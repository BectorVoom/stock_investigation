import {
	notebookWidgetSchema,
	type ScheduledTask,
	type TaskLastRun,
	type WidgetSize,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskResultWidget } from "../../src/tasks/TaskResultWidget.tsx";
import { resultStamp } from "../../src/tasks/taskResultStore.ts";
import { WidgetBody } from "../../src/widgets/WidgetBody.tsx";
import { ALWAYS_VISIBLE, deferred, errorResponse, jsonResponse } from "../fakeBackend.ts";
import {
	createTasksServer,
	makeResult,
	makeTask,
	NOW_MS,
	type TasksServer,
} from "./tasksHarness.ts";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function widgetCore(size: WidgetSize, widgetId = "w-result", taskId = "task_1") {
	return {
		widgetId,
		type: "task-result" as const,
		taskId,
		title: "Morning storage brief",
		size,
	};
}

function renderWidget(server: TasksServer, size: WidgetSize = "medium") {
	return render(() => (
		<TaskResultWidget widget={widgetCore(size)} api={server.api} visibility={ALWAYS_VISIBLE} />
	));
}

function lastRun(overrides: Partial<TaskLastRun> = {}): TaskLastRun {
	return {
		runId: "run_9",
		state: "completed",
		slotAt: null,
		queuedAt: "2026-10-24T06:59:00Z",
		failureCode: null,
		failureUpstreamStatus: null,
		...overrides,
	};
}

/** A server with one answered task (its last run completed two hours ago). */
function answeredServer(task: Partial<ScheduledTask> = {}): TasksServer {
	const server = createTasksServer({ tasks: [makeTask({ lastRun: lastRun(), ...task })] });
	server.setResult("task_1", makeResult());
	return server;
}

function root(): HTMLElement {
	const element = document.querySelector('[data-widget-kind="task-result"]');
	if (!(element instanceof HTMLElement)) throw new Error("the widget is missing");
	return element;
}

function field(name: string): HTMLElement | null {
	const element = root().querySelector(`[data-field="${name}"]`);
	return element instanceof HTMLElement ? element : null;
}

/** Lets the fake fetches and Solid's effects settle under fake timers. */
async function flush(): Promise<void> {
	for (let step = 0; step < 10; step += 1) await vi.advanceTimersByTimeAsync(0);
}

