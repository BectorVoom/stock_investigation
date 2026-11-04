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
  them), 【海外】 (the overseas share of sales and each country's share,
  §5f) and 【テーマ】;
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

1. the company's own site: its registered domain name is built from its
   English name ("toyota.co.jp", "coca-colacompany.com", "toyota-global.com").
   One that only starts with a distinctive word of it is an ordinary page:
   "akikawabokuen.com" is 秋川牧園's, but "shochikugeino.co.jp" is 松竹芸能's,
   not 松竹's;
2. regulators and exchanges (SEC, EDINET, JPX, TDnet, `*.go.jp`);
3. other pages.

A family company's site — a distinctive word of the name plus a hyphenated
word the name lacks, such as "toyota-body.co.jp" or "toyota-ej.co.jp" for
TOYOTA MOTOR — is never read (2026-11-04). The first rule, "the host
contains a distinctive word", took both for Toyota's own site; their
profile pages pass the quote check while describing another company.
A site named after the Japanese name is the company's own when the
Japanese name has the kanji of its romanized words: "subaru-kougyou.jp" is
スバル興業's (Subaru Enterprise; 興業 = kougyou), never SUBARU's
(webSources.ts `ROMANIZED_NAME_WORDS`, 2026-11-04).

The writer searches only for a stock without a stored business text
(every Japanese stock, a US company without a 10-K Item 1), Japanese stocks
by TOPIX size first. (At first each search was one Tavily credit, and the
owner's free 1,000 a month ran out; §2b replaced Tavily with a Haiku agent.)

Never used: Wikipedia and other open-edit encyclopedias (removed from
research by the owner, ADR-0025), social media, forums, Q&A and video
sites, 会社四季報's own site (licensed text), Tavily's machine-written
company profiles and job boards (added 2026-11-04, when マイナビ and
`tavily.com/knowledge` pages filled source slots for 三菱重工業 and JR東海),
and plain http.

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

### 2b. The Haiku agent finds the pages (2026-11-04)

Tavily's free 1,000 searches a month ran out after about 985 stocks
(HTTP 432), and the owner asked for the pages to be found by web search
with a Claude Haiku 5.5 agent. The writer's default page search is now one
Messages request per stock with Haiku 5.5 and the Claude API's web search
tool (`web_search_20250305`, at most 2 searches, the excluded hosts as
`blocked_domains`). The agent picks up to six pages from its results, the
company's own site first. Only its picks are read, and only those that were
among the results: nothing written from memory is read, and results it
passed over (job sites, subsidiaries) are not read either. The pages are then read by the
runner's own fetcher and quoted and checked like any other source, so the
evidence rule does not depend on the agent. A search costs USD 10 per 1,000
plus about 19,000 input tokens; a stock that needs one costs about USD 0.02
in all. `--search tavily` keeps the earlier path. When a company's own site
refuses robots or renders only with JavaScript, the readable pages are
third-party company profiles (kitaishihon.com, irbank.net…), shown as
ウェブページ.

### 2c. Pages the runner cannot read (2026-11-04)

About 1.4% of searched stocks ended with no readable page and so no entry:
the runner's fetcher got an HTTP error (sites refusing bots), an empty
page (rendered only by script), a page over 2 MiB, or a timeout. For those
four failures, and only those, the page is read once more with the Claude
API's web fetch tool (`web_fetch_20250910`, Haiku 5.5, at most 8,000
tokens of text, the excluded hosts blocked; about USD 0.001 a page). Its
text, without the tool's metadata header, is quoted and checked like any
page. A page robots.txt refuses, an address or redirect the safety policy
rejects, and a PDF (the tool returns PDFs as binary) are never read this
way.

### 2d. Claude Code instead of the Claude API (2026-11-04)

When the API's prepaid credit ran out, the owner asked for the Haiku 5.5
agent through Claude Code. `run.ts --backend claude-code` (now the
default) runs Haiku 5.5 with the `claude` CLI on the owner's subscription
login:

- writing turns go through the claude-code adapter (no tools; a turn
  whose CLI reports any tool or an API key fails closed);
