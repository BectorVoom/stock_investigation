import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { apiErrorBodySchema } from "@research/contracts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * External-service errors keep their status (docs/rule/error_handling.md
 * §4a, ADR-0037) in the real development environment network: the real
 * `bun run dev` launcher, the real API, a real public host. Previewing a feed
 * URL that the host answers with 404 must come back as 404 with
 * `upstreamStatus: 404` beside the stable `FETCH_FAILED` code — before the
 * rule it was 502 and the host's status was lost. No model quota is spent.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8901;
const API_PORT = 8902;
const API_ORIGIN = `http://localhost:${API_PORT}`;
/** A public https URL GitHub answers with 404 (no such user or repository). */
const MISSING_FEED_URL =
	process.env.RESEARCH_REAL_MISSING_FEED_URL ??
	"https://github.com/research-workspace-no-such-account-0037/feed.atom";

let pristine: PristineCopy | null = null;
let dataDir = "";
let extraRoot = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-upstream-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-upstream-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

test("dev answers a real host's 404 as 404 with upstreamStatus, not 502", async () => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const env = launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18997",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env });
	resources.add(async () => {
		await service.stop();
	});
	try {
		const response = await fetch(`${API_ORIGIN}/api/v1/sources/preview`, {
			method: "POST",
			headers: ownerHeaders(API_ORIGIN),
			body: JSON.stringify({ url: MISSING_FEED_URL }),
		});
		const parsed = apiErrorBodySchema.parse(await response.json());
		expect(parsed.error).toMatchObject({
			code: "FETCH_FAILED",
			detail: "HTTP_ERROR",
			upstreamStatus: 404,
		});
		// The response itself answers with the host's own status, unchanged.
		expect(response.status).toBe(404);
	} finally {
		await service.stop();
	}
});
