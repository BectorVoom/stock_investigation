//! Port of `packages/domain/src/finance/demandScenario.ts`: a scenario's
//! structural invariants (DATA-009) and its nullable growth rates.

use research_js::whitespace;
use serde::Serialize;

use super::cagr::{derive_cagr, is_integer};
use crate::literal::js_literal_enum;

/// Shortest scenario horizon in years.
pub const MIN_HORIZON_YEARS: f64 = 3.0;
/// Longest scenario horizon in years.
pub const MAX_HORIZON_YEARS: f64 = 5.0;

/// One case (bear, base or bull) of a scenario.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioCase {
	/// The case's value in the target year.
	pub target_value: f64,
	/// What must hold for the case.
	pub assumptions: Vec<String>,
}

js_literal_enum! {
	/// What a quantity measures; unit demand, revenue and price growth must
	/// not be conflated.
	pub enum DemandQuantityKind {
		/// `unit-demand`.
		UnitDemand = "unit-demand",
		/// `revenue`.
		Revenue = "revenue",
		/// `price`.
		Price = "price",
	}
}

/// `DemandScenarioInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct DemandScenarioInput {
	/// What is forecast.
	pub product_or_service: String,
	/// What the quantity measures.
	pub quantity_kind: DemandQuantityKind,
	/// Unit of the values.
	pub unit: String,
	/// Year of the baseline.
	pub base_year: f64,
	/// Year of the targets.
	pub target_year: f64,
	/// `None` when no sourced baseline exists; growth is then not derivable.
	pub baseline_value: Option<f64>,
	/// Pessimistic case.
	pub bear: ScenarioCase,
	/// Central case.
	pub base: ScenarioCase,
	/// Optimistic case.
	pub bull: ScenarioCase,
	/// What drives demand.
	pub drivers: Vec<String>,
	/// What holds it back.
	pub barriers: Vec<String>,
	/// What would prove the scenario wrong.
	pub falsifiers: Vec<String>,
	/// How the values were derived.
	pub methodology: String,
}

/// `DemandScenarioError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DemandScenarioError {
	/// `MISSING_UNIT`.
	MissingUnit,
	/// `MISSING_METHODOLOGY`.
	MissingMethodology,
	/// `HORIZON_OUT_OF_RANGE`.
	HorizonOutOfRange,
	/// `SCENARIO_ORDER_INVALID`.
	ScenarioOrderInvalid,
	/// `MISSING_DRIVERS`.
	MissingDrivers,
	/// `MISSING_FALSIFIERS`.
	MissingFalsifiers,
	/// `MISSING_ASSUMPTIONS`.
	MissingAssumptions,
	/// `NON_FINITE`.
	NonFinite,
}

impl DemandScenarioError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::MissingUnit => "MISSING_UNIT",
			Self::MissingMethodology => "MISSING_METHODOLOGY",
			Self::HorizonOutOfRange => "HORIZON_OUT_OF_RANGE",
			Self::ScenarioOrderInvalid => "SCENARIO_ORDER_INVALID",
			Self::MissingDrivers => "MISSING_DRIVERS",
			Self::MissingFalsifiers => "MISSING_FALSIFIERS",
			Self::MissingAssumptions => "MISSING_ASSUMPTIONS",
			Self::NonFinite => "NON_FINITE",
		}
	}
}

/// Growth rates per case; `None` when not derivable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DerivedScenarioCagr {
	/// Bear case.
	pub bear: Option<f64>,
	/// Base case.
	pub base: Option<f64>,
	/// Bull case.
	pub bull: Option<f64>,
}

fn cagr_or_none(input: &DemandScenarioInput, target_value: f64) -> Option<f64> {
	let baseline = input.baseline_value?;
	derive_cagr(baseline, target_value, input.base_year, input.target_year).ok()
}

/// `deriveScenarioCagr`: validates a scenario's structural invariants
/// (DATA-009) and derives nullable growth rates.
///
/// # Errors
///
/// Every failed invariant, in the TypeScript's order.
pub fn derive_scenario_cagr(
	input: &DemandScenarioInput,
) -> Result<DerivedScenarioCagr, Vec<DemandScenarioError>> {
	let mut errors = Vec::new();
	let cases = [&input.bear, &input.base, &input.bull];
	if whitespace::trim(&input.unit).is_empty() {
		errors.push(DemandScenarioError::MissingUnit);
	}
	if whitespace::trim(&input.methodology).is_empty() {
		errors.push(DemandScenarioError::MissingMethodology);
	}
	let horizon = input.target_year - input.base_year;
	if !is_integer(horizon) || !(MIN_HORIZON_YEARS..=MAX_HORIZON_YEARS).contains(&horizon) {
		errors.push(DemandScenarioError::HorizonOutOfRange);
	}
	if !cases.iter().all(|case| case.target_value.is_finite()) {
		errors.push(DemandScenarioError::NonFinite);
	} else if input.bear.target_value > input.base.target_value
		|| input.base.target_value > input.bull.target_value
	{
		errors.push(DemandScenarioError::ScenarioOrderInvalid);
	}
	if input.drivers.is_empty() {
		errors.push(DemandScenarioError::MissingDrivers);
	}
	if input.falsifiers.is_empty() {
		errors.push(DemandScenarioError::MissingFalsifiers);
	}
	if cases.iter().any(|case| case.assumptions.is_empty()) {
		errors.push(DemandScenarioError::MissingAssumptions);
	}
	if !errors.is_empty() {
		return Err(errors);
	}
	Ok(DerivedScenarioCagr {
		bear: cagr_or_none(input, input.bear.target_value),
		base: cagr_or_none(input, input.base.target_value),
		bull: cagr_or_none(input, input.bull.target_value),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn case(target_value: f64) -> ScenarioCase {
		ScenarioCase {
			target_value,
			assumptions: vec!["a".to_owned()],
		}
	}

	#[test]
	fn collects_every_error_in_order() {
		let input = DemandScenarioInput {
			product_or_service: "p".to_owned(),
			quantity_kind: DemandQuantityKind::Revenue,
			unit: "\u{FEFF} ".to_owned(),
			base_year: 2025.0,
			target_year: 2026.0,
			baseline_value: None,
			bear: case(3.0),
			base: case(2.0),
			bull: ScenarioCase {
				target_value: 4.0,
				assumptions: vec![],
			},
			drivers: vec![],
			barriers: vec![],
			falsifiers: vec![],
			methodology: "m".to_owned(),
		};
		assert_eq!(
			derive_scenario_cagr(&input),
			Err(vec![
				DemandScenarioError::MissingUnit,
				DemandScenarioError::HorizonOutOfRange,
				DemandScenarioError::ScenarioOrderInvalid,
				DemandScenarioError::MissingDrivers,
				DemandScenarioError::MissingFalsifiers,
				DemandScenarioError::MissingAssumptions,
			])
		);
		let valid = DemandScenarioInput {
			unit: "GWh".to_owned(),
			target_year: 2030.0,
			baseline_value: Some(100.0),
			bear: case(100.0),
			base: case(150.0),
			bull: case(200.0),
			drivers: vec!["d".to_owned()],
			falsifiers: vec!["f".to_owned()],
			..input
		};
		let derived = derive_scenario_cagr(&valid).unwrap();
		assert_eq!(derived.bear, Some(0.0));
		assert!(derived.bull.is_some());
	}
}
