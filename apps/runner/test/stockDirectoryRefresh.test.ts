import type { CompanyProfileSource, JquantsProfilesFailure } from "@research/adapters/finance";
import type {
	StockDirectoryData,
	StockDirectoryFailure,
	StockDirectorySource,
} from "@research/application";
import { unconfiguredStockDirectorySource } from "@research/application";
import {
	type ClaimedJob,
	type CompleteJobRequest,
	STOCK_DIRECTORY_LIMITS,
	type StockCompanyProfile,
	type StockDirectoryEntry,
	type StockDirectoryFailureCode,
	type WatchMarket,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import { createEventLogger } from "@research/effects";
import { describe, expect, it } from "vitest";
import { executeJob } from "../src/jobExecution.ts";
import type { MarketRequestPacer, PacerKey } from "../src/marketPacing.ts";
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
		{ ok: true; value: StockDirectoryData } | { ok: false; error: StockDirectoryFailure }
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
	const holds: [PacerKey, number][] = [];
	const pacer: MarketRequestPacer = {
		async pace(provider) {
			keys.push(provider);
			return answer;
		},
		async admit(provider) {
			keys.push(provider);
			return answer ? "granted" : "stopped";
		},
		hold(provider, ms) {
			holds.push([provider, ms]);
		},
	};
	return { pacer, keys, holds };
}

/** Toyota's row of J-Quants' Listed Issue Master (live, 2026-11-02) as a profile. */
const TOYOTA_PROFILE: StockCompanyProfile = {
	symbol: "7203",
	nameEn: "TOYOTA MOTOR CORPORATION",
	sector17Code: "6",
	sector17Name: "自動車・輸送機",
	sector33Code: "3700",
	sector33Name: "輸送用機器",
	scaleCategory: "TOPIX Core30",
	marketSegmentCode: "0111",
	marketSegmentName: "プライム",
	asOf: "2026-08-10",
};

