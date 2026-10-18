//! Replays `vectors/finance/*.json` (written by Node from the real
//! TypeScript adapters: `node scripts/vectors/index.ts finance`). Adapter
//! cases are transcripts: the case carries the scripted answers of the fakes
//! and the expected record of every call the adapter made plus its result;
//! the Rust port runs against the same fakes and must produce the same
//! record.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss
)]

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use research_application::ports::SafeFetchError;
use research_contracts::json::to_js_value;
use research_finance::finnhub::FinnhubEarningsSource;
use research_finance::fred::FredSeriesSource;
use research_finance::market_fetch::{
	date_prefix_of, fetch_json_document, http_status_of, is_iso_date, subtract_days_iso,
};
use research_finance::ports::{
	BeforeRequest, EarningsCalendarSource, EarningsQuery, EarningsStock, MarketSeriesSource,
	Secret, SeriesQuery,
};
use research_finance::twelve_data::{TwelveDataSeriesSource, split_twelve_symbol};
use research_js::json::Value;
use serde_json::{Value as Json, json};
use tokio_util::sync::CancellationToken;

#[test]
fn string_to_number_matches_javascript() {
	let cases = load("js_number.json");
	assert!(cases.as_array().unwrap().len() > 50);
	let mut failures = Vec::new();
	for case in cases.as_array().unwrap() {
		let input = text(case, "input");
		let expected = text(case, "bits");
		let actual = double_bits(research_js::string_number::string_to_number(input));
		if actual != expected {
			failures.push(format!("{input:?}: {actual} != {expected}"));
		}
	}
	report(&failures);
}

#[test]
fn market_helpers_match_typescript() {
	let file = load("market_fetch.json");
	let helpers = field(&file, "helpers");
	let mut failures = Vec::new();
	for case in array(helpers, "isIsoDate") {
		let input = text(case, "input");
		if is_iso_date(input) != flag(case, "output") {
			failures.push(format!("isIsoDate {input:?}"));
		}
	}
	for case in array(helpers, "datePrefix") {
		let input = text(case, "input");
		let expected = optional_text(case, "output");
		if date_prefix_of(input).as_deref() != expected {
			failures.push(format!("datePrefix {input:?}"));
		}
	}
	for case in array(helpers, "subtractDays") {
		let input = text(case, "iso");
		let days = number(case, "days") as i64;
		let expected = optional_text(case, "output");
		if subtract_days_iso(input, days).as_deref() != expected {
			failures.push(format!("subtractDays {input:?} {days}"));
		}
	}
	for case in array(helpers, "httpStatus") {
		let error = SafeFetchError {
			code: error_code(text(case, "code")),
			detail: text(case, "detail").to_owned(),
			body: None,
		};
		let expected = field(case, "output").as_f64().map(|n| n as u16);
		if http_status_of(&error) != expected {
			failures.push(format!("httpStatus {:?}", error.detail));
		}
	}
	for case in array(helpers, "splitTwelve") {
		let input = text(case, "input");
		let (base, exchange) = split_twelve_symbol(input);
		let output = field(case, "output");
		let expected_exchange = optional_text(output, "exchange");
		if base != text(output, "base") || exchange != expected_exchange {
			failures.push(format!("splitTwelve {input:?}"));
		}
	}
	report(&failures);
}

#[tokio::test]
async fn json_documents_match_typescript() {
	let file = load("market_fetch.json");
	let mut failures = Vec::new();
	for (index, case) in array(&file, "documents").iter().enumerate() {
		let log = EventLog::default();
		let fetcher = Scripted::new(field(case, "script"), &log);
		let mut options = research_finance::market_fetch::fetch_options(
			"api.stlouisfed.org",
			"application/json",
			&CancellationToken::new(),
		);
		options.max_bytes = 10;
		options.timeout_ms = 20;
		let result = fetch_json_document(
			&fetcher,
			"https://api.stlouisfed.org/fred/series?x=1",
			&options,
		)
		.await;
		// The TypeScript Result is `{ok: true, value: {finalUrl, json}}` or
		// `{ok: false, error}`; the Rust helper returns the parsed value only.
		let expected = field(case, "output");
		let (output, expected_json) = match &result {
			Ok(value) => (
				json!({"ok": true, "json": value_to_serde(value)}),
				json!({"ok": expected.as_object().and_then(|o| o.get("ok")).and_then(Value::as_bool),
					"json": has(expected, "value").map(|v| js_to_serde(field(v, "json")))}),
			),
			Err(error) => (
				json!({"ok": false, "error": error_json(error)}),
				js_to_serde(expected),
			),
		};
		if norm(&output) != norm(&expected_json) {
			failures.push(format!(
				"document case {index}: {output} != {expected_json}"
			));
		}
		if norm(&log.snapshot()) != norm(&js_to_serde(field(case, "events"))) {
			failures.push(format!("document case {index}: events differ"));
		}
	}
	report(&failures);
}

