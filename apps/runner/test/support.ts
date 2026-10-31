import { createAgentRegistry } from "@research/agent-core";
import { type SafeFetchError, unconfiguredMarketSeriesSource } from "@research/application";
import type {
	ClaimedJob,
	ClaimJobResponse,
	CompleteJobRequest,
	ReleaseJobRequest,
	ReleaseJobResponse,
	RunnerEventsRequest,
} from "@research/contracts";
import { marketUnavailableReason } from "@research/contracts";
import { err, ok } from "@research/domain";
import { silentEventLogger } from "@research/effects";
import {
	createScriptedAgent,
	type ScriptedReply,
} from "../../../examples/extensions/scriptedAgent.ts";
import {
	analysis,
	fixedClock,
	newsTools,
	PLAN,
	request,
	SOURCES,
	VERDICT_SUPPORTED,
} from "../../../packages/application/test/support.ts";
import type { RunnerApi, RunnerApiError, RunnerApiResult } from "../src/apiClient.ts";
import type { JobExecutionDeps } from "../src/jobExecution.ts";
import { createMarketPacer } from "../src/marketPacing.ts";

export const RUN_ID = "run_test";

export const RESEARCH_JOB: Extract<ClaimedJob, { kind: "research" }> = {
	kind: "research",
	runId: RUN_ID,
	leaseGeneration: 3,
	leaseExpiresAt: "2026-10-11T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [...SOURCES],
	request: request(),
	priorUsage: {
		agentSteps: 0,
		toolCalls: 0,
		inputBytes: 0,
		knownCostUsd: 0,
		hasUnmeteredUsage: false,
	},
	workspaceComponents: [],
	conversationContext: [],
};

export const INGEST_JOB: ClaimedJob = {
	kind: "news-ingest",
	runId: "run_ingest",
	leaseGeneration: 1,
	leaseExpiresAt: "2026-10-11T00:01:30.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [...SOURCES],
};

type Scripted<T> = RunnerApiResult<T> | (() => RunnerApiResult<T>);

function next<T>(queue: Scripted<T>[], fallback: RunnerApiResult<T>): RunnerApiResult<T> {
	const entry = queue.length > 1 ? queue.shift() : queue[0];
	if (entry === undefined) return fallback;
	return typeof entry === "function" ? entry() : entry;
}

export const apiFailure = (code: string, transient = false): RunnerApiResult<never> =>
	err({ code, detail: "", transient } satisfies RunnerApiError);

/** In-memory Worker stand-in that records every runner call and plays scripted answers. */
export function createFakeApi(
	script: {
		claim?: Scripted<ClaimJobResponse>[];
		heartbeat?: Scripted<{ leaseExpiresAt: string; cancelRequested: boolean }>[];
		events?: Scripted<{ cancelRequested: boolean }>[];
		complete?: Scripted<{ state: "completed"; replayed: boolean; newArticleCount: number }>[];
		release?: Scripted<ReleaseJobResponse>[];
	} = {},
) {
	const calls = {
		claim: 0,
		heartbeats: [] as number[],
		events: [] as RunnerEventsRequest[],
		completions: [] as CompleteJobRequest[],
		releases: [] as ReleaseJobRequest[],
	};
	const api: RunnerApi = {
		async claim() {
			calls.claim += 1;
			return next(script.claim ?? [], ok({ job: null, pollAfterMs: 15_000 }));
		},
		async heartbeat(_runId, leaseGeneration) {
			calls.heartbeats.push(leaseGeneration);
			return next(
				script.heartbeat ?? [],
				ok({ leaseExpiresAt: "2026-10-11T00:03:00.000Z", cancelRequested: false }),
			);
		},
		async events(_runId, body) {
			calls.events.push(body);
			return next(script.events ?? [], ok({ cancelRequested: false }));
		},
		async complete(_runId, body) {
			calls.completions.push(body);
			return next(
				script.complete ?? [],
				ok({ state: "completed", replayed: false, newArticleCount: 0 }),
			);
		},
		async release(_runId, body) {
			calls.releases.push(body);
			return next(script.release ?? [], ok({ state: "pending" }));
		},
		async renewCredential() {
			return ok({ token: "rk_renewed" });
		},
	};
	return { api, calls };
}

