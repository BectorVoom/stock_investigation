/**
 * The shared EDINET index (ADR-0058 §4): conformance vectors the Rust
 * runner replays (crates `research-finance`, `research-runner`), written
 * from the TypeScript reference into `finance/edinet_index.json`:
 *
 * - `edinetIndexDocument` — one annual row → the index document or null
 *   (securities code, filer name, period-end rule, `submitDateTime` →
 *   `+09:00` instant, the name cut at a character boundary);
 * - `edinetIndexDay` — one date's list (parsed JSON) → its documents and
 *   dropped-row count, or the problem; a `{"generated": n}` input stands for
 *   a list of n distinct period-less amendments (the per-day limit) and its
 *   output gives the document count instead of the documents;
 * - `sources` — whole `edinet-index` source runs over a URL-keyed scripted
 *   fetcher (requests, pacing grants, results);
 * - `jobs` — the runner's `edinet-index` body (completion, log lines,
 *   pacing keys) over scripted source answers.
 *
 * Fixture lists are named, not inlined (`{"fixture": "<name>"}` under
 * examples/fixtures/equity-sync/).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SafeFetchError } from "@research/application";
import {
	type ClaimedJob,
	EDINET_INDEX_LIMITS,
	type EquitySyncFailureCode,
} from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import { executeJob } from "../../../apps/runner/src/jobExecution.ts";
import type { MarketRequestPacer } from "../../../apps/runner/src/marketPacing.ts";
import { createDeps, createFakeApi } from "../../../apps/runner/test/support.ts";
import {
	type EdinetAnnualRow,
	edinetDocumentListUrl,
	parseEdinetDocumentList,
} from "../../../packages/adapters/src/finance/edinetDocuments.ts";
import {
	createEdinetIndexSource,
	type EdinetIndexData,
	type EdinetIndexSource,
	edinetIndexDay,
	edinetIndexDocument,
} from "../../../packages/adapters/src/finance/edinetIndex.ts";
import type { EquitySyncFailure } from "../../../packages/adapters/src/finance/equitySync.ts";
import type { VectorExporter, VectorFile } from "../shared.ts";
import { EQUITY_SYNC_FIXTURE_DIR, edinetFixtureDates } from "./equitySyncFixtures.ts";
import { normalizeCall, plain, type RecordedCall } from "./support.ts";

const KEY = "vector-edinet-key-01";

function fixtureText(name: string): string {
	return readFileSync(join(EQUITY_SYNC_FIXTURE_DIR, name), "utf8");
}

function listName(date: string): string {
	return `edinet-documents-${date}.synthetic.json`;
}

function resultJson<T, E>(result: Result<T, E>): unknown {
	return result.ok ? { ok: plain(result.value) } : { err: plain(result.error) };
}

/** `{"generated": n}`: n distinct period-less amendments of one filer on 2025-06-20. */
export function generatedList(count: number): unknown {
	return {
		metadata: { status: "200" },
		results: Array.from({ length: count }, (_, index) => ({
			docID: `S${String(index).padStart(7, "0")}`,
			edinetCode: "E99991",
			secCode: "99990",
			filerName: "名",
			docTypeCode: "130",
			submitDateTime: "2025-06-20 15:00",
			withdrawalStatus: "0",
		})),
	};
}

type ListInput =
	| { readonly fixture: string }
	| { readonly inline: unknown }
	| { readonly generated: number };

function resolveList(input: ListInput): unknown {
	if ("fixture" in input) return JSON.parse(fixtureText(input.fixture));
	if ("generated" in input) return generatedList(input.generated);
	return input.inline;
}

