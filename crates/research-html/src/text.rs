//! The converter's string helpers, each equal to the TypeScript expression
//! named in its doc comment. Whitespace is JavaScript's `\s` (it includes
//! U+FEFF and excludes U+0085) via `research_js::whitespace`; the regexes are
//! hand-written scans because they are ASCII-flavoured (`\d`, `/i` without
//! the `u` flag) and run on every block.

use research_js::whitespace::{is_js_whitespace, trim};

/// Pushes `line` collapsed and trimmed (`collapseWhitespace(line).trim()` for
/// a line without `\n`). Returns false when nothing was pushed.
fn push_line_collapsed_trimmed(out: &mut String, line: &str) -> bool {
	let mut wrote = false;
	let mut pending_space = false;
	for character in line.chars() {
		if is_js_whitespace(character) {
			pending_space = wrote;
		} else {
			if pending_space {
				out.push(' ');
				pending_space = false;
			}
			out.push(character);
			wrote = true;
		}
	}
	wrote
}

/// `finalizeBlockLines`: collapse whitespace except newlines, trim every
/// line, drop leading and trailing blank lines, keep at most one blank line
/// in a row.
pub(crate) fn finalize_block_lines(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut kept_any = false;
	// A blank line after a kept line; written only if a non-blank line follows.
	let mut pending_blank = false;
	for line in text.split('\n') {
		let mark = out.len();
		if kept_any {
			out.push('\n');
			if pending_blank {
				out.push('\n');
			}
		}
		if push_line_collapsed_trimmed(&mut out, line) {
			kept_any = true;
			pending_blank = false;
		} else {
			out.truncate(mark);
			pending_blank = kept_any;
		}
	}
	out
}

/// `singleLine`: every whitespace run (newlines included) becomes one space,
/// then trim.
pub(crate) fn single_line(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	push_line_collapsed_trimmed(&mut out, text);
	out
}

/// `/^\s/.test(text)`.
pub(crate) fn starts_with_whitespace(text: &str) -> bool {
	text.chars().next().is_some_and(is_js_whitespace)
}

/// `/\s$/.test(text)`.
pub(crate) fn ends_with_whitespace(text: &str) -> bool {
	text.chars().next_back().is_some_and(is_js_whitespace)
}

/// `value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== "")`,
/// tested against `wanted` (`BOILERPLATE_TOKENS.has`).
pub(crate) fn any_token(value: &str, wanted: impl Fn(&str) -> bool) -> bool {
	let lowered;
	let lower: &str = if value.is_ascii() {
		if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
			lowered = value.to_ascii_lowercase();
			&lowered
		} else {
			value
		}
	} else {
		lowered = value.to_lowercase();
		&lowered
	};
	lower
		.split(|character: char| !(character.is_ascii_lowercase() || character.is_ascii_digit()))
		.any(|token| !token.is_empty() && wanted(token))
}

/// `/^skip( to)? /i.test(text)`: the optional group never changes the
/// verdict (`skip to ` starts with `skip `), and `/i` without `u` folds
/// ASCII only.
pub(crate) fn is_skip_link_text(text: &str) -> bool {
	let bytes = text.as_bytes();
	bytes
		.get(..4)
		.is_some_and(|head| head.eq_ignore_ascii_case(b"skip"))
		&& bytes.get(4) == Some(&b' ')
}

/// `/^#{1,6} /.test(text)`.
pub(crate) fn is_heading_block(text: &str) -> bool {
	let hashes = text.bytes().take_while(|&byte| byte == b'#').count();
	(1..=6).contains(&hashes) && text.as_bytes().get(hashes) == Some(&b' ')
}

