/-!
# Incremental history refresh (ADR-0044 §3)

Formal model of `packages/domain/src/market/historyRefresh.ts`:
`historyRefreshRequest`, `firstHistoryFetch`, `anchorConfirmed`,
`historyOutcome` and `mergeHistory`.

Dates are abstracted to `Nat` (the code's `YYYY-MM-DD` strings order as text,
which is the order of the day numbers), values to `Int` (the code compares
values only for equality), instants to `Int` milliseconds. Point lists are
*ascending and date-unique* where the code requires it (`Ascending`); the
adapters guarantee it for every answer and the database for every stored
series.

`confirmed` states what the code's binary search computes on such a list (the
anchor's date is present with exactly the anchor's value); the conformance
vectors replay it through the real binary search.

The results:

- `fetched_mem_mergeKept` — every fetched point is in the merge result with
  its fetched value (before trimming to the newest `maxStored`);
- `stored_survives` and its corollaries — a stored point the write does not
  replace and the answer does not hold survives unchanged; with a null write
  every stored point survives (`null_write_keeps_stored`,
  `null_write_keeps_dates`); a stored point older than `replaceFrom` survives
  (`older_than_replaceFrom_survives`), unconditionally for the full write an
  outcome builds (`outcome_full_keeps_older`);
- `replaced_only_if_fetched` — no stored point on or after `replaceFrom`
  (any, for a full write without a date) survives unless fetched;
- `ascending_mergeHistory` — the result is strictly ascending by date, so one
  row per date;
- `window_replaceFrom_fetched`, `full_replaceFrom_fetched` — a write's
  `replaceFrom` is a fetched date (what the completion contract demands), and
  `window_replaceFrom_is_fetch_start` — a window write replaces from the date
  the window was asked from; `empty_answer_replaces_nothing` — an empty answer
  never replaces anything;
- `refetch_only_after_window`, `full_fetch_stores` — a full fetch never asks
  for another, so a series costs at most two provider requests;
- `keeping_write_needs_confirmed_anchor` (and `keeping_write_needs_unchanged_anchor`,
  with the value spelled out by `confirmed_iff`) — a write that keeps older
  stored rows is stored only when the claim had an anchor and the answer
  reproduced it with exactly its value, so adjusted and unadjusted history
  never mix; contrapositively a non-empty full answer that does not reproduce
  the anchor replaces everything (`unconfirmed_anchor_replaces_everything`),
  and a window that does not reproduce it stores nothing but asks for the
  full history (`unconfirmed_anchor_window_refetches`).
-/

namespace Research.HistoryRefresh

structure Point where
  date : Nat
  value : Int
  deriving DecidableEq, Repr

/-- The claim for one series: the anchor (or none stored) and whether a full check is due. -/
structure Request where
  anchor : Option Point
  fullCheck : Bool
  deriving DecidableEq, Repr

/-- The provider request: from a date (inclusive), or everything. -/
inductive Fetch where
  | window (fromDate : Nat)
  | full
  deriving DecidableEq, Repr

/-- `HistoryWrite`: `window r` and `full (some r)` replace from `r`, `full none` everything. -/
inductive Write where
  | window (replaceFrom : Nat)
  | full (replaceFrom : Option Nat)
  deriving DecidableEq, Repr

inductive Outcome where
  | store (write : Option Write)
  | refetchFull
  deriving DecidableEq, Repr

/-- `HISTORY_FULL_CHECK_DAYS` (7) in milliseconds. -/
def fullCheckPeriodMs : Int := 7 * 86400000

/--
`historyRefreshRequest`: no anchor → nothing to check; never fully fetched →
due; otherwise due once the last full fetch is at least the period old (a
stamp in the future is not due). The code's non-finite stamp is `none` here.
-/
def request (anchor : Option Point) (checkedAt : Option Int) (now : Int) : Request :=
  match anchor with
  | none => { anchor := none, fullCheck := false }
  | some a =>
    { anchor := some a,
      fullCheck := match checkedAt with
        | none => true
        | some t => decide (fullCheckPeriodMs ≤ now - t) }

/-- `firstHistoryFetch`. -/
def firstFetch (r : Request) : Fetch :=
  match r.anchor with
  | some a => if r.fullCheck then .full else .window a.date
  | none => .full

