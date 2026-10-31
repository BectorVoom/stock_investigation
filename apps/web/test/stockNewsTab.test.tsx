import {
	type StockNewsArticle,
	type StockNewsResponse,
	stockNewsResponseSchema,
} from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { NewsTab } from "../src/stocks/NewsTab.tsx";
import { STOCK_FRESH_MS } from "../src/stocks/stockReads.ts";
import type { SelectedStock } from "../src/stocks/stockTabs.ts";
import {
	ALWAYS_VISIBLE,
	createFakeBackend,
	deferred,
	errorResponse,
	jsonResponse,
} from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The Stocks page's News tab (ADR-0049 §7) against a fake API that counts
 * requests: no request while hidden, the kept first page shown at once —
 * without a request while fresh (`STOCK_FRESH_MS`), re-checked with its
 * ETag after that — Show more appending pages (announced), a
 * failed Show more keeping the loaded pages, and the empty, no-terms and
 * failure states.
 */

const NEWS_PATH = /^\/api\/v1\/stocks\/us%3AAAPL\/news(?:\?cursor=([^&]+))?$/;

const APPLE: SelectedStock = {
	stockId: "us:AAPL",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	watchlist: null,
	company: null,
	listTitles: [],
};

const APPLE_TERMS = [
	{ text: "Apple", kind: "name" },
	{ text: "AAPL", kind: "symbol" },
] as const;

/** Article `index` (newer first): published on a day of October 2026, except every fifth. */
function article(index: number): StockNewsArticle {
	const day = String(28 - (index % 28)).padStart(2, "0");
	return {
		articleId: `art_${index}`,
		sourceId: "src_feed",
		canonicalUrl: `https://news.example.org/articles/${index}`,
		publisher: "Example News",
		title: `Apple story ${index}`,
		publishedAt: index % 5 === 4 ? null : `2026-10-${day}T09:00:00Z`,
		retrievedAt: `2026-10-${day}T10:00:00Z`,
		contentFingerprint: "a".repeat(64),
		excerpt: index % 2 === 0 ? `Excerpt ${index} about Apple.` : null,
		mentions: { text: "Apple", kind: "name" },
	};
}

function range(from: number, count: number): StockNewsArticle[] {
	return Array.from({ length: count }, (_, offset) => article(from + offset));
}

function page(
	articles: readonly StockNewsArticle[],
	nextCursor: string | null,
	terms: StockNewsResponse["terms"] = [...APPLE_TERMS],
): StockNewsResponse {
	return stockNewsResponseSchema.parse({ stockId: "us:AAPL", terms, articles, nextCursor });
}

/**
 * A fake News endpoint: `first` answers the first page with ETag
 * `"n-<version>"` (304 when the request carries it), `pages` the page after
 * each cursor; `hold` makes the next cursor read wait for the test.
 */
function newsServer(options: {
	readonly first: StockNewsResponse;
	readonly pages?: Readonly<Record<string, StockNewsResponse>>;
}) {
	const backend = createFakeBackend();
	let first = options.first;
	let version = 1;
	let failures = { first: 0, more: 0 };
	let held: ReturnType<typeof deferred<void>> | null = null;
	backend.on("GET", NEWS_PATH, async (request, match) => {
		const cursor = match[1] === undefined ? null : decodeURIComponent(match[1]);
		if (cursor === null) {
			if (failures.first > 0) {
				failures = { ...failures, first: failures.first - 1 };
				return errorResponse(500, "INTERNAL", "The API failed.");
			}
			const etag = `"n-${version}"`;
			if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
			return jsonResponse(first, { headers: { ETag: etag } });
		}
		if (held !== null) {
			const wait = held;
			held = null;
			await wait.promise;
		}
		if (failures.more > 0) {
			failures = { ...failures, more: failures.more - 1 };
			return errorResponse(500, "INTERNAL", "The API failed.");
		}
		const next = options.pages?.[cursor];
		return next === undefined
			? errorResponse(404, "NOT_FOUND", "No such page.")
			: jsonResponse(next, { headers: { ETag: `"n-more-${cursor}"` } });
	});
	return {
		api: createApiClient({ fetch: backend.fetch }),
		firstReads: () => backend.requestsTo("GET", /\/news$/),
		moreReads: () => backend.requestsTo("GET", /\/news\?cursor=/),
		failFirst: () => {
			failures = { ...failures, first: failures.first + 1 };
		},
		failMore: () => {
			failures = { ...failures, more: failures.more + 1 };
		},
		holdMore: () => {
			const gate = deferred<void>();
			held = gate;
			return () => gate.resolve();
		},
		replaceFirst: (next: StockNewsResponse) => {
			first = next;
			version += 1;
		},
	};
}

