import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { scheduledTaskResponseSchema } from "@research/contracts";
import { parseBrowser } from "../e2e/engines.ts";

const browser = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const out = `test-results/ui-review/${browser}/news`;

test.beforeEach(async ({ context }) => {
	await context.setExtraHTTPHeaders({
		"X-E2E-Owner": `news-review-${Date.now()}-${test.info().testId}`,
	});
});

test("News task opens News and stays out of the Chat list", async ({ page }) => {
	mkdirSync(out, { recursive: true });
	await page.context().setExtraHTTPHeaders({ "X-E2E-Owner": `news-destination-${Date.now()}` });
	await page.goto("/#/tasks");
	const created = await page.request.post("/api/v1/scheduled-tasks", {
		headers: {
			Origin: new URL(page.url()).origin,
			"X-Research-Csrf": "1",
			"Idempotency-Key": `news-destination-${Date.now()}`,
		},
		data: {
			title: "News destination review",
			question: "Report verified energy news.",
			outputType: "news",
			horizonYears: 3,
			markets: ["US"],
			schedule: { kind: "daily", time: "09:00" },
			timeZone: "UTC",
			spendConsent: null,
		},
	});
	expect(created.status()).toBe(201);
	const { task } = scheduledTaskResponseSchema.parse(await created.json());
	await page.reload();
	const newsLink = page.getByRole("link", { name: "Read News destination review in News" });
	await expect(newsLink).toHaveAttribute("href", "#/news");
	await expect(page.getByRole("link", { name: /Open the chat of News destination/ })).toHaveCount(
		0,
	);
	await page.screenshot({ path: `${out}/news-task-destination.png`, fullPage: true });
	await newsLink.click();
	await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await expect(page.getByText("No chats yet. Start one above.", { exact: true })).toBeVisible();
	await expect(page.getByText(task.title, { exact: true })).toHaveCount(0);
	await expect(page.getByText(task.question, { exact: true })).toHaveCount(0);
	await page.screenshot({ path: `${out}/chat-without-news.png`, fullPage: true });
});

test("News navigation, empty state and responsive layout", async ({ page }) => {
	mkdirSync(out, { recursive: true });
	await page.goto("/#/news");
	await expect(page.getByRole("heading", { name: "News", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "News", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(page.getByText(/No articles ingested yet/)).toBeVisible();
	for (const [name, width, height] of [
		["desktop", 1440, 900],
		["phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		await expect(page.getByRole("link", { name: "Manage news sources" })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
	}
	await page.getByRole("link", { name: "Manage news sources" }).click();
	await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Recent articles" })).toHaveCount(0);
});

test("AI news reports, older history, reload and narrow screens", async ({ page }) => {
	mkdirSync(out, { recursive: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const at = "2026-11-08T09:00:00.000Z";
	await page.route("**/api/v1/scheduled-tasks", (route) =>
		route.fulfill({
			json: {
				tasks: [
					{
						taskId: "task_news_review",
						workspaceId: "ws_news_review",
						title: "Semiconductor morning news",
						question: "Research semiconductor news",
						outputType: "news",
						horizonYears: 3,
						markets: ["JP"],
						schedule: { kind: "daily", time: "08:00" },
						timeZone: "Asia/Tokyo",
						spendConsent: null,
						status: "active",
						nextRunAt: at,
						lastRun: null,
						lastSkip: null,
						version: 0,
						createdAt: at,
						updatedAt: at,
					},
				],
				limits: { maxActive: 10, maxTasks: 30 },
			},
		}),
	);
	const latest = `AI report: chip demand rose. Source https://example.com/${"long-source-path".repeat(30)}`;
	let reads = 0;
	await page.route("**/api/v1/workspaces/ws_news_review/messages*", (route) => {
		reads += 1;
		const older = new URL(route.request().url()).searchParams.has("before");
		return route.fulfill({
			json: {
				messages: [
					{
						messageId: older ? "old_answer" : "new_answer",
						seq: older ? 1 : 3,
						role: "assistant",
						text: older ? "Earlier report: chip demand was steady." : latest,
						runId: null,
						claimIds: older ? [] : ["claim_news_review", "unsupported_news_review"],
						createdAt: at,
					},
				],
				claims: older
					? []
					: [
							{
								claimId: "unsupported_news_review",
								text: "This unsupported sentence must not appear in the article.",
								claimType: "forecast",
								status: "unsupported",
								links: [],
								issues: [{ code: "NO_SUPPORTING_EVIDENCE" }],
							},
							{
								claimId: "claim_news_review",
								text: latest,
								claimType: "forecast",
								status: "supported",
								links: [
									{
										evidenceId: "evidence_news_review",
										relation: "supports",
										quote: "Chip demand rose.",
									},
								],
								issues: [],
							},
						],
				evidence: older
					? []
					: [
							{
								evidenceId: "evidence_news_review",
								sourceUrl: "https://example.com/industry-report",
								title: "Industry demand report",
								publisher: "Industry statistics",
								publishedAt: at,
								retrievedAt: at,
								effectiveAt: null,
								excerpt: "Chip demand rose.",
								checksum: "a".repeat(64),
								sourceClass: "news",
							},
						],
				hasEarlier: !older,
			},
		});
	});
	await page.goto("/#/news");
	await expect(page.getByRole("heading", { name: "AI news", exact: true })).toBeVisible();
	await expect(page.locator('[data-claim-id="claim_news_review"]')).toContainText(latest);
	await expect(page.locator('[data-report-format="news"]')).toBeVisible();
	await expect(page.locator("[data-claim-type]")).toHaveCount(0);
	await expect(page.locator('[data-claim-id="unsupported_news_review"]')).toHaveCount(0);
	await expect(page.locator('[data-claim-status="supported"]')).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Claims in this answer" })).toHaveCount(0);
	await page.getByRole("button", { name: "Earlier news" }).click();
	await expect(
		page.getByText("Earlier report: chip demand was steady.", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Earlier news" })).toHaveCount(0);
	expect(reads).toBe(2);
	await page.getByText("1 source", { exact: true }).click();
	await expect(page.getByRole("link", { name: /Industry demand report/ })).toHaveAttribute(
		"href",
		"https://example.com/industry-report",
	);
	for (const [name, width, height] of [
		["ai-desktop", 1440, 900],
		["ai-phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
	}
	await page.reload();
	await expect(page.locator('[data-claim-id="claim_news_review"]')).toContainText(latest);
	expect(errors).toEqual([]);
});

test("task output dropdown offers News and Chat", async ({ page }) => {
	await page.goto("/#/tasks");
	await page.getByRole("button", { name: "New task", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const output = dialog.getByRole("combobox", { name: "Output", exact: true });
	await expect(output).toHaveValue("chat");
	await output.selectOption("news");
	await expect(output).toHaveValue("news");
	await page.screenshot({ path: `${out}/task-output.png`, fullPage: true });
	await output.selectOption("chat");
	await expect(output).toHaveValue("chat");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
});
