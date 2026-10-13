import { z } from "zod";
import { agentDescriptorSchema } from "./agent.ts";
import { researchBudgetSchema, researchRequestSchema, researchRunSchema } from "./jobs.ts";
import {
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	shortTextSchema,
} from "./primitives.ts";
import {
	articleSchema,
	claimSchema,
	datasetSchema,
	demandScenarioSchema,
	evidenceSchema,
	financialObservationSchema,
	investorFilingSchema,
	licensePolicySchema,
	newsSourceSchema,
	positionObservationSchema,
	pricingPowerRecordSchema,
	securitySchema,
	sourceTypeSchema,
	supplierLinkSchema,
	trustClassificationSchema,
} from "./records.ts";
import { uiCommandSchema, workspaceStateSchema } from "./ui.ts";

export const API_PREFIX = "/api/v1";
export const RUNNER_API_PREFIX = "/api/v1/runner";
export const MAX_REQUEST_BODY_BYTES = 1_000_000;

export const sessionResponseSchema = z.strictObject({
	ownerId: z.string(),
	authMode: z.enum(["cloudflare-access", "local-dev"]),
	/**
	 * Which local environment this API runs in (ADR-0011). The SPA shows a
	 * "Development" badge for "development" and nothing extra for
	 * "production"; an unknown or missing value is treated as "production".
	 */
	environment: z.enum(["development", "production"]),
});
export type AppEnvironment = z.infer<typeof sessionResponseSchema>["environment"];

/**
 * Which built release the API serves (ADR-0011, release generations). The
 * generation id and build time are baked into the release at build time, so a
 * running instance keeps reporting the generation it started with even while
 * a newer generation is built. Null when the Worker was not started from a
 * release (development, tests). Nothing sensitive: ids and timestamps only.
 */
