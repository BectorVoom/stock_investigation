//! Search tools (`searchTools.ts`, ADR-0025): `web.search` over Tavily (needs
//! the owner's key) and `news.search` over GDELT. A provider outage pauses
//! that provider: 60 s, doubling per consecutive outage up to 30 minutes;
//! GDELT's plain-text rate-limit notice (an HTTP 200) counts as one
//! (ADR-0039 §6). A well-formed answer ends the escalation, another malformed
//! one leaves it as is. A successful answer is reused for 15 minutes, keyed by
//! provider and normalised query, with its real retrieval time (ADR-0039 §5).
use crate::{
	news::{NOTICE, argument, invalid_args, meta, options, regex, string_args},
	shared::*,
};
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::records::SourceClass;
use research_domain::{news::url_policy::validate_fetch_url, text::truncate::truncate_text};
use research_js::{
	date,
	json::{self, Object, Value},
	uri::encode_uri_component,
	whitespace::{collapse, trim},
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
const TAVILY_HOST: &str = "api.tavily.com";
/// `SEARCH_TIMEOUT_MS` of the TypeScript: one fetch's whole budget.
const SEARCH_TIMEOUT_MS: u64 = 15_000;
/// The first outage pauses a provider this long; each further consecutive outage doubles it.
const SEARCH_COOLDOWN_MS: i64 = 60_000;
/// Ceiling of the escalating pause (30 minutes).
const SEARCH_COOLDOWN_MAX_MS: i64 = 1_800_000;
const SEARCH_USER_AGENT: &str = "research-workspace/1.0 (personal research tool)";
/// Tavily returns at most this many results per call (1 credit per basic search).
const TAVILY_MAX_RESULTS: f64 = 10.0;
/// A successful answer is reused this long (ADR-0039 §5).
const SEARCH_CACHE_TTL_MS: i64 = 900_000;
/// At most this many answers are kept; the oldest is evicted first.
const SEARCH_CACHE_MAX_ENTRIES: usize = 200;
/// GDELT's rate-limit notice under HTTP 200 ("Please limit requests to one
/// every 5 seconds…"), matched ASCII case-insensitively like the TypeScript.
const GDELT_THROTTLE_TEXT: &str = "limit requests";
/// A web result's snippet as retrieved text, bounded.
const SNIPPET_MAX_CHARS: usize = 1_000;
/// The snippet shown to the planner beside each result, bounded more tightly.
const SNIPPET_PREVIEW_CHARS: usize = 300;

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
/// Dependencies of the search tools. One factory instance shares its GDELT
/// limiter and each provider's pause.
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
	/// The owner's Tavily key; `web.search` is registered only when it is set.
	pub tavily_api_key: Option<String>,
}

/// One provider's escalating outage pause. Clock reads match the TypeScript:
/// one to compare while a window exists, one to open a window.
#[derive(Default)]
struct OutagePause {
	/// `(retry after, window length)`; the length stays after expiry so the
	/// next outage doubles it, until a well-formed answer clears both.
	state: Mutex<(Option<i64>, i64)>,
}
impl OutagePause {
	fn lock(&self) -> std::sync::MutexGuard<'_, (Option<i64>, i64)> {
		self.state.lock().unwrap_or_else(PoisonError::into_inner)
	}
	/// The current window's length while paused.
	fn paused(&self, clock: &dyn Clock) -> Option<i64> {
		let (retry_after, window) = *self.lock();
		retry_after
			.is_some_and(|deadline| clock.now_ms() < deadline)
			.then_some(window)
	}
	fn outage(&self, clock: &dyn Clock) {
		let mut state = self.lock();
		let window = if state.1 == 0 {
			SEARCH_COOLDOWN_MS
		} else {
			state.1.saturating_mul(2).min(SEARCH_COOLDOWN_MAX_MS)
		};
		*state = (Some(clock.now_ms().saturating_add(window)), window);
	}
	fn answered(&self) {
		*self.lock() = (None, 0);
	}
}

