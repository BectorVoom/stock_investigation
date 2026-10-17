//! Tag names as small integers.
//!
//! htmlparser2 keeps its open-element stack as an array of strings and
//! scans it (`indexOf`, `includes`) on every close tag — O(depth) per tag,
//! the residual ADR-0030 removes. Here every name the parser or the converter
//! treats specially is a variant of [`Known`] (resolved by one `match`, no
//! hashing), and any other name is interned once per document. The parser's
//! and the converter's per-name position stacks are then plain vectors
//! indexed by [`NameId`].

use std::collections::HashMap;

/// A tag name: a [`Known`] variant or a name interned by [`Names`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct NameId(u32);

impl NameId {
	/// The name of a [`Known`] variant.
	#[must_use]
	pub const fn known(known: Known) -> Self {
		Self(known as u32)
	}

	/// The [`Known`] variant, if this is one.
	#[must_use]
	pub fn as_known(self) -> Option<Known> {
		usize::try_from(self.0)
			.ok()
			.and_then(|index| KNOWN.get(index))
			.map(|&(known, _)| known)
	}

	/// Position in per-name tables.
	#[must_use]
	pub fn index(self) -> usize {
		usize::try_from(self.0).unwrap_or(usize::MAX)
	}
}

macro_rules! known_names {
	($($variant:ident => $text:literal,)*) => {
		/// Every tag name htmlparser2 or the converter special-cases.
		#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
		#[repr(u32)]
		#[allow(missing_docs)]
		pub enum Known { $($variant,)* }

		/// `(variant, name)` in discriminant order.
		const KNOWN: &[(Known, &str)] = &[$((Known::$variant, $text),)*];

		fn lookup_known(name: &str) -> Option<Known> {
			match name {
				$($text => Some(Known::$variant),)*
				_ => None,
			}
		}
	};
}

