/**
 * The examples in docs/external-apis/apis/claude-api.md, fed through the
 * TypeScript runner's own Claude API adapter (conventions.md §4): the request
 * the adapter sends must equal the documented one, and the documented live
 * stream must parse into a completed, priced turn.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	buildClaudeRequestBody,
	CLAUDE_API_MESSAGES_URL,
	failureForClaudeErrorType,
	failureForClaudeRejection,
	interpretClaudeSseLine,
	MAX_OUTPUT_TOKENS,
} from "../../src/providers/claudeApi.ts";
import { createClaudeApiRuntime } from "../../src/providers/index.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import {
	BASE_ENV,
	collect,
	itemAt,
	makeContext,
	makeEnvironment,
	makeRequest,
	recordingFetch,
	sseResponse,
	terminalEvents,
	textOf,
	usageEvents,
} from "./helpers.ts";

const API_KEY = "sk-ant-api03-DOC-EXAMPLE-0123456789abcdef";
const PROMPT = "Reply with the single word OK.";

const errorBodySchema = z.looseObject({
	type: z.literal("error"),
	error: z.looseObject({ type: z.string(), message: z.string() }),
	request_id: z.string(),
});

function documentedRequest(): { headers: Map<string, string>; body: string } {
	const lines = docExampleText("claude-api", "claude-api-messages-request").split("\n");
	const blank = lines.indexOf("");
	const headers = new Map<string, string>();
	for (const line of lines.slice(1, blank)) {
		const colon = line.indexOf(":");
		headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
	}
	return { headers, body: lines.slice(blank + 1).join("\n") };
}

describe("claude-api.md examples", () => {
	it("documents the exact request body and headers the adapter sends", async () => {
		const documented = documentedRequest();
		// The documented request is the bounded diagnostic one (max_tokens 16); otherwise byte-identical.
		expect(documented.body).toContain('"max_tokens":16,');
		const production = documented.body.replace(
			'"max_tokens":16,',
			`"max_tokens":${MAX_OUTPUT_TOKENS},`,
		);
		expect(production).toBe(buildClaudeRequestBody("claude-haiku-5-5", PROMPT, "low"));

		const stream = `${docExampleText("claude-api", "claude-api-messages-stream")}\n`;
		const fake = recordingFetch(() => sseResponse(stream));
		const runtime = createClaudeApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, ANTHROPIC_API_KEY: API_KEY } }),
		);
		await collect(
			runtime.run(
				makeRequest({ prompt: PROMPT }),
				makeContext({ model: "claude-haiku-5-5", effort: "low" }),
			),
		);
		const call = itemAt(fake.calls, 0);
		expect(call.url).toBe(CLAUDE_API_MESSAGES_URL);
		expect(call.init.body).toBe(production);
		const sent = new Headers(call.init.headers);
		for (const [name, value] of documented.headers) {
			if (name === "host") continue;
			expect(sent.get(name), name).toBe(name === "x-api-key" ? API_KEY : value);
		}
	});

	it("parses the live stream into the answer text and a priced, completed turn", async () => {
		const stream = `${docExampleText("claude-api", "claude-api-messages-stream")}\n`;
		for (const line of stream.split("\n")) {
			expect(interpretClaudeSseLine(line).kind, line).not.toBe("malformed");
		}
		const fake = recordingFetch(() => sseResponse(stream));
		const runtime = createClaudeApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, ANTHROPIC_API_KEY: API_KEY } }),
		);
		const events = await collect(
			runtime.run(makeRequest(), makeContext({ model: "claude-haiku-5-5", effort: "low" })),
		);
		expect(textOf(events)).toBe("OK");
		expect(terminalEvents(events)).toEqual([{ type: "completed" }]);
		const usage = itemAt(usageEvents(events), 0);
		// 18 input and 4 output tokens at Haiku 5.5's 0.10 / 0.50 USD per million.
		expect(usage.type === "usage" ? usage.knownCostUsd : null).toBeCloseTo(3.8e-6, 12);
	});

	it("retries the documented error event before message_start, then fails as unavailable", async () => {
		const stream = `${docExampleText("claude-api", "claude-api-stream-error-overloaded")}\n\n`;
		vi.useFakeTimers();
		try {
			const fake = recordingFetch(() => sseResponse(stream));
			const runtime = createClaudeApiRuntime(
				makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, ANTHROPIC_API_KEY: API_KEY } }),
			);
			const pending = collect(runtime.run(makeRequest(), makeContext()));
			// REJECTION_RETRY: three retries after 2 s, 4 s and 8 s.
			await vi.advanceTimersByTimeAsync(2_000);
			expect(fake.calls).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(fake.calls).toHaveLength(3);
			await vi.advanceTimersByTimeAsync(8_000);
			const events = await pending;
			expect(fake.calls).toHaveLength(4);
			expect(events).toEqual([
				{ type: "usage", knownCostUsd: null },
				{ type: "failed", code: "PROVIDER_UNAVAILABLE", retryable: true },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails the documented spend-cap 429 at once as PROVIDER_PAYMENT_REQUIRED", async () => {
		const body = JSON.stringify(docExampleJson("claude-api", "claude-api-error-429-spend-cap"));
		expect(failureForClaudeRejection(429, body)).toEqual({
			code: "PROVIDER_PAYMENT_REQUIRED",
			retryable: false,
			upstreamStatus: 429,
		});
		const fake = recordingFetch(() => new Response(body, { status: 429 }));
		const runtime = createClaudeApiRuntime(
			makeEnvironment({ fetch: fake.fetch, env: { ...BASE_ENV, ANTHROPIC_API_KEY: API_KEY } }),
		);
		const events = await collect(runtime.run(makeRequest(), makeContext()));
		expect(events).toEqual([
			{ type: "failed", code: "PROVIDER_PAYMENT_REQUIRED", retryable: false, upstreamStatus: 429 },
		]);
		expect(fake.calls).toHaveLength(1);
	});

	it("maps the documented error answers (status and body) to the same failure as their type", () => {
		for (const [id, status] of [
			["claude-api-error-401", 401],
			["claude-api-error-404", 404],
		] as const) {
			const body = errorBodySchema.parse(
				id === "claude-api-error-401"
					? docExampleJson("claude-api", "claude-api-error-401")
					: docExampleJson("claude-api", "claude-api-error-404"),
			);
			const byStatus = failureForClaudeRejection(status, JSON.stringify(body));
			expect(byStatus.upstreamStatus).toBe(status);
			expect(failureForClaudeErrorType(body.error.type).code).toBe(byStatus.code);
		}
	});
});
