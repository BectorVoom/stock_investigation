//! Annual SEC company-facts selection with explicit missing/currency/period semantics (DATA-005).
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/sec-edgar.md
use crate::{
	market_fetch::{array, field, text},
	ports::BeforeRequest,
	sec_client::*,
};
use async_trait::async_trait;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;
use research_application::ports::Clock;
use research_domain::finance::{
	net_margin::{
		ContinuingOperationsPolicy, IncomeFigure, NetMarginError, NetProfitMargin,
		compute_net_profit_margin,
	},
	types::{AccountingStandard, FiscalPeriod, Money, ReportingPeriod},
};
use research_js::{
	json::{Object, Value},
	number::to_js_string,
	whitespace::trim,
};
use serde::Serialize;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
/// SEC ticker directory, cached twelve hours.
pub const SEC_TICKER_DIRECTORY_URL: &str =
	"https://www.sec.gov/files/company_tickers_exchange.json";
/// Revenue tie-breaking precedence.
pub const REVENUE_CONCEPT_PRECEDENCE: [&str; 4] = [
	"Revenues",
	"RevenueFromContractWithCustomerExcludingAssessedTax",
	"RevenueFromContractWithCustomerIncludingAssessedTax",
	"SalesRevenueNet",
];
/// Company-facts API URL.
pub fn sec_company_facts_url(cik: &str) -> String {
	format!("https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")
}
/// Accepts dotted share classes as the SEC's hyphenated ticker.
pub fn normalize_ticker_key(ticker: &str) -> String {
	trim(ticker).to_uppercase().replace('.', "-")
}
/// SEC issuer identity.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecIssuer {
	/// Zero-padded SEC CIK.
	pub cik: String,
	/// SEC company name.
	pub name: String,
	/// SEC spelling of the ticker.
	pub ticker: String,
	/// Exchange text exactly as SEC publishes it.
	pub sec_exchange: Option<String>,
}
/// Unit kind of an annual figure.
#[derive(Clone, Copy, Debug, Serialize)]
pub enum SecFigureUnit {
	/// Currency amount.
	#[serde(rename = "currency")]
	Currency,
	/// Currency per share.
	#[serde(rename = "currency-per-share")]
	CurrencyPerShare,
}
/// One selected annual fact with filing lineage.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecAnnualFigure {
	/// Taxonomy-qualified concept.
	pub concept: String,
	/// Reported number.
	pub amount: f64,
	/// Number's unit.
	pub unit: SecFigureUnit,
	/// Reporting currency.
	pub currency: String,
	/// Own start/end dates; fiscal year is the end year.
	pub period: ReportingPeriod,
	/// Fiscal year of the filing that supplied the fact.
	pub filing_fiscal_year: Option<f64>,
	/// US-GAAP.
	pub accounting_standard: AccountingStandard,
	/// 10-K or 10-K/A.
	pub form: String,
	/// Filing accession.
	pub accession_number: String,
	/// Filing date.
	pub filed_at: String,
}
/// Explicitly unavailable figure.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{reason}")]
pub struct Unavailable {
	/// Fixed explanation.
	pub reason: String,
}
/// A selected annual figure or explicit absence.
pub type FigureResult = Result<SecAnnualFigure, Unavailable>;
/// Independent annual selections and their derived margin.
#[derive(Clone, Debug)]
pub struct SelectedFinancials {
	/// Revenue.
	pub revenue: FigureResult,
	/// Net income.
	pub net_income: FigureResult,
	/// Diluted earnings per share.
	pub eps_diluted: FigureResult,
	/// Margin with honest failure semantics.
	pub net_profit_margin: Result<NetProfitMargin, Unavailable>,
}
/// Company financials and the documents actually retrieved.
#[derive(Clone, Debug)]
pub struct SecCompanyFinancials {
	/// Resolved identity.
	pub issuer: SecIssuer,
	/// Annual selected figures.
	pub selected: SelectedFinancials,
	/// Retrieved directory URL.
	pub ticker_directory_url: String,
	/// Retrieved facts URL.
	pub company_facts_url: String,
}
fn unexpected(detail: &str) -> SecError {
	SecError::new(SecErrorCode::UnexpectedResponse, detail)
}
/// Reads columns by name and keeps the first usable ticker occurrence.
pub fn parse_ticker_directory(value: &Value) -> Result<IndexMap<String, SecIssuer>, SecError> {
	let fields = array(value, "fields")
		.filter(|a| a.iter().all(|v| v.as_str().is_some()))
		.ok_or_else(|| unexpected("SEC ticker directory has an unexpected shape"))?;
	let rows = array(value, "data")
		.filter(|a| a.iter().all(|v| v.as_array().is_some()))
		.ok_or_else(|| unexpected("SEC ticker directory has an unexpected shape"))?;
	let columns = ["cik", "name", "ticker", "exchange"]
		.map(|key| fields.iter().position(|v| v.as_str() == Some(key)));
	let [
		Some(cik_at),
		Some(name_at),
		Some(ticker_at),
		Some(exchange_at),
	] = columns
	else {
		return Err(unexpected(
			"SEC ticker directory is missing expected columns",
		));
	};
	let mut issuers = IndexMap::new();
	for row in rows.iter().filter_map(Value::as_array) {
		let Some(cik) = row
			.get(cik_at)
			.and_then(Value::as_f64)
			.filter(|v| v.is_finite() && *v > 0.0 && v.fract() == 0.0)
		else {
			continue;
		};
		let Some(name) = row.get(name_at).and_then(Value::as_str) else {
			continue;
		};
		let Some(ticker) = row
			.get(ticker_at)
			.and_then(Value::as_str)
			.filter(|s| !trim(s).is_empty())
		else {
			continue;
		};
		let key = normalize_ticker_key(ticker);
		issuers.entry(key).or_insert_with(|| SecIssuer {
			cik: format!("{:0>10}", to_js_string(cik)),
			name: trim(name).to_owned(),
			ticker: trim(ticker).to_uppercase(),
			sec_exchange: row
				.get(exchange_at)
				.and_then(Value::as_str)
				.map(trim)
				.filter(|s| !s.is_empty())
				.map(str::to_owned),
		});
	}
	if issuers.is_empty() {
		return Err(unexpected("SEC ticker directory contains no usable rows"));
	}
	Ok(issuers)
}
struct AnnualFact<'a> {
	start: &'a str,
	end: &'a str,
	value: f64,
	accn: &'a str,
	fy: Option<f64>,
	form: &'a str,
	filed: &'a str,
	year: f64,
}
fn annual_fact(value: &Value) -> Option<AnnualFact<'_>> {
	let date = |key| text(value, key).filter(|s| crate::sec_13f::iso_date(s));
	let start = date("start")?;
	let end = date("end")?;
	let filed = date("filed")?;
	let amount = field(value, "val")?.as_f64().filter(|n| n.is_finite())?;
	let accn = text(value, "accn").filter(|s| (1..=40).contains(&s.chars().count()))?;
	let form = text(value, "form")?;
	if !matches!(form, "10-K" | "10-K/A") || text(value, "fp") != Some("FY") {
		return None;
	}
	let fy = field(value, "fy");
	if fy.is_some_and(|v| {
		!v.is_null()
			&& !v.as_f64().is_some_and(|n| {
				n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
			})
	}) {
		return None;
	}
	let start_date = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d").ok()?;
	let end_date = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").ok()?;
	if !(350..=380).contains(&(end_date - start_date).num_days().saturating_add(1)) {
		return None;
	}
	let year: f64 = end.get(..4)?.parse().ok()?;
	if !(1990.0..=2100.0).contains(&year) {
		return None;
	}
	Some(AnnualFact {
		start,
		end,
		value: amount,
		accn,
		fy: fy.and_then(Value::as_f64),
		form,
		filed,
		year,
	})
}
struct Selection {
	end: String,
	figure: Option<SecAnnualFigure>,
	currencies: Vec<String>,
}
fn latest_for_concept(gaap: &Object, concept: &str, unit: SecFigureUnit) -> Option<Selection> {
	let raw = gaap.get(concept)?;
	if field(raw, "label").is_some_and(|v| !v.is_null() && v.as_str().is_none()) {
		return None;
	}
	let units = field(raw, "units")?.as_object()?;
	if units.values().any(|v| v.as_array().is_none()) {
		return None;
	}
	let mut candidates = Vec::new();
	for (key, values) in units.iter() {
		let currency = match unit {
			SecFigureUnit::Currency => key,
			SecFigureUnit::CurrencyPerShare => key.strip_suffix("/shares").unwrap_or(""),
		};
		if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
			continue;
		}
		let fact = values
			.as_array()?
			.iter()
			.filter_map(annual_fact)
			.min_by(|a, b| {
				b.end
					.cmp(a.end)
					.then_with(|| b.filed.cmp(a.filed))
					.then_with(|| b.accn.cmp(a.accn))
			});
		if let Some(fact) = fact {
			candidates.push((currency, fact));
		}
	}
	let end = candidates
		.iter()
		.map(|(_, fact)| fact.end)
		.max()?
		.to_owned();
	candidates.retain(|(_, fact)| fact.end == end);
	if candidates.len() > 1 {
		let mut currencies: Vec<_> = candidates.into_iter().map(|(c, _)| c.to_owned()).collect();
		currencies.sort();
		return Some(Selection {
			end,
			figure: None,
			currencies,
		});
	}
	let (currency, fact) = candidates.pop()?;
	Some(Selection {
		end,
		figure: Some(SecAnnualFigure {
			concept: format!("us-gaap:{concept}"),
			amount: fact.value,
			unit,
			currency: currency.to_owned(),
			period: ReportingPeriod {
				fiscal_year: fact.year,
				fiscal_period: FiscalPeriod::Fy,
				period_start: fact.start.to_owned(),
				period_end: fact.end.to_owned(),
			},
			filing_fiscal_year: fact.fy,
			accounting_standard: AccountingStandard::UsGaap,
			form: fact.form.to_owned(),
			accession_number: fact.accn.to_owned(),
			filed_at: fact.filed.to_owned(),
		}),
		currencies: Vec::new(),
	})
}
fn figure(selection: Option<Selection>, what: &str) -> FigureResult {
	match selection {
		None => Err(Unavailable {
			reason: format!(
				"SEC company facts contain no annual (10-K, full fiscal year) {what} for this issuer"
			),
		}),
		Some(Selection {
			figure: Some(figure),
			..
		}) => Ok(figure),
		Some(selection) => Err(Unavailable {
			reason: format!(
				"SEC company facts report {what} for the period ending {} in more than one currency ({}); no figure is chosen between them",
				selection.end,
				selection.currencies.join(", ")
			),
		}),
	}
}
fn derive_margin(
	revenue: &FigureResult,
	income: &FigureResult,
) -> Result<NetProfitMargin, Unavailable> {
	let (Ok(revenue), Ok(income)) = (revenue, income) else {
		return Err(Unavailable {
			reason: "net profit margin needs both revenue and net income; one is unavailable"
				.to_owned(),
		});
	};
	let to_income = |f: &SecAnnualFigure| IncomeFigure {
		amount: Money {
			amount: f.amount,
			currency: f.currency.clone(),
		},
		period: f.period.clone(),
		accounting_standard: f.accounting_standard,
		continuing_operations_policy: ContinuingOperationsPolicy::Total,
	};
	match compute_net_profit_margin(&to_income(income), &to_income(revenue)) {
		Ok(margin) => Ok(margin),
		Err(error) => {
			let reason = match error {
				NetMarginError::NonFinite => "a reported figure is not a finite number",
				NetMarginError::NonPositiveRevenue => {
					"reported revenue is zero or negative, so a margin is not meaningful"
				}
				NetMarginError::CurrencyMismatch => {
					"revenue and net income are reported in different currencies"
				}
				NetMarginError::PeriodMismatch => {
					"revenue and net income are not reported for the same fiscal period"
				}
				NetMarginError::AccountingStandardMismatch => {
					"revenue and net income use different accounting standards"
				}
				NetMarginError::ContinuingOperationsPolicyMismatch => {
					"revenue and net income use different continuing-operations bases"
				}
			};
			let describe = |f: &SecAnnualFigure| {
				format!(
					"FY{} {} to {}",
					to_js_string(f.period.fiscal_year),
					f.period.period_start,
					f.period.period_end
				)
			};
			let periods = if error == NetMarginError::PeriodMismatch {
				format!(
					" (revenue: {}; net income: {})",
					describe(revenue),
					describe(income)
				)
			} else {
				String::new()
			};
			Err(Unavailable {
				reason: format!("{reason}{periods}; margin not computed"),
			})
		}
	}
}
/// Selects each metric independently; tie precedence and restatement recency match TypeScript.
/// Accession recency uses byte order (the accepted arbitrary-accession collation deviation).
pub fn select_annual_financials(value: &Value) -> Result<SelectedFinancials, SecError> {
	let facts = field(value, "facts")
		.and_then(Value::as_object)
		.ok_or_else(|| unexpected("SEC company facts have an unexpected shape"))?;
	if field(value, "entityName").is_some_and(|v| v.as_str().is_none()) {
		return Err(unexpected("SEC company facts have an unexpected shape"));
	}
	let Some(gaap) = facts.get("us-gaap").and_then(Value::as_object) else {
		let no = || {
			Unavailable { reason: "SEC company facts contain no us-gaap taxonomy for this issuer (it may report under IFRS)".to_owned() }
		};
		return Ok(SelectedFinancials {
			revenue: Err(no()),
			net_income: Err(no()),
			eps_diluted: Err(no()),
			net_profit_margin: Err(no()),
		});
	};
	let mut best: Option<Selection> = None;
	for concept in REVENUE_CONCEPT_PRECEDENCE {
		if let Some(selection) = latest_for_concept(gaap, concept, SecFigureUnit::Currency) {
			if best.as_ref().is_none_or(|b| selection.end > b.end) {
				best = Some(selection);
			}
		}
	}
	let revenue = figure(best, "revenue");
	let net_income = figure(
		latest_for_concept(gaap, "NetIncomeLoss", SecFigureUnit::Currency),
		"net income (us-gaap:NetIncomeLoss)",
	);
	let eps_diluted = figure(
		latest_for_concept(
			gaap,
			"EarningsPerShareDiluted",
			SecFigureUnit::CurrencyPerShare,
		),
		"diluted EPS (us-gaap:EarningsPerShareDiluted)",
	);
	let net_profit_margin = derive_margin(&revenue, &net_income);
	Ok(SelectedFinancials {
		revenue,
		net_income,
		eps_diluted,
		net_profit_margin,
	})
}
/// Financials port consumed by SEC tools.
#[async_trait]
pub trait SecFinancialsSource: Send + Sync {
	/// Latest eligible annual figures for a ticker.
	async fn latest_annual_financials(
		&self,
		ticker: &str,
		cancel: Option<&CancellationToken>,
	) -> Result<SecCompanyFinancials, SecError>;
}
/// Company-facts documents of large filers run to tens of megabytes.
pub const COMPANY_FACTS_MAX_BYTES: usize = 48_000_000;
/// The ticker directory is fetched at most once per this many milliseconds.
const TICKER_DIRECTORY_TTL_MS: i64 = 43_200_000;
/// Byte cap of the ticker directory download.
const TICKER_DIRECTORY_MAX_BYTES: usize = 8_000_000;

