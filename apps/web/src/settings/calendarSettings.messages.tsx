import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

/** Settings → Calendar (`CalendarSettingsSection.tsx`). */
export const calendarSettingsMessages = defineMessages({
	en: {
		title: "Calendar",
		/** The intro sentence around the link to the Watchlist page. */
		intro: (watchlistLink: JSX.Element): JSX.Element => (
			<>
				Keep the earnings announcement dates of the stocks on your {watchlistLink} in your own
				calendar: sync them to Google Calendar, download them as a file, or subscribe to them.
				Single dates can also be added from the Watchlist table.
			</>
		),
		watchlistLink: "Watchlist",
		loadFailed: "Could not load the calendar.",
		notRefreshed: "The calendar state did not refresh.",
		googleSyncNotQueued: (reason: string) => `The Google Calendar sync was not queued: ${reason}`,
		notDownloaded: "The calendar file was not downloaded.",
		linkNotCreated: "The subscription link was not created.",
		linkNotRevoked: "The subscription link was not revoked.",
		linkRevoked: "The subscription link was revoked.",
		linkNotCopied: "The link was not copied.",
		copyFailed: "Copying failed; select the link and copy it by hand.",
		/** Completes "Loading …". */
		calendarThing: "calendar",
		preparingFile: "Preparing file…",
		downloadIcs: "Download calendar file (.ics)",
		addStockFirst: "Add a stock on the Watchlist page to download its dates.",
		subscriptionLink: "Subscription link",
		shownOnce:
			"This is the only time this link is shown. Copy it now; replacing or revoking it stops this link from working.",
		linkFieldLabel: "Subscription link (shown once)",
		copied: "Copied to the clipboard.",
		/** `createdAt` is the `<time>` element of the creation instant. */
		linkCreated: (createdAt: JSX.Element): JSX.Element => (
			<>A subscription link was created {createdAt}. The link itself is not shown again.</>
		),
		replaceLink: "Replace link",
		revokeLink: "Revoke link",
		noLinkYet: "No subscription link exists yet. A calendar app can poll it for new dates.",
		createLink: "Create subscription link",
		linkIsSecret:
			"The link is a secret: anyone with it can read the calendar. Google Calendar can only subscribe to it when this app is reachable from the internet over HTTPS (a localhost address works with calendar apps on this computer only). The .ics download and the per-date links work everywhere.",
		replaceTitle: "Replace the subscription link?",
		replaceBody: "A new link is created and shown once. The old link stops working immediately.",
		revokeTitle: "Revoke the subscription link?",
		revokeBody: "Calendar apps using the link stop receiving updates. This cannot be undone.",
	},
	ja: {
		title: "カレンダー",
		intro: (watchlistLink) => (
			<>
				{watchlistLink}
				にある銘柄の決算発表日を、自分のカレンダーで管理できます。Google Calendar
				に同期する、ファイルとしてダウンロードする、または購読する方法があります。日付を1件ずつウォッチリストの表から追加することもできます。
			</>
		),
		watchlistLink: "ウォッチリスト",
		loadFailed: "カレンダーを読み込めませんでした。",
		notRefreshed: "カレンダーの状態を更新できませんでした。",
		googleSyncNotQueued: (reason) =>
			`Google Calendar の同期をキューに追加できませんでした: ${reason}`,
		notDownloaded: "カレンダーのファイルをダウンロードできませんでした。",
		linkNotCreated: "購読リンクを作成できませんでした。",
		linkNotRevoked: "購読リンクを失効できませんでした。",
		linkRevoked: "購読リンクを失効しました。",
		linkNotCopied: "リンクをコピーできませんでした。",
		copyFailed: "コピーに失敗しました。リンクを選択して手動でコピーしてください。",
		calendarThing: "カレンダー",
		preparingFile: "ファイルを準備中…",
		downloadIcs: "カレンダーのファイルをダウンロード（.ics）",
		addStockFirst: "日付をダウンロードするには、ウォッチリストのページで銘柄を追加してください。",
		subscriptionLink: "購読リンク",
		shownOnce:
			"このリンクが表示されるのは今回だけです。今すぐコピーしてください。置き換えるか失効すると、このリンクは使えなくなります。",
		linkFieldLabel: "購読リンク（一度だけ表示）",
		copied: "クリップボードにコピーしました。",
		linkCreated: (createdAt) => (
			<>購読リンクは {createdAt} に作成されました。リンク自体は再表示されません。</>
		),
		replaceLink: "リンクを置き換え",
		revokeLink: "リンクを失効",
		noLinkYet:
			"購読リンクはまだありません。カレンダーアプリはこのリンクを定期的に確認して新しい日付を取り込めます。",
		createLink: "購読リンクを作成",
		linkIsSecret:
			"このリンクは秘密です。知っている人は誰でもカレンダーを読めます。Google Calendar で購読できるのは、このアプリにインターネットから HTTPS でアクセスできる場合だけです（localhost のアドレスは、このコンピューター上のカレンダーアプリでのみ使えます）。.ics のダウンロードと日付ごとのリンクはどこでも使えます。",
		replaceTitle: "購読リンクを置き換えますか？",
		replaceBody: "新しいリンクを作成して一度だけ表示します。古いリンクはすぐに使えなくなります。",
		revokeTitle: "購読リンクを失効しますか？",
		revokeBody:
			"このリンクを使っているカレンダーアプリには更新が届かなくなります。この操作は取り消せません。",
	},
});

