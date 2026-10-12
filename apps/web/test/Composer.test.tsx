import {
	type AgentSettingsResponse,
	type AgentsResponse,
	agentSettingsResponseSchema,
	agentsResponseSchema,
	idempotencyKeySchema,
	type ResearchRequest,
	type ResearchRun,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../src/api/http.ts";
import { Composer } from "../src/chat/Composer.tsx";
import type { Remote } from "../src/lib/remote.ts";
import {
	AGENT_SETTINGS,
	AGENT_SETTINGS_RESPONSE,
	AGENTS,
	DEFAULT_BUDGET,
	makeRun,
	NO_RUNNER_AGENTS,
	WORKSPACE_ID,
} from "./fixtures.ts";

afterEach(cleanup);

type SubmitFn = (request: ResearchRequest, key: string) => Promise<ApiResult<ResearchRun>>;

const METERED_RESPONSE: AgentSettingsResponse = agentSettingsResponseSchema.parse({
	settings: {
		defaultAgentId: "openrouter",
		models: { openrouter: "provider/model" },
		effort: "high",
		budget: { ...DEFAULT_BUDGET, maxSpendUsd: 3 },
		webAccess: "public-web",
	},
	updatedAt: "2026-10-05T00:00:00Z",
	origin: "saved",
});

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

function mount(
	agents: Remote<AgentsResponse> = { status: "ready", value: AGENTS },
	settings: Remote<AgentSettingsResponse> = { status: "ready", value: AGENT_SETTINGS_RESPONSE },
	onSubmit: SubmitFn = async () => ({ ok: true, value: makeRun({ state: "pending" }) }),
	suggestion?: () => { readonly text: string; readonly nonce: number } | null,
) {
	let counter = 0;
	const submit = vi.fn(onSubmit);
	const reloadAgents = vi.fn();
	const reloadSettings = vi.fn();
	render(() => (
		<Composer
			workspaceId={WORKSPACE_ID}
			agents={agents}
			settings={settings}
			onReloadAgents={reloadAgents}
			onReloadSettings={reloadSettings}
			newIdempotencyKey={() => {
				counter += 1;
				return `idem-test-key-${counter}`;
			}}
			onSubmit={submit}
			suggestion={suggestion}
		/>
	));
	return { submit, reloadAgents, reloadSettings };
}

function submitButton(): HTMLButtonElement {
	const button = screen.getByRole("button", { name: /Send/ });
	if (!(button instanceof HTMLButtonElement)) throw new Error("submit is not a button");
	return button;
}

function consentCheckbox(): HTMLInputElement {
	const element = screen.getByRole("checkbox", { name: /consent to metered spend/ });
	if (!(element instanceof HTMLInputElement)) throw new Error("consent is not a checkbox input");
	return element;
}

function typeQuestion(text = "Where will storage demand grow?") {
	fireEvent.input(screen.getByLabelText("Question"), { target: { value: text } });
}

function questionValue(): string {
	const element = screen.getByLabelText("Question");
	if (!(element instanceof HTMLTextAreaElement)) throw new Error("question is not a textarea");
	return element.value;
}

function questionBox(): HTMLTextAreaElement {
	const element = screen.getByLabelText("Question");
	if (!(element instanceof HTMLTextAreaElement)) throw new Error("question is not a textarea");
	return element;
}

function composerText(): string {
	return screen.getByRole("form", { name: "Research composer" }).textContent ?? "";
}

describe("Composer: fields", () => {
	it("asks only the question, horizon and markets; agent choices are read-only", () => {
		mount();
		expect(screen.getByRole("form", { name: "Research composer" })).toBeDefined();
		expect(screen.getByLabelText("Question")).toBeDefined();
		expect(screen.getByLabelText("Question").getAttribute("placeholder")).toBe(
			"Ask a research question…",
		);
		const horizon = screen.getByLabelText("Horizon");
		expect([...horizon.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
			"3 years",
			"4 years",
			"5 years",
		]);
		expect(screen.getByRole("checkbox", { name: "Japan (JP)" })).toBeDefined();
		expect(screen.getByRole("checkbox", { name: "United States (US)" })).toBeDefined();
		// Backend, effort and budget are no longer inputs of this form.
		expect(screen.queryByLabelText("Agent backend")).toBeNull();
		expect(screen.queryByLabelText("Effort")).toBeNull();
		expect(screen.queryByLabelText("Default backend")).toBeNull();
		expect(screen.queryByLabelText("Max agent steps")).toBeNull();
		expect(screen.queryByLabelText("Max spend (USD)")).toBeNull();
	});

	it("summarises the saved agent as one line with a link to Settings → AI agent", () => {
		mount();
		const form = composerText();
		expect(form).toContain("Claude Code (available)");
		expect(form).toContain("backend default");
		expect(form).toContain("medium");
		expect(form).toContain("web access off");
		// Limits and the cost statement live in Settings → AI agent, not here
		// (owner decision 2026-10-12).
		expect(form).not.toContain("Limits and cost");
		expect(form).not.toContain("6 steps");
		expect(form).not.toContain("20 tool calls");
		expect(form).not.toContain("no metered spend authorized");
		const link = screen.getByRole("link", { name: "Change in Settings → AI agent" });
		expect(link.getAttribute("href")).toBe("#/settings/agent");
	});

	it("names the stored model and web access when set", () => {
		mount(undefined, { status: "ready", value: METERED_RESPONSE });
		expect(composerText()).toContain("OpenRouter (available)");
		expect(composerText()).toContain("provider/model");
		expect(composerText()).toContain("high");
		expect(composerText()).toContain("web access on");
		// The metered allowance is stated in the consent label itself.
		expect(
			screen.getByRole("checkbox", { name: /consent to metered spend up to \$3\.00/ }),
		).toBeDefined();
		expect(composerText()).not.toContain("Limits and cost");
	});

	it("shows the current options choice in the disclosure summary", () => {
		mount();
		expect(screen.getByText("Options: 5 years · JP, US")).toBeDefined();
		fireEvent.change(screen.getByLabelText("Horizon"), { target: { value: "3" } });
		expect(screen.getByText("Options: 3 years · JP, US")).toBeDefined();
	});

	it("says the runner is offline and the question will be queued when none has reported", () => {
		mount(
			{ status: "ready", value: NO_RUNNER_AGENTS },
			{ status: "ready", value: AGENT_SETTINGS_RESPONSE },
		);
		const notice = document.querySelector("[data-runner-offline]");
		expect(notice?.textContent).toContain("Runner offline");
		expect(notice?.textContent).toContain("will be queued");
		typeQuestion();
		expect(submitButton().disabled).toBe(false);
	});
});

describe("Composer: agent settings loading", () => {
	it("cannot submit while the settings load", () => {
		mount(undefined, { status: "loading" });
		expect(screen.getByText("Loading agent settings…")).toBeDefined();
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Agent settings are still loading.",
		);
	});

	it("shows configuration problems before anything is typed", () => {
		mount(undefined, { status: "loading" });
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Agent settings are still loading.",
		);
		cleanup();

		const none: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: { ...AGENT_SETTINGS, defaultAgentId: null },
			updatedAt: null,
			origin: "defaults",
		});
		mount(undefined, { status: "ready", value: none });
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Choose a default agent backend in Settings → AI agent.",
		);
	});

	it("hides question problems until the owner types or tries to send", () => {
		mount();
		expect(screen.queryByRole("list", { name: "Before you can submit" })).toBeNull();
		fireEvent.submit(screen.getByRole("form", { name: "Research composer" }));
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Enter a research question",
		);
	});

	it("announces configuration problems above the input with a settings link", () => {
		const none: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: { ...AGENT_SETTINGS, defaultAgentId: null },
			updatedAt: null,
			origin: "defaults",
		});
		mount(undefined, { status: "ready", value: none });
		const composer = screen.getByRole("form", { name: "Research composer" });
		// The configuration problem is announced above the input and stays in
		// the list below it.
		const problems = within(composer).getAllByText(
			"Choose a default agent backend in Settings → AI agent.",
		);
		expect(problems).toHaveLength(2);
		const first = problems[0];
		if (first === undefined) throw new Error("expected the configuration problem in the notice");
		const notice = first.closest("output");
		if (!(notice instanceof HTMLElement)) throw new Error("expected the problem inside a notice");
		const link = within(composer).getByRole("link", { name: "Open Settings → AI agent" });
		expect(link.getAttribute("href")).toBe("#/settings/agent");
		// The notice sits above the question input, not in the list below it.
		expect(
			notice.compareDocumentPosition(screen.getByLabelText("Question")) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("shows a settings error with retry", () => {
		const failure = {
			kind: "network" as const,
			code: "NETWORK_ERROR" as const,
			status: null,
			message: "The request could not be completed (down).",
			detail: null,
			issues: [],
		};
		const { reloadSettings } = mount(undefined, { status: "error", error: failure });
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Could not load agent settings.");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(reloadSettings).toHaveBeenCalledTimes(1);
	});
});

