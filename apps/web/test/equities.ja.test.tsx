import { catalogProblems } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { equitiesMessages } from "../src/equities/equities.messages.ts";
import { FINANCIAL_FRESH_MS } from "../src/equities/financialStore.ts";
import { financialsMessages } from "../src/equities/financials.messages.ts";
import { unitCaption } from "../src/equities/StatementTable.tsx";
import { pageMessages } from "../src/pages.messages.ts";
import { stocksMessages } from "../src/stocks/stocks.messages.ts";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import { widgetTypeMessages } from "../src/widgets/widgetTypes.messages.ts";
import {
	APPLE_ID,
	createEquitiesServer,
	makeCompany,
	NINTENDO,
	NINTENDO_ID,
	nintendoSynced,
} from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";
import { createStocksBackend, mountStocks } from "./stocksHarness.tsx";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-31T10:00:00Z"));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("financial statements in Japanese (ADR-0032, ADR-0048)", () => {
	it("has whole catalogs and names the page and both widget types", () => {
		expect(catalogProblems(financialsMessages)).toEqual([]);
		expect(catalogProblems(stocksMessages)).toEqual([]);
		expect(catalogProblems(equitiesMessages)).toEqual([]);
		expect(pageMessages.ja.title("registered")).toBe("登録済みの銘柄");
		expect(pageMessages.ja.title("stocks")).toBe("株式データ");
		expect(widgetTypeMessages.ja.typeLabel("financial-statement")).toBe("財務諸表");
		expect(widgetTypeMessages.ja.typeLabel("financial-history")).toBe("財務推移");
		expect(unitCaption("JPY", financialsMessages.ja)).toBe("百万円");
		expect(unitCaption("USD", financialsMessages.ja)).toBe("百万米ドル");
		expect(unitCaption("USD", financialsMessages.en)).toBe("USD millions");
		expect(financialsMessages.ja.metric("ordinary-income")).toBe("経常利益");
		expect(financialsMessages.ja.metric("profit-attributable-to-owners")).toBe(
			"親会社株主に帰属する当期純利益",
		);
		expect(financialsMessages.ja.reason("not-reported")).toBe("開示なし");
	});

	it("renders the statement widget in Japanese", async () => {
		const server = createEquitiesServer();
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<WidgetBody
					widget={{
						widgetId: "w-fs",
						type: "financial-statement",
						companyId: APPLE_ID,
						statement: "income-statement",
						years: 5,
						title: "Apple Inc. (AAPL)",
						size: "large",
					}}
					view={null}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
					market={null}
					editingDisabled={false}
					onSaveText={async () => true}
					onSaveMarketWidget={() => {}}
					onSaveWidget={async () => true}
				/>
			</LocaleProvider>
		));
		const table = await waitFor(() => {
			const element = document.querySelector("table[data-statement]");
			if (!(element instanceof HTMLTableElement)) throw new Error("no table yet");
			return element;
		});
		expect(table.caption?.textContent).toBe("損益計算書（百万米ドル）");
		expect(table.querySelector('tr[data-metric="revenue"] th')?.textContent).toBe("売上高");
		expect(table.querySelector('tr[data-metric="ordinary-income"] td')?.textContent).toBe(
			"開示なし",
		);
		expect(table.querySelector("thead th:last-child")?.textContent).toContain("2024年9月28日");
		expect(document.body.textContent).toContain("Apple Inc.（AAPL）");
		expect(document.body.textContent).toContain("直近の決算期末: 2024年9月28日");
		const control = document.querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no switch");
		expect(
			within(control)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["損益", "貸借", "CF"]);
	});

	it("renders a Japanese company's statement in 百万円, a separate-only profit as 当期純利益", async () => {
		const server = createEquitiesServer({ companies: [nintendoSynced()] });
		const widget = {
			widgetId: "w-fs",
			type: "financial-statement",
			companyId: NINTENDO_ID,
			statement: "income-statement",
			years: 5,
			title: "任天堂株式会社 (7974)",
			size: "large",
		} as const;
		const mount = () =>
			render(() => (
				<LocaleProvider locale={() => "ja"}>
					<WidgetBody
						widget={widget}
						view={null}
						api={server.api}
						visibility={ALWAYS_VISIBLE}
						market={null}
						editingDisabled={false}
						onSaveText={async () => true}
						onSaveMarketWidget={() => {}}
						onSaveWidget={async () => true}
					/>
				</LocaleProvider>
			));
		const shownTable = () =>
			waitFor(() => {
				const element = document.querySelector("table[data-statement]");
				if (!(element instanceof HTMLTableElement)) throw new Error("no table yet");
				return element;
			});
		mount();
		const table = await shownTable();
		expect(table.caption?.textContent).toBe("損益計算書（百万円）");
		expect(
			table.querySelector('tr[data-metric="revenue"] td[data-fiscal-year="2025"]')?.textContent,
		).toBe("1,164,922");
		expect(table.querySelector('tr[data-metric="ordinary-income"] th')?.textContent).toBe(
			"経常利益",
		);
		expect(
			table.querySelector('tr[data-metric="profit-attributable-to-owners"] th')?.textContent,
		).toBe("親会社株主に帰属する当期純利益");
		expect(document.body.textContent).toContain("直近の決算期末: 2025年3月31日");
		// J-Quants' coverage and the earnings summaries as sources, in Japanese (ADR-0059 §2).
		expect(document.querySelector('[data-field="jquants-note"]')?.textContent).toBe(
			"日本企業の値は J-Quants（Free プラン）の通期の決算短信から取得します。直近の約 2 会計年度分で、約 12 週間遅れです。売上総利益・負債合計・設備投資・フリー・キャッシュ・フローは提供されません。",
		);
		const sources = [...document.querySelectorAll('[data-field="widget-footer"] a')];
		expect(sources[0]?.textContent).toBe("決算短信（2025-05-08 開示・J-Quants のデータ）");
		expect(sources[0]?.getAttribute("aria-label")).toBe(
			"2025-05-08 開示の決算短信の J-Quants のデータを開く（J-Quants の API キーが必要）",
		);
		expect(sources.map((link) => link.textContent)).toContain(
			"決算短信（訂正）（2024-06-10 開示・J-Quants のデータ）",
		);
		cleanup();

		// A later sync stored separate-only values (a new ETag).
		server.japaneseScope = () => "separate";
		server.revision += 1;
		const reads = () => server.requests("GET", /\/statements\/income-statement/).length;
		expect(reads()).toBe(1);
		// Shown again within the fresh window: the kept answer, no request.
		mount();
		expect(
			(await shownTable()).querySelector('tr[data-metric="profit-attributable-to-owners"] th')
				?.textContent,
		).toBe("親会社株主に帰属する当期純利益");
		expect(reads()).toBe(1);
		cleanup();
		// After the window the next showing re-reads conditionally and gets the new values.
		const later = Date.now() + FINANCIAL_FRESH_MS + 1;
		vi.spyOn(Date, "now").mockReturnValue(later);
		mount();
		await waitFor(() =>
			expect(
				document.querySelector('tr[data-metric="profit-attributable-to-owners"] th')?.textContent,
			).toBe("当期純利益（個別）"),
		);
		const requests = server.requests("GET", /\/statements\/income-statement/);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.headers["if-none-match"]).toBeDefined();
	});

	it("renders the Stocks page and its tabs in Japanese", async () => {
		const api = createStocksBackend({ companies: [makeCompany(), NINTENDO()] });
		api.server.stocks = [];
		mountStocks(api.backend, { locale: "ja", route: { stockId: "jp:7974", tab: "financials" } });
		// The detail: 「任天堂株式会社 · 7974」 and the four tabs in Japanese.
		expect(await screen.findByRole("heading", { name: "任天堂株式会社 · 7974" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "別の銘柄を選ぶ" }).getAttribute("href")).toBe(
			"#/registered",
		);
		const strip = screen.getByRole("tablist", { name: "任天堂株式会社 のデータ" });
		expect(
			within(strip)
				.getAllByRole("tab")
				.map((tab) => tab.textContent),
		).toEqual(["チャート", "財務諸表", "企業情報", "ニュース"]);
		// Nintendo's company is tracked with nothing stored yet: on the way (ADR-0058 §6).
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-none"]')?.textContent).toContain(
				"この銘柄の財務諸表はまだ保存されていません。サーバーは上場しているすべての銘柄の財務諸表を取得します。",
			),
		);
		// No sync line, not even for Nintendo's failed sync (ADR-0055 §4).
		expect(document.querySelector('[data-field="stock-financials-tab"]')?.textContent).not.toMatch(
			/同期|JQUANTS_API_KEY/,
		);
		expect(document.querySelector('[data-field="financials-none"]')?.textContent).toContain(
			"出典: SEC EDGAR（米国）または J-Quants の決算短信（日本）。",
		);
		// The server syncs the statements (ADR-0054): no Sync now.
		expect(screen.queryByRole("button", { name: "任天堂株式会社 を今すぐ同期" })).toBeNull();
		// The Company tab in Japanese.
		fireEvent.click(within(strip).getByRole("tab", { name: "企業情報" }));
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-listing"]')?.textContent).toContain(
				"上場情報",
			),
		);
	});
});
