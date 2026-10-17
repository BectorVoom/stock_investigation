//! Port of `packages/domain/src/jobs/lease.ts`: lease fencing (AGT-011).
//! `leaseGeneration` increases on every claim, so a runner whose lease was
//! superseded is rejected even if its clock disagrees.
//!
//! The Worker API decides claims; the runner does not call these functions
//! today. They are ported because the Lean model proves them and its vectors
//! are replayed here.
//!
//! TEMPORARY (ADR-0030 wave A): `isoToEpochMs` / `epochMsToIso` belong to the
//! seam module `crate::time` (V8 `Date.parse`), which is written in parallel.
//! Until the merge connects it, [`iso_to_epoch_ms`] below reads only the
//! `Date.prototype.toISOString` form (`YYYY-MM-DDTHH:mm:ss.sssZ`, the only
//! form the API stores) and treats anything else as unreadable.

use super::state_machine::JobState;
use crate::calendar::civil_date::{civil_from_days, days_from_civil, days_in_month};

/// The lease-relevant view of a job row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobLeaseView {
	/// Current state.
	pub state: JobState,
	/// Generation of the current lease.
	pub lease_generation: u64,
	/// Runner holding the lease.
	pub lease_owner_id: Option<String>,
	/// ISO instant the lease expires.
	pub lease_expires_at: Option<String>,
	/// Number of claims already granted for this job.
	pub attempt: u64,
	/// Retry ceiling.
	pub max_attempts: u64,
	/// The owner asked to cancel.
	pub cancel_requested: bool,
}

/// Why a claim may proceed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimReason {
	/// `fresh`: the job was pending.
	Fresh,
	/// `lease-expired`: the previous runner's lease ran out.
	LeaseExpired,
}

/// `ClaimDecision`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimDecision {
	/// The job may be claimed.
	Claim {
		/// Why.
		reason: ClaimReason,
		/// `attempt + 1`.
		next_attempt: u64,
		/// `leaseGeneration + 1`.
		next_lease_generation: u64,
	},
	/// The retry ceiling is reached; the job must be failed rather than re-run.
	Exhausted,
	/// Not claimable now.
	NotEligible,
}

/// `LeaseError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum LeaseError {
	/// `NOT_LEASED`.
	#[error("NOT_LEASED")]
	NotLeased,
	/// `STALE_LEASE`.
	#[error("STALE_LEASE")]
	StaleLease,
	/// `WRONG_RUNNER`.
	#[error("WRONG_RUNNER")]
	WrongRunner,
}

impl LeaseError {
	/// The TypeScript code string.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::NotLeased => "NOT_LEASED",
			Self::StaleLease => "STALE_LEASE",
			Self::WrongRunner => "WRONG_RUNNER",
		}
	}
}

/// What a runner presents to prove it still owns a job.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseProof {
	/// The runner's id.
	pub runner_id: String,
	/// The generation it was granted.
	pub lease_generation: u64,
}

fn two_digits(bytes: &[u8]) -> Option<u32> {
	match bytes {
		[tens @ b'0'..=b'9', ones @ b'0'..=b'9'] => {
			Some(u32::from(tens - b'0') * 10 + u32::from(ones - b'0'))
		}
		_ => None,
	}
}

/// TEMPORARY stand-in for `crate::time::iso_to_epoch_ms` (see the module docs).
fn iso_to_epoch_ms(iso: &str) -> Option<i64> {
	let bytes = iso.as_bytes();
	if bytes.len() != 24
		|| bytes.get(10) != Some(&b'T')
		|| bytes.get(13) != Some(&b':')
		|| bytes.get(16) != Some(&b':')
		|| bytes.get(19) != Some(&b'.')
		|| bytes.get(23) != Some(&b'Z')
	{
		return None;
	}
	let (year, month, day) = crate::calendar::civil_date::split_iso_date(iso.get(..10)?)?;
	if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
		return None;
	}
	let hours = two_digits(bytes.get(11..13)?)?;
	let minutes = two_digits(bytes.get(14..16)?)?;
	let seconds = two_digits(bytes.get(17..19)?)?;
	let millis_text = iso.get(20..23)?;
	if !millis_text.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	let millis: i64 = millis_text.parse().ok()?;
	if hours > 24
		|| minutes > 59
		|| seconds > 59
		|| (hours == 24 && (minutes, seconds, millis) != (0, 0, 0))
	{
		return None;
	}
	let day_ms = days_from_civil(year, month, day) * 86_400_000;
	Some(day_ms + i64::from(hours * 3_600 + minutes * 60 + seconds) * 1000 + millis)
}

