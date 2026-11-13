import { defineMessages } from "@research/i18n";

export const loginMessages = defineMessages({
	en: {
		title: "Administrator login",
		description:
			"This workspace is private. Sign in with the administrator account through Cloudflare Access.",
		signIn: "Sign in with Cloudflare Access",
		forbidden:
			"This account is not the administrator. Sign out and use the configured administrator account.",
		signOut: "Sign out of Cloudflare Access",
		unavailable:
			"The session could not be verified. Retry, or ask the administrator to check the Cloudflare Access configuration.",
		retry: "Retry",
	},
	ja: {
		title: "管理者ログイン",
		description:
			"このワークスペースは非公開です。Cloudflare Access から管理者アカウントでログインしてください。",
		signIn: "Cloudflare Access でログイン",
		forbidden:
			"このアカウントは管理者ではありません。ログアウトし、設定された管理者アカウントでログインしてください。",
		signOut: "Cloudflare Access からログアウト",
		unavailable:
			"セッションを確認できませんでした。再試行するか、管理者に Cloudflare Access の設定確認を依頼してください。",
		retry: "再試行",
	},
});
