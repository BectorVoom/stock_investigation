import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { parseBrowser } from "../e2e/engines.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

/**
 * Scripted UI review of Settings (ADR-0052; `bun run review:ui`, with the
 * other review specs). REVIEW, not a gate: opens every category at
 * 1440×900, 820×1180 and 390×844, plus a Japanese pass, and records a PNG of
 * each with APPENDED findings in `test-results/ui-review/<engine>/findings.json`.
 *
 * Besides the shared geometry checks (overflow, covered or small targets,
 * unnamed controls) it checks the ChatGPT-style layout itself: the category
 * list stands left of the pane from `md` up and is one row above it below;
 * from `sm` up every row's control sits right of its name; and the web
 * access switch shows a focus ring when reached by keyboard.
 *
 * Runs as an isolated owner (`X-E2E-Owner`) and writes nothing (no save,
 * no import).
 */
const REVIEW_BROWSER = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const OUT = process.env.UIREVIEW_OUT ?? `test-results/ui-review/${REVIEW_BROWSER}`;
const OWNER = `ui-review-settings-${Date.now()}@example.test`;
const VIEWPORTS = [
	["desktop", 1440, 900],
	["tablet", 820, 1180],
	["phone", 390, 844],
] as const;
const CATEGORIES = [
	["agent", "AI agent", "AI エージェント"],
	["calendar", "Calendar", "カレンダー"],
	["language", "Language", "言語"],
	["data", "Export and import", "エクスポートとインポート"],
] as const;

const findingsFileSchema = z.array(
	z.object({ state: z.string(), rule: z.string(), detail: z.string() }),
);
const findings: ReviewFinding[] = [];
const consoleProblems: string[] = [];

/** The shared geometry and naming checks, plus the Settings layout checks, inside the page. */
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
			if (style.visibility === "hidden" || style.display === "none") return false;
			return el.closest("[hidden]") === null;
		};
		const inViewport = (rect: DOMRect): boolean =>
			rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;

		if (document.documentElement.scrollWidth > vw + 1)
			out.push({
				rule: "horizontal-overflow",
				detail: `document is ${document.documentElement.scrollWidth}px wide in a ${vw}px viewport`,
			});
		const tablist = document.querySelector('[role="tablist"]');
		for (const el of Array.from(document.querySelectorAll("main *"))) {
			if (!visible(el)) continue;
			// The category list scrolls sideways inside itself on a phone.
			if (tablist?.contains(el) === true) continue;
			const rect = el.getBoundingClientRect();
			if (rect.right > vw + 1 && inViewport(rect))
				out.push({
					rule: "beyond-right-edge",
					detail: `${describe(el)} right=${Math.round(rect.right)} > ${vw}`,
				});
		}

		const interactive = Array.from(
			document.querySelectorAll("main button, main a[href], main input, main select"),
		).filter(visible);
		for (const el of interactive) {
			const rect = el.getBoundingClientRect();
			if (!inViewport(rect)) continue;
			if (tablist?.contains(el) === true && (rect.left < 0 || rect.right > vw)) continue;
			const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
			const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
			const top = document.elementFromPoint(cx, cy);
			if (top !== null && top !== el && !el.contains(top) && !top.contains(el)) {
				const label = top.closest("label");
				const labelsIt =
					label !== null && (label.contains(el) || label.getAttribute("for") === el.id);
				if (!labelsIt)
					out.push({
						rule: "obscured",
						detail: `${describe(el)} is covered at its centre by ${describe(top)}`,
					});
			}
			const inlineLink = el.tagName === "A" && getComputedStyle(el).display === "inline";
			if (!inlineLink && (rect.width < 24 || rect.height < 24))
				out.push({
					rule: "small-target",
					detail: `${describe(el)} is ${Math.round(rect.width)}x${Math.round(rect.height)}px (< 24x24)`,
				});
			const name =
				(el.getAttribute("aria-label") ?? "").trim() ||
				(el.textContent ?? "").trim() ||
				(el instanceof HTMLInputElement || el instanceof HTMLSelectElement
					? (el.labels?.[0]?.textContent ?? "").trim()
					: "");
			if (name === "") out.push({ rule: "no-accessible-name", detail: describe(el) });
		}

		// The category list: left of the pane from `md` (768 px) up, one row above it below.
		const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
		const panel = document.querySelector('[role="tabpanel"]:not([hidden])');
		const first = tabs[0]?.getBoundingClientRect();
		const second = tabs[1]?.getBoundingClientRect();
		const pane = panel?.getBoundingClientRect();
		if (first !== undefined && second !== undefined && pane !== undefined) {
			const stacked = second.top >= first.bottom - 1;
			if (vw >= 768 && !(stacked && first.right <= pane.left + 1))
				out.push({
					rule: "category-list-layout",
					detail: "from md up the categories must be a column left of the pane",
				});
			if (vw < 768 && (stacked || first.bottom > pane.top + 1))
				out.push({
					rule: "category-list-layout",
					detail: "below md the categories must be one row above the pane",
				});
		}

		// Every category icon keeps its 16 px, however long the name beside it.
		for (const icon of Array.from(document.querySelectorAll('[role="tab"] svg'))) {
			const box = icon.getBoundingClientRect();
			if (Math.round(box.width) !== 16 || Math.round(box.height) !== 16)
				out.push({
					rule: "squeezed-icon",
					detail: `${describe(icon.closest('[role="tab"]') ?? icon)} icon is ${Math.round(box.width)}x${Math.round(box.height)}px`,
				});
		}

		// From `sm` (640 px) up a row's control stands right of its name.
		if (vw >= 640) {
			for (const row of Array.from(
				document.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-setting-row]'),
			)) {
				const columns = row.firstElementChild?.children;
				const name = columns?.[0]?.getBoundingClientRect();
				const control = columns?.[1]?.getBoundingClientRect();
				if (name === undefined || control === undefined || control.width === 0) continue;
				if (control.left < name.right - 1)
					out.push({
						rule: "row-layout",
						detail: `${describe(row)}: control starts at ${Math.round(control.left)}, name ends at ${Math.round(name.right)}`,
					});
			}
		}
		return out;
	});
	for (const finding of found) findings.push({ state, ...finding });
}

