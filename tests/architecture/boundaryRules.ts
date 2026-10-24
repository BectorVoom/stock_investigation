/**
 * The import-boundary rule table, as data. One entry per workspace package;
 * a package under packages/ or apps/ without an entry fails the check, so a
 * new package cannot be added without deciding what it may depend on.
 *
 * Source: ENGINEERING_DESIGN_RULES.md section 3 and ARCHITECTURE section 11
 * ("do not accidentally import Node-only libraries into Worker bundles").
 */
import {
	anyExternal,
	exact,
	nodeBuiltin,
	type PackageRule,
	pkg,
	scheme,
} from "./boundaryChecker.ts";

export const WORKSPACE_SCOPES = ["@research/", "@app/"] as const;

const DOMAIN = exact("@research/domain");
const CONTRACTS = exact("@research/contracts");
const AGENT_CORE = exact("@research/agent-core");
const APPLICATION = exact("@research/application");
const UI_REGISTRY = exact("@research/ui-registry");
const EFFECTS = exact("@research/effects");
/** UI languages (ADR-0032): the framework-free core and its Solid binding. */
const I18N = exact("@research/i18n");
const I18N_SOLID = exact("@research/i18n/solid");
/** The reusable widget grid, by entry point: the Solid UI, the pure core, the agent layer. */
const WIDGET_GRID = exact("@research/widget-grid");
const WIDGET_GRID_CORE = exact("@research/widget-grid/core");
const WIDGET_GRID_AGENT = exact("@research/widget-grid/agent");
const WIDGET_GRID_STYLES = exact("@research/widget-grid/styles.css");

/** Adapter entry points by the runtime they can load in. */
const WORKER_ONLY_ADAPTERS = ["d1", "worker"] as const;
const NODE_ONLY_ADAPTERS = ["node", "providers", "tools", "finance", "sqlite", "google"] as const;
const RUNTIME_NEUTRAL_ADAPTERS = ["feed", "runtime", "sql"] as const;

const adapterEntry = (name: string) => exact(`@research/adapters/${name}`);

