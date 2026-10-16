import ResearchFormal.Basic
import ResearchFormal.MonthGrid

/-!
# Chart-viewer windows and resampling

Formal model of `packages/domain/src/market/chartWindow.ts` (ADR-0025).

Days are integers (days since 1970-01-01, as in the TypeScript) and values are
natural numbers; averages, percents and drawdowns are floating-point in the
implementation and are covered by unit and property tests, not here.

* The bucket fold of `resampleSeries`: points carry an integer day; the bucket
  key is a function of the day (identity for daily bars, the week's Monday
  for weekly bars, a month/quarter/year index otherwise, reusing the
  `MonthGrid` civil-date arithmetic). Proved below, for sorted inputs: output
  days strictly ascend; every bar's close is its bucket's last value; the bar
  count never exceeds the input length and is zero only for empty input; every
  bar satisfies `low ≤ open, close ≤ high`. The calendar correspondence (which
  civil date maps to which key, including the Monday rule and month-end
  clamping) is an independent reimplementation used only for the exported
  vectors, tied to the TypeScript by the conformance test and by hand-worked
  unit tests — tested on samples, not proved (the same split as `MonthGrid`).
* The window functions (`presetWindow`, `clampWindow`, `panWindow`,
  `zoomWindow`): the result lies within the extent with `from ≤ to`; a pan
  preserves the span when the extent is wide enough; a zoom keeps the
  extent-clamped anchor inside.
* `visibleSlice`: the binary-search indices are exactly the bars whose days
  lie in the window (proved against a filter; the model scans linearly while
  the implementation bisects — the vectors pin their agreement, as with
  `pairSort` versus `Array.sort`).
* The moving average's shape: the output length and the null prefix
  (`period − 1` leading nulls).
-/

namespace Research

/-! ## Points, bucket keys, bars -/

/-- One observation: an integer day with a natural-number value. -/
structure CPoint where
  day : Int
  val : Nat
  deriving Repr, DecidableEq

/-- Resampling intervals. -/
inductive CInterval where
  | daily
  | weekly
  | monthly
  | quarterly
  | yearly
  deriving Repr, DecidableEq

/-- Monday offset of the week containing `d`: the weekday (0 = Sunday,
    1970-01-01 was a Thursday) moved back to Monday. -/
def mondayOffset (d : Int) : Int :=
  ((((d + 4) % 7 + 7) % 7) + 6) % 7

/-- Bucket key of a day: the identity for daily bars, the week's Monday for
    weekly bars, a month/quarter/year index otherwise. Keying weeks by their
    Monday (rather than the ISO week-numbering year) keeps 2024-12-30 in its
    own week's bucket. -/
def keyOf : CInterval → Int → Int
  | .daily, d => d
  | .weekly, d => d - mondayOffset d
  | .monthly, d =>
    match gridCivilFromDays d with
    | (y, m, _) => y * 12 + (m - 1)
  | .quarterly, d =>
    match gridCivilFromDays d with
    | (y, m, _) => y * 4 + ((m - 1) / 3)
  | .yearly, d => (gridCivilFromDays d).1

/-- One resampled bar (`open_` since `open` is a Lean keyword). -/
structure CBar where
  key : Int
  day : Int
  open_ : Nat
  high : Nat
  low : Nat
  close : Nat
  count : Nat
  deriving Repr, DecidableEq

/-- A bar holding a single point. -/
def pointBar (iv : CInterval) (p : CPoint) : CBar :=
  { key := keyOf iv p.day, day := p.day, open_ := p.val, high := p.val,
    low := p.val, close := p.val, count := 1 }

/-- Folds one more point into an open bar (the key never changes: the caller
    only adds points of the same bucket). -/
def barAdd (iv : CInterval) (b : CBar) (p : CPoint) : CBar :=
  { key := b.key, day := p.day, open_ := b.open_, high := max b.high p.val,
    low := min b.low p.val, close := p.val, count := b.count + 1 }

/-- Maximal leading run of points in bucket `k`, with the rest. -/
def takeRun (iv : CInterval) : List CPoint → Int → List CPoint × List CPoint
  | [], _ => ([], [])
  | p :: ps, k =>
    if keyOf iv p.day = k then
      let (run, rest) := takeRun iv ps k
      (p :: run, rest)
    else ([], p :: ps)

/-- The cons-case projections (proved separately so callers never unfold lets). -/
theorem takeRun_cons_fst (iv : CInterval) (p : CPoint) (ps : List CPoint) (k : Int)
    (h : keyOf iv p.day = k) :
    (takeRun iv (p :: ps) k).1 = p :: (takeRun iv ps k).1 := by
  simp only [takeRun, ifPos h]

theorem takeRun_cons_snd (iv : CInterval) (p : CPoint) (ps : List CPoint) (k : Int)
    (h : keyOf iv p.day = k) :
    (takeRun iv (p :: ps) k).2 = (takeRun iv ps k).2 := by
  simp only [takeRun, ifPos h]

/-- The cons case outside the bucket keeps the whole tail. -/
theorem takeRun_cons_ne (iv : CInterval) (p : CPoint) (ps : List CPoint) (k : Int)
    (h : keyOf iv p.day ≠ k) :
    takeRun iv (p :: ps) k = ([], p :: ps) := by
  simp only [takeRun, ifNeg h]

/-- Every point of the run is in bucket `k`. -/
theorem takeRun_fst_keys (iv : CInterval) (ps : List CPoint) (k : Int) :
    ∀ q ∈ (takeRun iv ps k).1, keyOf iv q.day = k := by
  induction ps with
  | nil =>
    intro q hq
    simp only [takeRun] at hq
    simp at hq
  | cons p ps ih =>
    by_cases h : keyOf iv p.day = k
    · intro q hq
      rw [takeRun_cons_fst iv p ps k h] at hq
      simp at hq
      cases hq with
      | inl heq2 =>
        rw [heq2]
        exact h
      | inr hm =>
        exact ih q hm
    · rw [takeRun_cons_ne iv p ps k h]
      intro q hq
      simp at hq

/-- The run and the rest partition the input. -/
theorem takeRun_append (iv : CInterval) (ps : List CPoint) (k : Int) :
    (takeRun iv ps k).1 ++ (takeRun iv ps k).2 = ps := by
  induction ps with
  | nil => simp [takeRun]
  | cons p ps ih =>
    by_cases h : keyOf iv p.day = k
    · rw [takeRun_cons_fst iv p ps k h, takeRun_cons_snd iv p ps k h,
        List.cons_append, ih]
    · rw [takeRun_cons_ne iv p ps k h]
      show [] ++ (p :: ps) = p :: ps
      exact List.nil_append _

/-- The rest is empty or starts outside bucket `k`. -/
theorem takeRun_rest_head (iv : CInterval) (ps : List CPoint) (k : Int)
    (r : List CPoint) (hr : (takeRun iv ps k).2 = r) :
    r = [] ∨ ∃ q qs, r = q :: qs ∧ keyOf iv q.day ≠ k := by
  induction ps generalizing r with
  | nil =>
    simp [takeRun] at hr
    rw [hr]
    exact Or.inl rfl
  | cons p ps ih =>
    by_cases h : keyOf iv p.day = k
    · have hrr : (takeRun iv ps k).2 = r := by
        rw [takeRun_cons_snd iv p ps k h] at hr
        exact hr
      exact ih r hrr
    · rw [takeRun_cons_ne iv p ps k h] at hr
      have hr2 : p :: ps = r := hr
      rw [← hr2]
      exact Or.inr ⟨p, ps, rfl, h⟩

/-- The rest never outgrows the input (the fuel argument below). -/
theorem takeRun_rest_le (iv : CInterval) (ps : List CPoint) (k : Int) :
    (takeRun iv ps k).2.length ≤ ps.length := by
  induction ps with
  | nil => simp [takeRun]
  | cons p ps ih =>
    by_cases h : keyOf iv p.day = k
    · have hlen : (takeRun iv (p :: ps) k).2.length
          = (takeRun iv ps k).2.length := by
        rw [takeRun_cons_snd iv p ps k h]
      rw [hlen]
      simp only [List.length_cons]
      have ihr := ih
      omega
    · rw [takeRun_cons_ne iv p ps k h]
      show (p :: ps).length ≤ (p :: ps).length
      omega

/-- The rest of a run split lies inside the input. -/
theorem takeRun_mem_suffix (iv : CInterval) (ps : List CPoint) (k : Int) :
    ∀ r ∈ (takeRun iv ps k).2, r ∈ ps := by
  intro r hr
  have h := takeRun_append iv ps k
  have hmem : r ∈ (takeRun iv ps k).1 ++ (takeRun iv ps k).2 :=
    List.mem_append.mpr (Or.inr hr)
  rwa [h] at hmem

/-- Maximal equal-key runs. Daily bars are singletons (the identity: one bar
    per point, even for shared dates). Fuel-bounded so no termination proof
    is needed; every use supplies at least the input length as fuel. -/
