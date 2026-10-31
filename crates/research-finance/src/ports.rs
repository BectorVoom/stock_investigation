//! Market and earnings ports (FR-017, FR-018); sources are registered by id.
use async_trait::async_trait;
use research_contracts::market::{
	MarketProviderId, MarketSeriesMeta, MarketUnavailableCode, market_unavailable_reason,
};
use research_contracts::stock_directory::{StockDirectoryEntry, StockDirectoryFailureCode};
use research_contracts::watchlist::{
	EarningsEvent, EarningsSourceId, EarningsUnavailableCode, WatchMarket,
};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

/// An API credential whose Debug representation is always redacted (SEC-005).
#[derive(Clone)]
pub struct Secret(String);
impl Secret {
	/// Wraps a credential.
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}
	/// Exposes it only at the outgoing request boundary.
	pub fn expose(&self) -> &str {
		&self.0
	}
}
impl std::fmt::Debug for Secret {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str("[REDACTED]")
	}
}
/// One request for a provider series.
pub struct SeriesQuery<'a> {
	/// Provider symbol.
	pub symbol: &'a str,
	/// ADR-0044: first observation date to return (inclusive), or `None`
	/// for the full history (newest `max_observations`). No adapter overlap.
	pub from: Option<&'a str>,
	/// Maximum observations.
	pub max_observations: usize,
	/// Run cancellation.
	pub cancel: &'a CancellationToken,
	/// Admits each HTTP request the adapter actually sends (a cached part
	/// costs no grant); nothing is sent unless it answers `Granted`.
	pub before_request: &'a dyn AdmitRequest,
}
/// The answer to a market request's admission (`MarketRequestAdmission`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketRequestAdmission {
	/// Send it.
	Granted,
	/// The job stopped while waiting: send nothing.
	Stopped,
	/// The provider's daily budget is used up: send nothing, fail the series
	/// as `RATE_LIMITED`.
	BudgetSpent,
}
impl MarketRequestAdmission {
	/// The TypeScript string form.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Granted => "granted",
			Self::Stopped => "stopped",
			Self::BudgetSpent => "budget-spent",
		}
	}
}
/// Admits one market request start (`beforeRequest` of `fetchSeries`).
#[async_trait]
pub trait AdmitRequest: Send + Sync {
	/// The admission of the next request.
	async fn admit(&self) -> MarketRequestAdmission;
}
/// One daily or lower-frequency numeric observation.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
	/// UTC civil date.
	pub observed_on: String,
	/// Provider value.
	pub value: f64,
}
impl research_domain::market::history_refresh::DatedValue for SeriesPoint {
	fn observed_on(&self) -> &str {
		&self.observed_on
	}
	fn value(&self) -> f64 {
		self.value
	}
}
/// A series and its lineage.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SeriesData {
	/// Provider metadata.
	pub meta: MarketSeriesMeta,
	/// Ascending, deduplicated observations.
	pub observations: Vec<SeriesPoint>,
}
/// A fixed, log-safe provider failure (`MarketSourceUnavailable`).
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{reason}")]
pub struct MarketUnavailable {
	/// Stable code.
	pub code: MarketUnavailableCode,
	/// Fixed reason.
	pub reason: String,
	/// The provider's answer status behind `code`, unchanged; `None` when it
	/// did not answer (docs/rule/error_handling.md §4a).
	pub upstream_status: Option<u16>,
}
impl MarketUnavailable {
	/// Constructs the provider-specific fixed reason, keeping the provider's
	/// answer status (`None` when no answer caused the failure).
	pub fn new(
		code: MarketUnavailableCode,
		provider: MarketProviderId,
		upstream_status: Option<u16>,
	) -> Self {
		Self {
			code,
			reason: market_unavailable_reason(code, Some(provider)).to_owned(),
			upstream_status,
		}
	}
}
/// Source-neutral series port.
#[async_trait]
pub trait MarketSeriesSource: Send + Sync {
	/// Registry id.
	fn provider_id(&self) -> MarketProviderId;
	/// Fetches a series; remote response text never escapes in a failure.
	async fn fetch_series(&self, query: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable>;
}
/// Explicitly unavailable source when the owner has not configured a key.
pub struct UnconfiguredMarketSeriesSource {
	/// Registry id.
	pub provider: MarketProviderId,
	/// Configured fixed reason.
	pub reason: String,
}
#[async_trait]
impl MarketSeriesSource for UnconfiguredMarketSeriesSource {
	fn provider_id(&self) -> MarketProviderId {
		self.provider
	}
	async fn fetch_series(&self, _: SeriesQuery<'_>) -> Result<SeriesData, MarketUnavailable> {
		Err(MarketUnavailable {
			code: MarketUnavailableCode::SourceNotConfigured,
			reason: self.reason.clone(),
			upstream_status: None,
		})
	}
}
/// One requested stock.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarningsStock {
	/// Provider symbol.
	pub symbol: String,
	/// Whether to resolve its name.
	pub need_name: bool,
}
/// Per-request quota gate, also used for cached JPX sources.
#[async_trait]
pub trait BeforeRequest: Send + Sync {
	/// False means send nothing.
	async fn before_request(&self) -> bool;
}
/// One earnings batch.
pub struct EarningsQuery<'a> {
	/// Stocks in response order.
	pub stocks: &'a [EarningsStock],
	/// Inclusive start date.
	pub from_date: &'a str,
	/// Inclusive end date.
	pub to_date: &'a str,
	/// Cancellation.
	pub cancel: &'a CancellationToken,
	/// Called immediately before every sent request.
	pub before_request: &'a dyn BeforeRequest,
}
/// Successfully retrieved announcements.
#[derive(Clone, Debug, Serialize)]
pub struct EarningsData {
	/// Company name when requested.
	pub name: Option<String>,
	/// Announcements, bounded to eight.
	pub events: Vec<EarningsEvent>,
}
/// Failed retrieval (`EarningsSourceFailure`): a name only for
/// NO_SCHEDULED_DATE, the provider's answer status for every other code.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}")]
pub struct EarningsFailure {
	/// Stable reason code.
	pub code: EarningsUnavailableCode,
	/// A known name for a successful retrieval with no scheduled date.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub name: Option<Option<String>>,
	/// The provider's answer status behind `code`, unchanged (§4a): the outer
	/// `None` for NO_SCHEDULED_DATE (which carries a name instead), the inner
	/// `None` when the provider did not answer.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub upstream_status: Option<Option<u16>>,
}
impl EarningsFailure {
	/// A failure without a name, with the provider's answer status
	/// (`None` when no answer caused it).
	pub fn new(code: EarningsUnavailableCode, upstream_status: Option<u16>) -> Self {
		Self {
			code,
			name: None,
			upstream_status: Some(upstream_status),
		}
	}
	/// A successful retrieval without announcements.
	pub fn no_date(name: Option<String>) -> Self {
		Self {
			code: EarningsUnavailableCode::NoScheduledDate,
			name: Some(name),
			upstream_status: None,
		}
	}
	/// The provider's answer status, `None` when there is none.
	#[must_use]
	pub fn answer_status(&self) -> Option<u16> {
		self.upstream_status.flatten()
	}
}
/// A result per stock, in query order.
pub type EarningsResult = Result<EarningsData, EarningsFailure>;
/// Source-neutral earnings port.
#[async_trait]
pub trait EarningsCalendarSource: Send + Sync {
	/// Registry id.
	fn source_id(&self) -> EarningsSourceId;
	/// Sequential requests, one output per input stock.
	async fn fetch_earnings(&self, query: EarningsQuery<'_>) -> Vec<EarningsResult>;
}
/// A source without the required provider key.
pub struct UnconfiguredEarningsCalendarSource(pub EarningsSourceId);
#[async_trait]
impl EarningsCalendarSource for UnconfiguredEarningsCalendarSource {
	fn source_id(&self) -> EarningsSourceId {
		self.0
	}
	async fn fetch_earnings(&self, query: EarningsQuery<'_>) -> Vec<EarningsResult> {
		query
			.stocks
			.iter()
			.map(|_| {
				Err(EarningsFailure::new(
					EarningsUnavailableCode::SourceNotConfigured,
					None,
				))
			})
			.collect()
	}
}
/// Injected sleep (ARCH-002); resolves early when cancelled.
#[async_trait]
pub trait Sleeper: Send + Sync {
	/// Waits in milliseconds, without returning cancellation as an exception.
	async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>);
}
/// Production cancellable tokio sleep.
pub struct TokioSleeper;
#[async_trait]
impl Sleeper for TokioSleeper {
	async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
		let sleep = tokio::time::sleep(std::time::Duration::from_millis(ms));
		if let Some(cancel) = cancel {
			tokio::select! { () = sleep => {}, () = cancel.cancelled() => {} }
		} else {
			sleep.await;
		}
	}
}

