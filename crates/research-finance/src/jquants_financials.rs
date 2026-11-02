//! Japanese annual statements and company profiles from J-Quants (port of
//! `packages/adapters/src/finance/jquantsFinancials.ts`, ADR-0059), fetched
//! with the owner's `JQUANTS_API_KEY` through the same pinned host, fetch
//! options and `x-api-key` header as the prices (`jquants.rs`).
//!
//! - Statements (`financial-sync`, provider `jquants`, §2): one query
//!   `GET /v2/fins/summary?code=<5-char>`, every page (`pagination_key`, at
//!   most `JQUANTS_MAX_PAGES`), each page admitted by the runner's
//!   `jquants-fins` gate. [`jquants_summaries_to_sync`] turns the answer into
//!   the completion's identity and filings (pure; replays
//!   `vectors/finance/jquants_financials.json`).
//! - Profiles (the JP `stock-directory-refresh`, §3): `GET
//!   /v2/equities/master` with no parameters, every page, paced under
//!   `jquants`; [`jquants_master_to_profiles`] (pure; replays
//!   `vectors/finance/jquants_profiles.json`).
//!
//! Status mapping of the statements query: 400 → `FINANCIAL_PARSE_FAILED`
//! (the API never builds a malformed code); 401/403 →
//! `FINANCIAL_ACCESS_DENIED`; 429 → `FINANCIAL_RATE_LIMITED` (the runner
//! holds `jquants-fins`); any other status or a transport failure →
//! `FINANCIAL_SOURCE_FAILED` — the status kept unchanged (ADR-0037). The
//! error body is never logged or stored.
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/jquants.md

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use research_application::ports::{SafeFetchError, SafeFetchErrorCode, SafeFetcher};
use research_contracts::check_outgoing;
use research_contracts::equity_financials::{
	EquityAccountingStandard, EquityExtractedFact, EquityFactsStatus, EquityFilingMetadata,
	EquityFilingResult, EquityPeriodType, EquityProvider, EquityReportForm, EquityScope,
	EquitySyncFailureCode, EquitySyncIdentity, EquitySyncRequest, is_canonical_decimal,
	iso_day_number,
};
use research_contracts::stock_company_profile::StockCompanyProfile;
use research_domain::finance::financial_statements::iso_date_of_day_number;
use research_js::json::{Object, Value};
use research_js::utf16::compare;
use tokio_util::sync::CancellationToken;

use crate::equity_sync::{
	COMPLETION_CAPS, EquitySyncData, EquitySyncFailure, EquitySyncQuery, EquitySyncSource,
	compare_facts, equity_sync_failure_of_fetch, fit_completion_caps,
};
use crate::jquants::{JQUANTS_HOST, JQUANTS_MAX_PAGES, JQUANTS_PAGE_MAX_BYTES, parse_jquants_page};
use crate::market_fetch::{fetch_json_document, fetch_options};
use crate::ports::{BeforeRequest, Secret};

/// `JQUANTS_FINS_SUMMARY_PATH`: the earnings summaries query (ADR-0059 §2).
pub const JQUANTS_FINS_SUMMARY_PATH: &str = "/v2/fins/summary";
/// `JQUANTS_MASTER_PATH`: the Listed Issue Master query (ADR-0059 §3).
pub const JQUANTS_MASTER_PATH: &str = "/v2/equities/master";
/// `JQUANTS_FULL_YEAR_DOC_TYPE_PREFIX`: a full-year summary's `DocType`
/// prefix; every other kind carries no annual actuals.
pub const JQUANTS_FULL_YEAR_DOC_TYPE_PREFIX: &str = "FYFinancialStatements_";
/// J-Quants states every amount in yen.
const JQUANTS_UNIT: &str = "JPY";
/// A `DocType` of a non-consolidated filer.
const NON_CONSOLIDATED: &str = "_NonConsolidated_";

/// One summary item kept as a fact (`JQUANTS_ITEMS`): its concept, the
/// period it covers, and the non-consolidated (`NC…`) item of a
/// consolidated filer stored under the same concept with scope `separate`.
struct JquantsItem {
	item: &'static str,
	concept: &'static str,
	period: EquityPeriodType,
	separate_item: Option<&'static str>,
}

