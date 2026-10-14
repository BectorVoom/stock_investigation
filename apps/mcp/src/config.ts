/**
 * Pure parsing of the MCP server's settings (ADR-0019): the API origin comes
 * from `--api <origin>` or `RESEARCH_API_URL`, defaulting to production
 * (`http://127.0.0.1:8787`). Loopback `http:` origins only — anything else is
 * a startup error (fail closed, ADR-0006: a local process is the owner only
 * over loopback). No process access here; `main.ts` supplies argv and env.
 */

export const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";
export const DEV_API_ORIGIN = "http://127.0.0.1:8788";

const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export const HOME_MCP_HELP = `research-home-widgets: arrange the Home dashboard widgets through the owner API.

Usage:
  bun apps/mcp/src/main.ts [--api <origin>]

Options:
  --api <origin>   Workspace API origin (default ${DEFAULT_API_ORIGIN}, or RESEARCH_API_URL).
                   Loopback http: only: localhost, 127.0.0.1 or [::1].
                   Use ${DEV_API_ORIGIN} for development (bun run dev).
  --help, -h       Print this help.

The server speaks MCP over newline-delimited JSON on stdin/stdout. Connect it
from OpenCode with: opencode mcp add home-widgets -- bun <repo>/apps/mcp/src/main.ts --api <origin>`;

export interface HomeMcpConfig {
	readonly apiOrigin: string;
	/** `--help` was passed: print `HOME_MCP_HELP` and exit 0 without starting. */
	readonly help: boolean;
}

export type ParseHomeMcpConfig =
	| { readonly ok: true; readonly value: HomeMcpConfig }
	| { readonly ok: false; readonly error: string };

function checkOrigin(raw: string): ParseHomeMcpConfig {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return {
			ok: false,
			error: `"${raw}" is not a URL; pass an origin like ${DEFAULT_API_ORIGIN}.`,
		};
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.includes(url.hostname)) {
		return {
			ok: false,
			error: `refusing API origin "${raw}": only loopback http: origins are allowed (localhost, 127.0.0.1, [::1]).`,
		};
	}
	return { ok: true, value: { apiOrigin: url.origin, help: false } };
}

export function parseHomeMcpConfig(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): ParseHomeMcpConfig {
	let flagOrigin: string | null = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			return { ok: true, value: { apiOrigin: DEFAULT_API_ORIGIN, help: true } };
		}
		if (arg === "--api") {
			const value = argv[index + 1];
			if (value === undefined || value === "") {
				return { ok: false, error: `--api needs an origin, e.g. --api ${DEFAULT_API_ORIGIN}.` };
			}
			flagOrigin = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--api=")) {
			const value = arg.slice("--api=".length);
			if (value === "") {
				return { ok: false, error: `--api needs an origin, e.g. --api=${DEFAULT_API_ORIGIN}.` };
			}
			flagOrigin = value;
			continue;
		}
		if (arg.startsWith("-")) {
			return { ok: false, error: `unknown option "${arg}"; see --help.` };
		}
		return { ok: false, error: `unexpected argument "${arg}"; see --help.` };
	}
	const raw = flagOrigin ?? env.RESEARCH_API_URL ?? DEFAULT_API_ORIGIN;
	return checkOrigin(raw);
}
