import type { IngestedArticle, SubscribedSourceRef } from "@research/contracts";
import { err, normalizeFeed, ok, type RawFeed, type Result } from "@research/domain";
import type { Clock, FeedParser, Hasher, SafeFetchErrorCode, SafeFetcher } from "./ports.ts";

/** Resource ceilings for feed retrieval (section 5.6). */
export const FEED_LIMITS = {
	maxBytes: 1_000_000,
	timeoutMs: 15_000,
	maxItems: 100,
	accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
} as const;

export type FeedFetchErrorCode = SafeFetchErrorCode | "NOT_A_FEED";

export interface FeedFetchDeps {
	readonly fetcher: SafeFetcher;
	readonly feedParser: FeedParser;
}

export interface FetchedFeed {
	readonly finalUrl: string;
	readonly feed: RawFeed;
}

/** Fetches and parses one feed. The request is pinned to the feed's own host. */
export async function fetchFeed(
	url: string,
	deps: FeedFetchDeps,
	options: {
		readonly maxBytes: number;
		readonly signal?: AbortSignal;
		readonly allowedHosts?: ReadonlySet<string>;
	},
): Promise<Result<FetchedFeed, { code: FeedFetchErrorCode; detail: string }>> {
	const fetched = await deps.fetcher.fetchText(url, {
		maxBytes: options.maxBytes,
		timeoutMs: FEED_LIMITS.timeoutMs,
		accept: FEED_LIMITS.accept,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
	});
	if (!fetched.ok) return fetched;
	const parsed = deps.feedParser.parse(fetched.value.text);
	if (!parsed.ok) return err({ code: parsed.error, detail: "response is not an RSS or Atom feed" });
	return ok({ finalUrl: fetched.value.finalUrl, feed: parsed.value });
}

export interface SourceArticles {
	readonly articles: readonly IngestedArticle[];
	readonly rejectedItemCount: number;
}

/**
 * Retrieves a subscribed source and normalizes its items into article records
 * with content fingerprints. Deduplication against stored articles happens at
 * persistence time through uniqueness constraints (FR-003).
 */
export async function fetchSourceArticles(
	source: SubscribedSourceRef,
	deps: FeedFetchDeps & { readonly hasher: Hasher; readonly clock: Clock },
	signal?: AbortSignal,
): Promise<Result<SourceArticles, { code: FeedFetchErrorCode; detail: string }>> {
	// A subscribed feed is fetched from its registered host only; a redirect elsewhere is refused.
	const fetched = await fetchFeed(source.canonicalUrl, deps, {
		maxBytes: FEED_LIMITS.maxBytes,
		allowedHosts: new Set([new URL(source.canonicalUrl).hostname]),
		...(signal === undefined ? {} : { signal }),
	});
	if (!fetched.ok) return fetched;
	const normalized = normalizeFeed(fetched.value.feed, {
		publisher: source.publisher,
		retrievedAt: deps.clock.nowIso(),
		licensePolicy: source.licensePolicy,
		maxItems: FEED_LIMITS.maxItems,
	});
	const articles = await Promise.all(
		normalized.articles.map(async (candidate) => ({
			sourceId: source.sourceId,
			canonicalUrl: candidate.canonicalUrl,
			publisher: candidate.publisher,
			title: candidate.title,
			publishedAt: candidate.publishedAt,
			retrievedAt: candidate.retrievedAt,
			contentFingerprint: await deps.hasher.sha256Hex(candidate.fingerprintMaterial),
			excerpt: candidate.excerpt,
		})),
	);
	return ok({ articles, rejectedItemCount: normalized.rejected.length });
}

export interface IngestOutcome {
	readonly articles: readonly IngestedArticle[];
	readonly sourceReports: readonly {
		readonly sourceId: string;
		readonly fetchedAt: string;
		readonly errorCode: string | null;
	}[];
}

/**
 * Retrieves every given source sequentially (bounded parallelism of one keeps
 * the runner polite to publishers). One failing feed is reported per source and
 * never aborts the others.
 */
export async function ingestSources(
	sources: readonly SubscribedSourceRef[],
	deps: FeedFetchDeps & { readonly hasher: Hasher; readonly clock: Clock },
	options: { readonly signal: AbortSignal; readonly maxArticles: number },
): Promise<IngestOutcome> {
	const byUrl = new Map<string, IngestedArticle>();
	const sourceReports: IngestOutcome["sourceReports"][number][] = [];
	for (const source of sources) {
		if (options.signal.aborted) break;
		const fetched = await fetchSourceArticles(source, deps, options.signal);
		sourceReports.push({
			sourceId: source.sourceId,
			fetchedAt: deps.clock.nowIso(),
			errorCode: fetched.ok ? null : fetched.error.code,
		});
		if (!fetched.ok) continue;
		for (const article of fetched.value.articles) {
			if (byUrl.size >= options.maxArticles) break;
			if (!byUrl.has(article.canonicalUrl)) byUrl.set(article.canonicalUrl, article);
		}
	}
	return { articles: [...byUrl.values()], sourceReports };
}
