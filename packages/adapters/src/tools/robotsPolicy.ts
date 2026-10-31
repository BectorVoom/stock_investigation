/**
 * robots.txt policy (RFC 9309) for the research runner (a building block, not
 * a tool). Decides whether a path on an already-allowed host may be fetched.
 *
 * Matching is a linear-time loop over the pattern's literal segments, never
 * a backtracking regular expression built from the file: a hostile
 * robots.txt must not be able to stall the runner (SEC-008 bounds payloads;
 * this bounds the matching itself).
 */

export interface RobotsRule {
	readonly pattern: string;
	readonly allow: boolean;
}

export interface RobotsGroup {
	/** Lower-cased `user-agent` values as written (`*` for the wildcard group). */
	readonly agents: readonly string[];
	readonly rules: readonly RobotsRule[];
}

/** Opaque parsed form: the normalized crawler token travels with the groups. */
export interface RobotsRules {
	readonly token: string;
	readonly groups: readonly RobotsGroup[];
}

/** No group matches this token, so everything is allowed (RFC 9309 section 2.2.2). */
export const ALLOW_ALL: RobotsRules = { token: "", groups: [] };

/** Everything is disallowed except `/robots.txt` itself, which is always allowed. */
export const DISALLOW_ALL: RobotsRules = {
	token: "",
	groups: [{ agents: ["*"], rules: [{ pattern: "/", allow: false }] }],
};

/** Anything past this prefix of the input is ignored (SEC-008). */
const MAX_ROBOTS_CHARS = 500 * 1024;
/** Lines longer than this are ignored. */
const MAX_LINE_CHARS = 2_000;

/** Unreserved characters per RFC 3986 section 2.3 (RFC 9309 section 2.2.2 compares after decoding these). */
function isUnreservedChar(char: string): boolean {
	return (
		(char >= "A" && char <= "Z") ||
		(char >= "a" && char <= "z") ||
		(char >= "0" && char <= "9") ||
		char === "-" ||
		char === "_" ||
		char === "." ||
		char === "~"
	);
}

