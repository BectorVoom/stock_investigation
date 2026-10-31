import { defineMessages } from "@research/i18n";

/**
 * A short description of each stable API error code (API-008, ADR-0032
 * decision 8), worded from where the API raises it. The server's own
 * `message` stays English; a UI language other than English shows the
 * description of the code instead, with the server's message as its tooltip.
 */
export const apiErrorMessages = defineMessages({
	en: {
		UNAUTHENTICATED: "Sign-in required.",
		FORBIDDEN: "This action is not allowed.",
		CSRF_REJECTED: "A cross-site or unprotected write was rejected.",
		NOT_FOUND: "Not found.",
		VALIDATION_FAILED: "The request is not valid.",
		PAYLOAD_TOO_LARGE: "The data is too large.",
		RATE_LIMITED: "Too many requests or runs; try again later.",
		CONFLICT: "Another change or step got in the way; wait for it to finish, then try again.",
		IDEMPOTENCY_KEY_REUSED: "This idempotency key was already used for a different request.",
		UNSAFE_URL: "This URL is not allowed.",
		FETCH_FAILED: "The source could not be retrieved.",
		NOT_A_FEED: "No readable RSS or Atom feed was found at this URL.",
		DUPLICATE_SOURCE: "This source is already registered.",
		UNKNOWN_AGENT: "This agent backend is not registered.",
		SPEND_CONSENT_REQUIRED:
			"This backend is metered. Set a maximum spend and confirm consent to authorize paid usage.",
		ILLEGAL_TRANSITION: "The run's current state does not allow this.",
		STALE_LEASE: "This runner no longer holds the run.",
		UI_COMMAND_REJECTED: "The change was rejected and nothing was modified.",
		VERSION_CONFLICT: "The data changed since it was loaded; reload and try again.",
		INTEGRITY_VIOLATION: "The data failed its integrity checks.",
		UNSUPPORTED_EXPORT_VERSION: "This export format version cannot be imported.",
		STORED_DASHBOARD_UNREADABLE:
			"The stored Home arrangement could not be read. Reset to the default arrangement to continue.",
		STORED_NOTEBOOK_UNREADABLE: "The stored notebook could not be read.",
		INVALID_NOTEBOOK: "The notebook content is not valid.",
		INVALID_NOTEBOOK_SELECTION: "The selection names widgets that are not in the notebook.",
		NOTHING_TO_UNDO: "There is nothing to undo.",
		AGENT_NOT_CONFIGURED: "No AI agent is configured. Choose one in Settings → AI agent.",
		NOTEBOOK_ASSIST_ACTIVE:
			"The notebook assistant is still working on this chat. Wait for it to finish, then ask again.",
		AUTH_KEYS_UNAVAILABLE:
			"Sign-in could not be checked right now. Your session may be fine; try again in a moment.",
		INTERNAL: "Internal server error.",
	},
	ja: {
		UNAUTHENTICATED: "サインインが必要です。",
		FORBIDDEN: "この操作は許可されていません。",
		CSRF_REJECTED: "別サイトからの、または保護されていない書き込みを拒否しました。",
		NOT_FOUND: "見つかりません。",
		VALIDATION_FAILED: "リクエストの内容が正しくありません。",
		PAYLOAD_TOO_LARGE: "データが大きすぎます。",
		RATE_LIMITED: "リクエストまたは実行が多すぎます。しばらくしてから再試行してください。",
		CONFLICT: "ほかの変更や処理と競合しました。完了を待ってから再試行してください。",
		IDEMPOTENCY_KEY_REUSED: "この冪等キーは別のリクエストで使用済みです。",
		UNSAFE_URL: "この URL は許可されていません。",
		FETCH_FAILED: "情報源を取得できませんでした。",
		NOT_A_FEED: "この URL で読み取れる RSS または Atom フィードが見つかりません。",
		DUPLICATE_SOURCE: "この情報源はすでに登録されています。",
		UNKNOWN_AGENT: "このエージェントのバックエンドは登録されていません。",
		SPEND_CONSENT_REQUIRED:
			"このバックエンドは従量課金です。有料の利用を許可するには、最大支出額を設定して同意してください。",
		ILLEGAL_TRANSITION: "実行の現在の状態では、この操作はできません。",
		STALE_LEASE: "このランナーはもうこの実行を担当していません。",
		UI_COMMAND_REJECTED: "変更は拒否され、何も変更されていません。",
		VERSION_CONFLICT: "読み込んだ後に内容が変わりました。再読み込みしてから再試行してください。",
		INTEGRITY_VIOLATION: "データの整合性チェックに失敗しました。",
		UNSUPPORTED_EXPORT_VERSION: "このエクスポート形式のバージョンはインポートできません。",
		STORED_DASHBOARD_UNREADABLE:
			"保存されたホームの配置を読み込めません。既定の配置に戻すと続行できます。",
		STORED_NOTEBOOK_UNREADABLE: "保存されたノートブックを読み込めません。",
		INVALID_NOTEBOOK: "ノートブックの内容が正しくありません。",
		INVALID_NOTEBOOK_SELECTION: "選択の中に、ノートブックにないウィジェットがあります。",
		NOTHING_TO_UNDO: "取り消せる変更がありません。",
		AGENT_NOT_CONFIGURED:
			"AI エージェントが設定されていません。設定 → AI エージェントで選んでください。",
		NOTEBOOK_ASSIST_ACTIVE:
			"このチャットのノートブックアシスタントがまだ作業中です。完了してから、もう一度質問してください。",
		AUTH_KEYS_UNAVAILABLE:
			"現在サインインを確認できません。セッションは有効な可能性があります。しばらくしてから再試行してください。",
		INTERNAL: "サーバー内部でエラーが発生しました。",
	},
});

