import type { MarketSeries } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChartViewer } from "../src/chartViewer/ChartViewer.tsx";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

function vixSeries(): MarketSeries {
	return {
		seriesId: "fred:VIXCLS",
		provider: "fred",
		symbol: "VIXCLS",
		title: "CBOE Volatility Index: VIX",
		unit: "Index",
		frequency: "daily",
		publisher: "Test Publisher",
		sourceUrl: "https://example.com/series",
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		observations: [
			["2026-10-06", 15.01],
			["2026-10-07", 15.08],
			["2026-10-08", 15.41],
		],
	};
}

beforeEach(() => {
	resetGlobalFetchCalls();
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

describe("chart viewer in Japanese", () => {
	it("words the controls, the chart's instructions and the captions; series names and dates stay", () => {
		const [series] = createSignal<readonly MarketSeries[]>([vixSeries()]);
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<ChartViewer
					open
					title="VIX chart"
					series={series}
					initialPreset="max"
					onClose={() => {}}
				/>
			</LocaleProvider>
		));
		expect(screen.getByRole("button", { name: "1か月" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "最大" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByLabelText("開始日")).toBeTruthy();
		expect(document.querySelector('sl-select[label="間隔"]')).not.toBeNull();
		expect(document.querySelector('[data-field="auto-interval"]')?.textContent?.trim()).toBe(
			"自動 · 日次",
		);

		const chart = document.querySelector('svg[aria-roledescription="操作できるチャート"]');
		expect(chart).not.toBeNull();
		const instructionsId = chart?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(instructionsId)?.textContent).toContain(
			"左右の矢印キーで読み取り位置を 1 本ずつ動かします。",
		);
		expect(document.querySelector('[data-chart-part="readout"]')?.textContent).toBe(
			"チャートを指すと値を読み取れます。下のデータ表にすべての値があります。",
		);

		expect(screen.getByRole("region", { name: "表示範囲の統計" }).textContent).toContain(
			"表示範囲の統計（日足）",
		);
		expect(document.body.textContent).toContain("データ表: VIX chart");
		// The series name, value and date are data: shown as they are.
		expect(document.body.textContent).toContain("CBOE Volatility Index: VIX");
		expect(document.body.textContent).toContain("2026-10-08 時点");
	});

	it("words the chart type, the candle readout, the volume and the close-only note (ADR-0056)", () => {
		const bars: MarketSeries = {
			...vixSeries(),
			seriesId: "twelve-data:7203",
			provider: "twelve-data",
			title: "7203",
			unit: "JPY",
			observations: [
				["2026-10-06", 3000, [2950, 3010, 2940, 1_200_000]],
				["2026-10-07", 2980],
				["2026-10-08", 2900, [2980, 2990, 2890, 2_400_000]],
			],
		};
		const [series] = createSignal<readonly MarketSeries[]>([bars]);
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<ChartViewer
					open
					title="トヨタ"
					series={series}
					initialPreset="max"
					initialChartType="candlestick"
					onClose={() => {}}
				/>
			</LocaleProvider>
		));
		const select = document.querySelector('sl-select[label="チャートの種類"]');
		expect(select).not.toBeNull();
		const options = [...(select?.querySelectorAll("sl-option") ?? [])].map(
			(option) => option.textContent,
		);
		expect(options).toEqual(["ライン", "ローソク足"]);
		const chart = document.querySelector('svg[aria-roledescription="操作できるチャート"]');
		if (!(chart instanceof SVGSVGElement)) throw new Error("no chart");
		expect(chart.getAttribute("aria-label")).toBe("ローソク足チャート: トヨタ");
		expect(document.querySelector('[data-chart-part="candle-legend"]')?.textContent).toBe(
			"上昇下落",
		);
		expect(document.querySelector('[data-field="close-only-bars"]')?.textContent).toBe(
			"終値だけの足があります — その始値・高値・安値は分かりません。",
		);
		expect(document.querySelector('g[data-chart-part="volume"]')?.textContent).toContain("万");
		chart.focus();
		fireEvent.keyDown(chart, { key: "Home" });
		expect(document.querySelector('[data-chart-part="readout"]')?.textContent).toBe(
			"2026-10-06 — 7203: 始値 2,950 · 高値 3,010 · 安値 2,940 · 終値 3,000 JPY · 出来高 120万 · 陽線（上昇）",
		);
		fireEvent.keyDown(chart, { key: "End" });
		expect(document.querySelector('[data-chart-part="readout"]')?.textContent).toContain(
			"出来高 240万 · 陰線（下落）",
		);
	});
});
