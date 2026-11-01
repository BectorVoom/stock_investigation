import { env } from "cloudflare:test";
import {
	type ClaimedJob,
	completeJobResponseSchema,
	EDINET_INDEX_LIMITS,
	EQUITY_IDENTITY_CONFLICT_CODE,
	EQUITY_SYNC_API_FAILURE_CODES,
	type EquityMetricCell,
	equityCompanyListSchema,
	equityCompanyViewSchema,
	equityFilingsResponseSchema,
	equityMetricSeriesResponseSchema,
	equityRevisionsResponseSchema,
	equityStatementResponseSchema,
} from "@research/contracts";
import { equityConceptsOfProvider } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	accession,
	businessDescription,
	docId,
	expectedFreeCashFlow,
	expectedValue,
	type FilingInput,
	failedCompletion,
	securitiesReport,
	syncedCompletion,
	tenK,
} from "./equitySyncFixtures.ts";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	createWorkspace,
	errorCode,
	type Harness,
	idempotencyKey,
	issueRunnerToken,
	researchRequest,
	trackCompany,
	USAGE,
	untrackCompany,
} from "./helpers.ts";

type SyncLease = Extract<ClaimedJob, { kind: "financial-sync" }>;

const LEASE_MS = 90_000;

async function setup(options: { equityTracksDirectory?: boolean; edinetIndexSync?: boolean } = {}) {
	const harness = createHarness(options);
	const token = await issueRunnerToken(harness);
	return { harness, token };
}

/**
 * The shared EDINET index lists `reports` (ADR-0058 §4), as an
 * `edinet-indexed` completion stores them: each on its filing day.
 */
async function indexReports(harness: Harness, symbol: string, reports: readonly FilingInput[]) {
	for (const report of reports) {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO edinet_index_day (owner_id, listed_on, checked_at, document_count)
			VALUES (?, ?, ?, 1)`,
		)
			.bind(harness.ownerId, report.filedOn, harness.time.clock.nowIso())
			.run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO edinet_document_index (owner_id, doc_id, sec_code, edinet_code,
				filer_name, doc_type_code, period_start, period_end, submitted_at, parent_doc_id, listed_on)
			VALUES (?, ?, ?, 'E02367', '任天堂株式会社', ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				harness.ownerId,
				report.sourceDocumentId,
				`${symbol}0`,
				report.form === "securities-report" ? "120" : "130",
				report.form === "securities-report" ? report.periodStart : null,
				report.form === "securities-report" ? report.periodEnd : null,
				report.submittedAt,
				report.amendsSourceDocumentId,
				report.filedOn,
			)
			.run();
	}
}

/**
 * Tracks a listing the way the directory reconcile does (ADR-0058 §3), via
 * the repository: these tests are about the sync, not about which stocks
 * the directory holds (the reconcile has its own tests below). A Japanese
 * listing is first given its six annual reports in the EDINET index, so it
 * is due (a JP company without an indexed report waits for the index).
 */
async function track(harness: Harness, stockId: string) {
	const [prefix, symbol = ""] = stockId.split(":");
	const market = prefix === "jp" ? "JP" : "US";
	if (market === "JP") {
		await indexReports(
			harness,
			symbol,
			JP_YEARS.map((year) => securitiesReport(year)),
		);
	}
	await trackCompany(harness, stockId);
	const list = await body(
		await harness.call("GET", "/equities/companies"),
		equityCompanyListSchema,
	);
	const view = list.companies.find((entry) => entry.market === market && entry.symbol === symbol);
	if (view === undefined) throw new Error(`${stockId} was not tracked`);
	return view;
}

/**
 * Stores (or replaces) a market's stock list as a directory download does,
 * with a new `retrieved_at`: the reconcile runs again after a list changes.
 */
async function storeDirectory(harness: Harness, market: "US" | "JP", symbols: readonly string[]) {
	await env.DB.prepare("DELETE FROM stock_directory WHERE owner_id = ? AND market = ?")
		.bind(harness.ownerId, market)
		.run();
	for (const symbol of symbols) {
		await env.DB.prepare(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
				symbol_key, name_key, local_name_key, search_key)
			VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '', ?)`,
		)
			.bind(
				harness.ownerId,
				market,
				symbol,
				`${symbol} Inc.`,
				market === "US" ? "nasdaq" : "tse-prime",
				symbol.toLowerCase(),
				symbol.toLowerCase(),
				symbol.toLowerCase(),
			)
			.run();
	}
	await env.DB.prepare(
		`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at,
			fold_version)
		VALUES (?, ?, ?, NULL, ?, 1)
		ON CONFLICT (owner_id, market) DO UPDATE SET
			entry_count = excluded.entry_count, retrieved_at = excluded.retrieved_at`,
	)
		.bind(harness.ownerId, market, symbols.length, harness.time.clock.nowIso())
		.run();
}

/** The company becomes due now, as its next regular check would (no re-track recorded). */
async function makeDue(harness: Harness, companyId: string) {
	const result = await env.DB.prepare(
		"UPDATE equity_sync_state SET next_due_at = ? WHERE owner_id = ? AND company_id = ?",
	)
		.bind(harness.time.clock.nowIso(), harness.ownerId, companyId)
		.run();
	expect(result.meta.changes).toBe(1);
}

/** The company's listing leaves the directory and comes back now: due at once (ADR-0058 §3). */
async function retrack(harness: Harness, companyId: string) {
	const view = await company(harness, companyId);
	await untrackCompany(harness, companyId);
	expect(await trackCompany(harness, `${view.market.toLowerCase()}:${view.symbol}`)).toBe(
		companyId,
	);
}

/** Claims the next job, which must be a financial sync, walked to `publishing`. */
async function claimSync(harness: Harness, token: string): Promise<SyncLease> {
	const job = await claim(harness, token);
	if (job?.kind !== "financial-sync")
		throw new Error(`expected a financial sync, got ${job?.kind}`);
	await advanceToPublishing(harness, token, job);
	return job;
}

async function complete(harness: Harness, token: string, lease: SyncLease, payload: unknown) {
	return harness.runner(token, `/jobs/${lease.runId}/complete`, payload);
}

/** One whole sync: claim, complete, expect the job completed. */
async function sync(
	harness: Harness,
	token: string,
	filings: readonly FilingInput[],
	options: Parameters<typeof syncedCompletion>[3] = {},
): Promise<SyncLease> {
	const lease = await claimSync(harness, token);
	const response = await complete(
		harness,
		token,
		lease,
		syncedCompletion(lease, lease.source.provider, filings, options),
	);
	expect(response.status).toBe(200);
	expect((await body(response, completeJobResponseSchema)).state).toBe("completed");
	return lease;
}

async function statement(harness: Harness, companyId: string, kind: string, years = 5) {
	const response = await harness.call(
		"GET",
		`/equities/companies/${companyId}/statements/${kind}?years=${years}`,
	);
	expect(response.status).toBe(200);
	return body(response, equityStatementResponseSchema);
}

async function company(harness: Harness, companyId: string) {
	const response = await harness.call("GET", `/equities/companies/${companyId}`);
	expect(response.status).toBe(200);
	return body(response, equityCompanyViewSchema);
}

/** Everything the sync stores for an owner, to prove what a sync wrote (or did not). */
async function snapshot(ownerId: string) {
	const rows = async (sql: string) =>
		(await env.DB.prepare(sql).bind(ownerId).all()).results as Record<string, unknown>[];
	return {
		companies: await rows("SELECT * FROM equity_company WHERE owner_id = ? ORDER BY company_id"),
		filings: await rows("SELECT * FROM equity_report_filing WHERE owner_id = ? ORDER BY filing_id"),
		facts: await rows(
			`SELECT * FROM equity_reported_fact WHERE owner_id = ?
			ORDER BY filing_id, concept, scope, period_type, period_start, period_end, unit`,
		),
		values: await rows(
			`SELECT * FROM equity_metric_value WHERE owner_id = ?
			ORDER BY company_id, metric_code, fiscal_year`,
		),
		state: await rows("SELECT * FROM equity_sync_state WHERE owner_id = ? ORDER BY company_id"),
		descriptions: await rows(
			"SELECT * FROM equity_business_description WHERE owner_id = ? ORDER BY company_id",
		),
	};
}

function cellOf(
	response: { rows: { metric: string; cells: EquityMetricCell[] }[] },
	metric: string,
	fiscalYear: number,
) {
	const cell = response.rows
		.find((row) => row.metric === metric)
		?.cells.find((entry) => entry.fiscalYear === fiscalYear);
	if (cell === undefined) throw new Error(`no cell ${metric} ${fiscalYear}`);
	return cell;
}

