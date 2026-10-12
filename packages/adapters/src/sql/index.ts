/**
 * Engine-neutral SQL persistence: every `Persistence` port backed by any
 * `SqlDatabase` that speaks the SQLite dialect (see `database.ts`). The D1
 * binding (`../d1`) and the Node `node:sqlite` driver (`../sqlite`) are both
 * thin adapters over this module, and the same API suite runs against both.
 */
import type {
	ArticleRepository,
	AssetRepository,
	AuditLog,
	ChatRepository,
	JobRepository,
	Persistence,
	RateLimiter,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	RunnerCredentialRepository,
	RunnerStatusRepository,
	SettingsRepository,
	SourceRepository,
	WorkspaceRepository,
} from "@research/application";
import type { SqlDatabase } from "./database.ts";
import {
	createArticleRepository,
	createAssetRepository,
	createAuditLog,
	createChatRepository,
	createJobRepository,
	createRateLimiter,
	createResearchRecordRepository,
	createRunnerCredentialRepository,
	createRunnerStatusRepository,
	createSettingsRepository,
	createSourceRepository,
	createWorkspaceRepository,
} from "./repositories.ts";
import { createResearchUnitOfWork } from "./unitOfWork.ts";

export type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
export { StoredDataError } from "./rows.ts";

/** Every SQL-backed port, built from one database. */
export function createSqlPersistence(db: SqlDatabase): Persistence {
	const sources: SourceRepository = createSourceRepository(db);
	const articles: ArticleRepository = createArticleRepository(db);
	const jobs: JobRepository = createJobRepository(db);
	const workspaces: WorkspaceRepository = createWorkspaceRepository(db);
	const records: ResearchRecordRepository = createResearchRecordRepository(db);
	const chat: ChatRepository = createChatRepository(db);
	const assets: AssetRepository = createAssetRepository(db);
	const runnerCredentials: RunnerCredentialRepository = createRunnerCredentialRepository(db);
	const runnerStatus: RunnerStatusRepository = createRunnerStatusRepository(db);
	const settings: SettingsRepository = createSettingsRepository(db);
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
		assets,
		runnerCredentials,
		runnerStatus,
		settings,
		rateLimiter,
		audit,
		unitOfWork,
	};
}
