//! Research records (`packages/contracts/src/records.ts`): articles,
//! evidence, claims, scenarios, securities, suppliers, financial and
//! position observations, investor filings, pricing power and datasets.

use research_js::json::Value;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

use crate::json::Record;
use crate::patterns;
use crate::primitives::{
	CURRENCY, HTTPS_URL, ISO_DATE, ISO_DATE_TIME, LONG_TEXT, Market, SHORT_TEXT, id,
};
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, UnionOption, array, decode_object, js_enum, literal,
	nullable, number, optional, record, refine, run_discriminated, run_string, run_union, string,
	uint,
};

/* ---------- News ---------- */

js_enum! {
	/// `licensePolicySchema`.
	pub enum LicensePolicy {
		HeadlineAndLinkOnly = "headline-and-link-only",
		ShortExcerptPermitted = "short-excerpt-permitted",
	}
}

const TITLE_300: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(300)];
const SHA256: &[StrCheck] = &[StrCheck::Regex(&patterns::SHA256_HEX, None)];
const MAX_500: &[StrCheck] = &[StrCheck::Max(500)];

/// `articleSchema` without `articleId` (`ingestedArticleSchema`): a feed item
/// the runner retrieved, before the Worker assigns ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestedArticle {
	/// Source id.
	pub source_id: String,
	/// Canonical https URL.
	pub canonical_url: String,
	/// Publisher (trimmed, 1..300).
	pub publisher: String,
	/// Title (1..300).
	pub title: String,
	/// Publication time, when known.
	pub published_at: Option<String>,
	/// Retrieval time.
	pub retrieved_at: String,
	/// SHA-256 hex fingerprint.
	pub content_fingerprint: String,
	/// Excerpt, only where the license permits one (≤ 500).
	pub excerpt: Option<String>,
}

impl IngestedArticle {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			source_id: "sourceId" => id,
			canonical_url: "canonicalUrl" => string(HTTPS_URL),
			publisher: "publisher" => string(SHORT_TEXT),
			title: "title" => string(TITLE_300),
			published_at: "publishedAt" => nullable(string(ISO_DATE_TIME)),
			retrieved_at: "retrievedAt" => string(ISO_DATE_TIME),
			content_fingerprint: "contentFingerprint" => string(SHA256),
			excerpt: "excerpt" => nullable(string(MAX_500)),
		})
	}
}

/* ---------- Evidence graph ---------- */

js_enum! {
	/// `sourceClassSchema`.
	pub enum SourceClass {
		News = "news",
		RegulatoryFiling = "regulatory-filing",
		OfficialStatistics = "official-statistics",
		CompanyDisclosure = "company-disclosure",
		MarketData = "market-data",
		Other = "other",
	}
}

/// `evidenceSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
	/// Evidence id.
	pub evidence_id: String,
	/// https source URL.
	pub source_url: String,
	/// Title (1..300).
	pub title: String,
	/// Publisher (trimmed, 1..300).
	pub publisher: String,
	/// Publication time.
	pub published_at: Option<String>,
	/// Retrieval time.
	pub retrieved_at: String,
	/// The as-of time the content describes.
	pub effective_at: Option<String>,
	/// Excerpt (≤ 500).
	pub excerpt: Option<String>,
	/// SHA-256 of the retrieved content.
	pub checksum: String,
	/// Source class.
	pub source_class: SourceClass,
}

impl Evidence {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			evidence_id: "evidenceId" => id,
			source_url: "sourceUrl" => string(HTTPS_URL),
			title: "title" => string(TITLE_300),
			publisher: "publisher" => string(SHORT_TEXT),
			published_at: "publishedAt" => nullable(string(ISO_DATE_TIME)),
			retrieved_at: "retrievedAt" => string(ISO_DATE_TIME),
			effective_at: "effectiveAt" => nullable(string(ISO_DATE_TIME)),
			excerpt: "excerpt" => nullable(string(MAX_500)),
			checksum: "checksum" => string(SHA256),
			source_class: "sourceClass" => SourceClass::decode,
		})
	}
}

js_enum! {
	/// `claimTypeSchema`.
	pub enum ClaimType {
		Observation = "observation",
		Inference = "inference",
		Hypothesis = "hypothesis",
		Forecast = "forecast",
	}
}

js_enum! {
	/// `evidenceRelationSchema`.
	pub enum EvidenceRelation {
		Supports = "supports",
		Contradicts = "contradicts",
		Context = "context",
	}
}

js_enum! {
	/// `claimStatusSchema`.
	pub enum ClaimStatus {
		Supported = "supported",
		Unsupported = "unsupported",
		Conflicting = "conflicting",
	}
}

const MAX_400: &[StrCheck] = &[StrCheck::Max(400)];

/// `evidenceLinkSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLink {
	/// Evidence id.
	pub evidence_id: String,
	/// Relation.
	pub relation: EvidenceRelation,
	/// Quote (≤ 400).
	pub quote: Option<String>,
}

impl EvidenceLink {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			evidence_id: "evidenceId" => id,
			relation: "relation" => EvidenceRelation::decode,
			quote: "quote" => nullable(string(MAX_400)),
		})
	}
}

/// `claimIssueSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code")]
pub enum ClaimIssue {
	/// Cites an evidence id that does not exist.
	#[serde(rename = "UNKNOWN_EVIDENCE", rename_all = "camelCase")]
	UnknownEvidence {
		/// The id (≤ 200).
		evidence_id: String,
	},
	/// The quote is not in the evidence.
	#[serde(rename = "QUOTE_NOT_FOUND", rename_all = "camelCase")]
	QuoteNotFound {
		/// The id (≤ 200).
		evidence_id: String,
	},
	/// The quote is too short.
	#[serde(rename = "QUOTE_TOO_SHORT", rename_all = "camelCase")]
	QuoteTooShort {
		/// The id (≤ 200).
		evidence_id: String,
	},
	/// A quote is missing.
	#[serde(rename = "MISSING_QUOTE", rename_all = "camelCase")]
	MissingQuote {
		/// The id (≤ 200).
		evidence_id: String,
	},
	/// A number is not in the evidence.
	#[serde(rename = "NUMBER_NOT_IN_EVIDENCE", rename_all = "camelCase")]
	NumberNotInEvidence {
		/// The number as written (≤ 40).
		number_text: String,
	},
	/// No supporting evidence.
	#[serde(rename = "NO_SUPPORTING_EVIDENCE")]
	NoSupportingEvidence,
	/// Not independently verified.
	#[serde(rename = "NOT_INDEPENDENTLY_VERIFIED")]
	NotIndependentlyVerified,
}

