//! Replays the pure-function vectors of the financial statement sync
//! (ADR-0048), written by Node from the TypeScript reference
//! (`scripts/vectors/finance/equitySync.ts`):
//! `vectors/finance/equity_sync_{shared,sec,edinet}.json`. Objects compare
//! as JSON values (key order aside: the TypeScript builds some objects by
//! spreading, the Rust serialises in schema order).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::cmp::Ordering;

use base64::Engine;
use research_application::ports::{SafeFetchError, SafeFetchErrorCode};
use research_contracts::equity_financials::{
	EquityExtractedFact, EquityFilingMetadata, EquityFilingResult, EquitySyncFailureCode,
	EquitySyncRequest,
};
use research_finance::edinet_csv::{
	decode_utf16_le, edinet_context, extract_edinet_report, for_each_tsv_row, parse_edinet_csv,
	select_edinet_report_entry,
};
use research_finance::edinet_documents::{
	EdinetAnnualRow, EdinetListProblem, EdinetListedRow, EdinetPlanInput, edinet_download_plan,
	edinet_error_status, edinet_filing_metadata, edinet_identity, parse_edinet_document_list,
};
use research_finance::equity_sync::{
	CompletionCaps, annual_facts_in_order, compare_facts, equity_sync_code_of_status,
	equity_sync_failure_of_fetch, fit_completion_caps,
};
use research_finance::sec_annual::{
	SecSyncInput, equity_sync_failure_of_sec, index_sec_company_facts, parse_sec_submissions,
	sec_filing_url, sec_needs_company_facts, sec_sync_result,
};
use research_finance::sec_client::{SecError, SecErrorCode};
use serde_json::{Value as Json, json};

/* ---------- loading ---------- */

fn root() -> std::path::PathBuf {
	std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn load(name: &str) -> Json {
	let path = root().join("vectors/finance").join(name);
	serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn fixture_path(name: &str) -> std::path::PathBuf {
	root().join("examples/fixtures/equity-sync").join(name)
}

/// A JSON value as `JSON.parse` would give it.
fn js(value: &Json) -> research_js::json::Value {
	research_js::json::parse(&value.to_string()).unwrap()
}

/// `{fixture}` / `{inline}` / `{base64}` inputs as the JavaScript value they stand for.
fn resolve(input: &Json) -> research_js::json::Value {
	if let Some(name) = input.get("fixture").and_then(Json::as_str) {
		return research_js::json::parse(&std::fs::read_to_string(fixture_path(name)).unwrap())
			.unwrap();
	}
	js(&input["inline"])
}

fn bytes_of(input: &Json) -> Vec<u8> {
	if let Some(name) = input.get("fixture").and_then(Json::as_str) {
		return std::fs::read(fixture_path(name)).unwrap();
	}
	base64::engine::general_purpose::STANDARD
		.decode(input["base64"].as_str().unwrap())
		.unwrap()
}

fn to_json<T: serde::Serialize>(value: &T) -> Json {
	serde_json::to_value(value).unwrap()
}

fn rows<'a>(file: &'a Json, name: &str) -> &'a [Json] {
	file[name]
		.as_array()
		.unwrap_or_else(|| panic!("missing {name}"))
}

fn strings(value: &Json) -> Vec<String> {
	value
		.as_array()
		.unwrap()
		.iter()
		.map(|item| item.as_str().unwrap().to_owned())
		.collect()
}

fn fact(value: &Json) -> EquityExtractedFact {
	serde_json::from_value(value.clone()).unwrap()
}

fn facts(value: &Json) -> Vec<EquityExtractedFact> {
	serde_json::from_value(value.clone()).unwrap()
}

fn filing(value: &Json) -> EquityFilingResult {
	research_contracts::validate(&js(value)).unwrap()
}

fn metadata(value: &Json) -> EquityFilingMetadata {
	research_contracts::validate(&js(value)).unwrap()
}

/// Collects mismatches and reports them all at once.
#[derive(Default)]
struct Check {
	failures: Vec<String>,
	total: usize,
}

impl Check {
	fn same(&mut self, what: &str, actual: &Json, expected: &Json) {
		self.total += 1;
		if actual != expected {
			self.failures.push(format!(
				"{what}\n   rust:       {}\n   typescript: {}",
				truncate(&actual.to_string()),
				truncate(&expected.to_string())
			));
		}
	}

	fn done(self, minimum: usize) {
		assert!(self.total >= minimum, "only {} cases", self.total);
		assert!(
			self.failures.is_empty(),
			"{} of {} cases differ:\n{}",
			self.failures.len(),
			self.total,
			self.failures
				.iter()
				.take(8)
				.cloned()
				.collect::<Vec<_>>()
				.join("\n")
		);
	}
}

