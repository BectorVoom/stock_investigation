# ADR-0009: Agent web access and the page archive

**Status:** Accepted · **Date:** 2026-10-12

## Context

The owner requires: "Have the AI agent access web pages and convert the retrieved data into Markdown files." Task 5a built the pieces (`htmlToMarkdown`, `robotsPolicy`, the `PageArchive`); this decision turns them into the `web.fetch_page` research tool.

This is the first tool whose destination is chosen by the model rather than fixed in code (news tools are confined to subscribed hosts; SEC tools to `sec.gov`). A model-proposed URL is a new capability with a new threat, so the tool is gated, bounded and licensed differently from the others.

## Decision

**Off unless the owner says otherwise.** The research request carries `webAccess: "off" | "public-web"` (default `"off"`; a stored request from before the field parses as `"off"`, fail closed, ARCH-017). The pipeline's permitted set excludes every tool whose `networkAllowlist.kind` is `"public-web"` when the request does not say `"public-web"`, and the planning prompt lists only permitted tools — a tool the run cannot use is not advertised. The web app's composer sends `"off"` for now; the settings page wires the owner's real value later.

**The model only proposes a URL.** The call still passes `authorizeToolCall` (registered? on this run's allowlist? within budget? schema-valid?) like every other tool (AGT-006). One page per call, no link following.

**One shared URL policy, the runner's fetcher underneath.** Only `https`, default port, no credentials, no IP literal, public addresses only: the URL goes through `validateFetchUrl` and the runner's pinned `SafeFetcher`, which re-validates every redirect hop (ADR-0005). No `allowedHosts` is passed — there is no fixed host to pin — so safety rests on the pinned fetcher plus the string policy.

**One host, spaced out, robots honoured before every request.** Requests to one host start at least a second apart; `robots.txt` of the target host is fetched through the same fetcher, parsed with `parseRobotsTxt(text, "research-workspace")`, and honoured. Every redirect hop is authorized the same way BEFORE it is contacted: the page fetch passes an `authorizeRedirect` callback through the shared `SafeFetcher` core that reads and caches the hop's robots rules and applies them (a refusal ends the fetch with `REDIRECT_NOT_AUTHORIZED` before the hop is requested), so no request reaches a path its site's robots.txt disallows. Per RFC 9309 a 4xx robots answer means "no restrictions"; a 5xx answer, a timeout or a network error means "assume disallowed". Rules are cached per host (at most 200 hosts, one-hour expiry). Per RFC 9309 section 2.3.1.2 a robots.txt redirect to another host (e.g. a public CDN) is followed through the pinned fetcher and the result applied to the host that was asked.

**Everything retrieved is untrusted data (SEC-001, AGT-007).** It is fenced, never interpreted, and cannot change which tools run or what they may reach. The page text is NOT stored in the database: licence terms of an arbitrary page are unknown, so `retainQuotes` is false and `excerpt` is null (DATA-010). The Markdown file stays on the owner's machine (`RUNNER_PAGES_DIR`, default `data/pages` under `bun run start`); without that directory the tool is not registered at all.

## The threat it adds, and what bounds it

A prompt injection in retrieved text can make the model propose a URL that carries what the model knows in its query string (the question and retrieved text — never credentials: prompts contain no secrets, SEC-005, and the URL length cap truncates exfiltration attempts). What bounds it:

- the off-switch: no web access, no tool, no request;
- `https` GET of exactly one page per call (no POST, no credentials, no file write beyond the archive);
- the URL length cap (2,048 characters);
- the per-run tool-call budget, checked before every call;
- no secrets in prompts, so there is nothing worth stealing in them.

Recorded as T17 in `docs/THREAT_MODEL.md`.

## Licensing

An arbitrary page's terms are unknown, so the workspace keeps the minimum: a Markdown cache on the owner's own machine, nothing in the database, `robots.txt` honoured, no crawling (one page per call, no link following, per-host spacing). A page whose terms the owner knows can still become a subscribed source; the web tool is for pages a retrieved source links to or names, not for building a corpus.

## What is NOT done

- No JavaScript rendering: pages that need a browser come back empty or partial.
- No PDF and no other binary format (HTML, XHTML and plain text only).
- No search engine: the tool fetches a URL it is given; it cannot discover pages.
- Publication dates are unknown: `publishedAt` is always null, and the model is told to treat undated material as possibly stale (DATA-002).
- A robots.txt redirect to another host (e.g. a public CDN) is followed through the pinned fetcher (at most five hops) and the result applied to the host that was asked (RFC 9309 section 2.3.1.2).
- The app cannot display the archived files: they are Markdown on the owner's disk, not workspace components. Deleting them is deleting files; turning web access off stops new ones.
- Main-content detection in `htmlToMarkdown` is heuristic, not exact: elements with a menu-like `role`, `aria-hidden="true"` or `hidden` are dropped with their subtrees.
- A `div`/`section`/`ul`/`ol`/`header` whose `id`/`class` carries a whole conventional token (`nav`, `menu`, `sidebar`, `footer`, …) is dropped outside main content.
- An `<a>` that differs from the page URL only by its fragment becomes plain text, and a skip-hint link is dropped entirely.
- Without a main element, a `ul`/`ol` of five or more items that are each exactly one link is dropped as a menu.
- Without a main element, the Markdown starts at the article `<h1>` (the single one, or the last one followed by 200 characters of paragraph text).
- Whitespace around inline emphasis and links is preserved outside the markers so `**Data source:** U.S.` keeps its space.
- Whatever the heuristics drop is counted (`boilerplateBlocks`, `menuLists`, `leadingBlocks`), stored in the archive front matter and named in the model text, so the cut is never silent.
- Motivating real run: three eia.gov "Today in Energy" articles saved as 14,923 / 13,673 / 19,965 bytes with 77 / 77 / 24 link-only list lines (38% / 42% / 9% of each file) and the article's own heading on line 48, so the 4,000-character model window showed mostly site menu instead of article text.

## Consequences

- Research runs can follow a citation to the cited page when the owner allows it; by default nothing changes.
- The runner writes outside the database for the first time (the archive directory), so backup means copying `data/` as before — the pages go with it.
- One more per-host fetcher (robots + spacing) shares the runner's network path; budgets and timeouts bound it like every other tool.
