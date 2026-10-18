//! Replays the actual TypeScript test scenarios, including every prompt and
//! every ordered call across the agent, tools and progress reporter.
use super::*;
use async_trait::async_trait;
use research_agent_core::{
	runtime::{AgentProbe, AgentRunContext, AgentTurn},
	tools::{Tool, ToolCostCategory, ToolMeta, ToolSideEffect},
};
use research_contracts::jobs::{ConversationContextMessage, ConversationRole};
use research_contracts::{
	Contract,
	agent::{AgentCapabilities, AgentRequest},
	validate,
};
use std::{
	collections::VecDeque,
	sync::atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Default)]
struct Trace(Arc<Mutex<Vec<Value>>>);
impl Trace {
	fn push(&self, value: Value) {
		self.0.lock().unwrap().push(value);
	}
}
struct Reporter(Trace);
#[async_trait]
impl PipelineReporter for Reporter {
	async fn state(&self, state: JobState) {
		self.0
			.push(o([("type", s("state")), ("state", s(state.as_str()))]));
	}
	async fn note(&self, text: &str) {
		self.0.push(o([("type", s("note")), ("text", s(text))]));
	}
	async fn tool(&self, id: &str, outcome: ToolCallOutcome, detail: &str) {
		self.0.push(o([
			("type", s("tool")),
			("toolId", s(id)),
			("outcome", s(outcome.as_str())),
			("detail", s(detail)),
		]));
	}
	async fn usage(&self, usage: &ResourceUsage) {
		self.0
			.push(o([("type", s("usage")), ("usage", json(usage).unwrap())]));
	}
}
struct ScriptClock {
	ms: Mutex<VecDeque<i64>>,
	iso: Mutex<VecDeque<String>>,
	last_ms: Mutex<i64>,
}
impl Clock for ScriptClock {
	fn now_ms(&self) -> i64 {
		let v = self.ms.lock().unwrap().pop_front();
		let mut last = self.last_ms.lock().unwrap();
		if let Some(v) = v {
			*last = v;
		}
		*last
	}
	fn now_iso(&self) -> String {
		self.iso
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected clock.nowIso")
	}
}
fn decode_vec<T: Contract>(value: &Value) -> Vec<T> {
	list(value).iter().map(|v| validate(v).unwrap()).collect()
}
/// The prompt builders are called directly by the TypeScript tests, with
/// messages longer than the claim contract allows (to exercise the byte
/// budgets), so the messages are built without the contract decoder.
fn unvalidated_context(value: &Value) -> Vec<ConversationContextMessage> {
	list(value)
		.iter()
		.map(|message| ConversationContextMessage {
			role: if field(message, "role") == "owner" {
				ConversationRole::Owner
			} else {
				ConversationRole::Assistant
			},
			text: field(message, "text").to_owned(),
		})
		.collect()
}
fn request(v: &Value) -> ResearchRequest {
	// Tests exercise small historical ceilings directly, below the API's new-run minima.
	let mut validated = v.clone();
	set(
		&mut validated,
		"budget",
		o([
			("maxAgentSteps", n(6.0)),
			("maxToolCalls", n(10.0)),
			("maxWallClockMs", n(600000.0)),
			("maxInputBytes", n(400000.0)),
			("maxSpendUsd", Value::Null),
		]),
	);
	let mut result: ResearchRequest = validate(&validated).unwrap();
	result.budget = serde_json::from_str(&research_js::json::stringify(get(v, "budget"))).unwrap();
	result
}
fn static_str(v: &str) -> &'static str {
	Box::leak(v.to_owned().into_boxed_str())
}
fn meta(v: &Value) -> ToolMeta {
	ToolMeta {
		tool_id: static_str(field(v, "toolId")),
		version: static_str(field(v, "version")),
		description: static_str(field(v, "description")),
		args_hint: static_str(field(v, "argsHint")),
		timeout_ms: field_number_u64(v, "timeoutMs"),
		permission: "research-read",
		cost_category: match field(v, "costCategory") {
			"metered" => ToolCostCategory::Metered,
			"rate-limited" => ToolCostCategory::RateLimited,
			_ => ToolCostCategory::Free,
		},
		side_effect: match field(v, "sideEffect") {
			"external-read" => ToolSideEffect::ExternalRead,
			"external-read+archive-write" => ToolSideEffect::ExternalReadArchiveWrite,
			_ => ToolSideEffect::None,
		},
		network_allowlist: match field(get(v, "networkAllowlist"), "kind") {
			"public-web" => ToolNetworkAllowlist::PublicWeb,
			"subscribed-sources" => ToolNetworkAllowlist::SubscribedSources,
			"hosts" => {
				ToolNetworkAllowlist::Hosts(strings(get(get(v, "networkAllowlist"), "hosts")))
			}
			_ => ToolNetworkAllowlist::None,
		},
	}
}
fn field_number_u64(v: &Value, key: &str) -> u64 {
	research_js::number::to_js_string(num(get(v, key)).unwrap())
		.parse()
		.unwrap()
}
struct ScriptAgent {
	meta: Value,
	turns: Mutex<VecDeque<Value>>,
	trace: Trace,
}
#[async_trait]
impl AgentRuntime for ScriptAgent {
	fn agent_id(&self) -> &str {
		field(&self.meta, "agentId")
	}
	fn display_name(&self) -> &str {
		"Scripted vector"
	}
	fn cost_model(&self) -> CostModel {
		if field(&self.meta, "costModel") == "metered" {
			CostModel::Metered
		} else {
			CostModel::PlanLimited
		}
	}
	fn tool_isolation(&self) -> ToolIsolation {
		if field(&self.meta, "toolIsolation") == "enforced" {
			ToolIsolation::Enforced
		} else {
			ToolIsolation::Unverified
		}
	}
	async fn probe(&self) -> AgentProbe {
		let p = get(&self.meta, "probe");
		AgentProbe {
			availability: validate(get(p, "availability")).unwrap(),
			capabilities: validate::<AgentCapabilities>(get(p, "capabilities")).unwrap(),
		}
	}
	fn run(&self, request: AgentRequest, ctx: AgentRunContext) -> AgentTurn {
		self.trace.push(o([
			("type", s("agent")),
			("request", json(&request).unwrap()),
			(
				"context",
				o([
					(
						"scratchDirectory",
						ctx.scratch_directory
							.as_ref()
							.map(|p| s(p.to_string_lossy().to_string()))
							.unwrap_or_default(),
					),
					("model", ctx.model.map(s).unwrap_or_default()),
					("effort", s(ctx.effort.as_str())),
				]),
			),
		]));
		let turn = self
			.turns
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected agent turn");
		if get(&turn, "cancelled").as_bool() == Some(true) {
			ctx.cancel.cancel();
		}
		let mut events = items(&turn, "events")
			.iter()
			.map(|v| {
				validate(v).unwrap_or_else(|_| research_contracts::agent::AgentEvent::Failed {
					code: String::new(),
					retryable: false,
				})
			})
			.collect::<Vec<_>>();
		if let Some(name) = get(&turn, "threw").as_str() {
			events.push(research_contracts::agent::AgentEvent::Failed {
				code: format!("AGENT_THREW_{name}"),
				retryable: true,
			});
		}
		AgentTurn::from_events(events)
	}
}
struct ScriptTool {
	meta: ToolMeta,
	script: Value,
	position: AtomicUsize,
	trace: Trace,
}
#[async_trait]
impl Tool for ScriptTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}
	fn parse_args(&self, args: &Value) -> Option<Value> {
		items(&self.script, "schemas")
			.iter()
			.find(|v| get(v, "input") == args)
			.and_then(|v| {
				if let Value::Object(output) = get(v, "output") {
					output.get("ok").cloned()
				} else {
					None
				}
			})
	}
	async fn execute(
		&self,
		args: Value,
		context: ToolContext,
	) -> Result<ToolOutput, research_agent_core::tools::ToolFailure> {
		self.trace.push(o([
			("type", s("execute")),
			("toolId", s(self.meta.tool_id)),
			("args", args.clone()),
		]));
		let i = self.position.fetch_add(1, Ordering::SeqCst);
		let call = items(&self.script, "executions").get(i).unwrap();
		assert_eq!(get(call, "args"), &args);
		for allocated in items(call, "ids") {
			assert_eq!(
				context.ids.next_id(field(allocated, "prefix")),
				field(allocated, "id")
			);
		}
		let result = get(call, "result");
		if matches!(result, Value::Null) {
			std::future::pending::<()>().await;
			unreachable!();
		}
		if get(result, "ok").as_bool() == Some(false) {
			let error = get(result, "error");
			return Err(research_agent_core::tools::ToolFailure {
				code: field(error, "code").to_owned(),
				detail: field(error, "detail").to_owned(),
				retryable: get(error, "retryable").as_bool().unwrap(),
			});
		}
		let value = get(result, "value");
		Ok(ToolOutput {
			model_text: field(value, "modelText").to_owned(),
			evidence: items(value, "evidence")
				.iter()
				.map(|v| CollectedEvidence {
					evidence: validate(get(v, "evidence")).unwrap(),
					retrieved_text: field(v, "retrievedText").to_owned(),
					retain_quotes: get(v, "retainQuotes").as_bool().unwrap(),
				})
				.collect(),
			securities: decode_vec(get(value, "securities")),
			financial_observations: decode_vec(get(value, "financialObservations")),
			position_observations: decode_vec(get(value, "positionObservations")),
			investor_filings: decode_vec(get(value, "investorFilings")),
			articles: decode_vec(get(value, "articles")),
		})
	}
}
fn corpus(name: &str) -> Value {
	research_js::json::parse(
		&std::fs::read_to_string(format!(
			"{}/../../vectors/pipeline/{name}.json",
			env!("CARGO_MANIFEST_DIR")
		))
		.unwrap(),
	)
	.unwrap()
}
fn compare(actual: &Value, expected: &Value, path: &str) {
	match (actual, expected) {
		(Value::Object(a), Value::Object(b)) => {
			assert_eq!(
				a.len(),
				b.len(),
				"{path}: key count; got {:?} want {:?}",
				a.keys().collect::<Vec<_>>(),
				b.keys().collect::<Vec<_>>()
			);
			for (key, value) in b.iter() {
				let actual = a
					.get(key)
					.unwrap_or_else(|| panic!("{path}: missing {key}"));
				compare(actual, value, &format!("{path}.{key}"));
			}
		}
		(Value::Array(a), Value::Array(b)) => {
			assert_eq!(a.len(), b.len(), "{path}: array count");
			for (i, (a, b)) in a.iter().zip(b).enumerate() {
				compare(a, b, &format!("{path}.{i}"));
			}
		}
		_ => assert_eq!(actual, expected, "{path}"),
	}
}

