//! The converter state machine: a line-for-line port of `convert` in
//! `packages/adapters/src/tools/htmlToMarkdown.ts` (its comments explain the
//! rules; the important ones are kept here). Every length is in UTF-16 code
//! units, every whitespace test is JavaScript's `\s`.
//!
//! COST (as in the TypeScript): every element kind that carries formatting
//! state is capped at `MAX_FORMAT_NESTING_DEPTH` levels, a work budget stops
//! root output past `WORK_BUDGET_MULTIPLE × maxChars`, and tag matching is
//! O(1) per tag through per-name position stacks. Unlike the TypeScript the
//! parser's own stack is O(1) too (`parser.rs`), so a whole conversion is
//! linear in the input.

use research_js::utf16::{cut_code_points, utf16_len};
use research_js::whitespace::{split, trim};
use url::Url;

use crate::names::{Known, NameId};
use crate::parser::{self, Attributes, Handler, Tag};
use crate::text::{
	any_token, ends_with_whitespace, finalize_block_lines, is_heading_block, is_menu_list_block,
	is_skip_link_text, single_line, starts_with_whitespace,
};

/// Conversion options (`HtmlToMarkdownOptions`).
#[derive(Clone, Copy, Debug)]
pub struct Options<'a> {
	/// The page URL: relative links resolve against it, same-page links are found with it.
	pub base_url: &'a str,
	/// Markdown budget in UTF-16 code units.
	pub max_chars: usize,
}

/// Heuristic drops, so a reader knows the Markdown is not the whole page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OmittedCounts {
	/// Subtrees dropped as chrome (tag, role, state, conventional names, skip links, outside main).
	pub boilerplate_blocks: usize,
	/// Link-only lists dropped as menus.
	pub menu_lists: usize,
	/// Blocks before the article `<h1>`.
	pub leading_blocks: usize,
}

/// The converted page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarkdownPage {
	/// Text of `<title>`, else the first `<h1>`; whitespace-collapsed, at most 300 characters.
	pub title: Option<String>,
	/// The Markdown, at most `max_chars` UTF-16 code units.
	pub markdown: String,
	/// True when the page was longer than `max_chars` and the Markdown was cut.
	pub truncated: bool,
	/// What the heuristics dropped.
	pub omitted: OmittedCounts,
}

const TITLE_MAX_CHARS: usize = 300;
/// An `<h1>` counts as the article start only with this much paragraph text after it (rule 5).
const ARTICLE_H1_MIN_PARAGRAPH_CHARS: usize = 200;
/// A link-only list counts as a menu only from this many items (rule 4).
const MENU_LIST_MIN_ITEMS: usize = 5;
/// Nesting ceiling for every element kind that carries formatting state.
/// Deeper elements are flattened to their text: without it, N nested
/// blockquotes around M lines rebuild every line N times.
const MAX_FORMAT_NESTING_DEPTH: usize = 32;
/// Rendering stops once root blocks exceed this many times `max_chars`.
const WORK_BUDGET_MULTIPLE: usize = 4;

/// Elements dropped with everything inside them (`DROPPED_ELEMENTS`).
const fn is_dropped_element(known: Known) -> bool {
	use Known as K;
	matches!(
		known,
		K::Script
			| K::Style
			| K::Noscript
			| K::Template
			| K::Svg | K::Canvas
			| K::Iframe
			| K::Object
			| K::Embed
			| K::Form | K::Button
			| K::Select
			| K::Textarea
			| K::Nav | K::Footer
			| K::Aside
	)
}

/// `role` values dropped with everything inside them (rule 1).
fn is_drop_role(token: &str) -> bool {
	matches!(
		token,
		"navigation"
			| "banner"
			| "contentinfo"
			| "complementary"
			| "search"
			| "menu" | "menubar"
			| "dialog"
			| "alertdialog"
	)
}

/// Conventional chrome names, matched as whole tokens (rule 2).
fn is_boilerplate_token(token: &str) -> bool {
	matches!(
		token,
		"nav"
			| "navbar"
			| "navigation"
			| "menu" | "breadcrumb"
			| "breadcrumbs"
			| "sidebar"
			| "footer"
			| "cookie"
			| "cookies"
			| "consent"
			| "banner"
			| "masthead"
			| "share" | "social"
			| "subnav"
			| "skip" | "skiplink"
			| "toolbar"
	)
}

/// Tags the token rule may drop; never `body`/`html`/`main`/`article` (rule 2).
const fn is_boilerplate_tag(known: Known) -> bool {
	matches!(
		known,
		Known::Div | Known::Section | Known::Ul | Known::Ol | Known::Header
	)
}

/// The converter's void elements (fewer than htmlparser2's: no `basefont`,
/// `command`, `frame`, `isindex`, `keygen`).
const fn is_void_element(known: Known) -> bool {
	use Known as K;
	matches!(
		known,
		K::Area
			| K::Base | K::Br
			| K::Col | K::Embed
			| K::Hr | K::Img
			| K::Input
			| K::Link | K::Meta
			| K::Param
			| K::Source
			| K::Track
			| K::Wbr
	)
}

/// Elements that become Markdown blocks separated by one blank line.
const fn is_block_element(known: Known) -> bool {
	use Known as K;
	matches!(
		known,
		K::P | K::Div
			| K::Section
			| K::Article
			| K::Main | K::Header
			| K::Hgroup
			| K::Figure
			| K::Figcaption
			| K::Dl | K::Dt
			| K::Dd | K::Details
			| K::Summary
			| K::Address
			| K::Search
	)
}

