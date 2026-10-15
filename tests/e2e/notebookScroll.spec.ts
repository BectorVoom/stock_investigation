import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Untitled widget frames and drag inside a scrolling notebook (W5,
 * ADR-0021). Isolated owner, no agent backend: widgets are written through
 * the notebook API like the 200-widget test in `notebook.spec.ts` does.
 *
 * Contract coverage: a notebook of 40 widgets scrolls inside
 * `[data-notebook-scroll]` on wheel (Notebook-first and the Chat-first
 * narrow panel), every widget is reachable by wheel and keyboard focus with
 * the last fully visible, no widget shows a visible title (the `h3` is
 * visually hidden) while the grip and actions reveal on hover, dragging
 * from the top to the bottom edge auto-scrolls the container and the drop
 * persists across reload, and Home still shows titles.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let workspaceId = "";
const consoleErrors: string[] = [];
// Isolated owner: this file's chats and notebook are its own, whatever the
// file order. No runner harness: nothing here talks to an agent.
const owner = `e2e-notebook-scroll-${Date.now()}@example.test`;

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
	await context.close();
});

/**
 * A screenshot for reading the layout, taken on Chromium only: Playwright's
 * WebKit screenshot injects a <style> the app's CSP refuses, which would be
 * logged as a console error this spec fails on.
 */
async function reviewShot(name: string): Promise<void> {
	if (page.context().browser()?.browserType().name() !== "chromium") return;
	await page.screenshot({ path: test.info().outputPath(name) });
}

/** The Notebook's widgets only: thread previews use the same frame. */
function notebookArticles() {
	return page.locator('div[data-panel="notebook"] article[data-widget-id]');
}

function scrollContainer() {
	return page.locator('div[data-panel="notebook"] [data-notebook-scroll]');
}

async function containerScrollTop(): Promise<number> {
	return scrollContainer().evaluate((element) => element.scrollTop);
}

/**
 * Waits until the wanted panel is more than twice the other: the switch
 * animates `grid-template-columns`, so a screenshot right after the mode
 * flips still sees the old proportions.
 */
async function expectDominant(panel: "chat" | "notebook"): Promise<void> {
	await expect
		.poll(async () => {
			const chatBox = await page.locator('section[data-panel="chat"]').boundingBox();
			const notebookBox = await page.locator('div[data-panel="notebook"]').boundingBox();
			if (chatBox === null || notebookBox === null) throw new Error("workspace panels missing");
			return panel === "chat"
				? chatBox.width > notebookBox.width * 2
				: notebookBox.width > chatBox.width * 2;
		})
		.toBe(true);
}

/**
 * Clicks the mode switch until the panel reports the wanted mode (a click
 * during the post-reload load can lose to the restored mode, so poll on the
 * panel's own `data-mode` instead of clicking once).
 */
