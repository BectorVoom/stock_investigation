import { env } from "cloudflare:test";
import {
	homeDashboardResponseSchema,
	homeDashboardSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import { expect, it } from "vitest";
import { body, createHarness } from "./helpers.ts";

it("initializes Home in the database without changing the first-save version", async () => {
	const harness = createHarness();
	const initial = await body(
		await harness.call("GET", "/home/dashboard"),
		homeDashboardResponseSchema,
	);
	expect(initial.version).toBe(0);
	expect(initial.origin).toBe("defaults");
	expect(initial.updatedAt).toBeNull();
	const stored = await env.DB.prepare(
		"SELECT dashboard_json, version FROM home_dashboards WHERE owner_id = ?",
	)
		.bind(harness.ownerId)
		.first();
	expect(stored?.version).toBe(0);
	const raw = stored?.dashboard_json;
	if (typeof raw !== "string") throw new Error("missing stored dashboard");
	expect(homeDashboardSchema.parse(JSON.parse(raw))).toEqual(initial.dashboard);
	const saved = await body(
		await harness.call("PUT", "/home/dashboard", {
			expectedVersion: 0,
			dashboard: { schemaVersion: 2, widgets: [] },
		}),
		homeDashboardResponseSchema,
	);
	expect(saved.version).toBe(1);
	expect(saved.origin).toBe("saved");
	expect(
		(await body(await harness.call("GET", "/home/dashboard"), homeDashboardResponseSchema))
			.dashboard.widgets,
	).toEqual([]);
});

it("reads earnings attribution from the database instead of provider constants", async () => {
	const harness = createHarness();
	await env.DB.prepare(
		"UPDATE earnings_sources SET publisher = ?, source_url = ? WHERE market = 'US'",
	)
		.bind("Stored publisher", "https://example.com/stored-earnings")
		.run();
	try {
		const result = await body(
			await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "AAPL" }),
			watchlistResponseSchema,
		);
		expect(result.stocks[0]?.publisher).toBe("Stored publisher");
		expect(result.stocks[0]?.sourceUrl).toBe("https://example.com/stored-earnings");
	} finally {
		await env.DB.prepare(
			"UPDATE earnings_sources SET publisher = 'Finnhub', source_url = 'https://finnhub.io/' WHERE market = 'US'",
		).run();
	}
});

it("reports missing persisted source metadata as an actionable typed failure", async () => {
	const harness = createHarness();
	const added = await harness.call("POST", "/watchlist/stocks", { market: "US", symbol: "AAPL" });
	expect(added.ok).toBe(true);
	await env.DB.prepare("DELETE FROM earnings_sources WHERE market = 'US'").run();
	try {
		const response = await harness.call("GET", "/watchlist");
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { code: "INTERNAL", message: "Stored earnings source metadata is missing." },
		});
	} finally {
		await env.DB.prepare(
			"INSERT INTO earnings_sources VALUES ('US', 'finnhub', 'Finnhub', 'https://finnhub.io/')",
		).run();
	}
});
