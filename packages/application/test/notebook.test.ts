/**
 * The notebook application service (ADR-0020): get/put/undo through the
 * owner API, assist queueing, and the claim/completion helpers the
 * runner-job service uses. Fake repositories stand in for SQL; the SQL
 * itself is covered by `apps/api/test/notebook.test.ts`.
 */
import type {
	AgentSettings,
	ChatMessage,
	Evidence,
	Notebook,
	NotebookAssistRequest,
	NotebookTurn,
	NotebookWidget,
} from "@research/contracts";
import { EMPTY_NOTEBOOK, NOTEBOOK_LIMITS } from "@research/contracts";
import { emptyWorkspaceState, type WorkspaceState } from "@research/domain";
import { describe, expect, it } from "vitest";
import type { UseCaseResult } from "../src/errors.ts";
import {
	createNotebookService,
	notebookAssistedEffects,
	prepareNotebookAssistClaim,
} from "../src/notebook/notebook.ts";
import type {
	AuditLog,
	ChatRepository,
	Clock,
	IdGenerator,
	JobRecord,
	JobRepository,
	NotebookRepository,
	RateLimiter,
	ResearchUnitOfWork,
	SettingsRepository,
	WorkspaceRepository,
} from "../src/ports.ts";
import { chartWidget, fixedClock, recordsWith } from "./support.ts";

const OWNER = "owner_1";
const STORED_EVIDENCE: Evidence = {
	evidenceId: "ev_stored",
	sourceUrl: "https://example.com/report",
	title: "Storage outlook",
	publisher: "Example",
	publishedAt: null,
	retrievedAt: "2026-10-01T00:00:00.000Z",
	effectiveAt: null,
	excerpt: null,
	checksum: "a".repeat(64),
	sourceClass: "news",
};
const WORKSPACE = "ws_1";
const NOW = "2026-10-14T00:00:00.000Z";

function textWidget(widgetId: string, title = "Notes", text = "hello"): NotebookWidget {
	return {
		widgetId,
		type: "text",
		title,
		size: "medium",
		text,
		createdAt: NOW,
		updatedAt: NOW,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	};
}

function researchWidget(widgetId: string, componentId: string): NotebookWidget {
	return {
		widgetId,
		type: "research",
		title: "Result",
		size: "large",
		componentId,
		createdAt: NOW,
		updatedAt: NOW,
		revision: 1,
		origin: { kind: "chat", messageId: "msg_1", runId: "run_1", componentId },
	};
}

