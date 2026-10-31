import { STOCK_TABS, type StockTab, watchlistStockIdSchema } from "@research/contracts";
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
	/**
	 * The Stocks page's stock and tab (ADR-0049 §1): `#/stocks/<stockId>[/<tab>]`.
	 * Null elsewhere and for `#/stocks` with no stock.
	 */
	readonly stock: StockRoute | null;
}

export interface StockRoute {
	readonly stockId: string;
	readonly tab: StockTab;
}

function isStockTab(value: string | undefined): value is StockTab {
	return STOCK_TABS.some((tab) => tab === value);
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
/** Sub-sections addressable below `#/settings`; anything else is ignored. */
const SETTINGS_SECTIONS = new Set(["agent", "calendar"]);

/**
 * Parses `#/home`, `#/chat`, `#/chat/<id>`, `#/sources`, `#/registered`,
 * `#/stocks`, `#/stocks/<stockId>[/<tab>]`, `#/tasks`, `#/settings`,
 * `#/settings/agent` and `#/settings/calendar`; the legacy `#/canvas`,
 * `#/canvas/<id>`, `#/workspace/<id>` and `#/workspace` aliases parse as the
 * chat view (bookmarks from before the Canvas panel moved into the thread),
 * the legacy `#/watchlist/calendar[/YYYY-MM-DD]` links as
 * `#/settings/calendar` (the calendar settings moved there, ADR-0022), and
 * `#/watchlist` and `#/equities` as `#/registered`, where their lists and
 * actions live now (ADR-0049 §1). A bad stock id opens the Stocks page with
 * no stock; a bad tab opens the stock's Chart tab.
 * Anything else (unknown or empty hash) is the default `home` view.
 */
export function parseHash(hash: string): Route {
	const normalized = hash.replace(/^#\/?/, "");
	const [viewText, idText, tabText] = normalized.split("/");
	if (viewText === "workspace" || viewText === "canvas") {
		const workspaceId = idText !== undefined && WORKSPACE_ID.test(idText) ? idText : null;
		return { view: "chat", workspaceId, section: null, stock: null };
	}
	// The Watchlist and Equities pages' lists are the Registered stocks page
	// (ADR-0049 §1); the Watchlist's calendar links moved to Settings (ADR-0022).
	if (viewText === "watchlist" && idText === "calendar") {
		return { view: "settings", workspaceId: null, section: "calendar", stock: null };
	}
	if (viewText === "watchlist" || viewText === "equities") {
		return { view: "registered", workspaceId: null, section: null, stock: null };
	}
	const known = PAGES.find((page) => page.view === viewText);
	if (known === undefined) return { view: "home", workspaceId: null, section: null, stock: null };
	if (known.view === "chat" && idText !== undefined) {
		return {
			view: known.view,
			workspaceId: WORKSPACE_ID.test(idText) ? idText : null,
			section: null,
			stock: null,
		};
	}
	if (known.view === "settings" && idText !== undefined) {
		return {
			view: known.view,
			workspaceId: null,
			section: SETTINGS_SECTIONS.has(idText) ? idText : null,
			stock: null,
		};
	}
	if (known.view === "stocks" && idText !== undefined) {
		const stockId = decodeHashPart(idText);
		if (stockId === null || !watchlistStockIdSchema.safeParse(stockId).success) {
			return { view: "stocks", workspaceId: null, section: null, stock: null };
		}
		const tab = isStockTab(tabText) ? tabText : "chart";
		return { view: "stocks", workspaceId: null, section: null, stock: { stockId, tab } };
	}
	return { view: known.view, workspaceId: null, section: null, stock: null };
}

/** A hash segment as text; null when its percent-encoding is broken. */
function decodeHashPart(part: string): string | null {
	try {
		return decodeURIComponent(part);
	} catch {
		return null;
	}
}

export function formatHash(route: Route): string {
	if (route.view === "chat" && route.workspaceId !== null) {
		return `#/chat/${route.workspaceId}`;
	}
	if (route.view === "settings" && route.section !== null) {
		return `#/${route.view}/${route.section}`;
	}
	if (route.view === "stocks" && route.stock !== null) {
		// `:` is legal in a fragment, so `#/stocks/us:AAPL/news` stays readable.
		const id = encodeURIComponent(route.stock.stockId).replace(/%3A/gi, ":");
		return route.stock.tab === "chart" ? `#/stocks/${id}` : `#/stocks/${id}/${route.stock.tab}`;
	}
	return `#/${route.view}`;
}

/** The Tasks page (ADR-0033): the widget's "Open Tasks" link. */
export const TASKS_HASH = formatHash({
	view: "tasks",
	workspaceId: null,
	section: null,
	stock: null,
});

/**
 * The Registered stocks page (ADR-0049 §2): where the watchlist, its lists
 * and the companies whose statements are synced are managed.
 */
export const REGISTERED_STOCKS_HASH = formatHash({
	view: "registered",
	workspaceId: null,
	section: null,
	stock: null,
});

/** One stock on the Stocks page, at one tab (ADR-0049 §1). */
export function stockHash(stockId: string, tab: StockTab = "chart"): string {
	return formatHash({ view: "stocks", workspaceId: null, section: null, stock: { stockId, tab } });
}

/** The AI agent section of Settings: where a skipped task's fix lives. */
export const SETTINGS_AGENT_HASH = formatHash({
	view: "settings",
	workspaceId: null,
	section: "agent",
	stock: null,
});

/** A conversation on the Chat page (a task's answers land in its own). */
export function chatHash(workspaceId: string): string {
	return formatHash({ view: "chat", workspaceId, section: null, stock: null });
}

/** The Calendar section of Settings (Google Calendar, `.ics` download, subscription link). */
export const SETTINGS_CALENDAR_HASH = formatHash({
	view: "settings",
	workspaceId: null,
	section: "calendar",
	stock: null,
});

export interface Router {
	readonly route: Accessor<Route>;
	/**
	 * Goes to a route. `replace` swaps the current history entry instead of
	 * adding one (a Stocks tab switch, ADR-0049 §1: Back never walks tabs).
	 */
	readonly navigate: (route: Route, options?: { readonly replace?: boolean }) => void;
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
		navigate: (next, options) => {
			const hash = formatHash(next);
			// Update the signal directly too: `hashchange` is asynchronous.
			setRoute(next);
			if (win.location.hash === hash) return;
			if (options?.replace === true) win.location.replace(hash);
			else win.location.hash = hash;
		},
	};
}
