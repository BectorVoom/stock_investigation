import {
	type AgentsResponse,
	isLeasedJobState,
	isTerminalJobState,
	type ResearchRun,
} from "@research/contracts";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { ResearchBudget } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { BudgetFields } from "../components/BudgetFields.tsx";
import { BUTTON, BUTTON_DANGER, BUTTON_PRIMARY, ErrorNotice } from "../components/ui.tsx";
import {
	type BudgetDraft,
	budgetDraftFrom,
	type CostModelView,
	costStatement,
	defaultBudgetDraft,
	evaluateBudget,
} from "../settings/agentSettingsModel.ts";

const RETRYABLE_STATES: readonly ResearchRun["state"][] = ["failed", "cancelled", "partial"];

const STATE_CLASSES: { readonly [S in ResearchRun["state"]]?: string } = {
	cancelled: "border-slate-500 bg-slate-100 text-slate-800",
	partial: "border-amber-700 bg-amber-50 text-amber-900",
	waiting_approval: "border-amber-700 bg-amber-50 text-amber-900",
};

/** Owner consent to resume a run that asked for more than its budget allowed. */
export function ApprovalForm(props: {
	readonly run: ResearchRun;
	readonly costModel: CostModelView;
	readonly onApprove: (runId: string, budget: ResearchBudget) => Promise<ApiResult<ResearchRun>>;
}): JSX.Element {
	const [draft, setDraft] = createSignal<BudgetDraft>(
		props.run.request === null ? defaultBudgetDraft() : budgetDraftFrom(props.run.request.budget),
	);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	const evaluation = createMemo(() => evaluateBudget(draft(), props.costModel));

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const budget = evaluation().budget;
		if (budget === null || submitting()) return;
		setSubmitting(true);
		setFailure(null);
		const result = await props.onApprove(props.run.runId, budget);
		setSubmitting(false);
		if (!result.ok) setFailure(result.error);
	};

	return (
		<form
			aria-label={`Approve run ${props.run.runId}`}
			class="mt-2 space-y-2 rounded bg-slate-200 p-2"
			noValidate
			onSubmit={submit}
		>
			<p class="text-xs text-amber-950">
				<span class="font-semibold">Approval requested: </span>
				<span data-approval-reason="true" class="font-mono">
					{props.run.approvalRequest?.reasonCode ?? "reason not stated"}
				</span>
				<Show when={props.run.approvalRequest?.detail}>
					{(detail) => <span> — {detail()}</span>}
				</Show>
			</p>
			<BudgetFields
				legend="Limits you approve for the resumed run"
				draft={draft()}
				onChange={setDraft}
				spendEditable={props.costModel !== "plan-limited"}
				spendConsentRequired={evaluation().spendConsentRequired}
			/>
			<p class="text-xs text-slate-800">{costStatement(props.costModel)}</p>
			<Show when={evaluation().problems.length > 0}>
				<ul class="list-disc pl-5 text-xs text-slate-700">
					<For each={evaluation().problems}>{(problem) => <li>{problem}</li>}</For>
				</ul>
			</Show>
			<button
				type="submit"
				class={BUTTON_PRIMARY}
				disabled={evaluation().budget === null || submitting()}
			>
				Approve and resume
			</button>
			<Show when={failure()}>
				{(error) => <ErrorNotice failure={error()} title="The run was not approved." />}
			</Show>
		</form>
	);
}

/**
 * One research run rendered inline in the thread (CopilotKit-style agent
 * activity): always visible and compact — a state badge (not for completed
 * or failed), latest progress line, working indicator, Stop, state note,
 * failure line, retry and the approval form. WHY no disclosure: run kind, attempt, timings,
 * limits, usage, cost, provenance, verification and the progress log now live
 * in the runner/server logs (`job_finished`), not in the thread.
 */
