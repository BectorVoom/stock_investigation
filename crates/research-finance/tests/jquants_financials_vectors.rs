//! Replays `vectors/finance/jquants_financials.json` (ADR-0059 §2), written
//! by Node from the TypeScript `jquantsSummariesToSync`
//! (`scripts/vectors/finance/jquantsFinancials.ts`): cases
//! `{ name, code, knownDisclosures, records, expected: { identity, filings, more } }`.
//! The records are J-Quants' live answers (and derived edits of them); they
//! are read with JavaScript `JSON.parse` semantics. Objects compare as JSON
//! values (key order aside).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_finance::jquants_financials::jquants_summaries_to_sync;
use serde_json::{Value as Json, json};

fn load(name: &str) -> Json {
	let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../vectors/finance")
		.join(name);
	let text = std::fs::read_to_string(&path)
		.unwrap_or_else(|error| panic!("{}: {error}", path.display()));
	serde_json::from_str(&text).unwrap()
}

/// A JSON value as `JSON.parse` gives it.
fn js(value: &Json) -> research_js::json::Value {
	research_js::json::parse(&value.to_string()).unwrap()
}

#[test]
fn summaries_to_sync_match_typescript() {
	let file = load("jquants_financials.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() >= 10, "only {} cases", cases.len());
	let mut failures = Vec::new();
	for case in cases {
		let name = case["name"].as_str().unwrap();
		let known: Vec<String> = case["knownDisclosures"]
			.as_array()
			.unwrap()
			.iter()
			.map(|id| id.as_str().unwrap().to_owned())
			.collect();
		let records = js(&case["records"]);
		let data = jquants_summaries_to_sync(
			case["code"].as_str().unwrap(),
			&known,
			records.as_array().unwrap(),
		);
		let actual = json!({
			"identity": data.identity,
			"filings": data.filings,
			"more": data.more,
		});
		if actual != case["expected"] {
			failures.push(format!(
				"{name}\n   rust:       {actual}\n   typescript: {}",
				case["expected"]
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ:\n{}",
		failures.len(),
		cases.len(),
		failures.join("\n")
	);
}