known_names! {
	A => "a",
	Address => "address",
	AnnotationXml => "annotation-xml",
	Area => "area",
	Article => "article",
	Aside => "aside",
	B => "b",
	Base => "base",
	Basefont => "basefont",
	Blockquote => "blockquote",
	Body => "body",
	Br => "br",
	Button => "button",
	Canvas => "canvas",
	Code => "code",
	Col => "col",
	Command => "command",
	Datalist => "datalist",
	Dd => "dd",
	Desc => "desc",
	Details => "details",
	Div => "div",
	Dl => "dl",
	Dt => "dt",
	Em => "em",
	Embed => "embed",
	Fieldset => "fieldset",
	Figcaption => "figcaption",
	Figure => "figure",
	Footer => "footer",
	Form => "form",
	Frame => "frame",
	H1 => "h1",
	H2 => "h2",
	H3 => "h3",
	H4 => "h4",
	H5 => "h5",
	H6 => "h6",
	Head => "head",
	Header => "header",
	Hgroup => "hgroup",
	Hr => "hr",
	Html => "html",
	I => "i",
	Iframe => "iframe",
	Image => "image",
	Img => "img",
	Input => "input",
	Isindex => "isindex",
	Keygen => "keygen",
	Li => "li",
	Link => "link",
	Main => "main",
	Math => "math",
	Meta => "meta",
	Mi => "mi",
	Mn => "mn",
	Mo => "mo",
	Ms => "ms",
	Mtext => "mtext",
	Nav => "nav",
	Noscript => "noscript",
	Object => "object",
	Ol => "ol",
	Optgroup => "optgroup",
	Option => "option",
	Output => "output",
	P => "p",
	Param => "param",
	Pre => "pre",
	Rp => "rp",
	Rt => "rt",
	Script => "script",
	Search => "search",
	Section => "section",
	Select => "select",
	Source => "source",
	Span => "span",
	Strong => "strong",
	Style => "style",
	Summary => "summary",
	Svg => "svg",
	Table => "table",
	Tbody => "tbody",
	Td => "td",
	Template => "template",
	Textarea => "textarea",
	Tfoot => "tfoot",
	Th => "th",
	Thead => "thead",
	Title => "title",
	Tr => "tr",
	Track => "track",
	Ul => "ul",
	Wbr => "wbr",
	// SVG tag-name adjustments (`svgTagNameAdjustments`): lower-case form, then adjusted form.
	Altglyph => "altglyph",
	AltGlyph => "altGlyph",
	Altglyphdef => "altglyphdef",
	AltGlyphDef => "altGlyphDef",
	Altglyphitem => "altglyphitem",
	AltGlyphItem => "altGlyphItem",
	Animatecolor => "animatecolor",
	AnimateColor => "animateColor",
	Animatemotion => "animatemotion",
	AnimateMotion => "animateMotion",
	Animatetransform => "animatetransform",
	AnimateTransform => "animateTransform",
	Clippath => "clippath",
	ClipPath => "clipPath",
	Feblend => "feblend",
	FeBlend => "feBlend",
	Fecolormatrix => "fecolormatrix",
	FeColorMatrix => "feColorMatrix",
	Fecomponenttransfer => "fecomponenttransfer",
	FeComponentTransfer => "feComponentTransfer",
	Fecomposite => "fecomposite",
	FeComposite => "feComposite",
	Feconvolvematrix => "feconvolvematrix",
	FeConvolveMatrix => "feConvolveMatrix",
	Fediffuselighting => "fediffuselighting",
	FeDiffuseLighting => "feDiffuseLighting",
	Fedisplacementmap => "fedisplacementmap",
	FeDisplacementMap => "feDisplacementMap",
	Fedistantlight => "fedistantlight",
	FeDistantLight => "feDistantLight",
	Fedropshadow => "fedropshadow",
	FeDropShadow => "feDropShadow",
	Feflood => "feflood",
	FeFlood => "feFlood",
	Fefunca => "fefunca",
	FeFuncA => "feFuncA",
	Fefuncb => "fefuncb",
	FeFuncB => "feFuncB",
	Fefuncg => "fefuncg",
	FeFuncG => "feFuncG",
	Fefuncr => "fefuncr",
	FeFuncR => "feFuncR",
	Fegaussianblur => "fegaussianblur",
	FeGaussianBlur => "feGaussianBlur",
	Feimage => "feimage",
	FeImage => "feImage",
	Femerge => "femerge",
	FeMerge => "feMerge",
	Femergenode => "femergenode",
	FeMergeNode => "feMergeNode",
	Femorphology => "femorphology",
	FeMorphology => "feMorphology",
	Feoffset => "feoffset",
	FeOffset => "feOffset",
	Fepointlight => "fepointlight",
	FePointLight => "fePointLight",
	Fespecularlighting => "fespecularlighting",
	FeSpecularLighting => "feSpecularLighting",
	Fespotlight => "fespotlight",
	FeSpotLight => "feSpotLight",
	Fetile => "fetile",
	FeTile => "feTile",
	Feturbulence => "feturbulence",
	FeTurbulence => "feTurbulence",
	Foreignobject => "foreignobject",
	ForeignObject => "foreignObject",
	Glyphref => "glyphref",
	GlyphRef => "glyphRef",
	Lineargradient => "lineargradient",
	LinearGradient => "linearGradient",
	Radialgradient => "radialgradient",
	RadialGradient => "radialGradient",
	Textpath => "textpath",
	TextPath => "textPath",
}

