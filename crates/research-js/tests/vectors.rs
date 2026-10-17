//! Replays `vectors/js/*.json` (written by Node: `node scripts/vectors/index.ts js`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_js::{json_text, number, uri, utf16, whitespace};
use serde::Deserialize;

fn vector_file(name: &str) -> String {
	let path = format!("{}/../../vectors/js/{name}", env!("CARGO_MANIFEST_DIR"));
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn double(bits: &str) -> f64 {
	f64::from_bits(u64::from_str_radix(bits, 16).unwrap())
}

#[derive(Deserialize)]
struct NumberVectors {
	#[serde(rename = "toString")]
	to_string: Vec<ToStringCase>,
	#[serde(rename = "toFixed")]
	to_fixed: Vec<ToFixedCase>,
}

#[derive(Deserialize)]
struct ToStringCase {
	bits: String,
	output: String,
}

#[derive(Deserialize)]
struct ToFixedCase {
	bits: String,
	digits: u32,
	output: String,
}

#[test]
fn number_formatting_matches_v8() {
	let vectors: NumberVectors = serde_json::from_str(&vector_file("number.json")).unwrap();
	assert!(vectors.to_string.len() > 1000);
	for case in &vectors.to_string {
		assert_eq!(
			number::to_js_string(double(&case.bits)),
			case.output,
			"String({})",
			case.bits
		);
	}
	for case in &vectors.to_fixed {
		let value = double(&case.bits);
		assert_eq!(
			number::to_fixed(value, case.digits),
			case.output,
			"({value:e}).toFixed({})",
			case.digits
		);
	}
}

#[derive(Deserialize)]
struct StringVectors {
	whitespace: Vec<u32>,
	length: Vec<Case<usize>>,
	trim: Vec<Case<String>>,
	collapse: Vec<Case<String>>,
	slice: Vec<SliceCase>,
	#[serde(rename = "encodeURIComponent")]
	encode_uri_component: Vec<Case<String>>,
	#[serde(rename = "jsonQuote")]
	json_quote: Vec<Case<String>>,
}

#[derive(Deserialize)]
struct Case<T> {
	input: String,
	output: T,
}

#[derive(Deserialize)]
struct SliceCase {
	input: String,
	start: usize,
	end: usize,
	output: String,
}

#[test]
fn string_primitives_match_v8() {
	let vectors: StringVectors = serde_json::from_str(&vector_file("string.json")).unwrap();
	let expected: std::collections::BTreeSet<u32> = vectors.whitespace.iter().copied().collect();
	for code in (0u32..=0xFFFF).filter(|code| !(0xD800..=0xDFFF).contains(code)) {
		let character = char::from_u32(code).unwrap();
		assert_eq!(
			whitespace::is_js_whitespace(character),
			expected.contains(&code),
			"U+{code:04X}"
		);
	}
	for case in &vectors.length {
		assert_eq!(
			utf16::utf16_len(&case.input),
			case.output,
			"{:?}.length",
			case.input
		);
	}
	for case in &vectors.trim {
		assert_eq!(
			whitespace::trim(&case.input),
			case.output,
			"{:?}.trim()",
			case.input
		);
	}
	for case in &vectors.collapse {
		assert_eq!(
			whitespace::collapse(&case.input),
			case.output,
			"{:?} collapse",
			case.input
		);
	}
	for case in &vectors.slice {
		assert_eq!(
			utf16::slice(&case.input, case.start, case.end),
			case.output,
			"{:?}.slice({}, {})",
			case.input,
			case.start,
			case.end
		);
	}
	for case in &vectors.encode_uri_component {
		assert_eq!(
			uri::encode_uri_component(&case.input),
			case.output,
			"encodeURIComponent({:?})",
			case.input
		);
	}
	for case in &vectors.json_quote {
		assert_eq!(
			json_text::quote(&case.input),
			case.output,
			"JSON.stringify({:?})",
			case.input
		);
	}
}
