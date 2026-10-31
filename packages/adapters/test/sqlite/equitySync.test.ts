import { fileURLToPath } from "node:url";
import { chunkEquityRows, createSqlPersistence } from "@research/adapters/sql";
import {
	applySqlMigrations,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
} from "@research/adapters/sqlite";
import {
	EMPTY_EQUITY_SYNC_STATE,
	type EquitySyncCompletionEffects,
	type EquitySyncEffects,
	equityFilingId,
	type JobRecord,
	MAX_JOB_ATTEMPTS,
} from "@research/application";
import { EMPTY_USAGE } from "@research/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = readSqlMigrations(
	fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
);
const OWNER = "owner@example.test";
const COMPANY = "eqc_000000000000000000000001";
const AT = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-12T00:00:00.000Z";
const FILING = equityFilingId(COMPANY, "sec", "0000320193-25-000001");

function job(runId: string): JobRecord {
	return {
		runId,
		ownerId: OWNER,
		kind: "financial-sync",
		state: "pending",
		request: { companyId: COMPANY },
		workspaceId: null,
		usage: EMPTY_USAGE,
		attempt: 0,
		maxAttempts: MAX_JOB_ATTEMPTS,
		leaseGeneration: 0,
		leaseOwnerId: null,
		leaseExpiresAt: null,
		lastEventSeq: -1,
		cancelRequested: false,
		failureCode: null,
		failureDetail: null,
		failureUpstreamStatus: null,
		approvalRequest: null,
		retryOfRunId: null,
		contextAnchorSeq: null,
		verificationStatus: null,
		providerModel: null,
		providerSessionRef: null,
		completedGeneration: null,
		provenance: null,
		version: 0,
		createdAt: AT,
		updatedAt: AT,
	};
}

function synced(overrides: Partial<EquitySyncCompletionEffects> = {}): EquitySyncCompletionEffects {
	return {
		kind: "synced",
		companyId: COMPANY,
		identity: { sourceCompanyId: "0000320193", name: "Apple Inc.", fiscalYearEnd: "09-30" },
		newFilings: [
			{
				filingId: FILING,
				provider: "sec",
				sourceDocumentId: "0000320193-25-000001",
				form: "10-K",
				filedOn: "2025-11-01",
				submittedAt: null,
				periodStart: "2024-10-01",
				periodEnd: "2025-09-30",
				accountingStandard: "US-GAAP",
				amendsSourceDocumentId: null,
				sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/",
				factsStatus: "extracted",
				factCount: 1,
				primaryScope: "consolidated",
				firstSeenAt: AT,
				recordedAt: AT,
			},
		],
		finalizedFilings: [],
		facts: [
			{
				filingId: FILING,
				concept: "us-gaap:Revenues",
				scope: "consolidated",
				periodType: "duration",
				periodStart: "2024-10-01",
				periodEnd: "2025-09-30",
				unit: "USD",
				fiscalYear: 2025,
				metricCode: "revenue",
				valueDecimal: "391035000000",
			},
		],
		metricValues: [
			{
				metricCode: "revenue",
				fiscalYear: 2025,
				valueDecimal: "391035000000",
				currency: "USD",
				unavailableReason: null,
				filingId: FILING,
				concept: "us-gaap:Revenues",
				scope: "consolidated",
				periodStart: "2024-10-01",
				periodEnd: "2025-09-30",
				derived: false,
				reportedValueCount: 1,
			},
		],
		scannedDays: [],
		state: {
			checkedAt: AT,
			morePending: false,
			edinetPhase: null,
			nextDueAt: LATER,
			dataUpdatedAt: AT,
		},
		// `track` in beforeEach left the company due at AT: no "Sync now" since.
		schedule: { heldNextDueAt: AT },
		at: AT,
		...overrides,
	};
}

const EMPTY_EFFECTS = {
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
} as const;

