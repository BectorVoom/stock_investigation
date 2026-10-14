import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnswerClaims } from "../src/chat/Citations.tsx";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PILL,
	BUTTON_PRIMARY,
	CHAT_PANEL,
	PANEL,
	Section,
} from "../src/components/ui.tsx";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "./appHarness.tsx";
import { createFakeBackend, type FakeBackend } from "./fakeBackend.ts";
import { CONVERSATION, makeRun, WORKSPACE_ID } from "./fixtures.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, "..", "src", "styles.css"), "utf8");

/** A `border` utility token, not a substring of another token. */
function hasBorderToken(className: string): boolean {
	return className.split(/\s+/).some((token) => token === "border" || token.startsWith("border-"));
}

let backend: FakeBackend;
let server: ServerState;

beforeEach(() => {
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
	window.location.hash = `#/chat/${WORKSPACE_ID}`;
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	window.localStorage.clear();
});

describe("shared button and panel styles", () => {
	it("fills borderless buttons and keeps PANEL bordered for Sources and Settings", () => {
		for (const style of [BUTTON, BUTTON_PRIMARY, BUTTON_DANGER, BUTTON_PILL]) {
			expect(hasBorderToken(style)).toBe(false);
			expect(style).toContain("min-h-6");
		}
		expect(BUTTON).toContain("bg-slate-200");
		expect(BUTTON).toContain("hover:bg-slate-300");
		expect(BUTTON_PRIMARY).toContain("bg-blue-700");
		expect(BUTTON_DANGER).toContain("bg-red-100");
		expect(BUTTON_DANGER).toContain("hover:bg-red-200");
		expect(BUTTON_PILL).toContain("rounded-full");
		// Sources and Settings keep their bordered look.
		expect(hasBorderToken(PANEL)).toBe(true);
		expect(hasBorderToken(CHAT_PANEL)).toBe(false);
		expect(CHAT_PANEL).toContain("bg-white");
	});

	it("keeps the visible keyboard focus ring", () => {
		expect(STYLES).toContain(":focus-visible");
	});

	it("renders Sources and Settings sections with borders and filled buttons", async () => {
		cleanup();
		render(() => (
			<Section title="Subscribed sources">
				<button type="button" class={BUTTON}>
					Preview source
				</button>
			</Section>
		));
		const section = document.querySelector("section[aria-label='Subscribed sources']");
		if (!(section instanceof HTMLElement)) throw new Error("expected the section");
		expect(hasBorderToken(section.className)).toBe(true);
		const button = screen.getByRole("button", { name: "Preview source" });
		expect(hasBorderToken(button.className)).toBe(false);
		expect(button.className).toContain("bg-slate-200");
		expect(button.className).toContain("min-h-6");
	});
});

