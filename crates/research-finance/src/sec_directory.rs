//! The US stock directory (port of `secDirectory.ts`, ADR-0033): SEC's
//! `company_tickers_exchange.json`, the ticker directory the SEC financials
//! tool reads, downloaded through the same fair-access client. Rows on
//! Nasdaq, NYSE, Cboe and Texas SE are kept in file order (the first row of a
//! ticker wins, the directory reader's rule); OTC and unlisted rows, tickers
//! outside the US symbol shape and rows whose name cannot be stored are
//! dropped (the last counted, never named).
use crate::{
	ports::{DroppedRowsHook, StockDirectoryData, StockDirectoryQuery, StockDirectorySource},
	sec_client::{SecClient, SecErrorCode, SecRequest, parse_sec_json},
	sec_financials::{SEC_TICKER_DIRECTORY_URL, parse_ticker_directory},
	stock_directory::{ParsedStockDirectory, finish_directory, fits_directory_name},
};
use async_trait::async_trait;
use research_contracts::stock_directory::{
	StockDirectoryEntry, StockDirectoryFailureCode, StockListing,
};
use research_contracts::watchlist::{WatchMarket, parse_stock_id};
use research_js::json::Value;
use serde::Serialize;
use std::{collections::HashSet, sync::Arc};

/// Byte cap of the ticker directory download (`TICKER_DIRECTORY_MAX_BYTES`).
pub const TICKER_DIRECTORY_MAX_BYTES: usize = 8_000_000;

/// SEC's exchange text (exact) as the listing kept; every other exchange is dropped.
#[must_use]
pub fn sec_directory_listing(exchange: &str) -> Option<StockListing> {
	match exchange {
		"Nasdaq" => Some(StockListing::Nasdaq),
		"NYSE" => Some(StockListing::Nyse),
		"CBOE" => Some(StockListing::Cboe),
		"TXSE" => Some(StockListing::Txse),
		_ => None,
	}
}

/// The US list before the row-count floor (`secDirectoryEntries`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecDirectoryEntries {
	/// Kept rows.
	pub entries: Vec<StockDirectoryEntry>,
	/// Rows dropped for a name that cannot be stored.
	pub dropped_rows: usize,
}

/// The US list of a decoded ticker directory, before the row-count floor.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for an unreadable directory.
pub fn sec_directory_entries(
	value: &Value,
) -> Result<SecDirectoryEntries, StockDirectoryFailureCode> {
	let issuers =
		parse_ticker_directory(value).map_err(|_| StockDirectoryFailureCode::ParseFailed)?;
	let mut entries = Vec::new();
	let mut seen: HashSet<String> = HashSet::new();
	let mut dropped_rows = 0;
	for issuer in issuers.values() {
		let Some(listing) = issuer
			.sec_exchange
			.as_deref()
			.and_then(sec_directory_listing)
		else {
			continue;
		};
		let symbol = &issuer.ticker;
		if parse_stock_id(&format!("us:{symbol}")).is_err() || seen.contains(symbol) {
			continue;
		}
		if !fits_directory_name(&issuer.name) {
			dropped_rows += 1;
			continue;
		}
		seen.insert(symbol.clone());
		entries.push(StockDirectoryEntry {
			symbol: symbol.clone(),
			name: issuer.name.clone(),
			local_name: None,
			listing,
		});
	}
	Ok(SecDirectoryEntries {
		entries,
		dropped_rows,
	})
}

/// [`sec_directory_entries`] plus the contract's floor and ceiling; SEC states no date.
///
/// # Errors
/// `DIRECTORY_PARSE_FAILED` for an unreadable directory or a list outside the bounds.
pub fn parse_sec_directory(
	value: &Value,
) -> Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	let parsed = sec_directory_entries(value)?;
	finish_directory(None, parsed.entries, parsed.dropped_rows)
}

const fn failure_of(code: SecErrorCode) -> StockDirectoryFailureCode {
	match code {
		SecErrorCode::NotConfigured => StockDirectoryFailureCode::NotConfigured,
		SecErrorCode::RateLimited => StockDirectoryFailureCode::RateLimited,
		SecErrorCode::UnexpectedResponse => StockDirectoryFailureCode::ParseFailed,
		_ => StockDirectoryFailureCode::SourceFailed,
	}
}

/// The US source over the SEC fair-access client.
pub struct SecDirectorySource {
	client: Arc<dyn SecClient>,
	on_dropped: Option<DroppedRowsHook>,
}

impl SecDirectorySource {
	/// A source over `client` (its User-Agent is the owner's `SEC_USER_AGENT`).
	pub fn new(client: Arc<dyn SecClient>, on_dropped: Option<DroppedRowsHook>) -> Self {
		Self { client, on_dropped }
	}
}

#[async_trait]
impl StockDirectorySource for SecDirectorySource {
	fn market(&self) -> WatchMarket {
		WatchMarket::Us
	}

	async fn fetch_directory(
		&self,
		query: StockDirectoryQuery<'_>,
	) -> Result<StockDirectoryData, StockDirectoryFailureCode> {
		// One grant per request start, taken immediately before it is sent;
		// a false hook (the job stopped while waiting) sends nothing.
		if !query.before_request.before_request().await {
			return Err(StockDirectoryFailureCode::SourceFailed);
		}
		let document = self
			.client
			.fetch_document(
				SEC_TICKER_DIRECTORY_URL,
				SecRequest {
					max_bytes: TICKER_DIRECTORY_MAX_BYTES,
					accept: "application/json",
					cancel: Some(query.cancel),
				},
			)
			.await
			.map_err(|error| failure_of(error.code))?;
		// Half a megabyte of JSON: parse off the tokio worker.
		let parsed = crate::cpu::offload(move || {
			let value =
				parse_sec_json(&document).map_err(|_| StockDirectoryFailureCode::ParseFailed)?;
			parse_sec_directory(&value)
		})
		.await?;
		if parsed.dropped_rows > 0
			&& let Some(hook) = &self.on_dropped
		{
			hook(parsed.dropped_rows);
		}
		Ok(parsed.data)
	}
}
