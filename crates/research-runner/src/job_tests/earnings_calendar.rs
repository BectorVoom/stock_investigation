//! `earnings-calendar-sync` jobs through the shell (ADR-0068; the job body's
//! conformance is `vectors/finance/jobs_earnings_calendar.json`): dispatch,
//! the lifecycle states, the wiring by market, and the failures.

use research_contracts::earnings_calendar::EarningsCalendarEvent;
use research_contracts::watchlist::{
	EarningsSourceId, EarningsTiming, EarningsUnavailableCode, WatchMarket,
};
use research_finance::ports::{
	EarningsMarketCalendar, EarningsMarketCalendarFailure, EarningsMarketCalendarQuery,
	EarningsMarketCalendarSource,
};

use super::*;

pub(super) fn calendar_job(market: &str) -> ClaimedJob {
	parse(&format!(
		r#"{{{},"market":"{market}","fromDate":"2026-11-03","toDate":"2027-05-07"}}"#,
		lease("earnings-calendar-sync", "run_calendar", 5, 20_000)
	))
	.unwrap()
}

fn event(symbol: &str, date: Option<&str>) -> EarningsCalendarEvent {
	EarningsCalendarEvent {
		period_key: "2026-q3".to_owned(),
		announcement_date: date.map(str::to_owned),
		fiscal_period_label: "Q3 2026".to_owned(),
		fiscal_period_end: None,
		timing: EarningsTiming::BeforeOpen,
		symbol: symbol.to_owned(),
	}
}

/// Answers once with `answer`, taking one pacing grant first; records the windows asked.
struct FakeCalendar {
	source: EarningsSourceId,
	answer: Result<EarningsMarketCalendar, EarningsMarketCalendarFailure>,
	windows: Mutex<Vec<(String, String)>>,
	grants: Mutex<Vec<bool>>,
}

impl FakeCalendar {
	fn answering(
		source: EarningsSourceId,
		answer: Result<EarningsMarketCalendar, EarningsMarketCalendarFailure>,
	) -> Arc<Self> {
		Arc::new(Self {
			source,
			answer,
			windows: Mutex::new(Vec::new()),
			grants: Mutex::new(Vec::new()),
		})
	}
}

#[async_trait]
impl EarningsMarketCalendarSource for FakeCalendar {
	fn source_id(&self) -> EarningsSourceId {
		self.source
	}
	async fn fetch_calendar(
		&self,
		query: EarningsMarketCalendarQuery<'_>,
	) -> Result<EarningsMarketCalendar, EarningsMarketCalendarFailure> {
		self.windows
			.lock()
			.unwrap()
			.push((query.from_date.to_owned(), query.to_date.to_owned()));
		let granted = query.before_request.before_request().await;
		self.grants.lock().unwrap().push(granted);
		self.answer.clone()
	}
}

fn calendar_harness(api: &Arc<FakeApi>, sources: &[&Arc<FakeCalendar>]) -> Harness {
	harness(
		Arc::clone(api),
		Options {
			calendar_sources: sources
				.iter()
				.map(|source| {
					(
						source.source.as_str().to_owned(),
						Arc::clone(*source) as Arc<dyn EarningsMarketCalendarSource>,
					)
				})
				.collect(),
			..Options::default()
		},
	)
}

fn us_calendar() -> EarningsMarketCalendar {
	EarningsMarketCalendar {
		events: vec![
			event("AAPL", Some("2026-11-05")),
			event("BH-A", Some("2026-11-03")),
		],
		truncated_dates: vec!["2026-11-05".to_owned()],
	}
}

/// The completion of a US calendar with a truncated day (the golden file's).
pub(super) async fn us_calendar_completion() -> CompleteJobRequest {
	let api = FakeApi::new(ApiScript::default());
	let finnhub = FakeCalendar::answering(EarningsSourceId::Finnhub, Ok(us_calendar()));
	let harness = calendar_harness(&api, &[&finnhub]);
	run(calendar_job("US"), &harness).await;
	first_completion(&api)
}

