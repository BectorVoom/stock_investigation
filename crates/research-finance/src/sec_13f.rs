//! SEC 13F-HR reported holdings. DATA-007: changes are not transaction dates.
use std::{collections::BTreeSet,sync::Arc};
use async_trait::async_trait;
use indexmap::{IndexMap,IndexSet};
use research_js::{json::Value,whitespace::trim,string_number::string_to_number};
use research_feed::xml_tree::{as_node,first_node_of,children_of,text_of};
use research_domain::finance::filings::{ReportedPositionChange,classify_reported_position_change};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use crate::{sec_client::*,market_fetch::{field,text,array}};
/// The SEC form supported by this source.
pub const FORM_13F_HR: &str = "13F-HR";
/// Filing date at which the SEC changed to whole-dollar values.
pub const FORM_13F_WHOLE_DOLLAR_FROM: &str = "2023-01-03";
/// One eligible recent filing.
#[derive(Clone,Debug,Serialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub struct FilingRef {
	/// SEC accession.
	pub accession_number: String,
	/// Quarter end.
	pub report_period_end: String,
	/// Submission date.
	pub filed_at: String,
}
/// Recent filing selection.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct RecentFilings {
	/// Trimmed manager name.
	pub manager_name: String,
	/// Two latest distinct quarters.
	pub filings: Vec<FilingRef>,
}
/// One aggregate before converting the filing's value unit.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ParsedHolding {
	/// First issuer name for this CUSIP.
	pub issuer_name: String,
	/// Upper-case CUSIP.
	pub cusip: String,
	/// Total reported shares.
	pub reported_shares: f64,
	/// Total value in the filing's units.
	pub value_as_filed: f64,
}
/// Parsed information table; incomplete CUSIPs have no holding.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ParsedInformationTable {
	/// Complete holdings in first-seen CUSIP order.
	pub holdings: Vec<ParsedHolding>,
	/// Options and principal amounts.
	pub excluded_row_count: u64,
	/// Rows that could not be read.
	pub unreadable_row_count: u64,
	/// Sorted incomplete CUSIPs.
	pub incomplete_cusips: Vec<String>,
}
/// One complete reported share position.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Reported13FHolding {
	/// Issuer name.
	pub issuer_name: String,
	/// CUSIP.
	pub cusip: String,
	/// Reported shares.
	pub reported_shares: f64,
	/// Whole US dollars.
	pub reported_value_usd: f64,
}
/// Retrieved filing and completeness information.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Sec13FFiling {
	/// Accession and quarter.
	#[serde(flatten)]
	pub filing: FilingRef,
	/// Always 13F-HR.
	pub form: String,
	/// Retrieved complete submission URL.
	pub filing_url: String,
	/// Complete holdings by value descending, CUSIP ascending.
	pub holdings: Vec<Reported13FHolding>,
	/// Original value unit.
	pub value_unit_as_filed: String,
	/// Excluded options/principal rows.
	pub excluded_row_count: u64,
	/// Unreadable rows.
	pub unreadable_row_count: u64,
	/// Incomplete CUSIPs.
	pub incomplete_cusips: Vec<String>,
}
/// Quarter-over-quarter reported share change (DATA-007).
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ReportedPositionComparison {
	/// CUSIP.
	pub cusip: String,
	/// Current, then previous issuer name.
	pub issuer_name: String,
	/// Previous reported shares, absent when not reported.
	pub previous_reported_shares: Option<f64>,
	/// Current reported shares.
	pub current_reported_shares: Option<f64>,
	/// Domain classification.
	pub change: ReportedPositionChange,
}
/// Manager identity resolved from submissions.
#[derive(Clone,Debug,Serialize)]
pub struct Manager {
	/// Normalized CIK.
	pub cik: String,
	/// SEC name.
	pub name: String,
}
/// Complete source result.
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Sec13FReport {
	/// Filer.
	pub manager: Manager,
	/// Retrieved submissions URL.
	pub submissions_url: String,
	/// Latest report.
	pub current: Sec13FFiling,
	/// Prior quarter, if found.
	pub previous: Option<Sec13FFiling>,
	/// Changes, empty when comparison is unavailable.
	pub changes: Vec<ReportedPositionComparison>,
	/// Explicit completeness obstacle (DATA-011).
	pub comparison_unavailable_reason: Option<String>,
}
/// Submissions API URL.
pub fn sec_submissions_url(cik: &str) -> String { format!("https://data.sec.gov/submissions/CIK{cik}.json") }
/// Complete filing URL, with numeric CIK and dashless accession directory.
pub fn sec_filing_text_url(cik: &str,accession: &str) -> String {
	format!("https://www.sec.gov/Archives/edgar/data/{}/{}/{accession}.txt",research_js::number::to_js_string(string_to_number(cik)),accession.replace('-',""))
}
fn unexpected(detail: &str) -> SecError { SecError::new(SecErrorCode::UnexpectedResponse,detail) }
pub(crate) fn iso_date(text: &str) -> bool {
	research_contracts::patterns::is_iso_date(text)
}
/// Selects the two newest non-amendment filings with distinct report periods.
pub fn select_recent_13f_filings(json: &Value) -> Result<RecentFilings,SecError> {
	let invalid = || unexpected("SEC submissions have an unexpected shape");
	let name = text(json,"name").filter(|s| !s.is_empty()).ok_or_else(invalid)?;
	let recent = field(json,"filings").and_then(|v| field(v,"recent")).ok_or_else(invalid)?;
	let acc = array(recent,"accessionNumber").ok_or_else(invalid)?;
	let filed = array(recent,"filingDate").ok_or_else(invalid)?;
	let report = array(recent,"reportDate").ok_or_else(invalid)?;
	let forms = array(recent,"form").ok_or_else(invalid)?;
	if [acc,filed,report,forms].iter().any(|rows| !rows.iter().all(|v| v.as_str().is_some())) { return Err(invalid()); }
	let mut candidates = Vec::new();
	for (i,form) in forms.iter().enumerate() {
		if form.as_str()!=Some(FORM_13F_HR) { continue; }
		let Some(accession) = acc.get(i).and_then(Value::as_str).filter(|s| {
			let parts: Vec<_> = s.split('-').collect();
			parts.len()==3 && parts.iter().zip([10,2,6]).all(|(p,len)| p.len()==len && p.bytes().all(|b| b.is_ascii_digit()))
		}) else { continue; };
		let Some(filed) = filed.get(i).and_then(Value::as_str).filter(|s| iso_date(s)) else { continue; };
		let Some(report) = report.get(i).and_then(Value::as_str).filter(|s| iso_date(s)) else { continue; };
		candidates.push(FilingRef { accession_number: accession.to_owned(),filed_at: filed.to_owned(),report_period_end: report.to_owned() });
	}
	candidates.sort_by(|a,b| b.report_period_end.cmp(&a.report_period_end).then_with(|| b.filed_at.cmp(&a.filed_at)).then_with(|| b.accession_number.cmp(&a.accession_number)));
	let mut seen = BTreeSet::new();
	let filings = candidates.into_iter().filter(|c| seen.insert(c.report_period_end.clone())).take(2).collect();
	Ok(RecentFilings { manager_name: trim(name).to_owned(),filings })
}
/// Extracts only the first INFORMATION TABLE document, using the exact EDGAR markers.
pub fn extract_information_table_xml(submission: &str) -> Option<String> {
	for segment in submission.split("<DOCUMENT>").skip(1) {
		let kind = segment.split_once("<TYPE>").map(|(_,s)| s.split(['\r','\n','<']).next().unwrap_or(""));
		if !kind.is_some_and(|s| trim(s).to_uppercase()=="INFORMATION TABLE") { continue; }
		let start = segment.find("<XML>")?; let end = segment.find("</XML>")?;
		if end<=start { return None; }
		return segment.get(start+5..end).map(|s| trim(s).to_owned());
	}
	None
}
fn numeric(text: &str) -> bool {
	let mut parts = text.split('.');
	let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
	parts.next().is_some_and(digits) && parts.next().is_none_or(digits) && parts.next().is_none()
}
/// Parses fast-xml-parser-compatible 13F XML and aggregates only complete share positions.
pub fn parse_information_table(xml: &str) -> Result<ParsedInformationTable,SecError> {
	let malformed = || unexpected("13F information table is not the expected XML");
	let document = crate::sec_xml::parse(xml).ok_or_else(malformed)?;
	let table = first_node_of(&document,&["informationTable"]).ok_or_else(malformed)?;
	let mut by_cusip: IndexMap<String,ParsedHolding> = IndexMap::new();
	let mut incomplete = BTreeSet::new(); let mut excluded_row_count = 0; let mut unreadable_row_count = 0;
	for row in children_of(table,&["infoTable"]) {
		let Some(row) = as_node(row) else { unreadable_row_count += 1; continue; };
		let Some(cusip) = text_of(row.get("cusip"),400).filter(|s| s.len()==9 && s.bytes().all(|b| b.is_ascii_alphanumeric())).map(|s| s.to_uppercase()) else { unreadable_row_count += 1; continue; };
		let amount = first_node_of(row,&["shrsOrPrnAmt"]);
		let kind = amount.and_then(|a| text_of(a.get("sshPrnamtType"),400)).map(|s| s.to_uppercase());
		if text_of(row.get("putCall"),400).is_some() || kind.as_deref()==Some("PRN") { excluded_row_count += 1; continue; }
		let name = text_of(row.get("nameOfIssuer"),400).filter(|s| s.chars().count()<=300);
		let value = text_of(row.get("value"),400).filter(|s| numeric(s));
		let shares = amount.and_then(|a| text_of(a.get("sshPrnamt"),400)).filter(|s| numeric(s));
		if kind.as_deref()!=Some("SH") || name.is_none() || value.is_none() || shares.is_none() {
			unreadable_row_count += 1; incomplete.insert(cusip); continue;
		}
		let value_as_filed = string_to_number(value.as_deref().unwrap_or(""));
		let reported_shares = string_to_number(shares.as_deref().unwrap_or(""));
		if let Some(existing) = by_cusip.get_mut(&cusip) { existing.value_as_filed += value_as_filed; existing.reported_shares += reported_shares; }
		else { by_cusip.insert(cusip.clone(),ParsedHolding { issuer_name: name.unwrap_or_default(),cusip,reported_shares,value_as_filed }); }
	}
	Ok(ParsedInformationTable { holdings: by_cusip.into_values().filter(|h| !incomplete.contains(&h.cusip)).collect(),excluded_row_count,unreadable_row_count,incomplete_cusips: incomplete.into_iter().collect() })
}
/// Compares reported positions in current CUSIP order, then previous-only CUSIPs.
pub fn compare_reported_positions(previous: &[Reported13FHolding],current: &[Reported13FHolding]) -> Vec<ReportedPositionComparison> {
	let before: IndexMap<_,_> = previous.iter().map(|h| (h.cusip.as_str(),h)).collect();
	let after: IndexMap<_,_> = current.iter().map(|h| (h.cusip.as_str(),h)).collect();
	let cusips: IndexSet<_> = after.keys().chain(before.keys()).copied().collect();
	cusips.into_iter().map(|cusip| {
		let previous = before.get(cusip); let current = after.get(cusip);
		let previous_reported_shares = previous.map(|h| h.reported_shares); let current_reported_shares = current.map(|h| h.reported_shares);
		ReportedPositionComparison { cusip: cusip.to_owned(),issuer_name: current.or(previous).map_or(cusip,|h| h.issuer_name.as_str()).to_owned(),previous_reported_shares,current_reported_shares,change: classify_reported_position_change(previous_reported_shares,current_reported_shares) }
	}).collect()
}
fn to_filing(filing: FilingRef,url: String,table: ParsedInformationTable) -> Sec13FFiling {
	let dollars = filing.filed_at.as_str()>=FORM_13F_WHOLE_DOLLAR_FROM;
	let mut holdings: Vec<_> = table.holdings.into_iter().map(|h| Reported13FHolding { issuer_name: h.issuer_name,cusip: h.cusip,reported_shares: h.reported_shares,reported_value_usd: h.value_as_filed*if dollars { 1.0 } else { 1000.0 } }).collect();
	holdings.sort_by(|a,b| { let difference = b.reported_value_usd-a.reported_value_usd; if difference.is_nan() || difference==0.0 { a.cusip.cmp(&b.cusip) } else if difference<0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater } });
	Sec13FFiling { filing,form: FORM_13F_HR.to_owned(),filing_url: url,holdings,value_unit_as_filed: if dollars { "usd" } else { "usd-thousands" }.to_owned(),excluded_row_count: table.excluded_row_count,unreadable_row_count: table.unreadable_row_count,incomplete_cusips: table.incomplete_cusips }
}
fn obstacle(current: &Sec13FFiling,previous: Option<&Sec13FFiling>) -> Option<String> {
	let Some(previous) = previous else { return Some("no previous 13F-HR filing was found among this filer's recent SEC submissions".to_owned()); };
	let which: Vec<_> = [current,previous].into_iter().filter(|f| f.unreadable_row_count>0).map(|f| format!("{} row(s) of the filing for {} (accession {})",f.unreadable_row_count,f.filing.report_period_end,f.filing.accession_number)).collect();
	(!which.is_empty()).then(|| format!("{} could not be read, so its holdings are incomplete and no change in reported positions is stated",which.join(" and ")))
}
/// Holdings port consumed by research tools.
#[async_trait]
pub trait Sec13FSource: Send + Sync {
	/// Latest two reported quarters, fetched sequentially.
	async fn latest_holdings(&self,cik: &str,cancel: Option<&CancellationToken>) -> Result<Sec13FReport,SecError>;
}
/// SEC-backed implementation.
pub struct Edgar13FSource {
	/// Shared fair-access client.
	pub client: Arc<dyn SecClient>,
}
impl Edgar13FSource {
	async fn load(&self,cik: &str,filing: FilingRef,cancel: Option<&CancellationToken>) -> Result<Sec13FFiling,SecError> {
		let document = self.client.fetch_document(&sec_filing_text_url(cik,&filing.accession_number),SecRequest { max_bytes: 16_000_000,accept: "text/plain",cancel }).await?;
		let xml = extract_information_table_xml(&document.text).ok_or_else(|| unexpected("13F-HR submission contains no information table document"))?;
		Ok(to_filing(filing,document.url,parse_information_table(&xml)?))
	}
}
#[async_trait]
impl Sec13FSource for Edgar13FSource {
	async fn latest_holdings(&self,cik: &str,cancel: Option<&CancellationToken>) -> Result<Sec13FReport,SecError> {
		let cik = normalize_cik(cik).ok_or_else(|| SecError::new(SecErrorCode::InvalidIdentifier,"managerCik is not a CIK"))?;
		let submissions = self.client.fetch_document(&sec_submissions_url(&cik),SecRequest { max_bytes: 8_000_000,accept: "application/json",cancel }).await?;
		let recent = select_recent_13f_filings(&parse_sec_json(&submissions)?)?;
		let mut filings = recent.filings.into_iter();
		let latest = filings.next().ok_or_else(|| SecError::new(SecErrorCode::NoData,"no 13F-HR filing among this filer's recent SEC submissions"))?;
		let current = self.load(&cik,latest,cancel).await?;
		let previous = match filings.next() { Some(filing) => Some(self.load(&cik,filing,cancel).await?),None => None };
		let comparison_unavailable_reason = obstacle(&current,previous.as_ref());
		let changes = previous.as_ref().filter(|_| comparison_unavailable_reason.is_none()).map_or_else(Vec::new,|p| compare_reported_positions(&p.holdings,&current.holdings));
		Ok(Sec13FReport { manager: Manager { cik,name: recent.manager_name },submissions_url: submissions.url,current,previous,changes,comparison_unavailable_reason })
	}
}