fn series_json(
	result: &Result<
		research_finance::ports::SeriesData,
		research_finance::ports::MarketUnavailable,
	>,
) -> Json {
	match result {
		Ok(data) => json!({"ok": serde_json::to_value(data).unwrap()}),
		Err(error) => {
			json!({"err": {"code": serde_json::to_value(error.code).unwrap(), "reason": error.reason}})
		}
	}
}

async fn replay_series(file: &str) {
	let cases = load(file);
	let cases = cases.as_array().unwrap();
	assert!(cases.len() > 500, "{file}");
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let log = EventLog::default();
		let fetcher: Arc<Scripted> = Arc::new(Scripted::new(field(case, "script"), &log));
		let key = Secret::new(text(case, "apiKey"));
		let source: Box<dyn MarketSeriesSource> = match text(case, "provider") {
			"fred" => Box::new(FredSeriesSource::new(key, fetcher)),
			_ => Box::new(TwelveDataSeriesSource::new(key, fetcher)),
		};
		let query = field(case, "query");
		let cancel = CancellationToken::new();
		let result = source
			.fetch_series(SeriesQuery {
				symbol: text(query, "symbol"),
				since: optional_text(query, "since"),
				max_observations: number(query, "maxObservations") as usize,
				cancel: &cancel,
			})
			.await;
		let actual = series_json(&result);
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"{file} case {index}: {actual}\n   expected {expected}"
			));
		}
		if norm(&log.snapshot()) != norm(&js_to_serde(field(case, "events"))) {
			failures.push(format!(
				"{file} case {index}: calls differ: {}\n   expected {}",
				log.snapshot(),
				js_to_serde(field(case, "events"))
			));
		}
		// SEC-005: no key in the typed result.
		assert!(!actual.to_string().contains(text(case, "apiKey")));
	}
	report(&failures);
}

#[tokio::test]
async fn fred_matches_typescript() {
	replay_series("fred.json").await;
}

#[tokio::test]
async fn twelve_data_matches_typescript() {
	replay_series("twelve_data.json").await;
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

#[tokio::test]
async fn finnhub_matches_typescript() {
	let cases = load("finnhub.json");
	let cases = cases.as_array().unwrap();
	assert!(cases.len() > 500);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let log = EventLog::default();
		let fetcher = Arc::new(Scripted::new(field(case, "script"), &log));
		let source = FinnhubEarningsSource::new(Secret::new(text(case, "apiKey")), fetcher);
		let query = field(case, "query");
		let stocks: Vec<EarningsStock> = array(query, "stocks")
			.iter()
			.map(|s| EarningsStock {
				symbol: text(s, "symbol").to_owned(),
				need_name: flag(s, "needName"),
			})
			.collect();
		let before = ScriptedBefore {
			answers: array(case, "before")
				.iter()
				.map(|v| matches!(v, Value::Bool(true)))
				.collect(),
			next: Mutex::new(0),
			log: log.clone(),
		};
		let cancel = CancellationToken::new();
		let results = source
			.fetch_earnings(EarningsQuery {
				stocks: &stocks,
				from_date: text(query, "fromDate"),
				to_date: text(query, "toDate"),
				cancel: &cancel,
				before_request: &before,
			})
			.await;
		let actual = Json::Array(
			results
				.iter()
				.map(|r| match r {
					Ok(data) => json!({"ok": serde_json::to_value(data).unwrap()}),
					Err(error) => json!({"err": serde_json::to_value(error).unwrap()}),
				})
				.collect(),
		);
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"finnhub case {index}: {actual}\n   expected {expected}"
			));
		}
		if norm(&log.snapshot()) != norm(&js_to_serde(field(case, "events"))) {
			failures.push(format!("finnhub case {index}: calls differ"));
		}
	}
	report(&failures);
	let _ = to_js_value::<Json>;
}

