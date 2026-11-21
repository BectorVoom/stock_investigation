import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
	agentsResponseSchema,
	conversationResponseSchema,
	type ResearchRun,
	researchRunListResponseSchema,
	researchRunResponseSchema,
} from "@research/contracts";
import { openNodeSqlite } from "../../packages/adapters/src/sqlite/index.ts";
import { seedStockResearch } from "../../packages/adapters/test/sql/stockResearchFixtures.ts";
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
 * ADR-0079 on the real stack: real launcher (`bun run dev` on test ports with
 * throwaway directories), real runner, real agent backend, real D1 and a
 * browser. It replays the owner's conversation of 2026-11-21: a research
 * question first — it must still research (stocks.search over explicitly
 * synthetic stored records, so no web search service is needed) — then, in
 * the same chat, 「バックグラインド、ダイシング、モールディングを図で説明してください。」,
 * which must be answered directly, without tools, with a flow diagram under
 * the answer and the "not researched" labels.
 *
 * Opt-in (spends model quota): `RUN_LIVE_AGENT=<agentId>` with the backend's
 * key in the test process environment (optional `RUN_LIVE_MODEL`).
 */
test.describe.configure({ mode: "serial" });
const AGENT = process.env.RUN_LIVE_AGENT ?? "";
const MODEL = process.env.RUN_LIVE_MODEL ?? "";
const WEB_PORT = process.env.RESEARCH_RUNNER === "node" ? 8952 : 8950;
const API_PORT = WEB_PORT + 1;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
const RESEARCH_QUESTION =
	'These are synthetic test records, not real company data. Use stocks.search: query "Synthetic Solar" kind "company", and state the stored business activity with its evidence.';
const DIAGRAM_QUESTION = "バックグラインド、ダイシング、モールディングを図で説明してください。";
const DIRECT_NOTE =
	"この回答は調査を行わず、AI モデルの一般知識から書かれています。出典との照合は行っていません。投資助言ではありません。";
const resources = new TestResources();
let pristine: PristineCopy | null = null;
let root = "";
let data = "";
let runnerEnv = "";
let failed = false;
let workspaceId = "";

