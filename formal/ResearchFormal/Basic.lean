/-!
# Shared helpers

Two rewriting lemmas for `if`, named locally so the proofs do not depend on
which spelling of them the installed core library currently prefers.
-/

namespace Research

theorem ifPos {α : Sort _} {c : Prop} [Decidable c] (hc : c) {a b : α} :
    (if c then a else b) = a := by
  simp [hc]

theorem ifNeg {α : Sort _} {c : Prop} [Decidable c] (hc : ¬c) {a b : α} :
    (if c then a else b) = b := by
  simp [hc]

end Research
