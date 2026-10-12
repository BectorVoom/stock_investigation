import { describe, expect, it, vi } from "vitest";
import { buildChildEnv } from "../../src/providers/environment.ts";
import {
	asKnownCostUsd,
	createTurnGuard,
	hintFromHttpStatus,
	hintFromText,
	isValidModelId,
	PROVIDER_FAILURES,
	preflightTurn,
} from "../../src/providers/turn.ts";
import { BASE_ENV, makeContext, makeRequest, SECRET_ENV } from "./helpers.ts";

describe("createTurnGuard", () => {
	it("keeps the first stop reason: a later deadline cannot relabel a cancellation", () => {
		vi.useFakeTimers();
		try {
			const external = new AbortController();
			const guard = createTurnGuard(external.signal, Date.now() + 1_000, Date.now());

			external.abort();
			vi.advanceTimersByTime(2_000);
			guard.stop("finished");

			expect(guard.reason()).toBe("aborted");
			expect(guard.signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops with `deadline` when the deadline passes first, and resolves `stopped`", async () => {
		vi.useFakeTimers();
		try {
			const guard = createTurnGuard(new AbortController().signal, Date.now() + 1_000, Date.now());

			expect(guard.reason()).toBeNull();
			vi.advanceTimersByTime(1_000);

			expect(await guard.stopped).toBe("deadline");
			expect(guard.signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("is stopped from the start when the external signal is already aborted", () => {
		const external = new AbortController();
		external.abort();

		const guard = createTurnGuard(external.signal, Date.now() + 60_000, Date.now());

		expect(guard.reason()).toBe("aborted");
		guard.stop("finished");
	});

	it("leaves no timer behind once stopped", () => {
		vi.useFakeTimers();
		try {
			const guard = createTurnGuard(new AbortController().signal, Date.now() + 60_000, Date.now());
			guard.stop("finished");

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("preflightTurn", () => {
	const now = Date.parse("2026-10-11T00:00:00.000Z");

	it("accepts a future deadline and returns it in epoch milliseconds", () => {
		expect(
			preflightTurn(makeRequest({ deadline: "2026-10-11T00:01:00+09:00" }), makeContext(), 0),
		).toEqual({
			ok: true,
			deadlineEpochMs: Date.parse("2026-10-10T15:01:00.000Z"),
		});
	});

	it("rejects a deadline that is exactly now or earlier", () => {
		expect(
			preflightTurn(makeRequest({ deadline: "2026-10-11T00:00:00.000Z" }), makeContext(), now),
		).toEqual({
			ok: false,
			failure: PROVIDER_FAILURES.DEADLINE_EXCEEDED,
		});
	});

	it("rejects an unparseable deadline instead of running without one", () => {
		expect(preflightTurn(makeRequest({ deadline: "soon" }), makeContext(), now)).toEqual({
			ok: false,
			failure: PROVIDER_FAILURES.REQUEST_INVALID,
		});
	});
});

describe("isValidModelId", () => {
	it.each([
		"sonnet",
		"gpt-6.1-sol",
		"opencode-go/glm-5.3-flash",
		"anthropic/claude-sonnet-4.5",
		"meta-llama/llama-3.3-70b-instruct:free",
		"~openai/gpt-sol-latest",
		"provider/model#high",
	])("accepts %s", (model) => {
		expect(isValidModelId(model)).toBe(true);
	});

	it.each([
		"",
		"-m",
		"--model",
		"a b",
		"a\tb",
		"a;b",
		"$(id)",
		"a`b",
		"../x y",
		"x".repeat(101),
	])("rejects %j", (model) => {
		expect(isValidModelId(model)).toBe(false);
	});
});

describe("failure hints", () => {
	it.each([
		["Not logged in · Please run /login", "auth"],
		["unexpected status 401 Unauthorized: Missing bearer", "auth"],
		["You've hit your usage limit", "rate-limit"],
		["429 Too Many Requests", "rate-limit"],
		["Insufficient credits", "payment"],
		["Overloaded", "unavailable"],
		["segmentation fault", null],
		["took 4010 ms on port 14290", null],
	])("reads %j as %j", (text, hint) => {
		expect(hintFromText(text)).toBe(hint);
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[402, "payment"],
		[429, "rate-limit"],
		[500, "unavailable"],
		[529, "unavailable"],
		[400, null],
		[404, null],
	])("reads HTTP %i as %j", (status, hint) => {
		expect(hintFromHttpStatus(status)).toBe(hint);
	});
});

describe("asKnownCostUsd", () => {
	it.each([
		[0.5, 0.5],
		[0, 0],
		[-0.01, null],
		[Number.NaN, null],
		[Number.POSITIVE_INFINITY, null],
		[null, null],
		[undefined, null],
	])("maps %j to %j", (value, expected) => {
		expect(asKnownCostUsd(value)).toBe(expected);
	});
});

describe("buildChildEnv", () => {
	it("copies only the base keys and the named provider keys", () => {
		const childEnv = buildChildEnv(
			{ ...BASE_ENV, ...SECRET_ENV, CODEX_HOME: "/home/owner/.codex" },
			["CODEX_HOME"],
		);

		expect(childEnv).toEqual({ ...BASE_ENV, CODEX_HOME: "/home/owner/.codex" });
	});

	it("omits unset and empty variables instead of passing empty strings", () => {
		expect(buildChildEnv({ PATH: "/bin", HOME: undefined, LANG: "" }, ["CODEX_HOME"])).toEqual({
			PATH: "/bin",
		});
	});
});
