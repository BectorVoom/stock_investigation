//! Market-refresh and earnings-refresh job bodies; the shell owns leases and event delivery.
use crate::{pacing::MarketPacer, ports::*};
use async_trait::async_trait;
use indexmap::IndexMap;
use research_application::{ports::Clock, reporter::PipelineReporter};
use research_contracts::{
	jobs::*,
	market::{MarketObservation, MarketUnavailableCode, parse_market_series_id},
	watchlist::{EarningsUnavailableCode, earnings_source_by_market, parse_stock_id},
};
use research_effects::{EventLogger, LogValue};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;
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
					match source
						.fetch_series(SeriesQuery {
							symbol: parsed.symbol,
							since: entry.latest_observed_on.as_deref(),
							max_observations: 800,
							cancel,
						})
						.await
					{
						Err(error) => output.error_code = Some(error.code),
						Ok(result) => {
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
		let mut results = match deps.earnings_sources.get(&id) {
			None => stocks
				.iter()
				.map(|_| {
					Err(EarningsFailure::new(
						EarningsUnavailableCode::SourceNotConfigured,
					))
				})
				.collect(),
			Some(source) => {
				source
					.fetch_earnings(EarningsQuery {
						stocks: &stocks,
						from_date: &job.from_date,
						to_date: &job.to_date,
						cancel,
						before_request: &gate,
					})
					.await
			}
		};
		if results.len() != stocks.len() {
			deps.logger.warn(
				"earnings_source_failed",
				&[
					("source", LogValue::from(id.as_str())),
					("error", LogValue::from("RangeError")),
				],
			);
			results = stocks
				.iter()
				.map(|_| Err(EarningsFailure::new(EarningsUnavailableCode::SourceFailed)))
				.collect();
		}
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