def runsFuel (iv : CInterval) : List CPoint → Nat → List (List CPoint)
  | [], _ => []
  | _ :: _, 0 => []
  | p :: ps, f + 1 =>
    if iv = .daily then [p] :: runsFuel iv ps f
    else
      let (run, rest) := takeRun iv ps (keyOf iv p.day)
      (p :: run) :: runsFuel iv rest f

/-- Zero fuel yields no runs. -/
theorem runsFuel_zero (iv : CInterval) (pts : List CPoint) :
    runsFuel iv pts 0 = [] := by
  match pts with
  | [] => simp [runsFuel]
  | _ :: _ => simp [runsFuel]

/-- Empty input yields no runs. -/
theorem runsFuel_nil (iv : CInterval) (f : Nat) : runsFuel iv [] f = [] := by
  match f with
  | 0 => simp [runsFuel]
  | _ + 1 => simp [runsFuel]

/-- The daily case lists one singleton per point; otherwise head, run, rest. -/
theorem runsFuel_cons (iv : CInterval) (p : CPoint) (ps : List CPoint) (f : Nat) :
    ∃ run rest, runsFuel iv (p :: ps) (f + 1)
        = (if iv = .daily then [p] else p :: run) :: runsFuel iv rest f
      ∧ (iv = .daily → rest = ps)
      ∧ (iv ≠ .daily → takeRun iv ps (keyOf iv p.day) = (run, rest)) := by
  by_cases hd : iv = .daily
  · refine ⟨[], ps, ?_, ?_, ?_⟩
    · simp only [runsFuel, ifPos hd]
    · intro _
      rfl
    · intro hne
      exact absurd hd hne
  · refine ⟨(takeRun iv ps (keyOf iv p.day)).1, (takeRun iv ps (keyOf iv p.day)).2,
      ?_, ?_, ?_⟩
    · simp only [runsFuel, ifNeg hd]
    · intro heq2
      exact absurd heq2 hd
    · intro _
      rfl

/-- A bar for a run (`none` for the empty run, which `runsFuel` never emits). -/
def mkBar (iv : CInterval) : List CPoint → Option CBar
  | [] => none
  | p :: tail => some (tail.foldl (barAdd iv) (pointBar iv p))

/-- Total version of `mkBar` (the empty-run default is arbitrary). -/
def mkBarTotal (iv : CInterval) : List CPoint → CBar
  | [] => { key := 0, day := 0, open_ := 0, high := 0, low := 0, close := 0, count := 0 }
  | p :: tail => tail.foldl (barAdd iv) (pointBar iv p)

/-- On a nonempty run the two agree. -/
theorem mkBar_eq_some_total (iv : CInterval) (p : CPoint) (tail : List CPoint) :
    mkBar iv (p :: tail) = some (mkBarTotal iv (p :: tail)) := rfl

/-- The resampling: one bar per maximal run. -/
def resampleSorted (iv : CInterval) (pts : List CPoint) : List CBar :=
  (runsFuel iv pts pts.length).filterMap (mkBar iv)

/-- Stable insertion by day (mirrors the implementation's stable day sort:
    equal days keep their input order). -/
def insertPt (p : CPoint) : List CPoint → List CPoint
  | [] => [p]
  | q :: qs => if p.day ≤ q.day then p :: q :: qs else q :: insertPt p qs

/-- Stable ascending-day sort. -/
def sortPoints : List CPoint → List CPoint
  | [] => []
  | p :: ps => insertPt p (sortPoints ps)

/-- Every emitted run is nonempty. -/
theorem runsFuel_mem_nonempty (iv : CInterval) (pts : List CPoint) (f : Nat) :
    ∀ run ∈ runsFuel iv pts f, run ≠ [] := by
  induction f generalizing pts with
  | zero =>
    intro run hmem
    rw [runsFuel_zero] at hmem
    simp at hmem
  | succ f ih =>
    intro run hmem
    match pts with
    | [] =>
      rw [runsFuel_nil] at hmem
      simp at hmem
    | p :: ps =>
      obtain ⟨hdRun, rest, hfuel, -, -⟩ := runsFuel_cons iv p ps f
      rw [hfuel, List.mem_cons] at hmem
      cases hmem with
      | inl heq =>
        rw [heq]
        by_cases hd : iv = .daily
        · simp [hd]
        · simp [hd]
      | inr hm => exact ih rest run hm

/-- The runs never outnumber the points. -/
theorem runsFuel_length_le (iv : CInterval) (pts : List CPoint) (f : Nat) :
    (runsFuel iv pts f).length ≤ pts.length := by
  induction f generalizing pts with
  | zero =>
    rw [runsFuel_zero]
    simp
  | succ f ih =>
    match pts with
    | [] =>
      rw [runsFuel_nil]
      simp
    | p :: ps =>
      obtain ⟨run, rest, hfuel, hdaily, hsplit⟩ := runsFuel_cons iv p ps f
      have hlen : (runsFuel iv (p :: ps) (f + 1)).length
          = (runsFuel iv rest f).length + 1 := by
        rw [hfuel, List.length_cons]
      rw [hlen]
      simp only [List.length_cons]
      by_cases hd : iv = .daily
      · rw [hdaily hd]
        have h := ih ps
        omega
      · have hpair := hsplit hd
        have h2 : (takeRun iv ps (keyOf iv p.day)).2 = rest := by rw [hpair]
        have h1 := ih rest
        have h2l := takeRun_rest_le iv ps (keyOf iv p.day)
        rw [h2] at h2l
        omega

/-- Filtering with per-element `some` is a map. -/
theorem filterMap_some_map (l : List α) (f : α → Option β) (g : α → β)
    (h : ∀ x ∈ l, f x = some (g x)) : l.filterMap f = l.map g := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    have hx : f x = some (g x) := h x List.mem_cons_self
    have hxs : ∀ y ∈ xs, f y = some (g y) :=
      fun y hy => h y (List.mem_cons_of_mem _ hy)
    simp only [List.filterMap_cons, hx, List.map_cons]
    rw [ih hxs]

/-- Resampling is a map over the runs. -/
theorem resample_map_runs (iv : CInterval) (pts : List CPoint) :
    resampleSorted iv pts = (runsFuel iv pts pts.length).map (mkBarTotal iv) := by
  unfold resampleSorted
  apply filterMap_some_map
  intro run hmem
  match hrun : run with
  | [] => exact absurd rfl (runsFuel_mem_nonempty iv pts pts.length [] hmem)
  | p :: tail => exact mkBar_eq_some_total iv p tail

/-- **Bar count ≤ input length.** -/
theorem resample_length_le (iv : CInterval) (pts : List CPoint) :
    (resampleSorted iv pts).length ≤ pts.length := by
  rw [resample_map_runs, List.length_map]
  exact runsFuel_length_le iv pts pts.length

/-- A cons input always yields a bar. -/
theorem resample_cons_ne (iv : CInterval) (p : CPoint) (ps : List CPoint) :
    resampleSorted iv (p :: ps) ≠ [] := by
  rw [resample_map_runs]
  simp only [List.length_cons]
  obtain ⟨run, rest, hfuel, -, -⟩ := runsFuel_cons iv p ps ps.length
  rw [hfuel, List.map_cons]
  simp

/-- **Bar count is zero only for empty input.** -/
theorem resample_empty (iv : CInterval) (pts : List CPoint) :
    resampleSorted iv pts = [] ↔ pts = [] := by
  constructor
  · intro h
    match pts with
    | [] => rfl
    | p :: ps => exact absurd h (resample_cons_ne iv p ps)
  · intro h
    rw [h]
    rfl

/-- Last value of a run (the default covers the empty run). -/
def runClose : List CPoint → Nat → Nat
  | [], c => c
  | p :: ps, _ => runClose ps p.val

/-- Last day of a run (the default covers the empty run). -/
def runDay : List CPoint → Int → Int
  | [], d => d
  | p :: ps, _ => runDay ps p.day

/-- Folding only ever overwrites the close with the newest value. -/
theorem foldClose_eq (iv : CInterval) (tail : List CPoint) (b : CBar) :
    (tail.foldl (barAdd iv) b).close = runClose tail b.close := by
  induction tail generalizing b with
  | nil => rfl
  | cons q qs ih =>
    show (qs.foldl (barAdd iv) (barAdd iv b q)).close = runClose (q :: qs) b.close
    rw [ih]
    match qs with
    | [] => rfl
    | _ :: _ => rfl

/-- Folding only ever overwrites the day with the newest day. -/
theorem foldDay_eq (iv : CInterval) (tail : List CPoint) (b : CBar) :
    (tail.foldl (barAdd iv) b).day = runDay tail b.day := by
  induction tail generalizing b with
  | nil => rfl
  | cons q qs ih =>
    show (qs.foldl (barAdd iv) (barAdd iv b q)).day = runDay (q :: qs) b.day
    rw [ih]
    match qs with
    | [] => rfl
    | _ :: _ => rfl

/-- Folding counts exactly the folded points. -/
theorem foldCount_eq (iv : CInterval) (tail : List CPoint) (b : CBar) :
    (tail.foldl (barAdd iv) b).count = b.count + tail.length := by
  induction tail generalizing b with
  | nil => simp
  | cons q qs ih =>
    show (qs.foldl (barAdd iv) (barAdd iv b q)).count = b.count + (qs.length + 1)
    rw [ih]
    show (barAdd iv b q).count + qs.length = _
    show b.count + 1 + qs.length = _
    omega