/* ---------- JPX ---------- */

use research_finance::jpx::{JPX_INDEX_URL, JpxEarningsSource, extract_jpx_workbook_urls};
use research_finance::jpx_workbook::{
	decode_workbook_text, header_matches, parse_jpx_workbook, slug_fiscal_kind,
};
use research_finance::zip_reader::read_zip_entries;

fn workbook_json(
	result: &Result<
		Vec<research_finance::jpx_workbook::JpxWorkbookRow>,
		research_finance::jpx_workbook::JpxWorkbookError,
	>,
) -> Json {
	match result {
		Ok(rows) => json!({"ok": true, "value": serde_json::to_value(rows).unwrap()}),
		Err(error) => json!({"ok": false, "error": error.as_str()}),
	}
}

/// The XML the exporter builds for the bound checks (`recipeSheet` in jpx.ts).
fn recipe_sheet(recipe: &str, count: usize) -> (String, String) {
	const STRINGS: &str = "<si><t>Scheduled Dates for Earnings Announcements</t></si><si><t>Code</t></si><si><t>Issue Name</t></si><si><t>Fiscal Year-end</t></si><si><t>Fiscal Year/Quarter</t></si><si><t>Second quarter</t></si>";
	const HEADER: &str = "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"s\"><v>2</v></c><c r=\"D1\" t=\"s\"><v>3</v></c><c r=\"E1\" t=\"s\"><v>4</v></c></row>";
	let extra = if recipe == "strings" {
		"<si><t>x</t></si>".repeat(count)
	} else {
		String::new()
	};
	let shared = format!("<sst>{STRINGS}{extra}</sst>");
	let rows = match recipe {
		"rows" => (0..count)
			.map(|i| {
				let n = i + 2;
				format!("<row><c r=\"A{n}\"><v>46331</v></c><c r=\"B{n}\"><v>7203</v></c><c r=\"C{n}\" t=\"s\"><v>5</v></c><c r=\"D{n}\"><v>46477</v></c><c r=\"E{n}\" t=\"s\"><v>5</v></c></row>")
			})
			.collect::<String>(),
		"strings" => String::new(),
		"emptyRows" => "<row><c/></row>".repeat(count),
		"cells" => format!("<row>{}</row>", "<c/>".repeat(count)),
		"cellsAcrossRows" => format!("<row>{}</row>", "<c/>".repeat(500_000)).repeat(count),
		other => panic!("unknown recipe {other}"),
	};
	(
		format!("<worksheet><sheetData>{HEADER}{rows}</sheetData></worksheet>"),
		shared,
	)
}

#[test]
fn jpx_workbook_matches_typescript() {
	let file = load("jpx_workbook.json");
	let mut failures = Vec::new();
	let workbooks = array(&file, "workbooks");
	assert!(workbooks.len() > 400);
	for (index, case) in workbooks.iter().enumerate() {
		let result = parse_jpx_workbook(text(case, "sheet"), text(case, "shared"));
		let actual = workbook_json(&result);
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"workbook {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for case in array(&file, "recipes") {
		let recipe = text(case, "recipe");
		let count = number(case, "count") as usize;
		let (sheet, shared) = recipe_sheet(recipe, count);
		let actual = match parse_jpx_workbook(&sheet, &shared) {
			Ok(rows) => json!({"ok": {
				"length": rows.len(),
				"first": rows.first().map(|r| serde_json::to_value(r).unwrap()),
				"last": rows.last().map(|r| serde_json::to_value(r).unwrap()),
			}}),
			Err(error) => json!({"err": error.as_str()}),
		};
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!("recipe {recipe} {count}: {actual} != {expected}"));
		}
	}
	for case in array(&file, "decode") {
		if decode_workbook_text(text(case, "input")) != text(case, "output") {
			failures.push(format!("decode {:?}", text(case, "input")));
		}
	}
	let header_cases = array(&file, "headerMatches");
	for case in header_cases {
		if header_matches(text(case, "text"), text(case, "english")) != flag(case, "output") {
			failures.push(format!("headerMatches {:?}", text(case, "text")));
		}
	}
	for case in array(&file, "slugs") {
		if slug_fiscal_kind(text(case, "label")) != text(case, "output") {
			failures.push(format!("slug {:?}", text(case, "label")));
		}
	}
	report(&failures);
}