const fn heading_level(known: Known) -> Option<usize> {
	match known {
		Known::H1 => Some(1),
		Known::H2 => Some(2),
		Known::H3 => Some(3),
		Known::H4 => Some(4),
		Known::H5 => Some(5),
		Known::H6 => Some(6),
		_ => None,
	}
}

fn is(name: NameId, known: Known) -> bool {
	name == NameId::known(known)
}

struct TextBlock {
	text: String,
	in_main: bool,
	/// A rendered nested list: an enclosing `li` splices its lines as they are.
	list: bool,
}

enum Frame {
	/// The root (tag `None`) and block elements.
	Section {
		tag: Option<NameId>,
		in_main: bool,
		inline: String,
		blocks: Vec<TextBlock>,
	},
	Heading {
		tag: NameId,
		level: usize,
		inline: String,
	},
	Inline {
		tag: NameId,
		marker: &'static str,
		href: Option<String>,
		same_page: bool,
		inline: String,
	},
	Pre {
		tag: NameId,
	},
	List {
		tag: NameId,
		ordered: bool,
		depth: usize,
		items: Vec<String>,
	},
	Item {
		tag: NameId,
		inline: String,
		blocks: Vec<TextBlock>,
		depth: usize,
		ordered: bool,
		index: usize,
		orphan: bool,
	},
	Quote {
		tag: NameId,
		in_main: bool,
		inline: String,
		blocks: Vec<TextBlock>,
	},
	Table {
		tag: NameId,
		rows: Vec<Vec<String>>,
	},
	Row {
		tag: NameId,
		cells: Vec<String>,
	},
	Cell {
		tag: NameId,
		inline: String,
	},
}

impl Frame {
	const fn tag(&self) -> Option<NameId> {
		match self {
			Self::Section { tag, .. } => *tag,
			Self::Heading { tag, .. }
			| Self::Inline { tag, .. }
			| Self::Pre { tag }
			| Self::List { tag, .. }
			| Self::Item { tag, .. }
			| Self::Quote { tag, .. }
			| Self::Table { tag, .. }
			| Self::Row { tag, .. }
			| Self::Cell { tag, .. } => Some(*tag),
		}
	}

	/// The frame's inline buffer, for kinds that collect inline text.
	const fn inline_mut(&mut self) -> Option<&mut String> {
		match self {
			Self::Section { inline, .. }
			| Self::Quote { inline, .. }
			| Self::Item { inline, .. }
			| Self::Inline { inline, .. }
			| Self::Heading { inline, .. }
			| Self::Cell { inline, .. } => Some(inline),
			Self::Pre { .. } | Self::List { .. } | Self::Table { .. } | Self::Row { .. } => None,
		}
	}
}

/// `flushInline`: pending inline text of a block frame becomes a block.
fn flush_inline(frame: &mut Frame, main_depth: usize) {
	let (inline, blocks, in_main) = match frame {
		Frame::Section {
			inline,
			blocks,
			in_main,
			..
		}
		| Frame::Quote {
			inline,
			blocks,
			in_main,
			..
		} => (inline, blocks, *in_main),
		Frame::Item { inline, blocks, .. } => (inline, blocks, main_depth > 0),
		_ => return,
	};
	let text = finalize_block_lines(inline);
	inline.clear();
	if !text.is_empty() {
		blocks.push(TextBlock {
			text,
			in_main,
			list: false,
		});
	}
}

/// `attribValue`: case-insensitive lookup (htmlparser2 already lower-cases names).
fn attrib_value<'a>(attributes: &'a Attributes, wanted: &str) -> Option<&'a str> {
	attributes
		.iter()
		.find(|&(key, _)| key_matches(key, wanted))
		.map(|(_, value)| value)
}

fn has_attrib(attributes: &Attributes, wanted: &str) -> bool {
	attributes.iter().any(|(key, _)| key_matches(key, wanted))
}

/// `key.toLowerCase() === wanted` for a lower-case ASCII `wanted`.
fn key_matches(key: &str, wanted: &str) -> bool {
	if key.is_ascii() {
		key.eq_ignore_ascii_case(wanted)
	} else {
		key.to_lowercase() == wanted
	}
}

fn collapse_title(text: &str) -> String {
	cut_code_points(&single_line(text), TITLE_MAX_CHARS).to_owned()
}

/// `href` without its fragment.
fn without_fragment(href: &str) -> &str {
	href.find('#')
		.map_or(href, |index| href.get(..index).unwrap_or(href))
}

fn is_http(url: &Url) -> bool {
	matches!(url.scheme(), "http" | "https")
}

/// The page URL, parsed once: `resolveLink`, `pageNoFragment`, `isSamePageLink`.
struct Links {
	/// `new URL(baseUrl)`; `None` when it does not parse (every link then fails).
	base: Option<Url>,
	/// The page URL without its fragment, when it is an http(s) URL.
	page_without_fragment: Option<String>,
}

impl Links {
	fn new(base_url: &str) -> Self {
		let base = Url::parse(base_url).ok();
		let page_without_fragment = base
			.as_ref()
			.filter(|url| is_http(url))
			.map(|url| without_fragment(url.as_str()).to_owned());
		Self {
			base,
			page_without_fragment,
		}
	}

	/// `new URL(href.trim(), baseUrl)`.
	fn resolve(&self, href: &str) -> Option<Url> {
		self.base.as_ref()?.join(trim(href)).ok()
	}