async function focusPanel(panel: "chat" | "notebook"): Promise<void> {
	const name = panel === "chat" ? "Focus Chat" : "Focus Notebook";
	await expect
		.poll(
			async () => {
				const current = await page
					.locator('section[data-panel="notebook"]')
					.first()
					.getAttribute("data-mode");
				if (current === panel) return true;
				await page.getByRole("button", { name }).first().click();
				return false;
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
}

/**
 * The center of a widget near a point: nudges past row gaps so the drop
 * lands on a widget, never in a gap where the engine holds the target.
 */
async function pointOnWidget(
	x: number,
	y: number,
): Promise<{ readonly x: number; readonly y: number; readonly id: string }> {
	for (const dy of [0, 12, -12, 24, -24, 40, -40]) {
		const hit = await page.evaluate(
			(point: { readonly x: number; readonly y: number }) => {
				const frames = [...document.elementsFromPoint(point.x, point.y)]
					.filter(
						(element): element is HTMLElement =>
							element instanceof HTMLElement &&
							element.closest("article[data-widget-id]") !== null &&
							element.closest("[data-widget-dragging]") === null,
					)
					.map((element) => element.closest("article[data-widget-id]"));
				const frame = frames[0];
				if (!(frame instanceof HTMLElement)) return null;
				const box = frame.getBoundingClientRect();
				return {
					id: frame.getAttribute("data-widget-id"),
					cx: box.x + box.width / 2,
					cy: box.y + box.height / 2,
				};
			},
			{ x, y: y + dy },
		);
		if (hit?.id !== null && hit?.id !== undefined) return { x: hit.cx, y: hit.cy, id: hit.id };
	}
	throw new Error("no widget near the drop point");
}

/** True when the last widget is fully inside the scroll container. */
async function lastWidgetFullyVisible(): Promise<{
	readonly top: boolean;
	readonly bottom: boolean;
}> {
	return page.evaluate(() => {
		const scroller = document.querySelector('div[data-panel="notebook"] [data-notebook-scroll]');
		const articles = [
			...document.querySelectorAll('div[data-panel="notebook"] article[data-widget-id]'),
		];
		const last = articles[articles.length - 1];
		if (!(scroller instanceof HTMLElement) || !(last instanceof HTMLElement)) {
			throw new Error("notebook scroll container or widgets missing");
		}
		const outer = scroller.getBoundingClientRect();
		const inner = last.getBoundingClientRect();
		return { top: inner.top >= outer.top - 1, bottom: inner.bottom <= outer.bottom + 1 };
	});
}

test("a new chat opens Chat-first with Chat wider than the Notebook", async () => {
	await page.goto("/#/chat");
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	workspaceId = /#\/chat\/([^/?]+)/.exec(page.url())?.[1] ?? "";
	expect(workspaceId).toMatch(/^ws_/);
});

test("forty widgets written through the API render in the notebook", async () => {
	test.setTimeout(120_000);
	const notebookUrl = `${E2E_ORIGIN}/api/v1/workspaces/${workspaceId}/notebook`;
	const read = await page.request.get(notebookUrl);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		notebook: { widgets: unknown[] };
		version: number;
	};
	const now = new Date().toISOString();
	const sizes = ["large", "medium", "small"] as const;
	const filler = Array.from({ length: 40 }, (_, index) => ({
		widgetId: `nb_scroll_${index}`,
		type: "text",
		title: `Scroll note ${index + 1}`,
		size: sizes[index % 3] ?? "small",
		text: `Observation ${index + 1}: inventory days fell while the order book grew.`,
		createdAt: now,
		updatedAt: now,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
	}));
	const saved = await page.request.put(notebookUrl, {
		headers: { Origin: E2E_ORIGIN, "X-Research-Csrf": "1", "Content-Type": "application/json" },
		data: {
			notebook: { widgets: [...stored.notebook.widgets, ...filler] },
			expectedVersion: stored.version,
		},
	});
	expect(saved.status()).toBe(200);

	await page.reload();
	await expect(notebookArticles()).toHaveCount(40, { timeout: 30_000 });
	await focusPanel("notebook");
	await expectDominant("notebook");
	// Let the 150 ms column transition settle so the screenshot shows the
	// switched layout, not a frame halfway through it.
	await page.waitForTimeout(400);
	await reviewShot("notebook-first.png");
});

test("the scroll container scrolls on wheel and reaches the last widget", async () => {
	const container = scrollContainer();
	await expect(container).toBeVisible();
	expect(await containerScrollTop()).toBe(0);
	const box = await container.boundingBox();
	if (box === null) throw new Error("scroll container has no box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, 600);
	await expect.poll(containerScrollTop).toBeGreaterThan(0);

	const last = notebookArticles().last();
	await last.evaluate((element) => element.scrollIntoView({ block: "end" }));
	await expect.poll(lastWidgetFullyVisible).toEqual({ top: true, bottom: true });
});

test("keyboard focus scrolls widgets into view", async () => {
	await scrollContainer().evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.evaluate(() => {
		const bodies = [...document.querySelectorAll('div[data-panel="notebook"] .wg-body')];
		const first = bodies[0];
		if (!(first instanceof HTMLElement)) throw new Error("no first widget body");
		first.focus();
	});
	// Tab advances focus to another widget of the notebook.
	await page.keyboard.press("Tab");
	const focusedWidget = await page.evaluate(() => {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement)) return null;
		return active
			.closest('div[data-panel="notebook"] article[data-widget-id]')
			?.getAttribute("data-widget-id");
	});
	expect(focusedWidget).not.toBeNull();

	// Focusing the last body brings it fully into view. WebKit performs
	// the focus scroll on a later frame, so poll until it settles.
	await page.evaluate(() => {
		const bodies = [...document.querySelectorAll('div[data-panel="notebook"] .wg-body')];
		const lastBody = bodies[bodies.length - 1];
		if (!(lastBody instanceof HTMLElement)) throw new Error("no last widget body");
		lastBody.focus();
	});
	const bodyVisible = () =>
		page.evaluate(() => {
			const scroller = document.querySelector('div[data-panel="notebook"] [data-notebook-scroll]');
			const bodies = [...document.querySelectorAll('div[data-panel="notebook"] .wg-body')];
			const lastBody = bodies[bodies.length - 1];
			if (!(scroller instanceof HTMLElement) || !(lastBody instanceof HTMLElement)) {
				throw new Error("notebook scroll container or widget bodies missing");
			}
			const outer = scroller.getBoundingClientRect();
			const inner = lastBody.getBoundingClientRect();
			return {
				scrollTop: scroller.scrollTop,
				top: inner.top >= outer.top - 1,
				bottom: inner.bottom <= outer.bottom + 1,
			};
		});
	const scrolled = await bodyVisible();
	expect(scrolled.scrollTop).toBeGreaterThan(0);
	await expect
		.poll(async () => {
			const state = await bodyVisible();
			return state.top && state.bottom;
		})
		.toBe(true);
	expect(scrolled.top).toBe(true);
	expect(scrolled.bottom).toBe(true);
});

