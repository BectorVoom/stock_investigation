/**
 * Scripted UI review of the Chat page (`bun run review:ui`).
 *
 * REVIEW, not a gate: it drives the real app through its states at four
 * viewport sizes, records one PNG per state plus
 * `test-results/ui-review/<engine>/findings.json`, and prints a summary table
 * (rule -> count) at the end. It never fails because of a finding — only
 * when the review itself could not run (the app did not start, a state could
 * not be reached). It is self-sufficient: it performs the minimum setup
 * itself (subscribe the fixture source, choose the scripted backend in
 * Settings, start a conversation, ask one question, wait for the answer)
 * instead of assuming another spec ran first. It reuses the E2E server stack
 * (web server, global setup, fixtures) through
 * `tests/ui-review/playwright.config.ts`.
 *
 * Known limitation: an element scrolled out of a scroll container can be
 * reported as "obscured" because `elementFromPoint` at its centre hits
 * whatever covers that viewport point. Findings are leads for a human (or an
 * agent reading the screenshots), not verdicts.
 *
 * The geometry/contrast audit runs inside the page (`page.evaluate`), where
 * imports cannot cross the serialization boundary — so its formulas are
 * intentionally duplicated there. The sharable pure parts (contrast math,
 * target-size rule, findings summary) live in `reviewMath.ts` and are
 * unit-tested in `reviewMath.test.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN, FEED_URL, HEADLINE } from "../e2e/fixtures.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

const REVIEW_BROWSER = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const OUT = process.env.UIREVIEW_OUT ?? `test-results/ui-review/${REVIEW_BROWSER}`;
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	"X-Research-Csrf": "1",
	"Content-Type": "application/json",
};

type Finding = ReviewFinding;
const findings: Finding[] = [];
const consoleProblems: string[] = [];

/** Geometry, contrast and naming checks evaluated inside the page. */
async function audit(page: Page, state: string): Promise<void> {
	const found = await page.evaluate(() => {
		const out: { rule: string; detail: string }[] = [];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const describe = (el: Element): string => {
			const label = el.getAttribute("aria-label") ?? "";
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
			return `<${el.tagName.toLowerCase()}${label ? ` aria-label="${label}"` : ""}> "${text}"`;
		};
		const visible = (el: Element): boolean => {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return false;
			const style = getComputedStyle(el);
			if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
				return false;
			// Visually hidden (sr-only) content is 1px clipped.
			if (rect.width <= 1 && rect.height <= 1) return false;
			// Content of a closed <details> is not rendered; only that element's own summary is.
			for (
				let box = el.parentElement?.closest("details") ?? null;
				box !== null;
				box = box.parentElement?.closest("details") ?? null
			) {
				if (box.open) continue;
				const ownSummary = el.closest("summary");
				if (ownSummary === null || ownSummary.parentElement !== box) return false;
			}
			if (el.closest("[inert]") !== null) return false;
			return true;
		};
		const inViewport = (rect: DOMRect): boolean =>
			rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;

		// 1. Horizontal overflow of the document.
		const doc = document.documentElement;
		if (doc.scrollWidth > vw + 1)
			out.push({
				rule: "horizontal-overflow",
				detail: `document is ${doc.scrollWidth}px wide in a ${vw}px viewport`,
			});

		// 2. Elements sticking out of the right edge.
		for (const el of Array.from(document.querySelectorAll("body *"))) {
			if (!visible(el)) continue;
			const rect = el.getBoundingClientRect();
			if (rect.right > vw + 1 && rect.left < vw && inViewport(rect))
				out.push({
					rule: "beyond-right-edge",
					detail: `${describe(el)} right=${Math.round(rect.right)} > ${vw}`,
				});
		}

		// 3. Interactive elements: obscured, tiny targets, missing names.
		const interactive = Array.from(
			document.querySelectorAll("button, a[href], input, textarea, select, summary"),
		).filter(visible);
		const composer = document.querySelector('form[aria-label="Research composer"]');
		const banner = document.querySelector("header");
		for (const el of interactive) {
			const rect = el.getBoundingClientRect();
			if (!inViewport(rect)) continue;
			const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
			const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
			const top = document.elementFromPoint(cx, cy);
			if (top !== null && top !== el && !el.contains(top) && !top.contains(el)) {
				const coveredBySticky =
					(composer?.contains(top) === true && composer?.contains(el) !== true) ||
					banner?.contains(top) === true;
				if (top.closest('[role="dialog"]') !== null && el.closest('[role="dialog"]') === null)
					continue;
				const label = top.closest("label");
				const labelsIt =
					label !== null && (label.contains(el) || label.getAttribute("for") === el.id);
				if (!labelsIt)
					out.push({
						rule: coveredBySticky ? "covered-by-pinned-area" : "obscured",
						detail: `${describe(el)} is covered at its centre by ${describe(top)}`,
					});
			}
			const inlineLink = el.tagName === "A" && getComputedStyle(el).display === "inline";
			if (!inlineLink && (rect.width < 24 || rect.height < 24)) {
				const isCheck =
					el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
				if (!isCheck)
					out.push({
						rule: "small-target",
						detail: `${describe(el)} is ${Math.round(rect.width)}x${Math.round(rect.height)}px (< 24x24)`,
					});
			}
			const name =
				(el.getAttribute("aria-label") ?? "").trim() ||
				(el.textContent ?? "").trim() ||
				(el.getAttribute("title") ?? "").trim() ||
				(el instanceof HTMLInputElement ||
				el instanceof HTMLTextAreaElement ||
				el instanceof HTMLSelectElement
					? (el.labels?.[0]?.textContent ?? "").trim() ||
						(el.getAttribute("placeholder") ?? "").trim()
					: "");
			if (name === "") out.push({ rule: "no-accessible-name", detail: describe(el) });
		}

		// 4. Text contrast (WCAG AA) against the nearest opaque background.
		const probe = document.createElement("canvas");
		probe.width = 1;
		probe.height = 1;
		const ink = probe.getContext("2d", { willReadFrequently: true });
		const colourCache = new Map<string, [number, number, number, number] | null>();
		const parse = (value: string): [number, number, number, number] | null => {
			const cached = colourCache.get(value);
			if (cached !== undefined) return cached;
			let result: [number, number, number, number] | null = null;
			if (ink !== null) {
				ink.clearRect(0, 0, 1, 1);
				ink.fillStyle = "rgba(0, 0, 0, 0)";
				ink.fillStyle = value;
				ink.fillRect(0, 0, 1, 1);
				const data = ink.getImageData(0, 0, 1, 1).data;
				result = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
			}
			colourCache.set(value, result);
			return result;
		};
		const luminance = (rgb: readonly number[]): number => {
			const channel = (value: number) => {
				const s = value / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			return (
				0.2126 * channel(rgb[0] ?? 0) +
				0.7152 * channel(rgb[1] ?? 0) +
				0.0722 * channel(rgb[2] ?? 0)
			);
		};
		const backgroundOf = (el: Element): [number, number, number] => {
			let node: Element | null = el;
			while (node !== null) {
				const bg = parse(getComputedStyle(node).backgroundColor);
				if (bg !== null && bg[3] >= 0.99) return [bg[0], bg[1], bg[2]];
				node = node.parentElement;
			}
			return [255, 255, 255];
		};
		const seen = new Set<string>();
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			const el = node.parentElement;
			if (el === null || (node.textContent ?? "").trim() === "" || !visible(el)) continue;
			if (!inViewport(el.getBoundingClientRect())) continue;
			const style = getComputedStyle(el);
			const fg = parse(style.color);
			if (fg === null) continue;
			const bg = backgroundOf(el);
			const l1 = luminance(fg);
			const l2 = luminance(bg);
			const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
			const size = Number.parseFloat(style.fontSize);
			const bold = Number(style.fontWeight) >= 700;
			const large = size >= 24 || (size >= 18.66 && bold);
			const disabled = el.closest("[disabled], [aria-disabled='true']") !== null;
			if (!disabled && ratio < (large ? 3 : 4.5)) {
				const key = `${style.color}|${bg.join(",")}|${el.tagName}`;
				if (!seen.has(key)) {
					seen.add(key);
					out.push({
						rule: "low-contrast",
						detail: `${describe(el)} ${ratio.toFixed(2)}:1 (${style.color} on rgb(${bg.join(", ")}), ${size}px)`,
					});
				}
			}
			if (size < 11) out.push({ rule: "tiny-text", detail: `${describe(el)} ${size}px` });
		}

		// 5. Heading order.
		let previous = 0;
		for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(
			visible,
		)) {
			const level = Number(heading.tagName.slice(1));
			if (previous !== 0 && level > previous + 1)
				out.push({
					rule: "heading-skip",
					detail: `h${previous} -> h${level}: ${describe(heading)}`,
				});
			previous = level;
		}

		// 5b. Content wider than its box inside the chat thread (long unbroken words, URLs).
		for (const el of Array.from(
			document.querySelectorAll('[aria-label="Messages"] *, [aria-label="Chats"] *'),
		)) {
			if (!visible(el)) continue;
			// Only CSS boxes can overflow (as the Home review checks): chart SVG
			// in the thread's result previews has no such box, and a rotated axis
			// title's unrotated scrollWidth says nothing about what is drawn.
			if (!(el instanceof HTMLElement)) continue;
			const style = getComputedStyle(el);
			if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
			if (style.textOverflow === "ellipsis") continue;
			if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && style.display !== "inline")
				out.push({
					rule: "content-wider-than-box",
					detail: `${describe(el)} content ${el.scrollWidth}px in a ${el.clientWidth}px box`,
				});
		}

		// 6. Clipped text without a way to read all of it.
		for (const el of Array.from(document.querySelectorAll("body *"))) {
			if (!visible(el) || el.children.length > 0) continue;
			const style = getComputedStyle(el);
			if (style.overflow === "visible" || el.scrollWidth <= el.clientWidth + 1) continue;
			if (!el.hasAttribute("title"))
				out.push({
					rule: "clipped-text",
					detail: `${describe(el)} shows ${el.clientWidth}px of ${el.scrollWidth}px, no title`,
				});
		}
		return out;
	});
	for (const item of found) findings.push({ state, ...item });
}