describe("equity sync SQL (ADR-0048 §2, §6)", () => {
	let db: NodeSqliteDatabase;
	beforeEach(async () => {
		db = openNodeSqlite(":memory:");
		applySqlMigrations(db, MIGRATIONS);
		const persistence = createSqlPersistence(db);
		await persistence.equitySync.track(
			OWNER,
			{ companyId: COMPANY, market: "US", symbol: "AAPL", provider: "sec", name: null },
			20,
			AT,
		);
	});
	afterEach(() => db.close());

	async function rows(table: string) {
		return (await db.prepare(`SELECT * FROM ${table} WHERE owner_id = ?`).bind(OWNER).all())
			.results;
	}

	async function commit(runId: string, effects: EquitySyncEffects, expectedVersion = 0) {
		const persistence = createSqlPersistence(db);
		return persistence.unitOfWork.commitCompletion(
			OWNER,
			{
				runId,
				expectedVersion,
				patch: { state: "completed" },
				audits: [],
				at: effects.at,
			},
			{ ...EMPTY_EFFECTS, equitySync: effects },
		);
	}

	it("commits filings, facts, values and the sync state with the job", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		expect(await commit("run_1", synced())).toEqual({ kind: "committed", newArticleCount: 0 });
		expect(await rows("equity_report_filing")).toHaveLength(1);
		expect(await rows("equity_reported_fact")).toHaveLength(1);
		expect(await rows("equity_metric_value")).toEqual([
			expect.objectContaining({ value_decimal: "391035000000", updated_at: AT }),
		]);
		const [summary] = await persistence.equitySync.listSummaries(OWNER, { companyId: COMPANY });
		expect(summary?.company.sourceCompanyId).toBe("0000320193");
		expect(summary?.state).toMatchObject({
			lastSucceededAt: AT,
			nextDueAt: LATER,
			dataUpdatedAt: AT,
			consecutiveFailures: 0,
		});
		expect(summary?.latestFiscalYear).toBe(2025);
		expect(summary?.filingCount).toBe(1);
	});

	it("writes nothing when the job compare-and-set loses (stale lease)", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const before = await rows("equity_sync_state");
		expect(await commit("run_1", synced(), 7)).toEqual({ kind: "job-conflict" });
		expect(await rows("equity_report_filing")).toEqual([]);
		expect(await rows("equity_reported_fact")).toEqual([]);
		expect(await rows("equity_metric_value")).toEqual([]);
		expect(await rows("equity_sync_state")).toEqual(before);
		expect((await rows("equity_company"))[0]).toMatchObject({ source_company_id: null });
	});

	it("rolls the whole batch back when one statement fails", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const broken = synced({
			metricValues: [
				// Violates the table's CHECK: neither a value nor a reason.
				{
					metricCode: "gross-profit",
					fiscalYear: 2025,
					valueDecimal: null,
					currency: null,
					unavailableReason: null,
					filingId: null,
					concept: null,
					scope: null,
					periodStart: null,
					periodEnd: null,
					derived: false,
					reportedValueCount: 0,
				},
			],
		});
		await expect(commit("run_1", broken)).rejects.toThrow();
		expect(await rows("equity_report_filing")).toEqual([]);
		expect(await rows("equity_reported_fact")).toEqual([]);
		expect(await rows("equity_metric_value")).toEqual([]);
		const stored = await persistence.jobs.get(OWNER, "run_1");
		expect(stored?.state).toBe("pending");
		expect(stored?.version).toBe(0);
	});

	it("never rewrites stored rows when the same writes arrive again", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		await commit("run_1", synced());
		const filings = await rows("equity_report_filing");
		const facts = await rows("equity_reported_fact");
		const values = await rows("equity_metric_value");
		const company = await rows("equity_company");
		// A second job carrying identical rows (the service would not send
		// them; the SQL is the second line of defence): nothing changes.
		await persistence.jobs.insert(job("run_2"), "k2", "f", 5);
		const again = synced({
			at: LATER,
			newFilings: synced().newFilings.map((row) => ({
				...row,
				firstSeenAt: LATER,
				recordedAt: LATER,
				factCount: 99,
			})),
			state: { ...synced().state, checkedAt: LATER, dataUpdatedAt: null },
		});
		expect((await commit("run_2", again)).kind).toBe("committed");
		expect(await rows("equity_report_filing")).toEqual(filings);
		expect(await rows("equity_reported_fact")).toEqual(facts);
		expect(await rows("equity_metric_value")).toEqual(values);
		expect(await rows("equity_company")).toEqual(company);
		expect((await rows("equity_sync_state"))[0]).toMatchObject({
			last_succeeded_at: LATER,
			data_updated_at: AT,
		});
	});

	it("moves only a pending filing to its final status, and only once", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const first = synced();
		const pending = first.newFilings.map((row) => ({
			...row,
			factsStatus: "pending" as const,
			factCount: 0,
			accountingStandard: null,
			primaryScope: null,
		}));
		await commit("run_1", synced({ newFilings: pending, facts: [], metricValues: [] }));
		await persistence.jobs.insert(job("run_2"), "k2", "f", 5);
		await commit(
			"run_2",
			synced({
				at: LATER,
				newFilings: [],
				finalizedFilings: [
					{
						filingId: FILING,
						factsStatus: "extracted",
						factCount: 1,
						accountingStandard: "US-GAAP",
						primaryScope: "consolidated",
					},
				],
			}),
		);
		expect((await rows("equity_report_filing"))[0]).toMatchObject({
			facts_status: "extracted",
			fact_count: 1,
			accounting_standard: "US-GAAP",
			primary_scope: "consolidated",
			recorded_at: LATER,
		});
		await persistence.jobs.insert(job("run_3"), "k3", "f", 5);
		await commit(
			"run_3",
			synced({
				at: "2026-10-13T00:00:00.000Z",
				newFilings: [],
				facts: [],
				metricValues: [],
				finalizedFilings: [
					{
						filingId: FILING,
						factsStatus: "unavailable",
						factCount: 0,
						accountingStandard: null,
						primaryScope: null,
					},
				],
			}),
		);
		expect((await rows("equity_report_filing"))[0]).toMatchObject({
			facts_status: "extracted",
			recorded_at: LATER,
		});
	});

	it("records a failure, counts it, and a success clears it", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.equitySync.recordFailure(OWNER, {
			kind: "failed",
			companyId: COMPANY,
			failureCode: "FINANCIAL_SOURCE_FAILED",
			failureUpstreamStatus: 503,
			consecutiveFailures: 1,
			nextDueAt: "2026-10-11T00:30:00.000Z",
			schedule: { heldNextDueAt: AT },
			at: AT,
		});
		let [summary] = await persistence.equitySync.listSummaries(OWNER, { companyId: COMPANY });
		expect(summary?.state).toMatchObject({
			failureCode: "FINANCIAL_SOURCE_FAILED",
			failureUpstreamStatus: 503,
			failureAt: AT,
			consecutiveFailures: 1,
			nextDueAt: "2026-10-11T00:30:00.000Z",
		});
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		await commit("run_1", synced({ at: LATER, state: { ...synced().state, checkedAt: LATER } }));
		[summary] = await persistence.equitySync.listSummaries(OWNER, { companyId: COMPANY });
		expect(summary?.state).toMatchObject({
			failureCode: null,
			failureUpstreamStatus: null,
			failureAt: null,
			consecutiveFailures: 0,
		});
	});

	it("reads the stored facts of (metric, year) keys with their filings", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		await commit("run_1", synced());
		const facts = await persistence.equitySync.factsOfKeys(OWNER, COMPANY, [
			["revenue", 2025],
			["revenue", 2024],
			["gross-profit", 2025],
		]);
		expect(facts).toEqual([
			expect.objectContaining({
				metricCode: "revenue",
				fiscalYear: 2025,
				filedOn: "2025-11-01",
				accountingStandard: "US-GAAP",
			}),
		]);
		const [entry] = await persistence.equitySync.valuesWithFilings(
			OWNER,
			COMPANY,
			["revenue"],
			[2025],
		);
		expect(entry?.filing?.filingId).toBe(FILING);
		expect(entry?.value.valueDecimal).toBe("391035000000");
		expect(await persistence.equitySync.valueYears(OWNER, COMPANY, 5)).toEqual([2025]);
		const revisions = await persistence.equitySync.revisions(OWNER, COMPANY, "revenue", 2025, 10);
		expect(revisions.map((row) => row.fact.valueDecimal)).toEqual(["391035000000"]);
	});

	it("keeps a Sync now pressed while the job ran, and the job's own time otherwise", async () => {
		const persistence = createSqlPersistence(db);
		const held = "2026-10-12T00:00:00.000Z";
		const press = "2026-10-11T00:05:00.000Z";
		await persistence.equitySync.reschedule(OWNER, COMPANY, { nextDueAt: held, edinetPhase: null });
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		// No press: the job's own next time, even a later one.
		const later = "2026-10-12T00:10:00.000Z";
		await commit(
			"run_1",
			synced({ state: { ...synced().state, nextDueAt: later }, schedule: { heldNextDueAt: held } }),
		);
		expect((await rows("equity_sync_state"))[0]).toMatchObject({ next_due_at: later });
		// The next job is held again, the owner presses during it: the press wins.
		await persistence.equitySync.reschedule(OWNER, COMPANY, { nextDueAt: held, edinetPhase: null });
		await persistence.jobs.insert(job("run_2"), "k2", "f", 5);
		expect(await persistence.equitySync.requestSync(OWNER, COMPANY, press)).toBe(true);
		await commit(
			"run_2",
			synced({ state: { ...synced().state, nextDueAt: later }, schedule: { heldNextDueAt: held } }),
		);
		expect((await rows("equity_sync_state"))[0]).toMatchObject({ next_due_at: press });
		// A failure keeps a press too, and an earlier backoff beats a later press.
		await persistence.equitySync.reschedule(OWNER, COMPANY, { nextDueAt: held, edinetPhase: null });
		await persistence.equitySync.requestSync(OWNER, COMPANY, "2026-10-11T02:00:00.000Z");
		await persistence.equitySync.recordFailure(OWNER, {
			kind: "failed",
			companyId: COMPANY,
			failureCode: "FINANCIAL_SOURCE_FAILED",
			failureUpstreamStatus: null,
			consecutiveFailures: 1,
			nextDueAt: "2026-10-11T00:30:00.000Z",
			schedule: { heldNextDueAt: held },
			at: AT,
		});
		expect((await rows("equity_sync_state"))[0]).toMatchObject({
			next_due_at: "2026-10-11T00:30:00.000Z",
		});
	});

	it("keeps both values of a key one filing reports twice, and an exact repeat once", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const [revenue] = synced().facts;
		if (revenue === undefined) throw new Error("fixture");
		await commit(
			"run_1",
			synced({ facts: [revenue, { ...revenue }, { ...revenue, valueDecimal: "1" }] }),
		);
		const stored = await persistence.equitySync.revisions(OWNER, COMPANY, "revenue", 2025, 10);
		expect(stored.map((row) => row.fact.valueDecimal).sort()).toEqual(["1", "391035000000"]);
	});

	it("stores a filing's primary scope only with its facts", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const [extracted] = synced().newFilings;
		if (extracted === undefined) throw new Error("fixture");
		// The table refuses an extracted filing without a primary scope.
		await expect(
			commit("run_1", synced({ newFilings: [{ ...extracted, primaryScope: null }] })),
		).rejects.toThrow();
		await commit("run_1", synced());
		const [filing] = await persistence.equitySync.listFilings(OWNER, COMPANY, 10);
		expect(filing?.primaryScope).toBe("consolidated");
		const [fact] = await persistence.equitySync.factsOfKeys(OWNER, COMPANY, [["revenue", 2025]]);
		expect(fact?.primaryScope).toBe("consolidated");
	});

	it("lists filings newest first within the limit", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const [base] = synced().newFilings;
		if (base === undefined) throw new Error("fixture");
		const filingOf = (accession: string, filedOn: string) => ({
			...base,
			filingId: equityFilingId(COMPANY, "sec", accession),
			sourceDocumentId: accession,
			filedOn,
		});
		await commit(
			"run_1",
			synced({
				newFilings: [
					filingOf("0000320193-23-000001", "2023-11-01"),
					filingOf("0000320193-25-000002", "2025-11-01"),
					filingOf("0000320193-25-000001", "2025-11-01"),
				],
				facts: [],
				metricValues: [],
			}),
		);
		const listed = await persistence.equitySync.listFilings(OWNER, COMPANY, 2);
		expect(listed.map((filing) => filing.sourceDocumentId)).toEqual([
			"0000320193-25-000002",
			"0000320193-25-000001",
		]);
		expect(await persistence.equitySync.listFilings(OWNER, COMPANY, 10)).toHaveLength(3);
	});

	it("lists a year with only an unavailable reason other than not-reported", async () => {
		const persistence = createSqlPersistence(db);
		await persistence.jobs.insert(job("run_1"), "k1", "f", 5);
		const unavailable = (
			fiscalYear: number,
			reason: "not-reported" | "no-mapping-for-standard",
		) => ({
			metricCode: "revenue" as const,
			fiscalYear,
			valueDecimal: null,
			currency: null,
			unavailableReason: reason,
			filingId: null,
			concept: null,
			scope: null,
			periodStart: null,
			periodEnd: null,
			derived: false,
			reportedValueCount: 0,
		});
		await commit(
			"run_1",
			synced({
				facts: [],
				metricValues: [
					unavailable(2025, "no-mapping-for-standard"),
					unavailable(2024, "not-reported"),
				],
			}),
		);
		expect(await persistence.equitySync.valueYears(OWNER, COMPANY, 5)).toEqual([2025]);
	});

	it("untracks once: a repeat writes nothing and an unknown company is not found", async () => {
		const persistence = createSqlPersistence(db);
		expect(await persistence.equitySync.untrack(OWNER, COMPANY)).toBe("untracked");
		expect(await persistence.equitySync.untrack(OWNER, COMPANY)).toBe("already-untracked");
		expect(await persistence.equitySync.untrack(OWNER, "eqc_missing")).toBe("not-found");
	});

	it("seeds the defaults once and leaves an untracked company untracked", async () => {
		const persistence = createSqlPersistence(db);
		const other = "seed-owner";
		const defaults = [
			{ companyId: "eqc_a", market: "US", symbol: "AAPL", provider: "sec", name: "Apple" },
			{ companyId: "eqc_b", market: "JP", symbol: "7974", provider: "edinet", name: null },
		] as const;
		await persistence.equitySync.seedDefaults(other, defaults, AT);
		expect((await persistence.equitySync.probe(other, AT)).seeded).toBe(true);
		await persistence.equitySync.untrack(other, "eqc_a");
		await persistence.equitySync.seedDefaults(
			other,
			[{ ...defaults[0], companyId: "eqc_c" }, defaults[1]],
			LATER,
		);
		const summaries = await persistence.equitySync.listSummaries(other, { companyId: null });
		expect(summaries.map((entry) => entry.company.companyId)).toEqual(["eqc_b"]);
		expect(summaries[0]?.state.nextDueAt).toBe(AT);
		expect(EMPTY_EQUITY_SYNC_STATE.consecutiveFailures).toBe(0);
	});
});

describe("chunkEquityRows", () => {
	it("keeps every chunk within the byte budget and every row once", () => {
		const rows = Array.from({ length: 500 }, (_, index) => [`fact_${index}`, "値", index]);
		const chunks = chunkEquityRows(rows, 2_000);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks)
			expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(2_000);
		const parsed: unknown[] = [];
		for (const chunk of chunks) {
			const rowsOfChunk: unknown = JSON.parse(chunk);
			if (Array.isArray(rowsOfChunk)) parsed.push(...rowsOfChunk);
		}
		expect(parsed).toEqual(rows);
	});
});
