/**
 * The narrow SQL driver interface every repository in this directory is typed
 * against (ARCH-004: use cases depend on ports, adapters on this contract,
 * never on a vendor SDK type). It covers exactly what the repositories use
 * today and nothing more.
 *
 * Contract an engine MUST honour to reuse these repositories:
 * - `batch` is atomic: all statements commit or none do. The guarded writes
 *   of ADR-0004 (a compare-and-set UPDATE first, every later statement
 *   conditional on it having stamped its mutation id) rely on it.
 * - `meta.changes` is the number of rows the statement changed.
 * - The SQL passed in is the SQLite dialect (`json_each`, `json_extract`,
 *   `ON CONFLICT`, `INSERT OR IGNORE`, `RETURNING`). An engine must speak
 *   that dialect to reuse these repositories; anything else implements the
 *   `Persistence` ports in a new adapter directory instead (ADR-0008).
 *
 * Rows are `Record<string, unknown>`; they are decoded with zod in `rows.ts`,
 * so drivers stay untyped and validation lives in one place (API-002).
 */
export type SqlRow = Record<string, unknown>;

export type SqlValue = string | number | null;

/** One prepared statement with its bound values; immutable, like D1's. */
export interface SqlStatement {
	bind(...values: readonly SqlValue[]): SqlStatement;
	first(): Promise<SqlRow | null>;
	all(): Promise<SqlAllResult>;
	run(): Promise<SqlRunResult>;
}

export interface SqlAllResult {
	readonly results: readonly SqlRow[];
}

export interface SqlRunResult {
	readonly meta: { readonly changes: number };
}

/** One result per statement, in order; `results` is present for statements that return rows. */
export interface SqlBatchResult {
	/**
	 * Rows returned by the statement, if it returns any (e.g. `... RETURNING`
	 * or a batched SELECT). Untyped, like all stored rows: callers decode
	 * them with zod in `rows.ts` (API-002), never cast them.
	 */
	readonly results: readonly unknown[];
	readonly meta: { readonly changes: number };
}

export interface SqlDatabase {
	prepare(sql: string): SqlStatement;
	batch(statements: readonly SqlStatement[]): Promise<readonly SqlBatchResult[]>;
}
