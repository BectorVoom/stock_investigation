import {
	type CompanyOverviewView,
	type CompanySummaryView,
	companyOverviewViewSchema,
	type EquityBusinessParagraph,
	type EquityBusinessSource,
	type StockBusiness,
	type StockCompanyProfileView,
	stockBusinessSchema,
	stockCompanyProfileViewSchema,
} from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * the profile loads or after it failed, and the Japanese words. A Japanese
 * stock shows its J-Quants company profile instead (ADR-0059 §3).
 */

const APPLE_10K: EquityBusinessSource = {
	sourceDocumentId: "0000320193-25-000079",
	form: "10-K",
	filedOn: "2025-10-31",
	periodEnd: "2025-09-27",
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
};

/** Toyota's row of J-Quants' Listed Issue Master (live, 2026-11-02), as the API returns it stored. */
const TOYOTA_PROFILE: StockCompanyProfileView = stockCompanyProfileViewSchema.parse({
	symbol: "7203",
	nameEn: "TOYOTA MOTOR CORPORATION",
	sector17Code: "6",
	sector17Name: "自動車・輸送機",
	sector33Code: "3700",
	sector33Name: "輸送用機器",
	scaleCategory: "TOPIX Core30",
	marketSegmentCode: "0111",
	marketSegmentName: "プライム",
	asOf: "2026-08-10",
	retrievedAt: "2026-11-02T03:00:00Z",
});

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
		).toEqual(["company-summary", "company-listing", "company-business"]);
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
			"No business description is stored yet. The server reads it from the annual report by itself; it appears here once stored.",
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

	it("says a listed stock not tracked yet has its description on the way, on the Watchlist or not (ADR-0058 §6)", async () => {
		// MSFT is listed but its company is not tracked yet: the harness answers "not-tracked".
		const page = mountStocks(api.backend, { route: { stockId: "us:MSFT", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-pending"]')?.textContent).toBe(
			"No business description is stored yet. The server reads it from the annual report by itself; it appears here once stored.",
		);
		expect(
			group.querySelector("[data-business-status]")?.getAttribute("data-business-status"),
		).toBe("pending");
		expect(within(group).queryByRole("button")).toBeNull();
		expect(page.navigations).toEqual([]);
	});

	it("says a stock outside the stored stock lists gets no description, with no control", async () => {
		const page = mountStocks(api.backend, { route: { stockId: "us:ZZZZ", tab: "company" } });
		const group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-tracked"]')?.textContent).toBe(
			"No business description is stored for this stock. The server reads the descriptions of the stocks in the stored US stock list, and this stock is not in it.",
		);
		expect(group.textContent).not.toContain("Watchlist");
		expect(within(group).queryByRole("button")).toBeNull();
		expect(page.navigations).toEqual([]);
	});

	it("re-reads the profile sooner while the description is on the way, and stops once it is stored", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			api.businessOf.set("us:AAPL", { status: "pending" });
			mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
			const reads = () => api.backend.requestsTo("GET", /^\/api\/v1\/stocks\/us%3AAAPL$/);
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() =>
				expect(document.querySelector('[data-field="business-pending"]')).not.toBeNull(),
			);
			const first = reads().length;
			await vi.advanceTimersByTimeAsync(5_000);
			expect(reads()).toHaveLength(first + 1);
			api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(reads()).toHaveLength(first + 2);
			await vi.waitFor(() =>
				expect(document.querySelector('[data-field="business-summary"]')).not.toBeNull(),
			);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(reads()).toHaveLength(first + 2);
		} finally {
			vi.useRealTimers();
		}
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

	it("shows no Business group for a Japanese stock: J-Quants has no description", async () => {
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		await profileGroup();
		expect(document.querySelector('[data-field="company-business"]')).toBeNull();
		expect(document.querySelector('[data-field="business-not-tracked"]')).toBeNull();
	});
});