/** A profile source that admits one request and answers `answer`. */
function profileSource(
	answer: () => Promise<
		| { ok: true; value: { profiles: StockCompanyProfile[]; requests: number } }
		| { ok: false; error: JquantsProfilesFailure }
	>,
): { source: CompanyProfileSource; seen: { calls: number } } {
	const seen = { calls: 0 };
	return {
		seen,
		source: {
			async fetchProfiles(query) {
				seen.calls += 1;
				await query.beforeRequest();
				return answer();
			},
		},
	};
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

describe("stock-directory-refresh execution (ADR-0034)", () => {
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
				// No J-Quants key in this harness: no profiles (ADR-0059 §3).
				profiles: null,
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
			profiles: null,
		});
		expect(keys).toEqual(["sec"]);
	});

	it("carries J-Quants' profiles on a JP list, paced under jquants, and logs the count (ADR-0059 §3)", async () => {
		const entries = jpEntries(FLOOR);
		const { source } = answering("JP", async () => ok({ asOf: "2026-09-30", entries }));
		const profiles = profileSource(async () => ok({ profiles: [TOYOTA_PROFILE], requests: 1 }));
		const { pacer, keys } = recordingPacer();
		const lines: string[] = [];
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("JP"),
			{
				...harness.deps,
				logger: createEventLogger((line) => {
					lines.push(line);
				}),
				marketPacer: pacer,
				stockDirectorySources: new Map([["JP", source]]),
				companyProfileSource: profiles.source,
			},
			never,
		);
		expect(calls.completions[0]).toMatchObject({
			outcome: "stock-directory-refreshed",
			market: "JP",
			profiles: [TOYOTA_PROFILE],
		});
		expect(keys).toEqual(["jpx", "jquants"]);
		const logs = lines.map((line): Record<string, unknown> => JSON.parse(line));
		expect(logs.find((line) => line.event === "company_profiles_fetched")).toEqual({
			at: expect.any(String),
			level: "info",
			event: "company_profiles_fetched",
			count: 1,
			requests: 1,
		});
	});

	it("asks no profiles for a US list", async () => {
		const { source } = answering("US", async () => ok({ asOf: null, entries: usEntries(FLOOR) }));
		const profiles = profileSource(async () => ok({ profiles: [TOYOTA_PROFILE], requests: 1 }));
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("US"),
			{
				...harness.deps,
				stockDirectorySources: new Map([["US", source]]),
				companyProfileSource: profiles.source,
			},
			never,
		);
		expect(calls.completions[0]).toMatchObject({ market: "US", profiles: null });
		expect(profiles.seen.calls).toBe(0);
	});

	it("still stores the list when the master fails: profiles null, logged with J-Quants' status", async () => {
		const cases: [JquantsProfilesFailure, readonly [PacerKey, number][]][] = [
			[{ code: "RATE_LIMITED", upstreamStatus: 429, requests: 1 }, [["jquants", 120_000]]],
			[{ code: "ACCESS_DENIED", upstreamStatus: 403, requests: 1 }, []],
			[{ code: "SOURCE_FAILED", upstreamStatus: null, requests: 0 }, []],
		];
		for (const [failure, expectedHolds] of cases) {
			const entries = jpEntries(FLOOR);
			const { source } = answering("JP", async () => ok({ asOf: "2026-09-30", entries }));
			const profiles = profileSource(async () => err(failure));
			const { pacer, holds } = recordingPacer();
			const lines: string[] = [];
			const { api, calls } = createFakeApi();
			const harness = createDeps(api);
			await executeJob(
				job("JP"),
				{
					...harness.deps,
					logger: createEventLogger((line) => {
						lines.push(line);
					}),
					marketPacer: pacer,
					stockDirectorySources: new Map([["JP", source]]),
					companyProfileSource: profiles.source,
				},
				never,
			);
			expect(calls.completions[0]).toMatchObject({
				outcome: "stock-directory-refreshed",
				entries,
				profiles: null,
			});
			const logs = lines.map((line): Record<string, unknown> => JSON.parse(line));
			expect(logs.find((line) => line.event === "company_profiles_failed")).toEqual({
				at: expect.any(String),
				level: "warn",
				event: "company_profiles_failed",
				code: failure.code,
				upstreamStatus: failure.upstreamStatus,
			});
			expect(holds).toEqual(expectedHolds);
		}
	});

	it("treats a throwing profile source as a failed master, not a failed job", async () => {
		const entries = jpEntries(FLOOR);
		const { source } = answering("JP", async () => ok({ asOf: "2026-09-30", entries }));
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		await executeJob(
			job("JP"),
			{
				...harness.deps,
				stockDirectorySources: new Map([["JP", source]]),
				companyProfileSource: {
					async fetchProfiles() {
						throw new TypeError("boom");
					},
				},
			},
			never,
		);
		expect(calls.completions[0]).toMatchObject({
			outcome: "stock-directory-refreshed",
			profiles: null,
		});
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

	it("passes the source's code and upstream status through and retries only a source failure", async () => {
		const cases: [StockDirectoryFailureCode, number | null, boolean][] = [
			["DIRECTORY_SOURCE_FAILED", 503, true],
			["DIRECTORY_SOURCE_FAILED", null, true],
			["DIRECTORY_RATE_LIMITED", 429, false],
			["DIRECTORY_PARSE_FAILED", null, false],
			["DIRECTORY_NOT_CONFIGURED", null, false],
		];
		for (const [code, upstreamStatus, retryable] of cases) {
			const { source } = answering("JP", async () => err({ code, upstreamStatus }));
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
				// The source's own status, unchanged; absent when there was none (§4a).
				...(upstreamStatus === null ? {} : { failureUpstreamStatus: upstreamStatus }),
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
				return err({ code: "DIRECTORY_SOURCE_FAILED", upstreamStatus: null });
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
