import { type ResearchExport, researchExportSchema } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { SettingsView } from "../src/settings/SettingsView.tsx";
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

const TOKEN = `rt_${"k".repeat(45)}`;

const CREDENTIAL = {
	credentialId: "cred_1",
	label: "Desk PC",
	createdAt: "2026-10-05T00:00:00Z",
	expiresAt: "2026-11-04T00:00:00Z",
	revokedAt: null,
	lastUsedAt: null,
};

const EXPORT: ResearchExport = researchExportSchema.parse({
	format: "research-workspace-export",
	formatVersion: 1,
	exportedAt: "2026-10-06T00:00:00Z",
	workspace: { title: WORKSPACE_SUMMARY.title, state: WORKSPACE_VIEW.state },
	messages: CONVERSATION.messages,
	datasets: WORKSPACE_VIEW.datasets,
	assets: [],
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
let credentials: (
	| typeof CREDENTIAL
	| (Omit<typeof CREDENTIAL, "revokedAt"> & { revokedAt: string })
)[];
const openedWorkspaces: string[] = [];

beforeEach(() => {
	backend = createFakeBackend();
	credentials = [];
	openedWorkspaces.length = 0;
	backend.on("GET", /runner-credentials$/, () => jsonResponse({ credentials }));
	backend.on("POST", /runner-credentials$/, () => {
		credentials = [CREDENTIAL];
		return jsonResponse({ credential: CREDENTIAL, token: TOKEN }, { status: 201 });
	});
	backend.on("DELETE", /runner-credentials\/cred_1$/, () => {
		credentials = [{ ...CREDENTIAL, revokedAt: "2026-10-06T00:00:00Z" }];
		return new Response(null, { status: 204 });
	});
	backend.on("GET", /workspaces$/, () => jsonResponse({ workspaces: [WORKSPACE_SUMMARY] }));
	backend.on("GET", /agents$/, () => jsonResponse(AGENTS));
	backend.on("GET", /settings\/agent$/, () => jsonResponse(AGENT_SETTINGS_RESPONSE));
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount() {
	render(() => (
		<SettingsView
			api={createApiClient({ fetch: backend.fetch })}
			session={{
				status: "ready",
				value: { ownerId: "owner-1", authMode: "cloudflare-access", environment: "production" },
			}}
			agentSection={null}
			visibility={ALWAYS_VISIBLE}
			onReloadSession={() => {}}
			onOpenWorkspace={(workspaceId) => openedWorkspaces.push(workspaceId)}
		/>
	));
}

function chooseFile(content: string, name = "export.json") {
	const input = screen.getByLabelText("Import workspace file (JSON export)");
	const file = new File([content], name, { type: "application/json" });
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	fireEvent.change(input);
}

describe("Settings: session", () => {
	it("shows the AI agent section first, then the session owner id, sign-in method and environment", () => {
		mount();
		const sections = [...document.querySelectorAll("div.space-y-3 > section")];
		expect(sections[0]?.getAttribute("aria-label")).toBe("AI agent");
		const session = screen.getByRole("region", { name: "Session" });
		expect(session.querySelector('[data-field="owner-id"]')?.textContent).toBe("owner-1");
		expect(session.querySelector('[data-field="auth-mode"]')?.textContent).toBe(
			"cloudflare-access",
		);
		expect(session.querySelector('[data-field="environment"]')?.textContent).toBe("production");
	});
});

describe("Settings: runner credentials", () => {
	it("shows a newly issued token once, with a warning, and never stores it", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		mount();
		const section = screen.getByRole("region", { name: "Runner credentials" });
		await within(section).findByText("No runner credentials issued yet.");

		fireEvent.input(within(section).getByLabelText("Credential label"), {
			target: { value: "Desk PC" },
		});
		fireEvent.input(within(section).getByLabelText("Expires in days"), { target: { value: "14" } });
		fireEvent.click(within(section).getByRole("button", { name: "Issue runner credential" }));

		const tokenPanel = await screen.findByRole("region", { name: "New runner token" });
		expect(backend.requestsTo("POST", /runner-credentials$/)[0]?.body).toEqual({
			label: "Desk PC",
			expiresInDays: 14,
		});
		expect(tokenPanel.querySelector('[data-field="runner-token"]')?.textContent).toBe(TOKEN);
		expect(within(tokenPanel).getByRole("alert").textContent).toBe(
			"Copy this token now. It is shown only once and cannot be displayed again.",
		);

		fireEvent.click(within(tokenPanel).getByRole("button", { name: "Copy token" }));
		await within(tokenPanel).findByText("Token copied to the clipboard.");
		expect(writeText).toHaveBeenCalledWith(TOKEN);

		// The token is component state only: nothing in web storage.
		expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
		expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
		expect(document.cookie).not.toContain(TOKEN);

		fireEvent.click(
			within(tokenPanel).getByRole("button", { name: "I have stored the token — hide it" }),
		);
		expect(screen.queryByRole("region", { name: "New runner token" })).toBeNull();
		expect(document.body.textContent).not.toContain(TOKEN);
		// The list shows the credential but never a token.
		const row = await within(section).findByRole("row", { name: /Desk PC/ });
		expect(row.querySelector('[data-field="credential-status"]')?.textContent).toBe("active");
	});

	it("tells the owner to copy by hand when the clipboard is unavailable", async () => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("denied")) },
		});
		mount();
		const section = screen.getByRole("region", { name: "Runner credentials" });
		fireEvent.input(within(section).getByLabelText("Credential label"), {
			target: { value: "Desk PC" },
		});
		fireEvent.click(within(section).getByRole("button", { name: "Issue runner credential" }));
		const tokenPanel = await screen.findByRole("region", { name: "New runner token" });
		fireEvent.click(within(tokenPanel).getByRole("button", { name: "Copy token" }));
		await within(tokenPanel).findByText(/select the token and copy it manually/);
		expect(tokenPanel.textContent).toContain(TOKEN);
	});

	it("does not confirm a copy on a newer token when an earlier copy finishes late", async () => {
		let finishCopy: () => void = () => {};
		const writeText = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishCopy = resolve;
				}),
		);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const secondToken = `rt_${"z".repeat(45)}`;
		let issuedCount = 0;
		backend.on("POST", /runner-credentials$/, () => {
			issuedCount += 1;
			return jsonResponse(
				{ credential: CREDENTIAL, token: issuedCount === 1 ? TOKEN : secondToken },
				{ status: 201 },
			);
		});
		mount();
		const section = screen.getByRole("region", { name: "Runner credentials" });
		const issue = async () => {
			fireEvent.input(within(section).getByLabelText("Credential label"), {
				target: { value: "Desk PC" },
			});
			fireEvent.click(within(section).getByRole("button", { name: "Issue runner credential" }));
		};

		await issue();
		const firstPanel = await screen.findByRole("region", { name: "New runner token" });
		fireEvent.click(within(firstPanel).getByRole("button", { name: "Copy token" }));
		fireEvent.click(
			within(firstPanel).getByRole("button", { name: "I have stored the token — hide it" }),
		);

		await issue();
		await waitFor(() =>
			expect(document.querySelector('[data-field="runner-token"]')?.textContent).toBe(secondToken),
		);
		// The clipboard now finishes writing the FIRST token.
		finishCopy();
		await Promise.resolve();
		await Promise.resolve();
		const secondPanel = screen.getByRole("region", { name: "New runner token" });
		expect(within(secondPanel).queryByText("Token copied to the clipboard.")).toBeNull();
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText).toHaveBeenCalledWith(TOKEN);
	});

	it("revokes a credential and shows it as revoked", async () => {
		credentials = [CREDENTIAL];
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Revoke Desk PC" }));
		await screen.findByText("revoked 2026-10-06 00:00 UTC");
		expect(backend.requestsTo("DELETE", /cred_1$/)).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Revoke Desk PC" })).toBeNull();
	});
});

