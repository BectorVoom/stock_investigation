import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { baseChildEnv } from "../../scripts/testEnv.ts";
import { FEED_URL, HEADLINE } from "./fixtures.ts";

/**
 * Two-state workspace and Chat ↔ Notebook integration (task D2, ADR-0020).
 *
 * Runs as an isolated owner (`X-E2E-Owner`) so its backend choice, source
 * subscription and chats never disturb the other specs whatever the file
 * order. It sets up its own scripted backend and fixture source, like
 * `research.spec.ts` does for the default owner.
 *
 * Contract coverage: open a new chat → Chat-first; research with the
 * scripted backend; "Add to Notebook" for one chart and the answer; Focus
 * Notebook → Notebook-first with thread and draft intact; reload → still
 * Notebook-first; drag a widget (order kept across reload); size through
 * the menu (`data-widget-size` persists); select the chart and drive the
 * scripted notebook assistant ("make it larger" resizes, turn card shows
 * "resized", Undo restores; "explain this" adds a text widget after the
 * selection; "remove it" proposes, Remove deletes); Focus Chat →
 * Chat-first with all history intact.
 *
 * The scripted agent's notebook behaviour (task C) answers by the first
 * matching keyword: `chart` adds a line chart "Revenue", `larger` resizes
 * the selection to large, `explain` adds a text widget "Explanation" after
 * the first selected, `bar` sets selected charts to bar, `duplicate`
 * duplicates the selection, `remove` proposes removing the selection,
 * otherwise "Noted." with no change.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const consoleErrors: string[] = [];
// Isolated owner: this file's Settings, Sources, chats and jobs are its own,
// whatever the file order. Runner status is owner-scoped, so the spec brings
// its own harness loop reporting as this owner (see `E2E_RUNNER_OWNER`).
const owner = `e2e-notebook-${Date.now()}@example.test`;

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
			E2E_PORT: process.env.E2E_PORT ?? "8799",
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

async function panelWidths(): Promise<{ readonly chat: number; readonly notebook: number }> {
	const chatBox = await page.locator('section[data-panel="chat"]').boundingBox();
	const notebookBox = await page.locator('div[data-panel="notebook"]').boundingBox();
	if (chatBox === null || notebookBox === null) throw new Error("workspace panels missing");
	return { chat: chatBox.width, notebook: notebookBox.width };
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookWidgets() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

/**
 * Waits until the dominant panel is more than twice the other: the switch
 * animates `grid-template-columns`, so a measurement right after the click
 * sees the old proportions.
 */
async function expectDominant(panel: "chat" | "notebook"): Promise<void> {
	await expect
		.poll(async () => {
			const widths = await panelWidths();
			return panel === "chat"
				? widths.chat > widths.notebook * 2
				: widths.notebook > widths.chat * 2;
		})
		.toBe(true);
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
	await expectDominant("chat");
});

test("the scripted runner backend registers", async () => {
	// Cold-start tolerance: in a full-suite run the runner reported long ago
	// (earlier specs); standalone this file runs first and the harness may
	// still be starting. The settings UI below needs the same option.
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible();
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 75_000,
	});
});

test("the owner chooses the scripted backend and subscribes the fixture source", async () => {
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible();
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 30_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	const model = agentSection.getByLabel("Model for this backend");
	await expect(model.locator("option", { hasText: "scripted/alpha" })).toHaveCount(1);
	await model.selectOption("scripted/alpha");
	const save = agentSection.getByRole("button", { name: "Save" });
	if (await save.isEnabled()) await save.click();
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
});

test("a research run renders its results in the thread with Add to Notebook actions", async () => {
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const workspaceId = /#\/(?:chat|canvas|workspace)\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	expect(workspaceId).toMatch(/^ws_/);
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");
	await composer.getByRole("button", { name: "Send question" }).click();

	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.locator('[data-run-state="completed"]')).toBeAttached({ timeout: 60_000 });
	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(conversation.getByRole("article", { name: "Assistant message" })).toContainText(
		"1 of 2 claim(s) are supported",
	);
	for (const type of ["research-report", "source-list", "data-table", "bar-chart"]) {
		await expect(conversation.locator(`[data-component-type="${type}"]`).first()).toBeVisible();
	}
	// First notebook step: every preview and the answer offer one save.
	await expect(conversation.getByRole("button", { name: "Add to Notebook" }).first()).toBeVisible();
});

test("Add to Notebook saves one chart and the answer", async () => {
	const conversation = page.getByRole("region", { name: "Conversation" });
	const chartPreview = conversation
		.locator('[data-preview-component]:has([data-component-type="bar-chart"])')
		.first();
	await chartPreview.getByRole("button", { name: "Add to Notebook" }).click();
	await expect(chartPreview.getByText("In notebook")).toBeVisible({ timeout: 15_000 });

	const answer = conversation.getByRole("article", { name: "Assistant message" }).first();
	await answer.getByRole("button", { name: "Add to Notebook" }).click();
	await expect(answer.getByText("In notebook")).toBeVisible({ timeout: 15_000 });

	const notebook = page.getByRole("region", { name: "Notebook" });
	await expect(notebook).toContainText(HEADLINE);
	// The package stylesheet is loaded on this page: the Notebook is a real
	// grid and its frames and the thread previews are styled frames.
	const layout = await page.evaluate(() => {
		const grid = document.querySelector('div[data-panel="notebook"] [data-widget-grid]');
		const frame = document.querySelector('div[data-panel="notebook"] article[data-widget-id]');
		const header = frame?.querySelector("[data-widget-drag-handle]") ?? null;
		const preview = document.querySelector("[data-preview-component] article[data-widget-id]");
		const style = (element: Element | null) =>
			element === null ? null : getComputedStyle(element);
		return {
			grid: style(grid)?.display ?? null,
			header: style(header)?.display ?? null,
			frame: style(frame)?.flexDirection ?? null,
			preview: style(preview)?.flexDirection ?? null,
		};
	});
	await page.screenshot({ path: test.info().outputPath("chat-first.png") });
	expect(layout).toEqual({
		grid: "grid",
		header: "flex",
		frame: "column",
		preview: "column",
	});
});

