//! Massive (formerly Polygon.io) US stock prices for the `stock-prices-sync`
//! job (port of `packages/adapters/src/finance/massive.ts`, ADR-0058 §2):
//! the grouped daily bars of one date, one stock's range aggregates and the
//! split listing, over `api.massive.com` with `Authorization: Bearer <key>`.
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/massive.md
use crate::market_fetch::{fetch_json_document, fetch_options};
use crate::ports::Secret;
use crate::stock_prices::{
	StockDayAnswer, StockPriceProblem, StockPriceRequestContext, StockPriceSource, consistent_bar,
	finish_day_bars, massive_ticker_to_symbol, new_york_date, problem_of_status,
	symbol_to_massive_ticker,
};
use async_trait::async_trait;
use research_application::ports::{
	SafeFetchError, SafeFetchErrorCode, SafeFetchOptions, SafeFetcher,
};
use research_contracts::stock_prices::{StockDayBar, StockHistoryBar, StockPriceProvider};
use research_contracts::watchlist::WatchMarket;
use research_js::json::{Object, Value};
use std::sync::Arc;

/// The pinned API host.
pub const MASSIVE_HOST: &str = "api.massive.com";
/// `MASSIVE_PUBLISHER`.
pub const MASSIVE_PUBLISHER: &str = "Massive";
/// A grouped day of ~11,000 tickers is ~1.5 MB; room above it.
pub const MASSIVE_DAY_MAX_BYTES: usize = 8_000_000;
/// Two years of one stock's bars, or one page of splits.
pub const MASSIVE_PAGE_MAX_BYTES: usize = 2_000_000;
/// 9999-12-31T23:59:59.999Z: a bar time outside 1970…9999 is not a trading day.
const MAX_EPOCH_MS: f64 = 253_402_300_799_999.0;
/// Pages one history or split listing may follow (`next_url`).
pub const MASSIVE_MAX_PAGES: usize = 5;

/// `massiveProblem`: 401 key, 403 plan, 404, 429, else a source failure.
#[must_use]
pub fn massive_problem(error: &SafeFetchError) -> StockPriceProblem {
	if error.code == SafeFetchErrorCode::HttpError {
		if error.status == Some(403) {
			return StockPriceProblem::PlanRefused(403);
		}
		return problem_of_status(error.status);
	}
	StockPriceProblem::Failed(error.status)
}

/// `resultsSchema`: an object whose `results` is an absent or array value
/// and `next_url` an absent, null or string value.
fn results_page(json: &Value) -> Option<(&[Value], Option<String>)> {
	let object = json.as_object()?;
	let results: &[Value] = match object.get("results") {
		None => &[],
		Some(value) => value.as_array()?,
	};
	let next = match object.get("next_url") {
		None | Some(Value::Null) => None,
		Some(Value::String(next)) => Some(next.clone()),
		Some(_) => return None,
	};
	Some((results, next))
}

/// `barRowSchema`'s typed fields: `T` (string), `t` (finite number), `otc`
/// (boolean), each optional; `None` when the row fails the schema.
struct BarRow<'a> {
	object: &'a Object,
	ticker: Option<&'a str>,
	start: Option<f64>,
	otc: Option<bool>,
}

fn bar_row(row: &Value) -> Option<BarRow<'_>> {
	let object = row.as_object()?;
	let ticker = match object.get("T") {
		None => None,
		Some(Value::String(ticker)) => Some(ticker.as_str()),
		Some(_) => return None,
	};
	let start = match object.get("t") {
		None => None,
		Some(Value::Number(start)) if start.is_finite() => Some(*start),
		Some(_) => return None,
	};
	let otc = match object.get("otc") {
		None => None,
		Some(Value::Bool(otc)) => Some(*otc),
		Some(_) => return None,
	};
	Some(BarRow {
		object,
		ticker,
		start,
		otc,
	})
}

fn row_bar(row: &BarRow<'_>) -> Option<(f64, research_contracts::market::MarketBar)> {
	consistent_bar(
		row.object.get("o"),
		row.object.get("h"),
		row.object.get("l"),
		row.object.get("c"),
		row.object.get("v"),
	)
}

/// `parseMassiveDay`.
#[must_use]
pub fn parse_massive_day(json: &Value) -> Option<Vec<StockDayBar>> {
	let (results, _) = results_page(json)?;
	let mut bars = Vec::new();
	for row in results {
		let Some(row) = bar_row(row) else { continue };
		if row.otc == Some(true) {
			continue;
		}
		let Some(symbol) = row.ticker.and_then(massive_ticker_to_symbol) else {
			continue;
		};
		if let Some((close, bar)) = row_bar(&row) {
			bars.push(StockDayBar(symbol, close, bar));
		}
	}
	Some(finish_day_bars(bars))
}

