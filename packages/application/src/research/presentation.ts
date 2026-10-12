import type {
	Claim,
	Dataset,
	DatasetCell,
	DemandScenario,
	Evidence,
	FinancialObservation,
	PositionObservation,
	Security,
	SupplierLink,
} from "@research/contracts";
import { type JsonObject, positionLabels, type UiOperation } from "@research/domain";

/**
 * Deterministic presentation of verified results: the same records always
 * yield the same datasets and UI operations. The model does not author these.
 */
export interface PresentationInput {
	readonly runId: string;
	readonly question: string;
	readonly nowIso: string;
	readonly dataCutoffAt: string;
	readonly claims: readonly Claim[];
	readonly scenarios: readonly DemandScenario[];
	readonly securities: readonly Security[];
	readonly supplierLinks: readonly SupplierLink[];
	readonly financialObservations: readonly FinancialObservation[];
	readonly positionObservations: readonly PositionObservation[];
	readonly evidence: readonly Evidence[];
}

export interface Presentation {
	readonly datasets: readonly Dataset[];
	readonly uiOperations: readonly UiOperation[];
}

export const DISCLAIMER =
	"Research support only — not investment advice. Scenarios are conditional on their stated assumptions, not predictions, and every figure is as of its stated date.";

const MAX_PROFILES = 4;

export function datasetIds(runId: string) {
	return {
		scenarios: `${runId}_ds_scenarios`,
		growth: `${runId}_ds_growth`,
		suppliers: `${runId}_ds_suppliers`,
		financials: `${runId}_ds_financials`,
		positionsJp: `${runId}_ds_positions_jp`,
		positionsUs: `${runId}_ds_positions_us`,
	} as const;
}

/** Shown to the model so optional display instructions can bind to real column keys. */
export function datasetGuide(runId: string): string {
	const ids = datasetIds(runId);
	return [
		`- ${ids.scenarios}: product, quantity, unit, baseYear, targetYear, baseline, bear, base, bull (one row per scenario)`,
		`- ${ids.growth}: scenario, bear, base, bull (derived CAGR in % per year; only scenarios with a sourced baseline)`,
		`- ${ids.suppliers}: company, ticker, exchange, country, products, exposure`,
		`- ${ids.financials}: security, metric, value, valueUnit, period, basis`,
		`- ${ids.positionsJp} / ${ids.positionsUs}: jurisdiction-specific position statistics`,
		"A dataset exists only if the run produced rows for it.",
	].join("\n");
}

const text = (value: string): DatasetCell => ({ v: value });
const unavailable = (reason: string): DatasetCell => ({ v: null, reason });

function percentCell(ratio: number | null): DatasetCell {
	return ratio === null
		? unavailable("not derivable: no sourced baseline")
		: { v: Math.round(ratio * 10_000) / 100, basis: "derived" };
}

function unitLabel(observation: FinancialObservation): string {
	if (observation.unit === "ratio") return "ratio";
	const currency = observation.currency ?? "currency";
	return observation.unit === "currency" ? currency : `${currency} per share`;
}

function periodLabel(observation: FinancialObservation): string {
	const period = observation.period;
	return period === null
		? "—"
		: `FY${period.fiscalYear} ${period.fiscalPeriod} (${period.periodStart} to ${period.periodEnd})`;
}

function positionRows(
	observations: readonly PositionObservation[],
	securityName: (securityId: string) => string,
): Record<string, DatasetCell>[] {
	return observations.map((observation) => {
		const provenance =
			observation.sourceEvidenceId === null || observation.asOfDate === null
				? {}
				: { sourceId: observation.sourceEvidenceId, asOf: observation.asOfDate };
		const reason = observation.unavailableReason ?? "unavailable";
		const figures = observation.figures;
		const row: Record<string, DatasetCell> = {
			security: text(securityName(observation.securityId)),
			definition: text(observation.metricDefinition),
		};
		if (observation.metric === "jp-margin-balance") {
			const jp = figures?.metric === "jp-margin-balance" ? figures : null;
			row.marginBuy =
				jp === null ? unavailable(reason) : { v: jp.marginBuyBalanceShares, ...provenance };
			row.marginSell =
				jp === null ? unavailable(reason) : { v: jp.marginSellBalanceShares, ...provenance };
		} else {
			const us = figures?.metric === "us-short-interest" ? figures : null;
			row.shortInterest =
				us === null ? unavailable(reason) : { v: us.reportedShortInterestShares, ...provenance };
		}
		return row;
	});
}

