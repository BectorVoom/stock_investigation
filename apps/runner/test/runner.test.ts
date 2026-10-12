import { describe, expect, it } from "vitest";
import { createHttpRunnerApi } from "../src/apiClient.ts";
import { loadConfig } from "../src/config.ts";
import { runRunnerLoop } from "../src/runner.ts";
import { apiFailure, createDeps, createFakeApi, RESEARCH_JOB } from "./support.ts";

describe("runner polling loop (section 5.1)", () => {
	function loop(api: ReturnType<typeof createFakeApi>["api"], stopAfterSleeps: number) {
		const shutdown = new AbortController();
		const harness = createDeps(api);
		const sleeps: number[] = [];
		const run = runRunnerLoop(
			{
				...harness.deps,
				sleep: async (ms) => {
					sleeps.push(ms);
					if (sleeps.length >= stopAfterSleeps) shutdown.abort();
				},
			},
			shutdown.signal,
		);
		return { run, sleeps, harness };
	}

	it("follows the server's poll hint when idle and never polls faster", async () => {
		const { api, calls } = createFakeApi({
			claim: [{ ok: true, value: { job: null, pollAfterMs: 15_000 } }],
		});
		const { run, sleeps } = loop(api, 3);
		expect(await run).toBe("shutdown");
		expect(sleeps).toEqual([15_000, 15_000, 15_000]);
		expect(calls.claim).toBe(3);
	});

	it("caps an excessive poll hint", async () => {
		const { api } = createFakeApi({
			claim: [{ ok: true, value: { job: null, pollAfterMs: 86_400_000 } }],
		});
		const { run, sleeps } = loop(api, 1);
		await run;
		expect(sleeps).toEqual([60_000]);
	});

	it("backs off exponentially on errors and recovers", async () => {
		const { api } = createFakeApi({
			claim: [
				apiFailure("TRANSPORT_ERROR", true),
				apiFailure("TRANSPORT_ERROR", true),
				apiFailure("HTTP_503", true),
				{ ok: true, value: { job: null, pollAfterMs: 15_000 } },
			],
		});
		const { run, sleeps } = loop(api, 5);
		await run;
		expect(sleeps).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
	});

	it("stops instead of retrying when its credential is rejected", async () => {
		const { api, calls } = createFakeApi({ claim: [apiFailure("UNAUTHENTICATED")] });
		const { run, sleeps } = loop(api, 99);
		expect(await run).toBe("unauthenticated");
		expect(calls.claim).toBe(1);
		expect(sleeps).toEqual([]);
	});

	it("executes a claimed job and immediately polls again", async () => {
		const { api, calls } = createFakeApi({
			claim: [
				{ ok: true, value: { job: RESEARCH_JOB, pollAfterMs: 2_000 } },
				{ ok: true, value: { job: null, pollAfterMs: 15_000 } },
			],
		});
		const { run, sleeps } = loop(api, 1);
		await run;
		expect(calls.completions).toHaveLength(1);
		expect(sleeps).toEqual([15_000]);
	});
});

