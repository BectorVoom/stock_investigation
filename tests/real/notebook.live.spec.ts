import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { agentsResponseSchema } from "@research/contracts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	type LaunchedService,
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Positive path of the notebook assistant (ADR-0020) in the real
 * environment: `bun run dev` started from a pristine copy on test ports with
 * throwaway directories, the real runner under Node and the real OpenCode
 * backend with the owner's model. Opt-in like `live.spec.ts`
 * (`RUN_LIVE_OPENCODE=1`, `OPENCODE_MODEL`), because it spends plan quota.
 *
 * From fresh state: the backend is chosen in Settings, a new chat opens
 * Chat-first, the owner writes one text widget in the Notebook, selects it
 * and asks the assistant for a chart from its numbers; the assistant's turn
 * adds a chart widget. With the chart selected it is asked to make it large;
 * the turn resizes it, Undo restores it, and Notebook-first survives a
 * reload. A model reply that fails the protocol is a finding: the turn card
 * and the runner log are printed.
 *
 * Then the same chat's notebook is filled to 199 widgets of long notes, too
 * many to show in full: with nothing selected the prompt carries the first
 * widgets' content and only summary lines for the rest, and the assistant
 * still has to add an index naming the last three widgets.
 */
test.describe.configure({ mode: "serial" });

const LIVE = process.env.RUN_LIVE_OPENCODE === "1";
const MODEL = (process.env.OPENCODE_MODEL ?? "").trim();
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8911;
const API_PORT = 8912;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const NOTE =
	"Revenue was 10 million USD in 2022, 12 million USD in 2023 and 15 million USD in 2024.";

let pristine: PristineCopy | null = null;
let service: LaunchedService | null = null;
let dataDir = "";
let extraRoot = "";
let livePage: Page | null = null;
let failed = false;
const stoppers = new TestResources();
const cleaners = new TestResources();

function activePage(): Page {
	if (livePage === null) throw new Error("the live browser page was not created");
	return livePage;
}

