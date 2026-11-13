import Std

namespace Research.CitationReference

/-- Canonical generated short reference, ASCII `ev` followed by a positive integer. -/
def shortReference (reference : String) : Bool :=
  match reference.toList with
  | 'e' :: 'v' :: first :: rest =>
      ('1' ≤ first && first ≤ '9') && rest.all (fun c => '0' ≤ c && c ≤ '9')
  | _ => false

/-- Only evidence actually shown in this run can supply a canonical reference. -/
def resolve (runId reference : String) (shown : List String) : String :=
  if reference ∈ shown then reference
  else if shortReference reference = true ∧ runId ++ "_" ++ reference ∈ shown
       then runId ++ "_" ++ reference
       else reference

/-- Resolution never invents an identifier: any changed id belongs to the shown pack. -/
theorem original_or_shown (runId reference : String) (shown : List String) :
    resolve runId reference shown = reference ∨ resolve runId reference shown ∈ shown := by
  unfold resolve
  split
  · exact Or.inl rfl
  · split
    · rename_i h
      exact Or.inr h.2
    · exact Or.inl rfl

/-- A real shown identifier always takes precedence over a possible alias. -/
theorem shown_stable (runId reference : String) (shown : List String) (h : reference ∈ shown) :
    resolve runId reference shown = reference := by
  simp [resolve, h]

/-- An omitted/unretrieved candidate cannot be made citeable by its suffix. -/
theorem unshown_unchanged (runId reference : String) (shown : List String)
    (h : reference ∉ shown) (hc : runId ++ "_" ++ reference ∉ shown) :
    resolve runId reference shown = reference := by
  simp [resolve, h, hc]

end Research.CitationReference
