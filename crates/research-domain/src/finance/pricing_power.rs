//! Port of `packages/domain/src/finance/pricingPower.ts` (FR-009 /
//! DATA-008). Price realization is kept separate from volume, mix, FX and
//! cost effects; a margin improvement alone is never classified as
//! demonstrated pricing power.

/// `PricingPowerInputs`: year-over-year percentages (4.5 = +4.5%) and basis
/// points; `None` = not disclosed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PricingPowerInputs {
	/// Revenue growth.
	pub revenue_growth_pct: Option<f64>,
	/// Price realization.
	pub price_realization_pct: Option<f64>,
	/// Volume growth.
	pub volume_growth_pct: Option<f64>,
	/// Mix effect.
	pub mix_effect_pct: Option<f64>,
	/// FX effect.
	pub fx_effect_pct: Option<f64>,
	/// Input cost change.
	pub input_cost_change_pct: Option<f64>,
	/// Gross margin change.
	pub gross_margin_change_bps: Option<f64>,
	/// Operating margin change.
	pub operating_margin_change_bps: Option<f64>,
	/// Evidence ids of management commentary on pricing.
	pub management_commentary_evidence_ids: Vec<String>,
}

/// `PricingPowerClassification`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PricingPowerClassification {
	/// `corroborated-price-realization`.
	CorroboratedPriceRealization,
	/// `price-realization-uncorroborated`.
	PriceRealizationUncorroborated,
	/// `price-increase-offset-by-volume-loss`.
	PriceIncreaseOffsetByVolumeLoss,
	/// `price-increase-absorbed-by-costs`.
	PriceIncreaseAbsorbedByCosts,
	/// `no-price-realization`.
	NoPriceRealization,
	/// `margin-improvement-without-price-evidence`.
	MarginImprovementWithoutPriceEvidence,
	/// `insufficient-data`.
	InsufficientData,
}

impl PricingPowerClassification {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::CorroboratedPriceRealization => "corroborated-price-realization",
			Self::PriceRealizationUncorroborated => "price-realization-uncorroborated",
			Self::PriceIncreaseOffsetByVolumeLoss => "price-increase-offset-by-volume-loss",
			Self::PriceIncreaseAbsorbedByCosts => "price-increase-absorbed-by-costs",
			Self::NoPriceRealization => "no-price-realization",
			Self::MarginImprovementWithoutPriceEvidence => {
				"margin-improvement-without-price-evidence"
			}
			Self::InsufficientData => "insufficient-data",
		}
	}
}

/// `PricingPowerInputName`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PricingPowerInputName {
	/// `priceRealizationPct`.
	PriceRealizationPct,
	/// `volumeGrowthPct`.
	VolumeGrowthPct,
	/// `grossMarginChangeBps`.
	GrossMarginChangeBps,
	/// `managementCommentary`.
	ManagementCommentary,
}

impl PricingPowerInputName {
	/// The TypeScript literal.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::PriceRealizationPct => "priceRealizationPct",
			Self::VolumeGrowthPct => "volumeGrowthPct",
			Self::GrossMarginChangeBps => "grossMarginChangeBps",
			Self::ManagementCommentary => "managementCommentary",
		}
	}
}

/// `PricingPowerAssessment`.
#[derive(Clone, Debug, PartialEq)]
pub struct PricingPowerAssessment {
	/// The classification.
	pub classification: PricingPowerClassification,
	/// Inputs that were not disclosed, in a fixed order.
	pub missing_inputs: Vec<PricingPowerInputName>,
	/// Reported revenue growth minus the additive sum of price, volume, mix
	/// and FX effects, in percentage points; `None` unless every term is disclosed.
	pub unexplained_revenue_residual_pct: Option<f64>,
}

/// A non-finite figure is not a disclosure; it is treated exactly like an
/// undisclosed one.
fn disclosed(value: Option<f64>) -> Option<f64> {
	value.filter(|value| value.is_finite())
}

