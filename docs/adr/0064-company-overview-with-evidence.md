# ADR-0064: Company overview (事業概要) with evidence and references

Status: accepted, 2026-11-03. Builds on ADR-0060 (AI-written company
summaries), ADR-0053 (the US business description) and ADR-0059 §3 (a
Japanese stock's J-Quants profile).

## Context

ADR-0060's summary is free text: nothing ties a sentence to the stored
facts, so the model fills gaps from memory unseen. The stored summary of
秋川牧園 (1380) describes chicken and egg production, which no stored
source says. On 2026-11-03 the owner asked for:

1. a 企業の説明 template on the Company tab (企業情報), with evidence and
   references, written by Claude Haiku 5.5 (a proof of concept first,
   `scripts/poc/companyDescription/`);
2. laid out like the company descriptions of 会社四季報 (Japan Company
   Handbook) and SBI証券, with the references in small text;
3. written without AI-like style;
4. stored in new database columns and shown on the page, with the section
   renamed from 企業の説明 to 事業概要.

## Decision

### 1. The entry

`CompanyOverviewView` (`packages/contracts/src/companyOverview.ts`)
follows 会社四季報's entry as SBI証券 shows it on its 企業概要 tab:

- labelled rows 【特色】 (one line), 【事業内容】, 【連結事業】 (a segment's
  share of sales and margin, 四季報's `79(4)`, only where a source states
  them), 【海外】 and 【テーマ】;
- a 基本情報 (Key facts) table: market, sector (Japan) and fiscal year end
  from stored records, and founded, employees and headquarters where a
  source states them;
- a 業績 (Results) table: the latest fiscal year's stored figures in
  millions and the operating margin computed from them (removed from the
  page later the same day, §5a).

Only the layout follows 会社四季報. Its text is Toyo Keizai's licensed
content and is neither read nor copied. Its forecast paragraphs have no
counterpart (ADR-0060: no forecasts). Every text is stored in English and
Japanese.

### 2. Evidence and references

The server builds numbered sources (S1–S9) from its own records:

- the stock directory entry;
- a US company's 10-K "Item 1. Business" or a Japanese company's J-Quants
  profile;
- the stored annual figures.

The model sees each source's id and text. It writes every field with 1–3
evidence items `{ source, quote }`. Code accepts a field only when every
quote is found word for word in the named source (ignoring whitespace,
letter case, Unicode width and quote/dash style), and only when every
stated percentage appears in its quotes. A field that still fails after
one repair turn is dropped, never stored. The references (title,
publisher, date, link, note) come from the records, never from the model.
The view refuses a citation that is not in its references.

### 2a. Public web pages as sources (2026-11-03)

The stored records alone were too narrow. A Japanese company has no
business text at all, so 秋川牧園's 事業内容 and テーマ were empty, and the
owner asked to broaden the acceptable sources. Each stock now also gets up
to three public web pages (S4 onward). One web search (`web.search`,
Tavily, one credit) finds them, and the runner's own `web.fetch_page` reads
them: the pinned safe fetcher, robots.txt, per-host spacing, 2 MiB and 15 s
a page. Each page's text (up to 10,000 characters) is quoted and checked
word for word like any other source.

Acceptable pages, in this order:

1. the company's own site (its host contains a distinctive word of its
   English name);
2. regulators and exchanges (SEC, EDINET, JPX, TDnet, `*.go.jp`);
3. other pages.

Never used: Wikipedia and other open-edit encyclopedias (removed from
research by the owner, ADR-0025), social media, forums, Q&A and video
sites, 会社四季報's own site (licensed text), and plain http.

A page's reference shows its title, its host as the publisher, its kind
(企業の公式サイト / 規制当局・取引所 / ウェブページ) and the day it was retrieved.
The 出典 list shows only the pages a shown field cites.

Result on 2026-11-03: 1380 went from 3 fields (sector only) to 12, all
verified, from akikawabokuen.com's 事業紹介 and 会社概要 pages:
- its segments 生産卸売事業 and 直販事業, each with what it does;
- themes such as 無農薬野菜 and 冷凍鶏加工食品;
- founded, employees and head office.

AAPL (14/14) and KO (15/15) also read apple.com and coca-colacompany.com
pages. The PoC runs under Node, because the safe fetcher's pinned sockets
time out under Bun.

### 3. Style

The prompt carries `STYLE_RULES`, in English and Japanese:

