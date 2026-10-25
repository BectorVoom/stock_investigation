# Engineering Design Rules — AI Research Workspace

**Status:** Normative proposed rules  
**Version:** 1.0  
**Date:** 2026-10-11  
**Architecture:** [ARCHITECTURE_AND_REQUIREMENTS.md](ARCHITECTURE_AND_REQUIREMENTS.md)

## 1. Applicability and interpretation

This is the **canonical rule set** for human developers and coding agents (OpenCode, Codex, Claude Code). `AGENTS.md` and tool-specific instruction files may link to it but must not maintain conflicting copies. Rules marked **MUST** are release gates; **SHOULD** requires a documented exception; **MAY** is optional. For a deviation, write an ADR describing rationale, risk, tests and rollback.

**Priority order:** correctness and data integrity > security and authorization > maintainability > testability > performance > minimum code size. Prefer simple verified code to speculative architectural generality.

## 2. Mandatory design principles

| Rule | Principle | Enforceable interpretation |
|---|---|---|
| ARCH-001 | Single Responsibility (SRP) | One module has one cohesive reason to change; do not combine UI, fetching, orchestration, calculation and persistence |
| ARCH-002 | Pure functions | Domain transforms MUST be pure unless an ADR explains an unavoidable effect; inject time, randomness and environmental inputs |
| ARCH-003 | Functional Core / Imperative Shell | Network/DB/CLI/LLM effects exist at explicit boundaries; decisions/calculations stay in pure core |
| ARCH-004 | Dependency Inversion | Domain and use cases depend on ports/contracts, never Hono, SolidJS, D1, CLI/LLM SDKs |
| ARCH-005 | Design by Contract | Validate unknown data at trust boundaries and encode invariants/pre-/postconditions; version public schemas |
| ARCH-006 | Open/Closed (targeted OCP) | Extend known registries (agent, component, tool, provider) without adding switch cases throughout unrelated modules |
| ARCH-007 | Interface Segregation | Narrow contracts; do not require unsupported agent capabilities |
| ARCH-008 | Composition over Inheritance | Prefer injected capabilities and small functions over inheritance trees |
| ARCH-009 | Immutability | Treat domain records as immutable values; update through pure transitions |
| ARCH-010 | Explicit error handling | Expected failures represented by tagged `Result` unions; unexpected failures handled/logged at effect boundaries; shell code uses Effect (ADR-0007); the Rust runner returns `Result` with `thiserror` types and handles failures at its edge instead of Effect (ADR-0030) |
| ARCH-011 | Determinism | For deterministic operations, same validated inputs yield same outputs; record external timestamps/snapshots |
| ARCH-012 | KISS / YAGNI | Avoid generic frameworks until at least one real extension requires them; do not prebuild multi-tenancy or microservices |
| ARCH-013 | DRY with restraint | Deduplicate stable domain logic, not merely superficially similar workflows |
| ARCH-014 | Information hiding | Modules expose stable public APIs; internal storage/prompt/provider representations stay private |
| ARCH-015 | State machine | Async jobs and persisted commands have explicit legal transition graphs and terminal states |
| ARCH-016 | Idempotency | Retryable mutations accept stable idempotency keys and DB constraints or compare-and-set versions |
| ARCH-017 | Fail closed | Unknown permission, command, tool, schema version or host is rejected; no implicit permissive fallback |
| ARCH-018 | Ports and adapters | Modular monolith with explicit runtime ports; no unnecessary microservices or global event bus |
| ARCH-019 | External-service errors keep their status | When an external service answers with an error, the status it answered with is returned unchanged — recorded as a number where the answer arrives, carried beside our own code through every function, stored row and API view, and used as the API's own response status (4xx/5xx); never remapped, rounded or parsed from text (docs/rule/error_handling.md §4a, ADR-0037) |

**Do not equate SRP with artificial function/file size limits.** A 30-line cohesive function may be better than five one-line wrappers. Require demonstrable ownership boundaries, not arbitrary metrics.

