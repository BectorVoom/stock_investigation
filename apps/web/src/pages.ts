/**
 * Single source of truth for the SPA's pages (MECE split). No Solid import:
 * plain data so routers, navigation, titles and docs can all read from here.
 * Rule: no page title or purpose string is written anywhere else (ARCH-010).
 */
export const PAGES = [
	{
		view: "home",
		title: "Home",
		purpose:
			"Check market prices, charts and economic indicators at a glance on widgets you arrange.",
	},
	{
		view: "watchlist",
		title: "Watchlist",
		purpose: "Register the stocks you follow and see their earnings announcement dates.",
	},
	{
		view: "equities",
		title: "Equities",
		purpose:
			"Import and inspect Japanese and US equity financial statements and company data with their sources.",
	},
	{
		view: "tasks",
		title: "Tasks",
		purpose:
			"Schedule research questions to run by themselves and see when each runs next and how it last went.",
	},
	{
		view: "chat",
		title: "Chat",
		purpose: "Ask research questions and read the answers, with their sources and run progress.",
	},
	{
		view: "sources",
		title: "Sources",
		purpose: "Choose which news sources research may read.",
	},
	{
		view: "settings",
		title: "Settings",
		purpose:
			"Configure how the workspace runs: the AI agent, the calendar, the runner and data export.",
	},
] as const;

export type ViewName = (typeof PAGES)[number]["view"];

/**
 * The pages the top bar's navigation lists. Settings is left out: the owner ID
 * at the right of the bar opens it, so a second way in would only crowd the bar.
 */
export const NAVIGATION_PAGES = PAGES.filter((page) => page.view !== "settings");
