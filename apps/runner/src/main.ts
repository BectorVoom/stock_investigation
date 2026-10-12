import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedParser } from "@research/adapters/feed";
import { createFilePageArchive, createNodeSafeFetcher } from "@research/adapters/node";
import { createBaselineAgentRuntimes, createNodeProcessRunner } from "@research/adapters/providers";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createResearchTools } from "@research/adapters/tools";
import { createAgentRegistry, createToolRegistry } from "@research/agent-core";
import { attempt, createEventLogger, type EventLogger, UnexpectedError } from "@research/effects";
import { Effect } from "effect";
import { createHttpRunnerApi } from "./apiClient.ts";
import { loadConfig } from "./config.ts";
import {
	ConfigurationError,
	CredentialRenewalError,
	exitCodeForFailure,
	type RunnerFailure,
	UnsupportedRuntimeError,
} from "./exitCodes.ts";
import type { ScratchDirectories } from "./jobExecution.ts";
import { runRunnerLoop } from "./runner.ts";
import { isUnsupportedRuntime, runtimeName } from "./runtime.ts";

/** Sleep that ends early when the runner is asked to stop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function createScratchDirectories(root: string): ScratchDirectories {
	return {
		async create() {
			await mkdir(root, { recursive: true, mode: 0o700 });
			// mkdtemp creates the directory with mode 0700 and an unpredictable suffix.
			return mkdtemp(join(root, "job-"));
		},
		remove: (path) => rm(path, { recursive: true, force: true }),
	};
}

/** Class name of an escaped defect for the crash log — never its message (SEC-010). */
function defectName(defect: unknown): string {
	if (defect instanceof Error) return defect.constructor.name;
	return "unknown";
}

/**
 * The runner as one Effect program (ADR-0007): expected failures are tagged
 * errors handled once at the bottom of this file; `runRunnerLoop` itself is
 * untouched and only wrapped with `attempt`.
 */
function runnerProgram(
	logger: EventLogger,
): Effect.Effect<
	number,
	ConfigurationError | CredentialRenewalError | UnsupportedRuntimeError | UnexpectedError
> {
	return Effect.gen(function* () {
		// The runner's first log line names the runtime (process.release.name /
		// versions), so a mis-run under Bun is visible in the log before
		// anything else. (With --env-file-if-exists, Node itself may print an
		// env notice to the same log first; this is still the runner's first
		// line.)
		yield* Effect.sync(() =>
			logger.info("runner_started", {
				runtime: runtimeName(process.versions),
				release: process.release.name,
				node: process.version,
			}),
		);
		if (isUnsupportedRuntime(process.versions)) {
			return yield* Effect.fail(
				new UnsupportedRuntimeError({ runtime: runtimeName(process.versions) }),
			);
		}
		const config = loadConfig(process.env);
		if (!config.ok) {
			return yield* Effect.fail(new ConfigurationError({ problems: config.problems }));
		}
		const { value } = config;
		const fetcher = createNodeSafeFetcher();
		const feedParser = createFeedParser();
		const api = createHttpRunnerApi({
			apiUrl: value.apiUrl,
			runnerToken: value.runnerToken,
			accessClientId: value.accessClientId,
			accessClientSecret: value.accessClientSecret,
			fetch,
			sleep,
		});

		if (process.argv[2] === "renew") {
			const renewed = yield* attempt("renew_credential", () => api.renewCredential(30));
			if (!renewed.ok) {
				return yield* Effect.fail(new CredentialRenewalError({ code: renewed.error.code }));
			}
			// The new token is printed once to stdout for the owner to store; it is never logged.
			process.stdout.write(`${renewed.value.token}\n`);
			return 0;
		}

		const shutdown = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				logger.info("shutdown_requested", { signal });
				shutdown.abort();
			});
		}
		if (value.secUserAgent === null)
			logger.warn("sec_tools_disabled", { reason: "SEC_USER_AGENT not set" });
		if (value.pagesDirectory === null)
			logger.warn("web_pages_disabled", { reason: "RUNNER_PAGES_DIR not set" });

		const exit = yield* attempt("run_runner_loop", () =>
			runRunnerLoop(
				{
					api,
					agents: createAgentRegistry(
						createBaselineAgentRuntimes({
							processRunner: createNodeProcessRunner(),
							fetch,
							env: process.env,
						}),
					),
					tools: createToolRegistry(
						createResearchTools({
							fetcher,
							feedParser,
							hasher: webCryptoHasher,
							clock: systemClock,
							secUserAgent: value.secUserAgent,
							pageArchive:
								value.pagesDirectory === null
									? null
									: createFilePageArchive({
											directory: value.pagesDirectory,
											hasher: webCryptoHasher,
										}),
							sleep,
						}),
					),
					feed: { fetcher, feedParser, hasher: webCryptoHasher },
					clock: systemClock,
					logger,
					scratch: createScratchDirectories(value.scratchRoot ?? join(tmpdir(), "research-runner")),
					every: (ms, task) => {
						const timer = setInterval(task, ms);
						return () => clearInterval(timer);
					},
					newFenceToken: () => crypto.randomUUID(),
					allowUnverifiedToolIsolation: value.allowUnverifiedToolIsolation,
					sleep,
				},
				shutdown.signal,
			),
		);
		return exit === "shutdown" ? 0 : 1;
	});
}

/** Maps one handled failure to its log lines and exit code. */
function reportFailure(logger: EventLogger, failure: RunnerFailure): Effect.Effect<number> {
	return Effect.sync(() => {
		switch (failure._tag) {
			case "ConfigurationError":
				for (const problem of failure.problems) logger.error("invalid_configuration", { problem });
				break;
			case "UnsupportedRuntimeError":
				logger.error("unsupported_runtime", { runtime: failure.runtime });
				break;
			case "CredentialRenewalError":
				logger.error("renew_failed", { code: failure.code });
				break;
			case "UnexpectedError":
				logger.error("runner_crashed", { error: failure.errorName });
				break;
		}
		return exitCodeForFailure(failure);
	});
}

/** Composition root of the local runner: the only place adapters are chosen. */
async function main(): Promise<number> {
	const logger = createEventLogger((line) => process.stderr.write(line));
	return Effect.runPromise(
		runnerProgram(logger).pipe(
			// ONE place where tagged failures become exit codes.
			Effect.catchTags({
				ConfigurationError: (failure) => reportFailure(logger, failure),
				CredentialRenewalError: (failure) => reportFailure(logger, failure),
				UnsupportedRuntimeError: (failure) => reportFailure(logger, failure),
				UnexpectedError: (failure) => reportFailure(logger, failure),
			}),
			// A defect is a bug that escaped the program: log its class name and exit 1
			// instead of leaving an unhandled rejection behind.
			Effect.catchDefect((defect) =>
				reportFailure(
					logger,
					new UnexpectedError({ operation: "run_runner", errorName: defectName(defect) }),
				),
			),
		),
	);
}

try {
	process.exitCode = await main();
} catch {
	// The crash reporter itself failed; the process still exits non-zero.
	process.exitCode = 1;
}
