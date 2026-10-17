/**
 * Vectors for the widget rules the notebook path runs after decoding
 * (`reconcileChartDraft`, `withEarnedChartProvenance`,
 * `notebookCapacityProblem`, `notebookContentBytes`): a seeded corpus of
 * chart drafts and before/after widget lists, outputs from the real
 * TypeScript.
 */
import {
	notebookCapacityProblem,
	notebookContentBytes,
	notebookWidgetSchema,
	reconcileChartDraft,
	type WidgetCore,
	widgetCoreSchema,
	withEarnedChartProvenance,
} from "../../../packages/contracts/src/index.ts";
import * as fx from "../../../packages/contracts/test/fixtures.ts";
import { seededRandom } from "../shared.ts";

type Random = () => number;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function pick<T>(random: Random, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)] as T;
}

const EVIDENCE_IDS = ["ev_1", "ev_2", "ev_3"];

function evidenceCopy(id: string): Json {
	return JSON.parse(JSON.stringify({ ...fx.evidence, evidenceId: id })) as Json;
}

function point(random: Random): Json {
	const out: Record<string, Json> = {
		x: pick(random, ["2024", "2025", "2026", " Q1 "]),
		y: pick(random, [1, 2.5, -0, 1e21, 3]),
	};
	const roll = random();
	if (roll < 0.25) out.basis = pick(random, ["assumption", "derived"]);
	else if (roll < 0.55) {
		out.sourceId = pick(random, EVIDENCE_IDS);
		out.asOf = pick(random, ["2026-10-01", "2026-10-01T00:00:00Z"]);
	} else if (roll < 0.6) out.asOf = "2026-10-02";
	return out;
}

function chartDraft(random: Random, widgetId: string): Record<string, Json> {
	const series = Array.from({ length: 1 + Math.floor(random() * 2) }, () => ({
		name: pick(random, ["Base", "Bull", "Base"]),
		points: Array.from({ length: 1 + Math.floor(random() * 4) }, () => point(random)),
	}));
	const out: Record<string, Json> = {
		widgetId,
		title: "Chart",
		size: "medium",
		type: "chart",
		chartType: pick(random, ["line", "bar"]),
		unit: pick(random, ["GWh", "%"]),
		series,
	};
	if (random() < 0.3) out.xLabel = "Year";
	if (random() < 0.3) out.yLabel = "GWh";
	if (random() < 0.3) out.xKind = pick(random, ["text", "date", "number"]);
	if (random() < 0.5) out.sourceIds = EVIDENCE_IDS.filter(() => random() < 0.5);
	if (random() < 0.6) out.sources = EVIDENCE_IDS.filter(() => random() < 0.6).map(evidenceCopy);
	if (random() < 0.1) out.sources = [evidenceCopy("ev_1"), evidenceCopy("ev_1")];
	return out;
}

/** A valid chart core: the draft reconciled (so citations and copies agree). */
function chartCore(random: Random, widgetId: string): WidgetCore | null {
	const parsed = widgetCoreSchema.safeParse(reconcileChartDraft(chartDraft(random, widgetId)));
	return parsed.success ? parsed.data : null;
}

function edited(random: Random, chart: WidgetCore): WidgetCore {
	const copy = JSON.parse(JSON.stringify(chart)) as Record<string, Json>;
	const roll = random();
	if (roll < 0.2) copy.unit = "kWh";
	else if (roll < 0.35) copy.widgetId = `${String(copy.widgetId)}-copy`;
	else if (roll < 0.55) {
		const series = copy.series as { points: { y: number }[] }[];
		const first = series[0]?.points[0];
		if (first !== undefined) first.y += 1;
	} else if (roll < 0.65) copy.xLabel = "Period";
	else if (roll < 0.75) delete copy.sourceIds;
	const parsed = widgetCoreSchema.safeParse(reconcileChartDraft(copy));
	return parsed.success ? parsed.data : chart;
}

const TEXT_CORE = {
	widgetId: "w-t",
	type: "text",
	title: "Notes",
	size: "medium",
	text: "hello",
} as const;

function marketCore(index: number, seriesCount: number): Json {
	return {
		widgetId: `m-${index}`,
		type: "stock-table",
		title: "S",
		size: "small",
		seriesIds: Array.from({ length: seriesCount }, (_, offset) => `fred:S${index * 12 + offset}`),
	};
}