/// `parseMassiveHistory`: the bars and the next page.
#[must_use]
pub fn parse_massive_history(json: &Value) -> Option<(Vec<StockHistoryBar>, Option<String>)> {
	let (results, next) = results_page(json)?;
	let mut bars = Vec::new();
	for row in results {
		let Some(row) = bar_row(row) else { continue };
		let Some(start) = row
			.start
			.filter(|start| (0.0..=MAX_EPOCH_MS).contains(start))
		else {
			continue;
		};
		if let Some((close, bar)) = row_bar(&row) {
			// A whole millisecond count (JSON numbers of `t` are integers).
			#[allow(clippy::cast_possible_truncation)]
			let date = new_york_date(start.floor() as i64);
			bars.push(StockHistoryBar(date, close, bar));
		}
	}
	Some((bars, next))
}

/// `parseMassiveSplits`: the directory symbols and the next page.
#[must_use]
pub fn parse_massive_splits(json: &Value) -> Option<(Vec<String>, Option<String>)> {
	let (results, next) = results_page(json)?;
	let mut symbols = Vec::new();
	for row in results {
		let Some(object) = row.as_object() else {
			continue;
		};
		let ticker = match object.get("ticker") {
			None => continue,
			Some(Value::String(ticker)) => ticker,
			Some(_) => continue,
		};
		if let Some(symbol) = massive_ticker_to_symbol(ticker) {
			symbols.push(symbol);
		}
	}
	Some((symbols, next))
}

/// A page parser: its items and the next page's URL, `None` when not that shape.
type PageParser<T> = fn(&Value) -> Option<(Vec<T>, Option<String>)>;

/// The US stock-price source over Massive.
pub struct MassiveStockPriceSource {
	api_key: Secret,
	fetcher: Arc<dyn SafeFetcher>,
}

impl MassiveStockPriceSource {
	/// Constructs the source.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>) -> Self {
		Self { api_key, fetcher }
	}

	fn options(
		&self,
		max_bytes: usize,
		context: &StockPriceRequestContext<'_>,
	) -> SafeFetchOptions {
		let mut options = fetch_options(MASSIVE_HOST, "application/json", context.cancel);
		options.max_bytes = max_bytes;
		options.authorization = Some(format!("Bearer {}", self.api_key.expose()));
		options
	}

	/// One paced GET answering JSON.
	async fn get(
		&self,
		url: &str,
		max_bytes: usize,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Value, StockPriceProblem> {
		context.admit().await?;
		fetch_json_document(
			self.fetcher.as_ref(),
			url,
			&self.options(max_bytes, context),
		)
		.await
		.map_err(|error| massive_problem(&error))
	}

	/// Follows `next_url` pages up to the page cap.
	async fn pages<T>(
		&self,
		first: String,
		context: &StockPriceRequestContext<'_>,
		parse: PageParser<T>,
	) -> Result<Vec<T>, StockPriceProblem>
	where
		T: Send,
	{
		let mut items = Vec::new();
		let mut url = Some(first);
		let mut page = 0;
		while let Some(next) = url {
			if page >= MASSIVE_MAX_PAGES {
				return Err(StockPriceProblem::Failed(None));
			}
			let json = self.get(&next, MASSIVE_PAGE_MAX_BYTES, context).await?;
			let (parsed, following) = parse(&json).ok_or(StockPriceProblem::Failed(None))?;
			items.extend(parsed);
			url = following;
			page += 1;
		}
		Ok(items)
	}
}

#[async_trait]
impl StockPriceSource for MassiveStockPriceSource {
	fn provider(&self) -> StockPriceProvider {
		StockPriceProvider::Massive
	}
	fn market(&self) -> WatchMarket {
		WatchMarket::Us
	}
	fn delay_days(&self) -> i64 {
		0
	}
	fn splits_in_day_answers(&self) -> bool {
		false
	}
	async fn fetch_day(
		&self,
		date: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<StockDayAnswer, StockPriceProblem> {
		let url = format!(
			"https://{MASSIVE_HOST}/v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true"
		);
		let json = self.get(&url, MASSIVE_DAY_MAX_BYTES, context).await?;
		let bars = parse_massive_day(&json).ok_or(StockPriceProblem::Failed(None))?;
		Ok(StockDayAnswer {
			bars,
			adjusted_symbols: Vec::new(),
		})
	}
	async fn fetch_history(
		&self,
		symbol: &str,
		from: &str,
		to: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<StockHistoryBar>, StockPriceProblem> {
		let ticker = symbol_to_massive_ticker(symbol).ok_or(StockPriceProblem::NotFound(None))?;
		let url = format!(
			"https://{MASSIVE_HOST}/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}?adjusted=true&sort=asc&limit=50000"
		);
		self.pages(url, context, parse_massive_history).await
	}
	async fn fetch_split_symbols(
		&self,
		after: &str,
		through: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<String>, StockPriceProblem> {
		let url = format!(
			"https://{MASSIVE_HOST}/stocks/v1/splits?execution_date.gt={after}&execution_date.lte={through}&limit=5000"
		);
		self.pages(url, context, parse_massive_splits).await
	}
}