/-- `anchorConfirmed`: the answer holds the anchor's date with exactly its value. -/
def confirmed (a : Point) (ps : List Point) : Bool :=
  ps.any fun p => p.date == a.date && p.value == a.value

/-- `historyOutcome`. -/
def outcome (r : Request) (f : Fetch) (ps : List Point) : Outcome :=
  match f with
  | .window _ =>
    match r.anchor with
    | some a => if confirmed a ps then .store (some (.window a.date)) else .refetchFull
    | none => .refetchFull
  | .full =>
    match ps with
    | [] => .store none
    | p :: _ =>
      match r.anchor with
      | some a =>
        if confirmed a ps then .store (some (.full (some p.date))) else .store (some (.full none))
      | none => .store (some (.full none))

/-- True when the write replaces the stored row dated `d` (whether or not the answer holds it). -/
def replaces : Option Write → Nat → Bool
  | none, _ => false
  | some (.window r), d => decide (r ≤ d)
  | some (.full none), _ => true
  | some (.full (some r)), d => decide (r ≤ d)

/-- The code's `kept` filter: a stored row stays unless the answer holds its date or the write replaces it. -/
def keep (w : Option Write) (fetched : List Point) (p : Point) : Bool :=
  !(fetched.any fun q => q.date == p.date) && !(replaces w p.date)

/-- The code's two-pointer merge: the kept row first when it is strictly older. -/
def mergeSorted : List Point → List Point → List Point
  | [], ys => ys
  | x :: xs, [] => x :: xs
  | x :: xs, y :: ys =>
    if x.date < y.date then x :: mergeSorted xs (y :: ys) else y :: mergeSorted (x :: xs) ys
termination_by xs ys => xs.length + ys.length

def mergeKept (stored fetched : List Point) (w : Option Write) : List Point :=
  mergeSorted (stored.filter (keep w fetched)) fetched

/-- The newest `max` rows (`slice(length - max)` when longer). -/
def trim (max : Nat) (l : List Point) : List Point := l.drop (l.length - max)

/-- `mergeHistory`. -/
def mergeHistory (stored fetched : List Point) (w : Option Write) (max : Nat) : List Point :=
  trim max (mergeKept stored fetched w)

def Ascending (l : List Point) : Prop := l.Pairwise fun a b => a.date < b.date

/-! ## The merge -/

theorem mem_mergeSorted (z : Point) :
    ∀ xs ys : List Point, z ∈ mergeSorted xs ys ↔ z ∈ xs ∨ z ∈ ys
  | [], ys => by simp [mergeSorted]
  | x :: xs, [] => by simp [mergeSorted]
  | x :: xs, y :: ys => by
    unfold mergeSorted
    split
    · have ih := mem_mergeSorted z xs (y :: ys)
      simp only [List.mem_cons] at ih ⊢
      rw [ih, or_assoc]
    · have ih := mem_mergeSorted z (x :: xs) ys
      simp only [List.mem_cons] at ih ⊢
      rw [ih]
      exact or_left_comm
termination_by xs ys => xs.length + ys.length

theorem ascending_mergeSorted :
    ∀ xs ys : List Point, Ascending xs → Ascending ys →
      (∀ x ∈ xs, ∀ y ∈ ys, x.date ≠ y.date) → Ascending (mergeSorted xs ys)
  | [], ys, _, hy, _ => by simpa [mergeSorted] using hy
  | x :: xs, [], hx, _, _ => by simpa [mergeSorted] using hx
  | x :: xs, y :: ys, hx, hy, hd => by
    unfold Ascending at hx hy
    rw [List.pairwise_cons] at hx hy
    unfold mergeSorted
    split
    · rename_i hlt
      have rest : Ascending (mergeSorted xs (y :: ys)) :=
        ascending_mergeSorted xs (y :: ys) hx.2 (List.pairwise_cons.mpr hy)
          (fun a ha b hb => hd a (List.mem_cons_of_mem x ha) b hb)
      refine List.pairwise_cons.mpr ⟨?_, rest⟩
      intro z hz
      rcases (mem_mergeSorted z xs (y :: ys)).mp hz with hz | hz
      · exact hx.1 z hz
      · rcases List.mem_cons.mp hz with rfl | hz
        · exact hlt
        · exact Nat.lt_trans hlt (hy.1 z hz)
    · rename_i hge
      have hne : x.date ≠ y.date := hd x (List.mem_cons_self) y (List.mem_cons_self)
      have hlt : y.date < x.date := by omega
      have rest : Ascending (mergeSorted (x :: xs) ys) :=
        ascending_mergeSorted (x :: xs) ys (List.pairwise_cons.mpr hx) hy.2
          (fun a ha b hb => hd a ha b (List.mem_cons_of_mem y hb))
      refine List.pairwise_cons.mpr ⟨?_, rest⟩
      intro z hz
      rcases (mem_mergeSorted z (x :: xs) ys).mp hz with hz | hz
      · rcases List.mem_cons.mp hz with rfl | hz
        · exact hlt
        · exact Nat.lt_trans hlt (hx.1 z hz)
      · exact hy.1 z hz
