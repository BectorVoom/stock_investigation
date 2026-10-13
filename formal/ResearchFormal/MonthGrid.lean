import ResearchFormal.Basic

/-!
# Earnings month grid

Formal model of `buildMonthGrid` in `packages/domain/src/calendar/monthGrid.ts`
(FR-019 section 1).

The TypeScript computes civil dates with integer arithmetic (Howard Hinnant's
`days_from_civil` / `civil_from_days`, no `Date` objects); the weekday of
1970-01-01 (a Thursday) anchors the week. This model captures the combinatorial
core over `Nat` day offsets:

* `gridLeading` — how many days before the 1st are shown in the first week;
* `gridCells` — the total cell count (smallest multiple of 7 covering the
  visible days);
* `gridDayNums` — the in-month day numbers in cell order.

Proved below: (a) the cell count is a multiple of 7, (b) the first cell's
weekday is `weekStart`, (c) the in-month cells are exactly days 1..n in order.
The absolute civil-date correspondence (Hinnant arithmetic, leap years, the
1970 Thursday anchor) is an independent reimplementation in Lean used for the
exported vectors, tied to the TypeScript by the conformance test and by
hand-worked unit tests — it is tested on samples, not proved.
-/

namespace Research

/-- Days before the 1st shown in the first week (TypeScript:
    `(firstWeekday - weekStart + 7) % 7`). -/
def gridLeading (firstWeekday weekStart : Nat) : Nat :=
  (firstWeekday + 7 - weekStart) % 7

/-- Total cells: smallest multiple of 7 covering `leading + days`. -/
def gridCells (leading days : Nat) : Nat :=
  ((leading + days + 6) / 7) * 7

/-- **(a) The cell count is a multiple of 7.** -/
theorem gridCells_multiple (leading days : Nat) :
    (gridCells leading days) % 7 = 0 := by
  unfold gridCells
  omega

/-- Rows of whole weeks (4–6 for real months: `leading < 7`, `28 ≤ days ≤ 31`). -/
theorem gridRows_bound (leading days : Nat) (hl : leading < 7)
    (hd : 28 ≤ days ∧ days ≤ 31) :
    4 ≤ gridCells leading days / 7 ∧ gridCells leading days / 7 ≤ 6 := by
  unfold gridCells
  omega

/-- **(b) The first cell's weekday is `weekStart`.** -/
theorem grid_first_weekday (firstWeekday weekStart : Nat)
    (hf : firstWeekday < 7) (hw : weekStart < 7) :
    (firstWeekday + 7 - gridLeading firstWeekday weekStart) % 7 = weekStart := by
  unfold gridLeading
  omega

/-- In-month day numbers (1-based) in cell order. -/
def gridDayNums (leading days total : Nat) : List Nat :=
  ((List.range total).filter fun idx =>
    decide (leading ≤ idx ∧ idx < leading + days)).map
    fun idx => idx - leading + 1

/-- Singleton filter facts (no core-version dependence). -/
theorem filter_singleton_false (p : Nat → Bool) (n : Nat)
    (h : ¬ p n = true) : [n].filter p = [] := by
  rw [List.filter_cons, ifNeg h, List.filter_nil]

theorem filter_singleton_true (p : Nat → Bool) (n : Nat)
    (h : p n = true) : [n].filter p = [n] := by
  rw [List.filter_cons, ifPos h, List.filter_nil]

/-- Below the month (`idx < leading`) nothing is kept. -/
theorem filter_range_lt_self (n leading : Nat) :
    ((List.range n).filter fun idx =>
      decide (leading ≤ idx ∧ idx < leading)) = [] := by
  induction n with
  | zero => simp
  | succ m ihm =>
    have h1 : (([m].filter fun idx =>
      decide (leading ≤ idx ∧ idx < leading))) = [] := by
      apply filter_singleton_false
      simp only [decide_eq_true_eq]
      omega
    simp only [List.range_succ, List.filter_append, ihm, h1, List.nil_append]

/-- Congruence of `map` over a range. -/
theorem map_congr_range (f g : Nat → Nat) (n : Nat)
    (h : ∀ k ∈ List.range n, f k = g k) :
    (List.range n).map f = (List.range n).map g := by
  induction n with
  | zero => rfl
  | succ m ihm =>
    have h1 : ∀ k ∈ List.range m, f k = g k := by
      intro k hk
      exact h k (by simp [List.range_succ, hk])
    have hlast : f m = g m := h m (by simp [List.range_succ])
    simp only [List.range_succ, List.map_append]
    rw [ihm h1]
    show _ ++ [f m] = _ ++ [g m]
    rw [hlast]

