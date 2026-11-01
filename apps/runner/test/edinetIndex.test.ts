/** `edinet-index` job execution in the TypeScript runner (ADR-0058 §4). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createEdinetIndexSource,
	type EdinetIndexSource,
	edinetDocumentListUrl,
} from "@research/adapters/finance";
import type { SafeFetcher } from "@research/application";
import type { ClaimedJob, CompleteJobRequest } from "@research/contracts";
import { completeJobRequestSchema } from "@research/contracts";
import { err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketRequestPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const FIXTURES = fileURLToPath(new URL("../../../examples/fixtures/equity-sync/", import.meta.url));
const KEY = "runner-test-edinet-key";
const DATES = ["2025-07-01", "2025-06-20", "2024-09-10"];

type EdinetIndexJob = Extract<ClaimedJob, { kind: "edinet-index" }>;

function indexJob(days: readonly string[] = DATES): EdinetIndexJob {
	return {
		kind: "edinet-index",
		runId: "run_edinet_index",
		leaseGeneration: 4,
		leaseExpiresAt: "2026-10-31T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		days: [...days],
	};
}

function recordingPacer() {
	const calls: [PacerKey, number | undefined][] = [];
	const pacer: MarketRequestPacer = {
		async pace(provider, _signal, requests) {
			calls.push([provider, requests]);
			return true;
		},
		async admit(provider) {
			calls.push([provider, undefined]);
			return "granted";
		},
	};
	return { pacer, calls };
}

/** A fetcher answering the fixture lists by URL (an unknown URL answers `fallback`). */
function listFetcher(overrides: Record<string, ReturnType<SafeFetcher["fetchText"]>> = {}) {
	const urls: string[] = [];
	const fetcher: SafeFetcher = {
		async fetchText(url) {
			urls.push(url);
			const override = overrides[url];
			if (override !== undefined) return override;
			const date = DATES.find((day) => edinetDocumentListUrl(day, KEY) === url);
			return date === undefined
				? err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 })
				: ok({
						finalUrl: url,
						contentType: "application/json",
						text: readFileSync(`${FIXTURES}edinet-documents-${date}.synthetic.json`, "utf8"),
					});
		},
	};
	return { fetcher, urls };
}

async function run(job: EdinetIndexJob, source: EdinetIndexSource, pacer = recordingPacer().pacer) {
	const lines: string[] = [];
	const { api, calls } = createFakeApi();
	const harness = createDeps(api);
	await executeJob(
		job,
		{
			...harness.deps,
			logger: createEventLogger((line) => {
				lines.push(line);
			}),
			marketPacer: pacer,
			edinetIndexSource: source,
		},
		never,
	);
	const logs = lines.map((line): Record<string, unknown> => JSON.parse(line));
	const states = calls.events
		.flatMap((request) => request.events)
		.map((entry) => ("state" in entry.event ? entry.event.state : null));
	return { completion: calls.completions[0], logs, states, fetchedAt: harness.time.clock.nowIso() };
}

function indexedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "edinet-indexed")
		throw new Error(`expected edinet-indexed, got ${completion?.outcome}`);
	return completion;
}

function failedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "failed")
		throw new Error(`expected failed, got ${completion?.outcome}`);
	return completion;
}