#[derive(Clone)]
struct Hit {
	title: String,
	publisher: String,
	url: String,
	published_at: Option<String>,
	text: String,
	/// Shown to the planner after the result line; `None` for headlines.
	preview: Option<String>,
}
enum Search {
	Ok(Vec<Hit>),
	/// The cause, and the provider's answer status unchanged (`None` when it
	/// did not answer with one, §4a).
	Failed(String, Option<u16>),
	CoolingDown(i64),
	Aborted,
}

enum Provider {
	Tavily { api_key: String },
	Gdelt { ledger: Ledger },
}
impl Provider {
	/// The provider's part of a cache key.
	const fn cache_name(&self) -> &'static str {
		match self {
			Self::Tavily { .. } => "tavily",
			Self::Gdelt { .. } => "gdelt",
		}
	}
}
struct SearchTool {
	deps: SearchToolDeps,
	meta: ToolMeta,
	provider: Provider,
	pause: OutagePause,
	/// Shared by both tools of one factory, like the TypeScript closure.
	cache: Arc<SearchCache>,
}

struct CachedSearch {
	hits: Arc<[Hit]>,
	/// The real request's retrieval time: a reuse reports this, never its own.
	retrieved_at: String,
	/// `deps.clock` time the answer was stored, for the TTL.
	stored_at_ms: i64,
}
/// Successful answers by key, oldest first. The clock is read only to judge
/// an existing entry and to store one, the same reads as the TypeScript. A
/// linear scan over at most 200 keys costs nothing beside a request.
#[derive(Default)]
struct SearchCache {
	entries: Mutex<VecDeque<(String, Arc<CachedSearch>)>>,
}
impl SearchCache {
	fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(String, Arc<CachedSearch>)>> {
		self.entries.lock().unwrap_or_else(PoisonError::into_inner)
	}
	/// The fresh answer for `key`; an expired one is dropped.
	fn get(&self, key: &str, clock: &dyn Clock) -> Option<Arc<CachedSearch>> {
		let mut entries = self.lock();
		let index = entries.iter().position(|(k, _)| k == key)?;
		let entry = Arc::clone(&entries.get(index)?.1);
		let age = clock.now_ms().saturating_sub(entry.stored_at_ms);
		// A clock that went backwards also expires it: freshness is unknown.
		if (0..SEARCH_CACHE_TTL_MS).contains(&age) {
			return Some(entry);
		}
		entries.remove(index);
		None
	}
	fn set(&self, key: String, hits: Arc<[Hit]>, retrieved_at: String, clock: &dyn Clock) {
		let stored_at_ms = clock.now_ms();
		let mut entries = self.lock();
		if let Some(index) = entries.iter().position(|(k, _)| *k == key) {
			entries.remove(index);
		}
		while entries.len() >= SEARCH_CACHE_MAX_ENTRIES {
			entries.pop_front();
		}
		entries.push_back((
			key,
			Arc::new(CachedSearch {
				hits,
				retrieved_at,
				stored_at_ms,
			}),
		));
	}
}
/// The provider plus the query as the provider reads it: trimmed, inner
/// whitespace runs collapsed, lower-cased (`toLowerCase`). The query is the
/// only argument that changes either request.
fn cache_key(provider: &str, query: &str) -> String {
	format!("{provider}\u{0}{}", one_line(query).to_lowercase())
}

