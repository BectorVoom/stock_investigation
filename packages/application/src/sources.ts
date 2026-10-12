import type {
	Article,
	NewsSource,
	RecommendedSource,
	RegisterSourceRequest,
	SourcePreview,
	UpdateSourceRequest,
} from "@research/contracts";
import {
	canonicalizeArticleUrl,
	normalizeFeed,
	ok,
	type RawFeed,
	validateFetchUrl,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import { FEED_LIMITS } from "./ingest.ts";
import type {
	ArticleRepository,
	AuditLog,
	Clock,
	FeedParser,
	IdGenerator,
	RateLimiter,
	SafeFetchError,
	SafeFetcher,
	SourceRepository,
} from "./ports.ts";

/** Previews run inside the Worker's CPU budget, so they read far less than a full ingest. */
const PREVIEW_MAX_BYTES = 300_000;
const PREVIEW_SAMPLE_SIZE = 5;
const SOURCE_FETCHES_PER_HOUR = 40;
const MAX_SOURCES = 100;
const HOUR_MS = 3_600_000;

export interface SourceServiceDeps {
	readonly sources: SourceRepository;
	readonly articles: ArticleRepository;
	readonly fetcher: SafeFetcher;
	readonly feedParser: FeedParser;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
	readonly recommended: readonly RecommendedSource[];
}

const FEED_LINK_TYPES = ["application/rss+xml", "application/atom+xml"];

/**
 * Finds `<link rel="alternate" type="application/rss+xml|atom+xml" href>` feed
 * advertisements in an HTML page. Returned URLs are untrusted and must pass
 * the URL policy before being fetched.
 */
export function discoverFeedLinks(html: string, pageUrl: string): readonly string[] {
	const found: string[] = [];
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		const attribute = (name: string): string | null => {
			const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
			return match?.[1] ?? match?.[2] ?? null;
		};
		const rel = attribute("rel")?.toLowerCase() ?? "";
		const type = attribute("type")?.toLowerCase() ?? "";
		const href = attribute("href");
		if (!rel.split(/\s+/).includes("alternate") || !FEED_LINK_TYPES.includes(type)) continue;
		if (href === null || !URL.canParse(href, pageUrl)) continue;
		found.push(new URL(href, pageUrl).href);
	}
	return [...new Set(found)];
}

function fetchFailure(error: SafeFetchError): UseCaseResult<never> {
	const unsafe =
		error.code === "UNSAFE_URL" ||
		error.code === "UNSAFE_REDIRECT" ||
		error.code === "HOST_NOT_ALLOWED";
	return unsafe
		? fail("UNSAFE_URL", "The URL or one of its redirects is not allowed.", error.code)
		: fail("FETCH_FAILED", "The source could not be retrieved.", error.code);
}

interface InspectedFeed {
	readonly canonicalUrl: string;
	readonly feed: RawFeed;
}

