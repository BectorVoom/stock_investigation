import type { AppliedCommand, JobRecord, WorkspaceRecord } from "@research/application";
import {
	type AgentSettings,
	type Article,
	agentSettingsSchema,
	articleSchema,
	bundleProvenanceSchema,
	type ChatMessage,
	type ConversationSummary,
	chatMessageSchema,
	conversationSummarySchema,
	type EarningsTiming,
	type EarningsUnavailableCode,
	earningsTimingSchema,
	earningsUnavailableCodeSchema,
	type HomeDashboard,
	homeDashboardSchema,
	type NewsSource,
	newsSourceSchema,
	type RunnerCredential,
	researchRequestSchema,
	resourceUsageSchema,
	runnerCredentialSchema,
	STABLE_FAILURE_CODE_PATTERN,
	uiCommandSchema,
	type WatchMarket,
	type WorkspaceSummary,
	watchMarketSchema,
	workspaceStateSchema,
	workspaceSummarySchema,
} from "@research/contracts";
import { isJobState, type WorkspaceState } from "@research/domain";
import { z } from "zod";

/**
 * Row decoding. SQL drivers return untyped rows and stored JSON may predate the current
 * schema, so everything read from the database is validated against the shared
 * contracts (API-002) instead of being cast.
 */
export class StoredDataError extends Error {
	constructor(table: string, detail: string) {
		super(`stored ${table} row failed validation: ${detail}`);
		this.name = "StoredDataError";
	}
}

export function decode<T>(table: string, schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const paths = parsed.error.issues
			.slice(0, 3)
			.map((issue) => issue.path.join("."))
			.join(", ");
		throw new StoredDataError(table, paths);
	}
	return parsed.data;
}

/** Parses a JSON text column; malformed JSON is a storage fault, not user input. */
export function parseJsonColumn<T>(table: string, schema: z.ZodType<T>, text: unknown): T {
	if (typeof text !== "string") throw new StoredDataError(table, "JSON column is not text");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new StoredDataError(table, "JSON column is not parseable");
	}
	return decode(table, schema, value);
}

const nullableText = z.string().nullable();

const sourceRowSchema = z.object({
	source_id: z.string(),
	canonical_url: z.string(),
	source_type: z.string(),
	title: z.string(),
	publisher: z.string(),
	license_policy: z.string(),
	trust_classification: z.string(),
	feed_status: z.string(),
	last_fetched_at: nullableText,
	last_error_code: nullableText,
	created_at: z.string(),
	updated_at: z.string(),
});

export function toNewsSource(row: unknown): NewsSource {
	const r = decode("news_sources", sourceRowSchema, row);
	return decode("news_sources", newsSourceSchema, {
		sourceId: r.source_id,
		canonicalUrl: r.canonical_url,
		sourceType: r.source_type,
		title: r.title,
		publisher: r.publisher,
		licensePolicy: r.license_policy,
		trustClassification: r.trust_classification,
		feedStatus: r.feed_status,
		lastFetchedAt: r.last_fetched_at,
		lastErrorCode: r.last_error_code,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	});
}

const articleRowSchema = z.object({
	article_id: z.string(),
	source_id: z.string(),
	canonical_url: z.string(),
	publisher: z.string(),
	title: z.string(),
	published_at: nullableText,
	retrieved_at: z.string(),
	content_fingerprint: z.string(),
	excerpt: nullableText,
});

export function toArticle(row: unknown): Article {
	const r = decode("articles", articleRowSchema, row);
	return decode("articles", articleSchema, {
		articleId: r.article_id,
		sourceId: r.source_id,
		canonicalUrl: r.canonical_url,
		publisher: r.publisher,
		title: r.title,
		publishedAt: r.published_at,
		retrievedAt: r.retrieved_at,
		contentFingerprint: r.content_fingerprint,
		excerpt: r.excerpt,
	});
}

const jobRowSchema = z.object({
	owner_id: z.string(),
	run_id: z.string(),
	kind: z.enum(["research", "news-ingest", "market-refresh", "earnings-refresh"]),
	state: z.string(),
	request_json: nullableText,
	workspace_id: nullableText,
	usage_json: z.string(),
	attempt: z.number(),
	max_attempts: z.number(),
	lease_generation: z.number(),
	lease_owner_id: nullableText,
	lease_expires_at: nullableText,
	last_event_seq: z.number(),
	cancel_requested: z.number(),
	failure_code: nullableText,
	failure_detail: nullableText.nullish(),
	approval_request_json: nullableText,
	retry_of_run_id: nullableText,
	// Optional so a row written before migration 0003 (no such column) still
	// decodes; a missing anchor claims an empty context (fail closed).
	context_anchor_seq: z.number().nullable().optional(),
	verification_status: z.enum(["verified", "partially-verified", "unverified"]).nullable(),
	provider_model: nullableText,
	provider_session_ref: nullableText,
	completed_generation: z.number().nullable(),
	provenance_json: nullableText,
	version: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	request_fingerprint: z.string(),
});

