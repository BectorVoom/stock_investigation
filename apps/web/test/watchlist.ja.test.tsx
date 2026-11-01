import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeBackend } from "./fakeBackend.ts";
import { createStocksBackend, mountRegistered, mountStocks } from "./stocksHarness.tsx";
import {
	emptyDirectoryMarket,
	FRESH_STAMP,
	UPCOMING_DATE,
	type WatchServer,
} from "./watchlistHarness.ts";

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
	it("words the table, the timing and the status in Japanese; tickers and dates stay as they are", async () => {
		mountJapanese();
		const table = await screen.findByRole("table", {
			name: "登録銘柄: ウォッチリスト、続いて財務諸表を同期している企業",
		});
		expect(within(table).getByRole("columnheader", { name: "次回発表" })).toBeTruthy();
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain("Apple Inc");
		expect(row.textContent).toContain(UPCOMING_DATE);
		expect(row.textContent).toContain("取引終了後");
		expect(row.textContent).toContain("米国");
		expect(within(row).getByRole("link", { name: "Google Calendar に追加" })).toBeTruthy();
		expect(within(row).getByRole("button", { name: "AAPL を削除" })).toBeTruthy();
		// Refreshed fine and idle: the refresh line says nothing (ADR-0050 §5).
		expect(document.querySelector('[data-field="watchlist-status"]')?.textContent).toBe("");
		expect(screen.queryByText(/最後に成功した更新/)).toBeNull();
		expect(screen.queryByText(/財務諸表の同期:/)).toBeNull();
		// The server fetches the dates: there is no refresh button.
		expect(screen.queryByRole("button", { name: "決算発表日を更新" })).toBeNull();
	});

	it("names the stock lists section in Japanese", async () => {
		mountJapanese();
		const section = await screen.findByRole("region", { name: "銘柄一覧" });
		expect(section.textContent).toContain(
			"株式データのページの検索が使う、保存済みの米国・日本の上場銘柄一覧です。",
		);
		expect(within(section).getByRole("button", { name: "銘柄一覧を更新" })).toBeTruthy();
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
		await screen.findByRole("table");
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
		fireEvent.click(screen.getByRole("button", { name: "銘柄一覧を更新" }));
		expect(
			await screen.findByText("銘柄一覧の更新をローカルのランナーに予約しました。"),
		).toBeTruthy();
		// One box: no separate symbol entry.
		expect(screen.queryByText("銘柄コードを直接入力")).toBe(null);
	});
});
