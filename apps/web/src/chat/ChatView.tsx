import type { ConversationSummary, WorkspaceSummary } from "@research/contracts";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	DisclosureSummary,
	Empty,
	ErrorNotice,
	Field,
	INPUT,
	Loading,
	Notice,
	RemoteView,
} from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createReadGate } from "../lib/readGate.ts";
import { createRemote, type Remote } from "../lib/remote.ts";
import { createWorkspaceSession } from "../lib/session.ts";
import { Composer } from "./Composer.tsx";
import { Conversation } from "./Conversation.tsx";
import { RecordsDrawer } from "./RecordsDrawer.tsx";

function CreateConversationForm(props: {
	readonly api: ApiClient;
	readonly onCreated: (workspace: WorkspaceSummary) => void;
}): JSX.Element {
	const [title, setTitle] = createSignal("");
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	// The create may still be in flight when the owner leaves Chat: a late
	// response must not pull them back. The conversation appears in the list
	// next time Chat loads.
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (title().trim() === "" || submitting()) return;
		setSubmitting(true);
		setFailure(null);
		const result = await props.api.createWorkspace(title().trim());
		if (disposed) return;
		setSubmitting(false);
		if (result.ok) {
			setTitle("");
			props.onCreated(result.value);
		} else {
			setFailure(result.error);
		}
	};
	return (
		<form aria-label="Create conversation" class="flex flex-wrap items-end gap-2" onSubmit={submit}>
			<Field label="New conversation title">
				{(id) => (
					<input
						id={id}
						type="text"
						class={INPUT}
						maxLength={300}
						value={title()}
						onInput={(event) => setTitle(event.currentTarget.value)}
					/>
				)}
			</Field>
			<button type="submit" class={BUTTON} disabled={title().trim() === "" || submitting()}>
				Start conversation
			</button>
			<Show when={failure()}>
				{(error) => <ErrorNotice failure={error()} title="The conversation was not created." />}
			</Show>
		</form>
	);
}

interface ConversationList {
	readonly state: () => Remote<readonly ConversationSummary[]>;
	readonly value: () => readonly ConversationSummary[] | null;
	readonly reload: () => Promise<void>;
	readonly pollNow: () => void;
}

/**
 * The conversation history, polled conditionally so an unchanged list costs a
 * 304 (architecture section 5.1). Must be created under a Solid owner.
 */
function createConversationList(api: ApiClient, visibility: VisibilitySource): ConversationList {
	const [state, setState] = createSignal<Remote<readonly ConversationSummary[]>>({
		status: "loading",
	});
	const [value, setValue] = createSignal<readonly ConversationSummary[] | null>(null);
	let etag: string | null = null;
	let disposed = false;
	/**
	 * A manual `reload()` bypasses the poller's serialisation, so two list
	 * reads can be in flight at once. Tickets admit responses in send order:
	 * a slow poll that started before the reload must not replace the newer
	 * list (and its ETag) the reload already adopted.
	 */
	const gate = createReadGate();

	const fetchList = async (): Promise<PollSignal> => {
		const ticket = gate.begin();
		const result = await api.listConversations(etag);
		if (disposed) return "unchanged";
		if (!gate.admit(ticket)) return "changed";
		if (!result.ok) {
			if (value() === null) setState({ status: "error", error: result.error });
			return "failed";
		}
		const conditional = result.value;
		if (!conditional.changed) return "unchanged";
		// Data and ETag are adopted together, and only when admitted.
		etag = conditional.etag;
		setValue(() => conditional.value);
		setState({ status: "ready", value: conditional.value });
		return "changed";
	};

	const poller = createPoller({ poll: fetchList, visibility });
	poller.start();
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	return {
		state,
		value,
		reload: async () => {
			await fetchList();
		},
		pollNow: () => poller.pollNow(),
	};
}

function byNewestActivity(a: ConversationSummary, b: ConversationSummary): number {
	const order = b.lastActivityAt.localeCompare(a.lastActivityAt);
	return order !== 0 ? order : a.workspaceId.localeCompare(b.workspaceId);
}

