//! Replays `vectors/company-summary/*.json` (the TypeScript prompt and reply
//! check) and runs the turn against a scripted agent.

use super::*;
use crate::reporter::ToolCallOutcome;
use async_trait::async_trait;
use research_agent_core::runtime::{AgentProbe, AgentTurn};
use research_contracts::agent::{AgentAvailability, AgentCapabilities, Capability, CostModel};
use research_contracts::jobs::ClaimedJob;
use research_contracts::json::to_js_json;
use research_js::json::{self, Value};
use std::sync::Mutex;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn vector(name: &str) -> TestResult<Vec<Value>> {
	let path = format!(
		"{}/../../vectors/company-summary/{name}.json",
		env!("CARGO_MANIFEST_DIR")
	);
	let value = json::parse(&std::fs::read_to_string(path)?)?;
	Ok(value.as_array().ok_or("not an array")?.to_vec())
}

fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
	static NULL: Value = Value::Null;
	value.as_object().and_then(|o| o.get(name)).unwrap_or(&NULL)
}

fn optional_text(value: &Value) -> Option<String> {
	value.as_str().map(str::to_owned)
}

#[test]
fn prompts_match_the_typescript() -> TestResult {
	let cases = vector("prompts")?;
	assert!(!cases.is_empty());
	for case in &cases {
		let input = field(case, "input");
		let facts = field(input, "facts");
		let facts = CompanySummaryFacts {
			name: optional_text(field(facts, "name")),
			local_name: optional_text(field(facts, "localName")),
			listing: optional_text(field(facts, "listing")),
			sector: optional_text(field(facts, "sector")),
			business_excerpt: optional_text(field(facts, "businessExcerpt")),
		};
		let built = company_summary_prompt(&CompanySummaryPromptInput {
			stock_id: field(input, "stockId").as_str().ok_or("stockId")?,
			facts: &facts,
			fence_token: field(input, "fenceToken").as_str().ok_or("fenceToken")?,
			repair_note: field(input, "repairNote").as_str(),
		})?;
		assert_eq!(built, field(case, "output").as_str().ok_or("output")?);
	}
	Ok(())
}

#[test]
fn reply_checks_match_the_typescript() -> TestResult {
	let cases = vector("replies")?;
	assert!(!cases.is_empty());
	for case in &cases {
		let text = field(case, "input").as_str().ok_or("input")?;
		let output = field(case, "output");
		match check_company_summary_reply(text) {
			Ok(summary) => {
				assert_eq!(field(output, "ok").as_bool(), Some(true), "{text}");
				assert_eq!(
					Some(to_js_json(&summary)?.as_str()),
					field(output, "summary").as_str(),
					"{text}"
				);
			}
			Err(message) => {
				assert_eq!(field(output, "ok").as_bool(), Some(false), "{text}");
				assert_eq!(Some(message.as_str()), field(output, "message").as_str());
			}
		}
	}
	Ok(())
}

#[test]
fn an_empty_fence_token_is_a_programming_error_only_with_a_fact() {
	let none = CompanySummaryFacts {
		name: None,
		local_name: None,
		listing: None,
		sector: None,
		business_excerpt: None,
	};
	let input = |facts| CompanySummaryPromptInput {
		stock_id: "us:AAPL",
		facts,
		fence_token: "",
		repair_note: None,
	};
	assert!(company_summary_prompt(&input(&none)).is_ok());
	let named = CompanySummaryFacts {
		name: Some("Apple Inc.".to_owned()),
		..none.clone()
	};
	assert!(matches!(
		company_summary_prompt(&input(&named)),
		Err(CompanySummaryError::EmptyFence)
	));
}

/* ---------- the turn ---------- */

struct Agent {
	replies: Vec<Vec<AgentEvent>>,
	prompts: Mutex<Vec<AgentRequest>>,
	availability: AgentAvailability,
	isolation: ToolIsolation,
}

impl Agent {
	fn replying(texts: &[&str]) -> Self {
		Self::with_events(
			texts
				.iter()
				.map(|text| {
					vec![
						AgentEvent::TextDelta {
							text: (*text).to_owned(),
						},
						AgentEvent::Usage {
							known_cost_usd: Some(0.25),
						},
						AgentEvent::Completed,
					]
				})
				.collect(),
		)
	}
	fn with_events(replies: Vec<Vec<AgentEvent>>) -> Self {
		Self {
			replies,
			prompts: Mutex::new(Vec::new()),
			availability: AgentAvailability::Available,
			isolation: ToolIsolation::Enforced,
		}
	}
	fn requests(&self) -> Vec<AgentRequest> {
		self.prompts.lock().map(|r| r.clone()).unwrap_or_default()
	}
}

