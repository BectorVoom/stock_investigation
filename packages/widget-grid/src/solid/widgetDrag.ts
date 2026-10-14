import { nextDropTarget, type SlotRect } from "../core/dragModel.ts";
import type { WidgetBase, WidgetSize } from "../core/types.ts";

/**
 * Pointer/DOM engine for widget dragging (HIG Drag and drop). Owns the
 * active press/drag state, the window listeners, every CSSOM write (lifted
 * widget, placeholder, preview `order` values) and its cleanup. The owner
 * (for example `WidgetGrid`) keeps only the wiring: what may start a drag
 * (`canStart`), what a drop saves (`onDrop`) and clearing the kept preview
 * after the save.
 *
 * `dragModel.ts` stays pure: this module converts DOM measurements to its
 * input and applies its output to the DOM, nothing more.
 *
 * Coordinates: slot rectangles are re-measured in PAGE coordinates
 * (`getBoundingClientRect` plus the window scroll offset) on every animation
 * frame, and the pointer is converted to page coordinates on every
 * evaluation, so any scrolling during a drag (auto-scroll, wheel, trackpad,
 * scrollbar — in the window or in a scroll container) never stales the
 * decision. A `scroll` listener (capture, so container scrolls count)
 * schedules a re-evaluation frame; pointer frames coalesce on
 * `requestAnimationFrame`.
 *
 * Edge auto-scroll (HIG: scroll the destination when necessary): while a drag
 * is active and the pointer rests within 80 px of the top or bottom edge of
 * the nearest scrollable ancestor of the grid (the window when the page
 * itself scrolls, for example Home; the Notebook's `[data-notebook-scroll]`
 * panel there) and it can still scroll that way, every frame scrolls by an
 * amount proportional to how deep into the zone the pointer is (capped at
 * about 16 px) and re-evaluates the drop target as content passes under the
 * pointer. It stops when the pointer leaves the zone, the scroller reaches
 * its end, or the drag ends or is cancelled.
 */

/** Within this distance of the top/bottom viewport edge, a drag auto-scrolls. */
const EDGE_ZONE_PX = 80;
/** Deepest-edge auto-scroll step per frame. */
const MAX_SCROLL_STEP_PX = 16;
/** Pointer travel before a press becomes a drag (a press-and-release is a click). */
const START_THRESHOLD_PX = 4;

/** Interactive controls that never start a drag (native elements only). */
const NATIVE_NO_DRAG_SELECTOR =
	'button,a,input,select,textarea,summary,[role="menu"],[role="menuitem"]';

/**
 * Whether an element scrolls vertically on its own: clipping overflow
 * (`auto` or `scroll`) with content taller than the box. Read from the
 * computed style (never the inline style alone, so host stylesheets count)
 * and the real overflow (an `auto` box that fits its content scrolls
 * nothing).
 */
export function isVerticallyScrollable(element: Element): boolean {
	if (!(element instanceof HTMLElement)) return false;
	const overflowY = getComputedStyle(element).overflowY;
	if (overflowY !== "auto" && overflowY !== "scroll") return false;
	return element.scrollHeight > element.clientHeight;
}

/**
 * The nearest vertically scrollable ancestor of the grid, or null when the
 * page itself scrolls. The Notebook's widget list scrolls inside its panel
 * (`[data-notebook-scroll]`), so a drag there auto-scrolls that panel;
 * Home's grid sits in the window scroll and keeps the window behaviour.
 */
export function findScrollableAncestor(grid: HTMLElement): HTMLElement | null {
	let node = grid.parentElement;
	while (node !== null) {
		if (isVerticallyScrollable(node)) return node;
		node = node.parentElement;
	}
	return null;
}

export interface WidgetDragDrop {
	readonly widgetId: string;
	readonly fromIndex: number;
	readonly toIndex: number;
	readonly preview: readonly string[];
}

export interface WidgetDragOptions<W extends WidgetBase = WidgetBase> {
	/** The grid element holding the widget articles. */
	readonly getGrid: () => HTMLElement | undefined;
	/** Current server-order widgets (preview order is derived from these). */
	readonly getWidgets: () => readonly W[];
	/** False while a save is in flight, while loading, or otherwise busy. */
	readonly canStart: () => boolean;
	/**
	 * Called once per committed drop with the reorder to save. The preview
	 * orders are left on screen; the owner clears them via `clearPreview`
	 * once the save settles.
	 */
	readonly onDrop: (drop: WidgetDragDrop) => void;
	/**
	 * Extra selector for controls that never start a drag (appended to the
	 * native list above). Read lazily on every press through the options
	 * object, so a host-supplied selector is always current.
	 */
	readonly extraIgnoreSelector?: string;
}

