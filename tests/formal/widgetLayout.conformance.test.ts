import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyWidgetLayoutEdit } from "@research/widget-grid/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Conformance between the widget-grid layout edits and the Lean 4 dashboard
 * model in `formal/`. The theorems in `formal/ResearchFormal/*.lean` are
 * about Lean definitions, not about this TypeScript. What connects them is
 * `formal/vectors.json`: the Lean executable `export-vectors` evaluates the
 * *verified* definitions over exhaustive small grids, and every vector is
 * replayed here against `applyWidgetLayoutEdit` (as well as against
 * `applyDashboardEdit` in `conformance.test.ts`). A divergence between model
 * and code fails this suite.
 *
 * `resize` keeps every id in place and `add` at a position is `add` followed
 * by `reorder`, so neither needs a new operation in the model: only the four
 * modelled edit kinds appear in the vectors.
 */
const vectorsSchema = z.object({
	dashboard: z.array(
		z.object({
			dashboard: z.array(z.number()),
			edit: z.object({ kind: z.string(), id: z.number(), toIndex: z.number().optional() }),
			accepted: z.boolean(),
			ids: z.array(z.number()),
		}),
	),
});

const vectors = vectorsSchema.parse(
	JSON.parse(
		readFileSync(fileURLToPath(new URL("../../formal/vectors.json", import.meta.url)), "utf8"),
	),
);

describe("Lean model conformance: widget-grid layout edits", () => {
	const widgetId = (id: number) => `w${id}`;
	const toWidgets = (ids: readonly number[]) =>
		ids.map((id) => ({
			widgetId: widgetId(id),
			type: "metric",
			title: `Widget ${id}`,
			size: "small" as const,
		}));

	it(`reaches the model's accept/reject and final ids on all ${vectors.dashboard.length} vectors`, () => {
		expect(vectors.dashboard.length).toBe(612);
		for (const vector of vectors.dashboard) {
			const widgets = toWidgets(vector.dashboard);
			const label = JSON.stringify(vector);
			const id = widgetId(vector.edit.id);
			const edit = (() => {
				switch (vector.edit.kind) {
					case "add":
						return {
							kind: "add" as const,
							widget: {
								widgetId: id,
								type: "metric",
								title: `Widget ${vector.edit.id}`,
								size: "small" as const,
							},
						};
					case "remove":
						return { kind: "remove" as const, widgetId: id };
					case "moveEarlier":
						return { kind: "move" as const, widgetId: id, direction: "earlier" as const };
					case "moveLater":
						return { kind: "move" as const, widgetId: id, direction: "later" as const };
					case "reorder": {
						if (vector.edit.toIndex === undefined) {
							throw new Error(`reorder vector without toIndex: ${label}`);
						}
						return { kind: "reorder" as const, widgetId: id, toIndex: vector.edit.toIndex };
					}
					default:
						throw new Error(`unknown dashboard edit kind: ${label}`);
				}
			})();
			const result = applyWidgetLayoutEdit(widgets, edit, { maxWidgets: 24 });
			expect(result.ok, label).toBe(vector.accepted);
			const ids = result.ok
				? result.value.map((widget) => widget.widgetId)
				: widgets.map((widget) => widget.widgetId);
			expect(ids, label).toEqual(vector.ids.map(widgetId));
		}
	});
});
