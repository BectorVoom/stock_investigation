/**
 * Benchmark cases of ADR-0058 §3–§4 (every directory stock tracked, the
 * shared EDINET index, sync-job retention), run by `scripts/bench.ts`
 * through the real repositories and unit of work on `node:sqlite` with the
 * production migrations, at the directory's real size: 7,700 US and 3,700
 * JP stocks (11,400 companies), 30,000 indexed EDINET reports, 16,000
 * terminal `financial-sync` jobs. On D1 the same SQL runs inside the
 * database, so these budget the SQL engine work of one claim, not Worker
 * CPU. Fixtures are built once (untimed); a write case restores its rows in
 * its untimed setup, so every sample measures the same work.
 */
import { fileURLToPath } from "node:url";
import {
	type CompletionEffects,
	type EdinetIndexEffects,
	type EquityListingToTrack,
	PRUNED_SYNC_JOB_KINDS,
	scheduledJobRecord,
} from "@research/application";
import type { EdinetIndexDocument } from "@research/contracts";
import { createSqlPersistence } from "../packages/adapters/src/sql/index.ts";
import {
	applySqlMigrations,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
} from "../packages/adapters/src/sqlite/index.ts";

/** The shape of a `scripts/bench.ts` case. */
export interface EquityBenchCase {
	readonly name: string;
	readonly budgetMs: number;
	readonly setup?: () => unknown;
	readonly run: () => unknown;
}

const OWNER = "owner_bench";
const AT = "2026-11-02T00:00:00.000Z";
const BATCH_AT = "2026-11-02T00:00:01.000Z";
const US_COUNT = 7_700;
const JP_COUNT = 3_700;
const MIGRATIONS = readSqlMigrations(
	fileURLToPath(new URL("../infra/migrations", import.meta.url)),
);

const usSymbol = (index: number) => `U${String(index).padStart(5, "0")}`;
const jpSymbol = (index: number) => String(1300 + index);
const day = (offset: number) =>
	new Date(Date.UTC(2020, 10, 2) + offset * 86_400_000).toISOString().slice(0, 10);

