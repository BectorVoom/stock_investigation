import type {
	AgentsResponse,
	Claim,
	Conversation as ConversationData,
	Evidence,
	ResearchRun,
} from "@research/contracts";
import { isTerminalJobState } from "@research/contracts";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ResearchBudget } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { BUTTON, ErrorNotice, Loading } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { AnswerClaims } from "./Citations.tsx";
import { RunCard } from "./RunCard.tsx";
import { SUGGESTIONS } from "./suggestions.ts";

type Message = ConversationData["messages"][number];
/** Minimal clipboard surface, injectable so tests can replace it. */
type ClipboardLike = Pick<Clipboard, "writeText">;

function defaultClipboard(): ClipboardLike | null {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
			return navigator.clipboard;
		}
	} catch {
		// No clipboard available (e.g. insecure context): the button reports failure.
	}
	return null;
}

const MAX_LISTED_RUNS = 5;

function CopyButton(props: {
	readonly text: string;
	readonly clipboard?: ClipboardLike | null;
}): JSX.Element {
	const [status, setStatus] = createSignal<"idle" | "copied" | "failed">("idle");
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
	const label = () =>
		status() === "copied" ? "Copied" : status() === "failed" ? "Copy failed" : "Copy answer";
	const copy = async () => {
		const target = props.clipboard === undefined ? defaultClipboard() : props.clipboard;
		if (target === null || target === undefined) {
			setStatus("failed");
		} else {
			try {
				await target.writeText(props.text);
				setStatus("copied");
			} catch {
				setStatus("failed");
			}
		}
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => setStatus("idle"), 2000);
	};
	return (
		<button
			type="button"
			aria-label={label()}
			onClick={() => void copy()}
			class="inline-flex min-h-6 items-center gap-1 rounded px-1 py-0.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900"
		>
			<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
				<rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" />
				<path
					d="M8.5 3.5v-2a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2"
					stroke="currentColor"
				/>
			</svg>
			<span>{label()}</span>
		</button>
	);
}

function OwnerMessage(props: { readonly message: Message }): JSX.Element {
	return (
		<div class="flex justify-end">
			<div class="min-w-0 max-w-[80%]">
				<div class="rounded-2xl bg-blue-700 px-3 py-2 text-sm text-white">
					{/* Plain text only: agent output is data, never markup (UI-005). */}
					<p class="whitespace-pre-wrap wrap-anywhere">{props.message.text}</p>
				</div>
				<p class="mt-0.5 text-right text-2xs text-slate-600">
					<time datetime={props.message.createdAt}>{formatInstant(props.message.createdAt)}</time>
				</p>
			</div>
		</div>
	);
}

function AssistantMessage(props: {
	readonly message: Message;
	readonly claims: ReadonlyMap<string, Claim>;
	readonly evidence: ReadonlyMap<string, Evidence>;
	readonly clipboard?: ClipboardLike | null;
	readonly onOpenRecords: (runId: string, opener: HTMLElement | null) => void;
}): JSX.Element {
	return (
		<div>
			<p class="text-2xs text-slate-600">
				<span class="font-semibold">Assistant</span>
				{" · "}
				<time datetime={props.message.createdAt}>{formatInstant(props.message.createdAt)}</time>
			</p>
			{/* Plain text only: agent output is data, never markup (UI-005). */}
			<p class="mt-0.5 whitespace-pre-wrap wrap-anywhere text-sm text-slate-900">
				{props.message.text}
			</p>
			<Show when={props.message.claimIds.length > 0}>
				<AnswerClaims
					claimIds={props.message.claimIds}
					claims={props.claims}
					evidence={props.evidence}
				/>
			</Show>
			<p class="mt-1 flex flex-wrap gap-2">
				<CopyButton text={props.message.text} clipboard={props.clipboard} />
				<Show when={props.message.runId}>
					{(runId) => (
						<button
							type="button"
							onClick={(event) => props.onOpenRecords(runId(), event.currentTarget)}
							class="inline-flex min-h-6 items-center rounded px-1 py-0.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900"
						>
							Evidence
						</button>
					)}
				</Show>
			</p>
		</div>
	);
}

