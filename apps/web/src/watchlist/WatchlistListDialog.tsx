import type { WatchlistList, WatchlistResponse } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import {
	createEffect,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { BUTTON, ErrorNotice } from "../components/ui.tsx";
import { watchlistPricesMessages } from "../home/widgets/watchlistPrices.messages.ts";
import { commonMessages } from "../i18n/common.messages.ts";
import { WATCHLIST_HASH } from "../router.ts";
import { TASK_LINK } from "../tasks/TaskParts.tsx";
import { watchlistListsMessages } from "./watchlistLists.messages.ts";

/**
 * The add menu's "Watchlist prices" dialog (ADR-0040 §6): the owner's lists,
 * each a button with its title and stock count; choosing one places the
 * widget. With no lists it says so and links to the Watchlist page. A native
 * modal dialog like the Task result dialog: focus moves to the first list
 * (else Cancel) on open, Escape or Cancel closes, and focus returns to the
 * opener. The lists come from one watchlist read when the dialog opens.
 */
export function WatchlistListDialog(props: {
	readonly api: ApiClient;
	readonly opener: HTMLElement | null;
	/** Places the widget; resolves true once saved (the dialog then closes). */
	readonly onChoose: (list: WatchlistList) => Promise<boolean>;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(watchlistListsMessages);
	const counts = useMessages(watchlistPricesMessages);
	const common = useMessages(commonMessages);
	const headingId = createUniqueId();
	const introId = createUniqueId();
	const [watchlist, setWatchlist] = createSignal<WatchlistResponse | null>(null);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [saving, setSaving] = createSignal(false);
	let disposed = false;
	let dialog: HTMLDialogElement | undefined;
	let list: HTMLUListElement | undefined;
	let cancelButton: HTMLButtonElement | undefined;
	onCleanup(() => {
		disposed = true;
	});

	const load = async (): Promise<void> => {
		setFailure(null);
		const result = await props.api.getWatchlist();
		if (disposed) return;
		if (!result.ok) {
			setFailure(result.error);
			return;
		}
		// An unconditional read always carries a body.
		if (result.value.changed) setWatchlist(result.value.value);
	};

	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};
	const choose = async (chosen: WatchlistList): Promise<void> => {
		if (saving()) return;
		setSaving(true);
		const saved = await props.onChoose(chosen);
		if (disposed) return;
		setSaving(false);
		// A refused save (busy, the page full) keeps the dialog open; the page says why.
		if (saved) close();
	};
	/** The first list when there is one, else Cancel: where focus starts. */
	const focusStart = (): void => {
		const first = list?.querySelector("button");
		if (first instanceof HTMLButtonElement) first.focus();
		else cancelButton?.focus();
	};

	onMount(() => {
		dialog?.showModal();
		focusStart();
		void load();
	});
	// The lists arrive after the dialog opened: focus moves to the first one
	// then, unless the owner already moved it inside the dialog.
	createEffect(
		on(
			() => watchlist() !== null,
			(loaded) => {
				if (loaded && document.activeElement === cancelButton) focusStart();
			},
			{ defer: true },
		),
	);
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			aria-describedby={introId}
			class="m-auto w-full max-w-md rounded bg-slate-100 p-4"
			data-watchlist-list-dialog=""
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				{m().chooseHeading}
			</h3>
			<p id={introId} class="mt-1 text-xs text-slate-700">
				{m().chooseIntro}
			</p>
			<div class="mt-2 space-y-2">
				<Show when={failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().listsLoadFailed}
							onRetry={() => void load()}
						/>
					)}
				</Show>
				<Show
					when={watchlist()}
					fallback={
						<Show when={failure() === null}>
							<output aria-busy="true" class="block text-sm text-slate-600">
								{common().loadingThing(m().listsThing)}
							</output>
						</Show>
					}
				>
					{(current) => (
						<Show
							when={current().lists.length > 0}
							fallback={
								<div class="space-y-1 rounded border border-dashed border-slate-300 px-3 py-2">
									<p class="text-sm text-slate-800">{m().chooseNoLists}</p>
									<a
										href={WATCHLIST_HASH}
										class={`${TASK_LINK} text-sm`}
										onClick={() => props.onClose()}
									>
										{m().openWatchlist}
									</a>
								</div>
							}
						>
							<ul
								ref={(element) => {
									list = element;
								}}
								aria-label={m().chooseList}
								class="max-h-80 space-y-1 overflow-y-auto"
							>
								<For each={current().lists}>
									{(entry) => (
										<li>
											<button
												type="button"
												class="flex min-h-11 w-full flex-col items-start rounded bg-white px-3 py-2 text-left hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
												disabled={saving()}
												data-list-id={entry.listId}
												onClick={() => void choose(entry)}
											>
												<span class="break-words text-sm font-medium text-slate-900">
													{entry.title}
												</span>
												<span class="text-xs text-slate-700">
													{counts().stockCount(entry.stockIds.length)}
												</span>
											</button>
										</li>
									)}
								</For>
							</ul>
						</Show>
					)}
				</Show>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					ref={(element) => {
						cancelButton = element;
					}}
					type="button"
					class={BUTTON}
					onClick={() => close()}
				>
					{common().cancel}
				</button>
			</div>
		</dialog>
	);
}