impl Known {
	/// `svgTagNameAdjustments`: the camel-case SVG name for a lower-case one.
	#[must_use]
	pub const fn svg_adjusted(self) -> Option<Self> {
		use Known as K;
		Some(match self {
			K::Altglyph => K::AltGlyph,
			K::Altglyphdef => K::AltGlyphDef,
			K::Altglyphitem => K::AltGlyphItem,
			K::Animatecolor => K::AnimateColor,
			K::Animatemotion => K::AnimateMotion,
			K::Animatetransform => K::AnimateTransform,
			K::Clippath => K::ClipPath,
			K::Feblend => K::FeBlend,
			K::Fecolormatrix => K::FeColorMatrix,
			K::Fecomponenttransfer => K::FeComponentTransfer,
			K::Fecomposite => K::FeComposite,
			K::Feconvolvematrix => K::FeConvolveMatrix,
			K::Fediffuselighting => K::FeDiffuseLighting,
			K::Fedisplacementmap => K::FeDisplacementMap,
			K::Fedistantlight => K::FeDistantLight,
			K::Fedropshadow => K::FeDropShadow,
			K::Feflood => K::FeFlood,
			K::Fefunca => K::FeFuncA,
			K::Fefuncb => K::FeFuncB,
			K::Fefuncg => K::FeFuncG,
			K::Fefuncr => K::FeFuncR,
			K::Fegaussianblur => K::FeGaussianBlur,
			K::Feimage => K::FeImage,
			K::Femerge => K::FeMerge,
			K::Femergenode => K::FeMergeNode,
			K::Femorphology => K::FeMorphology,
			K::Feoffset => K::FeOffset,
			K::Fepointlight => K::FePointLight,
			K::Fespecularlighting => K::FeSpecularLighting,
			K::Fespotlight => K::FeSpotLight,
			K::Fetile => K::FeTile,
			K::Feturbulence => K::FeTurbulence,
			K::Foreignobject => K::ForeignObject,
			K::Glyphref => K::GlyphRef,
			K::Lineargradient => K::LinearGradient,
			K::Radialgradient => K::RadialGradient,
			K::Textpath => K::TextPath,
			_ => return None,
		})
	}

	/// The lower-case form (`String.prototype.toLowerCase`) of a known name.
	#[must_use]
	pub const fn lower_case(self) -> Self {
		use Known as K;
		match self {
			K::AltGlyph => K::Altglyph,
			K::AltGlyphDef => K::Altglyphdef,
			K::AltGlyphItem => K::Altglyphitem,
			K::AnimateColor => K::Animatecolor,
			K::AnimateMotion => K::Animatemotion,
			K::AnimateTransform => K::Animatetransform,
			K::ClipPath => K::Clippath,
			K::FeBlend => K::Feblend,
			K::FeColorMatrix => K::Fecolormatrix,
			K::FeComponentTransfer => K::Fecomponenttransfer,
			K::FeComposite => K::Fecomposite,
			K::FeConvolveMatrix => K::Feconvolvematrix,
			K::FeDiffuseLighting => K::Fediffuselighting,
			K::FeDisplacementMap => K::Fedisplacementmap,
			K::FeDistantLight => K::Fedistantlight,
			K::FeDropShadow => K::Fedropshadow,
			K::FeFlood => K::Feflood,
			K::FeFuncA => K::Fefunca,
			K::FeFuncB => K::Fefuncb,
			K::FeFuncG => K::Fefuncg,
			K::FeFuncR => K::Fefuncr,
			K::FeGaussianBlur => K::Fegaussianblur,
			K::FeImage => K::Feimage,
			K::FeMerge => K::Femerge,
			K::FeMergeNode => K::Femergenode,
			K::FeMorphology => K::Femorphology,
			K::FeOffset => K::Feoffset,
			K::FePointLight => K::Fepointlight,
			K::FeSpecularLighting => K::Fespecularlighting,
			K::FeSpotLight => K::Fespotlight,
			K::FeTile => K::Fetile,
			K::FeTurbulence => K::Feturbulence,
			K::ForeignObject => K::Foreignobject,
			K::GlyphRef => K::Glyphref,
			K::LinearGradient => K::Lineargradient,
			K::RadialGradient => K::Radialgradient,
			K::TextPath => K::Textpath,
			other => other,
		}
	}

