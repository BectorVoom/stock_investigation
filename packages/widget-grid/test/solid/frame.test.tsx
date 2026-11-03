import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetBase } from "../../src/core/types.ts";
import { WidgetFrame } from "../../src/solid/WidgetFrame.tsx";

afterEach(() => cleanup());

const widget = (overrides: Partial<WidgetBase> = {}): WidgetBase => ({
	widgetId: "w-1",
	type: "note",
	title: "Notes",
	size: "small",
	...overrides,
});

describe("WidgetFrame", () => {
	it("labels the article by its title and carries the widget identity", () => {
		render(() => (
			<WidgetFrame widget={widget({ widgetId: "w-9", type: "metric", size: "medium" })}>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.getAttribute("data-widget-id")).toBe("w-9");
		expect(article.getAttribute("data-widget-type")).toBe("metric");
		expect(article.getAttribute("data-widget-size")).toBe("medium");
		const title = article.querySelector("h3");
		if (!(title instanceof HTMLElement)) throw new Error("no title");
		expect(article.getAttribute("aria-labelledby")).toBe(title.id);
		expect(title.id).not.toBe("");
	});

	it("renders the header strip as the drag handle, with no grip glyph (ADR-0063)", () => {
		render(() => (
			<WidgetFrame widget={widget()} actions={<button type="button">menu</button>}>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		expect(handle.getAttribute("data-widget-drag-handle")).toBe("w-1");
		expect(handle.querySelector(".wg-grip")).toBeNull();
		expect(handle.querySelector("svg")).toBeNull();
	});

	it("holds the body in a focusable group labelled by the title", () => {
		render(() => <WidgetFrame widget={widget()}>body text</WidgetFrame>);
		const article = screen.getByRole("article", { name: "Notes" });
		const title = article.querySelector("h3");
		if (!(title instanceof HTMLElement)) throw new Error("no title");
		const body = article.querySelector("div[tabindex='0']");
		if (!(body instanceof HTMLElement)) throw new Error("no scrollable body");
		expect(body.getAttribute("role")).toBe("group");
		expect(body.getAttribute("aria-labelledby")).toBe(title.id);
		expect(body.textContent).toContain("body text");
	});

	it("keeps the actions slot live", async () => {
		const [label, setLabel] = createSignal("first");
		render(() => (
			<WidgetFrame widget={widget()} actions={<button type="button">{label()}</button>}>
				body
			</WidgetFrame>
		));
		expect(screen.getByRole("button", { name: "first" })).toBeDefined();
		setLabel("second");
		await Promise.resolve();
		expect(screen.getByRole("button", { name: "second" })).toBeDefined();
	});

	it("keeps children live", async () => {
		const [text, setText] = createSignal("one");
		render(() => <WidgetFrame widget={widget()}>{text()}</WidgetFrame>);
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.textContent).toContain("one");
		setText("two");
		await Promise.resolve();
		expect(article.textContent).toContain("two");
	});
});

describe("WidgetFrame has no selection (removed 2026-11-02)", () => {
	it("renders only the title and the host's actions, and never marks a selection", () => {
		render(() => (
			<WidgetFrame widget={widget()} actions={<button type="button">menu</button>}>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.hasAttribute("data-widget-selected")).toBe(false);
		expect(article.querySelector(".wg-select-toggle")).toBeNull();
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		// The header's only button is the host's.
		expect([...handle.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"menu",
		]);
		handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(article.hasAttribute("data-widget-selected")).toBe(false);
	});
});

describe("WidgetFrame titleHidden", () => {
	it("keeps the accessible name while hiding the title and marking the frame", () => {
		render(() => (
			<WidgetFrame widget={widget()} titleHidden>
				body text
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.hasAttribute("data-widget-title-hidden")).toBe(true);
		const title = article.querySelector("h3");
		if (!(title instanceof HTMLElement)) throw new Error("no title");
		expect(title.className).toContain("wg-visually-hidden");
		expect(title.className).not.toContain("wg-title");
		expect(article.getAttribute("aria-labelledby")).toBe(title.id);
		const body = article.querySelector("div[tabindex='0']");
		if (!(body instanceof HTMLElement)) throw new Error("no scrollable body");
		expect(body.getAttribute("aria-labelledby")).toBe(title.id);
		expect(body.textContent).toContain("body text");
	});

	it("makes the top edge a drag strip for the widget, hidden from assistive technology", () => {
		render(() => (
			<WidgetFrame widget={widget()} titleHidden>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		const strip = article.querySelector(".wg-drag-strip");
		if (!(strip instanceof HTMLElement)) throw new Error("no drag strip");
		expect(strip.getAttribute("data-widget-drag-handle")).toBe("w-1");
		expect(strip.getAttribute("aria-hidden")).toBe("true");
		// It sits before the header, so the control cluster stays on top of it.
		expect(strip.nextElementSibling?.classList.contains("wg-header")).toBe(true);
	});

	it("has no drag strip on a titled frame, whose header is already the top", () => {
		render(() => <WidgetFrame widget={widget()}>body</WidgetFrame>);
		expect(
			screen.getByRole("article", { name: "Notes" }).querySelector(".wg-drag-strip"),
		).toBeNull();
	});

	it("renders a visible title without the marker when omitted", () => {
		render(() => <WidgetFrame widget={widget()}>body text</WidgetFrame>);
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.hasAttribute("data-widget-title-hidden")).toBe(false);
		const title = article.querySelector("h3");
		if (!(title instanceof HTMLElement)) throw new Error("no title");
		expect(title.className).toContain("wg-title");
		expect(title.className).not.toContain("wg-visually-hidden");
	});
});