#[tokio::test]
async fn all_original_typescript_pipeline_scenarios_match_full_transcripts() {
	let mut count = 0;
	for file in 0..6 {
		for case in list(&corpus(&format!("transcripts-{file}"))) {
			let script = get(case, "input");
			let job = get(script, "job");
			let name = field(script, "name");
			let trace = Trace::default();
			let clock = Arc::new(ScriptClock {
				ms: Mutex::new(
					items(get(script, "clock"), "ms")
						.iter()
						.map(|v| {
							research_js::number::to_js_string(num(v).unwrap())
								.parse()
								.unwrap()
						})
						.collect(),
				),
				iso: Mutex::new(strings(get(get(script, "clock"), "iso")).into()),
				last_ms: Mutex::new(0),
			});
			let cancel = tokio_util::sync::CancellationToken::new();
			if get(script, "aborted").as_bool() == Some(true) {
				cancel.cancel();
			}
			let input = ResearchPipelineInput {
				run_id: field(job, "runId").to_owned(),
				request: request(get(job, "request")),
				sources: decode_vec(get(job, "sources")),
				workspace_components: decode_vec(get(job, "workspaceComponents")),
				conversation_context: decode_vec(get(job, "conversationContext")),
				prior_usage: serde_json::from_str(&research_js::json::stringify(get(
					job,
					"priorUsage",
				)))
				.unwrap(),
				cancel,
				allow_unverified_tool_isolation: get(job, "allowUnverifiedToolIsolation")
					.as_bool()
					.unwrap(),
			};
			let tools = items(script, "tools")
				.iter()
				.map(|v| {
					Arc::new(ScriptTool {
						meta: meta(get(v, "meta")),
						script: v.clone(),
						position: AtomicUsize::new(0),
						trace: trace.clone(),
					}) as Arc<dyn Tool>
				})
				.collect();
			let fences = Mutex::new(VecDeque::from(strings(get(script, "fences"))));
			let deps = ResearchPipelineDeps {
				agent: Arc::new(ScriptAgent {
					meta: get(script, "agent").clone(),
					turns: Mutex::new(items(script, "turns").to_vec().into()),
					trace: trace.clone(),
				}),
				tools: ToolRegistry::new(tools).unwrap(),
				clock,
				reporter: Arc::new(Reporter(trace.clone())),
				new_fence_token: Arc::new(move || {
					fences
						.lock()
						.unwrap()
						.pop_front()
						.expect("unexpected fence")
				}),
				scratch_directory: get(script, "scratchDirectory").as_str().map(PathBuf::from),
			};
			let outcome = run_research_pipeline(input, deps)
				.await
				.unwrap_or_else(|e| panic!("{name}: {e}"));
			let actual = o([
				("trace", a(trace.0.lock().unwrap().clone())),
				("outcome", json(&outcome).unwrap()),
			]);
			compare(&actual, get(case, "output"), name);
			count += 1;
		}
	}
	// The TypeScript suite has 58 `it` blocks (some `it.each`, some running the
	// pipeline twice); fewer transcripts than blocks means a scenario was lost.
	assert!(count >= 58, "only {count} pipeline scenarios");
}

