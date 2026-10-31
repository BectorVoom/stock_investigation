# External API documentation rules

Every external API this application calls has one reference document, `docs/external-apis/apis/<api>.md`, written from [`api-template.md`](api-template.md) and listed in the index [`README.md`](README.md) ([ADR-0047](../adr/0047-external-api-documents.md)). The code that calls the API and the provider's own specification are the sources of truth; the document explains both and says how one becomes the other.

## 1. What counts as an external API

A network service run by someone else that the runner, the API Worker or the web app sends requests to: a data provider (SEC, JPX, FRED, Twelve Data, Finnhub), a search service (Tavily, GDELT), an identity or calendar service (Google, Cloudflare Access), a model API (Claude API, OpenRouter), and the open web the runner reads (subscribed feeds, fetched pages, `robots.txt`). A request made by a library on our behalf (for example `jose` fetching signing keys) counts: our code chose the host.

Not external APIs, and documented elsewhere:

| Not here | Why | Where it is documented |
| --- | --- | --- |
| Our own HTTP API (`apps/api`), the runner protocol, the MCP server | We define them | [`EXTERNAL_AGENT_PROTOCOL.md`](../EXTERNAL_AGENT_PROTOCOL.md), `packages/contracts`, [OPERATIONS.md](../OPERATIONS.md) |
| Model CLIs (Claude Code, OpenCode, Codex) | Local programs the runner starts, not network requests the code makes; their own API traffic is theirs | [`AGENT_BACKENDS.md`](../AGENT_BACKENDS.md) |
| Links the UI only renders (add-to-calendar deep links, attribution links, a series' public page) | The browser opens them on the owner's click; no response is read | The README table [Hosts in code that are not API calls](README.md#hosts-in-code-that-are-not-api-calls) |
| Cloudflare D1, Workers runtime | Platform bindings, not HTTP requests from our code | [`docs/database/`](../database/README.md), [OPERATIONS.md](../OPERATIONS.md) |

## 2. One document per API

- One document per provider service that shares a host, an authentication scheme and usage limits (for example all SEC EDGAR endpoints, or OAuth and Calendar as two Google documents because their hosts, credentials and limits differ). Each endpoint the code calls is listed in the Overview's Endpoints cell as a code span `METHOD /path` and has a `### METHOD /path` subsection, with exactly that text, in sections 2, 3 and 5.
- File name: the service in kebab case (`fred.md`, `google-calendar.md`). The title line is `# External API: <Service name>`.
- Both runners are documented together. The Rust runner (`crates/`) is the default and the TypeScript runner (`apps/runner`, `packages/adapters`) the rollback ([ADR-0030](../adr/0030-runner-rewritten-in-rust.md)); they must send the same requests and map the same fields. Where they differ, say so in the section where the difference shows and in "Known differences" under section 7.
- The full parameter, field and error tables of an API live only in its document. ADRs keep the decision, OPERATIONS.md keeps the operator steps (which key to set, how to rotate it), and both link here instead of repeating the tables.

## 3. Mandatory content

The sections are fixed, numbered and in this order; the checker fails a document that lacks one. Write "None." or "Not applicable: <reason>" rather than deleting a section.

| Section | Must contain |
| --- | --- |
| 1. Overview | The property table from the template: provider, purpose in this application, hosts, every endpoint with its HTTP method, authentication (scheme, header or parameter, env variable), usage limits (published quota, our own pacing and caps), who calls it (runner, Worker, browser), code paths in both runners, official documentation links, last verification date. |
| 2. Input Parameters | Per endpoint, every parameter the code sends or can send: name exactly as on the wire, location (path, query, header, body, form), data type, required or optional, default (the provider's default when we omit it, and the value we send), constraints (format, range, length, enum), description. Headers that change behaviour (`Accept`, `User-Agent`, `anthropic-version`) are parameters. Parameters the provider offers but we never send are not listed. |
| 3. Output Parameters | Per endpoint, the complete response structure of the variant we request, field by field, including fields the code ignores: JSON path, data type, Nullable (the provider may send `null`), Optional (the provider may omit the field), Read (whether our code reads it), description. Open-ended maps are documented by their key pattern (`$.facts.<taxonomy>.<concept>`). A part whose structure the provider does not publish and we could not observe is stated as such in its row, never left out silently. Non-JSON payloads (XML, XLSX, HTML, plain text, event streams) list every element, sheet, column, line or event type the format defines for that response, marking which ones the code reads. |
| 4. Error Handling | HTTP status codes and what our code does with each; the provider's own error codes and error body shape; timeouts (connect, total, body size cap); retry policy (which failures, how many attempts, backoff); rate-limit handling (headers read, pacing, pause after an outage); fallback (cache, degraded answer, other provider). Name our resulting error codes, and keep the [upstream-status rule](../rule/error_handling.md): the provider's status travels unchanged. |
| 5. Examples | Per endpoint, a `### METHOD /path` subsection with at least one request and one successful response; per document, a `### Error response` subsection with at least one error response. Each example has a verification line (section 4 below). |
| 6. Data Mapping | A table from each external field the code reads to the internal model field (`packages/contracts` schema, Rust type) and, when stored, the database `table.column` linked to its [table document](../database/README.md#tables), with the transformation (unit, type, timezone, normalisation, rounding, default when missing). |
| 7. Maintenance | Known differences between the runners, open issues and limitations, and the verification log: one row per verification (date, method, what was checked, by whom). |

## 4. Examples must be exact

An example shows what the production API sends and receives, not what we wish it did.

- **Same structure as production.** Field names, nesting, data types, number versus string, `null` versus absent, date and number formats, header names and casing exactly as the provider uses them. No invented fields, no renamed fields, no simplified shapes.
- **Allowed edits, always stated.** You may shorten an array to fewer elements and replace a secret with a placeholder; every element you keep is verbatim, and strings inside JSON are never cut. In HTML, XML, text or event-stream excerpts you may omit whole elements or lines, marking each omission (`<!-- … -->` in HTML and XML, a line `…` otherwise). Say what you cut in the verification line ("2 of 30 observations kept").
- **Secrets never appear.** API keys, OAuth tokens, client secrets, cookies and personal data are replaced by `<ENV_VARIABLE_NAME>` or `<redacted>`. The placeholder names the variable the value comes from.
- **Request examples** use an `http` code block with the method, path and query exactly as the code builds them, and the headers the code sets. **Response examples** give the status line and relevant headers in an `http` block and the body in its own `json` (or `xml`, `text`) block, so the body parses on its own.
- **Every example has its own verification line** directly under it. The one shared line: a response's status-line `http` block followed directly by its body block, verified together under the body. The form:

  `Verified: <method>, <YYYY-MM-DD>, <source>. <edits>`

  | Method | Use when | Source names |
  | --- | --- | --- |
  | `live` | Captured from the production API by running the request | the command or test that ran it, e.g. `curl` or `bun run test:real` |
  | `fixture` | Taken from a fixture in the repository that was itself recorded from production | the fixture path |
  | `spec` | Checked field by field against the provider's official reference or machine-readable schema, but not observed live | the specification URL |
  | `unverified` | None of the above was possible | the reason, and what would verify it |

  `unverified` examples are allowed only with the reason and what would verify it on the verification line, and the document's "Open issues" lists them.
- **The code must accept the examples.** Every successful JSON response body is marked with `<!-- example: <api>-<name> -->` on the line above its code block (other bodies may be marked too) and parsed in a test by the same function our code uses (the TypeScript runner's parser for runner calls): `*DocExamples.test.ts` files (next to the adapter tests in `packages/adapters/test/`, or under `tests/` for the Worker) read it with a literal `docExampleJson("<api>", "<id>")` or `docExampleText("<api>", "<id>")` from `packages/adapters/test/docExamples.ts`, so a document whose example the code would reject fails `bun run test`.

## 5. Keeping documents current

**Mandatory with every change to an integration, in the same commit or pull request, reviewed together with the code:**

| Change | Documentation update |
| --- | --- |
| New external API | New `docs/external-apis/apis/<api>.md` from the template, a row in the README index, and example tests. The integration is not done without them. |
| New or removed endpoint, host or HTTP method | Overview, Input, Output, Examples, Data Mapping of that endpoint; Hosts in the Overview. |
| New, changed or removed request parameter or header | Input Parameters, and the request example. |
| Response field newly read, no longer read, or parsed differently | Output Parameters, Data Mapping, and the response example (re-verified). |
| Changed error handling: status mapping, error codes, timeout, retry, pacing, rate limit, cache, fallback | Error Handling. |
| Changed mapping to contracts or database columns | Data Mapping, and the table document when the column's meaning changes ([database conventions §10](../database/conventions.md#10-table-definition-documents)). |
| Provider changed its API or published limits (found by a failure, a deprecation notice or a check) | The affected sections, a verification-log row, and the code if needed. |
| New or changed environment variable or credential | Authentication in the Overview, and [OPERATIONS.md](../OPERATIONS.md) for the operator step. |
| API removed | Move the document to `docs/external-apis/archive/<api>.md` with a line naming the commit that removed the integration, remove it from the index, list it under "Archived APIs", and update links. |

**Re-verification.** Re-run the examples (live when a key is available) whenever a response example or a parsed field changes, and at least when a provider announces a version change. Add a verification-log row each time. When a live check finds a difference from the document, the document and the code are fixed in the same change, never the document alone.

## 6. Checked by tests

- `tests/architecture/externalApiDocs.test.ts` (in `bun run test`) fails when a document lacks a mandatory section or Overview property, still holds a placeholder, names a code path that does not exist, lacks a `### METHOD /path` subsection in sections 2, 3 or 5 for an endpoint of its Overview, lacks a request or success example for an endpoint or an error example, has an example without its own verification line, an `unverified` example while "Open issues" says "None.", a `json` block anywhere that does not parse, a 2xx JSON body without a marker, or a marker no `DocExamples` test reads with `docExampleJson`/`docExampleText`; when the README index does not link it exactly once; and when production code under `apps/`, `packages/` or `crates/` names a host (in a string literal outside comments and Rust `#[cfg(test)]` modules: an `https://` URL or a `*_HOST` constant) that no document lists under Hosts and the README does not list as "not an API call", or builds a URL with a computed host (`https://${…}` with anything but a `*_HOST` constant of the same file, `"https://{…}"`, `"https://" + host`) in a file no document lists under Code. A new integration therefore fails the build until it is documented. Limits: a host that never appears in a URL literal — read from configuration and handed to a library in pieces — is caught only by review, and a `DocExamples` read counts when it is code outside comments in a file without `.skip`, `.only` or `.todo`; whether the test asserts something meaningful is reviewed.
- `*DocExamples.test.ts` files feed the marked response examples through our parsers (section 4).
- Links are checked by `tests/architecture/docLinks.test.ts`.

What is not checked mechanically: that the prose matches the code, and that a `live` example still matches today's production. Those are reviewed with the change and re-verified as in section 5.
