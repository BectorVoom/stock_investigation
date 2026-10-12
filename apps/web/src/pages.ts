/**
 * Single source of truth for the SPA's pages (MECE split). No Solid import:
 * plain data so routers, navigation, titles and docs can all read from here.
 * Rule: no page title or purpose string is written anywhere else (ARCH-010).
 */
export const PAGES = [
	{
		view: "chat",
		title: "Chat",
		purpose: "Ask research questions and read the answers, with their sources and run progress.",
	},
	{
		view: "canvas",
		title: "Canvas",
		purpose: "Inspect and arrange the tables, charts and reports that research produced.",
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
			"Configure how the workspace runs: the AI agent, the runner, approved images and data export.",
	},
] as const;

export type ViewName = (typeof PAGES)[number]["view"];