function isHexDigit(char: string): boolean {
	return (
		(char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F")
	);
}

const utf8Encoder = new TextEncoder();

/**
 * Normalises a robots path (rule pattern or match target) per RFC 9309 section
 * 2.2.2: percent-encoded unreserved characters are decoded, all other octets
 * stay percent-encoded in upper-case form, and non-ASCII characters are
 * compared as UTF-8 percent-encoded. `*` and `$` are matching syntax, not
 * path characters, and pass through unchanged. Terminates: one pass over the
 * input, the index advances by at least one UTF-16 unit per iteration.
 */
export function normalizeRobotsPath(value: string): string {
	let out = "";
	let index = 0;
	while (index < value.length) {
		const char = value[index];
		if (
			char === "%" &&
			index + 2 < value.length &&
			isHexDigit(value[index + 1] ?? "") &&
			isHexDigit(value[index + 2] ?? "")
		) {
			const hex = value.slice(index + 1, index + 3);
			const byte = Number.parseInt(hex, 16);
			const decoded = String.fromCharCode(byte);
			// Terminates: fixed 3-character consumption per escape.
			if (decoded.length === 1 && isUnreservedChar(decoded)) out += decoded;
			else out += `%${hex.toUpperCase()}`;
			index += 3;
			continue;
		}
		const code = value.codePointAt(index) ?? 0;
		if (code > 127) {
			const text = String.fromCodePoint(code);
			for (const byte of utf8Encoder.encode(text)) {
				out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
			}
			index += text.length;
			continue;
		}
		out += char ?? "";
		index += 1;
	}
	return out;
}

function normalizeToken(userAgentToken: string): string {
	return typeof userAgentToken === "string" ? userAgentToken.trim().toLowerCase() : "";
}

export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRules {
	const token = normalizeToken(userAgentToken);
	try {
		if (typeof text !== "string" || text === "") return { token, groups: [] };
		let capped = text.length > MAX_ROBOTS_CHARS ? text.slice(0, MAX_ROBOTS_CHARS) : text;
		if (capped.length < text.length) {
			// Never parse a rule cut off mid-line; the cut-back line is simply lost.
			const newline = capped.lastIndexOf("\n");
			if (newline === -1) return { token, groups: [] };
			capped = capped.slice(0, newline);
		}
		const groups: RobotsGroup[] = [];
		let agents: string[] = [];
		let rules: RobotsRule[] = [];
		let inRules = false;
		for (const rawLine of capped.split(/\r\n|[\n\r]/)) {
			if (rawLine.length > MAX_LINE_CHARS) continue;
			const hash = rawLine.indexOf("#");
			const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
			if (line === "") continue;
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			const directive = line.slice(0, colon).trim().toLowerCase();
			const value = line.slice(colon + 1).trim();
			if (directive === "user-agent") {
				if (inRules) {
					// The previous group is complete; orphan rules (no agent) are discarded.
					if (agents.length > 0) groups.push({ agents, rules });
					agents = [];
					rules = [];
					inRules = false;
				}
				if (value !== "") agents.push(value.toLowerCase());
			} else if (directive === "allow" || directive === "disallow") {
				inRules = true;
				if (value !== "") {
					// Normalised once at parse time so matching stays a plain string
					// comparison (RFC 9309 section 2.2.2); `*`/`$` syntax survives.
					rules.push({ pattern: normalizeRobotsPath(value), allow: directive === "allow" });
				}
			}
			// Anything else (`sitemap`, crawler-delay, unknown fields) carries no access rule.
		}
		if (agents.length > 0) groups.push({ agents, rules });
		return { token, groups };
	} catch {
		// Total function: string operations above do not throw in practice;
		// an unparseable file carries no usable group, which `isPathAllowed`
		// treats as allow-all. Callers that need fail-closed use DISALLOW_ALL.
		return { token, groups: [] };
	}
}

/**
 * Linear-time wildcard match for one rule pattern: `*` matches any run of
 * characters, a trailing `$` anchors the end. Splitting on `*` turns the
 * pattern into literal segments matched left to right with `indexOf`, so a
 * pathological pattern such as `/a*a*a*a*a*a*a*a*b` costs one scan per
 * segment instead of exponential backtracking.
 */
function matchPattern(pattern: string, target: string): boolean {
	let anchored = false;
	let body = pattern;
	if (body.endsWith("$")) {
		anchored = true;
		body = body.slice(0, -1);
	}
	const trailingStar = body.endsWith("*");
	const parts = body.split("*");
	const first = parts[0] ?? "";
	if (!target.startsWith(first)) return false;
	let pos = first.length;
	const lastIndex = parts.length - 1;
	for (let i = 1; i < parts.length; i += 1) {
		const part = parts[i] ?? "";
		if (part === "") continue;
		if (anchored && i === lastIndex) {
			const start = target.length - part.length;
			if (start < pos) return false;
			return target.startsWith(part, start);
		}
		const found = target.indexOf(part, pos);
		if (found === -1) return false;
		pos = found + part.length;
	}
	if (anchored) {
		// A trailing `*` already consumed the rest; otherwise the match must reach the end.
		if (trailingStar) return true;
		return pos === target.length;
	}
	return true;
}

/**
 * Rules of the group that names our token win over the `*` group; same-token
 * groups merge. A group names our token only when its `user-agent` value
 * equals the token, case-insensitively (RFC 9309 section 2.2.1 product-token
 * match; both sides are lower-cased at parse time): `research` or `r` does not
 * name `research-workspace`.
 */
function applicableRules(rules: RobotsRules): readonly RobotsRule[] {
	const specific: RobotsRule[] = [];
	const wildcard: RobotsRule[] = [];
	// Whether a group naming our token matched at all — an empty matching group
	// means "no restrictions", not "fall back to the wildcard" (RFC 9309 2.2.2).
	let specificGroupMatched = false;
	for (const group of rules.groups) {
		let namesToken = false;
		let isWildcard = false;
		for (const agent of group.agents) {
			if (agent === "*") isWildcard = true;
			else if (rules.token !== "" && rules.token === agent) {
				namesToken = true;
			}
		}
		if (namesToken) {
			specificGroupMatched = true;
			specific.push(...group.rules);
		} else if (isWildcard) wildcard.push(...group.rules);
	}
	return specificGroupMatched ? specific : wildcard;
}

export function isPathAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
	try {
		if (typeof pathAndQuery !== "string") return false;
		const hash = pathAndQuery.indexOf("#");
		const rawTarget = hash === -1 ? pathAndQuery : pathAndQuery.slice(0, hash);
		// Targets are normalised like rules (RFC 9309 section 2.2.2); one pass, terminates.
		const target = normalizeRobotsPath(rawTarget);
		const query = target.indexOf("?");
		const pathname = query === -1 ? target : target.slice(0, query);
		// `/robots.txt` itself is always allowed (RFC 9309 section 2.3).
		if (pathname === "/robots.txt") return true;
		// The longest matching rule wins; `Allow` wins a tie (RFC 9309 section 2.2.2).
		let best: RobotsRule | null = null;
		for (const rule of applicableRules(rules)) {
			if (rule.pattern === "" || !matchPattern(rule.pattern, target)) continue;
			if (
				best === null ||
				rule.pattern.length > best.pattern.length ||
				(rule.pattern.length === best.pattern.length && rule.allow)
			) {
				best = rule;
			}
		}
		return best === null ? true : best.allow;
	} catch {
		// Fail closed: a path that cannot be matched is not fetched.
		return false;
	}
}
