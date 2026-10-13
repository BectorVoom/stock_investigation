# UI review — Chat page

**Date:** 2026-10-12 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Tool:** `bun run review:ui`

Owner's note for this file: *playwright mcp*.

## How it was reviewed

The page was driven in a real browser with Playwright, against the real application stack (the E2E server and runner), and the screenshots were read one by one — the automated findings are leads, not verdicts.

- **Playwright MCP was not used.** No Playwright MCP server was configured in the session that did this review (not in Claude Code, OpenCode or Codex), and one added mid-session would not have loaded. The same browser engine was driven through the Playwright library instead. To have the MCP tools available in a later session: `claude mcp add playwright -- npx @playwright/mcp@latest`.
- The script that did the review is now part of the repository (`tests/ui-review/`, `bun run review:ui`), so the review is repeatable; `REVIEW_BROWSER=chrome|firefox|webkit` selects the engine.

**Viewports:** 1440×900, 1280×720, 820×1180, 390×844.

**States:** thread with a completed run · run details open · composer disclosures open · evidence drawer open · a 14-line draft · a 260-character unbroken word sent with Enter · a failed run · 16 conversations with long titles · an empty conversation · no backend chosen.

**Checks run inside the page:** horizontal overflow · content wider than its box · controls covered by something else · targets under 24 px · missing accessible names · text contrast (WCAG AA, colours resolved through a canvas because Tailwind 4 emits `oklch()`) · heading order · clipped text without a title · focus visibility on every tab stop · drawer focus, Escape and outside-click · input growth · Enter / Shift+Enter · newest message in view · console and page errors.

## Round 1 — findings

152 automated findings, reduced by reading the screenshots to eight real defects.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | The evidence drawer was not a dialog: no role, focus stayed behind it, Escape and outside-click did nothing, and the page behind stayed usable (a question was sent underneath it during the review) | high | Fixed — `role="dialog"`, focus moves in and returns, Escape and backdrop close it, the page behind is inert |
| 2 | A long unbroken word or URL ran out of the message bubble, the run card and the history preview | high | Fixed — text wraps anywhere; a browser test checks real geometry |
| 3 | Long conversation titles wrapped to three lines; only six conversations fitted on a 900 px screen | medium | Fixed — one line with the full title on hover |
| 4 | On a tall narrow screen the input floated in the middle of the page | medium | Fixed — it rests at the bottom of the viewport |
| 5 | With no backend chosen the only hint was a small unlinked bullet under the input | medium | Fixed — a warning above the input with a link to Settings → AI agent |
| 6 | A validation message appeared right after a successful send | medium | Fixed |
| 7 | 86 controls were under the 24 px minimum target height | low | Fixed |
| 8 | One action had two names ("Evidence" / "Evidence & records") | low | Fixed |

Found before round 1, from five screenshots after the redesign: at phone width the pinned input sat on top of the thread and its caption overlapped the content behind it (no opaque background). Fixed, with a geometry test at 420 px.

## Round 2 — after the fixes

15 automated findings, all of kinds that are expected behaviour: thread content scrolled behind the pinned input, and controls behind the open drawer's backdrop.

Reading the round 2 screenshots found one **regression caused by the round 1 fix**: making every `<summary>` 24 px tall with a flex display removed the browser's disclosure triangle, so "Run details", "Progress log", "Limits and cost", "Options" and "Conversations" looked like plain text. Fixed with an explicit chevron in one shared part.

## What scripted review could not find

Three defects reached the owner although every automated test and this review had passed. They are recorded here because they changed how review is done ([rule/test_guideline.md](rule/test_guideline.md)).

| Defect | Why review missed it |
|---|---|
| The send button was disabled on the owner's real installation: no backend was saved in Settings | Every test and the review started from a prepared state with a backend already saved. The review did visit the "no backend" state — it is finding 5 — and rated it "medium: barely told" instead of recognising that it blocked first use |
| Agent settings could not be saved: OpenCode required a model id typed from memory | The review used the scripted test backend, which needs no model |
| Every question failed in `bun run dev` with `NO_EVIDENCE_COLLECTED` | Nothing sent a question through the development runner; the real-environment check that had been done used `bun run prod` only |