fn truncate(text: &str) -> String {
	if text.chars().count() > 600 {
		format!("{}…", text.chars().take(600).collect::<String>())
	} else {
		text.to_owned()
	}
}

fn result_json<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> Json {
	match result {
		Ok(value) => json!({ "ok": value }),
		Err(error) => json!({ "err": error }),
	}
}

/* ---------- shared ---------- */

fn fetch_error(value: &Json) -> SafeFetchError {
	let codes = [
		SafeFetchErrorCode::UnsafeUrl,
		SafeFetchErrorCode::HostNotAllowed,
		SafeFetchErrorCode::UnsafeRedirect,
		SafeFetchErrorCode::TooManyRedirects,
		SafeFetchErrorCode::RedirectNotAuthorized,
		SafeFetchErrorCode::Timeout,
		SafeFetchErrorCode::HttpError,
		SafeFetchErrorCode::ResponseTooLarge,
		SafeFetchErrorCode::NetworkError,
	];
	let name = value["code"].as_str().unwrap();
	let code = codes
		.into_iter()
		.find(|code| code.as_str() == name)
		.unwrap();
	let detail = value["detail"].as_str().unwrap_or("");
	match value.get("status").and_then(Json::as_u64) {
		Some(status) if code == SafeFetchErrorCode::HttpError => {
			SafeFetchError::http(u16::try_from(status).unwrap(), detail, None)
		}
		Some(status) => SafeFetchError::answered(code, u16::try_from(status).unwrap(), detail),
		None => SafeFetchError::new(code, detail),
	}
}

fn sec_error(code: &str, upstream_status: &Json) -> SecError {
	let codes = [
		SecErrorCode::NotConfigured,
		SecErrorCode::InvalidIdentifier,
		SecErrorCode::NotFound,
		SecErrorCode::AccessDenied,
		SecErrorCode::RateLimited,
		SecErrorCode::FetchFailed,
		SecErrorCode::ResponseTooLarge,
		SecErrorCode::UnexpectedResponse,
		SecErrorCode::NoData,
	];
	SecError {
		code: codes.into_iter().find(|c| c.as_str() == code).unwrap(),
		detail: "x".to_owned(),
		retryable: false,
		upstream_status: upstream_status.as_u64().map(|s| u16::try_from(s).unwrap()),
	}
}

#[test]
fn shared_rules_match_typescript() {
	let file = load("equity_sync_shared.json");
	let mut check = Check::default();
	for row in rows(&file, "codeOfStatus") {
		let status = u16::try_from(row["status"].as_u64().unwrap()).unwrap();
		check.same(
			&format!("codeOfStatus {status}"),
			&json!(equity_sync_code_of_status(status).as_str()),
			&row["output"],
		);
	}
	for row in rows(&file, "failureOfFetch") {
		let requests = usize::try_from(row["requests"].as_u64().unwrap()).unwrap();
		check.same(
			&format!("failureOfFetch {}", row["error"]),
			&to_json(&equity_sync_failure_of_fetch(
				&fetch_error(&row["error"]),
				requests,
			)),
			&row["output"],
		);
	}
	for row in rows(&file, "failureOfSec") {
		let error = sec_error(row["code"].as_str().unwrap(), &row["upstreamStatus"]);
		check.same(
			&format!("failureOfSec {row}"),
			&to_json(&equity_sync_failure_of_sec(&error, 4)),
			&row["output"],
		);
	}
	for row in rows(&file, "retryable") {
		let code = EquitySyncFailureCode::from_str_value(row["code"].as_str().unwrap()).unwrap();
		check.same("retryable", &json!(code.is_retryable()), &row["output"]);
	}
	for row in rows(&file, "compareFacts") {
		let sign = match compare_facts(&fact(&row["a"]), &fact(&row["b"])) {
			Ordering::Less => -1,
			Ordering::Equal => 0,
			Ordering::Greater => 1,
		};
		check.same(&format!("compareFacts {row}"), &json!(sign), &row["output"]);
	}
	for row in rows(&file, "annualFactsInOrder") {
		check.same(
			&format!("annualFactsInOrder {}", row["facts"]),
			&to_json(&annual_facts_in_order(facts(&row["facts"]))),
			&row["output"],
		);
	}
	for row in rows(&file, "fitCompletionCaps") {
		let filings: Vec<EquityFilingResult> = row["filings"]
			.as_array()
			.unwrap()
			.iter()
			.map(filing)
			.collect();
		let caps = CompletionCaps {
			max_filings: usize::try_from(row["caps"]["maxFilings"].as_u64().unwrap()).unwrap(),
			max_facts: usize::try_from(row["caps"]["maxFacts"].as_u64().unwrap()).unwrap(),
		};
		let fitted = fit_completion_caps(filings, caps);
		let actual = json!({
			"filings": fitted.filings.iter().map(|filing| json!({
				"id": filing.metadata.source_document_id,
				"status": filing.facts_status.as_str(),
				"facts": filing.facts.len(),
			})).collect::<Vec<_>>(),
			"cut": fitted.cut.iter().map(|filing| filing.metadata.source_document_id.clone()).collect::<Vec<_>>(),
		});
		check.same(&format!("fitCompletionCaps {row}"), &actual, &row["output"]);
	}
	check.done(1_500);
}