#[tokio::test]
async fn a_market_calendar_completes_through_its_markets_source() {
	let api = FakeApi::new(ApiScript::default());
	let finnhub = FakeCalendar::answering(EarningsSourceId::Finnhub, Ok(us_calendar()));
	let jpx = FakeCalendar::answering(
		EarningsSourceId::Jpx,
		Ok(EarningsMarketCalendar {
			events: vec![event("7203", None)],
			truncated_dates: Vec::new(),
		}),
	);
	let harness = calendar_harness(&api, &[&finnhub, &jpx]);
	run(calendar_job("JP"), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	let Some(CompleteJobRequest::EarningsCalendarSynced {
		lease_generation,
		market,
		from_date,
		to_date,
		events,
		truncated_dates,
		..
	}) = calls.completions.first()
	else {
		panic!("expected an earnings-calendar completion");
	};
	assert_eq!(*lease_generation, 5);
	assert_eq!(*market, WatchMarket::Jp);
	assert_eq!(
		(from_date.as_str(), to_date.as_str()),
		("2026-11-03", "2027-05-07")
	);
	assert_eq!(events, &vec![event("7203", None)]);
	assert!(truncated_dates.is_empty());
	// Only JPX was asked, for the claimed window, with one pacing grant.
	assert!(finnhub.windows.lock().unwrap().is_empty());
	assert_eq!(
		*jpx.windows.lock().unwrap(),
		[("2026-11-03".to_owned(), "2027-05-07".to_owned())]
	);
	assert_eq!(*jpx.grants.lock().unwrap(), [true]);
	assert!(
		harness
			.log
			.events()
			.contains(&"earnings_calendar_fetched".to_owned())
	);
}

#[tokio::test]
async fn a_us_calendar_without_finnhub_fails_as_not_configured() {
	let api = FakeApi::new(ApiScript::default());
	let jpx = FakeCalendar::answering(EarningsSourceId::Jpx, Ok(us_calendar()));
	let harness = calendar_harness(&api, &[&jpx]);
	run(calendar_job("US"), &harness).await;
	let calls = api.calls();
	assert_eq!(state_sequence(&calls), FULL_LIFECYCLE);
	assert_eq!(
		failure_of(&calls),
		("SOURCE_NOT_CONFIGURED".to_owned(), false)
	);
	assert!(jpx.windows.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_calendar_failure_keeps_its_code_and_status_and_only_a_source_failure_is_retried() {
	for (code, upstream_status, retryable) in [
		(EarningsUnavailableCode::SourceFailed, Some(503), true),
		(EarningsUnavailableCode::SourceFailed, None, true),
		(EarningsUnavailableCode::RateLimited, Some(429), false),
		(EarningsUnavailableCode::SourceAuthFailed, Some(401), false),
		(EarningsUnavailableCode::PlanNotEntitled, Some(403), false),
	] {
		let api = FakeApi::new(ApiScript::default());
		let finnhub = FakeCalendar::answering(
			EarningsSourceId::Finnhub,
			Err(EarningsMarketCalendarFailure {
				code,
				upstream_status,
			}),
		);
		let harness = calendar_harness(&api, &[&finnhub]);
		run(calendar_job("US"), &harness).await;
		let calls = api.calls();
		let Some(CompleteJobRequest::Failed {
			failure_code,
			failure_upstream_status,
			retryable: actual_retryable,
			..
		}) = calls.completions.first()
		else {
			panic!("expected a failed completion");
		};
		assert_eq!(failure_code, code.as_str());
		assert_eq!(*failure_upstream_status, Tri::or_absent(upstream_status));
		assert_eq!(*actual_retryable, retryable, "{code:?}");
	}
}

#[tokio::test]
async fn a_calendar_the_api_would_refuse_fails_instead_of_being_sent() {
	let api = FakeApi::new(ApiScript::default());
	let finnhub = FakeCalendar::answering(
		EarningsSourceId::Finnhub,
		Ok(EarningsMarketCalendar {
			events: vec![event("AAPL", Some("2026-11-05")), event("AAPL", None)],
			truncated_dates: Vec::new(),
		}),
	);
	let harness = calendar_harness(&api, &[&finnhub]);
	run(calendar_job("US"), &harness).await;
	assert_eq!(failure_of(&api.calls()), ("SOURCE_FAILED".to_owned(), true));
	assert!(
		harness
			.log
			.events()
			.contains(&"earnings_calendar_rejected".to_owned())
	);
}