async function profileGroup(): Promise<HTMLElement> {
	return waitFor(() => {
		const element = document.querySelector('#stock-panel-company [data-field="company-profile"]');
		if (!(element instanceof HTMLElement)) throw new Error("no Company profile group yet");
		return element;
	});
}

/** The description list's rows as "term: value" texts. */
function rows(group: HTMLElement): string[] {
	return [...group.querySelectorAll("dl > div")].map(
		(row) => `${row.querySelector("dt")?.textContent}: ${row.querySelector("dd")?.textContent}`,
	);
}

describe("Company tab: a Japanese stock's J-Quants profile (ADR-0059 §3)", () => {
	it("shows the stored profile in place of a business description, with its date and source", async () => {
		api.companyProfileOf.set("jp:7203", TOYOTA_PROFILE);
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		const group = await profileGroup();

		const tab = document.querySelector('[data-field="stock-company-tab"]');
		expect(
			[...(tab?.querySelectorAll("section") ?? [])].map((section) =>
				section.getAttribute("data-field"),
			),
		).toEqual(["company-summary", "company-listing", "company-profile"]);
		expect(within(group).getByRole("heading", { level: 4, name: "Company profile" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Company profile" })).toBe(group);
		expect(rows(group)).toEqual([
			"Sector (33 sectors): 輸送用機器",
			"Sector (17 sectors): 自動車・輸送機",
			"Market segment: プライム",
			"Scale category: TOPIX Core30",
		]);
		// J-Quants' Japanese names are marked so a screen reader reads them in Japanese.
		expect(
			[...group.querySelectorAll('dd [lang="ja"]')].map((element) => element.textContent),
		).toEqual(["輸送用機器", "自動車・輸送機", "プライム"]);
		expect(group.querySelector('[data-field="company-profile-source"]')?.textContent).toBe(
			"As of Aug 10, 2026. Source: J-Quants (Listed Issue Master).",
		);
		// The owner removed the line that J-Quants has no business description (2026-11-03).
		expect(group.querySelector('[data-field="company-profile-no-business"]')).toBeNull();
		expect(group.textContent).not.toContain("has no business description");
		expect(within(group).queryByRole("link")).toBeNull();
		expect(within(group).queryByRole("button")).toBeNull();
		expect(document.querySelector('[data-field="company-business"]')).toBeNull();
	});

	it("says J-Quants states no scale category, and shows no second English name", async () => {
		api.companyProfileOf.set("jp:7203", { ...TOYOTA_PROFILE, nameEn: null, scaleCategory: null });
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		const group = await profileGroup();
		expect(rows(group)).toEqual([
			"Sector (33 sectors): 輸送用機器",
			"Sector (17 sectors): 自動車・輸送機",
			"Market segment: プライム",
			"Scale category: None",
		]);
		expect(group.querySelectorAll('[data-unavailable="true"]')).toHaveLength(1);
	});

	it("says no profile is stored yet when the API has none, and re-reads no sooner", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
			const reads = () => api.backend.requestsTo("GET", /^\/api\/v1\/stocks\/jp%3A7203$/);
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() =>
				expect(document.querySelector('[data-field="company-profile-none"]')?.textContent).toBe(
					"No company profile is stored for this stock yet. The server stores the profiles of Japanese stocks from J-Quants with the Japanese stock list; it appears here once stored.",
				),
			);
			const group = await profileGroup();
			expect(group.querySelector("dl")).toBeNull();
			expect(group.querySelector('[data-field="company-profile-source"]')).toBeNull();
			const first = reads().length;
			// The profile comes with the daily stock list, not within seconds: no quick re-reads.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(reads()).toHaveLength(first);
		} finally {
			vi.useRealTimers();
		}
	});

	it("words the profile and its absence in Japanese", async () => {
		api.companyProfileOf.set("jp:7203", TOYOTA_PROFILE);
		const page = mountStocks(api.backend, {
			route: { stockId: "jp:7203", tab: "company" },
			locale: "ja",
		});
		const group = await profileGroup();
		expect(within(group).getByRole("heading", { level: 4, name: "企業概要" })).toBeTruthy();
		expect(rows(group)).toEqual([
			"業種（33 業種）: 輸送用機器",
			"業種（17 業種）: 自動車・輸送機",
			"市場区分: プライム",
			"規模区分: TOPIX Core30",
		]);
		expect(group.querySelector('[data-field="company-profile-source"]')?.textContent).toBe(
			"2026年8月10日時点。出典: J-Quants（上場銘柄一覧）。",
		);
		expect(group.textContent).not.toContain("事業内容の記載がない");

		page.setRoute({ stockId: "jp:6758", tab: "company" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-profile-none"]')?.textContent).toBe(
				"この銘柄の企業概要はまだ保存されていません。サーバーは日本の銘柄一覧とあわせて J-Quants から日本株の企業概要を保存します。保存されるとここに表示されます。",
			),
		);
	});
});

