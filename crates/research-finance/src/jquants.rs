//! J-Quants (JPX's official API, V2) Japanese stock prices for the
//! `stock-prices-sync` job (port of `packages/adapters/src/finance/jquants.ts`,
//! ADR-0058 §2): `GET /v2/equities/bars/daily` by date and by code over
//! `api.jquants.com` with the `x-api-key` header, following
//! `pagination_key`; the adjusted values are stored.
//!
//! Wire format, limits and error mapping: docs/external-apis/apis/jquants.md
use crate::market_fetch::{fetch_json_document, fetch_options, is_iso_date};
use crate::ports::Secret;
use crate::stock_prices::{
	StockDayAnswer, StockPriceProblem, StockPriceRequestContext, StockPriceSource, consistent_bar,
	finish_day_bars, jquants_code_to_symbol, problem_of_status, symbol_to_jquants_code,
};
use async_trait::async_trait;
use research_application::ports::{SafeFetchError, SafeFetchErrorCode, SafeFetcher};
use research_contracts::market::MarketBar;
use research_contracts::stock_prices::{StockDayBar, StockHistoryBar, StockPriceProvider};
use research_contracts::watchlist::WatchMarket;
use research_js::json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;

/// The pinned API host.
pub const JQUANTS_HOST: &str = "api.jquants.com";
/// `JQUANTS_PUBLISHER`.
pub const JQUANTS_PUBLISHER: &str = "J-Quants";
/// One page of a day's ~4,400 records (every field of each).
pub const JQUANTS_PAGE_MAX_BYTES: usize = 8_000_000;
/// Pages one day or history may follow (`pagination_key`).
pub const JQUANTS_MAX_PAGES: usize = 20;
/// The Free plan's delay (12 weeks); a paid plan sets 0.
pub const DEFAULT_JQUANTS_DELAY_DAYS: u32 = 84;

/// `jquantsProblem`: a 403 whose message names the API key (or a 401) is
/// the key; any other 403 the plan.
#[must_use]
pub fn jquants_problem(error: &SafeFetchError) -> StockPriceProblem {
	if error.code != SafeFetchErrorCode::HttpError {
		return StockPriceProblem::Failed(error.status);
	}
	if error.status == Some(403) {
		let about_key = error
			.body
			.as_deref()
			.and_then(|body| research_js::json::parse(body).ok())
			.and_then(|body| match body.as_object()?.get("message")? {
				Value::String(message) => Some(message.to_ascii_lowercase().contains("api key")),
				_ => None,
			})
			.unwrap_or(false);
		return if about_key {
			StockPriceProblem::AuthFailed(Some(403))
		} else {
			StockPriceProblem::PlanRefused(403)
		};
	}
	problem_of_status(error.status)
}

/// `parseJquantsPage`: the records and the next page's key.
#[must_use]
pub fn parse_jquants_page(json: &Value) -> Option<(&[Value], Option<String>)> {
	let object = json.as_object()?;
	let records = object.get("data")?.as_array()?;
	let next = match object.get("pagination_key") {
		None | Some(Value::Null) => None,
		Some(Value::String(key)) => (!key.is_empty()).then(|| key.clone()),
		Some(_) => return None,
	};
	Some((records, next))
}

/// One record that gives a bar.
struct Record {
	symbol: String,
	date: String,
	close: f64,
	bar: MarketBar,
	adjusted: bool,
}

fn read_record(row: &Value) -> Option<Record> {
	let object = row.as_object()?;
	let date = object.get("Date")?.as_str()?;
	let code = object.get("Code")?.as_str()?;
	if !is_iso_date(date) {
		return None;
	}
	let symbol = jquants_code_to_symbol(code)?;
	let (close, bar) = consistent_bar(
		object.get("AdjO"),
		object.get("AdjH"),
		object.get("AdjL"),
		object.get("AdjC"),
		object.get("AdjVo"),
	)?;
	let adjusted = matches!(
		object.get("AdjFactor"),
		Some(Value::Number(factor)) if factor.is_finite() && (*factor - 1.0).abs() > 0.0
	);
	Some(Record {
		symbol,
		date: date.to_owned(),
		close,
		bar,
		adjusted,
	})
}

