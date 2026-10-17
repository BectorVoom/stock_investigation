//! Port of `core/sizes.ts`: three fixed sizes on a grid of equal cells with
//! a fixed row height. These numbers are the single source of truth
//! (`solid/styles.css` states the same grid in CSS).

use super::types::WidgetSize;

/// Every size, smallest first.
pub const WIDGET_SIZES: [WidgetSize; 3] =
	[WidgetSize::Small, WidgetSize::Medium, WidgetSize::Large];

/// `WidgetGridMetrics`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WidgetGridMetrics {
	/// Columns below the wide breakpoint.
	pub narrow_columns: u32,
	/// Columns at and above the wide breakpoint.
	pub wide_columns: u32,
	/// Viewport width (rem) at which the grid switches to `wide_columns`.
	pub wide_min_width_rem: f64,
	/// Container width (rem) at which a container-sized grid switches.
	pub container_wide_min_width_rem: f64,
	/// Fixed height of one grid row (rem).
	pub row_height_rem: f64,
	/// Gap between cells, both axes (rem).
	pub gap_rem: f64,
}

/// `WIDGET_GRID_METRICS`.
pub const WIDGET_GRID_METRICS: WidgetGridMetrics = WidgetGridMetrics {
	narrow_columns: 2,
	wide_columns: 4,
	wide_min_width_rem: 64.0,
	container_wide_min_width_rem: 40.0,
	row_height_rem: 17.0,
	gap_rem: 1.0,
};

/// How many grid cells one widget covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidgetCellSpan {
	/// Columns covered.
	pub columns: u32,
	/// Rows covered.
	pub rows: u32,
}

/// The cells of a size below and at/above the wide breakpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidgetSizeSpan {
	/// Below the wide breakpoint.
	pub narrow: WidgetCellSpan,
	/// At and above the wide breakpoint.
	pub wide: WidgetCellSpan,
}

/// `WIDGET_SIZE_SPANS`: Small is one cell; Medium is 2 × 2; Large is the
/// full width × 2 at the wide breakpoint and 2 × 2 below it.
#[must_use]
pub const fn widget_size_span(size: WidgetSize) -> WidgetSizeSpan {
	match size {
		WidgetSize::Small => WidgetSizeSpan {
			narrow: WidgetCellSpan {
				columns: 1,
				rows: 1,
			},
			wide: WidgetCellSpan {
				columns: 1,
				rows: 1,
			},
		},
		WidgetSize::Medium => WidgetSizeSpan {
			narrow: WidgetCellSpan {
				columns: 2,
				rows: 2,
			},
			wide: WidgetCellSpan {
				columns: 2,
				rows: 2,
			},
		},
		WidgetSize::Large => WidgetSizeSpan {
			narrow: WidgetCellSpan {
				columns: 2,
				rows: 2,
			},
			wide: WidgetCellSpan {
				columns: 4,
				rows: 2,
			},
		},
	}
}

/// `WIDGET_SIZE_SHAPES`: the shape of each size in words.
#[must_use]
pub const fn widget_size_shape(size: WidgetSize) -> &'static str {
	match size {
		WidgetSize::Small => "1 × 1",
		WidgetSize::Medium => "2 × 2",
		WidgetSize::Large => "full width × 2",
	}
}

/// `widgetHeightRem`: the rows plus the gaps between them.
#[must_use]
pub fn widget_height_rem(rows: u32, metrics: &WidgetGridMetrics) -> f64 {
	f64::from(rows) * metrics.row_height_rem + f64::from(rows.saturating_sub(1)) * metrics.gap_rem
}