describe("runner API client (API-007)", () => {
	const options = (fetchImpl: typeof fetch, sleeps: number[] = []) => ({
		apiUrl: "https://research.example.test",
		runnerToken: `rk_${"a".repeat(64)}`,
		accessClientId: null,
		accessClientSecret: null,
		fetch: fetchImpl,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
	});
	const json = (status: number, payload: unknown) =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});

	it("sends the bearer token only to the configured origin and refuses redirects", async () => {
		const seen: { url: string; init: RequestInit | undefined }[] = [];
		const api = createHttpRunnerApi(
			options(async (input, init) => {
				seen.push({ url: String(input), init });
				return json(200, { job: null, pollAfterMs: 15_000 });
			}),
		);
		const result = await api.claim({ runnerVersion: "t", agents: [] });
		expect(result.ok).toBe(true);
		expect(seen[0]?.url).toBe("https://research.example.test/api/v1/runner/jobs/claim");
		expect(seen[0]?.init?.redirect).toBe("error");
		expect(new Headers(seen[0]?.init?.headers).get("Authorization")).toBe(
			`Bearer rk_${"a".repeat(64)}`,
		);
		expect(new Headers(seen[0]?.init?.headers).has("CF-Access-Client-Id")).toBe(false);
	});

	it("retries transport errors, 429 and 5xx with backoff, up to a bound", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const api = createHttpRunnerApi(
			options(async () => {
				attempts += 1;
				if (attempts === 1) throw new TypeError("fetch failed");
				if (attempts === 2) return json(503, { error: { code: "INTERNAL", message: "x" } });
				if (attempts === 3) return json(429, { error: { code: "RATE_LIMITED", message: "x" } });
				return json(200, { leaseExpiresAt: "2026-10-11T00:03:00.000Z", cancelRequested: false });
			}, sleeps),
		);
		const result = await api.heartbeat("run_x", 1);
		expect(result.ok).toBe(true);
		expect(attempts).toBe(4);
		expect(sleeps).toEqual([500, 1_000, 2_000]);

		attempts = 0;
		const alwaysDown = createHttpRunnerApi(
			options(async () => {
				attempts += 1;
				return json(503, { error: { code: "INTERNAL", message: "x" } });
			}),
		);
		expect(await alwaysDown.heartbeat("run_x", 1)).toMatchObject({
			ok: false,
			error: { code: "INTERNAL", transient: true },
		});
		expect(attempts).toBe(4);
	});

	it("does not retry a definitive rejection and surfaces its stable code", async () => {
		let attempts = 0;
		const api = createHttpRunnerApi(
			options(async () => {
				attempts += 1;
				return json(409, { error: { code: "STALE_LEASE", message: "x", detail: "STALE_LEASE" } });
			}),
		);
		expect(await api.heartbeat("run_x", 1)).toEqual({
			ok: false,
			error: { code: "STALE_LEASE", detail: "STALE_LEASE", transient: false },
		});
		expect(attempts).toBe(1);
	});

	it("rejects a success response that violates the contract", async () => {
		const api = createHttpRunnerApi(options(async () => json(200, { job: { kind: "exec" } })));
		expect(await api.claim({ runnerVersion: "t", agents: [] })).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE", transient: false },
		});
	});
});

describe("runner configuration", () => {
	const valid = {
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: `rk_${"a".repeat(64)}`,
	};

	it("accepts https and loopback http only", () => {
		expect(loadConfig(valid).ok).toBe(true);
		expect(loadConfig({ ...valid, RESEARCH_API_URL: "http://localhost:8787" }).ok).toBe(true);
		for (const url of [
			"http://research.example.test",
			"ftp://x.test",
			"",
			"http://localhost.evil.test",
		]) {
			expect(loadConfig({ ...valid, RESEARCH_API_URL: url }).ok, url).toBe(false);
		}
	});

	it("defaults to refusing unverified tool isolation and disabling SEC tools", () => {
		const config = loadConfig(valid);
		if (!config.ok) throw new Error("expected valid config");
		expect(config.value.allowUnverifiedToolIsolation).toBe(false);
		expect(config.value.secUserAgent).toBeNull();
		const optedIn = loadConfig({ ...valid, ALLOW_UNVERIFIED_TOOL_ISOLATION: "1" });
		expect(optedIn.ok && optedIn.value.allowUnverifiedToolIsolation).toBe(true);
		// Only the exact value "1" opts in.
		const notQuite = loadConfig({ ...valid, ALLOW_UNVERIFIED_TOOL_ISOLATION: "true" });
		expect(notQuite.ok && notQuite.value.allowUnverifiedToolIsolation).toBe(false);
	});

	it("reports problems without echoing secret values", () => {
		const secret = "super-secret-but-malformed token!";
		const result = loadConfig({ RESEARCH_API_URL: "https://x.test", RUNNER_TOKEN: secret });
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("super-secret");
	});

	it("leaves the pages directory unset by default and accepts an explicit one", () => {
		const config = loadConfig(valid);
		if (!config.ok) throw new Error("expected valid config");
		expect(config.value.pagesDirectory).toBeNull();
		const withPages = loadConfig({ ...valid, RUNNER_PAGES_DIR: "data/pages" });
		if (!withPages.ok) throw new Error("expected valid config");
		expect(withPages.value.pagesDirectory).toBe("data/pages");
		// A blank value is the same as unset: web page retrieval stays disabled.
		const blank = loadConfig({ ...valid, RUNNER_PAGES_DIR: "   " });
		if (!blank.ok) throw new Error("expected valid config");
		expect(blank.value.pagesDirectory).toBeNull();
	});
});