const approvalRequestSchema = z.object({ reasonCode: z.string(), detail: z.string() });

export function toJobRecord(row: unknown): JobRecord & { readonly requestFingerprint: string } {
	const r = decode("research_jobs", jobRowSchema, row);
	if (!isJobState(r.state)) throw new StoredDataError("research_jobs", "state");
	// Finding 10: `failure_detail` is a stable code, never free text. Old rows
	// predate the rule and must still decode, so an unstable or mis-tied value
	// decodes to null instead of throwing (fail closed, ARCH-017).
	const rawDetail = r.failure_detail ?? null;
	const failureDetail =
		rawDetail !== null &&
		STABLE_FAILURE_CODE_PATTERN.test(rawDetail) &&
		r.failure_code === "ALL_TOOL_CALLS_FAILED"
			? rawDetail
			: null;
	return {
		runId: r.run_id,
		ownerId: r.owner_id,
		kind: r.kind,
		state: r.state,
		request:
			r.request_json === null
				? null
				: parseJsonColumn("research_jobs", researchRequestSchema, r.request_json),
		workspaceId: r.workspace_id,
		usage: parseJsonColumn("research_jobs", resourceUsageSchema, r.usage_json),
		attempt: r.attempt,
		maxAttempts: r.max_attempts,
		leaseGeneration: r.lease_generation,
		leaseOwnerId: r.lease_owner_id,
		leaseExpiresAt: r.lease_expires_at,
		lastEventSeq: r.last_event_seq,
		cancelRequested: r.cancel_requested !== 0,
		failureCode: r.failure_code,
		// Rows written before the failure-detail migration have no column.
		failureDetail,
		approvalRequest:
			r.approval_request_json === null
				? null
				: parseJsonColumn("research_jobs", approvalRequestSchema, r.approval_request_json),
		retryOfRunId: r.retry_of_run_id,
		contextAnchorSeq: r.context_anchor_seq ?? null,
		verificationStatus: r.verification_status,
		providerModel: r.provider_model,
		providerSessionRef: r.provider_session_ref,
		completedGeneration: r.completed_generation,
		provenance:
			r.provenance_json === null
				? null
				: parseJsonColumn("research_jobs", bundleProvenanceSchema, r.provenance_json),
		version: r.version,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		requestFingerprint: r.request_fingerprint,
	};
}

const workspaceRowSchema = z.object({
	workspace_id: z.string(),
	title: z.string(),
	version: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
});

export function toWorkspaceSummary(row: unknown): WorkspaceSummary {
	const r = decode("workspaces", workspaceRowSchema, row);
	return decode("workspaces", workspaceSummarySchema, {
		workspaceId: r.workspace_id,
		title: r.title,
		version: r.version,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	});
}

export function toWorkspaceRecord(row: unknown): WorkspaceRecord {
	const state = decode("workspaces", z.object({ state_json: z.string() }), row);
	const stored = parseJsonColumn("workspaces", workspaceStateSchema, state.state_json);
	return {
		summary: toWorkspaceSummary(row),
		// Stored rows may predate the withdrawal of approved images (owner's decision of
		// 2026-10-13): drop `image-gallery` components here, at the single decode choke point
		// every workspace read flows through, rather than rewriting stored JSON in a migration.
		// Rewriting would need identical JSON surgery in SQL on both backends (D1 and SQLite,
		// ADR-0008) and would have to neutralise history entries without breaking the
		// (owner_id, workspace_id, version) continuity that compare-and-set writes and event
		// polling rely on. Stripping on read keeps the version sequence untouched — the stored
		// version column and the stripped state's version stay equal, so compare-and-set keeps
		// working — while the command history is preserved verbatim for audit. The next owner
		// or agent write persists the stripped state naturally.
		state: dropWithdrawnImageComponents(stored),
	};
}

/**
 * Removes `image-gallery` components from a stored canvas state read from the
 * database. Layout order, focus and selection are repaired so the result still
 * satisfies the workspace invariants; the version is untouched.
 */
function dropWithdrawnImageComponents(state: WorkspaceState): WorkspaceState {
	if (!state.components.some((component) => component.componentType === "image-gallery")) {
		return state;
	}
	const kept = state.components.filter((component) => component.componentType !== "image-gallery");
	const keptIds = new Set(kept.map((component) => component.componentId));
	return {
		...state,
		components: kept,
		layout: {
			...state.layout,
			order: state.layout.order.filter((id) => keptIds.has(id)),
		},
		focusedComponentId:
			state.focusedComponentId !== null && keptIds.has(state.focusedComponentId)
				? state.focusedComponentId
				: null,
		selection:
			state.selection !== null && keptIds.has(state.selection.componentId) ? state.selection : null,
	};
}

