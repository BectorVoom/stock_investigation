import { defineMessages } from "@research/i18n";

/**
 * The Chat page's frame (ADR-0031): the Chats panel, the welcome, the
 * Chat/Notebook switch and the panels' notices. Chat titles the owner or the
 * agent wrote stay as written; only the server's untouched default title
 * ("New chat") is shown in the current language.
 */
export const chatMessages = defineMessages({
	en: {
		chatTitle: "Chat title",
		newChat: "New chat",
		/** The thing being loaded, for "Loading …". */
		newChatLoading: "new chat",
		noChats: "No chats yet. Start one above.",
		chatsCount: (count: number) => `Chats (${count})`,
		chats: "Chats",
		chatNotCreated: "The chat was not created.",
		chatNotRenamed: "The chat was not renamed.",
		expandChats: "Expand Chats panel",
		collapseChats: "Collapse Chats panel",
		/** The thing being loaded, for "Loading …". */
		conversations: "conversations",
		/** The thing being loaded, for "Loading …". */
		conversation: "conversation",
		moreActionsFor: (title: string) => `More actions for ${title}`,
		actionsFor: (title: string) => `Actions for ${title}`,
		deleteChat: (title: string) => `Delete “${title}”?`,
		deleteChatBody:
			"This removes its messages, notebook and research records. This cannot be undone.",
		chat: "Chat",
		notebook: "Notebook",
		welcome: "Welcome to Chat",
		welcomeHint:
			"Start a new chat to ask a research question. Prior findings stay available here even when the local runner is offline.",
		chatOrNotebook: "Chat or Notebook",
		dismiss: "Dismiss",
		conversationFailed: "Could not load this conversation.",
		messagesFailed: "Could not load the messages.",
		notebookFailed: "Could not load the notebook.",
		collapseChat: "Collapse Chat panel",
		expandChat: "Expand Chat panel",
		collapseNotebook: "Collapse Notebook panel",
		expandNotebook: "Expand Notebook panel",
		notebookTakingShape: "Your notebook is taking shape —",
		focusNotebook: "Focus Notebook",
		focusChat: "Focus Chat",
		dismissSuggestion: "Dismiss suggestion",
		workspaceFocus: "Workspace focus",
	},
	ja: {
		chatTitle: "チャットのタイトル",
		newChat: "新しいチャット",
		newChatLoading: "新しいチャット",
		noChats: "チャットはまだありません。上のボタンから始めてください。",
		chatsCount: (count) => `チャット一覧（${count}）`,
		chats: "チャット一覧",
		chatNotCreated: "チャットを作成できませんでした。",
		chatNotRenamed: "チャットの名前を変更できませんでした。",
		expandChats: "チャット一覧パネルを展開",
		collapseChats: "チャット一覧パネルを折りたたむ",
		conversations: "チャット一覧",
		conversation: "チャット",
		moreActionsFor: (title) => `「${title}」のその他の操作`,
		actionsFor: (title) => `「${title}」の操作`,
		deleteChat: (title) => `「${title}」を削除しますか？`,
		deleteChatBody:
			"メッセージ、ノートブック、リサーチの記録が削除されます。この操作は取り消せません。",
		chat: "チャット",
		notebook: "ノートブック",
		welcome: "チャットへようこそ",
		welcomeHint:
			"新しいチャットを始めて、リサーチの質問をしてください。ローカルのランナーがオフラインでも、これまでの調査結果はここで確認できます。",
		chatOrNotebook: "チャットまたはノートブック",
		dismiss: "閉じる",
		conversationFailed: "このチャットを読み込めませんでした。",
		messagesFailed: "メッセージを読み込めませんでした。",
		notebookFailed: "ノートブックを読み込めませんでした。",
		collapseChat: "チャットパネルを折りたたむ",
		expandChat: "チャットパネルを展開",
		collapseNotebook: "ノートブックパネルを折りたたむ",
		expandNotebook: "ノートブックパネルを展開",
		notebookTakingShape: "ノートブックの形が整ってきました —",
		focusNotebook: "ノートブックを中心に表示",
		focusChat: "チャットを中心に表示",
		dismissSuggestion: "提案を閉じる",
		workspaceFocus: "ワークスペースの表示",
	},
});
