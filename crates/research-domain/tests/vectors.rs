//! Replays `vectors/domain/*.json` (written by Node from the real TypeScript:
//! `node scripts/vectors/index.ts domain`).
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use research_domain::calendar::civil_date::{
	add_days_iso, excel_serial_to_iso_date, is_valid_iso_date,
};
use research_domain::calendar::google_sync::{
	GoogleEventBody, ManagedGoogleEvent, encode_base32_hex, plan_google_sync,
};
use research_domain::evidence::verify_claims::{
	ClaimIssue, DraftClaim, EvidenceText, VerifiedClaim, extract_number_tokens, is_passage_of,
	mentions, verify_claims,
};
use research_domain::finance::cagr::derive_cagr;
use research_domain::finance::demand_scenario::{
	DemandQuantityKind, DemandScenarioInput, ScenarioCase, derive_scenario_cagr,
};
use research_domain::finance::filings::{
	ReportedPositionContext, classify_reported_position_change, describe_reported_position_change,
};
use research_domain::finance::per::trailing_per;
use research_domain::finance::positions::{
	JpMarginBalanceFigures, UsShortInterestFigures, jp_margin_buy_sell_ratio, us_days_to_cover,
};
use research_domain::finance::pricing_power::{PricingPowerInputs, assess_pricing_power};
use research_domain::jobs::budget::{
	CostReport, CostStatus, ResearchBudget, ResourceUsage, UsageDelta, add_usage, check_budget,
	summarize_cost,
};
use research_domain::jobs::lease::{
	ClaimDecision, ClaimReason, JobLeaseView, decide_claim, lease_expiry_iso,
};
use research_domain::jobs::state_machine::JobState;
use research_domain::market::rate_window::{RatePermit, rate_window_permit};
use research_domain::market::series_id::parse_market_series_id;
use research_domain::text::recent_within_budget::recent_count_within_budget;
use research_domain::text::truncate::truncate_text;
use research_domain::watchlist::stock_id::parse_stock_id;
use serde_json::{Value, json};

fn load(name: &str) -> Value {
	let path = format!("{}/../../vectors/domain/{name}", env!("CARGO_MANIFEST_DIR"));
	serde_json::from_str(
		&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}")),
	)
	.unwrap()
}

fn bits(value: &Value) -> f64 {
	f64::from_bits(u64::from_str_radix(value.as_str().unwrap(), 16).unwrap())
}

fn optional_bits(value: &Value) -> Option<f64> {
	(!value.is_null()).then(|| bits(value))
}

/// Doubles compare by bit pattern (so -0 and NaN payloads count), `None` as null.
fn same_bits(actual: Option<f64>, expected: &Value) -> bool {
	match actual {
		None => expected.is_null(),
		Some(value) => !expected.is_null() && value.to_bits() == bits(expected).to_bits(),
	}
}

fn nat(value: &Value) -> u64 {
	value.as_u64().unwrap()
}

fn str_of(value: &Value) -> &str {
	value.as_str().unwrap()
}

fn strings(value: &Value) -> Vec<String> {
	value
		.as_array()
		.unwrap()
		.iter()
		.map(|item| str_of(item).to_owned())
		.collect()
}

fn issue_json(issue: &ClaimIssue) -> Value {
	match issue {
		ClaimIssue::UnknownEvidence { evidence_id }
		| ClaimIssue::QuoteNotFound { evidence_id }
		| ClaimIssue::QuoteTooShort { evidence_id }
		| ClaimIssue::MissingQuote { evidence_id } => {
			json!({ "code": issue.code(), "evidenceId": evidence_id })
		}
		ClaimIssue::NumberNotInEvidence { number_text } => {
			json!({ "code": issue.code(), "numberText": number_text })
		}
		ClaimIssue::NoSupportingEvidence | ClaimIssue::NotIndependentlyVerified => {
			json!({ "code": issue.code() })
		}
	}
}

fn verified_json(claim: &VerifiedClaim) -> Value {
	json!({
		"claimId": claim.claim_id,
		"text": claim.text,
		"claimType": claim.claim_type,
		"status": claim.status,
		"links": claim.links,
		"issues": claim.issues.iter().map(issue_json).collect::<Vec<_>>(),
	})
}

