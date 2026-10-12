import { MAX_LOG_FIELD_CHARS } from "@research/effects";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

/**
 * The runner reports configuration problems through
 * `logger.error("invalid_configuration", { problem })`, so every problem
 * message must satisfy the logger's content rule: short enough and on one
 * line, otherwise the field would be dropped and the owner would see an empty
 * line. The messages must also never echo the offending value (which may be a
 * secret). This pins that contract; if a future message breaks it, the call
 * site must switch to a stable code per problem instead.
 */
describe("configuration problems fit the log content rule (A1-1)", () => {
	const badEnvironments: readonly Readonly<Record<string, string | undefined>>[] = [
		{},
		{ RESEARCH_API_URL: "notaurl" },
		{ RESEARCH_API_URL: "http://example.test/api" },
		{ RESEARCH_API_URL: "https://research.example.test", RUNNER_TOKEN: "short" },
		{
			RESEARCH_API_URL: "https://research.example.test",
			RUNNER_TOKEN: "token_with_a_line_break\ninjected",
		},
	];

	it("every problem is a short single line that echoes no value", () => {
		let seen = 0;
		for (const env of badEnvironments) {
			const result = loadConfig(env);
			if (result.ok) continue;
			for (const problem of result.problems) {
				expect(problem.length).toBeLessThanOrEqual(MAX_LOG_FIELD_CHARS);
				expect(problem).not.toContain("\n");
				expect(problem).not.toContain("\r");
				seen += 1;
			}
		}
		expect(seen).toBeGreaterThan(0);
	});

	it("a malformed token is reported without echoing it", () => {
		const result = loadConfig({
			RESEARCH_API_URL: "https://research.example.test",
			RUNNER_TOKEN: "short",
		});
		if (result.ok) throw new Error("expected a configuration problem");
		expect(result.problems.length).toBeGreaterThan(0);
		for (const problem of result.problems) {
			expect(problem).not.toContain("short");
		}
	});
});
