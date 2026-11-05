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
	COMPANY_SUMMARY_CHECK_INTERVAL_MS,
	createAgentSettingsService,
	createCompanySummaryService,
	createDataSyncService,
	createEquitySyncService,
	createExportImportService,
	createGoogleCalendarService,
	createHomeService,
	createJobRetentionService,
	createNotebookService,
	createOwnerMemo,
	createResearchRunService,
	createRunnerCredentialService,
	createRunnerJobService,
	createScheduledTaskService,
	createSourceService,
	createStockDataSearchService,
	createStockDirectoryService,
	createStockPageService,
	createSyncCheckGate,
	createWatchlistService,
	createWorkspaceService,
	type DataSyncKind,
	type IdGenerator,
	MARKET_CATALOG,
	type Persistence,
	RECOMMENDED_SOURCES,
	type SafeFetcher,
	SYNC_JOB_RETENTION_PERIOD_MS,
} from "@research/application";
import {
	BASELINE_COMPONENT_DEFINITIONS,
	type ComponentDefinition,
	createComponentCatalog,
} from "@research/contracts";
import { createEventLogger, type EventLogger, logIsolated } from "@research/effects";
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
	/**
	 * ADR-0051, ADR-0054: the server-side syncs at claim time (market data,
	 * earnings dates, stock lists, Google Calendar, news feeds). Defaults to
	 * the `SERVER_DATA_SYNC` binding ("off" disables); the API test harness
	 * turns it off unless a test asks for it.
	 */
	readonly serverDataSync?: boolean;
	/**
	 * ADR-0058 §3: every directory stock is tracked for its financial
	 * statements at claim time. Defaults to `serverDataSync`; the API test
	 * harness turns it on separately, so equity tests need not queue the
	 * other syncs.
	 */
	readonly equityTracksDirectory?: boolean;
	/**
	 * ADR-0058 §3: old terminal sync jobs are deleted at claim time.
	 * Defaults to `serverDataSync`; the API tests turn it on separately.
	 */
	readonly syncJobRetention?: boolean;
	/**
	 * ADR-0060: AI-written company summaries are queued at claim time.
	 * Defaults to `serverDataSync`; the API tests turn it on separately.
	 */
	readonly companySummaries?: boolean;
	/** The server-side sync kinds kept (default: all); tests narrow it to the kind they check. */
	readonly serverSyncKinds?: ReadonlySet<DataSyncKind>;
}

/**
 * Composition root: the only place where ports meet adapters. Services are
 * built per request because Worker bindings arrive with the request; that is a
 * handful of closures and no I/O. Request-independent parts (component catalog,
 * feed parser, fetcher) come from `createSharedParts` and are reused.
 */