function renderTab(
	server: ReturnType<typeof newsServer>,
	options: { readonly active?: boolean; readonly locale?: "en" | "ja" } = {},
) {
	const [shown, setShown] = createSignal(options.active ?? true);
	const [mounted, setMounted] = createSignal(true);
	render(() => (
		<LocaleProvider locale={() => options.locale ?? "en"}>
			<Show when={mounted()}>
				<NewsTab
					api={server.api}
					visibility={ALWAYS_VISIBLE}
					stock={() => APPLE}
					active={shown}
					onSelectTab={() => {}}
				/>
			</Show>
		</LocaleProvider>
	));
	return { setShown, setMounted };
}

function articleList(): HTMLElement {
	return screen.getByRole("list", { name: "Stored articles that mention Apple Inc." });
}

async function listedCount(count: number): Promise<void> {
	await waitFor(() => expect(within(articleList()).getAllByRole("listitem")).toHaveLength(count));
}

function showMore(): HTMLButtonElement {
	const button = screen.getByRole("button", { name: "Show more" });
	if (!(button instanceof HTMLButtonElement)) throw new Error("Show more is not a button");
	return button;
}

function status(): string {
	return document.querySelector('[data-field="stock-news-status"]')?.textContent ?? "";
}

/** Moves the clock `ms` ahead of real time (the read cache's freshness window); restored after each test. */
function advanceClock(ms: number): void {
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
}

