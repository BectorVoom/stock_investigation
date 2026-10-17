//! Port of `packages/domain/src/finance/per.ts`.

use super::types::{ActualOrEstimate, AdjustmentBasis, Money, ReportingPeriod};

/// `PerError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PerError {
	/// `NON_FINITE`.
	#[error("NON_FINITE")]
	NonFinite,
	/// `NEGATIVE_PRICE`.
	#[error("NEGATIVE_PRICE")]
	NegativePrice,
	/// `NON_POSITIVE_EPS`.
	#[error("NON_POSITIVE_EPS")]
	NonPositiveEps,
	/// `CURRENCY_MISMATCH`.
	#[error("CURRENCY_MISMATCH")]
	CurrencyMismatch,
	/// `SECURITY_MISMATCH`.
	#[error("SECURITY_MISMATCH")]
	SecurityMismatch,
	/// `ADJUSTMENT_BASIS_MISMATCH`.
	#[error("ADJUSTMENT_BASIS_MISMATCH")]
	AdjustmentBasisMismatch,
	/// `EPS_BASIS_MISMATCH`.
	#[error("EPS_BASIS_MISMATCH")]
	EpsBasisMismatch,
}

impl PerError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NonFinite => "NON_FINITE",
			Self::NegativePrice => "NEGATIVE_PRICE",
			Self::NonPositiveEps => "NON_POSITIVE_EPS",
			Self::CurrencyMismatch => "CURRENCY_MISMATCH",
			Self::SecurityMismatch => "SECURITY_MISMATCH",
			Self::AdjustmentBasisMismatch => "ADJUSTMENT_BASIS_MISMATCH",
			Self::EpsBasisMismatch => "EPS_BASIS_MISMATCH",
		}
	}
}

/// `trailingPer`: price / trailing EPS. Missing or non-positive EPS is an
/// error, never a "meaningful" positive ratio.
///
/// # Errors
///
/// The first failing check, in the TypeScript's order.
pub fn trailing_per(price: f64, trailing_eps: f64) -> Result<f64, PerError> {
	if !price.is_finite() || !trailing_eps.is_finite() {
		return Err(PerError::NonFinite);
	}
	if price < 0.0 {
		return Err(PerError::NegativePrice);
	}
	if trailing_eps <= 0.0 {
		return Err(PerError::NonPositiveEps);
	}
	let ratio = price / trailing_eps;
	// A finite price over a denormal EPS overflows; that is not a reportable ratio.
	if ratio.is_finite() {
		Ok(ratio)
	} else {
		Err(PerError::NonFinite)
	}
}

/// `EpsBasis`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EpsBasis {
	/// Reported trailing EPS.
	Trailing,
	/// Estimated forward EPS.
	Forward,
}

/// `Dilution`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Dilution {
	/// `basic`.
	Basic,
	/// `diluted`.
	Diluted,
}

/// `PriceQuote`.
#[derive(Clone, Debug, PartialEq)]
pub struct PriceQuote {
	/// The quoted security.
	pub security_id: String,
	/// The price.
	pub price: Money,
	/// When it was quoted.
	pub price_as_of: String,
	/// Split adjustment.
	pub adjustment_basis: AdjustmentBasis,
}

/// `EpsFigure`.
#[derive(Clone, Debug, PartialEq)]
pub struct EpsFigure {
	/// The security.
	pub security_id: String,
	/// Earnings per share.
	pub eps: Money,
	/// Trailing or forward.
	pub basis: EpsBasis,
	/// Reported or estimated.
	pub actual_or_estimate: ActualOrEstimate,
	/// The period.
	pub period: ReportingPeriod,
	/// Split adjustment.
	pub adjustment_basis: AdjustmentBasis,
	/// Share count basis.
	pub dilution: Dilution,
}

/// `PerValue` (`formula` is always `"price / EPS"`).
#[derive(Clone, Debug, PartialEq)]
pub struct PerValue {
	/// The ratio.
	pub per: f64,
	/// Trailing or forward.
	pub eps_basis: EpsBasis,
	/// Reported or estimated.
	pub actual_or_estimate: ActualOrEstimate,
	/// Share count basis.
	pub dilution: Dilution,
	/// The price currency.
	pub currency: String,
	/// When the price was quoted.
	pub price_as_of: String,
	/// The earnings period.
	pub earnings_period: ReportingPeriod,
	/// Split adjustment.
	pub adjustment_basis: AdjustmentBasis,
}

impl PerValue {
	/// The `formula` field.
	pub const FORMULA: &'static str = "price / EPS";
}

/// `computePer`: PER with the qualifying metadata FR-006 requires; rejects
/// mismatched inputs instead of guessing.
///
/// # Errors
///
/// The first failing check, in the TypeScript's order.
pub fn compute_per(quote: &PriceQuote, eps: &EpsFigure) -> Result<PerValue, PerError> {
	if quote.security_id != eps.security_id {
		return Err(PerError::SecurityMismatch);
	}
	if quote.price.currency != eps.eps.currency {
		return Err(PerError::CurrencyMismatch);
	}
	if quote.adjustment_basis != eps.adjustment_basis {
		return Err(PerError::AdjustmentBasisMismatch);
	}
	// Trailing EPS is by definition reported; forward EPS is by definition an estimate.
	let expected = match eps.basis {
		EpsBasis::Trailing => ActualOrEstimate::Actual,
		EpsBasis::Forward => ActualOrEstimate::Estimate,
	};
	if eps.actual_or_estimate != expected {
		return Err(PerError::EpsBasisMismatch);
	}
	let per = trailing_per(quote.price.amount, eps.eps.amount)?;
	Ok(PerValue {
		per,
		eps_basis: eps.basis,
		actual_or_estimate: eps.actual_or_estimate,
		dilution: eps.dilution,
		currency: quote.price.currency.clone(),
		price_as_of: quote.price_as_of.clone(),
		earnings_period: eps.period.clone(),
		adjustment_basis: quote.adjustment_basis,
	})
}
