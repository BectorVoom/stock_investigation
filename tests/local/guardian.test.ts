import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { baseChildEnv } from "../../scripts/testEnv.ts";

/**
 * Finding 8 (task 23b): killing the launcher with SIGKILL must not leave its
 * services running. The guardian watches the launcher pid and, when it
 * disappears, signals the recorded process groups and exits — and it must
 * not kill anything it did not start.
 *
 * This test exercises the real `scripts/guardian.ts` against stub processes
 * (one TCP server on a test port standing in for Wrangler/Vite, one sleeper
 * standing in for the runner): SIGKILL the stub launcher, assert the port is
 * free and no recorded child remains within seconds, the unrecorded sleeper
 * survives, and the guardian itself exits. POSIX only: process groups are
 * not used on Windows (see the limitation noted in ADR-0011).
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUARDIAN = join(REPO_ROOT, "scripts", "guardian.ts");

let dir = "";

afterEach(() => {
	if (dir !== "") rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function portFree(port: number): Promise<boolean> {
	const { connect } = await import("node:net");
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(true));
	});
}

describe("parent-liveness guardian (finding 8, task 23b)", () => {
	it("stops the recorded groups when the launcher is SIGKILLed, spares the rest", async () => {
		if (process.platform === "win32") return;
		dir = mkdtempSync(join(tmpdir(), "research-guardian-"));
		const port = 18971;
		const pgidFile = join(dir, "groups.json");

		const server = spawn(
			process.execPath,
			[
				"-e",
				`require("http").createServer((_, res) => res.end("ok")).listen(${port}, "127.0.0.1");setInterval(()=>{},1000);`,
			],
			{ detached: true, stdio: "ignore", env: baseChildEnv() },
		);
		const runner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], {
			detached: true,
			stdio: "ignore",
			env: baseChildEnv(),
		});
		// Started by someone else: must survive the guardian.
		const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], {
			detached: true,
			stdio: "ignore",
			env: baseChildEnv(),
		});
		if (server.pid === undefined || runner.pid === undefined || bystander.pid === undefined) {
			throw new Error("could not spawn stub processes");
		}
		// A detached child's group id is its pid.
		writeFileSync(pgidFile, JSON.stringify([server.pid, runner.pid]));
		const stub = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], {
			stdio: "ignore",
			env: baseChildEnv(),
		});
		if (stub.pid === undefined) throw new Error("could not spawn stub launcher");
		const guardian = spawn("bun", [GUARDIAN, String(stub.pid), pgidFile], {
			detached: true,
			stdio: "ignore",
			env: baseChildEnv(),
		});
		guardian.unref();
		try {
			// The server child is actually listening.
			let listening = false;
			for (let waited = 0; waited < 10_000; waited += 200) {
				if (!(await portFree(port))) {
					listening = true;
					break;
				}
				await sleep(200);
			}
			expect(listening, "the stub server never started listening").toBe(true);

			stub.kill("SIGKILL");
			// Within a few seconds: the port is free, no recorded child
			// remains, the guardian exited, and the bystander survives.
			const deadline = Date.now() + 15_000;
			let done = false;
			let guardianGone = false;
			while (Date.now() < deadline) {
				const free = await portFree(port);
				const serverGone = !groupAlive(server.pid);
				const runnerGone = !groupAlive(runner.pid);
				try {
					process.kill(guardian.pid ?? -1, 0);
				} catch {
					guardianGone = true;
				}
				if (free && serverGone && runnerGone && guardianGone) {
					done = true;
					break;
				}
				await sleep(200);
			}
			expect(done, "the guardian did not stop the recorded groups in time").toBe(true);
			expect(groupAlive(bystander.pid), "the guardian killed a group it did not start").toBe(true);
		} finally {
			for (const child of [server, runner, bystander]) {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// Already gone, which is the state being asked for.
				}
			}
			try {
				if (guardian.pid !== undefined) process.kill(guardian.pid, "SIGKILL");
			} catch {
				// Already exited.
			}
		}
	}, 30_000);

	it("refuses to run without a launcher pid and a group file", () => {
		if (process.platform === "win32") return;
		const bad = spawnSync("bun", [GUARDIAN], { encoding: "utf8", env: baseChildEnv() });
		expect(bad.status).toBe(2);
	}, 30_000);
});
