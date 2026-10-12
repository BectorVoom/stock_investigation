import { expect, type Page, test } from "@playwright/test";
import { E2E_ORIGIN, FEED_URL, HEADLINE } from "./fixtures.ts";

/**
 * Representative end-to-end journey (rules section 10, "E2E"):
 * chat -> research -> sourced table/chart -> workspace reload, plus the UI
 * safety properties that only a real browser can show.
 */

async function xssFlag(page: Page): Promise<unknown> {
	return page.evaluate(() => Reflect.get(window, "__xss"));
}

test.describe.configure({ mode: "serial" });

let page: Page;
const dialogs: string[] = [];
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	page.on("dialog", (dialog) => {
		dialogs.push(dialog.message());
		void dialog.dismiss();
	});
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterAll(async () => {
	await page.close();
});

test("a fresh installation guides the owner from chat to a sent message", async () => {
	// Fresh database: nothing saved, no runs. The send button is disabled and
	// a visible notice names Settings → AI agent with a link.
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1, name: "Research workspace" })).toBeVisible();
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);

	const composer = page.getByRole("form", { name: "Research composer" });
	await composer
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");
	await expect(composer.getByRole("button", { name: "Send question" })).toBeDisabled();
	await expect(composer).toContainText("Choose a default agent backend in Settings → AI agent.");
	const settingsLink = composer.getByRole("link", { name: "Open Settings → AI agent" });
	await expect(settingsLink).toBeVisible();
	expect(await settingsLink.getAttribute("href")).toBe("#/settings/agent");

	// The link lands on the AI agent section with focus on Default backend.
	await settingsLink.click();
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible();
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 30_000,
	});
	await expect(backend).toBeFocused();
	await backend.selectOption({ label: "Scripted example agent — available" });
	const model = agentSection.getByLabel("Model for this backend");
	await expect(model.locator("option", { hasText: "scripted/alpha" })).toHaveCount(1);
	await model.selectOption("scripted/alpha");
	// The model is chosen from the selector: no text input is shown unless "Other" is chosen.
	await expect(agentSection.getByLabel("Model id")).toHaveCount(0);
	await agentSection.getByRole("button", { name: "Save" }).click();
	await expect(agentSection).toContainText(/Saved /);

	// Back to chat, retype the draft, send: the message and a run card appear.
	await agentSection.getByRole("link", { name: "Back to chat" }).click();
	const composerAfter = page.getByRole("form", { name: "Research composer" });
	await expect(composerAfter).toBeVisible();
	await composerAfter
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");
	await composerAfter.getByRole("button", { name: "Send question" }).click();
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.getByRole("article", { name: "Your message" })).toContainText(
		"Which storage products will see demand growth?",
	);
	await expect(thread.locator("[data-run-state]")).toHaveCount(1, { timeout: 30_000 });
});

