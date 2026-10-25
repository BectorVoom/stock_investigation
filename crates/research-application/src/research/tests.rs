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
	agent::{AgentCapabilities, AgentEvent, AgentRequest, CostModel},
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
/// Replays exactly the clock readings the TypeScript took: a missing reading
/// (the port reads the clock more often) or a left-over one (less often) fails.
struct ScriptClock {
	ms: Mutex<VecDeque<i64>>,
	iso: Mutex<VecDeque<String>>,
}
impl ScriptClock {
	fn assert_drained(&self, name: &str) {
		assert!(
			self.ms.lock().unwrap().is_empty(),
			"{name}: unread clock.nowMs readings"
		);
		assert!(
			self.iso.lock().unwrap().is_empty(),
			"{name}: unread clock.nowIso readings"
		);
	}
}
impl Clock for ScriptClock {
	fn now_ms(&self) -> i64 {
		self.ms
			.lock()
			.unwrap()
			.pop_front()
			.expect("unexpected clock.nowMs")
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
		// An event the contracts cannot even decode (the TypeScript test feeds
		// `{type: "exec"}`) is delivered as a bounds-violating typed event, so the
		// pipeline's own `validate_agent_event` path rejects it.
		let events = items(&turn, "events")
			.iter()
			.map(|v| {
				validate::<AgentEvent>(v).unwrap_or_else(|_| AgentEvent::ToolRequest {
					tool_id: "malformed".to_owned(),
					args: research_contracts::json::JsonValue::default(),
					call_id: String::new(),
				})
			})
			.collect::<Vec<_>>();
		// The run is cancelled at the point the TypeScript's signal first aborted.
		let cancel_after = num(get(&turn, "cancelAfter")).map(|n| {
			usize::try_from(research_js::number::to_js_string(n).parse::<u64>().unwrap()).unwrap()
		});
		let threw = get(&turn, "threw").as_str().is_some();
		let run_cancel = ctx.cancel.clone();
		AgentTurn::spawn(&ctx.cancel, move |sender| async move {
			let delivered = events.len();
			for (index, event) in events.into_iter().enumerate() {
				if cancel_after == Some(index) {
					run_cancel.cancel();
				}
				if !sender.send(event).await {
					return;
				}
			}
			if cancel_after == Some(delivered) {
				run_cancel.cancel();
			}
			if threw {
				// An adapter that throws: the port maps every panic to AGENT_THREW_Panic.
				std::panic::resume_unwind(Box::new("adapter threw"));
			}
		})
	}
}
struct ScriptTool {
	meta: ToolMeta,
	script: Value,
	position: AtomicUsize,
	trace: Trace,
	run_cancel: tokio_util::sync::CancellationToken,
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
		if get(call, "abortsRun").as_bool() == Some(true) {
			self.run_cancel.cancel();
		}
		if get(call, "threw").as_str().is_some() {
			// A tool that throws: the port maps every panic to TOOL_THREW / "panic".
			std::panic::resume_unwind(Box::new("tool threw"));
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
		// `{"$negativeZero": true}` is how the vectors spell -0 (JSON cannot).
		(Value::Number(a), Value::Object(b)) if b.get("$negativeZero").is_some() => {
			assert!(
				a.to_bits() == (-0.0_f64).to_bits(),
				"{path}: expected -0, got {a}"
			);
		}
		(Value::Number(a), Value::Number(b)) => {
			assert!(
				a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()),
				"{path}: {a} is not {b}"
			);
		}
		_ => assert_eq!(actual, expected, "{path}"),
	}
}

/// Pipeline.test.ts blocks (it.each rows expanded) and the hand-written runs
/// they record; the seeded `gen/` and `edge/` runs come on top.
const HAND_WRITTEN_BLOCKS: usize = 65;
const HAND_WRITTEN_RUNS: usize = 72;

