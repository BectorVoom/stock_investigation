import { createD1Adapters } from "@research/adapters/d1";
import { createFeedParser } from "@research/adapters/feed";
import {
	randomFeedTokenGenerator,
	randomIdGenerator,
	randomSecretGenerator,
	systemClock,
	webCryptoHasher,
} from "@research/adapters/runtime";
import { createWorkerSafeFetcher } from "@research/adapters/worker";
import {
	type Clock,
	createAgentSettingsService,
	createExportImportService,
	createGoogleCalendarService,
	createHomeService,
	createNotebookService,
	createResearchRunService,
	createRunnerCredentialService,
	createRunnerJobService,
	createSourceService,
	createWatchlistService,
	createWorkspaceService,
	type IdGenerator,
	MARKET_CATALOG,
	type Persistence,
	RECOMMENDED_SOURCES,
	type SafeFetcher,
} from "@research/application";
import {
	BASELINE_COMPONENT_DEFINITIONS,
	type ComponentDefinition,
	createComponentCatalog,
} from "@research/contracts";
import { type OwnerAuthenticator, ownerAuthenticatorFor } from "./auth.ts";
import type { Env } from "./env.ts";

/** Seams that tests replace; production uses the defaults. */
export interface CompositionOverrides {
	readonly fetcher?: SafeFetcher;
	readonly clock?: Clock;
	readonly ids?: IdGenerator;
	readonly ownerAuthenticator?: OwnerAuthenticator;
	/** Extra component types (FR-013): registered here, with no change to any use case. */
	readonly extraComponents?: readonly ComponentDefinition[];
	/** Whole persistence seam; defaults to the Worker's D1 binding (ADR-0008). */
	readonly persistence?: Persistence;
}

/**
 * Composition root: the only place where ports meet adapters. Services are
 * built per request because Worker bindings arrive with the request; that is a
 * handful of closures and no I/O. Request-independent parts (component catalog,
 * feed parser, fetcher) come from `createSharedParts` and are reused.
 */
/** Everything that does not depend on a request's bindings, built once per isolate. */
export function createSharedParts(overrides: CompositionOverrides = {}) {
	return {
		catalog: createComponentCatalog([
			...BASELINE_COMPONENT_DEFINITIONS,
			...(overrides.extraComponents ?? []),
		]),
		feedParser: createFeedParser(),
		fetcher: overrides.fetcher ?? createWorkerSafeFetcher(),
	};
}

export type SharedParts = ReturnType<typeof createSharedParts>;

export function createServices(
	env: Env,
	overrides: CompositionOverrides = {},
	shared: SharedParts = createSharedParts(overrides),
) {
	const persistence = overrides.persistence ?? createD1Adapters(env.DB);
	const clock = overrides.clock ?? systemClock;
	const ids = overrides.ids ?? randomIdGenerator;
	const hasher = webCryptoHasher;
	const { catalog } = shared;
	return {
		authenticateOwner: overrides.ownerAuthenticator ?? ownerAuthenticatorFor(env),
		runnerStatus: persistence.runnerStatus,
		clock,
		sources: createSourceService({
			sources: persistence.sources,
			articles: persistence.articles,
			fetcher: shared.fetcher,
			feedParser: shared.feedParser,
			clock,
			ids,
			rateLimiter: persistence.rateLimiter,
			audit: persistence.audit,
			recommended: RECOMMENDED_SOURCES,
		}),
		runs: createResearchRunService({
			jobs: persistence.jobs,
			workspaces: persistence.workspaces,
			records: persistence.records,
			runnerStatus: persistence.runnerStatus,
			unitOfWork: persistence.unitOfWork,
			clock,
			ids,
			hasher,
			rateLimiter: persistence.rateLimiter,
			audit: persistence.audit,
			googleCalendar: persistence.googleCalendar,
		}),
		notebook: createNotebookService({
			notebooks: persistence.notebooks,
			workspaces: persistence.workspaces,
			jobs: persistence.jobs,
			chat: persistence.chat,
			settings: persistence.settings,
			market: persistence.market,
			unitOfWork: persistence.unitOfWork,
			clock,
			ids,
			hasher,
			rateLimiter: persistence.rateLimiter,
			audit: persistence.audit,
			records: persistence.records,
		}),
		runnerJobs: createRunnerJobService({
			jobs: persistence.jobs,
			sources: persistence.sources,
			workspaces: persistence.workspaces,
			records: persistence.records,
			runnerStatus: persistence.runnerStatus,
			unitOfWork: persistence.unitOfWork,
			chat: persistence.chat,
			catalog,
			clock,
			ids,
			homeDashboard: persistence.homeDashboard,
			market: persistence.market,
			notebooks: persistence.notebooks,
			watchlist: persistence.watchlist,
			earnings: persistence.earnings,
			hasher,
			googleCalendar: persistence.googleCalendar,
			audit: persistence.audit,
		}),
		workspaces: createWorkspaceService({
			workspaces: persistence.workspaces,
			records: persistence.records,
			chat: persistence.chat,
			catalog,
			clock,
			ids,
			audit: persistence.audit,
			unitOfWork: persistence.unitOfWork,
			chartEvidence: persistence.chartEvidence,
		}),
		credentials: createRunnerCredentialService({
			credentials: persistence.runnerCredentials,
			clock,
			ids,
			hasher,
			secrets: randomSecretGenerator,
			audit: persistence.audit,
		}),
		agentSettings: createAgentSettingsService({
			settings: persistence.settings,
			jobs: persistence.jobs,
			clock,
			audit: persistence.audit,
		}),
		home: createHomeService({
			dashboard: persistence.homeDashboard,
			market: persistence.market,
			jobs: persistence.jobs,
			notebooks: persistence.notebooks,
			clock,
			audit: persistence.audit,
			records: persistence.records,
		}),
		watchlist: createWatchlistService({
			watchlist: persistence.watchlist,
			earnings: persistence.earnings,
			calendarFeed: persistence.calendarFeed,
			googleCalendar: persistence.googleCalendar,
			jobs: persistence.jobs,
			clock,
			ids,
			secrets: randomFeedTokenGenerator,
			hasher,
			rateLimiter: persistence.rateLimiter,
			audit: persistence.audit,
		}),
		googleCalendar: createGoogleCalendarService({
			jobs: persistence.jobs,
			googleCalendar: persistence.googleCalendar,
			clock,
			ids,
			rateLimiter: persistence.rateLimiter,
			audit: persistence.audit,
		}),
		marketCatalog: MARKET_CATALOG,
		exportImport: createExportImportService({
			workspaces: persistence.workspaces,
			records: persistence.records,
			chat: persistence.chat,
			unitOfWork: persistence.unitOfWork,
			catalog,
			clock,
			ids,
		}),
	};
}

export type Services = ReturnType<typeof createServices>;
