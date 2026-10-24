import { describe, expect, it } from "vitest";
import {
	claimedJobSchema,
	completeJobRequestSchema,
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryEntry,
	stockDirectoryHitSchema,
	stockDirectoryRefreshRequestSchema,
	stockDirectorySearchQuerySchema,
	stockDirectoryStatusResponseSchema,
} from "../src/index.ts";
import { resourceUsage } from "./fixtures.ts";

/** `count` distinct valid US rows: A0000..; JP rows are 1000.. codes. */
function usEntries(count: number): StockDirectoryEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		symbol: `A${index.toString().padStart(4, "0")}`,
		name: `Company ${index}`,
		listing: "nasdaq",
	}));
}

function jpEntries(count: number): StockDirectoryEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		symbol: String(1000 + index),
		name: `COMPANY ${index}`,
		localName: `会社${index}`,
		listing: "tse-prime",
	}));
}

function completion(market: "US" | "JP", entries: readonly StockDirectoryEntry[]) {
	return {
		outcome: "stock-directory-refreshed",
		leaseGeneration: 1,
		usage: resourceUsage,
		market,
		asOf: market === "JP" ? "2026-09-30" : null,
		fetchedAt: "2026-10-24T00:00:00Z",
		entries,
	};
}

describe("stock-directory-refresh job", () => {
	it("leases one market", () => {
		const lease = {
			kind: "stock-directory-refresh",
			runId: "run_1",
			leaseGeneration: 1,
			leaseExpiresAt: "2026-10-24T00:05:00Z",
			attempt: 1,
			heartbeatIntervalMs: 10_000,
			sources: [],
			market: "JP",
		};
		expect(claimedJobSchema.safeParse(lease).success).toBe(true);
		expect(claimedJobSchema.safeParse({ ...lease, market: "UK" }).success).toBe(false);
	});

	it("accepts a full list per market", () => {
		const min = STOCK_DIRECTORY_LIMITS.minEntriesPerMarket;
		expect(completeJobRequestSchema.safeParse(completion("US", usEntries(min))).success).toBe(true);
		expect(completeJobRequestSchema.safeParse(completion("JP", jpEntries(min))).success).toBe(true);
	});

	it("refuses a list below the floor, so a broken parse never replaces a good list", () => {
		const short = usEntries(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket - 1);
		expect(completeJobRequestSchema.safeParse(completion("US", short)).success).toBe(false);
	});

	it("refuses rows of the wrong market shape, listing, duplicates and US local names", () => {
		const base = usEntries(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket);
		const variants: StockDirectoryEntry[][] = [
			[...base.slice(1), { symbol: "7203", name: "Toyota", listing: "nasdaq" }],
			[...base.slice(1), { symbol: "ZZZ", name: "Z", listing: "tse-prime" }],
			[...base.slice(1), { symbol: "A0002", name: "Again", listing: "nyse" }],
			[...base.slice(1), { symbol: "ZZZ", name: "Z", localName: "ゼット", listing: "nyse" }],
		];
		for (const entries of variants) {
			expect(completeJobRequestSchema.safeParse(completion("US", entries)).success).toBe(false);
		}
		const jp = jpEntries(STOCK_DIRECTORY_LIMITS.minEntriesPerMarket);
		jp[0] = { symbol: "AAPL", name: "Apple", listing: "tse-prime" };
		expect(completeJobRequestSchema.safeParse(completion("JP", jp)).success).toBe(false);
	});

	it("keeps a maximal US list under the 1 MB body cap", () => {
		// Measured names average ~25 characters; a 40-character name on every
		// row of a maximal list still fits.
		const entries = Array.from({ length: STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket }, (_, i) => ({
			symbol: `B${i.toString().padStart(5, "0")}`,
			name: "X".repeat(40),
			listing: "nyse" as const,
		}));
		const bytes = new TextEncoder().encode(JSON.stringify(completion("US", entries))).length;
		expect(bytes).toBeLessThan(1_000_000);
	});
});

describe("stock directory API shapes", () => {
	it("parses a search query with a default limit and refuses blank or long queries", () => {
		expect(stockDirectorySearchQuerySchema.parse({ q: " toyota " })).toEqual({
			q: "toyota",
			limit: STOCK_DIRECTORY_LIMITS.defaultResults,
		});
		expect(
			stockDirectorySearchQuerySchema.parse({ q: "7203", market: "JP", limit: "5" }).limit,
		).toBe(5);
		expect(stockDirectorySearchQuerySchema.safeParse({ q: "  " }).success).toBe(false);
		expect(
			stockDirectorySearchQuerySchema.safeParse({
				q: "x".repeat(STOCK_DIRECTORY_LIMITS.maxQueryChars + 1),
			}).success,
		).toBe(false);
		expect(
			stockDirectorySearchQuerySchema.safeParse({
				q: "a",
				limit: STOCK_DIRECTORY_LIMITS.maxResults + 1,
			}).success,
		).toBe(false);
	});

	it("ties a hit's stock id to its market and symbol", () => {
		const hit = {
			stockId: "jp:7203",
			market: "JP",
			symbol: "7203",
			name: "TOYOTA MOTOR CORPORATION",
			localName: "トヨタ自動車",
			listing: "tse-prime",
			registered: false,
		};
		expect(stockDirectoryHitSchema.safeParse(hit).success).toBe(true);
		expect(stockDirectoryHitSchema.safeParse({ ...hit, stockId: "jp:7205" }).success).toBe(false);
	});

	it("defaults a refresh to both markets and refuses duplicates", () => {
		expect(stockDirectoryRefreshRequestSchema.parse({})).toEqual({ markets: ["US", "JP"] });
		expect(stockDirectoryRefreshRequestSchema.safeParse({ markets: ["US", "US"] }).success).toBe(
			false,
		);
	});

	it("lists US then JP in the status", () => {
		const status = (market: "US" | "JP") => ({
			market,
			sourceId: market === "US" ? "sec" : "jpx",
			publisher: "P",
			sourceUrl: "https://example.com/",
			entryCount: 0,
			asOf: null,
			retrievedAt: null,
			activeRunId: null,
			activeRunState: null,
			lastFailure: null,
		});
		expect(
			stockDirectoryStatusResponseSchema.safeParse({ markets: [status("US"), status("JP")] })
				.success,
		).toBe(true);
		expect(
			stockDirectoryStatusResponseSchema.safeParse({ markets: [status("JP"), status("US")] })
				.success,
		).toBe(false);
	});
});
