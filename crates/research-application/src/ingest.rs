//! Sequential feed retrieval with ordered results. Parsing, normalization and
//! hashing run on rayon while the next source's network request is in flight.
use crate::ports::{Clock, FeedParser, FetchedDocument, Hasher, SafeFetchOptions, SafeFetcher};
use rayon::prelude::*;
use research_contracts::{
	Tri,
	jobs::{SourceFetchReport, SubscribedSourceRef},
	records::IngestedArticle,
};
use research_domain::news::feed::{NormalizeFeedOptions, normalize_feed};
use std::{
	collections::{BTreeSet, HashSet},
	sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// Maximum feed body bytes.
pub const FEED_MAX_BYTES: usize = 1_000_000;
/// Maximum feed request duration.
pub const FEED_TIMEOUT_MS: u64 = 15_000;
/// Maximum normalized entries per source.
pub const FEED_MAX_ITEMS: usize = 100;
/// Feed content negotiation header.
pub const FEED_ACCEPT: &str =
	"application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8";

/// Ingest environment ports.
#[derive(Clone)]
pub struct IngestDeps {
	/// SSRF-defended text transport.
	pub fetcher: Arc<dyn SafeFetcher>,
	/// RSS/Atom parser.
	pub feed_parser: Arc<dyn FeedParser>,
	/// SHA-256 implementation.
	pub hasher: Arc<dyn Hasher>,
	/// Timestamp source.
	pub clock: Arc<dyn Clock>,
}
/// Run cancellation and output ceiling.
pub struct IngestOptions {
	/// Owner/lease cancellation.
	pub cancel: CancellationToken,
	/// Stop adding articles at this count; still fetch/report remaining sources.
	pub max_articles: usize,
}
/// Normalized articles and rejection count for one feed.
#[derive(Debug, Clone)]
pub struct SourceArticles {
	/// Articles in feed order.
	pub articles: Vec<IngestedArticle>,
	/// Malformed/unsafe entries rejected by normalization.
	pub rejected_item_count: usize,
}
/// Expected transport/parser failure of one source: the fetch failure as is
/// (with its status), or "not a feed".
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {detail}")]
pub struct FeedFetchError {
	/// Safe fetch code or NOT_A_FEED.
	pub code: String,
	/// Log-safe diagnostic.
	pub detail: String,
	/// The feed host's answer status, unchanged; `None` for NOT_A_FEED and
	/// for a fetch nothing answered (docs/rule/error_handling.md §4a).
	pub status: Option<u16>,
}

/// The feed host's answer status behind a feed failure, unchanged; `None`
/// when it did not answer (`feedUpstreamStatus`, §4a).
#[must_use]
pub const fn feed_upstream_status(error: &FeedFetchError) -> Option<u16> {
	error.status
}
/// Exceptional errors which escape TypeScript ingest to the job boundary.
#[derive(Debug, thiserror::Error)]
pub enum IngestError {
	/// Faithfully preserves new URL(storedUrl)'s throw (JS TypeError).
	#[error("invalid stored feed URL (TypeError): {0}")]
	InvalidStoredUrl(url::ParseError),
	/// The CPU task panicked or was lost before returning.
	#[error("feed CPU worker did not return a result")]
	CpuWorker,
}

impl IngestError {
	/// The name the TypeScript runner's `RUNNER_ERROR_<name>` failure code would
	/// carry for this error: `TypeError` for a stored URL `new URL` rejects (the
	/// job fails retryable), `Panic` for a lost CPU job (ADR-0030 error-name map).
	#[must_use]
	pub const fn js_error_name(&self) -> &'static str {
		match self {
			Self::InvalidStoredUrl(_) => "TypeError",
			Self::CpuWorker => "Panic",
		}
	}
}
/// News-ingest completion (deduplication across sources is first wins).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestOutcome {
	/// Unique articles, ordered by first occurrence.
	pub articles: Vec<IngestedArticle>,
	/// One report for every source fetched, including failures.
	pub source_reports: Vec<SourceFetchReport>,
}

async fn fetch_document(
	source: &SubscribedSourceRef,
	deps: &IngestDeps,
	cancel: Option<CancellationToken>,
) -> Result<Result<FetchedDocument, FeedFetchError>, IngestError> {
	let url = url::Url::parse(&source.canonical_url).map_err(IngestError::InvalidStoredUrl)?;
	let host = url.host_str().unwrap_or_default().to_owned();
	let options = SafeFetchOptions {
		max_bytes: FEED_MAX_BYTES,
		timeout_ms: FEED_TIMEOUT_MS,
		accept: FEED_ACCEPT.to_owned(),
		cancel,
		allowed_hosts: Some(BTreeSet::from([host])),
		authorize_redirect: None,
		user_agent: None,
		authorization: None,
		finnhub_token: None,
		include_error_body: false,
		json_body: None,
	};
	Ok(deps
		.fetcher
		.fetch_text(&source.canonical_url, &options)
		.await
		.map_err(|e| FeedFetchError {
			code: e.code.as_str().to_owned(),
			detail: e.detail,
			status: e.status,
		}))
}

