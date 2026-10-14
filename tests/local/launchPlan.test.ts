import { describe, expect, it } from "vitest";
import {
	DEFAULT_DEV_API_PORT,
	DEFAULT_DEV_DATA_DIR,
	DEFAULT_DEV_PORT,
	DEFAULT_PREVIOUS_RELEASE_DIR,
	DEFAULT_PROD_DATA_DIR,
	DEFAULT_PROD_PORT,
	describeOverlap,
	type LaunchInputs,
	planLaunch,
	RUNNER_ENV_FILE,
	readLaunchInputs,
} from "../../scripts/launchPlan.ts";

const REPO_ROOT = "/repo";
const BUN = "/bin/bun";

function inputs(overrides: Partial<LaunchInputs> = {}): LaunchInputs {
	return {
		mode: "production",
		repoRoot: REPO_ROOT,
		bunExe: BUN,
		prodPort: DEFAULT_PROD_PORT,
		prodDataDir: DEFAULT_PROD_DATA_DIR,
		devPort: DEFAULT_DEV_PORT,
		devApiPort: DEFAULT_DEV_API_PORT,
		devDataDir: DEFAULT_DEV_DATA_DIR,
		releaseDir: "release",
		previousReleaseDir: DEFAULT_PREVIOUS_RELEASE_DIR,
		runnerEnvFile: RUNNER_ENV_FILE,
		...overrides,
	};
}

describe("readLaunchInputs", () => {
	it("applies the documented defaults", () => {
		const parsed = readLaunchInputs("production", {}, REPO_ROOT, BUN);
		expect(parsed).toEqual({ ok: true, value: inputs() });
	});

	it("lets RESEARCH_PORT and RESEARCH_DATA_DIR override production", () => {
		const parsed = readLaunchInputs(
			"production",
			{ RESEARCH_PORT: "9001", RESEARCH_DATA_DIR: "custom-data" },
			REPO_ROOT,
			BUN,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.prodPort).toBe(9001);
		expect(parsed.value.prodDataDir).toBe("custom-data");
	});

	it("lets RESEARCH_DEV_PORT / RESEARCH_DEV_API_PORT / RESEARCH_DEV_DATA_DIR override development", () => {
		const parsed = readLaunchInputs(
			"development",
			{
				RESEARCH_DEV_PORT: "3100",
				RESEARCH_DEV_API_PORT: "8899",
				RESEARCH_DEV_DATA_DIR: "custom-dev-data",
			},
			REPO_ROOT,
			BUN,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.devPort).toBe(3100);
		expect(parsed.value.devApiPort).toBe(8899);
		expect(parsed.value.devDataDir).toBe("custom-dev-data");
	});

	it("lets RESEARCH_RUNNER_ENV_FILE override the runner env file (finding 5)", () => {
		const parsed = readLaunchInputs(
			"production",
			{ RESEARCH_RUNNER_ENV_FILE: "/tmp/test-runner.env" },
			REPO_ROOT,
			BUN,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.runnerEnvFile).toBe("/tmp/test-runner.env");
		const planned = planLaunch(parsed.value);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const runner = planned.value.processes.find((process) => process.name === "runner");
		expect(runner?.args.join(" ")).toContain("--env-file-if-exists=/tmp/test-runner.env");
	});

	it("rejects a port outside 1024-65535 and names the setting", () => {
		for (const env of [
			{ RESEARCH_PORT: "80" },
			{ RESEARCH_PORT: "not-a-port" },
			{ RESEARCH_DEV_PORT: "99999" },
			{ RESEARCH_DEV_API_PORT: "" },
		]) {
			// An empty value falls back to the default instead of failing.
			if (Object.values(env)[0] === "") continue;
			const parsed = readLaunchInputs("development", env, REPO_ROOT, BUN);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) continue;
			expect(parsed.error.code).toBe("INVALID_PORT");
			expect(parsed.error.message).toContain(Object.keys(env)[0] ?? "");
		}
	});
});