- write like a handbook editor;
- name products, brands and segments rather than category words;
- no filler or praise words, and no sentence starting with "The company"
  or 「同社は」;
- no 「〜しています」 chains, em dashes or summing-up sentences;
- no hedging and no evaluation.

The style is asked for, not checked by code.

### 4. Storage

Migration 0029 adds six nullable columns to `stock_company_summary`, stored
whole or not at all (CHECK):

- `overview_json`, `overview_facts_json`, `overview_references_json`;
- `overview_agent_id`, `overview_model`, `overview_generated_at`.

They sit beside the ADR-0060 columns. The overview write
(`companyOverviewStatement`) leaves the summary untouched, and a
`company-summarized` completion leaves the overview untouched. The Stocks
read returns both from one primary-key seek: `overview` beside `summary` in
`GET /api/v1/stocks/:stockId`.

### 5. The page

The Company tab's first section is now 事業概要 (Business overview). It
shows the overview when one is stored, otherwise the ADR-0060 summary.
Small text (12 px; the source marks are `<sup>`, 75 % of the text) is used
for:

- the source marks after each field;
- the 出所 line under each part;
- the numbered 出典 list;
- the AI line.

The AI line is dated by the browser's day.

### 5a. No evidence list, no results (2026-11-03)

The owner asked to delete 根拠(出典からの引用) and 業績 from the page. The
quotes are still checked and stored (they are what makes a field
trustworthy), and the figures stay in `overview_facts_json`. The page shows
neither, and its 出典 list names only the sources the shown fields cite:
the figures' source is left out. The AI line says only who wrote the entry,
when, from the sources above only, and that it may contain mistakes (the
owner removed the check and 会社四季報 sentences on 2026-11-03).

### 5b. Business activities and specific themes (2026-11-03)

The owner asked that the section explain the company's actual business
activities from its business segment information, and that themes be
specific ("Natural Foods" rather than "Food", "Analog Semiconductors"
rather than "Semiconductors").

- 【事業内容】 explains, segment by segment, what the company makes or
  provides, for whom, and how it earns the money. When the segments are
  regions selling the same things, it explains the main product and
  service lines instead. A sector classification is not an activity: a
  company whose sources describe none gets an empty row.
- Each 【連結事業】 segment carries `activity`: one quoted line on what it
  does, or null when the sources say nothing about that segment. Entries
  stored before this read it as null.
- 【テーマ】 are at sub-industry level and never a sector name or a broad
  word. When nothing specific is supported, there are none.

The draft therefore allows empty 事業内容 and テーマ lists.

### 6. Who writes it, for now

The writer is the proof of concept: `node --env-file=.env
scripts/poc/companyDescription/run.ts --store` reads the web pages (§2a),
asks Claude Haiku 5.5 (through the project's Claude API adapter, no
tools), checks the evidence and stores the verified entries of the
Watchlist stocks with `store.ts` (Node, `node:sqlite`, the same statement).
`--no-web` leaves the web pages out. Run on the development database on
2026-11-03, with web pages:

| Stock | Fields verified |
|---|---|
| AAPL | 14 / 14 |
| KO | 15 / 15 |
| 1380 | 12 / 12 |

Cost: about $0.02 of Claude API usage and one Tavily search a stock.

## Consequences

- Every sentence on 事業概要 can be traced to a quote in a named source,
  and a figure is never the model's own.
- Without web pages (`--no-web`, or a search that finds no acceptable
  page) a Japanese stock's entry stays thin: the stored sources give only
  its names, listing, sectors and figures. A stored text source, such as
  the 有価証券報告書's 「事業の内容」 (EDINET, removed by ADR-0059), would
  remove the dependence on the web.
- 【連結事業】 shows segment names without 四季報's shares and margins: the
  segment note of the financial statements is not stored.
- The check proves that the quoted words exist, not that a sentence says
  no more than its quote, and it does not check the Japanese translation.
- Open (technical debt): the runner jobs still write ADR-0060 summaries. To
  move the writer into the server's `company-summary` job:
  - carry the sources in the claim;
  - run the prompt and the evidence check in both runners (TypeScript and
    Rust, with conformance vectors);
  - write the overview in the completion's guarded batch.

  Until then, overviews are refreshed by running the script.
- Rollback: drop the six columns in the order migration 0029's header
  gives. The version-28 code never reads them.