function unwrap<T>(result: UseCaseResult<T>): T {
	if (!result.ok)
		throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

function expectFail<T>(result: UseCaseResult<T>, code: string): string {
	if (result.ok) throw new Error(`expected failure ${code}, got success`);
	expect(result.error.code).toBe(code);
	return result.error.message;
}

interface NotebookStore {
	putCalls: { notebook: Notebook; expectedVersion: number }[];
	record: { notebook: Notebook; version: number; updatedAt: string } | null | "unreadable";
	revisions: Map<number, Notebook>;
	turns: NotebookTurn[];
	putOutcome: "written" | "version-conflict";
}

interface Fakes {
	notebooks: NotebookRepository;
	notebookStore: NotebookStore;
	workspaces: WorkspaceRepository;
	jobs: JobRepository;
	jobKeys: Map<string, { job: JobRecord; fingerprint: string }>;
	chat: ChatRepository;
	chatMessages: ChatMessage[];
	settings: SettingsRepository;
	settingsStored: { current: AgentSettings | null };
	unitOfWork: ResearchUnitOfWork;
	enqueued: { job: JobRecord; key: string; fingerprint: string; text: string }[];
	enqueueOutcome: {
		current: "inserted" | "existing-same" | "existing-different" | "kind-active" | "at-capacity";
	};
	audit: AuditLog;
	auditEntries: { action: string; actor: string; detail: string }[];
	clock: Clock;
	ids: IdGenerator;
}

const SETTINGS: AgentSettings = {
	defaultAgentId: "claude-code",
	models: { "claude-code": "model-1" },
	effort: "medium",
	budget: {
		maxAgentSteps: 6,
		maxToolCalls: 20,
		maxWallClockMs: 600_000,
		maxInputBytes: 400_000,
		maxSpendUsd: null,
	},
	webAccess: "off",
};

function fakes(canvas: WorkspaceState = emptyWorkspaceState(WORKSPACE)): Fakes {
	const fixed = fixedClock(NOW);
	let counter = 0;
	const ids: IdGenerator = {
		newId: (prefix) => {
			counter += 1;
			return `${prefix}_${counter}`;
		},
	};
	const notebookStore: NotebookStore = {
		putCalls: [],
		record: null,
		revisions: new Map(),
		turns: [],
		putOutcome: "written",
	};
	const notebooks: NotebookRepository = {
		async get() {
			return notebookStore.record;
		},
		async put(_owner, _workspace, notebook, expectedVersion, at) {
			notebookStore.putCalls.push({ notebook, expectedVersion });
			if (notebookStore.putOutcome === "version-conflict") return "version-conflict";
			notebookStore.record = { notebook, version: expectedVersion + 1, updatedAt: at };
			notebookStore.revisions.set(expectedVersion + 1, notebook);
			return "written";
		},
		async getRevision(_owner, _workspace, version) {
			return notebookStore.revisions.get(version) ?? null;
		},
		async listTurns() {
			return [...notebookStore.turns];
		},
		async listMarketSeriesIds() {
			return [];
		},
		async listWatchlistListIds() {
			return [];
		},
	};
	const workspaces: WorkspaceRepository = {
		list: async () => [],
		get: async (ownerId, workspaceId) =>
			ownerId === OWNER && workspaceId === WORKSPACE
				? {
						summary: {
							workspaceId: WORKSPACE,
							title: "Chat",
							version: canvas.version,
							createdAt: NOW,
							updatedAt: NOW,
						},
						state: canvas,
					}
				: null,
		insert: async () => {},
		rename: async () => null,
		listRecords: async () => [],
		findCommand: async () => null,
		write: async () => "written",
		listCommandsAfter: async () => [],
	};
	const jobKeys = new Map<string, { job: JobRecord; fingerprint: string }>();
	const jobs: JobRepository = {
		insert: async () => ({ kind: "inserted" }),
		findByIdempotencyKey: async (_owner, key) => {
			const found = jobKeys.get(key) ?? null;
			return found === null ? null : { job: found.job, requestFingerprint: found.fingerprint };
		},
		get: async () => null,
		list: async () => [],
		findLatestResearchRequest: async () => null,
		listClaimCandidates: async () => [],
		write: async () => true,
		writeWithEvents: async () => true,
		listProgress: async () => [],
		findActiveByKind: async () => null,
		findActiveNotebookAssist: async () => null,
		findLatestSuccessAtByKind: async () => null,
		findLatestFailureByKind: async () => null,
		findLatestFailedByKind: async () => null,
		countUnfinished: async () => 0,
	};
	const chatMessages: ChatMessage[] = [];
	const chat: ChatRepository = {
		async list() {
			return [];
		},
		async listConversations() {
			return [];
		},
		async findByRunId(_owner, _workspace, runId) {
			return chatMessages.find((message) => message.runId === runId) ?? null;
		},
	};
	const settingsStored: { current: AgentSettings | null } = { current: { ...SETTINGS } };
	const settings: SettingsRepository = {
		async getAgentSettings() {
			return settingsStored.current === null
				? null
				: { settings: settingsStored.current, updatedAt: NOW };
		},
		async putAgentSettings(_owner, next) {
			settingsStored.current = next;
		},
	};
	const enqueued: Fakes["enqueued"] = [];
	const enqueueOutcome: Fakes["enqueueOutcome"] = { current: "inserted" };
	const unitOfWork: ResearchUnitOfWork = {
		async enqueueResearch(input) {
			enqueued.push({
				job: input.job,
				key: input.idempotencyKey,
				fingerprint: input.requestFingerprint,
				text: input.ownerMessage.text,
			});
			const job = { ...input.job, contextAnchorSeq: 7, version: 0 } as JobRecord;
			switch (enqueueOutcome.current) {
				case "inserted":
					return { kind: "inserted" } as const;
				case "existing-same":
					return { kind: "existing", job, sameRequest: true } as const;
				case "existing-different":
					return { kind: "existing", job, sameRequest: false } as const;
				case "kind-active":
					return { kind: "kind-active", job } as const;
				case "at-capacity":
					return { kind: "at-capacity" } as const;
			}
		},
		async commitCompletion() {
			throw new Error("not used by the notebook service tests");
		},
		async importWorkspace() {},
		async deleteWorkspace() {
			return "deleted" as const;
		},
		async createScheduledTask() {
			throw new Error("not used by the notebook service tests");
		},
	};
	const auditEntries: Fakes["auditEntries"] = [];
	const audit: AuditLog = {
		async record(entry) {
			auditEntries.push({ action: entry.action, actor: entry.actor, detail: entry.detail });
		},
	};
	return {
		notebooks,
		notebookStore,
		workspaces,
		jobs,
		jobKeys,
		chat,
		chatMessages,
		settings,
		settingsStored,
		unitOfWork,
		enqueued,
		enqueueOutcome,
		audit,
		auditEntries,
		clock: fixed.clock,
		ids,
	};
}

function service(f: Fakes, rateLimiter?: RateLimiter, records = recordsWith()) {
	return createNotebookService({
		notebooks: f.notebooks,
		workspaces: f.workspaces,
		jobs: f.jobs,
		chat: f.chat,
		settings: f.settings,
		market: {
			getSeriesMeta: async () => [],
			getRefreshState: async () => new Map(),
			getObservations: async () => [],
			deleteSeriesNotIn: async () => 0,
		},
		watchlistLists: { membersOf: async () => new Map() },
		unitOfWork: f.unitOfWork,
		clock: f.clock,
		ids: f.ids,
		hasher: { sha256Hex: async (text) => `hash:${text.length}` },
		rateLimiter: rateLimiter ?? { consume: async () => true },
		audit: f.audit,
		records,
	});
}

const ASSIST: NotebookAssistRequest = {
	instruction: "Summarise this",
	selectedWidgetIds: [],
	notebookVersion: 0,
};

describe("getNotebook", () => {
	it("answers 404 for a workspace the owner does not have", async () => {
		const f = fakes();
		expectFail(await service(f).getNotebook(OWNER, "ws_missing"), "NOT_FOUND");
	});

	it("returns version 0 with the empty notebook before any save", async () => {
		const f = fakes();
		const got = unwrap(await service(f).getNotebook(OWNER, WORKSPACE));
		expect(got).toMatchObject({
			workspaceId: WORKSPACE,
			notebook: EMPTY_NOTEBOOK,
			version: 0,
			updatedAt: null,
			undoAvailable: false,
			turns: [],
		});
	});

	it("returns the stored notebook with turns and undo availability", async () => {
		const f = fakes();
		const notebook = { widgets: [textWidget("w-1")] };
		f.notebookStore.record = { notebook, version: 3, updatedAt: NOW };
		f.notebookStore.revisions.set(2, { widgets: [textWidget("w-0")] });
		f.notebookStore.turns = [
			{
				runId: "run_1",
				baseVersion: 2,
				appliedVersion: 3,
				changes: [],
				proposedRemovals: [],
				failure: null,
				createdAt: NOW,
			},
		];
		const got = unwrap(await service(f).getNotebook(OWNER, WORKSPACE));
		expect(got.version).toBe(3);
		expect(got.notebook).toEqual(notebook);
		expect(got.undoAvailable).toBe(true);
		expect(got.turns).toHaveLength(1);
	});

	it("reports no undo when no earlier body is kept", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		const got = unwrap(await service(f).getNotebook(OWNER, WORKSPACE));
		expect(got.undoAvailable).toBe(false);
	});

	it("fails closed on an unreadable stored body", async () => {
		const f = fakes();
		f.notebookStore.record = "unreadable";
		expectFail(await service(f).getNotebook(OWNER, WORKSPACE), "STORED_NOTEBOOK_UNREADABLE");
	});
});

