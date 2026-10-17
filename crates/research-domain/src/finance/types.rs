//! Port of `packages/domain/src/finance/types.ts`: shared finance vocabulary.

use serde::{Deserialize, Serialize};

/// A market the workspace covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Market {
	/// Japan.
	#[serde(rename = "JP")]
	Jp,
	/// United States.
	#[serde(rename = "US")]
	Us,
}

/// An amount in an ISO 4217 currency.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Money {
	/// The amount.
	pub amount: f64,
	/// ISO 4217 code, e.g. `"JPY"`.
	pub currency: String,
}

/// `AccountingStandard`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AccountingStandard {
	/// `US-GAAP`.
	#[serde(rename = "US-GAAP")]
	UsGaap,
	/// `IFRS`.
	#[serde(rename = "IFRS")]
	Ifrs,
	/// `JGAAP`.
	#[serde(rename = "JGAAP")]
	Jgaap,
	/// `OTHER`.
	#[serde(rename = "OTHER")]
	Other,
}

/// `FiscalPeriod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FiscalPeriod {
	/// Full year.
	#[serde(rename = "FY")]
	Fy,
	/// First quarter.
	#[serde(rename = "Q1")]
	Q1,
	/// Second quarter.
	#[serde(rename = "Q2")]
	Q2,
	/// Third quarter.
	#[serde(rename = "Q3")]
	Q3,
	/// Fourth quarter.
	#[serde(rename = "Q4")]
	Q4,
	/// Trailing twelve months.
	#[serde(rename = "TTM")]
	Ttm,
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

/// `ActualOrEstimate`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActualOrEstimate {
	/// Reported.
	Actual,
	/// Estimated.
	Estimate,
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
