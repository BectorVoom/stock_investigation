//! The direct answer (ADR-0079): a question the first planning round judged to
//! need no research is answered from the model's general knowledge in one
//! turn, with an optional flow diagram (`directAnswer.ts`, `answerDirectly`).
use super::{
	PipelineError, PipelineOutcome, ResearchPipelineDeps, ResearchPipelineInput,
	draft::parse_draft,
	failed,
	prompts::{DirectAnswerPromptInput, PROMPT_VERSION, direct_answer_prompt},
	turn::{Session, TurnFailure},
	value::*,
};
use research_agent_core::{model_text::extract_json_object, runtime::AgentProbe};
use research_contracts::{ContractError, jobs::ResearchBundle, validate};
use research_domain::jobs::state_machine::JobState;
use research_js::{json::Value, utf16, whitespace};

/// Fewest stages a flow diagram draws (`FLOW_DIAGRAM_LIMITS.minSteps`).
const MIN_STEPS: usize = 2;

/// Japanese kana or a CJK ideograph: the question is answered with the Japanese note.
fn has_japanese_script(text: &str) -> bool {
	text.chars()
		.any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}'))
}

/// The line the pipeline — never the model — appends to every direct answer,
/// in the question's language (`directAnswerNote`).
pub(super) fn direct_answer_note(question: &str) -> &'static str {
	if has_japanese_script(question) {
		"この回答は調査を行わず、AI モデルの一般知識から書かれています。出典との照合は行っていません。投資助言ではありません。"
	} else {
		"Answered from the AI model's general knowledge without research; nothing here was checked against sources. Not investment advice."
	}
}

pub(super) struct DirectAnswerParts {
	pub answer: String,
	/// `flow-diagram` props, or `None`.
	pub diagram: Option<Value>,
	/// Why a proposed diagram was left out, for the progress log.
	pub notes: Vec<String>,
}

/// Reads the direct answer's reply (`readDirectAnswer`): prose is the answer
/// itself, JSON without a usable answer is refused, and a diagram that is not
/// a flow of 2 to 10 labelled stages is left out with a note.
pub(super) fn read_direct_answer(reply: &str) -> Option<DirectAnswerParts> {
	let Ok(json) = extract_json_object(reply) else {
		let prose = utf16::truncate(whitespace::trim(reply), 4000).into_owned();
		return (!prose.is_empty()).then_some(DirectAnswerParts {
			answer: prose,
			diagram: None,
			notes: Vec::new(),
		});
	};
	let parsed = parse_draft("direct", &json).ok()?;
	let answer = field(&parsed, "answer").to_owned();
	let proposed = get(&parsed, "diagram");
	if matches!(proposed, Value::Null) {
		return Some(DirectAnswerParts {
			answer,
			diagram: None,
			notes: Vec::new(),
		});
	}
	let diagram = parse_draft("directDiagram", proposed)
		.ok()
		.filter(|d| items(d, "steps").len() >= MIN_STEPS);
	let Some(diagram) = diagram else {
		return Some(DirectAnswerParts {
			answer,
			diagram: None,
			notes: vec![
				"The proposed diagram was left out: it was not a flow of 2 to 10 labelled stages."
					.to_owned(),
			],
		});
	};
	let steps = items(&diagram, "steps")
		.iter()
		.map(|step| {
			let detail = match get(step, "detail") {
				Value::String(text) if !text.is_empty() => s(text.as_str()),
				_ => Value::Null,
			};
			o([("label", get(step, "label").clone()), ("detail", detail)])
		})
		.collect::<Vec<_>>();
	Some(DirectAnswerParts {
		answer,
		diagram: Some(o([
			("title", get(&diagram, "title").clone()),
			("steps", a(steps)),
			("basis", s("model-knowledge")),
		])),
		notes: Vec::new(),
	})
}