/// JavaScript line terminators (what `.` does not match without `s`).
const fn is_line_terminator(character: char) -> bool {
	matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^(-|\d+\.)\s+\[.+\]\(https?:\/\/\S+\)$/.test(line)`.
///
/// The prefix and the whitespace run are unambiguous; for the rest a match
/// exists iff some `](http://` / `](https://` at position k (k ≥ 1 after
/// the `[`) has no line terminator before it and only non-whitespace after
/// its `//`, ending in `)` with at least one character before that `)`.
pub(crate) fn is_menu_item_line(line: &str) -> bool {
	let bytes = line.as_bytes();
	let position = if bytes.first() == Some(&b'-') {
		1
	} else {
		let digits = bytes
			.iter()
			.take_while(|byte| byte.is_ascii_digit())
			.count();
		if digits == 0 || bytes.get(digits) != Some(&b'.') {
			return false;
		}
		digits + 1
	};
	let Some(rest) = line.get(position..) else {
		return false;
	};
	let after_space = rest.trim_start_matches(is_js_whitespace);
	if after_space.len() == rest.len() {
		return false;
	}
	let Some(inner) = after_space.strip_prefix('[') else {
		return false;
	};
	if !inner.ends_with(')') {
		return false;
	}
	// Byte offsets: first line terminator in `inner`, last whitespace in `inner`.
	let first_terminator = inner.find(is_line_terminator).unwrap_or(inner.len());
	let last_whitespace_end = inner
		.char_indices()
		.rev()
		.find(|&(_, character)| is_js_whitespace(character))
		.map_or(0, |(index, character)| index + character.len_utf8());
	let mut search = 0usize;
	while let Some(found) = inner.get(search..).and_then(|tail| tail.find("](http")) {
		let k = search + found;
		search = k + 1;
		// `.+` needs at least one character, none of them a line terminator.
		if k == 0 || k > first_terminator {
			if k > first_terminator {
				break;
			}
			continue;
		}
		let after_scheme = k + "](http".len();
		let target_start = if inner
			.get(after_scheme..)
			.is_some_and(|tail| tail.starts_with("s://"))
		{
			after_scheme + "s://".len()
		} else if inner
			.get(after_scheme..)
			.is_some_and(|tail| tail.starts_with("://"))
		{
			after_scheme + "://".len()
		} else {
			continue;
		};
		// `\S+\)$`: at least one non-whitespace character, then the final `)`.
		if target_start < inner.len() - 1 && target_start >= last_whitespace_end {
			return true;
		}
	}
	false
}

/// `isMenuListBlock`: at least five non-blank lines, each one link.
pub(crate) fn is_menu_list_block(text: &str, minimum_items: usize) -> bool {
	let mut count = 0usize;
	for line in text.split('\n') {
		let line = trim(line);
		if line.is_empty() {
			continue;
		}
		if !is_menu_item_line(line) {
			return false;
		}
		count += 1;
	}
	count >= minimum_items
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn finalizes_lines_like_the_typescript() {
		assert_eq!(finalize_block_lines("  a   b  "), "a b");
		assert_eq!(finalize_block_lines("\n\na\n\n\n b \n\n"), "a\n\nb");
		assert_eq!(finalize_block_lines("a\n \nb"), "a\n\nb");
		assert_eq!(finalize_block_lines("a\nb"), "a\nb");
		assert_eq!(finalize_block_lines(" \n \n"), "");
		assert_eq!(finalize_block_lines("x\u{a0}\u{3000}y\u{85}"), "x y\u{85}");
		assert_eq!(finalize_block_lines("\u{feff}a\u{feff}"), "a");
	}

	#[test]
	fn single_line_joins_every_whitespace_run() {
		assert_eq!(single_line(" a \n\t b "), "a b");
		assert_eq!(single_line("\u{2028}x\u{2029}"), "x");
	}

	#[test]
	fn recognises_skip_links_and_headings() {
		assert!(is_skip_link_text("Skip to content"));
		assert!(is_skip_link_text("SKIP content"));
		assert!(!is_skip_link_text("skipper"));
		assert!(!is_skip_link_text("\u{17f}kip x"));
		assert!(is_heading_block("# a"));
		assert!(is_heading_block("###### a"));
		assert!(!is_heading_block("####### a"));
		assert!(!is_heading_block("#a"));
	}

	#[test]
	fn matches_menu_item_lines() {
		assert!(is_menu_item_line("- [a](https://x.example/0)"));
		assert!(is_menu_item_line("12. [a](http://x)"));
		assert!(is_menu_item_line("-\u{a0}[a](https://x)y)"));
		assert!(is_menu_item_line("- [a](b](https://x)"));
		assert!(!is_menu_item_line("- [](https://x)"));
		assert!(!is_menu_item_line("-[a](https://x)"));
		assert!(!is_menu_item_line("- [a](https://)"));
		assert!(!is_menu_item_line("- [a](https://x y)"));
		assert!(!is_menu_item_line("- [a](ftp://x)"));
		assert!(!is_menu_item_line("- [a\rb](https://x)"));
		assert!(is_menu_item_line("- [a](https://x) ](https://y)"));
		assert!(!is_menu_item_line("1 [a](https://x)"));
		assert!(!is_menu_item_line("- [a](https://x) tail"));
	}

	#[test]
	fn splits_tokens_on_non_alphanumerics_after_lower_casing() {
		let is_nav = |token: &str| token == "nav";
		assert!(any_token("sub-NAV", is_nav));
		assert!(!any_token("navigation", is_nav));
		assert!(any_token("x\u{130}nav", |token| token == "nav"));
	}
}