	/// htmlparser2's `voidElements`.
	#[must_use]
	pub const fn is_parser_void(self) -> bool {
		use Known as K;
		matches!(
			self,
			K::Area
				| K::Base | K::Basefont
				| K::Br | K::Col
				| K::Command | K::Embed
				| K::Frame | K::Hr
				| K::Img | K::Input
				| K::Isindex | K::Keygen
				| K::Link | K::Meta
				| K::Param | K::Source
				| K::Track | K::Wbr
		)
	}

	/// `htmlIntegrationElements` (SVG-adjusted casing).
	#[must_use]
	pub const fn is_html_integration(self) -> bool {
		use Known as K;
		matches!(
			self,
			K::Mi
				| K::Mo | K::Mn
				| K::Ms | K::Mtext
				| K::AnnotationXml
				| K::ForeignObject
				| K::Desc | K::Title
		)
	}
}

/// Per-document table of tag names: [`Known`] names by `match`, any other
/// name interned on first sight.
#[derive(Default)]
pub struct Names {
	map: HashMap<Box<str>, NameId>,
	/// Text and lower-case form of each interned name, by `index - KNOWN.len()`.
	dynamic: Vec<(Box<str>, NameId)>,
}

impl Names {
	/// The id of `name`, interning it if needed.
	pub fn intern(&mut self, name: &str) -> NameId {
		if let Some(known) = lookup_known(name) {
			return NameId::known(known);
		}
		if let Some(&id) = self.map.get(name) {
			return id;
		}
		let id = self.push(name);
		// The converter lower-cases every name again (JavaScript `toLowerCase`);
		// for nearly every name that is the name itself.
		let lower = name.to_lowercase();
		let lower_id = if lower == name {
			id
		} else {
			self.intern(&lower)
		};
		if let Some(entry) = self.dynamic.get_mut(id.index().saturating_sub(KNOWN.len())) {
			entry.1 = lower_id;
		}
		id
	}

	fn push(&mut self, name: &str) -> NameId {
		let index = KNOWN.len() + self.dynamic.len();
		let id = NameId(u32::try_from(index).unwrap_or(u32::MAX));
		self.dynamic.push((name.into(), id));
		self.map.insert(name.into(), id);
		id
	}

	/// The text of a name.
	#[must_use]
	pub fn text(&self, id: NameId) -> &str {
		match id.index().checked_sub(KNOWN.len()) {
			None => KNOWN.get(id.index()).map_or("", |&(_, text)| text),
			Some(offset) => self.dynamic.get(offset).map_or("", |(text, _)| text),
		}
	}

	/// The id of `toLowerCase()` of a name.
	#[must_use]
	pub fn lower_case(&self, id: NameId) -> NameId {
		match id.index().checked_sub(KNOWN.len()) {
			None => id
				.as_known()
				.map_or(id, |known| NameId::known(known.lower_case())),
			Some(offset) => self.dynamic.get(offset).map_or(id, |&(_, lower)| lower),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn known_table_matches_discriminants_and_lower_cases() {
		for (index, &(known, text)) in KNOWN.iter().enumerate() {
			assert_eq!(known as usize, index);
			assert_eq!(lookup_known(text), Some(known));
			assert_eq!(KNOWN[known.lower_case() as usize].1, text.to_lowercase());
			if let Some(adjusted) = known.svg_adjusted() {
				assert_eq!(KNOWN[adjusted as usize].1.to_lowercase(), text);
			}
		}
	}

	#[test]
	fn interns_unknown_names_with_their_lower_case() {
		let mut names = Names::default();
		let custom = names.intern("x-foo");
		assert_eq!(names.intern("x-foo"), custom);
		assert_eq!(names.text(custom), "x-foo");
		assert_eq!(names.lower_case(custom), custom);
		let upper = names.intern("Ab");
		assert_eq!(names.text(names.lower_case(upper)), "ab");
		assert_eq!(names.intern("div"), NameId::known(Known::Div));
		assert_eq!(
			names.lower_case(NameId::known(Known::ClipPath)),
			NameId::known(Known::Clippath)
		);
	}
}