const fn item(
	item: &'static str,
	concept: &'static str,
	period: EquityPeriodType,
	separate_item: Option<&'static str>,
) -> JquantsItem {
	JquantsItem {
		item,
		concept,
		period,
		separate_item,
	}
}

const DURATION: EquityPeriodType = EquityPeriodType::Duration;
const INSTANT: EquityPeriodType = EquityPeriodType::Instant;

/// `JQUANTS_ITEMS`, in the TypeScript's order (the facts are sorted after).
const JQUANTS_ITEMS: [JquantsItem; 10] = [
	item("Sales", "jquants:Sales", DURATION, Some("NCSales")),
	item("OP", "jquants:OP", DURATION, Some("NCOP")),
	item("OdP", "jquants:OdP", DURATION, Some("NCOdP")),
	item("NP", "jquants:NP", DURATION, Some("NCNP")),
	item("CFO", "jquants:CFO", DURATION, None),
	item("CFI", "jquants:CFI", DURATION, None),
	item("CFF", "jquants:CFF", DURATION, None),
	item("TA", "jquants:TA", INSTANT, Some("NCTA")),
	item("Eq", "jquants:Eq", INSTANT, Some("NCEq")),
	item("CashEq", "jquants:CashEq", INSTANT, None),
];

/* ---------- Pure parts ---------- */

/// `canonicalJquantsDecimal`: a J-Quants amount (`/^([+-]?)(\d+)(?:\.(\d+))?$/`)
/// as canonical decimal text — a leading `+` and leading zeros removed,
/// trailing fractional zeros removed, `-0` as `0`. `None` when it is not a
/// plain decimal (`""`, an exponent, `.5`, `5.`, text) or the result is not
/// canonical (over 64 characters): the item then gives no fact.
#[must_use]
pub fn canonical_jquants_decimal(text: &str) -> Option<String> {
	let (negative, unsigned) = match text.as_bytes().first() {
		Some(b'-') => (true, text.get(1..)?),
		Some(b'+') => (false, text.get(1..)?),
		_ => (false, text),
	};
	let (whole, fraction) = match unsigned.split_once('.') {
		Some((whole, fraction)) => (whole, Some(fraction)),
		None => (unsigned, None),
	};
	let all_digits =
		|part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
	if !all_digits(whole) || fraction.is_some_and(|fraction| !all_digits(fraction)) {
		return None;
	}
	// `/^0+(?=\d)/`: leading zeros, keeping the last digit.
	let zeros = whole.bytes().take_while(|byte| *byte == b'0').count();
	let whole = whole.get(zeros.min(whole.len() - 1)..)?;
	let fraction = fraction.unwrap_or("").trim_end_matches('0');
	let mut value = String::with_capacity(text.len());
	if negative && !(whole == "0" && fraction.is_empty()) {
		value.push('-');
	}
	value.push_str(whole);
	if !fraction.is_empty() {
		value.push('.');
		value.push_str(fraction);
	}
	is_canonical_decimal(&value).then_some(value)
}

/// `^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$` as seconds of the day.
fn disclosure_seconds(time: &str) -> Option<i64> {
	let [h0, h1, b':', m0, m1, b':', s0, s1] = *time.as_bytes() else {
		return None;
	};
	let digit = |byte: u8| byte.is_ascii_digit().then(|| i64::from(byte - b'0'));
	let hours = digit(h0)? * 10 + digit(h1)?;
	let (m0, s0) = (digit(m0)?, digit(s0)?);
	if !matches!(h0, b'0'..=b'2') || hours > 23 || m0 > 5 || s0 > 5 {
		return None;
	}
	Some(hours * 3_600 + (m0 * 10 + digit(m1)?) * 60 + s0 * 10 + digit(s1)?)
}

