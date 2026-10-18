//! The one bridge from async code to the rayon pool (ADR-0030 decision 5).
//!
//! CPU work called from async code (HTML conversion, feed parsing, claim
//! verification, large notebook checks) must never run on a tokio worker,
//! and a panic inside it must never take the runner down: a panic in a
//! `rayon::spawn` job aborts the whole process. [`run_cpu`] runs the job on
//! the rayon pool, catches a panic and returns it as [`CpuPanic`], which the
//! caller reports like a TypeScript throw (e.g. `TOOL_THREW`,
//! `job_crashed` + a retryable failure).

use std::panic::{AssertUnwindSafe, catch_unwind};

use tokio::sync::oneshot;

/// A CPU job panicked (or the pool dropped it). The panic payload is never
/// carried: it may contain untrusted text or secrets (SEC-010).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuPanic;

impl std::fmt::Display for CpuPanic {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter.write_str("CPU job panicked")
	}
}

impl std::error::Error for CpuPanic {}

/// Runs `job` on the rayon pool and awaits its result without blocking the
/// calling tokio worker.
///
/// Dropping the returned future does not stop a job that has started (CPU
/// work has no cancellation points); its result is discarded. Jobs must
/// therefore be pure — side effects (files, network) stay in async code,
/// where cancellation applies.
///
/// # Errors
/// [`CpuPanic`] when the job panicked.
pub async fn run_cpu<F, T>(job: F) -> Result<T, CpuPanic>
where
	F: FnOnce() -> T + Send + 'static,
	T: Send + 'static,
{
	let (sender, receiver) = oneshot::channel();
	rayon::spawn(move || {
		// AssertUnwindSafe: the job owns its inputs and nothing it touched is
		// observed after a panic (its result is replaced by `CpuPanic`).
		let outcome = catch_unwind(AssertUnwindSafe(job)).map_err(|_| CpuPanic);
		// The receiver may be gone (the caller was cancelled): nothing to do.
		let _ = sender.send(outcome);
	});
	receiver.await.unwrap_or(Err(CpuPanic))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn returns_the_result_of_the_job() {
		assert_eq!(run_cpu(|| (1..=10).sum::<u32>()).await, Ok(55));
	}

	#[tokio::test]
	async fn a_panicking_job_is_an_error_not_an_abort() {
		let outcome: Result<u32, CpuPanic> = run_cpu(|| panic!("hostile input")).await;
		assert_eq!(outcome, Err(CpuPanic));
		// The pool still works afterwards.
		assert_eq!(run_cpu(|| 7).await, Ok(7));
	}
}
