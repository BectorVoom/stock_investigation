/**
 * Shoelace integration for the Home page (FR-017).
 *
 * - Cherry-picked component modules only — never the whole library — imported
 *   from this module, which only the lazy Home code path reaches, so the other
 *   pages do not pay for Shoelace.
 * - Theme: the light stylesheet; the token mapping lives in
 *   `apps/web/src/styles.css` (primary → blue, neutral → slate,
 *   success → emerald, warning → amber, danger → red; one 0.25rem radius;
 *   no shadows; the app font; the app focus ring).
 * - Icons: Shoelace's built-in "system" library resolves to `data:` URIs that
 *   `sl-icon` then `fetch()`es, which this app's `connect-src 'self'` policy
 *   blocks. Both the "system" and the "default" libraries are registered here
 *   with a resolver returning SAME-ORIGIN URLs of real SVG files shipped in
 *   the web build (`apps/web/public/icons/`, copied from the installed
 *   `@shoelace-style/shoelace@2.20.1` package's own system icon library —
 *   `dist/chunks/chunk.3TFKS637.js`, MIT licence; Shoelace's icons are
 *   Bootstrap Icons, MIT). EVERY system icon is shipped (all 18), so every
 *   icon a used component can request resolves: `caret` (sl-button caret),
 *   `chevron-right`/`chevron-left` (every sl-menu-item renders its submenu
 *   indicator), `chevron-down` (sl-select expand icon), `x-lg` (sl-dialog
 *   close), and the rest for any other state the components can reach. Lit
 *   styles apply through adoptedStyleSheets and the popup positions itself
 *   through the CSSOM, both permitted by `style-src 'self'`; the E2E icon
 *   test proves it in all three engines.
 */
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/card/card.js";
import "@shoelace-style/shoelace/dist/components/dialog/dialog.js";
import "@shoelace-style/shoelace/dist/components/dropdown/dropdown.js";
import "@shoelace-style/shoelace/dist/components/icon/icon.js";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/menu/menu.js";
import "@shoelace-style/shoelace/dist/components/menu-item/menu-item.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/skeleton/skeleton.js";
import "@shoelace-style/shoelace/dist/themes/light.css";
import { registerIconLibrary } from "@shoelace-style/shoelace/dist/utilities/icon-library.js";

/** Every icon in the Shoelace system library; any other name 404s loudly instead of failing silently. */
export const HOME_ICON_NAMES = [
	"caret",
	"check",
	"chevron-down",
	"chevron-left",
	"chevron-right",
	"copy",
	"eye",
	"eye-slash",
	"eyedropper",
	"grip-vertical",
	"indeterminate",
	"person-fill",
	"play-fill",
	"pause-fill",
	"radio",
	"star-fill",
	"x-lg",
	"x-circle-fill",
] as const;

let iconsRegistered = false;

/**
 * Points the "system" and "default" icon libraries at same-origin SVG files
 * so no `data:` fetch ever hits `connect-src`. Idempotent; safe to call on
 * every Home visit.
 */
export function ensureHomeIconLibraries(): void {
	if (iconsRegistered) return;
	iconsRegistered = true;
	const resolver = (name: string): string => `/icons/${name}.svg`;
	registerIconLibrary("system", { resolver });
	registerIconLibrary("default", { resolver });
}