/// `jquantsDisclosureInstant`: `DiscDate` + `DiscTime` in Asia/Tokyo (UTC+9,
/// no daylight saving) as UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SS.000Z`); `None`
/// when the date is not a calendar date or the time is not `HH:MM:SS`.
#[must_use]
pub fn jquants_disclosure_instant(date: &str, time: &str) -> Option<String> {
	let day = iso_day_number(date)?;
	let seconds = day * 86_400 + disclosure_seconds(time)? - 9 * 3_600;
	let (utc_day, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
	Some(format!(
		"{}T{:02}:{:02}:{:02}.000Z",
		iso_date_of_day_number(utc_day),
		of_day / 3_600,
		of_day % 3_600 / 60,
		of_day % 60
	))
}

/// `jquantsAccountingStandard`: the standard a `DocType` names by the text
/// after its last `_` (`JP`, `IFRS`, `US`); `None` for any other.
#[must_use]
pub fn jquants_accounting_standard(doc_type: &str) -> Option<EquityAccountingStandard> {
	let suffix = doc_type
		.rsplit_once('_')
		.map_or(doc_type, |(_, suffix)| suffix);
	match suffix {
		"JP" => Some(EquityAccountingStandard::Jgaap),
		"IFRS" => Some(EquityAccountingStandard::Ifrs),
		"US" => Some(EquityAccountingStandard::UsGaap),
		_ => None,
	}
}

/// `jquantsSummaryUrl`: the record's source — the query that answers it
/// (J-Quants keeps no public document page).
#[must_use]
pub fn jquants_summary_url(code: &str, disc_date: &str) -> String {
	let query = url::form_urlencoded::Serializer::new(String::new())
		.append_pair("code", code)
		.append_pair("date", disc_date)
		.finish();
	format!("https://{JQUANTS_HOST}{JQUANTS_FINS_SUMMARY_PATH}?{query}")
}

fn text_field<'a>(record: &'a Object, name: &str) -> Option<&'a str> {
	match record.get(name)? {
		Value::String(text) => Some(text),
		_ => None,
	}
}

/// One full-year summary as read from the answer.
struct FullYearSummary<'a> {
	disc_no: &'a str,
	disc_date: &'a str,
	disc_time: &'a str,
	doc_type: &'a str,
	fiscal_year_start: &'a str,
	fiscal_year_end: &'a str,
	period_start: &'a str,
	period_end: &'a str,
	record: &'a Object,
}

/// `readFullYearSummary`: `None` for a row that is not an object, a
/// `DocType` that does not start with `FYFinancialStatements_`, a `DiscNo`
/// that is not 14 digits, a `DiscDate`, `CurFYSt`, `CurFYEn`, `CurPerSt` or
/// `CurPerEn` that is not a calendar date, `CurPerSt` after `CurPerEn` or
/// `CurFYSt` after `CurFYEn`, or a `DiscTime` that is not text.
fn read_full_year_summary(row: &Value) -> Option<FullYearSummary<'_>> {
	let record = row.as_object()?;
	let doc_type = text_field(record, "DocType")?;
	let disc_no = text_field(record, "DiscNo")?;
	let summary = FullYearSummary {
		disc_no,
		disc_date: text_field(record, "DiscDate")?,
		disc_time: text_field(record, "DiscTime")?,
		doc_type,
		fiscal_year_start: text_field(record, "CurFYSt")?,
		fiscal_year_end: text_field(record, "CurFYEn")?,
		period_start: text_field(record, "CurPerSt")?,
		period_end: text_field(record, "CurPerEn")?,
		record,
	};
	let dates = [
		summary.disc_date,
		summary.fiscal_year_start,
		summary.fiscal_year_end,
		summary.period_start,
		summary.period_end,
	];
	let valid = doc_type.starts_with(JQUANTS_FULL_YEAR_DOC_TYPE_PREFIX)
		&& disc_no.len() == 14
		&& disc_no.bytes().all(|byte| byte.is_ascii_digit())
		&& dates.into_iter().all(|date| iso_day_number(date).is_some())
		// Calendar dates are ASCII: byte order is the TypeScript's.
		&& summary.period_start <= summary.period_end
		&& summary.fiscal_year_start <= summary.fiscal_year_end;
	valid.then_some(summary)
}