	/// `resolveLink`: only http(s) results stay links (SEC-001).
	fn resolve_link(&self, href: &str) -> Option<String> {
		self.resolve(href).filter(is_http).map(String::from)
	}

	/// `isSamePageLink` (rule 3).
	fn is_same_page(&self, href: &str) -> bool {
		let Some(page) = self.page_without_fragment.as_deref() else {
			return false;
		};
		self.resolve(href)
			.filter(is_http)
			.is_some_and(|resolved| without_fragment(resolved.as_str()) == page)
	}
}

/// `htmlToMarkdown`: total — any input gives a page.
#[must_use]
pub fn html_to_markdown(html: &str, options: &Options<'_>) -> MarkdownPage {
	let mut converter = Converter::new(options.base_url, options.max_chars);
	parser::parse(html, &mut converter);
	converter.finish()
}

struct Converter {
	stack: Vec<Frame>,
	/// Lower-cased names of the open dropped subtree.
	dropped: Vec<NameId>,
	/// `(name, contributes main)` for every pushed element.
	open_elements: Vec<(NameId, bool)>,
	/// Per name: positions in `open_elements`, innermost last, so
	/// `pop_element` finds its match in O(1) (repeated mismatched closes made
	/// matching O(n²) on a 2 MB input).
	open_tag_positions: Vec<Vec<usize>>,
	links: Links,
	max_chars: usize,
	body_seen: bool,
	body_depth: usize,
	main_depth: usize,
	saw_main: bool,
	boilerplate_drops: usize,
	menu_lists_dropped: usize,
	leading_dropped: usize,
	title_depth: usize,
	title_chunks: String,
	title_text: Option<String>,
	first_h1: Option<String>,
	pre_depth: usize,
	pre_chunks: String,
	heading_depth: usize,
	list_depth: usize,
	table_depth: usize,
	row_depth: usize,
	cell_depth: usize,
	quote_depth: usize,
	inline_depth: usize,
	section_depth: usize,
	item_depth: usize,
	// Opens flattened (not pushed) past the nesting ceiling, per kind. Each
	// close of that kind consumes one pending skip first, so a flattened close
	// can never pop a pushed ancestor with the same tag.
	skipped_quotes: usize,
	skipped_lists: usize,
	skipped_tables: usize,
	skipped_rows: usize,
	skipped_inline: usize,
	skipped_sections: usize,
	skipped_items: usize,
	skipped_headings: usize,
	// Work budget: rendered root-block characters so far; once past the
	// budget further root output is dropped (the result is truncated anyway).
	rendered_chars: usize,
	over_budget: bool,
	work_budget: usize,
}

impl Converter {
	fn new(base_url: &str, max_chars: usize) -> Self {
		Self {
			stack: vec![Frame::Section {
				tag: None,
				in_main: false,
				inline: String::new(),
				blocks: Vec::new(),
			}],
			dropped: Vec::new(),
			open_elements: Vec::new(),
			open_tag_positions: Vec::new(),
			links: Links::new(base_url),
			max_chars,
			body_seen: false,
			body_depth: 0,
			main_depth: 0,
			saw_main: false,
			boilerplate_drops: 0,
			menu_lists_dropped: 0,
			leading_dropped: 0,
			title_depth: 0,
			title_chunks: String::new(),
			title_text: None,
			first_h1: None,
			pre_depth: 0,
			pre_chunks: String::new(),
			heading_depth: 0,
			list_depth: 0,
			table_depth: 0,
			row_depth: 0,
			cell_depth: 0,
			quote_depth: 0,
			inline_depth: 0,
			section_depth: 0,
			item_depth: 0,
			skipped_quotes: 0,
			skipped_lists: 0,
			skipped_tables: 0,
			skipped_rows: 0,
			skipped_inline: 0,
			skipped_sections: 0,
			skipped_items: 0,
			skipped_headings: 0,
			rendered_chars: 0,
			over_budget: false,
			work_budget: max_chars.saturating_mul(WORK_BUDGET_MULTIPLE),
		}
	}

	const fn eligible(&self) -> bool {
		!self.body_seen || self.body_depth > 0
	}

	fn omitted(&self) -> OmittedCounts {
		OmittedCounts {
			boilerplate_blocks: self.boilerplate_drops,
			menu_lists: self.menu_lists_dropped,
			leading_blocks: self.leading_dropped,
		}
	}

	/// Starts dropping an element; only the subtree root is counted (rules 1–2).
	fn drop_element(&mut self, name: NameId) {
		if self.dropped.is_empty() {
			self.boilerplate_drops += 1;
		}
		if !name.as_known().is_some_and(is_void_element) {
			self.dropped.push(name);
		}
	}

	/// Pops `open_elements` through the matching open, releasing its main contributions.
	fn pop_element(&mut self, name: NameId) {
		let matched = self
			.open_tag_positions
			.get(name.index())
			.and_then(|positions| positions.last());
		let Some(&match_index) = matched else { return };
		while self.open_elements.len() > match_index {
			let Some((popped, main)) = self.open_elements.pop() else {
				break;
			};
			let back = self.open_elements.len();
			// Entries unwind in reverse push order, so the popped position is
			// its tag stack's top; the guard keeps a bug fail-safe.
			if let Some(positions) = self.open_tag_positions.get_mut(popped.index()) {
				if positions.last() == Some(&back) {
					positions.pop();
				}
			}
			if main {
				self.main_depth = self.main_depth.saturating_sub(1);
			}
		}
	}

