# External API documentation

One reference document per external API the application calls: what we send, what comes back, how failures are handled, verified examples, and how the answer becomes our data. Most calls are made by the local runner — the Rust runner (`crates/`, the default) or the TypeScript runner (`apps/runner` with `packages/adapters`, the rollback). The API Worker makes two kinds itself: it fetches a feed URL the owner enters to preview or subscribe to a source ([Web feeds and pages](apis/web-feeds-and-pages.md)), and, when deployed behind Cloudflare Access, the team's signing keys ([Cloudflare Access](apis/cloudflare-access.md)). The web app calls no external API.

**Rules:** [conventions.md](conventions.md) — what counts as an external API, the mandatory sections, how examples are verified, and what every integration change must update ([ADR-0047](../adr/0047-external-api-documents.md)). Errors from these services keep their HTTP status ([error handling §4a](../rule/error_handling.md), [ADR-0037](../adr/0037-external-service-errors-keep-their-status.md)).

- **New API:** copy [`api-template.md`](api-template.md) to `apis/<api>.md`, fill it in from the code of both runners and the provider's reference, verify the examples, and add it to the index below in the same commit as the integration ([conventions §5](conventions.md#5-keeping-documents-current)).
- **Check:** `tests/architecture/externalApiDocs.test.ts` (in `bun run test`) checks every document's structure and fails when production code reaches a host no document lists; `*DocExamples.test.ts` files parse the documented responses with the code's own parsers.

## APIs

<!-- api-index:start -->

| API | Provider | Used for | Hosts | Credential |
|---|---|---|---|---|
| [SEC EDGAR](apis/sec-edgar.md) | U.S. Securities and Exchange Commission | US stock directory, XBRL company facts, 13F holdings, US annual financial statements | `www.sec.gov`, `data.sec.gov` | None (`SEC_USER_AGENT` contact header) |
| [EDINET API v2](apis/edinet.md) | Financial Services Agency of Japan | Japanese annual securities reports and their XBRL-to-CSV facts | `api.edinet-fsa.go.jp` | `EDINET_API_KEY` (`Subscription-Key` query parameter) |
| [JPX](apis/jpx.md) | Japan Exchange Group | Japanese stock directory, earnings announcement schedule | `www.jpx.co.jp` | None |
| [FRED](apis/fred.md) | Federal Reserve Bank of St. Louis | Economic indicator series on Home and in the Notebook | `api.stlouisfed.org` | `FRED_API_KEY` |
| [Twelve Data](apis/twelve-data.md) | Twelve Data | Daily prices of stocks, FX and metals | `api.twelvedata.com` | `TWELVE_DATA_API_KEY` |
| [Finnhub](apis/finnhub.md) | Finnhub | US earnings dates for the watchlist | `finnhub.io` | `FINNHUB_API_KEY` |
| [Tavily Search](apis/tavily-search.md) | Tavily | `web.search` research tool | `api.tavily.com` | `TAVILY_API_KEY` |
| [GDELT DOC 2.0](apis/gdelt-doc.md) | The GDELT Project | `news.search` research tool | `api.gdeltproject.org` | None |
| [Google OAuth 2.0](apis/google-oauth.md) | Google | Connecting Google Calendar | `accounts.google.com`, `oauth2.googleapis.com` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| [Google Calendar API](apis/google-calendar.md) | Google | Syncing earnings dates to a dedicated calendar | `www.googleapis.com` | OAuth access token |
| [Claude API](apis/claude-api.md) | Anthropic | `claude-api` agent backend (Messages) | `api.anthropic.com` | `ANTHROPIC_API_KEY` |
| [OpenRouter](apis/openrouter.md) | OpenRouter | `openrouter` agent backend, model catalogue | `openrouter.ai` | `OPENROUTER_API_KEY` |
| [Cloudflare Access signing keys](apis/cloudflare-access.md) | Cloudflare | Verifying the owner's Access JWT in the deployed Worker | `<team-name>.cloudflareaccess.com` | None (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`) |
| [Web feeds and pages](apis/web-feeds-and-pages.md) | Any publisher the owner subscribes to | News ingest (RSS/Atom), `web.fetch_page`, `robots.txt` | Owner-chosen `https` hosts | None |

<!-- api-index:end -->

## Hosts in code that are not API calls

Production code names these hosts without calling an API on them. The checker accepts them only because they are listed here.

<!-- non-api-hosts:start -->

| Host | Where | Why it is not an API call |
|---|---|---|
| `127.0.0.1` | Google OAuth loopback redirect, MCP server default | Our own loopback listener ([Google OAuth](apis/google-oauth.md) describes the redirect). |
| `example.com` | `apps/web/src/sources/SourcesView.tsx` | Placeholder text in the add-a-source field. |
| `calendar.google.com`, `outlook.live.com` | `packages/domain/src/calendar/links.ts` | Add-to-calendar links the browser opens on the owner's click. |
| `disclosure2.edinet-fsa.go.jp` | `packages/adapters/src/finance/edinetDocuments.ts`, `crates/research-finance/src/edinet_documents.rs` | A filing's page in the EDINET viewer (`WZEK0040.aspx?{docID}`), stored as its source link and opened on the owner's click ([EDINET § 6](apis/edinet.md#6-data-mapping)). |
| `fred.stlouisfed.org` | FRED adapters, `packages/adapters/src/sql/unitOfWork.ts` | A series' public page, stored as its source link ([FRED § 6](apis/fred.md#6-data-mapping)). |
| `twelvedata.com` | Twelve Data adapters, `packages/adapters/src/sql/unitOfWork.ts` | Attribution link ([Twelve Data § 6](apis/twelve-data.md#6-data-mapping)). |
| `opencode.ai` | `packages/adapters/src/providers/openCode.ts`, `crates/research-providers/src/opencode.rs` | `$schema` URL written into the OpenCode CLI's configuration file; the CLI is documented in [AGENT_BACKENDS.md](../AGENT_BACKENDS.md). |

<!-- non-api-hosts:end -->

Files whose hosts are data, not integrations: `packages/application/src/recommendedCatalog.ts` (the recommended news sources; each is fetched as a feed, [Web feeds and pages](apis/web-feeds-and-pages.md)).

## Archived APIs

Documents of removed integrations move to `docs/external-apis/archive/` and are listed here with the commit that removed them. None yet.
