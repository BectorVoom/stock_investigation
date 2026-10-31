//! RFC 9309 policy, faithfully ported from `robotsPolicy.ts` (SEC-008).
//! Wildcards match literal segments without a backtracking regular expression.
use research_js::{utf16, whitespace::trim};
use serde::{Deserialize, Serialize};

/// One normalized access rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RobotsRule {
	/// Normalized pattern, retaining `*` and terminal `$` syntax.
	pub pattern: String,
	/// Whether this rule permits access.
	pub allow: bool,
}
/// A group of user agents and their rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RobotsGroup {
	/// Lowercase user-agent values.
	pub agents: Vec<String>,
	/// Rules in source order.
	pub rules: Vec<RobotsRule>,
}
/// Parsed robots policy with the normalized crawler token.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RobotsRules {
	/// Crawler token.
	pub token: String,
	/// Groups in source order.
	pub groups: Vec<RobotsGroup>,
}
impl RobotsRules {
	/// No applicable group: all paths allowed.
	pub fn allow_all() -> Self {
		Self::default()
	}
	/// Refuse every path except `/robots.txt` itself.
	pub fn disallow_all() -> Self {
		Self {
			token: String::new(),
			groups: vec![RobotsGroup {
				agents: vec!["*".into()],
				rules: vec![RobotsRule {
					pattern: "/".into(),
					allow: false,
				}],
			}],
		}
	}
}

/// Decode unreserved escapes, uppercase other escapes, and percent-encode UTF-8.
pub fn normalize_robots_path(value: &str) -> String {
	const HEX: &[u8] = b"0123456789ABCDEF";
	let mut out = String::with_capacity(value.len());
	let mut chars = value.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '%' {
			let mut look = chars.clone();
			if let (Some(a), Some(b)) = (look.next(), look.next()) {
				if a.is_ascii_hexdigit() && b.is_ascii_hexdigit() {
					let byte = a.to_digit(16).unwrap_or(0) * 16 + b.to_digit(16).unwrap_or(0);
					let decoded = char::from_u32(byte).unwrap_or('\u{FFFD}');
					if decoded.is_ascii_alphanumeric() || "-_.~".contains(decoded) {
						out.push(decoded);
					} else {
						out.push('%');
						out.push(a.to_ascii_uppercase());
						out.push(b.to_ascii_uppercase());
					}
					chars = look;
					continue;
				}
			}
		}
		if ch.is_ascii() {
			out.push(ch);
		} else {
			let mut buffer = [0; 4];
			for byte in ch.encode_utf8(&mut buffer).bytes() {
				out.push('%');
				out.push(char::from(
					*HEX.get(usize::from(byte >> 4)).unwrap_or(&b'0'),
				));
				out.push(char::from(
					*HEX.get(usize::from(byte & 15)).unwrap_or(&b'0'),
				));
			}
		}
	}
	out
}

/// Parse the bounded prefix; a cut-off line is never interpreted as a rule.
pub fn parse_robots_txt(text: &str, user_agent_token: &str) -> RobotsRules {
	let mut parsed = RobotsRules {
		token: trim(user_agent_token).to_lowercase(),
		groups: Vec::new(),
	};
	let capped = utf16::truncate(text, 500 * 1024);
	let capped = if utf16::utf16_len(text) > 500 * 1024 {
		let Some(end) = capped.rfind('\n') else {
			return parsed;
		};
		capped.get(..end).unwrap_or("")
	} else {
		&capped
	};
	let mut agents = Vec::new();
	let mut rules = Vec::new();
	let mut in_rules = false;
	for raw in capped.split(['\r', '\n']) {
		if utf16::utf16_len(raw) > 2000 {
			continue;
		}
		let line = trim(raw.split_once('#').map_or(raw, |(head, _)| head));
		let Some((directive, value)) = line.split_once(':') else {
			continue;
		};
		let value = trim(value);
		match trim(directive).to_lowercase().as_str() {
			"user-agent" => {
				if in_rules {
					if !agents.is_empty() {
						parsed.groups.push(RobotsGroup {
							agents: std::mem::take(&mut agents),
							rules: std::mem::take(&mut rules),
						});
					}
					agents.clear();
					rules.clear();
					in_rules = false;
				}
				if !value.is_empty() {
					agents.push(value.to_lowercase());
				}
			}
			"allow" | "disallow" => {
				in_rules = true;
				if !value.is_empty() {
					rules.push(RobotsRule {
						pattern: normalize_robots_path(value),
						allow: trim(directive).eq_ignore_ascii_case("allow"),
					});
				}
			}
			_ => {}
		}
	}
	if !agents.is_empty() {
		parsed.groups.push(RobotsGroup { agents, rules });
	}
	parsed
}

fn match_pattern(pattern: &str, target: &str) -> bool {
	let (body, anchored) = pattern
		.strip_suffix('$')
		.map_or((pattern, false), |body| (body, true));
	let trailing_star = body.ends_with('*');
	let mut parts = body.split('*').peekable();
	let first = parts.next().unwrap_or("");
	if !target.starts_with(first) {
		return false;
	}
	let mut pos = first.len();
	while let Some(part) = parts.next() {
		if part.is_empty() {
			continue;
		}
		if anchored && parts.peek().is_none() {
			return target.len().checked_sub(part.len()).is_some_and(|start| {
				start >= pos
					&& target
						.get(start..)
						.is_some_and(|tail| tail.starts_with(part))
			});
		}
		let Some(found) = target.get(pos..).and_then(|tail| tail.find(part)) else {
			return false;
		};
		pos += found + part.len();
	}
	!anchored || trailing_star || pos == target.len()
}

/// Apply the longest matching rule; Allow wins ties and specific groups override `*`.
pub fn is_path_allowed(rules: &RobotsRules, path_and_query: &str) -> bool {
	let target = normalize_robots_path(
		path_and_query
			.split_once('#')
			.map_or(path_and_query, |(head, _)| head),
	);
	if target
		.split_once('?')
		.map_or(target.as_str(), |(head, _)| head)
		== "/robots.txt"
	{
		return true;
	}
	// RFC 9309 section 2.2.1 product-token match: a group names our token only
	// when a `user-agent` value equals it case-insensitively (both lower-cased
	// at parse time); `research` does not name `research-workspace`.
	let names_token = |group: &RobotsGroup| {
		group
			.agents
			.iter()
			.any(|agent| agent != "*" && !rules.token.is_empty() && rules.token == *agent)
	};
	let specific = rules.groups.iter().any(names_token);
	let mut best: Option<&RobotsRule> = None;
	for group in &rules.groups {
		if if specific {
			!names_token(group)
		} else {
			!group.agents.iter().any(|agent| agent == "*")
		} {
			continue;
		}
		for rule in &group.rules {
			if !rule.pattern.is_empty()
				&& match_pattern(&rule.pattern, &target)
				&& best.is_none_or(|old| {
					rule.pattern.len() > old.pattern.len()
						|| (rule.pattern.len() == old.pattern.len() && rule.allow)
				}) {
				best = Some(rule);
			}
		}
	}
	best.is_none_or(|rule| rule.allow)
}
