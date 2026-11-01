import { env } from "cloudflare:test";
import { createD1Adapters } from "@research/adapters/d1";
import type { NewsSource } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	type ClaimedLease,
	claim,
	createHarness,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * ADR-0053 §3–4: the server syncs the Google Calendar and the news feeds
 * itself when a runner asks for work; no page asks for either. These drive
 * the claim on real persistence and check what is queued and when. The
 * timing rule is the Lean-verified `decideSync` (ADR-0051).
 */

type Harness = ReturnType<typeof createHarness>;

const MINUTE = 60_000;
/** Past the per-owner check period and the least gap between two jobs. */
const GAP = 20_000;

type GoogleLease = Extract<ClaimedLease, { kind: "google-calendar" }>;
type NewsLease = Extract<ClaimedLease, { kind: "news-ingest" }>;

async function audits(harness: Harness, runId: string): Promise<string[]> {
	const rows = await env.DB.prepare(
		"SELECT actor, action, detail FROM audit_log WHERE owner_id = ? AND resource = ? ORDER BY audit_id",
	)
		.bind(harness.ownerId, runId)
		.all<{ actor: string; action: string; detail: string }>();
	return rows.results.map((row) => `${row.actor} ${row.action} ${row.detail}`);
}

async function jobCount(harness: Harness, kind: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND kind = ?",
	)
		.bind(harness.ownerId, kind)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe("the server syncs the Google Calendar (ADR-0053 §3)", () => {
	async function setup() {
		const harness = createHarness({ serverDataSync: true, serverSyncKinds: ["google-calendar"] });
		return { harness, token: await issueRunnerToken(harness) };
	}

	/** The calendar as a finished connect leaves it: connected, never synced. */
	async function connect(harness: Harness): Promise<void> {
		await createD1Adapters(env.DB).googleCalendar.apply(
			harness.ownerId,
			{ status: "connected", calendarId: "cal_1", connectedAt: harness.time.clock.nowIso() },
			harness.time.clock.nowIso(),
		);
	}

	async function claimSync(harness: Harness, token: string): Promise<GoogleLease> {
		const job = await claim(harness, token);
		if (job?.kind !== "google-calendar")
			throw new Error(`expected a google sync, got ${job?.kind}`);
		expect(job.action).toBe("sync");
		await advanceToPublishing(harness, token, job);
		return job;
	}

	async function completeSync(harness: Harness, token: string, lease: GoogleLease, digest: string) {
		const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "google-calendar-synced",
			leaseGeneration: lease.leaseGeneration,
			usage: USAGE,
			calendarId: "cal_1",
			desiredDigest: digest,
			inserted: 0,
			updated: 0,
			deleted: 0,
			unchanged: 0,
		});
		expect(response.status).toBe(200);
	}

	it("queues nothing while the calendar is not connected", async () => {
		const { harness, token } = await setup();
		expect(await claim(harness, token)).toBeNull();
		expect(await jobCount(harness, "google-calendar")).toBe(0);
	});

	it("syncs a calendar never synced at once, then only after a change", async () => {
		const { harness, token } = await setup();
		await connect(harness);
		const first = await claimSync(harness, token);
		expect(await audits(harness, first.runId)).toEqual([
			"scheduler run.sync_google_calendar action=sync reason=changed",
		]);
		const digest = first.desiredDigest;
		if (digest === undefined) throw new Error("a sync lease carries the desired digest");
		await completeSync(harness, token, first, digest);
		// In sync: nothing more, however long the runner polls.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(24 * 60 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobCount(harness, "google-calendar")).toBe(1);
	});

	it("retries a failed step only after the retry interval and never loops on one digest", async () => {
		const { harness, token } = await setup();
		await connect(harness);
		const first = await claimSync(harness, token);
		// A sync that ends without bringing the calendar in line (a runner
		// reporting another digest): the same digest is tried again only
		// after the retry interval, not at every claim.
		await completeSync(harness, token, first, "0".repeat(64));
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(30 * MINUTE);
		const second = await claimSync(harness, token);
		const failed = await harness.runner(token, `/jobs/${second.runId}/complete`, {
			outcome: "failed",
			leaseGeneration: second.leaseGeneration,
			usage: USAGE,
			failureCode: "GOOGLE_REQUEST_FAILED",
			failureUpstreamStatus: 503,
			retryable: false,
		});
		expect(failed.status).toBe(200);
		// The failure is recorded on the link. No page offers Sync now, so the
		// server tries again — after the retry interval, never at every claim.
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(29 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(MINUTE);
		await claimSync(harness, token);
		expect(await jobCount(harness, "google-calendar")).toBe(3);
	});

	it("waits while an earnings sync runs: its dates may change the events", async () => {
		const harness = createHarness({
			serverDataSync: true,
			serverSyncKinds: ["google-calendar", "earnings-refresh"],
		});
		const token = await issueRunnerToken(harness);
		await connect(harness);
		expect(
			(await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "AAPL" })).status,
		).toBe(200);
		const earnings = await claim(harness, token);
		expect(earnings?.kind).toBe("earnings-refresh");
		expect(await jobCount(harness, "google-calendar")).toBe(0);
	});
});

