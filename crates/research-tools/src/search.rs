//! Parallel GDELT/Wikipedia search (`searchTools.ts`, ADR-0025).
use crate::{
	news::{NOTICE, argument, invalid_args, meta, options, regex, string_args},
	shared::*,
};
use async_trait::async_trait;
use regex::Regex;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::records::SourceClass;
use research_domain::{news::url_policy::validate_fetch_url, text::truncate::truncate_text};
use research_js::{
	date,
	json::{self, Value},
	uri::encode_uri_component,
	whitespace::{collapse, trim},
};
use std::{
	collections::HashSet,
	collections::VecDeque,
	sync::{Arc, LazyLock, Mutex, PoisonError},
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
/// Optional connection-only optimization; no HTTP request is sent here.
#[async_trait]
pub trait SearchPreconnect: Send + Sync {
	/// Prepares a validated GDELT connection within `timeout_ms`; failures are
	/// ignored because the real fetch repeats every check and reports them.
	async fn preconnect(&self, timeout_ms: u64, cancel: &CancellationToken);
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
	/// Production preconnection capability, absent for scripted fetchers.
	pub preconnect: Option<Arc<dyn SearchPreconnect>>,
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
	class: SourceClass,
}
enum Backend {
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
			"Searches recent news (GDELT) and Wikipedia for short keywords and returns result titles and URLs with evidence ids; read a promising result with web.fetch_page.",
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
fn excerpt(text: &str) -> String {
	static TAG: LazyLock<Option<Regex>> = LazyLock::new(|| regex("<[^>]*>"));
	static ENTITY: LazyLock<Option<Regex>> =
		LazyLock::new(|| regex(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);"));
	let stripped = TAG
		.as_ref()
		.map_or_else(|| text.into(), |r| r.replace_all(text, ""));
	let decoded = ENTITY.as_ref().map_or_else(
		|| stripped.clone(),
		|r| {
			r.replace_all(&stripped, |caps: &regex::Captures<'_>| {
				let body = caps.get(1).map_or("", |m| m.as_str());
				let named = match body {
					"amp" => Some("&"),
					"lt" => Some("<"),
					"gt" => Some(">"),
					"quot" => Some("\""),
					"apos" => Some("'"),
					"nbsp" => Some("\u{00A0}"),
					"ndash" => Some("–"),
					"mdash" => Some("—"),
					"hellip" => Some("…"),
					"lsquo" => Some("‘"),
					"rsquo" => Some("’"),
					"ldquo" => Some("“"),
					"rdquo" => Some("”"),
					"laquo" => Some("«"),
					"raquo" => Some("»"),
					_ => None,
				};
				if let Some(named) = named {
					return named.to_owned();
				}
				if let Some(numeric) = body.strip_prefix('#') {
					let (digits, radix) = numeric
						.strip_prefix(['x', 'X'])
						.map_or((numeric, 10), |s| (s, 16));
					// Numeric references with arbitrarily many leading zeroes still parse in JS.
					let digits = digits.trim_start_matches('0');
					if let Ok(code) =
						u32::from_str_radix(if digits.is_empty() { "0" } else { digits }, radix)
					{
						if code <= 0x10ffff {
							return char::from_u32(code).unwrap_or('\u{FFFD}').to_string();
						}
					}
				}
				caps.get(0).map_or("", |m| m.as_str()).to_owned()
			})
		},
	);
	trim(&collapse(&decoded)).to_owned()
}
fn provider_items(value: &Value, gdelt: bool) -> Option<Vec<Hit>> {
	let root = value.as_object()?;
	let items = match root.get(if gdelt { "articles" } else { "pages" }) {
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
		let hit = if gdelt {
			let url = object.get("url")?.as_str()?;
			let domain = optional_string("domain")?;
			let seen = optional_string("seendate")?;
			Hit {
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
				class: SourceClass::News,
			}
		} else {
			let key = object.get("key")?.as_str()?;
			let snippet = optional_string("excerpt")?;
			let description = match object.get("description") {
				None | Some(Value::Null) => "",
				Some(value) => value.as_str()?,
			};
			let description = trim(description);
			let snippet = excerpt(snippet.unwrap_or(""));
			let mut parts = vec![title];
			if !description.is_empty() {
				parts.push(description);
			}
			if !snippet.is_empty() && snippet != description {
				parts.push(&snippet);
			}
			if key.is_empty() {
				continue;
			}
			Hit {
				title: title.into(),
				publisher: "Wikipedia".into(),
				url: format!(
					"https://en.wikipedia.org/wiki/{}",
					encode_uri_component(key)
				),
				published_at: None,
				text: parts.join("\n"),
				class: SourceClass::Other,
			}
		};
		if !title.is_empty() {
			hits.push(hit);
		}
	}
	Some(hits)
}
impl SearchTool {
	/// Waits until a GDELT request may start; `Err` carries the failure cause
	/// when the call must not send, `Ok(timeout)` the fetch budget otherwise.
	///
	/// C2: nothing is reserved. A start is recorded only at the instant the
	/// request is sent (`Ledger::claim` under its lock), so a caller that never
	/// sends records nothing and no restore exists. C5: when the slot is not yet
	/// open the connection is prepared during the wait; the preparation shares
	/// the fetch's overall deadline (spacing wait + `SEARCH_TIMEOUT_MS`) and
	/// whatever it spends beyond the wait is deducted from the fetch budget.
	async fn gate(&self, context: &ToolContext) -> Result<u64, Backend> {
		let mut budget = SEARCH_TIMEOUT_MS;
		if let Some(preconnect) = &self.deps.preconnect {
			let began = self.deps.clock.now_ms();
			let wait = self.ledger.peek_wait(GDELT_KEY, began);
			if wait > 0 {
				let wait_ms = u64::try_from(wait).unwrap_or(0);
				tokio::join!(
					preconnect
						.preconnect(wait_ms.saturating_add(SEARCH_TIMEOUT_MS), &context.cancel),
					self.deps.sleep.sleep(wait_ms, &context.cancel)
				);
				if context.cancel.is_cancelled() {
					return Err(Backend::Aborted);
				}
				let spent = self
					.deps
					.clock
					.now_ms()
					.saturating_sub(began)
					.saturating_sub(wait);
				budget = SEARCH_TIMEOUT_MS.saturating_sub(u64::try_from(spent).unwrap_or(0));
				if budget == 0 {
					return Err(Backend::Failed(format!(
						"TIMEOUT: no complete response within {SEARCH_TIMEOUT_MS} ms"
					)));
				}
			}
		}
		if await_slot(
			&self.ledger,
			GDELT_KEY,
			self.deps.clock.as_ref(),
			self.deps.sleep.as_ref(),
			&context.cancel,
			false,
		)
		.await
		{
			Ok(budget)
		} else {
			Err(Backend::Aborted)
		}
	}
	async fn backend(&self, query: &str, gdelt: bool, context: &ToolContext) -> Backend {
		let budget = if gdelt {
			match self.gate(context).await {
				Ok(budget) => budget,
				Err(outcome) => return outcome,
			}
		} else {
			SEARCH_TIMEOUT_MS
		};
		let (host, url) = if gdelt {
			(
				"api.gdeltproject.org",
				format!(
					"https://api.gdeltproject.org/api/v2/doc/doc?query={}&mode=artlist&format=json&maxrecords=10&sort=hybridrel",
					encode_uri_component(&format!("{query} sourcelang:english"))
				),
			)
		} else {
			(
				"en.wikipedia.org",
				format!(
					"https://en.wikipedia.org/w/rest.php/v1/search/page?q={}&limit=3",
					encode_uri_component(query)
				),
			)
		};
		let mut opts = options(1_000_000, budget, "application/json", context);
		opts.allowed_hosts = Some([host.into()].into());
		opts.user_agent = Some("research-workspace/1.0 (personal research tool)".into());
		let fetched = match self.deps.fetcher.fetch_text(&url, &opts).await {
			Ok(v) => v,
			Err(e) => {
				return Backend::Failed(
					truncate_text(&format!("{}: {}", e.code.as_str(), e.detail), 200).into_owned(),
				);
			}
		};
		match json::parse(&fetched.text) {
			Err(_) => {
				let line = trim(fetched.text.split('\n').next().unwrap_or(""));
				Backend::Failed(
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
			Ok(value) => provider_items(&value, gdelt).map_or_else(
				|| Backend::Failed("unexpected response shape".into()),
				Backend::Ok,
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
		// Wikipedia is polled first: in the TypeScript GDELT's request always
		// comes after at least one await (the spacing check), so Wikipedia's
		// request is the first one made.
		let (wiki, gdelt) = tokio::join!(
			self.backend(&query, false, &context),
			self.backend(&query, true, &context)
		);
		if matches!(gdelt, Backend::Aborted) || matches!(wiki, Backend::Aborted) {
			return Err(tool_failure("TOOL_ABORTED", "run was cancelled", false));
		}
		if let (Backend::Failed(a), Backend::Failed(b)) = (&gdelt, &wiki) {
			return Err(tool_failure("SEARCH_FAILED", &format!("{a}; {b}"), true));
		}
		let retrieved_at = (context.now_iso)();
		let mut seen = HashSet::new();
		let mut evidence = Vec::new();
		let mut lines = vec![NOTICE.into()];
		for backend in [&gdelt, &wiki] {
			if let Backend::Ok(hits) = backend {
				for hit in hits {
					let Ok(target) = validate_fetch_url(&hit.url) else {
						continue;
					};
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
							source_class: hit.class,
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
					evidence.push(collected);
				}
			}
		}
		if evidence.is_empty() {
			lines = vec![format!(
				"No results for {query}. Try shorter or different keywords."
			)];
		}
		if let Backend::Failed(cause) = gdelt {
			lines.push(format!("GDELT news search failed: {cause}."));
		}
		if let Backend::Failed(cause) = wiki {
			lines.push(format!("Wikipedia search failed: {cause}."));
		}
		if !evidence.is_empty() {
			lines.push("Read a promising result with web.fetch_page before relying on it.".into());
		}
		Ok(ToolOutput {
			model_text: bound_model_text(&lines),
			evidence,
			..ToolOutput::default()
		})
	}
}

#[async_trait]
impl SearchPreconnect for research_net::NodeSafeFetcher {
	async fn preconnect(&self, timeout_ms: u64, cancel: &CancellationToken) {
		// This is an optional optimization. Its typed failure never replaces the
		// real fetch result, which repeats DNS validation and reports failures.
		let _preparation = research_net::NodeSafeFetcher::preconnect(
			self,
			"https://api.gdeltproject.org/",
			timeout_ms,
			Some(cancel.clone()),
		)
		.await;
	}
}

// The unbounded-integer model and its spacing proof live in
// formal/ResearchFormal/Spacing.lean (`claim`, `reserveSlot`). Valid Date
// milliseconds leave ample i64 headroom.
pub(crate) fn reserve_slot(now: i64, last: Option<i64>, interval: i64) -> i64 {
	last.map_or(now, |last| now.max(last.saturating_add(interval)))
}

/// What a caller learns when it asks to send now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
	/// The start was recorded; send immediately.
	Started,
	/// Cancelled before sending; nothing was recorded.
	Aborted,
	/// Not yet: the milliseconds until the earliest permitted start.
	Wait(i64),
}

/// Request starts per key, at least `interval_ms` apart (ADR-0030 C2). Only a
/// start that is actually being sent is ever recorded.
#[derive(Debug)]
pub struct Ledger {
	entries: Mutex<VecDeque<(String, i64)>>,
	interval_ms: i64,
	capacity: usize,
}

impl Ledger {
	/// A ledger keeping at most `capacity` keys (oldest evicted first, like
	/// the TypeScript maps).
	#[must_use]
	pub fn new(interval_ms: i64, capacity: usize) -> Self {
		Self {
			entries: Mutex::new(VecDeque::new()),
			interval_ms,
			capacity,
		}
	}
	fn entries(&self) -> std::sync::MutexGuard<'_, VecDeque<(String, i64)>> {
		self.entries.lock().unwrap_or_else(PoisonError::into_inner)
	}
	/// Milliseconds `key` would have to wait at `now` (0 when it may start).
	#[must_use]
	pub fn peek_wait(&self, key: &str, now: i64) -> i64 {
		let previous = self.entries().iter().find(|(k, _)| k == key).map(|e| e.1);
		reserve_slot(now, previous, self.interval_ms).saturating_sub(now)
	}
	/// Under the lock: if `now` is at least `interval` after the recorded
	/// start, records `record(now)` (the real send instant, never earlier than
	/// `now`) and returns [`Claim::Started`]. A caller that already has a
	/// previous start and is cancelled gets [`Claim::Aborted`] without a record
	/// when `abort_if_previous` carries its token.
	pub fn claim(
		&self,
		key: &str,
		now: i64,
		abort_if_previous: Option<&CancellationToken>,
		record: impl FnOnce(i64) -> i64,
	) -> Claim {
		let mut entries = self.entries();
		let previous = entries.iter().find(|(k, _)| k == key).map(|e| e.1);
		let wait = reserve_slot(now, previous, self.interval_ms).saturating_sub(now);
		if wait > 0 {
			return Claim::Wait(wait);
		}
		if previous.is_some() && abort_if_previous.is_some_and(CancellationToken::is_cancelled) {
			return Claim::Aborted;
		}
		let started = record(now).max(now);
		crate::web::cache_set(&mut entries, key, started, self.capacity);
		Claim::Started
	}
	/// Notes that `key` was contacted at `instant` (a request that ended on
	/// another URL): the recorded start becomes `max(existing, instant)`, so
	/// it can never move backwards over a later caller's start.
	pub fn note(&self, key: &str, instant: i64) {
		let mut entries = self.entries();
		let latest = entries
			.iter()
			.find(|(k, _)| k == key)
			.map_or(instant, |e| e.1.max(instant));
		crate::web::cache_set(&mut entries, key, latest, self.capacity);
	}
}

/// Waits until `key` may start and records the start at that instant; false
/// when cancelled first (nothing recorded). Clock reads match the TypeScript:
/// one before and one at the recorded start. `abort_without_wait` also
/// checks cancellation when no wait is needed and an earlier start exists
/// (the web tool's politeness rule).
pub(crate) async fn await_slot(
	ledger: &Ledger,
	key: &str,
	clock: &dyn Clock,
	sleep: &dyn Sleep,
	cancel: &CancellationToken,
	abort_without_wait: bool,
) -> bool {
	let mut now = clock.now_ms();
	let mut first = true;
	loop {
		let token = abort_without_wait.then_some(cancel);
		let claim = ledger.claim(key, now, token, |n| {
			if first { clock.now_ms().max(n) } else { n }
		});
		match claim {
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
				first = false;
			}
		}
	}
}
