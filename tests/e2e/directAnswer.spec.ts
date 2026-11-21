import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { DIRECT_ANSWER_TEXT } from "./e2eScriptedAgent.ts";
import { E2E_PORT } from "./fixtures.ts";

/**
 * A question that needs no research is answered directly (ADR-0079), end to
 * end through the REAL runner loop and the scripted agent: the planner says
 * no research is needed, the answer arrives as plain text ending with the
 * pipeline's "not researched" note, its flow diagram renders under it as an
 * ordered list with the basis caption, it can be added to the Notebook, and
 * it fits a phone-width screen. No tool runs and no citation chip appears.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness, so
 * its backend choice and chats never touch the other specs.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-direct-answer-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const QUESTION = "バックグラインド、ダイシング、モールディングを図で説明してください。";
const NOTE =
	"この回答は調査を行わず、AI モデルの一般知識から書かれています。出典との照合は行っていません。投資助言ではありません。";

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

test("a diagram question is answered directly with a flow diagram, not researched", async ({
	browserName,
}) => {
	test.setTimeout(150_000);
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

	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer.getByRole("textbox", { name: "Question" }).fill(QUESTION);
	await composer.getByRole("button", { name: "Send question" }).click();

	const thread = page.getByRole("list", { name: "Messages" });
	const answer = thread.getByRole("article", { name: "Assistant message" });
	await expect(answer).toContainText(DIRECT_ANSWER_TEXT, { timeout: 60_000 });
	await expect(answer).toContainText(NOTE);
	await expect(answer).not.toContainText("claim(s) are supported");
	await expect(thread.locator("[data-citation-chip]")).toHaveCount(0);

	const preview = thread.locator('[data-preview-component]:has([data-flow-diagram="true"])');
	const diagram = preview.locator("[data-flow-diagram]");
	await expect(diagram).toBeVisible();
	await expect(diagram.getByRole("heading", { name: "半導体後工程の流れ" })).toBeVisible();
	const stages = diagram.getByRole("listitem");
	await expect(stages).toHaveCount(3);
	await expect(stages.nth(0)).toHaveAccessibleName("Stage 1 of 3");
	await expect(stages.nth(2)).toContainText("モールディング");
	await expect(diagram.locator("figcaption")).toHaveText(
		"Written by AI from general knowledge — not researched or checked against sources",
	);
	await expect(preview.locator("[data-fallback]")).toHaveCount(0);

	// The diagram is saved into the Notebook like any other result.
	await preview.getByRole("button", { name: "Add to Notebook" }).click();
	await expect(preview.getByText("In notebook")).toBeVisible({ timeout: 15_000 });
	const saved = page.locator('div[data-panel="notebook"] [data-flow-diagram]');
	await expect(saved).toBeVisible();
	await expect(saved.getByRole("listitem")).toHaveCount(3);

	// Phone width: every stage card stays inside the diagram, nothing scrolls sideways.
	await page.setViewportSize({ width: 390, height: 844 });
	await diagram.scrollIntoViewIfNeeded();
	const fits = await diagram.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return [...element.querySelectorAll("li > div")].every((card) => {
			const cardBox = card.getBoundingClientRect();
			return cardBox.left >= box.left - 0.5 && cardBox.right <= box.right + 0.5;
		});
	});
	expect(fits).toBe(true);
	expect(await diagram.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
		true,
	);
	expect(consoleErrors).toEqual([]);
	// WebKit's screenshot injects a <style> the app's CSP refuses, so it is
	// taken on Chromium only and after the console check.
	if (browserName !== "webkit") {
		await page.screenshot({ path: test.info().outputPath("direct-answer-phone.png") });
	}
});