export function RunCard(props: {
	readonly run: ResearchRun;
	readonly agents: AgentsResponse | null;
	readonly onCancel: (runId: string) => Promise<void>;
	readonly onRetry: (runId: string) => Promise<void>;
	readonly onApprove: (runId: string, budget: ResearchBudget) => Promise<ApiResult<ResearchRun>>;
}): JSX.Element {
	const [busy, setBusy] = createSignal(false);
	const costModel = createMemo((): CostModelView => {
		const agentId = props.run.request?.agentId;
		return props.agents?.agents.find((agent) => agent.agentId === agentId)?.costModel ?? "unknown";
	});
	const act = async (action: (runId: string) => Promise<void>) => {
		if (busy()) return;
		setBusy(true);
		await action(props.run.runId);
		setBusy(false);
	};
	const unfinished = () => !isTerminalJobState(props.run.state);
	const latestProgress = () =>
		props.run.progress.length === 0 ? null : props.run.progress[props.run.progress.length - 1];
	const stateNote = () => {
		if (props.run.cancelRequested && !isTerminalJobState(props.run.state)) {
			return "Cancellation requested — waiting for the runner to stop.";
		}
		if (props.run.state === "pending") return "Queued — waiting for a runner to claim it.";
		if (isLeasedJobState(props.run.state)) return "A runner is working on this.";
		return null;
	};
	// Only failed or partial runs get the alert line; retry is for retryable states.
	// The alert shows even when no code was recorded (never a blank): the
	// code span itself stays present only when a code exists, so tests and
	// logs can key on it.
	const showFailure = () => props.run.state === "failed" || props.run.state === "partial";
	// No badge for the two ordinary endings (owner's decision of 2026-10-12):
	// a completed run is followed by its answer and a failed one by the alert
	// line below, so the word would only repeat them. Every other state keeps
	// its badge. The state stays on `data-run-state` and in the status region.
	const showStateBadge = () => props.run.state !== "completed" && props.run.state !== "failed";

	return (
		<article
			aria-label={`Run ${props.run.runId}`}
			data-run-state={props.run.state}
			class="rounded bg-slate-100 p-2 wrap-anywhere"
		>
			<p class="flex flex-wrap items-center gap-2 text-xs">
				<Show when={showStateBadge()}>
					<span
						data-field="state"
						class={`rounded border px-1.5 py-px font-semibold ${STATE_CLASSES[props.run.state] ?? "border-blue-700 bg-blue-50 text-blue-900"}`}
					>
						{props.run.state}
					</span>
				</Show>
				<Show when={latestProgress()}>
					{(entry) => <span class="min-w-0 flex-1 text-slate-700">{entry().text}</span>}
				</Show>
				<Show when={unfinished()}>
					<span aria-hidden="true" class="inline-flex items-center gap-1">
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-slate-600 motion-safe:animate-pulse" />
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-slate-600 motion-safe:animate-pulse" />
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-slate-600 motion-safe:animate-pulse" />
					</span>
				</Show>
				<Show when={unfinished()}>
					<button
						type="button"
						class={BUTTON_DANGER}
						disabled={busy() || props.run.cancelRequested}
						onClick={() => void act(props.onCancel)}
					>
						Stop
					</button>
				</Show>
			</p>
			<Show when={stateNote()}>
				{(note) => <p class="mt-1 text-xs text-slate-700">{note()}</p>}
			</Show>
			<Show when={showFailure()}>
				<p role="alert" class="mt-1 text-xs text-red-900">
					<span class="font-semibold">
						{props.run.state === "partial" ? "Stopped early: " : "Failure code: "}
					</span>
					<Show when={props.run.failureCode} fallback={<span>reason not stated</span>}>
						{(code) => (
							<span data-field="failure-code" class="font-mono">
								{code()}
							</span>
						)}
					</Show>
					<Show when={props.run.failureDetail}>
						{(detail) => (
							<span>
								{" ("}
								<span data-field="failure-detail" class="font-mono">
									{detail()}
								</span>
								{")"}
							</span>
						)}
					</Show>
				</p>
			</Show>
			<Show when={RETRYABLE_STATES.includes(props.run.state)}>
				<div class="mt-2 flex flex-wrap gap-2">
					<button
						type="button"
						class={BUTTON}
						disabled={busy()}
						onClick={() => void act(props.onRetry)}
					>
						Retry run
					</button>
				</div>
			</Show>
			<Show when={props.run.state === "waiting_approval"}>
				{/* The form's draft signal is created once per mount; Conversation
				    keys cards by stable run-id strings, so a poll that replaces
				    the run object updates text in place instead of recreating
				    the form — an approval draft being typed survives. */}
				<ApprovalForm run={props.run} costModel={costModel()} onApprove={props.onApprove} />
			</Show>
		</article>
	);
}