describe("Composer: cost honesty and consent (FR-016)", () => {
	it("shows no limits or cost statement for a plan-limited backend, never $0, and sends no spend allowance", async () => {
		const { submit } = mount();
		typeQuestion();

		// Limits and the cost statement live in Settings → AI agent (owner
		// decision 2026-10-12): the composer shows only the backend summary.
		expect(document.querySelector("[data-cost-statement]")).toBeNull();
		expect(screen.queryByText("Limits and cost")).toBeNull();
		expect(composerText()).toContain("Claude Code (available)");
		expect(screen.getByRole("form", { name: "Research composer" }).textContent).not.toMatch(
			/\$\s?0/,
		);
		expect(screen.queryByRole("checkbox", { name: /consent to metered spend/ })).toBeNull();
		expect(submitButton().disabled).toBe(false);

		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const [request, key] = submit.mock.calls[0] ?? [];
		expect(request?.agentId).toBe("claude-code");
		expect(request?.model).toBeNull();
		expect(request?.effort).toBe("medium");
		expect(request?.budget.maxSpendUsd).toBeNull();
		expect(request?.webAccess).toBe("off");
		expect(request?.workspaceId).toBe(WORKSPACE_ID);
		expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
	});

	it("keeps submit disabled for a metered backend until consent is given on the form", async () => {
		const { submit } = mount(undefined, { status: "ready", value: METERED_RESPONSE });
		typeQuestion();

		// The consent label states the metered allowance itself (no "above").
		expect(
			screen.getByRole("checkbox", { name: /consent to metered spend up to \$3\.00/ }),
		).toBeDefined();
		expect(document.querySelector("[data-cost-statement]")).toBeNull();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Confirm consent to metered spend on the form itself.",
		);

		fireEvent.click(consentCheckbox());
		expect(submitButton().disabled).toBe(false);
		expect(screen.queryByRole("list", { name: "Before you can submit" })).toBeNull();

		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0]?.[0].budget.maxSpendUsd).toBe(3);
	});

	it("does not submit a metered request when the form is submitted without consent", () => {
		const { submit } = mount(undefined, { status: "ready", value: METERED_RESPONSE });
		typeQuestion();
		fireEvent.submit(screen.getByRole("form", { name: "Research composer" }));
		expect(submit).not.toHaveBeenCalled();
	});

	it("withdraws consent after a submission", async () => {
		mount(undefined, { status: "ready", value: METERED_RESPONSE });
		typeQuestion();
		fireEvent.click(consentCheckbox());
		expect(submitButton().disabled).toBe(false);

		fireEvent.click(submitButton());
		await screen.findByText("Question queued. It starts when a runner claims it.");
		expect(consentCheckbox().checked).toBe(false);
		expect(submitButton().disabled).toBe(true);
	});

	it("cannot submit to a metered backend whose stored spend is zero", () => {
		const response: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: {
				...METERED_RESPONSE.settings,
				budget: { ...METERED_RESPONSE.settings.budget, maxSpendUsd: 0 },
			},
			updatedAt: "2026-10-05T00:00:00Z",
			origin: "saved",
		});
		mount(undefined, { status: "ready", value: response });
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"in Settings → AI agent",
		);
	});

	it("cannot submit when the settings chose no backend, an unavailable one, or OpenCode without a model", () => {
		const none: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: { ...AGENT_SETTINGS, defaultAgentId: null },
			updatedAt: null,
			origin: "defaults",
		});
		mount(undefined, { status: "ready", value: none });
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Choose a default agent backend in Settings → AI agent.",
		);
		cleanup();

		const codex: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: { ...AGENT_SETTINGS, defaultAgentId: "codex" },
			updatedAt: "2026-10-05T00:00:00Z",
			origin: "saved",
		});
		mount(undefined, { status: "ready", value: codex });
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Codex is unavailable (NOT_INSTALLED)",
		);
		cleanup();

		const opencode: AgentSettingsResponse = agentSettingsResponseSchema.parse({
			settings: { ...AGENT_SETTINGS, defaultAgentId: "opencode" },
			updatedAt: "2026-10-05T00:00:00Z",
			origin: "saved",
		});
		mount({ status: "ready", value: OPENCODE_AGENTS }, { status: "ready", value: opencode });
		typeQuestion();
		expect(submitButton().disabled).toBe(true);
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"OpenCode needs a model",
		);
	});
});

