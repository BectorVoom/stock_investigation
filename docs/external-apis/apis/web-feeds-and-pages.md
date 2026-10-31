# External API: Web feeds and pages

## 1. Overview

| Property | Value |
|---|---|
| Provider | Any publisher on the open web: the owner's subscribed news sources (RSS 2.0, RSS 1.0 / RDF, Atom feeds) and the public pages the agent opens. Not one service: there is no key, quota or error contract beyond HTTP itself. |
| Purpose | News ingest of subscribed feeds (FR-003) and the `news.fetch_feed` / `news.fetch_article` research tools; checking a feed URL when the owner previews or adds a source on the Sources page; the `web.fetch_page` research tool, which reads one public page as Markdown into the page archive after honouring the site's `robots.txt` ([ADR-0009](../../adr/0009-agent-web-access-and-page-archive.md)). |
| Hosts | Owner-chosen `https` hosts (subscribed sources, URLs the owner enters on the Sources page, and pages the agent opens from retrieved results and cited URLs). The recommended sources are data in `packages/application/src/recommendedCatalog.ts`. |
| Endpoints | `GET <feed URL>` — an RSS or Atom feed (or, when checking a source, an HTML page that advertises one); `GET <page URL>` — one HTML or plain-text page; `GET /robots.txt` — the site's crawler rules, read before every `web.fetch_page` and `news.fetch_article` request |
| Authentication | None. No cookies are sent or kept. |
| Configuration | `RUNNER_PAGES_DIR` — where `web.fetch_page` archives pages (`data/pages/` by default); without it the tool is not registered. `web.fetch_page` is also advertised only when the run's request says `webAccess: "public-web"` (Settings → AI agent). The feed tools reach only the hosts of the owner's subscribed sources. |
| Usage Limits | Publishers set their own; we read RFC 9309 `robots.txt` for `web.fetch_page`. Ours: ingest fetches subscribed sources one at a time; `web.fetch_page` and `news.fetch_article` share one spacing that keeps request starts to one host at least 1 s apart, and fetch one page per tool call; source checks in the API Worker are limited to 40 per owner per hour (bucket `source-fetch`). Size and time caps per endpoint in section 4. |
| Called By | Rust runner (default) and TypeScript runner (rollback): `news-ingest` jobs, and the `news.fetch_feed`, `news.fetch_article` and `web.fetch_page` tools in `research` jobs. API Worker (`createWorkerSafeFetcher`): `POST /api/v1/sources/preview` and `POST /api/v1/sources` fetch the entered feed URL once (and one advertised feed). |
| Code | `crates/research-application/src/ingest.rs`, `crates/research-feed/src/lib.rs`, `crates/research-feed/src/tree.rs`, `crates/research-feed/src/validator.rs`, `crates/research-domain/src/news/feed.rs`, `crates/research-domain/src/news/canonical_url.rs`, `crates/research-tools/src/news.rs`, `crates/research-tools/src/web.rs`, `crates/research-tools/src/robots.rs`, `crates/research-tools/src/catalogue.rs`, `crates/research-html/src/converter.rs`, `crates/research-net/src/core.rs`, `crates/research-net/src/pinned.rs`, `crates/research-net/src/decode.rs`, `crates/research-net/src/charset.rs`, `crates/research-net/src/transport.rs`, `crates/research-net/src/archive.rs`, `packages/application/src/ingest.ts`, `packages/application/src/sources.ts`, `packages/domain/src/news/feed.ts`, `packages/domain/src/news/canonicalUrl.ts`, `packages/adapters/src/feed/index.ts`, `packages/adapters/src/feed/xmlTree.ts`, `packages/adapters/src/tools/newsTools.ts`, `packages/adapters/src/tools/webTools.ts`, `packages/adapters/src/tools/pageAccess.ts`, `packages/adapters/src/tools/robotsPolicy.ts`, `packages/adapters/src/tools/index.ts`, `packages/adapters/src/tools/htmlToMarkdown.ts`, `packages/adapters/src/tools/shared.ts`, `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/runtime/charset.ts`, `packages/adapters/src/worker/index.ts`, `packages/adapters/src/node/index.ts`, `packages/adapters/src/node/pinnedConnect.ts`, `packages/adapters/src/node/pageArchive.ts`, `apps/runner/src/jobExecution.ts` |
| Official Documentation | [RSS 2.0 specification](https://www.rssboard.org/rss-specification), [RSS 1.0 specification](https://web.resource.org/rss/1.0/spec), [RFC 4287 The Atom Syndication Format](https://www.rfc-editor.org/rfc/rfc4287), [Dublin Core elements (`dc:date`)](https://www.dublincore.org/specifications/dublin-core/dces/), [RSS content module (`content:encoded`)](https://web.resource.org/rss/1.0/modules/content/), [RFC 9309 Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309), [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) |
| Last Verified | 2026-10-31, live (section 7) |

Every request goes through the safe fetcher (SEC-002): `https` only, default port, no credentials or IP literals, every DNS answer must be public and the connection is pinned to a validated address (runner; the Worker relies on the string policy and Cloudflare's egress), redirects are followed by hand at most 5 hops with every hop re-validated, and bodies are bounded before and after decoding. A **subscribed feed** (ingest, `news.fetch_feed`) is fetched from its registered host only — a redirect to another host is refused (`HOST_NOT_ALLOWED`); the Worker's **source check** passes no host allowlist, so the entered URL may redirect to any public host and the feed a page advertises may be on another public host. The feed is parsed with entity expansion off, and normalised into articles: plain-text title, canonical `https` link, UTC publication time, and an excerpt only where the source's licence allows (DATA-010). A **page** for `web.fetch_page` or `news.fetch_article` is fetched only after the site's `robots.txt` allows it — and again for every redirect hop before that hop is contacted — and after its host's 1 s spacing slot; both tools go through one shared machinery (`pageAccess.ts`, Rust `PageAccess` in `web.rs`) with one robots cache and one spacing. `web.fetch_page` converts the page to Markdown, archives it on the owner's machine and cites it as evidence without storing any of its text; `news.fetch_article` stays pinned to a subscribed source's host (a redirect elsewhere is `HOST_NOT_ALLOWED`, and that host's `robots.txt` is not read) and reads the page as plain text.

## 2. Input Parameters

All three endpoints are plain `GET` requests with only these headers; no query string of ours, no conditional request (`If-None-Match`, `If-Modified-Since` are never sent), no cookies.

### GET <feed URL>

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| (URL) | path | string | Yes | — ; the source's stored `canonical_url` (runner), or the URL the owner typed, trimmed (Worker) | `https`, default port, no credentials, public host name; ≤ 2,048 characters for the tools | The feed. |
| `Accept` | header | string | No | We send `application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8` (runner, `FEED_LIMITS.accept`); the Worker's source check adds `, text/html;q=0.5` | Printable ASCII | Prefers feed media types; the check also accepts an HTML page to look for an advertised feed. The parser decides by content, not by `Content-Type`. |
| `User-Agent` | header | string | No | We send `stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)` (`DEFAULT_USER_AGENT`) | Printable ASCII | The application's fixed identification. |
| `Accept-Encoding` | header | string | No | Runner: `gzip`; Worker: chosen by the Workers runtime | `gzip` | Runner counts encoded bytes against the size cap; `gzip`, `x-gzip`, `deflate`, `br` and identity are decoded, any other encoding fails. |
| `Host` | header | string | Yes | The URL's host name | — | Virtual hosting; TLS is verified against this name. |

### GET <page URL>

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| (URL) | path | string | Yes | — ; the model's `url` argument, normalised by `validateFetchUrl` | `https`, default port, no credentials, public host; ≤ 2,048 characters. `news.fetch_article`: the host must be the host of a subscribed source. | The page. |
| `Accept` | header | string | No | We send `text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5` | Printable ASCII | HTML preferred, plain text accepted. |
| `User-Agent` | header | string | No | We send `research-workspace/1.0 (personal research tool)` (`PAGE_USER_AGENT`), from both `web.fetch_page` and `news.fetch_article` | Printable ASCII | Identifies with the product token the `robots.txt` rules are matched against (`research-workspace`). |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | As above. |
| `Host` | header | string | Yes | The URL's host name | — | As above. |

### GET /robots.txt

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| (URL) | path | string | Yes | `https://<host>/robots.txt` for the page's host and for every redirect hop's host (`news.fetch_article`: hops on its pinned host only) | — | RFC 9309 location. |
| `Accept` | header | string | No | We send `text/plain` | — | The file's media type. |
| `User-Agent` | header | string | No | We send `research-workspace/1.0 (personal research tool)` | Printable ASCII | Same identity as the page request. |
| `Accept-Encoding` | header | string | No | We send `gzip` | `gzip` | As above. |

## 3. Output Parameters

Response headers read on every endpoint: the status line, `Location` (redirects), `Content-Type` (pages: decides HTML / text / unsupported; feeds and `robots.txt`: ignored), `Content-Length` (a declared size over the cap fails before reading), `Content-Encoding` (decoder choice) and `Connection` (Rust keep-alive). Every body is decoded by the charset it declares, the first that names an encoding the decoder knows: a byte-order mark (UTF-8, UTF-16LE, UTF-16BE; dropped), the `charset` parameter of `Content-Type`, then in the first 1,024 bytes an XML declaration's `encoding` (only at the very start) or the `charset` of the first `<meta>` that has one (`<meta charset>` or `http-equiv` … `content="…; charset=…"`); otherwise UTF-8. An unknown label (or WHATWG's "replacement" encoding) is skipped and the next source is read, as the WHATWG rules do: an unknown `Content-Type` charset does not mean UTF-8 when the document itself declares a known encoding; only when no source names a known encoding is the body UTF-8. Labels are those of the WHATWG Encoding Standard (`Shift_JIS`, `EUC-JP`, `ISO-8859-1` = windows-1252, …); decoding is non-fatal (U+FFFD for an invalid sequence). The byte caps apply to the bytes before decoding. Both runners and the API Worker's source check decode alike (`packages/adapters/src/runtime/charset.ts` in `safeFetchCore.ts`, Rust `crates/research-net/src/charset.rs` with `encoding_rs`).

