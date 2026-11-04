# PoC: 事業概要 (company overview) with evidence and references

A proof of concept for the Company tab's (企業情報) "About the company"
(企業の説明) section, written by Claude Haiku 5.5. It is laid out like a
company entry of 会社四季報 (Japan Company Handbook) as SBI証券 shows it on its
企業概要 tab: labelled rows, a 会社概要 table and a 業績 table, with every
source credit in small text (the HTML report shows the 業績 table and the
根拠 quotes for review; the app's page shows neither, ADR-0064 §5a). Every
field carries evidence. With `--store` it writes the verified
entries into the database, and the app's Company tab shows them under
事業概要 (ADR-0064). The server's `company-summary` job still writes ADR-0060
summaries; until that job writes overviews too, this script is the writer.

**Only the layout follows 会社四季報.** Its text is Toyo Keizai's licensed
content (SBI証券 shows it to logged-in customers) and is neither read nor
copied. Its editorial forecast paragraphs have no counterpart (ADR-0060: no
forecasts). Every field comes from the server's own stored records or
from up to three public web pages (ADR-0064 §2a).

## The template

| 四季報's label | Who fills it | Rule |
|---|---|---|
| 【特色】 Feature | model | one statement; Japanese at most 70 characters (one handbook line) |
| 【事業内容】 Businesses | model | the summary of the business: 2–4 sentences of one paragraph (Japanese about 100–250 characters) on what it makes or provides, main products or brands, customers, how it earns the money and where; always written when a source describes the business |
| 【連結事業】 Segments | model | the segments a source names; share of sales and margin (四季報's `79(4)`) only where a source states the number, never computed |
| 【海外】 Overseas | model + code | the overseas share and up to 6 countries or regions with their shares: the model copies stated shares or a region table's amounts (and its total and home amounts), code computes the shares (ADR-0064 §5f) |
| 【テーマ】 Themes | model | 1–6 chips, each with a one-statement reason (shown on hover) |
| 会社概要 Profile | code + model | market, sector (JP) and fiscal year end from stored records; founded, employees and headquarters by the model, only when a source states them |
| 業績 Results | code | the latest fiscal year's stored revenue, operating, ordinary (JP) and net income in millions, and the operating margin computed from them |
| 出所 / 出典 References | code | small source marks (S1, S2…) after each field, a small 出所 line under each part, the numbered 出典 list, and the quotes in a closed 根拠 list |

Model fields are typed by the contract in
`packages/contracts/src/companyOverview.ts`; `template.ts` aliases it for
the PoC and adds the style rules. Each has `evidence: [{ source:
"S2", quote: "…" }]`. The sources are built by the code from stored
records (`sources.ts`):

- S1: the stock directory entry.
- S2: a US company's 10-K "Item 1. Business" (up to 24,000 characters) or a
  Japanese company's J-Quants profile.
- S3: the stored annual figures.

The model sees only the ids and the text, so it cannot invent a title or
a link.

## Style: no AI-like writing

`STYLE_RULES` in `template.ts` is part of the prompt, with rules for English
and for Japanese. The text should read like a handbook editor wrote it:

- Name products, brands, segments and numbers from the sources rather than
  category words.
- No filler or praise words unless a source uses them ("leading",
  "comprehensive", 「幅広い」「多岐にわたる」「〜に注力」…).
- No sentence starting with "The company" or 「同社は」.
- No 「〜しています」 chains: end lines with a noun or 「〜を展開。」.
- No em dashes, "not only … but also", rule-of-three lists or summing-up
  sentences.
- No hedging and no evaluation.

On 2026-11-03 the rules were added and Haiku 5.5 re-run. One phrase in 80
texts matched the list: 「子会社を通じて展開」, which states a fact there.
The style is not checked by code.

## The evidence check

`evidence.ts` accepts a field only when all three hold:

- every quote is found word for word in the source it names, ignoring only
  whitespace, letter case, Unicode width and quote/dash style;
- every stated percentage appears in one of its quotes;
- text with a digit quotes something with a digit.

A failing reply gets one repair turn listing each failure. Fields still
failing after it are not shown. When the repair turn's reply still breaks
the schema (a theme label over 40 characters cost Microsoft its whole
entry on 2026-11-03), `reply.ts` drops just the invalid list items; only an
invalid 【特色】 loses the entry. An entry is stored only when a verified
field cites a business text or a web page; one that quotes only the stock
list, the sector code or the figures (「東証プライム上場の松竹。」) says
nothing, and storing it would hide the ADR-0060 summary.

## Run

```sh
node --env-file=.env scripts/poc/companyDescription/run.ts            # every Watchlist stock in data-dev
node --env-file=.env scripts/poc/companyDescription/run.ts US:AAPL JP:1380
node --env-file=.env scripts/poc/companyDescription/run.ts --db <path to a D1 .sqlite file>
node --env-file=.env scripts/poc/companyDescription/run.ts --store    # also store them; the Company tab shows them
# every stock-list stock, 6 at a time, stored as each finishes; resumes where it stopped
node --env-file=.env scripts/poc/companyDescription/run.ts --all --store --concurrency 6 --out <dir>
```

| Option | Meaning |
|---|---|
| `--all` | every stock-list stock, in `directoryStocks` order: Watchlist, then Japanese stocks by TOPIX size (Core30 first), then the rest |
| `--limit <n>` | write at most n stocks |
| `--concurrency <n>` | stocks written at the same time (default 1); a rate-limited or overloaded model turn is retried up to 3 times after 30, 60, 90 s |
| `--force` | also rewrite stocks whose overview is already stored (skipped by default, so a run resumes), and retry stocks the same search provider searched in the last 30 days without a usable result (also skipped by default, so restarts do not pay for those searches again) |
| `--rewrite-before <ISO>` | also rewrite stored entries written before that instant |
| `--no-web` / `--web-all` | no web pages / web pages for every stock (default: only a stock without a stored business text) |
| `--store` | store each verified overview as soon as it is checked |
| `--search claude` / `--search tavily` | who finds the web pages: a Claude Haiku 5.5 agent with the Claude API's web search tool (default, about USD 0.02 a stock, `claudePageFinder.ts`) or Tavily (`TAVILY_API_KEY`, 1,000 free searches a month) |

`--store` writes through `storeOverview.ts` (the adapter's
`companyOverviewStatement`) into the six `overview_*` columns of
`stock_company_summary`; it needs `node:sqlite`. The development database
is in WAL mode, so this works while `bun run dev` runs. `store.ts`
re-stores saved `.overview.json` files.

A rewrite (`--force`, `--rewrite-before`) replaces a stored entry only
with one at least as full: it must keep 【事業内容】 and fill as many rows
(`mayReplace`, `runPolicy.ts`). The first unguarded rewrite left 32 entries
without the 【事業内容】 they had.

Runs under Node, because the web step's safe fetcher does not work under
Bun. Needs `ANTHROPIC_API_KEY` (read from `.env`; `TAVILY_API_KEY` only for
`--search tavily`) and the `sqlite3` CLI.

Besides the stored records, a stock gets up to three public web pages
(`webSources.ts`, ADR-0064 §2a, §2b). A Claude Haiku 5.5 agent finds them
with the Claude API's web search tool (`claudePageFinder.ts`, at most two
searches; `--search tavily` uses Tavily instead) and picks up to six from
its results; only those picks, and only if they were among the results,
are read, by the runner's own `web.fetch_page`:

- the company's own site comes first, then regulators and exchanges, then
  other pages. A site is the company's own when its registered domain name
  is built from the company's name ("toyota.co.jp", "coca-colacompany.com"),
  while one that only starts with the name ("akikawabokuen.com", but also
  松竹芸能's "shochikugeino.co.jp" for 松竹) is an ordinary page;
  a family company's site ("toyota-body.co.jp" for TOYOTA MOTOR) is never
  read, because its profile page would pass the quote check while
  describing a different company;
- Wikipedia, social media, forums, Q&A, video, 会社四季報's site and other
  licensed editorial blurbs or quote pages (Nikkei, 株予報, みんかぶ, 株探,
  Yahoo Finance), machine-written profiles (Tavily's, MarkLines' AI
  analysis), contact-list aggregators, job boards and recruiting pages
  (also by host name: …tenshoku…, …career…, recruit.…) and plain http are
  never used;
- a page that cannot be read gives its place to the next result (at most
  six tried). A refused redirect (many Japanese sites send "/company" to
  "http://…/company/") is tried once more as the https URL with the slash;
- a page the runner's fetcher cannot read for an HTTP error, an empty
  (script-rendered) page, a page over 2 MiB or a timeout is read once more
  with the Claude API's web fetch tool (`fetchText`, ADR-0064 §2c); never
  a page robots.txt refuses, a rejected address, or a PDF;
- a preferred share, warrant, unit or right whose issuer is listed
  ("AHL-PD" → AHL) copies its issuer's entry after every other stock is
  done (ADR-0064 §5e); funds, trusts and SPACs are described as such;
- by default only a stock without a stored business text (every Japanese
  stock, a US one without a 10-K Item 1) is searched, about USD 0.02 a
  stock with the Haiku agent. Five failed searches in a row pause all
  searches for five minutes; only an answer that the credits or the spend
  limit are used up turns them off. A stock left with no business text is
  skipped without a model turn; one searched without a usable result waits
  30 days before the same provider tries again;
- the fetched pages are kept under `<out>/pages/`.

The model turn goes through the project's own Claude API adapter (no
tools, effort medium) and reads the database read-only. Per stock it
writes to `--out` (default `output/`, which is gitignored):

- `<MARKET>-<SYMBOL>.html`: the section in Japanese and English, then the
  check result. Open it in a browser.
- `.json`: the reply and the sources.
- `.replies.json`: the raw replies.
- `.overview.json`: what is stored.
- `run.jsonl`: one line per stock (turns, cost, verified fields, web pages,
  stored, or why nothing was written).

Tests: `tests/local/companyDescriptionPoc.test.ts`.

## Result on 2026-11-03 (data-dev Watchlist)

| Stock | Turns | Fields verified | Cost |
|---|---|---|---|
| JP:1380 秋川牧園 | 2 | 4 / 4 | $0.0018 |
| US:AAPL | 1 | 14 / 14 | $0.0033 |
| US:KO | 2 | 14 / 14 | $0.0083 |

## What it showed

- **US stocks fill most of the entry.** The 10-K business section gives
  特色, 事業内容, the segment names, themes, the year founded (KO) and the
  employee count (AAPL).
- **【連結事業】 has names but no numbers.** 四季報's segment shares and
  margins come from the segment note of the financial statements, which we
  do not store (SEC company facts have no segment breakdown). A real
  【連結事業】 needs that data; the 10-K's segment note is the source.
- **Japanese stocks are thin.** The stored sources give only the name,
  listing, sectors and figures, so 特色 and 事業内容 just restate the sector.
  ADR-0060's stored summary of 1380 describes chicken and egg production,
  but none of the stored sources says that, so it came from the model's
  memory. A Japanese description on par with 四季報 needs a text source, such
  as the 「事業の内容」 section of the 有価証券報告書 (EDINET, removed by
  ADR-0059).
- **Limits of the check.** It proves the quoted words exist, not that the
  sentence says no more than the quote, and the Japanese translation is not
  checked (Haiku once wrote "Dasani" as 「ダサani」).
