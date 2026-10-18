#![allow(clippy::unwrap_used,clippy::expect_used,clippy::panic,clippy::indexing_slicing)]
mod support;
use std::collections::HashSet;
use research_agent_core::runtime::*;
use research_providers::{cli_turn::*,claude_code::*,codex::*,opencode::*,openrouter::*,openrouter_models::*,environment::*,lines::*,process::*,turn::*};
use serde_json::{Value,json};
use support::*;
fn vectors(name:&str)->Value { serde_json::from_str(&std::fs::read_to_string(format!("{}/../../vectors/providers/{name}.json",env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap() }
fn interpreter(backend:&str,option:u64)->Box<dyn CliStreamInterpreter> {
    match backend { "opencode"=>Box::new(OpenCodeInterpreter::new(OpenCodeInterpreterOptions { ask_and_reject:option>0,permitted_tool_ids:if option==2 { vec!["web.search".to_owned(),"web.fetch_page".to_owned()] } else { vec![] },max_tool_requests:if option==2 {2}else{0} })),"codex"=>Box::<CodexInterpreter>::default(),_=>Box::<ClaudeInterpreter>::default() }
}
#[test]
fn backend_argv_configs_environment_and_variants() {
    let vectors=vectors("builders");
    for case in vectors["builders"].as_array().unwrap() {
        let input=&case["input"];let model=input["model"].as_str();let effort=effort(input["effort"].as_str().unwrap());let scratch=input["scratch"].as_str().unwrap();let base=model.unwrap_or("provider/model");
        assert_eq!(json!({"codex":build_codex_args(scratch,model,effort),"claude":build_claude_args(model,effort),"opencode":build_opencode_args(base),"config":build_opencode_config_content(base),"variants":model_arguments_for(base,effort,&HashSet::from(["low".to_owned()]))}),case["output"]);
    }
    for case in vectors["environments"].as_array().unwrap() {
        let env=serde_json::from_value::<Environment>(case["input"]["env"].clone()).unwrap();let keys:Vec<_>=case["input"]["keys"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();
        assert_eq!(json!({"env":build_child_env(&env,&keys),"cwd":probe_working_directory(&env)}),case["output"]);
    }
}
#[test]
fn all_provider_line_verdicts_and_stateful_conclusions() {
    for backend in ["opencode","codex","claude-code"] {
        let file=vectors(&format!("{backend}-lines"));
        for (index,case) in file.as_array().unwrap().iter().enumerate() {
            let mut stream=interpreter(backend,case["input"]["option"].as_u64().unwrap());let mut emitted=0;let mut verdicts=vec![];
            for line in case["input"]["lines"].as_array().unwrap() {
                let verdict=stream.interpret_line(line.as_str().unwrap());if let LineVerdict::Text { text }=&verdict { emitted+=research_js::utf16::utf16_len(text); }verdicts.push(verdict);
            }
            let exit=&case["input"]["exit"];let exit=ProcessExit { code:exit["code"].as_i64().map(|v|i32::try_from(v).unwrap()),signal:exit["signal"].as_str().map(str::to_owned),stderr_tail:exit["stderrTail"].as_str().unwrap().to_owned() };
            assert_eq!(json!({"verdicts":canonical(&verdicts),"conclusion":canonical(&stream.conclude(&exit,emitted))}),case["output"],"{backend} case {index}: {}",case["input"]);
        }
    }
}
#[test]
fn sse_line_schema_and_cost_semantics() { for case in vectors("sse").as_array().unwrap() { assert_eq!(canonical(&interpret_sse_line(case["input"].as_str().unwrap())),case["output"],"{}",case["input"]); } }
#[test]
fn streaming_utf8_bom_cr_and_utf16_bounds() {
    for case in vectors("lines").as_array().unwrap() {
        let mut splitter=LineSplitter::new(usize::try_from(case["input"]["max"].as_u64().unwrap()).unwrap());let mut lines=vec![];
        for chunk in case["input"]["chunks"].as_array().unwrap() { let bytes:Vec<_>=chunk.as_array().unwrap().iter().map(|n|u8::try_from(n.as_u64().unwrap()).unwrap()).collect();lines.extend(splitter.push(&bytes)); }
        lines.extend(splitter.finish());assert_eq!(json!(lines),case["output"],"{}",case["input"]);
    }
}
#[test]
fn pure_model_hint_cost_retry_and_catalog_parity() {
    let file=vectors("pure");
    for case in file["models"].as_array().unwrap() { assert_eq!(json!(is_valid_model_id(case["input"].as_str().unwrap())),case["output"]); }
    let hint=|h:Option<FailureHint>|h.map(|v|match v {FailureHint::Auth=>"auth",FailureHint::Payment=>"payment",FailureHint::RateLimit=>"rate-limit",FailureHint::Unavailable=>"unavailable"});
    for case in file["hints"].as_array().unwrap() { assert_eq!(json!(hint(hint_from_text(case["input"].as_str().unwrap()))),case["output"],"{}",case["input"]); }
    for case in file["statuses"].as_array().unwrap() { let status=u16::try_from(case["input"].as_u64().unwrap()).unwrap();assert_eq!(json!({"hint":hint(hint_from_http_status(f64::from(status))),"failure":failure_for_http_status(status)}),case["output"]); }
    for case in file["costs"].as_array().unwrap() { let value=f64::from_bits(u64::from_str_radix(case["input"].as_str().unwrap(),16).unwrap());assert_eq!(json!(as_known_cost_usd(Some(value)).map(|v|format!("{:016x}",v.to_bits()))),case["output"]); }
    for case in file["retry"].as_array().unwrap() { let i=&case["input"];assert_eq!(json!(rejection_retry_delay_ms(u32::try_from(i["index"].as_u64().unwrap()).unwrap(),i["after"].as_f64(),i["remaining"].as_f64().unwrap())),case["output"]); }
    for case in file["headers"].as_array().unwrap() { assert_eq!(json!(parse_retry_after_ms(case["input"].as_str(),case["now"].as_f64().unwrap()).map(|v|format!("{:016x}",v.to_bits()))),case["output"]); }
    for case in file["catalogs"].as_array().unwrap() { let input=research_js::json::parse(&case["input"].to_string()).unwrap();assert_eq!(json!(parse_free_model_ids(&input)),case["output"]); }
    for case in file["modelLists"].as_array().unwrap() { assert_eq!(json!(parse_model_list(case["input"].as_str().unwrap())),case["output"]); }
    for case in file["preflight"].as_array().unwrap() { let mut req=request();req.deadline=case["input"]["deadline"].as_str().unwrap().to_owned();let output=match preflight_turn(&req,&ctx(),case["input"]["now"].as_f64().unwrap()) { Ok(v)=>json!({"ok":true,"deadlineEpochMs":v}),Err(f)=>json!({"ok":false,"failure":f}) };assert_eq!(output,case["output"]); }
}
#[tokio::test]
async fn whole_cli_turn_transcripts() {
    for case in vectors("cli-turns").as_array().unwrap() {
        let input=&case["input"];let runner=ScriptedRunner::repeat(input["script"].clone());let environment=environment(runner.clone(),unused_http(),serde_json::from_value(input["env"].clone()).unwrap());
        let scratch=tempfile::tempdir().unwrap();let mut context=context(&input["context"]);context.scratch_directory=Some(scratch.path().to_owned());
        let runtime:Box<dyn AgentRuntime>=match input["backend"].as_str().unwrap() { "opencode"=>Box::new(OpenCodeRuntime::new(environment)),"codex"=>Box::new(CodexRuntime::new(environment)),_=>Box::new(ClaudeCodeRuntime::new(environment)) };
        let events=collect(runtime.run(decode(&input["request"]),context)).await;
        let normalize_path=|v:Value|serde_json::from_str::<Value>(&v.to_string().replace(&scratch.path().to_string_lossy().to_string(),"/scratch/job_1")).unwrap();
        let spawns=normalize_path(json!(*runner.calls.lock().unwrap()));
        let files=if input["backend"]=="opencode" {json!([{"path":"/scratch/job_1/opencode.jsonc","content":std::fs::read_to_string(scratch.path().join("opencode.jsonc")).unwrap()}])}else{json!([])};
        assert_eq!(json!({"spawns":spawns,"files":files,"events":canonical(&events)}),case["output"],"{}",input);
    }
}
#[tokio::test]
async fn whole_http_request_and_bytewise_sse_transcripts() {
    for case in vectors("http-turns").as_array().unwrap() {
        let input=&case["input"];let http=ScriptedHttp::repeat(json!({"body":input["body"],"width":1}));let mut env=env();env.extend([("OPENROUTER_API_KEY".to_owned(),"sk-or-v1-test-key".to_owned()),("OPENROUTER_MODEL".to_owned(),"example/model".to_owned()),("OPENROUTER_FREE_MODEL".to_owned(),"example/model:free".to_owned())]);
        let environment=environment(ScriptedRunner::repeat(json!({})),http.clone(),env);let runtime=if input["free"]==true {OpenRouterRuntime::free(environment)}else{OpenRouterRuntime::new(environment)};
        let mut request=request();request.deadline=chrono::Utc::now().checked_add_signed(chrono::Duration::seconds(20)).unwrap().to_rfc3339();let mut context=ctx();context.effort=effort(input["effort"].as_str().unwrap());
        let events=collect(runtime.run(request,context)).await;
        // Header names are case-insensitive; TS uses an object with capitalized keys.
        let mut calls=http.calls.lock().unwrap().clone();for call in &mut calls { if let Some(headers)=call["headers"].as_object_mut() { let old=std::mem::take(headers);*headers=old.into_iter().map(|(k,v)|(match k.as_str() {"authorization"=>"Authorization".to_owned(),"content-type"=>"Content-Type".to_owned(),"accept"=>"Accept".to_owned(),_=>k},v)).collect(); } }
        assert_eq!(json!({"calls":calls,"events":canonical(&events)}),case["output"],"{}",input);
    }
}
