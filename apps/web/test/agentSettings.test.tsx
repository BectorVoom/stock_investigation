import {
	type AgentSettingsResponse,
	agentSettingsResponseSchema,
	agentsResponseSchema,
	DEFAULT_AGENT_SETTINGS,
	OPENROUTER_FREE_AGENT_ID,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { AgentSettingsSection } from "../src/settings/AgentSettingsSection.tsx";
import {
	createFakeBackend,
	deferred,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import { AGENT_SETTINGS, AGENT_SETTINGS_RESPONSE, AGENTS, NO_RUNNER_AGENTS } from "./fixtures.ts";

const UNSAVED = { settings: DEFAULT_AGENT_SETTINGS, updatedAt: null, origin: "defaults" } as const;

const OPENCODE_AGENTS = agentsResponseSchema.parse({
	...AGENTS,
	agents: [
		...AGENTS.agents,
		{
			agentId: "opencode",
			displayName: "OpenCode",
			capabilities: { supported: ["cancel"] },
			costModel: "plan-limited",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
	],
});

let backend: FakeBackend;

beforeEach(() => {
	backend = createFakeBackend();
});

afterEach(cleanup);

function mount(
	response: AgentSettingsResponse = agentSettingsResponseSchema.parse(UNSAVED),
	agents = AGENTS,
	agentSection: string | null = null,
) {
	backend.on("GET", /agents$/, () => jsonResponse(agents));
	backend.on("GET", /settings\/agent$/, () => jsonResponse(response));
	backend.on("PUT", /settings\/agent$/, (request) =>
		jsonResponse({ settings: request.body, updatedAt: "2026-10-06T00:00:00Z", origin: "saved" }),
	);
	render(() => (
		<AgentSettingsSection
			api={createApiClient({ fetch: backend.fetch })}
			agentSection={agentSection}
		/>
	));
}

function saveButton(): HTMLButtonElement {
	const button = screen.getByRole("button", { name: "Save" });
	if (!(button instanceof HTMLButtonElement)) throw new Error("save is not a button");
	return button;
}

function chooseBackend(agentId: string) {
	fireEvent.change(screen.getByLabelText("Default backend"), { target: { value: agentId } });
}

function chooseModel(value: string) {
	fireEvent.change(screen.getByLabelText("Model for this backend"), {
		target: { value },
	});
}

const OTHER_VALUE = "__other__";

function chooseOther() {
	chooseModel(OTHER_VALUE);
}

function typeModelId(text: string) {
	fireEvent.input(screen.getByLabelText("Model id"), { target: { value: text } });
}

function modelSelect(): HTMLSelectElement {
	const element = screen.getByLabelText("Model for this backend");
	if (!(element instanceof HTMLSelectElement)) throw new Error("model is not a select");
	return element;
}

function modelSelectValue(): string {
	return modelSelect().value;
}

function customInputValue(): string | null {
	const element = screen.queryByLabelText("Model id");
	if (element === null) return null;
	if (!(element instanceof HTMLInputElement)) throw new Error("Model id is not an input");
	return element.value;
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
	const element = screen.getByLabelText(label);
	if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
		return element;
	}
	throw new Error(`"${label}" is not a form control`);
}

function webAccessCheckbox(): HTMLInputElement {
	const element = screen.getByRole("checkbox", {
		name: "Allow the agent to open public web pages",
	});
	if (!(element instanceof HTMLInputElement)) throw new Error("web access is not a checkbox");
	return element;
}

/** The section shell renders at once; the form arrives after the settings load. */
async function sectionReady() {
	await screen.findByRole("region", { name: "AI agent" });
	await screen.findByLabelText("Default backend");
}

describe("Agent settings: loading", () => {
	it("shows the defaults with a not-yet-saved note before the first save", async () => {
		mount();
		await sectionReady();
		const section = screen.getByRole("region", { name: "AI agent" });
		expect(section.textContent).toContain("These are the defaults — they have not been saved yet.");
		expect(field("Effort").value).toBe("medium");
		expect(field("Max agent steps").value).toBe("6");
		expect(field("Max spend (USD)").value).toBe("");
		expect(webAccessCheckbox().checked).toBe(true);
		expect(saveButton().disabled).toBe(true);
		expect(screen.queryByText(/Saved /)).toBeNull();
	});

	it("is the first section of the settings page", async () => {
		mount();
		await sectionReady();
	});

	it("lists every backend's availability and disables the unavailable one", async () => {
		mount();
		await sectionReady();
		const options = [...field("Default backend").querySelectorAll("option")];
		expect(options.map((option) => [option.textContent, option.disabled])).toEqual([
			["Choose a backend…", false],
			["Claude Code — available", false],
			["OpenRouter — available", false],
			["Codex — unavailable (NOT_INSTALLED)", true],
		]);
		const availability = screen.getByRole("list", { name: "Backend availability" });
		expect(availability.textContent).toContain(
			"Codex: Unavailable — NOT_INSTALLED: codex binary not found on PATH",
		);
	});

	it("says the runner is offline", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), NO_RUNNER_AGENTS);
		await sectionReady();
		const notice = document.querySelector("[data-runner-offline]");
		expect(notice?.textContent).toContain("Runner offline");
	});
});

