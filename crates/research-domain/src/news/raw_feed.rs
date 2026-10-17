//! The adapter-neutral feed shape a feed parser produces (`RawFeed` in
//! `packages/domain/src/news/feed.ts`). Every field is untrusted text.

/// Which syndication format the feed was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedKind {
	/// RSS 2.0 (or RSS 1.0/RDF, parsed the same way).
	Rss,
	/// Atom 1.0.
	Atom,
}

impl FeedKind {
	/// The TypeScript literal: `"rss"` or `"atom"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Rss => "rss",
			Self::Atom => "atom",
		}
	}
}

/// One entry of a feed, before normalisation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawFeedItem {
	/// Entry title as written (may contain markup).
	pub title: Option<String>,
	/// Entry link as written.
	pub link: Option<String>,
	/// Publication timestamp text as written.
	pub published_text: Option<String>,
	/// Summary or description as written (may contain markup).
	pub summary_text: Option<String>,
}

/// A parsed feed, before normalisation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawFeed {
	/// RSS or Atom.
	pub kind: FeedKind,
	/// Channel/feed title.
	pub title: Option<String>,
	/// The site link the feed names.
	pub site_link: Option<String>,
	/// Entries in document order.
	pub items: Vec<RawFeedItem>,
}