### GET <feed URL>

XML. The parser (`createFeedParser`, Rust `research_feed`) rejects input over 2,000,000 bytes, input that is not well-formed XML, and nesting deeper than 64 elements; entities other than the five predefined ones and numeric references are not expanded, and a DOCTYPE never is. The root decides the format: `rss` → RSS 2.0, `rdf:RDF` → RSS 1.0, `feed` (or `atom:feed`) with a `title`, `entry` or `id` child → Atom; anything else is `NOT_A_FEED`. Element names are matched literally: Atom elements bare or with the `atom:` prefix, `dc:` and `content:` with those prefixes. Text is trimmed; CDATA is taken literally. Elements are listed as the specifications define them for a channel and an item; "Optional" follows the specification, "Read" is our code.

RSS 2.0 (`/rss/channel`):

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `rss@version` | attribute | No | No | No | `2.0`. |
| `channel/title` | text | No | No | Yes | Feed name; suggested publisher when the owner adds the source (≤ 2,000 characters read, 300 kept). |
| `channel/link` | text | No | No | Yes | Site URL; shown as the source's site link in the preview. |
| `channel/description` | text | No | No | No | Feed description. |
| `channel/language`, `copyright`, `managingEditor`, `webMaster`, `pubDate`, `lastBuildDate`, `category`, `generator`, `docs`, `cloud`, `ttl`, `image`, `rating`, `textInput`, `skipHours`, `skipDays` | elements | No | Yes | No | Optional channel elements; `ttl`, `skipHours` and `skipDays` do not change our schedule. |
| `channel/item` | element (0..n) | No | Yes | Yes | One story; at most 100 are examined per fetch. |
| `item/title` | text | No | Yes (title or description required) | Yes | Headline; an item without one is rejected (`MISSING_TITLE`). |
| `item/link` | text | No | Yes | Yes | Article URL; first choice for the link. |
| `item/description` | text (HTML allowed) | No | Yes | Yes | Summary; first choice for the excerpt. |
| `item/author` | text | No | Yes | No | Author e-mail. |
| `item/category` | text (0..n) | No | Yes | No | Categories. |
| `item/comments` | text | No | Yes | No | Comments page URL. |
| `item/enclosure` | element (`url`, `length`, `type`) | No | Yes | No | Attached media. |
| `item/guid` | text | No | Yes | Yes | Unique id; used as the link when `link` is missing, `isPermaLink` is not `false` and it starts with `http(s)://`. |
| `item/guid@isPermaLink` | attribute | No | Yes | Yes | Default `true`. |
| `item/pubDate` | text (RFC 822) | No | Yes | Yes | Publication time; first choice for the date. |
| `item/source` | element | No | Yes | No | Originating channel. |
| `item/dc:date` | text (ISO 8601) | No | Yes | Yes | Dublin Core date; used when `pubDate` is missing. |
| `item/content:encoded` | text (HTML) | No | Yes | Yes | Full content; used as the summary when `description` is missing. |
| `item/atom:link@href` (`rel` absent or `alternate`) | attribute | No | Yes | Yes | Last fallback for the link. |
| other extension elements (`media:*`, `slash:*`, `wfw:*`, …) | elements | No | Yes | No | Ignored. |