struct DirectoryCache {
	issuers: IndexMap<String, SecIssuer>,
	url: String,
	expires: i64,
}
/// The outcome of one directory download, shared by everyone who waited for it.
type DirectoryOutcome = Result<Arc<DirectoryCache>, SecError>;
/// What one download attempt came to: its outcome, or `Refused` when the
/// pacing gate of the caller that started it said no before any request.
#[derive(Clone)]
enum Flight {
	Refused,
	Settled(DirectoryOutcome),
}
/// The download in progress (`inFlight`): its shared outcome, its own
/// cancellation (cancelled only when every waiter has left) and its waiters.
struct InFlight {
	id: u64,
	outcome: Shared<BoxFuture<'static, Flight>>,
	cancel: CancellationToken,
	waiters: usize,
}
#[derive(Default)]
struct DirectoryState {
	cached: Option<Arc<DirectoryCache>>,
	in_flight: Option<InFlight>,
	next_id: u64,
}

/// SEC's ticker list, cached twelve hours (`createSecTickerDirectory`):
/// shared by the research tool's financials and the financial sync (ADR-0048).
pub struct SecTickerDirectory {
	client: Arc<dyn SecClient>,
	clock: Arc<dyn Clock>,
	state: Arc<std::sync::Mutex<DirectoryState>>,
}