#[test]
fn claim_verification_matches_typescript() {
	let vectors = load("verify.json");
	let tokens = vectors["extractNumberTokens"].as_array().unwrap();
	assert!(tokens.len() > 1000);
	for case in tokens {
		assert_eq!(
			extract_number_tokens(str_of(&case["input"])),
			strings(&case["output"]),
			"{case}"
		);
	}
	for case in vectors["isPassageOf"].as_array().unwrap() {
		let actual = is_passage_of(str_of(&case["quote"]), str_of(&case["text"]));
		assert_eq!(actual, case["output"].as_bool().unwrap(), "{case}");
	}
	for case in vectors["mentions"].as_array().unwrap() {
		let actual = mentions(str_of(&case["text"]), str_of(&case["phrase"]));
		assert_eq!(actual, case["output"].as_bool().unwrap(), "{case}");
	}
	let runs = vectors["verifyClaims"].as_array().unwrap();
	assert!(runs.len() > 300);
	for case in runs {
		let claims: Vec<DraftClaim> = serde_json::from_value(case["claims"].clone()).unwrap();
		let evidence: Vec<EvidenceText> = serde_json::from_value(case["evidence"].clone()).unwrap();
		let output: Vec<Value> = verify_claims(&claims, &evidence)
			.iter()
			.map(verified_json)
			.collect();
		assert_eq!(Value::Array(output), case["output"], "{}", case["claims"]);
	}
}

fn usage_of(value: &Value) -> ResourceUsage {
	ResourceUsage {
		agent_steps: nat(&value["agentSteps"]),
		tool_calls: nat(&value["toolCalls"]),
		input_bytes: nat(&value["inputBytes"]),
		known_cost_usd: bits(&value["knownCostUsd"]),
		has_unmetered_usage: value["hasUnmeteredUsage"].as_bool().unwrap(),
	}
}

#[test]
fn budgets_match_typescript() {
	let cases = load("budget.json");
	let cases = cases.as_array().unwrap();
	assert!(cases.len() >= 1000);
	for case in cases {
		let raw = &case["budget"];
		let budget = ResearchBudget {
			max_agent_steps: nat(&raw["maxAgentSteps"]),
			max_tool_calls: nat(&raw["maxToolCalls"]),
			max_wall_clock_ms: nat(&raw["maxWallClockMs"]),
			max_input_bytes: nat(&raw["maxInputBytes"]),
			max_spend_usd: optional_bits(&raw["maxSpendUsd"]),
		};
		let mut usage = usage_of(&case["usage"]);
		for step in case["steps"].as_array().unwrap() {
			let wire = &step["delta"];
			let cost = &wire["cost"];
			let cost_usd = if cost.get("usd").is_some() {
				CostReport::Usd(bits(&cost["usd"]))
			} else if cost["kind"] == "null" {
				CostReport::Unknown
			} else {
				CostReport::NotGiven
			};
			let delta = UsageDelta {
				agent_steps: nat(&wire["steps"]),
				tool_calls: nat(&wire["tools"]),
				input_bytes: nat(&wire["bytes"]),
				cost_usd,
			};
			let elapsed = step["elapsedMs"].as_i64().unwrap();
			let limit = check_budget(&budget, &usage, elapsed, &delta)
				.err()
				.map(|limit| limit.as_str());
			assert_eq!(limit, step["limit"].as_str(), "{case}");
			usage = add_usage(&usage, &delta);
			let expected = usage_of(&step["after"]);
			assert_eq!(usage.agent_steps, expected.agent_steps);
			assert_eq!(usage.tool_calls, expected.tool_calls);
			assert_eq!(usage.input_bytes, expected.input_bytes);
			assert_eq!(
				usage.known_cost_usd.to_bits(),
				expected.known_cost_usd.to_bits(),
				"{case}"
			);
			assert_eq!(usage.has_unmetered_usage, expected.has_unmetered_usage);
			let summary = summarize_cost(&usage);
			let status = match summary.status {
				CostStatus::None => "none",
				CostStatus::Metered => "metered",
				CostStatus::UnknownPlanLimited => "unknown-plan-limited",
			};
			assert_eq!(status, str_of(&step["cost"]["status"]));
			assert!(
				same_bits(summary.total_cost_usd, &step["cost"]["totalCostUsd"]),
				"{case}"
			);
			assert!(same_bits(
				Some(summary.metered_portion_usd),
				&step["cost"]["meteredPortionUsd"]
			));
		}
	}
}

/// A growth rate is `pow(…) - 1`: allow one unit in the last place of the
/// `pow` result (see `research_js::math`), nothing more.
fn assert_pow_ulp(actual: f64, expected: f64, case: &Value) {
	let (actual_pow, expected_pow) = (actual + 1.0, expected + 1.0);
	let ulp = f64::from_bits(expected_pow.abs().to_bits() + 1) - expected_pow.abs();
	assert!(
		actual.to_bits() == expected.to_bits() || (actual_pow - expected_pow).abs() <= ulp,
		"{case}: {actual:e} vs {expected:e}"
	);
}

