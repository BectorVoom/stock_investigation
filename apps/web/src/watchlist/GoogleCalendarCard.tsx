import type { GoogleCalendarState } from "@research/contracts";
import { SafeLink } from "@research/ui-registry";
import { createSignal, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, BUTTON_DANGER, ConfirmDialog, ErrorNotice } from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createGoogleSyncQueue } from "./googleSyncQueue.ts";
import { googleFailureReason } from "./watchlistModel.ts";

function syncCountsText(state: GoogleCalendarState): string | null {
	if (state.lastSync === null) return null;
	const { inserted, updated, deleted } = state.lastSync;
	return `${inserted} added, ${updated} changed, ${deleted} removed.`;
}

/**
 * The Google Calendar card on the Watchlist page (FR-019 section 2.7): every
 * state as a complete sentence. Queueing goes through the shared
 * `createGoogleSyncQueue`; cancelling a connecting run uses the existing
 * run-cancel endpoint. Never renders the auth URL outside the sign-in link.
 */
export function GoogleCalendarCard(props: {
	readonly state: GoogleCalendarState;
	readonly api: ApiClient;
	readonly busy: boolean;
	readonly onQueued: () => void;
	readonly onQueueFailed: (title: string, error: ApiFailure) => void;
}): JSX.Element {
	const [queueBusy, setQueueBusy] = createSignal(false);
	const [disconnectConfirm, setDisconnectConfirm] = createSignal<HTMLElement | null>(null);
	const [cancelBusy, setCancelBusy] = createSignal(false);
	const queue = createGoogleSyncQueue(props.api);

	const queueAction = async (action: "connect" | "sync" | "disconnect"): Promise<void> => {
		if (queueBusy() || props.busy) return;
		setQueueBusy(true);
		const result = await queue.queue(action);
		setQueueBusy(false);
		if (result.kind === "busy") return;
		if (result.kind === "failed") {
			props.onQueueFailed(
				action === "connect"
					? "The Google Calendar connection was not queued."
					: action === "sync"
						? "The Google Calendar sync was not queued."
						: "The Google Calendar disconnection was not queued.",
				result.error,
			);
			return;
		}
		props.onQueued();
	};

	const cancelRun = async (): Promise<void> => {
		const runId = props.state.activeRunId;
		if (runId === null || cancelBusy()) return;
		setCancelBusy(true);
		const result = await props.api.cancelResearchRun(runId);
		setCancelBusy(false);
		if (!result.ok) {
			props.onQueueFailed("The Google Calendar run was not cancelled.", result.error);
			return;
		}
		props.onQueued();
	};

	/**
	 * Disconnects after the confirmation: the queue resolves first and only
	 * then the dialog closes (closing synchronously inside the confirm click
	 * would dispose the dialog mid-dispatch).
	 */
	const confirmDisconnect = async (): Promise<void> => {
		await queueAction("disconnect");
		setDisconnectConfirm(null);
	};

	const runActive = () => props.state.activeRunId !== null;

	const connectedLine = (): string => {
		const state = props.state;
		const since =
			state.connectedAt === null
				? "Connected."
				: `Connected since ${formatInstant(state.connectedAt)}.`;
		if (state.activeRunId !== null) {
			return state.activeAction === "disconnect" ? `${since} Disconnecting…` : `${since} Syncing…`;
		}
		// Says so when the calendar is behind and nothing is running: after
		// a failed sync nothing is queued automatically (see below).
		const behind =
			state.inSync === false
				? " The dates here have changed since; use Sync now to update the calendar."
				: "";
		if (state.lastSyncedAt !== null) {
			const counts = syncCountsText(state);
			return `${since} Last synced ${formatInstant(state.lastSyncedAt)}: ${counts ?? "no changes."}${behind}`;
		}
		return `${since} Not synced yet.`;
	};

	const failure = () => props.state.lastFailure;

	return (
		<div class="mt-3 rounded border border-slate-200 p-2">
			<h4 class="text-xs font-semibold text-slate-900">Google Calendar</h4>
			<Show when={props.state.status === "disconnected"}>
				<p class="mt-1 text-xs text-slate-700">
					Keeps a calendar named &lsquo;Earnings calendar (Research workspace)&rsquo; in your Google
					account in step with these dates. The app can only see and change calendars it created
					itself.
				</p>
				<div class="mt-1">
					<button
						type="button"
						class={BUTTON}
						disabled={queueBusy() || props.busy}
						onClick={() => void queueAction("connect")}
					>
						Connect Google Calendar
					</button>
				</div>
			</Show>
			<Show when={props.state.status === "connecting"}>
				<div class="mt-1 space-y-1">
					<Show
						when={props.state.authUrl}
						fallback={
							<output class="block text-xs text-slate-700">
								Preparing Google sign-in… It is prepared by the local runner; if the runner is
								offline this waits until it reconnects.
							</output>
						}
					>
						{(url) => (
							<>
								<SafeLink url={url()}>Open Google sign-in</SafeLink>
								<p class="text-xs text-slate-700">
									Waiting for you to finish in Google (5 minutes)…
								</p>
							</>
						)}
					</Show>
					{/* Offered in both sub-states: a sign-in that is still being
					    prepared (runner offline) must be cancellable too. */}
					<Show when={runActive()}>
						<button
							type="button"
							class={BUTTON}
							disabled={cancelBusy() || props.busy}
							onClick={() => void cancelRun()}
						>
							Cancel
						</button>
					</Show>
				</div>
			</Show>
			<Show when={props.state.status === "connected"}>
				<output class="mt-1 block text-xs text-slate-700">{connectedLine()}</output>
				<div class="mt-1 flex flex-wrap gap-2">
					<button
						type="button"
						class={BUTTON}
						disabled={queueBusy() || props.busy || runActive()}
						onClick={() => void queueAction("sync")}
					>
						Sync now
					</button>
					<button
						type="button"
						class={BUTTON_DANGER}
						// One step at a time: the API refuses a second one.
						disabled={queueBusy() || props.busy || runActive()}
						onClick={(event) => setDisconnectConfirm(event.currentTarget)}
					>
						Disconnect
					</button>
				</div>
			</Show>
			<Show when={props.state.status === "needs-reconnect"}>
				<p class="mt-1 text-xs text-slate-700">
					{props.state.lastFailure === null
						? "The Google connection needs attention."
						: googleFailureReason(props.state.lastFailure.code)}{" "}
					Reconnect to keep the calendar in step.
				</p>
				<div class="mt-1">
					<button
						type="button"
						class={BUTTON}
						disabled={queueBusy() || props.busy}
						onClick={() => void queueAction("connect")}
					>
						Reconnect Google Calendar
					</button>
				</div>
			</Show>
			{/* Needs-reconnect already states its reason above; no second copy. */}
			<Show when={props.state.status === "needs-reconnect" ? null : failure()}>
				{(current) => (
					<div class="mt-1">
						<ErrorNotice
							failure={{
								code: current().code,
								message: googleFailureReason(current().code),
								detail: null,
								issues: [],
							}}
							title="The Google Calendar step failed."
						/>
						<Show when={props.state.status === "connected"}>
							<p class="mt-1 text-xs text-slate-700">
								Automatic syncing is paused until a sync succeeds. Use Sync now to try again.
							</p>
						</Show>
					</div>
				)}
			</Show>
			{(() => {
				// Read once per render (never a `Show` value accessor): closing
				// the dialog disposes it, and no disposed accessor is ever read.
				const opener = disconnectConfirm();
				if (opener === null) return null;
				return (
					<ConfirmDialog
						title="Disconnect Google Calendar?"
						opener={opener}
						confirmLabel="Disconnect"
						pending={queueBusy()}
						failure={null}
						onConfirm={() => void confirmDisconnect()}
						onCancel={() => setDisconnectConfirm(null)}
					>
						The calendar stays in your Google account — delete it there (Google Calendar settings)
						if you no longer want it. This app forgets the connection at once.
					</ConfirmDialog>
				);
			})()}
		</div>
	);
}
