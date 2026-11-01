import type { EquityCompanyView } from "@research/contracts";
import { formatStockId } from "@research/domain";
import type { PollSignal } from "../lib/polling.ts";

/**
 * Pure helpers of the companies' reads (ADR-0048 §8): what a company is
 * called, its stock id, and how the companies list polls.
 */

/** The company's name, or its symbol until the provider or the stock list names it. */
export function companyName(company: EquityCompanyView): string {
	return company.name ?? company.symbol;
}

/** The listing's stock id (`us:AAPL`, `jp:7974`), as the stock directory names it. */
export function companyStockId(company: EquityCompanyView): string {
	return formatStockId(company.market, company.symbol);
}

/**
 * How soon the page polls the list again: fast while a sync runs, the
 * queued ceiling while one waits for a runner, else nothing to watch
 * (the page then only re-checks on its visible ticker).
 */
export function companiesPollSignal(companies: readonly EquityCompanyView[]): PollSignal | null {
	if (companies.some((company) => company.sync.status === "running")) return "active";
	if (companies.some((company) => company.sync.status === "queued")) return "queued";
	return null;
}
