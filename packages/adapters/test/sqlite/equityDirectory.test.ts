/**
 * ADR-0058 §3–§4 on node:sqlite: every directory stock tracked in batches,
 * never-checked companies first, the shared EDINET index and the
 * retention of old sync jobs.
 */
import { fileURLToPath } from "node:url";
import { createSqlPersistence } from "@research/adapters/sql";
import {
	applySqlMigrations,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
} from "@research/adapters/sqlite";
import {
	type CompletionEffects,
	type EdinetIndexEffects,
	equityFilingId,
	type JobRecord,
	PRUNED_SYNC_JOB_KINDS,
	scheduledJobRecord,
} from "@research/application";
import type { EdinetIndexDocument, JobKind } from "@research/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = readSqlMigrations(
	fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
);
const OWNER = "owner@example.test";
const AT = "2026-11-02T00:00:00.000Z";
const LATER = "2026-11-03T00:00:00.000Z";

const EMPTY_EFFECTS: CompletionEffects = {
	bundle: null,
	articles: [],
	sourceReports: [],
	workspace: null,
	assistantMessage: null,
	marketSeries: [],
	earnings: [],
	google: null,
	notebook: null,
	notebookTurn: null,
	stockDirectory: null,
	equitySync: null,
};

let db: NodeSqliteDatabase;
beforeEach(() => {
	db = openNodeSqlite(":memory:");
	applySqlMigrations(db, MIGRATIONS);
});
afterEach(() => db.close());

const persistence = () => createSqlPersistence(db);

async function run(sql: string, ...values: (string | number | null)[]): Promise<void> {
	await db
		.prepare(sql)
		.bind(...values)
		.run();
}

async function all(sql: string, ...values: (string | number | null)[]) {
	return (
		await db
			.prepare(sql)
			.bind(...values)
			.all()
	).results;
}

/** Stores a market's directory (rows and meta) directly. */
async function storeDirectory(
	market: "US" | "JP",
	entries: readonly { symbol: string; name: string; localName?: string }[],
): Promise<void> {
	for (const entry of entries) {
		await run(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing, symbol_key,
				name_key, local_name_key, search_key)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			OWNER,
			market,
			entry.symbol,
			entry.name,
			entry.localName ?? null,
			market === "US" ? "nasdaq" : "tse-prime",
			entry.symbol.toLowerCase(),
			entry.name.toLowerCase(),
			"",
			entry.symbol.toLowerCase(),
		);
	}
	await run(
		`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version)
		VALUES (?, ?, ?, NULL, ?, 1)`,
		OWNER,
		market,
		entries.length,
		AT,
	);
}

async function watch(market: "US" | "JP", symbol: string): Promise<void> {
	await run(
		`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
		VALUES (?, ?, ?, ?, NULL, ?)`,
		OWNER,
		`${market.toLowerCase()}:${symbol}`,
		market,
		symbol,
		AT,
	);
}

/** Tracks every candidate the reconcile would, with deterministic ids. */
async function trackCandidates(at: string, limit = 500) {
	const repo = persistence().equitySync;
	const candidates = await repo.untrackedDirectoryListings(OWNER, limit);
	await repo.trackListings(
		OWNER,
		candidates.map((candidate) => ({
			companyId: candidate.companyId ?? `eqc_${candidate.market}_${candidate.symbol}`,
			market: candidate.market,
			symbol: candidate.symbol,
			provider: candidate.market === "US" ? "sec" : "edinet",
			name: candidate.name,
			existing: candidate.companyId !== null,
		})),
		at,
	);
	return candidates;
}

function indexDocument(
	docId: string,
	secCode: string,
	overrides: Partial<EdinetIndexDocument> = {},
): EdinetIndexDocument {
	return {
		docId,
		secCode,
		edinetCode: "E02367",
		filerName: "任天堂株式会社",
		docTypeCode: "120",
		periodStart: "2025-04-01",
		periodEnd: "2026-03-31",
		submittedAt: "2026-06-26T15:30:00+09:00",
		parentDocId: null,
		...overrides,
	};
}