#[async_trait]
impl AgentRuntime for Agent {
	fn agent_id(&self) -> &str {
		"scripted"
	}
	fn display_name(&self) -> &str {
		"Scripted"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::Metered
	}
	fn tool_isolation(&self) -> ToolIsolation {
		self.isolation
	}
	async fn probe(&self) -> AgentProbe {
		AgentProbe {
			capabilities: AgentCapabilities {
				supported: vec![Capability::Stream],
				model: None,
				models: None,
			},
			availability: self.availability.clone(),
		}
	}
	fn run(&self, request: AgentRequest, _context: AgentRunContext) -> AgentTurn {
		let mut prompts = self.prompts.lock().unwrap_or_else(|e| e.into_inner());
		let index = prompts.len();
		prompts.push(request);
		AgentTurn::from_events(self.replies.get(index).cloned().unwrap_or_default())
	}
}

struct FixedClock;
impl Clock for FixedClock {
	fn now_ms(&self) -> i64 {
		1_791_676_800_000
	}
	fn now_iso(&self) -> String {
		"2026-10-11T00:00:00.000Z".to_owned()
	}
}

#[derive(Default)]
struct Reporter {
	log: Mutex<Vec<String>>,
}
impl Reporter {
	fn push(&self, entry: String) {
		self.log
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.push(entry);
	}
	fn entries(&self) -> Vec<String> {
		self.log.lock().map(|l| l.clone()).unwrap_or_default()
	}
}
#[async_trait]
impl PipelineReporter for Reporter {
	async fn state(&self, state: JobState) {
		self.push(format!("state {}", state.as_str()));
	}
	async fn note(&self, text: &str) {
		self.push(format!("note {text}"));
	}
	async fn tool(&self, tool_id: &str, _outcome: ToolCallOutcome, _detail: &str) {
		self.push(format!("tool {tool_id}"));
	}
	async fn usage(&self, usage: &ResourceUsage) {
		self.push(format!("usage {} steps", usage.agent_steps));
	}
}

fn job() -> TestResult<CompanySummaryJob> {
	let claimed: ClaimedJob = research_contracts::parse(
		r#"{"kind":"company-summary","runId":"run_summary","leaseGeneration":2,"leaseExpiresAt":"2026-10-11T00:01:30.000Z","attempt":1,"heartbeatIntervalMs":20000,"sources":[],"stockId":"jp:7203","agent":{"agentId":"scripted","model":"m-1","effort":"high"},"facts":{"name":"TOYOTA MOTOR CORPORATION","localName":"トヨタ自動車","listing":"tse-prime","sector":null,"businessExcerpt":null}}"#,
	)?;
	match claimed {
		ClaimedJob::CompanySummary(job) => Ok(job),
		_ => Err("not a company-summary job".into()),
	}
}

async fn run_with(
	agent: &Agent,
	reporter: &Reporter,
	cancel: &CancellationToken,
) -> TestResult<CompanySummaryTurnOutcome> {
	let job = job()?;
	let fence = || "fence".to_owned();
	Ok(run_company_summary_turn(
		&CompanySummaryTurnInput {
			job: &job,
			cancel,
			allow_unverified_tool_isolation: false,
		},
		&CompanySummaryTurnDeps {
			agent,
			clock: &FixedClock,
			reporter,
			new_fence_token: &fence,
			scratch_directory: None,
		},
	)
	.await?)
}

const GOOD: &str = r#"{"description":{"en":"Toyota builds cars.","ja":"トヨタは自動車を作ります。"},"themes":[{"en":"Automobiles","ja":"自動車"}]}"#;

