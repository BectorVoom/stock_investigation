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

describe("Twelve Data daily limit (TWELVE_DATA_DAILY_LIMIT)", () => {
	const base = {
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: "token_with_enough_characters_01",
	};

	it.each([
		[undefined, 800],
		["", 800],
		[" 5000 ", 5000],
		["0", 0],
		["1000000", 1_000_000],
	])("reads %j as %d (default: the Basic plan's 800; 0: no daily limit)", (value, expected) => {
		const result = loadConfig(
			value === undefined ? base : { ...base, TWELVE_DATA_DAILY_LIMIT: value },
		);
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(result.value.twelveDataDailyLimit).toBe(expected);
	});

	it.each([
		"1000001",
		"-1",
		"8.5",
		"many",
		"1e3",
	])("rejects %j with one message that names the setting and not the value", (value) => {
		const result = loadConfig({ ...base, TWELVE_DATA_DAILY_LIMIT: value });
		if (result.ok) throw new Error(`expected a configuration problem for ${value}`);
		expect(result.problems).toEqual([
			"TWELVE_DATA_DAILY_LIMIT must be a whole number from 0 to 1000000 (0: no daily limit)",
		]);
		expect(result.problems[0]).not.toContain(value);
	});
});

describe("Google Calendar configuration (FR-019 section 2.6)", () => {
	const base = {
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: "token_with_enough_characters_01",
	};

	it("leaves the OAuth pair unset and defaults the token file, accepting all three when given", () => {
		const blank = loadConfig(base);
		if (!blank.ok) throw new Error(`expected a valid config: ${blank.problems.join("; ")}`);
		expect(blank.value.googleOAuthClientId).toBeNull();
		expect(blank.value.googleOAuthClientSecret).toBeNull();
		expect(blank.value.googleTokenFile).toBe("google-token.json");
		const keyed = loadConfig({
			...base,
			GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
			GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
			GOOGLE_TOKEN_FILE: "data/google-token.json",
		});
		if (!keyed.ok) throw new Error(`expected a valid config: ${keyed.problems.join("; ")}`);
		expect(keyed.value.googleOAuthClientId).toBe("google-client-id");
		expect(keyed.value.googleOAuthClientSecret).toBe("google-client-secret");
		expect(keyed.value.googleTokenFile).toBe("data/google-token.json");
	});
});

describe("EDINET is removed (ADR-0059 §5)", () => {
	it("no longer reads EDINET_API_KEY: any value is ignored, never a problem", () => {
		const result = loadConfig({
			RESEARCH_API_URL: "https://research.example.test",
			RUNNER_TOKEN: "token_with_enough_characters_01",
			EDINET_API_KEY: "has a space",
		});
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(Object.keys(result.value).some((key) => /edinet/i.test(key))).toBe(false);
	});
});

describe("stock price configuration (ADR-0058 §7)", () => {
	const base = {
		RESEARCH_API_URL: "https://research.example.test",
		RUNNER_TOKEN: "token_with_enough_characters_01",
	};

	it("leaves both keys unset and defaults to the free plans", () => {
		const result = loadConfig(base);
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(result.value).toMatchObject({
			massiveApiKey: null,
			massiveRequestsPerMinute: 5,
			jquantsApiKey: null,
			jquantsRequestsPerMinute: 3,
			jquantsDelayDays: 84,
		});
	});

	it("accepts keys, rates and a paid plan's zero delay", () => {
		const result = loadConfig({
			...base,
			MASSIVE_API_KEY: " massive-key-01 ",
			MASSIVE_REQUESTS_PER_MINUTE: "100",
			JQUANTS_API_KEY: "jquants-key-01",
			JQUANTS_REQUESTS_PER_MINUTE: "60",
			JQUANTS_DELAY_DAYS: "0",
		});
		if (!result.ok) throw new Error(`expected a valid config: ${result.problems.join("; ")}`);
		expect(result.value).toMatchObject({
			massiveApiKey: "massive-key-01",
			massiveRequestsPerMinute: 100,
			jquantsApiKey: "jquants-key-01",
			jquantsRequestsPerMinute: 60,
			jquantsDelayDays: 0,
		});
	});

	it("refuses bad values with one message naming the setting, never the value", () => {
		const result = loadConfig({
			...base,
			MASSIVE_API_KEY: "has a space",
			MASSIVE_REQUESTS_PER_MINUTE: "0",
			JQUANTS_API_KEY: "short",
			JQUANTS_REQUESTS_PER_MINUTE: "601",
			JQUANTS_DELAY_DAYS: "366",
		});
		if (result.ok) throw new Error("expected problems");
		expect(result.problems).toEqual([
			"MASSIVE_API_KEY must be 8–200 printable characters without spaces",
			"MASSIVE_REQUESTS_PER_MINUTE must be a whole number from 1 to 600",
			"JQUANTS_API_KEY must be 8–200 printable characters without spaces",
			"JQUANTS_REQUESTS_PER_MINUTE must be a whole number from 1 to 600",
			"JQUANTS_DELAY_DAYS must be a whole number from 0 to 365",
		]);
		for (const value of ["many", "1.5", "-1", "1e2"]) {
			const bad = loadConfig({ ...base, JQUANTS_DELAY_DAYS: value });
			if (bad.ok) throw new Error(`expected a problem for ${value}`);
			expect(bad.problems).toEqual(["JQUANTS_DELAY_DAYS must be a whole number from 0 to 365"]);
		}
	});
});
