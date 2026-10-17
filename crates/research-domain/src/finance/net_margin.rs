//! Port of `packages/domain/src/finance/netMargin.ts`.

use super::types::{AccountingStandard, Money, ReportingPeriod, is_same_reporting_period};

/// `NetMarginError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum NetMarginError {
	/// `NON_FINITE`.
	#[error("NON_FINITE")]
	NonFinite,
	/// `NON_POSITIVE_REVENUE`.
	#[error("NON_POSITIVE_REVENUE")]
	NonPositiveRevenue,
	/// `CURRENCY_MISMATCH`.
	#[error("CURRENCY_MISMATCH")]
	CurrencyMismatch,
	/// `PERIOD_MISMATCH`.
	#[error("PERIOD_MISMATCH")]
	PeriodMismatch,
	/// `ACCOUNTING_STANDARD_MISMATCH`.
	#[error("ACCOUNTING_STANDARD_MISMATCH")]
	AccountingStandardMismatch,
	/// `CONTINUING_OPERATIONS_POLICY_MISMATCH`.
	#[error("CONTINUING_OPERATIONS_POLICY_MISMATCH")]
	ContinuingOperationsPolicyMismatch,
}

impl NetMarginError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NonFinite => "NON_FINITE",
			Self::NonPositiveRevenue => "NON_POSITIVE_REVENUE",
			Self::CurrencyMismatch => "CURRENCY_MISMATCH",
			Self::PeriodMismatch => "PERIOD_MISMATCH",
			Self::AccountingStandardMismatch => "ACCOUNTING_STANDARD_MISMATCH",
			Self::ContinuingOperationsPolicyMismatch => "CONTINUING_OPERATIONS_POLICY_MISMATCH",
		}
	}
}

/// `ContinuingOperationsPolicy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ContinuingOperationsPolicy {
	/// `total`.
	Total,
	/// `continuing-only`.
	ContinuingOnly,
}

/// `IncomeFigure`.
#[derive(Clone, Debug, PartialEq)]
pub struct IncomeFigure {
	/// The amount.
	pub amount: Money,
	/// The period it covers.
	pub period: ReportingPeriod,
	/// Its accounting basis.
	pub accounting_standard: AccountingStandard,
	/// Whether discontinued operations are included.
	pub continuing_operations_policy: ContinuingOperationsPolicy,
}

/// `NetProfitMargin` (`formula` is always `"net income / revenue"`).
#[derive(Clone, Debug, PartialEq)]
pub struct NetProfitMargin {
	/// Ratio, e.g. 0.12 for 12%. May be negative for a net loss.
	pub margin_ratio: f64,
	/// The revenue's currency.
	pub currency: String,
	/// The revenue's period.
	pub period: ReportingPeriod,
	/// The revenue's accounting basis.
	pub accounting_standard: AccountingStandard,
	/// The revenue's continuing-operations policy.
	pub continuing_operations_policy: ContinuingOperationsPolicy,
}

impl NetProfitMargin {
	/// The `formula` field.
	pub const FORMULA: &'static str = "net income / revenue";
}

/// `computeNetProfitMargin`: net income / revenue for the same reporting
/// period, currency and accounting basis.
///
/// # Errors
///
/// The first failing check, in the TypeScript's order.
pub fn compute_net_profit_margin(
	net_income: &IncomeFigure,
	revenue: &IncomeFigure,
) -> Result<NetProfitMargin, NetMarginError> {
	if !net_income.amount.amount.is_finite() || !revenue.amount.amount.is_finite() {
		return Err(NetMarginError::NonFinite);
	}
	if net_income.amount.currency != revenue.amount.currency {
		return Err(NetMarginError::CurrencyMismatch);
	}
	if !is_same_reporting_period(&net_income.period, &revenue.period) {
		return Err(NetMarginError::PeriodMismatch);
	}
	if net_income.accounting_standard != revenue.accounting_standard {
		return Err(NetMarginError::AccountingStandardMismatch);
	}
	if net_income.continuing_operations_policy != revenue.continuing_operations_policy {
		return Err(NetMarginError::ContinuingOperationsPolicyMismatch);
	}
	if revenue.amount.amount <= 0.0 {
		return Err(NetMarginError::NonPositiveRevenue);
	}
	let margin_ratio = net_income.amount.amount / revenue.amount.amount;
	if !margin_ratio.is_finite() {
		return Err(NetMarginError::NonFinite);
	}
	Ok(NetProfitMargin {
		margin_ratio,
		currency: revenue.amount.currency.clone(),
		period: revenue.period.clone(),
		accounting_standard: revenue.accounting_standard,
		continuing_operations_policy: revenue.continuing_operations_policy,
	})
}
