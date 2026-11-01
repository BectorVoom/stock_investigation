//! Every directory stock's daily bars, one request per market and date
//! (port of `packages/adapters/src/finance/stockPrices.ts`, ADR-0058 §2):
//! the provider-neutral body of a `stock-prices-sync` job and the pure rules
//! it decides by. The providers ([`crate::massive`], [`crate::jquants`])
//! implement [`StockPriceSource`]. Replayed against the TypeScript by
//! `vectors/finance/stock_prices.json`.
//!
//! Wire formats, limits and error mapping: docs/external-apis/apis/massive.md,
//! docs/external-apis/apis/jquants.md

use async_trait::async_trait;
use futures_util::FutureExt;
use research_application::{ports::Clock, reporter::PipelineReporter};
use research_contracts::jobs::{CompleteJobRequest, EMPTY_USAGE, JobState, StockPricesSyncJob};
use research_contracts::market::{MarketBar, MarketUnavailableCode};
use research_contracts::stock_prices::{
	StockDayBar, StockHistoryBar, StockHistoryOutcome, StockHistoryReason, StockHistoryResult,
	StockPriceDayOutcome, StockPriceDayResult, StockPriceProvider, StockPricesClaim,
	is_stock_price_symbol, limits, stock_price_provider_of_market,
};
use research_contracts::watchlist::WatchMarket;
use research_contracts::{Tri, check_outgoing};
use research_domain::finance::financial_statements::{iso_date_of_day_number, iso_day_number};
use research_effects::{EventLogger, LogValue};
use research_js::json::Value;
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::pacing::MarketPacer;
use crate::ports::{AdmitRequest, MarketRequestAdmission};

/// `PLAN_REFUSAL_TOO_OLD_DAYS`: a plan refusal for a day more than this many
/// days beyond the delay is `too-old` (both free plans keep two years).
pub const PLAN_REFUSAL_TOO_OLD_DAYS: i64 = 365;

/// `PLAN_HISTORY_SAFE_DAYS`: a refused window is asked once more from this
/// many days before the plan's newest day.
pub const PLAN_HISTORY_SAFE_DAYS: i64 = 700;

/// `StockPriceProblem`: why a provider request gave no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StockPriceProblem {
	/// The job was stopped while waiting for its admission.
	Stopped,
	/// The key is invalid or expired.
	AuthFailed(Option<u16>),
	/// The plan does not cover the request (a 403 not about the key).
	PlanRefused(u16),
	/// The provider's rate limit (429), or the runner's own budget.
	RateLimited(Option<u16>),
	/// The provider does not know the stock (404).
	NotFound(Option<u16>),
	/// A network, server or format failure.
	Failed(Option<u16>),
}

impl StockPriceProblem {
	/// The TypeScript `kind`.
	#[must_use]
	pub const fn kind(self) -> &'static str {
		match self {
			Self::Stopped => "stopped",
			Self::AuthFailed(_) => "auth-failed",
			Self::PlanRefused(_) => "plan-refused",
			Self::RateLimited(_) => "rate-limited",
			Self::NotFound(_) => "not-found",
			Self::Failed(_) => "failed",
		}
	}

	/// The provider's status, if any.
	#[must_use]
	pub const fn status(self) -> Option<u16> {
		match self {
			Self::Stopped => None,
			Self::PlanRefused(status) => Some(status),
			Self::AuthFailed(status)
			| Self::RateLimited(status)
			| Self::NotFound(status)
			| Self::Failed(status) => status,
		}
	}
}

/// `problemOfStatus`: an HTTP status before the provider's own rules.
#[must_use]
pub const fn problem_of_status(status: Option<u16>) -> StockPriceProblem {
	match status {
		Some(401) => StockPriceProblem::AuthFailed(status),
		Some(404) => StockPriceProblem::NotFound(status),
		Some(429) => StockPriceProblem::RateLimited(status),
		_ => StockPriceProblem::Failed(status),
	}
}

/// One market's answer for one date.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct StockDayAnswer {
	/// Mapped, consistent, symbol-sorted and symbol-unique bars.
	pub bars: Vec<StockDayBar>,
	/// Symbols whose record says a price adjustment applied that day.
	pub adjusted_symbols: Vec<String>,
}

