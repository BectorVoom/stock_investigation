import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

/**
 * Specs and the server-side sync (ADR-0051). No page and no API call starts
 * a `market-refresh` or `earnings-refresh` any more: the API queues them
 * itself each time a runner claims work — at once for never-refreshed items
 * (a widget, list or stock just added), everything when the full sync is due
 * (market: every 30 minutes or longer, earnings: every 24 hours). Specs
 * therefore wait for the data instead of triggering it (`waitForSync`), and
 * a spec that needs a second refresh of data already stored ages the stored
 * state the scheduler reads (`makeFullMarketSyncDue`) instead of waiting
 * half an hour. Shared by the browser specs, the UI review and the
 * real-network specs.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The E2E Worker's default owner (`OWNER_EMAIL` in `wrangler.e2e.jsonc`), its `owner_id`. */
export const E2E_DEFAULT_OWNER = "owner@localhost";

/** Where `tests/e2e/start-worker.sh` persists the E2E Worker's local D1. */
export const E2E_D1_STATE_DIR = join(REPO_ROOT, ".wrangler", "e2e-state");

/** A response that carries the sync state (`/home/data`, `/watchlist`, notebook market data). */
export interface WithRefreshState {
	readonly refresh: {
		readonly activeRunId: string | null;
		readonly lastSucceededAt: string | null;
	};
}

/**
 * Re-reads `read` every `intervalMs` until no run is active and `done`
 * holds; answers that read. Throws with the last refresh state when
 * `timeoutMs` passes. The server queues the job at the runner's next claim
 * (the runner asks every few seconds when idle), so a deadline covers the
 * claim gap, the run and a slow provider.
 */
export async function waitForSync<T extends WithRefreshState>(
	read: () => Promise<T>,
	done: (data: T) => boolean,
	what: string,
	options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 420_000;
	const intervalMs = options.intervalMs ?? 3_000;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const data = await read();
		if (data.refresh.activeRunId === null && done(data)) return data;
		if (Date.now() > deadline) {
			throw new Error(
				`the server-side sync of ${what} did not finish in ${timeoutMs} ms: ${JSON.stringify(data.refresh)}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** The part of `GET /api/v1/home/data` the waits read (extra fields pass). */
const homeSyncStateSchema = z.object({
	series: z.array(z.object({ seriesId: z.string(), lastRefreshedAt: z.string().nullable() })),
	refresh: z.object({
		activeRunId: z.string().nullable(),
		lastSucceededAt: z.string().nullable(),
	}),
});
export type HomeSyncState = z.infer<typeof homeSyncStateSchema>;

/** One read of `GET /api/v1/home/data` as the owner `request` speaks for. */
export async function readHomeSyncState(
	request: APIRequestContext,
	origin: string,
): Promise<HomeSyncState> {
	return homeSyncStateSchema.parse(await (await request.get(`${origin}/api/v1/home/data`)).json());
}

/**
 * Waits until the server-side sync has stamped every series in `seriesIds`
 * for the owner `request` speaks for (a page's or context's request carries
 * its `X-E2E-Owner` header) and no market run is active. A page then shows
 * them after its own re-read (within a minute) or at once after a reload.
 */
export async function waitForHomeSeries(
	request: APIRequestContext,
	origin: string,
	seriesIds: readonly string[],
	timeoutMs = 150_000,
): Promise<HomeSyncState> {
	return waitForSync(
		() => readHomeSyncState(request, origin),
		(data) =>
			seriesIds.every(
				(seriesId) =>
					(data.series.find((entry) => entry.seriesId === seriesId)?.lastRefreshedAt ?? null) !==
					null,
			),
		seriesIds.join(", "),
		{ timeoutMs },
	);
}

/**
 * The local D1 file under a Wrangler `--persist-to` directory (or a data
 * directory holding one): the `.sqlite` that has the market tables, not
 * Miniflare's metadata file.
 */
export function localD1DatabasePath(root: string): string {
	const candidates: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith(".sqlite")) candidates.push(path);
		}
	};
	if (existsSync(root)) walk(root);
	for (const path of candidates) {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const table = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'market_series'")
				.get();
			if (table !== undefined) return path;
		} finally {
			db.close();
		}
	}
	throw new Error(`no D1 database with market tables under ${root}`);
}

/**
 * How far back `makeFullMarketSyncDue` moves the stamps: beyond the longest
 * full-sync interval the schedule can choose (`marketSyncIntervalMs`
 * stretches 30 minutes by the Twelve Data series count; two days covers
 * 1,200 series at 600 requests a day), and short of ADR-0044's 7-day full
 * history check, so the sync it causes is still the window fetch.
 */
const AGE_MS = 2 * 24 * 60 * 60_000;

/**
 * Makes the API's next runner claim queue a full market sync (scope
 * "all", ADR-0051 rule 2) without waiting for the interval: moves the
 * owner's series refresh stamps (`market_series.last_refreshed_at`) and the
 * creation time of its ended `market-refresh` jobs `AGE_MS` into the past —
 * what the stored state looks like once the interval has passed. Nothing
 * else changes (observations, history anchors, `history_checked_at`,
 * job end times), so the job the claim queues is the ordinary full sync.
 * `ownerId` null ages every owner (a throwaway development database).
 * Answers the instant the stamps were aged at: every series the full sync
 * fetches carries a `lastRefreshedAt` after it.
 *
 * Call it with no market job active (after `waitForSync`), so the job whose
 * creation it ages is not the one still running.
 */
export function makeFullMarketSyncDue(databasePath: string, ownerId: string | null): number {
	const nowMs = Date.now();
	const aged = new Date(nowMs - AGE_MS).toISOString();
	const db = new DatabaseSync(databasePath);
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		const ownerClause = ownerId === null ? "" : " AND owner_id = ?";
		const ownerArgs = ownerId === null ? [] : [ownerId];
		db.prepare(
			`UPDATE market_series SET last_refreshed_at = ? WHERE last_refreshed_at IS NOT NULL${ownerClause}`,
		).run(aged, ...ownerArgs);
		db.prepare(
			`UPDATE research_jobs SET created_at = ? WHERE kind = 'market-refresh' AND state IN ('completed', 'failed', 'cancelled')${ownerClause}`,
		).run(aged, ...ownerArgs);
	} finally {
		db.close();
	}
	return nowMs;
}
