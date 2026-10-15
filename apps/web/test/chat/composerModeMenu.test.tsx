import type { AgentSettingsResponse, AgentsResponse } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerTarget } from "../../src/chat/Composer.tsx";
import type { Remote } from "../../src/lib/remote.ts";
import { AGENT_SETTINGS_RESPONSE, AGENTS, WORKSPACE_ID } from "../fixtures.ts";

afterEach(() => {
	cleanup();
});

function mountComposer(target: ComposerTarget) {
	const onTargetChange = vi.fn();
	const agents: Remote<AgentsResponse> = { status: "ready", value: AGENTS };
	const settings: Remote<AgentSettingsResponse> = {
		status: "ready",
		value: AGENT_SETTINGS_RESPONSE,
	};
	render(() => (
		<Composer
			workspaceId={WORKSPACE_ID}
			agents={agents}
			settings={settings}
			onReloadAgents={() => undefined}
			onReloadSettings={() => undefined}
			newIdempotencyKey={() => "idem-test-key-1"}
			onSubmit={async () => {
				throw new Error("unused");
			}}
			target={target}
			onTargetChange={onTargetChange}
		/>
	));
	return { onTargetChange };
}

function openModeMenu(form: HTMLElement): HTMLElement {
	fireEvent.click(within(form).getByRole("button", { name: "Choose mode" }));
	return screen.getByRole("menu", { name: "Composer mode" });
}

describe("composer mode menu (ADR-0023)", () => {
	it("has no Research/Notebook buttons; the + menu shows the checked mode", () => {
		mountComposer("research");
		const form = screen.getByRole("form", { name: "Research composer" });
		expect(within(form).queryByRole("button", { name: "Research" })).toBeNull();
		expect(within(form).queryByRole("button", { name: "Notebook" })).toBeNull();

		const menu = openModeMenu(form);
		expect(
			within(menu).getByRole("menuitemradio", { name: "Research" }).getAttribute("aria-checked"),
		).toBe("true");
		expect(
			within(menu).getByRole("menuitemradio", { name: "Notebook" }).getAttribute("aria-checked"),
		).toBe("false");
	});

	it("choosing Notebook calls onTargetChange and focuses the textarea", async () => {
		const { onTargetChange } = mountComposer("research");
		const form = screen.getByRole("form", { name: "Research composer" });
		const menu = openModeMenu(form);
		fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Notebook" }));
		expect(onTargetChange).toHaveBeenCalledWith("notebook");
		// The menu closed and focus moved from the + button into the textarea.
		expect(screen.queryByRole("menu", { name: "Composer mode" })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Question")));
	});

	it("shows the Notebook chip only for Notebook, and its × leaves Notebook mode", () => {
		const { onTargetChange } = mountComposer("notebook");
		const notebook = screen.getByRole("form", { name: "Notebook composer" });
		fireEvent.click(within(notebook).getByRole("button", { name: "Leave Notebook mode" }));
		expect(onTargetChange).toHaveBeenCalledWith("research");
		cleanup();

		mountComposer("research");
		const research = screen.getByRole("form", { name: "Research composer" });
		expect(within(research).queryByRole("button", { name: "Leave Notebook mode" })).toBeNull();
	});

	it("Escape closes the menu and returns focus to +", async () => {
		mountComposer("research");
		const form = screen.getByRole("form", { name: "Research composer" });
		openModeMenu(form);
		const research = await screen.findByRole("menuitemradio", { name: "Research" });
		await waitFor(() => expect(document.activeElement).toBe(research));
		fireEvent.keyDown(research, { key: "Escape" });
		expect(screen.queryByRole("menu", { name: "Composer mode" })).toBeNull();
		expect(document.activeElement).toBe(within(form).getByRole("button", { name: "Choose mode" }));
	});

	it("arrow keys move between the two modes", async () => {
		mountComposer("research");
		const form = screen.getByRole("form", { name: "Research composer" });
		openModeMenu(form);
		const research = await screen.findByRole("menuitemradio", { name: "Research" });
		const notebook = screen.getByRole("menuitemradio", { name: "Notebook" });
		await waitFor(() => expect(document.activeElement).toBe(research));
		fireEvent.keyDown(research, { key: "ArrowDown" });
		expect(document.activeElement).toBe(notebook);
		fireEvent.keyDown(notebook, { key: "ArrowUp" });
		expect(document.activeElement).toBe(research);
	});
});
