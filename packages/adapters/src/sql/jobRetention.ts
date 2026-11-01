/**
 * Retention of the server's sync jobs (ADR-0058 §3): terminal jobs of the
 * given kinds whose terminal time is older than a cutoff are deleted with
 * their transitions and events, a bounded batch at a time.
 *
 * What is never deleted, so no read loses what it needs:
 * - a job that is not terminal (the claim, `findActiveByKind`);
 * - the newest job of each (kind, market, scope, state): a job goes only
 *   when a newer job of the same kind, market (`$.market`), refresh scope
 *   (`$.scope`) and state exists. So the newest job of a kind and market
 *   (`findLatestByKind`, `decideSync`), the newest full one (`fullOnly`),
 *   the newest completed one (`findLatestSuccessAtByKind`) and the newest
 *   failed and cancelled ones (`findLatestFailureByKind`,
 *   `findLatestFailedByKind`) all stay.
 * Sync jobs have no workspace, records or chat messages; the audit log
 * names a run id as text only.
 */
import type { SyncJobRetention } from "@research/application";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { TERMINAL_SQL } from "./repositories.ts";
import { decode } from "./rows.ts";

const runIdRowSchema = z.object({ run_id: z.string() });

export function createSyncJobRetention(db: SqlDatabase): SyncJobRetention {
	return {
		async pruneTerminalJobs(ownerId, kinds, beforeIso, limit) {
			if (kinds.length === 0 || limit < 1) return 0;
			// The candidates come off idx_research_jobs__owner_id_kind_created_at_run_id
			// (one range per kind, created before the cutoff); each one's newer
			// twin is a forward walk of the same index that stops at the first
			// match — over a class's jobs the walks are disjoint gaps, so a run
			// reads each job of a kind a bounded number of times.
			const { results } = await db
				.prepare(
					`SELECT rj.run_id
					FROM research_jobs AS rj
					WHERE rj.owner_id = ?1
						AND rj.kind IN (SELECT kinds.value FROM json_each(?2) AS kinds)
						AND rj.created_at < ?3
						AND rj.updated_at < ?3
						AND rj.state IN (${TERMINAL_SQL})
						AND EXISTS (
							SELECT 1
							FROM research_jobs AS rj_newer
							WHERE rj_newer.owner_id = rj.owner_id
								AND rj_newer.kind = rj.kind
								AND (rj_newer.created_at, rj_newer.run_id) > (rj.created_at, rj.run_id)
								AND rj_newer.state = rj.state
								AND json_extract(rj_newer.request_json, '$.market')
									IS json_extract(rj.request_json, '$.market')
								AND json_extract(rj_newer.request_json, '$.scope')
									IS json_extract(rj.request_json, '$.scope')
						)
					ORDER BY rj.kind, rj.created_at, rj.run_id
					LIMIT ?4`,
				)
				.bind(ownerId, JSON.stringify(kinds), beforeIso, limit)
				.all();
			const runIds = results.map((row) => decode("research_jobs", runIdRowSchema, row).run_id);
			if (runIds.length === 0) return 0;
			const ids = JSON.stringify(runIds);
			// Children first, then the job rows; the job delete re-checks that
			// each row is still terminal (a terminal job never leaves that state).
			const deleted = await db.batch([
				db
					.prepare(
						`DELETE FROM job_events
						WHERE owner_id = ? AND run_id IN (SELECT ids.value FROM json_each(?) AS ids)`,
					)
					.bind(ownerId, ids),
				db
					.prepare(
						`DELETE FROM job_transitions
						WHERE owner_id = ? AND run_id IN (SELECT ids.value FROM json_each(?) AS ids)`,
					)
					.bind(ownerId, ids),
				db
					.prepare(
						`DELETE FROM research_jobs
						WHERE owner_id = ? AND run_id IN (SELECT ids.value FROM json_each(?) AS ids)
							AND state IN (${TERMINAL_SQL})`,
					)
					.bind(ownerId, ids),
			]);
			return deleted[2]?.meta.changes ?? 0;
		},
	};
}
