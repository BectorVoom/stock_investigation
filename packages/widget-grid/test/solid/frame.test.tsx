import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetBase } from "../../src/core/types.ts";
import { WidgetFrame } from "../../src/solid/WidgetFrame.tsx";
import { WidgetGrid } from "../../src/solid/WidgetGrid.tsx";

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

describe("WidgetFrame selection", () => {
	it("renders no select toggle and selects nothing without onSelectChange", () => {
		render(() => (
			<WidgetFrame widget={widget()} actions={<button type="button">menu</button>}>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.hasAttribute("data-widget-selected")).toBe(false);
		expect(screen.queryByRole("button", { name: "Select “Notes”" })).toBeNull();
		// A header click with no selection offered changes nothing and throws nothing.
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(article.hasAttribute("data-widget-selected")).toBe(false);
	});

	it("marks selection and offers a toggle button with the documented name", () => {
		const calls: { readonly widgetId: string; readonly mode: "replace" | "toggle" }[] = [];
		render(() => (
			<WidgetFrame
				widget={widget()}
				selected={true}
				onSelectChange={(widgetId, mode) => {
					calls.push({ widgetId, mode });
				}}
			>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		expect(article.hasAttribute("data-widget-selected")).toBe(true);
		const toggle = screen.getByRole("button", { name: "Select “Notes”" });
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(toggle.getAttribute("title")).toBe("Select “Notes”");
		expect(toggle.className).toContain("wg-select-toggle");
		toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toEqual([{ widgetId: "w-1", mode: "toggle" }]);
	});

	it("selects alone on a header click and toggles with a modifier", () => {
		const calls: { readonly widgetId: string; readonly mode: "replace" | "toggle" }[] = [];
		render(() => (
			<WidgetFrame
				widget={widget()}
				selected={false}
				onSelectChange={(widgetId, mode) => {
					calls.push({ widgetId, mode });
				}}
				actions={<button type="button">menu</button>}
			>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		const title = article.querySelector("h3");
		if (!(title instanceof HTMLElement)) throw new Error("no title");

		title.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toEqual([{ widgetId: "w-1", mode: "replace" }]);

		for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
			title.dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers }));
		}
		expect(calls).toEqual([
			{ widgetId: "w-1", mode: "replace" },
			{ widgetId: "w-1", mode: "toggle" },
			{ widgetId: "w-1", mode: "toggle" },
			{ widgetId: "w-1", mode: "toggle" },
		]);

		// A click that landed on a control is the control's, never a selection.
		const menu = screen.getByRole("button", { name: "menu" });
		menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toHaveLength(4);
	});

	it("a completed drag suppresses the click that follows it, but not the next one", async () => {
		const calls: { readonly widgetId: string; readonly mode: "replace" | "toggle" }[] = [];
		const items: WidgetBase[] = [
			{ widgetId: "w-a", type: "note", title: "A", size: "small" },
			{ widgetId: "w-b", type: "note", title: "B", size: "small" },
			{ widgetId: "w-c", type: "note", title: "C", size: "small" },
		];
		const { container } = render(() => (
			<WidgetGrid widgets={items} onReorder={() => undefined}>
				{(item) => (
					<WidgetFrame
						widget={item}
						onSelectChange={(widgetId, mode) => {
							calls.push({ widgetId, mode });
						}}
					>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		mockFrameLayout(container);
		// A real drag: press on A's header, move far enough to lift, release.
		await dragFrameWidget(container, "w-a", 150, 50, 150, 320);
		const article = container.querySelector('article[data-widget-id="w-a"]');
		if (!(article instanceof HTMLElement)) throw new Error("missing w-a");
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		// The click the browser fires on release must not select…
		handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toEqual([]);
		// …while the next click is an ordinary header click again.
		handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toEqual([{ widgetId: "w-a", mode: "replace" }]);
	});

	it("a press-and-release without movement still selects", () => {
		const calls: { readonly widgetId: string; readonly mode: "replace" | "toggle" }[] = [];
		render(() => (
			<WidgetFrame
				widget={widget()}
				onSelectChange={(widgetId, mode) => {
					calls.push({ widgetId, mode });
				}}
			>
				body
			</WidgetFrame>
		));
		const article = screen.getByRole("article", { name: "Notes" });
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		handle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(calls).toEqual([{ widgetId: "w-1", mode: "replace" }]);
	});
});

/**
 * Stacked boxes (300x100 with a 20px gap) like the grid test, so the drag
 * engine lifts and drops against measurable slots.
 */
function mockFrameLayout(container: HTMLElement): void {
	const boxFor = (element: HTMLElement, fallback: number): DOMRect => {
		const raw = element.style.order;
		const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
		const position = Number.isInteger(parsed) ? parsed : fallback;
		return new DOMRect(0, position * 120, 300, 100);
	};
	const articles = () =>
		[...container.querySelectorAll("article[data-widget-id]")].filter(
			(node): node is HTMLElement => node instanceof HTMLElement,
		);
	for (const [index, article] of articles().entries()) {
		article.getBoundingClientRect = () => boxFor(article, index);
	}
}

async function dragFrameWidget(
	container: HTMLElement,
	fromId: string,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
): Promise<void> {
	const article = container.querySelector(`article[data-widget-id="${fromId}"]`);
	if (!(article instanceof HTMLElement)) throw new Error(`missing ${fromId}`);
	const handle = article.querySelector("[data-widget-drag-handle]");
	if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
	handle.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			clientX: fromX,
			clientY: fromY,
			button: 0,
			pointerId: 1,
			isPrimary: true,
		}),
	);
	window.dispatchEvent(
		new PointerEvent("pointermove", {
			bubbles: true,
			clientX: toX,
			clientY: toY,
			pointerId: 1,
			isPrimary: true,
		}),
	);
	await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
	window.dispatchEvent(
		new PointerEvent("pointerup", {
			bubbles: true,
			clientX: toX,
			clientY: toY,
			pointerId: 1,
			isPrimary: true,
		}),
	);
}
