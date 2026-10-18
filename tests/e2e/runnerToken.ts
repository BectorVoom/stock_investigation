/**
 * What both E2E runner harnesses share: the optional second-runner owner and
 * the runner credential the harness issues for itself.
 */
import { CSRF_HEADER, CSRF_HEADER_VALUE, issuedRunnerCredentialSchema } from "@research/contracts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Optional second-runner owner (`notebook.spec.ts`): when set, every API
 * call of this harness carries `X-E2E-Owner`, so its credential, agent
 * report and claimed jobs all belong to that owner — isolated from the
 * default owner's suite state. Unset: the harness behaves exactly as before.
 */
export const RUNNER_OWNER =
	process.env.E2E_RUNNER_OWNER === undefined || process.env.E2E_RUNNER_OWNER === ""
		? null
		: process.env.E2E_RUNNER_OWNER;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The harness `fetch`, routing to the runner owner when one is configured. */
export const runnerFetch: typeof fetch = (input, init) => {
	if (RUNNER_OWNER === null) return fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set("X-E2E-Owner", RUNNER_OWNER);
	return fetch(input, { ...init, headers });
};

export async function issueToken(): Promise<string> {
	// The last refusal, so a Worker that answers but refuses is told apart from one that never starts.
	let lastRefusal = "no response";
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await runnerFetch(`${E2E_ORIGIN}/api/v1/runner-credentials`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: E2E_ORIGIN,
					[CSRF_HEADER]: CSRF_HEADER_VALUE,
				},
				body: JSON.stringify({ label: `e2e runner ${Date.now()}`, expiresInDays: 1 }),
			});
			if (response.ok) return issuedRunnerCredentialSchema.parse(await response.json()).token;
			lastRefusal = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
		} catch {
			// The Worker is still starting; try again shortly.
		}
		await sleep(500);
	}
	throw new Error(`E2E Worker did not issue a runner credential (last: ${lastRefusal})`);
}
