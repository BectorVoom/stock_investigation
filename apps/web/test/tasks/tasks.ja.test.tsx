import { catalogProblems } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageMessages } from "../../src/pages.messages.ts";
import { ScheduledTasksWidget } from "../../src/tasks/ScheduledTasksWidget.tsx";
import { TaskResultDialog } from "../../src/tasks/TaskResultDialog.tsx";
import { TaskResultWidget } from "../../src/tasks/TaskResultWidget.tsx";
import { TasksView } from "../../src/tasks/TasksView.tsx";
import { taskResultMessages } from "../../src/tasks/taskResult.messages.ts";
import { tasksMessages } from "../../src/tasks/tasks.messages.ts";
import { tasksModelMessages } from "../../src/tasks/tasksModel.messages.ts";
import { widgetTypeMessages } from "../../src/widgets/widgetTypes.messages.ts";
import { ALWAYS_VISIBLE } from "../fakeBackend.ts";
import { createTasksServer, makeResult, makeTask, NOW_MS } from "./tasksHarness.ts";

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
		failureUpstreamStatus: null,
	},
	lastSkip: { code: "RATE_LIMITED", slotAt: "2026-10-24T23:00:00Z", at: "2026-10-24T23:00:03Z" },
});

describe("scheduled tasks in Japanese (ADR-0032)", () => {
	it("has whole catalogs and names the page and the widget type", () => {
		expect(catalogProblems(tasksMessages)).toEqual([]);
		expect(catalogProblems(tasksModelMessages)).toEqual([]);
		expect(catalogProblems(taskResultMessages)).toEqual([]);
		expect(widgetTypeMessages.ja.typeLabel("task-result")).toBe("タスクの結果");
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
		expect(
			within(row).getByRole("button", { name: "Morning storage brief の結果をホームに表示" })
				.textContent,
		).toBe("結果をホームに表示");

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

	it("renders the Task result widget in Japanese", async () => {
		const server = createTasksServer({ tasks: [TASK] });
		server.setResult("task_1", makeResult({ verificationStatus: "partially-verified" }));
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<TaskResultWidget
					widget={{
						widgetId: "w-result",
						type: "task-result",
						taskId: "task_1",
						title: "Morning storage brief",
						size: "medium",
					}}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</LocaleProvider>
		));
		await screen.findByText(/Grid storage demand/);
		const status = document.querySelector('[data-field="task-result-status"]');
		expect(status?.textContent).toContain("2 時間前に回答");
		expect(status?.textContent).toContain("一部検証済み");
		expect(
			screen.getByRole("link", { name: "Morning storage brief のチャットを開く" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Morning storage brief を今すぐ実行" })).toBeTruthy();
	});

	it("renders the Task result widget's empty and deleted states and the add dialog in Japanese", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		const view = render(() => (
			<LocaleProvider locale={() => "ja"}>
				<TaskResultWidget
					widget={{
						widgetId: "w-result",
						type: "task-result",
						taskId: "task_1",
						title: "Morning storage brief",
						size: "small",
					}}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
				<TaskResultWidget
					widget={{
						widgetId: "w-gone",
						type: "task-result",
						taskId: "task_gone",
						title: "Old task",
						size: "small",
					}}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</LocaleProvider>
		));
		expect(await screen.findByText("まだ結果はありません。")).toBeTruthy();
		expect(
			await screen.findByText(
				"このタスクは削除されました。メニューからこのウィジェットを削除してください。",
			),
		).toBeTruthy();
		view.unmount();

		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<TaskResultDialog
					api={createTasksServer().api}
					visibility={ALWAYS_VISIBLE}
					opener={null}
					onChoose={() => Promise.resolve(true)}
					onClose={() => {}}
				/>
			</LocaleProvider>
		));
		const dialog = await screen.findByRole("dialog", { name: "タスクを選択" });
		expect(
			await within(dialog).findByText(
				"スケジュールされたタスクはまだありません。先にタスクページで作成してください。",
			),
		).toBeTruthy();
		expect(within(dialog).getByRole("link", { name: "タスクを開く" })).toBeTruthy();
	});
});
