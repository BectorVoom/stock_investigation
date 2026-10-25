/**
 * Valid baseline fixtures for the contract tests. Each test derives its negative
 * cases from these by changing one thing, so a rejection can only be caused by
 * the field under test. Values are illustrative, not real market data.
 */
import type {
	AgentDescriptor,
	Article,
	ChatMessage,
	Claim,
	ClaimedJob,
	Dataset,
	DemandScenario,
	Evidence,
	FinancialObservation,
	InvestorFiling,
	NewsSource,
	PositionObservation,
	PricingPowerRecord,
	ResearchBundle,
	ResearchRequest,
	ResearchRun,
	RunRecords,
	Security,
	SupplierLink,
} from "../src/index.ts";

export const T0 = "2026-10-11T00:00:00Z";
export const T1 = "2026-10-11T00:05:00Z";
export const SHA256 = "a".repeat(64);

export const newsSource: NewsSource = {
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/rss",
	sourceType: "rss",
	title: "Example Wire",
	publisher: "Example Media",
	licensePolicy: "headline-and-link-only",
	trustClassification: "established-media",
	feedStatus: "active",
	lastFetchedAt: null,
	lastErrorCode: null,
	lastErrorUpstreamStatus: null,
	createdAt: T0,
	updatedAt: T0,
};

export const article: Article = {
	articleId: "art_1",
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/articles/1",
	publisher: "Example Media",
	title: "Battery makers expand capacity",
	publishedAt: T0,
	retrievedAt: T1,
	contentFingerprint: SHA256,
	excerpt: null,
};

export const evidence: Evidence = {
	evidenceId: "ev_1",
	sourceUrl: "https://news.example.com/articles/1",
	title: "Battery makers expand capacity",
	publisher: "Example Media",
	publishedAt: T0,
	retrievedAt: T1,
	effectiveAt: null,
	excerpt: "Three suppliers announced new plants.",
	checksum: SHA256,
	sourceClass: "news",
};

export const claim: Claim = {
	claimId: "claim_1",
	text: "Three suppliers announced new plants.",
	claimType: "observation",
	status: "supported",
	links: [
		{ evidenceId: "ev_1", relation: "supports", quote: "Three suppliers announced new plants." },
	],
	issues: [],
};

export const demandScenario: DemandScenario = {
	scenarioId: "scn_1",
	productOrService: "Grid-scale battery storage",
	quantityKind: "unit-demand",
	unit: "GWh installed per year",
	baseYear: 2025,
	targetYear: 2030,
	baselineValue: 1024,
	bear: { targetValue: 1024, assumptions: ["Subsidies lapse"] },
	base: { targetValue: 3125, assumptions: ["Current policy holds"] },
	bull: { targetValue: 7776, assumptions: ["Cell prices fall faster"] },
	drivers: ["Renewables share"],
	barriers: ["Interconnection queues"],
	falsifiers: ["Installations flat for two years"],
	methodology: "Bottom-up from announced projects.",
	derivedCagr: { bear: 0, base: 0.25, bull: 0.5 },
	baselineEvidenceId: "ev_1",
	baselineQuote: null,
	supportingEvidenceIds: ["ev_1"],
	contraryEvidenceIds: [],
};

export const jpSecurity: Security = {
	securityId: "sec_jp_1",
	country: "JP",
	ticker: "6999",
	exchange: "TSE",
	issuerName: "Example Denki KK",
	issuerIdentifier: { scheme: "EDINET", value: "E00000" },
	listingCurrency: "JPY",
	reportingCurrency: "JPY",
	listingVerification: "unverified",
	formerTickers: [],
};

export const usSecurity: Security = {
	securityId: "sec_us_1",
	country: "US",
	ticker: "EXMP",
	exchange: "NASDAQ",
	issuerName: "Example Semiconductor Inc",
	issuerIdentifier: { scheme: "CIK", value: "0000000000" },
	listingCurrency: "USD",
	reportingCurrency: "USD",
	listingVerification: "source-verified",
	formerTickers: [{ ticker: "EXM", exchange: "NYSE", validUntil: "2024-06-30" }],
};

export const supplierLink: SupplierLink = {
	supplierLinkId: "sup_1",
	scenarioId: "scn_1",
	securityId: "sec_jp_1",
	productsOrServices: ["Battery separators"],
	businessExposure: "Roughly a third of segment revenue per the cited filing.",
	evidenceIds: ["ev_1"],
	relationshipQuote: null,
};

export const reportingPeriod = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2025-04-01",
	periodEnd: "2026-03-31",
} as const;

export const availableObservation: FinancialObservation = {
	observationId: "obs_1",
	securityId: "sec_jp_1",
	metricCode: "trailing-per",
	value: 16,
	unavailableReason: null,
	unit: "ratio",
	currency: null,
	accountingStandard: "JGAAP",
	period: reportingPeriod,
	actualOrEstimate: "actual",
	marketDataAsOf: T0,
	formula: "price / EPS",
	sourceEvidenceId: "ev_1",
};

