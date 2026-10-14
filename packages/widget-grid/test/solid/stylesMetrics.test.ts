import { describe, expect, it } from "vitest";
import { WIDGET_GRID_METRICS, WIDGET_SIZE_SPANS } from "../../src/core/sizes.ts";
import css from "../../src/solid/styles.css?raw";

/** First `repeat(N, …)` column count in the grid rule and in the wide media rule. */
function narrowAndWideColumns(text: string): { narrow: number; wide: number } {
	const repeats = [...text.matchAll(/grid-template-columns:\s*repeat\((\d+),/g)].map((match) =>
		Number(match[1]),
	);
	if (repeats.length < 2) throw new Error("expected a base grid and a wide grid column rule");
	return { narrow: repeats[0] ?? 0, wide: repeats[repeats.length - 1] ?? 0 };
}

function wideBreakpointRem(text: string): number {
	const match = /@media\s*\(\s*min-width:\s*([\d.]+)rem\s*\)/.exec(text);
	if (match === null) throw new Error("expected a min-width media query in rem");
	return Number(match[1]);
}

function containerBreakpointRem(text: string): number {
	const match = /@container\s*\(\s*min-width:\s*([\d.]+)rem\s*\)/.exec(text);
	if (match === null) throw new Error("expected a min-width container query in rem");
	return Number(match[1]);
}

function singleRem(text: string, property: string): number {
	const match = new RegExp(`${property}:\\s*(?:var\\([^,]+,\\s*)?([\\d.]+)rem`).exec(text);
	if (match === null) throw new Error(`expected ${property} in rem`);
	return Number(match[1]);
}

function gapRem(text: string): number {
	const match = /(?:^|\s)gap:\s*(?:var\([^,]+,\s*)?([\d.]+)rem/m.exec(text);
	if (match === null) throw new Error("expected gap in rem");
	return Number(match[1]);
}

/** Grid spans for one size: narrow rule plus, for large, the wide override. */
function spansFor(
	text: string,
	size: string,
): { narrow: [number, number]; wide: [number, number] } {
	const block = new RegExp(
		`\\.wg-frame\\[data-widget-size="${size}"\\][\\s\\S]*?grid-column:\\s*span\\s*(\\d+);[\\s\\S]*?grid-row:\\s*span\\s*(\\d+);`,
		"g",
	);
	const found = [...text.matchAll(block)].map(
		(match) => [Number(match[1]), Number(match[2])] as [number, number],
	);
	if (found.length === 0) throw new Error(`expected a span rule for ${size}`);
	const narrow = found[0] ?? [0, 0];
	const wide = found.length > 1 ? (found[found.length - 1] ?? narrow) : narrow;
	return { narrow, wide };
}

describe("stylesheet metrics match core/sizes.ts", () => {
	it("uses the same column counts, breakpoint, row height and gap", () => {
		const columns = narrowAndWideColumns(css);
		expect(columns.narrow).toBe(WIDGET_GRID_METRICS.narrowColumns);
		expect(columns.wide).toBe(WIDGET_GRID_METRICS.wideColumns);
		expect(wideBreakpointRem(css)).toBe(WIDGET_GRID_METRICS.wideMinWidthRem);
		expect(singleRem(css, "grid-auto-rows")).toBe(WIDGET_GRID_METRICS.rowHeightRem);
		expect(gapRem(css)).toBe(WIDGET_GRID_METRICS.gapRem);
	});

	it("spans the same cells per size, narrow and wide", () => {
		for (const size of ["small", "medium", "large"] as const) {
			const spans = spansFor(css, size);
			expect(spans.narrow).toEqual([
				WIDGET_SIZE_SPANS[size].narrow.columns,
				WIDGET_SIZE_SPANS[size].narrow.rows,
			]);
			expect(spans.wide).toEqual([
				WIDGET_SIZE_SPANS[size].wide.columns,
				WIDGET_SIZE_SPANS[size].wide.rows,
			]);
		}
	});

	it("applies the same span rule to the drag placeholder", () => {
		for (const size of ["small", "medium", "large"] as const) {
			const pattern = new RegExp(`\\.wg-placeholder\\[data-widget-size="${size}"\\]`);
			expect(pattern.test(css)).toBe(true);
		}
	});

	it("uses the container breakpoint for container-sized columns", () => {
		expect(containerBreakpointRem(css)).toBe(WIDGET_GRID_METRICS.containerWideMinWidthRem);
		expect(css).toMatch(/\.wg-grid-container\s*\{[^}]*container-type:\s*inline-size/);
		expect(css).toContain(".wg-grid-container");
	});

	it("themes the quiet variant and selection through custom properties", () => {
		expect(css).toContain("--wg-border-hover");
		expect(css).toContain("--wg-selected");
		expect(css).toContain('[data-widget-variant="quiet"]');
		expect(css).toContain("[data-widget-selected]");
		// The viewport breakpoint never restyles a container-sized grid.
		expect(css).toContain(':not([data-widget-columns-from="container"])');
		// The quiet reveal stays in the accessibility tree and honours motion
		// and hover capabilities.
		expect(css).toMatch(/prefers-reduced-motion/);
		expect(css).toMatch(/@media\s*\(\s*hover:\s*none\s*\)/);
	});

	it("never uses dense flow", () => {
		expect(css).not.toMatch(/grid-auto-flow:\s*dense/);
		expect(css).toMatch(/grid-auto-flow:\s*row/);
	});
});