test("notebook widgets show no visible title; controls reveal on hover", async () => {
	// Park the pointer and clear focus so no frame reveals its controls.
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
	await page.getByRole("region", { name: "Notebook" }).hover();
	const titles = await page.evaluate(() => {
		const articles = [
			...document.querySelectorAll('div[data-panel="notebook"] article[data-widget-id]'),
		];
		return articles.map((node) => {
			if (!(node instanceof HTMLElement)) throw new Error("non-element article");
			const heading = node.querySelector("h3");
			if (!(heading instanceof HTMLElement)) throw new Error("widget without a title element");
			const style = getComputedStyle(heading);
			return {
				className: heading.className,
				position: style.position,
				width: style.width,
				height: style.height,
				marked: node.hasAttribute("data-widget-title-hidden"),
			};
		});
	});
	expect(titles).toHaveLength(40);
	for (const title of titles) {
		expect(title.className).toContain("wg-visually-hidden");
		expect(title.position).toBe("absolute");
		expect(title.width).toBe("1px");
		expect(title.height).toBe("1px");
		expect(title.marked).toBe(true);
	}

	// The quiet reveal: hidden until hovered, shown on hover.
	const first = notebookArticles().first();
	const gripOpacity = () =>
		first.locator(".wg-grip").evaluate((element) => getComputedStyle(element).opacity);
	await expect.poll(gripOpacity).toBe("0");
	await first.hover();
	await expect.poll(gripOpacity).toBe("1");
	await expect
		.poll(() =>
			first.locator(".wg-header-actions").evaluate((element) => getComputedStyle(element).opacity),
		)
		.toBe("1");
});