const MAX_200: &[StrCheck] = &[StrCheck::Max(200)];
const MAX_40: &[StrCheck] = &[StrCheck::Max(40)];
const CLAIM_ISSUE_CODES: &[&str] = &[
	"UNKNOWN_EVIDENCE",
	"QUOTE_NOT_FOUND",
	"QUOTE_TOO_SHORT",
	"MISSING_QUOTE",
	"NUMBER_NOT_IN_EVIDENCE",
	"NO_SUPPORTING_EVIDENCE",
	"NOT_INDEPENDENTLY_VERIFIED",
];

impl ClaimIssue {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "code", CLAIM_ISSUE_CODES, |cx, tag| match tag {
			0 => decode_object!(cx, input, strict, ["code"], Self::UnknownEvidence {
				evidence_id: "evidenceId" => string(MAX_200),
			}),
			1 => decode_object!(cx, input, strict, ["code"], Self::QuoteNotFound {
				evidence_id: "evidenceId" => string(MAX_200),
			}),
			2 => decode_object!(cx, input, strict, ["code"], Self::QuoteTooShort {
				evidence_id: "evidenceId" => string(MAX_200),
			}),
			3 => decode_object!(cx, input, strict, ["code"], Self::MissingQuote {
				evidence_id: "evidenceId" => string(MAX_200),
			}),
			4 => decode_object!(cx, input, strict, ["code"], Self::NumberNotInEvidence {
				number_text: "numberText" => string(MAX_40),
			}),
			5 => decode_object!(cx, input, strict, ["code"], Self::NoSupportingEvidence {}),
			_ => decode_object!(
				cx,
				input,
				strict,
				["code"],
				Self::NotIndependentlyVerified {}
			),
		})
	}
}

const CLAIM_TEXT: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(1000)];

/// `claimSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
	/// Claim id.
	pub claim_id: String,
	/// Text (1..1000).
	pub text: String,
	/// Claim type.
	pub claim_type: ClaimType,
	/// Verification status.
	pub status: ClaimStatus,
	/// Evidence links (≤ 12).
	pub links: Vec<EvidenceLink>,
	/// Verification issues (≤ 24).
	pub issues: Vec<ClaimIssue>,
}

impl Claim {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			claim_id: "claimId" => id,
			text: "text" => string(CLAIM_TEXT),
			claim_type: "claimType" => ClaimType::decode,
			status: "status" => ClaimStatus::decode,
			links: "links" => array(EvidenceLink::decode, &[ArrCheck::Max(12)]),
			issues: "issues" => array(ClaimIssue::decode, &[ArrCheck::Max(24)]),
		})
	}
}

/* ---------- Demand scenarios ---------- */

const ASSUMPTION: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(400)];
const ASSUMPTIONS: &[ArrCheck] = &[ArrCheck::Max(12)];
const UNIT_80: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(80)];
const YEAR: &[NumCheck] = &[NumCheck::Int, NumCheck::Gte(1990.0), NumCheck::Lte(2100.0)];

/// One case (bear/base/bull) of a scenario.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioCase {
	/// Target value.
	pub target_value: f64,
	/// Assumptions (≤ 12 of 1..400).
	pub assumptions: Vec<String>,
}

impl ScenarioCase {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			target_value: "targetValue" => number(&[]),
			assumptions: "assumptions" => array(string(ASSUMPTION), ASSUMPTIONS),
		})
	}
}

js_enum! {
	/// What a scenario quantifies.
	pub enum QuantityKind {
		UnitDemand = "unit-demand",
		Revenue = "revenue",
		Price = "price",
	}
}

/// `derivedCagr` of a scenario.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DerivedCagr {
	/// Bear case.
	pub bear: Option<f64>,
	/// Base case.
	pub base: Option<f64>,
	/// Bull case.
	pub bull: Option<f64>,
}

impl DerivedCagr {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			bear: "bear" => nullable(number(&[])),
			base: "base" => nullable(number(&[])),
			bull: "bull" => nullable(number(&[])),
		})
	}
}

const EVIDENCE_IDS_24: &[ArrCheck] = &[ArrCheck::Max(24)];

/// `demandScenarioSchema` (the scenario input extended with ids and the
/// derived growth).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemandScenario {
	/// Product or service (trimmed, 1..300).
	pub product_or_service: String,
	/// What is quantified.
	pub quantity_kind: QuantityKind,
	/// Unit (1..80).
	pub unit: String,
	/// Base year (1990..2100).
	pub base_year: u64,
	/// Target year (1990..2100).
	pub target_year: u64,
	/// Sourced baseline, when any.
	pub baseline_value: Option<f64>,
	/// Bear case.
	pub bear: ScenarioCase,
	/// Base case.
	pub base: ScenarioCase,
	/// Bull case.
	pub bull: ScenarioCase,
	/// Drivers.
	pub drivers: Vec<String>,
	/// Barriers.
	pub barriers: Vec<String>,
	/// Falsifiers.
	pub falsifiers: Vec<String>,
	/// Methodology (trimmed, 1..4000).
	pub methodology: String,
	/// Scenario id.
	pub scenario_id: String,
	/// Derived CAGR per case.
	pub derived_cagr: DerivedCagr,
	/// Evidence of the baseline.
	pub baseline_evidence_id: Option<String>,
	/// Quote stating the baseline (≤ 400).
	pub baseline_quote: Option<String>,
	/// Supporting evidence (≤ 24).
	pub supporting_evidence_ids: Vec<String>,
	/// Contrary evidence (≤ 24).
	pub contrary_evidence_ids: Vec<String>,
}