#[test]
fn finance_matches_typescript() {
	let vectors = load("finance.json");
	let (mut cagr_cases, mut cagr_exact) = (0usize, 0usize);
	for case in vectors["cagr"].as_array().unwrap() {
		let inputs: Vec<f64> = case["inputs"]
			.as_array()
			.unwrap()
			.iter()
			.map(bits)
			.collect();
		let result = derive_cagr(inputs[0], inputs[1], inputs[2], inputs[3]);
		match result {
			Ok(value) => {
				cagr_cases += 1;
				if same_bits(Some(value), &case["ok"]) {
					cagr_exact += 1;
				} else {
					assert_pow_ulp(value, bits(&case["ok"]), case);
				}
			}
			Err(error) => assert_eq!(error.as_str(), str_of(&case["error"]), "{case}"),
		}
	}
	// See research_js::math: V8's pow differs from the fdlibm port in the
	// last bit for a few percent of inputs.
	assert!(
		cagr_exact * 100 >= cagr_cases * 90,
		"{cagr_exact} of {cagr_cases} exact"
	);
	for case in vectors["scenarios"].as_array().unwrap() {
		let raw = &case["input"];
		let scenario_case = |value: &Value| ScenarioCase {
			target_value: bits(&value["targetValue"]),
			assumptions: strings(&value["assumptions"]),
		};
		let input = DemandScenarioInput {
			product_or_service: str_of(&raw["productOrService"]).to_owned(),
			quantity_kind: match str_of(&raw["quantityKind"]) {
				"unit-demand" => DemandQuantityKind::UnitDemand,
				"revenue" => DemandQuantityKind::Revenue,
				_ => DemandQuantityKind::Price,
			},
			unit: str_of(&raw["unit"]).to_owned(),
			base_year: bits(&raw["baseYear"]),
			target_year: bits(&raw["targetYear"]),
			baseline_value: optional_bits(&raw["baselineValue"]),
			bear: scenario_case(&raw["bear"]),
			base: scenario_case(&raw["base"]),
			bull: scenario_case(&raw["bull"]),
			drivers: strings(&raw["drivers"]),
			barriers: strings(&raw["barriers"]),
			falsifiers: strings(&raw["falsifiers"]),
			methodology: str_of(&raw["methodology"]).to_owned(),
		};
		match derive_scenario_cagr(&input) {
			Ok(derived) => {
				let expected = &case["ok"];
				for (actual, key) in [
					(derived.bear, "bear"),
					(derived.bull, "bull"),
					(derived.base, "base"),
				] {
					match actual {
						None => assert!(expected[key].is_null(), "{case}"),
						Some(value) => assert_pow_ulp(value, bits(&expected[key]), case),
					}
				}
			}
			Err(errors) => {
				let codes: Vec<&str> = errors.iter().map(|error| error.as_str()).collect();
				assert_eq!(codes, strings(&case["errors"]), "{case}");
			}
		}
	}
	for case in vectors["pricing"].as_array().unwrap() {
		let raw = &case["inputs"];
		let inputs = PricingPowerInputs {
			revenue_growth_pct: optional_bits(&raw["revenueGrowthPct"]),
			price_realization_pct: optional_bits(&raw["priceRealizationPct"]),
			volume_growth_pct: optional_bits(&raw["volumeGrowthPct"]),
			mix_effect_pct: optional_bits(&raw["mixEffectPct"]),
			fx_effect_pct: optional_bits(&raw["fxEffectPct"]),
			input_cost_change_pct: optional_bits(&raw["inputCostChangePct"]),
			gross_margin_change_bps: optional_bits(&raw["grossMarginChangeBps"]),
			operating_margin_change_bps: optional_bits(&raw["operatingMarginChangeBps"]),
			management_commentary_evidence_ids: strings(&raw["managementCommentaryEvidenceIds"]),
		};
		let assessed = assess_pricing_power(&inputs);
		let expected = &case["output"];
		assert_eq!(
			assessed.classification.as_str(),
			str_of(&expected["classification"]),
			"{case}"
		);
		let missing: Vec<&str> = assessed
			.missing_inputs
			.iter()
			.map(|name| name.as_str())
			.collect();
		assert_eq!(missing, strings(&expected["missingInputs"]), "{case}");
		assert!(
			same_bits(
				assessed.unexplained_revenue_residual_pct,
				&expected["unexplainedRevenueResidualPct"]
			),
			"{case}"
		);
	}
	let context = ReportedPositionContext {
		investor_name: "Fund — Ünïcode".to_owned(),
		issuer_name: "Example Corp".to_owned(),
		report_period_end: "2026-06-30".to_owned(),
		filed_at: "2026-08-14".to_owned(),
		form: "13F-HR".to_owned(),
	};
	for case in vectors["positionChanges"].as_array().unwrap() {
		let change = classify_reported_position_change(
			optional_bits(&case["previous"]),
			optional_bits(&case["current"]),
		);
		assert_eq!(change.as_str(), str_of(&case["change"]), "{case}");
		assert_eq!(
			describe_reported_position_change(change, &context),
			str_of(&case["description"])
		);
	}
	let ratio_json = |result: Result<f64, &'static str>| match result {
		Ok(value) => json!({ "ok": format!("{:016x}", value.to_bits()) }),
		Err(code) => json!({ "error": code }),
	};
	for case in vectors["ratios"].as_array().unwrap() {
		let numerator = bits(&case["numerator"]);
		let denominator = bits(&case["denominator"]);
		let jp = jp_margin_buy_sell_ratio(&JpMarginBalanceFigures {
			margin_buy_balance_shares: numerator,
			margin_sell_balance_shares: denominator,
		});
		let us = us_days_to_cover(&UsShortInterestFigures {
			reported_short_interest_shares: numerator,
			average_daily_volume_shares: optional_bits(&case["volume"]),
		});
		assert_eq!(
			ratio_json(jp.map_err(|error| error.as_str())),
			case["jp"],
			"{case}"
		);
		assert_eq!(
			ratio_json(us.map_err(|error| error.as_str())),
			case["us"],
			"{case}"
		);
		let per = trailing_per(numerator, denominator).map_err(|error| error.as_str());
		assert_eq!(ratio_json(per), case["per"], "{case}");
	}
}

