import Std

namespace Research.MaterialSeries

/-- Imported material IDs reuse the FRED ASCII symbol grammar, in a distinct namespace. -/
def symbolValid (chars : List Char) : Bool :=
  !chars.isEmpty && chars.length ≤ 25 && chars.all (fun c =>
    ('A' ≤ c && c ≤ 'Z') || ('0' ≤ c && c ≤ '9'))

def parse (provider : String) (chars : List Char) : Bool :=
  provider == "materials" && symbolValid chars

theorem accepted_namespace (provider : String) (chars : List Char)
    (h : parse provider chars = true) : provider = "materials" := by
  simp only [parse, Bool.and_eq_true, beq_iff_eq] at h
  exact h.1

theorem accepted_symbol (provider : String) (chars : List Char)
    (h : parse provider chars = true) : symbolValid chars = true := by
  simp only [parse, Bool.and_eq_true] at h
  exact h.2

end Research.MaterialSeries
