import { agentsResponseSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { body, CLAIM_BODY, createHarness, issueRunnerToken } from "./helpers.ts";

/**
 * Finding 12 (task 23b): `GET /api/v1/agents` computes `runnerOnline` from
 * the clock, so its ETag must include `runnerOnline` — otherwise a poll with
 * a stale ETag answers 304 forever after the runner stops and Settings keeps
 * saying the runner is online.
 */
describe("agents ETag expires the runner-online flag (finding 12, task 23b)", () => {
	it("answers 200 with runnerOnline false after the window, not 304", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const claimed = await harness.runner(token, "/jobs/claim", CLAIM_BODY);
		expect(claimed.status).toBe(200);

		const first = await harness.call("GET", "/agents");
		expect(first.status).toBe(200);
		const online = await body(first, agentsResponseSchema);
		expect(online.runnerOnline).toBe(true);
		expect(online.runnerLastSeenAt).not.toBeNull();
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();

		// Same last-seen time, clock advanced past the 60 s online window.
		harness.time.advance(61_000);
		const second = await harness.call("GET", "/agents", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(second.status).toBe(200);
		const offline = await body(second, agentsResponseSchema);
		expect(offline.runnerLastSeenAt).toBe(online.runnerLastSeenAt);
		expect(offline.runnerOnline).toBe(false);
	});

	it("still answers 304 when nothing changed within the window", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		await harness.runner(token, "/jobs/claim", CLAIM_BODY);
		const first = await harness.call("GET", "/agents");
		const etag = first.headers.get("ETag");
		expect(etag).not.toBeNull();
		const second = await harness.call("GET", "/agents", undefined, {
			"If-None-Match": etag ?? "",
		});
		expect(second.status).toBe(304);
	});
});