/** A sourced baseline with the date its source describes; otherwise explicitly unavailable. */
function baselineCell(
	scenario: DemandScenario,
	evidenceById: ReadonlyMap<string, Evidence>,
): DatasetCell {
	const source =
		scenario.baselineEvidenceId === null
			? undefined
			: evidenceById.get(scenario.baselineEvidenceId);
	if (scenario.baselineValue === null || source === undefined) {
		return unavailable("no sourced baseline");
	}
	return {
		v: scenario.baselineValue,
		sourceId: source.evidenceId,
		asOf: source.effectiveAt ?? source.publishedAt ?? source.retrievedAt,
	};
}

export function buildPresentation(input: PresentationInput): Presentation {
	const ids = datasetIds(input.runId);
	const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
	const datasets: Dataset[] = [];
	const operations: UiOperation[] = [];
	const securityById = new Map(input.securities.map((s) => [s.securityId, s]));
	const securityName = (securityId: string): string => {
		const security = securityById.get(securityId);
		return security === undefined
			? securityId
			: `${security.issuerName} (${security.exchange}: ${security.ticker})`;
	};
	const component = (suffix: string) => `${input.runId}_${suffix}`;
	const create = (suffix: string, componentType: string, props: JsonObject) => {
		// The Worker re-validates these props against the component registry.
		operations.push({
			operation: "component.create",
			componentId: component(suffix),
			componentType,
			schemaVersion: 1,
			props,
		});
	};

	/* ----- Report ----- */
	const statements = (status: Claim["status"]) =>
		input.claims
			.filter((claim) => claim.status === status)
			.map((claim) => ({
				text: claim.text,
				claimId: claim.claimId,
				claimType: claim.claimType,
				status: claim.status,
				sourceIds: [...new Set(claim.links.map((link) => link.evidenceId))],
			}));
	const findings = [
		{ heading: "Supported findings", statements: statements("supported") },
		{ heading: "Findings with conflicting evidence", statements: statements("conflicting") },
		{ heading: "Unsupported statements (not verified)", statements: statements("unsupported") },
	].filter((section) => section.statements.length > 0);
	// A report always has a section; with nothing verified it says so instead of staying empty.
	const sections =
		findings.length > 0
			? findings
			: [
					{
						heading: "No findings",
						statements: [
							{
								text: "No claim could be established from the retrieved evidence.",
								claimId: null,
								claimType: null,
								status: null,
								sourceIds: [],
							},
						],
					},
				];
	create("report", "research-report", {
		title: input.question.slice(0, 300),
		generatedAt: input.nowIso,
		dataCutoffAt: input.dataCutoffAt,
		sections,
		disclaimer: DISCLAIMER,
	});

	const citedIds = [...new Set(input.evidence.map((item) => item.evidenceId))].slice(0, 40);
	if (citedIds.length > 0) {
		create("sources", "source-list", { title: "Sources", sourceIds: citedIds });
	}

	/* ----- Demand scenarios ----- */
	if (input.scenarios.length > 0) {
		const scenarioSources = (scenario: DemandScenario) => [
			...scenario.supportingEvidenceIds,
			...scenario.contraryEvidenceIds,
		];
		datasets.push({
			datasetId: ids.scenarios,
			title: "Demand scenarios",
			columns: [
				{ key: "product", label: "Product / service", kind: "text" },
				{ key: "quantity", label: "Measured quantity", kind: "text" },
				{ key: "unit", label: "Unit", kind: "text" },
				{ key: "baseYear", label: "Base year", kind: "text" },
				{ key: "targetYear", label: "Target year", kind: "text" },
				{ key: "baseline", label: "Baseline", kind: "number", unit: "see Unit column" },
				{ key: "bear", label: "Bear target", kind: "number", unit: "see Unit column" },
				{ key: "base", label: "Base target", kind: "number", unit: "see Unit column" },
				{ key: "bull", label: "Bull target", kind: "number", unit: "see Unit column" },
			],
			rows: input.scenarios.map((scenario) => ({
				product: text(scenario.productOrService),
				quantity: text(scenario.quantityKind),
				unit: text(scenario.unit),
				baseYear: text(String(scenario.baseYear)),
				targetYear: text(String(scenario.targetYear)),
				baseline: baselineCell(scenario, evidenceById),
				// Scenario targets are assumptions, and the table says so on every figure.
				bear: { v: scenario.bear.targetValue, basis: "assumption" },
				base: { v: scenario.base.targetValue, basis: "assumption" },
				bull: { v: scenario.bull.targetValue, basis: "assumption" },
			})),
			createdAt: input.nowIso,
		});
		create("scenarios", "data-table", {
			title: "Demand scenarios (bear / base / bull)",
			datasetRef: ids.scenarios,
			sourceIds: [...new Set(input.scenarios.flatMap(scenarioSources))].slice(0, 40),
			caption:
				"Targets are scenario assumptions, not measurements. See the report for drivers and falsifiers.",
		});

		const derivable = input.scenarios.filter((scenario) => scenario.derivedCagr.base !== null);
		if (derivable.length > 0) {
			datasets.push({
				datasetId: ids.growth,
				title: "Derived scenario growth",
				columns: [
					{ key: "scenario", label: "Scenario", kind: "text" },
					{ key: "bear", label: "Bear", kind: "number", unit: "% per year" },
					{ key: "base", label: "Base", kind: "number", unit: "% per year" },
					{ key: "bull", label: "Bull", kind: "number", unit: "% per year" },
				],
				rows: derivable.map((scenario) => ({
					scenario: text(
						`${scenario.productOrService} (${scenario.baseYear}–${scenario.targetYear})`,
					),
					bear: percentCell(scenario.derivedCagr.bear),
					base: percentCell(scenario.derivedCagr.base),
					bull: percentCell(scenario.derivedCagr.bull),
				})),
				createdAt: input.nowIso,
			});
			create("growth", "bar-chart", {
				title: "Derived compound annual growth by scenario",
				datasetRef: ids.growth,
				categoryKey: "scenario",
				series: [
					{ key: "bear", label: "Bear" },
					{ key: "base", label: "Base" },
					{ key: "bull", label: "Bull" },
				],
				xLabel: "Scenario",
				yLabel: "Compound annual growth",
				yUnit: "% per year",
				sourceIds: [...new Set(derivable.flatMap(scenarioSources))].slice(0, 40),
			});
		}
	}

	/* ----- Suppliers ----- */
	if (input.supplierLinks.length > 0) {
		datasets.push({
			datasetId: ids.suppliers,
			title: "Supplier mapping",
			columns: [
				{ key: "company", label: "Company", kind: "text" },
				{ key: "ticker", label: "Ticker", kind: "text" },
				{ key: "exchange", label: "Exchange", kind: "text" },
				{ key: "country", label: "Country", kind: "text" },
				{ key: "listing", label: "Listing check", kind: "text" },
				{ key: "products", label: "Relevant products / services", kind: "text" },
				{ key: "exposure", label: "Business exposure", kind: "text" },
			],
			rows: input.supplierLinks.map((link) => {
				const security = securityById.get(link.securityId);
				const sourceId = link.evidenceIds[0];
				const cited = (value: string): DatasetCell =>
					sourceId === undefined ? text(value) : { v: value, sourceId };
				return {
					company: cited(security?.issuerName ?? link.securityId),
					ticker: text(security?.ticker ?? "—"),
					exchange: text(security?.exchange ?? "—"),
					country: text(security?.country ?? "—"),
					listing: text(
						security?.listingVerification === "source-verified"
							? "ticker and exchange from an official directory"
							: "not verified against an exchange listing",
					),
					products: text(link.productsOrServices.join("; ").slice(0, 600)),
					exposure: cited(link.businessExposure.slice(0, 600)),
				};
			}),
			createdAt: input.nowIso,
		});
		create("suppliers", "data-table", {
			title: "Listed suppliers (Japan / United States)",
			datasetRef: ids.suppliers,
			sourceIds: [...new Set(input.supplierLinks.flatMap((link) => link.evidenceIds))].slice(0, 40),
		});
		// Profiles are shown only for issuers whose listing a tool confirmed; the rest stay in
		// the table above, where the "Listing check" column says they are unverified.
		const profiled = input.supplierLinks.filter(
			(link) => securityById.get(link.securityId)?.listingVerification === "source-verified",
		);
		profiled.slice(0, MAX_PROFILES).forEach((link, index) => {
			const security = securityById.get(link.securityId);
			if (security === undefined) return;
			create(`company${index}`, "company-profile", {
				companyName: security.issuerName,
				ticker: security.ticker,
				exchange: security.exchange,
				country: security.country,
				productsOrServices: link.productsOrServices,
				businessExposure: link.businessExposure,
				sourceIds: link.evidenceIds,
			});
		});
	}

	/* ----- Financial observations ----- */
	if (input.financialObservations.length > 0) {
		datasets.push({
			datasetId: ids.financials,
			title: "Financial metrics",
			columns: [
				{ key: "security", label: "Security", kind: "text" },
				{ key: "metric", label: "Metric", kind: "text" },
				{ key: "value", label: "Value", kind: "number", unit: "see Unit column" },
				{ key: "valueUnit", label: "Unit", kind: "text" },
				{ key: "period", label: "Accounting period", kind: "text" },
				{ key: "basis", label: "Basis", kind: "text" },
			],
			rows: input.financialObservations.map((observation) => ({
				security: text(securityName(observation.securityId)),
				metric: text(observation.metricCode),
				value:
					observation.value === null || observation.sourceEvidenceId === null
						? unavailable(observation.unavailableReason ?? "unavailable")
						: {
								v: observation.value,
								sourceId: observation.sourceEvidenceId,
								...(observation.marketDataAsOf === null
									? observation.period === null
										? {}
										: { asOf: observation.period.periodEnd }
									: { asOf: observation.marketDataAsOf }),
							},
				valueUnit: text(unitLabel(observation)),
				period: text(periodLabel(observation)),
				basis: text(
					`${observation.accountingStandard ?? "basis n/a"}, ${observation.actualOrEstimate}${observation.formula === null ? "" : `; ${observation.formula}`}`,
				),
			})),
			createdAt: input.nowIso,
		});
		create("financials", "financial-table", {
			title: "Financial metrics",
			datasetRef: ids.financials,
			sourceIds: [
				...new Set(
					input.financialObservations
						.map((observation) => observation.sourceEvidenceId)
						.filter((id): id is string => id !== null),
				),
			].slice(0, 40),
			methodologyNote:
				"PER = share price / EPS for the stated basis and period; non-positive or missing EPS, or a missing licensed price, is reported as N/A. Net profit margin = net income / revenue for the same reporting period and accounting standard.",
		});
	}

	/* ----- Positions: one table per jurisdiction, never merged (DATA-006) ----- */
	for (const metric of ["jp-margin-balance", "us-short-interest"] as const) {
		const observations = input.positionObservations.filter((o) => o.metric === metric);
		if (observations.length === 0) continue;
		const labels = positionLabels(metric);
		const isJp = metric === "jp-margin-balance";
		const datasetId = isJp ? ids.positionsJp : ids.positionsUs;
		datasets.push({
			datasetId,
			title: labels.heading,
			columns: [
				{ key: "security", label: "Security", kind: "text" },
				...(isJp
					? [
							{
								key: "marginBuy",
								label: "Margin buy balance",
								kind: "number" as const,
								unit: "shares",
							},
							{
								key: "marginSell",
								label: "Margin sell balance",
								kind: "number" as const,
								unit: "shares",
							},
						]
					: [
							{
								key: "shortInterest",
								label: "Reported short interest",
								kind: "number" as const,
								unit: "shares",
							},
						]),
				{ key: "definition", label: "Source definition", kind: "text" },
			],
			rows: positionRows(observations, securityName),
			createdAt: input.nowIso,
		});
		create(isJp ? "positions_jp" : "positions_us", "data-table", {
			title: labels.heading,
			datasetRef: datasetId,
			sourceIds: [
				...new Set(
					observations.map((o) => o.sourceEvidenceId).filter((id): id is string => id !== null),
				),
			],
			caption: labels.caveat,
		});
	}

	return { datasets, uiOperations: operations };
}
