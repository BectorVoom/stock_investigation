# Japanese corporate-training report: no verified findings

## Reproduction and diagnosis

Read the development database without modifying it. The latest affected run was `run_31663be510448fe7d55a930c` (2026-11-12 06:53 UTC), question `日米の企業研修の需要が拡大しているか調査してください。`, output type `news`, backend `openrouter-free`, model `dots-studio/dots-3-note-preview:free`, medium effort. It completed unverified with four unsupported claims.

The original source was the archived `2026 Training Industry Report` (`https://trainingmag.com/2026-training-industry-report/`). Two claims had valid source quotes but failed `NUMBER_NOT_IN_EVIDENCE`: the source's `$108.5 billion` was rendered as `1085億ドル`, and million-dollar amounts were similarly converted to 万ドル while still classified as observations. Other claims had `QUOTE_NOT_FOUND`. The previous repair condition checked only whether quotations existed, so the valid quotations prevented a repair even though all claims failed deterministic verification.

## Changes

- The first analysis draft now goes through the existing complete deterministic claim verifier before deciding whether to repair. If every claim is unsupported, the existing second attempt is used. Genuine conflicting evidence is preserved without being treated as a generation error.
- Observation text must preserve original numeric notation/units across languages. A scaled/localized monetary value is an arithmetic inference and must quote its original numeric inputs; independent verification still checks it. No number-matching or source-verification rule was relaxed.
- Both pipelines share draft-to-claim mapping between preflight and final verification; draft IDs consume no persistent claim IDs. Rust reuses its prepared evidence index on the CPU pool.
- A real rerun (`run_ef7fcfac74bf82413927ef88`) exposed a separate failure: both analysis and compact repair hit Dots Note free's previous 8,192 total-token cap. Its whole-run retry then collected no original evidence. Both adapters now allow 32,768 tokens for this exact free model, preserving effort and free-cost enforcement; paid and near-match IDs retain 8,192. The live model catalogue reported a 460,800-token provider maximum. Exhausted truncation repair is now non-retryable, avoiding a redundant whole-run retry at the same cap.
- Added a regression for Japanese billion-to-億 conversion: the observation is rejected, a properly sourced inference is repaired and independently verified. Added an opt-in real-environment test of the exact Japanese question, news output, medium effort and a rendered verified claim/citation.

No schema change or new domain algorithm was introduced. Existing Lean proofs/formal vectors remain current; the actual arithmetic and source verifier are unchanged. The provider profile and its request example are documented in [OpenRouter](../external-apis/apis/openrouter.md).

## Validation and external block

- Selected application/provider/documentation suites: 667 tests passed, including all 456 application tests.
- Provider suites and external API documentation checks also passed independently; the Dots request example is compared byte-for-byte with the production adapter.
- Application and provider Rust tests passed; conformance vectors were regenerated and repository-wide vector drift check passed.
- Typecheck, workspace Rust formatting/Clippy, benchmark budgets and Lean/formal-vector checks were run; final command outcomes are recorded with this change.
- Original-model isolated development attempt: real Chrome, Rust runner, OpenRouter and live Agent Web Search, same Japanese question; no successful report was obtained at 8,192. Interrupted after reproducing provider truncation; not a passing live test.
- After increasing the cap, a direct production-shaped Dots request returned HTTP 429, `openrouter_free_tier_daily`. The key authenticated successfully; its per-key allowance was not exhausted.
- The newly added exact-question live test was also attempted on `openrouter`, `openai/gpt-4.1-mini`, medium effort, news output, $0.50 cap, real isolated development launcher/Rust runner, Chrome, Agent Web Search. It failed immediately with `PROVIDER_PAYMENT_REQUIRED` before tool calls. The account credits endpoint reported no purchased credits. Artifacts: `test-results-real/live-live-positive-path-th-a0eb2--produces-verified-findings/`; preserved throwaway data: `/var/folders/wc/4h0g65w97b32s862x86qgbx80000gn/T/research-live-dev-a-dSZQqK`.

The operational rerun was an authorized attempt to repair the user's report, separate from isolated tests. It preserved the selected free backend/model, original question, output type and budgets, and did not alter saved settings or the old report. It failed after truncation and a failed whole-run retry; no verified replacement is claimed. Further regeneration is blocked by the provider's free daily quota and paid-credit requirements. No credits were purchased and no automatic paid fallback or backend change was made.

Final command outcomes after the completion-cap and retryability fixes: selected Vitest suites 667 passed; Rust application/provider suites 44 passed (2 existing timing cases ignored); full repository vector check passed; typecheck passed; workspace `rust:check` passed; Biome and diff-whitespace checks passed. Benchmark budgets and existing Lean/formal-vector checks also passed during this repair. The later live provider limits did not produce a verified replacement report, and are not treated as a successful live check.
