/**
 * Micro-benchmarks for the hot paths that run inside the Worker's CPU budget
 * (10 ms per request on Workers Free) or on every poll. Performance work in
 * this repository is driven by these measurements, not by guesses:
 *
 *     bun run bench
 *
 * Each case reports the median time of one call at a realistic worst-case size.
 */

import { extractJsonObject } from "@research/agent-core";
import {
	applyNotebookCommands,
	checkBundleIntegrity,
	createHomeService,
	homeDataDigestEtag,
	notebookAssistPrompt,
	stampNotebook,
	stockDirectoryRows,
} from "@research/application";
import {
	BASELINE_COMPONENT_DEFINITIONS,
	completeJobRequestSchema,
	createComponentCatalog,
	type HomeDashboard,
	homeDataResponseSchema,
	NOTEBOOK_LIMITS,
	type Notebook,
	type NotebookWidget,
	notebookContentBytes,
	notebookSchema,
	type ResearchBundle,
	researchBundleSchema,
	type StockDirectoryEntry,
	WIDGET_LIMITS,
	type WidgetCore,
} from "@research/contracts";
import {
	applyDashboardEdit,
	applyUiCommand,
	buildEarningsCalendar,
	buildMonthGrid,
	type CommandContext,
	canonicalGoogleSyncDigestInput,
	canonicalizeArticleUrl,
	changeOverOneYear,
	classifyIpAddress,
	type Dashboard,
	type DraftClaim,
	emptyWorkspaceState,
	type GoogleEventBody,
	googleEventBody,
	groupEventsByDate,
	latestChange,
	type ManagedGoogleEvent,
	type MarketPoint,
	movingAverage,
	normalizeFeed,
	planGoogleSync,
	type RawFeed,
	resampleSeries,
	verifyClaims,
	visibleSlice,
	type WorkspaceState,
	windowStats,
} from "@research/domain";
import { createWidgetAgentHost, parseWidgetCommand } from "@research/widget-grid/agent";
import {
	applyWidgetLayoutEdit,
	nextDropTarget,
	ok,
	type WidgetSize,
} from "@research/widget-grid/core";
import { modelToPm, pmToModel } from "../apps/web/src/notebook/richText/docConvert.ts";
import { parseRichText } from "../apps/web/src/notebook/richText/parser.ts";
import { serializeRichText } from "../apps/web/src/notebook/richText/serializer.ts";
import { parseJpxWorkbook } from "../packages/adapters/src/finance/jpxWorkbook.ts";
import { htmlToMarkdown } from "../packages/adapters/src/tools/htmlToMarkdown.ts";
import { seriesColor } from "../packages/ui-registry/src/charts/chartMath.ts";
import {
	chartWidgetSeries,
	chartWidgetToGuardedDataset,
} from "../packages/ui-registry/src/charts/chartWidgetDataset.ts";
import {
	type BuildDetailChartInput,
	buildDetailChartModel,
	buildNavigatorOverview,
	type DetailMaOverlayInput,
	ensureTwoBarWindow,
	navigatorWindowRect,
	unionBarDays,
	unionOverview,
} from "../packages/ui-registry/src/charts/detailChartModel.ts";
import { buildHomeLineModel } from "../packages/ui-registry/src/charts/homeLineModel.ts";
import { buildLineModel } from "../packages/ui-registry/src/charts/lineModel.ts";

interface Case {
	readonly name: string;
	readonly budgetMs: number;
	readonly run: () => unknown;
}

const RUN_ID = "run_bench";
const id = (suffix: string) => `${RUN_ID}_${suffix}`;
const SENTENCE = "Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier. ";

/* ----- Fixtures at the contract's upper bounds ----- */

const evidenceTexts = Array.from({ length: 80 }, (_, index) => ({
	evidenceId: id(`ev${index}`),
	retrievedText: `${SENTENCE.repeat(48)} Item ${index} shipped ${index * 7 + 3} units.`,
}));
const draftClaims: DraftClaim[] = Array.from({ length: 80 }, (_, index) => ({
	claimId: id(`cl${index}`),
	text: `Item ${index % 80} shipped ${(index % 80) * 7 + 3} units in 2026.`,
	claimType: "observation",
	links: Array.from({ length: 6 }, (_, link) => ({
		evidenceId: id(`ev${(index + link) % 80}`),
		relation: "supports",
		quote: "Orders for grid storage reached 100 GWh in 2026",
	})),
}));

const feed: RawFeed = {
	kind: "rss",
	title: "Bench feed",
	siteLink: null,
	items: Array.from({ length: 100 }, (_, index) => ({
		title: `Story <b>number</b> ${index} &amp; more`,
		link: `https://news.example.org/a/${index}?utm_source=rss&b=2&a=1#frag`,
		publishedText: "Thu, 01 Oct 2026 09:00:00 GMT",
		summaryText: `<p>${SENTENCE.repeat(6)}</p><script>ignored()</script>`,
	})),
};

const catalog = createComponentCatalog(BASELINE_COMPONENT_DEFINITIONS);
const context: CommandContext = {
	validateProps: catalog.validateProps,
	knownDatasetRefs: { has: () => true },
	knownSourceIds: { has: () => true },
	knownClaims: new Map(),
	maxComponents: 40,
};
let workspace: WorkspaceState = emptyWorkspaceState("ws");
for (let index = 0; index < 40; index += 1) {
	const applied = applyUiCommand(
		workspace,
		{
			protocolVersion: 1,
			commandId: `c${index}`,
			workspaceId: "ws",
			expectedWorkspaceVersion: workspace.version,
			operation: "component.create",
			componentId: `table${index}`,
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: `Table ${index}`, datasetRef: `ds${index}`, sourceIds: ["ev1", "ev2"] },
		},
		context,
	);
	if (!applied.ok) throw new Error("benchmark fixture: create failed");
	workspace = applied.value;
}
const fullWorkspace = workspace;
const reversed = [...fullWorkspace.layout.order].reverse();

