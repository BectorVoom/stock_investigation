import type { GoogleCalendarState } from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createSignal, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, BUTTON_DANGER, ConfirmDialog, ErrorNotice } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { formatInstant } from "../lib/format.ts";
import { createGoogleSyncQueue } from "../watchlist/googleSyncQueue.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { googleFailureReason } from "../watchlist/watchlistModel.ts";
import { googleCalendarMessages } from "./calendarSettings.messages.tsx";
import { SettingRow } from "./SettingsLayout.tsx";

function syncCountsText(
	state: GoogleCalendarState,
	text: MessagesOf<typeof googleCalendarMessages>,
): string | null {
	if (state.lastSync === null) return null;
	const { inserted, updated, deleted } = state.lastSync;
	return text.syncCounts(inserted, updated, deleted);
}

/**
 * The Google Calendar row in Settings → Calendar (FR-019 section 2.7): every
 * state as a complete sentence beside the actions it allows: connect,
 * cancel, disconnect, reconnect. The sync itself is the server's (ADR-0053):
 * no button queues one. Queueing goes through `createGoogleSyncQueue`;
 * cancelling a connecting run uses the existing run-cancel endpoint. Never
 * renders the auth URL outside the sign-in link.
 */
export function GoogleCalendarCard(props: {
	readonly state: GoogleCalendarState;
	readonly api: ApiClient;
	readonly busy: boolean;
	readonly onQueued: () => void;
	readonly onQueueFailed: (title: string, error: ApiFailure) => void;
}): JSX.Element {
	const m = useMessages(googleCalendarMessages);
	const modelText = useMessages(watchlistModelMessages);
	const common = useMessages(commonMessages);
	const [queueBusy, setQueueBusy] = createSignal(false);
	const [disconnectConfirm, setDisconnectConfirm] = createSignal<HTMLElement | null>(null);
	const [cancelBusy, setCancelBusy] = createSignal(false);
	const queue = createGoogleSyncQueue(props.api);

	const queueAction = async (action: "connect" | "disconnect"): Promise<void> => {
		if (queueBusy() || props.busy) return;
		setQueueBusy(true);
		const result = await queue.queue(action);
		setQueueBusy(false);
		if (result.kind === "busy") return;
		if (result.kind === "failed") {
			props.onQueueFailed(
				action === "connect" ? m().connectNotQueued : m().disconnectNotQueued,
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
			props.onQueueFailed(m().runNotCancelled, result.error);
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
		const text = m();
		const since =
			state.connectedAt === null
				? text.connected
				: text.connectedSince(formatInstant(state.connectedAt));
		if (state.activeRunId !== null) {
			return state.activeAction === "disconnect" ? text.disconnecting(since) : text.syncing(since);
		}
		// Says so when the calendar is behind and nothing is running: the
		// server's next sync catches it up.
		const behind = state.inSync === false ? text.behind : "";
		if (state.lastSyncedAt !== null) {
			const counts = syncCountsText(state, text);
			return text.lastSynced(
				since,
				formatInstant(state.lastSyncedAt),
				counts ?? text.noChanges,
				behind,
			);
		}
		return text.notSyncedYet(since);
	};

	const failure = () => props.state.lastFailure;

	return (
		<>
			<SettingRow
				// i18n-exempt: product name
				label="Google Calendar"
				heading
				field="google-calendar"
				description={
					<>
						<Show when={props.state.status === "disconnected"}>
							<p>{m().disconnectedIntro}</p>
						</Show>
						<Show when={props.state.status === "connecting"}>
							<Show
								when={props.state.authUrl}
								fallback={<output class="block">{m().preparingSignIn}</output>}
							>
								{(url) => (
									<>
										<SafeLink url={url()}>{m().openSignIn}</SafeLink>
										<p>{m().waitingForSignIn}</p>
									</>
								)}
							</Show>
						</Show>
						<Show when={props.state.status === "connected"}>
							<output class="block">{connectedLine()}</output>
						</Show>
						<Show when={props.state.status === "needs-reconnect"}>
							<p>
								{m().reconnectToKeep(
									props.state.lastFailure === null
										? m().needsAttention
										: modelText().reasonWithUpstreamStatus(
												googleFailureReason(props.state.lastFailure.code, modelText()),
												props.state.lastFailure.upstreamStatus,
											),
								)}
							</p>
						</Show>
					</>
				}
				controlLayout="actions"
				control={
					<>
						<Show when={props.state.status === "disconnected"}>
							<button
								type="button"
								class={BUTTON}
								disabled={queueBusy() || props.busy}
								onClick={() => void queueAction("connect")}
							>
								{m().connect}
							</button>
						</Show>
						{/* Offered in both connecting sub-states: a sign-in that is still
						    being prepared (runner offline) must be cancellable too. */}
						<Show when={props.state.status === "connecting" && runActive()}>
							<button
								type="button"
								class={BUTTON}
								disabled={cancelBusy() || props.busy}
								onClick={() => void cancelRun()}
							>
								{common().cancel}
							</button>
						</Show>
						<Show when={props.state.status === "connected"}>
							<button
								type="button"
								class={BUTTON_DANGER}
								// One step at a time: the API refuses a second one.
								disabled={queueBusy() || props.busy || runActive()}
								onClick={(event) => setDisconnectConfirm(event.currentTarget)}
							>
								{m().disconnect}
							</button>
						</Show>
						<Show when={props.state.status === "needs-reconnect"}>
							<button
								type="button"
								class={BUTTON}
								disabled={queueBusy() || props.busy}
								onClick={() => void queueAction("connect")}
							>
								{m().reconnect}
							</button>
						</Show>
					</>
				}
				below={
					// Needs-reconnect already states its reason above; no second copy.
					<Show when={props.state.status === "needs-reconnect" ? null : failure()}>
						{(current) => (
							<div>
								<ErrorNotice
									failure={{
										code: current().code,
										message: googleFailureReason(current().code, modelText()),
										detail: null,
										issues: [],
										upstreamStatus: current().upstreamStatus,
									}}
									title={m().stepFailed}
								/>
								<Show when={props.state.status === "connected"}>
									<p class="mt-1 text-xs text-slate-700">{m().autoSyncPaused}</p>
								</Show>
							</div>
						)}
					</Show>
				}
			/>
			{(() => {
				// Read once per render (never a `Show` value accessor): closing
				// the dialog disposes it, and no disposed accessor is ever read.
				const opener = disconnectConfirm();
				if (opener === null) return null;
				return (
					<ConfirmDialog
						title={m().disconnectTitle}
						opener={opener}
						confirmLabel={m().disconnect}
						pending={queueBusy()}
						failure={null}
						onConfirm={() => void confirmDisconnect()}
						onCancel={() => setDisconnectConfirm(null)}
					>
						{m().disconnectBody}
					</ConfirmDialog>
				);
			})()}
		</>
	);
}
