//! Public-page retrieval: per-hop robots approval, politeness, Markdown and archive.
use crate::{
	news::{
		NOTICE, PAGE_ACCEPT, argument, content_type_matches, cpu, invalid_args, meta, options,
		string_args,
	},
	robots::{RobotsRules, is_path_allowed, parse_robots_txt},
	search::{Ledger, Sleep, await_slot},
	shared::*,
};
use async_trait::async_trait;
use research_agent_core::tools::*;
use research_application::ports::*;
use research_contracts::records::SourceClass;
use research_domain::{
	news::url_policy::{ValidatedFetchUrl, validate_fetch_url},
	text::truncate::truncate_text,
};
use research_js::{
	json::Value,
	utf16::utf16_len,
	whitespace::{is_js_whitespace, trim},
};
use std::{
	collections::{BTreeSet, VecDeque},
	sync::{Arc, Mutex, MutexGuard, PoisonError},
};
use tokio_util::sync::CancellationToken;
use url::Url;

/// Request starts to one host stay this far apart (politeness).
const POLITENESS_INTERVAL_MS: i64 = 1_000;
/// Bound of the robots cache and of the politeness ledger (hosts).
const ROBOTS_CACHE_MAX_HOSTS: usize = 200;

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
/// The product token robots rules are matched against, sent on every page and
/// robots request; the model is never told this value.
pub const PAGE_USER_AGENT: &str = "research-workspace/1.0 (personal research tool)";
struct CacheEntry {
	rules: Arc<RobotsRules>,
	expires: i64,
}
/// How the page tools (`web.fetch_page`, `news.fetch_article`) reach a
/// publisher's page (`pageAccess.ts`): robots.txt before the page and every
/// redirect hop, request starts to one host spaced, the `research-workspace`
/// User-Agent. One instance is shared by both tools of a catalogue, so their
/// robots cache and spacing are one.
pub struct PageAccess {
	fetcher: Arc<dyn SafeFetcher>,
	clock: Arc<dyn Clock>,
	sleep: Arc<dyn Sleep>,
	robots: Mutex<VecDeque<(String, CacheEntry)>>,
	/// Per-host request starts, recorded only when a request is sent (C2).
	starts: Ledger,
}
/// One page request (`PageRequest`): its bounds and an optional host pin.
pub(crate) struct PageRequest<'a> {
	pub max_bytes: usize,
	pub timeout_ms: u64,
	pub accept: &'a str,
	/// When set, the page and every redirect hop must be on this host.
	pub pinned_host: Option<&'a str>,
}
/// Locks a std mutex; every critical section is short and never awaits, so a
/// poisoned lock only means another thread panicked and the data is still valid.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
	mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// A JS `Map` bounded to `capacity` keys: insertion-order (FIFO) eviction, and
