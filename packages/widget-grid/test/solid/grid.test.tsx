import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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

	it("a press on the host selector starts no drag; without it the same press does", async () => {
		const framed = (item: WidgetBase) => (
			<article
				data-widget-id={item.widgetId}
				data-widget-type={item.type}
				data-widget-size={item.size}
				class="wg-frame"
			>
				<div class="wg-header" data-widget-drag-handle={item.widgetId}>
					<span class="host-ignore">grip</span>
				</div>
			</article>
		);
		async function pressGripMove(
			container: HTMLElement,
			toX: number,
			toY: number,
		): Promise<HTMLElement> {
			const grip = container.querySelector(".host-ignore");
			if (!(grip instanceof HTMLElement)) throw new Error("no host grip");
			const box = grip.getBoundingClientRect();
			const fromX = box.x + box.width / 2;
			const fromY = box.y + box.height / 2;
			grip.dispatchEvent(
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
			return grip;
		}
		// With the host selector the press never starts a drag.
		let blocked = 0;
		const stopBlocked = render(() => (
			<WidgetGrid
				widgets={widgets()}
				ignoreDragFrom=".host-ignore"
				onReorder={() => {
					blocked += 1;
				}}
			>
				{(item) => framed(item)}
			</WidgetGrid>
		));
		mockLayout(stopBlocked.container);
		await pressGripMove(stopBlocked.container, 150, 320);
		expect(stopBlocked.container.querySelector("[data-widget-placeholder]")).toBeNull();
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
		expect(blocked).toBe(0);
		stopBlocked.unmount();
		// Without it the same press starts a drag.
		let allowed = 0;
		const stopAllowed = render(() => (
			<WidgetGrid
				widgets={widgets()}
				onReorder={() => {
					allowed += 1;
				}}
			>
				{(item) => framed(item)}
			</WidgetGrid>
		));
		mockLayout(stopAllowed.container);
		await pressGripMove(stopAllowed.container, 150, 320);
		expect(stopAllowed.container.querySelector("[data-widget-placeholder]")).not.toBeNull();
		expect(allowed).toBe(0);
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
		expect(allowed).toBe(0);
		stopAllowed.unmount();
	});

	it("a synchronous onReorder throw clears the preview and propagates", async () => {
		let calls = 0;
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				onReorder={() => {
					calls += 1;
					if (calls === 1) throw new Error("host boom");
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
		// Drag A (position 0) past C's midpoint to (150,320): the host bug
		// surfaces instead of disappearing.
		await expect(dragFromTo(container, "w-a", 150, 50, 150, 320)).rejects.toThrow("host boom");
		expect(calls).toBe(1);
		// The preview is cleared and the saving flag is released: the next
		// drag saves again.
		expect(
			[...container.querySelectorAll("article[data-widget-id]")].every(
				(article) => (article as HTMLElement).style.order === "",
			),
		).toBe(true);
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		expect(calls).toBe(2);
	});

	it("a rejected onReorder promise only clears the preview", async () => {
		let calls = 0;
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				onReorder={() => {
					calls += 1;
					return Promise.reject(new Error("save failed"));
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
		// A rejection never throws out of the drop: it only clears the preview.
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		expect(calls).toBe(1);
		await waitFor(() =>
			expect(
				[...container.querySelectorAll("article[data-widget-id]")].every(
					(article) => (article as HTMLElement).style.order === "",
				),
			).toBe(true),
		);
		// The saving flag is released after the settle: the next drag saves.
		await dragFromTo(container, "w-a", 150, 50, 150, 320);
		expect(calls).toBe(2);
	});

	it("canDrag defaults to true when omitted", async () => {
		let calls = 0;
		const { container } = render(() => (
			<WidgetGrid
				widgets={widgets()}
				onReorder={() => {
					calls += 1;
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
		expect(calls).toBe(1);
	});

	it("reports the new position through the index accessor after a reorder, without re-creating children", async () => {
		const initial = widgets();
		const [list, setList] = createSignal<WidgetBase[]>([...initial]);
		const creations = new Map<string, number>();
		const positions = new Map<string, () => number>();
		render(() => (
			<WidgetGrid widgets={list()} onReorder={() => undefined}>
				{(item, index) => {
					creations.set(item.widgetId, (creations.get(item.widgetId) ?? 0) + 1);
					positions.set(item.widgetId, index);
					return (
						<WidgetFrame widget={item}>
							<span>{item.title}</span>
						</WidgetFrame>
					);
				}}
			</WidgetGrid>
		));
		expect(positions.get("w-a")?.()).toBe(0);
		expect(positions.get("w-b")?.()).toBe(1);
		expect(positions.get("w-c")?.()).toBe(2);
		const first = initial[0];
		const second = initial[1];
		const third = initial[2];
		if (first === undefined || second === undefined || third === undefined) {
			throw new Error("fixture widgets are missing");
		}
		setList([second, third, first]);
		await waitFor(() => expect(positions.get("w-a")?.()).toBe(2));
		expect(positions.get("w-b")?.()).toBe(0);
		expect(positions.get("w-c")?.()).toBe(1);
		expect([...creations.values()]).toEqual([1, 1, 1]);
	});
});
