import {
	type HomeDataResponse,
	MARKET_LIMITS,
	marketUnavailable,
	parseMarketSeriesId,
} from "@research/contracts";
import { MARKET_CATALOG } from "./marketCatalog.ts";
import type { JobRepository, StoredMarketObservation, StoredMarketSeries } from "./ports.ts";

/**
 * The "series metadata + observations + refresh status for these ids" core
 * (ADR-0021): one function for the Home dashboard and for a conversation's
 * notebook, so the two can never drift. The callers own the id lists (the
 * dashboard's series, one notebook's series) and their digests; everything
 * below is identical for both.
 */

/** One cheap per-series stamp of what a data ETag covers (no observations). */
export interface MarketSeriesStamp {
	readonly seriesId: string;
	readonly lastRefreshedAt: string | null;
	readonly retrievedAt: string | null;
	readonly unavailableCode: string | null;
}

/** The owner-global refresh state every market-data response carries. */
export interface MarketRefreshStatus {
	readonly activeRunId: string | null;
	readonly activeRunState: string | null;
	readonly lastSucceededAt: string | null;
	readonly lastFailure: HomeDataResponse["refresh"]["lastFailure"];
}

/**
 * The refresh half of a data digest: the active run, the last success and
 * the last failure (S2: a failed or cancelled refresh is never presented as
 * a success). Cheap owner-scoped job reads only, no observation rows.
 */
export async function fetchMarketRefreshStatus(
	jobs: JobRepository,
	ownerId: string,
): Promise<MarketRefreshStatus> {
	const [active, lastSucceededAt, lastFailureRow] = await Promise.all([
		jobs.findActiveByKind(ownerId, "market-refresh"),
		jobs.findLatestSuccessAtByKind(ownerId, "market-refresh"),
		jobs.findLatestFailureByKind(ownerId, "market-refresh"),
	]);
	return {
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
	};
}

/** One stamp per id, in id order, from the stored metadata rows. */
export function seriesStampsFor(
	seriesIds: readonly string[],
	metas: readonly StoredMarketSeries[],
): readonly MarketSeriesStamp[] {
	const metaById = new Map(metas.map((meta) => [meta.seriesId, meta]));
	return seriesIds.map((seriesId) => {
		const meta = metaById.get(seriesId);
		return {
			seriesId,
			lastRefreshedAt: meta?.lastRefreshedAt ?? null,
			retrievedAt: meta?.retrievedAt ?? null,
			unavailableCode: meta?.unavailableCode ?? null,
		};
	});
}

/**
 * The union a `market-refresh` claim fetches: the Home dashboard's series
 * first, then the notebooks' series, de-duplicated, at most `limit`
 * (ADR-0021: `MARKET_LIMITS.maxTrackedSeries`).
 */
export function unionSeriesIds(
	dashboardIds: readonly string[],
	notebookIds: readonly string[],
	limit: number = MARKET_LIMITS.maxTrackedSeries,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const seriesId of [...dashboardIds, ...notebookIds]) {
		if (seen.has(seriesId)) continue;
		seen.add(seriesId);
		out.push(seriesId);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Maps stored metadata plus already-ascending, already-bounded repository
 * rows to the `HomeDataResponse` series entries, in id order. Nothing is
 * re-sorted here. A stored series id that does not parse is a storage fault,
 * never silently served as another provider (fail closed).
 */
export function assembleMarketSeries(
	seriesIds: readonly string[],
	metas: readonly StoredMarketSeries[],
	observations: readonly StoredMarketObservation[],
): HomeDataResponse["series"] {
	const metaById = new Map(metas.map((meta) => [meta.seriesId, meta]));
	const obsById = new Map<string, { observedOn: string; value: number }[]>();
	for (const obs of observations) {
		const list = obsById.get(obs.seriesId) ?? [];
		list.push({ observedOn: obs.observedOn, value: obs.value });
		obsById.set(obs.seriesId, list);
	}
	const catalogLabel = new Map(MARKET_CATALOG.map((entry) => [entry.seriesId, entry.label]));
	return seriesIds.map((seriesId) => {
		const meta = metaById.get(seriesId);
		// Already ascending and bounded by the repository: map to the
		// tuple wire format without re-sorting.
		const obs = (obsById.get(seriesId) ?? []).map((point): [string, number] => [
			point.observedOn,
			point.value,
		]);
		if (meta === undefined) {
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
}
