# OpenCode independent review — 2026-11-13

Actual CLI: OpenCode v2.2.6.
Model: `opencode/nemotron-3.5-lightning-free` (explicit free route, no paid fallback).
Command: `opencode run --standalone --format json --agent research-text --model opencode/nemotron-3.5-lightning-free`.
Prompt: stdin; cwd an isolated scratch directory; config copied from the project's `OPENCODE_FREE_TIER_CONFIG_CONTENT`. No `--auto`. Permissions deny unknown tools and ask/reject gated tools non-interactively. No repository files or browser test state changed by this review.

Initial execution: exit0; provider-reported cost0; input32,317 tokens/output895/reasoning8,866. Stream had step_start, text, step_finish; no tool events.
Prompt packet SHA256: `29571a8fd2b2672994a3872ec8cf9e146dc5add38f835df44835c27319adc5f5`.

## Initial OpenCode output (preserved verbatim)

## Review Findings: Cross-Browser E2E & Administrator Login

After reviewing the implementation and test changes, here are the actual defects and limitations found.

---

### Actual Defects

| Severity | File:Line | Trigger | Impact |
|----------|-----------|---------|--------|
| Low | `apps/web/src/auth/LoginPage.tsx:49` | Clicking "Sign in with Cloudflare Access" button | `onClick={props.signIn}` invokes `() => props.window.location.reload()`. This unconditionally reloads the page rather than initiating a Cloudflare Access OAuth redirect. The session state updates on the next render based on the API response. While this works for the app's intended flow (localhost auto-login + reload triggers Access check), it does not follow the typical Cloudflare Access redirect pattern and may feel inconsistent if users expect a redirect-based login. |
| Medium | `apps/api/src/auth.ts:231-232` | API request from a hostname not in `LOCAL_HOSTNAMES` with `AUTH_MODE=local-dev` | `if (!LOCAL_HOSTNAMES.has(new URL(request.url).hostname)) return err("UNAUTHENTICATED")`. If `LOCAL_HOSTNAMES` does not include the specific localhost hostname (e.g., custom ports, internal IP `10.x.x.x`, `::1`), the local-dev authenticator rejects the request, causing the session to remain unavailable and the `LoginPage` to display even on localhost. |
| Low | `apps/web/vite.config.ts:25-50` | Development mode (`bun run dev`) vs production build | The `cspMetaFromHeadersFile` plugin has `apply: "build"`, so the strict CSP meta tag is only injected during production builds. In development, the Vite dev server injects inline `<style>` elements under `style-src 'self'`, and the CSP meta tag is absent. This creates an intentional development/production disparity — CSP is weaker in development and only enforced in production. |

---

### Limitations (Not Defects)

| Category | Description |
|----------|-------------|
| Cross-browser CSS/SVG rendering | Target browser floor (Chrome 111, Edge 111, Firefox 128, Safari 16.4) covers modern support, but exact pixel differences in font rendering, box model, and SVG rasterization are expected across browsers. The indicator sparkline dimensions use `toBeCloseTo(72, 3)` / `toBeCloseTo(24, 3)` tolerance precisely for this. |
| Playwright platform-specific browser launch | `engines.ts` has macOS Firefox TCC blocks and Chrome channel selection — these are test infrastructure concerns, not app defects. |
| Zod jitless performance trade-off | `zodJitless.ts` configures `jitless: true` to keep Zod CSP-compliant (no eval). This adds a small runtime overhead and may slow schema validation marginally, but is necessary for the strict CSP requirement. |
| Dev/prod CSP disparity | The `_headers` file CSP and the Vite-injected meta tag are the single source of truth; the dev/build difference is acknowledged and intentional (defense-in-depth for dev inline styles). |

---

### Test Changes Assessment

