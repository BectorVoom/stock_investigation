import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { homeDashboardResponseSchema } from "../../packages/contracts/src/home.ts";
import { notebookResponseSchema } from "../../packages/contracts/src/notebook.ts";
import {
	type CreateScheduledTaskRequest,
	type ScheduledTask,
	scheduledTaskListResponseSchema,
	scheduledTaskResponseSchema,
} from "../../packages/contracts/src/scheduledTasks.ts";
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN, E2E_PORT, FEED_URL } from "../e2e/fixtures.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

/**
 * Scripted UI review of Scheduled tasks (ADR-0033 §8–§9; `bun run review:ui`,
 * with the other review specs). REVIEW, not a gate: drives the Tasks page
 * (empty, populated with every schedule kind and status, a real skip), the
 * editor dialog (new and edit, once / weekly / monthly field sets, problems),
 * the delete confirmation, the `scheduled-tasks` widget on Home at Small,
 * Medium and Large (empty and populated), the widget in a chat's Notebook
 * (Notebook-first) and a Japanese pass, at 1440×900, 820×1180 and 390×844.
 * Records PNGs plus APPENDED findings in
 * `test-results/ui-review/<engine>/findings.json` and prints a summary table.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) with its own runner harness, so
 * its tasks, backend choice and Home layout never touch the other specs.
 * Every state is produced through the API or the runner — nothing is
 * written into the database file: the skip is a real `AGENT_NOT_CONFIGURED`
 * occurrence (a daily task due a minute after creation while no backend is
 * saved), and the completed one-off task really fired.
 */
const REVIEW_BROWSER = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const OUT = process.env.UIREVIEW_OUT ?? `test-results/ui-review/${REVIEW_BROWSER}`;
const OWNER = `ui-review-tasks-${Date.now()}@example.test`;
/** Fixed, so "next run" and zone naming read the same on every machine. */
const VIEWER_ZONE = "Asia/Tokyo";
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	"X-Research-Csrf": "1",
	"Content-Type": "application/json",
};
const VIEWPORTS = [
	["desktop", 1440, 900],
	["tablet", 820, 1180],
	["phone", 390, 844],
] as const;

const SKIPPED_TITLE = "Pre-market news sweep";
const ONCE_TITLE = "One-off storage check";
const RUN_TITLE = "Morning storage brief";
const PAUSED_TITLE = "Rate-cut watch";
const WEEKLY_TITLE = "Weekly earnings recap";
const MONTHLY_TITLE = "Month-end battery outlook";
const LONG_TITLE =
	"Quarterly check of Japanese and US semiconductor equipment makers' order backlogs and guidance";
const QUESTION = "Which storage products will see demand growth?";

const findingsFileSchema = z.array(
	z.object({ state: z.string(), rule: z.string(), detail: z.string() }),
);
const findings: ReviewFinding[] = [];
const consoleProblems: string[] = [];

/**
 * Geometry, contrast and naming audit inside the page (the Chat review's
 * checks; imports cannot cross `evaluate`, so the formulas are repeated).
 * While a modal dialog is open only the dialog is audited: the rest of the
 * page is inert behind its backdrop.
 */
