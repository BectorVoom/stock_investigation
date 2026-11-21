//! Stored stock retrieval contract, shared by both runners.
use crate::primitives::{CURRENCY, HTTPS_URL, ISO_DATE, ISO_DATE_TIME, SHORT_TEXT};
use crate::records::{AccountingStandard, ListingVerification, SourceClass};
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, array, boolean, decode_object, js_enum, nullable, number,
	optional, string,
};
use crate::{Contract, patterns};
use research_js::json::Value;
use serde::Serialize;

js_enum! {
	/// The corpus to search.
	pub enum StockResearchKind { Company = "company", Financials = "financials", News = "news" }
}

js_enum! {
	/// Japanese exchange venue (`stockResearchJpExchangeSchema`).
	pub enum StockResearchJpExchange { Tse = "TSE", Nse = "NSE", Fse = "FSE", Sse = "SSE" }
}

fn bounded_words(text: &str) -> bool {
	text.split(research_js::whitespace::is_js_whitespace)
		.filter(|part| !part.is_empty())
		.count()
		<= 8
}
const QUERY: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(128),
	StrCheck::Refine(bounded_words, "Use at most eight search terms."),
];
const TICKER: &[StrCheck] = &[StrCheck::Regex(&patterns::TICKER, None)];
const YEAR: &[NumCheck] = &[NumCheck::Int, NumCheck::Gte(1990.0), NumCheck::Lte(2100.0)];

fn limit(cx: &mut Cx, input: Option<&Value>) -> Option<f64> {
	if input.is_none() {
		return Some(6.0);
	}
	number(&[NumCheck::Int, NumCheck::Gte(1.0), NumCheck::Lte(12.0)])(cx, input)
}

fn jp_financials_field(
	cx: &mut Cx,
	input: Option<&Value>,
) -> Option<Vec<StockResearchJpFinancials>> {
	if input.is_none() {
		return Some(Vec::new());
	}
	array(StockResearchJpFinancials::decode, &[ArrCheck::Max(12)])(cx, input)
}

/// Validated agent arguments. The lease is injected by the host, never by the model.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchQuery {
	/// All terms must match one passage.
	pub query: String,
	/// None searches all three corpora.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub kind: Option<StockResearchKind>,
	/// Maximum results, 1..12.
	pub limit: f64,
}
impl StockResearchQuery {
	/// Exact argument boundary.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			query: "query" => string(QUERY),
			kind: "kind" => optional(StockResearchKind::decode),
			limit: "limit" => limit,
		})
	}
}
/// Server-provided passage and lineage.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchHit {
	/// Corpus.
	pub kind: StockResearchKind,
	/// Stable stored record reference.
	pub record_id: String,
	/// Stored title.
	pub title: String,
	/// Bounded passage.
	pub text: String,
	/// None is context only.
	pub source_url: Option<String>,
	/// Publisher.
	pub publisher: String,
	/// Publication date.
	pub published_at: Option<String>,
	/// Stored retrieval date.
	pub retrieved_at: String,
	/// Financial period or as-of date.
	pub effective_at: Option<String>,
	/// Evidence class.
	pub source_class: SourceClass,
	/// Whether excerpts may be retained.
	pub retain_quotes: bool,
	/// AI text is never promoted to primary evidence.
	pub ai_generated: bool,
}
impl StockResearchHit {
	/// Validates server data.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			kind: "kind" => StockResearchKind::decode,
			record_id: "recordId" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			title: "title" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			text: "text" => string(&[StrCheck::Min(1), StrCheck::Max(2400)]),
			source_url: "sourceUrl" => nullable(string(HTTPS_URL)),
			publisher: "publisher" => string(&[StrCheck::Min(1), StrCheck::Max(300)]),
			published_at: "publishedAt" => nullable(string(ISO_DATE_TIME)),
			retrieved_at: "retrievedAt" => string(ISO_DATE_TIME),
			effective_at: "effectiveAt" => nullable(string(ISO_DATE_TIME)),
			source_class: "sourceClass" => SourceClass::decode,
			retain_quotes: "retainQuotes" => boolean,
			ai_generated: "aiGenerated" => boolean,
		})
	}
}