function documentCases(): unknown[] {
	const base: EdinetAnnualRow = {
		docId: "S100AAAA",
		edinetCode: "E99991",
		secCode: "99990",
		filerName: "名",
		docTypeCode: "120",
		periodStart: "2024-04-01",
		periodEnd: "2025-03-31",
		submitDateTime: "2025-06-20 15:00",
		parentDocId: null,
	};
	const max = EDINET_INDEX_LIMITS.maxFilerNameChars;
	const rows: EdinetAnnualRow[] = [
		...edinetFixtureDates().flatMap((date) => {
			const parsed = parseEdinetDocumentList(JSON.parse(fixtureText(listName(date))));
			if (!parsed.ok) throw new Error(`fixture list ${date}`);
			return parsed.value;
		}),
		base,
		{ ...base, docTypeCode: "130", periodStart: null, periodEnd: null, parentDocId: "S100BBBB" },
		{ ...base, docTypeCode: "130", periodStart: "2024-04-01", periodEnd: "2025-03-31" },
		{ ...base, periodStart: null },
		{ ...base, periodEnd: null },
		{ ...base, secCode: null },
		{ ...base, secCode: "9999" },
		{ ...base, secCode: "99991" },
		{ ...base, secCode: "ABC10" },
		{ ...base, secCode: "abc10" },
		{ ...base, secCode: "999900" },
		{ ...base, filerName: null },
		{ ...base, submitDateTime: "2025-01-02 00:05" },
		{ ...base, submitDateTime: "2025-12-31 23:59" },
		{ ...base, filerName: "a".repeat(max) },
		{ ...base, filerName: "a".repeat(max + 1) },
		{ ...base, filerName: `${"a".repeat(max - 1)}𠮷b` },
		{ ...base, filerName: `${"あ".repeat(max - 2)}𠮷𠮷` },
		{ ...base, filerName: "𠮷".repeat(max) },
	];
	return rows.map((row) => ({ row, output: edinetIndexDocument(row) }));
}

function dayCases(): unknown[] {
	const row = (fields: Record<string, unknown>) => ({
		docID: "S100AAAA",
		edinetCode: "E99991",
		secCode: "99990",
		filerName: "名",
		docTypeCode: "120",
		periodStart: "2024-04-01",
		periodEnd: "2025-03-31",
		submitDateTime: "2025-06-20 15:00",
		parentDocID: null,
		withdrawalStatus: "0",
		...fields,
	});
	const inputs: ListInput[] = [
		...edinetFixtureDates().map((date) => ({ fixture: listName(date) })),
		{ inline: { metadata: { status: "200" }, results: [] } },
		{
			inline: {
				metadata: { status: "200" },
				results: [
					row({}),
					row({}),
					row({ docID: "S100AAAB", secCode: null }),
					row({ docID: "S100AAAC", periodEnd: null }),
					row({ docID: "S100AAAD", docTypeCode: "130", periodEnd: null, periodStart: null }),
					row({ docID: "S100AAAE", filerName: "  " }),
					row({ docID: "S100AAAF", withdrawalStatus: "1" }),
					row({ docID: "S100AAAG", docTypeCode: "140" }),
					row({ docID: "S100AAAH", secCode: "12340", edinetCode: "E12345" }),
				],
			},
		},
		{ inline: { metadata: { status: "401", message: "Unauthorized" } } },
		{ inline: { metadata: { status: "oops" } } },
		{ inline: { StatusCode: 429, message: "Too Many Requests" } },
		{ inline: { results: [] } },
		{ inline: "x" },
		{ generated: EDINET_INDEX_LIMITS.maxDocumentsPerDay },
		{ generated: EDINET_INDEX_LIMITS.maxDocumentsPerDay + 1 },
	];
	// A generated list's documents are many and alike: their count stands for them.
	return inputs.map((input) => {
		const result = edinetIndexDay(resolveList(input));
		const output =
			"generated" in input && result.ok
				? { ok: { documentCount: result.value.documents.length, dropped: result.value.dropped } }
				: resultJson(result);
		return { list: input, output };
	});
}

/* ---------- Whole source runs ---------- */

type Answer =
	| { readonly fixture: string }
	| { readonly text: string }
	| { readonly generated: number }
	| { readonly error: SafeFetchError };

interface SourceScenario {
	readonly name: string;
	readonly credential: string | null;
	readonly answers: readonly (readonly [string, Answer])[];
	readonly days: readonly string[];
	/** Pacing answers (true once used up). */
	readonly grants: readonly boolean[];
}

async function runSource(scenario: SourceScenario): Promise<unknown> {
	const answers = new Map(scenario.answers.map(([url, answer]) => [url, answer]));
	const calls: (RecordedCall & { kind: string })[] = [];
	const source = createEdinetIndexSource({
		apiKey: scenario.credential,
		fetcher: {
			async fetchText(url, options) {
				calls.push({ ...normalizeCall(url, options), kind: "text" });
				const answer = answers.get(url);
				if (answer === undefined)
					return err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 });
				if ("error" in answer) return err(answer.error);
				const text =
					"fixture" in answer
						? fixtureText(answer.fixture)
						: "generated" in answer
							? JSON.stringify(generatedList(answer.generated))
							: answer.text;
				return ok({ finalUrl: url, contentType: "application/json", text });
			},
		},
	});
	let grants = 0;
	const result = await source.list({
		days: scenario.days,
		signal: new AbortController().signal,
		beforeRequest: async () => {
			const answer = scenario.grants[grants] ?? true;
			grants += 1;
			return answer;
		},
	});
	return { ...scenario, output: { requests: calls, grants, result: resultJson(result) } };
}

