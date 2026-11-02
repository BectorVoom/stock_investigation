//! Replays `vectors/finance/jquants_profiles.json` (ADR-0059 §3), written by
//! Node from the TypeScript `jquantsMasterToProfiles`
//! (`scripts/vectors/finance/jquantsFinancials.ts`): cases
//! `{ name, records, expected }`. The records are J-Quants' live Listed
//! Issue Master (trimmed) and derived edits of it, read with JavaScript
//! `JSON.parse` semantics.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_finance::jquants_financials::jquants_master_to_profiles;
use serde_json::Value as Json;

fn load(name: &str) -> Json {
	let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../../vectors/finance")
		.join(name);
	let text = std::fs::read_to_string(&path)
		.unwrap_or_else(|error| panic!("{}: {error}", path.display()));
	serde_json::from_str(&text).unwrap()
}

#[test]
fn master_to_profiles_matches_typescript() {
	let file = load("jquants_profiles.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() >= 4, "only {} cases", cases.len());
	let mut failures = Vec::new();
	for case in cases {
		let name = case["name"].as_str().unwrap();
		let records = research_js::json::parse(&case["records"].to_string()).unwrap();
		let actual =
			serde_json::to_value(jquants_master_to_profiles(records.as_array().unwrap())).unwrap();
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