/// `jquantsDayAnswer`: the date's bars and the symbols adjusted that day.
#[must_use]
pub fn jquants_day_answer(records: &[Value], date: &str) -> StockDayAnswer {
	let mut bars = Vec::new();
	let mut adjusted = BTreeSet::new();
	for record in records.iter().filter_map(read_record) {
		if record.date != date {
			continue;
		}
		if record.adjusted {
			adjusted.insert(record.symbol.clone());
		}
		bars.push(StockDayBar(record.symbol, record.close, record.bar));
	}
	StockDayAnswer {
		bars: finish_day_bars(bars),
		adjusted_symbols: adjusted.into_iter().collect(),
	}
}

/// `jquantsHistoryBars`: one code's bars.
#[must_use]
pub fn jquants_history_bars(records: &[Value], symbol: &str) -> Vec<StockHistoryBar> {
	records
		.iter()
		.filter_map(read_record)
		.filter(|record| record.symbol == symbol)
		.map(|record| StockHistoryBar(record.date, record.close, record.bar))
		.collect()
}

/// The JP stock-price source over J-Quants.
pub struct JquantsStockPriceSource {
	api_key: Secret,
	fetcher: Arc<dyn SafeFetcher>,
	delay_days: i64,
}

impl JquantsStockPriceSource {
	/// Constructs the source; `delay_days` is `JQUANTS_DELAY_DAYS`.
	pub fn new(api_key: Secret, fetcher: Arc<dyn SafeFetcher>, delay_days: u32) -> Self {
		Self {
			api_key,
			fetcher,
			delay_days: i64::from(delay_days),
		}
	}

	/// Every page of one query, each paced.
	async fn records(
		&self,
		query: &[(&str, &str)],
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<Value>, StockPriceProblem> {
		let mut all = Vec::new();
		let mut key: Option<String> = None;
		let mut page = 0;
		while page == 0 || key.is_some() {
			if page >= JQUANTS_MAX_PAGES {
				return Err(StockPriceProblem::Failed(None));
			}
			// Built before the await: the serializer is not `Send`.
			let url = {
				let mut params = url::form_urlencoded::Serializer::new(String::new());
				for (name, value) in query {
					params.append_pair(name, value);
				}
				if let Some(key) = &key {
					params.append_pair("pagination_key", key);
				}
				format!(
					"https://{JQUANTS_HOST}/v2/equities/bars/daily?{}",
					params.finish()
				)
			};
			context.admit().await?;
			let mut options = fetch_options(JQUANTS_HOST, "application/json", context.cancel);
			options.max_bytes = JQUANTS_PAGE_MAX_BYTES;
			options.x_api_key = Some(self.api_key.expose().to_owned());
			options.include_error_body = true;
			let json = fetch_json_document(self.fetcher.as_ref(), &url, &options)
				.await
				.map_err(|error| jquants_problem(&error))?;
			let (records, next) =
				parse_jquants_page(&json).ok_or(StockPriceProblem::Failed(None))?;
			all.extend(records.iter().cloned());
			key = next;
			page += 1;
		}
		Ok(all)
	}
}

#[async_trait]
impl StockPriceSource for JquantsStockPriceSource {
	fn provider(&self) -> StockPriceProvider {
		StockPriceProvider::Jquants
	}
	fn market(&self) -> WatchMarket {
		WatchMarket::Jp
	}
	fn delay_days(&self) -> i64 {
		self.delay_days
	}
	fn splits_in_day_answers(&self) -> bool {
		true
	}
	async fn fetch_day(
		&self,
		date: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<StockDayAnswer, StockPriceProblem> {
		let records = self.records(&[("date", date)], context).await?;
		Ok(jquants_day_answer(&records, date))
	}
	async fn fetch_history(
		&self,
		symbol: &str,
		from: &str,
		to: &str,
		context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<StockHistoryBar>, StockPriceProblem> {
		let code = symbol_to_jquants_code(symbol).ok_or(StockPriceProblem::NotFound(None))?;
		let records = self
			.records(&[("code", &code), ("from", from), ("to", to)], context)
			.await?;
		Ok(jquants_history_bars(&records, symbol))
	}
	async fn fetch_split_symbols(
		&self,
		_after: &str,
		_through: &str,
		_context: &StockPriceRequestContext<'_>,
	) -> Result<Vec<String>, StockPriceProblem> {
		// J-Quants reports adjustments in the day answers (`AdjFactor`).
		Ok(Vec::new())
	}
}
