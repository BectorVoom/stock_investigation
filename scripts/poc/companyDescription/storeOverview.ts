import { companyOverviewStatement } from "@research/adapters/sql";
import { openNodeSqlite } from "@research/adapters/sqlite";
import { companyOverviewViewSchema, watchMarketSchema } from "@research/contracts";
import { z } from "zod";

/**
 * One stock's overview as run.ts writes it (`<MARKET>-<SYMBOL>.overview.json`)
 * and as the store step reads it.
 */
export const storedOverviewSchema = z.strictObject({
	ownerId: z.string().min(1),
	market: watchMarketSchema,
	symbol: z.string().regex(/^[A-Z0-9.-]{1,16}$/),
	overview: companyOverviewViewSchema,
});
export type StoredOverview = z.infer<typeof storedOverviewSchema>;

/** Tries while the dev API holds the write lock, and the pause between them. */
const LOCKED_ATTEMPTS = 10;
const LOCKED_PAUSE_MS = 1_000;

/**
 * Upserts overviews into a local database through the adapter's
 * `companyOverviewStatement`, which checks each overview against its
 * contract first and leaves the ADR-0060 summary columns as they are.
 * Needs node:sqlite (Node, not Bun). The development database is in WAL
 * mode, so this writes beside the running dev API; the connection is held
 * only for the one batch. The adapter sets no busy timeout, so a write
 * that meets the dev API's lock ("database is locked", 9 of 3,466 stocks on
 * 2026-11-04) is tried again after a pause.
 */
export async function storeOverviews(
	databasePath: string,
	items: readonly StoredOverview[],
): Promise<void> {
	const parsed = items.map((item) => storedOverviewSchema.parse(item));
	for (let attempt = 1; ; attempt += 1) {
		try {
			await storeOnce(databasePath, parsed);
			return;
		} catch (error) {
			const locked =
				error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
			if (!locked || attempt === LOCKED_ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, LOCKED_PAUSE_MS * attempt));
		}
	}
}

async function storeOnce(databasePath: string, items: readonly StoredOverview[]): Promise<void> {
	const db = openNodeSqlite(databasePath);
	try {
		await db.batch(
			items.map((item) =>
				companyOverviewStatement(db, item.ownerId, item.market, item.symbol, item.overview),
			),
		);
	} finally {
		db.close();
	}
}
