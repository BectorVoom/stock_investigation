import {
	type Conversation,
	isLeasedJobState,
	type ResearchRequest,
	type ResearchRun,
	type WorkspaceView,
} from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ApiClient, ResearchBudget } from "../api/client.ts";
import type { ApiFailure, ApiResult } from "../api/http.ts";
import { buildCommand, type UiOperation } from "../canvas/commands.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "./polling.ts";
import { createReadGate } from "./readGate.ts";
import type { sessionMessages } from "./session.messages.ts";

/** The words of the session's notices, in the UI language. */
export type SessionText = MessagesOf<typeof sessionMessages>;

export interface SessionNotice {
	readonly tone: "info" | "error";
	readonly text: string;
	readonly failure: ApiFailure | null;
}

export interface WorkspaceSession {
	/** Server-accepted workspace view; the only source of truth for the canvas (UI-009). */
	readonly view: Accessor<WorkspaceView | null>;
	readonly conversation: Accessor<Conversation | null>;
	readonly runs: Accessor<readonly ResearchRun[]>;
	/** True while the server holds messages older than those already loaded. */
	readonly hasEarlierMessages: Accessor<boolean>;
	/** Set while an earlier page is being fetched. */
	readonly loadingEarlier: Accessor<boolean>;
	/** The last "load earlier messages" failure, if any; cleared on the next attempt. */
	readonly earlierError: Accessor<ApiFailure | null>;
	/** The last conversation-refresh failure, if any; cleared on the next success. */
	readonly conversationError: Accessor<ApiFailure | null>;
	/** Set while the workspace itself cannot be loaded. */
	readonly loadError: Accessor<ApiFailure | null>;
	readonly notice: Accessor<SessionNotice | null>;
	readonly commandPending: Accessor<boolean>;
	readonly dismissNotice: () => void;
	readonly reload: () => Promise<void>;
	/** Loads the next earlier page and merges it; no-op when none remains. */
	readonly loadEarlierMessages: () => Promise<void>;
	/** Sends one owner UI operation and renders the state the server returns. */
	readonly dispatch: (operation: UiOperation) => Promise<void>;
	readonly submitRun: (
		request: ResearchRequest,
		idempotencyKey: string,
	) => Promise<ApiResult<ResearchRun>>;
	readonly cancelRun: (runId: string) => Promise<void>;
	readonly retryRun: (runId: string) => Promise<void>;
	readonly approveRun: (runId: string, budget: ResearchBudget) => Promise<ApiResult<ResearchRun>>;
}

function byNewestFirst(a: ResearchRun, b: ResearchRun): number {
	return b.createdAt.localeCompare(a.createdAt);
}

/**
 * At most this many earlier pages are fetched to close a history gap per
 * refresh. If the held window is still not met, the older held window is
 * dropped with `hasEarlier` kept true, so the owner can page back — a history
 * with a silent hole is never presented.
 */
const MAX_GAP_FILL_PAGES = 3;

function minSeq(messages: readonly Conversation["messages"][number][]): number | null {
	let minimum: number | null = null;
	for (const message of messages) {
		if (minimum === null || message.seq < minimum) minimum = message.seq;
	}
	return minimum;
}

function maxSeq(messages: readonly Conversation["messages"][number][]): number | null {
	let maximum: number | null = null;
	for (const message of messages) {
		if (maximum === null || message.seq > maximum) maximum = message.seq;
	}
	return maximum;
}

/**
 * True when two conversation windows meet: they share a message, or their seq
 * ranges overlap or touch, so their union has no hole. Either side is
 * internally contiguous (pages are served newest-first slices), so a shared
 * message or adjacent ranges are enough.
 */
function windowsMeet(a: Conversation, b: Conversation): boolean {
	const ids = new Set(a.messages.map((message) => message.messageId));
	if (b.messages.some((message) => ids.has(message.messageId))) return true;
	const aMin = minSeq(a.messages);
	const aMax = maxSeq(a.messages);
	const bMin = minSeq(b.messages);
	const bMax = maxSeq(b.messages);
	if (aMin === null || aMax === null || bMin === null || bMax === null) return true;
	return bMin <= aMax + 1 && aMin <= bMax + 1;
}

