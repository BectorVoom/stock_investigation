import {
	COMPANY_SUMMARY_LIMITS,
	type CompanySummaryFacts,
	type CompanySummaryJobRequest,
	type CompleteJobRequest,
	companySummaryFactsSchema,
	companySummaryJobRequestSchema,
	type JobAgentChoice,
	type WatchMarket,
} from "@research/contracts";
import { err, ok, parseStockId, type Result, truncateText } from "@research/domain";
import { type SyncCheckGate, scheduledJobRecord } from "./dataSync.ts";
import type { EquitySyncRepository } from "./equitySyncPorts.ts";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	CompanySummaryEffects,
	CompanySummaryRepository,
	CompanySummarySchedule,
	IdGenerator,
	JobRecord,
	JobRepository,
	SettingsRepository,
	StockDirectoryRepository,
	StoredWatchlistStock,
	WatchlistRepository,
} from "./ports.ts";
import { JOB_ADMISSION, MODEL_REQUIRED_AGENT_IDS } from "./researchRuns.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** How often an owner's schedule is looked at (the `gate`'s period). */
export const COMPANY_SUMMARY_CHECK_INTERVAL_MS = 60_000;

/**
 * AI-written company summaries (ADR-0060): at claim time the server queues
 * one `company-summary` job at a time, for the first Watchlist stock whose
 * summary is missing or older than `refreshAfterDays` and that was not
 * queued in the last `retryAfterHours`, while an AI agent is chosen in
 * Settings → AI agent; the claim gives the agent the stored facts; the
 * completion stores what it wrote.
 */
export interface CompanySummaryDeps {
	readonly summaries: CompanySummaryRepository;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
	readonly settings: Pick<SettingsRepository, "getAgentSettings">;
	readonly stockDirectory: Pick<StockDirectoryRepository, "getEntry" | "getCompanyProfile">;
	readonly equitySync: Pick<EquitySyncRepository, "businessByListing">;
	readonly jobs: Pick<JobRepository, "insert">;
	readonly ids: IdGenerator;
	readonly clock: Clock;
	readonly audit: AuditLog;
	readonly log: (event: string, fields: Record<string, string>) => void;
	/**
	 * At most one look at an owner's schedule per period (per isolate):
	 * runners claim about once a second while idle, and a stock's summary
	 * is due at most once a day.
	 */
	readonly gate: Pick<SyncCheckGate, "take">;
	/** Off with the other server syncs (`SERVER_DATA_SYNC`, ADR-0051). */
	readonly enabled: boolean;
}

/** What a `company-summary` claim carries beyond the lease. */
export interface CompanySummaryClaimFields {
	readonly stockId: string;
	readonly agent: JobAgentChoice;
	readonly facts: CompanySummaryFacts;
}

/** Why a claim is refused before the lease: the stored request is unreadable. */
export interface CompanySummaryClaimRefusal {
	readonly reason: string;
}

/**
 * The first Watchlist stock (in Watchlist order) whose summary is due: none
 * stored and not queued in the last `retryAfterHours`, or one older than
 * `refreshAfterDays`. Null when none is.
 */
export function dueSummaryStock(
	stocks: readonly StoredWatchlistStock[],
	schedule: readonly CompanySummarySchedule[],
	nowMs: number,
): StoredWatchlistStock | null {
	const byKey = new Map(schedule.map((row) => [`${row.market}:${row.symbol}`, row]));
	for (const stock of stocks) {
		const row = byKey.get(`${stock.market}:${stock.symbol}`);
		if (row === undefined) return stock;
		const queuedMs = Date.parse(row.queuedAt);
		if (nowMs - queuedMs < COMPANY_SUMMARY_LIMITS.retryAfterHours * HOUR_MS) continue;
		if (row.generatedAt === null) return stock;
		const generatedMs = Date.parse(row.generatedAt);
		if (nowMs - generatedMs >= COMPANY_SUMMARY_LIMITS.refreshAfterDays * DAY_MS) return stock;
	}
	return null;
}

/** The stored request of a `company-summary` job, or null when it is not one. */
export function companySummaryRequestOf(job: JobRecord): CompanySummaryJobRequest | null {
	const parsed = companySummaryJobRequestSchema.safeParse(job.request);
	return parsed.success ? parsed.data : null;
}

/** A fact the claim carries: trimmed, cut to the contract's bound, null when empty. */
function fact(text: string | null | undefined, max: number): string | null {
	if (text === null || text === undefined) return null;
	const trimmed = text.trim();
	return trimmed === "" ? null : truncateText(trimmed, max);
}

