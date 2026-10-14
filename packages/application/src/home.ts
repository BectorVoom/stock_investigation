import {
	DEFAULT_HOME_DASHBOARD,
	type HomeDashboard,
	type HomeDashboardResponse,
	type HomeDataResponse,
	homeDashboardSchema,
	MARKET_LIMITS,
} from "@research/contracts";
import { distinctDashboardSeriesIds, err, ok } from "@research/domain";
import { fail, type UseCaseError, type UseCaseResult } from "./errors.ts";
import { MARKET_CATALOG } from "./marketCatalog.ts";
import {
	assembleMarketSeries,
	fetchMarketRefreshStatus,
	type MarketSeriesStamp,
	seriesStampsFor,
} from "./marketData.ts";
import type {
	AuditLog,
	Clock,
	HomeDashboardRecord,
	HomeDashboardRepository,
	JobRepository,
	MarketRepository,
	NotebookRepository,
} from "./ports.ts";

export interface HomeServiceDeps {
	readonly dashboard: HomeDashboardRepository;
	readonly market: MarketRepository;
	readonly jobs: JobRepository;
	/** The notebooks' series a Home save must keep (ADR-0021). */
	readonly notebooks: NotebookRepository;
	readonly clock: Clock;
	readonly audit: AuditLog;
}

/**
 * The cheap, owner-scoped facts a `/home/data` ETag covers (S3): dashboard
 * version, active run id + state, last success and failure stamps, and one
 * stamp per series (last_refreshed_at / retrieved_at / unavailable_code).
 * Observations are NOT part of the digest — they always move together with
 * the stamps a completion writes — so a 304 is answered before any
 * observation row is loaded.
 */
export interface HomeDataDigest {
	readonly dashboardVersion: number;
	readonly seriesIds: readonly string[];
	readonly activeRunId: string | null;
	readonly activeRunState: string | null;
	readonly lastSucceededAt: string | null;
	readonly lastFailure: HomeDataResponse["refresh"]["lastFailure"];
	readonly seriesStamps: readonly MarketSeriesStamp[];
}

/**
 * Pure ETag source for `/home/data`, over the digest only (S3). The same
 * string is used for the digest-first 304 check and for the full response,
 * so the two can never disagree.
 */
export function homeDataDigestEtag(digest: HomeDataDigest): string {
	const series = digest.seriesStamps
		.map(
			(entry) =>
				`${entry.seriesId}:${entry.lastRefreshedAt ?? "never"}:${entry.retrievedAt ?? "never"}:${entry.unavailableCode ?? "ok"}`,
		)
		.join(",");
	const failure =
		digest.lastFailure === null
			? "no-failure"
			: `${digest.lastFailure.state}:${digest.lastFailure.code}:${digest.lastFailure.at}`;
	return `home.v${digest.dashboardVersion}.${digest.activeRunId ?? "idle"}.${digest.activeRunState ?? "idle"}.${digest.lastSucceededAt ?? "never"}.${failure}.${series}`;
}

const UNREADABLE_ERROR: UseCaseError = {
	code: "STORED_DASHBOARD_UNREADABLE",
	message: "The stored dashboard could not be read. Reset to the default arrangement to continue.",
};

