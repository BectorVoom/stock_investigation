import type { EquityBusinessSource, StockTab } from "@research/contracts";
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

/**
 * The Registered stocks page's list over the watchlist and the companies
 * whose statements are synced, and the Stocks page's tab strip and its
 * Financial statements and Company tabs (ADR-0049). Tickers, codes, company
 * names and dates stay as they are; the Watchlist's own words (earnings
 * dates, lists, the add form) stay in the watchlist catalogs and the
 * statements' words in the financials catalogs. A business description's
 * paragraphs are the filing's own words and are never translated
 * (ADR-0053 §6); only the words around them are here.
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
			"No stocks yet. Find a US or Japanese stock on the Stocks page and add it to the Watchlist to follow its earnings dates and financial statements.",
		stockListsTitle: "Market stock lists",
		stockListsHint:
			"The stored lists of US and Japanese listed stocks that the Stocks page's search reads. A missing or old list downloads when this page opens.",
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
		atLimit: (max: number): string =>
			`Statements are synced for ${max} companies, the most there can be. Stop syncing one to sync another.`,
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
		nameEnglish: "Name (English)",
		nameJapanese: "Name (Japanese)",
		symbol: "Symbol",
		market: "Market",
		listing: "Listing",
		stockId: "Stock id",
		notInDirectory: "Not in the stored stock list",
		profileThing: "the stock's stored listing",
		profileFailed: "Could not load the stock's stored company information.",
		notKnownYet: "Not known yet",
		lists: "Lists",

		/* ----- Company tab: Business (ADR-0053 §6) ----- */
		businessHeading: "Business",
		/** The report a description was read from; the dates come formatted. */
		businessSource: (
			form: EquityBusinessSource["form"],
			periodEnd: string,
			filedOn: string,
		): string =>
			form === "10-K"
				? `From the 10-K for the fiscal year ended ${periodEnd}, filed ${filedOn}.`
				: `From the annual securities report (有価証券報告書) for the fiscal year ended ${periodEnd}, filed ${filedOn}.`,
		viewFiling: "View filing",
		showMore: "Show more",
		showLess: "Show less",
		businessContinues: "The section continues in the filing.",
		businessPending: "The business description arrives with the next financial statements sync.",
		businessNotTracked:
			"Business descriptions come from annual reports, read when this company's financial statements are synced.",
		openFinancials: "Open Financial statements",
		businessNotFound: "The newest annual report has no business section that could be read.",
	},
	ja: {
		tableCaption: "登録銘柄: ウォッチリスト、続いて財務諸表を同期している企業",
		financialsColumn: "財務諸表",
		notSynced: "未同期",
		notOnWatchlist: "ウォッチリスト外",
		notLoaded: "未読み込み",
		showUnnamed: (symbol) => `${symbol} を表示`,
		noStocks:
			"銘柄はまだありません。株式データのページで米国株または日本株を探してウォッチリストに追加すると、決算発表日と財務諸表を確認できます。",
		stockListsTitle: "銘柄一覧",
		stockListsHint:
			"株式データのページの検索が使う、保存済みの米国・日本の上場銘柄一覧です。一覧がない、または古い場合は、このページを開いたときに取得します。",
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
		atLimit: (max) =>
			`財務諸表を同期できる上限の ${max} 社に達しています。別の企業を同期するには、どれかの同期を停止してください。`,
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
		nameEnglish: "名称（英語）",
		nameJapanese: "名称（日本語）",
		symbol: "銘柄コード",
		market: "市場",
		listing: "上場区分",
		stockId: "銘柄 ID",
		notInDirectory: "保存済みの銘柄一覧にありません",
		profileThing: "保存済みの上場情報",
		profileFailed: "保存済みの企業情報を読み込めませんでした。",
		notKnownYet: "未確認",
		lists: "リスト",

		businessHeading: "事業内容",
		businessSource: (form, periodEnd, filedOn) =>
			form === "10-K"
				? `${periodEnd}期の年次報告書（Form 10-K、${filedOn}提出）より。`
				: `${periodEnd}期の有価証券報告書（${filedOn}提出）より。`,
		viewFiling: "書類を見る",
		showMore: "さらに表示",
		showLess: "表示を減らす",
		businessContinues: "続きは書類をご覧ください。",
		businessPending: "事業内容は次回の財務諸表の同期で取得されます。",
		businessNotTracked:
			"事業内容は年次報告書から、この企業の財務諸表を同期するときに読み取ります。",
		openFinancials: "財務諸表を開く",
		businessNotFound: "最新の年次報告書には、読み取れる事業内容の記載がありませんでした。",
	},
});