impl DemandScenario {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			product_or_service: "productOrService" => string(SHORT_TEXT),
			quantity_kind: "quantityKind" => QuantityKind::decode,
			unit: "unit" => string(UNIT_80),
			base_year: "baseYear" => uint(YEAR),
			target_year: "targetYear" => uint(YEAR),
			baseline_value: "baselineValue" => nullable(number(&[])),
			bear: "bear" => ScenarioCase::decode,
			base: "base" => ScenarioCase::decode,
			bull: "bull" => ScenarioCase::decode,
			drivers: "drivers" => array(string(ASSUMPTION), ASSUMPTIONS),
			barriers: "barriers" => array(string(ASSUMPTION), ASSUMPTIONS),
			falsifiers: "falsifiers" => array(string(ASSUMPTION), ASSUMPTIONS),
			methodology: "methodology" => string(LONG_TEXT),
			scenario_id: "scenarioId" => id,
			derived_cagr: "derivedCagr" => DerivedCagr::decode,
			baseline_evidence_id: "baselineEvidenceId" => nullable(id),
			baseline_quote: "baselineQuote" => nullable(string(MAX_400)),
			supporting_evidence_ids: "supportingEvidenceIds" => array(id, EVIDENCE_IDS_24),
			contrary_evidence_ids: "contraryEvidenceIds" => array(id, EVIDENCE_IDS_24),
		})
	}
}

/* ---------- Securities and suppliers ---------- */

/// `EXCHANGES_BY_COUNTRY`.
#[must_use]
pub const fn exchanges_of(country: Market) -> &'static [&'static str] {
	match country {
		Market::Jp => &["TSE", "NSE", "FSE", "SSE"],
		Market::Us => &["NYSE", "NASDAQ", "NYSE American", "NYSE Arca", "Cboe BZX"],
	}
}

js_enum! {
	/// Issuer identifier schemes.
	pub enum IssuerScheme {
		Cik = "CIK",
		Edinet = "EDINET",
		Lei = "LEI",
		Jcn = "JCN",
		Isin = "ISIN",
	}
}

const VALUE_40: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(40)];
const EXCHANGE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(20)];
const TICKER: &[StrCheck] = &[StrCheck::Regex(&patterns::TICKER, None)];

/// An issuer identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IssuerIdentifier {
	/// Scheme.
	pub scheme: IssuerScheme,
	/// Value (1..40).
	pub value: String,
}

impl IssuerIdentifier {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			scheme: "scheme" => IssuerScheme::decode,
			value: "value" => string(VALUE_40),
		})
	}
}

js_enum! {
	/// How a listing was verified.
	pub enum ListingVerification {
		SourceVerified = "source-verified",
		Unverified = "unverified",
	}
}

/// A former ticker of a security.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormerTicker {
	/// Ticker.
	pub ticker: String,
	/// Exchange (1..20).
	pub exchange: String,
	/// Last date it was valid.
	pub valid_until: String,
}

impl FormerTicker {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			ticker: "ticker" => string(TICKER),
			exchange: "exchange" => string(EXCHANGE),
			valid_until: "validUntil" => string(ISO_DATE),
		})
	}
}

/// `securitySchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Security {
	/// Security id.
	pub security_id: String,
	/// Country.
	pub country: Market,
	/// Ticker.
	pub ticker: String,
	/// Exchange, a known venue of the country.
	pub exchange: String,
	/// Issuer name (trimmed, 1..300).
	pub issuer_name: String,
	/// Issuer identifier, when known.
	pub issuer_identifier: Option<IssuerIdentifier>,
	/// Listing currency.
	pub listing_currency: String,
	/// Reporting currency.
	pub reporting_currency: Option<String>,
	/// Listing verification.
	pub listing_verification: ListingVerification,
	/// Former tickers (≤ 10).
	pub former_tickers: Vec<FormerTicker>,
}

impl Security {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let security = decode_object!(cx, input, strict, [], Self {
			security_id: "securityId" => id,
			country: "country" => Market::decode,
			ticker: "ticker" => string(TICKER),
			exchange: "exchange" => string(EXCHANGE),
			issuer_name: "issuerName" => string(SHORT_TEXT),
			issuer_identifier: "issuerIdentifier" => nullable(IssuerIdentifier::decode),
			listing_currency: "listingCurrency" => string(CURRENCY),
			reporting_currency: "reportingCurrency" => nullable(string(CURRENCY)),
			listing_verification: "listingVerification" => ListingVerification::decode,
			former_tickers: "formerTickers" => array(FormerTicker::decode, &[ArrCheck::Max(10)]),
		});
		refine(cx, mark, security.as_ref(), |cx, security| {
			if !exchanges_of(security.country).contains(&security.exchange.as_str()) {
				cx.refine_failed(
					Some("exchange"),
					"exchange is not a known venue for the security's country",
				);
			}
		});
		security
	}
}

const BUSINESS_EXPOSURE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(1000)];
const ONE_TO_12: &[ArrCheck] = &[ArrCheck::Min(1), ArrCheck::Max(12)];

/// `supplierLinkSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierLink {
	/// Supplier link id.
	pub supplier_link_id: String,
	/// Scenario, when tied to one.
	pub scenario_id: Option<String>,
	/// Security id.
	pub security_id: String,
	/// Products or services (1..12 trimmed texts).
	pub products_or_services: Vec<String>,
	/// Business exposure (1..1000).
	pub business_exposure: String,
	/// Evidence of the relationship (1..12, FR-005).
	pub evidence_ids: Vec<String>,
	/// Quote naming the issuer (≤ 400).
	pub relationship_quote: Option<String>,
}

