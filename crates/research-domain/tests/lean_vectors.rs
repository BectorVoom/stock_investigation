//! Replays the Lean 4 conformance vectors (`formal/vectors.json`, see
//! docs/FORMAL_VERIFICATION.md) against the Rust port, family by family, in
//! the same way `tests/formal/conformance.test.ts` replays them against the
//! TypeScript. The dashboard family is replayed by `research-widget-grid`.
#![allow(
	clippy::unwrap_used,
	clippy::expect_used,
	clippy::panic,
	clippy::indexing_slicing
)]

use std::sync::OnceLock;

use research_domain::calendar::google_sync::{
	GoogleEventBody, GoogleEventTransparency, GooglePrivateProperties, ManagedEventStatus,
	ManagedGoogleEvent, encode_base32_hex, google_event_id, plan_google_sync,
};
use research_domain::evidence::verify_claims::{
	ClaimStatus, ClaimType, DraftClaim, DraftEvidenceLink, EvidenceIndex, EvidenceRelation,
	verify_claim,
};
use research_domain::finance::filings::classify_reported_position_change;
use research_domain::jobs::budget::{
	CostReport, ResearchBudget, ResourceUsage, UsageDelta, check_budget,
};
use research_domain::jobs::lease::{
	ClaimDecision, ClaimReason, JobLeaseView, LeaseProof, ReleaseDecision, check_lease,
	decide_claim, decide_release, released_lease_view,
};
use research_domain::jobs::state_machine::{
	JOB_STATES, JobState, LEASED_JOB_STATES, TERMINAL_JOB_STATES,
};
use research_domain::market::rate_window::{RatePermit, rate_window_permit};
use research_domain::text::recent_within_budget::recent_count_within_budget;
use serde_json::Value;

fn vectors() -> &'static Value {
	static VECTORS: OnceLock<Value> = OnceLock::new();
	VECTORS.get_or_init(|| {
		let path = format!("{}/../../formal/vectors.json", env!("CARGO_MANIFEST_DIR"));
		serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
	})
}

fn family(name: &str) -> &'static [Value] {
	vectors()[name]
		.as_array()
		.unwrap_or_else(|| panic!("missing family {name}"))
}

fn state(value: &Value) -> JobState {
	JobState::parse(value.as_str().unwrap()).unwrap()
}

fn nat(value: &Value) -> u64 {
	value.as_u64().unwrap()
}

fn int(value: &Value) -> i64 {
	value.as_i64().unwrap()
}

fn names(states: &[JobState]) -> Vec<&'static str> {
	states.iter().map(|state| state.as_str()).collect()
}

fn strings(value: &Value) -> Vec<&str> {
	value
		.as_array()
		.unwrap()
		.iter()
		.map(|item| item.as_str().unwrap())
		.collect()
}

#[test]
fn job_states_match_the_model() {
	assert_eq!(names(&JOB_STATES), strings(&vectors()["states"]));
	assert_eq!(
		names(&TERMINAL_JOB_STATES),
		strings(&vectors()["terminalStates"])
	);
	assert_eq!(
		names(&LEASED_JOB_STATES),
		strings(&vectors()["leasedStates"])
	);
	let filtered: Vec<JobState> = JOB_STATES
		.into_iter()
		.filter(|state| state.is_terminal())
		.collect();
	assert_eq!(names(&filtered), strings(&vectors()["terminalStates"]));
	let filtered: Vec<JobState> = JOB_STATES
		.into_iter()
		.filter(|state| state.is_leased())
		.collect();
	assert_eq!(names(&filtered), strings(&vectors()["leasedStates"]));
	let transitions = vectors()["transitions"].as_object().unwrap();
	assert_eq!(transitions.len(), JOB_STATES.len());
	for from in JOB_STATES {
		assert_eq!(
			names(from.transitions()),
			strings(&transitions[from.as_str()]),
			"{from:?}"
		);
	}
}

const NOW_MS: i64 = 1_791_676_800_000; // Date.parse("2026-10-11T00:00:00.000Z")
const PAST: &str = "2026-10-10T23:59:00.000Z";
const FUTURE: &str = "2026-10-11T00:01:00.000Z";

fn decision_json(decision: ClaimDecision) -> Value {
	match decision {
		ClaimDecision::Claim {
			reason,
			next_attempt,
			next_lease_generation,
		} => serde_json::json!({
			"kind": "claim",
			"reason": match reason { ClaimReason::Fresh => "fresh", ClaimReason::LeaseExpired => "lease-expired" },
			"nextAttempt": next_attempt,
			"nextLeaseGeneration": next_lease_generation,
		}),
		ClaimDecision::Exhausted => serde_json::json!({ "kind": "exhausted" }),
		ClaimDecision::NotEligible => serde_json::json!({ "kind": "not-eligible" }),
	}
}

