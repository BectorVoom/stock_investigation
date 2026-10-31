//! Market-refresh, earnings-refresh, stock-directory-refresh and
//! financial-sync job bodies; the shell owns leases and event delivery.
use crate::{
	equity_sync::{EquitySyncFailure, EquitySyncQuery, EquitySyncSource},
	pacing::MarketPacer,
	ports::*,
};
use async_trait::async_trait;
use futures_util::FutureExt;
use indexmap::IndexMap;
use research_application::{ports::Clock, reporter::PipelineReporter};
use research_contracts::{
	Tri, check_outgoing,
	equity_financials::{EquityProvider, EquitySyncFailureCode},
	jobs::*,
	market::{
		MarketHistoryWrite, MarketObservation, MarketSeriesId, MarketUnavailableCode,
		limits::MAX_OBSERVATIONS_PER_RESPONSE, parse_market_series_id,
	},
	stock_directory::{StockDirectoryFailureCode, stock_directory_source_id},
	watchlist::{EarningsUnavailableCode, WatchMarket, earnings_source_by_market, parse_stock_id},
};
use research_domain::market::history_refresh::{
	HistoryFetch, HistoryOutcome, HistoryPoint, HistoryRefreshRequest, HistoryWrite,
	first_history_fetch, history_outcome,
};
use research_effects::{EventLogger, LogValue};
use std::{
	collections::{HashMap, HashSet},
	panic::AssertUnwindSafe,
	sync::atomic::{AtomicBool, Ordering},
};
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
/// One paced provider request for a series: its answer, its failure, or a stop.
enum SeriesAnswer {
	/// An admission was stopped (the run was cancelled): end the refresh.
	Stopped,
	/// The series failed with this code and the provider's status (§4a).
	Failed(MarketUnavailableCode, Tri<u16>),
	/// Ascending, date-unique points (the adapters guarantee it), cut to one
	/// response's worth.
	Answered(SeriesData),
}

/// Asks the provider for `entry`'s series. The adapter admits each HTTP
/// request it actually sends through the provider's pacing gate (API-007): a
/// refusal or cancellation while waiting stops the refresh without fetching,
/// and a spent daily budget fails the series as `RATE_LIMITED` without
/// sending. The answer is cut to the newest `MAX_OBSERVATIONS_PER_RESPONSE`
/// here, before the history decision, so a write's `replaceFrom` is always
/// one of the dates the completion carries.
async fn fetch_series_answer(
	source: &dyn MarketSeriesSource,
	entry: &MarketRefreshSeries,
	target: &MarketSeriesId<'_>,
	fetch: HistoryFetch<'_>,
	deps: &RefreshDeps<'_>,
	cancel: &CancellationToken,
) -> SeriesAnswer {
	let gate = SeriesGate {
		pacer: deps.pacer,
		provider: target.provider.as_str(),
		cancel,
		stopped: AtomicBool::new(false),
	};
	// An adapter fault (a panic, the Rust form of a TypeScript throw) is
	// logged by class and fails this series only.
	let fetched = AssertUnwindSafe(source.fetch_series(SeriesQuery {
		symbol: target.symbol,
		from: match fetch {
			HistoryFetch::Window { from } => Some(from),
			HistoryFetch::Full => None,
		},
		max_observations: MAX_OBSERVATIONS_PER_RESPONSE,
		cancel,
		before_request: &gate,
	}))
	.catch_unwind()
	.await;
	// A stopped admission sent nothing (or not the rest): nothing is reported for the series.
	if gate.stopped.load(Ordering::SeqCst) {
		return SeriesAnswer::Stopped;
	}
	match fetched {
		Err(_) => {
			deps.logger.warn(
				"market_series_failed",
				&[
					("seriesId", LogValue::from(entry.series_id.as_str())),
					("error", LogValue::from(ADAPTER_FAULT_CLASS)),
				],
			);
			SeriesAnswer::Failed(MarketUnavailableCode::SourceFailed, Tri::Absent)
		}
		// The provider's own status, unchanged (§4a).
		Ok(Err(error)) => SeriesAnswer::Failed(error.code, Tri::or_null(error.upstream_status)),
		Ok(Ok(mut data)) => {
			let excess = data
				.observations
				.len()
				.saturating_sub(MAX_OBSERVATIONS_PER_RESPONSE);
			data.observations.drain(..excess);
			SeriesAnswer::Answered(data)
		}
	}
}

