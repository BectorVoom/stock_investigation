/**
 * E2E runner: the real runner loop, real research tools and real feed parser,
 * with two seams replaced — the agent is the scripted example backend and
 * outbound fetches come from fixtures. It registers a backend ("scripted")
 * that the core has never heard of, which is FR-013 exercised end to end.
 *
 * This is NOT a network test: `fixtureFetcher` serves synthetic feeds and
 * never contacts the network, so a fetcher that hangs under the wrong runtime
 * (Defect 0: the pinned HTTPS fetcher under Bun) passes here and fails only
 * in the real-environment check (`bun run test:real`, which refreshes a real
 * subscribed feed through the real runner).
 *
 * With RUN_LIVE_OPENCODE=1 the agent registry is the real baseline runtimes
 * (so OpenCode is available, with OPENCODE_MODEL from the environment) and
 * per-job scratch directories are real temporary directories, because the
 * OpenCode adapter writes its deny-all config there. Without the switch the
 * scripted agent is used and no live backend is ever started.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedParser } from "@research/adapters/feed";
import { createGoogleHttp } from "@research/adapters/google";
import { createBaselineAgentRuntimes, createNodeProcessRunner } from "@research/adapters/providers";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createResearchTools } from "@research/adapters/tools";
import { createAgentRegistry, createToolRegistry } from "@research/agent-core";
import { EMPTY_USAGE } from "@research/domain";
import { createEventLogger } from "@research/effects";
import {
	createHttpRunnerApi,
	createMarketPacer,
	runRunnerLoop,
} from "../../apps/runner/src/index.ts";
import { fixtureStockDirectorySources } from "./directoryFixtures.ts";
import { createE2eScriptedAgent } from "./e2eScriptedAgent.ts";
import { fixtureEarningsSources } from "./earningsFixtures.ts";
import { fixtureEquitySyncSources } from "./equitySyncFixtures.ts";
import { E2E_ORIGIN, fixtureFetcher, GOOGLE_SIGN_IN_URL } from "./fixtures.ts";
import { googleUnconfiguredFlagFile } from "./googleFlag.ts";
import { fixtureMarketSources } from "./marketFixtures.ts";
import { issueToken, runnerFetch, sleep } from "./runnerToken.ts";

/** Live backend for `tests/e2e/opencodeLive.spec.ts`; unset everywhere else. */
const LIVE = process.env.RUN_LIVE_OPENCODE === "1";

const logger = createEventLogger((line) => process.stderr.write(line));

/** The scripted example backend with the E2E replies (shared with the Rust runner). */
const agent = createE2eScriptedAgent();

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());

const feedParser = createFeedParser();
// Without the live switch the scripted example backend runs; with it the
// real baseline runtimes (OpenCode included) answer. The registry is chosen
// here — the harness is not forked.
const agents = LIVE
	? createAgentRegistry(
			createBaselineAgentRuntimes({
				processRunner: createNodeProcessRunner(),
				fetch,
				env: process.env,
			}),
		)
	: createAgentRegistry([agent]);