#[test]
fn draft_schemas_match_typescript_transformations_and_issue_paths() {
	for case in list(&corpus("drafts")) {
		let input = get(case, "input");
		let output = match parse_draft(field(input, "schema"), get(input, "value")) {
			Ok(v) => o([("ok", v)]),
			Err(issues) => o([(
				"err",
				a(issues.iter().map(|i| {
					o([
						("path", s(&i.path)),
						("code", s(i.code)),
						("message", s(&i.message)),
					])
				})),
			)]),
		};
		compare(
			&output,
			get(case, "output"),
			&format!(
				"{} {}",
				field(input, "schema"),
				research_js::json::stringify(get(input, "value"))
			),
		);
	}
}

#[test]
fn prompt_corpus_matches_every_byte() {
	let mut cases_seen = 0;
	for part in 0.. {
		let name = format!("prompts-{part}");
		let path = format!(
			"{}/../../vectors/pipeline/{name}.json",
			env!("CARGO_MANIFEST_DIR")
		);
		if !std::path::Path::new(&path).exists() {
			break;
		}
		cases_seen += prompt_cases(&corpus(&name));
	}
	assert!(cases_seen > 400, "only {cases_seen} prompt cases");
}

fn prompt_cases(cases: &Value) -> usize {
	let cases = list(cases);
	for case in cases {
		let input = get(case, "input");
		let builder = field(input, "builder");
		// The verification prompt takes neither a request nor a context.
		let (request, context) = if builder == "verification" {
			(None, Vec::new())
		} else {
			(
				Some(request(get(input, "request"))),
				unvalidated_context(get(input, "conversationContext")),
			)
		};
		let request = request.as_ref();
		let actual = match builder {
			"planning" => {
				let metas = items(input, "tools").iter().map(meta).collect::<Vec<_>>();
				planning_prompt(PlanningPromptInput {
					request: request.unwrap(),
					now_iso: field(input, "nowIso"),
					tools: &metas.iter().collect::<Vec<_>>(),
					sources: &decode_vec(get(input, "sources")),
					collected_so_far: field(input, "collectedSoFar"),
					remaining_tool_calls: field_number_u64(input, "remainingToolCalls"),
					conversation_context: &context,
					fence_token: field(input, "fenceToken"),
					prompt_budget_bytes: usize::try_from(field_number_u64(
						input,
						"promptBudgetBytes",
					))
					.unwrap(),
					reminder: get(input, "reminder").as_str(),
				})
				.unwrap()
			}
			"analysis" => analysis_prompt(AnalysisPromptInput {
				request: request.unwrap(),
				now_iso: field(input, "nowIso"),
				evidence_pack: field(input, "evidencePack"),
				record_summary: field(input, "recordSummary"),
				dataset_guide: field(input, "datasetGuide"),
				existing_components: &decode_vec(get(input, "existingComponents")),
				conversation_context: &context,
				fence_token: field(input, "fenceToken"),
				repair_note: get(input, "repairNote").as_str(),
			})
			.unwrap(),
			_ => verification_prompt(
				&items(input, "claims")
					.iter()
					.map(|v| {
						(
							usize::try_from(field_number_u64(v, "index")).unwrap(),
							field(v, "text").to_owned(),
							field(v, "passages").to_owned(),
						)
					})
					.collect::<Vec<_>>(),
				field(input, "fenceToken"),
			)
			.unwrap(),
		};
		assert_eq!(
			actual,
			str_(get(case, "output")),
			"{}",
			field(input, "builder")
		);
	}
	cases.len()
}