/-- Folding never changes the bucket key. -/
theorem foldKey_eq (iv : CInterval) (tail : List CPoint) (b : CBar) :
    (tail.foldl (barAdd iv) b).key = b.key := by
  induction tail generalizing b with
  | nil => rfl
  | cons q qs ih => exact ih (barAdd iv b q)

/-- The folded day is a day of the run (or the default). -/
theorem runDay_mem_map (qs : List CPoint) (d : Int) :
    runDay qs d = d ∨ runDay qs d ∈ qs.map (·.day) := by
  induction qs generalizing d with
  | nil => exact Or.inl rfl
  | cons p ps ih =>
    show runDay ps p.day = d ∨ runDay ps p.day ∈ (p :: ps).map (·.day)
    have h := ih p.day
    cases h with
    | inl heq =>
      apply Or.inr
      simp only [List.map_cons]
      rw [heq]
      exact List.mem_cons_self
    | inr hm =>
      exact Or.inr (List.mem_cons_of_mem _ hm)

/-- The well-formedness of a bar: the extremes cover open and close. -/
def BarBounds (b : CBar) : Prop :=
  b.low ≤ b.open_ ∧ b.low ≤ b.close ∧ b.open_ ≤ b.high ∧ b.close ≤ b.high

/-- One fold step preserves the bounds. -/
theorem barAdd_bounds (iv : CInterval) (b : CBar) (p : CPoint) (h : BarBounds b) :
    BarBounds (barAdd iv b p) := by
  simp only [BarBounds, barAdd] at h ⊢
  obtain ⟨h1, h2, h3, h4⟩ := h
  omega

/-- A single-point bar satisfies the bounds. -/
theorem pointBar_bounds (iv : CInterval) (p : CPoint) : BarBounds (pointBar iv p) := by
  simp only [BarBounds, pointBar]
  omega

/-- A whole run fold preserves the bounds. -/
theorem fold_bounds (iv : CInterval) (tail : List CPoint) (b : CBar) (h : BarBounds b) :
    BarBounds (tail.foldl (barAdd iv) b) := by
  induction tail generalizing b with
  | nil =>
    simpa using h
  | cons q qs ih =>
    exact ih _ (barAdd_bounds iv b q h)

/-- **Every bar satisfies `low ≤ open, close ≤ high`.** -/
theorem resample_bounds (iv : CInterval) (pts : List CPoint) :
    ∀ b ∈ resampleSorted iv pts, BarBounds b := by
  intro b hb
  rw [resample_map_runs, List.mem_map] at hb
  obtain ⟨run, hmem, rfl⟩ := hb
  match hrun : run with
  | [] => exact absurd rfl (runsFuel_mem_nonempty iv pts pts.length [] hmem)
  | p :: tail =>
    show BarBounds (mkBarTotal iv (p :: tail))
    show BarBounds (tail.foldl (barAdd iv) (pointBar iv p))
    exact fold_bounds iv tail _ (pointBar_bounds iv p)

/-- **Every bar's close is its bucket's last value.** -/
theorem resample_close_last (iv : CInterval) (pts : List CPoint) :
    ∀ b ∈ resampleSorted iv pts,
      ∃ run : List CPoint, ∃ p tail,
        run = p :: tail ∧ run ∈ runsFuel iv pts pts.length
        ∧ b.close = runClose tail p.val := by
  intro b hb
  rw [resample_map_runs, List.mem_map] at hb
  obtain ⟨run, hmem, rfl⟩ := hb
  match hrun : run with
  | [] => exact absurd rfl (runsFuel_mem_nonempty iv pts pts.length [] hmem)
  | p :: tail =>
    refine ⟨p :: tail, p, tail, rfl, hmem, ?_⟩
    show (tail.foldl (barAdd iv) (pointBar iv p)).close = _
    rw [foldClose_eq]
    rfl

/-- Tail of a pairwise list stays pairwise. -/
theorem pairwise_tail {α : Type} {p : α} {ps : List α} {R : α → α → Prop} :
    (p :: ps).Pairwise R → ps.Pairwise R := by
  intro h
  match ps with
  | [] => exact List.Pairwise.nil
  | _ :: _ => exact (List.pairwise_cons.mp h).2

/-- Head of a pairwise list bounds the whole tail. -/
theorem pairwise_head_rel {α : Type} {p : α} {ps : List α} {R : α → α → Prop} :
    (p :: ps).Pairwise R → ∀ y ∈ ps, R p y := by
  intro h
  match ps with
  | [] =>
    intro y hy
    simp at hy
  | _ :: _ => exact (List.pairwise_cons.mp h).1

/-- A suffix of a pairwise concatenation stays pairwise. -/
theorem pairwise_suffix_append (R : CPoint → CPoint → Prop) : ∀ (l1 l2 : List CPoint),
    (l1 ++ l2).Pairwise R → l2.Pairwise R := by
  intro l1
  induction l1 with
  | nil => intro l2 h; simpa using h
  | cons _ _ ih =>
    intro l2 h
    exact ih _ (pairwise_tail h)

/-- Key of a run: its head's bucket (`0` for the empty run, which never occurs). -/
def runKey (iv : CInterval) : List CPoint → Int
  | [] => 0
  | p :: _ => keyOf iv p.day

/-- Run keys strictly ascend with a lower bound threaded through. -/
theorem runs_keys_asc (iv : CInterval) : ∀ (f : Nat) (pts : List CPoint) (lo : Int),
    pts.Pairwise (fun a b => a.day < b.day) →
    pts.Pairwise (fun a b => keyOf iv a.day ≤ keyOf iv b.day) →
    (∀ q ∈ pts, lo < keyOf iv q.day) →
    ((runsFuel iv pts f).map (runKey iv)).Pairwise (· < ·) ∧
    (∀ run ∈ runsFuel iv pts f, lo < runKey iv run) := by
  intro f
  induction f with
  | zero =>
    intro pts lo _ _ _
    rw [runsFuel_zero]
    simp
  | succ f ih =>
    intro pts lo hday hkey hlo
    match pts with
    | [] =>
      rw [runsFuel_nil]
      simp
    | p :: ps =>
      by_cases hd : iv = .daily
      · have hdayT := pairwise_tail hday
        have hkeyT := pairwise_tail hkey
        have hkd : ∀ r : CPoint, keyOf iv r.day = r.day := by
          intro r
          rw [hd]
          rfl
        have hloT : ∀ q ∈ ps, keyOf iv p.day < keyOf iv q.day := by
          intro q hq
          rw [hkd, hkd]
          exact pairwise_head_rel hday q hq
        have hrec := ih ps (keyOf iv p.day) hdayT hkeyT hloT
        obtain ⟨hdRun, rest, hfuel, hdaily, -⟩ := runsFuel_cons iv p ps f
        have hrest : rest = ps := hdaily hd
        have hfuelD : runsFuel iv (p :: ps) (f + 1) = [p] :: runsFuel iv ps f := by
          rw [hfuel, hrest, ifPos hd]
        rw [hfuelD, List.map_cons]
        constructor
        · rw [List.pairwise_cons]
          constructor
          · intro y hy
            rw [List.mem_map] at hy
            obtain ⟨run, hrun, rfl⟩ := hy
            have h2 := hrec.2 run hrun
            show runKey iv [p] < runKey iv run
            show keyOf iv p.day < _
            exact h2
          · exact hrec.1
        · intro run hmem
          have hmem' : run ∈ [p] :: runsFuel iv ps f := hfuelD ▸ hmem
          rw [List.mem_cons] at hmem'
          cases hmem' with
          | inl heq =>
            rw [heq]
            show lo < runKey iv [p]
            show lo < keyOf iv p.day
            exact hlo p List.mem_cons_self
          | inr hm =>
            have h2 := hrec.2 run hm
            have h1 : lo < keyOf iv p.day := hlo p List.mem_cons_self
            show lo < runKey iv run
            omega
      · obtain ⟨run, rest, hfuel, -, hsplit⟩ := runsFuel_cons iv p ps f
        have hpair := hsplit hd
        have h1 : (takeRun iv ps (keyOf iv p.day)).1 = run := by rw [hpair]
        have h2 : (takeRun iv ps (keyOf iv p.day)).2 = rest := by rw [hpair]
        have hsplitEq : run ++ rest = ps := by
          have h := takeRun_append iv ps (keyOf iv p.day)
          rw [h1, h2] at h
          exact h
        have happ : (p :: run) ++ rest = p :: ps := by
          rw [List.cons_append, hsplitEq]
        have hdayR : rest.Pairwise (fun a b => a.day < b.day) := by
          have hday' : ((p :: run) ++ rest).Pairwise (fun a b => a.day < b.day) := by
            rw [happ]
            exact hday
          exact pairwise_suffix_append _ _ _ hday'
        have hkeyR : rest.Pairwise (fun a b => keyOf iv a.day ≤ keyOf iv b.day) := by
          have hkey' : ((p :: run) ++ rest).Pairwise
              (fun a b => keyOf iv a.day ≤ keyOf iv b.day) := by
            rw [happ]
            exact hkey
          exact pairwise_suffix_append _ _ _ hkey'
        have hloR : ∀ q ∈ rest, keyOf iv p.day < keyOf iv q.day := by
          intro q hq
          have hqp : q ∈ ps := by
            have h : q ∈ run ++ rest := List.mem_append.mpr (Or.inr hq)
            rwa [hsplitEq] at h
          have hle : keyOf iv p.day ≤ keyOf iv q.day :=
            pairwise_head_rel hkey q hqp
          have hne : keyOf iv q.day ≠ keyOf iv p.day := by
            have hhead := takeRun_rest_head iv ps (keyOf iv p.day) rest h2
            cases hhead with
            | inl heq => simp [heq] at hq
            | inr hcon =>
              obtain ⟨qq, qqs, heq, hneq⟩ := hcon
              have hkeyRest : (qq :: qqs).Pairwise
                  (fun a b => keyOf iv a.day ≤ keyOf iv b.day) := by
                rw [← heq]
                exact hkeyR
              have hqrest : q ∈ qq :: qqs := by
                rw [← heq]
                exact hq
              rw [List.mem_cons] at hqrest
              cases hqrest with
              | inl heq2 =>
                rw [heq2]
                exact hneq
              | inr hm =>
                have hqqrest : qq ∈ rest := by
                  rw [heq]
                  exact List.mem_cons_self
                have hqqps : qq ∈ ps := by
                  have hmemqq : qq ∈ run ++ rest :=
                    List.mem_append.mpr (Or.inr hqqrest)
                  rwa [hsplitEq] at hmemqq
                have hk1q : keyOf iv p.day ≤ keyOf iv qq.day :=
                  pairwise_head_rel hkey qq hqqps
                have hle2 : keyOf iv qq.day ≤ keyOf iv q.day :=
                  pairwise_head_rel hkeyRest q hm
                omega
          omega
        have hrec := ih rest (keyOf iv p.day) hdayR hkeyR hloR
        have hfuelN : runsFuel iv (p :: ps) (f + 1)
            = (p :: run) :: runsFuel iv rest f := by
          rw [hfuel, ifNeg hd]
        rw [hfuelN, List.map_cons]
        constructor
        · rw [List.pairwise_cons]
          constructor
          · intro y hy
            rw [List.mem_map] at hy
            obtain ⟨rn, hrn, rfl⟩ := hy
            have h2r := hrec.2 rn hrn
            show runKey iv (p :: run) < runKey iv rn
            show keyOf iv p.day < _
            exact h2r
          · exact hrec.1
        · intro rn hmem
          have hmem' : rn ∈ (p :: run) :: runsFuel iv rest f := hfuelN ▸ hmem
          rw [List.mem_cons] at hmem'
          cases hmem' with
          | inl heq =>
            rw [heq]
            show lo < runKey iv (p :: run)
            show lo < keyOf iv p.day
            exact hlo p List.mem_cons_self
          | inr hm =>
            have h2r := hrec.2 rn hm
            have h1r : lo < keyOf iv p.day := hlo p List.mem_cons_self
            show lo < runKey iv rn
            omega

