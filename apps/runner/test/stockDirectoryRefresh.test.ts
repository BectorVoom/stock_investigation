import type { StockDirectoryData, StockDirectorySource } from "@research/application";
import { unconfiguredStockDirectorySource } from "@research/application";
import {
	type ClaimedJob,
	type CompleteJobRequest,
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryEntry,
	type StockDirectoryFailureCode,
	type WatchMarket,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketPacer, PacerKey } from "../src/marketPacing.ts";
import { createDeps, createFakeApi } from "./support.ts";

const never = new AbortController().signal;
const FLOOR = STOCK_DIRECTORY_LIMITS.minEntriesPerMarket;

function job(market: WatchMarket): Extract<ClaimedJob, { kind: "stock-directory-refresh" }> {
	return {
		kind: "stock-directory-refresh",
		runId: "run_directory",
		leaseGeneration: 4,
		leaseExpiresAt: "2026-10-24T00:01:30.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		market,
	};
}

function usEntries(count: number): StockDirectoryEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		symbol: `T${String(index).padStart(4, "0")}`,
		name: `Company ${index}`,
		listing: "nyse",
	}));
}

function jpEntries(count: number): StockDirectoryEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		symbol: String(1000 + index),
		name: `Issue ${index}`,
		localName: `銘柄${index}`,
		listing: "tse-prime",
	}));
}

/** A source that answers once and records the hook it was given. */
function answering(
	market: WatchMarket,
	answer: () => Promise<
		{ ok: true; value: StockDirectoryData } | { ok: false; error: StockDirectoryFailureCode }
	>,
) {
	const seen = { calls: 0, grants: [] as boolean[] };
	const source: StockDirectorySource = {
		market,
		async fetchDirectory(query) {
			seen.calls += 1;
			seen.grants.push(await query.beforeRequest());
			return answer();
		},
	};
	return { source, seen };
}

