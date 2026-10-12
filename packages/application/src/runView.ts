import type { ResearchRun, RunnerEvent } from "@research/contracts";
import { summarizeCost } from "@research/domain";
import type { JobRecord, ProgressEntry } from "./ports.ts";

/** Projects the stored job onto the API view, including the honest cost summary (FR-016). */
export function toRunView(job: JobRecord, progress: readonly ProgressEntry[]): ResearchRun {
	return {
		runId: job.runId,
		kind: job.kind,
		workspaceId: job.workspaceId,
		state: job.state,
		request: job.request,
		usage: job.usage,
		cost: summarizeCost(job.usage),
		attempt: job.attempt,
		maxAttempts: job.maxAttempts,
		leaseExpiresAt: job.leaseExpiresAt,
		cancelRequested: job.cancelRequested,
		failureCode: job.failureCode,
		failureDetail: job.failureDetail,
		approvalRequest: job.approvalRequest,
		retryOfRunId: job.retryOfRunId,
		verificationStatus: job.verificationStatus,
		providerModel: job.providerModel,
		provenance: job.provenance,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		progress: [...progress],
	};
}

export interface ProgressRow extends ProgressEntry {
	readonly seq: number;
}

/** The runner events worth showing the owner as progress; usage and session refs are not. */
export function toProgressRows(events: readonly RunnerEvent[]): readonly ProgressRow[] {
	return events.flatMap(({ seq, at, event }): ProgressRow[] => {
		if (event.type === "state") return [{ seq, at, kind: "state", text: event.state }];
		if (event.type === "note") return [{ seq, at, kind: "note", text: event.text }];
		if (event.type === "tool") {
			return [
				{ seq, at, kind: "tool", text: `${event.toolId}: ${event.outcome} — ${event.detail}` },
			];
		}
		return [];
	});
}
