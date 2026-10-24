//! Market-refresh, earnings-refresh and stock-directory-refresh job bodies;
//! the shell owns leases and event delivery.
use crate::{pacing::MarketPacer, ports::*};
use async_trait::async_trait;
use futures_util::FutureExt;
use indexmap::IndexMap;
use research_application::{ports::Clock, reporter::PipelineReporter};
use research_contracts::{
	Tri, check_outgoing,
	jobs::*,
	market::{MarketObservation, MarketUnavailableCode, parse_market_series_id},
	stock_directory::{StockDirectoryFailureCode, stock_directory_source_id},
	watchlist::{EarningsUnavailableCode, WatchMarket, earnings_source_by_market, parse_stock_id},
};
use research_effects::{EventLogger, LogValue};
use std::{collections::HashMap, panic::AssertUnwindSafe};
use tokio_util::sync::CancellationToken;
/// What an unexpected adapter fault is logged as: TypeScript logs the thrown
/// `Error.name`, and a Rust panic is the same kind of programming fault.
const ADAPTER_FAULT_CLASS: &str = "Error";

/// Source registries and process-wide pacing.
pub struct RefreshDeps<'a> {
	/// Wall clock.
	pub clock: &'a dyn Clock,
	/// Logger.
	pub logger: &'a dyn EventLogger,
	/// Shared provider quota gate.
	pub pacer: &'a dyn MarketPacer,
	/// Market sources keyed by provider id.
	pub market_sources: &'a HashMap<String, std::sync::Arc<dyn MarketSeriesSource>>,
	/// Earnings sources keyed by source id.
	pub earnings_sources: &'a HashMap<String, std::sync::Arc<dyn EarningsCalendarSource>>,
}
async fn finish(reporter: &dyn PipelineReporter) {
	for state in [
		JobState::Analyzing,
		JobState::Verifying,
		JobState::Publishing,
	] {
		reporter.state(state).await;
	}
}
/// Executes claimed series sequentially, preserving timestamps and abort/break semantics.
pub async fn execute_market_refresh(
	job: &MarketRefreshJob,
	deps: &RefreshDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let mut series = Vec::new();
	for entry in &job.series {
		if cancel.is_cancelled() {
			break;
		}
		let fetched_at = deps.clock.now_iso();
		let mut output = MarketRefreshedSeries {
			series_id: entry.series_id.clone(),
			fetched_at,
			meta: None,
			observations: Vec::new(),
			error_code: None,
		};
		match parse_market_series_id(&entry.series_id) {
			Err(_) => output.error_code = Some(MarketUnavailableCode::SeriesNotFound),
			Ok(parsed) => match deps.market_sources.get(parsed.provider.as_str()) {
				None => output.error_code = Some(MarketUnavailableCode::SourceNotConfigured),
				Some(source) => {
					if !deps
						.pacer
						.pace(parsed.provider.as_str(), cancel, None)
						.await || cancel.is_cancelled()
					{
						break;
					}
					// An adapter fault (a panic, the Rust form of a TypeScript
					// throw) is logged by class and fails this series only.
					let fetched = AssertUnwindSafe(source.fetch_series(SeriesQuery {
						symbol: parsed.symbol,
						since: entry.latest_observed_on.as_deref(),
						max_observations: 800,
						cancel,
					}))
					.catch_unwind()
					.await;
					match fetched {
						Err(_) => {
							deps.logger.warn(
								"market_series_failed",
								&[
									("seriesId", LogValue::from(entry.series_id.as_str())),
									("error", LogValue::from(ADAPTER_FAULT_CLASS)),
								],
							);
							output.error_code = Some(MarketUnavailableCode::SourceFailed);
						}
						Ok(Err(error)) => output.error_code = Some(error.code),
						Ok(Ok(result)) => {
							output.meta = Some(result.meta);
							let start = result.observations.len().saturating_sub(800);
							output.observations = result
								.observations
								.into_iter()
								.skip(start)
								.map(|p| MarketObservation(p.observed_on, p.value))
								.collect();
						}
					}
				}
			},
		}
		series.push(output);
	}
	finish(reporter).await;
	CompleteJobRequest::MarketRefreshed {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		series,
	}
}
struct SourceGate<'a> {
	pacer: &'a dyn MarketPacer,
	id: &'a str,
	cancel: &'a CancellationToken,
}
#[async_trait]
impl BeforeRequest for SourceGate<'_> {
	async fn before_request(&self) -> bool {
		self.pacer.pace(self.id, self.cancel, None).await
	}
}
// RECORDED (ported as-is): when a source returns the right number of results, a
// stock whose symbol repeats takes the first not-yet-answered claim entry
// (`order.find(... && !byId.has)`), exactly like the TypeScript.
/// Groups by first-seen source, executes each group sequentially and restores claim order.
pub async fn execute_earnings_refresh(
	job: &EarningsRefreshJob,
	deps: &RefreshDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let mut groups: IndexMap<String, Vec<EarningsStock>> = IndexMap::new();
	let mut order = Vec::new();
	let mut by_id: IndexMap<String, EarningsRefreshedStock> = IndexMap::new();
	for stock in &job.stocks {
		let fetched_at = deps.clock.now_iso();
		match parse_stock_id(&stock.stock_id) {
			Err(_) => {
				by_id.insert(
					stock.stock_id.clone(),
					EarningsRefreshedStock {
						stock_id: stock.stock_id.clone(),
						fetched_at,
						name: None,
						events: Vec::new(),
						error_code: Some(EarningsUnavailableCode::SourceFailed),
					},
				);
			}
			Ok(parsed) => {
				let source = earnings_source_by_market(parsed.market).as_str().to_owned();
				groups.entry(source).or_default().push(EarningsStock {
					symbol: parsed.symbol.to_owned(),
					need_name: stock.name.is_none(),
				});
				order.push((stock.stock_id.clone(), parsed.symbol.to_owned()));
			}
		}
	}
	for (id, stocks) in groups {
		if cancel.is_cancelled() {
			break;
		}
		let fetched_at = deps.clock.now_iso();
		let gate = SourceGate {
			pacer: deps.pacer,
			id: &id,
			cancel,
		};
		let failed_all = || -> Vec<EarningsResult> {
			stocks
				.iter()
				.map(|_| Err(EarningsFailure::new(EarningsUnavailableCode::SourceFailed)))
				.collect()
		};
		let log_failure = |error: &str| {
			deps.logger.warn(
				"earnings_source_failed",
				&[
					("source", LogValue::from(id.as_str())),
					("error", LogValue::from(error)),
				],
			);
		};
		let results = match deps.earnings_sources.get(&id) {
			None => stocks
				.iter()
				.map(|_| {
					Err(EarningsFailure::new(
						EarningsUnavailableCode::SourceNotConfigured,
					))
				})
				.collect(),
			Some(source) => {
				let fetched = AssertUnwindSafe(source.fetch_earnings(EarningsQuery {
					stocks: &stocks,
					from_date: &job.from_date,
					to_date: &job.to_date,
					cancel,
					before_request: &gate,
				}))
				.catch_unwind()
				.await;
				match fetched {
					Err(_) => {
						log_failure(ADAPTER_FAULT_CLASS);
						failed_all()
					}
					// The port promises one result per symbol in order; a short
					// batch is a contract breach, failed closed for the whole source.
					Ok(results) if results.len() != stocks.len() => {
						log_failure("RangeError");
						failed_all()
					}
					Ok(results) => results,
				}
			}
		};
		for (stock, result) in stocks.iter().zip(results) {
			let Some((stock_id, _)) = order
				.iter()
				.find(|(id, symbol)| symbol == &stock.symbol && !by_id.contains_key(id))
			else {
				continue;
			};
			let mut output = EarningsRefreshedStock {
				stock_id: stock_id.clone(),
				fetched_at: fetched_at.clone(),
				name: None,
				events: Vec::new(),
				error_code: None,
			};
			match result {
				Ok(mut data) => {
					data.events.truncate(8);
					output.name = data.name;
					output.events = data.events;
				}
				Err(error) => {
					output.error_code = Some(error.code);
					output.name = error.name.flatten();
				}
			}
			by_id.insert(stock_id.clone(), output);
		}
	}
	let mut stocks: Vec<_> = by_id.into_values().collect();
	stocks.sort_by_key(|s| {
		job.stocks
			.iter()
			.position(|claim| claim.stock_id == s.stock_id)
	});
	finish(reporter).await;
	CompleteJobRequest::EarningsRefreshed {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		stocks,
	}
}