describe("putNotebook", () => {
	it("saves a first version and audits the write", async () => {
		const f = fakes();
		const got = unwrap(
			await service(f).putNotebook(OWNER, WORKSPACE, { widgets: [textWidget("w-1")] }, 0),
		);
		expect(f.notebookStore.putCalls).toHaveLength(1);
		expect(f.notebookStore.putCalls[0]?.expectedVersion).toBe(0);
		expect(f.auditEntries).toMatchObject([{ action: "notebook.update", actor: "owner" }]);
		expect(got.version).toBe(1);
	});

	it("answers VERSION_CONFLICT on a stale version", async () => {
		const f = fakes();
		f.notebookStore.putOutcome = "version-conflict";
		expectFail(
			await service(f).putNotebook(OWNER, WORKSPACE, { widgets: [textWidget("w-1")] }, 0),
			"VERSION_CONFLICT",
		);
		expect(f.auditEntries).toEqual([]);
	});

	it("saves a notebook at the widget maximum and refuses one past the byte cap", async () => {
		const f = fakes();
		const full = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) =>
			textWidget(`w-${index}`),
		);
		unwrap(await service(f).putNotebook(OWNER, WORKSPACE, { widgets: full }, 0));
		expect(f.notebookStore.putCalls).toHaveLength(1);

		const heavy = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) =>
			textWidget(`w-${index}`, "Notes", "y".repeat(NOTEBOOK_LIMITS.maxTextChars)),
		);
		const message = expectFail(
			await service(fakes()).putNotebook(OWNER, WORKSPACE, { widgets: heavy }, 0),
			"INVALID_NOTEBOOK",
		);
		expect(message).toContain("850 KB");
	});

	it("saves a chart whose source copy equals the owner's record and refuses an altered one (ADR-0026)", async () => {
		const record = STORED_EVIDENCE;
		const cited = (title: string): NotebookWidget => ({
			...chartWidget("w-c", { title }),
			type: "chart",
			chartType: "bar",
			unit: "%",
			series: [
				{
					name: "Base",
					points: [{ x: "AI", y: 16.5, sourceId: record.evidenceId, asOf: "2026-10-01" }],
				},
			],
			sources: [record],
		});
		const f = fakes();
		unwrap(
			await service(f, undefined, recordsWith([record])).putNotebook(
				OWNER,
				WORKSPACE,
				{ widgets: [cited("Growth")] },
				0,
			),
		);
		expect(f.notebookStore.putCalls).toHaveLength(1);

		const forged = {
			...cited("Forged"),
			sources: [{ ...record, title: "A better-sounding report" }],
		};
		const message = expectFail(
			await service(fakes(), undefined, recordsWith([record])).putNotebook(
				OWNER,
				WORKSPACE,
				{ widgets: [forged] },
				0,
			),
			"INVALID_NOTEBOOK",
		);
		expect(message).toContain('Chart "Forged"');
	});

	it("rejects a research widget that names no canvas component, naming the widget", async () => {
		const f = fakes();
		const message = expectFail(
			await service(f).putNotebook(
				OWNER,
				WORKSPACE,
				{ widgets: [researchWidget("w-r", "comp-9")] },
				0,
			),
			"INVALID_NOTEBOOK",
		);
		expect(message).toContain("Result");
		expect(f.notebookStore.putCalls).toEqual([]);
	});

	it("accepts a research widget that names a canvas component", async () => {
		const canvas: WorkspaceState = {
			...emptyWorkspaceState(WORKSPACE),
			components: [{ componentId: "comp-1", componentType: "report", schemaVersion: 1, props: {} }],
		};
		const f = fakes(canvas);
		unwrap(
			await service(f).putNotebook(
				OWNER,
				WORKSPACE,
				{ widgets: [researchWidget("w-r", "comp-1")] },
				0,
			),
		);
		expect(f.notebookStore.putCalls).toHaveLength(1);
	});

	it("rewrites an assistant origin from the owner API, keeps a chat origin", async () => {
		const f = fakes();
		const assistant = {
			...textWidget("w-a"),
			origin: { kind: "assistant", messageId: null, runId: "run_9", componentId: null } as const,
		};
		const fromChat = {
			...textWidget("w-c"),
			origin: { kind: "chat", messageId: "msg_1", runId: null, componentId: null } as const,
		};
		unwrap(await service(f).putNotebook(OWNER, WORKSPACE, { widgets: [assistant, fromChat] }, 0));
		const written = f.notebookStore.putCalls[0]?.notebook.widgets;
		expect(written?.find((widget) => widget.widgetId === "w-a")?.origin).toEqual({
			kind: "owner",
			messageId: null,
			runId: null,
			componentId: null,
		});
		expect(written?.find((widget) => widget.widgetId === "w-c")?.origin).toEqual(fromChat.origin);
	});
});

