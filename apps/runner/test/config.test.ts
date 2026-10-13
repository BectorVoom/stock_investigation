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

describe("market data configuration (FR-017)", () => {
	const base = {
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: "token_with_enough_characters_01",
	};

	it("leaves both provider keys unset and the Twelve Data rate at 8 per minute by default", () => {
		const result = loadConfig(base);
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(result.value.fredApiKey).toBeNull();
		expect(result.value.twelveDataApiKey).toBeNull();
		expect(result.value.twelveDataRequestsPerMinute).toBe(8);
	});

	it("leaves the Finnhub key unset by default and accepts it when given", () => {
		const blank = loadConfig(base);
		if (!blank.ok) throw new Error(`expected a valid config: ${blank.problems.join("; ")}`);
		expect(blank.value.finnhubApiKey).toBeNull();
		const keyed = loadConfig({ ...base, FINNHUB_API_KEY: "finnhub-key" });
		if (!keyed.ok) throw new Error(`expected a valid config: ${keyed.problems.join("; ")}`);
		expect(keyed.value.finnhubApiKey).toBe("finnhub-key");
	});

	it("accepts both keys and a rate override", () => {
		const result = loadConfig({
			...base,
			FRED_API_KEY: "fred-key",
			TWELVE_DATA_API_KEY: "twelve-key",
			TWELVE_DATA_REQUESTS_PER_MINUTE: "30",
		});
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(result.value.fredApiKey).toBe("fred-key");
		expect(result.value.twelveDataApiKey).toBe("twelve-key");
		expect(result.value.twelveDataRequestsPerMinute).toBe(30);
	});

	it.each([
		"0",
		"601",
		"1000",
		"8.5",
		"many",
	])("rejects a TWELVE_DATA_REQUESTS_PER_MINUTE of %j without echoing it", (value) => {
		const result = loadConfig({ ...base, TWELVE_DATA_REQUESTS_PER_MINUTE: value });
		if (result.ok) throw new Error(`expected a configuration problem for ${value}`);
		expect(result.problems.length).toBeGreaterThan(0);
		for (const problem of result.problems) {
			expect(problem.length).toBeLessThanOrEqual(MAX_LOG_FIELD_CHARS);
			expect(problem).not.toContain("\n");
			expect(problem).not.toContain(value);
		}
	});
});
