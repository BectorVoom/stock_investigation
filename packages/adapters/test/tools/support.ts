/** Test doubles shared by the finance and tool tests. Nothing here touches the network. */
import { readFileSync } from "node:fs";
import type { ToolContext } from "@research/agent-core";
import type {
	Clock,
	FetchedDocument,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import type { SubscribedSourceRef } from "@research/contracts";
import { err, ok } from "@research/domain";

export function fixtureText(relativePath: string): string {
	return readFileSync(
		new URL(`../../../../examples/fixtures/${relativePath}`, import.meta.url),
		"utf8",
	);
}

export type ScriptedPage =
	| { readonly text: string; readonly contentType?: string; readonly finalUrl?: string }
	| { readonly error: SafeFetchError };

export interface ScriptedFetchCall {
	readonly url: string;
	readonly options: SafeFetchOptions;
}

export interface ScriptedFetcher extends SafeFetcher {
	readonly calls: ScriptedFetchCall[];
	readonly urls: () => readonly string[];
}

/**
 * A SafeFetcher that serves scripted pages and, like the real adapters,
 * refuses hosts outside `allowedHosts` — so a tool that forgets to pin its
 * hosts, or pins the wrong ones, fails its test.
 */
export function createScriptedFetcher(pages: {
	readonly [url: string]: ScriptedPage;
}): ScriptedFetcher {
	const calls: ScriptedFetchCall[] = [];
	return {
		calls,
		urls: () => calls.map((call) => call.url),
		async fetchText(url, options) {
			calls.push({ url, options });
			const host = new URL(url).hostname;
			if (options.allowedHosts !== undefined && !options.allowedHosts.has(host)) {
				return err({ code: "HOST_NOT_ALLOWED", detail: "host is not on the allowlist" });
			}
			const page = Object.hasOwn(pages, url) ? pages[url] : undefined;
			if (page === undefined) return err({ code: "HTTP_ERROR", detail: "HTTP 404" });
			if ("error" in page) return err(page.error);
			const document: FetchedDocument = {
				finalUrl: page.finalUrl ?? url,
				contentType: page.contentType ?? null,
				text: page.text,
			};
			return ok(document);
		},
	};
}

export const NOW_ISO = "2026-10-11T03:00:00.000Z";

export function fixedClock(iso: string = NOW_ISO): Clock {
	return { nowMs: () => Date.parse(iso), nowIso: () => iso };
}

export function createToolContext(
	subscribedSources: readonly SubscribedSourceRef[] = [],
	signal: AbortSignal = new AbortController().signal,
): ToolContext & { readonly allocatedIds: string[] } {
	const allocatedIds: string[] = [];
	let counter = 0;
	return {
		runId: "run_test",
		signal,
		nowIso: () => NOW_ISO,
		nextId: (prefix) => {
			counter += 1;
			const id = `run_test_${prefix}${counter}`;
			allocatedIds.push(id);
			return id;
		},
		subscribedSources,
		allocatedIds,
	};
}

export const SEC_USER_AGENT = "Synthetic Research Workspace owner@synthetic-wire.org";