async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** Tabs through the page and reports focus stops without a visible indicator. */
async function auditFocus(page: Page, state: string, stops: number): Promise<void> {
	await page.locator("body").click({ position: { x: 2, y: 2 } });
	for (let index = 0; index < stops; index += 1) {
		await page.keyboard.press("Tab");
		const result = await page.evaluate(() => {
			const el = document.activeElement;
			if (el === null || el === document.body) return null;
			const style = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			const ring = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
			const shadow = style.boxShadow !== "none";
			// A focus style on a wrapper (focus-within) also counts.
			const wrapper =
				el.parentElement === null ? "none" : getComputedStyle(el.parentElement).boxShadow;
			const wrapperOutline =
				el.parentElement !== null && getComputedStyle(el.parentElement).outlineStyle !== "none";
			return {
				name: `<${el.tagName.toLowerCase()}> ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}`,
				indicated: ring || shadow || wrapper !== "none" || wrapperOutline,
				offscreen: rect.bottom < 0 || rect.top > window.innerHeight,
			};
		});
		if (result === null) continue;
		if (!result.indicated) findings.push({ state, rule: "focus-not-visible", detail: result.name });
		if (result.offscreen) findings.push({ state, rule: "focus-offscreen", detail: result.name });
	}
}

/**
 * Minimum setup so the review is self-sufficient: the scripted backend is
 * chosen in Settings, the fixture source is subscribed, and one conversation
 * holds a completed run. Mirrors the corresponding steps of
 * `tests/e2e/research.spec.ts` without importing them.
 */
