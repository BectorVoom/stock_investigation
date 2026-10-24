import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { formatInstant } from "../src/lib/format.ts";
import { WatchlistView } from "../src/watchlist/WatchlistView.tsx";
import { ALWAYS_VISIBLE, type FakeBackend } from "./fakeBackend.ts";
import { createWatchlistBackend, FRESH_STAMP, UPCOMING_DATE } from "./watchlistHarness.ts";

let backend: FakeBackend;

beforeEach(() => {
	({ backend } = createWatchlistBackend());
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
});
