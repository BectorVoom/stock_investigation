//! Replays `vectors/finance/stock_directory*.json` (written by Node from the
//! real TypeScript adapters: `node scripts/vectors/index.ts finance`): the SEC
//! and JPX list parsers, the JPX link scrape, the row-count floor (as recipes
//! both sides rebuild) and source transcripts over the scripted fetcher,
//! where every request, pacing grant and SEC wait must match (ADR-0034).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	clippy::cast_possible_truncation,
	clippy::cast_possible_wrap,
	clippy::cast_sign_loss
)]

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use research_contracts::stock_directory::StockDirectoryFailureCode;
use research_finance::jpx_directory::{
	JpxDirectorySource, JpxListingLanguage, JpxListingRow, extract_jpx_listing_url,
	jpx_directory_entries, listing_date, parse_jpx_listing_sheet,
};
use research_finance::ports::{
	BeforeRequest, DroppedRowsHook, Sleeper, StockDirectoryData, StockDirectoryQuery,
	StockDirectorySource,
};
use research_finance::sec_client::PacedSecClient;
use research_finance::sec_directory::{
	SecDirectorySource, parse_sec_directory, sec_directory_entries,
};
use research_js::json::Value;
use serde_json::{Value as Json, json};
use tokio_util::sync::CancellationToken;

fn result_json<T>(
	result: Result<T, StockDirectoryFailureCode>,
	ok: impl FnOnce(T) -> Json,
) -> Json {
	match result {
		Ok(value) => json!({"ok": ok(value)}),
		Err(code) => json!({"err": code.as_str()}),
	}
}

/// A long list as its length and digest (`listSummary` in directory.ts).
fn list_summary(data: &StockDirectoryData) -> Json {
	json!({
		"asOf": data.as_of,
		"length": data.entries.len(),
		"digest": digest_of(&serde_json::to_value(&data.entries).unwrap()),
	})
}

fn language(case: &Value) -> JpxListingLanguage {
	JpxListingLanguage::from_str_value(text(case, "language")).unwrap()
}

/// `secRecipe` in directory.ts: two rows to drop, then `count` NYSE rows.
fn sec_recipe(count: usize) -> Value {
	let mut rows = vec![
		json!([9, "N".repeat(201), "LONG", "NYSE"]),
		json!([8, "Over the counter", "OTCX", "OTC"]),
	];
	for index in 0..count {
		rows.push(json!([
			100_000 + index,
			format!("Company {index}"),
			format!("T{index:04}"),
			"NYSE"
		]));
	}
	let text = json!({"fields": ["cik", "name", "ticker", "exchange"], "data": rows}).to_string();
	research_js::json::parse(&text).unwrap()
}

fn listing_rows(rows: &[Value]) -> Vec<JpxListingRow> {
	rows.iter()
		.map(|row| JpxListingRow {
			code: text(row, "code").to_owned(),
			name: text(row, "name").to_owned(),
			section: text(row, "section").to_owned(),
			date: text(row, "date").to_owned(),
		})
		.collect()
}

#[test]
fn stock_directory_parsers_match_typescript() {
	let file = load("stock_directory.json");
	let mut failures = Vec::new();
	let urls = field(&file, "pageUrls");
	assert_eq!(text(urls, "ja"), JpxListingLanguage::Ja.page_url());
	assert_eq!(text(urls, "en"), JpxListingLanguage::En.page_url());

	let sec = array(&file, "secEntries");
	assert!(sec.len() >= 300);
	for (index, case) in sec.iter().enumerate() {
		let value = research_js::json::parse(text(case, "input")).unwrap();
		let actual = result_json(sec_directory_entries(&value), |parsed| {
			serde_json::to_value(parsed).unwrap()
		});
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"secEntries {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for case in array(&file, "secRecipes") {
		let count = number(case, "count") as usize;
		let actual = result_json(parse_sec_directory(&sec_recipe(count)), |parsed| {
			let mut summary = list_summary(&parsed.data);
			summary["droppedRows"] = json!(parsed.dropped_rows);
			summary
		});
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"secRecipe {count}: {actual}\n   expected {expected}"
			));
		}
	}
	for (index, case) in array(&file, "jpxLinks").iter().enumerate() {
		let actual = extract_jpx_listing_url(text(case, "html"), language(case));
		if actual.as_deref() != optional_text(case, "output") {
			failures.push(format!(
				"jpxLinks {index}: {actual:?} for {}",
				text(case, "html")
			));
		}
	}
	let sheets = array(&file, "jpxSheets");
	assert!(sheets.len() >= 300);
	for (index, case) in sheets.iter().enumerate() {
		let actual = result_json(
			parse_jpx_listing_sheet(text(case, "sheet"), text(case, "shared"), language(case)),
			|rows| serde_json::to_value(rows).unwrap(),
		);
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"jpxSheets {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for (index, case) in array(&file, "jpxJoins").iter().enumerate() {
		let joined = jpx_directory_entries(
			&listing_rows(array(case, "japanese")),
			&listing_rows(array(case, "english")),
		);
		let actual = serde_json::to_value(&joined).unwrap();
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"jpxJoins {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for case in array(&file, "listingDates") {
		let input = text(case, "input");
		if listing_date(input).as_deref() != optional_text(case, "output") {
			failures.push(format!("listingDate {input:?}"));
		}
	}
	report(&failures);
}

