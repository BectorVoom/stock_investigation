import type { EquityCompanyView } from "@research/contracts";
import { formatStockId } from "@research/domain";

/** Pure helper of the companies' reads (ADR-0048 §8): a company's stock id. */

/** The listing's stock id (`us:AAPL`, `jp:7974`), as the stock directory names it. */
export function companyStockId(company: EquityCompanyView): string {
	return formatStockId(company.market, company.symbol);
}
