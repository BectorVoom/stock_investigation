import type { WatchlistResponse } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { failureMessageIn } from "../api/errorText.ts";
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
	Section,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { downloadTextFile } from "../lib/download.ts";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createGoogleSyncQueue } from "../watchlist/googleSyncQueue.ts";
import { googleAutoSyncWanted, watchlistRefreshSignal } from "../watchlist/watchlistModel.ts";
import { calendarSettingsMessages } from "./calendarSettings.messages.tsx";
import { GoogleCalendarCard } from "./GoogleCalendarCard.tsx";

type FeedConfirm = "replace" | "revoke";

/**
 * Settings → Calendar (ADR-0022): how the watchlist's earnings dates reach
 * the owner's own calendars — the Google Calendar card, the `.ics` download
 * and the subscription link. They moved here from the Watchlist page, which
 * now lists the stocks only. The state lives on the watchlist response, so
 * the section reads it and polls only while a run is active; when that run
 * ends it applies the same automatic Google sync rule as Home and the
 * Watchlist page (`googleAutoSyncWanted`), so a connection made here syncs
 * without visiting another page.
 */
export function CalendarSettingsSection(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** From the `#/settings/calendar` route marker; scrolls to and focuses this section. */
	readonly section: string | null;
}): JSX.Element {
	const m = useMessages(calendarSettingsMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
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
	const googleQueue = createGoogleSyncQueue(props.api);
	/** The watchlist ETag an automatic Google sync was already attempted for (at most one per ETag). */
	let googleSyncAttemptedEtag: string | null = null;
	let disposed = false;
	let sectionRef: HTMLDivElement | undefined;
	onCleanup(() => {
		disposed = true;
		poller.stop();
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

	/** After a load with no run active: queue one Google sync when the shared rule says so. */
	const maybeAutoGoogleSync = (): void => {
		const current = data();
		const tag = etag();
		if (disposed || current === null || tag === null) return;
		if (!googleAutoSyncWanted(current, tag, googleSyncAttemptedEtag)) return;
		googleSyncAttemptedEtag = tag;
		void googleQueue.queue("sync").then((result) => {
			if (disposed) return;
			if (result.kind === "failed") {
				setNotice(m().googleSyncNotQueued(failureMessageIn(result.error, locale())));
				return;
			}
			if (result.kind === "queued") void reloadAfterWrite();
		});
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				// The poller only runs while a run is active: it has ended.
				poller.stop();
				maybeAutoGoogleSync();
			}
			return signal;
		},
		visibility: props.visibility,
	});

	const reloadAfterWrite = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (runActive()) poller.start();
		else maybeAutoGoogleSync();
	};

	onMount(() => void reloadAfterWrite());

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
			<Section title={m().title} label={m().title}>
				<p class="text-xs text-slate-700">
					{m().intro(
						<a
							href="#/watchlist"
							class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
						>
							{m().watchlistLink}
						</a>,
					)}
				</p>
				<Show when={failure()}>
					{(current) => (
						<div class="mt-2">
							<ErrorNotice
								failure={current().error}
								title={current().title}
								onRetry={() => {
									setFailure(null);
									setLoading(true);
									void reloadAfterWrite();
								}}
							/>
						</div>
					)}
				</Show>
				<Show when={notice()}>
					{(text) => (
						<div class="mt-2">
							<Notice tone="info">{text()}</Notice>
						</div>
					)}
				</Show>
				<Show when={loading()}>
					<Loading label={m().calendarThing} />
				</Show>
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
				<div class="mt-3">
					<button
						type="button"
						class={BUTTON}
						disabled={downloadBusy() || stockCount() === 0}
						onClick={() => void downloadIcs()}
					>
						{downloadBusy() ? m().preparingFile : m().downloadIcs}
					</button>
					<Show when={data() !== null && stockCount() === 0}>
						<p class="mt-1 text-xs text-slate-700">{m().addStockFirst}</p>
					</Show>
				</div>
				<div class="mt-3 rounded border border-slate-200 p-2">
					<h4 class="text-xs font-semibold text-slate-900">{m().subscriptionLink}</h4>
					<Show when={issuedUrl()}>
						{(url) => (
							<div class="mt-1 space-y-1">
								<p class="text-xs text-slate-700">{m().shownOnce}</p>
								<div class="flex flex-wrap items-center gap-2">
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
					<Show when={feedCreatedAt()}>
						{(createdAt) => (
							<div class="mt-1 space-y-1">
								<p class="text-xs text-slate-700">
									{m().linkCreated(
										<time dateTime={createdAt()}>{formatInstant(createdAt())}</time>,
									)}
								</p>
								<div class="flex flex-wrap gap-2">
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
								</div>
							</div>
						)}
					</Show>
					<Show when={data() !== null && feedCreatedAt() === null && issuedUrl() === null}>
						<div class="mt-1 space-y-1">
							<p class="text-xs text-slate-700">{m().noLinkYet}</p>
							<button
								type="button"
								class={BUTTON_PRIMARY}
								disabled={busy()}
								onClick={() => void issueFeed()}
							>
								{m().createLink}
							</button>
						</div>
					</Show>
					<p class="mt-2 text-xs text-slate-700">{m().linkIsSecret}</p>
				</div>
			</Section>
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
