import { agentSettingsResponseSchema, DEFAULT_AGENT_SETTINGS } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { AgentSettingsSection } from "../src/settings/AgentSettingsSection.tsx";
import { CalendarSettingsSection } from "../src/settings/CalendarSettingsSection.tsx";
import { GoogleCalendarCard } from "../src/settings/GoogleCalendarCard.tsx";
import { ALWAYS_VISIBLE, createFakeBackend, jsonResponse } from "./fakeBackend.ts";
import { AGENTS } from "./fixtures.ts";
import { createWatchlistBackend } from "./watchlistHarness.ts";

/** Settings in Japanese (ADR-0032): the sections' own words, names and sentences with values. */

afterEach(cleanup);

function inJapanese(content: () => JSX.Element) {
	render(() => <LocaleProvider locale={() => "ja"}>{content()}</LocaleProvider>);
}

describe("Settings → AI agent in Japanese", () => {
	it("labels the form, states the offline runner with its last-seen time and lists what blocks Save", async () => {
		const backend = createFakeBackend();
		backend.on("GET", /agents$/, () => jsonResponse({ ...AGENTS, runnerOnline: false }));
		backend.on("GET", /settings\/agent$/, () =>
			jsonResponse(
				agentSettingsResponseSchema.parse({
					settings: DEFAULT_AGENT_SETTINGS,
					updatedAt: null,
					origin: "defaults",
				}),
			),
		);
		inJapanese(() => (
			<AgentSettingsSection api={createApiClient({ fetch: backend.fetch })} agentSection={null} />
		));

		const section = await screen.findByRole("region", { name: "AI エージェント" });
		const form = await within(section).findByRole("form", { name: "AI エージェントの設定" });
		expect(within(form).getByText("これは既定の設定で、まだ保存されていません。")).toBeTruthy();
		const backendSelect = within(form).getByLabelText("既定のバックエンド");
		await within(backendSelect).findByRole("option", { name: "Claude Code — 利用可能" });
		expect(
			within(form).getByText(
				"ランナーはオフラインです（最終接続 2026-10-05 00:00 UTC）。質問はキューに入り、ランナーが再接続すると開始します。下のバックエンドの利用可否は最後に報告された時点のものです。",
			),
		).toBeTruthy();
		const problems = within(form).getByRole("list", { name: "保存する前に" });
		expect(problems.textContent).toContain("既定のエージェントのバックエンドを選んでください。");
		expect(within(form).getByRole("button", { name: "保存" })).toBeTruthy();
		expect(within(form).getByRole("option", { name: "高" })).toBeTruthy();
	});
});

describe("Settings → Calendar in Japanese", () => {
	it("explains the section around the Watchlist link and offers the Google Calendar steps", async () => {
		const { backend } = createWatchlistBackend();
		inJapanese(() => (
			<CalendarSettingsSection
				api={createApiClient({ fetch: backend.fetch })}
				visibility={ALWAYS_VISIBLE}
				section={null}
			/>
		));
		const section = await screen.findByRole("region", { name: "カレンダー" });
		await within(section).findByText("Google Calendar");
		const link = within(section).getByRole("link", { name: "ウォッチリスト" });
		expect(link.getAttribute("href")).toBe("#/watchlist");
		expect(section.textContent).toContain(
			"ウォッチリストにある銘柄の決算発表日を、自分のカレンダーで管理できます。",
		);
		expect(within(section).getByRole("button", { name: "Google Calendar に接続" })).toBeTruthy();
		expect(within(section).getByRole("button", { name: "購読リンクを作成" })).toBeTruthy();
	});

	it("states the last sync with its counts", () => {
		inJapanese(() => (
			<GoogleCalendarCard
				state={{
					status: "connected",
					authUrl: null,
					calendarId: "cal_1",
					connectedAt: "2026-11-02T10:00:00Z",
					lastSyncedAt: "2026-11-02T11:00:00Z",
					lastSync: { inserted: 3, updated: 0, deleted: 1, unchanged: 4 },
					inSync: false,
					activeRunId: null,
					activeRunState: null,
					activeAction: null,
					lastFailure: null,
				}}
				api={createApiClient({ fetch: createFakeBackend().fetch })}
				busy={false}
				onQueued={() => {}}
				onQueueFailed={() => {}}
			/>
		));
		expect(
			screen.getByText(
				/最終同期 .+: 追加 3 件、変更 0 件、削除 1 件。その後、ここの日付が変わりました。/,
			),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "今すぐ同期" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "切断" })).toBeTruthy();
	});
});