/-- The kept indices are exactly `leading .. leading + days - 1`. -/
theorem filter_range_aux : ∀ (n leading days : Nat), leading + days ≤ n →
    ((List.range n).filter fun idx => decide (leading ≤ idx ∧ idx < leading + days))
      = List.range' leading days := by
  intro n
  induction n with
  | zero =>
    intro leading days h
    have h0 : days = 0 := by omega
    have h1 : leading = 0 := by omega
    subst h0
    subst h1
    simp
  | succ n ih =>
    intro leading days h
    rw [List.range_succ, List.filter_append]
    by_cases hn : leading + days ≤ n
    · rw [ih leading days hn]
      have hnil : (([n].filter fun idx =>
        decide (leading ≤ idx ∧ idx < leading + days))) = [] := by
        apply filter_singleton_false
        simp only [decide_eq_true_eq]
        omega
      rw [hnil, List.append_nil]
    · by_cases hd : days = 0
      · subst hd
        simp only [Nat.add_zero]
        rw [filter_range_lt_self]
        have hnil2 : (([n].filter fun idx =>
          decide (leading ≤ idx ∧ idx < leading)) = []) := by
          apply filter_singleton_false
          simp only [decide_eq_true_eq]
          omega
        rw [hnil2, List.nil_append]
        rfl
      · obtain ⟨days', rfl⟩ := Nat.exists_eq_succ_of_ne_zero hd
        have heq : n = leading + days' := by omega
        subst heq
        have hkeep : (([leading + days'].filter fun idx =>
          decide (leading ≤ idx ∧ idx < leading + (days' + 1)))) = [leading + days'] := by
          apply filter_singleton_true
          simp only [decide_eq_true_eq]
          omega
        have htight : ∀ idx ∈ List.range (leading + days'),
            decide (leading ≤ idx ∧ idx < leading + (days' + 1))
              = decide (leading ≤ idx ∧ idx < leading + days') := by
          intro idx hmem
          have hlt : idx < leading + days' := List.mem_range.mp hmem
          have e1 : (leading ≤ idx ∧ idx < leading + (days' + 1)) ↔
              (leading ≤ idx ∧ idx < leading + days') := by omega
          simp [e1]
        have hsub : ((List.range (leading + days')).filter fun idx =>
            decide (leading ≤ idx ∧ idx < leading + (days' + 1)))
            = List.range' leading days' := by
          rw [List.filter_congr htight]
          exact ih leading days' (by omega)
        rw [hsub, hkeep, Nat.succ_eq_add_one, List.range'_concat]
        simp only [Nat.one_mul]

/-- Mapping the kept indices to 1-based day numbers gives `1 .. days`. -/
theorem map_range'_sub (leading days : Nat) :
    ((List.range' leading days).map fun idx => idx - leading + 1)
      = List.range' 1 days := by
  rw [List.range'_eq_map_range, List.map_map, List.range'_eq_map_range]
  apply map_congr_range
  intro k _
  show leading + k - leading + 1 = 1 + k
  omega

/-- **(c) The in-month cells are exactly days 1..n in order.** -/
theorem grid_days_exact (leading days : Nat) :
    gridDayNums leading days (gridCells leading days)
      = List.range' 1 days := by
  unfold gridDayNums
  have hle : leading + days ≤ gridCells leading days := by
    unfold gridCells
    omega
  rw [filter_range_aux _ _ _ hle, map_range'_sub]

/-! ## Civil dates (vector oracle only) -/

/-- Proleptic-Gregorian leap year. -/
def gridLeapYear (year : Nat) : Bool :=
  decide (year % 4 = 0 ∧ (year % 100 ≠ 0 ∨ year % 400 = 0))

/-- Days in a civil month. -/
def gridDaysInMonth (year month : Nat) : Nat :=
  match month with
  | 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31
  | 4 | 6 | 9 | 11 => 30
  | _ => if gridLeapYear year then 29 else 28

/-- Days since 1970-01-01 (Hinnant `days_from_civil`, mirrored for vectors). -/
def gridDaysFromCivil (year month day : Nat) : Int :=
  let adjYear : Int := if month ≤ 2 then (year : Int) - 1 else year
  let era : Int := adjYear / 400 - (if adjYear < 0 ∧ adjYear % 400 ≠ 0 then 1 else 0)
  let yoe : Int := adjYear - era * 400
  let mp : Int := if month > 2 then (month : Int) - 3 else month + 9
  let doy : Int := (153 * mp + 2) / 5 + day - 1
  let doe : Int := yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468

/-- Inverse: civil date of an absolute day count. -/
def gridCivilFromDays (days : Int) : Int × Int × Int :=
  let z : Int := days + 719468
  let era : Int := z / 146097 - (if z < 0 ∧ z % 146097 ≠ 0 then 1 else 0)
  let doe : Int := z - era * 146097
  let yoe : Int := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let y : Int := yoe + era * 400
  let doy : Int := doe - (365 * yoe + yoe / 4 - yoe / 100)
  let mp : Int := (5 * doy + 2) / 153
  let d : Int := doy - (153 * mp + 2) / 5 + 1
  let m : Int := if mp < 10 then mp + 3 else mp - 9
  (if m ≤ 2 then y + 1 else y, m, d)

/-- Weekday of a civil date (0 = Sunday); 1970-01-01 was a Thursday. -/
def gridWeekday (year month day : Nat) : Nat :=
  ((gridDaysFromCivil year month day + 4) % 7).toNat

end Research
