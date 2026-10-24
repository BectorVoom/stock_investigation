import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { scheduledTaskListResponseSchema } from "../../packages/contracts/src/scheduledTasks.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT, FEED_URL } from "./fixtures.ts";

/**
 * Scheduled tasks end to end (FR-021, ADR-0033): a task created on the Tasks
 * page, "Run now" through the REAL runner loop and the scripted agent, the
 * answer in the task's own chat, the Scheduled tasks widget on Home (pause
 * and resume from the widget), a one-off task that fires by itself when the
 * runner next claims work after its time, and delete keeping the chat. The
 * page runs under its Content-Security-Policy without errors.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness, so
 * its backend choice, source, tasks and run allowance never touch the other
 * specs, whatever the file order.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-tasks-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const DAILY_TITLE = "Morning storage brief";
const ONCE_TITLE = "One-off storage check";
const QUESTION = "Which storage products will see demand growth?";

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
	runner = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: {
			...baseChildEnv(),
			...suiteRunnerSettings(),
			E2E_PORT: String(E2E_PORT),
			E2E_RUNNER_OWNER: owner,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
});

test.afterAll(async () => {
	if (runner !== null && runner.exitCode === null) {
		const exited = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
		runner.kill("SIGTERM");
		await exited;
	}
	runner = null;
	await context.close();
});

/** Saves the scripted backend and subscribes the fixture feed, as this owner. */
async function setUpOwner(): Promise<void> {
	await page.goto("/#/settings/agent");
	const agentSection = page.getByRole("region", { name: "AI agent" });
	const backend = agentSection.getByLabel("Default backend");
	// Cold start: this file's harness may still be starting.
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 75_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	await agentSection.getByRole("button", { name: "Save" }).click();
	await expect(agentSection).toContainText(/Saved /);

	await page.getByRole("link", { name: "Sources", exact: true }).click();
	await page.getByLabel("Feed or site URL").fill(FEED_URL);
	await page.getByRole("button", { name: "Preview source" }).click();
	const preview = page.getByRole("region", { name: "Source preview" });
	await expect(preview).toContainText("Example Energy News (synthetic)");
	await preview.getByLabel("License policy").selectOption("short-excerpt-permitted");
	await preview.getByRole("button", { name: "Subscribe to this source" }).click();
	await expect(page.getByRole("region", { name: "Subscribed sources" })).toContainText(
		"Example Energy News (synthetic)",
	);
}

async function openTasksPage(): Promise<Locator> {
	await page.goto("/#/tasks");
	const list = page.getByRole("region", { name: "Scheduled tasks" });
	await expect(list.getByRole("button", { name: "New task" })).toBeVisible({ timeout: 30_000 });
	return list;
}

/** The task's row on the Tasks page. */
function taskRow(title: string): Locator {
	return page
		.getByRole("list", { name: "Your scheduled tasks" })
		.getByRole("article", { name: title });
}

async function listTasks() {
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/scheduled-tasks`);
	expect(response.status()).toBe(200);
	return scheduledTaskListResponseSchema.parse(await response.json()).tasks;
}

/** `HH:MM` and `YYYY-MM-DD` in UTC, `minutes` from now. */
function utcAhead(minutes: number): { readonly date: string; readonly time: string } {
	const iso = new Date(Date.now() + minutes * 60_000).toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

test("a task is created on the Tasks page with its own chat (FR-021)", async () => {
	test.setTimeout(150_000);
	await setUpOwner();
	const list = await openTasksPage();
	await list.getByRole("button", { name: "New task" }).click();
	const dialog = page.getByRole("dialog", { name: "New task" });
	await dialog.getByLabel("Title").fill(DAILY_TITLE);
	await dialog.getByLabel("Question").fill(QUESTION);
	await dialog.getByLabel("Repeat").selectOption({ label: "Daily" });
	// Three hours ahead in UTC, so the daily slot never comes due during the suite.
	await dialog.getByLabel("Time", { exact: true }).fill(utcAhead(180).time);
	await dialog.getByLabel("Time zone").fill("UTC");
	await dialog.getByRole("button", { name: "Create task" }).click();
	await expect(dialog).toBeHidden();

	const row = taskRow(DAILY_TITLE);
	await expect(row).toBeVisible();
	await expect(row).toContainText("Every day at");
	await expect(row).toContainText("Not run yet");
	const [task] = (await listTasks()).filter((entry) => entry.title === DAILY_TITLE);
	expect(task?.status).toBe("active");
	expect(task?.nextRunAt).not.toBeNull();
	expect(task?.lastRun).toBeNull();
});

test("Run now queues a run whose answer lands in the task's chat", async () => {
	await openTasksPage();
	const row = taskRow(DAILY_TITLE);
	await row.getByRole("button", { name: `Run ${DAILY_TITLE} now` }).click();
	await expect
		.poll(
			async () =>
				(await listTasks()).find((entry) => entry.title === DAILY_TITLE)?.lastRun?.state ?? null,
			{ timeout: 90_000, intervals: [1_000] },
		)
		.toBe("completed");
	// The schedule did not move: a run-now run has no slot.
	const task = (await listTasks()).find((entry) => entry.title === DAILY_TITLE);
	expect(task?.lastRun?.slotAt).toBeNull();

	await row.getByRole("link", { name: `Open the chat of ${DAILY_TITLE}` }).click();
	await expect(page).toHaveURL(new RegExp(`#/chat/${task?.workspaceId ?? "missing"}$`));
	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(conversation).toContainText(QUESTION, { timeout: 30_000 });
	await expect(conversation.getByRole("article", { name: "Assistant message" })).toContainText(
		"claim(s) are supported",
		{ timeout: 30_000 },
	);
});