impl SupplierLink {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			supplier_link_id: "supplierLinkId" => id,
			scenario_id: "scenarioId" => nullable(id),
			security_id: "securityId" => id,
			products_or_services: "productsOrServices" => array(string(SHORT_TEXT), ONE_TO_12),
			business_exposure: "businessExposure" => string(BUSINESS_EXPOSURE),
			evidence_ids: "evidenceIds" => array(id, ONE_TO_12),
			relationship_quote: "relationshipQuote" => nullable(string(MAX_400)),
		})
	}
}

/* ---------- Financial observations ---------- */

js_enum! {
	/// Fiscal period.
	pub enum FiscalPeriod {
		Fy = "FY",
		Q1 = "Q1",
		Q2 = "Q2",
		Q3 = "Q3",
		Q4 = "Q4",
		Ttm = "TTM",
	}
}

/// `reportingPeriodSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportingPeriod {
	/// Fiscal year (1990..2100).
	pub fiscal_year: u64,
	/// Fiscal period.
	pub fiscal_period: FiscalPeriod,
	/// Start date.
	pub period_start: String,
	/// End date.
	pub period_end: String,
}

impl ReportingPeriod {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			fiscal_year: "fiscalYear" => uint(YEAR),
			fiscal_period: "fiscalPeriod" => FiscalPeriod::decode,
			period_start: "periodStart" => string(ISO_DATE),
			period_end: "periodEnd" => string(ISO_DATE),
		})
	}
}

js_enum! {
	/// `financialMetricCodeSchema`.
	pub enum FinancialMetricCode {
		TrailingPer = "trailing-per",
		ForwardPer = "forward-per",
		NetProfitMargin = "net-profit-margin",
		Revenue = "revenue",
		NetIncome = "net-income",
		EpsDiluted = "eps-diluted",
		SharePrice = "share-price",
	}
}

js_enum! {
	/// Unit of a financial observation.
	pub enum FinancialUnit {
		Ratio = "ratio",
		Currency = "currency",
		CurrencyPerShare = "currency-per-share",
	}
}

js_enum! {
	/// Accounting standard.
	pub enum AccountingStandard {
		UsGaap = "US-GAAP",
		Ifrs = "IFRS",
		Jgaap = "JGAAP",
		Other = "OTHER",
	}
}

js_enum! {
	/// Actual or estimate.
	pub enum ActualOrEstimate {
		Actual = "actual",
		Estimate = "estimate",
	}
}

/// `financialObservationSchema`: one immutable, dated measurement.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialObservation {
	/// Observation id.
	pub observation_id: String,
	/// Security id.
	pub security_id: String,
	/// Metric.
	pub metric_code: FinancialMetricCode,
	/// Value, or null when unavailable.
	pub value: Option<f64>,
	/// Why unavailable (1..300), exactly when `value` is null (DATA-011).
	pub unavailable_reason: Option<String>,
	/// Unit.
	pub unit: FinancialUnit,
	/// Currency.
	pub currency: Option<String>,
	/// Accounting standard.
	pub accounting_standard: Option<AccountingStandard>,
	/// Reporting period.
	pub period: Option<ReportingPeriod>,
	/// Actual or estimate.
	pub actual_or_estimate: ActualOrEstimate,
	/// Price timestamp for price-derived metrics.
	pub market_data_as_of: Option<String>,
	/// Formula (≤ 200).
	pub formula: Option<String>,
	/// Source evidence (DATA-001).
	pub source_evidence_id: Option<String>,
}

const REASON_300: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(300)];

impl FinancialObservation {
	/// zod decoder (four refinements, then the per-metric rules of DATA-005).
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let observation = decode_object!(cx, input, strict, [], Self {
			observation_id: "observationId" => id,
			security_id: "securityId" => id,
			metric_code: "metricCode" => FinancialMetricCode::decode,
			value: "value" => nullable(number(&[])),
			unavailable_reason: "unavailableReason" => nullable(string(REASON_300)),
			unit: "unit" => FinancialUnit::decode,
			currency: "currency" => nullable(string(CURRENCY)),
			accounting_standard: "accountingStandard" => nullable(AccountingStandard::decode),
			period: "period" => nullable(ReportingPeriod::decode),
			actual_or_estimate: "actualOrEstimate" => ActualOrEstimate::decode,
			market_data_as_of: "marketDataAsOf" => nullable(string(ISO_DATE_TIME)),
			formula: "formula" => nullable(string(MAX_200)),
			source_evidence_id: "sourceEvidenceId" => nullable(id),
		});
		refine(cx, mark, observation.as_ref(), |cx, o| {
			if o.value.is_none() == o.unavailable_reason.is_none() {
				cx.refine_failed(
					Some("unavailableReason"),
					"exactly one of value / unavailableReason must be set",
				);
			}
			if o.value.is_some() && o.source_evidence_id.is_none() {
				cx.refine_failed(
					Some("sourceEvidenceId"),
					"an available observation must cite source evidence",
				);
			}
			if o.value.is_some() && o.unit != FinancialUnit::Ratio && o.currency.is_none() {
				cx.refine_failed(
					Some("currency"),
					"a currency-denominated observation must state its currency",
				);
			}
			// Hard gate 6: a displayed number always has an as-of date.
			if o.value.is_some() && o.period.is_none() && o.market_data_as_of.is_none() {
				cx.refine_failed(
					Some("period"),
					"an available observation must carry a reporting period or a market-data timestamp",
				);
			}
			// Section 8.2 / DATA-005: an available metric carries everything its definition needs.
			let Some(value) = o.value else { return };
			let mut must = |holds: bool, path: &str, message: &str| {
				if !holds {
					cx.refine_failed(Some(path), message);
				}
			};
			use FinancialMetricCode as M;
			let is_per = matches!(o.metric_code, M::TrailingPer | M::ForwardPer);
			if is_per {
				must(
					value > 0.0,
					"value",
					"PER is only meaningful for positive EPS; otherwise report N/A",
				);
				must(o.unit == FinancialUnit::Ratio, "unit", "PER is a ratio");
				must(
					o.period.is_some(),
					"period",
					"PER needs the earnings period",
				);
				must(
					o.market_data_as_of.is_some(),
					"marketDataAsOf",
					"PER needs the price timestamp",
				);
				must(o.formula.is_some(), "formula", "PER needs its formula");
				let expected = if o.metric_code == M::TrailingPer {
					ActualOrEstimate::Actual
				} else {
					ActualOrEstimate::Estimate
				};
				must(
					o.actual_or_estimate == expected,
					"actualOrEstimate",
					"trailing PER uses reported EPS; forward PER uses estimated EPS",
				);
			}
			if o.metric_code == M::NetProfitMargin {
				must(
					o.unit == FinancialUnit::Ratio,
					"unit",
					"net profit margin is a ratio",
				);
				must(
					o.period.is_some(),
					"period",
					"net profit margin needs its reporting period",
				);
				must(
					o.accounting_standard.is_some(),
					"accountingStandard",
					"state the accounting basis",
				);
				must(
					o.formula.is_some(),
					"formula",
					"net profit margin needs its formula",
				);
			}
			if matches!(o.metric_code, M::Revenue | M::NetIncome) {
				must(
					o.unit == FinancialUnit::Currency,
					"unit",
					"an income figure is a currency amount",
				);
				must(
					o.period.is_some(),
					"period",
					"an income figure needs its reporting period",
				);
				must(
					o.accounting_standard.is_some(),
					"accountingStandard",
					"state the accounting basis",
				);
			}
			if o.metric_code == M::EpsDiluted {
				must(
					o.unit == FinancialUnit::CurrencyPerShare,
					"unit",
					"EPS is a per-share amount",
				);
				must(
					o.period.is_some(),
					"period",
					"EPS needs its reporting period",
				);
			}
			if o.metric_code == M::SharePrice {
				must(
					o.unit == FinancialUnit::CurrencyPerShare,
					"unit",
					"a share price is a per-share amount",
				);
				must(
					o.market_data_as_of.is_some(),
					"marketDataAsOf",
					"a share price needs its timestamp",
				);
			}
		});
		observation
	}
}

