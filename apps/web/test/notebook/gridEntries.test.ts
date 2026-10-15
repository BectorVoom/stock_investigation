import type { NotebookWidget } from "@research/contracts";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createWidgetGridEntries } from "../../src/widgets/gridEntries.ts";

function textWidget(widgetId: string, text: string, revision = 1): NotebookWidget {
	return {
		widgetId,
		type: "text",
		title: `Note ${widgetId}`,
		size: "small",
		text,
		createdAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
		revision,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

describe("notebook grid entries", () => {
	it("keep one entry per widget id while the widget is replaced, reordered and removed", () => {
		createRoot((dispose) => {
			const [widgets, setWidgets] = createSignal<readonly NotebookWidget[]>([
				textWidget("a", "first"),
				textWidget("b", "second"),
			]);
			const entries = createWidgetGridEntries(widgets);
			const [a, b] = entries();
			if (a === undefined || b === undefined) throw new Error("two entries expected");

			// A saved edit: a new object and revision, same id.
			setWidgets([{ ...textWidget("a", "edited", 2), size: "large" }, textWidget("b", "second")]);
			expect(entries()[0]).toBe(a);
			expect(a.size).toBe("large");
			expect(a.widget.type === "text" ? a.widget.text : null).toBe("edited");

			// A reorder moves the same entries.
			setWidgets([textWidget("b", "second"), textWidget("a", "edited", 2)]);
			expect(entries()).toEqual([b, a]);

			// A removed id is forgotten: re-adding it makes a fresh entry.
			setWidgets([textWidget("b", "second")]);
			expect(entries()).toEqual([b]);
			setWidgets([textWidget("b", "second"), textWidget("a", "back", 3)]);
			expect(entries()[1]).not.toBe(a);
			expect(entries()[1]?.title).toBe("Note a");
			dispose();
		});
	});
});
