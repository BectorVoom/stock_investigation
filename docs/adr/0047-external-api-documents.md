# ADR-0047: External API documentation in docs/external-apis, one checked document per API

Status: accepted, 2026-10-31.

## Context

The owner asked (2026-10-31) to document every integrated external API — overview, input and output parameters, error handling, examples that match production exactly, data mapping — with a reusable template, standard rules in the development guidelines, examples validated against real responses or specifications where possible, and the rules applied to every existing integration with redundant documentation removed.

Before this change the services the runner calls (SEC EDGAR, JPX, FRED, Twelve Data, Finnhub, Tavily, GDELT, Google OAuth and Calendar, the Claude API, OpenRouter, and the open web) and those the API Worker calls (a feed URL the owner previews, and Cloudflare Access signing keys when deployed) were described in pieces: module header comments in both runners, the ADRs that chose each service ([ADR-0014](0014-market-data-sources.md), [ADR-0009](0009-agent-web-access-and-page-archive.md), [ADR-0016](0016-earnings-dates-and-calendar-export.md), [ADR-0018](0018-google-calendar-sync.md), [ADR-0025](0025-web-search-research-tool.md), [ADR-0031](0031-claude-api-backend.md), [ADR-0034](0034-stock-directory-search.md), [ADR-0039](0039-fewer-external-requests.md)), and operator sections of [OPERATIONS.md](../OPERATIONS.md). No single place said which fields we read, which statuses we expect, or how a field reaches a database column, and no check noticed a new host the code started to call.

## Decision

1. **`docs/external-apis/` holds the API documentation**, organised like `docs/database/` ([ADR-0046](0046-table-definition-documents.md)): `README.md` (entry point and index), `conventions.md` (the rules), `api-template.md`, and `apis/<api>.md`, one per provider service. Removed integrations move to `archive/`.
2. **Fixed sections**, numbered as the owner listed them: Overview, Input Parameters, Output Parameters, Error Handling, Examples, Data Mapping, Maintenance. Both runners are documented in the same document, because they must send the same requests ([ADR-0030](0030-runner-rewritten-in-rust.md)).
3. **Examples are exact and say how they were verified.** Each carries `Verified: live | fixture | spec | unverified, <date>, <source>`. Arrays may be shortened and secrets replaced, and the line says so; nothing else may differ from production.
4. **Checked, not trusted.** `tests/architecture/externalApiDocs.test.ts` checks structure, verification lines, JSON validity, links and existing code paths, and scans production code for hosts: a host no document lists fails the build. `*DocExamples.test.ts` files parse the documented successful responses with the code's own parsers (the TypeScript runner's, or `jose` for the Worker).
5. **One home per fact.** Parameter, field and error tables live only in the API document. ADRs keep the decision and OPERATIONS.md the operator steps; both link to the API document.

## Consequences

- A new integration, or a new host in an existing one, fails `bun run test` until its document exists — the same guarantee ADR-0046 gives for tables.
- A documented example the code cannot parse fails the build, so examples cannot drift from the parser. Whether today's production still matches an example is not checked automatically; the rules require re-verification when a parsed field changes, recorded in each document's verification log.
- SEC EDGAR examples are checked against SEC's published documentation only, because `SEC_USER_AGENT` was not set when the documents were written; the owner can re-verify them live once it is.
- Parsing the examples exercises the TypeScript parsers; the Rust runner's parsers are held to the same behaviour by their own tests and the shared conformance vectors, not by these examples.

## Alternatives considered

- **OpenAPI files per provider.** Most of these services publish no OpenAPI description, several answer with XLSX, XML or HTML, and an OpenAPI file cannot say how a field becomes a database column. Rejected.
- **Keep documenting in module comments.** Comments stay next to the code but are split across two runners and cannot hold examples or mappings without becoming the larger part of the file.
- **Record cassettes of every response and test against them.** Stronger than parsing examples, but the recorded payloads are large (company facts are megabytes) and some providers' terms restrict redistribution. The existing fixtures in `packages/adapters/test/*/fixtures` remain; the documents cite them where they are the source of an example.