#[test]
fn jpx_index_matches_typescript() {
	let file = load("jpx_index.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 500);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let actual = extract_jpx_workbook_urls(text(case, "html"));
		let expected: Vec<&str> = array(case, "output")
			.iter()
			.map(|v| v.as_str().unwrap())
			.collect();
		if actual != expected {
			failures.push(format!("index {index}: {actual:?} != {expected:?}"));
		}
	}
	report(&failures);
	assert!(JPX_INDEX_URL.starts_with("https://www.jpx.co.jp/"));
}

fn archive_bytes(case: &Value) -> Vec<u8> {
	use base64::Engine as _;
	let mut bytes = Vec::new();
	for part in array(case, "archive") {
		if let Some(b64) = has(part, "b64") {
			bytes.extend(
				base64::engine::general_purpose::STANDARD
					.decode(b64.as_str().unwrap())
					.unwrap(),
			);
		} else {
			bytes.resize(bytes.len() + number(part, "zeros") as usize, 0);
		}
	}
	bytes
}

#[test]
fn zip_reader_matches_typescript() {
	use sha2::{Digest, Sha256};
	let file = load("zip.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 500);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let bytes = archive_bytes(case);
		let names: Vec<&str> = array(case, "names")
			.iter()
			.map(|v| v.as_str().unwrap())
			.collect();
		let actual = match read_zip_entries(&bytes, &names) {
			Ok(entries) => {
				json!({"ok": names.iter().collect::<std::collections::BTreeSet<_>>().iter().map(|name| {
				let data = &entries[**name];
				json!({"name": name, "length": data.len(), "sha256": hex::encode(Sha256::digest(data))})
			}).collect::<Vec<_>>()})
			}
			Err(error) => json!({"err": error.to_string()}),
		};
		// The TypeScript map keeps first-insertion order of the requested names.
		let expected = js_to_serde(field(case, "output"));
		let mut actual_sorted = actual.clone();
		let mut expected_sorted = expected.clone();
		for value in [&mut actual_sorted, &mut expected_sorted] {
			if let Some(list) = value.get_mut("ok").and_then(Json::as_array_mut) {
				list.sort_by_key(|entry| entry["name"].as_str().unwrap_or_default().to_owned());
			}
		}
		if norm(&actual_sorted) != norm(&expected_sorted) {
			failures.push(format!("zip case {index}: {actual} != {expected}"));
		}
	}
	report(&failures);
}

struct TestClock(std::sync::atomic::AtomicI64);

impl research_application::ports::Clock for TestClock {
	fn now_ms(&self) -> i64 {
		self.0.load(std::sync::atomic::Ordering::SeqCst)
	}
	fn now_iso(&self) -> String {
		research_js::date::epoch_ms_to_iso(self.now_ms()).unwrap()
	}
}

/// Delegates to whichever scripted fetcher the current step installed.
struct Swappable(Mutex<Option<Arc<Scripted>>>);

impl Swappable {
	fn current(&self) -> Arc<Scripted> {
		self.0.lock().unwrap().clone().unwrap()
	}
}

#[async_trait::async_trait]
impl research_application::ports::SafeFetcher for Swappable {
	async fn fetch_text(
		&self,
		url: &str,
		options: &research_application::ports::SafeFetchOptions,
	) -> Result<research_application::ports::FetchedDocument, SafeFetchError> {
		self.current().fetch_text(url, options).await
	}
}

#[async_trait::async_trait]
impl research_application::ports::SafeBinaryFetcher for Swappable {
	async fn fetch_bytes(
		&self,
		url: &str,
		options: &research_application::ports::SafeFetchOptions,
	) -> Result<research_application::ports::BinaryDocument, SafeFetchError> {
		self.current().fetch_bytes(url, options).await
	}
}

