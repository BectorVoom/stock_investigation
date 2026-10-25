import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import {
	calendarFeedIssuedSchema,
	completeJobResponseSchema,
	researchRunResponseSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	claim,
	createHarness,
	errorCode,
	idempotencyKey,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

const AAPL_EVENT = {
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
} as const;

function earningsCompletion(
	lease: { leaseGeneration: number },
	fetchedAt: string,
	stocks: readonly {
		readonly stockId: string;
		readonly name: string | null;
		readonly events: readonly {
			readonly periodKey: string;
			readonly announcementDate: string | null;
			readonly fiscalPeriodLabel: string;
			readonly fiscalPeriodEnd: string | null;
			readonly timing: "before-open" | "after-close" | "during-session" | "unknown";
		}[];
		readonly errorCode:
			| "NEVER_REFRESHED"
			| "SOURCE_NOT_CONFIGURED"
			| "SOURCE_AUTH_FAILED"
			| "SYMBOL_NOT_FOUND"
			| "PLAN_NOT_ENTITLED"
			| "RATE_LIMITED"
			| "NO_SCHEDULED_DATE"
			| "SOURCE_FAILED"
			| null;
		readonly upstreamStatus?: number;
	}[],
) {
	return {
		outcome: "earnings-refreshed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		stocks: stocks.map((entry) => ({ ...entry, fetchedAt, events: [...entry.events] })),
	};
}

async function addStock(harness: ReturnType<typeof createHarness>, market: string, symbol: string) {
	const response = await harness.call("POST", "/watchlist/stocks", { market, symbol });
	expect(response.status).toBe(200);
	return body(response, watchlistResponseSchema);
}

async function queueRefresh(harness: ReturnType<typeof createHarness>): Promise<string> {
	const response = await harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey());
	expect(response.status).toBe(202);
	return (await body(response, researchRunResponseSchema)).run.runId;
}

describe("watchlist stocks (FR-018)", () => {
	it("starts empty with no refresh history and no feed", async () => {
		const harness = createHarness();
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(watchlist.stocks).toEqual([]);
		expect(watchlist.refresh).toEqual({
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		});
		expect(watchlist.feed).toEqual({ enabled: false, createdAt: null });
		expect(watchlist.googleCalendar).toEqual({
			status: "disconnected",
			authUrl: null,
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: null,
		});
	});

	it("adds US and JP stocks, trimming and upper-casing the symbol", async () => {
		const harness = createHarness();
		const added = await addStock(harness, "US", "  aapl ");
		expect(added.stocks).toHaveLength(1);
		expect(added.stocks[0]).toMatchObject({
			stockId: "us:AAPL",
			market: "US",
			symbol: "AAPL",
			name: null,
			source: "finnhub",
			publisher: "Finnhub",
			sourceUrl: "https://finnhub.io/",
			lastRefreshedAt: null,
			retrievedAt: null,
		});
		expect(added.stocks[0]?.unavailable).toMatchObject({ code: "NEVER_REFRESHED" });
		expect(added.stocks[0]?.events).toEqual([]);
		const both = await addStock(harness, "JP", "7203");
		expect(both.stocks.map((stock) => stock.stockId)).toEqual(["us:AAPL", "jp:7203"]);
		expect(both.stocks[1]).toMatchObject({
			source: "jpx",
			publisher: "Japan Exchange Group (JPX)",
			sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
		});
	});

	it("rejects symbols that do not match the market shape", async () => {
		const harness = createHarness();
		for (const request of [
			{ market: "US", symbol: "7203" },
			{ market: "JP", symbol: "AAPL" },
			{ market: "JP", symbol: "72" },
			{ market: "US", symbol: "" },
			{ market: "XX", symbol: "AAPL" },
		]) {
			const response = await harness.call("POST", "/watchlist/stocks", request);
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
	});

	it("treats a repeated add as a success that changes nothing", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const reread = await addStock(harness, "US", "aapl");
		expect(reread.stocks).toHaveLength(1);
		expect(reread.stocks[0]?.addedAt).not.toBeNull();
	});

	it("refuses more than 50 stocks with a stable validation error", async () => {
		const harness = createHarness();
		for (let index = 1; index <= 50; index += 1) {
			await addStock(harness, "US", `T${index}`);
		}
		const full = await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "EXTRA" });
		expect(full.status).toBe(400);
		expect(await errorCode(full)).toBe("VALIDATION_FAILED");
		// The cap is enforced in the INSERT: the list still holds 50 rows,
		// so every watchlist route keeps answering 200 (the response schema
		// rejects 51), and the refused add wrote no audit row.
		const reread = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(reread.stocks).toHaveLength(50);
		const audits = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM audit_log WHERE owner_id = ? AND action = 'watchlist.stock.add' AND resource = ?",
		)
			.bind(harness.ownerId, "us:EXTRA")
			.first<{ n: number }>();
		expect(audits?.n).toBe(0);
		// A re-add of a present stock still succeeds when the list is full.
		const present = await addStock(harness, "US", "T1");
		expect(present.stocks).toHaveLength(50);
	});

	it("removes a stock and answers NOT_FOUND for unknown or malformed ids", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		const removed = await harness.call("DELETE", "/watchlist/stocks/us:AAPL");
		expect(removed.status).toBe(200);
		expect(
			(await body(removed, watchlistResponseSchema)).stocks.map((stock) => stock.stockId),
		).toEqual(["jp:7203"]);
		const again = await harness.call("DELETE", "/watchlist/stocks/us:AAPL");
		expect(again.status).toBe(404);
		expect(await errorCode(again)).toBe("NOT_FOUND");
		const malformed = await harness.call("DELETE", "/watchlist/stocks/nope");
		expect(malformed.status).toBe(404);
		expect(await errorCode(malformed)).toBe("NOT_FOUND");
	});

	it("scopes the watchlist per owner and defends writes with CSRF", async () => {
		const first = createHarness();
		const second = createHarness();
		await addStock(first, "US", "AAPL");
		const other = await body(await second.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(other.stocks).toEqual([]);
		const csrf = await first.raw("POST", "/watchlist/stocks", {
			body: { market: "US", symbol: "MSFT" },
			headers: { Origin: "http://localhost" },
		});
		expect(csrf.status).toBe(403);
		expect(await errorCode(csrf)).toBe("CSRF_REJECTED");
	});

	it("answers 304 when the watchlist is unchanged", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const first = await harness.call("GET", "/watchlist");
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const second = await harness.call("GET", "/watchlist", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(second.status).toBe(304);
	});

	it("records an audit row with ids only", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const rows = await env.DB.prepare(
			"SELECT action, resource, detail FROM audit_log WHERE owner_id = ? AND action = ?",
		)
			.bind(harness.ownerId, "watchlist.stock.add")
			.all<{ action: string; resource: string; detail: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]).toEqual({
			action: "watchlist.stock.add",
			resource: "us:AAPL",
			detail: "market=US",
		});
	});
});