/// What a source needs per request.
pub struct StockPriceRequestContext<'a> {
	/// The job's stop.
	pub cancel: &'a CancellationToken,
	/// Awaited before every HTTP request, every page included.
	pub before_request: &'a dyn AdmitRequest,
}

impl StockPriceRequestContext<'_> {
	/// Awaits the admission: `Ok` to send, else the problem to report.
	///
	/// # Errors
	/// `Stopped`, or `RateLimited` without a status for a spent budget.
	pub async fn admit(&self) -> Result<(), StockPriceProblem> {
		match self.before_request.admit().await {
			MarketRequestAdmission::Granted => Ok(()),
			MarketRequestAdmission::Stopped => Err(StockPriceProblem::Stopped),
			MarketRequestAdmission::BudgetSpent => Err(StockPriceProblem::RateLimited(None)),
		}
	}
}

/// One provider of one market's stock prices (`StockPriceSource`).
#[async_trait]
pub trait StockPriceSource: Send + Sync {
	/// The provider.
	fn provider(&self) -> StockPriceProvider;
	/// The market.
	fn market(&self) -> WatchMarket;
	/// Days newer than today minus this are not asked for.
	fn delay_days(&self) -> i64;
	/// True when splits show in the day answers, false when they are listed.
	fn splits_in_day_answers(&self) -> bool;
	/// One date's bars.
	async fn fetch_day(
		&self,
		date: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<StockDayAnswer, StockPriceProblem>;
	/// One stock's bars of `[from, to]`.
	async fn fetch_history(
		&self,
		symbol: &str,
		from: &str,
		to: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<StockHistoryBar>, StockPriceProblem>;
	/// Directory symbols with a split executed in `(after, through]`.
	async fn fetch_split_symbols(
		&self,
		after: &str,
		through: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<String>, StockPriceProblem>;
}

/// What ended the fetching early.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndedBy {
	/// A rate limit.
	RateLimited,
	/// A source failure.
	Failed,
}

impl EndedBy {
	/// The TypeScript value.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::RateLimited => "rate-limited",
			Self::Failed => "failed",
		}
	}
}

/// `StockPricesOutcome`.
#[derive(Clone, Debug, PartialEq)]
pub enum StockPricesOutcome {
	/// What the job has.
	Synced {
		/// One result per reported day.
		days: Vec<StockPriceDayResult>,
		/// Requested and split histories.
		histories: Vec<StockHistoryResult>,
		/// Split stocks not refetched because of the history cap.
		splits_over_cap: usize,
		/// What ended the fetching early, if anything.
		ended_by: Option<EndedBy>,
	},
	/// The job failed.
	Failed {
		/// The market code.
		code: MarketUnavailableCode,
		/// The provider's status, unchanged.
		upstream_status: Option<u16>,
		/// Whether a retry at once may help.
		retryable: bool,
	},
	/// The job was stopped.
	Stopped,
}

/* ---------- Ticker and code mapping ---------- */

