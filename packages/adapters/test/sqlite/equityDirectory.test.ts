/**
 * ADR-0058 §3 on node:sqlite: every directory stock tracked in batches —
 * US and JP alike since ADR-0059 — never-checked companies first, the
 * retention of old sync jobs; and the J-Quants company profiles a JP
 * directory completion stores (ADR-0059 §3).
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
	equityTrackDueAt,
	type JobRecord,
	PRUNED_SYNC_JOB_KINDS,
	type StockDirectoryCompletion,
	scheduledJobRecord,
} from "@research/application";
import type { JobKind, StockCompanyProfile } from "@research/contracts";
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

/** Records a check of a company and when it is due next (as a job's end would). */
async function checked(companyId: string, checkedAt: string, nextDueAt: string): Promise<void> {
	await run(
		`UPDATE equity_sync_state SET last_checked_at = ?, next_due_at = ?
		WHERE owner_id = ? AND company_id = ?`,
		checkedAt,
		nextDueAt,
		OWNER,
		companyId,
	);
}

/** Tracks every candidate the reconcile would, with deterministic ids. */
async function trackCandidates(at: string, limit = 500) {
	const repo = persistence().equitySync;
	const candidates = await repo.untrackedDirectoryListings(OWNER, limit);
	await repo.trackListings(
		OWNER,
		candidates.map((candidate, index) => ({
			companyId: candidate.companyId ?? `eqc_${candidate.market}_${candidate.symbol}`,
			market: candidate.market,
			symbol: candidate.symbol,
			provider: candidate.market === "US" ? "sec" : "jquants",
			name: candidate.name,
			existing: candidate.companyId !== null,
			dueAt: equityTrackDueAt(Date.parse(at), index, candidate.onWatchlist),
		})),
		at,
	);
	return candidates;
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
			onWatchlist: true,
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
					dueAt: AT,
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
				dueAt: LATER,
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
						dueAt: LATER,
					},
				],
				LATER,
			),
		).toEqual({ inserted: 0, retracked: 0 });
	});

	// ADR-0059 §2: no EDINET index gates a Japanese company any more.
	it("makes a Japanese company due at its place in the batch, like a US one", async () => {
		await storeDirectory("JP", [
			{ symbol: "7974", name: "Nintendo" },
			{ symbol: "1380", name: "Akikawa Foods" },
		]);
		await trackCandidates(AT);
		expect(
			await all(
				`SELECT eco.company_id, eco.provider, ess.next_due_at, ess.last_checked_at
				FROM equity_company AS eco
				JOIN equity_sync_state AS ess
					ON ess.owner_id = eco.owner_id AND ess.company_id = eco.company_id
				WHERE eco.owner_id = ?
				ORDER BY eco.company_id`,
				OWNER,
			),
		).toEqual([
			// The batch's order: 1380 first, 7974 a millisecond later; never checked.
			{
				company_id: "eqc_JP_1380",
				provider: "jquants",
				next_due_at: AT,
				last_checked_at: null,
			},
			{
				company_id: "eqc_JP_7974",
				provider: "jquants",
				next_due_at: "2026-11-02T00:00:00.001Z",
				last_checked_at: null,
			},
		]);
		expect((await persistence().equitySync.probe(OWNER, LATER)).dueCompanyId).toBe("eqc_JP_1380");
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
					provider: "jquants",
					name: null,
					existing: false,
					dueAt: AT,
				},
				{
					companyId: "eqc_gone",
					market: "US",
					symbol: "GONE",
					provider: "sec",
					name: null,
					existing: false,
					dueAt: AT,
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
			{ company_id: "eqc_jp", tracked: 1, next_due_at: AT },
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
		await checked("eqc_US_AAPL", "2026-09-24T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
		const probe = await persistence().equitySync.probe(OWNER, AT);
		expect(probe).toEqual({ activeJob: false, dueCompanyId: "eqc_US_MSFT" });
		await checked("eqc_US_MSFT", AT, LATER);
		expect((await persistence().equitySync.probe(OWNER, AT)).dueCompanyId).toBe("eqc_US_AAPL");
		await run("UPDATE equity_company SET tracked = 0 WHERE company_id = 'eqc_US_AAPL'");
		expect((await persistence().equitySync.probe(OWNER, AT)).dueCompanyId).toBeNull();
	});

	it("reads whether a Japanese company is on the Watchlist", async () => {
		await storeDirectory("JP", [{ symbol: "7974", name: "Nintendo" }]);
		await trackCandidates(AT);
		await watch("JP", "7974");
		const context = await persistence().equitySync.claimContext(OWNER, "eqc_JP_7974");
		expect(context?.onWatchlist).toBe(true);
		expect(context?.company.provider).toBe("jquants");
		expect(context?.filings).toEqual([]);
		const [summary] = await persistence().equitySync.listSummaries(OWNER, {
			companyId: "eqc_JP_7974",
		});
		expect(summary?.onWatchlist).toBe(true);
	});
});

