import {
	type EquityCompanyView,
	type EquityStatementResponse,
	formatStockId,
	type MarketSeries,
	parseStockId,
	STOCK_DATA_LIMITS,
	STOCK_DATA_SECTIONS,
	type StockDataPassage,
	type StockDataSearchRequest,
	type StockDataSearchResponse,
	type StockDataSection,
	type StockProfileResponse,
	type WatchMarket,
} from "@research/contracts";
import {
	checkLease,
	EQUITY_STATEMENTS,
	type EquityMetricCode,
	type EquityStatement,
	foldStockSearchText,
	ok,
	rankStockPassages,
	retrievalTokens,
} from "@research/domain";
import type { EquitySyncService } from "./equitySync.ts";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	JobRecord,
	JobRepository,
	StockDirectoryRepository,
	WatchlistRepository,
} from "./ports.ts";
import type { RunnerIdentity } from "./runnerJobs.ts";
import type { StockPageService, StockRef } from "./stockPages.ts";

/**
 * Retrieval over the stored stock data (ADR-0071), for the runner's
 * `stocks.search_data` research tool. Only the holder of a research run's
 * current lease may search, and only its owner's rows are read. The stocks
 * are the ones the call names, else the ones its query names; their stored
 * records become passages (`stockDataPassages`) ranked by BM25
 * (`rankStockPassages`). Nothing here makes the runner fetch anything.
 */
export interface StockDataSearchDeps {
	readonly jobs: Pick<JobRepository, "get">;
	readonly stockPages: Pick<
		StockPageService,
		"profile" | "pricesDigest" | "prices" | "themeSearch"
	>;
	readonly stockDirectory: Pick<StockDirectoryRepository, "search" | "getEntry">;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
	readonly equityCompanies: Pick<EquitySyncService, "company" | "statement">;
}

/** A passage before ranking. */
export type StockDataPassageDraft = Omit<StockDataPassage, "score">;

/** The stored records of one stock that passages are cut from. */
export interface StockDataRecords {
	readonly profile: StockProfileResponse;
	readonly series: MarketSeries | null;
	readonly statements: readonly EquityStatementResponse[];
}

/** Words of company names too common to identify one (`Apple Inc.` → `apple`). */
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
	"co",
	"com",
	"company",
	"corp",
	"corporation",
	"group",
	"holding",
	"holdings",
	"inc",
	"incorporated",
	"international",
	"limited",
	"llc",
	"ltd",
	"plc",
	"sa",
	"technologies",
	"technology",
	"trust",
]);

const LISTING_LABELS: Readonly<Record<string, string>> = {
	nasdaq: "Nasdaq",
	nyse: "New York Stock Exchange",
	cboe: "Cboe",
	txse: "Texas Stock Exchange",
	"tse-prime": "Tokyo Stock Exchange Prime Market",
	"tse-standard": "Tokyo Stock Exchange Standard Market",
	"tse-growth": "Tokyo Stock Exchange Growth Market",
};

const STATEMENT_LABELS: Readonly<Record<EquityStatement, string>> = {
	"income-statement": "Income statement",
	"balance-sheet": "Balance sheet",
	"cash-flow": "Cash flow statement",
};

/** How a metric is named in a passage: the words a question uses for it (net income, sales, capex). */
const METRIC_LABELS: Readonly<Record<EquityMetricCode, string>> = {
	revenue: "revenue (net sales)",
	"gross-profit": "gross profit",
	"operating-income": "operating income",
	"ordinary-income": "ordinary income (経常利益)",
	"profit-attributable-to-owners": "net income (profit attributable to owners of the parent)",
	"total-assets": "total assets",
	"total-liabilities": "total liabilities",
	"total-equity": "total equity",
	"cash-and-cash-equivalents": "cash and cash equivalents",
	"net-cash-from-operating-activities": "operating cash flow (net cash from operating activities)",
	"net-cash-from-investing-activities": "investing cash flow (net cash from investing activities)",
	"net-cash-from-financing-activities": "financing cash flow (net cash from financing activities)",
	"capital-expenditures": "capital expenditures (capex)",
	"free-cash-flow": "free cash flow",
};

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function dayToInstant(day: string | null): string | null {
	return day === null ? null : `${day}T00:00:00.000Z`;
}

