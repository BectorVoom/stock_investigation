import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
	agentsResponseSchema,
	articleListResponseSchema,
	researchRunListResponseSchema,
	researchRunResponseSchema,
} from "@research/contracts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	idempotencyKey,
	type LaunchedService,
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Positive-path live test (`bun run test:real:live`, finding 14, task 23b).
 *
 * Opt-in: skipped without `RUN_LIVE_OPENCODE=1` and `OPENCODE_MODEL` (the
 * same switches the existing live tests use) or `RUN_LIVE_AGENT=<agentId>`, because it spends plan quota
 * and needs the real network. `bun run test:real` alone is PARTIAL coverage
 * of the owner's rule (network path only: one real feed refresh, no model);
 * THIS suite is the positive path: a real question through the real agent
 * backend, a real public page through the research tool, from the fresh and
 * the upgraded settings states — against `bun run dev` started for real on
 * test ports with throwaway directories.
 *
 * 1. Fresh state: Chat shows the notice, Settings → AI agent gets the
 *    backend and model chosen from the selectors and saved (with public web
 *    access allowed), a real recommended source (EIA Today in Energy) is
 *    subscribed, a question is asked, and the run completes with at least
 *    one claim and one source link.
 * 2. A question uses Agent Web Search for discovery and extraction.
 * 3. Upgraded state: after a restart with a fresh database that has a run
 *    but no saved settings (created through the API), a question can be
 *    sent without visiting Settings.
 *
 * A model reply that fails the protocol is a finding, not something to
 * assert around: the assertions below are the protocol minimum, and every
 * attempt's outcome is recorded in `docs/REQUIREMENTS_STATUS.md`.
 */
test.describe.configure({ mode: "serial" });

/**
 * The backend under test: `RUN_LIVE_AGENT=<agentId>` (with an optional
 * `RUN_LIVE_MODEL`), or the original `RUN_LIVE_OPENCODE=1` with the required
 * `OPENCODE_MODEL`. The runner is chosen by `RESEARCH_RUNNER` (the launcher).
 */
const LIVE_AGENT_ENV = (process.env.RUN_LIVE_AGENT ?? "").trim();
const LIVE_OPENCODE = process.env.RUN_LIVE_OPENCODE === "1";
const LIVE = LIVE_AGENT_ENV !== "" || LIVE_OPENCODE;
const AGENT_ID = LIVE_AGENT_ENV !== "" ? LIVE_AGENT_ENV : "opencode";
const MODEL =
	AGENT_ID === "opencode"
		? (process.env.OPENCODE_MODEL ?? "").trim()
		: (process.env.RUN_LIVE_MODEL ?? "").trim();
/**
 * Backends that bill per use (ADR-0031): this live suite sets an optional maximum spend,
 * and the runner needs
 * the provider key, passed explicitly into the throwaway runner env file.
 */
const METERED_KEYS: Readonly<Record<string, string>> = {
	"claude-api": "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
};
/** Plan-limited HTTPS backends that still need their key in the runner env file (ADR-0074, ADR-0075). */
const PLAN_KEYS: Readonly<Record<string, string>> = {
	"sarashina-api": "SARASHINA_API_KEY",
	"gemini-api": "GEMINI_API_KEY",
};
const METERED_KEY = METERED_KEYS[AGENT_ID] ?? null;
const METERED = METERED_KEY !== null;
const PLAN_KEY = PLAN_KEYS[AGENT_ID] ?? null;
/** The spend ceiling per question on a metered backend, in USD (`RUN_LIVE_MAX_SPEND`, default 0.50). */
const MAX_SPEND_USD = Number((process.env.RUN_LIVE_MAX_SPEND ?? "0.5").trim());

