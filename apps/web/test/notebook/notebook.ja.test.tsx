import type { ChatMessage } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { NotebookPanel } from "../../src/notebook/NotebookPanel.tsx";
import {
	notebookModelMessages,
	notebookSessionMessages,
} from "../../src/notebook/notebook.messages.ts";
import { widgetFromAnswer } from "../../src/notebook/notebookModel.ts";
import { createNotebookSession, type NotebookSession } from "../../src/notebook/notebookSession.ts";
import { parseRichText } from "../../src/notebook/richText/parser.ts";
import { RichTextView } from "../../src/notebook/richText/RichTextView.tsx";
import { TextWidget } from "../../src/notebook/widgets/TextWidget.tsx";
import { MarketWidgetDialog } from "../../src/widgets/MarketWidgetDialog.tsx";
import { widgetClipboardMessages } from "../../src/widgets/widgetClipboard.messages.ts";
import {
	clipboardCountText,
	createWidgetClipboardStore,
	type WidgetClipboardStore,
} from "../../src/widgets/widgetClipboard.ts";
import { ALWAYS_VISIBLE, type FakeBackend } from "../fakeBackend.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";
import { lastOpenMenu } from "../openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "../setup.ts";
import { createNotebookBackend, notebookFixtures, WORKSPACE_ID } from "./notebookHarness.ts";

/**
 * The Notebook and the shared widget board in Japanese (ADR-0031): the UI's
 * own words follow the language, the owner's content (titles, notes, data)
 * stays as stored.
 */

const registry = createBaselineUiRegistry();
const rootDisposers: (() => void)[] = [];
let backend: FakeBackend;

function memoryClipboard(): WidgetClipboardStore {
	const map = new Map<string, string>();
	return createRoot((dispose) => {
		rootDisposers.push(dispose);
		return createWidgetClipboardStore({
			getItem: (key) => map.get(key) ?? null,
			setItem: (key, value) => void map.set(key, value),
			removeItem: (key) => void map.delete(key),
		});
	});
}

function renderJapaneseNotebook(): NotebookSession {
	const api = createApiClient({ fetch: backend.fetch });
	const clipboard = memoryClipboard();
	const session = createRoot((dispose) => {
		rootDisposers.push(dispose);
		return createNotebookSession(
			api,
			WORKSPACE_ID,
			ALWAYS_VISIBLE,
			() => notebookSessionMessages.ja,
		);
	});
	render(() => (
		<LocaleProvider locale={() => "ja"}>
			<NotebookPanel
				session={session}
				api={api}
				registry={registry}
				view={WORKSPACE_VIEW}
				mode="notebook"
				clipboard={clipboard}
				onAskAssistant={() => undefined}
			/>
		</LocaleProvider>
	));
	return session;
}

function articleById(id: string): HTMLElement {
	const article = document.querySelector(`article[data-widget-id="${id}"]`);
	if (!(article instanceof HTMLElement)) throw new Error(`widget ${id} is missing`);
	return article;
}

beforeEach(() => {
	resetGlobalFetchCalls();
	const fixtures = notebookFixtures();
	({ backend } = createNotebookBackend([fixtures.text, fixtures.metric, fixtures.table]));
});

