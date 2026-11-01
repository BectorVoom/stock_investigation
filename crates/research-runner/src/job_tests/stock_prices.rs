//! `stock-prices-sync` jobs through the shell (ADR-0058 §2; port of
//! `apps/runner/test/stockPricesSync.test.ts`): the real Massive source over
//! a fake fetcher, the proved state order, the completion the Worker
//! receives, and the failures with the provider's status unchanged.

use research_contracts::stock_prices::{StockDayBar, StockPriceDayOutcome};
use research_contracts::watchlist::WatchMarket;
use research_finance::massive::MassiveStockPriceSource;
use research_finance::ports::Secret;

use super::*;

const GROUPED: &str = "https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks";

/// `START_MS` is 2026-10-10 in New York.
fn prices_job(days: &str) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"market":"US","days":{days},"histories":[],"adjustmentsSince":null,"windowStart":"2024-10-11"}}"#,
		lease("stock-prices-sync", "run_prices", 3, 20_000)
	))
	.unwrap()
}

/// Answers each URL from `pages`; an unscripted URL fails with `error`.
struct PricePages {
	pages: HashMap<String, String>,
	error: SafeFetchError,
	urls: Mutex<Vec<String>>,
}

#[async_trait]
impl SafeFetcher for PricePages {
	async fn fetch_text(
		&self,
		url: &str,
		options: &SafeFetchOptions,
	) -> Result<FetchedDocument, SafeFetchError> {
		assert_eq!(
			options.authorization.as_deref(),
			Some("Bearer massive-key-1")
		);
		self.urls.lock().unwrap().push(url.to_owned());
		self.pages.get(url).map_or_else(
			|| Err(self.error.clone()),
			|text| {
				Ok(FetchedDocument {
					final_url: url.to_owned(),
					content_type: Some("application/json".to_owned()),
					text: text.clone(),
				})
			},
		)
	}
}

fn massive_harness(api: &Arc<FakeApi>, fetcher: &Arc<PricePages>) -> Harness {
	let source: Arc<dyn research_finance::stock_prices::StockPriceSource> = Arc::new(
		MassiveStockPriceSource::new(Secret::new("massive-key-1"), Arc::clone(fetcher) as _),
	);
	harness(
		Arc::clone(api),
		Options {
			stock_price_sources: vec![(WatchMarket::Us, source)],
			..Options::default()
		},
	)
}

#[tokio::test]
async fn a_day_walk_completes_with_the_bars_the_worker_accepts() {
	let api = FakeApi::new(ApiScript::default());
	let fetcher = Arc::new(PricePages {
		pages: HashMap::from([
			(
				format!("{GROUPED}/2026-10-09?adjusted=true"),
				r#"{"results":[{"T":"BRK.B","o":410,"h":415.25,"l":409.5,"c":412.5,"v":3120455,"t":1}],"status":"OK"}"#.to_owned(),
			),
			(
				format!("{GROUPED}/2026-10-08?adjusted=true"),
				r#"{"resultsCount":0,"status":"OK"}"#.to_owned(),
			),
		]),
		error: SafeFetchError::http(404, "HTTP 404", None),
		urls: Mutex::new(Vec::new()),
	});
	let harness = massive_harness(&api, &fetcher);
	run(prices_job(r#"["2026-10-09","2026-10-08"]"#), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::StockPricesSynced {
		days,
		provider,
		histories,
		..
	}) = calls.completions.first()
	else {
		panic!("expected stock-prices-synced, got {:?}", calls.completions);
	};
	assert_eq!(provider.as_str(), "massive");
	assert!(histories.is_empty());
	assert_eq!(days.len(), 2);
	assert_eq!(days[0].outcome, StockPriceDayOutcome::Stored);
	let StockDayBar(symbol, close, _) = &days[0].bars[0];
	assert_eq!((symbol.as_str(), *close), ("BRK-B", 412.5));
	// Two days old in New York: not final yet.
	assert_eq!(days[1].outcome, StockPriceDayOutcome::NotYetAvailable);
	assert!(
		harness
			.log
			.lines()
			.iter()
			.any(|line| line.contains("stock_prices_synced"))
	);
}

#[tokio::test]
async fn without_a_key_the_job_fails_before_any_request() {
	let api = FakeApi::new(ApiScript::default());
	let harness = harness(Arc::clone(&api), Options::default());
	run(prices_job(r#"["2026-10-09"]"#), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	match calls.completions.first() {
		Some(CompleteJobRequest::Failed {
			failure_code,
			retryable,
			failure_upstream_status,
			..
		}) => {
			assert_eq!(failure_code, "SOURCE_NOT_CONFIGURED");
			assert!(!retryable);
			assert_eq!(*failure_upstream_status, Tri::Absent);
		}
		other => panic!("expected failed, got {other:?}"),
	}
}

#[tokio::test]
async fn a_rejected_key_fails_with_the_providers_status() {
	let api = FakeApi::new(ApiScript::default());
	let fetcher = Arc::new(PricePages {
		pages: HashMap::new(),
		error: SafeFetchError::http(401, "HTTP 401", None),
		urls: Mutex::new(Vec::new()),
	});
	let harness = massive_harness(&api, &fetcher);
	run(prices_job(r#"["2026-10-09","2026-10-08"]"#), &harness).await;
	match api.calls().completions.first() {
		Some(CompleteJobRequest::Failed {
			failure_code,
			retryable,
			failure_upstream_status,
			..
		}) => {
			assert_eq!(failure_code, "SOURCE_AUTH_FAILED");
			assert!(!retryable);
			assert_eq!(*failure_upstream_status, Tri::Value(401));
		}
		other => panic!("expected failed, got {other:?}"),
	}
	// The key failure ends the job at the first request.
	assert_eq!(fetcher.urls.lock().unwrap().len(), 1);
	assert!(
		harness
			.log
			.lines()
			.iter()
			.any(|line| line.contains("stock_prices_failed"))
	);
}