describe("the server fetches the news feeds (ADR-0053 §4)", () => {
	async function setup() {
		const harness = createHarness({ serverDataSync: true, serverSyncKinds: ["news-ingest"] });
		return { harness, token: await issueRunnerToken(harness) };
	}

	async function subscribe(
		harness: Harness,
		sourceId: string,
		feedStatus: NewsSource["feedStatus"] = "active",
	): Promise<void> {
		const at = harness.time.clock.nowIso();
		await createD1Adapters(env.DB).sources.insert(harness.ownerId, {
			sourceId,
			canonicalUrl: `https://example.com/${sourceId}.xml`,
			sourceType: "rss",
			title: sourceId,
			publisher: "Example",
			licensePolicy: "headline-and-link-only",
			trustClassification: "established-media",
			feedStatus,
			lastFetchedAt: null,
			lastErrorCode: null,
			lastErrorUpstreamStatus: null,
			createdAt: at,
			updatedAt: at,
		});
	}

	async function claimIngest(harness: Harness, token: string): Promise<NewsLease> {
		const job = await claim(harness, token);
		if (job?.kind !== "news-ingest") throw new Error(`expected a news ingest, got ${job?.kind}`);
		await advanceToPublishing(harness, token, job);
		return job;
	}

	/** Every leased source fetched now; `failing` ones answered with an error. */
	async function completeIngest(
		harness: Harness,
		token: string,
		lease: NewsLease,
		failing: readonly string[] = [],
	): Promise<void> {
		const fetchedAt = harness.time.clock.nowIso();
		const response = await harness.runner(token, `/jobs/${lease.runId}/complete`, {
			outcome: "ingested",
			leaseGeneration: lease.leaseGeneration,
			usage: { ...USAGE, agentSteps: 0, hasUnmeteredUsage: false },
			articles: [],
			sourceReports: lease.sources.map((source) => ({
				sourceId: source.sourceId,
				fetchedAt,
				errorCode: failing.includes(source.sourceId) ? "TIMEOUT" : null,
				upstreamStatus: null,
			})),
		});
		expect(response.status).toBe(200);
	}

	it("queues nothing without an active source", async () => {
		const { harness, token } = await setup();
		expect(await claim(harness, token)).toBeNull();
		await subscribe(harness, "src_paused", "paused");
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		expect(await jobCount(harness, "news-ingest")).toBe(0);
	});

	it("fetches a new source at once, then every source every 30 minutes", async () => {
		const { harness, token } = await setup();
		await subscribe(harness, "src_a");
		const first = await claimIngest(harness, token);
		expect(first.sources.map((source) => source.sourceId)).toEqual(["src_a"]);
		expect(await audits(harness, first.runId)).toEqual([
			"scheduler run.sync_news reason=new-items",
		]);
		// A failed fetch still stamps its source: no loop on a broken feed.
		await completeIngest(harness, token, first, ["src_a"]);
		harness.time.advance(GAP);
		expect(await claim(harness, token)).toBeNull();
		// A source subscribed later is fetched at once, with the others.
		await subscribe(harness, "src_b");
		harness.time.advance(GAP);
		const second = await claimIngest(harness, token);
		expect(second.sources.map((source) => source.sourceId).sort()).toEqual(["src_a", "src_b"]);
		await completeIngest(harness, token, second);
		harness.time.advance(20 * MINUTE);
		expect(await claim(harness, token)).toBeNull();
		harness.time.advance(10 * MINUTE);
		const third = await claimIngest(harness, token);
		expect(await audits(harness, third.runId)).toEqual(["scheduler run.sync_news reason=stale"]);
	});
});

describe("SERVER_DATA_SYNC=off (ADR-0053)", () => {
	it("queues no stock list, Google Calendar or news job", async () => {
		const harness = createHarness({ serverDataSync: false });
		const token = await issueRunnerToken(harness);
		await createD1Adapters(env.DB).googleCalendar.apply(
			harness.ownerId,
			{ status: "connected", calendarId: "cal_1" },
			harness.time.clock.nowIso(),
		);
		expect(await claim(harness, token)).toBeNull();
		for (const kind of ["stock-directory-refresh", "google-calendar", "news-ingest"]) {
			expect(await jobCount(harness, kind)).toBe(0);
		}
	});
});