/* A dashboard at the contract bound (`DASHBOARD_LIMITS.maxWidgets`). */
const reorderBenchDashboard: Dashboard = {
	schemaVersion: 2,
	widgets: Array.from({ length: 24 }, (_, widget) => ({
		type: "market-metric" as const,
		widgetId: `w-bench-${widget}`,
		title: `Bench widget ${widget}`,
		size: "small" as const,
		seriesId: "fred:VIXCLS",
	})),
};

/* A widget grid at the layout bound (24 widgets): the drag decision runs on
 * every pointer frame during a drag, the edit and the agent path on drop. */
interface GridBenchWidget {
	readonly widgetId: string;
	readonly type: string;
	readonly title: string;
	readonly size: WidgetSize;
}

const gridBenchWidgets: readonly GridBenchWidget[] = Array.from({ length: 24 }, (_, widget) => ({
	widgetId: `w-grid-${widget}`,
	type: "bench",
	title: `Grid widget ${widget}`,
	size: "small",
}));

const gridBenchSlots = Array.from({ length: 24 }, (_, slot) => ({
	left: slot * 116,
	top: 0,
	right: slot * 116 + 100,
	bottom: 100,
}));
const gridBenchHistory = { target: 0, banned: null as number | null };

let gridBenchLive: GridBenchWidget[] = [...gridBenchWidgets];
let gridBenchRevision = 0;
const gridBenchHost = createWidgetAgentHost({
	store: {
		read: async () => ok({ widgets: gridBenchLive, revision: gridBenchRevision }),
		write: async (widgets, revision) => {
			if (revision !== gridBenchRevision) {
				return {
					ok: false as const,
					error: { code: "CONFLICT" as const, message: "the layout changed elsewhere." },
				};
			}
			gridBenchRevision += 1;
			gridBenchLive = [...widgets];
			return ok({ widgets: gridBenchLive, revision: gridBenchRevision });
		},
	},
	types: [
		{
			type: "bench",
			label: "Bench",
			description: "A benchmark widget.",
			defaultSize: "small",
			sizes: ["small", "medium", "large"],
			configSchema: { type: "object" },
			build: (draft) =>
				ok({
					widgetId: draft.widgetId,
					type: "bench",
					title: draft.title,
					size: draft.size,
				}),
			configOf: () => ({}),
		},
	],
	newWidgetId: () => "w-grid-new",
});

const bundle: ResearchBundle = {
	evidence: Array.from({ length: 80 }, (_, index) => ({
		evidenceId: id(`ev${index}`),
		sourceUrl: `https://news.example.org/a/${index}`,
		title: `Evidence ${index}`,
		publisher: "Example News",
		publishedAt: "2026-10-01T00:00:00.000Z",
		retrievedAt: "2026-10-11T00:00:00.000Z",
		effectiveAt: null,
		excerpt: SENTENCE.repeat(5).slice(0, 480),
		checksum: "a".repeat(64),
		sourceClass: "news" as const,
	})),
	claims: Array.from({ length: 80 }, (_, index) => ({
		claimId: id(`cl${index}`),
		text: SENTENCE.repeat(8).slice(0, 900),
		claimType: "observation" as const,
		status: "supported" as const,
		links: Array.from({ length: 6 }, (_, link) => ({
			evidenceId: id(`ev${(index + link) % 80}`),
			relation: "supports" as const,
			quote: SENTENCE.repeat(4).slice(0, 380),
		})),
		issues: [],
	})),
	scenarios: [],
	securities: [],
	supplierLinks: [],
	financialObservations: [],
	positionObservations: [],
	investorFilings: [],
	pricingPower: [],
	// 8 datasets x 47 rows x 8 columns = 3,008 > limit, so 46 rows: 2,944 cells of the 3,000 allowed.
	datasets: Array.from({ length: 8 }, (_, index) => ({
		datasetId: id(`ds${index}`),
		title: `Dataset ${index}`,
		columns: Array.from({ length: 8 }, (_, column) => ({
			key: `c${column}`,
			label: `Column ${column}`,
			kind: "number" as const,
			unit: "units",
		})),
		rows: Array.from({ length: 46 }, (_, row) =>
			Object.fromEntries(
				Array.from({ length: 8 }, (_, column) => [
					`c${column}`,
					{ v: row * column, sourceId: id(`ev${row % 80}`), asOf: "2026-10-01" },
				]),
			),
		),
		createdAt: "2026-10-11T00:00:00.000Z",
	})),
	uiOperations: [],
	answerText: SENTENCE.repeat(40),
	answerClaimIds: [],
	verificationStatus: "partially-verified",
	provenance: {
		agentId: "bench",
		providerModel: null,
		promptVersion: "research-v1",
		toolVersions: {},
		dataCutoffAt: "2026-10-11T00:00:00.000Z",
	},
};
const bundleJson = JSON.stringify(bundle);

const hostileBraces = `${"{".repeat(100_000)}${"}".repeat(100_000)}`;
const proseThenJson = `${"Here is {an} aside. ".repeat(2_000)}${JSON.stringify({ answer: SENTENCE.repeat(50) })}`;

/* A realistic ~1 MB article page: chrome, scripts and styles around long-form content. */
const articleSentence =
	"Grid-scale battery orders doubled year over year to 1,250 units as utilities restocked. ";
