import { type Accessor, createSignal, onCleanup } from "solid-js";
import { PAGES, type ViewName } from "./pages.ts";

export type { ViewName };
export const VIEWS = PAGES.map((page) => page.view);

export interface Route {
	readonly view: ViewName;
	/** Only meaningful for the chat view; survives a browser reload via the URL. */
	readonly workspaceId: string | null;
	/**
	 * Settings sub-section marker: `#/settings/agent` scrolls the AI agent
	 * section into view and focuses its backend select, `#/settings/calendar`
	 * scrolls to and focuses the Calendar section. Null elsewhere.
	 */
	readonly section: string | null;
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
/** Sub-sections addressable below `#/settings`; anything else is ignored. */
const SETTINGS_SECTIONS = new Set(["agent", "calendar"]);

/**
 * Parses `#/home`, `#/chat`, `#/chat/<id>`, `#/sources`, `#/watchlist`,
 * `#/tasks`, `#/settings`, `#/settings/agent` and `#/settings/calendar`; the legacy
 * `#/canvas`, `#/canvas/<id>`, `#/workspace/<id>` and `#/workspace` aliases
 * parse as the chat view (bookmarks from before the Canvas panel moved into
 * the thread), and the legacy `#/watchlist/calendar[/YYYY-MM-DD]` links as
 * `#/settings/calendar` (the calendar settings moved there, ADR-0022).
 * Anything else (unknown or empty hash) is the default `home` view.
 */
export function parseHash(hash: string): Route {
	const normalized = hash.replace(/^#\/?/, "");
	const [viewText, idText] = normalized.split("/");
	if (viewText === "workspace" || viewText === "canvas") {
		const workspaceId = idText !== undefined && WORKSPACE_ID.test(idText) ? idText : null;
		return { view: "chat", workspaceId, section: null };
	}
	const known = PAGES.find((page) => page.view === viewText);
	if (known === undefined) return { view: "home", workspaceId: null, section: null };
	if (known.view === "chat" && idText !== undefined) {
		return {
			view: known.view,
			workspaceId: WORKSPACE_ID.test(idText) ? idText : null,
			section: null,
		};
	}
	if (known.view === "settings" && idText !== undefined) {
		return {
			view: known.view,
			workspaceId: null,
			section: SETTINGS_SECTIONS.has(idText) ? idText : null,
		};
	}
	if (known.view === "watchlist" && idText === "calendar") {
		return { view: "settings", workspaceId: null, section: "calendar" };
	}
	return { view: known.view, workspaceId: null, section: null };
}

export function formatHash(route: Route): string {
	if (route.view === "chat" && route.workspaceId !== null) {
		return `#/chat/${route.workspaceId}`;
	}
	if (route.view === "settings" && route.section !== null) {
		return `#/${route.view}/${route.section}`;
	}
	return `#/${route.view}`;
}

/** The Tasks page (ADR-0033): the widget's "Open Tasks" link. */
export const TASKS_HASH = formatHash({ view: "tasks", workspaceId: null, section: null });

/** The Watchlist page: where a Watchlist prices widget's lists are made (ADR-0040). */
export const WATCHLIST_HASH = formatHash({ view: "watchlist", workspaceId: null, section: null });

/** The AI agent section of Settings: where a skipped task's fix lives. */
export const SETTINGS_AGENT_HASH = formatHash({
	view: "settings",
	workspaceId: null,
	section: "agent",
});

/** A conversation on the Chat page (a task's answers land in its own). */
export function chatHash(workspaceId: string): string {
	return formatHash({ view: "chat", workspaceId, section: null });
}

/** The Calendar section of Settings (Google Calendar, `.ics` download, subscription link). */
export const SETTINGS_CALENDAR_HASH = formatHash({
	view: "settings",
	workspaceId: null,
	section: "calendar",
});

export interface Router {
	readonly route: Accessor<Route>;
	readonly navigate: (route: Route) => void;
}

/**
 * A view switch synced to `location.hash` (no router dependency). Must be
 * created under a Solid owner so the listener is removed on disposal.
 */
export function createHashRouter(win: Window): Router {
	const [route, setRoute] = createSignal<Route>(parseHash(win.location.hash));
	const onHashChange = () => setRoute(parseHash(win.location.hash));
	win.addEventListener("hashchange", onHashChange);
	onCleanup(() => win.removeEventListener("hashchange", onHashChange));
	return {
		route,
		navigate: (next) => {
			const hash = formatHash(next);
			// Update the signal directly too: `hashchange` is asynchronous.
			setRoute(next);
			if (win.location.hash !== hash) win.location.hash = hash;
		},
	};
}
