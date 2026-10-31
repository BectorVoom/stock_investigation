import { fileURLToPath } from "node:url";
import type { CompletionEffects, MarketCompletionSeries } from "@research/application";
import { MARKET_LIMITS } from "@research/contracts";
import { type HistoryPoint, type HistoryWrite, mergeHistory } from "@research/domain";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMarketRepository } from "../../src/sql/repositories.ts";
import {
	chunkHistoryReplacements,
	createResearchUnitOfWork,
	MARKET_HISTORY_DELETE_CHUNK_DATES,
} from "../../src/sql/unitOfWork.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * ADR-0044 §3: the completion's SQL must store exactly what the domain's
 * reference `mergeHistory(stored, fetched, write, maxStoredObservations)`
 * describes. Every case goes through the REAL unit of work (`commitCompletion`,
 * one guarded batch) on the real migrations, and the stored rows are read back
 * and compared with the reference. An AFTER UPDATE trigger (test-only) counts
 * rewritten rows, so "an unchanged value is not rewritten" is observed, not
 * assumed.
 */

const PROPERTY_SEED = 20_261_031;
/** The API's completion time (the job write's `at`). */
const COMMITTED_AT = "2026-10-31T01:00:00.000Z";
/**
 * The runner's `fetchedAt`, deliberately years ahead of the API: the full
 * check stamp must come from the API clock, never from the runner's.
 */
const FETCHED_AT = "2030-01-01T00:00:00.000Z";
const MAX_STORED = MARKET_LIMITS.maxStoredObservations;

type Db = ReturnType<typeof openNodeSqlite>;

let db: Db;
let caseNumber = 0;

beforeAll(() => {
	db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	applySqlMigrations(db, [
		{
			name: "9999_test_rewrites.sql",
			sql: `CREATE TABLE test_rewrites (owner_id TEXT NOT NULL, series_id TEXT NOT NULL);
				CREATE TRIGGER test_count_rewrites AFTER UPDATE ON market_observations BEGIN
					INSERT INTO test_rewrites VALUES (new.owner_id, new.series_id);
				END;`,
		},
	]);
});

afterAll(() => db.close());

/** A fresh owner with one job row at version 0, so the completion's guard passes. */
async function freshOwner(): Promise<string> {
	caseNumber += 1;
	const ownerId = `owner_${caseNumber}`;
	await db
		.prepare(
			`INSERT INTO research_jobs
				(owner_id, run_id, kind, state, idempotency_key, request_fingerprint,
				request_json, workspace_id, usage_json, attempt, max_attempts, lease_generation,
				lease_owner_id, lease_expires_at, last_event_seq, cancel_requested, failure_code,
				approval_request_json, retry_of_run_id, verification_status, provider_model,
				provider_session_ref, completed_generation, provenance_json, version,
				last_mutation_id, created_at, updated_at)
			VALUES (?, 'run_1', 'market-refresh', 'publishing', 'key-1', 'market-refresh', NULL, NULL,
				'{}', 1, 3, 2, NULL, NULL, -1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
				'mutation-0', '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')`,
		)
		.bind(ownerId)
		.run();
	return ownerId;
}

