/**
 * SEC EDGAR tools: annual financials for a US ticker and 13F-HR holdings of an
 * investment manager. Both reach only www.sec.gov / data.sec.gov (the SEC
 * client pins the fetcher to those hosts) and fail closed with
 * `NOT_CONFIGURED` when the owner has not supplied an SEC User-Agent.
 *
 * Every number in the output is either a figure SEC published, with its
 * concept, period, filing and evidence id, or a ratio computed by the domain
 * from two such figures. Anything else is `null` plus a reason (DATA-011).
 */
import {
	type CollectedEvidence,
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolContext,
	type ToolDefinition,
	type ToolFailure,
} from "@research/agent-core";
import type { Hasher } from "@research/application";
import {
	EXCHANGES_BY_COUNTRY,
	type FinancialObservation,
	type InvestorFiling,
	type Security,
} from "@research/contracts";
import { describeReportedPositionChange, err, ok } from "@research/domain";
import { z } from "zod";
import type { SharePriceSource } from "../finance/marketData.ts";
import type {
	ReportedPositionComparison,
	Sec13FFiling,
	Sec13FReport,
	Sec13FSource,
} from "../finance/sec13f.ts";
import { isoDateToInstant, SEC_HOSTS, SEC_PUBLISHER, type SecError } from "../finance/secClient.ts";
import type {
	FigureResult,
	SecAnnualFigure,
	SecCompanyFinancials,
	SecFinancialsSource,
} from "../finance/secFinancials.ts";
import { boundModelText, collectEvidence, toolFailure, truncateText } from "./shared.ts";

export interface SecToolDeps {
	readonly financials: SecFinancialsSource;
	readonly filings: Sec13FSource;
	readonly sharePrice: SharePriceSource;
	readonly hasher: Hasher;
}

/** Contract limit on holdings per filing record. */
const MAX_HOLDINGS_PER_FILING = 60;
/** Slots kept for positions that dropped out, so they are not crowded out by large books. */
const MAX_NO_LONGER_REPORTED = 10;
const MAX_CHANGES_IN_MODEL_TEXT = 12;

const PER_FORMULA = "share price / diluted EPS of the latest reported fiscal year";
/** A configured price source would still need a reviewed EPS/adjustment-basis policy before use. */
const PER_NOT_IMPLEMENTED_REASON =
	"A share-price source is configured, but computing PER from it is not implemented in this version; no ratio is reported.";

function secFailure(error: SecError): ToolFailure {
	return toolFailure(error.code, error.detail, error.retryable);
}

/** SEC's exchange text mapped to the contract's venue name by exact, case-insensitive match only. */
function contractExchange(secExchange: string | null): string | null {
	if (secExchange === null) return null;
	const wanted = secExchange.trim().toLowerCase();
	return EXCHANGES_BY_COUNTRY.US.find((venue) => venue.toLowerCase() === wanted) ?? null;
}

function scaled(amount: number): string {
	const magnitude = Math.abs(amount);
	const [divisor, word] =
		magnitude >= 1e12
			? [1e12, "trillion"]
			: magnitude >= 1e9
				? [1e9, "billion"]
				: magnitude >= 1e6
					? [1e6, "million"]
					: [1, ""];
	return divisor === 1 ? "" : ` (${Number((amount / divisor).toFixed(3))} ${word})`;
}

function describeFigure(label: string, figure: FigureResult): string {
	if (!figure.ok) return `${label}: unavailable — ${figure.error.reason}.`;
	const { value } = figure;
	const unit = value.unit === "currency" ? value.currency : `${value.currency} per share`;
	const filingYear =
		value.filingFiscalYear === null
			? ""
			: ` (SEC fiscal-year label of that filing: ${value.filingFiscalYear})`;
	return `${label}: ${value.concept} = ${value.amount} ${unit}${scaled(value.amount)} for the fiscal year ended ${value.period.periodEnd}, period ${value.period.periodStart} to ${value.period.periodEnd}; form ${value.form}, accession ${value.accessionNumber}, filed ${value.filedAt}${filingYear}.`;
}

