//! The parts of `packages/domain/src/market/dashboard.ts` the runner
//! reaches through the contracts (notebook capacity, claim checks): the
//! dashboard bounds and the series walk. `applyDashboardEdit` is the Home
//! page's (API) and is not ported; its Lean vectors are replayed against the
//! widget-grid layout edits, which mirror it.

/// `DASHBOARD_LIMITS`: the single definition of every dashboard bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DashboardLimits {
	/// Widgets on one dashboard.
	pub max_widgets: usize,
	/// Distinct market series on one dashboard.
	pub max_series: usize,
	/// Series of one line chart.
	pub max_line_chart_series: usize,
	/// Series of one table.
	pub max_table_series: usize,
	/// Shortest widget title (UTF-16 units).
	pub min_widget_title: usize,
	/// One title rule for every widget on every page (ADR-0024).
	pub max_widget_title: usize,
}

/// `DASHBOARD_LIMITS`.
pub const DASHBOARD_LIMITS: DashboardLimits = DashboardLimits {
	max_widgets: 24,
	max_series: 30,
	max_line_chart_series: 4,
	max_table_series: 12,
	min_widget_title: 1,
	max_widget_title: 120,
};

/// Days-ahead choices the earnings-calendar widget offers (SPEC section 2).
pub const EARNINGS_CALENDAR_DAYS_AHEAD: [u32; 4] = [30, 60, 90, 180];

/// A widget that may name market series (`dashboardWidgetSeriesIds`):
/// `market-metric` names one, `line-chart`, `stock-table` and
/// `indicator-table` name a list, every other type names none.
pub trait DashboardWidgetSeries {
	/// The market series this widget names, in its own order.
	fn series_ids(&self) -> &[String];
}

/// `distinctDashboardSeriesIds`: the distinct series of a dashboard (or a
/// notebook), in widget order — the ONE implementation.
#[must_use]
pub fn distinct_dashboard_series_ids<W: DashboardWidgetSeries>(widgets: &[W]) -> Vec<&str> {
	let mut seen = std::collections::HashSet::new();
	let mut ids = Vec::new();
	for widget in widgets {
		for id in widget.series_ids() {
			if seen.insert(id.as_str()) {
				ids.push(id.as_str());
			}
		}
	}
	ids
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Widget(Vec<String>);

	impl DashboardWidgetSeries for Widget {
		fn series_ids(&self) -> &[String] {
			&self.0
		}
	}

	#[test]
	fn keeps_first_seen_order() {
		let widgets = [
			Widget(vec!["b".to_owned(), "a".to_owned()]),
			Widget(vec![]),
			Widget(vec!["a".to_owned(), "c".to_owned()]),
		];
		assert_eq!(distinct_dashboard_series_ids(&widgets), ["b", "a", "c"]);
	}
}
