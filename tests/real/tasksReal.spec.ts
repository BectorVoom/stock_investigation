import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
	agentSettingsResponseSchema,
	conversationListResponseSchema,
	homeDashboardResponseSchema,
	researchRunListResponseSchema,
} from "@research/contracts";
import { z } from "zod";
import { suiteRunnerSettings, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	type LaunchedService,
	launcherEnv,
	listScheduledTasks,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	stashMigrationsFrom,
	TestResources,
	utcSlotAhead,
} from "./helpers.ts";

/**
 * Scheduled tasks in the real development environment (ADR-0033, FR-021;
 * `bun run test:real`, no model quota). From a pristine copy, the real
 * `bun run dev` launcher with the real runner (Rust by default) on test
 * ports and throwaway directories:
 *
 * 1. Fresh state: no backend saved in Settings. A "Once" task created on the
 *    Tasks page 1–2 minutes ahead (UTC) fires by itself when the real
 *    runner's idle claim finds it due — nothing else can fire it — and is
 *    skipped as AGENT_NOT_CONFIGURED: the page shows the skip, its reason
 *    and the "Open Settings → AI agent" fix link, the task is completed and
 *    no run was queued in its chat. This proves migration 0010, the
 *    launcher, the runner's polling and the firing path on a fresh install.
 * 2. Upgraded state: a database at schema version 9 (migration 0010 and
 *    every later one moved out of the copy) holds a conversation and a saved
 *    Home dashboard; the restart applies 0010 onwards; the conversation survives, the tasks list answers
 *    200 and empty, and the Home dashboard keeps working when a Scheduled
 *    tasks widget is added (and a task is created from it).
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The suite's runner (RESEARCH_RUNNER, default rust), as the launcher starts it. */
const RUNNER = suiteRunnerSettings().RESEARCH_RUNNER === "rust" ? "rust" : "node";
const FRESH_VITE_PORT = 8913;
const FRESH_API_PORT = 8914;
const UPGRADE_VITE_PORT = 8915;
const UPGRADE_API_PORT = 8916;
const MIGRATION = "0010_scheduled_tasks.sql";
const SHOTS_DIR = join(REPO_ROOT, "test-results-real");
const ONCE_TITLE = "Real one-off energy check";
const QUESTION = "Which energy storage products could see demand growth over the next 5 years?";

let pristine: PristineCopy | null = null;
let runnerEnvFile = "";
let configRoot = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	configRoot = mkdtempSync(join(tmpdir(), "research-real-tasks-config-"));
	resources.add(() => rmSync(configRoot, { recursive: true, force: true }));
	// Test-owned runner settings (finding 5): nothing at all, so no backend
	// key or model choice can reach the runner from the owner's env file.
	runnerEnvFile = writeTestRunnerEnvFile(configRoot, {});
	mkdirSync(SHOTS_DIR, { recursive: true });
});

test.afterAll(() => resources.close());

/** One throwaway data + release set per test, so the two states never share a database. */
function throwawayDirs(label: string): { readonly dataDir: string; readonly extraRoot: string } {
	const dataDir = mkdtempSync(join(tmpdir(), `research-real-tasks-${label}-data-`));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	const extraRoot = mkdtempSync(join(tmpdir(), `research-real-tasks-${label}-extra-`));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	return { dataDir, extraRoot };
}