const US_YEARS = [2025, 2024, 2023, 2022, 2021, 2020];
const JP_YEARS = [2026, 2025, 2024, 2023, 2022, 2021];

describe("financial sync: claim payloads (ADR-0048 §6)", () => {
	it("claims a US company with its SEC request and the concept list", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		expect(tracked.sync.status).toBe("never");
		const lease = await claimSync(harness, token);
		expect(lease.companyId).toBe(tracked.companyId);
		expect(lease.market).toBe("US");
		expect(lease.symbol).toBe("AAPL");
		expect(lease.concepts).toEqual([...equityConceptsOfProvider("sec")]);
		expect(lease.source).toEqual({
			provider: "sec",
			cik: null,
			knownAccessions: [],
			pendingFilings: [],
			filedSince: "2020-10-11",
			fullCheck: true,
			describedDocumentId: null,
		});
		expect((await company(harness, tracked.companyId)).sync.status).toBe("running");
	});

	it("claims a Japanese company with the reports the EDINET index names, oldest first", async () => {
		const { harness, token } = await setup();
		await track(harness, "jp:7974");
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(lease.source.secCode).toBe("79740");
		// Not resolved yet: the filer code the index states.
		expect(lease.source.edinetCode).toBe("E02367");
		expect("scanDays" in lease.source).toBe(false);
		const oldest = securitiesReport(2021);
		expect(lease.source.indexedFilings).toHaveLength(6);
		expect(lease.source.indexedFilings[0]).toEqual({
			sourceDocumentId: oldest.sourceDocumentId,
			form: "securities-report",
			filedOn: oldest.filedOn,
			submittedAt: oldest.submittedAt,
			periodStart: oldest.periodStart,
			periodEnd: oldest.periodEnd,
			amendsSourceDocumentId: null,
			sourceUrl: oldest.sourceUrl,
		});
		expect(lease.source.indexedFilings.map((filing) => filing.periodEnd)).toEqual(
			[...lease.source.indexedFilings.map((filing) => filing.periodEnd)].sort(),
		);
	});

	it("queues one job at a time and never one while a sync is pending or leased", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		await track(harness, "us:MSFT");
		await claimSync(harness, token);
		expect(await claim(harness, token)).toBeNull();
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'financial-sync'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(jobs?.n).toBe(1);
	});
});

describe("financial sync: backfill and reads (ADR-0048 §5, §7)", () => {
	it("backfills six US fiscal years and answers the statements from the stored values", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(
			harness,
			token,
			US_YEARS.map((year) => tenK(year)),
		);
		const view = await company(harness, tracked.companyId);
		expect(view).toMatchObject({
			sourceCompanyId: "0000320193",
			name: "Apple Inc.",
			fiscalYearEnd: "09-30",
			latestFiscalYear: 2025,
			filingCount: 6,
		});
		expect(view.sync.status).toBe("succeeded");

		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(income.fiscalYears).toEqual([2021, 2022, 2023, 2024, 2025]);
		expect(income.rows.map((row) => row.metric)).toEqual([
			"revenue",
			"gross-profit",
			"operating-income",
			"ordinary-income",
			"profit-attributable-to-owners",
		]);
		for (const year of income.fiscalYears) {
			expect(cellOf(income, "revenue", year)).toMatchObject({
				valueDecimal: expectedValue("revenue", year),
				currency: "USD",
				scope: "consolidated",
				concept: "us-gaap:Revenues",
				reportedValueCount: 1,
				derived: false,
			});
			// Not a US-GAAP concept: missing, with its reason — never zero.
			expect(cellOf(income, "ordinary-income", year)).toMatchObject({
				valueDecimal: null,
				unavailableReason: "not-reported",
			});
		}
		// A year's current value cites the latest filing reporting it (the
		// 2025 10-K's comparative for 2023).
		expect(cellOf(income, "revenue", 2023).filingId).toBe(
			`${tracked.companyId}:sec:${accession(2025)}`,
		);
		expect(income.filings.map((filing) => filing.sourceDocumentId)).toEqual([
			accession(2025),
			accession(2024),
			accession(2023),
		]);

		const cash = await statement(harness, tracked.companyId, "cash-flow", 10);
		expect(cash.fiscalYears).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
		for (const year of cash.fiscalYears) {
			expect(cellOf(cash, "free-cash-flow", year)).toMatchObject({
				valueDecimal: expectedFreeCashFlow(year),
				derived: true,
				concept: "derived:free-cash-flow",
			});
			expect(cellOf(cash, "capital-expenditures", year).valueDecimal).toBe(
				expectedValue("capital-expenditures", year),
			);
		}
		const balance = await statement(harness, tracked.companyId, "balance-sheet", 10);
		// Instants only at year ends of annual durations in the same filing: 2019 onwards.
		expect(cellOf(balance, "total-assets", 2018).unavailableReason).toBe("not-reported");
		expect(cellOf(balance, "total-assets", 2019).valueDecimal).toBe(
			expectedValue("total-assets", 2019),
		);

		const series = await harness.call(
			"GET",
			`/equities/companies/${tracked.companyId}/metrics?metric=net-cash-from-investing-activities&years=3`,
		);
		expect(series.status).toBe(200);
		const parsed = await body(series, equityMetricSeriesResponseSchema);
		expect(parsed.cells.map((cell) => cell.valueDecimal)).toEqual([
			expectedValue("net-cash-from-investing-activities", 2023),
			expectedValue("net-cash-from-investing-activities", 2024),
			expectedValue("net-cash-from-investing-activities", 2025),
		]);
	});

	it("backfills six Japanese fiscal years with the same response shapes as a US company", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		const lease = await sync(
			harness,
			token,
			JP_YEARS.map((year) => securitiesReport(year)),
		);
		expect(lease.source.provider).toBe("edinet");
		const income = await statement(harness, nintendo.companyId, "income-statement");
		expect(income.fiscalYears).toEqual([2022, 2023, 2024, 2025, 2026]);
		for (const year of income.fiscalYears) {
			// The separate statement's "1" never displaces the consolidated value.
			expect(cellOf(income, "revenue", year)).toMatchObject({
				valueDecimal: expectedValue("revenue", year),
				currency: "JPY",
				scope: "consolidated",
				concept: "jppfs_cor:NetSales",
			});
			expect(cellOf(income, "ordinary-income", year).valueDecimal).toBe(
				expectedValue("ordinary-income", year),
			);
		}
		const cash = await statement(harness, nintendo.companyId, "cash-flow");
		// EDINET reports the payment negative; the metric is a positive amount.
		expect(cellOf(cash, "capital-expenditures", 2026).valueDecimal).toBe(
			expectedValue("capital-expenditures", 2026),
		);
		expect(cellOf(cash, "free-cash-flow", 2026).valueDecimal).toBe(expectedFreeCashFlow(2026));
		expect((await company(harness, nintendo.companyId)).sourceCompanyId).toBe("E02367");

		// Same schema and shape for both markets.
		const { harness: us, token: usToken } = await setup();
		const apple = await track(us, "us:AAPL");
		await sync(
			us,
			usToken,
			US_YEARS.map((year) => tenK(year)),
		);
		const usIncome = await statement(us, apple.companyId, "income-statement");
		expect(usIncome.rows.map((row) => row.metric)).toEqual(income.rows.map((row) => row.metric));
		expect(usIncome.rows.map((row) => row.cells.length)).toEqual(
			income.rows.map((row) => row.cells.length),
		);
		expect(Object.keys(usIncome).sort()).toEqual(Object.keys(income).sort());
	});

	it("keeps a reported zero apart from a missing value", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const filing = tenK(2025, { override: { "gross-profit": "0" } });
		filing.facts = filing.facts.filter(
			(fact) =>
				!(fact.concept === "us-gaap:OperatingIncomeLoss" && fact.periodEnd === "2025-09-30"),
		);
		await sync(harness, token, [filing]);
		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(cellOf(income, "gross-profit", 2025)).toMatchObject({
			valueDecimal: "0",
			unavailableReason: null,
		});
		expect(cellOf(income, "operating-income", 2025)).toMatchObject({
			valueDecimal: null,
			unavailableReason: "not-reported",
			filingId: null,
		});
	});

	it("answers conditional reads with 304 until the stored values or the sync status change", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025)]);
		const path = `/equities/companies/${tracked.companyId}/statements/income-statement?years=5`;
		const first = await harness.call("GET", path);
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const again = await harness.call("GET", path, undefined, { "If-None-Match": etag ?? "" });
		expect(again.status).toBe(304);
		// A new due time moves the company's schedule, which the body shows.
		await makeDue(harness, tracked.companyId);
		const changed = await harness.call("GET", path, undefined, { "If-None-Match": etag ?? "" });
		expect(changed.status).toBe(200);
	});
});

