/**
 * How the page tools (`web.fetch_page`, `news.fetch_article`) reach a
 * publisher's page: one shared machinery, so both honour the site's
 * robots.txt, space their request starts to one host, and identify with the
 * same product token (docs/external-apis/apis/web-feeds-and-pages.md).
 *
 * - robots.txt is read (and cached per host for an hour) before the page and
 *   before every redirect hop is contacted, so no request reaches a path its
 *   site disallows (RFC 9309; ADR-0009).
 * - Request starts to one host stay at least a second apart (politeness).
 * - Every request carries `research-workspace/1.0 (…)`, the product token the
 *   robots rules are matched against.
 *
 * One instance is shared by both tools of a catalogue, so their robots cache
 * and spacing are one: a page tool cannot bypass the other's spacing.
 */
import type { ToolFailure } from "@research/agent-core";
import type { Clock, FetchedDocument, SafeFetchError, SafeFetcher } from "@research/application";
import { err, ok, parseUrl, type Result } from "@research/domain";
import {
	ALLOW_ALL,
	DISALLOW_ALL,
	isPathAllowed,
	parseRobotsTxt,
	type RobotsRules,
} from "./robotsPolicy.ts";
import { createKeyedTurns, fetchFailure, toolFailure } from "./shared.ts";

export interface PageAccessDeps {
	readonly fetcher: SafeFetcher;
	readonly clock: Clock;
	/** Wait that ends early when the run is aborted. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Names the product token used for robots; the model is never told this value. */
export const PAGE_USER_AGENT = "research-workspace/1.0 (personal research tool)";
/** The crawler token the robots rules are matched against. */
const ROBOTS_TOKEN = "research-workspace";
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_TIMEOUT_MS = 10_000;
const ROBOTS_ACCEPT = "text/plain";
/** At most 200 hosts in each per-host map: the robots cache (entries expire
 * after one hour) and the politeness timestamps (SEC-008 bounds payloads and
 * state). */
const ROBOTS_CACHE_MAX_HOSTS = 200;
const ROBOTS_CACHE_TTL_MS = 3_600_000;
/** Request starts to one host stay at least a second apart (politeness). */
const POLITENESS_INTERVAL_MS = 1_000;

interface RobotsCacheEntry {
	readonly rules: RobotsRules;
	readonly expiresAtMs: number;
}

/** One page request: its size, time and media-type bounds, and an optional host pin. */
export interface PageRequest {
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly accept: string;
	/** When set, the page and every redirect hop must be on this host (`allowedHosts`). */
	readonly pinnedHost: string | null;
}

/** A page that robots.txt allowed, with the final URL's host. */
export interface AllowedPage {
	readonly document: FetchedDocument;
	readonly finalHost: string;
}

export interface PageAccess {
	/**
	 * Fetches `target` after its robots.txt allowed it and its host's slot
	 * came; every redirect hop is robots-checked and spaced before it is
	 * contacted. Fails with `ROBOTS_DISALLOWED`, `TOOL_ABORTED`, `UNSAFE_URL`
	 * or the fetch failure.
	 */
	fetchPage(
		target: { readonly href: string; readonly hostname: string },
		request: PageRequest,
		signal: AbortSignal,
	): Promise<Result<AllowedPage, ToolFailure>>;
}

function pathAndQuery(href: string): string | null {
	const url = parseUrl(href);
	return url === null ? null : `${url.pathname}${url.search}`;
}

function hostOf(href: string): string | null {
	const url = parseUrl(href);
	return url === null ? null : url.hostname.toLowerCase().replace(/\.$/, "");
}

function cacheSet<Key, Entry>(
	cache: Map<Key, Entry>,
	key: Key,
	entry: Entry,
	maxHosts: number,
): void {
	if (!cache.has(key) && cache.size >= maxHosts) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, entry);
}

/** A robots.txt fetch failure becomes allow-all only for an explicit 4xx; everything else is disallow-all. */
function robotsFailureRules(error: SafeFetchError): RobotsRules {
	if (error.code === "HTTP_ERROR" && error.status >= 400 && error.status < 500) return ALLOW_ALL;
	return DISALLOW_ALL;
}

const aborted = (): ToolFailure => toolFailure("TOOL_ABORTED", "run was cancelled");
const disallowed = (host: string): ToolFailure =>
	toolFailure("ROBOTS_DISALLOWED", `robots.txt of ${host} disallows this page`);