No test changes weaken behavior checks. The research.spec.ts removals of `research-report` count checks are replaced with stronger server-state validations (stored workspace schema, disclaimer text, statement status). The hostile-model-text test is newly added (`SEC-003, UI-005`). Text updates (e.g., `"USD per XAU"` → `"$ per XAU"`) merely align expected output with actual display. Browser-compatibility tolerances (`toBeCloseTo`, `ratio: 0.999`) replace exact checks that failed on WebKit/Firefox quirks.

---

**Summary:** Three actual defects found (1 medium, 2 low severity). No blocking issues prevent the deployed Cloudflare administrator-only login from working with localhost automatic login preserved. CSP remains strict in production; untrusted text stays inert via the research report's disclaimer and dialog rendering; persisted widget state originates from confirmed server data.

## Human/parent-agent triage of initial claims

These are dispositions, not omitted findings:

1. Low: reload rather than explicit OAuth redirect. **Rejected as a defect.** The whole deployed hostname is protected by Access. A full document reload invokes its edge302 login redirect. Existing live Playwright checks prove the root redirects to the configured team; the regression test proves a document request and preserves the hash route. No bespoke OAuth endpoint is needed.
2. Medium: local hostname/ports/IPv6 rejection. **Rejected as a defect.** Actual allowlist includes localhost,127.0.0.1,[::1]. URL.hostname excludes the port. Nonloopback10.x hosts are intentionally refused under local-dev to fail closed. The model inferred missing constant values from an excerpt.
3. Low: development CSP weaker than build CSP. **Rejected as a new defect.** This is an explicit existing HMR development exception. Production `_headers` and injected meta keep strict CSP; no CSP relaxation was introduced.

The output also misdescribes the hostile-model-text test as newly added (it existed and was adapted) and inaccurately attributes inert XSS behavior to disclaimer text (plain-text rendering/CSP provide it). These inaccuracies were explicitly corrected in the follow-up prompt.

## Follow-up

The same OpenCode review session is being rechecked with the above primary facts.
Command: same as initial with `--session <same-review-session>`. Model unchanged.
No source modifications or model substitution.

Follow-up completed: exit0, provider-reported cost0. No tool events.

### Follow-up OpenCode output (verbatim)

## Reassessment Against Supplied Facts

All three prior findings are eliminated by the supplied primary facts:

1. **LoginPage `location.reload()`** — The deployed app uses Cloudflare Access with whole-hostname protection. Both anonymous HTTPS root and `/api/v1/session` return 302 to `appservice27.cloudflareaccess.com`. `location.reload()` is the correct full-document navigation to the protected hostname that triggers Cloudflare Access flow; the sign-in regression test confirms navigation while preserving the hash route. No bespoke OAuth client is needed. **Defect eliminated.**

2. **LOCAL_HOSTNAMES scope** — The constant is `new Set(["localhost", "127.0.0.1", "[::1]"])`. URL.hostname strips ports (`new URL("http://localhost:8787").hostname === "localhost"`), and IPv6 loopback is `"[::1]"`. Internal 10.x addresses are deliberately rejected as a security requirement (local-dev authorized only for loopback). This is existing behavior, not a new defect. **Defect eliminated.**

3. **CSP dev/prod disparity** — The Vite plugin `cspMetaFromHeadersFile` has `apply: "build"` explicitly, with its own comment: "the built index.html also carries the policy as a <meta>. The header file stays the single source of truth... Build-only, because the Vite dev server injects inline <style> elements that style-src 'self' forbids." This is an intentionally accepted dev/build tooling difference; the strict CSP remains on production builds via `_headers`. **Defect eliminated.**

Additionally, the hostile-model-text test was adapted from existing code, not newly added; inert XSS behavior derives from plain-text rendering and strict CSP, not disclaimer wording.

---

No remaining actionable defects. All prior findings are resolved by the supplied facts, and no blocking issues exist in the source or test changes when assessed with the complete deployment context.

## Supplemental lazy-viewer retry review

Same OpenCode CLIv2.2.6, free model, isolated config and review session. Both supplemental turns exit0, reported cost0, no tool events. Commands are the initial command plus `--session <same-review-session>`. No source edits or browser servers were run by the reviewer.