test("an upgrade keeps the last question's backend so sending works without visiting Settings", async ({
	browser,
}) => {
	// A second owner (the E2E Worker routes `X-E2E-Owner` to a separate
	// identity): the first test already saved settings, and this owner never
	// did — like an installation from before Settings → AI agent existed.
	const upgradeOwner = `e2e-upgrade-${Date.now()}@example.test`;
	const ownerHeaders = {
		"X-E2E-Owner": upgradeOwner,
		Origin: E2E_ORIGIN,
		"X-Research-Csrf": "1",
		"Content-Type": "application/json",
	};
	const created = await page.request.post(`${E2E_ORIGIN}/api/v1/workspaces`, {
		headers: ownerHeaders,
		data: { title: `Upgrade ${Date.now()}` },
	});
	expect(created.status()).toBe(201);
	const workspaceId = (await created.json()).workspaceId as string;
	const runResponse = await page.request.post(`${E2E_ORIGIN}/api/v1/research-runs`, {
		headers: { ...ownerHeaders, "Idempotency-Key": `idem-e2e-upgrade-${Date.now()}` },
		data: {
			workspaceId,
			question: "Which storage products saw demand growth?",
			agentId: "claude-code",
			model: null,
			effort: "medium",
			horizonYears: 4,
			markets: ["JP", "US"],
			budget: {
				maxAgentSteps: 6,
				maxToolCalls: 20,
				maxWallClockMs: 600_000,
				maxInputBytes: 400_000,
				maxSpendUsd: null,
			},
			webAccess: "off",
		},
	});
	expect(runResponse.status()).toBe(202);

	// No settings saved, but the last question supplies the backend.
	const settings = await (
		await page.request.get(`${E2E_ORIGIN}/api/v1/settings/agent`, {
			headers: { "X-E2E-Owner": upgradeOwner },
		})
	).json();
	expect(settings.updatedAt).toBeNull();
	expect(settings.origin).toBe("carried-over");
	expect(settings.settings.defaultAgentId).toBe("claude-code");

	// In the browser as that owner the send button is enabled with the
	// carried-over note, and sending works.
	const upgrade = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": upgradeOwner } });
	const second = await upgrade.newPage();
	try {
		await second.goto("/");
		await expect(second).toHaveURL(/#\/chat\/ws_/, { timeout: 30_000 });
		const composer = second.getByRole("form", { name: "Research composer" });
		await expect(composer).toContainText("Using the backend of your last question");
		await composer
			.getByRole("textbox", { name: "Question" })
			.fill("Which products will see further demand growth?");
		await expect(composer.getByRole("button", { name: "Send question" })).toBeEnabled();
		await composer.getByRole("button", { name: "Send question" }).click();
		const thread = second.getByRole("list", { name: "Messages" });
		// The API-created run left the first owner message; the sent draft is the newest one.
		await expect(thread.getByRole("article", { name: "Your message" }).last()).toContainText(
			"Which products will see further demand growth?",
		);
		await expect(thread.locator("[data-run-state]")).toHaveCount(2, { timeout: 30_000 });
	} finally {
		await upgrade.close();
	}
});

test("the owner is signed in and creates a chat", async () => {
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1, name: "Research workspace" })).toBeVisible();
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page.getByRole("navigation", { name: "Chats" })).toContainText("New chat");
	await expect(page).toHaveURL(/#\/chat\/ws_/);
});

test("a news source is previewed first and subscribed only on an explicit click (FR-001, FR-002)", async () => {
	await page.getByRole("link", { name: "Sources", exact: true }).click();
	const subscribed = page.getByRole("region", { name: "Subscribed sources" });
	await expect(subscribed).toBeVisible();

	// An unsafe target is refused before anything is fetched.
	await page.getByLabel("Feed or site URL").fill("https://169.254.169.254/latest/meta-data/");
	await page.getByRole("button", { name: "Preview source" }).click();
	await expect(page.locator('[data-error-code="UNSAFE_URL"]')).toBeVisible();

	await page.getByLabel("Feed or site URL").fill(FEED_URL);
	await page.getByRole("button", { name: "Preview source" }).click();
	const preview = page.getByRole("region", { name: "Source preview" });
	await expect(preview).toContainText("Example Energy News (synthetic)");
	await expect(preview).toContainText(HEADLINE);
	// Previewing alone subscribes to nothing.
	await expect(subscribed.getByRole("row")).toHaveCount(0);

	// The owner states that this (synthetic) source permits short excerpts.
	await preview.getByLabel("License policy").selectOption("short-excerpt-permitted");
	await preview.getByRole("button", { name: "Subscribe to this source" }).click();
	await expect(subscribed).toContainText("Example Energy News (synthetic)");
});

