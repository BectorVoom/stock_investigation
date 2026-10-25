/** Captures the REAL tools and every dependency boundary used by their tests. */
import { appendFileSync } from "node:fs";
import type { ToolContext, ToolDefinition } from "@research/agent-core";
import type { Clock, Hasher, SafeFetcher } from "@research/application";
import {
	type NewsToolDeps,
	createNewsTools as news,
} from "../../../packages/adapters/src/tools/newsTools.ts";
import {
	ALLOW_ALL,
	isPathAllowed as allowed,
	DISALLOW_ALL,
	normalizeRobotsPath as normalize,
	parseRobotsTxt as parse,
} from "../../../packages/adapters/src/tools/robotsPolicy.ts";
import {
	type SearchToolDeps,
	createSearchTools as search,
} from "../../../packages/adapters/src/tools/searchTools.ts";
import {
	type WebToolDeps,
	createWebTools as web,
} from "../../../packages/adapters/src/tools/webTools.ts";
export { ALLOW_ALL, DISALLOW_ALL };
export type { NewsToolDeps, SearchToolDeps, WebToolDeps };
export { MAX_FEED_EVIDENCE_ITEMS } from "../../../packages/adapters/src/tools/newsTools.ts";
export type { RobotsRules } from "../../../packages/adapters/src/tools/robotsPolicy.ts";

let counter = 0;
const namespace = process.env.TOOLS_CAPTURE_NAMESPACE ?? "generated";
function emit(value: unknown): void {
	const file = process.env.TOOLS_CAPTURE_FILE;
	if (file !== undefined) appendFileSync(file, `${JSON.stringify(value)}\n`);
}
function capture<D extends { fetcher: SafeFetcher; hasher: Hasher; clock: Clock }>(
	kind: string,
	deps: D,
	factory: (deps: D) => readonly ToolDefinition[],
	/** Factory settings the replay needs to build the same tools. */
	settings: Readonly<Record<string, unknown>> = {},
): readonly ToolDefinition[] {
	const id = `${namespace}:${counter++}`;
	const fetches: unknown[] = [];
	const hashes: unknown[] = [];
	const milliseconds: number[] = [];
	const sleeps: unknown[] = [];
	const archives: unknown[] = [];
	const calls: unknown[] = [];
	const wrapped = {
		...deps,
		clock: {
			nowMs: () => {
				const value = deps.clock.nowMs();
				milliseconds.push(value);
				return value;
			},
			nowIso: () => deps.clock.nowIso(),
		},
		hasher: {
			sha256Hex: async (text: string) => {
				const output = await deps.hasher.sha256Hex(text);
				hashes.push({ text, output });
				return output;
			},
		},
		fetcher: {
			fetchText: async (url, options) => {
				const redirects: unknown[] = [];
				const entry = {
					url,
					options: {
						maxBytes: options.maxBytes,
						timeoutMs: options.timeoutMs,
						accept: options.accept,
						allowedHosts: options.allowedHosts === undefined ? null : [...options.allowedHosts],
						userAgent: options.userAgent ?? null,
						authorizeRedirect: options.authorizeRedirect !== undefined,
						authorization: options.authorization ?? null,
						jsonBody: options.jsonBody ?? null,
					},
					redirects,
					aborted: false,
					output: undefined as unknown,
				};
				fetches.push(entry);
				const output = await deps.fetcher.fetchText(url, {
					...options,
					...(options.authorizeRedirect === undefined
						? {}
						: {
								authorizeRedirect: async (href: string) => {
									const output = await options.authorizeRedirect?.(href);
									redirects.push({ url: href, output });
									return output === true;
								},
							}),
				});
				entry.output = output;
				entry.aborted = options.signal?.aborted === true;
				return output;
			},
		} satisfies SafeFetcher,
	};
	if ("sleep" in deps && typeof deps.sleep === "function") {
		const original = deps.sleep as SearchToolDeps["sleep"];
		Object.assign(wrapped, {
			sleep: async (ms: number, signal: AbortSignal) => {
				const entry = { ms, aborted: false };
				sleeps.push(entry);
				await original(ms, signal);
				entry.aborted = signal.aborted;
			},
		});
	}
	if ("pageArchive" in deps) {
		const original = (deps as D & WebToolDeps).pageArchive;
		Object.assign(wrapped, {
			pageArchive: {
				save: async (page: Parameters<WebToolDeps["pageArchive"]["save"]>[0]) => {
					const output = await original.save(page);
					archives.push({ page, output });
					return output;
				},
			},
		});
	}
	return factory(wrapped).map((tool) => ({
		...tool,
		async execute(args: unknown, context: ToolContext) {
			const times: string[] = [];
			const ids: { prefix: string; output: string }[] = [];
			const entry = {
				toolId: tool.toolId,
				args,
				sources: context.subscribedSources,
				cancelled: context.signal.aborted,
				times,
				ids,
				output: undefined as unknown,
			};
			calls.push(entry);
			const output = await tool.execute(args, {
				...context,
				nowIso: () => {
					const value = context.nowIso();
					times.push(value);
					return value;
				},
				nextId: (prefix) => {
					const output = context.nextId(prefix);
					ids.push({ prefix, output });
					return output;
				},
			});
			entry.output = output;
			// Evidence hashing runs concurrently, so its completion order is not
			// stable; the replay consumes hashes by content, so sort for determinism.
			const sortedHashes = [...hashes].sort((a, b) =>
				JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
			);
			emit({
				kind,
				...settings,
				id,
				calls,
				fetches,
				hashes: sortedHashes,
				milliseconds,
				sleeps,
				archives,
			});
			return output;
		},
	}));
}
export function createNewsTools(deps: NewsToolDeps): readonly ToolDefinition[] {
	return capture("news", deps, news);
}
export function createSearchTools(deps: SearchToolDeps): readonly ToolDefinition[] {
	return capture("search", deps, search, { tavilyApiKey: deps.tavilyApiKey });
}
export function createWebTools(deps: WebToolDeps): readonly ToolDefinition[] {
	return capture("web", deps, web);
}
export function parseRobotsTxt(text: string, token: string) {
	const output = parse(text, token);
	emit({ kind: "robots-parse", input: { text, token }, output });
	return output;
}
export function normalizeRobotsPath(text: string) {
	const output = normalize(text);
	emit({ kind: "robots-normalize", input: text, output });
	return output;
}
export function isPathAllowed(rules: Parameters<typeof allowed>[0], path: string) {
	const output = allowed(rules, path);
	emit({ kind: "robots-allowed", input: { rules, path }, output });
	return output;
}