#[test]
fn decide_claim_matches_the_model() {
	let cases = family("decideClaim");
	assert!(cases.len() > 500);
	for case in cases {
		// The model's single "lease expired" bit covers both a past expiry and a missing one.
		let expiries: &[Option<&str>] = if case["leaseExpired"].as_bool().unwrap() {
			&[Some(PAST), None]
		} else {
			&[Some(FUTURE)]
		};
		for expiry in expiries {
			let job = JobLeaseView {
				state: state(&case["state"]),
				lease_generation: nat(&case["leaseGeneration"]),
				lease_owner_id: Some("runner-1".to_owned()),
				lease_expires_at: expiry.map(str::to_owned),
				attempt: nat(&case["attempt"]),
				max_attempts: nat(&case["maxAttempts"]),
				cancel_requested: case["cancelRequested"].as_bool().unwrap(),
			};
			assert_eq!(
				decision_json(decide_claim(&job, NOW_MS)),
				case["decision"],
				"{case}"
			);
		}
	}
}

#[test]
fn check_lease_matches_the_model() {
	let cases = family("checkLease");
	assert!(!cases.is_empty());
	for case in cases {
		let job = JobLeaseView {
			state: state(&case["state"]),
			lease_generation: nat(&case["leaseGeneration"]),
			lease_owner_id: case["leaseOwner"]
				.as_u64()
				.map(|owner| format!("runner-{owner}")),
			lease_expires_at: Some(FUTURE.to_owned()),
			attempt: 1,
			max_attempts: 3,
			cancel_requested: false,
		};
		let proof = LeaseProof {
			runner_id: format!("runner-{}", nat(&case["runner"])),
			lease_generation: nat(&case["proofGeneration"]),
		};
		let result = check_lease(&job, &proof).map_or_else(|error| error.as_str(), |()| "OK");
		assert_eq!(result, case["result"].as_str().unwrap(), "{case}");
	}
}

fn release_json(decision: ReleaseDecision) -> Value {
	match decision {
		ReleaseDecision::Requeue { next_attempt } => {
			serde_json::json!({ "kind": "requeue", "nextAttempt": next_attempt })
		}
		ReleaseDecision::Cancel => serde_json::json!({ "kind": "cancel" }),
	}
}

#[test]
fn decide_release_matches_the_model() {
	let cases = family("decideRelease");
	assert!(cases.len() > 1000);
	for case in cases {
		let job = JobLeaseView {
			state: state(&case["state"]),
			lease_generation: nat(&case["leaseGeneration"]),
			lease_owner_id: case["leaseOwner"]
				.as_u64()
				.map(|owner| format!("runner-{owner}")),
			lease_expires_at: Some(FUTURE.to_owned()),
			attempt: nat(&case["attempt"]),
			max_attempts: 3,
			cancel_requested: case["cancelRequested"].as_bool().unwrap(),
		};
		let proof = LeaseProof {
			runner_id: format!("runner-{}", nat(&case["runner"])),
			lease_generation: nat(&case["proofGeneration"]),
		};
		match decide_release(&job, &proof) {
			Err(error) => {
				assert_eq!(
					serde_json::json!({ "kind": "rejected", "error": error.as_str() }),
					case["decision"],
					"{case}"
				);
				assert!(case["releasedState"].is_null(), "{case}");
			}
			Ok(decision) => {
				assert_eq!(release_json(decision), case["decision"], "{case}");
				let released = released_lease_view(&job, decision);
				assert_eq!(
					released.state.as_str(),
					case["releasedState"].as_str().unwrap(),
					"{case}"
				);
				assert_eq!(released.lease_generation, job.lease_generation, "{case}");
				let check =
					check_lease(&released, &proof).map_or_else(|error| error.as_str(), |()| "OK");
				assert_eq!(check, case["releasedCheck"].as_str().unwrap(), "{case}");
				assert_eq!(
					decision_json(decide_claim(&released, NOW_MS)),
					case["releasedClaim"],
					"{case}"
				);
			}
		}
	}
}

