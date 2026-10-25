import {
	type AgentSettings,
	DEFAULT_AGENT_SETTINGS,
	type ResearchRequest,
} from "@research/contracts";
import { ok } from "@research/domain";
import type { UseCaseResult } from "./errors.ts";
import type { AuditLog, Clock, JobRepository, SettingsRepository } from "./ports.ts";

export interface AgentSettingsServiceDeps {
	readonly settings: SettingsRepository;
	/** Only the newest-request read; the service never writes jobs (ARCH-007). */
	readonly jobs: Pick<JobRepository, "findLatestResearchRequest">;
	readonly clock: Clock;
	readonly audit: AuditLog;
}

export type AgentSettingsOrigin = "saved" | "carried-over" | "defaults";

export interface AgentSettingsView {
	readonly settings: AgentSettings;
	/** null while the owner has never saved settings (the defaults are being shown). */
	readonly updatedAt: string | null;
	/** Which settings are shown, so the UI can say so (saved, carried over, or defaults). */
	readonly origin: AgentSettingsOrigin;
}

/**
 * Carries the owner's most recent research choice into unset settings: the
 * backend, its model when one was used, effort and limits. The optional
 * spend cap and web access use their defaults until the owner saves settings.
 */
export function carriedOverSettings(request: ResearchRequest): AgentSettings {
	return {
		defaultAgentId: request.agentId,
		models: request.model === null ? {} : { [request.agentId]: request.model },
		effort: request.effort,
		budget: { ...request.budget, maxSpendUsd: null },
		webAccess: DEFAULT_AGENT_SETTINGS.webAccess,
	};
}

/**
 * One stored settings record per owner (section 10). Reads fall back to the
 * contract defaults; writes replace the whole record — last write wins, since
 * a single owner edits one form. When nothing is stored, the owner's most
 * recent research run supplies the agent choices (one extra query, only on
 * that path), so an installation that predates the Settings → AI agent form
 * can still send.
 */
export function createAgentSettingsService(deps: AgentSettingsServiceDeps) {
	return {
		async get(ownerId: string): Promise<AgentSettingsView> {
			const stored = await deps.settings.getAgentSettings(ownerId);
			if (stored !== null) {
				return { settings: stored.settings, updatedAt: stored.updatedAt, origin: "saved" };
			}
			const latest = await deps.jobs.findLatestResearchRequest(ownerId);
			if (latest === null) {
				return { settings: DEFAULT_AGENT_SETTINGS, updatedAt: null, origin: "defaults" };
			}
			return { settings: carriedOverSettings(latest), updatedAt: null, origin: "carried-over" };
		},

		async update(ownerId: string, next: AgentSettings): Promise<UseCaseResult<AgentSettingsView>> {
			const now = deps.clock.nowIso();
			await deps.settings.putAgentSettings(ownerId, next, now);
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "settings.agent.update",
				resource: ownerId,
				// Ids and codes only: never model names or free text (SEC-010).
				detail: `backend=${next.defaultAgentId ?? "none"} effort=${next.effort}`,
				at: now,
			});
			return ok({ settings: next, updatedAt: now, origin: "saved" });
		},
	};
}

export type AgentSettingsService = ReturnType<typeof createAgentSettingsService>;