/** Commits an `edinet-indexed` completion of a fresh job. */
async function commitIndex(
	documents: readonly EdinetIndexDocument[],
	listedOn = "2026-06-26",
	runId = "run_index",
) {
	const p = persistence();
	await p.jobs.insert(
		scheduledJobRecord({ ownerId: OWNER, kind: "edinet-index", request: null, runId, at: AT }),
		`k_${runId}`,
		"edinet-index",
		50,
	);
	const effects: EdinetIndexEffects = {
		days: [{ listedOn, documentCount: documents.length }],
		documents: documents.map((document) => ({ ...document, listedOn })),
		checkedAt: AT,
		at: LATER,
	};
	return p.unitOfWork.commitCompletion(
		OWNER,
		{ runId, expectedVersion: 0, patch: { state: "completed" }, audits: [], at: LATER },
		{ ...EMPTY_EFFECTS, edinetIndex: effects },
	);
}

describe("tracking the directory (ADR-0058 §3)", () => {
	it("lists untracked stocks Watchlist first, then US before JP, then by symbol", async () => {
		await storeDirectory("US", [
			{ symbol: "NFLX", name: "Netflix" },
			{ symbol: "AAPL", name: "Apple" },
			{ symbol: "ZM", name: "Zoom" },
		]);
		await storeDirectory("JP", [
			{ symbol: "1380", name: "Akikawa Foods", localName: "秋川牧園" },
			{ symbol: "7974", name: "Nintendo", localName: "任天堂" },
		]);
		await watch("JP", "7974");
		await watch("US", "ZM");
		const candidates = await persistence().equitySync.untrackedDirectoryListings(OWNER, 10);
		expect(candidates.map((candidate) => `${candidate.market}:${candidate.symbol}`)).toEqual([
			"US:ZM",
			"JP:7974",
			"US:AAPL",
			"US:NFLX",
			"JP:1380",
		]);
		expect(candidates[1]).toEqual({
			market: "JP",
			symbol: "7974",
			name: "Nintendo",
			localName: "任天堂",
			companyId: null,
		});
		expect(await persistence().equitySync.untrackedDirectoryListings(OWNER, 2)).toHaveLength(2);
	});

	it("tracks a batch due now, re-tracks an untracked company, and lists nothing after", async () => {
		await storeDirectory("US", [
			{ symbol: "AAPL", name: "Apple" },
			{ symbol: "KO", name: "Coca-Cola" },
		]);
		await persistence().equitySync.trackListings(
			OWNER,
			[
				{
					companyId: "eqc_ko",
					market: "US",
					symbol: "KO",
					provider: "sec",
					name: null,
					existing: false,
				},
			],
			AT,
		);
		await run("UPDATE equity_company SET tracked = 0 WHERE company_id = 'eqc_ko'");
		const candidates = await persistence().equitySync.untrackedDirectoryListings(OWNER, 10);
		expect(candidates.map((candidate) => [candidate.symbol, candidate.companyId])).toEqual([
			["AAPL", null],
			["KO", "eqc_ko"],
		]);
		const written = await persistence().equitySync.trackListings(
			OWNER,
			candidates.map((candidate) => ({
				companyId: candidate.companyId ?? "eqc_aapl",
				market: candidate.market,
				symbol: candidate.symbol,
				provider: "sec",
				name: candidate.name,
				existing: candidate.companyId !== null,
			})),
			LATER,
		);
		expect(written).toEqual({ inserted: 1, retracked: 1 });
		expect(
			await all(
				`SELECT eco.company_id, eco.tracked, eco.tracked_at, ess.next_due_at, ess.sync_requested_at
				FROM equity_company AS eco
				JOIN equity_sync_state AS ess
					ON ess.owner_id = eco.owner_id AND ess.company_id = eco.company_id
				ORDER BY eco.company_id`,
			),
		).toEqual([
			{
				company_id: "eqc_aapl",
				tracked: 1,
				tracked_at: LATER,
				next_due_at: LATER,
				sync_requested_at: LATER,
			},
			{
				company_id: "eqc_ko",
				tracked: 1,
				tracked_at: LATER,
				next_due_at: LATER,
				sync_requested_at: LATER,
			},
		]);
		expect(await persistence().equitySync.untrackedDirectoryListings(OWNER, 10)).toEqual([]);
		// A repeat (a concurrent reconcile) writes nothing.
		expect(
			await persistence().equitySync.trackListings(
				OWNER,
				[
					{
						companyId: "eqc_other",
						market: "US",
						symbol: "AAPL",
						provider: "sec",
						name: null,
						existing: false,
					},
				],
				LATER,
			),
		).toEqual({ inserted: 0, retracked: 0 });
	});

	it("makes a Japanese company due only when the EDINET index holds a report of it", async () => {
		await storeDirectory("JP", [
			{ symbol: "7974", name: "Nintendo" },
			{ symbol: "1380", name: "Akikawa Foods" },
		]);
		await commitIndex([indexDocument("S100AAAA", "79740")]);
		await trackCandidates(AT);
		expect(
			await all(
				"SELECT company_id, next_due_at FROM equity_sync_state WHERE owner_id = ? ORDER BY company_id",
				OWNER,
			),
		).toEqual([
			{ company_id: "eqc_JP_1380", next_due_at: null },
			{ company_id: "eqc_JP_7974", next_due_at: AT },
		]);
	});

	it("untracks only listings that left a stored directory, off the schedule, data kept", async () => {
		await storeDirectory("US", [{ symbol: "AAPL", name: "Apple" }]);
		await trackCandidates(AT);
		// A JP company tracked earlier while no JP list is stored stays tracked.
		await persistence().equitySync.trackListings(
			OWNER,
			[
				{
					companyId: "eqc_jp",
					market: "JP",
					symbol: "7974",
					provider: "edinet",
					name: null,
					existing: false,
				},
				{
					companyId: "eqc_gone",
					market: "US",
					symbol: "GONE",
					provider: "sec",
					name: null,
					existing: false,
				},
			],
			AT,
		);
		await run(
			`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
				filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
			VALUES (?, 'eqc_gone', '0000000000-25-000001', '10-K', '2025-11-01', '2025-09-30',
				'https://www.sec.gov/x', 'not-found', '[]', 0, ?)`,
			OWNER,
			AT,
		);
		expect(await persistence().equitySync.untrackDelisted(OWNER, 500)).toBe(1);
		expect(
			await all(
				`SELECT eco.company_id, eco.tracked, ess.next_due_at
				FROM equity_company AS eco
				JOIN equity_sync_state AS ess
					ON ess.owner_id = eco.owner_id AND ess.company_id = eco.company_id
				ORDER BY eco.company_id`,
			),
		).toEqual([
			{ company_id: "eqc_US_AAPL", tracked: 1, next_due_at: AT },
			{ company_id: "eqc_gone", tracked: 0, next_due_at: null },
			{ company_id: "eqc_jp", tracked: 1, next_due_at: null },
		]);
		expect(await all("SELECT company_id FROM equity_business_description")).toEqual([
			{ company_id: "eqc_gone" },
		]);
		expect(await persistence().equitySync.untrackDelisted(OWNER, 500)).toBe(0);
	});
});

