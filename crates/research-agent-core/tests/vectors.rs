//! Replays `vectors/model-text/*.json` (Node: `node scripts/vectors/index.ts model-text`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_agent_core::model_text::{extract_json_object, fence_untrusted_text};
use research_js::json;
use serde::Deserialize;
use serde_json::Value;

fn vector_file(name: &str) -> String {
	let path = format!(
		"{}/../../vectors/model-text/{name}",
		env!("CARGO_MANIFEST_DIR")
	);
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[derive(Deserialize)]
struct ExtractCase {
	input: String,
	output: Value,
}

#[test]
fn extract_json_object_matches_typescript() {
	let cases: Vec<ExtractCase> =
		serde_json::from_str(&vector_file("extract-json-object.json")).unwrap();
	assert!(cases.len() > 3000);
	for case in &cases {
		let actual = match extract_json_object(&case.input) {
			Ok(value) => serde_json::json!({ "ok": json::stringify(&value) }),
			Err(error) => serde_json::json!({ "err": error.as_str() }),
		};
		assert_eq!(actual, case.output, "extractJsonObject({:?})", case.input);
	}
}

#[derive(Deserialize)]
struct FenceCase {
	label: String,
	text: String,
	token: String,
	output: String,
}

#[test]
fn fence_matches_typescript() {
	let cases: Vec<FenceCase> = serde_json::from_str(&vector_file("fence.json")).unwrap();
	for case in &cases {
		assert_eq!(
			fence_untrusted_text(&case.label, &case.text, &case.token).unwrap(),
			case.output
		);
	}
}
