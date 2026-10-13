import { describe, expect, it } from "vitest";
import { nextDropTarget, type SlotRect } from "../src/home/dragModel.ts";

/**
 * Hand-worked 4-column grid with mixed sizes (100 px cells, 16 px gap):
 * two smalls, one medium 2×2, two smalls, one large full-width ×2.
 */
const SLOTS: readonly SlotRect[] = [
	{ left: 0, top: 0, right: 100, bottom: 100 }, // 0 small A
	{ left: 116, top: 0, right: 216, bottom: 100 }, // 1 small B
	{ left: 232, top: 0, right: 448, bottom: 216 }, // 2 medium C
	{ left: 0, top: 116, right: 100, bottom: 216 }, // 3 small D
	{ left: 116, top: 116, right: 216, bottom: 216 }, // 4 small E
	{ left: 0, top: 232, right: 448, bottom: 464 }, // 5 large F
];

describe("nextDropTarget", () => {
	it("holds before the midpoint and moves after it when travelling forward", () => {
		const prev = { target: 0, banned: null };
		// Just inside B (left edge), before B's center (166,50).
		const before = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 120, y: 50 },
			previous: prev,
		});
		expect(before.target).toBe(0);
		// Past B's center.
		const after = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 180, y: 50 },
			previous: prev,
		});
		expect(after.target).toBe(1);
		expect(after.banned).toBe(0);
	});

	it("holds before the midpoint when travelling backward", () => {
		const prev = { target: 1, banned: null };
		// Inside A but past A's center away from B is the far left; a pointer
		// just inside A's right edge has not crossed in the backward direction.
		const before = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 1,
			pointer: { x: 95, y: 50 },
			previous: prev,
		});
		expect(before.target).toBe(1);
		const after = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 1,
			pointer: { x: 20, y: 50 },
			previous: prev,
		});
		expect(after.target).toBe(0);
	});

	it("holds in gaps and outside every slot", () => {
		const prev = { target: 0, banned: null };
		for (const pointer of [
			{ x: 108, y: 50 }, // gap between A and B
			{ x: -50, y: -50 }, // outside
			{ x: 500, y: 500 }, // outside
		]) {
			expect(
				nextDropTarget({ slots: SLOTS, draggedIndex: 0, pointer, previous: prev }).target,
			).toBe(0);
		}
	});

	it("ignores the just-swapped slot until the pointer leaves it", () => {
		// Just swapped 0 -> 1: dragged now at 1, banned 0.
		const swapped = { target: 1, banned: 0 };
		// Pointer back inside slot 0 (the swapped widget): ignored.
		const held = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 1,
			pointer: { x: 50, y: 50 },
			previous: swapped,
		});
		expect(held.target).toBe(1);
		expect(held.banned).toBe(0);
		// Pointer over the dragged slot itself (slot 1 center): hold target
		// and release the ban once slot 0 is left.
		const released = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 1,
			pointer: { x: 166, y: 50 },
			previous: swapped,
		});
		expect(released.target).toBe(1);
		expect(released.banned).toBeNull();
	});

	it("a small dragged over a medium needs to pass the medium center", () => {
		const prev = { target: 0, banned: null };
		// Medium C center is (340,108). Edge entry is not enough.
		const edge = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 240, y: 10 },
			previous: prev,
		});
		expect(edge.target).toBe(0);
		const deep = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 400, y: 150 },
			previous: prev,
		});
		expect(deep.target).toBe(2);
	});

	it("a medium dragged over a small needs to pass the small center", () => {
		const prev = { target: 2, banned: null };
		// Small A center is (50,50); dragged medium center is (340,108).
		// A pointer just inside A's far edge (right side, towards the medium)
		// has not crossed past A's center away from the medium.
		const edge = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 2,
			pointer: { x: 95, y: 50 },
			previous: prev,
		});
		expect(edge.target).toBe(2);
		const deep = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 2,
			pointer: { x: 10, y: 50 },
			previous: prev,
		});
		expect(deep.target).toBe(0);
	});

	it("a small dragged onto a large needs to pass the large center", () => {
		const prev = { target: 0, banned: null };
		// Large F center is (224,348).
		const edge = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 10, y: 240 },
			previous: prev,
		});
		expect(edge.target).toBe(0);
		const deep = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 300, y: 400 },
			previous: prev,
		});
		expect(deep.target).toBe(5);
	});

	it("is stable when resting on a boundary: repeated calls do not oscillate", () => {
		// Pointer resting just past B's center while dragging A: first call
		// moves 0 -> 1 with ban 0; the next call (same pointer, new preview
		// coordinates where dragged is at 1) must hold at 1.
		const first = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 0,
			pointer: { x: 180, y: 50 },
			previous: { target: 0, banned: null },
		});
		expect(first.target).toBe(1);
		// In the new preview order the slots are re-measured; model the same
		// geometry with draggedIndex updated: pointer over slot 1 (own slot).
		const second = nextDropTarget({
			slots: SLOTS,
			draggedIndex: 1,
			pointer: { x: 180, y: 50 },
			previous: first,
		});
		expect(second.target).toBe(1);
	});

	it("holds still with one or zero slots and with a bad dragged index", () => {
		expect(
			nextDropTarget({
				slots: [],
				draggedIndex: 0,
				pointer: { x: 50, y: 50 },
				previous: { target: 0, banned: null },
			}).target,
		).toBe(0);
		expect(
			nextDropTarget({
				slots: SLOTS.slice(0, 1),
				draggedIndex: 0,
				pointer: { x: 50, y: 50 },
				previous: { target: 0, banned: null },
			}).target,
		).toBe(0);
		expect(
			nextDropTarget({
				slots: SLOTS,
				draggedIndex: 99,
				pointer: { x: 180, y: 50 },
				previous: { target: 1, banned: null },
			}).target,
		).toBe(1);
	});
});
