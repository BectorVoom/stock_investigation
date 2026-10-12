import {
	type AgentsResponse,
	isLeasedJobState,
	isTerminalJobState,
	type ResearchRun,
} from "@research/contracts";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { ResearchBudget } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { BudgetFields } from "../components/BudgetFields.tsx";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	DisclosureSummary,
	ErrorNotice,
} from "../components/ui.tsx";
import {
	describeCost,
	formatInstant,
	formatInteger,
	formatMinutes,
	formatUsd,
} from "../lib/format.ts";
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
	completed: "border-emerald-700 bg-emerald-50 text-emerald-900",
	failed: "border-red-700 bg-red-50 text-red-900",
	cancelled: "border-slate-500 bg-slate-100 text-slate-800",
	partial: "border-amber-700 bg-amber-50 text-amber-900",
	waiting_approval: "border-amber-700 bg-amber-50 text-amber-900",
};

function describeLimits(budget: ResearchBudget): readonly (readonly [string, string])[] {
	return [
		["Max agent steps", formatInteger(budget.maxAgentSteps)],
		["Max tool calls", formatInteger(budget.maxToolCalls)],
		["Max wall-clock time", formatMinutes(budget.maxWallClockMs)],
		["Max input", `${formatInteger(budget.maxInputBytes)} bytes`],
		["Max spend", budget.maxSpendUsd === null ? "none authorized" : formatUsd(budget.maxSpendUsd)],
	];
}

/**
 * What produced a published result, for reproducibility (AGT-010): backend and
 * model, prompt version, tool versions and the data cut-off, on one line.
 */
function describeProvenance(provenance: NonNullable<ResearchRun["provenance"]>): string {
	const backend =
		provenance.providerModel === null
			? provenance.agentId
			: `${provenance.agentId} (${provenance.providerModel})`;
	const tools = Object.entries(provenance.toolVersions)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([toolId, version]) => `${toolId} ${version}`);
	return [
		backend,
		`prompt version ${provenance.promptVersion}`,
		tools.length === 0 ? "no tool versions recorded" : `tools: ${tools.join(", ")}`,
		`data cut-off ${formatInstant(provenance.dataCutoffAt)}`,
	].join(" · ");
}

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
			class="mt-2 space-y-2 rounded border border-amber-300 bg-amber-50 p-2"
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
 * activity): a compact collapsed line plus a "Run details" disclosure with
 * everything the former status panel showed. WHY a card here: the owner must
 * see agent state where the question was asked, not in a separate panel.
 */