async function openSettings(
	browser: Browser,
	viewport: { readonly width: number; readonly height: number },
	locale: string,
): Promise<Page> {
	const context = await browser.newContext({
		viewport,
		locale,
		extraHTTPHeaders: { "X-E2E-Owner": OWNER },
	});
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning")
			consoleProblems.push(`${message.type()}: ${message.text()}`);
	});
	return page;
}

test.describe.configure({ mode: "serial" });

test("Settings: every category at desktop, tablet and phone widths, and in Japanese", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	mkdirSync(OUT, { recursive: true });

	for (const [viewportName, width, height] of VIEWPORTS) {
		const page = await openSettings(browser, { width, height }, "en-US");
		await page.goto("/#/settings");
		await expect(page.getByRole("region", { name: "AI agent" })).toBeVisible({ timeout: 60_000 });
		for (const [key, name] of CATEGORIES) {
			const tab = page
				.getByRole("tablist", { name: "Settings categories" })
				.getByRole("tab", { name });
			await tab.click();
			await expect(tab).toHaveAttribute("aria-selected", "true");
			// `#/settings` already shows the AI agent: choosing it again changes no URL.
			await expect(page).toHaveURL(
				key === "agent" ? /#\/settings(\/agent)?$/ : new RegExp(`#/settings/${key}$`),
			);
			const region = page.getByRole("region", { name });
			await expect(region).toBeVisible();
			// Let each pane settle (loading lines replaced by content) before measuring.
			await expect(region.getByText(/^Loading /)).toHaveCount(0, { timeout: 30_000 });
			const state = `settings-${key}-${viewportName}`;
			await audit(page, state);
			await page.screenshot({ path: `${OUT}/${state}.png`, fullPage: true });
		}

		if (viewportName === "desktop") {
			// Keyboard: the arrows walk the list; the switch shows its focus ring.
			await page.goto("/#/settings");
			const agentTab = page.getByRole("tab", { name: "AI agent" });
			await agentTab.focus();
			await page.keyboard.press("ArrowDown");
			await expect(page.getByRole("tab", { name: "Calendar" })).toBeFocused();
			await page.keyboard.press("ArrowUp");
			await expect(agentTab).toBeFocused();
			const webAccess = page.getByRole("switch", {
				name: "Allow the agent to open public web pages",
			});
			await expect(webAccess).toBeVisible({ timeout: 30_000 });
			// Safari's Tab skips checkboxes unless the user turns that on, so the
			// switch is focused directly — after a key press, which makes the
			// browser treat the focus as keyboard focus (`:focus-visible`).
			await page.keyboard.press("Shift+Tab");
			await webAccess.focus();
			await expect(webAccess).toBeFocused();
			const ring = await webAccess.evaluate((input) => {
				const track = input.nextElementSibling;
				return track === null ? "none" : getComputedStyle(track).boxShadow;
			});
			if (ring === "none")
				findings.push({
					state: "settings-agent-switch-focus",
					rule: "no-focus-ring",
					detail: "the web access switch shows no ring when focused by keyboard",
				});
			await page.screenshot({ path: `${OUT}/settings-agent-switch-focus.png` });
		}
		await page.context().close();
	}

	const ja = await openSettings(browser, { width: 1440, height: 900 }, "ja-JP");
	await ja.goto("/#/settings");
	await expect(ja.getByRole("region", { name: "AI エージェント" })).toBeVisible({
		timeout: 60_000,
	});
	for (const [key, , name] of CATEGORIES) {
		await ja.getByRole("tab", { name }).click();
		await expect(ja.getByRole("region", { name })).toBeVisible();
		const state = `settings-${key}-ja`;
		await audit(ja, state);
		await ja.screenshot({ path: `${OUT}/${state}.png`, fullPage: true });
	}
	await ja.context().close();

	for (const problem of consoleProblems)
		findings.push({ state: "settings", rule: "console", detail: problem });
	let previous: ReviewFinding[];
	try {
		previous = findingsFileSchema.parse(JSON.parse(readFileSync(`${OUT}/findings.json`, "utf8")));
	} catch {
		// No earlier review spec ran in this output directory (or its file is unreadable).
		previous = [];
	}
	writeFileSync(`${OUT}/findings.json`, JSON.stringify([...previous, ...findings], null, 2));
	for (const line of formatSummaryTable(countByRule(findings))) console.log(line);
	console.log(
		`ui-review (settings): ${findings.length} findings, screenshots in ${OUT}/settings-*.png`,
	);
});