/// The claim's history request for one series (ADR-0044), as the domain reads it.
fn history_request(entry: &MarketRefreshSeries) -> HistoryRefreshRequest {
	HistoryRefreshRequest {
		anchor: entry.anchor.as_ref().map(|anchor| HistoryPoint {
			observed_on: anchor.observed_on.clone(),
			value: anchor.value,
		}),
		full_check: entry.full_check,
	}
}

/// The domain's write as the completion carries it.
fn wire_write(write: HistoryWrite) -> MarketHistoryWrite {
	match write {
		HistoryWrite::Window { replace_from } => MarketHistoryWrite::Window { replace_from },
		HistoryWrite::Full { replace_from } => MarketHistoryWrite::Full { replace_from },
	}
}

/// Executes claimed series sequentially, preserving timestamps and abort/break semantics.
///
/// Each series is refreshed incrementally (ADR-0044): the first request asks
/// from the claim's anchor (or for everything when there is none or a full
/// check is due); when the window does not reproduce the anchor, the provider
/// changed older history and a second, paced request fetches everything in
/// the same job. The completion carries how the answer replaces the stored
/// history (`history`), decided by the domain rule.
pub async fn execute_market_refresh(
	job: &MarketRefreshJob,
	deps: &RefreshDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let mut series = Vec::new();
	// The API claims each series once; a repeated id is skipped (first wins)
	// because the completion contract refuses two entries for one series —
	// two history writes would not store what merging them one by one does.
	let mut claimed: HashSet<&str> = HashSet::with_capacity(job.series.len());
	'series: for entry in &job.series {
		if cancel.is_cancelled() {
			break;
		}
		if !claimed.insert(entry.series_id.as_str()) {
			continue;
		}
		let fetched_at = deps.clock.now_iso();
		let mut output = MarketRefreshedSeries {
			series_id: entry.series_id.clone(),
			fetched_at,
			meta: None,
			observations: Vec::new(),
			error_code: None,
			upstream_status: Tri::Absent,
			history: None,
		};
		let target = match parse_market_series_id(&entry.series_id) {
			Err(_) => {
				output.error_code = Some(MarketUnavailableCode::SeriesNotFound);
				series.push(output);
				continue;
			}
			Ok(target) => target,
		};
		let Some(source) = deps.market_sources.get(target.provider.as_str()) else {
			output.error_code = Some(MarketUnavailableCode::SourceNotConfigured);
			series.push(output);
			continue;
		};
		let request = history_request(entry);
		let mut fetch = first_history_fetch(&request);
		// At most two rounds: `history_outcome` asks for a full refetch only
		// after a window fetch (Lean `HistoryRefresh.refetch_only_after_window`).
		let (data, write) = loop {
			match fetch_series_answer(source.as_ref(), entry, &target, fetch, deps, cancel).await {
				SeriesAnswer::Stopped => break 'series,
				SeriesAnswer::Failed(code, upstream_status) => {
					output.error_code = Some(code);
					output.upstream_status = upstream_status;
					series.push(output);
					continue 'series;
				}
				SeriesAnswer::Answered(data) => {
					match history_outcome(&request, fetch, &data.observations) {
						HistoryOutcome::RefetchFull => fetch = HistoryFetch::Full,
						HistoryOutcome::Store { write } => break (data, write),
					}
				}
			}
		};
		output.meta = Some(data.meta);
		output.observations = data
			.observations
			.into_iter()
			.map(|p| MarketObservation(p.observed_on, p.value))
			.collect();
		output.history = write.map(wire_write);
		series.push(output);
	}
	finish(reporter).await;
	CompleteJobRequest::MarketRefreshed {
		lease_generation: job.lease.lease_generation,
		usage: EMPTY_USAGE,
		series,
	}
}
/// The market job's admission gate for one series request: the pacer's
/// answer, remembering a stop so the job ends the refresh.
struct SeriesGate<'a> {
	pacer: &'a dyn MarketPacer,
	provider: &'a str,
	cancel: &'a CancellationToken,
	stopped: AtomicBool,
}
#[async_trait]
impl AdmitRequest for SeriesGate<'_> {
	async fn admit(&self) -> MarketRequestAdmission {
		let admission = self.pacer.admit(self.provider, self.cancel).await;
		// A grant that arrives with the cancellation still stops the refresh.
		if admission == MarketRequestAdmission::Stopped || self.cancel.is_cancelled() {
			self.stopped.store(true, Ordering::SeqCst);
			return MarketRequestAdmission::Stopped;
		}
		admission
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
						upstream_status: Tri::Absent,
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
		// A whole-source failure the runner decides (no adapter, a fault, a
		// short batch) is not a source answer: like the TypeScript, its
		// entries carry no `upstreamStatus` key at all.
		let failed_all = |code| -> (Vec<EarningsResult>, bool) {
			let results = stocks
				.iter()
				.map(|_| Err(EarningsFailure::new(code, None)))
				.collect();
			(results, false)
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
		let (results, answered) = match deps.earnings_sources.get(&id) {
			None => failed_all(EarningsUnavailableCode::SourceNotConfigured),
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
						failed_all(EarningsUnavailableCode::SourceFailed)
					}
					// The port promises one result per symbol in order; a short
					// batch is a contract breach, failed closed for the whole source.
					Ok(results) if results.len() != stocks.len() => {
						log_failure("RangeError");
						failed_all(EarningsUnavailableCode::SourceFailed)
					}
					Ok(results) => (results, true),
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
				upstream_status: Tri::Absent,
			};
			match result {
				Ok(mut data) => {
					data.events.truncate(8);
					output.name = data.name;
					output.events = data.events;
				}
				Err(error) => {
					output.error_code = Some(error.code);
					// The provider's own status, unchanged (§4a); a
					// listed-nothing success (NO_SCHEDULED_DATE) has none.
					if answered {
						output.upstream_status = Tri::or_null(error.answer_status());
					}
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
	let failed = |failure: StockDirectoryFailure| CompleteJobRequest::Failed {
		lease_generation,
		usage: EMPTY_USAGE,
		failure_code: failure.code.as_str().to_owned(),
		failure_detail: Tri::Absent,
		// SEC's or JPX's own status, unchanged (§4a).
		failure_upstream_status: Tri::or_absent(failure.upstream_status),
		retryable: failure.code == StockDirectoryFailureCode::SourceFailed,
	};
	let data = match result {
		Ok(data) => data,
		Err(failure) => return failed(failure),
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
		return failed(StockDirectoryFailure::own(
			StockDirectoryFailureCode::ParseFailed,
		));
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
) -> Result<StockDirectoryData, StockDirectoryFailure> {
	let Some(source) = deps.sources.get(&market) else {
		return Err(StockDirectoryFailure::own(
			StockDirectoryFailureCode::NotConfigured,
		));
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
		Err(StockDirectoryFailure::own(
			StockDirectoryFailureCode::SourceFailed,
		))
	})
}

/* ---------- Financial-statement sync (ADR-0045) ---------- */

/// What a `financial-sync` job needs.
pub struct FinancialSyncDeps<'a> {
	/// Wall clock.
	pub clock: &'a dyn Clock,
	/// Logger.
	pub logger: &'a dyn EventLogger,
	/// Shared provider quota gate (`sec`, `edinet`).
	pub pacer: &'a dyn MarketPacer,
	/// Sources by provider (an absent one is unconfigured).
	pub sources: &'a HashMap<EquityProvider, std::sync::Arc<dyn EquitySyncSource>>,
}

/// The pacing window of a provider's host (`sec` is shared with the SEC
/// stock directory, so the two never exceed SEC's rate together).
const fn pacer_id(provider: EquityProvider) -> &'static str {
	match provider {
		EquityProvider::Sec => "sec",
		EquityProvider::Edinet => "edinet",
	}
}