/** `416161000000` → `416161000000 USD (416.16 billion)`; the exact stored text comes first. */
export function describeAmount(decimal: string, currency: string | null): string {
	const unit = currency === null ? "" : ` ${currency}`;
	const magnitude = Math.abs(Number(decimal));
	const scales: readonly [number, string][] = [
		[1e12, "trillion"],
		[1e9, "billion"],
		[1e6, "million"],
	];
	for (const [size, word] of scales) {
		if (magnitude >= size) {
			return `${decimal}${unit} (${(Number(decimal) / size).toFixed(2)} ${word})`;
		}
	}
	return `${decimal}${unit}`;
}

/** The `en` (or `ja`) strings of a stored overview entry, evidence quotes left out. */
function localizedStrings(value: unknown, language: "en" | "ja", out: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) localizedStrings(item, language, out);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "evidence") continue;
		if (key === language && typeof child === "string") out.push(child);
		else localizedStrings(child, language, out);
	}
}

function displayName(profile: StockProfileResponse): string | null {
	return profile.directory?.name ?? profile.company?.name ?? null;
}

function listingPassage(profile: StockProfileResponse): StockDataPassageDraft {
	const name = displayName(profile);
	const directory = profile.directory;
	const parts = [
		`${name ?? profile.symbol} (${profile.stockId}): symbol ${profile.symbol}, market ${profile.market}.`,
	];
	if (directory !== null) {
		if (directory.localName !== null) parts.push(`Local name: ${directory.localName}.`);
		parts.push(`Listed on ${LISTING_LABELS[directory.listing] ?? directory.listing}.`);
	}
	return {
		stockId: profile.stockId,
		name,
		section: "listing",
		title: `Listing — ${name ?? profile.symbol}`,
		text: clip(parts.join(" "), STOCK_DATA_LIMITS.maxPassageChars),
		sourceUrl: null,
		publisher:
			profile.market === "US" ? "SEC company tickers and exchanges" : "Japan Exchange Group",
		sourceClass: "other",
		asOf: null,
		aiWritten: false,
	};
}

function financialPassages(
	profile: StockProfileResponse,
	statement: EquityStatementResponse,
): StockDataPassageDraft[] {
	const name = displayName(profile) ?? profile.symbol;
	const company: EquityCompanyView = statement.company;
	const years = [...statement.fiscalYears]
		.sort((a, b) => b - a)
		.slice(0, STOCK_DATA_LIMITS.financialYears);
	const filingsById = new Map(statement.filings.map((filing) => [filing.filingId, filing]));
	const label = STATEMENT_LABELS[statement.statement];
	const passages: StockDataPassageDraft[] = [];
	for (const year of years) {
		const reported: string[] = [];
		const missing: string[] = [];
		let periodEnd: string | null = null;
		let filingId: string | null = null;
		for (const row of statement.rows) {
			const cell = row.cells.find((candidate) => candidate.fiscalYear === year);
			if (cell === undefined) continue;
			const metric = METRIC_LABELS[row.metric];
			if (cell.valueDecimal === null) {
				missing.push(`${metric} (${cell.unavailableReason ?? "not stored"})`);
				continue;
			}
			periodEnd ??= cell.periodEnd;
			filingId ??= cell.filingId;
			reported.push(
				`${metric} ${describeAmount(cell.valueDecimal, cell.currency)}${cell.derived ? " (derived)" : ""}`,
			);
		}
		if (reported.length === 0) continue;
		const filing = filingId === null ? undefined : filingsById.get(filingId);
		const sentences = [
			`${name} (${profile.stockId}) ${label.toLowerCase()} for fiscal year ${year}${periodEnd === null ? "" : `, period ending ${periodEnd}`}: ${reported.join("; ")}.`,
		];
		if (missing.length > 0) sentences.push(`Not available: ${missing.join("; ")}.`);
		if (filing !== undefined) {
			sentences.push(`Source: ${filing.form} filed ${filing.filedOn}.`);
		}
		passages.push({
			stockId: profile.stockId,
			name: displayName(profile),
			section: "financials",
			title: clip(`${label} FY${year} — ${name}`, STOCK_DATA_LIMITS.maxTitleChars),
			text: clip(sentences.join(" "), STOCK_DATA_LIMITS.maxPassageChars),
			sourceUrl: filing?.sourceUrl ?? null,
			publisher: company.provider === "sec" ? "SEC EDGAR" : "J-Quants (JPX)",
			sourceClass: company.provider === "sec" ? "regulatory-filing" : "company-disclosure",
			asOf: statement.dataUpdatedAt,
			aiWritten: false,
		});
	}
	return passages;
}

