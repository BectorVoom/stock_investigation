//! Replays `vectors/domain/equity_financials.json` (ADR-0048, written by Node
//! from the TypeScript: `scripts/vectors/finance/equitySync.ts`):
//! canonical decimals, annual durations, fiscal years, the annual facts of a
//! filing and the SEC JSON-number → decimal text rule.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_domain::finance::financial_statements::{
	EquityExtractedFact, annual_facts_of_filing, fiscal_year_of_period_end, is_annual_duration,
	is_canonical_decimal, sec_value_decimal,
};
use serde_json::{Value, json};

fn vectors() -> Value {
	let path = format!(
		"{}/../../vectors/domain/equity_financials.json",
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

fn text(value: &Value) -> &str {
	value.as_str().unwrap()
}

#[test]
fn canonical_decimals_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "isCanonicalDecimal");
	assert!(rows.len() > 1_000);
	for row in rows {
		assert_eq!(
			is_canonical_decimal(text(&row["input"])),
			row["output"].as_bool().unwrap(),
			"{row}"
		);
	}
}

#[test]
fn annual_durations_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "isAnnualDuration");
	assert!(rows.len() > 1_000);
	for row in rows {
		assert_eq!(
			is_annual_duration(text(&row["start"]), text(&row["end"])),
			row["output"].as_bool().unwrap(),
			"{row}"
		);
	}
}

#[test]
fn fiscal_years_match_typescript() {
	let file = vectors();
	for row in cases(&file, "fiscalYearOfPeriodEnd") {
		assert_eq!(
			fiscal_year_of_period_end(text(&row["input"])),
			row["output"].as_i64(),
			"{row}"
		);
	}
}

#[test]
fn annual_facts_of_a_filing_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "annualFactsOfFiling");
	assert!(rows.len() > 300);
	for row in rows {
		let facts: Vec<EquityExtractedFact> = serde_json::from_value(row["facts"].clone()).unwrap();
		let result = annual_facts_of_filing(facts);
		let actual = json!({
			"kept": result.kept,
			"dropped": result
				.dropped
				.iter()
				.map(|(fact, problem)| json!({ "fact": fact, "problem": problem }))
				.collect::<Vec<_>>(),
		});
		assert_eq!(actual, row["output"], "{}", row["facts"]);
	}
}

#[test]
fn sec_values_match_typescript() {
	let file = vectors();
	let rows = cases(&file, "secValueDecimal");
	assert!(rows.len() > 500);
	for row in rows {
		let value = f64::from_bits(u64::from_str_radix(text(&row["bits"]), 16).unwrap());
		assert_eq!(
			sec_value_decimal(value).as_deref(),
			row["output"].as_str(),
			"{row}"
		);
	}
}
