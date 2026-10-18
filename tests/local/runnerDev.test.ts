import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	fileSignature,
	installFile,
	isRelevantChange,
	parseArgs,
} from "../../scripts/runnerDev.ts";
import { baseChildEnv } from "../../scripts/testEnv.ts";

/**
 * The development Rust runner supervisor (ADR-0030): argument parsing, which
 * changes trigger a build, the atomic install, and — against a fake `cargo`
 * and a fake runner binary — the whole loop: build once, run the child,
 * rebuild on a source change, restart when the binary is replaced from
 * outside, survive the child's exit, and stop the child's process group on
 * SIGTERM. POSIX only (process groups).
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER_DEV = join(REPO_ROOT, "scripts", "runnerDev.ts");

let dir = "";
const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const child of spawned.splice(0)) {
		if (child.pid !== undefined && child.exitCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	if (dir !== "") rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(what: string, probe: () => T | null, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

function read(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("parseArgs", () => {
	const base = [
		"--binary",
		"data-dev/runner/research-runner",
		"--runner-env",
		"apps/runner/.env",
		"--target-dir",
		"target",
		"--build-log",
		"data-dev/logs/runner-build.log",
	];

	it("reads the plan's arguments and applies the documented timings", () => {
		const parsed = parseArgs(base);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.once).toBe(false);
		expect(parsed.value.cargo).toBe("cargo");
		expect(parsed.value.debounceMs).toBe(300);
		expect(parsed.value.restartGraceMs).toBe(8_000);
		expect(parsed.value.shutdownGraceMs).toBeLessThan(8_000);
		expect(parseArgs([...base, "--once"])).toMatchObject({ ok: true, value: { once: true } });
	});

	it("names a missing or unknown argument", () => {
		expect(parseArgs(["--binary", "x"])).toMatchObject({ ok: false });
		expect(parseArgs([...base, "--bogus", "1"])).toMatchObject({ ok: false });
		expect(parseArgs([...base, "--debounce-ms", "-1"])).toMatchObject({ ok: false });
		expect(parseArgs([...base, "--poll-ms"])).toMatchObject({ ok: false });
	});
});

describe("isRelevantChange", () => {
	it("reacts to crate sources and the workspace manifests only", () => {
		expect(isRelevantChange("crates/research-runner/src/main.rs")).toBe(true);
		expect(isRelevantChange("crates/research-js/Cargo.toml")).toBe(true);
		expect(isRelevantChange("Cargo.toml")).toBe(true);
		expect(isRelevantChange("Cargo.lock")).toBe(true);
		expect(isRelevantChange("README.md")).toBe(false);
		expect(isRelevantChange("apps/web/src/main.tsx")).toBe(false);
	});

	it("ignores build output and editor temporaries (a build must not retrigger itself)", () => {
		expect(isRelevantChange("crates/x/target/debug/x")).toBe(false);
		expect(isRelevantChange("crates/x/src/.#main.rs")).toBe(false);
		expect(isRelevantChange("crates/x/src/main.rs~")).toBe(false);
		expect(isRelevantChange("crates/x/src/main.rs.swp")).toBe(false);
		expect(isRelevantChange("crates/x/src/4913")).toBe(false);
		expect(isRelevantChange("")).toBe(false);
	});
});

describe("installFile", () => {
	it("replaces the destination through a rename: new inode, executable, no temp left", () => {
		dir = mkdtempSync(join(tmpdir(), "research-runnerdev-"));
		const source = join(dir, "built");
		const destination = join(dir, "installed");
		writeFileSync(source, "#!/bin/sh\n", { mode: 0o644 });
		writeFileSync(destination, "old", { mode: 0o755 });
		const before = statSync(destination).ino;
		const signatureBefore = fileSignature(destination);
		installFile(source, destination);
		expect(readFileSync(destination, "utf8")).toBe("#!/bin/sh\n");
		expect(statSync(destination).mode & 0o111).not.toBe(0);
		expect(statSync(destination).ino).not.toBe(before);
		// Even identical bytes are a new file, which is what restarts the child.
		expect(fileSignature(destination)).not.toBe(signatureBefore);
		expect(existsSync(`${destination}.tmp-${process.pid}`)).toBe(false);
	});
});

interface Fixture {
	readonly root: string;
	readonly target: string;
	readonly binary: string;
	readonly buildLog: string;
	readonly runnerLog: string;
	readonly cargoLog: string;
	readonly cargo: string;
}

/** A fake repository, a fake `cargo` that "builds" a generation-numbered shell runner. */
function fixture(cargoBody?: string): Fixture {
	dir = mkdtempSync(join(tmpdir(), "research-runnerdev-"));
	const root = join(dir, "repo");
	mkdirSync(join(root, "crates", "demo", "src"), { recursive: true });
	writeFileSync(join(root, "crates", "demo", "src", "lib.rs"), "// v1\n");
	writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
	const target = join(dir, "target");
	const cargoLog = join(dir, "cargo.log");
	const cargo = join(dir, "fake-cargo");
	writeFileSync(
		cargo,
		cargoBody ??
			`#!/bin/sh
{
	echo "args: $*"
	echo "target: $CARGO_TARGET_DIR"
	echo "rustflags: \${RUSTFLAGS:-unset}"
	echo "build_jobs: \${CARGO_BUILD_JOBS:-unset}"
} >> "${cargoLog}"
n=$(cat "$CARGO_TARGET_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
mkdir -p "$CARGO_TARGET_DIR/debug"
echo "$n" > "$CARGO_TARGET_DIR/count"
cat > "$CARGO_TARGET_DIR/debug/research-runner" <<EOF
#!/bin/sh
echo "runner_started generation=$n args=\\$*"
exec sleep 300
EOF
chmod 755 "$CARGO_TARGET_DIR/debug/research-runner"
# The runner package declares the companion binary too (ADR-0030).
printf '#!/bin/sh\\nexec "$@"\\n' > "$CARGO_TARGET_DIR/debug/research-provider-spawn"
chmod 755 "$CARGO_TARGET_DIR/debug/research-provider-spawn"
`,
		{ mode: 0o755 },
	);
	chmodSync(cargo, 0o755);
	return {
		root,
		target,
		binary: join(dir, "data-dev", "runner", "research-runner"),
		buildLog: join(dir, "data-dev", "logs", "runner-build.log"),
		runnerLog: join(dir, "data-dev", "logs", "runner.log"),
		cargoLog,
		cargo,
	};
}