async function sourceCases(): Promise<unknown[]> {
	const dates = [...edinetFixtureDates()].reverse();
	const pages: [string, Answer][] = dates.map((date) => [
		edinetDocumentListUrl(date, KEY),
		{ fixture: listName(date) },
	]);
	const http = (status: number): Answer => ({
		error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status },
	});
	const second = dates[1] ?? "";
	const withPage = (date: string, answer: Answer): [string, Answer][] => [
		[edinetDocumentListUrl(date, KEY), answer],
		...pages.filter(([url]) => url !== edinetDocumentListUrl(date, KEY)),
	];
	const scenarios: SourceScenario[] = [
		{ name: "unconfigured", credential: null, answers: pages, days: dates, grants: [] },
		{
			name: "every fixture date, newest first",
			credential: KEY,
			answers: pages,
			days: dates,
			grants: [],
		},
		{
			name: "a date claimed twice is listed once",
			credential: KEY,
			answers: pages,
			days: [dates[0] ?? "", dates[0] ?? "", second],
			grants: [],
		},
		...[400, 404, 500, 503].map(
			(status): SourceScenario => ({
				name: `a date answers HTTP ${status}: left out`,
				credential: KEY,
				answers: withPage(second, http(status)),
				days: dates,
				grants: [],
			}),
		),
		...[401, 403, 429].map(
			(status): SourceScenario => ({
				name: `a date answers HTTP ${status}: listing stops`,
				credential: KEY,
				answers: withPage(second, http(status)),
				days: dates,
				grants: [],
			}),
		),
		...(
			[
				["metadata 400", '{"metadata":{"status":"400","message":"Bad Request"}}'],
				["metadata 500", '{"metadata":{"status":"500","message":"Internal Server Error"}}'],
				["gateway 401", '{"StatusCode":401,"message":"Access denied"}'],
				["gateway 429", '{"StatusCode":429,"message":"Too Many Requests"}'],
				["not JSON", "<html>"],
				["not a list", '{"StatusCode":200}'],
			] as const
		).map(
			([label, text]): SourceScenario => ({
				name: `a date answers ${label}`,
				credential: KEY,
				answers: withPage(second, { text }),
				days: dates,
				grants: [],
			}),
		),
		{
			name: "a date over the per-day limit",
			credential: KEY,
			answers: withPage(second, { generated: EDINET_INDEX_LIMITS.maxDocumentsPerDay + 1 }),
			days: dates,
			grants: [],
		},
		...(
			[
				["timeout", { code: "TIMEOUT", detail: "x" }],
				["too large", { code: "RESPONSE_TOO_LARGE", detail: "x" }],
				["network", { code: "NETWORK_ERROR", detail: "x" }],
			] as const
		).map(
			([label, error]): SourceScenario => ({
				name: `a date fails with ${label}`,
				credential: KEY,
				answers: withPage(second, { error }),
				days: dates,
				grants: [],
			}),
		),
		{
			name: "every date fails",
			credential: KEY,
			answers: dates.map((date) => [edinetDocumentListUrl(date, KEY), http(503)]),
			days: dates,
			grants: [],
		},
		{
			name: "the first date is refused",
			credential: KEY,
			answers: withPage(dates[0] ?? "", http(401)),
			days: dates,
			grants: [],
		},
		{ name: "the gate stops", credential: KEY, answers: pages, days: dates, grants: [true, false] },
		{
			name: "the gate stops at once",
			credential: KEY,
			answers: pages,
			days: dates,
			grants: [false],
		},
	];
	const out: unknown[] = [];
	for (const scenario of scenarios) out.push(plain(await runSource(scenario)));
	return out;
}

/* ---------- The runner's job body ---------- */

function recordingLogger(lines: unknown[]): EventLogger {
	const record = (level: string) => (event: string, fields?: LogFields) => {
		lines.push({ level, event, ...(fields ?? {}) });
	};
	return {
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		logFailures: () => 0,
	};
}

type Scripted =
	| { readonly ok: EdinetIndexData }
	| { readonly err: EquitySyncFailure }
	| { readonly throws: string };

