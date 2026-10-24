import { type ConversationSummary, DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import { createSignal, onCleanup } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createPoller, type PollSignal } from "../lib/polling.ts";
import { createReadGate } from "../lib/readGate.ts";
import type { Remote } from "../lib/remote.ts";

export interface ConversationList {
	readonly state: () => Remote<readonly ConversationSummary[]>;
	readonly value: () => readonly ConversationSummary[] | null;
	readonly reload: () => Promise<void>;
	readonly pollNow: () => void;
}

/**
 * The conversation history, polled conditionally so an unchanged list costs a
 * 304 (architecture section 5.1). Must be created under a Solid owner.
 */
export function createConversationList(
	api: ApiClient,
	visibility: VisibilitySource,
): ConversationList {
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

export function byNewestActivity(a: ConversationSummary, b: ConversationSummary): number {
	const order = b.lastActivityAt.localeCompare(a.lastActivityAt);
	return order !== 0 ? order : a.workspaceId.localeCompare(b.workspaceId);
}

/**
 * A chat's title as the UI shows it. The server names a new chat
 * `DEFAULT_CONVERSATION_TITLE` and replaces that exact title with the first
 * question, so the stored value stays English; only its display follows the
 * UI language (`newChatTitle`). Any other title was written by the owner or
 * the agent and shows as written.
 */
export function displayedChatTitle(title: string, newChatTitle: string): string {
	return title === DEFAULT_CONVERSATION_TITLE ? newChatTitle : title;
}