RSS 1.0 / RDF (`/rdf:RDF`): the `item` elements are siblings of `channel`, and the RSS 2.0 rules above apply to them.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `channel@rdf:about` | attribute | No | No | No | Channel URI. |
| `channel/title`, `channel/link` | text | No | No | Yes | As RSS 2.0. |
| `channel/description` | text | No | No | No | Description. |
| `channel/items/rdf:Seq/rdf:li@rdf:resource` | attributes | No | No | No | The item order; items are read in document order instead. |
| `channel/image`, `channel/textinput`, `/rdf:RDF/image`, `/rdf:RDF/textinput` | elements | No | Yes | No | Images and text input. |
| `/rdf:RDF/item` | element (1..15 per spec; any number read) | No | No | Yes | One story; at most 100 examined. |
| `item@rdf:about` | attribute | No | No | No | Item URI (usually the link). |
| `item/title` | text | No | No | Yes | Headline. |
| `item/link` | text | No | No | Yes | Article URL. Surrounding whitespace is trimmed (live: `…/index.html `). |
| `item/description` | text | No | Yes | Yes | Summary. |
| `item/dc:date` | text (W3C-DTF / ISO 8601) | No | Yes | Yes | Publication time. |
| `item/dc:creator`, `item/dc:subject`, other `dc:` / module elements | text | No | Yes | No | Ignored. |

Atom (`/feed`, RFC 4287):

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `feed/id` | IRI | No | No | Yes | Only used to recognise the document as Atom. |
| `feed/title` | text construct | No | No | Yes | Feed name, as `channel/title`. |
| `feed/updated` | date | No | No | No | Last update. |
| `feed/link@href` (`rel` absent or `alternate`) | attribute | No | Yes | Yes | Site URL; chosen like `entry/link@href` below. |
| `feed/author`, `category`, `contributor`, `generator`, `icon`, `logo`, `rights`, `subtitle` | elements | No | Yes | No | Ignored. |
| `feed/entry` | element (0..n) | No | Yes | Yes | One story; at most 100 examined. |
| `entry/id` | IRI | No | No | No | Entry id. |
| `entry/title` | text construct | No | No | Yes | Headline; its markup (`type="html"`) is reduced to text. |
| `entry/updated` | date (RFC 3339) | No | No | Yes | Used as the date when `published` is missing. |
| `entry/published` | date (RFC 3339) | No | Yes | Yes | Publication time; first choice. |
| `entry/link@href` (`rel` absent or `alternate`) | attribute | No | Yes | Yes | Article URL; the first such link whose `href` is usable — not empty after trimming, ≤ 4,096 UTF-16 units, and accepted by the article URL policy normalisation applies (`canonicalizeArticleUrl` / `canonicalize_article_url`: `https`, public host, …). An unusable one (`javascript:`, `http:`, a private address, …) is skipped and the next tried. Links with another `rel` (`self`, `enclosure`, …) are ignored. |
| `entry/summary` | text construct | No | Yes | Yes | Summary; first choice for the excerpt. |
| `entry/content` | content construct | No | Yes | Yes | Used when `summary` is missing. `src` (out-of-line content) is not followed. |
| `entry/author`, `category`, `contributor`, `rights`, `source` | elements | No | Yes | No | Ignored. |

When the owner checks a source and the body is not a feed, the Worker reads the page's first `<link rel="alternate" type="application/rss+xml|application/atom+xml" href>` and fetches that URL once.

