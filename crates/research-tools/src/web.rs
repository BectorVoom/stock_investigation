//! Public-page retrieval: per-hop robots approval, politeness, Markdown and archive.
use crate::{
	news::{
		NOTICE, PAGE_ACCEPT, argument, content_type_matches, invalid_args, meta, options,
		string_args,
	},
	robots::{RobotsRules, is_path_allowed, parse_robots_txt},
	search::{Sleep, reserve_slot},
	shared::*,
};
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::records::SourceClass;
use research_domain::{news::url_policy::validate_fetch_url, text::truncate::truncate_text};
use research_js::{
	json::Value,
	utf16::utf16_len,
	whitespace::{is_js_whitespace, trim},
};
use std::{
	collections::VecDeque,
	sync::{Arc, Mutex, MutexGuard, PoisonError},
};
use tokio_util::sync::CancellationToken;
use url::Url;

/// Request starts to one host stay this far apart (politeness).
const POLITENESS_INTERVAL_MS: i64 = 1_000;

/// Dependencies of `web.fetch_page`.
#[derive(Clone)]
pub struct WebToolDeps {
	/// SSRF-safe fetcher, also used for robots files.
	pub fetcher: Arc<dyn SafeFetcher>,
	/// Evidence hasher.
	pub hasher: Arc<dyn Hasher>,
	/// Environment clock.
	pub clock: Arc<dyn Clock>,
	/// Atomic page archive.
	pub page_archive: Arc<dyn PageArchive>,
	/// Cancellation-aware delay.
	pub sleep: Arc<dyn Sleep>,
}
struct CacheEntry {
	rules: Arc<RobotsRules>,
	expires: i64,
}
struct State {
	deps: WebToolDeps,
	robots: Mutex<VecDeque<(String, CacheEntry)>>,
	/// Per-host request-start reservations (FIFO-evicted like the robots cache).
	last: Mutex<VecDeque<(String, i64)>>,
}
/// Locks a std mutex; every critical section is short and never awaits, so a
/// poisoned lock only means another thread panicked and the data is still valid.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn cache_set<T>(cache: &mut VecDeque<(String, T)>, key: &str, value: T) {
	if let Some((_, old)) = cache.iter_mut().find(|(k, _)| k == key) {
		*old = value;
		return;
	}
	if cache.len() >= 200 {
		cache.pop_front();
	}
	cache.push_back((key.into(), value));
}
fn host_path(href: &str) -> Option<(String, String)> {
	let url = Url::parse(href).ok()?;
	let host = url.host_str()?.to_lowercase();
	let host = host.strip_suffix('.').unwrap_or(&host).to_owned();
	let path = match url.query() {
		Some(query) if !query.is_empty() => format!("{}?{query}", url.path()),
		_ => url.path().into(),
	};
	Some((host, path))
}
fn normalize_plain_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut space = false;
	let mut newlines = 0;
	for ch in text.chars() {
		if ch != '\n' && is_js_whitespace(ch) {
			if !space {
				out.push(' ');
			}
			space = true;
			newlines = 0;
		} else {
			space = false;
			if ch == '\n' {
				newlines += 1;
				if newlines <= 2 {
					out.push(ch);
				}
			} else {
				newlines = 0;
				out.push(ch);
			}
		}
	}
	trim(&out).into()
}
impl State {
	async fn robots_for(&self, host: &str, context: &ToolContext) -> Arc<RobotsRules> {
		let now = self.deps.clock.now_ms();
		{
			let mut cache = locked(&self.robots);
			if let Some(index) = cache.iter().position(|(key, _)| key == host) {
				if let Some((_, entry)) = cache.get(index) {
					if now < entry.expires {
						return entry.rules.clone();
					}
				}
				cache.remove(index);
			}
		}
		let mut opts = options(512 * 1024, 10_000, "text/plain", context);
		opts.user_agent = Some("research-workspace/1.0 (personal research tool)".into());
		// RFC 9309 permits cross-host robots redirects; never pin allowed_hosts.
		let rules = match self
			.deps
			.fetcher
			.fetch_text(&format!("https://{host}/robots.txt"), &opts)
			.await
		{
			Ok(doc) => parse_robots_txt(&doc.text, "research-workspace"),
			Err(error)
				if http_status_of(&error).is_some_and(|status| (400..500).contains(&status)) =>
			{
				RobotsRules::allow_all()
			}
			Err(_) => RobotsRules::disallow_all(),
		};
		let rules = Arc::new(rules);
		cache_set(
			&mut locked(&self.robots),
			host,
			CacheEntry {
				rules: rules.clone(),
				expires: self.deps.clock.now_ms().saturating_add(3_600_000),
			},
		);
		rules
	}
	/// Reserves this host's next request-start slot (ADR-0030 C2): under one
	/// lock, `slot = max(now, last + interval)` and the entry becomes `slot`, so
	/// concurrent callers can never start inside the politeness window.
	fn reserve(&self, host: &str, now: i64) -> (Option<i64>, i64) {
		let mut last = locked(&self.last);
		let previous = last.iter().find(|(key, _)| key == host).map(|(_, at)| *at);
		let slot = reserve_slot(now, previous, POLITENESS_INTERVAL_MS);
		cache_set(&mut last, host, slot);
		(previous, slot)
	}
	/// Replaces this call's reservation (`expected`) by `value` (the real start
	/// time, or the old state after an abort) unless a later caller already
	/// chained its own slot on it.
	fn settle(&self, host: &str, expected: i64, value: i64) {
		let mut last = locked(&self.last);
		if let Some((_, at)) = last.iter_mut().find(|(key, _)| key == host) {
			if *at == expected {
				*at = value;
			}
		}
	}
	async fn polite_wait(&self, host: &str, cancel: &CancellationToken) -> bool {
		let now = self.deps.clock.now_ms();
		let (previous, slot) = self.reserve(host, now);
		// TS: only a host with an earlier start can wait or be aborted here.
		if let Some(previous) = previous {
			if slot > now {
				self.deps
					.sleep
					.sleep(u64::try_from(slot.saturating_sub(now)).unwrap_or(0), cancel)
					.await;
			}
			if cancel.is_cancelled() {
				// Nothing was sent, so the old start time stays authoritative.
				self.settle(host, slot, previous);
				return false;
			}
		}
		self.settle(host, slot, self.deps.clock.now_ms());
		true
	}
}
struct Authorizer {
	state: Arc<State>,
	context: ToolContext,
}
#[async_trait]
impl RedirectAuthorizer for Authorizer {
	async fn authorize(&self, url: &str) -> bool {
		let Some((host, path)) = host_path(url) else {
			return false;
		};
		let rules = self.state.robots_for(&host, &self.context).await;
		!self.context.cancel.is_cancelled()
			&& is_path_allowed(&rules, &path)
			&& self.state.polite_wait(&host, &self.context.cancel).await
	}
}
struct WebTool {
	state: Arc<State>,
	meta: ToolMeta,
}
/// Construct `web.fetch_page` with bounded per-factory caches.
pub fn create_web_tools(deps: WebToolDeps) -> Vec<Arc<dyn Tool>> {
	vec![Arc::new(WebTool {
		state: Arc::new(State {
			deps,
			robots: Mutex::new(VecDeque::new()),
			last: Mutex::new(VecDeque::new()),
		}),
		meta: meta(
			"web.fetch_page",
			"Retrieves one public web page and returns it as Markdown with an evidence id; use it for a page a retrieved source links to or names; it cannot search.",
			r#"{ "url": "https://… (one public web page)" }"#,
			40_000,
			ToolCostCategory::RateLimited,
			ToolSideEffect::ExternalReadArchiveWrite,
			ToolNetworkAllowlist::PublicWeb,
		),
	})]
}
fn aborted() -> ToolFailure {
	tool_failure("TOOL_ABORTED", "run was cancelled", false)
}
fn disallowed(host: &str) -> ToolFailure {
	tool_failure(
		"ROBOTS_DISALLOWED",
		&format!("robots.txt of {host} disallows this page"),
		false,
	)
}
#[async_trait]
impl Tool for WebTool {
	fn meta(&self) -> &ToolMeta {
		&self.meta
	}
	fn parse_args(&self, args: &Value) -> Option<Value> {
		string_args(args, "url", 1, 2048, false)
	}
	async fn execute(&self, args: Value, context: ToolContext) -> Result<ToolOutput, ToolFailure> {
		let args = self.parse_args(&args).ok_or_else(invalid_args)?;
		let target = validate_fetch_url(&argument(&args, "url")?)
			.map_err(|error| tool_failure("UNSAFE_URL", error.as_str(), false))?;
		let (_, path) = host_path(&target.href)
			.ok_or_else(|| tool_failure("UNSAFE_URL", "MALFORMED_URL", false))?;
		let state = &self.state;
		let rules = state.robots_for(&target.hostname, &context).await;
		if context.cancel.is_cancelled() {
			return Err(aborted());
		}
		if !is_path_allowed(&rules, &path) {
			return Err(disallowed(&target.hostname));
		}
		if !state.polite_wait(&target.hostname, &context.cancel).await {
			return Err(aborted());
		}
		let mut opts = options(2_000_000, 15_000, PAGE_ACCEPT, &context);
		opts.user_agent = Some("research-workspace/1.0 (personal research tool)".into());
		opts.authorize_redirect = Some(Arc::new(Authorizer {
			state: state.clone(),
			context: context.clone(),
		}));
		let fetched = state
			.deps
			.fetcher
			.fetch_text(&target.href, &opts)
			.await
			.map_err(|error| fetch_failure(&error))?;
		let (final_host, final_path) = host_path(&fetched.final_url)
			.ok_or_else(|| tool_failure("UNSAFE_URL", "the final URL is malformed", false))?;
		if final_host != target.hostname || final_path != path {
			cache_set(
				&mut locked(&state.last),
				&final_host,
				state.deps.clock.now_ms(),
			);
			let rules = state.robots_for(&final_host, &context).await;
			if context.cancel.is_cancelled() {
				return Err(aborted());
			}
			if !is_path_allowed(&rules, &final_path) {
				return Err(disallowed(&final_host));
			}
		}
		let (markdown, title, truncated, omitted) = if fetched
			.content_type
			.as_deref()
			.is_some_and(|t| content_type_matches(t, "text/plain"))
		{
			let normalized = normalize_plain_text(&fetched.text);
			let truncated = utf16_len(&normalized) > MAX_RETRIEVED_TEXT_CHARS;
			(
				truncate_text(&normalized, MAX_RETRIEVED_TEXT_CHARS).into_owned(),
				None,
				truncated,
				OmittedCounts::default(),
			)
		} else if fetched.content_type.as_deref().is_none_or(|t| {
			content_type_matches(t, "text/html") || content_type_matches(t, "application/xhtml+xml")
		}) {
			// A parse is sequential CPU work. The oneshot keeps it off Tokio, and
			// dropping this future cannot reach the subsequent archive write (C3).
			let (send, receive) = tokio::sync::oneshot::channel();
			let html = fetched.text;
			let base = fetched.final_url.clone();
			rayon::spawn(move || {
				let page = research_html::html_to_markdown(
					&html,
					&research_html::Options {
						base_url: &base,
						max_chars: MAX_RETRIEVED_TEXT_CHARS,
					},
				);
				let _ = send.send(page);
			});
			let page = tokio::select! { page = receive => page.map_err(|_| tool_failure("TOOL_THREW","Error",false))?, () = context.cancel.cancelled() => return Err(aborted()) };
			let convert = |count| {
				u32::try_from(count).map_err(|_| tool_failure("TOOL_THREW", "RangeError", false))
			};
			(
				page.markdown,
				page.title,
				page.truncated,
				OmittedCounts {
					boilerplate_blocks: convert(page.omitted.boilerplate_blocks)?,
					menu_lists: convert(page.omitted.menu_lists)?,
					leading_blocks: convert(page.omitted.leading_blocks)?,
				},
			)
		} else {
			return Err(tool_failure(
				"UNSUPPORTED_CONTENT_TYPE",
				"the response is not an HTML or text page",
				false,
			));
		};
		if markdown.is_empty() {
			return Err(tool_failure(
				"EMPTY_PAGE",
				"the page contains no text",
				false,
			));
		}
		if context.cancel.is_cancelled() {
			return Err(aborted());
		}
		let retrieved_at = (context.now_iso)();
		let file = state
			.deps
			.page_archive
			.save(&ArchivedPage {
				source_url: target.href,
				final_url: fetched.final_url.clone(),
				title: title.clone(),
				retrieved_at: retrieved_at.clone(),
				markdown: markdown.clone(),
				omitted: Some(omitted),
			})
			.await
			.map_err(|error| tool_failure("ARCHIVE_WRITE_FAILED", &error.detail, false))?;
		let collected = collect_evidence(
			state.deps.hasher.as_ref(),
			EvidenceInput {
				evidence_id: context.ids.next_id("ev"),
				source_url: fetched.final_url,
				title: title.unwrap_or_else(|| final_host.clone()),
				publisher: final_host,
				published_at: None,
				retrieved_at: retrieved_at.clone(),
				effective_at: None,
				source_class: SourceClass::Other,
				retrieved_text: markdown.clone(),
				retain_quotes: false,
				excerpt: None,
			},
		);
		let note = if omitted != OmittedCounts::default() {
			format!(
				" navigation and menus omitted ({} boilerplate block(s), {} menu list(s), {} leading block(s)); the Markdown starts at the article.",
				omitted.boilerplate_blocks, omitted.menu_lists, omitted.leading_blocks
			)
		} else {
			String::new()
		};
		let lines = vec![
			format!(
				"[{}] {} | {}",
				collected.evidence.evidence_id,
				collected.evidence.title,
				collected.evidence.source_url
			),
			format!(
				"Retrieved {retrieved_at}; saved to {file}{}.{note} The page states no publication date; treat undated material as possibly stale.",
				if truncated { " (text truncated)" } else { "" }
			),
			NOTICE.into(),
			truncate_text(&markdown, 4000).into_owned(),
		];
		Ok(ToolOutput {
			model_text: bound_model_text(&lines),
			evidence: vec![collected],
			..ToolOutput::default()
		})
	}
}