/* ---------- Positions ---------- */

js_enum! {
	/// Position metric.
	pub enum PositionMetric {
		JpMarginBalance = "jp-margin-balance",
		UsShortInterest = "us-short-interest",
	}
}

/// `positionFiguresSchema` (discriminated on `metric`; `jurisdiction` comes
/// first in the parsed value).
#[derive(Debug, Clone, PartialEq)]
pub enum PositionFigures {
	/// JP margin balances.
	JpMarginBalance {
		/// Margin buy balance (shares).
		margin_buy_balance_shares: f64,
		/// Margin sell balance (shares).
		margin_sell_balance_shares: f64,
	},
	/// US short interest.
	UsShortInterest {
		/// Reported short interest (shares).
		reported_short_interest_shares: f64,
		/// Average daily volume (shares), when known.
		average_daily_volume_shares: Option<f64>,
	},
}

impl PositionFigures {
	/// The metric of these figures.
	#[must_use]
	pub const fn metric(&self) -> PositionMetric {
		match self {
			Self::JpMarginBalance { .. } => PositionMetric::JpMarginBalance,
			Self::UsShortInterest { .. } => PositionMetric::UsShortInterest,
		}
	}
}

impl Serialize for PositionFigures {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let mut map = serializer.serialize_map(Some(4))?;
		match self {
			Self::JpMarginBalance {
				margin_buy_balance_shares,
				margin_sell_balance_shares,
			} => {
				map.serialize_entry("jurisdiction", "JP")?;
				map.serialize_entry("metric", "jp-margin-balance")?;
				map.serialize_entry("marginBuyBalanceShares", margin_buy_balance_shares)?;
				map.serialize_entry("marginSellBalanceShares", margin_sell_balance_shares)?;
			}
			Self::UsShortInterest {
				reported_short_interest_shares,
				average_daily_volume_shares,
			} => {
				map.serialize_entry("jurisdiction", "US")?;
				map.serialize_entry("metric", "us-short-interest")?;
				map.serialize_entry(
					"reportedShortInterestShares",
					reported_short_interest_shares,
				)?;
				map.serialize_entry("averageDailyVolumeShares", average_daily_volume_shares)?;
			}
		}
		map.end()
	}
}

const SHARES: &[NumCheck] = &[NumCheck::Gte(0.0)];

/// Field holder for the JP figures (decoded with their literal jurisdiction).
struct JpFigures {
	jurisdiction: (),
	margin_buy_balance_shares: f64,
	margin_sell_balance_shares: f64,
}

/// Field holder for the US figures.
struct UsFigures {
	jurisdiction: (),
	reported_short_interest_shares: f64,
	average_daily_volume_shares: Option<f64>,
}

impl PositionFigures {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "metric", PositionMetric::VALUES, |cx, tag| {
			if tag == 0 {
				let figures = decode_object!(cx, input, strict, ["metric"], JpFigures {
					jurisdiction: "jurisdiction" => literal("JP"),
					margin_buy_balance_shares: "marginBuyBalanceShares" => number(SHARES),
					margin_sell_balance_shares: "marginSellBalanceShares" => number(SHARES),
				})?;
				let JpFigures {
					jurisdiction: (), ..
				} = figures;
				Some(Self::JpMarginBalance {
					margin_buy_balance_shares: figures.margin_buy_balance_shares,
					margin_sell_balance_shares: figures.margin_sell_balance_shares,
				})
			} else {
				let figures = decode_object!(cx, input, strict, ["metric"], UsFigures {
					jurisdiction: "jurisdiction" => literal("US"),
					reported_short_interest_shares: "reportedShortInterestShares" => number(SHARES),
					average_daily_volume_shares: "averageDailyVolumeShares" => nullable(number(SHARES)),
				})?;
				let UsFigures {
					jurisdiction: (), ..
				} = figures;
				Some(Self::UsShortInterest {
					reported_short_interest_shares: figures.reported_short_interest_shares,
					average_daily_volume_shares: figures.average_daily_volume_shares,
				})
			}
		})
	}
}

