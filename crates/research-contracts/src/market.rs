//! Market data (`packages/contracts/src/market.ts`): series ids, metadata,
//! observations and the market-refresh limits.

use research_js::json::Value;
use serde::Serialize;

use crate::primitives::{HTTPS_URL, ISO_DATE};
use crate::zod::{
	Cx, StrCheck, decode_object, js_enum, nullable, number, number_literals, run_discriminated,
	run_string, string, tuple2,
};

/// `MARKET_LIMITS`: the dashboard numbers are the domain's
/// [`DASHBOARD_LIMITS`], the refresh numbers are the contract's own.
pub mod limits {
	use research_domain::market::dashboard::DASHBOARD_LIMITS;

	/// Widgets on Home.
	pub const MAX_WIDGETS: usize = DASHBOARD_LIMITS.max_widgets;
	/// Distinct series one page's market widgets may name.
	pub const MAX_SERIES: usize = DASHBOARD_LIMITS.max_series;
	/// Series of one line chart.
	pub const MAX_LINE_CHART_SERIES: usize = DASHBOARD_LIMITS.max_line_chart_series;
	/// Series of one table widget.
	pub const MAX_TABLE_SERIES: usize = DASHBOARD_LIMITS.max_table_series;
	/// Distinct series one market refresh fetches.
	pub const MAX_TRACKED_SERIES: usize = 60;
	/// Observations one series carries in a completion.
	pub const MAX_OBSERVATIONS_PER_RESPONSE: usize = 800;
	/// Observations stored per series.
	pub const MAX_STORED_OBSERVATIONS: usize = 1500;
	/// Shortest widget title.
	pub const MIN_WIDGET_TITLE: usize = DASHBOARD_LIMITS.min_widget_title;
	/// Longest widget title (one rule for every widget, ADR-0024).
	pub const MAX_WIDGET_TITLE: usize = DASHBOARD_LIMITS.max_widget_title;
}

pub use research_domain::market::dashboard::DASHBOARD_LIMITS;
/// `marketProviderIdSchema`, `parseMarketSeriesId` and `formatMarketSeriesId`
/// are the domain's (`market/seriesId.ts`).
pub use research_domain::market::series_id::{
	MarketProviderId, MarketSeriesId, SeriesIdError, format_market_series_id,
	parse_market_series_id,
};

/// The parsed `"<provider>:<symbol>"` series id (the domain's
/// [`MarketSeriesId`], under its former contracts name).
pub type MarketSeriesIdParts<'a> = MarketSeriesId<'a>;

/// `marketSeriesIdSchema`.
pub(crate) const MARKET_SERIES_ID: &[StrCheck] = &[
	StrCheck::Max(64),
	StrCheck::Refine(
		|value| parse_market_series_id(value).is_ok(),
		"invalid market series id",
	),
];

/// `marketSeriesIdSchema` decoder.
pub(crate) fn market_series_id(cx: &mut Cx, input: Option<&Value>) -> Option<String> {
	run_string(cx, input, MARKET_SERIES_ID)
}

js_enum! {
	/// `marketRangeSchema`.
	pub enum MarketRange {
		OneMonth = "1m",
		ThreeMonths = "3m",
		SixMonths = "6m",
		OneYear = "1y",
		ThreeYears = "3y",
		Max = "max",
	}
}

js_enum! {
	/// `marketFrequencySchema`.
	pub enum MarketFrequency {
		Daily = "daily",
		Weekly = "weekly",
		Monthly = "monthly",
		Quarterly = "quarterly",
		Annual = "annual",
		Unknown = "unknown",
	}
}

/// `marketObservationSchema`: `[observedOn, value]` on the wire (ADR-0010).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarketObservation(pub String, pub f64);

impl MarketObservation {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		tuple2(string(ISO_DATE), number(&[]))(cx, input).map(|(date, value)| Self(date, value))
	}
}

/// `marketHistoryAnchorSchema` (ADR-0044): the stored observation a window
/// refresh must reproduce, the `HISTORY_OVERLAP_OBSERVATIONS`-th newest
/// stored observation of the series.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketHistoryAnchor {
	/// Its date.
	pub observed_on: String,
	/// Its stored value (finite).
	pub value: f64,
}

impl MarketHistoryAnchor {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			observed_on: "observedOn" => string(ISO_DATE),
			value: "value" => number(&[]),
		})
	}
}

