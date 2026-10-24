import { LocaleProvider, useMessages } from "@research/i18n/solid";
import type { UiRegistry } from "@research/ui-registry";
import { WidgetGridStringsProvider } from "@research/widget-grid";
import {
	createEffect,
	ErrorBoundary,
	For,
	type JSX,
	lazy,
	Match,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import type { ApiClient } from "./api/client.ts";
import { appMessages } from "./app.messages.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { BUTTON, Loading, PageHeader } from "./components/ui.tsx";
import { commonMessages } from "./i18n/common.messages.ts";
import { createLocaleState, type LocaleState } from "./i18n/localeState.ts";
import { widgetGridMessages } from "./i18n/widgetGrid.messages.ts";
import { browserLocalStorage } from "./lib/browserStorage.ts";
import type { VisibilitySource } from "./lib/polling.ts";
import { createRemote } from "./lib/remote.ts";
import { pageMessages } from "./pages.messages.ts";
import { PAGES } from "./pages.ts";
import { createHashRouter, formatHash } from "./router.ts";
import { SettingsView } from "./settings/SettingsView.tsx";
import { SourcesView } from "./sources/SourcesView.tsx";
import { TasksView } from "./tasks/TasksView.tsx";
import { WatchlistView } from "./watchlist/WatchlistView.tsx";

/** Home is loaded lazily so the other pages never pay for Shoelace. */
const HomeView = lazy(() =>
	import("./home/HomeView.tsx").then((module) => ({ default: module.HomeView })),
);

export interface AppProps {
	/** The only way the UI reaches the backend (UI-001). */
	readonly api: ApiClient;
	/** Component registry; extensions are added where this is constructed (the composition root). */
	readonly registry: UiRegistry;
	readonly visibility: VisibilitySource;
	readonly window: Window;
}

export function App(props: AppProps): JSX.Element {
	const localeState = createLocaleState({
		window: props.window,
		storage: browserLocalStorage(),
	});
	return (
		<LocaleProvider locale={localeState.locale}>
			<WidgetGridStringsProvider strings={widgetGridMessages[localeState.locale()]}>
				<AppShell {...props} localeState={localeState} />
			</WidgetGridStringsProvider>
		</LocaleProvider>
	);
}

function AppShell(props: AppProps & { readonly localeState: LocaleState }): JSX.Element {
	const m = useMessages(appMessages);
	const common = useMessages(commonMessages);
	const pages = useMessages(pageMessages);
	const router = createHashRouter(props.window);
	const session = createRemote(() => props.api.getSession());
	const view = () => router.route().view;

	// The tab title is external to Solid's tree, hence an effect.
	createEffect(() => {
		props.window.document.title = m().tabTitle(pages().title(view()));
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
					<h1 class="text-base font-semibold">{m().appName}</h1>
					{/* ADR-0011: visible "Development" badge in development only. Colour is
					    never the only signal: the badge carries the word itself. An unknown
					    or missing environment is treated as production (no badge). */}
					<Show when={session.value()?.environment === "development"}>
						<span
							data-field="environment-badge"
							class="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold text-amber-900"
						>
							{m().developmentBadge}
						</span>
					</Show>
					<nav aria-label={m().viewsNavigation}>
						<ul class="flex flex-wrap gap-1">
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
											{pages().title(page.view)}
										</a>
									</li>
								)}
							</For>
						</ul>
					</nav>
					<p class="ml-auto text-xs text-slate-700" data-field="session-summary">
						<Show when={session.value()} fallback={m().checkingSession}>
							{(current) => (
								<>
									{m().signedInAs} <span class="font-mono">{current().ownerId}</span>
								</>
							)}
						</Show>
					</p>
				</div>
			</header>
			<main
				class="mx-auto w-full max-w-[110rem] px-4 py-3"
				classList={{
					"flex min-h-0 flex-1 flex-col lg:overflow-hidden": view() === "chat",
				}}
			>
				<PageHeader view={view()} />
				<Switch>
					<Match when={view() === "home"}>
						{/* V10: the lazy chunk has a designed loading state and an
						    error state with "Try again" — a failed chunk load must
						    not leave the default page blank. */}
						<ErrorBoundary
							fallback={(error, reset) => (
								<div
									role="alert"
									class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
								>
									<p>
										<span class="font-semibold">{m().homeLoadFailed} </span>
										{error instanceof Error ? error.message : common().unknownError}
									</p>
									<button type="button" class={`${BUTTON} mt-1`} onClick={reset}>
										{common().tryAgain}
									</button>
								</div>
							)}
						>
							<Suspense fallback={<Loading label={pages().title("home")} />}>
								<HomeView api={props.api} visibility={props.visibility} />
							</Suspense>
						</ErrorBoundary>
					</Match>
					<Match when={view() === "tasks"}>
						<TasksView api={props.api} visibility={props.visibility} />
					</Match>
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
					<Match when={view() === "watchlist"}>
						<WatchlistView api={props.api} visibility={props.visibility} />
					</Match>
					<Match when={view() === "settings"}>
						<SettingsView
							api={props.api}
							session={session.state()}
							section={router.route().section}
							visibility={props.visibility}
							localeState={props.localeState}
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