function notebookWidgets(page: Page) {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

async function waitForRunnerWithModel(): Promise<void> {
	await expect
		.poll(
			async () => {
				const response = await fetch(`${API_ORIGIN}/api/v1/agents`, {
					headers: ownerHeaders(API_ORIGIN),
				});
				if (!response.ok) return [];
				const parsed = agentsResponseSchema.safeParse(await response.json());
				if (!parsed.success) return [];
				const opencode = parsed.data.agents.find((agent) => agent.agentId === "opencode");
				return opencode?.capabilities.models ?? [];
			},
			{ timeout: 180_000 },
		)
		.toContain(MODEL);
}

function dumpRunnerLog(label: string): void {
	try {
		const log = readFileSync(join(dataDir, "logs", "runner.log"), "utf8");
		console.log(`--- ${label}: runner.log tail ---\n${log.split("\n").slice(-30).join("\n")}`);
	} catch (error) {
		console.log(`runner log unreadable: ${error instanceof Error ? error.message : "unknown"}`);
	}
}

/**
 * Sends one instruction to the notebook assistant and waits for its turn
 * card; a run that fails instead stops the wait at once with its reason.
 */
async function instruct(page: Page, instruction: string): Promise<void> {
	const composer = page.getByRole("form", { name: "Notebook composer" });
	await composer.getByRole("textbox", { name: "Instruction" }).fill(instruction);
	const turns = page.locator("[data-notebook-turn]");
	const failures = page.getByRole("status").filter({ hasText: /^Failed:/ });
	const turnsBefore = await turns.count();
	const failuresBefore = await failures.count();
	await composer.getByRole("button", { name: "Send instruction" }).click();
	await expect
		.poll(
			async () => {
				if ((await failures.count()) > failuresBefore) return "failed";
				return (await turns.count()) > turnsBefore ? "turn" : "waiting";
			},
			{ timeout: 300_000, intervals: [1_000] },
		)
		.not.toBe("waiting");
	if ((await failures.count()) > failuresBefore) {
		dumpRunnerLog(`the run for "${instruction}" failed`);
		throw new Error(`the notebook-assist run failed: ${await failures.last().innerText()}`);
	}
	console.log(`turn for "${instruction}": ${await turns.last().innerText()}`);
}

test.describe("notebook assistant through the real backend (spends real quota)", () => {
	test.skip(!LIVE, "needs RUN_LIVE_OPENCODE=1 with OPENCODE_MODEL in the environment");

	test.beforeAll(async ({ browser }) => {
		if (MODEL === "") {
			throw new Error("RUN_LIVE_OPENCODE=1 requires OPENCODE_MODEL=provider/model");
		}
		test.setTimeout(300_000);
		pristine = makePristineCopy(REPO_ROOT);
		cleaners.add(() => pristine?.remove());
		dataDir = mkdtempSync(join(tmpdir(), "research-notebook-live-"));
		cleaners.add(() => rmSync(dataDir, { recursive: true, force: true }));
		extraRoot = mkdtempSync(join(tmpdir(), "research-notebook-live-extra-"));
		cleaners.add(() => rmSync(extraRoot, { recursive: true, force: true }));
		const runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
		const launched = await startLauncher({
			cwd: pristine.root,
			args: ["dev"],
			env: launcherEnv({
				dataDir: join(extraRoot, "prod-data"),
				devDataDir: dataDir,
				releaseDir: join(extraRoot, "release"),
				previousDir: join(extraRoot, "release.previous"),
				runnerEnvFile,
				scratchRoot: join(extraRoot, "scratch"),
				webOutDir: join(extraRoot, "web-out"),
				prodPort: "8910",
				devPort: String(VITE_PORT),
				devApiPort: String(API_PORT),
				extra: { OPENCODE_MODEL: MODEL },
			}),
		});
		service = launched;
		stoppers.add(async () => {
			await launched.stop();
		});
		livePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	});

	test.afterEach(() => {
		if (test.info().status === "failed") failed = true;
	});

	test.afterAll(async () => {
		if (livePage !== null) await livePage.close().catch(() => undefined);
		livePage = null;
		await stoppers.close();
		if (failed) {
			console.log(`live run failed: keeping ${dataDir} and ${extraRoot} for inspection`);
			return;
		}
		await cleaners.close();
	});

	test("fresh state: choose the backend, write a note, ask for a chart, resize it, undo", async () => {
		test.setTimeout(900_000);
		expect(service).not.toBeNull();
		const page = activePage();
		await waitForRunnerWithModel();

		// Settings → AI agent: the real backend and model, saved.
		await page.goto(`${VITE_ORIGIN}/#/settings`);
		const agentSection = page.getByRole("region", { name: "AI agent" });
		const backend = agentSection.getByLabel("Default backend");
		await expect(backend.locator("option", { hasText: "OpenCode" })).toHaveCount(1, {
			timeout: 30_000,
		});
		await backend.selectOption("opencode");
		const modelSelect = agentSection.getByLabel("Model for this backend");
		await expect
			.poll(
				async () =>
					modelSelect
						.locator("option")
						.evaluateAll((nodes) =>
							nodes.map((node) => (node instanceof HTMLOptionElement ? node.value : "")),
						),
				{ timeout: 60_000 },
			)
			.toContain(MODEL);
		await modelSelect.selectOption(MODEL);
		await agentSection.getByLabel("Effort").selectOption("low");
		const save = agentSection.getByRole("button", { name: "Save" });
		if (await save.isEnabled()) await save.click();
		await expect(agentSection).toContainText(/Saved /);

		// A new chat opens Chat-first.
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await page
			.getByRole("navigation", { name: "Chats" })
			.getByRole("button", { name: "New chat", exact: true })
			.click();
		await expect(page).toHaveURL(/#\/chat\/ws_/);
		const notebook = page.locator('div[data-panel="notebook"]');
		const chatBox = await page.locator('section[data-panel="chat"]').boundingBox();
		const notebookBox = await notebook.boundingBox();
		expect((chatBox?.width ?? 0) > (notebookBox?.width ?? 0) * 2).toBe(true);
		await page.screenshot({ path: test.info().outputPath("1-chat-first.png") });

		// The owner writes one text widget in the Notebook.
		await notebook.getByRole("button", { name: "Add widget" }).click();
		await page.getByRole("menuitem", { name: "Text" }).click();
		const editor = page.getByRole("dialog");
		await editor.getByLabel("Title").fill("Revenue note");
		await editor.getByLabel("Text", { exact: true }).fill(NOTE);
		await editor.getByRole("button", { name: "Save widget" }).click();
		await expect(notebookWidgets(page)).toHaveCount(1, { timeout: 15_000 });

		// Focus Notebook, select the note, ask for a chart from its numbers.
		await page.getByRole("button", { name: "Focus Notebook" }).first().click();
		const note = notebookWidgets(page).first();
		await note.getByRole("button", { name: "Select “Revenue note”" }).click();
		await expect(note).toHaveAttribute("data-widget-selected", "");
		await instruct(
			page,
			"Create a line chart widget titled Revenue from the numbers in the selected note, right after it.",
		);
		await expect(
			page.locator('div[data-panel="notebook"] article[data-widget-type="chart"]'),
		).toHaveCount(1);
		await page.screenshot({ path: test.info().outputPath("2-notebook-first-chart.png") });

		// Select the chart alone and ask for it to be large.
		const chart = page.locator('div[data-panel="notebook"] article[data-widget-type="chart"]');
		await chart.locator(".wg-title").click();
		await expect(chart).toHaveAttribute("data-widget-selected", "");
		const sizeBefore = (await chart.getAttribute("data-widget-size")) ?? "";
		await instruct(page, "Make this chart large.");
		await expect(chart).toHaveAttribute("data-widget-size", "large");
		expect(sizeBefore).not.toBe("large");

		// Undo restores the size the chart had.
		await page.locator("[data-notebook-turn]").last().getByRole("button", { name: "Undo" }).click();
		await expect(chart).toHaveAttribute("data-widget-size", sizeBefore);

		// Notebook-first and the widgets survive a reload.
		await page.reload();
		await expect(notebookWidgets(page)).toHaveCount(2, { timeout: 30_000 });
		const reloadedChat = await page.locator('section[data-panel="chat"]').boundingBox();
		const reloadedNotebook = await notebook.boundingBox();
		expect((reloadedNotebook?.width ?? 0) > (reloadedChat?.width ?? 0) * 2).toBe(true);
		await page.screenshot({ path: test.info().outputPath("3-after-reload.png") });
	});

	test("a large notebook with nothing selected: the assistant works from its summary index", async () => {
		test.setTimeout(900_000);
		const page = activePage();
		const workspaceId = /#\/chat\/([^/?]+)/.exec(page.url())?.[1];
		if (workspaceId === undefined) throw new Error(`no open chat in ${page.url()}`);
		const notebookUrl = `${API_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`;
		const read = await fetch(notebookUrl, { headers: ownerHeaders(API_ORIGIN) });
		expect(read.status).toBe(200);
		const stored = (await read.json()) as {
			notebook: { widgets: { widgetId: string }[] };
			version: number;
		};
		const now = new Date().toISOString();
		const fillerCount = 199 - stored.notebook.widgets.length;
		const filler = Array.from({ length: fillerCount }, (_, index) => ({
			widgetId: `nb_live_fill_${index}`,
			type: "text",
			title: `Note ${index + 1}`,
			size: "small",
			text: `Note ${index + 1}. ${"Inventory days fell while the order book grew. ".repeat(40)}`,
			createdAt: now,
			updatedAt: now,
			revision: 1,
			origin: { kind: "owner", messageId: null, runId: null, componentId: null },
		}));
		const saved = await fetch(notebookUrl, {
			method: "PUT",
			headers: ownerHeaders(API_ORIGIN),
			body: JSON.stringify({
				notebook: { widgets: [...stored.notebook.widgets, ...filler] },
				expectedVersion: stored.version,
			}),
		});
		expect(saved.status).toBe(200);

		// A reload clears the selection: the instruction is about the whole notebook.
		await page.reload();
		await expect(notebookWidgets(page)).toHaveCount(199, { timeout: 60_000 });
		const composer = page.getByRole("form", { name: "Notebook composer" });
		await expect(composer.getByText("About the whole notebook")).toBeVisible();
		const lastTitles = [fillerCount - 2, fillerCount - 1, fillerCount].map((n) => `Note ${n}`);
		await instruct(
			page,
			"Add one text widget titled Index at the end of the notebook. Its text lists the titles of the last three widgets currently in the notebook, one per line.",
		);
		await expect(notebookWidgets(page)).toHaveCount(200, { timeout: 30_000 });
		const index = notebookWidgets(page).last();
		await expect(index.locator(".wg-title")).toHaveText("Index");
		const indexText = await index.innerText();
		console.log(`index widget: ${indexText}`);
		for (const title of lastTitles) expect(indexText).toContain(title);
		await page.screenshot({ path: test.info().outputPath("4-large-notebook-index.png") });
	});
});