/// Disclosure order: `DiscDate`, `DiscTime`, `DiscNo` (UTF-16 code-unit order).
fn compare_disclosures(a: &FullYearSummary<'_>, b: &FullYearSummary<'_>) -> Ordering {
	compare(a.disc_date, b.disc_date)
		.then_with(|| compare(a.disc_time, b.disc_time))
		.then_with(|| compare(a.disc_no, b.disc_no))
}

/// `summaryFacts`: one fact per stated item in canonical order
/// (`compare_facts`), unit JPY. A `_Consolidated_` summary's items are
/// `consolidated` and its `NC…` items `separate` under the same concept; a
/// `_NonConsolidated_` summary's items are `separate` and its `NC…` items
/// are not read.
fn summary_facts(summary: &FullYearSummary<'_>) -> Vec<EquityExtractedFact> {
	let non_consolidated = summary.doc_type.contains(NON_CONSOLIDATED);
	let mut facts = Vec::with_capacity(JQUANTS_ITEMS.len() * 2);
	let mut add = |name: &str, concept: &str, period: EquityPeriodType, scope: EquityScope| {
		let Some(value_decimal) =
			text_field(summary.record, name).and_then(canonical_jquants_decimal)
		else {
			return;
		};
		facts.push(EquityExtractedFact {
			concept: concept.to_owned(),
			unit: JQUANTS_UNIT.to_owned(),
			value_decimal,
			period_type: period,
			period_start: (period == EquityPeriodType::Duration)
				.then(|| summary.period_start.to_owned()),
			period_end: summary.period_end.to_owned(),
			scope,
		});
	};
	for entry in &JQUANTS_ITEMS {
		let scope = if non_consolidated {
			EquityScope::Separate
		} else {
			EquityScope::Consolidated
		};
		add(entry.item, entry.concept, entry.period, scope);
		if let Some(separate) = entry.separate_item.filter(|_| !non_consolidated) {
			add(separate, entry.concept, entry.period, EquityScope::Separate);
		}
	}
	// Stable, like `Array#sort`.
	facts.sort_by(compare_facts);
	facts
}

/// The completion fields [`jquants_summaries_to_sync`] decides (`JquantsSyncData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JquantsSyncData {
	/// The code, no name, the newest fiscal year end; `None` without a full-year summary.
	pub identity: Option<EquitySyncIdentity>,
	/// New full-year summaries, newest first, within the completion caps.
	pub filings: Vec<EquityFilingResult>,
	/// The caps cut filings.
	pub more: bool,
}

