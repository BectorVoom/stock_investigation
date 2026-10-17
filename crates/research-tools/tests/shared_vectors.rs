//! Replays `vectors/model-text/bound-model-text.json` against `shared::bound_model_text`.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_tools::shared::bound_model_text;
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
	lines: Vec<String>,
	output: String,
}

#[test]
fn bound_model_text_matches_typescript() {
	let path = format!(
		"{}/../../vectors/model-text/bound-model-text.json",
		env!("CARGO_MANIFEST_DIR")
	);
	let cases: Vec<Case> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
	assert!(cases.len() > 400);
	for case in &cases {
		assert_eq!(bound_model_text(&case.lines), case.output);
	}
}