### Initial supplemental OpenCode output (verbatim)

## Independent Review: Chart Viewer Lazy Load / WebKit Caching Fix

### Blocking Defect Found

| Severity | File:Line | Trigger | Evidence | Impact |
|----------|-----------|---------|----------|--------|
| Critical | `apps/web/build/chartViewerChunk.ts:26` | `load()` hook returns module source in build mode | `return \`export default import.meta.ROLLUP_FILE_URL_${reference};\`` — The `load` hook returns JavaScript source that becomes the module's runtime code. `import.meta.ROLLUP_FILE_URL` is not a browser API; evaluating `import.meta.ROLLUP_FILE_URL_${reference}` causes a `ReferenceError` when the virtual module `virtual:chart-viewer-url` is imported. The type declaration at `chunkUrl.d.ts:2` expects a string URL export, but the actual returned code is invalid at runtime. | The chart viewer cannot load in build mode. Any import of the virtual module (which `viewerImport.ts` presumably does) throws at runtime, preventing the entire lazy-chartViewer flow. This defeats the patch's purpose. |

### Additional Observations (Not Necessarily Defects)

| Category | Description |
|----------|-------------|
| `emitFile` return semantics | `apps/web/build/chartViewerChunk.ts:21-26` — `this.emitFile({ type: "chunk", ... })` return value type depends on Vite/Rollup version. Embedding it as `${reference}` in `import.meta.ROLLUP_FILE_URL_${reference}` is fragile; if `reference` is not a plain string (e.g., an object or number), the template literal produces unpredictable runtime code. |
| Cache‑busting import path | `apps/web/src/chartViewer/LazyChartViewer.tsx:38-46` and `viewerImport.ts` (not fully provided) — The `failedAttempts` counter is passed to `importViewerModule`, but without seeing that module's implementation, it cannot be verified that the dynamic import appends a distinct query parameter (e.g., `?t=1`) to bust WebKit's failed‑import cache. The test routes `/assets/ChartViewer-*.js(?:\?.*)?$` allowing optional queries, but the actual import path construction is opaque. |
| Promise‑race on concurrent opens | `apps/web/src/chartViewer/LazyChartViewer.tsx:35-47` — `viewerChunk` is module‑level `null`/promise. Rapid successive opener presses with `viewerChunk === null` could trigger multiple concurrent `importViewerModule()` calls, confused `failedAttempts` increments, and race conditions in the catch block (`viewerChunk = null`). This is an edge case but could manifest under fast user interaction. |
| CSS preload/scope | `assetsInlineLimit: 0` in `vite.config.ts:85` ensures no asset inlining, but dynamic import of a chunk with associated CSS depends on Vite's default behavior. No explicit CSS-handling hook is present; in practice Vite usually handles CSS for dynamically imported chunks, but this is not guaranteed across all build configurations. |

### Conclusion

**One blocking defect** is confirmed: the virtual module export at `chartViewerChunk.ts:26` produces invalid runtime JavaScript (`import.meta.ROLLUP_FILE_URL_` is undefined in browsers), making the chart viewer inoperable in build mode. The other observations are either environment‑dependent or require inspection of `viewerImport.ts` (not fully in context) to confirm as defects.

No further defects can be confirmed from the provided code alone.

### Disposition of supplemental initial claims

The Critical compiler-marker claim is rejected/withdrawn: Rollup explicitly replaces `import.meta.ROLLUP_FILE_URL_referenceId` during compilation. Actual emitted JS has a concrete `/assets/ChartViewer-*.js` string and no unresolved marker. Source and real retry browser results corroborate this. Primary reference: https://rollupjs.org/plugin-development/#file-urls .

The first packet raced with a structural extraction and omitted the new `viewerImport.ts`; the final packet includes the complete source and updated unit mocks. The Promise-race observation lacked a valid interleaving: assignment is synchronous before yielding, and concurrent opens share the Promise. CSS/static-dependency recovery is explicitly outside the root-asset retry guarantee.