/// The `"shares"` unit literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SharesUnit;

impl Serialize for SharesUnit {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.serialize_str("shares")
	}
}

const DEFINITION_500: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(500)];

/// `positionObservationSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionObservation {
	/// Observation id.
	pub observation_id: String,
	/// Security id.
	pub security_id: String,
	/// Jurisdiction.
	pub jurisdiction: Market,
	/// Metric.
	pub metric: PositionMetric,
	/// Figures, or null when unavailable.
	pub figures: Option<PositionFigures>,
	/// Why unavailable (1..300).
	pub unavailable_reason: Option<String>,
	/// The source's own definition (1..500).
	pub metric_definition: String,
	/// Always `"shares"`.
	pub unit: SharesUnit,
	/// As-of date.
	pub as_of_date: Option<String>,
	/// Dissemination time.
	pub disseminated_at: Option<String>,
	/// Source evidence.
	pub source_evidence_id: Option<String>,
}

impl PositionObservation {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let observation = decode_object!(cx, input, strict, [], Self {
			observation_id: "observationId" => id,
			security_id: "securityId" => id,
			jurisdiction: "jurisdiction" => Market::decode,
			metric: "metric" => PositionMetric::decode,
			figures: "figures" => nullable(PositionFigures::decode),
			unavailable_reason: "unavailableReason" => nullable(string(REASON_300)),
			metric_definition: "metricDefinition" => string(DEFINITION_500),
			unit: "unit" => |cx: &mut Cx, input| literal("shares")(cx, input).map(|()| SharesUnit),
			as_of_date: "asOfDate" => nullable(string(ISO_DATE)),
			disseminated_at: "disseminatedAt" => nullable(string(ISO_DATE_TIME)),
			source_evidence_id: "sourceEvidenceId" => nullable(id),
		});
		refine(cx, mark, observation.as_ref(), |cx, o| {
			if o.figures.is_none() == o.unavailable_reason.is_none() {
				cx.refine_failed(
					Some("unavailableReason"),
					"exactly one of figures / unavailableReason must be set",
				);
			}
			if o.figures.is_some() && (o.source_evidence_id.is_none() || o.as_of_date.is_none()) {
				cx.refine_failed(
					Some("figures"),
					"available figures must cite source evidence and an as-of date",
				);
			}
			let jurisdiction_matches =
				(o.jurisdiction == Market::Jp) == (o.metric == PositionMetric::JpMarginBalance);
			let figures_match = o
				.figures
				.as_ref()
				.is_none_or(|figures| figures.metric() == o.metric);
			if !(jurisdiction_matches && figures_match) {
				cx.refine_failed(
					Some("metric"),
					"metric does not belong to this jurisdiction",
				);
			}
		});
		observation
	}
}

/* ---------- Investor filings ---------- */

js_enum! {
	/// `reportedPositionChangeSchema`.
	pub enum ReportedPositionChange {
		NewlyReportedHolding = "newly-reported-holding",
		IncreaseInReportedPosition = "increase-in-reported-position",
		DecreaseInReportedPosition = "decrease-in-reported-position",
		NoLongerReported = "no-longer-reported",
		UnchangedReportedPosition = "unchanged-reported-position",
		NotReported = "not-reported",
	}
}

js_enum! {
	/// Filer identifier schemes.
	pub enum FilerScheme {
		Cik = "CIK",
		Edinet = "EDINET",
	}
}

/// The filer's identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReportingEntityIdentifier {
	/// Scheme.
	pub scheme: FilerScheme,
	/// Value (1..40).
	pub value: String,
}

impl ReportingEntityIdentifier {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			scheme: "scheme" => FilerScheme::decode,
			value: "value" => string(VALUE_40),
		})
	}
}

/// One holding of a filing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
	/// Issuer name (trimmed, 1..300).
	pub issuer_name: String,
	/// CUSIP (≤ 12).
	pub cusip: Option<String>,
	/// Security id, when matched.
	pub security_id: Option<String>,
	/// Reported shares.
	pub reported_shares: f64,
	/// Reported value in USD.
	pub reported_value_usd: Option<f64>,
	/// Change against the previous quarter.
	pub change_from_prior_filing: Option<ReportedPositionChange>,
}

const MAX_12: &[StrCheck] = &[StrCheck::Max(12)];

impl Holding {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			issuer_name: "issuerName" => string(SHORT_TEXT),
			cusip: "cusip" => nullable(string(MAX_12)),
			security_id: "securityId" => nullable(id),
			reported_shares: "reportedShares" => number(SHARES),
			reported_value_usd: "reportedValueUsd" => nullable(number(SHARES)),
			change_from_prior_filing: "changeFromPriorFiling" => nullable(ReportedPositionChange::decode),
		})
	}
}

const FORM: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(20)];

/// `investorFilingSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestorFiling {
	/// Filing id.
	pub filing_id: String,
	/// Investor name (trimmed, 1..300).
	pub investor_name: String,
	/// Filer identifier.
	pub reporting_entity_identifier: ReportingEntityIdentifier,
	/// Form (1..20).
	pub form: String,
	/// Quarter end the holdings are as of.
	pub report_period_end: String,
	/// Filing date.
	pub filed_at: String,
	/// https filing URL.
	pub filing_url: String,
	/// Holdings (≤ 60).
	pub holdings: Vec<Holding>,
	/// Source evidence.
	pub source_evidence_id: String,
}

impl InvestorFiling {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			filing_id: "filingId" => id,
			investor_name: "investorName" => string(SHORT_TEXT),
			reporting_entity_identifier: "reportingEntityIdentifier" => ReportingEntityIdentifier::decode,
			form: "form" => string(FORM),
			report_period_end: "reportPeriodEnd" => string(ISO_DATE),
			filed_at: "filedAt" => string(ISO_DATE),
			filing_url: "filingUrl" => string(HTTPS_URL),
			holdings: "holdings" => array(Holding::decode, &[ArrCheck::Max(60)]),
			source_evidence_id: "sourceEvidenceId" => id,
		})
	}
}