termination_by xs ys => xs.length + ys.length

theorem mem_mergeKept (z : Point) (stored fetched : List Point) (w : Option Write) :
    z ∈ mergeKept stored fetched w ↔ (z ∈ stored ∧ keep w fetched z = true) ∨ z ∈ fetched := by
  unfold mergeKept
  rw [mem_mergeSorted, List.mem_filter]

theorem keep_iff (w : Option Write) (fetched : List Point) (p : Point) :
    keep w fetched p = true ↔ (∀ q ∈ fetched, q.date ≠ p.date) ∧ replaces w p.date = false := by
  unfold keep
  simp

/-- (a) Every fetched point is stored with its fetched value. -/
theorem fetched_mem_mergeKept (stored fetched : List Point) (w : Option Write) (p : Point)
    (h : p ∈ fetched) : p ∈ mergeKept stored fetched w :=
  (mem_mergeKept p stored fetched w).mpr (Or.inr h)

/-- (b) A stored point the write does not replace and the answer does not hold survives unchanged. -/
theorem stored_survives (stored fetched : List Point) (w : Option Write) (p : Point)
    (hp : p ∈ stored) (hf : ∀ q ∈ fetched, q.date ≠ p.date) (hr : replaces w p.date = false) :
    p ∈ mergeKept stored fetched w :=
  (mem_mergeKept p stored fetched w).mpr (Or.inl ⟨hp, (keep_iff w fetched p).mpr ⟨hf, hr⟩⟩)

/-- (b) With a null write (a plain merge) every stored point the answer does not hold survives unchanged. -/
theorem null_write_keeps_stored (stored fetched : List Point) (p : Point) (hp : p ∈ stored)
    (hf : ∀ q ∈ fetched, q.date ≠ p.date) : p ∈ mergeKept stored fetched none :=
  stored_survives stored fetched none p hp hf rfl

/-- (b) With a null write no stored date disappears (the answer may only change its value). -/
theorem null_write_keeps_dates (stored fetched : List Point) (p : Point) (hp : p ∈ stored) :
    ∃ q ∈ mergeKept stored fetched none, q.date = p.date := by
  by_cases h : ∃ q ∈ fetched, q.date = p.date
  · obtain ⟨q, hq, hd⟩ := h
    exact ⟨q, fetched_mem_mergeKept stored fetched none q hq, hd⟩
  · refine ⟨p, null_write_keeps_stored stored fetched p hp ?_, rfl⟩
    intro q hq hd
    exact h ⟨q, hq, hd⟩

/-- (b) A stored point older than `replaceFrom` that the answer does not hold survives unchanged. -/
theorem older_than_replaceFrom_survives (stored fetched : List Point) (p : Point) (r : Nat)
    (w : Write) (hw : w = .window r ∨ w = .full (some r)) (hp : p ∈ stored) (hlt : p.date < r)
    (hf : ∀ q ∈ fetched, q.date ≠ p.date) : p ∈ mergeKept stored fetched (some w) := by
  apply stored_survives stored fetched (some w) p hp hf
  rcases hw with rfl | rfl <;> simp [replaces] <;> omega