type Processed = (Result<SourceArticles, FeedFetchError>, SourceFetchReport);
/// A source's CPU job, already running while the next fetch is in flight.
type Pending = tokio::task::JoinHandle<Result<Processed, research_effects::cpu::CpuPanic>>;

/// Starts parsing, normalizing and hashing on the rayon pool (a panic there is
/// reported, never an abort). The task starts at once, so the work overlaps the
/// next source's network request (ADR-0030 decision 5).
fn process(
	source: SubscribedSourceRef,
	deps: IngestDeps,
	fetched: Result<FetchedDocument, FeedFetchError>,
) -> Pending {
	tokio::spawn(research_effects::cpu::run_cpu(move || {
		let result = fetched.and_then(|document| {
			let feed = deps
				.feed_parser
				.parse(&document.text)
				.map_err(|_| FeedFetchError {
					code: "NOT_A_FEED".to_owned(),
					detail: "response is not an RSS or Atom feed".to_owned(),
					status: None,
				})?;
			let now = deps.clock.now_iso();
			let normalized = normalize_feed(
				&feed,
				&NormalizeFeedOptions {
					publisher: &source.publisher,
					retrieved_at: &now,
					license_policy: source.license_policy,
					max_items: FEED_MAX_ITEMS,
				},
			);
			let articles = normalized
				.articles
				.into_par_iter()
				.map(|v| IngestedArticle {
					source_id: source.source_id.clone(),
					canonical_url: v.canonical_url,
					publisher: v.publisher,
					title: v.title,
					published_at: v.published_at,
					retrieved_at: v.retrieved_at,
					content_fingerprint: deps.hasher.sha256_hex(&v.fingerprint_material),
					excerpt: v.excerpt,
				})
				.collect();
			Ok(SourceArticles {
				articles,
				rejected_item_count: normalized.rejected.len(),
			})
		});
		let report = SourceFetchReport {
			source_id: source.source_id,
			fetched_at: deps.clock.now_iso(),
			error_code: result.as_ref().err().map(|e| e.code.clone()),
			// RECORDED (ported as-is): the TypeScript `ingestSources` reports
			// only the code, so the report carries no `upstreamStatus` key
			// (the contract and `feed_upstream_status` are ready for it).
			upstream_status: Tri::Absent,
		};
		(result, report)
	}))
}

/// Waits for a source's CPU job.
async fn finish(pending: Pending) -> Result<Processed, IngestError> {
	pending
		.await
		.map_err(|_| IngestError::CpuWorker)?
		.map_err(|_| IngestError::CpuWorker)
}

/// Fetches one source, retaining the registered-host redirect allowlist.
/// Invalid stored URLs remain exceptional (TypeError in the TS runner).
pub async fn fetch_source_articles(
	source: &SubscribedSourceRef,
	deps: &IngestDeps,
	cancel: Option<CancellationToken>,
) -> Result<Result<SourceArticles, FeedFetchError>, IngestError> {
	let fetched = fetch_document(source, deps, cancel).await?;
	let (result, _) = finish(process(source.clone(), deps.clone(), fetched)).await?;
	Ok(result)
}

fn collect_result(
	out: &mut IngestOutcome,
	seen: &mut HashSet<String>,
	limit: usize,
	result: Processed,
) {
	let (result, report) = result;
	out.source_reports.push(report);
	if let Ok(source) = result {
		for article in source.articles {
			if out.articles.len() >= limit {
				break;
			}
			if seen.insert(article.canonical_url.clone()) {
				out.articles.push(article);
			}
		}
	}
}

/// Fetches at most one feed at a time, overlaps pure CPU work with the next
/// fetch, and folds all results in subscription order (FR-003).
pub async fn ingest_sources(
	sources: &[SubscribedSourceRef],
	deps: &IngestDeps,
	options: IngestOptions,
) -> Result<IngestOutcome, IngestError> {
	let mut out = IngestOutcome {
		articles: vec![],
		source_reports: vec![],
	};
	let mut seen = HashSet::new();
	let mut pending: Option<Pending> = None;
	for source in sources {
		if options.cancel.is_cancelled() {
			break;
		}
		let fetch = fetch_document(source, deps, Some(options.cancel.clone()));
		let fetched = if let Some(previous) = pending.take() {
			let (fetched, previous) = tokio::join!(fetch, finish(previous));
			collect_result(&mut out, &mut seen, options.max_articles, previous?);
			fetched?
		} else {
			fetch.await?
		};
		pending = Some(process(source.clone(), deps.clone(), fetched));
	}
	if let Some(last) = pending {
		collect_result(
			&mut out,
			&mut seen,
			options.max_articles,
			finish(last).await?,
		);
	}
	Ok(out)
}

#[cfg(test)]
#[path = "ingest/tests.rs"]
mod tests;
