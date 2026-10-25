import { type HomeWidget, MARKET_LIMITS, putHomeDashboardRequestSchema } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "../../src/tasks/TasksView.tsx";
import {
	type HomeServerState,
	initialHomeServerState,
	initialServerState,
	initialWatchlistServerState,
	installHomeRoutes,
	installWatchlistRoutes,
	mountApp,
} from "../appHarness.tsx";
import { ALWAYS_VISIBLE, createFakeBackend, type FakeBackend } from "../fakeBackend.ts";
import { lastOpenMenu } from "../openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "../setup.ts";
import { createTasksServer, makeResult, makeTask, type TasksServer } from "./tasksHarness.ts";

let backend: FakeBackend;
let home: HomeServerState;
let tasks: TasksServer;

const SECOND_TASK = makeTask({
	taskId: "task_2",
	workspaceId: "ws_task_2",
	title: "Weekly chip check",
	schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
	timeZone: "UTC",
	nextRunAt: "2026-10-26T07:30:00Z",
});

function freshBackend(taskList = [makeTask(), SECOND_TASK]): void {
	backend = createFakeBackend();
	home = initialHomeServerState(false);
	installHomeRoutes(backend, initialServerState(), home);
	installWatchlistRoutes(backend, initialWatchlistServerState());
	tasks = createTasksServer({ tasks: taskList, backend });
	tasks.setResult("task_1", makeResult());
	window.location.hash = "#/home";
}

beforeEach(() => {
	// Home's fixtures are fresh at this time, so Home queues no auto-refresh.
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
	resetGlobalFetchCalls();
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

const homePuts = () => backend.requestsTo("PUT", /\/home\/dashboard$/);
/** The widgets the last Home save sent, read through the contract. */
function lastSavedWidgets(): readonly HomeWidget[] {
	const put = homePuts().at(-1);
	if (put === undefined) throw new Error("nothing was saved");
	return putHomeDashboardRequestSchema.parse(put.body).dashboard.widgets;
}

function frames(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

async function openTaskDialog(): Promise<HTMLElement> {
	await waitFor(() => expect(frames()).toHaveLength(7), { timeout: 10_000 });
	const add = screen.getByRole("button", { name: "Add widget" });
	fireEvent.click(add);
	fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: "Task result" }));
	return screen.findByRole("dialog", { name: "Choose a task" });
}

