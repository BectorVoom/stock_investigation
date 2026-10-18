//! Faithful market, earnings and SEC adapters for the local runner (ADR-0030).
pub mod finnhub;
pub mod fred;
pub mod jobs;
pub mod jpx;
pub mod jpx_workbook;
pub mod market_fetch;
pub mod pacing;
pub mod ports;
pub mod twelve_data;
pub mod zip_reader;

pub mod market_data;
pub mod sec_13f;
pub mod sec_client;
pub mod sec_financials;
mod sec_xml;