export const PACKAGE_RULES: readonly PackageRule[] = [
	{
		// Pure core: nothing but its own files. No npm packages, no node:*, no workspace packages.
		root: "packages/domain",
		allowed: [],
		forbidden: [],
		zones: [],
	},
	{
		root: "packages/contracts",
		allowed: [DOMAIN, pkg("zod")],
		forbidden: [],
		zones: [],
	},
	{
		root: "packages/agent-core",
		allowed: [CONTRACTS, DOMAIN, pkg("zod")],
		forbidden: [],
		zones: [],
	},
	{
		// The notebook assistant (ADR-0020) applies widget commands through the
		// widget-grid agent layer; the Solid entry stays out of reach.
		root: "packages/application",
		allowed: [DOMAIN, CONTRACTS, AGENT_CORE, WIDGET_GRID_CORE, WIDGET_GRID_AGENT, pkg("zod")],
		forbidden: [WIDGET_GRID, WIDGET_GRID_STYLES],
		zones: [],
	},
	{
		// UI languages (ADR-0032). The core (locales, catalogs) is plain
		// TypeScript; only the Solid binding may import the UI framework.
		root: "packages/i18n",
		allowed: [pkg("solid-js")],
		forbidden: [],
		zones: [],
	},
	{
		root: "packages/ui-registry",
		allowed: [CONTRACTS, DOMAIN, I18N, I18N_SOLID, pkg("solid-js"), pkg("zod")],
		forbidden: [],
		zones: [],
	},
	{
		// Independent and reusable (ADR-0019): no other workspace package, so
		// another application can take it as it is. `core` is pure TypeScript,
		// `agent` adds zod only, `solid` is the only place the UI framework
		// and the DOM appear.
		root: "packages/widget-grid",
		allowed: [pkg("solid-js"), pkg("zod")],
		forbidden: [],
		sourceDirectories: ["src/core", "src/agent", "src/solid"],
		zones: [
			{
				name: "widget-grid pure core",
				directories: ["src/core"],
				forbidden: [anyExternal(), nodeBuiltin()],
				forbiddenDirectories: ["src/agent", "src/solid"],
			},
			{
				name: "widget-grid agent layer",
				directories: ["src/agent"],
				forbidden: [pkg("solid-js"), nodeBuiltin()],
				forbiddenDirectories: ["src/solid"],
			},
		],
	},
	{
		root: "packages/effects",
		allowed: [DOMAIN, pkg("effect")],
		forbidden: [],
		zones: [],
	},
	{
		root: "packages/adapters",
		allowed: [APPLICATION, AGENT_CORE, CONTRACTS, DOMAIN, EFFECTS, anyExternal()],
		forbidden: [],
		// Every adapter file belongs to exactly one runtime directory. Without this, a helper
		// placed beside them could import node:* and be imported by Worker-safe code unnoticed.
		sourceDirectories: [
			...WORKER_ONLY_ADAPTERS,
			...RUNTIME_NEUTRAL_ADAPTERS,
			...NODE_ONLY_ADAPTERS,
		].map((name) => `src/${name}`),
		zones: [
			{
				// These directories are bundled into the Cloudflare Worker (or shared with it).
				name: "Worker-safe adapter",
				directories: [...WORKER_ONLY_ADAPTERS, ...RUNTIME_NEUTRAL_ADAPTERS].map(
					(name) => `src/${name}`,
				),
				forbidden: [nodeBuiltin()],
				forbiddenDirectories: NODE_ONLY_ADAPTERS.map((name) => `src/${name}`),
			},
		],
	},
	{
		root: "apps/api",
		allowed: [
			APPLICATION,
			CONTRACTS,
			DOMAIN,
			EFFECTS,
			...[...WORKER_ONLY_ADAPTERS, ...RUNTIME_NEUTRAL_ADAPTERS].map(adapterEntry),
			pkg("effect"),
			pkg("hono"),
			pkg("jose"),
			pkg("zod"),
			scheme("cloudflare:"),
		],
		forbidden: [
			nodeBuiltin(),
			pkg("solid-js"),
			...NODE_ONLY_ADAPTERS.map(adapterEntry),
			pkg("@research/agent-core"),
			pkg("@research/ui-registry"),
		],
		zones: [],
	},
	{
		root: "apps/runner",
		allowed: [
			AGENT_CORE,
			APPLICATION,
			CONTRACTS,
			DOMAIN,
			EFFECTS,
			...[...NODE_ONLY_ADAPTERS, ...RUNTIME_NEUTRAL_ADAPTERS].map(adapterEntry),
			scheme("node:"),
			pkg("effect"),
			pkg("zod"),
		],
		forbidden: [
			pkg("hono"),
			pkg("solid-js"),
			scheme("cloudflare:"),
			...WORKER_ONLY_ADAPTERS.map(adapterEntry),
		],
		zones: [],
	},
	{
		// CSS and asset imports are relative, which is always allowed inside the package.
		// Shoelace is allowed package-wide so the Home surface can use it;
		// only apps/web/src/home imports it, and the lazy Home chunk (measured
		// in the Phase C report) proves the other pages do not pay for it.
		root: "apps/web",
		allowed: [
			CONTRACTS,
			UI_REGISTRY,
			DOMAIN,
			I18N,
			I18N_SOLID,
			WIDGET_GRID,
			WIDGET_GRID_CORE,
			WIDGET_GRID_STYLES,
			pkg("solid-js"),
			pkg("zod"),
			pkg("@shoelace-style/shoelace"),
			// WYSIWYG rich-text editor (ADR-0021 task W4b): only
			// apps/web/src/notebook/richText imports these, and the lazy
			// editor chunk keeps them out of the initial load.
			pkg("prosemirror-model"),
			pkg("prosemirror-state"),
			pkg("prosemirror-view"),
			pkg("prosemirror-commands"),
			pkg("prosemirror-keymap"),
			pkg("prosemirror-history"),
			pkg("prosemirror-inputrules"),
			pkg("prosemirror-schema-list"),
		],
		forbidden: [
			pkg("hono"),
			nodeBuiltin(),
			pkg("@research/application"),
			pkg("@research/adapters"),
			pkg("@research/agent-core"),
		],
		zones: [],
	},
	{
		// The Home MCP server (ADR-0019): the agent layer over the owner API.
		// No Solid entry (it never renders), no application/adapters (it adds
		// no route and no use case: every edit goes through the existing API).
		root: "apps/mcp",
		allowed: [CONTRACTS, WIDGET_GRID_CORE, WIDGET_GRID_AGENT, pkg("zod"), scheme("node:")],
		forbidden: [pkg("solid-js"), pkg("hono"), WIDGET_GRID, APPLICATION, pkg("@research/adapters")],
		zones: [],
	},
];
