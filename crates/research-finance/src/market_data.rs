//! Source-neutral licensed-data ports; V1 has no verified configured sources (DATA-006, DATA-011).
use async_trait::async_trait;
use research_domain::finance::{per::PriceQuote,positions::{UsShortInterestFigures,JpMarginBalanceFigures}};
use serde::Serialize;
/// Fixed explanation for missing licensed prices.
pub const NO_SHARE_PRICE_SOURCE_REASON: &str = "No licensed market-data source is configured, so no share price is available. A price-based ratio cannot be computed and is reported unavailable rather than estimated.";
/// Fixed explanation for missing US short interest.
pub const NO_US_SHORT_INTEREST_SOURCE_REASON: &str = "No US short-interest source is configured. FINRA publishes equity short interest, but no licensed, verified feed is connected to this workspace.";
/// Fixed explanation for missing Japanese margin balances.
pub const NO_JP_MARGIN_BALANCE_SOURCE_REASON: &str = "No Japanese margin-balance source is configured. JPX publishes margin trading statistics, but no licensed, verified feed is connected to this workspace.";
/// Missing licensed-source data.
#[derive(Clone,Debug,Serialize,thiserror::Error)]
#[error("{reason}")]
pub struct MarketDataUnavailable {
	/// Stable code.
	pub code: String,
	/// Owner-facing reason.
	pub reason: String,
}
fn unavailable(reason: &str) -> MarketDataUnavailable { MarketDataUnavailable { code: "SOURCE_NOT_CONFIGURED".to_owned(),reason: reason.to_owned() } }
/// Traceable provenance for a source's figures.
#[derive(Clone,Debug)]
pub struct MarketDataProvenance {
	/// Source URL.
	pub source_url: String,
	/// Source title.
	pub title: String,
	/// Publisher.
	pub publisher: String,
	/// Publication timestamp.
	pub published_at: Option<String>,
	/// Verifiable retrieved text, in memory only.
	pub retrieved_text: String,
}
/// Available price report.
pub struct SharePriceReport {
	/// Dated price and adjustment basis.
	pub quote: PriceQuote,
	/// Source lineage.
	pub provenance: MarketDataProvenance,
}
/// Price lookup input.
pub struct SharePriceQuery<'a> {
	/// Security identity.
	pub security_id: &'a str,
	/// Ticker.
	pub ticker: &'a str,
	/// Listing exchange.
	pub exchange: &'a str,
}
/// Licensed price source.
#[async_trait]
pub trait SharePriceSource: Send + Sync {
	/// Latest quote with lineage, or explicit absence.
	async fn latest_quote(&self,query: SharePriceQuery<'_>) -> Result<SharePriceReport,MarketDataUnavailable>;
}
/// Available US settlement short-interest report.
pub struct UsShortInterestReport {
	/// Shares sold short and volume.
	pub figures: UsShortInterestFigures,
	/// Settlement date.
	pub settlement_date: String,
	/// Dissemination timestamp.
	pub disseminated_at: Option<String>,
	/// Source lineage.
	pub provenance: MarketDataProvenance,
}
/// Licensed US short-interest source.
#[async_trait]
pub trait UsShortInterestSource: Send + Sync {
	/// Latest report for this ticker.
	async fn latest_short_interest(&self,ticker: &str) -> Result<UsShortInterestReport,MarketDataUnavailable>;
}
/// Available Japanese margin-balance report.
pub struct JpMarginBalanceReport {
	/// Margin purchase/sale balance shares.
	pub figures: JpMarginBalanceFigures,
	/// Balances' as-of date.
	pub as_of_date: String,
	/// Dissemination timestamp.
	pub disseminated_at: Option<String>,
	/// Source lineage.
	pub provenance: MarketDataProvenance,
}
/// Licensed Japanese margin-balance source.
#[async_trait]
pub trait JpMarginBalanceSource: Send + Sync {
	/// Latest report for a four-character securities code.
	async fn latest_margin_balance(&self,code: &str) -> Result<JpMarginBalanceReport,MarketDataUnavailable>;
}
/// The V1 unconfigured share-price source; performs no network calls.
pub struct UnconfiguredSharePriceSource;
#[async_trait]
impl SharePriceSource for UnconfiguredSharePriceSource {
	async fn latest_quote(&self,_: SharePriceQuery<'_>) -> Result<SharePriceReport,MarketDataUnavailable> { Err(unavailable(NO_SHARE_PRICE_SOURCE_REASON)) }
}
/// The V1 unconfigured US short-interest source.
pub struct UnconfiguredUsShortInterestSource;
#[async_trait]
impl UsShortInterestSource for UnconfiguredUsShortInterestSource {
	async fn latest_short_interest(&self,_: &str) -> Result<UsShortInterestReport,MarketDataUnavailable> { Err(unavailable(NO_US_SHORT_INTEREST_SOURCE_REASON)) }
}
/// The V1 unconfigured Japanese margin-balance source.
pub struct UnconfiguredJpMarginBalanceSource;
#[async_trait]
impl JpMarginBalanceSource for UnconfiguredJpMarginBalanceSource {
	async fn latest_margin_balance(&self,_: &str) -> Result<JpMarginBalanceReport,MarketDataUnavailable> { Err(unavailable(NO_JP_MARGIN_BALANCE_SOURCE_REASON)) }
}
