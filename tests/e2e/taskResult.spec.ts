import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "../../packages/contracts/src/home.ts";
import {
	scheduledTaskListResponseSchema,
	taskResultResponseSchema,
} from "../../packages/contracts/src/scheduledTasks.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT, FEED_URL } from "./fixtures.ts";

/**
 * The Task result widget end to end (ADR-0038): a task created on the Tasks
 * page, a Task result widget placed on Home from the add menu's task dialog
 * (no answer yet), Run now from the widget through the REAL runner loop and
 * the scripted agent, the answer and its status line arriving in the widget
 * through the real `GET /scheduled-tasks/:id/result`, and Show result on
 * Home from the Tasks page (added, then "already on Home"). The pages run
 * under their Content-Security-Policy without errors.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness, so
 * its backend choice, tasks and Home dashboard never touch the other specs.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-task-result-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const FIRST_TITLE = "Storage demand brief";
const SECOND_TITLE = "Chip supply check";
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

/** `HH:MM` in UTC, `minutes` from now: a daily slot that never comes due during the suite. */
function utcTimeAhead(minutes: number): string {
	return new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16);
}

async function createDailyTask(title: string): Promise<void> {
	const list = await openTasksPage();
	await list.getByRole("button", { name: "New task" }).click();
	const dialog = page.getByRole("dialog", { name: "New task" });
	await dialog.getByLabel("Title").fill(title);
	await dialog.getByLabel("Question").fill(QUESTION);
	await dialog.getByLabel("Repeat").selectOption({ label: "Daily" });
	await dialog.getByLabel("Time", { exact: true }).fill(utcTimeAhead(180));
	await dialog.getByLabel("Time zone").fill("UTC");
	await dialog.getByRole("button", { name: "Create task" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("list", { name: "Your scheduled tasks" }).getByRole("article", { name: title }),
	).toBeVisible();
}

async function taskIdOf(title: string): Promise<string> {
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/scheduled-tasks`);
	expect(response.status()).toBe(200);
	const { tasks } = scheduledTaskListResponseSchema.parse(await response.json());
	const task = tasks.find((entry) => entry.title === title);
	if (task === undefined) throw new Error(`no task named ${title}`);
	return task.taskId;
}

/** The Task result widget of a task on the page. */
function resultWidget(taskId: string): Locator {
	return page.locator(`[data-widget-kind="task-result"][data-task-id="${taskId}"]`);
}

async function homeTaskResultIds(): Promise<string[]> {
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	expect(response.status()).toBe(200);
	const { dashboard } = homeDashboardResponseSchema.parse(await response.json());
	return dashboard.widgets.flatMap((widget) =>
		widget.type === "task-result" ? [widget.taskId] : [],
	);
}

test("a Task result widget is placed on Home from the add menu's task dialog", async () => {
	test.setTimeout(150_000);
	await setUpOwner();
	await createDailyTask(FIRST_TITLE);
	const taskId = await taskIdOf(FIRST_TITLE);

	await page.goto("/#/home");
	const add = page.getByRole("button", { name: "Add widget" });
	await expect(add).toBeEnabled({ timeout: 30_000 });
	await add.click();
	await page.getByRole("menuitem", { name: "Task result", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Choose a task" });
	const choice = dialog
		.getByRole("list", { name: "Your scheduled tasks" })
		.getByRole("button", { name: new RegExp(FIRST_TITLE) });
	await expect(choice).toContainText("Every day at");
	await choice.click();
	await expect(dialog).toBeHidden();

	const widget = resultWidget(taskId);
	await expect(widget).toContainText(FIRST_TITLE, { timeout: 30_000 });
	await expect(widget).toContainText("No result yet.");
	await expect(widget).toContainText("Next run in");
	expect(await homeTaskResultIds()).toEqual([taskId]);
});

test("Run now from the widget brings the run's answer and its status line into it", async () => {
	test.setTimeout(150_000);
	const taskId = await taskIdOf(FIRST_TITLE);
	const widget = resultWidget(taskId);
	await widget.getByRole("button", { name: `Run ${FIRST_TITLE} now` }).click();
	await expect(widget).toContainText(/Queued a run of/);

	// The shared list polls every 5 s while the run is unfinished; once it
	// shows the run ended, the widget reads the answer through the real route.
	const answer = widget.locator('[data-field="task-result-text"]');
	await expect(answer).toContainText("claim(s) are supported", { timeout: 120_000 });
	const status = widget.locator('[data-field="task-result-status"]');
	await expect(status).toContainText(/Answered (just now|1 min ago)/);
	await expect(status.locator("[data-verification-status]")).toHaveCount(1);

	// The route the widget read is the API's own answer, the same text.
	const response = await page.request.get(`${E2E_ORIGIN}/api/v1/scheduled-tasks/${taskId}/result`);
	expect(response.status()).toBe(200);
	const { result } = taskResultResponseSchema.parse(await response.json());
	expect(result?.text).toContain("claim(s) are supported");
	// Plain text, as stored: the clamp only hides lines, it never cuts the text.
	expect(await answer.textContent()).toBe(result?.text);
	// A Medium frame (560 px) holds far more than the fallback ten lines:
	// the clamp follows the frame's height, so the answer fills it.
	const clamp = await answer.evaluate((element) =>
		Number(getComputedStyle(element).getPropertyValue("-webkit-line-clamp")),
	);
	expect(clamp).toBeGreaterThan(14);

	await widget.getByRole("link", { name: `Open the chat of ${FIRST_TITLE}` }).click();
	await expect(page).toHaveURL(/#\/chat\//);
	await expect(page.getByRole("region", { name: "Conversation" })).toContainText(QUESTION, {
		timeout: 30_000,
	});
});

test("Show result on Home on the Tasks page adds a widget, then says it is already there", async () => {
	test.setTimeout(120_000);
	await createDailyTask(SECOND_TITLE);
	const secondId = await taskIdOf(SECOND_TITLE);
	const firstId = await taskIdOf(FIRST_TITLE);

	const show = page.getByRole("button", { name: `Show the result of ${SECOND_TITLE} on Home` });
	await show.click();
	await expect(page.getByText(`Added the result of ${SECOND_TITLE} to Home.`)).toBeVisible();
	expect(await homeTaskResultIds()).toEqual([firstId, secondId]);

	await show.click();
	await expect(page.getByText(`Already on Home: the result of ${SECOND_TITLE}.`)).toBeVisible();
	await page.getByRole("button", { name: `Show the result of ${FIRST_TITLE} on Home` }).click();
	await expect(page.getByText(`Already on Home: the result of ${FIRST_TITLE}.`)).toBeVisible();
	expect(await homeTaskResultIds()).toEqual([firstId, secondId]);

	await page.goto("/#/home");
	await expect(resultWidget(secondId)).toContainText("No result yet.", { timeout: 30_000 });
	await expect(resultWidget(firstId).locator('[data-field="task-result-text"]')).toContainText(
		"claim(s) are supported",
	);
});

test("the pages ran under their Content-Security-Policy without errors", async () => {
	expect(consoleErrors).toEqual([]);
});
