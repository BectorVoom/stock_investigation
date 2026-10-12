/**
 * OPT-IN live contract check against the real SEC EDGAR endpoints.
 *
 * Skipped unless SEC_LIVE_TEST_USER_AGENT is set to the owner's own descriptive
 * User-Agent with contact details (SEC fair-access policy), e.g.
 *   SEC_LIVE_TEST_USER_AGENT="Jane Doe research jane@example.com" \
 *     node_modules/.bin/vitest run --project node packages/adapters/test/finance/secLive.test.ts
 * It makes about seven requests, spaced by the client's rate limiter, through
 * the production Node SafeFetcher (real DNS validation and pinned TLS). It
 * asserts shapes only, never particular figures, so it does not go stale.
 */
import { describe, expect, it } from "vitest";
import { createSec13FSource } from "../../src/finance/sec13f.ts";
import { createSecClient } from "../../src/finance/secClient.ts";
import { createSecFinancialsSource } from "../../src/finance/secFinancials.ts";
import { createNodeSafeFetcher } from "../../src/node/index.ts";
import { systemClock } from "../../src/runtime/index.ts";

const userAgent = process.env.SEC_LIVE_TEST_USER_AGENT ?? null;

describe.skipIf(userAgent === null)("SEC EDGAR live contract (opt-in)", () => {
	const client = createSecClient({
		fetcher: createNodeSafeFetcher(),
		clock: systemClock,
		userAgent,
	});

	it("returns same-period annual figures for a large Nasdaq issuer", async () => {
		const source = createSecFinancialsSource({ client, nowMs: () => Date.now() });
		const result = await source.latestAnnualFinancials("AAPL");
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}`);
		expect(result.value.issuer.cik).toBe("0000320193");
		expect(result.value.issuer.secExchange?.toLowerCase()).toBe("nasdaq");
		expect(result.value.revenue.ok).toBe(true);
		expect(result.value.netIncome.ok).toBe(true);
		expect(result.value.epsDiluted.ok).toBe(true);
		expect(result.value.netProfitMargin.ok).toBe(true);
	}, 120_000);

	it("returns two 13F-HR quarters for a long-standing filer", async () => {
		const source = createSec13FSource({ client });
		const result = await source.latestHoldings("1067983");
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.detail}`);
		expect(result.value.current.holdings.length).toBeGreaterThan(0);
		expect(result.value.previous).not.toBeNull();
		expect(result.value.changes.length).toBeGreaterThan(0);
		expect(
			result.value.current.reportPeriodEnd > (result.value.previous?.reportPeriodEnd ?? ""),
		).toBe(true);
	}, 120_000);
});
