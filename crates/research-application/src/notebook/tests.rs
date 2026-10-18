//! Node transcript replay lives here so the test harness cannot enter a production binary.

use super::*;
use crate::{
	ports::Clock,
	reporter::{PipelineReporter, ToolCallOutcome},
};
use async_trait::async_trait;
use research_agent_core::runtime::{AgentProbe, AgentRunContext, AgentRuntime, AgentTurn};
use research_contracts::{
	agent::{
		AgentAvailability, AgentCapabilities, AgentEvent, AgentRequest, CostModel, ToolIsolation,
	},
	jobs::{ClaimedJob, NotebookAssistJob},
	json::to_js_value,
	notebook::Notebook,
	widgets::WidgetCore,
};
use research_domain::jobs::{budget::ResourceUsage, state_machine::JobState};
use research_js::json::{self, Object, Value};
use serde::Serialize;
use std::{
	collections::{HashSet, VecDeque},
	sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn field<'a>(value: &'a Value, name: &str) -> &'a Value {
	static NULL: Value = Value::Null;
	value.as_object().and_then(|o| o.get(name)).unwrap_or(&NULL)
}
fn text(value: &Value) -> &str {
	value.as_str().unwrap_or_default()
}
fn array(value: &Value) -> &[Value] {
	value.as_array().unwrap_or_default()
}
fn strings(value: &Value) -> Vec<String> {
	array(value).iter().map(|v| text(v).to_owned()).collect()
}
fn member(name: &str, value: Value) -> Value {
	let mut o = Object::new();
	o.insert(name, value);
	Value::Object(o)
}
fn serialized<T: Serialize>(name: &str, value: &T) -> Value {
	member(name, to_js_value(value).unwrap())
}

fn decode_bits(value: &mut Value) {
	match value {
		Value::Object(object) => {
			if let Some(bits) = object.get("$doubleBits").and_then(Value::as_str) {
				*value = Value::Number(f64::from_bits(u64::from_str_radix(bits, 16).unwrap()));
			} else {
				let keys: Vec<_> = object.keys().map(str::to_owned).collect();
				for key in keys {
					if let Some(value) = object.get_mut(&key) {
						decode_bits(value);
					}
				}
			}
		}
		Value::Array(items) => {
			for value in items {
				decode_bits(value);
			}
		}
		_ => {}
	}
}

// JSON values compare object keys in insertion order. Contract outputs are
// structural; prompt strings (embedded within them) must remain byte-exact.
fn canonical(value: &Value) -> Value {
	match value {
		Value::Object(o) => {
			let mut entries: Vec<_> = o
				.iter()
				.map(|(k, v)| (k.to_owned(), canonical(v)))
				.collect();
			entries.sort_by(|a, b| a.0.cmp(&b.0));
			Value::Object(Object::from_members(entries))
		}
		Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
		_ => value.clone(),
	}
}
fn assert_same(actual: &Value, expected: &Value, context: &str) {
	if canonical(actual) == canonical(expected) {
		return;
	}
	let a = json::stringify(actual);
	let e = json::stringify(expected);
	let mismatch = a
		.bytes()
		.zip(e.bytes())
		.position(|(a, e)| a != e)
		.unwrap_or(a.len().min(e.len()));
	let from = mismatch.saturating_sub(100);
	let end_a = (mismatch + 240).min(a.len());
	let end_e = (mismatch + 240).min(e.len());
	panic!(
		"{context}: first difference near byte {mismatch}; actual {:?}, expected {:?}",
		a.get(from..end_a),
		e.get(from..end_e)
	);
}

