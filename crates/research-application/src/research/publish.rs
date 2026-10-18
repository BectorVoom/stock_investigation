//! Final citation selection, deterministic answer and restricted model display.
use std::collections::{HashMap,HashSet};
use research_agent_core::{runtime::AgentProbe,tools::ToolOutput};
use research_contracts::{jobs::ResearchBundle,records::IngestedArticle,ui::UiOperation,validate,ContractError};
use research_domain::jobs::{budget::{ResourceUsage,BudgetLimit},state_machine::JobState};
use research_js::{json::Value,utf16};
use super::{value::*,records::Records,presentation::{build_presentation,DISCLAIMER},prompts::PROMPT_VERSION,ResearchPipelineInput,ResearchPipelineDeps,PipelineOutcome,PipelineError,failed};

pub(super) struct PublishInput<'a>{
	pub input:&'a ResearchPipelineInput,pub deps:&'a ResearchPipelineDeps,pub probe:&'a AgentProbe,pub usage:ResourceUsage,pub collected:ToolOutput,pub articles:Vec<IngestedArticle>,pub claims:Vec<Value>,pub records:Records,pub analysis:Value,pub analysis_failure:Option<String>,pub stopped:Option<BudgetLimit>,pub verifier_ran:bool,pub ui_proposals:Vec<Value>,pub notes:Vec<String>,pub now:&'a str,
}

