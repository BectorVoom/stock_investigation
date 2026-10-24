# ADR-0032: The UI speaks the owner's language (English and Japanese)

**Status:** Accepted · **Date:** 2026-10-24 · **Owner decision:** "Please
support global language", then, asked what that covers: **translate the UI**
(not the research input or the agent's answers), shipping **English +
Japanese** first, with a framework where a language is one more catalog.

## Context

Every word of the web app was written into its components in English: about
980 places across 70 files (measured by the scanner below on 2026-10-24),
`<html lang="en">` fixed, Shoelace's own control words English only. The
owner researches Japanese and US companies and reads Japanese.

## Decision

1. **One small package, `@research/i18n`** (`packages/i18n`):
   - `LOCALES = ["en", "ja"]`, `negotiateLocale(navigator.languages)` (match
     on the primary subtag, else English), `LOCALE_NAMES` (each language
     named in itself: "English", "日本語").
   - `defineMessages({ en, ja })`: a catalog is one table per language. The
     English table fixes the keys and every parameter type; the compiler
     rejects a missing key or a parameter of another type in any other
     language. A message is text or a function of its parameters (counts,
     names, elements), so each language orders its own words and chooses its
     own plural forms. `catalogProblems` re-checks what a cast could hide.
   - `@research/i18n/solid`: `LocaleProvider`, `useLocale()`,
     `useMessages(catalog)` → an accessor; components read `m().key` inside
     JSX, so a language change re-renders text in place with no reload.
     Without a provider the language is English (unit tests need no setup).
   - Dependencies: `solid-js` only, and only in the Solid binding; the core is
     also type-checked without the DOM lib.
2. **Catalogs live beside the code that shows them**, one
   `<feature>.messages.ts` (or `.tsx` when a message holds an element) per
   feature folder; shared words in `apps/web/src/i18n/common.messages.ts`.
   There is no central catalog file, so features translate independently.
   Pure models that produce owner-facing text take the table they need as a
   parameter (functional core, ARCH-002) instead of reading a global.
3. **The choice:** Settings → Language offers "Browser default (…)",
   English, 日本語. The default follows the browser (and its `languagechange`
   event). A fixed choice is kept in this browser's `localStorage`
   (`research.locale`), a per-visitor convenience (docs/rule/error_handling.md,
   "Best-effort conveniences"): refused storage means the choice lasts for the
   visit. Nothing on the server changes.
4. **`<html lang>` follows the language**, which also switches the words
   inside Shoelace controls (Shoelace's own Japanese translation is
   registered in `apps/web/src/home/shoelace.ts`) and lets screen readers
   pronounce the page correctly.
5. **The reusable widget grid stays free of the library** (ADR-0019): its
   few words (move announcement, select toggle, size names) are a
   `WidgetGridStrings` object with English defaults, passed by the host
   through `WidgetGridStringsProvider`; the app passes
   `apps/web/src/i18n/widgetGrid.messages.ts`.
6. **What is translated:** every word the app itself writes — headings,
   labels, buttons, menus, hints, notices, empty states, accessible names and
   live-region announcements, the tab title, the client's own error sentences
   and the descriptions of the API's stable error codes.
7. **What is not translated, on purpose:**
   - research content: the agent's answers, article and source titles,
     quoted evidence, widget titles the owner or the agent wrote, data
     labels from a provider (FRED and Twelve Data series names);
   - identifiers: error codes, tickers, exchange codes, units and currency
     codes, product names (OpenCode, Codex, Claude Code, Google Calendar,
     FRED, SEC EDGAR, JPX);
   - text for developers or models: thrown-error messages, logs, the MCP
     tool descriptions, prompts;
   - **numbers and dates**: figures keep one notation in every language
     (`1,234.5`, ISO dates `2026-10-24`, instants in UTC), so a figure reads
     exactly as in the source document and the as-of rules of FR-017 hold
     unchanged. English and Japanese share digit grouping and the decimal
     point, so nothing reads wrong today. A language with other separators
     (German, French) would have to thread the locale into
     `apps/web/src/lib/format.ts` and `packages/ui-registry/src/format.ts` —
     recorded here as the known follow-up, not done.
8. **API errors:** the server keeps sending a stable `code` and an English
   `message` (API-008, unchanged). In English the UI shows them as before.
   In another language it shows the translated description of the code
   (and the client's own failures in that language); the server's English
   message stays in the DOM as the code's tooltip for diagnosis.
9. **Guards:**
   - `apps/web/test/catalogs.test.ts` imports every `*.messages.ts` by name
     and fails on a missing, extra, empty or mistyped entry, or on a
     Japanese entry that copies an English sentence unchanged;
   - `tests/architecture/uiText.test.ts` (scanner
     `tests/architecture/uiTextScanner.ts`) fails on English UI text written
     into UI source outside a catalog. A line that must stay as it is (a
     product name, a unit) carries `// i18n-exempt: <reason>` on the line
     before; `bun tests/architecture/uiTextScanner.ts <path>` lists the
     findings of a folder;
   - Playwright configs pin `locale: "en-US"`, so a machine whose system
     language is Japanese still runs the English specs; the Japanese spec
     sets its own locale.

## Japanese style and glossary

Polite form (です・ます) for sentences, short noun forms for buttons and menu
items (保存, 削除), full-width 「」 around quoted names, 。and 、 as
punctuation, half-width digits and Latin letters, a space between Japanese
and a Latin word only where it reads better (AI エージェント). Keep it short:
the widgets and side panels are narrow.

| English | 日本語 |
|---|---|
| Home / Watchlist / Chat / Sources / Settings | ホーム / ウォッチリスト / チャット / 情報源 / 設定 |
| Research workspace | リサーチワークスペース |
| workspace (a chat's research space) | ワークスペース |
| chat, conversation | チャット |
| Notebook | ノートブック |
| widget | ウィジェット |
| research run, run | リサーチ, 実行 |
| runner (the local runner) | ランナー |
| agent, AI agent, backend | エージェント, AI エージェント, バックエンド |
| model | モデル |
| source (news source, feed) | 情報源, フィード |
| citation, source of a figure | 出典 |
| evidence | 根拠 |
| records (the run's records drawer) | 記録 |
| earnings announcement date | 決算発表日 |
| stock, listing, ticker | 銘柄, 上場銘柄, ティッカー |
| market data, series, indicator | 市場データ, 系列, 指標 |
| price chart | 価格チャート |
| as of | 時点 |
| unavailable (reason) | 取得できません（理由） |
| refresh / reload | 更新 / 再読み込み |
| Undo | 取り消す |
| cut / copy / paste / duplicate | 切り取り / コピー / 貼り付け / 複製 |
| Delete / Remove | 削除 |
| Try again | 再試行 |
| subscribe / unsubscribe (a source) | 購読 / 購読解除 |
| pause / resume | 一時停止 / 再開 |
| credential, token | 認証情報, トークン |
| export / import | エクスポート / インポート |
| sign-in method | サインイン方法 |
| Development (environment badge) | 開発環境 |

## Adding a language

Add its code to `LOCALES` and its endonym to `LOCALE_NAMES`; the compiler
then lists every catalog that lacks it. Register Shoelace's translation for
it in `apps/web/src/home/shoelace.ts`. If its digit grouping or decimal mark
differ from English, do the number-formatting follow-up of decision 7 first.

## Consequences

- A new UI string is written in a catalog in both languages, or the
  architecture test fails; reviewers check the Japanese reads naturally.
- English UI text is unchanged, so existing unit and E2E tests keep reading
  English; Japanese is covered by its own tests.
- The Japanese text was written by the implementing agents and checked
  against this glossary; no native-speaker review is claimed.