/// One lookup's answer: the issuer (`None` when SEC's list does not name the
/// ticker) and the URL the list was read from.
#[derive(Clone, Debug)]
pub struct TickerLookup {
	/// The issuer, if listed.
	pub issuer: Option<SecIssuer>,
	/// Retrieved directory URL.
	pub url: String,
}

impl SecTickerDirectory {
	/// An empty cache over `client` (its fair-access pacing applies).
	pub fn new(client: Arc<dyn SecClient>, clock: Arc<dyn Clock>) -> Self {
		Self {
			client,
			clock,
			state: Arc::new(std::sync::Mutex::new(DirectoryState::default())),
		}
	}

	/// The issuer listed under `ticker`. The list is fetched at most once per
	/// 12 hours, and concurrent misses share one download; `before_request`
	/// (a pacing gate) is asked only when this caller starts that download,
	/// and a refusal stops the lookup without a request.
	///
	/// # Errors
	/// The SEC client's error, or the cancelled error after a refusal or
	/// when `cancel` fires while waiting.
	pub async fn lookup(
		&self,
		ticker: &str,
		cancel: Option<&CancellationToken>,
		before_request: Option<&dyn BeforeRequest>,
	) -> Result<TickerLookup, SecError> {
		let directory = self.directory(cancel, before_request).await?;
		Ok(TickerLookup {
			issuer: directory
				.issuers
				.get(&normalize_ticker_key(ticker))
				.cloned(),
			url: directory.url.clone(),
		})
	}

