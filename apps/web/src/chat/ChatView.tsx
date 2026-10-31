import { DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import type { UiRegistry } from "@research/ui-registry";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { CHAT_PANEL, ErrorNotice, Loading } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createWorkspaceMode } from "../notebook/workspaceMode.ts";
import { ChatsPanel, DeleteChatDialog, NewChatButton } from "./ChatsPanel.tsx";
import { chatMessages } from "./chat.messages.ts";
import { focusComposerBox } from "./composerFocus.ts";
import { byNewestActivity, createConversationList } from "./conversationList.ts";
import { OpenWorkspace } from "./OpenWorkspace.tsx";

/**
 * Chat page: past chats plus one open conversation in exactly two states —
 * Chat-first or Notebook-first (ADR-0020). Chat, Notebook, the workspace
 * session, the notebook session, the thread, the composer draft and the
 * selection live above the layout; switching states changes only the grid
 * proportions, so nothing is re-created. The selected id lives in the URL
 * hash, so reloading reopens the same conversation from server state without
 * rerunning any research (FR-010).
 */
export function ChatView(props: {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string | null;
	/** Null opens the page with no conversation selected (the welcome). */
	readonly onSelectConversation: (workspaceId: string | null) => void;
}): JSX.Element {
	const m = useMessages(chatMessages);
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

	// Tailwind's `lg` is 64rem: in rem, so `wide()` flips exactly where the
	// CSS breakpoint does, whatever the browser's default font size.
	const mediaQuery = "(min-width: 64rem)";
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

	const [chatsCollapsed, setChatsCollapsed] = createSignal(false);
	// The secondary panel (the Notebook in Chat-first, Chat in Notebook-first)
	// collapses to a rail; the dominant panel always stays.
	const [secondaryCollapsed, setSecondaryCollapsed] = createSignal(false);
	// The two states, remembered per conversation (a conversation never seen
	// opens Chat-first). Below `lg` the states keep their meaning as the
	// two-tab switcher, so the selected tab IS the mode.
	const [mode, setMode] = createWorkspaceMode(() => props.workspaceId);

	const [newChatPending, setNewChatPending] = createSignal(false);
	const [newChatError, setNewChatError] = createSignal<ApiFailure | null>(null);
	const [renamingId, setRenamingId] = createSignal<string | null>(null);
	const [renameError, setRenameError] = createSignal<ApiFailure | null>(null);
	const [deleteTarget, setDeleteTarget] = createSignal<{
		readonly workspaceId: string;
		readonly title: string;
	} | null>(null);
	const [deleteOpener, setDeleteOpener] = createSignal<HTMLElement | null>(null);
	const [deletePending, setDeletePending] = createSignal(false);
	const [deleteError, setDeleteError] = createSignal<ApiFailure | null>(null);
	const [focusNonce, setFocusNonce] = createSignal(0);

	// The create may still be in flight when the owner leaves Chat: a late
	// response must not pull them back. The conversation appears in the list
	// next time Chat loads.
	let disposed = false;
	let createSeq = 0;
	onCleanup(() => {
		disposed = true;
	});

	const focusComposer = (workspaceId: string) => {
		setFocusNonce((nonce) => nonce + 1);
		// Fallback for engines where the effect runs before mount: retry once.
		// It never steals focus the owner has since taken (a rename input
		// saves on blur and would close), and only when the open conversation
		// still matches: the timeout may fire after they navigated elsewhere.
		setTimeout(() => {
			if (props.workspaceId === workspaceId) focusComposerBox();
		}, 100);
	};

	const handleNewChat = async () => {
		// Reuse an empty "New chat" instead of creating another one.
		const reusable = ordered().find(
			(entry) => entry.title === DEFAULT_CONVERSATION_TITLE && entry.messageCount === 0,
		);
		if (reusable !== undefined) {
			props.onSelectConversation(reusable.workspaceId);
			focusComposer(reusable.workspaceId);
			return;
		}
		if (newChatPending()) return;
		setNewChatPending(true);
		setNewChatError(null);
		createSeq += 1;
		const seq = createSeq;
		const result = await props.api.createWorkspace();
		if (disposed || seq !== createSeq) return;
		setNewChatPending(false);
		if (result.ok) {
			void conversations.reload();
			props.onSelectConversation(result.value.workspaceId);
			focusComposer(result.value.workspaceId);
		} else {
			setNewChatError(result.error);
		}
	};

	const handleRename = async (workspaceId: string, currentTitle: string, nextRaw: string) => {
		const next = nextRaw.trim();
		// An empty or unchanged title sends no request.
		if (next === "" || next === currentTitle) {
			setRenamingId(null);
			return;
		}
		const result = await props.api.renameWorkspace(workspaceId, next);
		if (disposed) return;
		if (result.ok) {
			setRenamingId(null);
			setRenameError(null);
			await conversations.reload();
		} else {
			// The old title stays: the list is not reloaded on failure.
			setRenameError(result.error);
			setRenamingId(null);
		}
	};

	const handleRequestDelete = (
		entry: { readonly workspaceId: string; readonly title: string },
		opener: HTMLElement | null,
	) => {
		setDeleteTarget(entry);
		setDeleteOpener(() => opener);
		setDeleteError(null);
		setDeletePending(false);
	};

	const handleConfirmDelete = async () => {
		const target = deleteTarget();
		if (target === null || deletePending()) return;
		setDeletePending(true);
		setDeleteError(null);
		const result = await props.api.deleteWorkspace(target.workspaceId);
		if (disposed) return;
		if (!result.ok) {
			// A 409 (a question is still running) shows the server's message
			// in the dialog and deletes nothing: the dialog stays open.
			setDeleteError(result.error);
			setDeletePending(false);
			return;
		}
		setDeletePending(false);
		setDeleteTarget(null);
		const wasOpen = props.workspaceId === target.workspaceId;
		await conversations.reload();
		if (disposed) return;
		if (wasOpen) {
			const remaining = [...(conversations.value() ?? [])].sort(byNewestActivity);
			// No chats remain: a null selection shows the welcome.
			props.onSelectConversation(remaining[0]?.workspaceId ?? null);
		}
		// Return focus to the opener (the More actions button).
		deleteOpener()?.focus();
	};

	const handleCancelDelete = () => {
		setDeleteTarget(null);
		setDeleteError(null);
		setDeletePending(false);
		deleteOpener()?.focus();
	};

	// One grid whose column template changes with the state: Chat-first is
	// Chat ≈ 75–80 % / Notebook ≈ 20–25 % of the space right of the Chats
	// panel (`3fr`/`1fr`), Notebook-first the reverse. Every template is a
	// complete literal: Tailwind generates grid rules from the class names it
	// finds in source, so an interpolated template would style nothing. The
	// transition is disabled under `prefers-reduced-motion`.
	const gridColumns = () => {
		if (mode() === "chat") {
			if (chatsCollapsed() && secondaryCollapsed()) return "lg:grid-cols-[3rem_minmax(0,3fr)_3rem]";
			if (chatsCollapsed()) return "lg:grid-cols-[3rem_minmax(0,3fr)_minmax(0,1fr)]";
			if (secondaryCollapsed()) return "lg:grid-cols-[minmax(14rem,18rem)_minmax(0,3fr)_3rem]";
			return "lg:grid-cols-[minmax(14rem,18rem)_minmax(0,3fr)_minmax(0,1fr)]";
		}
		if (chatsCollapsed() && secondaryCollapsed()) return "lg:grid-cols-[3rem_3rem_minmax(0,3fr)]";
		if (chatsCollapsed()) return "lg:grid-cols-[3rem_minmax(0,1fr)_minmax(0,3fr)]";
		if (secondaryCollapsed()) return "lg:grid-cols-[minmax(14rem,18rem)_3rem_minmax(0,3fr)]";
		return "lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(0,3fr)]";
	};

	const onMobileTabKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
		event.preventDefault();
		setMode(mode() === "chat" ? "notebook" : "chat");
		// Move focus to the newly selected tab.
		queueMicrotask(() => {
			const next = mode() === "chat" ? "chat-tab-mobile" : "notebook-tab-mobile";
			document.getElementById(next)?.focus();
		});
	};

	const welcome = () => (
		<section
			aria-label={m().chat}
			data-panel="chat"
			class={`${CHAT_PANEL} flex min-w-0 flex-1 flex-col items-center justify-center text-center`}
		>
			<h3 class="text-base font-semibold text-slate-900">{m().welcome}</h3>
			<p class="mt-1 max-w-md text-sm text-slate-600">{m().welcomeHint}</p>
			<div class="mt-2 w-full max-w-xs">
				<NewChatButton
					variant="pill"
					disabled={newChatPending()}
					onClick={() => void handleNewChat()}
				/>
			</div>
			<Show when={newChatPending()}>
				<Loading label={m().newChatLoading} />
			</Show>
			<Show when={newChatError()}>
				{(error) => (
					<div class="mt-1">
						<ErrorNotice failure={error()} title={m().chatNotCreated} />
					</div>
				)}
			</Show>
		</section>
	);

	return (
		// `OpenWorkspace` is keyed by workspace id OUTSIDE the narrow/wide branch, so
		// crossing the `lg` breakpoint swaps the layout without recreating the sessions
		// (no duplicated polling, no loading flash). Only the layout branches; the
		// two states only change the grid template and tab selection below `lg`.
		<div
			class={`flex min-w-0 flex-1 flex-col gap-3 lg:grid lg:min-h-0 lg:transition-[grid-template-columns] lg:duration-150 lg:motion-reduce:transition-none ${gridColumns()}`}
		>
			<ChatsPanel
				conversations={conversations}
				ordered={ordered}
				selectedId={props.workspaceId}
				onSelect={props.onSelectConversation}
				onNewChat={() => void handleNewChat()}
				newChatPending={newChatPending}
				newChatError={newChatError}
				collapsed={chatsCollapsed}
				onToggleCollapsed={() => setChatsCollapsed((current) => !current)}
				wide={wide}
				renamingId={renamingId}
				onStartRename={(id) => {
					setRenameError(null);
					setRenamingId(id);
				}}
				onRename={(id, current, next) => void handleRename(id, current, next)}
				onCancelRename={() => setRenamingId(null)}
				onRequestDelete={handleRequestDelete}
				renameError={renameError}
			/>
			<Show when={!wide() && props.workspaceId !== null && ordered().length > 0}>
				<div role="tablist" aria-label={m().chatOrNotebook} onKeyDown={onMobileTabKeyDown}>
					<div class="flex gap-1 lg:hidden">
						<button
							id="chat-tab-mobile"
							type="button"
							role="tab"
							aria-selected={mode() === "chat"}
							aria-controls="chat-panel-mobile"
							class="rounded px-2 py-1 text-sm font-medium"
							classList={{
								"bg-blue-700 text-white": mode() === "chat",
								"text-slate-800 hover:bg-slate-200": mode() !== "chat",
							}}
							onClick={() => setMode("chat")}
						>
							{m().chat}
						</button>
						<button
							id="notebook-tab-mobile"
							type="button"
							role="tab"
							aria-selected={mode() === "notebook"}
							aria-controls="notebook-panel-mobile"
							class="rounded px-2 py-1 text-sm font-medium"
							classList={{
								"bg-blue-700 text-white": mode() === "notebook",
								"text-slate-800 hover:bg-slate-200": mode() !== "notebook",
							}}
							onClick={() => setMode("notebook")}
						>
							{m().notebook}
						</button>
					</div>
				</div>
			</Show>
			<Show
				when={props.workspaceId}
				keyed
				fallback={
					<Show when={conversations.value() !== null && ordered().length === 0}>{welcome()}</Show>
				}
			>
				{(workspaceId) => (
					<OpenWorkspace
						api={props.api}
						registry={props.registry}
						visibility={props.visibility}
						workspaceId={workspaceId}
						listTitle={selectedSummary()?.title ?? null}
						onActivity={() => void conversations.reload()}
						focusNonce={focusNonce()}
						mode={mode()}
						onModeChange={setMode}
						wide={wide}
						secondaryCollapsed={secondaryCollapsed}
						onToggleSecondary={() => setSecondaryCollapsed((current) => !current)}
					/>
				)}
			</Show>
			<Show when={props.workspaceId === null && conversations.value() === null}>
				<Loading label={m().conversation} />
			</Show>

			<Show when={deleteTarget()} keyed>
				{(target) => (
					<DeleteChatDialog
						target={target}
						opener={deleteOpener}
						pending={deletePending}
						failure={deleteError}
						onConfirm={() => void handleConfirmDelete()}
						onCancel={handleCancelDelete}
					/>
				)}
			</Show>
		</div>
	);
}
