/**
 * Classifies a literal IP address for SSRF defence (SEC-002). Anything that is
 * not plainly globally routable unicast is treated as non-public; unparseable
 * input is "invalid" and must be rejected by callers (fail closed).
 */
export type IpClass = "public" | "non-public" | "invalid";

function parseIpv4(text: string): readonly number[] | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		// Reject octal/hex/empty forms so "0177.0.0.1" cannot alias 127.0.0.1.
		if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		octets.push(octet);
	}
	return octets;
}

function isPublicIpv4(octets: readonly number[]): boolean {
	const [a = 0, b = 0, c = 0] = octets;
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
	if (a === 169 && b === 254) return false; // link-local, cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
	if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
	if (a >= 224) return false; // multicast, reserved, broadcast
	return true;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when malformed. */
function parseIpv6(text: string): readonly number[] | null {
	let source = text;
	const zoneIndex = source.indexOf("%");
	if (zoneIndex !== -1) source = source.slice(0, zoneIndex);
	if (source === "" || !/^[0-9a-fA-F:.]+$/.test(source)) return null;

	// An embedded dotted-quad tail occupies the last two groups.
	let tail: readonly number[] = [];
	const lastColon = source.lastIndexOf(":");
	const maybeIpv4 = source.slice(lastColon + 1);
	if (maybeIpv4.includes(".")) {
		const octets = parseIpv4(maybeIpv4);
		if (octets === null) return null;
		const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = octets;
		tail = [(o0 << 8) | o1, (o2 << 8) | o3];
		source = `${source.slice(0, lastColon + 1)}0:0`;
	}

	const halves = source.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (part: string): readonly number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const group of part.split(":")) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};
	const head = parseGroups(halves[0] ?? "");
	const rest = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
	if (head === null || rest === null) return null;
	let groups: number[];
	if (halves.length === 2) {
		const missing = 8 - head.length - rest.length;
		if (missing < 1) return null;
		groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
	} else {
		groups = [...head];
	}
	if (groups.length !== 8) return null;
	if (tail.length === 2) {
		groups[6] = tail[0] ?? 0;
		groups[7] = tail[1] ?? 0;
	}
	return groups;
}

function embeddedIpv4(high: number, low: number): readonly number[] {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIpv6(groups: readonly number[]): boolean {
	const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
	const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	// ::/96 holds unspecified, loopback and the deprecated IPv4-compatible form: never a real destination.
	if (upperZero && g5 === 0) return false;
	// IPv4-mapped ::ffff:a.b.c.d is judged by the IPv4 address it carries.
	if (upperZero && g5 === 0xffff) return isPublicIpv4(embeddedIpv4(g6, g7));
	// NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 destination.
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPublicIpv4(embeddedIpv4(g6, g7));
	}
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return false; // local-use NAT64 64:ff9b:1::/48
	// 6to4 2002::/16 embeds an IPv4 destination in the next 32 bits.
	if (g0 === 0x2002) return isPublicIpv4(embeddedIpv4(g1, g2));
	if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
	if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation 3fff::/20 (RFC 9637)
	if (g0 === 0x2001 && g1 < 0x200) return false; // IETF protocol assignments incl. Teredo
	// Only 2000::/3 is global unicast; this excludes ULA, link-local, multicast and reserved space.
	return (g0 & 0xe000) === 0x2000;
}

export function classifyIpAddress(address: string): IpClass {
	const text = address.trim();
	if (text.includes(":")) {
		const groups = parseIpv6(text);
		if (groups === null) return "invalid";
		return isPublicIpv6(groups) ? "public" : "non-public";
	}
	const octets = parseIpv4(text);
	if (octets === null) return "invalid";
	return isPublicIpv4(octets) ? "public" : "non-public";
}

/** True for anything shaped like an IP literal, including bracketed IPv6 and numeric hosts. */
export function looksLikeIpLiteral(hostname: string): boolean {
	if (hostname.startsWith("[") || hostname.includes(":")) return true;
	// Purely numeric/dotted or hex hosts ("2130706433", "0x7f.1") can be read as IPv4 by resolvers.
	return /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*\.?$/i.test(hostname);
}