#[tokio::test]
async fn all_original_typescript_pipeline_scenarios_match_full_transcripts() {
	let mut hand_written = Vec::new();
	let mut seeded = 0;
	let mut edges = 0;
	for file in 0.. {
		let name = format!("transcripts-{file}");
		let path = format!(
			"{}/../../vectors/pipeline/{name}.json",
			env!("CARGO_MANIFEST_DIR")
		);
		if !std::path::Path::new(&path).exists() {
			break;
		}
		for case in list(&corpus(&name)) {
			let script = get(case, "input");
			let job = get(script, "job");
			let name = field(script, "name");
			if name.starts_with("gen/") {
				seeded += 1;
			} else if name.starts_with("edge/") {
				edges += 1;
			} else {
				hand_written.push(name.to_owned());
			}
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
			});
			let cancel = tokio_util::sync::CancellationToken::new();
			if get(script, "aborted").as_bool() == Some(true) {
				cancel.cancel();
			}
			let run_cancel = cancel.clone();
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
			let script_tools: Vec<Arc<ScriptTool>> = items(script, "tools")
				.iter()
				.map(|v| {
					Arc::new(ScriptTool {
						meta: meta(get(v, "meta")),
						script: v.clone(),
						position: AtomicUsize::new(0),
						trace: trace.clone(),
						run_cancel: run_cancel.clone(),
					})
				})
				.collect();
			let tools = script_tools
				.iter()
				.map(|tool| Arc::clone(tool) as Arc<dyn Tool>)
				.collect();
			let fences = Arc::new(Mutex::new(VecDeque::from(strings(get(script, "fences")))));
			let fence_source = Arc::clone(&fences);
			let agent = Arc::new(ScriptAgent {
				meta: get(script, "agent").clone(),
				turns: Mutex::new(items(script, "turns").to_vec().into()),
				trace: trace.clone(),
			});
			let deps = ResearchPipelineDeps {
				agent: Arc::clone(&agent) as Arc<dyn AgentRuntime>,
				tools: ToolRegistry::new(tools).unwrap(),
				clock: Arc::clone(&clock) as Arc<dyn Clock>,
				reporter: Arc::new(Reporter(trace.clone())),
				new_fence_token: Arc::new(move || {
					fence_source
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
			// Nothing scripted may be left over: every clock reading, fence token,
			// model turn and tool execution the TypeScript made happened here too.
			clock.assert_drained(name);
			assert!(fences.lock().unwrap().is_empty(), "{name}: unused fences");
			assert!(
				agent.turns.lock().unwrap().is_empty(),
				"{name}: unused turns"
			);
			for (tool, scripted) in script_tools.iter().zip(items(script, "tools")) {
				assert_eq!(
					tool.position.load(Ordering::SeqCst),
					items(scripted, "executions").len(),
					"{name}: executions of {}",
					tool.meta.tool_id
				);
			}
		}
	}
	// Deleting or skipping any hand-written scenario must fail, whatever the
	// seeded runs add: the exact list is the exporter's block table.
	let table = corpus("scenarios");
	let blocks = items(&table, "blocks");
	assert_eq!(blocks.len(), HAND_WRITTEN_BLOCKS, "pipeline.test.ts blocks");
	assert_eq!(hand_written.len(), HAND_WRITTEN_RUNS, "hand-written runs");
	for block in blocks {
		let name = field(block, "name");
		let expected = usize::try_from(field_number_u64(block, "runs")).unwrap();
		assert!(expected >= 1, "{name}: a block with no pipeline run");
		let found = hand_written.iter().filter(|n| n.as_str() == name).count();
		assert_eq!(found, expected, "{name}: recorded runs");
	}
	assert!(seeded >= 600, "only {seeded} seeded runs");
	assert!(edges >= 70, "only {edges} budget-edge runs");
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

/// Native timing scenarios: the transcript vectors cannot carry real timers, so
/// the wall-clock stop and run cancellation of a tool in flight are proved
/// here with tokio's paused clock (ADR-0030 C3: the losing tool is dropped).
mod in_flight_tool {
	use super::*;
	use research_agent_core::{runtime::AgentRunContext, tools::ToolFailure};
	use research_contracts::agent::AgentEvent;
	use std::sync::atomic::AtomicBool;

	struct FixedClock;
	impl Clock for FixedClock {
		fn now_ms(&self) -> i64 {
			1_792_195_200_000
		}
		fn now_iso(&self) -> String {
			"2026-10-17T00:00:00.000Z".to_owned()
		}
	}

	/// Replies to the planning prompt with one call to the slow tool.
	struct PlanningAgent;
	#[async_trait]
	impl AgentRuntime for PlanningAgent {
		fn agent_id(&self) -> &str {
			"scripted"
		}
		fn display_name(&self) -> &str {
			"Scripted"
		}
		fn cost_model(&self) -> CostModel {
			CostModel::PlanLimited
		}
		fn tool_isolation(&self) -> ToolIsolation {
			ToolIsolation::Enforced
		}
		async fn probe(&self) -> AgentProbe {
			AgentProbe {
				availability: AgentAvailability::Available,
				capabilities: AgentCapabilities {
					supported: Vec::new(),
					model: None,
					models: None,
				},
			}
		}
		fn run(&self, _request: AgentRequest, _context: AgentRunContext) -> AgentTurn {
			AgentTurn::from_events(vec![
				AgentEvent::TextDelta {
					text: r#"{"toolCalls":[{"toolId":"slow.read","args":{}}],"done":true}"#
						.to_owned(),
				},
				AgentEvent::Completed,
			])
		}
	}

	/// Never returns; records that its future was dropped (cancelled).
	struct SlowTool {
		meta: ToolMeta,
		started: Arc<AtomicBool>,
		dropped: Arc<AtomicBool>,
	}
	struct DropFlag(Arc<AtomicBool>);
	impl Drop for DropFlag {
		fn drop(&mut self) {
			self.0.store(true, Ordering::SeqCst);
		}
	}
	#[async_trait]
	impl Tool for SlowTool {
		fn meta(&self) -> &ToolMeta {
			&self.meta
		}
		fn parse_args(&self, args: &Value) -> Option<Value> {
			Some(args.clone())
		}
		async fn execute(
			&self,
			_args: Value,
			_context: ToolContext,
		) -> Result<ToolOutput, ToolFailure> {
			let _flag = DropFlag(Arc::clone(&self.dropped));
			self.started.store(true, Ordering::SeqCst);
			std::future::pending().await
		}
	}

	struct Fixture {
		input: ResearchPipelineInput,
		deps: ResearchPipelineDeps,
		trace: Trace,
		started: Arc<AtomicBool>,
		dropped: Arc<AtomicBool>,
	}

	fn fixture(max_wall_clock_ms: f64, tool_timeout_ms: u64) -> Fixture {
		let job = research_js::json::parse(&format!(
			r#"{{"workspaceId":"ws_t","question":"Which storage products will see demand growth?","agentId":"scripted","model":null,"effort":"medium","horizonYears":4,"markets":["US"],"budget":{{"maxAgentSteps":6,"maxToolCalls":10,"maxWallClockMs":{max_wall_clock_ms},"maxInputBytes":400000,"maxSpendUsd":null}},"webAccess":"off"}}"#
		))
		.unwrap();
		let trace = Trace::default();
		let started = Arc::new(AtomicBool::new(false));
		let dropped = Arc::new(AtomicBool::new(false));
		let tool = SlowTool {
			meta: ToolMeta {
				tool_id: "slow.read",
				version: "1",
				description: "Never returns.",
				args_hint: "{}",
				timeout_ms: tool_timeout_ms,
				permission: "research-read",
				cost_category: ToolCostCategory::Free,
				side_effect: ToolSideEffect::None,
				network_allowlist: ToolNetworkAllowlist::None,
			},
			started: Arc::clone(&started),
			dropped: Arc::clone(&dropped),
		};
		Fixture {
			input: ResearchPipelineInput {
				run_id: "run_t".to_owned(),
				request: request(&job),
				sources: Vec::new(),
				workspace_components: Vec::new(),
				conversation_context: Vec::new(),
				prior_usage: ResourceUsage::default(),
				cancel: tokio_util::sync::CancellationToken::new(),
				allow_unverified_tool_isolation: false,
			},
			deps: ResearchPipelineDeps {
				agent: Arc::new(PlanningAgent),
				tools: ToolRegistry::new(vec![Arc::new(tool) as Arc<dyn Tool>]).unwrap(),
				clock: Arc::new(FixedClock),
				reporter: Arc::new(Reporter(trace.clone())),
				new_fence_token: Arc::new(|| "fence".to_owned()),
				scratch_directory: None,
			},
			trace,
			started,
			dropped,
		}
	}

	fn tool_events(trace: &Trace) -> Vec<(String, String)> {
		trace
			.0
			.lock()
			.unwrap()
			.iter()
			.filter(|event| field(event, "type") == "tool")
			.map(|event| {
				(
					field(event, "outcome").to_owned(),
					field(event, "detail").to_owned(),
				)
			})
			.collect()
	}

	/// The run's wall-clock budget ends a tool that is still running: the tool is
	/// dropped, the stop is reported as MAX_WALL_CLOCK (the tool's own 5-minute
	/// limit would have fired much later), and nothing is retried.
	#[tokio::test(start_paused = true)]
	async fn the_run_deadline_cancels_a_tool_in_flight() {
		let Fixture {
			input,
			deps,
			trace,
			started,
			dropped,
		} = fixture(30_000.0, 300_000);
		let outcome = run_research_pipeline(input, deps).await.unwrap();
		assert!(started.load(Ordering::SeqCst));
		assert!(
			dropped.load(Ordering::SeqCst),
			"tool future was not dropped"
		);
		assert_eq!(
			tool_events(&trace),
			[("failed".to_owned(), "MAX_WALL_CLOCK".to_owned())]
		);
		match outcome {
			PipelineOutcome::Failed {
				failure_code,
				failure_detail,
				retryable,
				..
			} => {
				assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
				assert_eq!(failure_detail.as_deref(), Some("MAX_WALL_CLOCK"));
				assert!(!retryable);
			}
			other => panic!("unexpected outcome {other:?}"),
		}
	}

	/// The tool's own time limit wins when it is shorter than the run's budget:
	/// TOOL_TIMEOUT is an ordinary retryable-code tool failure, not a run stop.
	#[tokio::test(start_paused = true)]
	async fn the_tool_timeout_is_a_tool_failure_and_drops_the_tool() {
		let Fixture {
			input,
			deps,
			trace,
			dropped,
			..
		} = fixture(600_000.0, 5_000);
		let outcome = run_research_pipeline(input, deps).await.unwrap();
		assert!(
			dropped.load(Ordering::SeqCst),
			"tool future was not dropped"
		);
		assert_eq!(
			tool_events(&trace),
			[("failed".to_owned(), "TOOL_TIMEOUT".to_owned())]
		);
		match outcome {
			PipelineOutcome::Failed {
				failure_code,
				failure_detail,
				..
			} => {
				assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
				assert_eq!(failure_detail.as_deref(), Some("TOOL_TIMEOUT"));
			}
			other => panic!("unexpected outcome {other:?}"),
		}
	}

	/// The owner cancels in the same instant the run's deadline fires: the
	/// TypeScript combines the two signals, the tool sees the owner's abort and the
	/// call is recorded as TOOL_ABORTED (never as a MAX_WALL_CLOCK stop, and the
	/// run does not return `cancelled` before the plan's bookkeeping).
	#[tokio::test(start_paused = true)]
	async fn a_cancellation_that_coincides_with_the_deadline_is_a_tool_abort() {
		let Fixture {
			input,
			deps,
			trace,
			started,
			dropped,
		} = fixture(30_000.0, 300_000);
		let cancel = input.cancel.clone();
		let run = tokio::spawn(run_research_pipeline(input, deps));
		while !started.load(Ordering::SeqCst) {
			tokio::task::yield_now().await;
		}
		cancel.cancel();
		tokio::time::advance(Duration::from_millis(30_000)).await;
		let outcome = run.await.unwrap().unwrap();
		assert!(
			dropped.load(Ordering::SeqCst),
			"tool future was not dropped"
		);
		assert_eq!(
			tool_events(&trace),
			[("failed".to_owned(), "TOOL_ABORTED".to_owned())]
		);
		match outcome {
			PipelineOutcome::Failed {
				failure_code,
				failure_detail,
				..
			} => {
				assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
				assert_eq!(failure_detail.as_deref(), Some("TOOL_ABORTED"));
			}
			other => panic!("unexpected outcome {other:?}"),
		}
	}

	/// Owner cancellation while a tool runs aborts and drops the tool. As in the
	/// TypeScript, a one-call plan then ends through the zero-evidence rule
	/// (`ALL_TOOL_CALLS_FAILED` / `TOOL_ABORTED`): cancellation is only noticed
	/// at the next call or turn, and the lease holder discards the result.
	#[tokio::test(start_paused = true)]
	async fn cancelling_the_run_aborts_a_tool_in_flight() {
		let Fixture {
			input,
			deps,
			started,
			dropped,
			..
		} = fixture(600_000.0, 300_000);
		let cancel = input.cancel.clone();
		let run = tokio::spawn(run_research_pipeline(input, deps));
		while !started.load(Ordering::SeqCst) {
			tokio::task::yield_now().await;
		}
		cancel.cancel();
		let outcome = run.await.unwrap().unwrap();
		assert!(
			dropped.load(Ordering::SeqCst),
			"tool future was not dropped"
		);
		match outcome {
			PipelineOutcome::Failed {
				failure_code,
				failure_detail,
				..
			} => {
				assert_eq!(failure_code, "ALL_TOOL_CALLS_FAILED");
				assert_eq!(failure_detail.as_deref(), Some("TOOL_ABORTED"));
			}
			other => panic!("unexpected outcome {other:?}"),
		}
	}
}

/// Hot-path budgets (rr-spec-pipeline.md section 3.2-5). Timing is only
/// meaningful with optimizations: run
/// `cargo test -p research-application --release -- --ignored hot_paths --nocapture`.
mod hot_paths {
	use super::*;
	use crate::research::collect::{CollectedEntry, collected_so_far_text};
	use std::time::Instant;

	/// Best of `rounds` runs, in milliseconds (the minimum is the least noisy).
	fn best_ms(rounds: u32, mut work: impl FnMut()) -> f64 {
		(0..rounds)
			.map(|_| {
				let start = Instant::now();
				work();
				start.elapsed().as_secs_f64() * 1000.0
			})
			.fold(f64::INFINITY, f64::min)
	}

	fn cjk(len: usize) -> String {
		"日本銀行政策金利蓄電池需要予測"
			.chars()
			.cycle()
			.take(len)
			.collect()
	}

	#[test]
	#[ignore = "timing: run in release mode"]
	fn hot_paths_meet_their_budgets() {
		let job = research_js::json::parse(
			r#"{"workspaceId":"ws_t","question":"Which storage products will see demand growth?","agentId":"scripted","model":null,"effort":"medium","horizonYears":4,"markets":["JP","US"],"budget":{"maxAgentSteps":6,"maxToolCalls":10,"maxWallClockMs":600000,"maxInputBytes":400000,"maxSpendUsd":null},"webAccess":"off"}"#,
		)
		.unwrap();
		let request = request(&job);
		let sources: Vec<SubscribedSourceRef> = (0..200)
			.map(|i| SubscribedSourceRef {
				source_id: format!("src_{i}"),
				canonical_url: format!("https://news{i}.example.com/feed.xml"),
				publisher: cjk(80),
				title: cjk(120),
				license_policy: research_contracts::records::LicensePolicy::HeadlineAndLinkOnly,
			})
			.collect();
		let tool = ToolMeta {
			tool_id: "news.fetch_feed",
			version: "1",
			description: "Fetch a subscribed feed.",
			args_hint: "{\"sourceId\": string}",
			timeout_ms: 5_000,
			permission: "research-read",
			cost_category: ToolCostCategory::Free,
			side_effect: ToolSideEffect::ExternalRead,
			network_allowlist: ToolNetworkAllowlist::SubscribedSources,
		};
		let tools = vec![&tool; 12];
		let context: Vec<_> = (0..6)
			.map(|i| ConversationContextMessage {
				role: if i % 2 == 0 {
					ConversationRole::Owner
				} else {
					ConversationRole::Assistant
				},
				text: cjk(600),
			})
			.collect();
		let collected = cjk(90_000);
		let planning = best_ms(20, || {
			let prompt = planning_prompt(PlanningPromptInput {
				request: &request,
				now_iso: "2026-10-11T00:00:00.000Z",
				tools: &tools,
				sources: &sources,
				collected_so_far: &collected,
				remaining_tool_calls: 10,
				conversation_context: &context,
				fence_token: "fence-1",
				prompt_budget_bytes: PLANNING_PROMPT_BUDGET_BYTES,
				reminder: Some(PLANNING_REMINDER),
			})
			.unwrap();
			assert!(prompt.len() <= PLANNING_PROMPT_BUDGET_BYTES);
		});
		let entries: Vec<_> = (0..400)
			.map(|i| CollectedEntry {
				step: i / 8,
				full_text: cjk(2_000),
				digest_lines: vec![
					format!("[run_t_ev{i}] 日本の蓄電池需要 — Example News; undated");
					5
				],
			})
			.collect();
		let history = best_ms(20, || {
			assert!(!collected_so_far_text(&entries, 50).is_empty());
		});
		let pack = cjk(150_000);
		let analysis = best_ms(20, || {
			let prompt = analysis_prompt(AnalysisPromptInput {
				request: &request,
				now_iso: "2026-10-11T00:00:00.000Z",
				evidence_pack: &pack,
				record_summary: "(none)",
				dataset_guide: &presentation::dataset_guide("run_t"),
				existing_components: &[],
				conversation_context: &context,
				fence_token: "fence-1",
				repair_note: None,
			})
			.unwrap();
			assert!(prompt.len() > pack.len());
		});
		println!(
			"planning prompt (200 CJK sources, 90 KB collected) {planning:.3} ms; \
			 collectedSoFar (400 entries) {history:.3} ms; analysis prompt (150 KB pack) {analysis:.3} ms"
		);
		assert!(planning <= 5.0, "planning prompt {planning} ms");
		assert!(history <= 5.0, "collectedSoFar {history} ms");
		assert!(analysis <= 5.0, "analysis prompt {analysis} ms");
	}
}

mod cpu_panics {
	use super::*;

	/// A panic in off-thread CPU work is an error the caller reports, not an abort.
	#[tokio::test]
	async fn a_panicking_cpu_job_is_a_cpu_worker_error() {
		let result: Result<u32, PipelineError> =
			on_cpu(|| std::panic::resume_unwind(Box::new("boom"))).await;
		assert!(matches!(result, Err(PipelineError::CpuWorker)));
		assert_eq!(on_cpu(|| 7).await.unwrap(), 7);
	}
}