export function RunCard(props: {
	readonly run: ResearchRun;
	readonly agents: AgentsResponse | null;
	readonly onCancel: (runId: string) => Promise<void>;
	readonly onRetry: (runId: string) => Promise<void>;
	readonly onApprove: (runId: string, budget: ResearchBudget) => Promise<ApiResult<ResearchRun>>;
	readonly onOpenRecords: (runId: string, opener: HTMLElement | null) => void;
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
	// The owner must act on these, so their details start expanded.
	const expandedByDefault = () =>
		props.run.state === "waiting_approval" || props.run.state === "failed";
	// Disclosure state lives outside the snapshot (finding 3): a poll that
	// replaces the run object must not close details the owner opened, nor
	// erase an approval draft. The card opens on its own when it newly needs
	// action, but it never closes itself.
	const [detailsOpen, setDetailsOpen] = createSignal(expandedByDefault());
	// A run that newly needs action opens on its own; nothing here closes.
	createEffect(() => {
		if (expandedByDefault()) setDetailsOpen(true);
	});

	return (
		<article
			aria-label={`Run ${props.run.runId}`}
			data-run-state={props.run.state}
			class="rounded border border-slate-200 bg-white p-2 wrap-anywhere"
		>
			<p class="flex flex-wrap items-center gap-2 text-xs">
				<span
					data-field="state"
					class={`rounded border px-1.5 py-px font-semibold ${STATE_CLASSES[props.run.state] ?? "border-blue-700 bg-blue-50 text-blue-900"}`}
				>
					{props.run.state}
				</span>
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
			<details
				class="group mt-1 text-xs"
				open={detailsOpen()}
				onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
			>
				<DisclosureSummary class="text-slate-700">Run details</DisclosureSummary>
				<div class="mt-1 space-y-1">
					<p>
						<span>{props.run.kind === "research" ? "Research" : "News refresh"}</span>
						{" · "}
						<span data-field="attempt">
							Attempt {props.run.attempt} of {props.run.maxAttempts}
						</span>
						{" · "}
						<span class="text-slate-600">started {formatInstant(props.run.createdAt)}</span>
					</p>
					<Show when={props.run.request}>
						{(request) => (
							<p class="text-xs text-slate-800">
								<span class="font-semibold">{request().agentId}</span>
								<Show when={props.run.providerModel}>{(model) => <span> ({model()})</span>}</Show>
								{": "}
								{request().question}
							</p>
						)}
					</Show>
					<Show when={props.run.failureCode}>
						{(code) => (
							<p role="alert" class="mt-1 text-xs text-red-900">
								<span class="font-semibold">
									{props.run.state === "partial" ? "Stopped early: " : "Failure code: "}
								</span>
								<span data-field="failure-code" class="font-mono">
									{code()}
								</span>
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
						)}
					</Show>
					<Show when={props.run.verificationStatus}>
						{(status) => (
							<p class="mt-1 text-xs text-slate-800">
								<span class="font-semibold">Verification: </span>
								{status()}
							</p>
						)}
					</Show>
					<Show when={props.run.provenance}>
						{(provenance) => (
							<p data-field="provenance" class="mt-1 text-xs text-slate-800">
								<span class="font-semibold">Produced by: </span>
								{describeProvenance(provenance())}
							</p>
						)}
					</Show>
					<div class="mt-1 grid grid-cols-2 gap-2 text-xs">
						<Show when={props.run.request}>
							{(request) => (
								<dl aria-label="Limits in force">
									<dt class="font-semibold text-slate-700">Limits in force</dt>
									<For each={describeLimits(request().budget)}>
										{([label, value]) => (
											<dd>
												{label}: {value}
											</dd>
										)}
									</For>
								</dl>
							)}
						</Show>
						<dl aria-label="Usage so far">
							<dt class="font-semibold text-slate-700">Usage so far</dt>
							<dd>Agent steps: {formatInteger(props.run.usage.agentSteps)}</dd>
							<dd>Tool calls: {formatInteger(props.run.usage.toolCalls)}</dd>
							<dd>Input: {formatInteger(props.run.usage.inputBytes)} bytes</dd>
							<dd data-field="cost">Cost: {describeCost(props.run.cost)}</dd>
						</dl>
					</div>
					<details class="group mt-1 text-xs">
						<DisclosureSummary class="text-slate-700">
							Progress log ({props.run.progress.length})
						</DisclosureSummary>
						<Show
							when={props.run.progress.length > 0}
							fallback={<p class="text-slate-600">No progress reported yet.</p>}
						>
							<ol aria-label="Progress log" class="mt-1 space-y-0.5">
								<For each={props.run.progress}>
									{(entry) => (
										<li>
											<time datetime={entry.at} class="text-slate-600">
												{formatInstant(entry.at)}
											</time>{" "}
											<span class="font-mono text-2xs">[{entry.kind}]</span> {entry.text}
										</li>
									)}
								</For>
							</ol>
						</Show>
					</details>
					<div class="mt-2 flex flex-wrap gap-2">
						<Show when={RETRYABLE_STATES.includes(props.run.state)}>
							<button
								type="button"
								class={BUTTON}
								disabled={busy()}
								onClick={() => void act(props.onRetry)}
							>
								Retry run
							</button>
						</Show>
						<Show when={props.run.kind === "research"}>
							<button
								type="button"
								class={BUTTON}
								onClick={(event) => props.onOpenRecords(props.run.runId, event.currentTarget)}
							>
								Evidence
							</button>
						</Show>
					</div>
					<Show when={props.run.state === "waiting_approval"}>
						<ApprovalForm run={props.run} costModel={costModel()} onApprove={props.onApprove} />
					</Show>
				</div>
			</details>
		</article>
	);
}