### GET <page URL>

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `Content-Type` | header | No | Yes | Yes | `web.fetch_page`: `text/plain` → plain text; `text/html` / `application/xhtml+xml` or absent → HTML; anything else → `UNSUPPORTED_CONTENT_TYPE`. `news.fetch_article`: HTML, XHTML, plain text or absent accepted. |
| `<title>` | element | No | Yes | Yes | Page title (`web.fetch_page`: else the first `<h1>`; whitespace collapsed, ≤ 300 characters). |
| `<meta property="article:published_time" content>` | attribute | No | Yes | Yes (`news.fetch_article` only) | Publication time when it parses as ISO 8601; `web.fetch_page` never dates a page. |
| `<body>` content | elements | No | No | Yes | `web.fetch_page`: converted to Markdown — headings, paragraphs, lists, tables, block quotes, code, emphasis and links (resolved against the final URL); `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `iframe`, `object`, `embed`, `form` and its controls, `nav`, `footer`, `aside` and comments are dropped with their content; boilerplate blocks, link-only menu lists and leading chrome before the article are dropped heuristically and counted; ≤ 20,000 characters. `news.fetch_article`: all text, tags stripped (`toPlainText`). |
| other `<head>` elements (`meta`, `link`, `script`, …) | elements | No | Yes | No | Ignored. |

### GET /robots.txt

`text/plain` lines, RFC 9309. Two limits: the fetch fails with `RESPONSE_TOO_LARGE` when the body passes 512 KiB (524,288 bytes, wire or decoded), and that failure — like every non-4xx failure — makes the host disallow-all for an hour (fail closed). A body that fetched successfully is cut to its first 500 Ki UTF-16 code units (512,000) and, when cut, back to the last complete line, so a rule is never read half; lines over 2,000 characters are ignored, `#` starts a comment.

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `user-agent:` | line | No | No | Yes | Starts a group. RFC 9309 §2.2.1 product-token match: a group whose value equals our token `research-workspace` case-insensitively wins over `*` (`research` or `research-workspace/1.0` does not match); same-token groups merge; without such a group the `*` group applies. |
| `allow:` / `disallow:` | line | No | Yes | Yes | Path patterns with `*` and a trailing `$`; percent-encoding normalised; the longest match wins, `allow` wins a tie; an empty value is no rule. |
| `sitemap:`, `crawl-delay:`, unknown lines | line | No | Yes | No | Ignored (`crawl-delay` does not change the 1 s spacing). |

`/robots.txt` itself is always allowed.

## 4. Error Handling

### HTTP status codes

The safe fetcher turns every answer into one result; the status of an error answer travels unchanged ([§4a](../../rule/error_handling.md), [ADR-0037](../../adr/0037-external-service-errors-keep-their-status.md)).

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| 2xx | Success | Body read within the caps; feed parsed / page converted / robots parsed. | — |
| 301, 302, 303, 307, 308 | Moved | Followed by hand with `GET`: the `Location` (relative ones resolved) gets the full URL policy and allowlist again; a subscribed feed's redirect must stay on its registered host, while the Worker's source check (and `robots.txt`, RFC 9309) may follow it to any public host; `web.fetch_page` reads the hop's `robots.txt` and waits its 1 s slot before contacting it. Without `Location` → `HTTP_ERROR` with the status. | `UNSAFE_REDIRECT`, `HOST_NOT_ALLOWED`, `REDIRECT_NOT_AUTHORIZED`, `TOO_MANY_REDIRECTS` (6th redirect or a loop) |
| 4xx, 5xx, other | Error | Body discarded unread. Feeds: the source's fetch report keeps the code and status (`news_sources.last_error_code`, `last_error_upstream_status`, `feed_status = failing`); the Worker's source check answers `FETCH_FAILED` with the feed host's status. Tools: the call fails, retryable for 429 and 5xx. `robots.txt`: 4xx → no restrictions (RFC 9309 "unavailable"); 5xx or any other failure → everything disallowed (RFC 9309 "unreachable", fail closed). | `HTTP_ERROR` (status kept) |
| 200, not a feed | HTML page, truncated or malformed XML | Ingest and `news.fetch_feed`: `NOT_A_FEED`, no status. Source check: looks for an advertised feed once, else `NOT_A_FEED`. | `NOT_A_FEED` |
| 200, page with another type or no text | PDF, image, empty page | `web.fetch_page`: `UNSUPPORTED_CONTENT_TYPE` / `EMPTY_PAGE`; `news.fetch_article`: `UNSUPPORTED_CONTENT_TYPE` / `EMPTY_DOCUMENT`. | as named |
| — | `robots.txt` disallows the page or a redirect hop (`web.fetch_page`, `news.fetch_article`) | `ROBOTS_DISALLOWED` (target) or `REDIRECT_NOT_AUTHORIZED` (hop); nothing is requested from the refused path. | `ROBOTS_DISALLOWED`, `REDIRECT_NOT_AUTHORIZED` |
| — | URL fails the policy (http, IP literal, private address, port, credentials) or every DNS answer is not public | Nothing is sent. Worker source check maps these to `UNSAFE_URL`. | `UNSAFE_URL`, `UNSAFE_REDIRECT`, `HOST_NOT_SUBSCRIBED` (`news.fetch_article`), `SOURCE_NOT_SUBSCRIBED` (`news.fetch_feed`) |
| — | Archive write failed | The page is not cited. | `ARCHIVE_WRITE_FAILED` |

### Provider error codes and body

