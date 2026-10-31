import type { StockTab } from "@research/contracts";
import type { EquityProvider } from "@research/domain";
import { defineMessages } from "@research/i18n";

const EN_TABS: { readonly [T in StockTab]: string } = {
	chart: "Chart",
	financials: "Financial statements",
	company: "Company",
	news: "News",
};

const JA_TABS: { readonly [T in StockTab]: string } = {
	chart: "チャート",
	financials: "財務諸表",
	company: "企業情報",
	news: "ニュース",
};

const EN_FILER_SITE: { readonly [P in EquityProvider]: string } = {
	sec: "SEC EDGAR",
	edinet: "EDINET",
};

/**
 * The Registered stocks page's list over the watchlist and the companies
 * whose statements are synced, and the Stocks page's tab strip and its
 * Financial statements and Company tabs (ADR-0049). Tickers, codes, company
 * names and dates stay as they are; the Watchlist's own words (earnings
 * dates, lists, the add form) stay in the watchlist catalogs and the
 * statements' words in the financials catalogs.
 */
export const stocksMessages = defineMessages({
	en: {
		/* ----- the list ----- */
		tableCaption: "Your stocks: the watchlist, then the companies whose statements are synced",
		financialsColumn: "Financials",
		notSynced: "Not synced",
		notOnWatchlist: "Not on Watchlist",
		/** A cell whose list could not be read (the page says why, once). */
		notLoaded: "Not loaded",
		/** A row's Show button when no stored name is known yet. */
		showUnnamed: (symbol: string): string => `Show ${symbol}`,
		noStocks:
			"No stocks yet. Add a US or Japanese stock above to follow its earnings dates and financial statements.",
		syncedCount: (count: number, max: number): string =>
			`Statements synced for ${count} of ${max} companies`,
		companiesFailed: "Could not load the companies whose statements are synced.",
		addToWatchlist: "Add to Watchlist",
		addToWatchlistNamed: (symbol: string): string => `Add ${symbol} to the Watchlist`,
		addedToWatchlist: (symbol: string): string =>
			`Added ${symbol} to the Watchlist. Its earnings dates are being fetched by the local runner.`,
		stockActions: (symbol: string): string => `More actions for ${symbol}`,
		stockMenu: (symbol: string): string => `${symbol} actions`,
		syncFinancialsNow: "Sync financials now",
		trackFinancials: "Sync financial statements",
		untrackFinancials: "Stop syncing financial statements",
		untrackHeading: (name: string): string => `Stop syncing the statements of ${name}?`,
		untrackBody:
			"Its statements are no longer synced. Its stored filings and values are kept: syncing it again shows them at once.",
		untrackStaysOnWatchlist: "It stays on the Watchlist.",
		untrackLeavesList: "It is not on the Watchlist, so it leaves this list.",
		untrackConfirm: "Stop syncing",
		untracked: (name: string): string =>
			`Stopped syncing the statements of ${name}. Its stored data is kept.`,
		untrackFailed: "The statements were not stopped from syncing.",
		tracked: (name: string): string =>
			`Syncing the statements of ${name}. Its first sync runs when the local runner next claims work.`,
		trackFailed: "The financial statements were not set to sync.",
		/** The add form's second write failed after the first succeeded. */
		addedNotTracked: (symbol: string): string =>
			`${symbol} was added to the Watchlist, but its financial statements were not set to sync.`,
		atLimit: (max: number): string =>
			`Statements are synced for ${max} companies, the most there can be. Stop syncing one to sync another.`,
		alsoSync: "Also sync annual financial statements",
		alsoSyncHint: "From SEC EDGAR (US) or EDINET (Japan), by the local runner.",

		/* ----- the detail ----- */
		chooseStock:
			"No stock is shown. Search for one above, or choose one on the Registered stocks page, to see its chart, financial statements, company information and news.",

		/* ----- the search area and Add to Watchlist (ADR-0050) ----- */
		searchTitle: "Find a stock",
		searchHint:
			"Search the stored US and Japanese stock lists by company name or symbol, and pick a stock to open it.",
		onWatchlistStatus: "On the Watchlist",
		addToList: "Add to a list",
		addToListsHeading: (symbol: string): string => `Add ${symbol} to lists`,
		addIntro:
			"It goes on the Watchlist. Tick the lists to add it to as well, or none to put it on the Watchlist only.",
		addIntroWatched: "It is on the Watchlist. Tick the lists to add it to.",
		alreadyInList: "Already in this list",
		listIsFull: "Full",
		noListsYet: "You have no lists yet. Lists are made on the Registered stocks page.",
		addConfirm: "Add",
		notAddedToWatchlist: (symbol: string): string => `${symbol} was not added to the Watchlist.`,
		addedToLists: (symbol: string, lists: string): string => `Added ${symbol} to ${lists}.`,
		addedToWatchlistAndLists: (symbol: string, lists: string): string =>
			`Added ${symbol} to the Watchlist and to ${lists}. Its earnings dates are being fetched by the local runner.`,
		openRegistered: "Open Registered stocks",
		chooseOtherStock: "Choose another stock",
		detailHeading: (name: string, symbol: string): string => `${name} · ${symbol}`,
		tabsLabel: (name: string): string => `Data of ${name}`,
		tab: (tab: StockTab): string => EN_TABS[tab],
		/** The noun in "Loading <thing>…" while a tab's code downloads. */
		tabThing: (tab: StockTab): string => `the ${EN_TABS[tab]} tab`,
		tabFailed: "This tab could not be loaded.",

		/* ----- Financial statements tab ----- */
		notTrackedBody: "Annual financial statements are not synced for this stock.",
		financialsUnknown:
			"Whether this stock's statements are synced is not known: the companies could not be loaded.",
		filingsDisclosure: (count: number): string => `Filings (${count})`,
		syncLabel: "Sync",

		/* ----- Company tab ----- */
		listingHeading: "Listing",
		filerHeading: "Filer",
		keyFiguresHeading: "Key figures",
		workspaceHeading: "On this workspace",
		nameEnglish: "Name (English)",
		nameJapanese: "Name (Japanese)",
		symbol: "Symbol",
		market: "Market",
		listing: "Listing",
		stockId: "Stock id",
		notInDirectory: "Not in the stored stock list",
		profileThing: "the stock's stored listing",
		profileFailed: "Could not load the stock's stored listing.",
		filerSite: (provider: EquityProvider): string => `Open the filer on ${EN_FILER_SITE[provider]}`,
		/** An EDINET code is shown as text: no link to a filer's EDINET page is built here. */
		edinetNoLink: "Search this code on EDINET to open the filer.",
		fiscalYearEnd: "Fiscal year end",
		latestFiscalYear: "Newest fiscal year",
		filingsStored: "Annual filings stored",
		lastSync: "Last sync",
		notResolved: "Not resolved yet: the first sync resolves it",
		neverSynced: "Not synced yet",
		notKnownYet: "Not known yet",
		filerNotTracked:
			"Statements are not synced for this stock, so its filer and key figures are not stored.",
		openFinancials: "Open Financial statements",
		keyFiguresIntro: (year: string): string => `${year}, from the stored annual statements.`,
		keyFiguresNone: "No values are stored yet. They appear after the company's first sync.",
		keyFiguresThing: "the key figures",
		keyFiguresFailed: "Could not load the key figures.",
		keyFigureValue: (value: string, unit: string): string => `${value} ${unit}`,
		onWatchlistSince: "On the Watchlist since",
		notOnWatchlistLong: "Not on the Watchlist",
		lists: "Lists",
		noLists: "In no list",
		nextEarnings: "Next earnings announcement",
		noUpcomingEarnings: "No upcoming announcement is stored",
	},
	ja: {
		tableCaption: "登録銘柄: ウォッチリスト、続いて財務諸表を同期している企業",
		financialsColumn: "財務諸表",
		notSynced: "未同期",
		notOnWatchlist: "ウォッチリスト外",
		notLoaded: "未読み込み",
		showUnnamed: (symbol) => `${symbol} を表示`,
		noStocks:
			"銘柄はまだありません。上で米国株または日本株を追加すると、決算発表日と財務諸表を確認できます。",
		syncedCount: (count, max) => `財務諸表の同期: ${max} 社中 ${count} 社`,
		companiesFailed: "財務諸表を同期している企業を読み込めませんでした。",
		addToWatchlist: "ウォッチリストに追加",
		addToWatchlistNamed: (symbol) => `${symbol} をウォッチリストに追加`,
		addedToWatchlist: (symbol) =>
			`${symbol} をウォッチリストに追加しました。決算発表日はローカルランナーが取得中です。`,
		stockActions: (symbol) => `${symbol} のその他の操作`,
		stockMenu: (symbol) => `${symbol} の操作`,
		syncFinancialsNow: "今すぐ財務諸表を同期",
		trackFinancials: "財務諸表を同期する",
		untrackFinancials: "財務諸表の同期を停止",
		untrackHeading: (name) => `${name} の財務諸表の同期を停止しますか？`,
		untrackBody:
			"財務諸表は同期されなくなります。保存済みの提出書類と値は残り、再び同期するとすぐに表示されます。",
		untrackStaysOnWatchlist: "ウォッチリストには残ります。",
		untrackLeavesList: "ウォッチリストにないため、この一覧から外れます。",
		untrackConfirm: "同期を停止",
		untracked: (name) => `${name} の財務諸表の同期を停止しました。保存済みのデータは残っています。`,
		untrackFailed: "財務諸表の同期を停止できませんでした。",
		tracked: (name) =>
			`${name} の財務諸表を同期します。最初の同期はローカルランナーが次に処理を受け取ったときに実行されます。`,
		trackFailed: "財務諸表の同期を設定できませんでした。",
		addedNotTracked: (symbol) =>
			`${symbol} をウォッチリストに追加しましたが、財務諸表の同期は設定できませんでした。`,
		atLimit: (max) =>
			`財務諸表を同期できる上限の ${max} 社に達しています。別の企業を同期するには、どれかの同期を停止してください。`,
		alsoSync: "年次の財務諸表も同期する",
		alsoSyncHint: "SEC EDGAR（米国）または EDINET（日本）から、ローカルランナーが取得します。",

		chooseStock:
			"表示中の銘柄はありません。上で銘柄を検索するか、登録済みの銘柄のページで選ぶと、株価チャート・財務諸表・企業情報・ニュースを表示します。",

		searchTitle: "銘柄を探す",
		searchHint:
			"保存済みの米国・日本の銘柄一覧を会社名または銘柄コードで検索し、選んだ銘柄を開きます。",
		onWatchlistStatus: "ウォッチリストに登録済み",
		addToList: "リストに追加",
		addToListsHeading: (symbol) => `${symbol} をリストに追加`,
		addIntro:
			"ウォッチリストに登録します。あわせて追加するリストにチェックを入れてください。チェックしなければウォッチリストだけに登録します。",
		addIntroWatched: "ウォッチリストに登録済みです。追加するリストにチェックを入れてください。",
		alreadyInList: "このリストに追加済み",
		listIsFull: "上限",
		noListsYet: "リストはまだありません。リストは登録済みの銘柄のページで作成できます。",
		addConfirm: "追加",
		notAddedToWatchlist: (symbol) => `${symbol} をウォッチリストに追加できませんでした。`,
		addedToLists: (symbol, lists) => `${symbol} を ${lists} に追加しました。`,
		addedToWatchlistAndLists: (symbol, lists) =>
			`${symbol} をウォッチリストと ${lists} に追加しました。決算発表日はローカルランナーが取得中です。`,
		openRegistered: "登録済みの銘柄を開く",
		chooseOtherStock: "別の銘柄を選ぶ",
		detailHeading: (name, symbol) => `${name} · ${symbol}`,
		tabsLabel: (name) => `${name} のデータ`,
		tab: (tab) => JA_TABS[tab],
		tabThing: (tab) => `${JA_TABS[tab]}タブ`,
		tabFailed: "このタブを読み込めませんでした。",

		notTrackedBody: "この銘柄の年次財務諸表は同期されていません。",
		financialsUnknown:
			"財務諸表を同期している企業を読み込めなかったため、この銘柄の財務諸表が同期されているかはわかりません。",
		filingsDisclosure: (count) => `提出書類（${count} 件）`,
		syncLabel: "同期",

		listingHeading: "上場情報",
		filerHeading: "提出者",
		keyFiguresHeading: "主要な数値",
		workspaceHeading: "このワークスペースでの状態",
		nameEnglish: "名称（英語）",
		nameJapanese: "名称（日本語）",
		symbol: "銘柄コード",
		market: "市場",
		listing: "上場区分",
		stockId: "銘柄 ID",
		notInDirectory: "保存済みの銘柄一覧にありません",
		profileThing: "保存済みの上場情報",
		profileFailed: "保存済みの上場情報を読み込めませんでした。",
		filerSite: (provider) =>
			provider === "sec" ? "SEC EDGAR で提出者を開く" : "EDINET で提出者を開く",
		edinetNoLink: "EDINET でこのコードを検索すると提出者を表示できます。",
		fiscalYearEnd: "決算日",
		latestFiscalYear: "直近の会計年度",
		filingsStored: "保存済みの年次報告書",
		lastSync: "最終同期",
		notResolved: "未特定（最初の同期で特定されます）",
		neverSynced: "未同期",
		notKnownYet: "未確認",
		filerNotTracked:
			"この銘柄の財務諸表は同期されていないため、提出者と主要な数値は保存されていません。",
		openFinancials: "財務諸表を開く",
		keyFiguresIntro: (year) => `${year}、保存済みの年次財務諸表から。`,
		keyFiguresNone: "保存済みの値はまだありません。最初の同期の後に表示されます。",
		keyFiguresThing: "主要な数値",
		keyFiguresFailed: "主要な数値を読み込めませんでした。",
		keyFigureValue: (value, unit) => `${value} ${unit}`,
		onWatchlistSince: "ウォッチリストへの登録日",
		notOnWatchlistLong: "ウォッチリストにありません",
		lists: "リスト",
		noLists: "どのリストにも入っていません",
		nextEarnings: "次回の決算発表",
		noUpcomingEarnings: "今後の発表日は保存されていません",
	},
});