describe("Composer: submission", () => {
	it("shows the API error code and reuses the idempotency key when the same question is re-sent", async () => {
		let attempts = 0;
		const { submit } = mount(undefined, undefined, async () => {
			attempts += 1;
			if (attempts === 1) {
				return {
					ok: false,
					error: {
						kind: "api",
						code: "RATE_LIMITED",
						status: 429,
						message: "too many runs",
						detail: null,
						issues: [],
					},
				};
			}
			return { ok: true, value: makeRun({ state: "pending" }) };
		});
		typeQuestion();

		fireEvent.click(submitButton());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("RATE_LIMITED");
		expect(alert.textContent).toContain("too many runs");
		// The draft is kept so the owner can retry.
		expect(questionValue()).toBe("Where will storage demand grow?");

		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
		expect(submit.mock.calls[1]?.[1]).toBe(submit.mock.calls[0]?.[1]);
		await screen.findByText("Question queued. It starts when a runner claims it.");

		// A new question after a success gets a new key.
		typeQuestion("A different question");
		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
		expect(submit.mock.calls[2]?.[1]).not.toBe(submit.mock.calls[0]?.[1]);
	});

	it("keeps a new draft typed while the previous question was being submitted", async () => {
		let finish: (result: ApiResult<ResearchRun>) => void = () => {};
		const { submit } = mount(
			undefined,
			undefined,
			() =>
				new Promise<ApiResult<ResearchRun>>((resolve) => {
					finish = resolve;
				}),
		);
		typeQuestion("First question about storage");
		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

		// The request is in flight and the owner is already typing the next question.
		typeQuestion("A follow-up typed while waiting");
		finish({ ok: true, value: makeRun({ state: "pending" }) });
		await screen.findByText("Question queued. It starts when a runner claims it.");

		expect(questionValue()).toBe("A follow-up typed while waiting");
		expect(submit.mock.calls[0]?.[0].question).toBe("First question about storage");
	});

	it("clears the question after a submission when it was not edited meanwhile", async () => {
		mount();
		typeQuestion("  Padded question  ");
		fireEvent.click(submitButton());
		await screen.findByText("Question queued. It starts when a runner claims it.");
		expect(questionValue()).toBe("");
	});

	it("stays quiet after a successful send until the owner types again", async () => {
		mount();
		typeQuestion();
		fireEvent.click(submitButton());
		await screen.findByText("Question queued. It starts when a runner claims it.");
		expect(screen.queryByRole("list", { name: "Before you can submit" })).toBeNull();
		typeQuestion("ab");
		expect(screen.getByRole("list", { name: "Before you can submit" }).textContent).toContain(
			"Enter a research question",
		);
	});

	it("sends the horizon and markets from the form with the agent choices from the settings", async () => {
		const { submit } = mount(undefined, { status: "ready", value: METERED_RESPONSE });
		typeQuestion();
		fireEvent.change(screen.getByLabelText("Horizon"), { target: { value: "3" } });
		fireEvent.click(screen.getByRole("checkbox", { name: "Japan (JP)" }));
		fireEvent.click(consentCheckbox());

		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		const request = submit.mock.calls[0]?.[0];
		expect(request?.horizonYears).toBe(3);
		expect(request?.markets).toEqual(["US"]);
		expect(request?.agentId).toBe("openrouter");
		expect(request?.model).toBe("provider/model");
		expect(request?.effort).toBe("high");
		expect(request?.webAccess).toBe("public-web");
	});

	it("requires at least one market", () => {
		mount();
		typeQuestion();
		fireEvent.click(screen.getByRole("checkbox", { name: "Japan (JP)" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "United States (US)" }));
		expect(submitButton().disabled).toBe(true);
	});

	it("sends on Enter through the same submit path as the button", async () => {
		const { submit } = mount();
		typeQuestion("Which storage products will grow?");
		fireEvent.keyDown(questionBox(), { key: "Enter", shiftKey: false, isComposing: false });
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0]?.[0].question).toBe("Which storage products will grow?");
	});

	it("does not send on Shift+Enter", () => {
		const { submit } = mount();
		typeQuestion("A two-line question");
		fireEvent.keyDown(questionBox(), { key: "Enter", shiftKey: true, isComposing: false });
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not send on Enter while an IME composition is active", () => {
		const { submit } = mount();
		typeQuestion("日本語の質問");
		fireEvent.keyDown(questionBox(), { key: "Enter", shiftKey: false, isComposing: true });
		expect(submit).not.toHaveBeenCalled();
		cleanup();

		mount();
		typeQuestion("日本語の質問");
		fireEvent.keyDown(questionBox(), { key: "Enter", shiftKey: false, keyCode: 229 });
		expect(submit).not.toHaveBeenCalled();
	});

	it("fills the input from a suggestion without sending", () => {
		const suggestion = () => ({ text: "Which products will see demand growth?", nonce: 1 });
		const { submit } = mount(undefined, undefined, undefined, suggestion);
		expect(questionValue()).toBe("Which products will see demand growth?");
		expect(submit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(questionBox());
	});
});