test("a question runs to a sourced report, table and chart (FR-004, FR-005, FR-010, FR-011, FR-012)", async () => {
	// Agent choices are made once in Settings → AI agent, not on the question form.
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible();
	const backend = agentSection.getByLabel("Default backend");
	// The backend list comes from what the runner reported, including an extension backend.
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 30_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	// An earlier test may already have saved this exact backend, in which case
	// there is nothing to save; the Saved stamp below is shown either way.
	const save = agentSection.getByRole("button", { name: "Save" });
	if (await save.isEnabled()) await save.click();
	await expect(agentSection).toContainText(/Saved /);

	await page.getByRole("link", { name: "Chat", exact: true }).click();
	const composer = page.getByRole("form", { name: "Research composer" });
	await expect(composer).toContainText("Scripted example agent");
	await composer
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");

	// Limits and the cost statement live in Settings → AI agent; the composer
	// shows only the backend/model/effort/web-access summary and is never $0.
	await expect(composer).toContainText("Scripted example agent");
	await expect(composer).not.toContainText("$0");

	await composer.getByRole("button", { name: "Send question" }).click();

	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.locator('[data-run-state="completed"]')).toBeVisible({ timeout: 60_000 });
	// The compact run card shows state only: no Run details disclosure, cost, limits or provenance.
	await expect(thread.getByText("Run details")).toHaveCount(0);

	// The answer arrives in the conversation with its claims.
	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(conversation.getByRole("article", { name: "Assistant message" })).toContainText(
		"1 of 2 claim(s) are supported",
	);
	// A citation chip opens its source card with an Open source link.
	await conversation
		.getByRole("button", { name: /^Source 1:/ })
		.first()
		.click();
	await expect(conversation.getByRole("link", { name: "Open source" }).first()).toBeVisible();

	const canvas = page.getByRole("region", { name: "Canvas" });
	for (const type of ["research-report", "source-list", "data-table", "bar-chart"]) {
		await expect(canvas.locator(`[data-component-type="${type}"]`).first()).toBeVisible();
	}
	// No component fell back to an error placeholder.
	await expect(canvas.locator("[data-fallback]")).toHaveCount(0);
	// Exactly one report exists: the model's own attempt to author one was refused.
	await expect(canvas.locator('[data-component-type="research-report"]')).toHaveCount(1);
	await expect(canvas).not.toContainText("Trust me");
	// The supplier's listing was proposed by the model, so it is shown as unverified.
	await expect(canvas).toContainText("not verified against an exchange listing");

	// The report separates the supported finding from the fabricated one.
	const report = canvas.locator('[data-component-type="research-report"]');
	await expect(report).toContainText("Supported findings");
	await expect(report).toContainText("Grid storage orders reached 100 GWh in 2026.");
	await expect(report).toContainText("Unsupported statements (not verified)");
	await expect(report).toContainText("Orders will certainly triple next year.");
	await expect(report).toContainText("not investment advice");
	// The real finding carries a "supported" badge and the fabricated one an "unsupported" one.
	await expect(report.locator('[data-claim-id$="_cl1"]')).toContainText(/supported/i);
	await expect(report.locator('[data-claim-id$="_cl2"]')).toContainText(/unsupported/i);
	// The model's narrative ("999%") is never published anywhere on the page.
	await expect(page.locator("body")).not.toContainText("999%");

	// Every source is a real link to the retrieved article, with tracking parameters stripped.
	const sourceLink = canvas
		.locator('[data-component-type="source-list"]')
		.getByRole("link", { name: new RegExp(HEADLINE) });
	await expect(sourceLink).toHaveAttribute(
		"href",
		"https://news.example.org/articles/grid-storage-orders",
	);
	await expect(sourceLink).toHaveAttribute("rel", /noopener/);

	// The chart is derived (20% a year for the base case) and has an accessible name.
	await expect(
		canvas.getByRole("img", { name: /Bar chart: Derived compound annual growth/ }),
	).toBeVisible();
});