/// `jquantsSummariesToSync` (ADR-0059 §2):
///
/// 1. Keep the full-year summaries (`read_full_year_summary`), in disclosure
///    order (`DiscDate`, `DiscTime`, `DiscNo`).
/// 2. The first summary of a fiscal year (`CurFYSt`, `CurFYEn`) is an
///    `earnings-report`; each later one an `amended-earnings-report`
///    amending the summary before it — decided over every full-year
///    summary, known ones included.
/// 3. Each summary whose `DiscNo` is not in `known_disclosures` is one
///    `extracted` filing (a `DiscNo` listed twice is reported once, the
///    first time); the completion caps keep the newest and `more` says
///    whether any was cut.
/// 4. Identity: the code, no name, the `MM-DD` of the newest `CurFYEn`;
///    `None` when the answer holds no full-year summary.
#[must_use]
pub fn jquants_summaries_to_sync(
	code: &str,
	known_disclosures: &[String],
	records: &[Value],
) -> JquantsSyncData {
	let mut summaries: Vec<FullYearSummary<'_>> =
		records.iter().filter_map(read_full_year_summary).collect();
	// Stable, like `Array#sort`.
	summaries.sort_by(compare_disclosures);
	let known: HashSet<&str> = known_disclosures.iter().map(String::as_str).collect();
	let mut previous_of_year: HashMap<(&str, &str), &str> = HashMap::new();
	let mut reported: HashSet<&str> = HashSet::new();
	let mut filings = Vec::new();
	let mut newest_year_end: Option<&str> = None;
	for summary in &summaries {
		let year = (summary.fiscal_year_start, summary.fiscal_year_end);
		let amends = previous_of_year.insert(year, summary.disc_no);
		if newest_year_end.is_none_or(|newest| summary.fiscal_year_end > newest) {
			newest_year_end = Some(summary.fiscal_year_end);
		}
		if known.contains(summary.disc_no) || !reported.insert(summary.disc_no) {
			continue;
		}
		filings.push(EquityFilingResult {
			metadata: EquityFilingMetadata {
				source_document_id: summary.disc_no.to_owned(),
				form: if amends.is_some() {
					EquityReportForm::AmendedEarningsReport
				} else {
					EquityReportForm::EarningsReport
				},
				filed_on: summary.disc_date.to_owned(),
				submitted_at: jquants_disclosure_instant(summary.disc_date, summary.disc_time),
				period_start: Some(summary.fiscal_year_start.to_owned()),
				period_end: summary.fiscal_year_end.to_owned(),
				amends_source_document_id: amends.map(str::to_owned),
				source_url: jquants_summary_url(code, summary.disc_date),
			},
			accounting_standard: jquants_accounting_standard(summary.doc_type),
			facts_status: EquityFactsStatus::Extracted,
			facts: summary_facts(summary),
		});
	}
	let fitted = fit_completion_caps(filings, COMPLETION_CAPS);
	JquantsSyncData {
		identity: newest_year_end.map(|end| EquitySyncIdentity {
			source_company_id: code.to_owned(),
			name: None,
			fiscal_year_end: end.get(5..).map(str::to_owned),
		}),
		more: !fitted.cut.is_empty(),
		filings: fitted.filings,
	}
}

/// `jquantsMasterToProfiles` (ADR-0059 §3): one profile per record whose
/// 5-character `Code` ends in `0` (a common stock; the symbol is its first
/// four characters), `CoNameEn` `None` when empty, `ScaleCat` `None` for
/// `-`. A record that is not an object, misses a field, whose `Date` is not
/// a calendar date or whose profile does not pass `stockCompanyProfileSchema`
/// is skipped; a symbol seen before keeps the first valid record's profile.
/// Values are copied as J-Quants states them (not trimmed).
#[must_use]
pub fn jquants_master_to_profiles(records: &[Value]) -> Vec<StockCompanyProfile> {
	let mut profiles = Vec::new();
	let mut seen: HashSet<String> = HashSet::new();
	for row in records {
		let Some(profile) = row.as_object().and_then(master_profile) else {
			continue;
		};
		if seen.contains(&profile.symbol)
			|| iso_day_number(&profile.as_of).is_none()
			|| check_outgoing(&profile).is_err()
		{
			continue;
		}
		seen.insert(profile.symbol.clone());
		profiles.push(profile);
	}
	profiles
}

/// The profile of one master record before validation; `None` when a field
/// is not text or the code is not five characters ending in `0`.
fn master_profile(row: &Object) -> Option<StockCompanyProfile> {
	let code = text_field(row, "Code")?;
	let name_en = text_field(row, "CoNameEn")?;
	let scale_category = text_field(row, "ScaleCat")?;
	let text = |name: &str| text_field(row, name).map(str::to_owned);
	// Five UTF-16 units ending in "0"; a non-ASCII code fails the symbol pattern anyway.
	if research_js::utf16::utf16_len(code) != 5 || !code.ends_with('0') {
		return None;
	}
	Some(StockCompanyProfile {
		// Four ASCII characters, else the symbol pattern refuses it (and a
		// non-ASCII head cannot be cut here): the record is skipped either way.
		symbol: code.get(..4)?.to_owned(),
		name_en: (!name_en.is_empty()).then(|| name_en.to_owned()),
		sector17_code: text("S17")?,
		sector17_name: text("S17Nm")?,
		sector33_code: text("S33")?,
		sector33_name: text("S33Nm")?,
		scale_category: (scale_category != "-").then(|| scale_category.to_owned()),
		market_segment_code: text("Mkt")?,
		market_segment_name: text("MktNm")?,
		as_of: text("Date")?,
	})
}

