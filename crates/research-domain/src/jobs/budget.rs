//! Port of `packages/domain/src/jobs/budget.ts`: owner-set run ceilings and
//! the usage that is charged against them (FR-016 / AGT-008).

use serde::{Deserialize, Serialize};

/// Owner-set ceilings for one research run (FR-016 / AGT-008).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchBudget {
	/// Model turns the run may take.
	pub max_agent_steps: u64,
	/// Tool calls the run may execute.
	pub max_tool_calls: u64,
	/// Wall-clock time of one attempt, in milliseconds.
	pub max_wall_clock_ms: u64,
	/// UTF-8 bytes of prompt input the run may send.
	pub max_input_bytes: u64,
	/// `None` = the owner authorized no metered spend at all.
	pub max_spend_usd: Option<f64>,
}

/// What a run has consumed so far. Usage only ever grows. The default is
/// [`EMPTY_USAGE`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
	/// Model turns charged.
	pub agent_steps: u64,
	/// Tool calls charged.
	pub tool_calls: u64,
	/// Prompt input bytes charged.
	pub input_bytes: u64,
	/// Sum of the costs the provider actually reported.
	pub known_cost_usd: f64,
	/// True once any step ran whose cost the provider could not report.
	pub has_unmetered_usage: bool,
}

/// `EMPTY_USAGE`: nothing consumed yet.
pub const EMPTY_USAGE: ResourceUsage = ResourceUsage {
	agent_steps: 0,
	tool_calls: 0,
	input_bytes: 0,
	known_cost_usd: 0.0,
	has_unmetered_usage: false,
};

/// The limit a step would exceed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BudgetLimit {
	/// `MAX_AGENT_STEPS`.
	MaxAgentSteps,
	/// `MAX_TOOL_CALLS`.
	MaxToolCalls,
	/// `MAX_WALL_CLOCK`.
	MaxWallClock,
	/// `MAX_INPUT_BYTES`.
	MaxInputBytes,
	/// `MAX_SPEND`.
	MaxSpend,
}

impl BudgetLimit {
	/// The TypeScript code string, e.g. `"MAX_TOOL_CALLS"`.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::MaxAgentSteps => "MAX_AGENT_STEPS",
			Self::MaxToolCalls => "MAX_TOOL_CALLS",
			Self::MaxWallClock => "MAX_WALL_CLOCK",
			Self::MaxInputBytes => "MAX_INPUT_BYTES",
			Self::MaxSpend => "MAX_SPEND",
		}
	}
}

/// The cost a step reports: `UsageDelta.costUsd` is optional and nullable in
/// TypeScript, and the two absences mean different things.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum CostReport {
	/// `costUsd` not given: the known cost and the unmetered flag are unchanged.
	#[default]
	NotGiven,
	/// `costUsd: null`: the step ran but its cost is unknown.
	Unknown,
	/// A reported cost. Non-finite or negative values count as unknown.
	Usd(f64),
}

/// One planned or performed step. Counter increments of 0 change nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UsageDelta {
	/// Model turns.
	pub agent_steps: u64,
	/// Tool calls.
	pub tool_calls: u64,
	/// Prompt input bytes.
	pub input_bytes: u64,
	/// The step's cost report.
	pub cost_usd: CostReport,
}

/// Usage only ever grows. A cost that is not a finite non-negative number is
/// treated as unknown rather than silently reducing or corrupting the total.
///
/// The TypeScript counters are doubles whose negative or non-finite
/// increments are ignored; here they are unsigned integers, so every
/// increment is usable (the `increment` guard is the type).
#[must_use]
pub fn add_usage(usage: &ResourceUsage, delta: &UsageDelta) -> ResourceUsage {
	let (cost_is_unknown, cost) = match delta.cost_usd {
		CostReport::NotGiven => (false, 0.0),
		CostReport::Unknown => (true, 0.0),
		CostReport::Usd(value) if !value.is_finite() || value < 0.0 => (true, 0.0),
		// `increment`: only a positive value adds (so -0 adds +0, not -0).
		CostReport::Usd(value) => (false, if value > 0.0 { value } else { 0.0 }),
	};
	ResourceUsage {
		agent_steps: usage.agent_steps.saturating_add(delta.agent_steps),
		tool_calls: usage.tool_calls.saturating_add(delta.tool_calls),
		input_bytes: usage.input_bytes.saturating_add(delta.input_bytes),
		known_cost_usd: usage.known_cost_usd + cost,
		has_unmetered_usage: usage.has_unmetered_usage || cost_is_unknown,
	}
}

/// Checks whether `usage` plus the `next` planned step stays within budget.
/// Call before performing the step so a limit is never overshot.
///
/// `elapsed_ms` is compared strictly (`elapsed < max`) and is not projected.
///
/// # Errors
///
/// The first limit (in the TypeScript's order) the step would exceed.
pub fn check_budget(
	budget: &ResearchBudget,
	usage: &ResourceUsage,
	elapsed_ms: i64,
	next: &UsageDelta,
) -> Result<(), BudgetLimit> {
	let projected = add_usage(usage, next);
	if projected.agent_steps > budget.max_agent_steps {
		return Err(BudgetLimit::MaxAgentSteps);
	}
	if projected.tool_calls > budget.max_tool_calls {
		return Err(BudgetLimit::MaxToolCalls);
	}
	if i128::from(elapsed_ms) >= i128::from(budget.max_wall_clock_ms) {
		return Err(BudgetLimit::MaxWallClock);
	}
	if projected.input_bytes > budget.max_input_bytes {
		return Err(BudgetLimit::MaxInputBytes);
	}
	// Written so that NaN fails it: a corrupt counter is over budget, not under.
	let spend_ceiling = budget.max_spend_usd.unwrap_or(0.0);
	if !matches!(
		projected.known_cost_usd.partial_cmp(&spend_ceiling),
		Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
	) {
		return Err(BudgetLimit::MaxSpend);
	}
	Ok(())
}

