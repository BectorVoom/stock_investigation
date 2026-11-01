//! Replays `vectors/finance/stock_prices.json` (written by Node from the real
//! TypeScript: `node scripts/vectors/index.ts finance`, ADR-0058 §2): the
//! ticker and code mapping, the market dates, the day-outcome rules, the
//! Massive and J-Quants parsers and status mappings, and whole
//! `stock-prices-sync` claims over the scripted fetcher, where every request
//! and pacing admission must match.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing,
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss
)]

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use research_application::ports::SafeFetchError;
use research_contracts::stock_prices::{StockDayBar, StockPriceDayOutcome, StockPricesClaim};
use research_contracts::watchlist::WatchMarket;
use research_finance::jquants::{
	JquantsStockPriceSource, jquants_day_answer, jquants_history_bars, jquants_problem,
	parse_jquants_page,
};
use research_finance::massive::{
	MassiveStockPriceSource, massive_problem, parse_massive_day, parse_massive_history,
	parse_massive_splits,
};
use research_finance::ports::{AdmitRequest, MarketRequestAdmission, Secret};
use research_finance::stock_prices::{
	StockDayAnswer, StockPriceProblem, StockPriceSource, StockPricesOutcome, delayed_day_outcome,
	empty_day_outcome, jquants_code_to_symbol, massive_ticker_to_symbol, new_york_date,
	plan_refusal_outcome, symbol_to_jquants_code, symbol_to_massive_ticker, sync_stock_prices,
	tokyo_date,
};
use research_js::json::Value;
use serde_json::{Value as Json, json};
use tokio_util::sync::CancellationToken;

fn vectors() -> Value {
	load("stock_prices.json")
}

fn expected(value: &Value) -> Json {
	norm(&js_to_serde(value))
}

fn optional_string(value: Option<String>) -> Json {
	value.map_or(Json::Null, Json::String)
}

fn outcome_json(outcome: Option<StockPriceDayOutcome>) -> Json {
	outcome.map_or(Json::Null, |outcome| json!(outcome.as_str()))
}

#[test]
fn tickers_and_codes_map_like_the_typescript() {
	let file = vectors();
	let mapping = field(&file, "mapping");
	for case in array(mapping, "tickers") {
		let ticker = text(case, "ticker");
		assert_eq!(
			optional_string(massive_ticker_to_symbol(ticker)),
			expected(field(case, "symbol")),
			"{ticker:?}"
		);
	}
	for case in array(mapping, "symbols") {
		let symbol = text(case, "symbol");
		assert_eq!(
			optional_string(symbol_to_massive_ticker(symbol)),
			expected(field(case, "ticker")),
			"{symbol:?}"
		);
		assert_eq!(
			optional_string(symbol_to_jquants_code(symbol)),
			expected(field(case, "code")),
			"{symbol:?}"
		);
	}
	for case in array(mapping, "codes") {
		let code = text(case, "code");
		assert_eq!(
			optional_string(jquants_code_to_symbol(code)),
			expected(field(case, "symbol")),
			"{code:?}"
		);
	}
}

#[test]
fn market_dates_match() {
	let file = vectors();
	let cases = array(&file, "dates");
	assert!(cases.len() > 1000);
	for case in cases {
		let ms = number(case, "ms") as i64;
		assert_eq!(new_york_date(ms), text(case, "newYork"), "{ms}");
		assert_eq!(tokyo_date(ms), text(case, "tokyo"), "{ms}");
	}
}

#[test]
fn day_outcome_rules_match() {
	let file = vectors();
	for case in array(&file, "outcomes") {
		let age = number(case, "age") as i64;
		let delay = number(case, "delay") as i64;
		let context = format!("age {age} delay {delay}");
		assert_eq!(
			outcome_json(delayed_day_outcome(age, delay)),
			expected(field(case, "delayed")),
			"{context}"
		);
		assert_eq!(
			json!(empty_day_outcome(age, delay).as_str()),
			expected(field(case, "empty")),
			"{context}"
		);
		assert_eq!(
			outcome_json(plan_refusal_outcome(age, delay)),
			expected(field(case, "refusal")),
			"{context}"
		);
	}
}

