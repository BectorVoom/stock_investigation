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
		purpose: "Configure how the workspace runs: the AI agent, the runner and data export.",
	},
] as const;

export type ViewName = (typeof PAGES)[number]["view"];
