/**
 * Engine-neutral SQL persistence: every `Persistence` port backed by any
 * `SqlDatabase` that speaks the SQLite dialect (see `database.ts`). The D1
 * binding (`../d1`) and the Node `node:sqlite` driver (`../sqlite`) are both
 * thin adapters over this module, and the same API suite runs against both.
 */
import type {
	ArticleRepository,
	AuditLog,
	CalendarFeedRepository,
	ChartEvidenceReferences,
	ChatRepository,
	EarningsRepository,
	GoogleCalendarRepository,
	HomeDashboardRepository,
	JobRepository,
	MarketRepository,
	NotebookRepository,
	Persistence,
	RateLimiter,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	RunnerCredentialRepository,
	RunnerStatusRepository,
	SettingsRepository,
	SourceRepository,
	StockDirectoryRepository,
	WatchlistRepository,
	WorkspaceRepository,
} from "@research/application";
import type { SqlDatabase } from "./database.ts";
import {
	createArticleRepository,
	createAuditLog,
	createCalendarFeedRepository,
	createChartEvidenceReferences,
	createChatRepository,
	createEarningsRepository,
	createGoogleCalendarRepository,
	createHomeDashboardRepository,
	createJobRepository,
	createMarketRepository,
	createNotebookRepository,
	createRateLimiter,
	createResearchRecordRepository,
	createRunnerCredentialRepository,
	createRunnerStatusRepository,
	createSettingsRepository,
	createSourceRepository,
	createStockDirectoryRepository,
	createWatchlistRepository,
	createWorkspaceRepository,
} from "./repositories.ts";
import { createResearchUnitOfWork } from "./unitOfWork.ts";

export type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
export { StoredDataError } from "./rows.ts";
export { chunkStockDirectoryRows, STOCK_DIRECTORY_CHUNK_BYTES } from "./unitOfWork.ts";

/** Every SQL-backed port, built from one database. */
export function createSqlPersistence(db: SqlDatabase): Persistence {
	const sources: SourceRepository = createSourceRepository(db);
	const articles: ArticleRepository = createArticleRepository(db);
	const jobs: JobRepository = createJobRepository(db);
	const workspaces: WorkspaceRepository = createWorkspaceRepository(db);
	const records: ResearchRecordRepository = createResearchRecordRepository(db);
	const chat: ChatRepository = createChatRepository(db);
	const runnerCredentials: RunnerCredentialRepository = createRunnerCredentialRepository(db);
	const runnerStatus: RunnerStatusRepository = createRunnerStatusRepository(db);
	const settings: SettingsRepository = createSettingsRepository(db);
	const homeDashboard: HomeDashboardRepository = createHomeDashboardRepository(db);
	const market: MarketRepository = createMarketRepository(db);
	const notebooks: NotebookRepository = createNotebookRepository(db);
	const chartEvidence: ChartEvidenceReferences = createChartEvidenceReferences(db);
	const watchlist: WatchlistRepository = createWatchlistRepository(db);
	const earnings: EarningsRepository = createEarningsRepository(db);
	const calendarFeed: CalendarFeedRepository = createCalendarFeedRepository(db);
	const googleCalendar: GoogleCalendarRepository = createGoogleCalendarRepository(db);
	const stockDirectory: StockDirectoryRepository = createStockDirectoryRepository(db);
	const rateLimiter: RateLimiter = createRateLimiter(db);
	const audit: AuditLog = createAuditLog(db);
	const unitOfWork: ResearchUnitOfWork = createResearchUnitOfWork(db);
	return {
		sources,
		articles,
		jobs,
		workspaces,
		records,
		chat,
		runnerCredentials,
		runnerStatus,
		settings,
		homeDashboard,
		market,
		notebooks,
		chartEvidence,
		watchlist,
		earnings,
		calendarFeed,
		googleCalendar,
		stockDirectory,
		rateLimiter,
		audit,
		unitOfWork,
	};
}