/* ---------- Pricing power ---------- */

/// `pricingPowerInputsSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingPowerInputs {
	/// Revenue growth (%).
	pub revenue_growth_pct: Option<f64>,
	/// Price realisation (%).
	pub price_realization_pct: Option<f64>,
	/// Volume growth (%).
	pub volume_growth_pct: Option<f64>,
	/// Mix effect (%).
	pub mix_effect_pct: Option<f64>,
	/// FX effect (%).
	pub fx_effect_pct: Option<f64>,
	/// Input cost change (%).
	pub input_cost_change_pct: Option<f64>,
	/// Gross margin change (bps).
	pub gross_margin_change_bps: Option<f64>,
	/// Operating margin change (bps).
	pub operating_margin_change_bps: Option<f64>,
	/// Management commentary evidence (≤ 12).
	pub management_commentary_evidence_ids: Vec<String>,
}

impl PricingPowerInputs {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			revenue_growth_pct: "revenueGrowthPct" => nullable(number(&[])),
			price_realization_pct: "priceRealizationPct" => nullable(number(&[])),
			volume_growth_pct: "volumeGrowthPct" => nullable(number(&[])),
			mix_effect_pct: "mixEffectPct" => nullable(number(&[])),
			fx_effect_pct: "fxEffectPct" => nullable(number(&[])),
			input_cost_change_pct: "inputCostChangePct" => nullable(number(&[])),
			gross_margin_change_bps: "grossMarginChangeBps" => nullable(number(&[])),
			operating_margin_change_bps: "operatingMarginChangeBps" => nullable(number(&[])),
			management_commentary_evidence_ids: "managementCommentaryEvidenceIds" => array(id, &[ArrCheck::Max(12)]),
		})
	}
}

js_enum! {
	/// Pricing power classification.
	pub enum PricingPowerClassification {
		CorroboratedPriceRealization = "corroborated-price-realization",
		PriceRealizationUncorroborated = "price-realization-uncorroborated",
		PriceIncreaseOffsetByVolumeLoss = "price-increase-offset-by-volume-loss",
		PriceIncreaseAbsorbedByCosts = "price-increase-absorbed-by-costs",
		NoPriceRealization = "no-price-realization",
		MarginImprovementWithoutPriceEvidence = "margin-improvement-without-price-evidence",
		InsufficientData = "insufficient-data",
	}
}

js_enum! {
	/// An input a pricing power assessment lacked.
	pub enum PricingPowerMissingInput {
		PriceRealizationPct = "priceRealizationPct",
		VolumeGrowthPct = "volumeGrowthPct",
		GrossMarginChangeBps = "grossMarginChangeBps",
		ManagementCommentary = "managementCommentary",
	}
}

/// `pricingPowerAssessmentSchema` (computed by the domain).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingPowerAssessment {
	/// Classification.
	pub classification: PricingPowerClassification,
	/// Missing inputs.
	pub missing_inputs: Vec<PricingPowerMissingInput>,
	/// Unexplained revenue residual (%).
	pub unexplained_revenue_residual_pct: Option<f64>,
}

impl PricingPowerAssessment {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			classification: "classification" => PricingPowerClassification::decode,
			missing_inputs: "missingInputs" => array(PricingPowerMissingInput::decode, &[]),
			unexplained_revenue_residual_pct: "unexplainedRevenueResidualPct" => nullable(number(&[])),
		})
	}
}

/// `pricingPowerRecordSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingPowerRecord {
	/// Record id.
	pub pricing_power_id: String,
	/// Security id.
	pub security_id: String,
	/// Reporting period.
	pub period: ReportingPeriod,
	/// Inputs.
	pub inputs: PricingPowerInputs,
	/// Assessment computed from `inputs`.
	pub assessment: PricingPowerAssessment,
	/// Evidence (1..12).
	pub evidence_ids: Vec<String>,
}

impl PricingPowerRecord {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			pricing_power_id: "pricingPowerId" => id,
			security_id: "securityId" => id,
			period: "period" => ReportingPeriod::decode,
			inputs: "inputs" => PricingPowerInputs::decode,
			assessment: "assessment" => PricingPowerAssessment::decode,
			evidence_ids: "evidenceIds" => array(id, ONE_TO_12),
		})
	}
}

/* ---------- Datasets ---------- */

/// `DATASET_LIMITS`.
pub mod dataset_limits {
	/// Column label characters.
	pub const MAX_COLUMN_LABEL_CHARS: usize = 80;
	/// Column unit characters.
	pub const MAX_COLUMN_UNIT_CHARS: usize = 40;
}

/// A cell value: a finite number, text (≤ 600) or null.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
	/// A number.
	Number(f64),
	/// Text.
	Text(String),
	/// No value.
	Null,
}

impl Serialize for CellValue {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self {
			Self::Number(number) => serializer.serialize_f64(*number),
			Self::Text(text) => serializer.serialize_str(text),
			Self::Null => serializer.serialize_unit(),
		}
	}
}

const MAX_600: &[StrCheck] = &[StrCheck::Max(600)];

fn null_value(cx: &mut Cx, input: Option<&Value>) -> Option<()> {
	match input {
		Some(Value::Null) => Some(()),
		_ => {
			cx.invalid_type("null", input);
			None
		}
	}
}

impl CellValue {
	fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let as_number =
			|cx: &mut Cx, input: Option<&Value>| number(&[])(cx, input).map(Self::Number);
		let as_text =
			|cx: &mut Cx, input: Option<&Value>| run_string(cx, input, MAX_600).map(Self::Text);
		let as_null =
			|cx: &mut Cx, input: Option<&Value>| null_value(cx, input).map(|()| Self::Null);
		let options: [UnionOption<'_, Self>; 3] = [&as_number, &as_text, &as_null];
		run_union(cx, input, &options)
	}
}