/// One authoritative annual figure of a Japanese company from stored J-Quants statements.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchJpFigure {
	/// Numeric value in base currency units.
	pub value: f64,
	/// ISO 4217 currency code.
	pub currency: String,
	/// Accounting basis.
	pub accounting_standard: AccountingStandard,
	/// Reporting period start (`YYYY-MM-DD`).
	pub period_start: String,
	/// Reporting period end (`YYYY-MM-DD`).
	pub period_end: String,
	/// J-Quants summary URL.
	pub source_url: String,
	/// Filing date (`YYYY-MM-DD`).
	pub filed_on: String,
	/// Retrieval timestamp.
	pub retrieved_at: String,
	/// Mapped J-Quants concept.
	pub concept: String,
}
impl StockResearchJpFigure {
	/// Validates one structured Japanese financial figure.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			value: "value" => number(&[]),
			currency: "currency" => string(CURRENCY),
			accounting_standard: "accountingStandard" => AccountingStandard::decode,
			period_start: "periodStart" => string(ISO_DATE),
			period_end: "periodEnd" => string(ISO_DATE),
			source_url: "sourceUrl" => string(HTTPS_URL),
			filed_on: "filedOn" => string(ISO_DATE),
			retrieved_at: "retrievedAt" => string(ISO_DATE_TIME),
			concept: "concept" => string(&[StrCheck::Min(1), StrCheck::Max(120)]),
		})
	}
}

/// Structured annual financials for a matched Japanese company.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchJpFinancials {
	/// Stock code (e.g. `7014`).
	pub symbol: String,
	/// Issuer name.
	pub issuer_name: String,
	/// Japanese exchange venue.
	pub exchange: StockResearchJpExchange,
	/// Whether listing was verified against `stock_directory`.
	pub listing_verification: ListingVerification,
	/// Fiscal year (`1990..=2100`).
	pub fiscal_year: f64,
	/// Annual revenue figure, when available.
	pub revenue: Option<StockResearchJpFigure>,
	/// Why revenue is unavailable, when absent.
	pub revenue_unavailable_reason: Option<String>,
	/// Annual profit attributable to owners, when available.
	pub net_income: Option<StockResearchJpFigure>,
	/// Why net income is unavailable, when absent.
	pub net_income_unavailable_reason: Option<String>,
}
impl StockResearchJpFinancials {
	/// Validates structured Japanese company financials.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			symbol: "symbol" => string(TICKER),
			issuer_name: "issuerName" => string(SHORT_TEXT),
			exchange: "exchange" => StockResearchJpExchange::decode,
			listing_verification: "listingVerification" => ListingVerification::decode,
			fiscal_year: "fiscalYear" => number(YEAR),
			revenue: "revenue" => nullable(StockResearchJpFigure::decode),
			revenue_unavailable_reason: "revenueUnavailableReason" => nullable(string(&[StrCheck::Min(1), StrCheck::Max(300)])),
			net_income: "netIncome" => nullable(StockResearchJpFigure::decode),
			net_income_unavailable_reason: "netIncomeUnavailableReason" => nullable(string(&[StrCheck::Min(1), StrCheck::Max(300)])),
		})
	}
}

/// The bounded search response.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockResearchResponse {
	/// Passages in corpus-interleaved order.
	pub hits: Vec<StockResearchHit>,
	/// Narrow the query when true.
	pub truncated: bool,
	/// Structured Japanese financials for matched JP financial hits.
	pub jp_financials: Vec<StockResearchJpFinancials>,
}
impl crate::Contract for StockResearchResponse {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			hits: "hits" => array(StockResearchHit::decode, &[ArrCheck::Max(12)]),
			truncated: "truncated" => boolean,
			jp_financials: "jpFinancials" => jp_financials_field,
		})
	}
}
impl crate::Contract for StockResearchQuery {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		Self::decode(cx, input)
	}
}