describe("Composer: carried-over settings", () => {
	const carried: AgentSettingsResponse = agentSettingsResponseSchema.parse({
		settings: AGENT_SETTINGS,
		updatedAt: null,
		origin: "carried-over",
	});

	it("sends with the carried-over backend like saved settings and says where it came from", async () => {
		const { submit } = mount(undefined, { status: "ready", value: carried });
		typeQuestion();
		expect(submitButton().disabled).toBe(false);
		expect(composerText()).toContain("Using the backend of your last question");
		const link = screen.getByRole("link", { name: "review in Settings → AI agent" });
		expect(link.getAttribute("href")).toBe("#/settings/agent");

		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
		expect(submit.mock.calls[0]?.[0].agentId).toBe("claude-code");
	});

	it("shows no carried-over note for saved settings", () => {
		mount();
		typeQuestion();
		expect(screen.queryByText(/Using the backend of your last question/)).toBeNull();
	});
});

describe("Composer: spend consent is consumed on dispatch (finding 1)", () => {
	const timeoutError = {
		kind: "api" as const,
		code: "TIMEOUT" as const,
		status: 504,
		message: "the request timed out",
		detail: null,
		issues: [],
	};

	function mountMetered(onSubmit: SubmitFn) {
		let counter = 0;
		const submit = vi.fn(onSubmit);
		render(() => (
			<Composer
				workspaceId={WORKSPACE_ID}
				agents={{ status: "ready", value: AGENTS }}
				settings={{ status: "ready", value: METERED_RESPONSE }}
				onReloadAgents={() => {}}
				onReloadSettings={() => {}}
				newIdempotencyKey={() => {
					counter += 1;
					return `idem-test-key-${counter}`;
				}}
				onSubmit={submit}
			/>
		));
		return { submit };
	}

	it("a timeout then a changed question is blocked until consent is given again", async () => {
		const { submit } = mountMetered(async () => ({ ok: false, error: timeoutError }));
		typeQuestion("Where will storage demand grow?");
		fireEvent.click(consentCheckbox());
		expect(submitButton().disabled).toBe(false);

		fireEvent.click(submitButton());
		await screen.findByRole("alert");
		expect(submit).toHaveBeenCalledTimes(1);
		// Consent was consumed by the dispatch, even though it failed: the
		// timed-out request may still have been accepted by the server.
		expect(consentCheckbox().checked).toBe(false);

		// A DIFFERENT request must not reuse the earlier consent.
		typeQuestion("A changed question about suppliers?");
		expect(submitButton().disabled).toBe(true);

		fireEvent.click(consentCheckbox());
		expect(submitButton().disabled).toBe(false);
		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
		expect(submit.mock.calls[1]?.[1]).not.toBe(submit.mock.calls[0]?.[1]);
		expect(submit.mock.calls[1]?.[0].question).toBe("A changed question about suppliers?");
	});

	it("a timeout then an identical resend reuses the key without fresh consent", async () => {
		const { submit } = mountMetered(async () => ({ ok: false, error: timeoutError }));
		typeQuestion("Where will storage demand grow?");
		fireEvent.click(consentCheckbox());

		fireEvent.click(submitButton());
		await screen.findByRole("alert");
		expect(submit).toHaveBeenCalledTimes(1);
		expect(consentCheckbox().checked).toBe(false);

		// The identical resend is the same authorised action: still sendable.
		expect(submitButton().disabled).toBe(false);
		fireEvent.click(submitButton());
		await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
		expect(submit.mock.calls[1]?.[1]).toBe(submit.mock.calls[0]?.[1]);
		expect(submit.mock.calls[1]?.[0].question).toBe("Where will storage demand grow?");
	});
});

