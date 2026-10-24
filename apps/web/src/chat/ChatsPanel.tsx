import { type ConversationSummary, DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { ApiFailure } from "../api/http.ts";
import {
	ActionMenu,
	BUTTON,
	BUTTON_PILL,
	CHAT_PANEL,
	ConfirmDialog,
	DisclosureSummary,
	Empty,
	ErrorNotice,
	INPUT,
	Loading,
	PanelCollapseButton,
	PanelHeader,
	RemoteView,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import type { Remote } from "../lib/remote.ts";
import { chatMessages } from "./chat.messages.ts";
import { byNewestActivity, type ConversationList, displayedChatTitle } from "./conversationList.ts";

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
	const m = useMessages(chatMessages);
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
			aria-label={m().chatTitle}
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
 * The one "New chat" button (guideline section 6). The expanded Chats panel
 * shows the full-width pill; the collapsed rail (icon only) and the
 * narrow-screen disclosure (compact) keep their small forms through this same
 * part, so the create-at-once behaviour, the pending state and the focus
 * cannot drift between copies.
 */
export function NewChatButton(props: {
	readonly variant: "pill" | "compact" | "icon";
	readonly disabled: boolean;
	readonly onClick: () => void;
}): JSX.Element {
	const m = useMessages(chatMessages);
	if (props.variant === "icon") {
		// 24 px square: the collapsed rail holds 24 px of content width.
		return (
			<button
				type="button"
				class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-slate-900 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
				aria-label={m().newChat}
				title={m().newChat}
				disabled={props.disabled}
				onClick={() => props.onClick()}
			>
				<PlusIcon />
			</button>
		);
	}
	return (
		<button
			type="button"
			class={props.variant === "pill" ? BUTTON_PILL : `${BUTTON} inline-flex items-center gap-1`}
			disabled={props.disabled}
			onClick={() => props.onClick()}
		>
			<PlusIcon /> {m().newChat}
		</button>
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
	const m = useMessages(chatMessages);
	const historyOpen = () => (props.ordered().length === 0 || props.wide() ? true : undefined);

	const listContent = () => (
		<RemoteView
			remote={props.conversations.state()}
			label={m().conversations}
			onRetry={() => void props.conversations.reload()}
		>
			{(list) => (
				<Show when={list().length > 0} fallback={<Empty>{m().noChats}</Empty>}>
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

	const newChatPill = () => (
		<NewChatButton
			variant="pill"
			disabled={props.newChatPending()}
			onClick={() => props.onNewChat()}
		/>
	);

	const newChatCompact = () => (
		<NewChatButton
			variant="compact"
			disabled={props.newChatPending()}
			onClick={() => props.onNewChat()}
		/>
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
						{m().chatsCount(props.ordered().length)}
					</DisclosureSummary>
					<nav aria-label={m().chats} class="mt-2 space-y-2">
						{newChatCompact()}
						<Show when={props.newChatPending()}>
							<Loading label={m().newChatLoading} />
						</Show>
						<Show when={props.newChatError()}>
							{(error) => <ErrorNotice failure={error()} title={m().chatNotCreated} />}
						</Show>
						<Show when={props.renameError()}>
							{(error) => <ErrorNotice failure={error()} title={m().chatNotRenamed} />}
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
					<div class={`${CHAT_PANEL} hidden flex-col items-center gap-2 lg:flex`}>
						<NewChatButton
							variant="icon"
							disabled={props.newChatPending()}
							onClick={() => props.onNewChat()}
						/>
						<PanelCollapseButton
							label={m().expandChats}
							expanded={false}
							onToggle={props.onToggleCollapsed}
							side="left"
						/>
					</div>
				}
			>
				<section aria-label={m().chats} class={`${CHAT_PANEL} hidden min-h-0 flex-col lg:flex`}>
					<PanelHeader
						title={m().chats}
						count={`(${props.ordered().length})`}
						expanded={true}
						collapseLabel={m().collapseChats}
						expandLabel={m().expandChats}
						onToggle={props.onToggleCollapsed}
						side="left"
					/>
					<nav aria-label={m().chats} class="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">
						{newChatPill()}
						<Show when={props.newChatPending()}>
							<Loading label={m().newChatLoading} />
						</Show>
						<Show when={props.newChatError()}>
							{(error) => <ErrorNotice failure={error()} title={m().chatNotCreated} />}
						</Show>
						<Show when={props.renameError()}>
							{(error) => <ErrorNotice failure={error()} title={m().chatNotRenamed} />}
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
	const m = useMessages(chatMessages);
	const common = useMessages(commonMessages);
	// Saving the shown default title unchanged keeps the stored one (no rename).
	const title = () => displayedChatTitle(props.entry.title, m().newChat);
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
								initial={title()}
								onSave={(next) =>
									props.onRename(next.trim() === title() ? props.entry.title : next)
								}
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
							<span class="block truncate text-sm font-semibold text-slate-900" title={title()}>
								{title()}
							</span>
						</a>
					</Show>
				</div>
				<Show when={!props.renaming}>
					<ActionMenu
						buttonLabel={m().moreActionsFor(title())}
						menuLabel={m().actionsFor(title())}
						items={[
							{
								label: common().rename,
								onSelect: () => props.onStartRename(),
							},
							{
								label: common().delete,
								onSelect: () => {
									const active =
										document.activeElement instanceof HTMLElement ? document.activeElement : null;
									props.onRequestDelete(
										{
											workspaceId: props.entry.workspaceId,
											title: title(),
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
	const m = useMessages(chatMessages);
	const common = useMessages(commonMessages);
	return (
		<ConfirmDialog
			title={m().deleteChat(props.target.title)}
			opener={props.opener()}
			confirmLabel={common().delete}
			pending={props.pending()}
			failure={props.failure()}
			onConfirm={props.onConfirm}
			onCancel={props.onCancel}
		>
			<p>{m().deleteChatBody}</p>
		</ConfirmDialog>
	);
}

export { DEFAULT_CONVERSATION_TITLE };
export type { ConversationSummary, Remote };