export function createCompanySummaryService(deps: CompanySummaryDeps) {
	/** The agent choice saved in Settings, or null when none can run a summary. */
	async function savedAgent(ownerId: string): Promise<JobAgentChoice | null> {
		const stored = await deps.settings.getAgentSettings(ownerId);
		const settings = stored?.settings ?? null;
		const agentId = settings?.defaultAgentId ?? null;
		if (settings === null || agentId === null) return null;
		const model = settings.models[agentId] ?? null;
		if (MODEL_REQUIRED_AGENT_IDS.includes(agentId) && model === null) return null;
		return { agentId, model, effort: settings.effort };
	}

	return {
		/**
		 * Queues the due stock's summary job, if any, and records the queue
		 * time on its row. Only with an AI agent chosen in Settings that the
		 * claiming runner has available; a second job while one is unfinished
		 * is refused by the INSERT (one summary at a time).
		 */
		async materializeDue(ownerId: string, available: ReadonlySet<string>): Promise<void> {
			if (!deps.enabled) return;
			const nowMs = deps.clock.nowMs();
			if (!deps.gate.take(ownerId, nowMs)) return;
			const agent = await savedAgent(ownerId);
			if (agent === null || !available.has(agent.agentId)) return;
			const [stocks, schedule] = await Promise.all([
				deps.watchlist.listStocks(ownerId),
				deps.summaries.listSchedule(ownerId),
			]);
			const stock = dueSummaryStock(stocks, schedule, nowMs);
			if (stock === null) return;
			const at = deps.clock.nowIso();
			const request: CompanySummaryJobRequest = { stockId: stock.stockId, agent };
			const job = scheduledJobRecord({
				ownerId,
				kind: "company-summary",
				request,
				runId: deps.ids.newId("run"),
				at,
			});
			const outcome = await deps.jobs.insert(
				job,
				`summary_${job.runId}`.slice(0, 64),
				`company-summary:${stock.stockId}`,
				JOB_ADMISSION.maxUnfinishedJobs,
			);
			if (outcome.kind !== "inserted") {
				deps.log("company_summary_skipped", { reason: outcome.kind });
				return;
			}
			await deps.summaries.markQueued(ownerId, stock.market, stock.symbol, at);
			await deps.audit.record({
				ownerId,
				actor: "scheduler",
				action: "run.company_summary",
				resource: job.runId,
				detail: `stock=${stock.stockId} agent=${agent.agentId}`,
				at,
			});
		},

		/**
		 * The claim's fields, read from the stored rows BEFORE the lease is
		 * granted: the stock and agent of the stored request and the facts
		 * the server holds about the company.
		 */
		async prepareClaim(
			ownerId: string,
			job: JobRecord,
		): Promise<Result<CompanySummaryClaimFields, CompanySummaryClaimRefusal>> {
			const request = companySummaryRequestOf(job);
			if (request === null) return err({ reason: "company summary job has no stored request" });
			const stock = parseStockId(request.stockId);
			if (!stock.ok) return err({ reason: "company summary job names no stock" });
			const { market, symbol } = stock.value;
			const [entry, profile, business] = await Promise.all([
				deps.stockDirectory.getEntry(ownerId, market, symbol),
				market === "JP"
					? deps.stockDirectory.getCompanyProfile(ownerId, market, symbol)
					: Promise.resolve(null),
				market === "US"
					? deps.equitySync.businessByListing(ownerId, market, symbol)
					: Promise.resolve(null),
			]);
			const description = business?.description ?? null;
			const businessText =
				description !== null && description.status === "extracted"
					? description.paragraphs.map((paragraph) => paragraph.text).join("\n")
					: null;
			const sector = profile === null ? null : `${profile.sector33Name} (${profile.sector17Name})`;
			const facts = companySummaryFactsSchema.safeParse({
				name: fact(
					entry?.name ?? profile?.nameEn ?? business?.company.name,
					COMPANY_SUMMARY_LIMITS.maxFactChars,
				),
				localName: fact(entry?.localName, COMPANY_SUMMARY_LIMITS.maxFactChars),
				listing: fact(entry?.listing, COMPANY_SUMMARY_LIMITS.maxFactChars),
				sector: fact(sector, COMPANY_SUMMARY_LIMITS.maxFactChars),
				businessExcerpt: fact(businessText, COMPANY_SUMMARY_LIMITS.maxBusinessExcerptChars),
			});
			if (!facts.success) return err({ reason: "company summary facts failed the contract" });
			return ok({ stockId: request.stockId, agent: request.agent, facts: facts.data });
		},

		/**
		 * The write of a `company-summarized` completion: the summary of the
		 * stock the job was queued for, by the agent it was queued with.
		 */
		completionEffects(
			job: JobRecord,
			request: Extract<CompleteJobRequest, { outcome: "company-summarized" }>,
		): UseCaseResult<CompanySummaryEffects> {
			const stored = companySummaryRequestOf(job);
			if (stored === null || stored.stockId !== request.stockId) {
				return fail("VALIDATION_FAILED", "The summary is not for the stock this run summarises.");
			}
			const stock = parseStockId(stored.stockId);
			if (!stock.ok) return fail("VALIDATION_FAILED", "The run names no stock.");
			const market: WatchMarket = stock.value.market;
			return ok({
				market,
				symbol: stock.value.symbol,
				summary: request.summary,
				agentId: stored.agent.agentId,
				model: stored.agent.model,
				generatedAt: deps.clock.nowIso(),
			});
		},
	};
}

export type CompanySummaryService = ReturnType<typeof createCompanySummaryService>;
