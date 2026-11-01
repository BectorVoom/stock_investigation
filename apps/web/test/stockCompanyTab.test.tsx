import {
	type EquityBusinessParagraph,
	type EquityBusinessSource,
	type StockBusiness,
	stockBusinessSchema,
} from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCompany, NINTENDO } from "./equitiesHarness.ts";
import { deferred, errorResponse } from "./fakeBackend.ts";
import { createStocksBackend, mountStocks, type StocksServer } from "./stocksHarness.tsx";

/**
 * The Company tab's Business group (ADR-0053 §6) on the Stocks page, over
 * the fake API's profile read: the source line and its filing link, the
 * summary with "Show more" / "Show less" (aria-expanded, aria-controls,
 * focus kept on the button, kept while the stock stays shown, reset for
 * another stock), the truncated note, the pending / not-tracked /
 * not-found sentences, the way to Financial statements, nothing extra while
 * the profile loads or after it failed, and the Japanese words.
 */

const APPLE_10K: EquityBusinessSource = {
	sourceDocumentId: "0000320193-25-000079",
	form: "10-K",
	filedOn: "2025-10-31",
	periodEnd: "2025-09-27",
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
};

const NINTENDO_REPORT: EquityBusinessSource = {
	sourceDocumentId: "S100W4AB",
	form: "securities-report",
	filedOn: "2025-06-27",
	periodEnd: "2025-03-31",
	sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100W4AB",
};

/** A text paragraph of exactly `chars` UTF-16 units, ending with a full stop. */
function text(label: string, chars: number): EquityBusinessParagraph {
	const body = `${label} `.padEnd(chars - 1, "x");
	return { kind: "text", text: `${body}.` };
}

function heading(words: string): EquityBusinessParagraph {
	return { kind: "heading", text: words };
}

/**
 * Six paragraphs whose summary (700 units) is the first three: the fourth
 * (a heading) would fit but a summary never ends on a heading, the fifth
 * does not fit.
 */
const APPLE_PARAGRAPHS: readonly EquityBusinessParagraph[] = [
	heading("Company Background"),
	text("The Company designs, manufactures and markets smartphones", 300),
	text("The Company's fiscal year is the 52- or 53-week period", 300),
	heading("Products"),
	text("iPhone is the Company's line of smartphones", 300),
	text("Mac is the Company's line of personal computers", 300),
];

function extracted(
	source: EquityBusinessSource,
	paragraphs: readonly EquityBusinessParagraph[],
	truncated = false,
): StockBusiness {
	return stockBusinessSchema.parse({
		status: "extracted",
		source,
		paragraphs,
		truncated,
		fetchedAt: "2025-11-01T03:00:00Z",
	});
}

let api: StocksServer;

beforeEach(() => {
	api = createStocksBackend({ companies: [makeCompany(), NINTENDO()] });
});

afterEach(() => {
	cleanup();
});

async function businessGroup(): Promise<HTMLElement> {
	return waitFor(() => {
		const element = document.querySelector('#stock-panel-company [data-field="company-business"]');
		if (!(element instanceof HTMLElement)) throw new Error("no Business group yet");
		return element;
	});
}

function toggle(group: HTMLElement): HTMLButtonElement {
	const button = group.querySelector('[data-field="business-toggle"]');
	if (!(button instanceof HTMLButtonElement)) throw new Error("no Show more button");
	return button;
}

function rest(group: HTMLElement): HTMLElement {
	const element = group.querySelector('[data-field="business-rest"]');
	if (!(element instanceof HTMLElement)) throw new Error("no rest container");
	return element;
}

