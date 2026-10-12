/-!
# Small classifiers

* `classifyPositionChange` models `classifyReportedPositionChange` in
  `packages/domain/src/finance/filings.ts` (FR-008, DATA-007). A share count
  of `0` stands for "not reported" (absent, non-positive or non-finite).
* `claimStatus` / `downgrade` model the status logic of `verifyClaim` in
  `packages/domain/src/evidence/verifyClaims.ts` and the independent-verifier
  rule in the research pipeline (AGT-013).
-/

namespace Research

inductive PositionChange where
  | newlyReported | increase | decrease | noLongerReported | unchanged | notReported
  deriving DecidableEq, Repr

def classifyPositionChange (previous current : Nat) : PositionChange :=
  if previous = 0 ∧ current = 0 then .notReported
  else if previous = 0 then .newlyReported
  else if current = 0 then .noLongerReported
  else if previous < current then .increase
  else if current < previous then .decrease
  else .unchanged

/-- The classification is exactly determined by the two reported quantities. -/
theorem classify_spec (p c : Nat) :
    (classifyPositionChange p c = .notReported ↔ p = 0 ∧ c = 0) ∧
    (classifyPositionChange p c = .newlyReported ↔ p = 0 ∧ 0 < c) ∧
    (classifyPositionChange p c = .noLongerReported ↔ 0 < p ∧ c = 0) ∧
    (classifyPositionChange p c = .increase ↔ 0 < p ∧ p < c) ∧
    (classifyPositionChange p c = .decrease ↔ 0 < c ∧ c < p) ∧
    (classifyPositionChange p c = .unchanged ↔ 0 < p ∧ p = c) := by
  unfold classifyPositionChange
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> (repeat' split) <;> simp_all <;> omega

/-- A holding is "newly reported" only if nothing was reported before. -/
theorem newly_reported_had_no_prior (p c : Nat)
    (h : classifyPositionChange p c = .newlyReported) : p = 0 :=
  ((classify_spec p c).2.1.mp h).1

/-- An "increase" always compares two positive reported positions. -/
theorem increase_is_between_reported_positions (p c : Nat)
    (h : classifyPositionChange p c = .increase) : 0 < p ∧ p < c :=
  (classify_spec p c).2.2.2.1.mp h

inductive ClaimStatus where
  | supported | unsupported | conflicting
  deriving DecidableEq, Repr

/--
Status from the number of verified supporting links, verified contradicting
links, and numbers in the claim that no supporting evidence contains.
-/
def claimStatus (supports contradicts unsupportedNumbers : Nat) : ClaimStatus :=
  if supports = 0 ∨ 0 < unsupportedNumbers then .unsupported
  else if 0 < contradicts then .conflicting
  else .supported

/-- **No unsupported "supported".** A supported claim has verified support and no stray numbers. -/
theorem supported_has_evidence (s c n : Nat) (h : claimStatus s c n = .supported) :
    0 < s ∧ c = 0 ∧ n = 0 := by
  unfold claimStatus at h
  (repeat' split at h) <;> simp_all <;> omega

/-- Contradicting evidence is never hidden: with support and a contradiction the claim conflicts. -/
theorem contradiction_is_surfaced (s c : Nat) (hs : 0 < s) (hc : 0 < c) :
    claimStatus s c 0 = .conflicting := by
  unfold claimStatus
  (repeat' split) <;> simp_all <;> omega

/-- Without any verified supporting link a claim is unsupported, whatever else is cited. -/
theorem no_support_is_unsupported (c n : Nat) : claimStatus 0 c n = .unsupported := by
  simp [claimStatus]

/-- Verdict of the independent verifier on one claim. -/
inductive Verdict where
  | supported | unsupported | contradicted | silent
  deriving DecidableEq, Repr

/-- The verifier may only downgrade: anything but an explicit "supported" withdraws support. -/
def downgrade (status : ClaimStatus) (v : Verdict) : ClaimStatus :=
  if status = .supported ∧ v ≠ .supported then .unsupported else status

/-- **Verification never upgrades.** A claim is supported afterwards only if it was before. -/
theorem downgrade_never_upgrades (status : ClaimStatus) (v : Verdict)
    (h : downgrade status v = .supported) : status = .supported ∧ v = .supported := by
  unfold downgrade at h
  split at h
  · cases h
  · rename_i hn
    refine ⟨h, ?_⟩
    cases v <;> simp_all

/-- A claim the verifier rejects, or says nothing about, does not stay supported. -/
theorem unconfirmed_is_not_supported (status : ClaimStatus) (v : Verdict) (hv : v ≠ .supported) :
    downgrade status v ≠ .supported := by
  intro h
  exact hv (downgrade_never_upgrades status v h).2

end Research