fn day_bars_json(bars: &[StockDayBar]) -> Json {
	norm(&serde_json::to_value(bars).unwrap())
}

fn answer_json(answer: &StockDayAnswer) -> Json {
	json!({"bars": day_bars_json(&answer.bars), "adjustedSymbols": answer.adjusted_symbols})
}

#[test]
fn provider_bodies_parse_alike() {
	let file = vectors();
	let parse = field(&file, "parse");
	for case in array(parse, "massive") {
		let body = research_js::json::parse(text(case, "text")).unwrap();
		let context = text(case, "text");
		let day = parse_massive_day(&body).map_or(Json::Null, |bars| day_bars_json(&bars));
		assert_eq!(day, expected(field(case, "day")), "day {context}");
		let history = parse_massive_history(&body).map_or(Json::Null, |(bars, next)| {
			norm(&json!({"bars": serde_json::to_value(bars).unwrap(), "next": next}))
		});
		assert_eq!(
			history,
			expected(field(case, "history")),
			"history {context}"
		);
		let splits = parse_massive_splits(&body).map_or(
			Json::Null,
			|(symbols, next)| json!({"symbols": symbols, "next": next}),
		);
		assert_eq!(splits, expected(field(case, "splits")), "splits {context}");
	}
	for case in array(parse, "splits") {
		let body = research_js::json::parse(text(case, "text")).unwrap();
		let splits = parse_massive_splits(&body).map_or(
			Json::Null,
			|(symbols, next)| json!({"symbols": symbols, "next": next}),
		);
		assert_eq!(
			splits,
			expected(field(case, "splits")),
			"{}",
			text(case, "text")
		);
	}
	for case in array(parse, "jquants") {
		let body = research_js::json::parse(text(case, "text")).unwrap();
		let context = text(case, "text");
		let page = parse_jquants_page(&body);
		let page_json = page.as_ref().map_or(
			Json::Null,
			|(records, next)| json!({"next": next, "records": records.len()}),
		);
		assert_eq!(
			norm(&page_json),
			expected(field(case, "page")),
			"page {context}"
		);
		let day = page.as_ref().map_or(Json::Null, |(records, _)| {
			answer_json(&jquants_day_answer(records, "2026-08-07"))
		});
		assert_eq!(day, expected(field(case, "day")), "day {context}");
		let history = page.as_ref().map_or(Json::Null, |(records, _)| {
			norm(&serde_json::to_value(jquants_history_bars(records, "1380")).unwrap())
		});
		assert_eq!(
			history,
			expected(field(case, "history")),
			"history {context}"
		);
	}
}

fn problem_json(problem: StockPriceProblem) -> Json {
	match problem {
		StockPriceProblem::Stopped => json!({"kind": "stopped"}),
		other => json!({"kind": other.kind(), "status": other.status()}),
	}
}

fn fetch_error(error: &Value) -> SafeFetchError {
	fetch_error_of(error)
}

#[test]
fn status_mappings_match() {
	let file = vectors();
	for case in array(&file, "problems") {
		let error = fetch_error(field(case, "error"));
		assert_eq!(
			norm(&problem_json(massive_problem(&error))),
			expected(field(case, "massive")),
			"{error:?}"
		);
		assert_eq!(
			norm(&problem_json(jquants_problem(&error))),
			expected(field(case, "jquants")),
			"{error:?}"
		);
	}
}

/// `scriptedAdmission`: the n-th answer (then `Granted`), logged as `before`.
struct ScriptedAdmission {
	answers: Vec<MarketRequestAdmission>,
	next: Mutex<usize>,
	log: EventLog,
}

#[async_trait::async_trait]
impl AdmitRequest for ScriptedAdmission {
	async fn admit(&self) -> MarketRequestAdmission {
		self.log.push(json!({"before": true}));
		let mut next = self.next.lock().unwrap();
		let answer = self
			.answers
			.get(*next)
			.copied()
			.unwrap_or(MarketRequestAdmission::Granted);
		*next += 1;
		answer
	}
}