// The scripted agent never touches the filesystem, but the live OpenCode
// adapter must write its per-run config into a real scratch directory
// (AGT-004): created empty under the OS temp dir, removed when the job ends.
const scratchRoot = LIVE ? await mkdtemp(join(tmpdir(), "research-e2e-live-")) : null;
const exit = await runRunnerLoop(
	{
		api: createHttpRunnerApi({
			apiUrl: E2E_ORIGIN,
			runnerToken: await issueToken(),
			accessClientId: null,
			accessClientSecret: null,
			fetch: runnerFetch,
			sleep,
		}),
		agents,
		tools: createToolRegistry(
			createResearchTools({
				fetcher: fixtureFetcher,
				feedParser,
				hasher: webCryptoHasher,
				clock: systemClock,
				secUserAgent: null,
				tavilyApiKey: null,
				pageArchive: null,
				sleep: (ms, signal) =>
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, Math.min(ms, 500));
						signal.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					}),
			}),
		),
		feed: { fetcher: fixtureFetcher, feedParser, hasher: webCryptoHasher },
		clock: systemClock,
		logger,
		scratch:
			scratchRoot === null
				? { create: async (runId) => `/nonexistent/e2e/${runId}`, remove: async () => {} }
				: {
						create: (runId) => mkdtemp(join(scratchRoot, `${runId}-`)),
						remove: (path) => rm(path, { recursive: true, force: true }).then(() => undefined),
					},
		every: (ms, task) => {
			const timer = setInterval(task, ms);
			return () => clearInterval(timer);
		},
		newFenceToken: () => crypto.randomUUID(),
		allowUnverifiedToolIsolation: false,
		// Market data: the real FRED and Twelve Data adapters served from real
		// recorded provider responses (tests/e2e/marketFixtures.ts) — no keys,
		// no network. Series without a recorded response fail as
		// SERIES_NOT_FOUND, so the browser only ever shows fixture numbers.
		marketSources: fixtureMarketSources(),
		// No limits in E2E: the fixture loop never paces.
		marketPacer: createMarketPacer({ clock: systemClock, sleep, limits: new Map() }),
		// Earnings dates: canned Finnhub/JPX answers beside the market
		// fixtures (tests/e2e/earningsFixtures.ts) — no keys, no network.
		// Stocks without a recorded answer fail with the fixed unavailable
		// wording, so the browser only ever shows fixture dates.
		earningsSources: fixtureEarningsSources(),
		// Stock lists (ADR-0034): canned US and JP lists from the shared
		// fixture file (tests/e2e/directoryFixtures.ts), padded to the
		// contract's floor — no SEC, no JPX, no network.
		stockDirectorySources: fixtureStockDirectorySources(),
		// Financial statements (ADR-0045): the canned SEC and EDINET
		// completions beside the synthetic inputs (tests/e2e/equitySyncFixtures.ts)
		// — no keys, no network.
		equitySyncSources: fixtureEquitySyncSources(),
		// Google Calendar is out of scope for the browser suite: no
		// credentials, so any google-calendar job fails honestly with
		// GOOGLE_NOT_CONFIGURED (FR-019 section 2.6 wiring only).
		google: {
			config: {
				clientId: null,
				clientSecret: null,
				tokenFile: join(tmpdir(), "research-e2e-google-token.json"),
			},
			http: createGoogleHttp(),
			sleep: (ms, signal) =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, Math.min(ms, 500));
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					});
				}),
		},
		// FR-019 section 2.7: the browser suite scripts the Google OAuth
		// dance instead of performing it (no browser consent, no Google).
		// Connect sends one fixture sign-in URL, waits so the test can see
		// it, then completes as connected; sync completes with fixture
		// counts; disconnect completes unrevoked. While the flag file below
		// exists (a test creates it to cover the failure sentence, then
		// removes it) every google-calendar job fails honestly with
		// GOOGLE_NOT_CONFIGURED, exactly like the unconfigured runner.
		executeGoogleCalendar: async (job, env, signal, reporter, sendAuthUrl) => {
			if (existsSync(googleUnconfiguredFlagFile())) {
				env.logger.warn("google_not_configured", { runId: job.runId });
				return {
					outcome: "failed",
					leaseGeneration: job.leaseGeneration,
					usage: EMPTY_USAGE,
					failureCode: "GOOGLE_NOT_CONFIGURED",
					retryable: false,
				};
			}
			if (job.action === "connect") {
				await reporter.state("planning");
				const delivered = await sendAuthUrl(GOOGLE_SIGN_IN_URL);
				if (!delivered) {
					env.logger.warn("google_auth_timeout", { runId: job.runId });
					return {
						outcome: "failed",
						leaseGeneration: job.leaseGeneration,
						usage: EMPTY_USAGE,
						failureCode: "GOOGLE_AUTH_TIMEOUT",
						retryable: false,
					};
				}
				await reporter.state("collecting");
				// The owner "signs in": hold the URL visible across at least
				// one queued-cadence poll (10 s), then connect.
				for (let waited = 0; waited < 24 && !signal.aborted; waited += 1) {
					await env.google.sleep(500, signal);
				}
				if (signal.aborted) {
					return {
						outcome: "failed",
						leaseGeneration: job.leaseGeneration,
						usage: EMPTY_USAGE,
						failureCode: "GOOGLE_AUTH_TIMEOUT",
						retryable: false,
					};
				}
				// The full pipeline chain (the transition matrix rejects
				// jumps like collecting straight to publishing).
				await reporter.state("analyzing");
				await reporter.state("verifying");
				env.logger.info("google_connected", { runId: job.runId, calendarId: "e2e-calendar" });
				await reporter.state("publishing");
				return {
					outcome: "google-calendar-connected",
					leaseGeneration: job.leaseGeneration,
					usage: EMPTY_USAGE,
					calendarId: "e2e-calendar",
				};
			}
			if (job.action === "sync") {
				await reporter.state("planning");
				await reporter.state("collecting");
				const events = job.events ?? [];
				env.logger.info("google_synced", {
					runId: job.runId,
					calendarId: "e2e-calendar",
					inserted: events.length,
					updated: 0,
					deleted: 0,
					unchanged: 0,
				});
				await reporter.state("analyzing");
				await reporter.state("verifying");
				await reporter.state("publishing");
				return {
					outcome: "google-calendar-synced",
					leaseGeneration: job.leaseGeneration,
					usage: EMPTY_USAGE,
					calendarId: "e2e-calendar",
					desiredDigest: job.desiredDigest ?? "0".repeat(64),
					inserted: events.length,
					updated: 0,
					deleted: 0,
					unchanged: 0,
				};
			}
			await reporter.state("planning");
			await reporter.state("collecting");
			await reporter.state("analyzing");
			await reporter.state("verifying");
			env.logger.info("google_disconnected", { runId: job.runId, revoked: false });
			await reporter.state("publishing");
			return {
				outcome: "google-calendar-disconnected",
				leaseGeneration: job.leaseGeneration,
				usage: EMPTY_USAGE,
				revoked: false,
			};
		},
		// Poll quickly so the browser test does not wait on the production idle interval.
		sleep: (ms, signal) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(ms, 500));
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			}),
	},
	shutdown.signal,
);
process.exitCode = exit === "shutdown" ? 0 : 1;
