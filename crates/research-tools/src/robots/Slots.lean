import Std

/- ADR-0030 C2. The millisecond reservation used by search::reserve_slot
   and web::polite_wait. Rust uses saturating i64 arithmetic at its machine
   boundary; these properties apply when last + interval fits i64, as all
   valid Date milliseconds do. No scheduler or network timing is assumed.
   Check: ~/.elan/bin/lean +leanprover/lean4:v4.34.1 <this file>. -/
namespace ResearchTools

def reserveSlot (now last interval : Int) : Int := max now (last + interval)

theorem neverBeforeNow (now last interval : Int) :
    now ≤ reserveSlot now last interval := by
  exact Int.le_max_left _ _

theorem respectsSpacing (now last interval : Int) :
    last + interval ≤ reserveSlot now last interval := by
  exact Int.le_max_right _ _

theorem earliestPermitted (now last interval candidate : Int)
    (hnow : now ≤ candidate) (hspacing : last + interval ≤ candidate) :
    reserveSlot now last interval ≤ candidate := by
  exact Int.max_le.mpr ⟨hnow, hspacing⟩

theorem consecutiveReservations (now₁ now₂ last interval : Int) :
    reserveSlot now₁ last interval + interval ≤
      reserveSlot now₂ (reserveSlot now₁ last interval) interval := by
  exact respectsSpacing _ _ _

/- Robots selection: a matching rule can replace the current winner exactly
   when it is longer, or is an Allow of equal length. The resulting rule
   never loses specificity, and Allow wins every equal-specificity tie. -/
def replaceRule (length oldLength : Nat) (allow : Bool) : Bool :=
  decide (length > oldLength ∨ (length = oldLength ∧ allow = true))

theorem selectedRuleNeverShorter (length oldLength : Nat) (allow : Bool)
    (h : replaceRule length oldLength allow = true) : oldLength ≤ length := by
  simp [replaceRule] at h
  omega

theorem allowWinsTie (length : Nat) : replaceRule length length true = true := by
  simp [replaceRule]

end ResearchTools
