import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "../../src/tasks/TasksView.tsx";
import { ALWAYS_VISIBLE } from "../fakeBackend.ts";
import {
	createTasksServer,
	METERED_SETTINGS,
	makeTask,
	NOW_MS,
	type TasksServer,
} from "./tasksHarness.ts";

beforeEach(() => {
	// Only the clock is fixed: the poller's timers stay real (30 s never elapses here).
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW_MS);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function renderPage(server: TasksServer) {
	render(() => <TasksView api={server.api} visibility={ALWAYS_VISIBLE} />);
}

async function rowOf(title: string): Promise<HTMLElement> {
	const heading = await screen.findByRole("heading", { name: new RegExp(title) });
	const row = heading.closest("li");
	if (row === null) throw new Error(`no row for ${title}`);
	return row;
}

function field(
	dialog: HTMLElement,
	label: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
	const control = within(dialog).getByLabelText(label);
	if (
		control instanceof HTMLInputElement ||
		control instanceof HTMLTextAreaElement ||
		control instanceof HTMLSelectElement
	) {
		return control;
	}
	throw new Error(`${label} is not a form control`);
}

/** Save waits for the AI agent settings (they decide whether consent is asked). */
async function saveEnabled(dialog: HTMLElement, name: string): Promise<void> {
	await waitFor(() => {
		const button = within(dialog).getByRole("button", { name });
		expect(button instanceof HTMLButtonElement && !button.disabled).toBe(true);
	});
}

describe("Tasks page (ADR-0033 §8)", () => {
	it("explains what a task is when there is none, with the limits", async () => {
		renderPage(createTasksServer());
		expect(
			await screen.findByText(/No scheduled tasks yet\. A task asks a research question/),
		).toBeTruthy();
		expect(screen.getByText("0 of 10 active · 0 of 30 tasks")).toBeTruthy();
	});

	it("lists a task with its schedule, next run, last run, chat link and skip with its fix", async () => {
		const server = createTasksServer({
			tasks: [
				makeTask({
					lastRun: {
						runId: "run_9",
						state: "completed",
						slotAt: "2026-10-23T23:00:00Z",
						queuedAt: "2026-10-23T23:00:02Z",
						failureCode: null,
					},
					lastSkip: {
						code: "AGENT_NOT_CONFIGURED",
						slotAt: "2026-10-24T23:00:00Z",
						at: "2026-10-24T23:00:03Z",
					},
				}),
			],
		});
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		expect(row.textContent).toContain("Every day at 08:00");
		expect(row.textContent).toContain("What changed overnight in grid storage demand?");
		expect(row.textContent).toContain("Next run in 14 h");
		expect(row.textContent).toContain("Last run: completed");
		const chat = within(row).getByRole("link", { name: "Open the chat of Morning storage brief" });
		expect(chat.getAttribute("href")).toBe("#/chat/ws_task_1");
		expect(row.textContent).toContain("no AI backend is saved in Settings.");
		const fix = within(row).getByRole("link", { name: "Open Settings → AI agent" });
		expect(fix.getAttribute("href")).toBe("#/settings/agent");
	});

	it("creates a Weekdays task in the browser's zone, with an idempotency key and no consent", async () => {
		const server = createTasksServer();
		renderPage(server);
		await screen.findByText(/No scheduled tasks yet/);
		fireEvent.click(screen.getByRole("button", { name: "New task" }));
		const dialog = await screen.findByRole("dialog", { name: "New task" });
		expect(document.activeElement).toBe(field(dialog, "Title"));
		fireEvent.input(field(dialog, "Title"), { target: { value: "Weekday open" } });
		fireEvent.input(field(dialog, "Question"), { target: { value: "How did Tokyo open?" } });
		fireEvent.change(field(dialog, "Repeat"), { target: { value: "weekdays" } });
		fireEvent.input(field(dialog, "Time"), { target: { value: "07:30" } });
		expect(field(dialog, "Time zone").value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		// A plan-limited backend is saved: no consent to give.
		await saveEnabled(dialog, "Create task");
		expect(within(dialog).queryByRole("checkbox", { name: /Allow this task to spend/ })).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));

		await screen.findByText("Created Weekday open. Its chat holds every answer.");
		const [create] = server.backend.requestsTo("POST", /^\/api\/v1\/scheduled-tasks$/);
		expect(create?.headers["idempotency-key"]).toMatch(/^idem-/);
		expect(create?.body).toEqual({
			title: "Weekday open",
			question: "How did Tokyo open?",
			horizonYears: 5,
			markets: ["JP", "US"],
			schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			spendConsent: null,
		});
		expect(screen.queryByRole("dialog")).toBeNull();
		const row = await rowOf("Weekday open");
		expect(row.textContent).toContain("Weekdays at 07:30");
	});

	it("shows what stops a save instead of sending it", async () => {
		const server = createTasksServer();
		renderPage(server);
		fireEvent.click(await screen.findByRole("button", { name: "New task" }));
		const dialog = await screen.findByRole("dialog", { name: "New task" });
		await saveEnabled(dialog, "Create task");
		fireEvent.change(field(dialog, "Repeat"), { target: { value: "weekly" } });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Mon" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
		const problems = within(dialog).getByRole("list", { name: "Before you can save this task" });
		expect(problems.textContent).toContain("Enter a title.");
		expect(problems.textContent).toContain("Choose at least one day of the week.");
		expect(server.backend.requestsTo("POST", /scheduled-tasks/)).toHaveLength(0);
	});

	it("creates a metered task without asking for spending consent", async () => {
		const server = createTasksServer({ agentSettings: METERED_SETTINGS });
		renderPage(server);
		fireEvent.click(await screen.findByRole("button", { name: "New task" }));
		const dialog = await screen.findByRole("dialog", { name: "New task" });
		fireEvent.input(field(dialog, "Title"), { target: { value: "Metered brief" } });
		fireEvent.input(field(dialog, "Question"), { target: { value: "What changed overnight?" } });
		await waitFor(() =>
			expect(
				within(dialog).getByRole("button", { name: "Create task" }).hasAttribute("disabled"),
			).toBe(false),
		);
		expect(within(dialog).queryByRole("checkbox", { name: /Allow this task to spend/ })).toBeNull();
		fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
		await screen.findByText(/Created Metered brief/);
		const [create] = server.backend.requestsTo("POST", /^\/api\/v1\/scheduled-tasks$/);
		const body = create?.body;
		expect(
			typeof body === "object" && body !== null && "spendConsent" in body
				? body.spendConsent
				: null,
		).toBeNull();
	});

	it("edits a task in the same dialog with compare-and-set on its version", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		fireEvent.click(within(row).getByRole("button", { name: "Edit Morning storage brief" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit task" });
		expect(field(dialog, "Title").value).toBe("Morning storage brief");
		expect(field(dialog, "Repeat").value).toBe("daily");
		expect(field(dialog, "Time zone").value).toBe("Asia/Tokyo");
		fireEvent.input(field(dialog, "Title"), { target: { value: "Evening storage brief" } });
		fireEvent.input(field(dialog, "Time"), { target: { value: "18:30" } });
		await saveEnabled(dialog, "Save task");
		fireEvent.click(within(dialog).getByRole("button", { name: "Save task" }));
		await screen.findByText("Saved Evening storage brief.");
		const [patch] = server.backend.requestsTo("PATCH", /scheduled-tasks\/task_1$/);
		expect(patch?.body).toMatchObject({
			expectedVersion: 1,
			title: "Evening storage brief",
			schedule: { kind: "daily", time: "18:30" },
			timeZone: "Asia/Tokyo",
		});
		expect((await rowOf("Evening storage brief")).textContent).toContain("Every day at 18:30");
	});

	it("pauses and resumes a task", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		fireEvent.click(within(row).getByRole("button", { name: "Pause Morning storage brief" }));
		await screen.findByText("Paused Morning storage brief.");
		const paused = await rowOf("Morning storage brief");
		expect(paused.textContent).toContain("Paused: it does not run until you resume it.");
		fireEvent.click(within(paused).getByRole("button", { name: "Resume Morning storage brief" }));
		await screen.findByText("Resumed Morning storage brief.");
		const bodies = server.backend
			.requestsTo("PATCH", /scheduled-tasks\/task_1$/)
			.map((request) => request.body);
		expect(bodies).toEqual([
			{ expectedVersion: 1, status: "paused" },
			{ expectedVersion: 2, status: "active" },
		]);
	});

	it("runs a task now, and says so when its last run is still unfinished", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		fireEvent.click(within(row).getByRole("button", { name: "Run Morning storage brief now" }));
		await screen.findByText(
			"Queued a run of Morning storage brief. Its answer arrives in its chat.",
		);
		const ran = await rowOf("Morning storage brief");
		expect(ran.textContent).toContain("Last run: pending");
		fireEvent.click(within(ran).getByRole("button", { name: "Run Morning storage brief now" }));
		await screen.findByText(/is still on its last run, so no second run was queued/);
		const runs = server.backend.requestsTo("POST", /scheduled-tasks\/task_1\/run$/);
		expect(runs).toHaveLength(2);
		// Each press is its own logical write.
		expect(runs[0]?.headers["idempotency-key"]).not.toBe(runs[1]?.headers["idempotency-key"]);
	});

	it("deletes only after confirmation, and keeps the task on Cancel", async () => {
		const server = createTasksServer({ tasks: [makeTask()] });
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		fireEvent.click(within(row).getByRole("button", { name: "Delete Morning storage brief" }));
		let dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Delete Morning storage brief?");
		expect(dialog.textContent).toContain("Its chat and the answers in it stay.");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(server.backend.requestsTo("DELETE", /scheduled-tasks/)).toHaveLength(0);
		expect(await rowOf("Morning storage brief")).toBeTruthy();

		fireEvent.click(within(row).getByRole("button", { name: "Delete Morning storage brief" }));
		dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete task" }));
		await screen.findByText("Deleted Morning storage brief. Its chat stays.");
		expect(server.backend.requestsTo("DELETE", /scheduled-tasks\/task_1$/)).toHaveLength(1);
		expect(screen.queryByRole("heading", { name: /Morning storage brief/ })).toBeNull();
	});

	it("shows a refused resume with its code and what to do", async () => {
		const server = createTasksServer({ tasks: [makeTask({ status: "paused", nextRunAt: null })] });
		server.backend.on(
			"PATCH",
			/scheduled-tasks\/task_1$/,
			() =>
				new Response(
					JSON.stringify({
						error: { code: "VALIDATION_FAILED", message: "too many tasks", detail: "TASKS_FULL" },
					}),
					{ status: 422, headers: { "Content-Type": "application/json" } },
				),
		);
		renderPage(server);
		const row = await rowOf("Morning storage brief");
		fireEvent.click(within(row).getByRole("button", { name: "Resume Morning storage brief" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("VALIDATION_FAILED");
		expect(document.body.textContent).toContain(
			"You have reached the limit of 10 active or 30 tasks in all. Pause or delete a task first.",
		);
	});
});
