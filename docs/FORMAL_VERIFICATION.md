# Formal verification (Lean 4)

`AGENTS.md` asks for Lean 4 verification of algorithmic correctness. The Lean project lives in `formal/` (toolchain pinned in `formal/lean-toolchain`, no Mathlib, no `sorry`, no axioms).

## What is proved

| Lean file | Mirrors | Theorems (plain language) |
|---|---|---|
| `JobStateMachine.lean` | `packages/domain/src/jobs/stateMachine.ts` | Terminal states are exactly the states with no successor and are absorbing; no path ever leaves a finished job (`terminal_is_final`); every state can reach a terminal one; every leased state can return to `pending`, be cancelled and be failed; `completed` is reachable only from `publishing`, `publishing` only from `verifying`, a lease only from `pending`; `partial` needs collection to have started; a pause for approval is possible only from a stage that can spend and resumes only through the queue; no self-transitions. |
| `Lease.lean` | `packages/domain/src/jobs/lease.ts` | A granted claim increments attempt and generation by exactly one and never exceeds the retry ceiling; cancelled, finished and live-leased jobs are never claimable (single lease); after a re-claim every proof with an older generation is rejected whoever presents it (fencing) and never becomes valid again; at most one (runner, generation) pair passes the lease check (mutual exclusion); the claimant's own proof is accepted. |
| `Budget.lean` | `packages/domain/src/jobs/budget.ts` | The budget check is sound and complete; usage is monotone; a run that performs each step only after the check passes never exceeds any ceiling, for any sequence of requested steps; with a zero spend ceiling no positively-priced step is allowed. |
| `Workspace.lean` | `packages/domain/src/workspace/reducer.ts` (structural part) | An accepted command was written against the current version and bumps it by exactly one; a stale command is rejected; the same expected version can never be accepted twice (idempotent submission); every accepted operation preserves "component ids unique and the layout lists each exactly once" — including a pigeonhole proof that the reducer's one-directional layout check is sufficient; applying any list of instructions with rejects skipped keeps the invariant and moves the version by at most one per instruction. |
| `Classification.lean` | `finance/filings.ts`, `evidence/verifyClaims.ts`, pipeline verifier rule | Exact characterisation of each reported-position change; a "supported" claim always has verified support, no contradiction and no unsupported number; contradictions surface as "conflicting"; the independent verifier can only downgrade, never upgrade. |
| `RecentWithinBudget.lean` | `text/recentWithinBudget.ts` | The kept count never exceeds `maxItems` or the number of items; the kept total never exceeds `budget`; when the count is smaller than both, adding the next older item would exceed `budget` (maximality, so no item is ever skipped). |

## How the proofs are tied to the TypeScript

A Lean proof is about a Lean definition, not about TypeScript. The link is differential:

1. `formal/Export.lean` evaluates the **verified** definitions over exhaustive small grids and prints `formal/vectors.json` (state lists and the full transition matrix; 768 `decideClaim` cases; 288 `checkLease` cases; 768 budget cases under one fixed small budget; all 1,110 operation sequences of length ≤ 3 over a ten-operation alphabet for the reducer; 80 version-guard cases — every operation against three setups, each submitted with a stale (where one exists), the current and a future expected version, then resubmitted unchanged; classifier grids; 2,040 `recentWithinBudget` cases — every list of length 0..3 over sizes {0, 1, 2, 3}, every budget 0..5, every `maxItems` 0..3). `ResearchFormal/Basic.lean` holds only two shared rewriting helpers for `if`, no app theorems.
2. `tests/formal/conformance.test.ts` replays every vector against the TypeScript implementation in the normal test run. It needs no Lean toolchain.
3. `bun run formal:check` (CI job `formal`) rebuilds the proofs, rejects `sorry`/`axiom`, regenerates the vectors and fails if they differ from the committed file.

So a change to the TypeScript that departs from the model fails step 2, and a change to the model that is not re-exported fails step 3.

## What is not proved

- The correspondence is tested on finite grids, not proved for all inputs. The grids are exhaustive over the discrete structure (every state, every branch of every condition) but not over unbounded numbers or arbitrary strings.
- Floating-point behaviour (NaN handling in budgets, CAGR, PER, margins) is covered by unit and property tests, not Lean: the models use natural numbers.
- Time is abstracted to one bit (`leaseExpired`); clock skew is outside the model. Fencing does not depend on clocks, which is the point of the generation counter.
- The reducer model abstracts component props and reference checks (datasets, sources, assets); those are covered by unit, property and integration tests.
- SQL-level atomicity (the guarded D1 batches) is exercised by integration tests in the Workers runtime, not modelled.
- Feed parsing, URL/IP classification and claim text matching are not modelled.
- String truncation (`truncateText`, now in `packages/domain/src/text/truncate.ts`) and the context builder's text handling in `buildConversationContext` (trimming, the per-message cut, UTF-8 byte counting) are covered by unit and property tests, not by Lean; only the selection count (`recentCountWithinBudget`) is modelled.

## Running

```sh
# one-time: install the Lean toolchain manager (https://lean-lang.org/install/)
bun run formal:check          # lake build + no-sorry check + vectors are current
bun run test                  # includes tests/formal/conformance.test.ts
```
