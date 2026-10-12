/**
 * The Cloudflare D1 binding: adapts a `D1Database` to the narrow
 * `SqlDatabase` contract and hands it to the engine-neutral repositories in
 * `../sql`. Only the `SqlDatabase`-shaped surface (`prepare`, `bind`,
 * `first`, `all`, `run`, `batch`) is touched, so any SQLite-dialect engine
 * already flows through this function at runtime; the wrapper exists because
 * D1's generic statement types are not structurally assignable to the narrow
 * interface, not to add behaviour. See ADR-0008.
 */
import type { Persistence } from "@research/application";
import type {
	SqlBatchResult,
	SqlDatabase,
	SqlRow,
	SqlStatement,
	SqlValue,
} from "../sql/database.ts";
import { createSqlPersistence } from "../sql/index.ts";

/** Re-types a D1 binding as the narrow driver contract; adds no behaviour. */
function wrapDatabase(db: D1Database): SqlDatabase {
	// Per-database registry: a batch runs only statements prepared from this
	// database, so a transaction can never silently execute another
	// database's statement outside of it (ARCH-017: fail closed).
	const inners = new WeakMap<SqlStatement, D1PreparedStatement>();
	const wrap = (inner: D1PreparedStatement): SqlStatement => {
		const statement: SqlStatement = {
			bind(...values: readonly SqlValue[]): SqlStatement {
				return wrap(inner.bind(...values));
			},
			first(): Promise<SqlRow | null> {
				return inner.first();
			},
			async all(): Promise<{ readonly results: readonly SqlRow[] }> {
				const result = await inner.all();
				return { results: result.results };
			},
			async run(): Promise<{ readonly meta: { readonly changes: number } }> {
				const result = await inner.run();
				return { meta: { changes: result.meta.changes } };
			},
		};
		inners.set(statement, inner);
		return statement;
	};
	return {
		prepare(sql: string): SqlStatement {
			return wrap(db.prepare(sql));
		},
		async batch(statements: readonly SqlStatement[]): Promise<readonly SqlBatchResult[]> {
			const batch: D1PreparedStatement[] = [];
			for (const statement of statements) {
				const inner = inners.get(statement);
				if (inner === undefined) {
					throw new Error("d1 batch received a statement from another database");
				}
				batch.push(inner);
			}
			const results = await db.batch(batch);
			return results.map((result) => ({
				results: result.results,
				meta: { changes: result.meta.changes },
			}));
		},
	};
}

/** Every D1-backed port, built from one database binding. */
export function createD1Adapters(db: D1Database): Persistence {
	return createSqlPersistence(wrapDatabase(db));
}