#[test]
fn check_budget_matches_the_model() {
	let budget = &vectors()["budget"];
	let limits = &budget["limits"];
	let limits = ResearchBudget {
		max_agent_steps: nat(&limits["maxAgentSteps"]),
		max_tool_calls: nat(&limits["maxToolCalls"]),
		max_wall_clock_ms: nat(&limits["maxWallClockMs"]),
		max_input_bytes: nat(&limits["maxInputBytes"]),
		max_spend_usd: limits["maxSpendUsd"].as_f64(),
	};
	let cases = budget["vectors"].as_array().unwrap();
	assert_eq!(cases.len(), 1536);
	for case in cases {
		let limits = ResearchBudget {
			max_spend_usd: case["maxSpendUsd"].as_f64(),
			..limits
		};
		let usage = &case["usage"];
		let next = &case["next"];
		let usage = ResourceUsage {
			agent_steps: nat(&usage[0]),
			tool_calls: nat(&usage[1]),
			input_bytes: nat(&usage[2]),
			known_cost_usd: usage[3].as_f64().unwrap(),
			has_unmetered_usage: false,
		};
		let next = UsageDelta {
			agent_steps: nat(&next[0]),
			tool_calls: nat(&next[1]),
			input_bytes: nat(&next[2]),
			cost_usd: CostReport::Usd(next[3].as_f64().unwrap()),
		};
		let result = check_budget(&limits, &usage, int(&case["elapsedMs"]), &next);
		let expected = case["limit"].as_str();
		assert_eq!(result.err().map(|limit| limit.as_str()), expected, "{case}");
	}
}

#[test]
fn position_changes_match_the_model() {
	for case in family("positionChange") {
		let forms = |shares: f64| {
			if shares == 0.0 {
				vec![Some(0.0), None]
			} else {
				vec![Some(shares)]
			}
		};
		for previous in forms(case["previous"].as_f64().unwrap()) {
			for current in forms(case["current"].as_f64().unwrap()) {
				assert_eq!(
					classify_reported_position_change(previous, current).as_str(),
					case["change"].as_str().unwrap(),
					"{case}"
				);
			}
		}
	}
}

#[test]
fn claim_status_matches_the_model() {
	let index = EvidenceIndex::from_normalized([(
		"ev".to_owned(),
		"revenue rose 12 percent year on year according to the filing".to_owned(),
	)]);
	let cases = family("claimStatus");
	assert_eq!(cases.len(), 12);
	for case in cases {
		let link = |relation, quote: &str| DraftEvidenceLink {
			evidence_id: "ev".to_owned(),
			relation,
			quote: Some(quote.to_owned()),
		};
		let mut links = Vec::new();
		for _ in 0..nat(&case["supports"]) {
			links.push(link(
				EvidenceRelation::Supports,
				"revenue rose 12 percent year on year",
			));
		}
		for _ in 0..nat(&case["contradicts"]) {
			links.push(link(
				EvidenceRelation::Contradicts,
				"according to the filing",
			));
		}
		let claim = DraftClaim {
			claim_id: "c".to_owned(),
			// 99 appears nowhere in the evidence; 12 does.
			text: if nat(&case["unsupportedNumbers"]) > 0 {
				"Revenue rose 99 percent.".to_owned()
			} else {
				"Revenue rose 12 percent.".to_owned()
			},
			claim_type: ClaimType::Observation,
			links,
		};
		let expected = match case["status"].as_str().unwrap() {
			"supported" => ClaimStatus::Supported,
			"unsupported" => ClaimStatus::Unsupported,
			"conflicting" => ClaimStatus::Conflicting,
			other => panic!("unknown status {other}"),
		};
		assert_eq!(verify_claim(&claim, &index).status, expected, "{case}");
	}
}

fn usize_of(value: &Value) -> usize {
	usize::try_from(nat(value)).unwrap()
}

fn grants(value: &Value) -> Vec<i64> {
	value.as_array().unwrap().iter().map(int).collect()
}

#[test]
fn rate_permits_match_the_model() {
	let cases = family("ratePermit");
	assert_eq!(cases.len(), 1092);
	for case in cases {
		let result = rate_window_permit(
			&grants(&case["grants"]),
			int(&case["now"]),
			usize_of(&case["maxPer"]),
			int(&case["window"]),
		);
		match result {
			RatePermit::Allowed => assert!(case["allowed"].as_bool().unwrap(), "{case}"),
			RatePermit::Denied { retry_after_ms } => {
				assert!(!case["allowed"].as_bool().unwrap(), "{case}");
				assert_eq!(retry_after_ms, int(&case["retryAfter"]), "{case}");
			}
		}
	}
}

#[test]
fn recorded_rate_grants_match_the_model() {
	let cases = family("rateRecord");
	assert_eq!(cases.len(), 120);
	for case in cases {
		let max_per = usize_of(&case["maxPer"]);
		let window = int(&case["window"]);
		let mut recorded: Vec<i64> = Vec::new();
		for at in grants(&case["times"]) {
			if rate_window_permit(&recorded, at, max_per, window) == RatePermit::Allowed {
				recorded.push(at);
			}
		}
		assert_eq!(recorded, grants(&case["recorded"]), "{case}");
		// The proved bound, checked independently: no window holds more than maxPer.
		for now in 0..=5 {
			let in_window = recorded
				.iter()
				.filter(|at| **at > now - window && **at <= now)
				.count();
			assert!(in_window <= max_per, "{case} @{now}");
		}
	}
}

