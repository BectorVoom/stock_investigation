//! GDELT news search (`searchTools.ts`, ADR-0025).
use crate::{
	news::{NOTICE, argument, invalid_args, meta, options, string_args},
	shared::*,
};
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::records::SourceClass;
use research_domain::{news::url_policy::validate_fetch_url, text::truncate::truncate_text};
use research_js::{
	date,
	json::{self, Value},
	uri::encode_uri_component,
	whitespace::trim,
};
use std::{
	collections::HashSet,
	collections::VecDeque,
	sync::{Arc, Mutex, PoisonError},
	time::Duration,
};
use tokio_util::sync::CancellationToken;

/// GDELT asks for one request per 5 s.
const GDELT_SPACING_MS: i64 = 5_000;
const GDELT_KEY: &str = "api.gdeltproject.org";
/// `SEARCH_TIMEOUT_MS` of the TypeScript: one fetch's whole budget.
const SEARCH_TIMEOUT_MS: u64 = 15_000;

/// Cancellation-aware waiting, injected for deterministic transcripts.
#[async_trait]
pub trait Sleep: Send + Sync {
	/// Resolves after the wait or when cancelled; never fails.
	async fn sleep(&self, milliseconds: u64, cancel: &CancellationToken);
}
/// Tokio implementation of the environment sleep port.
pub struct TokioSleep;
#[async_trait]
impl Sleep for TokioSleep {
	async fn sleep(&self, milliseconds: u64, cancel: &CancellationToken) {
		tokio::select! { () = tokio::time::sleep(Duration::from_millis(milliseconds)) => {}, () = cancel.cancelled() => {} }
	}
}
/// Dependencies of `web.search`. One factory instance shares its GDELT limiter.
#[derive(Clone)]
pub struct SearchToolDeps {
	/// SSRF-safe fetcher.
	pub fetcher: Arc<dyn SafeFetcher>,
	/// Evidence hasher.
	pub hasher: Arc<dyn Hasher>,
	/// Environment clock.
	pub clock: Arc<dyn Clock>,
	/// Cancellation-aware delay.
	pub sleep: Arc<dyn Sleep>,
}
struct SearchTool {
	deps: SearchToolDeps,
	meta: ToolMeta,
	/// Recorded GDELT request starts, process-wide per factory.
	ledger: Ledger,
}
struct Hit {
	title: String,
	publisher: String,
	url: String,
	published_at: Option<String>,
	text: String,
}
enum Search {
	Ok(Vec<Hit>),
	Failed(String),
	Aborted,
}