describe("undoNotebook", () => {
	it("restores the earlier body as a new version", async () => {
		const f = fakes();
		const current = { widgets: [textWidget("w-1"), textWidget("w-2")] };
		const earlier = { widgets: [textWidget("w-1")] };
		f.notebookStore.record = { notebook: current, version: 2, updatedAt: NOW };
		f.notebookStore.revisions.set(1, earlier);
		unwrap(await service(f).undoNotebook(OWNER, WORKSPACE, 2));
		expect(f.notebookStore.putCalls[0]?.expectedVersion).toBe(2);
		expect(f.notebookStore.putCalls[0]?.notebook.widgets.map((widget) => widget.widgetId)).toEqual([
			"w-1",
		]);
		expect(f.auditEntries).toMatchObject([{ action: "notebook.undo", actor: "owner" }]);
	});

	it("answers VERSION_CONFLICT when not current", async () => {
		const f = fakes();
		f.notebookStore.record = { notebook: { widgets: [] }, version: 2, updatedAt: NOW };
		expectFail(await service(f).undoNotebook(OWNER, WORKSPACE, 1), "VERSION_CONFLICT");
		expect(f.notebookStore.putCalls).toEqual([]);
	});

	it("answers NOTHING_TO_UNDO when no earlier body is kept", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		expectFail(await service(f).undoNotebook(OWNER, WORKSPACE, 1), "NOTHING_TO_UNDO");
	});
});

