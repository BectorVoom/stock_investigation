import {
	type AgentSettings,
	type AgentSettingsResponse,
	type AgentsResponse,
	OPENROUTER_FREE_AGENT_ID,
} from "@research/contracts";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { SpendField } from "../components/SpendField.tsx";
import {
	BUTTON_PRIMARY,
	ErrorNotice,
	INPUT,
	LABEL,
	Loading,
	Notice,
	Section,
	Select,
} from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import type { PollSchedule } from "../lib/polling.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createRemote, type Remote } from "../lib/remote.ts";
import {
	type AgentSettingsDraft,
	agentOptions,
	backendRequiresModel,
	buildModelSelectOptions,
	evaluateAgentSettings,
	FREE_PLAN_NOTE,
	FREE_TIER_CAUTION,
	isFreeTierModelId,
	isSettingsDraftChanged,
	MODEL_OTHER_LABEL,
	MODEL_OTHER_VALUE,
	MODEL_SAVED_SUFFIX,
	modelSelectValue,
	runnerNotice,
	settingsDraftFrom,
} from "./agentSettingsModel.ts";

const EFFORTS = ["low", "medium", "high"] as const;

/** Always visible: polls immediately and on schedule (tests, and callers without a document). */
const ALWAYS_VISIBLE: VisibilitySource = {
	isVisible: () => true,
	subscribe: () => () => {},
};

/**
 * Agent backends, re-read while the section is open on the same
 * visibility-aware polling the Chat page uses. Conditional requests keep an
 * unchanged answer cheap (a 304 keeps the last value); a changed answer
 * updates the selector in place without touching the owner's draft.
 * Must be created under a Solid owner.
 */
function createAgentsPoller(api: ApiClient, visibility: VisibilitySource, schedule?: PollSchedule) {
	const [state, setState] = createSignal<Remote<AgentsResponse>>({ status: "loading" });
	const [value, setValue] = createSignal<AgentsResponse | null>(null);
	let etag: string | null = null;
	let disposed = false;

	const fetchList = async (): Promise<PollSignal> => {
		const result = await api.pollAgents(etag);
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (value() === null) setState({ status: "error", error: result.error });
			return "failed";
		}
		const conditional = result.value;
		if (!conditional.changed) return "unchanged";
		etag = conditional.etag;
		setValue(() => conditional.value);
		setState({ status: "ready", value: conditional.value });
		return "changed";
	};

	const poller = createPoller({ poll: fetchList, visibility, schedule });
	poller.start();
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	return {
		state,
		value,
		reload: async (): Promise<void> => {
			await fetchList();
		},
		pollNow: () => poller.pollNow(),
	};
}

/**
 * Settings → AI agent: the one place where the default backend, its model,
 * effort, per-question limits and web access are chosen (FR-012). The
 * question form only reads what is saved here. Pure rules live in
 * agentSettingsModel; this component only renders and dispatches.
 */