function pricePassage(
	profile: StockProfileResponse,
	series: MarketSeries,
): StockDataPassageDraft | null {
	const observations = series.observations;
	const last = observations.at(-1);
	if (last === undefined) return null;
	const name = displayName(profile) ?? profile.symbol;
	const unit = series.unit === "" ? "" : ` ${series.unit}`;
	const sentences = [
		`${name} (${profile.stockId}) latest stored daily close: ${last[1]}${unit} on ${last[0]}.`,
	];
	const previous = observations.at(-2);
	if (previous !== undefined && previous[1] !== 0) {
		const change = ((last[1] - previous[1]) / previous[1]) * 100;
		sentences.push(
			`Previous close ${previous[1]} on ${previous[0]} (change ${change >= 0 ? "+" : ""}${change.toFixed(2)}%).`,
		);
	}
	let high = last;
	let low = last;
	for (const point of observations) {
		if (point[1] > high[1]) high = point;
		if (point[1] < low[1]) low = point;
	}
	const first = observations[0];
	if (first !== undefined) {
		sentences.push(
			`Over the ${observations.length} stored closes since ${first[0]}: high ${high[1]} on ${high[0]}, low ${low[1]} on ${low[0]}.`,
		);
	}
	if (last[2] !== undefined) {
		const [open, highBar, lowBar, volume] = last[2];
		sentences.push(`Latest bar: open ${open}, high ${highBar}, low ${lowBar}, volume ${volume}.`);
	}
	return {
		stockId: profile.stockId,
		name: displayName(profile),
		section: "prices",
		title: clip(`Daily prices — ${name}`, STOCK_DATA_LIMITS.maxTitleChars),
		text: clip(sentences.join(" "), STOCK_DATA_LIMITS.maxPassageChars),
		sourceUrl: series.sourceUrl === "" ? null : series.sourceUrl,
		publisher: series.publisher === "" ? series.provider : series.publisher,
		sourceClass: "market-data",
		asOf: series.retrievedAt,
		aiWritten: false,
	};
}

/**
 * The passages of one stock's stored records, in a fixed order (listing,
 * profile, AI summary, overview, business text, financials, earnings,
 * prices), only of the wanted sections.
 */
