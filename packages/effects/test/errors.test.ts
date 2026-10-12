import { err, ok } from "@research/domain";
import { Effect, Result as EffectResult } from "effect";
import { describe, expect, it } from "vitest";
import { attempt, attemptResult, fromResult, toResult, UnexpectedError } from "../src/index.ts";

describe("fromResult", () => {
	it("succeeds on ok", () => {
		expect(Effect.runSync(fromResult(ok(7)))).toBe(7);
	});

	it("fails with the typed error on err", () => {
		const outcome = Effect.runSync(Effect.result(fromResult(err("NOT_FOUND"))));
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (EffectResult.isFailure(outcome)) expect(outcome.failure).toBe("NOT_FOUND");
	});
});

describe("attempt", () => {
	it("succeeds when the promise resolves", async () => {
		await expect(Effect.runPromise(attempt("fetch_feed", async () => 42))).resolves.toBe(42);
	});

	it("maps a rejection to UnexpectedError without the thrown message", async () => {
		const outcome = await Effect.runPromise(
			Effect.result(attempt("fetch_feed", () => Promise.reject(new TypeError("secret detail")))),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) return;
		const failure = outcome.failure;
		expect(failure).toBeInstanceOf(UnexpectedError);
		expect(failure._tag).toBe("UnexpectedError");
		expect(failure.operation).toBe("fetch_feed");
		expect(failure.errorName).toBe("TypeError");
		expect(JSON.stringify(failure)).not.toContain("secret detail");
	});

	it("maps a synchronously throwing thunk the same way", async () => {
		const outcome = await Effect.runPromise(
			Effect.result(
				attempt("renew_credential", () => {
					throw new Error("bearer token material");
				}),
			),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) return;
		expect(outcome.failure.errorName).toBe("Error");
		expect(JSON.stringify(outcome.failure)).not.toContain("bearer token material");
	});

	it("names a non-Error rejection unknown instead of leaking the value", async () => {
		const outcome = await Effect.runPromise(
			Effect.result(attempt("claim", () => Promise.reject("plain string failure"))),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) return;
		expect(outcome.failure.errorName).toBe("unknown");
		expect(JSON.stringify(outcome.failure)).not.toContain("plain string failure");
	});
});

describe("attempt errorCode", () => {
	async function rejectionOf(thrown: unknown): Promise<UnexpectedError> {
		const outcome = await Effect.runPromise(
			Effect.result(attempt("write_file", () => Promise.reject(thrown))),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) throw new Error("expected failure");
		expect(outcome.failure).toBeInstanceOf(UnexpectedError);
		return outcome.failure;
	}

	it("keeps a safe OS error code without the message", async () => {
		const denied = Object.assign(new Error("EACCES: permission denied, open '/data/pages/x.md'"), {
			code: "EACCES",
		});
		const failure = await rejectionOf(denied);
		expect(failure.errorName).toBe("Error");
		expect(failure.errorCode).toBe("EACCES");
		expect(JSON.stringify(failure)).toContain("EACCES");
		expect(JSON.stringify(failure)).not.toContain("permission denied");
		expect(JSON.stringify(failure)).not.toContain("/data/pages/x.md");
	});

	it("keeps the code of a non-Error rejection", async () => {
		const failure = await rejectionOf({ code: "ENOENT" });
		expect(failure.errorCode).toBe("ENOENT");
	});

	it.each([
		["free text", "EACCES: permission denied, open '/data/pages/x.md'"],
		["lowercase", "eacces"],
		["a single letter", "E"],
		["a 33-character token", "E12345678901234567890123456789012"],
		["an empty string", ""],
		["a non-string", 13],
	])("drops %s instead of leaking it", async (_label, code) => {
		const failure = await rejectionOf(Object.assign(new Error("failing write"), { code }));
		expect(failure.errorCode).toBeUndefined();
		expect(JSON.stringify(failure)).not.toContain("failing write");
	});
});

describe("attemptResult", () => {
	it("passes an ok Result through", async () => {
		await expect(Effect.runPromise(attemptResult("claim", async () => ok("job")))).resolves.toBe(
			"job",
		);
	});

	it("passes a typed err through unwrapped", async () => {
		const outcome = await Effect.runPromise(
			Effect.result(attemptResult("claim", async () => err("UNAUTHENTICATED"))),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) return;
		// A typed failure stays a plain string: it is not an UnexpectedError.
		expect(outcome.failure).toBe("UNAUTHENTICATED");
	});

	it("wraps a rejection in UnexpectedError", async () => {
		const outcome = await Effect.runPromise(
			Effect.result(
				attemptResult("claim", () => Promise.reject(new Error("connection reset by peer"))),
			),
		);
		expect(EffectResult.isFailure(outcome)).toBe(true);
		if (!EffectResult.isFailure(outcome)) return;
		expect(outcome.failure).toBeInstanceOf(UnexpectedError);
		expect(JSON.stringify(outcome.failure)).not.toContain("connection reset by peer");
	});
});

describe("toResult", () => {
	it("converts success to ok", async () => {
		await expect(toResult(Effect.succeed(3))).resolves.toEqual(ok(3));
	});

	it("converts a typed failure to err", async () => {
		await expect(toResult(Effect.fail("STALE_LEASE"))).resolves.toEqual(err("STALE_LEASE"));
	});

	it("rejects on a defect instead of converting it", async () => {
		await expect(toResult(Effect.die(new Error("programmer bug")))).rejects.toThrow(
			"programmer bug",
		);
	});
});
