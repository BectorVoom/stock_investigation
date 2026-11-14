import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	agentSettingsResponseSchema,
	agentsResponseSchema,
	conversationResponseSchema,
	DEFAULT_AGENT_SETTINGS,
	runScheduledTaskResponseSchema,
	scheduledTaskResponseSchema,
	taskResultResponseSchema,
} from "@research/contracts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	listScheduledTasks,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
	utcSlotAhead,
} from "./helpers.ts";

/**
 * Scheduled tasks, live positive path (ADR-0033, FR-021): a task fires BY
 * ITSELF on the real `bun run dev` with the real runner and the real agent
 * CLI, and its answer lands in its own chat. Spends plan quota (exactly one
 * research run), so it is opt-in: skipped without `RUN_LIVE_AGENT=<agentId>`
 * (optional `RUN_LIVE_MODEL`; for `opencode` the model is required).
 *
 * Fresh state: Settings → AI agent gets the backend chosen from the selector
 * and saved, the real recommended EIA "Today in Energy" source is
 * subscribed, a "Once" task is created on the Tasks page 1–2 minutes ahead
 * (UTC), and nothing else is clicked: the runner's idle claim fires it, the
 * run completes, the task's chat holds the question and an assistant answer
 * with claims and at least one source link, a Scheduled tasks widget
 * added to Home shows the task with its last run completed, and a Task
 * result widget (ADR-0038) shows the answer text itself.
 *
 * A model reply that fails the protocol is a finding, not something to
 * assert around: the throwaway directories are kept on failure.
 */
test.describe.configure({ mode: "serial" });

const AGENT_ID = (process.env.RUN_LIVE_AGENT ?? "").trim();
const LIVE = AGENT_ID !== "";
const MODEL = (process.env.RUN_LIVE_MODEL ?? "").trim();
/** Metered backends (ADR-0031) and the key each needs; spending caps are optional (ADR-0035). */
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
const MAX_SPEND_USD = Number((process.env.RUN_LIVE_MAX_SPEND ?? "0.5").trim());
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8917;
const API_PORT = 8918;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const SHOTS_DIR = join(REPO_ROOT, "test-results-real");
const TITLE = "Live AI news: EIA energy brief";
const QUESTION =
	"What did EIA Today in Energy report about US energy supply or demand this week, " +
	"and which products or services could see demand growth over the next 3 to 5 years as a result?";

let pristine: PristineCopy | null = null;
let dataDir = "";
let extraRoot = "";
let failed = false;
/** Stops (always run); deletions (only when green, so a failure keeps its evidence). */
const stoppers = new TestResources();
const cleaners = new TestResources();

function devEnv(runnerEnvFile: string): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18979",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
		extra: {
			// The agent runtimes inherit this: the model choice is explicit, so
			// the CLI never picks a provider itself.
			...(AGENT_ID === "opencode" && MODEL !== "" ? { OPENCODE_MODEL: MODEL } : {}),
		},
	});
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
				if (MODEL !== "" && !(agent.capabilities.models ?? []).includes(MODEL)) {
					return "model not listed";
				}
				return "ready";
			},
			{ timeout: 180_000 },
		)
		.toBe("ready");
}

/** What the backend did, printed while the launcher still runs (findings need evidence). */
async function dumpDiagnostics(label: string): Promise<void> {
	console.log(`--- tasks live diagnostics: ${label} ---`);
	try {
		const tasks = await listScheduledTasks(API_ORIGIN);
		console.log(`tasks: ${JSON.stringify(tasks)}`);
		const runId = tasks[0]?.lastRun?.runId;
		if (runId !== undefined) {
			const response = await fetch(`${API_ORIGIN}/api/v1/research-runs/${runId}`, {
				headers: ownerHeaders(API_ORIGIN),
			});
			console.log(`run ${runId}: ${(await response.text()).slice(0, 4_000)}`);
		}
	} catch (error) {
		console.log(`API failed: ${error instanceof Error ? error.message : "unknown"}`);
	}
	try {
		const log = readFileSync(join(dataDir, "logs", "runner.log"), "utf8");
		console.log(`--- runner.log tail ---\n${log.split("\n").slice(-60).join("\n")}`);
	} catch (error) {
		console.log(`runner log unreadable: ${error instanceof Error ? error.message : "unknown"}`);
	}
}