test("the chat page stays usable on narrow screens and keeps its desktop layout at lg", async () => {
	await page.setViewportSize({ width: 420, height: 860 });
	try {
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		const composer = page.getByRole("form", { name: "Research composer" });
		await expect(composer).toBeVisible();
		const thread = page.getByRole("list", { name: "Messages" });
		await expect(thread).toBeVisible();

		// 1. The input area has an opaque background, so thread content never shows through it.
		const background = await composer.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		expect(background).not.toBe("rgba(0, 0, 0, 0)");

		// 3. The history is collapsed and the thread starts within the first viewport.
		await page.evaluate(() => window.scrollTo(0, 0));
		const historyOpen = await page
			.locator('details[data-conversations-disclosure="true"]')
			.evaluate((element) => (element as HTMLDetailsElement).open);
		expect(historyOpen).toBe(false);
		const firstInView = await page.evaluate(() => {
			const first = document.querySelector('ol[aria-label="Messages"] > li');
			if (!(first instanceof HTMLElement)) return false;
			return first.getBoundingClientRect().top < window.innerHeight;
		});
		expect(firstInView).toBe(true);

		// 2. The last thread item scrolls fully above the sticky input area.
		const lastItem = thread.locator(":scope > li").last();
		await lastItem.evaluate((element) => element.scrollIntoView({ block: "start" }));
		const noOverlap = await page.evaluate(() => {
			const list = document.querySelector('ol[aria-label="Messages"]');
			const lastItem = list?.lastElementChild;
			const form = document.querySelector('form[aria-label="Research composer"]');
			if (!(lastItem instanceof HTMLElement) || !(form instanceof HTMLElement)) return false;
			const itemBox = lastItem.getBoundingClientRect();
			const formBox = form.getBoundingClientRect();
			return itemBox.bottom <= formBox.top + 1;
		});
		expect(noOverlap).toBe(true);

		// 4. At lg the chats list sits beside the thread and the page itself does not scroll.
		await page.setViewportSize({ width: 1440, height: 900 });
		const nav = page.getByRole("navigation", { name: "Chats" });
		await expect(nav).toBeVisible();
		const sideBySide = await page.evaluate(() => {
			const navElement = document.querySelector('nav[aria-label="Chats"]');
			const listElement = document.querySelector('ol[aria-label="Messages"]');
			if (!(navElement instanceof HTMLElement) || !(listElement instanceof HTMLElement)) {
				return false;
			}
			const navBox = navElement.getBoundingClientRect();
			const listBox = listElement.getBoundingClientRect();
			return navBox.x + navBox.width <= listBox.x + 1;
		});
		expect(sideBySide).toBe(true);
		const pageScrolls = await page.evaluate(
			() => document.documentElement.scrollHeight <= window.innerHeight,
		);
		expect(pageScrolls).toBe(true);

		await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible();
	} finally {
		await page.setViewportSize({ width: 1280, height: 720 });
	}
});

test("hostile model text is rendered as inert text, never as markup (SEC-003, UI-005)", async () => {
	const report = page.locator('[data-component-type="research-report"]');
	// The literal markup is visible as text...
	await expect(report).toContainText('<img src=x onerror="window.__xss=1">');
	// ...and created no element and ran no script.
	await expect(report.locator("img")).toHaveCount(0);
	await expect(page.locator("script:not([src])")).toHaveCount(0);
	expect(await xssFlag(page)).toBeUndefined();
	expect(dialogs).toEqual([]);
});

test("the conversation, canvas and run survive a reload without re-running research (FR-010)", async () => {
	const canvas = page.getByRole("region", { name: "Canvas" });
	const before = await canvas
		.locator("[data-component-id]")
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-component-id")));
	expect(before.length).toBeGreaterThanOrEqual(5);
	const versionBefore = await canvas.getByText(/Workspace version \d+/).textContent();

	await page.reload();

	await expect(canvas.locator("[data-component-id]").first()).toBeVisible();
	const after = await canvas
		.locator("[data-component-id]")
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-component-id")));
	expect(after).toEqual(before);
	await expect(canvas.getByText(/Workspace version \d+/)).toHaveText(versionBefore ?? "");

	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await expect(
		page
			.getByRole("region", { name: "Conversation" })
			.getByRole("article", { name: "Assistant message" }),
	).toContainText("1 of 2 claim(s) are supported");
	// Exactly one run exists: the reload did not start another.
	await expect(
		page.getByRole("list", { name: "Messages" }).locator("[data-run-state]"),
	).toHaveCount(1);

	await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible();
});

test("the owner can remove a component and the change persists (journey 6)", async () => {
	const canvas = page.getByRole("region", { name: "Canvas" });
	const sources = canvas.locator('[data-component-type="source-list"]');
	const componentId = await sources.getAttribute("data-component-id");
	expect(componentId).not.toBeNull();
	await canvas.getByRole("button", { name: `Remove ${componentId}` }).click();
	await expect(sources).toHaveCount(0);
	await page.reload();
	await expect(canvas.locator("[data-component-id]").first()).toBeVisible();
	await expect(canvas.locator('[data-component-type="source-list"]')).toHaveCount(0);
});

