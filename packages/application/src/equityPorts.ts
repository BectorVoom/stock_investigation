import type {
	EquityCatalogRecord,
	EquityFactQuery,
	EquityFactsResponse,
	EquityImport,
	EquityImportHistory,
	EquityImportResult,
	EquityIssuerList,
	EquityRecordQuery,
	EquityRecordsResponse,
} from "@research/contracts";

export interface EquityPageQuery {
	readonly q: string;
	readonly after?: string;
	readonly limit: number;
}
export type EquityCursorQuery = Omit<EquityPageQuery, "q">;
export interface EquityImportWrite {
	readonly importId: string;
	readonly idempotencyKey: string;
	readonly contentSha256: string;
	readonly receivedAt: string;
	readonly payload: EquityImport;
	readonly records: readonly EquityCatalogRecord[];
}
export interface EquitySavedImport {
	readonly result: EquityImportResult;
	readonly contentSha256: string;
}
/** Immutable records make validation lookups safe: commit rechecks ID/content conflicts atomically. */
export interface EquityRepository {
	getVersion(ownerId: string): Promise<number>;
	findImport(ownerId: string, idempotencyKey: string): Promise<EquitySavedImport | null>;
	commit(ownerId: string, write: EquityImportWrite): Promise<boolean>;
	getRecords(ownerId: string, ids: readonly string[]): Promise<readonly EquityCatalogRecord[]>;
	listRecords(ownerId: string, query: EquityRecordQuery): Promise<EquityRecordsResponse>;
	listIssuers(ownerId: string, query: EquityPageQuery): Promise<EquityIssuerList>;
	listFacts(
		ownerId: string,
		issuerId: string,
		query: EquityFactQuery & { readonly ingestionVersion: number },
	): Promise<EquityFactsResponse>;
	listIssuerRecords(
		ownerId: string,
		issuerId: string,
		query: EquityCursorQuery,
	): Promise<EquityRecordsResponse>;
	listImports(ownerId: string, query: EquityCursorQuery): Promise<EquityImportHistory>;
	getImportPayload(ownerId: string, importId: string): Promise<EquityImport | null>;
}