async function api(path: string, body?: unknown): Promise<unknown> {
	const method = body === undefined ? "GET" : "POST";
	const response = await fetch(`${API}/api/v1${path}`, {
		method,
		headers: { ...ownerHeaders(API), "Idempotency-Key": crypto.randomUUID().replaceAll("-", "") },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
	return response.json();
}

function databasePath(): string {
	for (const entry of readdirSync(join(data, "d1"), { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
		const path = join(entry.parentPath, entry.name);
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			if (
				db.prepare("SELECT name FROM sqlite_schema WHERE name = 'equity_metric_value'").get() !==
				undefined
			)
				return path;
		} finally {
			db.close();
		}
	}
	throw new Error("The isolated launcher did not create its D1 database.");
}

async function start(): Promise<LaunchedService> {
	if (pristine === null) throw new Error("Pristine copy missing");
	const service = await startLauncher({
		cwd: pristine.root,
		args: ["dev"],
		env: launcherEnv({
			dataDir: join(root, "production-unused"),
			devDataDir: data,
			releaseDir: join(root, "release"),
			previousDir: join(root, "previous"),
			runnerEnvFile: runnerEnv,
			scratchRoot: join(root, "scratch"),
			webOutDir: join(root, "web"),
			prodPort: String(WEB_PORT - 1),
			devPort: String(WEB_PORT),
			devApiPort: String(API_PORT),
		}),
	});
	resources.add(() => service.stop().then(() => undefined));
	await expect
		.poll(
			async () => {
				const agents = agentsResponseSchema.parse(await api("/agents"));
				return agents.agents.find((candidate) => candidate.agentId === AGENT)?.availability.status;
			},
			{ timeout: 120_000 },
		)
		.toBe("available");
	return service;
}

/** Sends a question in the open chat and waits for its run to complete. */
async function ask(page: Page, question: string): Promise<ResearchRun> {
	const before = researchRunListResponseSchema
		.parse(await api(`/research-runs?workspaceId=${workspaceId}`))
		.runs.map((run) => run.runId);
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer.getByRole("textbox", { name: "Question" }).fill(question);
	await expect(composer.getByRole("button", { name: "Send question" })).toBeEnabled();
	await composer.getByRole("button", { name: "Send question" }).click();
	let runId = "";
	await expect
		.poll(
			async () => {
				const listed = researchRunListResponseSchema.parse(
					await api(`/research-runs?workspaceId=${workspaceId}`),
				);
				const run = listed.runs.find(
					(candidate) => candidate.kind === "research" && !before.includes(candidate.runId),
				);
				if (run === undefined) return "pending";
				runId = run.runId;
				if (["failed", "partial", "cancelled", "waiting_approval"].includes(run.state))
					throw new Error(
						`Run ended ${run.state}: ${run.failureCode}/${run.failureDetail}; ${JSON.stringify(run.progress)}`,
					);
				return run.state;
			},
			{ timeout: 600_000, intervals: [1000, 2000, 3000] },
		)
		.toBe("completed");
	return researchRunResponseSchema.parse(await api(`/research-runs/${runId}`)).run;
}

test.beforeAll(async () => {
	test.skip(
		AGENT === "",
		"Opt in with RUN_LIVE_AGENT=<agentId> and its key in the environment (real model quota).",
	);
	test.setTimeout(300_000);
	pristine = makePristineCopy(fileURLToPath(new URL("../..", import.meta.url)));
	root = mkdtempSync(join(tmpdir(), "research-direct-answer-live-"));
	data = join(root, "dev-data");
	runnerEnv = writeTestRunnerEnvFile(root, {
		ALLOW_UNVERIFIED_TOOL_ISOLATION: "1",
		...(AGENT === "opencode" ? { OPENCODE_MODEL: MODEL } : {}),
		...(AGENT === "openrouter-free"
			? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "", OPENROUTER_FREE_MODEL: MODEL }
			: {}),
		...(AGENT === "sarashina-api"
			? { SARASHINA_API_KEY: process.env.SARASHINA_API_KEY ?? "" }
			: {}),
		...(AGENT === "gemini-api"
			? {
					GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
					...(MODEL === "" ? {} : { GEMINI_MODEL: MODEL }),
				}
			: {}),
	});
	// The first launch creates the database; the synthetic records are seeded
	// while the stack is stopped, then it starts again.
	const first = await start();
	await first.stop();
	const db = openNodeSqlite(databasePath());
	try {
		await seedStockResearch(db, "owner@localhost");
		await db
			.prepare("UPDATE news_sources SET feed_status = 'paused' WHERE owner_id = ?")
			.bind("owner@localhost")
			.run();
		await db
			.prepare("UPDATE equity_company SET tracked = 0 WHERE owner_id = ?")
			.bind("owner@localhost")
			.run();
	} finally {
		db.close();
	}
	await start();
});
test.afterEach(() => {
	if (["failed", "timedOut", "interrupted"].includes(test.info().status ?? "")) failed = true;
});
test.afterAll(async () => {
	try {
		await resources.close();
	} finally {
		// Failed-run diagnostics may be kept, but provider credentials must not be.
		if (runnerEnv !== "") rmSync(runnerEnv, { force: true });
	}
	if (failed) {
		console.log(`Keeping isolated failure evidence: ${root}`);
		try {
			console.log(
				readFileSync(join(data, "logs", "runner.log"), "utf8")
					.split("\n")
					.slice(-25)
					.join("\n"),
			);
		} catch (error) {
			console.log(`Cannot read diagnostics: ${error instanceof Error ? error.name : "unknown"}`);
		}
	} else {
		pristine?.remove();
		if (root !== "") rmSync(root, { recursive: true, force: true });
	}
});

test("a research question still researches, and a diagram follow-up is answered directly with a flow diagram", async ({
	page,
}) => {
	test.setTimeout(1_200_000);
	await page.goto(ORIGIN);
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	const chatsNav = page.getByRole("navigation", { name: "Chats" });
	await chatsNav.getByRole("button", { name: "New chat", exact: true }).click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const composer = page.getByRole("form", { name: "Research composer" });
	await expect(composer).toContainText("Choose a default agent backend");
	await page.locator('[data-field="session-owner-link"]').click();
	const settings = page.getByRole("region", { name: "AI agent" });
	await settings.getByLabel("Default backend").selectOption(AGENT);
	if (MODEL !== "") await settings.getByLabel("Model for this backend").selectOption(MODEL);
	const save = settings.getByRole("button", { name: "Save" });
	if (await save.isEnabled()) await save.click();
	await expect(settings).toContainText(/Saved /);
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await chatsNav.getByRole("button", { name: "New chat", exact: true }).click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	await expect(composer).not.toContainText("Choose a default agent backend");
	workspaceId = page.url().split("/chat/")[1] ?? "";

	// 1. Needs research: the planner asks for tools, and the answer is verified claims.
	const research = await ask(page, RESEARCH_QUESTION);
	const researchTools = research.progress.filter((event) => event.kind === "tool");
	expect(researchTools.some((event) => event.text.startsWith("stocks.search: executed"))).toBe(
		true,
	);
	expect(research.progress.some((event) => event.text.includes("needs no research"))).toBe(false);
	expect(research.verificationStatus).not.toBe("unverified");

	// 2. The owner's diagram request, as a follow-up in the same chat: no tools, one answer turn.
	const direct = await ask(page, DIAGRAM_QUESTION);
	expect(direct.progress.filter((event) => event.kind === "tool")).toEqual([]);
	expect(
		direct.progress.some(
			(event) =>
				event.text ===
				"The planner judged that this question needs no research; answering from the model's general knowledge.",
		),
	).toBe(true);
	expect(direct.usage.agentSteps).toBe(2);
	expect(direct.verificationStatus).toBe("unverified");
	expect(direct.provenance?.promptVersion).toBe("research-v11");
	const conversation = conversationResponseSchema.parse(
		await api(`/workspaces/${workspaceId}/messages`),
	);
	// The owner's question carries the run id too; the answer is the assistant's message.
	const answer = conversation.messages.find(
		(message) => message.runId === direct.runId && message.role === "assistant",
	);
	expect(answer).toBeDefined();
	expect(answer?.claimIds).toEqual([]);
	expect(answer?.text.endsWith(DIRECT_NOTE)).toBe(true);
	expect(answer?.text).toMatch(/[ぁ-んァ-ン]/);
	expect(answer?.text).not.toContain("claim(s) are supported");

	// 3. The browser shows the answer and, under it, the diagram with its basis caption.
	const thread = page.getByRole("list", { name: "Messages" });
	const diagram = thread.locator("[data-flow-diagram]");
	await expect(diagram).toBeVisible({ timeout: 30_000 });
	const stages = diagram.locator("ol > li");
	expect(await stages.count()).toBeGreaterThanOrEqual(3);
	const labels = (await stages.allTextContents()).join(" ");
	for (const term of ["バックグラインド", "ダイシング", "モールディング"])
		expect(labels).toContain(term);
	await expect(diagram.locator("[data-flow-diagram-basis]")).toBeVisible();
	await expect(thread).toContainText(DIRECT_NOTE);
	await diagram.scrollIntoViewIfNeeded();
	await page.screenshot({ path: test.info().outputPath("direct-answer.png"), fullPage: false });
	await page.reload();
	await expect(thread.locator("[data-flow-diagram]")).toBeVisible({ timeout: 30_000 });
	console.log(
		JSON.stringify({
			runner: process.env.RESEARCH_RUNNER ?? "rust",
			research: { runId: research.runId, steps: research.usage.agentSteps },
			direct: {
				runId: direct.runId,
				providerModel: direct.providerModel,
				steps: direct.usage.agentSteps,
				stages: await stages.allTextContents(),
			},
		}),
	);
});
