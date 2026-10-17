//! Port of `packages/domain/src/finance/types.ts`: shared finance vocabulary.

use serde::{Deserialize, Serialize};

use crate::literal::js_literal_enum;

js_literal_enum! {
	/// A market the workspace covers (`marketSchema`).
	pub enum Market {
		/// Japan.
		Jp = "JP",
		/// United States.
		Us = "US",
	}
}

/// An amount in an ISO 4217 currency.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Money {
	/// The amount.
	pub amount: f64,
	/// ISO 4217 code, e.g. `"JPY"`.
	pub currency: String,
}

js_literal_enum! {
	/// `AccountingStandard`.
	pub enum AccountingStandard {
		/// `US-GAAP`.
		UsGaap = "US-GAAP",
		/// `IFRS`.
		Ifrs = "IFRS",
		/// `JGAAP`.
		Jgaap = "JGAAP",
		/// `OTHER`.
		Other = "OTHER",
	}
}

js_literal_enum! {
	/// `FiscalPeriod`.
	pub enum FiscalPeriod {
		/// Full year.
		Fy = "FY",
		/// First quarter.
		Q1 = "Q1",
		/// Second quarter.
		Q2 = "Q2",
		/// Third quarter.
		Q3 = "Q3",
		/// Fourth quarter.
		Q4 = "Q4",
		/// Trailing twelve months.
		Ttm = "TTM",
	}
}

/// `ReportingPeriod`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportingPeriod {
	/// Fiscal year.
	pub fiscal_year: f64,
	/// Period within it.
	pub fiscal_period: FiscalPeriod,
	/// Inclusive ISO date (YYYY-MM-DD).
	pub period_start: String,
	/// Inclusive ISO date (YYYY-MM-DD).
	pub period_end: String,
}

js_literal_enum! {
	/// `ActualOrEstimate`.
	pub enum ActualOrEstimate {
		/// Reported.
		Actual = "actual",
		/// Estimated.
		Estimate = "estimate",
	}
}

/// `AdjustmentBasis`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdjustmentBasis {
	/// `split-adjusted`.
	SplitAdjusted,
	/// `unadjusted`.
	Unadjusted,
}

/// `isSameReportingPeriod` (`===` on every field: `NaN` years never match).
#[must_use]
pub fn is_same_reporting_period(a: &ReportingPeriod, b: &ReportingPeriod) -> bool {
	a.fiscal_year == b.fiscal_year
		&& a.fiscal_period == b.fiscal_period
		&& a.period_start == b.period_start
		&& a.period_end == b.period_end
}
