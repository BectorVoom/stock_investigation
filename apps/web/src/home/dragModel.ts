/**
 * Pure drag decision for Home widget reordering (FR-017). No DOM, no clock:
 * given the slot rectangles in the current preview order, the dragged index,
 * the pointer point and the previous decision, return the next target index.
 *
 * Order-based reflow (not free placement): the preview order is a permutation
 * of the widget ids, the dragged widget ends at `toIndex` of the result and
 * the others keep their order (`applyDashboardEdit` reorder semantics).
 *
 * Stability (HIG destination feedback must not flip-flop when a small widget
 * is dragged over a medium/large one or the reverse): the target changes only
 * when the pointer has crossed the midpoint of another slot IN THE DIRECTION
 * OF TRAVEL, and the slot just left is ignored until the pointer leaves it.
 * Midpoint crossing is measured as the dot product of (pointer - hoverCenter)
 * with (hoverCenter - draggedCenter): positive means the pointer is past the
 * hover center away from the dragged slot. The `banned` index is the preview
 * position just vacated (now holding the swapped widget); while the pointer
 * stays inside it, a move back to it is ignored. Once the pointer leaves it,
 * the ban clears.
 *
 * O(n) per pointer move: one pass to find the hovered slot, constant work
 * after. At most 24 widgets.
 */

export interface DragPoint {
	readonly x: number;
	readonly y: number;
}

export interface SlotRect {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface DragHistory {
	/** Preview position of the dragged widget after the last decision. */
	readonly target: number;
	/** Preview position to ignore until the pointer leaves it, or null. */
	readonly banned: number | null;
}

export interface DropTargetInput {
	/** Slot rectangles in the current preview order (length n). */
	readonly slots: readonly SlotRect[];
	/** Current preview position of the dragged widget. */
	readonly draggedIndex: number;
	readonly pointer: DragPoint;
	readonly previous: DragHistory;
}

function contains(rect: SlotRect, point: DragPoint): boolean {
	return (
		point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
	);
}

function center(rect: SlotRect): DragPoint {
	return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function bannedStillHeld(
	slots: readonly SlotRect[],
	banned: number | null,
	pointer: DragPoint,
): number | null {
	if (banned === null) return null;
	const rect = slots[banned];
	if (rect === undefined) return null;
	return contains(rect, pointer) ? banned : null;
}

/**
 * The next drop target. Returns `{ target, banned }` in the SAME preview
 * coordinates as the input `slots`: `target` is where the dragged widget
 * belongs, `banned` is the slot to ignore until the pointer leaves it.
 */
export function nextDropTarget(input: DropTargetInput): DragHistory {
	const { slots, draggedIndex, pointer, previous } = input;
	const count = slots.length;
	if (count <= 1)
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	if (draggedIndex < 0 || draggedIndex >= count) {
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	}

	let hover: number | null = null;
	for (let index = 0; index < count; index += 1) {
		const rect = slots[index];
		if (rect === undefined) continue;
		if (contains(rect, pointer)) {
			hover = index;
			break;
		}
	}

	// In a gap or outside every slot: hold the current target, and release
	// the ban once the pointer has left the banned slot.
	if (hover === null) {
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	}
	// Over the dragged slot itself: hold, releasing the ban when left.
	if (hover === draggedIndex) {
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	}
	// Hysteresis: ignore the widget just swapped with until left.
	if (previous.banned !== null && hover === previous.banned) {
		return { target: previous.target, banned: previous.banned };
	}

	const draggedRect = slots[draggedIndex];
	const hoverRect = slots[hover];
	if (draggedRect === undefined || hoverRect === undefined) {
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	}
	const draggedCenter = center(draggedRect);
	const hoverCenter = center(hoverRect);
	const vx = hoverCenter.x - draggedCenter.x;
	const vy = hoverCenter.y - draggedCenter.y;
	// Coincident centers (should not happen for distinct slots): allow the move.
	if (vx === 0 && vy === 0) {
		return { target: hover, banned: draggedIndex };
	}
	const wx = pointer.x - hoverCenter.x;
	const wy = pointer.y - hoverCenter.y;
	// Past the midpoint away from the dragged slot: cross in travel direction.
	if (vx * wx + vy * wy <= 0) {
		return { target: previous.target, banned: bannedStillHeld(slots, previous.banned, pointer) };
	}
	// Commit: the vacated preview position now holds the swapped widget, so
	// ban it (in the NEW preview coordinates the next call will use) until left.
	return { target: hover, banned: draggedIndex };
}