fn decision_json(decision: ClaimDecision) -> Value {
	match decision {
		ClaimDecision::Claim {
			reason,
			next_attempt,
			next_lease_generation,
		} => json!({
			"kind": "claim",
			"reason": match reason { ClaimReason::Fresh => "fresh", ClaimReason::LeaseExpired => "lease-expired" },
			"nextAttempt": next_attempt,
			"nextLeaseGeneration": next_lease_generation,
		}),
		ClaimDecision::Exhausted => json!({ "kind": "exhausted" }),
		ClaimDecision::NotEligible => json!({ "kind": "not-eligible" }),
	}
}

#[test]
fn text_ids_dates_and_plans_match_typescript() {
	let vectors = load("misc.json");
	for case in vectors["truncate"].as_array().unwrap() {
		let max = usize::try_from(nat(&case["max"])).unwrap();
		assert_eq!(
			truncate_text(str_of(&case["input"]), max),
			str_of(&case["output"]),
			"{case}"
		);
	}
	for case in vectors["recent"].as_array().unwrap() {
		let sizes: Vec<u64> = case["sizes"].as_array().unwrap().iter().map(nat).collect();
		let count =
			recent_count_within_budget(&sizes, nat(&case["budget"]), nat(&case["maxItems"]));
		assert_eq!(u64::try_from(count).unwrap(), nat(&case["count"]), "{case}");
	}
	for case in vectors["series"].as_array().unwrap() {
		let parsed = parse_market_series_id(str_of(&case["input"]))
			.ok()
			.map(|id| json!({ "provider": id.provider.as_str(), "symbol": id.symbol }));
		assert_eq!(parsed.unwrap_or(Value::Null), case["output"], "{case}");
	}
	for case in vectors["stocks"].as_array().unwrap() {
		let parsed = parse_stock_id(str_of(&case["input"]))
			.ok()
			.map(|id| json!({ "market": id.market.as_str(), "symbol": id.symbol }));
		assert_eq!(parsed.unwrap_or(Value::Null), case["output"], "{case}");
	}
	for case in vectors["rate"].as_array().unwrap() {
		let grants: Vec<i64> = case["grants"]
			.as_array()
			.unwrap()
			.iter()
			.map(|at| at.as_i64().unwrap())
			.collect();
		let permit = rate_window_permit(
			&grants,
			case["now"].as_i64().unwrap(),
			usize::try_from(nat(&case["maxPer"])).unwrap(),
			case["window"].as_i64().unwrap(),
		);
		let retry = match permit {
			RatePermit::Allowed => None,
			RatePermit::Denied { retry_after_ms } => Some(retry_after_ms),
		};
		assert_eq!(retry, case["retryAfter"].as_i64(), "{case}");
	}
	for case in vectors["dates"].as_array().unwrap() {
		let input = str_of(&case["input"]);
		assert_eq!(
			is_valid_iso_date(input),
			case["valid"].as_bool().unwrap(),
			"{case}"
		);
		for shifted in case["shifted"].as_array().unwrap() {
			let result = add_days_iso(input, bits(&shifted["days"]));
			match result {
				Ok(date) => assert_eq!(
					Some(date.as_str()),
					shifted["output"].as_str(),
					"{input} {shifted}"
				),
				Err(error) => assert_eq!(
					error.as_str(),
					str_of(&shifted["error"]),
					"{input} {shifted}"
				),
			}
		}
	}
	for case in vectors["serials"].as_array().unwrap() {
		let output = excel_serial_to_iso_date(bits(&case["serial"])).ok();
		assert_eq!(output.as_deref(), case["output"].as_str(), "{case}");
	}
	for case in vectors["base32"].as_array().unwrap() {
		let bytes: Vec<u8> = case["bytes"]
			.as_array()
			.unwrap()
			.iter()
			.map(|byte| u8::try_from(nat(byte)).unwrap())
			.collect();
		assert_eq!(
			encode_base32_hex(&bytes).ok().as_deref(),
			case["output"].as_str(),
			"{case}"
		);
	}
	for case in vectors["sync"].as_array().unwrap() {
		let desired: Vec<GoogleEventBody> =
			serde_json::from_value(case["desired"].clone()).unwrap();
		let existing: Vec<ManagedGoogleEvent> =
			serde_json::from_value(case["existing"].clone()).unwrap();
		let output = plan_google_sync(&desired, &existing).ok().map(|plan| {
			json!({
				"inserts": plan.inserts.iter().map(|body| body.id.as_str()).collect::<Vec<_>>(),
				"updates": plan.updates.iter().map(|body| body.id.as_str()).collect::<Vec<_>>(),
				"deletes": plan.deletes,
				"unchanged": plan.unchanged,
			})
		});
		assert_eq!(output.unwrap_or(Value::Null), case["output"], "{case}");
	}
	let now_ms = 1_791_676_800_000;
	for case in vectors["claims"].as_array().unwrap() {
		let job = JobLeaseView {
			state: JobState::parse(str_of(&case["state"])).unwrap(),
			lease_generation: 4,
			lease_owner_id: Some("runner-1".to_owned()),
			lease_expires_at: case["leaseExpiresAt"].as_str().map(str::to_owned),
			attempt: nat(&case["attempt"]),
			max_attempts: 3,
			cancel_requested: false,
		};
		assert_eq!(
			decision_json(decide_claim(&job, now_ms)),
			case["decision"],
			"{case}"
		);
	}
	for case in vectors["expiryIso"].as_array().unwrap() {
		assert_eq!(
			lease_expiry_iso(case["ms"].as_i64().unwrap(), 0),
			str_of(&case["output"]),
			"{case}"
		);
	}
}