const commandRowSchema = z.object({
	version: z.number(),
	command_json: z.string(),
	origin: z.enum(["owner", "agent"]),
	applied_at: z.string(),
});

export function toAppliedCommand(row: unknown): AppliedCommand {
	const r = decode("workspace_commands", commandRowSchema, row);
	return {
		version: r.version,
		command: parseJsonColumn("workspace_commands", uiCommandSchema, r.command_json),
		appliedAt: r.applied_at,
		origin: r.origin,
	};
}

const messageRowSchema = z.object({
	message_id: z.string(),
	seq: z.number(),
	role: z.string(),
	text: z.string(),
	run_id: nullableText,
	claim_ids_json: z.string(),
	created_at: z.string(),
});

export function toChatMessage(row: unknown): ChatMessage {
	const r = decode("chat_messages", messageRowSchema, row);
	return decode("chat_messages", chatMessageSchema, {
		messageId: r.message_id,
		seq: r.seq,
		role: r.role,
		text: r.text,
		runId: r.run_id,
		claimIds: parseJsonColumn("chat_messages", z.array(z.string()), r.claim_ids_json),
		createdAt: r.created_at,
	});
}

const conversationSummaryRowSchema = z.object({
	workspace_id: z.string(),
	title: z.string(),
	message_count: z.number(),
	last_message_at: nullableText,
	last_role: nullableText,
	last_preview: nullableText,
	last_activity_at: z.string(),
});

/** Decodes one `listConversations` row; the preview was already cut in SQL. */
export function toConversationSummary(row: unknown): ConversationSummary {
	const r = decode("conversations", conversationSummaryRowSchema, row);
	return decode("conversations", conversationSummarySchema, {
		workspaceId: r.workspace_id,
		title: r.title,
		messageCount: r.message_count,
		lastMessageAt: r.last_message_at,
		lastMessageRole: r.last_role,
		lastMessagePreview: r.last_preview,
		lastActivityAt: r.last_activity_at,
	});
}

const credentialRowSchema = z.object({
	owner_id: z.string(),
	credential_id: z.string(),
	label: z.string(),
	created_at: z.string(),
	expires_at: z.string(),
	revoked_at: nullableText,
	last_used_at: nullableText,
});

export function toRunnerCredential(row: unknown): RunnerCredential & { readonly ownerId: string } {
	const r = decode("runner_credentials", credentialRowSchema, row);
	const credential = decode("runner_credentials", runnerCredentialSchema, {
		credentialId: r.credential_id,
		label: r.label,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		revokedAt: r.revoked_at,
		lastUsedAt: r.last_used_at,
	});
	return { ...credential, ownerId: r.owner_id };
}

const ownerSettingsRowSchema = z.object({
	agent_settings_json: z.string(),
	updated_at: z.string(),
});

export function toStoredAgentSettings(row: unknown): {
	readonly settings: AgentSettings;
	readonly updatedAt: string;
} {
	const r = decode("owner_settings", ownerSettingsRowSchema, row);
	return {
		settings: parseJsonColumn("owner_settings", agentSettingsSchema, r.agent_settings_json),
		updatedAt: r.updated_at,
	};
}

/** Decodes a `body_json` column with the given contract schema. */
export function bodyOf<T>(table: string, schema: z.ZodType<T>, row: unknown): T {
	const r = decode(table, z.object({ body_json: z.string() }), row);
	return parseJsonColumn(table, schema, r.body_json);
}

export function textColumn(table: string, column: string, row: unknown): string {
	const r = decode(table, z.record(z.string(), z.unknown()), row);
	const value = r[column];
	if (typeof value !== "string") throw new StoredDataError(table, column);
	return value;
}

export function numberColumn(table: string, column: string, row: unknown): number {
	const r = decode(table, z.record(z.string(), z.unknown()), row);
	const value = r[column];
	if (typeof value !== "number") throw new StoredDataError(table, column);
	return value;
}

const homeDashboardRowSchema = z.object({
	dashboard_json: z.string(),
	version: z.number(),
	updated_at: z.string(),
});

/** A stored dashboard that no longer parses is a typed failure (fail closed). */
export function toHomeDashboardRecord(row: unknown): {
	readonly dashboard: HomeDashboard;
	readonly version: number;
	readonly updatedAt: string;
} {
	const r = decode("home_dashboards", homeDashboardRowSchema, row);
	return {
		dashboard: parseJsonColumn("home_dashboards", homeDashboardSchema, r.dashboard_json),
		version: r.version,
		updatedAt: r.updated_at,
	};
}