/** The Google Calendar card in Settings → Calendar (`GoogleCalendarCard.tsx`). */
export const googleCalendarMessages = defineMessages({
	en: {
		syncCounts: (inserted: number, updated: number, deleted: number) =>
			`${inserted} added, ${updated} changed, ${deleted} removed.`,
		connectNotQueued: "The Google Calendar connection was not queued.",
		syncNotQueued: "The Google Calendar sync was not queued.",
		disconnectNotQueued: "The Google Calendar disconnection was not queued.",
		runNotCancelled: "The Google Calendar run was not cancelled.",
		connected: "Connected.",
		connectedSince: (at: string) => `Connected since ${at}.`,
		disconnecting: (since: string) => `${since} Disconnecting…`,
		syncing: (since: string) => `${since} Syncing…`,
		behind: " The dates here have changed since; use Sync now to update the calendar.",
		/** `behind` is the `behind` sentence or "". */
		lastSynced: (since: string, at: string, counts: string, behind: string) =>
			`${since} Last synced ${at}: ${counts}${behind}`,
		noChanges: "no changes.",
		notSyncedYet: (since: string) => `${since} Not synced yet.`,
		disconnectedIntro:
			"Keeps a calendar named ‘Earnings calendar (Research workspace)’ in your Google account in step with these dates. The app can only see and change calendars it created itself.",
		connect: "Connect Google Calendar",
		preparingSignIn:
			"Preparing Google sign-in… It is prepared by the local runner; if the runner is offline this waits until it reconnects.",
		openSignIn: "Open Google sign-in",
		waitingForSignIn: "Waiting for you to finish in Google (5 minutes)…",
		syncNow: "Sync now",
		disconnect: "Disconnect",
		needsAttention: "The Google connection needs attention.",
		reconnectToKeep: (reason: string) => `${reason} Reconnect to keep the calendar in step.`,
		reconnect: "Reconnect Google Calendar",
		stepFailed: "The Google Calendar step failed.",
		autoSyncPaused: "Automatic syncing is paused until a sync succeeds. Use Sync now to try again.",
		disconnectTitle: "Disconnect Google Calendar?",
		disconnectBody:
			"The calendar stays in your Google account — delete it there (Google Calendar settings) if you no longer want it. This app forgets the connection at once.",
	},
	ja: {
		syncCounts: (inserted, updated, deleted) =>
			`追加 ${inserted} 件、変更 ${updated} 件、削除 ${deleted} 件。`,
		connectNotQueued: "Google Calendar への接続をキューに追加できませんでした。",
		syncNotQueued: "Google Calendar の同期をキューに追加できませんでした。",
		disconnectNotQueued: "Google Calendar の切断をキューに追加できませんでした。",
		runNotCancelled: "Google Calendar の実行をキャンセルできませんでした。",
		connected: "接続済みです。",
		connectedSince: (at) => `${at} から接続しています。`,
		disconnecting: (since) => `${since}切断中…`,
		syncing: (since) => `${since}同期中…`,
		behind:
			"その後、ここの日付が変わりました。カレンダーを更新するには「今すぐ同期」を使ってください。",
		lastSynced: (since, at, counts, behind) => `${since}最終同期 ${at}: ${counts}${behind}`,
		noChanges: "変更なし。",
		notSyncedYet: (since) => `${since}まだ同期していません。`,
		disconnectedIntro:
			"Google アカウント内の「Earnings calendar (Research workspace)」という名前のカレンダーを、これらの日付と同じ状態に保ちます。このアプリが閲覧・変更できるのは、自分で作成したカレンダーだけです。",
		connect: "Google Calendar に接続",
		preparingSignIn:
			"Google のサインインを準備中… ローカルのランナーが準備します。ランナーがオフラインの場合は、再接続するまで待ちます。",
		openSignIn: "Google のサインインを開く",
		waitingForSignIn: "Google での操作が終わるのを待っています（5分）…",
		syncNow: "今すぐ同期",
		disconnect: "切断",
		needsAttention: "Google との接続を確認する必要があります。",
		reconnectToKeep: (reason) => `${reason}カレンダーを同期し続けるには再接続してください。`,
		reconnect: "Google Calendar に再接続",
		stepFailed: "Google Calendar の処理に失敗しました。",
		autoSyncPaused:
			"同期が成功するまで自動同期は一時停止しています。もう一度試すには「今すぐ同期」を使ってください。",
		disconnectTitle: "Google Calendar との接続を切断しますか？",
		disconnectBody:
			"カレンダーは Google アカウントに残ります。不要な場合は Google Calendar の設定から削除してください。このアプリは接続情報をすぐに破棄します。",
	},
});