/-- A bar's key is its run's key. -/
theorem bar_key_eq_runKey (iv : CInterval) (x : List CPoint) (hne : x ≠ []) :
    (mkBarTotal iv x).key = runKey iv x := by
  match x with
  | [] => exact absurd rfl hne
  | p :: tail =>
    show (tail.foldl (barAdd iv) (pointBar iv p)).key = _
    rw [foldKey_eq]
    rfl

/-- Transport a pairwise statement across maps. -/
theorem pairwise_map_iff (l : List α) (f : α → β) (R : β → β → Prop) :
    (l.map f).Pairwise R ↔ l.Pairwise (fun a b => R (f a) (f b)) := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    simp only [List.map_cons]
    constructor
    · intro h
      obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp h
      rw [List.pairwise_cons]
      refine ⟨?_, ih.mp htail⟩
      intro y hy
      exact hhead (f y) (List.mem_map_of_mem hy)
    · intro h
      obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp h
      rw [List.pairwise_cons]
      refine ⟨?_, ih.mpr htail⟩
      intro z hz
      rw [List.mem_map] at hz
      obtain ⟨y, hym, rfl⟩ := hz
      exact hhead y hym

/-- Pointwise-equal relations give the same pairwise statement. -/
theorem pairwise_congr (l : List α) (R S : α → α → Prop)
    (h : ∀ x ∈ l, ∀ y ∈ l, (R x y ↔ S x y)) (hp : l.Pairwise R) : l.Pairwise S := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp hp
    rw [List.pairwise_cons]
    constructor
    · intro y hy
      exact ((h x List.mem_cons_self y (List.mem_cons_of_mem _ hy)).mp) (hhead y hy)
    · exact ih
        (fun x hx y hy => h x (List.mem_cons_of_mem _ hx) y (List.mem_cons_of_mem _ hy))
        htail

/-- **Output bucket keys strictly ascend** (for strictly day-ordered input
    with ordered bucket keys — the shape real series have). -/
theorem resample_keys_asc (iv : CInterval) (pts : List CPoint) (lo : Int)
    (hday : pts.Pairwise (fun a b => a.day < b.day))
    (hkey : pts.Pairwise (fun a b => keyOf iv a.day ≤ keyOf iv b.day))
    (hlo : ∀ q ∈ pts, lo < keyOf iv q.day) :
    (resampleSorted iv pts).Pairwise (fun a b => a.key < b.key) := by
  have hr := runs_keys_asc iv pts.length pts lo hday hkey hlo
  rw [resample_map_runs, pairwise_map_iff]
  have hrk := (pairwise_map_iff _ _ _).mp hr.1
  apply pairwise_congr _ _ _ _ hrk
  intro x hx y hy
  have hne := runsFuel_mem_nonempty iv pts pts.length
  have ex : (mkBarTotal iv x).key = runKey iv x := bar_key_eq_runKey iv x (hne x hx)
  have ey : (mkBarTotal iv y).key = runKey iv y := bar_key_eq_runKey iv y (hne y hy)
  rw [ex, ey]

/-- Before-lemma: everything in the left part precedes everything in the right. -/
theorem pairwise_before_day (l1 l2 : List CPoint)
    (h : (l1 ++ l2).Pairwise (fun a b => a.day < b.day)) :
    ∀ x ∈ l1, ∀ y ∈ l2, x.day < y.day := by
  induction l1 with
  | nil =>
    intro x hx
    simp at hx
  | cons a t ih =>
    intro x hx y hy
    rw [List.mem_cons] at hx
    cases hx with
    | inl heq =>
      rw [heq]
      have hhead : ∀ z ∈ t ++ l2, a.day < z.day := pairwise_head_rel h
      exact hhead y (List.mem_append.mpr (Or.inr hy))
    | inr hm =>
      exact ih (pairwise_tail h) x hm y hy

/-- Every run's points lie inside the input. -/
theorem runsFuel_subset (iv : CInterval) : ∀ (f : Nat) (pts : List CPoint),
    ∀ run ∈ runsFuel iv pts f, ∀ q ∈ run, q ∈ pts := by
  intro f
  induction f with
  | zero =>
    intro pts run hmem
    rw [runsFuel_zero] at hmem
    simp at hmem
  | succ f ih =>
    intro pts run hmem q hq
    match pts with
    | [] =>
      rw [runsFuel_nil] at hmem
      simp at hmem
    | p :: ps =>
      obtain ⟨hdRun, rest, hfuel, hdaily, hsplit⟩ := runsFuel_cons iv p ps f
      rw [hfuel, List.mem_cons] at hmem
      cases hmem with
      | inl heq =>
        rw [heq] at hq
        by_cases hd : iv = .daily
        · rw [ifPos hd] at hq
          rw [List.mem_cons] at hq
          cases hq with
          | inl heq2 =>
            rw [heq2]
            exact List.mem_cons_self
          | inr hm => exact absurd hm List.not_mem_nil
        · rw [ifNeg hd] at hq
          rw [List.mem_cons] at hq
          cases hq with
          | inl heq2 =>
            rw [heq2]
            exact List.mem_cons_self
          | inr hm =>
            have hpair := hsplit hd
            have h1 : (takeRun iv ps (keyOf iv p.day)).1 = hdRun := by rw [hpair]
            have h2 : (takeRun iv ps (keyOf iv p.day)).2 = rest := by rw [hpair]
            have happ := takeRun_append iv ps (keyOf iv p.day)
            rw [h1, h2] at happ
            have hmem' : q ∈ hdRun ++ rest := List.mem_append.mpr (Or.inl hm)
            rw [happ] at hmem'
            exact List.mem_cons_of_mem _ hmem'
      | inr hm =>
        have hsub := ih rest run hm q hq
        by_cases hd : iv = .daily
        · rw [hdaily hd] at hsub
          exact List.mem_cons_of_mem _ hsub
        · have hpair := hsplit hd
          have h1 : (takeRun iv ps (keyOf iv p.day)).1 = hdRun := by rw [hpair]
          have h2 : (takeRun iv ps (keyOf iv p.day)).2 = rest := by rw [hpair]
          have happ := takeRun_append iv ps (keyOf iv p.day)
          rw [h1, h2] at happ
          have hmem' : q ∈ hdRun ++ rest := List.mem_append.mpr (Or.inr hsub)
          rw [happ] at hmem'
          exact List.mem_cons_of_mem _ hmem'

