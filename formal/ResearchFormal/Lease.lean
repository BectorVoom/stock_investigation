import ResearchFormal.Basic
import ResearchFormal.JobStateMachine

/-!
# Lease claiming and fencing

Formal model of `decideClaim` and `checkLease` in
`packages/domain/src/jobs/lease.ts` (architecture section 5.2, rule AGT-011).

Time is abstracted to one bit, `leaseExpired`, which stands for
"`leaseExpiresAt` is absent, unreadable, or not after now".
-/

namespace Research

structure Job where
  state : JobState
  generation : Nat
  /-- Credential id of the runner holding the lease, if any. -/
  owner : Option Nat
  leaseExpired : Bool
  /-- Number of claims already granted. -/
  attempt : Nat
  maxAttempts : Nat
  cancelRequested : Bool
  deriving Repr

inductive ClaimDecision where
  /-- Grant a lease. `fresh` is false when recovering an expired lease. -/
  | claim (nextAttempt nextGeneration : Nat) (fresh : Bool)
  | exhausted
  | notEligible
  deriving DecidableEq, Repr

def decideClaim (j : Job) : ClaimDecision :=
  if j.cancelRequested then .notEligible
  else if j.state = .pending then
    if j.attempt ≥ j.maxAttempts then .exhausted
    else .claim (j.attempt + 1) (j.generation + 1) true
  else if j.state.isLeased = true ∧ j.leaseExpired = true then
    if j.attempt ≥ j.maxAttempts then .exhausted
    else .claim (j.attempt + 1) (j.generation + 1) false
  else .notEligible

/-- The job after the Worker grants a claim to `runner`. -/
def applyClaim (j : Job) (runner nextAttempt nextGeneration : Nat) : Job :=
  { j with
    state := .claimed, generation := nextGeneration, owner := some runner,
    leaseExpired := false, attempt := nextAttempt }

inductive LeaseCheck where
  | ok | notLeased | stale | wrongRunner
  deriving DecidableEq, Repr

def checkLease (j : Job) (runner generation : Nat) : LeaseCheck :=
  if j.state.isLeased = false ∨ j.owner = none then .notLeased
  else if generation ≠ j.generation then .stale
  else if j.owner ≠ some runner then .wrongRunner
  else .ok

/--
What a granted claim implies about the job it was granted for. Every other
claim theorem is a corollary of this characterisation.
-/
theorem claim_spec {j : Job} {a g : Nat} {f : Bool} (h : decideClaim j = .claim a g f) :
    j.cancelRequested = false ∧ j.attempt < j.maxAttempts ∧
    a = j.attempt + 1 ∧ g = j.generation + 1 ∧
    ((f = true ∧ j.state = .pending) ∨
      (f = false ∧ j.state.isLeased = true ∧ j.leaseExpired = true)) := by
  unfold decideClaim at h
  by_cases hc : j.cancelRequested = true
  · rw [ifPos hc] at h
    cases h
  · rw [ifNeg hc] at h
    have hc' : j.cancelRequested = false := by
      cases hv : j.cancelRequested with
      | false => rfl
      | true => exact absurd hv hc
    by_cases hp : j.state = .pending
    · rw [ifPos hp] at h
      by_cases ha : j.attempt ≥ j.maxAttempts
      · rw [ifPos ha] at h
        cases h
      · rw [ifNeg ha] at h
        injection h with h1 h2 h3
        exact ⟨hc', by omega, h1.symm, h2.symm, Or.inl ⟨h3.symm, hp⟩⟩
    · rw [ifNeg hp] at h
      by_cases hl : j.state.isLeased = true ∧ j.leaseExpired = true
      · rw [ifPos hl] at h
        by_cases ha : j.attempt ≥ j.maxAttempts
        · rw [ifPos ha] at h
          cases h
        · rw [ifNeg ha] at h
          injection h with h1 h2 h3
          exact ⟨hc', by omega, h1.symm, h2.symm, Or.inr ⟨h3.symm, hl.1, hl.2⟩⟩
      · rw [ifNeg hl] at h
        cases h

