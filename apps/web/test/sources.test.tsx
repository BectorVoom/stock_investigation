import { type NewsSource, newsSourceSchema } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { SourcesView } from "../src/sources/SourcesView.tsx";
import { createFakeBackend, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { makeRun } from "./fixtures.ts";

const SOURCE: NewsSource = newsSourceSchema.parse({
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/feed.xml",
	sourceType: "rss",
	title: "Example Energy News",
	publisher: "Example Media",
	licensePolicy: "headline-and-link-only",
	trustClassification: "trade-press",
	feedStatus: "failing",
	lastFetchedAt: "2026-10-05T03:00:00Z",
	lastErrorCode: "FETCH_TIMEOUT",
	lastErrorUpstreamStatus: null,
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-05T03:00:00Z",
});

const PREVIEW = {
	canonicalUrl: "https://feeds.example.org/energy.xml",
	sourceType: "atom",
	title: "Energy Wire",
	siteLink: "https://example.org/",
	suggestedPublisher: "Example Org",
	itemCount: 12,
	rejectedItemCount: 2,
	sampleItems: [
		{
			title: "Storage tenders double",
			canonicalUrl: "https://example.org/a",
			publishedAt: "2026-10-04T00:00:00Z",
		},
	],
	alreadySubscribed: false,
};

const RECOMMENDED = {
	catalogId: "cat_1",
	title: "Official Statistics Feed",
	publisher: "Statistics Bureau",
	feedUrl: "https://stats.example.go.jp/feed.xml",
	homepageUrl: "https://stats.example.go.jp/",
	region: "JP",
	language: "ja",
	trustClassification: "official",
	licensePolicy: "headline-and-link-only",
	rationale: "Primary source for monthly production statistics.",
	feedCheckedOn: "2026-10-01",
};

function article(index: number) {
	return {
		articleId: `art_${index}`,
		sourceId: "src_1",
		canonicalUrl: `https://news.example.com/articles/${index}`,
		publisher: "Example Media",
		title: `Article number ${index}`,
		publishedAt: null,
		retrievedAt: "2026-10-05T03:00:00Z",
		contentFingerprint: "f".repeat(64),
		excerpt: null,
	};
}

let backend: FakeBackend;
let subscribed: NewsSource[];

beforeEach(() => {
	backend = createFakeBackend();
	subscribed = [SOURCE];
	backend.on("GET", /^\/api\/v1\/sources$/, () => jsonResponse({ sources: subscribed }));
	backend.on("GET", /^\/api\/v1\/sources\/recommended$/, () =>
		jsonResponse({ entries: [RECOMMENDED] }),
	);
	backend.on("GET", /^\/api\/v1\/articles$/, () =>
		jsonResponse({ articles: [article(1), article(2)], nextCursor: "page-2" }),
	);
	backend.on("GET", /^\/api\/v1\/articles\?cursor=page-2$/, () =>
		jsonResponse({ articles: [article(3)], nextCursor: null }),
	);
	backend.on("POST", /^\/api\/v1\/sources\/preview$/, () => jsonResponse(PREVIEW));
	backend.on("POST", /^\/api\/v1\/sources$/, () => {
		const created: NewsSource = {
			...SOURCE,
			sourceId: "src_2",
			title: "Energy Wire",
			feedStatus: "active",
			lastErrorCode: null,
			lastErrorUpstreamStatus: null,
		};
		subscribed = [...subscribed, created];
		return jsonResponse(created, { status: 201 });
	});
});

afterEach(cleanup);

function mount() {
	render(() => <SourcesView api={createApiClient({ fetch: backend.fetch })} />);
}

/** Buttons are disabled while an action is in flight; wait until the control can be used. */
async function enabledButton(name: string): Promise<HTMLElement> {
	return waitFor(() => {
		const button = screen.getByRole("button", { name });
		if (button.hasAttribute("disabled")) throw new Error(`"${name}" is still disabled`);
		return button;
	});
}

const writes = () => backend.requests.filter((request) => request.method !== "GET");

describe("Sources view", () => {
	it("lists subscribed sources with their last fetch status and error", async () => {
		mount();
		const table = await screen.findByRole("table", {
			name: "Sources you subscribe to, with their last fetch status",
		});
		const row = within(table).getByRole("row", { name: /Example Energy News/ });
		expect(row.querySelector('[data-field="feed-status"]')?.textContent).toContain("failing");
		expect(row.textContent).toContain("Last fetch: 2026-10-05 03:00 UTC");
		expect(row.textContent).toContain("Last error: FETCH_TIMEOUT");
		// A timeout had no answer from the feed host, so no status is stated.
		expect(row.querySelector('[data-field="last-error-upstream-status"]')).toBeNull();
	});

	it("states the feed host's answer status beside the last error code", async () => {
		subscribed = [{ ...SOURCE, lastErrorCode: "HTTP_ERROR", lastErrorUpstreamStatus: 410 }];
		mount();
		const table = await screen.findByRole("table", {
			name: "Sources you subscribe to, with their last fetch status",
		});
		const row = within(table).getByRole("row", { name: /Example Energy News/ });
		expect(row.textContent).toContain("Last error: HTTP_ERROR (service answered HTTP 410)");
	});

	it("states the feed host's answer status when a preview fails because of it", async () => {
		// The API answers with the host's own status (ADR-0037): a 404, not 502.
		backend.on("POST", /^\/api\/v1\/sources\/preview$/, () =>
			jsonResponse(
				{
					error: {
						code: "FETCH_FAILED",
						message: "The source could not be retrieved.",
						detail: "HTTP_ERROR",
						upstreamStatus: 404,
					},
				},
				{ status: 404 },
			),
		);
		mount();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("Feed or site URL"), {
			target: { value: "https://feeds.example.org/gone.xml" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"FETCH_FAILED: The source could not be retrieved. (HTTP_ERROR) (service answered HTTP 404)",
		);
	});

	it("previews a URL without subscribing, then subscribes only on an explicit click", async () => {
		mount();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("Feed or site URL"), {
			target: { value: "https://feeds.example.org/energy.xml" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview source" }));

		const preview = await screen.findByRole("region", { name: "Source preview" });
		expect(preview.textContent).toContain("Preview: Energy Wire");
		expect(preview.querySelector('[data-field="item-count"]')?.textContent).toBe("12");
		expect(preview.querySelector('[data-field="rejected-count"]')?.textContent).toContain("2");
		expect(within(preview).getByRole("list", { name: "Sample items" }).textContent).toContain(
			"Storage tenders double",
		);
		// Previewing has not subscribed to anything.
		expect(writes().map((request) => request.path)).toEqual(["/api/v1/sources/preview"]);
		expect(writes()[0]?.body).toEqual({ url: "https://feeds.example.org/energy.xml" });

		fireEvent.change(within(preview).getByLabelText("License policy"), {
			target: { value: "short-excerpt-permitted" },
		});
		fireEvent.change(within(preview).getByLabelText("Trust classification"), {
			target: { value: "established-media" },
		});
		fireEvent.click(within(preview).getByRole("button", { name: "Subscribe to this source" }));

		await screen.findByText("Subscribed to “Energy Wire”.");
		expect(writes()[1]?.path).toBe("/api/v1/sources");
		expect(writes()[1]?.body).toEqual({
			url: "https://feeds.example.org/energy.xml",
			title: "Energy Wire",
			publisher: "Example Org",
			licensePolicy: "short-excerpt-permitted",
			trustClassification: "established-media",
		});
		expect(screen.queryByRole("region", { name: "Source preview" })).toBeNull();
		await screen.findByRole("row", { name: /Energy Wire/ });
	});

	it("defaults a previewed URL to the most conservative license and trust settings", async () => {
		mount();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("Feed or site URL"), {
			target: { value: "https://feeds.example.org/energy.xml" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
		const preview = await screen.findByRole("region", { name: "Source preview" });
		fireEvent.click(within(preview).getByRole("button", { name: "Subscribe to this source" }));
		await waitFor(() => expect(writes()).toHaveLength(2));
		expect(writes()[1]?.body).toMatchObject({
			licensePolicy: "headline-and-link-only",
			trustClassification: "unclassified",
		});
	});

	it("cannot subscribe again to a feed that is already subscribed", async () => {
		backend.on("POST", /^\/api\/v1\/sources\/preview$/, () =>
			jsonResponse({ ...PREVIEW, alreadySubscribed: true }),
		);
		mount();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("Feed or site URL"), {
			target: { value: "https://feeds.example.org/energy.xml" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
		const preview = await screen.findByRole("region", { name: "Source preview" });
		expect(preview.textContent).toContain("You already subscribe to this feed.");
		expect(
			within(preview)
				.getByRole("button", { name: "Subscribe to this source" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("shows why an unsafe URL was rejected", async () => {
		backend.on("POST", /^\/api\/v1\/sources\/preview$/, () =>
			errorResponse(422, "UNSAFE_URL", "the URL is not allowed", "PRIVATE_ADDRESS"),
		);
		mount();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("Feed or site URL"), {
			target: { value: "https://10.0.0.1/feed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("UNSAFE_URL");
		expect(alert.textContent).toContain("PRIVATE_ADDRESS");
		expect(alert.textContent).not.toContain("service answered");
		expect(screen.queryByRole("region", { name: "Source preview" })).toBeNull();
	});

	it("never enrols a recommended source automatically; subscribing needs its own click", async () => {
		mount();
		const catalog = await screen.findByRole("region", { name: "Recommended sources" });
		await within(catalog).findByText("Primary source for monthly production statistics.");
		expect(writes()).toHaveLength(0);

		fireEvent.click(
			within(catalog).getByRole("button", { name: "Preview Official Statistics Feed" }),
		);
		await screen.findByRole("region", { name: "Source preview" });
		expect(writes().map((request) => request.path)).toEqual(["/api/v1/sources/preview"]);
		expect(writes()[0]?.body).toEqual({ url: "https://stats.example.go.jp/feed.xml" });

		fireEvent.click(
			within(catalog).getByRole("button", { name: "Subscribe to Official Statistics Feed" }),
		);
		await waitFor(() => expect(writes()).toHaveLength(2));
		expect(writes()[1]?.body).toEqual({
			url: "https://stats.example.go.jp/feed.xml",
			title: "Official Statistics Feed",
			publisher: "Statistics Bureau",
			licensePolicy: "headline-and-link-only",
			trustClassification: "official",
		});
	});

	it("pauses, resumes and removes a source", async () => {
		backend.on("PATCH", /^\/api\/v1\/sources\/src_1$/, (request) => {
			const paused =
				typeof request.body === "object" &&
				request.body !== null &&
				"feedStatus" in request.body &&
				request.body.feedStatus === "paused";
			subscribed = [{ ...SOURCE, feedStatus: paused ? "paused" : "active", lastErrorCode: null }];
			return jsonResponse(subscribed[0]);
		});
		backend.on("DELETE", /^\/api\/v1\/sources\/src_1$/, () => {
			subscribed = [];
			return new Response(null, { status: 204 });
		});
		mount();
		fireEvent.click(await enabledButton("Pause Example Energy News"));
		fireEvent.click(await enabledButton("Resume Example Energy News"));
		await enabledButton("Pause Example Energy News");
		expect(backend.requestsTo("PATCH", /src_1$/).map((request) => request.body)).toEqual([
			{ feedStatus: "paused" },
			{ feedStatus: "active" },
		]);

		fireEvent.click(await enabledButton("Remove Example Energy News"));
		await screen.findByText("No sources subscribed yet.");
		expect(backend.requestsTo("DELETE", /src_1$/)).toHaveLength(1);
	});

	it("queues a news refresh with an idempotency key and says it waits for the runner", async () => {
		backend.on("POST", /^\/api\/v1\/sources\/refresh$/, () =>
			jsonResponse(
				{
					run: makeRun({
						runId: "run_news",
						kind: "news-ingest",
						request: null,
						workspaceId: null,
						state: "pending",
					}),
				},
				{ status: 202 },
			),
		);
		mount();
		await screen.findByRole("table");
		fireEvent.click(screen.getByRole("button", { name: "Refresh news now" }));
		const status = await screen.findByText(/News refresh queued as run/);
		expect(status.textContent).toContain("run_news");
		expect(status.textContent).toContain("stays queued until the runner reconnects");
		const refresh = backend.requestsTo("POST", /refresh$/)[0];
		expect(refresh?.headers["idempotency-key"]).toMatch(/^idem-[0-9a-f-]{36}$/);
		expect(refresh?.body).toBeUndefined();
	});

	it("pages through recent articles", async () => {
		mount();
		const articles = await screen.findByRole("list", { name: "Articles" });
		expect(within(articles).getAllByRole("listitem")).toHaveLength(2);
		expect(articles.textContent).toContain("published date not stated");

		fireEvent.click(screen.getByRole("button", { name: "Load more articles" }));
		await within(articles).findByText("Article number 3");
		expect(within(articles).getAllByRole("listitem")).toHaveLength(3);
		expect(screen.queryByRole("button", { name: "Load more articles" })).toBeNull();
		expect(
			within(articles).getByRole("link", { name: "Article number 1" }).getAttribute("href"),
		).toBe("https://news.example.com/articles/1");
	});
});
