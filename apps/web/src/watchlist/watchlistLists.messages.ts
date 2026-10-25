import { defineMessages } from "@research/i18n";

/**
 * The Watchlist page's Lists section and the add menu's list dialog
 * (ADR-0040 §6–7). List titles, symbols and company names are the owner's
 * data and never pass through here.
 */
export const watchlistListsMessages = defineMessages({
	en: {
		sectionTitle: "Lists",
		sectionHint:
			"Group watchlist stocks into titled lists. Show a list on Home or in a Notebook to see each stock's change from the previous close.",
		newList: "New list",
		newListHeading: "New list",
		titleLabel: "Title",
		titleHint: (max: number) => `1 to ${max} characters.`,
		createList: "Create list",
		save: "Save",
		noLists: "No lists yet. Make one with New list.",
		/** A list card's count: how many of the most it may hold. */
		stockCountOf: (count: number, max: number) => `${count} of ${max} stocks`,
		listActions: (title: string) => `Actions for ${title}`,
		listMenu: (title: string) => `${title} actions`,
		listCard: (title: string) => `List: ${title}`,
		rename: "Rename…",
		renameHeading: (title: string) => `Rename ${title}`,
		showOnHome: "Show on Home",
		deleteItem: "Delete…",
		deleteHeading: (title: string) => `Delete ${title}?`,
		deleteBody:
			"The list is deleted; its stocks stay on the watchlist. A widget that shows it says the list was deleted. This cannot be undone.",
		deleteList: "Delete list",
		emptyList: "No stocks in this list yet.",
		listStocks: (title: string) => `Stocks in ${title}`,
		removeFromList: "Remove from list",
		removeFromListNamed: (symbol: string, title: string) => `Remove ${symbol} from ${title}`,
		addStock: "Add stock",
		addStockNamed: (title: string) => `Add stocks to ${title}`,
		addHeading: (title: string) => `Add stocks to ${title}`,
		watchedStocks: "Stocks on your watchlist",
		noOtherWatched: "Every watchlist stock is already in this list.",
		searchHeading: "A stock not on your watchlist",
		searchHint: "Adding it also adds it to the watchlist, so its earnings dates are tracked too.",
		addChosen: (count: number) =>
			count === 0 ? "Add to list" : `Add ${count} stock${count === 1 ? "" : "s"} to list`,
		roomLeft: (count: number) => `Room for ${count} more stock${count === 1 ? "" : "s"}.`,
		tooManyChosen: (room: number) =>
			`Choose at most ${room} stock${room === 1 ? "" : "s"}: the list has room for no more.`,
		listFull: (max: number) => `This list is full: a list holds at most ${max} stocks.`,
		listsFull: (max: number) =>
			`You have ${max} lists, the most there can be. Delete one to make another.`,
		watchlistFull: (max: number) =>
			`The watchlist is full (${max} stocks): remove a stock from it before adding a new one.`,
		changedElsewhere:
			"The list or the stock changed elsewhere, so the page now shows the current lists.",
		titleProblem: (max: number) => `Enter a title of 1 to ${max} characters.`,
		inLists: (titles: string) => `In lists: ${titles}`,
		alsoLeavesLists: (count: number) =>
			`Also removes it from ${count} list${count === 1 ? "" : "s"}.`,

		created: (title: string) => `Created ${title}.`,
		renamed: (title: string) => `Renamed the list to ${title}.`,
		deleted: (title: string) => `Deleted ${title}.`,
		addedToList: (symbols: string, title: string) => `Added ${symbols} to ${title}.`,
		addedToListAndWatchlist: (symbol: string, title: string) =>
			`Added ${symbol} to ${title} and to the watchlist. Its earnings dates are being fetched by the local runner.`,
		removedFromList: (symbol: string, title: string) => `Removed ${symbol} from ${title}.`,
		notCreated: "The list was not created.",
		notRenamed: "The list was not renamed.",
		notDeleted: "The list was not deleted.",
		notAdded: "The stock was not added to the list.",
		notAddedNamed: (symbol: string) => `${symbol} was not added to the list.`,
		addedToWatchlistOnly: (symbol: string, title: string) =>
			`${symbol} was added to the watchlist but not to ${title}. Its earnings dates are being fetched by the local runner.`,
		notRemoved: "The stock was not removed from the list.",
		shownOnHome: (title: string) => `Added ${title} to Home.`,
		alreadyOnHome: (title: string) => `${title} is already on Home.`,
		notShownOnHome: "The list was not added to Home.",
		homeTooManyWidgets: (max: number) =>
			`Home already holds ${max} widgets, the most it can. Remove one there first.`,
		homeTooManySeries: (max: number) =>
			`Home already shows ${max} price series, the most it can. Remove a widget there first.`,
		homeTooLarge: (kilobytes: number) =>
			`Home's widgets would exceed ${kilobytes} KB. Remove a widget there first.`,

		// The add menu's dialog.
		chooseHeading: "Choose a list",
		chooseIntro:
			"The widget shows the list's stocks with each one's last close and its change from the previous close.",
		chooseList: "Your Watchlist lists",
		chooseNoLists: "You have no Watchlist lists yet.",
		openWatchlist: "Make one on the Watchlist page",
		/** The noun in "Loading your lists…". */
		listsThing: "your lists",
		listsLoadFailed: "Your lists did not load.",
	},
	ja: {
		sectionTitle: "リスト",
		sectionHint:
			"ウォッチリストの銘柄を名前付きのリストにまとめます。リストをホームやノートブックに表示すると、銘柄ごとの前日終値からの変化が見られます。",
		newList: "新しいリスト",
		newListHeading: "新しいリスト",
		titleLabel: "名前",
		titleHint: (max) => `1〜${max} 文字。`,
		createList: "リストを作成",
		save: "保存",
		noLists: "リストはまだありません。「新しいリスト」で作成できます。",
		stockCountOf: (count, max) => `${count} / ${max} 銘柄`,
		listActions: (title) => `${title} の操作`,
		listMenu: (title) => `${title} の操作メニュー`,
		listCard: (title) => `リスト：${title}`,
		rename: "名前を変更…",
		renameHeading: (title) => `${title} の名前を変更`,
		showOnHome: "ホームに表示",
		deleteItem: "削除…",
		deleteHeading: (title) => `${title} を削除しますか？`,
		deleteBody:
			"リストを削除します。銘柄はウォッチリストに残ります。このリストを表示しているウィジェットには、リストが削除されたと表示されます。元に戻せません。",
		deleteList: "リストを削除",
		emptyList: "このリストにはまだ銘柄がありません。",
		listStocks: (title) => `${title} の銘柄`,
		removeFromList: "リストから外す",
		removeFromListNamed: (symbol, title) => `${symbol} を ${title} から外す`,
		addStock: "銘柄を追加",
		addStockNamed: (title) => `${title} に銘柄を追加`,
		addHeading: (title) => `${title} に銘柄を追加`,
		watchedStocks: "ウォッチリストの銘柄",
		noOtherWatched: "ウォッチリストの銘柄はすべてこのリストに入っています。",
		searchHeading: "ウォッチリストにない銘柄",
		searchHint: "追加するとウォッチリストにも追加され、決算発表日も追跡されます。",
		addChosen: (count) => (count === 0 ? "リストに追加" : `${count} 銘柄をリストに追加`),
		roomLeft: (count) => `あと ${count} 銘柄を追加できます。`,
		tooManyChosen: (room) =>
			`選べるのは ${room} 銘柄までです。リストにそれ以上の空きはありません。`,
		listFull: (max) => `このリストはいっぱいです。1 つのリストには ${max} 銘柄まで入ります。`,
		listsFull: (max) => `リストは ${max} 個までです。新しく作るには、どれかを削除してください。`,
		watchlistFull: (max) =>
			`ウォッチリストはいっぱいです（${max} 銘柄）。新しい銘柄を追加する前に、どれかを外してください。`,
		changedElsewhere: "リストまたは銘柄が別の場所で変更されたため、現在のリストを表示しています。",
		titleProblem: (max) => `名前は 1〜${max} 文字で入力してください。`,
		inLists: (titles) => `リスト：${titles}`,
		alsoLeavesLists: (count) => `${count} 個のリストからも外れます。`,

		created: (title) => `${title} を作成しました。`,
		renamed: (title) => `リストの名前を ${title} に変更しました。`,
		deleted: (title) => `${title} を削除しました。`,
		addedToList: (symbols, title) => `${symbols} を ${title} に追加しました。`,
		addedToListAndWatchlist: (symbol, title) =>
			`${symbol} を ${title} とウォッチリストに追加しました。決算発表日はローカルランナーが取得中です。`,
		removedFromList: (symbol, title) => `${symbol} を ${title} から外しました。`,
		notCreated: "リストを作成できませんでした。",
		notRenamed: "リストの名前を変更できませんでした。",
		notDeleted: "リストを削除できませんでした。",
		notAdded: "銘柄をリストに追加できませんでした。",
		notAddedNamed: (symbol) => `${symbol} をリストに追加できませんでした。`,
		addedToWatchlistOnly: (symbol, title) =>
			`${symbol} はウォッチリストに追加されましたが、${title} には追加されませんでした。決算発表日はローカルランナーが取得中です。`,
		notRemoved: "銘柄をリストから外せませんでした。",
		shownOnHome: (title) => `${title} をホームに追加しました。`,
		alreadyOnHome: (title) => `${title} はすでにホームにあります。`,
		notShownOnHome: "リストをホームに追加できませんでした。",
		homeTooManyWidgets: (max) =>
			`ホームのウィジェットはすでに上限の ${max} 個です。先にホームでどれかを削除してください。`,
		homeTooManySeries: (max) =>
			`ホームはすでに上限の ${max} 件の価格系列を表示しています。先にホームでウィジェットを削除してください。`,
		homeTooLarge: (kilobytes) =>
			`ホームのウィジェットが ${kilobytes} KB を超えます。先にホームでどれかを削除してください。`,

		chooseHeading: "リストを選択",
		chooseIntro:
			"ウィジェットには、選んだリストの銘柄ごとに終値と前日終値からの変化が表示されます。",
		chooseList: "ウォッチリストのリスト",
		chooseNoLists: "ウォッチリストのリストはまだありません。",
		openWatchlist: "ウォッチリストのページで作成",
		listsThing: "リスト",
		listsLoadFailed: "リストを読み込めませんでした。",
	},
});
