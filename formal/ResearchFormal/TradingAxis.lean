/-!
# Trading-day axis

Formal model of `packages/domain/src/market/tradingAxis.ts` (ADR-0057): the
chart viewer spaces bars evenly in trading order, so a day without a bar
(a weekend, a holiday, a provider gap) takes no room.

The axis days are a list of rationals (the implementation's day numbers are
integers, and `axisDay` yields fractional days between bars, which feed back
into `axisPosition`); positions are exact rationals (core's `Rat`, no Mathlib),
where the implementation computes in floating point — the conformance test
compares the two within 1e-9 relative.

* `axisSegment` is modelled by a linear prefix scan; for a strictly ascending
  list it is the index of the last day `≤ d`, `-1` when none
  (`axisSegment_spec`). The implementation bisects; the vectors pin their
  agreement.
* `axisPosition` / `axisDay`: with two or more days, the segment is the
  axis segment (respectively the floor of the position) clamped to
  `0 … n − 2`, and the position is linear in the day across it. With one day
  the slope is one position a day; with none the position is the day itself.
  A segment whose gap is not positive (a list that is not strictly ascending)
  falls back to `d - first` like the implementation; the theorems assume a
  strictly ascending list, which the viewer's `unionBarDays` guarantees.

Proved for every strictly ascending list (`Ascending`):

* `axisPosition_barDay`: the `i`-th axis day sits at position `i`;
* `axisPosition_strictMono`: `d₁ < d₂ → axisPosition d₁ < axisPosition d₂`
  (for every length, so in particular for two or more days);
* `axisDay_axisPosition`, `axisPosition_axisDay`: the two maps are exact
  inverses (over the rationals; the floating-point round trip is within
  tolerance, checked by the property test).

Continuity follows from the bar-day lemma (adjacent segments agree on their
shared bar day, both giving its index) and is also property-tested.
-/

namespace Research.TradingAxis

/-- The axis days strictly ascend (the viewer's `unionBarDays`). -/
def Ascending (days : List Rat) : Prop := days.Pairwise (· < ·)

/-- Index of the last axis day `≤ d`, `-1` when `d` precedes them all: a
    prefix scan (the implementation bisects; equal on ascending lists). -/
def axisSegment : List Rat → Rat → Int
  | [], _ => -1
  | x :: xs, d => if x ≤ d then axisSegment xs d + 1 else -1

/-- A segment index clamped to the known gaps `0 … n − 2` (`gapAt`'s clamp;
    a negative index becomes 0). -/
def clampIdx (n : Nat) (z : Int) : Nat := min z.toNat (n - 2)

/-- The `i`-th axis day (0 past the end, never reached under the clamp). -/
def dayAt (days : List Rat) (i : Nat) : Rat := days.getD i 0

/-- A day's position on the trading-day axis. -/
def axisPosition (days : List Rat) (d : Rat) : Rat :=
  if days.length < 2 then d - days.headD 0
  else
    let k := clampIdx days.length (axisSegment days d)
    let s := dayAt days k
    let g := dayAt days (k + 1) - s
    if 0 < g then (k : Rat) + (d - s) / g else d - days.headD 0

/-- The (possibly fractional) day at a position. -/
def axisDay (days : List Rat) (p : Rat) : Rat :=
  if days.length < 2 then days.headD 0 + p
  else
    let k := clampIdx days.length p.floor
    let s := dayAt days k
    let g := dayAt days (k + 1) - s
    if 0 < g then s + (p - k) * g else days.headD 0 + p

/-! ## The segment search -/

theorem axisSegment_ge (days : List Rat) (d : Rat) : -1 ≤ axisSegment days d := by
  induction days with
  | nil => simp [axisSegment]
  | cons x xs ih =>
    unfold axisSegment
    split <;> omega

theorem axisSegment_mono (days : List Rat) {d₁ d₂ : Rat} (h : d₁ ≤ d₂) :
    axisSegment days d₁ ≤ axisSegment days d₂ := by
  induction days with
  | nil => simp [axisSegment]
  | cons x xs ih =>
    unfold axisSegment
    have := axisSegment_ge xs d₂
    by_cases h₁ : x ≤ d₁
    · have h₂ : x ≤ d₂ := Rat.le_trans h₁ h
      simp only [h₁, h₂, ↓reduceIte]
      omega
    · simp only [h₁, ↓reduceIte]
      split <;> omega

theorem axisSegment_lt (days : List Rat) (d : Rat) : axisSegment days d < days.length := by
  induction days with
  | nil => simp [axisSegment]
  | cons x xs ih =>
    unfold axisSegment
    simp only [List.length_cons]
    split <;> omega

/-- **The search is right.** On a strictly ascending list, the `j`-th day is
    `≤ d` exactly when `j` is at most the returned index: the index is that
    of the last day `≤ d`, and `-1` when there is none. -/
theorem axisSegment_spec {days : List Rat} (hasc : Ascending days) (d : Rat) :
    ∀ j, j < days.length → (dayAt days j ≤ d ↔ (j : Int) ≤ axisSegment days d) := by
  induction days with
  | nil => intro j hj; simp at hj
  | cons x xs ih =>
    intro j hj
    have hrest : Ascending xs := (List.pairwise_cons.mp hasc).2
    have hhead : ∀ y, y ∈ xs → x < y := (List.pairwise_cons.mp hasc).1
    have hge := axisSegment_ge xs d
    unfold axisSegment
    cases j with
    | zero =>
      simp only [dayAt, List.getD_cons_zero]
      by_cases hx : x ≤ d
      · simp only [hx, ↓reduceIte, true_iff]
        omega
      · simp only [hx, ↓reduceIte, false_iff]
        omega
    | succ j =>
      have hj' : j < xs.length := by simp at hj; omega
      have hat : dayAt (x :: xs) (j + 1) = dayAt xs j := by simp [dayAt]
      rw [hat, ih hrest j hj']
      by_cases hx : x ≤ d
      · simp only [hx, ↓reduceIte]
        omega
      · simp only [hx, ↓reduceIte]
        have hmem : dayAt xs j ∈ xs := by
          simp only [dayAt, List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hj',
            Option.getD_some]
          exact List.getElem_mem hj'
        have hlt := hhead _ hmem
        have hnot : ¬ dayAt xs j ≤ d := fun hle =>
          hx (Rat.le_trans (Rat.le_of_lt hlt) hle)
        rw [← ih hrest j hj']
        simp only [hnot, false_iff]
        omega

/-- Strictly ascending days at strictly ascending indices. -/
theorem dayAt_lt {days : List Rat} (hasc : Ascending days) {i j : Nat} (hij : i < j)
    (hj : j < days.length) : dayAt days i < dayAt days j := by
  have hi : i < days.length := by omega
  simp only [dayAt, List.getD_eq_getElem?_getD, List.getElem?_eq_getElem hi,
    List.getElem?_eq_getElem hj, Option.getD_some]
  exact List.pairwise_iff_getElem.mp hasc i j hi hj hij

/-! ## The clamp -/

/-- A clamped index is characterised by its neighbours: given any predicate
    that holds of `j` exactly when `j ≤ z` (the segment search, or the floor
    of a position), the clamp of `z` is `k` exactly when `k` is the first gap
    or `P k` holds, and `k` is the last gap or `P (k + 1)` fails. -/
theorem clampIdx_iff {n : Nat} (z : Int) (P : Nat → Prop)
    (hP : ∀ j, j < n → (P j ↔ (j : Int) ≤ z)) {k : Nat} (hk : k + 2 ≤ n) :
    clampIdx n z = k ↔ ((k = 0 ∨ P k) ∧ (k + 2 = n ∨ ¬ P (k + 1))) := by
  rw [hP k (by omega), hP (k + 1) (by omega)]
  unfold clampIdx
  omega

theorem clampIdx_le (n : Nat) (z : Int) : clampIdx n z + 2 ≤ n ∨ n < 2 := by
  unfold clampIdx
  omega

/-- The floor of a position, as the clamp's predicate. -/
theorem floor_spec (p : Rat) (n : Nat) :
    ∀ j, j < n → (((j : Nat) : Rat) ≤ p ↔ (j : Int) ≤ p.floor) := by
  intro j _
  rw [Rat.le_floor_iff, Rat.intCast_natCast]

/-! ## Rational arithmetic on one segment -/

theorem frac_nonneg {d s g : Rat} (hg : 0 < g) (h : s ≤ d) : 0 ≤ (d - s) / g := by
  rw [Rat.div_def]
  apply Rat.mul_nonneg
  · rw [← Rat.le_iff_sub_nonneg] -- 0 ≤ d - s
    exact h
  · exact Rat.le_of_lt (Rat.inv_pos.mpr hg)

theorem frac_lt_one {d s g : Rat} (hg : 0 < g) (h : d < s + g) : (d - s) / g < 1 := by
  rw [Rat.div_lt_iff hg]
  grind

theorem frac_mono {d₁ d₂ s g : Rat} (hg : 0 < g) (h : d₁ < d₂) :
    (d₁ - s) / g < (d₂ - s) / g := by
  rw [Rat.lt_div_iff hg, Rat.div_mul_cancel (Rat.ne_of_gt hg)]
  grind

/-! ## The maps on a strictly ascending list of two or more days -/

/-- With two or more strictly ascending days, the clamped segment's gap is
    positive, so the position is the segment's linear formula. -/
theorem axisPosition_eq {days : List Rat} (hasc : Ascending days) (hn : 2 ≤ days.length)
    (d : Rat) {k : Nat} (hkdef : clampIdx days.length (axisSegment days d) = k) :
    axisPosition days d =
      (k : Rat) + (d - dayAt days k) / (dayAt days (k + 1) - dayAt days k) := by
  have hk : k + 2 ≤ days.length := by
    have := clampIdx_le days.length (axisSegment days d); omega
  have hg : 0 < dayAt days (k + 1) - dayAt days k := by
    have := dayAt_lt hasc (Nat.lt_succ_self k) (by omega)
    grind
  unfold axisPosition
  simp only [show ¬ days.length < 2 by omega, ↓reduceIte, hkdef, hg]

theorem axisDay_eq {days : List Rat} (hasc : Ascending days) (hn : 2 ≤ days.length)
    (p : Rat) {k : Nat} (hkdef : clampIdx days.length p.floor = k) :
    axisDay days p =
      dayAt days k + (p - k) * (dayAt days (k + 1) - dayAt days k) := by
  have hk : k + 2 ≤ days.length := by
    have := clampIdx_le days.length p.floor; omega
  have hg : 0 < dayAt days (k + 1) - dayAt days k := by
    have := dayAt_lt hasc (Nat.lt_succ_self k) (by omega)
    grind
  unfold axisDay
  simp only [show ¬ days.length < 2 by omega, ↓reduceIte, hkdef, hg]

/-- The segment of a day, by its neighbours. -/
theorem segment_clamp_iff {days : List Rat} (hasc : Ascending days) (d : Rat) {k : Nat}
    (hk : k + 2 ≤ days.length) :
    clampIdx days.length (axisSegment days d) = k ↔
      ((k = 0 ∨ dayAt days k ≤ d) ∧ (k + 2 = days.length ∨ d < dayAt days (k + 1))) := by
  rw [clampIdx_iff (axisSegment days d) (fun j => dayAt days j ≤ d) (axisSegment_spec hasc d) hk]
  simp only [Rat.not_le]

/-- The segment of a position, by its neighbours. -/
theorem floor_clamp_iff (n : Nat) (p : Rat) {k : Nat} (hk : k + 2 ≤ n) :
    clampIdx n p.floor = k ↔ ((k = 0 ∨ (k : Rat) ≤ p) ∧ (k + 2 = n ∨ p < (k : Rat) + 1)) := by
  rw [clampIdx_iff p.floor (fun j => ((j : Nat) : Rat) ≤ p) (floor_spec p n) hk]
  simp only [Rat.not_le, Rat.natCast_add, Rat.natCast_ofNat]

theorem clampIdx_mono (n : Nat) {z₁ z₂ : Int} (h : z₁ ≤ z₂) : clampIdx n z₁ ≤ clampIdx n z₂ := by
  unfold clampIdx
  omega

/-! ## The theorems -/

/-- **Bar days land on the integers.** The `i`-th axis day is at position `i`. -/
theorem axisPosition_barDay {days : List Rat} (hasc : Ascending days) {i : Nat}
    (hi : i < days.length) : axisPosition days (dayAt days i) = i := by
  by_cases hn : days.length < 2
  · match days, hi, hn with
    | [a], hi, _ =>
      have : i = 0 := by simp at hi; omega
      subst this
      simp [axisPosition, dayAt, Rat.sub_self]
  · have hn2 : 2 ≤ days.length := by omega
    by_cases hlast : i + 1 = days.length
    · -- The last day: the last gap, at its end.
      have hk : (days.length - 2) + 2 ≤ days.length := by omega
      have hkdef : clampIdx days.length (axisSegment days (dayAt days i)) = days.length - 2 := by
        rw [segment_clamp_iff hasc _ hk]
        have hlt := dayAt_lt hasc (show days.length - 2 < i by omega) hi
        exact ⟨Or.inr (Rat.le_of_lt hlt), Or.inl (by omega)⟩
      rw [axisPosition_eq hasc hn2 _ hkdef]
      have hsucc : days.length - 2 + 1 = i := by omega
      rw [hsucc]
      have hlt := dayAt_lt hasc (show days.length - 2 < i by omega) hi
      have hg : dayAt days i - dayAt days (days.length - 2) ≠ 0 := by grind
      rw [Rat.div_def, Rat.mul_inv_cancel _ hg]
      have hcast : ((days.length - 2 : Nat) : Rat) + 1 = ((i : Nat) : Rat) := by
        rw [← hsucc, Rat.natCast_add, Rat.natCast_ofNat]
      exact hcast
    · have hk : i + 2 ≤ days.length := by omega
      have hkdef : clampIdx days.length (axisSegment days (dayAt days i)) = i := by
        rw [segment_clamp_iff hasc _ hk]
        exact ⟨Or.inr (Rat.le_refl), Or.inr (dayAt_lt hasc (Nat.lt_succ_self i) (by omega))⟩
      rw [axisPosition_eq hasc hn2 _ hkdef, Rat.sub_self, Rat.div_def, Rat.zero_mul, Rat.add_zero]

/-- **Strictly increasing**, for every strictly ascending list of axis days. -/
theorem axisPosition_strictMono {days : List Rat} (hasc : Ascending days) {d₁ d₂ : Rat}
    (h : d₁ < d₂) : axisPosition days d₁ < axisPosition days d₂ := by
  by_cases hn : days.length < 2
  · simp only [axisPosition, hn, ↓reduceIte]
    grind
  · have hn2 : 2 ≤ days.length := by omega
    generalize hk₁ : clampIdx days.length (axisSegment days d₁) = k₁
    generalize hk₂ : clampIdx days.length (axisSegment days d₂) = k₂
    have hle : k₁ ≤ k₂ := by
      rw [← hk₁, ← hk₂]
      exact clampIdx_mono _ (axisSegment_mono days (Rat.le_of_lt h))
    have hb₁ : k₁ + 2 ≤ days.length := by
      have := clampIdx_le days.length (axisSegment days d₁); omega
    have hb₂ : k₂ + 2 ≤ days.length := by
      have := clampIdx_le days.length (axisSegment days d₂); omega
    rw [axisPosition_eq hasc hn2 d₁ hk₁, axisPosition_eq hasc hn2 d₂ hk₂]
    have hg₁ : 0 < dayAt days (k₁ + 1) - dayAt days k₁ := by
      have := dayAt_lt hasc (Nat.lt_succ_self k₁) (by omega); grind
    have hg₂ : 0 < dayAt days (k₂ + 1) - dayAt days k₂ := by
      have := dayAt_lt hasc (Nat.lt_succ_self k₂) (by omega); grind
    by_cases heq : k₁ = k₂
    · subst heq
      have := frac_mono (s := dayAt days k₁) hg₁ h
      grind
    · -- Different segments: d₁ is before its segment's end, d₂ after its start.
      have hlt : k₁ < k₂ := by omega
      obtain ⟨-, hend⟩ := (segment_clamp_iff hasc d₁ hb₁).mp hk₁
      obtain ⟨hstart, -⟩ := (segment_clamp_iff hasc d₂ hb₂).mp hk₂
      have hend' : d₁ < dayAt days (k₁ + 1) := by
        rcases hend with h' | h'
        · omega
        · exact h'
      have hstart' : dayAt days k₂ ≤ d₂ := by
        rcases hstart with h' | h'
        · omega
        · exact h'
      have hf₁ := frac_lt_one hg₁ (show d₁ < dayAt days k₁ + (dayAt days (k₁ + 1) - dayAt days k₁)
        by grind)
      have hf₂ := frac_nonneg hg₂ hstart'
      have hcast : ((k₁ : Nat) : Rat) + 1 ≤ ((k₂ : Nat) : Rat) := by
        have := Rat.natCast_le_natCast.mpr (show k₁ + 1 ≤ k₂ by omega)
        rwa [Rat.natCast_add, Rat.natCast_ofNat] at this
      grind

/-- **Exact inverse (day → position → day).** -/
theorem axisDay_axisPosition {days : List Rat} (hasc : Ascending days) (d : Rat) :
    axisDay days (axisPosition days d) = d := by
  by_cases hn : days.length < 2
  · simp only [axisPosition, axisDay, hn, ↓reduceIte]
    grind
  · have hn2 : 2 ≤ days.length := by omega
    generalize hk : clampIdx days.length (axisSegment days d) = k
    have hb : k + 2 ≤ days.length := by
      have := clampIdx_le days.length (axisSegment days d); omega
    have hg : 0 < dayAt days (k + 1) - dayAt days k := by
      have := dayAt_lt hasc (Nat.lt_succ_self k) (by omega); grind
    obtain ⟨hstart, hend⟩ := (segment_clamp_iff hasc d hb).mp hk
    rw [axisPosition_eq hasc hn2 d hk]
    have hfloor : clampIdx days.length
        ((k : Rat) + (d - dayAt days k) / (dayAt days (k + 1) - dayAt days k)).floor = k := by
      rw [floor_clamp_iff _ _ hb]
      constructor
      · rcases hstart with h' | h'
        · exact Or.inl h'
        · have := frac_nonneg hg h'
          exact Or.inr (by grind)
      · rcases hend with h' | h'
        · exact Or.inl h'
        · have := frac_lt_one hg (show d < dayAt days k + (dayAt days (k + 1) - dayAt days k)
            by grind)
          exact Or.inr (by grind)
    rw [axisDay_eq hasc hn2 _ hfloor]
    have hcancel := Rat.div_mul_cancel (a := d - dayAt days k) (Rat.ne_of_gt hg)
    grind

/-- **Exact inverse (position → day → position).** -/
theorem axisPosition_axisDay {days : List Rat} (hasc : Ascending days) (p : Rat) :
    axisPosition days (axisDay days p) = p := by
  by_cases hn : days.length < 2
  · simp only [axisPosition, axisDay, hn, ↓reduceIte]
    grind
  · have hn2 : 2 ≤ days.length := by omega
    generalize hk : clampIdx days.length p.floor = k
    have hb : k + 2 ≤ days.length := by
      have := clampIdx_le days.length p.floor; omega
    have hg : 0 < dayAt days (k + 1) - dayAt days k := by
      have := dayAt_lt hasc (Nat.lt_succ_self k) (by omega); grind
    obtain ⟨hstart, hend⟩ := (floor_clamp_iff _ p hb).mp hk
    rw [axisDay_eq hasc hn2 p hk]
    have hseg : clampIdx days.length (axisSegment days
        (dayAt days k + (p - k) * (dayAt days (k + 1) - dayAt days k))) = k := by
      rw [segment_clamp_iff hasc _ hb]
      constructor
      · rcases hstart with h' | h'
        · exact Or.inl h'
        · have : 0 ≤ (p - k) * (dayAt days (k + 1) - dayAt days k) :=
            Rat.mul_nonneg (by grind) (Rat.le_of_lt hg)
          exact Or.inr (by grind)
      · rcases hend with h' | h'
        · exact Or.inl h'
        · have : (p - k) * (dayAt days (k + 1) - dayAt days k) <
              1 * (dayAt days (k + 1) - dayAt days k) :=
            (Rat.mul_lt_mul_right hg).mpr (by grind)
          exact Or.inr (by grind)
    rw [axisPosition_eq hasc hn2 _ hseg]
    have hcancel := Rat.mul_div_cancel (a := p - k) (Rat.ne_of_gt hg)
    grind

end Research.TradingAxis