#[tokio::test]
async fn jpx_source_matches_typescript() {
	use research_application::ports::{SafeBinaryFetcher, SafeFetcher};
	let file = load("jpx_source.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() >= 100);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let swap = Arc::new(Swappable(Mutex::new(None)));
		let clock = Arc::new(TestClock(std::sync::atomic::AtomicI64::new(0)));
		let text_fetcher: Arc<dyn SafeFetcher> = swap.clone();
		let binary_fetcher: Arc<dyn SafeBinaryFetcher> = swap.clone();
		let source = JpxEarningsSource::new(text_fetcher, binary_fetcher, clock.clone());
		for (step_index, step) in array(case, "steps").iter().enumerate() {
			clock.0.store(
				number(step, "nowMs") as i64,
				std::sync::atomic::Ordering::SeqCst,
			);
			let log = EventLog::default();
			*swap.0.lock().unwrap() = Some(Arc::new(Scripted::new(field(step, "script"), &log)));
			let stocks: Vec<EarningsStock> = array(step, "stocks")
				.iter()
				.map(|s| EarningsStock {
					symbol: text(s, "symbol").to_owned(),
					need_name: flag(s, "needName"),
				})
				.collect();
			let before = ScriptedBefore {
				answers: array(step, "before")
					.iter()
					.map(|v| matches!(v, Value::Bool(true)))
					.collect(),
				next: Mutex::new(0),
				log: log.clone(),
			};
			let cancel = CancellationToken::new();
			let results = source
				.fetch_earnings(EarningsQuery {
					stocks: &stocks,
					from_date: text(step, "fromDate"),
					to_date: text(step, "toDate"),
					cancel: &cancel,
					before_request: &before,
				})
				.await;
			let actual = Json::Array(
				results
					.iter()
					.map(|r| match r {
						Ok(data) => json!({"ok": serde_json::to_value(data).unwrap()}),
						Err(error) => json!({"err": serde_json::to_value(error).unwrap()}),
					})
					.collect(),
			);
			let expected = js_to_serde(field(step, "output"));
			if norm(&actual) != norm(&expected) {
				failures.push(format!(
					"jpx source {index}/{step_index}: {actual}\n   expected {expected}"
				));
			}
			if norm(&log.snapshot()) != norm(&js_to_serde(field(step, "events"))) {
				failures.push(format!(
					"jpx source {index}/{step_index}: events {}\n   expected {}",
					log.snapshot(),
					js_to_serde(field(step, "events"))
				));
			}
		}
	}
	report(&failures);
}

/* ---------- SEC ---------- */

use research_domain::finance::filings::ReportedPositionChange;
use research_feed::{info_table, tree, validator};
use research_finance::ports::Sleeper;
use research_finance::sec_13f::{
	Edgar13FSource, Reported13FHolding, Sec13FSource, compare_reported_positions,
	extract_information_table_xml, parse_information_table, sec_filing_text_url,
	sec_submissions_url, select_recent_13f_filings,
};
use research_finance::sec_client::{
	PacedSecClient, SecClient, SecDocument, SecError, SecRequest, is_usable_sec_user_agent,
	iso_date_to_instant, normalize_cik, parse_sec_json,
};
use research_finance::sec_financials::{
	EdgarFinancialsSource, FigureResult, SecCompanyFinancials, SecFinancialsSource,
	SelectedFinancials, normalize_ticker_key, parse_ticker_directory, sec_company_facts_url,
	select_annual_financials,
};

fn sec_error_json(error: &SecError) -> Json {
	serde_json::to_value(error).unwrap()
}

fn result_json<T>(result: Result<T, SecError>, ok: impl FnOnce(T) -> Json) -> Json {
	match result {
		Ok(value) => json!({"ok": true, "value": ok(value)}),
		Err(error) => json!({"ok": false, "error": sec_error_json(&error)}),
	}
}

fn figure_json(figure: &FigureResult) -> Json {
	match figure {
		Ok(value) => json!({"ok": true, "value": serde_json::to_value(value).unwrap()}),
		Err(error) => json!({"ok": false, "error": {"reason": error.reason}}),
	}
}