/// What a stock-directory refresh needs (ADR-0034).
pub struct DirectoryDeps<'a> {
	/// Wall clock.
	pub clock: &'a dyn Clock,
	/// Logger.
	pub logger: &'a dyn EventLogger,
	/// Shared provider quota gate (`sec`, `jpx`).
	pub pacer: &'a dyn MarketPacer,
	/// Sources by market.
	pub sources: &'a HashMap<WatchMarket, std::sync::Arc<dyn StockDirectorySource>>,
}

/// Runs a claimed stock-directory-refresh job (port of
/// `executeStockDirectoryRefresh`): downloads the leased market's list and
/// completes with `stock-directory-refreshed`, or `failed` with a stable
/// code. The source's requests pace through the shared window of its host,
/// so a directory refresh and an earnings refresh never exceed JPX's budget
/// together. The completion is checked against its contract before it is
/// sent: a list the API would refuse fails here as `DIRECTORY_PARSE_FAILED`,
/// so a stored list is never replaced by a broken one. Only
/// `DIRECTORY_SOURCE_FAILED` is retried by the API.
pub async fn execute_stock_directory_refresh(
	job: &StockDirectoryRefreshJob,
	deps: &DirectoryDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let fetched_at = deps.clock.now_iso();
	let result = fetch_stock_directory(job.market, deps, cancel).await;
	finish(reporter).await;
	let lease_generation = job.lease.lease_generation;
	let failed = |code: StockDirectoryFailureCode| CompleteJobRequest::Failed {
		lease_generation,
		usage: EMPTY_USAGE,
		failure_code: code.as_str().to_owned(),
		failure_detail: Tri::Absent,
		retryable: code == StockDirectoryFailureCode::SourceFailed,
	};
	let data = match result {
		Ok(data) => data,
		Err(code) => return failed(code),
	};
	let count = i64::try_from(data.entries.len()).unwrap_or(i64::MAX);
	let completion = CompleteJobRequest::StockDirectoryRefreshed {
		lease_generation,
		usage: EMPTY_USAGE,
		market: job.market,
		as_of: data.as_of,
		fetched_at,
		entries: data.entries,
	};
	if check_outgoing(&completion).is_err() {
		deps.logger.warn(
			"stock_directory_rejected",
			&[
				("runId", LogValue::from(job.lease.run_id.as_str())),
				("market", LogValue::from(job.market.as_str())),
			],
		);
		return failed(StockDirectoryFailureCode::ParseFailed);
	}
	deps.logger.info(
		"stock_directory_fetched",
		&[
			("runId", LogValue::from(job.lease.run_id.as_str())),
			("market", LogValue::from(job.market.as_str())),
			("entries", LogValue::from(count)),
		],
	);
	completion
}

/// The market's source answer; an absent source is unconfigured, a panic a source failure.
async fn fetch_stock_directory(
	market: WatchMarket,
	deps: &DirectoryDeps<'_>,
	cancel: &CancellationToken,
) -> Result<StockDirectoryData, StockDirectoryFailureCode> {
	let Some(source) = deps.sources.get(&market) else {
		return Err(StockDirectoryFailureCode::NotConfigured);
	};
	let gate = SourceGate {
		pacer: deps.pacer,
		id: stock_directory_source_id(market).as_str(),
		cancel,
	};
	let fetched = AssertUnwindSafe(source.fetch_directory(StockDirectoryQuery {
		cancel,
		before_request: &gate,
	}))
	.catch_unwind()
	.await;
	fetched.unwrap_or_else(|_| {
		// An adapter fault (the Rust form of a TypeScript throw) is logged by
		// class, never by message or URL (SEC-010).
		deps.logger.warn(
			"stock_directory_source_failed",
			&[
				("market", LogValue::from(market.as_str())),
				("error", LogValue::from(ADAPTER_FAULT_CLASS)),
			],
		);
		Err(StockDirectoryFailureCode::SourceFailed)
	})
}
