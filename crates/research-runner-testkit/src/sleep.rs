//! Sleeps capped at 500 ms (`Math.min(ms, 500)` in the TypeScript harness) so
//! the browser suite never waits on production cadences (poll idle, tool
//! politeness delays, Google holds).

use std::time::Duration;

use async_trait::async_trait;
use research_finance::ports::Sleeper;
use research_tools::search::Sleep;
use tokio_util::sync::CancellationToken;

/// The longest any E2E wait lasts.
pub const SLEEP_CAP_MS: u64 = 500;

/// Resolves after `min(ms, 500)` or as soon as `cancel` fires.
async fn capped(ms: u64, cancel: Option<&CancellationToken>) {
	let sleep = tokio::time::sleep(Duration::from_millis(ms.min(SLEEP_CAP_MS)));
	match cancel {
		Some(cancel) => tokio::select! {
			() = sleep => {},
			() = cancel.cancelled() => {},
		},
		None => sleep.await,
	}
}

/// The capped sleep for every injected wait port.
#[derive(Clone, Copy, Debug, Default)]
pub struct CappedSleep;

#[async_trait]
impl Sleeper for CappedSleep {
	async fn sleep(&self, ms: u64, cancel: Option<&CancellationToken>) {
		capped(ms, cancel).await;
	}
}

#[async_trait]
impl Sleep for CappedSleep {
	async fn sleep(&self, milliseconds: u64, cancel: &CancellationToken) {
		capped(milliseconds, Some(cancel)).await;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test(start_paused = true)]
	async fn long_waits_are_cut_to_the_cap() {
		let before = tokio::time::Instant::now();
		Sleeper::sleep(&CappedSleep, 60_000, None).await;
		assert_eq!(before.elapsed(), Duration::from_millis(SLEEP_CAP_MS));
	}

	#[tokio::test(start_paused = true)]
	async fn a_cancelled_wait_ends_at_once() {
		let cancel = CancellationToken::new();
		cancel.cancel();
		let before = tokio::time::Instant::now();
		Sleep::sleep(&CappedSleep, 400, &cancel).await;
		assert!(before.elapsed() < Duration::from_millis(1));
	}
}