afterEach(() => {
	cleanup();
	while (rootDisposers.length > 0) rootDisposers.pop()?.();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("the Notebook in Japanese", () => {
	it("words the panel, the bodies and the board, and keeps the owner's titles", async () => {
		const session = renderJapaneseNotebook();
		await waitFor(
			() => expect(document.querySelectorAll("article[data-widget-id]")).toHaveLength(3),
			{
				timeout: 10_000,
			},
		);
		expect(screen.getByRole("region", { name: "ノートブック" })).toBeDefined();
		expect(screen.getByRole("button", { name: "ウィジェットを貼り付け" })).toBeDefined();
		// The metric body: direction word and "<date> 時点"; numbers and units unchanged.
		const metric = articleById("nb-metric");
		expect(metric.textContent).toContain("42.5");
		expect(metric.textContent).toContain("(上昇)");
		expect(metric.textContent).toContain("2026-10-01 時点");
		expect(metric.textContent).toContain("アシスタントが作成");
		expect(articleById("nb-table").querySelector("caption")?.textContent).toBe("2 列、2 行");
		// The text body's accessible name, and the owner's note as written.
		expect(
			within(articleById("nb-text")).getByRole("button", { name: "メモを編集" }),
		).toBeDefined();
		expect(articleById("nb-text").textContent).toContain("First paragraph.");
		// The stored title is quoted, never translated.
		fireEvent.click(screen.getByRole("button", { name: "「Notes」の操作" }));
		const menu = await waitFor(() => lastOpenMenu());
		for (const name of [
			"編集…",
			"サイズ: 小",
			"切り取り",
			"コピー",
			"後ろに貼り付け",
			"複製",
			"削除",
		]) {
			expect(within(menu).getByRole("menuitem", { name })).toBeDefined();
		}
		fireEvent.click(within(menu).getByRole("menuitem", { name: "コピー" }));
		await waitFor(() =>
			expect(document.querySelector("output.sr-only[aria-live='polite']")?.textContent).toBe(
				"1 件のウィジェットをコピーしました。",
			),
		);
		// The selection toolbar's count.
		session.select("nb-text", "replace");
		session.select("nb-table", "toggle");
		await waitFor(() => expect(screen.getByText("2 件を選択中")).toBeDefined());
		expect(screen.getByRole("toolbar", { name: "選択したウィジェット" })).toBeDefined();
	});

	it("gives a new widget its starter words in Japanese", async () => {
		renderJapaneseNotebook();
		await waitFor(
			() => expect(document.querySelectorAll("article[data-widget-id]")).toHaveLength(3),
			{
				timeout: 10_000,
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "ウィジェットを追加" }));
		const menu = await waitFor(() => lastOpenMenu());
		fireEvent.click(within(menu).getByRole("menuitem", { name: "テキスト" }));
		const heading = await screen.findByRole(
			"heading",
			{ name: "テキストウィジェットを編集" },
			{ timeout: 10_000 },
		);
		const dialog = heading.closest("dialog");
		if (dialog === null) throw new Error("no editor dialog");
		expect(within(dialog).getByLabelText("タイトル")).toHaveProperty("value", "新しいメモ");
		expect(within(dialog).getByRole("button", { name: "ウィジェットを保存" })).toBeDefined();
	});
});

describe("the widget words in Japanese", () => {
	it("words the market dialog's labels and problems", () => {
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<MarketWidgetDialog
					state={{ mode: "add", type: "line-chart" }}
					opener={null}
					widgets={[]}
					limits={{ scope: "notebook", maxWidgets: 200, maxSeries: 24 }}
					catalog={[]}
					catalogState="ready"
					seriesById={new Map()}
					onSave={() => undefined}
					onClose={() => undefined}
				/>
			</LocaleProvider>
		));
		const dialog = document.querySelector("sl-dialog");
		if (!(dialog instanceof HTMLElement)) throw new Error("no market dialog");
		expect(dialog.getAttribute("label") ?? Reflect.get(dialog, "label")).toBe(
			"折れ線チャートウィジェットを追加",
		);
		// The labels stay real attributes (tests and specs select controls by them).
		expect(dialog.querySelector('sl-select[label="系列"]')).not.toBeNull();
		expect(dialog.querySelector('sl-input[label="タイトル"]')).not.toBeNull();
		const problems = within(dialog).getByRole("list", { name: "このウィジェットを保存する前に" });
		expect(problems.textContent).toContain("タイトルを入力してください。");
		expect(problems.textContent).toContain("系列を選んでください。");
	});

	it("names a to-do checkbox after its item, and keeps the note as written", () => {
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<RichTextView
					doc={parseRichText("- [ ] buy milk")}
					onToggleTodo={() => undefined}
					checkboxesDisabled={false}
				/>
			</LocaleProvider>
		));
		expect(screen.getByRole("checkbox", { name: "ToDo: buy milk" })).toBeDefined();
	});

	it("words the in-place editor's names around the owner's note", async () => {
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<TextWidget
					widget={{
						widgetId: "w-note",
						type: "text",
						title: "Notes",
						size: "medium",
						text: "- [ ] buy milk",
					}}
					editingDisabled={false}
					onSaveText={() => Promise.resolve(true)}
				/>
			</LocaleProvider>
		));
		fireEvent.click(screen.getByRole("button", { name: "メモを編集" }));
		const editor = await screen.findByRole("textbox", { name: "メモを編集" }, { timeout: 10_000 });
		expect(within(editor).getByRole("checkbox", { name: "ToDo の完了を切り替え" })).toBeDefined();
		expect(editor.textContent).toContain("buy milk");
	});

	it("passes Japanese words to the pure helpers", () => {
		expect(clipboardCountText(2, "Cut", widgetClipboardMessages.ja)).toBe(
			"2 件のウィジェットを切り取りました。",
		);
		const empty: ChatMessage = {
			messageId: "msg_empty",
			seq: 1,
			role: "assistant",
			text: "",
			runId: "run_1",
			claimIds: [],
			createdAt: "2026-10-01T00:00:00Z",
		};
		const core = widgetFromAnswer(empty, notebookModelMessages.ja);
		expect(core.title).toBe("回答");
		expect(core.type === "text" ? core.text : null).toBe("（空の回答）");
	});
});
