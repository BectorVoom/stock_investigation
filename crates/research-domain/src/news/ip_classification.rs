//! Port of `packages/domain/src/news/ipClassification.ts`.
//!
//! Classifies a literal IP address for SSRF defence (SEC-002). Anything that
//! is not plainly globally routable unicast is treated as non-public;
//! unparseable input is "invalid" and must be rejected by callers (fail
//! closed).

use research_js::whitespace;

/// The verdict on one address literal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpClass {
	/// Globally routable unicast.
	Public,
	/// Private, loopback, link-local, documentation, multicast, reserved…
	NonPublic,
	/// Not an IP literal this classifier accepts.
	Invalid,
}

impl IpClass {
	/// The TypeScript literal: `"public"`, `"non-public"` or `"invalid"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Public => "public",
			Self::NonPublic => "non-public",
			Self::Invalid => "invalid",
		}
	}
}

/// Dotted-quad IPv4 with decimal octets only.
fn parse_ipv4(text: &str) -> Option<[u8; 4]> {
	let mut octets = [0u8; 4];
	let mut parts = text.split('.');
	for slot in &mut octets {
		let part = parts.next()?;
		// Reject octal/hex/empty forms so "0177.0.0.1" cannot alias 127.0.0.1
		// (`/^(0|[1-9]\d{0,2})$/`, ASCII digits).
		let bytes = part.as_bytes();
		let well_formed = match bytes {
			[b'0'] => true,
			[first, rest @ ..] => {
				(b'1'..=b'9').contains(first)
					&& rest.len() <= 2
					&& rest.iter().all(u8::is_ascii_digit)
			}
			[] => false,
		};
		if !well_formed {
			return None;
		}
		*slot = part.parse::<u8>().ok()?;
	}
	if parts.next().is_some() {
		return None;
	}
	Some(octets)
}

fn is_public_ipv4([a, b, c, _]: [u8; 4]) -> bool {
	if a == 0 || a == 10 || a == 127 {
		return false;
	}
	if a == 100 && (64..=127).contains(&b) {
		return false; // CGNAT 100.64/10
	}
	if a == 169 && b == 254 {
		return false; // link-local, cloud metadata
	}
	if a == 172 && (16..=31).contains(&b) {
		return false;
	}
	if a == 192 && b == 168 {
		return false;
	}
	if a == 192 && b == 0 && (c == 0 || c == 2) {
		return false; // IETF protocol, TEST-NET-1
	}
	if a == 192 && b == 88 && c == 99 {
		return false; // 6to4 relay anycast
	}
	if a == 198 && (b == 18 || b == 19) {
		return false; // benchmarking
	}
	if a == 198 && b == 51 && c == 100 {
		return false; // TEST-NET-2
	}
	if a == 203 && b == 0 && c == 113 {
		return false; // TEST-NET-3
	}
	a < 224 // multicast, reserved, broadcast
}

/// Groups of one side of `::`, each 1–4 hex digits.
fn parse_groups(part: &str, groups: &mut Vec<u16>) -> Option<()> {
	if part.is_empty() {
		return Some(());
	}
	for group in part.split(':') {
		if group.is_empty()
			|| group.len() > 4
			|| !group.bytes().all(|byte| byte.is_ascii_hexdigit())
		{
			return None;
		}
		groups.push(u16::from_str_radix(group, 16).ok()?);
	}
	Some(())
}

/// Expands an IPv6 literal to eight 16-bit groups, or `None` when malformed.
fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
	let source = text
		.split_once('%')
		.map_or(text, |(address, _zone)| address);
	if source.is_empty()
		|| !source
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() || byte == b':' || byte == b'.')
	{
		return None;
	}
	// An embedded dotted-quad tail occupies the last two groups.
	let mut tail: Option<[u16; 2]> = None;
	let after_last_colon = source.rfind(':').map_or(0, |index| index + 1);
	let maybe_ipv4 = source.get(after_last_colon..).unwrap_or("");
	let rewritten;
	let source = if maybe_ipv4.contains('.') {
		let [o0, o1, o2, o3] = parse_ipv4(maybe_ipv4)?;
		tail = Some([
			u16::from(o0) << 8 | u16::from(o1),
			u16::from(o2) << 8 | u16::from(o3),
		]);
		rewritten = format!("{}0:0", source.get(..after_last_colon).unwrap_or(""));
		rewritten.as_str()
	} else {
		source
	};
	let halves: Vec<&str> = source.split("::").collect();
	if halves.len() > 2 {
		return None;
	}
	let mut head = Vec::with_capacity(8);
	parse_groups(halves.first().copied().unwrap_or(""), &mut head)?;
	let mut rest = Vec::with_capacity(8);
	if let Some(second) = halves.get(1) {
		parse_groups(second, &mut rest)?;
	}
	let mut groups = head;
	if halves.len() == 2 {
		let missing = 8usize.checked_sub(groups.len() + rest.len())?;
		if missing < 1 {
			return None;
		}
		groups.resize(groups.len() + missing, 0);
		groups.extend(rest);
	}
	let mut groups: [u16; 8] = groups.try_into().ok()?;
	if let Some([high, low]) = tail {
		groups[6] = high;
		groups[7] = low;
	}
	Some(groups)
}