const articleParts: string[] = [
	"<html><head><title>Grid battery orders double &amp; margins hold</title><style>p{color:red}</style>",
	'<script>window.tracker="x";</script></head><body><nav><a href="/home">home</a></nav><main><article><h1>Grid battery orders double</h1>',
];
for (let section = 0; section < 1_000; section += 1) {
	articleParts.push(
		`<h2>Section ${section}</h2><p>${articleSentence.repeat(8)}<strong>strong ${section}</strong> <a href="/a/${section}">link ${section}</a></p>`,
		`<ul><li>item ${section} a</li><li>item ${section} b<ul><li>nested ${section}</li></ul></li></ul>`,
		`<table><tr><th>Metric</th><th>Value</th></tr><tr><td>orders|units</td><td>${section}</td></tr></table>`,
		`<blockquote><p>quoted ${section}</p></blockquote><pre>code ${section}\n  indented</pre>`,
	);
}
articleParts.push("</article></main><aside>sidebar</aside><footer>footer</footer></body></html>");
const articleHtml = articleParts.join("");

/* Worst case at the 2 MiB input limit (findings 1–2): 4,000 levels of mixed
 * formatting elements (blockquote/list/item/emphasis) around a 1.8 MiB body.
 * Past the 32-level ceiling every deeper element is flattened, the work budget
 * drops root output past four times maxChars, and the time stays linear in the
 * input size (see the converter header for the argument and one residual). */
const longLine = `x${"y".repeat(1999)}`;
const deepNestingHtml =
	"<blockquote><ul><li><strong><em>".repeat(4_000) +
	`<p>${`${longLine}<br>`.repeat(900)}</p>` +
	"</em></strong></li></ul></blockquote>".repeat(4_000);

/* Worst case at the contract bounds: 30 dashboard series with 800 observations each. */
function homeBenchPoints(series: number, count: number): MarketPoint[] {
	const points: MarketPoint[] = [];
	let value = 100 + (series % 7) * 13;
	let seed = 0x9e3779b9 + series * 101;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff - 0.5;
	};
	let day = Date.UTC(2024, 0, 1);
	for (let index = 0; index < count; index += 1) {
		value = Math.max(1, value + next() * 4);
		const iso = new Date(day).toISOString().slice(0, 10);
		points.push({ observedOn: iso, value: Math.round(value * 100) / 100 });
		day += 86_400_000;
	}
	return points;
}

const HOME_BENCH_SERIES = Array.from({ length: 30 }, (_, series) => ({
	key: `bench-${series}`,
	label: `Bench series ${series}`,
	points: homeBenchPoints(series, 800),
}));

const homeBenchDashboard: HomeDashboard = {
	schemaVersion: 2,
	widgets: Array.from({ length: 10 }, (_, widget) => ({
		type: "stock-table" as const,
		widgetId: `w-bench-${widget}`,
		title: `Bench table ${widget}`,
		size: "medium" as const,
		seriesIds: [0, 1, 2].map((slot) => {
			const series = widget * 3 + slot;
			return series % 2 === 0 ? `fred:SYN${series}` : `twelve-data:SYN${series}`;
		}),
	})),
};

const homeBenchMetas = HOME_BENCH_SERIES.map((entry, series) => {
	const provider = series % 2 === 0 ? ("fred" as const) : ("twelve-data" as const);
	const symbol = `SYN${series}`;
	return {
		seriesId: `${provider}:${symbol}`,
		provider,
		symbol,
		title: entry.label,
		unit: "Index",
		frequency: "daily" as const,
		publisher: provider === "fred" ? "Fred Bench" : "Twelve Bench",
		sourceUrl:
			provider === "fred"
				? `https://fred.stlouisfed.org/series/${symbol}`
				: "https://twelvedata.com/",
		lastRefreshedAt: "2026-10-12T12:00:00Z",
		retrievedAt: "2026-10-12T12:00:00Z",
		unavailableCode: null,
	};
});

const homeBenchObservationsBySeries = new Map(
	homeBenchMetas.map((meta, series) => {
		const entry = HOME_BENCH_SERIES[series];
		if (entry === undefined) throw new Error("benchmark fixture: series missing");
		return [
			meta.seriesId,
			entry.points.map((point) => ({
				seriesId: meta.seriesId,
				observedOn: point.observedOn,
				value: point.value,
			})),
		] as const;
	}),
);

/* Worst case at the contract bounds: a full 50-stock watchlist with 8 events each. */
const ICS_BENCH_EVENTS = Array.from({ length: 50 }, (_, stock) =>
	Array.from({ length: 8 }, (_, event) => ({
		stockId: stock % 2 === 0 ? `us:BENCH${stock}` : `jp:${String(1000 + stock)}`,
		symbol: stock % 2 === 0 ? `BENCH${stock}` : String(1000 + stock),
		name: `Bench Company ${stock} K.K. with a fairly long name, Inc.`,
		periodKey: `2026-q${(event % 4) + 1}-${event}`,
		announcementDate: `2026-${String((event % 9) + 1).padStart(2, "0")}-${String(10 + ((stock + event) % 18))}`,
		fiscalPeriodLabel: `Q${(event % 4) + 1} 2026`,
		fiscalPeriodEnd: null,
		timing: "after-close" as const,
		publisher: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		retrievedAt: "2026-10-12T12:00:00.000Z",
	})),
).flat();

/* Worst case at the contract bounds: 400 desired Google event bodies with
 * deterministic ids plus 400 managed events (half identical, a quarter
 * changed or cancelled, 50 confirmed-but-undesired). Built through the real
 * `googleEventBody` path so the fixture exercises the shared text builder. */