fn is_plain(text: &str) -> bool {
	!text.is_empty()
		&& text
			.bytes()
			.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn directory_symbol(symbol: String) -> Option<String> {
	is_stock_price_symbol(&symbol).then_some(symbol)
}

/// `[A-Z]` as one byte.
fn single_upper(text: &str) -> bool {
	text.len() == 1 && text.bytes().all(|byte| byte.is_ascii_uppercase())
}

/// `massiveTickerToSymbol`: Massive's ticker in the directory's (SEC) form.
#[must_use]
pub fn massive_ticker_to_symbol(ticker: &str) -> Option<String> {
	if is_plain(ticker) {
		return directory_symbol(ticker.to_owned());
	}
	// `BASE.WS` / `BASE.WS.X`
	if let Some((base, rest)) = ticker.split_once(".WS") {
		if is_plain(base) {
			if rest.is_empty() {
				return directory_symbol(format!("{base}-WT"));
			}
			if let Some(series) = rest.strip_prefix('.')
				&& single_upper(series)
			{
				return directory_symbol(format!("{base}-WT{series}"));
			}
		}
	}
	if let Some(base) = ticker.strip_suffix(".U")
		&& is_plain(base)
	{
		return directory_symbol(format!("{base}-UN"));
	}
	if let Some((base, class)) = ticker.rsplit_once('.')
		&& is_plain(base)
		&& single_upper(class)
	{
		return directory_symbol(format!("{base}-{class}"));
	}
	if let Some((base, series)) = ticker.rsplit_once('p')
		&& is_plain(base)
		&& (series.is_empty() || single_upper(series))
	{
		return directory_symbol(format!("{base}-P{series}"));
	}
	if let Some(base) = ticker.strip_suffix('r')
		&& is_plain(base)
	{
		return directory_symbol(format!("{base}-RI"));
	}
	if let Some(base) = ticker.strip_suffix('w')
		&& is_plain(base)
	{
		return directory_symbol(format!("{base}-WI"));
	}
	None
}

/// `symbolToMassiveTicker`: a directory symbol in Massive's form.
#[must_use]
pub fn symbol_to_massive_ticker(symbol: &str) -> Option<String> {
	if is_plain(symbol) {
		return Some(symbol.to_owned());
	}
	let (base, suffix) = symbol.split_once('-')?;
	let upper = |text: &str| text.bytes().all(|byte| byte.is_ascii_uppercase());
	if !is_plain(base) || !(1..=3).contains(&suffix.len()) || !upper(suffix) {
		return None;
	}
	Some(match suffix {
		"WT" => format!("{base}.WS"),
		"UN" => format!("{base}.U"),
		"RI" => format!("{base}r"),
		"WI" => format!("{base}w"),
		"P" => format!("{base}p"),
		_ if suffix.len() == 3 && suffix.starts_with("WT") => {
			format!("{base}.WS.{}", suffix.get(2..)?)
		}
		_ if suffix.len() == 2 && suffix.starts_with('P') => format!("{base}p{}", suffix.get(1..)?),
		_ if suffix.len() == 1 => format!("{base}.{suffix}"),
		_ => return None,
	})
}

/// `/^[0-9][0-9A-Z]{3}$/`.
fn is_jp_symbol(text: &str) -> bool {
	let bytes = text.as_bytes();
	bytes.len() == 4
		&& bytes.first().is_some_and(u8::is_ascii_digit)
		&& bytes
			.iter()
			.skip(1)
			.all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
}

/// `jquantsCodeToSymbol`: `13800` → `1380`, `130A0` → `130A`.
#[must_use]
pub fn jquants_code_to_symbol(code: &str) -> Option<String> {
	let head = code.strip_suffix('0')?;
	is_jp_symbol(head).then(|| head.to_owned())
}

/// `symbolToJquantsCode`: `1380` → `13800`.
#[must_use]
pub fn symbol_to_jquants_code(symbol: &str) -> Option<String> {
	is_jp_symbol(symbol).then(|| format!("{symbol}0"))
}

/* ---------- Market dates ---------- */

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

fn year_of_day(day: i64) -> i64 {
	iso_date_of_day_number(day)
		.get(..4)
		.and_then(|year| year.parse().ok())
		.unwrap_or(1970)
}

/// The day number of the `nth` Sunday of `month` (1-based) of `year`.
fn nth_sunday_day(year: i64, month: u32, nth: i64) -> i64 {
	let first = iso_day_number(&format!("{year:04}-{month:02}-01")).unwrap_or(0);
	// 1970-01-01 was a Thursday (weekday 4, Sunday 0).
	let weekday = (first + 4).rem_euclid(7);
	first + (7 - weekday).rem_euclid(7) + (nth - 1) * 7
}

/// `newYorkDate`: the America/New_York date of an instant (US daylight time
/// from the second Sunday of March 02:00 EST to the first Sunday of
/// November 02:00 EDT).
#[must_use]
pub fn new_york_date(epoch_ms: i64) -> String {
	let year = year_of_day(epoch_ms.div_euclid(DAY_MS));
	let daylight_start = nth_sunday_day(year, 3, 2) * DAY_MS + 7 * HOUR_MS;
	let daylight_end = nth_sunday_day(year, 11, 1) * DAY_MS + 6 * HOUR_MS;
	let offset = if epoch_ms >= daylight_start && epoch_ms < daylight_end {
		-4 * HOUR_MS
	} else {
		-5 * HOUR_MS
	};
	iso_date_of_day_number((epoch_ms + offset).div_euclid(DAY_MS))
}

/// `tokyoDate`: the Asia/Tokyo date of an instant (UTC+9).
#[must_use]
pub fn tokyo_date(epoch_ms: i64) -> String {
	iso_date_of_day_number((epoch_ms + 9 * HOUR_MS).div_euclid(DAY_MS))
}

/// `marketToday`.
#[must_use]
pub fn market_today(market: WatchMarket, epoch_ms: i64) -> String {
	match market {
		WatchMarket::Us => new_york_date(epoch_ms),
		WatchMarket::Jp => tokyo_date(epoch_ms),
	}
}

/* ---------- Day outcomes ---------- */

/// `delayedDayOutcome`.
#[must_use]
pub const fn delayed_day_outcome(age_days: i64, delay_days: i64) -> Option<StockPriceDayOutcome> {
	if age_days < delay_days {
		Some(StockPriceDayOutcome::NotYetAvailable)
	} else {
		None
	}
}

/// `emptyDayOutcome`.
#[must_use]
pub const fn empty_day_outcome(age_days: i64, delay_days: i64) -> StockPriceDayOutcome {
	if age_days > delay_days + limits::SETTLE_DAYS {
		StockPriceDayOutcome::NoTrading
	} else {
		StockPriceDayOutcome::NotYetAvailable
	}
}

/// `planRefusalOutcome`: `None` when the plan lacks the data (the job fails).
#[must_use]
pub const fn plan_refusal_outcome(age_days: i64, delay_days: i64) -> Option<StockPriceDayOutcome> {
	if age_days <= delay_days + limits::SETTLE_DAYS {
		Some(StockPriceDayOutcome::NotYetAvailable)
	} else if age_days > delay_days + PLAN_REFUSAL_TOO_OLD_DAYS {
		Some(StockPriceDayOutcome::TooOld)
	} else {
		None
	}
}

/* ---------- Bars ---------- */

/// `providerPrice`: a finite JSON number.
#[must_use]
pub fn provider_price(value: Option<&Value>) -> Option<f64> {
	match value {
		Some(Value::Number(number)) if number.is_finite() => Some(*number),
		_ => None,
	}
}

/// `providerVolume`: a finite, non-negative JSON number.
#[must_use]
pub fn provider_volume(value: Option<&Value>) -> Option<f64> {
	provider_price(value).filter(|volume| *volume >= 0.0)
}

/// `consistentBar`: the close and its bar when every price is readable and
/// the bar is consistent.
#[must_use]
pub fn consistent_bar(
	open: Option<&Value>,
	high: Option<&Value>,
	low: Option<&Value>,
	close: Option<&Value>,
	volume: Option<&Value>,
) -> Option<(f64, MarketBar)> {
	let bar = MarketBar {
		open: provider_price(open)?,
		high: provider_price(high)?,
		low: provider_price(low)?,
		volume: provider_volume(volume),
	};
	let close = provider_price(close)?;
	bar.is_consistent_with(close).then_some((close, bar))
}

/// `finishDayBars`: symbol-sorted, symbol-unique (first wins), capped.
#[must_use]
pub fn finish_day_bars(mut bars: Vec<StockDayBar>) -> Vec<StockDayBar> {
	// Stable, like JavaScript's sort: the first of two bars of one symbol stays first.
	bars.sort_by(|a, b| a.0.cmp(&b.0));
	bars.dedup_by(|later, earlier| later.0 == earlier.0);
	bars.truncate(limits::MAX_BARS_PER_DAY);
	bars
}

/// `finishHistoryBars`: within `[from, to]`, ascending, date-unique (first
/// wins), the newest `MAX_BARS_PER_HISTORY`.
#[must_use]
pub fn finish_history_bars(
	bars: Vec<StockHistoryBar>,
	from: &str,
	to: &str,
) -> Vec<StockHistoryBar> {
	let mut inside: Vec<StockHistoryBar> = bars
		.into_iter()
		.filter(|bar| bar.0.as_str() >= from && bar.0.as_str() <= to)
		.collect();
	inside.sort_by(|a, b| a.0.cmp(&b.0));
	inside.dedup_by(|later, earlier| later.0 == earlier.0);
	let excess = inside.len().saturating_sub(limits::MAX_BARS_PER_HISTORY);
	inside.drain(..excess);
	inside
}

/* ---------- The job ---------- */

fn failed_outcome(problem: StockPriceProblem) -> StockPricesOutcome {
	match problem {
		StockPriceProblem::RateLimited(status) => StockPricesOutcome::Failed {
			code: MarketUnavailableCode::RateLimited,
			upstream_status: status,
			retryable: false,
		},
		other => StockPricesOutcome::Failed {
			code: MarketUnavailableCode::SourceFailed,
			upstream_status: other.status(),
			retryable: true,
		},
	}
}

const fn auth_failed(status: Option<u16>) -> StockPricesOutcome {
	StockPricesOutcome::Failed {
		code: MarketUnavailableCode::SourceAuthFailed,
		upstream_status: status,
		retryable: false,
	}
}

/// The walk's mutable state.
struct Walk<'a> {
	source: &'a dyn StockPriceSource,
	context: StockPriceRequestContext<'a>,
	histories: Vec<StockHistoryResult>,
	fetched: HashSet<String>,
	ended: Option<StockPriceProblem>,
	newest_available: String,
	safe_start: String,
}

