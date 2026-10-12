import type {
	AgentSettingsResponse,
	AgentsResponse,
	ResearchRequest,
	ResearchRun,
} from "@research/contracts";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onMount,
	Show,
} from "solid-js";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { DisclosureSummary, ErrorNotice, Loading, Notice, Select } from "../components/ui.tsx";
import { formatUsd } from "../lib/format.ts";
import type { Remote } from "../lib/remote.ts";
import { runnerNotice } from "../settings/agentSettingsModel.ts";
import { fitTextarea, supportsFieldSizing } from "./autogrow.ts";
import { type ComposerDraft, defaultComposerDraft, evaluateComposer } from "./composerModel.ts";

const HORIZONS = [3, 4, 5] as const;

/** Configuration problems show immediately; question problems wait for input. WHY: the owner cannot fix what they have not typed yet, but a missing backend blocks everything. */
function isConfigurationProblem(problem: string): boolean {
	return problem.includes("Settings → AI agent") || problem.includes("still loading");
}

/**
 * Question form. The draft holds only what belongs to one question (UI-003);
 * backend, model, effort, budget and web access are read from the saved agent
 * settings. The form shows a read-only backend/model/effort/web-access
 * summary; limits and the cost statement live in Settings → AI agent (owner
 * decision 2026-10-12). Submitting creates a research run, and the
 * stored question then arrives back through the conversation like any other
 * server state.
 */
