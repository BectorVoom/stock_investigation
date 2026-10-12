import {
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	type ResearchRequest,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import { carriedOverSettings, createAgentSettingsService } from "../src/agentSettings.ts";
import type {
	AuditEntry,
	AuditLog,
	Clock,
	JobRepository,
	SettingsRepository,
	StoredAgentSettings,
} from "../src/ports.ts";
import { fixedClock, request } from "./support.ts";

function fakes() {
	const time = fixedClock();
	const rows = new Map<string, StoredAgentSettings>();
	const audits: AuditEntry[] = [];
	const settings: SettingsRepository = {
		async getAgentSettings(ownerId) {
			return rows.get(ownerId) ?? null;
		},
		async putAgentSettings(ownerId, next, updatedAt) {
			rows.set(ownerId, { settings: next, updatedAt });
		},
	};
	let latest: ResearchRequest | null = null;
	let latestCalls = 0;
	const jobs: Pick<JobRepository, "findLatestResearchRequest"> = {
		async findLatestResearchRequest() {
			latestCalls += 1;
			return latest;
		},
	};
	const audit: AuditLog = {
		async record(entry) {
			audits.push(entry);
		},
	};
	const clock: Clock = time.clock;
	return {
		time,
		rows,
		audits,
		settings,
		jobs,
		audit,
		clock,
		setLatest(value: ResearchRequest | null) {
			latest = value;
		},
		latestCalls: () => latestCalls,
	};
}

const SAVED: AgentSettings = {
	defaultAgentId: "opencode",
	models: { opencode: "provider/model" },
	effort: "high",
	budget: {
		maxAgentSteps: 6,
		maxToolCalls: 20,
		maxWallClockMs: 600_000,
		maxInputBytes: 400_000,
		maxSpendUsd: 2,
	},
	webAccess: "off",
};

describe("agent settings service (section 10)", () => {
	it("returns the defaults with a null timestamp before anything is stored", async () => {
		const deps = fakes();
		const service = createAgentSettingsService(deps);
		expect(await service.get("owner-1")).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});
	});

	it("carries the most recent research choice over when nothing is stored", async () => {
		const deps = fakes();
		deps.setLatest(
			request({
				agentId: "opencode",
				model: "provider/model",
				effort: "high",
				budget: {
					maxAgentSteps: 4,
					maxToolCalls: 10,
					maxWallClockMs: 300_000,
					maxInputBytes: 200_000,
					maxSpendUsd: 2,
				},
				webAccess: "off",
			}),
		);
		const service = createAgentSettingsService(deps);
		expect(await service.get("owner-1")).toEqual({
			settings: {
				defaultAgentId: "opencode",
				models: { opencode: "provider/model" },
				effort: "high",
				budget: {
					maxAgentSteps: 4,
					maxToolCalls: 10,
					maxWallClockMs: 300_000,
					maxInputBytes: 200_000,
					// A stored or carried-over amount is never consent (AGT-012).
					maxSpendUsd: null,
				},
				// Web access stays the default for the owner to review.
				webAccess: DEFAULT_AGENT_SETTINGS.webAccess,
			},
			updatedAt: null,
			origin: "carried-over",
		});
	});

	it("carries no model entry when the most recent run used the backend default", async () => {
		const deps = fakes();
		deps.setLatest(request({ agentId: "claude-code", model: null }));
		const service = createAgentSettingsService(deps);
		const view = await service.get("owner-1");
		expect(view.origin).toBe("carried-over");
		expect(view.settings.defaultAgentId).toBe("claude-code");
		expect(view.settings.models).toEqual({});
	});

	it("prefers saved settings over any carried-over values", async () => {
		const deps = fakes();
		deps.setLatest(request({ agentId: "opencode", model: "provider/model" }));
		const service = createAgentSettingsService(deps);
		const updated = await service.update("owner-1", SAVED);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.value).toEqual({
			settings: SAVED,
			updatedAt: deps.clock.nowIso(),
			origin: "saved",
		});
		// The carried-over values no longer matter once the owner has saved.
		expect(await service.get("owner-1")).toEqual(updated.value);
		expect(deps.latestCalls()).toBe(0);
	});

	it("queries previous runs only on the nothing-stored path", async () => {
		const deps = fakes();
		const service = createAgentSettingsService(deps);
		await service.get("owner-1");
		expect(deps.latestCalls()).toBe(1);
		await service.update("owner-1", SAVED);
		await service.get("owner-1");
		expect(deps.latestCalls()).toBe(1);
	});

	it("stores the settings, audits the backend and effort only, and returns what was stored", async () => {
		const deps = fakes();
		const service = createAgentSettingsService(deps);
		const updated = await service.update("owner-1", SAVED);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.value).toEqual({
			settings: SAVED,
			updatedAt: deps.clock.nowIso(),
			origin: "saved",
		});
		expect(await service.get("owner-1")).toEqual(updated.value);
		expect(deps.audits).toHaveLength(1);
		expect(deps.audits[0]).toMatchObject({
			ownerId: "owner-1",
			actor: "owner",
			action: "settings.agent.update",
		});
		expect(deps.audits[0]?.detail).toContain("opencode");
		expect(deps.audits[0]?.detail).toContain("high");
		expect(deps.audits[0]?.detail).not.toContain("provider/model");
	});

	it("last write wins", async () => {
		const deps = fakes();
		const service = createAgentSettingsService(deps);
		await service.update("owner-1", SAVED);
		deps.time.advance(1_000);
		const second: AgentSettings = { ...SAVED, effort: "low", defaultAgentId: null };
		const updated = await service.update("owner-1", second);
		expect(updated.ok && updated.value.settings).toEqual(second);
		expect(await service.get("owner-1")).toEqual(updated.ok ? updated.value : null);
	});

	it("isolates owners", async () => {
		const deps = fakes();
		const service = createAgentSettingsService(deps);
		await service.update("owner-1", SAVED);
		expect(await service.get("owner-2")).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});
	});
});

describe("carriedOverSettings", () => {
	it("never carries a spend allowance or web access", () => {
		const carried = carriedOverSettings(
			request({ budget: { ...request().budget, maxSpendUsd: 50 }, webAccess: "public-web" }),
		);
		expect(carried.budget.maxSpendUsd).toBeNull();
		expect(carried.webAccess).toBe(DEFAULT_AGENT_SETTINGS.webAccess);
	});
});
