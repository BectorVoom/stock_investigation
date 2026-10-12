import { UnexpectedError } from "@research/effects";
import { describe, expect, it } from "vitest";
import {
	ConfigurationError,
	CredentialRenewalError,
	exitCodeForFailure,
	UnsupportedRuntimeError,
} from "../src/exitCodes.ts";

describe("runner exit codes", () => {
	it("maps invalid configuration to exit code 2", () => {
		const failure = new ConfigurationError({
			problems: ["RESEARCH_API_URL must be https (http is allowed for localhost only)"],
		});
		expect(exitCodeForFailure(failure)).toBe(2);
	});

	it("maps a failed credential renewal to exit code 1", () => {
		expect(exitCodeForFailure(new CredentialRenewalError({ code: "UNAUTHENTICATED" }))).toBe(1);
	});

	it("maps an unsupported runtime to exit code 3", () => {
		expect(exitCodeForFailure(new UnsupportedRuntimeError({ runtime: "bun" }))).toBe(3);
	});

	it("maps an unexpected failure to exit code 1", () => {
		expect(
			exitCodeForFailure(new UnexpectedError({ operation: "run_runner_loop", errorName: "Error" })),
		).toBe(1);
	});

	it("carries the _tag each typed handler matches on", () => {
		expect(new ConfigurationError({ problems: [] })._tag).toBe("ConfigurationError");
		expect(new CredentialRenewalError({ code: "x" })._tag).toBe("CredentialRenewalError");
		expect(new UnsupportedRuntimeError({ runtime: "bun" })._tag).toBe("UnsupportedRuntimeError");
		expect(new UnexpectedError({ operation: "op", errorName: "Error" })._tag).toBe(
			"UnexpectedError",
		);
	});
});