describe("Company tab: Business in Japanese (ADR-0032)", () => {
	it("words a 10-K, Show more and the link in Japanese", async () => {
		api.businessOf.set("us:AAPL", extracted(APPLE_10K, APPLE_PARAGRAPHS, true));
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" }, locale: "ja" });
		const group = await businessGroup();
		expect(within(group).getByRole("heading", { level: 4, name: "事業内容" })).toBeTruthy();
		expect(group.querySelector('[data-field="business-source"]')?.textContent).toBe(
			"2025年9月27日期の年次報告書（Form 10-K、2025年10月31日提出）より。 書類を見る",
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
		api.businessOf.set("us:MSFT", { status: "pending" });
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

		page.setRoute({ stockId: "us:MSFT", tab: "company" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="business-pending"]')?.textContent).toBe(
				"事業内容はまだ保存されていません。サーバーが年次報告書から自動で読み取り、保存されるとここに表示されます。",
			),
		);

		page.setRoute({ stockId: "us:ZZZZ", tab: "company" });
		await waitFor(() =>
			expect(document.querySelector('[data-field="business-not-tracked"]')).toBeTruthy(),
		);
		group = await businessGroup();
		expect(group.querySelector('[data-field="business-not-tracked"]')?.textContent).toBe(
			"この銘柄の事業内容は保存されていません。サーバーは保存済みの米国の銘柄一覧にある銘柄の事業内容を年次報告書から読み取りますが、この銘柄は一覧にありません。",
		);
		expect(within(group).queryByRole("button")).toBeNull();
	});
});

/** Toyota's summary as a `company-summarized` completion leaves it (ADR-0060). */
const TOYOTA_SUMMARY: CompanySummaryView = {
	description: {
		en: "Toyota Motor builds cars, trucks and hybrid vehicles sold worldwide.",
		ja: "トヨタ自動車は世界で販売される乗用車、トラック、ハイブリッド車を製造しています。",
	},
	themes: [
		{ en: "Automobiles", ja: "自動車" },
		{ en: "Hybrid vehicles", ja: "ハイブリッド車" },
	],
	agentId: "claude-code",
	model: "claude-sonnet",
	generatedAt: "2026-11-02T03:00:00.000Z",
};

async function summaryGroup(): Promise<HTMLElement> {
	return waitFor(() => {
		const group = document.querySelector<HTMLElement>('[data-field="company-summary"]');
		if (group === null) throw new Error("no summary group yet");
		return group;
	});
}

