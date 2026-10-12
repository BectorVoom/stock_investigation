import type { UiRegistry } from "@research/ui-registry";
import { createEffect, For, type JSX, Match, Show, Switch } from "solid-js";
import type { ApiClient } from "./api/client.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { PageHeader } from "./components/ui.tsx";
import type { VisibilitySource } from "./lib/polling.ts";
import { createRemote } from "./lib/remote.ts";
import { PAGES } from "./pages.ts";
import { createHashRouter, formatHash } from "./router.ts";
import { SettingsView } from "./settings/SettingsView.tsx";
import { SourcesView } from "./sources/SourcesView.tsx";

export interface AppProps {
	/** The only way the UI reaches the backend (UI-001). */
	readonly api: ApiClient;
	/** Component registry; extensions are added where this is constructed (the composition root). */
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly window: Window;
}

export function App(props: AppProps): JSX.Element {
	const router = createHashRouter(props.window);
	const session = createRemote(() => props.api.getSession());
	const view = () => router.route().view;

	// The tab title is external to Solid's tree, hence an effect.
	createEffect(() => {
		const page = PAGES.find((entry) => entry.view === view());
		props.window.document.title = `${page?.title ?? "Chat"} · Research workspace`;
	});

	return (
		<div
			class="bg-slate-100 text-slate-900"
			classList={{
				"flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden": view() === "chat",
				"min-h-screen": view() !== "chat",
			}}
		>
			<header class="border-b border-slate-300 bg-white">
				<div class="mx-auto flex max-w-[110rem] flex-wrap items-center gap-4 px-4 py-2">
					<h1 class="text-base font-semibold">Research workspace</h1>
					{/* ADR-0011: visible "Development" badge in development only. Colour is
					    never the only signal: the badge carries the word itself. An unknown
					    or missing environment is treated as production (no badge). */}
					<Show when={session.value()?.environment === "development"}>
						<span
							data-field="environment-badge"
							class="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold text-amber-900"
						>
							Development
						</span>
					</Show>
					<nav aria-label="Views">
						<ul class="flex gap-1">
							<For each={PAGES}>
								{(page) => (
									<li>
										<a
											href={formatHash({
												view: page.view,
												workspaceId: page.view === "chat" ? router.route().workspaceId : null,
												section: null,
											})}
											aria-current={view() === page.view ? "page" : undefined}
											class="rounded px-2 py-1 text-sm font-medium"
											classList={{
												"bg-blue-700 text-white": view() === page.view,
												"text-slate-800 hover:bg-slate-200": view() !== page.view,
											}}
										>
											{page.title}
										</a>
									</li>
								)}
							</For>
						</ul>
					</nav>
					<p class="ml-auto text-xs text-slate-700" data-field="session-summary">
						<Show when={session.value()} fallback="Checking session…">
							{(current) => (
								<>
									Signed in as <span class="font-mono">{current().ownerId}</span>
								</>
							)}
						</Show>
					</p>
				</div>
				<p class="mx-auto max-w-[110rem] px-4 pb-1 text-2xs text-slate-600">
					A research instrument: it does not place trades and is not investment advice.
				</p>
			</header>
			<main
				class="mx-auto w-full max-w-[110rem] px-4 py-3"
				classList={{
					"flex min-h-0 flex-1 flex-col lg:overflow-hidden": view() === "chat",
				}}
			>
				<PageHeader view={view()} />
				<Switch>
					<Match when={view() === "chat"}>
						<ChatView
							api={props.api}
							registry={props.registry}
							visibility={props.visibility}
							workspaceId={router.route().workspaceId}
							onSelectConversation={(workspaceId) =>
								router.navigate({ view: "chat", workspaceId, section: null })
							}
						/>
					</Match>
					<Match when={view() === "sources"}>
						<SourcesView api={props.api} />
					</Match>
					<Match when={view() === "settings"}>
						<SettingsView
							api={props.api}
							session={session.state()}
							agentSection={router.route().section}
							visibility={props.visibility}
							onReloadSession={() => void session.reload()}
							onOpenWorkspace={(workspaceId) =>
								router.navigate({ view: "chat", workspaceId, section: null })
							}
						/>
					</Match>
				</Switch>
			</main>
		</div>
	);
}