fn embedded_ipv4(high: u16, low: u16) -> [u8; 4] {
	let [h0, h1] = high.to_be_bytes();
	let [l0, l1] = low.to_be_bytes();
	[h0, h1, l0, l1]
}

fn is_public_ipv6([g0, g1, g2, g3, g4, g5, g6, g7]: [u16; 8]) -> bool {
	let upper_zero = g0 == 0 && g1 == 0 && g2 == 0 && g3 == 0 && g4 == 0;
	// ::/96 holds unspecified, loopback and the deprecated IPv4-compatible form: never a real destination.
	if upper_zero && g5 == 0 {
		return false;
	}
	// IPv4-mapped ::ffff:a.b.c.d is judged by the IPv4 address it carries.
	if upper_zero && g5 == 0xffff {
		return is_public_ipv4(embedded_ipv4(g6, g7));
	}
	// NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 destination.
	if g0 == 0x64 && g1 == 0xff9b && g2 == 0 && g3 == 0 && g4 == 0 && g5 == 0 {
		return is_public_ipv4(embedded_ipv4(g6, g7));
	}
	if g0 == 0x64 && g1 == 0xff9b && g2 == 1 {
		return false; // local-use NAT64 64:ff9b:1::/48
	}
	// 6to4 2002::/16 embeds an IPv4 destination in the next 32 bits.
	if g0 == 0x2002 {
		return is_public_ipv4(embedded_ipv4(g1, g2));
	}
	if g0 == 0x2001 && g1 == 0xdb8 {
		return false; // documentation
	}
	if g0 == 0x3fff && g1 < 0x1000 {
		return false; // documentation 3fff::/20 (RFC 9637)
	}
	if g0 == 0x2001 && g1 < 0x200 {
		return false; // IETF protocol assignments incl. Teredo
	}
	// Only 2000::/3 is global unicast; this excludes ULA, link-local, multicast and reserved space.
	(g0 & 0xe000) == 0x2000
}

/// `classifyIpAddress`: the class of an address literal (surrounding JS
/// whitespace is ignored).
#[must_use]
pub fn classify_ip_address(address: &str) -> IpClass {
	let text = whitespace::trim(address);
	let public = if text.contains(':') {
		parse_ipv6(text).map(is_public_ipv6)
	} else {
		parse_ipv4(text).map(is_public_ipv4)
	};
	match public {
		None => IpClass::Invalid,
		Some(true) => IpClass::Public,
		Some(false) => IpClass::NonPublic,
	}
}

/// `0x…` (hex, case-insensitive) or decimal digits — one label of a numeric host.
fn is_numeric_label(label: &str) -> bool {
	let bytes = label.as_bytes();
	match bytes {
		[b'0', b'x' | b'X', hex @ ..] if !hex.is_empty() => hex.iter().all(u8::is_ascii_hexdigit),
		[] => false,
		digits => digits.iter().all(u8::is_ascii_digit),
	}
}

/// `looksLikeIpLiteral`: true for anything shaped like an IP literal,
/// including bracketed IPv6 and numeric hosts.
#[must_use]
pub fn looks_like_ip_literal(hostname: &str) -> bool {
	if hostname.starts_with('[') || hostname.contains(':') {
		return true;
	}
	// Purely numeric/dotted or hex hosts ("2130706433", "0x7f.1") can be read as IPv4 by resolvers:
	// /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*\.?$/i
	let body = hostname.strip_suffix('.').unwrap_or(hostname);
	!body.is_empty() && body.split('.').all(is_numeric_label)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn classifies_like_the_typescript() {
		assert_eq!(classify_ip_address("8.8.8.8"), IpClass::Public);
		assert_eq!(classify_ip_address(" 10.0.0.1 "), IpClass::NonPublic);
		assert_eq!(classify_ip_address("0177.0.0.1"), IpClass::Invalid);
		assert_eq!(classify_ip_address("::ffff:127.0.0.1"), IpClass::NonPublic);
		assert_eq!(classify_ip_address("2606:4700::1111"), IpClass::Public);
		assert_eq!(classify_ip_address("fe80::1%en0"), IpClass::NonPublic);
		assert_eq!(classify_ip_address("1:2:3:4:5:6:7::8"), IpClass::Invalid);
		assert!(looks_like_ip_literal("0x7f.1"));
		assert!(looks_like_ip_literal("2130706433."));
		assert!(!looks_like_ip_literal("example.com"));
		assert!(!looks_like_ip_literal("1..2"));
	}
}
