//! Per-provider sliding-window grants, shared across refresh jobs (API-007).
use crate::ports::{MarketRequestAdmission, Sleeper};
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
const UTC_DAY_MS: i64 = 86_400_000;
/// The daily budgets (`marketDailyBudgets`): Twelve Data's configured
/// `TWELVE_DATA_DAILY_LIMIT`; 0 (a paid plan) means none.
#[must_use]
pub fn market_daily_budgets(twelve_data_daily_limit: usize) -> HashMap<String, usize> {
	if twelve_data_daily_limit == 0 {
		HashMap::new()
	} else {
		HashMap::from([("twelve-data".to_owned(), twelve_data_daily_limit)])
	}
}
/// Pacing abstraction for sources and job bodies.
#[async_trait]
pub trait MarketPacer: Send + Sync {
	/// Waits for each requested grant. Unknown providers always return true;
	/// false when cancelled or when the provider's daily budget is spent.
	async fn pace(
		&self,
		provider: &str,
		cancel: &CancellationToken,
		requests: Option<usize>,
	) -> bool;
	/// Admits one request start: `BudgetSpent` at once when the provider's
	/// daily budget is used up, otherwise like one `pace` grant.
	async fn admit(&self, provider: &str, cancel: &CancellationToken) -> MarketRequestAdmission {
		if self.pace(provider, cancel, Some(1)).await {
			MarketRequestAdmission::Granted
		} else {
			MarketRequestAdmission::Stopped
		}
	}
}
/// Process-lifetime, mutex-protected grant histories and daily counts.
pub struct WindowMarketPacer {
	clock: Arc<dyn Clock>,
	sleep: Arc<dyn Sleeper>,
	limits: HashMap<String, MarketRateLimit>,
	requests_per_series: HashMap<String, usize>,
	/// Request starts per UTC day, by provider. In memory only: a restart
	/// starts the day's count at 0.
	daily_budgets: HashMap<String, usize>,
	grants: Mutex<HashMap<String, Vec<i64>>>,
	/// `(UTC day since the epoch, starts counted)` per budgeted provider.
	spent_today: Mutex<HashMap<String, (i64, usize)>>,
}
impl WindowMarketPacer {
	/// Constructs an injected-clock pacer. `requests_per_series` is the
	/// grant count of a `pace` call that names none (default 1).
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
			daily_budgets: HashMap::new(),
			grants: Mutex::new(HashMap::new()),
			spent_today: Mutex::new(HashMap::new()),
		}
	}
	/// The same pacer with daily budgets by provider.
	#[must_use]
	pub fn with_daily_budgets(mut self, budgets: HashMap<String, usize>) -> Self {
		self.daily_budgets = budgets;
		self
	}
	/// Standard FRED, Twelve Data, Finnhub, JPX, SEC and Google limits, and
	/// Twelve Data's configured daily limit (0: none).
	pub fn standard(
		clock: Arc<dyn Clock>,
		sleep: Arc<dyn Sleeper>,
		twelve_requests_per_minute: usize,
		twelve_data_daily_limit: usize,
	) -> Self {
		let limits = [
			// FRED publishes 120 requests per minute; 100 is our own margin below it.
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
			.with_daily_budgets(market_daily_budgets(twelve_data_daily_limit))
	}
}
/// One step of an admission: decided, or wait this long and try again.
enum Step {
	Done(MarketRequestAdmission),
	Wait(i64),
}
impl WindowMarketPacer {
	/// Reads the clock once and decides (TypeScript `take`'s loop body):
	/// `units` against the daily budget, `reserved` grants in the window at
	/// one instant.
	fn step(
		&self,
		provider: &str,
		limit: Option<&MarketRateLimit>,
		budget: Option<usize>,
		units: usize,
		reserved: usize,
	) -> Step {
		let now = self.clock.now_ms();
		// A changed UTC date (forward or, with a clock moved back, backward) starts a new count.
		let day = now.div_euclid(UTC_DAY_MS);
		let Ok(mut spent_today) = self.spent_today.lock() else {
			return Step::Done(MarketRequestAdmission::Stopped);
		};
		let spent = spent_today
			.get(provider)
			.filter(|(counted_day, _)| *counted_day == day)
			.map_or(0, |(_, spent)| *spent);
		if budget.is_some_and(|budget| spent.saturating_add(units) > budget) {
			return Step::Done(MarketRequestAdmission::BudgetSpent);
		}
		if let Some(limit) = limit {
			let Ok(mut histories) = self.grants.lock() else {
				return Step::Done(MarketRequestAdmission::Stopped);
			};
			let grants = histories.entry(provider.to_owned()).or_default();
			// Retain future grants when the clock moves backwards, as the TS does.
			let recent: Vec<_> = grants
				.iter()
				.copied()
				.filter(|at| *at > now.saturating_sub(limit.window_ms))
				.collect();
			// All `reserved` units fit iff fewer than `max - reserved + 1` grants are in the window.
			let room = limit
				.max_per_window
				.saturating_sub(reserved)
				.saturating_add(1);
			match rate_window_permit(&recent, now, room, limit.window_ms) {
				RatePermit::Denied { retry_after_ms } => return Step::Wait(retry_after_ms),
				RatePermit::Allowed => {
					*grants = recent;
					grants.extend(std::iter::repeat_n(now, reserved));
				}
			}
		}
		if budget.is_some() {
			spent_today.insert(provider.to_owned(), (day, spent.saturating_add(units)));
		}
		Step::Done(MarketRequestAdmission::Granted)
	}
}
impl WindowMarketPacer {
	/// Admits one request costing `units` grants, reserving them all at one
	/// instant (`take`): two multi-unit requests can never overrun a window
	/// between them. A request costing more than the window holds takes the
	/// whole window (it could never fit otherwise).
	async fn take(
		&self,
		provider: &str,
		cancel: &CancellationToken,
		units: usize,
	) -> MarketRequestAdmission {
		let limit = self.limits.get(provider);
		let budget = self.daily_budgets.get(provider).copied();
		if units == 0 || (limit.is_none() && budget.is_none()) {
			return MarketRequestAdmission::Granted;
		}
		let reserved = limit.map_or(units, |limit| units.min(limit.max_per_window));
		loop {
			if cancel.is_cancelled() {
				return MarketRequestAdmission::Stopped;
			}
			match self.step(provider, limit, budget, units, reserved) {
				Step::Done(admission) => return admission,
				Step::Wait(retry_after_ms) => {
					self.sleep
						.sleep(u64::try_from(retry_after_ms).unwrap_or(0), Some(cancel))
						.await;
				}
			}
		}
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
		let units = requests
			.or_else(|| self.requests_per_series.get(provider).copied())
			.unwrap_or(1);
		self.take(provider, cancel, units).await == MarketRequestAdmission::Granted
	}
	async fn admit(&self, provider: &str, cancel: &CancellationToken) -> MarketRequestAdmission {
		self.take(provider, cancel, 1).await
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::{AtomicI64, Ordering};

	/// A clock that only the sleeper moves.
	struct FakeTime {
		now: AtomicI64,
		slept: Mutex<Vec<u64>>,
	}
	impl Clock for FakeTime {
		fn now_ms(&self) -> i64 {
			self.now.load(Ordering::SeqCst)
		}
		fn now_iso(&self) -> String {
			String::new()
		}
	}
	#[async_trait]
	impl Sleeper for FakeTime {
		async fn sleep(&self, ms: u64, _: Option<&CancellationToken>) {
			if let Ok(mut slept) = self.slept.lock() {
				slept.push(ms);
			}
			self.now
				.fetch_add(i64::try_from(ms).unwrap_or(i64::MAX), Ordering::SeqCst);
		}
	}

	fn google_pacer() -> (WindowMarketPacer, Arc<FakeTime>) {
		let time = Arc::new(FakeTime {
			now: AtomicI64::new(1_000_000),
			slept: Mutex::new(Vec::new()),
		});
		let limits = HashMap::from([(
			"google".to_owned(),
			MarketRateLimit {
				max_per_window: 5,
				window_ms: 1_000,
			},
		)]);
		let pacer = WindowMarketPacer::new(time.clone(), time.clone(), limits, HashMap::new());
		(pacer, time)
	}

	fn slept(time: &FakeTime) -> Vec<u64> {
		time.slept.lock().map(|s| s.clone()).unwrap_or_default()
	}

	#[tokio::test]
	async fn multi_unit_requests_reserve_all_their_units_at_once() {
		let (pacer, time) = google_pacer();
		let cancel = CancellationToken::new();
		// A PATCH costs 3 of the window's 5: a second one waits for the whole
		// window instead of taking 2 now and 1 later.
		assert!(pacer.pace("google", &cancel, Some(3)).await);
		assert!(slept(&time).is_empty());
		assert!(pacer.pace("google", &cancel, Some(3)).await);
		assert_eq!(slept(&time), [1_000]);
		// 3 in the window: 2 more fit exactly, the next one waits.
		assert!(pacer.pace("google", &cancel, Some(2)).await);
		assert_eq!(slept(&time), [1_000]);
		assert_eq!(
			pacer.admit("google", &cancel).await,
			MarketRequestAdmission::Granted
		);
		assert_eq!(slept(&time), [1_000, 1_000]);
	}

	#[tokio::test]
	async fn a_request_larger_than_the_window_takes_the_whole_window() {
		let (pacer, time) = google_pacer();
		let cancel = CancellationToken::new();
		assert!(pacer.pace("google", &cancel, Some(7)).await);
		assert!(slept(&time).is_empty());
		assert!(pacer.pace("google", &cancel, Some(1)).await);
		assert_eq!(slept(&time), [1_000]);
	}
}
