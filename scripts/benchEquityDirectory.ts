/**
 * Benchmark cases of ADR-0058 §3 and ADR-0059 (every directory stock
 * tracked, the due probe, a Japanese company's J-Quants claim, the JP list's
 * company profiles, sync-job retention), run by `scripts/bench.ts`
 * through the real repositories and unit of work on `node:sqlite` with the
 * production migrations, at the directory's real size: 7,700 US and 3,700
 * JP stocks (11,400 companies), two J-Quants summaries per Japanese company,
 * 16,000 terminal `financial-sync` jobs. On D1 the same SQL runs inside the
 * database, so these budget the SQL engine work of one claim, not Worker
 * CPU. Fixtures are built once (untimed); a write case restores its rows in
 * its untimed setup, so every sample measures the same work.
 */
import { fileURLToPath } from "node:url";
import {
	type CompletionEffects,
	type EquityListingToTrack,
	equitySyncRequestOf,
	PRUNED_SYNC_JOB_KINDS,
	type StockDirectoryCompletion,
	scheduledJobRecord,
	stockDirectoryRows,
} from "@research/application";
import type { StockCompanyProfile } from "@research/contracts";
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
			provider: market === "US" ? "sec" : "jquants",
			name: null,
			existing: false,
			dueAt: AT,
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

/**
 * Two stored J-Quants full-year summaries (ADR-0059 §2) for every Japanese
 * company, as `financial-synced` completions leave them (facts are not
 * read by the claim, so none are stored).
 */
async function storeJquantsFilings(db: NodeSqliteDatabase): Promise<void> {
	await db
		.prepare(
			`INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider,
				source_document_id, form, filed_on, submitted_at, period_start, period_end,
				accounting_standard, amends_source_document_id, source_url, facts_status, fact_count,
				primary_scope, first_seen_at, recorded_at)
			SELECT eco.owner_id, eco.company_id || ':jquants:' || years.value || '0508' || eco.symbol || '00',
				eco.company_id, 'jquants', years.value || '0508' || eco.symbol || '00', 'earnings-report',
				years.value || '-05-08', NULL, (years.value - 1) || '-04-01', years.value || '-03-31',
				'JGAAP', NULL, 'https://api.jquants.com/v2/fins/summary?code=' || eco.symbol || '0',
				'extracted', 12, 'consolidated', ?, ?
			FROM equity_company AS eco
			CROSS JOIN json_each('[2025,2026]') AS years
			WHERE eco.owner_id = ? AND eco.market = 'JP'`,
		)
		.bind(AT, AT, OWNER)
		.run();
}

/** One J-Quants company profile per JP directory stock (ADR-0059 §3), shaped like the master's. */
function jquantsProfile(index: number): StockCompanyProfile {
	return {
		symbol: jpSymbol(index),
		nameEn: `BENCH ${index} CO.,LTD.`,
		sector17Code: "6",
		sector17Name: "自動車・輸送機",
		sector33Code: "3700",
		sector33Name: "輸送用機器",
		scaleCategory: index % 3 === 0 ? null : "TOPIX Small 1",
		marketSegmentCode: "0111",
		marketSegmentName: "プライム",
		asOf: "2026-08-10",
	};
}

export async function equityDirectoryBenchCases(): Promise<EquityBenchCase[]> {
	// The first batch of a fresh install: 500 untracked stocks picked and tracked.
	const fresh = await directoryDatabase(0);
	// Settled: every directory stock tracked, the Japanese ones never checked
	// (as migration 0027 leaves them) with two stored J-Quants summaries each.
	const settled = await directoryDatabase(US_COUNT + JP_COUNT);
	await storeJquantsFilings(settled);
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

	// A JP directory completion with J-Quants' profiles of every listed stock
	// (ADR-0059 §3): the list replaced, the profiles replaced and joined to it.
	const jpEntries = Array.from({ length: JP_COUNT }, (_, index) => ({
		symbol: jpSymbol(index),
		name: `JP ${index}`,
		localName: `日本${index}`,
		listing: "tse-prime" as const,
	}));
	const jpCompletion: StockDirectoryCompletion = {
		market: "JP",
		asOf: "2026-10-31",
		retrievedAt: AT,
		foldVersion: 1,
		rows: stockDirectoryRows("JP", jpEntries),
		// 4,444 issues on the master; the ETFs and preferreds beyond the list are dropped.
		profiles: Array.from({ length: 4_444 }, (_, index) => jquantsProfile(index)),
	};
	const profiles = await directoryDatabase(0);
	let directoryRun = 0;

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
						provider: candidate.market === "US" ? "sec" : "jquants",
						name: candidate.name,
						existing: false,
						dueAt: BATCH_AT,
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
			name: "J-Quants claim of a Japanese company: context and request, 7,400 stored summaries",
			budgetMs: 0.5,
			run: async () => {
				const context = await createSqlPersistence(settled).equitySync.claimContext(
					OWNER,
					"eqc_JP_1300",
				);
				if (context === null) throw new Error("no company");
				const request = equitySyncRequestOf(context, Date.parse(AT));
				if (request.provider !== "jquants" || request.knownDisclosures.length !== 2) {
					throw new Error("unexpected claim");
				}
			},
		},
		{
			name: "JP stock-directory completion: 3,700 rows and 4,444 J-Quants profiles replaced",
			budgetMs: 80,
			run: async () => {
				directoryRun += 1;
				const runId = `run_directory_${directoryRun}`;
				const persistence = createSqlPersistence(profiles);
				await persistence.jobs.insert(
					scheduledJobRecord({
						ownerId: OWNER,
						kind: "stock-directory-refresh",
						request: { market: "JP" },
						runId,
						at: AT,
					}),
					`k_${runId}`,
					"stock-directory-refresh",
					100_000,
				);
				const outcome = await persistence.unitOfWork.commitCompletion(
					OWNER,
					{ runId, expectedVersion: 0, patch: { state: "completed" }, audits: [], at: AT },
					{ ...EMPTY_EFFECTS, stockDirectory: jpCompletion },
				);
				if (outcome.kind !== "committed")
					throw new Error("the directory completion did not commit");
			},
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