export function Composer(props: {
	readonly workspaceId: string;
	readonly agents: Remote<AgentsResponse>;
	readonly settings: Remote<AgentSettingsResponse>;
	readonly onReloadAgents: () => void;
	readonly onReloadSettings: () => void;
	readonly newIdempotencyKey: () => string;
	readonly onSubmit: (
		request: ResearchRequest,
		idempotencyKey: string,
	) => Promise<ApiResult<ResearchRun>>;
	readonly suggestion?: () => { readonly text: string; readonly nonce: number } | null;
	/** All runs the session holds, so the queued note can follow the run it belongs to (finding 12). */
	readonly runs?: readonly ResearchRun[];
}): JSX.Element {
	const [draft, setDraft] = createSignal<ComposerDraft>(defaultComposerDraft());
	const [submitting, setSubmitting] = createSignal(false);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [queuedNote, setQueuedNote] = createSignal<string | null>(null);
	/** The run the queued note belongs to; the note clears when it leaves `pending`. */
	const [queuedRunId, setQueuedRunId] = createSignal<string | null>(null);
	const [typed, setTyped] = createSignal(false);
	const [tried, setTried] = createSignal(false);
	/** Reused when the identical request is re-sent, so a retry cannot create a second run. */
	let pendingKey: { readonly fingerprint: string; readonly key: string } | null = null;
	let form: HTMLFormElement | undefined;
	let questionBox: HTMLTextAreaElement | undefined;

	const agents = createMemo(() => (props.agents.status === "ready" ? props.agents.value : null));
	const settings = createMemo(() =>
		props.settings.status === "ready" ? props.settings.value.settings : null,
	);
	// Carried-over settings work exactly like saved ones; the note says where
	// they came from and where to review them.
	const carriedOver = createMemo(
		() => props.settings.status === "ready" && props.settings.value.origin === "carried-over",
	);
	const evaluation = createMemo(() =>
		evaluateComposer(draft(), agents(), settings(), props.workspaceId),
	);
	const offlineNotice = createMemo(() => runnerNotice(agents()));
	const patch = (change: Partial<ComposerDraft>) =>
		setDraft((current) => ({ ...current, ...change }));

	const questionId = createUniqueId();
	const horizonId = createUniqueId();
	const consentId = createUniqueId();
	const problemsId = createUniqueId();

	// A suggestion chip fills the input and focuses it; it never sends (sending spends quota).
	createEffect(() => {
		const instruction = props.suggestion?.() ?? null;
		if (instruction === null) return;
		patch({ question: instruction.text });
		setTyped(true);
		questionBox?.focus();
	});

	// Script growth for engines without CSS `field-sizing: content` (see
	// `autogrow.ts`): the effect tracks the draft so input, suggestion fills
	// and the post-send clear all refit after Solid updates the DOM. Engines
	// with the CSS path skip this entirely.
	let needsScriptGrow = false;
	let fittedText: string | null = null;
	onMount(() => {
		needsScriptGrow = !supportsFieldSizing();
		if (needsScriptGrow && questionBox !== undefined) {
			fittedText = draft().question;
			fitTextarea(questionBox);
		}
	});
	createEffect(() => {
		const text = draft().question;
		const box = questionBox;
		if (!needsScriptGrow || box === undefined || text === fittedText) return;
		fittedText = text;
		fitTextarea(box);
	});

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		setTried(true);
		if (submitting()) return;
		// The live request, or — when consent was already consumed by a
		// dispatched attempt — the identical resend of that attempt. An
		// IDENTICAL resend (same captured request, same idempotency key) is
		// the same authorised action and needs no fresh consent; any change
		// to the request requires consent again (AGT-012).
		let request = evaluation().request;
		let identicalResend = false;
		if (request === null && pendingKey !== null) {
			const candidate = evaluateComposer(
				{ ...draft(), spendConsent: true },
				agents(),
				settings(),
				props.workspaceId,
			).request;
			if (candidate !== null && JSON.stringify(candidate) === pendingKey.fingerprint) {
				request = candidate;
				identicalResend = true;
			}
		}
		if (request === null) return;
		const fingerprint = JSON.stringify(request);
		if (pendingKey === null || pendingKey.fingerprint !== fingerprint) {
			pendingKey = { fingerprint, key: props.newIdempotencyKey() };
		}
		const key = pendingKey.key;
		// Consent is consumed when the request is dispatched, not when it
		// succeeds: a timed-out request may still have been accepted by the
		// server, so a DIFFERENT request must not reuse the earlier consent.
		if (!identicalResend) {
			setDraft((current) => ({ ...current, spendConsent: false }));
		}
		setSubmitting(true);
		setFailure(null);
		setQueuedNote(null);
		setQueuedRunId(null);
		const result = await props.onSubmit(request, key);
		setSubmitting(false);
		if (result.ok) {
			pendingKey = null;
			if (result.value.state === "pending") {
				setQueuedRunId(result.value.runId);
				setQueuedNote("Question queued. It starts when a runner claims it.");
			} else {
				setQueuedNote(`Question submitted (run is ${result.value.state}).`);
			}
			// A successful send resets the "the owner has started typing"
			// state, so the cleared form is quiet again until the owner types
			// or tries to send.
			setTyped(false);
			setTried(false);
			// The one-time consent is withdrawn. The question is cleared only if
			// it is still the one that was sent: text typed while the request was
			// in flight is the owner's next draft and must survive.
			setDraft((current) => ({
				...current,
				question: current.question.trim() === request.question ? "" : current.question,
				spendConsent: false,
			}));
		} else {
			// The fingerprint and key are kept: the identical resend reuses
			// the same key (no second run), while consent stays consumed.
			setFailure(result.error);
		}
	};

	const summary = () => {
		const selected = evaluation().selectedAgent;
		const stored = settings();
		if (selected === null || stored === null) return null;
		return {
			backend: `${selected.displayName} (${selected.status})`,
			model: evaluation().model ?? "backend default",
			effort: stored.effort,
			webAccess: stored.webAccess === "public-web" ? "on" : "off",
		};
	};
	const summaryLine = () => {
		const current = summary();
		if (current === null) return null;
		return `${current.backend} · ${current.model} · ${current.effort} · web access ${current.webAccess}`;
	};
	const consentLabel = () => {
		// Spend consent is required only when the settings carry a positive
		// metered allowance, so the amount below is always set in practice;
		// the fallback keeps the label honest if the budget is missing.
		const max = evaluation().budget?.maxSpendUsd ?? null;
		if (max === null) return "I consent to metered spend for this question";
		return `I consent to metered spend up to ${formatUsd(max)} for this question`;
	};
	const optionsSummary = () => {
		const markets = (["JP", "US"] as const).filter((market) => draft().markets[market]);
		const marketText = markets.length === 0 ? "no markets" : markets.join(", ");
		return `${draft().horizonYears} years · ${marketText}`;
	};
	const visibleProblems = createMemo(() => {
		const interacted = typed() || tried();
		return evaluation().problems.filter((problem) => isConfigurationProblem(problem) || interacted);
	});
	// Configuration problems block everything, so they are announced directly
	// above the input with a way to fix them; per-question problems stay in
	// the list under the input.
	const configProblems = createMemo(() =>
		evaluation().problems.filter((problem) => isConfigurationProblem(problem)),
	);
	// The queued note describes the run it belongs to (finding 12): as soon as
	// that run leaves `pending` the note disappears — the run's current state
	// is announced through the conversation status region instead.
	createEffect(() => {
		const tracked = queuedRunId();
		if (tracked === null) return;
		const current = props.runs?.find((run) => run.runId === tracked);
		if (current !== undefined && current.state !== "pending") {
			setQueuedRunId(null);
			setQueuedNote(null);
		}
	});

	const canSend = () => {
		if (submitting()) return false;
		if (evaluation().request !== null) return true;
		// The identical resend of a dispatched request stays enabled without
		// fresh consent; anything else needs a valid request.
		if (pendingKey === null) return false;
		const candidate = evaluateComposer(
			{ ...draft(), spendConsent: true },
			agents(),
			settings(),
			props.workspaceId,
		).request;
		return candidate !== null && JSON.stringify(candidate) === pendingKey.fingerprint;
	};
	const sendLabel = () => (submitting() ? "Sending…" : "Send question");

	// noValidate: the rules in composerModel are the single source of validation and messages.
	return (
		<form
			ref={(element) => {
				form = element;
			}}
			aria-label="Research composer"
			class="space-y-1 bg-white"
			noValidate
			onSubmit={submit}
		>
			<Show when={configProblems().length > 0}>
				<Notice tone="warning">
					<For each={configProblems()}>
						{(problem) => <span class="block wrap-anywhere">{problem}</span>}
					</For>
					<a
						href="#/settings/agent"
						class="inline-flex min-h-6 items-center text-blue-800 underline"
					>
						Open Settings → AI agent
					</a>
				</Notice>
			</Show>
			<div class="flex items-end gap-2 rounded-2xl bg-slate-100 p-2 focus-within:ring-2 focus-within:ring-blue-700">
				<label for={questionId} class="sr-only">
					Question
				</label>
				<textarea
					ref={(element) => {
						questionBox = element;
					}}
					id={questionId}
					class="max-h-48 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm text-slate-900 field-sizing-content focus:outline-none"
					rows="1"
					maxLength={2000}
					placeholder="Ask a research question…"
					value={draft().question}
					onInput={(event) => {
						setTyped(true);
						patch({ question: event.currentTarget.value });
					}}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						const composing = event.isComposing || event.keyCode === 229;
						if (composing) return;
						event.preventDefault();
						form?.requestSubmit();
					}}
				/>
				<button
					type="submit"
					aria-label={sendLabel()}
					aria-describedby={visibleProblems().length > 0 ? problemsId : undefined}
					disabled={!canSend()}
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed"
					classList={{
						"bg-blue-700 text-white hover:bg-blue-800": canSend(),
						"bg-slate-300 text-slate-600": !canSend(),
					}}
				>
					<Show
						when={!submitting()}
						fallback={
							<svg
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 14 14"
								fill="none"
								class="motion-safe:animate-spin"
							>
								<circle
									cx="7"
									cy="7"
									r="5.5"
									stroke="currentColor"
									stroke-width="2"
									opacity="0.3"
								/>
								<path d="M12.5 7A5.5 5.5 0 0 0 7 1.5" stroke="currentColor" stroke-width="2" />
							</svg>
						}
					>
						<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
							<path
								d="M7 12.5V1.5M7 1.5 2.5 6M7 1.5l4.5 4.5"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</Show>
				</button>
			</div>

			<div class="space-y-1 text-xs">
				<Show when={offlineNotice()}>
					{(text) => (
						<Notice tone="warning" data-runner-offline="true">
							{text()}
						</Notice>
					)}
				</Show>

				<Show when={props.settings.status === "loading"}>
					<Loading label="agent settings" />
				</Show>
				<Show when={props.settings.status === "error" ? props.settings.error : null}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title="Could not load agent settings."
							onRetry={props.onReloadSettings}
						/>
					)}
				</Show>
				<Show when={props.agents.status === "loading"}>
					<Loading label="agent backends" />
				</Show>
				<Show when={props.agents.status === "error" ? props.agents.error : null}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title="Could not load agent backends."
							onRetry={props.onReloadAgents}
						/>
					)}
				</Show>

				<Show when={summaryLine()}>
					{(line) => (
						<p class="break-words text-xs text-slate-700">
							{line()}{" "}
							<a href="#/settings/agent" class="text-blue-800 underline">
								Change in Settings → AI agent
							</a>
						</p>
					)}
				</Show>
				<Show when={carriedOver() && summaryLine() !== null}>
					<p class="break-words text-xs text-slate-700">
						Using the backend of your last question —{" "}
						<a href="#/settings/agent" class="text-blue-800 underline">
							review in Settings → AI agent
						</a>
					</p>
				</Show>

				<details class="group break-words text-xs text-slate-700">
					<DisclosureSummary>Options: {optionsSummary()}</DisclosureSummary>
					<div class="max-h-32 overflow-y-auto">
						<div class="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
							<div>
								<label for={horizonId} class="block text-xs font-medium text-slate-700">
									Horizon
								</label>
								<Select
									id={horizonId}
									onChange={(event) => {
										const horizonYears = HORIZONS.find(
											(candidate) => String(candidate) === event.currentTarget.value,
										);
										if (horizonYears !== undefined) patch({ horizonYears });
									}}
								>
									<For each={HORIZONS}>
										{(years) => (
											<option value={String(years)} selected={draft().horizonYears === years}>
												{years} years
											</option>
										)}
									</For>
								</Select>
							</div>
						</div>
						<fieldset class="mt-1 flex flex-wrap gap-4 text-xs text-slate-900">
							<legend class="block text-xs font-medium text-slate-700">Markets</legend>
							<label class="flex items-center gap-1">
								<input
									type="checkbox"
									checked={draft().markets.JP}
									onChange={(event) =>
										patch({ markets: { ...draft().markets, JP: event.currentTarget.checked } })
									}
								/>
								Japan (JP)
							</label>
							<label class="flex items-center gap-1">
								<input
									type="checkbox"
									checked={draft().markets.US}
									onChange={(event) =>
										patch({ markets: { ...draft().markets, US: event.currentTarget.checked } })
									}
								/>
								United States (US)
							</label>
						</fieldset>
					</div>
				</details>

				<Show when={evaluation().spendConsentRequired}>
					<div>
						<label for={consentId} class="flex items-start gap-2 text-xs text-slate-900">
							<input
								id={consentId}
								type="checkbox"
								class="mt-0.5"
								checked={draft().spendConsent}
								onChange={(event) => patch({ spendConsent: event.currentTarget.checked })}
							/>
							<span>{consentLabel()}</span>
						</label>
					</div>
				</Show>

				<Show when={visibleProblems().length > 0}>
					<ul
						id={problemsId}
						aria-label="Before you can submit"
						class="list-disc pl-5 text-xs text-slate-700"
					>
						<For each={visibleProblems()}>{(problem) => <li>{problem}</li>}</For>
					</ul>
				</Show>

				<Show when={queuedNote()}>
					{(note) => <output class="block text-xs text-emerald-900">{note()}</output>}
				</Show>
				<Show when={failure()}>
					{(error) => <ErrorNotice failure={error()} title="The question was not submitted." />}
				</Show>
			</div>
		</form>
	);
}
