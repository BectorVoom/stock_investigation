import Std

namespace StockValuation

/-- Exact model for the positive, same-currency price/EPS quotient.
    The UI uses finite floating-point inputs and rounds only for display. -/
def per (price eps : Int) (sameCurrency : Bool) : Option Rat :=
  if sameCurrency && (price > 0) && (eps > 0) then
    some ((price : Rat) / (eps : Rat))
  else none

theorem per_available_iff (price eps : Int) (sameCurrency : Bool) :
    (per price eps sameCurrency).isSome = true ↔ sameCurrency = true ∧ price > 0 ∧ eps > 0 := by
  simp [per, Bool.and_eq_true, and_assoc]

theorem per_uses_annual_eps (price eps : Int) (hp : price > 0) (he : eps > 0) :
    per price eps true = some ((price : Rat) / (eps : Rat)) := by
  simp [per, hp, he]

end StockValuation