Error handling follows docs/rule/error_handling.md.

## 3. Module dependency rules

Allowed dependency direction:

```text
apps/web -> packages/contracts, packages/ui-registry, packages/widget-grid, web application adapters
apps/api -> packages/application, packages/contracts, packages/effects, server adapters
apps/runner -> packages/agent-core, packages/application, packages/effects, runner adapters
apps/mcp -> packages/contracts, packages/widget-grid/{core,agent}, zod
packages/widget-grid -> solid-js, zod (no workspace package)
packages/effects -> packages/domain, effect
packages/application -> packages/domain, packages/contracts, declared ports
packages/domain -> TypeScript standard primitives and minimal pure utilities
packages/adapters -> packages/application ports + external SDKs
```

- **MUST NOT** import `solid-js`, `hono`, `cloudflare:*`, Node `fs`, database client or provider SDK into `packages/domain`.
- **MUST NOT** import Node-only CLI packages in the Cloudflare Worker build.
- **MUST** prohibit circular dependencies and cross-feature imports that bypass public package boundaries.
- **SHOULD** define schemas once in `packages/contracts`; use runtime validation on external inputs rather than trusting TS types.
- **MUST** enforce dependency boundaries with static analysis (ESLint import restrictions or a dependency graph check).

## 4. Function and data design

### FUNC-001: pure calculation example

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

type PerError = 'NON_FINITE' | 'NEGATIVE_PRICE' | 'NON_POSITIVE_EPS';

export function trailingPer(
  price: number,
  trailingEps: number,
): Result<number, PerError> {
  if (!Number.isFinite(price) || !Number.isFinite(trailingEps)) {
    return { ok: false, error: 'NON_FINITE' };
  }
  if (price < 0) return { ok: false, error: 'NEGATIVE_PRICE' };
  if (trailingEps <= 0) return { ok: false, error: 'NON_POSITIVE_EPS' };
  return { ok: true, value: price / trailingEps };
}
```

**Additional contract:** the caller MUST validate currency and that numerator/denominator refer to the same security and adjustment basis. This small function alone is not a complete investment metric.

### FUNC-002: explicit effects

```ts
interface Clock { nowIso(): string }
interface ArticleFetcher { fetch(url: string): Promise<unknown> }
interface ArticleRepository { save(article: Article): Promise<void> }