function stored(core: Json): Json {
	return {
		...(core as Record<string, Json>),
		createdAt: "2026-10-14T00:00:00.000Z",
		updatedAt: "2026-10-14T00:00:00.000Z",
		revision: 2,
		origin: { kind: "assistant", messageId: null, runId: "run_1", componentId: null },
	};
}

export function functionVectors(): Json {
	const random = seededRandom(0x0c4a27);
	const reconcile: Json[] = [];
	for (let index = 0; index < 400; index += 1) {
		const draft = chartDraft(random, `w-${index}`);
		if (index % 17 === 0) draft.unknownKey = 1;
		if (index % 23 === 0) draft.type = "table";
		reconcile.push({ input: draft, output: reconcileChartDraft(draft) as Json });
	}
	reconcile.push({
		input: JSON.parse(JSON.stringify(TEXT_CORE)) as Json,
		output: reconcileChartDraft(TEXT_CORE) as Json,
	});
	const earned: Json[] = [];
	for (let index = 0; index < 400; index += 1) {
		const previous = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, offset) =>
			chartCore(random, `w-${offset}`),
		).filter((chart): chart is WidgetCore => chart !== null);
		const next: WidgetCore[] = previous.map((chart) =>
			random() < 0.7 ? edited(random, chart) : chart,
		);
		if (random() < 0.3) {
			const fresh = chartCore(random, "w-new");
			if (fresh !== null) next.push(fresh);
		}
		if (random() < 0.2 && previous[0] !== undefined)
			next.push({ ...previous[0], widgetId: "w-dup" });
		next.push(widgetCoreSchema.parse(TEXT_CORE));
		earned.push({
			next: next as unknown as Json,
			previous: previous as unknown as Json,
			output: withEarnedChartProvenance(next, previous) as unknown as Json,
		});
	}
	const capacity: Json[] = [];
	const scenarios: [Json[], Json[]][] = [
		[Array.from({ length: 200 }, (_, index) => ({ ...TEXT_CORE, widgetId: `w${index}` })), []],
		[Array.from({ length: 201 }, (_, index) => ({ ...TEXT_CORE, widgetId: `w${index}` })), []],
		[[marketCore(0, 12), marketCore(1, 12), marketCore(2, 6)], []],
		[[marketCore(0, 12), marketCore(1, 12), marketCore(2, 7)], []],
		[
			[marketCore(0, 12), marketCore(1, 12), marketCore(2, 7)],
			[marketCore(0, 12), marketCore(1, 12), marketCore(2, 7)],
		],
	];
	for (const [nextCores, previousCores] of scenarios) {
		const next = nextCores.map((core) => widgetCoreSchema.parse(core));
		const previous = previousCores.map((core) => notebookWidgetSchema.parse(stored(core)));
		capacity.push({
			next: next as unknown as Json,
			previous: previous as unknown as Json,
			output: notebookCapacityProblem(next, previous) as unknown as Json,
		});
	}
	// Byte-cap boundaries are rebuilt by the replay from this recipe (text
	// widgets `t-<i>` of `chars` × "あ"), so megabytes are not committed.
	const bigText = (index: number, chars: number): Json => ({
		widgetId: `t-${index}`,
		type: "text",
		title: "T",
		size: "large",
		text: "あ".repeat(chars),
	});
	const recipes: [number, number, number][] = [
		[35, 0, 7900],
		[37, 0, 7900],
		[37, 37, 7900],
		[37, 38, 7900],
		[37, 36, 7900],
	];
	const bytes: Json[] = [];
	for (const [nextCount, previousCount, chars] of recipes) {
		const next = Array.from({ length: nextCount }, (_, index) =>
			widgetCoreSchema.parse(bigText(index, chars)),
		);
		const previous = Array.from({ length: previousCount }, (_, index) =>
			notebookWidgetSchema.parse(stored(bigText(index, chars))),
		);
		bytes.push({
			nextCount,
			previousCount,
			chars,
			output: notebookCapacityProblem(next, previous) as unknown as Json,
			nextBytes: notebookContentBytes(next),
			previousBytes: notebookContentBytes(previous),
		});
	}
	return {
		reconcileChartDraft: reconcile,
		withEarnedChartProvenance: earned,
		notebookCapacityProblem: capacity,
		contentBytes: bytes,
	};
}
