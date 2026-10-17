//! Port of `packages/domain/src/finance/filings.ts`. 13F filings report
//! end-of-quarter holdings, not trades (FR-008 / DATA-007): changes are
//! "reported position" changes with no execution date.

use crate::literal::js_literal_enum;

js_literal_enum! {
	/// `ReportedPositionChange`.
	pub enum ReportedPositionChange {
		/// `newly-reported-holding`.
		NewlyReportedHolding = "newly-reported-holding",
		/// `increase-in-reported-position`.
		IncreaseInReportedPosition = "increase-in-reported-position",
		/// `decrease-in-reported-position`.
		DecreaseInReportedPosition = "decrease-in-reported-position",
		/// `no-longer-reported`.
		NoLongerReported = "no-longer-reported",
		/// `unchanged-reported-position`.
		UnchangedReportedPosition = "unchanged-reported-position",
		/// `not-reported`.
		NotReported = "not-reported",
	}
}

impl ReportedPositionChange {
	/// `reportedPositionChangePhrase`: short wording that never implies a
	/// dated transaction.
	#[must_use]
	pub const fn phrase(self) -> &'static str {
		match self {
			Self::NewlyReportedHolding => "newly reported holding",
			Self::IncreaseInReportedPosition => "increase in reported position",
			Self::DecreaseInReportedPosition => "decrease in reported position",
			Self::NoLongerReported => "position no longer reported",
			Self::UnchangedReportedPosition => "unchanged reported position",
			Self::NotReported => "no reported position",
		}
	}
}

/// `classifyReportedPositionChange`; `None` means the security was absent
/// from that quarter's filing.
#[must_use]
pub fn classify_reported_position_change(
	previous_reported_shares: Option<f64>,
	current_reported_shares: Option<f64>,
) -> ReportedPositionChange {
	// Absent, non-positive and non-finite share counts all mean "no reported position".
	let reported = |shares: Option<f64>| shares.filter(|value| value.is_finite() && *value > 0.0);
	match (
		reported(previous_reported_shares),
		reported(current_reported_shares),
	) {
		(None, None) => ReportedPositionChange::NotReported,
		(None, Some(_)) => ReportedPositionChange::NewlyReportedHolding,
		(Some(_), None) => ReportedPositionChange::NoLongerReported,
		(Some(previous), Some(current)) if current > previous => {
			ReportedPositionChange::IncreaseInReportedPosition
		}
		(Some(previous), Some(current)) if current < previous => {
			ReportedPositionChange::DecreaseInReportedPosition
		}
		(Some(_), Some(_)) => ReportedPositionChange::UnchangedReportedPosition,
	}
}

/// `ReportedPositionContext`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportedPositionContext {
	/// The filer.
	pub investor_name: String,
	/// The held issuer.
	pub issuer_name: String,
	/// Quarter end the filing reports on (YYYY-MM-DD).
	pub report_period_end: String,
	/// Filing date.
	pub filed_at: String,
	/// Form type, e.g. `13F-HR`.
	pub form: String,
}

/// `describeReportedPositionChange`: wording that never implies a verified,
/// dated transaction.
#[must_use]
pub fn describe_reported_position_change(
	change: ReportedPositionChange,
	context: &ReportedPositionContext,
) -> String {
	format!(
		"{}: {} in {} as of {} ({} filed {}; quarter-end holdings, not a dated transaction).",
		context.investor_name,
		change.phrase(),
		context.issuer_name,
		context.report_period_end,
		context.form,
		context.filed_at
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn classifies_changes() {
		assert_eq!(
			classify_reported_position_change(None, Some(0.0)),
			ReportedPositionChange::NotReported
		);
		assert_eq!(
			classify_reported_position_change(Some(f64::NAN), Some(5.0)),
			ReportedPositionChange::NewlyReportedHolding
		);
		assert_eq!(
			classify_reported_position_change(Some(5.0), Some(5.0)),
			ReportedPositionChange::UnchangedReportedPosition
		);
	}
}