describe("the due company (ADR-0058 §3)", () => {
	it("serves never-checked companies before every company being refreshed", async () => {
		await storeDirectory("US", [
			{ symbol: "AAPL", name: "Apple" },
			{ symbol: "MSFT", name: "Microsoft" },
		]);
		await trackCandidates("2026-11-01T12:00:00.000Z");
		// AAPL was checked and is due since long ago; MSFT was never checked and due later.
		await persistence().equitySync.reschedule(OWNER, "eqc_US_AAPL", {
			nextDueAt: "2026-10-01T00:00:00.000Z",
			edinetPhase: null,
			checkedAt: "2026-09-24T00:00:00.000Z",
		});
		const probe = await persistence().equitySync.probe(OWNER, AT);
		expect(probe).toEqual({ activeJob: false, dueCompanyId: "eqc_US_MSFT" });
		await persistence().equitySync.reschedule(OWNER, "eqc_US_MSFT", {
			nextDueAt: LATER,
			edinetPhase: null,
			checkedAt: AT,
		});
		expect((await persistence().equitySync.probe(OWNER, AT)).dueCompanyId).toBe("eqc_US_AAPL");
		await run("UPDATE equity_company SET tracked = 0 WHERE company_id = 'eqc_US_AAPL'");
		expect((await persistence().equitySync.probe(OWNER, AT)).dueCompanyId).toBeNull();
	});

	it("reads a Japanese company's indexed reports and whether it is on the Watchlist", async () => {
		await storeDirectory("JP", [{ symbol: "7974", name: "Nintendo" }]);
		await commitIndex([
			indexDocument("S100BBBB", "79740", { submittedAt: "2026-06-26T16:00:00+09:00" }),
			indexDocument("S100AAAA", "79740"),
			indexDocument("S100CCCC", "13800"),
		]);
		await trackCandidates(AT);
		await watch("JP", "7974");
		const context = await persistence().equitySync.claimContext(OWNER, "eqc_JP_7974");
		expect(context?.onWatchlist).toBe(true);
		expect(context?.indexedReports.map((report) => report.docId)).toEqual(["S100AAAA", "S100BBBB"]);
		expect(context?.indexedReports[0]).toEqual({
			...indexDocument("S100AAAA", "79740"),
			listedOn: "2026-06-26",
		});
		const [summary] = await persistence().equitySync.listSummaries(OWNER, {
			companyId: "eqc_JP_7974",
		});
		expect(summary?.onWatchlist).toBe(true);
	});
});

