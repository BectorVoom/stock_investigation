import { env } from "cloudflare:test";
import type {
	Clock,
	Persistence,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import {
	type AgentDescriptor,
	apiErrorBodySchema,
	type ClaimedJob,
	type ComponentDefinition,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	claimJobResponseSchema,
	issuedRunnerCredentialSchema,
	type ResearchBundle,
	type ResearchRequest,
	researchRunResponseSchema,
	workspaceSummarySchema,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import type { z } from "zod";
import { createApp } from "../src/app.ts";

const ORIGIN = "http://localhost";
let ownerCounter = 0;

/** A clock tests can move, so lease expiry needs no real waiting. */
export function createTestClock(startIso = "2026-10-11T00:00:00.000Z") {
	let nowMs = Date.parse(startIso);
	const clock: Clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
	return {
		clock,
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

export interface FakeFetchCall {
	readonly url: string;
	readonly options: SafeFetchOptions;
}

/** A canned document's text, or the failure the safe fetcher reports for its URL. */
export type FakeDocument = string | SafeFetchError;

/**
 * Serves canned documents by URL; a `SafeFetchError` entry is returned as
 * that failure (an `HTTP_ERROR` carries the host's status); anything else
 * is a network error. Records every call.
 */
export function createFakeFetcher(documents: Readonly<Record<string, FakeDocument>>) {
	const calls: FakeFetchCall[] = [];
	const fetcher: SafeFetcher = {
		async fetchText(url, options) {
			calls.push({ url, options });
			const document = documents[url];
			if (document === undefined)
				return err({ code: "NETWORK_ERROR", detail: "no such test document" });
			if (typeof document !== "string") return err(document);
			return ok({ finalUrl: url, contentType: "application/xml", text: document });
		},
	};
	return { fetcher, calls };
}

export interface Harness {
	readonly ownerId: string;
	readonly time: ReturnType<typeof createTestClock>;
	readonly fetchCalls: FakeFetchCall[];
	/** Owner request with same-origin + CSRF headers already applied. */
	call(
		method: string,
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<Response>;
	/** Request with exactly the given headers (for auth/CSRF tests). */
	raw(
		method: string,
		path: string,
		init?: { body?: unknown; headers?: Record<string, string> },
	): Promise<Response>;
	runner(token: string, path: string, body: unknown): Promise<Response>;
}

/**
 * One isolated tenant per harness: every test gets a fresh owner id, and since
 * all storage is owner-scoped, tests cannot observe each other's rows.
 */
export function createHarness(
	options: {
		readonly documents?: Readonly<Record<string, FakeDocument>>;
		readonly extraComponents?: readonly ComponentDefinition[];
		readonly ownerId?: string;
		readonly time?: ReturnType<typeof createTestClock>;
		readonly persistence?: Persistence;
	} = {},
): Harness {
	ownerCounter += 1;
	const ownerId = options.ownerId ?? `owner-${ownerCounter}-${crypto.randomUUID()}@example.test`;
	const time = options.time ?? createTestClock();
	const fake = createFakeFetcher(options.documents ?? {});
	const app = createApp({
		overrides: {
			fetcher: fake.fetcher,
			clock: time.clock,
			ownerAuthenticator: async (request) =>
				request.headers.get("X-Test-Anonymous") === "1"
					? err("UNAUTHENTICATED")
					: ok({ ownerId, authMode: "local-dev" }),
			...(options.extraComponents === undefined
				? {}
				: { extraComponents: options.extraComponents }),
			...(options.persistence === undefined ? {} : { persistence: options.persistence }),
		},
	});
	const send = async (
		method: string,
		path: string,
		body: unknown,
		headers: Record<string, string>,
	) =>
		app.request(
			`${ORIGIN}/api/v1${path}`,
			{
				method,
				headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			{ DB: env.DB },
		);
	return {
		ownerId,
		time,
		fetchCalls: fake.calls,
		call: (method, path, body, headers = {}) =>
			send(method, path, body, { Origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE, ...headers }),
		raw: (method, path, init = {}) => send(method, path, init.body, init.headers ?? {}),
		runner: (token, path, body) =>
			send("POST", `/runner${path}`, body, { Authorization: `Bearer ${token}` }),
	};
}

export function idempotencyKey(): Record<string, string> {
	return { "Idempotency-Key": crypto.randomUUID().replaceAll("-", "") };
}

/** Parses a response body against its contract schema, so every test doubles as a contract test. */
export async function body<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
	const payload: unknown = await response.json();
	return schema.parse(payload);
}

/** The error payload of a failed response (a body can be read only once). */
export async function apiError(response: Response) {
	return (await body(response, apiErrorBodySchema)).error;
}

export async function errorCode(response: Response): Promise<string> {
	return (await apiError(response)).code;
}

export const AVAILABLE_AGENTS: AgentDescriptor[] = [
	{
		agentId: "claude-code",
		displayName: "Claude Code",
		capabilities: { supported: ["stream"] },
		costModel: "plan-limited",
		toolIsolation: "enforced",
		availability: { status: "available" },
	},
	{
		agentId: "openrouter",
		displayName: "OpenRouter",
		capabilities: { supported: ["stream", "cancel"] },
		costModel: "metered",
		toolIsolation: "enforced",
		availability: { status: "unavailable", reasonCode: "NOT_CONFIGURED", detail: "no API key" },
	},
];

export const CLAIM_BODY = { runnerVersion: "test-1", agents: AVAILABLE_AGENTS };

export async function issueRunnerToken(harness: Harness, label = "test runner"): Promise<string> {
	const response = await harness.call("POST", "/runner-credentials", { label, expiresInDays: 30 });
	if (response.status !== 201) {
		throw new Error(`could not issue runner credential: ${response.status}`);
	}
	return (await body(response, issuedRunnerCredentialSchema)).token;
}

export async function createWorkspace(harness: Harness, title = "Test workspace"): Promise<string> {
	const response = await harness.call("POST", "/workspaces", { title });
	if (response.status !== 201) throw new Error(`could not create workspace: ${response.status}`);
	return (await body(response, workspaceSummarySchema)).workspaceId;
}

export function researchRequest(
	workspaceId: string,
	overrides: Partial<ResearchRequest> = {},
): ResearchRequest {
	return {
		workspaceId,
		question: "Which products will see demand growth?",
		agentId: "claude-code",
		model: null,
		effort: "medium",
		horizonYears: 4,
		markets: ["JP", "US"],
		budget: {
			maxAgentSteps: 6,
			maxToolCalls: 20,
			maxWallClockMs: 600_000,
			maxInputBytes: 400_000,
			maxSpendUsd: null,
		},
		webAccess: "off",
		...overrides,
	};
}

export type ClaimedLease = ClaimedJob;

export async function queueRun(harness: Harness, workspaceId: string): Promise<string> {
	const response = await harness.call(
		"POST",
		"/research-runs",
		researchRequest(workspaceId),
		idempotencyKey(),
	);
	if (response.status !== 202) throw new Error(`could not queue run: ${response.status}`);
	return (await body(response, researchRunResponseSchema)).run.runId;
}

export async function claim(harness: Harness, token: string): Promise<ClaimedLease | null> {
	const response = await harness.runner(token, "/jobs/claim", CLAIM_BODY);
	if (response.status !== 200) throw new Error(`claim failed: ${response.status}`);
	return (await body(response, claimJobResponseSchema)).job;
}

export function stateEvents(
	harness: Harness,
	lease: ClaimedLease,
	states: readonly string[],
	firstSeq = 0,
) {
	return {
		leaseGeneration: lease.leaseGeneration,
		events: states.map((state, index) => ({
			seq: firstSeq + index,
			at: harness.time.clock.nowIso(),
			event: { type: "state", state },
		})),
	};
}

export const TO_PUBLISHING = ["planning", "collecting", "analyzing", "verifying", "publishing"];

/** Walks a claimed job to `publishing` in one events request. */
export async function advanceToPublishing(
	harness: Harness,
	token: string,
	lease: ClaimedLease,
): Promise<void> {
	const response = await harness.runner(
		token,
		`/jobs/${lease.runId}/events`,
		stateEvents(harness, lease, TO_PUBLISHING),
	);
	if (response.status !== 200) throw new Error(`could not advance run: ${response.status}`);
}

export const USAGE = {
	agentSteps: 3,
	toolCalls: 2,
	inputBytes: 1200,
	knownCostUsd: 0,
	hasUnmeteredUsage: true,
};

const CHECKSUM = "a".repeat(64);

/**
 * Hand-computed scenario fixture: baseline 100 over 4 years (2026 -> 2030).
 *   bear 10%/yr: 100 * 1.1^4 = 146.41
 *   base 20%/yr: 100 * 1.2^4 = 207.36
 *   bull 30%/yr: 100 * 1.3^4 = 285.61
 */
export const SCENARIO_TARGETS = { bear: 146.41, base: 207.36, bull: 285.61 };
export const SCENARIO_CAGR = { bear: 0.1, base: 0.2, bull: 0.3 };

/**
 * A small but complete, internally consistent bundle for `runId`: one supported
 * claim, one scenario, one supplier, one unavailable financial metric, a
 * dataset and two components that display them.
 */
export function bundleFor(runId: string, overrides: Partial<ResearchBundle> = {}): ResearchBundle {
	const id = (suffix: string) => `${runId}_${suffix}`;
	const now = "2026-10-11T00:00:00.000Z";
	return {
		evidence: [
			{
				evidenceId: id("ev1"),
				sourceUrl: "https://news.example.org/articles/grid-storage",
				title: "Grid storage orders rise",
				publisher: "Example News",
				publishedAt: "2026-10-01T00:00:00.000Z",
				retrievedAt: now,
				effectiveAt: null,
				excerpt: "Orders for grid storage reached 100 GWh in 2026.",
				checksum: CHECKSUM,
				sourceClass: "news",
			},
		],
		claims: [
			{
				claimId: id("cl1"),
				text: "Grid storage orders reached 100 GWh in 2026.",
				claimType: "observation",
				status: "supported",
				links: [
					{
						evidenceId: id("ev1"),
						relation: "supports",
						quote: "Orders for grid storage reached 100 GWh in 2026.",
					},
				],
				issues: [],
			},
		],
		scenarios: [
			{
				scenarioId: id("sc1"),
				productOrService: "Grid-scale battery storage",
				quantityKind: "unit-demand",
				unit: "GWh per year",
				baseYear: 2026,
				targetYear: 2030,
				baselineValue: 100,
				bear: { targetValue: SCENARIO_TARGETS.bear, assumptions: ["Permitting delays persist"] },
				base: { targetValue: SCENARIO_TARGETS.base, assumptions: ["Order trend continues"] },
				bull: { targetValue: SCENARIO_TARGETS.bull, assumptions: ["Subsidies are extended"] },
				drivers: ["Renewable build-out"],
				barriers: ["Interconnection queues"],
				falsifiers: ["Orders fall for two consecutive years"],
				methodology: "Order-book extrapolation from the cited baseline.",
				derivedCagr: SCENARIO_CAGR,
				baselineEvidenceId: id("ev1"),
				baselineQuote: "Orders for grid storage reached 100 GWh in 2026.",
				supportingEvidenceIds: [id("ev1")],
				contraryEvidenceIds: [],
			},
		],
		securities: [
			{
				securityId: id("sec1"),
				country: "US",
				ticker: "EXMP",
				exchange: "NASDAQ",
				issuerName: "Example Storage Corp",
				issuerIdentifier: null,
				listingCurrency: "USD",
				reportingCurrency: "USD",
				listingVerification: "unverified",
				formerTickers: [],
			},
		],
		supplierLinks: [
			{
				supplierLinkId: id("sup1"),
				scenarioId: id("sc1"),
				securityId: id("sec1"),
				productsOrServices: ["Battery systems"],
				businessExposure: "Sells grid storage systems.",
				evidenceIds: [id("ev1")],
				relationshipQuote: null,
			},
		],
		financialObservations: [
			{
				observationId: id("fo1"),
				securityId: id("sec1"),
				metricCode: "trailing-per",
				value: null,
				unavailableReason: "no licensed price source configured",
				unit: "ratio",
				currency: null,
				accountingStandard: null,
				period: null,
				actualOrEstimate: "actual",
				marketDataAsOf: null,
				formula: "price / EPS",
				sourceEvidenceId: null,
			},
		],
		positionObservations: [],
		investorFilings: [],
		pricingPower: [],
		datasets: [
			{
				datasetId: id("ds_scenarios"),
				title: "Demand scenarios",
				columns: [
					{ key: "product", label: "Product", kind: "text" },
					{ key: "base", label: "Base target", kind: "number", unit: "GWh per year" },
				],
				rows: [
					{
						product: { v: "Grid-scale battery storage" },
						base: { v: SCENARIO_TARGETS.base, sourceId: id("ev1"), asOf: "2026-10-01" },
					},
				],
				createdAt: now,
			},
		],
		uiOperations: [
			{
				operation: "component.create",
				componentId: `${runId}_table`,
				componentType: "data-table",
				schemaVersion: 1,
				props: {
					title: "Demand scenarios",
					datasetRef: id("ds_scenarios"),
					sourceIds: [id("ev1")],
				},
			},
			{
				operation: "component.create",
				componentId: `${runId}_sources`,
				componentType: "source-list",
				schemaVersion: 1,
				props: { title: "Sources", sourceIds: [id("ev1")] },
			},
		],
		answerText: "Grid storage demand is growing.",
		answerClaimIds: [id("cl1")],
		verificationStatus: "partially-verified",
		provenance: {
			agentId: "claude-code",
			providerModel: null,
			promptVersion: "research-v1",
			toolVersions: { "news.fetch_feed": "1" },
			dataCutoffAt: now,
		},
		...overrides,
	};
}

export function completion(lease: ClaimedLease, bundle: ResearchBundle) {
	return {
		outcome: "completed",
		leaseGeneration: lease.leaseGeneration,
		usage: USAGE,
		bundle,
		articles: [],
		sourceReports: [],
	};
}

/** Queues a run, claims it, walks it to `publishing` and completes it with the default bundle. */
export async function completeRun(harness: Harness, token: string, workspaceId: string) {
	const runId = await queueRun(harness, workspaceId);
	const lease = await claim(harness, token);
	if (lease === null || lease.runId !== runId) throw new Error("expected to claim the queued run");
	await advanceToPublishing(harness, token, lease);
	const response = await harness.runner(
		token,
		`/jobs/${runId}/complete`,
		completion(lease, bundleFor(runId)),
	);
	if (response.status !== 200) {
		throw new Error(`completion failed: ${response.status} ${await response.text()}`);
	}
	return { runId, lease };
}