function args(f: Fixture, extra: readonly string[]): string[] {
	return [
		RUNNER_DEV,
		"--binary",
		f.binary,
		"--runner-env",
		join(dir, "test.env"),
		"--target-dir",
		f.target,
		"--build-log",
		f.buildLog,
		"--cargo",
		f.cargo,
		"--root",
		f.root,
		"--debounce-ms",
		"50",
		"--poll-ms",
		"50",
		"--restart-grace-ms",
		"2000",
		"--shutdown-grace-ms",
		"2000",
		...extra,
	];
}

function hostileEnv(): Record<string, string> {
	return {
		...baseChildEnv(),
		// Must not reach Cargo: they could enable test seams or change codegen.
		RUSTFLAGS: "--cfg test_seams",
		CARGO_BUILD_JOBS: "1",
		CARGO_TARGET_DIR: "/hostile/target",
	};
}

describe("runnerDev --once", () => {
	it("runs the locked dev build into the shared target dir and installs the binary", () => {
		if (process.platform === "win32") return;
		const f = fixture();
		const result = spawnSync(process.execPath, args(f, ["--once"]), {
			env: hostileEnv(),
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const log = read(f.cargoLog);
		expect(log).toContain("args: build --locked -p research-runner");
		expect(log).toContain(`target: ${f.target}`);
		expect(log).toContain("rustflags: unset");
		expect(log).toContain("build_jobs: unset");
		expect(statSync(f.binary).mode & 0o111).not.toBe(0);
		expect(read(f.buildLog)).toContain("installed");
	});

	it("exits 1 and installs nothing when the build fails", () => {
		if (process.platform === "win32") return;
		const f = fixture("#!/bin/sh\necho 'error[E0432]: unresolved import' >&2\nexit 101\n");
		const result = spawnSync(process.execPath, args(f, ["--once"]), {
			env: baseChildEnv(),
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("runner-build.log");
		expect(existsSync(f.binary)).toBe(false);
		// Cargo's own output is in the build log, where the owner looks.
		expect(read(f.buildLog)).toContain("unresolved import");
	});

	it("exits 1 when cargo cannot be started", () => {
		if (process.platform === "win32") return;
		const f = fixture();
		const result = spawnSync(process.execPath, args(f, ["--once", "--cargo", "/no/such/cargo"]), {
			env: baseChildEnv(),
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(read(f.buildLog)).toContain("could not start cargo");
	});
});

describe("runnerDev supervising loop", () => {
	function startSupervisor(f: Fixture): ChildProcess {
		mkdirSync(join(f.runnerLog, ".."), { recursive: true });
		const logFd = openSync(f.runnerLog, "a");
		const child = spawn(process.execPath, args(f, []), {
			env: baseChildEnv(),
			// Like the launcher: stdout is runner.log and the group is its own.
			stdio: ["ignore", logFd, logFd],
			detached: true,
		});
		spawned.push(child);
		return child;
	}

	it("builds, runs, rebuilds on a source change, restarts on a replaced binary, survives exits", async () => {
		if (process.platform === "win32") return;
		const f = fixture();
		const supervisor = startSupervisor(f);
		const supervisorPid = supervisor.pid ?? 0;

		// No binary yet: the supervisor builds first, then runs it with the env-file flag.
		await waitFor("the first runner start", () =>
			read(f.runnerLog).includes("runner_started generation=1") ? true : null,
		);
		expect(read(f.runnerLog)).toContain(`args=--env-file-if-exists=${join(dir, "test.env")}`);

		// A source edit rebuilds and restarts.
		writeFileSync(join(f.root, "crates", "demo", "src", "lib.rs"), "// v2\n");
		await waitFor("the rebuilt runner", () =>
			read(f.runnerLog).includes("runner_started generation=2") ? true : null,
		);

		// Noise (a file outside crates/, a build artifact) rebuilds nothing.
		writeFileSync(join(f.root, "README.md"), "x");
		mkdirSync(join(f.root, "crates", "demo", "target"), { recursive: true });
		writeFileSync(join(f.root, "crates", "demo", "target", "out.rs"), "x");
		await sleep(700);
		expect(read(f.runnerLog)).not.toContain("generation=3");

		// A replacement from outside (identical bytes, temp file + rename) restarts too.
		const tmp = `${f.binary}.swap`;
		writeFileSync(tmp, readFileSync(f.binary), { mode: 0o755 });
		renameSync(tmp, f.binary);
		await waitFor("the restart after a replacement", () =>
			read(f.runnerLog).split("runner_started generation=2").length > 2 ? true : null,
		);

		// A crashing runner does not stop the supervisor: it waits for the next change.
		const crashing = `${f.binary}.crash`;
		writeFileSync(
			crashing,
			'#!/bin/sh\nprintf \'{"event":"runner_crashed","error":"Error"}\\n\' >&2\nexit 1\n',
			{ mode: 0o755 },
		);
		renameSync(crashing, f.binary);
		await waitFor("the crash line in runner.log", () =>
			read(f.runnerLog).includes('"event":"runner_crashed"') ? true : null,
		);
		await waitFor("the exit note", () =>
			read(f.buildLog).includes("waiting for the next change") ? true : null,
		);
		expect(supervisor.exitCode).toBeNull();

		// The next source edit rebuilds and starts a working runner again.
		writeFileSync(join(f.root, "crates", "demo", "src", "lib.rs"), "// v3\n");
		await waitFor("the recovery build", () =>
			read(f.runnerLog).includes("runner_started generation=3") ? true : null,
		);

		// SIGTERM stops the child's whole process group and the supervisor exits 0.
		const exited = new Promise<number | null>((resolve) => supervisor.once("exit", resolve));
		process.kill(supervisorPid, "SIGTERM");
		expect(await exited).toBe(0);
		await waitFor("the group to disappear", () => (groupAlive(supervisorPid) ? null : true));
		expect(read(f.buildLog)).toContain("stopping (SIGTERM)");
	}, 60_000);

	it("a failed first build leaves the supervisor waiting for a source change", async () => {
		if (process.platform === "win32") return;
		const f = fixture("#!/bin/sh\nexit 101\n");
		const supervisor = startSupervisor(f);
		await waitFor("the failed build note", () =>
			read(f.buildLog).includes("build failed") ? true : null,
		);
		await sleep(300);
		expect(supervisor.exitCode).toBeNull();
		expect(existsSync(f.binary)).toBe(false);
		process.kill(supervisor.pid ?? 0, "SIGTERM");
		await new Promise<void>((resolve) => supervisor.once("exit", () => resolve()));
	}, 30_000);
});
