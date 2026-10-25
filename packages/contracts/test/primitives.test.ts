import { describe, it } from "vitest";
import {
	API_ERROR_CODES,
	apiErrorBodySchema,
	apiErrorCodeSchema,
	currencySchema,
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	jsonObjectSchema,
	jsonValueSchema,
	longTextSchema,
	marketSchema,
	shortTextSchema,
	upstreamStatusSchema,
} from "../src/index.ts";
import { expectAccepted, expectRejected } from "./support.ts";

describe("idSchema", () => {
	it.each([
		"a",
		"ws_1",
		"cmd_123",
		"run:2026-10-11.a",
		"A9",
		"x".repeat(96),
	])("accepts %s", (id) => {
		expectAccepted(idSchema, id);
	});

	it.each([
		["", "empty"],
		["_leading", "leading underscore"],
		["-leading", "leading hyphen"],
		["has space", "space"],
		["a/b", "slash"],
		["a'b", "quote"],
		["a;drop", "semicolon"],
		["../etc", "path traversal"],
		["日本", "non-ASCII"],
		["x".repeat(97), "too long"],
	])("rejects %j (%s)", (id) => {
		expectRejected(idSchema, id);
	});

	it("rejects non-strings", () => {
		for (const value of [1, null, undefined, {}, ["a"]]) expectRejected(idSchema, value);
	});
});

describe("date and time schemas", () => {
	it.each([
		"2026-10-11T00:00:00Z",
		"2026-10-11T09:00:00+09:00",
		"2026-10-11T00:00:00.123Z",
	])("isoDateTimeSchema accepts %s", (value) => {
		expectAccepted(isoDateTimeSchema, value);
	});

	it.each([
		"2026-10-11",
		"2026-10-11T00:00:00",
		"2026-10-11 00:00:00Z",
		"11/10/2026",
		"2026-13-01T00:00:00Z",
		"yesterday",
		"",
	])("isoDateTimeSchema rejects %j", (value) => {
		expectRejected(isoDateTimeSchema, value);
	});

	it("isoDateSchema accepts calendar dates only", () => {
		expectAccepted(isoDateSchema, "2026-10-11");
		expectAccepted(isoDateSchema, "2024-02-29");
		for (const value of ["2026-10-11T00:00:00Z", "2026-02-30", "2026-1-1", "20261011", ""]) {
			expectRejected(isoDateSchema, value);
		}
	});
});

describe("httpsUrlSchema", () => {
	it("accepts https URLs", () => {
		expectAccepted(httpsUrlSchema, "https://example.com/path?q=1");
	});

	it.each([
		"http://example.com/",
		"ftp://example.com/",
		"javascript:alert(1)",
		"data:text/html,x",
		"//example.com",
		"example.com",
		"",
		`https://example.com/${"a".repeat(2048)}`,
	])("rejects %j", (value) => {
		expectRejected(httpsUrlSchema, value);
	});
});

describe("text schemas", () => {
	it("trims and bounds short text", () => {
		expectAccepted(shortTextSchema, "x".repeat(300));
		expectRejected(shortTextSchema, "x".repeat(301));
		expectRejected(shortTextSchema, "");
		expectRejected(shortTextSchema, "   ");
	});

	it("returns trimmed short text", () => {
		const parsed = expectAccepted(shortTextSchema, "  Title  ");
		if (parsed !== "Title") throw new Error(`expected trimmed text, got ${JSON.stringify(parsed)}`);
	});

	it("bounds long text", () => {
		expectAccepted(longTextSchema, "x".repeat(4000));
		expectRejected(longTextSchema, "x".repeat(4001));
		expectRejected(longTextSchema, " \n ");
	});
});

