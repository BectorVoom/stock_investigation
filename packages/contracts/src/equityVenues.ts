/** Initial venue registry, checked against ISO MIC data on 2026-10-29.
 * https://www.iso20022.org/market-identifier-codes
 * Add reviewed venues here; a valid MIC shape alone does not establish country.
 */
export const EQUITY_VENUE_MARKETS: Readonly<Record<string, "JP" | "US">> = {
	XTKS: "JP",
	XNGO: "JP",
	XFKA: "JP",
	XSAP: "JP",
	XNAS: "US",
	XNYS: "US",
	XASE: "US",
	ARCX: "US",
	BATS: "US",
	IEXG: "US",
	TXSE: "US",
	MEMX: "US",
	XNGS: "US",
	XNMS: "US",
	XNCM: "US",
};