const watchlistStockRowSchema = z.object({
	stock_id: z.string(),
	market: z.string(),
	symbol: z.string(),
	name: z.string().nullable(),
	added_at: z.string(),
	last_refreshed_at: z.string().nullable(),
	retrieved_at: z.string().nullable(),
	unavailable_code: z.string().nullable(),
});

export function toStoredWatchlistStock(row: unknown): {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly name: string | null;
	readonly addedAt: string;
	readonly lastRefreshedAt: string | null;
	readonly retrievedAt: string | null;
	readonly unavailableCode: EarningsUnavailableCode | null;
} {
	const r = decode("watchlist_stocks", watchlistStockRowSchema, row);
	return {
		stockId: r.stock_id,
		market: decode("watchlist_stocks", watchMarketSchema, r.market),
		symbol: r.symbol,
		name: r.name,
		addedAt: r.added_at,
		lastRefreshedAt: r.last_refreshed_at,
		retrievedAt: r.retrieved_at,
		unavailableCode:
			r.unavailable_code === null
				? null
				: decode("watchlist_stocks", earningsUnavailableCodeSchema, r.unavailable_code),
	};
}

const earningsEventRowSchema = z.object({
	stock_id: z.string(),
	period_key: z.string(),
	announcement_date: z.string().nullable(),
	fiscal_period_label: z.string(),
	fiscal_period_end: z.string().nullable(),
	timing: z.string(),
});

export function toStoredEarningsEvent(row: unknown): {
	readonly stockId: string;
	readonly periodKey: string;
	readonly announcementDate: string | null;
	readonly fiscalPeriodLabel: string;
	readonly fiscalPeriodEnd: string | null;
	readonly timing: EarningsTiming;
} {
	const r = decode("earnings_events", earningsEventRowSchema, row);
	return {
		stockId: r.stock_id,
		periodKey: r.period_key,
		announcementDate: r.announcement_date,
		fiscalPeriodLabel: r.fiscal_period_label,
		fiscalPeriodEnd: r.fiscal_period_end,
		timing: decode("earnings_events", earningsTimingSchema, r.timing),
	};
}

const calendarFeedRowSchema = z.object({
	token_hash: z.string(),
	created_at: z.string(),
});

export function toCalendarFeedRecord(row: unknown): {
	readonly tokenHash: string;
	readonly createdAt: string;
} {
	const r = decode("calendar_feeds", calendarFeedRowSchema, row);
	return { tokenHash: r.token_hash, createdAt: r.created_at };
}

const marketSeriesRowSchema = z.object({
	series_id: z.string(),
	provider: z.string(),
	symbol: z.string(),
	title: z.string(),
	unit: z.string(),
	frequency: z.string(),
	publisher: z.string(),
	source_url: z.string(),
	last_refreshed_at: z.string().nullable(),
	retrieved_at: z.string().nullable(),
	unavailable_code: z.string().nullable(),
});

const marketFrequencySchema = z.enum([
	"daily",
	"weekly",
	"monthly",
	"quarterly",
	"annual",
	"unknown",
]);
const marketUnavailableCodeSchema = z.enum([
	"NEVER_REFRESHED",
	"SOURCE_NOT_CONFIGURED",
	"SOURCE_AUTH_FAILED",
	"SERIES_NOT_FOUND",
	"PLAN_NOT_ENTITLED",
	"RATE_LIMITED",
	"NO_DATA",
	"SOURCE_FAILED",
]);

export function toStoredMarketSeries(row: unknown): {
	readonly seriesId: string;
	readonly provider: "fred" | "twelve-data";
	readonly symbol: string;
	readonly title: string;
	readonly unit: string;
	readonly frequency: "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "unknown";
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly lastRefreshedAt: string | null;
	readonly retrievedAt: string | null;
	readonly unavailableCode:
		| "NEVER_REFRESHED"
		| "SOURCE_NOT_CONFIGURED"
		| "SOURCE_AUTH_FAILED"
		| "SERIES_NOT_FOUND"
		| "PLAN_NOT_ENTITLED"
		| "RATE_LIMITED"
		| "NO_DATA"
		| "SOURCE_FAILED"
		| null;
} {
	const r = decode("market_series", marketSeriesRowSchema, row);
	const provider = r.provider === "twelve-data" ? "twelve-data" : "fred";
	if (r.provider !== "fred" && r.provider !== "twelve-data") {
		throw new StoredDataError("market_series", "provider");
	}
	return {
		seriesId: r.series_id,
		provider,
		symbol: r.symbol,
		title: r.title,
		unit: r.unit,
		frequency: decode("market_series", marketFrequencySchema, r.frequency),
		publisher: r.publisher,
		sourceUrl: r.source_url,
		lastRefreshedAt: r.last_refreshed_at,
		retrievedAt: r.retrieved_at,
		unavailableCode:
			r.unavailable_code === null
				? null
				: decode("market_series", marketUnavailableCodeSchema, r.unavailable_code),
	};
}
