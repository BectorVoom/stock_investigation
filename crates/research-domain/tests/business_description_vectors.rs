//! Replays `vectors/domain/business_description.json` (ADR-0053, written by
//! Node from the TypeScript: `node scripts/vectors/index.ts domain`): the
//! paragraph kind, the stored paragraphs, the section bounds and the summary
//! count. The Lean family of the section bounds is replayed by `lean_vectors.rs`.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_domain::finance::business_description::{
	BusinessParagraph, BusinessParagraphs, SectionBounds, SectionMark, business_paragraph_kind,
	business_paragraphs, business_section_bounds, business_summary_count, limits,
};
use serde_json::Value;

fn vectors() -> Value {
	let path = format!(
		"{}/../../vectors/domain/business_description.json",
		env!("CARGO_MANIFEST_DIR")
	);
	serde_json::from_str(
		&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}")),
	)
	.unwrap()
}

fn cases<'a>(file: &'a Value, name: &str) -> &'a [Value] {
	file[name]
		.as_array()
		.unwrap_or_else(|| panic!("missing {name}"))
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> T {
	serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn limits_match_typescript() {
	let file = vectors();
	let expected = &file["limits"];
	assert_eq!(expected["maxStoredChars"], limits::MAX_STORED_CHARS);
	assert_eq!(expected["maxParagraphs"], limits::MAX_PARAGRAPHS);
	assert_eq!(expected["maxHeadingChars"], limits::MAX_HEADING_CHARS);
	assert_eq!(expected["summaryChars"], limits::SUMMARY_CHARS);
}

#[test]
fn paragraph_kinds_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "kinds");
	assert!(rows.len() > 300);
	for row in rows {
		assert_eq!(
			business_paragraph_kind(row["input"].as_str().unwrap()).as_str(),
			row["output"].as_str().unwrap(),
			"{row}"
		);
	}
}

#[test]
fn paragraphs_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "paragraphs");
	assert!(rows.len() > 500);
	for row in rows {
		let blocks: Vec<String> = parse(&row["input"]);
		let expected: BusinessParagraphs = parse(&row["output"]);
		assert_eq!(business_paragraphs(&blocks), expected, "{row}");
	}
}

#[test]
fn section_bounds_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "bounds");
	assert!(rows.len() > 500);
	for row in rows {
		let marks: Vec<SectionMark> = parse(&row["marks"]);
		let sizes: Vec<u64> = parse(&row["sizes"]);
		let expected: Option<SectionBounds> = parse(&row["output"]);
		assert_eq!(business_section_bounds(&marks, &sizes), expected, "{row}");
	}
}

#[test]
fn summary_counts_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "summaries");
	assert!(rows.len() > 500);
	for row in rows {
		let paragraphs: Vec<BusinessParagraph> = parse(&row["paragraphs"]);
		let summary_chars = usize::try_from(row["summaryChars"].as_u64().unwrap()).unwrap();
		assert_eq!(
			business_summary_count(&paragraphs, summary_chars),
			usize::try_from(row["output"].as_u64().unwrap()).unwrap(),
			"{row}"
		);
	}
}