export function createSourceService(deps: SourceServiceDeps) {
	const fetchOptions = {
		maxBytes: PREVIEW_MAX_BYTES,
		timeoutMs: FEED_LIMITS.timeoutMs,
		accept: `${FEED_LIMITS.accept}, text/html;q=0.5`,
	};

	/** Fetches `url` as a feed, following one level of HTML feed auto-discovery. */
	async function inspect(ownerId: string, rawUrl: string): Promise<UseCaseResult<InspectedFeed>> {
		const validated = validateFetchUrl(rawUrl.trim());
		if (!validated.ok) return fail("UNSAFE_URL", "This URL is not allowed.", validated.error);
		const allowed = await deps.rateLimiter.consume({
			ownerId,
			bucket: "source-fetch",
			limit: SOURCE_FETCHES_PER_HOUR,
			windowMs: HOUR_MS,
			nowMs: deps.clock.nowMs(),
		});
		if (!allowed) return fail("RATE_LIMITED", "Too many source checks; try again later.");

		const first = await deps.fetcher.fetchText(validated.value.href, fetchOptions);
		if (!first.ok) return fetchFailure(first.error);
		let document = first.value;
		let parsed = deps.feedParser.parse(document.text);
		if (!parsed.ok) {
			const [advertised] = discoverFeedLinks(document.text, document.finalUrl);
			if (advertised === undefined) {
				return fail("NOT_A_FEED", "No RSS or Atom feed was found at this URL.");
			}
			const second = await deps.fetcher.fetchText(advertised, fetchOptions);
			if (!second.ok) return fetchFailure(second.error);
			document = second.value;
			parsed = deps.feedParser.parse(document.text);
			if (!parsed.ok) return fail("NOT_A_FEED", "The advertised feed could not be parsed.");
		}
		const canonical = canonicalizeArticleUrl(document.finalUrl);
		if (!canonical.ok) return fail("UNSAFE_URL", "The feed URL is not allowed.", canonical.error);
		return ok({ canonicalUrl: canonical.value, feed: parsed.value });
	}

	function suggestedPublisher(inspected: InspectedFeed): string {
		const title = inspected.feed.title?.trim() ?? "";
		return (title === "" ? new URL(inspected.canonicalUrl).hostname : title).slice(0, 300);
	}

	return {
		async preview(ownerId: string, rawUrl: string): Promise<UseCaseResult<SourcePreview>> {
			const inspected = await inspect(ownerId, rawUrl);
			if (!inspected.ok) return inspected;
			const publisher = suggestedPublisher(inspected.value);
			const normalized = normalizeFeed(inspected.value.feed, {
				publisher,
				retrievedAt: deps.clock.nowIso(),
				licensePolicy: "headline-and-link-only",
				maxItems: FEED_LIMITS.maxItems,
			});
			const siteLink = inspected.value.feed.siteLink;
			const safeSiteLink = siteLink === null ? null : validateFetchUrl(siteLink);
			const existing = await deps.sources.findByCanonicalUrl(ownerId, inspected.value.canonicalUrl);
			return ok({
				canonicalUrl: inspected.value.canonicalUrl,
				sourceType: inspected.value.feed.kind,
				title: publisher,
				siteLink: safeSiteLink?.ok === true ? safeSiteLink.value.href : null,
				suggestedPublisher: publisher,
				itemCount: normalized.articles.length,
				rejectedItemCount: normalized.rejected.length,
				sampleItems: normalized.articles.slice(0, PREVIEW_SAMPLE_SIZE).map((article) => ({
					title: article.title,
					canonicalUrl: article.canonicalUrl,
					publishedAt: article.publishedAt,
				})),
				alreadySubscribed: existing !== null,
			});
		},

		/** Re-validates the feed server-side; a client-side preview is never trusted. */
		async register(
			ownerId: string,
			request: RegisterSourceRequest,
		): Promise<UseCaseResult<NewsSource>> {
			const existingSources = await deps.sources.list(ownerId);
			if (existingSources.length >= MAX_SOURCES) {
				return fail("CONFLICT", `At most ${MAX_SOURCES} sources can be registered.`);
			}
			const inspected = await inspect(ownerId, request.url);
			if (!inspected.ok) return inspected;
			const now = deps.clock.nowIso();
			const publisher = request.publisher ?? suggestedPublisher(inspected.value);
			const source: NewsSource = {
				sourceId: deps.ids.newId("src"),
				canonicalUrl: inspected.value.canonicalUrl,
				sourceType: inspected.value.feed.kind,
				title: request.title ?? publisher,
				publisher,
				licensePolicy: request.licensePolicy,
				trustClassification: request.trustClassification,
				feedStatus: "active",
				lastFetchedAt: null,
				lastErrorCode: null,
				createdAt: now,
				updatedAt: now,
			};
			const inserted = await deps.sources.insert(ownerId, source);
			if (!inserted) return fail("DUPLICATE_SOURCE", "This source is already registered.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "source.register",
				resource: source.sourceId,
				detail: new URL(source.canonicalUrl).hostname,
				at: now,
			});
			return ok(source);
		},

		async update(
			ownerId: string,
			sourceId: string,
			patch: UpdateSourceRequest,
		): Promise<UseCaseResult<NewsSource>> {
			const now = deps.clock.nowIso();
			const updated = await deps.sources.update(ownerId, sourceId, patch, now);
			if (updated === null) return fail("NOT_FOUND", "Source not found.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "source.update",
				resource: sourceId,
				detail: Object.keys(patch).join(","),
				at: now,
			});
			return ok(updated);
		},

		async remove(ownerId: string, sourceId: string): Promise<UseCaseResult<void>> {
			const deleted = await deps.sources.delete(ownerId, sourceId);
			if (!deleted) return fail("NOT_FOUND", "Source not found.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "source.remove",
				resource: sourceId,
				detail: "",
				at: deps.clock.nowIso(),
			});
			return ok(undefined);
		},

		list: (ownerId: string): Promise<readonly NewsSource[]> => deps.sources.list(ownerId),

		/** The curated catalog is advisory: nothing in it is subscribed until the owner registers it. */
		listRecommended: (): readonly RecommendedSource[] => deps.recommended,

		listArticles(
			ownerId: string,
			query: { readonly sourceId: string | null; readonly cursor: string | null },
		): Promise<{ readonly articles: readonly Article[]; readonly nextCursor: string | null }> {
			return deps.articles.list(ownerId, { ...query, limit: 50 });
		},
	};
}

export type SourceService = ReturnType<typeof createSourceService>;