/-- A granted claim bumps the attempt and the generation by exactly one. -/
theorem claim_increments {j : Job} {a g : Nat} {f : Bool} (h : decideClaim j = .claim a g f) :
    a = j.attempt + 1 ∧ g = j.generation + 1 :=
  ⟨(claim_spec h).2.2.1, (claim_spec h).2.2.2.1⟩

/-- The retry ceiling is never exceeded: a granted attempt is within `maxAttempts`. -/
theorem claim_within_retry_ceiling {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) : a ≤ j.maxAttempts := by
  have hs := claim_spec h
  omega

/-- A cancelled job is never handed out. -/
theorem cancelled_not_claimable (j : Job) (h : j.cancelRequested = true) :
    decideClaim j = .notEligible := by
  unfold decideClaim
  rw [ifPos h]

/-- A job that is neither pending nor leased can never be claimed. -/
theorem unclaimable_when_not_open (j : Job) (hp : j.state ≠ .pending)
    (hl : j.state.isLeased = false) : decideClaim j = .notEligible := by
  have hno : ¬(j.state.isLeased = true ∧ j.leaseExpired = true) := by
    intro h
    rw [hl] at h
    exact absurd h.1 (by decide)
  unfold decideClaim
  by_cases hc : j.cancelRequested = true
  · rw [ifPos hc]
  · rw [ifNeg hc, ifNeg hp, ifNeg hno]

/-- A finished job is never handed out. -/
theorem terminal_not_claimable (j : Job) (h : j.state.isTerminal = true) :
    decideClaim j = .notEligible := by
  have hp : j.state ≠ .pending := by
    intro hp
    rw [hp] at h
    exact absurd h (by decide)
  have hl : j.state.isLeased = false := by
    cases hv : j.state.isLeased with
    | false => rfl
    | true =>
      have := JobState.leased_not_terminal j.state hv
      rw [this] at h
      exact absurd h (by decide)
  exact unclaimable_when_not_open j hp hl

/--
**Single lease.** While a lease is live (leased state, not expired) the job is
not eligible, so the Worker never grants a second concurrent lease.
-/
theorem live_lease_not_claimable (j : Job) (hl : j.state.isLeased = true)
    (he : j.leaseExpired = false) : decideClaim j = .notEligible := by
  have hp : j.state ≠ .pending := by
    intro hp
    rw [hp] at hl
    exact absurd hl (by decide)
  have hno : ¬(j.state.isLeased = true ∧ j.leaseExpired = true) := by
    intro h
    rw [he] at h
    exact absurd h.2 (by decide)
  unfold decideClaim
  by_cases hc : j.cancelRequested = true
  · rw [ifPos hc]
  · rw [ifNeg hc, ifNeg hp, ifNeg hno]

/-- What passing the lease check implies. -/
theorem lease_ok_spec {j : Job} {runner generation : Nat}
    (h : checkLease j runner generation = .ok) :
    j.state.isLeased = true ∧ j.owner = some runner ∧ generation = j.generation := by
  unfold checkLease at h
  by_cases h1 : j.state.isLeased = false ∨ j.owner = none
  · rw [ifPos h1] at h
    cases h
  · rw [ifNeg h1] at h
    by_cases h2 : generation ≠ j.generation
    · rw [ifPos h2] at h
      cases h
    · rw [ifNeg h2] at h
      by_cases h3 : j.owner ≠ some runner
      · rw [ifPos h3] at h
        cases h
      · refine ⟨?_, Classical.not_not.mp h3, Classical.not_not.mp h2⟩
        cases hl : j.state.isLeased with
        | true => rfl
        | false => exact absurd (Or.inl hl) h1

/-- After a claim, the claiming runner holds the lease under the new generation. -/
theorem claimant_holds_lease (j : Job) (runner a g : Nat) :
    checkLease (applyClaim j runner a g) runner g = .ok := by
  simp [checkLease, applyClaim, JobState.isLeased]

/--
**Fencing.** Once a job has been re-claimed, any proof carrying the previous
generation (or any older one) is rejected, whichever runner presents it — even
the runner that now holds the lease.
-/
theorem stale_generation_rejected {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) (newRunner anyRunner oldGeneration : Nat)
    (hold : oldGeneration ≤ j.generation) :
    checkLease (applyClaim j newRunner a g) anyRunner oldGeneration = .stale := by
  have hg : g = j.generation + 1 := (claim_increments h).2
  have hne : oldGeneration ≠ g := by omega
  simp [checkLease, applyClaim, JobState.isLeased, hne]

