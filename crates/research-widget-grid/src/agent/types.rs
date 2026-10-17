//! Port of `agent/types.ts`: commands and failures.

use research_js::json::Object;

use crate::core::layout::MoveDirection;
use crate::core::types::WidgetSize;

/// Version of the command protocol; a snapshot states the version it speaks.
pub const WIDGET_AGENT_PROTOCOL_VERSION: u32 = 1;

/// One parsed instruction from an agent (`WidgetCommand`).
#[derive(Clone, Debug, PartialEq)]
pub enum WidgetCommand {
	/// A new widget of a registered type.
	Add {
		/// The registered type.
		widget_type: String,
		/// The title (trimmed).
		title: String,
		/// Defaults to the type's default size.
		size: Option<WidgetSize>,
		/// The type-specific configuration.
		config: Option<Object>,
		/// 0-based final position (default: last).
		to_index: Option<usize>,
	},
	/// Delete one widget.
	Remove {
		/// Its id.
		widget_id: String,
	},
	/// Swap with the neighbour one position earlier or later.
	Move {
		/// Its id.
		widget_id: String,
		/// Which neighbour.
		direction: MoveDirection,
	},
	/// End at `to_index`, the others keeping their order.
	Reorder {
		/// Its id.
		widget_id: String,
		/// 0-based final position.
		to_index: usize,
	},
	/// Change the size to one the type allows.
	Resize {
		/// Its id.
		widget_id: String,
		/// The new size.
		size: WidgetSize,
	},
	/// Rename and/or reconfigure (a shallow merge of `config`).
	Update {
		/// Its id.
		widget_id: String,
		/// The new title (trimmed).
		title: Option<String>,
		/// Keys that replace the current configuration's.
		config: Option<Object>,
	},
	/// Copy through the widget's own type with a fresh id.
	Duplicate {
		/// The original's id.
		widget_id: String,
		/// Defaults to `"<title> (copy)"`.
		title: Option<String>,
		/// Defaults to right after the original.
		to_index: Option<usize>,
	},
}

/// Stable failure codes an agent can branch on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WidgetAgentFailureCode {
	/// The input did not match the command schema.
	InvalidCommand,
	/// `UNKNOWN_WIDGET_TYPE`.
	UnknownWidgetType,
	/// `SIZE_NOT_ALLOWED`.
	SizeNotAllowed,
	/// The widget type or the host rejected the widget or the layout.
	InvalidWidget,
	/// `WIDGET_NOT_FOUND`.
	WidgetNotFound,
	/// `DUPLICATE_WIDGET_ID`.
	DuplicateWidgetId,
	/// `MOVE_AT_END`.
	MoveAtEnd,
	/// `POSITION_OUT_OF_RANGE`.
	PositionOutOfRange,
	/// `TOO_MANY_WIDGETS`.
	TooManyWidgets,
	/// The layout changed between read and write.
	Conflict,
	/// The store could not be read or written.
	StoreUnavailable,
	/// `UNKNOWN_TOOL`.
	UnknownTool,
}

impl WidgetAgentFailureCode {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidCommand => "INVALID_COMMAND",
			Self::UnknownWidgetType => "UNKNOWN_WIDGET_TYPE",
			Self::SizeNotAllowed => "SIZE_NOT_ALLOWED",
			Self::InvalidWidget => "INVALID_WIDGET",
			Self::WidgetNotFound => "WIDGET_NOT_FOUND",
			Self::DuplicateWidgetId => "DUPLICATE_WIDGET_ID",
			Self::MoveAtEnd => "MOVE_AT_END",
			Self::PositionOutOfRange => "POSITION_OUT_OF_RANGE",
			Self::TooManyWidgets => "TOO_MANY_WIDGETS",
			Self::Conflict => "CONFLICT",
			Self::StoreUnavailable => "STORE_UNAVAILABLE",
			Self::UnknownTool => "UNKNOWN_TOOL",
		}
	}
}

/// A typed failure with one sentence an agent can act on.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct WidgetAgentFailure {
	/// The code.
	pub code: WidgetAgentFailureCode,
	/// The sentence.
	pub message: String,
}

impl WidgetAgentFailure {
	/// A failure from a code and a sentence.
	#[must_use]
	pub fn new(code: WidgetAgentFailureCode, message: impl Into<String>) -> Self {
		Self {
			code,
			message: message.into(),
		}
	}
}
