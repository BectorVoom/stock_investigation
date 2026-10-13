/**
 * OPT-IN live contract check for the FR-018 earnings sources.
 *
 * Skipped unless RUN_LIVE_EARNINGS=1:
 *   RUN_LIVE_EARNINGS=1 [FINNHUB_API_KEY=...] \
 *     node_modules/.bin/vitest run --project node packages/adapters/test/finance/earningsLive.test.ts
 *
 * The JPX leg needs no key (one index fetch plus one workbook per run — JPX
 * asks for low-frequency access, so keep this to a single run). The Finnhub
 * leg needs FINNHUB_API_KEY and is skipped without it (it passed against the
 * real API on 2026-10-13 with the owner's free-plan key). Real DNS
 * validation and pinned TLS are used throughout; assertions are shape and
 * plausibility only — never particular dates, so the test does not go stale.
 */
import { describe, expect, it } from "vitest";
import { createFinnhubEarningsSource } from "../../src/finance/finnhubEarnings.ts";
import { createJpxEarningsSource } from "../../src/finance/jpxEarnings.ts";
import { createNodeSafeBinaryFetcher, createNodeSafeFetcher } from "../../src/node/index.ts";

const enabled = process.env.RUN_LIVE_EARNINGS === "1";
const finnhubApiKey = process.env.FINNHUB_API_KEY ?? null;

function expectPlausibleEvents(
	label: string,
	events: readonly {
		readonly periodKey: string;
		readonly announcementDate: string | null;
		readonly fiscalPeriodLabel: string;
		readonly fiscalPeriodEnd: string | null;
		readonly timing: string;
	}[],
): void {
	for (const event of events) {
		expect(event.periodKey, `${label}: period key shape`).toMatch(/^[a-z0-9-]{1,48}$/);
		if (event.announcementDate !== null) {
			expect(event.announcementDate, `${label}: ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
		expect(event.fiscalPeriodLabel.length, `${label}: label`).toBeGreaterThan(0);
	}
	const dated = events
		.map((event) => event.announcementDate)
		.filter((date): date is string => date !== null);
	expect([...dated].sort(), `${label}: ascending dates`).toEqual(dated);
}

describe.skipIf(!enabled)("earnings live contract (opt-in)", () => {
	const fetcher = createNodeSafeFetcher();
	const binaryFetcher = createNodeSafeBinaryFetcher();
	const signal = new AbortController().signal;

	it("reads the live JPX schedule for a known code", async () => {
		const source = createJpxEarningsSource({
			fetcher,
			binaryFetcher,
			clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
		});
		const today = new Date().toISOString().slice(0, 10);
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "7203", needName: true }],
			fromDate: today,
			toDate: "2027-12-31",
			signal,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toHaveLength(1);
		const [result] = results;
		if (result === undefined || !result.ok) {
			// JPX lists by quarter-end month: outside the published set there is
			// honestly nothing scheduled, which is a valid live answer too.
			expect(result?.error.code).toBe("NO_SCHEDULED_DATE");
			return;
		}
		expectPlausibleEvents("jpx:7203", result.value.events);
	}, 120_000);

	it("reads the live Finnhub calendar when a key is configured", async () => {
		if (finnhubApiKey === null) return;
		const source = createFinnhubEarningsSource({ apiKey: finnhubApiKey, fetcher });
		const today = new Date().toISOString().slice(0, 10);
		const results = await source.fetchEarnings({
			stocks: [{ symbol: "AAPL", needName: true }],
			fromDate: today,
			toDate: "2027-12-31",
			signal,
			beforeRequest: () => Promise.resolve(true),
		});
		expect(results).toHaveLength(1);
		const [result] = results;
		if (result === undefined || !result.ok) {
			expect(["NO_SCHEDULED_DATE", "PLAN_NOT_ENTITLED", "RATE_LIMITED"]).toContain(
				result === undefined ? "missing" : result.error.code,
			);
			return;
		}
		expectPlausibleEvents("finnhub:AAPL", result.value.events);
	}, 120_000);
});
