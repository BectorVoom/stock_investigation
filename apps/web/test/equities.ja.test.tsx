import { catalogProblems } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EquitiesView } from "../src/equities/EquitiesView.tsx";
import { equitiesMessages } from "../src/equities/equities.messages.ts";
import { financialsMessages } from "../src/equities/financials.messages.ts";
import { unitCaption } from "../src/equities/StatementTable.tsx";
import { pageMessages } from "../src/pages.messages.ts";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import { widgetTypeMessages } from "../src/widgets/widgetTypes.messages.ts";
import { APPLE_ID, createEquitiesServer, NINTENDO_ID } from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE, jsonResponse } from "./fakeBackend.ts";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-31T10:00:00Z"));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("financial statements in Japanese (ADR-0032, ADR-0045)", () => {
	it("has whole catalogs and names the page and both widget types", () => {
		expect(catalogProblems(financialsMessages)).toEqual([]);
		expect(catalogProblems(equitiesMessages)).toEqual([]);
		expect(pageMessages.ja.title("equities")).toBe("株式データ");
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

	it("renders the Equities page in Japanese, naming the variable to set", async () => {
		const server = createEquitiesServer();
		server.backend.on("GET", /^\/api\/v1\/watchlist\/directory$/, () =>
			jsonResponse({ error: { code: "INTERNAL", message: "x" } }, { status: 500 }),
		);
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<EquitiesView api={server.api} visibility={ALWAYS_VISIBLE} />
			</LocaleProvider>
		));
		const row = await waitFor(() => {
			const element = document.querySelector(`tr[data-company-id="${NINTENDO_ID}"]`);
			if (!(element instanceof HTMLElement)) throw new Error("no row yet");
			return element;
		});
		expect(row.textContent).toContain("日本");
		expect(row.textContent).toContain("EDINET コード");
		expect(row.querySelector('[data-field="sync-failure"]')?.textContent).toContain(
			"未設定: apps/runner/.env に EDINET_API_KEY を設定し、ランナーを再起動してください。",
		);
		const apple = document.querySelector(`tr[data-company-id="${APPLE_ID}"]`);
		expect(apple?.querySelector('[data-field="sync-status"]')?.textContent).toBe(
			"同期済み · 最終同期 2 時間前",
		);
		expect(screen.getByText("20 社中 2 社")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Apple Inc. を今すぐ同期" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "任天堂株式会社 の追跡を停止" }));
		expect(
			await screen.findByRole("dialog", { name: "任天堂株式会社 の追跡を停止しますか?" }),
		).toBeTruthy();
	});
});