describe("Company tab: the AI-written summary and themes (ADR-0060)", () => {
	it("shows the description, the themes as a list and who wrote it, marked as AI", async () => {
		api.summaryOf.set("jp:7203", TOYOTA_SUMMARY);
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" } });
		const group = await summaryGroup();
		expect(screen.getByRole("region", { name: "Business overview" })).toBe(group);
		expect(
			within(group).getByRole("heading", { level: 4, name: "Business overview" }),
		).toBeTruthy();
		expect(group.querySelector('[data-field="company-summary-description"]')?.textContent).toBe(
			TOYOTA_SUMMARY.description.en,
		);
		const themes = within(group).getByRole("list", { name: "Themes" });
		expect(
			within(themes)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["Automobiles", "Hybrid vehicles"]);
		expect(group.querySelector('[data-field="company-summary-source"]')?.textContent).toBe(
			"Written by AI (claude-code, claude-sonnet) on Nov 2, 2026. It may contain mistakes.",
		);
	});

	it("says no description is written yet", async () => {
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const group = await summaryGroup();
		expect(group.querySelector('[data-field="company-summary-none"]')?.textContent).toBe(
			"No description is written yet. The server asks the AI agent chosen in Settings → AI agent to write one for each Watchlist stock; it appears here once written.",
		);
		expect(within(group).queryByRole("list")).toBeNull();
	});

	it("shows the Japanese description and themes in Japanese", async () => {
		api.summaryOf.set("jp:7203", { ...TOYOTA_SUMMARY, model: null });
		mountStocks(api.backend, { route: { stockId: "jp:7203", tab: "company" }, locale: "ja" });
		const group = await summaryGroup();
		expect(within(group).getByRole("heading", { level: 4, name: "事業概要" })).toBeTruthy();
		const description = group.querySelector('[data-field="company-summary-description"]');
		expect(description?.textContent).toBe(TOYOTA_SUMMARY.description.ja);
		expect(description?.getAttribute("lang")).toBe("ja");
		const themes = within(group).getByRole("list", { name: "テーマ" });
		expect(
			within(themes)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["自動車", "ハイブリッド車"]);
		expect(group.querySelector('[data-field="company-summary-source"]')?.textContent).toBe(
			"AI（claude-code）が 2026年11月2日 に作成。誤りを含む場合があります。",
		);
	});
});

/**
 * Coca-Cola's company overview as stored (ADR-0064), cut down from the
 * entry Claude Haiku 5.5 wrote on 2026-11-03 from the stored 10-K.
 */
