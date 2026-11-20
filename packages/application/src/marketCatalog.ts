import type { MarketCatalogEntry } from "@research/contracts";

/**
 * Curated market catalog (static data, like recommendedCatalog.ts). Holds
 * only id, short label, category and a one-line plain description — NOT units
 * or values (those come from the provider at refresh time).
 */
export const MARKET_CATALOG: readonly MarketCatalogEntry[] = [
	{
		seriesId: "fred:VIXCLS",
		label: "VIX Index",
		category: "volatility",
		description: "CBOE Volatility Index, daily close from FRED.",
	},
	{
		seriesId: "fred:DGS10",
		label: "US 10-year yield",
		category: "rates",
		description: "10-year Treasury constant maturity rate.",
	},
	{
		seriesId: "fred:DGS2",
		label: "US 2-year yield",
		category: "rates",
		description: "2-year Treasury constant maturity rate.",
	},
	{
		seriesId: "fred:T10Y2Y",
		label: "10Y-2Y spread",
		category: "rates",
		description: "10-year minus 2-year Treasury spread.",
	},
	{
		seriesId: "fred:FEDFUNDS",
		label: "Federal funds rate",
		category: "rates",
		description: "Effective federal funds rate.",
	},
	{
		seriesId: "fred:CPIAUCSL",
		label: "US CPI",
		category: "inflation",
		description: "Consumer price index for all urban consumers.",
	},
	{
		seriesId: "fred:UNRATE",
		label: "US unemployment",
		category: "labour",
		description: "Civilian unemployment rate.",
	},
	{
		seriesId: "fred:PAYEMS",
		label: "US payrolls",
		category: "labour",
		description: "Total nonfarm payroll employment.",
	},
	{
		seriesId: "fred:GDPC1",
		label: "US real GDP",
		category: "growth",
		description: "Real gross domestic product.",
	},
	{
		seriesId: "fred:SP500",
		label: "S&P 500",
		category: "equity-index",
		description: "S&P 500 index level.",
	},
	{
		seriesId: "fred:NASDAQCOM",
		label: "Nasdaq Composite",
		category: "equity-index",
		description: "Nasdaq Composite index level.",
	},
	{
		seriesId: "fred:NIKKEI225",
		label: "Nikkei 225",
		category: "equity-index",
		description: "Nikkei 225 stock average.",
	},
	{
		seriesId: "fred:DEXJPUS",
		label: "Yen per dollar",
		category: "fx",
		description: "Japanese yen to US dollar exchange rate.",
	},
	{
		seriesId: "fred:DCOILWTICO",
		label: "WTI crude oil",
		category: "commodity",
		description: "Crude oil WTI spot price.",
	},
	{
		seriesId: "twelve-data:XAU/USD",
		label: "Gold",
		category: "commodity",
		description: "Gold spot price in US dollars.",
	},
	{
		seriesId: "twelve-data:XAG/USD",
		label: "Silver",
		category: "commodity",
		description: "Silver spot price in US dollars.",
	},
	{
		seriesId: "fred:PCOPPUSDM",
		label: "Copper",
		category: "commodity",
		description: "Global copper price, monthly, in US dollars per metric ton.",
	},
	{
		seriesId: "twelve-data:AAPL",
		label: "Apple",
		category: "equity",
		description: "Apple Inc. share price.",
	},
	{
		seriesId: "twelve-data:MSFT",
		label: "Microsoft",
		category: "equity",
		description: "Microsoft Corp. share price.",
	},
	{
		seriesId: "twelve-data:NVDA",
		label: "Nvidia",
		category: "equity",
		description: "Nvidia Corp. share price.",
	},
	{
		seriesId: "twelve-data:EUR/USD",
		label: "Euro / dollar",
		category: "fx",
		description: "Euro to US dollar exchange rate.",
	},
	{
		seriesId: "twelve-data:USD/JPY",
		label: "Dollar / yen",
		category: "fx",
		description: "US dollar to Japanese yen exchange rate.",
	},
	// ADR-0076: JPX's published margin and short-selling statistics.
	{
		seriesId: "jpx:SHORT_SELLING_RATIO",
		label: "Short-selling ratio (空売り比率)",
		category: "margin",
		description:
			"Daily share of short sales in the TSE auction market's trading value, from JPX's short-selling summary.",
	},
	{
		seriesId: "jpx:MARGIN_BUYING_VALUE",
		label: "Margin buying balance (信用買い残)",
		category: "margin",
		description:
			"Weekly outstanding margin purchases in value, Tokyo and Nagoya, in JPY millions, from JPX.",
	},
	{
		seriesId: "jpx:MARGIN_RATIO",
		label: "Margin ratio (信用倍率)",
		category: "margin",
		description:
			"Weekly outstanding margin purchases over margin sales in shares, Tokyo and Nagoya, from JPX.",
	},
];