/// `marketHistoryWriteSchema` (ADR-0044): how a refresh's points are stored.
/// Stored rows on or after `replaceFrom` that the answer does not hold are
/// deleted, older rows are kept; a null `replaceFrom` (full fetch only)
/// replaces every stored row of the series. `replaceFrom` is always sent,
/// as `null` when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "mode")]
pub enum MarketHistoryWrite {
	/// A window fetch whose anchor held: replace from the anchor's date.
	#[serde(rename = "window", rename_all = "camelCase")]
	Window {
		/// The anchor's date.
		replace_from: String,
	},
	/// A full fetch: replace from the oldest fetched date, or everything.
	#[serde(rename = "full", rename_all = "camelCase")]
	Full {
		/// The first replaced date; `None` replaces every stored row.
		replace_from: Option<String>,
	},
}

impl MarketHistoryWrite {
	/// The first replaced date; `None` replaces every stored row.
	#[must_use]
	pub fn replace_from(&self) -> Option<&str> {
		match self {
			Self::Window { replace_from } => Some(replace_from),
			Self::Full { replace_from } => replace_from.as_deref(),
		}
	}

	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		run_discriminated(cx, input, "mode", &["window", "full"], |cx, tag| {
			if tag == 0 {
				decode_object!(cx, input, strict, ["mode"], Self::Window {
					replace_from: "replaceFrom" => string(ISO_DATE),
				})
			} else {
				decode_object!(cx, input, strict, ["mode"], Self::Full {
					replace_from: "replaceFrom" => nullable(string(ISO_DATE)),
				})
			}
		})
	}
}

js_enum! {
	/// `marketUnavailableCodeSchema` (`MARKET_UNAVAILABLE_CODES`).
	pub enum MarketUnavailableCode {
		NeverRefreshed = "NEVER_REFRESHED",
		SourceNotConfigured = "SOURCE_NOT_CONFIGURED",
		SourceAuthFailed = "SOURCE_AUTH_FAILED",
		SeriesNotFound = "SERIES_NOT_FOUND",
		PlanNotEntitled = "PLAN_NOT_ENTITLED",
		RateLimited = "RATE_LIMITED",
		NoData = "NO_DATA",
		SourceFailed = "SOURCE_FAILED",
	}
}

impl MarketUnavailableCode {
	/// `MARKET_UNAVAILABLE_REASONS`: the one fixed sentence per code.
	#[must_use]
	pub const fn reason(self) -> &'static str {
		match self {
			Self::NeverRefreshed => "No data has been refreshed yet; queue a refresh.",
			Self::SourceNotConfigured => {
				"The data source is not configured; set the provider key in apps/runner/.env."
			}
			Self::SourceAuthFailed => "The data source rejected the configured key.",
			Self::SeriesNotFound => {
				"The provider has no data for this symbol on the configured plan."
			}
			Self::PlanNotEntitled => "The provider plan does not include this symbol.",
			Self::RateLimited => "The provider rate limit was reached; try again later.",
			Self::NoData => "The provider returned no data for this series.",
			Self::SourceFailed => "The data source request failed.",
		}
	}
}

/// `marketUnavailableReason(code, provider?)`.
#[must_use]
pub const fn market_unavailable_reason(
	code: MarketUnavailableCode,
	provider: Option<MarketProviderId>,
) -> &'static str {
	match (code, provider) {
		(MarketUnavailableCode::SourceNotConfigured, Some(MarketProviderId::Fred)) => {
			"The FRED source is not configured; set FRED_API_KEY in apps/runner/.env."
		}
		(MarketUnavailableCode::SourceNotConfigured, Some(MarketProviderId::TwelveData)) => {
			"The Twelve Data source is not configured; set TWELVE_DATA_API_KEY in apps/runner/.env."
		}
		_ => code.reason(),
	}
}

const TITLE_200: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(200)];
const UNIT_80: &[StrCheck] = &[StrCheck::Trim, StrCheck::Min(1), StrCheck::Max(80)];

/// `marketSeriesMetaSchema` (titles and units are trimmed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSeriesMeta {
	/// Title (trimmed, 1..200).
	pub title: String,
	/// Unit (trimmed, 1..80).
	pub unit: String,
	/// Frequency.
	pub frequency: MarketFrequency,
	/// Publisher (trimmed, 1..200).
	pub publisher: String,
	/// https source URL.
	pub source_url: String,
}

impl MarketSeriesMeta {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			title: "title" => string(TITLE_200),
			unit: "unit" => string(UNIT_80),
			frequency: "frequency" => MarketFrequency::decode,
			publisher: "publisher" => string(TITLE_200),
			source_url: "sourceUrl" => string(HTTPS_URL),
		})
	}
}

/// `earningsCalendarDaysAheadSchema`: 30, 60, 90 or 180.
pub(crate) fn earnings_calendar_days_ahead(cx: &mut Cx, input: Option<&Value>) -> Option<f64> {
	number_literals(&[30.0, 60.0, 90.0, 180.0])(cx, input)
}
