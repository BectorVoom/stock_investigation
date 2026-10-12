/**
 * Runner exit codes as a pure mapping from tagged failures (ARCH-010). The
 * entry point handles every expected failure through `exitCodeForFailure`, so
 * the mapping is unit-testable without starting a process.
 */
import type { UnexpectedError } from "@research/effects";
import { Data } from "effect";

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
	readonly problems: readonly string[];
}> {}

export class CredentialRenewalError extends Data.TaggedError("CredentialRenewalError")<{
	readonly code: string;
}> {}

/**
 * WHY a distinct failure: the runner's pinned HTTPS fetcher never completes
 * under Bun's Node compatibility layer (every network tool times out), so a
 * Bun start must fail loudly at start-up instead of mis-running. Detected
 * through `process.versions.bun`.
 */
export class UnsupportedRuntimeError extends Data.TaggedError("UnsupportedRuntimeError")<{
	readonly runtime: string;
}> {}

export type RunnerFailure =
	| ConfigurationError
	| CredentialRenewalError
	| UnsupportedRuntimeError
	| UnexpectedError;

/**
 * WHY one function: every runner failure maps to its process exit code here.
 * Invalid configuration exits 2 (the owner must fix the environment);
 * an unsupported runtime exits 3 so the launcher can name it;
 * anything else that stops the runner exits 1.
 */
export function exitCodeForFailure(failure: RunnerFailure): number {
	switch (failure._tag) {
		case "ConfigurationError":
			return 2;
		case "UnsupportedRuntimeError":
			return 3;
		case "CredentialRenewalError":
		case "UnexpectedError":
			return 1;
	}
}