describe("planLaunch: production", () => {
	it("serves only the release, with no watcher and no Vite server", () => {
		const planned = planLaunch(inputs());
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const plan = planned.value;
		expect(plan.mode).toBe("production");
		expect(plan.origin).toBe(`http://localhost:${DEFAULT_PROD_PORT}`);
		expect(plan.apiOrigin).toBe(plan.origin);
		expect(plan.appEnv).toBe("production");
		expect(plan.dataDir).toBe(DEFAULT_PROD_DATA_DIR);
		expect(plan.processes.map((process) => process.name)).toEqual(["server", "runner"]);

		const server = plan.processes[0];
		const serverArgs = server?.args.join(" ") ?? "";
		// The server entry is the prebuilt bundle; nothing under apps/, packages/ or dist/.
		expect(serverArgs).toContain("release/wrangler.jsonc");
		expect(serverArgs).toContain("--no-bundle");
		expect(serverArgs).toContain("APP_ENV:production");
		expect(serverArgs).not.toContain("DEV_ALLOWED_ORIGIN");
		expect(serverArgs).not.toMatch(/apps\/|packages\/|dist\//);
		expect(server?.logFile).toBe("data/logs/server.log");
		// The feed token travels in a URL path: wrangler must not print its
		// per-request info lines into the server log (SEC-005).
		expect(server?.args).toContain("--log-level");
		expect(serverArgs).toContain("--log-level warn");

		const runner = plan.processes[1];
		expect(runner?.args.join(" ")).toContain("release/runner/main.mjs");
		expect(runner?.args.join(" ")).not.toContain("--watch");
		expect(runner?.extraEnv.RESEARCH_API_URL).toBe(plan.origin);
		// FR-019: the refresh-token file lives beside the credential file
		// (mode 0600); the plan names it so dev and prod never share a grant.
		expect(plan.credentialFile).toBe("data/runner-credential.json");
		expect(plan.googleTokenFile).toBe("data/google-token.json");
		expect(runner?.extraEnv.GOOGLE_TOKEN_FILE).toBe("data/google-token.json");
	});

	it("refuses to run against the development data directory", () => {
		for (const prodDataDir of [DEFAULT_DEV_DATA_DIR, "./data-dev"]) {
			const planned = planLaunch(inputs({ prodDataDir }));
			expect(planned.ok).toBe(false);
			if (planned.ok) continue;
			expect(planned.error.code).toBe("DATA_DIR_REFUSED");
			expect(planned.error.message).toContain("development data directory");
			expect(planned.error.message).toContain(prodDataDir);
		}
	});

	it("refuses a parent/child overlap with the other data directory, naming both", () => {
		for (const prodDataDir of ["data-dev/nested", "data-dev/../data-dev"]) {
			const planned = planLaunch(inputs({ prodDataDir }));
			expect(planned.ok).toBe(false);
			if (planned.ok) continue;
			expect(planned.error.code).toBe("DATA_DIR_REFUSED");
			expect(planned.error.message).toContain(prodDataDir);
			expect(planned.error.message).toContain(DEFAULT_DEV_DATA_DIR);
		}
		const wide = planLaunch(inputs({ prodDataDir: ".", devDataDir: "data-dev" }));
		expect(wide.ok).toBe(false);
		if (!wide.ok) {
			expect(wide.error.message).toContain(".");
			expect(wide.error.message).toContain("data-dev");
		}
	});

	it("describeOverlap tells equal, containment and disjoint apart", () => {
		expect(describeOverlap(REPO_ROOT, "data", "data")).toBe("equal");
		expect(describeOverlap(REPO_ROOT, "data", "./data/")).toBe("equal");
		expect(describeOverlap(REPO_ROOT, "data", "data/nested")).toBe("second-inside-first");
		expect(describeOverlap(REPO_ROOT, "data/nested", "data")).toBe("first-inside-second");
		expect(describeOverlap(REPO_ROOT, "data", "data-dev")).toBeNull();
		// A shared prefix is not containment.
		expect(describeOverlap(REPO_ROOT, "data", "database")).toBeNull();
	});

	it("honours RESEARCH_RELEASE_DIR and RESEARCH_PREVIOUS_RELEASE_DIR", () => {
		const parsed = readLaunchInputs(
			"production",
			{ RESEARCH_RELEASE_DIR: "/tmp/rel", RESEARCH_PREVIOUS_RELEASE_DIR: "/tmp/prev" },
			REPO_ROOT,
			BUN,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.releaseDir).toBe("/tmp/rel");
		expect(parsed.value.previousReleaseDir).toBe("/tmp/prev");
	});

	it("honours RESEARCH_PORT and RESEARCH_RELEASE_DIR", () => {
		const planned = planLaunch(inputs({ prodPort: 9001, releaseDir: "custom-release" }));
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.value.origin).toBe("http://localhost:9001");
		expect(planned.value.release?.wranglerConfig).toBe("custom-release/wrangler.jsonc");
		expect(planned.value.migrations.config).toBe("custom-release/wrangler.jsonc");
	});
});