/// Construct the single `web.search` tool.
pub fn create_search_tools(deps: SearchToolDeps) -> Vec<Arc<dyn Tool>> {
	vec![Arc::new(SearchTool {
		deps,
		ledger: Ledger::new(GDELT_SPACING_MS, 1),
		meta: meta(
			"web.search",
			"Searches recent news (GDELT) for short keywords and returns result titles and URLs with evidence ids; read a promising result with web.fetch_page.",
			r#"{ "query": "<2–200 characters of keywords, e.g. gold price 2026>" }"#,
			40_000,
			ToolCostCategory::RateLimited,
			ToolSideEffect::ExternalRead,
			ToolNetworkAllowlist::PublicWeb,
		),
	})]
}
fn seendate(text: &str) -> Option<String> {
	if text.len() != 16
		|| !text.get(..8)?.bytes().all(|b| b.is_ascii_digit())
		|| text.get(8..9)? != "T"
		|| !text.get(9..15)?.bytes().all(|b| b.is_ascii_digit())
		|| text.get(15..)? != "Z"
	{
		return None;
	}
	// Date.UTC maps years 00..99 to 1900..1999, so its round-trip rejects them.
	if text.get(..4)?.parse::<u16>().ok()? < 100 {
		return None;
	}
	let iso = format!(
		"{}-{}-{}T{}:{}:{}.000Z",
		text.get(..4)?,
		text.get(4..6)?,
		text.get(6..8)?,
		text.get(9..11)?,
		text.get(11..13)?,
		text.get(13..15)?
	);
	let result = date::to_iso_string(date::parse(&iso))?;
	(result == iso).then_some(result)
}
/// GDELT `artlist` articles; `None` when the answer has an unexpected shape.
fn gdelt_hits(value: &Value) -> Option<Vec<Hit>> {
	let root = value.as_object()?;
	let items = match root.get("articles") {
		None => return Some(Vec::new()),
		Some(value) => value.as_array()?,
	};
	let mut hits = Vec::with_capacity(items.len());
	for item in items {
		let object = item.as_object()?;
		let title = trim(object.get("title")?.as_str()?);
		let optional_string = |key| match object.get(key) {
			None => Some(None),
			Some(value) => value.as_str().map(Some),
		};
		let url = object.get("url")?.as_str()?;
		let domain = optional_string("domain")?;
		let seen = optional_string("seendate")?;
		if title.is_empty() {
			continue;
		}
		hits.push(Hit {
			title: title.into(),
			publisher: domain.map_or_else(
				|| {
					validate_fetch_url(url)
						.map_or_else(|_| "unknown publisher".into(), |v| v.hostname)
				},
				str::to_owned,
			),
			url: url.into(),
			published_at: seen.and_then(seendate),
			text: title.into(),
		});
	}
	Some(hits)
}
impl SearchTool {
	async fn gdelt(&self, query: &str, context: &ToolContext) -> Search {
		// C2: wait for the request's slot; a start is recorded only when sent.
		if !await_slot(
			&self.ledger,
			GDELT_KEY,
			self.deps.clock.as_ref(),
			self.deps.sleep.as_ref(),
			&context.cancel,
			false,
		)
		.await
		{
			return Search::Aborted;
		}
		let url = format!(
			"https://api.gdeltproject.org/api/v2/doc/doc?query={}&mode=artlist&format=json&maxrecords=10&sort=hybridrel",
			encode_uri_component(&format!("{query} sourcelang:english"))
		);
		let mut opts = options(1_000_000, SEARCH_TIMEOUT_MS, "application/json", context);
		opts.allowed_hosts = Some([GDELT_KEY.into()].into());
		opts.user_agent = Some("research-workspace/1.0 (personal research tool)".into());
		let fetched = match self.deps.fetcher.fetch_text(&url, &opts).await {
			Ok(v) => v,
			Err(e) => {
				return Search::Failed(
					truncate_text(&format!("{}: {}", e.code.as_str(), e.detail), 200).into_owned(),
				);
			}
		};
		match json::parse(&fetched.text) {
			Err(_) => {
				let line = trim(fetched.text.split('\n').next().unwrap_or(""));
				Search::Failed(
					truncate_text(
						if line.is_empty() {
							"empty response"
						} else {
							line
						},
						200,
					)
					.into_owned(),
				)
			}
			Ok(value) => gdelt_hits(&value).map_or_else(
				|| Search::Failed("unexpected response shape".into()),
				Search::Ok,
			),
		}
	}
}
#[async_trait]
impl Tool for SearchTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}
	fn parse_args(&self, args: &Value) -> Option<Value> {
		string_args(args, "query", 2, 200, true)
	}
	async fn execute(&self, args: Value, context: ToolContext) -> Result<ToolOutput, ToolFailure> {
		let args = self.parse_args(&args).ok_or_else(invalid_args)?;
		let query = argument(&args, "query")?;
		let hits = match self.gdelt(&query, &context).await {
			Search::Aborted => {
				return Err(tool_failure("TOOL_ABORTED", "run was cancelled", false));
			}
			Search::Failed(cause) => return Err(tool_failure("SEARCH_FAILED", &cause, true)),
			Search::Ok(hits) => hits,
		};
		let retrieved_at = (context.now_iso)();
		let mut seen = HashSet::new();
		let mut evidence = Vec::new();
		let mut lines = vec![NOTICE.into()];
		for hit in hits {
			let Ok(target) = validate_fetch_url(&hit.url) else {
				continue;
			};
			// GDELT may list the same page twice; one evidence item per URL.
			if !seen.insert(target.href.clone()) {
				continue;
			}
			let collected = collect_evidence(
				self.deps.hasher.as_ref(),
				EvidenceInput {
					evidence_id: context.ids.next_id("ev"),
					source_url: target.href,
					title: hit.title,
					publisher: hit.publisher,
					published_at: hit.published_at,
					retrieved_at: retrieved_at.clone(),
					effective_at: None,
					source_class: SourceClass::News,
					retrieved_text: hit.text,
					retain_quotes: false,
					excerpt: None,
				},
			);
			let e = &collected.evidence;
			lines.push(format!(
				"[{}] {} — {}; {} — {}",
				e.evidence_id,
				e.title,
				e.publisher,
				e.published_at.as_deref().unwrap_or("undated"),
				e.source_url
			));
			evidence.push(collected);
		}
		if evidence.is_empty() {
			lines = vec![format!(
				"No results for {query}. Try shorter or different keywords."
			)];
		} else {
			lines.push("Read a promising result with web.fetch_page before relying on it.".into());
		}
		Ok(ToolOutput {
			model_text: bound_model_text(&lines),
			evidence,
			..ToolOutput::default()
		})
	}
}