/// One answer turn after the planner judged that no research is needed. The
/// stages are still walked in order; nothing is presented as verified.
pub(super) async fn answer_directly(
	session: &mut Session<'_>,
	input: &ResearchPipelineInput,
	deps: &ResearchPipelineDeps,
	probe: &AgentProbe,
) -> Result<PipelineOutcome, PipelineError> {
	deps.reporter
		.note("The planner judged that this question needs no research; answering from the model's general knowledge.")
		.await;
	deps.reporter.state(JobState::Analyzing).await;
	let prompt = direct_answer_prompt(DirectAnswerPromptInput {
		request: &input.request,
		now_iso: &deps.clock.now_iso(),
		conversation_context: &input.conversation_context,
		fence_token: &(deps.new_fence_token)(),
	})?;
	let answered = match session.turn(prompt).await {
		Ok(turn) => turn,
		Err(error) => {
			if let Some(outcome) = session.terminal(&error) {
				return Ok(outcome);
			}
			let retryable = matches!(
				error,
				TurnFailure::Provider {
					retryable: true,
					..
				}
			);
			return Ok(failed(
				error.code(),
				retryable,
				None,
				error.upstream_status(),
				session.usage,
			));
		}
	};
	deps.reporter.state(JobState::Verifying).await;
	let Some(parts) = read_direct_answer(&answered.text) else {
		return Ok(failed(
			"DIRECT_ANSWER_INVALID",
			false,
			None,
			None,
			session.usage,
		));
	};
	for note in &parts.notes {
		deps.reporter.note(note).await;
	}
	deps.reporter.state(JobState::Publishing).await;
	let operations = parts.diagram.map_or_else(Vec::new, |props| {
		vec![o([
			("operation", s("component.create")),
			("componentId", s(format!("{}_diagram", input.run_id))),
			("componentType", s("flow-diagram")),
			("schemaVersion", n(1.0)),
			("props", props),
		])]
	});
	let answer_text = utf16::truncate(
		&format!(
			"{}\n\n{}",
			parts.answer,
			direct_answer_note(&input.request.question)
		),
		6000,
	)
	.into_owned();
	let versions = Value::Object(research_js::json::Object::from_members(
		deps.tools
			.list()
			.iter()
			.map(|t| (t.meta().tool_id.to_owned(), s(t.meta().version)))
			.collect(),
	));
	let empty = || a(Vec::<Value>::new());
	let data = o([
		("evidence", empty()),
		("claims", empty()),
		("scenarios", empty()),
		("securities", empty()),
		("supplierLinks", empty()),
		("financialObservations", empty()),
		("positionObservations", empty()),
		("investorFilings", empty()),
		("pricingPower", empty()),
		("datasets", empty()),
		("uiOperations", a(operations)),
		("answerText", s(answer_text)),
		("answerClaimIds", empty()),
		("verificationStatus", s("unverified")),
		(
			"provenance",
			o([
				("agentId", s(deps.agent.agent_id())),
				(
					"providerModel",
					input
						.request
						.model
						.as_ref()
						.or(probe.capabilities.model.as_ref())
						.map(s)
						.unwrap_or_default(),
				),
				("promptVersion", s(PROMPT_VERSION)),
				("toolVersions", versions),
				("dataCutoffAt", s(deps.clock.now_iso())),
			]),
		),
	]);
	match validate::<ResearchBundle>(&data) {
		Ok(bundle) => Ok(PipelineOutcome::Completed {
			bundle,
			articles: Vec::new(),
			usage: session.usage,
		}),
		Err(error) => {
			let paths = match error {
				ContractError::Invalid(issues) => issues
					.iter()
					.take(4)
					.map(|i| i.path_string("."))
					.collect::<Vec<_>>()
					.join("; "),
				ContractError::Json(_) => String::new(),
			};
			deps.reporter
				.note(&format!("Bundle failed contract validation at: {paths}"))
				.await;
			Ok(failed("BUNDLE_INVALID", false, None, None, session.usage))
		}
	}
}