describe("Company tab: Business (ADR-0053 §6)", () => {
	it("shows a 10-K's source line, its filing link and the summary, the rest behind Show more", async () => {
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS));
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();

		// Below Listing, headed like it.
		const tab = document.querySelector('[data-field="stock-company-tab"]');
		expect(
			[...(tab?.querySelectorAll("section") ?? [])].map((section) =>
				section.getAttribute("data-field"),
			),
		).toEqual(["company-listing", "company-business"]);
		expect(within(group).getByRole("heading", { level: 4, name: "Business" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Business" })).toBe(group);

		const source = group.querySelector('[data-field="business-source"]');
		expect(source?.textContent).toBe(
			"From the 10-K for the fiscal year ended Sep 27, 2025, filed Oct 31, 2025. View filing",
		);
		const link = within(group).getByRole("link", { name: "View filing" });
		expect(link.getAttribute("href")).toBe(APPLE_10K.sourceUrl);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");

		// The summary: the heading as a subheading, then two text paragraphs, in English.
		const summary = group.querySelector('[data-field="business-summary"]');
		expect(summary?.getAttribute("lang")).toBe("en");
		expect(
			within(group).getByRole("heading", { level: 5, name: "Company Background" }),
		).toBeTruthy();
		expect([...(summary?.children ?? [])].map((element) => element.tagName)).toEqual([
			"H5",
			"P",
			"P",
		]);
		// The rest is in the DOM but hidden until Show more.
		expect(rest(group).hidden).toBe(true);
		const button = toggle(group);
		expect(button.textContent).toBe("Show more");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.getAttribute("aria-controls")).toBe(rest(group).id);
		expect(group.querySelector('[data-field="business-continues"]')).toBeNull();
	});

	it("expands and collapses with focus kept on the same button", async () => {
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS));
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();
		const button = toggle(group);
		button.focus();
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(button.textContent).toBe("Show less");
		expect(rest(group).hidden).toBe(false);
		expect(within(rest(group)).getByRole("heading", { level: 5, name: "Products" })).toBeTruthy();
		expect(rest(group).textContent).toContain("Mac is the Company's line of personal computers");
		expect(document.activeElement).toBe(button);
		expect(toggle(group)).toBe(button);

		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		expect(button.textContent).toBe("Show more");
		expect(rest(group).hidden).toBe(true);
		expect(document.activeElement).toBe(button);
	});

	it("keeps Show more open while the stock stays shown and starts closed for another stock", async () => {
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS));
		api.businessOf.set("us:MSFT", extracted(APPLE_10K, APPLE_PARAGRAPHS));
		const page = mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		fireEvent.click(toggle(await businessGroup()));
		// Another tab and back: the panel was kept, open.
		const strip = screen.getByRole("tablist", { name: /^Data of / });
		fireEvent.click(within(strip).getByRole("tab", { name: "Chart" }));
		await waitFor(() => expect(document.getElementById("stock-panel-company")?.hidden).toBe(true));
		fireEvent.click(within(strip).getByRole("tab", { name: "Company" }));
		await waitFor(() => expect(document.getElementById("stock-panel-company")?.hidden).toBe(false));
		expect(toggle(await businessGroup()).getAttribute("aria-expanded")).toBe("true");

		// Another stock: its tabs are new, the description starts closed.
		page.setRoute({ stockId: "us:MSFT", tab: "company" });
		await screen.findByRole("heading", { name: /· MSFT$/ });
		await waitFor(() => expect(toggle(document.body).getAttribute("aria-expanded")).toBe("false"));
		page.setRoute({ stockId: "us:AAPL", tab: "company" });
		await screen.findByRole("heading", { name: /· AAPL$/ });
		await waitFor(() => expect(toggle(document.body).getAttribute("aria-expanded")).toBe("false"));
	});

	it("ends the expanded text of a truncated description with the filing", async () => {
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS, true));
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();
		const note = group.querySelector('[data-field="business-continues"]');
		// Inside the rest, last, so it shows only when expanded.
		expect(note?.parentElement).toBe(rest(group));
		expect(rest(group).lastElementChild).toBe(note);
		expect(note?.textContent).toBe("The section continues in the filing. View filing");
		fireEvent.click(toggle(group));
		const links = within(rest(group)).getAllByRole("link", { name: "View filing" });
		expect(links.map((link) => link.getAttribute("href"))).toEqual([APPLE_10K.sourceUrl]);
	});

	it("has no Show more when the summary is everything, and states a truncation at once", async () => {
		const short = [text("The Company designs smartphones", 200)];
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, short));
		api.businessOf.set("us:MSFT", extracted(APPLE_10K, short, true));
		const page = mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-summary"] p')?.textContent).toContain(
			"The Company designs smartphones",
		);
		expect(group.querySelector('[data-field="business-toggle"]')).toBeNull();
		expect(group.querySelector('[data-field="business-rest"]')).toBeNull();
		expect(group.querySelector('[data-field="business-continues"]')).toBeNull();

		page.setRoute({ stockId: "us:MSFT", tab: "company" });
		await screen.findByRole("heading", { name: /· MSFT$/ });
		await waitFor(() =>
			expect(document.querySelector('[data-field="business-continues"]')?.textContent).toBe(
				"The section continues in the filing. View filing",
			),
		);
		expect(document.querySelector('[data-field="business-toggle"]')).toBeNull();
	});

	it("says the description arrives with the next sync while it is pending", async () => {
		api.businessOf.set("us:AAPL", { status: "pending" });
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-pending"]')?.textContent).toBe(
			"The business description arrives with the next financial statements sync.",
		);
		expect(within(group).queryByRole("link")).toBeNull();
	});

	it("says a report without a readable section was read, with its link", async () => {
		api.businessOf.set("us:AAPL", { status: "not-found", source: APPLE_10K });
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-found"]')?.textContent).toBe(
			"The newest annual report has no business section that could be read.",
		);
		expect(group.querySelector('[data-field="business-source"]')?.textContent).toContain(
			"From the 10-K for the fiscal year ended Sep 27, 2025, filed Oct 31, 2025.",
		);
		expect(within(group).getByRole("link", { name: "View filing" }).getAttribute("href")).toBe(
			APPLE_10K.sourceUrl,
		);
		expect(group.querySelector('[data-field="business-toggle"]')).toBeNull();
	});

	it("says a stock that is not synced gets its description on the Watchlist, with no control (ADR-0054)", async () => {
		// MSFT is not tracked: the harness answers "not-tracked".
		const page = mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-tracked"]')?.textContent).toBe(
			"Business descriptions come from annual reports, read for the stocks on the Watchlist. Add this stock to the Watchlist to read its description.",
		);
		expect(within(group).queryByRole("button")).toBeNull();
		expect(page.navigations).toEqual([]);
	});

	it("shows nothing for the description while the profile loads, and nothing extra when it fails", async () => {
		const held = deferred<void>();
		api.backend.on("GET", /^\/api\/v1\/stocks\/us%3AAAPL$/, async () => {
			await held.promise;
			return errorResponse(500, "INTERNAL", "The API failed.");
		});
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-listing"]')?.textContent).toContain(
				"Loading",
			),
		);
		expect(document.querySelector('[data-field="company-business"]')).toBeNull();
		held.resolve();
		await screen.findByText("Could not load the stock's stored company information.");
		expect(document.querySelector('[data-field="company-business"]')).toBeNull();
	});

	it("reads a Japanese report in the filing's language in the English UI", async () => {
		api.businessOf.set(
			"jp:7974",
			extracted(NINTENDO_REPORT, [
				heading("事業の内容"),
				{
					kind: "text",
					text: "当社グループは、ホームエンターテインメントの分野で事業を展開しています。",
				},
			]),
		);
		mountStocks(api.backend, { route: { stockId: "jp:7974", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-source"]')?.textContent).toBe(
			"From the annual securities report (有価証券報告書) for the fiscal year ended Mar 31, 2025, filed Jun 27, 2025. View filing",
		);
		const summary = group.querySelector('[data-field="business-summary"]');
		expect(summary?.getAttribute("lang")).toBe("ja");
		expect(summary?.textContent).toContain("ホームエンターテインメント");
	});
});

