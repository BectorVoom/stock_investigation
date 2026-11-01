import { type EquityCompanyView, formatStockId, type WatchlistStock } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ConfirmDialog, ErrorNotice, Notice } from "../components/ui.tsx";
import { companyName } from "../equities/equitiesModel.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createClock } from "../tasks/clock.ts";
import { createStockDirectoryState } from "../watchlist/stockDirectory.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { storedDirectoryMarkets, watchlistStatusText } from "../watchlist/watchlistModel.ts";
import { type Outcome, OutcomeNotice } from "./Outcome.tsx";
import { StockListSection } from "./StockListSection.tsx";
import type { StockRowHandlers } from "./StockTable.tsx";
import { createStockRegistry } from "./stockRegistry.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockRow } from "./stocksModel.ts";

/**
 * The Registered stocks page (ADR-0049 §2, ADR-0050 §4): one list over the
 * watchlist's stocks and the companies whose statements are synced, with
 * the Watchlist's list tabs and earnings dates (synced by the server) and each row's financial
 * statements actions. The market stock lists the Stocks page's search reads
 * are downloaded in the background when missing or old (once per visit);
 * the page no longer shows them (the 銘柄一覧 area was removed at the owner's
 * request).
 * Stocks are added from the Stocks page (its search and Add to Watchlist)
 * or a list's Add stock dialog; this page has no add form. A row's name
 * opens the stock on the Stocks page; nothing here reads a stock's chart,
 * statements or news.
 */
export function RegisteredStocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const listText = useMessages(watchlistListsMessages);
	const model = useMessages(watchlistModelMessages);
	const now = createClock();

	const registry = createStockRegistry({
		api: props.api,
		visibility: props.visibility,
		automaticRuns: true,
	});
	const { watch, companies } = registry;
	const directory = createStockDirectoryState({
		api: props.api,
		visibility: props.visibility,
	});
	onCleanup(() => directory.dispose());
	onMount(() => {
		directory.start();
		registry.start();
	});

	/** What the last companies action said (sync, track, stop tracking). */
	const [outcome, setOutcome] = createSignal<Outcome | null>(null);
	const [removing, setRemoving] = createSignal<WatchlistStock | null>(null);
	const [untracking, setUntracking] = createSignal<EquityCompanyView | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);

	/* ---------- Companies actions ---------- */

	const confirmUntrack = async (): Promise<void> => {
		const company = untracking();
		if (company === null || companies.busy().has(company.companyId)) return;
		const answer = await companies.untrack(company);
		setUntracking(null);
		opener()?.focus();
		setOutcome(
			answer.ok
				? { kind: "notice", tone: "success", text: s().untracked(companyName(company)) }
				: { kind: "failure", title: s().untrackFailed, error: answer.error },
		);
	};
	const handlers = (): Omit<StockRowHandlers, "busy"> => ({
		companyBusy: (row) => registry.stockBusy(row.stockId),
		atTrackLimit: companies.atLimit(),
		nowMs: now,
		companiesKnown: companies.companies() !== null,
		watchlistKnown: watch.data() !== null,
		onAddToWatchlist: (row) => void addToWatchlist(row),
		onSyncNow: (company) => void registry.syncOutcome(company).then(setOutcome),
		onTrack: (row) => void registry.trackOutcome(row.stockId).then(setOutcome),
		onUntrack: (company, from) => {
			setOpener(from);
			setUntracking(company);
		},
	});

	/* ---------- Watchlist actions ---------- */

	/** A tracked-only stock's "Add to Watchlist": the watchlist write, then the announcement. */
	const addToWatchlist = async (row: StockRow): Promise<void> => {
		if (await watch.addStock(row.market, row.symbol)) {
			await watch.afterStockWatched(s().addedToWatchlist(row.symbol));
		}
	};
	const confirmRemove = async (): Promise<void> => {
		const target = removing();
		if (target === null) return;
		await watch.removeStock(target);
		setRemoving(null);
		opener()?.focus();
	};
	/** How many lists a stock leaves when it is removed from the watchlist. */
	const listsLeft = (stock: WatchlistStock): number =>
		registry.listTitles().get(stock.stockId)?.length ?? 0;

	return (
		<div class="space-y-3" data-page="registered">
			<Show when={watch.failure()}>
				{(current) => (
					<ErrorNotice
						failure={current().error}
						title={current().title}
						onRetry={current().retry}
					/>
				)}
			</Show>
			<Show when={watch.notice()}>
				{(current) => <Notice tone="info">{current().text}</Notice>}
			</Show>
			<Show when={companies.failure()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={s().companiesFailed}
						onRetry={() => companies.pollNow()}
					/>
				)}
			</Show>
			<OutcomeNotice outcome={outcome()} field="stocks-outcome" />

			<StockListSection
				api={props.api}
				data={watch.data}
				rows={registry.rows}
				loading={watch.loading}
				handlers={handlers}
				pageBusy={watch.busy}
				storedMarkets={() => storedDirectoryMarkets(directory.status())}
				statusText={() => {
					const current = watch.data();
					return current === null ? null : watchlistStatusText(current, model());
				}}
				onRemoveFromWatchlist={(stock, from) => {
					setOpener(from);
					setRemoving(stock);
				}}
				onWritten={watch.reloadAfterWrite}
				onStockWatched={watch.afterStockWatched}
			/>

			<Show when={removing()}>
				{(stock) => (
					<ConfirmDialog
						title={m().removeTitle(stock().symbol)}
						opener={opener()}
						confirmLabel={m().removeStock}
						pending={watch.busy()}
						failure={null}
						onConfirm={() => void confirmRemove()}
						onCancel={() => {
							setRemoving(null);
							opener()?.focus();
						}}
					>
						{m().removeBody(stock().symbol)}
						<Show when={listsLeft(stock()) > 0}>
							{" "}
							<span data-field="remove-leaves-lists">
								{listText().alsoLeavesLists(listsLeft(stock()))}
							</span>
						</Show>
					</ConfirmDialog>
				)}
			</Show>
			<Show when={untracking()}>
				{(company) => (
					<ConfirmDialog
						title={s().untrackHeading(companyName(company()))}
						opener={opener()}
						confirmLabel={s().untrackConfirm}
						pending={companies.busy().has(company().companyId)}
						failure={null}
						onConfirm={() => void confirmUntrack()}
						onCancel={() => setUntracking(null)}
					>
						<p>
							{s().untrackBody}{" "}
							{registry.rowsById().get(formatStockId(company().market, company().symbol))?.watchlist
								? s().untrackStaysOnWatchlist
								: s().untrackLeavesList}
						</p>
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);
}
