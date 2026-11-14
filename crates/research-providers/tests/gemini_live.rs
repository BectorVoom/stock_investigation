//! Live check of the Rust Gemini adapter through the production transport
//! (DNS-pinned HTTPS, HTTP/1.1). Ignored by default: it needs the network and a
//! key. Run: `GEMINI_API_KEY=… cargo test -p research-providers --test
//! gemini_live -- --ignored --nocapture`.
#![allow(clippy::expect_used, clippy::panic)]
use research_agent_core::runtime::{AgentRunContext, AgentRuntime, Effort};
use research_contracts::agent::{AgentAvailability, AgentEvent, AgentRequest};
use research_providers::{
	environment::ProviderEnvironment,
	gemini_api::GeminiApiRuntime,
	http::PinnedProviderHttpClient,
	process::{ProcessHandle, ProcessRunner, ProcessSpec},
};
use std::{collections::BTreeMap, io, sync::Arc};
use tokio_util::sync::CancellationToken;

struct NoProcesses;
impl ProcessRunner for NoProcesses {
	fn run(&self, _spec: ProcessSpec) -> io::Result<ProcessHandle> {
		Err(io::Error::other("an HTTPS backend starts no process"))
	}
}

#[tokio::test]
#[ignore = "live: needs the network and GEMINI_API_KEY"]
async fn answers_through_the_pinned_transport() {
	let key = std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY");
	let runtime = GeminiApiRuntime::new(ProviderEnvironment {
		process_runner: Arc::new(NoProcesses),
		http: Arc::new(PinnedProviderHttpClient::new().expect("tls")),
		env: BTreeMap::from([("GEMINI_API_KEY".to_owned(), key)]),
	});
	assert_eq!(
		runtime.probe().await.availability,
		AgentAvailability::Available
	);
	for (model, effort) in [
		("gemini-3.5-flash-lite", Effort::Low),
		("gemini-3.5-flash", Effort::Medium),
	] {
		let deadline = (chrono::Utc::now() + chrono::Duration::minutes(2))
			.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
		let mut turn = runtime.run(
			AgentRequest {
				run_id: "r1".to_owned(),
				conversation_id: "c1".to_owned(),
				prompt: "日本の首都はどこですか？一語で答えてください。".to_owned(),
				permitted_tool_ids: vec![],
				max_tool_calls: 0,
				deadline,
			},
			AgentRunContext {
				cancel: CancellationToken::new(),
				scratch_directory: None,
				model: Some(model.to_owned()),
				effort,
			},
		);
		let mut text = String::new();
		let mut tail = Vec::new();
		while let Some(event) = turn.next().await {
			match event {
				AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
				other => tail.push(format!("{other:?}")),
			}
		}
		println!("{model}: {text:?} {tail:?}");
		assert!(text.contains("東京"), "{model}: {text:?} {tail:?}");
		assert!(tail.last().is_some_and(|last| last.contains("Completed")));
	}
}