None: publishers answer with HTTP statuses; error pages (usually HTML) are never read.

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | Whole request including body: feeds 15 s, pages 15 s, `robots.txt` 10 s; tool budgets `news.fetch_feed` 25 s, `news.fetch_article` and `web.fetch_page` 40 s (robots + spacing + page). No separate connect timeout. | `packages/application/src/ingest.ts`, `crates/research-application/src/ingest.rs`, `packages/adapters/src/tools/webTools.ts`, `crates/research-tools/src/web.rs`, `packages/adapters/src/tools/newsTools.ts`, `crates/research-tools/src/news.rs` |
| Size caps | Feeds 1,000,000 bytes (runner), 300,000 (Worker check), parser 2,000,000; pages 2,000,000; `robots.txt` 512 KiB. Applied to wire bytes and to decoded bytes (runner; the Worker counts decoded bytes only) → `RESPONSE_TOO_LARGE`. Response headers over 16 KiB fail. | `packages/adapters/src/worker/safeFetchCore.ts`, `packages/adapters/src/node/pinnedConnect.ts`, `crates/research-net/src/pinned.rs`, `packages/adapters/src/feed/index.ts` |
| Retries | No application retry; a failed source waits for the next ingest. Transport level, both runners: when an attempt fails before a response arrives (connect, TLS or a dropped connection), the same GET is sent to the next of at most 3 validated addresses of the host. Rust only: when a reused idle keep-alive connection turns out to be closed before any response byte, the GET is sent once more on a fresh connection to the same address. | `packages/adapters/src/node/index.ts`, `crates/research-net/src/transport.rs`, `crates/research-net/src/pinned.rs` |
| Rate limit | Ingest: one source at a time. `web.fetch_page` and `news.fetch_article` together: request starts to one host ≥ 1 s apart (one shared record of ≤ 200 hosts); concurrent callers for one host take turns, first come, first served (TypeScript `createKeyedTurns`, Rust `Ledger`), and a caller cancelled while waiting leaves its place. Worker: 40 source checks per owner per hour (`RATE_LIMITED`). `429` / `Retry-After` from publishers is not specially handled. | `packages/application/src/ingest.ts`, `packages/adapters/src/tools/webTools.ts`, `crates/research-tools/src/web.rs`, `packages/application/src/sources.ts` |
| Cache | `robots.txt` rules (including the allow-all / disallow-all fallbacks) per host for 1 hour, ≤ 200 hosts, in memory, shared by `web.fetch_page` and `news.fetch_article`. A robots fetch that failed because the run was cancelled is not cached (the call ends `TOOL_ABORTED`; the next run reads the file again). Feeds and pages are not cached; articles are de-duplicated when stored. | `packages/adapters/src/tools/webTools.ts`, `crates/research-tools/src/web.rs` |
| Fallback | A failing source is reported and the others continue; the Sources page shows the source as failing with its code and status. A failed tool call is reported to the model, which may use another source. | `packages/application/src/ingest.ts`, `crates/research-application/src/ingest.rs` |

## 5. Examples

### GET <feed URL>

Request (news ingest of the recommended Federal Reserve source, TypeScript runner; the Rust runner sends the same headers without `Connection: close`):

```http
GET /feeds/press_all.xml HTTP/1.1
Host: www.federalreserve.gov
Accept: application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8
User-Agent: stock-investigation-research/0.1 (single-owner research workspace; automated read-only fetch)
Accept-Encoding: gzip
Connection: close
```

Verified: live, 2026-10-31, `curl --http1.1 --compressed` with the `Accept` and `User-Agent` above.

Response (RSS 2.0):

```http
HTTP/1.1 200 OK
Content-Type: text/xml
Transfer-Encoding: chunked
ETag: W/"4654ee50e467dd1:0"
Last-Modified: Thu, 29 Oct 2026 20:30:19 GMT
Content-Encoding: gzip
```

<!-- example: web-feeds-rss-fed-press -->
```xml
<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0">
    <channel>
        <title>FRB: Press Release - All Releases</title>
        <link><![CDATA[https://www.federalreserve.gov/feeds/feeds.htm]]></link>
        <description><![CDATA[All recent press releases from the Federal Reserve Board]]></description>
        <language>en</language>
        <item>
            <title>Federal Reserve Board announces approval of application by The Bank of Nova Scotia</title>
            <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/orders20261029a.htm]]></link>
            <guid><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/orders20261029a.htm]]></guid>
            <description><![CDATA[Federal Reserve Board announces approval of application by The Bank of Nova Scotia]]></description>
            <category>Orders on Banking Applications</category>
            <pubDate><![CDATA[Thu, 29 Oct 2026 20:30:00 GMT]]></pubDate>    
        </item>
        <item>
            <title>Federal Reserve issues FOMC statement</title>
            <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm]]></link>
            <guid><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm]]></guid>
            <description><![CDATA[Federal Reserve issues FOMC statement]]></description>
            <category>Monetary Policy</category>
            <pubDate><![CDATA[Wed, 28 Oct 2026 18:00:00 GMT]]></pubDate>    
        </item>
        <!-- … 18 more items omitted … -->
    </channel>
</rss>
```

Verified: live, 2026-10-31, `curl` of the request above (`https://www.federalreserve.gov/feeds/press_all.xml`). 2 of 20 items kept, the omission marked; the leading byte-order mark dropped and CRLF line ends written as LF (the decoder drops the mark; the parser treats both line ends alike); headers `Date`, `Connection`, `CF-*`, `Age`, `set-cookie`, `Server`, `Strict-Transport-Security`, `X-Frame-Options` omitted.

Response (RSS 1.0 / RDF, recommended Cabinet Office source `https://www.cao.go.jp/rss/news.rdf`, same request headers):

