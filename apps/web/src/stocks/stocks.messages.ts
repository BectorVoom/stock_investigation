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
 * The Registered stocks page's stock lists section, and the Stocks page's
 * tab strip, its Watchlist control and its Financial statements and
 * Company tabs (ADR-0049, ADR-0050, ADR-0054, ADR-0058, ADR-0059). Tickers,
 * codes, company names, J-Quants' sector and segment names and dates stay as
 * they are; the Watchlist's own words (earnings
 * dates, lists) stay in the watchlist catalogs and the
 * statements' words in the financials catalogs. A business description's
 * paragraphs are the filing's own words and are never translated
 * (ADR-0053 §6); only the words around them are here.
 */
export const stocksMessages = defineMessages({
	en: {
		/** A row's name link when no stored name is known yet. */
		showUnnamed: (symbol: string): string => `Show ${symbol}`,
		addToWatchlist: "Add to Watchlist",
		addToWatchlistNamed: (symbol: string): string => `Add ${symbol} to the Watchlist`,
		addedToWatchlist: (symbol: string): string =>
			`Added ${symbol} to the Watchlist. Its earnings dates are being fetched by the local runner.`,
		removeFromWatchlist: "Remove from Watchlist",
		sourceHint: "Source: SEC EDGAR (US) or earnings summaries (決算短信) via J-Quants (Japan).",

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
		/** A listed stock whose statements the server has not stored yet (ADR-0058 §3). */
		notStoredYetBody:
			"No financial statements are stored for this stock yet. The server fetches the statements of every listed stock; they appear here once stored.",
		/** A stock outside the stored stock lists: the server never fetches its statements. */
		notListedBody:
			"No financial statements are stored for this stock. The server fetches the statements of the stocks in the stored US and Japanese stock lists, and this stock is not in them.",
		/** Stored statements of a company whose listing left the stored stock lists (ADR-0055, ADR-0058). */
		storedNotUpdatedBody:
			"These statements were stored earlier and are no longer updated: the stock is no longer in the stored stock lists.",
		/** Stored statements of an untracked company that is listed again, before the server tracks it. */
		storedUpdatingBody:
			"These statements were stored earlier. The server updates them by itself; newer statements appear here once stored.",
		filingsDisclosure: (count: number): string => `Filings (${count})`,

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
		/** The SEC report a description was read from, named as filed; the dates come formatted. */
		businessSource: (
			form: EquityBusinessSource["form"],
			periodEnd: string,
			filedOn: string,
		): string => `From the ${form} for the fiscal year ended ${periodEnd}, filed ${filedOn}.`,
		viewFiling: "View filing",
		showMore: "Show more",
		showLess: "Show less",
		businessContinues: "The section continues in the filing.",
		businessPending:
			"No business description is stored yet. The server reads it from the annual report by itself; it appears here once stored.",
		/** A US stock outside the stored stock list (ADR-0058 §3: every listed US stock's description is read). */
		businessNotTracked:
			"No business description is stored for this stock. The server reads the descriptions of the stocks in the stored US stock list, and this stock is not in it.",
		businessNotFound: "The newest annual report has no business section that could be read.",

		/* ----- Company tab: a Japanese stock's J-Quants profile (ADR-0059 §3) ----- */
		companyProfileHeading: "Company profile",
		sector33: "Sector (33 sectors)",
		sector17: "Sector (17 sectors)",
		marketSegment: "Market segment",
		scaleCategory: "Scale category",
		/** J-Quants' "-": the issue is in no TOPIX scale category. */
		noScaleCategory: "None",
		/** The master's date, formatted. */
		companyProfileSource: (asOf: string): string =>
			`As of ${asOf}. Source: J-Quants (Listed Issue Master).`,
		companyProfileNone:
			"No company profile is stored for this stock yet. The server stores the profiles of Japanese stocks from J-Quants with the Japanese stock list; it appears here once stored.",

		/* ----- Company tab: 事業概要 — the company overview (ADR-0064) or the AI-written summary and themes (ADR-0060) ----- */
		summaryHeading: "Business overview",
		themesHeading: "Themes",
		/** Who wrote the summary and when; the date comes formatted. */
		summarySource: (agent: string, model: string | null, date: string): string =>
			`Written by AI (${model === null ? agent : `${agent}, ${model}`}) on ${date}. It may contain mistakes.`,
		summaryNone:
			"No description is written yet. The server asks the AI agent chosen in Settings → AI agent to write one for each Watchlist stock; it appears here once written.",
	},
	ja: {
		showUnnamed: (symbol) => `${symbol} を表示`,
		addToWatchlist: "ウォッチリストに追加",
		addToWatchlistNamed: (symbol) => `${symbol} をウォッチリストに追加`,
		addedToWatchlist: (symbol) =>
			`${symbol} をウォッチリストに追加しました。決算発表日はローカルランナーが取得中です。`,
		removeFromWatchlist: "ウォッチリストから削除",
		sourceHint: "出典: SEC EDGAR（米国）または J-Quants の決算短信（日本）。",

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

		notStoredYetBody:
			"この銘柄の財務諸表はまだ保存されていません。サーバーは上場しているすべての銘柄の財務諸表を取得します。保存されるとここに表示されます。",
		notListedBody:
			"この銘柄の財務諸表は保存されていません。サーバーは保存済みの米国・日本の銘柄一覧にある銘柄の財務諸表を取得しますが、この銘柄は一覧にありません。",
		storedNotUpdatedBody:
			"以前に保存した財務諸表です。この銘柄は保存済みの銘柄一覧から外れたため、更新されません。",
		storedUpdatingBody:
			"以前に保存した財務諸表です。サーバーが自動で更新し、新しい財務諸表は保存されるとここに表示されます。",
		filingsDisclosure: (count) => `提出書類（${count} 件）`,

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
			`${periodEnd}期の年次報告書（Form ${form}、${filedOn}提出）より。`,
		viewFiling: "書類を見る",
		showMore: "さらに表示",
		showLess: "表示を減らす",
		businessContinues: "続きは書類をご覧ください。",
		businessPending:
			"事業内容はまだ保存されていません。サーバーが年次報告書から自動で読み取り、保存されるとここに表示されます。",
		businessNotTracked:
			"この銘柄の事業内容は保存されていません。サーバーは保存済みの米国の銘柄一覧にある銘柄の事業内容を年次報告書から読み取りますが、この銘柄は一覧にありません。",
		businessNotFound: "最新の年次報告書には、読み取れる事業内容の記載がありませんでした。",

		companyProfileHeading: "企業概要",
		sector33: "業種（33 業種）",
		sector17: "業種（17 業種）",
		marketSegment: "市場区分",
		scaleCategory: "規模区分",
		noScaleCategory: "なし",
		companyProfileSource: (asOf) => `${asOf}時点。出典: J-Quants（上場銘柄一覧）。`,
		companyProfileNone:
			"この銘柄の企業概要はまだ保存されていません。サーバーは日本の銘柄一覧とあわせて J-Quants から日本株の企業概要を保存します。保存されるとここに表示されます。",

		summaryHeading: "事業概要",
		themesHeading: "テーマ",
		summarySource: (agent, model, date) =>
			`AI（${model === null ? agent : `${agent}、${model}`}）が ${date} に作成。誤りを含む場合があります。`,
		summaryNone:
			"説明はまだ作成されていません。サーバーが「設定 → AI エージェント」で選んだ AI エージェントにウォッチリストの各銘柄の説明を依頼します。作成されるとここに表示されます。",
	},
});