	/// The starter's admission, then (if granted) the download under its own
	/// cancellation, caching a success for twelve hours. A dropped sender
	/// means the starter left before its gate answered: nothing is sent.
	fn attempt(
		&self,
		admitted: tokio::sync::oneshot::Receiver<bool>,
		cancel: CancellationToken,
	) -> BoxFuture<'static, Flight> {
		let client = Arc::clone(&self.client);
		let clock = Arc::clone(&self.clock);
		let state = Arc::clone(&self.state);
		async move {
			if !admitted.await.unwrap_or(false) {
				return Flight::Refused;
			}
			Flight::Settled(download(client, clock, state, cancel).await)
		}
		.boxed()
	}

	/// The directory changes rarely; one copy per 12 hours keeps us off
	/// SEC's servers (`tickerDirectory`). Single-flight: concurrent misses
	/// share one download and its outcome, a failure included; the slot is
	/// cleared when it settles, so a later call downloads again. A caller
	/// cancelled while waiting stops at once without cancelling the download
	/// for the others; the last one to leave cancels it.
	///
	/// Pacing: only the caller that STARTS a download asks its gate, because
	/// only one request is sent and a pacing grant stands for one request; a
	/// caller that joins a download in progress consumes no grant (and counts
	/// no request). If the starter's gate refuses (its job stopped), that
	/// refusal is the starter's alone: it gets the cancelled error, while the
	/// joiners, whose own jobs did not stop, try again, one of them starting
	/// a fresh download through its own gate.
	async fn directory(
		&self,
		cancel: Option<&CancellationToken>,
		before_request: Option<&dyn BeforeRequest>,
	) -> DirectoryOutcome {
		loop {
			let (id, outcome, admission) = {
				let mut state = self
					.state
					.lock()
					.map_err(|_| unexpected("SEC ticker directory has an unexpected shape"))?;
				if let Some(cached) = state
					.cached
					.as_ref()
					.filter(|c| c.expires > self.clock.now_ms())
				{
					return Ok(Arc::clone(cached));
				}
				if cancel.is_some_and(CancellationToken::is_cancelled) {
					return Err(cancelled_error());
				}
				let mut admission = None;
				if state.in_flight.is_none() {
					let token = CancellationToken::new();
					let (admit, admitted) = tokio::sync::oneshot::channel();
					let id = state.next_id;
					state.next_id = state.next_id.wrapping_add(1);
					state.in_flight = Some(InFlight {
						id,
						outcome: self.attempt(admitted, token.clone()).shared(),
						cancel: token,
						waiters: 0,
					});
					admission = Some(admit);
				}
				let Some(in_flight) = state.in_flight.as_mut() else {
					return Err(unexpected("SEC ticker directory has an unexpected shape"));
				};
				in_flight.waiters += 1;
				(in_flight.id, in_flight.outcome.clone(), admission)
			};
			let starter = admission.is_some();
			if let Some(admit) = admission {
				let admitted = match (before_request, cancel) {
					(None, _) => true,
					(Some(gate), None) => gate.before_request().await,
					(Some(gate), Some(token)) => tokio::select! {
						biased;
						() = token.cancelled() => false,
						admitted = gate.before_request() => admitted,
					},
				};
				// Err only when the receiver is gone, i.e. the flight was
				// already dropped: nobody is left to tell.
				let _ = admit.send(admitted);
			}
			let result = match cancel {
				None => Some(outcome.await),
				Some(token) => tokio::select! {
					biased;
					result = outcome => Some(result),
					() = token.cancelled() => None,
				},
			};
			if let Ok(mut state) = self.state.lock()
				&& let Some(in_flight) = state.in_flight.as_mut()
				&& in_flight.id == id
			{
				in_flight.waiters = in_flight.waiters.saturating_sub(1);
				// Settled: clear the slot. Abandoned by its last waiter: cancel it.
				if result.is_some() || in_flight.waiters == 0 {
					if result.is_none() {
						in_flight.cancel.cancel();
					}
					state.in_flight = None;
				}
			}
			match result {
				Some(Flight::Settled(outcome)) => return outcome,
				// Another caller's gate refused; ours has not been asked yet.
				Some(Flight::Refused) if !starter => {}
				Some(Flight::Refused) | None => return Err(cancelled_error()),
			}
		}
	}
}