test("an invalid UI command is rejected by the server and changes nothing (hard gate 4)", async () => {
	const workspaceId = /#\/(?:chat|canvas|workspace)\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	const canvas = page.getByRole("region", { name: "Canvas" });
	const count = await canvas.locator("[data-component-id]").count();
	const version = Number(
		/\d+/.exec((await canvas.getByText(/Workspace version \d+/).textContent()) ?? "")?.[0],
	);

	const response = await page.request.post(`/api/v1/workspaces/${workspaceId}/commands`, {
		headers: { "X-Research-Csrf": "1", Origin: new URL(page.url()).origin },
		data: {
			protocolVersion: 1,
			commandId: `e2e_${Date.now()}`,
			workspaceId,
			expectedWorkspaceVersion: version,
			operation: "component.create",
			componentId: "evil",
			componentType: "raw-html",
			schemaVersion: 1,
			props: { html: "<script>window.__xss=1</script>" },
		},
	});
	expect(response.status()).toBe(422);
	expect((await response.json()).error.detail).toBe("UNKNOWN_COMPONENT_TYPE");

	// A write without the CSRF header is refused outright.
	const forged = await page.request.post(`/api/v1/workspaces/${workspaceId}/commands`, {
		headers: { Origin: "https://evil.example" },
		data: {},
	});
	expect(forged.status()).toBe(403);

	await page.reload();
	await expect(canvas.locator("[data-component-id]")).toHaveCount(count);
	expect(await xssFlag(page)).toBeUndefined();
});

test("a 260-character unbroken word stays inside the thread column", async () => {
	await page.setViewportSize({ width: 1440, height: 900 });
	try {
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		const composer = page.getByRole("form", { name: "Research composer" });
		await expect(composer).toBeVisible();
		const thread = page.getByRole("list", { name: "Messages" });
		await expect(thread.locator('article[aria-label="Your message"]')).toHaveCount(1);

		const longWord = "x".repeat(260);
		await composer.getByRole("textbox", { name: "Question" }).fill(`Research ${longWord} demand?`);
		await composer.getByRole("button", { name: "Send question" }).click();
		await expect(thread.locator('article[aria-label="Your message"]')).toHaveCount(2, {
			timeout: 30_000,
		});
		await expect(thread.locator("[data-run-state]")).toHaveCount(2, { timeout: 30_000 });
		// The compact run card has no details to open: the question lives in the owner bubble.

		const geometry = await page.evaluate(() => {
			const list = document.querySelector('ol[aria-label="Messages"]');
			if (!(list instanceof HTMLElement)) return null;
			const listBox = list.getBoundingClientRect();
			const check = (element: Element) => {
				if (!(element instanceof HTMLElement)) return { ok: false };
				const box = element.getBoundingClientRect();
				return {
					ok: element.scrollWidth <= element.clientWidth + 1 && box.right <= listBox.right + 1,
				};
			};
			return {
				threadOk: list.scrollWidth <= list.clientWidth + 1,
				bubbles: [...list.querySelectorAll('article[aria-label="Your message"]')].map(check),
				cards: [...document.querySelectorAll('article[aria-label^="Run "]')].map(check),
			};
		});
		expect(geometry).not.toBeNull();
		expect(geometry?.threadOk).toBe(true);
		for (const bubble of geometry?.bubbles ?? []) expect(bubble.ok).toBe(true);
		for (const card of geometry?.cards ?? []) expect(card.ok).toBe(true);
	} finally {
		await page.setViewportSize({ width: 1280, height: 720 });
	}
});

