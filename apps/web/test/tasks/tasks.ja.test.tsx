import { catalogProblems } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageMessages } from "../../src/pages.messages.ts";
import { ScheduledTasksWidget } from "../../src/tasks/ScheduledTasksWidget.tsx";
import { TasksView } from "../../src/tasks/TasksView.tsx";
import { tasksMessages } from "../../src/tasks/tasks.messages.ts";
import { tasksModelMessages } from "../../src/tasks/tasksModel.messages.ts";
import { widgetTypeMessages } from "../../src/widgets/widgetTypes.messages.ts";
import { ALWAYS_VISIBLE } from "../fakeBackend.ts";
import { createTasksServer, makeTask, NOW_MS } from "./tasksHarness.ts";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW_MS);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const TASK = makeTask({
	lastRun: {
		runId: "run_9",
		state: "completed",
		slotAt: null,
		queuedAt: "2026-10-23T23:00:02Z",
		failureCode: null,
	},
	lastSkip: { code: "RATE_LIMITED", slotAt: "2026-10-24T23:00:00Z", at: "2026-10-24T23:00:03Z" },
});

describe("scheduled tasks in Japanese (ADR-0032)", () => {
	it("has whole catalogs and names the page and the widget type", () => {
		expect(catalogProblems(tasksMessages)).toEqual([]);
		expect(catalogProblems(tasksModelMessages)).toEqual([]);
		expect(pageMessages.ja.title("tasks")).toBe("タスク");
		expect(widgetTypeMessages.ja.typeLabel("scheduled-tasks")).toBe("スケジュールされたタスク");
	});

	it("renders the Tasks page and its editor in Japanese", async () => {
		const server = createTasksServer({ tasks: [TASK] });
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<TasksView api={server.api} visibility={ALWAYS_VISIBLE} />
			</LocaleProvider>
		));
		const section = await screen.findByRole("region", { name: "スケジュールされたタスク" });
		const row = await within(section).findByRole("article", { name: /Morning storage brief/ });
		expect(row.textContent).toContain("毎日 08:00");
		expect(row.textContent).toContain("次回の実行は 14 時間後");
		expect(row.textContent).toContain("前回の実行: 完了");
		expect(row.textContent).toContain("1 時間あたりの実行回数");
		expect(
			within(row).getByRole("button", { name: "Morning storage brief を一時停止" }),
		).toBeTruthy();
		expect(
			within(row).getByRole("link", { name: "Morning storage brief のチャットを開く" }),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "新しいタスク" }));
		const dialog = await screen.findByRole("dialog", { name: "新しいタスク" });
		expect(within(dialog).getByLabelText("タイトル")).toBeTruthy();
		expect(within(dialog).getByLabelText("繰り返し")).toBeTruthy();
		expect(within(dialog).getByRole("option", { name: "平日（月〜金）" })).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "キャンセル" })).toBeTruthy();
	});

	it("renders the widget in Japanese", async () => {
		const server = createTasksServer({ tasks: [TASK] });
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<ScheduledTasksWidget
					widget={{
						widgetId: "w-tasks",
						type: "scheduled-tasks",
						title: "スケジュールされたタスク",
						size: "medium",
					}}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</LocaleProvider>
		));
		expect(await screen.findByText("有効 1 件 / 全 1 件")).toBeTruthy();
		expect(screen.getByRole("link", { name: "タスクを開く" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Morning storage brief を今すぐ実行" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "新しいタスク" })).toBeTruthy();
	});
});