/** Every run's reported cost: known, positive and within the ceiling on a metered backend. */
async function expectCostsWithinCeiling(): Promise<void> {
	if (!METERED) return;
	const runs = (await apiJson("GET", "/api/v1/research-runs")) as { runs: unknown };
	const list = Array.isArray(runs.runs) ? runs.runs : [];
	const costs = list.map((entry: unknown) => {
		const usage =
			typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).usage : null;
		const cost =
			typeof usage === "object" && usage !== null
				? (usage as Record<string, unknown>).knownCostUsd
				: null;
		return typeof cost === "number" ? cost : Number.NaN;
	});
	console.log(`metered run costs (USD): ${costs.map((cost) => cost.toFixed(4)).join(", ")}`);
	for (const cost of costs) {
		expect(cost).toBeGreaterThan(0);
		expect(cost).toBeLessThanOrEqual(MAX_SPEND_USD);
	}
}
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8901;
const API_PORT = 8902;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

/** The normalized owner-import feature, exercised on the actual dev launcher.
 * The financial sample is explicitly synthetic; the surrounding suite tests
 * the real runner/backend/feed/page network path, not a filing parser.
 */
const QUESTION_1 =
	process.env.RESEARCH_LIVE_QUESTION_1 ??
	"What did EIA Today in Energy report about US energy supply or demand this week, " +
		"and which products or services could see demand growth over the next 3 to 5 years as a result?";
const QUESTION_2 =
	"Use finance.sec_company_financials for MSFT. State Microsoft’s latest available annual revenue and cite the SEC evidence.";
const QUESTION_SEARCH =
	"Use web.search to discover the Example Domain documentation site. Then use web.extract on https://example.com/ to read the original page. State its purpose and cite the extracted evidence.";

let pristine: PristineCopy | null = null;
let service: LaunchedService | null = null;
let dataDirA = "";
let dataDirB = "";
let extraRoot = "";
let runnerEnvFile = "";
let livePage: Page | null = null;
let failed = false;
/** Stops (always run); deletions (run only when green, so a failure keeps evidence). */
const stoppers = new TestResources();
const cleaners = new TestResources();

/** The live browser page; assigned in `beforeAll` after the skip guard. */
function activePage(): Page {
	if (livePage === null) throw new Error("the live browser page was not created");
	return livePage;
}

function childEnv(dataDir: string, extra: Readonly<Record<string, string>> = {}) {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "8900",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
		extra: {
			// The runner's agent runtimes inherit this environment: the model
			// choice is explicit, so the CLI never picks a provider itself.
			...(MODEL === "" ? {} : { OPENCODE_MODEL: MODEL }),
			...extra,
		},
	});
}

async function startDev(dataDir: string): Promise<LaunchedService> {
	if (pristine === null) throw new Error("the pristine copy was not created");
	const launched = await startLauncher({
		cwd: pristine.root,
		args: ["dev"],
		env: childEnv(dataDir),
	});
	stoppers.add(async () => {
		await launched.stop();
	});
	return launched;
}

/**
 * Dumps what the backend did (run states, failure codes, progress tails, the
 * runner log tail, the pages directory) to stdout. Called when a live
 * assertion fails, while the launcher is still running — a model reply that
 * fails the protocol is a finding, and findings need evidence.
 */
async function dumpDiagnostics(label: string, dataDir: string): Promise<void> {
	console.log(`--- live diagnostics: ${label} ---`);
	try {
		const runs = (await apiJson("GET", "/api/v1/research-runs")) as { runs: unknown };
		const list = Array.isArray(runs.runs) ? runs.runs : [];
		for (const entry of list.slice(0, 5)) {
			if (typeof entry !== "object" || entry === null) continue;
			const run = entry as Record<string, unknown>;
			console.log(
				`run state=${String(run.state)} failureCode=${String(run.failureCode)} failureDetail=${String(run.failureDetail)}`,
			);
			const progress = Array.isArray(run.progress) ? run.progress : [];
			for (const item of progress.slice(-8)) {
				console.log(`  progress: ${JSON.stringify(item).slice(0, 300)}`);
			}
		}
	} catch (error) {
		console.log(`runs API failed: ${error instanceof Error ? error.message : "unknown"}`);
	}
	try {
		const log = readFileSync(join(dataDir, "logs", "runner.log"), "utf8");
		console.log(`--- runner.log tail ---\n${log.split("\n").slice(-40).join("\n")}`);
	} catch (error) {
		console.log(`runner log unreadable: ${error instanceof Error ? error.message : "unknown"}`);
	}
	try {
		console.log(`pages: ${readdirSync(join(dataDir, "pages")).join(", ")}`);
	} catch {
		console.log("pages: (no pages directory)");
	}
}

