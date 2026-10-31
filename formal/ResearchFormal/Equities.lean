/-!
Equities visibility and exact decimal ordering. Timestamp parsing and decimal
lexical validation are boundary contracts outside this model. Integer epochs
may precede 1970. A decimal is a signed coefficient divided by 10^scale.
-/
namespace Research

def equityVisible (available : Option Int) (committed : Int)
    (informationCutoff ingestionCutoff : Option Int) : Bool :=
  (match informationCutoff with
   | none => true
   | some cutoff => match available with
     | none => false
     | some published => published ≤ cutoff) &&
  (match ingestionCutoff with
   | none => true
   | some cutoff => committed ≤ cutoff)

theorem equityVisible_no_future (a c p s : Int)
    (h : equityVisible (some a) c (some p) (some s) = true) : a ≤ p ∧ c ≤ s := by
  simpa [equityVisible] using h

theorem equityVisible_unknown_excluded (c p : Int) (s : Option Int) :
    equityVisible none c (some p) s = false := by simp [equityVisible]

theorem equityVisible_without_cutoffs (a : Option Int) (c : Int) :
    equityVisible a c none none = true := by simp [equityVisible]

def equityDecimalLE (a : Int) (sa : Nat) (b : Int) (sb : Nat) : Prop :=
  a * (10 : Int)^sb ≤ b * (10 : Int)^sa

def equityVersionVisible (version cutoff : Nat) : Bool := decide (version ≤ cutoff)

theorem equityVersionVisible_no_future (version cutoff : Nat)
    (h : equityVersionVisible version cutoff = true) : version ≤ cutoff := by
  simpa [equityVersionVisible] using h

theorem equityVersionVisible_newer_excluded (version cutoff : Nat) (h : cutoff < version) :
    equityVersionVisible version cutoff = false := by
  simp [equityVersionVisible]
  omega

theorem equityDecimalLE_refl (a : Int) (s : Nat) : equityDecimalLE a s a s := by
  simp [equityDecimalLE]

theorem equityDecimalLE_total (a b : Int) (sa sb : Nat) :
    equityDecimalLE a sa b sb ∨ equityDecimalLE b sb a sa := by
  unfold equityDecimalLE
  omega

theorem equityDecimalLE_antisymmetric (a b : Int) (sa sb : Nat)
    (h₁ : equityDecimalLE a sa b sb) (h₂ : equityDecimalLE b sb a sa) :
    a * (10 : Int)^sb = b * (10 : Int)^sa := by
  unfold equityDecimalLE at *
  omega

def equityDecimalCompare (a : Int) (sa : Nat) (b : Int) (sb : Nat) : Int :=
  if a * (10 : Int)^sb < b * (10 : Int)^sa then -1
  else if a * (10 : Int)^sb > b * (10 : Int)^sa then 1 else 0

theorem equityDecimalCompare_zero_iff (a b : Int) (sa sb : Nat) :
    equityDecimalCompare a sa b sb = 0 ↔ a * (10 : Int)^sb = b * (10 : Int)^sa := by
  unfold equityDecimalCompare
  split <;> rename_i h
  · omega
  · split <;> omega

end Research
