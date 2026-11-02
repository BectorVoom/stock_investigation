import { DatabaseSync } from "node:sqlite";
import { E2E_D1_STATE_DIR, localD1DatabasePath } from "./marketSync.ts";

/**
 * Specs and the tracked companies (ADR-0054 §1). No page or API call tracks
 * a company any more: the API tracks every Watchlist stock itself when a
 * runner of the owner claims work. A spec that runs no runner for its owner
 * and needs a company whose statements are synced writes the rows the
 * claim-time reconcile would have written — the company, tracked, and its
 * sync state with no sync yet — into the E2E Worker's local D1.
 */
export function recordTrackedCompany(input: {
	readonly ownerId: string;
	readonly market: "US" | "JP";
	readonly symbol: string;
	readonly name: string;
}): string {
	const companyId = `eqc_e2e_${input.market.toLowerCase()}_${input.symbol}_${Date.now()}`;
	const at = new Date().toISOString();
	// Far ahead: the company is never due while the spec runs (no runner claims anyway).
	const nextDueAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
	const db = new DatabaseSync(localD1DatabasePath(E2E_D1_STATE_DIR));
	try {
		db.exec("PRAGMA busy_timeout = 10000");
		db.prepare(
			`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name, tracked, tracked_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
		).run(
			input.ownerId,
			companyId,
			input.market,
			input.symbol,
			input.market === "US" ? "sec" : "jquants",
			input.name,
			at,
		);
		db.prepare(
			"INSERT INTO equity_sync_state (owner_id, company_id, next_due_at) VALUES (?, ?, ?)",
		).run(input.ownerId, companyId, nextDueAt);
	} finally {
		db.close();
	}
	return companyId;
}