/// `web.search` (with a Tavily key) then `news.search`, in catalogue order.
pub fn create_search_tools(deps: SearchToolDeps) -> Vec<Arc<dyn Tool>> {
	let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
	let cache = Arc::new(SearchCache::default());
	if let Some(api_key) = deps.tavily_api_key.clone() {
		let mut web = meta(
			"web.search",
			"Searches the whole web (Tavily) for short keywords and returns result titles, URLs and snippets with evidence ids; read a promising result with web.fetch_page.",
			r#"{ "query": "<2–200 characters of keywords, e.g. Apple quarterly revenue 2026>" }"#,
			20_000,
			ToolCostCategory::Metered,
			ToolSideEffect::ExternalRead,
			ToolNetworkAllowlist::PublicWeb,
		);
		web.version = "2.0.0";
		tools.push(Arc::new(SearchTool {
			deps: deps.clone(),
			meta: web,
			provider: Provider::Tavily { api_key },
			pause: OutagePause::default(),
			cache: Arc::clone(&cache),
		}));
	}
	tools.push(Arc::new(SearchTool {
		deps,
		meta: meta(
			"news.search",
			"Searches recent news articles (GDELT) for short keywords and returns headlines and URLs with evidence ids; read a promising result with web.fetch_page.",
			r#"{ "query": "<2–200 characters of keywords, e.g. gold price 2026>" }"#,
			40_000,
			ToolCostCategory::RateLimited,
			ToolSideEffect::ExternalRead,
			ToolNetworkAllowlist::PublicWeb,
		),
		provider: Provider::Gdelt {
			ledger: Ledger::new(GDELT_SPACING_MS, 1),
		},
		pause: OutagePause::default(),
		cache,
	}));
	tools
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
/// `zonedDateToIso`: a date alone or a text ending in an explicit zone, as
/// ISO 8601; anything whose meaning depends on the machine's zone is `None`.
#[must_use]
pub fn zoned_date_to_iso(text: &str) -> Option<String> {
	let trimmed = trim(text);
	let date_only = regex(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")?;
	let zoned = regex(r"(?:Z|GMT|UTC|[+-][0-9]{2}:?[0-9]{2})$")?;
	if !date_only.is_match(trimmed) && !zoned.is_match(trimmed) {
		return None;
	}
	date::to_iso_string(date::parse(trimmed))
}
fn host_or_unknown(url: &str) -> String {
	validate_fetch_url(url).map_or_else(|_| "unknown publisher".into(), |v| v.hostname)
}
fn fetch_cause(error: &SafeFetchError) -> String {
	truncate_text(&format!("{}: {}", error.code.as_str(), error.detail), 200).into_owned()
}
fn first_line(text: &str) -> String {
	let line = trim(text.split('\n').next().unwrap_or(""));
	truncate_text(
		if line.is_empty() {
			"empty response"
		} else {
			line
		},
		200,
	)
	.into_owned()
}
/// `text.replace(/\s+/g, " ").trim()`.
fn one_line(text: &str) -> String {
	trim(&collapse(text)).to_owned()
}
/// A field that may be absent or null (zod `.nullish()`); `None` when it has another type.
fn nullish_string<'a>(object: &'a Object, key: &str) -> Option<Option<&'a str>> {
	match object.get(key) {
		None | Some(Value::Null) => Some(None),
		Some(value) => value.as_str().map(Some),
	}
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
			publisher: domain.map_or_else(|| host_or_unknown(url), str::to_owned),
			url: url.into(),
			published_at: seen.and_then(seendate),
			text: title.into(),
			preview: None,
		});
	}
	Some(hits)
}
/// Tavily `/search` results; `None` when the answer has an unexpected shape.
fn tavily_hits(value: &Value) -> Option<Vec<Hit>> {
	let items = value.as_object()?.get("results")?.as_array()?;
	let mut hits = Vec::with_capacity(items.len());
	for item in items {
		let object = item.as_object()?;
		let url = object.get("url")?.as_str()?;
		let title = one_line(object.get("title")?.as_str()?);
		let content = nullish_string(object, "content")?;
		let published = nullish_string(object, "published_date")?;
		if title.is_empty() {
			continue;
		}
		let snippet = one_line(content.unwrap_or(""));
		hits.push(Hit {
			publisher: host_or_unknown(url),
			url: url.into(),
			published_at: published.and_then(zoned_date_to_iso),
			text: if snippet.is_empty() {
				title.clone()
			} else {
				format!("{title}\n{}", truncate_text(&snippet, SNIPPET_MAX_CHARS))
			},
			preview: (!snippet.is_empty())
				.then(|| truncate_text(&snippet, SNIPPET_PREVIEW_CHARS).into_owned()),
			title,
		});
	}
	Some(hits)
}
/// Why a provider's 200 answer is unusable.
enum Unusable {
	/// Not JSON: a provider's plain-text notice.
	Text,
	/// JSON of an unexpected shape.
	Shape,
}
impl Unusable {
	/// The bounded cause the model sees: a text's first line.
	fn cause(&self, text: &str) -> String {
		match self {
			Self::Text => first_line(text),
			Self::Shape => "unexpected response shape".into(),
		}
	}
}
fn parsed_hits(text: &str, shape: fn(&Value) -> Option<Vec<Hit>>) -> Result<Vec<Hit>, Unusable> {
	match json::parse(text) {
		Err(_) => Err(Unusable::Text),
		Ok(value) => shape(&value).ok_or(Unusable::Shape),
	}
}
impl SearchTool {
	fn paused(&self, context: &ToolContext) -> Option<Search> {
		let window = self.pause.paused(self.deps.clock.as_ref())?;
		Some(if context.cancel.is_cancelled() {
			Search::Aborted
		} else {
			Search::CoolingDown(window)
		})
	}
	async fn gdelt(&self, ledger: &Ledger, query: &str, context: &ToolContext) -> Search {
		if let Some(paused) = self.paused(context) {
			return paused;
		}
		// C2: wait for the request's slot; a start is recorded only when sent.
		if !await_slot(
			ledger,
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
		opts.user_agent = Some(SEARCH_USER_AGENT.into());
		let fetched = match self.deps.fetcher.fetch_text(&url, &opts).await {
			Ok(v) => v,
			Err(e) => {
				// Cancellation shares the fetcher's TIMEOUT code; it must not
				// pause searching for another run. Query errors (4xx except
				// rate limiting) also do not indicate a provider outage.
				let outage = matches!(
					e.code,
					SafeFetchErrorCode::Timeout | SafeFetchErrorCode::NetworkError
				) || e
					.http_error_status()
					.is_some_and(|status| status == 429 || (500..600).contains(&status));
				if outage && !context.cancel.is_cancelled() {
					self.pause.outage(self.deps.clock.as_ref());
				}
				return Search::Failed(fetch_cause(&e), upstream_status_of(&e));
			}
		};
		match parsed_hits(&fetched.text, gdelt_hits) {
			// A 200 with plain text or a bad shape: the provider answered with
			// no error status (§4a). Its rate-limit notice is the outage a 429
			// is, so it opens the pause (ADR-0039 §6).
			Err(unusable) => {
				if matches!(unusable, Unusable::Text)
					&& fetched
						.text
						.to_ascii_lowercase()
						.contains(GDELT_THROTTLE_TEXT)
					&& !context.cancel.is_cancelled()
				{
					self.pause.outage(self.deps.clock.as_ref());
				}
				Search::Failed(unusable.cause(&fetched.text), None)
			}
			Ok(hits) => {
				self.pause.answered();
				Search::Ok(hits)
			}
		}
	}
	async fn tavily(&self, api_key: &str, query: &str, context: &ToolContext) -> Search {
		if let Some(paused) = self.paused(context) {
			return paused;
		}
		if context.cancel.is_cancelled() {
			return Search::Aborted;
		}
		let mut opts = options(1_000_000, SEARCH_TIMEOUT_MS, "application/json", context);
		opts.allowed_hosts = Some([TAVILY_HOST.into()].into());
		opts.user_agent = Some(SEARCH_USER_AGENT.into());
		opts.authorization = Some(format!("Bearer {api_key}"));
		// Basic depth costs one credit; dates are asked for so results can be dated.
		opts.json_body = Some(json::stringify(&Value::Object(Object::from_members(vec![
			("query".to_owned(), query.into()),
			("search_depth".to_owned(), "basic".into()),
			("max_results".to_owned(), TAVILY_MAX_RESULTS.into()),
			("include_published_date".to_owned(), true.into()),
		]))));
		let fetched = match self
			.deps
			.fetcher
			.fetch_text(&format!("https://{TAVILY_HOST}/search"), &opts)
			.await
		{
			Ok(v) => v,
			Err(e) => {
				// Only a rejected query (400, 422) says nothing about the
				// provider: every other HTTP status (bad key, quota, rate
				// limit, server error) would fail the next query too.
				let outage = matches!(
					e.code,
					SafeFetchErrorCode::Timeout | SafeFetchErrorCode::NetworkError
				) || e
					.http_error_status()
					.is_some_and(|status| status != 400 && status != 422);
				if outage && !context.cancel.is_cancelled() {
					self.pause.outage(self.deps.clock.as_ref());
				}
				return Search::Failed(fetch_cause(&e), upstream_status_of(&e));
			}
		};
		match parsed_hits(&fetched.text, tavily_hits) {
			// A 200 with plain text or a bad shape: the provider answered with no error status.
			Err(unusable) => Search::Failed(unusable.cause(&fetched.text), None),
			Ok(hits) => {
				self.pause.answered();
				Search::Ok(hits)
			}
		}
	}
	/// The provider's answer, or the failure the model sees.
	async fn request(&self, query: &str, context: &ToolContext) -> Result<Vec<Hit>, ToolFailure> {
		let outcome = match &self.provider {
			Provider::Tavily { api_key } => self.tavily(api_key, query, context).await,
			Provider::Gdelt { ledger } => self.gdelt(ledger, query, context).await,
		};
		match outcome {
			Search::CoolingDown(window) => Err(tool_failure(
				"SEARCH_COOLDOWN",
				&format!(
					"The search service is rate limited or unavailable. Use another search tool, subscribed feeds or known page URLs instead; this search is paused for {} seconds.",
					window / 1000
				),
				true,
			)),
			Search::Aborted => Err(tool_failure("TOOL_ABORTED", "run was cancelled", false)),
			Search::Failed(cause, upstream_status) => Err(tool_failure_upstream(
				"SEARCH_FAILED",
				&cause,
				true,
				upstream_status,
			)),
			Search::Ok(hits) => Ok(hits),
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
		let source_class = match self.provider {
			Provider::Tavily { .. } => SourceClass::Other,
			Provider::Gdelt { .. } => SourceClass::News,
		};
		let clock = self.deps.clock.as_ref();
		let key = cache_key(self.provider.cache_name(), &query);
		// A hit sends nothing, so it neither waits for a GDELT slot nor reads
		// or changes the outage pause.
		let (hits, retrieved_at) = if let Some(cached) = self.cache.get(&key, clock) {
			if context.cancel.is_cancelled() {
				return Err(tool_failure("TOOL_ABORTED", "run was cancelled", false));
			}
			(Arc::clone(&cached.hits), cached.retrieved_at.clone())
		} else {
			let hits: Arc<[Hit]> = self.request(&query, &context).await?.into();
			let retrieved_at = (context.now_iso)();
			// Only a successful answer is stored, with its real retrieval time.
			self.cache
				.set(key, Arc::clone(&hits), retrieved_at.clone(), clock);
			(hits, retrieved_at)
		};
		let mut seen = HashSet::new();
		let mut evidence = Vec::new();
		let mut lines = vec![NOTICE.into()];
		for hit in hits.iter() {
			let Ok(target) = validate_fetch_url(&hit.url) else {
				continue;
			};
			// A provider may list the same page twice; one evidence item per URL.
			if !seen.insert(target.href.clone()) {
				continue;
			}
			let collected = collect_evidence(
				self.deps.hasher.as_ref(),
				EvidenceInput {
					evidence_id: context.ids.next_id("ev"),
					source_url: target.href,
					title: hit.title.clone(),
					publisher: hit.publisher.clone(),
					published_at: hit.published_at.clone(),
					retrieved_at: retrieved_at.clone(),
					effective_at: None,
					source_class,
					retrieved_text: hit.text.clone(),
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
			if let Some(preview) = &hit.preview {
				lines.push(format!("  {preview}"));
			}
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
