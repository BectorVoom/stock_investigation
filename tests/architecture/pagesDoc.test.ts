import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES } from "../../apps/web/src/pages.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../docs/PAGES.md", import.meta.url)), "utf8");

/**
 * The page document and the code cannot drift apart: every view in `PAGES`
 * must be documented with the same title, route and purpose sentence, in its
 * own section. WHY per-section matching: a whole-document `toContain` passes
 * with the purposes swapped between pages, so each purpose must sit under its
 * own heading.
 */
describe("pages document matches the page map", () => {
	const sectionFor = (doc: string, title: string, view: string): string | null => {
		const heading = `## ${title} — \`#/${view}\``;
		const start = doc.indexOf(heading);
		if (start < 0) return null;
		const rest = doc.slice(start + heading.length);
		const next = rest.search(/^## .+ — `#\//m);
		return next < 0 ? rest : rest.slice(0, next);
	};

	const checkPurposes = (doc: string): string[] => {
		const problems: string[] = [];
		for (const page of PAGES) {
			const section = sectionFor(doc, page.title, page.view);
			if (section === null) {
				problems.push(`missing section for ${page.title}`);
				continue;
			}
			if (!section.includes(page.purpose)) {
				problems.push(`section ${page.title} does not contain its purpose`);
			}
		}
		return problems;
	};

	it("documents exactly the views in PAGES", () => {
		const headings = [...DOC.matchAll(/^## (.+) — `(.+)`$/gm)].map((match) => ({
			title: match[1],
			route: match[2],
		}));
		expect(headings.map((heading) => heading.title).sort()).toEqual(
			[...PAGES].map((page) => page.title).sort(),
		);
		expect(headings).toHaveLength(PAGES.length);
	});

	it("uses the same titles, routes and purpose sentences", () => {
		for (const page of PAGES) {
			expect(DOC).toContain(`## ${page.title} — \`#/${page.view}\``);
			expect(DOC).toContain(`#/${page.view}`);
		}
		expect(checkPurposes(DOC)).toEqual([]);
		// The parameterized chat and canvas routes are documented too.
		expect(DOC).toContain("#/chat/<workspaceId>");
		expect(DOC).toContain("#/canvas/<workspaceId>");
		// The settings agent marker that chat notices link to is documented too.
		expect(DOC).toContain("#/settings/agent");
	});

	it("fails when two pages swap their purpose paragraphs", () => {
		const chat = PAGES.find((page) => page.view === "chat");
		const canvas = PAGES.find((page) => page.view === "canvas");
		if (chat === undefined || canvas === undefined) throw new Error("expected chat and canvas");
		const swapped = DOC.replace(chat.purpose, "__CHAT_PURPOSE__")
			.replace(canvas.purpose, chat.purpose)
			.replace("__CHAT_PURPOSE__", canvas.purpose);
		expect(swapped).not.toBe(DOC);
		expect(checkPurposes(swapped).length).toBeGreaterThan(0);
	});
});