function latestFiledFigure(financials: SecCompanyFinancials): SecAnnualFigure | null {
	const figures = [financials.revenue, financials.netIncome, financials.epsDiluted].flatMap(
		(figure) => (figure.ok ? [figure.value] : []),
	);
	return figures.sort((a, b) => b.filedAt.localeCompare(a.filedAt))[0] ?? null;
}

function reportedObservation(
	context: ToolContext,
	securityId: string,
	metricCode: "revenue" | "net-income" | "eps-diluted",
	figure: FigureResult,
	sourceEvidenceId: string,
): FinancialObservation {
	const unit = metricCode === "eps-diluted" ? "currency-per-share" : "currency";
	const base = {
		observationId: context.nextId("fo"),
		securityId,
		metricCode,
		unit,
		actualOrEstimate: "actual",
		marketDataAsOf: null,
		formula: null,
		sourceEvidenceId,
	} as const;
	if (!figure.ok) {
		return {
			...base,
			value: null,
			unavailableReason: truncateText(figure.error.reason, 300),
			currency: null,
			accountingStandard: null,
			period: null,
		};
	}
	return {
		...base,
		value: figure.value.amount,
		unavailableReason: null,
		currency: figure.value.currency,
		accountingStandard: figure.value.accountingStandard,
		period: figure.value.period,
	};
}

function marginObservation(
	context: ToolContext,
	securityId: string,
	financials: SecCompanyFinancials,
	sourceEvidenceId: string,
): FinancialObservation {
	const base = {
		observationId: context.nextId("fo"),
		securityId,
		metricCode: "net-profit-margin",
		unit: "ratio",
		currency: null,
		actualOrEstimate: "actual",
		marketDataAsOf: null,
		sourceEvidenceId,
	} as const;
	const margin = financials.netProfitMargin;
	if (!margin.ok) {
		return {
			...base,
			value: null,
			unavailableReason: truncateText(margin.error.reason, 300),
			accountingStandard: null,
			period: null,
			formula: "net income / revenue",
		};
	}
	const revenueConcept = financials.revenue.ok ? financials.revenue.value.concept : "revenue";
	return {
		...base,
		value: margin.value.marginRatio,
		unavailableReason: null,
		accountingStandard: margin.value.accountingStandard,
		period: margin.value.period,
		formula: truncateText(
			`${margin.value.formula}: us-gaap:NetIncomeLoss (attributable to parent, incl. discontinued operations) / ${revenueConcept}, same fiscal year`,
			200,
		),
	};
}

