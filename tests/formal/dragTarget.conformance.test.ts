import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextDropTarget } from "@research/widget-grid/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between `nextDropTarget` (`@research/widget-grid/core`) and
 * the Lean 4 model in `formal/ResearchFormal/DragTarget.lean`.
 *
 * `formal/Export.lean` evaluates the verified definition over an exhaustive
 * small grid (2,943 vectors) and every vector is replayed here against the
 * implementation. All coordinates are integral, so the model's doubled
 * centers agree exactly with the TypeScript midpoints. A divergence between
 * model and code fails this suite.
 */
const slotRect = z.object({
	left: z.number(),
	top: z.number(),
	right: z.number(),
	bottom: z.number(),
});

const dragHistory = z.object({
	target: z.number(),
	banned: z.number().nullable(),
});

const dragTargetVectors = z.object({
	dragTarget: z.array(
		z.object({
			slots: z.array(slotRect),
			draggedIndex: z.number(),
			pointer: z.object({ x: z.number(), y: z.number() }),
			previous: dragHistory,
			target: z.number(),
			banned: z.number().nullable(),
		}),
	),
});

const vectors = dragTargetVectors.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

describe("Lean model conformance: drop-target decision", () => {
	it(`agrees with nextDropTarget on all ${vectors.dragTarget.length} vectors`, () => {
		expect(vectors.dragTarget.length).toBe(2943);
		for (const vector of vectors.dragTarget) {
			const result = nextDropTarget({
				slots: vector.slots,
				draggedIndex: vector.draggedIndex,
				pointer: vector.pointer,
				previous: vector.previous,
			});
			const label = JSON.stringify(vector);
			expect(result.target, label).toBe(vector.target);
			expect(result.banned, label).toBe(vector.banned);
		}
	});
});
