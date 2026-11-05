//! Retrieval over the stored stock data (`packages/contracts/src/stockData.ts`,
//! ADR-0071): what the `stocks.search_data` tool sends to
//! `POST /api/v1/runner/jobs/:id/stock-data/search` and the ranked passages it
//! gets back. The ranking itself runs in the API.

use research_js::json::{Object, Value};
use serde::Serialize;

use crate::primitives::{HTTPS_URL, ISO_DATE_TIME};
use crate::records::SourceClass;
use crate::watchlist::watchlist_stock_id;
use crate::zod::{
	ArrCheck, Cx, NumCheck, StrCheck, array, boolean, decode_object, js_enum, nullable, number,
	optional, string, uint,
};

/// `STOCK_DATA_LIMITS` (the parts the runner reaches).
pub mod limits {
	/// Longest query, in characters.
	pub const MAX_QUERY_CHARS: usize = 300;
	/// Stocks one call may name.
	pub const MAX_STOCK_IDS: usize = 5;
	/// Stocks one call reads at most.
	pub const MAX_SEARCHED_STOCKS: usize = 5;
	/// Most passages one answer holds.
	pub const MAX_RESULTS: usize = 12;
	/// Longest passage text.
	pub const MAX_PASSAGE_CHARS: usize = 1_200;
	/// Longest passage title.
	pub const MAX_TITLE_CHARS: usize = 200;
}

js_enum! {
	/// `stockDataSectionSchema`: the kind of stored record a passage comes from.
	pub enum StockDataSection {
		Listing = "listing",
		CompanyProfile = "company-profile",
		AiSummary = "ai-summary",
		Overview = "overview",
		Business = "business",
		Financials = "financials",
		Earnings = "earnings",
		Prices = "prices",
	}
}

const QUERY: &[StrCheck] = &[
	StrCheck::Trim,
	StrCheck::Min(1),
	StrCheck::Max(limits::MAX_QUERY_CHARS),
];
const NAME: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(200)];
const TITLE: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(limits::MAX_TITLE_CHARS)];
const TEXT: &[StrCheck] = &[StrCheck::Min(1), StrCheck::Max(limits::MAX_PASSAGE_CHARS)];
const STOCK_IDS: &[ArrCheck] = &[ArrCheck::Min(1), ArrCheck::Max(limits::MAX_STOCK_IDS)];
const SECTIONS: &[ArrCheck] = &[ArrCheck::Min(1), ArrCheck::Max(8)];
const LIMIT: &[NumCheck] = &[NumCheck::Int, NumCheck::Gte(1.0), NumCheck::Lte(12.0)];

/// The tool's arguments: `stockDataSearchRequestSchema` without `leaseGeneration`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDataSearchArgs {
	/// The question words (trimmed).
	pub query: String,
	/// The stocks to search; absent → the stocks the query names.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub stock_ids: Option<Vec<String>>,
	/// Only these kinds of record; absent → every kind.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub sections: Option<Vec<StockDataSection>>,
	/// Most passages wanted (1..=12).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub limit: Option<u64>,
}

impl StockDataSearchArgs {
	/// zod decoder (`.strict()`).
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			query: "query" => string(QUERY),
			stock_ids: "stockIds" => optional(array(watchlist_stock_id, STOCK_IDS)),
			sections: "sections" => optional(array(StockDataSection::decode, SECTIONS)),
			limit: "limit" => optional(uint(LIMIT)),
		})
	}

	/// The parsed arguments as JSON (zod's output: the query trimmed).
	#[must_use]
	pub fn to_value(&self) -> Value {
		let mut object = Object::new();
		object.insert("query", Value::String(self.query.clone()));
		if let Some(stock_ids) = &self.stock_ids {
			object.insert(
				"stockIds",
				Value::Array(stock_ids.iter().cloned().map(Value::String).collect()),
			);
		}
		if let Some(sections) = &self.sections {
			object.insert(
				"sections",
				Value::Array(
					sections
						.iter()
						.map(|section| Value::String(section.as_str().to_owned()))
						.collect(),
				),
			);
		}
		if let Some(limit) = self.limit {
			#[allow(clippy::cast_precision_loss)]
			object.insert("limit", Value::Number(limit as f64));
		}
		Value::Object(object)
	}
}

/// `stockDataSearchRequestSchema`: the arguments plus the run's lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDataSearchRequest {
	/// The lease generation that proves the runner holds the run.
	pub lease_generation: u64,
	/// The tool's arguments.
	#[serde(flatten)]
	pub args: StockDataSearchArgs,
}

/// `stockDataPassageSchema`: one ranked passage of a stored record.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDataPassage {
	/// `us:AAPL`, `jp:7974`.
	pub stock_id: String,
	/// The stock's stored name.
	pub name: Option<String>,
	/// The kind of record.
	pub section: StockDataSection,
	/// A short heading.
	pub title: String,
	/// The passage.
	pub text: String,
	/// The public page the record came from.
	pub source_url: Option<String>,
	/// Who published the record.
	pub publisher: String,
	/// The kind of source.
	pub source_class: SourceClass,
	/// When the record was stored or states its data for.
	pub as_of: Option<String>,
	/// Written by the app's AI, not read from a source.
	pub ai_written: bool,
	/// BM25 relevance.
	pub score: f64,
}

impl StockDataPassage {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			stock_id: "stockId" => watchlist_stock_id,
			name: "name" => nullable(string(NAME)),
			section: "section" => StockDataSection::decode,
			title: "title" => string(TITLE),
			text: "text" => string(TEXT),
			source_url: "sourceUrl" => nullable(string(HTTPS_URL)),
			publisher: "publisher" => string(NAME),
			source_class: "sourceClass" => SourceClass::decode,
			as_of: "asOf" => nullable(string(ISO_DATE_TIME)),
			ai_written: "aiWritten" => boolean,
			score: "score" => number(&[NumCheck::Gte(0.0)]),
		})
	}
}

/// `stockDataSearchResponseSchema`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockDataSearchResponse {
	/// The stocks whose stored data was searched, in search order.
	pub searched_stocks: Vec<String>,
	/// The passages, most relevant first.
	pub passages: Vec<StockDataPassage>,
}

impl StockDataSearchResponse {
	/// zod decoder.
	pub fn decode(cx: &mut Cx, input: Option<&Value>) -> Option<Self> {
		decode_object!(cx, input, strict, [], Self {
			searched_stocks: "searchedStocks" => array(watchlist_stock_id, &[ArrCheck::Max(limits::MAX_SEARCHED_STOCKS)]),
			passages: "passages" => array(StockDataPassage::decode, &[ArrCheck::Max(limits::MAX_RESULTS)]),
		})
	}
}
