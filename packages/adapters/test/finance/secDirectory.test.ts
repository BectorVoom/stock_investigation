/**
 * The US stock directory (ADR-0033) on SEC's ticker directory: a trimmed copy
 * of the real file (`fixtures/sec-company-tickers-exchange-trimmed.json`,
 * rows copied from the 2026-10-24 download) for the row rules, and lists
 * generated in-test for the contract floor and the fetch path.
 */
import { readFileSync } from "node:fs";
import type { SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import { STOCK_DIRECTORY_LIMITS } from "@research/contracts";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createSecClient } from "../../src/finance/secClient.ts";
import {
	createSecDirectorySource,
	parseSecDirectory,
	secDirectoryEntries,
} from "../../src/finance/secDirectory.ts";
import { SEC_TICKER_DIRECTORY_URL } from "../../src/finance/secFinancials.ts";
import { expectErr, expectOk } from "./support.ts";

const TRIMMED: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/sec-company-tickers-exchange-trimmed.json", import.meta.url), {
		encoding: "utf8",
	}),
);

const USER_AGENT = "Test Owner research owner@example.com";
const never = new AbortController().signal;

/** A ticker directory of `count` listed rows (`T0000` …) after the given leading rows. */
function directory(count: number, leading: readonly unknown[][] = []): unknown {
	const rows: unknown[][] = [...leading];
	for (let index = 0; index < count; index += 1) {
		rows.push([100_000 + index, `Company ${index}`, `T${String(index).padStart(4, "0")}`, "NYSE"]);
	}
	return { fields: ["cik", "name", "ticker", "exchange"], data: rows };
}

function fakeFetcher(answer: () => ReturnType<SafeFetcher["fetchText"]>) {
	const calls: { url: string; options: SafeFetchOptions }[] = [];
	const fetcher: SafeFetcher = {
		fetchText(url, options) {
			calls.push({ url, options });
			return answer();
		},
	};
	return { fetcher, calls };
}