function createCompanyFinancialsTool(deps: SecToolDeps): ToolDefinition {
	return defineTool({
		toolId: "finance.sec_company_financials",
		version: "1.0.0",
		description:
			"Latest fiscal-year revenue, net income, diluted EPS and net profit margin of a US-listed company, as reported to the SEC (EDGAR XBRL company facts). No share price: PER is reported unavailable.",
		argsSchema: z.strictObject({
			ticker: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9.-]{1,12}$/),
		}),
		argsHint: '{ "ticker": "<US ticker, e.g. MSFT>" }',
		timeoutMs: 90_000,
		permission: "research-read",
		costCategory: "rate-limited",
		sideEffect: "external-read",
		networkAllowlist: { kind: "hosts", hosts: SEC_HOSTS },
		async execute({ ticker }, context) {
			const loaded = await deps.financials.latestAnnualFinancials(ticker, context.signal);
			if (!loaded.ok) return err(secFailure(loaded.error));
			const financials = loaded.value;
			const { issuer } = financials;

			// The exchange is part of a security's identity (FR-005). SEC must state one we know;
			// otherwise no record is produced rather than a plausible-looking venue.
			const exchange = contractExchange(issuer.secExchange);
			if (exchange === null || !/^[A-Z0-9.-]{1,12}$/.test(issuer.ticker)) {
				return err(
					toolFailure(
						"SECURITY_NOT_IDENTIFIABLE",
						`SEC lists ${issuer.secExchange === null ? "no exchange" : `exchange "${truncateText(issuer.secExchange, 40)}"`} for this ticker, which is not a supported listing venue; no security or financial records were created`,
					),
				);
			}

			const retrievedAt = context.nowIso();
			const issuerName = truncateText(issuer.name, 300);
			const directoryEvidence = await collectEvidence(deps.hasher, {
				evidenceId: context.nextId("ev"),
				sourceUrl: financials.tickerDirectoryUrl,
				title: `SEC company tickers and exchanges — ${issuer.ticker}`,
				publisher: SEC_PUBLISHER,
				publishedAt: null,
				retrievedAt,
				effectiveAt: null,
				sourceClass: "other",
				retrievedText: `SEC ticker directory entry: ticker ${issuer.ticker}; issuer ${issuer.name}; CIK ${issuer.cik}; exchange ${issuer.secExchange ?? "not stated"}.`,
				// SEC data is US-government public information; passages may be kept.
				retainQuotes: true,
				excerpt: `Ticker ${issuer.ticker}; issuer ${issuerName}; CIK ${issuer.cik}; exchange ${issuer.secExchange ?? "not stated"}.`,
			});

			const latest = latestFiledFigure(financials);
			const margin = financials.netProfitMargin;
			const factLines = [
				`SEC EDGAR XBRL company facts for ${issuer.name} (CIK ${issuer.cik}).`,
				describeFigure("Revenue", financials.revenue),
				describeFigure("Net income", financials.netIncome),
				describeFigure("Diluted EPS", financials.epsDiluted),
				margin.ok
					? `Derived by this tool, not stated in the source: net profit margin = net income / revenue = ${margin.value.marginRatio.toFixed(4)} (${(margin.value.marginRatio * 100).toFixed(2)}%).`
					: `Net profit margin: not computed — ${margin.error.reason}.`,
			];
			const factsEvidence = await collectEvidence(deps.hasher, {
				evidenceId: context.nextId("ev"),
				sourceUrl: financials.companyFactsUrl,
				title: `SEC EDGAR XBRL company facts — ${issuer.name} (CIK ${issuer.cik})`,
				publisher: SEC_PUBLISHER,
				publishedAt: latest === null ? null : isoDateToInstant(latest.filedAt),
				retrievedAt,
				effectiveAt: latest === null ? null : isoDateToInstant(latest.period.periodEnd),
				sourceClass: "regulatory-filing",
				retrievedText: factLines.join("\n"),
				retainQuotes: true,
				excerpt: factLines.slice(0, 3).join(" "),
			});
			const factsEvidenceId = factsEvidence.evidence.evidenceId;

			const security: Security = {
				securityId: context.nextId("sec"),
				country: "US",
				ticker: issuer.ticker,
				exchange,
				issuerName,
				issuerIdentifier: { scheme: "CIK", value: issuer.cik },
				listingCurrency: "USD",
				reportingCurrency: financials.revenue.ok ? financials.revenue.value.currency : null,
				// Ticker and exchange were read from SEC's own directory file by this call.
				listingVerification: "source-verified",
				formerTickers: [],
			};
			const quote = await deps.sharePrice.latestQuote({
				securityId: security.securityId,
				ticker: security.ticker,
				exchange: security.exchange,
			});
			const perReason = quote.ok ? PER_NOT_IMPLEMENTED_REASON : quote.error.reason;
			const observations: readonly FinancialObservation[] = [
				reportedObservation(
					context,
					security.securityId,
					"revenue",
					financials.revenue,
					factsEvidenceId,
				),
				reportedObservation(
					context,
					security.securityId,
					"net-income",
					financials.netIncome,
					factsEvidenceId,
				),
				reportedObservation(
					context,
					security.securityId,
					"eps-diluted",
					financials.epsDiluted,
					factsEvidenceId,
				),
				marginObservation(context, security.securityId, financials, factsEvidenceId),
				{
					observationId: context.nextId("fo"),
					securityId: security.securityId,
					metricCode: "trailing-per",
					value: null,
					unavailableReason: truncateText(perReason, 300),
					unit: "ratio",
					currency: null,
					accountingStandard: null,
					period: null,
					actualOrEstimate: "actual",
					marketDataAsOf: null,
					formula: PER_FORMULA,
					sourceEvidenceId: null,
				},
			];

			return ok({
				...EMPTY_TOOL_OUTPUT,
				modelText: boundModelText([
					`${issuer.ticker} — ${issuer.name} (CIK ${issuer.cik}), listed on ${exchange} per SEC. securityId: ${security.securityId}.`,
					`[${directoryEvidence.evidence.evidenceId}] ${directoryEvidence.evidence.sourceUrl} (ticker, CIK and exchange)`,
					`[${factsEvidenceId}] ${factsEvidence.evidence.sourceUrl} (figures below)`,
					...factLines.slice(1),
					`Trailing PER: unavailable — ${perReason}`,
					"These are annual figures as reported to the SEC for the stated fiscal year, not current market data. Quote the numbers exactly as written here.",
					`Observation ids: ${observations.map((o) => `${o.metricCode}=${o.observationId}`).join(", ")}.`,
				]),
				evidence: [directoryEvidence, factsEvidence],
				securities: [security],
				financialObservations: observations,
			});
		},
	});
}

