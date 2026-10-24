//! Faithful market, earnings, SEC and stock-directory adapters for the local runner (ADR-0030).
pub mod finnhub;
pub mod fred;
pub mod jobs;
pub mod jpx;
pub mod jpx_directory;
pub mod jpx_workbook;
pub mod market_fetch;
pub mod pacing;
pub mod ports;
pub mod twelve_data;
pub mod zip_reader;

pub mod market_data;
pub mod sec_13f;
pub mod sec_client;
pub mod sec_directory;
pub mod sec_financials;
mod sec_xml;
pub mod stock_directory;

/// CPU-bound parsing runs off the tokio workers (ADR-0030 decision 5).
mod cpu {
	/// Runs `job` on the shared rayon bridge. A panic inside it is re-raised
	/// here, where the caller's boundary treats it like the TypeScript throw
	/// it stands for (a refresh job logs and fails its source, a tool call
	/// ends as `TOOL_THREW`).
	pub(crate) async fn offload<T, F>(job: F) -> T
	where
		T: Send + 'static,
		F: FnOnce() -> T + Send + 'static,
	{
		match research_effects::cpu::run_cpu(job).await {
			Ok(value) => value,
			Err(panicked) => std::panic::resume_unwind(Box::new(panicked.to_string())),
		}
	}
}
