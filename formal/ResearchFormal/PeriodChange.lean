import ResearchFormal.ChartWindow

/-!
# Change against an earlier date: 前月比 and 前年比

Formal model of `changeOverMonths` in `packages/domain/src/market/changes.ts`
(the indicator table's 1-month change and every widget's 1-year change).

A series is a list of observations, each a day number and a value; the last
one is the latest. The mark is the latest day `months` calendar months back
with the day clamped — `subMonthsDay`, the twin of the chart viewer's month
stepping that the `chartPreset` vectors already tie to the TypeScript. The
base is the newest earlier observation (by position: the code scans them
from the second-to-last backwards) dated on or before the mark. The change
has no value when there is no such observation (`noBase`) or when the base
lies more than `tol` days before the mark (`baseTooOld`).

Values are integers: the code only subtracts and divides them, in floating
point, which unit tests cover (with the non-finite cases); this model fixes
which two observations are compared. Proved:

* `ok_latest` — the compared latest observation is the last one;
* `ok_base` — the base is an earlier observation on or before the mark,
  within `tol` days of it, and every observation after it (except the
  latest) is after the mark;
* `ok_base_newest` — so in a date-ascending series the base is the newest
  earlier observation on or before the mark;
* `noBase_iff` — `noBase` exactly when every earlier observation is after the
  mark;
* `previous_is_base` — when the previous observation is on or before the
  mark and within `tol`, it is the base: for a monthly series dated on the
  same day of each month, 前月比 is the change against the previous
  observation.

`formal/Export.lean` evaluates `periodChange` over small series around month
ends and leap days; `tests/formal/periodChange.conformance.test.ts` replays
them against the TypeScript through real ISO dates.
-/

namespace Research.PeriodChange

/-- One observation: its day number (days since 1970-01-01) and its value. -/
structure Pt where
  day : Int
  val : Int
  deriving DecidableEq, Repr