/* ---------- source transcripts ---------- */

struct TestClock(i64);

impl research_application::ports::Clock for TestClock {
	fn now_ms(&self) -> i64 {
		self.0
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.0).unwrap()
	}
}

struct RecordingSleeper(EventLog);

#[async_trait::async_trait]
impl Sleeper for RecordingSleeper {
	async fn sleep(&self, ms: u64, _cancel: Option<&CancellationToken>) {
		self.0.push(json!({"sleep": ms}));
	}
}

struct ScriptedBefore {
	answers: Vec<bool>,
	next: Mutex<usize>,
	log: EventLog,
}

#[async_trait::async_trait]
impl BeforeRequest for ScriptedBefore {
	async fn before_request(&self) -> bool {
		self.log.push(json!({"before": true}));
		let mut next = self.next.lock().unwrap();
		let answer = self.answers.get(*next).copied().unwrap_or(true);
		*next += 1;
		answer
	}
}

fn scripted_before(case: &Value, log: &EventLog) -> ScriptedBefore {
	ScriptedBefore {
		answers: array(case, "before")
			.iter()
			.map(|v| matches!(v, Value::Bool(true)))
			.collect(),
		next: Mutex::new(0),
		log: log.clone(),
	}
}

fn dropped_recorder() -> (DroppedRowsHook, Arc<Mutex<Vec<usize>>>) {
	let dropped = Arc::new(Mutex::new(Vec::new()));
	let sink = Arc::clone(&dropped);
	(
		Arc::new(move |count| sink.lock().unwrap().push(count)),
		dropped,
	)
}

async fn replay(
	kind: &str,
	index: usize,
	case: &Value,
	source: &dyn StockDirectorySource,
	log: &EventLog,
	dropped: &Mutex<Vec<usize>>,
	failures: &mut Vec<String>,
) {
	let before = scripted_before(case, log);
	let cancel = CancellationToken::new();
	let result = source
		.fetch_directory(StockDirectoryQuery {
			cancel: &cancel,
			before_request: &before,
		})
		.await;
	let actual = json!({
		"output": result_json(result, |data| list_summary(&data)),
		"events": log.snapshot(),
		"dropped": *dropped.lock().unwrap(),
	});
	let expected = json!({
		"output": js_to_serde(field(case, "output")),
		"events": js_to_serde(field(case, "events")),
		"dropped": js_to_serde(field(case, "dropped")),
	});
	if norm(&actual) != norm(&expected) {
		failures.push(format!("{kind} {index}: {actual}\n   expected {expected}"));
	}
}

#[tokio::test]
async fn stock_directory_sources_match_typescript() {
	let file = load("stock_directory_sources.json");
	let mut failures = Vec::new();
	let sec = array(&file, "secSources");
	assert!(sec.len() >= 50);
	for (index, case) in sec.iter().enumerate() {
		let log = EventLog::default();
		let client = PacedSecClient::new(
			Arc::new(Scripted::new(field(case, "script"), &log)),
			Arc::new(TestClock(1_792_810_800_000)),
			Arc::new(RecordingSleeper(log.clone())),
			optional_text(case, "userAgent").map(str::to_owned),
		);
		let (hook, dropped) = dropped_recorder();
		let source = SecDirectorySource::new(Arc::new(client), Some(hook));
		replay("sec", index, case, &source, &log, &dropped, &mut failures).await;
	}
	let jpx = array(&file, "jpxSources");
	assert!(jpx.len() >= 50);
	for (index, case) in jpx.iter().enumerate() {
		let log = EventLog::default();
		let scripted = Arc::new(Scripted::new(field(case, "script"), &log));
		let (hook, dropped) = dropped_recorder();
		let source = JpxDirectorySource::new(scripted.clone(), scripted, Some(hook));
		replay("jpx", index, case, &source, &log, &dropped, &mut failures).await;
	}
	report(&failures);
}
