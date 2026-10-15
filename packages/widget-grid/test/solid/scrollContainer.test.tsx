import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetBase } from "../../src/core/types.ts";
import { WidgetFrame } from "../../src/solid/WidgetFrame.tsx";
import { WidgetGrid } from "../../src/solid/WidgetGrid.tsx";
import type { WidgetDragDrop } from "../../src/solid/widgetDrag.ts";
import {
	containerEdgeScrollStep,
	findScrollableAncestor,
	isVerticallyScrollable,
} from "../../src/solid/widgetDrag.ts";

afterEach(() => cleanup());

/** A box with the given vertical metrics: style overflow plus real overflow. */
function scrollBox(overflowY: string, scrollHeight: number, clientHeight: number): HTMLElement {
	const element = document.createElement("div");
	element.style.overflowY = overflowY;
	Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
	Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
	return element;
}

describe("isVerticallyScrollable", () => {
	/** Computed style needs the element in the document. */
	function attached(overflowY: string, scrollHeight: number, clientHeight: number): HTMLElement {
		const element = scrollBox(overflowY, scrollHeight, clientHeight);
		document.body.appendChild(element);
		return element;
	}

	it("is true for clipping overflow with taller content", () => {
		for (const overflowY of ["auto", "scroll"]) {
			const element = attached(overflowY, 500, 200);
			try {
				expect(isVerticallyScrollable(element)).toBe(true);
			} finally {
				element.remove();
			}
		}
	});

	it("is false without clipping overflow or without overflow", () => {
		const cases: Array<[string, number, number]> = [
			["visible", 500, 200],
			["hidden", 500, 200],
			["auto", 200, 200],
			["scroll", 200, 200],
		];
		for (const [overflowY, scrollHeight, clientHeight] of cases) {
			const element = attached(overflowY, scrollHeight, clientHeight);
			try {
				expect(isVerticallyScrollable(element)).toBe(false);
			} finally {
				element.remove();
			}
		}
	});

	it("is false for non-HTML elements", () => {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		expect(isVerticallyScrollable(svg)).toBe(false);
	});
});

describe("findScrollableAncestor", () => {
	it("finds the panel the grid scrolls in", () => {
		const panel = scrollBox("auto", 1000, 200);
		const grid = document.createElement("div");
		panel.appendChild(grid);
		document.body.appendChild(panel);
		try {
			expect(findScrollableAncestor(grid)).toBe(panel);
		} finally {
			panel.remove();
		}
	});

	it("prefers the nearest scrollable ancestor", () => {
		const outer = scrollBox("auto", 2000, 400);
		const inner = scrollBox("auto", 1000, 200);
		const grid = document.createElement("div");
		inner.appendChild(grid);
		outer.appendChild(inner);
		document.body.appendChild(outer);
		try {
			expect(findScrollableAncestor(grid)).toBe(inner);
		} finally {
			outer.remove();
		}
	});

	it("skips boxes that fit and returns null when the window scrolls", () => {
		const fitting = scrollBox("auto", 100, 200);
		const grid = document.createElement("div");
		fitting.appendChild(grid);
		document.body.appendChild(fitting);
		try {
			expect(findScrollableAncestor(grid)).toBeNull();
		} finally {
			fitting.remove();
		}
	});
});

describe("containerEdgeScrollStep", () => {
	/** A 300x400 panel at viewport top 100 (bottom 500), scrolled 50 of 1000. */
	function panel(scrollTop: number): HTMLElement {
		const element = scrollBox("auto", 1000, 400);
		Object.defineProperty(element, "scrollTop", {
			value: scrollTop,
			writable: true,
			configurable: true,
		});
		element.getBoundingClientRect = () => new DOMRect(0, 100, 300, 400);
		return element;
	}

	it("scrolls up near the top edge, faster when deeper", () => {
		const scroller = panel(50);
		expect(containerEdgeScrollStep(scroller, 100)).toBe(-16);
		expect(containerEdgeScrollStep(scroller, 170)).toBe(-2);
		expect(containerEdgeScrollStep(scroller, 179)).toBe(-1);
	});

	it("never scrolls up past the top", () => {
		expect(containerEdgeScrollStep(panel(0), 100)).toBe(0);
	});

	it("scrolls down near the bottom edge, faster when deeper", () => {
		const scroller = panel(50);
		expect(containerEdgeScrollStep(scroller, 500)).toBe(16);
		expect(containerEdgeScrollStep(scroller, 490)).toBe(14);
		expect(containerEdgeScrollStep(scroller, 421)).toBe(1);
	});

	it("never scrolls down past the bottom", () => {
		expect(containerEdgeScrollStep(panel(600), 490)).toBe(0);
	});

	it("is still in the middle", () => {
		expect(containerEdgeScrollStep(panel(50), 300)).toBe(0);
	});
});

