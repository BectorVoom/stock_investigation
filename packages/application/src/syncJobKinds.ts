/**
 * The job kinds the server queues on its own (ADR-0051, ADR-0054, ADR-0058).
 * A leaf module: the run list (`researchRuns.ts`) and job retention
 * (`jobRetention.ts`) both read it, and neither may import the other's
 * graph (`dataSync.ts` imports `researchRuns.ts`).
 */
import type { JobKind } from "@research/contracts";

/**
 * Research and notebook runs are not among them. Their jobs are pruned
 * after `SYNC_JOB_RETENTION_DAYS` and left out of the run list unless asked
 * for by kind.
 */
export const SERVER_SYNC_JOB_KINDS = [
	"market-refresh",
	"earnings-refresh",
	"stock-directory-refresh",
	"news-ingest",
	"google-calendar",
	"financial-sync",
	"stock-prices-sync",
	"edinet-index",
] as const satisfies readonly JobKind[];