function googleBenchDigest(index: number): number[] {
	const bytes: number[] = [(index & 255) ^ 0x9e, (index >> 8) & 255];
	for (let b = 2; b < 20; b += 1) bytes.push((b * 7 + index * 13 + 3) % 256);
	return bytes;
}
const GOOGLE_BENCH_DESIRED: GoogleEventBody[] = ICS_BENCH_EVENTS.map((event, index) => {
	const body = googleEventBody(event, googleBenchDigest(index));
	if (!body.ok) throw new Error(`benchmark fixture: googleEventBody failed (${body.error})`);
	return body.value;
});
const GOOGLE_BENCH_EXISTING: ManagedGoogleEvent[] = [
	...GOOGLE_BENCH_DESIRED.slice(0, 200).map((body) => ({
		id: body.id,
		status: "confirmed" as const,
		startDate: body.startDate,
		endDate: body.endDate,
		summary: body.summary,
		description: body.description,
	})),
	...GOOGLE_BENCH_DESIRED.slice(200, 300).map((body) => ({
		id: body.id,
		status: "confirmed" as const,
		startDate: body.startDate,
		endDate: body.endDate,
		summary: `${body.summary} (stale)`,
		description: body.description,
	})),
	...GOOGLE_BENCH_DESIRED.slice(300, 350).map((body) => ({
		id: body.id,
		status: "cancelled" as const,
		startDate: body.startDate,
		endDate: body.endDate,
		summary: body.summary,
		description: body.description,
	})),
	...Array.from({ length: 50 }, (_, extra) => ({
		id: `f${extra.toString(32).padStart(31, "0")}`,
		status: "confirmed" as const,
		startDate: "2026-10-29",
		endDate: "2026-10-30",
		summary: "Removed event",
		description: "No longer desired.",
	})),
];
{
	const planned = planGoogleSync(GOOGLE_BENCH_DESIRED, GOOGLE_BENCH_EXISTING);
	if (!planned.ok) throw new Error("benchmark fixture: planGoogleSync failed");
	if (
		planned.value.inserts.length !== 50 ||
		planned.value.updates.length !== 150 ||
		planned.value.deletes.length !== 50 ||
		planned.value.unchanged.length !== 200
	) {
		throw new Error("benchmark fixture: unexpected plan shape");
	}
}
/* A JPX-sized synthetic workbook (~2,900 data rows, ~1 MB of sheet XML) with
 * the observed layout (rows 1–4 titles, row 5 header, data from row 6;
 * numeric/string codes, Undecided rows). The real file is never committed;
 * the parser input is rebuilt per run, like the in-test builders. */
const JPX_BENCH_STRINGS = [
	"決算発表予定日\r\nScheduled Dates for Earnings Announcements",
	"コード\r\nCode",
	"会社名",
	"Issue Name",
	"決算期末\r\nFiscal Year-end",
	"種別",
	"Fiscal Year/Quarter",
	"Market Segment",
	"Toyota Motor Corp.",
	"SoftBank Group Corp.  ",
	"Second quarter",
	"Third quarter",
	"未定_Undecided",
	"130A",
];

function buildJpxBenchWorkbook(): { sheet: string; shared: string } {
	const shared =
		`<?xml version="1.0" encoding="UTF-8"?><sst count="${JPX_BENCH_STRINGS.length}" uniqueCount="${JPX_BENCH_STRINGS.length}">` +
		JPX_BENCH_STRINGS.map((text) => `<si><t>${text}</t></si>`).join("") +
		`</sst>`;
	const parts: string[] = [
		`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>`,
		`<row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row>`,
		`<row r="4"><c r="A4" s="1" t="s"><v>0</v></c></row>`,
		`<row r="5"><c r="A5" s="7" t="s"><v>0</v></c><c r="B5" s="7" t="s"><v>1</v></c>` +
			`<c r="C5" s="7" t="s"><v>2</v></c><c r="D5" s="7" t="s"><v>3</v></c>` +
			`<c r="E5" s="7" t="s"><v>4</v></c><c r="H5" s="7" t="s"><v>5</v></c>` +
			`<c r="I5" s="7" t="s"><v>6</v></c><c r="K5" s="7" t="s"><v>7</v></c></row>`,
	];
	for (let index = 0; index < 2900; index += 1) {
		const number = 6 + index;
		const date =
			index % 17 === 0
				? `<c r="A${number}" s="7" t="s"><v>12</v></c>`
				: `<c r="A${number}" s="6"><v>${46331 + (index % 60)}</v></c>`;
		const code =
			index % 23 === 0
				? `<c r="B${number}" s="7" t="s"><v>13</v></c>`
				: `<c r="B${number}" s="6"><v>${1000 + (index % 8000)}</v></c>`;
		parts.push(
			`<row r="${number}">${date}${code}` +
				`<c r="D${number}" s="7" t="s"><v>${8 + (index % 2)}</v></c>` +
				`<c r="E${number}" s="6"><v>46477</v></c>` +
				`<c r="H${number}" s="7" t="s"><v>5</v></c>` +
				`<c r="I${number}" s="7" t="s"><v>${10 + (index % 2)}</v></c>` +
				`<c r="K${number}" s="7" t="s"><v>7</v></c></row>`,
		);
	}
	parts.push(`</sheetData></worksheet>`);
	return { sheet: parts.join(""), shared };
}

const JPX_BENCH = buildJpxBenchWorkbook();
{
	const parsed = parseJpxWorkbook(JPX_BENCH.sheet, JPX_BENCH.shared);
	if (!parsed.ok) throw new Error(`benchmark fixture: JPX parse failed (${parsed.error})`);
	if (parsed.value.length < 2000) {
		throw new Error(`benchmark fixture: expected ~2,900 JPX rows, got ${parsed.value.length}`);
	}
}

