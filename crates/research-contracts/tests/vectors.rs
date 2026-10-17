//! Replays `vectors/contracts/*.json` (written by Node from the real zod
//! schemas: `node scripts/vectors/index.ts contracts`): for every case the
//! Rust decoder must give zod's verdict, zod's issues (code, path, message,
//! in order) and, for a valid input, zod's parsed value byte for byte.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::collections::BTreeMap;

use research_contracts::json::to_js_json;
use research_contracts::{Contract, Cx, PathSegment};
use research_js::json::Value;
use serde::Serialize;

type Outcome = (Option<String>, Vec<research_contracts::Issue>);
type Runner = fn(&Value) -> Outcome;

fn run<T: Contract + Serialize>(value: &Value) -> Outcome {
	let mut cx = Cx::new();
	let decoded = T::decode(&mut cx, Some(value));
	let issues = cx.into_issues();
	let output = match decoded {
		Some(decoded) if issues.is_empty() => Some(to_js_json(&decoded).unwrap()),
		_ => None,
	};
	(output, issues)
}

macro_rules! registry {
	($($name:literal => $ty:ty),* $(,)?) => {{
		let mut map: BTreeMap<&'static str, Runner> = BTreeMap::new();
		$(map.insert($name, run::<$ty> as Runner);)*
		map
	}};
}

fn runners() -> BTreeMap<&'static str, Runner> {
	use research_contracts::*;
	registry! {
		"agentDescriptor" => agent::AgentDescriptor,
		"agentRequest" => agent::AgentRequest,
		"agentEvent" => agent::AgentEvent,
		"resourceUsage" => jobs::ResourceUsage,
		"researchBudget" => jobs::ResearchBudget,
		"researchRequest" => jobs::ResearchRequest,
		"bundleProvenance" => jobs::BundleProvenance,
		"ingestedArticle" => records::IngestedArticle,
		"evidence" => records::Evidence,
		"claim" => records::Claim,
		"demandScenario" => records::DemandScenario,
		"security" => records::Security,
		"supplierLink" => records::SupplierLink,
		"reportingPeriod" => records::ReportingPeriod,
		"financialObservation" => records::FinancialObservation,
		"positionFigures" => records::PositionFigures,
		"positionObservation" => records::PositionObservation,
		"investorFiling" => records::InvestorFiling,
		"pricingPowerRecord" => records::PricingPowerRecord,
		"datasetCell" => records::DatasetCell,
		"datasetColumn" => records::DatasetColumn,
		"dataset" => records::Dataset,
		"uiOperation" => ui::UiOperation,
		"researchBundle" => jobs::ResearchBundle,
		"sourceFetchReport" => jobs::SourceFetchReport,
		"subscribedSourceRef" => jobs::SubscribedSourceRef,
		"claimJobRequest" => jobs::ClaimJobRequest,
		"workspaceComponentSummary" => jobs::WorkspaceComponentSummary,
		"conversationContextMessage" => jobs::ConversationContextMessage,
		"conversationContext" => ConversationContext,
		"claimedJob" => jobs::ClaimedJob,
		"claimJobResponse" => jobs::ClaimJobResponse,
		"heartbeatRequest" => jobs::HeartbeatRequest,
		"heartbeatResponse" => jobs::HeartbeatResponse,
		"eventsResponse" => jobs::EventsResponse,
		"runnerEvent" => jobs::RunnerEvent,
		"runnerEventsRequest" => jobs::RunnerEventsRequest,
		"completeJobRequest" => jobs::CompleteJobRequest,
		"completeJobResponse" => jobs::CompleteJobResponse,
		"marketSeriesMeta" => market::MarketSeriesMeta,
		"marketObservation" => market::MarketObservation,
		"earningsEvent" => watchlist::EarningsEvent,
		"googleEventBody" => google_calendar::GoogleEventBody,
		"widgetCore" => widgets::WidgetCore,
		"notebookWidget" => notebook::NotebookWidget,
		"notebook" => notebook::Notebook,
		"issuedRunnerCredential" => api::IssuedRunnerCredential,
		"apiErrorBody" => api::ApiErrorBody,
	}
}