#[test]
fn math_matches_v8() {
	let cases = load("math.json");
	let cases = cases.as_array().unwrap();
	let (mut pow_exact, mut pow_total) = (0usize, 0usize);
	for case in cases {
		let (x, y) = (bits(&case["x"]), bits(&case["y"]));
		let exp = research_js::math::exp(y);
		assert!(
			same_bits(Some(exp), &case["exp"]) || (exp.is_nan() && bits(&case["exp"]).is_nan()),
			"exp {case}"
		);
		let log = research_js::math::log(x);
		assert!(
			same_bits(Some(log), &case["log"]) || (log.is_nan() && bits(&case["log"]).is_nan()),
			"log {case}"
		);
		let pow = research_js::math::pow(x, y);
		let expected = bits(&case["pow"]);
		pow_total += 1;
		if pow.to_bits() == expected.to_bits() || (pow.is_nan() && expected.is_nan()) {
			pow_exact += 1;
		} else {
			// The known deviation: one unit in the last place, never more.
			let distance = pow.to_bits().abs_diff(expected.to_bits());
			assert!(distance <= 1 && pow.is_finite(), "pow {case}: {pow:e}");
		}
	}
	assert!(
		pow_exact * 100 >= pow_total * 93,
		"{pow_exact} of {pow_total}"
	);
}