describe("assistNotebook", () => {
	function queuedJob(f: Fakes): JobRecord {
		const enqueued = f.enqueued[0];
		if (enqueued === undefined) throw new Error("expected an enqueued job");
		return enqueued.job;
	}

	it("stores the instruction as the owner's message and queues the job with saved agent choices", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		f.chatMessages.push({
			messageId: "msg_9",
			seq: 0,
			role: "owner",
			text: "Summarise this",
			runId: "run_1",
			claimIds: [],
			createdAt: NOW,
		});
		const got = unwrap(
			await service(f).assistNotebook(
				OWNER,
				WORKSPACE,
				{ instruction: "Summarise this", selectedWidgetIds: ["w-1"], notebookVersion: 1 },
				"idem-key-1",
			),
		);
		expect(got.replayed).toBe(false);
		expect(got.message).toMatchObject({ role: "owner", text: "Summarise this", runId: "run_1" });
		const job = queuedJob(f);
		expect(job.kind).toBe("notebook-assist");
		expect(job.workspaceId).toBe(WORKSPACE);
		expect(job.request).toMatchObject({
			instruction: "Summarise this",
			selectedWidgetIds: ["w-1"],
			notebookVersion: 1,
			agent: { agentId: "claude-code", model: "model-1", effort: "medium" },
		});
		expect(f.enqueued[0]?.text).toBe("Summarise this");
		expect(f.auditEntries).toMatchObject([{ action: "notebook.assist.create", actor: "owner" }]);
	});

	it("replays the same result for the same key without a second write", async () => {
		const f = fakes();
		const message: ChatMessage = {
			messageId: "msg_9",
			seq: 0,
			role: "owner",
			text: "Summarise this",
			runId: "run_1",
			claimIds: [],
			createdAt: NOW,
		};
		f.chatMessages.push(message);
		f.jobKeys.set("idem-key-1", {
			job: {
				runId: "run_1",
				ownerId: OWNER,
				kind: "notebook-assist",
				state: "pending",
				request: {
					instruction: "Summarise this",
					selectedWidgetIds: [],
					notebookVersion: 0,
					agent: { agentId: "claude-code", model: null, effort: "medium" },
				},
				workspaceId: WORKSPACE,
				usage: {
					agentSteps: 0,
					toolCalls: 0,
					inputBytes: 0,
					knownCostUsd: 0,
					hasUnmeteredUsage: false,
				},
				attempt: 0,
				maxAttempts: 3,
				leaseGeneration: 0,
				leaseOwnerId: null,
				leaseExpiresAt: null,
				lastEventSeq: -1,
				cancelRequested: false,
				failureCode: null,
				failureDetail: null,
				failureUpstreamStatus: null,
				approvalRequest: null,
				retryOfRunId: null,
				contextAnchorSeq: null,
				verificationStatus: null,
				providerModel: null,
				providerSessionRef: null,
				completedGeneration: null,
				provenance: null,
				version: 0,
				createdAt: NOW,
				updatedAt: NOW,
			},
			fingerprint: "hash:96",
		});
		const first = unwrap(await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"));
		expect(first.replayed).toBe(true);
		expect(first.message).toEqual(message);
		expect(f.enqueued).toEqual([]);
	});

	it("rejects a reused key for a different request", async () => {
		const f = fakes();
		f.jobKeys.set("idem-key-1", {
			job: {
				runId: "run_1",
				ownerId: OWNER,
				kind: "notebook-assist",
				state: "pending",
				request: {
					instruction: "Other",
					selectedWidgetIds: [],
					notebookVersion: 0,
					agent: { agentId: "claude-code", model: null, effort: "medium" },
				},
				workspaceId: WORKSPACE,
				usage: {
					agentSteps: 0,
					toolCalls: 0,
					inputBytes: 0,
					knownCostUsd: 0,
					hasUnmeteredUsage: false,
				},
				attempt: 0,
				maxAttempts: 3,
				leaseGeneration: 0,
				leaseOwnerId: null,
				leaseExpiresAt: null,
				lastEventSeq: -1,
				cancelRequested: false,
				failureCode: null,
				failureDetail: null,
				failureUpstreamStatus: null,
				approvalRequest: null,
				retryOfRunId: null,
				contextAnchorSeq: null,
				verificationStatus: null,
				providerModel: null,
				providerSessionRef: null,
				completedGeneration: null,
				provenance: null,
				version: 0,
				createdAt: NOW,
				updatedAt: NOW,
			},
			fingerprint: "hash:1",
		});
		expectFail(
			await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"),
			"IDEMPOTENCY_KEY_REUSED",
		);
	});

	it("requires a saved backend and names Settings", async () => {
		const f = fakes();
		f.settingsStored.current = null;
		const message = expectFail(
			await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"),
			"AGENT_NOT_CONFIGURED",
		);
		expect(message).toContain("Settings → AI agent");
	});

	it("rejects unknown selected widget ids", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		const message = expectFail(
			await service(f).assistNotebook(
				OWNER,
				WORKSPACE,
				{ instruction: "x", selectedWidgetIds: ["w-9"], notebookVersion: 1 },
				"idem-key-1",
			),
			"INVALID_NOTEBOOK_SELECTION",
		);
		expect(message).toContain("w-9");
	});

	it("refuses a second turn while one is active", async () => {
		const f = fakes();
		f.jobs.findActiveNotebookAssist = async () =>
			({ runId: "run_old", ownerId: OWNER, workspaceId: WORKSPACE }) as unknown as JobRecord;
		expectFail(
			await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"),
			"NOTEBOOK_ASSIST_ACTIVE",
		);
		expect(f.enqueued).toEqual([]);
	});

	it("maps a lost insert race to NOTEBOOK_ASSIST_ACTIVE", async () => {
		const f = fakes();
		f.enqueueOutcome.current = "kind-active";
		expectFail(
			await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"),
			"NOTEBOOK_ASSIST_ACTIVE",
		);
	});

	it("maps a full queue to RATE_LIMITED", async () => {
		const f = fakes();
		f.enqueueOutcome.current = "at-capacity";
		expectFail(
			await service(f).assistNotebook(OWNER, WORKSPACE, ASSIST, "idem-key-1"),
			"RATE_LIMITED",
		);
	});

	it("refuses to queue without the hourly allowance", async () => {
		const f = fakes();
		expectFail(
			await service(f, { consume: async () => false }).assistNotebook(
				OWNER,
				WORKSPACE,
				ASSIST,
				"idem-key-1",
			),
			"RATE_LIMITED",
		);
	});
});