pub(super) async fn publish(args:PublishInput<'_>)->Result<PipelineOutcome,PipelineError>{
	let PublishInput{input,deps,probe,usage,collected,articles,claims,records,analysis,analysis_failure,stopped,verifier_ran,ui_proposals,mut notes,now}=args;
	deps.reporter.state(JobState::Publishing).await;
	let Records{scenarios,securities,supplier_links,pricing_power}=records;
	let count=|status:&str|claims.iter().filter(|v|field(v,"status")==status).count();let supported=count("supported");let conflicting=count("conflicting");let unsupported=count("unsupported");
	let status=if !claims.is_empty()&&supported==claims.len()&&verifier_ran{"verified"}else if supported>0{"partially-verified"}else{"unverified"};
	let known=securities.iter().map(|v|field(v,"securityId")).collect::<HashSet<_>>();
	let mut identified=|values:Vec<Value>,label:&str,limit:usize|{let count=values.len();let mut kept=values.into_iter().filter(|v|known.contains(field(v,"securityId"))).collect::<Vec<_>>();if kept.len()<count{notes.push(format!("{} {label} could not be linked to an identified security and were not stored.",count-kept.len()));}kept.truncate(limit);kept};
	let financial=identified(list(&json(&collected.financial_observations)?).to_vec(),"financial observation(s)",200);let positions=identified(list(&json(&collected.position_observations)?).to_vec(),"position observation(s)",80);let filings=collected.investor_filings.into_iter().take(12).collect::<Vec<_>>();
	let mut cited=HashSet::new();for c in &claims{cited.extend(items(c,"links").iter().map(|v|field(v,"evidenceId").to_owned()));}for v in &scenarios{cited.extend(strings(get(v,"supportingEvidenceIds")));cited.extend(strings(get(v,"contraryEvidenceIds")));if let Some(id)=get(v,"baselineEvidenceId").as_str(){cited.insert(id.to_owned());}}for v in &supplier_links{cited.extend(strings(get(v,"evidenceIds")));}for v in &pricing_power{cited.extend(strings(get(v,"evidenceIds")));cited.extend(strings(get(get(v,"inputs"),"managementCommentaryEvidenceIds")));}for v in financial.iter().chain(&positions){if let Some(id)=get(v,"sourceEvidenceId").as_str(){cited.insert(id.to_owned());}}for f in &filings{cited.insert(f.source_evidence_id.clone());}
	let evidence=collected.evidence.into_iter().map(|v|v.evidence).filter(|v|cited.contains(&v.evidence_id)).take(80).collect::<Vec<_>>();
	let mut answer=vec![if matches!(analysis,Value::Null){format!("The analysis step did not produce usable output ({}). Records retrieved by tools are shown as-is.",analysis_failure.as_deref().unwrap_or("unknown"))}else{format!("{supported} of {} claim(s) are supported by retrieved evidence and independently confirmed; {conflicting} have conflicting evidence and {unsupported} are unsupported.",claims.len())}];
	for (status,heading,limit) in [("supported","Supported findings:",8),("conflicting","Findings with conflicting evidence:",5),("unsupported","Not supported (shown for transparency, do not rely on these):",5)]{let lines=claims.iter().filter(|v|field(v,"status")==status).take(limit).map(|v|format!("- {}",field(v,"text"))).collect::<Vec<_>>();if !lines.is_empty(){answer.push(format!("{heading}\n{}",lines.join("\n")));}}
	answer.push(format!("{} demand scenario(s), {} supplier link(s) and {} financial observation(s) are on the canvas.",scenarios.len(),supplier_links.len(),financial.len()));answer.extend(notes);if let Some(limit)=stopped{answer.push(format!("Collection stopped early at a budget limit: {}.",limit.as_str()));}answer.push(DISCLAIMER.to_owned());let answer=utf16::truncate(&answer.join("\n\n"),6000).into_owned();
	let mut data=o([("runId",s(&input.run_id)),("question",s(&input.request.question)),("nowIso",s(now)),("dataCutoffAt",s(now)),("claims",a(claims.iter().cloned())),("scenarios",a(scenarios)),("securities",a(securities.iter().cloned())),("supplierLinks",a(supplier_links)),("financialObservations",a(financial)),("positionObservations",a(positions)),("evidence",json(&evidence)?)]);
	let presentation=build_presentation(&data);let mut accepted=Vec::new();let mut rejected=0;
	for proposal in items(&analysis,"uiOperations").iter().chain(&ui_proposals){let parsed=validate::<UiOperation>(proposal);if let Ok(v)=parsed{let v=json(&v)?;if model_authorable(&v,&input.run_id){accepted.push(v);continue;}}rejected+=1;}
	let mut renamed=HashMap::new();for v in &accepted{if field(v,"operation")=="component.create"&&!renamed.contains_key(field(v,"componentId")){renamed.insert(field(v,"componentId").to_owned(),format!("{}_model{}",input.run_id,renamed.len()+1));}}
	for v in &mut accepted{if let Some(name)=renamed.get(field(v,"componentId")){set(v,"componentId",s(name));}}
	if rejected>0{deps.reporter.note(&format!("{rejected} model display instruction(s) were refused (invalid, or outside what a model may author).")).await;}
	let mut operations=items(&presentation,"uiOperations").to_vec();operations.extend(accepted);operations.truncate(30);
	set(&mut data,"claims",a(claims.iter().take(80).cloned()));set(&mut data,"securities",a(securities.into_iter().take(40)));set(&mut data,"investorFilings",json(&filings)?);set(&mut data,"pricingPower",a(pricing_power));set(&mut data,"datasets",get(&presentation,"datasets").clone());set(&mut data,"uiOperations",a(operations));set(&mut data,"answerText",s(answer));set(&mut data,"answerClaimIds",a(claims.iter().take(80).map(|v|get(v,"claimId").clone())));set(&mut data,"verificationStatus",s(status));
	let versions=Value::Object(research_js::json::Object::from_members(deps.tools.list().iter().map(|t|(t.meta().tool_id.to_owned(),s(t.meta().version))).collect()));
	set(&mut data,"provenance",o([("agentId",s(deps.agent.agent_id())),("providerModel",input.request.model.as_ref().or(probe.capabilities.model.as_ref()).map(s).unwrap_or_default()),("promptVersion",s(PROMPT_VERSION)),("toolVersions",versions),("dataCutoffAt",s(now))]));
	// ResearchBundle is strict; the presentation-only inputs must not be sent.
	if let Value::Object(o)=&mut data{for key in ["runId","question","nowIso","dataCutoffAt"]{o.remove(key);}}
	let bundle=match validate::<ResearchBundle>(&data){Ok(bundle)=>bundle,Err(error)=>{let paths=match error{ContractError::Invalid(issues)=>issues.iter().take(4).map(|i|i.path_string(".")).collect::<Vec<_>>().join("; "),ContractError::Json(_)=>String::new()};deps.reporter.note(&format!("Bundle failed contract validation at: {paths}")).await;return Ok(failed("BUNDLE_INVALID",false,None,usage));}};
	Ok(match stopped.map(|s|s.as_str().to_owned()).or(analysis_failure){None=>PipelineOutcome::Completed{bundle,articles,usage},Some(failure_code)=>PipelineOutcome::Partial{failure_code,bundle,articles,usage}})
}
fn model_authorable(v:&Value,run:&str)->bool{if field(v,"componentId").starts_with(&format!("{run}_")){return false;}match field(v,"operation"){"component.create"=>["data-table","financial-table","line-chart","bar-chart","candlestick-chart","source-list"].contains(&field(v,"componentType")),"component.remove"|"component.focus"|"component.select"=>true,_=>false}}
