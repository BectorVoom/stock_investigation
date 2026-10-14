import { describe, expect, it } from "vitest";
import css from "../../src/solid/styles.css?raw";

/**
 * The untitled-frame overlay contract (ADR-0021): the titleHidden header is
 * pinned to the top edge, only its controls take pointer events, and the
 * grip keeps a 28 px hit target. Read as text like stylesMetrics does, so
 * the stylesheet and the contract cannot drift.
 */
describe("titleHidden overlay stylesheet", () => {
	it("pins the header to the top edge of a relatively positioned frame", () => {
		expect(css).toMatch(/\.wg-frame\[data-widget-title-hidden\]\s*\{[^}]*position:\s*relative/);
		expect(css).toMatch(
			/\.wg-frame\[data-widget-title-hidden\]\s+\.wg-header\s*\{[^}]*position:\s*absolute/,
		);
	});

	it("lets clicks pass through the overlay except on the controls", () => {
		expect(css).toMatch(
			/\.wg-frame\[data-widget-title-hidden\]\s+\.wg-header\s*\{[^}]*pointer-events:\s*none/,
		);
		for (const control of ["wg-grip", "wg-select-toggle", "wg-header-actions"]) {
			expect(css).toContain(`.wg-frame[data-widget-title-hidden] .${control}`);
		}
		expect(css).toMatch(/\.wg-frame\[data-widget-title-hidden\][\s\S]*?pointer-events:\s*auto/);
	});

	it("gives the controls the frame surface, rounded, with no shadow", () => {
		expect(css).toMatch(
			/\.wg-frame\[data-widget-title-hidden\][\s\S]*?background-color:\s*var\(--wg-surface/,
		);
		expect(css).toMatch(/\.wg-frame\[data-widget-title-hidden\][\s\S]*?border-radius:\s*0\.5rem/);
		const blocks = [...css.matchAll(/[^{}]*data-widget-title-hidden[^{}]*\{[^}]*\}/g)].map(
			(match) => match[0],
		);
		expect(blocks.length).toBeGreaterThan(0);
		for (const block of blocks) expect(block).not.toContain("box-shadow");
	});

	it("keeps a 28 px hit target on the 16 px grip and starts the body at the top", () => {
		expect(css).toMatch(
			/\.wg-frame\[data-widget-title-hidden\]\s+\.wg-grip\s*\{[^}]*width:\s*16px[^}]*padding:\s*6px/s,
		);
		expect(css).toMatch(
			/\.wg-frame\[data-widget-title-hidden\]\s+\.wg-body\s*\{[^}]*margin-top:\s*0/,
		);
	});
});