impl Walk<'_> {
	/// `fetchWindow`: `Some` outcome when the job ends here.
	async fn fetch_window(
		&mut self,
		symbol: &str,
		requested_from: &str,
		requested_to: &str,
		reason: StockHistoryReason,
	) -> Option<StockPricesOutcome> {
		self.fetched.insert(symbol.to_owned());
		let mut from = requested_from.to_owned();
		let to = if requested_to > self.newest_available.as_str() {
			self.newest_available.clone()
		} else {
			requested_to.to_owned()
		};
		if from > to {
			return None;
		}
		let mut answer = self
			.source
			.fetch_history(symbol, &from, &to, &self.context)
			.await;
		if matches!(answer, Err(StockPriceProblem::PlanRefused(_)))
			&& from < self.safe_start
			&& self.safe_start <= to
		{
			from.clone_from(&self.safe_start);
			answer = self
				.source
				.fetch_history(symbol, &from, &to, &self.context)
				.await;
		}
		match answer {
			Ok(bars) => {
				let bars = finish_history_bars(bars, &from, &to);
				let outcome = if bars.is_empty() {
					StockHistoryOutcome::NotFound
				} else {
					StockHistoryOutcome::Stored
				};
				self.histories.push(StockHistoryResult {
					symbol: symbol.to_owned(),
					reason,
					outcome,
					from,
					to,
					bars,
				});
				None
			}
			Err(StockPriceProblem::Stopped) => Some(StockPricesOutcome::Stopped),
			Err(StockPriceProblem::AuthFailed(status)) => Some(auth_failed(status)),
			Err(StockPriceProblem::NotFound(_)) => {
				self.histories.push(StockHistoryResult {
					symbol: symbol.to_owned(),
					reason,
					outcome: StockHistoryOutcome::NotFound,
					from,
					to,
					bars: Vec::new(),
				});
				None
			}
			// A plan refusal leaves this stock for the next job; the others go on.
			Err(StockPriceProblem::PlanRefused(_)) => None,
			Err(problem) => {
				self.ended = Some(problem);
				None
			}
		}
	}
}