const KO_OVERVIEW: CompanyOverviewView = companyOverviewViewSchema.parse({
	entry: {
		feature: {
			en: "Total beverage company selling Coca-Cola, Sprite and Fanta in more than 200 countries.",
			ja: "Coca-Cola、Sprite、Fantaなどを展開する総合飲料会社。200以上の国・地域で販売。",
			evidence: [
				{
					source: "S2",
					quote: "now sold in more than 200 countries and territories",
				},
			],
		},
		businesses: [
			{
				en: "Sparkling soft drinks: Coca-Cola, Sprite, Fanta.",
				ja: "炭酸飲料。Coca-Cola、Sprite、Fanta",
				evidence: [
					{ source: "S2", quote: "including Coca-Cola, Sprite, Coca-Cola Zero Sugar, Fanta" },
				],
			},
			{
				en: "Concentrate is sold to bottling partners",
				ja: "原液をボトラーに販売。",
				evidence: [{ source: "S2", quote: "sell concentrates to our bottling partners" }],
			},
		],
		segments: [
			{
				name: { en: "North America", ja: "北米" },
				activity: {
					en: "Fountain syrups sold to fountain retailers.",
					ja: "ファウンテン用シロップを飲食店に販売",
				},
				salesSharePercent: null,
				marginPercent: null,
				evidence: [{ source: "S2", quote: "North America" }],
			},
			{
				name: { en: "Bottling Investments", ja: "ボトリング投資" },
				activity: null,
				salesSharePercent: 21,
				marginPercent: 4,
				evidence: [{ source: "S2", quote: "Bottling Investments 21% (4%)" }],
			},
			{
				// Only its own heading as evidence: not shown (トヨタ紡織's regions, 2026-11-04).
				name: { en: "Asia Pacific", ja: "アジア太平洋" },
				activity: null,
				salesSharePercent: null,
				marginPercent: null,
				evidence: [{ source: "S2", quote: "### Asia Pacific" }],
			},
		],
		overseasSales: null,
		profile: [
			{
				field: "founded",
				value: { en: "1919 (Delaware)", ja: "1919年(デラウェア州)" },
				evidence: [{ source: "S2", quote: "incorporated in September 1919" }],
			},
		],
		themes: [
			{
				label: { en: "Beverages", ja: "飲料" },
				reason: {
					en: "Sells beverages in more than 200 countries.",
					ja: "200超の国・地域で飲料を販売。",
					evidence: [{ source: "S2", quote: "more than 200 countries and territories" }],
				},
			},
		],
	},
	facts: {
		listing: "nyse",
		sector: null,
		fiscalYearEnd: "12-31",
		figures: [
			{
				metric: "revenue",
				fiscalYear: 2025,
				periodEnd: "2025-12-31",
				value: "47941000000",
				currency: "USD",
			},
			{
				metric: "operating-income",
				fiscalYear: 2025,
				periodEnd: "2025-12-31",
				value: "13762000000",
				currency: "USD",
			},
		],
		cites: { listing: "S1", sector: null, figures: "S3" },
	},
	references: [
		{
			id: "S1",
			title: { en: "SEC company tickers and exchanges", ja: "SEC 登録企業ティッカー一覧" },
			publisher: "U.S. SEC",
			asOf: null,
			url: "https://www.sec.gov/files/company_tickers_exchange.json",
			note: null,
		},
		{
			id: "S2",
			title: {
				en: "Form 10-K, Item 1. Business (fiscal year ended 2025-12-31)",
				ja: "Form 10-K 第1項「事業の内容」(2025-12-31 終了事業年度)",
			},
			publisher: "U.S. SEC EDGAR",
			asOf: "2025-12-31",
			url: "https://www.sec.gov/Archives/edgar/data/21344/000162828026010047/ko-20251231.htm",
			note: { en: "Filed 2026-02-20.", ja: "2026-02-20 提出。" },
		},
		{
			id: "S3",
			title: {
				en: "Form 10-K financial statements (fiscal year ended 2025-12-31)",
				ja: "Form 10-K 財務諸表(2025-12-31 終了事業年度)",
			},
			publisher: "U.S. SEC EDGAR (XBRL)",
			asOf: "2025-12-31",
			url: "https://www.sec.gov/Archives/edgar/data/21344/000162828026010047/ko-20251231.htm",
			note: null,
		},
	],
	agentId: "claude-api",
	model: "claude-haiku-5-5",
	generatedAt: "2026-11-02T23:25:47.705Z",
});

async function overviewOf(): Promise<HTMLElement> {
	return waitFor(() => {
		const overview = document.querySelector<HTMLElement>('[data-field="company-overview"]');
		if (overview === null) throw new Error("no overview yet");
		return overview;
	});
}