async function audit(page: Page, state: string): Promise<void> {
	const found = await page.evaluate(() => {
		const out: { rule: string; detail: string }[] = [];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const modal = document.querySelector("dialog[open]");
		const scope: ParentNode = modal ?? document;
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
			if (rect.width <= 1 && rect.height <= 1) return false;
			// Content of a closed <details> (the phone's "Chats" list) is not rendered.
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

		const doc = document.documentElement;
		if (doc.scrollWidth > vw + 1)
			out.push({
				rule: "horizontal-overflow",
				detail: `document is ${doc.scrollWidth}px wide in a ${vw}px viewport`,
			});

		for (const el of Array.from(scope.querySelectorAll("*"))) {
			if (!visible(el)) continue;
			const rect = el.getBoundingClientRect();
			if (rect.right > vw + 1 && rect.left < vw && inViewport(rect))
				out.push({
					rule: "beyond-right-edge",
					detail: `${describe(el)} right=${Math.round(rect.right)} > ${vw}`,
				});
		}

		const interactive = Array.from(
			scope.querySelectorAll("button, a[href], input, textarea, select, summary"),
		).filter(visible);
		const banner = document.querySelector("header");
		for (const el of interactive) {
			const rect = el.getBoundingClientRect();
			if (!inViewport(rect)) continue;
			const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
			const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
			const top = document.elementFromPoint(cx, cy);
			if (top !== null && top !== el && !el.contains(top) && !top.contains(el)) {
				const label = top.closest("label");
				const labelsIt =
					label !== null && (label.contains(el) || label.getAttribute("for") === el.id);
				if (!labelsIt)
					out.push({
						rule: banner?.contains(top) === true ? "covered-by-pinned-area" : "obscured",
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

		// Text contrast (WCAG AA) against the nearest opaque background.
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
		const walker = document.createTreeWalker(modal ?? document.body, NodeFilter.SHOW_TEXT);
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

		let previous = 0;
		for (const heading of Array.from(scope.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(
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

		// Content wider than its box inside a task row or a widget (long titles, Japanese text).
		for (const el of Array.from(
			scope.querySelectorAll("[data-task-id] *, [data-widget-kind='scheduled-tasks'] *"),
		)) {
			if (!(el instanceof HTMLElement) || !visible(el)) continue;
			const style = getComputedStyle(el);
			if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
			if (style.textOverflow === "ellipsis") continue;
			if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && style.display !== "inline")
				out.push({
					rule: "content-wider-than-box",
					detail: `${describe(el)} content ${el.scrollWidth}px in a ${el.clientWidth}px box`,
				});
		}

		// Clipped text without a way to read all of it.
		for (const el of Array.from(scope.querySelectorAll("*"))) {
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
	await page.screenshot({ path: `${OUT}/tasks-${name}.png` });
}

async function shotOf(locator: Locator, name: string): Promise<void> {
	await locator.screenshot({ path: `${OUT}/tasks-${name}.png` });
}

/**
 * The dialog contract (UI review rule, MUST): focus moves in on open,
 * Escape closes it, focus returns to the opener.
 */
async function checkDialogFocus(page: Page, state: string, opener: Locator): Promise<void> {
	const focus = await page.evaluate(() => {
		const open = document.querySelector("dialog[open]");
		if (open === null) return "no-dialog";
		return open.contains(document.activeElement) ? "inside" : "outside";
	});
	if (focus !== "inside")
		findings.push({ state, rule: "dialog-focus", detail: `after opening, focus is ${focus}` });
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	if ((await page.locator("dialog[open]").count()) > 0) {
		findings.push({ state, rule: "dialog-escape", detail: "Escape does not close the dialog" });
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		return;
	}
	const returned = await opener.evaluate((node) => node === document.activeElement);
	if (!returned)
		findings.push({
			state,
			rule: "dialog-return-focus",
			detail: "after Escape, focus is not back on the control that opened the dialog",
		});
}

/** `HH:MM` and `YYYY-MM-DD` in UTC, `minutes` from now. */
function utcAhead(minutes: number): { readonly date: string; readonly time: string } {
	const iso = new Date(Date.now() + minutes * 60_000).toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** The next whole UTC minute that is at least 30 s away, so creating a task never races its time. */
function nextSafeMinute(): { readonly date: string; readonly time: string } {
	return utcAhead(Date.now() % 60_000 > 30_000 ? 2 : 1);
}

test("UI review of Scheduled tasks", async ({ browser }) => {
	test.setTimeout(900_000);
	mkdirSync(OUT, { recursive: true });
	const runner: ChildProcess = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: {
			...baseChildEnv(),
			...suiteRunnerSettings(),
			E2E_PORT: String(E2E_PORT),
			E2E_RUNNER_OWNER: OWNER,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	const contexts: BrowserContext[] = [];
	try {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			timezoneId: VIEWER_ZONE,
			extraHTTPHeaders: { "X-E2E-Owner": OWNER },
		});
		contexts.push(context);
		const page = await context.newPage();
		watchConsole(page);
		await review(page, browser);
		await reportConsole(page);
	} finally {
		for (const context of contexts) await context.close();
		if (runner.exitCode === null) {
			const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
			runner.kill("SIGTERM");
			await exited;
		}
	}
	let previous: ReviewFinding[] = [];
	try {
		previous = findingsFileSchema.parse(JSON.parse(readFileSync(`${OUT}/findings.json`, "utf8")));
	} catch {
		// No earlier review spec ran in this output directory (or its file is unreadable).
		previous = [];
	}
	writeFileSync(`${OUT}/findings.json`, JSON.stringify([...previous, ...findings], null, 2));
	for (const line of formatSummaryTable(countByRule(findings))) console.log(line);
	console.log(`ui-review (tasks): ${findings.length} findings, screenshots in ${OUT}/tasks-*.png`);

	function watchConsole(page: Page): void {
		page.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning")
				consoleProblems.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));
	}

	async function reportConsole(page: Page): Promise<void> {
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
	}

	async function review(page: Page, browserForJa: typeof browser): Promise<void> {
		const api = apiOf(page);

		/* ---------- T0. Fresh owner: no tasks, no backend ---------- */
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await openTasks(page);
			await page.waitForTimeout(500);
			await shot(page, `T0-empty-${name}`);
			await audit(page, `T0 empty ${name}`);
		}
		await page.setViewportSize({ width: 1440, height: 900 });

		/* ---------- H0. The widget's empty state on Home (Small, Medium, Large) ---------- */
		await api.placeHomeWidgets();
		for (const [name, width, height] of [VIEWPORTS[0], VIEWPORTS[2]]) {
			await page.setViewportSize({ width, height });
			await page.goto("/#/home");
			await expect(widgetOf(page, "large")).toContainText("No scheduled tasks yet", {
				timeout: 30_000,
			});
			await page.waitForTimeout(600);
			await shot(page, `H0-home-empty-${name}`);
			await audit(page, `H0 home empty ${name}`);
			await shotOf(widgetOf(page, "small"), `H0-widget-small-empty-${name}`);
		}
		await page.setViewportSize({ width: 1440, height: 900 });

		/* ---------- A real skip: a daily task due while no backend is saved ---------- */
		const skipAt = nextSafeMinute();
		await api.create({
			...taskFields(SKIPPED_TITLE),
			schedule: { kind: "daily", time: skipAt.time },
			timeZone: "UTC",
		});
		await expect
			.poll(async () => (await api.find(SKIPPED_TITLE))?.lastSkip?.code ?? null, {
				timeout: 180_000,
				intervals: [3_000],
			})
			.toBe("AGENT_NOT_CONFIGURED");

		/* ---------- The backend and source, then every kind and status ---------- */
		await setUpOwner(page);
		const onceAt = nextSafeMinute();
		await api.create({
			...taskFields(ONCE_TITLE),
			schedule: { kind: "once", date: onceAt.date, time: onceAt.time },
			timeZone: "UTC",
		});
		const morning = await api.create({
			...taskFields(RUN_TITLE),
			schedule: { kind: "daily", time: "07:30" },
			timeZone: VIEWER_ZONE,
		});
		await api.create({
			...taskFields("Weekday open check"),
			markets: ["JP"],
			schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:45" },
			timeZone: VIEWER_ZONE,
		});
		await api.create({
			...taskFields(WEEKLY_TITLE),
			markets: ["US"],
			schedule: { kind: "weekly", days: [1, 3, 5], time: "18:00" },
			timeZone: "America/New_York",
		});
		await api.create({
			...taskFields(MONTHLY_TITLE),
			horizonYears: 3,
			schedule: { kind: "monthly", day: 31, time: "09:00" },
			timeZone: "UTC",
		});
		await api.create({
			...taskFields(LONG_TITLE),
			question:
				"Compare the order backlogs, book-to-bill ratios and next-quarter guidance of the largest Japanese and US semiconductor equipment makers, and say which changed most since the last quarter.",
			schedule: { kind: "monthly", day: 15, time: "12:00" },
			timeZone: VIEWER_ZONE,
		});
		const paused = await api.create({
			...taskFields(PAUSED_TITLE),
			schedule: { kind: "daily", time: "21:00" },
			timeZone: "America/New_York",
		});
		await api.pause(paused);
		const friday = await api.create({
			...taskFields("Quiet Friday review"),
			schedule: { kind: "weekly", days: [5], time: "16:00" },
			timeZone: VIEWER_ZONE,
		});
		await api.pause(friday);
		await api.runNow(morning);
		await expect
			.poll(
				async () => {
					const once = await api.find(ONCE_TITLE);
					const ran = await api.find(RUN_TITLE);
					return `${once?.status}/${once?.lastRun?.state ?? "none"} ${ran?.lastRun?.state ?? "none"}`;
				},
				{ timeout: 240_000, intervals: [3_000] },
			)
			.toBe("completed/completed completed");

		/* ---------- T1. The populated Tasks page ---------- */
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await openTasks(page);
			await expect(taskRow(page, ONCE_TITLE)).toContainText("Completed", { timeout: 30_000 });
			await page.waitForTimeout(500);
			await shot(page, `T1-populated-${name}-top`);
			await audit(page, `T1 populated ${name} top`);
			await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			await page.waitForTimeout(400);
			await shot(page, `T1-populated-${name}-bottom`);
			await audit(page, `T1 populated ${name} bottom`);
		}
		await page.setViewportSize({ width: 1440, height: 900 });
		await openTasks(page);
		await shotOf(taskRow(page, SKIPPED_TITLE), "T1-row-skipped-desktop");
		await shotOf(taskRow(page, LONG_TITLE), "T1-row-long-title-desktop");

		/* ---------- D1. New task: the once / weekly / monthly field sets ---------- */
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await openTasks(page);
			const opener = tasksRegion(page).getByRole("button", { name: "New task" });
			await opener.click();
			const dialog = page.getByRole("dialog", { name: "New task" });
			await expect(dialog).toBeVisible();
			for (const [kind, label] of [
				["once", "Once"],
				["weekly", "Weekly"],
				["monthly", "Monthly"],
			] as const) {
				await dialog.getByLabel("Repeat").selectOption({ label });
				await page.waitForTimeout(300);
				await shot(page, `D1-new-${kind}-${name}`);
				await audit(page, `D1 new ${kind} ${name}`);
			}
			if (name === "desktop") {
				// Create with nothing filled in: the problems list.
				await dialog.getByRole("button", { name: "Create task" }).click();
				await page.waitForTimeout(300);
				await shot(page, `D2-new-problems-${name}`);
				await audit(page, `D2 new problems ${name}`);
			}
			await checkDialogFocus(page, `D1 new ${name}`, opener);
		}

		/* ---------- D3. Edit: one task of each field set ---------- */
		for (const [name, width, height] of [VIEWPORTS[0], VIEWPORTS[2]]) {
			await page.setViewportSize({ width, height });
			await openTasks(page);
			for (const [kind, title] of [
				["once", ONCE_TITLE],
				["weekly", WEEKLY_TITLE],
				["monthly", MONTHLY_TITLE],
			] as const) {
				const opener = taskRow(page, title).getByRole("button", { name: `Edit ${title}` });
				await opener.scrollIntoViewIfNeeded();
				await opener.click();
				const dialog = page.getByRole("dialog", { name: "Edit task" });
				await expect(dialog.getByLabel("Title")).toHaveValue(title);
				await page.waitForTimeout(300);
				await shot(page, `D3-edit-${kind}-${name}`);
				await audit(page, `D3 edit ${kind} ${name}`);
				await checkDialogFocus(page, `D3 edit ${kind} ${name}`, opener);
			}
		}

		/* ---------- D4. The delete confirmation ---------- */
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await openTasks(page);
			const opener = taskRow(page, PAUSED_TITLE).getByRole("button", {
				name: `Delete ${PAUSED_TITLE}`,
			});
			await opener.scrollIntoViewIfNeeded();
			await opener.click();
			await expect(page.getByRole("dialog", { name: `Delete ${PAUSED_TITLE}?` })).toBeVisible();
			await page.waitForTimeout(300);
			await shot(page, `D4-delete-${name}`);
			await audit(page, `D4 delete ${name}`);
			await checkDialogFocus(page, `D4 delete ${name}`, opener);
			// Escape cancels: the task is still there.
			await expect(taskRow(page, PAUSED_TITLE)).toBeVisible();
		}

		/* ---------- H1. The widget on Home at Small, Medium and Large ---------- */
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await page.goto("/#/home");
			await expect(widgetOf(page, "large")).toContainText(RUN_TITLE, { timeout: 30_000 });
			await page.waitForTimeout(600);
			await shot(page, `H1-home-${name}`);
			await audit(page, `H1 home ${name}`);
			for (const size of ["small", "medium", "large"] as const) {
				await widgetOf(page, size).scrollIntoViewIfNeeded();
				await shotOf(widgetOf(page, size), `H1-widget-${size}-${name}`);
				await audit(page, `H1 widget ${size} ${name}`);
			}
		}
		await page.setViewportSize({ width: 1440, height: 900 });
		// The widget's New task opens the same editor dialog.
		await page.goto("/#/home");
		const widgetNew = widgetOf(page, "medium").getByRole("button", { name: "New task" });
		await widgetNew.click();
		await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
		await page.waitForTimeout(300);
		await shot(page, "H2-widget-new-task-desktop");
		await audit(page, "H2 widget new task desktop");
		await checkDialogFocus(page, "H2 widget new task desktop", widgetNew);

		/* ---------- N1. The widget in a chat's Notebook (Notebook-first) ---------- */
		await api.placeNotebookWidget(morning.workspaceId);
		for (const [name, width, height] of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await page.goto(`/#/chat/${morning.workspaceId}`);
			const focus = page.getByRole("button", { name: "Focus Notebook" }).first();
			await focus.waitFor({ timeout: 30_000 });
			if ((await focus.getAttribute("aria-pressed")) !== "true") await focus.click();
			const notebookWidget = page.locator(
				'div[data-panel="notebook"] [data-widget-kind="scheduled-tasks"]',
			);
			await expect(notebookWidget).toContainText(RUN_TITLE, { timeout: 30_000 });
			await notebookWidget.scrollIntoViewIfNeeded();
			await page.waitForTimeout(600);
			await shot(page, `N1-notebook-${name}`);
			await audit(page, `N1 notebook ${name}`);
		}

		/* ---------- J. Japanese: the Tasks page, the editor and the widget ---------- */
		const ja = await browserForJa.newContext({
			viewport: { width: 1440, height: 900 },
			locale: "ja-JP",
			timezoneId: VIEWER_ZONE,
			extraHTTPHeaders: { "X-E2E-Owner": OWNER },
		});
		contexts.push(ja);
		const jaPage = await ja.newPage();
		watchConsole(jaPage);
		for (const [name, width, height] of [VIEWPORTS[0], VIEWPORTS[2]]) {
			await jaPage.setViewportSize({ width, height });
			await jaPage.goto("/#/tasks");
			await jaPage.locator("[data-task-id]").first().waitFor({ timeout: 30_000 });
			// A hash navigation keeps the previous page's scroll position.
			await jaPage.evaluate(() => window.scrollTo(0, 0));
			await jaPage.waitForTimeout(500);
			await shot(jaPage, `J-tasks-${name}-top`);
			await audit(jaPage, `J tasks ${name} top`);
			await jaPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
			await jaPage.waitForTimeout(400);
			await shot(jaPage, `J-tasks-${name}-bottom`);
			await audit(jaPage, `J tasks ${name} bottom`);
			await jaPage.evaluate(() => window.scrollTo(0, 0));
			await jaPage.getByRole("button", { name: "新しいタスク" }).first().click();
			await jaPage.locator("dialog[open]").waitFor();
			await jaPage.locator("dialog[open] select").last().selectOption("weekly");
			await jaPage.waitForTimeout(300);
			await shot(jaPage, `J-new-weekly-${name}`);
			await audit(jaPage, `J new weekly ${name}`);
			await jaPage.keyboard.press("Escape");
			await jaPage.goto("/#/home");
			await widgetOf(jaPage, "large").locator("[data-task-id]").first().waitFor({
				timeout: 30_000,
			});
			await jaPage.waitForTimeout(600);
			await shot(jaPage, `J-home-${name}`);
			await audit(jaPage, `J home ${name}`);
			for (const size of ["small", "medium", "large"] as const) {
				await widgetOf(jaPage, size).scrollIntoViewIfNeeded();
				await shotOf(widgetOf(jaPage, size), `J-widget-${size}-${name}`);
			}
		}
		await reportConsole(jaPage);
	}
});

/** The task fields every review task shares; each caller sets its schedule. */
function taskFields(title: string): Omit<CreateScheduledTaskRequest, "schedule" | "timeZone"> {
	return {
		title,
		question: QUESTION,
		horizonYears: 5,
		markets: ["JP", "US"],
		spendConsent: null,
	};
}

function tasksRegion(page: Page): Locator {
	return page.getByRole("region", { name: "Scheduled tasks" });
}

async function openTasks(page: Page): Promise<void> {
	await page.goto("/#/tasks");
	await expect(tasksRegion(page).getByRole("button", { name: "New task" })).toBeVisible({
		timeout: 30_000,
	});
	await page.locator("[aria-busy='true']").first().waitFor({ state: "detached", timeout: 30_000 });
	// A hash navigation keeps the previous page's scroll position.
	await page.evaluate(() => window.scrollTo(0, 0));
}

function taskRow(page: Page, title: string): Locator {
	return page
		.getByRole("list", { name: "Your scheduled tasks" })
		.getByRole("article", { name: title });
}

/** The review's Home widget of one size (`w-review-tasks-<size>`). */
function widgetOf(page: Page, size: "small" | "medium" | "large"): Locator {
	return page.locator(`[data-widget-id="w-review-tasks-${size}"]`);
}

/** Saves the scripted backend and subscribes the fixture feed, as this owner (like `tasks.spec.ts`). */
async function setUpOwner(page: Page): Promise<void> {
	await page.goto("/#/settings/agent");
	const agentSection = page.getByRole("region", { name: "AI agent" });
	const backend = agentSection.getByLabel("Default backend");
	await expect(backend.locator("option", { hasText: "Scripted example agent" })).toHaveCount(1, {
		timeout: 75_000,
	});
	await backend.selectOption({ label: "Scripted example agent — available" });
	await agentSection.getByRole("button", { name: "Save" }).click();
	await expect(agentSection).toContainText(/Saved /);

	await page.getByRole("link", { name: "Sources", exact: true }).click();
	await page.getByLabel("Feed or site URL").fill(FEED_URL);
	await page.getByRole("button", { name: "Preview source" }).click();
	const preview = page.getByRole("region", { name: "Source preview" });
	await expect(preview).toContainText("Example Energy News (synthetic)");
	await preview.getByLabel("License policy").selectOption("short-excerpt-permitted");
	await preview.getByRole("button", { name: "Subscribe to this source" }).click();
	await expect(page.getByRole("region", { name: "Subscribed sources" })).toContainText(
		"Example Energy News (synthetic)",
	);
}

/** The review owner's API calls (the context carries `X-E2E-Owner`). */
function apiOf(page: Page) {
	const base = `${E2E_ORIGIN}/api/v1`;
	let keys = 0;
	const key = (): string => {
		keys += 1;
		return `rk-review-tasks-${Date.now()}-${keys}`;
	};
	const list = async (): Promise<readonly ScheduledTask[]> => {
		const response = await page.request.get(`${base}/scheduled-tasks`);
		if (!response.ok()) throw new Error(`listing the tasks failed: ${response.status()}`);
		return scheduledTaskListResponseSchema.parse(await response.json()).tasks;
	};
	return {
		list,
		async find(title: string): Promise<ScheduledTask | undefined> {
			return (await list()).find((task) => task.title === title);
		},
		async create(request: CreateScheduledTaskRequest): Promise<ScheduledTask> {
			const response = await page.request.post(`${base}/scheduled-tasks`, {
				headers: { ...WRITE_HEADERS, "Idempotency-Key": key() },
				data: request,
			});
			if (!response.ok())
				throw new Error(`creating ${request.title} failed: ${await response.text()}`);
			return scheduledTaskResponseSchema.parse(await response.json()).task;
		},
		async pause(task: ScheduledTask): Promise<void> {
			const response = await page.request.patch(`${base}/scheduled-tasks/${task.taskId}`, {
				headers: WRITE_HEADERS,
				data: { expectedVersion: task.version, status: "paused" },
			});
			if (!response.ok()) throw new Error(`pausing ${task.title} failed: ${await response.text()}`);
		},
		async runNow(task: ScheduledTask): Promise<void> {
			const response = await page.request.post(`${base}/scheduled-tasks/${task.taskId}/run`, {
				headers: { ...WRITE_HEADERS, "Idempotency-Key": key() },
				data: {},
			});
			if (!response.ok()) throw new Error(`running ${task.title} failed: ${await response.text()}`);
		},
		/** Home holds only the three review widgets, so each is in view at every width. */
		async placeHomeWidgets(): Promise<void> {
			const read = await page.request.get(`${base}/home/dashboard`);
			const stored = homeDashboardResponseSchema.parse(await read.json());
			const response = await page.request.put(`${base}/home/dashboard`, {
				headers: WRITE_HEADERS,
				data: {
					dashboard: {
						schemaVersion: stored.dashboard.schemaVersion,
						widgets: (["small", "medium", "large"] as const).map((size) => ({
							type: "scheduled-tasks",
							widgetId: `w-review-tasks-${size}`,
							title: "Scheduled tasks",
							size,
						})),
					},
					expectedVersion: stored.version,
				},
			});
			if (!response.ok())
				throw new Error(`the review dashboard was not saved: ${response.status()}`);
		},
		/** The task's own chat gets a Notebook holding a note and the widget. */
		async placeNotebookWidget(workspaceId: string): Promise<void> {
			const url = `${base}/workspaces/${workspaceId}/notebook`;
			const stored = notebookResponseSchema.parse(await (await page.request.get(url)).json());
			const now = new Date().toISOString();
			const origin = { kind: "owner", messageId: null, runId: null, componentId: null };
			const response = await page.request.put(url, {
				headers: WRITE_HEADERS,
				data: {
					notebook: {
						widgets: [
							{
								widgetId: "nb-review-tasks",
								type: "scheduled-tasks",
								title: "Scheduled tasks",
								size: "medium",
								createdAt: now,
								updatedAt: now,
								revision: 1,
								origin,
							},
							{
								widgetId: "nb-review-note",
								type: "text",
								title: "Note",
								size: "small",
								text: "Storage demand: watch the monthly task's answers.",
								createdAt: now,
								updatedAt: now,
								revision: 1,
								origin,
							},
						],
					},
					expectedVersion: stored.version,
				},
			});
			if (!response.ok())
				throw new Error(`the review notebook was not saved: ${await response.text()}`);
		},
	};
}