function isAtBottom(element: HTMLOListElement): boolean {
	return element.scrollHeight - element.scrollTop - element.clientHeight < 32;
}

/** Concise spoken form of a run's state for the conversation status region (finding 9). */
function describeRunAnnouncement(run: ResearchRun): string {
	switch (run.state) {
		case "pending":
			return "Question queued. Waiting for a runner to claim it.";
		case "claimed":
			return "A runner claimed the question.";
		case "planning":
			return "Planning the research…";
		case "collecting":
			return "Collecting evidence…";
		case "analyzing":
			return "Analyzing the evidence…";
		case "verifying":
			return "Verifying the findings…";
		case "publishing":
			return "Publishing the answer…";
		case "completed":
			return "Completed: answer added.";
		case "failed":
			return `Failed: ${run.failureCode ?? "reason not stated"}.`;
		case "cancelled":
			return "Cancelled.";
		case "partial":
			return "Stopped early with partial results.";
		case "waiting_approval":
			return "Waiting for approval.";
	}
}

/**
 * The message thread: the main element of the Chat page. It takes the
 * available height and keeps the newest message in view only while the owner
 * was already at the bottom, so reading older messages is never interrupted.
 * WHY one list: run activity sits in reading order, directly after its
 * question, instead of in a separate panel.
 */
