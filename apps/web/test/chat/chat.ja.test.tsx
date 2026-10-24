import { DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/chat/Composer.tsx";
import { Conversation } from "../../src/chat/Conversation.tsx";
import { composerMessages } from "../../src/chat/composer.messages.ts";
import { defaultComposerDraft, evaluateComposer } from "../../src/chat/composerModel.ts";
import { displayedChatTitle } from "../../src/chat/conversationList.ts";
import { NotebookTurnCard } from "../../src/chat/NotebookTurnCard.tsx";
import { RunCard } from "../../src/chat/RunCard.tsx";
import {
	AGENT_SETTINGS_RESPONSE,
	AGENTS,
	CONVERSATION,
	makeRun,
	WORKSPACE_ID,
} from "../fixtures.ts";
import { makeNotebookTurn } from "./notebookFixtures.ts";

afterEach(cleanup);

function inJapanese(view: () => JSX.Element): void {
	render(() => <LocaleProvider locale={() => "ja"}>{view()}</LocaleProvider>);
}

describe("Chat in Japanese", () => {
	it("words the composer, its options and its send button in Japanese", () => {
		inJapanese(() => (
			<Composer
				workspaceId={WORKSPACE_ID}
				agents={{ status: "ready", value: AGENTS }}
				settings={{ status: "ready", value: AGENT_SETTINGS_RESPONSE }}
				onReloadAgents={vi.fn()}
				onReloadSettings={vi.fn()}
				newIdempotencyKey={() => "idem-test-key-1"}
				onSubmit={vi.fn()}
			/>
		));
		const form = screen.getByRole("form", { name: "リサーチの入力欄" });
		expect(screen.getByRole("button", { name: "質問を送信" })).toBeTruthy();
		expect(screen.getByPlaceholderText("リサーチの質問を入力…")).toBeTruthy();
		// A parameterised message: the horizon and markets summary.
		expect(form.textContent).toContain("オプション: 5 年 · JP, US");
		expect(form.textContent).toContain("ウェブアクセス オフ");
		fireEvent.input(screen.getByLabelText("質問"), { target: { value: "a" } });
		expect(screen.getByText("リサーチの質問を入力してください（3 文字以上）。")).toBeTruthy();
	});

	it("gives the composer's reasons in the language it is passed", () => {
		const result = evaluateComposer(
			defaultComposerDraft(),
			AGENTS,
			AGENT_SETTINGS_RESPONSE.settings,
			WORKSPACE_ID,
			composerMessages.ja,
		);
		expect(result.problems).toContain("リサーチの質問を入力してください（3 文字以上）。");
		expect(result.configurationProblems).toEqual([]);
	});

	it("words a run card and its approval form, but keeps the codes", () => {
		inJapanese(() => (
			<RunCard
				run={makeRun({ runId: "run_9", state: "failed", failureCode: "PROVIDER_UNAVAILABLE" })}
				agents={AGENTS}
				onCancel={vi.fn()}
				onRetry={vi.fn()}
				onApprove={vi.fn()}
			/>
		));
		expect(screen.getByRole("article", { name: "実行 run_9" })).toBeTruthy();
		expect(screen.getByText("失敗コード:")).toBeTruthy();
		expect(screen.getByText("PROVIDER_UNAVAILABLE")).toBeTruthy();
		expect(screen.getByRole("button", { name: "実行を再試行" })).toBeTruthy();
		expect(screen.getByText(/モデルのプロバイダーが混雑しているか/)).toBeTruthy();
	});

	it("greets an empty chat and offers Japanese starter questions", () => {
		const onSelect = vi.fn();
		inJapanese(() => (
			<Conversation
				conversation={{ ...CONVERSATION, messages: [], claims: [], evidence: [] }}
				onSelectSuggestion={onSelect}
			/>
		));
		expect(screen.getByRole("heading", { name: "何をリサーチしますか？" })).toBeTruthy();
		const chips = screen.getAllByRole("list", { name: "質問の例" });
		expect(chips.length).toBeGreaterThan(0);
		fireEvent.click(
			screen.getAllByRole("button", {
				name: "最近の提出書類で価格決定力に言及している米国のサプライヤーはどこですか？",
			})[0] ?? document.body,
		);
		expect(onSelect).toHaveBeenCalledWith(
			"最近の提出書類で価格決定力に言及している米国のサプライヤーはどこですか？",
		);
	});

	it("words a notebook turn around the widget titles it keeps as written", () => {
		inJapanese(() => (
			<NotebookTurnCard
				turn={makeNotebookTurn({
					runId: "run_n1",
					changes: [
						{ widgetId: "nb_1", kind: "added", title: "Revenue", before: null, after: null },
					],
				})}
				notebookVersion={2}
				isKept={() => false}
				onUndo={vi.fn()}
				undoPending={false}
				onRemove={vi.fn()}
				onKeep={vi.fn()}
			/>
		));
		expect(
			screen.getByRole("article", { name: "実行 run_n1 によるノートブックの変更" }),
		).toBeTruthy();
		expect(screen.getByText("追加: 「Revenue」")).toBeTruthy();
		expect(screen.getByRole("button", { name: "取り消す" })).toBeTruthy();
	});

	it("shows only the server's untouched default chat title in the UI language", () => {
		expect(displayedChatTitle(DEFAULT_CONVERSATION_TITLE, "新しいチャット")).toBe("新しいチャット");
		expect(displayedChatTitle("Grid storage suppliers", "新しいチャット")).toBe(
			"Grid storage suppliers",
		);
	});
});