export const unavailableObservation: FinancialObservation = {
	...availableObservation,
	observationId: "obs_2",
	value: null,
	unavailableReason: "EPS is negative for the trailing period; PER is not meaningful.",
	sourceEvidenceId: null,
};

export const jpPosition: PositionObservation = {
	observationId: "pos_jp_1",
	securityId: "sec_jp_1",
	jurisdiction: "JP",
	metric: "jp-margin-balance",
	figures: {
		jurisdiction: "JP",
		metric: "jp-margin-balance",
		marginBuyBalanceShares: 1_200_000,
		marginSellBalanceShares: 400_000,
	},
	unavailableReason: null,
	metricDefinition: "Exchange-reported standardized and negotiable margin balances.",
	unit: "shares",
	asOfDate: "2026-10-02",
	disseminatedAt: "2026-10-06T07:30:00Z",
	sourceEvidenceId: "ev_1",
};

export const usPosition: PositionObservation = {
	observationId: "pos_us_1",
	securityId: "sec_us_1",
	jurisdiction: "US",
	metric: "us-short-interest",
	figures: {
		jurisdiction: "US",
		metric: "us-short-interest",
		reportedShortInterestShares: 9_000_000,
		averageDailyVolumeShares: 2_250_000,
	},
	unavailableReason: null,
	metricDefinition: "Short interest reported for the settlement date.",
	unit: "shares",
	asOfDate: "2026-09-30",
	disseminatedAt: "2026-10-09T20:00:00Z",
	sourceEvidenceId: "ev_1",
};

export const investorFiling: InvestorFiling = {
	filingId: "fil_1",
	investorName: "Example Capital LP",
	reportingEntityIdentifier: { scheme: "CIK", value: "0000000001" },
	form: "13F-HR",
	reportPeriodEnd: "2026-06-30",
	filedAt: "2026-08-14",
	filingUrl: "https://filings.example.com/13f/0000000001",
	holdings: [
		{
			issuerName: "Example Semiconductor Inc",
			cusip: "000000000",
			securityId: "sec_us_1",
			reportedShares: 150_000,
			reportedValueUsd: 12_000_000,
			changeFromPriorFiling: "newly-reported-holding",
		},
	],
	sourceEvidenceId: "ev_1",
};

export const pricingPowerRecord: PricingPowerRecord = {
	pricingPowerId: "pp_1",
	securityId: "sec_us_1",
	period: reportingPeriod,
	inputs: {
		revenueGrowthPct: 8,
		priceRealizationPct: 5,
		volumeGrowthPct: 1.5,
		mixEffectPct: 0.5,
		fxEffectPct: 0.25,
		inputCostChangePct: 2,
		grossMarginChangeBps: 120,
		operatingMarginChangeBps: 80,
		managementCommentaryEvidenceIds: ["ev_1"],
	},
	assessment: {
		classification: "corroborated-price-realization",
		missingInputs: [],
		unexplainedRevenueResidualPct: 0.75,
	},
	evidenceIds: ["ev_1"],
};

export const dataset: Dataset = {
	datasetId: "dataset_20",
	title: "Demand scenarios",
	columns: [
		{ key: "product", label: "Product", kind: "text" },
		{ key: "cagr", label: "Base CAGR", kind: "number", unit: "% per year" },
		{ key: "asOf", label: "As of", kind: "date" },
	],
	rows: [
		{
			product: { v: "Grid storage" },
			cagr: { v: 25, sourceId: "ev_1", asOf: "2026-10-01" },
			asOf: { v: "2026-10-01" },
		},
		{
			product: { v: "Heat pumps" },
			cagr: { v: null, reason: "No sourced baseline." },
			asOf: { v: null, reason: "Not applicable." },
		},
	],
	createdAt: T0,
};

export const researchBudget = {
	maxAgentSteps: 6,
	maxToolCalls: 20,
	maxWallClockMs: 600_000,
	maxInputBytes: 400_000,
	maxSpendUsd: null,
} as const;

export const researchRequest: ResearchRequest = {
	workspaceId: "ws_1",
	question: "Which products will see demand growth over the next five years?",
	agentId: "claude-code",
	model: null,
	effort: "medium",
	horizonYears: 5,
	markets: ["JP", "US"],
	budget: researchBudget,
	webAccess: "off",
};

export const resourceUsage = {
	agentSteps: 3,
	toolCalls: 7,
	inputBytes: 120_000,
	knownCostUsd: 0,
	hasUnmeteredUsage: true,
} as const;

export const researchRun: ResearchRun = {
	runId: "run_1",
	kind: "research",
	workspaceId: "ws_1",
	state: "collecting",
	request: researchRequest,
	usage: resourceUsage,
	cost: { status: "unknown-plan-limited", totalCostUsd: null, meteredPortionUsd: 0 },
	attempt: 1,
	maxAttempts: 3,
	leaseExpiresAt: T1,
	cancelRequested: false,
	failureCode: null,
	failureDetail: null,
	failureUpstreamStatus: null,
	approvalRequest: null,
	retryOfRunId: null,
	verificationStatus: null,
	providerModel: null,
	provenance: null,
	createdAt: T0,
	updatedAt: T1,
	progress: [{ at: T0, kind: "state", text: "claimed" }],
};