// The unbounded-integer model and its spacing proof live in
// formal/ResearchFormal/Spacing.lean (`claim`, `reserveSlot`). Valid Date
// milliseconds leave ample i64 headroom.
pub(crate) fn reserve_slot(now: i64, last: Option<i64>, interval: i64) -> i64 {
	last.map_or(now, |last| now.max(last.saturating_add(interval)))
}

/// What a ticket holder learns when it asks to send now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Claim {
	/// The start was recorded; send immediately.
	Started,
	/// Cancelled before sending; nothing was recorded.
	Aborted,
	/// Not yet: the milliseconds until the earliest permitted start.
	Wait(i64),
	/// An earlier caller is still ahead in the queue.
	NotYourTurn,
}

#[derive(Debug, Default)]
struct LedgerState {
	/// Recorded starts per key, FIFO-evicted beyond `capacity` keys.
	starts: VecDeque<(String, i64)>,
	/// Waiting tickets per key, oldest first.
	queues: Vec<(String, VecDeque<u64>)>,
	next_ticket: u64,
}

/// Request starts per key, at least `interval_ms` apart (ADR-0030 C2). Only a
/// start that is actually being sent is ever recorded, and callers are served
/// first come, first served (only the head of a key's ticket queue may claim),
/// so no caller can be starved by later arrivals.
///
/// Proof: `formal/ResearchFormal/Spacing.lean` (`run_spaced`). The model has
/// one unbounded ledger per key; here at most `capacity` keys are remembered
/// (the TypeScript maps' FIFO bound), so the spacing guarantee holds for every
/// remembered key. A key forgotten after more than `capacity` other keys were
/// started may start at once; the web tool's capacity is 200 hosts.
#[derive(Debug)]
pub struct Ledger {
	state: Mutex<LedgerState>,
	turn: tokio::sync::Notify,
	interval_ms: i64,
	capacity: usize,
}

/// A place in a key's queue; dropping it (sent, cancelled, future dropped)
/// leaves the queue and wakes the next waiter.
pub(crate) struct Ticket<'a> {
	ledger: &'a Ledger,
	key: String,
	id: u64,
}

impl Drop for Ticket<'_> {
	fn drop(&mut self) {
		{
			let mut state = self.ledger.state();
			if let Some(index) = state.queues.iter().position(|(k, _)| *k == self.key) {
				if let Some((_, queue)) = state.queues.get_mut(index) {
					queue.retain(|id| *id != self.id);
					if queue.is_empty() {
						state.queues.swap_remove(index);
					}
				}
			}
		}
		self.ledger.turn.notify_waiters();
	}
}