describe("Company tab: the company overview with evidence and references (ADR-0064)", () => {
	it("replaces the summary under 事業概要 with 四季報-style rows, each field marked with its source", async () => {
		api.summaryOf.set("us:KO", { ...TOYOTA_SUMMARY });
		api.overviewOf.set("us:KO", KO_OVERVIEW);
		mountStocks(api.backend, { route: { stockId: "us:KO", tab: "company" }, locale: "ja" });
		const overview = await overviewOf();
		const group = await summaryGroup();
		expect(within(group).getByRole("heading", { level: 4, name: "事業概要" })).toBeTruthy();
		// The overview replaces the ADR-0060 summary.
		expect(group.querySelector('[data-field="company-summary-description"]')).toBeNull();
		const labels = [...overview.querySelectorAll("dt")].map((term) => term.textContent);
		// Like 四季報, a row with nothing to show (here 【海外】) is left out.
		expect(labels).toEqual(["【特色】", "【事業内容】", "【連結事業】", "【テーマ】"]);
		expect(overview.textContent).not.toContain("記載なし");
		const rows = [...overview.querySelectorAll("dd")].map((field) => field.textContent);
		expect(rows[0]).toBe(`${KO_OVERVIEW.entry.feature?.ja}S2`);
		// 【事業内容】 is the summary of the business: one paragraph, a mark after each sentence.
		const businesses = overview.querySelector('[data-field="company-overview-businesses"]');
		expect(businesses?.tagName).toBe("P");
		expect(businesses?.textContent).toBe(
			"炭酸飲料。Coca-Cola、Sprite、Fanta。S2原液をボトラーに販売。S2",
		);
		// One segment a line: what it does when the sources say; a stated share and
		// margin read like 四季報's "79(4)"; a segment that is only its name is not listed.
		const segments = overview.querySelector<HTMLElement>(
			'[data-field="company-overview-segments"]',
		);
		if (segments === null) throw new Error("no segments");
		expect(
			within(segments)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["北米：ファウンテン用シロップを飲食店に販売S2", "ボトリング投資21(4)S2"]);
		const mark = overview.querySelector("sup");
		expect(mark?.textContent).toBe("S2");
		expect(mark?.getAttribute("title")).toBe("出典 S2");
	});

	it("shows the key facts table, the 出所 lines and the cited references in small text; no evidence list, no results", async () => {
		api.overviewOf.set("us:KO", KO_OVERVIEW);
		mountStocks(api.backend, { route: { stockId: "us:KO", tab: "company" }, locale: "ja" });
		const overview = await overviewOf();
		const facts = overview.querySelector<HTMLElement>('[data-field="company-overview-key-facts"]');
		if (facts === null) throw new Error("no key facts");
		const factRows = within(facts)
			.getAllByRole("row")
			.map((row) => row.textContent);
		expect(factRows).toEqual(["市場NYSES1", "決算期12月", "設立1919年(デラウェア州)S2"]);
		// The owner removed 業績 and 根拠 (2026-11-03): no figures, no quotes on the page.
		expect(within(overview).queryByText("業績")).toBeNull();
		expect(within(overview).queryByText("根拠(出典からの引用)")).toBeNull();
		expect(overview.querySelector("details")).toBeNull();
		expect(overview.textContent).not.toContain("47,941");
		expect(overview.textContent).not.toContain("incorporated in September 1919");
		const lines = [...overview.querySelectorAll('[data-field="company-overview-source-line"]')];
		expect(lines[0]?.textContent).toBe(
			"出所: S2 Form 10-K 第1項「事業の内容」(2025-12-31 終了事業年度)",
		);
		for (const line of lines) expect(line.className).toContain("text-xs");
		const references = overview.querySelector<HTMLElement>(
			'[data-field="company-overview-references"]',
		);
		if (references === null) throw new Error("no references");
		// S3 (the financial statements) backs only the figures, which the page no longer shows.
		const items = within(references).getAllByRole("listitem");
		expect(items.map((item) => item.textContent?.slice(0, 4))).toEqual(["[S1]", "[S2]"]);
		expect(items[1]?.textContent).toContain(
			"[S2] Form 10-K 第1項「事業の内容」(2025-12-31 終了事業年度)。U.S. SEC EDGAR",
		);
		expect(within(references).getAllByRole("link")[1]?.getAttribute("href")).toBe(
			KO_OVERVIEW.references[1]?.url,
		);
		expect(references.querySelector("ol")?.className).toContain("text-xs");
	});

	it("dates the overview by the browser's day and says it is AI-written, in English", async () => {
		api.overviewOf.set("us:KO", KO_OVERVIEW);
		mountStocks(api.backend, { route: { stockId: "us:KO", tab: "company" } });
		const overview = await overviewOf();
		expect([...overview.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([
			"Feature",
			"Businesses",
			"Segments",
			"Themes",
		]);
		const writtenBy = overview.querySelector('[data-field="company-overview-written-by"]');
		const localDay = new Date(KO_OVERVIEW.generatedAt).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
		expect(writtenBy?.textContent).toContain(
			`Written by AI (claude-api, claude-haiku-5-5) on ${localDay}`,
		);
		// The owner removed the check and 会社四季報 sentences (2026-11-03).
		expect(writtenBy?.textContent).toBe(
			`Written by AI (claude-api, claude-haiku-5-5) on ${localDay} from the sources above only. It may contain mistakes.`,
		);
	});
});