export function stockDataPassages(
	records: StockDataRecords,
	sections: ReadonlySet<StockDataSection>,
): StockDataPassageDraft[] {
	const { profile } = records;
	const name = displayName(profile);
	const label = name ?? profile.symbol;
	const base = { stockId: profile.stockId, name };
	const passages: StockDataPassageDraft[] = [];
	const push = (draft: StockDataPassageDraft) => {
		if (sections.has(draft.section)) passages.push(draft);
	};

	push(listingPassage(profile));

	const companyProfile = profile.companyProfile;
	if (companyProfile !== null) {
		const facts = [
			companyProfile.nameEn === null ? null : `English name ${companyProfile.nameEn}`,
			`sector (33 industries) ${companyProfile.sector33Name}`,
			`sector (17 industries) ${companyProfile.sector17Name}`,
			`market segment ${companyProfile.marketSegmentName}`,
			companyProfile.scaleCategory === null ? null : `scale ${companyProfile.scaleCategory}`,
		].filter((fact): fact is string => fact !== null);
		push({
			...base,
			section: "company-profile",
			title: clip(`Company profile — ${label}`, STOCK_DATA_LIMITS.maxTitleChars),
			text: clip(
				`${label} (${profile.stockId}) J-Quants company profile as of ${companyProfile.asOf}: ${facts.join("; ")}.`,
				STOCK_DATA_LIMITS.maxPassageChars,
			),
			sourceUrl: null,
			publisher: "J-Quants (JPX)",
			sourceClass: "other",
			asOf: dayToInstant(companyProfile.asOf),
			aiWritten: false,
		});
	}

	const summary = profile.summary;
	if (summary !== null) {
		for (const language of ["en", "ja"] as const) {
			const themes = summary.themes.map((theme) => theme[language]).join(", ");
			push({
				...base,
				section: "ai-summary",
				title: clip(`AI-written summary (${language}) — ${label}`, STOCK_DATA_LIMITS.maxTitleChars),
				text: clip(
					`${summary.description[language]} ${language === "en" ? "Investment themes" : "投資テーマ"}: ${themes}.`,
					STOCK_DATA_LIMITS.maxPassageChars,
				),
				sourceUrl: null,
				publisher: "AI-written company summary",
				sourceClass: "other",
				asOf: summary.generatedAt,
				aiWritten: true,
			});
		}
	}

	const overview = profile.overview;
	if (overview !== null) {
		const reference = overview.references.find((candidate) => candidate.url !== null);
		for (const language of ["en", "ja"] as const) {
			const strings: string[] = [];
			localizedStrings(overview.entry, language, strings);
			if (strings.length === 0) continue;
			push({
				...base,
				section: "overview",
				title: clip(`Company overview (${language}) — ${label}`, STOCK_DATA_LIMITS.maxTitleChars),
				text: clip(strings.join(" / "), STOCK_DATA_LIMITS.maxPassageChars),
				sourceUrl: reference?.url ?? null,
				publisher: reference?.publisher ?? "AI-written company overview",
				sourceClass: "other",
				asOf: overview.generatedAt,
				aiWritten: true,
			});
		}
	}

	const business = profile.business;
	if (business.status === "extracted") {
		for (const paragraph of business.paragraphs.slice(0, STOCK_DATA_LIMITS.maxBusinessParagraphs)) {
			push({
				...base,
				section: "business",
				title: clip(
					`${business.source.form} business section (filed ${business.source.filedOn}) — ${label}`,
					STOCK_DATA_LIMITS.maxTitleChars,
				),
				text: clip(paragraph.text, STOCK_DATA_LIMITS.maxPassageChars),
				sourceUrl: business.source.sourceUrl,
				publisher: "SEC EDGAR",
				sourceClass: "regulatory-filing",
				asOf: business.fetchedAt,
				aiWritten: false,
			});
		}
	}

	if (sections.has("financials")) {
		for (const statement of records.statements)
			passages.push(...financialPassages(profile, statement));
	}

	const calendar = profile.earningsCalendar;
	if (calendar !== null) {
		const events = calendar.events.map(
			(event) =>
				`${event.announcementDate ?? "date undecided"} (${event.fiscalPeriodLabel}${event.timing === "unknown" ? "" : `, ${event.timing}`})`,
		);
		push({
			...base,
			section: "earnings",
			title: clip(`Upcoming earnings announcements — ${label}`, STOCK_DATA_LIMITS.maxTitleChars),
			text: clip(
				events.length === 0
					? `${label} (${profile.stockId}): no upcoming earnings announcement in the stored calendar.`
					: `${label} (${profile.stockId}) next earnings announcement dates: ${events.join("; ")}.`,
				STOCK_DATA_LIMITS.maxPassageChars,
			),
			sourceUrl: calendar.sourceUrl,
			publisher: calendar.publisher,
			sourceClass: "company-disclosure",
			asOf: calendar.syncedAt,
			aiWritten: false,
		});
	}

	if (records.series !== null) {
		const prices = pricePassage(profile, records.series);
		if (prices !== null) push(prices);
	}
	return passages;
}