### Final supplemental OpenCode output (verbatim)

## Reassessment: Prior Finding Withdrawn, No Remaining Defects

### Withdrawn Finding

The prior "critical" defect at `apps/web/build/chartViewerChunk.ts:26` — regarding `import.meta.ROLLUP_FILE_URL_${reference}` as an invalid browser API — is **eliminated** by primary compiler evidence:

- Rollup's official plugin development documentation explicitly documents `import.meta.ROLLUP_FILE_URL_referenceId` as a compile-time replacement that generates emitted file URLs, supporting both assets and chunks.
- The actual built index contains **zero** `ROLLUP_FILE_URL_` markers. The built code has been transformed to `import("./ChartViewer-CL0n1A9-.js")` with `var tu="/assets/ChartViewer-CL0n1A9-.js"`. The marker is a bundler-phase construct that Rollup inlines/substitutes before emission; the browser never sees it.
- The parent reports E2E root-chunk-failure/retry behavior passed **Chrome, Firefox, and WebKit**.

This finding was based on a misunderstanding of the Rollup compilation model and is hereby withdrawn.

### Current Implementation Review

The remaining source files (`chartViewerChunk.ts`, `viewerImport.ts`, `LazyChartViewer.tsx`) implement the lazy-chart-viewer retry-and-cache-bust flow as follows:

1. **Virtual module resolution**: `chartViewerChunk.ts` supplies the virtual module `virtual:chart-viewer-url` via Vite's `resolveId`/`load` hooks, emitting a chunk with `emitFile({type: "chunk", ...})`. The returned `reference` string is Rollup-internal and gets transformed during build.

2. **Import flow** (`viewerImport.ts:18-27`):
   - `failedAttempts === 0`: direct `import("./ChartViewer.tsx")` — first load via normal Vite resolution.
   - `failedAttempts > 0`: constructs `new URL(viewerModuleUrl, import.meta.url)` with `?chart-retry=N` query parameter, then `import(/* @vite-ignore */ url.href)`. The query param defeats WebKit's failed-import cache, triggering a fresh fetch of the same-origin compiled asset.

3. **Module-shape guard** (`viewerImport.ts:7-16`): `isViewerModule` validates that loaded exports contain both `ChartViewer` and `InlineChartViewer` as functions, rejecting invalid modules.

4. **Promise sharing** (`LazyChartViewer.tsx:35-47`): Module-level `viewerChunk` promise is set once, cleared on catch (`viewerChunk = null`), and retries increment `failedAttempts`. Concurrent opens share the same promise; no practical race given synchronous assignment before yielding (as noted in code comments).

5. **E2E test coverage** (`tests/e2e/chartViewer.spec.ts`): Routes `/assets/ChartViewer-[^/?]*\.js(?:\?.*)?$`, asserts `blocked === 0` on initial navigation (retry URL does not cause eager download), verifies `Try again` re-fetches the chunk, and confirms viewer opens after network restoration. Screenshot helper confines inline-style injection to Chromium only; all geometry/assertions run on every engine.

### Conclusion

**No remaining actionable defects.** The implementation correctly satisfies the stated requirements: strict CSP compatibility (no `eval`, no inline script), persisted widget state from confirmed server data, same-origin retry URLs with cache-busting query params, lazy/typed/normal Vite preload behavior, and cross-browser E2E function verified on Chrome, Firefox, and WebKit. The prior finding is withdrawn with the supplied compiler evidence.

Metadata first: `[{"reason": "stop", "cost": 0, "tokens": {"input": 41145, "output": 777, "reasoning": 10339, "cache": {"read": 0, "write": 0}}}]`

Metadata final: `[{"reason": "stop", "cost": 0, "tokens": {"input": 7811, "output": 785, "reasoning": 3351, "cache": {"read": 40128, "write": 0}}}]`

Final viewer packet SHA256: `ef2a18b4146d7b49455672eef241ca09cc66426713e62acb189fc310ed925c5a`
