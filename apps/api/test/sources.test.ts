import type { SafeFetchError } from "@research/application";
import {
	articleListResponseSchema,
	completeJobResponseSchema,
	newsSourceSchema,
	recommendedSourcesResponseSchema,
	researchRunResponseSchema,
	sourceListResponseSchema,
	sourcePreviewSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	apiError,
	body,
	bundleFor,
	claim,
	completion,
	createHarness,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	stateEvents,
	TO_PUBLISHING,
	USAGE,
} from "./helpers.ts";

const FEED_URL = "https://news.example.org/feed.xml";
const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
	<title>Example News</title>
	<link>https://news.example.org/</link>
	<item><title>Battery orders rise</title><link>https://news.example.org/a/1?utm_source=rss</link><pubDate>Thu, 01 Oct 2026 09:00:00 GMT</pubDate><description>Orders &lt;b&gt;rose&lt;/b&gt;.</description></item>
	<item><title>Chip fab opens</title><link>https://news.example.org/a/2</link><pubDate>Fri, 02 Oct 2026 09:00:00 GMT</pubDate></item>
	<item><title>Bad link</title><link>http://10.0.0.5/internal</link></item>
</channel></rss>`;

const HOMEPAGE_URL = "https://news.example.org/";
const HOMEPAGE = `<!doctype html><html><head><title>Example</title>
<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>news</body></html>`;

const REGISTRATION = {
	url: FEED_URL,
	licensePolicy: "headline-and-link-only",
	trustClassification: "established-media",
};

describe("source preview and registration (FR-001)", () => {
	it("previews feed metadata without subscribing", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const preview = await body(
			await harness.call("POST", "/sources/preview", { url: FEED_URL }),
			sourcePreviewSchema,
		);
		expect(preview).toMatchObject({
			canonicalUrl: FEED_URL,
			sourceType: "rss",
			suggestedPublisher: "Example News",
			itemCount: 2,
			rejectedItemCount: 1,
			alreadySubscribed: false,
		});
		// Tracking parameters are stripped from the canonical article URL.
		expect(preview.sampleItems.map((item) => item.canonicalUrl)).toEqual([
			"https://news.example.org/a/1",
			"https://news.example.org/a/2",
		]);
		expect(preview.sampleItems[0]?.publishedAt).toBe("2026-10-01T09:00:00.000Z");

		const sources = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(sources.sources).toHaveLength(0);
	});

	it("follows one level of HTML feed auto-discovery", async () => {
		const harness = createHarness({
			documents: { [HOMEPAGE_URL]: HOMEPAGE, [FEED_URL]: FEED },
		});
		const preview = await body(
			await harness.call("POST", "/sources/preview", { url: HOMEPAGE_URL }),
			sourcePreviewSchema,
		);
		expect(preview.canonicalUrl).toBe(FEED_URL);
		expect(harness.fetchCalls.map((call) => call.url)).toEqual([HOMEPAGE_URL, FEED_URL]);
	});

	it.each([
		["http://news.example.org/feed.xml", "SCHEME_NOT_ALLOWED"],
		["https://user:pass@news.example.org/feed.xml", "CREDENTIALS_NOT_ALLOWED"],
		["https://news.example.org:8443/feed.xml", "PORT_NOT_ALLOWED"],
		["https://127.0.0.1/feed.xml", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::1]/feed.xml", "IP_LITERAL_NOT_ALLOWED"],
		["https://169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
		["https://2130706433/feed.xml", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/feed.xml", "HOSTNAME_NOT_ALLOWED"],
		["https://router.local/feed.xml", "HOSTNAME_NOT_ALLOWED"],
		["https://intranet/feed.xml", "HOSTNAME_NOT_ALLOWED"],
		["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
		["javascript:alert(1)", "SCHEME_NOT_ALLOWED"],
		["not a url", "MALFORMED_URL"],
	])("rejects the unsafe target %s before any fetch", async (url, detail) => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		for (const path of ["/sources/preview", "/sources"]) {
			const response = await harness.call(
				"POST",
				path,
				path === "/sources" ? { ...REGISTRATION, url } : { url },
			);
			expect(response.status).toBe(422);
			const error = await apiError(response);
			expect(error.code).toBe("UNSAFE_URL");
			expect(error.detail).toBe(detail);
		}
		expect(harness.fetchCalls).toHaveLength(0);
	});

	it("reports a non-feed document and a failed fetch with stable codes", async () => {
		const harness = createHarness({
			documents: { "https://news.example.org/page": "<html><body>no feed here</body></html>" },
		});
		const notFeed = await harness.call("POST", "/sources/preview", {
			url: "https://news.example.org/page",
		});
		expect(notFeed.status).toBe(422);
		expect(await errorCode(notFeed)).toBe("NOT_A_FEED");

		const unreachable = await harness.call("POST", "/sources/preview", {
			url: "https://unreachable.example.org/feed.xml",
		});
		expect(unreachable.status).toBe(502);
		const error = await apiError(unreachable);
		expect(error).toMatchObject({ code: "FETCH_FAILED", detail: "NETWORK_ERROR" });
	});

	// docs/rule/error_handling.md §4a: the feed host's own status is answered
	// unchanged; a status that cannot be an error status line (a 3xx) or no
	// answer at all keeps FETCH_FAILED's own 502.
	it("answers a feed host's error status unchanged, with it in the body (§4a)", async () => {
		const host = "https://status.example.org";
		const answered = (status: number): SafeFetchError => ({
			code: "HTTP_ERROR",
			detail: `HTTP ${status}`,
			status,
		});
		const harness = createHarness({
			documents: {
				[`${host}/404.xml`]: answered(404),
				[`${host}/418.xml`]: answered(418),
				[`${host}/503.xml`]: answered(503),
				// Not in Hono's list of registered codes; passed through all the same.
				[`${host}/529.xml`]: answered(529),
				[`${host}/302.xml`]: {
					code: "HTTP_ERROR",
					detail: "HTTP 302 without a Location header",
					status: 302,
				},
				[`${host}/slow.xml`]: { code: "TIMEOUT", detail: "no answer within the limit" },
			},
		});
		const cases = [
			{ path: "404.xml", status: 404, upstreamStatus: 404, detail: "HTTP_ERROR" },
			{ path: "418.xml", status: 418, upstreamStatus: 418, detail: "HTTP_ERROR" },
			{ path: "503.xml", status: 503, upstreamStatus: 503, detail: "HTTP_ERROR" },
			{ path: "529.xml", status: 529, upstreamStatus: 529, detail: "HTTP_ERROR" },
			{ path: "302.xml", status: 502, upstreamStatus: 302, detail: "HTTP_ERROR" },
			{ path: "slow.xml", status: 502, upstreamStatus: undefined, detail: "TIMEOUT" },
		];
		for (const expected of cases) {
			for (const route of ["/sources/preview", "/sources"]) {
				const url = `${host}/${expected.path}`;
				const response = await harness.call(
					"POST",
					route,
					route === "/sources" ? { ...REGISTRATION, url } : { url },
				);
				expect(response.status, `${route} ${expected.path}`).toBe(expected.status);
				expect(response.headers.get("Content-Type")).toContain("application/json");
				const error = await apiError(response);
				expect(error.code).toBe("FETCH_FAILED");
				expect(error.detail).toBe(expected.detail);
				expect(error.upstreamStatus).toBe(expected.upstreamStatus);
			}
		}
		// Nothing was stored for a source whose host refused it.
		const listed = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(listed.sources).toEqual([]);
	});

	it("registers, updates and removes a source, rejecting duplicates", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const created = await harness.call("POST", "/sources", REGISTRATION);
		expect(created.status).toBe(201);
		const source = await body(created, newsSourceSchema);
		expect(source).toMatchObject({
			canonicalUrl: FEED_URL,
			publisher: "Example News",
			feedStatus: "active",
			licensePolicy: "headline-and-link-only",
			lastFetchedAt: null,
		});

		// The same feed reached through a tracking-parameter variant is still a duplicate.
		const duplicate = await harness.call("POST", "/sources", REGISTRATION);
		expect(duplicate.status).toBe(409);
		expect(await errorCode(duplicate)).toBe("DUPLICATE_SOURCE");

		const preview = await body(
			await harness.call("POST", "/sources/preview", { url: FEED_URL }),
			sourcePreviewSchema,
		);
		expect(preview.alreadySubscribed).toBe(true);

		const paused = await body(
			await harness.call("PATCH", `/sources/${source.sourceId}`, {
				feedStatus: "paused",
				title: "Renamed",
			}),
			newsSourceSchema,
		);
		expect(paused).toMatchObject({ feedStatus: "paused", title: "Renamed" });
		expect((await harness.call("PATCH", `/sources/${source.sourceId}`, {})).status).toBe(400);
		expect(
			(
				await harness.call("PATCH", `/sources/${source.sourceId}`, {
					canonicalUrl: "https://x.example/",
				})
			).status,
		).toBe(400);

		expect((await harness.call("DELETE", `/sources/${source.sourceId}`)).status).toBe(204);
		expect((await harness.call("DELETE", `/sources/${source.sourceId}`)).status).toBe(404);
		const sources = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(sources.sources).toHaveLength(0);
	});

	it("rate-limits source checks per owner", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		let limited = 0;
		for (let index = 0; index < 45; index += 1) {
			const response = await harness.call("POST", "/sources/preview", { url: FEED_URL });
			if (response.status === 429) limited += 1;
		}
		expect(limited).toBe(5);
		// A new window restores the allowance.
		harness.time.advance(3_600_000);
		expect((await harness.call("POST", "/sources/preview", { url: FEED_URL })).status).toBe(200);
	});
});

describe("recommended catalog (FR-002)", () => {
	it("lists curated entries without subscribing the owner to any of them", async () => {
		const harness = createHarness();
		const catalog = await body(
			await harness.call("GET", "/sources/recommended"),
			recommendedSourcesResponseSchema,
		);
		expect(catalog.entries.length).toBeGreaterThan(5);
		expect(new Set(catalog.entries.map((entry) => entry.catalogId)).size).toBe(
			catalog.entries.length,
		);
		expect(new Set(catalog.entries.map((entry) => entry.feedUrl)).size).toBe(
			catalog.entries.length,
		);
		const sources = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(sources.sources).toHaveLength(0);
		expect(harness.fetchCalls).toHaveLength(0);
	});
});

describe("news ingestion and deduplication (FR-003)", () => {
	const article = (path: string, fingerprintDigit: string, title: string) => ({
		sourceId: "placeholder",
		canonicalUrl: `https://news.example.org${path}`,
		publisher: "Example News",
		title,
		publishedAt: "2026-10-01T09:00:00.000Z",
		retrievedAt: "2026-10-11T00:00:00.000Z",
		contentFingerprint: fingerprintDigit.repeat(64),
		excerpt: null,
	});

	async function ingest(
		harness: ReturnType<typeof createHarness>,
		token: string,
		articles: ReturnType<typeof article>[],
		sourceId: string,
		errorCodeForSource: string | null = null,
		upstreamStatusForSource: number | null = null,
	) {
		const queued = await body(
			await harness.call("POST", "/sources/refresh", undefined, idempotencyKey()),
			researchRunResponseSchema,
		);
		expect(queued.run.kind).toBe("news-ingest");
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected to claim the ingest job");
		expect(lease.kind).toBe("news-ingest");
		expect(lease.sources.map((source) => source.sourceId)).toEqual([sourceId]);
		await harness.runner(
			token,
			`/jobs/${lease.runId}/events`,
			stateEvents(harness, lease, TO_PUBLISHING),
		);
		const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "ingested",
			leaseGeneration: lease.leaseGeneration,
			usage: { ...USAGE, agentSteps: 0, hasUnmeteredUsage: false },
			articles: articles.map((item) => ({ ...item, sourceId })),
			sourceReports: [
				{
					sourceId,
					fetchedAt: harness.time.clock.nowIso(),
					errorCode: errorCodeForSource,
					upstreamStatus: upstreamStatusForSource,
				},
			],
		});
		return body(response, completeJobResponseSchema);
	}

	it("stores each canonical article once across repeated ingestion", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const source = await body(
			await harness.call("POST", "/sources", REGISTRATION),
			newsSourceSchema,
		);
		const token = await issueRunnerToken(harness);

		const first = await ingest(
			harness,
			token,
			[article("/a/1", "1", "Battery orders rise"), article("/a/2", "2", "Chip fab opens")],
			source.sourceId,
		);
		expect(first).toMatchObject({ state: "completed", newArticleCount: 2 });

		// Second run: one repeat, one new item, and the first story syndicated under a new URL.
		const second = await ingest(
			harness,
			token,
			[
				article("/a/1", "1", "Battery orders rise"),
				article("/a/3", "3", "New mine approved"),
				article("/syndicated/battery-orders", "1", "Battery orders rise"),
			],
			source.sourceId,
		);
		expect(second.newArticleCount).toBe(1);

		const page = await body(await harness.call("GET", "/articles"), articleListResponseSchema);
		expect(page.articles.map((item) => item.canonicalUrl).sort()).toEqual([
			"https://news.example.org/a/1",
			"https://news.example.org/a/2",
			"https://news.example.org/a/3",
		]);
		expect(page.nextCursor).toBeNull();

		const refreshed = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(refreshed.sources[0]).toMatchObject({ feedStatus: "active", lastErrorCode: null });
		expect(refreshed.sources[0]?.lastFetchedAt).not.toBeNull();
	});

	it("marks a source as failing when the runner reports a fetch error, and skips paused sources", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const source = await body(
			await harness.call("POST", "/sources", REGISTRATION),
			newsSourceSchema,
		);
		const token = await issueRunnerToken(harness);
		await ingest(harness, token, [], source.sourceId, "TIMEOUT");
		const failing = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(failing.sources[0]).toMatchObject({ feedStatus: "failing", lastErrorCode: "TIMEOUT" });

		await harness.call("PATCH", `/sources/${source.sourceId}`, { feedStatus: "paused" });
		await harness.call("POST", "/sources/refresh", undefined, idempotencyKey());
		const lease = await claim(harness, token);
		expect(lease?.sources).toEqual([]);
	});

	it("stores the feed host's status beside a source's error code, and a later success clears both (§4a)", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const source = await body(
			await harness.call("POST", "/sources", REGISTRATION),
			newsSourceSchema,
		);
		expect(source.lastErrorUpstreamStatus).toBeNull();
		const token = await issueRunnerToken(harness);
		await ingest(harness, token, [], source.sourceId, "HTTP_ERROR", 410);
		const failing = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(failing.sources[0]).toMatchObject({
			feedStatus: "failing",
			lastErrorCode: "HTTP_ERROR",
			lastErrorUpstreamStatus: 410,
		});

		await ingest(harness, token, [], source.sourceId, "TIMEOUT");
		const noAnswer = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(noAnswer.sources[0]).toMatchObject({
			lastErrorCode: "TIMEOUT",
			lastErrorUpstreamStatus: null,
		});

		await ingest(harness, token, [], source.sourceId, "HTTP_ERROR", 503);
		await ingest(harness, token, [], source.sourceId);
		const recovered = await body(await harness.call("GET", "/sources"), sourceListResponseSchema);
		expect(recovered.sources[0]).toMatchObject({
			feedStatus: "active",
			lastErrorCode: null,
			lastErrorUpstreamStatus: null,
		});
	});

	it("does not accept a research outcome for an ingest job", async () => {
		const harness = createHarness({ documents: { [FEED_URL]: FEED } });
		const token = await issueRunnerToken(harness);
		await harness.call("POST", "/sources/refresh", undefined, idempotencyKey());
		const lease = await claim(harness, token);
		if (lease === null) throw new Error("expected a lease");
		await harness.runner(
			token,
			`/jobs/${lease.runId}/events`,
			stateEvents(harness, lease, TO_PUBLISHING),
		);
		const response = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			completion(lease, bundleFor(lease.runId)),
		);
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});
});
