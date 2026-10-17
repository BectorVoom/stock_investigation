//! Port of `core/layout.ts`: pure layout edits, the counterpart of the
//! domain's `applyDashboardEdit` (the Lean dashboard vectors are replayed
//! against this). `add` appends, `remove` deletes one widget, `move` swaps
//! with the neighbour, `reorder` lands the widget at `to_index` of the
//! result while the others keep their relative order (one pass), `replace`
//! swaps the widget under the same id at the same position, `resize`
//! changes one size. `add` with `to_index` is "append, then reorder".

use super::types::{WidgetBase, WidgetSize};

/// `WidgetLayoutLimits`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidgetLayoutLimits {
	/// Widgets one grid may hold.
	pub max_widgets: usize,
}

/// `DEFAULT_WIDGET_LAYOUT_LIMITS` (Home's 24).
pub const DEFAULT_WIDGET_LAYOUT_LIMITS: WidgetLayoutLimits = WidgetLayoutLimits { max_widgets: 24 };

/// Which way a `move` goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveDirection {
	/// One position earlier.
	Earlier,
	/// One position later.
	Later,
}

impl MoveDirection {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Earlier => "earlier",
			Self::Later => "later",
		}
	}
}

/// `WidgetLayoutEdit`.
#[derive(Clone, Debug, PartialEq)]
pub enum WidgetLayoutEdit<W> {
	/// Append (then reorder to `to_index` when given).
	Add {
		/// The new widget.
		widget: W,
		/// Final position, `0..=len`.
		to_index: Option<usize>,
	},
	/// Delete one widget.
	Remove {
		/// Its id.
		widget_id: String,
	},
	/// Swap with a neighbour.
	Move {
		/// Its id.
		widget_id: String,
		/// Which neighbour.
		direction: MoveDirection,
	},
	/// Land at `to_index`, the others keeping their order.
	Reorder {
		/// Its id.
		widget_id: String,
		/// Final position.
		to_index: usize,
	},
	/// Change one size.
	Resize {
		/// Its id.
		widget_id: String,
		/// The new size.
		size: WidgetSize,
	},
	/// Swap the widget with the same id in place.
	Replace {
		/// The replacement.
		widget: W,
	},
}

/// `WidgetLayoutError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WidgetLayoutError {
	/// `DUPLICATE_WIDGET_ID`.
	#[error("DUPLICATE_WIDGET_ID")]
	DuplicateWidgetId,
	/// `WIDGET_NOT_FOUND`.
	#[error("WIDGET_NOT_FOUND")]
	WidgetNotFound,
	/// `MOVE_AT_END`.
	#[error("MOVE_AT_END")]
	MoveAtEnd,
	/// `POSITION_OUT_OF_RANGE`.
	#[error("POSITION_OUT_OF_RANGE")]
	PositionOutOfRange,
	/// `TOO_MANY_WIDGETS`.
	#[error("TOO_MANY_WIDGETS")]
	TooManyWidgets,
	/// `INVALID_WIDGET`.
	#[error("INVALID_WIDGET")]
	InvalidWidget,
}

impl WidgetLayoutError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::DuplicateWidgetId => "DUPLICATE_WIDGET_ID",
			Self::WidgetNotFound => "WIDGET_NOT_FOUND",
			Self::MoveAtEnd => "MOVE_AT_END",
			Self::PositionOutOfRange => "POSITION_OUT_OF_RANGE",
			Self::TooManyWidgets => "TOO_MANY_WIDGETS",
			Self::InvalidWidget => "INVALID_WIDGET",
		}
	}
}

fn position_of<W: WidgetBase>(widgets: &[W], widget_id: &str) -> Option<usize> {
	widgets
		.iter()
		.position(|widget| widget.widget_id() == widget_id)
}

fn append_widget<W: WidgetBase>(
	widgets: &[W],
	widget: &W,
	limits: WidgetLayoutLimits,
) -> Result<Vec<W>, WidgetLayoutError> {
	if widget.widget_id().is_empty() {
		return Err(WidgetLayoutError::InvalidWidget);
	}
	if position_of(widgets, widget.widget_id()).is_some() {
		return Err(WidgetLayoutError::DuplicateWidgetId);
	}
	if widgets.len() + 1 > limits.max_widgets {
		return Err(WidgetLayoutError::TooManyWidgets);
	}
	let mut next = Vec::with_capacity(widgets.len() + 1);
	next.extend_from_slice(widgets);
	next.push(widget.clone());
	Ok(next)
}