function recordingPacer(answer = true) {
	const keys: PacerKey[] = [];
	const pacer: MarketPacer = {
		async pace(provider) {
			keys.push(provider);
			return answer;
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

describe("stock-directory-refresh execution (ADR-0033)", () => {
	it("completes with the market's list, its date and the fetch time", async () => {
		const entries = jpEntries(FLOOR);
		const { source, seen } = answering("JP", async () => ok({ asOf: "2026-09-30", entries }));
		const { pacer, keys } = recordingPacer();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("JP"),
			{ ...harness.deps, marketPacer: pacer, stockDirectorySources: new Map([["JP", source]]) },
			never,
		);
		expect(stateSequence(calls.events)).toEqual([
			"planning",
			"collecting",
			"analyzing",
			"verifying",
			"publishing",
		]);
		expect(calls.completions).toEqual([
			{
				outcome: "stock-directory-refreshed",
				leaseGeneration: 4,
				usage: {
					agentSteps: 0,
					toolCalls: 0,
					inputBytes: 0,
					knownCostUsd: 0,
					hasUnmeteredUsage: false,
				},
				market: "JP",
				asOf: "2026-09-30",
				fetchedAt: harness.time.clock.nowIso(),
				entries,
			},
		]);
		// The source's request grant comes from the shared JPX window.
		expect(seen.grants).toEqual([true]);
		expect(keys).toEqual(["jpx"]);
	});

	it("paces the US list under SEC's window", async () => {
		const { source } = answering("US", async () => ok({ asOf: null, entries: usEntries(FLOOR) }));
		const { pacer, keys } = recordingPacer();
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("US"),
			{ ...harness.deps, marketPacer: pacer, stockDirectorySources: new Map([["US", source]]) },
			never,
		);
		expect(calls.completions[0]).toMatchObject({
			outcome: "stock-directory-refreshed",
			market: "US",
			asOf: null,
		});
		expect(keys).toEqual(["sec"]);
	});

	it("fails with DIRECTORY_NOT_CONFIGURED when the market has no source, or the US source is unconfigured", async () => {
		for (const sources of [
			new Map<WatchMarket, StockDirectorySource>(),
			new Map<WatchMarket, StockDirectorySource>([["US", unconfiguredStockDirectorySource("US")]]),
		]) {
			const { api, calls } = createFakeApi();
			const harness = createDeps(api);
			await executeJob(job("US"), { ...harness.deps, stockDirectorySources: sources }, never);
			expect(failedOf(calls.completions[0])).toMatchObject({
				failureCode: "DIRECTORY_NOT_CONFIGURED",
				retryable: false,
			});
			expect(stateSequence(calls.events)).toEqual([
				"planning",
				"collecting",
				"analyzing",
				"verifying",
				"publishing",
			]);
		}
	});

	it("passes the source's code through and retries only a source failure", async () => {
		const cases: [StockDirectoryFailureCode, boolean][] = [
			["DIRECTORY_SOURCE_FAILED", true],
			["DIRECTORY_RATE_LIMITED", false],
			["DIRECTORY_PARSE_FAILED", false],
			["DIRECTORY_NOT_CONFIGURED", false],
		];
		for (const [code, retryable] of cases) {
			const { source } = answering("JP", async () => err(code));
			const { api, calls } = createFakeApi();
			const harness = createDeps(api);
			await executeJob(
				job("JP"),
				{ ...harness.deps, stockDirectorySources: new Map([["JP", source]]) },
				never,
			);
			expect(failedOf(calls.completions[0])).toEqual({
				outcome: "failed",
				leaseGeneration: 4,
				usage: expect.any(Object),
				failureCode: code,
				retryable,
			});
		}
	});

	it("refuses a list the completion contract would refuse, as DIRECTORY_PARSE_FAILED", async () => {
		const tooFew = jpEntries(FLOOR - 1);
		const duplicate = [...jpEntries(FLOOR), ...jpEntries(1)];
		const usOnJp = usEntries(FLOOR);
		const blankName = jpEntries(FLOOR).map((entry, index) =>
			index === 0 ? { ...entry, name: "  " } : entry,
		);
		const badDate = jpEntries(FLOOR);
		for (const [entries, asOf] of [
			[tooFew, null],
			[duplicate, null],
			[usOnJp, null],
			[blankName, null],
			[badDate, "2026-02-30"],
		] as const) {
			const lines: string[] = [];
			const logger = createEventLogger((line) => {
				lines.push(line);
			});
			const { source } = answering("JP", async () => ok({ asOf, entries }));
			const { api, calls } = createFakeApi();
			const harness = createDeps(api);
			await executeJob(
				job("JP"),
				{ ...harness.deps, logger, stockDirectorySources: new Map([["JP", source]]) },
				never,
			);
			expect(failedOf(calls.completions[0])).toMatchObject({
				failureCode: "DIRECTORY_PARSE_FAILED",
				retryable: false,
			});
			const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
			expect(events).toContain("stock_directory_rejected");
		}
	});

	it("logs a thrown source failure with the class name only and fails retryably", async () => {
		const lines: string[] = [];
		const logger = createEventLogger((line) => {
			lines.push(line);
		});
		const throwing: StockDirectorySource = {
			market: "JP",
			fetchDirectory: () =>
				Promise.reject(new TypeError("socket secret-detail https://x.example/")),
		};
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("JP"),
			{ ...harness.deps, logger, stockDirectorySources: new Map([["JP", throwing]]) },
			never,
		);
		expect(failedOf(calls.completions[0])).toMatchObject({
			failureCode: "DIRECTORY_SOURCE_FAILED",
			retryable: true,
		});
		const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.filter((line) => line.event === "stock_directory_source_failed")).toEqual([
			expect.objectContaining({ level: "warn", market: "JP", error: "TypeError" }),
		]);
		for (const line of lines) {
			expect(line).not.toContain("secret-detail");
			expect(line).not.toContain("https://x.example/");
		}
	});

	it("ends cancelled when the owner cancels while the list downloads", async () => {
		const { api, calls } = createFakeApi({
			heartbeat: [
				{ ok: true, value: { leaseExpiresAt: "2026-10-24T00:03:00.000Z", cancelRequested: true } },
			],
		});
		const harness = createDeps(api);
		const source: StockDirectorySource = {
			market: "JP",
			async fetchDirectory(query) {
				await harness.tickHeartbeat();
				// The pacing hook reports the stop: the source sends nothing more.
				expect(query.signal.aborted).toBe(true);
				return err("DIRECTORY_SOURCE_FAILED");
			},
		};
		await executeJob(
			job("JP"),
			{ ...harness.deps, stockDirectorySources: new Map([["JP", source]]) },
			never,
		);
		expect(calls.completions).toEqual([
			{ outcome: "cancelled", leaseGeneration: 4, usage: expect.any(Object) },
		]);
	});
});
