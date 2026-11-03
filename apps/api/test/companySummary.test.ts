import { env } from "cloudflare:test";
import { claimJobResponseSchema, runBudget, stockProfileResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	advanceToPublishing,
	body,
	CLAIM_BODY,
	createHarness,
	type Harness,
	issueRunnerToken,
	USAGE,
} from "./helpers.ts";

/**
 * AI-written company summaries (ADR-0060) on a real local D1 (and on
 * `node:sqlite` through the api-sqlite project): with an AI agent saved in
 * Settings, the claim queues one `company-summary` job for a Watchlist
 * stock, carries the stored facts, and the completion's summary is what
 * the Stocks profile read answers.
 */

const SUMMARY = {
	description: {
		en: "Toyota Motor builds cars, trucks and hybrid vehicles.",
		ja: "トヨタ自動車は乗用車、トラック、ハイブリッド車を製造しています。",
	},
	themes: [
		{ en: "Automobiles", ja: "自動車" },
		{ en: "Hybrid vehicles", ja: "ハイブリッド車" },
	],
};

async function setup(): Promise<{ readonly harness: Harness; readonly token: string }> {
	const harness = createHarness({ companySummaries: true });
	const token = await issueRunnerToken(harness);
	const saved = await harness.call("PUT", "/settings/agent", {
		defaultAgentId: "claude-code",
		models: {},
		effort: "medium",
		budget: runBudget(null),
		webAccess: "public-web",
	});
	expect(saved.status).toBe(200);
	await env.DB.prepare(
		`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
			symbol_key, name_key, local_name_key, search_key)
		VALUES (?, 'JP', '7203', 'TOYOTA MOTOR CORPORATION', 'トヨタ自動車', 'tse-prime', '7203', 'toyota', '', 'toyota')`,
	)
		.bind(harness.ownerId)
		.run();
	const added = await harness.call("POST", "/watchlist/stocks", { market: "JP", symbol: "7203" });
	expect(added.status).toBe(200);
	return { harness, token };
}

describe("company summaries (ADR-0060)", () => {
	it("queues a summary for a Watchlist stock, claims it with the facts and serves the result", async () => {
		const { harness, token } = await setup();
		const claimed = await harness.runner(token, "/jobs/claim", CLAIM_BODY);
		const job = (await body(claimed, claimJobResponseSchema)).job;
		if (job?.kind !== "company-summary") throw new Error(`expected a summary, got ${job?.kind}`);
		expect(job.stockId).toBe("jp:7203");
		expect(job.agent).toEqual({ agentId: "claude-code", model: null, effort: "medium" });
		expect(job.facts).toEqual({
			name: "TOYOTA MOTOR CORPORATION",
			localName: "トヨタ自動車",
			listing: "tse-prime",
			sector: null,
			businessExcerpt: null,
		});

		// Nothing is stored before the completion.
		const before = await body(
			await harness.call("GET", "/stocks/jp:7203"),
			stockProfileResponseSchema,
		);
		expect(before.summary).toBeNull();

		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "company-summarized",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			stockId: "jp:7203",
			summary: SUMMARY,
		});
		expect(completed.status).toBe(200);

		const after = await body(
			await harness.call("GET", "/stocks/jp:7203"),
			stockProfileResponseSchema,
		);
		expect(after.summary).toEqual({
			...SUMMARY,
			agentId: "claude-code",
			model: null,
			generatedAt: harness.time.clock.nowIso(),
		});
	});

	it("refuses a summary for another stock than the one the job was queued for", async () => {
		const { harness, token } = await setup();
		const job = (
			await body(await harness.runner(token, "/jobs/claim", CLAIM_BODY), claimJobResponseSchema)
		).job;
		if (job?.kind !== "company-summary") throw new Error(`expected a summary, got ${job?.kind}`);
		await advanceToPublishing(harness, token, job);
		const completed = await harness.runner(token, `/jobs/${job.runId}/complete`, {
			outcome: "company-summarized",
			leaseGeneration: job.leaseGeneration,
			usage: USAGE,
			stockId: "us:AAPL",
			summary: SUMMARY,
		});
		expect(completed.status).toBe(400);
	});

	it("serves a stored company overview (ADR-0064) beside the summary", async () => {
		const harness = createHarness();
		const overview = {
			entry: {
				feature: {
					en: "Builds cars and trucks.",
					ja: "乗用車・トラックを製造。",
					evidence: [{ source: "S1", quote: "TSE 33-sector: 輸送用機器" }],
				},
				businesses: [],
				segments: [],
				overseasSales: null,
				profile: [],
				themes: [],
			},
			facts: {
				listing: "tse-prime",
				sector: "輸送用機器",
				fiscalYearEnd: "03-31",
				figures: [],
				cites: { listing: null, sector: "S1", figures: null },
			},
			references: [
				{
					id: "S1",
					title: { en: "J-Quants listed issue master", ja: "J-Quants 上場銘柄一覧" },
					publisher: "JPX総研 (J-Quants)",
					asOf: "2026-08-10",
					url: "https://jpx-jquants.com/en/spec/eq-master",
					note: null,
				},
			],
			agentId: "claude-api",
			model: "claude-haiku-5-5",
			generatedAt: "2026-11-03T00:00:00.000Z",
		};
		await env.DB.prepare(
			`INSERT INTO stock_company_summary (owner_id, market, symbol, queued_at, overview_json,
				overview_facts_json, overview_references_json, overview_agent_id, overview_model,
				overview_generated_at)
			VALUES (?, 'JP', '7203', ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				harness.ownerId,
				overview.generatedAt,
				JSON.stringify(overview.entry),
				JSON.stringify(overview.facts),
				JSON.stringify(overview.references),
				overview.agentId,
				overview.model,
				overview.generatedAt,
			)
			.run();
		const profile = await body(
			await harness.call("GET", "/stocks/jp:7203"),
			stockProfileResponseSchema,
		);
		expect(profile.summary).toBeNull();
		expect(profile.overview).toEqual(overview);
	});

	it("queues nothing while no AI agent is chosen in Settings", async () => {
		const harness = createHarness({ companySummaries: true });
		const token = await issueRunnerToken(harness);
		await env.DB.prepare(
			`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
				symbol_key, name_key, local_name_key, search_key)
			VALUES (?, 'JP', '7203', 'TOYOTA MOTOR CORPORATION', 'トヨタ自動車', 'tse-prime', '7203', 'toyota', '', 'toyota')`,
		)
			.bind(harness.ownerId)
			.run();
		await harness.call("POST", "/watchlist/stocks", { market: "JP", symbol: "7203" });
		const job = (
			await body(await harness.runner(token, "/jobs/claim", CLAIM_BODY), claimJobResponseSchema)
		).job;
		expect(job).toBeNull();
	});
});
