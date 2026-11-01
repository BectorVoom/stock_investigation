import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeBackend } from "./fakeBackend.ts";
import { createStocksBackend, mountRegistered, mountStocks } from "./stocksHarness.tsx";
import { emptyDirectoryMarket, FRESH_STAMP, type WatchServer } from "./watchlistHarness.ts";

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
		// No date column and no sync of any kind (ADR-0053).
		expect(within(table).queryByRole("columnheader", { name: "次回発表" })).toBeNull();
		expect(within(table).queryByRole("columnheader", { name: "財務諸表" })).toBeNull();
		expect(screen.queryByRole("tab", { name: /すべての銘柄/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /同期|更新/ })).toBeNull();
	});

	it("names the stock lists section in Japanese, with no update button", async () => {
		mountJapanese();
		const section = await screen.findByRole("region", { name: "銘柄一覧" });
		expect(section.textContent).toContain(
			"株式データのページの検索が使う、保存済みの米国・日本の上場銘柄一覧です。一覧がない場合はサーバーがすぐに取得し、各一覧を毎週更新します。",
		);
		expect(within(section).queryByRole("button", { name: "銘柄一覧を更新" })).toBeNull();
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

	it("states the stock lists in Japanese, naming SEC_USER_AGENT after a configuration failure", async () => {
		server.directory.US = {
			...emptyDirectoryMarket(),
			lastFailure: {
				state: "failed",
				code: "DIRECTORY_NOT_CONFIGURED",
				upstreamStatus: null,
				at: FRESH_STAMP,
			},
		};
		mountJapanese();
		await screen.findByRole("region", { name: "銘柄一覧" });
		const lines = () =>
			[...document.querySelectorAll('[data-field="directory-status"] p')].map(
				(line) => line.textContent ?? "",
			);
		await waitFor(() => {
			expect(lines()).toHaveLength(2);
		});
		expect(lines()[0]).toBe(
			"米国の銘柄一覧: まだ取得していません。前回の更新に失敗しました: 米国の銘柄一覧を取得するには、apps/runner/.env に SEC_USER_AGENT（SEC が求める名前と連絡先メールアドレス）を設定してください。 出典: U.S. Securities and Exchange Commission (SEC)",
		);
		expect(lines()[1]).toBe(
			"日本の銘柄一覧: 3,707 銘柄、2026-09-30 時点。 出典: Japan Exchange Group (JPX)",
		);
		// The server downloads the list: the page offers no update and sends nothing.
		expect(screen.queryByRole("button", { name: "銘柄一覧を更新" })).toBeNull();
		expect(backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
		// One box: no separate symbol entry.
		expect(screen.queryByText("銘柄コードを直接入力")).toBe(null);
	});
});
