//! Port of `packages/domain/src/text/truncate.ts`.

use std::borrow::Cow;

use research_js::utf16;

/// `truncateText`: cut text to a budget of `max_length` UTF-16 code units
/// without splitting a surrogate pair, marking a cut with `…`.
///
/// Shared single copy (ARCH-013): the research tools and the conversation
/// context builder both reuse this rather than keeping two implementations.
/// The result length never exceeds `max_length`.
#[must_use]
pub fn truncate_text(text: &str, max_length: usize) -> Cow<'_, str> {
	if max_length == 0 {
		return Cow::Borrowed("");
	}
	if utf16::utf16_len(text) <= max_length {
		return Cow::Borrowed(text);
	}
	let kept = utf16::cut_code_points(text, max_length - 1);
	let mut cut = String::with_capacity(kept.len() + 3);
	cut.push_str(kept);
	cut.push('…');
	Cow::Owned(cut)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cuts_on_code_points_and_marks_the_cut() {
		assert_eq!(truncate_text("hello", 0), "");
		assert_eq!(truncate_text("hello", 5), "hello");
		assert_eq!(truncate_text("hello", 4), "hel…");
		assert_eq!(truncate_text("a😀b", 3), "a…");
		assert_eq!(truncate_text("😀😀", 1), "…");
	}
}