describe("task-result widget (ADR-0038 §4)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW_MS);
	});

	it("shows the task's title, when it answered, its verification and the answer", async () => {
		renderWidget(answeredServer());
		await screen.findByText(/Grid storage demand rose overnight\./);
		expect(root().dataset.taskId).toBe("task_1");
		expect(root().textContent).toContain("Morning storage brief");
		const status = field("task-result-status");
		expect(status?.textContent).toContain("Answered 2 h ago");
		const badge = status?.querySelector("[data-verification-status]");
		expect(badge?.getAttribute("data-verification-status")).toBe("verified");
		expect(badge?.textContent).toContain("Verified");
		expect(field("task-result-run")).toBeNull();
		// Plain text with its line break kept, never markup.
		const answer = field("task-result-text");
		expect(answer?.textContent).toBe(
			"Grid storage demand rose overnight.\nTwo utilities announced new tenders.",
		);
		expect(answer?.className).toContain("whitespace-pre-wrap");
	});

	it("shows the task's current title, not the one stored when it was added", async () => {
		const server = answeredServer({ title: "Renamed brief" });
		renderWidget(server);
		await screen.findByText("Renamed brief");
		expect(root().textContent).not.toContain("Morning storage brief");
	});

	it("renders markup in an answer as text (UI-005)", async () => {
		const server = answeredServer();
		server.setResult(
			"task_1",
			makeResult({ text: "<b>bold</b> <img src=x onerror=alert(1)> claim" }),
		);
		renderWidget(server);
		const answer = await screen.findByText("<b>bold</b> <img src=x onerror=alert(1)> claim");
		expect(answer.querySelector("b")).toBeNull();
		expect(root().querySelector("img")).toBeNull();
	});

	it("clamps the answer by size: Small 4 lines, Medium 10, Large all", async () => {
		const server = answeredServer();
		const clampOf = async (size: WidgetSize) => {
			const view = renderWidget(server, size);
			await screen.findByText(/Grid storage demand/);
			const classes = field("task-result-text")?.className ?? "";
			view.unmount();
			return classes;
		};
		expect(await clampOf("small")).toContain("line-clamp-4");
		expect(await clampOf("medium")).toContain("line-clamp-10");
		expect(await clampOf("large")).not.toContain("line-clamp");
	});

	it("names when it answered beyond a day in the task's zone, and each verification status", async () => {
		const server = answeredServer();
		server.setResult(
			"task_1",
			makeResult({ answeredAt: "2026-10-20T23:00:00Z", verificationStatus: "partially-verified" }),
		);
		const first = renderWidget(server);
		await screen.findByText(/Grid storage demand/);
		// The task's zone (Asia/Tokyo) is not the browser's, so it is named.
		expect(field("task-result-status")?.textContent).toMatch(/Answered .*Oct 21.*08:00/);
		expect(field("task-result-status")?.textContent).toContain("Partially verified");
		first.unmount();

		server.setResult("task_1", makeResult({ verificationStatus: null }));
		renderWidget(server);
		await screen.findByText("Verification not recorded");
	});

	it("says it is loading until the answer arrives", async () => {
		const server = answeredServer();
		const gate = deferred<Response>();
		server.backend.on("GET", /\/scheduled-tasks\/task_1\/result$/, () => gate.promise);
		renderWidget(server);
		expect(await screen.findByText("Loading the task's result…")).toBeTruthy();
		gate.resolve(jsonResponse({ result: makeResult() }));
		await screen.findByText(/Grid storage demand/);
		expect(screen.queryByText("Loading the task's result…")).toBeNull();
	});

	it("has no answer yet: says so with the next run", async () => {
		renderWidget(createTasksServer({ tasks: [makeTask()] }));
		await screen.findByText("No result yet.");
		expect(field("task-result-empty")?.textContent).toContain("Next run in 14 h");
		expect(field("task-result-text")).toBeNull();
	});

	it("has no answer yet while the first run is in progress: says it is running", async () => {
		renderWidget(
			createTasksServer({
				tasks: [makeTask({ lastRun: lastRun({ runId: "run_1", state: "collecting" }) })],
			}),
		);
		await screen.findByText("No result yet.");
		expect(field("task-result-empty")?.textContent).toContain("Running now (collecting)");
	});

	it("keeps the previous answer while a run is in progress or after one failed", async () => {
		const running = answeredServer({ lastRun: lastRun({ runId: "run_10", state: "analyzing" }) });
		const first = renderWidget(running);
		await screen.findByText(/Grid storage demand/);
		expect(field("task-result-run")?.textContent).toBe("Running now (analyzing)");
		first.unmount();

		const failed = answeredServer({
			lastRun: lastRun({ runId: "run_10", state: "failed", failureCode: "PROVIDER_UNAVAILABLE" }),
		});
		renderWidget(failed);
		await screen.findByText(/Grid storage demand/);
		expect(field("task-result-run")?.textContent).toBe("Last run: failed (PROVIDER_UNAVAILABLE)");
	});

	it("shows the last skip with its reason", async () => {
		renderWidget(
			answeredServer({
				lastSkip: {
					code: "RATE_LIMITED",
					slotAt: "2026-10-24T23:00:00Z",
					at: "2026-10-24T23:00:03Z",
				},
			}),
		);
		await screen.findByText(/Grid storage demand/);
		expect(root().querySelector('[data-field="task-skip"]')?.textContent).toContain("was skipped");
	});

	it("says the task was deleted once the list no longer has it, with no actions", async () => {
		const server = answeredServer();
		server.state.tasks = [];
		renderWidget(server);
		await screen.findByText("This task was deleted. Remove this widget from its menu.");
		expect(screen.queryByRole("button", { name: /now$/ })).toBeNull();
		expect(screen.queryByRole("link", { name: /Open the chat/ })).toBeNull();
		// The stored title still names the widget.
		expect(root().textContent).toContain("Morning storage brief");
	});

	it("reads a 404 of a just-deleted task as deleted, not as an error", async () => {
		const server = answeredServer();
		server.backend.on("GET", /\/scheduled-tasks\/task_1\/result$/, () =>
			errorResponse(404, "NOT_FOUND", "no such task"),
		);
		renderWidget(server);
		await screen.findByText("This task was deleted. Remove this widget from its menu.");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a load failure with an icon Try again that reads the answer again", async () => {
		const server = answeredServer();
		let fail = true;
		server.backend.on("GET", /\/scheduled-tasks\/task_1\/result$/, () =>
			fail
				? errorResponse(500, "INTERNAL", "boom")
				: jsonResponse({ result: makeResult() }, { headers: { ETag: '"r-2"' } }),
		);
		renderWidget(server);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Could not load this task's result.");
		expect(alert.textContent).toContain("INTERNAL");
		fail = false;
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await screen.findByText(/Grid storage demand/);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("has Open chat to the task's chat and Run now named after the task", async () => {
		const server = answeredServer();
		renderWidget(server);
		await screen.findByText(/Grid storage demand/);
		const chat = screen.getByRole("link", { name: "Open the chat of Morning storage brief" });
		expect(chat.getAttribute("href")).toBe("#/chat/ws_task_1");
		expect(chat.textContent).toBe("Open chat");
		const run = screen.getByRole("button", { name: "Run Morning storage brief now" });
		expect(run.getAttribute("title")).toBe("Run Morning storage brief now");
		fireEvent.click(run);
		await screen.findByText(/Queued a run of Morning storage brief/);
		expect(server.backend.requestsTo("POST", /task_1\/run$/)).toHaveLength(1);
		// The list now holds the queued run: the status line says so at once.
		expect(field("task-result-run")?.textContent).toBe("Running now (pending)");
	});
});

