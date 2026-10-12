import { expect, type Page, test } from "@playwright/test";
import { agentsResponseSchema } from "@research/contracts";
import { FEED_URL, HEADLINE } from "./fixtures.ts";

/**
 * Level 3 — the whole application with the real OpenCode backend.
 *
 * Opt-in: skipped unless RUN_LIVE_OPENCODE=1, so the normal `bun run test:e2e`
 * stays offline and never starts OpenCode. With the switch on, the E2E runner
 * harness serves the real baseline runtimes (see `runnerHarness.ts`) and this
 * spec drives the real UI: Settings → AI agent (OpenCode + model + effort low),
 * Sources (fixture feed), Chat (ask, wait for `completed`), Canvas, reload.
 *
 * The model comes from OPENCODE_MODEL in the caller's environment (a Go-plan
 * model such as `opencode-go/muse-spark-1.3-contributor`; free-tier models are
 * refused by the provider, AGT-003). News content is the fixed E2E fixture,
 * never the network. One attempt may take up to 15 minutes.
 */
const LIVE = process.env.RUN_LIVE_OPENCODE === "1";
const QUESTION =
	"What did grid storage orders reach in 2026, and which company supplies battery systems to utilities?";

test.describe.configure({ mode: "serial" });

test.describe("live OpenCode through the whole application (spends real quota)", () => {
	test.skip(!LIVE, "needs RUN_LIVE_OPENCODE=1 with OPENCODE_MODEL in the environment");

	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
	});

	test.afterAll(async () => {
		await page.close();
	});

	test("a question runs on OpenCode to a sourced report and survives a reload", async () => {
		test.setTimeout(900_000);
		const model = process.env.OPENCODE_MODEL;
		if (model === undefined || model.trim() === "") {
			throw new Error(
				"RUN_LIVE_OPENCODE=1 requires OPENCODE_MODEL=provider/model in the environment, so the CLI never picks a provider on its own",
			);
		}

		// Agent choices are made once in Settings → AI agent, not on the question form.
		// Wait until THIS runner has reported the live model before opening
		// the form, so a missing model here is a runner fault and not a
		// matter of timing. (The form itself keeps polling `/api/v1/agents`
		// and would fill the selector in once the report arrives.)
		await expect
			.poll(
				async () => {
					const response = await page.request.get("/api/v1/agents");
					if (!response.ok()) return [];
					const parsed = agentsResponseSchema.safeParse(await response.json());
					if (!parsed.success) return [];
					const opencode = parsed.data.agents.find((agent) => agent.agentId === "opencode");
					return opencode?.capabilities.models ?? [];
				},
				{ timeout: 180_000 },
			)
			.toContain(model.trim());
		await page.goto("/");
		await page.getByRole("link", { name: "Settings", exact: true }).click();
		const agentSection = page.getByRole("region", { name: "AI agent" });
		await expect(agentSection).toBeVisible();
		const backend = agentSection.getByLabel("Default backend");
		await expect(backend.locator("option", { hasText: "OpenCode" })).toHaveCount(1, {
			timeout: 30_000,
		});
		await backend.selectOption("opencode");
		// The model is a selector of runner-reported models (Settings → AI
		// agent), with "Other — type a model id…" as the escape hatch. The
		// live model must be one the runner reported; free-form typing would
		// hide a runner that never advertised it.
		const modelSelect = agentSection.getByLabel("Model for this backend");
		await expect(modelSelect).toBeVisible({ timeout: 30_000 });
		// The API already reported the live model above, so the select must
		// list it once the form has read `/agents`.
		await expect
			.poll(
				async () =>
					modelSelect
						.locator("option")
						.evaluateAll((nodes) =>
							nodes.map((node) => (node instanceof HTMLOptionElement ? node.value : "")),
						),
				{ timeout: 30_000 },
			)
			.toContain(model.trim());
		const reported = await modelSelect
			.locator("option")
			.evaluateAll((nodes) =>
				nodes.map((node) => (node instanceof HTMLOptionElement ? node.value : "")),
			);
		if (!reported.includes(model.trim())) {
			const listed = reported.map((value) => JSON.stringify(value)).join(", ");
			throw new Error(
				`OPENCODE_MODEL=${model} was not reported by the runner (option values: ${listed}).`,
			);
		}
		await modelSelect.selectOption(model.trim());
		await agentSection.getByLabel("Effort").selectOption("low");
		const save = agentSection.getByRole("button", { name: "Save" });
		if (await save.isEnabled()) await save.click();
		await expect(agentSection).toContainText(/Saved /);

		// Sources: subscribe the fixture feed explicitly.
		await page.getByRole("link", { name: "Sources", exact: true }).click();
		const subscribed = page.getByRole("region", { name: "Subscribed sources" });
		await expect(subscribed).toBeVisible();
		await page.getByLabel("Feed or site URL").fill(FEED_URL);
		await page.getByRole("button", { name: "Preview source" }).click();
		const preview = page.getByRole("region", { name: "Source preview" });
		await expect(preview).toContainText(HEADLINE);
		if ((await subscribed.getByRole("row").count()) === 0) {
			await preview.getByLabel("License policy").selectOption("short-excerpt-permitted");
			await preview.getByRole("button", { name: "Subscribe to this source" }).click();
		}
		await expect(subscribed).toContainText("Example Energy News (synthetic)");

		// Chat: start a conversation. The form only asks the question and
		// shows a read-only agent summary.
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await page.getByLabel("New conversation title").fill(`Live OpenCode ${Date.now()}`);
		await page.getByRole("button", { name: "Start conversation" }).click();
		await expect(page).toHaveURL(/#\/chat\/ws_/);
		const composer = page.getByRole("form", { name: "Research composer" });
		await expect(composer).toContainText("OpenCode");
		await composer.getByRole("textbox", { name: "Question" }).fill(QUESTION);
		await composer.getByRole("button", { name: "Send question" }).click();

		const thread = page.getByRole("list", { name: "Messages" });
		await expect(thread.locator('[data-run-state="completed"]')).toBeVisible({
			timeout: 900_000,
		});

		// An assistant message with at least one claim and a source link.
		const conversation = page.getByRole("region", { name: "Conversation" });
		const assistant = conversation.getByRole("article", { name: "Assistant message" });
		await expect(assistant).toBeVisible();
		const claims = assistant.locator('ul[aria-label="Claims"] > li[data-claim-id]');
		expect(await claims.count()).toBeGreaterThan(0);
		await expect(
			assistant.getByRole("link", { name: HEADLINE, exact: true }).first(),
		).toBeVisible();

		// A plan-limited backend is never shown as free.
		const cost = thread.locator('[data-field="cost"]').first();
		await expect(cost).toContainText(/unknown/i);
		await expect(cost).not.toContainText("$0");

		// Run count while the thread is rendered (the canvas page has no
		// message list): the reload below must not start another run.
		const runsBefore = await thread.locator("[data-run-state]").count();
		expect(runsBefore).toBeGreaterThan(0);

		// Canvas: a research report and a source list, no fallback component.
		await page.getByRole("link", { name: "Open canvas" }).click();
		const canvas = page.getByRole("region", { name: "Canvas" });
		await expect(canvas.locator('[data-component-type="research-report"]').first()).toBeVisible();
		await expect(canvas.locator('[data-component-type="source-list"]').first()).toBeVisible();
		await expect(canvas.locator("[data-fallback]")).toHaveCount(0);
		const sourceLink = canvas
			.locator('[data-component-type="source-list"]')
			.getByRole("link", { name: HEADLINE, exact: true });
		await expect(sourceLink).toHaveAttribute(
			"href",
			"https://news.example.org/articles/grid-storage-orders",
		);

		// A reload shows the same conversation without a new run.
		await page.reload();
		await expect(canvas.locator("[data-component-id]").first()).toBeVisible();
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await expect(
			page
				.getByRole("region", { name: "Conversation" })
				.getByRole("article", { name: "Assistant message" }),
		).toBeVisible();
		await expect(
			page.getByRole("list", { name: "Messages" }).locator("[data-run-state]"),
		).toHaveCount(runsBefore);
	});
});