describe("the shared EDINET index (ADR-0058 §4)", () => {
	it("stores the day and its reports once, and makes due the companies with an unstored report", async () => {
		await storeDirectory("JP", [
			{ symbol: "7974", name: "Nintendo" },
			{ symbol: "1380", name: "Akikawa Foods" },
			{ symbol: "6758", name: "Sony" },
		]);
		await trackCandidates(AT);
		// 6758 stored the report already; 1380 is untracked.
		await run(
			`INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider,
				source_document_id, form, filed_on, period_end, source_url, facts_status, fact_count,
				first_seen_at, recorded_at)
			VALUES (?, ?, 'eqc_JP_6758', 'edinet', 'S100SONY', 'securities-report', '2026-06-26',
				'2026-03-31', 'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SONY',
				'unavailable', 0, ?, ?)`,
			OWNER,
			equityFilingId("eqc_JP_6758", "edinet", "S100SONY"),
			AT,
			AT,
		);
		await run("UPDATE equity_company SET tracked = 0 WHERE company_id = 'eqc_JP_1380'");
		await run(
			"UPDATE equity_sync_state SET next_due_at = '2026-12-01T00:00:00.000Z' WHERE owner_id = ?",
			OWNER,
		);
		const documents = [
			indexDocument("S100AAAA", "79740"),
			indexDocument("S100BBBB", "13800"),
			indexDocument("S100SONY", "67580"),
			indexDocument("S100AMND", "79740", {
				docTypeCode: "130",
				periodStart: null,
				periodEnd: null,
				parentDocId: "S100AAAA",
			}),
		];
		expect(await commitIndex(documents)).toMatchObject({ kind: "committed" });
		expect(await all("SELECT listed_on, checked_at, document_count FROM edinet_index_day")).toEqual(
			[{ listed_on: "2026-06-26", checked_at: AT, document_count: 4 }],
		);
		expect(await persistence().edinetIndex.listedDays(OWNER, "2026-01-01")).toEqual(["2026-06-26"]);
		expect(await persistence().edinetIndex.listedDays(OWNER, "2026-07-01")).toEqual([]);
		expect(
			await all(
				"SELECT doc_id, doc_type_code, period_end FROM edinet_document_index ORDER BY doc_id",
			),
		).toEqual([
			{ doc_id: "S100AAAA", doc_type_code: "120", period_end: "2026-03-31" },
			{ doc_id: "S100AMND", doc_type_code: "130", period_end: null },
			{ doc_id: "S100BBBB", doc_type_code: "120", period_end: "2026-03-31" },
			{ doc_id: "S100SONY", doc_type_code: "120", period_end: "2026-03-31" },
		]);
		expect(
			await all(
				"SELECT company_id, next_due_at, sync_requested_at FROM equity_sync_state ORDER BY company_id",
			),
		).toEqual([
			{
				company_id: "eqc_JP_1380",
				next_due_at: "2026-12-01T00:00:00.000Z",
				sync_requested_at: AT,
			},
			{
				company_id: "eqc_JP_6758",
				next_due_at: "2026-12-01T00:00:00.000Z",
				sync_requested_at: AT,
			},
			{ company_id: "eqc_JP_7974", next_due_at: LATER, sync_requested_at: LATER },
		]);
		// The same day again (a concurrent job) inserts nothing new.
		expect(await commitIndex(documents, "2026-06-26", "run_again")).toMatchObject({
			kind: "committed",
		});
		expect(await all("SELECT doc_id FROM edinet_document_index")).toHaveLength(4);
	});

	it("writes nothing when the job compare-and-set loses", async () => {
		await persistence().jobs.insert(
			scheduledJobRecord({
				ownerId: OWNER,
				kind: "edinet-index",
				request: null,
				runId: "r",
				at: AT,
			}),
			"k",
			"edinet-index",
			50,
		);
		const committed = await persistence().unitOfWork.commitCompletion(
			OWNER,
			{ runId: "r", expectedVersion: 7, patch: { state: "completed" }, audits: [], at: LATER },
			{
				...EMPTY_EFFECTS,
				edinetIndex: {
					days: [{ listedOn: "2026-06-26", documentCount: 1 }],
					documents: [{ ...indexDocument("S100AAAA", "79740"), listedOn: "2026-06-26" }],
					checkedAt: AT,
					at: LATER,
				},
			},
		);
		expect(committed).toEqual({ kind: "job-conflict" });
		expect(await all("SELECT listed_on FROM edinet_index_day")).toEqual([]);
		expect(await all("SELECT doc_id FROM edinet_document_index")).toEqual([]);
	});
});

