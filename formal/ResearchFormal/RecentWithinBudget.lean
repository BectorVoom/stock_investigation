/-!
# Bounded conversation context

Formal model of `recentCountWithinBudget` in
`packages/domain/src/text/recentWithinBudget.ts`.

The list holds per-message byte sizes, newest first (the TypeScript array is
oldest first, so the conformance test reverses it). The count is the length of
the longest prefix whose total is at most `budget` and whose length is at most
`maxItems`: walk from the newest item and stop at the first item that does not
fit, never skipping an item to squeeze in an older one.
-/

namespace Research

/-- How many of the most recent items fit within `budget` and `maxItems`. -/
def recentCountWithinBudget : List Nat → Nat → Nat → Nat
  | [], _, _ => 0
  | _ :: _, _, 0 => 0
  | s :: rest, budget, maxItems + 1 =>
    if s ≤ budget then 1 + recentCountWithinBudget rest (budget - s) maxItems else 0

/-- The count never exceeds `maxItems`. -/
theorem recentCount_le_maxItems (xs : List Nat) (budget maxItems : Nat) :
    recentCountWithinBudget xs budget maxItems ≤ maxItems := by
  induction xs generalizing budget maxItems with
  | nil =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ _ => simp [recentCountWithinBudget]
  | cons s rest ih =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ m =>
      simp only [recentCountWithinBudget]
      by_cases h : s ≤ budget
      · simp only [h, ↓reduceIte]
        have := ih (budget - s) m
        omega
      · simp only [h, ↓reduceIte]
        omega

/-- The count never exceeds the number of items. -/
theorem recentCount_le_length (xs : List Nat) (budget maxItems : Nat) :
    recentCountWithinBudget xs budget maxItems ≤ xs.length := by
  induction xs generalizing budget maxItems with
  | nil =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ _ => simp [recentCountWithinBudget]
  | cons s rest ih =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ m =>
      simp only [recentCountWithinBudget]
      by_cases h : s ≤ budget
      · simp only [h, ↓reduceIte]
        have := ih (budget - s) m
        simp only [List.length_cons] at *
        omega
      · simp only [h, ↓reduceIte]
        simp only [List.length_cons]
        omega

/-- The total size of the kept items never exceeds `budget`. -/
theorem recentCount_kept_sum_le (xs : List Nat) (budget maxItems : Nat) :
    ((xs.take (recentCountWithinBudget xs budget maxItems)).sum ≤ budget) := by
  induction xs generalizing budget maxItems with
  | nil =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ _ => simp [recentCountWithinBudget]
  | cons s rest ih =>
    cases maxItems with
    | zero => simp [recentCountWithinBudget]
    | succ m =>
      simp only [recentCountWithinBudget]
      by_cases h : s ≤ budget
      · simp only [h, ↓reduceIte]
        have hs := ih (budget - s) m
        have hcomm : 1 + recentCountWithinBudget rest (budget - s) m
            = recentCountWithinBudget rest (budget - s) m + 1 := Nat.add_comm _ _
        have htake : ((s :: rest).take (1 + recentCountWithinBudget rest (budget - s) m)).sum
            = s + ((rest.take (recentCountWithinBudget rest (budget - s) m)).sum) := by
          rw [hcomm, List.take_succ_cons, List.sum_cons]
        omega
      · simp only [h, ↓reduceIte]
        simp

/--
Maximality: when the count is smaller than both `maxItems` and the number of
items, adding the next older item would exceed `budget`.
-/
theorem recentCount_maximal (xs : List Nat) (budget maxItems : Nat)
    (hlt : recentCountWithinBudget xs budget maxItems < maxItems)
    (hlen : recentCountWithinBudget xs budget maxItems < xs.length) :
    budget < ((xs.take (recentCountWithinBudget xs budget maxItems + 1)).sum) := by
  induction xs generalizing budget maxItems with
  | nil =>
    simp [recentCountWithinBudget] at hlen
  | cons s rest ih =>
    cases maxItems with
    | zero =>
      simp [recentCountWithinBudget] at hlt
    | succ m =>
      simp only [recentCountWithinBudget] at hlt hlen ⊢
      by_cases h : s ≤ budget
      · simp only [h, ↓reduceIte] at hlt hlen ⊢
        simp only [List.length_cons] at hlen
        have h1 : recentCountWithinBudget rest (budget - s) m < m := by omega
        have h2 : recentCountWithinBudget rest (budget - s) m < rest.length := by omega
        have ihm := ih (budget - s) m h1 h2
        have hcomm : 1 + recentCountWithinBudget rest (budget - s) m
            = recentCountWithinBudget rest (budget - s) m + 1 := Nat.add_comm _ _
        have htake : ((s :: rest).take (1 + recentCountWithinBudget rest (budget - s) m + 1)).sum
            = s + ((rest.take (recentCountWithinBudget rest (budget - s) m + 1)).sum) := by
          rw [List.take_succ_cons, List.sum_cons, hcomm]
        omega
      · simp only [h, ↓reduceIte] at hlt hlen ⊢
        simp only [Nat.zero_add, List.take_succ_cons, List.take_zero, List.sum_cons,
          List.sum_nil] at ⊢
        omega

end Research
