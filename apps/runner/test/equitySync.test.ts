/** `financial-sync` job execution in the TypeScript runner (ADR-0048 §6). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createEdinetSource,
	createSecAnnualFilingsSource,
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncQuery,
	type EquitySyncSource,
	edinetDocumentListUrl,
	edinetDocumentUrl,
} from "@research/adapters/finance";
import type { SafeBinaryFetcher, SafeFetcher } from "@research/application";
import type { ClaimedJob, CompleteJobRequest } from "@research/contracts";
import { completeJobRequestSchema } from "@research/contracts";
import {
	type EquityProvider,
	equityConceptsOfProvider,
	err,
	ok,
	type Result,
} from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const FIXTURES = fileURLToPath(new URL("../../../examples/fixtures/equity-sync/", import.meta.url));
const KEY = "runner-test-edinet-key";

type FinancialSyncJob = Extract<ClaimedJob, { kind: "financial-sync" }>;
const LEASE = {
	runId: "run_financial",
	leaseGeneration: 6,
	leaseExpiresAt: "2026-10-31T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
};

function edinetJob(
	scanDays: readonly string[],
	knownDocIds: readonly string[] = [],
): FinancialSyncJob {
	return {
		kind: "financial-sync",
		...LEASE,
		companyId: "eqc_jp",
		market: "JP",
		symbol: "9999",
		concepts: [...equityConceptsOfProvider("edinet")],
		source: {
			provider: "edinet",
			secCode: "99990",
			edinetCode: null,
			knownDocIds: [...knownDocIds],
			pendingFilings: [],
			scanDays: [...scanDays],
		},
	};
}

function secJob(): FinancialSyncJob {
	return {
		kind: "financial-sync",
		...LEASE,
		companyId: "eqc_us",
		market: "US",
		symbol: "SYND",
		concepts: [...equityConceptsOfProvider("sec")],
		source: {
			provider: "sec",
			cik: "0009999981",
			knownAccessions: [],
			pendingFilings: [],
			filedSince: "2020-10-31",
			fullCheck: true,
		},
	};
}

function recordingPacer() {
	const calls: [PacerKey, number | undefined][] = [];
	const pacer: MarketPacer = {
		async pace(provider, _signal, requests) {
			calls.push([provider, requests]);
			return true;
		},
	};
	return { pacer, calls };
}

function stub(
	provider: EquityProvider,
	answer: (query: EquitySyncQuery) => Promise<Result<EquitySyncData, EquitySyncFailure>>,
): EquitySyncSource {
	return { provider, sync: answer };
}

/** Runs one job and returns its completion and the parsed log lines. */
async function run(
	job: FinancialSyncJob,
	sources: ReadonlyMap<EquityProvider, EquitySyncSource>,
	pacer = recordingPacer().pacer,
) {
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
			equitySyncSources: sources,
		},
		never,
	);
	const logs = lines.map((line): Record<string, unknown> => JSON.parse(line));
	return { completion: calls.completions[0], calls, logs, fetchedAt: harness.time.clock.nowIso() };
}

function failedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "failed")
		throw new Error(`expected failed, got ${completion?.outcome}`);
	return completion;
}

function syncedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "financial-synced")
		throw new Error(`expected financial-synced, got ${completion?.outcome}`);
	return completion;
}

/** A fetcher answering the EDINET fixtures by URL and counting requests. */
function edinetFixtureFetcher() {
	const urls: string[] = [];
	const dates = new Map<string, string>();
	for (const date of ["2024-06-21", "2024-09-10", "2025-06-20", "2025-07-01"]) {
		dates.set(
			edinetDocumentListUrl(date, KEY),
			readFileSync(`${FIXTURES}edinet-documents-${date}.synthetic.json`, "utf8"),
		);
	}
	const zips = new Map<string, Uint8Array>();
	for (const docId of ["S100SY24", "S100SYA4", "S100SY25"]) {
		zips.set(
			edinetDocumentUrl(docId, KEY),
			new Uint8Array(readFileSync(`${FIXTURES}edinet-${docId}.synthetic.zip`)),
		);
	}
	const fetcher: SafeFetcher & SafeBinaryFetcher = {
		async fetchText(url) {
			urls.push(url);
			const text = dates.get(url);
			return text === undefined
				? err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 })
				: ok({ finalUrl: url, contentType: "application/json", text });
		},
		async fetchBytes(url) {
			urls.push(url);
			const bytes = zips.get(url);
			return bytes === undefined
				? err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 })
				: ok({ finalUrl: url, contentType: "application/octet-stream", bytes });
		},
	};
	return { fetcher, urls };
}