const homeBenchService = createHomeService({
	dashboard: {
		get: async () => ({
			dashboard: homeBenchDashboard,
			version: 4,
			updatedAt: "2026-10-12T12:00:00Z",
		}),
		put: async () => "written" as const,
		reset: async () => ({
			dashboard: homeBenchDashboard,
			version: 5,
			updatedAt: "2026-10-12T12:00:00Z",
		}),
	},
	market: {
		getSeriesMeta: async (_owner, ids) =>
			homeBenchMetas.filter((meta) => ids.includes(meta.seriesId)),
		getLatestObservedOn: async () => new Map(),
		getObservations: async (_owner, ids, limit) =>
			ids.flatMap((id) => (homeBenchObservationsBySeries.get(id) ?? []).slice(-limit)),
		deleteSeriesNotIn: async () => 0,
	},
	jobs: {
		findActiveByKind: async () => null,
		findLatestSuccessAtByKind: async () => "2026-10-12T12:00:00Z",
		findLatestFailureByKind: async () => null,
	} as never,
	notebooks: {
		get: async () => null,
		put: async () => "written" as const,
		getRevision: async () => null,
		listTurns: async () => [],
		listMarketSeriesIds: async () => [],
	},
	clock: { nowMs: () => Date.parse("2026-10-12T12:00:00Z"), nowIso: () => "2026-10-12T12:00:00Z" },
	audit: { record: async () => undefined },
	records: { resolve: async () => ({ datasets: [], evidence: [], claims: [] }) },
});

// A notebook at both maxima: 200 widgets, close to the content byte cap,
// mixing long text, wide tables and multi-series charts.
const NOTEBOOK_BENCH_META = {
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-14T00:00:00.000Z",
	revision: 3,
	origin: { kind: "chat", messageId: "msg_bench", runId: "run_bench", componentId: null },
} as const;
const notebookBenchWidgets: NotebookWidget[] = Array.from(
	{ length: NOTEBOOK_LIMITS.maxWidgets },
	(_, index): NotebookWidget => {
		const base = {
			widgetId: `nb_bench_${index}`,
			title: `Bench widget ${index} with a realistic title`,
			size: "medium",
			...NOTEBOOK_BENCH_META,
		} as const;
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
	},
);
const notebookBench: Notebook = notebookSchema.parse({ widgets: notebookBenchWidgets });
const notebookBenchBytes = notebookContentBytes(notebookBench.widgets);
if (notebookBenchBytes > NOTEBOOK_LIMITS.maxContentBytes) {
	throw new Error(`the bench notebook (${notebookBenchBytes} bytes) is over the content cap`);
}
const notebookBenchKb = Math.round(notebookBenchBytes / 1000);
/** The longest turn the assistant may return: 12 commands touching both ends of the notebook. */
const notebookBenchCommands = [
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
].slice(0, NOTEBOOK_LIMITS.maxCommandsPerTurn);
// Remove one widget so the duplicate fits under the widget maximum.
const notebookBenchRoom: Notebook = { widgets: notebookBench.widgets.slice(0, -1) };
let notebookBenchId = 0;
const notebookBenchContext = {
	knownComponentIds: new Set<string>(),
	newWidgetId: () => {
		notebookBenchId += 1;
		return `nb_new_${notebookBenchId}`;
	},
};
const notebookGridSlots = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) => ({
	left: (index % 4) * 200,
	top: Math.floor(index / 4) * 160,
	right: (index % 4) * 200 + 190,
	bottom: Math.floor(index / 4) * 160 + 150,
}));

/**
 * A Text widget note at the length cap, mixing every construct of the
 * Markdown subset. The read view parses it on every change, and the editor
 * converts its whole document back to Markdown on every keystroke.
 */
const richTextBenchSource = (() => {
	const blocks: string[] = [];
	for (
		let section = 0;
		blocks.join("\n\n").length < NOTEBOOK_LIMITS.maxTextChars - 400;
		section += 1
	) {
		blocks.push(
			`## Section ${section}`,
			`Pack **light** and *travel* far, see [notes](https://example.com/${section}) and \`code\` ~~gone~~.`,
			`- [ ] Book item ${section}\n- [x] Paid ${section}\n- Plain bullet`,
			`> A quoted remark ${section}`,
		);
	}
	return blocks.join("\n\n").slice(0, NOTEBOOK_LIMITS.maxTextChars);
})();
const richTextBenchPm = modelToPm(parseRichText(richTextBenchSource));

/* Four series of 1,500 daily closes for the chart viewer (ADR-0025): the
 * viewer resamples each held series once per interval, averages once per
 * (series, interval, period), and re-slices per window change. */
const CHART_BENCH_SERIES = Array.from({ length: 4 }, (_, series) => homeBenchPoints(series, 1500));
const CHART_BENCH_DAILY_BARS = resampleSeries(CHART_BENCH_SERIES[0] ?? [], "daily");
const CHART_BENCH_MIDDLE = {
	from: CHART_BENCH_DAILY_BARS[500]?.day ?? 0,
	to: CHART_BENCH_DAILY_BARS[999]?.day ?? 0,
};
const CHART_BENCH_VALUES = (CHART_BENCH_SERIES[0] ?? []).map((point) => point.value);

/* The viewer builds one render model per window change over 4 × 1,500 daily
 * bars at desktop plot width, with three moving-average overlays (ADR-0025). */
const CHART_BENCH_DETAIL_INPUT: BuildDetailChartInput = {
	series: CHART_BENCH_SERIES.map((points, series) => ({
		key: `bench-${series}`,
		label: `Bench series ${series}`,
		color: seriesColor(series),
		bars: resampleSeries(points, "daily"),
	})),
	window: CHART_BENCH_MIDDLE,
	plotWidth: 1200,
	plotHeight: 480,
	scale: "linear",
	mode: "value",
	maPeriods: [20, 50, 200],
};

/* Per-window-change cost must not grow with the held bars (ADR-0025
 * performance, fix round 6): the same 1-month window over 4 × 800 and
 * 4 × 20,000 daily bars, with everything the viewer memoizes per interval
 * (resampled bars, union days, moving averages, the navigator overview)
 * built once up front, exactly as the viewer holds them. The two sizes share
 * one budget, so a pan or zoom that touches every held bar fails here. */
