# External API: {{Service name}}

<!--
Template for one external API document (conventions.md). Copy to
docs/external-apis/apis/<api>.md, replace every {{placeholder}}, and delete these comments.
Write from the code of BOTH runners (crates/ is the default runner, apps/runner +
packages/adapters the rollback) and from the provider's official reference, never from memory.
tests/architecture/externalApiDocs.test.ts checks the structure; packages/adapters/test/**/
*DocExamples.test.ts parse the marked response examples with the runner's own parsers.

Conventions the checker relies on:
- The level-2 headings below are fixed: keep their numbers and words exactly.
- Overview: keep every property row. Hosts and Code cells hold code spans (`host`, `path`);
  every Code path must exist. Write "None." for a property that does not apply.
- Every endpoint in the Overview's Endpoints cell is a code span `METHOD /path` and has a level-3
  heading "### METHOD /path" with exactly that text in sections 2, 3 and 5 (for example
  "### GET /fred/series/observations"). Section 5 also has "### Error response".
- Output tables list the complete response, including fields the code ignores (Read = No).
- Every example code block is followed by its own line starting "Verified: " (conventions §4):
  "Verified: live|fixture|spec|unverified, YYYY-MM-DD, <source>. <edits>". Only a response's
  status-line http block and the body block right after it share one line, under the body.
- Every successful JSON response body has "<!-- example: <api>-<name> -->" on the line above its
  code block, and a DocExamples test reads it with docExampleJson("<api>", "<id>").
- Every unescaped | ends a table cell; write a literal pipe as \|.
- Secrets never appear: write <ENV_VARIABLE_NAME> or <redacted>.
-->

## 1. Overview

| Property | Value |
|---|---|
| Provider | {{organisation that runs the service}} |
| Purpose | {{what this application uses it for, in one or two sentences, with the features and ADRs}} |
| Hosts | `{{api.example.org}}` |
| Endpoints | `{{GET /path}}` — {{what it returns}} |
| Authentication | {{scheme; where the credential goes (header or query name); env variable `{{NAME}}` in `apps/runner/.env`; "None." for public endpoints}} |
| Configuration | {{other env variables or settings; "None."}} |
| Usage Limits | {{provider's published quota and terms, with a link; our pacing, caps and caches}} |
| Called By | {{Rust runner / TypeScript runner / API Worker / browser; which job kinds or tools}} |
| Code | `{{crates/...rs}}`, `{{packages/adapters/src/...ts}}` |
| Official Documentation | {{links to the reference pages used}} |
| Last Verified | {{YYYY-MM-DD, method (see section 7)}} |

{{One paragraph: when the code calls the API, what it asks for and what happens to the answer.}}

## 2. Input Parameters

### {{GET /path}}

| Name | In | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|---|
| `{{name}}` | {{path / query / header / body / form}} | {{string / integer / boolean / ...}} | {{Yes / No}} | {{provider default; what we send}} | {{format, range, enum}} | {{meaning}} |

## 3. Output Parameters

### {{GET /path}}

{{Content type and overall shape.}}

| Field | Type | Nullable | Optional | Read | Description |
|---|---|---|---|---|---|
| `{{$.field}}` | {{string / number / object / array}} | {{Yes / No}} | {{Yes / No}} | {{Yes / No}} | {{meaning, format, allowed values}} |

## 4. Error Handling

### HTTP status codes

| Status | When the provider sends it | What our code does | Our error code |
|---|---|---|---|
| {{429}} | {{rate limit exceeded}} | {{pauses, keeps the status}} | `{{RATE_LIMITED}}` |

### Provider error codes and body

{{The error body's structure and the provider's own codes, or "None: errors are plain HTTP statuses".}}

### Timeouts, retries and rate limits

| Concern | Behaviour | Code |
|---|---|---|
| Timeout | {{connect / total / body size cap}} | `{{path}}` |
| Retries | {{which failures, how many attempts, backoff}} | `{{path}}` |
| Rate limit | {{headers read, pacing, outage pause}} | `{{path}}` |
| Cache | {{what is cached, for how long, keyed by what; "None."}} | `{{path}}` |
| Fallback | {{what the user sees when the API fails}} | `{{path}}` |

## 5. Examples

### {{GET /path}}

Request:

```http
GET {{/path?query}} HTTP/1.1
Host: {{api.example.org}}
Accept: application/json
```

Verified: {{live}}, {{YYYY-MM-DD}}, {{source}}.

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

<!-- example: {{api}}-{{name}} -->
```json
{}
```

Verified: {{live}}, {{YYYY-MM-DD}}, {{source}}. {{edits, e.g. "2 of 30 items kept"}}

### Error response

```http
HTTP/1.1 {{400 Bad Request}}
Content-Type: application/json
```

```json
{}
```

Verified: {{live}}, {{YYYY-MM-DD}}, {{source}}.

## 6. Data Mapping

| External field | Transformation | Internal field | Stored in |
|---|---|---|---|
| `{{$.field}}` | {{parse, unit, timezone, normalisation, default}} | `{{ContractType.field}}` (`{{packages/contracts/src/...}}`) | {{`table.column`, linked to its table document ../../database/tables/<table>.md, or "Not stored"}} |

## 7. Maintenance

### Known differences between the runners

{{Differences between the Rust and TypeScript implementations, or "None."}}

### Open issues

{{Limitations, unverified examples, provider behaviour we do not handle yet, or "None."}}

### Verification log

| Date | Method | What was checked | By |
|---|---|---|---|
| {{YYYY-MM-DD}} | {{live / fixture / spec}} | {{endpoints and examples}} | {{who or which agent}} |
