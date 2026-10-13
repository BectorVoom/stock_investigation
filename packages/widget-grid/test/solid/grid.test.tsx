import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetBase } from "../../src/core/types.ts";
import { WidgetFrame } from "../../src/solid/WidgetFrame.tsx";
import { WidgetGrid } from "../../src/solid/WidgetGrid.tsx";
import type { WidgetDragDrop } from "../../src/solid/widgetDrag.ts";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const widgets = (): WidgetBase[] => [
	{ widgetId: "w-a", type: "note", title: "A", size: "small" },
	{ widgetId: "w-b", type: "note", title: "B", size: "small" },
	{ widgetId: "w-c", type: "note", title: "C", size: "medium" },
];

function orderOf(container: HTMLElement): (string | null)[] {
	return [...container.querySelectorAll("article[data-widget-id]")].map((article) =>
		article.getAttribute("data-widget-id"),
	);
}

/**
 * Dynamic layout like the Home test: each position stacks vertically
 * (300x100 with a 20px gap), reading the CSS `order` the drag preview
 * writes, so the mocked boxes track reflows like a real grid.
 */
function mockLayout(container: HTMLElement): void {
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
	const observer = new MutationObserver(() => {
		for (const article of articles()) {
			const current = article.getBoundingClientRect;
			void current;
		}
		const placeholder = container.querySelector("[data-widget-placeholder]");
		if (
			placeholder instanceof HTMLElement &&
			placeholder.getBoundingClientRect.toString().includes("native") === false
		) {
			// Keep the placeholder measurable once it appears.
			placeholder.getBoundingClientRect = () => boxFor(placeholder, 0);
		}
	});
	observer.observe(container, { childList: true, subtree: true });
}

async function dragFromTo(
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
	const placeholder = container.querySelector("[data-widget-placeholder]");
	if (placeholder instanceof HTMLElement) {
		const raw = placeholder.style.order;
		const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
		const position = Number.isInteger(parsed) ? parsed : 0;
		placeholder.getBoundingClientRect = () => new DOMRect(0, position * 120, 300, 100);
	}
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

describe("WidgetGrid", () => {
	it("renders widgets in order with their sizes", () => {
		const { container } = render(() => (
			<WidgetGrid widgets={widgets()} canDrag={true} onReorder={() => undefined}>
				{(item) => (
					<WidgetFrame widget={item}>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		expect(container.querySelector("[data-widget-grid]")).not.toBeNull();
		expect(orderOf(container)).toEqual(["w-a", "w-b", "w-c"]);
		expect(
			container.querySelector("article[data-widget-id='w-c']")?.getAttribute("data-widget-size"),
		).toBe("medium");
	});

	it("fires onReorder with the drop target", async () => {
		const seen: { drop: WidgetDragDrop | null } = { drop: null };
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				canDrag={true}
				onReorder={(next) => {
					seen.drop = next;
				}}
			>
				{(item) => (
					<WidgetFrame widget={item}>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		mockLayout(container);
		// Drag A (position 0, center 150,50) past C's midpoint (center 150,290) to (150,320).
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		await waitFor(() => expect(seen.drop).not.toBeNull());
		const got = seen.drop;
		if (got === null) throw new Error("onReorder never fired");
		expect(got.widgetId).toBe("w-a");
		expect(got.fromIndex).toBe(0);
		expect(got.toIndex).toBe(2);
	});

	it("starts no drag while canDrag is false", async () => {
		let called = 0;
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				canDrag={false}
				onReorder={() => {
					called += 1;
				}}
			>
				{(item) => (
					<WidgetFrame widget={item}>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		mockLayout(container);
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(called).toBe(0);
		expect(container.querySelector("[data-widget-placeholder]")).toBeNull();
	});

	it("starts no new drag while a returned promise is pending, then clears the preview", async () => {
		const gate: { resolve: ((value: unknown) => void) | null; calls: number } = {
			resolve: null,
			calls: 0,
		};
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				canDrag={true}
				onReorder={() => {
					gate.calls += 1;
					return new Promise<unknown>((resolve) => {
						gate.resolve = resolve;
					});
				}}
			>
				{(item) => (
					<WidgetFrame widget={item}>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		mockLayout(container);
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		await waitFor(() => expect(gate.calls).toBe(1));
		// The preview orders stay on screen while the promise is pending.
		const ordersWhilePending = [...container.querySelectorAll("article[data-widget-id]")].map(
			(article) => (article as HTMLElement).style.order,
		);
		expect(ordersWhilePending.some((order) => order !== "")).toBe(true);
		// A second drag while pending starts nothing.
		await dragFromTo(container, "w-b", 150, 170, 150, 50);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(gate.calls).toBe(1);
		// Settling clears the preview orders.
		const release = gate.resolve;
		if (release === null) throw new Error("save promise never created");
		release(undefined);
		await waitFor(() =>
			expect(
				[...container.querySelectorAll("article[data-widget-id]")].every(
					(article) => (article as HTMLElement).style.order === "",
				),
			).toBe(true),
		);
	});

	it("cancels on Escape with nothing called", async () => {
		let called = 0;
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				canDrag={true}
				onReorder={() => {
					called += 1;
				}}
			>
				{(item) => (
					<WidgetFrame widget={item}>
						<span>{item.title}</span>
					</WidgetFrame>
				)}
			</WidgetGrid>
		));
		mockLayout(container);
		const article = container.querySelector("article[data-widget-id='w-a']");
		if (!(article instanceof HTMLElement)) throw new Error("missing w-a");
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				clientX: 150,
				clientY: 50,
				button: 0,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		window.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				clientX: 150,
				clientY: 320,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
		expect(container.querySelector("[data-widget-placeholder]")).not.toBeNull();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		window.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				clientX: 150,
				clientY: 320,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(called).toBe(0);
		expect(container.querySelector("[data-widget-placeholder]")).toBeNull();
	});
});