export function Conversation(props: {
	readonly conversation: ConversationData | null;
	readonly hasEarlier?: boolean;
	readonly loadingEarlier?: boolean;
	/** The last "load earlier" failure; shown with a retry while messages stay visible. */
	readonly earlierError?: ApiFailure | null;
	readonly onLoadEarlier?: () => void;
	readonly runs?: readonly ResearchRun[];
	readonly agents?: AgentsResponse | null;
	readonly onCancel?: (runId: string) => Promise<void>;
	readonly onRetry?: (runId: string) => Promise<void>;
	readonly onApprove?: (runId: string, budget: ResearchBudget) => Promise<ApiResult<ResearchRun>>;
	readonly onOpenRecords?: (runId: string, opener: HTMLElement | null) => void;
	readonly onSelectSuggestion?: (text: string) => void;
	readonly clipboard?: ClipboardLike | null;
}): JSX.Element {
	const messages = createMemo(() =>
		[...(props.conversation?.messages ?? [])].sort((a, b) => a.seq - b.seq),
	);
	const claims = createMemo(
		() =>
			new Map((props.conversation?.claims ?? []).map((claim) => [claim.claimId, claim] as const)),
	);
	const evidence = createMemo(
		() =>
			new Map((props.conversation?.evidence ?? []).map((item) => [item.evidenceId, item] as const)),
	);
	const runs = createMemo(() => props.runs ?? []);
	const listedRuns = createMemo(() => {
		const all = runs();
		const unfinished = all.filter((run) => !isTerminalJobState(run.state));
		const finished = all.filter((run) => isTerminalJobState(run.state));
		return [...unfinished, ...finished.slice(0, Math.max(0, MAX_LISTED_RUNS - unfinished.length))];
	});
	// Reactive lookups behind stable id lists (finding 3): the `<For>` loops
	// below key by `messageId`/`runId` (plain strings, so equal ids keep their
	// DOM), while the current snapshot flows through these memos. A poll that
	// replaces every snapshot object therefore updates text in place instead
	// of recreating cards — open details and approval drafts survive.
	const messageById = createMemo(
		() => new Map(messages().map((message) => [message.messageId, message] as const)),
	);
	const messageIds = createMemo(() => messages().map((message) => message.messageId));
	const runById = createMemo(() => new Map(listedRuns().map((run) => [run.runId, run] as const)));
	const retriesByTarget = createMemo(() => {
		const grouped = new Map<string, ResearchRun[]>();
		for (const run of listedRuns()) {
			if (run.retryOfRunId === null) continue;
			const existing = grouped.get(run.retryOfRunId);
			if (existing === undefined) grouped.set(run.retryOfRunId, [run]);
			else existing.push(run);
		}
		for (const group of grouped.values()) {
			group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		}
		return grouped;
	});
	// Only owner messages decide that a run has an inline place (finding 4):
	// an assistant message carrying a run id never does.
	const ownerRunIds = createMemo(() => {
		const ids = new Set<string>();
		for (const message of messages()) {
			if (message.role === "owner" && message.runId !== null) ids.add(message.runId);
		}
		return ids;
	});
	/** Inline run ids for one owner message: the run itself plus its retries in place. */
	const inlineRunIds = (ownerRunId: string): readonly string[] => {
		const placed: string[] = [];
		const seen = new Set<string>();
		const visit = (runId: string): void => {
			if (seen.has(runId)) return;
			seen.add(runId);
			if (runById().has(runId)) placed.push(runId);
			for (const retry of retriesByTarget().get(runId) ?? []) visit(retry.runId);
		};
		visit(ownerRunId);
		return placed;
	};
	const placedInlineIds = createMemo(() => {
		const ids = new Set<string>();
		for (const ownerRunId of ownerRunIds()) {
			for (const runId of inlineRunIds(ownerRunId)) ids.add(runId);
		}
		return ids;
	});
	const earlierRunIds = createMemo(() =>
		listedRuns()
			.map((run) => run.runId)
			.filter((runId) => !placedInlineIds().has(runId)),
	);
	let list: HTMLOListElement | undefined;
	const [stickToBottom, setStickToBottom] = createSignal(true);

	// ONE persistent polite status region for the conversation (finding 9): it
	// announces concise state changes of the newest unfinished run — not the
	// whole card, not every progress line — and stays silent when a poll
	// changes nothing. The key carries run, state and failure code, so equal
	// polls never rewrite the region (no re-announcement).
	const newestActiveRun = createMemo((): ResearchRun | null => {
		const all = listedRuns();
		if (all.length === 0) return null;
		const unfinished = all.filter((run) => !isTerminalJobState(run.state));
		const pool = unfinished.length > 0 ? unfinished : all;
		let newest = pool[0];
		for (const run of pool) {
			const current = newest;
			if (current !== undefined && run.createdAt.localeCompare(current.createdAt) > 0) {
				newest = run;
			}
		}
		return newest ?? null;
	});
	const [liveAnnouncement, setLiveAnnouncement] = createSignal("");
	let lastAnnouncedKey: string | null = null;
	createEffect(() => {
		const run = newestActiveRun();
		if (run === null) return;
		const key = `${run.runId}:${run.state}:${run.failureCode ?? ""}`;
		if (key !== lastAnnouncedKey) {
			lastAnnouncedKey = key;
			setLiveAnnouncement(describeRunAnnouncement(run));
		}
	});

	// Scroll position lives outside Solid: sync it here (UI-002).
	createEffect(() => {
		const count = messages().length + listedRuns().length;
		const element = list;
		if (count === 0 || element === undefined) return;
		if (stickToBottom()) element.scrollTop = element.scrollHeight;
	});

	const openRecords = (runId: string, opener: HTMLElement | null) =>
		props.onOpenRecords?.(runId, opener);
	const noopCancel = async (_runId: string): Promise<void> => {};
	const noopRetry = async (_runId: string): Promise<void> => {};
	const noopApprove = async (
		_runId: string,
		_budget: ResearchBudget,
	): Promise<ApiResult<ResearchRun>> => ({
		ok: false,
		error: {
			kind: "api",
			code: "INTERNAL",
			status: 500,
			message: "unavailable",
			detail: null,
			issues: [],
		} satisfies ApiFailure,
	});

	function RunListItem(item: { readonly runId: string }): JSX.Element {
		const run = createMemo(() => runById().get(item.runId));
		return (
			<Show when={run()} fallback={null}>
				{(current) => (
					<li aria-label="Run status">
						<RunCard
							run={current()}
							agents={props.agents ?? null}
							onCancel={props.onCancel ?? noopCancel}
							onRetry={props.onRetry ?? noopRetry}
							onApprove={props.onApprove ?? noopApprove}
						/>
					</li>
				)}
			</Show>
		);
	}

	return (
		<section aria-label="Conversation" class="flex flex-1 flex-col lg:min-h-0">
			<output data-run-status="true" class="sr-only">
				{liveAnnouncement()}
			</output>
			<Show when={props.hasEarlier === true || earlierRunIds().length > 0}>
				<div class="mx-auto w-full max-w-3xl">
					<Show when={props.hasEarlier === true}>
						<div class="mt-1">
							<button
								type="button"
								class={BUTTON}
								disabled={props.loadingEarlier === true}
								onClick={() => props.onLoadEarlier?.()}
							>
								{props.loadingEarlier === true
									? "Loading earlier messages…"
									: "Load earlier messages"}
							</button>
							<Show when={props.earlierError}>
								{(error) => (
									<div class="mt-1">
										<ErrorNotice
											failure={error()}
											title="Could not load earlier messages."
											onRetry={() => props.onLoadEarlier?.()}
										/>
									</div>
								)}
							</Show>
						</div>
					</Show>
					<Show when={earlierRunIds().length > 0}>
						<section aria-label="Earlier runs" class="mt-2">
							<h4 class="text-xs font-semibold text-slate-700">Earlier runs</h4>
							<ul class="mt-1 space-y-2">
								<For each={earlierRunIds()}>{(runId) => <RunListItem runId={runId} />}</For>
							</ul>
						</section>
					</Show>
				</div>
			</Show>
			<Show when={props.conversation !== null} fallback={<Loading label="conversation" />}>
				<Show
					when={messages().length > 0}
					fallback={
						<div class="mx-auto w-full max-w-3xl flex-1 content-center px-4 py-8 text-center">
							<h3 class="text-base font-semibold text-slate-900">
								What would you like to research?
							</h3>
							<p class="mt-1 text-sm text-slate-600">
								Ask about demand growth, suppliers or pricing power — answers arrive with their
								sources.
							</p>
							<ul aria-label="Suggestions" class="mt-3 flex flex-wrap justify-center gap-2">
								<For each={SUGGESTIONS}>
									{(suggestion) => (
										<li>
											<button
												type="button"
												class="rounded-2xl border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-800 hover:bg-slate-50"
												onClick={() => props.onSelectSuggestion?.(suggestion)}
											>
												{suggestion}
											</button>
										</li>
									)}
								</For>
							</ul>
						</div>
					}
				>
					<ol
						ref={(element) => {
							list = element;
						}}
						aria-label="Messages"
						class="mx-auto w-full max-w-3xl space-y-4 wrap-anywhere px-1 py-2 pb-56 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pb-2"
						onScroll={(event) => setStickToBottom(isAtBottom(event.currentTarget))}
					>
						<For each={messageIds()}>
							{(messageId) => {
								const message = createMemo(() => messageById().get(messageId));
								const inlineIds = createMemo(() => {
									const current = message();
									if (current === undefined || current.role !== "owner" || current.runId === null) {
										return [] as const;
									}
									return inlineRunIds(current.runId);
								});
								return (
									<Show when={message()} fallback={null}>
										{(current) => (
											<>
												<li>
													<article
														aria-label={
															current().role === "owner" ? "Your message" : "Assistant message"
														}
														data-role={current().role}
													>
														<Show
															when={current().role === "owner"}
															fallback={
																<AssistantMessage
																	message={current()}
																	claims={claims()}
																	evidence={evidence()}
																	clipboard={props.clipboard}
																	onOpenRecords={openRecords}
																/>
															}
														>
															<OwnerMessage message={current()} />
														</Show>
													</article>
												</li>
												<Show when={inlineIds().length > 0}>
													<For each={inlineIds()}>{(runId) => <RunListItem runId={runId} />}</For>
												</Show>
											</>
										)}
									</Show>
								);
							}}
						</For>
					</ol>
				</Show>
			</Show>
		</section>
	);
}
