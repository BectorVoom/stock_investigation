import type { MarketCatalogEntry, MaterialImport, MaterialSeries } from "@research/contracts";

export interface MaterialRepository {
	/** Atomic immutable snapshots. Same content is idempotent; changed content conflicts. */
	import(ownerId: string, payload: MaterialImport, committedAt: string): Promise<boolean>;
	get(ownerId: string, seriesId: string): Promise<MaterialSeries | null>;
	listCatalog(ownerId: string): Promise<readonly MarketCatalogEntry[]>;
}
