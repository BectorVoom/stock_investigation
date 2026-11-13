# Analysis output truncation recovery

The analysis stage previously stopped on `PROVIDER_OUTPUT_TRUNCATED` without using its repair allowance. Both the TypeScript pipeline and Rust runner now use the remaining analysis attempt to request a smaller complete JSON answer (at most six short claims and minimal sufficient quotes). The failed output is never accepted. Successful repair still goes through ordinary schema validation, quote checks and independent verification. Every turn retains the existing cumulative spend, step, input and time ceilings; a second truncation stops as before and preserves available tool records.

The omission notice now gives separate numeric duplicate and input-budget counts, including zero budget omissions when only a duplicate was skipped.

Validation on `main`, 2026-11-12:

- `bunx vitest run packages/application/test/pipeline.test.ts packages/application/test/promptVolume.test.ts`: 79 passed.
- `bun run typecheck`: passed.
- `cargo test -p research-application --locked`: 28 passed, 2 existing timing tests ignored. Includes TypeScript transcript replay and targeted recovered/exhausted truncation vectors.
- `node scripts/vectors/index.ts --check pipeline`: passed.
- Biome check of edited TypeScript files: passed.
- `cargo clippy -p research-application --all-targets --locked -- -D warnings`: blocked by existing `needless_late_init` in `crates/research-js/src/math.rs:247`.
- `RUN_LIVE_AGENT=claude-code bun run test:real:live`: Chrome, isolated pristine copy and throwaway development database, real `bun run dev` launcher and runner. Fresh-state research reached the backend but failed `PROVIDER_AUTH`; interrupted rather than waiting for the completion assertion. No positive-path research proof; upgraded-state coverage not reached. Backend default model was used. Authentication must be restored before repeating this check.

No domain algorithm changed, so no Lean model or hot-path benchmark change is required. The historical failed response was not rerun or rewritten.

## OpenRouter verification attempt

At the owner's request, repeated with `RUN_LIVE_AGENT=openrouter RUN_LIVE_MODEL=openai/gpt-4.1-mini` and a $0.50 per-question ceiling, using the existing credential without printing it. The exact research file was selected with `bunx playwright test --config tests/real/playwright.config.ts '(^|/)live\.spec\.ts$'` (Chrome, real Rust runner, isolated pristine development copy and throwaway data directories).

The live harness now supplies `OPENROUTER_MODEL` in its test-owned runner environment, accepts the singular probed model capability, and uses Settings' Other → Model id control for paid OpenRouter models. An initial attempt exposed the selector mismatch before making a research request; it was corrected before repeating.

The repeated fresh-state UI flow saved Settings, subscribed the feed and submitted research. The run failed `PROVIDER_AUTH`, preserving upstream HTTP 401. A direct authenticated `GET https://openrouter.ai/api/v1/key` confirmed HTTP 401 with `API key expired.` The test was interrupted after this terminal failure rather than waiting for its completion assertion. No successful model output or truncation recovery was verified live; the upgraded-state and remaining research checks were not reached. Renew/replace the configured credential and repeat. No operational database or saved user settings were changed.

## Replacement key and successful OpenRouter requests

The replacement `OPENROUTER_API_KEY` in root `.env` passed the authenticated key check (HTTP 200). The runner-specific `apps/runner/.env` still contained the expired key. Tests explicitly used the valid root key in their isolated environment; neither credential file was modified or printed.

Repeated the exact-file Chrome suite with `openrouter`, `openai/gpt-4.1-mini`, $0.50 per-question ceiling, real `bun run dev` and Rust runner on main:

- First run: fresh-state test passed with cited findings and source-card interaction; research cost $0.010738. Stored-news research also completed ($0.003870) and the snapshot showed a cited finding. Its UI assertion failed because it scoped the citation to the progress element rather than the assistant article. Fixed that locator without weakening the citation requirement.
- Rerun after the locator fix: fresh-state research completed, cost $0.0153188, but verification rejected the claims (`verificationStatus=unverified`); the UI displayed `No verified findings are available for this report.` The test failed its nonempty-claims assertion. Remaining tests (including upgraded-state, page fetch and search) were not reached. This model-quality finding is unresolved; do not describe the full live suite as passing.
- Neither attempt reproduced `PROVIDER_OUTPUT_TRUNCATED`; recovery itself remains covered by deterministic TypeScript tests and Rust transcript conformance, not a live forced-truncation reproduction.
- Biome and diff whitespace checks passed after the locator fix.

Failure evidence is in `test-results-real/live-live-positive-path-th-4ca9b-save-subscribe-ask-complete/` and preserved throwaway data directory `/var/folders/wc/4h0g65w97b32s862x86qgbx80000gn/T/research-live-dev-a-O2N2kn`. The earlier stored-news screenshot is in `test-results-real/live-live-positive-path-th-bf1cb--a-stored-real-news-article/` with data directory `/var/folders/wc/4h0g65w97b32s862x86qgbx80000gn/T/research-live-dev-a-dVsVns`.

## Follow-up repairs and remaining verification

The preserved failed report contained six `QUOTE_NOT_FOUND` claims: all quoted support had been paraphrased. The stronger carried-over-settings check subsequently exposed generated UUIDs that were not evidence IDs (`UNKNOWN_EVIDENCE`). These are generation failures; the source verifier correctly rejected them.

