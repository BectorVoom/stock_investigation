# ADR-0020: Chat-first to Notebook-first workspace on the widget grid

**Status:** Accepted · **Date:** 2026-10-14

## Context

The owner asked for the Chat page to grow from a Chat-first interface into a
Notebook-first one: think through Chat, capture knowledge as widgets, and
organise it in a Notebook. Widgets must come from the existing
`@research/widget-grid` package (ADR-0019) — its grid, frame, sizes, drag
and drop and agent command layer — and the AI must create, read, edit, move,
resize, duplicate and (with confirmation) remove them through structured
operations, never through the DOM. Exactly two UI states exist.

Until now an open conversation showed three panels: Chats, Chat and a
Canvas of research components that only the research agent arranged
(owner decision of 2026-10-13). Research agents are text-in/text-out and
publish no model prose (ADR-0003 §6) because they read untrusted text.

## Decision

### The Notebook is a document of its own, one per conversation

`notebook` (contracts `notebook.ts`) is a versioned JSON document per
workspace: an ordered list of at most 200 widgets (raised from 40 on
2026-10-14) holding at most 850 KB of widget content. Each widget has the
package's four fields (`widgetId`, `type`, `title`, `size`), its content, and
server-stamped metadata (`createdAt`, `updatedAt`, `revision`, `origin`).
Types: `text` (editable text), `metric`, `chart` (line or bar, carrying its own
series), `table` (structured rows) and `research` (a canvas component of the
same conversation rendered through the registry, read-only content, badges
intact). There is no image type: the app stores no uploaded files and a URL
image would be a new fetch path (ADR-0005); recorded as a limitation.

It is stored apart from the canvas: canvas components are what research runs
produced (verified, agent-arranged, ADR-0003), notebook widgets are what the
owner chose to keep and develop. A widget saved from Chat is a copy of the
data with provenance (`origin.messageId` / `runId` / `componentId`), never a
screenshot and never a live link to a mutable record. Chat messages, widget
content, the layout (the widget order and sizes inside the notebook body) and
the assistant's operation history (`notebook_turns`) are separate records
joined by ids.

The byte cap exists because the per-widget caps alone allow far more than
one request may carry (`MAX_REQUEST_BODY_BYTES`, 1 MB): with metadata (under
500 bytes per widget) a notebook at the cap still fits one owner save, so a
notebook the assistant grew can always be saved again. One rule
(`notebookCapacityProblem` in contracts) decides it for the owner's saves,
the assistant's commands (runner and API) and the client, which refuses an
add past the cap at once with the reason. A notebook already over the byte
cap may shrink or be rearranged, never grow.

Persistence mirrors the Home dashboard (ADR-0017/0019): `GET`/`PUT
/workspaces/:id/notebook` with the version as compare-and-set revision, so a
stale tab or a concurrent assistant turn can never silently overwrite an
edit. The last 20 bodies are kept: `POST …/notebook/undo` restores the body
before the version on screen as a new version. Deleting a conversation
deletes its notebook.

### Two states, one session

An open conversation is in one of two states, `chat` (Chat-first: chat ≈ 75–80 %,
notebook ≈ 20–25 %) or `notebook` (Notebook-first: the reverse). The Chats
list becomes a collapsible rail. The state is remembered per conversation in
the browser (a convenience, like a collapsed panel); a conversation never
seen opens Chat-first. When the notebook holds three or more widgets while
Chat-first, a quiet inline suggestion offers the switch; it never switches by
itself. Switching changes only grid proportions: the workspace session, the
notebook session, the thread, the composer draft and the selection live
above the layout and are not re-created. Below `lg`, the two states keep their
meaning as a two-tab switcher whose default tab follows the state. The old
Canvas panel is gone: each research component is shown inside the thread,
under the answer of the run that produced it, with an "Add to Notebook"
action; components no visible run owns are listed after the thread.

### The widget grid package grows, stays generic

Additions to `@research/widget-grid` (no app knowledge): container-sized
columns (`columnsFrom="container"`), a quiet variant whose frame boundary
appears only on hover, focus and selection, frame selection (header click
selects, Shift/Ctrl/Meta toggles, plus a keyboard-reachable select toggle),
the standard `WidgetSizePicker` (S/M/L for every type), and a `duplicate`
agent command (`add` of a copy at the next position, so the Lean dashboard
model still covers it). Home keeps its defaults and looks as before.

### The notebook assistant: a new job kind with write access to one notebook

An instruction typed while widgets are selected, or in Notebook-first, goes
to the notebook assistant (`POST …/notebook/assist`), stored as the owner's
chat message and queued as a `notebook-assist` job carrying the instruction,
the explicit selection, the notebook at the version the owner saw, and the
saved agent choices. The runner asks the model once (one repair attempt)
for `{ reply, commands }`, where commands are widget-grid agent commands.
The prompt narrows context: selected widgets in full, the others by id,
type, title, size and position only; with nothing selected every widget
with its bodies cut (text to 500 characters, tables to 8 rows, chart series
to 24 points), as many as fit an 80 KB widget block in notebook order, the
rest as summary lines, so a full notebook degrades to an index instead of
failing the turn (the prompt ceiling is 120 KB). No tools, no network, no
evidence.

Every command is validated twice by the same code
(`application/notebook/notebookAgent.ts` over `createWidgetAgentHost`):
by the runner against its copy and by the API against the stored notebook,
all or nothing. The API refuses the whole turn (`NOTEBOOK_CHANGED`) when the
notebook moved past the base version while the model worked, rather than
merge. `remove` is never applied by the assistant: removals are returned as
`proposedRemovals` and the owner confirms them. Every applied turn is one
version, undoable, and its chat card lists each change with a before/after
preview.

**This amends ADR-0003 §6 and ADR-0019 ("research agents do not get these
tools") for this job kind only.** The notebook assistant may write prose
(its reply, `text` widgets) and edit widget content. Mitigations: it reads
no fetched text, only the owner's own notebook and instruction; it can write
only the one notebook named by the job; it cannot delete; every change is a
reviewable, undoable version; its reply and the widgets it writes are marked
as assistant-written and never carry verification badges (a `research`
widget only renders a stored component, whose badges the Worker checked).
Research runs are unchanged.

## Consequences

- New migration (`workspace_notebooks`, `workspace_notebook_revisions`,
  `notebook_turns`), new routes, a new job kind and completion outcome.
- The research canvas is no longer a separate panel; `PAGES.md` and the
  design guideline describe the two states.
- Export/import does not yet carry the notebook (limitation, recorded in
  `REQUIREMENTS_STATUS.md`).

## Alternatives considered

- **Make the canvas the notebook** (add size and title to workspace
  components). Rejected: the canvas reducer is proved in Lean and guards
  verification badges; owner edits and assistant prose would weaken exactly
  the guarantees ADR-0003 builds on.
- **Give the research pipeline notebook tools.** Rejected: it reads
  untrusted text; the notebook assistant is separated so that what can write
  never reads the web.
- **An intermediate "hybrid" layout.** Rejected by the owner: two states only.