describe("chat page without outlines", () => {
	async function chatReady(): Promise<void> {
		mountApp(backend);
		// Wait for loaded content, not the loading skeletons: the regions
		// render immediately while the workspace and chats still load.
		await screen.findByRole("article", { name: "Assistant message" });
		await screen.findByRole("article", { name: "Component news_1" });
		await screen.findByRole("navigation", { name: "Chats" });
		await screen.findByRole("button", { name: "More actions for Second research" });
	}

	it("renders the three panels with fills and no outlines", async () => {
		await chatReady();
		const chat = document.querySelector('[data-panel="chat"]');
		const chats = document.querySelector('section[aria-label="Chats"]');
		const notebook = document.querySelector('div[data-panel="notebook"]');
		for (const panel of [chat, chats, notebook]) {
			if (!(panel instanceof HTMLElement)) throw new Error("expected every chat panel");
			expect(hasBorderToken(panel.className)).toBe(false);
			expect(panel.className).toContain("bg-white");
		}
	});

	it("renders the collapsed rails with fills and no outlines", async () => {
		await chatReady();
		fireEvent.click(screen.getByRole("button", { name: "Collapse Chats panel" }));
		fireEvent.click(screen.getByRole("button", { name: "Collapse Notebook panel" }));
		const rails = [...document.querySelectorAll("[data-panel='notebook-rail']")];
		// The chats rail is the collapsed panel's own div: the parent of its expand button.
		const chatsExpand = screen.getByRole("button", { name: "Expand Chats panel" });
		const chatsRail = chatsExpand.closest("div");
		if (!(chatsRail instanceof HTMLElement)) {
			throw new Error("expected the chats rail");
		}
		for (const rail of [...rails, chatsRail]) {
			if (!(rail instanceof HTMLElement)) throw new Error("expected every rail");
			expect(hasBorderToken(rail.className)).toBe(false);
			expect(rail.className).toContain("bg-white");
		}
		// The rail buttons are filled, not outlined.
		for (const name of ["Expand Chats panel", "Expand Notebook panel", "New chat"]) {
			const button = screen.getByRole("button", { name });
			expect(hasBorderToken(button.className)).toBe(false);
		}
	});

	it("renders the welcome panel with a fill and no outline", async () => {
		server.conversations = [];
		window.location.hash = "#/chat";
		mountApp(backend);
		const welcome = await screen.findByRole("region", { name: "Chat" });
		expect(hasBorderToken(welcome.className)).toBe(false);
		expect(welcome.className).toContain("bg-white");
	});

	it("renders the run card and its approval form with fills and no outlines", async () => {
		server.runs = [
			makeRun({
				runId: "run_5",
				state: "waiting_approval",
				approvalRequest: { reasonCode: "MAX_TOOL_CALLS", detail: "needs more" },
			}),
		];
		mountApp(backend);
		const run = await screen.findByRole("article", { name: "Run run_5" });
		expect(hasBorderToken(run.className)).toBe(false);
		expect(run.className).toContain("bg-slate-100");
		const form = await screen.findByRole("form", { name: "Approve run run_5" });
		expect(hasBorderToken(form.className)).toBe(false);
		expect(form.className).toContain("bg-slate-200");
	});

	it("renders the composer box with a tinted fill, no outline and a focus ring", async () => {
		await chatReady();
		const composer = await screen.findByRole("form", { name: "Research composer" });
		const box = composer.querySelector("div.flex.items-end");
		if (!(box instanceof HTMLElement)) throw new Error("expected the question box");
		expect(hasBorderToken(box.className)).toBe(false);
		expect(box.className).toContain("bg-slate-100");
		expect(box.className).toContain("focus-within:ring-2");
	});

	it("renders result previews with fills and no outlines", async () => {
		await chatReady();
		const cards = [...document.querySelectorAll("li[data-preview-component]")];
		expect(cards.length).toBeGreaterThan(0);
		for (const card of cards) {
			if (!(card instanceof HTMLElement)) throw new Error("expected preview cards");
			expect(hasBorderToken(card.className)).toBe(false);
			expect(card.className).toContain("bg-slate-100");
		}
	});

	it("opens the action menu and the delete dialog on filled surfaces with no outlines", async () => {
		await chatReady();
		const nav = await screen.findByRole("navigation", { name: "Chats" });
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		const menu = await screen.findByRole("menu");
		expect(hasBorderToken(menu.className)).toBe(false);
		expect(menu.className).toContain("bg-slate-100");
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		expect(hasBorderToken(dialog.className)).toBe(false);
		expect(dialog.className).toContain("bg-slate-100");
		// The dialog buttons are filled, with their focus ring intact.
		for (const name of ["Cancel", "Delete"]) {
			const button = within(dialog).getByRole("button", { name });
			expect(hasBorderToken(button.className)).toBe(false);
			expect(button.className).toContain("min-h-6");
		}
	});
});

describe("citation chips and source cards without outlines", () => {
	it("fills chips and the floating card, keeping open and closed chips apart", async () => {
		cleanup();
		const claims = new Map(CONVERSATION.claims.map((claim) => [claim.claimId, claim] as const));
		const evidence = new Map(CONVERSATION.evidence.map((item) => [item.evidenceId, item] as const));
		render(() => <AnswerClaims claimIds={["claim_1"]} claims={claims} evidence={evidence} />);
		const chip = await screen.findByRole("button", {
			name: "Source 1: Grid storage outlook 2026",
		});
		expect(hasBorderToken(chip.className)).toBe(false);
		expect(chip.className).toContain("bg-blue-100");
		expect(chip.className).toContain("min-h-6");
		fireEvent.click(chip);
		const card = document.querySelector("[data-citation-card]");
		if (!(card instanceof HTMLElement)) throw new Error("expected the source card");
		expect(hasBorderToken(card.className)).toBe(false);
		expect(card.className).toContain("bg-blue-100");
		// The pinned (open) chip reads differently from a closed one.
		expect(chip.className).toContain("bg-blue-700");
		await waitFor(() => expect(chip.getAttribute("aria-expanded")).toBe("true"));
	});
});
