import type { MarketSeries } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { HomeView } from "../src/home/HomeView.tsx";
import { ResetDialog } from "../src/home/ResetDialog.tsx";
import { EarningsMonthCalendar } from "../src/home/widgets/EarningsMonthCalendar.tsx";
import { LineChartWidget } from "../src/home/widgets/LineChartWidget.tsx";
import { MetricWidget } from "../src/home/widgets/MetricWidget.tsx";
import { StockTableWidget } from "../src/home/widgets/StockTableWidget.tsx";
import {
	initialHomeServerState,
	initialServerState,
	initialWatchlistServerState,
	installHomeRoutes,
	installWatchlistRoutes,
} from "./appHarness.tsx";
import { createControllableVisibility, createFakeBackend } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/** Renders `ui` with the UI language fixed to Japanese. */
function renderJa(ui: () => JSX.Element) {
	return render(() => <LocaleProvider locale={() => "ja"}>{ui()}</LocaleProvider>);
}

function vix(observations: readonly (readonly [string, number])[]): MarketSeries {
	return {
		seriesId: "fred:VIXCLS",
		provider: "fred",
		symbol: "VIXCLS",
		title: "CBOE Volatility Index: VIX",
		unit: "Index",
		frequency: "daily",
		publisher: "Federal Reserve Bank of St. Louis",
		sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		observations: observations.map(([date, value]) => [date, value] as [string, number]),
	};
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
	resetGlobalFetchCalls();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("Home in Japanese", () => {
	it("words the page, its toolbar and its status line in Japanese", async () => {
		const backend = createFakeBackend();
		const home = initialHomeServerState(false);
		home.lastSucceededAt = "2026-10-12T11:50:00Z";
		installHomeRoutes(backend, initialServerState(), home);
		installWatchlistRoutes(backend, initialWatchlistServerState());
		const api = createApiClient({ fetch: backend.fetch });
		renderJa(() => <HomeView api={api} visibility={createControllableVisibility()} />);

		const page = screen.getByRole("region", { name: "ホームのウィジェット" });
		expect(within(page).getByRole("button", { name: "市場データを更新" })).toBeTruthy();
		expect(within(page).getByRole("button", { name: "既定の配置に戻す" })).toBeTruthy();
		await waitFor(() =>
			expect(document.querySelector('[data-field="home-status"]')?.textContent).toMatch(
				/^前回の更新成功：.+。$/,
			),
		);
		expect(screen.getByText(/^前回比は最新の観測値を一つ前の観測値と比べます。/)).toBeTruthy();
		// The FRED attribution keeps the exact wording FRED's terms require.
		expect(screen.getByText(/^This product uses the FRED® API/)).toBeTruthy();
	});

	it("confirms a reset in Japanese", () => {
		renderJa(() => <ResetDialog open opener={null} onConfirm={() => {}} onClose={() => {}} />);
		const dialog = document.querySelector("sl-dialog");
		expect(dialog?.getAttribute("label")).toBe("既定の配置に戻す");
		expect(screen.getByRole("button", { name: "キャンセル" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "既定に戻す" })).toBeTruthy();
	});
});

describe("Home market widgets in Japanese", () => {
	it("labels a metric's change lines and names its chart opener", () => {
		const series = vix([
			["2026-10-08", 15.08],
			["2026-10-09", 15.41],
		]);
		renderJa(() => (
			<MetricWidget
				widget={{
					widgetId: "w-vix",
					type: "market-metric",
					title: "VIX",
					size: "small",
					seriesId: series.seriesId,
				}}
				seriesById={() => new Map([[series.seriesId, series]])}
			/>
		));
		const opener = screen.getByRole("button", {
			name: /^チャートを開く：CBOE Volatility Index: VIX、/,
		});
		expect(opener.textContent).toContain("前回比：");
		expect(opener.textContent).toContain("1年前比：");
		// Up, said in words beside the ▲ mark; the numbers keep their notation.
		expect(opener.textContent).toContain("▲ +0.33 (+2.19%) (上昇)");
		expect(opener.textContent).toContain("取得できません（履歴が不足）");
		expect(screen.getByText(/^取得日時 /)).toBeTruthy();
	});

	it("words a stock table's headers and a missing series' reason by its code", () => {
		const missing: MarketSeries = {
			...vix([]),
			seriesId: "twelve-data:AAPL",
			provider: "twelve-data",
			symbol: "AAPL",
			title: "Apple Inc",
			unit: "USD",
			unavailable: {
				code: "SOURCE_NOT_CONFIGURED",
				upstreamStatus: null,
				reason:
					"The Twelve Data source is not configured; set TWELVE_DATA_API_KEY in apps/runner/.env.",
			},
		};
		renderJa(() => (
			<StockTableWidget
				widget={{
					widgetId: "w-stocks",
					type: "stock-table",
					title: "Stocks",
					size: "medium",
					seriesIds: [missing.seriesId],
				}}
				seriesById={() => new Map([[missing.seriesId, missing]])}
			/>
		));
		const table = screen.getByRole("table");
		expect(table.querySelector("caption")?.textContent).toBe("Stocks：系列ごとの直近の終値");
		expect(within(table).getByRole("columnheader", { name: "終値" })).toBeTruthy();
		expect(within(table).getByRole("columnheader", { name: "時点" })).toBeTruthy();
		expect(table.textContent).toContain(
			"取得できません（Twelve Data のデータソースが設定されていません。apps/runner/.env に TWELVE_DATA_API_KEY を設定してください。）",
		);
	});

	it("adds the provider's answer status to a missing series' reason in Japanese", () => {
		const limited: MarketSeries = {
			...vix([]),
			seriesId: "twelve-data:AAPL",
			provider: "twelve-data",
			symbol: "AAPL",
			title: "Apple Inc",
			unit: "USD",
			unavailable: {
				code: "RATE_LIMITED",
				upstreamStatus: 429,
				reason: "The provider rate limit was reached.",
			},
		};
		renderJa(() => (
			<StockTableWidget
				widget={{
					widgetId: "w-stocks",
					type: "stock-table",
					title: "Stocks",
					size: "medium",
					seriesIds: [limited.seriesId],
				}}
				seriesById={() => new Map([[limited.seriesId, limited]])}
			/>
		));
		expect(screen.getByRole("table").textContent).toContain(
			"取得できません（プロバイダーのレート制限に達しました。しばらくしてから再試行してください。サービスの応答は HTTP 429 でした。）",
		);
	});

	it("names a line chart's range in Japanese", () => {
		const series = vix([
			["2026-10-08", 15.08],
			["2026-10-09", 15.41],
		]);
		renderJa(() => (
			<LineChartWidget
				widget={{
					widgetId: "w-chart",
					type: "line-chart",
					title: "Volatility",
					size: "large",
					seriesIds: [series.seriesId],
					range: "1y",
				}}
				seriesById={() => new Map([[series.seriesId, series]])}
				onSaveRange={() => {}}
			/>
		));
		expect(document.querySelector('sl-select[label="期間"]')).not.toBeNull();
		expect(screen.getByText("過去1年")).toBeTruthy();
		expect(
			screen.getByRole("img", { name: "折れ線チャート：Volatility。日付ごとのIndex。" }),
		).toBeTruthy();
		expect(screen.getByText("データ表：Volatility")).toBeTruthy();
	});

	it("names weekdays, the month and each announcement day in Japanese", () => {
		renderJa(() => (
			<EarningsMonthCalendar
				today="2026-11-02"
				events={[
					{
						stockId: "us:AAPL",
						announcementDate: "2026-11-05",
						symbol: "AAPL",
						name: "Apple Inc",
						fiscalPeriodLabel: "Q4 2026",
						timing: "after-close",
						periodKey: "2026-q4",
						fiscalPeriodEnd: null,
						publisher: "Finnhub",
						sourceUrl: "https://finnhub.io/",
						retrievedAt: null,
					},
				]}
			/>
		));
		const headers = screen.getAllByRole("columnheader");
		expect(headers.map((header) => header.textContent)).toEqual([
			"日",
			"月",
			"火",
			"水",
			"木",
			"金",
			"土",
		]);
		expect(headers[0]?.querySelector("abbr")?.getAttribute("title")).toBe("日曜日");
		expect(screen.getByText("2026年11月")).toBeTruthy();
		expect(screen.getByRole("button", { name: "前の月" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "2026年11月5日：1件の発表、AAPL" })).toBeTruthy();
	});
});