#[test]
fn recent_counts_match_the_model() {
	let cases = family("recentWithinBudget");
	assert_eq!(cases.len(), 2040);
	for case in cases {
		// The model's list is newest first; the port takes oldest first.
		let mut oldest_first: Vec<u64> =
			case["sizes"].as_array().unwrap().iter().map(nat).collect();
		oldest_first.reverse();
		let count =
			recent_count_within_budget(&oldest_first, nat(&case["budget"]), nat(&case["maxItems"]));
		assert_eq!(count, usize_of(&case["count"]), "{case}");
	}
}

fn body(id: u64, fp: u64) -> GoogleEventBody {
	GoogleEventBody {
		id: format!("s{id}"),
		summary: format!("fp-{fp}"),
		description: format!("desc-{fp}"),
		start_date: "2026-10-29".to_owned(),
		end_date: "2026-10-30".to_owned(),
		private_properties: GooglePrivateProperties {
			research_workspace: "earnings".to_owned(),
			stock_id: "us:AAPL".to_owned(),
			period_key: "2026-q4".to_owned(),
		},
		source_title: "Finnhub".to_owned(),
		source_url: "https://finnhub.io/".to_owned(),
	}
}

fn pairs(value: &Value) -> Vec<(u64, u64)> {
	value
		.as_array()
		.unwrap()
		.iter()
		.map(|entry| (nat(&entry["id"]), nat(&entry["fp"])))
		.collect()
}

fn id_of(id: &str) -> u64 {
	id[1..].parse().unwrap()
}

#[test]
fn google_sync_plans_match_the_model() {
	let cases = family("syncPlan");
	assert_eq!(cases.len(), 1364);
	for case in cases {
		let desired: Vec<GoogleEventBody> = pairs(&case["desired"])
			.into_iter()
			.map(|(id, fp)| body(id, fp))
			.collect();
		let existing: Vec<ManagedGoogleEvent> = case["existing"]
			.as_array()
			.unwrap()
			.iter()
			.map(|row| ManagedGoogleEvent {
				id: format!("s{}", nat(&row["id"])),
				status: if row["cancelled"].as_bool().unwrap() {
					ManagedEventStatus::Cancelled
				} else {
					ManagedEventStatus::Confirmed
				},
				start_date: "2026-10-29".to_owned(),
				end_date: "2026-10-30".to_owned(),
				summary: format!("fp-{}", nat(&row["fp"])),
				description: format!("desc-{}", nat(&row["fp"])),
				// A busy row is `opaque`; every desired body is written `transparent`.
				transparency: if row["busy"].as_bool().unwrap() {
					GoogleEventTransparency::Opaque
				} else {
					GoogleEventTransparency::Transparent
				},
			})
			.collect();
		let plan = plan_google_sync(&desired, &existing).unwrap();
		let pair_of =
			|body: &&GoogleEventBody| (id_of(&body.id), body.summary[3..].parse().unwrap());
		assert_eq!(
			plan.inserts.iter().map(pair_of).collect::<Vec<_>>(),
			pairs(&case["inserts"]),
			"{case}"
		);
		assert_eq!(
			plan.updates.iter().map(pair_of).collect::<Vec<_>>(),
			pairs(&case["updates"]),
			"{case}"
		);
		let ids = |ids: &[&str]| ids.iter().map(|id| id_of(id)).collect::<Vec<_>>();
		let expected_ids = |value: &Value| {
			value
				.as_array()
				.unwrap()
				.iter()
				.map(nat)
				.collect::<Vec<_>>()
		};
		assert_eq!(ids(&plan.deletes), expected_ids(&case["deletes"]), "{case}");
		assert_eq!(
			ids(&plan.unchanged),
			expected_ids(&case["unchanged"]),
			"{case}"
		);
	}
}

#[test]
fn base32hex_matches_the_model() {
	const ALPHABET: &str = "0123456789abcdefghijklmnopqrstuv";
	let cases = family("base32hex");
	assert_eq!(cases.len(), 17);
	for case in cases {
		let bytes: Vec<u8> = case["bytes"]
			.as_array()
			.unwrap()
			.iter()
			.map(|byte| u8::try_from(nat(byte)).unwrap())
			.collect();
		let encoded = encode_base32_hex(&bytes).unwrap();
		let chars: Vec<u64> = encoded
			.chars()
			.map(|char| u64::try_from(ALPHABET.find(char).unwrap()).unwrap())
			.collect();
		let expected: Vec<u64> = case["chars"].as_array().unwrap().iter().map(nat).collect();
		assert_eq!(chars, expected, "{case}");
		assert_eq!(encoded.len(), bytes.len() * 8 / 5);
		if bytes.len() == 20 {
			assert_eq!(google_event_id(&bytes).unwrap(), encoded);
		}
	}
}