#[tokio::test]
async fn one_valid_reply_is_the_summary() -> TestResult {
	let agent = Agent::replying(&[GOOD]);
	let reporter = Reporter::default();
	let outcome = run_with(&agent, &reporter, &CancellationToken::new()).await?;
	let CompanySummaryTurnOutcome::Summarized { summary, usage } = outcome else {
		return Err(format!("{outcome:?}").into());
	};
	assert_eq!(to_js_json(&summary)?, GOOD);
	assert_eq!(usage.agent_steps, 1);
	assert!((usage.known_cost_usd - 0.25).abs() < 1e-9);
	let requests = agent.requests();
	assert_eq!(requests.len(), 1);
	let request = requests.first().ok_or("no request")?;
	assert_eq!(request.conversation_id, "run_summary");
	assert!(request.permitted_tool_ids.is_empty());
	assert_eq!(request.max_tool_calls, 0);
	assert_eq!(request.deadline, "2026-10-11T00:10:00.000Z");
	assert!(request.prompt.starts_with(COMPANY_SUMMARY_TURN_MARKER));
	assert_eq!(usage.input_bytes, request.prompt.len() as u64);
	assert_eq!(
		reporter.entries(),
		[
			"state planning",
			"state collecting",
			"state analyzing",
			"usage 1 steps",
			"state verifying",
			"state publishing",
		]
	);
	Ok(())
}

#[tokio::test]
async fn one_repair_then_the_reply_is_invalid() -> TestResult {
	let agent = Agent::replying(&["no json", r#"{"themes": []}"#]);
	let reporter = Reporter::default();
	let outcome = run_with(&agent, &reporter, &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, retryable: false, usage, .. }
			if failure_code == "COMPANY_SUMMARY_REPLY_INVALID" && usage.agent_steps == 2
	));
	let requests = agent.requests();
	assert_eq!(requests.len(), 2);
	assert!(requests.get(1).is_some_and(|r| r.prompt.ends_with(
		"\n\nYour previous answer was rejected: the reply contained no parseable JSON object. Answer again with valid JSON."
	)));
	assert_eq!(
		reporter.entries(),
		[
			"state planning",
			"state collecting",
			"state analyzing",
			"usage 1 steps",
			"state verifying",
			"note The first reply was rejected; asking for corrected JSON.",
			"usage 2 steps",
		]
	);
	Ok(())
}

#[tokio::test]
async fn a_repaired_reply_is_the_summary() -> TestResult {
	let agent = Agent::replying(&["sorry", GOOD]);
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		outcome,
		CompanySummaryTurnOutcome::Summarized { .. }
	));
	Ok(())
}

#[tokio::test]
async fn provider_failures_keep_their_status_and_an_early_end_is_retryable() -> TestResult {
	let agent = Agent::with_events(vec![vec![AgentEvent::Failed {
		code: "AGENT_RATE_LIMITED".to_owned(),
		retryable: true,
		upstream_status: Some(429),
	}]]);
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, failure_upstream_status: Some(429), retryable: true, .. }
			if failure_code == "AGENT_RATE_LIMITED"
	));
	let agent = Agent::with_events(vec![vec![AgentEvent::TextDelta {
		text: GOOD.to_owned(),
	}]]);
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, retryable: true, .. }
			if failure_code == "AGENT_STREAM_ENDED_EARLY"
	));
	let agent = Agent::with_events(vec![vec![
		AgentEvent::TextDelta {
			text: "a".repeat(100_000),
		},
		AgentEvent::TextDelta {
			text: "a".to_owned(),
		},
		AgentEvent::Completed,
	]]);
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, retryable: false, .. }
			if failure_code == "AGENT_OUTPUT_TOO_LARGE"
	));
	Ok(())
}

#[tokio::test]
async fn an_unavailable_or_unisolated_backend_fails_closed_and_a_cancel_wins() -> TestResult {
	let mut agent = Agent::replying(&[GOOD]);
	agent.availability = AgentAvailability::Unavailable {
		reason_code: research_contracts::agent::UnavailableReason::NotInstalled,
		detail: "missing".to_owned(),
	};
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, retryable: false, .. }
			if failure_code == "AGENT_UNAVAILABLE_NOT_INSTALLED"
	));
	let mut agent = Agent::replying(&[GOOD]);
	agent.isolation = ToolIsolation::Unverified;
	let outcome = run_with(&agent, &Reporter::default(), &CancellationToken::new()).await?;
	assert!(matches!(
		&outcome,
		CompanySummaryTurnOutcome::Failed { failure_code, .. }
			if failure_code == "TOOL_ISOLATION_UNVERIFIED"
	));
	let cancel = CancellationToken::new();
	cancel.cancel();
	let agent = Agent::replying(&[GOOD]);
	let outcome = run_with(&agent, &Reporter::default(), &cancel).await?;
	assert!(matches!(
		outcome,
		CompanySummaryTurnOutcome::Cancelled { .. }
	));
	assert!(agent.requests().is_empty());
	Ok(())
}