Since then the review starts from a fresh installation as well as a prepared one, and a UI change is exercised in `bun run dev` with the real runner and the real network before it is called done.

Two smaller things were seen only in real-environment screenshots and fixed afterwards: "Question queued. It starts when a runner claims it." stayed on screen after the answer had arrived, and the model selector stayed empty until the page was reloaded if Settings was opened before the runner's first report.

## Independent review of the same code

The frontend was also reviewed by Codex (read-only). It found eleven more defects that a browser pass does not show — state races and rule gaps rather than layout: spend consent surviving a failed submission, edits lost while a save is in flight, run cards recreated on every poll, an answered retry losing its status card, a late list response overwriting a newer one, an unreachable gap in paged history, hidden fetch failures, a late "created" response overriding navigation, run progress not announced to screen readers, and two ways the conformance tests could be fooled. All are fixed; the record is in [CODEX_REVIEW.md](CODEX_REVIEW.md).

## Status by browser

| Engine | Result |
|---|---|
| Chrome (Playwright, Chrome channel) | Reviewed; browser suite passes |
| Safari engine (Playwright WebKit) | Reviewed; browser suite passes. This is Safari's engine, not Safari.app itself |
| Firefox | **Not reviewed.** Firefox could not be started from the automated environment on the development machine (headless and headed both fail before any test runs). Run `REVIEW_BROWSER=firefox bun run review:ui` and `bun run test:e2e:firefox` from an ordinary terminal |

## 2026-10-12 — Chat and Canvas merged into one page

Chat and Canvas are one NotebookLM-style page: Chats / Chat / Canvas panels
side by side at `lg` (collapsible side rails), a `Chats` disclosure plus
Chat/Canvas tabs below it; one shared workspace session; "New chat" button
(no title field); per-chat Rename/Delete (menu + native dialog). Reviewed
with `E2E_PORT=9310 REVIEW_BROWSER=chrome bun run review:ui` after updating
`tests/ui-review/chatReview.spec.ts` (New-chat creation, `Chats` nav names);
screenshots read in `test-results/ui-review/chrome/`.

- 1440/1280/820/390 px: three panels, long titles truncate with full-text
  tooltips, the 260-char unbroken word stays inside the thread column, the
  pinned composer rests at the viewport bottom, empty chat shows suggestions
  and the Canvas panel shows its "(0 components)" empty state. No horizontal
  overflow or overlap in any shot; at 1024 px the columns bottom out at
  224 + 1fr + 288 px plus gaps inside the 992 px content width, so nothing
  overflows (reasoned, not screenshotted).
- The scripted review's real defect this round: the row "More actions" kebab
  measured 23 px wide, under the 24 px target floor — fixed with `min-w-6`
  on the shared `ActionMenu` button; re-review shows zero `small-target`
  findings (17 findings remain, all expected kinds: content behind the pinned
  composer, drawer-backdrop occlusion, the known drawer-heading advisory, one
  newest-answer timing lead).
- Rename/delete were exercised in DOM tests, not in this review (the server
  PATCH/DELETE routes arrive from another agent).

## Checked and found clean

