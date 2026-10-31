import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";

/**
 * The notebook assistant makes market charts (ADR-0021): from a new chat in
 * Chat-first with nothing selected, an instruction naming the Notebook is
 * routed to the notebook assistant (not Research), and the gold instruction
 * adds a `line-chart` naming the gold series instead of invented numbers.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with the scripted backend, like
 * `notebook.spec.ts`: `E2E_BROWSER=chrome bunx playwright test -c
 * tests/e2e/playwright.config.ts notebookAssistantGold`.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const consoleErrors: string[] = [];
// Isolated owner: this file's Settings and chats are its own, whatever the
// file order. Runner status is owner-scoped, so the spec brings its own
// harness loop reporting as this owner (see `E2E_RUNNER_OWNER`).
const owner = `e2e-notebook-gold-${Date.now()}@example.test`;

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

/**
 * A screenshot for reading the layout, taken on Chromium only: Playwright's
 * WebKit screenshot injects a <style> the app's CSP refuses, which would be
 * logged as a console error that this spec rightly fails on.
 */
async function reviewShot(name: string): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	await page.screenshot({ path: test.info().outputPath(name) });
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookWidgets() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

test("a new chat opens Chat-first with Chat wider than the Notebook", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	await expect(
		page.getByRole("heading", { level: 3, name: "What would you like to research?" }),
	).toBeVisible();
});

test("the owner chooses the scripted backend", async () => {
	await page.locator('[data-field="session-owner-link"]').click();
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible();
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 75_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	const model = agentSection.getByLabel("Model for this backend");
	await expect(model.locator("option", { hasText: "scripted/alpha" })).toHaveCount(1);
	await model.selectOption("scripted/alpha");
	const save = agentSection.getByRole("button", { name: "Save" });
	if (await save.isEnabled()) await save.click();
	await expect(agentSection).toContainText(/Saved /);
});

test("a gold instruction names the Notebook before sending and adds a market chart", async () => {
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	// Chat-first with nothing selected: the composer targets Research.
	const research = page.getByRole("form", { name: "Research composer" });
	await expect(research.getByRole("button", { name: "Leave Notebook mode" })).toHaveCount(0);
	await research.getByRole("button", { name: "Choose mode" }).click();
	const modeMenu = page.getByRole("menu", { name: "Composer mode" });
	await expect(modeMenu.getByRole("menuitemradio", { name: "Research" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(modeMenu.getByRole("menuitemradio", { name: "Notebook" })).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await page.keyboard.press("Escape");
	await research
		.getByRole("textbox", { name: "Question" })
		.fill("Create a chart of gold prices over the past year in the Notebook");
	// The draft names the notebook, so the menu routes to the notebook
	// assistant live, before anything is sent.
	const notebookComposer = page.getByRole("form", { name: "Notebook composer" });
	await expect(notebookComposer.getByRole("button", { name: "Leave Notebook mode" })).toBeVisible();
	await notebookComposer.getByRole("button", { name: "Choose mode" }).click();
	await expect(modeMenu.getByRole("menuitemradio", { name: "Notebook" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.keyboard.press("Escape");
	await notebookComposer.getByRole("button", { name: "Send instruction" }).click();

	// The turn adds one widget: a line-chart frame in the Notebook panel,
	// and the turn card says it was added.
	const widgets = notebookWidgets();
	await expect(widgets).toHaveCount(1, { timeout: 60_000 });
	await expect(widgets.first()).toHaveAttribute("data-widget-type", "line-chart");
	const turn = page.locator("[data-notebook-turn]");
	await expect(turn).toContainText(/added/i, { timeout: 60_000 });
	await reviewShot("gold-chart.png");

	// The stored notebook names the gold series and range: no invented numbers.
	const workspaceId = /#\/(?:chat|canvas|workspace)\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	expect(workspaceId).toMatch(/^ws_/);
	const read = await page.request.get(`${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		notebook: {
			widgets: {
				widgetId: string;
				type: string;
				seriesIds?: readonly string[];
				range?: string;
			}[];
		};
	};
	const chart = stored.notebook.widgets.find((widget) => widget.type === "line-chart");
	expect(chart?.seriesIds).toEqual(["twelve-data:XAU/USD"]);
	expect(chart?.range).toBe("1y");

	// The owner's own words named neither the notebook nor a widget ("Please
	// create gold chart." went to Research and failed): a request to create
	// a chart routes to the notebook assistant too.
	const draftBox = page.getByRole("textbox", { name: /Question|Instruction/ });
	await draftBox.fill("");
	await expect(page.getByRole("form", { name: "Research composer" })).toBeVisible();
	await expect(
		page
			.getByRole("form", { name: "Research composer" })
			.getByRole("button", { name: "Leave Notebook mode" }),
	).toHaveCount(0);
	await page.getByRole("textbox", { name: "Question" }).fill("Please create gold chart.");
	await expect(notebookComposer.getByRole("button", { name: "Leave Notebook mode" })).toBeVisible();
	await notebookComposer.getByRole("button", { name: "Send instruction" }).click();
	await expect(widgets).toHaveCount(2, { timeout: 60_000 });
	await expect(widgets.nth(1)).toHaveAttribute("data-widget-type", "line-chart");

	// Console errors exclude the expected error paths (422/403).
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