/-- (c) No stored point the write replaces survives unless the answer holds it. -/
theorem replaced_only_if_fetched (stored fetched : List Point) (w : Option Write) (p : Point)
    (hp : p ∈ mergeKept stored fetched w) (hr : replaces w p.date = true) : p ∈ fetched := by
  rcases (mem_mergeKept p stored fetched w).mp hp with ⟨_, hk⟩ | hf
  · have := ((keep_iff w fetched p).mp hk).2
    rw [hr] at this
    contradiction
  · exact hf

theorem ascending_filter (l : List Point) (f : Point → Bool) (h : Ascending l) :
    Ascending (l.filter f) :=
  List.Pairwise.filter f h

theorem ascending_drop (l : List Point) (n : Nat) (h : Ascending l) : Ascending (l.drop n) :=
  List.Pairwise.sublist (List.drop_sublist n l) h

/-- (d) The stored result is strictly ascending by date: one row per date. -/
theorem ascending_mergeHistory (stored fetched : List Point) (w : Option Write) (max : Nat)
    (hs : Ascending stored) (hf : Ascending fetched) :
    Ascending (mergeHistory stored fetched w max) := by
  unfold mergeHistory trim mergeKept
  apply ascending_drop
  apply ascending_mergeSorted _ _ (ascending_filter stored _ hs) hf
  intro x hx y hy hxy
  have hk := (List.mem_filter.mp hx).2
  exact ((keep_iff w fetched x).mp hk).1 y hy hxy.symm

/-- Trimming keeps the newest rows: the result is the merge minus its oldest rows. -/
theorem mergeHistory_suffix (stored fetched : List Point) (w : Option Write) (max : Nat) :
    mergeHistory stored fetched w max <:+ mergeKept stored fetched w :=
  List.drop_suffix _ _

/-! ## The outcome -/

theorem confirmed_mem (a : Point) (ps : List Point) (h : confirmed a ps = true) :
    ∃ p ∈ ps, p.date = a.date := by
  unfold confirmed at h
  obtain ⟨p, hp, he⟩ := List.any_eq_true.mp h
  simp only [Bool.and_eq_true, beq_iff_eq] at he
  exact ⟨p, hp, he.1⟩

