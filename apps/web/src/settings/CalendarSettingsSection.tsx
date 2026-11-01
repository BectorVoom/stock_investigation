import type { WatchlistResponse } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	ConfirmDialog,
	ErrorNotice,
	INPUT,
	Loading,
	Notice,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { downloadTextFile } from "../lib/download.ts";
import { formatInstant } from "../lib/format.ts";
import {
	createIdleReread,
	createPoller,
	type PollSignal,
	type VisibilitySource,
} from "../lib/polling.ts";
import { REGISTERED_STOCKS_HASH } from "../router.ts";
import { watchlistRefreshSignal } from "../watchlist/watchlistModel.ts";
import { calendarSettingsMessages } from "./calendarSettings.messages.tsx";
import { GoogleCalendarCard } from "./GoogleCalendarCard.tsx";
import { SettingRow, SettingsPane } from "./SettingsLayout.tsx";

type FeedConfirm = "replace" | "revoke";

/**
 * Settings → Calendar (ADR-0022): how the watchlist's earnings dates reach
 * the owner's own calendars — the Google Calendar card, the `.ics` download
 * and the subscription link. They moved here from the Watchlist page, which
 * now lists the stocks only. The state lives on the watchlist response, so
 * the section reads it, polls while a run is active and otherwise re-reads
 * it while visible (`createIdleReread`). The Google Calendar is synced by
 * the server whenever it is behind the earnings dates (ADR-0053): the
 * section never queues a sync, and the re-read — sooner while a connected
 * calendar is behind and no failure stopped the sync — shows the server's.
 */
