import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherEnv, makePristineCopy, startLauncher, TestResources } from "../real/helpers.ts";

/**
 * Finding 9 (task 23b): every resource registers its clean-up at the moment
 * it is created, and start helpers stop what they started before rejecting.
 * These tests drive the helpers themselves with a launcher that never
 * becomes ready.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fullEnv(dir: string): Record<string, string> {
	return launcherEnv({
		dataDir: join(dir, "data"),
		devDataDir: join(dir, "data-dev"),
		releaseDir: join(dir, "release"),
		previousDir: join(dir, "release.previous"),
		runnerEnvFile: join(dir, "test-runner.env"),
		scratchRoot: join(dir, "scratch"),
		webOutDir: join(dir, "web-out"),
		prodPort: "18981",
		devPort: "18982",
		devApiPort: "18983",
	});
}

describe("real-environment helpers clean up after themselves (finding 9)", () => {
	it("stops the child before rejecting when readiness never arrives", async () => {
		const dir = mkdtempSync(join(tmpdir(), "research-helpers-hang-"));
		try {
			// `bun run hang.mjs` executes the file directly: the spawned
			// process IS the hanging process, so stopping it leaves nothing.
			writeFileSync(
				join(dir, "hang.mjs"),
				`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "child.pid"))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
			);
			writeFileSync(join(dir, "test-runner.env"), "");
			await expect(
				startLauncher({ cwd: dir, args: ["hang.mjs"], env: fullEnv(dir), readyTimeoutMs: 2_000 }),
			).rejects.toThrow(/did not become ready/);
			const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			let dead = false;
			for (let waited = 0; waited < 10_000; waited += 200) {
				try {
					process.kill(pid, 0);
				} catch {
					dead = true;
					break;
				}
				await sleep(200);
			}
			expect(dead, "the never-ready launcher child was left running").toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects when the launcher exits before becoming ready", async () => {
		const dir = mkdtempSync(join(tmpdir(), "research-helpers-exit-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "exit-test", scripts: { boom: "node -e 'process.exit(3)'" } }),
			);
			writeFileSync(join(dir, "test-runner.env"), "");
			await expect(
				startLauncher({ cwd: dir, args: ["boom"], env: fullEnv(dir), readyTimeoutMs: 20_000 }),
			).rejects.toThrow(/launcher exited with 3/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("runs registered clean-ups LIFO and never skips one after a failure", async () => {
		const order: string[] = [];
		const resources = new TestResources();
		resources.add(() => {
			order.push("first");
		});
		resources.add(() => {
			order.push("second");
			throw new Error("cleanup boom");
		});
		resources.add(() => {
			order.push("third");
		});
		await resources.close();
		expect(order).toEqual(["third", "second", "first"]);
		await resources.close();
	});

	it("leaves no pristine directory behind when archiving fails", () => {
		const before = readdirSync(tmpdir()).filter((name) =>
			name.startsWith("research-real-pristine-"),
		);
		expect(() => makePristineCopy(join(tmpdir(), "research-definitely-not-here-xyz"))).toThrow();
		const after = readdirSync(tmpdir()).filter((name) =>
			name.startsWith("research-real-pristine-"),
		);
		expect(after).toEqual(before);
	});
});