describe("adding a Task result widget from the add menu (ADR-0038 §5)", () => {
	it("lists the tasks with their schedules and places the chosen one", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openTaskDialog();
		const list = await within(dialog).findByRole("list", { name: "Your scheduled tasks" });
		const choices = within(list).getAllByRole("button");
		expect(choices.map((choice) => choice.textContent)).toEqual([
			"Morning storage briefEvery day at 08:00",
			// The tests run in Asia/Tokyo: another zone is named.
			"Weekly chip checkWeekdays at 07:30 (UTC)",
		]);
		// Focus starts on the first task, so Enter picks it.
		await waitFor(() => expect(document.activeElement).toBe(choices[0]));

		fireEvent.click(choices[0] ?? list);
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(lastSavedWidgets().at(-1)).toMatchObject({
			type: "task-result",
			taskId: "task_1",
			title: "Morning storage brief",
			size: "medium",
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(frames()).toHaveLength(8));
		const frame = frames().at(-1);
		if (frame === undefined) throw new Error("expected the new widget");
		await waitFor(() => expect(frame.textContent).toContain("Grid storage demand rose overnight."));
		// No Edit…: which task it shows was chosen when it was added.
		const actions = frame.querySelector("button[data-widget-actions]");
		if (!(actions instanceof HTMLElement)) throw new Error("no widget actions button");
		fireEvent.click(actions);
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).not.toContain("Edit…");
		expect(names).toContain("Size: Small");
	});

	it("with no tasks, says so and links to the Tasks page", async () => {
		freshBackend([]);
		mountApp(backend);
		const dialog = await openTaskDialog();
		expect(
			await within(dialog).findByText(
				"You have no scheduled tasks yet. Create one on the Tasks page first.",
			),
		).toBeTruthy();
		expect(within(dialog).getByRole("link", { name: "Open Tasks" }).getAttribute("href")).toBe(
			"#/tasks",
		);
		expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
	});

	it("closes on Escape or Cancel without saving and gives focus back to Add widget", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openTaskDialog();
		await within(dialog).findByRole("list", { name: "Your scheduled tasks" });
		fireEvent(dialog, new Event("cancel", { cancelable: true }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add widget" }));

		const again = await openTaskDialog();
		fireEvent.click(within(again).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(homePuts()).toHaveLength(0);
	});
});

describe("Show result on Home on the Tasks page (ADR-0038 §5)", () => {
	function renderTasksPage() {
		return render(() => <TasksView api={tasks.api} visibility={ALWAYS_VISIBLE} />);
	}

	it("appends a Task result widget to Home, then says it is already there", async () => {
		freshBackend();
		renderTasksPage();
		const button = await screen.findByRole("button", {
			name: "Show the result of Morning storage brief on Home",
		});
		expect(button.textContent).toBe("Show result on Home");
		fireEvent.click(button);
		expect(
			await screen.findByText("Added the result of Morning storage brief to Home."),
		).toBeTruthy();
		expect(homePuts()).toHaveLength(1);
		expect(homePuts()[0]?.body).toMatchObject({ expectedVersion: 0 });
		const added = lastSavedWidgets().at(-1);
		expect(added).toMatchObject({ type: "task-result", taskId: "task_1", size: "medium" });
		expect(lastSavedWidgets()).toHaveLength(8);

		fireEvent.click(button);
		expect(
			await screen.findByText("Already on Home: the result of Morning storage brief."),
		).toBeTruthy();
		expect(homePuts()).toHaveLength(1);
	});

	it("re-reads Home and tries again when another tab saved it first", async () => {
		freshBackend();
		renderTasksPage();
		const button = await screen.findByRole("button", {
			name: "Show the result of Weekly chip check on Home",
		});
		// Another tab saves between this page's read and its write.
		backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () => {
			const answer = new Response(
				JSON.stringify({
					dashboard: home.dashboard,
					version: home.version,
					updatedAt: home.updatedAt,
					origin: "saved",
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
			if (homePuts().length === 0 && home.version === 0) home.version = 1;
			return answer;
		});
		fireEvent.click(button);
		expect(await screen.findByText("Added the result of Weekly chip check to Home.")).toBeTruthy();
		expect(homePuts().map((put) => put.body)).toMatchObject([
			{ expectedVersion: 0 },
			{ expectedVersion: 1 },
		]);
	});

	it("reports Home's widget limit instead of saving", async () => {
		freshBackend();
		home.dashboard = {
			schemaVersion: 2,
			widgets: Array.from({ length: MARKET_LIMITS.maxWidgets }, (_, index) => ({
				widgetId: `w-text-${index}`,
				type: "text" as const,
				title: `Note ${index}`,
				size: "small" as const,
				text: "A note.",
			})),
		};
		renderTasksPage();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Show the result of Morning storage brief on Home",
			}),
		);
		expect(
			await screen.findByText(
				`The result of Morning storage brief was not added: Home holds at most ${MARKET_LIMITS.maxWidgets} widgets. Remove one there first.`,
			),
		).toBeTruthy();
		expect(homePuts()).toHaveLength(0);
	});

	it("shows a failed Home read with its code", async () => {
		freshBackend();
		home.dashboardUnreadable = true;
		renderTasksPage();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Show the result of Morning storage brief on Home",
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The result was not added to Home.");
		expect(alert.textContent).toContain("STORED_DASHBOARD_UNREADABLE");
	});
});
