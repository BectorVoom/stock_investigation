/**
 * Stores company overviews (事業概要, ADR-0064) written by run.ts into a
 * local database: one upsert per `<MARKET>-<SYMBOL>.overview.json`
 * (storeOverview.ts). run.ts stores each stock itself as it finishes; this
 * CLI re-stores saved files.
 *
 *   node scripts/poc/companyDescription/store.ts --db <sqlite file> <file.overview.json ...>
 *
 * Runs under Node (it needs node:sqlite). The Company tab shows the
 * overview on its next read.
 */
import { readFileSync } from "node:fs";
import { storedOverviewSchema, storeOverviews } from "./storeOverview.ts";

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
		storedOverviewSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
	);
	await storeOverviews(args.db, stored);
	for (const item of stored) {
		console.log(
			`stored the overview of ${item.market}:${item.symbol} (${item.overview.generatedAt})`,
		);
	}
}

await main();