#[derive(Default)]
struct Recording {
	calls: Mutex<Vec<Value>>,
}
impl Recording {
	fn push(&self, value: Value) {
		self.calls.lock().unwrap().push(value);
	}
}
struct FakeAgent {
	recording: Arc<Recording>,
	probe: AgentProbe,
	isolation: ToolIsolation,
	turns: Mutex<VecDeque<Value>>,
}
#[async_trait]
impl AgentRuntime for FakeAgent {
	fn agent_id(&self) -> &str {
		"scripted"
	}
	fn display_name(&self) -> &str {
		"Vector agent"
	}
	fn cost_model(&self) -> CostModel {
		CostModel::PlanLimited
	}
	fn tool_isolation(&self) -> ToolIsolation {
		self.isolation
	}
	async fn probe(&self) -> AgentProbe {
		let mut o = Object::new();
		o.insert(
			"capabilities",
			to_js_value(&self.probe.capabilities).unwrap(),
		);
		o.insert(
			"availability",
			to_js_value(&self.probe.availability).unwrap(),
		);
		self.recording.push(member("probe", Value::Object(o)));
		self.probe.clone()
	}
	fn run(&self, request: AgentRequest, context: AgentRunContext) -> AgentTurn {
		let mut call = Object::new();
		call.insert("request", to_js_value(&request).unwrap());
		let mut ctx = Object::new();
		ctx.insert(
			"scratchDirectory",
			context
				.scratch_directory
				.map_or(Value::Null, |p| Value::from(p.to_string_lossy().as_ref())),
		);
		ctx.insert(
			"model",
			context
				.model
				.map_or(Value::Null, |s| Value::from(s.as_str())),
		);
		ctx.insert("effort", Value::from(context.effort.as_str()));
		call.insert("context", Value::Object(ctx));
		self.recording.push(Value::Object(call));
		let script = self.turns.lock().unwrap().pop_front().unwrap();
		// Cancellation in the TS fake happens during iteration, before the
		// final usage report. Cancellation never stops the notebook's loop.
		if field(&script, "aborted").as_bool() == Some(true) {
			context.cancel.cancel();
		}
		let events = array(field(&script, "events"))
			.iter()
			.map(|event| {
				// Invalid event bounds remain typed and are rejected by the actual turn loop.
				match research_contracts::validate::<AgentEvent>(event) {
					Ok(event) => event,
					Err(_) => AgentEvent::Failed {
						code: text(field(event, "code")).to_owned(),
						retryable: field(event, "retryable").as_bool().unwrap_or(false),
					},
				}
			})
			.collect();
		assert_eq!(
			field(&script, "threw"),
			&Value::Null,
			"TS throws require a Rust panic-specific test"
		);
		AgentTurn::from_events(events)
	}
}
struct FakeClock {
	recording: Arc<Recording>,
	times: Mutex<VecDeque<i64>>,
}
impl Clock for FakeClock {
	fn now_ms(&self) -> i64 {
		let time = self.times.lock().unwrap().pop_front().unwrap();
		self.recording
			.push(member("clock", json::parse(&time.to_string()).unwrap()));
		time
	}
	fn now_iso(&self) -> String {
		panic!("unused clock port")
	}
}
struct Reporter {
	recording: Arc<Recording>,
	cancel: CancellationToken,
	cancel_at: Option<usize>,
}
impl Reporter {
	fn push(&self, value: Value) {
		self.recording.push(value);
		if self.cancel_at == Some(self.recording.calls.lock().unwrap().len()) {
			self.cancel.cancel();
		}
	}
}
#[async_trait]
impl PipelineReporter for Reporter {
	async fn state(&self, state: JobState) {
		self.push(member("state", Value::from(state.as_str())));
	}
	async fn note(&self, note: &str) {
		self.push(member("note", Value::from(note)));
	}
	async fn usage(&self, usage: &ResourceUsage) {
		self.push(serialized("usage", usage));
	}
	async fn tool(&self, _: &str, _: ToolCallOutcome, _: &str) {
		panic!("notebook cannot call tools")
	}
}

fn job(input: &Value) -> TestResult<NotebookAssistJob> {
	let mut job = input.clone();
	let notebook = research_contracts::validate::<Notebook>(field(input, "notebook"))?;
	let ids = strings(field(input, "selectedWidgetIds"));
	let allow = field(input, "allowUnverifiedToolIsolation")
		.as_bool()
		.unwrap_or(false);
	if let Value::Object(object) = &mut job {
		object.remove("allowUnverifiedToolIsolation");
		object.insert("selectedWidgetIds", Value::Array(Vec::new()));
	}
	let ClaimedJob::NotebookAssist(mut job) = research_contracts::validate::<ClaimedJob>(&job)?
	else {
		panic!("notebook claim required");
	};
	// Existing tests deliberately exceed the selection bound to exercise the
	// application prompt budget directly. Production claims stay validated.
	job.selected_widget_ids = ids;
	job.notebook = notebook;
	let _ = allow;
	Ok(job)
}

