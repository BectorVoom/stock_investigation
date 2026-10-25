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

## 2026-10-14 — Home widgets after the Apple HIG rework (ADR-0017)

Reviewed on the merged tree with `bun run review:ui` on Chrome (Home states: populated,
add dialog, widget menu, unavailable, stale, loading, tablet, phone, and a mid-drag shot)
and with the real-data screenshots of `tests/real/homeReal.spec.ts`.

| What was looked at | Result |
|---|---|
| Three sizes | Small 1 × 1 (272 px tall), Medium 2 × 2 and Large full width × 2 (560 px tall); every widget of a size measures the same (asserted in `tests/e2e/home.spec.ts` at 1440 × 900 and 390 × 844) |
| Borders | White frames with a `slate-200` hairline, no shadow, no header rule; table rules and the provenance divider are the same hairline |
| Buttons | Every Home button is icon-only with its former text as accessible name and tooltip; the app header keeps its text navigation |
| Drag | The lifted widget follows the pointer with the blue ring at 90 % opacity, a dashed placeholder marks the drop slot, the others reflow; no snap-back between drop and save (sampled per frame) |

Findings that remain, all advisory:

- Inline provenance links are 16 px tall (links in running text are exempt, section 9).
- At 390 px a Small widget is about 163 px wide, so long titles are truncated with an
  ellipsis ("US 10-ye…") and metric text wraps; the full title is the frame's accessible
  name. Content taller than the frame scrolls inside it.
- A Medium widget with little content (a three-row watchlist) leaves empty space below it:
  the height is fixed per size by design.

| Engine | Result |
|---|---|
| Chrome (Chrome channel) | Reviewed; browser suite 53 passed, 1 skipped |
| Safari engine (Playwright WebKit) | Browser suite 35 passed, 1 skipped; `review:ui` not run on WebKit |
| Firefox | **Not run** — it cannot be launched from the agent shell on this machine; the owner runs `bun run test:e2e:firefox` and `REVIEW_BROWSER=firefox bun run review:ui` |

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

# UI review — Earnings month calendar and the Google Calendar card (FR-019)

