//! Annual SEC company-facts selection with explicit missing/currency/period semantics (DATA-005).
use std::sync::Arc;
use async_trait::async_trait;
use indexmap::IndexMap;
use research_application::ports::Clock;
use research_domain::finance::{types::{ReportingPeriod,FiscalPeriod,AccountingStandard,Money},net_margin::{IncomeFigure,ContinuingOperationsPolicy,compute_net_profit_margin,NetMarginError}};
use research_js::{json::{Value,Object},whitespace::trim,number::to_js_string};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use crate::{market_fetch::{field,text,array},sec_client::*};
/// SEC ticker directory, cached twelve hours.
pub const SEC_TICKER_DIRECTORY_URL: &str = "https://www.sec.gov/files/company_tickers_exchange.json";
/// Revenue tie-breaking precedence.
pub const REVENUE_CONCEPT_PRECEDENCE: [&str;4] = ["Revenues","RevenueFromContractWithCustomerExcludingAssessedTax","RevenueFromContractWithCustomerIncludingAssessedTax","SalesRevenueNet"];
/// Company-facts API URL.
pub fn sec_company_facts_url(cik: &str) -> String { format!("https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json") }
/// Accepts dotted share classes as the SEC's hyphenated ticker.
pub fn normalize_ticker_key(ticker: &str) -> String { trim(ticker).to_uppercase().replace('.',"-") }
/// SEC issuer identity.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
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
#[derive(Clone,Copy,Debug,Serialize)]
pub enum SecFigureUnit {
	/// Currency amount.
	#[serde(rename="currency")] Currency,
	/// Currency per share.
	#[serde(rename="currency-per-share")] CurrencyPerShare,
}
/// One selected annual fact with filing lineage.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
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
#[derive(Clone,Debug,Serialize,thiserror::Error)]
#[error("{reason}")]
pub struct Unavailable {
	/// Fixed explanation.
	pub reason: String,
}
/// A selected annual figure or explicit absence.
pub type FigureResult = Result<SecAnnualFigure,Unavailable>;
/// Domain margin plus its constant wire fields.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Margin {
	/// Net income / revenue.
	pub margin_ratio: f64,
	/// Reporting currency.
	pub currency: String,
	/// Common reporting period.
	pub period: ReportingPeriod,
	/// Accounting basis.
	pub accounting_standard: AccountingStandard,
	/// Total income basis.
	pub continuing_operations_policy: String,
	/// Explicit formula.
	pub formula: String,
}
/// Independent annual selections and their derived margin.
#[derive(Clone,Debug)]
pub struct SelectedFinancials {
	/// Revenue.
	pub revenue: FigureResult,
	/// Net income.
	pub net_income: FigureResult,
	/// Diluted earnings per share.
	pub eps_diluted: FigureResult,
	/// Margin with honest failure semantics.
	pub net_profit_margin: Result<Margin,Unavailable>,
}
/// Company financials and the documents actually retrieved.
#[derive(Clone,Debug)]
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
fn unexpected(detail: &str) -> SecError { SecError::new(SecErrorCode::UnexpectedResponse,detail) }
/// Reads columns by name and keeps the first usable ticker occurrence.
pub fn parse_ticker_directory(value: &Value) -> Result<IndexMap<String,SecIssuer>,SecError> {
	let fields = array(value,"fields").filter(|a| a.iter().all(|v| v.as_str().is_some())).ok_or_else(|| unexpected("SEC ticker directory has an unexpected shape"))?;
	let rows = array(value,"data").filter(|a| a.iter().all(|v| v.as_array().is_some())).ok_or_else(|| unexpected("SEC ticker directory has an unexpected shape"))?;
	let columns = ["cik","name","ticker","exchange"].map(|key| fields.iter().position(|v| v.as_str()==Some(key)));
	let [Some(cik_at),Some(name_at),Some(ticker_at),Some(exchange_at)] = columns else { return Err(unexpected("SEC ticker directory is missing expected columns")); };
	let mut issuers = IndexMap::new();
	for row in rows.iter().filter_map(Value::as_array) {
		let Some(cik) = row.get(cik_at).and_then(Value::as_f64).filter(|v| v.is_finite() && *v>0.0 && v.fract()==0.0) else { continue; };
		let Some(name) = row.get(name_at).and_then(Value::as_str) else { continue; };
		let Some(ticker) = row.get(ticker_at).and_then(Value::as_str).filter(|s| !trim(s).is_empty()) else { continue; };
		let key = normalize_ticker_key(ticker);
		issuers.entry(key).or_insert_with(|| SecIssuer { cik: format!("{:0>10}",to_js_string(cik)),name: trim(name).to_owned(),ticker: trim(ticker).to_uppercase(),sec_exchange: row.get(exchange_at).and_then(Value::as_str).map(trim).filter(|s| !s.is_empty()).map(str::to_owned) });
	}
	if issuers.is_empty() { return Err(unexpected("SEC ticker directory contains no usable rows")); }
	Ok(issuers)
}
struct AnnualFact<'a> { start: &'a str,end: &'a str,value: f64,accn: &'a str,fy: Option<f64>,form: &'a str,filed: &'a str,year: f64 }
fn annual_fact(value: &Value) -> Option<AnnualFact<'_>> {
	let date = |key| text(value,key).filter(|s| crate::sec_13f::iso_date(s));
	let start = date("start")?; let end = date("end")?; let filed = date("filed")?;
	let amount = field(value,"val")?.as_f64().filter(|n| n.is_finite())?;
	let accn = text(value,"accn").filter(|s| (1..=40).contains(&s.chars().count()))?;
	let form = text(value,"form")?;
	if !matches!(form,"10-K"|"10-K/A") || text(value,"fp")!=Some("FY") { return None; }
	let fy = field(value,"fy");
	if fy.is_some_and(|v| !v.is_null() && !v.as_f64().is_some_and(|n| n.is_finite() && n.fract()==0.0 && n.abs()<=9_007_199_254_740_991.0)) { return None; }
	let start_date = chrono::NaiveDate::parse_from_str(start,"%Y-%m-%d").ok()?;
	let end_date = chrono::NaiveDate::parse_from_str(end,"%Y-%m-%d").ok()?;
	if !(350..=380).contains(&(end_date-start_date).num_days().saturating_add(1)) { return None; }
	let year: f64 = end.get(..4)?.parse().ok()?;
	if !(1990.0..=2100.0).contains(&year) { return None; }
	Some(AnnualFact { start,end,value: amount,accn,fy: fy.and_then(Value::as_f64),form,filed,year })
}
struct Selection { end: String,figure: Option<SecAnnualFigure>,currencies: Vec<String> }
fn latest_for_concept(gaap: &Object,concept: &str,unit: SecFigureUnit) -> Option<Selection> {
	let raw = gaap.get(concept)?;
	if field(raw,"label").is_some_and(|v| !v.is_null() && v.as_str().is_none()) { return None; }
	let units = field(raw,"units")?.as_object()?;
	if units.values().any(|v| v.as_array().is_none()) { return None; }
	let mut candidates = Vec::new();
	for (key,values) in units.iter() {
		let currency = match unit { SecFigureUnit::Currency => key,SecFigureUnit::CurrencyPerShare => key.strip_suffix("/shares").unwrap_or("") };
		if currency.len()!=3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) { continue; }
		let fact = values.as_array()?.iter().filter_map(annual_fact).min_by(|a,b| b.end.cmp(a.end).then_with(|| b.filed.cmp(a.filed)).then_with(|| b.accn.cmp(a.accn)));
		if let Some(fact) = fact { candidates.push((currency,fact)); }
	}
	let end = candidates.iter().map(|(_,fact)| fact.end).max()?.to_owned();
	candidates.retain(|(_,fact)| fact.end==end);
	if candidates.len()>1 { let mut currencies: Vec<_> = candidates.into_iter().map(|(c,_)| c.to_owned()).collect(); currencies.sort(); return Some(Selection { end,figure: None,currencies }); }
	let (currency,fact) = candidates.pop()?;
	Some(Selection { end,figure: Some(SecAnnualFigure { concept: format!("us-gaap:{concept}"),amount: fact.value,unit,currency: currency.to_owned(),period: ReportingPeriod { fiscal_year: fact.year,fiscal_period: FiscalPeriod::Fy,period_start: fact.start.to_owned(),period_end: fact.end.to_owned() },filing_fiscal_year: fact.fy,accounting_standard: AccountingStandard::UsGaap,form: fact.form.to_owned(),accession_number: fact.accn.to_owned(),filed_at: fact.filed.to_owned() }),currencies: Vec::new() })
}
fn figure(selection: Option<Selection>,what: &str) -> FigureResult {
	match selection {
		None => Err(Unavailable { reason: format!("SEC company facts contain no annual (10-K, full fiscal year) {what} for this issuer") }),
		Some(Selection { figure: Some(figure),.. }) => Ok(figure),
		Some(selection) => Err(Unavailable { reason: format!("SEC company facts report {what} for the period ending {} in more than one currency ({}); no figure is chosen between them",selection.end,selection.currencies.join(", ")) }),
	}
}
fn derive_margin(revenue: &FigureResult,income: &FigureResult) -> Result<Margin,Unavailable> {
	let (Ok(revenue),Ok(income)) = (revenue,income) else { return Err(Unavailable { reason: "net profit margin needs both revenue and net income; one is unavailable".to_owned() }); };
	let to_income = |f: &SecAnnualFigure| IncomeFigure { amount: Money { amount: f.amount,currency: f.currency.clone() },period: f.period.clone(),accounting_standard: f.accounting_standard,continuing_operations_policy: ContinuingOperationsPolicy::Total };
	match compute_net_profit_margin(&to_income(income),&to_income(revenue)) {
		Ok(m) => Ok(Margin { margin_ratio: m.margin_ratio,currency: m.currency,period: m.period,accounting_standard: m.accounting_standard,continuing_operations_policy: "total".to_owned(),formula: "net income / revenue".to_owned() }),
		Err(error) => {
			let reason = match error { NetMarginError::NonFinite => "a reported figure is not a finite number",NetMarginError::NonPositiveRevenue => "reported revenue is zero or negative, so a margin is not meaningful",NetMarginError::CurrencyMismatch => "revenue and net income are reported in different currencies",NetMarginError::PeriodMismatch => "revenue and net income are not reported for the same fiscal period",NetMarginError::AccountingStandardMismatch => "revenue and net income use different accounting standards",NetMarginError::ContinuingOperationsPolicyMismatch => "revenue and net income use different continuing-operations bases" };
			let describe = |f: &SecAnnualFigure| format!("FY{} {} to {}",to_js_string(f.period.fiscal_year),f.period.period_start,f.period.period_end);
			let periods = if error==NetMarginError::PeriodMismatch { format!(" (revenue: {}; net income: {})",describe(revenue),describe(income)) } else { String::new() };
			Err(Unavailable { reason: format!("{reason}{periods}; margin not computed") })
		}
	}
}
/// Selects each metric independently; tie precedence and restatement recency match TypeScript.
/// Accession recency uses byte order (the accepted arbitrary-accession collation deviation).
pub fn select_annual_financials(value: &Value) -> Result<SelectedFinancials,SecError> {
	let facts = field(value,"facts").and_then(Value::as_object).ok_or_else(|| unexpected("SEC company facts have an unexpected shape"))?;
	if field(value,"entityName").is_some_and(|v| v.as_str().is_none()) { return Err(unexpected("SEC company facts have an unexpected shape")); }
	let Some(gaap) = facts.get("us-gaap").and_then(Value::as_object) else {
		let no = || Unavailable { reason: "SEC company facts contain no us-gaap taxonomy for this issuer (it may report under IFRS)".to_owned() };
		return Ok(SelectedFinancials { revenue: Err(no()),net_income: Err(no()),eps_diluted: Err(no()),net_profit_margin: Err(no()) });
	};
	let mut best: Option<Selection> = None;
	for concept in REVENUE_CONCEPT_PRECEDENCE {
		if let Some(selection) = latest_for_concept(gaap,concept,SecFigureUnit::Currency) {
			if best.as_ref().is_none_or(|b| selection.end>b.end) { best = Some(selection); }
		}
	}
	let revenue = figure(best,"revenue");
	let net_income = figure(latest_for_concept(gaap,"NetIncomeLoss",SecFigureUnit::Currency),"net income (us-gaap:NetIncomeLoss)");
	let eps_diluted = figure(latest_for_concept(gaap,"EarningsPerShareDiluted",SecFigureUnit::CurrencyPerShare),"diluted EPS (us-gaap:EarningsPerShareDiluted)");
	let net_profit_margin = derive_margin(&revenue,&net_income);
	Ok(SelectedFinancials { revenue,net_income,eps_diluted,net_profit_margin })
}
/// Financials port consumed by SEC tools.
#[async_trait]
pub trait SecFinancialsSource: Send + Sync {
	/// Latest eligible annual figures for a ticker.
	async fn latest_annual_financials(&self,ticker: &str,cancel: Option<&CancellationToken>) -> Result<SecCompanyFinancials,SecError>;
}
struct DirectoryCache { issuers: IndexMap<String,SecIssuer>,url: String,expires: i64 }
/// SEC company-facts adapter with a process-local directory cache.
pub struct EdgarFinancialsSource { client: Arc<dyn SecClient>,clock: Arc<dyn Clock>,directory: tokio::sync::Mutex<Option<DirectoryCache>> }
impl EdgarFinancialsSource {
	/// Constructs a source sharing SEC fair-access pacing.
	pub fn new(client: Arc<dyn SecClient>,clock: Arc<dyn Clock>) -> Self { Self { client,clock,directory: tokio::sync::Mutex::new(None) } }
}
#[async_trait]
impl SecFinancialsSource for EdgarFinancialsSource {
	async fn latest_annual_financials(&self,ticker: &str,cancel: Option<&CancellationToken>) -> Result<SecCompanyFinancials,SecError> {
		let (issuer,directory_url) = {
			let mut cache = self.directory.lock().await;
			if !cache.as_ref().is_some_and(|c| c.expires>self.clock.now_ms()) {
				let doc = self.client.fetch_document(SEC_TICKER_DIRECTORY_URL,SecRequest { max_bytes: 8_000_000,accept: "application/json",cancel }).await?;
				*cache = Some(DirectoryCache { issuers: parse_ticker_directory(&parse_sec_json(&doc)?)?,url: doc.url,expires: self.clock.now_ms().saturating_add(43_200_000) });
			}
			let cached = cache.as_ref().ok_or_else(|| unexpected("SEC ticker directory has an unexpected shape"))?;
			let issuer = cached.issuers.get(&normalize_ticker_key(ticker)).ok_or_else(|| SecError::new(SecErrorCode::NotFound,"ticker is not in SEC's ticker directory"))?;
			(issuer.clone(),cached.url.clone())
		};
		let doc = self.client.fetch_document(&sec_company_facts_url(&issuer.cik),SecRequest { max_bytes: 48_000_000,accept: "application/json",cancel }).await?;
		let selected = select_annual_financials(&parse_sec_json(&doc)?)?;
		Ok(SecCompanyFinancials { issuer,selected,ticker_directory_url: directory_url,company_facts_url: doc.url })
	}
}