async function ensurePrepared(page: Page): Promise<void> {
	await page.goto("/#/settings");
	const agentSection = page.getByRole("region", { name: "AI agent" });
	await expect(agentSection).toBeVisible({ timeout: 30_000 });
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 30_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	await agentSection.getByLabel("Model for this backend").selectOption("scripted/alpha");
	const save = agentSection.getByRole("button", { name: "Save" });
	if (await save.isEnabled()) await save.click();
	await expect(agentSection).toContainText(/Saved /);

	await page.getByRole("link", { name: "Sources", exact: true }).click();
	const subscribed = page.getByRole("region", { name: "Subscribed sources" });
	await expect(subscribed).toBeVisible();
	if ((await subscribed.getByRole("row").count()) === 0) {
		await page.getByLabel("Feed or site URL").fill(FEED_URL);
		await page.getByRole("button", { name: "Preview source" }).click();
		const preview = page.getByRole("region", { name: "Source preview" });
		await expect(preview).toContainText(HEADLINE);
		await preview.getByLabel("License policy").selectOption("short-excerpt-permitted");
		await preview.getByRole("button", { name: "Subscribe to this source" }).click();
		await expect(subscribed).toContainText("Example Energy News (synthetic)");
	}

	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await page
		.getByRole("navigation", { name: "Chats" })
		.getByRole("button", { name: "New chat", exact: true })
		.click();
	await expect(page).toHaveURL(/#\/chat\/ws_/);
	const composer = page.getByRole("form", { name: "Research composer" });
	await composer
		.getByRole("textbox", { name: "Question" })
		.fill("Which storage products will see demand growth?");
	await composer.getByRole("button", { name: "Send question" }).click();
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread.locator('[data-run-state="completed"]')).toBeAttached({ timeout: 90_000 });
}

