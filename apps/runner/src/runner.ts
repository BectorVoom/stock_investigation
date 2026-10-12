import type { AgentRegistry } from "@research/agent-core";
import type { AgentDescriptor } from "@research/contracts";
import { executeJob, type JobExecutionDeps } from "./jobExecution.ts";

export const RUNNER_VERSION = "0.1.0";

const REPROBE_INTERVAL_MS = 300_000;
const MAX_IDLE_SLEEP_MS = 60_000;
const ERROR_BACKOFF_START_MS = 2_000;
const ERROR_BACKOFF_MAX_MS = 60_000;

export interface RunnerLoopDeps extends JobExecutionDeps {
	readonly agents: AgentRegistry;
	/** Resolves after `ms`, or immediately when `signal` aborts. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type RunnerExit = "shutdown" | "unauthenticated";

/**
 * Outbound-only polling loop (section 4): the runner always initiates the
 * connection; nothing listens on the owner's network. Idle polling follows the
 * server's `pollAfterMs` hint and failures back off exponentially.
 */
export async function runRunnerLoop(
	deps: RunnerLoopDeps,
	shutdown: AbortSignal,
): Promise<RunnerExit> {
	let descriptors: readonly AgentDescriptor[] = [];
	let probedAtMs = Number.NEGATIVE_INFINITY;
	let errorBackoffMs = ERROR_BACKOFF_START_MS;

	while (!shutdown.aborted) {
		if (deps.clock.nowMs() - probedAtMs >= REPROBE_INTERVAL_MS) {
			descriptors = await deps.agents.describeAll();
			probedAtMs = deps.clock.nowMs();
			for (const descriptor of descriptors) {
				deps.logger.info("agent_probe", {
					agentId: descriptor.agentId,
					status: descriptor.availability.status,
					reason:
						descriptor.availability.status === "unavailable"
							? descriptor.availability.reasonCode
							: null,
					toolIsolation: descriptor.toolIsolation,
				});
			}
		}

		const claimed = await deps.api.claim({
			runnerVersion: RUNNER_VERSION,
			agents: [...descriptors],
		});
		if (!claimed.ok) {
			if (claimed.error.code === "UNAUTHENTICATED" || claimed.error.code === "FORBIDDEN") {
				// A revoked or expired credential will not start working again; stop instead of hammering.
				deps.logger.error("runner_credential_rejected", { code: claimed.error.code });
				return "unauthenticated";
			}
			deps.logger.warn("claim_failed", { code: claimed.error.code, retryInMs: errorBackoffMs });
			await deps.sleep(errorBackoffMs, shutdown);
			errorBackoffMs = Math.min(errorBackoffMs * 2, ERROR_BACKOFF_MAX_MS);
			continue;
		}
		errorBackoffMs = ERROR_BACKOFF_START_MS;

		const job = claimed.value.job;
		if (job === null) {
			await deps.sleep(Math.min(claimed.value.pollAfterMs, MAX_IDLE_SLEEP_MS), shutdown);
			continue;
		}
		deps.logger.info("job_claimed", {
			runId: job.runId,
			kind: job.kind,
			attempt: job.attempt,
			leaseGeneration: job.leaseGeneration,
		});
		await executeJob(job, deps, shutdown);
	}
	return "shutdown";
}
