import { notebookWidgetSchema, type ScheduledTask, type WidgetSize } from "@research/contracts";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisibilitySource } from "../../src/lib/polling.ts";
import { ScheduledTasksWidget } from "../../src/tasks/ScheduledTasksWidget.tsx";
import { WidgetBody } from "../../src/widgets/WidgetBody.tsx";
import { ALWAYS_VISIBLE, createControllableVisibility } from "../fakeBackend.ts";
import { createTasksServer, makeTask, NOW_MS, type TasksServer } from "./tasksHarness.ts";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function widgetCore(size: WidgetSize, widgetId = "w-tasks") {
	return { widgetId, type: "scheduled-tasks" as const, title: "Scheduled tasks", size };
}

function renderWidget(
	server: TasksServer,
	size: WidgetSize,
	visibility: VisibilitySource = ALWAYS_VISIBLE,
) {
	return render(() => (
		<ScheduledTasksWidget widget={widgetCore(size)} api={server.api} visibility={visibility} />
	));
}

function tenTasks(): ScheduledTask[] {
	return Array.from({ length: 10 }, (_, index) =>
		makeTask({
			taskId: `task_${index}`,
			workspaceId: `ws_${index}`,
			title: `Task ${index}`,
			nextRunAt: new Date(NOW_MS + (index + 1) * 3_600_000).toISOString(),
		}),
	);
}

const pending = {
	runId: "run_live",
	state: "pending" as const,
	slotAt: null,
	queuedAt: "2026-10-24T08:59:00Z",
	failureCode: null,
	failureUpstreamStatus: null,
};

/** Lets the fake fetches and Solid's effects settle under fake timers. */
async function flush(): Promise<void> {
	for (let step = 0; step < 10; step += 1) await vi.advanceTimersByTimeAsync(0);
}