export const agentDescriptor: AgentDescriptor = {
	agentId: "claude-code",
	displayName: "Claude Code",
	capabilities: { supported: ["stream", "cancel"] },
	costModel: "plan-limited",
	toolIsolation: "enforced",
	availability: { status: "available" },
};

export const researchBundle: ResearchBundle = {
	evidence: [evidence],
	claims: [claim],
	scenarios: [demandScenario],
	securities: [jpSecurity, usSecurity],
	supplierLinks: [supplierLink],
	financialObservations: [availableObservation, unavailableObservation],
	positionObservations: [jpPosition, usPosition],
	investorFilings: [investorFiling],
	pricingPower: [pricingPowerRecord],
	datasets: [dataset],
	uiOperations: [
		{
			operation: "component.create",
			componentId: "demand_table_1",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "Demand scenarios", datasetRef: "dataset_20", sourceIds: ["ev_1"] },
		},
	],
	answerText: "Grid storage demand is likely to grow; see the cited scenario.",
	answerClaimIds: ["claim_1"],
	verificationStatus: "verified",
	provenance: {
		agentId: "claude-code",
		providerModel: null,
		promptVersion: "research-v1",
		toolVersions: { "news.search": "1.0.0" },
		dataCutoffAt: T1,
	},
};

export const emptyBundle: ResearchBundle = {
	...researchBundle,
	evidence: [],
	claims: [],
	scenarios: [],
	securities: [],
	supplierLinks: [],
	financialObservations: [],
	positionObservations: [],
	investorFilings: [],
	pricingPower: [],
	datasets: [],
	uiOperations: [],
	answerClaimIds: [],
};

export const subscribedSource = {
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/rss",
	publisher: "Example Media",
	title: "Example Wire",
	licensePolicy: "headline-and-link-only",
} as const;

export const claimedResearchJob: Extract<ClaimedJob, { kind: "research" }> = {
	kind: "research",
	runId: "run_1",
	leaseGeneration: 1,
	leaseExpiresAt: T1,
	attempt: 1,
	heartbeatIntervalMs: 15_000,
	sources: [subscribedSource],
	request: researchRequest,
	priorUsage: {
		agentSteps: 0,
		toolCalls: 0,
		inputBytes: 0,
		knownCostUsd: 0,
		hasUnmeteredUsage: false,
	},
	workspaceComponents: [
		{ componentId: "demand_table_1", componentType: "data-table", title: "Demand scenarios" },
	],
	conversationContext: [],
};

export const ingestedArticle = {
	sourceId: "src_1",
	canonicalUrl: "https://news.example.com/articles/1",
	publisher: "Example Media",
	title: "Battery makers expand capacity",
	publishedAt: T0,
	retrievedAt: T1,
	contentFingerprint: SHA256,
	excerpt: null,
} as const;

export const sourceReport = { sourceId: "src_1", fetchedAt: T1, errorCode: null } as const;

export const chatMessage: ChatMessage = {
	messageId: "msg_1",
	seq: 0,
	role: "owner",
	text: "Which products will see demand growth?",
	runId: null,
	claimIds: [],
	createdAt: T0,
};

export const runRecords: RunRecords = {
	evidence: [evidence],
	claims: [claim],
	scenarios: [demandScenario],
	securities: [jpSecurity, usSecurity],
	supplierLinks: [supplierLink],
	financialObservations: [availableObservation, unavailableObservation],
	positionObservations: [jpPosition, usPosition],
	investorFilings: [investorFiling],
	pricingPower: [pricingPowerRecord],
};

export const workspaceState = {
	workspaceId: "ws_1",
	version: 5,
	components: [
		{
			componentId: "demand_table_1",
			componentType: "data-table",
			schemaVersion: 1,
			props: { title: "Demand scenarios", datasetRef: "dataset_20", sourceIds: ["ev_1"] },
		},
	],
	layout: { order: ["demand_table_1"], columns: 1 },
	focusedComponentId: null,
	selection: null,
	lastNavigation: null,
} as const;

export const workspaceSummary = {
	workspaceId: "ws_1",
	title: "Energy storage",
	version: 5,
	createdAt: T0,
	updatedAt: T1,
} as const;

/** Section 7 of ARCHITECTURE_AND_REQUIREMENTS.md, verbatim. */
export const SECTION_7_EXAMPLE_COMMAND: unknown = JSON.parse(`{
  "protocolVersion": 1,
  "commandId": "cmd_123",
  "workspaceId": "ws_1",
  "expectedWorkspaceVersion": 4,
  "operation": "component.create",
  "componentId": "demand_table_1",
  "componentType": "data-table",
  "schemaVersion": 1,
  "props": {
    "title": "Demand scenarios",
    "datasetRef": "dataset_20",
    "sourceIds": ["source_11"]
  }
}`);
