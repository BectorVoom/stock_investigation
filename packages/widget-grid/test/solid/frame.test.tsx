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

	it("renders the header strip as the drag handle with grip and title", () => {
		render(() => (
			<WidgetFrame widget={widget()} actions={<button type="button">menu</button>}>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		expect(handle.getAttribute("data-widget-drag-handle")).toBe("w-1");
		expect(handle.querySelector("svg[aria-hidden='true']")).not.toBeNull();
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
