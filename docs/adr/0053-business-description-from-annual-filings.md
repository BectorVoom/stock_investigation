# ADR-0053: The Company tab shows the business description from annual filings

Status: accepted, 2026-11-01. Amends ADR-0049 §6 (the Company tab gains a
Business group) and extends ADR-0048 §6 (the `financial-sync` job also
reads the business section of the newest annual report).

**Amended 2026-11-02** by [ADR-0058 §5](0058-every-stock-is-synced.md): a
20-F's description is its Item 4.B "Business Overview" (else Item 4), and a
40-F is recorded as not found without a download; the newest original 10-K,
20-F or 40-F is the report described.

**Amended 2026-11-04** (§3a): the primary document is converted as a whole
document (no article start at its `<h1>`), more heading forms are read, the
cap is 32,000,000 bytes, and migration 0033 has every report stored as
`not-found` read again.

## Context

The owner asked (2026-11-01):

> Please include the business description in the company information section.

The Company tab (企業情報, ADR-0049 §6) showed only the stored listing. No
stored data described what a company does: SEC's submissions JSON, which the
`financial-sync` job already downloads, has an industry label only
(`sicDescription`, e.g. "Electronic Computers"); Finnhub's free profile has
no description; Twelve Data's `/profile` would spend the daily budget the
market sync is fitted to (ADR-0051).

Asked on 2026-11-01, the owner chose:

- **the filings**: the opening of "Item 1. Business" of the newest 10-K
  (one extra SEC download per new 10-K) and 事業の内容 of the newest
  有価証券報告書 (from the XBRL-to-CSV the sync already downloads);
- **a summary with "Show more"**: the first paragraphs, the rest behind a
  toggle, with the filing and its date linked.

## Decision

### 1. Only synced companies have one

The description comes with the financial-statement sync (ADR-0048): a
company the owner tracks (at most 20) gets one with its next sync. A stock
whose company is not tracked says so and points at syncing its financial
statements; a stored description stays after untracking. Every read stays
"stored data only" (ADR-0049 rule 4): opening the tab never fetches.
*Amended 2026-11-01 by ADR-0054:* tracking follows the Watchlist, so a
company has a description when its stock is on the Watchlist; the
not-tracked message says to add the stock to the Watchlist.

### 2. What the claim asks and the completion returns

Table `equity_business_description` holds one row per company: the report
read (`source_document_id`, form, filing date, period end, link), `status`
`extracted` with paragraphs or `not-found`, `truncated`, `fetched_at`
(migration 0022).

- **SEC** — the claim carries `describedDocumentId`, the stored row's
  accession or null. The runner already reads the submissions index; it
  takes the newest original 10-K there (greatest filing date, then
  accession; a valid report date and a plain primary-document name). When
  its accession differs from `describedDocumentId`, it downloads that
  primary document (`https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/{primaryDocument}`,
  the filing's own `sourceUrl`; one paced request, 32,000,000-byte cap,
  16,000,000 before §3a) and
  extracts the section (§3). A primary document over the cap is recorded
  as `not-found` (a retry would not make it smaller). A company syncs once a day, and a new 10-K
  arrives once a year, so this is about one request per company per year.
- **EDINET** — every annual securities report (120) whose CSV a job reads
  yields its 事業の内容 (`jpcrp_cor:DescriptionOfBusinessTextBlock`, context
  `FilingDateInstant`), at no extra request. The claim also carries
  `describeFiling`: the newest stored 120 report (by period end, filing
  date, document id) when it is newer than the stored description (or none
  is stored); the runner downloads that CSV for the description alone when
  the job does not download it anyway, within the job's download cap. Of the
  120 reports read, the completion carries the newest one's description.
- The completion's `description` is the report read, or null when the job
  read none (the stored one is current, or the read failed: a failed
  description read never fails the job — the annual facts matter more — and
  the next daily sync asks again). The API writes it only when no row is
  stored or the new report's (period end, filing date, document id) is at
  least the stored one's, so an EDINET backfill of older reports never
  replaces the newest description. `not-found` is stored like a success, so
  a report without a readable section is not downloaded again.

Amendments (10-K/A, 訂正有価証券報告書) are never read: they rarely repeat
the business section.

### 3. Finding "Item 1. Business" in a 10-K

The primary document (inline XBRL HTML, 1–13 MB on the companies checked)
goes through the runner's existing HTML-to-Markdown converter
(`htmlToMarkdown`, ADR-0030; the Rust port replays it), cut at 4,000,000
characters. Its blocks (blank-line separated; a table block's cells joined
with spaces) are marked:

- **start** — the block is "Item 1. Business" in any case and punctuation,
  "Items 1 and 2. Business and Properties", at most 60 characters (§3a
  adds more forms);
- **end** — the block starts "Item 1A", "1B", "1C", "2" or "3", at most 120
  characters;
- **other** — everything else.

A table of contents names Item 1 too, and some filings repeat the heading
as a running page header. `businessSectionBounds` (packages/domain, Lean
model `BusinessSection.lean`) takes every start followed by an end; the
body of each runs to the first end after it, and the one with the largest
body (sum of block lengths; earliest among equals) wins. A table of
contents row followed by "Item 1A" has an empty body; no candidate with a
body = `not-found`.