Text contrast on every state · focus visibility on every tab stop · heading order (one advisory: the drawer's first heading) · accessible names · horizontal overflow at all four sizes · input growth and its cap · Enter sends, Shift+Enter does not · newest message stays in view · model and page text is rendered as inert text (the hostile test string shows as characters).

## Known limits of the tool

- An element scrolled out of a scroll container can be reported as "obscured"; content behind the pinned input is reported as "covered-by-pinned-area". Both are expected.
- Geometry and contrast are checked; whether a screen makes sense to a first-time owner is not. That is why the screenshots are read, and why the review also starts from a fresh installation.

# UI review — Home page

**Date:** 2026-10-13 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Tool:** `REVIEW_BROWSER=firefox bun run review:ui` (`tests/ui-review/homeReview.spec.ts`)

## How it was reviewed

The Home page (FR-017) was driven in Firefox with the Playwright library against the E2E server and runner with fixture market data, and every Home screenshot was read. It was also looked at with real data: the real-environment runs (`tests/real/homeReal.spec.ts`, `tests/real/homeUpgrade.spec.ts`) save full-page screenshots at 1440×900 and 390×844 after a real FRED and Twelve Data refresh, and those were read too. Playwright MCP was not used, for the reason given in the Chat section.

**States:** loading · populated desktop · Add-widget dialog · widget Actions menu · a series the provider cannot serve ("unavailable (reason)") · stale data · tablet and phone, top and bottom.

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Screenshots (real data) | Change digits followed the size of the change instead of the value ("▲ +4.2525" beside 4,173.67) | Fixed: a change shows the same fraction digits as the value it belongs to |
| Screenshots (real data) | Whole-number series showed changes with two decimals (159,044 with "+29.00") | Fixed the same way ("+29") |
| Screenshots (real data) | Indicator "As of" cells repeated "as of", "Previous" cells repeated the unit beside the Unit column | Fixed |
| Screenshots | Shoelace's own icons did not render: it loads them as `data:` URIs, which the page's `connect-src 'self'` policy blocks | Fixed without touching the policy: the 18 icons ship as files from the same origin; an E2E test fails if any `sl-icon` has no SVG |
| Screenshots | Shoelace's default density and colours did not match the rest of the application | Fixed by mapping Shoelace's tokens to the application's in `apps/web/src/styles.css` |
| Screenshots | The Add-widget dialog opened with red errors on an untouched form | Fixed: a neutral "To add this widget:" list until a field is changed, red "Fix before saving:" afterwards |
| Screenshots (after the merge with upstream) | Home's Shoelace buttons kept a border while the application's buttons had become borderless grey | Fixed in the token mapping (`apps/web/src/styles.css`) |
| Automated (14, all `small-target`) | Source links in provenance lines are under 24 px tall | Kept: links in running text are exempt (guideline section 9) |

## What scripted review could not find

The most serious Home defect was not visible in any screenshot and passed every scripted check: **choosing an option in any dropdown inside the widget dialog closed the dialog.** Shoelace's events bubble, so the dropdown's own "closed" event reached the dialog's handler. The scripted review and the first E2E tests set values without clicking through a real dropdown. It was found by an independent code review, fixed (handlers act only on their own element's events) and is now covered by E2E tests that select with a real mouse and with the keyboard, and that press Escape with a list open.

The same independent review found twenty-one further defects in page state, display and server code, most of a kind a browser pass does not show (a poller that stopped after one failed request, no error state when the stored arrangement cannot be read, a refresh that could be queued twice, data not reloaded after a save, a previous value of 0 shown as missing). All are fixed with tests.

Two E2E tests passed on Firefox and timed out on Chromium after that fix: they clicked a button behind the still-open dialog. The tests were wrong, not the page; they now close the dialog first.

## Status by browser