test("on a tall narrow screen the input rests at the bottom of the viewport", async () => {
	await page.setViewportSize({ width: 820, height: 1180 });
	try {
		await page.getByRole("link", { name: "Chat", exact: true }).click();
		await page.locator('details[data-conversations-disclosure="true"] > summary').click();
		await page
			.getByRole("navigation", { name: "Chats" })
			.getByRole("button", { name: "New chat", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { level: 3, name: "What would you like to research?" }),
		).toBeVisible();
		const gap = await page.evaluate(() => {
			const form = document.querySelector('form[aria-label="Research composer"]');
			if (!(form instanceof HTMLElement)) return -1;
			return window.innerHeight - form.getBoundingClientRect().bottom;
		});
		expect(gap).toBeGreaterThanOrEqual(0);
		expect(gap).toBeLessThanOrEqual(24);
	} finally {
		await page.setViewportSize({ width: 1280, height: 720 });
	}
});

test("the question input grows with a long draft and stays within its cap (all engines)", async () => {
	// Chromium grows the textarea through CSS `field-sizing: content`;
	// engines without it use the script fallback (`apps/web/src/chat/autogrow.ts`).
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	const composer = page.getByRole("form", { name: "Research composer" });
	const input = composer.getByRole("textbox", { name: "Question" });
	await input.fill("one line");
	const oneLine = await input.evaluate((element) => element.getBoundingClientRect().height);
	await input.fill(
		Array.from(
			{ length: 10 },
			(_, index) => `Line ${index + 1} of a draft that keeps growing`,
		).join("\n"),
	);
	// The script fallback refits after Solid renders, so poll rather than reading once.
	await expect
		.poll(async () => input.evaluate((element) => element.getBoundingClientRect().height), {
			timeout: 10_000,
		})
		.toBeGreaterThan(oneLine);
	const cap = await input.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).maxHeight),
	);
	expect(cap).toBeGreaterThan(oneLine);
	const grownHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
	expect(grownHeight).toBeLessThanOrEqual(cap + 1);
	await input.fill("");
});

test("a clipboard failure shows Copy failed instead of an unhandled rejection (all engines)", async () => {
	// Every engine gets the same denied clipboard, so the failure path is
	// exercised identically (automation cannot grant real clipboard
	// permissions outside Chromium, and this suite must not depend on them).
	// The previous test leaves an empty conversation selected, so first open
	// the conversation holding the most messages — it has an answer to copy.
	const listing = await page.request.get(`${E2E_ORIGIN}/api/v1/conversations`);
	const body = (await listing.json()) as {
		conversations?: { readonly workspaceId: string; readonly messageCount: number }[];
	};
	const busiest = [...(body.conversations ?? [])].sort(
		(a, b) => b.messageCount - a.messageCount,
	)[0];
	if (busiest === undefined) throw new Error("expected a conversation with messages for E2E");
	await page.goto(`/#/chat/${busiest.workspaceId}`);
	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(
		conversation.getByRole("article", { name: "Assistant message" }).first(),
	).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => {
		const denied = () => Promise.reject(new Error("clipboard denied for E2E"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: denied, readText: denied },
			configurable: true,
		});
	});
	const errorsBefore = consoleErrors.length;
	const copy = page.getByRole("button", { name: "Copy answer" }).first();
	await copy.click();
	await expect(page.getByRole("button", { name: "Copy failed" }).first()).toBeVisible({
		timeout: 10_000,
	});
	expect(consoleErrors.length).toBe(errorsBefore);
});

test("the page ran under its Content-Security-Policy without errors", async () => {
	const response = await page.request.get("/");
	expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});

test("a chat can be renamed and deleted", async () => {
	await page.goto("/");
	const nav = page.getByRole("navigation", { name: "Chats" });
	await expect(nav).toBeVisible();
	const chatName = `E2E rename ${Date.now()}`;
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const more = nav.getByRole("button", { name: "More actions for New chat" }).first();
	await more.click();
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await page.getByLabel("Chat title").fill(chatName);
	// Keyboard press (not locator press): a failed rename exits edit mode and
	// unmounts the input, which locator.press would chase until timeout.
	await page.keyboard.press("Enter");
	await expect(nav).toContainText(chatName, { timeout: 10_000 });
	const moreAfter = nav.getByRole("button", { name: `More actions for ${chatName}` }).first();
	await moreAfter.click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText(chatName);
	await expect(dialog).toContainText("cannot be undone");
	await dialog.getByRole("button", { name: "Delete" }).click();
	await expect(nav).not.toContainText(chatName);
});
