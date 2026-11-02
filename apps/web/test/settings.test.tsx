import { type ResearchExport, researchExportSchema } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { createLocaleState } from "../src/i18n/localeState.ts";
import type { SettingsSection } from "../src/router.ts";
import { SettingsView } from "../src/settings/SettingsView.tsx";
import { initialWatchlistServerState, installWatchlistRoutes } from "./appHarness.tsx";
import {
	ALWAYS_VISIBLE,
	createFakeBackend,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import {
	AGENT_SETTINGS_RESPONSE,
	AGENTS,
	CONVERSATION,
	WORKSPACE_SUMMARY,
	WORKSPACE_VIEW,
} from "./fixtures.ts";

const EXPORT: ResearchExport = researchExportSchema.parse({
	format: "research-workspace-export",
	formatVersion: 1,
	exportedAt: "2026-10-06T00:00:00Z",
	workspace: { title: WORKSPACE_SUMMARY.title, state: WORKSPACE_VIEW.state },
	messages: CONVERSATION.messages,
	datasets: WORKSPACE_VIEW.datasets,
	records: {
		evidence: WORKSPACE_VIEW.sources,
		claims: CONVERSATION.claims,
		scenarios: [],
		securities: [],
		supplierLinks: [],
		financialObservations: [],
		positionObservations: [],
		investorFilings: [],
		pricingPower: [],
	},
});

let backend: FakeBackend;
const openedWorkspaces: string[] = [];

beforeEach(() => {
	backend = createFakeBackend();
	openedWorkspaces.length = 0;
	backend.on("GET", /workspaces$/, () => jsonResponse({ workspaces: [WORKSPACE_SUMMARY] }));
	backend.on("GET", /agents$/, () => jsonResponse(AGENTS));
	backend.on("GET", /settings\/agent$/, () => jsonResponse(AGENT_SETTINGS_RESPONSE));
	installWatchlistRoutes(backend, initialWatchlistServerState());
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** The categories the page asked the router for, in order. */
let selections: SettingsSection[] = [];

/** Mounts Settings at a route's category; a category chosen in the list becomes the route's. */
function mount(initial: SettingsSection | null = null) {
	selections = [];
	// Like the hash router: a new route object on every set, and the browser's
	// later `hashchange` sets an equal route object once more.
	const [route, setRoute] = createSignal<{ readonly section: SettingsSection | null }>({
		section: initial,
	});
	const setSection = (section: SettingsSection | null) => setRoute({ section });
	render(() => (
		<SettingsView
			localeState={createLocaleState({ window, storage: null })}
			api={createApiClient({ fetch: backend.fetch })}
			section={route().section}
			onSelectSection={(next) => {
				selections.push(next);
				setSection(next);
				// The echo reads the current route, as the router reads `location.hash`.
				setTimeout(() => setRoute({ section: route().section }), 0);
			}}
			visibility={ALWAYS_VISIBLE}
			onOpenWorkspace={(workspaceId) => openedWorkspaces.push(workspaceId)}
		/>
	));
	return { setSection };
}

function category(name: string): HTMLElement {
	return within(screen.getByRole("tablist", { name: "Settings categories" })).getByRole("tab", {
		name,
	});
}

function chooseFile(content: string, name = "export.json") {
	const input = screen.getByLabelText("Import workspace file (JSON export)");
	const file = new File([content], name, { type: "application/json" });
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	fireEvent.change(input);
}

describe("Settings: categories", () => {
	it("lists AI agent, Calendar, Language, then Export and import, and no Session or Runner credentials category", () => {
		mount();
		const tabs = within(screen.getByRole("tablist", { name: "Settings categories" }))
			.getAllByRole("tab")
			.map((tab) => tab.textContent);
		expect(tabs).toEqual(["AI agent", "Calendar", "Language", "Export and import"]);
		expect(document.querySelector('[data-field="owner-id"]')).toBeNull();
		expect(backend.requestsTo("GET", /runner-credentials$/)).toHaveLength(0);
	});

	it("shows the AI agent at #/settings and mounts another category only when it is chosen", () => {
		mount();
		expect(category("AI agent").getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("region", { name: "AI agent" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Export and import" })).toBeNull();
		expect(backend.requestsTo("GET", /workspaces$/)).toHaveLength(0);

		fireEvent.click(category("Export and import"));
		expect(selections).toEqual(["data"]);
		expect(category("Export and import").getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("region", { name: "Export and import" })).toBeTruthy();
		// The AI agent pane stays mounted, hidden, so its unsaved draft survives.
		const agentPanel = document.getElementById(
			category("AI agent").getAttribute("aria-controls") ?? "",
		);
		expect(agentPanel?.hidden).toBe(true);
		expect(agentPanel?.querySelector('section[aria-label="AI agent"]')).not.toBeNull();
	});

	it("keeps an unsaved AI agent draft while another category is shown", async () => {
		mount();
		const effort = await screen.findByLabelText("Effort");
		fireEvent.change(effort, { target: { value: "high" } });
		fireEvent.click(category("Language"));
		fireEvent.click(category("AI agent"));
		const kept = screen.getByLabelText("Effort");
		if (!(kept instanceof HTMLSelectElement)) throw new Error("Effort is not a select");
		expect(kept.value).toBe("high");
	});

	it("moves between categories with the arrow keys, wrapping, and with Home and End", () => {
		mount();
		fireEvent.keyDown(category("AI agent"), { key: "ArrowDown" });
		expect(document.activeElement).toBe(category("Calendar"));
		fireEvent.keyDown(category("Calendar"), { key: "ArrowUp" });
		fireEvent.keyDown(category("AI agent"), { key: "ArrowUp" });
		expect(document.activeElement).toBe(category("Export and import"));
		fireEvent.keyDown(category("Export and import"), { key: "Home" });
		fireEvent.keyDown(category("AI agent"), { key: "End" });
		expect(selections).toEqual(["calendar", "agent", "data", "agent", "data"]);
		expect(category("Export and import").getAttribute("tabindex")).toBe("0");
		expect(category("AI agent").getAttribute("tabindex")).toBe("-1");
	});

	it("opens the category the route names", () => {
		mount("language");
		expect(category("Language").getAttribute("aria-selected")).toBe("true");
		expect(screen.getByLabelText("Display language")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "AI agent" })).toBeNull();
	});

	it("focuses the backend select for a link to #/settings/agent, but not when AI agent is chosen in the list", async () => {
		mount("agent");
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByLabelText("Default backend")),
		);
		cleanup();

		mount("language");
		category("AI agent").focus();
		fireEvent.click(category("AI agent"));
		await screen.findByLabelText("Default backend");
		// Give the pane's link effect its chance to run: focus must stay on the tab.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(category("AI agent"));
	});

	it("never moves focus or scrolls when a category is chosen after the AI agent or Calendar", async () => {
		const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
		mount("language");
		scrolled.mockClear();
		for (const [from, to] of [
			["AI agent", "Calendar"],
			["Calendar", "Language"],
			["AI agent", "Export and import"],
		] as const) {
			category(from).focus();
			fireEvent.click(category(from));
			if (from === "AI agent") await screen.findByLabelText("Default backend");
			else await screen.findByText("Calendar file");
			category(to).focus();
			fireEvent.click(category(to));
			// Let queued link effects (the Calendar heading's microtask) run.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(document.activeElement).toBe(category(to));
		}
		expect(scrolled).not.toHaveBeenCalled();
	});

	it("treats a category typed into the address as a link again after a choice", async () => {
		const { setSection } = mount("language");
		fireEvent.click(category("Calendar"));
		await screen.findByText("Calendar file");
		setSection("language");
		setSection("calendar");
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("heading", { level: 3, name: "Calendar" }),
			),
		);
	});
});