/**
 * The passages of the stocks' records that best answer the query: every
 * record's passages (`stockDataPassages`) ranked together by BM25 over title
 * and text, best first, at most `limit` (default `defaultResults`).
 */
export function rankStockDataPassages(
	records: readonly StockDataRecords[],
	sections: ReadonlySet<StockDataSection>,
	query: string,
	limit: number = STOCK_DATA_LIMITS.defaultResults,
): StockDataPassage[] {
	const drafts = records.flatMap((record) => stockDataPassages(record, sections));
	const ranked = rankStockPassages(
		query,
		drafts.map((draft) => `${draft.title}\n${draft.text}`),
		limit,
	);
	const passages: StockDataPassage[] = [];
	for (const hit of ranked) {
		const draft = drafts[hit.index];
		if (draft !== undefined) passages.push({ ...draft, score: Math.max(0, hit.score) });
	}
	return passages;
}

/** Tickers written in the query: `AAPL`, `BRK.B` (US), `7974`, `130A` (JP). */
function queryTickers(query: string): StockRef[] {
	const refs: StockRef[] = [];
	for (const word of query.normalize("NFKC").split(/[^A-Za-z0-9.]+/)) {
		const candidates: [WatchMarket, string][] = [];
		if (/^\d{4}$|^\d{3}[A-Z]$/.test(word)) candidates.push(["JP", word]);
		if (/^[A-Z][A-Z0-9]{0,4}(\.[A-Z])?$/.test(word) && word.length >= 2)
			candidates.push(["US", word]);
		for (const [market, symbol] of candidates) {
			refs.push({ stockId: formatStockId(market, symbol), market, symbol });
		}
	}
	return refs;
}

/** Whether a Watchlist stock's symbol or a distinctive word of its name is in the query. */
function namedInQuery(
	stock: { readonly symbol: string; readonly name: string | null },
	queryTokens: ReadonlySet<string>,
	foldedQuery: string,
): boolean {
	if (queryTokens.has(foldStockSearchText(stock.symbol))) return true;
	if (stock.name === null) return false;
	const foldedName = foldStockSearchText(stock.name).replace("株式会社", "").trim();
	if (
		foldedName.length >= 2 &&
		/[^\u0020-\u007e]/.test(foldedName) &&
		foldedQuery.includes(foldedName)
	) {
		return true;
	}
	return retrievalTokens(stock.name).some(
		(word) =>
			word.length >= 3 &&
			!GENERIC_NAME_WORDS.has(word) &&
			/^[a-z0-9]+$/.test(word) &&
			queryTokens.has(word),
	);
}