fn reorder_widgets<W: WidgetBase>(
	widgets: &[W],
	widget_id: &str,
	to_index: usize,
) -> Result<Vec<W>, WidgetLayoutError> {
	if widget_id.is_empty() {
		return Err(WidgetLayoutError::InvalidWidget);
	}
	let index = position_of(widgets, widget_id).ok_or(WidgetLayoutError::WidgetNotFound)?;
	if to_index >= widgets.len() {
		return Err(WidgetLayoutError::PositionOutOfRange);
	}
	let moved = widgets
		.get(index)
		.ok_or(WidgetLayoutError::WidgetNotFound)?;
	// One pass over the result positions: the moved widget lands at
	// `to_index` of the result, every other widget keeps its order.
	let mut next = Vec::with_capacity(widgets.len());
	let mut others = widgets
		.iter()
		.enumerate()
		.filter(|(position, _)| *position != index)
		.map(|(_, widget)| widget);
	for target in 0..widgets.len() {
		if target == to_index {
			next.push(moved.clone());
		} else {
			next.push(
				others
					.next()
					.ok_or(WidgetLayoutError::WidgetNotFound)?
					.clone(),
			);
		}
	}
	Ok(next)
}

/// `applyWidgetLayoutEdit`: enforces id uniqueness and the widget limit;
/// `move` at an end is a typed error. Never mutates its input.
///
/// # Errors
///
/// [`WidgetLayoutError`] as the TypeScript returns it.
pub fn apply_widget_layout_edit<W: WidgetBase>(
	widgets: &[W],
	edit: &WidgetLayoutEdit<W>,
	limits: WidgetLayoutLimits,
) -> Result<Vec<W>, WidgetLayoutError> {
	match edit {
		WidgetLayoutEdit::Add { widget, to_index } => {
			let appended = append_widget(widgets, widget, limits)?;
			match to_index {
				// A valid `to_index` is any position of the result, `0..=len`.
				Some(to_index) => reorder_widgets(&appended, widget.widget_id(), *to_index),
				None => Ok(appended),
			}
		}
		WidgetLayoutEdit::Remove { widget_id } => {
			if widget_id.is_empty() {
				return Err(WidgetLayoutError::InvalidWidget);
			}
			if position_of(widgets, widget_id).is_none() {
				return Err(WidgetLayoutError::WidgetNotFound);
			}
			Ok(widgets
				.iter()
				.filter(|widget| widget.widget_id() != widget_id)
				.cloned()
				.collect())
		}
		WidgetLayoutEdit::Move {
			widget_id,
			direction,
		} => {
			if widget_id.is_empty() {
				return Err(WidgetLayoutError::InvalidWidget);
			}
			let index = position_of(widgets, widget_id).ok_or(WidgetLayoutError::WidgetNotFound)?;
			let target = match direction {
				MoveDirection::Earlier => index.checked_sub(1),
				MoveDirection::Later => Some(index + 1).filter(|target| *target < widgets.len()),
			}
			.ok_or(WidgetLayoutError::MoveAtEnd)?;
			let mut next = widgets.to_vec();
			next.swap(index, target);
			Ok(next)
		}
		WidgetLayoutEdit::Reorder {
			widget_id,
			to_index,
		} => reorder_widgets(widgets, widget_id, *to_index),
		WidgetLayoutEdit::Resize { widget_id, size } => {
			if widget_id.is_empty() {
				return Err(WidgetLayoutError::InvalidWidget);
			}
			if position_of(widgets, widget_id).is_none() {
				return Err(WidgetLayoutError::WidgetNotFound);
			}
			Ok(widgets
				.iter()
				.map(|widget| {
					if widget.widget_id() == widget_id {
						widget.with_size(*size)
					} else {
						widget.clone()
					}
				})
				.collect())
		}
		WidgetLayoutEdit::Replace { widget } => {
			if widget.widget_id().is_empty() {
				return Err(WidgetLayoutError::InvalidWidget);
			}
			let index = position_of(widgets, widget.widget_id())
				.ok_or(WidgetLayoutError::WidgetNotFound)?;
			Ok(widgets
				.iter()
				.enumerate()
				.map(|(position, current)| {
					if position == index {
						widget.clone()
					} else {
						current.clone()
					}
				})
				.collect())
		}
	}
}