```http
HTTP/1.1 200 OK
Content-Type: text/xml; charset=utf-8
Transfer-Encoding: chunked
ETag: W/"1892-65f0a71885623"
Last-Modified: Fri, 30 Oct 2026 08:18:39 GMT
Content-Encoding: gzip
```

<!-- example: web-feeds-rdf-cao -->
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns="http://purl.org/rss/1.0/"
 xmlns:taxo="http://purl.org/rss/1.0/modules/taxonomy/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:syn="http://purl.org/rss/1.0/modules/syndication/"
 xmlns:admin="http://webns.net/mvcb/"
>
<channel rdf:about="https://www.cao.go.jp/">
  <title>内閣府 報道発表新着情報</title>
  <link>https://www.cao.go.jp/</link>
  <description>内閣府 報道発表新着情報 RSS</description>
  <dc:language>ja</dc:language>
  <items>
    <rdf:Seq>
      <rdf:li rdf:resource="https://survey.gov-online.go.jp" />
      <rdf:li rdf:resource="https://www.cao.go.jp/consumer/kabusoshiki/ai_technology/013/shiryou/index.html " />
      <!-- … 8 more rdf:li omitted … -->
    </rdf:Seq>
  </items>
  <image rdf:resource="https://www.cao.go.jp/common4/img/logo_pc.svg" />
</channel>
<image rdf:about="https://www.cao.go.jp/common4/img/logo_pc.svg">
  <title>内閣府画像</title>
  <url>https://www.cao.go.jp/common4/img/logo_pc.svg</url>
  <link>https://www.cao.go.jp/</link>
</image>
<item rdf:about="https://survey.gov-online.go.jp">
  <title><![CDATA[国民生活に関する世論調査]]></title>
  <link>https://survey.gov-online.go.jp</link>
  <dc:creator>内閣府</dc:creator>
  <dc:date>2026-10-30T16:28:00+09:00</dc:date>
  <dc:subject>調査報告 大臣官房政府広報室</dc:subject>
</item>
<item rdf:about="https://www.cao.go.jp/consumer/kabusoshiki/ai_technology/013/shiryou/index.html ">
  <title><![CDATA[第13回人工知能（AI）技術の利用と消費者問題に関する専門調査会【10月29日開催】]]></title>
  <link>https://www.cao.go.jp/consumer/kabusoshiki/ai_technology/013/shiryou/index.html </link>
  <dc:creator>内閣府</dc:creator>
  <dc:date>2026-10-30T15:22:00+09:00</dc:date>
  <dc:subject>会議資料 消費者委員会事務局</dc:subject>
</item>
<!-- … 8 more items omitted … -->
</rdf:RDF>
```

Verified: live, 2026-10-31, `curl --http1.1 --compressed https://www.cao.go.jp/rss/news.rdf` with the feed `Accept` and `User-Agent`. 2 of 10 items and 2 of 10 `rdf:li` kept, omissions marked; CRLF written as LF; headers `Server`, `Date`, `Connection`, `Vary`, `X-Frame-Options`, `X-Content-Type-Options`, `Cache-Status` omitted.

Response (Atom). None of the recommended sources checked serves Atom (21 of the 30 on 2026-10-31, all RSS 2.0 or RDF; the SEC feed was not called by owner decision), so this is the example of RFC 4287 §1.1:

<!-- example: web-feeds-atom-rfc4287 -->
```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">

  <title>Example Feed</title>
  <link href="http://example.org/"/>
  <updated>2003-12-13T18:30:02Z</updated>
  <author>
    <name>John Doe</name>
  </author>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>

  <entry>
    <title>Atom-Powered Robots Run Amok</title>
    <link href="http://example.org/2003/12/13/atom03"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2003-12-13T18:30:02Z</updated>
    <summary>Some text.</summary>
  </entry>

</feed>
```

Verified: spec, 2026-10-31, https://www.rfc-editor.org/rfc/rfc4287#section-1.1 (verbatim). The parser reads it but skips the entry's only alternate link (`http`, refused by the article URL policy), so normalisation rejects the entry for having no link (`MISSING_LINK`).

### GET <page URL>

Request (`web.fetch_page` for a page linked from the Federal Reserve feed, TypeScript runner; sent after `GET /robots.txt` below allowed it):

```http
GET /newsevents/pressreleases/monetary20261028a.htm HTTP/1.1
Host: www.federalreserve.gov
Accept: text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5
User-Agent: research-workspace/1.0 (personal research tool)
Accept-Encoding: gzip
Connection: close
```

Verified: live, 2026-10-31, `curl --http1.1 --compressed` with the `Accept` and `User-Agent` above.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/html
Transfer-Encoding: chunked
Last-Modified: Wed, 28 Oct 2026 18:00:18 GMT
Content-Encoding: gzip
```

<!-- example: web-feeds-page-fed-press -->
```html
<!doctype html>
<html lang="en" class="no-js">
<head>
<!-- … -->
    <title>Federal Reserve Board - Federal Reserve issues FOMC statement</title>
<!-- … -->
<body ng-app="pubwebApp">
<!-- … -->
        <div id="article">
            <div class="heading col-xs-12 col-sm-8 col-md-8">
                
                <p class="article__time">October 28, 2026</p>
                <h3 class="title">Federal Reserve issues FOMC statement</h3>              
<!-- … -->
                <p>The Federal Open Market Committee approved the following statement for release by a 10 – 2 vote:</p>