export interface WidgetDragController {
	/** Attach to the grid's `onPointerDown`. */
	readonly onPointerDown: (event: PointerEvent) => void;
	/** Removes every listener and restores the DOM. */
	readonly dispose: () => void;
	/** Removes kept preview `order` values (call after the drop's save settles). */
	readonly clearPreview: () => void;
	/** Cancels the active press/drag with nothing saved. */
	readonly cancel: () => void;
}

interface ActiveDrag {
	readonly widgetId: string;
	readonly pointerId: number;
	readonly pressX: number;
	readonly pressY: number;
	readonly grabDX: number;
	readonly grabDY: number;
	readonly width: number;
	readonly height: number;
	readonly fromIndex: number;
	readonly article: HTMLElement;
	readonly grid: HTMLElement;
	readonly draggedSize: WidgetSize;
	started: boolean;
	preview: string[];
	target: number;
	banned: number | null;
	/** Slot rectangles in PAGE coordinates, in preview order. */
	slots: SlotRect[];
	/**
	 * Nearest scrollable ancestor at drag start (null: the window scrolls).
	 * Resolved once per drag: the grid does not move panels mid-gesture.
	 */
	scroller: HTMLElement | null;
	/** Latest pointer position in VIEWPORT (client) coordinates. */
	lastClientX: number;
	lastClientY: number;
	raf: number;
	placeholder: HTMLElement | null;
}

const articlesIn = (grid: HTMLElement): HTMLElement[] => {
	const found: HTMLElement[] = [];
	for (const node of grid.querySelectorAll("article[data-widget-id]")) {
		if (node instanceof HTMLElement) found.push(node);
	}
	return found;
};

const articleWithId = (grid: HTMLElement, widgetId: string): HTMLElement | null => {
	for (const article of articlesIn(grid)) {
		if (article.getAttribute("data-widget-id") === widgetId) return article;
	}
	return null;
};

/** Viewport box shifted into page coordinates (stable under scrolling). */
const pageRectOf = (element: HTMLElement): SlotRect => {
	const box = element.getBoundingClientRect();
	const x = window.scrollX;
	const y = window.scrollY;
	return { left: box.left + x, top: box.top + y, right: box.right + x, bottom: box.bottom + y };
};

/** Slot rectangles in preview order, in page coordinates; the dragged slot is the placeholder. */
const readPreviewSlots = (
	grid: HTMLElement,
	preview: readonly string[],
	draggedId: string,
	placeholder: HTMLElement,
): SlotRect[] => {
	const byId = new Map<string, HTMLElement>();
	for (const article of articlesIn(grid)) {
		const id = article.getAttribute("data-widget-id");
		if (id !== null) byId.set(id, article);
	}
	const slots: SlotRect[] = [];
	for (const id of preview) {
		if (id === draggedId) {
			slots.push(pageRectOf(placeholder));
			continue;
		}
		const article = byId.get(id);
		if (article === undefined) continue;
		slots.push(pageRectOf(article));
	}
	return slots;
};

const applyDuringDragOrders = (
	grid: HTMLElement,
	preview: readonly string[],
	draggedId: string,
	target: number,
	placeholder: HTMLElement,
): void => {
	const positions = new Map<string, number>();
	for (const [index, id] of preview.entries()) positions.set(id, index);
	for (const article of articlesIn(grid)) {
		const id = article.getAttribute("data-widget-id");
		if (id === null || id === draggedId) continue;
		const position = positions.get(id);
		if (position === undefined) continue;
		article.style.setProperty("order", String(position));
	}
	placeholder.style.setProperty("order", String(target));
};

const applyPreviewOrders = (grid: HTMLElement, preview: readonly string[]): void => {
	const positions = new Map<string, number>();
	for (const [index, id] of preview.entries()) positions.set(id, index);
	for (const article of articlesIn(grid)) {
		const id = article.getAttribute("data-widget-id");
		if (id === null) continue;
		const position = positions.get(id);
		if (position === undefined) continue;
		article.style.setProperty("order", String(position));
	}
};

const clearGridOrders = (grid: HTMLElement): void => {
	for (const article of articlesIn(grid)) article.style.removeProperty("order");
};

const liftDragged = (article: HTMLElement, x: number, y: number, w: number, h: number): void => {
	article.style.setProperty("position", "fixed");
	article.style.setProperty("left", `${x}px`);
	article.style.setProperty("top", `${y}px`);
	article.style.setProperty("width", `${w}px`);
	article.style.setProperty("height", `${h}px`);
	article.style.setProperty("opacity", "0.9");
	article.style.setProperty("z-index", "30");
	article.style.setProperty("pointer-events", "none");
	article.setAttribute("data-widget-dragging", "");
};