/// `syncStockPrices`: runs one claim against its market's source; requests
/// are sequential and each passes the admission first.
pub async fn sync_stock_prices(
	job: &StockPricesClaim,
	source: &dyn StockPriceSource,
	now_ms: i64,
	cancel: &CancellationToken,
	before_request: &dyn AdmitRequest,
) -> StockPricesOutcome {
	let context = StockPriceRequestContext {
		cancel,
		before_request,
	};
	let today = iso_day_number(&market_today(source.market(), now_ms)).unwrap_or(0);
	let delay = source.delay_days();
	let mut days: Vec<StockPriceDayResult> = Vec::new();
	let mut reported: HashSet<String> = HashSet::new();
	let mut adjusted: Vec<String> = Vec::new();
	let mut newest_stored: Option<String> = None;
	let mut ended: Option<StockPriceProblem> = None;

	for date in &job.days {
		if cancel.is_cancelled() {
			return StockPricesOutcome::Stopped;
		}
		let Some(day_number) = iso_day_number(date) else {
			continue;
		};
		if reported.contains(date) {
			continue;
		}
		let age = today - day_number;
		if let Some(outcome) = delayed_day_outcome(age, delay) {
			reported.insert(date.clone());
			days.push(day_result(date, outcome, Vec::new(), None));
			continue;
		}
		match source.fetch_day(date, &context).await {
			Err(StockPriceProblem::Stopped) => return StockPricesOutcome::Stopped,
			Err(StockPriceProblem::AuthFailed(status)) => return auth_failed(status),
			Err(StockPriceProblem::PlanRefused(status)) => {
				let Some(outcome) = plan_refusal_outcome(age, delay) else {
					return StockPricesOutcome::Failed {
						code: MarketUnavailableCode::PlanNotEntitled,
						upstream_status: Some(status),
						retryable: false,
					};
				};
				reported.insert(date.clone());
				days.push(day_result(date, outcome, Vec::new(), Some(status)));
			}
			Err(problem) => {
				ended = Some(problem);
				break;
			}
			Ok(answer) => {
				reported.insert(date.clone());
				if answer.bars.is_empty() {
					days.push(day_result(
						date,
						empty_day_outcome(age, delay),
						Vec::new(),
						None,
					));
					continue;
				}
				days.push(day_result(
					date,
					StockPriceDayOutcome::Stored,
					answer.bars,
					None,
				));
				if newest_stored
					.as_deref()
					.is_none_or(|newest| date.as_str() > newest)
				{
					newest_stored = Some(date.clone());
				}
				if job
					.adjustments_since
					.as_deref()
					.is_some_and(|since| date.as_str() > since)
				{
					adjusted.extend(answer.adjusted_symbols);
				}
			}
		}
	}

	let mut walk = Walk {
		source,
		context,
		histories: Vec::new(),
		fetched: HashSet::new(),
		ended,
		newest_available: iso_date_of_day_number(today - delay),
		safe_start: iso_date_of_day_number(today - delay - PLAN_HISTORY_SAFE_DAYS),
	};
	for request in &job.histories {
		if walk.ended.is_some() {
			break;
		}
		if cancel.is_cancelled() {
			return StockPricesOutcome::Stopped;
		}
		if walk.fetched.contains(&request.symbol) || request.from > request.to {
			continue;
		}
		if let Some(stop) = walk
			.fetch_window(
				&request.symbol,
				&request.from,
				&request.to,
				StockHistoryReason::Requested,
			)
			.await
		{
			return stop;
		}
	}

	let mut splits_over_cap = 0;
	if let (None, Some(since), Some(newest)) = (
		walk.ended,
		job.adjustments_since.as_deref(),
		newest_stored.as_deref(),
	) && newest > since
		&& job.window_start.as_str() <= newest
	{
		let mut symbols = adjusted;
		if !source.splits_in_day_answers() {
			if cancel.is_cancelled() {
				return StockPricesOutcome::Stopped;
			}
			match source
				.fetch_split_symbols(since, newest, &walk.context)
				.await
			{
				Ok(listed) => symbols = listed,
				Err(StockPriceProblem::Stopped) => return StockPricesOutcome::Stopped,
				Err(StockPriceProblem::AuthFailed(status)) => return auth_failed(status),
				Err(problem) => {
					if matches!(
						problem,
						StockPriceProblem::RateLimited(_) | StockPriceProblem::Failed(_)
					) {
						walk.ended = Some(problem);
					}
					symbols = Vec::new();
				}
			}
		}
		let requested: HashSet<&str> = job
			.histories
			.iter()
			.map(|request| request.symbol.as_str())
			.collect();
		let mut candidates: Vec<String> = Vec::new();
		for symbol in symbols {
			if requested.contains(symbol.as_str()) || candidates.contains(&symbol) {
				continue;
			}
			candidates.push(symbol);
		}
		let room = limits::MAX_HISTORIES_PER_JOB.saturating_sub(job.histories.len());
		splits_over_cap = candidates.len().saturating_sub(room);
		for symbol in candidates.iter().take(room) {
			if walk.ended.is_some() {
				break;
			}
			if cancel.is_cancelled() {
				return StockPricesOutcome::Stopped;
			}
			if let Some(stop) = walk
				.fetch_window(symbol, &job.window_start, newest, StockHistoryReason::Split)
				.await
			{
				return stop;
			}
		}
	}

	if days.is_empty()
		&& walk.histories.is_empty()
		&& let Some(problem) = walk.ended
	{
		return failed_outcome(problem);
	}
	StockPricesOutcome::Synced {
		days,
		histories: walk.histories,
		splits_over_cap,
		ended_by: walk.ended.map(|problem| match problem {
			StockPriceProblem::RateLimited(_) => EndedBy::RateLimited,
			_ => EndedBy::Failed,
		}),
	}
}