test("the Scheduled tasks widget on Home shows the task and pauses and resumes it", async () => {
	await page.goto("/#/home");
	await page.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Scheduled tasks", exact: true }).click();
	const widget = page.getByRole("list", { name: "Your scheduled tasks" }).last();
	await expect(widget).toContainText(DAILY_TITLE, { timeout: 30_000 });

	await widget.getByRole("button", { name: `Pause ${DAILY_TITLE}` }).click();
	await expect
		.poll(async () => (await listTasks()).find((entry) => entry.title === DAILY_TITLE)?.status)
		.toBe("paused");
	await expect(widget.getByRole("button", { name: `Resume ${DAILY_TITLE}` })).toBeVisible();
	await widget.getByRole("button", { name: `Resume ${DAILY_TITLE}` }).click();
	await expect
		.poll(async () => (await listTasks()).find((entry) => entry.title === DAILY_TITLE)?.status)
		.toBe("active");

	// The widget survives a reload (it is part of the stored Home dashboard).
	await page.reload();
	await expect(page.getByRole("list", { name: "Your scheduled tasks" }).last()).toContainText(
		DAILY_TITLE,
		{ timeout: 30_000 },
	);
});

test("a one-off task fires by itself when the runner claims work after its time", async () => {
	test.setTimeout(240_000);
	const list = await openTasksPage();
	await list.getByRole("button", { name: "New task" }).click();
	const dialog = page.getByRole("dialog", { name: "New task" });
	await dialog.getByLabel("Title").fill(ONCE_TITLE);
	await dialog.getByLabel("Question").fill(QUESTION);
	await dialog.getByLabel("Repeat").selectOption({ label: "Once" });
	// The next whole minute that is at least 30 s away, so creating it never races its time.
	const at = utcAhead(Date.now() % 60_000 > 30_000 ? 2 : 1);
	await dialog.getByLabel("Date").fill(at.date);
	await dialog.getByLabel("Time", { exact: true }).fill(at.time);
	await dialog.getByLabel("Time zone").fill("UTC");
	await dialog.getByRole("button", { name: "Create task" }).click();
	await expect(dialog).toBeHidden();

	// Nothing but the runner's idle claims (≤ 15 s apart) can fire it.
	await expect
		.poll(
			async () => {
				const task = (await listTasks()).find((entry) => entry.title === ONCE_TITLE);
				return task === undefined ? null : `${task.status}/${task.lastRun?.state ?? "none"}`;
			},
			{ timeout: 210_000, intervals: [2_000] },
		)
		.toBe("completed/completed");
	const task = (await listTasks()).find((entry) => entry.title === ONCE_TITLE);
	expect(task?.nextRunAt).toBeNull();
	expect(task?.lastRun?.slotAt).toBe(`${at.date}T${at.time}:00.000Z`);
	await expect(taskRow(ONCE_TITLE)).toContainText("Completed", { timeout: 40_000 });
});

test("deleting a task asks first and keeps its chat", async () => {
	await openTasksPage();
	const workspaceId = (await listTasks()).find((entry) => entry.title === ONCE_TITLE)?.workspaceId;
	await taskRow(ONCE_TITLE)
		.getByRole("button", { name: `Delete ${ONCE_TITLE}` })
		.click();
	const confirm = page.getByRole("dialog", { name: `Delete ${ONCE_TITLE}?` });
	await confirm.getByRole("button", { name: "Delete task" }).click();
	await expect(taskRow(ONCE_TITLE)).toHaveCount(0);
	expect((await listTasks()).some((entry) => entry.title === ONCE_TITLE)).toBe(false);

	const chat = await page.request.get(`${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}`);
	expect(chat.status()).toBe(200);
});

test("the Tasks page ran under its Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