/* ---------- 13F ---------- */

type FilingHolding = InvestorFiling["holdings"][number];

function reportedHolding(
	holding: Sec13FFiling["holdings"][number],
	changeFromPriorFiling: FilingHolding["changeFromPriorFiling"],
): FilingHolding {
	return {
		issuerName: truncateText(holding.issuerName, 300),
		cusip: holding.cusip,
		securityId: null,
		reportedShares: holding.reportedShares,
		reportedValueUsd: holding.reportedValueUsd,
		changeFromPriorFiling,
	};
}

function currentFilingHoldings(report: Sec13FReport): readonly FilingHolding[] {
	// No comparison was made (no earlier filing, or a filing not read in full): every position
	// carries a null change, and nothing is said about positions that might have dropped out.
	if (report.previous === null || report.comparisonUnavailableReason !== null) {
		return report.current.holdings
			.slice(0, MAX_HOLDINGS_PER_FILING)
			.map((holding) => reportedHolding(holding, null));
	}
	const changeByCusip = new Map(report.changes.map((change) => [change.cusip, change.change]));
	const noLongerReported: FilingHolding[] = report.previous.holdings
		.filter((holding) => changeByCusip.get(holding.cusip) === "no-longer-reported")
		.slice(0, MAX_NO_LONGER_REPORTED)
		.map((holding) => ({
			issuerName: truncateText(holding.issuerName, 300),
			cusip: holding.cusip,
			securityId: null,
			// Both filings were read in full and this CUSIP is absent from the current one:
			// zero shares are reported, and there is no value to state.
			reportedShares: 0,
			reportedValueUsd: null,
			changeFromPriorFiling: "no-longer-reported",
		}));
	const reported = report.current.holdings
		.slice(0, MAX_HOLDINGS_PER_FILING - noLongerReported.length)
		.map((holding) => reportedHolding(holding, changeByCusip.get(holding.cusip) ?? null));
	return [...reported, ...noLongerReported];
}

function priorFilingHoldings(filing: Sec13FFiling): readonly FilingHolding[] {
	// No earlier filing was compared with this one.
	return filing.holdings
		.slice(0, MAX_HOLDINGS_PER_FILING)
		.map((holding) => reportedHolding(holding, null));
}