/-- A bar's day is a day of its run. -/
theorem bar_day_mem_run (iv : CInterval) (p : CPoint) (tail : List CPoint) :
    (mkBarTotal iv (p :: tail)).day ∈ (p :: tail).map (·.day) := by
  have hfold : (mkBarTotal iv (p :: tail)).day = runDay tail p.day :=
    foldDay_eq iv tail (pointBar iv p)
  rw [hfold]
  have h := runDay_mem_map tail p.day
  cases h with
  | inl heq =>
    rw [heq]
    simp
  | inr hm =>
    simp only [List.map_cons]
    exact List.mem_cons_of_mem _ hm

/-- A bar's day is one of the input's days. -/
theorem bar_day_mem_input (iv : CInterval) (f : Nat) (pts : List CPoint)
    (run : List CPoint) (hmem : run ∈ runsFuel iv pts f) :
    (mkBarTotal iv run).day ∈ pts.map (·.day) := by
  match hrun : run with
  | [] => exact absurd rfl (runsFuel_mem_nonempty iv pts f [] hmem)
  | p :: tail =>
    have hsub := runsFuel_subset iv f pts (p :: tail) hmem
    have h := bar_day_mem_run iv p tail
    rw [List.mem_map] at h ⊢
    obtain ⟨q, hq, heq⟩ := h
    exact ⟨q, hsub q hq, heq⟩

/-- Run days strictly ascend with a lower bound threaded through. -/
theorem runs_days_asc (iv : CInterval) : ∀ (f : Nat) (pts : List CPoint) (lo : Int),
    pts.Pairwise (fun a b => a.day < b.day) →
    (∀ q ∈ pts, lo < q.day) →
    ((runsFuel iv pts f).map (fun run => (mkBarTotal iv run).day)).Pairwise (· < ·) ∧
    (∀ run ∈ runsFuel iv pts f, lo < (mkBarTotal iv run).day) := by
  intro f
  induction f with
  | zero =>
    intro pts lo _ _
    rw [runsFuel_zero]
    simp
  | succ f ih =>
    intro pts lo hday hlo
    match pts with
    | [] =>
      rw [runsFuel_nil]
      simp
    | p :: ps =>
      have hdayT := pairwise_tail hday
      obtain ⟨hdRun, rest, hfuel, hdaily, hsplit⟩ := runsFuel_cons iv p ps f
      by_cases hd : iv = .daily
      · have hrest : rest = ps := hdaily hd
        have hrec := ih ps p.day hdayT (fun q hq => pairwise_head_rel hday q hq)
        have hfuelD : runsFuel iv (p :: ps) (f + 1) = [p] :: runsFuel iv ps f := by
          rw [hfuel, hrest, ifPos hd]
        rw [hfuelD, List.map_cons]
        constructor
        · rw [List.pairwise_cons]
          constructor
          · intro y hy
            rw [List.mem_map] at hy
            obtain ⟨run, hrun, rfl⟩ := hy
            have h2 := hrec.2 run hrun
            show (mkBarTotal iv [p]).day < (mkBarTotal iv run).day
            show p.day < _
            exact h2
          · exact hrec.1
        · intro run hmem
          have hmem' : run ∈ [p] :: runsFuel iv ps f := hfuelD ▸ hmem
          rw [List.mem_cons] at hmem'
          cases hmem' with
          | inl heq =>
            rw [heq]
            show lo < (mkBarTotal iv [p]).day
            show lo < p.day
            exact hlo p List.mem_cons_self
          | inr hm =>
            have h2 := hrec.2 run hm
            have h1 : lo < p.day := hlo p List.mem_cons_self
            show lo < (mkBarTotal iv run).day
            omega
      · have hpair := hsplit hd
        have h1 : (takeRun iv ps (keyOf iv p.day)).1 = hdRun := by rw [hpair]
        have h2 : (takeRun iv ps (keyOf iv p.day)).2 = rest := by rw [hpair]
        have happT := takeRun_append iv ps (keyOf iv p.day)
        rw [h1, h2] at happT
        have happ : (p :: hdRun) ++ rest = p :: ps := by
          rw [List.cons_append, happT]
        have hdayR : rest.Pairwise (fun a b => a.day < b.day) := by
          have hday' : ((p :: hdRun) ++ rest).Pairwise (fun a b => a.day < b.day) := by
            rw [happ]
            exact hday
          exact pairwise_suffix_append _ _ _ hday'
        have hbefore := pairwise_before_day _ _ (by rw [happ]; exact hday)
        have hfuelN : runsFuel iv (p :: ps) (f + 1)
            = (p :: hdRun) :: runsFuel iv rest f := by
          rw [hfuel, ifNeg hd]
        have hheadDay : (mkBarTotal iv (p :: hdRun)).day ∈ ((p :: hdRun).map (·.day)) :=
          bar_day_mem_run iv p hdRun
        have hrec := ih rest ((mkBarTotal iv (p :: hdRun)).day) hdayR (fun q hq => by
          obtain ⟨qd, hqd, heq⟩ := List.mem_map.mp hheadDay
          have hlt : qd.day < q.day := hbefore qd hqd q hq
          show (mkBarTotal iv (p :: hdRun)).day < q.day
          rw [← heq]
          exact hlt)
        rw [hfuelN, List.map_cons]
        constructor
        · rw [List.pairwise_cons]
          constructor
          · intro y hy
            rw [List.mem_map] at hy
            obtain ⟨rn, hrn, rfl⟩ := hy
            exact hrec.2 rn hrn
          · exact hrec.1
        · intro rn hmem
          have hmem' : rn ∈ (p :: hdRun) :: runsFuel iv rest f := hfuelN ▸ hmem
          rw [List.mem_cons] at hmem'
          cases hmem' with
          | inl heq =>
            rw [heq]
            obtain ⟨qd, hqd, heqd⟩ := List.mem_map.mp hheadDay
            have hqdps : qd ∈ p :: ps := by
              have hmem' : qd ∈ (p :: hdRun) ++ rest :=
                List.mem_append.mpr (Or.inl hqd)
              rwa [happ] at hmem'
            have hloqd : lo < qd.day := hlo qd hqdps
            show lo < (mkBarTotal iv (p :: hdRun)).day
            rw [← heqd]
            exact hloqd
          | inr hm =>
            have hmemD := bar_day_mem_input iv f rest rn hm
            obtain ⟨q, hq, heqy⟩ := List.mem_map.mp hmemD
            have hqps : q ∈ ps := by
              have hmem' : q ∈ hdRun ++ rest := List.mem_append.mpr (Or.inr hq)
              rwa [happT] at hmem'
            have hloq : lo < q.day := hlo q (List.mem_cons_of_mem _ hqps)
            show lo < (mkBarTotal iv rn).day
            rw [← heqy]
            exact hloq

/-- **Output days strictly ascend** (for strictly day-ordered input). -/
theorem resample_days_asc (iv : CInterval) (pts : List CPoint) (lo : Int)
    (hday : pts.Pairwise (fun a b => a.day < b.day))
    (hlo : ∀ q ∈ pts, lo < q.day) :
    (resampleSorted iv pts).Pairwise (fun a b => a.day < b.day) := by
  have hr := runs_days_asc iv pts.length pts lo hday hlo
  rw [resample_map_runs, pairwise_map_iff]
  have hrk := (pairwise_map_iff _ _ _).mp hr.1
  apply pairwise_congr _ _ _ _ hrk
  intro x hx y hy
  exact Iff.rfl

/-! ## Windows -/

/-- An inclusive integer-day window. -/
structure Window where
  lo : Int
  hi : Int
  deriving Repr, DecidableEq

def winLo (w : Window) : Int := min w.lo w.hi
def winHi (w : Window) : Int := max w.lo w.hi

/-- Fits `[a, a + span]` into `[lo, hi]` keeping the span; the whole extent
    when the span cannot fit. -/
def fitSpan (a span lo hi : Int) : Window :=
  if span ≥ hi - lo then ⟨lo, hi ⟩
  else ⟨min (max a lo) (hi - span), min (max a lo) (hi - span) + span ⟩

/-- The fit stays inside the extent. -/
theorem fitSpan_within (a span lo hi : Int) :
    lo ≤ (fitSpan a span lo hi).lo ∧ (fitSpan a span lo hi).hi ≤ hi := by
  unfold fitSpan
  by_cases h : span ≥ hi - lo
  · rw [ifPos h]
    show lo ≤ lo ∧ hi ≤ hi
    exact ⟨Int.le_refl _, Int.le_refl _⟩
  · rw [ifNeg h]
    show lo ≤ min (max a lo) (hi - span)
      ∧ min (max a lo) (hi - span) + span ≤ hi
    constructor <;> omega