/** A database holding both directories, 10 Watchlist stocks and `tracked` of the companies tracked. */
async function directoryDatabase(tracked: number): Promise<NodeSqliteDatabase> {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(db, MIGRATIONS);
	const rows = [
		...Array.from({ length: US_COUNT }, (_, index) => ["US", usSymbol(index), `US ${index}`, null]),
		...Array.from({ length: JP_COUNT }, (_, index) => [
			"JP",
			jpSymbol(index),
			`JP ${index}`,
			`日本${index}`,
		]),
	];
	await db
		.prepare(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing, symbol_key,
				name_key, local_name_key, search_key)
			SELECT ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
				json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'), 'nyse',
				lower(json_extract(incoming.value, '$[1]')), lower(json_extract(incoming.value, '$[2]')), '',
				lower(json_extract(incoming.value, '$[1]'))
			FROM json_each(?) AS incoming`,
		)
		.bind(OWNER, JSON.stringify(rows))
		.run();
	for (const [market, count] of [
		["US", US_COUNT],
		["JP", JP_COUNT],
	] as const) {
		await db
			.prepare(
				`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at,
					fold_version)
				VALUES (?, ?, ?, NULL, ?, 1)`,
			)
			.bind(OWNER, market, count, AT)
			.run();
	}
	for (let index = 0; index < 10; index += 1) {
		const symbol = usSymbol(US_COUNT - 1 - index);
		await db
			.prepare(
				`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
				VALUES (?, ?, 'US', ?, NULL, ?)`,
			)
			.bind(OWNER, `us:${symbol}`, symbol, AT)
			.run();
	}
	const listings = rows.slice(0, tracked).map(
		([market, symbol]): EquityListingToTrack => ({
			companyId: `eqc_${market}_${symbol}`,
			market: market === "US" ? "US" : "JP",
			symbol: String(symbol),
			provider: market === "US" ? "sec" : "edinet",
			name: null,
			existing: false,
		}),
	);
	const repo = createSqlPersistence(db).equitySync;
	for (let start = 0; start < listings.length; start += 500) {
		await repo.trackListings(OWNER, listings.slice(start, start + 500), AT);
	}
	return db;
}

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

function indexDocument(
	index: number,
	listedOn: string,
): EdinetIndexDocument & { listedOn: string } {
	return {
		docId: `S1${String(index).padStart(6, "0")}`,
		secCode: `${jpSymbol(index % JP_COUNT)}0`,
		edinetCode: `E${String(index % 99_999).padStart(5, "0")}`,
		filerName: `株式会社ベンチ${index}`,
		docTypeCode: "120",
		periodStart: "2025-04-01",
		periodEnd: "2026-03-31",
		submittedAt: `${listedOn}T15:00:00+09:00`,
		parentDocId: null,
		listedOn,
	};
}

/** Stores `count` indexed reports over consecutive days through an `edinet-indexed` commit. */
async function storeIndex(db: NodeSqliteDatabase, count: number, perDay: number, runId: string) {
	const days = Math.ceil(count / perDay);
	const effects: EdinetIndexEffects = {
		days: Array.from({ length: days }, (_, offset) => ({
			listedOn: day(offset),
			documentCount: perDay,
		})),
		documents: Array.from({ length: count }, (_, index) =>
			indexDocument(index, day(Math.floor(index / perDay))),
		),
		checkedAt: AT,
		at: AT,
	};
	return commitIndex(db, effects, runId);
}

async function commitIndex(db: NodeSqliteDatabase, effects: EdinetIndexEffects, runId: string) {
	const persistence = createSqlPersistence(db);
	await persistence.jobs.insert(
		scheduledJobRecord({ ownerId: OWNER, kind: "edinet-index", request: null, runId, at: AT }),
		`k_${runId}`,
		"edinet-index",
		100_000,
	);
	return persistence.unitOfWork.commitCompletion(
		OWNER,
		{ runId, expectedVersion: 0, patch: { state: "completed" }, audits: [], at: AT },
		{ ...EMPTY_EFFECTS, edinetIndex: effects },
	);
}

export async function equityDirectoryBenchCases(): Promise<EquityBenchCase[]> {
	// The first batch of a fresh install: 500 untracked stocks picked and tracked.
	const fresh = await directoryDatabase(0);
	// Settled: every directory stock tracked, half never checked.
	const settled = await directoryDatabase(US_COUNT + JP_COUNT);
	await storeIndex(settled, 30_000, 20, "run_index_fixture");
	await settled
		.prepare(
			`UPDATE equity_sync_state SET last_checked_at = ?, next_due_at = ?
			WHERE owner_id = ? AND company_id IN (
				SELECT eco.company_id
				FROM equity_company AS eco
				WHERE eco.owner_id = ? AND eco.market = 'US'
			)`,
		)
		.bind(AT, "2026-11-09T00:00:00.000Z", OWNER, OWNER)
		.run();
	// Every company checked: the probe walks the refresh range.
	const checked = await directoryDatabase(US_COUNT + JP_COUNT);
	await checked
		.prepare("UPDATE equity_sync_state SET last_checked_at = ?, next_due_at = ? WHERE owner_id = ?")
		.bind(AT, "2026-11-01T00:00:00.000Z", OWNER)
		.run();
	// 16,000 terminal financial-sync jobs older than the cutoff, 3 transitions
	// each: 30 samples of 500 deletions never run out.
	const jobs = openNodeSqlite(":memory:");
	applySqlMigrations(jobs, MIGRATIONS);
	await jobs
		.prepare(
			`INSERT INTO research_jobs (owner_id, run_id, kind, state, idempotency_key,
				request_fingerprint, request_json, workspace_id, usage_json, attempt, max_attempts,
				lease_generation, lease_owner_id, lease_expires_at, last_event_seq, cancel_requested,
				failure_code, approval_request_json, retry_of_run_id, verification_status, provider_model,
				provider_session_ref, completed_generation, provenance_json, version, last_mutation_id,
				created_at, updated_at)
			SELECT ?, 'run_' || printf('%05d', numbers.value), 'financial-sync', 'completed',
				'k_' || numbers.value, 'financial-sync',
				json_object('companyId', 'eqc_' || numbers.value), NULL, '{}', 1, 3, 1, NULL, NULL, -1, 0,
				NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, 2, 'mutation',
				strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01', '+' || numbers.value || ' minutes'),
				strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01', '+' || numbers.value || ' minutes')
			FROM json_each(?) AS numbers`,
		)
		.bind(OWNER, JSON.stringify(Array.from({ length: 16_000 }, (_, index) => index)))
		.run();
	await jobs
		.prepare(
			`INSERT INTO job_transitions (owner_id, run_id, from_state, to_state, lease_generation, actor,
				reason, at)
			SELECT rj.owner_id, rj.run_id, 'pending', 'completed', 1, 'bench', 'bench', rj.created_at
			FROM research_jobs AS rj
			CROSS JOIN json_each('[1,2,3]') AS copies`,
		)
		.run();
	const JOBS_BEFORE = "2026-10-26T00:00:00.000Z";

	const day40 = Array.from({ length: 40 }, (_, offset) => day(4_000 + offset));
	const busyCompletion: EdinetIndexEffects = {
		days: day40.map((listedOn) => ({ listedOn, documentCount: 90 })),
		documents: Array.from({ length: 3_600 }, (_, index) =>
			indexDocument(100_000 + index, day40[Math.floor(index / 90)] ?? day(0)),
		),
		checkedAt: AT,
		at: AT,
	};
	let indexRun = 0;

	return [
		{
			name: "directory reconcile: pick and track a 500-stock batch of 11,400 (first batch)",
			budgetMs: 60,
			setup: async () => {
				await fresh
					.prepare("DELETE FROM equity_sync_state WHERE owner_id = ? AND sync_requested_at = ?")
					.bind(OWNER, BATCH_AT)
					.run();
				await fresh
					.prepare("DELETE FROM equity_company WHERE owner_id = ? AND tracked_at = ?")
					.bind(OWNER, BATCH_AT)
					.run();
			},
			run: async () => {
				const repo = createSqlPersistence(fresh).equitySync;
				const candidates = await repo.untrackedDirectoryListings(OWNER, 500);
				await repo.trackListings(
					OWNER,
					candidates.map((candidate) => ({
						companyId: `eqc_batch_${candidate.market}_${candidate.symbol}`,
						market: candidate.market,
						symbol: candidate.symbol,
						provider: candidate.market === "US" ? "sec" : "edinet",
						name: candidate.name,
						existing: false,
					})),
					BATCH_AT,
				);
			},
		},
		{
			name: "directory reconcile: scan 11,400 tracked stocks, nothing to track or untrack",
			budgetMs: 40,
			run: async () => {
				const repo = createSqlPersistence(settled).equitySync;
				await repo.untrackedDirectoryListings(OWNER, 500);
				await repo.untrackDelisted(OWNER, 500);
			},
		},
		{
			name: "due-company probe, 11,400 companies, 3,700 never checked",
			budgetMs: 0.5,
			run: () => createSqlPersistence(settled).equitySync.probe(OWNER, AT),
		},
		{
			name: "due-company probe, 11,400 companies all checked and due",
			budgetMs: 0.5,
			run: () => createSqlPersistence(checked).equitySync.probe(OWNER, AT),
		},
		{
			name: "claim context of a Japanese company, 30,000 indexed reports",
			budgetMs: 0.5,
			run: () => createSqlPersistence(settled).equitySync.claimContext(OWNER, "eqc_JP_1300"),
		},
		{
			name: "edinet-indexed completion: 40 days, 3,600 reports, due marks over 3,700 JP companies",
			budgetMs: 80,
			setup: async () => {
				await settled
					.prepare("DELETE FROM edinet_document_index WHERE owner_id = ? AND listed_on >= ?")
					.bind(OWNER, day40[0] ?? day(0))
					.run();
				await settled
					.prepare("DELETE FROM edinet_index_day WHERE owner_id = ? AND listed_on >= ?")
					.bind(OWNER, day40[0] ?? day(0))
					.run();
			},
			run: async () => {
				indexRun += 1;
				const outcome = await commitIndex(settled, busyCompletion, `run_index_${indexRun}`);
				if (outcome.kind !== "committed") throw new Error("the index completion did not commit");
			},
		},
		{
			name: "listed EDINET days of the 6-year window (1,500 rows)",
			budgetMs: 1,
			run: () => createSqlPersistence(settled).edinetIndex.listedDays(OWNER, day(0)),
		},
		{
			name: "sync-job retention: one 500-job batch of 16,000 terminal jobs (3 transitions each)",
			budgetMs: 40,
			// Deleted rows are not restored: every sample deletes the next 500.
			run: () =>
				createSqlPersistence(jobs).jobRetention.pruneTerminalJobs(
					OWNER,
					PRUNED_SYNC_JOB_KINDS,
					JOBS_BEFORE,
					500,
				),
		},
	];
}