Both pipelines now use the existing first analysis attempt's repair allowance when every claim lacks usable verbatim support from a shown evidence ID. The repair lists the first twelve actual evidence IDs, requests short exact passages, and forbids invented IDs and altered dates/numbers. The analysis instructions distinguish bracketed evidence IDs from the random enclosing fence token. The second draft still goes through ordinary source and independent verification; an invalid second draft remains unsupported. No fuzzy ID remapping or relaxed source matching was added. Existing budgets bound all retries. Rust prepares its evidence index once on the CPU pool and reuses it for verification.

Additional fixes:

- The stored-news test now finds citations in the assistant article, rather than the progress element.
- The web-search test explicitly asks for `web.search` and original-page retrieval; its previous question also allowed `news.search` despite asserting only `web.search`. The earlier failed run used GDELT, hit its failure/cooldown, and fell back to a feed. The web-search assertion was preserved.
- The carried-over-settings test no longer asserts the spending gate superseded by ADR-0035. It sends a real page question without visiting Settings and requires the newly sent run to complete with a claim and citation, rather than polling the unrelated seed run. This is a populated current-schema/no-saved-settings scenario, not a historical schema migration test.
- The stale runner-specific OpenRouter key was synchronized from the valid root `.env`, without printing or committing either credential. Other runner settings and operational data were preserved. Already running runner processes must reload their environment to use it.
- Fixed Clippy's existing `needless_late_init` in `research-js/src/math.rs` by using the branch expression directly; arithmetic/order of evaluation are unchanged and V8 bit-for-bit math vectors pass.
- Packing-vector probes now carry a real verbatim fixture passage so their byte/step boundary checks are independent of citation repair. Separate cases cover invalid citations, exhausted repair, truncation recovery and budget stops.

Deterministic verification after these changes:

- Pipeline + prompt-volume tests: 81 passed.
- `bun run typecheck`: passed.
- `cargo test -p research-application -p research-js --locked`: 28 application tests, 29 JS tests and 3 JS vector tests passed; 2 existing timing tests ignored.
- `cargo clippy -p research-application --all-targets --locked -- -D warnings`: passed.
- Pipeline vectors regenerated and replayed successfully.
- `bun run bench`: all budgets passed (including claim verification); `bun run formal:check`: Lean proofs build and formal vectors are current, with existing unused-binding/simp warnings.

Live verification remains actual OpenRouter API calls using `openai/gpt-4.1-mini`, Chrome, isolated real development launchers and Rust runners on `main`. Five checks passed together (fresh-state research, stored-news citations, page archive, Agent Web Search, chat rename/delete); after fixing the obsolete spending assertion and invalid-ID generation, the strengthened carried-over-settings check passed separately. Earlier failed attempts are retained above; the final complete-file run is recorded below when finished. No naturally truncated provider answer has occurred in these live attempts; the truncation-specific recovery path is covered by deterministic events and Rust replay, not a forced live truncation experiment.

### Final verification outcome

All six live checks passed on the final code across the complete-file run and the targeted rerun:

1. Fresh Settings → subscription → research → cited answer and source card.
2. Stored-news retrieval through `stocks.search` → cited finding.
3. Real public-page retrieval → archived Markdown.
4. Agent Web Search → original-page retrieval → completed research; reported costs were positive and below the suite's explicit $0.50 limits.
5. Chat rename/delete and server-side removal.
6. Current-schema carried-over settings → a new real page question completes with a verified claim/citation without visiting Settings. Its missing spend cap is intentional under ADR-0035; other budget ceilings remain in force.

The final complete-file command passed the first five checks but its restart into the sixth encountered `ENOSPC`, causing runner/API write failures. Interrupted that run, removed reinstallable dependencies only from test copies created during this investigation and superseded Rust test executables (about 2 GiB), then reran the sixth check on the same code with `--grep 'upgraded state'`: passed (26.6 s; 1.3 min including launchers). Operational data was untouched. Preserved earlier failure logs/databases; removed dependency trees can be reinstalled. The interrupted suite's own cleanup removed its temporary data, so the captured command output/Playwright artifacts are the evidence for that infrastructure failure.

Final deterministic results: all 455 application tests passed; full `bun run rust:test` passed (715 tests, 13 existing ignored timing/opt-in cases); full `bun run rust:check` passed. Updated the runner's golden input-byte counts through `UPDATE_VECTORS=1 cargo test -p research-runner --locked golden_outgoing_payloads_are_current` after the prompt change. The repository-wide vector check also exposed provider fixtures stale from pre-existing OpenCode isolation test additions; regenerated those with the provider exporter without changing provider behavior.

The historical failed response remains unchanged. These live successes demonstrate the real OpenRouter/network/application path; they do not establish deterministic model quality for every question, nor force a real provider truncation. Bounded truncation/invalid-citation recovery, exhausted retries, budget preservation and strict source rejection are additionally covered by deterministic regression tests and Rust transcript replay.

After refreshing the provider fixtures, full `bun run vectors:check` and `cargo test -p research-providers --locked` both passed. No provider implementation was changed for this fixture refresh.