/-- The fit is ordered. -/
theorem fitSpan_ordered (a span lo hi : Int) (hs : 0 ≤ span) (hle : lo ≤ hi) :
    (fitSpan a span lo hi).lo ≤ (fitSpan a span lo hi).hi := by
  unfold fitSpan
  by_cases h : span ≥ hi - lo
  · rw [ifPos h]
    show lo ≤ hi
    exact hle
  · rw [ifNeg h]
    show min (max a lo) (hi - span) ≤ min (max a lo) (hi - span) + span
    omega

/-- The fit keeps the span when it fits. -/
theorem fitSpan_span_kept (a span lo hi : Int) (h : span ≤ hi - lo) :
    (fitSpan a span lo hi).hi - (fitSpan a span lo hi).lo = span := by
  unfold fitSpan
  by_cases hc : span ≥ hi - lo
  · rw [ifPos hc]
    show hi - lo = span
    omega
  · rw [ifNeg hc]
    show min (max a lo) (hi - span) + span - min (max a lo) (hi - span) = span
    omega

/-- Clamps a window into the held extent with at least `minSpan` days. -/
def clampWindow (w e : Window) (minSpan : Nat) : Window :=
  fitSpan (winLo w) (max (winHi w - winLo w) (minSpan : Int)) (winLo e) (winHi e)

/-- **The clamp stays inside the extent.** -/
theorem clampWindow_within (w e : Window) (minSpan : Nat) :
    winLo e ≤ (clampWindow w e minSpan).lo
    ∧ (clampWindow w e minSpan).hi ≤ winHi e := by
  unfold clampWindow
  exact fitSpan_within _ _ _ _

/-- **The clamp is ordered.** -/
theorem clampWindow_ordered (w e : Window) (minSpan : Nat) :
    (clampWindow w e minSpan).lo ≤ (clampWindow w e minSpan).hi := by
  unfold clampWindow
  apply fitSpan_ordered
  · have h1 : (0 : Int) ≤ (minSpan : Int) := by omega
    omega
  · unfold winLo winHi
    omega

/-- Shifts a window, keeping its span (the fit into the extent may shrink it
    only when the span cannot fit). -/
def panWindow (w : Window) (delta : Int) (e : Window) : Window :=
  fitSpan (winLo w + delta) (winHi w - winLo w) (winLo e) (winHi e)

/-- **A pan preserves the span when the extent is wide enough.** -/
theorem panWindow_span (w : Window) (delta : Int) (e : Window)
    (hfit : winHi w - winLo w ≤ winHi e - winLo e) :
    (panWindow w delta e).hi - (panWindow w delta e).lo
      = winHi w - winLo w := by
  unfold panWindow
  exact fitSpan_span_kept _ _ _ _ hfit

/-- **A pan stays inside the extent ordered.** -/
theorem panWindow_within (w : Window) (delta : Int) (e : Window) :
    winLo e ≤ (panWindow w delta e).lo ∧ (panWindow w delta e).hi ≤ winHi e
    ∧ (panWindow w delta e).lo ≤ (panWindow w delta e).hi := by
  unfold panWindow
  refine ⟨(fitSpan_within _ _ _ _).1, (fitSpan_within _ _ _ _).2, ?_⟩
  have hs : (0 : Int) ≤ winHi w - winLo w := by
    unfold winLo winHi
    omega
  have hle : winLo e ≤ winHi e := by
    unfold winLo winHi
    omega
  exact fitSpan_ordered _ _ _ _ hs hle

/-- Anchor-relative integer shift: the truncated `offset × span ÷ total`,
    capped at the new span (the cap is what keeps the anchor inside). -/
def zshift (off s span : Nat) : Nat :=
  if span = 0 then s / 2 else min s ((off * s) / span)

/-- The shift never exceeds the new span. -/
theorem zshift_le (off s span : Nat) : zshift off s span ≤ s := by
  unfold zshift
  by_cases h : span = 0
  · rw [ifPos h]
    exact Nat.div_le_self s 2
  · rw [ifNeg h]
    exact Nat.min_le_left s _

/-- Zoom placement core for a precomputed span and anchor-relative start:
    the window is fitted into the extent. -/
def zoomFitCore (ae start : Int) (s : Nat) (lo hi : Int) : Window :=
  if (s : Int) ≥ hi - lo then ⟨lo, hi⟩
  else ⟨min (max start lo) (hi - (s : Int)),
        min (max start lo) (hi - (s : Int)) + (s : Int)⟩

/-- **The core fit keeps the anchor inside.** -/
theorem zoomFitCore_anchor (ae start : Int) (s : Nat) (lo hi : Int)
    (hae : lo ≤ ae ∧ ae ≤ hi)
    (hlo : ae - (s : Int) ≤ start) (hhi : start ≤ ae) :
    (zoomFitCore ae start s lo hi).lo ≤ ae
    ∧ ae ≤ (zoomFitCore ae start s lo hi).hi := by
  unfold zoomFitCore
  by_cases h : (s : Int) ≥ hi - lo
  · rw [ifPos h]
    show lo ≤ ae ∧ ae ≤ hi
    exact hae
  · rw [ifNeg h]
    show min (max start lo) (hi - ↑s) ≤ ae
      ∧ ae ≤ min (max start lo) (hi - ↑s) + ↑s
    omega

/-- **The core fit stays inside the extent ordered.** -/
theorem zoomFitCore_within (ae start : Int) (s : Nat) (lo hi : Int)
    (hlo : ae - (s : Int) ≤ start) (hhi : start ≤ ae) (hle : lo ≤ hi) :
    lo ≤ (zoomFitCore ae start s lo hi).lo
    ∧ (zoomFitCore ae start s lo hi).hi ≤ hi
    ∧ (zoomFitCore ae start s lo hi).lo ≤ (zoomFitCore ae start s lo hi).hi := by
  unfold zoomFitCore
  by_cases h : (s : Int) ≥ hi - lo
  · rw [ifPos h]
    show lo ≤ lo ∧ hi ≤ hi ∧ lo ≤ hi
    refine ⟨Int.le_refl _, Int.le_refl _, ?_⟩
    omega
  · rw [ifNeg h]
    show lo ≤ min (max start lo) (hi - ↑s)
      ∧ min (max start lo) (hi - ↑s) + ↑s ≤ hi
      ∧ min (max start lo) (hi - ↑s) ≤ min (max start lo) (hi - ↑s) + ↑s
    refine ⟨?_, ?_, ?_⟩
    · omega
    · omega
    · omega

/-- Zoom placement for a precomputed span: the anchor keeps a capped relative
    position, then the window is fitted into the extent. -/
def zoomFit (a b anchor : Int) (s : Nat) (lo hi : Int) : Window :=
  zoomFitCore (min (max anchor lo) hi)
    (min (max anchor lo) hi
      - ((zshift ((min (max (min (max anchor lo) hi - a) 0) (b - a)).toNat) s
          ((b - a).toNat) : Nat) : Int))
    s lo hi

/-- The shift fact, stated once with the exact terms the wrapper computes. -/
theorem zoomFit_shift_le (a anchor : Int) (s : Nat) (lo hi b : Int) :
    zshift ((min (max (min (max anchor lo) hi - a) 0) (b - a)).toNat) s
        ((b - a).toNat) ≤ s :=
  zshift_le _ _ _

/-- **A zoom keeps the extent-clamped anchor inside.** -/
theorem zoomFit_anchor (a b anchor : Int) (s : Nat) (lo hi : Int) (hle : lo ≤ hi) :
    (zoomFit a b anchor s lo hi).lo ≤ min (max anchor lo) hi ∧
    min (max anchor lo) hi ≤ (zoomFit a b anchor s lo hi).hi := by
  unfold zoomFit
  apply zoomFitCore_anchor
  · constructor <;> omega
  · have hq := zoomFit_shift_le a anchor s lo hi b
    omega
  · omega

/-- **A zoom stays inside the extent ordered.** -/
theorem zoomFit_within (a b anchor : Int) (s : Nat) (lo hi : Int) (hle : lo ≤ hi) :
    lo ≤ (zoomFit a b anchor s lo hi).lo ∧ (zoomFit a b anchor s lo hi).hi ≤ hi
    ∧ (zoomFit a b anchor s lo hi).lo ≤ (zoomFit a b anchor s lo hi).hi := by
  unfold zoomFit
  apply zoomFitCore_within
  · have hq := zoomFit_shift_le a anchor s lo hi b
    omega
  · omega
  · exact hle

/-- Target span from a scale factor `num / den` (round half up), within
    `[floor, cap]`. -/
def zoomNewSpan (span num den floor cap : Nat) : Nat :=
  if den = 0 then min cap floor
  else min cap (max floor ((2 * span * num + den) / (2 * den)))

/-- Zooms around `anchor` by `num / den`, fitted into the extent. -/
def zoomWindow (w : Window) (anchor : Int) (num den : Nat) (e : Window)
    (minSpan : Nat) : Window :=
  zoomFit (min w.lo w.hi) (max w.lo w.hi) anchor
    (zoomNewSpan ((max w.lo w.hi - min w.lo w.hi).toNat) num den minSpan
      ((max e.lo e.hi - min e.lo e.hi).toNat))
    (min e.lo e.hi) (max e.lo e.hi)