/* ---------- SEC ---------- */

#[test]
fn sec_extraction_matches_typescript() {
	let file = load("equity_sync_sec.json");
	let mut check = Check::default();
	for row in rows(&file, "parseSecSubmissions") {
		let parsed = parse_sec_submissions(&resolve(&row["document"]));
		check.same(
			&format!("parseSecSubmissions {}", row["document"]),
			&result_json(parsed.map_err(|_| "PARSE_FAILED")),
			&row["output"],
		);
	}
	for row in rows(&file, "indexSecCompanyFacts") {
		let indexed =
			index_sec_company_facts(&resolve(&row["document"]), &strings(&row["concepts"]));
		let actual = result_json(
			indexed
				.map(|index| {
					let mut records: Vec<Json> = index
						.into_iter()
						.map(|(accession, record)| {
							let mut facts = record.facts;
							facts.sort_by(compare_facts);
							json!({
								"accession": accession,
								"form": record.form,
								"filed": record.filed,
								"entryCount": record.entry_count,
								"facts": facts,
							})
						})
						.collect();
					records.sort_by(|a, b| {
						a["accession"]
							.as_str()
							.unwrap()
							.cmp(b["accession"].as_str().unwrap())
					});
					records
				})
				.map_err(|_| "PARSE_FAILED"),
		);
		check.same(
			&format!(
				"indexSecCompanyFacts {} {}",
				truncate(&row["document"].to_string()),
				row["concepts"]
			),
			&actual,
			&row["output"],
		);
	}
	let submissions = parse_sec_submissions(&resolve(&json!({
		"fixture": "sec-submissions-CIK0009999981.synthetic.json"
	})))
	.unwrap();
	for (index, row) in rows(&file, "secSyncResult").iter().enumerate() {
		let mut request_json = row["request"].clone();
		request_json["provider"] = json!("sec");
		let EquitySyncRequest::Sec(request) =
			research_contracts::validate::<EquitySyncRequest>(&js(&request_json)).unwrap()
		else {
			panic!("an SEC request");
		};
		let facts = match &row["facts"] {
			Json::Null => None,
			Json::String(empty) if empty == "empty" => Some(Default::default()),
			value => Some(
				index_sec_company_facts(
					&resolve(&json!({ "fixture": value["fixture"] })),
					&strings(&value["concepts"]),
				)
				.unwrap(),
			),
		};
		let caps = match &row["caps"] {
			Json::Null => research_finance::equity_sync::COMPLETION_CAPS,
			caps => CompletionCaps {
				max_filings: usize::try_from(caps["maxFilings"].as_u64().unwrap()).unwrap(),
				max_facts: usize::try_from(caps["maxFacts"].as_u64().unwrap()).unwrap(),
			},
		};
		check.same(
			&format!("secNeedsCompanyFacts {index}"),
			&json!(sec_needs_company_facts(&request, &submissions)),
			&row["needsCompanyFacts"],
		);
		let result = sec_sync_result(
			&SecSyncInput {
				request: &request,
				cik: row["cik"].as_str().unwrap(),
				submissions: &submissions,
				facts: facts.as_ref(),
			},
			caps,
		);
		check.same(
			&format!("secSyncResult {index}"),
			&to_json(&result),
			&row["output"],
		);
	}
	for row in rows(&file, "secFilingUrl") {
		check.same(
			&format!("secFilingUrl {row}"),
			&json!(sec_filing_url(
				row["cik"].as_str().unwrap(),
				row["accession"].as_str().unwrap(),
				row["primaryDocument"].as_str()
			)),
			&row["output"],
		);
	}
	check.done(100);
}

/* ---------- EDINET ---------- */

fn list_problem(problem: EdinetListProblem) -> Json {
	match problem {
		EdinetListProblem::Parse => json!({ "kind": "parse" }),
		EdinetListProblem::Status(status) => json!({ "kind": "status", "status": status }),
	}
}