/* ---------- Requests ---------- */

/// Why a J-Quants page query ended without an answer (`JquantsPagesFailure`).
#[derive(Debug)]
enum PagesFailure {
	/// A status (unchanged) or a transport failure.
	Fetch(SafeFetchError),
	/// An answer of the wrong shape, or more than `JQUANTS_MAX_PAGES` pages.
	Shape,
	/// The gate refused (the job stopped while waiting).
	Stopped,
}

/// `jquantsPages`: every page of one query, each admitted by `before_request`,
/// with the requests sent (also on failure).
async fn jquants_pages(
	fetcher: &dyn SafeFetcher,
	api_key: &Secret,
	path: &str,
	query: &[(&str, &str)],
	cancel: &CancellationToken,
	before_request: &dyn BeforeRequest,
) -> (Result<Vec<Value>, PagesFailure>, usize) {
	let mut all = Vec::new();
	let mut key: Option<String> = None;
	let mut requests = 0usize;
	let mut page = 0usize;
	while page == 0 || key.is_some() {
		if page >= JQUANTS_MAX_PAGES {
			return (Err(PagesFailure::Shape), requests);
		}
		// Built before the await: the serializer is not `Send`.
		let url = {
			let mut params = url::form_urlencoded::Serializer::new(String::new());
			for (name, value) in query {
				params.append_pair(name, value);
			}
			if let Some(key) = &key {
				params.append_pair("pagination_key", key);
			}
			let search = params.finish();
			if search.is_empty() {
				format!("https://{JQUANTS_HOST}{path}")
			} else {
				format!("https://{JQUANTS_HOST}{path}?{search}")
			}
		};
		if !before_request.before_request().await {
			return (Err(PagesFailure::Stopped), requests);
		}
		requests += 1;
		let mut options = fetch_options(JQUANTS_HOST, "application/json", cancel);
		options.max_bytes = JQUANTS_PAGE_MAX_BYTES;
		options.x_api_key = Some(api_key.expose().to_owned());
		let json = match fetch_json_document(fetcher, &url, &options).await {
			Ok(json) => json,
			Err(error) => return (Err(PagesFailure::Fetch(error)), requests),
		};
		let Some((records, next)) = parse_jquants_page(&json) else {
			return (Err(PagesFailure::Shape), requests);
		};
		all.extend(records.iter().cloned());
		key = next;
		page += 1;
	}
	(Ok(all), requests)
}

/// `jquantsSyncFailureOfFetch`: 400 is a parse failure (the API never builds
/// a malformed code), the rest by `equity_sync_failure_of_fetch`.
#[must_use]
pub fn jquants_sync_failure_of_fetch(error: &SafeFetchError, requests: usize) -> EquitySyncFailure {
	if error.code == SafeFetchErrorCode::HttpError && error.status == Some(400) {
		return EquitySyncFailure {
			code: EquitySyncFailureCode::ParseFailed,
			upstream_status: Some(400),
			requests,
		};
	}
	equity_sync_failure_of_fetch(error, requests)
}

/// The `financial-sync` source of provider `jquants` (`createJquantsFinancialsSource`).
pub struct JquantsFinancialsSource {
	/// `JQUANTS_API_KEY`; `None` = not configured, nothing is requested.
	api_key: Option<Secret>,
	fetcher: Arc<dyn SafeFetcher>,
}

impl JquantsFinancialsSource {
	/// A source over the shared fetcher; `api_key` is `JQUANTS_API_KEY`.
	pub fn new(api_key: Option<Secret>, fetcher: Arc<dyn SafeFetcher>) -> Self {
		Self { api_key, fetcher }
	}
}

#[async_trait]
impl EquitySyncSource for JquantsFinancialsSource {
	fn provider(&self) -> EquityProvider {
		EquityProvider::Jquants
	}

