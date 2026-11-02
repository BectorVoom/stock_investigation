import type { JobKind } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createSyncCheckGate } from "../src/dataSync.ts";
import {
	createJobRetentionService,
	PRUNED_SYNC_JOB_KINDS,
	SYNC_JOB_RETENTION_BATCH,
	SYNC_JOB_RETENTION_PERIOD_MS,
} from "../src/jobRetention.ts";

const AT = "2026-11-02T00:00:00.000Z";

describe("sync job retention (ADR-0058 §3)", () => {
	function setup(deleted: number, enabled = true) {
		const calls: { kinds: readonly JobKind[]; before: string; limit: number }[] = [];
		const audits: { action: string; detail: string }[] = [];
		let nowMs = Date.parse(AT);
		const service = createJobRetentionService({
			retention: {
				pruneTerminalJobs: async (_owner, kinds, before, limit) => {
					calls.push({ kinds, before, limit });
					return deleted;
				},
			},
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			audit: {
				record: async (entry) => {
					audits.push({ action: entry.action, detail: entry.detail });
				},
			},
			gate: createSyncCheckGate(SYNC_JOB_RETENTION_PERIOD_MS),
			enabled,
		});
		return {
			service,
			calls,
			audits,
			advance: (ms: number) => {
				nowMs += ms;
			},
		};
	}

	it("deletes one batch of the sync kinds' jobs older than 7 days, and audits it", async () => {
		const run = setup(3);
		expect(await run.service.pruneDue("owner")).toBe(3);
		expect(run.calls).toEqual([
			{
				kinds: PRUNED_SYNC_JOB_KINDS,
				before: "2026-10-26T00:00:00.000Z",
				limit: SYNC_JOB_RETENTION_BATCH,
			},
		]);
		expect(run.audits).toEqual([
			{ action: "run.prune_sync_jobs", detail: "count=3 before=2026-10-26T00:00:00.000Z" },
		]);
	});

	it("never prunes research or notebook runs", () => {
		const kinds: readonly JobKind[] = PRUNED_SYNC_JOB_KINDS;
		expect(kinds).not.toContain("research");
		expect(kinds).not.toContain("notebook-assist");
		expect([...kinds].sort()).toEqual([
			"company-summary",
			"earnings-refresh",
			"financial-sync",
			"google-calendar",
			"market-refresh",
			"news-ingest",
			"stock-directory-refresh",
			"stock-prices-sync",
		]);
	});

	it("runs at most once an hour per owner and audits nothing when nothing went", async () => {
		const run = setup(0);
		await run.service.pruneDue("owner");
		run.advance(SYNC_JOB_RETENTION_PERIOD_MS - 1);
		expect(await run.service.pruneDue("owner")).toBe(0);
		expect(run.calls).toHaveLength(1);
		run.advance(1);
		await run.service.pruneDue("owner");
		expect(run.calls).toHaveLength(2);
		expect(run.audits).toEqual([]);
	});

	it("does nothing while switched off", async () => {
		const run = setup(5, false);
		expect(await run.service.pruneDue("owner")).toBe(0);
		expect(run.calls).toEqual([]);
	});
});