/// TEMPORARY stand-in for `crate::time::epoch_ms_to_iso` (`toISOString`)
/// for instants in years 0..=9999.
fn epoch_ms_to_iso(ms: i64) -> String {
	let days = ms.div_euclid(86_400_000);
	let in_day = ms.rem_euclid(86_400_000);
	let (year, month, day) = civil_from_days(days);
	format!(
		"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
		in_day / 3_600_000,
		in_day / 60_000 % 60,
		in_day / 1000 % 60,
		in_day % 1000
	)
}

fn is_lease_expired(job: &JobLeaseView, now_ms: i64) -> bool {
	// An unreadable expiry is treated as expired so a corrupt row cannot pin a job forever.
	job.lease_expires_at
		.as_deref()
		.and_then(iso_to_epoch_ms)
		.is_none_or(|expires_ms| expires_ms <= now_ms)
}

/// `decideClaim`.
#[must_use]
pub fn decide_claim(job: &JobLeaseView, now_ms: i64) -> ClaimDecision {
	if job.cancel_requested {
		return ClaimDecision::NotEligible;
	}
	let fresh = job.state == JobState::Pending;
	let recoverable = job.state.is_leased() && is_lease_expired(job, now_ms);
	if !fresh && !recoverable {
		return ClaimDecision::NotEligible;
	}
	if job.attempt >= job.max_attempts {
		return ClaimDecision::Exhausted;
	}
	ClaimDecision::Claim {
		reason: if fresh {
			ClaimReason::Fresh
		} else {
			ClaimReason::LeaseExpired
		},
		next_attempt: job.attempt.saturating_add(1),
		next_lease_generation: job.lease_generation.saturating_add(1),
	}
}

/// `checkLease`: whether `proof` still owns the job. Expiry alone does not
/// revoke ownership: until another claim bumps the generation there is no
/// competing writer, so a late heartbeat or completion from the original
/// runner is still safe to accept.
///
/// # Errors
///
/// The first failing check, in the TypeScript's order.
pub fn check_lease(job: &JobLeaseView, proof: &LeaseProof) -> Result<(), LeaseError> {
	let Some(owner) = job
		.lease_owner_id
		.as_deref()
		.filter(|_| job.state.is_leased())
	else {
		return Err(LeaseError::NotLeased);
	};
	if proof.lease_generation != job.lease_generation {
		return Err(LeaseError::StaleLease);
	}
	if proof.runner_id != owner {
		return Err(LeaseError::WrongRunner);
	}
	Ok(())
}

/// `leaseExpiryIso`.
#[must_use]
pub fn lease_expiry_iso(now_ms: i64, lease_duration_ms: i64) -> String {
	epoch_ms_to_iso(now_ms.saturating_add(lease_duration_ms))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reads_and_writes_iso_instants() {
		let ms = iso_to_epoch_ms("2026-10-11T00:01:00.000Z").unwrap();
		assert_eq!(ms, 1_791_676_860_000);
		assert_eq!(epoch_ms_to_iso(ms), "2026-10-11T00:01:00.000Z");
		assert_eq!(lease_expiry_iso(0, 1), "1970-01-01T00:00:00.001Z");
		assert_eq!(iso_to_epoch_ms("2026-02-30T00:00:00.000Z"), None);
		assert_eq!(iso_to_epoch_ms("not a date"), None);
	}

	#[test]
	fn an_unreadable_expiry_counts_as_expired() {
		let job = JobLeaseView {
			state: JobState::Collecting,
			lease_generation: 3,
			lease_owner_id: Some("runner-1".to_owned()),
			lease_expires_at: Some("garbage".to_owned()),
			attempt: 1,
			max_attempts: 3,
			cancel_requested: false,
		};
		assert_eq!(
			decide_claim(&job, 0),
			ClaimDecision::Claim {
				reason: ClaimReason::LeaseExpired,
				next_attempt: 2,
				next_lease_generation: 4
			}
		);
	}
}