<p>The Committee decided to maintain the target range for the federal funds rate at 3-3/4 to 4 percent, in support of the Federal Reserve's dual mandate. The Committee is continuing its policy of maintaining ample reserves in the banking system.</p>
<!-- … -->
</html>
```

Verified: live, 2026-10-31, `curl` of the request above (85,160 bytes decoded). Whole lines kept from 1,596, each omission marked `<!-- … -->` (the page itself has no `</head>` or `</body>`); byte-order mark dropped and CRLF written as LF; headers `Date`, `Connection`, `CF-*`, `Server`, `Strict-Transport-Security`, `X-Frame-Options` omitted.

### GET /robots.txt

Request (before a `web.fetch_page` request to `www.nist.gov`):

```http
GET /robots.txt HTTP/1.1
Host: www.nist.gov
Accept: text/plain
User-Agent: research-workspace/1.0 (personal research tool)
Accept-Encoding: gzip
Connection: close
```

Verified: live, 2026-10-31, `curl --http1.1 --compressed` with the `Accept` and `User-Agent` above.

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
```

<!-- example: web-feeds-robots-nist -->
```text
#
# robots.txt
#
# This file is to prevent the crawling and indexing of certain parts
# of your site by web crawlers and spiders run by sites like Yahoo!
# and Google. By telling these "robots" where not to go on your site,
# you save bandwidth and server resources.
#
# This file will be ignored unless it is at the root of your host:
# Used:    http://example.com/robots.txt
# Ignored: http://example.com/site/robots.txt
#
# For more information about the robots.txt standard, see:
# http://www.robotstxt.org/robotstxt.html

User-agent: *
# CSS, JS, Images
Allow: /core/*.css$
Allow: /core/*.css?
Allow: /core/*.js$
…
# Directories
Disallow: /core/
Disallow: /profiles/
# Files
Disallow: /README.md
…
```

Verified: live, 2026-10-31, `curl` of the request above. 25 of 92 lines kept, each omission a `…` line; other response headers omitted. Our code: the `*` group applies (no group names `research-workspace`), so `/core/` is refused and `/news-events/news` allowed.

### Error response

`robots.txt` that does not exist — the Federal Reserve answers 404, which our code reads as "no restrictions" (before the page request above):

```http
HTTP/1.1 404 Not Found
Content-Type: text/html
Transfer-Encoding: chunked
Content-Encoding: gzip
```

```html
<!doctype html>
<html lang="en" class="no-js">
  <head>
<!-- … -->
    <title>Federal Reserve Board - Page not Found</title>
<!-- … -->
```

Verified: live, 2026-10-31, `curl --http1.1 --compressed https://www.federalreserve.gov/robots.txt` with the robots `Accept` and `User-Agent`. Body cut to its first lines and title, omissions marked; byte-order mark dropped; headers `Date`, `Connection`, `CF-*`, `Server`, `Strict-Transport-Security`, `X-Frame-Options` omitted. Our code discards the body: 4xx → allow all, cached 1 hour. The same 404 for a feed would be `HTTP_ERROR` with status 404 in the source's fetch report.

## 6. Data Mapping

