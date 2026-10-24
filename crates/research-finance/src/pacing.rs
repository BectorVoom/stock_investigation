//! Per-provider sliding-window grants, shared across refresh jobs (API-007).
use crate::ports::Sleeper;
use async_trait::async_trait;
use research_application::ports::Clock;
use research_domain::market::rate_window::{RatePermit, rate_window_permit};
use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
/// Per-provider request limit.
#[derive(Clone, Copy, Debug)]
pub struct MarketRateLimit {
	/// Maximum grants in the half-open window.
	pub max_per_window: usize,
	/// Window length, in milliseconds.
	pub window_ms: i64,
}
/// Pacing abstraction for sources and job bodies.
#[async_trait]
pub trait MarketPacer: Send + Sync {
	/// Waits for each requested grant. Unknown providers always return true.
	async fn pace(
		&self,
		provider: &str,
		cancel: &CancellationToken,
		requests: Option<usize>,
	) -> bool;
}
/// Process-lifetime, mutex-protected grant histories.
pub struct WindowMarketPacer {
	clock: Arc<dyn Clock>,
	sleep: Arc<dyn Sleeper>,
	limits: HashMap<String, MarketRateLimit>,
	requests_per_series: HashMap<String, usize>,
	grants: Mutex<HashMap<String, Vec<i64>>>,
}
impl WindowMarketPacer {
	/// Constructs an injected-clock pacer.
	pub fn new(
		clock: Arc<dyn Clock>,
		sleep: Arc<dyn Sleeper>,
		limits: HashMap<String, MarketRateLimit>,
		requests_per_series: HashMap<String, usize>,
	) -> Self {
		Self {
			clock,
			sleep,
			limits,
			requests_per_series,
			grants: Mutex::new(HashMap::new()),
		}
	}
	/// Standard FRED, Twelve Data, Finnhub, JPX, SEC and Google limits.
	pub fn standard(
		clock: Arc<dyn Clock>,
		sleep: Arc<dyn Sleeper>,
		twelve_requests_per_minute: usize,
	) -> Self {
		let limits = [
			("fred", 100, 60_000),
			("twelve-data", twelve_requests_per_minute, 60_000),
			("finnhub", 30, 60_000),
			("jpx", 6, 60_000),
			// SEC (the US stock directory): the window form of the SEC
			// client's own 125 ms spacing, so a stopped job stops waiting here too.
			("sec", 8, 1_000),
			("google", 5, 1_000),
		]
		.into_iter()
		.map(|(id, max_per_window, window_ms)| {
			(
				id.to_owned(),
				MarketRateLimit {
					max_per_window,
					window_ms,
				},
			)
		})
		.collect();
		Self::new(clock, sleep, limits, HashMap::new())
	}
}
#[async_trait]
impl MarketPacer for WindowMarketPacer {
	async fn pace(
		&self,
		provider: &str,
		cancel: &CancellationToken,
		requests: Option<usize>,
	) -> bool {
		let Some(limit) = self.limits.get(provider) else {
			return true;
		};
		let count = requests
			.or_else(|| self.requests_per_series.get(provider).copied())
			.unwrap_or(if provider == "fred" { 2 } else { 1 });
		for _ in 0..count {
			loop {
				if cancel.is_cancelled() {
					return false;
				}
				let decision = {
					let now = self.clock.now_ms();
					let Ok(mut histories) = self.grants.lock() else {
						return false;
					};
					let grants = histories.entry(provider.to_owned()).or_default();
					// Retain future grants when the clock moves backwards, as the TS does.
					let recent: Vec<_> = grants
						.iter()
						.copied()
						.filter(|at| *at > now.saturating_sub(limit.window_ms))
						.collect();
					let decision =
						rate_window_permit(&recent, now, limit.max_per_window, limit.window_ms);
					if decision == RatePermit::Allowed {
						*grants = recent;
						grants.push(now);
					}
					decision
				};
				match decision {
					RatePermit::Allowed => break,
					RatePermit::Denied { retry_after_ms } => {
						self.sleep
							.sleep(u64::try_from(retry_after_ms).unwrap_or(0), Some(cancel))
							.await
					}
				}
			}
		}
		true
	}
}