const items = (): WidgetBase[] => [
	{ widgetId: "w-a", type: "note", title: "A", size: "small" },
	{ widgetId: "w-b", type: "note", title: "B", size: "small" },
	{ widgetId: "w-c", type: "note", title: "C", size: "small" },
];

/**
 * A 300x400 scroll panel at viewport top 100 holding the grid. Article boxes
 * track the panel's scroll position like a real layout, so a stale slot
 * measurement would decide against shifted boxes.
 */
function renderInPanel(onReorder: (drop: WidgetDragDrop) => void): {
	readonly container: HTMLElement;
	readonly panel: HTMLElement;
} {
	const panel = scrollBox("auto", 1200, 400);
	Object.defineProperty(panel, "scrollTop", {
		value: 0,
		writable: true,
		configurable: true,
	});
	panel.getBoundingClientRect = () => new DOMRect(0, 100, 300, 400);
	const rendered = render(() => (
		<WidgetGrid widgets={items()} onReorder={onReorder}>
			{(item) => (
				<WidgetFrame widget={item}>
					<span>{item.title}</span>
				</WidgetFrame>
			)}
		</WidgetGrid>
	));
	const grid = rendered.container.querySelector("[data-widget-grid]");
	if (!(grid instanceof HTMLElement)) throw new Error("no grid element");
	rendered.container.appendChild(panel);
	panel.appendChild(grid);
	const boxFor = (element: HTMLElement, fallback: number): DOMRect => {
		const raw = element.style.order;
		const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
		const position = Number.isInteger(parsed) ? parsed : fallback;
		return new DOMRect(0, 100 + position * 120 - panel.scrollTop, 300, 100);
	};
	const articles = () =>
		[...rendered.container.querySelectorAll("article[data-widget-id]")].filter(
			(node): node is HTMLElement => node instanceof HTMLElement,
		);
	for (const [index, article] of articles().entries()) {
		article.getBoundingClientRect = () => boxFor(article, index);
	}
	return { container: rendered.container, panel };
}

async function pressMove(
	container: HTMLElement,
	panel: HTMLElement,
	fromId: string,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	frames: number,
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
	// The placeholder exists synchronously after the move (startDrag runs on
	// the press movement); keep it measurable with the same scroll-tracking
	// boxes as the articles.
	const slotBox = (element: HTMLElement): DOMRect => {
		const raw = element.style.order;
		const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
		const position = Number.isInteger(parsed) ? parsed : 0;
		return new DOMRect(0, 100 + position * 120 - panel.scrollTop, 300, 100);
	};
	const placeholder = container.querySelector("[data-widget-placeholder]");
	if (placeholder instanceof HTMLElement)
		placeholder.getBoundingClientRect = () => slotBox(placeholder);
	for (let frame = 0; frame < frames; frame += 1) {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
		const slot = container.querySelector("[data-widget-placeholder]");
		if (slot instanceof HTMLElement) slot.getBoundingClientRect = () => slotBox(slot);
	}
}

describe("drag inside a scroll container", () => {
	it("auto-scrolls the panel at the bottom edge and drops at the target", async () => {
		let seen: WidgetDragDrop | null = null;
		const { container, panel } = renderInPanel((drop) => {
			seen = drop;
		});
		try {
			// Press on A's header (panel-relative 50) and rest inside the last
			// slot near the panel bottom edge (client 435: inside C's
			// 340–440 box and in the edge zone that starts at 420).
			await pressMove(container, panel, "w-a", 150, 150, 150, 435, 10);
			expect(panel.scrollTop).toBeGreaterThan(0);
			window.dispatchEvent(
				new PointerEvent("pointerup", {
					bubbles: true,
					clientX: 150,
					clientY: 435,
					pointerId: 1,
					isPrimary: true,
				}),
			);
			if (seen === null) throw new Error("onReorder never fired");
			const drop = seen as WidgetDragDrop;
			expect(drop.widgetId).toBe("w-a");
			expect(drop.fromIndex).toBe(0);
			// The pointer rests deep in the list: the widget lands at the end.
			expect(drop.toIndex).toBe(2);
		} finally {
			panel.remove();
		}
	});

	it("does not scroll the panel with the pointer in the middle", async () => {
		let calls = 0;
		const { container, panel } = renderInPanel(() => {
			calls += 1;
		});
		try {
			await pressMove(container, panel, "w-a", 150, 150, 150, 300, 2);
			expect(panel.scrollTop).toBe(0);
			window.dispatchEvent(
				new PointerEvent("pointerup", {
					bubbles: true,
					clientX: 150,
					clientY: 300,
					pointerId: 1,
					isPrimary: true,
				}),
			);
			expect(calls).toBe(1);
		} finally {
			panel.remove();
		}
	});
});