export function createDeps(
	api: RunnerApi,
	options: {
		replies?: readonly ScriptedReply[];
		onTurn?: (turnIndex: number) => void | Promise<void>;
		feedDocuments?: Record<string, string>;
		/** A scripted fetch failure per URL (an unscripted URL times out). */
		feedFailures?: Record<string, SafeFetchError>;
	} = {},
) {
	const time = fixedClock();
	const replies = options.replies ?? [PLAN, analysis(), VERDICT_SUPPORTED];
	const agent = createScriptedAgent({
		reply: async (_request, turnIndex) => {
			await options.onTurn?.(turnIndex);
			const reply = replies[turnIndex];
			if (reply === undefined) throw new Error(`no scripted reply for turn ${turnIndex}`);
			return reply;
		},
	});
	const tools = newsTools();
	const scratch = { created: [] as string[], removed: [] as string[] };
	const timers: { ms: number; task: () => void; stopped: boolean }[] = [];
	const fetchedUrls: string[] = [];
	const deps: JobExecutionDeps = {
		api,
		agents: createAgentRegistry([agent]),
		tools: tools.registry,
		feed: {
			fetcher: {
				async fetchText(url) {
					fetchedUrls.push(url);
					const failure = options.feedFailures?.[url];
					if (failure !== undefined) return err(failure);
					const text = options.feedDocuments?.[url];
					return text === undefined
						? err({ code: "TIMEOUT", detail: "test" })
						: ok({ finalUrl: url, contentType: "application/xml", text });
				},
			},
			feedParser: {
				parse(text) {
					if (!text.startsWith("FEED:")) return err("NOT_A_FEED");
					return ok({
						kind: "rss",
						title: "Example News",
						siteLink: null,
						items: text
							.slice(5)
							.split("|")
							.map((entry) => {
								const [title, link] = entry.split("@");
								return {
									title: title ?? null,
									link: link ?? null,
									publishedText: "2026-10-01T00:00:00Z",
									summaryText: "summary text",
								};
							}),
					});
				},
			},
			hasher: {
				// Deterministic stand-in: 64 hex chars derived from the text length and first char codes.
				async sha256Hex(text) {
					let acc = 7;
					for (const char of text) acc = (acc * 31 + char.charCodeAt(0)) % 0xffffffff;
					return acc.toString(16).padStart(8, "0").repeat(8);
				},
			},
		},
		clock: time.clock,
		logger: silentEventLogger,
		scratch: {
			async create(runId) {
				const path = `/scratch/${runId}`;
				scratch.created.push(path);
				return path;
			},
			async remove(path) {
				scratch.removed.push(path);
			},
		},
		every(ms, task) {
			const timer = { ms, task, stopped: false };
			timers.push(timer);
			return () => {
				timer.stopped = true;
			};
		},
		newFenceToken: () => "fence",
		allowUnverifiedToolIsolation: false,
		marketSources: new Map([
			[
				"fred",
				unconfiguredMarketSeriesSource(
					"fred",
					marketUnavailableReason("SOURCE_NOT_CONFIGURED", "fred"),
				),
			],
			[
				"twelve-data",
				unconfiguredMarketSeriesSource(
					"twelve-data",
					marketUnavailableReason("SOURCE_NOT_CONFIGURED", "twelve-data"),
				),
			],
		]),
		// No limits by default: existing tests never wait. Tests that cover
		// pacing build their own pacer with a fake clock and sleep.
		marketPacer: createMarketPacer({ clock: time.clock, sleep: async () => {}, limits: new Map() }),
		earningsSources: new Map(),
		// No financial statement sources by default: a financial-sync job
		// fails honestly with FINANCIAL_SOURCE_NOT_CONFIGURED.
		equitySyncSources: new Map(),
		// No stock-directory sources by default: a refresh fails honestly
		// with DIRECTORY_NOT_CONFIGURED. Tests that cover it pass their own.
		stockDirectorySources: new Map(),
		// Google sync is unconfigured by default: every google-calendar job
		// fails honestly with GOOGLE_NOT_CONFIGURED. Tests that cover the
		// flows override this bag with a fake server and a temp token file.
		google: {
			config: { clientId: null, clientSecret: null, tokenFile: "/scratch/google-token.json" },
			http: async () => {
				throw new Error("no Google HTTP in this test");
			},
			sleep: async () => {},
		},
	};
	return {
		deps,
		agent,
		tools,
		scratch,
		timers,
		time,
		fetchedUrls,
		/** Fires the heartbeat timer once and lets its promise chain settle. */
		async tickHeartbeat() {
			for (const timer of timers) if (!timer.stopped) timer.task();
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}
