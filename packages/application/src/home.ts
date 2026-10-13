import {
	DEFAULT_HOME_DASHBOARD,
	type HomeDashboard,
	type HomeDashboardResponse,
	type HomeDataResponse,
	homeDashboardSchema,
	MARKET_LIMITS,
	marketUnavailable,
	parseMarketSeriesId,
} from "@research/contracts";
import { distinctDashboardSeriesIds, err, ok } from "@research/domain";
import { fail, type UseCaseError, type UseCaseResult } from "./errors.ts";
import { MARKET_CATALOG } from "./marketCatalog.ts";
import type {
	AuditLog,
	Clock,
	HomeDashboardRecord,
	HomeDashboardRepository,
	JobRepository,
	MarketRepository,
} from "./ports.ts";

export interface HomeServiceDeps {
	readonly dashboard: HomeDashboardRepository;
	readonly market: MarketRepository;
	readonly jobs: JobRepository;
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
	readonly seriesStamps: readonly {
		readonly seriesId: string;
		readonly lastRefreshedAt: string | null;
		readonly retrievedAt: string | null;
		readonly unavailableCode: string | null;
	}[];
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
			// S4b: series (and their observations) that the new dashboard no
			// longer references are deleted in the same save, set-based.
			await deps.market.deleteSeriesNotIn(ownerId, distinctDashboardSeriesIds(dashboard.widgets));
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
			await deps.market.deleteSeriesNotIn(
				ownerId,
				distinctDashboardSeriesIds(stored.dashboard.widgets),
			);
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
			const [active, lastSucceededAt, lastFailureRow, metas] = await Promise.all([
				deps.jobs.findActiveByKind(ownerId, "market-refresh"),
				deps.jobs.findLatestSuccessAtByKind(ownerId, "market-refresh"),
				deps.jobs.findLatestFailureByKind(ownerId, "market-refresh"),
				deps.market.getSeriesMeta(ownerId, ids),
			]);
			const metaById = new Map(metas.map((meta) => [meta.seriesId, meta]));
			return ok({
				dashboardVersion: stored.value?.version ?? 0,
				seriesIds: ids,
				activeRunId: active?.runId ?? null,
				activeRunState: active?.state ?? null,
				lastSucceededAt,
				lastFailure:
					lastFailureRow === null || lastFailureRow.failureCode === null
						? null
						: {
								state: lastFailureRow.state,
								code: lastFailureRow.failureCode,
								at: lastFailureRow.at,
							},
				seriesStamps: ids.map((seriesId) => {
					const meta = metaById.get(seriesId);
					return {
						seriesId,
						lastRefreshedAt: meta?.lastRefreshedAt ?? null,
						retrievedAt: meta?.retrievedAt ?? null,
						unavailableCode: meta?.unavailableCode ?? null,
					};
				}),
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
			const metaById = new Map(metas.map((meta) => [meta.seriesId, meta]));
			const obsById = new Map<string, { observedOn: string; value: number }[]>();
			for (const obs of observations) {
				const list = obsById.get(obs.seriesId) ?? [];
				list.push({ observedOn: obs.observedOn, value: obs.value });
				obsById.set(obs.seriesId, list);
			}
			const catalogLabel = new Map(MARKET_CATALOG.map((entry) => [entry.seriesId, entry.label]));
			const series = header.seriesIds.map((seriesId) => {
				const meta = metaById.get(seriesId);
				// Already ascending and bounded by the repository: map to the
				// tuple wire format without re-sorting.
				const obs = (obsById.get(seriesId) ?? []).map((point): [string, number] => [
					point.observedOn,
					point.value,
				]);
				if (meta === undefined) {
					// Fail closed: a stored series id that does not parse is a
					// storage fault, never silently served as another provider.
					const parsed = parseMarketSeriesId(seriesId);
					if (parsed === null) {
						throw new Error(`stored market series id failed validation: ${seriesId}`);
					}
					const { provider, symbol } = parsed;
					return {
						seriesId,
						provider,
						symbol,
						title: catalogLabel.get(seriesId) ?? symbol,
						unit: "",
						frequency: "unknown" as const,
						publisher: "",
						sourceUrl:
							provider === "fred"
								? (`https://fred.stlouisfed.org/series/${symbol}` as string)
								: ("https://twelvedata.com/" as string),
						lastRefreshedAt: null,
						retrievedAt: null,
						unavailable: marketUnavailable("NEVER_REFRESHED"),
						observations: obs,
					};
				}
				// The stored placeholder of a series with no provider metadata
				// (never refreshed, or only failed so far) carries its symbol
				// as the title — not provider metadata. Show the catalog label
				// when there is one, else the symbol. A series that succeeded
				// at least once always has retrievedAt set, so a null
				// retrievedAt marks exactly the no-metadata rows.
				const title =
					meta.retrievedAt === null ? (catalogLabel.get(seriesId) ?? meta.symbol) : meta.title;
				return {
					seriesId: meta.seriesId,
					provider: meta.provider,
					symbol: meta.symbol,
					title,
					unit: meta.unit,
					frequency: meta.frequency,
					publisher: meta.publisher,
					sourceUrl: meta.sourceUrl,
					lastRefreshedAt: meta.lastRefreshedAt,
					retrievedAt: meta.retrievedAt,
					unavailable:
						meta.unavailableCode === null
							? null
							: marketUnavailable(meta.unavailableCode, meta.provider),
					observations: obs,
				};
			});
			return ok({
				series,
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