describe("edinet-index execution (ADR-0058 §4)", () => {
	it("fails unconfigured without a request, not retryable, in the proved state order", async () => {
		const { fetcher, urls } = listFetcher();
		const { pacer, calls } = recordingPacer();
		const { completion, states, logs } = await run(
			indexJob(),
			createEdinetIndexSource({ fetcher, apiKey: null }),
			pacer,
		);
		expect(failedOf(completion)).toEqual({
			outcome: "failed",
			leaseGeneration: 4,
			usage: expect.any(Object),
			failureCode: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(states).toEqual(["planning", "collecting", "analyzing", "verifying", "publishing"]);
		expect(urls).toEqual([]);
		expect(calls).toEqual([]);
		expect(logs.find((line) => line.event === "edinet_index_failed")).toMatchObject({
			level: "warn",
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
	});

	it("completes with every listed date's annual reports, paced under edinet, logging counts only", async () => {
		const { fetcher, urls } = listFetcher();
		const { pacer, calls } = recordingPacer();
		const { completion, logs, fetchedAt } = await run(
			indexJob(),
			createEdinetIndexSource({ fetcher, apiKey: KEY }),
			pacer,
		);
		const indexed = indexedOf(completion);
		expect(completeJobRequestSchema.safeParse(indexed).success).toBe(true);
		expect(indexed.fetchedAt).toBe(fetchedAt);
		expect(
			indexed.days.map((day) => [day.date, day.documents.map((document) => document.docId)]),
		).toEqual([
			["2025-07-01", ["S10701OT", "S100SYB5"]],
			["2025-06-20", ["S10620OT", "S100SY25"]],
			["2024-09-10", ["S10910OT", "S100SYA4"]],
		]);
		expect(urls).toHaveLength(3);
		expect(calls).toEqual([
			["edinet", 1],
			["edinet", 1],
			["edinet", 1],
		]);
		expect(logs.find((line) => line.event === "edinet_index_completed")).toEqual({
			at: expect.any(String),
			level: "info",
			event: "edinet_index_completed",
			runId: "run_edinet_index",
			days: 3,
			failedDays: 0,
			skippedDays: 0,
			documents: 6,
			droppedRows: 0,
			requests: 3,
		});
		expect(JSON.stringify(logs)).not.toContain(KEY);
	});

	it("leaves a failed date out of the completion and logs it with EDINET's status", async () => {
		const { fetcher } = listFetcher({
			[edinetDocumentListUrl("2025-06-20", KEY)]: Promise.resolve(
				err({ code: "HTTP_ERROR", detail: "HTTP 500", status: 500 }),
			),
		});
		const { completion, logs } = await run(
			indexJob(),
			createEdinetIndexSource({ fetcher, apiKey: KEY }),
		);
		expect(indexedOf(completion).days.map((day) => day.date)).toEqual(["2025-07-01", "2024-09-10"]);
		expect(logs.filter((line) => line.event === "edinet_index_day_failed")).toEqual([
			{
				at: expect.any(String),
				level: "warn",
				event: "edinet_index_day_failed",
				runId: "run_edinet_index",
				date: "2025-06-20",
				code: "FINANCIAL_SOURCE_FAILED",
				upstreamStatus: 500,
			},
		]);
	});

	it("fails with EDINET's status when no date could be listed, retrying only rate limits and source failures", async () => {
		for (const [status, code, retryable] of [
			[429, "FINANCIAL_RATE_LIMITED", true],
			[503, "FINANCIAL_SOURCE_FAILED", true],
			[401, "FINANCIAL_ACCESS_DENIED", false],
		] as const) {
			const fetcher: SafeFetcher = {
				fetchText: async () => err({ code: "HTTP_ERROR", detail: `HTTP ${status}`, status }),
			};
			const { completion } = await run(
				indexJob(["2025-06-20"]),
				createEdinetIndexSource({ fetcher, apiKey: KEY }),
			);
			expect(failedOf(completion)).toEqual({
				outcome: "failed",
				leaseGeneration: 4,
				usage: expect.any(Object),
				failureCode: code,
				failureUpstreamStatus: status,
				retryable,
			});
		}
	});

	it("fails a completion the API would refuse as a parse failure", async () => {
		const source: EdinetIndexSource = {
			list: async () =>
				ok({
					days: [
						{ date: "2025-06-20", documents: [] },
						{ date: "2025-06-20", documents: [] },
					],
					failedDays: [],
					skippedDays: 0,
					droppedRows: 0,
					requests: 2,
				}),
		};
		const { completion } = await run(indexJob(), source);
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_PARSE_FAILED",
			retryable: false,
		});
	});

	it("reports a throwing source as a retryable source failure", async () => {
		const source: EdinetIndexSource = {
			list: async () => {
				throw new TypeError("boom");
			},
		};
		const { completion, logs } = await run(indexJob(), source);
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_SOURCE_FAILED",
			retryable: true,
		});
		expect(logs.find((line) => line.event === "edinet_index_source_failed")).toMatchObject({
			error: "TypeError",
		});
	});
});
