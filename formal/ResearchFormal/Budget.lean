import ResearchFormal.Basic

/-!
# Run budgets

Formal model of `checkBudget` / `addUsage` in
`packages/domain/src/jobs/budget.ts` (FR-016, AGT-008).

Quantities are natural numbers; spend is in an integral unit (e.g. micro-USD).
The TypeScript implementation additionally treats non-finite inputs as over
budget — a floating-point concern with no counterpart in this model.
-/

namespace Research

structure Budget where
  maxSteps : Nat
  maxTools : Nat
  maxWallClock : Nat
  maxBytes : Nat
  maxSpend : Option Nat
  deriving Repr

structure Usage where
  steps : Nat
  tools : Nat
  bytes : Nat
  cost : Nat
  deriving Repr, DecidableEq

/-- What a planned step would consume. -/
structure Delta where
  steps : Nat
  tools : Nat
  bytes : Nat
  cost : Nat
  deriving Repr

def Usage.zero : Usage := ⟨0, 0, 0, 0⟩

def Usage.add (u : Usage) (d : Delta) : Usage :=
  ⟨u.steps + d.steps, u.tools + d.tools, u.bytes + d.bytes, u.cost + d.cost⟩

/-- The limits, in the order `checkBudget` tests them. -/
inductive Limit where
  | maxAgentSteps | maxToolCalls | maxWallClock | maxInputBytes | maxSpend
  deriving DecidableEq, Repr

/-- `none` means the planned step is within budget. -/
def checkBudget (b : Budget) (u : Usage) (elapsed : Nat) (d : Delta) : Option Limit :=
  if b.maxSteps < u.steps + d.steps then some .maxAgentSteps
  else if b.maxTools < u.tools + d.tools then some .maxToolCalls
  else if b.maxWallClock ≤ elapsed then some .maxWallClock
  else if b.maxBytes < u.bytes + d.bytes then some .maxInputBytes
  else if (b.maxSpend.isSome && b.maxSpend.getD 0 < u.cost + d.cost) then some .maxSpend
  else none

/-- Usage that respects every ceiling. -/
def Usage.within (u : Usage) (b : Budget) : Prop :=
  u.steps ≤ b.maxSteps ∧ u.tools ≤ b.maxTools ∧ u.bytes ≤ b.maxBytes ∧ (b.maxSpend.isSome = true → u.cost ≤ b.maxSpend.getD 0)

/-- **Soundness.** If the check passes, performing the step stays within every ceiling. -/
theorem check_sound {b : Budget} {u : Usage} {elapsed : Nat} {d : Delta}
    (h : checkBudget b u elapsed d = none) : (u.add d).within b ∧ elapsed < b.maxWallClock := by
  unfold checkBudget at h
  by_cases h1 : b.maxSteps < u.steps + d.steps
  · rw [ifPos h1] at h; cases h
  · rw [ifNeg h1] at h
    by_cases h2 : b.maxTools < u.tools + d.tools
    · rw [ifPos h2] at h; cases h
    · rw [ifNeg h2] at h
      by_cases h3 : b.maxWallClock ≤ elapsed
      · rw [ifPos h3] at h; cases h
      · rw [ifNeg h3] at h
        by_cases h4 : b.maxBytes < u.bytes + d.bytes
        · rw [ifPos h4] at h; cases h
        · rw [ifNeg h4] at h
          cases hs : b.maxSpend with
          | none =>
            simp [hs] at h
            exact ⟨⟨by simp [Usage.add]; omega, by simp [Usage.add]; omega,
              by simp [Usage.add]; omega, by simp [hs]⟩, by omega⟩
          | some cap =>
            simp [hs] at h
            refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_⟩
            all_goals simp_all [Usage.add]

/-- **Completeness.** A step that fits is never refused. -/
theorem check_complete {b : Budget} {u : Usage} {elapsed : Nat} {d : Delta}
    (hfit : (u.add d).within b) (htime : elapsed < b.maxWallClock) :
    checkBudget b u elapsed d = none := by
  obtain ⟨h1, h2, h3, h4⟩ := hfit
  simp only [Usage.add] at h1 h2 h3 h4
  unfold checkBudget
  rw [ifNeg (by omega), ifNeg (by omega), ifNeg (by omega), ifNeg (by omega)]
  cases hs : b.maxSpend with
  | none => simp
  | some cap => simp_all

/-- Usage never decreases. -/
theorem usage_monotone (u : Usage) (d : Delta) :
    u.steps ≤ (u.add d).steps ∧ u.tools ≤ (u.add d).tools ∧
    u.bytes ≤ (u.add d).bytes ∧ u.cost ≤ (u.add d).cost := by
  simp only [Usage.add]
  omega

/--
A run that performs each planned step only after the check passes, and stops at
the first refusal. Each step carries the elapsed time observed before it.
-/
def runGuarded (b : Budget) : Usage → List (Nat × Delta) → Usage
  | u, [] => u
  | u, (elapsed, d) :: rest =>
    match checkBudget b u elapsed d with
    | none => runGuarded b (u.add d) rest
    | some _ => u

/--
**Budget safety.** However many steps a model asks for and whatever they would
cost, a guarded run never exceeds any ceiling.
-/
theorem guarded_run_within_budget (b : Budget) (steps : List (Nat × Delta)) :
    ∀ u : Usage, u.within b → (runGuarded b u steps).within b := by
  induction steps with
  | nil => intro u hu; exact hu
  | cons step rest ih =>
    intro u hu
    obtain ⟨elapsed, d⟩ := step
    unfold runGuarded
    cases hc : checkBudget b u elapsed d with
    | none => exact ih (u.add d) (check_sound hc).1
    | some _ => exact hu

/-- In particular, a run started from nothing stays within budget. -/
theorem guarded_run_from_zero (b : Budget) (steps : List (Nat × Delta)) :
    (runGuarded b Usage.zero steps).within b :=
  guarded_run_within_budget b steps Usage.zero
    ⟨Nat.zero_le _, Nat.zero_le _, Nat.zero_le _, fun _ => Nat.zero_le _⟩

/-- An absent spending cap cannot reject a step for its cost. -/
theorem no_cap_allows_cost (b : Budget) (u : Usage) (elapsed : Nat) (d : Delta)
    (hcap : b.maxSpend = none)
    (hs : u.steps + d.steps ≤ b.maxSteps) (ht : u.tools + d.tools ≤ b.maxTools)
    (hb : u.bytes + d.bytes ≤ b.maxBytes) (he : elapsed < b.maxWallClock) :
    checkBudget b u elapsed d = none := by
  apply check_complete
  · exact ⟨hs, ht, hb, by simp [hcap]⟩
  · exact he

end Research
