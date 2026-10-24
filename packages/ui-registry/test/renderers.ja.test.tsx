import type { Locale } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	createBaselineUiRegistry,
	type RenderContext,
	type WorkspaceComponent,
	WorkspaceComponentView,
} from "../src/index.ts";
import { component, makeContext, VALID_PROPS } from "./fixtures.ts";

afterEach(cleanup);

const REGISTRY = createBaselineUiRegistry();

/** Renders one workspace component with the UI language set to `locale`. */
function renderIn(
	locale: () => Locale,
	workspaceComponent: WorkspaceComponent,
	contextOverrides: Partial<RenderContext> = {},
): HTMLElement {
	const context = makeContext(contextOverrides);
	return render(() => (
		<LocaleProvider locale={locale}>
			<WorkspaceComponentView
				component={workspaceComponent}
				context={context}
				registry={REGISTRY}
			/>
		</LocaleProvider>
	)).container;
}

const ja = (): Locale => "ja";

describe("registry components in Japanese (ADR-0032)", () => {
	it("words a research report's badges, notes and dates, and keeps the agent's text", () => {
		const container = renderIn(ja, component("research-report", VALID_PROPS["research-report"]));
		const text = container.textContent ?? "";
		// The registry's own words.
		expect(text).toContain("観察");
		expect(text).toContain("裏付けあり");
		expect(text).toContain("根拠が矛盾");
		expect(text).toContain("未検証のメモ — 保存された根拠と照合していません");
		expect(text).toContain("作成日 2026-10-05");
		expect(text).toContain("この記述には出典がありません。");
		// The agent's words are research content and stay as written.
		expect(text).toContain("Utility tenders rose year over year.");
		expect(text).toContain("Demand drivers");
		// Accessible names: the component and a numbered citation chip.
		expect(container.querySelector("article")?.getAttribute("aria-label")).toBe(
			"コンポーネント research_report_1",
		);
		const chip = container.querySelector("[data-citation-chip]");
		expect(chip?.getAttribute("aria-label")).toBe("出典 1：Grid storage outlook 2026");
	});

	it("labels the source card's dates and link in Japanese", () => {
		const container = renderIn(ja, component("research-report", VALID_PROPS["research-report"]));
		const chip = container.querySelector<HTMLButtonElement>("[data-citation-chip]");
		if (chip === null) throw new Error("no citation chip");
		fireEvent.click(chip);
		const card = container.querySelector("[data-citation-card]");
		expect(card?.textContent).toContain("公開日 2026-09-01");
		expect(card?.textContent).toContain("取得日 2026-10-01");
		expect(card?.textContent).toContain("情報源を開く");
	});

	it("words a data table's selection, markers and a data reason", () => {
		const container = renderIn(ja, component("data-table", VALID_PROPS["data-table"]));
		const text = container.textContent ?? "";
		expect(container.querySelector("thead th")?.textContent).toBe("選択");
		expect(text).toContain("仮定");
		expect(text).toContain("算出値");
		expect(text).toContain("2026-06-30 時点");
		// The dataset's own reason is content: only the frame around it is translated.
		expect(text).toContain("取得できません（not yet published）");
		expect(container.querySelector("tbody button")?.getAttribute("aria-label")).toBe(
			"1 行目を選択",
		);
		expect(text).toContain("出典 1 件");
	});

	it("words the registry's own withheld-value reason and the position caveats", () => {
		const container = renderIn(
			ja,
			component("financial-table", {
				...VALID_PROPS["financial-table"],
				datasetRef: "ds_positions",
			}),
		);
		const text = container.textContent ?? "";
		expect(text).toContain(
			"取得できません（表示しません：米国には銘柄別の信用買い残がありません）",
		);
		expect(text).toContain("信用取引残高（日本）：");
		expect(text).toContain("米国の空売り残高：");
		expect(text).toContain("算出方法：");
	});

	it("describes a chart and its unplotted points in Japanese", () => {
		const container = renderIn(ja, component("line-chart", VALID_PROPS["line-chart"]));
		const svg = container.querySelector("svg[role='img']");
		expect(svg?.getAttribute("aria-label")).toBe(
			"折れ線グラフ：Demand trajectory。Installed demand (GWh)（Year別）。系列：Base case、Bull case。",
		);
		const text = container.textContent ?? "";
		expect(text).toContain("2 点を取得できないため描画していません");
		expect(text).toContain("チャートにポインタを合わせると値を表示します。");
		expect(text).toContain("データ表：Demand trajectory");
		expect(container.querySelector("caption")?.textContent).toBe(
			"「Demand trajectory」に描画した値",
		);
	});

	it("words the candlestick chart's legend and axis", () => {
		const container = renderIn(
			ja,
			component("candlestick-chart", VALID_PROPS["candlestick-chart"]),
		);
		expect(container.querySelector("ul")?.getAttribute("aria-label")).toBe("凡例");
		const text = container.textContent ?? "";
		expect(text).toContain("終値が始値以上");
		expect(text).toContain("価格（JPY）");
	});

	it("explains a component it cannot render", () => {
		const container = renderIn(ja, component("crystal-ball", {}));
		expect(container.querySelector("[data-fallback]")?.textContent).toBe(
			"表示できません：不明なコンポーネント種別（コンポーネント種別「crystal-ball」、スキーマバージョン 1）。",
		);
	});

	it("follows a language change in place", () => {
		const [locale, setLocale] = createSignal<Locale>("en");
		const container = renderIn(
			locale,
			component("company-profile", VALID_PROPS["company-profile"]),
		);
		expect(container.querySelector("dt")?.textContent).toBe("Ticker");
		expect(container.querySelector("[data-field='country']")?.textContent).toBe("Japan");
		setLocale("ja");
		expect(container.querySelector("dt")?.textContent).toBe("ティッカー");
		expect(container.querySelector("[data-field='country']")?.textContent).toBe("日本");
		// The company's own words stay as written.
		expect(container.textContent).toContain("Grid-scale inverters");
	});
});