describe("task-result widget reads", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW_MS);
	});

	it("reads the answer on mount and again only when the last run moves on", async () => {
		const server = answeredServer();
		renderWidget(server);
		await flush();
		expect(server.resultRequests()).toHaveLength(1);
		// The list polls (30 s idle): an unchanged task never reads the answer.
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		expect(server.listRequests().length).toBeGreaterThanOrEqual(3);
		expect(server.resultRequests()).toHaveLength(1);

		const task = server.state.tasks[0];
		if (task === undefined) throw new Error("expected the task");
		// A new run starts: one read (its answer is still the old one, a 304).
		server.update({ ...task, lastRun: lastRun({ runId: "run_10", state: "pending" }), version: 2 });
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		expect(server.resultRequests()).toHaveLength(2);
		expect(server.resultRequests()[1]?.headers["if-none-match"]).toBe('"result-task_1-2"');
		// Its steps while unfinished read nothing more.
		server.update({
			...task,
			lastRun: lastRun({ runId: "run_10", state: "collecting" }),
			version: 3,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(server.resultRequests()).toHaveLength(2);
		// It ends with an answer: one read shows it.
		server.setResult("task_1", makeResult({ runId: "run_10", text: "A newer answer." }));
		server.update({
			...task,
			lastRun: lastRun({ runId: "run_10", state: "completed" }),
			version: 4,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await flush();
		expect(server.resultRequests()).toHaveLength(3);
		expect(screen.getByText("A newer answer.")).toBeTruthy();
	});

	it("sends one read for two widgets of the same task", async () => {
		const server = answeredServer();
		render(() => (
			<>
				<TaskResultWidget
					widget={widgetCore("small", "w-a")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
				<TaskResultWidget
					widget={widgetCore("large", "w-b")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</>
		));
		await flush();
		expect(screen.getAllByText(/Grid storage demand/)).toHaveLength(2);
		expect(server.resultRequests()).toHaveLength(1);
		expect(server.listRequests()).toHaveLength(1);
	});

	it("reads again when a widget of the task mounts after none showed it", async () => {
		const server = answeredServer();
		const [shown, setShown] = createSignal(true);
		render(() => (
			<Show when={shown()}>
				<TaskResultWidget
					widget={widgetCore("medium")}
					api={server.api}
					visibility={ALWAYS_VISIBLE}
				/>
			</Show>
		));
		await flush();
		expect(server.resultRequests()).toHaveLength(1);
		setShown(false);
		await flush();
		// A follow-up asked in the chat changes the answer without a new task run.
		server.setResult("task_1", makeResult({ text: "The follow-up's answer." }));
		setShown(true);
		await flush();
		expect(server.resultRequests()).toHaveLength(2);
		expect(screen.getByText("The follow-up's answer.")).toBeTruthy();
	});
});

describe("result stamp", () => {
	it("is the run id with its end state, one stamp for every unfinished step", () => {
		expect(resultStamp(makeTask())).toBe("");
		expect(resultStamp(makeTask({ lastRun: lastRun({ state: "pending" }) }))).toBe(
			"run_9:unfinished",
		);
		expect(resultStamp(makeTask({ lastRun: lastRun({ state: "verifying" }) }))).toBe(
			"run_9:unfinished",
		);
		expect(resultStamp(makeTask({ lastRun: lastRun({ state: "completed" }) }))).toBe(
			"run_9:completed",
		);
		expect(resultStamp(makeTask({ lastRun: lastRun({ state: "failed" }) }))).toBe("run_9:failed");
	});
});

describe("task-result widget in the Notebook", () => {
	it("renders through the shared widget body from a stored notebook widget", async () => {
		const server = answeredServer();
		const widget = notebookWidgetSchema.parse({
			...widgetCore("small"),
			createdAt: "2026-10-24T00:00:00Z",
			updatedAt: "2026-10-24T00:00:00Z",
			revision: 1,
			origin: { kind: "owner", messageId: null, runId: null, componentId: null },
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
		expect(await screen.findByText(/Grid storage demand/)).toBeTruthy();
		expect(root().dataset.taskId).toBe("task_1");
	});
});