fn log_count(count: usize) -> LogValue<'static> {
	LogValue::from(i64::try_from(count).unwrap_or(i64::MAX))
}

/// Runs a claimed `financial-sync` job (port of `executeEquitySync`): the
/// company's source fetches and extracts its annual filings, and the job
/// completes with `financial-synced`, or `failed` with an
/// `EQUITY_SYNC_FAILURE_CODES` code and the provider's status (ADR-0037).
/// A completion the API would refuse fails here as `FINANCIAL_PARSE_FAILED`
/// instead of being sent. A panicking source (the Rust form of a TypeScript
/// throw) fails the job as a retryable `FINANCIAL_SOURCE_FAILED`, logged by
/// class, like the stock-directory sources.
pub async fn execute_financial_sync(
	job: &FinancialSyncJob,
	deps: &FinancialSyncDeps<'_>,
	cancel: &CancellationToken,
	reporter: &dyn PipelineReporter,
) -> CompleteJobRequest {
	reporter.state(JobState::Planning).await;
	reporter.state(JobState::Collecting).await;
	let fetched_at = deps.clock.now_iso();
	let provider = job.claim.source.provider();
	let result = match deps.sources.get(&provider) {
		None => Err(EquitySyncFailure::own(
			EquitySyncFailureCode::SourceNotConfigured,
			0,
		)),
		Some(source) => {
			let gate = SourceGate {
				pacer: deps.pacer,
				id: pacer_id(provider),
				cancel,
			};
			let synced = AssertUnwindSafe(source.sync(EquitySyncQuery {
				target: &job.claim,
				cancel,
				before_request: &gate,
			}))
			.catch_unwind()
			.await;
			synced.unwrap_or_else(|_| {
				// An adapter fault (the Rust form of a TypeScript throw) is
				// logged by class, never by message or URL (SEC-010).
				deps.logger.warn(
					"financial_sync_source_failed",
					&[
						("provider", LogValue::from(provider.as_str())),
						("error", LogValue::from(ADAPTER_FAULT_CLASS)),
					],
				);
				Err(EquitySyncFailure::own(
					EquitySyncFailureCode::SourceFailed,
					0,
				))
			})
		}
	};
	finish(reporter).await;
	let lease_generation = job.lease.lease_generation;
	let company_id = job.claim.company_id.as_str();
	let failed = |failure: EquitySyncFailure| {
		deps.logger.warn(
			"financial_sync_failed",
			&[
				("companyId", LogValue::from(company_id)),
				("provider", LogValue::from(provider.as_str())),
				("code", LogValue::from(failure.code.as_str())),
				(
					"upstreamStatus",
					LogValue::from(failure.upstream_status.map(i64::from)),
				),
			],
		);
		CompleteJobRequest::Failed {
			lease_generation,
			usage: EMPTY_USAGE,
			failure_code: failure.code.as_str().to_owned(),
			failure_detail: Tri::Absent,
			// The provider's own status, unchanged (§4a).
			failure_upstream_status: Tri::or_absent(failure.upstream_status),
			retryable: failure.code.is_retryable(),
		}
	};
	let data = match result {
		Ok(data) => data,
		Err(failure) => return failed(failure),
	};
	let facts: usize = data.filings.iter().map(|filing| filing.facts.len()).sum();
	let (filings, scanned_days, requests, more) = (
		data.filings.len(),
		data.scanned_days.len(),
		data.requests,
		data.more,
	);
	let completion = CompleteJobRequest::FinancialSynced {
		lease_generation,
		usage: EMPTY_USAGE,
		company_id: company_id.to_owned(),
		provider,
		fetched_at,
		identity: data.identity,
		scanned_days: data.scanned_days,
		filings: data.filings,
		more,
	};
	if check_outgoing(&completion).is_err() {
		return failed(EquitySyncFailure::own(
			EquitySyncFailureCode::ParseFailed,
			requests,
		));
	}
	deps.logger.info(
		"financial_sync_completed",
		&[
			("companyId", LogValue::from(company_id)),
			("provider", LogValue::from(provider.as_str())),
			("filings", log_count(filings)),
			("facts", log_count(facts)),
			("scannedDays", log_count(scanned_days)),
			("more", LogValue::from(more)),
			("requests", log_count(requests)),
		],
	);
	completion
}