	async fn sync(&self, query: EquitySyncQuery<'_>) -> Result<EquitySyncData, EquitySyncFailure> {
		let EquitySyncRequest::Jquants(request) = &query.target.source else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceFailed,
				0,
			));
		};
		let Some(api_key) = &self.api_key else {
			return Err(EquitySyncFailure::own(
				EquitySyncFailureCode::SourceNotConfigured,
				0,
			));
		};
		let (records, requests) = jquants_pages(
			self.fetcher.as_ref(),
			api_key,
			JQUANTS_FINS_SUMMARY_PATH,
			&[("code", &request.code)],
			query.cancel,
			query.before_request,
		)
		.await;
		let records = match records {
			Ok(records) => records,
			Err(PagesFailure::Fetch(error)) => {
				return Err(jquants_sync_failure_of_fetch(&error, requests));
			}
			Err(PagesFailure::Shape) => {
				return Err(EquitySyncFailure::own(
					EquitySyncFailureCode::ParseFailed,
					requests,
				));
			}
			Err(PagesFailure::Stopped) => {
				return Err(EquitySyncFailure::own(
					EquitySyncFailureCode::SourceFailed,
					requests,
				));
			}
		};
		let code = request.code.clone();
		let known = request.known_disclosures.clone();
		// CPU-bound for a company with many summaries: off the tokio workers.
		let data =
			crate::cpu::offload(move || jquants_summaries_to_sync(&code, &known, &records)).await;
		Ok(EquitySyncData {
			identity: data.identity,
			filings: data.filings,
			more: data.more,
			requests,
			description: None,
			description_unread: None,
		})
	}
}

/// What one master fetch gave (`JquantsProfilesData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JquantsProfilesData {
	/// The profiles, in master order.
	pub profiles: Vec<StockCompanyProfile>,
	/// Requests sent.
	pub requests: usize,
}

/// `JquantsProfilesFailureCode`: why the master could not be read (logged
/// as `company_profiles_failed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JquantsProfilesFailureCode {
	/// 401/403.
	AccessDenied,
	/// 429 (the runner holds `jquants`).
	RateLimited,
	/// An answer of the wrong shape, too large or over `JQUANTS_MAX_PAGES` pages.
	ParseFailed,
	/// Any other status, a transport failure, a stopped job or a fault.
	SourceFailed,
}

impl JquantsProfilesFailureCode {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::AccessDenied => "ACCESS_DENIED",
			Self::RateLimited => "RATE_LIMITED",
			Self::ParseFailed => "PARSE_FAILED",
			Self::SourceFailed => "SOURCE_FAILED",
		}
	}
}

/// Why the master could not be read (`JquantsProfilesFailure`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JquantsProfilesFailure {
	/// Stable code.
	pub code: JquantsProfilesFailureCode,
	/// J-Quants' status, unchanged; `None` when none answered.
	pub upstream_status: Option<u16>,
	/// Requests sent.
	pub requests: usize,
}

/// One master fetch (`JquantsProfilesQuery`).
pub struct JquantsProfilesQuery<'a> {
	/// The job's stop.
	pub cancel: &'a CancellationToken,
	/// The runner's `jquants` gate; false = the job stopped while waiting.
	pub before_request: &'a dyn BeforeRequest,
}

/// The JP directory refresh's company-profile fetch (`CompanyProfileSource`, ADR-0059 §3).
#[async_trait]
pub trait CompanyProfileSource: Send + Sync {
	/// The master's profiles, or J-Quants' status.
	async fn fetch_profiles(
		&self,
		query: JquantsProfilesQuery<'_>,
	) -> Result<JquantsProfilesData, JquantsProfilesFailure>;
}

/// The Listed Issue Master over J-Quants with the owner's key
/// (`createJquantsProfileSource`; the runner builds none without it).
pub struct JquantsProfileSource {
	api_key: Secret,
	fetcher: Arc<dyn SafeFetcher>,
}

impl JquantsProfileSource {
	/// A source over the shared fetcher.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self {
		Self { api_key, fetcher }
	}
}