| Engine | Result |
|---|---|
| Firefox | Reviewed (scripted review and real-data screenshots); browser suite passes (22 passed, 1 skipped, after the merge with upstream `06c00d6`) |
| Chromium (Playwright's bundled build, not the Chrome channel) | Browser suite passes (22 passed, 1 skipped). **Not reviewed** with `review:ui` |
| Chrome (Chrome channel) | **Not run.** Google Chrome is not installed on the development machine; the launcher specs that run only under Chrome were not run either |
| Safari engine (Playwright WebKit) | **Not run.** WebKit cannot start on the development machine (missing system libraries). Home on Safari is unverified |

## Known limits

- On a phone-width screen the two tables are wider than the card and scroll sideways inside it; the first columns (name, latest value) are visible without scrolling.
- The review data is a small fixture (five observations per series); dense charts were only seen in the real-data screenshots.

# UI review — Watchlist page and the Home earnings-calendar widget

**Date:** 2026-10-13 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Tool:** `REVIEW_BROWSER=firefox bun run review:ui` (`tests/ui-review/watchlistReview.spec.ts`)

## How it was reviewed

The Watchlist page and the Home "Earnings calendar" widget (FR-018) were driven in Firefox against the E2E server and runner with fixture earnings sources, and the Watchlist screenshots were read. They were also looked at with real data: the real-environment runs (`tests/real/watchlistReal.spec.ts`, `tests/real/watchlistUpgrade.spec.ts`) save full-page screenshots of the Watchlist page and of Home at 1440×900 and 390×844 after a real JPX refresh, and those were read too.

**States:** loading · populated desktop · add-stock problems list · remove confirmation · subscription link just issued · a stock whose source is not configured ("unavailable (reason)") · tablet and phone, top and bottom.

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Automated | No finding on the Watchlist states (overflow, covered controls, target size, names, contrast, heading order, focus) | — |
| Code review (before the browser pass) | "Next announcement" could show a date already in the past when the stored dates were stale | Fixed: the first date on or after today is shown; when every stored date has passed the cell says so and offers no calendar link |
| Code review | A failed first load started the refresh poller as if a run were active | Fixed: polling starts only when the watchlist is loaded and a run is active |
| Code review | A calendar entry could state the day the stock was added as its "retrieved" date | Fixed: without a retrieved time there is no calendar link |
| Browser suite | "a chat can be renamed and deleted" failed intermittently in the full Firefox suite: a 100 ms fallback that focuses the chat composer could take focus from the rename input, which saves on blur and closes | Fixed in application code (`apps/web/src/chat/composerFocus.ts`); the defect predates this feature |
| Screenshots (real data) | After a refresh completes, the notice "Earnings-date refresh queued for the local runner." stays on the page beside the new "Last successful refresh" line | Fixed: the queued notice is cleared when the run ends |
| Owner report (2026-10-13) | The Home calendar widget showed no dates: adding a stock fetched nothing until "Refresh earnings dates" was found and clicked, Home had no such control, and the widget said "No announcement in the next 90 days." for stocks never looked up | Fixed: an add, opening the Watchlist page, and opening Home with a calendar widget each queue the fetch when dates are missing or over a day old; the widget has its own "Refresh earnings dates" button and a fetching status, and says "Earnings dates have not been fetched yet." until every stock was looked up |
| Automated (Home widget states added to the review, desktop and phone) | "Manage watchlist" link in the widget was 99×16 px | Fixed: 24 px minimum height. The two remaining findings are the small source links of other Home widgets, already recorded in the Home section |
| Screenshots (real data) | Home's default stock table is titled "Watchlist" (Twelve Data prices) and is unrelated to the stocks registered on the Watchlist page | Open: a naming question for the owner |

## Status by browser

| Engine | Result |
|---|---|
| Firefox | Reviewed (scripted review and real-data screenshots); browser suite passes (29 passed, 1 skipped) |
| Chromium (Playwright's bundled build) | **Not run** for this change |
| Chrome (Chrome channel) | **Not run.** Google Chrome is not installed on the development machine |
| Safari engine (Playwright WebKit) | **Not run.** WebKit cannot start on the development machine. Watchlist on Safari is unverified |

## Known limits

- On a phone-width screen the registered-stocks table is wider than its panel and scrolls sideways inside it; symbol, market and the next announcement are visible without scrolling.
- The confirmation dialogs are the shared `ConfirmDialog` and open where it opens everywhere (top left).
- No calendar application was used: the `.ics` content and the subscription feed were checked by tests, not by importing them into Google Calendar, Apple Calendar or Outlook.