The body's blocks are then cleaned for SEC: tables are dropped (the
description is prose); page numbers, `---` page breaks, "Table of
Contents", "Part I" and a bare "Item 1" running header are dropped, as are
short running footers naming "Form 10-K"; and text before the first
subheading is dropped when that subheading is among the first three
paragraphs (Amazon and Coca-Cola open Item 1 with forward-looking-statement
and defined-terms boilerplate).

Checked against the live 10-Ks of Apple, Microsoft, Coca-Cola, JPMorgan
Chase and Amazon (2026-11-01): each found the body heading, not the table
of contents, and each section opens with what the company does.

### 3a. Reports read as having no section (2026-11-04)

913 of 5,422 stored descriptions (773 10-K, 140 20-F) were `not-found`,
among them EOG Resources, Freeport-McMoRan and e.l.f. Beauty. Of 40 of
them read again by hand, 38 have the section; the reader lost it because:

- **The converter's article start** (ADR-0009: a page without a main
  element starts at its `<h1>`). A 10-K has no main element, and its only
  `<h1>` is often a heading of the exhibit index at the end: everything
  before it, Item 1 included, was dropped (EOG: 1,294 blocks; 28 of the
  40). The primary document is now converted with `wholeDocument` (Rust
  `whole_document`), which keeps every block; web pages are unchanged.
- **Heading forms not read**: "Items 1. and 2. Business and Properties."
  (a period after each number), "Item 1. *Business*" (italic `*` markers
  are ignored when a block is marked), "Item 1." and "Business" in two
  blocks (a "Business" or "Business." block right after a bare "Item 1."
  block starts the section, `secSectionMarks`), and a 20-F's "Item 4.
  Information On Our Company".
- **Size**: Regency Centers' and BlackRock TCP Capital's 10-Ks are 21 MB;
  the cap is now 32,000,000 bytes.

With these, 36 of the 40 are read; the other 4 are 20-Fs that put the
description in an annual-report layout without Item headings (Unilever,
Shell, ArcelorMittal, InterContinental Hotels) and stay `not-found`.
`not-found` is stored like a success, so migration 0033 deletes the
`not-found` rows of 10-Ks and 20-Fs and makes each such company's
scheduled sync due now: its next `financial-sync` reads the report again
(one SEC request each). Read again by the Rust runner on the development
database (2026-11-04, about 40 minutes): 782 of the 913 now have the
section (693 of 773 10-Ks, 89 of 140 20-Fs); 131 stay `not-found`.

### 4. Paragraphs

`businessParagraphs` (packages/domain) turns blocks — the cleaned 10-K
blocks, or the 事業の内容 text's lines — into stored paragraphs: whitespace
runs collapse; empty blocks go; a lone list marker joins the next block; a
short block (≤ 80 characters) with a letter, not a list item and without
closing punctuation is a heading, everything else text. The leading
paragraphs that fit 20,000 UTF-16 units and 400 paragraphs are kept
(`truncated` when some were left out; when no text paragraph is kept yet,
the first one that does not fit is cut with "…" to the room left), trailing headings go, and a result without text is
`not-found`. Apple's Item 1 is about 15,000 characters; banks' run past
100,000, mostly regulation — the opening is what describes the business.

### 5. Read

`GET /api/v1/stocks/:stockId` adds `business`: `extracted` (paragraphs,
`truncated`, the source report, `fetchedAt`), `not-found` (the source
report), `pending` (tracked, nothing stored yet) or `not-tracked`. One more
primary-key read of the company (already read for news terms) and one of
the description; the body stays its own ETag digest.

### 6. Company tab

Below Listing, a **Business** group (事業内容):

- a source line — "From the 10-K for the fiscal year ended {date}, filed
  {date}" / 「{date}期の有価証券報告書（{date}提出）より」 — with a "View
  filing" link (new tab, `rel="noopener noreferrer"`);
- the summary: the leading paragraphs within 700 characters, always through
  the first text paragraph and never ending on a heading
  (`businessSummaryCount`); headings as subheadings, text as paragraphs, in
  the filing's language (an English UI shows 事業の内容 in Japanese: the
  filing's words are not translated);
- "Show more" / "Show less" (a button with `aria-expanded` and
  `aria-controls`) when more paragraphs are stored; when `truncated`, the
  expanded text ends with "The section continues in the filing.";
- `pending`: "The business description arrives with the next financial
  statements sync."; `not-tracked`: "Business descriptions come from annual
  reports, read when this company's financial statements are synced." with
  the Financial statements tab, where syncing starts (*amended by ADR-0054:*
  "Business descriptions come from annual reports, read for the stocks on
  the Watchlist. Add this stock to the Watchlist to read its description.",
  no button); `not-found`: "The
  newest annual report has no business section that could be read." with
  its link.

## Consequences

- A tracked US company costs one more SEC request per new 10-K (about once a
  year), up to 32 MB (16 MB before §3a); existing companies get theirs at their next daily
  sync. A Japanese company costs nothing extra, except one CSV download for
  a stored report read before this change.
- The section finder is heuristic: a filing that words its headings
  differently ends `not-found` (stored, shown as such, not retried until a
  newer report). Neither the summary nor the paragraphs are rewritten or
  summarised by a model: what is shown is the filing's own text.
- EDINET's text block is built from the specification and examples only;
  it is verified live when the owner sets `EDINET_API_KEY` (as the rest of
  the EDINET sync, ADR-0048).
