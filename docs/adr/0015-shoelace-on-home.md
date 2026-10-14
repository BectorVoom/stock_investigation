# ADR-0015: Shoelace for the Home widgets

**Status:** Accepted · **Date:** 2026-10-13

## Context

The owner asked for the Home page widgets and tables in
shoelace-style/shoelace, while the rest of the app uses its own hand-built
components (`apps/web/src/components/ui.tsx`, `docs/DESIGN_GUIDELINE.md`).
A third-party kit on one page risks three things this repo treats as gates:
bundle cost on the other pages, look-and-feel drift, and the
Content-Security-Policy (`style-src 'self'`, `connect-src 'self'`, no inline
script/style), which is never relaxed. Shoelace also has no table component,
so tables were always going to stay native.

## Decision

**`@shoelace-style/shoelace` (npm, version 2.20.1, bundled — no CDN) on the
Home page only.** Only the used component modules are imported, from one
module (`apps/web/src/home/shoelace.ts`) that only the lazy Home code path
reaches:

`sl-dialog` (add/edit widget, reset confirmation), `sl-select` + `sl-option`,
`sl-input`, `sl-skeleton`, `sl-icon` — plus the light theme stylesheet and
the `icon-library` utility. Widget frames, menus and buttons are native
elements in the app style since ADR-0017 (`sl-card`, `sl-button`,
`sl-dropdown`, `sl-menu`, `sl-menu-item` were removed from the imported set).
No other component is imported; adding one is an edit to that module.

**Lazy loading, measured.** `App.tsx` loads the Home view through Solid's
`lazy()`, so the other pages never download or parse the kit. Production
build on 2026-10-13: the Home chunk `HomeView-*.js` is **187.75 kB
(52.17 kB gzip)** plus `HomeView-*.css` **14.96 kB**, beside the main
`index-*.js` 369.62 kB (108.05 kB gzip). (Before ADR-0017 the chunk was
230.35 kB / 60.09 kB gzip: dropping the card/button/menu modules saved
~43 kB.) The chunk is paid once, on the first visit to `#/home`; file hashes drift per build, sizes should be re-measured
if the kit version or the imported set changes.

**Token mapping** (`apps/web/src/styles.css`, on `html:root` so it wins over
the lazily loaded Shoelace stylesheet): primary → the Tailwind blue scale,
neutral → slate, success → emerald, warning → amber, danger → red (the
app's own theme variables, no invented hex); one corner radius (`0.25rem`
for every `--sl-border-radius-*`); no shadows (`--sl-shadow-*: none`,
borders instead); the app font; `--sl-focus-ring-*` matching the existing
`:focus-visible` rule. A Shoelace form control looks like its existing
counterpart (`INPUT`, `LABEL`); Home controls carry their own
`label` prop instead of the app's `Field`.

**CSP analysis (policy unchanged).** No CDN and no remote `setBasePath`.
Shoelace's built-in "system" icon library resolves to `data:` URIs that
`sl-icon` then `fetch()`es, which `connect-src 'self'` blocks — so both the
`system` and the `default` libraries are registered with a resolver
returning same-origin URLs to real SVG files shipped in the web build
(`apps/web/public/icons/`, copied from the installed Shoelace package's own
system icon library, MIT — Shoelace's icons are Bootstrap Icons). **All 18
system icons are shipped** (`caret`, `check`, `chevron-down`,
`chevron-left`, `chevron-right`, `copy`, `eye`, `eye-slash`, `eyedropper`,
`grip-vertical`, `indeterminate`, `person-fill`, `play-fill`, `pause-fill`,
`radio`, `star-fill`, `x-lg`, `x-circle-fill`), so every icon a used
component can request resolves (`chevron-down` for the select expand icon,
`x-lg` for the dialog close; `caret` and the menu-item submenu chevrons
belonged to the button/menu modules removed in ADR-0017, whose files still
ship). Lit styles apply through adoptedStyleSheets and the popup
positions itself through the CSSOM, both permitted by `style-src 'self'`.
The E2E CSP test visits Home, opens the add-widget dialog, a select and a
widget menu, and asserts no violation; the icon test asserts every
`/icons/*.svg` answers 200 as SVG with no icon-less `sl-icon`.

**Tables stay semantic `<table>`s** (caption, scopes, row header = series)
inside the `sl-card`, in one class set consistent with `DatasetTable`;
charts stay the registry SVG primitives (`ChartFrame`, `ChartLegend`,
palette, scales, ticks) with a native data-table twin. Solid typing comes
from a module augmentation of `JSX.IntrinsicElements`
(`apps/web/src/home/sl-elements.d.ts`, no `any`); Shoelace events arrive via
`on:sl-…`. Happy-dom tests import the same modules and assert on light-DOM
content and roles, never on shadow internals.

**App-wide zod `jitless` (`apps/web/src/zodJitless.ts`).** Zod probes
`new Function` once, at schema-creation time, to decide whether JIT-compiled
parsers are available. The probe is caught, but strict engines (Firefox)
report the blocked eval as a Content-Security-Policy console error on every
page load — failing the CSP test before Shoelace is even involved. The very
first module the SPA entry evaluates (imported first in `main.tsx`, before
any schema exists) therefore calls `config({ jitless: true })`: no eval is
ever attempted. Scoped to the SPA entry — the Worker and Node paths keep
their own configuration and their bench numbers. The cost is slower schema
parsing in the browser; the SPA validates small payloads (dashboard JSON,
≤30 series) and never needs JIT parsing.

## Consequences

- One page carries a UI kit; the other four never load it. The kit version is
  pinned in `apps/web/package.json` (lockfile committed); upgrading means
  re-copying any changed system icons and re-running the CSP/icon tests in
  all three engines.
- The "Home surface" section of `docs/DESIGN_GUIDELINE.md` is normative for
  the token mapping and the grid; the components table lists the Shoelace
  rows. `tests/architecture/designGuideline.test.ts` keeps passing without a
  loosened rule.
- Safari/WebKit behaviour of the Home page is unverified (open item): the
  scripted review and the E2E suite did not run on WebKit in this session
  (see `docs/REQUIREMENTS_STATUS.md`).

## Alternatives considered (deliberately not done)

- **Hand-built Home components in the app style.** Rejected: the owner
  explicitly asked for Shoelace, and the kit's dialog/menu/select behaviour
  (focus handling, keyboard support, popup positioning) is the part worth
  borrowing.
- **Importing the whole Shoelace library.** Rejected: every page would pay
  for components Home never uses. Cherry-picking keeps the lazy chunk to the
  measured ~188 kB (was ~230 kB before ADR-0017 removed the card, button and
  menu modules).
- **CDN with `setBasePath`.** Rejected: a third-party origin in `script-src`
  / `style-src` / `connect-src` contradicts the threat model (T9) and makes
  offline-local operation depend on the network.
- **Relaxing the CSP for one page.** Rejected outright: the policy is a
  release gate. If a Shoelace component cannot work under it, that component
  is replaced by a native element styled the app's way — none has needed it
  so far.

## Rollback

- Per-component: replace the failing `sl-*` tag with a native element in the
  app style (the stated policy); the icon libraries, theme import and chunk
  stay for the rest.
- Whole kit: every Shoelace import enters through `home/shoelace.ts` and the
  lazy `HomeView`, so removal is deleting that module, the `sl-*` usages, the
  token block in `styles.css` and `apps/web/public/icons/` — no other page
  imports the package. Downgrading `@shoelace-style/shoelace` out of
  `apps/web/package.json` plus the lockfile entry completes it.