describe("prepareNotebookAssistClaim", () => {
	function job(overrides: Partial<JobRecord> = {}): JobRecord {
		return {
			runId: "run_1",
			ownerId: OWNER,
			kind: "notebook-assist",
			state: "claimed",
			request: {
				instruction: "Summarise",
				selectedWidgetIds: ["w-1", "w-gone"],
				notebookVersion: 0,
				agent: { agentId: "claude-code", model: null, effort: "medium" },
			},
			workspaceId: WORKSPACE,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
			attempt: 1,
			maxAttempts: 3,
			leaseGeneration: 1,
			leaseOwnerId: "cred_1",
			leaseExpiresAt: NOW,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			failureUpstreamStatus: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: 5,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 1,
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		};
	}

	it("carries the stored notebook and drops selection ids that left", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 2,
			updatedAt: NOW,
		};
		const claimed = await prepareNotebookAssistClaim(
			{ notebooks: f.notebooks, chat: f.chat },
			OWNER,
			job(),
		);
		if (!claimed.ok) throw new Error("expected a claim payload");
		expect(claimed.value.notebookVersion).toBe(2);
		expect(claimed.value.selectedWidgetIds).toEqual(["w-1"]);
		expect(claimed.value.instruction).toBe("Summarise");
		expect(claimed.value.agent).toMatchObject({ agentId: "claude-code" });
	});

	it("refuses an unreadable stored notebook", async () => {
		const f = fakes();
		f.notebookStore.record = "unreadable";
		const claimed = await prepareNotebookAssistClaim(
			{ notebooks: f.notebooks, chat: f.chat },
			OWNER,
			job(),
		);
		if (claimed.ok) throw new Error("expected a refusal");
		expect(claimed.error.failureCode).toBe("STORED_NOTEBOOK_UNREADABLE");
	});
});