	fn push_element(&mut self, name: NameId, main: bool) {
		let index = name.index();
		if self.open_tag_positions.len() <= index {
			self.open_tag_positions.resize_with(index + 1, Vec::new);
		}
		if let Some(positions) = self.open_tag_positions.get_mut(index) {
			positions.push(self.open_elements.len());
		}
		self.open_elements.push((name, main));
	}

	fn flush_top(&mut self) {
		let main_depth = self.main_depth;
		if let Some(frame) = self.stack.last_mut() {
			flush_inline(frame, main_depth);
		}
	}

	/// Appends a finished block to whatever frame is now on top of the stack.
	fn emit_block(&mut self, text: String, in_main: bool, list: bool) {
		if text.is_empty() {
			return;
		}
		// Work budget: only root-directed output counts. Intermediate rebuilds
		// are bounded by the nesting ceiling instead; counting them would drop
		// the very blocks the final output is assembled from.
		if self.stack.len() == 1 {
			if self.over_budget {
				return;
			}
			self.rendered_chars = self.rendered_chars.saturating_add(utf16_len(&text));
			if self.rendered_chars > self.work_budget {
				self.over_budget = true;
			}
		}
		let Some(parent) = self.stack.last_mut() else {
			return;
		};
		match parent {
			Frame::Section { blocks, .. }
			| Frame::Quote { blocks, .. }
			| Frame::Item { blocks, .. } => {
				blocks.push(TextBlock {
					text,
					in_main,
					list,
				});
			}
			Frame::Inline { inline, .. }
			| Frame::Heading { inline, .. }
			| Frame::Cell { inline, .. } => {
				inline.push(' ');
				inline.push_str(&text);
				inline.push(' ');
			}
			Frame::List { items, .. } => items.push(text),
			Frame::Table { .. } | Frame::Row { .. } | Frame::Pre { .. } => {}
		}
	}

	/// Appends finished inline text to whatever frame is now on top of the stack.
	fn emit_inline(&mut self, text: &str) {
		if text.is_empty() {
			return;
		}
		let Some(parent) = self.stack.last_mut() else {
			return;
		};
		if let Frame::List { items, .. } = parent {
			let line = single_line(text);
			if !line.is_empty() {
				items.push(line);
			}
		} else if let Some(inline) = parent.inline_mut() {
			inline.push_str(text);
		}
	}

	fn top_is(&self, check: impl Fn(&Frame) -> bool) -> bool {
		self.stack.last().is_some_and(check)
	}

