//! Replays `vectors/finance/tools_*.json` (written by Node from the real
//! TypeScript tools: `node scripts/vectors/index.ts finance`): the SEC and
//! position tools over scripted sources, with the whole result compared:
//! model text byte for byte, evidence, securities, observations, filings.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss
)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use research_agent_core::tools::{IdAllocator, Tool, ToolContext, ToolFailure, ToolOutput};
use research_application::ports::Hasher;
use research_contracts::json::to_js_value;
use research_domain::finance::per::PriceQuote;
use research_domain::finance::positions::{JpMarginBalanceFigures, UsShortInterestFigures};
use research_domain::finance::types::{AdjustmentBasis, Money};
use research_finance::market_data::{
	JpMarginBalanceReport, JpMarginBalanceSource, MarketDataProvenance, MarketDataUnavailable,
	SharePriceQuery, SharePriceReport, SharePriceSource, UnconfiguredSharePriceSource,
	UsShortInterestReport, UsShortInterestSource,
};
use research_finance::sec_13f::{
	FilingRef, Manager, Reported13FHolding, Sec13FFiling, Sec13FReport, Sec13FSource,
};
use research_finance::sec_client::{SecError, SecErrorCode};
use research_finance::sec_financials::{
	SecCompanyFinancials, SecFinancialsSource, SecIssuer, select_annual_financials,
};
use research_js::json::Value;
use research_tools::positions::{PositionToolDeps, create_position_tools};
use research_tools::sec::{SecToolDeps, create_sec_tools};
use serde_json::{Map, Number, Value as Json, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

/* ---------- helpers ---------- */

fn load(name: &str) -> Value {
	let path = format!(
		"{}/../../vectors/finance/{name}",
		env!("CARGO_MANIFEST_DIR")
	);
	let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
	research_js::json::parse(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn has<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
	value.as_object().and_then(|o| o.get(key))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
	has(value, key).unwrap_or_else(|| panic!("missing {key}"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
	field(value, key)
		.as_str()
		.unwrap_or_else(|| panic!("{key} not a string"))
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	has(value, key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> f64 {
	field(value, key)
		.as_f64()
		.unwrap_or_else(|| panic!("{key} not a number"))
}

fn optional_number(value: &Value, key: &str) -> Option<f64> {
	has(value, key).and_then(Value::as_f64)
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
	field(value, key)
		.as_array()
		.unwrap_or_else(|| panic!("{key} not an array"))
}

fn to_serde(value: &Value) -> Json {
	match value {
		Value::Null => Json::Null,
		Value::Bool(b) => Json::Bool(*b),
		Value::Number(n) => Number::from_f64(*n).map_or(Json::Null, Json::Number),
		Value::String(s) => Json::String(s.clone()),
		Value::Array(items) => Json::Array(items.iter().map(to_serde).collect()),
		Value::Object(o) => {
			let mut map = Map::new();
			for (k, v) in o.iter() {
				map.insert(k.to_owned(), to_serde(v));
			}
			Json::Object(map)
		}
	}
}

fn norm(value: &Json) -> Json {
	match value {
		Json::Number(n) => {
			let d = n.as_f64().unwrap_or(f64::NAN);
			if d == 0.0 && d.is_sign_negative() {
				// The exporters write a negative zero as this marker.
				Json::String("-0(neg)".to_owned())
			} else {
				Number::from_f64(d).map_or(Json::Null, Json::Number)
			}
		}
		Json::Array(items) => Json::Array(items.iter().map(norm).collect()),
		Json::Object(map) => Json::Object(map.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
		other => other.clone(),
	}
}

fn report(failures: &[String]) {
	assert!(
		failures.is_empty(),
		"{} mismatches, first: {:#?}",
		failures.len(),
		failures.iter().take(3).collect::<Vec<_>>()
	);
}

struct Sha256Hasher;

impl Hasher for Sha256Hasher {
	fn sha256_hex(&self, text: &str) -> String {
		hex::encode(Sha256::digest(text.as_bytes()))
	}
}

/// `run_test_<prefix><n>` with one counter across prefixes (the TypeScript double).
struct SharedCounter(AtomicU64);

impl IdAllocator for SharedCounter {
	fn next_id(&self, prefix: &str) -> String {
		let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
		format!("run_test_{prefix}{n}")
	}
}

fn context() -> ToolContext {
	ToolContext {
		run_id: "run_test".to_owned(),
		cancel: CancellationToken::new(),
		now_iso: Arc::new(|| "2026-10-11T03:00:00.000Z".to_owned()),
		ids: Arc::new(SharedCounter(AtomicU64::new(0))),
		subscribed_sources: Arc::from(Vec::new()),
	}
}

fn output_json(output: &ToolOutput) -> Json {
	json!({
		"modelText": output.model_text,
		"evidence": output.evidence.iter().map(|item| json!({
			"evidence": serde_json::to_value(&item.evidence).unwrap(),
			"retrievedText": item.retrieved_text,
			"retainQuotes": item.retain_quotes,
		})).collect::<Vec<_>>(),
		"securities": serde_json::to_value(&output.securities).unwrap(),
		"financialObservations": serde_json::to_value(&output.financial_observations).unwrap(),
		"positionObservations": serde_json::to_value(&output.position_observations).unwrap(),
		"investorFilings": serde_json::to_value(&output.investor_filings).unwrap(),
		"articles": serde_json::to_value(&output.articles).unwrap(),
	})
}

/// Runs one tool the way the TypeScript `defineTool` wrapper does.
async fn run(tool: &dyn Tool, args: &Value) -> Json {
	let parsed = tool.parse_args(args);
	let result = match &parsed {
		None => {
			json!({"err": {"code": "INVALID_ARGS", "detail": "arguments failed validation", "retryable": false}})
		}
		Some(parsed) => match tool.execute(clone(parsed), context()).await {
			Ok(output) => json!({"ok": output_json(&output)}),
			Err(failure) => failure_json(failure),
		},
	};
	json!({"parsedArgs": parsed.as_ref().map_or(Json::Null, to_serde), "result": result})
}

fn clone(value: &Value) -> Value {
	value.clone()
}

fn check(failures: &mut Vec<String>, label: String, actual: &Json, expected: &Value) {
	let expected = to_serde(expected);
	if norm(actual) != norm(&expected) {
		let (a, e) = (norm(actual), norm(&expected));
		let detail = match (a.as_object(), e.as_object()) {
			(Some(a), Some(e)) => a
				.keys()
				.chain(e.keys())
				.filter(|k| a.get(*k) != e.get(*k))
				.map(|k| {
					format!(
						"{k}: {} != expected {}",
						a.get(k).unwrap_or(&Json::Null),
						e.get(k).unwrap_or(&Json::Null)
					)
				})
				.collect::<Vec<_>>()
				.join("\n   "),
			_ => format!("{a} != expected {e}"),
		};
		failures.push(format!("{label}:\n   {detail}"));
	}
}

fn sec_error_of(value: &Value) -> SecError {
	let code = match text(value, "code") {
		"NOT_CONFIGURED" => SecErrorCode::NotConfigured,
		"INVALID_IDENTIFIER" => SecErrorCode::InvalidIdentifier,
		"NOT_FOUND" => SecErrorCode::NotFound,
		"ACCESS_DENIED" => SecErrorCode::AccessDenied,
		"RATE_LIMITED" => SecErrorCode::RateLimited,
		"FETCH_FAILED" => SecErrorCode::FetchFailed,
		"RESPONSE_TOO_LARGE" => SecErrorCode::ResponseTooLarge,
		"UNEXPECTED_RESPONSE" => SecErrorCode::UnexpectedResponse,
		"NO_DATA" => SecErrorCode::NoData,
		other => panic!("unknown SEC code {other}"),
	};
	SecError {
		code,
		detail: text(value, "detail").to_owned(),
		retryable: matches!(field(value, "retryable"), Value::Bool(true)),
		upstream_status: field(value, "upstreamStatus")
			.as_f64()
			.and_then(research_domain::upstream::upstream_status_from_number),
	}
}

/* ---------- company financials ---------- */

struct FakeFinancials {
	setup: Value,
}

#[async_trait]
impl SecFinancialsSource for FakeFinancials {
	async fn latest_annual_financials(
		&self,
		_ticker: &str,
		_cancel: Option<&CancellationToken>,
	) -> Result<SecCompanyFinancials, SecError> {
		if let Some(error) = has(&self.setup, "sourceError").filter(|v| !v.is_null()) {
			return Err(sec_error_of(error));
		}
		let issuer = field(&self.setup, "issuer");
		let selected = select_annual_financials(field(&self.setup, "facts"))?;
		Ok(SecCompanyFinancials {
			issuer: SecIssuer {
				cik: text(issuer, "cik").to_owned(),
				name: text(issuer, "name").to_owned(),
				ticker: text(issuer, "ticker").to_owned(),
				sec_exchange: optional_text(issuer, "secExchange").map(str::to_owned),
			},
			selected,
			ticker_directory_url: text(&self.setup, "directoryUrl").to_owned(),
			company_facts_url: text(&self.setup, "factsUrl").to_owned(),
		})
	}
}

struct FakePrice {
	mode: String,
	reason: String,
}

#[async_trait]
impl SharePriceSource for FakePrice {
	async fn latest_quote(
		&self,
		_query: SharePriceQuery<'_>,
	) -> Result<SharePriceReport, MarketDataUnavailable> {
		if self.mode == "failed" {
			return Err(MarketDataUnavailable {
				code: "NO_DATA".to_owned(),
				reason: self.reason.clone(),
			});
		}
		Ok(SharePriceReport {
			quote: PriceQuote {
				security_id: "x".to_owned(),
				price: Money {
					amount: 1.0,
					currency: "USD".to_owned(),
				},
				price_as_of: "2026-10-01T00:00:00.000Z".to_owned(),
				adjustment_basis: AdjustmentBasis::SplitAdjusted,
			},
			provenance: MarketDataProvenance {
				source_url: "https://example.com/".to_owned(),
				title: "t".to_owned(),
				publisher: "p".to_owned(),
				published_at: None,
				retrieved_text: "x".to_owned(),
			},
		})
	}
}

struct NoHoldings;

#[async_trait]
impl Sec13FSource for NoHoldings {
	async fn latest_holdings(
		&self,
		_cik: &str,
		_cancel: Option<&CancellationToken>,
	) -> Result<Sec13FReport, SecError> {
		Err(SecError::new(SecErrorCode::NoData, "unused"))
	}
}

struct NoFinancials;

#[async_trait]
impl SecFinancialsSource for NoFinancials {
	async fn latest_annual_financials(
		&self,
		_ticker: &str,
		_cancel: Option<&CancellationToken>,
	) -> Result<SecCompanyFinancials, SecError> {
		Err(SecError::new(SecErrorCode::NoData, "unused"))
	}
}

fn tool<'a>(tools: &'a [Arc<dyn Tool>], id: &str) -> &'a dyn Tool {
	tools
		.iter()
		.find(|t| t.meta().tool_id == id)
		.unwrap()
		.as_ref()
}

#[tokio::test]
async fn company_financials_match_typescript() {
	let file = load("tools_financials.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 300);
	let mut failures = Vec::new();
	for (i, case) in cases.iter().enumerate() {
		let setup = field(case, "setup");
		let price: Arc<dyn SharePriceSource> = if text(setup, "price") == "unconfigured" {
			Arc::new(UnconfiguredSharePriceSource)
		} else {
			Arc::new(FakePrice {
				mode: text(setup, "price").to_owned(),
				reason: text(setup, "priceReason").to_owned(),
			})
		};
		let tools = create_sec_tools(SecToolDeps {
			financials: Arc::new(FakeFinancials {
				setup: setup.clone(),
			}),
			filings: Arc::new(NoHoldings),
			share_price: price,
			hasher: Arc::new(Sha256Hasher),
		});
		let actual = run(tool(&tools, text(case, "toolId")), field(case, "args")).await;
		check(
			&mut failures,
			format!("financials {i}"),
			&actual,
			field(case, "output"),
		);
	}
	report(&failures);
}

/* ---------- 13F ---------- */

struct FakeHoldings {
	report: Value,
}

fn holdings_of(value: &Value) -> Vec<Reported13FHolding> {
	array(value, "holdings")
		.iter()
		.map(|h| Reported13FHolding {
			issuer_name: text(h, "issuerName").to_owned(),
			cusip: text(h, "cusip").to_owned(),
			// Infinity travels as JSON null; a holding always has shares.
			reported_shares: has(h, "reportedShares")
				.and_then(Value::as_f64)
				.unwrap_or(f64::INFINITY),
			reported_value_usd: number(h, "reportedValueUsd"),
		})
		.collect()
}

fn filing_of(value: &Value) -> Sec13FFiling {
	Sec13FFiling {
		filing: FilingRef {
			accession_number: text(value, "accessionNumber").to_owned(),
			report_period_end: text(value, "reportPeriodEnd").to_owned(),
			filed_at: text(value, "filedAt").to_owned(),
		},
		form: text(value, "form").to_owned(),
		filing_url: text(value, "filingUrl").to_owned(),
		holdings: holdings_of(value)
			.into_iter()
			.map(|h| research_finance::sec_13f::Reported13FHolding { ..h })
			.collect(),
		value_unit_as_filed: text(value, "valueUnitAsFiled").to_owned(),
		excluded_row_count: number(value, "excludedRowCount") as u64,
		unreadable_row_count: number(value, "unreadableRowCount") as u64,
		incomplete_cusips: array(value, "incompleteCusips")
			.iter()
			.map(|c| c.as_str().unwrap().to_owned())
			.collect(),
	}
}

#[async_trait]
impl Sec13FSource for FakeHoldings {
	async fn latest_holdings(
		&self,
		_cik: &str,
		_cancel: Option<&CancellationToken>,
	) -> Result<Sec13FReport, SecError> {
		let report = &self.report;
		if has(report, "manager").is_none() {
			return Err(sec_error_of(report));
		}
		let current = filing_of(field(report, "current"));
		let previous = has(report, "previous")
			.filter(|v| !v.is_null())
			.map(filing_of);
		Ok(Sec13FReport {
			manager: Manager {
				cik: text(field(report, "manager"), "cik").to_owned(),
				name: text(field(report, "manager"), "name").to_owned(),
			},
			submissions_url: text(report, "submissionsUrl").to_owned(),
			current: filing_of(field(report, "current")),
			previous: has(report, "previous")
				.filter(|v| !v.is_null())
				.map(filing_of),
			// The exporter's `changes` are `compareReportedPositions` of the two
			// filings (verified separately) whenever a comparison was made.
			changes: match (
				&previous,
				optional_text(report, "comparisonUnavailableReason"),
			) {
				(Some(previous), None) => research_finance::sec_13f::compare_reported_positions(
					&previous.holdings,
					&current.holdings,
				),
				_ => Vec::new(),
			},
			comparison_unavailable_reason: optional_text(report, "comparisonUnavailableReason")
				.map(str::to_owned),
		})
	}
}

#[tokio::test]
async fn holdings_match_typescript() {
	let file = load("tools_holdings.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 70);
	let mut failures = Vec::new();
	for (i, case) in cases.iter().enumerate() {
		let tools = create_sec_tools(SecToolDeps {
			financials: Arc::new(NoFinancials),
			filings: Arc::new(FakeHoldings {
				report: field(case, "setup").clone(),
			}),
			share_price: Arc::new(UnconfiguredSharePriceSource),
			hasher: Arc::new(Sha256Hasher),
		});
		let actual = run(
			tool(&tools, "filings.sec_13f_holdings"),
			field(case, "args"),
		)
		.await;
		check(
			&mut failures,
			format!("holdings {i}"),
			&actual,
			field(case, "output"),
		);
	}
	report(&failures);
}

/* ---------- positions ---------- */

struct FakePositions {
	setup: Value,
}

fn provenance_of(report: &Value) -> MarketDataProvenance {
	let p = field(report, "provenance");
	MarketDataProvenance {
		source_url: text(p, "sourceUrl").to_owned(),
		title: text(p, "title").to_owned(),
		publisher: text(p, "publisher").to_owned(),
		published_at: optional_text(p, "publishedAt").map(str::to_owned),
		retrieved_text: text(p, "retrievedText").to_owned(),
	}
}

fn unavailable_of(answer: &Value) -> Option<MarketDataUnavailable> {
	has(answer, "unavailable").map(|u| MarketDataUnavailable {
		code: text(u, "code").to_owned(),
		reason: text(u, "reason").to_owned(),
	})
}

#[async_trait]
impl UsShortInterestSource for FakePositions {
	async fn latest_short_interest(
		&self,
		_ticker: &str,
	) -> Result<UsShortInterestReport, MarketDataUnavailable> {
		let answer = field(&self.setup, "us");
		if let Some(error) = unavailable_of(answer) {
			return Err(error);
		}
		let report = field(answer, "report");
		let figures = field(report, "figures");
		Ok(UsShortInterestReport {
			figures: UsShortInterestFigures {
				reported_short_interest_shares: number(figures, "reportedShortInterestShares"),
				average_daily_volume_shares: optional_number(figures, "averageDailyVolumeShares"),
			},
			settlement_date: text(report, "asOfDate").to_owned(),
			disseminated_at: optional_text(report, "disseminatedAt").map(str::to_owned),
			provenance: provenance_of(report),
		})
	}
}

#[async_trait]
impl JpMarginBalanceSource for FakePositions {
	async fn latest_margin_balance(
		&self,
		_code: &str,
	) -> Result<JpMarginBalanceReport, MarketDataUnavailable> {
		let answer = field(&self.setup, "jp");
		if let Some(error) = unavailable_of(answer) {
			return Err(error);
		}
		let report = field(answer, "report");
		let figures = field(report, "figures");
		Ok(JpMarginBalanceReport {
			figures: JpMarginBalanceFigures {
				margin_buy_balance_shares: number(figures, "marginBuyBalanceShares"),
				margin_sell_balance_shares: number(figures, "marginSellBalanceShares"),
			},
			as_of_date: text(report, "asOfDate").to_owned(),
			disseminated_at: optional_text(report, "disseminatedAt").map(str::to_owned),
			provenance: provenance_of(report),
		})
	}
}

#[tokio::test]
async fn positions_match_typescript() {
	let file = load("tools_positions.json");
	let cases = file.as_array().unwrap();
	assert!(cases.len() > 300);
	let mut failures = Vec::new();
	for (i, case) in cases.iter().enumerate() {
		let source = Arc::new(FakePositions {
			setup: field(case, "setup").clone(),
		});
		let tools = create_position_tools(PositionToolDeps {
			us_short_interest: source.clone(),
			jp_margin_balance: source,
			hasher: Arc::new(Sha256Hasher),
		});
		let actual = run(tool(&tools, text(case, "toolId")), field(case, "args")).await;
		check(
			&mut failures,
			format!("positions {i}"),
			&actual,
			field(case, "output"),
		);
	}
	report(&failures);
	let _ = to_js_value::<Json>;
}

/// A tool failure as the exporters record it: `upstreamStatus` only when set (§4a).
fn failure_json(failure: ToolFailure) -> serde_json::Value {
	let mut value =
		json!({"code": failure.code, "detail": failure.detail, "retryable": failure.retryable});
	if let Some(status) = failure.upstream_status {
		value["upstreamStatus"] = json!(status);
	}
	json!({ "err": value })
}