/// Downloads and parses the directory, caching a success for twelve hours.
async fn download(
	client: Arc<dyn SecClient>,
	clock: Arc<dyn Clock>,
	state: Arc<std::sync::Mutex<DirectoryState>>,
	cancel: CancellationToken,
) -> DirectoryOutcome {
	let doc = client
		.fetch_document(
			SEC_TICKER_DIRECTORY_URL,
			SecRequest {
				max_bytes: TICKER_DIRECTORY_MAX_BYTES,
				accept: "application/json",
				cancel: Some(&cancel),
			},
		)
		.await?;
	let url = doc.url.clone();
	// An 8 MB directory: parse off the tokio worker.
	let issuers =
		crate::cpu::offload(move || parse_ticker_directory(&parse_sec_json(&doc)?)).await?;
	let cache = Arc::new(DirectoryCache {
		issuers,
		url,
		expires: clock.now_ms().saturating_add(TICKER_DIRECTORY_TTL_MS),
	});
	if let Ok(mut state) = state.lock() {
		state.cached = Some(Arc::clone(&cache));
	}
	Ok(cache)
}

/// SEC company-facts adapter with a process-local directory cache.
pub struct EdgarFinancialsSource {
	client: Arc<dyn SecClient>,
	directory: SecTickerDirectory,
}
impl EdgarFinancialsSource {
	/// Constructs a source sharing SEC fair-access pacing.
	pub fn new(client: Arc<dyn SecClient>, clock: Arc<dyn Clock>) -> Self {
		Self {
			directory: SecTickerDirectory::new(Arc::clone(&client), clock),
			client,
		}
	}
}
#[async_trait]
impl SecFinancialsSource for EdgarFinancialsSource {
	async fn latest_annual_financials(
		&self,
		ticker: &str,
		cancel: Option<&CancellationToken>,
	) -> Result<SecCompanyFinancials, SecError> {
		let found = self.directory.lookup(ticker, cancel, None).await?;
		let issuer = found.issuer.ok_or_else(|| {
			SecError::new(
				SecErrorCode::NotFound,
				"ticker is not in SEC's ticker directory",
			)
		})?;
		let doc = self
			.client
			.fetch_document(
				&sec_company_facts_url(&issuer.cik),
				SecRequest {
					max_bytes: COMPANY_FACTS_MAX_BYTES,
					accept: "application/json",
					cancel,
				},
			)
			.await?;
		let company_facts_url = doc.url.clone();
		// Up to 48 MB of JSON: parse and select off the tokio worker.
		let selected =
			crate::cpu::offload(move || select_annual_financials(&parse_sec_json(&doc)?)).await?;
		Ok(SecCompanyFinancials {
			issuer,
			selected,
			ticker_directory_url: found.url,
			company_facts_url,
		})
	}
}