/* ---------- The job shell ---------- */

/// What a `stock-prices-sync` job needs from the runner.
pub struct StockPricesDeps<'a> {
	/// Wall clock.
	pub clock: &'a dyn Clock,
	/// Logger.
	pub logger: &'a dyn EventLogger,
	/// Shared provider quota gate (`massive`, `jquants`).
	pub pacer: &'a dyn MarketPacer,
	/// Sources by market; a market without its key has none.
	pub sources: &'a HashMap<WatchMarket, Arc<dyn StockPriceSource>>,
}

/// The provider's pacing admission for every request a source sends.
struct PacerGate<'a> {
	pacer: &'a dyn MarketPacer,
	provider: &'a str,
	cancel: &'a CancellationToken,
}

#[async_trait]
impl AdmitRequest for PacerGate<'_> {
	async fn admit(&self) -> MarketRequestAdmission {
		self.pacer.admit(self.provider, self.cancel).await
	}
}

/// What an unexpected source fault is logged as (the TypeScript logs the
/// thrown `Error.name`; a Rust panic is the same kind of fault).
const SOURCE_FAULT_CLASS: &str = "Error";

fn log_count(count: usize) -> LogValue<'static> {
	LogValue::from(i64::try_from(count).unwrap_or(i64::MAX))
}

