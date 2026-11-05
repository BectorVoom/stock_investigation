import type { StockResearchQuery, StockResearchResponse } from "@research/contracts";
import { isLeasedJobState, ok } from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type { Clock, JobRepository, StockResearchRepository } from "./ports.ts";
import type { RunnerIdentity } from "./runnerJobs.ts";

/** Reads only for this credential's live research lease; never accepts an owner from the model. */
export function createStockResearchService(deps: {
	readonly repository: StockResearchRepository;
	readonly jobs: JobRepository;
	readonly clock: Clock;
}) {
	return {
		async search(
			runner: RunnerIdentity,
			runId: string,
			leaseGeneration: number,
			query: StockResearchQuery,
		): Promise<UseCaseResult<StockResearchResponse>> {
			const job = await deps.jobs.get(runner.ownerId, runId);
			if (job === null) return fail("NOT_FOUND", "Run not found.");
			if (
				job.kind !== "research" ||
				!isLeasedJobState(job.state) ||
				job.cancelRequested ||
				job.leaseOwnerId !== runner.credentialId ||
				job.leaseGeneration !== leaseGeneration ||
				job.leaseExpiresAt === null ||
				job.leaseExpiresAt <= deps.clock.nowIso()
			) {
				return fail("FORBIDDEN", "A current research lease is required.");
			}
			return ok(await deps.repository.search(runner.ownerId, query));
		},
	};
}