describe("earnings refresh (FR-018)", () => {
	it("queues nothing for an empty watchlist, with a stable code", async () => {
		const harness = createHarness();
		const response = await harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey());
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
	});

	it("de-duplicates: one active run per owner", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const first = await queueRefresh(harness);
		const second = await queueRefresh(harness);
		expect(second).toBe(first);
	});

	it("S1: two concurrent creations with different keys yield a single active job", async () => {
		const harness = createHarness();
		await addStock(harness, "US", "AAPL");
		const [first, second] = await Promise.all([
			harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey()),
			harness.call("POST", "/watchlist/refresh", undefined, idempotencyKey()),
		]);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		const firstRun = (await body(first, researchRunResponseSchema)).run.runId;
		const secondRun = (await body(second, researchRunResponseSchema)).run.runId;
		expect(secondRun).toBe(firstRun);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = 'earnings-refresh'",
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(rows.results[0]?.n).toBe(1);
	});

	it("claims the watchlist stocks with stored names and the 185-day window", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		const runId = await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh" || job.runId !== runId) {
			throw new Error("expected the earnings-refresh job");
		}
		// The test clock starts at 2026-10-11: the window is [today, today + 185 days].
		expect(job.fromDate).toBe("2026-10-11");
		expect(job.toDate).toBe("2027-04-14");
		expect(job.stocks).toEqual([
			{ stockId: "us:AAPL", name: null },
			{ stockId: "jp:7203", name: null },
		]);
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(watchlist.refresh.activeRunId).toBe(runId);
		expect(watchlist.refresh.activeRunState).not.toBeNull();
	});

	it("runs claim -> complete -> data end to end", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		const runId = await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${runId}/complete`, {
			...earningsCompletion(job, harness.time.clock.nowIso(), [
				{
					stockId: "us:AAPL",
					name: "Apple Inc",
					events: [AAPL_EVENT],
					errorCode: null,
				},
				{ stockId: "jp:7203", name: null, events: [], errorCode: "NO_SCHEDULED_DATE" },
			]),
		});
		expect(completed.status).toBe(200);
		expect((await body(completed, completeJobResponseSchema)).replayed).toBe(false);
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		const aapl = watchlist.stocks.find((stock) => stock.stockId === "us:AAPL");
		expect(aapl?.name).toBe("Apple Inc");
		expect(aapl?.events).toEqual([{ ...AAPL_EVENT }]);
		expect(aapl?.unavailable).toBeNull();
		expect(aapl?.retrievedAt).not.toBeNull();
		expect(aapl?.lastRefreshedAt).not.toBeNull();
		const toyota = watchlist.stocks.find((stock) => stock.stockId === "jp:7203");
		expect(toyota?.events).toEqual([]);
		expect(toyota?.unavailable).toMatchObject({ code: "NO_SCHEDULED_DATE" });
		expect(toyota?.unavailable?.reason).toBe(
			"The source lists no upcoming announcement for this stock.",
		);
		expect(watchlist.refresh.activeRunId).toBeNull();
		expect(watchlist.refresh.lastSucceededAt).not.toBeNull();
		expect(watchlist.refresh.lastFailure).toBeNull();
	});

	it("stores only stocks still on the watchlist, counting the rest", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "US", "MSFT");
		const runId = await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		// The owner removes MSFT while the refresh is running.
		expect(await (await harness.call("DELETE", "/watchlist/stocks/us:MSFT")).status).toBe(200);
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${runId}/complete`, {
			...earningsCompletion(job, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
				{ stockId: "us:MSFT", name: "Microsoft", events: [AAPL_EVENT], errorCode: null },
			]),
		});
		expect(completed.status).toBe(200);
		const stored = await env.DB.prepare(
			"SELECT stock_id AS id FROM watchlist_stocks WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.all<{ id: string }>();
		expect(stored.results.map((row) => row.id).sort()).toEqual(["us:AAPL"]);
		const events = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM earnings_events WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.all<{ n: number }>();
		expect(events.results[0]?.n).toBe(1);
		const audits = await env.DB.prepare(
			"SELECT reason FROM job_transitions WHERE owner_id = ? AND run_id = ? AND to_state = 'completed'",
		)
			.bind(harness.ownerId, runId)
			.all<{ reason: string }>();
		expect(audits.results.map((row) => row.reason).join(" ")).toContain(
			"dropped 1 off-watchlist stocks",
		);
	});

	it("replaces events on success but keeps them on failure", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await queueRefresh(harness);
		const first = await claim(harness, token);
		if (first?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(harness, token, first);
		await harness.runner(
			token,
			`/jobs/${first.runId}/complete`,
			earningsCompletion(first, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
			]),
		);
		await queueRefresh(harness);
		const second = await claim(harness, token);
		if (second?.kind !== "earnings-refresh") throw new Error("expected the second job");
		// The stored name travels on the next claim, so the runner can skip the lookup.
		expect(second.stocks).toEqual([{ stockId: "us:AAPL", name: "Apple Inc" }]);
		await advanceToPublishing(harness, token, second);
		harness.time.advance(1000);
		await harness.runner(
			token,
			`/jobs/${second.runId}/complete`,
			earningsCompletion(second, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: null, events: [], errorCode: "SOURCE_FAILED" },
			]),
		);
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		const aapl = watchlist.stocks.find((stock) => stock.stockId === "us:AAPL");
		expect(aapl?.events).toEqual([{ ...AAPL_EVENT }]);
		expect(aapl?.name).toBe("Apple Inc");
		expect(aapl?.unavailable).toMatchObject({ code: "SOURCE_FAILED" });
	});

	it("stores the provider's status beside a stock's code, and a later success clears it (§4a)", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		const completeWith = async (entry: Parameters<typeof earningsCompletion>[2][number]) => {
			await queueRefresh(harness);
			const lease = await claim(harness, token);
			if (lease?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
			await advanceToPublishing(harness, token, lease);
			harness.time.advance(1000);
			const response = await harness.runner(
				token,
				`/jobs/${lease.runId}/complete`,
				earningsCompletion(lease, harness.time.clock.nowIso(), [entry]),
			);
			expect(response.status).toBe(200);
		};
		const aaplOf = async () =>
			(await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema)).stocks.find(
				(stock) => stock.stockId === "us:AAPL",
			);

		await completeWith({
			stockId: "us:AAPL",
			name: null,
			events: [],
			errorCode: "RATE_LIMITED",
			upstreamStatus: 429,
		});
		expect((await aaplOf())?.unavailable).toMatchObject({
			code: "RATE_LIMITED",
			upstreamStatus: 429,
		});

		await completeWith({
			stockId: "us:AAPL",
			name: "Apple Inc",
			events: [AAPL_EVENT],
			errorCode: null,
		});
		expect((await aaplOf())?.unavailable).toBeNull();

		// A code with no provider answer behind it carries no status.
		await completeWith({ stockId: "us:AAPL", name: null, events: [], errorCode: "SOURCE_FAILED" });
		expect((await aaplOf())?.unavailable).toMatchObject({
			code: "SOURCE_FAILED",
			upstreamStatus: null,
		});
	});

	it("rejects an outcome that does not match the job kind", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		const runId = await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		const wrong = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "market-refreshed",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			series: [],
		});
		expect(wrong.status).toBe(400);
		expect(await errorCode(wrong)).toBe("VALIDATION_FAILED");
		// And an earnings outcome on a market run is rejected the same way.
		await advanceToPublishing(harness, token, job);
		await harness.runner(
			token,
			`/jobs/${runId}/complete`,
			earningsCompletion(job, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: null, events: [], errorCode: "NO_SCHEDULED_DATE" },
			]),
		);
		await harness.call("POST", "/home/refresh", undefined, idempotencyKey());
		const market = await claim(harness, token);
		if (market?.kind !== "market-refresh") throw new Error("expected the market-refresh job");
		const mismatch = await harness.runner(token, `/jobs/${market.runId}/complete`, {
			outcome: "earnings-refreshed",
			leaseGeneration: market.leaseGeneration,
			usage: USAGE,
			stocks: [],
		});
		expect(mismatch.status).toBe(400);
		expect(await errorCode(mismatch)).toBe("VALIDATION_FAILED");
	});

	it("rejects a stale generation and replays a duplicate completion", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		const runId = await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(harness, token, job);
		const stale = await harness.runner(token, `/jobs/${runId}/complete`, {
			outcome: "earnings-refreshed",
			leaseGeneration: job.leaseGeneration + 1,
			usage: USAGE,
			stocks: [],
		});
		expect(stale.status).toBe(409);
		expect(await errorCode(stale)).toBe("STALE_LEASE");
		const payload = earningsCompletion(job, harness.time.clock.nowIso(), [
			{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
		]);
		const first = await harness.runner(token, `/jobs/${runId}/complete`, payload);
		expect((await body(first, completeJobResponseSchema)).replayed).toBe(false);
		const replay = await harness.runner(token, `/jobs/${runId}/complete`, payload);
		expect((await body(replay, completeJobResponseSchema)).replayed).toBe(true);
	});
});

