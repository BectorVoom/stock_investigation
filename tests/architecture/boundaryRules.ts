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

/** Adapter entry points by the runtime they can load in. */
const WORKER_ONLY_ADAPTERS = ["d1", "worker"] as const;
const NODE_ONLY_ADAPTERS = ["node", "providers", "tools", "finance", "sqlite"] as const;
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
		root: "packages/application",
		allowed: [DOMAIN, CONTRACTS, AGENT_CORE, pkg("zod")],
		forbidden: [],
		zones: [],
	},
	{
		root: "packages/ui-registry",
		allowed: [CONTRACTS, DOMAIN, pkg("solid-js"), pkg("zod")],
		forbidden: [],
		zones: [],
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
			pkg("solid-js"),
			pkg("zod"),
			pkg("@shoelace-style/shoelace"),
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
];