/** One open conversation: slim header, inline thread, pinned input. */
function OpenConversation(props: {
	readonly api: ApiClient;
	readonly workspaceId: string;
	readonly visibility: VisibilitySource;
	readonly title: string | null;
	readonly onActivity: () => void;
}): JSX.Element {
	const session = createWorkspaceSession(props.api, props.workspaceId, props.visibility);
	const agents = createRemote(() => props.api.listAgents());
	// Saved agent choices (backend, model, effort, limits, web access): loaded
	// once per mount, so returning from Settings → AI agent fetches them again.
	const agentSettings = createRemote(() => props.api.getAgentSettings());
	// Which run's records are open is dialog state, kept local (UI-003), along
	// with the control that opened it so focus can return there on close. The
	// opener arrives explicitly with the click (the event's `currentTarget`),
	// never via `document.activeElement`: Safari does not focus a clicked
	// button, so the active element is the wrong control there.
	const [recordsRunId, setRecordsRunId] = createSignal<string | null>(null);
	const [recordsOpener, setRecordsOpener] = createSignal<HTMLElement | null>(null);
	const openRecords = (runId: string, opener: HTMLElement | null) => {
		setRecordsOpener(() => opener);
		setRecordsRunId(runId);
	};
	const closeRecords = () => {
		setRecordsRunId(null);
		setRecordsOpener(() => null);
	};
	const recordsRun = createMemo(() => session.runs().find((run) => run.runId === recordsRunId()));
	const title = createMemo(
		() => props.title ?? session.view()?.workspace.title ?? props.workspaceId,
	);
	// A suggestion chip fills the input without sending; the nonce retriggers the effect.
	const [suggestion, setSuggestion] = createSignal<{
		readonly text: string;
		readonly nonce: number;
	} | null>(null);
	let suggestionNonce = 0;

	return (
		<div class="flex min-w-0 flex-1 flex-col lg:min-h-0">
			<Show when={session.notice()}>
				{(notice) => (
					<div class="mb-2 flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<Show when={notice().failure} fallback={<Notice tone="info">{notice().text}</Notice>}>
								{(failure) => <ErrorNotice failure={failure()} title={notice().text} />}
							</Show>
						</div>
						<button type="button" class={BUTTON} onClick={() => session.dismissNotice()}>
							Dismiss
						</button>
					</div>
				)}
			</Show>
			<Show when={session.loadError()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title="Could not load this conversation."
						onRetry={() => void session.reload()}
					/>
				)}
			</Show>
			<Show when={session.conversationError()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title="Could not load the messages."
						onRetry={() => void session.reload()}
					/>
				)}
			</Show>
			<div class="mx-auto w-full max-w-3xl min-w-0 flex flex-wrap items-baseline gap-2 wrap-anywhere px-1 py-2">
				<h3 class="min-w-0 text-base font-semibold text-slate-900">{title()}</h3>
				<a
					href={`#/canvas/${props.workspaceId}`}
					class="inline-flex min-h-6 items-center text-sm text-blue-800 underline"
				>
					Open canvas
				</a>
			</div>
			<Conversation
				conversation={session.conversation()}
				hasEarlier={session.hasEarlierMessages()}
				loadingEarlier={session.loadingEarlier()}
				earlierError={session.earlierError()}
				onLoadEarlier={() => void session.loadEarlierMessages()}
				runs={session.runs()}
				agents={agents.value()}
				onCancel={session.cancelRun}
				onRetry={session.retryRun}
				onApprove={session.approveRun}
				onOpenRecords={openRecords}
				onSelectSuggestion={(text) => {
					suggestionNonce += 1;
					setSuggestion({ text, nonce: suggestionNonce });
				}}
			/>
			<div class="sticky bottom-0 z-10 mx-auto w-full max-w-3xl shrink-0 bg-slate-100 px-1 pb-2 pt-1 lg:static">
				<Composer
					workspaceId={props.workspaceId}
					agents={agents.state()}
					settings={agentSettings.state()}
					onReloadAgents={() => void agents.reload()}
					onReloadSettings={() => void agentSettings.reload()}
					newIdempotencyKey={props.api.newIdempotencyKey}
					onSubmit={async (request, key) => {
						const result = await session.submitRun(request, key);
						if (result.ok) props.onActivity();
						return result;
					}}
					suggestion={suggestion}
					runs={session.runs()}
				/>
			</div>
			<Show when={recordsRunId()} keyed>
				{(runId) => (
					<RecordsDrawer
						api={props.api}
						runId={runId}
						startedAt={recordsRun()?.createdAt ?? null}
						opener={recordsOpener()}
						onClose={closeRecords}
					/>
				)}
			</Show>
		</div>
	);
}

/**
 * Chat page: the conversation history plus one open conversation. The selected
 * id lives in the URL hash, so reloading reopens the same conversation from
 * server state without rerunning any research (FR-010).
 */