// Effects are orchestrated here; normalization and verification remain pure.
async function ingest(
  url: string,
  deps: { fetcher: ArticleFetcher; repo: ArticleRepository; clock: Clock },
): Promise<Result<void, IngestError>> {
  // Validate target and fetch in a network-restricted adapter.
  // Normalize/validate the response in a pure domain function.
  // Persist with an idempotency key.
  // Return typed errors; never silently fabricate an article.
  throw new Error('Illustrative contract, not an implementation');
}
```

The illustrative stub above **MUST NOT be committed as completed production functionality**. Replace it with verified code and tests when implementing the use case.

### FUNC-003: further rules

- Pass dependencies explicitly; no unreviewed global mutable state or hidden service locators.
- Use readonly domain types and non-mutating transformations. Controlled SolidJS signals/store setters are allowed at UI boundaries.
- Do not catch and ignore exceptions. Translate failures at a boundary into typed, actionable error codes with sanitized diagnostics.
- Do not use `any`, unbounded `unknown` propagation, `@ts-ignore`, non-null assertions or unchecked casts to silence compilation. For unavoidable SDK interop, localize, document and test the assertion.
- Record units, dates, currency, market and financial basis in types/records; do not pass raw unqualified finance `number` values across module boundaries.
- Use precise names (`reportedShortInterestShares`, `trailingPer`, `retrievedAt`) over ambiguous names (`ratio`, `date`, `balance`).

### FUNC-004: Rust rules (the local runner, ADR-0030)

The runner is a Cargo workspace (`crates/*`, binary `research-runner`); the Worker API, the web app and the MCP server stay TypeScript. The Rust counterparts of the TypeScript rules above:

- **No unchecked escape hatches.** `unsafe_code = "forbid"`. Clippy denies `unwrap_used`, `expect_used`, `panic`, `todo`, `unimplemented`, `dbg_macro`, `indexing_slicing` and the lossy numeric casts (`cast_possible_truncation`, `cast_possible_wrap`, `cast_sign_loss`) in production code (`Cargo.toml` `[workspace.lints]`); tests may unwrap and index (`clippy.toml`). Use `get`, `try_from` and typed errors. An `#[allow(...)]` needs a comment saying why.
- **Typed errors, no exceptions to swallow.** Library crates return `Result` with `thiserror` error types; nothing is ignored silently: a deliberate `let _ =` discard carries a comment saying why (docs/rule/error_handling.md §5, checked by `tests/architecture/errorHandling.test.ts`). A panic inside a job is caught at the job boundary and reported as `job_crashed` with a retryable failure (`panic = "unwind"`), and the panic hook never prints the payload (SEC-010).
- **Contracts decoders at every boundary** (the counterpart of "no `any`: parse unknown data with zod"). Anything that crosses the process edge — Worker responses, agent output, feeds, pages, files — is decoded by `research-contracts` (or the owning crate's decoder), never read from `serde_json::Value` past the boundary, and everything written to the Worker goes through `research_contracts::json::to_js_json`.
- **JavaScript semantics live in `research-js`** (UTF-16 lengths, JS whitespace, number formatting, `JSON.stringify` strings); no other crate re-implements them.
- **Vectors prove parity.** A behaviour ported from TypeScript is proved by conformance vectors exported from the real TypeScript (`scripts/vectors/*.ts`, `vectors/**`, drift-checked by `bun run vectors:check`) and replayed by `cargo test`; algorithms with a Lean model replay `formal/vectors.json`. Changing a TypeScript algorithm that has vectors means regenerating them.
- **Test seams are not shippable.** They live in `research-runner-testkit`; the production binary has no dependency on it (checked from `cargo metadata`) and contains none of its marker strings.
- **Performance.** `rayon` only for pure parallel work collected by index; async code reaches CPU work through the rayon/oneshot bridge, never on a tokio worker; hot paths scan bytes (`memchr`) instead of running regexes over large text.
- **Gates.** `bun run rust:check` (`cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`) and `bun run rust:test` (`cargo test --workspace --locked`) are part of `bun run verify`. Builds use `--locked`; `RUSTFLAGS` and `CARGO_BUILD_*` from the caller never reach a build the launcher runs.

## 5. SolidJS UI rules

| ID | Rule |
|---|---|
| UI-001 | Components render and dispatch typed user actions; no direct DB/CLI/LLM access |
| UI-002 | Prefer `createMemo` for pure derived state; reserve `createEffect` for synchronization with external effects |
| UI-003 | Keep workspace domain state separate from ephemeral hover/dialog/scroll state |
| UI-004 | Agent-origin UI operations MUST match a versioned discriminated-union schema and registered type |
| UI-005 | Render data via approved components; never eval JavaScript/JSX or render unsanitized agent HTML |
| UI-006 | Component updates MUST enforce workspace version, command ID uniqueness and dataset ownership |
| UI-007 | Use appropriate chart axis labels, financial units, as-of dates, source links and unavailable states |
| UI-008 | Every new registry component MUST include valid/invalid props fixtures, accessibility and regression tests |
| UI-009 | Store canonical command/state on server; client renders the accepted result, not an unverified LLM draft |
| UI-010 | A new component SHOULD be added via registry entry + schema + renderer + tests, without orchestrator changes |
| UI-011 | UI changes follow docs/DESIGN_GUIDELINE.md; the design conformance test must pass |
| UI-012 | A UI change is reviewed with `bun run review:ui`; see docs/rule/UI_review_rule.md |

UI reviews follow docs/rule/UI_review_rule.md.

## 6. Hono/Workers/API rules

- **API-001** Route handlers MUST remain thin: validate -> authenticate/authorize -> invoke use case -> map typed result to HTTP response.
- **API-002** All user/runner requests MUST be runtime-validated at entry; validate persisted JSON when schema version changes.
- **API-003** No domain module may use Hono `Context`, Worker bindings or SQL.
- **API-004** Every resource lookup and mutation MUST check owner/runner scope; personal use does not remove access control.
- **API-005** Cookie-based writes MUST have CSRF/origin protections; sessions must use secure cookie attributes.
- **API-006** Secrets stay in Worker bindings/local secured configuration, never frontend bundles or prompt/tool output.
- **API-007** External calls MUST have timeouts, response-size limits, retry ceilings and per-provider rate limits.
- **API-008** API errors MUST be stable machine-readable codes; no raw internal traces in HTTP responses.
- **API-009** DB schema changes MUST have explicit migrations and a validated rollback/restore strategy.
- **API-010** Cloudflare Worker runtime APIs must be tested in the target runtime, not only in Node mocks.

## 7. Agent and research rules

| ID | Rule |
|---|---|
| AGT-001 | Each backend has an isolated adapter implementing only supported capabilities |
| AGT-002 | No direct vendor SDK type escapes an adapter into domain/application contracts |
| AGT-003 | CLI accounts and subscriptions follow official supported uses; no token extraction, evasion, quota bypass or unsupported credential sharing |
| AGT-004 | All CLI execution uses an approved sandbox profile and per-job scratch directory |
| AGT-005 | Disable arbitrary shell execution, file editing, repo access and unrestricted network by default for research agents |
| AGT-006 | Tool calls are authorized **outside** the model using allowlists, typed schemas and scoped credentials |
| AGT-007 | Prompt-injected news content cannot alter permissions, tool policies or workflow budgets |
| AGT-008 | Tool/agent calls have time, size, step, budget and retry bounds; unknown cost is not reported as zero |
| AGT-009 | Models do not invent sources, retrieved passages, financial observations or unavailable data |
| AGT-010 | Persist run ID, provider/model, prompt/tool versions, inputs, evidence IDs, usage and terminal state |
| AGT-011 | Jobs must be lease-fenced, idempotent and recoverable when a runner disappears |
| AGT-012 | No automatic fallback to a paid provider without owner authorization |
| AGT-013 | Verification is separate from generation: evaluate evidence support and contradictions before publishing claims |
| AGT-014 | Store canonical chat independent from provider sessions so adapters can be switched |

## 8. Evidence and finance rules

- **DATA-001** Every material fact, company-supplier claim and financial number MUST point to one or more stored Evidence or Observation IDs.
- **DATA-002** Distinguish `publishedAt`, `retrievedAt`, `effectiveAt/asOf` and `analyzedAt`; no unstated assumption that news is current.
- **DATA-003** Distinguish observation, inference, hypothesis and forecast in storage and display.
- **DATA-004** Preserve contradictory evidence; do not cherry-pick sources solely because they support a forecast.
- **DATA-005** Financial calculations MUST define formula, currency, period, unit, market, actual-vs-estimate and missing-data semantics.
- **DATA-006** Never equate Japan's margin credit buy/sell balances with US security-level short interest or aggregate broker margin debt.
- **DATA-007** 13F position changes are reported holding changes, not proof of specific transaction dates.
- **DATA-008** Separate price realization from volume, FX, mix and cost effects in pricing-power analysis.
- **DATA-009** Forecasts MUST include base/target years, bear/base/bull scenarios or justified alternatives, assumptions, drivers and falsifiers.
- **DATA-010** Use only permitted reproduction/retention of articles, imagery and third-party financial data.
- **DATA-011** Unavailable means explicit `null` plus reason, not invented zeros.
- **DATA-012** Keep vendor-specific raw records in adapters; normalized domain records carry lineage to those records.

## 9. Security and robustness rules

- **SEC-001** Treat external HTML, Markdown, image links, URL parameters, news, LLM outputs and tool responses as untrusted.
- **SEC-002** URL ingestion MUST defend against SSRF at URL validation, DNS/connection, redirect and egress-control layers. If connection-time destination control is not enforceable, only use approved hosts or an isolated proxy.
- **SEC-003** No generated source code or scripts are executed to render research UI.
- **SEC-004** Use Content Security Policy and safe Markdown rendering; prohibit unsafe `innerHTML` with untrusted content.
- **SEC-005** Owner and runner credentials must be isolated, least-privilege, rotated/revoked and redacted in logs.
- **SEC-006** No unrestricted CLI process or shell privileges in research execution; OS-level controls must enforce restrictions independently of prompts.
- **SEC-007** Deny unknown UI command/tool/component schema versions unless a tested migration exists.
- **SEC-008** All externally triggered mutations require authorization, idempotency and bounded payloads.
- **SEC-009** Check dependency advisories, lockfiles, secret leakage and build artifacts before merge.
- **SEC-010** Record audit traces without revealing credentials or licensed full-text content.

Logging follows docs/rule/logging.md.

## 10. Testing rules and objective gates

### Required test matrix

| Category | Mandatory tests |
|---|---|
| Unit | Pure finance functions, normalization, dedupe, state transitions, validators |
| Property-based | Invariants on numeric transformations, state machines, parsers and idempotency |
| Contract | API, tool, agent event, UI protocol, schema migration, provider capability |
| Integration | Hono + D1 persistence, auth, job claim/lease/heartbeat, retries, source retrieval |
| UI | SolidJS component props, missing data, commands, update/reload, accessibility |
| E2E | Chat -> research -> sourced table/chart -> workspace reload |
| Security | XSS, SSRF redirect/private IP, malicious article instructions, unauthorized actions |
| Recovery | Runner killed during call, duplicate completion, stale lease, browser reload |
| Architecture | Forbidden imports, cycles, Worker/Node runtime separation |
| AI evaluation | Versioned benchmark: citations support claims, supplier linkage, contradictory evidence, data freshness |

Real-environment testing follows docs/rule/test_guideline.md.

### Hard acceptance gates

1. Strict typechecking, linting, formatting and production build all pass.
2. Schema/contract tests and representative E2E tests pass.
3. Zero successful unauthorized tool calls in the defined adversarial test suite.
4. Invalid UI commands are rejected; duplicate commands do not duplicate state.
5. Finance formulas match independently prepared fixtures (the implementation's own formula cannot serve as the test oracle).
6. Every displayed sourced numeric observation has a traceable reference and as-of date, or is explicitly unavailable.
7. No CLI credentials or secrets appear in built frontend assets, logs or prompts.
8. Runner death/retry does not violate lease ownership or duplicate persistent effects.
9. New component/provider registration is demonstrably independent of existing core logic.
10. Known unmet requirements are recorded; passing CI never automatically implies product acceptance.

Coverage percentage MAY be monitored, but **100% line coverage is not the acceptance target**. Favor risk-focused behavior tests and independent expected results.

## 11. Rules specifically for vibe coding / coding agents

### Before editing

1. Read the task's acceptance criteria, this rule file, relevant contracts and architectural decision records.
2. Identify affected modules, trust boundaries and dependency directions.
3. Define or update schemas and behavior tests before changing an inter-module contract.
4. Keep changes narrowly scoped; do not rewrite unrelated code.

### During implementation

5. Use existing approved patterns; do not invent a second dependency injection framework or duplicate error format.
6. Prefer small cohesive pure functions with explicit input/output types. Avoid hidden network effects.
7. Add new components/providers through intended registry/adapter extension points.
8. Do not weaken or delete failing tests, suppress diagnostics, or replace real implementations with success-shaped stubs.
9. Never change requirements silently to make implementation easier.
10. Do not claim a CLI capability, live market-data source or cost as verified unless tested or documented.

### Before declaring completion

11. Run the applicable formatting, lint, typecheck, unit, contract, integration, security and build commands.
12. Report exactly which checks passed, failed, or could not run, and why.
13. Map changes to requirement IDs and provide evidence of fulfillment; identify incomplete behaviors explicitly.
14. Record architectural exceptions in an ADR and obtain owner approval before accepting critical safety exceptions.
15. Never describe a mock, seeded value or unvalidated LLM output as verified production financial data.

### Pull request / coding-agent handoff template

```markdown
## Objective
[Requirement IDs and expected behavior]

## Design changes
[Modules, contracts, dependency direction, ADR if required]

## Verification
- [ ] Typecheck
- [ ] Lint/format
- [ ] Unit/property tests
- [ ] Contract/integration tests
- [ ] Security checks
- [ ] E2E (if UI behavior changed)

## Evidence
[Commands run, result summaries, fixture IDs]

## Unmet requirements and known limitations
[Explicitly list; do not claim completion if unmet]

## Security/cost impact
[Secrets, egress, CLI permissions, paid API use, data licensing]
```

## 12. Explicit anti-patterns

**Prohibited:** god components/services; circular imports; HTTP/DB calls from domain functions; generic `catch {}`; unsafe casts to silence errors; ad hoc agent-written HTML/JS execution; broad shell auto-approval; direct browser access to local CLI; unauthorized URLs; fictitious citations; tests which merely assert the implementation against itself; automatically spending through a paid API; vague `date`/`value` financial metrics.

**Avoid unless justified:** deep inheritance, distributed microservices, event sourcing for every UI interaction, blanket CQRS, excessive repositories, one-interface-per-function, arbitrary limits such as 20 lines per function, hand-built crypto, and speculative plugin frameworks outside the three known extension registries.

## 13. CI enforcement mapping

| Rule families | Enforcement |
|---|---|
| ARCH-001/006/012 | PR/ADR review + example extension test |
| ARCH-002/003/009/011 | pure-function tests, readonly types, lint, property tests |
| ARCH-004/007/014/018 | import boundary rules, cycle analysis, contract fixtures |
| ARCH-005 / UI-004 / API-002 | runtime schemas, positive/negative contract tests |
| ARCH-010/015/016/017 | Result/state machine/idempotency/error-path tests |
| ARCH-019 | "keeps the upstream status" tests per adapter, use case and API route; architecture test forbids parsing a status out of a failure's text |
| UI-001..010 | component tests, schema migration, E2E and XSS suite |
| AGT-001..014 | per-adapter capability tests, sandbox/permission verification, failure injection |
| DATA-001..012 | referential integrity and time/unit/filing fixtures |
| SEC-001..010 | threat-model-derived adversarial tests, secret scanning, network restrictions |
| FUNC-004 (Rust) | `cargo fmt --check`, `cargo clippy -- -D warnings` with the workspace lint deny list, `cargo test --locked`, conformance vectors (`bun run vectors:check`), testkit-isolation checks |

## 14. Authoritative sources

- SolidJS reactive memoization: https://docs.solidjs.com/reference/basic-reactivity/create-memo
- SolidJS reactive effects: https://docs.solidjs.com/reference/basic-reactivity/create-effect
- Hono RPC and typed contracts: https://hono.dev/docs/guides/rpc
- Cloudflare Worker runtime: https://developers.cloudflare.com/workers/
- OpenCode SDK / API: https://docs.opencode.ai/docs/sdk/
- OWASP LLM Top 10: https://genai.owasp.org/llm-top-10/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Companion system specification: [ARCHITECTURE_AND_REQUIREMENTS.md](ARCHITECTURE_AND_REQUIREMENTS.md)

**These rules are an engineering proposal for this project, not a verbatim standards document.** Revalidate vendor API and security guidance when implementing adapters.