/**
 * The client's own failure sentences (`apps/web/src/api/http.ts`). The English
 * table is the failure's data: `ApiFailure.message` is built from it, so it
 * stays byte-for-byte what the client always said, and `translatedFailureMessage`
 * recognises a sentence by it to word the same reason in another language.
 */
export const clientFailureMessages = defineMessages({
	en: {
		requestInvalid: "The request does not match the API contract and was not sent.",
		responseInvalid: "The server response does not match the API contract.",
		responseNotJson: "The server response is not valid JSON.",
		unexpectedStatus: (status: number) =>
			`The server answered HTTP ${status} without a recognisable error body.`,
		timeout: (seconds: number) => `The server did not answer within ${seconds} s.`,
		requestFailed: (cause: string) => `The request could not be completed (${cause}).`,
		responseIncomplete: (cause: string) => `The response could not be read completely (${cause}).`,
		/** `received` is the response's Content-Type, "" when it had none. */
		markdownContentType: (received: string): string =>
			`Expected a text/markdown export but received "${received || "no content type"}".`,
		calendarContentType: (received: string): string =>
			`Expected a text/calendar file but received "${received || "no content type"}".`,
	},
	ja: {
		requestInvalid: "リクエストが API の契約に合わないため、送信しませんでした。",
		responseInvalid: "サーバーの応答が API の契約に合いません。",
		responseNotJson: "サーバーの応答が有効な JSON ではありません。",
		unexpectedStatus: (status) =>
			`サーバーが HTTP ${status} を返しましたが、エラーの内容を読み取れませんでした。`,
		timeout: (seconds) => `サーバーが ${seconds} 秒以内に応答しませんでした。`,
		requestFailed: (cause) => `リクエストを完了できませんでした（${cause}）。`,
		responseIncomplete: (cause) => `応答を最後まで読み取れませんでした（${cause}）。`,
		markdownContentType: (received) =>
			received === ""
				? "text/markdown のエクスポートを想定していましたが、Content-Type のない応答を受け取りました。"
				: `text/markdown のエクスポートを想定していましたが、「${received}」を受け取りました。`,
		calendarContentType: (received) =>
			received === ""
				? "text/calendar のファイルを想定していましたが、Content-Type のない応答を受け取りました。"
				: `text/calendar のファイルを想定していましたが、「${received}」を受け取りました。`,
	},
});