function chartWindowFixture(count: number) {
	const series = Array.from({ length: 4 }, (_, index) =>
		resampleSeries(homeBenchPoints(index, count), "daily"),
	);
	const first = series[0] ?? [];
	const lastBar = first[first.length - 1];
	const lastDay = lastBar?.day ?? 0;
	const window = { from: lastDay - 400, to: lastDay - 370 };
	const extent = { from: first[0]?.day ?? 0, to: lastDay };
	const closes = first.map((bar) => bar.close);
	const days = first.map((bar) => bar.day);
	const overlays: DetailMaOverlayInput[] = [20, 50, 200].map((period) => {
		const averaged = movingAverage(closes, period);
		return {
			seriesKey: "bench-0",
			color: seriesColor(0),
			period,
			label: `MA ${period}`,
			days,
			values: averaged.ok ? averaged.value : [],
		};
	});
	const overview = unionOverview(series);
	const navigator = buildNavigatorOverview({
		days: overview.days,
		values: overview.values,
		width: 1200,
		height: 56,
	});
	const modelInput: BuildDetailChartInput = {
		series: series.map((bars, index) => ({
			key: `bench-${index}`,
			label: `Bench series ${index}`,
			color: seriesColor(index),
			bars,
		})),
		window,
		plotWidth: 1200,
		plotHeight: 480,
		scale: "linear",
		mode: "percent",
		maPeriods: [],
		maOverlays: [overlays[0], overlays[1], overlays[2]].flatMap((overlay) =>
			overlay === undefined ? [] : [overlay],
		),
	};
	return { union: unionBarDays(series), window, extent, navigator, modelInput };
}
const CHART_WINDOW_800 = chartWindowFixture(800);
const CHART_WINDOW_20K = chartWindowFixture(20_000);

/** The largest chart widget the contract allows; each series starts one label later. */
const NOTEBOOK_BENCH_CHART = {
	widgetId: "w_bench_chart",
	type: "chart",
	title: "Bench chart",
	size: "large",
	chartType: "line",
	unit: "USD",
	xKind: "date",
	series: Array.from({ length: WIDGET_LIMITS.maxChartSeries }, (_, seriesIndex) => ({
		name: `Series ${seriesIndex + 1}`,
		points: Array.from({ length: WIDGET_LIMITS.maxChartPoints }, (_, pointIndex) => ({
			x: new Date(Date.UTC(2020, 0, 1 + seriesIndex + pointIndex)).toISOString().slice(0, 10),
			y: 100 + seriesIndex + Math.sin(pointIndex / 9) * 10,
		})),
	})),
} satisfies Extract<WidgetCore, { readonly type: "chart" }>;

/* Stock directory (ADR-0033): full-size lists shaped like the measured ones
 * (US 7,691 rows, ~25-character names; JP 3,700 rows with Japanese names). */
const usDirectory: StockDirectoryEntry[] = Array.from({ length: 7_691 }, (_, index) => ({
	symbol: `S${index.toString(36).toUpperCase()}`,
	name: `EXAMPLE HOLDINGS CORP ${index}`,
	listing: index % 2 === 0 ? "nasdaq" : "nyse",
}));
const jpDirectory: StockDirectoryEntry[] = Array.from({ length: 3_700 }, (_, index) => ({
	symbol: String(1000 + index),
	name: `EXAMPLE INDUSTRIES CO.,LTD. ${index}`,
	localName: `サンプル工業ホールディングス${index}`,
	listing: "tse-prime",
}));
const usDirectoryCompletionJson = JSON.stringify({
	outcome: "stock-directory-refreshed",
	leaseGeneration: 1,
	usage: { agentSteps: 0, toolCalls: 0, inputBytes: 0, knownCostUsd: 0, hasUnmeteredUsage: false },
	market: "US",
	asOf: null,
	fetchedAt: "2026-10-24T00:00:00Z",
	entries: usDirectory,
});

