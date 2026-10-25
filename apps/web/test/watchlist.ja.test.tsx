import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { formatInstant } from "../src/lib/format.ts";
import { WatchlistView } from "../src/watchlist/WatchlistView.tsx";
import { ALWAYS_VISIBLE, type FakeBackend } from "./fakeBackend.ts";
import {
	createWatchlistBackend,
	emptyDirectoryMarket,
	FRESH_STAMP,
	UPCOMING_DATE,
	type WatchServer,
} from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createWatchlistBackend());
});

afterEach(cleanup);

function mountJapanese() {
	render(() => (
		<LocaleProvider locale={() => "ja"}>
			<WatchlistView api={createApiClient({ fetch: backend.fetch })} visibility={ALWAYS_VISIBLE} />
		</LocaleProvider>
	));
}

describe("Watchlist view in Japanese", () => {
	it("words the table, the timing and the status in Japanese; tickers and dates stay as they are", async () => {
		mountJapanese();
		const table = await screen.findByRole("table", { name: "フォロー中の銘柄と次回の決算発表日" });
		expect(within(table).getByRole("columnheader", { name: "次回発表" })).toBeTruthy();
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain("Apple Inc");
		expect(row.textContent).toContain(UPCOMING_DATE);
		expect(row.textContent).toContain("取引終了後");
		expect(row.textContent).toContain("米国");
		expect(within(row).getByRole("link", { name: "Google Calendar に追加" })).toBeTruthy();
		expect(within(row).getByRole("button", { name: "AAPL を削除" })).toBeTruthy();
		expect(document.querySelector('[data-field="watchlist-status"]')?.textContent).toBe(
			`最後に成功した更新: ${formatInstant(FRESH_STAMP)}。`,
		);
		expect(screen.getByRole("button", { name: "決算発表日を更新" })).toBeTruthy();
	});

	it("explains an invalid symbol in Japanese, quoting what was typed", async () => {
		mountJapanese();
		await screen.findByRole("table");
		fireEvent.input(screen.getByLabelText("銘柄コード"), { target: { value: "aapl!" } });
		const problems = screen.getByRole("list", { name: "銘柄を追加する前に" });
		expect(problems.textContent).toBe(
			"「aapl!」は有効な銘柄コードではありません。米国のティッカーは英字で始まります（例: AAPL）。",
		);
		expect(screen.getByRole("button", { name: "追加" }).hasAttribute("disabled")).toBe(true);
	});

	it("searches in Japanese: the Japanese name leads, listings and Added are in Japanese", async () => {
		mountJapanese();
		await screen.findByRole("table");
		const box = screen.getByRole("combobox", { name: "銘柄を検索" });
		fireEvent.input(box, { target: { value: "とよた" } });
		const listbox = await screen.findByRole("listbox", { name: "一致する銘柄" });
		const [toyota] = within(listbox).getAllByRole("option");
		if (toyota === undefined) throw new Error("no 7203 option");
		expect(toyota.textContent).toBe("7203トヨタ自動車TOYOTA MOTOR CORPORATION日本・プライム");
		expect(screen.getByText("1 件")).toBeTruthy();
		fireEvent.click(toyota);
		expect(document.querySelector('[data-field="selected-stock"]')?.textContent).toBe(
			"選択中: 7203 トヨタ自動車（日本）",
		);

		fireEvent.input(box, { target: { value: "apple" } });
		const added = await screen.findByText("登録済み");
		expect(added.closest('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
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
		expect(screen.getByText("銘柄コードを直接入力")).toBeTruthy();
	});
});