fn selected_json(selected: &SelectedFinancials) -> Json {
	let margin = match &selected.net_profit_margin {
		Ok(m) => json!({"ok": true, "value": {
			"marginRatio": m.margin_ratio,
			"formula": "net income / revenue",
			"currency": m.currency,
			"period": serde_json::to_value(&m.period).unwrap(),
			"accountingStandard": serde_json::to_value(m.accounting_standard).unwrap(),
			"continuingOperationsPolicy": "total",
		}}),
		Err(error) => json!({"ok": false, "error": {"reason": error.reason}}),
	};
	json!({
		"revenue": figure_json(&selected.revenue),
		"netIncome": figure_json(&selected.net_income),
		"epsDiluted": figure_json(&selected.eps_diluted),
		"netProfitMargin": margin,
	})
}

fn financials_json(value: &SecCompanyFinancials) -> Json {
	let mut json = selected_json(&value.selected);
	json["issuer"] = serde_json::to_value(&value.issuer).unwrap();
	json["tickerDirectoryUrl"] = Json::String(value.ticker_directory_url.clone());
	json["companyFactsUrl"] = Json::String(value.company_facts_url.clone());
	json
}

#[test]
fn sec_client_primitives_match_typescript() {
	let file = load("sec_client.json");
	let primitives = field(&file, "primitives");
	let mut failures = Vec::new();
	for case in array(primitives, "userAgents") {
		let input = optional_text(case, "input");
		if is_usable_sec_user_agent(input) != flag(case, "output") {
			failures.push(format!("userAgent {input:?}"));
		}
	}
	for case in array(primitives, "ciks") {
		let input = text(case, "input");
		if normalize_cik(input).as_deref() != optional_text(case, "output") {
			failures.push(format!("cik {input:?}: {:?}", normalize_cik(input)));
		}
	}
	for case in array(primitives, "instants") {
		if iso_date_to_instant(text(case, "input")) != text(case, "output") {
			failures.push(format!("instant {:?}", text(case, "input")));
		}
	}
	for case in array(primitives, "json") {
		let document = SecDocument {
			url: "https://www.sec.gov/x".to_owned(),
			text: text(case, "text").to_owned(),
		};
		let actual = result_json(parse_sec_json(&document), |v| value_to_serde(&v));
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!("json {:?}: {actual} != {expected}", document.text));
		}
	}
	report(&failures);
}

/// Records every sleep and, like the TypeScript client's, ignores cancellation (F2).
struct RecordingSleeper(EventLog);

#[async_trait::async_trait]
impl Sleeper for RecordingSleeper {
	async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
		assert!(
			cancel.is_none(),
			"the SEC wait must not be cancellable (F2)"
		);
		self.0.push(json!({"sleep": ms}));
	}
}

fn sec_client(
	case: &Value,
	log: &EventLog,
	script: &Value,
	clock: &Arc<TestClock>,
) -> PacedSecClient {
	PacedSecClient::new(
		Arc::new(Scripted::new(script, log)),
		clock.clone(),
		Arc::new(RecordingSleeper(log.clone())),
		optional_text(case, "userAgent").map(str::to_owned),
	)
}