	fn open_tag(&mut self, name: NameId, attributes: &Attributes) {
		let known = name.as_known();
		let known_is = |wanted: Known| known == Some(wanted);
		if !self.dropped.is_empty() {
			// Inside a dropped subtree every tag is dropped; pushing keeps
			// nested same-name closes balanced so the outer pop lands correctly.
			if !known.is_some_and(is_void_element) {
				self.dropped.push(name);
			}
			return;
		}
		if known.is_some_and(is_dropped_element) {
			self.drop_element(name);
			return;
		}
		// Rule 1: drop by role and state, not only by tag. `role="main"` and
		// `role="article"` count as `<main>`/`<article>` below instead.
		let role = attrib_value(attributes, "role").map(|raw| trim(raw).to_lowercase());
		let role_tokens = || split(role.as_deref().unwrap_or(""));
		let aria_hidden = attrib_value(attributes, "aria-hidden")
			.is_some_and(|value| trim(value).to_lowercase() == "true");
		if aria_hidden || has_attrib(attributes, "hidden") || role_tokens().any(is_drop_role) {
			self.drop_element(name);
			return;
		}
		if known_is(Known::Body) {
			self.body_seen = true;
			self.body_depth += 1;
			return;
		}
		if known_is(Known::Title) {
			if self.title_depth == 0 {
				self.title_chunks.clear();
			}
			self.title_depth += 1;
			return;
		}
		if self.title_depth > 0 {
			return;
		}
		if known_is(Known::Pre) {
			// One frame for the outermost `<pre>` only (nested pushes left an
			// orphan frame whose close never popped it).
			if self.pre_depth == 0 {
				self.pre_chunks.clear();
				if self.eligible() {
					self.stack.push(Frame::Pre { tag: name });
				}
			}
			self.pre_depth += 1;
			return;
		}
		let level = known.and_then(heading_level);
		if level.is_some() {
			self.heading_depth += 1;
		}
		if known_is(Known::Head) || known_is(Known::Html) || !self.eligible() {
			return;
		}
		if self.pre_depth > 0 {
			// Inside `pre` only a line break still structures text.
			if known_is(Known::Br) {
				self.pre_chunks.push('\n');
			}
			return;
		}
		if known_is(Known::Br) {
			self.emit_inline("\n");
			return;
		}
		if known_is(Known::Hr) {
			self.flush_top();
			self.emit_block("---".to_owned(), self.main_depth > 0, false);
			return;
		}
		if known_is(Known::Img) {
			return;
		}
		let has_main_role = role_tokens().any(|token| token == "main" || token == "article");
		let contributes_main = known_is(Known::Main) || known_is(Known::Article) || has_main_role;
		if contributes_main {
			self.saw_main = true;
			self.main_depth += 1;
		}
		// Rule 2: drop by conventional names when there is no semantic help,
		// never inside main content and never for the document elements.
		if !contributes_main
			&& self.main_depth == 0
			&& known.is_some_and(is_boilerplate_tag)
			&& (attrib_value(attributes, "id")
				.is_some_and(|id| any_token(id, is_boilerplate_token))
				|| attrib_value(attributes, "class")
					.is_some_and(|class| any_token(class, is_boilerplate_token)))
		{
			self.drop_element(name);
			return;
		}
		if !known.is_some_and(is_void_element) {
			self.push_element(name, contributes_main);
		}
		if let Some(level) = level {
			// Past the ceiling a heading is flattened to its text.
			if self.heading_depth > MAX_FORMAT_NESTING_DEPTH {
				self.skipped_headings += 1;
				return;
			}
			self.flush_top();
			self.stack.push(Frame::Heading {
				tag: name,
				level,
				inline: String::new(),
			});
			return;
		}
		let Some(known) = known else {
			// Transparent elements (`span`, unknown and custom tags): text flows to the parent.
			return;
		};
		use Known as K;
		if self.heading_depth > 0
			&& (is_block_element(known)
				|| matches!(
					known,
					K::Ul | K::Ol | K::Li | K::Blockquote | K::Table | K::Tr | K::Td
				) || matches!(known, K::Th | K::Hr))
		{
			// A block tag inside a heading is invalid HTML; keep its text flowing, not its structure.
			return;
		}
		match known {
			K::Ul | K::Ol => {
				self.flush_top();
				if self.list_depth >= MAX_FORMAT_NESTING_DEPTH {
					self.skipped_lists += 1;
					return;
				}
				self.stack.push(Frame::List {
					tag: name,
					ordered: known == K::Ol,
					depth: self.list_depth,
					items: Vec::new(),
				});
				self.list_depth += 1;
			}
			K::Li => self.open_item(name),
			K::Blockquote => {
				self.flush_top();
				if self.quote_depth >= MAX_FORMAT_NESTING_DEPTH {
					self.skipped_quotes += 1;
					return;
				}
				self.stack.push(Frame::Quote {
					tag: name,
					in_main: self.main_depth > 0,
					inline: String::new(),
					blocks: Vec::new(),
				});
				self.quote_depth += 1;
			}
			K::Table => {
				// A table inside a cell would corrupt the outer row; keep only its text.
				if self.cell_depth > 0 {
					return;
				}
				if self.table_depth >= MAX_FORMAT_NESTING_DEPTH {
					self.skipped_tables += 1;
					return;
				}
				self.flush_top();
				self.stack.push(Frame::Table {
					tag: name,
					rows: Vec::new(),
				});
				self.table_depth += 1;
			}
			K::Tr => {
				if self.table_depth == 0 || self.cell_depth > 0 {
					return;
				}
				// A row nested directly in a row is malformed; keep only its text.
				if self.row_depth > 0 {
					self.skipped_rows += 1;
					return;
				}
				self.stack.push(Frame::Row {
					tag: name,
					cells: Vec::new(),
				});
				self.row_depth += 1;
			}
			K::Td | K::Th => {
				if self.row_depth == 0 || self.cell_depth > 0 {
					return;
				}
				self.stack.push(Frame::Cell {
					tag: name,
					inline: String::new(),
				});
				self.cell_depth += 1;
			}
			K::A | K::Strong | K::B | K::Em | K::I | K::Code => {
				if self.inline_depth >= MAX_FORMAT_NESTING_DEPTH {
					self.skipped_inline += 1;
					return;
				}
				let (marker, href) = match known {
					K::A => ("", attrib_value(attributes, "href")),
					K::Strong | K::B => ("**", None),
					K::Em | K::I => ("*", None),
					_ => ("`", None),
				};
				let same_page = href.is_some_and(|href| self.links.is_same_page(href));
				self.stack.push(Frame::Inline {
					tag: name,
					marker,
					href: href.map(str::to_owned),
					same_page,
					inline: String::new(),
				});
				self.inline_depth += 1;
			}
			_ if is_block_element(known) => {
				self.flush_top();
				// Past the ceiling a section is flattened to its text: each close
				// would otherwise re-emit all blocks accumulated below it.
				if self.section_depth >= MAX_FORMAT_NESTING_DEPTH {
					self.skipped_sections += 1;
					return;
				}
				self.stack.push(Frame::Section {
					tag: Some(name),
					in_main: self.main_depth > 0,
					inline: String::new(),
					blocks: Vec::new(),
				});
				self.section_depth += 1;
			}
			// Transparent elements: text flows to the parent.
			_ => {}
		}
	}

	fn open_item(&mut self, name: NameId) {
		self.flush_top();
		// Past the ceiling an item is flattened to a plain block; this also
		// bounds the ancestor scan below to ~32 consecutive items.
		if self.item_depth >= MAX_FORMAT_NESTING_DEPTH {
			self.skipped_items += 1;
			return;
		}
		// Number and marker come from the enclosing list; find it without popping.
		let mut ordered = false;
		let mut index = 1;
		let mut depth = 0;
		let mut orphan = true;
		if self.list_depth > 0 {
			for candidate in self.stack.iter().rev() {
				match candidate {
					Frame::List {
						ordered: list_ordered,
						depth: list_depth,
						items,
						..
					} => {
						ordered = *list_ordered;
						index = items.len() + 1;
						depth = *list_depth;
						orphan = false;
						break;
					}
					Frame::Item { .. } => {}
					_ => break,
				}
			}
		}
		self.stack.push(Frame::Item {
			tag: name,
			inline: String::new(),
			blocks: Vec::new(),
			depth,
			ordered,
			index,
			orphan,
		});
		self.item_depth += 1;
	}