describe("Settings: approved images", () => {
	it("offers no image-approval UI; the API and stored data remain (owner decision 2026-10-12)", async () => {
		mount();
		// Wait for the remaining sections so the absence is observed on the
		// settled page, not on a half-rendered one.
		await screen.findByRole("region", { name: "Runner credentials" });
		await screen.findByRole("region", { name: "Export and import" });
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
		mount();
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

	it("rejects a file that is not JSON without calling the API", async () => {
		mount();
		await screen.findByLabelText("Workspace to export");
		chooseFile("this is not json");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("INVALID_REQUEST");
		expect(alert.textContent).toContain("The file is not valid JSON.");
		expect(backend.requestsTo("POST", /import$/)).toHaveLength(0);
	});

	it("lists the validation errors of a JSON file that is not a valid export", async () => {
		mount();
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
		mount();
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
		mount();
		await screen.findByLabelText("Workspace to export");
		chooseFile(JSON.stringify(EXPORT));
		await screen.findByText(/Imported as “Imported research”/);
		expect(backend.requestsTo("POST", /import$/)[0]?.body).toEqual(EXPORT);
		fireEvent.click(screen.getByRole("button", { name: "Open imported workspace" }));
		expect(openedWorkspaces).toEqual(["ws_imported"]);
	});
});
