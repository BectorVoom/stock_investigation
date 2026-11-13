import Std

namespace Research.DemandSignals
inductive Kind where
  | expanding | emerging | weakening | uncertain
  deriving DecidableEq, Repr

def classify (expanding emerging weakening uncertain : Bool) : Option Kind :=
  if !(expanding || emerging || weakening) then none
  else if uncertain then some .uncertain
  else if weakening then some .weakening
  else if emerging then some .emerging
  else some .expanding

theorem weakening_precedence (e n : Bool) :
    classify e n true false = some .weakening := by simp [classify]

theorem expanding_requires_evidence (e n w u : Bool)
    (h : classify e n w u = some .expanding) :
    e = true ∧ n = false ∧ w = false ∧ u = false := by
  cases e <;> cases n <;> cases w <;> cases u <;> simp_all [classify]

theorem forecasts_never_expanding (e n w : Bool) :
    classify e n w true ≠ some .expanding := by
  cases e <;> cases n <;> cases w <;> decide

def accepts (signal theme query : Bool) : Bool := signal && theme && query

theorem accepted_meets_all (s t q : Bool) (h : accepts s t q = true) :
    s = true ∧ t = true ∧ q = true := by
  simpa [accepts, Bool.and_eq_true, and_assoc] using h

theorem filter_sound {α : Type} (items : List α) (s t q : α → Bool)
    (item : α) (h : item ∈ items.filter (fun a => accepts (s a) (t a) (q a))) :
    item ∈ items ∧ s item = true ∧ t item = true ∧ q item = true := by
  have hm := List.mem_filter.mp h
  exact ⟨hm.1, accepted_meets_all _ _ _ hm.2⟩
/-- Browsing theme context must not require an asserted growth signal. -/
def eligible (coverage signal : Bool) : Bool := coverage || signal

theorem coverage_does_not_require_signal (s : Bool) : eligible true s = true := by
  simp [eligible]

theorem coverage_preserves_filters (s t q : Bool)
    (h : accepts (eligible true s) t q = true) : t = true ∧ q = true := by
  exact (accepted_meets_all _ _ _ h).2

end Research.DemandSignals