const moveLifted = (article: HTMLElement, x: number, y: number): void => {
	article.style.setProperty("left", `${x}px`);
	article.style.setProperty("top", `${y}px`);
};

const unliftDragged = (article: HTMLElement): void => {
	for (const property of [
		"position",
		"left",
		"top",
		"width",
		"height",
		"opacity",
		"z-index",
		"pointer-events",
	]) {
		article.style.removeProperty(property);
	}
	article.removeAttribute("data-widget-dragging");
};

/**
 * Edge auto-scroll step inside a scroll container for one frame: 0 outside
 * the 80 px zones at the container's own top and bottom edges (zones are in
 * viewport coordinates, like the pointer) or when the container cannot
 * scroll that way, otherwise the same depth-proportional step as the window,
 * capped at about 16 px per frame.
 */
export function containerEdgeScrollStep(container: HTMLElement, clientY: number): number {
	const box = container.getBoundingClientRect();
	if (clientY < box.top + EDGE_ZONE_PX) {
		if (container.scrollTop <= 0) return 0;
		const depth = Math.min(1, (box.top + EDGE_ZONE_PX - clientY) / EDGE_ZONE_PX);
		return -Math.min(MAX_SCROLL_STEP_PX, Math.max(1, Math.round(depth * MAX_SCROLL_STEP_PX)));
	}
	if (clientY > box.bottom - EDGE_ZONE_PX) {
		if (container.scrollTop >= container.scrollHeight - container.clientHeight - 1) return 0;
		const depth = Math.min(1, (clientY - (box.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX);
		return Math.min(MAX_SCROLL_STEP_PX, Math.max(1, Math.round(depth * MAX_SCROLL_STEP_PX)));
	}
	return 0;
}

/**
 * Edge auto-scroll step for one frame: 0 outside the 80 px zones (or when
 * the page cannot scroll that way), otherwise a step proportional to the
 * depth into the zone, capped at about 16 px per frame.
 */
const edgeScrollStep = (clientY: number): number => {
	const height = window.innerHeight;
	if (clientY < EDGE_ZONE_PX) {
		if (window.scrollY <= 0) return 0;
		const depth = Math.min(1, (EDGE_ZONE_PX - clientY) / EDGE_ZONE_PX);
		return -Math.min(MAX_SCROLL_STEP_PX, Math.max(1, Math.round(depth * MAX_SCROLL_STEP_PX)));
	}
	if (clientY > height - EDGE_ZONE_PX) {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		if (window.scrollY >= max - 1) return 0;
		const depth = Math.min(1, (clientY - (height - EDGE_ZONE_PX)) / EDGE_ZONE_PX);
		return Math.min(MAX_SCROLL_STEP_PX, Math.max(1, Math.round(depth * MAX_SCROLL_STEP_PX)));
	}
	return 0;
};

export function createWidgetDrag<W extends WidgetBase = WidgetBase>(
	options: WidgetDragOptions<W>,
): WidgetDragController {
	let drag: ActiveDrag | null = null;
	let disposed = false;
	/**
	 * Swallows the click a completed drag fires on release, so the frame's
	 * header click never also selects. One-shot: the next click belongs to a
	 * new gesture, and a new press disarms it even when no click ever comes
	 * (for example after an Escape cancel followed by keyboard use).
	 */
	let clickGuard: { readonly release: () => void } | null = null;

	const disarmClickGuard = (): void => {
		const guard = clickGuard;
		clickGuard = null;
		guard?.release();
	};

	const armClickGuard = (grid: HTMLElement): void => {
		disarmClickGuard();
		const onClick = (event: Event): void => {
			const target = event.target;
			const inside = target instanceof Element && grid.contains(target);
			disarmClickGuard();
			if (inside) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const onPress = (): void => {
			disarmClickGuard();
		};
		window.addEventListener("click", onClick, true);
		window.addEventListener("pointerdown", onPress, true);
		clickGuard = {
			release: () => {
				window.removeEventListener("click", onClick, true);
				window.removeEventListener("pointerdown", onPress, true);
			},
		};
	};

	/** The full no-drag selector, read lazily so a host update applies. */
	const noDragSelector = (): string => {
		const extra = options.extraIgnoreSelector;
		return extra === undefined || extra === ""
			? NATIVE_NO_DRAG_SELECTOR
			: `${NATIVE_NO_DRAG_SELECTOR},${extra}`;
	};

	const scheduleFrame = (): void => {
		if (drag === null || drag.raf !== 0 || disposed) return;
		drag.raf = requestAnimationFrame(onFrame);
	};

	const removeListeners = (): void => {
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", onPointerUp);
		window.removeEventListener("pointercancel", onPointerCancel);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("blur", onBlur);
		window.removeEventListener("scroll", onScroll, true);
	};

	const resetDom = (): void => {
		const state = drag;
		if (state === null) return;
		if (state.raf !== 0) {
			cancelAnimationFrame(state.raf);
			state.raf = 0;
		}
		unliftDragged(state.article);
		state.placeholder?.remove();
		clearGridOrders(state.grid);
		document.body.style.removeProperty("user-select");
	};

	/** Cancels the active press/drag: the widget returns, nothing is saved. */
	function cancel(): void {
		if (drag === null) return;
		const wasStarted = drag.started;
		const grid = drag.grid;
		removeListeners();
		resetDom();
		drag = null;
		// A cancelled drag still ends with a click on release; it must not select.
		if (wasStarted) armClickGuard(grid);
	}

	function onFrame(): void {
		const state = drag;
		if (state === null || disposed) return;
		state.raf = 0;
		const placeholder = state.placeholder;
		if (!state.started || placeholder === null) return;
		// Edge auto-scroll first, so the target below is evaluated against
		// the fresh scroll position as content passes under the pointer.
		const scroller = state.scroller;
		const autoStep =
			scroller === null
				? edgeScrollStep(state.lastClientY)
				: containerEdgeScrollStep(scroller, state.lastClientY);
		if (autoStep !== 0) {
			if (scroller === null) window.scrollBy(0, autoStep);
			else scroller.scrollTop += autoStep;
		}
		moveLifted(state.article, state.lastClientX - state.grabDX, state.lastClientY - state.grabDY);
		// Slots are re-measured every frame: any scrolling during the drag
		// (auto-scroll, wheel, trackpad, scrollbar — window or container)
		// moves every box, so a cached rectangle would stale the decision.
		state.slots = readPreviewSlots(state.grid, state.preview, state.widgetId, placeholder);
		const next = nextDropTarget({
			slots: state.slots,
			draggedIndex: state.target,
			pointer: {
				x: state.lastClientX + window.scrollX,
				y: state.lastClientY + window.scrollY,
			},
			previous: { target: state.target, banned: state.banned },
		});
		if (next.target !== state.target) {
			const widgetId = state.widgetId;
			const without = state.preview.filter((id) => id !== widgetId);
			without.splice(next.target, 0, widgetId);
			state.preview = without;
			state.target = next.target;
			state.banned = next.banned;
			applyDuringDragOrders(state.grid, state.preview, state.widgetId, state.target, placeholder);
		} else {
			state.banned = next.banned;
		}
		// Keep scrolling while the pointer rests in the zone and the
		// scroller can still move that way; anything else stops until the
		// next move.
		const settled =
			scroller === null
				? edgeScrollStep(state.lastClientY)
				: containerEdgeScrollStep(scroller, state.lastClientY);
		if (settled !== 0) scheduleFrame();
	}

	function startDrag(state: ActiveDrag): void {
		state.started = true;
		// The drag auto-scrolls the grid's own panel when it has one (the
		// Notebook), otherwise the window (Home).
		state.scroller = findScrollableAncestor(state.grid);
		const placeholder = document.createElement("div");
		placeholder.setAttribute("data-widget-placeholder", "");
		placeholder.setAttribute("data-widget-size", state.draggedSize);
		placeholder.setAttribute("aria-hidden", "true");
		placeholder.className = "wg-placeholder";
		state.grid.appendChild(placeholder);
		state.placeholder = placeholder;
		document.body.style.setProperty("user-select", "none");
		liftDragged(
			state.article,
			state.lastClientX - state.grabDX,
			state.lastClientY - state.grabDY,
			state.width,
			state.height,
		);
		applyDuringDragOrders(state.grid, state.preview, state.widgetId, state.target, placeholder);
		state.slots = readPreviewSlots(state.grid, state.preview, state.widgetId, placeholder);
	}

	function onPointerMove(event: PointerEvent): void {
		const state = drag;
		if (state === null || event.pointerId !== state.pointerId) return;
		if (event.isPrimary === false) return;
		state.lastClientX = event.clientX;
		state.lastClientY = event.clientY;
		if (!state.started) {
			const moved = Math.hypot(state.lastClientX - state.pressX, state.lastClientY - state.pressY);
			// The drag image appears after about three points (4 px here);
			// a press and release without that movement is a plain click.
			if (moved < START_THRESHOLD_PX) return;
			startDrag(state);
		}
		scheduleFrame();
	}

	function onPointerUp(event: PointerEvent): void {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		const finished = drag;
		removeListeners();
		if (finished.raf !== 0) {
			cancelAnimationFrame(finished.raf);
			finished.raf = 0;
		}
		if (!finished.started) {
			drag = null;
			return;
		}
		// Flush the release point synchronously: a coalesced frame holding
		// the final pointer position may still be pending (or was just
		// cancelled), and the drop must commit what is under the pointer,
		// not the last frame that ran.
		finished.lastClientX = event.clientX;
		finished.lastClientY = event.clientY;
		const flushed = nextDropTarget({
			slots: finished.slots,
			draggedIndex: finished.target,
			pointer: {
				x: finished.lastClientX + window.scrollX,
				y: finished.lastClientY + window.scrollY,
			},
			previous: { target: finished.target, banned: finished.banned },
		});
		if (flushed.target !== finished.target) {
			const widgetId = finished.widgetId;
			const without = finished.preview.filter((id) => id !== widgetId);
			without.splice(flushed.target, 0, widgetId);
			finished.preview = without;
			finished.target = flushed.target;
			finished.banned = flushed.banned;
		}
		const widgetId = finished.widgetId;
		const toIndex = finished.target;
		const fromIndex = finished.fromIndex;
		const preview = [...finished.preview];
		// A completed drag ends with a click on release; it must not also select.
		armClickGuard(finished.grid);
		// Settle the lifted widget back into flow before deciding.
		unliftDragged(finished.article);
		finished.placeholder?.remove();
		document.body.style.removeProperty("user-select");
		if (toIndex === fromIndex) {
			clearGridOrders(finished.grid);
			drag = null;
			return;
		}
		// The previewed order stays on screen while the save is in flight
		// (no snap back): the owner clears it via `clearPreview` once the
		// save settles. Keep CSS orders until the server copy renders.
		applyPreviewOrders(finished.grid, preview);
		drag = null;
		options.onDrop({ widgetId, fromIndex, toIndex, preview });
	}

	function onPointerCancel(event: PointerEvent): void {
		if (drag === null || event.pointerId !== drag.pointerId) return;
		cancel();
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || drag === null) return;
		event.preventDefault();
		cancel();
	}

	function onBlur(): void {
		if (drag === null) return;
		cancel();
	}

	function onScroll(): void {
		// Slots are page coordinates, so scrolling never stales them; just
		// re-evaluate the target under the pointer on the next frame.
		if (drag?.started === true) scheduleFrame();
	}

	function onPointerDown(event: PointerEvent): void {
		if (drag !== null || disposed) return;
		if (!options.canStart()) return;
		const widgets = options.getWidgets();
		if (widgets.length <= 1) return;
		if (event.isPrimary === false) return;
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const target = event.target;
		if (!(target instanceof Element)) return;
		// A press on the actions button (or any interactive control) never
		// starts a drag; a click on it still opens the menu.
		if (target.closest(noDragSelector()) !== null) {
			return;
		}
		const handle = target.closest("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) return;
		const widgetId = handle.getAttribute("data-widget-drag-handle");
		if (widgetId === null || widgetId === "") return;
		const grid = options.getGrid();
		if (grid === undefined) return;
		const article = articleWithId(grid, widgetId);
		if (article === null) return;
		const serverIds = widgets.map((entry) => entry.widgetId);
		const fromIndex = serverIds.indexOf(widgetId);
		if (fromIndex < 0) return;
		const current = widgets.find((entry) => entry.widgetId === widgetId);
		if (current === undefined) return;
		const box = article.getBoundingClientRect();
		drag = {
			widgetId,
			pointerId: event.pointerId,
			pressX: event.clientX,
			pressY: event.clientY,
			grabDX: event.clientX - box.left,
			grabDY: event.clientY - box.top,
			width: box.width,
			height: box.height,
			fromIndex,
			article,
			grid,
			draggedSize: current.size,
			started: false,
			preview: [...serverIds],
			target: fromIndex,
			banned: null,
			slots: [],
			scroller: null,
			lastClientX: event.clientX,
			lastClientY: event.clientY,
			raf: 0,
			placeholder: null,
		};
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", onBlur);
		window.addEventListener("scroll", onScroll, true);
	}

	function dispose(): void {
		disposed = true;
		disarmClickGuard();
		removeListeners();
		if (drag !== null) {
			resetDom();
			drag = null;
		}
	}

	function clearPreview(): void {
		const grid = options.getGrid();
		if (grid !== undefined) clearGridOrders(grid);
	}

	return { onPointerDown, dispose, clearPreview, cancel };
}