/* ---------- Stock directory (ADR-0034: every listed US / JP stock) ---------- */

/// One stock-directory download.
pub struct StockDirectoryQuery<'a> {
	/// Run cancellation.
	pub cancel: &'a CancellationToken,
	/// Called immediately before every request; nothing is sent when it
	/// answers false. Built by the runner from the shared pacer (SEC and JPX
	/// share their windows with the other jobs that reach those hosts).
	pub before_request: &'a dyn BeforeRequest,
}

/// One market's list as a source delivers it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StockDirectoryData {
	/// The date the source says the list is effective (JPX); `None` for SEC.
	pub as_of: Option<String>,
	/// Every kept row, distinct symbols, already filtered to the market's listings.
	pub entries: Vec<StockDirectoryEntry>,
}

/// Why a market's list could not be downloaded. `upstream_status` is the
/// status SEC or JPX answered with, unchanged; `None` when it did not answer
/// with one (not configured, a timeout, a file that did not parse) (§4a).
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}")]
pub struct StockDirectoryFailure {
	/// Stable code.
	pub code: StockDirectoryFailureCode,
	/// The source's answer status behind `code`, unchanged.
	pub upstream_status: Option<u16>,
}

impl StockDirectoryFailure {
	/// A failure no external answer caused (parse, not configured, a stopped job).
	#[must_use]
	pub const fn own(code: StockDirectoryFailureCode) -> Self {
		Self {
			code,
			upstream_status: None,
		}
	}
}

/// Downloads one market's full list; adapters implement it per market (SEC, JPX).
#[async_trait]
pub trait StockDirectorySource: Send + Sync {
	/// The market whose list this source downloads.
	fn market(&self) -> WatchMarket;
	/// The list, or a stable failure code with the source's status (never provider text).
	async fn fetch_directory(
		&self,
		query: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailure>;
}

/// A source that always reports `DIRECTORY_NOT_CONFIGURED` (US without
/// `SEC_USER_AGENT`), so the job fails with a stable code instead of sending
/// an undeclared User-Agent to SEC.
pub struct UnconfiguredStockDirectorySource(pub WatchMarket);

#[async_trait]
impl StockDirectorySource for UnconfiguredStockDirectorySource {
	fn market(&self) -> WatchMarket {
		self.0
	}
	async fn fetch_directory(
		&self,
		_: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailure> {
		Err(StockDirectoryFailure::own(
			StockDirectoryFailureCode::NotConfigured,
		))
	}
}

/// Told how many rows a source dropped for an over-long name (a count, never the names).
pub type DroppedRowsHook = std::sync::Arc<dyn Fn(usize) + Send + Sync>;
