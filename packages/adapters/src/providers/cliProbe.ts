import type { AgentAvailability } from "@research/contracts";
import { isCommandNotFound, type ProcessRunner } from "./processRunner.ts";
import { settle } from "./turn.ts";

/** Probes are local status commands; one that takes longer than this is treated as broken. */
const PROBE_TIMEOUT_MS = 15_000;
/** Output budget of a status command; a catalog command may pass a larger one. */
const PROBE_MAX_OUTPUT_CHARS = 262_144;

export type CaptureOutcome =
	| {
			readonly kind: "exited";
			readonly code: number | null;
			readonly stdout: string;
			readonly stderrTail: string;
	  }
	| { readonly kind: "not-installed" }
	| { readonly kind: "timed-out" }
	| { readonly kind: "failed" };

export interface CaptureSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export interface CaptureOptions {
	/** Complete stdout lines are kept up to this many characters; later lines are dropped. */
	readonly maxOutputChars?: number;
}

/** Runs a short status command to completion and returns its bounded output. */
export async function captureCommand(
	processRunner: ProcessRunner,
	spec: CaptureSpec,
	options: CaptureOptions = {},
): Promise<CaptureOutcome> {
	const maxOutputChars = options.maxOutputChars ?? PROBE_MAX_OUTPUT_CHARS;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<"timed-out">((resolve) => {
		timer = setTimeout(() => resolve("timed-out"), PROBE_TIMEOUT_MS);
	});
	try {
		const handle = processRunner.run({ ...spec, stdin: "", signal: controller.signal });
		const stdoutLines: string[] = [];
		let capturedChars = 0;
		const drained = settle(
			(async () => {
				for await (const line of handle.stdoutLines) {
					capturedChars += line.length + 1;
					if (capturedChars > maxOutputChars) break;
					stdoutLines.push(line);
				}
			})(),
		);
		const finished = settle(handle.exit).then(async (exit) => ({ exit, drained: await drained }));
		const outcome = await Promise.race([finished, timedOut]);
		if (outcome === "timed-out") return { kind: "timed-out" };
		if (!outcome.exit.ok) {
			return { kind: isCommandNotFound(outcome.exit.error) ? "not-installed" : "failed" };
		}
		if (!outcome.drained.ok) return { kind: "failed" };
		return {
			kind: "exited",
			code: outcome.exit.value.code,
			stdout: stdoutLines.join("\n"),
			stderrTail: outcome.exit.value.stderrTail,
		};
	} catch (error) {
		return { kind: isCommandNotFound(error) ? "not-installed" : "failed" };
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

export type Version = readonly [major: number, minor: number, patch: number];

export function parseVersion(text: string): Version | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	if (match === null) return null;
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return [major, minor, patch];
}

/** Negative when `left` is older than `right`, zero when equal, positive when newer. */
export function compareVersions(left: Version, right: Version): number {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function formatVersion(version: Version): string {
	return version.join(".");
}

export function unavailable(
	reasonCode: Extract<AgentAvailability, { status: "unavailable" }>["reasonCode"],
	detail: string,
): AgentAvailability {
	return { status: "unavailable", reasonCode, detail: detail.slice(0, 300) };
}

export const AVAILABLE: AgentAvailability = { status: "available" };

export type VersionProbe =
	| { readonly ok: true; readonly version: Version }
	| { readonly ok: false; readonly availability: AgentAvailability };

/**
 * Confirms the binary runs and is at least the version the adapter's flags
 * were verified against. Older versions may silently ignore an isolation flag,
 * so they are refused rather than tried.
 */
export async function probeCliVersion(
	processRunner: ProcessRunner,
	spec: CaptureSpec,
	displayName: string,
	minimumVersion: Version,
): Promise<VersionProbe> {
	const outcome = await captureCommand(processRunner, spec);
	if (outcome.kind === "not-installed") {
		return {
			ok: false,
			availability: unavailable(
				"NOT_INSTALLED",
				`${displayName} CLI "${spec.command}" was not found on PATH`,
			),
		};
	}
	if (outcome.kind !== "exited" || outcome.code !== 0) {
		return {
			ok: false,
			availability: unavailable("PROBE_FAILED", `${displayName} CLI did not report its version`),
		};
	}
	const version = parseVersion(outcome.stdout) ?? parseVersion(outcome.stderrTail);
	if (version === null) {
		return {
			ok: false,
			availability: unavailable(
				"PROBE_FAILED",
				`${displayName} CLI printed no recognizable version`,
			),
		};
	}
	if (compareVersions(version, minimumVersion) < 0) {
		return {
			ok: false,
			availability: unavailable(
				"UNSUPPORTED_VERSION",
				`${displayName} CLI ${formatVersion(version)} is older than ${formatVersion(minimumVersion)}, the version this adapter was verified against`,
			),
		};
	}
	return { ok: true, version };
}