export function createPageAccess(deps: PageAccessDeps): PageAccess {
	const robotsCache = new Map<string, RobotsCacheEntry>();
	const lastRequestMs = new Map<string, number>();
	const turns = createKeyedTurns();

	/**
	 * robots.txt of one host, fetched through the same fetcher and cached. Per
	 * RFC 9309: a 4xx answer means "no restrictions"; a 5xx answer, a timeout
	 * or a network error means "assume disallowed" (fail closed, ARCH-017).
	 * Any other fetch failure is disallowed too: only an explicit 4xx is
	 * evidence that the host answers without restrictions.
	 *
	 * Per RFC 9309 section 2.3.1.2 the fetch follows redirects — including to
	 * another host such as a public CDN — through the pinned fetcher (which
	 * re-validates every hop and stops after five) and the result is applied to
	 * the host that was asked, cached under that host. No `allowedHosts` pin
	 * is passed for exactly this reason; a same-host pin would turn any
	 * cross-host robots redirect into a spurious hour-long "disallow all".
	 */
	async function robotsFor(host: string, signal: AbortSignal): Promise<RobotsRules> {
		const nowMs = deps.clock.nowMs();
		const cached = robotsCache.get(host);
		if (cached !== undefined && nowMs < cached.expiresAtMs) return cached.rules;
		if (cached !== undefined) robotsCache.delete(host);
		const fetched = await deps.fetcher.fetchText(`https://${host}/robots.txt`, {
			maxBytes: ROBOTS_MAX_BYTES,
			timeoutMs: ROBOTS_TIMEOUT_MS,
			accept: ROBOTS_ACCEPT,
			signal,
			userAgent: PAGE_USER_AGENT,
		});
		// A run cancelled during the fetch learned nothing about the host: the
		// caller sees the abort, and nothing is cached for the next run.
		if (!fetched.ok && signal.aborted) return DISALLOW_ALL;
		const rules = fetched.ok
			? parseRobotsTxt(fetched.value.text, ROBOTS_TOKEN)
			: robotsFailureRules(fetched.error);
		cacheSet(
			robotsCache,
			host,
			{ rules, expiresAtMs: deps.clock.nowMs() + ROBOTS_CACHE_TTL_MS },
			ROBOTS_CACHE_MAX_HOSTS,
		);
		return rules;
	}

	/**
	 * Spaces request starts to one host at least a second apart (politeness).
	 * False when the run was aborted while waiting. Callers take turns per
	 * host (first come, first served, like the Rust ledger), so two concurrent
	 * requests never read the same last start and start together. Bounded like
	 * the robots cache: an entry older than the politeness interval can never
	 * cause a wait again, so evicting it loses nothing.
	 */
	async function politeWait(host: string, signal: AbortSignal): Promise<boolean> {
		const release = await turns.take(host, signal);
		if (release === null) return false;
		try {
			const nowMs = deps.clock.nowMs();
			const lastMs = lastRequestMs.get(host);
			if (lastMs !== undefined) {
				const waitMs = POLITENESS_INTERVAL_MS - (nowMs - lastMs);
				if (waitMs > 0) await deps.sleep(waitMs, signal);
				if (signal.aborted) return false;
			}
			cacheSet(lastRequestMs, host, deps.clock.nowMs(), ROBOTS_CACHE_MAX_HOSTS);
			return true;
		} finally {
			release();
		}
	}

	/**
	 * Authorizes one redirect hop before the fetcher contacts it: the hop's
	 * robots.txt is read (and cached) and its rules applied, so robots approval
	 * precedes every page request. A refusal ends the fetch with
	 * `REDIRECT_NOT_AUTHORIZED` before the hop is requested. Never throws.
	 */
	async function authorizeHop(
		href: string,
		pinnedHost: string | null,
		signal: AbortSignal,
	): Promise<boolean> {
		try {
			const hopHost = hostOf(href);
			const hopPath = pathAndQuery(href);
			if (hopHost === null || hopPath === null) return false;
			// A hop off the pinned host is refused by the fetcher's allowlist
			// (`HOST_NOT_ALLOWED`) before it is contacted: reading that host's
			// robots.txt first would be a request for nothing.
			if (pinnedHost !== null && hopHost !== pinnedHost.toLowerCase().replace(/\.$/, "")) {
				return true;
			}
			const hopRules = await robotsFor(hopHost, signal);
			if (signal.aborted) return false;
			if (!isPathAllowed(hopRules, hopPath)) return false;
			return politeWait(hopHost, signal);
		} catch {
			// Fail closed: a hop whose robots.txt could not be checked is not taken.
			return false;
		}
	}

	return {
		async fetchPage(target, request, signal) {
			const targetPath = pathAndQuery(target.href);
			if (targetPath === null) return err(toolFailure("UNSAFE_URL", "MALFORMED_URL"));
			const initialRules = await robotsFor(target.hostname, signal);
			if (signal.aborted) return err(aborted());
			if (!isPathAllowed(initialRules, targetPath)) return err(disallowed(target.hostname));
			if (!(await politeWait(target.hostname, signal))) return err(aborted());

			const fetched = await deps.fetcher.fetchText(target.href, {
				maxBytes: request.maxBytes,
				timeoutMs: request.timeoutMs,
				accept: request.accept,
				signal,
				...(request.pinnedHost === null ? {} : { allowedHosts: new Set([request.pinnedHost]) }),
				userAgent: PAGE_USER_AGENT,
				// Every redirect hop is robots-checked (and spaced) before it
				// is contacted; a refusal ends the fetch before the request.
				authorizeRedirect: (url) => authorizeHop(url, request.pinnedHost, signal),
			});
			if (!fetched.ok) return err(fetchFailure(fetched.error));

			const finalUrl = fetched.value.finalUrl;
			const finalHost = hostOf(finalUrl);
			const finalPath = pathAndQuery(finalUrl);
			if (finalHost === null || finalPath === null) {
				return err(toolFailure("UNSAFE_URL", "the final URL is malformed"));
			}
			if (finalHost !== target.hostname || finalPath !== targetPath) {
				// Every hop was already robots-checked before it was contacted;
				// this re-check (cached, no fetch) is belt and braces for a
				// fetcher that reports a final URL it was not asked to follow.
				cacheSet(lastRequestMs, finalHost, deps.clock.nowMs(), ROBOTS_CACHE_MAX_HOSTS);
				const finalRules = await robotsFor(finalHost, signal);
				if (signal.aborted) return err(aborted());
				if (!isPathAllowed(finalRules, finalPath)) return err(disallowed(finalHost));
			}
			return ok({ document: fetched.value, finalHost });
		},
	};
}
