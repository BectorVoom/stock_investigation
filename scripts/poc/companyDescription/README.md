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
| 【事業内容】 Businesses | model | 1–4 statements, one product line or service each |
| 【連結事業】 Segments | model | the segments a source names; share of sales and margin (四季報's `79(4)`) only where a source states the number, never computed |
| 【海外】 Overseas | model | overseas share of sales, only where a source states it |
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
failing after it are not shown.

## Run

```sh
node --env-file=.env scripts/poc/companyDescription/run.ts            # every Watchlist stock in data-dev
node --env-file=.env scripts/poc/companyDescription/run.ts US:AAPL JP:1380
node --env-file=.env scripts/poc/companyDescription/run.ts --db <path to a D1 .sqlite file>
node --env-file=.env scripts/poc/companyDescription/run.ts --store    # also store them; the Company tab shows them
```

`--store` runs `store.ts` under Node (it needs `node:sqlite`). It writes
each `output/<MARKET>-<SYMBOL>.overview.json` through the adapter's
`companyOverviewStatement` into the six `overview_*` columns of
`stock_company_summary`. The development database is in WAL mode, so this
works while `bun run dev` runs.

Runs under Node, because the web step's safe fetcher does not work under
Bun. Needs `ANTHROPIC_API_KEY` and `TAVILY_API_KEY` (read from `.env`) and
the `sqlite3` CLI.

Besides the stored records, each stock gets up to three public web pages
(`webSources.ts`, ADR-0064 §2a). One Tavily search finds them, and the
runner's own `web.fetch_page` reads them:

- the company's own site comes first, then regulators and exchanges, then
  other pages;
- Wikipedia, social media, forums, Q&A, video, 会社四季報's site and plain
  http are never used;
- the fetched pages are kept under `output/pages/`;
- `--no-web` leaves the web step out. It goes
through the project's own Claude API adapter (no tools, effort medium) and
reads the database read-only. Per stock it writes to `output/`, which is
gitignored:

- `<MARKET>-<SYMBOL>.html`: the section in Japanese and English, then the
  check result. Open it in a browser.
- `.json`: the reply and the sources.
- `.replies.json`: the raw replies.

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