/-- Why there is no change (the TypeScript's `PeriodChangeError`, without `NON_FINITE`). -/
inductive Err where
  | noBase
  | baseTooOld
  deriving DecidableEq, Repr

/-- The first point of `ps` on or before `mark`. The code scans the earlier
    observations newest first, so `ps` is their reverse. -/
def findBase (mark : Int) : List Pt → Option Pt
  | [] => none
  | p :: ps => if p.day ≤ mark then some p else findBase mark ps

/-- The change's base and latest observation, or why there is none. -/
def periodChange (pts : List Pt) (months : Nat) (tol : Int) : Except Err (Pt × Pt) :=
  match pts.getLast? with
  | none => .error .noBase
  | some latest =>
    match findBase (subMonthsDay latest.day months) pts.dropLast.reverse with
    | none => .error .noBase
    | some b =>
      if subMonthsDay latest.day months - b.day ≤ tol then .ok (b, latest)
      else .error .baseTooOld

theorem findBase_some {mark : Int} :
    ∀ {ps : List Pt} {b : Pt}, findBase mark ps = some b →
      ∃ pre post, ps = pre ++ b :: post ∧ b.day ≤ mark ∧ ∀ q ∈ pre, mark < q.day
  | [], _, h => by simp [findBase] at h
  | p :: ps, b, h => by
    unfold findBase at h
    by_cases hp : p.day ≤ mark
    · simp only [hp, ↓reduceIte, Option.some.injEq] at h
      subst h
      exact ⟨[], ps, by simp, hp, by simp⟩
    · simp only [hp, ↓reduceIte] at h
      obtain ⟨pre, post, hps, hb, hpre⟩ := findBase_some h
      refine ⟨p :: pre, post, by simp [hps], hb, ?_⟩
      intro q hq
      simp only [List.mem_cons] at hq
      rcases hq with rfl | hq
      · exact Int.not_le.mp hp
      · exact hpre q hq

theorem findBase_none_iff {mark : Int} :
    ∀ {ps : List Pt}, findBase mark ps = none ↔ ∀ q ∈ ps, mark < q.day
  | [] => by simp [findBase]
  | p :: ps => by
    unfold findBase
    by_cases hp : p.day ≤ mark
    · simp only [hp, ↓reduceIte, reduceCtorEq, false_iff, List.mem_cons, forall_eq_or_imp, not_and]
      intro h
      exact absurd hp (Int.not_le_of_gt h)
    · simp only [hp, ↓reduceIte, List.mem_cons, forall_eq_or_imp]
      rw [findBase_none_iff]
      exact ⟨fun h => ⟨Int.not_le.mp hp, h⟩, fun h => h.2⟩

/-- Unfolds a successful result into the facts it rests on. -/
theorem ok_cases {pts : List Pt} {months : Nat} {tol : Int} {b l : Pt}
    (h : periodChange pts months tol = .ok (b, l)) :
    pts.getLast? = some l ∧
      findBase (subMonthsDay l.day months) pts.dropLast.reverse = some b ∧
      subMonthsDay l.day months - b.day ≤ tol := by
  unfold periodChange at h
  split at h
  · simp at h
  · rename_i latest hlast
    split at h
    · simp at h
    · rename_i b' hfind
      by_cases ht : subMonthsDay latest.day months - b'.day ≤ tol
      · simp only [ht, ↓reduceIte, Except.ok.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        exact ⟨hlast, hfind, ht⟩
      · simp [ht] at h

theorem ok_latest {pts : List Pt} {months : Nat} {tol : Int} {b l : Pt}
    (h : periodChange pts months tol = .ok (b, l)) : pts.getLast? = some l :=
  (ok_cases h).1

theorem ok_base {pts : List Pt} {months : Nat} {tol : Int} {b l : Pt}
    (h : periodChange pts months tol = .ok (b, l)) :
    ∃ pre post, pts.dropLast = pre ++ b :: post ∧
      b.day ≤ subMonthsDay l.day months ∧
      subMonthsDay l.day months - b.day ≤ tol ∧
      ∀ q ∈ post, subMonthsDay l.day months < q.day := by
  obtain ⟨_, hfind, htol⟩ := ok_cases h
  obtain ⟨pre, post, hrev, hb, hpre⟩ := findBase_some hfind
  refine ⟨post.reverse, pre.reverse, ?_, hb, htol, ?_⟩
  · have := congrArg List.reverse hrev
    simpa using this
  · intro q hq
    exact hpre q (List.mem_reverse.mp hq)

theorem ok_base_newest {pts : List Pt} {months : Nat} {tol : Int} {b l : Pt}
    (hsorted : pts.Pairwise (fun p q => p.day ≤ q.day))
    (h : periodChange pts months tol = .ok (b, l)) :
    ∀ q ∈ pts.dropLast, q.day ≤ subMonthsDay l.day months → q.day ≤ b.day := by
  obtain ⟨pre, post, hsplit, _, _, hpost⟩ := ok_base h
  have hs : (pre ++ b :: post).Pairwise (fun p q => p.day ≤ q.day) := by
    rw [← hsplit]
    exact hsorted.sublist (List.dropLast_sublist pts)
  intro q hq hle
  rw [hsplit] at hq
  rcases List.mem_append.mp hq with hpre | hrest
  · exact (List.pairwise_append.mp hs).2.2 q hpre b (List.mem_cons_self ..)
  · rcases List.mem_cons.mp hrest with rfl | hpost'
    · exact Int.le_refl _
    · exact absurd hle (Int.not_le_of_gt (hpost q hpost'))

theorem noBase_iff {pts : List Pt} {months : Nat} {tol : Int} {l : Pt}
    (hlast : pts.getLast? = some l) :
    periodChange pts months tol = .error .noBase ↔
      ∀ q ∈ pts.dropLast, subMonthsDay l.day months < q.day := by
  unfold periodChange
  rw [hlast]
  simp only
  constructor
  · intro h
    split at h
    · rename_i hnone
      intro q hq
      exact (findBase_none_iff.mp hnone) q (List.mem_reverse.mpr hq)
    · split at h <;> simp at h
  · intro h
    have hnone : findBase (subMonthsDay l.day months) pts.dropLast.reverse = none :=
      findBase_none_iff.mpr fun q hq => h q (List.mem_reverse.mp hq)
    rw [hnone]

theorem previous_is_base {init : List Pt} {p l : Pt} {months : Nat} {tol : Int}
    (hle : p.day ≤ subMonthsDay l.day months)
    (htol : subMonthsDay l.day months - p.day ≤ tol) :
    periodChange (init ++ [p, l]) months tol = .ok (p, l) := by
  have hlast : (init ++ [p, l]).getLast? = some l := by simp
  have hdrop : (init ++ [p, l]).dropLast = init ++ [p] := by
    rw [show init ++ [p, l] = (init ++ [p]) ++ [l] by simp, List.dropLast_concat]
  unfold periodChange
  rw [hlast]
  simp only
  rw [hdrop]
  simp only [List.reverse_append, List.reverse_cons, List.reverse_nil, List.nil_append,
    List.cons_append]
  unfold findBase
  simp [hle, htol]

end Research.PeriodChange