describe("Company tab: Business in Japanese (ADR-0032)", () => {
	it("words a securities report, Show more and the link in Japanese", async () => {
		api.businessOf.set("jp:7974", extracted(NINTENDO_REPORT, APPLE_PARAGRAPHS, true));
		mountStocks(api.backend, { route: { stockId: "jp:7974", tab: "company" }, locale: "ja" });
		const group = await businessGroup();
		expect(within(group).getByRole("heading", { level: 4, name: "事業内容" })).toBeTruthy();
		expect(group.querySelector('[data-field="business-source"]')?.textContent).toBe(
			"2025年3月31日期の有価証券報告書（2025年6月27日提出）より。 書類を見る",
		);
		const button = toggle(group);
		expect(button.textContent).toBe("さらに表示");
		fireEvent.click(button);
		expect(button.textContent).toBe("表示を減らす");
		expect(group.querySelector('[data-field="business-continues"]')?.textContent).toBe(
			"続きは書類をご覧ください。 書類を見る",
		);
	});

	it("words a 10-K, pending, not-found and not-tracked in Japanese", async () => {
		api.businessOf.set("us:AAPL", { status: "not-found", source: APPLE_10K });
		api.businessOf.set("jp:7974", { status: "pending" });
		const page = mountStocks(api.backend, {
			route: { stockId: "us:AAPL", tab: "company" },
			locale: "ja",
		});
		let group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-found"]')?.textContent).toBe(
			"最新の年次報告書には、読み取れる事業内容の記載がありませんでした。",
		);
		expect(group.querySelector('[data-field="business-source"]')?.textContent).toBe(
			"2025年9月27日期の年次報告書（Form 10-K、2025年10月31日提出）より。 書類を見る",
		);

		page.setRoute({ stockId: "jp:7974", tab: "company" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="business-pending"]')?.textContent).toBe(
				"事業内容は次回の財務諸表の同期で取得されます。",
			),
		);

		page.setRoute({ stockId: "us:MSFT", tab: "company" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="business-not-tracked"]')).toBeTruthy(),
		);
		group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-tracked"]')?.textContent).toBe(
			"事業内容は年次報告書から、ウォッチリストの銘柄について読み取ります。事業内容を表示するには、この銘柄をウォッチリストに追加してください。",
		);
		expect(within(group).queryByRole("button")).toBeNull();
	});
});