async fn replay_turn(input: &Value, expected: &Value) -> TestResult {
	let job = job(field(input, "job"))?;
	let cancel = CancellationToken::new();
	if field(input, "preAborted").as_bool() == Some(true) {
		cancel.cancel();
	}
	let recording = Arc::new(Recording::default());
	let probe = field(input, "probe");
	let agent = FakeAgent {
		recording: recording.clone(),
		probe: if probe == &Value::Null {
			AgentProbe {
				capabilities: AgentCapabilities {
					supported: Vec::new(),
					model: None,
					models: None,
				},
				availability: AgentAvailability::Available,
			}
		} else {
			AgentProbe {
				capabilities: research_contracts::validate(field(probe, "capabilities"))?,
				availability: research_contracts::validate(field(probe, "availability"))?,
			}
		},
		isolation: if text(field(input, "isolation")) == "unverified" {
			ToolIsolation::Unverified
		} else {
			ToolIsolation::Enforced
		},
		turns: Mutex::new(array(field(input, "turns")).iter().cloned().collect()),
	};
	let times = array(field(input, "clocks"))
		.iter()
		.map(|v| json::stringify(v).parse::<i64>().unwrap())
		.collect();
	let clock = FakeClock {
		recording: recording.clone(),
		times: Mutex::new(times),
	};
	let fences = Mutex::new(VecDeque::from(strings(field(input, "fences"))));
	let fence = || {
		let token = fences.lock().unwrap().pop_front().unwrap();
		recording.push(member("fence", Value::from(token.as_str())));
		token
	};
	// Runner tests request cancellation through their reporter at the first
	// API event. The transcript pins that boundary without a production seam.
	let cancel_at = array(field(input, "cancelAfterCalls"))
		.first()
		.map(|v| json::stringify(v).parse::<usize>().unwrap());
	let reporter = Reporter {
		recording: recording.clone(),
		cancel: cancel.clone(),
		cancel_at,
	};
	let outcome = run_notebook_assist_turn(
		&NotebookAssistTurnInput {
			job: &job,
			cancel: &cancel,
			allow_unverified_tool_isolation: field(
				field(input, "job"),
				"allowUnverifiedToolIsolation",
			)
			.as_bool()
			.unwrap_or(false),
		},
		&NotebookAssistTurnDeps {
			agent: &agent,
			clock: &clock,
			reporter: &reporter,
			new_fence_token: &fence,
			scratch_directory: field(input, "scratchDirectory").as_str().map(Into::into),
		},
	)
	.await?;
	assert_same(
		&Value::Array(recording.calls.lock().unwrap().clone()),
		field(expected, "calls"),
		"calls",
	);
	assert_same(
		&to_js_value(&outcome)?,
		field(expected, "outcome"),
		"outcome",
	);
	Ok(())
}

fn replay_commands(input: &Value, expected: &Value) -> TestResult {
	let notebook = research_contracts::validate::<Notebook>(field(input, "notebook"))?;
	let ids = strings(field(input, "ids"));
	let mut ids = ids.into_iter();
	let known = strings(field(input, "known"));
	let known: HashSet<&str> = known.iter().map(String::as_str).collect();
	let result = super::commands::apply_with_components(
		&notebook,
		array(field(input, "commands")),
		&known,
		&mut || ids.next(),
	);
	if field(expected, "ok").as_bool() == Some(true) {
		let actual = result?;
		let expected: Vec<WidgetCore> = array(field(expected, "widgets"))
			.iter()
			.map(research_contracts::validate)
			.collect::<Result<_, _>>()?;
		assert_same(&to_js_value(&actual)?, &to_js_value(&expected)?, "widgets");
	} else {
		let error = result.unwrap_err();
		assert_same(
			&Value::from(error.code.as_str()),
			field(field(field(expected, "error"), "failure"), "code"),
			"command code",
		);
		assert_same(
			&Value::from(error.message.as_str()),
			field(field(field(expected, "error"), "failure"), "message"),
			"command message",
		);
		assert_eq!(
			error.index.to_string(),
			json::stringify(field(field(expected, "error"), "index"))
		);
	}
	Ok(())
}

