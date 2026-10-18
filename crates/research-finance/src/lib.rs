//! Faithful market, earnings and SEC adapters for the local runner (ADR-0030).
pub mod ports;
pub mod market_fetch;
pub mod fred;
pub mod twelve_data;
pub mod finnhub;
pub mod jpx_workbook;
pub mod zip_reader;
pub mod jpx;
pub mod pacing;
pub mod jobs;

pub mod sec_client;
mod sec_xml;
pub mod sec_13f;
pub mod sec_financials;
pub mod market_data;