js_enum! {
	/// Basis of a number that is not a sourced measurement.
	pub enum ValueBasis {
		Assumption = "assumption",
		Derived = "derived",
	}
}

/// `z.union([isoDateSchema, isoDateTimeSchema])`.
pub(crate) fn date_or_date_time(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	let date = |cx: &mut Cx, input: Option<&Value>| run_string(cx, input, ISO_DATE);
	let date_time = |cx: &mut Cx, input: Option<&Value>| run_string(cx, input, ISO_DATE_TIME);
	let options: [UnionOption<'_, String>; 2] = [&date, &date_time];
	run_union(cx, input, &options)
}

/// `datasetCellSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetCell {
	/// The value.
	pub v: CellValue,
	/// Why the value is missing (1..300).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub reason: Option<String>,
	/// Evidence id of a sourced number.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub source_id: Option<String>,
	/// As-of date or time of a sourced number.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub as_of: Option<String>,
	/// Basis of an unsourced number.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub basis: Option<ValueBasis>,
}

impl DatasetCell {
	/// zod decoder (hard gate 6).
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let cell = decode_object!(cx, input, strict, [], Self {
			v: "v" => CellValue::decode,
			reason: "reason" => optional(string(REASON_300)),
			source_id: "sourceId" => optional(id),
			as_of: "asOf" => optional(date_or_date_time),
			basis: "basis" => optional(ValueBasis::decode),
		});
		refine(cx, mark, cell.as_ref(), |cx, cell| {
			if cell.v == CellValue::Null && cell.reason.is_none() {
				cx.refine_failed(
					Some("reason"),
					"an empty cell must state why the value is unavailable",
				);
			}
			if !matches!(cell.v, CellValue::Number(_)) {
				return;
			}
			if cell.source_id.is_some() && cell.as_of.is_none() {
				cx.refine_failed(Some("asOf"), "a sourced number must carry an as-of date");
			}
			// No bare numbers: every figure traces to a source or says what else it is.
			if cell.source_id.is_none() && cell.basis.is_none() {
				cx.refine_failed(
					Some("basis"),
					"a number must cite a source or declare itself an assumption or derived value",
				);
			}
		});
		cell
	}
}

js_enum! {
	/// Column kind.
	pub enum ColumnKind {
		Text = "text",
		Number = "number",
		Date = "date",
	}
}

const COLUMN_KEY: &[StrCheck] = &[StrCheck::Regex(&patterns::DATASET_KEY, None)];
const COLUMN_LABEL: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(dataset_limits::MAX_COLUMN_LABEL_CHARS),
];
const COLUMN_UNIT: &[StrCheck] = &[
	StrCheck::Min(1),
	StrCheck::Max(dataset_limits::MAX_COLUMN_UNIT_CHARS),
];

/// `datasetColumnSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetColumn {
	/// Key.
	pub key: String,
	/// Label (1..80).
	pub label: String,
	/// Kind.
	pub kind: ColumnKind,
	/// Unit (1..40), mandatory for number columns (UI-007).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub unit: Option<String>,
}

impl DatasetColumn {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			key: "key" => string(COLUMN_KEY),
			label: "label" => string(COLUMN_LABEL),
			kind: "kind" => ColumnKind::decode,
			unit: "unit" => optional(string(COLUMN_UNIT)),
		})
	}
}

/// One dataset row: cells by column key, in JavaScript property order.
pub type DatasetRow = Record<DatasetCell>;

/// `datasetSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
	/// Dataset id.
	pub dataset_id: String,
	/// Title (trimmed, 1..300).
	pub title: String,
	/// Columns (1..16).
	pub columns: Vec<DatasetColumn>,
	/// Rows (≤ 300).
	pub rows: Vec<DatasetRow>,
	/// Creation time.
	pub created_at: String,
}

fn dataset_row(cx: &mut Cx, input: Option<&Value>) -> Option<DatasetRow> {
	record(&[], DatasetCell::decode)(cx, input).map(Record)
}

impl Dataset {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		let mark = cx.mark();
		let dataset = decode_object!(cx, input, strict, [], Self {
			dataset_id: "datasetId" => id,
			title: "title" => string(SHORT_TEXT),
			columns: "columns" => array(DatasetColumn::decode, &[ArrCheck::Min(1), ArrCheck::Max(16)]),
			rows: "rows" => array(dataset_row, &[ArrCheck::Max(300)]),
			created_at: "createdAt" => string(ISO_DATE_TIME),
		});
		refine(cx, mark, dataset.as_ref(), |cx, d| {
			if !d
				.columns
				.iter()
				.all(|column| column.kind != ColumnKind::Number || column.unit.is_some())
			{
				cx.refine_failed(Some("columns"), "number columns must declare a unit");
			}
			let mut keys: Vec<&str> = d.columns.iter().map(|column| column.key.as_str()).collect();
			keys.sort_unstable();
			keys.dedup();
			let unique = keys.len() == d.columns.len();
			let declared = d.rows.iter().all(|row| {
				row.0
					.iter()
					.all(|(key, _)| keys.binary_search(&key.as_str()).is_ok())
			});
			if !(unique && declared) {
				cx.refine_failed(
					Some("rows"),
					"rows may only use declared, unique column keys",
				);
			}
			// A cell's value has the type its column declares.
			let kinds_match = d.rows.iter().all(|row| {
				d.columns.iter().all(|column| {
					match row
						.0
						.iter()
						.find(|(key, _)| *key == column.key)
						.map(|(_, cell)| &cell.v)
					{
						None | Some(CellValue::Null) => true,
						Some(CellValue::Number(_)) => column.kind == ColumnKind::Number,
						Some(CellValue::Text(_)) => column.kind != ColumnKind::Number,
					}
				})
			});
			if !kinds_match {
				cx.refine_failed(Some("rows"), "cell values must match their column kind");
			}
		});
		dataset
	}
}