describe("Composer: the queued note follows its run (finding 12)", () => {
	it("disappears as soon as its run leaves pending", async () => {
		const queued = makeRun({ runId: "run_queued", state: "pending", provenance: null });
		const done = makeRun({ runId: "run_queued", state: "completed" });
		const [runs, setRuns] = createSignal<readonly ResearchRun[]>([]);
		let counter = 0;
		render(() => (
			<Composer
				workspaceId={WORKSPACE_ID}
				agents={{ status: "ready", value: AGENTS }}
				settings={{ status: "ready", value: AGENT_SETTINGS_RESPONSE }}
				onReloadAgents={() => {}}
				onReloadSettings={() => {}}
				newIdempotencyKey={() => {
					counter += 1;
					return `idem-test-key-${counter}`;
				}}
				onSubmit={async () => ({ ok: true, value: queued })}
				runs={runs()}
			/>
		));
		typeQuestion();
		fireEvent.click(submitButton());
		await screen.findByText("Question queued. It starts when a runner claims it.");

		// The run is claimed and completes: its note must not outlive it.
		setRuns([queued]);
		await waitFor(() =>
			expect(
				screen.queryByText("Question queued. It starts when a runner claims it."),
			).not.toBeNull(),
		);
		setRuns([done]);
		await waitFor(() =>
			expect(screen.queryByText("Question queued. It starts when a runner claims it.")).toBeNull(),
		);
	});
});