/** Says, in the stored text itself, when a filing's holdings are not the whole picture. */
function incompletenessNote(filing: Sec13FFiling): string | null {
	if (filing.unreadableRowCount === 0) return null;
	const omitted =
		filing.incompleteCusips.length === 0
			? "the affected positions could not be identified"
			: `positions for CUSIP ${filing.incompleteCusips.join(", ")} are omitted rather than understated`;
	return `INCOMPLETE: ${filing.unreadableRowCount} rows of this information table could not be read; ${omitted}. The list below is not the filer's full holdings, and no change in reported positions is stated against this filing.`;
}

function filingText(managerName: string, filing: Sec13FFiling): string {
	return [
		`Form ${filing.form} of ${managerName}: positions held as of ${filing.reportPeriodEnd}, filed ${filing.filedAt}, accession ${filing.accessionNumber}.`,
		`${filing.holdings.length} share positions by CUSIP; ${filing.excludedRowCount} option or principal-amount rows excluded; ${filing.unreadableRowCount} rows unreadable. Values in US dollars${filing.valueUnitAsFiled === "usd-thousands" ? " (filed in thousands, converted)" : ""}.`,
		...[incompletenessNote(filing)].flatMap((note) => (note === null ? [] : [note])),
		...filing.holdings.map(
			(holding) =>
				`${holding.issuerName} | CUSIP ${holding.cusip} | ${holding.reportedShares} shares | value USD ${holding.reportedValueUsd}`,
		),
	].join("\n");
}

async function filingEvidence(
	hasher: Hasher,
	context: ToolContext,
	managerName: string,
	filing: Sec13FFiling,
	retrievedAt: string,
): Promise<CollectedEvidence> {
	const text = filingText(managerName, filing);
	return collectEvidence(hasher, {
		evidenceId: context.nextId("ev"),
		sourceUrl: filing.filingUrl,
		title: `Form ${filing.form} — ${managerName} — holdings as of ${filing.reportPeriodEnd}`,
		publisher: SEC_PUBLISHER,
		publishedAt: isoDateToInstant(filing.filedAt),
		retrievedAt,
		effectiveAt: isoDateToInstant(filing.reportPeriodEnd),
		sourceClass: "regulatory-filing",
		retrievedText: text,
		// SEC filings are US-government public information; passages may be kept.
		retainQuotes: true,
		excerpt: text,
	});
}

/** Largest movements first: positions that appeared or disappeared, then by size of the share change. */
function notableChanges(
	changes: readonly ReportedPositionComparison[],
): readonly ReportedPositionComparison[] {
	const delta = (change: ReportedPositionComparison): number =>
		Math.abs((change.currentReportedShares ?? 0) - (change.previousReportedShares ?? 0));
	return changes
		.filter((change) => change.change !== "unchanged-reported-position")
		.sort((a, b) => delta(b) - delta(a) || a.cusip.localeCompare(b.cusip))
		.slice(0, MAX_CHANGES_IN_MODEL_TEXT);
}