export function ChatView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string | null;
	readonly onSelectConversation: (workspaceId: string) => void;
}): JSX.Element {
	const conversations = createConversationList(props.api, props.visibility);
	const ordered = createMemo(() => [...(conversations.value() ?? [])].sort(byNewestActivity));
	const selectedSummary = createMemo(
		() => ordered().find((entry) => entry.workspaceId === props.workspaceId) ?? null,
	);

	// With no conversation in the URL, open the one with the newest activity (URL sync is external).
	createEffect(() => {
		const list = ordered();
		if (props.workspaceId !== null || list.length === 0) return;
		const latest = list[0];
		if (latest !== undefined) props.onSelectConversation(latest.workspaceId);
	});

	// Below the large breakpoint the page is a normal document and the history
	// is a collapsed disclosure; at `lg` the two-column full-height layout
	// stays and the disclosure is forced open (guideline section 5).
	const mediaQuery = "(min-width: 1024px)";
	const [wide, setWide] = createSignal(
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia(mediaQuery).matches
			: true,
	);
	createEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(mediaQuery);
		const update = () => setWide(query.matches);
		update();
		query.addEventListener("change", update);
		onCleanup(() => query.removeEventListener("change", update));
	});
	const historyOpen = createMemo(() => (ordered().length === 0 || wide() ? true : undefined));

	return (
		<div class="flex flex-1 flex-col gap-3 lg:grid lg:min-h-0 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
			<details
				data-conversations-disclosure="true"
				open={historyOpen()}
				class="group min-w-0 self-start lg:sticky lg:top-0 lg:min-h-0 lg:overflow-y-auto"
			>
				<DisclosureSummary class="text-sm font-medium text-slate-900 lg:hidden">
					Conversations ({ordered().length})
				</DisclosureSummary>
				<nav aria-label="Conversations" class="mt-2 space-y-2 lg:mt-0 lg:block">
					<CreateConversationForm
						api={props.api}
						onCreated={(workspace) => {
							void conversations.reload();
							props.onSelectConversation(workspace.workspaceId);
						}}
					/>
					<RemoteView
						remote={conversations.state()}
						label="conversations"
						onRetry={() => void conversations.reload()}
					>
						{(list) => (
							<Show
								when={list().length > 0}
								fallback={<Empty>No conversations yet. Start one above.</Empty>}
							>
								<ul class="space-y-1">
									<For each={[...list()].sort(byNewestActivity)}>
										{(entry) => (
											<li data-conversation-id={entry.workspaceId}>
												<a
													href={`#/chat/${entry.workspaceId}`}
													aria-current={
														entry.workspaceId === props.workspaceId ? "page" : undefined
													}
													class="block rounded px-2 py-1.5"
													classList={{
														"bg-blue-50": entry.workspaceId === props.workspaceId,
														"hover:bg-slate-100": entry.workspaceId !== props.workspaceId,
													}}
												>
													<span
														class="block truncate text-sm font-semibold text-slate-900"
														title={entry.title}
													>
														{entry.title}
													</span>
													<span
														class="block truncate text-xs text-slate-700"
														title={entry.lastMessagePreview ?? "No messages yet"}
													>
														{entry.lastMessagePreview ?? "No messages yet"}
													</span>
													<span class="block text-2xs text-slate-600">
														<time datetime={entry.lastActivityAt}>
															{formatInstant(entry.lastActivityAt)}
														</time>
														{" · "}
														{entry.messageCount === 1
															? "1 message"
															: `${entry.messageCount} messages`}
													</span>
												</a>
											</li>
										)}
									</For>
								</ul>
							</Show>
						)}
					</RemoteView>
				</nav>
			</details>

			<div class="flex min-w-0 flex-1 flex-col lg:min-h-0">
				<Show
					when={props.workspaceId}
					keyed
					fallback={
						<Show when={conversations.value() !== null && ordered().length === 0}>
							<Empty>
								No conversations yet. Start one to ask a research question. Prior findings stay
								available here even when the local runner is offline.
							</Empty>
						</Show>
					}
				>
					{(workspaceId) => (
						<OpenConversation
							api={props.api}
							workspaceId={workspaceId}
							visibility={props.visibility}
							title={selectedSummary()?.title ?? null}
							onActivity={() => void conversations.reload()}
						/>
					)}
				</Show>
				<Show when={props.workspaceId === null && conversations.value() === null}>
					<Loading label="conversation" />
				</Show>
			</div>
		</div>
	);
}