test("dragging to the bottom edge auto-scrolls the container and persists", async () => {
	test.setTimeout(120_000);
	await focusPanel("notebook");
	await scrollContainer().evaluate((element) => {
		element.scrollTop = 0;
	});
	const before = await notebookArticles().evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	const draggedId = before[0];
	if (draggedId === null || draggedId === undefined) throw new Error("no first widget");

	// The grip is the drag handle in untitled frames: press it, not the strip.
	const gripBox = await notebookArticles().first().locator(".wg-grip").boundingBox();
	if (gripBox === null) throw new Error("grip has no box");
	await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
	await page.mouse.down();
	const containerBox = await scrollContainer().boundingBox();
	if (containerBox === null) throw new Error("scroll container has no box");
	const edgeX = containerBox.x + containerBox.width / 2;
	const edgeY = containerBox.y + containerBox.height - 30;
	await page.mouse.move(edgeX, edgeY, { steps: 20 });
	// The container auto-scrolls while the pointer rests in the edge zone:
	// hold it there deep into the 40-widget list.
	await expect.poll(containerScrollTop, { timeout: 30_000 }).toBeGreaterThan(1500);
	// Drop onto a widget in the left column back in the middle: the edge
	// column center can sit in the grid gutter, where the engine correctly
	// holds the target instead of dropping.
	const columnX = containerBox.x + containerBox.width * 0.25;
	const middleY = containerBox.y + containerBox.height / 2;
	const drop = await pointOnWidget(columnX, middleY);
	await page.mouse.move(drop.x, drop.y, { steps: 10 });
	const underId = await page.evaluate(
		(point: { readonly x: number; readonly y: number }) => {
			const frames = [...document.elementsFromPoint(point.x, point.y)]
				.map((element) =>
					element instanceof Element ? element.closest("article[data-widget-id]") : null,
				)
				.filter(
					(frame): frame is HTMLElement =>
						frame instanceof HTMLElement && frame.closest("[data-widget-dragging]") === null,
				);
			return frames[0]?.getAttribute("data-widget-id") ?? null;
		},
		{ x: drop.x, y: drop.y },
	);
	if (underId === null) throw new Error("no widget under the drop point");
	// Let the engine settle on the drop point, then read the live preview
	// target (the placeholder's order) before releasing.
	await new Promise((resolve) => setTimeout(resolve, 800));
	const previewTarget = await page.evaluate(() => {
		const slot = document.querySelector('div[data-panel="notebook"] [data-widget-placeholder]');
		if (!(slot instanceof HTMLElement)) throw new Error("no drag placeholder");
		return slot.style.order;
	});
	await page.mouse.up();

	const moved = await notebookArticles().evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("data-widget-id")),
	);
	expect(moved).not.toEqual(before);
	const draggedIndex = moved.indexOf(draggedId);
	const underIndex = moved.indexOf(underId);
	// The widget left the top, landed where the pointer was (beside the
	// widget under it), and the live preview agreed before release.
	expect(draggedIndex).toBeGreaterThan(0);
	expect(Math.abs(draggedIndex - underIndex)).toBeLessThanOrEqual(2);
	expect(previewTarget).toBe(String(draggedIndex));
	// The save has landed once the Notebook's own Undo is available again.
	await expect(
		page.getByRole("region", { name: "Notebook" }).getByRole("button", { name: "Undo" }),
	).toBeEnabled({ timeout: 15_000 });
	await page.reload();
	await expect(notebookArticles()).toHaveCount(40, { timeout: 30_000 });
	await expect(
		notebookArticles().evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-widget-id")),
		),
	).resolves.toEqual(moved);
});

test("Chat-first still scrolls the narrow panel to every widget", async () => {
	await focusPanel("chat");
	const container = scrollContainer();
	await expect(container).toBeVisible();
	const scrollable = await container.evaluate(
		(element) => element.scrollHeight > element.clientHeight,
	);
	expect(scrollable).toBe(true);
	await container.evaluate((element) => {
		element.scrollTop = 0;
	});
	const box = await container.boundingBox();
	if (box === null) throw new Error("scroll container has no box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, 600);
	await expect.poll(containerScrollTop).toBeGreaterThan(0);
	const last = notebookArticles().last();
	await last.evaluate((element) => element.scrollIntoView({ block: "end" }));
	await expect.poll(lastWidgetFullyVisible).toEqual({ top: true, bottom: true });
	await expectDominant("chat");
	// Let the 150 ms column transition settle so the screenshot shows the
	// switched layout, not a frame halfway through it.
	await page.waitForTimeout(400);
	await reviewShot("chat-first.png");
});

test("Home still shows widget titles", async () => {
	const dashboardUrl = `${E2E_ORIGIN}/api/v1/home/dashboard`;
	const read = await page.request.get(dashboardUrl);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		dashboard: { widgets: unknown[] };
		version: number;
	};
	const saved = await page.request.put(dashboardUrl, {
		headers: { Origin: E2E_ORIGIN, "X-Research-Csrf": "1", "Content-Type": "application/json" },
		data: {
			dashboard: {
				schemaVersion: 1,
				widgets: [
					{
						widgetId: "home-scroll-t1",
						type: "earnings-calendar",
						title: "Home Earnings",
						size: "large",
						daysAhead: 30,
					},
				],
			},
			expectedVersion: stored.version,
		},
	});
	expect(saved.status()).toBe(200);

	await page.goto("/");
	const frame = page.locator('article[data-widget-id="home-scroll-t1"]');
	await expect(frame).toBeVisible({ timeout: 30_000 });
	const title = frame.locator("h3");
	await expect(title).toHaveText("Home Earnings");
	const style = await title.evaluate((element) => {
		const computed = getComputedStyle(element);
		return { className: element.className, position: computed.position, width: computed.width };
	});
	expect(style.className).toContain("wg-title");
	expect(style.className).not.toContain("wg-visually-hidden");
	expect(style.position).not.toBe("absolute");
	expect(Number.parseFloat(style.width)).toBeGreaterThan(1);
	// Console errors exclude the expected error paths (422/403).
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
