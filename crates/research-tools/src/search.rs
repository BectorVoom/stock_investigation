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
	sync::{Arc, LazyLock, Mutex, PoisonError},
	time::Duration,
};
use tokio_util::sync::CancellationToken;

/// GDELT asks for one request per 5 s.
const GDELT_SPACING_MS: i64 = 5_000;

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
	/// Prepare a validated GDELT connection while spacing runs.
	async fn preconnect(&self, cancel: &CancellationToken);
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
	/// Start (or reserved start) of the latest GDELT request, process-wide per factory.
	last: Mutex<Option<i64>>,
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
		last: Mutex::new(None),
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
	/// Replaces this call's reservation by `value` unless a later caller already
	/// chained its own slot on it.
	fn settle(&self, expected: i64, value: Option<i64>) {
		let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
		if *last == Some(expected) {
			*last = value;
		}
	}
	/// Waits until a GDELT request may start; false when cancelled while waiting.
	/// C2: the slot `max(now, last + 5 s)` is reserved under the lock before any
	/// await, so concurrent calls can never start inside the window. C5: when a
	/// wait is needed the connection (DNS, TCP, TLS) opens at once and only the
	/// request waits for the slot.
	async fn spacing(&self, context: &ToolContext) -> bool {
		let now = self.deps.clock.now_ms();
		let (previous, slot) = {
			let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
			let previous = *last;
			let slot = reserve_slot(now, previous, GDELT_SPACING_MS);
			*last = Some(slot);
			(previous, slot)
		};
		let wait = slot.saturating_sub(now);
		if wait > 0 {
			let delay = self
				.deps
				.sleep
				.sleep(u64::try_from(wait).unwrap_or(0), &context.cancel);
			if let Some(preconnect) = &self.deps.preconnect {
				tokio::join!(preconnect.preconnect(&context.cancel), delay);
			} else {
				delay.await;
			}
			if context.cancel.is_cancelled() {
				// Nothing was sent: the earlier start stays authoritative.
				self.settle(slot, previous);
				return false;
			}
		}
		self.settle(slot, Some(self.deps.clock.now_ms()));
		true
	}
	async fn backend(&self, query: &str, gdelt: bool, context: &ToolContext) -> Backend {
		if gdelt && !self.spacing(context).await {
			return Backend::Aborted;
		}
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
		let mut opts = options(1_000_000, 15_000, "application/json", context);
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
		let (gdelt, wiki) = tokio::join!(
			self.backend(&query, true, &context),
			self.backend(&query, false, &context)
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
	async fn preconnect(&self, cancel: &CancellationToken) {
		// This is an optional optimization. Its typed failure never replaces the
		// real fetch result, which repeats DNS validation and reports failures.
		let _preparation = research_net::NodeSafeFetcher::preconnect(
			self,
			"https://api.gdeltproject.org/",
			15_000,
			Some(cancel.clone()),
		)
		.await;
	}
}

// The unbounded-integer model and its minimality/spacing proofs live in
// robots/Slots.lean (`reserveSlot`). Valid Date milliseconds leave ample i64 headroom.
pub(crate) fn reserve_slot(now: i64, last: Option<i64>, interval: i64) -> i64 {
	last.map_or(now, |last| now.max(last.saturating_add(interval)))
}
