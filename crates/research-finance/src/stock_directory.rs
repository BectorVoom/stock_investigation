//! Rules shared by the two stock-directory sources (port of
//! `stockDirectory.ts`, ADR-0034): both parse a whole market's list and must
//! hand the runner a list the completion contract accepts, or a stable code.
use crate::{market_fetch::http_status_of, ports::StockDirectoryData};
use research_application::ports::SafeFetchError;
use research_contracts::stock_directory::{StockDirectoryEntry, StockDirectoryFailureCode, limits};
use research_js::utf16::utf16_len;
use serde::Serialize;

/// A parsed list plus how many rows were dropped for an over-long name.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedStockDirectory {
	/// The list.
	pub data: StockDirectoryData,
	/// Rows dropped for a name that cannot be stored (logged as a count only).
	pub dropped_rows: usize,
}

/// Whether a (trimmed) provider name can be stored as is: 1..=200 UTF-16
/// units, zod's `length` of the completion's name schema.
#[must_use]
pub fn fits_directory_name(name: &str) -> bool {
	(1..=limits::MAX_NAME_CHARS).contains(&utf16_len(name))
}

/// The finished list, or `DIRECTORY_PARSE_FAILED` when the row count is
/// outside the contract's floor and ceiling.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for a list the completion contract would refuse by size.
pub fn finish_directory(
	as_of: Option<String>,
	entries: Vec<StockDirectoryEntry>,
	dropped_rows: usize,
) -> Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	if !(limits::MIN_ENTRIES_PER_MARKET..=limits::MAX_ENTRIES_PER_MARKET).contains(&entries.len()) {
		return Err(StockDirectoryFailureCode::ParseFailed);
	}
	Ok(ParsedStockDirectory {
		data: StockDirectoryData { as_of, entries },
		dropped_rows,
	})
}

/// A failed download as its stable code: HTTP 429 is a rate limit, anything else a source failure.
#[must_use]
pub fn directory_fetch_failure(error: &SafeFetchError) -> StockDirectoryFailureCode {
	if http_status_of(error) == Some(429) {
		StockDirectoryFailureCode::RateLimited
	} else {
		StockDirectoryFailureCode::SourceFailed
	}
}