/** Waits until the runner's probe reports the backend (and the model, when one is chosen). */
async function waitForRunnerWithModel(): Promise<void> {
	await expect
		.poll(
			async () => {
				const response = await fetch(`${API_ORIGIN}/api/v1/agents`);
				if (!response.ok) return "agents API not ready";
				const parsed = agentsResponseSchema.safeParse(await response.json());
				if (!parsed.success) return "agents API response invalid";
				const agent = parsed.data.agents.find((entry) => entry.agentId === AGENT_ID);
				if (agent === undefined) return "backend not probed";
				if (agent.availability.status !== "available") {
					return `backend unavailable: ${agent.availability.reasonCode} ${agent.availability.detail}`;
				}
				if (
					MODEL !== "" &&
					agent.capabilities.model !== MODEL &&
					!(agent.capabilities.models ?? []).includes(MODEL)
				) {
					return "model not listed";
				}
				return "ready";
			},
			{ timeout: 180_000 },
		)
		.toBe("ready");
}

async function apiJson(method: string, path: string, body?: unknown): Promise<unknown> {
	const headers: Record<string, string> = { ...ownerHeaders(API_ORIGIN) };
	if (body !== undefined) {
		headers["Idempotency-Key"] = idempotencyKey();
	}
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	return (text === "" ? null : JSON.parse(text)) as unknown;
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "object" || value === null || !(field in value)) {
		throw new Error(`API response has no ${field}`);
	}
	const fieldValue: unknown = (value as Record<string, unknown>)[field];
	if (typeof fieldValue !== "string")
		throw new Error(`API response field ${field} is not a string`);
	return fieldValue;
}

function nestedField(response: unknown, outer: string, field: string): string {
	if (typeof response !== "object" || response === null) {
		throw new Error(`API response has no ${outer}`);
	}
	return stringField((response as Record<string, unknown>)[outer], field);
}