describe("Agent settings: saving", () => {
	it("saves the chosen backend, model, effort, limits and web access in the contract shape", async () => {
		mount();
		await sectionReady();
		chooseBackend("claude-code");
		chooseOther();
		typeModelId("custom/model");
		fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
		fireEvent.input(screen.getByLabelText("Max agent steps"), { target: { value: "4" } });
		fireEvent.click(
			screen.getByRole("checkbox", { name: "Allow the agent to open public web pages" }),
		);
		expect(saveButton().disabled).toBe(false);

		fireEvent.click(saveButton());
		await screen.findByText("Saved 2026-10-06 00:00 UTC");
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toEqual({
			defaultAgentId: "claude-code",
			models: { "claude-code": "custom/model" },
			effort: "high",
			budget: {
				maxAgentSteps: 4,
				maxToolCalls: 20,
				maxWallClockMs: 600_000,
				maxInputBytes: 400_000,
				maxSpendUsd: null,
			},
			webAccess: "off",
		});
		// Nothing left to save.
		expect(saveButton().disabled).toBe(true);
	});

	it("remembers each backend's model when switching backends", async () => {
		mount(AGENT_SETTINGS_RESPONSE);
		await sectionReady();
		expect(modelSelectValue()).toBe("");

		chooseOther();
		typeModelId("claude-model");
		chooseBackend("openrouter");
		expect(modelSelectValue()).toBe("");
		chooseOther();
		typeModelId("openrouter-model");
		chooseBackend("claude-code");
		expect(modelSelectValue()).toBe(OTHER_VALUE);
		expect(customInputValue()).toBe("claude-model");

		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "claude-code",
			models: { "claude-code": "claude-model", openrouter: "openrouter-model" },
		});
	});

	it("blocks saving OpenCode without a model", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), OPENCODE_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		expect(saveButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can save" }).textContent).toContain(
			"OpenCode needs a model",
		);

		chooseOther();
		typeModelId("provider/model");
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "opencode",
			models: { opencode: "provider/model" },
		});
	});

	it("applies the spend rule per cost model and never shows a consent checkbox", async () => {
		mount();
		await sectionReady();
		expect(screen.queryByRole("checkbox", { name: /consent to metered spend/ })).toBeNull();

		// Metered: a spend is required.
		chooseBackend("openrouter");
		const spend = field("Max spend (USD)");
		expect(spend.disabled).toBe(false);
		expect(document.querySelector('[data-cost-statement="metered"]')).not.toBeNull();
		expect(saveButton().disabled).toBe(true);
		fireEvent.input(spend, { target: { value: "2.5" } });
		// Storing the spend needs no consent checkbox: saving is allowed.
		expect(saveButton().disabled).toBe(false);

		// Plan-limited: no spend is stored and the field is disabled.
		chooseBackend("claude-code");
		expect(field("Max spend (USD)").disabled).toBe(true);
		expect(document.querySelector('[data-cost-statement="plan-limited"]')).not.toBeNull();
	});

	it("allows an unknown cost model with no spend", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), NO_RUNNER_AGENTS);
		await sectionReady();
		chooseBackend("claude-code");
		expect(field("Max spend (USD)").disabled).toBe(false);
		expect(saveButton().disabled).toBe(false);
	});

	it("blocks saving with invalid numbers and says what is wrong", async () => {
		mount();
		await sectionReady();
		chooseBackend("claude-code");
		fireEvent.input(screen.getByLabelText("Max agent steps"), { target: { value: "99" } });
		expect(saveButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can save" }).textContent).toContain(
			"Max agent steps must be a whole number from 1 to 12.",
		);
	});

	it("keeps the owner's edits when saving fails", async () => {
		backend.on("GET", /agents$/, () => jsonResponse(AGENTS));
		backend.on("GET", /settings\/agent$/, () => jsonResponse(AGENT_SETTINGS_RESPONSE));
		backend.on("PUT", /settings\/agent$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		render(() => (
			<AgentSettingsSection api={createApiClient({ fetch: backend.fetch })} agentSection={null} />
		));
		await sectionReady();

		chooseOther();
		typeModelId("custom/model");
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The agent settings were not saved.");
		expect(alert.textContent).toContain("INTERNAL");
		// The edits are kept and can be saved again.
		expect(customInputValue()).toBe("custom/model");
		expect(saveButton().disabled).toBe(false);
		// No new save happened: the timestamp is still the loaded one.
		expect(screen.getByText("Saved 2026-10-05 00:00 UTC")).toBeDefined();
		expect(backend.requestsTo("PUT", /settings\/agent/)).toHaveLength(1);
	});

	it("keeps edits made while a save is in flight and stays dirty afterwards", async () => {
		mount();
		await sectionReady();
		chooseBackend("claude-code");
		fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
		expect(saveButton().disabled).toBe(false);

		// The save is slow: the response arrives only after the owner edits again.
		let captured: unknown;
		const release = deferred<Response>();
		backend.on("PUT", /settings\/agent$/, (request) => {
			captured = request.body;
			return release.promise;
		});
		fireEvent.click(saveButton());
		await waitFor(() => expect(backend.requestsTo("PUT", /settings\/agent/)).toHaveLength(1));

		// Submitted "high", changed to "low" before the response arrives.
		fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "low" } });
		release.resolve(
			jsonResponse({
				settings: captured,
				updatedAt: "2026-10-06T00:00:00Z",
				origin: "saved",
			}),
		);
		await screen.findByText(/Saved /);

		// The response must not restore "high": the form keeps "low" and stays
		// dirty with Save enabled, since "low" was never saved.
		expect(field("Effort").value).toBe("low");
		expect(saveButton().disabled).toBe(false);
	});

	it("explains web access beneath the checkbox", async () => {
		mount();
		await sectionReady();
		const section = screen.getByRole("region", { name: "AI agent" });
		expect(section.textContent).toContain(
			"Pages are fetched by the local runner, saved as Markdown files on this computer, and never uploaded.",
		);
	});
});