fn vector_dir() -> String {
	format!("{}/../../vectors/contracts", env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &str) -> Value {
	let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{path}: {error}"));
	research_js::json::parse(&text).unwrap()
}

fn path_matches(expected: &Value, actual: &[PathSegment]) -> bool {
	let expected = expected.as_array().unwrap();
	expected.len() == actual.len()
		&& expected
			.iter()
			.zip(actual)
			.all(|(want, got)| match (want, got) {
				(Value::String(key), PathSegment::Key(got)) => key == got,
				(Value::Number(index), PathSegment::Index(got)) => {
					*index == f64::from(u32::try_from(*got).unwrap())
				}
				_ => false,
			})
}

#[test]
fn every_exported_schema_has_a_rust_decoder() {
	let index = read_json(&format!("{}/index.json", vector_dir()));
	let names: Vec<&str> = index
		.as_array()
		.unwrap()
		.iter()
		.map(|name| name.as_str().unwrap())
		.collect();
	let runners = runners();
	for name in &names {
		assert!(
			runners.contains_key(name),
			"no Rust decoder registered for {name}"
		);
	}
	for name in runners.keys() {
		assert!(
			names.contains(name),
			"{name} has a Rust decoder but no vectors"
		);
	}
}

#[test]
fn decoders_match_zod() {
	let index = read_json(&format!("{}/index.json", vector_dir()));
	let runners = runners();
	let mut failures = Vec::new();
	let mut total = 0usize;
	for name in index.as_array().unwrap() {
		let name = name.as_str().unwrap();
		let Some(runner) = runners.get(name) else {
			continue;
		};
		let file = read_json(&format!("{}/{name}.json", vector_dir()));
		for case in file
			.as_object()
			.unwrap()
			.get("cases")
			.unwrap()
			.as_array()
			.unwrap()
		{
			total += 1;
			let case = case.as_object().unwrap();
			let input_text = case.get("input").unwrap().as_str().unwrap();
			let input = research_js::json::parse(input_text).unwrap();
			let valid = case.get("valid").unwrap().as_bool().unwrap();
			let (output, issues) = runner(&input);
			let problem = if valid {
				let expected = case.get("output").unwrap().as_str().unwrap();
				match output {
					Some(output) if output == expected => None,
					Some(output) => Some(format!(
						"output differs\n  zod:  {expected}\n  rust: {output}"
					)),
					None => Some(format!("rejected a valid input: {issues:?}")),
				}
			} else {
				let expected = case.get("issues").unwrap().as_array().unwrap();
				let same = expected.len() == issues.len()
					&& expected.iter().zip(&issues).all(|(want, got)| {
						let want = want.as_object().unwrap();
						want.get("code").unwrap().as_str() == Some(got.code.as_str())
							&& want.get("message").unwrap().as_str() == Some(got.message.as_str())
							&& path_matches(want.get("path").unwrap(), &got.path)
					});
				if same {
					None
				} else {
					let expected = research_js::json::stringify(case.get("issues").unwrap());
					let actual: Vec<String> = issues
						.iter()
						.map(|issue| {
							format!(
								"{} [{}] {}",
								issue.code.as_str(),
								issue.path_string("."),
								issue.message
							)
						})
						.collect();
					Some(format!(
						"issues differ\n  zod:  {expected}\n  rust: {actual:?}"
					))
				}
			};
			if let Some(problem) = problem {
				failures.push(format!("{name}: {}\n  {problem}", truncate(input_text)));
			}
		}
	}
	assert!(total > 0);
	if !failures.is_empty() {
		let mut per_schema: BTreeMap<&str, usize> = BTreeMap::new();
		for failure in &failures {
			*per_schema
				.entry(failure.split(':').next().unwrap_or(""))
				.or_default() += 1;
		}
		eprintln!("failures per schema: {per_schema:?}");
		let shown: Vec<&String> = failures.iter().take(15).collect();
		panic!(
			"{} of {total} cases differ from zod:\n{}",
			failures.len(),
			shown
				.iter()
				.map(|s| s.as_str())
				.collect::<Vec<_>>()
				.join("\n")
		);
	}
}

fn truncate(text: &str) -> String {
	if text.chars().count() > 300 {
		format!("{}…", text.chars().take(300).collect::<String>())
	} else {
		text.to_owned()
	}
}
