import { cleanup, fireEvent } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_A, component, makeContext, VALID_PROPS } from "./fixtures.ts";
import { renderComponent } from "./helpers.tsx";

afterEach(cleanup);

function chips(container: HTMLElement): HTMLElement[] {
	const found: HTMLElement[] = [];
	for (const entry of container.querySelectorAll("[data-citation-chip]")) {
		if (!(entry instanceof HTMLElement)) throw new Error("citation chip is not an element");
		found.push(entry);
	}
	return found;
}

function openChip(container: HTMLElement, label: string): HTMLElement {
	const chip = chips(container).find((entry) => entry.getAttribute("aria-label") === label);
	if (chip === undefined) throw new Error(`no chip labelled ${label}`);
	fireEvent.click(chip);
	return chip;
}

describe("canvas citation chips (per component numbering)", () => {
	it("numbers a report's distinct sources once, sharing numbers across statements", () => {
		const container = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		const buttons = chips(container);
		// Statements cite [ev_a], [], [ev_a, ev_b], [ev_unknown].
		expect(buttons.map((chip) => chip.textContent)).toEqual(["1", "1", "2", "3"]);
		expect(buttons.map((chip) => chip.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON", "BUTTON"]);
		expect(buttons.map((chip) => chip.getAttribute("aria-label"))).toEqual([
			"Source 1: Grid storage outlook 2026",
			"Source 1: Grid storage outlook 2026",
			"Source 2: Annual securities report FY2025",
			"Source 3: unavailable",
		]);
		for (const chip of buttons) {
			expect(chip.getAttribute("class")).toContain("min-h-6");
			expect(chip.getAttribute("aria-expanded")).toBe("false");
		}
	});

	it("matches disclosure numbers to the component's chips", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		// The sourced cell cites ev_a, the component declares ev_a: one number.
		expect(chips(container).map((chip) => chip.textContent)).toEqual(["1"]);
		expect(container.textContent).toContain("1 source");
		const row = container.querySelector('ol[aria-label="Sources"] > li');
		expect(row?.textContent).toContain("1.");
		expect(row?.querySelector("a")?.textContent).toBe("Grid storage outlook 2026");
	});

	it("keeps an empty statement's text and an empty component's text", () => {
		const report = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		expect(report.textContent).toContain("No sources cited for this statement.");
		const empty = renderComponent(
			component("data-table", { title: "Empty", datasetRef: "ds_empty", sourceIds: [] }),
		);
		expect(empty.textContent).toContain("No sources cited for this component.");
		expect(empty.querySelector("[data-citation-chip]")).toBeNull();
	});

	it("opens a card with the stored excerpt and no relation word", () => {
		const container = renderComponent(component("news-card", VALID_PROPS["news-card"]), {
			sources: new Map([["ev_a", { ...EVIDENCE_A, excerpt: "Stored passage about tenders." }]]),
		});
		openChip(container, "Source 1: Grid storage outlook 2026");
		const card = container.querySelector("[data-citation-card]");
		expect(card?.textContent).toContain("Stored passage about tenders.");
		expect(card?.textContent).not.toContain("Supports");
		expect(card?.textContent).not.toContain("Contradicts");
		expect(card?.textContent).not.toContain("Context");
	});

	it("keeps one card open per component and closes it with Escape back on the chip", () => {
		const container = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		const first = openChip(container, "Source 1: Grid storage outlook 2026");
		expect(container.querySelectorAll("[data-citation-card]")).toHaveLength(1);
		const second = openChip(container, "Source 2: Annual securities report FY2025");
		expect(container.querySelectorAll("[data-citation-card]")).toHaveLength(1);
		expect(container.querySelector("[data-citation-card]")?.textContent).toContain(
			"Annual securities report FY2025",
		);
		fireEvent.keyDown(second, { key: "Escape" });
		expect(container.querySelector("[data-citation-card]")).toBeNull();
		expect(document.activeElement).toBe(second);
		expect(first.tagName).toBe("BUTTON");
	});

	it("closes a pinned card on a click outside the citation groups", () => {
		const container = renderComponent(component("news-card", VALID_PROPS["news-card"]));
		openChip(container, "Source 1: Grid storage outlook 2026");
		expect(container.querySelector("[data-citation-card]")).not.toBeNull();
		fireEvent.pointerDown(document.body);
		expect(container.querySelector("[data-citation-card]")).toBeNull();
	});

	it("reports an id with no stored source on the card and in the disclosure", () => {
		const report = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		openChip(report, "Source 3: unavailable");
		expect(report.querySelector("[data-citation-card]")?.textContent).toContain(
			"Source unavailable (id ev_unknown)",
		);
		const list = renderComponent(
			component("source-list", { title: "Key sources", sourceIds: ["ev_gone"] }),
		);
		expect(list.querySelector('ol[aria-label="Sources"] > li')?.textContent).toContain(
			"Source unavailable (id ev_gone)",
		);
	});

	it("never links an unsafe URL from a chip card", () => {
		const container = renderComponent(component("news-card", VALID_PROPS["news-card"]), {
			sources: new Map([["ev_a", { ...EVIDENCE_A, sourceUrl: "javascript:alert(1)" }]]),
		});
		openChip(container, "Source 1: Grid storage outlook 2026");
		const card = container.querySelector("[data-citation-card]");
		expect(card?.querySelector("a")).toBeNull();
		expect(card?.textContent).toContain("(link unavailable)");
	});

	it("numbers each component from 1, even for the same source", () => {
		const context = makeContext();
		const first = renderComponent(component("news-card", VALID_PROPS["news-card"]), context);
		expect(chips(first)[0]?.textContent).toBe("1");
		cleanup();
		const second = renderComponent(component("source-list", VALID_PROPS["source-list"]), context);
		const rows = [...second.querySelectorAll('ol[aria-label="Sources"] > li')];
		expect(rows[0]?.textContent).toContain("1.");
		expect(rows[1]?.textContent).toContain("2.");
	});
});