/** Lets the fake backend answer and the store settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
	resetGlobalFetchCalls();
});

describe("News tab reads (ADR-0049 §3 rules 3–4)", () => {
	it("makes no request while hidden, and reads the first page once shown", async () => {
		const server = newsServer({ first: page(range(0, 20), "c1") });
		const tab = renderTab(server, { active: false });
		await settle();
		expect(server.firstReads()).toHaveLength(0);

		tab.setShown(true);
		await listedCount(20);
		expect(server.firstReads()).toHaveLength(1);
		expect(server.firstReads()[0]?.headers["if-none-match"]).toBeUndefined();
		expect(server.moreReads()).toHaveLength(0);
	});

	it("shows the kept first page at once on a second showing, without a request while it is fresh", async () => {
		const server = newsServer({ first: page(range(0, 3), null) });
		const tab = renderTab(server);
		await listedCount(3);
		tab.setMounted(false);
		await settle();

		tab.setMounted(true);
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(3);
		await settle();
		expect(server.firstReads()).toHaveLength(1);
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(3);
	});

	it("re-checks the kept first page with its ETag on a showing after the freshness window", async () => {
		const server = newsServer({ first: page(range(0, 3), null) });
		const tab = renderTab(server);
		await listedCount(3);
		tab.setMounted(false);
		await settle();

		advanceClock(STOCK_FRESH_MS + 1_000);
		tab.setMounted(true);
		// At once, from the kept answer, before the re-check answers.
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(3);
		await settle();
		const reads = server.firstReads();
		expect(reads).toHaveLength(2);
		expect(reads[1]?.headers["if-none-match"]).toBe('"n-1"');
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(3);
	});
});

describe("News tab Show more (ADR-0049 §7)", () => {
	it("appends the next page, disabled while it loads, and announces the count", async () => {
		const server = newsServer({
			first: page(range(0, 20), "c1"),
			pages: { c1: page(range(20, 20), "c2"), c2: page(range(40, 5), null) },
		});
		renderTab(server);
		await listedCount(20);

		const release = server.holdMore();
		fireEvent.click(showMore());
		expect(showMore().disabled).toBe(true);
		release();
		await listedCount(40);
		expect(showMore().disabled).toBe(false);
		expect(status()).toBe("20 more articles loaded; 40 shown.");
		expect(server.moreReads()[0]?.path).toBe("/api/v1/stocks/us%3AAAPL/news?cursor=c1");

		fireEvent.click(showMore());
		await listedCount(45);
		expect(status()).toBe("5 more articles loaded; 45 shown.");
		// Every stored article was looked at: no Show more.
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
		expect(server.firstReads()).toHaveLength(1);
	});

	it("keeps the loaded pages when Show more fails, and Try again appends", async () => {
		const server = newsServer({
			first: page(range(0, 20), "c1"),
			pages: { c1: page(range(20, 2), null) },
		});
		renderTab(server);
		await listedCount(20);
		server.failMore();
		fireEvent.click(showMore());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("More articles could not be loaded; the ones shown stay.");
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(20);

		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await listedCount(22);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps appended pages while the panel is hidden, and drops them with the panel", async () => {
		const server = newsServer({
			first: page(range(0, 20), "c1"),
			pages: { c1: page(range(20, 20), null) },
		});
		const tab = renderTab(server);
		await listedCount(20);
		fireEvent.click(showMore());
		await listedCount(40);

		// Another tab shown (the panel stays mounted, hidden): the pages stay.
		tab.setShown(false);
		await settle();
		tab.setShown(true);
		await settle();
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(40);

		// Another stock chosen (the panel goes): only the first page is kept.
		tab.setMounted(false);
		await settle();
		tab.setMounted(true);
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(20);
		expect(showMore()).toBeTruthy();
	});

	it("restarts the list from a first page that changed", async () => {
		const server = newsServer({
			first: page(range(1, 20), "c1"),
			pages: { c1: page(range(21, 20), null) },
		});
		const tab = renderTab(server);
		await listedCount(20);
		fireEvent.click(showMore());
		await listedCount(40);

		// A new article mentions the stock: the next re-check answers a new first page.
		server.replaceFirst(page(range(0, 20), "c0"));
		tab.setShown(false);
		advanceClock(STOCK_FRESH_MS + 1_000);
		tab.setShown(true);
		await listedCount(20);
		expect(within(articleList()).getAllByRole("listitem")[0]?.textContent).toContain(
			"Apple story 0",
		);
	});
});

describe("News tab content and states (ADR-0049 §7)", () => {
	it("lists each article with its link, publisher, date, excerpt and the term it mentions", async () => {
		const server = newsServer({ first: page(range(0, 5), null) });
		renderTab(server);
		await listedCount(5);
		const items = within(articleList()).getAllByRole("listitem");
		const [firstItem, , , , fifth] = items;
		if (firstItem === undefined || fifth === undefined) throw new Error("five items expected");
		const link = within(firstItem).getByRole("link", { name: "Apple story 0" });
		expect(link.getAttribute("href")).toBe("https://news.example.org/articles/0");
		expect(link.getAttribute("rel")).toContain("noopener");
		expect(firstItem.textContent).toContain("Example News");
		expect(firstItem.textContent).toContain("Published Oct 28, 2026");
		expect(firstItem.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-28T09:00:00Z");
		expect(firstItem.textContent).toContain("Excerpt 0 about Apple.");
		expect(firstItem.textContent).toContain("Mentions: Apple");
		// No publication date: the retrieved date, said as such.
		expect(fifth.textContent).toContain("Retrieved Oct 24, 2026 (no publication date)");
		expect(screen.getByText("Searched for: Apple, AAPL")).toBeTruthy();
	});

	it("writes dates in the UI language", async () => {
		const server = newsServer({ first: page(range(0, 1), null) });
		renderTab(server, { locale: "ja" });
		const item = await waitFor(() => {
			const found = document.querySelector('[data-article-id="art_0"]');
			if (!(found instanceof HTMLElement)) throw new Error("no article yet");
			return found;
		});
		expect(item.textContent).toContain("公開 2026/10/28");
		expect(item.textContent).toContain("言及：Apple");
	});

	it("says no stored article mentions the stock, with the terms and a link to Sources", async () => {
		const server = newsServer({ first: page([], null) });
		renderTab(server);
		const none = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-news-none"]');
			if (!(found instanceof HTMLElement)) throw new Error("no empty state");
			return found;
		});
		expect(none.textContent).toContain(
			"No stored article mentions Apple. Articles come from the feeds chosen on Sources.",
		);
		expect(none.textContent).toContain("Searched for: Apple, AAPL");
		expect(within(none).getByRole("link", { name: "Open Sources" }).getAttribute("href")).toBe(
			"#/sources",
		);
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
	});

	it("keeps Show more, not the empty state, while pages without a mention still have a cursor", async () => {
		// The server reads at most 5 batches of 60 candidates per request, so a
		// page may hold no article and still name older ones to look at.
		const server = newsServer({
			first: page([], "c1"),
			pages: { c1: page([], "c2"), c2: page(range(30, 2), "c3"), c3: page([], "c4") },
		});
		renderTab(server);
		const noneYet = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-news-none-yet"]');
			if (!(found instanceof HTMLElement)) throw new Error("no none-yet state");
			return found;
		});
		expect(noneYet.textContent).toContain(
			"No mention of Apple among the stored articles looked at so far.",
		);
		expect(noneYet.textContent).toContain("Searched for: Apple, AAPL");
		expect(document.querySelector('[data-field="stock-news-none"]')).toBeNull();

		// A Show more page that adds nothing but has a cursor: still not empty, Show more stays.
		fireEvent.click(showMore());
		await waitFor(() =>
			expect(status()).toBe("No further mentions in the next stored articles; 0 shown."),
		);
		expect(document.querySelector('[data-field="stock-news-none-yet"]')).not.toBeNull();
		expect(document.querySelector('[data-field="stock-news-none"]')).toBeNull();

		fireEvent.click(showMore());
		await listedCount(2);
		expect(status()).toBe("2 more articles loaded; 2 shown.");

		// Past a listed page, an empty page with a cursor keeps the list and Show more.
		fireEvent.click(showMore());
		await waitFor(() =>
			expect(status()).toBe("No further mentions in the next stored articles; 2 shown."),
		);
		expect(within(articleList()).getAllByRole("listitem")).toHaveLength(2);
		expect(showMore().disabled).toBe(false);
		expect(server.moreReads().map((read) => read.path.split("cursor=")[1])).toEqual([
			"c1",
			"c2",
			"c3",
		]);
	});

	it("says when there is no stored name to search for", async () => {
		const server = newsServer({ first: page([], null, []) });
		renderTab(server);
		const none = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-news-no-terms"]');
			if (!(found instanceof HTMLElement)) throw new Error("no no-terms state");
			return found;
		});
		expect(none.textContent).toContain("There is no stored name to search the articles for");
		expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
	});

	it("states a failed first read with Try again, which reads again", async () => {
		const server = newsServer({ first: page(range(0, 2), null) });
		server.failFirst();
		renderTab(server);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The stored articles could not be loaded.");
		expect(alert.textContent).toContain("INTERNAL");
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await listedCount(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(server.firstReads()).toHaveLength(2);
	});
});
