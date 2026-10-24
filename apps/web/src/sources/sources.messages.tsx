import type { NewsSource } from "@research/contracts";
import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";
import { runStateMessages } from "../i18n/runState.messages.ts";

type LicensePolicy = NewsSource["licensePolicy"];
type TrustClassification = NewsSource["trustClassification"];
type FeedStatus = NewsSource["feedStatus"];

/**
 * The Sources page (ADR-0032). The stored enum values (`official`,
 * `headline-and-link-only`, `paused`…) are never translated; these messages
 * only word them. Recommended-catalog titles, publishers and rationales are
 * content from the server and stay as they are.
 */
export const sourcesMessages = defineMessages({
	en: {
		license: (policy: LicensePolicy): string =>
			({
				"headline-and-link-only": "Headline and link only (no excerpt stored)",
				"short-excerpt-permitted": "Short excerpt permitted",
			})[policy],
		trust: (trust: TrustClassification): string =>
			({
				official: "official",
				"established-media": "established-media",
				"trade-press": "trade-press",
				unclassified: "unclassified",
			})[trust],
		feedStatus: (status: FeedStatus): string =>
			({ active: "active", failing: "failing", paused: "paused" })[status],
		dateNotStated: "date not stated",
		published: "published",
		retrieved: "retrieved",

		previewRegion: "Source preview",
		previewHeading: (title: string) => `Preview: ${title}`,
		untitledFeed: "(untitled feed)",
		feedUrl: "Feed URL",
		type: "Type",
		site: "Site",
		siteNotStated: "not stated by the feed",
		suggestedPublisher: "Publisher (suggested)",
		notStated: "not stated",
		itemsFound: "Items found",
		itemsRejected: "Items rejected",
		rejectedCount: (count: number) => `${count} (unsafe or malformed links are never stored)`,
		sampleItems: "Sample items",
		noUsableItems: "The feed returned no usable items.",
		alreadySubscribed: "You already subscribe to this feed.",
		licensePolicy: "License policy",
		trustClassification: "Trust classification",
		subscribeToThisSource: "Subscribe to this source",
		discardPreview: "Discard preview",

		lastFetch: (when: string) => `Last fetch: ${when}`,
		neverFetched: "never fetched",
		lastError: "Last error:",
		pause: "Pause",
		pauseNamed: (title: string) => `Pause ${title}`,
		resume: "Resume",
		resumeNamed: (title: string) => `Resume ${title}`,
		removeNamed: (title: string) => `Remove ${title}`,

		recentArticles: "Recent articles",
		reloadArticles: "Reload articles",
		articlesLoadFailed: "Could not load articles.",
		noArticles: "No articles ingested yet. Subscribe to a source and choose “Refresh news now”.",
		articles: "Articles",
		/** The noun in "Loading articles…". */
		articlesThing: "articles",
		loadMoreArticles: "Load more articles",

		previewFailed: "The source could not be previewed.",
		subscribedTo: (title: string) => `Subscribed to “${title}”.`,
		notSubscribed: "The source was not subscribed.",
		notUpdated: "The source was not updated.",
		removed: (title: string) => `Removed “${title}”.`,
		notRemoved: "The source was not removed.",
		refreshNotQueued: "The news refresh was not queued.",

		addSourceTitle: "Add a news source by URL",
		addSourceLabel: "Add a source",
		addSourceHint:
			"The URL is checked and previewed first. Nothing is subscribed until you choose “Subscribe to this source”.",
		previewForm: "Preview a source",
		feedOrSiteUrl: "Feed or site URL",
		previewSource: "Preview source",

		subscribedSources: "Subscribed sources",
		refreshNewsNow: "Refresh news now",
		refreshQueued: (runId: JSX.Element, state: string): JSX.Element => (
			<>
				News refresh queued as run {runId} (state: {state}). It is fetched by the local runner; if
				the runner is offline it stays queued until the runner reconnects.
			</>
		),
		/** The noun in "Loading sources…" and "Could not load sources.". */
		sourcesThing: "sources",
		noSources: "No sources subscribed yet.",
		sourcesCaption: "Sources you subscribe to, with their last fetch status",
		sourceColumn: "Source",
		typeLicenseTrustColumn: "Type, license, trust",
		statusColumn: "Status",
		actionsColumn: "Actions",

		recommendedSources: "Recommended sources",
		recommendedHint:
			"A curated starting list. None of these is subscribed automatically; preview or subscribe to each one yourself.",
		/** The noun in "Loading recommended sources…". */
		recommendedThing: "recommended sources",
		catalogEmpty: "The catalog is empty.",
		defaultLicense: (license: string) => `default license: ${license}`,
		feedLastChecked: "feed last checked",
		preview: "Preview",
		previewNamed: (title: string) => `Preview ${title}`,
		subscribe: "Subscribe",
		subscribeNamed: (title: string) => `Subscribe to ${title}`,
	},
	ja: {
		license: (policy) =>
			({
				"headline-and-link-only": "見出しとリンクのみ（抜粋は保存しません）",
				"short-excerpt-permitted": "短い抜粋を許可",
			})[policy],
		trust: (trust) =>
			({
				official: "公式",
				"established-media": "大手メディア",
				"trade-press": "業界紙",
				unclassified: "未分類",
			})[trust],
		feedStatus: (status) => ({ active: "有効", failing: "取得失敗", paused: "一時停止中" })[status],
		dateNotStated: "日付の記載なし",
		published: "公開",
		retrieved: "取得",

		previewRegion: "情報源のプレビュー",
		previewHeading: (title) => `プレビュー: ${title}`,
		untitledFeed: "（タイトルなしのフィード）",
		feedUrl: "フィード URL",
		type: "種類",
		site: "サイト",
		siteNotStated: "フィードに記載なし",
		suggestedPublisher: "発行元（候補）",
		notStated: "記載なし",
		itemsFound: "見つかった項目",
		itemsRejected: "除外した項目",
		rejectedCount: (count) => `${count}（安全でないリンクや不正なリンクは保存しません）`,
		sampleItems: "項目の例",
		noUsableItems: "フィードに使える項目がありませんでした。",
		alreadySubscribed: "このフィードはすでに購読しています。",
		licensePolicy: "ライセンス方針",
		trustClassification: "信頼性の分類",
		subscribeToThisSource: "この情報源を購読",
		discardPreview: "プレビューを破棄",

		lastFetch: (when) => `最終取得: ${when}`,
		neverFetched: "未取得",
		lastError: "最後のエラー:",
		pause: "一時停止",
		pauseNamed: (title) => `「${title}」を一時停止`,
		resume: "再開",
		resumeNamed: (title) => `「${title}」を再開`,
		removeNamed: (title) => `「${title}」を削除`,

		recentArticles: "最近の記事",
		reloadArticles: "記事を再読み込み",
		articlesLoadFailed: "記事を読み込めませんでした。",
		noArticles:
			"まだ取り込んだ記事はありません。情報源を購読して「今すぐニュースを更新」を選んでください。",
		articles: "記事",
		articlesThing: "記事",
		loadMoreArticles: "記事をさらに読み込む",

		previewFailed: "情報源をプレビューできませんでした。",
		subscribedTo: (title) => `「${title}」を購読しました。`,
		notSubscribed: "情報源を購読できませんでした。",
		notUpdated: "情報源を更新できませんでした。",
		removed: (title) => `「${title}」を削除しました。`,
		notRemoved: "情報源を削除できませんでした。",
		refreshNotQueued: "ニュースの更新を予約できませんでした。",

		addSourceTitle: "URL で情報源を追加",
		addSourceLabel: "情報源を追加",
		addSourceHint:
			"URL はまず確認され、プレビューが表示されます。「この情報源を購読」を選ぶまで購読されません。",
		previewForm: "情報源をプレビュー",
		feedOrSiteUrl: "フィードまたはサイトの URL",
		previewSource: "プレビュー",

		subscribedSources: "購読中の情報源",
		refreshNewsNow: "今すぐニュースを更新",
		refreshQueued: (runId, state) => (
			<>
				ニュースの更新を実行 {runId} として予約しました（状態: {runStateMessages.ja.name(state)}
				）。ローカルのランナーが取得します。ランナーがオフラインの間は、再接続するまで予約されたままです。
			</>
		),
		sourcesThing: "情報源",
		noSources: "まだ購読中の情報源はありません。",
		sourcesCaption: "購読中の情報源と最終取得の状況",
		sourceColumn: "情報源",
		typeLicenseTrustColumn: "種類・ライセンス・信頼性",
		statusColumn: "状態",
		actionsColumn: "操作",

		recommendedSources: "おすすめの情報源",
		recommendedHint:
			"厳選した最初のリストです。どれも自動では購読されません。それぞれご自身でプレビューまたは購読してください。",
		recommendedThing: "おすすめの情報源",
		catalogEmpty: "カタログは空です。",
		defaultLicense: (license) => `既定のライセンス: ${license}`,
		feedLastChecked: "フィード最終確認",
		preview: "プレビュー",
		previewNamed: (title) => `「${title}」をプレビュー`,
		subscribe: "購読",
		subscribeNamed: (title) => `「${title}」を購読`,
	},
});