test.describe("live positive path through the real backend (spends real quota)", () => {
	test.skip(!LIVE, "needs RUN_LIVE_AGENT=<agentId>, or RUN_LIVE_OPENCODE=1 with OPENCODE_MODEL");

	test.beforeAll(async ({ browser }) => {
		if (AGENT_ID === "opencode" && MODEL === "") {
			throw new Error(
				"RUN_LIVE_OPENCODE=1 requires OPENCODE_MODEL=provider/model in the environment, so the CLI never picks a provider on its own",
			);
		}
		test.setTimeout(300_000);
		pristine = makePristineCopy(REPO_ROOT);
		cleaners.add(() => pristine?.remove());
		dataDirA = mkdtempSync(join(tmpdir(), "research-live-dev-a-"));
		cleaners.add(() => rmSync(dataDirA, { recursive: true, force: true }));
		dataDirB = mkdtempSync(join(tmpdir(), "research-live-dev-b-"));
		cleaners.add(() => rmSync(dataDirB, { recursive: true, force: true }));
		extraRoot = mkdtempSync(join(tmpdir(), "research-live-extra-"));
		cleaners.add(() => rmSync(extraRoot, { recursive: true, force: true }));
		// Test-owned runner settings (finding 5): the operational
		// `apps/runner/.env` is neither copied nor read.
		// A backend whose tool isolation is "unverified" (Codex) is refused
		// by the pipeline unless the owner opts in on the runner; this is a
		// throwaway copy, and the opt-in is the documented one.
		const meteredKey = METERED_KEY === null ? "" : (process.env[METERED_KEY] ?? "").trim();
		if (METERED_KEY !== null && meteredKey === "") {
			throw new Error(`RUN_LIVE_AGENT=${AGENT_ID} needs ${METERED_KEY} in the environment`);
		}
		const planKey = PLAN_KEY === null ? "" : (process.env[PLAN_KEY] ?? "").trim();
		if (PLAN_KEY !== null && planKey === "") {
			throw new Error(`RUN_LIVE_AGENT=${AGENT_ID} needs ${PLAN_KEY} in the environment`);
		}
		if (METERED && !(MAX_SPEND_USD > 0)) {
			throw new Error("RUN_LIVE_MAX_SPEND must be a positive number of USD");
		}
		const searchKey = (
			process.env.RESEARCH_LIVE_SEARCH_API_KEY ??
			process.env.AGENT_WEB_SEARCH_API_KEY ??
			""
		).trim();
		const searchUrl = (
			process.env.RESEARCH_LIVE_SEARCH_URL ??
			process.env.AGENT_WEB_SEARCH_URL ??
			"http://127.0.0.1:8090"
		).trim();
		runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
			...(process.env.SEC_USER_AGENT ? { SEC_USER_AGENT: process.env.SEC_USER_AGENT } : {}),
			...(searchKey === ""
				? {}
				: { AGENT_WEB_SEARCH_API_KEY: searchKey, AGENT_WEB_SEARCH_URL: searchUrl }),
			...(AGENT_ID === "opencode" ? {} : { ALLOW_UNVERIFIED_TOOL_ISOLATION: "1" }),
			...(METERED_KEY === null ? {} : { [METERED_KEY]: meteredKey }),
			...(PLAN_KEY === null ? {} : { [PLAN_KEY]: planKey }),
			...(AGENT_ID === "openrouter" && MODEL !== "" ? { OPENROUTER_MODEL: MODEL } : {}),
			...(AGENT_ID === "gemini-api" && MODEL !== "" ? { GEMINI_MODEL: MODEL } : {}),
		});
		service = await startDev(dataDirA);
		livePage = await browser.newPage();
	});

	test.afterEach(() => {
		if (test.info().status === "failed") failed = true;
	});

	test.afterAll(async () => {
		if (livePage !== null) await livePage.close().catch(() => undefined);
		livePage = null;
		await stoppers.close();
		if (failed) {
			// Keep the evidence: a model reply that fails the protocol is a
			// finding, and findings need their logs, not a cleaned tmp dir.
			console.log(
				`live run failed: keeping throwaway directories for inspection:\n- ${dataDirA}\n- ${dataDirB}\n- ${extraRoot}`,
			);
			return;
		}
		await cleaners.close();
	});
	test("fresh state: notice, Settings selectors, save, subscribe, ask, complete", async () => {
		test.setTimeout(900_000);
		const page = activePage();
		await waitForRunnerWithModel();
		await page.goto(VITE_ORIGIN);
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await page
			.getByRole("navigation", { name: "Chats" })
			.getByRole("button", { name: "New chat", exact: true })
			.click();
		await expect(page).toHaveURL(/#\/chat\/ws_/);
		// Fresh state: no backend saved, so the composer says where to fix it.
		const composer = page.getByRole("form", { name: "Research composer" });
		await expect(composer).toContainText("Choose a default agent backend");

		// Settings → AI agent: backend and model chosen from the selectors, saved.
		await page.locator('[data-field="session-owner-link"]').click();
		const agentSection = page.getByRole("region", { name: "AI agent" });
		await expect(agentSection).toBeVisible();
		const backend = agentSection.getByLabel("Default backend");
		await expect(backend.locator(`option[value="${AGENT_ID}"]`)).toHaveCount(1, {
			timeout: 30_000,
		});
		await backend.selectOption(AGENT_ID);
		if (MODEL !== "") {
			const modelSelect = agentSection.getByLabel("Model for this backend");
			if (AGENT_ID === "openrouter") {
				// Paid OpenRouter models use the explicit model-id control.
				await modelSelect.selectOption("__other__");
				await agentSection.getByRole("textbox", { name: "Model id", exact: true }).fill(MODEL);
			} else {
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
			}
		}
		await agentSection.getByLabel("Effort").selectOption("low");
		// A metered backend asks for the per-question spend ceiling here.
		if (METERED) await agentSection.getByLabel("Max spend (USD)").fill(String(MAX_SPEND_USD));
		// Public web access must be ON for the page question below: ensure
		// the checkbox is checked (the defaults already allow it, so blindly
		// clicking would turn it OFF).
		const webAccess = agentSection.getByRole("switch", {
			name: "Allow the agent to open public web pages",
		});
		if (!(await webAccess.isChecked())) await webAccess.check();
		await expect(webAccess).toBeChecked();
		const save = agentSection.getByRole("button", { name: "Save" });
		if (await save.isEnabled()) await save.click();
		await expect(agentSection).toContainText(/Saved /);
		// What was saved is what the runs use: backend, model and web
		// access, read back through the API (a UI-only save that dropped
		// web access would fail the page question below as NO_EVIDENCE).
		const savedSettings = await apiJson("GET", "/api/v1/settings/agent");
		if (typeof savedSettings !== "object" || savedSettings === null) {
			throw new Error("saved settings have no body");
		}
		const settingsBody = (savedSettings as { settings: unknown }).settings;
		if (typeof settingsBody !== "object" || settingsBody === null) {
			throw new Error("saved settings have no settings");
		}
		const settingsRecord = settingsBody as Record<string, unknown>;
		expect(settingsRecord.defaultAgentId).toBe(AGENT_ID);
		if (MODEL !== "") {
			expect((settingsRecord.models as Record<string, unknown>)[AGENT_ID]).toBe(MODEL);
		}
		expect(settingsRecord.webAccess).toBe("public-web");
		if (METERED) {
			const budget = settingsRecord.budget as Record<string, unknown>;
			expect(budget.maxSpendUsd).toBe(MAX_SPEND_USD);
		}

		// A real recommended source subscribed.
		await page.getByRole("link", { name: "Sources", exact: true }).click();
		const recommended = page.getByRole("region", { name: "Recommended sources" });
		await expect(recommended).toBeVisible();
		const eia = recommended.locator('li[data-catalog-id="eia-today"]');
		await expect(eia).toBeVisible();
		await eia.getByRole("button", { name: "Subscribe to EIA Today in Energy" }).click();
		const subscribed = page.getByRole("region", { name: "Subscribed sources" });
		await expect(subscribed).toContainText("EIA Today in Energy", { timeout: 45_000 });

		// A question asked; the run completes with a claim and a source link.
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await composer.getByRole("textbox", { name: "Question" }).fill(QUESTION_1);
		await composer.getByRole("button", { name: "Send question" }).click();
		const thread = page.getByRole("list", { name: "Messages" });
		await expect(thread.locator('[data-run-state="completed"]')).toBeAttached({
			timeout: 720_000,
		});
		const conversation = page.getByRole("region", { name: "Conversation" });
		const assistant = conversation.getByRole("article", { name: "Assistant message" });
		await expect(assistant).toBeVisible();
		// The answer groups claims under Summary/Findings; each rendered claim
		// retains its stable ID regardless of the section title.
		await expect(assistant.locator("li[data-claim-id]").first()).toBeVisible();
		expect(await assistant.locator("li[data-claim-id]").count()).toBeGreaterThan(0);
		expect(await assistant.locator("a").count()).toBeGreaterThan(0);

		// The first question named the chat: it started as "New chat".
		const openChat = page
			.getByRole("navigation", { name: "Chats" })
			.locator('li[data-conversation-id] a[aria-current="page"]');
		await expect(openChat).toContainText(QUESTION_1.slice(0, 32), {
			timeout: 30_000,
		});
		await expect(
			page.getByRole("region", { name: "Chat", exact: true }).getByRole("heading").first(),
		).toContainText(QUESTION_1.slice(0, 32));
		// A citation chip opens its source card with a link to the source.
		const chip = assistant.locator("[data-citation-chip]").first();
		await chip.click();
		const card = assistant.locator("[data-citation-card]");
		await expect(card).toBeVisible();
		await expect(card.getByRole("link", { name: "Open source" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(card).toHaveCount(0);
		// The run's research results sit in the thread under its answer
		// (ADR-0020), each with an "Add to Notebook" action.
		const preview = conversation.locator("[data-preview-component]").first();
		await expect(preview).toBeVisible();
		await expect(preview.getByRole("button", { name: "Add to Notebook" })).toBeVisible();
		// Every result is the run's own, under its answer: no "Other results" area.
		await expect(
			page.getByRole("list", { name: "Messages" }).locator("[data-preview-component]").first(),
		).toBeVisible();
		await expect(page.getByRole("region", { name: "Other results" })).toHaveCount(0);
		const chatUrl = page.url();
		await page.goto(chatUrl);
	});

	test("stored stock retrieval uses stocks.search and cites a stored real-news article", async () => {
		test.setTimeout(900_000);
		const articles = articleListResponseSchema.parse(await apiJson("GET", "/api/v1/articles"));
		const article = articles.articles[0];
		if (article === undefined) throw new Error("The real feed produced no stored article.");
		const term = article.title.match(/[A-Za-z]{4,}/u)?.[0];
		if (term === undefined) throw new Error("The stored headline has no searchable word.");
		const page = activePage();
		const composer = page.getByRole("form", { name: "Research composer" });
		const thread = page.getByRole("list", { name: "Messages" });
		const completedBefore = await thread.locator('[data-run-state="completed"]').count();
		await composer
			.getByRole("textbox", { name: "Question" })
			.fill(
				`Use stocks.search with query "${term}" and kind "news" to retrieve stored news. Report one factual statement supported by the returned passage, cite its evidence, and state its publication date. Use only stored retrieval; do not fetch feeds, web pages or live search.`,
			);
		await composer.getByRole("button", { name: "Send question" }).click();
		try {
			await expect(thread.locator('[data-run-state="completed"]')).toHaveCount(
				completedBefore + 1,
				{ timeout: 720_000 },
			);
		} catch (error) {
			await dumpDiagnostics("stored stock retrieval", dataDirA);
			throw error;
		}
		const runs = researchRunListResponseSchema.parse(await apiJson("GET", "/api/v1/research-runs"));
		const searched = runs.runs.find((run) => run.request?.question.startsWith("Use stocks.search"));
		if (searched === undefined) throw new Error("Stored retrieval run was not listed.");
		const detail = await apiJson("GET", `/api/v1/research-runs/${stringField(searched, "runId")}`);
		expect(JSON.stringify(detail)).toContain("stocks.search: executed");
		await expect(
			thread
				.getByRole("article", { name: "Assistant message" })
				.last()
				.locator("[data-citation-chip]")
				.first(),
		).toBeVisible();
	});

	test("a question no subscribed source covers searches the web and completes", async () => {
		test.setTimeout(900_000);
		const page = activePage();
		try {
			const composer = page.getByRole("form", { name: "Research composer" });
			const thread = page.getByRole("list", { name: "Messages" });
			// Counted from what is already there, so the test also holds when
			// run on its own after the fresh-state test (`-g`).
			const completedBefore = await thread.locator('[data-run-state="completed"]').count();
			await composer.getByRole("textbox", { name: "Question" }).fill(QUESTION_SEARCH);
			await composer.getByRole("button", { name: "Send question" }).click();
			await expect(thread.locator('[data-run-state="completed"]')).toHaveCount(
				completedBefore + 1,
				{ timeout: 720_000 },
			);
		} catch (error) {
			await dumpDiagnostics("search question", dataDirA);
			throw error;
		}
		// Confirm both service calls through the run's progress.
		const runs = (await apiJson("GET", "/api/v1/research-runs")) as { runs: unknown };
		const list = Array.isArray(runs.runs) ? runs.runs : [];
		const searchRun = list.find(
			(entry: unknown) =>
				typeof entry === "object" &&
				entry !== null &&
				JSON.stringify(entry).includes(QUESTION_SEARCH),
		);
		expect(searchRun, "the search question's run is not listed").toBeDefined();
		const detail = await apiJson("GET", `/api/v1/research-runs/${stringField(searchRun, "runId")}`);
		const recorded = JSON.stringify(detail);
		expect(recorded).toMatch(/web\.search: executed/);
		expect(recorded).toMatch(/web\.extract: executed/);
		expect(recorded).not.toContain("web.fetch_page");
		await expectCostsWithinCeiling();
	});

	test("a past chat is renamed and then deleted with its runs", async () => {
		const page = activePage();
		const nav = page.getByRole("navigation", { name: "Chats" });
		const row = nav.locator("li[data-conversation-id]");
		await expect(row).toHaveCount(1);
		const workspaceId = await row.getAttribute("data-conversation-id");
		const renamed = `Live renamed ${Date.now()}`;
		await row.getByRole("button", { name: /^More actions for / }).click();
		await page.getByRole("menuitem", { name: "Rename" }).click();
		await page.getByLabel("Chat title").fill(renamed);
		await page.keyboard.press("Enter");
		await expect(nav).toContainText(renamed, { timeout: 15_000 });
		await expect(
			page.getByRole("region", { name: "Chat", exact: true }).getByRole("heading").first(),
		).toContainText(renamed);

		// Both runs are finished, so the delete is accepted; the open chat
		// was the only one, so the page falls back to the welcome.
		await nav.getByRole("button", { name: `More actions for ${renamed}` }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText(renamed);
		await dialog.getByRole("button", { name: "Delete" }).click();
		await expect(row).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByRole("heading", { name: "Welcome to Chat" })).toBeVisible();
		// Gone on the server too, with its runs.
		const gone = await fetch(`${API_ORIGIN}/api/v1/workspaces/${workspaceId ?? ""}`, {
			headers: ownerHeaders(API_ORIGIN),
		});
		expect(gone.status).toBe(404);
		const runs = await apiJson("GET", `/api/v1/research-runs?workspaceId=${workspaceId ?? ""}`);
		expect(JSON.stringify(runs)).not.toContain('"runId"');
	});

	test("Japanese corporate training news produces verified findings", async () => {
		test.skip(
			process.env.RUN_LIVE_JAPANESE_TRAINING !== "1",
			"opt-in Japanese numeric-representation reproduction",
		);
		test.setTimeout(900_000);
		await waitForRunnerWithModel();
		const workspace = await apiJson("POST", "/api/v1/workspaces", {
			title: "Japanese training report verification",
		});
		const workspaceId = stringField(workspace, "workspaceId");
		const created = researchRunResponseSchema.parse(
			await apiJson("POST", "/api/v1/research-runs", {
				workspaceId,
				question: "日米の企業研修の需要が拡大しているか調査してください。",
				outputType: "news",
				agentId: AGENT_ID,
				model: MODEL === "" ? null : MODEL,
				effort: "medium",
				horizonYears: 3,
				markets: ["JP", "US"],
				budget: {
					maxAgentSteps: 12,
					maxToolCalls: 60,
					maxWallClockMs: 1_800_000,
					maxInputBytes: 2_000_000,
					maxSpendUsd: METERED ? MAX_SPEND_USD : null,
				},
				webAccess: "public-web",
			}),
		);
		const path = `/api/v1/research-runs/${created.run.runId}`;
		try {
			await expect
				.poll(async () => researchRunResponseSchema.parse(await apiJson("GET", path)).run.state, {
					timeout: 720_000,
					intervals: [1000, 2000, 5000],
				})
				.toMatch(/^(completed|partial|failed|cancelled|waiting_approval)$/);
			const { run } = researchRunResponseSchema.parse(await apiJson("GET", path));
			expect(run.state, `${run.failureCode}: ${run.failureDetail}`).toBe("completed");
			expect(run.verificationStatus).toMatch(/^(verified|partially-verified)$/);
			const page = activePage();
			await page.goto(`${VITE_ORIGIN}/#/chat/${workspaceId}`);
			const assistant = page.getByRole("article", { name: "Assistant message" });
			await expect(assistant.locator("li[data-claim-id]").first()).toBeVisible();
			await expect(assistant.locator("[data-citation-chip]").first()).toBeVisible();
			await expect(assistant).toContainText(/研修|トレーニング/);
			await expect(assistant).not.toContainText("No verified findings");
			await expect(assistant).not.toContainText("このレポートには検証済みの調査結果がありません");
			await page.screenshot({
				path: test.info().outputPath("japanese-training.png"),
				fullPage: true,
			});
		} catch (error) {
			await dumpDiagnostics("Japanese corporate training", dataDirA);
			throw error;
		}
	});

	test("upgraded state: a run without saved settings can send without visiting Settings", async () => {
		test.setTimeout(900_000);
		const page = activePage();
		// A fresh database holding a run but no saved settings: restart the
		// launcher against it, then create the run through the API.
		await service?.stop();
		service = await startDev(dataDirB);
		await waitForRunnerWithModel();
		const workspace = await apiJson("POST", "/api/v1/workspaces", {
			title: "Upgraded state probe",
		});
		const workspaceId = stringField(workspace, "workspaceId");
		const created = await apiJson("POST", "/api/v1/research-runs", {
			workspaceId,
			question: "Which products could see demand growth?",
			agentId: AGENT_ID,
			model: MODEL === "" ? null : MODEL,
			effort: "low",
			horizonYears: 4,
			markets: ["US"],
			budget: {
				maxAgentSteps: 6,
				maxToolCalls: 20,
				maxWallClockMs: 600_000,
				maxInputBytes: 400_000,
				maxSpendUsd: METERED ? MAX_SPEND_USD : null,
			},
			webAccess: "off",
		});
		expect(nestedField(created, "run", "runId")).not.toBe("");
		// The settings were never saved: the API says they are carried over
		// from the most recent question, not defaults.
		const settings = await apiJson("GET", "/api/v1/settings/agent");
		if (typeof settings !== "object" || settings === null) {
			throw new Error("settings response has no body");
		}
		expect((settings as { origin: unknown }).origin).toBe("carried-over");

		// Without visiting Settings, the composer offers to send.
		await page.goto(VITE_ORIGIN);
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await page
			.getByRole("navigation", { name: "Chats" })
			.getByRole("button", { name: "New chat", exact: true })
			.click();
		await expect(page).toHaveURL(/#\/chat\/ws_/);
		const composer = page.getByRole("form", { name: "Research composer" });
		await expect(composer).not.toContainText("Choose a default agent backend");
		await composer.getByRole("textbox", { name: "Question" }).fill(QUESTION_2);
		const send = composer.getByRole("button", { name: "Send question" });
		// ADR-0035: an absent cap is allowed, including carried-over settings.
		await expect(send).toBeEnabled();
		try {
			await send.click();
			// Verify the newly sent question, not the seed run that supplied preferences.
			const thread = page.getByRole("list", { name: "Messages" });
			await expect(thread.locator('[data-run-state="completed"]')).toHaveCount(1, {
				timeout: 720_000,
			});
			const assistant = thread.getByRole("article", { name: "Assistant message" });
			await expect(assistant.locator("li[data-claim-id]").first()).toBeVisible();
			await expect(assistant.locator("[data-citation-chip]").first()).toBeVisible();
			const carried = await apiJson("GET", "/api/v1/settings/agent");
			if (typeof carried !== "object" || carried === null)
				throw new Error("settings response has no body");
			expect((carried as { origin: unknown }).origin).toBe("carried-over");
		} catch (error) {
			await dumpDiagnostics("upgraded-state send", dataDirB);
			throw error;
		}
	});
});