function create13FHoldingsTool(deps: SecToolDeps): ToolDefinition {
	return defineTool({
		toolId: "filings.sec_13f_holdings",
		version: "1.0.0",
		description:
			"Quarter-end holdings an institutional investment manager reported to the SEC on its two most recent Form 13F-HR filings, with the change in each reported position. 13F shows holdings at quarter end, not trades.",
		argsSchema: z.strictObject({
			managerCik: z
				.string()
				.trim()
				.regex(/^(CIK)?\d{1,10}$/i),
		}),
		argsHint: '{ "managerCik": "<SEC CIK of the investment manager, digits>" }',
		timeoutMs: 120_000,
		permission: "research-read",
		costCategory: "rate-limited",
		sideEffect: "external-read",
		networkAllowlist: { kind: "hosts", hosts: SEC_HOSTS },
		async execute({ managerCik }, context) {
			const loaded = await deps.filings.latestHoldings(managerCik, context.signal);
			if (!loaded.ok) return err(secFailure(loaded.error));
			const report = loaded.value;
			const investorName = truncateText(report.manager.name, 300);
			const retrievedAt = context.nowIso();

			const toRecord = (
				filing: Sec13FFiling,
				holdings: readonly FilingHolding[],
				evidence: CollectedEvidence,
			): InvestorFiling => ({
				filingId: context.nextId("fil"),
				investorName,
				reportingEntityIdentifier: { scheme: "CIK", value: report.manager.cik },
				form: filing.form,
				reportPeriodEnd: filing.reportPeriodEnd,
				filedAt: filing.filedAt,
				filingUrl: filing.filingUrl,
				holdings: [...holdings],
				sourceEvidenceId: evidence.evidence.evidenceId,
			});

			const currentEvidence = await filingEvidence(
				deps.hasher,
				context,
				investorName,
				report.current,
				retrievedAt,
			);
			const evidence = [currentEvidence];
			const filings = [toRecord(report.current, currentFilingHoldings(report), currentEvidence)];
			if (report.previous !== null) {
				const previousEvidence = await filingEvidence(
					deps.hasher,
					context,
					investorName,
					report.previous,
					retrievedAt,
				);
				evidence.push(previousEvidence);
				filings.push(
					toRecord(report.previous, priorFilingHoldings(report.previous), previousEvidence),
				);
			}

			const describeFiling = (label: string, filing: Sec13FFiling, index: number): string =>
				`${label}: holdings as of ${filing.reportPeriodEnd}, filed ${filing.filedAt}, ${filing.holdings.length} share positions — filingId ${filings[index]?.filingId ?? "n/a"}, evidence [${evidence[index]?.evidence.evidenceId ?? "n/a"}] ${filing.filingUrl}`;
			const incompleteLines = [report.current, report.previous].flatMap((filing) => {
				const note = filing === null ? null : incompletenessNote(filing);
				return filing === null || note === null
					? []
					: [`Filing for ${filing.reportPeriodEnd}: ${note}`];
			});
			const lines = [
				`Form 13F-HR holdings reported by ${investorName} (CIK ${report.manager.cik}).`,
				"A 13F lists positions held at quarter end and is filed weeks later. It shows no trade dates and no prices paid; describe differences only as changes in reported positions.",
				describeFiling("Current filing", report.current, 0),
				...(report.previous === null
					? []
					: [describeFiling("Previous filing", report.previous, 1)]),
				...incompleteLines,
				// Stated before the lists, so it survives truncation of long output.
				...(report.comparisonUnavailableReason === null
					? []
					: [
							`No change in reported positions is stated: ${report.comparisonUnavailableReason}. Do not infer that any position was newly reported, changed or dropped.`,
						]),
				"Largest reported positions in the current filing:",
				...report.current.holdings
					.slice(0, 10)
					.map(
						(holding) =>
							`  ${holding.issuerName} (CUSIP ${holding.cusip}): ${holding.reportedShares} shares, value USD ${holding.reportedValueUsd}`,
					),
			];
			if (report.comparisonUnavailableReason === null) {
				lines.push("Changes in reported positions versus the previous filing:");
				for (const change of notableChanges(report.changes)) {
					lines.push(
						`  ${describeReportedPositionChange(change.change, {
							investorName,
							issuerName: change.issuerName,
							reportPeriodEnd: report.current.reportPeriodEnd,
							filedAt: report.current.filedAt,
							form: report.current.form,
						})} Reported shares: ${change.previousReportedShares ?? "none"} -> ${change.currentReportedShares ?? "none"}.`,
					);
				}
			}
			return ok({
				...EMPTY_TOOL_OUTPUT,
				modelText: boundModelText(lines),
				evidence,
				investorFilings: filings,
			});
		},
	});
}

export function createSecTools(deps: SecToolDeps): readonly ToolDefinition[] {
	return [createCompanyFinancialsTool(deps), create13FHoldingsTool(deps)];
}