async function storeRows(
	ownerId: string,
	seriesId: string,
	points: readonly HistoryPoint[],
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
			SELECT ?, ?, json_extract(value, '$.observedOn'), json_extract(value, '$.value')
			FROM json_each(?)`,
		)
		.bind(ownerId, seriesId, JSON.stringify(points))
		.run();
}

async function storedRows(ownerId: string, seriesId: string): Promise<HistoryPoint[]> {
	const { results } = await db
		.prepare(
			"SELECT observed_on, value FROM market_observations WHERE owner_id = ? AND series_id = ? ORDER BY observed_on",
		)
		.bind(ownerId, seriesId)
		.all();
	return results.map((row) => ({ observedOn: String(row.observed_on), value: Number(row.value) }));
}

async function rewriteCount(ownerId: string, seriesId: string): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM test_rewrites WHERE owner_id = ? AND series_id = ?")
		.bind(ownerId, seriesId)
		.first();
	return Number(row?.n);
}

function succeeded(
	seriesId: string,
	observations: readonly HistoryPoint[],
	history: HistoryWrite | null,
): MarketCompletionSeries {
	return {
		seriesId,
		provider: "fred",
		symbol: seriesId.slice(5),
		fetchedAt: FETCHED_AT,
		meta: {
			title: seriesId,
			unit: "",
			frequency: "daily",
			publisher: "FRED",
			sourceUrl: "https://fred.stlouisfed.org/",
		},
		observations,
		errorCode: null,
		upstreamStatus: null,
		history,
	};
}

async function commit(
	ownerId: string,
	series: readonly MarketCompletionSeries[],
	committedAt = COMMITTED_AT,
): Promise<void> {
	const effects: CompletionEffects = {
		bundle: null,
		articles: [],
		sourceReports: [],
		workspace: null,
		assistantMessage: null,
		marketSeries: series,
		earnings: [],
		google: null,
		notebook: null,
		notebookTurn: null,
		stockDirectory: null,
	};
	const outcome = await createResearchUnitOfWork(db).commitCompletion(
		ownerId,
		{
			runId: "run_1",
			expectedVersion: 0,
			patch: { state: "completed" },
			audits: [],
			at: committedAt,
		},
		effects,
	);
	expect(outcome.kind).toBe("committed");
}

/** Day `offset` after 2000-01-01 as `YYYY-MM-DD`. */
function day(offset: number): string {
	return new Date(Date.UTC(2000, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Ascending points on the given day offsets, value `valueAt(offset)`. */
function pointsOn(offsets: readonly number[], valueAt: (offset: number) => number): HistoryPoint[] {
	return [...new Set(offsets)]
		.sort((a, b) => a - b)
		.map((offset) => ({ observedOn: day(offset), value: valueAt(offset) }));
}

function expectedRewrites(
	stored: readonly HistoryPoint[],
	fetched: readonly HistoryPoint[],
): number {
	const storedValues = new Map(stored.map((point) => [point.observedOn, point.value]));
	return fetched.filter((point) => {
		const before = storedValues.get(point.observedOn);
		return before !== undefined && before !== point.value;
	}).length;
}

/** One series of a generated case: what is stored, what the refresh answers, how it writes. */
interface SeriesCase {
	readonly stored: HistoryPoint[];
	readonly fetched: HistoryPoint[];
	readonly write: HistoryWrite | null;
}

/**
 * Values are eighths of small integers: exact in binary, never -0 (SQLite
 * keeps no sign of zero), and often equal to the stored value so the
 * "not rewritten" path is exercised as much as the changed one.
 */
const value = fc.integer({ min: -4_000, max: 4_000 }).map((n) => n / 8);

const seriesCase: fc.Arbitrary<SeriesCase> = fc
	.record({
		// Up to 1,700 stored rows: past the 1,500 kept, so trimming is exercised.
		storedStart: fc.integer({ min: 0, max: 400 }),
		storedCount: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 1_700 })),
		storedGap: fc.integer({ min: 1, max: 3 }),
		fetchedStart: fc.integer({ min: 0, max: 5_000 }),
		fetchedCount: fc.integer({ min: 1, max: MARKET_LIMITS.maxObservationsPerResponse }),
		fetchedGap: fc.integer({ min: 1, max: 3 }),
		/** 0 keeps every stored value; n changes every (n+1)-th answered day. */
		changeEvery: fc.integer({ min: 0, max: 5 }),
		writeKind: fc.constantFrom("none", "window", "full-from", "full-null"),
		replaceAt: fc.nat(),
		values: fc.array(value, { minLength: 1, maxLength: 64 }),
	})
	.map((knobs): SeriesCase => {
		const valueAt = (offset: number, salt: number) =>
			knobs.values[(offset * 7 + salt) % knobs.values.length] ?? 0;
		const storedOffsets = Array.from(
			{ length: knobs.storedCount },
			(_, index) => knobs.storedStart + index * knobs.storedGap,
		);
		const stored = pointsOn(storedOffsets, (offset) => valueAt(offset, 0));
		// The answer usually overlaps the stored tail: start it inside the stored range.
		const lastStored = storedOffsets.at(-1) ?? 0;
		const fetchedStart =
			knobs.fetchedStart % 2 === 0 && stored.length > 0
				? Math.max(0, lastStored - (knobs.fetchedStart % 900))
				: knobs.fetchedStart;
		const fetchedOffsets = Array.from(
			{ length: knobs.fetchedCount },
			(_, index) => fetchedStart + index * knobs.fetchedGap,
		);
		const storedValue = new Map(stored.map((point) => [point.observedOn, point.value]));
		const fetched = pointsOn(fetchedOffsets, (offset) => {
			const before = storedValue.get(day(offset));
			const keep = knobs.changeEvery === 0 || offset % (knobs.changeEvery + 1) !== 0;
			return before !== undefined && keep ? before : valueAt(offset, 3);
		});
		// The contract allows only answered dates as replaceFrom.
		const from = fetched[knobs.replaceAt % fetched.length]?.observedOn ?? day(fetchedStart);
		const write: HistoryWrite | null =
			knobs.writeKind === "none"
				? null
				: knobs.writeKind === "window"
					? { mode: "window", replaceFrom: from }
					: knobs.writeKind === "full-from"
						? { mode: "full", replaceFrom: from }
						: { mode: "full", replaceFrom: null };
		return { stored, fetched, write };
	});

async function checkAgainstReference(cases: readonly SeriesCase[]): Promise<void> {
	const ownerId = await freshOwner();
	const ids = cases.map((_, index) => `fred:S${index}`);
	for (const [index, entry] of cases.entries()) {
		await storeRows(ownerId, ids[index] ?? "", entry.stored);
	}
	await commit(
		ownerId,
		cases.map((entry, index) => succeeded(ids[index] ?? "", entry.fetched, entry.write)),
	);
	for (const [index, entry] of cases.entries()) {
		const seriesId = ids[index] ?? "";
		expect(await storedRows(ownerId, seriesId)).toEqual(
			mergeHistory(entry.stored, entry.fetched, entry.write, MAX_STORED),
		);
		expect(await rewriteCount(ownerId, seriesId)).toBe(
			expectedRewrites(entry.stored, entry.fetched),
		);
	}
}

describe("market completion history write (ADR-0044 §3)", () => {
	it("stores what mergeHistory describes, for random histories and writes", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(seriesCase, { minLength: 1, maxLength: 3 }), checkAgainstReference),
			{ seed: PROPERTY_SEED, numRuns: 300 },
		);
		// ~3 s locally: 300 real batches over up to 5,100 stored rows each.
	}, 60_000);

	it("a window write deletes a point the provider withdrew and keeps everything older", async () => {
		const stored = pointsOn([1, 2, 3, 4, 5, 6], (offset) => offset);
		// The answer from the anchor (day 3) no longer holds day 5.
		const fetched = pointsOn([3, 4, 6, 7], (offset) => offset);
		await checkAgainstReference([
			{ stored, fetched, write: { mode: "window", replaceFrom: day(3) } },
		]);
		const ownerId = `owner_${caseNumber}`;
		expect((await storedRows(ownerId, "fred:S0")).map((point) => point.observedOn)).toEqual(
			[1, 2, 3, 4, 6, 7].map(day),
		);
	});

	it("a full write with a null replaceFrom replaces a longer stored history", async () => {
		const stored = pointsOn(
			Array.from({ length: 1_200 }, (_, index) => index),
			(offset) => offset / 2,
		);
		const fetched = pointsOn(
			Array.from({ length: 800 }, (_, index) => 600 + index),
			(offset) => offset,
		);
		await checkAgainstReference([{ stored, fetched, write: { mode: "full", replaceFrom: null } }]);
		const rows = await storedRows(`owner_${caseNumber}`, "fred:S0");
		expect(rows).toEqual(fetched);
	});

	it("a full write from its oldest answered date keeps the older stored rows", async () => {
		const stored = pointsOn(
			Array.from({ length: 1_000 }, (_, index) => index),
			(offset) => offset,
		);
		const fetched = pointsOn(
			Array.from({ length: 800 }, (_, index) => 300 + index),
			(offset) => offset,
		);
		await checkAgainstReference([
			{ stored, fetched, write: { mode: "full", replaceFrom: day(300) } },
		]);
		const rows = await storedRows(`owner_${caseNumber}`, "fred:S0");
		expect(rows).toHaveLength(1_100);
		expect(rows[0]).toEqual({ observedOn: day(0), value: 0 });
	});

	it("a completion without history (a runner from before ADR-0044) only merges", async () => {
		const stored = pointsOn([1, 2, 3, 4, 5], (offset) => offset);
		const fetched = pointsOn([4, 6], (offset) => offset * 10);
		await checkAgainstReference([{ stored, fetched, write: null }]);
		expect(await storedRows(`owner_${caseNumber}`, "fred:S0")).toEqual(
			pointsOn([1, 2, 3, 4, 5, 6], (offset) =>
				offset === 4 || offset === 6 ? offset * 10 : offset,
			),
		);
	});

	it("trims to the newest 1,500 rows after a window write", async () => {
		const stored = pointsOn(
			Array.from({ length: 1_500 }, (_, index) => index),
			() => 1,
		);
		const fetched = pointsOn(
			Array.from({ length: 100 }, (_, index) => 1_468 + index),
			() => 1,
		);
		await checkAgainstReference([
			{ stored, fetched, write: { mode: "window", replaceFrom: day(1_468) } },
		]);
		const rows = await storedRows(`owner_${caseNumber}`, "fred:S0");
		expect(rows).toHaveLength(MAX_STORED);
		expect(rows[0]?.observedOn).toBe(day(68));
	});

	it("rewrites no row whose value is unchanged", async () => {
		const stored = pointsOn(
			Array.from({ length: 64 }, (_, index) => index),
			(offset) => offset,
		);
		const fetched = pointsOn(
			Array.from({ length: 32 }, (_, index) => 32 + index),
			(offset) => (offset === 40 ? -1 : offset),
		);
		await checkAgainstReference([
			{ stored, fetched, write: { mode: "window", replaceFrom: day(32) } },
		]);
		expect(await rewriteCount(`owner_${caseNumber}`, "fred:S0")).toBe(1);
	});

	it("stamps history_checked_at with the API's time for a full write only, and a later window write keeps it", async () => {
		const ownerId = await freshOwner();
		const fetched = pointsOn([1, 2], (offset) => offset);
		await commit(ownerId, [
			succeeded("fred:FULL", fetched, { mode: "full", replaceFrom: null }),
			succeeded("fred:WINDOW", fetched, { mode: "window", replaceFrom: day(1) }),
			succeeded("fred:LEGACY", fetched, null),
		]);
		const repository = createMarketRepository(db);
		const state = await repository.getRefreshState(ownerId, [
			"fred:FULL",
			"fred:WINDOW",
			"fred:LEGACY",
		]);
		// The API's time, not the runner's fetchedAt (which still stamps the refresh).
		expect(state.get("fred:FULL")).toMatchObject({
			lastRefreshedAt: FETCHED_AT,
			historyCheckedAt: COMMITTED_AT,
		});
		expect(state.get("fred:WINDOW")?.historyCheckedAt).toBeNull();
		expect(state.get("fred:LEGACY")?.historyCheckedAt).toBeNull();

		// A second completion (next job) with a window write leaves the stamp alone.
		await db
			.prepare("UPDATE research_jobs SET version = 0 WHERE owner_id = ? AND run_id = 'run_1'")
			.bind(ownerId)
			.run();
		await commit(
			ownerId,
			[
				{
					...succeeded("fred:FULL", fetched, { mode: "window", replaceFrom: day(1) }),
					fetchedAt: "2030-01-02T00:00:00.000Z",
				},
			],
			"2026-11-01T01:00:00.000Z",
		);
		const after = await repository.getRefreshState(ownerId, ["fred:FULL"]);
		expect(after.get("fred:FULL")).toMatchObject({
			lastRefreshedAt: "2030-01-02T00:00:00.000Z",
			historyCheckedAt: COMMITTED_AT,
		});
	});

	it("replaces a maximal completion (60 series x 800 points) in two delete chunks", async () => {
		const cases: SeriesCase[] = Array.from({ length: MARKET_LIMITS.maxTrackedSeries }, (_, s) => ({
			stored: pointsOn(
				Array.from({ length: MAX_STORED }, (_, index) => index),
				(offset) => offset + s,
			),
			fetched: pointsOn(
				Array.from(
					{ length: MARKET_LIMITS.maxObservationsPerResponse },
					(_, index) => 900 + index * 2,
				),
				(offset) => offset + s + (offset % 3 === 0 ? 0.5 : 0),
			),
			write:
				s % 2 === 0
					? { mode: "full", replaceFrom: null }
					: { mode: "window", replaceFrom: day(900) },
		}));
		await checkAgainstReference(cases);
	}, 60_000);
});

describe("history delete chunking (ADR-0044, S5)", () => {
	const dates = (count: number) => Array.from({ length: count }, (_, index) => day(index));

	it("never splits a series and keeps every chunk within the date budget", () => {
		const replacements = Array.from({ length: 60 }, (_, index) => ({
			seriesId: `fred:${"A".repeat(56)}${String(index).padStart(2, "0")}`,
			replaceFrom: null,
			dates: dates(MARKET_LIMITS.maxObservationsPerResponse),
		}));
		const chunks = chunkHistoryReplacements(replacements);
		expect(chunks).toHaveLength(2);
		for (const chunk of chunks) {
			const total = chunk.reduce((sum, entry) => sum + entry.dates.length, 0);
			expect(total).toBeLessThanOrEqual(MARKET_HISTORY_DELETE_CHUNK_DATES);
			// The bound date list stays well under 1 MB (D1's limit is ~2 MB).
			expect(
				JSON.stringify(chunk.map((entry) => ({ seriesId: entry.seriesId, dates: entry.dates })))
					.length,
			).toBeLessThan(500_000);
		}
		expect(chunks.flat()).toEqual(replacements);
	});

	it("emits nothing for no replacements", () => {
		expect(chunkHistoryReplacements([])).toEqual([]);
	});
});