#[tokio::test]
async fn node_generated_notebook_transcripts() -> TestResult {
	let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vectors/notebook");
	let mut paths: Vec<_> = std::fs::read_dir(root)?
		.map(|e| e.map(|e| e.path()))
		.collect::<Result<_, _>>()?;
	paths.sort();
	let mut turns = 0;
	let mut commands = 0;
	for path in paths {
		if !path
			.file_name()
			.is_some_and(|name| name.to_string_lossy().starts_with("transcripts-"))
		{
			continue;
		}
		let mut cases = json::parse(&std::fs::read_to_string(&path)?)?;
		decode_bits(&mut cases);
		for (index, case) in array(&cases).iter().enumerate() {
			let result = if text(field(case, "area")) == "turn" {
				turns += 1;
				replay_turn(field(case, "input"), field(case, "output")).await
			} else {
				commands += 1;
				replay_commands(field(case, "input"), field(case, "output"))
			};
			if let Err(error) = result {
				panic!("{} case {index}: {error}", path.display());
			}
		}
	}
	assert!(turns >= 90);
	assert!(commands >= 30);
	eprintln!("Replayed {turns} whole turns and {commands} command batches");
	Ok(())
}

fn benchmark_input() -> TestResult<(Notebook, Vec<Value>)> {
	let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../vectors/notebook/benchmark.json");
	let mut data = json::parse(&std::fs::read_to_string(path)?)?;
	decode_bits(&mut data);
	Ok((
		research_contracts::validate(field(&data, "notebook"))?,
		array(field(&data, "commands")).to_vec(),
	))
}

#[test]
#[ignore = "timing guard: run explicitly on an idle machine with --release"]
fn notebook_performance_budgets() -> TestResult {
	use std::{hint::black_box, time::Instant};
	let (notebook, commands) = benchmark_input()?;
	let prompt = || {
		notebook_assist_prompt(&NotebookAssistPromptInput {
			notebook: &notebook,
			selected_widget_ids: &[],
			instruction: "Tidy this notebook.",
			conversation_context: &[],
			fence_token: "bench-fence",
			repair_note: None,
		})
		.unwrap()
	};
	let mut room = notebook.clone();
	room.widgets.pop();
	let apply = || {
		let mut id = 0;
		apply_notebook_commands(&room, &commands, &mut || {
			id += 1;
			Some(format!("nb_new_{id}"))
		})
		.unwrap()
	};
	let measure = |label: &str, budget: f64, run: &mut dyn FnMut()| {
		for _ in 0..3 {
			run();
		}
		let mut samples = Vec::new();
		for _ in 0..9 {
			let start = Instant::now();
			run();
			samples.push(start.elapsed().as_secs_f64() * 1000.0);
		}
		samples.sort_by(f64::total_cmp);
		let median = samples[4];
		eprintln!("{label}: {median:.3} ms (budget {budget} ms)");
		median <= budget
	};
	let prompt_ok = measure("full notebook prompt", 5.0, &mut || {
		black_box(prompt());
	});
	let bytes_ok = measure("full notebook content bytes", 8.0, &mut || {
		black_box(research_contracts::widget_rules::notebook_content_bytes(
			&notebook.widgets,
		));
	});
	let commands_ok = measure("12 notebook commands", 10.0, &mut || {
		black_box(apply());
	});
	assert!(
		prompt_ok && bytes_ok && commands_ok,
		"notebook performance budget exceeded"
	);
	Ok(())
}