/** True when `candidate` is a strictly older snapshot of the run than `existing`. */
function isOlderSnapshot(candidate: ResearchRun, existing: ResearchRun): boolean {
	const candidateAt = Date.parse(candidate.updatedAt);
	const existingAt = Date.parse(existing.updatedAt);
	return Number.isFinite(candidateAt) && Number.isFinite(existingAt) && candidateAt < existingAt;
}

function runsFingerprint(runs: readonly ResearchRun[]): string {
	return runs.map((run) => `${run.runId}:${run.state}:${run.updatedAt}`).join("|");
}

/**
 * Merges a freshly fetched conversation page into what is held. Messages are
 * de-duplicated by `messageId` and sorted by `seq`; claims and evidence are
 * merged by id. The periodic refresh fetches only the newest page, so merging
 * (rather than replacing) keeps earlier pages that were already loaded.
 */
function mergeConversation(
	current: Conversation | null,
	incoming: Conversation,
	preserveHasEarlier: boolean,
	currentHasEarlier: boolean,
): Conversation {
	if (current === null) return incoming;
	const messagesById = new Map(
		[...current.messages, ...incoming.messages].map((message) => [message.messageId, message]),
	);
	const messages = [...messagesById.values()].sort((a, b) => a.seq - b.seq);
	const claimsById = new Map(
		[...current.claims, ...incoming.claims].map((claim) => [claim.claimId, claim]),
	);
	const evidenceById = new Map(
		[...current.evidence, ...incoming.evidence].map((item) => [item.evidenceId, item]),
	);
	return {
		messages,
		claims: [...claimsById.values()],
		evidence: [...evidenceById.values()],
		// A refresh of the newest page says nothing about pages already loaded
		// below it; only an earlier-page fetch updates the flag.
		hasEarlier: preserveHasEarlier ? currentHasEarlier : incoming.hasEarlier,
	};
}

/**
 * State and effects for one open workspace. Create it under a Solid owner
 * (it registers cleanup). All domain state comes from API responses; nothing
 * here guesses the outcome of a command.
 *
 * `text` gives the notices' words in the UI language, read when a notice is
 * raised (a view passes `useMessages(sessionMessages)`); English by default.
 */