describe("planLaunch: development", () => {
	it("starts Vite, the API, a watching runner build and a Node runner against data-dev/", () => {
		const planned = planLaunch(inputs({ mode: "development" }));
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const plan = planned.value;
		expect(plan.mode).toBe("development");
		expect(plan.origin).toBe(`http://localhost:${DEFAULT_DEV_PORT}`);
		expect(plan.apiOrigin).toBe(`http://localhost:${DEFAULT_DEV_API_PORT}`);
		expect(plan.appEnv).toBe("development");
		expect(plan.dataDir).toBe(DEFAULT_DEV_DATA_DIR);
		expect(plan.release).toBeNull();
		expect(plan.processes.map((process) => process.name)).toEqual([
			"vite",
			"server",
			"runner-build",
			"runner",
		]);

		const vite = plan.processes[0];
		expect(vite?.args).toContain(String(DEFAULT_DEV_PORT));
		expect(vite?.extraEnv.RESEARCH_DEV_API_PORT).toBe(String(DEFAULT_DEV_API_PORT));

		const server = plan.processes[1];
		const serverArgs = server?.args.join(" ") ?? "";
		expect(serverArgs).toContain(`${DEFAULT_DEV_DATA_DIR}/dev.wrangler.jsonc`);
		expect(serverArgs).not.toContain("infra/wrangler.jsonc");
		expect(serverArgs).not.toContain("APP_ENV:development");
		expect(serverArgs).not.toContain("DEV_ALLOWED_ORIGIN");
		expect(serverArgs).not.toContain("--no-bundle");

		// The feed token travels in a URL path: wrangler must not print its
		// per-request info lines into the server log (SEC-005).
		expect(server?.args).toContain("--log-level");
		expect(serverArgs).toContain("--log-level warn");
		// The dev server and migrations run against a generated configuration
		// that never reads dist/: the SPA comes from Vite.
		expect(plan.migrations.config).toBe(`${DEFAULT_DEV_DATA_DIR}/dev.wrangler.jsonc`);
		expect(plan.devWrangler?.file).toBe(`${DEFAULT_DEV_DATA_DIR}/dev.wrangler.jsonc`);
		expect(plan.devWrangler?.webDir).toBe(`${DEFAULT_DEV_DATA_DIR}/web`);
		const devConfig: unknown = JSON.parse(plan.devWrangler?.content ?? "{}");
		expect(devConfig).toMatchObject({
			assets: { directory: `/repo/${DEFAULT_DEV_DATA_DIR}/web` },
			vars: {
				APP_ENV: "development",
				DEV_ALLOWED_ORIGIN: `http://localhost:${DEFAULT_DEV_PORT}`,
			},
		});
		expect(JSON.stringify(devConfig)).not.toContain("dist/");
		expect(JSON.stringify(devConfig)).not.toContain('"env"');

		// The runner bundle lives inside the data directory and runs under
		// Node: Bun's Node compatibility hangs the pinned HTTPS fetcher.
		expect(plan.devRunner).toEqual({
			bunExe: BUN,
			source: "apps/runner/src/main.ts",
			bundle: `${DEFAULT_DEV_DATA_DIR}/runner/main.mjs`,
		});
		const build = plan.processes[2];
		expect(build?.command).toBe(BUN);
		expect(build?.args).toContain("--watch");
		expect(build?.args.join(" ")).toContain(`${DEFAULT_DEV_DATA_DIR}/runner/main.mjs`);

		const runner = plan.processes[3];
		expect(runner?.command).toBe("node");
		expect(runner?.args).toContain("--watch");
		expect(runner?.args).toContain(`${DEFAULT_DEV_DATA_DIR}/runner/main.mjs`);
		expect(runner?.args.join(" ")).not.toContain("apps/runner/src/main.ts");
		expect(runner?.extraEnv.RESEARCH_API_URL).toBe(plan.apiOrigin);
		// FR-019: the dev plan names its own token file inside data-dev/.
		expect(plan.googleTokenFile).toBe(`${DEFAULT_DEV_DATA_DIR}/google-token.json`);
		expect(runner?.extraEnv.GOOGLE_TOKEN_FILE).toBe(`${DEFAULT_DEV_DATA_DIR}/google-token.json`);
	});

	it("refuses to run against the production data directory", () => {
		for (const devDataDir of [DEFAULT_PROD_DATA_DIR, "./data"]) {
			const planned = planLaunch(inputs({ mode: "development", devDataDir }));
			expect(planned.ok).toBe(false);
			if (planned.ok) continue;
			expect(planned.error.code).toBe("DATA_DIR_REFUSED");
			expect(planned.error.message).toContain("production data directory");
			expect(planned.error.message).toContain(devDataDir);
		}
	});

	it("refuses a development directory containing the production one", () => {
		const planned = planLaunch(
			inputs({ mode: "development", devDataDir: ".", prodDataDir: "data" }),
		);
		expect(planned.ok).toBe(false);
		if (planned.ok) return;
		expect(planned.error.code).toBe("DATA_DIR_REFUSED");
		expect(planned.error.message).toContain("data");
	});

	it("uses the dev ports and a throwaway data directory from settings", () => {
		const planned = planLaunch(
			inputs({ mode: "development", devPort: 3100, devApiPort: 8899, devDataDir: "tmp-dev" }),
		);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.value.origin).toBe("http://localhost:3100");
		expect(planned.value.apiOrigin).toBe("http://localhost:8899");
		expect(planned.value.credentialFile).toBe("tmp-dev/runner-credential.json");
		expect(planned.value.listenPorts).toEqual([
			{ port: 3100, envVar: "RESEARCH_DEV_PORT" },
			{ port: 8899, envVar: "RESEARCH_DEV_API_PORT" },
		]);
	});
});
