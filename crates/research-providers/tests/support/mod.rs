#![allow(dead_code)]
use std::{collections::{BTreeMap,VecDeque},sync::{Arc,Mutex},io};
use async_trait::async_trait;
use futures_util::{StreamExt,stream};
use research_agent_core::runtime::*;
use research_contracts::agent::*;
use research_providers::{environment::*,http::*,process::*};
use serde_json::{Value,json};
use tokio_util::sync::CancellationToken;

pub fn decode<T:research_contracts::Contract>(value:&Value)->T { research_contracts::parse(&value.to_string()).unwrap() }
pub fn context(value:&Value)->AgentRunContext { AgentRunContext { cancel:CancellationToken::new(),scratch_directory:value["scratchDirectory"].as_str().map(Into::into),model:value["model"].as_str().map(str::to_owned),effort:effort(value["effort"].as_str().unwrap_or("medium")) } }
pub fn effort(value:&str)->Effort { match value { "low"=>Effort::Low,"high"=>Effort::High,_=>Effort::Medium } }
pub fn request()->AgentRequest { decode(&json!({ "runId":"run_1","conversationId":"conv_1","prompt":"PROMPT-MARKER: reply with the single word OK.","permittedToolIds":[],"maxToolCalls":0,"deadline":"2999-01-01T00:00:00.000Z" })) }
pub fn ctx()->AgentRunContext { context(&json!({"scratchDirectory":"/scratch/job_1","model":null,"effort":"medium"})) }
pub async fn collect(mut turn:AgentTurn)->Vec<AgentEvent> { let mut events=vec![];while let Some(e)=turn.next().await { events.push(e); }assert_eq!(turn.close().await,TurnEnd::Finished);events }
pub fn canonical(value:&impl serde::Serialize)->Value { normalize(serde_json::to_value(value).unwrap()) }
fn normalize(value:Value)->Value {
    match value {
        Value::Array(v)=>Value::Array(v.into_iter().map(normalize).collect()),
        Value::Object(m)=>Value::Object(m.into_iter().map(|(k,v)|(k,normalize(v))).collect()),
        Value::Number(n)=>{ let v=n.as_f64().unwrap();if v.fract()!=0.0 { json!({"doubleBits":format!("{:016x}",v.to_bits())}) } else { Value::Number(n) } },
        v=>v,
    }
}
#[derive(Default)]
pub struct ScriptedRunner { pub scripts:Mutex<VecDeque<Value>>,pub fallback:Value,pub calls:Mutex<Vec<Value>>,pub reaped:Arc<std::sync::atomic::AtomicBool> }
impl ScriptedRunner {
    pub fn repeat(script:Value)->Arc<Self> { Arc::new(Self { fallback:script,..Self::default() }) }
    pub fn sequence(scripts:Vec<Value>)->Arc<Self> { Arc::new(Self { scripts:Mutex::new(scripts.into()),..Self::default() }) }
}
impl ProcessRunner for ScriptedRunner {
    fn run(&self,spec:ProcessSpec)->io::Result<ProcessHandle> {
        self.calls.lock().unwrap().push(json!({"command":spec.command,"args":spec.args,"cwd":spec.cwd,"env":spec.env,"stdin":spec.stdin}));
        let script=self.scripts.lock().unwrap().pop_front().unwrap_or_else(||self.fallback.clone());
        if let Some(code)=script["syncError"].as_i64() { return Err(io::Error::from_raw_os_error(i32::try_from(code).unwrap())); }
        let lines=script["lines"].as_array().cloned().unwrap_or_default().into_iter().map(|v|v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let hang=script["hang"]==true;let ignore=script["ignoreAbort"]==true;let error=script["spawnErrorCode"].as_str().map(str::to_owned);
        let cancel=spec.cancel.clone();
        let stdout_lines=stream::iter(if error.is_some() { vec![] } else { lines }).chain(stream::once(async move {
            if ignore { futures_util::future::pending::<()>().await; }
            if hang { cancel.cancelled().await; }
            None::<String>
        }).filter_map(|v|async move {v})).boxed();
        let code=if script["exit"].as_object().is_none_or(|v|!v.contains_key("code")) { Some(0) } else { script["exit"]["code"].as_i64().map(|v|i32::try_from(v).unwrap()) };
        let signal=script["exit"]["signal"].as_str().map(str::to_owned);let stderr_tail=script["exit"]["stderrTail"].as_str().unwrap_or("").to_owned();let flag=self.reaped.clone();
        let exit=Box::pin(async move {
            if let Some(error)=error { return Err(io::Error::from_raw_os_error(if error=="ENOENT" { libc::ENOENT } else { libc::EACCES })); }
            if ignore { futures_util::future::pending::<()>().await; }
            if hang { spec.cancel.cancelled().await;tokio::time::sleep(std::time::Duration::from_millis(script["exitAfterAbortMs"].as_u64().unwrap_or(0))).await; }
            flag.store(true,std::sync::atomic::Ordering::SeqCst);
            Ok(ProcessExit { code:if hang {None}else{code},signal:if hang {Some("SIGTERM".to_owned())}else{signal},stderr_tail })
        });
        Ok(ProcessHandle { stdout_lines,exit })
    }
}
#[derive(Default)]
pub struct ScriptedHttp { pub responses:Mutex<VecDeque<Value>>,pub calls:Mutex<Vec<Value>>,pub fallback:Value }
impl ScriptedHttp {
    pub fn repeat(response:Value)->Arc<Self> { Arc::new(Self { fallback:response,..Self::default() }) }
    pub fn sequence(responses:Vec<Value>)->Arc<Self> { Arc::new(Self { responses:Mutex::new(responses.into()),..Self::default() }) }
}
#[async_trait]
impl HttpClient for ScriptedHttp {
    async fn send(&self,request:HttpRequest,cancel:CancellationToken)->Result<HttpResponse,TransportError> {
        self.calls.lock().unwrap().push(json!({"url":request.url,"method":request.method,"headers":request.headers,"body":request.body,"redirect":"error"}));
        let response=self.responses.lock().unwrap().pop_front().unwrap_or_else(||self.fallback.clone());
        if response["hangHeaders"]==true { cancel.cancelled().await;return Err(TransportError("ABORTED")); }
        if response["error"]==true { return Err(TransportError("FETCH_FAILED")); }
        let bytes=response["body"].as_str().unwrap_or("").as_bytes().to_vec();
        let width=usize::try_from(response["width"].as_u64().unwrap_or(1)).unwrap();
        let chunks:Vec<Result<Vec<u8>,TransportError>>=bytes.chunks(width).map(|v|Ok(v.to_vec())).collect();
        let hang=response["hangBody"]==true;let read_error=response["readError"]==true;
        let body=if response["noBody"]==true { None } else { Some(stream::iter(chunks).chain(stream::once(async move {
            if hang { cancel.cancelled().await; }
            if read_error { Some(Err(TransportError("READ_FAILED"))) } else { None }
        }).filter_map(|v|async move {v})).boxed()) };
        Ok(HttpResponse { status:u16::try_from(response["status"].as_u64().unwrap_or(200)).unwrap(),headers:response["headers"].as_object().map(|v|v.iter().map(|(k,v)|(k.clone(),v.as_str().unwrap().to_owned())).collect()).unwrap_or_default(),body })
    }
}
pub fn environment(runner:Arc<dyn ProcessRunner>,http:Arc<dyn HttpClient>,env:Environment)->ProviderEnvironment { ProviderEnvironment { process_runner:runner,http,env } }
pub fn env()->BTreeMap<String,String> { [("PATH","/usr/bin:/bin"),("HOME","/home/owner"),("USER","owner"),("LANG","en_US.UTF-8"),("LC_ALL","en_US.UTF-8"),("TMPDIR","/tmp/owner"),("TERM","dumb")].into_iter().map(|(k,v)|(k.to_owned(),v.to_owned())).collect() }
pub fn unused_http()->Arc<ScriptedHttp> { ScriptedHttp::repeat(json!({"error":true})) }
