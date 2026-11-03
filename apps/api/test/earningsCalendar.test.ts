import { env } from "cloudflare:test";
import { completeJobResponseSchema, stockProfileResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	type ClaimedLease,
	claim,
	createHarness,
	errorCode,
	type Harness,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0068: every listed stock's next earnings date. The claim-time
 * schedule queues one `earnings-calendar-sync` per market whose stock list
 * is stored, the claim names the window [today, today + 185 days], and the
 * completion replaces the market's stored calendar with the stock-list
 * stocks' rows, which `GET /stocks/:stockId` serves. Real persistence on
 * both engines; the clock starts on Sunday 2026-10-11 00:00 UTC.
 */

type CalendarLease = Extract<ClaimedLease, { kind: "earnings-calendar-sync" }>;

const HOUR = 60 * 60_000;
/** Past the per-owner check period and the least gap between two jobs. */
const GAP = 20_000;

function setup() {
	return createHarness({ serverDataSync: true, serverSyncKinds: ["earnings-calendar-sync"] });
}

async function seedDirectory(harness: Harness, market: "US" | "JP", symbols: readonly string[]) {
	await env.DB.batch([
		...symbols.map((symbol) =>
			env.DB.prepare(
				`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
					symbol_key, name_key, local_name_key, search_key)
				VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '', ?)`,
			).bind(
				harness.ownerId,
				market,
				symbol,
				`${symbol} Inc.`,
				market === "US" ? "nyse" : "tse-prime",
				symbol.toLowerCase(),
				symbol.toLowerCase(),
				symbol.toLowerCase(),
			),
		),
		env.DB.prepare(
			`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version)
			VALUES (?, ?, ?, NULL, '2026-10-10T00:00:00.000Z', 2)`,
		).bind(harness.ownerId, market, symbols.length),
	]);
}

async function claimCalendar(harness: Harness, token: string): Promise<CalendarLease> {
	const job = await claim(harness, token);
	if (job?.kind !== "earnings-calendar-sync") {
		throw new Error(`expected an earnings calendar, got ${job?.kind}`);
	}
	await advanceToPublishing(harness, token, job);
	return job;
}

function synced(harness: Harness, lease: CalendarLease, market: "US" | "JP" = lease.market) {
	return {
		outcome: "earnings-calendar-synced",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		market,
		fromDate: lease.fromDate,
		toDate: lease.toDate,
		fetchedAt: harness.time.clock.nowIso(),
		events: [
			{
				symbol: "KO",
				periodKey: "2026-q3",
				announcementDate: "2026-10-21",
				fiscalPeriodLabel: "Q3 2026",
				fiscalPeriodEnd: null,
				timing: "before-open",
			},
			{
				symbol: "KO",
				periodKey: "2026-q2",
				announcementDate: "2026-10-11",
				fiscalPeriodLabel: "Q2 2026",
				fiscalPeriodEnd: null,
				timing: "before-open",
			},
			// Not in the stored stock list: not kept.
			{
				symbol: "ZZZZ",
				periodKey: "2026-q3",
				announcementDate: "2026-10-22",
				fiscalPeriodLabel: "Q3 2026",
				fiscalPeriodEnd: null,
				timing: "unknown",
			},
		],
		truncatedDates: [],
	};
}

async function jobsOfKind(harness: Harness) {
	const rows = await env.DB.prepare(
		`SELECT run_id, state, request_json FROM research_jobs
		WHERE owner_id = ? AND kind = 'earnings-calendar-sync' ORDER BY created_at`,
	)
		.bind(harness.ownerId)
		.all<{ run_id: string; state: string; request_json: string }>();
	return rows.results;
}

async function profile(harness: Harness, stockId: string) {
	const response = await harness.call("GET", `/stocks/${encodeURIComponent(stockId)}`);
	expect(response.status).toBe(200);
	return body(response, stockProfileResponseSchema);
}

describe("earnings-calendar-sync (ADR-0068)", () => {
	it("queues nothing for a market whose stock list is not stored", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobsOfKind(harness)).toEqual([]);
		expect((await profile(harness, "us:KO")).earningsCalendar).toBeNull();
	});

	it("syncs each market's calendar, serves a listed stock's events, and waits a day", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "US", ["KO", "PEP"]);
		const lease = await claimCalendar(harness, token);
		expect(lease).toMatchObject({ market: "US", fromDate: "2026-10-11", toDate: "2027-04-14" });
		// One active job per market: none queued beside it.
		expect(await jobsOfKind(harness)).toHaveLength(1);
		const response = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			synced(harness, lease),
		);
		expect(response.status).toBe(200);
		expect((await body(response, completeJobResponseSchema)).state).toBe("completed");

		const ko = await profile(harness, "us:KO");
		expect(ko.earningsCalendar).toEqual({
			source: "finnhub",
			publisher: "Finnhub",
			sourceUrl: "https://finnhub.io/",
			syncedAt: "2026-10-11T00:00:00.000Z",
			// Soonest first; nothing before today.
			events: [
				{
					periodKey: "2026-q2",
					announcementDate: "2026-10-11",
					fiscalPeriodLabel: "Q2 2026",
					fiscalPeriodEnd: null,
					timing: "before-open",
				},
				{
					periodKey: "2026-q3",
					announcementDate: "2026-10-21",
					fiscalPeriodLabel: "Q3 2026",
					fiscalPeriodEnd: null,
					timing: "before-open",
				},
			],
		});
		// A listed stock without rows: the calendar is stored, the list empty.
		expect((await profile(harness, "us:PEP")).earningsCalendar?.events).toEqual([]);
		const stored = await env.DB.prepare(
			"SELECT count(*) AS n FROM stock_earnings_calendar WHERE owner_id = ? AND symbol = 'ZZZZ'",
		)
			.bind(harness.ownerId)
			.first<{ n: number }>();
		expect(stored?.n).toBe(0);

		// A fresh calendar queues nothing until it is a day old.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(24 * HOUR);
		const next = await claimCalendar(harness, token);
		expect(next).toMatchObject({ market: "US", fromDate: "2026-10-12" });
		// The next day the past announcement is no longer served.
		expect(
			(await profile(harness, "us:KO")).earningsCalendar?.events.map((event) => event.periodKey),
		).toEqual(["2026-q3"]);
	});

	it("refuses another market's calendar and retries a failed sync later", async () => {
		const harness = setup();
		const token = await issueRunnerToken(harness);
		await seedDirectory(harness, "JP", ["1380"]);
		const lease = await claimCalendar(harness, token);
		expect(lease.market).toBe("JP");
		const wrong = await harness.runner(
			token,
			`/jobs/${lease.runId}/complete`,
			synced(harness, lease, "US"),
		);
		expect(wrong.status).toBe(400);
		expect(await errorCode(wrong)).toBe("VALIDATION_FAILED");
		const failed = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			failureCode: "SOURCE_NOT_CONFIGURED",
			retryable: false,
		});
		expect(failed.status).toBe(200);
		expect((await profile(harness, "jp:1380")).earningsCalendar).toBeNull();
		// Retried after the schedule's retry gap, not at once.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(HOUR);
		expect((await claimCalendar(harness, token)).market).toBe("JP");
	});
});
