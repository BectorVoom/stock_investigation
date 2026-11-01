import { cleanup, fireEvent, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeBackend } from "./fakeBackend.ts";
import { createStocksBackend, mountRegistered, mountStocks } from "./stocksHarness.tsx";
import { FRESH_STAMP, type WatchServer } from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createStocksBackend());
});

afterEach(cleanup);

function mountJapanese() {
	mountRegistered(backend, { locale: "ja" });
}

describe("Stocks page in Japanese: the Watchlist half", () => {
	it("words a list's table in Japanese; tickers stay as they are", async () => {
		server.lists = [
			{
				listId: "list_a",
				title: "Semis",
				stockIds: ["us:AAPL"],
				version: 1,
				createdAt: FRESH_STAMP,
				updatedAt: FRESH_STAMP,
			},
		];
		mountJapanese();
		const table = await screen.findByRole("table", { name: "Semis の銘柄" });
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["銘柄コード", "市場", "操作"]);
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain("Apple Inc");
		expect(row.textContent).toContain("米国");
		expect(within(row).getByRole("button", { name: "AAPL を Semis から外す" })).toBeTruthy();
		// No date column and no sync of any kind (ADR-0054).
		expect(within(table).queryByRole("columnheader", { name: "次回発表" })).toBeNull();
		expect(within(table).queryByRole("columnheader", { name: "財務諸表" })).toBeNull();
		expect(screen.queryByRole("tab", { name: /すべての銘柄/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /同期|更新/ })).toBeNull();
	});

	it("has no 銘柄一覧 area", async () => {
		mountJapanese();
		await screen.findByRole("region", { name: "銘柄とリスト" });
		expect(screen.queryByRole("region", { name: "銘柄一覧" })).toBeNull();
		expect(screen.queryByRole("button", { name: "銘柄一覧を更新" })).toBeNull();
	});

	it("searches in Japanese on the Stocks page: the Japanese name leads, listings are in Japanese", async () => {
		const page = mountStocks(backend, { locale: "ja" });
		await screen.findByRole("region", { name: "銘柄を探す" });
		const box = screen.getByRole("combobox", { name: "銘柄を検索" });
		fireEvent.input(box, { target: { value: "とよた" } });
		const listbox = await screen.findByRole("listbox", { name: "一致する銘柄" });
		const [toyota] = within(listbox).getAllByRole("option");
		if (toyota === undefined) throw new Error("no 7203 option");
		expect(toyota.textContent).toBe("7203トヨタ自動車TOYOTA MOTOR CORPORATION日本・プライム");
		expect(screen.getByText("1 件")).toBeTruthy();
		fireEvent.click(toyota);
		expect(page.route()).toEqual({ stockId: "jp:7203", tab: "chart" });
		fireEvent.input(box, { target: { value: "zzzz" } });
		expect(await screen.findByText("「zzzz」に一致する銘柄はありません。")).toBeTruthy();
	});
});
