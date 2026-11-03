/**
 * Stores company overviews (事業概要, ADR-0064) written by run.ts into a
 * local database: one upsert per `<MARKET>-<SYMBOL>.overview.json`, through
 * the adapter's `companyOverviewStatement`, which checks each overview
 * against its contract first and leaves the ADR-0060 summary columns as
 * they are.
 *
 *   node scripts/poc/companyDescription/store.ts --db <sqlite file> <file.overview.json ...>
 *
 * Runs under Node (it needs node:sqlite). The development database is in
 * WAL mode, so this writes beside the running dev API; the Company tab
 * shows the overview on its next read.
 */
import { readFileSync } from "node:fs";
import { companyOverviewStatement } from "@research/adapters/sql";
import { openNodeSqlite } from "@research/adapters/sqlite";
import { companyOverviewViewSchema, watchMarketSchema } from "@research/contracts";
import { z } from "zod";

const storedFileSchema = z.strictObject({
	ownerId: z.string().min(1),
	market: watchMarketSchema,
	symbol: z.string().regex(/^[A-Z0-9.-]{1,16}$/),
	overview: companyOverviewViewSchema,
});

function parseArgs(argv: readonly string[]): { db: string; files: string[] } {
	const files: string[] = [];
	let db: string | null = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db") db = argv[++index] ?? null;
		else if (arg !== undefined) files.push(arg);
	}
	if (db === null || files.length === 0) {
		throw new Error("usage: store.ts --db <sqlite file> <file.overview.json ...>");
	}
	return { db, files };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const stored = args.files.map((file) =>
		storedFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
	);
	const db = openNodeSqlite(args.db);
	try {
		await db.batch(
			stored.map((item) =>
				companyOverviewStatement(db, item.ownerId, item.market, item.symbol, item.overview),
			),
		);
	} finally {
		db.close();
	}
	for (const item of stored) {
		console.log(
			`stored the overview of ${item.market}:${item.symbol} (${item.overview.generatedAt})`,
		);
	}
}

await main();
