//! Port of `core/types.ts`: the shared vocabulary of the widget grid.

use std::fmt;

/// The three fixed widget sizes (Apple HIG Widgets: fixed sizes on a grid of equal cells).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WidgetSize {
	/// One cell.
	Small,
	/// 2 × 2.
	Medium,
	/// Full width × 2.
	Large,
}

impl WidgetSize {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Small => "small",
			Self::Medium => "medium",
			Self::Large => "large",
		}
	}

	/// `isWidgetSize` + parse.
	#[must_use]
	pub fn parse(value: &str) -> Option<Self> {
		match value {
			"small" => Some(Self::Small),
			"medium" => Some(Self::Medium),
			"large" => Some(Self::Large),
			_ => None,
		}
	}
}

impl fmt::Display for WidgetSize {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

/// What the grid and the agent layer need to know about one widget
/// (`WidgetBase`). A host's own widget type carries its configuration
/// besides; it stays opaque here. (The TypeScript's runtime size check is
/// the type: a `WidgetSize` is always valid.)
pub trait WidgetBase: Clone {
	/// Unique within one grid.
	fn widget_id(&self) -> &str;
	/// Key of the host's widget type.
	fn widget_type(&self) -> &str;
	/// The title.
	fn title(&self) -> &str;
	/// The size.
	fn size(&self) -> WidgetSize;
	/// `{ ...widget, size }`.
	#[must_use]
	fn with_size(&self, size: WidgetSize) -> Self;
}
