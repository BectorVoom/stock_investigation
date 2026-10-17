//! Port of `packages/domain/src/finance/cagr.ts`.
//!
//! `**`, `Math.exp` and `Math.log` come from `research_js::math` (V8's
//! fdlibm results). `exp` and `log` agree with V8 bit for bit; `pow` can
//! differ in its last bit for a few percent of inputs (documented there), so
//! a derived growth rate can differ in its last digits — never in the
//! two-decimal percentage the presentation rounds it to, except at an exact
//! rounding tie.

use research_js::math;

/// `CagrError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CagrError {
	/// `NON_FINITE`.
	#[error("NON_FINITE")]
	NonFinite,
	/// `NON_POSITIVE_BASE`.
	#[error("NON_POSITIVE_BASE")]
	NonPositiveBase,
	/// `NEGATIVE_TARGET`.
	#[error("NEGATIVE_TARGET")]
	NegativeTarget,
	/// `INVALID_YEARS`.
	#[error("INVALID_YEARS")]
	InvalidYears,
}

impl CagrError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NonFinite => "NON_FINITE",
			Self::NonPositiveBase => "NON_POSITIVE_BASE",
			Self::NegativeTarget => "NEGATIVE_TARGET",
			Self::InvalidYears => "INVALID_YEARS",
		}
	}
}

/// `Number.isInteger`.
pub(crate) fn is_integer(value: f64) -> bool {
	value.is_finite() && value.trunc() == value
}

/// `deriveCagr`: compound annual growth rate as a ratio,
/// `(target / base)^(1 / years) - 1`.
///
/// # Errors
///
/// The first failing check, in the TypeScript's order.
pub fn derive_cagr(
	base_value: f64,
	target_value: f64,
	base_year: f64,
	target_year: f64,
) -> Result<f64, CagrError> {
	if ![base_value, target_value, base_year, target_year]
		.iter()
		.all(|value| value.is_finite())
	{
		return Err(CagrError::NonFinite);
	}
	if !is_integer(base_year) || !is_integer(target_year) || target_year <= base_year {
		return Err(CagrError::InvalidYears);
	}
	if base_value <= 0.0 {
		return Err(CagrError::NonPositiveBase);
	}
	if target_value < 0.0 {
		return Err(CagrError::NegativeTarget);
	}
	let years = target_year - base_year;
	let direct = math::pow(target_value / base_value, 1.0 / years) - 1.0;
	if direct.is_finite() {
		return Ok(direct);
	}
	// target / base can overflow although the growth rate itself is
	// representable; log space avoids the intermediate ratio.
	let via_logs = math::exp((math::log(target_value) - math::log(base_value)) / years) - 1.0;
	if via_logs.is_finite() {
		Ok(via_logs)
	} else {
		Err(CagrError::NonFinite)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn derives_growth_and_rejects_bad_input() {
		let rate = derive_cagr(100.0, 200.0, 2020.0, 2025.0).unwrap();
		assert!((rate - 0.148_698_354_997_035).abs() < 1e-12);
		assert_eq!(
			derive_cagr(f64::NAN, 1.0, 1.0, 2.0),
			Err(CagrError::NonFinite)
		);
		assert_eq!(
			derive_cagr(1.0, 1.0, 2.0, 2.0),
			Err(CagrError::InvalidYears)
		);
		assert_eq!(
			derive_cagr(1.0, 1.0, 1.5, 3.0),
			Err(CagrError::InvalidYears)
		);
		assert_eq!(
			derive_cagr(0.0, 1.0, 1.0, 2.0),
			Err(CagrError::NonPositiveBase)
		);
		assert_eq!(
			derive_cagr(1.0, -1.0, 1.0, 2.0),
			Err(CagrError::NegativeTarget)
		);
		assert!(derive_cagr(1e-300, 1e300, 2020.0, 2023.0).is_ok());
	}
}