describe("owner calendar download (FR-018)", () => {
	it("serves the calendar as an attachment with the dated event only", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await addStock(harness, "JP", "7203");
		await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(harness, token, job);
		const undecided = {
			periodKey: "fy2027-03-31-third-quarter",
			announcementDate: null,
			fiscalPeriodLabel: "Third quarter",
			fiscalPeriodEnd: "2027-03-31",
			timing: "unknown",
		} as const;
		await harness.runner(
			token,
			`/jobs/${job.runId}/complete`,
			earningsCompletion(job, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
				{ stockId: "jp:7203", name: "Toyota Motor Corp.", events: [undecided], errorCode: null },
			]),
		);
		const response = await harness.call("GET", "/watchlist/calendar.ics");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="earnings-calendar.ics"',
		);
		const text = await response.text();
		expect(text).toContain("BEGIN:VCALENDAR");
		expect(text).toContain("UID:earnings-us-AAPL-2026-q4@research-workspace");
		expect(text).toContain("DTSTART;VALUE=DATE:20261029");
		// The undecided announcement is listed on the watchlist but has no VEVENT.
		expect(text).not.toContain("jp-7203");
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(watchlist.stocks.find((stock) => stock.stockId === "jp:7203")?.events).toHaveLength(1);
	});
});

describe("calendar subscription feed (FR-018)", () => {
	async function issueFeed(harness: ReturnType<typeof createHarness>) {
		const response = await harness.call("POST", "/watchlist/feed");
		expect(response.status).toBe(201);
		return body(response, calendarFeedIssuedSchema);
	}

	/** Feed route as the test harness addresses it (raw() already prefixes /api/v1). */
	function feedRoute(token: string): string {
		return `/calendar-feed/${token}/earnings.ics`;
	}

	it("issues a token once, serves the calendar anonymously, and reports the feed", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await addStock(harness, "US", "AAPL");
		await queueRefresh(harness);
		const job = await claim(harness, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(harness, token, job);
		await harness.runner(
			token,
			`/jobs/${job.runId}/complete`,
			earningsCompletion(job, harness.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
			]),
		);
		const issued = await issueFeed(harness);
		expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,200}$/);
		// Feed tokens carry their own prefix: they live in URL paths, not in
		// Authorization headers like the runner's `rk_` secrets.
		expect(issued.token.startsWith("cal_")).toBe(true);
		expect(issued.path).toBe(`/api/v1/calendar-feed/${issued.token}/earnings.ics`);
		// The calendar app carries no session: an anonymous fetch serves the document.
		const anonymous = await harness.raw("GET", feedRoute(issued.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(anonymous.status).toBe(200);
		expect(anonymous.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
		expect(anonymous.headers.get("Cache-Control")).toBe("private, max-age=900");
		expect(anonymous.headers.get("ETag")).not.toBeNull();
		const text = await anonymous.text();
		expect(text).toContain("UID:earnings-us-AAPL-2026-q4@research-workspace");
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(watchlist.feed.enabled).toBe(true);
		expect(watchlist.feed.createdAt).toBe(issued.createdAt);
		const cached = await harness.raw("GET", feedRoute(issued.token), {
			headers: {
				"X-Test-Anonymous": "1",
				"If-None-Match": anonymous.headers.get("ETag") ?? "",
			},
		});
		expect(cached.status).toBe(304);
	});

	it("answers the same 404 for a bad shape, an unknown token and a revoked feed", async () => {
		const harness = createHarness();
		for (const path of [
			"/calendar-feed/short/earnings.ics",
			"/calendar-feed/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/earnings.ics",
			"/calendar-feed/!!!not-a-token!!!/earnings.ics",
		]) {
			const response = await harness.raw("GET", path, { headers: { "X-Test-Anonymous": "1" } });
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("NOT_FOUND");
		}
		const issued = await issueFeed(harness);
		const revoked = await harness.call("DELETE", "/watchlist/feed");
		expect(revoked.status).toBe(204);
		const gone = await harness.raw("GET", feedRoute(issued.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(gone.status).toBe(404);
		expect(await errorCode(gone)).toBe("NOT_FOUND");
		const watchlist = await body(await harness.call("GET", "/watchlist"), watchlistResponseSchema);
		expect(watchlist.feed).toEqual({ enabled: false, createdAt: null });
		const again = await harness.call("DELETE", "/watchlist/feed");
		expect(again.status).toBe(404);
		expect(await errorCode(again)).toBe("NOT_FOUND");
	});

	it("answers the same uniform 404 for any other calendar-feed shape or method", async () => {
		const harness = createHarness();
		const issued = await issueFeed(harness);
		const valid = `/calendar-feed/${issued.token}/earnings.ics`;
		const anonymous = { headers: { "X-Test-Anonymous": "1" } };
		// Malformed paths never reach the owner API: no 401/403, always the
		// same 404 body, with or without an owner session.
		for (const path of [
			"/calendar-feed//earnings.ics",
			`${valid}/`,
			"/calendar-feed/earnings.ics",
			"/calendar-feed/other",
		]) {
			for (const init of [anonymous, {}]) {
				const response = await harness.raw("GET", path, init);
				expect(response.status).toBe(404);
				expect(await errorCode(response)).toBe("NOT_FOUND");
			}
		}
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			for (const init of [anonymous, {}]) {
				const response = await harness.raw(method, valid, init);
				expect(response.status).toBe(404);
				expect(await errorCode(response)).toBe("NOT_FOUND");
			}
		}
		// HEAD is served like GET on the well-formed route.
		const head = await harness.raw("HEAD", valid, anonymous);
		expect(head.status).toBe(200);
	});

	it("rotates the token: the old link stops working", async () => {
		const harness = createHarness();
		const first = await issueFeed(harness);
		const second = await issueFeed(harness);
		expect(second.token).not.toBe(first.token);
		const old = await harness.raw("GET", feedRoute(first.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(old.status).toBe(404);
		const current = await harness.raw("GET", feedRoute(second.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect(current.status).toBe(200);
	});

	it("never serves another owner's calendar and never honours the token as an owner session", async () => {
		const first = createHarness();
		const second = createHarness();
		const token = await issueRunnerToken(first);
		await addStock(first, "US", "AAPL");
		await queueRefresh(first);
		const job = await claim(first, token);
		if (job?.kind !== "earnings-refresh") throw new Error("expected the earnings-refresh job");
		await advanceToPublishing(first, token, job);
		await first.runner(
			token,
			`/jobs/${job.runId}/complete`,
			earningsCompletion(job, first.time.clock.nowIso(), [
				{ stockId: "us:AAPL", name: "Apple Inc", events: [AAPL_EVENT], errorCode: null },
			]),
		);
		const issued = await body(
			await first.call("POST", "/watchlist/feed"),
			calendarFeedIssuedSchema,
		);
		// The second owner's feed is a different token over an empty calendar.
		const other = await body(
			await second.call("POST", "/watchlist/feed"),
			calendarFeedIssuedSchema,
		);
		expect(other.token).not.toBe(issued.token);
		const otherCalendar = await second.raw("GET", feedRoute(other.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect((await otherCalendar.text()).includes("VEVENT")).toBe(false);
		// The first owner's token still serves only the first owner's calendar.
		const own = await first.raw("GET", feedRoute(issued.token), {
			headers: { "X-Test-Anonymous": "1" },
		});
		expect((await own.text()).includes("earnings-us-AAPL")).toBe(true);
		// And the feed token buys nothing on owner routes: presented there, the
		// caller is still whoever the session says — here the second owner.
		const foreign = await second.call("GET", "/watchlist", undefined, {
			Authorization: `Bearer ${issued.token}`,
		});
		expect(foreign.status).toBe(200);
		expect((await body(foreign, watchlistResponseSchema)).stocks).toEqual([]);
		// With NO owner session the token alone is not a session: the owner
		// route answers unauthenticated, never the first owner's calendar.
		const bare = await first.raw("GET", "/watchlist", {
			headers: { "X-Test-Anonymous": "1", Authorization: `Bearer ${issued.token}` },
		});
		expect(bare.status).toBe(401);
		expect(await errorCode(bare)).toBe("UNAUTHENTICATED");
	});

	it("never writes the token to a log line, an audit row or an error body", async () => {
		const harness = createHarness();
		const lines: string[] = [];
		const errors = console.error;
		console.error = (...args: unknown[]) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			const issued = await issueFeed(harness);
			const fetched = await harness.raw("GET", feedRoute(issued.token), {
				headers: { "X-Test-Anonymous": "1" },
			});
			expect(fetched.status).toBe(200);
			const missing = await harness.raw(
				"GET",
				"/calendar-feed/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/earnings.ics",
				{ headers: { "X-Test-Anonymous": "1" } },
			);
			expect(missing.status).toBe(404);
			for (const line of lines) {
				expect(line).not.toContain(issued.token);
			}
			const audits = await env.DB.prepare("SELECT detail FROM audit_log WHERE owner_id = ?")
				.bind(harness.ownerId)
				.all<{ detail: string }>();
			expect(audits.results.length).toBeGreaterThan(0);
			for (const row of audits.results) {
				expect(row.detail).not.toContain(issued.token);
			}
			const missingBody = await missing.json();
			expect(JSON.stringify(missingBody)).not.toContain("xxxx");
			// Force a logged failure ON the feed route: the lookup throws,
			// the error boundary logs once and answers 500. The logged route
			// is the unexpanded pattern — never the token-bearing path.
			const persistence = createD1Adapters(env.DB);
			const failing = createHarness({
				ownerId: harness.ownerId,
				persistence: {
					...persistence,
					calendarFeed: {
						...persistence.calendarFeed,
						findOwnerByTokenHash: () => Promise.reject(new Error("lookup blew up")),
					},
				},
			});
			const broken = await failing.raw("GET", feedRoute(issued.token), {
				headers: { "X-Test-Anonymous": "1" },
			});
			expect(broken.status).toBe(500);
			expect(JSON.stringify(await broken.json())).not.toContain(issued.token);
			const logged = lines.filter((line) => line.includes("unhandled_error"));
			expect(logged).toHaveLength(1);
			expect(logged[0]).toContain("/api/v1/calendar-feed/:token/earnings.ics");
			for (const line of lines) {
				expect(line).not.toContain(issued.token);
			}
		} finally {
			console.error = errors;
		}
	});
});