export const versionResponseSchema = z.strictObject({
	generation: z.string().min(1).nullable(),
	builtAt: z.string().min(1).nullable(),
	environment: z.enum(["development", "production"]),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

/* ---------- Sources ---------- */

export const previewSourceRequestSchema = z.strictObject({ url: z.string().min(1).max(2048) });

export const sourcePreviewSchema = z.strictObject({
	canonicalUrl: httpsUrlSchema,
	sourceType: sourceTypeSchema,
	title: z.string().max(300),
	siteLink: httpsUrlSchema.nullable(),
	suggestedPublisher: z.string().max(300),
	itemCount: z.number().int().nonnegative(),
	rejectedItemCount: z.number().int().nonnegative(),
	sampleItems: z
		.array(
			z.strictObject({
				title: z.string(),
				canonicalUrl: httpsUrlSchema,
				publishedAt: isoDateTimeSchema.nullable(),
			}),
		)
		.max(5),
	/** Whether this owner already subscribes to the feed. */
	alreadySubscribed: z.boolean(),
});
export type SourcePreview = z.infer<typeof sourcePreviewSchema>;

export const registerSourceRequestSchema = z.strictObject({
	url: z.string().min(1).max(2048),
	title: shortTextSchema.optional(),
	publisher: shortTextSchema.optional(),
	licensePolicy: licensePolicySchema,
	trustClassification: trustClassificationSchema,
});
export type RegisterSourceRequest = z.infer<typeof registerSourceRequestSchema>;

export const updateSourceRequestSchema = z
	.strictObject({
		title: shortTextSchema.optional(),
		publisher: shortTextSchema.optional(),
		licensePolicy: licensePolicySchema.optional(),
		trustClassification: trustClassificationSchema.optional(),
		feedStatus: z.enum(["active", "paused"]).optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, { message: "no fields to update" });
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;

export const sourceListResponseSchema = z.strictObject({ sources: z.array(newsSourceSchema) });

export const recommendedSourceSchema = z.strictObject({
	catalogId: idSchema,
	title: shortTextSchema,
	publisher: shortTextSchema,
	feedUrl: httpsUrlSchema,
	homepageUrl: httpsUrlSchema,
	region: z.enum(["JP", "US", "GLOBAL"]),
	language: z.enum(["en", "ja"]),
	trustClassification: trustClassificationSchema,
	/** Conservative default; the owner confirms licensing when subscribing. */
	licensePolicy: licensePolicySchema,
	rationale: z.string().min(1).max(400),
	/** Date the feed URL was last checked to respond with a parseable feed. */
	feedCheckedOn: isoDateSchema,
});
export type RecommendedSource = z.infer<typeof recommendedSourceSchema>;

export const recommendedSourcesResponseSchema = z.strictObject({
	entries: z.array(recommendedSourceSchema),
});

export const articleListResponseSchema = z.strictObject({
	articles: z.array(articleSchema),
	/** Opaque cursor for the next page; null when exhausted. */
	nextCursor: z.string().nullable(),
});

/* ---------- Research runs ---------- */

export const createResearchRunRequestSchema = researchRequestSchema;
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const researchRunResponseSchema = z.strictObject({ run: researchRunSchema });
export const researchRunListResponseSchema = z.strictObject({ runs: z.array(researchRunSchema) });

export const approveRunRequestSchema = z.strictObject({
	/** Replacement ceilings the owner consents to for the resumed run. */
	budget: researchBudgetSchema,
});

export const runRecordsResponseSchema = z.strictObject({
	evidence: z.array(evidenceSchema),
	claims: z.array(claimSchema),
	scenarios: z.array(demandScenarioSchema),
	securities: z.array(securitySchema),
	supplierLinks: z.array(supplierLinkSchema),
	financialObservations: z.array(financialObservationSchema),
	positionObservations: z.array(positionObservationSchema),
	investorFilings: z.array(investorFilingSchema),
	pricingPower: z.array(pricingPowerRecordSchema),
});
export type RunRecords = z.infer<typeof runRecordsResponseSchema>;

export const agentsResponseSchema = z.strictObject({
	agents: z.array(agentDescriptorSchema),
	/** null until a runner has ever reported in. */
	runnerLastSeenAt: isoDateTimeSchema.nullable(),
	runnerOnline: z.boolean(),
});
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

/* ---------- Workspaces ---------- */

export const workspaceSummarySchema = z.strictObject({
	workspaceId: idSchema,
	title: shortTextSchema,
	version: z.number().int().nonnegative(),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

/** Title a conversation carries until its first question names it. */
export const DEFAULT_CONVERSATION_TITLE = "New chat";

/** `title` omitted: the conversation starts as DEFAULT_CONVERSATION_TITLE. */
export const createWorkspaceRequestSchema = z.strictObject({ title: shortTextSchema.optional() });
export const renameWorkspaceRequestSchema = z.strictObject({ title: shortTextSchema });
export const workspaceListResponseSchema = z.strictObject({
	workspaces: z.array(workspaceSummarySchema),
});

/** Everything the SPA needs to render a workspace in one round trip (no N+1 fetches). */
export const workspaceViewSchema = z.strictObject({
	workspace: workspaceSummarySchema,
	state: workspaceStateSchema,
	datasets: z.array(datasetSchema),
	sources: z.array(evidenceSchema),
});
export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const workspaceEventSchema = z.strictObject({
	/** Workspace version produced by applying this command. */
	version: z.number().int().positive(),
	command: uiCommandSchema,
	appliedAt: isoDateTimeSchema,
	origin: z.enum(["owner", "agent"]),
});
export const workspaceEventsResponseSchema = z.strictObject({
	events: z.array(workspaceEventSchema),
	currentVersion: z.number().int().nonnegative(),
});

export const submitCommandResponseSchema = z.strictObject({
	state: workspaceStateSchema,
	/** True when this commandId had already been applied (no state change). */
	replayed: z.boolean(),
});

export const chatMessageSchema = z.strictObject({
	messageId: idSchema,
	seq: z.number().int().nonnegative(),
	role: z.enum(["owner", "assistant"]),
	text: z.string().max(6000),
	runId: idSchema.nullable(),
	claimIds: z.array(idSchema),
	createdAt: isoDateTimeSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationResponseSchema = z.strictObject({
	messages: z.array(chatMessageSchema),
	/** Claims and evidence referenced by the messages, for linked citations. */
	claims: z.array(claimSchema),
	evidence: z.array(evidenceSchema),
	/** True when the workspace holds at least one message older than those returned. */
	hasEarlier: z.boolean(),
});
export type Conversation = z.infer<typeof conversationResponseSchema>;

export const conversationSummarySchema = z.strictObject({
	workspaceId: idSchema,
	title: shortTextSchema,
	messageCount: z.number().int().nonnegative(),
	/** null for a workspace nobody has written in yet. */
	lastMessageAt: isoDateTimeSchema.nullable(),
	lastMessageRole: z.enum(["owner", "assistant"]).nullable(),
	/** First 160 characters of the last message, plain text. */
	lastMessagePreview: z.string().max(160).nullable(),
	/** Sort key: lastMessageAt, or the workspace's createdAt when it has no messages. */
	lastActivityAt: isoDateTimeSchema,
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const conversationListResponseSchema = z.strictObject({
	conversations: z.array(conversationSummarySchema),
});
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

/* ---------- Runner credentials ---------- */

export const runnerCredentialSchema = z.strictObject({
	credentialId: idSchema,
	label: shortTextSchema,
	createdAt: isoDateTimeSchema,
	expiresAt: isoDateTimeSchema,
	revokedAt: isoDateTimeSchema.nullable(),
	lastUsedAt: isoDateTimeSchema.nullable(),
});
export type RunnerCredential = z.infer<typeof runnerCredentialSchema>;

export const issueRunnerCredentialRequestSchema = z.strictObject({
	label: shortTextSchema,
	expiresInDays: z.number().int().min(1).max(90),
});
/** The bearer token is returned exactly once; only its hash is stored. */
export const issuedRunnerCredentialSchema = z.strictObject({
	credential: runnerCredentialSchema,
	token: z.string().min(40),
});
export const runnerCredentialListResponseSchema = z.strictObject({
	credentials: z.array(runnerCredentialSchema),
});
/** Answer to a runner asking whether its token is still accepted (no side effect). */
export const runnerCredentialCheckResponseSchema = z.strictObject({ credentialId: idSchema });
export type RunnerCredentialCheck = z.infer<typeof runnerCredentialCheckResponseSchema>;

/**
 * Cookie-authenticated writes must carry this header (API-005). Browsers cannot
 * add a custom header cross-origin without a CORS preflight, which the API never grants.
 */
export const CSRF_HEADER = "X-Research-Csrf";
export const CSRF_HEADER_VALUE = "1";