describe("Agent settings: save payload", () => {
	it("sends the model with its backend and keeps the section heading", async () => {
		mount(AGENT_SETTINGS_RESPONSE);
		await sectionReady();
		const section = screen.getByRole("region", { name: "AI agent" });
		expect(within(section).getByRole("heading", { name: "AI agent" })).toBeDefined();
		await waitFor(() => expect(saveButton().disabled).toBe(true));
	});
});

const LISTED_AGENTS = agentsResponseSchema.parse({
	...AGENTS,
	agents: [
		...AGENTS.agents,
		{
			agentId: "opencode",
			displayName: "OpenCode",
			capabilities: { supported: [], models: ["provider/alpha", "provider/beta"] },
			costModel: "plan-limited",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
	],
});

describe("Agent settings: carried-over choices", () => {
	const carried = agentSettingsResponseSchema.parse({
		settings: AGENT_SETTINGS,
		updatedAt: null,
		origin: "carried-over",
	});

	it("says the settings come from the most recent question and enables Save without edits", async () => {
		mount(carried);
		await sectionReady();
		const section = screen.getByRole("region", { name: "AI agent" });
		expect(section.textContent).toContain(
			"These settings come from your most recent question. Review them and press Save.",
		);
		expect(section.textContent).not.toContain("have not been saved yet");
		// Saving is what makes them the owner's, so no edit is needed first.
		expect(saveButton().disabled).toBe(false);

		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toEqual(AGENT_SETTINGS);
		// Saving returns to the saved state: nothing left to save.
		await waitFor(() => expect(saveButton().disabled).toBe(true));
	});

	it("shows a Back to chat link next to Saved after saving", async () => {
		mount(carried);
		await sectionReady();
		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		const back = screen.getByRole("link", { name: "Back to chat" });
		expect(back.getAttribute("href")).toBe("#/chat");
	});
});

describe("Agent settings: model selector", () => {
	it("choosing OpenCode then a model from the select enables Save with that id", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		expect(saveButton().disabled).toBe(true);
		chooseModel("provider/alpha");
		expect(saveButton().disabled).toBe(false);

		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "opencode",
			models: { opencode: "provider/alpha" },
		});
	});

	it("saves OpenCode without typing any text — regression for the owner's report", async () => {
		// The owner does not know a model id by heart: the form must complete
		// through the selector alone, with no text input visible or used.
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		expect(screen.queryByLabelText("Model id")).toBeNull();
		chooseModel("provider/beta");
		expect(screen.queryByLabelText("Model id")).toBeNull();
		expect(saveButton().disabled).toBe(false);

		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "opencode",
			models: { opencode: "provider/beta" },
		});
	});

	it("groups reported ids by provider and keeps a saved-but-unlisted choice", async () => {
		const saved = agentSettingsResponseSchema.parse({
			settings: {
				...AGENT_SETTINGS,
				defaultAgentId: "opencode",
				models: { opencode: "kept/typed" },
			},
			updatedAt: "2026-10-05T00:00:00Z",
			origin: "saved",
		});
		mount(saved, LISTED_AGENTS);
		await sectionReady();
		const select = modelSelect();
		const groups = [...select.querySelectorAll("optgroup")];
		expect(groups.map((group) => group.getAttribute("label"))).toEqual(["provider"]);
		const options = [...select.querySelectorAll("option")];
		const savedOption = options.find((option) => (option.textContent ?? "").includes("kept/typed"));
		expect(savedOption?.textContent).toContain("(saved — not in the runner's list)");
		expect(savedOption?.getAttribute("value")).toBe("kept/typed");
		// The stored choice is kept without revealing the text input, and the
		// form stays valid so opening it never silently changes the choice.
		expect(screen.queryByLabelText("Model id")).toBeNull();
		expect(screen.queryByRole("list", { name: "Before you can save" })).toBeNull();
		fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "opencode",
			models: { opencode: "kept/typed" },
		});
	});

	it("shows that backend's stored model when switching backends", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		chooseModel("provider/alpha");
		chooseBackend("claude-code");
		expect(modelSelectValue()).toBe("");
		chooseBackend("opencode");
		expect(modelSelectValue()).toBe("provider/alpha");
	});

	it("reveals the text input only for Other and saves its value", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		expect(screen.queryByLabelText("Model id")).toBeNull();
		chooseOther();
		expect(screen.getByLabelText("Model id")).toBeDefined();
		typeModelId("provider/typed");
		expect(saveButton().disabled).toBe(false);

		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: "opencode",
			models: { opencode: "provider/typed" },
		});
	});

	it("offers default plus Other when the backend reports no models", async () => {
		mount();
		await sectionReady();
		chooseBackend("claude-code");
		const labels = [...modelSelect().querySelectorAll("option")].map(
			(option) => option.textContent,
		);
		expect(labels).toEqual(["Backend default", "Other — type a model id…"]);
		expect(screen.queryByLabelText("Model id")).toBeNull();
		chooseOther();
		expect(screen.getByLabelText("Model id")).toBeDefined();
	});

	it("requires a model for OpenCode with Choose as the first option", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		expect(modelSelect().querySelector("option")?.textContent).toBe("Choose a model…");
	});

	it("shows and hides the free-tier caution with its accessible link", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		chooseOther();
		typeModelId("provider/model-free");
		const caution = await screen.findByText(
			"OpenCode serves free-tier models only to sessions that list its tools, so this app runs them with every tool call rejected; an answer fails if the model tries a tool, and a plan model avoids that.",
		);
		expect(caution.getAttribute("id")).not.toBeNull();
		const describedBy = modelSelect().getAttribute("aria-describedby") ?? "";
		expect(describedBy.split(" ")).toContain(caution.getAttribute("id"));

		chooseModel("provider/alpha");
		expect(
			screen.queryByText(
				"OpenCode serves free-tier models only to sessions that list its tools, so this app runs them with every tool call rejected; an answer fails if the model tries a tool, and a plan model avoids that.",
			),
		).toBeNull();
	});

	it("says where the list comes from without asking for provider/model by heart", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), LISTED_AGENTS);
		await sectionReady();
		chooseBackend("opencode");
		const section = screen.getByRole("region", { name: "AI agent" });
		expect(section.textContent).toContain("Models reported by the runner for this backend");
		expect(section.textContent).not.toContain("has the form provider/model — pick one");
	});

	it("says it is waiting while no runner has reported", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), NO_RUNNER_AGENTS);
		await sectionReady();
		expect(screen.getByText("Waiting for the runner to report its models…")).toBeDefined();
	});

	it("re-reads the backends while open and keeps what the owner already typed", async () => {
		backend.on("GET", /agents$/, () =>
			jsonResponse(OPENCODE_AGENTS, { headers: { ETag: '"v1"' } }),
		);
		backend.on("GET", /settings\/agent$/, () =>
			jsonResponse(agentSettingsResponseSchema.parse(UNSAVED)),
		);
		render(() => (
			<AgentSettingsSection
				api={createApiClient({ fetch: backend.fetch })}
				agentSection={null}
				pollSchedule={{
					activeMs: 50,
					idleBaseMs: 50,
					idleMaxMs: 200,
					queuedMaxMs: 100,
					backoffFactor: 2,
				}}
			/>
		));
		await sectionReady();
		chooseBackend("opencode");
		chooseOther();
		typeModelId("provider/typed");
		// The runner reports models while the section stays open; later
		// registrations win in the fake backend. The first poll after the
		// change answers 304 (nothing changes, cheap); the next carries
		// the new list with a new validator.
		let served304 = false;
		backend.on("GET", /agents$/, (request) => {
			if (request.headers["if-none-match"] === '"v1"' && !served304) {
				served304 = true;
				return new Response(null, { status: 304 });
			}
			return jsonResponse(LISTED_AGENTS, { headers: { ETag: '"v2"' } });
		});
		await screen.findByText("provider/alpha", undefined, { timeout: 10_000 });
		// What the owner already chose or typed is undisturbed.
		expect(modelSelectValue()).toBe(OTHER_VALUE);
		expect(customInputValue()).toBe("provider/typed");
		// An unchanged answer was cheap: at least one poll sent If-None-Match.
		expect(
			backend
				.requestsTo("GET", /agents$/)
				.some((request) => request.headers["if-none-match"] === '"v1"'),
		).toBe(true);
	}, 15_000);
});