test("Focus Notebook switches to Notebook-first with thread and draft intact", async () => {
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer.getByRole("textbox", { name: "Question" }).fill("draft that must survive");
	await page.getByRole("button", { name: "Focus Notebook" }).first().click();
	await expectDominant("notebook");
	await expect(page.getByRole("button", { name: "Focus Notebook" }).first()).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// The thread and the draft are still there: the switch re-created nothing.
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.getByRole("article", { name: "Your message" })).toContainText(
		"Which storage products will see demand growth?",
	);
	// Notebook-first targets the notebook assistant by default; the draft moves with it.
	await expect(
		page
			.getByRole("form", { name: "Notebook composer" })
			.getByRole("textbox", { name: "Instruction" }),
	).toHaveValue("draft that must survive");
});

test("a reload keeps Notebook-first", async () => {
	await page.reload();
	await expect(page.getByRole("region", { name: "Notebook" })).toBeVisible();
	await expectDominant("notebook");
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.getByRole("article", { name: "Your message" }).first()).toBeVisible();
});

test("a dragged widget keeps its new position across a reload", async () => {
	const widgets = notebookWidgets();
	await expect(widgets).toHaveCount(2, { timeout: 15_000 });
	const before = await widgets.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	// The whole header strip is the drag handle (the actions button never
	// starts a drag): press, move past the second widget, drop.
	const handle = widgets.first().locator("[data-widget-drag-handle]");
	const handleBox = await handle.boundingBox();
	const targetBox = await widgets.nth(1).boundingBox();
	if (handleBox === null || targetBox === null) throw new Error("widget boxes missing");
	await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
	await page.mouse.down();
	// Onto the far half of the second widget, whether the grid places it
	// beside the first (wide container) or below it (narrow container).
	await page.mouse.move(targetBox.x + targetBox.width * 0.8, targetBox.y + targetBox.height * 0.8, {
		steps: 25,
	});
	await page.mouse.up();
	const moved = await widgets.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	expect(moved).not.toEqual(before);
	await page.reload();
	await expect(notebookWidgets().first()).toBeVisible();
	await expect(
		notebookWidgets().evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-widget-id")),
		),
	).resolves.toEqual(moved);
});

test("a size change through the menu persists", async () => {
	const chart = notebookWidgets().first();
	await chart.locator("button[data-widget-actions]").click();
	await page.getByRole("menuitem", { name: "Small" }).click();
	await expect(chart).toHaveAttribute("data-widget-size", "small");
	await page.reload();
	await expect(notebookWidgets().first()).toHaveAttribute("data-widget-size", "small");
});

test("selecting the chart targets the notebook assistant; larger resizes with Undo", async () => {
	// A click on the header strip (not the actions button) selects the widget alone.
	const chart = notebookWidgets().first();
	await chart.locator(".wg-title").click();
	const notebookComposer = page.getByRole("form", { name: "Notebook composer" });
	await expect(notebookComposer).toBeVisible();
	await expect(notebookComposer.getByRole("list", { name: "Selected widgets" })).toBeVisible();
	await notebookComposer.getByRole("textbox", { name: "Instruction" }).fill("make it larger");
	await notebookComposer.getByRole("button", { name: "Send instruction" }).click();

	// The assistant resized the selection: the turn card says so.
	const turn = page.locator("[data-notebook-turn]");
	await expect(turn).toContainText(/resized/i, { timeout: 60_000 });
	await expect(chart).toHaveAttribute("data-widget-size", "large");
	// Undo restores the size.
	await turn.getByRole("button", { name: "Undo" }).click();
	await expect(chart).not.toHaveAttribute("data-widget-size", "large");
});

test("explain adds a text widget after the selection; remove proposes and Remove deletes", async () => {
	const notebookComposer = page.getByRole("form", { name: "Notebook composer" });
	await notebookComposer.getByRole("textbox", { name: "Instruction" }).fill("explain this");
	await notebookComposer.getByRole("button", { name: "Send instruction" }).click();
	const widgets = notebookWidgets();
	await expect(widgets).toHaveCount(3, { timeout: 60_000 });
	await expect(widgets.nth(1)).toContainText("Explanation");
	await page.screenshot({ path: test.info().outputPath("notebook-first.png") });

	await notebookComposer.getByRole("textbox", { name: "Instruction" }).fill("remove it");
	await notebookComposer.getByRole("button", { name: "Send instruction" }).click();
	const turn = page.locator("[data-notebook-turn]").last();
	await expect(turn.getByText(/Remove “.*”?/)).toBeVisible({ timeout: 60_000 });
	await turn.getByRole("button", { name: "Remove" }).click();
	await expect(widgets).toHaveCount(2);
});

test("Focus Chat returns to Chat-first with all history intact", async () => {
	await page.getByRole("button", { name: "Focus Chat" }).first().click();
	await expectDominant("chat");
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.getByRole("article", { name: "Your message" }).first()).toContainText(
		"Which storage products will see demand growth?",
	);
	await expect(thread.getByRole("article", { name: "Assistant message" }).first()).toContainText(
		"1 of 2 claim(s) are supported",
	);
	// Console errors exclude the expected error paths (422/403).
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