export function createHomeService(deps: HomeServiceDeps) {
	/** The stored record, or the stable failure when it no longer parses (V2, fail closed). */
	async function readableRecord(
		ownerId: string,
	): Promise<UseCaseResult<HomeDashboardRecord | null>> {
		const stored = await deps.dashboard.get(ownerId);
		if (stored === "unreadable") return err(UNREADABLE_ERROR);
		return ok(stored);
	}

	/**
	 * Series a Home save must keep: the dashboard's series plus every series
	 * a notebook still names (ADR-0021). Only series named by neither are
	 * deleted with the save.
	 */
	async function keepSeriesIds(ownerId: string, dashboard: HomeDashboard): Promise<string[]> {
		const notebookIds = await deps.notebooks.listMarketSeriesIds(ownerId);
		return [...new Set([...distinctDashboardSeriesIds(dashboard.widgets), ...notebookIds])];
	}

	return {
		async getDashboard(ownerId: string): Promise<UseCaseResult<HomeDashboardResponse>> {
			const stored = await readableRecord(ownerId);
			if (!stored.ok) return stored;
			if (stored.value === null) {
				return ok({
					dashboard: DEFAULT_HOME_DASHBOARD,
					version: 0,
					updatedAt: null,
					origin: "defaults",
				});
			}
			return ok({
				dashboard: stored.value.dashboard,
				version: stored.value.version,
				updatedAt: stored.value.updatedAt,
				origin: "saved",
			});
		},

		async putDashboard(
			ownerId: string,
			dashboard: HomeDashboard,
			expectedVersion: number,
		): Promise<UseCaseResult<HomeDashboardResponse>> {
			const now = deps.clock.nowIso();
			const result = await deps.dashboard.put(ownerId, dashboard, expectedVersion, now);
			if (result === "version-conflict") {
				return fail("VERSION_CONFLICT", "The dashboard changed; reload and try again.");
			}
			// S4b: series (and their observations) that neither the new
			// dashboard nor any notebook still references are deleted in the
			// same save, set-based.
			await deps.market.deleteSeriesNotIn(ownerId, await keepSeriesIds(ownerId, dashboard));
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "home.dashboard.update",
				resource: ownerId,
				detail: `widgets=${dashboard.widgets.length}`,
				at: now,
			});
			const stored = await deps.dashboard.get(ownerId);
			if (stored === null || stored === "unreadable") return fail("INTERNAL", "Internal error.");
			return ok({
				dashboard: stored.dashboard,
				version: stored.version,
				updatedAt: stored.updatedAt,
				origin: "saved",
			});
		},

		/**
		 * V2: the way out when the stored document no longer parses. A
		 * dedicated reset (not a versioned PUT) replaces the stored document,
		 * so no expectedVersion is needed: the owner explicitly discards
		 * whatever is stored, readable or not.
		 */
		async resetDashboard(ownerId: string): Promise<UseCaseResult<HomeDashboardResponse>> {
			const now = deps.clock.nowIso();
			const dashboard: HomeDashboard = {
				schemaVersion: 1,
				widgets: [...DEFAULT_HOME_DASHBOARD.widgets],
			};
			const stored = await deps.dashboard.reset(ownerId, dashboard, now);
			await deps.market.deleteSeriesNotIn(ownerId, await keepSeriesIds(ownerId, stored.dashboard));
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "home.dashboard.reset",
				resource: ownerId,
				detail: `widgets=${stored.dashboard.widgets.length}`,
				at: now,
			});
			return ok({
				dashboard: stored.dashboard,
				version: stored.version,
				updatedAt: stored.updatedAt,
				origin: "saved",
			});
		},

		/**
		 * S3: everything the ETag covers, with cheap owner-scoped queries only
		 * (dashboard row, active run row, two terminal-run lookups, one series
		 * metadata query) — no observation rows.
		 */
		async getDataDigest(ownerId: string): Promise<UseCaseResult<HomeDataDigest>> {
			const stored = await readableRecord(ownerId);
			if (!stored.ok) return stored;
			const dashboard = stored.value?.dashboard ?? DEFAULT_HOME_DASHBOARD;
			const ids = distinctDashboardSeriesIds(dashboard.widgets).slice(0, MARKET_LIMITS.maxSeries);
			const [status, metas] = await Promise.all([
				fetchMarketRefreshStatus(deps.jobs, ownerId),
				deps.market.getSeriesMeta(ownerId, ids),
			]);
			return ok({
				dashboardVersion: stored.value?.version ?? 0,
				seriesIds: ids,
				activeRunId: status.activeRunId,
				activeRunState: status.activeRunState,
				lastSucceededAt: status.lastSucceededAt,
				lastFailure: status.lastFailure,
				seriesStamps: seriesStampsFor(ids, metas),
			});
		},

		/**
		 * ONE round trip: the series of the current dashboard (saved or
		 * default) with stored metadata and the newest ≤ 800 observations.
		 * The repository returns observations ascending by date (one ordered
		 * SQL statement); nothing is re-sorted here. Pass a digest from
		 * `getDataDigest` to reuse its cheap reads; otherwise it is fetched.
		 */
		async getData(
			ownerId: string,
			digest?: HomeDataDigest,
		): Promise<UseCaseResult<HomeDataResponse>> {
			let header = digest;
			if (header === undefined) {
				const computed = await this.getDataDigest(ownerId);
				if (!computed.ok) return computed;
				header = computed.value;
			}
			const [metas, observations] = await Promise.all([
				deps.market.getSeriesMeta(ownerId, header.seriesIds),
				deps.market.getObservations(
					ownerId,
					header.seriesIds,
					MARKET_LIMITS.maxObservationsPerResponse,
				),
			]);
			return ok({
				series: assembleMarketSeries(header.seriesIds, metas, observations),
				refresh: {
					activeRunId: header.activeRunId,
					activeRunState: header.activeRunState,
					lastSucceededAt: header.lastSucceededAt,
					lastFailure: header.lastFailure,
				},
			});
		},

		getCatalog(): readonly (typeof MARKET_CATALOG)[number][] {
			return MARKET_CATALOG;
		},

		validatedDashboard(value: unknown): UseCaseResult<HomeDashboard> {
			const parsed = homeDashboardSchema.safeParse(value);
			if (!parsed.success) return fail("VALIDATION_FAILED", "Dashboard failed validation.");
			return ok(parsed.data);
		},
	};
}

export type HomeService = ReturnType<typeof createHomeService>;
