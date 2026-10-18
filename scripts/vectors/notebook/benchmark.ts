/** Same workload as scripts/bench.ts, kept as data for Rust timing guards. */
import { type NotebookWidget, notebookSchema } from "@research/contracts";
/** Four 6 x 400-point charts with provenance, and a maximal reply that rewrites each. */
export function heavyChartsNotebook() {
	const series = (bump: number) =>
		Array.from({ length: 6 }, (_, s) => ({
			name: `S${s}`,
			points: Array.from({ length: 400 }, (_, i) => ({
				x: `p${i}`,
				y: i * 1.5 + 0.1 + (i === 0 && s === 0 ? bump : 0),
				basis: "derived" as const,
			})),
		}));
	const widgets = Array.from({ length: 4 }, (_, i) => ({
		widgetId: `c${i}`,
		title: `Heavy chart ${i}`,
		size: "medium" as const,
		createdAt: "2026-10-14T00:00:00.000Z",
		updatedAt: "2026-10-14T00:00:00.000Z",
		revision: 1,
		origin: { kind: "owner" as const, messageId: null, runId: null, componentId: null },
		type: "chart" as const,
		chartType: "line" as const,
		unit: "USD",
		series: series(0),
	}));
	return {
		notebook: notebookSchema.parse({ widgets }),
		commands: widgets.map((w) => ({
			kind: "update",
			widgetId: w.widgetId,
			config: { series: series(1) },
		})),
	};
}

export function benchmarkNotebook() {
	const widgets: NotebookWidget[] = Array.from({ length: 200 }, (_, index) => {
		const base = {
			widgetId: `nb_bench_${index}`,
			title: `Bench widget ${index} with a realistic title`,
			size: "medium",
			createdAt: "2026-10-14T00:00:00.000Z",
			updatedAt: "2026-10-14T00:00:00.000Z",
			revision: 3,
			origin: { kind: "chat", messageId: "msg_bench", runId: "run_bench", componentId: null },
		} satisfies Omit<NotebookWidget, "type">;
		switch (index % 4) {
			case 0:
				return {
					...base,
					type: "text",
					text: `${"Notes on margins and guidance. ".repeat(130)}${index}`,
				};
			case 1:
				return {
					...base,
					type: "table",
					columns: Array.from({ length: 12 }, (_, column) => `Column ${column}`),
					rows: Array.from({ length: 30 }, (_, row) =>
						Array.from({ length: 12 }, (_, column) =>
							column % 2 === 0 ? `cell ${row}-${column} text` : row * column + 0.25,
						),
					),
				};
			case 2:
				return {
					...base,
					type: "chart",
					chartType: "line",
					unit: "JPY bn",
					series: Array.from({ length: 2 }, (_, series) => ({
						name: `Series ${series}`,
						points: Array.from({ length: 100 }, (_, point) => ({
							x: `2026-Q${point}`,
							y: point * 1.5,
						})),
					})),
				};
			default:
				return {
					...base,
					type: "metric",
					value: index * 10.5,
					unit: "%",
					change: 0.4,
					caption: "Operating margin, trailing twelve months",
					asOf: "2026-10-14",
				};
		}
	});
	return {
		notebook: notebookSchema.parse({ widgets }),
		commands: [
			{ kind: "update", widgetId: "nb_bench_0", config: { text: "Rewritten." } },
			{ kind: "resize", widgetId: "nb_bench_1", size: "large" },
			{ kind: "reorder", widgetId: "nb_bench_2", toIndex: 198 },
			{ kind: "move", widgetId: "nb_bench_3", direction: "later" },
			{ kind: "duplicate", widgetId: "nb_bench_5" },
			{ kind: "update", widgetId: "nb_bench_9", title: "Renamed" },
			{ kind: "resize", widgetId: "nb_bench_198", size: "small" },
			{ kind: "reorder", widgetId: "nb_bench_197", toIndex: 0 },
			{ kind: "update", widgetId: "nb_bench_4", config: { text: "Also rewritten." } },
			{ kind: "move", widgetId: "nb_bench_100", direction: "earlier" },
			{ kind: "resize", widgetId: "nb_bench_50", size: "large" },
			{ kind: "reorder", widgetId: "nb_bench_60", toIndex: 120 },
		],
	};
}