#[tokio::test]
async fn sec_client_calls_match_typescript() {
	let file = load("sec_client.json");
	let cases = array(&file, "calls");
	assert!(cases.len() >= 100);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let log = EventLog::default();
		let clock = Arc::new(TestClock(std::sync::atomic::AtomicI64::new(
			number(case, "startMs") as i64,
		)));
		let client = sec_client(case, &log, field(case, "script"), &clock);
		let calls = array(case, "calls");
		let tokens: Vec<CancellationToken> = calls
			.iter()
			.map(|call| {
				let token = CancellationToken::new();
				if flag(call, "cancel") {
					token.cancel();
				}
				token
			})
			.collect();
		let request = |call: &Value, token: &CancellationToken| {
			let url = text(call, "url").to_owned();
			let accept = text(call, "accept").to_owned();
			let max_bytes = number(call, "maxBytes") as usize;
			let token = token.clone();
			let client = &client;
			async move {
				let result = client
					.fetch_document(
						&url,
						SecRequest {
							max_bytes,
							accept: &accept,
							cancel: Some(&token),
						},
					)
					.await;
				result_json(result, |d| json!({"url": d.url, "text": d.text}))
			}
		};
		let mut outputs = Vec::new();
		if flag(case, "concurrent") {
			for call in calls {
				clock.0.fetch_add(
					number(call, "advanceMs") as i64,
					std::sync::atomic::Ordering::SeqCst,
				);
			}
			let futures: Vec<_> = calls
				.iter()
				.zip(&tokens)
				.map(|(call, token)| request(call, token))
				.collect();
			outputs = futures_util::future::join_all(futures).await;
		} else {
			for (call, token) in calls.iter().zip(&tokens) {
				clock.0.fetch_add(
					number(call, "advanceMs") as i64,
					std::sync::atomic::Ordering::SeqCst,
				);
				outputs.push(request(call, token).await);
			}
		}
		// Overlapping calls interleave sleeps and fetches differently; the
		// record keeps the two lists apart, each in order.
		let events = log.snapshot().as_array().unwrap().clone();
		let (fetches, sleeps): (Vec<_>, Vec<_>) = events
			.into_iter()
			.partition(|event| event.get("fetch").is_some());
		let actual = json!({"events": {"fetches": fetches, "sleeps": sleeps}, "outputs": outputs});
		let expected = json!({
			"events": js_to_serde(field(case, "events")),
			"outputs": js_to_serde(field(case, "outputs")),
		});
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"sec client {index}: {actual}\n   expected {expected}"
			));
		}
	}
	report(&failures);
}

#[test]
fn sec_13f_pure_parts_match_typescript() {
	let file = load("sec_13f.json");
	let mut failures = Vec::new();
	for case in array(&file, "urls") {
		if sec_submissions_url(text(case, "cik")) != text(case, "submissions")
			|| sec_filing_text_url(text(case, "cik"), text(case, "accession"))
				!= text(case, "filing")
		{
			failures.push(format!("urls {:?}", text(case, "cik")));
		}
	}
	for (index, case) in array(&file, "selection").iter().enumerate() {
		let actual = result_json(
			select_recent_13f_filings(field(case, "input")),
			|recent| json!({"managerName": recent.manager_name, "filings": serde_json::to_value(&recent.filings).unwrap()}),
		);
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"selection {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for (index, case) in array(&file, "extraction").iter().enumerate() {
		let actual = extract_information_table_xml(text(case, "input"));
		if actual.as_deref() != optional_text(case, "output") {
			failures.push(format!("extraction {index}: {actual:?}"));
		}
	}
	for (index, case) in array(&file, "comparisons").iter().enumerate() {
		let holdings = |key: &str| -> Vec<Reported13FHolding> {
			array(case, key)
				.iter()
				.map(|h| Reported13FHolding {
					issuer_name: text(h, "issuerName").to_owned(),
					cusip: text(h, "cusip").to_owned(),
					// Infinity travels as JSON null in the exporter's output (JSON.stringify).
					reported_shares: field(h, "reportedShares").as_f64().unwrap_or(f64::INFINITY),
					reported_value_usd: number(h, "reportedValueUsd"),
				})
				.collect()
		};
		let actual = serde_json::to_value(compare_reported_positions(
			&holdings("previous"),
			&holdings("current"),
		))
		.unwrap();
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"comparison {index}: {actual}\n   expected {expected}"
			));
		}
	}
	report(&failures);
	let _ = ReportedPositionChange::NotReported;
}

fn encode_tree(value: &tree::Value) -> Json {
	match value {
		tree::Value::Text(text) => Json::String(text.clone()),
		tree::Value::Array(items) => {
			json!({"a": items.iter().map(encode_tree).collect::<Vec<_>>()})
		}
		tree::Value::Object(object) => encode_object(object),
	}
}

fn encode_object(object: &tree::Object) -> Json {
	json!({"o": object.iter().map(|(k, v)| json!([k, encode_tree(v)])).collect::<Vec<_>>()})
}