- page searches run `claude -p` with the WebSearch tool alone
  (`claudeCodePageFinder.ts`): the CLI's init line must list only
  WebSearch, no MCP server and `apiKeySource` "none", and the child gets
  no `ANTHROPIC_*` variable, so the run can never bill an API key; a
  picked URL is read only when it appeared in the search results, as
  before;
- there is no web-fetch fallback: Claude Code's WebFetch returns a model's
  summary, not the page's words, so no quote could be checked;
- the plan's usage is shared with the owner's own Claude Code work: the
  run pauses when the 5-hour window is 80% used (until it resets) and
  stops when the 7-day window is (`PlanGate`, from each search turn's
  `rate_limit_event`); a rate-limited writing turn waits 30 minutes;
- ニコニコ大百科 and other user-written wikis are excluded like Wikipedia;
  the search prompt asks for HTML pages, not PDFs;
- (2026-11-04, review of the first 2,383 stocks) sites whose pages the
  runner's fetcher could read at most 15% of the time are excluded (bot
  walls and script-only pages: roic.ai 2 of 74, CEF Connect 11 of 82,
  barchart.com 0 of 45, GuruFocus, Simply Wall St, stocknear, CapEdge,
  Craft, PitchBook, YCharts and others), and the prompt asks for a short
  SEC document only (an annual or fund report or a prospectus is over the
  fetcher's 2 MiB: 908 such picks were refused) and, for a fund, the fund
  manager's own page first.

`--backend claude-api` keeps the metered API path.

### 5b. Empty rows and bare segments (2026-11-04)

トヨタ紡織's entry showed 【連結事業】 as four region names (米州, アジア,
中国, 欧州・アフリカ) whose only evidence was the page heading "### 米州",
and 【海外】 as 「出典に記載なし」. The owner asked for the template to be
fixed:

