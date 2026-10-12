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
import { checkBundleIntegrity } from "@research/application";
import {
	BASELINE_COMPONENT_DEFINITIONS,
	createComponentCatalog,
	type ResearchBundle,
	researchBundleSchema,
} from "@research/contracts";
import {
	applyUiCommand,
	type CommandContext,
	canonicalizeArticleUrl,
	classifyIpAddress,
	type DraftClaim,
	emptyWorkspaceState,
	normalizeFeed,
	type RawFeed,
	verifyClaims,
	type WorkspaceState,
} from "@research/domain";
import { htmlToMarkdown } from "../packages/adapters/src/tools/htmlToMarkdown.ts";

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
	knownAssetRefs: { has: () => true },
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

const cases: Case[] = [
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
];

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

let overBudget = 0;
for (const benchCase of cases) {
	for (let warmup = 0; warmup < 5; warmup += 1) benchCase.run();
	const samples: number[] = [];
	for (let sample = 0; sample < 25; sample += 1) {
		const started = performance.now();
		benchCase.run();
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
