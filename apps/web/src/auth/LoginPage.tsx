import { useMessages } from "@research/i18n/solid";
import { type JSX, Match, Switch } from "solid-js";
import type { Session } from "../api/client.ts";
import { BUTTON, BUTTON_PRIMARY } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import type { Remote } from "../lib/remote.ts";
import { loginMessages } from "./login.messages.ts";

/**
 * Identity and administrator authorization remain the server's responsibility.
 * A full-page navigation lets Access redirect to the configured identity provider;
 * fetching a protected API from JavaScript cannot complete an interactive login.
 */
export function LoginPage(props: {
	readonly state: Remote<Session>;
	readonly retry: () => Promise<void>;
	readonly signIn: () => void;
}): JSX.Element {
	const m = useMessages(loginMessages);
	const common = useMessages(commonMessages);
	const code = () => (props.state.status === "error" ? props.state.error.code : null);
	return (
		<main class="flex min-h-dvh items-center justify-center bg-slate-100 px-4 py-8 text-slate-900">
			<section
				class="w-full max-w-md rounded border border-slate-300 bg-white p-6"
				aria-labelledby="login-title"
			>
				<h1 id="login-title" class="text-xl font-semibold">
					{m().title}
				</h1>
				<p class="mt-3 text-sm text-slate-700">{m().description}</p>
				<div class="mt-6">
					<Switch
						fallback={
							<>
								<p role="alert" class="mb-4 text-sm text-slate-700">
									{m().unavailable}
								</p>
								<button type="button" class={BUTTON} onClick={() => void props.retry()}>
									{m().retry}
								</button>
							</>
						}
					>
						<Match when={props.state.status === "loading"}>
							<output aria-busy="true" class="block text-sm text-slate-600">
								{common().loading}
							</output>
						</Match>
						<Match when={code() === "UNAUTHENTICATED"}>
							<button type="button" class={BUTTON_PRIMARY} onClick={props.signIn}>
								{m().signIn}
							</button>
						</Match>
						<Match when={code() === "FORBIDDEN"}>
							<p role="alert" class="mb-4 text-sm text-slate-700">
								{m().forbidden}
							</p>
							<a class={BUTTON_PRIMARY} href="/cdn-cgi/access/logout">
								{m().signOut}
							</a>
						</Match>
					</Switch>
				</div>
			</section>
		</main>
	);
}