/-- A runner that does not own the lease is rejected even with the right generation. -/
theorem other_runner_rejected (j : Job) (runner other a g : Nat) (hne : other ≠ runner) :
    checkLease (applyClaim j runner a g) other g = .wrongRunner := by
  have hne' : runner ≠ other := fun h => hne h.symm
  simp [checkLease, applyClaim, JobState.isLeased, hne']

/--
**Mutual exclusion.** At any moment at most one (runner, generation) pair passes
the lease check for a job.
-/
theorem lease_holder_unique {j : Job} {r₁ g₁ r₂ g₂ : Nat}
    (h₁ : checkLease j r₁ g₁ = .ok) (h₂ : checkLease j r₂ g₂ = .ok) : r₁ = r₂ ∧ g₁ = g₂ := by
  have s₁ := lease_ok_spec h₁
  have s₂ := lease_ok_spec h₂
  refine ⟨?_, by omega⟩
  exact Option.some.inj (s₁.2.1.symm.trans s₂.2.1)

/-- Generations only grow: a claim never reuses an earlier generation number. -/
theorem generation_strictly_increases {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) (runner : Nat) :
    j.generation < (applyClaim j runner a g).generation := by
  have hg : g = j.generation + 1 := (claim_increments h).2
  show j.generation < g
  omega

/--
**No lost-then-regained lease.** Combining the above: after a re-claim by
`newRunner`, the previous holder's proof fails, and it keeps failing after any
number of further claims, because generations never decrease.
-/
theorem old_proof_never_valid_again {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) (newRunner oldRunner oldGeneration : Nat)
    (hold : oldGeneration ≤ j.generation) :
    checkLease (applyClaim j newRunner a g) oldRunner oldGeneration ≠ .ok := by
  rw [stale_generation_rejected h newRunner oldRunner oldGeneration hold]
  decide

/-!
## Lease hand-back on shutdown (ADR-0036)

Formal model of `decideRelease` and `releasedLeaseView` in
`packages/domain/src/jobs/lease.ts`. A runner that is shutting down gives its
lease back instead of letting it run out: the job returns to `pending` with
its claim refunded, or — when the owner asked to cancel meanwhile — is
cancelled at once, as an owner cancel of a job without a live lease is.
-/

inductive ReleaseDecision where
  /-- Back to `pending`, the claim refunded to `nextAttempt`. -/
  | requeue (nextAttempt : Nat)
  /-- The owner asked to cancel while the lease was held: cancelled now. -/
  | cancel
  /-- Not the current holder: the lease check's verdict. -/
  | rejected (reason : LeaseCheck)
  deriving DecidableEq, Repr

def decideRelease (j : Job) (runner generation : Nat) : ReleaseDecision :=
  if checkLease j runner generation = .ok then
    if j.cancelRequested then .cancel else .requeue (j.attempt - 1)
  else .rejected (checkLease j runner generation)

/-- The job after a `requeue` hand-back: pending, no owner, the generation kept. -/
def applyRequeue (j : Job) (nextAttempt : Nat) : Job :=
  { j with state := .pending, owner := none, leaseExpired := true, attempt := nextAttempt }

/-- The job after a `cancel` hand-back. -/
def applyReleaseCancel (j : Job) : Job :=
  { j with state := .cancelled, owner := none, leaseExpired := true, cancelRequested := false }

/-- The job after the Worker applies a hand-back decision (a refusal changes nothing). -/
def applyRelease (j : Job) : ReleaseDecision → Job
  | .requeue a => applyRequeue j a
  | .cancel => applyReleaseCancel j
  | .rejected _ => j

/-- What a granted `requeue` implies. -/
theorem release_requeue_spec {j : Job} {runner generation a : Nat}
    (h : decideRelease j runner generation = .requeue a) :
    checkLease j runner generation = .ok ∧ j.cancelRequested = false ∧ a = j.attempt - 1 := by
  unfold decideRelease at h
  by_cases hc : checkLease j runner generation = .ok
  · rw [ifPos hc] at h
    by_cases hx : j.cancelRequested = true
    · rw [ifPos hx] at h
      cases h
    · rw [ifNeg hx] at h
      injection h with h1
      refine ⟨hc, ?_, h1.symm⟩
      cases hv : j.cancelRequested with
      | false => rfl
      | true => exact absurd hv hx
  · rw [ifNeg hc] at h
    cases h

/-- What a granted `cancel` implies. -/
theorem release_cancel_spec {j : Job} {runner generation : Nat}
    (h : decideRelease j runner generation = .cancel) :
    checkLease j runner generation = .ok ∧ j.cancelRequested = true := by
  unfold decideRelease at h
  by_cases hc : checkLease j runner generation = .ok
  · rw [ifPos hc] at h
    by_cases hx : j.cancelRequested = true
    · exact ⟨hc, hx⟩
    · rw [ifNeg hx] at h
      cases h
  · rw [ifNeg hc] at h
    cases h

/-- **Only the holder releases.** Anyone else is refused with the lease check's verdict. -/
theorem non_holder_cannot_release {j : Job} {runner generation : Nat}
    (h : checkLease j runner generation ≠ .ok) :
    decideRelease j runner generation = .rejected (checkLease j runner generation) := by
  unfold decideRelease
  rw [ifNeg h]

/--
A granted hand-back (either kind) was made by the runner that owns the lease,
presenting the current generation, while the job was leased.
-/
theorem release_by_holder_only {j : Job} {runner generation : Nat}
    (h : (∃ a, decideRelease j runner generation = .requeue a) ∨
      decideRelease j runner generation = .cancel) :
    j.state.isLeased = true ∧ j.owner = some runner ∧ generation = j.generation := by
  rcases h with ⟨a, ha⟩ | hc
  · exact lease_ok_spec (release_requeue_spec ha).1
  · exact lease_ok_spec (release_cancel_spec hc).1

/--
**Refund.** A hand-back never raises the attempt count, and gives back exactly
one claim (a job with no claim recorded stays at zero).
-/
theorem release_refunds_one_claim {j : Job} {runner generation a : Nat}
    (h : decideRelease j runner generation = .requeue a) :
    a ≤ j.attempt ∧ (0 < j.attempt → a + 1 = j.attempt) := by
  have ha := (release_requeue_spec h).2.2
  omega

/-- **Round trip.** A claim followed by the claimant's hand-back leaves the attempt count unchanged. -/
theorem claim_then_release_restores_attempt {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) (runner : Nat) :
    decideRelease (applyClaim j runner a g) runner g = .requeue j.attempt := by
  have hs := claim_spec h
  have hok := claimant_holds_lease j runner a g
  have hcr : ¬((applyClaim j runner a g).cancelRequested = true) := by
    show ¬(j.cancelRequested = true)
    rw [hs.1]
    decide
  unfold decideRelease
  rw [ifPos hok, ifNeg hcr]
  show ReleaseDecision.requeue (a - 1) = .requeue j.attempt
  rw [hs.2.2.1]
  rfl

/--
**The released proof is dead.** After a hand-back the job is not leased, so
every proof — the released one included — is refused.
-/
theorem requeued_rejects_every_proof (j : Job) (a runner generation : Nat) :
    checkLease (applyRequeue j a) runner generation = .notLeased := by
  simp [checkLease, applyRequeue, JobState.isLeased]

theorem release_cancelled_rejects_every_proof (j : Job) (runner generation : Nat) :
    checkLease (applyReleaseCancel j) runner generation = .notLeased := by
  simp [checkLease, applyReleaseCancel, JobState.isLeased]

/-- A hand-back cannot be repeated: once requeued, any further release is refused. -/
theorem release_not_repeatable (j : Job) (a runner generation : Nat) :
    decideRelease (applyRequeue j a) runner generation = .rejected .notLeased := by
  have hn := requeued_rejects_every_proof j a runner generation
  have hne : checkLease (applyRequeue j a) runner generation ≠ .ok := by
    rw [hn]
    decide
  rw [non_holder_cannot_release hne, hn]

/-- A hand-back keeps the generation; only a claim moves it. -/
theorem requeue_keeps_generation (j : Job) (a : Nat) :
    (applyRequeue j a).generation = j.generation := rfl

/--
**Claimable fresh.** The next claim takes a requeued job as a fresh claim with
the refunded attempt plus one and the next generation — unless the refunded
count is already at the retry ceiling.
-/
theorem requeued_claimable_fresh {j : Job} {runner generation a : Nat}
    (h : decideRelease j runner generation = .requeue a) :
    decideClaim (applyRequeue j a) =
      if a ≥ j.maxAttempts then .exhausted else .claim (a + 1) (j.generation + 1) true := by
  have hs := release_requeue_spec h
  have hcr : ¬((applyRequeue j a).cancelRequested = true) := by
    show ¬(j.cancelRequested = true)
    rw [hs.2.1]
    decide
  have hp : (applyRequeue j a).state = .pending := rfl
  unfold decideClaim
  rw [ifNeg hcr, ifPos hp]
  rfl

/-- Within the retry ceiling the requeued job is always claimed fresh. -/
theorem requeued_claim_within_ceiling {j : Job} {runner generation a : Nat}
    (h : decideRelease j runner generation = .requeue a)
    (hceil : j.attempt ≤ j.maxAttempts) (hpos : 0 < j.maxAttempts) :
    decideClaim (applyRequeue j a) = .claim (a + 1) (j.generation + 1) true := by
  rw [requeued_claimable_fresh h]
  have ha := (release_requeue_spec h).2.2
  have hlt : ¬(a ≥ j.maxAttempts) := by omega
  rw [ifNeg hlt]

/--
**A restart costs no attempt.** Claim, hand back, claim again: the second
claim is fresh and carries the same attempt number as the first.
-/
theorem restart_costs_no_attempt {j : Job} {a g : Nat} {f : Bool}
    (h : decideClaim j = .claim a g f) (runner : Nat) :
    decideClaim (applyRequeue (applyClaim j runner a g) j.attempt) = .claim a (g + 1) true := by
  have hs := claim_spec h
  rw [requeued_claimable_fresh (claim_then_release_restores_attempt h runner)]
  have hlt : ¬(j.attempt ≥ (applyClaim j runner a g).maxAttempts) := by
    show ¬(j.attempt ≥ j.maxAttempts)
    omega
  rw [ifNeg hlt]
  show ClaimDecision.claim (j.attempt + 1) (g + 1) true = .claim a (g + 1) true
  rw [hs.2.2.1]

/--
**Release then claim fences the released proof.** The next claim strictly
raises the generation, so the released proof stays refused once the job is
leased again — whoever holds it, the releasing runner included.
-/
theorem release_then_claim_fences {j : Job} {runner generation a a' g' : Nat} {f : Bool}
    (h : decideRelease j runner generation = .requeue a)
    (hc : decideClaim (applyRequeue j a) = .claim a' g' f) (newRunner anyRunner : Nat) :
    generation < g' ∧
      checkLease (applyClaim (applyRequeue j a) newRunner a' g') anyRunner generation = .stale := by
  have hg : generation = j.generation := (lease_ok_spec (release_requeue_spec h).1).2.2
  have hg' : g' = j.generation + 1 := (claim_increments hc).2
  refine ⟨by omega, ?_⟩
  have hold : generation ≤ (applyRequeue j a).generation := by
    show generation ≤ j.generation
    omega
  exact stale_generation_rejected hc newRunner anyRunner generation hold

/-- A requeue is a legal transition of the state machine. -/
theorem release_requeue_legal {j : Job} {runner generation a : Nat}
    (h : decideRelease j runner generation = .requeue a) :
    JobState.canStep j.state .pending = true :=
  JobState.leased_can_requeue j.state (lease_ok_spec (release_requeue_spec h).1).1

/-- A hand-back cancel is a legal transition of the state machine. -/
theorem release_cancel_legal {j : Job} {runner generation : Nat}
    (h : decideRelease j runner generation = .cancel) :
    JobState.canStep j.state .cancelled = true :=
  JobState.leased_can_cancel j.state (lease_ok_spec (release_cancel_spec h).1).1

end Research