/-- (e) A window write replaces from a fetched date (the anchor's). -/
theorem window_replaceFrom_fetched (r : Request) (f : Fetch) (ps : List Point) (d : Nat)
    (h : outcome r f ps = .store (some (.window d))) : ∃ p ∈ ps, p.date = d := by
  cases f with
  | full =>
    cases ps with
    | nil => simp [outcome] at h
    | cons p t =>
      cases ha : r.anchor with
      | none => simp [outcome, ha] at h
      | some a =>
        simp only [outcome, ha] at h
        split at h <;> simp at h
  | window e =>
    cases ha : r.anchor with
    | none => simp [outcome, ha] at h
    | some a =>
      simp only [outcome, ha] at h
      split at h
      · rename_i hc
        simp only [Outcome.store.injEq, Option.some.injEq, Write.window.injEq] at h
        subst h
        exact confirmed_mem a ps hc
      · simp at h

/-- (e) A full write with a date replaces from a fetched date (the oldest fetched). -/
theorem full_replaceFrom_fetched (r : Request) (f : Fetch) (ps : List Point) (d : Nat)
    (h : outcome r f ps = .store (some (.full (some d)))) : ∃ p ∈ ps, p.date = d := by
  cases f with
  | window e =>
    cases ha : r.anchor with
    | none => simp [outcome, ha] at h
    | some a =>
      simp only [outcome, ha] at h
      split at h <;> simp at h
  | full =>
    cases ps with
    | nil => simp [outcome] at h
    | cons p t =>
      cases ha : r.anchor with
      | none => simp [outcome, ha] at h
      | some a =>
        simp only [outcome, ha] at h
        split at h
        · simp only [Outcome.store.injEq, Option.some.injEq, Write.full.injEq] at h
          exact ⟨p, List.mem_cons_self, h⟩
        · simp at h

/-- (e) The first window write replaces from exactly the date the window was asked from. -/
theorem window_replaceFrom_is_fetch_start (r : Request) (ps : List Point) (d e : Nat)
    (hf : firstFetch r = .window e) (h : outcome r (firstFetch r) ps = .store (some (.window d))) :
    d = e := by
  rw [hf] at h
  cases ha : r.anchor with
  | none => simp [firstFetch, ha] at hf
  | some a =>
    cases hc : r.fullCheck with
    | true => simp [firstFetch, ha, hc] at hf
    | false =>
      simp only [firstFetch, ha, hc, Bool.false_eq_true, ↓reduceIte, Fetch.window.injEq] at hf
      simp only [outcome, ha] at h
      split at h
      · simp only [Outcome.store.injEq, Option.some.injEq, Write.window.injEq] at h
        omega
      · simp at h

/-- (e) An empty answer never replaces anything: a plain merge, or a request for more. -/
theorem empty_answer_replaces_nothing (r : Request) (f : Fetch) :
    outcome r f [] = .store none ∨ outcome r f [] = .refetchFull := by
  unfold outcome confirmed
  cases f with
  | window _ => cases r.anchor <;> simp
  | full => simp

/-- (f) Only a window fetch asks for the full history. -/
theorem refetch_only_after_window (r : Request) (f : Fetch) (ps : List Point)
    (h : outcome r f ps = .refetchFull) : ∃ d, f = .window d := by
  cases f with
  | window d => exact ⟨d, rfl⟩
  | full =>
    cases ps with
    | nil => simp [outcome] at h
    | cons p t =>
      cases ha : r.anchor with
      | none => simp [outcome, ha] at h
      | some a =>
        simp only [outcome, ha] at h
        split at h <;> simp at h

/-- (f) A full fetch always stores: a series costs at most two provider requests. -/
theorem full_fetch_stores (r : Request) (ps : List Point) :
    ∃ w, outcome r .full ps = .store w := by
  cases h : outcome r .full ps with
  | store w => exact ⟨w, rfl⟩
  | refetchFull => exact absurd (refetch_only_after_window r .full ps h) (by simp)

/-- A window is asked only from a stored anchor's date, and never on a due full check. -/
theorem firstFetch_window (r : Request) (d : Nat) (h : firstFetch r = .window d) :
    ∃ a, r.anchor = some a ∧ a.date = d ∧ r.fullCheck = false := by
  cases ha : r.anchor with
  | none => simp [firstFetch, ha] at h
  | some a =>
    cases hc : r.fullCheck with
    | true => simp [firstFetch, ha, hc] at h
    | false =>
      simp only [firstFetch, ha, hc, Bool.false_eq_true, ↓reduceIte, Fetch.window.injEq] at h
      exact ⟨a, rfl, h, rfl⟩

/-- A claim without an anchor is never a full check (the contract refuses one). -/
theorem request_no_anchor (c : Option Int) (now : Int) : (request none c now).fullCheck = false :=
  rfl

theorem ascending_head_le (p : Point) (rest : List Point) (h : Ascending (p :: rest)) :
    ∀ q ∈ p :: rest, p.date ≤ q.date := by
  intro q hq
  rcases List.mem_cons.mp hq with rfl | hq
  · exact Nat.le_refl _
  · exact Nat.le_of_lt ((List.pairwise_cons.mp h).1 q hq)

/--
(b) For the full write an outcome builds, every stored point older than its
`replaceFrom` survives unchanged: the answer is ascending, so it holds no
date older than its oldest.
-/
theorem outcome_full_keeps_older (r : Request) (f : Fetch) (stored ps : List Point) (d : Nat)
    (hps : Ascending ps) (h : outcome r f ps = .store (some (.full (some d)))) (p : Point)
    (hp : p ∈ stored) (hlt : p.date < d) : p ∈ mergeKept stored ps (some (.full (some d))) := by
  have head : ∃ q t, ps = q :: t ∧ q.date = d := by
    cases f with
    | window e =>
      cases ha : r.anchor with
      | none => simp [outcome, ha] at h
      | some a =>
        simp only [outcome, ha] at h
        split at h <;> simp at h
    | full =>
      cases ps with
      | nil => simp [outcome] at h
      | cons q t =>
        cases ha : r.anchor with
        | none => simp [outcome, ha] at h
        | some a =>
          simp only [outcome, ha] at h
          split at h
          · simp only [Outcome.store.injEq, Option.some.injEq, Write.full.injEq] at h
            exact ⟨q, t, rfl, h⟩
          · simp at h
  obtain ⟨q, t, rfl, hq⟩ := head
  apply older_than_replaceFrom_survives stored _ p d _ (Or.inr rfl) hp hlt
  intro x hx hxp
  have := ascending_head_le q t hps x hx
  omega

/-! ## Adjusted and unadjusted history never mix

ADR-0044's central safety claim: stored rows older than the answer are kept
only when the anchor came back with exactly its stored value. A write that
keeps stored rows is `window r` or `full (some r)`; `full none` replaces
everything and `none` (an empty answer) changes no stored row's date.
-/

/-- `confirmed` is exactly "the answer holds the anchor's date with the anchor's value". -/
theorem confirmed_iff (a : Point) (ps : List Point) :
    confirmed a ps = true ↔ ∃ p ∈ ps, p.date = a.date ∧ p.value = a.value := by
  unfold confirmed
  simp [List.any_eq_true]

/--
Whenever an outcome stores a write that keeps older stored rows (a window
write, or a full write with a `replaceFrom` date), the claim had an anchor and
the answer reproduced it: same date, same value.
-/
theorem keeping_write_needs_confirmed_anchor (r : Request) (f : Fetch) (ps : List Point)
    (w : Write) (d : Nat) (hw : w = .window d ∨ w = .full (some d))
    (h : outcome r f ps = .store (some w)) :
    ∃ a, r.anchor = some a ∧ confirmed a ps = true := by
  cases f with
  | window e =>
    cases ha : r.anchor with
    | none => simp [outcome, ha] at h
    | some a =>
      simp only [outcome, ha] at h
      split at h
      · rename_i hc
        exact ⟨a, rfl, hc⟩
      · simp at h
  | full =>
    cases ps with
    | nil => simp [outcome] at h
    | cons p t =>
      cases ha : r.anchor with
      | none =>
        simp only [outcome, ha, Outcome.store.injEq, Option.some.injEq] at h
        subst h
        rcases hw with hw | hw <;> simp at hw
      | some a =>
        simp only [outcome, ha] at h
        split at h
        · rename_i hc
          exact ⟨a, rfl, hc⟩
        · simp only [Outcome.store.injEq, Option.some.injEq] at h
          subst h
          rcases hw with hw | hw <;> simp at hw

/-- The same with the anchor's value spelled out: older rows stay only beside an unchanged anchor. -/
theorem keeping_write_needs_unchanged_anchor (r : Request) (f : Fetch) (ps : List Point)
    (w : Write) (d : Nat) (hw : w = .window d ∨ w = .full (some d))
    (h : outcome r f ps = .store (some w)) :
    ∃ a, r.anchor = some a ∧ ∃ p ∈ ps, p.date = a.date ∧ p.value = a.value := by
  obtain ⟨a, ha, hc⟩ := keeping_write_needs_confirmed_anchor r f ps w d hw h
  exact ⟨a, ha, (confirmed_iff a ps).mp hc⟩

/--
Contrapositive, full branch: a full fetch whose non-empty answer does not
reproduce the stored anchor replaces every stored row.
-/
theorem unconfirmed_anchor_replaces_everything (r : Request) (a : Point) (ps : List Point)
    (ha : r.anchor = some a) (hc : confirmed a ps = false) (hne : ps ≠ []) :
    outcome r .full ps = .store (some (.full none)) := by
  cases ps with
  | nil => exact absurd rfl hne
  | cons p t => simp [outcome, ha, hc]

/-- Contrapositive, window branch: a window that does not reproduce the anchor stores nothing yet. -/
theorem unconfirmed_anchor_window_refetches (r : Request) (a : Point) (e : Nat) (ps : List Point)
    (ha : r.anchor = some a) (hc : confirmed a ps = false) :
    outcome r (.window e) ps = .refetchFull := by
  simp [outcome, ha, hc]

/-- With nothing stored, a non-empty answer replaces everything. -/
theorem no_anchor_replaces_everything (r : Request) (ps : List Point) (ha : r.anchor = none)
    (hne : ps ≠ []) : outcome r .full ps = .store (some (.full none)) := by
  cases ps with
  | nil => exact absurd rfl hne
  | cons p t => simp [outcome, ha]

end Research.HistoryRefresh