export function createWorkspaceSession(
	api: ApiClient,
	workspaceId: string,
	visibility: VisibilitySource,
	text: Accessor<SessionText>,
): WorkspaceSession {
	const [view, setView] = createSignal<WorkspaceView | null>(null);
	const [conversation, setConversation] = createSignal<Conversation | null>(null);
	const [hasEarlierMessages, setHasEarlierMessages] = createSignal(false);
	const [loadingEarlier, setLoadingEarlier] = createSignal(false);
	const [earlierError, setEarlierError] = createSignal<ApiFailure | null>(null);
	const [conversationError, setConversationError] = createSignal<ApiFailure | null>(null);
	const [runs, setRuns] = createSignal<readonly ResearchRun[]>([]);
	const [loadError, setLoadError] = createSignal<ApiFailure | null>(null);
	const [notice, setNotice] = createSignal<SessionNotice | null>(null);
	const [commandPending, setCommandPending] = createSignal(false);

	let workspaceEtag: string | null = null;
	let conversationEtag: string | null = null;
	const runEtags = new Map<string, string | null>();
	/** One idempotency key per retried run, so a double click cannot create two retries. */
	const retryKeys = new Map<string, string>();
	let disposed = false;
	/**
	 * Responses can arrive out of order. The gate rejects any read that was sent
	 * before the latest accepted mutation, or before a read that was already
	 * applied, so late answers never replace newer state.
	 */
	const gate = createReadGate();
	/** Set when a run finished and its published results have not been fetched yet. */
	let fullRefreshDue = false;

	const reportFailure = (sentence: string, failure: ApiFailure): SessionNotice => {
		const raised: SessionNotice = { tone: "error", text: sentence, failure };
		setNotice(raised);
		return raised;
	};
	/** The notice the last failed retry left; the next retry attempt clears it. */
	let retryFailure: SessionNotice | null = null;
	/** Clears only the retry's own failure notice; any other notice stays until dismissed. */
	const clearRetryFailure = () => {
		if (retryFailure !== null && notice() === retryFailure) setNotice(null);
		retryFailure = null;
	};

	/** Installs a view unless it is older than the one held: workspace versions only move forward. */
	const installView = (next: WorkspaceView): boolean => {
		const current = view();
		if (current !== null && next.state.version < current.state.version) return false;
		setView(next);
		return true;
	};

	/** Adds or replaces one run, unless what is held is a newer snapshot of the same run. */
	const upsertRun = (run: ResearchRun) => {
		setRuns((current) => {
			const existing = current.find((candidate) => candidate.runId === run.runId);
			if (existing !== undefined && isOlderSnapshot(run, existing)) return current;
			return [run, ...current.filter((candidate) => candidate.runId !== run.runId)].sort(
				byNewestFirst,
			);
		});
	};

	/** A mutation the server accepted: reads still in flight predate it and are discarded. */
	const acceptRun = (run: ResearchRun) => {
		gate.invalidate();
		upsertRun(run);
	};

	/**
	 * Closes the gap between the held window and a non-overlapping refreshed
	 * newest page by paging backwards from the new window (at most
	 * `MAX_GAP_FILL_PAGES` requests). When the pages meet, the union is
	 * installed with the held flag; when the bound is hit first, only the new
	 * window and the fetched pages are kept with `hasEarlier` true, so the
	 * owner can load back to the dropped older window. A failed gap page keeps
	 * the same no-hole shape and records the failure for the retry control.
	 */
	const fillHistoryGap = async (held: Conversation, newest: Conversation): Promise<void> => {
		const heldFlag = hasEarlierMessages();
		let fresh = newest;
		let floor = minSeq(newest.messages);
		let met = false;
		let reachedStart = false;
		for (let step = 0; step < MAX_GAP_FILL_PAGES; step += 1) {
			if (floor === null || disposed) return;
			// Earlier pages are addressed by `before`, not by the newest page's
			// ETag, so they are fetched unconditionally and merged by id.
			const page = await api.getConversation(workspaceId, null, { before: floor });
			if (disposed) return;
			if (!page.ok) {
				setConversation({ ...fresh, hasEarlier: true });
				setHasEarlierMessages(true);
				setConversationError(page.error);
				return;
			}
			const chunk = page.value.changed ? page.value.value : null;
			if (chunk === null) return;
			fresh = mergeConversation(fresh, chunk, false, hasEarlierMessages());
			if (chunk.messages.length === 0 || !chunk.hasEarlier) reachedStart = true;
			if (windowsMeet(held, chunk)) {
				met = true;
				break;
			}
			floor = minSeq(chunk.messages);
		}
		if (disposed) return;
		if (met) {
			const finalFlag = reachedStart ? false : heldFlag;
			const merged = mergeConversation(held, fresh, true, heldFlag);
			setConversation({ ...merged, hasEarlier: finalFlag });
			setHasEarlierMessages(finalFlag);
		} else {
			setConversation({ ...fresh, hasEarlier: true });
			setHasEarlierMessages(true);
		}
	};

	/** Fetches workspace, conversation and run list (ETags make the unchanged case cheap). */
	const refreshAll = async (): Promise<PollSignal> => {
		const ticket = gate.begin();
		const [workspaceResult, conversationResult, runsResult] = await Promise.all([
			api.getWorkspace(workspaceId, workspaceEtag),
			api.getConversation(workspaceId, conversationEtag),
			api.listResearchRuns(workspaceId),
		]);
		if (disposed) return "unchanged";
		// Stale answers are dropped whole, ETags included, and the data is simply read again.
		if (!gate.admit(ticket)) return "changed";
		let changed = false;
		let failed = false;

		if (workspaceResult.ok) {
			setLoadError(null);
			// The ETag is adopted only together with the view it belongs to.
			if (workspaceResult.value.changed && installView(workspaceResult.value.value)) {
				workspaceEtag = workspaceResult.value.etag;
				changed = true;
			}
		} else {
			failed = true;
			// With nothing to show yet this is a load error; otherwise keep the last good view.
			if (view() === null) setLoadError(workspaceResult.error);
		}

		if (conversationResult.ok) {
			setConversationError(null);
			if (conversationResult.value.changed) {
				conversationEtag = conversationResult.value.etag;
				const incoming = conversationResult.value.value;
				const current = conversation();
				if (current === null || !windowsMeet(current, incoming)) {
					if (current === null) {
						setConversation(incoming);
						setHasEarlierMessages(incoming.hasEarlier);
					} else {
						// The refreshed newest page does not overlap what is held:
						// page backwards from the new window until it meets the
						// held one, so no message is silently skipped.
						await fillHistoryGap(current, incoming);
					}
				} else {
					// The refresh fetches only the newest page: merge it so earlier
					// pages already loaded are kept. The flag is preserved, since the
					// newest page cannot say whether earlier pages remain.
					setConversation(
						mergeConversation(current, incoming, current !== null, hasEarlierMessages()),
					);
				}
				changed = true;
			}
		} else {
			failed = true;
			// Existing messages stay visible; the failure is shown with a retry
			// (finding 7) instead of leaving "Loading conversation…" forever.
			setConversationError(conversationResult.error);
		}

		if (runsResult.ok) {
			const next = [...runsResult.value].sort(byNewestFirst);
			if (runsFingerprint(next) !== runsFingerprint(runs())) {
				setRuns(next);
				changed = true;
			}
		} else {
			failed = true;
		}

		if (failed) return "failed";
		fullRefreshDue = false;
		if (runs().some((run) => isLeasedJobState(run.state))) return "active";
		if (changed) return "changed";
		return runs().some((run) => run.state === "pending") ? "queued" : "unchanged";
	};

	/** While a run executes, only that run is polled (conditionally); everything else waits. */
	const pollOnce = async (): Promise<PollSignal> => {
		const executing = runs().filter((run) => isLeasedJobState(run.state));
		if (fullRefreshDue || executing.length === 0 || view() === null) return refreshAll();

		const ticket = gate.begin();
		const results = await Promise.all(
			executing.map((run) => api.getResearchRun(run.runId, runEtags.get(run.runId) ?? null)),
		);
		if (disposed) return "unchanged";
		if (!gate.admit(ticket)) return "changed";
		let someoneFinished = false;
		let failed = false;
		results.forEach((result, index) => {
			const previous = executing[index];
			if (previous === undefined) return;
			if (!result.ok) {
				failed = true;
				return;
			}
			if (!result.value.changed) return;
			runEtags.set(previous.runId, result.value.etag);
			upsertRun(result.value.value);
			if (!isLeasedJobState(result.value.value.state)) someoneFinished = true;
		});
		if (someoneFinished) {
			// A finished run may have published components and an answer. They are fetched now
			// if the owner is looking; a hidden tab makes no new requests, so the refresh waits
			// until the tab is shown again (the poller polls at once when that happens).
			fullRefreshDue = true;
			return visibility.isVisible() ? refreshAll() : "changed";
		}
		return failed ? "failed" : "active";
	};

	const poller = createPoller({ poll: pollOnce, visibility });
	poller.start();
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	const loadEarlierMessages = async (): Promise<void> => {
		const current = conversation();
		if (current === null || !hasEarlierMessages() || loadingEarlier() || disposed) return;
		const smallest = current.messages.reduce<number | null>(
			(minimum, message) => (minimum === null || message.seq < minimum ? message.seq : minimum),
			null,
		);
		// An empty thread has nothing earlier to fetch.
		if (smallest === null) {
			setHasEarlierMessages(false);
			return;
		}
		setLoadingEarlier(true);
		setEarlierError(null);
		try {
			// Earlier pages are addressed by `before`, not by the newest page's
			// ETag, so they are fetched unconditionally and merged by id. Merging
			// is monotonic (union), so an out-of-order arrival cannot drop state.
			const result = await api.getConversation(workspaceId, null, { before: smallest });
			if (disposed) return;
			if (!result.ok) {
				// The spinner stops but the loaded messages stay: the failure
				// is shown with a retry (finding 7).
				setEarlierError(result.error);
				return;
			}
			setEarlierError(null);
			// A 304 without an ETag sent cannot happen; only a changed page merges.
			const incoming = result.value.changed ? result.value.value : null;
			if (incoming === null) return;
			setConversation((previous) =>
				previous === null
					? incoming
					: mergeConversation(previous, incoming, false, hasEarlierMessages()),
			);
			setHasEarlierMessages(incoming.hasEarlier);
		} finally {
			if (!disposed) setLoadingEarlier(false);
		}
	};

	const dispatch = async (operation: UiOperation): Promise<void> => {
		const current = view();
		if (current === null || commandPending()) return;
		setCommandPending(true);
		const result = await api.submitCommand(
			buildCommand(operation, {
				commandId: api.newCommandId(),
				workspaceId,
				expectedWorkspaceVersion: current.state.version,
			}),
		);
		if (disposed) return;
		if (result.ok) {
			// Render exactly what the server accepted, not what was asked for — unless a poll
			// has meanwhile delivered an even newer version, which this response must not undo.
			const accepted = result.value.state;
			gate.invalidate();
			setView((previous) =>
				previous === null || accepted.version < previous.state.version
					? previous
					: {
							...previous,
							state: accepted,
							workspace: { ...previous.workspace, version: accepted.version },
						},
			);
			setNotice(null);
		} else if (result.error.code === "VERSION_CONFLICT") {
			await refreshAll();
			setNotice({
				tone: "error",
				text: text().versionConflict,
				failure: result.error,
			});
		} else {
			reportFailure(text().changeRejected, result.error);
		}
		setCommandPending(false);
	};

	return {
		view,
		conversation,
		runs,
		hasEarlierMessages,
		loadingEarlier,
		earlierError,
		conversationError,
		loadError,
		notice,
		commandPending,
		dismissNotice: () => setNotice(null),
		reload: async () => {
			await refreshAll();
		},
		loadEarlierMessages,
		dispatch,
		submitRun: async (request, idempotencyKey) => {
			const result = await api.createResearchRun(request, idempotencyKey);
			if (result.ok && !disposed) {
				acceptRun(result.value);
				// The owner's question is stored server-side; fetch it rather than echoing a guess.
				poller.pollNow();
			}
			return result;
		},
		cancelRun: async (runId) => {
			const result = await api.cancelResearchRun(runId);
			if (disposed) return;
			if (result.ok) acceptRun(result.value);
			else reportFailure(text().cancelFailed, result.error);
		},
		retryRun: async (runId) => {
			const key = retryKeys.get(runId) ?? api.newIdempotencyKey();
			retryKeys.set(runId, key);
			// A new attempt answers the previous one's failure: never leave it on screen.
			clearRetryFailure();
			const result = await api.retryResearchRun(runId, key);
			if (disposed) return;
			if (result.ok) {
				acceptRun(result.value);
				poller.pollNow();
			} else {
				retryFailure = reportFailure(text().retryFailed, result.error);
			}
		},
		approveRun: async (runId, budget) => {
			const result = await api.approveResearchRun(runId, budget);
			if (result.ok && !disposed) {
				acceptRun(result.value);
				poller.pollNow();
			}
			return result;
		},
	};
}
