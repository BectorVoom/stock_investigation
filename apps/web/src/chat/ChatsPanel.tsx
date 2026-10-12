import { type ConversationSummary, DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { ApiFailure } from "../api/http.ts";
import {
	ActionMenu,
	BUTTON,
	ConfirmDialog,
	DisclosureSummary,
	Empty,
	ErrorNotice,
	INPUT,
	Loading,
	PANEL,
	PanelHeader,
	RemoteView,
} from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import type { Remote } from "../lib/remote.ts";
import { byNewestActivity, type ConversationList } from "./conversationList.ts";

function PlusIcon(): JSX.Element {
	return (
		<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
			<path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
		</svg>
	);
}

export function RenameInput(props: {
	readonly initial: string;
	readonly onSave: (title: string) => void;
	readonly onCancel: () => void;
}): JSX.Element {
	const [draft, setDraft] = createSignal(props.initial);
	let input: HTMLInputElement | undefined;
	let cancelled = false;
	// Focus and select the current title for quick replacement.
	queueMicrotask(() => {
		input?.focus();
		input?.select();
	});
	const save = (value: string) => {
		if (cancelled) return;
		props.onSave(value);
	};
	return (
		<input
			ref={(element) => {
				input = element;
			}}
			type="text"
			aria-label="Chat title"
			class={INPUT}
			maxLength={300}
			value={draft()}
			onInput={(event) => setDraft(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					save(draft());
				} else if (event.key === "Escape") {
					event.preventDefault();
					cancelled = true;
					props.onCancel();
				}
			}}
			onBlur={() => save(draft())}
		/>
	);
}

/**
 * Left panel: past chats and the New chat button. On narrow screens the same
 * list renders inside the existing disclosure; at `lg` it is a panel card
 * that collapses to a narrow rail.
 */
export function ChatsPanel(props: {
	readonly conversations: ConversationList;
	readonly ordered: () => readonly ConversationSummary[];
	readonly selectedId: string | null;
	readonly onSelect: (workspaceId: string) => void;
	readonly onNewChat: () => void;
	readonly newChatPending: () => boolean;
	readonly newChatError: () => ApiFailure | null;
	readonly collapsed: () => boolean;
	readonly onToggleCollapsed: () => void;
	readonly wide: () => boolean;
	readonly renamingId: () => string | null;
	readonly onStartRename: (workspaceId: string) => void;
	readonly onRename: (workspaceId: string, currentTitle: string, nextTitle: string) => void;
	readonly onCancelRename: () => void;
	readonly onRequestDelete: (
		entry: { readonly workspaceId: string; readonly title: string },
		opener: HTMLElement | null,
	) => void;
	readonly renameError: () => ApiFailure | null;
}): JSX.Element {
	const historyOpen = () => (props.ordered().length === 0 || props.wide() ? true : undefined);

	const listContent = () => (
		<RemoteView
			remote={props.conversations.state()}
			label="conversations"
			onRetry={() => void props.conversations.reload()}
		>
			{(list) => (
				<Show when={list().length > 0} fallback={<Empty>No chats yet. Start one above.</Empty>}>
					<ul class="space-y-1">
						<For each={[...list()].sort(byNewestActivity)}>
							{(entry) => (
								<ChatRowWrapper
									entry={entry}
									selected={entry.workspaceId === props.selectedId}
									renaming={props.renamingId() === entry.workspaceId}
									onOpen={() => props.onSelect(entry.workspaceId)}
									onStartRename={() => props.onStartRename(entry.workspaceId)}
									onRename={(next) => props.onRename(entry.workspaceId, entry.title, next)}
									onCancelRename={props.onCancelRename}
									onRequestDelete={props.onRequestDelete}
								/>
							)}
						</For>
					</ul>
				</Show>
			)}
		</RemoteView>
	);

	const newChatButton = () => (
		<button
			type="button"
			class={`${BUTTON} inline-flex items-center gap-1`}
			disabled={props.newChatPending()}
			onClick={() => props.onNewChat()}
		>
			<PlusIcon /> New chat
		</button>
	);

	return (
		<Show
			when={props.wide()}
			fallback={
				/* Narrow layout: the history stays the disclosure it is today. */
				<details
					data-conversations-disclosure="true"
					open={historyOpen()}
					class="group min-w-0 self-start lg:hidden"
				>
					<DisclosureSummary class="text-sm font-medium text-slate-900">
						Chats ({props.ordered().length})
					</DisclosureSummary>
					<nav aria-label="Chats" class="mt-2 space-y-2">
						{newChatButton()}
						<Show when={props.newChatPending()}>
							<Loading label="new chat" />
						</Show>
						<Show when={props.newChatError()}>
							{(error) => <ErrorNotice failure={error()} title="The chat was not created." />}
						</Show>
						<Show when={props.renameError()}>
							{(error) => <ErrorNotice failure={error()} title="The chat was not renamed." />}
						</Show>
						{listContent()}
					</nav>
				</details>
			}
		>
			{/* Wide layout: panel card or collapsed rail. */}
			<Show
				when={!props.collapsed()}
				fallback={
					<div class={`${PANEL} hidden flex-col items-center gap-2 lg:flex`}>
						<button
							type="button"
							class={BUTTON}
							aria-expanded={false}
							aria-label="Expand Chats panel"
							onClick={() => props.onToggleCollapsed()}
						>
							Expand
						</button>
					</div>
				}
			>
				<section aria-label="Chats" class={`${PANEL} hidden min-h-0 flex-col lg:flex`}>
					<PanelHeader
						title="Chats"
						count={`(${props.ordered().length})`}
						expanded={true}
						collapseLabel="Collapse Chats panel"
						expandLabel="Expand Chats panel"
						onToggle={props.onToggleCollapsed}
					/>
					<nav aria-label="Chats" class="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">
						{newChatButton()}
						<Show when={props.newChatPending()}>
							<Loading label="new chat" />
						</Show>
						<Show when={props.newChatError()}>
							{(error) => <ErrorNotice failure={error()} title="The chat was not created." />}
						</Show>
						<Show when={props.renameError()}>
							{(error) => <ErrorNotice failure={error()} title="The chat was not renamed." />}
						</Show>
						{listContent()}
					</nav>
				</section>
			</Show>
		</Show>
	);
}