#[async_trait]
impl CompanyProfileSource for JquantsProfileSource {
	async fn fetch_profiles(
		&self,
		query: JquantsProfilesQuery<'_>,
	) -> Result<JquantsProfilesData, JquantsProfilesFailure> {
		let (records, requests) = jquants_pages(
			self.fetcher.as_ref(),
			&self.api_key,
			JQUANTS_MASTER_PATH,
			&[],
			query.cancel,
			query.before_request,
		)
		.await;
		match records {
			Ok(records) => {
				let profiles =
					crate::cpu::offload(move || jquants_master_to_profiles(&records)).await;
				Ok(JquantsProfilesData { profiles, requests })
			}
			Err(failure) => Err(jquants_profiles_failure(&failure, requests)),
		}
	}
}

/// `jquantsProfilesFailure`: a page failure as the master's failure — a
/// status by the equity-sync mapping (400 included: any other status is a
/// source failure here), the status unchanged.
fn jquants_profiles_failure(failure: &PagesFailure, requests: usize) -> JquantsProfilesFailure {
	let (code, upstream_status) = match failure {
		PagesFailure::Shape => (JquantsProfilesFailureCode::ParseFailed, None),
		PagesFailure::Stopped => (JquantsProfilesFailureCode::SourceFailed, None),
		PagesFailure::Fetch(error) => {
			let code = match equity_sync_failure_of_fetch(error, requests).code {
				EquitySyncFailureCode::AccessDenied => JquantsProfilesFailureCode::AccessDenied,
				EquitySyncFailureCode::RateLimited => JquantsProfilesFailureCode::RateLimited,
				EquitySyncFailureCode::ParseFailed => JquantsProfilesFailureCode::ParseFailed,
				_ => JquantsProfilesFailureCode::SourceFailed,
			};
			(code, error.status)
		}
	};
	JquantsProfilesFailure {
		code,
		upstream_status,
		requests,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn amounts_become_canonical_decimal_text_or_nothing() {
		for (text, expected) in [
			("50684952000000", Some("50684952000000")),
			("-4339099000000", Some("-4339099000000")),
			("+0012", Some("12")),
			("000", Some("0")),
			("-0", Some("0")),
			("-0.000", Some("0")),
			("1.2300", Some("1.23")),
			("0.50", Some("0.5")),
			("", None),
			("1e5", None),
			(".5", None),
			("5.", None),
			("+-1", None),
			("１", None),
			(" 1", None),
		] {
			assert_eq!(
				canonical_jquants_decimal(text).as_deref(),
				expected,
				"{text}"
			);
		}
		assert_eq!(canonical_jquants_decimal(&"9".repeat(65)), None);
	}

	#[test]
	fn disclosure_instants_are_tokyo_time_in_utc() {
		assert_eq!(
			jquants_disclosure_instant("2026-05-08", "13:55:00").as_deref(),
			Some("2026-05-08T04:55:00.000Z")
		);
		assert_eq!(
			jquants_disclosure_instant("2026-01-01", "08:59:59").as_deref(),
			Some("2025-12-31T23:59:59.000Z")
		);
		for bad in ["24:00:00", "13:60:00", "1:00:00", "", "13:55"] {
			assert_eq!(jquants_disclosure_instant("2026-05-08", bad), None, "{bad}");
		}
		assert_eq!(jquants_disclosure_instant("2026-02-30", "13:55:00"), None);
	}

	#[test]
	fn standards_and_urls() {
		assert_eq!(
			jquants_accounting_standard("FYFinancialStatements_Consolidated_JP"),
			Some(EquityAccountingStandard::Jgaap)
		);
		assert_eq!(
			jquants_accounting_standard("FYFinancialStatements_NonConsolidated_JP"),
			Some(EquityAccountingStandard::Jgaap)
		);
		assert_eq!(
			jquants_accounting_standard("FYFinancialStatements_Consolidated_US"),
			Some(EquityAccountingStandard::UsGaap)
		);
		assert_eq!(
			jquants_accounting_standard("FYFinancialStatements_Consolidated_JMIS"),
			None
		);
		assert_eq!(
			jquants_summary_url("72030", "2026-05-08"),
			"https://api.jquants.com/v2/fins/summary?code=72030&date=2026-05-08"
		);
	}
}