/** Toyota, Nintendo and Veritas In Silico as J-Quants' Listed Issue Master answered on 2026-11-02. */
const TOYOTA: StockCompanyProfile = {
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
const NINTENDO: StockCompanyProfile = {
	symbol: "7974",
	nameEn: "Nintendo Co.,Ltd.",
	sector17Code: "10",
	sector17Name: "情報通信・サービスその他",
	sector33Code: "3800",
	sector33Name: "その他製品",
	scaleCategory: "TOPIX Core30",
	marketSegmentCode: "0111",
	marketSegmentName: "プライム",
	asOf: "2026-08-10",
};
/** J-Quants states its scale category as "-" (no TOPIX group). */
const VERITAS: StockCompanyProfile = {
	symbol: "130A",
	nameEn: "Veritas In Silico Inc.",
	sector17Code: "5",
	sector17Name: "医薬品",
	sector33Code: "3250",
	sector33Name: "医薬品",
	scaleCategory: null,
	marketSegmentCode: "0113",
	marketSegmentName: "グロース",
	asOf: "2026-08-10",
};

/** Commits a JP `stock-directory-refreshed` completion of a fresh job. */
async function commitDirectory(
	symbols: readonly string[],
	profiles: readonly StockCompanyProfile[] | null,
	runId: string,
	expectedVersion = 0,
) {
	const p = persistence();
	await p.jobs.insert(
		scheduledJobRecord({
			ownerId: OWNER,
			kind: "stock-directory-refresh",
			request: { market: "JP" },
			runId,
			at: AT,
		}),
		`k_${runId}`,
		"stock-directory-refresh",
		50,
	);
	const directory: StockDirectoryCompletion = {
		market: "JP",
		asOf: "2026-10-31",
		retrievedAt: LATER,
		foldVersion: 1,
		rows: symbols.map((symbol) => ({
			market: "JP",
			symbol,
			name: `Company ${symbol}`,
			localName: null,
			listing: "tse-prime",
			symbolKey: symbol.toLowerCase(),
			nameKey: `company ${symbol}`,
			localNameKey: "",
			searchKey: symbol.toLowerCase(),
		})),
		profiles,
	};
	return p.unitOfWork.commitCompletion(
		OWNER,
		{ runId, expectedVersion, patch: { state: "completed" }, audits: [], at: LATER },
		{ ...EMPTY_EFFECTS, stockDirectory: directory },
	);
}

const storedProfiles = () =>
	all(
		`SELECT scp.symbol, scp.name_en, scp.sector33_name, scp.scale_category, scp.as_of,
			scp.retrieved_at
		FROM stock_company_profile AS scp
		WHERE scp.owner_id = ? AND scp.market = 'JP'
		ORDER BY scp.symbol`,
		OWNER,
	);

describe("company profiles of the JP directory (ADR-0059 §3)", () => {
	it("replaces the market's profiles, keeping symbols of the stored list only", async () => {
		const outsider = { ...TOYOTA, symbol: "9999" };
		expect(await commitDirectory(["7203", "7974"], [TOYOTA, NINTENDO, outsider], "r1")).toEqual({
			kind: "committed",
			newArticleCount: 0,
		});
		expect(await storedProfiles()).toEqual([
			{
				symbol: "7203",
				name_en: "TOYOTA MOTOR CORPORATION",
				sector33_name: "輸送用機器",
				scale_category: "TOPIX Core30",
				as_of: "2026-08-10",
				retrieved_at: LATER,
			},
			{
				symbol: "7974",
				name_en: "Nintendo Co.,Ltd.",
				sector33_name: "その他製品",
				scale_category: "TOPIX Core30",
				as_of: "2026-08-10",
				retrieved_at: LATER,
			},
		]);
		expect(await persistence().stockDirectory.getCompanyProfile(OWNER, "JP", "7203")).toEqual({
			...TOYOTA,
			retrievedAt: LATER,
		});
		expect(await persistence().stockDirectory.getCompanyProfile(OWNER, "JP", "9999")).toBeNull();

		// A null `profiles` keeps the stored rows; a list replaces them all.
		await commitDirectory(["7203", "7974"], null, "r2");
		expect(await storedProfiles()).toHaveLength(2);
		await commitDirectory(["130A", "7203"], [VERITAS, { ...TOYOTA, nameEn: null }], "r3");
		expect(await storedProfiles()).toEqual([
			{
				symbol: "130A",
				name_en: "Veritas In Silico Inc.",
				sector33_name: "医薬品",
				scale_category: null,
				as_of: "2026-08-10",
				retrieved_at: LATER,
			},
			{
				symbol: "7203",
				name_en: null,
				sector33_name: "輸送用機器",
				scale_category: "TOPIX Core30",
				as_of: "2026-08-10",
				retrieved_at: LATER,
			},
		]);
		await commitDirectory(["7203"], [], "r4");
		expect(await storedProfiles()).toEqual([]);
	});

	it("writes nothing when the job compare-and-set loses", async () => {
		expect(await commitDirectory(["7203"], [TOYOTA], "r_stale", 7)).toEqual({
			kind: "job-conflict",
		});
		expect(await storedProfiles()).toEqual([]);
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
