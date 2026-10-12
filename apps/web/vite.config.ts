import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Port of the development API the dev server proxies to. Read defensively:
 * an unparseable value falls back to the production default rather than
 * proxying somewhere unexpected.
 */
function devApiPort(): number {
	const parsed = Number(process.env.RESEARCH_DEV_API_PORT ?? "8787");
	return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535 ? parsed : 8787;
}

/**
 * Defence in depth for hosts that might not apply `public/_headers`: the built
 * index.html also carries the policy as a <meta>. The header file stays the
 * single source of truth, so the two cannot drift. Build-only, because the Vite
 * dev server injects inline <style> elements that `style-src 'self'` forbids.
 */
function cspMetaFromHeadersFile(): Plugin {
	return {
		name: "csp-meta-from-headers-file",
		apply: "build",
		transformIndexHtml() {
			const headers = readFileSync(new URL("./public/_headers", import.meta.url), "utf8");
			const policy = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1];
			if (policy === undefined) {
				throw new Error("apps/web/public/_headers must define a Content-Security-Policy");
			}
			const content = policy
				.split(";")
				.map((directive) => directive.trim())
				// Browsers ignore frame-ancestors in a <meta> policy (and warn); the header enforces it.
				.filter((directive) => directive !== "" && !directive.startsWith("frame-ancestors"))
				.join("; ");
			return [
				{
					tag: "meta",
					attrs: { "http-equiv": "Content-Security-Policy", content },
					injectTo: "head-prepend",
				},
			];
		},
	};
}

/**
 * Invoked from the repo root (`vite --config apps/web/vite.config.ts`), so the
 * root is pinned to this directory instead of relying on the working directory.
 *
 * Two launcher settings (ADR-0011) arrive as environment variables:
 * `RESEARCH_DEV_API_PORT` is the development API the dev server proxies `/api`
 * to (`bun run dev` sets it; default 8787 keeps `vite` usable by hand), and
 * `RESEARCH_WEB_OUT_DIR` overrides the build output directory (`bun run
 * prod:build` sets it to the release directory; default `dist/web`).
 */
export default defineConfig({
	root: webRoot,
	plugins: [solid(), tailwindcss(), cspMetaFromHeadersFile()],
	build: {
		outDir:
			process.env.RESEARCH_WEB_OUT_DIR ?? fileURLToPath(new URL("../../dist/web", import.meta.url)),
		emptyOutDir: true,
		// Supported-browsers floor (README "Supported browsers"): the lowest
		// versions the app supports — the floor Tailwind CSS v4 itself
		// requires (Chrome 111 / Edge 111, Firefox 128, Safari 16.4). Pinned
		// explicitly so the bundler downlevels or rejects syntax this floor
		// cannot run, instead of silently shipping it.
		target: ["chrome111", "edge111", "firefox128", "safari16.4"],
		// No inlined assets: every script and style is a same-origin file (CSP `'self'` only).
		assetsInlineLimit: 0,
		modulePreload: { polyfill: false },
	},
	server: {
		proxy: {
			"/api": { target: `http://127.0.0.1:${devApiPort()}`, changeOrigin: false },
		},
	},
});