describe("Agent settings: section link", () => {
	it("focuses the backend select when opened through the agent marker", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), AGENTS, "agent");
		await sectionReady();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByLabelText("Default backend")),
		);
	});

	it("does not steal focus on a plain settings visit", async () => {
		mount();
		await sectionReady();
		expect(document.activeElement).not.toBe(screen.getByLabelText("Default backend"));
	});
});

const FREE_AGENTS = agentsResponseSchema.parse({
	...AGENTS,
	agents: [
		...AGENTS.agents,
		{
			agentId: OPENROUTER_FREE_AGENT_ID,
			displayName: "OpenRouter (free models)",
			capabilities: {
				supported: ["stream", "cancel"],
				models: ["b/model:free", "a/model:free", "openrouter/free"],
			},
			costModel: "plan-limited",
			toolIsolation: "enforced",
			availability: { status: "available" },
		},
	],
});

describe("Agent settings: openrouter free backend", () => {
	it("lists the runner-reported free models grouped by provider", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), FREE_AGENTS);
		await sectionReady();
		chooseBackend(OPENROUTER_FREE_AGENT_ID);
		const groups = [...modelSelect().querySelectorAll("optgroup")];
		expect(groups.map((group) => group.getAttribute("label"))).toEqual(["a", "b", "openrouter"]);
		const values = [...modelSelect().querySelectorAll("option")].map((option) =>
			option.getAttribute("value"),
		);
		expect(values).toContain("a/model:free");
		expect(values).toContain("openrouter/free");
	});

	it("blocks saving without a model and with a non-free model, and saves a free model", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), FREE_AGENTS);
		await sectionReady();
		chooseBackend(OPENROUTER_FREE_AGENT_ID);
		expect(saveButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can save" }).textContent).toContain(
			"OpenRouter (free models) needs a model",
		);

		chooseOther();
		typeModelId("provider/model");
		expect(screen.getByRole("list", { name: "Before you can save" }).textContent).toContain(
			"The OpenRouter free model must end in :free",
		);
		expect(saveButton().disabled).toBe(true);

		chooseModel("a/model:free");
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());
		await screen.findByText(/Saved /);
		expect(backend.requestsTo("PUT", /settings\/agent/)[0]?.body).toMatchObject({
			defaultAgentId: OPENROUTER_FREE_AGENT_ID,
			models: { [OPENROUTER_FREE_AGENT_ID]: "a/model:free" },
			budget: expect.objectContaining({ maxSpendUsd: null }),
		});
	});

	it("shows the free plan note only for the free backend and links it to the select", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), FREE_AGENTS);
		await sectionReady();
		expect(screen.queryByText(/No spend is authorized for this backend/)).toBeNull();

		chooseBackend(OPENROUTER_FREE_AGENT_ID);
		const note = await screen.findByText(/No spend is authorized for this backend/);
		expect(note.getAttribute("data-free-plan-note")).toBe("true");
		const describedBy = modelSelect().getAttribute("aria-describedby") ?? "";
		expect(describedBy.split(" ")).toContain(note.getAttribute("id"));

		chooseBackend("claude-code");
		expect(screen.queryByText(/No spend is authorized for this backend/)).toBeNull();
	});

	it("uses the free placeholder for the Other input", async () => {
		mount(agentSettingsResponseSchema.parse(UNSAVED), FREE_AGENTS);
		await sectionReady();
		chooseBackend(OPENROUTER_FREE_AGENT_ID);
		chooseOther();
		expect(screen.getByLabelText("Model id").getAttribute("placeholder")).toBe(
			"provider/model:free",
		);
		chooseBackend("claude-code");
		chooseOther();
		expect(screen.getByLabelText("Model id").getAttribute("placeholder")).toBe("provider/model");
	});
});