fn admission_of(text: &str) -> MarketRequestAdmission {
	match text {
		"granted" => MarketRequestAdmission::Granted,
		"stopped" => MarketRequestAdmission::Stopped,
		"budget-spent" => MarketRequestAdmission::BudgetSpent,
		other => panic!("unknown admission {other}"),
	}
}

fn claim_of(job: &Value) -> StockPricesClaim {
	let object = job.as_object().unwrap();
	let mut members: Vec<(String, Value)> = Vec::new();
	for key in [
		"market",
		"days",
		"histories",
		"adjustmentsSince",
		"windowStart",
	] {
		members.push((key.to_owned(), object.get(key).unwrap().clone()));
	}
	let text = research_js::json::stringify(&Value::Object(
		research_js::json::Object::from_members(members),
	));
	// The claim's own fields, decoded through the full job contract.
	let lease = r#""kind":"stock-prices-sync","runId":"run_prices","leaseGeneration":2,"leaseExpiresAt":"2026-10-31T16:00:00.000Z","attempt":1,"heartbeatIntervalMs":20000,"sources":[]"#;
	let full = format!("{{{lease},{}", &text[1..]);
	match research_contracts::parse::<research_contracts::jobs::ClaimedJob>(&full).unwrap() {
		research_contracts::jobs::ClaimedJob::StockPricesSync(job) => job.claim,
		other => panic!("not a stock-prices-sync job: {other:?}"),
	}
}

fn sync_outcome_json(outcome: &StockPricesOutcome) -> Json {
	norm(&match outcome {
		StockPricesOutcome::Stopped => json!({"kind": "stopped"}),
		StockPricesOutcome::Failed {
			code,
			upstream_status,
			retryable,
		} => json!({
			"kind": "failed",
			"code": code.as_str(),
			"upstreamStatus": upstream_status,
			"retryable": retryable,
		}),
		StockPricesOutcome::Synced {
			days,
			histories,
			splits_over_cap,
			split_symbols,
			split_checked_through,
			ended_by,
		} => json!({
			"kind": "synced",
			"days": serde_json::to_value(days).unwrap(),
			"histories": serde_json::to_value(histories).unwrap(),
			"splitsOverCap": splits_over_cap,
			"splitSymbols": split_symbols,
			"splitCheckedThrough": split_checked_through,
			"endedBy": ended_by.map(|ended| ended.as_str()),
		}),
	})
}

#[tokio::test]
async fn whole_jobs_make_the_same_requests_and_outcomes() {
	let file = vectors();
	let cases = array(&file, "jobs");
	assert!(cases.len() >= 20);
	for case in cases {
		let name = text(case, "name");
		let log = EventLog::default();
		let fetcher = Arc::new(Scripted::new(field(case, "script"), &log));
		let job = field(case, "job");
		let claim = claim_of(job);
		let api_key = Secret::new(text(case, "apiKey"));
		let source: Box<dyn StockPriceSource> = match claim.market {
			WatchMarket::Us => Box::new(MassiveStockPriceSource::new(api_key, fetcher)),
			WatchMarket::Jp => Box::new(JquantsStockPriceSource::new(
				api_key,
				fetcher,
				number(case, "delayDays") as u32,
			)),
		};
		let gate = ScriptedAdmission {
			answers: array(case, "admissions")
				.iter()
				.map(|answer| admission_of(answer.as_str().unwrap()))
				.collect(),
			next: Mutex::new(0),
			log: log.clone(),
		};
		let outcome = sync_stock_prices(
			&claim,
			source.as_ref(),
			number(case, "nowMs") as i64,
			&CancellationToken::new(),
			&gate,
			&|| log.push(json!({"held": true})),
		)
		.await;
		assert_eq!(
			norm(&log.snapshot()),
			expected(field(case, "events")),
			"events of {name}"
		);
		assert_eq!(
			sync_outcome_json(&outcome),
			expected(field(case, "outcome")),
			"outcome of {name}"
		);
	}
}
