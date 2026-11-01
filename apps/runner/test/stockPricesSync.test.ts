/**
 * `stock-prices-sync` execution in the TypeScript runner (ADR-0058 §2): the
 * proved state order, pacing under the provider's key, the completion the
 * API accepts, and the failures (no key, a rejected key) with the provider's
 * status unchanged (ADR-0037).
 */
import { createMassiveStockPriceSource } from "@research/adapters/finance";
import type { FetchedDocument, SafeFetchError, SafeFetcher } from "@research/application";
import {
	type ClaimedJob,
	type CompleteJobRequest,
	completeJobRequestSchema,
} from "@research/contracts";
import { EMPTY_USAGE, err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketRequestPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const NOW = Date.parse("2026-10-31T15:00:00.000Z");
const clock = { nowMs: () => NOW, nowIso: () => new Date(NOW).toISOString() };

function job(
	fields: Partial<Extract<ClaimedJob, { kind: "stock-prices-sync" }>> = {},
): Extract<ClaimedJob, { kind: "stock-prices-sync" }> {
	return {
		kind: "stock-prices-sync",
		runId: "run_prices",
		leaseGeneration: 3,
		leaseExpiresAt: "2026-10-31T15:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		market: "US",
		days: ["2026-10-30", "2026-10-29"],
		histories: [],
		adjustmentsSince: null,
		windowStart: "2024-11-01",
		...fields,
	};
}

const GROUPED = "https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks";

function fetcherOf(
	pages: Record<string, string | SafeFetchError>,
): SafeFetcher & { urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		async fetchText(url) {
			urls.push(url);
			const page = pages[url];
			if (page === undefined) return err({ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 });
			if (typeof page !== "string") return err(page);
			const document: FetchedDocument = {
				finalUrl: url,
				contentType: "application/json",
				text: page,
			};
			return ok(document);
		},
	};
}

function recordingPacer() {
	const keys: PacerKey[] = [];
	const pacer: MarketRequestPacer = {
		async pace(provider) {
			keys.push(provider);
			return true;
		},
		async admit(provider) {
			keys.push(provider);
			return "granted";
		},
	};
	return { pacer, keys };
}

function stateSequence(events: { events: { event: { type: string; state?: string } }[] }[]) {
	return events
		.flatMap((request) => request.events)
		.filter((entry) => entry.event.type === "state")
		.map((entry) => entry.event.state);
}

function failedOf(completion: CompleteJobRequest | undefined) {
	if (completion?.outcome !== "failed")
		throw new Error(`expected failed, got ${completion?.outcome}`);
	return completion;
}

const DAY = JSON.stringify({
	results: [{ T: "BRK.B", o: 410, h: 415.25, l: 409.5, c: 412.5, v: 3120455, t: 1 }],
	resultsCount: 1,
	status: "OK",
});

describe("stock-prices-sync execution (ADR-0058 §2)", () => {
	it("walks the days newest first, paced as massive, and completes with what the API accepts", async () => {
		const fetcher = fetcherOf({
			[`${GROUPED}/2026-10-30?adjusted=true`]: DAY,
			[`${GROUPED}/2026-10-29?adjusted=true`]: JSON.stringify({ resultsCount: 0, status: "OK" }),
		});
		const { pacer, keys } = recordingPacer();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const source = createMassiveStockPriceSource({ apiKey: "massive-key-1", fetcher });
		await executeJob(
			job(),
			{ ...harness.deps, clock, marketPacer: pacer, stockPriceSources: new Map([["US", source]]) },
			never,
		);
		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(keys).toEqual(["massive", "massive"]);
		expect(fetcher.urls).toEqual([
			`${GROUPED}/2026-10-30?adjusted=true`,
			`${GROUPED}/2026-10-29?adjusted=true`,
		]);
		const completion = calls.completions[0];
		expect(completion).toEqual({
			outcome: "stock-prices-synced",
			leaseGeneration: 3,
			usage: EMPTY_USAGE,
			market: "US",
			provider: "massive",
			fetchedAt: "2026-10-31T15:00:00.000Z",
			days: [
				{
					date: "2026-10-30",
					outcome: "stored",
					bars: [["BRK-B", 412.5, [410, 415.25, 409.5, 3120455]]],
				},
				{ date: "2026-10-29", outcome: "not-yet-available", bars: [] },
			],
			histories: [],
		});
		expect(completeJobRequestSchema.safeParse(completion).success).toBe(true);
	});

	it("fails at once without a key, before any request", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		const { pacer, keys } = recordingPacer();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job({ market: "JP" }),
			{ ...harness.deps, clock, logger, marketPacer: pacer },
			never,
		);
		expect(failedOf(calls.completions[0])).toMatchObject({
			failureCode: "SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(calls.completions[0]).not.toHaveProperty("failureUpstreamStatus");
		expect(keys).toEqual([]);
		const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
		expect(events).toContain("stock_prices_failed");
	});

	it("fails with SOURCE_AUTH_FAILED and Massive's status when the key is rejected", async () => {
		const fetcher = fetcherOf({
			[`${GROUPED}/2026-10-30?adjusted=true`]: {
				code: "HTTP_ERROR",
				detail: "HTTP 401",
				status: 401,
			},
		});
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const source = createMassiveStockPriceSource({ apiKey: "massive-key-1", fetcher });
		await executeJob(
			job(),
			{
				...harness.deps,
				clock,
				marketPacer: recordingPacer().pacer,
				stockPriceSources: new Map([["US", source]]),
			},
			never,
		);
		expect(failedOf(calls.completions[0])).toMatchObject({
			failureCode: "SOURCE_AUTH_FAILED",
			failureUpstreamStatus: 401,
			retryable: false,
		});
	});
});