fn annual_rows(value: &Json) -> Vec<EdinetAnnualRow> {
	serde_json::from_value(value.clone()).unwrap()
}

#[test]
fn edinet_extraction_matches_typescript() {
	let file = load("equity_sync_edinet.json");
	let concepts = strings(&file["concepts"]);
	let mut check = Check::default();
	for row in rows(&file, "parseEdinetDocumentList") {
		let parsed = parse_edinet_document_list(&resolve(&row["document"]));
		let actual = match parsed {
			Ok(rows) => json!({ "ok": rows }),
			Err(problem) => json!({ "err": list_problem(problem) }),
		};
		check.same(
			&format!("parseEdinetDocumentList {}", row["document"]),
			&actual,
			&row["output"],
		);
	}
	for row in rows(&file, "edinetErrorStatus") {
		check.same(
			&format!("edinetErrorStatus {}", row["body"]),
			&json!(edinet_error_status(&js(&row["body"]))),
			&row["output"],
		);
	}
	for row in rows(&file, "edinetFilingMetadata") {
		let input: EdinetAnnualRow = serde_json::from_value(row["row"].clone()).unwrap();
		check.same(
			&format!("edinetFilingMetadata {}", row["row"]),
			&to_json(&edinet_filing_metadata(&input)),
			&row["output"],
		);
	}
	for row in rows(&file, "edinetIdentity") {
		let matched = annual_rows(&row["matched"]);
		check.same(
			&format!("edinetIdentity {row}"),
			&to_json(&edinet_identity(
				matched.iter(),
				row["claimEdinetCode"].as_str(),
			)),
			&row["output"],
		);
	}
	for (index, row) in rows(&file, "edinetDownloadPlan").iter().enumerate() {
		let pending: Vec<EquityFilingMetadata> = row["pending"]
			.as_array()
			.unwrap()
			.iter()
			.map(metadata)
			.collect();
		let found: Vec<EdinetListedRow> = serde_json::from_value(row["found"].clone()).unwrap();
		let plan = edinet_download_plan(&EdinetPlanInput {
			pending: &pending,
			found: &found,
			known_doc_ids: &strings(&row["knownDocIds"]),
			max_downloads: usize::try_from(row["maxDownloads"].as_u64().unwrap()).unwrap(),
		});
		check.same(
			&format!("edinetDownloadPlan {index}"),
			&to_json(&plan),
			&row["output"],
		);
	}
	for row in rows(&file, "decodeUtf16Le") {
		let bytes = bytes_of(&json!({ "base64": row["base64"] }));
		check.same(
			&format!("decodeUtf16Le {}", row["base64"]),
			&result_json(decode_utf16_le(&bytes).map_err(|_| "ENCODING")),
			&row["output"],
		);
	}
	for row in rows(&file, "forEachTsvRow") {
		let mut out: Vec<Vec<String>> = Vec::new();
		for_each_tsv_row(row["text"].as_str().unwrap(), |fields| {
			out.push(fields.iter().map(|field| field.to_string()).collect());
			true
		});
		check.same(
			&format!("forEachTsvRow {}", row["text"]),
			&to_json(&out),
			&row["output"],
		);
	}
	for row in rows(&file, "edinetContext") {
		let actual = edinet_context(row["input"].as_str().unwrap())
			.map(|(context, scope)| json!({ "context": context, "scope": scope }));
		check.same(
			&format!("edinetContext {}", row["input"]),
			&to_json(&actual),
			&row["output"],
		);
	}
	for row in rows(&file, "parseEdinetCsv") {
		let parsed = parse_edinet_csv(row["text"].as_str().unwrap(), &strings(&row["concepts"]));
		check.same(
			&format!(
				"parseEdinetCsv {} {}",
				truncate(&row["text"].to_string()),
				row["concepts"]
			),
			&result_json(parsed.map_err(|_| "MISSING_HEADER")),
			&row["output"],
		);
	}
	for row in rows(&file, "selectEdinetReportEntry") {
		check.same(
			&format!("selectEdinetReportEntry {}", row["names"]),
			&json!(select_edinet_report_entry(&strings(&row["names"]))),
			&row["output"],
		);
	}
	for row in rows(&file, "extractEdinetReport") {
		let report = extract_edinet_report(&bytes_of(&row["archive"]), &concepts);
		check.same(
			&format!("extractEdinetReport {}", row["name"]),
			&result_json(report.map_err(|problem| problem.as_str())),
			&row["output"],
		);
	}
	check.done(1_000);
}