describe("Settings: approved images are gone", () => {
	it("offers no image-approval UI and makes no image API calls (owner decision 2026-10-13)", async () => {
		mount();
		// Show every category so the absence is observed on each settled pane,
		// not on a half-rendered page.
		fireEvent.click(category("Export and import"));
		await screen.findByLabelText("Workspace to export");
		expect(screen.queryByRole("tab", { name: "Approved images" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Approved images" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Approve image" })).toBeNull();
		expect(backend.requestsTo("GET", /assets$/)).toHaveLength(0);
		expect(backend.requestsTo("POST", /assets$/)).toHaveLength(0);
	});
});

describe("Settings: export and import", () => {
	function captureDownloads() {
		const downloads: { name: string; href: string }[] = [];
		const blobs: Blob[] = [];
		vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			if (blob instanceof Blob) blobs.push(blob);
			return "blob:test-download";
		});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			downloads.push({ name: this.download, href: this.href });
		});
		return { downloads, blobs };
	}

	it("downloads the JSON and Markdown exports of the chosen workspace", async () => {
		backend.on("GET", /export\?format=json$/, () => jsonResponse(EXPORT));
		backend.on(
			"GET",
			/export\?format=markdown$/,
			() =>
				new Response("# Grid storage research\n", { headers: { "Content-Type": "text/markdown" } }),
		);
		const { downloads, blobs } = captureDownloads();
		mount("data");
		const section = screen.getByRole("region", { name: "Export and import" });
		const picker = await within(section).findByLabelText("Workspace to export");
		const jsonButton = within(section).getByRole("button", { name: "Download JSON export" });
		expect(jsonButton.hasAttribute("disabled")).toBe(true);

		fireEvent.change(picker, { target: { value: "ws_1" } });
		fireEvent.click(jsonButton);
		await waitFor(() => expect(downloads).toHaveLength(1));
		fireEvent.click(within(section).getByRole("button", { name: "Download Markdown export" }));
		await waitFor(() => expect(downloads).toHaveLength(2));

		expect(downloads.map((download) => download.name)).toEqual([
			"grid-storage-research-export.json",
			"grid-storage-research-export.md",
		]);
		expect(blobs.map((blob) => blob.type)).toEqual(["application/json", "text/markdown"]);
		expect(JSON.parse(await (blobs[0] ?? new Blob()).text())).toEqual(EXPORT);
		expect(await blobs[1]?.text()).toBe("# Grid storage research\n");
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
	});

	it("shows an export failure under the export row, not under the import row", async () => {
		backend.on("GET", /export\?format=json$/, () =>
			jsonResponse({ error: { code: "INTERNAL", message: "export broke" } }, { status: 500 }),
		);
		mount("data");
		const picker = await screen.findByLabelText("Workspace to export");
		fireEvent.change(picker, { target: { value: "ws_1" } });
		fireEvent.click(screen.getByRole("button", { name: "Download JSON export" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The JSON export failed.");
		const exportRow = picker.closest("[data-setting-row]");
		const importRow = screen
			.getByLabelText("Import workspace file (JSON export)")
			.closest("[data-setting-row]");
		expect(exportRow?.contains(alert)).toBe(true);
		expect(importRow?.contains(alert)).toBe(false);
	});

	it("rejects a file that is not JSON without calling the API", async () => {
		mount("data");
		await screen.findByLabelText("Workspace to export");
		chooseFile("this is not json");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("INVALID_REQUEST");
		expect(alert.textContent).toContain("The file is not valid JSON.");
		expect(backend.requestsTo("POST", /import$/)).toHaveLength(0);
	});

	it("lists the validation errors of a JSON file that is not a valid export", async () => {
		mount("data");
		await screen.findByLabelText("Workspace to export");
		chooseFile(JSON.stringify({ ...EXPORT, formatVersion: 2, messages: "none" }));
		const errors = await screen.findByRole("list", { name: "Validation errors" });
		const items = within(errors)
			.getAllByRole("listitem")
			.map((item) => item.textContent ?? "");
		expect(items.some((item) => item.startsWith("formatVersion:"))).toBe(true);
		expect(items.some((item) => item.startsWith("messages:"))).toBe(true);
		expect(backend.requestsTo("POST", /import$/)).toHaveLength(0);
	});

	it("shows the server's rejection of an import", async () => {
		backend.on("POST", /import$/, () =>
			jsonResponse(
				{ error: { code: "INTEGRITY_VIOLATION", message: "claim cites unknown evidence" } },
				{ status: 422 },
			),
		);
		mount("data");
		await screen.findByLabelText("Workspace to export");
		chooseFile(JSON.stringify(EXPORT));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("INTEGRITY_VIOLATION");
		expect(alert.textContent).toContain("claim cites unknown evidence");
	});

	it("imports a valid export and offers to open the new workspace", async () => {
		backend.on("POST", /import$/, () =>
			jsonResponse(
				{ ...WORKSPACE_SUMMARY, workspaceId: "ws_imported", title: "Imported research" },
				{ status: 201 },
			),
		);
		mount("data");
		await screen.findByLabelText("Workspace to export");
		chooseFile(JSON.stringify(EXPORT));
		await screen.findByText(/Imported as “Imported research”/);
		expect(backend.requestsTo("POST", /import$/)[0]?.body).toEqual(EXPORT);
		fireEvent.click(screen.getByRole("button", { name: "Open imported workspace" }));
		expect(openedWorkspaces).toEqual(["ws_imported"]);
	});
});
