//! Replays `vectors/domain-news/*.json` (written by Node from the TypeScript:
//! `node scripts/vectors/index.ts domain-news`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_domain::news::canonical_url::canonicalize_article_url;
use research_domain::news::ip_classification::{classify_ip_address, looks_like_ip_literal};
use research_domain::news::url_policy::validate_fetch_url;
use serde::Deserialize;
use serde_json::Value;

fn vector_file(name: &str) -> String {
	let path = format!(
		"{}/../../vectors/domain-news/{name}",
		env!("CARGO_MANIFEST_DIR")
	);
	std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[derive(Deserialize)]
struct Case<T> {
	input: String,
	output: T,
}

#[derive(Deserialize)]
struct IpVectors {
	classify: Vec<Case<String>>,
	#[serde(rename = "looksLikeIpLiteral")]
	looks_like_ip_literal: Vec<Case<bool>>,
}

#[test]
fn ip_classification_matches_typescript() {
	let vectors: IpVectors = serde_json::from_str(&vector_file("ip.json")).unwrap();
	for case in &vectors.classify {
		assert_eq!(
			classify_ip_address(&case.input).as_str(),
			case.output,
			"classify({:?})",
			case.input
		);
	}
	for case in &vectors.looks_like_ip_literal {
		assert_eq!(
			looks_like_ip_literal(&case.input),
			case.output,
			"looksLike({:?})",
			case.input
		);
	}
}

#[derive(Deserialize)]
struct UrlVectors {
	#[serde(rename = "validateFetchUrl")]
	validate: Vec<Case<Value>>,
	#[serde(rename = "canonicalizeArticleUrl")]
	canonicalize: Vec<Case<Value>>,
}

#[test]
fn url_policy_matches_typescript() {
	let vectors: UrlVectors = serde_json::from_str(&vector_file("url.json")).unwrap();
	let mut failures = Vec::new();
	for case in &vectors.validate {
		let actual = match validate_fetch_url(&case.input) {
			Ok(url) => serde_json::json!({ "ok": { "href": url.href, "hostname": url.hostname } }),
			Err(error) => serde_json::json!({ "err": error.as_str() }),
		};
		if actual != case.output {
			failures.push(format!(
				"validate({:?}): rust {actual} ts {}",
				case.input, case.output
			));
		}
	}
	for case in &vectors.canonicalize {
		let actual = match canonicalize_article_url(&case.input) {
			Ok(href) => serde_json::json!({ "ok": href }),
			Err(error) => serde_json::json!({ "err": error.as_str() }),
		};
		if actual != case.output {
			failures.push(format!(
				"canonicalize({:?}): rust {actual} ts {}",
				case.input, case.output
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} mismatches:\n{}",
		failures.len(),
		failures.join("\n")
	);
}