/// re-setting an existing key keeps its position.
pub(crate) fn cache_set<T>(
	cache: &mut VecDeque<(String, T)>,
	key: &str,
	value: T,
	capacity: usize,
) {
	if let Some((_, old)) = cache.iter_mut().find(|(k, _)| k == key) {
		*old = value;
		return;
	}
	if cache.len() >= capacity {
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
impl PageAccess {
	/// A page access with empty robots cache and spacing ledger.
	#[must_use]
	pub fn new(
		fetcher: Arc<dyn SafeFetcher>,
		clock: Arc<dyn Clock>,
		sleep: Arc<dyn Sleep>,
	) -> Self {
		Self {
			fetcher,
			clock,
			sleep,
			robots: Mutex::new(VecDeque::new()),
			starts: Ledger::new(POLITENESS_INTERVAL_MS, ROBOTS_CACHE_MAX_HOSTS),
		}
	}
	async fn robots_for(&self, host: &str, context: &ToolContext) -> Arc<RobotsRules> {
		let now = self.clock.now_ms();
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
		opts.user_agent = Some(PAGE_USER_AGENT.into());
		// RFC 9309 permits cross-host robots redirects; never pin allowed_hosts.
		let fetched = self
			.fetcher
			.fetch_text(&format!("https://{host}/robots.txt"), &opts)
			.await;
		// A run cancelled during the fetch learned nothing about the host: the
		// caller sees the abort, and nothing is cached for the next run.
		if fetched.is_err() && context.cancel.is_cancelled() {
			return Arc::new(RobotsRules::disallow_all());
		}
		let rules = match fetched {
			Ok(doc) => parse_robots_txt(&doc.text, "research-workspace"),
			// Only an explicit 4xx answer is allow-all; everything else is disallow-all.
			Err(error)
				if error
					.http_error_status()
					.is_some_and(|status| (400..500).contains(&status)) =>
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
				expires: self.clock.now_ms().saturating_add(3_600_000),
			},
			ROBOTS_CACHE_MAX_HOSTS,
		);
		rules
	}
	/// Waits until a request to `host` may start (politeness, C2) and records
	/// the start only at the instant it is sent; false when cancelled first.
	async fn polite_wait(&self, host: &str, cancel: &CancellationToken) -> bool {
		await_slot(
			&self.starts,
			host,
			self.clock.as_ref(),
			self.sleep.as_ref(),
			cancel,
			true,
		)
		.await
	}
}
/// `fetchPage`: fetches `target` after its robots.txt allowed it and its
/// host's slot came; every redirect hop is robots-checked and spaced before it
/// is contacted. Returns the document and the final URL's host.
pub(crate) async fn fetch_page(
	access: &Arc<PageAccess>,
	target: &ValidatedFetchUrl,
	request: &PageRequest<'_>,
	context: &ToolContext,
) -> Result<(FetchedDocument, String), ToolFailure> {
	let (_, path) = host_path(&target.href)
		.ok_or_else(|| tool_failure("UNSAFE_URL", "MALFORMED_URL", false))?;
	let rules = access.robots_for(&target.hostname, context).await;
	if context.cancel.is_cancelled() {
		return Err(aborted());
	}
	if !is_path_allowed(&rules, &path) {
		return Err(disallowed(&target.hostname));
	}
	if !access.polite_wait(&target.hostname, &context.cancel).await {
		return Err(aborted());
	}
	let mut opts = options(
		request.max_bytes,
		request.timeout_ms,
		request.accept,
		context,
	);
	opts.allowed_hosts = request
		.pinned_host
		.map(|host| BTreeSet::from([host.to_owned()]));
	opts.user_agent = Some(PAGE_USER_AGENT.into());
	opts.authorize_redirect = Some(Arc::new(Authorizer {
		access: Arc::clone(access),
		context: context.clone(),
		pinned_host: request.pinned_host.map(normalized_host),
	}));
	let fetched = access
		.fetcher
		.fetch_text(&target.href, &opts)
		.await
		.map_err(|error| fetch_failure(&error))?;
	let (final_host, final_path) = host_path(&fetched.final_url)
		.ok_or_else(|| tool_failure("UNSAFE_URL", "the final URL is malformed", false))?;
	if final_host != target.hostname || final_path != path {
		// Every hop was already robots-checked before it was contacted; this
		// re-check (cached, no fetch) is belt and braces for a fetcher that
		// reports a final URL it was not asked to follow.
		access.starts.note(&final_host, access.clock.now_ms());
		let rules = access.robots_for(&final_host, context).await;
		if context.cancel.is_cancelled() {
			return Err(aborted());
		}
		if !is_path_allowed(&rules, &final_path) {
			return Err(disallowed(&final_host));
		}
	}
	Ok((fetched, final_host))
}
/// `hostOf`'s normalisation: lower case, no trailing dot.
fn normalized_host(host: &str) -> String {
	let host = host.to_lowercase();
	host.strip_suffix('.').unwrap_or(&host).to_owned()
}
struct Authorizer {
	access: Arc<PageAccess>,
	context: ToolContext,
	pinned_host: Option<String>,
}
#[async_trait]
impl RedirectAuthorizer for Authorizer {
	async fn authorize(&self, url: &str) -> bool {
		let Some((host, path)) = host_path(url) else {
			return false;
		};
		// A hop off the pinned host is refused by the fetcher's allowlist
		// (`HOST_NOT_ALLOWED`) before it is contacted: reading that host's
		// robots.txt first would be a request for nothing.
		if self
			.pinned_host
			.as_ref()
			.is_some_and(|pinned| *pinned != host)
		{
			return true;
		}
		let rules = self.access.robots_for(&host, &self.context).await;
		!self.context.cancel.is_cancelled()
			&& is_path_allowed(&rules, &path)
			&& self.access.polite_wait(&host, &self.context.cancel).await
	}
}
struct WebTool {
	deps: WebToolDeps,
	access: Arc<PageAccess>,
	meta: ToolMeta,
}
/// Construct `web.fetch_page` with its own robots cache and spacing.
pub fn create_web_tools(deps: WebToolDeps) -> Vec<Arc<dyn Tool>> {
	let access = Arc::new(PageAccess::new(
		Arc::clone(&deps.fetcher),
		Arc::clone(&deps.clock),
		Arc::clone(&deps.sleep),
	));
	create_web_tools_sharing(deps, access)
}
/// Construct `web.fetch_page` on a [`PageAccess`] shared with `news.fetch_article`.
pub fn create_web_tools_sharing(deps: WebToolDeps, access: Arc<PageAccess>) -> Vec<Arc<dyn Tool>> {
	vec![Arc::new(WebTool {
		deps,
		access,
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
/// The TypeScript `TOOL_THREW <error.name>` path, for a panicking CPU job.
pub(crate) fn threw() -> ToolFailure {
	tool_failure("TOOL_THREW", "Error", false)
}
pub(crate) fn aborted() -> ToolFailure {
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
		let (fetched, final_host) = fetch_page(
			&self.access,
			&target,
			&PageRequest {
				max_bytes: 2_000_000,
				timeout_ms: 15_000,
				accept: PAGE_ACCEPT,
				pinned_host: None,
			},
			&context,
		)
		.await?;
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
			// A parse is sequential CPU work: it runs on the rayon pool through the
			// shared bridge (a panic becomes TOOL_THREW instead of aborting the
			// runner), and the archive write below is never reached after a drop (C3).
			let html = fetched.text;
			let base = fetched.final_url.clone();
			let page = cpu(&context.cancel, move || {
				research_html::html_to_markdown(
					&html,
					&research_html::Options {
						base_url: &base,
						max_chars: MAX_RETRIEVED_TEXT_CHARS,
					},
				)
			})
			.await?;
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
		let page = ArchivedPage {
			source_url: target.href,
			final_url: fetched.final_url.clone(),
			title: title.clone(),
			retrieved_at: retrieved_at.clone(),
			markdown: markdown.clone(),
			omitted: Some(omitted),
		};
		// C3: dropping the save future (cancellation) stops the write before its
		// atomic rename, so a cancelled call leaves no archive file.
		let saved = tokio::select! {
			saved = self.deps.page_archive.save(&page) => saved,
			() = context.cancel.cancelled() => return Err(aborted()),
		};
		let file =
			saved.map_err(|error| tool_failure("ARCHIVE_WRITE_FAILED", &error.detail, false))?;
		let collected = collect_evidence(
			self.deps.hasher.as_ref(),
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
