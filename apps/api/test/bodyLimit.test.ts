import { MAX_REQUEST_BODY_BYTES, MAX_RUNNER_COMPLETION_BODY_BYTES } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createHarness, errorCode, issueRunnerToken } from "./helpers.ts";

/**
 * Request body limits: 1 MB everywhere, except a runner's job completion,
 * which may carry a full market sync of every tracked series (ADR-0055).
 */

/** A JSON object whose serialised form is `bytes` long. */
function bodyOf(bytes: number): { readonly padding: string } {
	return { padding: "x".repeat(bytes - '{"padding":""}'.length) };
}

describe("request body limits (ADR-0055)", () => {
	it("refuses more than 1 MB on an owner route and on other runner routes", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const large = bodyOf(MAX_REQUEST_BODY_BYTES + 1);
		const owner = await harness.call("POST", "/watchlist/stocks", large);
		expect(owner.status).toBe(413);
		expect(await errorCode(owner)).toBe("PAYLOAD_TOO_LARGE");
		const heartbeat = await harness.runner(token, "/jobs/run_missing/heartbeat", large);
		expect(heartbeat.status).toBe(413);
	});

	it("lets a completion over 1 MB through to validation, and refuses one over its own limit", async () => {
		const harness = createHarness();
		const token = await issueRunnerToken(harness);
		const overGeneral = await harness.runner(
			token,
			"/jobs/run_missing/complete",
			bodyOf(MAX_REQUEST_BODY_BYTES * 2),
		);
		expect(overGeneral.status).toBe(400);
		expect(await errorCode(overGeneral)).toBe("VALIDATION_FAILED");
		const overCompletion = await harness.runner(
			token,
			"/jobs/run_missing/complete",
			bodyOf(MAX_RUNNER_COMPLETION_BODY_BYTES + 1),
		);
		expect(overCompletion.status).toBe(413);
		expect(await errorCode(overCompletion)).toBe("PAYLOAD_TOO_LARGE");
	});
});