/// How a run's cost is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CostStatus {
	/// Nothing ran.
	#[serde(rename = "none")]
	None,
	/// Every step reported its cost.
	#[serde(rename = "metered")]
	Metered,
	/// At least one step's cost is unknown.
	#[serde(rename = "unknown-plan-limited")]
	UnknownPlanLimited,
}

/// A run's cost as shown to the owner.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummary {
	/// How the cost is known.
	pub status: CostStatus,
	/// `None` whenever any usage was unmetered: an unknown cost is never reported as $0.
	pub total_cost_usd: Option<f64>,
	/// The part of the cost providers reported.
	pub metered_portion_usd: f64,
}

/// `summarizeCost`.
#[must_use]
pub fn summarize_cost(usage: &ResourceUsage) -> CostSummary {
	if usage.has_unmetered_usage {
		return CostSummary {
			status: CostStatus::UnknownPlanLimited,
			total_cost_usd: None,
			metered_portion_usd: usage.known_cost_usd,
		};
	}
	let ran = usage.agent_steps > 0 || usage.known_cost_usd > 0.0;
	CostSummary {
		status: if ran {
			CostStatus::Metered
		} else {
			CostStatus::None
		},
		total_cost_usd: Some(usage.known_cost_usd),
		metered_portion_usd: usage.known_cost_usd,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const BUDGET: ResearchBudget = ResearchBudget {
		max_agent_steps: 6,
		max_tool_calls: 10,
		max_wall_clock_ms: 600_000,
		max_input_bytes: 400_000,
		max_spend_usd: Some(1.0),
	};

	#[test]
	fn add_usage_treats_bad_costs_as_unknown() {
		let unknown = add_usage(
			&EMPTY_USAGE,
			&UsageDelta {
				cost_usd: CostReport::Usd(f64::NAN),
				..UsageDelta::default()
			},
		);
		assert!(unknown.has_unmetered_usage);
		assert_eq!(unknown.known_cost_usd, 0.0);
		let negative = add_usage(
			&EMPTY_USAGE,
			&UsageDelta {
				cost_usd: CostReport::Usd(-1.0),
				..UsageDelta::default()
			},
		);
		assert!(negative.has_unmetered_usage);
		let null = add_usage(
			&EMPTY_USAGE,
			&UsageDelta {
				cost_usd: CostReport::Unknown,
				..UsageDelta::default()
			},
		);
		assert!(null.has_unmetered_usage);
		let absent = add_usage(
			&EMPTY_USAGE,
			&UsageDelta {
				agent_steps: 1,
				..UsageDelta::default()
			},
		);
		assert!(!absent.has_unmetered_usage);
		assert_eq!(absent.agent_steps, 1);
		let paid = add_usage(
			&absent,
			&UsageDelta {
				cost_usd: CostReport::Usd(0.25),
				..UsageDelta::default()
			},
		);
		assert_eq!(paid.known_cost_usd, 0.25);
	}

	#[test]
	fn check_budget_reports_limits_in_order() {
		assert_eq!(
			check_budget(&BUDGET, &EMPTY_USAGE, 0, &UsageDelta::default()),
			Ok(())
		);
		let full = ResourceUsage {
			agent_steps: 6,
			tool_calls: 10,
			..EMPTY_USAGE
		};
		assert_eq!(
			check_budget(
				&BUDGET,
				&full,
				0,
				&UsageDelta {
					agent_steps: 1,
					tool_calls: 1,
					..UsageDelta::default()
				}
			),
			Err(BudgetLimit::MaxAgentSteps)
		);
		assert_eq!(
			check_budget(&BUDGET, &EMPTY_USAGE, 600_000, &UsageDelta::default()),
			Err(BudgetLimit::MaxWallClock)
		);
		let nan = ResourceUsage {
			known_cost_usd: f64::NAN,
			..EMPTY_USAGE
		};
		assert_eq!(
			check_budget(&BUDGET, &nan, 0, &UsageDelta::default()),
			Err(BudgetLimit::MaxSpend)
		);
		let no_spend = ResearchBudget {
			max_spend_usd: None,
			..BUDGET
		};
		let spent = ResourceUsage {
			known_cost_usd: 0.01,
			..EMPTY_USAGE
		};
		assert_eq!(
			check_budget(&no_spend, &spent, 0, &UsageDelta::default()),
			Err(BudgetLimit::MaxSpend)
		);
	}

	#[test]
	fn summarize_cost_never_reports_unknown_as_zero() {
		let unknown = ResourceUsage {
			has_unmetered_usage: true,
			known_cost_usd: 0.5,
			..EMPTY_USAGE
		};
		assert_eq!(summarize_cost(&unknown).total_cost_usd, None);
		assert_eq!(summarize_cost(&EMPTY_USAGE).status, CostStatus::None);
		let ran = ResourceUsage {
			agent_steps: 1,
			..EMPTY_USAGE
		};
		assert_eq!(summarize_cost(&ran).status, CostStatus::Metered);
	}
}