describe("JSON schemas", () => {
	it("accepts nested JSON values", () => {
		expectAccepted(jsonValueSchema, { a: [1, "two", null, true, { b: [] }] });
		expectAccepted(jsonValueSchema, null);
		expectAccepted(jsonObjectSchema, {});
	});

	it("rejects values JSON cannot represent", () => {
		for (const value of [
			undefined,
			() => 1,
			Symbol("s"),
			10n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expectRejected(jsonValueSchema, value);
		}
		expectRejected(jsonValueSchema, { nested: { fn: () => 1 } });
		expectRejected(jsonValueSchema, [undefined]);
	});

	it("requires an object, not an array or scalar, for jsonObjectSchema", () => {
		for (const value of [[], "text", 1, null]) expectRejected(jsonObjectSchema, value);
	});
});

describe("market and currency", () => {
	it("accepts only JP and US markets", () => {
		expectAccepted(marketSchema, "JP");
		expectAccepted(marketSchema, "US");
		for (const value of ["jp", "UK", "", null]) expectRejected(marketSchema, value);
	});

	it("accepts only three upper-case letters as a currency code", () => {
		expectAccepted(currencySchema, "JPY");
		expectAccepted(currencySchema, "USD");
		for (const value of ["usd", "US", "USDT", "$", "", "U5D"])
			expectRejected(currencySchema, value);
	});
});

describe("API error body (API-008)", () => {
	it("accepts every stable error code", () => {
		for (const code of API_ERROR_CODES) {
			expectAccepted(apiErrorBodySchema, { error: { code, message: "m" } });
		}
	});

	it("accepts an optional machine-readable detail", () => {
		expectAccepted(apiErrorBodySchema, {
			error: { code: "UI_COMMAND_REJECTED", message: "rejected", detail: "VERSION_CONFLICT" },
		});
	});

	it("rejects unknown codes", () => {
		expectRejected(apiErrorCodeSchema, "SOMETHING_NEW");
		expectRejected(apiErrorBodySchema, { error: { code: "internal", message: "m" } }, [
			"error",
			"code",
		]);
	});

	it("rejects extra fields such as a stack trace", () => {
		expectRejected(apiErrorBodySchema, {
			error: { code: "INTERNAL", message: "m", stack: "Error: at handler.ts:1" },
		});
		expectRejected(apiErrorBodySchema, { error: { code: "INTERNAL", message: "m" }, trace: [] });
	});

	it("requires a message", () => {
		expectRejected(apiErrorBodySchema, { error: { code: "INTERNAL" } }, ["error", "message"]);
	});

	it("carries an external service's status unchanged beside the code (§4a)", () => {
		for (const upstreamStatus of [404, 418, 503, 529, 302]) {
			expectAccepted(apiErrorBodySchema, {
				error: { code: "FETCH_FAILED", message: "m", detail: "HTTP_ERROR", upstreamStatus },
			});
		}
		expectRejected(apiErrorBodySchema, {
			error: { code: "FETCH_FAILED", message: "m", upstreamStatus: "404" },
		});
	});

	it("keeps the published codes stable", () => {
		// Codes are a public contract: removing or renaming one is a breaking change.
		const published = [
			"UNAUTHENTICATED",
			"FORBIDDEN",
			"CSRF_REJECTED",
			"NOT_FOUND",
			"VALIDATION_FAILED",
			"PAYLOAD_TOO_LARGE",
			"RATE_LIMITED",
			"CONFLICT",
			"IDEMPOTENCY_KEY_REUSED",
			"UNSAFE_URL",
			"FETCH_FAILED",
			"NOT_A_FEED",
			"DUPLICATE_SOURCE",
			"UNKNOWN_AGENT",
			"SPEND_CONSENT_REQUIRED",
			"ILLEGAL_TRANSITION",
			"STALE_LEASE",
			"UI_COMMAND_REJECTED",
			"VERSION_CONFLICT",
			"INTEGRITY_VIOLATION",
			"UNSUPPORTED_EXPORT_VERSION",
			"INTERNAL",
		];
		for (const code of published) expectAccepted(apiErrorCodeSchema, code);
	});
});

describe("upstreamStatusSchema (docs/rule/error_handling.md §4a)", () => {
	it("accepts every three-digit HTTP status, including ones no mapping names", () => {
		for (const status of [100, 302, 404, 418, 429, 503, 520, 529, 599]) {
			expectAccepted(upstreamStatusSchema, status);
		}
	});

	it("rejects what cannot be an HTTP status", () => {
		for (const value of [99, 600, 404.5, -1, "503", null])
			expectRejected(upstreamStatusSchema, value);
	});
});
