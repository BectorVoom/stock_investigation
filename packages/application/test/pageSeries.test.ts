import type { HomeWidget } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { ownerSeries, pageSeriesFor, resolveListSeries } from "../src/pageSeries.ts";
import type { WatchlistListMember, WatchlistListRepository } from "../src/ports.ts";

const OWNER = "owner_1";

/** A `membersOf` fake over fixed lists that counts its calls (one per request). */
function listsOf(lists: Readonly<Record<string, readonly string[]>>) {
	const calls: (readonly string[])[] = [];
	const repository: Pick<WatchlistListRepository, "membersOf"> = {
		async membersOf(ownerId, listIds) {
			calls.push(listIds);
			const out = new Map<string, readonly WatchlistListMember[]>();
			if (ownerId !== OWNER) return out;
			for (const listId of listIds) {
				const stockIds = lists[listId];
				if (stockIds === undefined) continue;
				out.set(
					listId,
					stockIds.map((stockId) => {
						const [prefix, symbol = ""] = stockId.split(":");
						return { stockId, market: prefix === "jp" ? "JP" : "US", symbol };
					}),
				);
			}
			return out;
		},
	};
	return { repository, calls };
}

function prices(widgetId: string, listId: string): HomeWidget {
	return { type: "watchlist-prices", widgetId, title: listId, size: "medium", listId };
}

function metric(widgetId: string, seriesId: string): HomeWidget {
	return { type: "market-metric", widgetId, title: seriesId, size: "small", seriesId };
}

function us(count: number, offset = 0): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `us:S${String(index + offset).padStart(3, "0")}`,
	);
}

describe("resolveListSeries (ADR-0040 §3)", () => {
	it("maps members through stockPriceSeriesId and asks nothing for no lists", async () => {
		const { repository, calls } = listsOf({ list_a: ["us:BRK.B", "jp:7203"] });
		const none = await resolveListSeries(repository, OWNER, []);
		expect(none("list_a")).toBeUndefined();
		expect(calls).toEqual([]);
		const lookup = await resolveListSeries(repository, OWNER, ["list_a", "list_a", "list_gone"]);
		expect(lookup("list_a")).toEqual(["twelve-data:BRK.B", "twelve-data:7203:JPX"]);
		expect(lookup("list_gone")).toBeUndefined();
		// One query, each id once.
		expect(calls).toEqual([["list_a", "list_gone"]]);
	});
});

describe("pageSeriesFor (ADR-0040 §4)", () => {
	it("serves named series first, then each list's series in widget and list order", async () => {
		const { repository } = listsOf({
			list_a: ["us:NVDA", "us:AAPL"],
			list_b: ["us:AAPL", "jp:7203"],
		});
		const ids = await pageSeriesFor(repository, OWNER, [
			prices("w-1", "list_b"),
			metric("w-2", "twelve-data:AAPL"),
			prices("w-3", "list_a"),
			metric("w-4", "fred:VIXCLS"),
		]);
		expect(ids).toEqual([
			"twelve-data:AAPL",
			"fred:VIXCLS",
			"twelve-data:7203:JPX",
			"twelve-data:NVDA",
		]);
	});

	it("stops at 30 without ever pushing a named series out", async () => {
		const { repository } = listsOf({ list_a: us(12), list_b: us(12, 12) });
		const named = Array.from({ length: 10 }, (_, index) => metric(`w-${index}`, `fred:N${index}`));
		const ids = await pageSeriesFor(repository, OWNER, [
			prices("w-a", "list_a"),
			prices("w-b", "list_b"),
			...named,
		]);
		expect(ids).toHaveLength(30);
		expect(ids.slice(0, 10)).toEqual(named.map((_, index) => `fred:N${index}`));
		expect(ids.at(-1)).toBe("twelve-data:S019");
	});

	it("lets a deleted list contribute nothing", async () => {
		const { repository } = listsOf({});
		expect(
			await pageSeriesFor(repository, OWNER, [prices("w-1", "list_gone"), metric("w-2", "fred:X")]),
		).toEqual(["fred:X"]);
	});
});

describe("ownerSeries (ADR-0040 §4)", () => {
	function deps(
		lists: Readonly<Record<string, readonly string[]>>,
		notebookNamed: readonly string[],
		notebookListIds: readonly string[],
	) {
		const fake = listsOf(lists);
		return {
			calls: fake.calls,
			deps: {
				watchlistLists: fake.repository,
				notebooks: {
					listMarketSeriesIds: async () => notebookNamed,
					listWatchlistListIds: async () => notebookListIds,
				},
			},
		};
	}

	it("tracks Home's page first, then notebooks' named and listed series, resolving lists once", async () => {
		const { deps: d, calls } = deps(
			{ list_home: ["us:AAPL"], list_nb: ["us:MSFT", "us:AAPL"] },
			["fred:DEXJPUS"],
			["list_nb", "list_deleted"],
		);
		const series = await ownerSeries(d, OWNER, [
			prices("w-1", "list_home"),
			metric("w-2", "fred:VIXCLS"),
		]);
		expect(series.tracked).toEqual([
			"fred:VIXCLS",
			"twelve-data:AAPL",
			"fred:DEXJPUS",
			"twelve-data:MSFT",
		]);
		expect([...series.keep].sort()).toEqual([...series.tracked].sort());
		expect(calls).toEqual([["list_home", "list_nb", "list_deleted"]]);
	});

	it("caps the tracked set at 60 but keeps every named and listed series", async () => {
		// Home: 30 named; notebooks: 20 named + 2 lists of 12.
		const homeNamed = Array.from({ length: 30 }, (_, index) =>
			metric(`w-${index}`, `fred:H${index}`),
		);
		const notebookNamed = Array.from({ length: 20 }, (_, index) => `fred:N${index}`);
		const { deps: d } = deps(
			{ list_x: us(12), list_y: us(12, 12), list_home: us(3, 40) },
			notebookNamed,
			["list_x", "list_y"],
		);
		const series = await ownerSeries(d, OWNER, [...homeNamed, prices("w-h", "list_home")]);
		expect(series.tracked).toHaveLength(60);
		// Home's page is capped at 30 named, so its list adds nothing to the tracked set …
		expect(series.tracked).not.toContain("twelve-data:S040");
		expect(series.tracked.slice(30, 50)).toEqual(notebookNamed);
		// … but the keep set holds everything any page names or lists.
		expect(series.keep).toHaveLength(30 + 3 + 20 + 24);
		expect(series.keep).toContain("twelve-data:S040");
		expect(series.keep).toContain("twelve-data:S023");
	});

	it("asks nothing of the lists when no page shows one", async () => {
		const { deps: d, calls } = deps({}, ["fred:X"], []);
		const series = await ownerSeries(d, OWNER, [metric("w-1", "fred:VIXCLS")]);
		expect(series.tracked).toEqual(["fred:VIXCLS", "fred:X"]);
		expect(calls).toEqual([]);
	});
});