test.describe("a scheduled task fires by itself through the real backend (spends real quota)", () => {
	test.skip(!LIVE, "needs RUN_LIVE_AGENT=<agentId> (optional RUN_LIVE_MODEL)");

	test.beforeAll(async () => {
		if (AGENT_ID === "opencode" && MODEL === "") {
			throw new Error(
				"RUN_LIVE_AGENT=opencode requires RUN_LIVE_MODEL=provider/model, so the CLI never picks a provider on its own",
			);
		}
		test.setTimeout(300_000);
		pristine = makePristineCopy(REPO_ROOT);
		cleaners.add(() => pristine?.remove());
		dataDir = mkdtempSync(join(tmpdir(), "research-live-tasks-data-"));
		cleaners.add(() => rmSync(dataDir, { recursive: true, force: true }));
		extraRoot = mkdtempSync(join(tmpdir(), "research-live-tasks-extra-"));
		cleaners.add(() => rmSync(extraRoot, { recursive: true, force: true }));
		// Test-owned runner settings (finding 5). A backend whose tool
		// isolation is "unverified" needs the documented runner opt-in, as in
		// live.spec.ts; this is a throwaway copy.
		const runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
			...(AGENT_ID === "opencode" ? {} : { ALLOW_UNVERIFIED_TOOL_ISOLATION: "1" }),
			...(METERED_KEY === null ? {} : { [METERED_KEY]: (process.env[METERED_KEY] ?? "").trim() }),
			...(PLAN_KEY === null ? {} : { [PLAN_KEY]: (process.env[PLAN_KEY] ?? "").trim() }),
			...(AGENT_ID === "gemini-api" && MODEL !== "" ? { GEMINI_MODEL: MODEL } : {}),
		});
		if (pristine === null) throw new Error("the pristine copy was not created");
		const launched = await startLauncher({
			cwd: pristine.root,
			args: ["dev"],
			env: devEnv(runnerEnvFile),
		});
		stoppers.add(async () => {
			await launched.stop();
		});
		mkdirSync(SHOTS_DIR, { recursive: true });
	});

	test.afterEach(() => {
		if (test.info().status === "failed") failed = true;
	});

	test.afterAll(async () => {
		await stoppers.close();
		if (failed) {
			console.log(
				`live task run failed: keeping throwaway directories for inspection:\n- ${dataDir}\n- ${extraRoot}`,
			);
			return;
		}
		await cleaners.close();
	});

	test(
		process.env.RUN_LIVE_SETTINGS_ONLY === "1"
			? "live backend Settings saves and survives reload"
			: "live AI News task generates a report and displays persisted text",
		async ({ browser }) => {
			test.setTimeout(1_200_000);
			await waitForRunnerWithModel();
			const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US" });
			stoppers.add(() => context.close());
			const page = await context.newPage();
			await page.setViewportSize({ width: 1440, height: 900 });

			// Settings → AI agent: the backend (and model) chosen from the selectors, saved.
			await page.goto(VITE_ORIGIN);
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
			await agentSection.getByLabel("Effort").selectOption("low");
			if (METERED) await agentSection.getByLabel("Max spend (USD)").fill(String(MAX_SPEND_USD));
			const save = agentSection.getByRole("button", { name: "Save" });
			if (await save.isEnabled()) await save.click();
			await expect(agentSection).toContainText(/Saved /);
			// Saved explicitly: what a scheduled run uses (ADR-0033 §4).
			const settingsResponse = await fetch(`${API_ORIGIN}/api/v1/settings/agent`, {
				headers: ownerHeaders(API_ORIGIN),
			});
			const settings = agentSettingsResponseSchema.parse(await settingsResponse.json());
			expect(settings.origin).toBe("saved");
			expect(settings.settings.defaultAgentId).toBe(AGENT_ID);
			if (process.env.RUN_LIVE_SETTINGS_ONLY === "1") {
				expect(settings.settings.models[AGENT_ID]).toBe(MODEL);
				await page.reload();
				const savedBackend = page
					.getByRole("region", { name: "AI agent" })
					.getByLabel("Default backend");
				await expect(savedBackend).toHaveValue(AGENT_ID);
				await expect(
					page.getByRole("region", { name: "AI agent" }).getByLabel("Model for this backend"),
				).toHaveValue(MODEL);
				await page.screenshot({
					path: join(SHOTS_DIR, "opencode-settings-live.png"),
					fullPage: true,
				});
				console.log(
					JSON.stringify({
						scenario: "settings-only",
						backend: AGENT_ID,
						model: MODEL,
						persistedAfterReload: true,
					}),
				);
				return;
			}

			// The real recommended source subscribed.
			await page.getByRole("link", { name: "Sources", exact: true }).click();
			const recommended = page.getByRole("region", { name: "Recommended sources" });
			const eia = recommended.locator('li[data-catalog-id="eia-today"]');
			await expect(eia).toBeVisible();
			await eia.getByRole("button", { name: "Subscribe to EIA Today in Energy" }).click();
			await expect(page.getByRole("region", { name: "Subscribed sources" })).toContainText(
				"EIA Today in Energy",
				{ timeout: 60000 },
			);

			// A "Once" task 1–2 minutes ahead, created on the Tasks page.
			await page.getByRole("link", { name: "Tasks", exact: true }).click();
			const list = page.getByRole("region", { name: "Scheduled tasks" });
			await list.getByRole("button", { name: "New task" }).click();
			const dialog = page.getByRole("dialog", { name: "New task" });
			await dialog.getByLabel("Output", { exact: true }).selectOption("news");
			await dialog.getByLabel("Title").fill(TITLE);
			await dialog.getByLabel("Question").fill(QUESTION);
			await dialog.getByLabel("Repeat").selectOption({ label: "Once" });
			const slot = utcSlotAhead(60_000);
			await dialog.getByLabel("Date").fill(slot.date);
			await dialog.getByLabel("Time", { exact: true }).fill(slot.time);
			await expect(dialog.getByLabel("Time zone")).toHaveValue("UTC");
			await expect(
				dialog.getByRole("checkbox", { name: /^Allow this task to spend up to / }),
			).toHaveCount(0);
			await dialog.getByRole("button", { name: "Create task" }).click();
			await expect(dialog).toBeHidden({ timeout: 30_000 });
			const row = page
				.getByRole("list", { name: "Your scheduled tasks" })
				.getByRole("article", { name: TITLE });
			await expect(row).toContainText("Not run yet");

			// Nothing else is clicked: the runner's claim fires it, the run completes.
			try {
				await expect
					.poll(
						async () => {
							const task = (await listScheduledTasks(API_ORIGIN)).find(
								(entry) => entry.title === TITLE,
							);
							if (task === undefined) return "missing";
							if (task.lastSkip !== null) throw new Error(`skipped:${task.lastSkip.code}`);
							const state = task.lastRun?.state ?? "none";
							if (["failed", "cancelled", "partial", "waiting_approval"].includes(state))
								throw new Error(
									`News generation ${state}: ${task.lastRun?.failureCode ?? "unknown"}`,
								);
							return state === "completed" || state === "failed" || state === "cancelled"
								? `${task.status}/${state}/${task.lastRun?.failureCode ?? "-"}`
								: "waiting";
						},
						{ timeout: slot.atMs - Date.now() + 720_000, intervals: [5_000] },
					)
					.toBe("completed/completed/-");
			} catch (error) {
				await dumpDiagnostics("scheduled run");
				throw error;
			}
			const [task] = await listScheduledTasks(API_ORIGIN);
			if (task === undefined) throw new Error("the task vanished after its run");
			expect(task.lastRun?.slotAt).toBe(slot.iso);
			expect(task.nextRunAt).toBeNull();
			// It fired at or after its time, never before.
			expect(Date.parse(task.lastRun?.queuedAt ?? "")).toBeGreaterThanOrEqual(slot.atMs);

			await expect(row).toContainText("Last run: completed", { timeout: 60_000 });
			await expect(row).toContainText("Completed");
			await page.screenshot({ path: join(SHOTS_DIR, "tasks-live-tasks-page-1440x900.png") });

			expect(task.outputType).toBe("news");
			const response = await fetch(`${API_ORIGIN}/api/v1/scheduled-tasks/${task.taskId}/result`, {
				headers: ownerHeaders(API_ORIGIN),
			});
			expect(response.ok).toBe(true);
			const stored = taskResultResponseSchema.parse(await response.json()).result;
			if (stored === null) throw new Error("completed News task has no stored answer");
			expect(stored.text.length).toBeGreaterThan(50);
			const conversationResponse = await fetch(
				`${API_ORIGIN}/api/v1/workspaces/${task.workspaceId}/messages`,
				{ headers: ownerHeaders(API_ORIGIN), signal: AbortSignal.timeout(15_000) },
			);
			expect(conversationResponse.ok).toBe(true);
			const conversation = conversationResponseSchema.parse(await conversationResponse.json());
			const articlePath = test.info().outputPath("generated-news-with-evidence.json");
			await writeFile(
				articlePath,
				JSON.stringify({ backend: AGENT_ID, model: MODEL, stored, conversation }, null, 2),
			);
			await test.info().attach("generated-news-with-evidence", {
				path: articlePath,
				contentType: "application/json",
			});
			const supported = conversation.claims.filter((claim) => claim.status === "supported");
			expect(supported.length).toBeGreaterThan(0);
			expect(
				conversation.claims.filter((claim) => claim.status !== "supported"),
				"Every published News claim must pass verification",
			).toEqual([]);
			expect(stored.verificationStatus).toBe("verified");
			await page.getByRole("link", { name: "News", exact: true }).click();
			const news = page.getByRole("region", { name: "AI news", exact: true });
			await expect(news.getByRole("heading", { name: TITLE })).toBeVisible();
			for (const claim of supported) {
				await expect(news.locator(`[data-claim-id="${claim.claimId}"]`)).toContainText(claim.text);
			}
			await news
				.getByRole("button", { name: /^Source \d+:/ })
				.first()
				.click();
			await expect(news.getByRole("link").first()).toBeVisible();
			await page.screenshot({ path: join(SHOTS_DIR, "news-live-desktop.png"), fullPage: true });
			await page.reload();
			for (const claim of supported) {
				await expect(news.locator(`[data-claim-id="${claim.claimId}"]`)).toContainText(claim.text);
			}
			await page.setViewportSize({ width: 390, height: 844 });
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true,
			);
			await page.screenshot({ path: join(SHOTS_DIR, "news-live-phone.png"), fullPage: true });
			await page.getByRole("link", { name: "Tasks", exact: true }).click();
			await expect(page.getByRole("link", { name: `Read ${TITLE} in News` })).toHaveAttribute(
				"href",
				"#/news",
			);
			await expect(page.getByRole("link", { name: `Open the chat of ${TITLE}` })).toHaveCount(0);
			await page.getByRole("link", { name: "Chat", exact: true }).click();
			await expect(page.getByText("No chats yet. Start one above.", { exact: true })).toBeVisible();
			await expect(page.getByText(TITLE, { exact: true })).toHaveCount(0);
			await expect(page.getByText(QUESTION, { exact: true })).toHaveCount(0);
			console.log(
				JSON.stringify({
					taskId: task.taskId,
					runId: stored.runId,
					backend: AGENT_ID,
					model: MODEL,
					outputType: task.outputType,
					answerChars: stored.text.length,
					verificationStatus: stored.verificationStatus,
					report: stored.text,
				}),
			);
		},
	);

	test("live investigation report uses research sections and source references", async ({
		browser,
	}) => {
		test.skip(
			process.env.RUN_LIVE_INVESTIGATION !== "1",
			"opt in to the additional investigation run",
		);
		test.setTimeout(900_000);
		await waitForRunnerWithModel();
		const settings = await fetch(`${API_ORIGIN}/api/v1/settings/agent`, {
			method: "PUT",
			headers: ownerHeaders(API_ORIGIN),
			body: JSON.stringify({
				...DEFAULT_AGENT_SETTINGS,
				defaultAgentId: AGENT_ID,
				models: MODEL === "" ? {} : { [AGENT_ID]: MODEL },
				effort: "low",
				webAccess: "public-web",
			}),
		});
		expect(settings.ok).toBe(true);
		const context = await browser.newContext({ locale: "en-US" });
		stoppers.add(() => context.close());
		const page = await context.newPage();
		await page.goto(`${VITE_ORIGIN}/#/sources`);
		const subscribe = page.getByRole("button", { name: "Subscribe to EIA Today in Energy" });
		await expect(page.getByRole("region", { name: "Recommended sources" })).toBeVisible();
		if ((await subscribe.count()) > 0) await subscribe.click();
		await expect(page.getByRole("region", { name: "Subscribed sources" })).toContainText(
			"EIA Today in Energy",
		);
		const created = await fetch(`${API_ORIGIN}/api/v1/scheduled-tasks`, {
			method: "POST",
			headers: { ...ownerHeaders(API_ORIGIN), "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify({
				title: "Refinery investigation",
				outputType: "chat",
				question:
					"Investigate how US refineries changed their production mix in 2026 using EIA Today in Energy. Give a concise answer, the reported findings and their explanation with sources. Distinguish reporting periods from publication dates. Use observations from the retrieved reports only; do not invent demand forecasts or claim exhaustive coverage.",
				horizonYears: 3,
				markets: ["US"],
				schedule: { kind: "daily", time: "09:00" },
				timeZone: "UTC",
				spendConsent: null,
			}),
		});
		expect(created.status).toBe(201);
		const { task } = scheduledTaskResponseSchema.parse(await created.json());
		const started = await fetch(`${API_ORIGIN}/api/v1/scheduled-tasks/${task.taskId}/run`, {
			method: "POST",
			headers: { ...ownerHeaders(API_ORIGIN), "Idempotency-Key": crypto.randomUUID() },
			body: "{}",
		});
		expect(started.status).toBe(202);
		const { run } = runScheduledTaskResponseSchema.parse(await started.json());
		await expect
			.poll(
				async () =>
					(await listScheduledTasks(API_ORIGIN)).find((entry) => entry.taskId === task.taskId)
						?.lastRun?.state,
				{ timeout: 720_000, intervals: [5_000] },
			)
			.toBe("completed");
		const read = await fetch(`${API_ORIGIN}/api/v1/workspaces/${task.workspaceId}/messages`, {
			headers: ownerHeaders(API_ORIGIN),
		});
		expect(read.ok).toBe(true);
		const conversation = conversationResponseSchema.parse(await read.json());
		await test.info().attach("investigation-report-with-evidence", {
			body: JSON.stringify(conversation, null, 2),
			contentType: "application/json",
		});
		expect(conversation.claims.length).toBeGreaterThan(1);
		expect(conversation.claims.filter((claim) => claim.status !== "supported")).toEqual([]);
		await page.goto(`${VITE_ORIGIN}/#/chat/${task.workspaceId}`);
		const report = page.locator('[data-report-format="investigation"]');
		await expect(report).toBeVisible();
		await expect(report.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
		await expect(report.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
		await expect(
			page.getByText(/claim\(s\) are supported by retrieved evidence/),
		).not.toBeVisible();
		await report
			.getByRole("button", { name: /^Source \d+:/ })
			.first()
			.click();
		await expect(report.getByRole("link", { name: "Open source", exact: true })).toBeVisible();
		for (const [name, width, height] of [
			["desktop", 1440, 900],
			["phone", 390, 844],
		] as const) {
			await page.setViewportSize({ width, height });
			await page.screenshot({
				path: join(SHOTS_DIR, `investigation-live-${name}.png`),
				fullPage: true,
			});
		}
		await page.reload();
		await expect(report.getByRole("heading", { name: "Summary", exact: true })).toBeVisible();
		console.log(
			JSON.stringify({
				runId: run.runId,
				backend: AGENT_ID,
				model: MODEL,
				supportedClaims: conversation.claims.length,
				format: "investigation",
			}),
		);
	});
});