describe("financial sync: incremental writes (ADR-0048 §6)", () => {
	it("writes nothing but the sync state when a second sync brings nothing new", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const filings = US_YEARS.map((year) => tenK(year));
		await sync(harness, token, filings);
		const before = await snapshot(harness.ownerId);
		expect(before.facts.length).toBeGreaterThan(100);

		// The same completion again (a runner that resends known filings) and
		// an empty one (what a runner sends when nothing is new).
		for (const resend of [filings, []]) {
			harness.time.advance(25 * 60 * 60 * 1000);
			await makeDue(harness, tracked.companyId);
			await sync(harness, token, resend);
			const after = await snapshot(harness.ownerId);
			expect(after.companies).toEqual(before.companies);
			expect(after.filings).toEqual(before.filings);
			expect(after.facts).toEqual(before.facts);
			expect(after.values).toEqual(before.values);
			const state = after.state[0];
			expect(state?.data_updated_at).toBe(before.state[0]?.data_updated_at);
			expect(state?.last_succeeded_at).toBe(harness.time.clock.nowIso());
		}
	});

	it("adds a new fiscal year and rewrites only the keys its facts touch", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(
			harness,
			token,
			US_YEARS.map((year) => tenK(year)),
		);
		const before = await snapshot(harness.ownerId);
		harness.time.advance(60 * 60 * 1000);
		await makeDue(harness, tracked.companyId);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "sec") throw new Error("expected SEC");
		expect(lease.source.cik).toBe("0000320193");
		expect(lease.source.fullCheck).toBe(false);
		expect([...lease.source.knownAccessions].sort()).toEqual(
			US_YEARS.map((year) => accession(year)).sort(),
		);
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [tenK(2026)]),
		);
		expect(response.status).toBe(200);
		const after = await snapshot(harness.ownerId);
		const at = harness.time.clock.nowIso();
		for (const row of after.values) {
			const year = Number(row.fiscal_year);
			const old = before.values.find(
				(entry) => entry.metric_code === row.metric_code && entry.fiscal_year === row.fiscal_year,
			);
			if (year <= 2023) {
				// Untouched: not even rewritten.
				expect(row).toEqual(old);
			} else if (year === 2026) {
				expect(old).toBeUndefined();
				expect(row.updated_at).toBe(at);
			}
		}
		expect(after.state[0]?.data_updated_at).toBe(at);
		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(income.fiscalYears).toEqual([2022, 2023, 2024, 2025, 2026]);
		expect(cellOf(income, "revenue", 2026).valueDecimal).toBe(expectedValue("revenue", 2026));
		expect(cellOf(income, "revenue", 2025).filingId).toBe(
			`${tracked.companyId}:sec:${accession(2026)}`,
		);
	});

	it("leaves a touched value unwritten when an older filing reports the same figures", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025)]);
		const before = await snapshot(harness.ownerId);
		harness.time.advance(60 * 60 * 1000);
		await makeDue(harness, tracked.companyId);
		// The 2024 10-K reports 2024 and 2023 again (same values, older filing)
		// and 2022 for the first time.
		await sync(harness, token, [tenK(2024)]);
		const after = await snapshot(harness.ownerId);
		for (const row of before.values) {
			const same = after.values.find(
				(entry) => entry.metric_code === row.metric_code && entry.fiscal_year === row.fiscal_year,
			);
			expect(same).toEqual(row);
		}
		const added = after.values.filter(
			(row) =>
				!before.values.some(
					(entry) => entry.metric_code === row.metric_code && entry.fiscal_year === row.fiscal_year,
				),
		);
		expect(added.length).toBeGreaterThan(0);
		// New: the 2022 durations and the 2023 year-end balances (the 2025
		// 10-K's balance sheet starts at 2024).
		const balance = new Set([
			"total-assets",
			"total-liabilities",
			"total-equity",
			"cash-and-cash-equivalents",
		]);
		for (const row of added) {
			expect(
				row.fiscal_year === 2022 ||
					(row.fiscal_year === 2023 && balance.has(String(row.metric_code))),
			).toBe(true);
		}
		expect(after.facts.length).toBeGreaterThan(before.facts.length);
		expect(after.state[0]?.data_updated_at).toBe(harness.time.clock.nowIso());
	});

	it("keeps the data time when new facts change no current value", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025), tenK(2024)]);
		const before = await snapshot(harness.ownerId);
		harness.time.advance(60 * 60 * 1000);
		await makeDue(harness, tracked.companyId);
		// An amendment of the 2024 year filed before the 2025 10-K, with the
		// same figures: its facts are stored, but the 2025 10-K stays the
		// latest filing for every key they touch.
		const amendment = tenK(2024, { form: "10-K/A", seq: 2, filedOn: "2025-01-15" });
		amendment.facts = amendment.facts.filter((fact) => fact.periodEnd === "2024-09-30");
		await sync(harness, token, [amendment]);
		const after = await snapshot(harness.ownerId);
		expect(after.facts.length).toBe(before.facts.length + amendment.facts.length);
		expect(after.values).toEqual(before.values);
		expect(after.state[0]?.data_updated_at).toBe(before.state[0]?.data_updated_at);
	});

	it("moves the current value to a restatement and keeps the as-filed history", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2024), tenK(2023)]);
		await makeDue(harness, tracked.companyId);
		// The 10-K/A restates 2024 revenue.
		const restated = tenK(2024, {
			form: "10-K/A",
			seq: 2,
			filedOn: "2025-02-01",
			override: { revenue: "99999000" },
		});
		await sync(harness, token, [restated]);
		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(cellOf(income, "revenue", 2024)).toMatchObject({
			valueDecimal: "99999000",
			filingId: `${tracked.companyId}:sec:${accession(2024, 2)}`,
			reportedValueCount: 2,
		});
		const revisions = await harness.call(
			"GET",
			`/equities/companies/${tracked.companyId}/revisions?metric=revenue&fiscalYear=2024`,
		);
		expect(revisions.status).toBe(200);
		const parsed = await body(revisions, equityRevisionsResponseSchema);
		expect(parsed.current.valueDecimal).toBe("99999000");
		expect(parsed.reported.map((entry) => [entry.filingId, entry.valueDecimal])).toEqual([
			[`${tracked.companyId}:sec:${accession(2024, 2)}`, "99999000"],
			[`${tracked.companyId}:sec:${accession(2024)}`, expectedValue("revenue", 2024)],
		]);
		expect(parsed.filings.map((filing) => [filing.form, filing.isAmendment])).toEqual([
			["10-K/A", true],
			["10-K", false],
		]);
	});

	it("applies an EDINET amendment (訂正) over the original report", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		await sync(harness, token, [securitiesReport(2026), securitiesReport(2025)]);
		await makeDue(harness, nintendo.companyId);
		const amendment = securitiesReport(2026, {
			amendment: { seq: 1, filedOn: "2026-08-03" },
			override: { "operating-income": "123456789" },
		});
		await sync(harness, token, [amendment]);
		const income = await statement(harness, nintendo.companyId, "income-statement");
		expect(cellOf(income, "operating-income", 2026)).toMatchObject({
			valueDecimal: "123456789",
			reportedValueCount: 2,
		});
		// Unchanged figures move to the amendment as the latest filing, same value.
		expect(cellOf(income, "revenue", 2026)).toMatchObject({
			valueDecimal: expectedValue("revenue", 2026),
			reportedValueCount: 1,
		});
		const facts = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM equity_reported_fact
			WHERE owner_id = ? AND metric_code = 'operating-income' AND fiscal_year = 2026`,
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(facts?.n).toBe(2);
		const filing = await env.DB.prepare(
			"SELECT amends_source_document_id, form FROM equity_report_filing WHERE owner_id = ? AND source_document_id = ?",
		)
			.bind(harness.ownerId, docId(2026, 1))
			.first();
		expect(filing).toEqual({
			amends_source_document_id: docId(2026, 0),
			form: "amended-securities-report",
		});
	});

	it("stores a fact once and answers ambiguous for a key one filing reports with two values", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const filing = tenK(2025);
		const revenue = filing.facts.find(
			(fact) => fact.concept === "us-gaap:Revenues" && fact.periodEnd === "2025-09-30",
		);
		const assets = filing.facts.find(
			(fact) => fact.concept === "us-gaap:Assets" && fact.periodEnd === "2025-09-30",
		);
		if (revenue === undefined || assets === undefined) throw new Error("fixture");
		filing.facts.push({ ...revenue }, { ...assets, valueDecimal: "1" });
		await sync(harness, token, [filing]);
		const rows = await env.DB.prepare(
			`SELECT concept, value_decimal FROM equity_reported_fact
			WHERE owner_id = ? AND period_end = '2025-09-30' AND concept IN ('us-gaap:Revenues', 'us-gaap:Assets')
			ORDER BY concept, value_decimal`,
		)
			.bind(harness.ownerId)
			.all();
		// The exact repeat collapses; both reported assets are kept as filed.
		expect(rows.results).toEqual([
			{ concept: "us-gaap:Assets", value_decimal: "1" },
			{ concept: "us-gaap:Assets", value_decimal: expectedValue("total-assets", 2025) },
			{ concept: "us-gaap:Revenues", value_decimal: expectedValue("revenue", 2025) },
		]);
		const balance = await statement(harness, tracked.companyId, "balance-sheet");
		expect(cellOf(balance, "total-assets", 2025)).toMatchObject({
			valueDecimal: null,
			unavailableReason: "ambiguous",
		});
	});

	it("never lets an older filing or a lower-ranked concept stand in for a conflicting amendment", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025, { override: { revenue: "100" } })]);
		await makeDue(harness, tracked.companyId);
		// The 10-K/A reports Revenues twice (110 and 120) and a lower-ranked revenue concept.
		const amendment = tenK(2025, { form: "10-K/A", seq: 2, filedOn: "2026-02-01" });
		const revenue = amendment.facts.find(
			(fact) => fact.concept === "us-gaap:Revenues" && fact.periodEnd === "2025-09-30",
		);
		if (revenue === undefined) throw new Error("fixture");
		revenue.valueDecimal = "110";
		amendment.facts.push(
			{ ...revenue, valueDecimal: "120" },
			{
				...revenue,
				concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
				valueDecimal: "999",
			},
		);
		await sync(harness, token, [amendment]);
		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(cellOf(income, "revenue", 2025)).toMatchObject({
			valueDecimal: null,
			unavailableReason: "ambiguous",
			filingId: null,
		});
		const revisions = await body(
			await harness.call(
				"GET",
				`/equities/companies/${tracked.companyId}/revisions?metric=revenue&fiscalYear=2025`,
			),
			equityRevisionsResponseSchema,
		);
		expect(revisions.current.unavailableReason).toBe("ambiguous");
		expect(
			revisions.reported
				.filter((entry) => entry.concept === "us-gaap:Revenues")
				.map((entry) => [entry.filingId, entry.valueDecimal])
				.sort(),
		).toEqual([
			[`${tracked.companyId}:sec:${accession(2025)}`, "100"],
			[`${tracked.companyId}:sec:${accession(2025, 2)}`, "110"],
			[`${tracked.companyId}:sec:${accession(2025, 2)}`, "120"],
		]);
	});

	it("shows a consolidated filer's year from consolidated statements only", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		const report = securitiesReport(2026);
		// Consolidated statements without GrossProfit; only the parent's (separate) one.
		report.facts = report.facts.filter((fact) => fact.concept !== "jppfs_cor:GrossProfit");
		report.facts.push({
			concept: "jppfs_cor:GrossProfit",
			unit: "JPY",
			valueDecimal: "777",
			periodType: "duration",
			periodStart: "2025-04-01",
			periodEnd: "2026-03-31",
			scope: "separate",
		});
		await sync(harness, token, [report]);
		const income = await statement(harness, nintendo.companyId, "income-statement");
		expect(cellOf(income, "revenue", 2026)).toMatchObject({
			valueDecimal: expectedValue("revenue", 2026),
			scope: "consolidated",
		});
		expect(cellOf(income, "gross-profit", 2026)).toMatchObject({
			valueDecimal: null,
			unavailableReason: "not-reported",
		});
		// The parent-only figure stays in the as-filed history with its scope.
		const revisions = await body(
			await harness.call(
				"GET",
				`/equities/companies/${nintendo.companyId}/revisions?metric=gross-profit&fiscalYear=2026`,
			),
			equityRevisionsResponseSchema,
		);
		expect(revisions.reported.map((entry) => [entry.scope, entry.valueDecimal])).toEqual([
			["separate", "777"],
		]);
		const filing = await env.DB.prepare(
			"SELECT primary_scope FROM equity_report_filing WHERE owner_id = ? AND source_document_id = ?",
		)
			.bind(harness.ownerId, docId(2026))
			.first();
		expect(filing).toEqual({ primary_scope: "consolidated" });
	});

	it("shows a filer without subsidiaries from its separate statements", async () => {
		const { harness, token } = await setup();
		const filer = await track(harness, "jp:7974");
		const report = securitiesReport(2026);
		report.facts = report.facts
			.filter((fact) => fact.scope === "consolidated")
			.map((fact) => ({ ...fact, scope: "separate" as const }));
		await sync(harness, token, [report]);
		const income = await statement(harness, filer.companyId, "income-statement");
		expect(cellOf(income, "operating-income", 2026)).toMatchObject({
			valueDecimal: expectedValue("operating-income", 2026),
			scope: "separate",
		});
	});

	it("lists the years of a filer whose standard has no mappings, with the reason", async () => {
		for (const standard of ["IFRS", "US-GAAP"] as const) {
			const { harness, token } = await setup();
			const filer = await track(harness, "jp:7974");
			await sync(harness, token, [
				securitiesReport(2026, { standard }),
				securitiesReport(2025, { standard }),
			]);
			const income = await statement(harness, filer.companyId, "income-statement");
			// Not "never synced": the years are there, every cell says why it is empty.
			expect(income.fiscalYears).toEqual([2025, 2026]);
			for (const year of income.fiscalYears) {
				expect(cellOf(income, "revenue", year)).toMatchObject({
					valueDecimal: null,
					unavailableReason: "no-mapping-for-standard",
				});
			}
			const series = await body(
				await harness.call("GET", `/equities/companies/${filer.companyId}/metrics?metric=revenue`),
				equityMetricSeriesResponseSchema,
			);
			expect(series.cells.map((cell) => cell.fiscalYear)).toEqual([2025, 2026]);
		}
	});

	it("rejects a completion that lists one filing twice", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [tenK(2025), tenK(2025)]),
		);
		expect(response.status).toBe(400);
		expect((await snapshot(harness.ownerId)).filings).toEqual([]);
	});

	it("writes nothing from a completion whose lease was superseded", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		const stale = await claimSync(harness, token);
		harness.time.advance(LEASE_MS + 1_000);
		const current = await claimSync(harness, token);
		expect(current.runId).toBe(stale.runId);
		expect(current.leaseGeneration).toBeGreaterThan(stale.leaseGeneration);
		const before = await snapshot(harness.ownerId);
		const rejected = await complete(
			harness,
			token,
			stale,
			syncedCompletion(stale, "sec", [tenK(2025)], {
				description: businessDescription(tenK(2025)),
			}),
		);
		expect(rejected.status).toBe(409);
		expect(await errorCode(rejected)).toBe("STALE_LEASE");
		expect(await snapshot(harness.ownerId)).toEqual(before);
		const accepted = await complete(
			harness,
			token,
			current,
			syncedCompletion(current, "sec", [tenK(2025)]),
		);
		expect(accepted.status).toBe(200);
		expect((await snapshot(harness.ownerId)).filings).toHaveLength(1);
	});

	it("rejects a result for another company or from the wrong kind of job", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		const other = await complete(
			harness,
			token,
			lease,
			syncedCompletion({ ...lease, companyId: "eqc_other" }, "sec", [tenK(2025)]),
		);
		expect(other.status).toBe(400);
		const wrongProvider = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "edinet", [securitiesReport(2026)]),
		);
		expect(wrongProvider.status).toBe(400);
		const wrongOutcome = await complete(harness, token, lease, {
			outcome: "stock-directory-refreshed",
			leaseGeneration: lease.leaseGeneration,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
			market: "US",
			asOf: null,
			fetchedAt: "2026-10-11T00:00:00.000Z",
			entries: [],
		});
		expect(wrongOutcome.status).toBe(400);
		expect((await snapshot(harness.ownerId)).filings).toEqual([]);

		// A research job cannot complete as a financial sync.
		const { harness: research, token: researchToken } = await setup();
		const workspaceId = await createWorkspace(research);
		const queued = await research.call(
			"POST",
			"/research-runs",
			researchRequest(workspaceId),
			idempotencyKey(),
		);
		expect(queued.status).toBe(202);
		const job = await claim(research, researchToken);
		if (job === null) throw new Error("expected a research job");
		await advanceToPublishing(research, researchToken, job);
		const refused = await research.runner(
			researchToken,
			`/jobs/${job.runId}/complete`,
			syncedCompletion({ leaseGeneration: job.leaseGeneration, companyId: "eqc_x" }, "sec", []),
		);
		expect(refused.status).toBe(400);
	});

	it("refuses an issuer another tracked company already resolved to", async () => {
		const { harness, token } = await setup();
		const google = await track(harness, "us:GOOGL");
		const identity = {
			sourceCompanyId: "0001652044",
			name: "Alphabet Inc.",
			fiscalYearEnd: "12-31",
		};
		await sync(harness, token, [tenK(2025)], { identity });
		const second = await track(harness, "us:GOOG");
		const lease = await claimSync(harness, token);
		expect(lease.companyId).toBe(second.companyId);
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [tenK(2025)], {
				identity,
				description: businessDescription(tenK(2025)),
			}),
		);
		expect(response.status).toBe(200);
		expect((await body(response, completeJobResponseSchema)).state).toBe("failed");
		// Nothing of the other issuer is stored, its business description included.
		expect((await snapshot(harness.ownerId)).descriptions).toEqual([]);
		const view = await company(harness, second.companyId);
		expect(view.sync.status).toBe("failed");
		// A documented API-side code (contracts), resolved by untracking one listing.
		expect(EQUITY_IDENTITY_CONFLICT_CODE).toBe("FINANCIAL_IDENTITY_CONFLICT");
		expect(EQUITY_SYNC_API_FAILURE_CODES).toContain(EQUITY_IDENTITY_CONFLICT_CODE);
		expect(view.sync.failure?.code).toBe(EQUITY_IDENTITY_CONFLICT_CODE);
		expect(view.sourceCompanyId).toBeNull();
		expect(view.filingCount).toBe(0);
		expect((await company(harness, google.companyId)).filingCount).toBe(1);
	});
});

describe("financial sync: checkpoints (ADR-0048 §6)", () => {
	it("downloads only reports the index names: a stored one is never named again", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		await sync(harness, token, [securitiesReport(2026), securitiesReport(2025)]);
		await makeDue(harness, nintendo.companyId);
		const next = await claimSync(harness, token);
		if (next.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(next.source.indexedFilings.map((filing) => filing.sourceDocumentId)).toEqual(
			[2021, 2022, 2023, 2024].map((year) => docId(year)),
		);
	});

	it("offers a filing whose facts are not available yet again, then records them", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		// Filed yesterday: company facts lag the filing, so it stays pending.
		const lagging = tenK(2026, { filedOn: "2026-10-10", factsStatus: "not-available" });
		await sync(harness, token, [lagging, tenK(2025)]);
		const pending = await env.DB.prepare(
			"SELECT facts_status FROM equity_report_filing WHERE owner_id = ? AND source_document_id = ?",
		)
			.bind(harness.ownerId, accession(2026))
			.first();
		expect(pending).toEqual({ facts_status: "pending" });
		await makeDue(harness, tracked.companyId);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "sec") throw new Error("expected SEC");
		expect(lease.source.knownAccessions).toEqual([accession(2025)]);
		expect(lease.source.pendingFilings.map((filing) => filing.sourceDocumentId)).toEqual([
			accession(2026),
		]);
		expect(lease.source.pendingFilings[0]?.filedOn).toBe("2026-10-10");
		const extracted = { ...tenK(2026, { filedOn: "2026-10-10" }) };
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [extracted]),
		);
		expect(response.status).toBe(200);
		const after = await env.DB.prepare(
			"SELECT facts_status, fact_count FROM equity_report_filing WHERE owner_id = ? AND source_document_id = ?",
		)
			.bind(harness.ownerId, accession(2026))
			.first<{ facts_status: string; fact_count: number }>();
		expect(after?.facts_status).toBe("extracted");
		expect(after?.fact_count).toBeGreaterThan(0);
		const income = await statement(harness, tracked.companyId, "income-statement");
		expect(cellOf(income, "revenue", 2026).valueDecimal).toBe(expectedValue("revenue", 2026));
	});

	it("records an old filing without facts as unavailable and never offers it again", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2024, { factsStatus: "not-available" })]);
		await makeDue(harness, tracked.companyId);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "sec") throw new Error("expected SEC");
		expect(lease.source.pendingFilings).toEqual([]);
		expect(lease.source.knownAccessions).toEqual([accession(2024)]);
	});

	it("retries an old EDINET report that could not be read for 7 days after it was first seen", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		// Found by a backfill long after filing; its download was unreadable.
		await sync(harness, token, [securitiesReport(2023, { factsStatus: "not-available" })]);
		const status = async () =>
			(
				await env.DB.prepare(
					"SELECT facts_status FROM equity_report_filing WHERE owner_id = ? AND source_document_id = ?",
				)
					.bind(harness.ownerId, docId(2023))
					.first<{ facts_status: string }>()
			)?.facts_status;
		expect(await status()).toBe("pending");
		// Six days later it is still offered and still unreadable: pending.
		harness.time.advance(6 * 24 * 60 * 60 * 1000);
		await makeDue(harness, nintendo.companyId);
		let lease = await claimSync(harness, token);
		if (lease.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(lease.source.pendingFilings.map((filing) => filing.sourceDocumentId)).toEqual([
			docId(2023),
		]);
		await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "edinet", [securitiesReport(2023, { factsStatus: "not-available" })]),
		);
		expect(await status()).toBe("pending");
		// Seven days after it was first seen it is final.
		harness.time.advance(24 * 60 * 60 * 1000);
		await makeDue(harness, nintendo.companyId);
		lease = await claimSync(harness, token);
		await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "edinet", [securitiesReport(2023, { factsStatus: "not-available" })]),
		);
		expect(await status()).toBe("unavailable");
	});

	it("runs again at once with a full SEC check after a completion that said more", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025)], { more: true });
		expect((await company(harness, tracked.companyId)).sync.nextDueAt).toBe(
			harness.time.clock.nowIso(),
		);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "sec") throw new Error("expected SEC");
		expect(lease.source.fullCheck).toBe(true);
		await complete(harness, token, lease, syncedCompletion(lease, "sec", [tenK(2024)]));
		const view = await company(harness, tracked.companyId);
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
		);
	});

	it("re-extracts stored filings by the documented procedure (equities guide, Limitations)", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [tenK(2025), tenK(2024)]);
		const before = await snapshot(harness.ownerId);
		// The administrator's statements, as docs/database/libraries/equities.md lists them.
		await env.DB.batch([
			env.DB.prepare("DELETE FROM equity_reported_fact WHERE owner_id = ? AND company_id = ?").bind(
				harness.ownerId,
				tracked.companyId,
			),
			env.DB.prepare("DELETE FROM equity_metric_value WHERE owner_id = ? AND company_id = ?").bind(
				harness.ownerId,
				tracked.companyId,
			),
			env.DB.prepare(
				`UPDATE equity_report_filing SET facts_status = 'pending', fact_count = 0, primary_scope = NULL
				WHERE owner_id = ? AND company_id = ? AND facts_status = 'extracted'`,
			).bind(harness.ownerId, tracked.companyId),
		]);
		await makeDue(harness, tracked.companyId);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "sec") throw new Error("expected SEC");
		expect(lease.source.knownAccessions).toEqual([]);
		expect(lease.source.pendingFilings.map((filing) => filing.sourceDocumentId)).toEqual([
			accession(2025),
			accession(2024),
		]);
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [tenK(2025), tenK(2024)]),
		);
		expect(response.status).toBe(200);
		const after = await snapshot(harness.ownerId);
		const content = (rows: Record<string, unknown>[], drop: string[]) =>
			rows.map((row) =>
				Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key))),
			);
		expect(content(after.facts, ["recorded_at"])).toEqual(content(before.facts, ["recorded_at"]));
		expect(content(after.values, ["updated_at"])).toEqual(content(before.values, ["updated_at"]));
		expect(content(after.filings, ["recorded_at"])).toEqual(
			content(before.filings, ["recorded_at"]),
		);
	});

	it("keeps a deferred EDINET document pending and due at once", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		await sync(harness, token, [
			securitiesReport(2026),
			securitiesReport(2025, { factsStatus: "deferred" }),
		]);
		const view = await company(harness, nintendo.companyId);
		expect(view.sync.nextDueAt).toBe(harness.time.clock.nowIso());
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(lease.source.pendingFilings.map((filing) => filing.sourceDocumentId)).toEqual([
			docId(2025),
		]);
		// Stored filings come with their stored periods (an amendment takes its original's).
		const stored = securitiesReport(2026);
		expect(lease.source.knownFilings).toEqual([
			{ docId: docId(2026), periodStart: stored.periodStart, periodEnd: stored.periodEnd },
		]);
	});
});

describe("financial sync: scheduling and failures (ADR-0048 §6)", () => {
	it("tracks every directory stock at claim time, Watchlist first, and untracks a delisted one (ADR-0058 §3)", async () => {
		const { harness, token } = await setup({ equityTracksDirectory: true });
		await storeDirectory(harness, "US", ["AAPL", "MSFT"]);
		await storeDirectory(harness, "JP", ["7974"]);
		const lease = await claimSync(harness, token);
		const list = await body(
			await harness.call("GET", "/equities/companies"),
			equityCompanyListSchema,
		);
		expect(list.companies.map((entry) => `${entry.market}:${entry.symbol}`).sort()).toEqual([
			"JP:7974",
			"US:AAPL",
			"US:MSFT",
		]);
		// A US company is due at once; the JP one waits for the EDINET index.
		expect(["AAPL", "MSFT"]).toContain(lease.symbol);
		const nintendo = list.companies.find((entry) => entry.symbol === "7974");
		expect(nintendo?.sync.nextDueAt).toBeNull();
		const msft = list.companies.find((entry) => entry.symbol === "MSFT");
		if (msft === undefined) throw new Error("MSFT not tracked");

		// A new US list without MSFT: the next check after it untracks MSFT; its data stays readable.
		harness.time.advance(5_000);
		await storeDirectory(harness, "US", ["AAPL"]);
		await claim(harness, token);
		expect((await company(harness, msft.companyId)).tracked).toBe(false);
		const audits = await env.DB.prepare(
			`SELECT action, actor, detail FROM audit_log
			WHERE owner_id = ? AND action LIKE 'equity.%'
			ORDER BY at, action`,
		)
			.bind(harness.ownerId)
			.all();
		expect(audits.results).toEqual([
			{ action: "equity.track", actor: "scheduler", detail: "count=3" },
			{ action: "equity.untrack", actor: "scheduler", detail: "count=1" },
		]);

		// Listed again: the same company is tracked again and due at once.
		harness.time.advance(5_000);
		await storeDirectory(harness, "US", ["AAPL", "MSFT"]);
		await claim(harness, token);
		const back = await company(harness, msft.companyId);
		expect(back.tracked).toBe(true);
		expect(back.sync.nextDueAt).toBe(harness.time.clock.nowIso());
	});

	it("tracks no company while the reconcile is off (the test default)", async () => {
		const { harness, token } = await setup();
		await storeDirectory(harness, "US", ["AAPL"]);
		expect(await claim(harness, token)).toBeNull();
		expect((await snapshot(harness.ownerId)).companies).toEqual([]);
	});

	it("backs an identity conflict off for 30 days", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:GOOGL");
		const googl = await sync(harness, token, [tenK(2025)], {
			identity: { sourceCompanyId: "0001652044", name: "Alphabet Inc.", fiscalYearEnd: "12-31" },
		});
		const goog = await track(harness, "us:GOOG");
		const lease = await claimSync(harness, token);
		expect(lease.companyId).toBe(goog.companyId);
		expect(lease.companyId).not.toBe(googl.companyId);
		await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "sec", [], {
				identity: { sourceCompanyId: "0001652044", name: "Alphabet Inc.", fiscalYearEnd: "12-31" },
			}),
		);
		const view = await company(harness, goog.companyId);
		expect(view.sync.failure?.code).toBe(EQUITY_IDENTITY_CONFLICT_CODE);
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 30 * 24 * 60 * 60 * 1000,
		);
	});

	it("records a terminal failure with the provider's status and backs off", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const first = await claimSync(harness, token);
		const failed = await complete(
			harness,
			token,
			first,
			failedCompletion(first, "FINANCIAL_ACCESS_DENIED", { upstreamStatus: 403 }),
		);
		expect((await body(failed, completeJobResponseSchema)).state).toBe("failed");
		let view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("failed");
		expect(view.sync.failure).toEqual({
			code: "FINANCIAL_ACCESS_DENIED",
			upstreamStatus: 403,
			at: harness.time.clock.nowIso(),
		});
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(harness.time.clock.nowMs() + 30 * 60_000);
		// Not due yet: no job.
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(30 * 60_000);
		const second = await claimSync(harness, token);
		await complete(harness, token, second, failedCompletion(second, "FINANCIAL_PARSE_FAILED"));
		view = await company(harness, tracked.companyId);
		expect(view.sync.failure?.upstreamStatus).toBeNull();
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(harness.time.clock.nowMs() + 60 * 60_000);
		// A success clears the failure and the count.
		harness.time.advance(60 * 60_000);
		await sync(harness, token, [tenK(2025)]);
		view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("succeeded");
		expect(view.sync.failure).toBeNull();
		const state = (await snapshot(harness.ownerId)).state[0];
		expect(state?.consecutive_failures).toBe(0);
	});

	it("leaves the company alone while a retryable failure is retried", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		const response = await complete(
			harness,
			token,
			lease,
			failedCompletion(lease, "FINANCIAL_RATE_LIMITED", { retryable: true, upstreamStatus: 429 }),
		);
		expect((await body(response, completeJobResponseSchema)).state).toBe("pending");
		const view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("queued");
		expect(view.sync.failure).toBeNull();
	});

	it("backs a company off when its job reaches the retry ceiling at claim time", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await claimSync(harness, token);
			harness.time.advance(LEASE_MS + 1_000);
		}
		expect(await claim(harness, token)).toBeNull();
		const view = await company(harness, tracked.companyId);
		expect(view.sync.failure?.code).toBe("RETRY_CEILING_REACHED");
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(harness.time.clock.nowMs() + 30 * 60_000);
	});

	it("keeps a re-track while the company's own job runs", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		// Held a day ahead while the job runs.
		expect(Date.parse((await company(harness, tracked.companyId)).sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 24 * 60 * 60 * 1000,
		);
		harness.time.advance(60_000);
		await retrack(harness, tracked.companyId);
		const retrackedAt = harness.time.clock.nowIso();
		harness.time.advance(60_000);
		await complete(harness, token, lease, syncedCompletion(lease, "sec", [tenK(2025)]));
		expect((await company(harness, tracked.companyId)).sync.nextDueAt).toBe(retrackedAt);
		// The re-track is served by the next claim; its completion without one
		// schedules the regular check a week later (off the Watchlist, ADR-0058 §3).
		const next = await claimSync(harness, token);
		await complete(harness, token, next, syncedCompletion(next, "sec", [tenK(2025)]));
		expect(Date.parse((await company(harness, tracked.companyId)).sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
		);
		expect(await claim(harness, token)).toBeNull();
	});

	it("keeps a re-track while a job that then fails runs", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		harness.time.advance(60_000);
		await retrack(harness, tracked.companyId);
		const retrackedAt = harness.time.clock.nowIso();
		await complete(harness, token, lease, failedCompletion(lease, "FINANCIAL_PARSE_FAILED"));
		const view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("failed");
		expect(view.sync.nextDueAt).toBe(retrackedAt);
	});

	it("schedules an owner's retry of a failed sync like any job: no stale backoff, its own backoff", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const first = await claimSync(harness, token);
		await complete(harness, token, first, failedCompletion(first, "FINANCIAL_PARSE_FAILED"));
		const retry = async (runId: string) => {
			harness.time.advance(60_000);
			const response = await harness.call(
				"POST",
				`/research-runs/${runId}/retry`,
				undefined,
				idempotencyKey(),
			);
			expect(response.status).toBe(202);
			return claimSync(harness, token);
		};
		// A failed retry backs off once more (the second failure: 60 minutes).
		const second = await retry(first.runId);
		await complete(harness, token, second, failedCompletion(second, "FINANCIAL_PARSE_FAILED"));
		let view = await company(harness, tracked.companyId);
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(harness.time.clock.nowMs() + 60 * 60_000);
		// A successful retry schedules the regular (weekly) check, not the old backoff time.
		const third = await retry(second.runId);
		await complete(harness, token, third, syncedCompletion(third, "sec", [tenK(2025)]));
		view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("succeeded");
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
		);
	});

	it("records a sync refused at claim time on the company and backs it off", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [
			tenK(2026, { filedOn: "2026-10-10", factsStatus: "not-available" }),
		]);
		// A stored pending filing the claim cannot offer (its link is not https).
		await env.DB.prepare(
			"UPDATE equity_report_filing SET source_url = 'http://example.test/filing' WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.run();
		harness.time.advance(60_000);
		await makeDue(harness, tracked.companyId);
		expect(await claim(harness, token)).toBeNull();
		const view = await company(harness, tracked.companyId);
		expect(view.sync.status).toBe("failed");
		expect(view.sync.failure).toEqual({
			code: "INTERNAL",
			upstreamStatus: null,
			at: harness.time.clock.nowIso(),
		});
		expect(EQUITY_SYNC_API_FAILURE_CODES).toContain("INTERNAL");
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(harness.time.clock.nowMs() + 30 * 60_000);
		// Backed off: the next poll queues nothing.
		expect(await claim(harness, token)).toBeNull();
	});

	it("cancels a queued sync of a company that is no longer tracked", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		harness.time.advance(LEASE_MS + 1_000);
		await untrackCompany(harness, tracked.companyId);
		expect(await claim(harness, token)).toBeNull();
		const job = await env.DB.prepare(
			"SELECT state FROM research_jobs WHERE owner_id = ? AND run_id = ?",
		)
			.bind(harness.ownerId, lease.runId)
			.first();
		expect(job).toEqual({ state: "cancelled" });
	});

	it("queues no EDINET job when the index holds no report (not found) or every indexed report is stored (idle)", async () => {
		const { harness, token } = await setup();
		// No indexed report: tracked but not due until the index lists one.
		await trackCompany(harness, "jp:9999");
		const unknown = await company(
			harness,
			(await snapshot(harness.ownerId)).companies.map((row) => String(row.company_id))[0] ?? "",
		);
		expect(unknown.sync.nextDueAt).toBeNull();
		await makeDue(harness, unknown.companyId);
		expect(await claim(harness, token)).toBeNull();
		const view = await company(harness, unknown.companyId);
		expect(view.sync.phase).toBe("not-found");
		expect(view.sync.lastCheckedAt).toBe(harness.time.clock.nowIso());
		expect(Date.parse(view.sync.nextDueAt ?? "")).toBe(
			harness.time.clock.nowMs() + 30 * 24 * 60 * 60 * 1000,
		);

		// Idle: the six indexed annual reports stored (the newest one's business section read).
		const { harness: idle, token: idleToken } = await setup();
		const nintendo = await track(idle, "jp:7974");
		await sync(
			idle,
			idleToken,
			JP_YEARS.map((year) => securitiesReport(year)),
			{ description: businessDescription(securitiesReport(2026)) },
		);
		await makeDue(idle, nintendo.companyId);
		expect(await claim(idle, idleToken)).toBeNull();
		const idleView = await company(idle, nintendo.companyId);
		expect(idleView.sync.phase).toBe("idle");
		// Off the Watchlist: the weekly check.
		expect(Date.parse(idleView.sync.nextDueAt ?? "")).toBe(
			idle.time.clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
		);
	});
});

describe("the shared EDINET index (ADR-0058 §4)", () => {
	type IndexLease = Extract<ClaimedJob, { kind: "edinet-index" }>;

	async function claimIndex(harness: Harness, token: string): Promise<IndexLease> {
		const job = await claim(harness, token);
		if (job?.kind !== "edinet-index")
			throw new Error(`expected an EDINET index job, got ${job?.kind}`);
		await advanceToPublishing(harness, token, job);
		return job;
	}

	const nintendoReport = {
		docId: docId(2026),
		secCode: "79740",
		edinetCode: "E02367",
		filerName: "任天堂株式会社",
		docTypeCode: "120",
		periodStart: "2025-04-01",
		periodEnd: "2026-03-31",
		submittedAt: "2026-06-26T15:30:00+09:00",
		parentDocId: null,
	};

	it("lists each day once for every company and makes a company with a new report due", async () => {
		const { harness, token } = await setup({ edinetIndexSync: true });
		// Without a JP list there is nothing to index.
		expect(await claim(harness, token)).toBeNull();
		await storeDirectory(harness, "JP", ["7974", "1380"]);
		await trackCompany(harness, "jp:7974");
		harness.time.advance(5_000);
		const lease = await claimIndex(harness, token);
		// Yesterday in Japan (the clock is 2026-10-11 09:00 JST) is a Saturday: the Friday first.
		expect(lease.days).toHaveLength(EDINET_INDEX_LIMITS.maxDaysPerJob);
		expect(lease.days[0]).toBe("2026-10-09");
		const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "edinet-indexed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			fetchedAt: harness.time.clock.nowIso(),
			days: [
				{ date: "2026-10-09", documents: [nintendoReport] },
				{ date: "2026-10-08", documents: [] },
			],
		});
		expect(response.status).toBe(200);
		expect((await body(response, completeJobResponseSchema)).state).toBe("completed");
		const days = await env.DB.prepare(
			"SELECT listed_on, document_count FROM edinet_index_day WHERE owner_id = ? ORDER BY listed_on",
		)
			.bind(harness.ownerId)
			.all();
		expect(days.results).toEqual([
			{ listed_on: "2026-10-08", document_count: 0 },
			{ listed_on: "2026-10-09", document_count: 1 },
		]);
		// The company is due at once and downloads the indexed report.
		const sync = await claimSync(harness, token);
		if (sync.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(sync.source.indexedFilings.map((filing) => filing.sourceDocumentId)).toEqual([
			docId(2026),
		]);
		await complete(
			harness,
			token,
			sync,
			syncedCompletion(sync, "edinet", [securitiesReport(2026)]),
		);
		// The next index job lists the days not listed yet, never one already listed.
		harness.time.advance(15_000);
		const next = await claimIndex(harness, token);
		expect(next.days).not.toContain("2026-10-09");
		expect(next.days).not.toContain("2026-10-08");
		expect(next.days[0]).toBe("2026-10-07");
		const audits = await env.DB.prepare(
			"SELECT count(*) AS n FROM audit_log WHERE owner_id = ? AND action = 'run.sync_edinet_index'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(audits?.n).toBe(2);
	});

	it("tries again 30 minutes after a job that failed, never at every claim", async () => {
		const { harness, token } = await setup({ edinetIndexSync: true });
		await storeDirectory(harness, "JP", ["7974"]);
		const lease = await claimIndex(harness, token);
		const failed = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			failedCompletion(lease, "FINANCIAL_SOURCE_NOT_CONFIGURED"),
		);
		expect((await body(failed, completeJobResponseSchema)).state).toBe("failed");
		harness.time.advance(15 * 60_000);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(15 * 60_000);
		expect((await claimIndex(harness, token)).days[0]).toBe("2026-10-09");
	});

	it("refuses an index result for another kind of job", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		const response = await complete(harness, token, lease, {
			outcome: "edinet-indexed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			fetchedAt: harness.time.clock.nowIso(),
			days: [],
		});
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});
});

describe("sync job retention (ADR-0058 §3)", () => {
	it("deletes old terminal sync jobs at claim time with their transitions, never the newest", async () => {
		const harness = createHarness({ syncJobRetention: true });
		const token = await issueRunnerToken(harness);
		await track(harness, "us:AAPL");
		const first = await sync(harness, token, [tenK(2025)]);
		harness.time.advance(60_000);
		await makeDue(harness, first.companyId);
		const second = await sync(harness, token, [tenK(2025)]);
		// Untracked, so no new sync is queued. Eight days later the older sync
		// goes; the newest of its kind and state stays.
		await untrackCompany(harness, first.companyId);
		harness.time.advance(8 * 24 * 60 * 60 * 1000);
		expect(await claim(harness, token)).toBeNull();
		const runs = await env.DB.prepare(
			"SELECT run_id FROM research_jobs WHERE owner_id = ? ORDER BY created_at",
		)
			.bind(harness.ownerId)
			.all();
		expect(runs.results).toEqual([{ run_id: second.runId }]);
		const transitions = await env.DB.prepare(
			"SELECT count(*) AS n FROM job_transitions WHERE owner_id = ? AND run_id = ?",
		)
			.bind(harness.ownerId, first.runId)
			.first<{ n: number }>();
		expect(transitions?.n).toBe(0);
	});
});

describe("financial sync: owner API (ADR-0048 §7, ADR-0054 §1)", () => {
	it("offers no write: tracking, untracking and syncing are the server's (ADR-0054 §1)", async () => {
		const { harness } = await setup();
		const apple = await track(harness, "us:AAPL");
		for (const [method, path, payload] of [
			["POST", "/equities/companies", { stockId: "us:MSFT" }],
			["DELETE", `/equities/companies/${apple.companyId}`, undefined],
			["POST", `/equities/companies/${apple.companyId}/sync`, undefined],
		] as const) {
			const response = await harness.call(method, path, payload);
			expect(response.status).toBe(404);
		}
		expect((await company(harness, apple.companyId)).tracked).toBe(true);
	});

	it("lists every stored filing newest first, pending, unavailable and superseded included", async () => {
		const { harness, token } = await setup();
		const tracked = await track(harness, "us:AAPL");
		await sync(harness, token, [
			tenK(2026, { filedOn: "2026-10-10", factsStatus: "not-available" }),
			tenK(2025),
			tenK(2024, { factsStatus: "not-available" }),
		]);
		await makeDue(harness, tracked.companyId);
		await sync(harness, token, [
			tenK(2025, { form: "10-K/A", seq: 2, filedOn: "2026-02-01", override: { revenue: "5" } }),
		]);
		const path = `/equities/companies/${tracked.companyId}/filings`;
		const response = await harness.call("GET", path);
		expect(response.status).toBe(200);
		const listed = await body(response, equityFilingsResponseSchema);
		expect(listed.company.companyId).toBe(tracked.companyId);
		expect(
			listed.filings.map((filing) => [
				filing.sourceDocumentId,
				filing.form,
				filing.factsStatus,
				filing.filedOn,
			]),
		).toEqual([
			[accession(2026), "10-K", "pending", "2026-10-10"],
			[accession(2025, 2), "10-K/A", "extracted", "2026-02-01"],
			[accession(2025), "10-K", "extracted", "2025-11-01"],
			[accession(2024), "10-K", "unavailable", "2024-11-01"],
		]);
		expect(listed.filings[2]?.factCount).toBe(tenK(2025).facts.length);
		expect(listed.filings[3]?.factCount).toBe(0);
		expect(listed.filings.map((filing) => filing.isAmendment)).toEqual([false, true, false, false]);
		const etag = response.headers.get("ETag");
		expect(etag).not.toBeNull();
		const again = await harness.call("GET", path, undefined, { "If-None-Match": etag ?? "" });
		expect(again.status).toBe(304);
		const missing = await harness.call("GET", "/equities/companies/eqc_missing/filings");
		expect(missing.status).toBe(404);
		expect(await errorCode(missing)).toBe("EQUITY_COMPANY_NOT_FOUND");
	});

	it("answers 404 for an unknown company and validates queries", async () => {
		const { harness } = await setup();
		for (const path of [
			"/equities/companies/eqc_missing",
			"/equities/companies/eqc_missing/statements/income-statement",
			"/equities/companies/eqc_missing/metrics?metric=revenue",
			"/equities/companies/eqc_missing/revisions?metric=revenue&fiscalYear=2024",
		]) {
			const response = await harness.call("GET", path);
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("EQUITY_COMPANY_NOT_FOUND");
		}
		const tracked = await track(harness, "us:AAPL");
		const base = `/equities/companies/${tracked.companyId}`;
		expect((await harness.call("GET", `${base}/statements/balance`)).status).toBe(404);
		expect((await harness.call("GET", `${base}/statements/income-statement?years=16`)).status).toBe(
			400,
		);
		expect((await harness.call("GET", `${base}/metrics?metric=ebitda`)).status).toBe(400);
		// An empty statement before the first sync: no years, every row present.
		const empty = await statement(harness, tracked.companyId, "income-statement");
		expect(empty.fiscalYears).toEqual([]);
		expect(empty.rows).toHaveLength(5);
		expect(empty.dataUpdatedAt).toBeNull();
	});
});

describe("financial sync: business description (ADR-0053 §2)", () => {
	/** The stored description's report and status (the row the profile reads). */
	async function storedDescription(harness: Harness) {
		const [row] = (await snapshot(harness.ownerId)).descriptions;
		return row === undefined
			? null
			: { id: row.source_document_id, status: row.status, fetchedAt: row.fetched_at };
	}

	it("asks SEC for the newest 10-K's section until one is stored, and keeps the newest", async () => {
		const { harness, token } = await setup();
		const apple = await track(harness, "us:AAPL");
		const first = await sync(harness, token, [tenK(2025)], {
			description: businessDescription(tenK(2025)),
			fetchedAt: "2026-10-11T00:00:05.000Z",
		});
		if (first.source.provider !== "sec") throw new Error("expected SEC");
		expect(first.source.describedDocumentId).toBeNull();
		expect(await storedDescription(harness)).toEqual({
			id: accession(2025),
			status: "extracted",
			fetchedAt: "2026-10-11T00:00:05.000Z",
		});

		await makeDue(harness, apple.companyId);
		const second = await claimSync(harness, token);
		if (second.source.provider !== "sec") throw new Error("expected SEC");
		expect(second.source.describedDocumentId).toBe(accession(2025));
		// An older report never replaces the stored description.
		const older = await complete(
			harness,
			token,
			second,
			syncedCompletion(second, "sec", [], { description: businessDescription(tenK(2024)) }),
		);
		expect(older.status).toBe(200);
		expect((await storedDescription(harness))?.id).toBe(accession(2025));

		// A newer 10-K without a readable section replaces it as not-found.
		await makeDue(harness, apple.companyId);
		await sync(harness, token, [tenK(2026)], {
			description: businessDescription(tenK(2026), { status: "not-found" }),
		});
		expect(await storedDescription(harness)).toMatchObject({
			id: accession(2026),
			status: "not-found",
		});
	});

	it("answers a replayed completion without writing its description again", async () => {
		const { harness, token } = await setup();
		await track(harness, "us:AAPL");
		const lease = await claimSync(harness, token);
		const payload = syncedCompletion(lease, "sec", [tenK(2025)], {
			description: businessDescription(tenK(2025)),
		});
		expect((await complete(harness, token, lease, payload)).status).toBe(200);
		const before = await snapshot(harness.ownerId);
		const replayed = await complete(harness, token, lease, payload);
		expect(replayed.status).toBe(200);
		expect((await body(replayed, completeJobResponseSchema)).replayed).toBe(true);
		expect(await snapshot(harness.ownerId)).toEqual(before);
	});

	it("asks EDINET for the newest stored annual report newer than the described one", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		const first = await sync(harness, token, [securitiesReport(2025)]);
		if (first.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(first.source.describeFiling).toBeNull();

		await makeDue(harness, nintendo.companyId);
		const second = await claimSync(harness, token);
		if (second.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(second.source.describeFiling).toMatchObject({
			sourceDocumentId: docId(2025),
			form: "securities-report",
			periodEnd: "2025-03-31",
			filedOn: "2025-06-27",
		});
		const response = await complete(
			harness,
			token,
			second,
			syncedCompletion(second, "edinet", [], {
				description: businessDescription(securitiesReport(2025)),
			}),
		);
		expect(response.status).toBe(200);
		expect((await storedDescription(harness))?.id).toBe(docId(2025));

		await makeDue(harness, nintendo.companyId);
		const third = await claimSync(harness, token);
		if (third.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(third.source.describeFiling).toBeNull();
		// A backfilled older report's description is not kept; a newer report is asked for.
		await complete(
			harness,
			token,
			third,
			syncedCompletion(third, "edinet", [securitiesReport(2026), securitiesReport(2024)], {
				description: businessDescription(securitiesReport(2024)),
			}),
		);
		expect((await storedDescription(harness))?.id).toBe(docId(2025));
		await makeDue(harness, nintendo.companyId);
		const fourth = await claimSync(harness, token);
		if (fourth.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(fourth.source.describeFiling?.sourceDocumentId).toBe(docId(2026));
	});

	it("queues an otherwise idle EDINET company for a report whose section is not read yet", async () => {
		const { harness, token } = await setup();
		const nintendo = await track(harness, "jp:7974");
		// Synced before ADR-0053: reports stored, no description.
		await sync(
			harness,
			token,
			JP_YEARS.map((year) => securitiesReport(year)),
		);
		await makeDue(harness, nintendo.companyId);
		const lease = await claimSync(harness, token);
		if (lease.source.provider !== "edinet") throw new Error("expected EDINET");
		expect(lease.source.indexedFilings).toEqual([]);
		expect(lease.source.pendingFilings).toEqual([]);
		expect(lease.source.describeFiling?.sourceDocumentId).toBe(docId(2026));
		const response = await complete(
			harness,
			token,
			lease,
			syncedCompletion(lease, "edinet", [], {
				description: businessDescription(securitiesReport(2026)),
			}),
		);
		expect(response.status).toBe(200);
		// Read once: the company is idle again.
		await makeDue(harness, nintendo.companyId);
		expect(await claim(harness, token)).toBeNull();
	});
});