function ChatRowWrapper(props: {
	readonly entry: ConversationSummary;
	readonly selected: boolean;
	readonly renaming: boolean;
	readonly onOpen: () => void;
	readonly onStartRename: () => void;
	readonly onRename: (next: string) => void;
	readonly onCancelRename: () => void;
	readonly onRequestDelete: (
		entry: { readonly workspaceId: string; readonly title: string },
		opener: HTMLElement | null,
	) => void;
}): JSX.Element {
	return (
		<li data-conversation-id={props.entry.workspaceId} class="min-w-0">
			<div
				class="flex items-start gap-1 rounded px-1 py-1"
				classList={{ "bg-blue-50": props.selected }}
			>
				<div class="min-w-0 flex-1">
					<Show
						when={!props.renaming}
						fallback={
							<RenameInput
								initial={props.entry.title}
								onSave={(next) => props.onRename(next)}
								onCancel={props.onCancelRename}
							/>
						}
					>
						<a
							href={`#/chat/${props.entry.workspaceId}`}
							aria-current={props.selected ? "page" : undefined}
							class="block rounded px-1 py-0.5"
							classList={{ "hover:bg-slate-100": !props.selected }}
						>
							<span
								class="block truncate text-sm font-semibold text-slate-900"
								title={props.entry.title}
							>
								{props.entry.title}
							</span>
							<span
								class="block truncate text-xs text-slate-700"
								title={props.entry.lastMessagePreview ?? "No messages yet"}
							>
								{props.entry.lastMessagePreview ?? "No messages yet"}
							</span>
							<span class="block text-2xs text-slate-600">
								<time datetime={props.entry.lastActivityAt}>
									{formatInstant(props.entry.lastActivityAt)}
								</time>
								{" · "}
								{props.entry.messageCount === 1
									? "1 message"
									: `${props.entry.messageCount} messages`}
							</span>
						</a>
					</Show>
				</div>
				<Show when={!props.renaming}>
					<ActionMenu
						buttonLabel={`More actions for ${props.entry.title}`}
						menuLabel={`Actions for ${props.entry.title}`}
						items={[
							{
								label: "Rename",
								onSelect: () => props.onStartRename(),
							},
							{
								label: "Delete",
								onSelect: () => {
									const active =
										document.activeElement instanceof HTMLElement ? document.activeElement : null;
									props.onRequestDelete(
										{
											workspaceId: props.entry.workspaceId,
											title: props.entry.title,
										},
										active,
									);
								},
							},
						]}
					/>
				</Show>
			</div>
		</li>
	);
}

export function DeleteChatDialog(props: {
	readonly target: { readonly workspaceId: string; readonly title: string };
	readonly opener: () => HTMLElement | null;
	readonly pending: () => boolean;
	readonly failure: () => ApiFailure | null;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}): JSX.Element {
	return (
		<ConfirmDialog
			title={`Delete “${props.target.title}”?`}
			opener={props.opener()}
			confirmLabel="Delete"
			pending={props.pending()}
			failure={props.failure()}
			onConfirm={props.onConfirm}
			onCancel={props.onCancel}
		>
			<p>This removes its messages, canvas and research records. This cannot be undone.</p>
		</ConfirmDialog>
	);
}

export { DEFAULT_CONVERSATION_TITLE };
export type { ConversationSummary, Remote };