function devEnv(
	dirs: { readonly dataDir: string; readonly extraRoot: string },
	ports: { readonly vite: number; readonly api: number; readonly prod: number },
): Record<string, string> {
	return launcherEnv({
		dataDir: join(dirs.extraRoot, "prod-data"),
		devDataDir: dirs.dataDir,
		releaseDir: join(dirs.extraRoot, "release"),
		previousDir: join(dirs.extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(dirs.extraRoot, "scratch"),
		webOutDir: join(dirs.extraRoot, "web-out"),
		prodPort: String(ports.prod),
		devPort: String(ports.vite),
		devApiPort: String(ports.api),
	});
}

async function startDev(env: Record<string, string>): Promise<LaunchedService> {
	if (pristine === null) throw new Error("the pristine copy was not created");
	const launched = await startLauncher({ cwd: pristine.root, args: ["dev"], env });
	resources.add(async () => {
		await launched.stop();
	});
	return launched;
}

/** One API call, its answer parsed with the shared contract (a drift fails here, never a cast). */
async function api<S extends z.ZodType>(
	schema: S,
	apiOrigin: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<z.infer<S>> {
	const response = await fetch(`${apiOrigin}${path}`, {
		method,
		headers: ownerHeaders(apiOrigin),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return schema.parse(JSON.parse(text));
}

/** The one field this spec reads from a created conversation. */
const createdWorkspaceSchema = z.object({ workspaceId: z.string().min(1) });

/** What the backend did, printed while the launcher still runs (a failure needs evidence). */
async function dumpDiagnostics(label: string, apiOrigin: string, dataDir: string): Promise<void> {
	console.log(`--- tasks diagnostics: ${label} ---`);
	try {
		console.log(`tasks: ${JSON.stringify(await listScheduledTasks(apiOrigin))}`);
	} catch (error) {
		console.log(`tasks API failed: ${error instanceof Error ? error.message : "unknown"}`);
	}
	for (const name of ["runner.log", "server.log"]) {
		try {
			const log = readFileSync(join(dataDir, "logs", name), "utf8");
			console.log(`--- ${name} tail ---\n${log.split("\n").slice(-40).join("\n")}`);
		} catch (error) {
			console.log(`${name} unreadable: ${error instanceof Error ? error.message : "unknown"}`);
		}
	}
}

async function openTasksPage(page: Page, viteOrigin: string) {
	await page.goto(viteOrigin);
	await page.getByRole("link", { name: "Tasks", exact: true }).click();
	await expect(page).toHaveURL(/#\/tasks$/);
	const list = page.getByRole("region", { name: "Scheduled tasks" });
	await expect(list.getByRole("button", { name: "New task" })).toBeVisible({ timeout: 60_000 });
	return list;
}

test("fresh state: a Once task fires on the real runner's claim and is skipped without a backend", async ({
	browser,
}) => {
	test.setTimeout(600_000);
	const viteOrigin = `http://localhost:${FRESH_VITE_PORT}`;
	const apiOrigin = `http://localhost:${FRESH_API_PORT}`;
	const dirs = throwawayDirs("fresh");
	await startDev(devEnv(dirs, { vite: FRESH_VITE_PORT, api: FRESH_API_PORT, prod: 18982 }));
	// The real runner of this suite runs, and it is what will claim.
	const startedLine =
		readFileSync(join(dirs.dataDir, "logs", "runner.log"), "utf8")
			.split("\n")
			.find((line) => line.includes("runner_started")) ?? "";
	expect(startedLine).toContain(`"runtime":"${RUNNER}"`);

	// Fresh: nothing saved in Settings → AI agent, no task.
	const settings = await api(
		agentSettingsResponseSchema,
		apiOrigin,
		"GET",
		"/api/v1/settings/agent",
	);
	expect(settings.origin).toBe("defaults");
	expect(await listScheduledTasks(apiOrigin)).toEqual([]);

	// The browser lives in UTC, so the editor's default zone is UTC too.
	const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US" });
	resources.add(() => context.close());
	const page = await context.newPage();
	await page.setViewportSize({ width: 1440, height: 900 });
	try {
		const list = await openTasksPage(page, viteOrigin);
		await expect(list).toContainText("No scheduled tasks yet.");

		await list.getByRole("button", { name: "New task" }).click();
		const dialog = page.getByRole("dialog", { name: "New task" });
		await expect(dialog).toBeVisible();
		await dialog.getByLabel("Title").fill(ONCE_TITLE);
		await dialog.getByLabel("Question").fill(QUESTION);
		await dialog.getByLabel("Repeat").selectOption({ label: "Once" });
		const slot = utcSlotAhead(60_000);
		await dialog.getByLabel("Date").fill(slot.date);
		await dialog.getByLabel("Time", { exact: true }).fill(slot.time);
		await expect(dialog.getByLabel("Time zone")).toHaveValue("UTC");
		await dialog.getByRole("button", { name: "Create task" }).click();
		await expect(dialog).toBeHidden({ timeout: 30_000 });
		const row = page
			.getByRole("list", { name: "Your scheduled tasks" })
			.getByRole("article", { name: ONCE_TITLE });
		await expect(row).toBeVisible();
		await expect(row).toContainText(`Once on ${slot.date} at ${slot.time}`);
		await expect(row).toContainText("Not run yet");

		const [created] = await listScheduledTasks(apiOrigin);
		expect(created?.status).toBe("active");
		expect(created?.nextRunAt).toBe(slot.iso);

		// Nothing but the real runner's idle claims (≤ 15 s apart) can fire it.
		await expect
			.poll(
				async () => {
					const task = (await listScheduledTasks(apiOrigin)).find(
						(entry) => entry.title === ONCE_TITLE,
					);
					return task === undefined ? "missing" : `${task.status}/${task.lastSkip?.code ?? "none"}`;
				},
				{ timeout: slot.atMs - Date.now() + 180_000, intervals: [3_000] },
			)
			.toBe("completed/AGENT_NOT_CONFIGURED");
		const [skipped] = await listScheduledTasks(apiOrigin);
		if (skipped === undefined) throw new Error("the task vanished after firing");
		expect(skipped.nextRunAt).toBeNull();
		expect(skipped.lastRun).toBeNull();
		expect(skipped.lastSkip?.slotAt).toBe(slot.iso);
		// Skipped when a claim found it due: at or after its time.
		expect(Date.parse(skipped.lastSkip?.at ?? "")).toBeGreaterThanOrEqual(slot.atMs);
		// No run was queued in the task's chat.
		const runs = await api(
			researchRunListResponseSchema,
			apiOrigin,
			"GET",
			`/api/v1/research-runs?workspaceId=${encodeURIComponent(skipped.workspaceId)}`,
		);
		expect(runs.runs).toEqual([]);

		// The page (still open, polling) shows the skip, its reason and the fix link.
		await expect(row).toContainText("Completed", { timeout: 60_000 });
		const skipLine = row.locator('[data-field="task-skip"]');
		// "The run due <its time, in words> was skipped: <reason>" — the time
		// carries the slot's HH:MM (the browser and the task are both UTC).
		await expect(skipLine).toContainText("was skipped: no AI backend is saved in Settings.", {
			timeout: 60_000,
		});
		await expect(skipLine).toContainText(slot.time);
		await expect(skipLine).toContainText("Choose a backend in Settings → AI agent.");
		const fix = skipLine.getByRole("link", { name: "Open Settings → AI agent" });
		await expect(fix).toHaveAttribute("href", "#/settings/agent");
		await expect(row).toContainText("Not run yet");
		await row.scrollIntoViewIfNeeded();
		await page.screenshot({ path: join(SHOTS_DIR, "tasks-real-fresh-skipped-1440x900.png") });

		await fix.click();
		await expect(page).toHaveURL(/#\/settings\/agent$/);
		await expect(page.getByRole("region", { name: "AI agent" })).toBeVisible();
	} catch (error) {
		await dumpDiagnostics("fresh state", apiOrigin, dirs.dataDir);
		throw error;
	}
});

test("upgraded state: a version-9 database gains the tasks table and Home keeps working", async ({
	browser,
}) => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const viteOrigin = `http://localhost:${UPGRADE_VITE_PORT}`;
	const apiOrigin = `http://localhost:${UPGRADE_API_PORT}`;
	const dirs = throwawayDirs("upgrade");
	const env = devEnv(dirs, { vite: UPGRADE_VITE_PORT, api: UPGRADE_API_PORT, prod: 18981 });
	const migrationsDir = join(pristine.root, "infra", "migrations");
	const { restore } = stashMigrationsFrom(
		migrationsDir,
		MIGRATION,
		join(dirs.extraRoot, "migrations-stash"),
	);
	resources.add(restore);

	// Phase 1: schema version 9. A conversation and a saved Home dashboard.
	const before = await startDev(env);
	let savedWidgetIds: readonly string[] = [];
	try {
		const workspace = await api(createdWorkspaceSchema, apiOrigin, "POST", "/api/v1/workspaces", {
			title: "Upgrade probe",
		});
		const conversations = await api(
			conversationListResponseSchema,
			apiOrigin,
			"GET",
			"/api/v1/conversations",
		);
		expect(conversations.conversations.map((entry) => entry.workspaceId)).toContain(
			workspace.workspaceId,
		);
		const dashboard = await api(
			homeDashboardResponseSchema,
			apiOrigin,
			"GET",
			"/api/v1/home/dashboard",
		);
		expect(dashboard.origin).toBe("defaults");
		const saved = await api(
			homeDashboardResponseSchema,
			apiOrigin,
			"PUT",
			"/api/v1/home/dashboard",
			{
				dashboard: dashboard.dashboard,
				expectedVersion: dashboard.version,
			},
		);
		expect(saved.origin).toBe("saved");
		savedWidgetIds = dashboard.dashboard.widgets.map((widget) => widget.widgetId);
	} finally {
		await before.stop();
	}

	// Phase 2: the migration returns; the SAME data directory restarts at version 10.
	restore();
	await startDev(env);
	const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US" });
	resources.add(() => context.close());
	const page = await context.newPage();
	await page.setViewportSize({ width: 1440, height: 900 });
	try {
		const conversations = await api(
			conversationListResponseSchema,
			apiOrigin,
			"GET",
			"/api/v1/conversations",
		);
		expect(conversations.conversations.map((entry) => entry.title)).toContain("Upgrade probe");
		const listResponse = await fetch(`${apiOrigin}/api/v1/scheduled-tasks`, {
			headers: ownerHeaders(apiOrigin),
		});
		expect(listResponse.status).toBe(200);
		expect(await listScheduledTasks(apiOrigin)).toEqual([]);

		// Home: the saved dashboard loads, and a Scheduled tasks widget is added.
		await page.goto(`${viteOrigin}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		await page.getByRole("button", { name: "Add widget" }).click();
		await page.getByRole("menuitem", { name: "Scheduled tasks", exact: true }).click();
		const widget = page.locator('[data-widget-kind="scheduled-tasks"]');
		await expect(widget).toContainText(
			"No scheduled tasks yet. A task runs a research question on a schedule.",
			{ timeout: 60_000 },
		);
		// The add was saved, next to every widget the dashboard already had.
		await expect
			.poll(
				async () => {
					const current = await api(
						homeDashboardResponseSchema,
						apiOrigin,
						"GET",
						"/api/v1/home/dashboard",
					);
					const ids = current.dashboard.widgets.map((entry) => entry.widgetId);
					const kept = savedWidgetIds.every((id) => ids.includes(id));
					const added = current.dashboard.widgets.some((entry) => entry.type === "scheduled-tasks");
					return `${current.origin}/kept=${kept}/added=${added}`;
				},
				{ timeout: 30_000 },
			)
			.toBe("saved/kept=true/added=true");

		// The upgraded table takes writes: a daily task created from the widget.
		await widget.getByRole("button", { name: "New task" }).click();
		const dialog = page.getByRole("dialog", { name: "New task" });
		await dialog.getByLabel("Title").fill("Upgraded daily brief");
		await dialog.getByLabel("Question").fill(QUESTION);
		await dialog.getByLabel("Repeat").selectOption({ label: "Daily" });
		// Three hours ahead, so the daily slot never comes due during the spec.
		await dialog
			.getByLabel("Time", { exact: true })
			.fill(new Date(Date.now() + 3 * 3_600_000).toISOString().slice(11, 16));
		await dialog.getByRole("button", { name: "Create task" }).click();
		await expect(dialog).toBeHidden({ timeout: 30_000 });
		await expect(widget).toContainText("Upgraded daily brief", { timeout: 30_000 });
		await expect(widget).toContainText("Not run yet");
		const tasks = await listScheduledTasks(apiOrigin);
		expect(tasks.map((task) => `${task.title}/${task.status}`)).toEqual([
			"Upgraded daily brief/active",
		]);
		const after = await api(
			conversationListResponseSchema,
			apiOrigin,
			"GET",
			"/api/v1/conversations",
		);
		expect(after.conversations.map((entry) => entry.title).sort()).toEqual(
			["Upgrade probe", "Upgraded daily brief"].sort(),
		);

		// The widget is part of the stored dashboard: it survives a reload.
		await page.reload();
		await expect(page.locator('[data-widget-kind="scheduled-tasks"]')).toContainText(
			"Upgraded daily brief",
			{ timeout: 60_000 },
		);
		await page.locator('[data-widget-kind="scheduled-tasks"]').scrollIntoViewIfNeeded();
		await page.waitForTimeout(1_000);
		await page.screenshot({
			path: join(SHOTS_DIR, "tasks-real-upgrade-home-1440x900.png"),
			fullPage: true,
		});
	} catch (error) {
		await dumpDiagnostics("upgraded state", apiOrigin, dirs.dataDir);
		throw error;
	}
});