async function jobCases(): Promise<unknown[]> {
	const day = (date: string): EdinetIndexData["days"][number] => {
		const parsed = edinetIndexDay(JSON.parse(fixtureText(listName(date))));
		if (!parsed.ok) throw new Error(`fixture list ${date}`);
		return { date, documents: [...parsed.value.documents] };
	};
	const data = (fields: Partial<EdinetIndexData>): EdinetIndexData => ({
		days: [],
		failedDays: [],
		skippedDays: 0,
		droppedRows: 0,
		requests: 0,
		...fields,
	});
	const cases: { days: string[]; answer: Scripted }[] = [
		{
			days: ["2025-07-01", "2025-06-20", "2024-09-10"],
			answer: {
				ok: data({ days: [day("2025-07-01"), day("2025-06-20"), day("2024-09-10")], requests: 3 }),
			},
		},
		{
			days: ["2025-07-01", "2025-06-20", "2024-09-10", "2024-06-21"],
			answer: {
				ok: data({
					days: [day("2025-07-01")],
					failedDays: [
						{ date: "2025-06-20", code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: 500 },
						{ date: "2024-09-10", code: "FINANCIAL_RATE_LIMITED", upstreamStatus: 429 },
					],
					skippedDays: 1,
					droppedRows: 2,
					requests: 3,
				}),
			},
		},
		{
			days: ["2025-06-20"],
			answer: { ok: data({ days: [{ date: "2025-06-20", documents: [] }], requests: 1 }) },
		},
		// A completion the contract refuses (a date twice): failed as a parse failure.
		{
			days: ["2025-06-20"],
			answer: { ok: data({ days: [day("2025-06-20"), day("2025-06-20")], requests: 2 }) },
		},
		// An annual report without a period end: refused by the contract too.
		{
			days: ["2025-06-20"],
			answer: {
				ok: data({
					days: [
						{
							date: "2025-06-20",
							documents: day("2025-06-20").documents.map((document) => ({
								...document,
								periodEnd: null,
							})),
						},
					],
					requests: 1,
				}),
			},
		},
		{ days: ["2025-06-20"], answer: { throws: "TypeError" } },
	];
	const codes: readonly EquitySyncFailureCode[] = [
		"FINANCIAL_SOURCE_NOT_CONFIGURED",
		"FINANCIAL_RATE_LIMITED",
		"FINANCIAL_ACCESS_DENIED",
		"FINANCIAL_SOURCE_FAILED",
		"FINANCIAL_PARSE_FAILED",
	];
	for (const code of codes) {
		for (const upstreamStatus of [null, 401, 429, 503] as const) {
			cases.push({ days: ["2025-06-20"], answer: { err: { code, upstreamStatus, requests: 1 } } });
		}
	}
	const out: unknown[] = [];
	for (const [index, entry] of cases.entries()) {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const logs: unknown[] = [];
		const paced: unknown[] = [];
		const pacer: MarketRequestPacer = {
			async pace(provider, _signal, requests) {
				paced.push([provider, requests ?? null]);
				return true;
			},
			async admit(provider) {
				paced.push([provider, "admit"]);
				return "granted";
			},
		};
		const answer = entry.answer;
		const source: EdinetIndexSource = {
			async list(query) {
				await query.beforeRequest();
				if ("throws" in answer) throw new TypeError(answer.throws);
				if ("err" in answer) return err(answer.err);
				return ok(answer.ok);
			},
		};
		const job: Extract<ClaimedJob, { kind: "edinet-index" }> = {
			kind: "edinet-index",
			runId: `run_ei_${index}`,
			leaseGeneration: 3,
			leaseExpiresAt: "2026-10-31T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			days: entry.days,
		};
		await executeJob(
			job,
			{
				...harness.deps,
				logger: recordingLogger(logs),
				marketPacer: pacer,
				edinetIndexSource: source,
			},
			new AbortController().signal,
		);
		out.push(
			plain({
				job,
				answer,
				clockIso: harness.time.clock.nowIso(),
				output: {
					completion: calls.completions[0] ?? null,
					logs: logs.filter(
						(line) =>
							typeof line === "object" &&
							line !== null &&
							"event" in line &&
							typeof line.event === "string" &&
							(line.event.startsWith("edinet_index") || line.event === "job_finished"),
					),
					paced,
				},
			}),
		);
	}
	return out;
}

async function edinetIndexFile(): Promise<VectorFile> {
	return {
		path: "finance/edinet_index.json",
		content: {
			limits: EDINET_INDEX_LIMITS,
			edinetIndexDocument: documentCases(),
			edinetIndexDay: dayCases(),
			sources: await sourceCases(),
			jobs: await jobCases(),
		},
	};
}

export const edinetIndexExporter: VectorExporter = {
	name: "edinet-index",
	async build(): Promise<readonly VectorFile[]> {
		return [await edinetIndexFile()];
	},
};
