# Pages

The SPA is split into four pages by user action (MECE): every action lives on
exactly one page, and every primary journey step has a page. A "conversation"
and a "workspace" are the same stored thing (one chat + one canvas); the UI
says "conversation" on the Chat page and in navigation between Chat and Canvas.

Routes: `#/chat` and `#/chat/<workspaceId>` (default), `#/canvas/<workspaceId>`,
`#/sources`, `#/settings`. The legacy `#/workspace/<id>` and `#/workspace`
hashes parse as the canvas view so old bookmarks keep working. `#/settings/agent`
scrolls the AI agent section into view and moves focus to its Default backend
select, so a notice in Chat can link straight to the control that fixes it.

Page layout (frame, panels, headings, shared parts) follows
[docs/DESIGN_GUIDELINE.md](DESIGN_GUIDELINE.md).

## Chat — `#/chat`

**Purpose**

Ask research questions and read the answers, with their sources and run progress.

**User actions**

- Start a new conversation.
- Open a past conversation from the history list.
- Load earlier messages.
- Write and submit a question (agent choices are not made here — they are chosen once in Settings → AI agent).
- Watch a run's progress.
- Cancel, retry or approve a run.
- Copy an answer.
- Open the evidence records of a run.
- Go to the canvas of this conversation.

**Shows**

- The conversation history (newest activity first): title, last-message preview
  (or "No messages yet"), last-activity time and message count; the open
  conversation is marked with `aria-current="page"`.
- The open conversation's title with an "Open canvas" link (`#/canvas/<id>`).
- The message thread with claim badges and source links, newest first paging
  through "Load earlier messages": owner messages as right-aligned bubbles,
  assistant answers as plain text with "Copy answer" and "Evidence" actions,
  each research run as an inline card directly after the owner message whose
  `runId` matches it (state, latest progress, working indicator, `Stop`,
  expandable "Run details" with attempt, limits, usage, cost, provenance,
  progress log, retry and approval form), and unmatched runs grouped under
  "Earlier runs".
- An empty conversation greets ("What would you like to research?") with starter
  suggestions that fill the question input without sending.
- The question form (question, horizon, markets and the one-time spend consent,
  with a read-only agent summary) and the evidence records drawer for one run,
  session notices and load errors.

**Not here**

- Arranging tables, charts or reports — see Canvas (`#/canvas/<id>`).
- Choosing news sources — see Sources (`#/sources`).
- Runner credentials, approved images or export — see Settings (`#/settings`).

## Canvas — `#/canvas`

**Purpose**

Inspect and arrange the tables, charts and reports that research produced.

**User actions**

- Choose which conversation's canvas to show.
- Focus a component.
- Select a component item (e.g. a table row).
- Reorder components (move up/down, one/two columns).
- Remove a component.
- Go back to the chat of this conversation.

**Shows**

- The conversation picker (label "Conversation") and a "Back to chat" link
  (`#/chat/<id>`).
- The stored components in `layout.order` through the registry, with workspace
  version, component count and per-component controls.
- Session notices and load errors for the canvas.

**Not here**

- Asking questions, reading answers, run progress or evidence records — see Chat
  (`#/chat/<id>`). No question form, no run controls and no message list live here.
- Choosing news sources — see Sources (`#/sources`).
- Runner, images or export — see Settings (`#/settings`).

## Sources — `#/sources`

**Purpose**

Choose which news sources research may read.

**User actions**

- Preview a feed or site URL (site and feed metadata, safety/licensing check).
- Subscribe to a previewed source with a license policy and trust classification.
- Pause, resume or remove a subscribed source.
- Browse the recommended catalog, preview an entry and subscribe to it.
- Queue a news refresh for the local runner.
- Browse recent articles.

**Shows**

- The source preview, subscribed sources, recommended sources and recent articles.

**Not here**

- Asking questions or watching runs — see Chat (`#/chat`).
- Inspecting produced tables and charts — see Canvas (`#/canvas/<id>`).
- Runner credentials or export — see Settings (`#/settings`).

## Settings — `#/settings`

**Purpose**

Configure how the workspace runs: the AI agent, the runner, approved images and data export.

**User actions**

- Choose the default AI backend, its model from a list, effort, per-question limits and web access.
- View the session (owner id, sign-in method).
- Issue a runner credential and copy the one-time token; revoke a credential.
- Approve an image (URL, alt text, permission basis) or remove it.
- Export a workspace as JSON or Markdown; import a workspace file and open it.

**Shows**

- The AI agent defaults, session, runner credentials (never tokens except once at issue), approved
  images, export/import.

**Not here**

- Asking questions or reading answers — see Chat (`#/chat`).
- Produced tables and charts — see Canvas (`#/canvas/<id>`).
- Subscribing to news — see Sources (`#/sources`).

## Journeys to pages

| Journey (ARCHITECTURE_AND_REQUIREMENTS.md section 2) | Page |
|---|---|
| 1. Configure sources | Sources |
| 2. Ask a research question | Chat |
| 3. Inspect evidence | Chat (evidence records drawer) |
| 4. Map suppliers | Chat (records) and Canvas (report/table components) |
| 5. Inspect positions and investors | Chat (records) and Canvas (financial components) |
| 6. Manipulate research UI | Canvas (arrange/remove); reopen via Chat or Canvas picker |
| 7. Continue without local compute | Chat (browse history, queue while offline); Canvas (browse findings) |

## How the split was checked

Each user action above appears under exactly one page (exclusive), and every
journey step maps to a page (exhaustive). Dialogs such as the records drawer
belong to the page that opens them (Chat). Web tests assert the exclusivity
(Chat has no canvas region; Canvas has no composer, message list or run
status), the legacy `#/workspace/<id>` URL opens the canvas, and
`tests/architecture/pagesDoc.test.ts` fails if this document drifts from
`apps/web/src/pages.ts` (titles, routes, purpose sentences).
