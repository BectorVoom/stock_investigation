import { env } from "cloudflare:test";
import type { Clock } from "@research/application";
import { apiErrorBodySchema, CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { err, ok } from "@research/domain";
import { Effect, type EventLogger, UnexpectedError } from "@research/effects";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, defectResponse } from "../src/app.ts";
import { type AppEnv, respond } from "../src/http.ts";
import { apiError, createHarness } from "./helpers.ts";

const ORIGIN = "http://localhost";

/** A clock that throws, so the workspace creation use case throws mid-call. */
function throwingClock(sentinel: string): Clock {
	return {
		nowMs: () => {
			throw new Error(sentinel);
		},
		nowIso: () => {
			throw new Error(sentinel);
		},
	};
}

describe("HTTP error boundary (ADR-0007)", () => {
	it("maps a throwing use case to INTERNAL without leaking the failure", async () => {
		const sentinel = "clock-boom-sentinel";
		const app = createApp({
			overrides: {
				clock: throwingClock(sentinel),
				ownerAuthenticator: async (request) =>
					request.headers.get("X-Test-Anonymous") === "1"
						? err("UNAUTHENTICATED")
						: ok({ ownerId: "owner-error-boundary@example.test", authMode: "local-dev" }),
			},
		});
		const response = await app.request(
			`${ORIGIN}/api/v1/workspaces`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ORIGIN,
					[CSRF_HEADER]: CSRF_HEADER_VALUE,
				},
				body: JSON.stringify({ title: "Boundary probe" }),
			},
			{ DB: env.DB },
		);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).not.toContain(sentinel);
		expect(text).not.toContain("stack");
		// Exactly the stable INTERNAL body: no detail, no trace.
		expect(apiErrorBodySchema.parse(JSON.parse(text)).error).toEqual({
			code: "INTERNAL",
			message: "Internal error.",
		});
	});

	it("still maps an expected failure to its stable code and status", async () => {
		const harness = createHarness();
		const response = await harness.call("GET", "/research-runs/run_missing");
		expect(response.status).toBe(404);
		expect((await apiError(response)).code).toBe("NOT_FOUND");
	});
});

/** A logger whose every call throws, as a failed log writer does. */
function throwingLogger(): EventLogger {
	const boom = (): never => {
		throw new Error("log writer down");
	};
	return { info: boom, warn: boom, error: boom, logFailures: () => 0 };
}

describe("HTTP error boundary with a throwing logger (A1-2)", () => {
	it("respond still answers INTERNAL with the stable body", async () => {
		const probe = new Hono<AppEnv>();
		probe.get("/probe", (c) =>
			respond(
				c,
				throwingLogger(),
				Effect.fail(new UnexpectedError({ operation: "probe.boom", errorName: "Error" })),
			),
		);
		const response = await probe.request(`${ORIGIN}/probe`);
		expect(response.status).toBe(500);
		const text = await response.text();
		// Exactly the stable INTERNAL body: no detail, no trace.
		expect(apiErrorBodySchema.parse(JSON.parse(text)).error).toEqual({
			code: "INTERNAL",
			message: "Internal error.",
		});
	});

	it("the defect boundary still answers INTERNAL with the stable body", async () => {
		const probe = new Hono<AppEnv>();
		probe.get("/probe", (c) => defectResponse(throwingLogger(), new Error("boom"), c));
		const response = await probe.request(`${ORIGIN}/probe`);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).not.toContain("boom");
		expect(apiErrorBodySchema.parse(JSON.parse(text)).error).toEqual({
			code: "INTERNAL",
			message: "Internal error.",
		});
	});
});