/-- **A zoom keeps the extent-clamped anchor inside.** -/
theorem zoomWindow_anchor (w : Window) (anchor : Int) (num den : Nat) (e : Window)
    (minSpan : Nat) :
    (zoomWindow w anchor num den e minSpan).lo ≤ min (max anchor (winLo e)) (winHi e)
    ∧ min (max anchor (winLo e)) (winHi e)
      ≤ (zoomWindow w anchor num den e minSpan).hi := by
  unfold zoomWindow winLo winHi
  exact zoomFit_anchor _ _ _ _ _ _ (by omega)

/-- Preset buttons. -/
inductive CPreset where
  | w1
  | m1
  | m3
  | m6
  | ytd
  | y1
  | y3
  | y5
  | max
  deriving Repr, DecidableEq

/-- Back `months` calendar months with the day clamped (the Lean twin of the
    implementation's month stepping). -/
def subMonthsDay (day : Int) (months : Nat) : Int :=
  match gridCivilFromDays day with
  | (y, m, d) =>
    let total := y * 12 + (m - 1) - (months : Int)
    let ty := total / 12
    let tm := total - ty * 12 + 1
    let dim := gridDaysInMonth ty.toNat tm.toNat
    let cd := if d ≤ (dim : Int) then d.toNat else dim
    gridDaysFromCivil ty.toNat tm.toNat cd

/-- Preset start day (the end is always the last held day). -/
def presetStart : CPreset → Int → Int → Int
  | .w1, _, last => last - 7
  | .ytd, _, last =>
    match gridCivilFromDays last with
    | (y, _, _) => gridDaysFromCivil y.toNat 1 1
  | .m1, _, last => subMonthsDay last 1
  | .m3, _, last => subMonthsDay last 3
  | .m6, _, last => subMonthsDay last 6
  | .y1, _, last => subMonthsDay last 12
  | .y3, _, last => subMonthsDay last 36
  | .y5, _, last => subMonthsDay last 60
  | .max, first, _ => first

/-- A preset window: `to` is the last held day, `from` counts back and is
    clamped into the held extent. -/
def presetWindow (preset : CPreset) (first last : Int) : Window :=
  ⟨min (max (presetStart preset (min first last) (max first last)) (min first last))
    (max first last),
    max first last⟩

/-- **A preset is ordered with `to` at the last day.** -/
theorem presetWindow_ordered (preset : CPreset) (first last : Int) :
    (presetWindow preset first last).lo ≤ (presetWindow preset first last).hi
    ∧ (presetWindow preset first last).hi = max first last := by
  unfold presetWindow
  show min (max (presetStart preset (min first last) (max first last)) (min first last))
      (max first last)
      ≤ max first last
    ∧ max first last = max first last
  constructor
  · omega
  · rfl

/-- **A preset stays inside the held extent.** -/
theorem presetWindow_within (preset : CPreset) (first last : Int) :
    min first last ≤ (presetWindow preset first last).lo
    ∧ (presetWindow preset first last).hi ≤ max first last := by
  unfold presetWindow
  show min first last
      ≤ min (max (presetStart preset (min first last) (max first last)) (min first last))
        (max first last)
    ∧ max first last ≤ max first last
  constructor
  · omega
  · exact Int.le_refl _

/-! ## Visible slice -/

/-- First index with day `≥ x`. -/
def lowerBound : List Int → Int → Nat
  | [], _ => 0
  | d :: ds, x => if x ≤ d then 0 else lowerBound ds x + 1

/-- First index with day `> x`. -/
def upperBound : List Int → Int → Nat
  | [], _ => 0
  | d :: ds, x => if d ≤ x then upperBound ds x + 1 else 0

/-- Slice indices `[start, end)` for the window (ends normalised). -/
def sliceIdx (days : List Int) (a b : Int) : Nat × Nat :=
  (lowerBound days (min a b), upperBound days (max a b))

/-- Singleton filter facts on integers (the `MonthGrid` versions are `Nat`-only). -/
theorem filter_singleton_false' (p : Int → Bool) (n : Int) (h : ¬ p n = true) :
    [n].filter p = [] := by
  rw [List.filter_cons, ifNeg h, List.filter_nil]

theorem filter_singleton_true' (p : Int → Bool) (n : Int) (h : p n = true) :
    [n].filter p = [n] := by
  rw [List.filter_cons, ifPos h, List.filter_nil]

/-- Days below `x` never survive the filter. -/
theorem filter_lt_none_of_ge (days : List Int) (x d0 : Int)
    (hge : ∀ d ∈ days, d0 ≤ d) (hle : x ≤ d0) :
    (days.filter (fun d => decide (d < x))).length = 0 := by
  induction days with
  | nil => simp
  | cons d ds ih =>
    have h1 : (([d].filter (fun e => decide (e < x)))) = [] := by
      apply filter_singleton_false'
      simp only [decide_eq_true_eq]
      have h0 := hge d List.mem_cons_self
      omega
    have h2 : (ds.filter (fun e => decide (e < x))).length = 0 :=
      ih (fun e he => hge e (List.mem_cons_of_mem _ he))
    have hcons : d :: ds = [d] ++ ds := rfl
    rw [hcons, List.filter_append, h1, List.nil_append, h2]

/-- Days above `x` never survive the filter. -/
theorem filter_le_none_of_gt (days : List Int) (x d0 : Int)
    (hge : ∀ d ∈ days, d0 ≤ d) (hgt : x < d0) :
    (days.filter (fun d => decide (d ≤ x))).length = 0 := by
  induction days with
  | nil => simp
  | cons d ds ih =>
    have h1 : (([d].filter (fun e => decide (e ≤ x)))) = [] := by
      apply filter_singleton_false'
      simp only [decide_eq_true_eq]
      have h0 := hge d List.mem_cons_self
      omega
    have h2 : (ds.filter (fun e => decide (e ≤ x))).length = 0 :=
      ih (fun e he => hge e (List.mem_cons_of_mem _ he))
    have hcons : d :: ds = [d] ++ ds := rfl
    rw [hcons, List.filter_append, h1, List.nil_append, h2]

/-- The lower bound counts the days below `x` (sorted input). -/
theorem lowerBound_count (days : List Int) (x : Int)
    (hsorted : days.Pairwise (· ≤ ·)) :
    lowerBound days x = (days.filter (fun d => decide (d < x))).length := by
  induction days with
  | nil => simp [lowerBound]
  | cons d ds ih =>
    have htail := pairwise_tail hsorted
    by_cases h : x ≤ d
    · have hds0 := filter_lt_none_of_ge ds x d (pairwise_head_rel hsorted) h
      have h1 : (([d].filter (fun e => decide (e < x)))) = [] := by
        apply filter_singleton_false'
        simp only [decide_eq_true_eq]
        omega
      have hlb : lowerBound (d :: ds) x = 0 := by
        simp only [lowerBound, ifPos h]
      rw [hlb]
      have hcons : d :: ds = [d] ++ ds := rfl
      rw [hcons, List.filter_append, h1, List.nil_append, hds0]
    · have hdx : d < x := by omega
      have h1 : (([d].filter (fun e => decide (e < x)))) = [d] := by
        apply filter_singleton_true'
        simp only [decide_eq_true_eq]
        exact hdx
      have hlb : lowerBound (d :: ds) x = lowerBound ds x + 1 := by
        simp only [lowerBound, ifNeg h]
      rw [hlb, ih htail]
      have hcons : d :: ds = [d] ++ ds := rfl
      rw [hcons, List.filter_append, h1, List.cons_append]
      simp

/-- The upper bound counts the days at or below `x` (sorted input). -/
theorem upperBound_count (days : List Int) (x : Int)
    (hsorted : days.Pairwise (· ≤ ·)) :
    upperBound days x = (days.filter (fun d => decide (d ≤ x))).length := by
  induction days with
  | nil => simp [upperBound]
  | cons d ds ih =>
    have htail := pairwise_tail hsorted
    by_cases h : d ≤ x
    · have h1 : (([d].filter (fun e => decide (e ≤ x)))) = [d] := by
        apply filter_singleton_true'
        simp only [decide_eq_true_eq]
        exact h
      have hub : upperBound (d :: ds) x = upperBound ds x + 1 := by
        simp only [upperBound, ifPos h]
      rw [hub, ih htail]
      have hcons : d :: ds = [d] ++ ds := rfl
      rw [hcons, List.filter_append, h1, List.cons_append]
      simp
    · have hgt : x < d := by omega
      have h1 : (([d].filter (fun e => decide (e ≤ x)))) = [] := by
        apply filter_singleton_false'
        simp only [decide_eq_true_eq]
        omega
      have hds0 := filter_le_none_of_gt ds x d (pairwise_head_rel hsorted) hgt
      have hub : upperBound (d :: ds) x = 0 := by
        simp only [upperBound, ifNeg h]
      rw [hub]
      have hcons : d :: ds = [d] ++ ds := rfl
      rw [hcons, List.filter_append, h1, List.nil_append, hds0]

/-- A window filter that is empty on the whole tail. -/
theorem filter_window_none_of_gt (days : List Int) (lo hi d0 : Int)
    (hge : ∀ d ∈ days, d0 ≤ d) (hgt : hi < d0) :
    days.filter (fun d => decide (lo ≤ d) && decide (d ≤ hi)) = [] := by
  induction days with
  | nil => simp
  | cons d ds ih =>
    have h1 : (([d].filter (fun e => decide (lo ≤ e) && decide (e ≤ hi)))) = [] := by
      apply filter_singleton_false'
      simp only [Bool.and_eq_true, decide_eq_true_eq]
      intro hcon
      have h0 := hge d List.mem_cons_self
      omega
    have hcons : d :: ds = [d] ++ ds := rfl
    rw [hcons, List.filter_append, h1, List.nil_append]
    exact ih (fun e he => hge e (List.mem_cons_of_mem _ he))

/-- The lower bound of a tail with nothing below `lo` is zero. -/
theorem lowerBound_zero_of_all_ge (days : List Int) (lo d0 : Int)
    (hge : ∀ d ∈ days, d0 ≤ d) (hlo : lo ≤ d0)
    (hsorted : days.Pairwise (· ≤ ·)) :
    lowerBound days lo = 0 := by
  have h0 : (days.filter (fun e => decide (e < lo))).length = 0 :=
    filter_lt_none_of_ge days lo d0 hge hlo
  have hc := lowerBound_count days lo hsorted
  omega

/-- **The slice is exactly the bars whose days lie in the window.** -/
theorem sliceIdx_eq_filter (days : List Int) (a b : Int)
    (hsorted : days.Pairwise (· ≤ ·)) :
    (days.drop (sliceIdx days a b).1).take ((sliceIdx days a b).2 - (sliceIdx days a b).1)
      = days.filter (fun d => decide (min a b ≤ d) && decide (d ≤ max a b)) := by
  have hlo : min a b ≤ max a b := by omega
  induction days with
  | nil =>
    simp [sliceIdx, lowerBound, upperBound]
  | cons d ds ih =>
    have htail := pairwise_tail hsorted
    have hds := ih htail
    simp only [sliceIdx] at hds
    by_cases h1 : d < min a b
    · have hlb : lowerBound (d :: ds) (min a b) = lowerBound ds (min a b) + 1 := by
        simp only [lowerBound, ifNeg (by omega : ¬ min a b ≤ d)]
      have hub : upperBound (d :: ds) (max a b) = upperBound ds (max a b) + 1 := by
        have hle : d ≤ max a b := by omega
        simp only [upperBound, ifPos hle]
      have hslice : sliceIdx (d :: ds) a b
          = (lowerBound ds (min a b) + 1, upperBound ds (max a b) + 1) := by
        simp only [sliceIdx, hlb, hub]
      rw [hslice]
      simp only [List.drop_succ_cons]
      have hsub : upperBound ds (max a b) + 1 - (lowerBound ds (min a b) + 1)
          = upperBound ds (max a b) - lowerBound ds (min a b) := by omega
      rw [hsub, hds]
      have h1single : (([d].filter
          (fun e => decide (min a b ≤ e) && decide (e ≤ max a b)))) = [] := by
        apply filter_singleton_false'
        simp only [Bool.and_eq_true, decide_eq_true_eq]
        intro hcon
        omega
      have hcons : d :: ds = [d] ++ ds := rfl
      rw [hcons, List.filter_append, h1single, List.nil_append]
    · by_cases h2 : d ≤ max a b
      · have hlo_d : min a b ≤ d := by omega
        have hlb : lowerBound (d :: ds) (min a b) = 0 := by
          simp only [lowerBound, ifPos hlo_d]
        have hub : upperBound (d :: ds) (max a b) = upperBound ds (max a b) + 1 := by
          simp only [upperBound, ifPos h2]
        -- Everything in the tail is at least `d ≥ lo`: no below-lo prefix.
        have hlbds : lowerBound ds (min a b) = 0 :=
          lowerBound_zero_of_all_ge ds (min a b) d
            (pairwise_head_rel hsorted) hlo_d htail
        have hslice : sliceIdx (d :: ds) a b = (0, upperBound ds (max a b) + 1) := by
          simp only [sliceIdx, hlb, hub]
        rw [hslice]
        simp only [List.drop_zero]
        have hsub : upperBound ds (max a b) + 1 - 0 = upperBound ds (max a b) + 1 := by
          omega
        rw [hsub, List.take_succ_cons]
        have hpred : (decide (min a b ≤ d) && decide (d ≤ max a b)) = true := by
          simp only [Bool.and_eq_true, decide_eq_true_eq]
          exact ⟨hlo_d, h2⟩
        have h1single : (([d].filter
            (fun e => decide (min a b ≤ e) && decide (e ≤ max a b)))) = [d] := by
          apply filter_singleton_true'
          exact hpred
        have hcons : d :: ds = [d] ++ ds := rfl
        rw [hcons, List.filter_append, h1single]
        have htake : ds.take (upperBound ds (max a b))
            = (ds.drop (lowerBound ds (min a b))).take
                (upperBound ds (max a b) - lowerBound ds (min a b)) := by
          rw [hlbds]
          simp
        rw [htake, hds, List.cons_append, List.nil_append]
      · have hgt : max a b < d := by omega
        have hlb : lowerBound (d :: ds) (min a b) = 0 := by
          have hlo_d : min a b ≤ d := by omega
          simp only [lowerBound, ifPos hlo_d]
        have hub : upperBound (d :: ds) (max a b) = 0 := by
          simp only [upperBound, ifNeg h2]
        have hslice : sliceIdx (d :: ds) a b = (0, 0) := by
          simp only [sliceIdx, hlb, hub]
        rw [hslice]
        simp only [List.drop_zero]
        have hsub : (0 : Nat) - 0 = 0 := by omega
        rw [hsub, List.take_zero]
        have hge : ∀ e ∈ d :: ds, d ≤ e := by
          intro e he
          rw [List.mem_cons] at he
          cases he with
          | inl heq =>
            rw [heq]
            omega
          | inr hm => exact pairwise_head_rel hsorted e hm
        have hcons : d :: ds = [d] ++ ds := rfl
        rw [hcons]
        exact (filter_window_none_of_gt ([d] ++ ds) (min a b) (max a b) d
          hge hgt).symm

/-! ## Moving average shape -/

/-- Null-prefix mask: entry `i` (0-based from `i`) is set once `period ≤ i+1`. -/
def maMaskAux : List Nat → Nat → Nat → List Bool
  | [], _, _ => []
  | _ :: xs, p, i => decide (p ≤ i + 1) :: maMaskAux xs p (i + 1)

def maMask (xs : List Nat) (p : Nat) : List Bool := maMaskAux xs p 0

/-- The mask preserves the length. -/
theorem maMaskAux_length (xs : List Nat) (p i : Nat) :
    (maMaskAux xs p i).length = xs.length := by
  induction xs generalizing i with
  | nil => simp [maMaskAux]
  | cons _ _ ih =>
    simp only [maMaskAux, List.length_cons]
    rw [ih]

/-- **The mask is `period − 1` leading `false` then `true`.** -/
theorem maMaskAux_shape (xs : List Nat) (p i : Nat) :
    maMaskAux xs p i
      = List.replicate (min (p - i - 1) xs.length) false
        ++ List.replicate (xs.length - (p - i - 1)) true := by
  induction xs generalizing i with
  | nil =>
    have h1 : min (p - i - 1) 0 = 0 := by omega
    have h2 : 0 - (p - i - 1) = 0 := Nat.zero_sub _
    simp only [maMaskAux, List.length_nil, h1, h2, List.replicate_zero, List.append_nil]
  | cons _ xs ih =>
    simp only [maMaskAux, List.length_cons]
    by_cases h : p ≤ i + 1
    · have e : decide (p ≤ i + 1) = true := decide_eq_true_eq.mpr h
      rw [e]
      have hz : p - i - 1 = 0 := by omega
      have hz2 : p - (i + 1) - 1 = 0 := by omega
      rw [hz, ih, hz2]
      have m1 : min (0 : Nat) xs.length = 0 := by omega
      have m2 : min (0 : Nat) (xs.length + 1) = 0 := by omega
      rw [m1, m2]
      simp only [Nat.sub_zero, List.replicate_zero, List.nil_append, List.replicate_succ]
    · have e : decide (p ≤ i + 1) = false := decide_eq_false_iff_not.mpr (by omega)
      rw [e]
      have hk : 1 ≤ p - i - 1 := by omega
      have hmin : min (p - i - 1) (xs.length + 1)
          = min (p - (i + 1) - 1) xs.length + 1 := by omega
      have hlen : xs.length + 1 - (p - i - 1)
          = xs.length - (p - (i + 1) - 1) := by omega
      rw [ih, hmin, hlen, List.replicate_succ, List.cons_append]

/-- **The moving-average output keeps the input length.** -/
theorem maMask_length (xs : List Nat) (p : Nat) :
    (maMask xs p).length = xs.length := by
  unfold maMask
  exact maMaskAux_length xs p 0

end Research
