import type { ConversationSummary } from "@research/contracts";
import type { UiRegistry } from "@research/ui-registry";
import { createEffect, createMemo, createUniqueId, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import {
	BUTTON,
	Empty,
	ErrorNotice,
	LABEL,
	Loading,
	Notice,
	PANEL,
	RemoteView,
	Select,
} from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createRemote } from "../lib/remote.ts";
import { createWorkspaceSession } from "../lib/session.ts";
import { Canvas } from "./Canvas.tsx";

function byNewestActivity(a: ConversationSummary, b: ConversationSummary): number {
	const order = b.lastActivityAt.localeCompare(a.lastActivityAt);
	return order !== 0 ? order : a.workspaceId.localeCompare(b.workspaceId);
}

/** One open canvas: the stored components of a single conversation. */
function OpenCanvas(props: {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly workspaceId: string;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const session = createWorkspaceSession(props.api, props.workspaceId, props.visibility);
	return (
		<>
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
						title="Could not load this canvas."
						onRetry={() => void session.reload()}
					/>
				)}
			</Show>
			<Show when={session.view()} fallback={<Loading label="canvas" />}>
				{(view) => (
					<Canvas
						view={view()}
						registry={props.registry}
						busy={session.commandPending()}
						onOperation={(operation) => void session.dispatch(operation)}
					/>
				)}
			</Show>
		</>
	);
}

/**
 * Canvas page: which conversation's canvas to show, and that canvas. No
 * question form, no run controls, no message list live here.
 */
export function CanvasView(props: {
	readonly api: ApiClient;
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly workspaceId: string | null;
	readonly onSelectConversation: (workspaceId: string) => void;
}): JSX.Element {
	const conversations = createRemote(async () => {
		const result = await props.api.listConversations(null);
		if (!result.ok) return result;
		if (!result.value.changed)
			return { ok: true as const, value: [] as readonly ConversationSummary[] };
		return { ok: true as const, value: result.value.value };
	});
	const pickerId = createUniqueId();
	const ordered = createMemo(() => [...(conversations.value() ?? [])].sort(byNewestActivity));

	// With no conversation in the URL, open the one with the newest activity (URL sync is external).
	createEffect(() => {
		const list = ordered();
		if (props.workspaceId !== null || list.length === 0) return;
		const latest = list[0];
		if (latest !== undefined) props.onSelectConversation(latest.workspaceId);
	});

	return (
		<div class="space-y-3">
			<section aria-label="Conversation picker" class={PANEL}>
				<RemoteView
					remote={conversations.state()}
					label="conversations"
					onRetry={() => void conversations.reload()}
				>
					{(list) => (
						<div class="flex flex-wrap items-end gap-4">
							<div>
								<label for={pickerId} class={LABEL}>
									Conversation
								</label>
								<Select
									id={pickerId}
									onChange={(event) => {
										if (event.currentTarget.value !== "") {
											props.onSelectConversation(event.currentTarget.value);
										}
									}}
								>
									<option value="" selected={props.workspaceId === null}>
										{list().length === 0 ? "No conversations yet" : "Choose a conversation…"}
									</option>
									<For each={[...list()].sort(byNewestActivity)}>
										{(entry) => (
											<option
												value={entry.workspaceId}
												selected={entry.workspaceId === props.workspaceId}
											>
												{entry.title}
											</option>
										)}
									</For>
								</Select>
							</div>
							<Show when={props.workspaceId !== null}>
								<a
									href={`#/chat/${props.workspaceId ?? ""}`}
									class="text-sm text-blue-800 underline"
								>
									Back to chat
								</a>
							</Show>
						</div>
					)}
				</RemoteView>
			</section>

			<Show
				when={props.workspaceId}
				keyed
				fallback={
					<Show when={conversations.value() !== null && ordered().length === 0}>
						<Empty>
							No conversations yet.{" "}
							<a href="#/chat" class="underline">
								Start one on the Chat page
							</a>
							.
						</Empty>
					</Show>
				}
			>
				{(workspaceId) => (
					<OpenCanvas
						api={props.api}
						registry={props.registry}
						workspaceId={workspaceId}
						visibility={props.visibility}
					/>
				)}
			</Show>
		</div>
	);
}