export function AgentSettingsSection(props: {
	readonly api: ApiClient;
	/** From the `#/settings/agent` route marker: scroll here and focus the backend select. */
	readonly agentSection: string | null;
	/** Visibility-aware polling source; defaults to always visible. */
	readonly visibility?: VisibilitySource;
	/** Poll schedule; tests pass a fast one so a re-read arrives without waiting. */
	readonly pollSchedule?: PollSchedule;
}): JSX.Element {
	const agents = createAgentsPoller(
		props.api,
		props.visibility ?? ALWAYS_VISIBLE,
		props.pollSchedule,
	);
	const stored = createRemote(() => props.api.getAgentSettings());
	const [original, setOriginal] = createSignal<AgentSettings | null>(null);
	const [draft, setDraft] = createSignal<AgentSettingsDraft | null>(null);
	const [savedAt, setSavedAt] = createSignal<string | null>(null);
	const [origin, setOrigin] = createSignal<AgentSettingsResponse["origin"]>("defaults");
	const [initialized, setInitialized] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [sectionLinked, setSectionLinked] = createSignal(false);

	// The loaded settings seed the draft once; later edits (and failed saves)
	// belong to the owner until a save returns.
	createEffect(() => {
		const loaded = stored.value();
		if (loaded !== null && !initialized()) {
			setOriginal(loaded.settings);
			setDraft(settingsDraftFrom(loaded.settings));
			setSavedAt(loaded.updatedAt);
			setOrigin(loaded.origin);
			setInitialized(true);
		}
	});

	const agentsValue = createMemo(() => (agents.state().status === "ready" ? agents.value() : null));
	const agentsError = createMemo(() => {
		const remote = agents.state();
		return remote.status === "error" ? remote.error : null;
	});
	const settingsError = createMemo(() => {
		const remote = stored.state();
		return remote.status === "error" ? remote.error : null;
	});
	const options = createMemo(() => agentOptions(agentsValue()));
	const evaluation = createMemo(() => {
		const current = draft();
		return current === null ? null : evaluateAgentSettings(current, agentsValue());
	});
	const changed = createMemo(() => {
		const current = draft();
		const previous = original();
		return current !== null && previous !== null && isSettingsDraftChanged(current, previous);
	});
	// Saving carried-over settings is what makes them the owner's, so Save is
	// enabled for them even though nothing was edited.
	const canSave = createMemo(
		() =>
			(changed() || origin() === "carried-over") && evaluation()?.settings !== null && !saving(),
	);
	const offlineNotice = createMemo(() => runnerNotice(agentsValue()));
	// While no runner has reported, the model field says so instead of
	// offering an empty list: a first-time owner opens Settings exactly then.
	const waitingForModels = createMemo(() => {
		const current = agentsValue();
		return current === null || current.runnerLastSeenAt === null;
	});
	const selectedBackendId = createMemo(() => draft()?.defaultAgentId ?? "");
	const reportedList = createMemo(() => evaluation()?.reportedModels ?? null);
	const modelText = createMemo(() => evaluation()?.modelText ?? "");
	const trimmedModel = createMemo(() => modelText().trim());
	const requiresModel = createMemo(() => backendRequiresModel(selectedBackendId()));
	const selectOptions = createMemo(() =>
		buildModelSelectOptions(reportedList(), trimmedModel(), requiresModel()),
	);
	const reportedSet = createMemo(() => new Set(reportedList() ?? []));
	const [otherModes, setOtherModes] = createSignal<Readonly<Record<string, boolean>>>({});
	const otherMode = createMemo(() => otherModes()[selectedBackendId()] ?? false);
	const selectValue = createMemo(() => modelSelectValue(modelText(), otherMode()));
	// A free-tier id is a caution, never a blocker: the app runs those models
	// with every tool call rejected, so an answer fails only if the model
	// tries a tool — a plan model avoids that. The models stay listed.
	const showFreeCaution = createMemo(
		() =>
			selectedBackendId() === "opencode" &&
			trimmedModel() !== "" &&
			isFreeTierModelId(trimmedModel()),
	);
	const isFreeBackend = createMemo(() => selectedBackendId() === OPENROUTER_FREE_AGENT_ID);
	const selectedDisplayName = createMemo(() => evaluation()?.selectedAgent?.displayName ?? "");

	const backendId = createUniqueId();
	const modelSelectId = createUniqueId();
	const customModelId = createUniqueId();
	const modelHelpId = createUniqueId();
	const modelCautionId = createUniqueId();
	const freePlanNoteId = createUniqueId();
	const modelDescribedBy = createMemo(() => {
		const ids = [modelHelpId];
		if (showFreeCaution()) ids.push(modelCautionId);
		if (isFreeBackend()) ids.push(freePlanNoteId);
		return ids.join(" ");
	});
	const effortId = createUniqueId();
	const webAccessId = createUniqueId();
	const problemsId = createUniqueId();

	// A `#/settings/agent` link lands on this section: scroll it into view and
	// move focus to the backend select once the form is usable.
	createEffect(() => {
		if (props.agentSection !== "agent" || sectionLinked() || draft() === null) return;
		if (agents.state().status !== "ready") return;
		const select = document.getElementById(backendId);
		if (!(select instanceof HTMLSelectElement)) return;
		setSectionLinked(true);
		select.scrollIntoView({ block: "center" });
		select.focus({ preventScroll: true });
	});

	const setModelText = (text: string) => {
		const current = draft();
		if (current === null || current.defaultAgentId === "") return;
		const models = { ...current.models };
		if (text === "") delete models[current.defaultAgentId];
		else models[current.defaultAgentId] = text;
		setDraft({ ...current, models });
	};

	const onModelSelect = (value: string) => {
		const backend = selectedBackendId();
		if (backend === "") return;
		if (value === MODEL_OTHER_VALUE) {
			// Typing starts fresh from the default or a listed id; an
			// unlisted saved id stays as the starting text to be edited.
			const trimmed = trimmedModel();
			if (trimmed === "" || reportedSet().has(trimmed)) {
				if (trimmed !== "") setModelText("");
			}
			setOtherModes((previous) => ({ ...previous, [backend]: true }));
			return;
		}
		setModelText(value);
		setOtherModes((previous) => ({ ...previous, [backend]: false }));
	};

	const save = async (event: SubmitEvent) => {
		event.preventDefault();
		const next = evaluation()?.settings ?? null;
		const submitted = draft();
		if (next === null || submitted === null || saving()) return;
		setSaving(true);
		setFailure(null);
		const result = await props.api.saveAgentSettings(next);
		setSaving(false);
		if (result.ok) {
			setOriginal(result.value.settings);
			setSavedAt(result.value.updatedAt);
			setOrigin(result.value.origin);
			// The response describes what was saved, not what the owner is
			// editing now: edits made after the submitted draft was captured
			// belong to the owner and must survive. Only a draft that has not
			// moved on is replaced, so "Saved" means what was actually saved —
			// otherwise the form stays dirty with Save enabled.
			const savedDraft = settingsDraftFrom(result.value.settings);
			const submittedText = JSON.stringify(submitted);
			setDraft((current) =>
				current === null || JSON.stringify(current) === submittedText ? savedDraft : current,
			);
		} else {
			// The owner's edits are kept so they can be fixed and saved again.
			setFailure(result.error);
		}
	};

	return (
		<Section title="AI agent">
			<Show when={stored.state().status === "loading" && draft() === null}>
				<Loading label="agent settings" />
			</Show>
			<Show when={settingsError()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title="Could not load agent settings."
						onRetry={() => void stored.reload()}
					/>
				)}
			</Show>
			<Show when={draft()}>
				{(current) => (
					<form aria-label="AI agent settings" class="mt-2 space-y-2" noValidate onSubmit={save}>
						<Show when={savedAt() === null && origin() === "defaults"}>
							<p class="text-xs text-slate-700">
								These are the defaults — they have not been saved yet.
							</p>
						</Show>
						<Show when={savedAt() === null && origin() === "carried-over"}>
							<p class="text-xs text-slate-700">
								These settings come from your most recent question. Review them and press Save.
							</p>
						</Show>

						<Show when={offlineNotice()}>
							{(text) => (
								<Notice tone="warning" data-runner-offline="true">
									{text()}
								</Notice>
							)}
						</Show>

						<div>
							<label for={backendId} class={LABEL}>
								Default backend
							</label>
							<Show when={agents.state().status === "loading"}>
								<Loading label="agent backends" />
							</Show>
							<Show when={agentsError()}>
								{(error) => (
									<ErrorNotice
										failure={error()}
										title="Could not load agent backends."
										onRetry={() => void agents.reload()}
									/>
								)}
							</Show>
							<Select
								id={backendId}
								disabled={agentsValue() === null}
								onChange={(event) =>
									setDraft({ ...current(), defaultAgentId: event.currentTarget.value })
								}
							>
								<option value="" selected={current().defaultAgentId === ""}>
									Choose a backend…
								</option>
								<For each={options()}>
									{(option) => (
										<option
											value={option.agentId}
											disabled={!option.selectable}
											selected={current().defaultAgentId === option.agentId}
										>
											{option.displayName} — {option.status}
										</option>
									)}
								</For>
							</Select>
							<ul
								aria-label="Backend availability"
								class="mt-1 space-y-0.5 text-2xs text-slate-700"
							>
								<For each={options()}>
									{(option) => (
										<li data-agent-id={option.agentId} data-selectable={option.selectable}>
											<span class="font-semibold">{option.displayName}: </span>
											{option.detail}
										</li>
									)}
								</For>
							</ul>
						</div>

						<div>
							<label for={modelSelectId} class={LABEL}>
								Model for this backend
							</label>
							<Select
								id={modelSelectId}
								disabled={current().defaultAgentId === ""}
								describedBy={modelDescribedBy()}
								onChange={(event) => onModelSelect(event.currentTarget.value)}
							>
								<option value="" selected={selectValue() === ""}>
									{selectOptions().firstOptionLabel}
								</option>
								<For each={selectOptions().groups}>
									{(group) => (
										<optgroup label={group.provider}>
											<For each={group.models}>
												{(model) => (
													<option value={model} selected={selectValue() === model}>
														{model}
													</option>
												)}
											</For>
										</optgroup>
									)}
								</For>
								<Show when={selectOptions().savedModel}>
									{(saved) => (
										<option value={saved()} selected={selectValue() === saved()}>
											{saved()}
											{MODEL_SAVED_SUFFIX}
										</option>
									)}
								</Show>
								<option value={MODEL_OTHER_VALUE} selected={selectValue() === MODEL_OTHER_VALUE}>
									{MODEL_OTHER_LABEL}
								</option>
							</Select>
							<Show when={otherMode()}>
								<label for={customModelId} class={`${LABEL} mt-1`}>
									Model id
								</label>
								<input
									id={customModelId}
									type="text"
									class={INPUT}
									maxLength={100}
									placeholder={isFreeBackend() ? "provider/model:free" : "provider/model"}
									value={modelText()}
									onInput={(event) => setModelText(event.currentTarget.value)}
								/>
							</Show>
							<Show when={showFreeCaution()}>
								<p id={modelCautionId} class="mt-0.5 text-2xs text-amber-900">
									{FREE_TIER_CAUTION}
								</p>
							</Show>
							<Show when={isFreeBackend()}>
								<p
									id={freePlanNoteId}
									data-free-plan-note="true"
									class="mt-0.5 text-2xs text-slate-600"
								>
									{FREE_PLAN_NOTE}
								</p>
							</Show>
							<p id={modelHelpId} class="mt-0.5 text-2xs text-slate-600">
								<Show
									when={waitingForModels()}
									fallback={
										<>
											Models reported by the runner for this backend.{" "}
											{requiresModel()
												? `${selectedDisplayName()} needs a model — choose one from the list.`
												: "Empty means the backend's own default."}
										</>
									}
								>
									<span data-waiting-for-models="true">
										Waiting for the runner to report its models…
									</span>
								</Show>
							</p>
						</div>

						<div>
							<label for={effortId} class={LABEL}>
								Effort
							</label>
							<Select
								id={effortId}
								onChange={(event) => {
									const effort = EFFORTS.find(
										(candidate) => candidate === event.currentTarget.value,
									);
									if (effort !== undefined) setDraft({ ...current(), effort });
								}}
							>
								<For each={EFFORTS}>
									{(effort) => (
										<option value={effort} selected={current().effort === effort}>
											{effort}
										</option>
									)}
								</For>
							</Select>
						</div>

						{/* Per-question limits are fixed (ADR-0029); only a billing backend asks for a spend ceiling. */}
						<Show when={evaluation()?.spendEditable ?? false}>
							<SpendField
								draft={current().budget}
								onChange={(budget) => setDraft({ ...current(), budget })}
								spendConsentRequired={false}
								showConsent={false}
							/>
						</Show>

						<div>
							<label for={webAccessId} class="flex items-start gap-2 text-xs text-slate-900">
								<input
									id={webAccessId}
									type="checkbox"
									class="mt-0.5"
									checked={current().webAccess === "public-web"}
									onChange={(event) =>
										setDraft({
											...current(),
											webAccess: event.currentTarget.checked ? "public-web" : "off",
										})
									}
								/>
								<span>Allow the agent to open public web pages</span>
							</label>
							<p class="mt-0.5 text-2xs text-slate-600">
								Pages are fetched by the local runner, saved as Markdown files on this computer, and
								never uploaded.
							</p>
						</div>

						<p data-cost-statement={evaluation()?.costModel} class="text-xs text-slate-800">
							<span class="font-semibold">Cost: </span>
							{evaluation()?.costStatement}
						</p>

						<Show when={(evaluation()?.problems.length ?? 0) > 0}>
							<ul
								id={problemsId}
								aria-label="Before you can save"
								class="list-disc pl-5 text-xs text-slate-700"
							>
								<For each={evaluation()?.problems ?? []}>{(problem) => <li>{problem}</li>}</For>
							</ul>
						</Show>

						<div class="flex flex-wrap items-center gap-2">
							<button
								type="submit"
								class={BUTTON_PRIMARY}
								disabled={!canSave()}
								aria-describedby={(evaluation()?.problems.length ?? 0) > 0 ? problemsId : undefined}
							>
								{saving() ? "Saving…" : "Save"}
							</button>
							<Show when={savedAt()}>
								{(at) => (
									<span class="flex flex-wrap items-center gap-2">
										<output class="text-xs text-emerald-900">Saved {formatInstant(at())}</output>
										<a
											href="#/chat"
											class="inline-flex min-h-6 items-center text-blue-800 underline"
										>
											Back to chat
										</a>
									</span>
								)}
							</Show>
						</div>

						<Show when={failure()}>
							{(error) => (
								<ErrorNotice failure={error()} title="The agent settings were not saved." />
							)}
						</Show>
					</form>
				)}
			</Show>
		</Section>
	);
}