#[tokio::test]
async fn panic_and_cancellation_wait_for_producer_cleanup() -> TestResult {
	use std::sync::atomic::{AtomicBool, Ordering};
	struct Producer {
		cleanup: Arc<AtomicBool>,
		mode: u8,
	}
	#[async_trait]
	impl AgentRuntime for Producer {
		fn agent_id(&self) -> &str {
			"scripted"
		}
		fn display_name(&self) -> &str {
			"Producer test"
		}
		fn cost_model(&self) -> CostModel {
			CostModel::PlanLimited
		}
		fn tool_isolation(&self) -> ToolIsolation {
			ToolIsolation::Enforced
		}
		async fn probe(&self) -> AgentProbe {
			AgentProbe {
				capabilities: AgentCapabilities {
					supported: Vec::new(),
					model: None,
					models: None,
				},
				availability: AgentAvailability::Available,
			}
		}
		fn run(&self, _: AgentRequest, context: AgentRunContext) -> AgentTurn {
			let flag = self.cleanup.clone();
			let mode = self.mode;
			AgentTurn::spawn(&context.cancel.clone(), move |sender| async move {
				if mode == 0 {
					flag.store(true, Ordering::SeqCst);
					panic!("adapter bug");
				}
				if mode == 1 {
					context.cancel.cancel();
				}
				if mode == 2 {
					sender
						.send(AgentEvent::Usage {
							known_cost_usd: Some(f64::NAN),
						})
						.await;
				}
				sender.send(AgentEvent::Completed).await;
				sender.cancel_token().cancelled().await;
				flag.store(true, Ordering::SeqCst);
			})
		}
	}
	let (notebook, _) = benchmark_input()?;
	let lease = research_contracts::jobs::Lease {
		run_id: "test".to_owned(),
		lease_generation: 1,
		lease_expires_at: "2026-10-14T00:00:00.000Z".to_owned(),
		attempt: 1,
		heartbeat_interval_ms: 20_000,
		sources: Vec::new(),
	};
	let job = NotebookAssistJob {
		lease,
		workspace_id: "ws_test".to_owned(),
		agent: research_contracts::jobs::NotebookAssistAgent {
			agent_id: "scripted".to_owned(),
			model: None,
			effort: research_contracts::jobs::Effort::Medium,
		},
		instruction: "Test.".to_owned(),
		selected_widget_ids: Vec::new(),
		notebook,
		notebook_version: 4,
		conversation_context: Vec::new(),
	};
	for mode in 0..3 {
		let cleanup = Arc::new(AtomicBool::new(false));
		let agent = Producer {
			cleanup: cleanup.clone(),
			mode,
		};
		let recording = Arc::new(Recording::default());
		let cancel = CancellationToken::new();
		let reporter = Reporter {
			recording: recording.clone(),
			cancel: cancel.clone(),
			cancel_at: None,
		};
		let clock = FakeClock {
			recording,
			times: Mutex::new(VecDeque::from([0])),
		};
		let outcome = run_notebook_assist_turn(
			&NotebookAssistTurnInput {
				job: &job,
				cancel: &cancel,
				allow_unverified_tool_isolation: false,
			},
			&NotebookAssistTurnDeps {
				agent: &agent,
				clock: &clock,
				reporter: &reporter,
				new_fence_token: &|| "test-fence".to_owned(),
				scratch_directory: None,
			},
		)
		.await?;
		assert!(
			cleanup.load(Ordering::SeqCst),
			"turn returned before producer cleanup"
		);
		match (mode, outcome) {
			(
				0,
				NotebookAssistTurnOutcome::Failed {
					failure_code,
					retryable,
					usage,
				},
			) => {
				assert_eq!(failure_code, "AGENT_THREW_Panic");
				assert!(retryable);
				assert_eq!(usage.agent_steps, 1);
				assert!(usage.has_unmetered_usage);
			}
			(1, NotebookAssistTurnOutcome::Cancelled { usage }) => assert_eq!(usage.agent_steps, 1),
			(
				2,
				NotebookAssistTurnOutcome::Failed {
					failure_code,
					retryable,
					..
				},
			) => {
				assert_eq!(failure_code, "AGENT_EVENT_INVALID");
				assert!(!retryable);
			}
			(_, outcome) => panic!("unexpected outcome {outcome:?}"),
		}
	}
	Ok(())
}