/** Everything that does not depend on a request's bindings, built once per isolate. */
export function createSharedParts(
	overrides: CompositionOverrides = {},
	logger: EventLogger = createEventLogger((line) => console.error(line.trimEnd())),
) {
	return {
		/** For failures a use case contains instead of answering (the claim-time scheduler). */
		logger,
		catalog: createComponentCatalog([
			...BASELINE_COMPONENT_DEFINITIONS,
			...(overrides.extraComponents ?? []),
		]),
		feedParser: createFeedParser(),
		/** When the claim reads an owner's sync state (ADR-0051); per isolate. */
		syncGate: createSyncCheckGate(),
		/** When the claim considers an owner's directory reconcile (ADR-0058 §3). */
		equityGate: createSyncCheckGate(),
		/** The directory signature each owner's last complete reconcile saw (ADR-0058 §3). */
		equityReconciled: createOwnerMemo(),
		/** At most one sync-job retention run per owner an hour (ADR-0058 §3). */
		retentionGate: createSyncCheckGate(SYNC_JOB_RETENTION_PERIOD_MS),
		/** When the claim looks at an owner's company summaries (ADR-0060). */
		summaryGate: createSyncCheckGate(COMPANY_SUMMARY_CHECK_INTERVAL_MS),
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
	const runs = createResearchRunService({
		jobs: persistence.jobs,
		workspaces: persistence.workspaces,
		records: persistence.records,
		runnerStatus: persistence.runnerStatus,
		settings: persistence.settings,
		unitOfWork: persistence.unitOfWork,
		clock,
		ids,
		hasher,
		rateLimiter: persistence.rateLimiter,
		audit: persistence.audit,
		googleCalendar: persistence.googleCalendar,
	});
	const serverDataSync = overrides.serverDataSync ?? env.SERVER_DATA_SYNC !== "off";
	const equitySync = createEquitySyncService({
		equitySync: persistence.equitySync,
		jobs: persistence.jobs,
		stockDirectory: persistence.stockDirectory,
		clock,
		ids,
		audit: persistence.audit,
		trackDirectory: overrides.equityTracksDirectory ?? serverDataSync,
		gate: shared.equityGate,
		reconciled: shared.equityReconciled,
		log: (event, fields) => logIsolated(() => shared.logger.warn(event, fields)),
	});
	const stockPages = createStockPageService({
		stockDirectory: persistence.stockDirectory,
		market: persistence.market,
		articles: persistence.articles,
		equitySync: persistence.equitySync,
		equityCompanies: equitySync,
		watchlist: persistence.watchlist,
		companySummaries: persistence.companySummaries,
		earningsCalendar: persistence.earningsCalendar,
		clock,
	});
	const jobRetention = createJobRetentionService({
		retention: persistence.jobRetention,
		clock,
		audit: persistence.audit,
		gate: shared.retentionGate,
		enabled: overrides.syncJobRetention ?? serverDataSync,
	});
	const dataSync = createDataSyncService({
		jobs: persistence.jobs,
		homeDashboard: persistence.homeDashboard,
		notebooks: persistence.notebooks,
		watchlistLists: persistence.watchlistLists,
		market: persistence.market,
		watchlist: persistence.watchlist,
		stockDirectory: persistence.stockDirectory,
		stockPrices: persistence.stockPrices,
		googleCalendar: persistence.googleCalendar,
		earnings: persistence.earnings,
		earningsCalendar: persistence.earningsCalendar,
		hasher,
		sources: persistence.sources,
		clock,
		ids,
		audit: persistence.audit,
		gate: shared.syncGate,
		enabled: serverDataSync,
		...(overrides.serverSyncKinds === undefined ? {} : { kinds: overrides.serverSyncKinds }),
		log: (event, fields) => logIsolated(() => shared.logger.warn(event, fields)),
	});
	const companySummary = createCompanySummaryService({
		summaries: persistence.companySummaries,
		watchlist: persistence.watchlist,
		settings: persistence.settings,
		stockDirectory: persistence.stockDirectory,
		equitySync: persistence.equitySync,
		jobs: persistence.jobs,
		ids,
		clock,
		audit: persistence.audit,
		log: (event, fields) => logIsolated(() => shared.logger.warn(event, fields)),
		gate: shared.summaryGate,
		enabled: overrides.companySummaries ?? serverDataSync,
	});
	const scheduledTasks = createScheduledTaskService({
		scheduledTasks: persistence.scheduledTasks,
		unitOfWork: persistence.unitOfWork,
		jobs: persistence.jobs,
		runs,
		workspaces: persistence.workspaces,
		clock,
		ids,
		hasher,
		audit: persistence.audit,
	});
	return {
		authenticateOwner: overrides.ownerAuthenticator ?? ownerAuthenticatorFor(env),
		materials: persistence.materials,
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
		runs,
		scheduledTasks,
		equitySync,
		notebook: createNotebookService({
			notebooks: persistence.notebooks,
			workspaces: persistence.workspaces,
			jobs: persistence.jobs,
			chat: persistence.chat,
			settings: persistence.settings,
			market: persistence.market,
			watchlistLists: persistence.watchlistLists,
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
			stockPrices: persistence.stockPrices,
			notebooks: persistence.notebooks,
			watchlist: persistence.watchlist,
			watchlistLists: persistence.watchlistLists,
			earnings: persistence.earnings,
			hasher,
			googleCalendar: persistence.googleCalendar,
			audit: persistence.audit,
			scheduler: scheduledTasks,
			onSchedulerFailure: (name) =>
				logIsolated(() => shared.logger.error("scheduled_tasks_materialize_failed", { name })),
			equitySync,
			onEquitySyncFailure: (name) =>
				logIsolated(() => shared.logger.error("equity_sync_scheduler_failed", { name })),
			jobRetention,
			onJobRetentionFailure: (name) =>
				logIsolated(() => shared.logger.error("sync_job_retention_failed", { name })),
			dataSync,
			onDataSyncFailure: (name) =>
				logIsolated(() => shared.logger.error("data_sync_scheduler_failed", { name })),
			companySummary,
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
			watchlistLists: persistence.watchlistLists,
			watchlist: persistence.watchlist,
			clock,
			audit: persistence.audit,
			records: persistence.records,
		}),
		watchlist: createWatchlistService({
			watchlist: persistence.watchlist,
			watchlistLists: persistence.watchlistLists,
			homeDashboard: persistence.homeDashboard,
			notebooks: persistence.notebooks,
			market: persistence.market,
			earnings: persistence.earnings,
			calendarFeed: persistence.calendarFeed,
			googleCalendar: persistence.googleCalendar,
			stockDirectory: persistence.stockDirectory,
			jobs: persistence.jobs,
			clock,
			ids,
			secrets: randomFeedTokenGenerator,
			hasher,
			audit: persistence.audit,
		}),
		stockDirectory: createStockDirectoryService({
			stockDirectory: persistence.stockDirectory,
			watchlist: persistence.watchlist,
			jobs: persistence.jobs,
		}),
		stockPages,
		// ADR-0071: the runner's stocks.search_data tool reads the same stored records.
		stockData: createStockDataSearchService({
			jobs: persistence.jobs,
			stockPages,
			stockDirectory: persistence.stockDirectory,
			watchlist: persistence.watchlist,
			equityCompanies: equitySync,
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
