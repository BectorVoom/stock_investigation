import { env } from "cloudflare:test";
import {
	agentSettingsResponseSchema,
	agentSettingsSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	DEFAULT_AGENT_SETTINGS,
	researchRunResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	body,
	createHarness,
	createWorkspace,
	errorCode,
	idempotencyKey,
	researchRequest,
} from "./helpers.ts";

const SAVED = {
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
} as const;

async function auditRows(ownerId: string) {
	const result = await env.DB.prepare(
		"SELECT action, detail FROM audit_log WHERE owner_id = ? AND action = ?",
	)
		.bind(ownerId, "settings.agent.update")
		.all<{ action: string; detail: string }>();
	return result.results;
}

/** Queues one research run with the given request overrides and returns its run id. */
async function queueResearchRun(
	harness: ReturnType<typeof createHarness>,
	overrides: Parameters<typeof researchRequest>[1] = {},
): Promise<string> {
	const workspaceId = await createWorkspace(harness);
	const response = await harness.call(
		"POST",
		"/research-runs",
		researchRequest(workspaceId, overrides),
		idempotencyKey(),
	);
	expect(response.status).toBe(202);
	return (await body(response, researchRunResponseSchema)).run.runId;
}

describe("agent settings (section 10)", () => {
	it("returns the defaults with a null timestamp before any save", async () => {
		const harness = createHarness();
		const response = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(response).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});
	});

	it("carries the most recent research choice over when nothing is saved", async () => {
		const harness = createHarness();
		await queueResearchRun(harness, {
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
		});
		const response = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(response).toEqual({
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

	it("carries the newest research run and skips runs without a request", async () => {
		const harness = createHarness();
		await queueResearchRun(harness, { agentId: "claude-code", model: null });
		// A news-ingest job is newer but carries no backend choice and must not hide the run.
		const ingest = await harness.call("POST", "/sources/refresh", undefined, idempotencyKey());
		expect(ingest.status).toBe(202);
		const response = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(response.origin).toBe("carried-over");
		expect(response.settings.defaultAgentId).toBe("claude-code");
		expect(response.settings.models).toEqual({});
	});

	it("prefers a save over any carried-over values", async () => {
		const harness = createHarness();
		await queueResearchRun(harness, { agentId: "opencode", model: "provider/model" });
		const saved = await body(
			await harness.call("PUT", "/settings/agent", SAVED),
			agentSettingsResponseSchema,
		);
		expect(saved.origin).toBe("saved");
		const fetched = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(fetched).toEqual(saved);
		expect(fetched.settings.defaultAgentId).toBe("opencode");
	});

	it("returns a save on the next GET", async () => {
		const harness = createHarness();
		const saved = await body(
			await harness.call("PUT", "/settings/agent", SAVED),
			agentSettingsResponseSchema,
		);
		expect(agentSettingsSchema.safeParse(saved.settings).success).toBe(true);
		expect(saved.settings).toEqual(SAVED);
		expect(saved.updatedAt).toBe(harness.time.clock.nowIso());
		expect(saved.origin).toBe("saved");

		const fetched = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(fetched).toEqual(saved);
	});

	it("isolates owners, including carried-over choices", async () => {
		const alice = createHarness();
		const bob = createHarness();
		expect((await alice.call("PUT", "/settings/agent", SAVED)).status).toBe(200);
		const other = await body(await bob.call("GET", "/settings/agent"), agentSettingsResponseSchema);
		expect(other).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});

		await queueResearchRun(alice, { agentId: "opencode", model: "provider/model" });
		const stillDefaults = await body(
			await bob.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(stillDefaults.origin).toBe("defaults");
	});

	it("rejects an invalid body and stores nothing", async () => {
		const harness = createHarness();
		const response = await harness.call("PUT", "/settings/agent", {
			...SAVED,
			budget: { ...SAVED.budget, maxAgentSteps: 99 },
		});
		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		const fetched = await body(
			await harness.call("GET", "/settings/agent"),
			agentSettingsResponseSchema,
		);
		expect(fetched).toEqual({
			settings: DEFAULT_AGENT_SETTINGS,
			updatedAt: null,
			origin: "defaults",
		});
		expect(await auditRows(harness.ownerId)).toHaveLength(0);
	});

	it("rejects a write without the CSRF header", async () => {
		const harness = createHarness();
		const response = await harness.raw("PUT", "/settings/agent", {
			body: SAVED,
			headers: { Origin: "http://localhost" },
		});
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("CSRF_REJECTED");
	});

	it("writes an audit row without model names", async () => {
		const harness = createHarness();
		expect((await harness.call("PUT", "/settings/agent", SAVED)).status).toBe(200);
		const rows = await auditRows(harness.ownerId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("settings.agent.update");
		expect(rows[0]?.detail).toContain("opencode");
		expect(rows[0]?.detail).toContain("high");
		expect(rows[0]?.detail).not.toContain("provider/model");
	});

	it("requires authentication", async () => {
		const harness = createHarness();
		const response = await harness.raw("GET", "/settings/agent", {
			headers: {
				"X-Test-Anonymous": "1",
				Origin: "http://localhost",
				[CSRF_HEADER]: CSRF_HEADER_VALUE,
			},
		});
		expect(response.status).toBe(401);
	});
});