const clock = { nowMs: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" };

function sourceWith(fetcher: SafeFetcher, userAgent: string | null = USER_AGENT) {
	const dropped: number[] = [];
	const source = createSecDirectorySource({
		client: createSecClient({ fetcher, clock, userAgent, sleep: async () => {} }),
		onDroppedRows: (count) => dropped.push(count),
	});
	return { source, dropped };
}

describe("secDirectoryEntries (the row rules)", () => {
	it("keeps Nasdaq, NYSE, Cboe and Texas SE rows in file order and drops OTC and unlisted rows", () => {
		const parsed = expectOk(secDirectoryEntries(TRIMMED));
		expect(parsed.droppedRows).toBe(0);
		expect(parsed.entries).toEqual([
			{ symbol: "NVDA", name: "NVIDIA CORP", listing: "nasdaq" },
			{ symbol: "AAPL", name: "Apple Inc.", listing: "nasdaq" },
			{ symbol: "GOOGL", name: "Alphabet Inc.", listing: "nasdaq" },
			{ symbol: "MSFT", name: "MICROSOFT CORP", listing: "nasdaq" },
			{ symbol: "AMZN", name: "AMAZON COM INC", listing: "nasdaq" },
			{ symbol: "META", name: "Meta Platforms, Inc.", listing: "nasdaq" },
			{ symbol: "CBOE", name: "Cboe Global Markets, Inc.", listing: "cboe" },
			{ symbol: "AAAU", name: "Goldman Sachs Physical Gold ETF", listing: "cboe" },
			{ symbol: "ET", name: "Energy Transfer LP", listing: "txse" },
			{ symbol: "SUN", name: "Sunoco LP", listing: "txse" },
			{ symbol: "TM", name: "TOYOTA MOTOR CORP/", listing: "nyse" },
		]);
	});

	it("drops tickers outside the US symbol shape, keeps the first of a repeated ticker and counts over-long names", () => {
		const parsed = expectOk(
			secDirectoryEntries({
				fields: ["ticker", "exchange", "cik", "name"],
				data: [
					["brk-b", "NYSE", 1, " Berkshire Hathaway Inc "],
					["BRK.B", "NYSE", 2, "Second spelling"],
					["1ABC", "Nasdaq", 3, "Starts with a digit"],
					["TOOLONGSYMBOL", "Nasdaq", 4, "Eleven characters"],
					["LONG", "Nasdaq", 5, "N".repeat(STOCK_DIRECTORY_LIMITS.maxNameChars + 1)],
					["EDGE", "Nasdaq", 6, "N".repeat(STOCK_DIRECTORY_LIMITS.maxNameChars)],
					["EMPTY", "Nasdaq", 7, "   "],
					["LOWER", "nasdaq", 8, "Exchange text is exact"],
				],
			}),
		);
		expect(parsed.entries).toEqual([
			{ symbol: "BRK-B", name: "Berkshire Hathaway Inc", listing: "nyse" },
			{
				symbol: "EDGE",
				name: "N".repeat(STOCK_DIRECTORY_LIMITS.maxNameChars),
				listing: "nasdaq",
			},
		]);
		expect(parsed.droppedRows).toBe(2);
	});

	it("fails an unreadable directory as DIRECTORY_PARSE_FAILED", () => {
		expect(expectErr(secDirectoryEntries({ data: [] }))).toBe("DIRECTORY_PARSE_FAILED");
		expect(expectErr(secDirectoryEntries({ fields: ["cik"], data: [] }))).toBe(
			"DIRECTORY_PARSE_FAILED",
		);
		expect(expectErr(secDirectoryEntries(directory(0)))).toBe("DIRECTORY_PARSE_FAILED");
	});
});

describe("parseSecDirectory (the contract floor)", () => {
	it("refuses a list below the floor, so a broken file never replaces a stored list", () => {
		expect(expectErr(parseSecDirectory(TRIMMED))).toBe("DIRECTORY_PARSE_FAILED");
		const floor = STOCK_DIRECTORY_LIMITS.minEntriesPerMarket;
		expect(expectErr(parseSecDirectory(directory(floor - 1)))).toBe("DIRECTORY_PARSE_FAILED");
		const atFloor = expectOk(parseSecDirectory(directory(floor)));
		expect(atFloor.data).toMatchObject({ asOf: null });
		expect(atFloor.data.entries).toHaveLength(floor);
	});

	it("refuses a list above the ceiling", () => {
		const ceiling = STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket;
		expect(expectOk(parseSecDirectory(directory(ceiling))).data.entries).toHaveLength(ceiling);
		expect(expectErr(parseSecDirectory(directory(ceiling + 1)))).toBe("DIRECTORY_PARSE_FAILED");
	});
});

describe("createSecDirectorySource", () => {
	const listed = JSON.stringify(
		directory(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket, [
			[9, "N".repeat(STOCK_DIRECTORY_LIMITS.maxNameChars + 1), "LONG", "NYSE"],
		]),
	);

	it("downloads the ticker directory once with the owner's User-Agent and reports dropped rows as a count", async () => {
		const { fetcher, calls } = fakeFetcher(async () =>
			ok({ finalUrl: SEC_TICKER_DIRECTORY_URL, contentType: "application/json", text: listed }),
		);
		const { source, dropped } = sourceWith(fetcher);
		let grants = 0;
		const result = await source.fetchDirectory({
			signal: never,
			beforeRequest: async () => {
				grants += 1;
				return true;
			},
		});
		const data = expectOk(result);
		expect(source.market).toBe("US");
		expect(data.asOf).toBeNull();
		expect(data.entries).toHaveLength(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket);
		expect(dropped).toEqual([1]);
		expect(grants).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(SEC_TICKER_DIRECTORY_URL);
		expect(calls[0]?.options).toMatchObject({
			userAgent: USER_AGENT,
			accept: "application/json",
			maxBytes: 8_000_000,
		});
		expect([...(calls[0]?.options.allowedHosts ?? [])].sort()).toEqual([
			"data.sec.gov",
			"www.sec.gov",
		]);
	});

	it("sends nothing when the pacing hook refuses (the job stopped)", async () => {
		const { fetcher, calls } = fakeFetcher(async () => err({ code: "TIMEOUT", detail: "x" }));
		const { source } = sourceWith(fetcher);
		const result = await source.fetchDirectory({ signal: never, beforeRequest: async () => false });
		expect(expectErr(result)).toBe("DIRECTORY_SOURCE_FAILED");
		expect(calls).toHaveLength(0);
	});

	it("maps SEC failures to stable codes without provider text", async () => {
		const cases: [SafeFetchError, string][] = [
			[{ code: "HTTP_ERROR", detail: "HTTP 429 Too Many Requests" }, "DIRECTORY_RATE_LIMITED"],
			[{ code: "HTTP_ERROR", detail: "HTTP 403" }, "DIRECTORY_SOURCE_FAILED"],
			[{ code: "HTTP_ERROR", detail: "HTTP 503" }, "DIRECTORY_SOURCE_FAILED"],
			[{ code: "TIMEOUT", detail: "no response" }, "DIRECTORY_SOURCE_FAILED"],
			[{ code: "RESPONSE_TOO_LARGE", detail: "cap" }, "DIRECTORY_SOURCE_FAILED"],
		];
		for (const [error, code] of cases) {
			const { fetcher } = fakeFetcher(async () => err(error));
			const { source } = sourceWith(fetcher);
			const result = await source.fetchDirectory({
				signal: never,
				beforeRequest: async () => true,
			});
			expect(expectErr(result)).toBe(code);
		}
	});

	it("fails a body that is not JSON, or JSON of the wrong shape, as DIRECTORY_PARSE_FAILED", async () => {
		for (const text of ["<html>", JSON.stringify({ fields: [], data: [] })]) {
			const { fetcher } = fakeFetcher(async () =>
				ok({ finalUrl: SEC_TICKER_DIRECTORY_URL, contentType: "application/json", text }),
			);
			const { source } = sourceWith(fetcher);
			const result = await source.fetchDirectory({
				signal: never,
				beforeRequest: async () => true,
			});
			expect(expectErr(result)).toBe("DIRECTORY_PARSE_FAILED");
		}
	});

	it("is DIRECTORY_NOT_CONFIGURED without a usable User-Agent, and sends nothing", async () => {
		const { fetcher, calls } = fakeFetcher(async () => err({ code: "TIMEOUT", detail: "x" }));
		const { source } = sourceWith(fetcher, "no contact");
		const result = await source.fetchDirectory({ signal: never, beforeRequest: async () => true });
		expect(expectErr(result)).toBe("DIRECTORY_NOT_CONFIGURED");
		expect(calls).toHaveLength(0);
	});
});
