/**
 * The `omitted` note of `web.fetch_page`: the model is told when the
 * converter's heuristics removed navigation, menus or leading chrome, and
 * told nothing when the Markdown is already complete.
 */
import type { ArchivedPage, PageArchive } from "@research/application";
import { err, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createWebTools, type WebToolDeps } from "../../src/tools/webTools.ts";
import { createScriptedFetcher, createToolContext, NOW_ISO, type ScriptedPage } from "./support.ts";

const PAGE_URL = "https://news.synthetic-wire.org/2026/10/grid-battery-orders";
const ROBOTS_URL = "https://news.synthetic-wire.org/robots.txt";
const ALLOW_ALL_ROBOTS = "User-agent: *\nAllow: /";

function sha256Hasher(): WebToolDeps["hasher"] {
	return {
		sha256Hex: async (text: string) => `hash:${text.length}`,
	};
}

function setup(pages: { readonly [url: string]: ScriptedPage }) {
	const fetcher = createScriptedFetcher(pages);
	const saved: ArchivedPage[] = [];
	const archive: PageArchive = {
		async save(page) {
			saved.push(page);
			return ok({ fileName: "2026-10-11-news.synthetic-wire.org-0123456789abcdef.md" });
		},
	};
	const deps: WebToolDeps = {
		fetcher,
		hasher: sha256Hasher(),
		clock: { nowMs: () => Date.parse(NOW_ISO), nowIso: () => NOW_ISO },
		pageArchive: archive,
		sleep: async () => {},
	};
	const [tool] = createWebTools(deps);
	if (tool === undefined) throw new Error("web.fetch_page was not created");
	return { tool, saved };
}

function allowedPages(page: ScriptedPage): { readonly [url: string]: ScriptedPage } {
	return { [ROBOTS_URL]: { text: ALLOW_ALL_ROBOTS }, [PAGE_URL]: page };
}

describe("web.fetch_page omitted note", () => {
	it("mentions navigation and menus omitted when the converter dropped something", async () => {
		const html =
			`<html><body><div class="sidebar"><p>menu chrome</p></div>` +
			`<h1>Site title</h1><h1>Article title</h1><p>${"word ".repeat(150)}</p></body></html>`;
		const { tool, saved } = setup(allowedPages({ text: html, contentType: "text/html" }));
		const result = await tool.execute({ url: PAGE_URL }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.modelText).toContain("navigation and menus omitted");
		expect(saved[0]?.omitted).toMatchObject({
			boilerplateBlocks: expect.any(Number),
			menuLists: expect.any(Number),
			leadingBlocks: expect.any(Number),
		});
		const omitted = saved[0]?.omitted;
		if (omitted === undefined) throw new Error("archive missed the omitted counts");
		expect(omitted.boilerplateBlocks + omitted.menuLists + omitted.leadingBlocks).toBeGreaterThan(
			0,
		);
	});

	it("says nothing about omission when the Markdown is complete", async () => {
		const html =
			`<html><head><title>Grid battery orders double</title></head>` +
			`<body><article><h1>Grid battery orders double</h1>` +
			`<p>Orders for grid-scale batteries doubled year over year to 1,250 units.</p></article></body></html>`;
		const { tool } = setup(allowedPages({ text: html, contentType: "text/html" }));
		const result = await tool.execute({ url: PAGE_URL }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.modelText).not.toContain("navigation and menus omitted");
	});

	it("maps an archive failure the same way with omitted counts present", async () => {
		const failing: PageArchive = {
			async save() {
				return err({ code: "ARCHIVE_WRITE_FAILED", detail: "EACCES" });
			},
		};
		const fetcher = createScriptedFetcher(
			allowedPages({ text: "<article><p>story</p></article>", contentType: "text/html" }),
		);
		const [tool] = createWebTools({
			fetcher,
			hasher: sha256Hasher(),
			clock: { nowMs: () => Date.parse(NOW_ISO), nowIso: () => NOW_ISO },
			pageArchive: failing,
			sleep: async () => {},
		});
		if (tool === undefined) throw new Error("tool missing");
		expect(await tool.execute({ url: PAGE_URL }, createToolContext())).toMatchObject({
			ok: false,
			error: { code: "ARCHIVE_WRITE_FAILED" },
		});
	});
});