test("UI review of the Chat page", async ({ browser }) => {
	test.setTimeout(600_000);
	mkdirSync(OUT, { recursive: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning")
			consoleProblems.push(`${message.type()}: ${message.text()}`);
	});
	page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));

	await ensurePrepared(page);

	/* ---------- A. Desktop, conversation with a completed run ---------- */
	// Open the conversation that has the most messages (the prepared one, or newer ones).
	const listing = await page.request.get(`${E2E_ORIGIN}/api/v1/conversations`);
	const listingSchema = z.object({
		conversations: z.array(z.object({ workspaceId: z.string(), messageCount: z.number() })),
	});
	const conversations = listingSchema.parse(await listing.json()).conversations;
	const busiest = [...conversations].sort((a, b) => b.messageCount - a.messageCount)[0];
	const chatUrl = busiest === undefined ? "/#/chat" : `/#/chat/${busiest.workspaceId}`;
	await page.goto(chatUrl);
	const thread = page.getByRole("list", { name: "Messages" });
	await expect(thread).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(600);
	await shot(page, "A1-desktop-thread");
	await audit(page, "A desktop thread");
	const pageScrolls = await page.evaluate(
		() => document.documentElement.scrollHeight > window.innerHeight + 1,
	);
	if (pageScrolls)
		findings.push({
			state: "A desktop thread",
			rule: "page-scrolls",
			detail: "the whole page scrolls at 1440x900; the thread should scroll inside its column",
		});

	// Is the newest message in view on load (stick to bottom)?
	const composer = page.getByRole("form", { name: "Research composer" });
	const lastItem = thread.locator(":scope > li").last();
	const lastBox = await lastItem.boundingBox();
	const composerBox = await composer.boundingBox();
	if (lastBox !== null && composerBox !== null && lastBox.y + lastBox.height > composerBox.y + 2)
		findings.push({
			state: "A desktop thread",
			rule: "newest-not-in-view",
			detail: `last thread item ends at ${Math.round(lastBox.y + lastBox.height)}, input starts at ${Math.round(composerBox.y)}`,
		});

	// Sources row expanded, then a citation chip pins its source card.
	const sourcesRow = page
		.getByRole("region", { name: "Conversation" })
		.locator("details", { hasText: "source" })
		.first();
	await sourcesRow.locator("summary").first().click();
	await page.waitForTimeout(300);
	await sourcesRow.scrollIntoViewIfNeeded();
	await shot(page, "A2-sources-open");
	await audit(page, "A sources row open");
	await sourcesRow.locator("summary").first().click();
	const sourceChip = page
		.getByRole("region", { name: "Conversation" })
		.getByRole("button", { name: /^Source \d+:/ })
		.first();
	if ((await sourceChip.count()) > 0) {
		await sourceChip.click();
		await page.waitForTimeout(300);
		await shot(page, "A2b-source-card");
		await audit(page, "A source card open");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	}

	// A chip in a thread result preview pins its source card inside that preview.
	const canvasChip = page.locator("[data-preview-component] [data-citation-chip]").first();
	if ((await canvasChip.count()) > 0) {
		await canvasChip.scrollIntoViewIfNeeded();
		await canvasChip.click();
		await page.waitForTimeout(300);
		await shot(page, "A2c-preview-source-card");
		await audit(page, "A preview source card open");
		const boxes = await page.evaluate(() => {
			const card = document.querySelector("[data-citation-card]");
			const panel = card?.closest("[data-preview-component]") ?? null;
			if (!(card instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
			const rect = (element: HTMLElement) => {
				const box = element.getBoundingClientRect();
				return { left: box.left, right: box.right };
			};
			return { card: rect(card), panel: rect(panel) };
		});
		if (boxes === null) {
			findings.push({
				state: "A preview source card open",
				rule: "missing-control",
				detail: "the open source card or its preview was not found",
			});
		} else if (boxes.card.left < boxes.panel.left - 1 || boxes.card.right > boxes.panel.right + 1) {
			findings.push({
				state: "A preview source card open",
				rule: "card-overflows-panel",
				detail: `card ${Math.round(boxes.card.left)}-${Math.round(boxes.card.right)} vs panel ${Math.round(boxes.panel.left)}-${Math.round(boxes.panel.right)}`,
			});
		}
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	} else {
		findings.push({
			state: "A preview source card open",
			rule: "missing-control",
			detail: "no citation chip in a thread result preview",
		});
	}

	// Composer disclosure (Options only; "Limits and cost" was removed).
	await page.locator("summary", { hasText: /^Options:/ }).click();
	await page.waitForTimeout(300);
	await shot(page, "A3-composer-disclosures");
	await audit(page, "A composer disclosures open");
	const afterDisclosures = await composer.boundingBox();
	if (afterDisclosures !== null && afterDisclosures.y + afterDisclosures.height > 900 + 1)
		findings.push({
			state: "A composer disclosures open",
			rule: "composer-below-fold",
			detail: `composer bottom at ${Math.round(afterDisclosures.y + afterDisclosures.height)} in a 900px viewport`,
		});
	await page.locator("summary", { hasText: /^Options:/ }).click();

	// Records drawer: opens, takes focus, closes with Escape, returns focus.
	const evidence = page.getByRole("button", { name: "Evidence" }).first();
	if ((await evidence.count()) > 0) {
		await evidence.click();
		await page.waitForTimeout(700);
		await shot(page, "A4-records-drawer");
		await audit(page, "A records drawer");
		const focusInside = await page.evaluate(() => {
			const dialog = document.querySelector('[role="dialog"], dialog');
			return dialog === null
				? "no-dialog-role"
				: dialog.contains(document.activeElement)
					? "inside"
					: "outside";
		});
		if (focusInside !== "inside")
			findings.push({
				state: "A records drawer",
				rule: "drawer-focus",
				detail: `after opening, focus is ${focusInside}`,
			});
		const drawer = page
			.locator('[role="dialog"], aside')
			.filter({ hasText: /evidence/i })
			.last();
		const opener = await page.evaluate(
			() => document.activeElement?.textContent?.trim().slice(0, 30) ?? "",
		);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
		if (await drawer.isVisible().catch(() => false)) {
			findings.push({
				state: "A records drawer",
				rule: "drawer-escape",
				detail: "Escape does not close the drawer",
			});
			await drawer.getByRole("button", { name: /close/i }).first().click();
			await page.waitForTimeout(400);
		}
		if (await drawer.isVisible().catch(() => false))
			findings.push({
				state: "A records drawer",
				rule: "drawer-stuck",
				detail: "the drawer could not be closed",
			});
		const focusBack = await page.evaluate(
			() => document.activeElement?.textContent?.trim().slice(0, 30) ?? "",
		);
		if (!/Evidence/.test(focusBack))
			findings.push({
				state: "A records drawer",
				rule: "drawer-focus-return",
				detail: `after closing, focus is on "${focusBack}" (was inside: "${opener}")`,
			});
		// Backdrop click closes it too.
		await evidence.click();
		await page.waitForTimeout(500);
		await page.mouse.click(40, 500);
		await page.waitForTimeout(500);
		if (await drawer.isVisible().catch(() => false)) {
			findings.push({
				state: "A records drawer",
				rule: "drawer-backdrop",
				detail: "clicking outside the drawer does not close it",
			});
			await drawer.getByRole("button", { name: /close/i }).first().click();
			await page.waitForTimeout(300);
		}
	} else {
		findings.push({
			state: "A desktop thread",
			rule: "missing-control",
			detail: 'no "Evidence" button on the answer',
		});
	}

	await auditFocus(page, "A keyboard", 22);

	/* ---------- B. Typing: growth, long words, Enter to send ---------- */
	const input = composer.getByRole("textbox", { name: "Question", exact: true });
	await input.fill(
		Array.from(
			{ length: 14 },
			(_, index) => `Line ${index + 1} of a long multi-line question`,
		).join("\n"),
	);
	await page.waitForTimeout(300);
	await shot(page, "B1-long-draft");
	await audit(page, "B long draft");
	const grown = await input.boundingBox();
	if (grown !== null && grown.height < 60)
		findings.push({
			state: "B long draft",
			rule: "input-does-not-grow",
			detail: `textarea is ${Math.round(grown.height)}px tall with 14 lines`,
		});
	if (grown !== null && grown.height > 420)
		findings.push({
			state: "B long draft",
			rule: "input-grows-unbounded",
			detail: `textarea is ${Math.round(grown.height)}px tall`,
		});
	const send = composer.getByRole("button", { name: /Send/ });
	const sendBox = await send.boundingBox();
	if (sendBox === null || sendBox.y + sendBox.height > 900)
		findings.push({
			state: "B long draft",
			rule: "send-out-of-view",
			detail: "send button not visible with a long draft",
		});

	const longWord = "W".repeat(260);
	await input.fill(`Which suppliers benefit? ${longWord}`);
	await input.press("Enter");
	await expect(thread.locator('[data-role="owner"]').last()).toContainText(
		"Which suppliers benefit?",
		{ timeout: 15_000 },
	);
	await page.waitForTimeout(500);
	await shot(page, "B2-sent-in-progress");
	await audit(page, "B run in progress");
	const bubble = thread.locator('[data-role="owner"]').last();
	const bubbleBox = await bubble.boundingBox();
	const threadBox = await thread.boundingBox();
	if (
		bubbleBox !== null &&
		threadBox !== null &&
		bubbleBox.x + bubbleBox.width > threadBox.x + threadBox.width + 1
	)
		findings.push({
			state: "B long word",
			rule: "bubble-overflows",
			detail: `bubble right edge ${Math.round(bubbleBox.x + bubbleBox.width)} > thread ${Math.round(threadBox.x + threadBox.width)}`,
		});
	const inputAfterSend = await input.inputValue();
	if (inputAfterSend !== "")
		findings.push({
			state: "B sent",
			rule: "input-not-cleared",
			detail: `input still holds ${inputAfterSend.length} characters after sending`,
		});
	const nag = await composer.getByText(/Enter a research question/).count();
	if (nag > 0)
		findings.push({
			state: "B sent",
			rule: "validation-after-send",
			detail: "a validation message is shown right after a successful send",
		});
	const focusedAfterSend = await page.evaluate(() => document.activeElement?.tagName ?? "none");
	if (focusedAfterSend !== "TEXTAREA")
		findings.push({
			state: "B sent",
			rule: "focus-lost-after-send",
			detail: `focus is on ${focusedAfterSend}; a chat keeps focus in the input`,
		});

	// Wait for the run to finish, then check the newest answer is in view.
	await expect(
		page
			.locator(
				'[data-run-state="completed"], [data-run-state="partial"], [data-run-state="failed"]',
			)
			.last(),
	).toBeAttached({ timeout: 90_000 });
	await page.waitForTimeout(2500);
	await shot(page, "B3-after-answer");
	await audit(page, "B after answer");
	const newest = thread.locator(":scope > li").last();
	const newestBox = await newest.boundingBox();
	const composerNow = await composer.boundingBox();
	if (newestBox !== null && composerNow !== null && newestBox.y > composerNow.y)
		findings.push({
			state: "B after answer",
			rule: "new-answer-not-in-view",
			detail: "the newest thread item is below the input after the answer arrived",
		});

	// Shift+Enter must not send.
	const ownerCountBefore = await thread.locator('[data-role="owner"]').count();
	await input.fill("first line");
	await input.press("Shift+Enter");
	await input.type("second line");
	await page.waitForTimeout(400);
	const ownerCountAfter = await thread.locator('[data-role="owner"]').count();
	if (ownerCountAfter !== ownerCountBefore)
		findings.push({
			state: "B keyboard",
			rule: "shift-enter-sent",
			detail: "Shift+Enter sent the message",
		});
	if (!(await input.inputValue()).includes("\n"))
		findings.push({
			state: "B keyboard",
			rule: "shift-enter-no-newline",
			detail: "Shift+Enter did not insert a line break",
		});
	await input.fill("");

	/* ---------- C. Many conversations with long titles ---------- */
	for (let index = 0; index < 14; index += 1) {
		await page.request.post(`${E2E_ORIGIN}/api/v1/workspaces`, {
			headers: WRITE_HEADERS,
			data: {
				title: `Review conversation ${index + 1} with a deliberately long title to test wrapping and truncation in the list`,
			},
		});
	}
	await page.reload();
	await expect(page.getByRole("navigation", { name: "Chats" })).toBeVisible({
		timeout: 20_000,
	});
	await page.waitForTimeout(1200);
	await shot(page, "C1-many-conversations");
	await audit(page, "C many conversations");
	const scrollsNow = await page.evaluate(
		() => document.documentElement.scrollHeight > window.innerHeight + 1,
	);
	if (scrollsNow)
		findings.push({
			state: "C many conversations",
			rule: "page-scrolls",
			detail: "with 16 conversations the whole page scrolls instead of the list",
		});

	/* ---------- D. Empty conversation ---------- */
	const emptyLink = page.getByRole("navigation", { name: "Chats" }).getByRole("link").first();
	await emptyLink.click();
	await page.waitForTimeout(1000);
	await shot(page, "D1-empty");
	await audit(page, "D empty conversation");
	// Two suggestion copies exist (one above the composer for narrow screens,
	// one centred below it at this viewport): use the visible one.
	const visibleSuggestions = page.locator('ul[aria-label="Suggestions"]:visible');
	const chip = visibleSuggestions.getByRole("button").first();
	if ((await chip.count()) > 0) {
		const chipText = (await chip.textContent()) ?? "";
		await chip.click();
		await page.waitForTimeout(300);
		if ((await input.inputValue()).trim() !== chipText.trim())
			findings.push({
				state: "D empty conversation",
				rule: "suggestion-not-filled",
				detail: "clicking a suggestion did not fill the input",
			});
		await shot(page, "D2-suggestion-filled");
		await input.fill("");
	} else {
		findings.push({
			state: "D empty conversation",
			rule: "missing-control",
			detail: "no suggestion chips",
		});
	}

	/* ---------- E. Other viewports ---------- */
	for (const [name, width, height] of [
		["laptop", 1280, 720],
		["tablet", 820, 1180],
		["phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		await page.goto("/#/chat");
		await page.waitForTimeout(300);
		await page.waitForTimeout(1500);
		await shot(page, `E-${name}-top`);
		await audit(page, `E ${name} top`);
		const form = await page.getByRole("form", { name: "Research composer" }).boundingBox();
		if (form !== null && height - (form.y + form.height) > 40)
			findings.push({
				state: `E ${name} top`,
				rule: "input-not-at-bottom",
				detail: `input area ends ${Math.round(height - (form.y + form.height))}px above the bottom of the ${height}px viewport`,
			});
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const list = page.getByRole("list", { name: "Messages" });
		if ((await list.count()) > 0) await list.locator(":scope > li").last().scrollIntoViewIfNeeded();
		await page.waitForTimeout(500);
		await shot(page, `E-${name}-bottom`);
		await audit(page, `E ${name} bottom`);
	}

	/* ---------- F. No backend chosen: what the owner is told ---------- */
	await page.setViewportSize({ width: 1440, height: 900 });
	const current = await page.request.get(`${E2E_ORIGIN}/api/v1/settings/agent`);
	const saved = z
		.object({ settings: z.record(z.string(), z.unknown()) })
		.parse(await current.json());
	await page.request.put(`${E2E_ORIGIN}/api/v1/settings/agent`, {
		headers: WRITE_HEADERS,
		data: { ...saved.settings, defaultAgentId: null },
	});
	await page.goto("/#/chat");
	await page.waitForTimeout(1500);
	await shot(page, "F1-no-backend");
	await audit(page, "F no backend chosen");
	const told = await composer.textContent();
	if (!/Settings/.test(told ?? ""))
		findings.push({
			state: "F no backend chosen",
			rule: "no-guidance",
			detail: "the form does not tell the owner to choose a backend in Settings",
		});
	await page.request.put(`${E2E_ORIGIN}/api/v1/settings/agent`, {
		headers: WRITE_HEADERS,
		data: saved.settings,
	});

	// Every `page.screenshot()` injects a transient `<style>body {}</style>`
	// stabilization sheet and removes it after the capture (verified with a
	// MutationObserver around the capture). Under this app's strict
	// `style-src 'self'` policy WebKit reports each injection as a page
	// console error while Chromium stays silent, so without filtering every
	// WebKit review would carry two identical "Refused to apply a stylesheet"
	// lines per screenshot that describe the review tool, not the
	// application. They are dropped only when the page holds no
	// application-authored `<style>` element — anything but Playwright's own
	// `body {}` keeps them. A genuine application CSP violation stays gated
	// by the E2E Content-Security-Policy test, which never screenshots.
	const pageStyles = await page.evaluate(() =>
		[...document.querySelectorAll("style")].map((node) => (node.textContent ?? "").trim()),
	);
	const appAuthoredStyles = pageStyles.filter((text) => text !== "" && text !== "body {}");
	for (const problem of consoleProblems) {
		if (
			problem.startsWith("error: Refused to apply a stylesheet") &&
			appAuthoredStyles.length === 0
		)
			continue;
		findings.push({ state: "console", rule: "console", detail: problem.slice(0, 300) });
	}
	writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2));
	for (const line of formatSummaryTable(countByRule(findings))) console.log(line);
	console.log(`ui-review: ${findings.length} findings, screenshots in ${OUT}/`);
	await context.close();
});