Feed items become `IngestedArticle` (`packages/contracts/src/jobs.ts`, Rust `crates/research-contracts/src/records.rs`) via `normalizeFeed` / `normalize_feed`; the API stores them in [`articles`](../../database/tables/articles.md) from the job's completion. Tool results become `Evidence` (`packages/contracts/src/records.ts`), stored with the run's bundle in [`evidence.body_json`](../../database/tables/evidence.md).

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `item/link`, else permalink `item/guid`, else `atom:link@href`; Atom `entry/link@href` | A value empty after trimming or longer than 4,096 UTF-16 units is no link (never cut: a cut URL would be a wrong one), whether element text (`link`, `guid`, measured whole) or an attribute (`href`). RSS then falls back `link` → permalink `guid` → `atom:link`; Atom (and `atom:link`) takes the first alternate link whose `href` is usable — including passing the article URL policy below — trying later ones. No usable link → `MISSING_LINK`; a link that is not `https` with a public host → `UNSAFE_LINK`. Then trimmed; lower-case host, fragment and `utm_*` / click-id parameters removed, parameters sorted, no trailing slash; duplicates within a feed dropped | `IngestedArticle.canonicalUrl` | [`articles.canonical_url`](../../database/tables/articles.md) |
| `item/title`, `entry/title` | Tags stripped, entities decoded, whitespace collapsed (`toPlainText`); ≤ 300 characters (cut with `…`); empty → `MISSING_TITLE` | `IngestedArticle.title` | [`articles.title`](../../database/tables/articles.md) |
| `item/pubDate`, else `item/dc:date`; `entry/published`, else `entry/updated` | ISO 8601 or RFC 822 only, a missing zone read as UTC, North American zone abbreviations (`EST`, `PDT`, …) understood; → ISO 8601 UTC; anything else `null` (never the retrieval time) | `IngestedArticle.publishedAt` | [`articles.published_at`](../../database/tables/articles.md) |
| `item/description`, else `item/content:encoded`; `entry/summary`, else `entry/content` | `toPlainText`; ≤ 500 characters, only when the source's licence is `short-excerpt-permitted`, else `null` | `IngestedArticle.excerpt` | [`articles.excerpt`](../../database/tables/articles.md) |
| publisher, publication time, title, summary, canonical URL | One text of four lines, hashed with SHA-256 (hex): the publisher lower-cased only; the first 10 characters of the ISO publication time (`YYYY-MM-DD`, or `undated`); the stored title (parser bound 2,000 UTF-16 units, then plain text cut to 300 characters) NFKC-normalised, lower-cased, every run of non-letter / non-digit characters folded to one space and trimmed; then `summary:` + the summary normalised like the title — the parser bounds the summary to 20,000 UTF-16 units first, and it is not cut to the 500-character excerpt — or `url:` + the canonical URL unchanged when the feed gives no summary, its plain text is empty, or it normalises to nothing (only punctuation or symbols) | `IngestedArticle.contentFingerprint` | [`articles.content_fingerprint`](../../database/tables/articles.md) and `articles.article_id` (`art_` + 32 hex) |
| (source) | The source's publisher name | `IngestedArticle.publisher` | [`articles.publisher`](../../database/tables/articles.md) |
| (none) | Run clock at retrieval | `IngestedArticle.retrievedAt` | [`articles.retrieved_at`](../../database/tables/articles.md) |
| fetch failure code and HTTP status | Unchanged; `NOT_A_FEED` has no status | `SourceFetchReport.errorCode`, `.upstreamStatus` (`packages/contracts/src/jobs.ts`) | [`news_sources.last_error_code`, `last_error_upstream_status`, `feed_status`, `last_fetched_at`](../../database/tables/news_sources.md) |
| `channel/title`, `feed/title` (source check) | Trimmed, ≤ 300 characters; the host when empty | `SourcePreview.suggestedPublisher`, `.title` (`packages/contracts/src/api.ts`) | [`news_sources.publisher`, `title`](../../database/tables/news_sources.md) unless the owner overrides them |
| `channel/link`, Atom alternate link (source check) | Must pass the URL policy, else `null` | `SourcePreview.siteLink` | Not stored |
| document root (source check) | `rss` for RSS 2.0 and RDF, `atom` for Atom | `SourcePreview.sourceType` | [`news_sources.source_type`](../../database/tables/news_sources.md) |
| final URL after redirects (source check) | Canonicalised as above | `SourcePreview.canonicalUrl` | [`news_sources.canonical_url`](../../database/tables/news_sources.md) |
| article fields (`news.fetch_feed`) | The 20 newest articles become evidence: URL, title, publisher, dates; retrieved text = title + excerpt; `excerpt` kept only under `short-excerpt-permitted` | `Evidence` (`sourceClass` `news`) | [`evidence.body_json`](../../database/tables/evidence.md) |
| final URL, `<title>` / first `<h1>`, host (`web.fetch_page`) | Title else host; publisher = final host; `publishedAt` `null`; Markdown (≤ 20,000 characters) hashed for `checksum`; `excerpt` `null` | `Evidence` (`sourceClass` `other`) | [`evidence.body_json`](../../database/tables/evidence.md); the Markdown only in the page archive file (`RUNNER_PAGES_DIR`, front matter: source and final URL, title, retrieval time, checksum) |
| `<title>`, `article:published_time`, page text (`news.fetch_article`) | Title else `Untitled page on <host>`; time → ISO 8601 UTC or `null`; text ≤ 20,000 characters retrieved, excerpt ≤ 500 only under `short-excerpt-permitted` (strictest licence of the host's sources) | `Evidence` (`sourceClass` `news`) | [`evidence.body_json`](../../database/tables/evidence.md) |
| `robots.txt` groups | Parsed rules, or allow-all / disallow-all after a failure | Robots rules (in memory, 1 hour) | Not stored |

## 7. Maintenance

### Known differences between the runners

- Connections: the Rust runner keeps idle HTTP/1.1 connections per validated address and reuses them for later GETs (and retries a GET once on a fresh connection when a pooled one was closed before answering); the TypeScript runner opens a fresh socket per request and sends `Connection: close`.
- Politeness: TypeScript serialises callers per host and records a host's request start when the wait ends; Rust queues them in a ledger and records the start when the request is sent. Both serve callers first come, first served and keep starts to one host ≥ 1 s apart.
- Charset decoding: TypeScript uses the runtime's `TextDecoder` (ICU in Node and workerd), Rust `encoding_rs`; both implement the WHATWG Encoding Standard and pick the encoding by the same rules, so well-formed text decodes identically (Shift_JIS, EUC-JP and windows-1252 tested in Node, workerd and Rust). How a malformed sequence in a legacy encoding is replaced may differ in edge cases.
- The API Worker (TypeScript only) cannot pin DNS answers and does not count encoded bytes (its header in `packages/adapters/src/worker/index.ts` says so).
- Otherwise none: both runners send the same headers, parse feeds with the same acceptance set (pinned by `vectors/feed/*.json`), and convert HTML with the same converter rules.

### Open issues

- No conditional GET: every ingest downloads each feed in full even when the publisher sends `ETag` / `Last-Modified` (both observed live).
- Publisher `429` / `Retry-After` and `robots.txt` `crawl-delay` are not honoured beyond the 1 s spacing.
- No Atom feed among the 21 recommended sources checked, so the Atom example is the RFC's (`spec`), not a live capture.

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| 2026-10-31 | live | Federal Reserve RSS 2.0 feed, Cabinet Office RDF feed, a Federal Reserve press-release page, `robots.txt` of `www.nist.gov` (200) and `www.federalreserve.gov` (404); format of 21 of the 30 recommended feeds (RSS 2.0 or RDF; one same-host 302; SEC not called) | Claude (ADR-0047 external API documents) |
| 2026-10-31 | spec | Atom example (RFC 4287 §1.1); element tables against RSS 2.0, RSS 1.0, RFC 4287, RFC 9309 | Claude (ADR-0047 external API documents) |
| 2026-10-31 | spec | Charset decoding rules against the WHATWG Encoding Standard (labels, BOM) and the XML 1.0 / HTML encoding declarations; no example changed (the live examples are UTF-8) | Claude (external-API defect fixes) |
| 2026-10-31 | spec | After the defect fixes: `user-agent` product-token match against RFC 9309 §2.2.1; overlong / first-usable link rules against RFC 4287 §4.2.7; `news.fetch_article` request headers and robots read from the code (no example changed) | Claude (external-API defect fixes) |