/// Runs a claimed `stock-prices-sync` job (`executeStockPricesSync`): the
/// market's source fetches the claimed days newest first, the requested
/// windows and the split refetches, paced under the provider's id. The job
/// completes with `stock-prices-synced`, or `failed` with a market code and
/// the provider's status unchanged (ADR-0037); a missing key fails at once
/// without a request. A completion the API would refuse fails here as
/// `SOURCE_FAILED` instead. Logs carry dates, codes and counts only.
pub async fn execute_stock_prices_sync(
	job: &StockPricesSyncJob,
	deps: &StockPricesDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let market = job.claim.market;
	let provider = stock_price_provider_of_market(market);
	let fetched_at = deps.clock.now_iso();
	let outcome = match deps.sources.get(&market) {
		None => StockPricesOutcome::Failed {
			code: MarketUnavailableCode::SourceNotConfigured,
			upstream_status: None,
			retryable: false,
		},
		Some(source) => {
			let gate = PacerGate {
				pacer: deps.pacer,
				provider: provider.as_str(),
				cancel,
			};
			AssertUnwindSafe(sync_stock_prices(
				&job.claim,
				source.as_ref(),
				deps.clock.now_ms(),
				cancel,
				&gate,
			))
			.catch_unwind()
			.await
			.unwrap_or_else(|_| {
				deps.logger.warn(
					"stock_prices_source_failed",
					&[
						("market", LogValue::from(market.as_str())),
						("error", LogValue::from(SOURCE_FAULT_CLASS)),
					],
				);
				StockPricesOutcome::Failed {
					code: MarketUnavailableCode::SourceFailed,
					upstream_status: None,
					retryable: true,
				}
			})
		}
	};
	for state in [
		JobState::Analyzing,
		JobState::Verifying,
		JobState::Publishing,
	] {
		reporter.state(state).await;
	}
	let lease_generation = job.lease.lease_generation;
	let failed = |code: MarketUnavailableCode, upstream_status: Option<u16>, retryable: bool| {
		CompleteJobRequest::Failed {
			lease_generation,
			usage: EMPTY_USAGE,
			failure_code: code.as_str().to_owned(),
			failure_detail: Tri::Absent,
			// The provider's own status, unchanged (§4a).
			failure_upstream_status: Tri::or_absent(upstream_status),
			retryable,
		}
	};
	let (days, histories, splits_over_cap, ended_by) = match outcome {
		// A stop is decided by the caller (cancelled, abandoned or released).
		StockPricesOutcome::Stopped => {
			return failed(MarketUnavailableCode::SourceFailed, None, true);
		}
		StockPricesOutcome::Failed {
			code,
			upstream_status,
			retryable,
		} => {
			deps.logger.warn(
				"stock_prices_failed",
				&[
					("market", LogValue::from(market.as_str())),
					("provider", LogValue::from(provider.as_str())),
					("code", LogValue::from(code.as_str())),
					(
						"upstreamStatus",
						LogValue::from(upstream_status.map(i64::from)),
					),
				],
			);
			return failed(code, upstream_status, retryable);
		}
		StockPricesOutcome::Synced {
			days,
			histories,
			splits_over_cap,
			ended_by,
		} => (days, histories, splits_over_cap, ended_by),
	};
	if splits_over_cap > 0 {
		// These stocks keep their pre-split bars until a later split check names them.
		deps.logger.warn(
			"stock_prices_splits_over_cap",
			&[
				("market", LogValue::from(market.as_str())),
				("skipped", log_count(splits_over_cap)),
			],
		);
	}
	let stored_days = days
		.iter()
		.filter(|day| day.outcome == StockPriceDayOutcome::Stored)
		.count();
	let bars: usize = days.iter().map(|day| day.bars.len()).sum();
	let day_count = days.len();
	let history_count = histories.len();
	let completion = CompleteJobRequest::StockPricesSynced {
		lease_generation,
		usage: EMPTY_USAGE,
		market,
		provider,
		fetched_at,
		days,
		histories,
	};
	if check_outgoing(&completion).is_err() {
		deps.logger.warn(
			"stock_prices_rejected",
			&[
				("runId", LogValue::from(job.lease.run_id.as_str())),
				("market", LogValue::from(market.as_str())),
			],
		);
		return failed(MarketUnavailableCode::SourceFailed, None, false);
	}
	deps.logger.info(
		"stock_prices_synced",
		&[
			("market", LogValue::from(market.as_str())),
			("provider", LogValue::from(provider.as_str())),
			("days", log_count(day_count)),
			("storedDays", log_count(stored_days)),
			("bars", log_count(bars)),
			("histories", log_count(history_count)),
			("endedBy", LogValue::from(ended_by.map(EndedBy::as_str))),
		],
	);
	completion
}