describe("notebookAssistedEffects", () => {
	function job(): JobRecord {
		return {
			runId: "run_1",
			ownerId: OWNER,
			kind: "notebook-assist",
			state: "claimed",
			request: {
				instruction: "Summarise",
				selectedWidgetIds: [],
				notebookVersion: 1,
				agent: { agentId: "claude-code", model: null, effort: "medium" },
			},
			workspaceId: WORKSPACE,
			usage: {
				agentSteps: 0,
				toolCalls: 0,
				inputBytes: 0,
				knownCostUsd: 0,
				hasUnmeteredUsage: false,
			},
			attempt: 1,
			maxAttempts: 3,
			leaseGeneration: 1,
			leaseOwnerId: "cred_1",
			leaseExpiresAt: NOW,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			failureUpstreamStatus: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: 5,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 1,
			createdAt: NOW,
			updatedAt: NOW,
		};
	}

	it("applies commands, stamps assistant origin and proposes removals by title", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1", "Keep")] },
			version: 1,
			updatedAt: NOW,
		};
		const effects = unwrap(
			await notebookAssistedEffects(
				{ notebooks: f.notebooks, workspaces: f.workspaces, ids: f.ids, records: recordsWith() },
				job(),
				{
					outcome: "notebook-assisted",
					leaseGeneration: 1,
					usage: {
						agentSteps: 1,
						toolCalls: 0,
						inputBytes: 10,
						knownCostUsd: 0,
						hasUnmeteredUsage: true,
					},
					baseVersion: 1,
					reply: "Done",
					commands: [{ kind: "add", type: "text", title: "Added", config: { text: "new" } }],
					proposedRemovals: ["w-1", "w-gone"],
				},
				NOW,
			),
		);
		expect(effects.notebook?.expectedVersion).toBe(1);
		expect(effects.notebook?.notebook.widgets.map((widget) => widget.widgetId)).toEqual([
			"w-1",
			"w_1",
		]);
		expect(
			effects.notebook?.notebook.widgets.find((widget) => widget.widgetId === "w_1")?.origin,
		).toMatchObject({ kind: "assistant", runId: "run_1" });
		expect(effects.notebookTurn?.turn.appliedVersion).toBe(2);
		expect(effects.notebookTurn?.turn.failure).toBeNull();
		expect(effects.notebookTurn?.turn.proposedRemovals).toEqual([
			{ widgetId: "w-1", title: "Keep" },
		]);
		expect(effects.notebookTurn?.turn.changes.map((change) => change.kind)).toEqual(["added"]);
		expect(effects.assistantMessage).toMatchObject({
			messageId: "run_1_answer",
			text: "Done",
			claimIds: [],
		});
	});

	it("records a turn that would grow the notebook past its byte cap as failed, writing nothing", async () => {
		const f = fakes();
		const big = (widgetId: string): NotebookWidget =>
			textWidget(widgetId, "Notes", "y".repeat(NOTEBOOK_LIMITS.maxTextChars));
		const count = Math.floor(NOTEBOOK_LIMITS.maxContentBytes / NOTEBOOK_LIMITS.maxTextChars);
		f.notebookStore.record = {
			notebook: { widgets: Array.from({ length: count }, (_, index) => big(`w-${index}`)) },
			version: 1,
			updatedAt: NOW,
		};
		const effects = unwrap(
			await notebookAssistedEffects(
				{ notebooks: f.notebooks, workspaces: f.workspaces, ids: f.ids, records: recordsWith() },
				job(),
				{
					outcome: "notebook-assisted",
					leaseGeneration: 1,
					usage: {
						agentSteps: 1,
						toolCalls: 0,
						inputBytes: 10,
						knownCostUsd: 0,
						hasUnmeteredUsage: true,
					},
					baseVersion: 1,
					reply: "Copied.",
					commands: [{ kind: "duplicate", widgetId: "w-0" }],
					proposedRemovals: [],
				},
				NOW,
			),
		);
		expect(effects.notebook).toBeNull();
		expect(effects.notebookTurn?.turn.appliedVersion).toBeNull();
		expect(effects.notebookTurn?.turn.failure?.code).toBe("NOTEBOOK_TOO_LARGE");
	});

	it("writes no version for a turn whose commands change nothing", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		const size = textWidget("w-1").size;
		const effects = unwrap(
			await notebookAssistedEffects(
				{ notebooks: f.notebooks, workspaces: f.workspaces, ids: f.ids, records: recordsWith() },
				job(),
				{
					outcome: "notebook-assisted",
					leaseGeneration: 1,
					usage: {
						agentSteps: 1,
						toolCalls: 0,
						inputBytes: 10,
						knownCostUsd: 0,
						hasUnmeteredUsage: true,
					},
					baseVersion: 1,
					reply: "It is already that size.",
					commands: [{ kind: "resize", widgetId: "w-1", size }],
					proposedRemovals: [],
				},
				NOW,
			),
		);
		expect(effects.notebook).toBeNull();
		expect(effects.notebookTurn?.turn).toMatchObject({
			appliedVersion: null,
			changes: [],
			failure: null,
		});
		expect(effects.assistantMessage.text).toBe("It is already that size.");
	});

	it("records NOTEBOOK_CHANGED and applies nothing when the notebook moved", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 2,
			updatedAt: NOW,
		};
		const effects = unwrap(
			await notebookAssistedEffects(
				{ notebooks: f.notebooks, workspaces: f.workspaces, ids: f.ids, records: recordsWith() },
				job(),
				{
					outcome: "notebook-assisted",
					leaseGeneration: 1,
					usage: {
						agentSteps: 1,
						toolCalls: 0,
						inputBytes: 10,
						knownCostUsd: 0,
						hasUnmeteredUsage: true,
					},
					baseVersion: 1,
					reply: "Done",
					commands: [{ kind: "add", type: "text", title: "Added", config: { text: "new" } }],
					proposedRemovals: [],
				},
				NOW,
			),
		);
		expect(effects.notebook).toBeNull();
		expect(effects.notebookTurn?.turn).toMatchObject({
			appliedVersion: null,
			failure: { code: "NOTEBOOK_CHANGED" },
		});
		expect(effects.notebookTurn?.turn.failure?.message).toContain("Ask again.");
	});

	it("records the failure and applies nothing for an invalid command", async () => {
		const f = fakes();
		f.notebookStore.record = {
			notebook: { widgets: [textWidget("w-1")] },
			version: 1,
			updatedAt: NOW,
		};
		const effects = unwrap(
			await notebookAssistedEffects(
				{ notebooks: f.notebooks, workspaces: f.workspaces, ids: f.ids, records: recordsWith() },
				job(),
				{
					outcome: "notebook-assisted",
					leaseGeneration: 1,
					usage: {
						agentSteps: 1,
						toolCalls: 0,
						inputBytes: 10,
						knownCostUsd: 0,
						hasUnmeteredUsage: true,
					},
					baseVersion: 1,
					reply: "Tried",
					commands: [{ kind: "remove", widgetId: "w-1" }],
					proposedRemovals: [],
				},
				NOW,
			),
		);
		expect(effects.notebook).toBeNull();
		expect(effects.notebookTurn?.turn.failure?.code).toBe("INVALID_COMMAND");
	});
});
