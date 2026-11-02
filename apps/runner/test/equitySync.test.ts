/** `financial-sync` job execution in the TypeScript runner (ADR-0048 §6, ADR-0059 §2). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createJquantsFinancialsSource,
	createSecAnnualFilingsSource,
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncQuery,
	type EquitySyncSource,
} from "@research/adapters/finance";
import type { SafeFetcher } from "@research/application";
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
import type { MarketRequestPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const FIXTURES = fileURLToPath(new URL("../../../examples/fixtures/equity-sync/", import.meta.url));
const JQUANTS_FIXTURES = fileURLToPath(
	new URL("../../../packages/adapters/test/finance/fixtures/", import.meta.url),
);
const KEY = "runner-test-jquants-key";
const NINTENDO_SUMMARIES = "https://api.jquants.com/v2/fins/summary?code=79740";

type FinancialSyncJob = Extract<ClaimedJob, { kind: "financial-sync" }>;
const LEASE = {
	runId: "run_financial",
	leaseGeneration: 6,
	leaseExpiresAt: "2026-10-31T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
};

function jquantsJob(knownDisclosures: readonly string[] = []): FinancialSyncJob {
	return {
		kind: "financial-sync",
		...LEASE,
		companyId: "eqc_jp",
		market: "JP",
		symbol: "7974",
		concepts: [...equityConceptsOfProvider("jquants")],
		source: { provider: "jquants", code: "79740", knownDisclosures: [...knownDisclosures] },
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
			describedDocumentId: null,
		},
	};
}

function recordingPacer() {
	const calls: [PacerKey, number | undefined][] = [];
	const holds: [PacerKey, number][] = [];
	const pacer: MarketRequestPacer = {
		async pace(provider, _signal, requests) {
			calls.push([provider, requests]);
			return true;
		},
		// Financial sources pace through `pace`; a call here would show as a missing grant count.
		async admit(provider) {
			calls.push([provider, undefined]);
			return "granted";
		},
		hold(provider, ms) {
			holds.push([provider, ms]);
		},
	};
	return { pacer, calls, holds };
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

/** A fetcher answering J-Quants' live Nintendo summaries (2026-11-02), or `status`, counting requests. */
function jquantsFetcher(status: number | null = null) {
	const urls: string[] = [];
	const page = readFileSync(`${JQUANTS_FIXTURES}jquants-fins-summary-code-7974.json`, "utf8");
	const fetcher: SafeFetcher = {
		async fetchText(url) {
			urls.push(url);
			if (status !== null) {
				return err({ code: "HTTP_ERROR", detail: `HTTP ${status}`, status });
			}
			return url === NINTENDO_SUMMARIES
				? ok({ finalUrl: url, contentType: "application/json", text: page })
				: err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 });
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

	it("fails a J-Quants job without a key before any request (real source)", async () => {
		const { fetcher, urls } = jquantsFetcher();
		const source = createJquantsFinancialsSource({ fetcher, apiKey: null });
		const { pacer, calls } = recordingPacer();
		const { completion } = await run(jquantsJob(), new Map([["jquants", source]]), pacer);
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(urls).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("completes with J-Quants' summaries, paced under jquants-fins, and logs counts only (ADR-0059 §2)", async () => {
		const { fetcher, urls } = jquantsFetcher();
		const source = createJquantsFinancialsSource({ fetcher, apiKey: KEY });
		const { pacer, calls, holds } = recordingPacer();
		const { completion, logs, fetchedAt } = await run(
			jquantsJob(),
			new Map([["jquants", source]]),
			pacer,
		);
		const synced = syncedOf(completion);
		expect(completeJobRequestSchema.safeParse(synced).success).toBe(true);
		const expected = JSON.parse(readFileSync(`${FIXTURES}e2e-jquants.json`, "utf8"));
		expect(synced).toMatchObject({
			companyId: "eqc_jp",
			provider: "jquants",
			fetchedAt,
			identity: expected.identity,
			filings: expected.filings,
			more: false,
			description: null,
		});
		expect(urls).toEqual([NINTENDO_SUMMARIES]);
		expect(calls).toEqual([["jquants-fins", 1]]);
		expect(holds).toEqual([]);
		const completed = logs.find((line) => line.event === "financial_sync_completed");
		expect(completed).toEqual({
			at: expect.any(String),
			level: "info",
			event: "financial_sync_completed",
			companyId: "eqc_jp",
			provider: "jquants",
			filings: expected.filings.length,
			facts: synced.filings.reduce((total, filing) => total + filing.facts.length, 0),
			more: false,
			requests: 1,
		});
		// The key travels only in the request header, never in a log line.
		expect(JSON.stringify(logs)).not.toContain(KEY);
	});

	it("reports nothing new when every full-year summary is stored", async () => {
		const expected = JSON.parse(readFileSync(`${FIXTURES}e2e-jquants.json`, "utf8"));
		const known: string[] = expected.filings.map(
			(filing: { sourceDocumentId: string }) => filing.sourceDocumentId,
		);
		const { fetcher } = jquantsFetcher();
		const source = createJquantsFinancialsSource({ fetcher, apiKey: KEY });
		const { completion } = await run(jquantsJob(known), new Map([["jquants", source]]));
		expect(syncedOf(completion)).toMatchObject({ filings: [], more: false });
	});

	it("holds jquants-fins after J-Quants' 429, and maps its statuses (ADR-0059 §2)", async () => {
		const cases: [number, string, boolean, readonly [PacerKey, number][]][] = [
			[429, "FINANCIAL_RATE_LIMITED", true, [["jquants-fins", 120_000]]],
			[400, "FINANCIAL_PARSE_FAILED", false, []],
			[401, "FINANCIAL_ACCESS_DENIED", false, []],
			[403, "FINANCIAL_ACCESS_DENIED", false, []],
			[500, "FINANCIAL_SOURCE_FAILED", true, []],
		];
		for (const [status, code, retryable, expectedHolds] of cases) {
			const { fetcher } = jquantsFetcher(status);
			const source = createJquantsFinancialsSource({ fetcher, apiKey: KEY });
			const { pacer, holds } = recordingPacer();
			const { completion } = await run(jquantsJob(), new Map([["jquants", source]]), pacer);
			expect(failedOf(completion)).toEqual({
				outcome: "failed",
				leaseGeneration: 6,
				usage: expect.any(Object),
				failureCode: code,
				failureUpstreamStatus: status,
				retryable,
			});
			expect(holds).toEqual(expectedHolds);
		}
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
				identity: { sourceCompanyId: "79740", name: null, fiscalYearEnd: null },
				filings: [],
				more: false,
				requests: 2,
				description: null,
				descriptionUnread: null,
			}),
		);
		const { completion } = await run(secJob(), new Map([["sec", source]]));
		expect(failedOf(completion)).toMatchObject({
			failureCode: "FINANCIAL_PARSE_FAILED",
			retryable: false,
		});
	});

	it("fails a business description in a J-Quants completion as a parse failure (ADR-0059 §3)", async () => {
		const expected = JSON.parse(readFileSync(`${FIXTURES}e2e-sec.json`, "utf8"));
		const source = stub("jquants", async () =>
			ok({
				identity: { sourceCompanyId: "79740", name: null, fiscalYearEnd: null },
				filings: [],
				more: false,
				requests: 1,
				description: expected.description,
				descriptionUnread: null,
			}),
		);
		const { completion } = await run(jquantsJob(), new Map([["jquants", source]]));
		expect(failedOf(completion).failureCode).toBe("FINANCIAL_PARSE_FAILED");
	});

	it("logs a business description read that failed, and still completes (ADR-0053)", async () => {
		const source = stub("sec", async () =>
			ok({
				identity: { sourceCompanyId: "0009999981", name: null, fiscalYearEnd: null },
				filings: [],
				more: false,
				requests: 4,
				description: null,
				descriptionUnread: { code: "FINANCIAL_RATE_LIMITED", upstreamStatus: 429 },
			}),
		);
		const { completion, logs } = await run(secJob(), new Map([["sec", source]]));
		expect(syncedOf(completion).description).toBeNull();
		expect(logs.filter((line) => line.event === "financial_sync_description_unread")).toEqual([
			{
				at: expect.any(String),
				level: "warn",
				event: "financial_sync_description_unread",
				companyId: expect.any(String),
				provider: "sec",
				code: "FINANCIAL_RATE_LIMITED",
				upstreamStatus: 429,
			},
		]);
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
			[
				"https://www.sec.gov/Archives/edgar/data/9999981/000999998125000110/synd-20250930.htm",
				readFileSync(`${FIXTURES}sec-10k-0009999981-25-000110.synthetic.htm`, "utf8"),
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
		// The newest 10-K's Item 1 (ADR-0053): one more paced request.
		expect(synced.description).toEqual(expected.description);
		expect(calls).toEqual([
			["sec", 1],
			["sec", 1],
			["sec", 1],
		]);
		expect(logs.find((line) => line.event === "financial_sync_completed")).toMatchObject({
			filings: 7,
			requests: 3,
		});
	});
});