fn day_result(
	date: &str,
	outcome: StockPriceDayOutcome,
	bars: Vec<StockDayBar>,
	upstream_status: Option<u16>,
) -> StockPriceDayResult {
	StockPriceDayResult {
		date: date.to_owned(),
		outcome,
		bars,
		upstream_status,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn tickers_map_both_ways() {
		for (ticker, symbol) in [
			("BRK.B", "BRK-B"),
			("KIMpL", "KIM-PL"),
			("DCOMp", "DCOM-P"),
			("AAC.WS", "AAC-WT"),
			("NE.WS.A", "NE-WTA"),
			("AAC.U", "AAC-UN"),
			("AIIAr", "AIIA-RI"),
			("MSGKw", "MSGK-WI"),
		] {
			assert_eq!(massive_ticker_to_symbol(ticker).as_deref(), Some(symbol));
			assert_eq!(symbol_to_massive_ticker(symbol).as_deref(), Some(ticker));
		}
		assert_eq!(jquants_code_to_symbol("130A0").as_deref(), Some("130A"));
		assert_eq!(jquants_code_to_symbol("25935"), None);
	}

	#[test]
	fn new_york_follows_daylight_time() {
		// 2026-07-01T03:59:59Z is still June 30 in New York (EDT).
		assert_eq!(new_york_date(1_782_878_399_000), "2026-06-30");
		assert_eq!(new_york_date(1_782_878_400_000), "2026-07-01");
	}
}