describe("scheduled-tasks widget (ADR-0033 §9)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW_MS);
	});

	it("shows the next task only on Small", async () => {
		renderWidget(createTasksServer({ tasks: tenTasks() }), "small");
		const list = await screen.findByRole("list", { name: "Your scheduled tasks" });
		const items = within(list).getAllByRole("listitem");
		expect(items).toHaveLength(1);
		expect(items[0]?.textContent).toContain("Task 0");
		expect(items[0]?.textContent).toContain("Next run in 1 h");
		expect(screen.queryByText(/more$/)).toBeNull();
	});

	it("shows up to four on Medium and up to eight then 'N more' on Large", async () => {
		const server = createTasksServer({ tasks: tenTasks() });
		const medium = renderWidget(server, "medium");
		const mediumList = await screen.findByRole("list", { name: "Your scheduled tasks" });
		expect(within(mediumList).getAllByRole("listitem")).toHaveLength(4);
		expect(screen.queryByText(/more$/)).toBeNull();
		medium.unmount();

		renderWidget(server, "large");
		const largeList = await screen.findByRole("list", { name: "Your scheduled tasks" });
		expect(within(largeList).getAllByRole("listitem")).toHaveLength(8);
		const more = screen.getByRole("link", { name: "2 more" });
		expect(more.getAttribute("href")).toBe("#/tasks");
		expect(screen.getByRole("link", { name: "Open Tasks" }).getAttribute("href")).toBe("#/tasks");
	});

	it("orders by next run with paused and completed last, each with its last run and chat link", async () => {
		const server = createTasksServer({
			tasks: [
				makeTask({ taskId: "p", title: "Paused one", status: "paused", nextRunAt: null }),
				makeTask({
					taskId: "a",
					title: "Active one",
					workspaceId: "ws_active",
					lastRun: { ...pending, state: "completed" },
				}),
			],
		});
		renderWidget(server, "medium");
		const list = await screen.findByRole("list", { name: "Your scheduled tasks" });
		const items = within(list).getAllByRole("listitem");
		expect(items.map((item) => item.querySelector("p")?.textContent)).toEqual([
			"Active one",
			"Paused one",
		]);
		expect(items[0]?.textContent).toContain("Last run: completed");
		const chat = within(items[0] ?? list).getByRole("link", {
			name: "Open the chat of Active one",
		});
		expect(chat.getAttribute("href")).toBe("#/chat/ws_active");
		expect(items[1]?.textContent).toContain("Paused: it does not run until you resume it.");
		expect(screen.getByText("1 active of 2")).toBeTruthy();
	});

	it("has an empty state with New task, which opens the Tasks page's editor", async () => {
		renderWidget(createTasksServer(), "small");
		expect(
			await screen.findByText(
				"No scheduled tasks yet. A task runs a research question on a schedule.",
			),
		).toBeTruthy();
		// A labelled button in the empty body, not only the header's icon.
		const newTask = screen.getByRole("button", { name: "New task" });
		expect(newTask.textContent).toBe("New task");
		fireEvent.click(newTask);
		expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
	});

	it("pauses, resumes and runs a task from icon buttons named after it", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderWidget(server, "medium");
		const pause = await screen.findByRole("button", { name: "Pause Morning storage brief" });
		expect(pause.getAttribute("title")).toBe("Pause Morning storage brief");
		fireEvent.click(pause);
		const resume = await screen.findByRole("button", { name: "Resume Morning storage brief" });
		fireEvent.click(resume);
		await screen.findByRole("button", { name: "Pause Morning storage brief" });
		fireEvent.click(screen.getByRole("button", { name: "Run Morning storage brief now" }));
		await screen.findByText(/Queued a run of Morning storage brief/);
		expect(
			server.backend.requestsTo("PATCH", /scheduled-tasks\/task_1$/).map((request) => request.body),
		).toEqual([
			{ expectedVersion: 1, status: "paused" },
			{ expectedVersion: 2, status: "active" },
		]);
		expect(server.backend.requestsTo("POST", /task_1\/run$/)).toHaveLength(1);
	});

	it("offers no Pause or Resume on a completed one-time task, only Run now", async () => {
		const server = createTasksServer({
			tasks: [
				makeTask({
					status: "completed",
					nextRunAt: null,
					schedule: { kind: "once", date: "2026-10-20", time: "08:00" },
				}),
			],
		});
		renderWidget(server, "small");
		await screen.findByRole("button", { name: "Run Morning storage brief now" });
		expect(screen.queryByRole("button", { name: /^(Pause|Resume) / })).toBeNull();
	});

	it("shows a load failure with an icon Try again that re-reads the list", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		let fail = true;
		server.backend.on("GET", /^\/api\/v1\/scheduled-tasks$/, () =>
			fail
				? new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), {
						status: 500,
						headers: { "Content-Type": "application/json" },
					})
				: new Response(
						JSON.stringify({ tasks: [makeTask()], limits: { maxActive: 10, maxTasks: 30 } }),
						{ headers: { "Content-Type": "application/json" } },
					),
		);
		renderWidget(server, "medium");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Could not load the scheduled tasks.");
		fail = false;
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await screen.findByText("Morning storage brief");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("scheduled-tasks widget polling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW_MS);
	});

	it("polls every 5 s while a run is unfinished and backs off to 30 s once it ends", async () => {
		const server = createTasksServer({ tasks: [makeTask({ lastRun: pending })] });
		renderWidget(server, "medium");
		await flush();
		expect(server.listRequests()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(server.listRequests()).toHaveLength(2);
		// The conditional re-read carries the ETag (the server answers 304).
		expect(server.listRequests()[1]?.headers["if-none-match"]).toBe('"tasks-1"');

		server.update(makeTask({ lastRun: { ...pending, state: "completed" }, version: 2 }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(server.listRequests()).toHaveLength(3);
		await flush();
		expect(screen.getByText("Last run: completed")).toBeTruthy();
		await vi.advanceTimersByTimeAsync(25_000);
		expect(server.listRequests()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(server.listRequests()).toHaveLength(4);
	});

	it("retires the 'Queued a run' notice once the list shows the run moving on", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderWidget(server, "medium");
		fireEvent.click(await screen.findByRole("button", { name: "Run Morning storage brief now" }));
		await screen.findByText(/Queued a run of Morning storage brief/);
		// The next poll still shows the run as queued: the notice stays.
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(screen.queryByText(/Queued a run of Morning storage brief/)).not.toBeNull();
		const queued = server.state.tasks[0];
		if (queued?.lastRun == null) throw new Error("the run was not queued");
		server.update({ ...queued, lastRun: { ...queued.lastRun, state: "collecting" } });
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(screen.getByText("Last run: collecting")).toBeTruthy();
		expect(screen.queryByText(/Queued a run of Morning storage brief/)).toBeNull();
	});

	it("sends nothing while the tab is hidden and catches up when it shows again", async () => {
		const visibility = createControllableVisibility();
		const server = createTasksServer({ tasks: [makeTask()] });
		renderWidget(server, "medium", visibility);
		await flush();
		expect(server.listRequests()).toHaveLength(1);
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(server.listRequests()).toHaveLength(1);
		visibility.setVisible(true);
		await flush();
		expect(server.listRequests()).toHaveLength(2);
	});

	it("shares one list and one poll between several widgets on a page", async () => {
		const server = createTasksServer({ tasks: tenTasks() });
		const view = render(() => (
			<>
				<ScheduledTasksWidget
					widget={widgetCore("small", "w-a")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
				<ScheduledTasksWidget
					widget={widgetCore("medium", "w-b")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
				<ScheduledTasksWidget
					widget={widgetCore("large", "w-c")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</>
		));
		await flush();
		expect(screen.getAllByRole("list", { name: "Your scheduled tasks" })).toHaveLength(3);
		expect(server.listRequests()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(server.listRequests()).toHaveLength(2);
		// The last widget gone, polling stops.
		view.unmount();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(server.listRequests()).toHaveLength(2);
	});

	it("updates every widget at once after a quick action in one of them", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		render(() => (
			<>
				<ScheduledTasksWidget
					widget={widgetCore("small", "w-a")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
				<ScheduledTasksWidget
					widget={widgetCore("medium", "w-b")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</>
		));
		await flush();
		const [first] = screen.getAllByRole("button", { name: "Pause Morning storage brief" });
		if (first === undefined) throw new Error("expected a Pause button");
		fireEvent.click(first);
		await flush();
		expect(screen.getAllByRole("button", { name: "Resume Morning storage brief" })).toHaveLength(2);
	});
});

describe("scheduled-tasks widget in the Notebook", () => {
	it("renders through the shared widget body from a stored notebook widget", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		const widget = notebookWidgetSchema.parse({
			...widgetCore("small"),
			createdAt: "2026-10-24T00:00:00Z",
			updatedAt: "2026-10-24T00:00:00Z",
			revision: 1,
			origin: { kind: "assistant", messageId: null, runId: null, componentId: null },
		});
		render(() => (
			<WidgetBody
				widget={widget}
				view={null}
				api={server.api}
				visibility={ALWAYS_VISIBLE}
				market={null}
				editingDisabled={false}
				onSaveText={() => Promise.resolve(true)}
				onSaveMarketWidget={() => {}}
			/>
		));
		expect(await screen.findByText("Morning storage brief")).toBeTruthy();
		expect(screen.getByText("Written by the assistant")).toBeTruthy();
	});
});