impl Ledger {
	/// A ledger remembering at most `capacity` keys.
	#[must_use]
	pub fn new(interval_ms: i64, capacity: usize) -> Self {
		Self {
			state: Mutex::new(LedgerState::default()),
			turn: tokio::sync::Notify::new(),
			interval_ms,
			capacity,
		}
	}
	fn state(&self) -> std::sync::MutexGuard<'_, LedgerState> {
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}
	/// Milliseconds `key` would have to wait at `now` (0 when it may start).
	#[must_use]
	pub fn peek_wait(&self, key: &str, now: i64) -> i64 {
		let state = self.state();
		let previous = state.starts.iter().find(|(k, _)| k == key).map(|e| e.1);
		reserve_slot(now, previous, self.interval_ms).saturating_sub(now)
	}
	pub(crate) fn enqueue(&self, key: &str) -> Ticket<'_> {
		let mut state = self.state();
		let id = state.next_ticket;
		state.next_ticket = state.next_ticket.wrapping_add(1);
		match state.queues.iter_mut().find(|(k, _)| k == key) {
			Some((_, queue)) => queue.push_back(id),
			None => state.queues.push((key.to_owned(), VecDeque::from([id]))),
		}
		Ticket {
			ledger: self,
			key: key.to_owned(),
			id,
		}
	}
	/// Under the lock: only the head ticket may claim. It records exactly `now`
	/// (the instant it decided on, which the model's `claim` also records) when
	/// `now` is at least `interval` after the recorded start. A head that
	/// already has a previous start and is cancelled gets [`Claim::Aborted`]
	/// without a record when `abort_if_previous` carries its token.
	pub(crate) fn claim(
		&self,
		ticket: &Ticket<'_>,
		now: i64,
		abort_if_previous: Option<&CancellationToken>,
	) -> Claim {
		let mut state = self.state();
		let is_head = state
			.queues
			.iter()
			.find(|(k, _)| *k == ticket.key)
			.and_then(|(_, queue)| queue.front())
			.is_some_and(|id| *id == ticket.id);
		if !is_head {
			return Claim::NotYourTurn;
		}
		let previous = state
			.starts
			.iter()
			.find(|(k, _)| *k == ticket.key)
			.map(|e| e.1);
		let wait = reserve_slot(now, previous, self.interval_ms).saturating_sub(now);
		if wait > 0 {
			return Claim::Wait(wait);
		}
		if previous.is_some() && abort_if_previous.is_some_and(CancellationToken::is_cancelled) {
			return Claim::Aborted;
		}
		crate::web::cache_set(&mut state.starts, &ticket.key, now, self.capacity);
		Claim::Started
	}
	/// Notes that `key` was contacted at `instant` (a request that ended on
	/// another URL): the recorded start becomes `max(existing, instant)`, so
	/// it can never move backwards over a later caller's start.
	pub fn note(&self, key: &str, instant: i64) {
		let mut state = self.state();
		let latest = state
			.starts
			.iter()
			.find(|(k, _)| k == key)
			.map_or(instant, |e| e.1.max(instant));
		crate::web::cache_set(&mut state.starts, key, latest, self.capacity);
	}
}

/// Waits (first come, first served) until `key` may start and records the
/// start at that instant; false when cancelled first (nothing recorded, the
/// ticket is released). Clock reads match the TypeScript: one before and one
/// at the recorded start, and the recorded value is the very value decided
/// on. `abort_without_wait` also checks cancellation when no wait is needed
/// and an earlier start exists (the web tool's politeness rule).
pub async fn await_slot(
	ledger: &Ledger,
	key: &str,
	clock: &dyn Clock,
	sleep: &dyn Sleep,
	cancel: &CancellationToken,
	abort_without_wait: bool,
) -> bool {
	let ticket = ledger.enqueue(key);
	let mut now = clock.now_ms();
	// The TypeScript reads the clock a second time when it records the start;
	// that second read is the instant decided on (and recorded) here.
	let mut reread = true;
	loop {
		// Registered before the state is inspected, so a wake-up cannot be lost.
		let mut turn = std::pin::pin!(ledger.turn.notified());
		turn.as_mut().enable();
		if reread && ledger.peek_wait(key, now) == 0 {
			now = clock.now_ms();
		}
		reread = false;
		let token = abort_without_wait.then_some(cancel);
		match ledger.claim(&ticket, now, token) {
			Claim::Started => return true,
			Claim::Aborted => return false,
			Claim::Wait(ms) => {
				sleep.sleep(u64::try_from(ms).unwrap_or(0), cancel).await;
				if cancel.is_cancelled() {
					return false;
				}
				// The sleep port guarantees `ms` elapsed unless cancelled, so a
				// clock that lags behind it (a scripted one) cannot hold us here.
				now = clock.now_ms().max(now.saturating_add(ms));
			}
			Claim::NotYourTurn => {
				tokio::select! {
					() = &mut turn => {}
					() = cancel.cancelled() => return false,
				}
				now = clock.now_ms();
			}
		}
	}
}