	/// The flattened-close rule: when the top frame is not this close's own
	/// kind and tag but an open of this kind was flattened, the close
	/// releases that open's element entry and consumes one pending skip.
	fn consume_skip(
		&mut self,
		name: NameId,
		own_top: bool,
		which: fn(&mut Self) -> &mut usize,
	) -> bool {
		if own_top || *which(self) == 0 {
			return false;
		}
		self.pop_element(name);
		*which(self) -= 1;
		true
	}

	fn close_tag(&mut self, name: NameId) {
		let known = name.as_known();
		let known_is = |wanted: Known| known == Some(wanted);
		if !self.dropped.is_empty() {
			if self.dropped.last() == Some(&name) {
				self.dropped.pop();
			}
			return;
		}
		if known_is(Known::Body) {
			self.body_depth = self.body_depth.saturating_sub(1);
			return;
		}
		if known_is(Known::Title) {
			if self.title_depth > 0 {
				self.title_depth -= 1;
				if self.title_depth == 0 && self.title_text.is_none() {
					let collapsed = collapse_title(&self.title_chunks);
					if !collapsed.is_empty() {
						self.title_text = Some(collapsed);
					}
				}
			}
			return;
		}
		if self.title_depth > 0 {
			return;
		}
		if known_is(Known::Pre) {
			if self.pre_depth > 0 {
				self.pre_depth -= 1;
				if self.pre_depth == 0 {
					if self.top_is(|frame| matches!(frame, Frame::Pre { .. })) {
						self.stack.pop();
					}
					let chunks = std::mem::take(&mut self.pre_chunks);
					let content = chunks.trim_matches('\n');
					if !content.is_empty() {
						let block = format!("```\n{content}\n```");
						self.emit_block(block, self.main_depth > 0, false);
					}
				}
			}
			return;
		}
		// The heading counter is released before the `pre` early return: a
		// heading opened inside `pre` incremented it.
		let level = known.and_then(heading_level);
		if level.is_some() {
			self.heading_depth = self.heading_depth.saturating_sub(1);
		}
		if self.pre_depth > 0 || known_is(Known::Head) || known_is(Known::Html) {
			return;
		}
		let tag_matches = |frame: &Frame| frame.tag() == Some(name);
		let consumed = match known {
			_ if level.is_some() => {
				let own = self
					.top_is(|frame| matches!(frame, Frame::Heading { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_headings)
			}
			Some(Known::Blockquote) => {
				let own =
					self.top_is(|frame| matches!(frame, Frame::Quote { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_quotes)
			}
			Some(Known::Ul | Known::Ol) => {
				let own =
					self.top_is(|frame| matches!(frame, Frame::List { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_lists)
			}
			Some(Known::Li) => {
				let own =
					self.top_is(|frame| matches!(frame, Frame::Item { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_items)
			}
			Some(Known::Table) => {
				let own =
					self.top_is(|frame| matches!(frame, Frame::Table { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_tables)
			}
			Some(Known::Tr) => {
				let own =
					self.top_is(|frame| matches!(frame, Frame::Row { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_rows)
			}
			Some(Known::A | Known::Strong | Known::B | Known::Em | Known::I | Known::Code) => {
				let own = self
					.top_is(|frame| matches!(frame, Frame::Inline { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_inline)
			}
			Some(known) if is_block_element(known) => {
				let own = self
					.top_is(|frame| matches!(frame, Frame::Section { .. }) && tag_matches(frame));
				self.consume_skip(name, own, |this| &mut this.skipped_sections)
			}
			_ => false,
		};
		if consumed {
			return;
		}
		self.pop_element(name);
		if !self.top_is(tag_matches) {
			return;
		}
		let Some(frame) = self.stack.pop() else {
			return;
		};
		self.close_frame(frame);
	}

	fn close_frame(&mut self, mut frame: Frame) {
		let main_depth = self.main_depth;
		let in_main = main_depth > 0;
		match frame {
			Frame::Section { .. } => {
				self.section_depth = self.section_depth.saturating_sub(1);
				flush_inline(&mut frame, main_depth);
				if let Frame::Section { blocks, .. } = frame {
					for block in blocks {
						self.emit_block(block.text, block.in_main, block.list);
					}
				}
			}
			Frame::Heading { tag, level, inline } => {
				let text = single_line(&inline);
				if !text.is_empty() {
					if is(tag, Known::H1) && self.first_h1.is_none() {
						self.first_h1 = Some(collapse_title(&text));
					}
					let mut block = "#".repeat(level);
					block.push(' ');
					block.push_str(&text);
					self.emit_block(block, in_main, false);
				}
			}
			Frame::Inline {
				marker,
				href,
				same_page,
				inline,
				..
			} => {
				self.inline_depth = self.inline_depth.saturating_sub(1);
				self.close_inline(marker, href.as_deref(), same_page, &inline);
			}
			Frame::List { items, .. } => {
				self.list_depth = self.list_depth.saturating_sub(1);
				if !items.is_empty() {
					self.emit_block(items.join("\n"), in_main, true);
				}
			}
			Frame::Item { .. } => {
				self.item_depth = self.item_depth.saturating_sub(1);
				flush_inline(&mut frame, main_depth);
				self.close_item(frame);
			}
			Frame::Quote { .. } => {
				self.quote_depth = self.quote_depth.saturating_sub(1);
				flush_inline(&mut frame, main_depth);
				let Frame::Quote {
					blocks,
					in_main: quote_in_main,
					..
				} = frame
				else {
					return;
				};
				let mut lines = String::new();
				for (number, line) in blocks
					.iter()
					.flat_map(|block| block.text.split('\n'))
					.enumerate()
				{
					if number > 0 {
						lines.push('\n');
					}
					if line.is_empty() {
						lines.push('>');
					} else {
						lines.push_str("> ");
						lines.push_str(line);
					}
				}
				if !lines.is_empty() {
					self.emit_block(lines, quote_in_main, false);
				}
			}
			Frame::Table { rows, .. } => {
				self.table_depth = self.table_depth.saturating_sub(1);
				let mut kept = rows
					.iter()
					.filter(|row| row.iter().any(|cell| !cell.is_empty()));
				let Some(header) = kept.next() else { return };
				let pipe = |out: &mut String, cells: &[String]| {
					out.push_str("| ");
					out.push_str(&cells.join(" | "));
					out.push_str(" |");
				};
				let mut lines = String::new();
				pipe(&mut lines, header);
				lines.push_str("\n| ");
				lines.push_str(&vec!["---"; header.len()].join(" | "));
				lines.push_str(" |");
				for row in kept {
					lines.push('\n');
					pipe(&mut lines, row);
				}
				self.emit_block(lines, in_main, false);
			}
			Frame::Row { cells, .. } => {
				self.row_depth = self.row_depth.saturating_sub(1);
				if let Some(Frame::Table { rows, .. }) = self.stack.last_mut() {
					rows.push(cells);
				}
			}
			Frame::Cell { inline, .. } => {
				self.cell_depth = self.cell_depth.saturating_sub(1);
				let replaced: String = inline
					.chars()
					.map(|character| {
						if matches!(character, '|' | '\n') {
							' '
						} else {
							character
						}
					})
					.collect();
				let text = single_line(&replaced);
				if let Some(Frame::Row { cells, .. }) = self.stack.last_mut() {
					cells.push(text);
				} else if !text.is_empty() {
					self.emit_inline(&text);
				}
			}
			Frame::Pre { .. } => {}
		}
	}

	fn close_inline(&mut self, marker: &str, href: Option<&str>, same_page: bool, raw: &str) {
		let lead = if starts_with_whitespace(raw) { " " } else { "" };
		let trail = if ends_with_whitespace(raw) { " " } else { "" };
		if let Some(href) = href {
			let text = single_line(raw);
			if text.is_empty() {
				return;
			}
			// Skip hints are chrome even when they carry a real URL (rule 3).
			if is_skip_link_text(&text) {
				self.boilerplate_drops += 1;
				return;
			}
			// Same-page links are not links: keep the text, drop the target (rule 3).
			let url = if same_page {
				None
			} else {
				self.links.resolve_link(href)
			};
			let out = match url {
				None => format!("{lead}{text}{trail}"),
				Some(url) => format!("{lead}[{text}]({url}){trail}"),
			};
			self.emit_inline(&out);
		} else if !marker.is_empty() {
			// Rule 6: a space lost inside the emphasis must survive outside it,
			// or `**Data source:**U.S.` is emitted.
			let text = finalize_block_lines(raw);
			if !text.is_empty() {
				self.emit_inline(&format!("{lead}{marker}{text}{marker}{trail}"));
			}
		} else {
			self.emit_inline(raw);
		}
	}

	fn close_item(&mut self, frame: Frame) {
		let Frame::Item {
			blocks,
			inline,
			depth,
			ordered,
			index,
			orphan,
			..
		} = frame
		else {
			return;
		};
		let main = self.main_depth > 0;
		let mut parts = blocks;
		// Always empty after the flush above; kept as in the TypeScript.
		let direct = finalize_block_lines(&inline);
		if !direct.is_empty() {
			parts.push(TextBlock {
				text: direct,
				in_main: main,
				list: false,
			});
		}
		let mut kept = parts.into_iter().filter(|part| !part.text.is_empty());
		let Some(first) = kept.next() else { return };
		if orphan {
			self.emit_block(first.text, main, false);
			for extra in kept {
				self.emit_block(extra.text, main, false);
			}
			return;
		}
		let marker = if ordered {
			format!("{index}.")
		} else {
			"-".to_owned()
		};
		let indent = "  ".repeat(depth);
		let mut lines = format!("{indent}{marker} {}", first.text);
		for extra in kept {
			for line in extra.text.split('\n') {
				lines.push('\n');
				if extra.list {
					// A nested list already carries its absolute indent; splice it unchanged.
					lines.push_str(line);
				} else {
					lines.push_str(&indent);
					lines.push_str("  ");
					lines.push_str(line);
				}
			}
		}
		if let Some(Frame::List { items, .. }) = self.stack.last_mut() {
			items.push(lines);
		} else {
			self.emit_block(lines, main, false);
		}
	}

	/// Where a text chunk goes (`onText`), or `None` when it is dropped.
	fn text_target(&mut self) -> Option<TextTarget<'_>> {
		if !self.dropped.is_empty() {
			return None;
		}
		if self.title_depth > 0 {
			return Some(TextTarget::Inline(&mut self.title_chunks));
		}
		if self.pre_depth > 0 {
			return Some(TextTarget::Inline(&mut self.pre_chunks));
		}
		if !self.eligible() {
			return None;
		}
		match self.stack.last_mut()? {
			Frame::List { items, .. } => Some(TextTarget::List(items)),
			frame => frame.inline_mut().map(TextTarget::Inline),
		}
	}

	fn finish(mut self) -> MarkdownPage {
		// Unclosed tags still contribute their text: unwind the stack in order.
		// Unclosed dropped/title/pre state is drained first (each drain loop
		// strictly decreases its counter), then every iteration pops a frame.
		while self.stack.len() > 1 {
			let Some(tag) = self.stack.last().and_then(Frame::tag) else {
				break;
			};
			if !self.dropped.is_empty() {
				self.dropped.clear();
				continue;
			}
			if self.title_depth > 0 {
				while self.title_depth > 0 {
					self.close_tag(NameId::known(Known::Title));
				}
				continue;
			}
			if self.pre_depth > 0 {
				while self.pre_depth > 0 {
					self.close_tag(NameId::known(Known::Pre));
				}
				continue;
			}
			let before = self.stack.len();
			self.close_tag(tag);
			if self.stack.len() >= before {
				self.stack.pop();
			}
		}
		let main_depth = self.main_depth;
		let blocks = match self.stack.pop() {
			Some(mut root) => {
				flush_inline(&mut root, main_depth);
				match root {
					Frame::Section { blocks, .. }
					| Frame::Quote { blocks, .. }
					| Frame::Item { blocks, .. } => blocks,
					_ => Vec::new(),
				}
			}
			None => Vec::new(),
		};
		let visible = self.select_visible(blocks);
		let title = self.title_text.take().or_else(|| self.first_h1.take());
		let omitted = self.omitted();
		let max_chars = self.max_chars;
		let separators = 2 * visible.len().saturating_sub(1);
		let full_length = visible
			.iter()
			.map(|block| utf16_len(&block.text))
			.sum::<usize>()
			+ separators;
		// `over_budget` means blocks were dropped while rendering, so the
		// result is truncated even when what survived fits.
		if !self.over_budget && full_length <= max_chars {
			let texts: Vec<&str> = visible.iter().map(|block| block.text.as_str()).collect();
			return MarkdownPage {
				title,
				markdown: texts.join("\n\n"),
				truncated: false,
				omitted,
			};
		}
		let mut markdown = String::new();
		let mut used = 0usize;
		let mut kept = 0usize;
		for block in &visible {
			let separator = if kept == 0 { 0 } else { 2 };
			let length = utf16_len(&block.text);
			if used + separator + length > max_chars {
				break;
			}
			if kept > 0 {
				markdown.push_str("\n\n");
			}
			markdown.push_str(&block.text);
			used += separator + length;
			kept += 1;
		}
		if kept == 0 {
			let first = visible.first().map_or("", |block| block.text.as_str());
			markdown = cut_code_points(first, max_chars).to_owned();
		}
		MarkdownPage {
			title,
			markdown,
			truncated: true,
			omitted,
		}
	}

	/// Main content, menus and the article `<h1>` (rules 4–5).
	fn select_visible(&mut self, blocks: Vec<TextBlock>) -> Vec<TextBlock> {
		if self.saw_main {
			let before = blocks.len();
			let visible: Vec<TextBlock> =
				blocks.into_iter().filter(|block| block.in_main).collect();
			// Blocks outside `<main>`/`<article>` are chrome by definition.
			self.boilerplate_drops += before - visible.len();
			return visible;
		}
		// Rule 4: link-only lists outside the main content are menus.
		let mut visible = Vec::with_capacity(blocks.len());
		for block in blocks {
			if block.list && is_menu_list_block(&block.text, MENU_LIST_MIN_ITEMS) {
				self.menu_lists_dropped += 1;
			} else {
				visible.push(block);
			}
		}
		// Rule 5: start at the article when the page offers no main element.
		let h1_indices: Vec<usize> = visible
			.iter()
			.enumerate()
			.filter(|(_, block)| block.text.starts_with("# "))
			.map(|(index, _)| index)
			.collect();
		let start = match h1_indices.as_slice() {
			[] => None,
			[only] => Some(*only),
			several => several.iter().rev().copied().find(|&index| {
				let mut chars = 0usize;
				for following in visible.iter().skip(index + 1) {
					if following.text.starts_with("# ") {
						break;
					}
					if is_heading_block(&following.text) || following.list {
						continue;
					}
					chars += utf16_len(&following.text);
					if chars >= ARTICLE_H1_MIN_PARAGRAPH_CHARS {
						break;
					}
				}
				chars >= ARTICLE_H1_MIN_PARAGRAPH_CHARS
			}),
		};
		match start {
			Some(start) if start > 0 => {
				self.leading_dropped = start;
				visible.split_off(start)
			}
			_ => visible,
		}
	}
}

enum TextTarget<'a> {
	Inline(&'a mut String),
	List(&'a mut Vec<String>),
}

impl Handler for Converter {
	fn on_open_tag(&mut self, tag: Tag<'_>, attributes: &Attributes) {
		self.open_tag(tag.lower, attributes);
	}

	fn on_text(&mut self, text: &str) {
		match self.text_target() {
			Some(TextTarget::Inline(buffer)) => buffer.push_str(text),
			Some(TextTarget::List(items)) => {
				let line = single_line(text);
				if !line.is_empty() {
					items.push(line);
				}
			}
			None => {}
		}
	}

	fn on_split_text(&mut self, character: char) {
		match self.text_target() {
			Some(TextTarget::Inline(buffer)) => buffer.push(character),
			// A list item per chunk: each lone surrogate half becomes one item,
			// held as U+FFFD (ADR-0030).
			Some(TextTarget::List(items)) => {
				items.push("\u{FFFD}".to_owned());
				items.push("\u{FFFD}".to_owned());
			}
			None => {}
		}
	}

	fn on_close_tag(&mut self, tag: Tag<'_>, _implied: bool) {
		self.close_tag(tag.lower);
	}
}
