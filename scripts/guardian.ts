/**
 * Parent-liveness guard (finding 8, task 23b). Killing the launcher with
 * SIGKILL runs no shutdown code, and its children live in their own process
 * groups — Wrangler, Vite and the runner would keep serving and claiming
 * jobs. The launcher therefore starts this guardian alongside its children:
 * it watches the launcher's process id and, when that id disappears, signals
 * the recorded process groups and exits.
 *
 * Usage: `bun scripts/guardian.ts <launcherPid> <pgidFile>`
 * `pgidFile` is a JSON array of process group ids the launcher maintains
 * (one per child it started; a detached child's group id is its pid).
 *
 * Safety (no new dependency, POSIX only):
 * - It signals ONLY the group ids in the file (positive integers, not 0/1,
 *   not its own group, not the launcher's), so it cannot kill anything it
 *   did not start. A group that is already gone is skipped silently.
 * - It is detached into its own group with ignored stdio, so terminal
 *   signals to the launcher's group never reach it; on a clean shutdown the
 *   launcher stops it explicitly, and after it has acted it exits — it is
 *   never orphaned.
 * - The pid-reuse race (a group id recycled between the launcher's death and
 *   the kill) is bounded by acting fast (250 ms poll) and documented in ADR-0011.
 *
 * Limitation: on Windows process groups are not used, so the guardian kills
 * the recorded pids directly and descendants outside them may survive.
 */
import { readFileSync } from "node:fs";

const USE_PROCESS_GROUPS = process.platform !== "win32";
const POLL_MS = 250;
const TERM_WAIT_MS = 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function launcherAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but belongs to another user: alive.
		if (typeof error === "object" && error !== null && "code" in error) {
			return (error as { code?: unknown }).code === "EPERM";
		}
		return false;
	}
}

function groupAlive(id: number): boolean {
	try {
		process.kill(USE_PROCESS_GROUPS ? -id : id, 0);
		return true;
	} catch {
		return false;
	}
}

function signalGroup(id: number, signal: NodeJS.Signals): void {
	try {
		process.kill(USE_PROCESS_GROUPS ? -id : id, signal);
	} catch {
		// Gone already, which is the state being asked for.
	}
}

/** The recorded ids this guardian may signal, verified before any kill. */
function recordedGroups(pgidFile: string): number[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pgidFile, "utf8")) as unknown;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const mine = process.pid;
	const groups: number[] = [];
	for (const entry of parsed.slice(0, 64)) {
		if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 1) continue;
		if (entry === mine) continue;
		if (!groups.includes(entry)) groups.push(entry);
	}
	return groups;
}

async function stopGroups(groups: readonly number[]): Promise<void> {
	for (const id of groups) {
		if (groupAlive(id)) signalGroup(id, "SIGTERM");
	}
	const deadline = Date.now() + TERM_WAIT_MS;
	while (Date.now() < deadline) {
		if (groups.every((id) => !groupAlive(id))) return;
		await sleep(50);
	}
	for (const id of groups) {
		if (groupAlive(id)) signalGroup(id, "SIGKILL");
	}
	while (groups.some((id) => groupAlive(id))) {
		if (Date.now() > deadline + 2_000) break;
		await sleep(50);
	}
}

async function main(): Promise<void> {
	const launcherPid = Number(process.argv[2]);
	const pgidFile = process.argv[3];
	if (!Number.isInteger(launcherPid) || launcherPid <= 1 || typeof pgidFile !== "string") {
		console.error("guardian: usage: guardian.ts <launcherPid> <pgidFile>");
		process.exit(2);
	}
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
	while (launcherAlive(launcherPid)) {
		await sleep(POLL_MS);
	}
	await stopGroups(recordedGroups(pgidFile));
	process.exit(0);
}

await main();
