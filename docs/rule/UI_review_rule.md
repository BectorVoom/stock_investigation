# UI review

UI changes are reviewed in a real browser with Playwright before they are
called done (rule UI-012). The repeatable record is the scripted review, not
an interactive session.

## When a review is required

- Any change under `apps/web/src` or `packages/ui-registry/src` that alters
  layout or interaction: run `bun run review:ui` and read its screenshots
  before calling the change done.

## How to run it

- `bun run review:ui` starts the same server stack as the E2E suite (its
  config reuses the E2E web server, global setup and fixtures) and is
  self-sufficient: it subscribes the fixture source, chooses the scripted
  backend, starts a conversation, asks one question and waits for the answer.
- The engine is selected with `REVIEW_BROWSER=chrome|firefox|webkit`
  (default chrome); output goes under `test-results/ui-review/<engine>/`.
  A UI change is reviewed in all three engines before it is called done:
  run it once per engine and fix anything the Firefox or WebKit review shows
  that is not present in Chrome.
  ```sh
  REVIEW_BROWSER=chrome bun run review:ui
  REVIEW_BROWSER=firefox bun run review:ui
  REVIEW_BROWSER=webkit bun run review:ui
  ```
- It is a REVIEW, not a gate: it never fails because of a finding. It writes
  `test-results/ui-review/<engine>/findings.json` and one PNG per state, then prints a
  summary table (`rule -> count`). It fails only when the review itself could
  not run. It is not part of `bun run test:e2e` or CI.

## What it covers

- Viewports 1440×900, 1280×720, 820×1180, 390×844; states thread, run
  details, composer disclosures, records drawer, keyboard order, long draft,
  long-word send, after-answer, many conversations, empty conversation,
  small-viewport top/bottom, no-backend guidance.
- Checks: overflow, obscured/covered, small-target (< 24×24),
  no-accessible-name, low-contrast (AA), tiny-text, heading-skip,
  wider-than-box, clipped-text, focus visibility, drawer/composer behaviour,
  console/pageerror capture.

## How to read the findings

- Read the PNGs with the JSON: a person (or agent) looks at every
  screenshot; the JSON alone is not the review.
- Known limitation: an element scrolled out of a scroll container can be
  reported as "obscured". Findings are leads, not verdicts — confirm each one
  in the screenshot before changing code.
- Known tooling artifact: every Playwright screenshot injects a transient
  `<style>body {}</style>` sheet; under the app's strict `style-src 'self'`
  policy WebKit reports each injection as a page console error while Chromium
  stays silent. The review filters these reports (only when the page holds no
  application-authored `<style>` element); a genuine application CSP violation
  stays gated by the E2E Content-Security-Policy test, which never screenshots.
- Pure helpers live in `tests/ui-review/reviewMath.ts` (`reviewMath.test.ts`);
  the in-page audit keeps its own copy (imports cannot cross `evaluate`).

## Fresh as well as prepared state

- Check from where a real owner starts (FRESH: no saved backend → send
  disabled with Settings → AI agent guidance — the lesson of the "cannot
  send" defect), not only prepared state. Section F covers no-backend;
  section D covers an empty conversation.

## What blocks merging, and what is advisory

- MUST fix: blocked primary action, page-level overflow, inoperable control,
  dialog without focus handling (focus in, Escape, return, backdrop).
- Advisory: contrast/target edge cases, clipped text, heading order, and
  "obscured" findings the screenshot shows are scrolled-out elements.

## Interactive exploration

- Playwright MCP sessions may explore, but the scripted review output plus
  screenshots is the cited evidence. `docs/UI_review.md` stays with the
  orchestrator — do not edit it for the review.