export function createStockDataSearchService(deps: StockDataSearchDeps) {
	/** The stocks a query names: tickers in it, Watchlist names, the directory search, theme matches. */
	async function stocksOfQuery(ownerId: string, query: string): Promise<StockRef[]> {
		const tickers = queryTickers(query);
		const queryTokens = new Set(retrievalTokens(query));
		const foldedQuery = foldStockSearchText(query);
		const [entries, watched, directory, themes] = await Promise.all([
			Promise.all(
				tickers.map((ref) => deps.stockDirectory.getEntry(ownerId, ref.market, ref.symbol)),
			),
			deps.watchlist.listStocks(ownerId),
			deps.stockDirectory.search(ownerId, { text: query, market: null, limit: 3 }),
			deps.stockPages.themeSearch(ownerId, query, 1),
		]);
		const refs: StockRef[] = [];
		for (const [index, entry] of entries.entries()) {
			const ref = tickers[index];
			if (entry !== null && ref !== undefined) refs.push(ref);
		}
		for (const stock of watched) {
			if (namedInQuery(stock, queryTokens, foldedQuery)) {
				refs.push({ stockId: stock.stockId, market: stock.market, symbol: stock.symbol });
			}
		}
		for (const entry of directory) {
			refs.push({
				stockId: formatStockId(entry.market, entry.symbol),
				market: entry.market,
				symbol: entry.symbol,
			});
		}
		for (const hit of themes.hits)
			refs.push({ stockId: hit.stockId, market: hit.market, symbol: hit.symbol });
		return refs;
	}

	async function recordsOf(
		ownerId: string,
		stock: StockRef,
		sections: ReadonlySet<StockDataSection>,
	): Promise<StockDataRecords> {
		const [profile, series] = await Promise.all([
			deps.stockPages.profile(ownerId, stock),
			sections.has("prices")
				? deps.stockPages
						.pricesDigest(ownerId, stock)
						.then((digest) => deps.stockPages.prices(ownerId, digest))
						.then((prices) => prices.series)
				: Promise.resolve(null),
		]);
		let statements: EquityStatementResponse[] = [];
		if (sections.has("financials") && profile.company !== null) {
			const company = await deps.equityCompanies.company(ownerId, profile.company.companyId);
			if (company.ok) {
				statements = await Promise.all(
					EQUITY_STATEMENTS.map((statement) =>
						deps.equityCompanies.statement(
							ownerId,
							company.value,
							statement,
							STOCK_DATA_LIMITS.financialYears,
						),
					),
				);
			}
		}
		return { profile, series, statements };
	}

	return {
		async search(
			runner: RunnerIdentity,
			runId: string,
			request: StockDataSearchRequest,
		): Promise<UseCaseResult<StockDataSearchResponse>> {
			const job: JobRecord | null = await deps.jobs.get(runner.ownerId, runId);
			if (job === null) return fail("NOT_FOUND", "Run not found.");
			const lease = checkLease(
				{
					state: job.state,
					leaseGeneration: job.leaseGeneration,
					leaseOwnerId: job.leaseOwnerId,
					leaseExpiresAt: job.leaseExpiresAt,
					attempt: job.attempt,
					maxAttempts: job.maxAttempts,
					cancelRequested: job.cancelRequested,
				},
				{ runnerId: runner.credentialId, leaseGeneration: request.leaseGeneration },
			);
			if (!lease.ok) {
				return fail(
					"STALE_LEASE",
					"This runner no longer holds the lease for the run.",
					lease.error,
				);
			}
			if (job.kind !== "research") {
				return fail(
					"VALIDATION_FAILED",
					"Only a research run may search the stored stock data.",
					"runId",
				);
			}

			const named: StockRef[] =
				request.stockIds === undefined
					? await stocksOfQuery(runner.ownerId, request.query)
					: request.stockIds.flatMap((stockId) => {
							const parts = parseStockId(stockId);
							return parts === null ? [] : [{ stockId, ...parts }];
						});
			const stocks: StockRef[] = [];
			const seen = new Set<string>();
			for (const ref of named) {
				if (seen.has(ref.stockId)) continue;
				seen.add(ref.stockId);
				stocks.push(ref);
				if (stocks.length === STOCK_DATA_LIMITS.maxSearchedStocks) break;
			}
			if (stocks.length === 0) return ok({ searchedStocks: [], passages: [] });

			const sections = new Set<StockDataSection>(request.sections ?? STOCK_DATA_SECTIONS);
			const records = await Promise.all(
				stocks.map((stock) => recordsOf(runner.ownerId, stock, sections)),
			);
			return ok({
				searchedStocks: stocks.map((stock) => stock.stockId),
				passages: rankStockDataPassages(records, sections, request.query, request.limit),
			});
		},
	};
}

export type StockDataSearchService = ReturnType<typeof createStockDataSearchService>;