**Date:** 2026-10-14 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Widget guideline:** Apple Human Interface Guidelines for widgets (owner's standing instruction; [DESIGN_GUIDELINE.md](DESIGN_GUIDELINE.md) section 14) · **Tool:** `REVIEW_BROWSER=firefox bun run review:ui` (`tests/ui-review/watchlistReview.spec.ts`)

## How it was reviewed

The Home "Earnings calendar" widget and the Watchlist page's Calendar section were driven in Firefox against the E2E server and runner with fixture earnings sources and a scripted Google step (no browser consent, no Google), and every screenshot below was read: `W7-home-widget-desktop`, `W7-home-widget-phone`, `W8-google-disconnected`, `W8-google-connecting`, `W8-google-connected`. They were also looked at with real data: the real-environment runs save Home and the Watchlist page at 1440×900 and 390×844 after the real runner fetched JPX and Finnhub (`test-results-real/watchlist-real-*.png`, `watchlist-upgrade-home-1440x900.png`), and those were read too.

**States:** widget month grid with an announcement day (desktop, phone) · Watchlist calendar with a day's announcements · Google card disconnected · connecting with the sign-in link and Cancel · connected while syncing.

## How the widget follows the widget guideline

| Guideline point | What the widget does |
|---|---|
| Glanceable, uncluttered | One compact month grid with a dot on announcement days, at most three "Next" announcements, one status line. The per-row calendar links, the `.ics` download, the five-column table and the per-stock reasons moved to the Watchlist page |
| Simple functions; depth belongs to the app | Two actions only ("Refresh earnings dates", "Open calendar") beside month navigation. Day details, calendar links and the Google card are on the Watchlist page |
| A tap opens the right place | An announcement day links to `#/watchlist/calendar/YYYY-MM-DD`, which opens the calendar on that month with the day selected |
| Confident targets | Day links, month buttons and the actions are at least 44×44 px under a coarse pointer, at least 24 px otherwise |

The widget sits in the fixed-size frame of the Home rework (ADR-0017): its buttons are the shared icon-only button, and a body taller than the frame scrolls inside it. The other Home widgets were reworked against the same guideline there (see "Home widgets after the Apple HIG rework").

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Automated | No finding on the Watchlist states, the widget states or the Google card states | — |
| Screenshots | Today was not marked on the month grid (only `aria-current`, nothing for the eye), although the design guideline says "today emphasised" | Fixed: today's number is an outlined, bold pill; re-reviewed in both variants |
| Real-environment run (upgraded state) | When the dates arrived after the widget was already on screen, the grid stayed on the current month while "Next" listed a date in the following month; a reload showed the other month | Fixed: until the owner navigates, the grid follows the first upcoming announcement |
| Code review | The widget's Google line showed the sync time as a raw ISO stamp | Fixed: formatted like every other time |
| Code review | The card offered no Cancel while the sign-in was still being prepared (runner offline), and Disconnect stayed enabled while another Google step ran | Fixed: Cancel in both sub-states; one step at a time |
| Code review | After a failed sync the card did not say the calendar was behind, nor that automatic syncing had stopped | Fixed: both are stated, with "Sync now" as the way forward |
| Code review | "Reconnect needed" stated its reason twice (sentence and error notice) | Fixed: once |
| Screenshots | The month name appears twice (the heading beside the buttons and the table caption) | Kept: the caption is the table's accessible name and the guideline asks for a visible caption |

## Status by browser

| Engine | Result |
|---|---|
| Firefox | Reviewed (scripted review and real-data screenshots) |
| Chromium (Playwright's bundled build) | **Not run** for this change |
| Chrome (Chrome channel) | **Not run.** Google Chrome is not installed on the development machine |
| Safari engine (Playwright WebKit) | **Not run.** WebKit cannot start on the development machine |

## Known limits

- The 44 px targets apply under a coarse pointer; the review ran with a mouse pointer, so they are covered by class assertions in the component tests, not by a touch-device screenshot.
- The Google card was reviewed with a scripted Google step. The real sign-in page, the "connected" page the runner serves after sign-in, and the calendar as it appears in Google Calendar have not been seen: they need the owner's OAuth client and an interactive sign-in.
- Home's default stock table is still titled "Watchlist" although it is unrelated to the stocks registered on the Watchlist page (open naming question from the FR-018 review).

# UI review — Chat-first to Notebook-first workspace (FR-020, ADR-0020)

**Date:** 2026-10-14

## How it was reviewed

The scripted Chat review (`REVIEW_BROWSER=chrome bun run review:ui`) on the
new two-state page, compared with the same review run on the commit before
the change (`b6e43f0`); screenshots of both states from the notebook E2E spec
and from the real-environment run (`tests/real/notebook.live.spec.ts`, real
OpenCode backend); and a read-only look at the owner's running `bun run dev`
(port 3000) in both states.

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Real-environment screenshots | The Notebook and the thread previews were unstyled markup: only the lazy Home chunk loaded the widget-grid stylesheet, and DOM tests do not evaluate CSS | Fixed: the Chat page imports it; the notebook E2E spec asserts the computed grid and frame layout |
| Screenshots | In Notebook-first the narrow chat squeezed preview tables to one letter per line | Fixed: tables in frames keep a readable 32rem minimum and scroll sideways in a narrow panel |
| Automated (35 beyond-right-edge) | Natural-width tables overran the preview frame | Fixed by the 32rem minimum (wrap when there is room) |
| Screenshots | Fixed-height previews cut charts and left blank space under short components | Fixed: previews take their natural height up to the body of a Large widget |
| Screenshots / automated | A long y-axis title ran past the plot and was cut | Fixed: `fitAxisTitle` sets smaller type, then shortens with the full title as a tooltip |
| Automated (small-target) | The chart's "Data table" disclosure was 16 px tall | Fixed: 24 px |
| Automated (new-answer-not-in-view) | Result previews settle their height after the answer, and a question sent while reading further up did not bring the thread down | Fixed: the thread stays pinned while its items grow, and the owner's own new message re-pins it |
| Screenshots | With the composer on Notebook, the empty chat still offered research starter questions | Fixed: hidden for the Notebook target |
| Review tooling | The Chat review measured rotated SVG chart titles as CSS boxes (false "content-wider-than-box") | The rule now checks HTML boxes only, as the Home review already did |

Result: 23 findings, all of kinds present before the change
(`covered-by-pinned-area`, `obscured`: content behind the pinned input or a
drawer backdrop; `heading-skip` in the records drawer and
`input-not-at-bottom` for the centred empty state, both also in the
baseline), against 103 on the baseline commit.

## Status by browser

| Engine | Result |
|---|---|
| Chrome (Chrome channel) | Reviewed (scripted review, E2E incl. `notebook.spec.ts`, real-environment run) |
| Safari engine (Playwright WebKit) | E2E passed (58); the scripted review was not run |
| Firefox | **Not run**: Firefox cannot be launched from the agent's shell on this machine; the owner runs `bun run test:e2e:firefox` |

## Known limits

- The Chats panel stays open in Notebook-first unless collapsed, so the
  Notebook takes three quarters of the space beside it, not of the window.
- The chosen state is remembered per browser (local storage), not per account.

# UI review — Scheduled tasks (ADR-0033)

**Date:** 2026-10-24 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Widget guideline:** Apple Human Interface Guidelines for widgets ([ADR-0017](adr/0017-home-widgets-follow-apple-hig.md)) · **Tool:** `tests/ui-review/tasksReview.spec.ts` (part of `bun run review:ui`; run alone with `REVIEW_BROWSER=<engine> node_modules/.bin/playwright test --config tests/ui-review/playwright.config.ts tasksReview.spec.ts`)

## How it was reviewed

The review runs as its own owner (`X-E2E-Owner`) with its own runner harness against the built SPA, and creates every state through the API and the runner — nothing is written into the database file. The skip is real: a daily task due a minute after creation while no backend is saved, which the runner's next claim records as `AGENT_NOT_CONFIGURED`. The completed one-off task really fired, and "Run now" really ran through the scripted agent. Every screenshot (64 per engine, `test-results/ui-review/<engine>/tasks-*.png`) was read, with `findings.json`.

**States** at 1440×900, 820×1180 and 390×844: the Tasks page empty (fresh owner) and with nine tasks of every kind and status (daily, weekdays, weekly, monthly on day 31 and 15, once and completed, two paused, one skipped, one run now, a 95-character title with a long question), top and bottom; the editor dialog for a new task with the once, weekly and monthly field sets, the problems list, and editing a task of each set; the delete confirmation; Home with the `scheduled-tasks` widget at Small, Medium and Large, empty and populated, with a crop of each widget; the widget's own New task dialog; the widget in a chat's Notebook (Notebook-first). Japanese (`ja-JP`) at 1440 and 390: the Tasks page, the weekly editor, Home and each widget size. The dialogs are checked for focus moving in, Escape closing them and focus returning to the opener.

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Screenshots | The widget showed only "6 active of 9" at its top: frames show no title (ADR-0024), so nothing said what the widget was | Fixed: the body names itself ("Scheduled tasks · 6 active of 9"), as the market widgets name their series |
| Screenshots | Medium and Large widgets read as one block of text: four lines per task with no separation | Fixed: hairline dividers between tasks, as on the Tasks page |
| Automated (clipped-text) / screenshots | A Small widget on a phone (~170 px) cut the title to "Morning…" beside the two icon buttons; long titles were cut without a way to read them | Fixed: titles wrap to two lines with the full title as a tooltip; when the row has less than 12rem for the text the two buttons wrap under it |
| Screenshots | The empty widget offered only a 24 px "+" in its corner | Fixed: the empty state has a labelled "New task" button (the corner "+" appears once there are tasks) |
| Screenshots (Japanese) | "チャットを開く" broke across two lines in a Small widget | Fixed: the link does not wrap |
| Screenshots | On a phone the Tasks page put Edit / Pause / Run now / Delete between the schedule and the question it belongs to | Fixed: on a phone the actions follow the task's text; from 640 px they sit on the right |
| Screenshots | The editor dialog opened in the top-left corner of a desktop window | Fixed: it is centred (`m-auto`), 36rem wide so the monthly set (Repeat, Day of month, Time) fits on one line |
| Screenshots | On a phone the weekly editor wrapped "Sat" onto a line of its own | Fixed: below 640 px the seven days are seven columns (box above the day) |
| Screenshots | The problems list ("Enter a title.") had no visible lead-in, unlike Home's "To add this widget:" | Fixed: "Before you can save this task" heads the list and names it |
| WebKit review (content-wider-than-box ×9) | A first fix used a CSS container query; inside a Notebook column WebKit squeezed the two buttons and hid Run now | Replaced by wrapping (no container query); WebKit and Chrome now lay the widget out the same |
| Real-environment run (coordinator) | A one-off task whose only occurrence was skipped said "Completed: this one-time task has run." beside "Not run yet" and the skip line | Fixed: "Completed: its one time was skipped, so it did not run." (EN/JA) when the skip is newer than the last run; unit-tested |
| Real-environment run (coordinator) | "Created …" (and the other success notices) stayed after the task had fired or been skipped | Fixed: a success notice shows only while the list still holds that task as the action left it (version, status, last run, last skip); failures stay until the next action; unit-tested on the model and on the widget |
| Automated (obscured, small-target) | The widget frame's selection control (`Select "Scheduled tasks"`, 2×2 px) on every widget | Not this feature: the shared `@research/widget-grid` frame, same on every widget type |
| Automated (obscured) | Notebook-first desktop: a source button of the narrow chat panel's table lies under the Notebook | Not this feature: the chat thread's preview table in Notebook-first |
| Review tooling | Items of the phone's closed "Chats" list were reported as obscured | The audit now skips content of a closed `<details>`, as the Chat review does |

Findings per engine (rule → count):

| Engine | Before | After |
|---|---|---|
| Chrome (Chrome channel) | obscured 79, small-target 37, clipped-text 10 — 126 | obscured 38, small-target 37 — 75; all but one are the shared frame's selection control (above), the last is the chat-table item |
| Safari engine (Playwright WebKit) | First run after the Chrome fixes: obscured 39, small-target 39, content-wider-than-box 9 — 87 | obscured 39, small-target 39 — 78; the frame's selection control, the chat-table item and the chat preview table's 20×96 px "Select" button (Notebook-first) |

The dialog checks (focus in, Escape, focus back on the opener) found nothing in either engine.

## Status by browser

| Engine | Result |
|---|---|
| Chrome (Chrome channel) | Reviewed (scripted review, screenshots read) |
| Safari engine (Playwright WebKit) | Reviewed (scripted review, screenshots read) |
| Firefox | **Not run**: Firefox cannot be launched from the agent's shell on this machine; the owner runs `REVIEW_BROWSER=firefox bun run review:ui` |

## Known limits

- The delete confirmation is the shared `ConfirmDialog` and still opens in the top-left corner, as everywhere in the app; only the task editor was centred. A global `dialog:modal { margin: auto }` would centre them all.
- Touch was not emulated: the 44 px coarse-pointer sizes (icon buttons and links) were not measured; the Tasks page's text buttons are the app's 24 px `BUTTON`, as on the Watchlist page.
- A skipped one-off task, a spend-consent checkbox (metered backend) and a failed run were not in the screenshots: the first two need a skipped once slot or a Claude API key, the third a failing agent; their wording is covered by unit tests.
- The Notebook-first chat panel beside the Notebook is narrow at 1440 px and squeezes its result tables; that is the chat's layout, not this feature's.

# UI review — Watchlist lists and the Watchlist prices widget (ADR-0040)

**Date:** 2026-10-25 · **Rule:** [rule/UI_review_rule.md](rule/UI_review_rule.md) · **Widget guideline:** Apple Human Interface Guidelines for widgets ([ADR-0017](adr/0017-home-widgets-follow-apple-hig.md)) · **Tool:** `tests/ui-review/watchlistListsReview.spec.ts` (part of `bun run review:ui`; run alone with `REVIEW_BROWSER=<engine> node_modules/.bin/playwright test --config tests/ui-review/playwright.config.ts watchlistListsReview.spec.ts`)

## How it was reviewed

The review runs as its own owner with its own runner harness against the built SPA; every state is made through the API and the runner. A six-stock list (AAPL and MSFT, which the E2E Twelve Data fixtures serve, beside TM, 7203, 6758 and 7205, which they do not), a one-stock list with a long title and an empty list; Home holds the list at Small, Medium and Large plus an empty list at Small, and Home's automatic refresh fetches the prices through the runner. Every screenshot (`test-results/ui-review/<engine>/watchlist-lists/*.png`, 18 per engine) was read, with `findings.json` (a document wider than the viewport).

**States** at 1440×900 and 390×844: the Lists section empty and populated, the New list dialog, the Add stock dialog (checkboxes and search), and Home with the widget at each size, with a crop of each widget.

## Findings and what was done

| Found by | Finding | Outcome |
|---|---|---|
| Screenshots | The source line read "Sources: Twelve Data," — a series with no observations added an empty publisher | Fixed: the line names the sources of the numbers shown (series with observations on the page) |
| Screenshots | A stock without data printed the whole provider sentence ("unavailable (The provider has no data … HTTP 404.)"): four lines a row at Small, two to four at Medium on a phone, pushing the session note out of a Small frame | Fixed: in the widget the reason is clamped to one line at Small and two at Medium and Large; the whole reason stays in the text (screen readers) and the tooltip. The Stock table is unchanged |
| Screenshots | The first clamp did not apply: `block` beside `line-clamp-*` overrode the `-webkit-box` display | Fixed: the clamp class alone |
| Automated (overflow) | — | No page wider than its viewport in either engine at 390 px: the widget hides the As of column below a 28rem container and the Source column below 42rem instead of scrolling sideways |

## Status by browser

| Engine | Result |
|---|---|
| Chrome (Chrome channel) | Reviewed (scripted review, screenshots read; E2E `watchlistLists.spec.ts`) |
| Safari engine (Playwright WebKit) | Reviewed (scripted review, screenshots read; E2E `watchlistLists.spec.ts`) |
| Firefox | **Not run**: Firefox cannot be launched from the agent's shell on this machine; the owner runs `REVIEW_BROWSER=firefox bun run review:ui` |

## Known limits

- Japanese stocks show "unavailable" on Twelve Data's free plan (ADR-0040 §3), so most rows of a Japanese list are reasons, not prices.
- A stock added through the API before the stock lists were downloaded has no company name; the page says "unavailable (not retrieved yet)". The widget first showed the series title in its place ("MSFT (NASDAQ)", or a placeholder such as "TM"); after the independent review it shows the symbol alone, once.
- The review audits overflow only; it does not repeat the Tasks review's obscured / small-target audit. The list card's buttons are the app's 24 px `BUTTON`, as elsewhere on the Watchlist page.