const cases: Case[] = [
	{
		name: `parse + validate a full US stock-list completion (${Math.round(usDirectoryCompletionJson.length / 1024)} KB, 7,691 rows)`,
		budgetMs: 30,
		run: () => completeJobRequestSchema.parse(JSON.parse(usDirectoryCompletionJson)),
	},
	{
		name: "fold the search keys of both stock lists (11,391 rows)",
		budgetMs: 20,
		run: () => [stockDirectoryRows("US", usDirectory), stockDirectoryRows("JP", jpDirectory)],
	},
	{
		name: `parse + validate a maximal bundle (${Math.round(bundleJson.length / 1024)} KB)`,
		budgetMs: 10,
		run: () => researchBundleSchema.parse(JSON.parse(bundleJson)),
	},
	{
		name: "integrity-check a maximal bundle",
		budgetMs: 2,
		run: () => checkBundleIntegrity(RUN_ID, bundle),
	},
	{
		name: "verify 80 claims x 6 links against 80 x 4 KB evidence",
		budgetMs: 10,
		run: () => verifyClaims(draftClaims, evidenceTexts),
	},
	{
		name: "normalize a 100-item feed",
		budgetMs: 3,
		run: () =>
			normalizeFeed(feed, {
				publisher: "Bench",
				retrievedAt: "2026-10-11T00:00:00.000Z",
				licensePolicy: "short-excerpt-permitted",
				maxItems: 100,
			}),
	},
	{
		name: "apply layout.update on a 40-component workspace",
		budgetMs: 0.5,
		run: () =>
			applyUiCommand(
				fullWorkspace,
				{
					protocolVersion: 1,
					commandId: "reorder",
					workspaceId: "ws",
					expectedWorkspaceVersion: fullWorkspace.version,
					operation: "layout.update",
					order: reversed,
					columns: 2,
				},
				context,
			),
	},
	{
		name: "reorder a widget to the end of a 24-widget dashboard",
		budgetMs: 0.5,
		run: () =>
			applyDashboardEdit(reorderBenchDashboard, {
				kind: "reorder",
				widgetId: "w-bench-0",
				toIndex: 23,
			}),
	},
	{
		name: "nextDropTarget over 24 slots",
		budgetMs: 0.5,
		run: () =>
			nextDropTarget({
				slots: gridBenchSlots,
				draggedIndex: 0,
				pointer: { x: 2000, y: 50 },
				previous: gridBenchHistory,
			}),
	},
	{
		name: "applyWidgetLayoutEdit reorder on 24 widgets",
		budgetMs: 0.5,
		run: () =>
			applyWidgetLayoutEdit(gridBenchWidgets, {
				kind: "reorder",
				widgetId: "w-grid-0",
				toIndex: 23,
			}),
	},
	{
		name: "parseWidgetCommand for a reorder",
		budgetMs: 0.5,
		run: () => parseWidgetCommand({ kind: "reorder", widgetId: "w-grid-0", toIndex: 23 }),
	},
	{
		name: "host.apply reorder over an in-memory store of 24 widgets",
		budgetMs: 1,
		run: () => gridBenchHost.apply({ kind: "reorder", widgetId: "w-grid-0", toIndex: 23 }),
	},
	{
		name: `measure the content bytes of a full notebook (200 widgets, ${notebookBenchKb} KB)`,
		budgetMs: 8,
		run: () => notebookContentBytes(notebookBench.widgets),
	},
	{
		name: `validate a full notebook (200 widgets, ${notebookBenchKb} KB)`,
		budgetMs: 15,
		run: () => notebookSchema.parse(notebookBench),
	},
	{
		name: "check 12 assistant commands against a full notebook, then stamp it (runner + API)",
		budgetMs: 10,
		run: async () => {
			const applied = await applyNotebookCommands(
				notebookBenchRoom,
				notebookBenchCommands,
				notebookBenchContext,
			);
			if (!applied.ok) throw new Error(`bench turn refused: ${applied.error.failure.message}`);
			return stampNotebook(
				notebookBenchRoom,
				applied.value.widgets,
				"2026-10-14T01:00:00.000Z",
				() => ({
					kind: "assistant",
					messageId: null,
					runId: "run_bench",
					componentId: null,
				}),
			);
		},
	},
	{
		name: "build the no-selection assistant prompt for a full notebook",
		budgetMs: 5,
		run: () =>
			notebookAssistPrompt({
				notebook: notebookBench,
				selectedWidgetIds: [],
				instruction: "Tidy this notebook.",
				conversationContext: [],
				fenceToken: "bench-fence",
				repairNote: null,
			}),
	},
	{
		name: "parse an 8,000-character rich-text note (Text widget read view)",
		budgetMs: 2,
		run: () => parseRichText(richTextBenchSource),
	},
	{
		name: "editor keystroke: 8,000-character ProseMirror doc back to Markdown",
		budgetMs: 4,
		run: () => serializeRichText(pmToModel(richTextBenchPm)),
	},
	{
		name: "nextDropTarget over 200 notebook slots",
		budgetMs: 0.5,
		run: () =>
			nextDropTarget({
				slots: notebookGridSlots,
				draggedIndex: 0,
				pointer: { x: 700, y: 49 * 160 + 40 },
				previous: gridBenchHistory,
			}),
	},
	{
		name: "extract JSON after 40 KB of brace-laden prose",
		budgetMs: 2,
		run: () => extractJsonObject(proseThenJson),
	},
	{
		name: "extract JSON from 200 KB of hostile nested braces",
		budgetMs: 20,
		run: () => extractJsonObject(hostileBraces),
	},
	{
		name: "canonicalize 1,000 article URLs",
		budgetMs: 10,
		run: () => {
			for (let i = 0; i < 1_000; i += 1)
				canonicalizeArticleUrl(`https://News.Example.org/a/${i}/?utm_source=x&b=2&a=1#f`);
		},
	},
	{
		name: "classify 10,000 IP addresses",
		budgetMs: 10,
		run: () => {
			for (let i = 0; i < 5_000; i += 1) {
				classifyIpAddress(`10.${i % 255}.3.4`);
				classifyIpAddress(`2001:db8::${(i % 9999).toString(16)}`);
			}
		},
	},
	{
		name: `convert a 1 MB article page to Markdown (${Math.round(articleHtml.length / 1024)} KB)`,
		budgetMs: 100,
		run: () =>
			htmlToMarkdown(articleHtml, { baseUrl: "https://news.example.org/a/1", maxChars: 20_000 }),
	},
	{
		name: `convert 2 MB of deeply nested formatting elements (${Math.round(deepNestingHtml.length / 1024)} KB)`,
		budgetMs: 2000,
		run: () =>
			htmlToMarkdown(deepNestingHtml, {
				baseUrl: "https://news.example.org/a/1",
				maxChars: 20_000,
			}),
	},
	{
		// Runs on every render of a Notebook chart widget (ADR-0024, 2026-10-17):
		// the order-preserving row merge plus the shared line model, at the
		// contract's largest chart, with staggered labels so the merge has work.
		name: "rebuild a 6 x 400-point Notebook chart widget as a dataset and line model",
		budgetMs: 10,
		run: () =>
			buildLineModel(chartWidgetToGuardedDataset(NOTEBOOK_BENCH_CHART), {
				xKey: "x",
				series: chartWidgetSeries(NOTEBOOK_BENCH_CHART),
			}),
	},
	{
		name: "derive home view-model and chart paths for 30 series x 800 observations",
		budgetMs: 25,
		run: () => {
			for (const entry of HOME_BENCH_SERIES) {
				latestChange(entry.points);
				changeOverOneYear(entry.points);
			}
			return buildHomeLineModel(HOME_BENCH_SERIES, "max");
		},
	},
	{
		name: "assemble GET /home/data for 30 series x 800 observations including response parse",
		budgetMs: 15,
		run: async () => {
			// S3: the digest-first flow — cheap ETag, then the full assembly.
			const digestResult = await homeBenchService.getDataDigest("owner_bench");
			if (!digestResult.ok) throw new Error(digestResult.error.code);
			const etag = homeDataDigestEtag(digestResult.value);
			const assembled = await homeBenchService.getData("owner_bench", digestResult.value);
			if (!assembled.ok) throw new Error(assembled.error.code);
			const parsed = homeDataResponseSchema.parse(assembled.value);
			return `${etag}:${parsed.series.length}`;
		},
	},
	{
		name: "build earnings calendar ICS for a full watchlist (50 stocks x 8 events)",
		budgetMs: 10,
		run: () =>
			buildEarningsCalendar({ calendarName: "Earnings calendar", events: ICS_BENCH_EVENTS }),
	},
	{
		name: "build a month grid and group 400 earnings events by date",
		budgetMs: 10,
		run: () => {
			const grid = buildMonthGrid(2026, 10, 0);
			if (!grid.ok) throw new Error("benchmark: month grid failed");
			return groupEventsByDate(ICS_BENCH_EVENTS);
		},
	},
	{
		name: "plan a Google sync for 400 desired x 400 existing events",
		budgetMs: 10,
		run: () => planGoogleSync(GOOGLE_BENCH_DESIRED, GOOGLE_BENCH_EXISTING),
	},
	{
		name: "build the canonical Google sync digest input for 400 bodies",
		budgetMs: 5,
		run: () => canonicalGoogleSyncDigestInput(GOOGLE_BENCH_DESIRED),
	},
	{
		name: `parse a JPX-sized synthetic workbook (2,900 rows, ${Math.round(JPX_BENCH.sheet.length / 1024)} KB sheet)`,
		budgetMs: 50,
		run: () => parseJpxWorkbook(JPX_BENCH.sheet, JPX_BENCH.shared),
	},
	{
		name: "resample 4 x 1,500 daily points to daily bars",
		budgetMs: 5,
		run: () => CHART_BENCH_SERIES.map((points) => resampleSeries(points, "daily")),
	},
	{
		name: "resample 4 x 1,500 daily points to weekly bars",
		budgetMs: 5,
		run: () => CHART_BENCH_SERIES.map((points) => resampleSeries(points, "weekly")),
	},
	{
		name: "resample 4 x 1,500 daily points to monthly bars",
		budgetMs: 5,
		run: () => CHART_BENCH_SERIES.map((points) => resampleSeries(points, "monthly")),
	},
	{
		name: "resample 4 x 1,500 daily points to quarterly bars",
		budgetMs: 5,
		run: () => CHART_BENCH_SERIES.map((points) => resampleSeries(points, "quarterly")),
	},
	{
		name: "resample 4 x 1,500 daily points to yearly bars",
		budgetMs: 5,
		run: () => CHART_BENCH_SERIES.map((points) => resampleSeries(points, "yearly")),
	},
	{
		name: "movingAverage(200) over 1,500 closes",
		budgetMs: 1,
		run: () => movingAverage(CHART_BENCH_VALUES, 200),
	},
	{
		name: "windowStats over 1,500 daily bars",
		budgetMs: 1,
		run: () => windowStats(CHART_BENCH_DAILY_BARS),
	},
	{
		name: "visibleSlice over 1,500 daily bars",
		budgetMs: 0.5,
		run: () => visibleSlice(CHART_BENCH_DAILY_BARS, CHART_BENCH_MIDDLE),
	},
	{
		name: "build the detail chart model for 4 x 1,500 daily bars at 1,200 px",
		budgetMs: 15,
		run: () => buildDetailChartModel(CHART_BENCH_DETAIL_INPUT),
	},
	// These cases time the per-window-change work on precomputed (memoized)
	// bars and union; that the viewer really reuses them across pans and
	// zooms is asserted by apps/web/test/chartViewerCaching.test.tsx.
	...[
		{ label: "4 x 800", fixture: CHART_WINDOW_800 },
		{ label: "4 x 20,000", fixture: CHART_WINDOW_20K },
	].flatMap(({ label, fixture }): Case[] => [
		{
			name: `window change: two-bar check on the memoized union, ${label} bars`,
			budgetMs: 0.1,
			run: () => ensureTwoBarWindow(fixture.window, fixture.union, fixture.extent),
		},
		{
			name: `window change: navigator rectangle, ${label} bars`,
			budgetMs: 0.1,
			run: () =>
				fixture.navigator === null ? null : navigatorWindowRect(fixture.navigator, fixture.window),
		},
		{
			name: `window change: 1-month detail model with 3 MAs, ${label} bars`,
			budgetMs: 0.6,
			run: () => buildDetailChartModel(fixture.modelInput),
		},
	]),
];

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

let overBudget = 0;
for (const benchCase of cases) {
	for (let warmup = 0; warmup < 5; warmup += 1) await benchCase.run();
	const samples: number[] = [];
	for (let sample = 0; sample < 25; sample += 1) {
		const started = performance.now();
		await benchCase.run();
		samples.push(performance.now() - started);
	}
	const ms = median(samples);
	const verdict = ms <= benchCase.budgetMs ? "ok  " : "SLOW";
	if (ms > benchCase.budgetMs) overBudget += 1;
	console.log(
		`${verdict} ${ms.toFixed(3).padStart(9)} ms  (budget ${benchCase.budgetMs} ms)  ${benchCase.name}`,
	);
}
process.exit(overBudget === 0 ? 0 : 1);