export function CalendarSettingsSection(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** A link to `#/settings/calendar` scrolls to and focuses this pane's heading. */
	readonly section: string | null;
}): JSX.Element {
	const m = useMessages(calendarSettingsMessages);
	const common = useMessages(commonMessages);
	const [data, setData] = createSignal<WatchlistResponse | null>(null);
	const [etag, setEtag] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<{ title: string; error: ApiFailure } | null>(null);
	const [notice, setNotice] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [feedConfirm, setFeedConfirm] = createSignal<FeedConfirm | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	/** The subscription URL, kept only from the moment it is issued until the next reload. */
	const [issuedUrl, setIssuedUrl] = createSignal<string | null>(null);
	const [copied, setCopied] = createSignal(false);
	const [downloadBusy, setDownloadBusy] = createSignal(false);
	let disposed = false;
	let sectionRef: HTMLDivElement | undefined;
	onCleanup(() => {
		disposed = true;
		poller.stop();
		idleReread.stop();
	});

	const loadWatchlist = async (): Promise<PollSignal> => {
		const result = await props.api.getWatchlist(etag());
		if (disposed) return "unchanged";
		setLoading(false);
		if (!result.ok) {
			if (data() === null) setFailure({ title: m().loadFailed, error: result.error });
			else setNotice(m().notRefreshed);
			return "failed";
		}
		if (!result.value.changed) return watchlistRefreshSignal(data());
		setData(result.value.value);
		setEtag(result.value.etag);
		setFailure(null);
		const signal = watchlistRefreshSignal(result.value.value);
		return signal === "unchanged" ? "changed" : signal;
	};

	const runActive = (): boolean => watchlistRefreshSignal(data()) !== "unchanged";

	const poller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				// The poller only runs while a run is active: it has ended. A
				// connect leaves the calendar behind the dates, and the server's
				// sync follows at the runner's next claim: look again soon.
				poller.stop();
				idleReread.soon();
			}
			return signal;
		},
		visibility: props.visibility,
	});

	/** A connected calendar behind the dates with no failure: the server syncs it at the runner's next claim. */
	const googleBehind = (): boolean => {
		const google = data()?.googleCalendar;
		return google?.status === "connected" && google.inSync === false && google.lastFailure === null;
	};

	const idleReread = createIdleReread({
		visibility: props.visibility,
		busy: () => disposed || data() === null || runActive(),
		awaiting: googleBehind,
		reread: async () => {
			await loadWatchlist();
			if (!disposed && runActive()) poller.start();
		},
	});

	const reloadAfterWrite = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (runActive()) poller.start();
		// A connect or disconnect ends in a state the server acts on next.
		idleReread.soon();
	};

	onMount(() => {
		idleReread.start();
		void reloadAfterWrite();
	});

	/** Scrolls to and focuses the section heading for `#/settings/calendar`, once per link. */
	let linkedFocused = false;
	createEffect(() => {
		if (props.section !== "calendar") {
			linkedFocused = false;
			return;
		}
		const section = sectionRef;
		if (section === undefined || linkedFocused) return;
		linkedFocused = true;
		queueMicrotask(() => {
			if (disposed) return;
			const heading = section.querySelector("h3");
			if (!(heading instanceof HTMLElement)) return;
			heading.setAttribute("tabindex", "-1");
			if (typeof heading.scrollIntoView === "function") heading.scrollIntoView({ block: "start" });
			if (typeof heading.focus === "function") heading.focus({ preventScroll: true });
		});
	});

	const downloadIcs = async (): Promise<void> => {
		if (downloadBusy()) return;
		setDownloadBusy(true);
		setFailure(null);
		const result = await props.api.downloadWatchlistIcs();
		if (disposed) return;
		setDownloadBusy(false);
		if (!result.ok) {
			setFailure({ title: m().notDownloaded, error: result.error });
			return;
		}
		downloadTextFile(
			document,
			"earnings-calendar.ics",
			"text/calendar; charset=utf-8",
			result.value,
		);
	};

	const issueFeed = async (): Promise<void> => {
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		setNotice(null);
		setCopied(false);
		const result = await props.api.issueCalendarFeed();
		if (disposed) return;
		setBusy(false);
		setFeedConfirm(null);
		if (!result.ok) {
			setFailure({ title: m().linkNotCreated, error: result.error });
			return;
		}
		setIssuedUrl(`${window.location.origin}${result.value.path}`);
		await reloadAfterWrite();
	};

	const revokeFeed = async (): Promise<void> => {
		if (busy()) return;
		setBusy(true);
		setFailure(null);
		const result = await props.api.revokeCalendarFeed();
		if (disposed) return;
		setBusy(false);
		setFeedConfirm(null);
		if (!result.ok) {
			setFailure({ title: m().linkNotRevoked, error: result.error });
			return;
		}
		setIssuedUrl(null);
		setNotice(m().linkRevoked);
		await reloadAfterWrite();
	};

	const copyIssuedUrl = async (): Promise<void> => {
		const url = issuedUrl();
		if (url === null) return;
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
		} catch {
			setFailure({
				title: m().linkNotCopied,
				error: {
					kind: "invalid-response",
					code: "UNEXPECTED_STATUS",
					status: null,
					// Written in the UI language: a client code with the caller's own sentence is shown as is.
					message: m().copyFailed,
					detail: null,
					issues: [],
				},
			});
		}
	};

	const stockCount = () => data()?.stocks.length ?? 0;
	const feedCreatedAt = () => data()?.feed.createdAt ?? null;
	const openFeedConfirm = (kind: FeedConfirm, element: HTMLElement) => {
		setOpener(element);
		setFeedConfirm(kind);
	};
	const closeDialogs = () => {
		setFeedConfirm(null);
		opener()?.focus();
	};

	return (
		<div data-calendar-settings ref={sectionRef}>
			<SettingsPane
				title={m().title}
				intro={m().intro(
					<a
						href={REGISTERED_STOCKS_HASH}
						class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
					>
						{m().watchlistLink}
					</a>,
				)}
			>
				<div class="space-y-2 py-3 empty:hidden">
					<Show when={failure()}>
						{(current) => (
							<ErrorNotice
								failure={current().error}
								title={current().title}
								onRetry={() => {
									setFailure(null);
									setLoading(true);
									void reloadAfterWrite();
								}}
							/>
						)}
					</Show>
					<Show when={notice()}>{(text) => <Notice tone="info">{text()}</Notice>}</Show>
					<Show when={loading()}>
						<Loading label={m().calendarThing} />
					</Show>
				</div>
				<Show when={data()}>
					{(current) => (
						<GoogleCalendarCard
							state={current().googleCalendar}
							api={props.api}
							busy={busy()}
							onQueued={() => void reloadAfterWrite()}
							onQueueFailed={(title, error) => setFailure({ title, error })}
						/>
					)}
				</Show>
				<SettingRow
					label={m().fileTitle}
					description={
						<>
							<p>{m().fileHint}</p>
							<Show when={data() !== null && stockCount() === 0}>
								<p class="mt-0.5 text-slate-700">{m().addStockFirst}</p>
							</Show>
						</>
					}
					controlLayout="actions"
					control={
						<button
							type="button"
							class={BUTTON}
							disabled={downloadBusy() || stockCount() === 0}
							onClick={() => void downloadIcs()}
						>
							{downloadBusy() ? m().preparingFile : m().downloadIcs}
						</button>
					}
				/>
				<SettingRow
					label={m().subscriptionLink}
					heading
					description={
						<>
							<Show when={issuedUrl() !== null}>
								<p>{m().shownOnce}</p>
							</Show>
							<Show when={feedCreatedAt()}>
								{(createdAt) => (
									<p>
										{m().linkCreated(
											<time dateTime={createdAt()}>{formatInstant(createdAt())}</time>,
										)}
									</p>
								)}
							</Show>
							<Show when={data() !== null && feedCreatedAt() === null && issuedUrl() === null}>
								<p>{m().noLinkYet}</p>
							</Show>
							<p class="mt-1">{m().linkIsSecret}</p>
						</>
					}
					controlLayout="actions"
					control={
						<>
							<Show when={feedCreatedAt() !== null}>
								<button
									type="button"
									class={BUTTON}
									disabled={busy()}
									onClick={(event) => openFeedConfirm("replace", event.currentTarget)}
								>
									{m().replaceLink}
								</button>
								<button
									type="button"
									class={BUTTON_DANGER}
									disabled={busy()}
									onClick={(event) => openFeedConfirm("revoke", event.currentTarget)}
								>
									{m().revokeLink}
								</button>
							</Show>
							<Show when={data() !== null && feedCreatedAt() === null && issuedUrl() === null}>
								<button
									type="button"
									class={BUTTON_PRIMARY}
									disabled={busy()}
									onClick={() => void issueFeed()}
								>
									{m().createLink}
								</button>
							</Show>
						</>
					}
					below={
						<Show when={issuedUrl()}>
							{(url) => (
								<div class="space-y-1">
									<div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
										<input
											type="text"
											readonly
											aria-label={m().linkFieldLabel}
											class={`${INPUT} font-mono`}
											value={url()}
											onFocus={(event) => event.currentTarget.select()}
										/>
										<button type="button" class={BUTTON} onClick={() => void copyIssuedUrl()}>
											{common().copy}
										</button>
									</div>
									<Show when={copied()}>
										<output class="block text-xs text-slate-700">{m().copied}</output>
									</Show>
								</div>
							)}
						</Show>
					}
				/>
			</SettingsPane>
			<Show when={feedConfirm() === "replace"}>
				<ConfirmDialog
					title={m().replaceTitle}
					opener={opener()}
					confirmLabel={m().replaceLink}
					pending={busy()}
					failure={null}
					onConfirm={() => void issueFeed()}
					onCancel={closeDialogs}
				>
					{m().replaceBody}
				</ConfirmDialog>
			</Show>
			<Show when={feedConfirm() === "revoke"}>
				<ConfirmDialog
					title={m().revokeTitle}
					opener={opener()}
					confirmLabel={m().revokeLink}
					pending={busy()}
					failure={null}
					onConfirm={() => void revokeFeed()}
					onCancel={closeDialogs}
				>
					{m().revokeBody}
				</ConfirmDialog>
			</Show>
		</div>
	);
}
