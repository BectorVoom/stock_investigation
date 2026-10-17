//! Port of `packages/domain/src/finance/positions.ts`. Position statistics
//! are jurisdiction-specific (FR-007 / DATA-006): the two shapes share no
//! interchangeable fields on purpose — there is no US security-level
//! margin-buy balance, and US short interest is not Japan's margin-sale
//! balance.

/// Japan margin trading balances.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JpMarginBalanceFigures {
	/// Margin purchase balance, in shares.
	pub margin_buy_balance_shares: f64,
	/// Margin sale balance, in shares.
	pub margin_sell_balance_shares: f64,
}

/// US short interest.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UsShortInterestFigures {
	/// Reported short interest, in shares.
	pub reported_short_interest_shares: f64,
	/// Average daily volume, in shares; `None` when unavailable.
	pub average_daily_volume_shares: Option<f64>,
}

/// `PositionFigures`, discriminated by `metric`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PositionFigures {
	/// `jurisdiction: "JP"`, `metric: "jp-margin-balance"`.
	JpMarginBalance(JpMarginBalanceFigures),
	/// `jurisdiction: "US"`, `metric: "us-short-interest"`.
	UsShortInterest(UsShortInterestFigures),
}

/// `PositionFigures["metric"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PositionMetric {
	/// `jp-margin-balance`.
	JpMarginBalance,
	/// `us-short-interest`.
	UsShortInterest,
}

impl PositionMetric {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::JpMarginBalance => "jp-margin-balance",
			Self::UsShortInterest => "us-short-interest",
		}
	}
}

/// `PositionRatioError` (plus `VOLUME_UNAVAILABLE` for days-to-cover).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PositionRatioError {
	/// `NON_FINITE`.
	#[error("NON_FINITE")]
	NonFinite,
	/// `NEGATIVE_INPUT`.
	#[error("NEGATIVE_INPUT")]
	NegativeInput,
	/// `ZERO_DENOMINATOR`.
	#[error("ZERO_DENOMINATOR")]
	ZeroDenominator,
	/// `VOLUME_UNAVAILABLE`.
	#[error("VOLUME_UNAVAILABLE")]
	VolumeUnavailable,
}

impl PositionRatioError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NonFinite => "NON_FINITE",
			Self::NegativeInput => "NEGATIVE_INPUT",
			Self::ZeroDenominator => "ZERO_DENOMINATOR",
			Self::VolumeUnavailable => "VOLUME_UNAVAILABLE",
		}
	}
}

fn ratio(numerator: f64, denominator: f64) -> Result<f64, PositionRatioError> {
	if !numerator.is_finite() || !denominator.is_finite() {
		return Err(PositionRatioError::NonFinite);
	}
	if numerator < 0.0 || denominator < 0.0 {
		return Err(PositionRatioError::NegativeInput);
	}
	if denominator == 0.0 {
		return Err(PositionRatioError::ZeroDenominator);
	}
	let value = numerator / denominator;
	if value.is_finite() {
		Ok(value)
	} else {
		Err(PositionRatioError::NonFinite)
	}
}

/// `jpMarginBuySellRatio`: Japan margin ratio (信用倍率), margin buy balance /
/// margin sell balance.
///
/// # Errors
///
/// Non-finite, negative or zero-denominator inputs.
pub fn jp_margin_buy_sell_ratio(
	figures: &JpMarginBalanceFigures,
) -> Result<f64, PositionRatioError> {
	ratio(
		figures.margin_buy_balance_shares,
		figures.margin_sell_balance_shares,
	)
}

/// `usDaysToCover`: reported short interest / average daily share volume.
///
/// # Errors
///
/// `VOLUME_UNAVAILABLE` without a volume, else as [`jp_margin_buy_sell_ratio`].
pub fn us_days_to_cover(figures: &UsShortInterestFigures) -> Result<f64, PositionRatioError> {
	let volume = figures
		.average_daily_volume_shares
		.ok_or(PositionRatioError::VolumeUnavailable)?;
	ratio(figures.reported_short_interest_shares, volume)
}

/// `PositionLabels`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionLabels {
	/// Section heading.
	pub heading: &'static str,
	/// What the figures are and are not.
	pub caveat: &'static str,
}

/// `positionLabels`.
#[must_use]
pub const fn position_labels(metric: PositionMetric) -> PositionLabels {
	match metric {
		PositionMetric::JpMarginBalance => PositionLabels {
			heading: "Japan margin trading balances (信用取引残高)",
			caveat: "Margin purchase and margin sale balances as defined by the reporting exchange/source. Not comparable to US short interest.",
		},
		PositionMetric::UsShortInterest => PositionLabels {
			heading: "US short interest",
			caveat: "Security-level short interest as of the settlement date. Not equivalent to Japan's margin-sale balance; no security-level US margin-buy balance exists.",
		},
	}
}