describe("sync job retention (ADR-0058 §3)", () => {
	const OLD = "2026-10-01T00:00:00.000Z";
	const BEFORE = "2026-10-26T00:00:00.000Z";

	async function insertJob(
		runId: string,
		kind: JobKind,
		state: JobRecord["state"],
		createdAt: string,
		request: JobRecord["request"] = null,
	): Promise<void> {
		await persistence().jobs.insert(
			{
				...scheduledJobRecord({ ownerId: OWNER, kind, request, runId, at: createdAt }),
				state,
			},
			`k_${runId}`,
			kind,
			10_000,
		);
		await run(
			`INSERT INTO job_transitions (owner_id, run_id, from_state, to_state, lease_generation, actor,
				reason, at)
			VALUES (?, ?, 'pending', ?, 0, 'test', 'test', ?)`,
			OWNER,
			runId,
			state,
			createdAt,
		);
		await run(
			`INSERT INTO job_events (owner_id, run_id, lease_generation, seq, kind, text, at)
			VALUES (?, ?, 0, 0, 'state', 'x', ?)`,
			OWNER,
			runId,
			createdAt,
		);
	}

	const minute = (n: number) => new Date(Date.parse(OLD) + n * 60_000).toISOString();

	it("deletes old terminal sync jobs with their rows, never the newest of a kind, state and market", async () => {
		await insertJob("fs_1", "financial-sync", "completed", minute(1));
		await insertJob("fs_2", "financial-sync", "completed", minute(2));
		await insertJob("fs_3", "financial-sync", "failed", minute(3));
		await insertJob("fs_4", "financial-sync", "completed", minute(4));
		await insertJob("dir_us_1", "stock-directory-refresh", "completed", minute(5), {
			market: "US",
		});
		await insertJob("dir_jp_1", "stock-directory-refresh", "completed", minute(6), {
			market: "JP",
		});
		await insertJob("dir_us_2", "stock-directory-refresh", "completed", minute(7), {
			market: "US",
		});
		await insertJob("mk_narrow", "market-refresh", "completed", minute(8), {
			scope: "unrefreshed",
		});
		await insertJob("mk_full", "market-refresh", "completed", minute(9));
		await insertJob("mk_narrow_2", "market-refresh", "completed", minute(10), {
			scope: "unrefreshed",
		});
		// Recent, pending, or not a sync kind: never pruned (one active job of a kind at a time).
		await insertJob("fs_recent", "financial-sync", "completed", "2026-11-01T00:00:00.000Z");
		await insertJob("fs_pending", "financial-sync", "pending", minute(11));
		await insertJob("research_1", "research", "completed", minute(12));
		await insertJob("research_2", "research", "completed", minute(13));
		const deleted = await persistence().jobRetention.pruneTerminalJobs(
			OWNER,
			PRUNED_SYNC_JOB_KINDS,
			BEFORE,
			500,
		);
		expect(deleted).toBe(5);
		const left = (await all("SELECT run_id FROM research_jobs ORDER BY run_id")).map(
			(row) => row.run_id,
		);
		expect(left).toEqual([
			"dir_jp_1",
			"dir_us_2",
			"fs_3",
			"fs_pending",
			"fs_recent",
			"mk_full",
			"mk_narrow_2",
			"research_1",
			"research_2",
		]);
		const childRuns = async (table: string) =>
			(await all(`SELECT DISTINCT run_id FROM ${table} ORDER BY run_id`)).map((row) => row.run_id);
		expect(await childRuns("job_transitions")).toEqual(left);
		expect(await childRuns("job_events")).toEqual(left);
		// Nothing left to delete: a second run deletes nothing.
		expect(
			await persistence().jobRetention.pruneTerminalJobs(OWNER, PRUNED_SYNC_JOB_KINDS, BEFORE, 500),
		).toBe(0);
		// The latest-job reads still see what they saw.
		expect(
			await persistence().jobs.findLatestByKind(OWNER, "financial-sync", { fullOnly: false }),
		).toMatchObject({ createdAt: "2026-11-01T00:00:00.000Z" });
		expect(await persistence().jobs.findLatestFailedByKind(OWNER, "financial-sync")).not.toBeNull();
		expect(
			await persistence().jobs.findLatestByKind(OWNER, "market-refresh", { fullOnly: true }),
		).toMatchObject({ createdAt: minute(9) });
	});

	it("deletes at most the batch, oldest first", async () => {
		for (let index = 1; index <= 6; index += 1) {
			await insertJob(`fs_${index}`, "financial-sync", "completed", minute(index));
		}
		expect(
			await persistence().jobRetention.pruneTerminalJobs(OWNER, PRUNED_SYNC_JOB_KINDS, BEFORE, 2),
		).toBe(2);
		expect(
			(await all("SELECT run_id FROM research_jobs ORDER BY run_id")).map((row) => row.run_id),
		).toEqual(["fs_3", "fs_4", "fs_5", "fs_6"]);
	});
});