#[test]
fn information_table_trees_match_fast_xml_parser() {
	let file = load("sec_13f_trees.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 1500);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let input = text(case, "input");
		let units: Vec<u16> = input.encode_utf16().collect();
		let valid = validator::is_valid_xml(&units);
		let tree_json = if valid {
			info_table::parse(&units).map_or(json!({"throws": true}), |t| encode_object(&t))
		} else {
			json!({"throws": true})
		};
		let expected_valid = flag(case, "valid");
		let expected_tree = js_to_serde(field(case, "tree"));
		if valid != expected_valid || norm(&tree_json) != norm(&expected_tree) {
			failures.push(format!("tree {index} {input:?}: valid {valid}/{expected_valid} {tree_json}\n   expected {expected_tree}"));
		}
	}
	report(&failures);
}

#[test]
fn information_tables_match_typescript() {
	let file = load("sec_13f_tables.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 500);
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let actual = result_json(parse_information_table(text(case, "input")), |t| {
			serde_json::to_value(&t).unwrap()
		});
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!("table {index}: {actual}\n   expected {expected}"));
		}
	}
	report(&failures);
}

async fn replay_sec_source(file: &str, kind13f: bool) {
	let cases = load(file);
	let cases = cases.as_array().unwrap();
	assert!(cases.len() >= 100, "{file}");
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		let log = EventLog::default();
		let clock = Arc::new(TestClock(std::sync::atomic::AtomicI64::new(
			number(case, "startMs") as i64,
		)));
		let client: Arc<dyn SecClient> =
			Arc::new(sec_client(case, &log, field(case, "script"), &clock));
		let mut outputs = Vec::new();
		let holdings_source = Edgar13FSource {
			client: client.clone(),
		};
		let financials_source = EdgarFinancialsSource::new(client.clone(), clock.clone());
		for step in array(case, "steps") {
			clock.0.fetch_add(
				number(step, "advanceMs") as i64,
				std::sync::atomic::Ordering::SeqCst,
			);
			let token = CancellationToken::new();
			if flag(step, "cancel") {
				token.cancel();
			}
			let arg = text(step, "arg");
			outputs.push(if kind13f {
				result_json(
					holdings_source.latest_holdings(arg, Some(&token)).await,
					|r| serde_json::to_value(&r).unwrap(),
				)
			} else {
				result_json(
					financials_source
						.latest_annual_financials(arg, Some(&token))
						.await,
					|r| financials_json(&r),
				)
			});
		}
		let actual = json!({"events": log.snapshot(), "outputs": outputs});
		let expected = json!({"events": js_to_serde(field(case, "events")), "outputs": js_to_serde(field(case, "outputs"))});
		if norm(&actual) != norm(&expected) {
			failures.push(format!("{file} {index}: {actual}\n   expected {expected}"));
		}
	}
	report(&failures);
}

#[tokio::test]
async fn sec_13f_source_matches_typescript() {
	replay_sec_source("sec_13f_source.json", true).await;
}

#[tokio::test]
async fn sec_financials_source_matches_typescript() {
	replay_sec_source("sec_financials_source.json", false).await;
}

#[test]
fn sec_financials_pure_parts_match_typescript() {
	let file = load("sec_financials.json");
	let mut failures = Vec::new();
	for (index, case) in array(&file, "selection").iter().enumerate() {
		let actual = result_json(select_annual_financials(field(case, "input")), |s| {
			selected_json(&s)
		});
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"selection {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for (index, case) in array(&file, "directory").iter().enumerate() {
		let result = parse_ticker_directory(field(case, "input"));
		let actual = match result {
			Ok(map) => {
				json!({"ok": map.iter().map(|(k, v)| json!([k, serde_json::to_value(v).unwrap()])).collect::<Vec<_>>()})
			}
			Err(error) => json!({"err": sec_error_json(&error)}),
		};
		let expected = js_to_serde(field(case, "output"));
		if norm(&actual) != norm(&expected) {
			failures.push(format!(
				"directory {index}: {actual}\n   expected {expected}"
			));
		}
	}
	for case in array(&file, "tickerKeys") {
		if normalize_ticker_key(text(case, "input")) != text(case, "output") {
			failures.push(format!("tickerKey {:?}", text(case, "input")));
		}
	}
	assert_eq!(
		sec_company_facts_url("0000320193"),
		array(&file, "urls")[0].as_str().unwrap()
	);
	report(&failures);
}