fn residual(inputs: &PricingPowerInputs) -> Option<f64> {
	let revenue = disclosed(inputs.revenue_growth_pct)?;
	let price = disclosed(inputs.price_realization_pct)?;
	let volume = disclosed(inputs.volume_growth_pct)?;
	let mix = disclosed(inputs.mix_effect_pct)?;
	let fx = disclosed(inputs.fx_effect_pct)?;
	Some(revenue - (price + volume + mix + fx))
}

fn classify(inputs: &PricingPowerInputs) -> PricingPowerClassification {
	use PricingPowerClassification as C;
	let margin_improved = inputs.gross_margin_change_bps.unwrap_or(0.0) > 0.0
		|| inputs.operating_margin_change_bps.unwrap_or(0.0) > 0.0;
	let Some(price) = inputs.price_realization_pct else {
		return if margin_improved {
			C::MarginImprovementWithoutPriceEvidence
		} else {
			C::InsufficientData
		};
	};
	if price <= 0.0 {
		return C::NoPriceRealization;
	}
	let (Some(volume), Some(gross_margin)) =
		(inputs.volume_growth_pct, inputs.gross_margin_change_bps)
	else {
		return C::PriceRealizationUncorroborated;
	};
	// The price increase did not grow price-times-volume revenue. The effects compound:
	// +10% price with -9.5% volume is 1.10 x 0.905 = 0.9955, a decline, even though 10 > 9.5.
	if volume < 0.0 && (1.0 + price / 100.0) * (1.0 + volume / 100.0) <= 1.0 {
		return C::PriceIncreaseOffsetByVolumeLoss;
	}
	if gross_margin < 0.0 {
		return C::PriceIncreaseAbsorbedByCosts;
	}
	if inputs.management_commentary_evidence_ids.is_empty() {
		return C::PriceRealizationUncorroborated;
	}
	C::CorroboratedPriceRealization
}

/// `assessPricingPower`.
#[must_use]
pub fn assess_pricing_power(raw_inputs: &PricingPowerInputs) -> PricingPowerAssessment {
	// Normalized first so NaN/Infinity can never satisfy a corroboration check by comparing false.
	let inputs = PricingPowerInputs {
		price_realization_pct: disclosed(raw_inputs.price_realization_pct),
		volume_growth_pct: disclosed(raw_inputs.volume_growth_pct),
		gross_margin_change_bps: disclosed(raw_inputs.gross_margin_change_bps),
		operating_margin_change_bps: disclosed(raw_inputs.operating_margin_change_bps),
		..raw_inputs.clone()
	};
	let mut missing_inputs = Vec::new();
	if inputs.price_realization_pct.is_none() {
		missing_inputs.push(PricingPowerInputName::PriceRealizationPct);
	}
	if inputs.volume_growth_pct.is_none() {
		missing_inputs.push(PricingPowerInputName::VolumeGrowthPct);
	}
	if inputs.gross_margin_change_bps.is_none() {
		missing_inputs.push(PricingPowerInputName::GrossMarginChangeBps);
	}
	if inputs.management_commentary_evidence_ids.is_empty() {
		missing_inputs.push(PricingPowerInputName::ManagementCommentary);
	}
	PricingPowerAssessment {
		classification: classify(&inputs),
		missing_inputs,
		unexplained_revenue_residual_pct: residual(&inputs),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn compounding_volume_loss_offsets_price() {
		let inputs = PricingPowerInputs {
			price_realization_pct: Some(10.0),
			volume_growth_pct: Some(-9.5),
			gross_margin_change_bps: Some(10.0),
			..PricingPowerInputs::default()
		};
		assert_eq!(
			assess_pricing_power(&inputs).classification,
			PricingPowerClassification::PriceIncreaseOffsetByVolumeLoss
		);
		let nan = PricingPowerInputs {
			price_realization_pct: Some(f64::NAN),
			..inputs
		};
		let assessed = assess_pricing_power(&nan);
		assert_eq!(
			assessed.classification,
			PricingPowerClassification::MarginImprovementWithoutPriceEvidence
		);
		assert_eq!(
			assessed.missing_inputs[0],
			PricingPowerInputName::PriceRealizationPct
		);
	}
}