- A segment with no activity and no stated share or margin
  (`isBareSegment`, contracts) is neither stored nor shown, whatever its
  quote; the prompt lists a segment only with one of them. (First only a
  segment quoting its own heading counted; Coca-Cola's "Latin America"
  quoting "Our operating structure includes the following operating
  segments:" showed that was too narrow.)
- Like 四季報, a row (【特色】…【テーマ】) or key fact (founded, employees,
  headquarters, market, fiscal year end) with nothing to show is left out
  instead of marked 「出典に記載なし」.
- 【特色】 says what sets the company apart (position, origin, group, main
  brand or market) instead of repeating the 事業内容 lines, and every claim
  in a field must be stated in that field's own quotes: 「トヨタグループの」
  rested on a quote that never said it. The quote check proves a quote is
  in its source, not that it supports every word of the field, so this
  rule lives in the prompt.

### 5c. 【事業内容】 is the summary of the business (2026-11-04)

The owner asked for 【事業内容】 to be the summary of the company's
business. It was a bulleted list of up to four fragments, one product line
each (「電気通信機器・電気機器…を製造・販売。」), and empty in 100 of 1,708
stored entries. It is now one short paragraph of 2–4 sentences (Japanese
about 100–250 characters): what the company makes or provides, its main
products, services or brands, its customers, how it earns the money and
where it sells. Each sentence is still one statement with its own
evidence, so the stored shape (`businesses`, up to 4 statements) is
unchanged and older entries show as a paragraph too. A reply that leaves it
empty although a business text or web page is among the sources gets the
repair turn. The page shows the sentences as one paragraph, each followed
by its source mark.

### 5d. What the review of 2026-11-04 changed

An independent review of the first ~2,300 entries found entries stored
without a 【事業内容】, claims no quote supported, and a rewrite that made
entries worse. The writer now:

- **Checks names and numbers, not only quotes** (evidence.ts
  `claimTerms`): every katakana or Latin-script name in Japanese text,
  every capitalised word after the first of an English sentence, and every
  number must appear in the field's quotes or in the sources the field
  cites (Japanese-era years count as their Western years). 「トヨタグループ」
  in no source fails. Requiring the quote itself would have rejected 34–45%
  of fields, mostly names stated a line away; this rule rejects 1–4%, and a
  failing field first gets the repair turn. Kanji names are not checked.
- **Checks the style rules** (style.ts): banned phrases the source does not
  use and English starting "The company" ask for the repair turn but never
  remove a field.
- **Does not store an entry without 【事業内容】** when a source describes the
  business (76 were stored before), and **never replaces a stored entry
  with a less full one** on a rewrite (the first rewrite left 32 without
  the 【事業内容】 they had).
- **Excludes more sites**: licensed editorial blurbs and quote pages
  (Nikkei, 株予報, みんかぶ, 株探, Yahoo Finance) on the same grounds as
  会社四季報, machine-written analysis (MarkLines), contact-list aggregators,
  and job and recruiting sites by host name.
- **Pauses** web searches for five minutes after five failures in a row
  instead of turning them off, and treats a search-tool error as a failed
  search rather than "nothing found".

Retrying the run's 52 failed stocks (2026-11-04) changed four details:

- A reply whose 【特色】 is empty or invalid keeps its other fields: Haiku
  leaves 【特色】 null when no quote supports one, and the whole reply was
  then discarded (10 stocks). An entry may lack 【特色】 (§5b).
- A quote of a markdown link's text matches: pages read by Claude's web
  fetch are markdown, "[World Financial Group](https://…)".
- A number spelled out in English in a quote ("four platforms") backs the
  digit (「4つ」).
- A hyphenated word is checked by its name: "Bermuda-based" by Bermuda.

### 5e. Listings that are not operating companies (2026-11-04)

The stock list also holds preferred shares, warrants, units and rights
(532 US listings such as AHL-PD, AAC-WT) and funds, trusts and ETFs.

- A preferred share, warrant, unit or right whose issuer is itself listed
  (472 of the 532: "AHL-PD" → AHL) takes a copy of its issuer's entry: its
  business is the issuer's. No model turn; the copies are made after every
  other stock, so the issuer's entry exists first.
- (2026-11-04) Nasdaq writes such a listing without a hyphen, and a note
  or another share class has a symbol of its own: 70 of the first 171
  stocks the full run could not write were these (EFSCP, HBANP, EDBLW,
  GPACU, DUKB, FCNCN), searched as companies and finding nothing. A
  listing now also takes the entry of a listing under the same company
  name whose symbol is its issuer's: the issuer's symbol followed by more
  letters (EFSC → EFSCP), or a class-A share of the same root (FCNCA →
  FCNCN). An exchange-traded note only shares its bank's name (BMO's
  FLYD, Deutsche Bank's DZZ) and is written as itself.
- A fund, trust, ETF or blank-check company (SPAC) is written like any
  stock, and the prompt tells the model to describe it as one: its
  investment objective or purpose, what it holds or seeks, who manages or
  sponsors it, and themes naming what it invests in.

### 5f. 【海外】 names the countries (2026-11-04)

The owner: a bare "42%" tells the reader nothing — write the countries and
their shares. 【海外】 now reads 「海外売上高比率 58%（米国 33%、欧州 15%、
アジア 10%）」 ("Overseas sales 58% (United States 33%, …)"), or the
countries alone when the overall share is unknown.

Sources rarely state a country's share; they give a table of sales by
region (所在地別 / 地域ごとの情報 / revenue by geographic area) in the
table's own unit. So the model copies the numbers and code computes the
shares (`overseasSalesFromDraft` in `@research/contracts`):

- the draft's `overseasSales` holds the stated overseas share, the table's
  total and home-country amounts, and up to six countries or regions
  outside the home country, each with a stated share or its amount;
- every one of those numbers must be in the field's quotes (the usual
  number check), and the names like any name;
- a region's share is its stated share, else its amount over the total; the
  overseas share is the stated one, else the total less the home amount
  over the total; one decimal place, largest region first;
- a table without a total row (Sony's, Hitachi's 地域別売上高) adds up: the
  model copies the home amount and every other row, その他 included (up
  to 12; the page shows the largest six), and quotes the header row so
  each amount can be matched to its region;
- a long page keeps its sales-by-region table: past 10,000 characters a
  page contributes its first 8,000 and a 2,000-character excerpt at its
  first region-sales heading (`pageTextForModel`), and the page search
  asks for a page of sales by country or region;
- the stored entry keeps `percent` (nullable) and `regions` (`name`,
  `percent`), not the amounts. An entry stored before this has no
  `regions` and still reads (`regions` defaults to empty); it gains them
  when it is rewritten.

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