describe("financial-sync execution (ADR-0048)", () => {
	it("fails unconfigured, not retryable, when the provider has no source", async () => {
		const { completion, calls, logs } = await run(secJob(), new Map());
		expect(failedOf(completion)).toEqual({
			outcome: "failed",
			leaseGeneration: 6,
			usage: expect.any(Object),
			failureCode: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		const states = calls.events.flatMap((request) => request.events).map((entry) => entry.event);
		expect(states.map((event) => ("state" in event ? event.state : null))).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(logs.find((line) => line.event === "financial_sync_failed")).toMatchObject({
			level: "warn",
			companyId: "eqc_us",
			provider: "sec",
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
		});
	});

	it("fails an EDINET job without a key before any request (real source)", async () => {
		const { fetcher, urls } = edinetFixtureFetcher();
		const source = createEdinetSource({
			fetcher,
			binaryFetcher: fetcher,
			apiKey: null,
			clock: createDeps(createFakeApi().api).time.clock,
		});
		const { pacer, calls } = recordingPacer();
		const { completion } = await run(
			edinetJob(["2025-06-20"]),
			new Map([["edinet", source]]),
			pacer,
		);
		expect(failedOf(completion).failureCode).toBe("FINANCIAL_SOURCE_NOT_CONFIGURED");
		expect(urls).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("completes with the source's data, paced under the provider's key, and logs counts only", async () => {
		const { fetcher, urls } = edinetFixtureFetcher();
		const source = createEdinetSource({
			fetcher,
			binaryFetcher: fetcher,
			apiKey: KEY,
			clock: createDeps(createFakeApi().api).time.clock,
		});
		const { pacer, calls } = recordingPacer();
		const { completion, logs, fetchedAt } = await run(
			edinetJob(["2024-06-21", "2024-09-10", "2025-06-20", "2025-07-01"]),
			new Map([["edinet", source]]),
			pacer,
		);
		const synced = syncedOf(completion);
		expect(completeJobRequestSchema.safeParse(synced).success).toBe(true);
		expect(synced).toMatchObject({
			companyId: "eqc_jp",
			provider: "edinet",
			fetchedAt,
			identity: {
				sourceCompanyId: "E99991",
				name: "シンセティック工業株式会社",
				fiscalYearEnd: "03-31",
			},
			scannedDays: ["2024-06-21", "2024-09-10", "2025-06-20", "2025-07-01"],
			more: false,
		});
		expect(synced.filings.map((f) => [f.sourceDocumentId, f.factsStatus])).toEqual([
			["S100SYB5", "not-available"],
			["S100SY25", "extracted"],
			["S100SYA4", "extracted"],
			["S100SY24", "extracted"],
		]);
		expect(urls).toHaveLength(7);
		expect(calls).toEqual(Array.from({ length: 7 }, () => ["edinet", 1]));
		const completed = logs.find((line) => line.event === "financial_sync_completed");
		expect(completed).toEqual({
			at: expect.any(String),
			level: "info",
			event: "financial_sync_completed",
			companyId: "eqc_jp",
			provider: "edinet",
			filings: 4,
			facts: 90,
			scannedDays: 4,
			more: false,
			requests: 7,
		});
		// The key travels only in request URLs, never in a log line.
		expect(JSON.stringify(logs)).not.toContain(KEY);
	});

	it("shares EDINET's date lists across two jobs (one source, one cache)", async () => {
		const { fetcher, urls } = edinetFixtureFetcher();
		const source = createEdinetSource({
			fetcher,
			binaryFetcher: fetcher,
			apiKey: KEY,
			clock: createDeps(createFakeApi().api).time.clock,
		});
		const sources = new Map([["edinet", source]] as const);
		await run(edinetJob(["2025-06-20"]), sources);
		expect(urls).toHaveLength(2);
		const second = await run(edinetJob(["2025-06-20"], ["S100SY25"]), sources);
		expect(syncedOf(second.completion).filings).toEqual([]);
		expect(urls).toHaveLength(2);
		expect(second.logs.find((line) => line.event === "financial_sync_completed")?.requests).toBe(0);
	});

	it("passes the code and status through, retrying only rate limits and source failures", async () => {
		const cases: [EquitySyncFailure["code"], number | null, boolean][] = [
			["FINANCIAL_RATE_LIMITED", 429, true],
			["FINANCIAL_SOURCE_FAILED", 503, true],
			["FINANCIAL_SOURCE_FAILED", null, true],
			["FINANCIAL_ACCESS_DENIED", 403, false],
			["FINANCIAL_COMPANY_NOT_FOUND", null, false],
			["FINANCIAL_PARSE_FAILED", null, false],
		];
		for (const [code, upstreamStatus, retryable] of cases) {
			const source = stub("sec", async () => err({ code, upstreamStatus, requests: 1 }));
			const { completion, logs } = await run(secJob(), new Map([["sec", source]]));
			expect(failedOf(completion)).toEqual({
				outcome: "failed",
				leaseGeneration: 6,
				usage: expect.any(Object),
				failureCode: code,
				...(upstreamStatus === null ? {} : { failureUpstreamStatus: upstreamStatus }),
				retryable,
			});
			expect(logs.find((line) => line.event === "financial_sync_failed")?.upstreamStatus).toBe(
				upstreamStatus,
			);
		}
	});

	it("fails a completion the API would refuse as a parse failure", async () => {
		const source = stub("sec", async () =>
			ok({
				identity: { sourceCompanyId: "E99991", name: null, fiscalYearEnd: null },
				scannedDays: [],
				filings: [],
				more: false,
				requests: 2,
			}),
		);
		const { completion } = await run(secJob(), new Map([["sec", source]]));
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_PARSE_FAILED",
			retryable: false,
		});
	});

	it("reports a throwing source as a retryable source failure", async () => {
		const source = stub("sec", async () => {
			throw new TypeError("boom");
		});
		const { completion, logs } = await run(secJob(), new Map([["sec", source]]));
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_SOURCE_FAILED",
			retryable: true,
		});
		expect(logs.find((line) => line.event === "financial_sync_source_failed")).toMatchObject({
			provider: "sec",
			error: "TypeError",
		});
	});

	it("runs the real SEC source end to end over the fixtures", async () => {
		const pages = new Map<string, string>([
			[
				"https://data.sec.gov/submissions/CIK0009999981.json",
				readFileSync(`${FIXTURES}sec-submissions-CIK0009999981.synthetic.json`, "utf8"),
			],
			[
				"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999981.json",
				readFileSync(`${FIXTURES}sec-companyfacts-CIK0009999981.synthetic.json`, "utf8"),
			],
		]);
		const fetcher: SafeFetcher = {
			async fetchText(url) {
				const text = pages.get(url);
				return text === undefined
					? err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 })
					: ok({ finalUrl: url, contentType: "application/json", text });
			},
		};
		const clock = createDeps(createFakeApi().api).time.clock;
		const source = createSecAnnualFilingsSource({
			fetcher,
			clock,
			userAgent: "Synthetic Research owner@synthetic-wire.org",
			sleep: async () => {},
		});
		const { pacer, calls } = recordingPacer();
		const { completion, logs } = await run(secJob(), new Map([["sec", source]]), pacer);
		const synced = syncedOf(completion);
		const expected = JSON.parse(readFileSync(`${FIXTURES}e2e-sec.json`, "utf8"));
		expect(synced.identity).toEqual(expected.identity);
		expect(synced.filings).toEqual(expected.filings);
		expect(calls).toEqual([
			["sec", 1],
			["sec", 1],
		]);
		expect(logs.find((line) => line.event === "financial_sync_completed")).toMatchObject({
			filings: 7,
			requests: 2,
		});
	});
});
