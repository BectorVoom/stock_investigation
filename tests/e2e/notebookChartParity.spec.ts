import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_PORT, FEED_URL } from "./fixtures.ts";

/**
 * Chart parity between Chat previews and Notebook widgets (chart-parity task).
 *
 * In a chat with a research chart preview, Add to Notebook, then compare the
 * preview's chart svg and the Notebook widget's chart svg: viewBox, number of
 * `[data-bar]` marks and their `d` positions, and axis titles. Chrome only is
 * fine for this spec.
 */

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const consoleErrors: string[] = [];
const owner = `e2e-chart-parity-${Date.now()}@example.test`;

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

async function reviewShot(name: string): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	await page.screenshot({ path: test.info().outputPath(name) });
}

test("a research chart preview and its Notebook widget draw the same svg", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);

	await page.getByRole("link", { name: "Settings", exact: true }).click();
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

	await page.getByRole("link", { name: "Sources", exact: true }).click();
	await page.getByLabel("Feed or site URL").fill(FEED_URL);
	await page.getByRole("button", { name: "Preview source" }).click();
	const previewRegion = page.getByRole("region", { name: "Source preview" });
	await expect(previewRegion).toContainText("Example Energy News (synthetic)");
	await previewRegion.getByLabel("License policy").selectOption("short-excerpt-permitted");
	await previewRegion.getByRole("button", { name: "Subscribe to this source" }).click();
	await expect(page.getByRole("region", { name: "Subscribed sources" })).toContainText(
		"Example Energy News (synthetic)",
	);

	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");
	await composer.getByRole("button", { name: "Send question" }).click();

	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.locator('[data-run-state="completed"]')).toBeAttached({ timeout: 60_000 });
	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(conversation.locator('[data-component-type="bar-chart"]').first()).toBeVisible();

	const chartPreview = conversation
		.locator('[data-preview-component]:has([data-component-type="bar-chart"])')
		.first();
	const previewSvg = chartPreview.locator('svg[role="img"]').first();
	await expect(previewSvg).toBeVisible();
	await reviewShot("chart-preview.png");

	await chartPreview.getByRole("button", { name: "Add to Notebook" }).click();
	await expect(chartPreview.getByText("In notebook")).toBeVisible({ timeout: 15_000 });

	const notebook = page.getByRole("region", { name: "Notebook" });
	const widget = notebook.locator('article[data-widget-id] div[data-widget-body="chart"]').first();
	await expect(widget.locator('svg[role="img"]')).toBeVisible();
	await reviewShot("chart-notebook.png");

	const compared = await page.evaluate(() => {
		const preview = document.querySelector("[data-preview-component] svg[role='img']");
		const notebookWidget = document.querySelector(
			'div[data-panel="notebook"] div[data-widget-body="chart"] svg[role="img"]',
		);
		if (!(preview instanceof SVGSVGElement) || !(notebookWidget instanceof SVGSVGElement)) {
			return null;
		}
		const barsOf = (svg: SVGSVGElement) =>
			[...svg.querySelectorAll("path[data-bar]")].map((bar) => bar.getAttribute("d") ?? "");
		const axisTitle = (svg: SVGSVGElement, axis: string) =>
			svg.querySelector(`[data-axis-title="${axis}"]`)?.textContent ?? null;
		const yTicks = (svg: SVGSVGElement) =>
			[...svg.querySelectorAll('[data-chart-part="y-axis"] text')]
				.filter((element) => element.getAttribute("data-axis-title") === null)
				.map((element) => element.textContent ?? "");
		// ADR-0026: the provenance around the plot reads the same too.
		const provenance = (svg: SVGSVGElement) => {
			const figure = svg.closest("figure");
			return {
				basisNote: figure?.querySelector("[data-chart-basis-note]")?.textContent ?? null,
				sources: figure?.querySelector('section[aria-label="Sources"]')?.textContent ?? null,
				tableCells: [...(figure?.querySelectorAll("details td") ?? [])].map(
					(cell) => cell.textContent ?? "",
				),
			};
		};
		return {
			previewProvenance: provenance(preview),
			notebookProvenance: provenance(notebookWidget),
			previewViewBox: preview.getAttribute("viewBox"),
			notebookViewBox: notebookWidget.getAttribute("viewBox"),
			previewBars: barsOf(preview),
			notebookBars: barsOf(notebookWidget),
			previewXTitle: axisTitle(preview, "x"),
			notebookXTitle: axisTitle(notebookWidget, "x"),
			previewYTitle: axisTitle(preview, "y"),
			notebookYTitle: axisTitle(notebookWidget, "y"),
			previewYTicks: yTicks(preview),
			notebookYTicks: yTicks(notebookWidget),
			previewMarks: preview.querySelector('[data-chart-part="marks"]')?.innerHTML ?? "",
			notebookMarks: notebookWidget.querySelector('[data-chart-part="marks"]')?.innerHTML ?? "",
		};
	});
	if (compared === null) throw new Error("chart svgs missing for comparison");
	expect(compared.notebookViewBox).toBe(compared.previewViewBox);
	expect(compared.notebookBars).toEqual(compared.previewBars);
	expect(compared.notebookBars.length).toBeGreaterThan(0);
	expect(compared.notebookXTitle).toBe(compared.previewXTitle);
	expect(compared.notebookYTitle).toBe(compared.previewYTitle);
	expect(compared.notebookYTicks).toEqual(compared.previewYTicks);
	expect(compared.notebookMarks).toBe(compared.previewMarks);
	expect(compared.previewProvenance.basisNote).not.toBeNull();
	expect(compared.previewProvenance.sources).not.toBeNull();
	expect(compared.notebookProvenance).toEqual(compared.previewProvenance);

	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
