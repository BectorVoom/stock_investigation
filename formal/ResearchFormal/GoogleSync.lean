import ResearchFormal.Basic

/-!
# Google Calendar sync plan

Formal model of `planGoogleSync` in `packages/domain/src/calendar/googleSync.ts`
(FR-019 section 2.3) plus the base32hex event-id encoder.

A desired event is abstracted to `(id, fingerprint)` where the fingerprint
stands for all compared fields (equal iff every compared field is equal); a
managed event is `SyncRow` (id, whether Google reports it cancelled, whether
Google shows it as busy, and the same fingerprint). The TypeScript compares
`startDate`, `endDate`, `summary` and `description`; the conformance test maps
fingerprint `0`/`1` to two field assignments that differ in exactly the
compared fields. Every desired event is free (`transparency: transparent`, as
the `.ics`), so a busy managed event (`opaque`, Google's default) always
differs from it: `busy` is modelled on its own rather than folded into the
fingerprint, because the desired side has no busy variant.

Proved below: (1) every desired id ends in exactly one of
inserts/updates/unchanged (`plan_covers` needs nothing; `plan_disjoint`
needs distinct desired ids — the TypeScript rejects duplicates with
`DUPLICATE_ID`, covered by fail-closed unit tests), and a busy row is never
left unchanged (`plan_unchanged_free`); (2) no id is both
written and deleted (`plan_no_write_delete`); (3) applying the plan to
`existing` yields exactly the desired confirmed set, every desired event
free (`apply_plan_desired`, `apply_plan_confirmed`, and cancelled leftovers
are kept as-is).

The models sort every bucket by id (insertion sort, as in `Calendar.lean`);
only membership is proved about the sorts — the exact ascending order is
pinned by the exported vectors and asserted in the conformance test.
Duplicate ids in either input are outside the model (the implementation
fails closed); all vectors use distinct ids.
-/

namespace Research

/-- One managed event Google returned: id, cancelled?, busy? (`transparency`
    not `transparent`), fingerprint of the compared fields. -/
structure SyncRow where
  id : Nat
  cancelled : Bool
  busy : Bool
  fingerprint : Nat
  deriving Repr, DecidableEq

/-- A sync plan: full desired pairs to write, managed ids to delete or keep. -/
structure SyncPlan where
  inserts : List (Nat × Nat)
  updates : List (Nat × Nat)
  deletes : List Nat
  unchanged : List Nat
  deriving Repr

/-! ## Small list-search facts (proved locally, no core-version dependence) -/

theorem find?_mem' {l : List α} {p : α → Bool} {a : α}
    (h : l.find? p = some a) : a ∈ l := by
  induction l with
  | nil => simp [List.find?] at h
  | cons hd tl ih =>
    simp only [List.find?] at h
    by_cases hhd : p hd = true
    · simp [hhd] at h
      cases h
      simp
    · simp [hhd] at h
      exact List.mem_cons_of_mem _ (ih h)

theorem find?_prop' {l : List α} {p : α → Bool} {a : α}
    (h : l.find? p = some a) : p a = true := by
  induction l with
  | nil => simp [List.find?] at h
  | cons hd tl ih =>
    simp only [List.find?] at h
    by_cases hhd : p hd = true
    · simp [hhd] at h
      cases h
      exact hhd
    · simp [hhd] at h
      exact ih h

theorem any_of_mem {l : List α} {p : α → Bool} {a : α}
    (h : a ∈ l) (hp : p a = true) : l.any p = true := by
  rw [List.any_eq_true]
  exact ⟨a, h, hp⟩

theorem any_mem_of_true {l : List α} {p : α → Bool}
    (h : l.any p = true) : ∃ a ∈ l, p a = true := by
  rw [List.any_eq_true] at h
  exact h

/-- Lookup of a managed event by id (first match). -/
def syncFind (existing : List SyncRow) (id : Nat) : Option SyncRow :=
  existing.find? (fun r => r.id == id)

/-- A found row really is in the list, with the looked-up id. -/
theorem syncFind_mem_id {e : List SyncRow} {x : Nat} {r : SyncRow}
    (h : syncFind e x = some r) : r ∈ e ∧ r.id = x := by
  have hmem : r ∈ e :=
    find?_mem' (l := e) (p := fun r_1 => r_1.id == x) (a := r)
      (by simpa [syncFind] using h)
  have hpred : (fun r_1 => r_1.id == x) r = true :=
    find?_prop' (l := e) (p := fun r_1 => r_1.id == x) (a := r)
      (by simpa [syncFind] using h)
  refine ⟨hmem, ?_⟩
  simpa using hpred

/-- Stable insertion by id (matches `Array.sort` with `<` on distinct ids). -/
def pairInsertId (x : Nat × Nat) : List (Nat × Nat) → List (Nat × Nat)
  | [] => [x]
  | y :: ys => if x.1 < y.1 then x :: y :: ys else y :: pairInsertId x ys

def pairSortId : List (Nat × Nat) → List (Nat × Nat)
  | [] => []
  | x :: xs => pairInsertId x (pairSortId xs)

def natInsert (x : Nat) : List Nat → List Nat
  | [] => [x]
  | y :: ys => if x < y then x :: y :: ys else y :: natInsert x ys

def natSort : List Nat → List Nat
  | [] => []
  | x :: xs => natInsert x (natSort xs)

theorem mem_pairInsertId (x : Nat × Nat) (l : List (Nat × Nat)) (y : Nat × Nat) :
    y ∈ pairInsertId x l ↔ y = x ∨ y ∈ l := by
  induction l with
  | nil => simp [pairInsertId]
  | cons z zs ih =>
    simp only [pairInsertId]
    by_cases h : x.1 < z.1
    · rw [ifPos h]
      simp
    · rw [ifNeg h, List.mem_cons, List.mem_cons, ih]
      exact or_left_comm

theorem mem_pairSortId (l : List (Nat × Nat)) (p : Nat × Nat) :
    p ∈ pairSortId l ↔ p ∈ l := by
  induction l with
  | nil => simp [pairSortId]
  | cons x xs ih =>
    simp only [pairSortId, mem_pairInsertId, ih, List.mem_cons]

theorem mem_natInsert (x : Nat) (l : List Nat) (y : Nat) :
    y ∈ natInsert x l ↔ y = x ∨ y ∈ l := by
  induction l with
  | nil => simp [natInsert]
  | cons z zs ih =>
    simp only [natInsert]
    by_cases h : x < z
    · rw [ifPos h]
      simp
    · rw [ifNeg h, List.mem_cons, List.mem_cons, ih]
      exact or_left_comm

theorem mem_natSort (l : List Nat) (y : Nat) :
    y ∈ natSort l ↔ y ∈ l := by
  induction l with
  | nil => simp [natSort]
  | cons x xs ih =>
    simp only [natSort, mem_natInsert, ih, List.mem_cons]

/-- The full pipeline: insert when the id is unknown; update when known and
    (cancelled, busy, or any compared field differs); delete when a confirmed managed
    event's id is not desired; a cancelled event that is not desired is
    ignored. Deterministic order (by id). -/
def planInserts (desired : List (Nat × Nat)) (existing : List SyncRow) :
    List (Nat × Nat) :=
  pairSortId (desired.filter fun p => match syncFind existing p.1 with
    | none => true
    | some _ => false)

def planUpdates (desired : List (Nat × Nat)) (existing : List SyncRow) :
    List (Nat × Nat) :=
  pairSortId (desired.filter fun p => match syncFind existing p.1 with
    | none => false
    | some r => decide (r.cancelled = true) || decide (r.busy = true)
      || decide (r.fingerprint ≠ p.2))

def planUnchanged (desired : List (Nat × Nat)) (existing : List SyncRow) :
    List Nat :=
  natSort ((desired.filter fun p => match syncFind existing p.1 with
    | none => false
    | some r => decide (r.cancelled = false) && decide (r.busy = false)
      && decide (r.fingerprint = p.2)).map (·.1))

def planDeletes (desired : List (Nat × Nat)) (existing : List SyncRow) :
    List Nat :=
  natSort ((existing.filter fun r =>
    decide (r.cancelled = false)
      && decide ((desired.any fun p => decide (p.1 = r.id)) = false)).map
    (·.id))

def planSync (desired : List (Nat × Nat)) (existing : List SyncRow) : SyncPlan :=
  ⟨planInserts desired existing, planUpdates desired existing,
   planDeletes desired existing, planUnchanged desired existing⟩

/-- Rows with equal ids in a distinct-id list are the same row. -/
theorem fst_mem_eq (d : List (Nat × Nat)) (p q : Nat × Nat)
    (hp : p ∈ d) (hq : q ∈ d) (he : p.1 = q.1)
    (h : (d.map (·.1)).Nodup) : p = q := by
  revert hp hq he h
  induction d with
  | nil =>
    intro hp _ _ _
    simp at hp
  | cons r rest ih =>
    intro hp hq he h
    simp only [List.map_cons, List.nodup_cons, List.mem_cons] at hp hq h
    rcases hp with rfl | hpm
    · rcases hq with rfl | hqm
      · rfl
      · exfalso
        obtain ⟨hni, _⟩ := h
        apply hni
        rw [List.mem_map]
        exact ⟨q, hqm, by simpa using he.symm⟩
    · rcases hq with rfl | hqm
      · exfalso
        obtain ⟨hni, _⟩ := h
        apply hni
        rw [List.mem_map]
        exact ⟨p, hpm, by simpa using he⟩
      · exact ih hpm hqm he h.2

/-- In a distinct-id list, lookup by a member's id returns that member. -/
theorem syncFind_some (e : List SyncRow) (r : SyncRow) (hm : r ∈ e)
    (h : (e.map (·.id)).Nodup) : syncFind e r.id = some r := by
  revert hm h
  induction e with
  | nil =>
    intro hm _
    simp at hm
  | cons hd tl ih =>
    intro hm h
    simp only [List.map_cons, List.nodup_cons] at h
    obtain ⟨hni, htl⟩ := h
    unfold syncFind
    by_cases hhd : (fun r_1 => r_1.id == r.id) hd = true
    · have hmap : ((hd :: tl).find? fun r_1 => r_1.id == r.id) = some hd := by
        simp [hhd]
      have heq : hd.id = r.id := by simpa using hhd
      simp only [List.mem_cons] at hm
      simp only [hmap]
      rcases hm with rfl | htlm
      · rfl
      · exfalso
        apply hni
        rw [List.mem_map]
        exact ⟨r, htlm, by simpa using heq.symm⟩
    · have hmap : ((hd :: tl).find? fun r_1 => r_1.id == r.id)
          = tl.find? fun r_1 => r_1.id == r.id := by
        simp [hhd]
      have hm' : r ∈ tl := by
        simp only [List.mem_cons] at hm
        rcases hm with heqr | htlm
        · subst heqr
          simp at hhd
        · exact htlm
      have hgoal : syncFind tl r.id = some r := ih hm' htl
      simpa [syncFind, hmap] using hgoal

/-! ## Bucket membership -/

theorem mem_plan_inserts {d : List (Nat × Nat)} {e : List SyncRow}
    {p : Nat × Nat} :
    p ∈ planInserts d e ↔ p ∈ d ∧ syncFind e p.1 = none := by
  unfold planInserts
  simp only [mem_pairSortId, List.mem_filter]
  constructor
  · rintro ⟨hd, hpred⟩
    refine ⟨hd, ?_⟩
    cases hfind : syncFind e p.1 with
    | none => rfl
    | some r => simp [hfind] at hpred
  · rintro ⟨hd, hfind⟩
    exact ⟨hd, by simp [hfind]⟩

theorem mem_plan_updates {d : List (Nat × Nat)} {e : List SyncRow}
    {p : Nat × Nat} :
    p ∈ planUpdates d e ↔ p ∈ d ∧ ∃ r, syncFind e p.1 = some r ∧
      (r.cancelled = true ∨ r.busy = true ∨ r.fingerprint ≠ p.2) := by
  unfold planUpdates
  simp only [mem_pairSortId, List.mem_filter]
  constructor
  · rintro ⟨hd, hpred⟩
    by_cases hnone : syncFind e p.1 = none
    · simp [hnone] at hpred
    · obtain ⟨r, hr⟩ : ∃ r, syncFind e p.1 = some r := by
        cases ho : syncFind e p.1 with
        | none => exact absurd ho hnone
        | some r => exact ⟨r, rfl⟩
      have hpred' : (decide (r.cancelled = true) || decide (r.busy = true)
          || decide (r.fingerprint ≠ p.2)) = true := by
        simpa [hr] using hpred
      simp only [Bool.or_eq_true, decide_eq_true_eq] at hpred'
      exact ⟨hd, r, hr, or_assoc.mp hpred'⟩
  · rintro ⟨hd, r, hfind, hc⟩
    refine ⟨hd, ?_⟩
    simp [hfind, Bool.or_eq_true]
    exact or_assoc.mpr hc

theorem mem_plan_unchanged {d : List (Nat × Nat)} {e : List SyncRow}
    {x : Nat} :
    x ∈ planUnchanged d e ↔ ∃ p ∈ d, p.1 = x ∧ ∃ r, syncFind e x = some r ∧
      r.cancelled = false ∧ r.busy = false ∧ r.fingerprint = p.2 := by
  unfold planUnchanged
  simp only [mem_natSort, List.mem_map, List.mem_filter]
  constructor
  · rintro ⟨p, ⟨hd, hpred⟩, hpx⟩
    cases hfind : syncFind e p.1 with
    | none => simp [hfind] at hpred
    | some r =>
      simp [hfind, Bool.and_eq_true, decide_eq_true_eq] at hpred
      obtain ⟨⟨hnc, hnb⟩, hfp⟩ := hpred
      exact ⟨p, hd, hpx, r, by rw [← hpx]; exact hfind, hnc, hnb, hfp⟩
  · rintro ⟨p, hd, hpx, r, hfind, hnc, hnb, hfp⟩
    refine ⟨p, ⟨hd, ?_⟩, hpx⟩
    have hfindp : syncFind e p.1 = some r := by rw [hpx]; exact hfind
    simp [hfindp, Bool.and_eq_true, decide_eq_true_eq]
    exact ⟨⟨hnc, hnb⟩, hfp⟩

theorem mem_plan_deletes {d : List (Nat × Nat)} {e : List SyncRow}
    {x : Nat} :
    x ∈ planDeletes d e ↔ ∃ r ∈ e, r.id = x ∧ r.cancelled = false ∧
      (d.any fun p => decide (p.1 = x)) = false := by
  unfold planDeletes
  simp only [mem_natSort, List.mem_map, List.mem_filter]
  constructor
  · rintro ⟨r, ⟨hm, hpred⟩, hrx⟩
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hpred
    obtain ⟨hnc, hno⟩ := hpred
    rw [hrx] at hno
    exact ⟨r, hm, hrx, hnc, hno⟩
  · rintro ⟨r, hm, hrx, hnc, hno⟩
    have hno' : (d.any fun p => decide (p.1 = r.id)) = false := by
      rw [← hrx] at hno
      exact hno
    exact ⟨r, ⟨hm, by simp [hnc, hno']⟩, hrx⟩

/-! ## The three proved properties -/

/-- **(1a) Every desired id ends in one of inserts/updates/unchanged.** -/
theorem plan_covers (d : List (Nat × Nat)) (e : List SyncRow)
    (p : Nat × Nat) (h : p ∈ d) :
    (∃ q ∈ planInserts d e, q.1 = p.1)
      ∨ (∃ q ∈ planUpdates d e, q.1 = p.1)
      ∨ p.1 ∈ planUnchanged d e := by
  cases hfind : syncFind e p.1 with
  | none =>
    exact Or.inl ⟨p, (mem_plan_inserts.mpr ⟨h, hfind⟩), rfl⟩
  | some r =>
    by_cases hc : r.cancelled = true
    · exact Or.inr (Or.inl
        ⟨p, (mem_plan_updates.mpr ⟨h, r, hfind, Or.inl hc⟩), rfl⟩)
    · by_cases hb : r.busy = true
      · exact Or.inr (Or.inl
          ⟨p, (mem_plan_updates.mpr ⟨h, r, hfind, Or.inr (Or.inl hb)⟩), rfl⟩)
      · by_cases hfp : r.fingerprint = p.2
        · exact Or.inr (Or.inr (by
            rw [mem_plan_unchanged]
            have hnc : r.cancelled = false := by
              cases hbc : r.cancelled <;> simp_all
            have hnb : r.busy = false := by
              cases hbb : r.busy <;> simp_all
            exact ⟨p, h, rfl, r, hfind, hnc, hnb, hfp⟩))
        · exact Or.inr (Or.inl
            ⟨p, (mem_plan_updates.mpr ⟨h, r, hfind, Or.inr (Or.inr hfp)⟩), rfl⟩)

/-- **(1b) No desired id ends in two buckets** (needs distinct desired ids —
    the implementation rejects duplicates with `DUPLICATE_ID`). -/
theorem plan_disjoint (d : List (Nat × Nat)) (e : List SyncRow)
    (h : (d.map (·.1)).Nodup) (x : Nat) :
    ¬(∃ q ∈ planInserts d e, q.1 = x ∧ ∃ q' ∈ planUpdates d e, q'.1 = x)
      ∧ ¬(∃ q ∈ planInserts d e, q.1 = x ∧ x ∈ planUnchanged d e)
      ∧ ¬(∃ q ∈ planUpdates d e, q.1 = x ∧ x ∈ planUnchanged d e) := by
  refine ⟨?_, ?_, ?_⟩
  · rintro ⟨q, hqm, hqx, q', hq'm, hq'x⟩
    rw [mem_plan_inserts] at hqm
    rw [mem_plan_updates] at hq'm
    obtain ⟨_, hnone⟩ := hqm
    obtain ⟨_, _, hsome, _⟩ := hq'm
    rw [hqx] at hnone
    rw [hq'x] at hsome
    simp [hnone] at hsome
  · rintro ⟨q, hqm, hqx, hxu⟩
    rw [mem_plan_inserts] at hqm
    rw [mem_plan_unchanged] at hxu
    obtain ⟨_, hnone⟩ := hqm
    obtain ⟨p, _, hpx, _, hsome, _, _, _⟩ := hxu
    rw [hqx] at hnone
    simp [hnone] at hsome
  · rintro ⟨q, hqm, hqx, hxu⟩
    rw [mem_plan_updates] at hqm
    rw [mem_plan_unchanged] at hxu
    obtain ⟨hdq, r, hsome, hc⟩ := hqm
    obtain ⟨p, hdp, hpx, r', hsome', hnc, hnb, hfp⟩ := hxu
    have heq : q.1 = p.1 := by rw [hqx, hpx]
    have hqq : q = p := fst_mem_eq d q p hdq hdp heq h
    subst hqq
    rw [← hpx] at hsome'
    have hrr : r = r' := Option.some_inj.mp (hsome.symm.trans hsome')
    subst hrr
    rcases hc with hcanc | hbusy | hne
    · simp [hnc] at hcanc
    · simp [hnb] at hbusy
    · exact absurd hfp hne

/-- **(1c) A busy managed event is never left unchanged**: an id the plan
    keeps as it is names a free row (every written body is `transparent`, so
    a busy one always differs from what is desired). -/
theorem plan_unchanged_free (d : List (Nat × Nat)) (e : List SyncRow)
    (x : Nat) (h : x ∈ planUnchanged d e) :
    ∃ r, syncFind e x = some r ∧ r.busy = false := by
  obtain ⟨_, _, _, r, hfind, _, hnb, _⟩ := mem_plan_unchanged.mp h
  exact ⟨r, hfind, hnb⟩

/-- **(2) No id is both written and deleted.** -/
theorem plan_no_write_delete (d : List (Nat × Nat)) (e : List SyncRow)
    (x : Nat)
    (h : (∃ q ∈ planInserts d e, q.1 = x)
      ∨ (∃ q ∈ planUpdates d e, q.1 = x)) :
    x ∉ planDeletes d e := by
  have hmem : ∃ p ∈ d, p.1 = x := by
    rcases h with ⟨q, hqm, hqx⟩ | ⟨q, hqm, hqx⟩
    · rw [mem_plan_inserts] at hqm
      exact ⟨q, hqm.1, hqx⟩
    · rw [mem_plan_updates] at hqm
      obtain ⟨hdq, _, _, _⟩ := hqm
      exact ⟨q, hdq, hqx⟩
  obtain ⟨p, hpd, hpx⟩ := hmem
  have hany : (d.any fun q => decide (q.1 = x)) = true :=
    any_of_mem hpd (by simp [hpx])
  intro hdel
  rw [mem_plan_deletes] at hdel
  obtain ⟨_, _, _, _, hno⟩ := hdel
  simp [hany] at hno

/-! ## Applying the plan -/

/-- Planned fingerprint for an id (`none` when nothing is written for it). -/
def writeFp (written : List (Nat × Nat)) (id : Nat) : Option Nat :=
  (written.find? fun p => p.1 == id).map (·.2)

/-- A written pair's fingerprint is what the lookup returns, provided every
    pair filed under the id agrees (follows from distinct desired ids). -/
theorem writeFp_some_of_mem (written : List (Nat × Nat)) (p : Nat × Nat)
    (h : p ∈ written)
    (hu : ∀ w ∈ written, w.1 = p.1 → w.2 = p.2) :
    writeFp written p.1 = some p.2 := by
  revert h hu
  induction written with
  | nil =>
    intro h _
    simp at h
  | cons hd tl ih =>
    intro h hu
    simp only [List.mem_cons] at h
    by_cases hhd : (fun p_1 => p_1.1 == p.1) hd = true
    · have hmap : ((hd :: tl).find? fun p_1 => p_1.1 == p.1) = some hd := by
        simp [hhd]
      have heq : hd.1 = p.1 := by simpa using hhd
      have hfp : writeFp (hd :: tl) p.1 = some hd.2 := by
        simp [writeFp, hmap]
      rcases h with rfl | htlm
      · exact hfp
      · have h2 : hd.2 = p.2 := hu hd (by simp) heq
        simp [hfp, h2]
    · have hmap : ((hd :: tl).find? fun p_1 => p_1.1 == p.1)
          = tl.find? fun p_1 => p_1.1 == p.1 := by
        simp [hhd]
      have htlm : p ∈ tl := by
        rcases h with rfl | htlm
        · simp at hhd
        · exact htlm
      have hu' : ∀ w ∈ tl, w.1 = p.1 → w.2 = p.2 :=
        fun w hwm hw1 => hu w (List.mem_cons_of_mem _ hwm) hw1
      have hgoal : writeFp tl p.1 = some p.2 := ih htlm hu'
      simpa [writeFp, hmap] using hgoal

/-- All pairs filed under one id agree when the desired ids are distinct. -/
theorem written_fp_unique (d : List (Nat × Nat)) (hd : (d.map (·.1)).Nodup)
    {w : Nat × Nat} (hw : w ∈ d) {p : Nat × Nat} (hp : p ∈ d)
    (heq : w.1 = p.1) : w.2 = p.2 := by
  have hww : w = p := fst_mem_eq d w p hw hp heq hd
  rw [hww]

/-- Written pairs all come from the desired list. -/
theorem written_mem_of_mem {d : List (Nat × Nat)} {e : List SyncRow}
    {w : Nat × Nat}
    (h : w ∈ planInserts d e ++ planUpdates d e) : w ∈ d := by
  simp only [List.mem_append, mem_plan_inserts, mem_plan_updates] at h
  rcases h with ⟨hd, _⟩ | ⟨hd, _, _, _⟩
  · exact hd
  · exact hd

/-- Apply a plan, given its buckets explicitly (no projections to reduce). -/
def applyPlanCore (existing : List SyncRow) (ins upd : List (Nat × Nat))
    (del : List Nat) : List SyncRow :=
  existing.filterMap (fun r =>
    if r.id ∈ del then none
    else match writeFp (ins ++ upd) r.id with
      | none => some r
      | some fp => some ⟨r.id, false, false, fp⟩)
  ++ ((ins ++ upd).filter fun p =>
    decide ((existing.any fun r => decide (r.id = p.1)) = false)).map
    fun p => (⟨p.1, false, false, p.2⟩ : SyncRow)

/-- Apply a plan: drop deleted rows, replace written ids with confirmed, free
    rows carrying the planned fingerprint (every written body says
    `transparent`), keep the rest, append brand-new rows. -/
def applyPlan (existing : List SyncRow) (plan : SyncPlan) : List SyncRow :=
  applyPlanCore existing plan.inserts plan.updates plan.deletes

/-- Every written id resolves to the fingerprint of its desired pair. -/
theorem written_fp_some (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (p : Nat × Nat) (h : p ∈ d)
    (hw : p ∈ planInserts d e ++ planUpdates d e) :
    writeFp (planInserts d e ++ planUpdates d e) p.1 = some p.2 := by
  apply writeFp_some_of_mem _ _ hw
  intro w hwm hw1
  have hwd : w ∈ d := written_mem_of_mem hwm
  exact written_fp_unique d hd hwd h hw1

/-- A written pair lands in the result with its fingerprint. -/
theorem apply_plan_written_core (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (_he : (e.map (·.id)).Nodup)
    (p : Nat × Nat) (h : p ∈ d)
    (hw : p ∈ planInserts d e ++ planUpdates d e) :
    ∃ r ∈ applyPlanCore e (planInserts d e) (planUpdates d e)
        (planDeletes d e),
      r.id = p.1 ∧ r.fingerprint = p.2 ∧ r.cancelled = false
        ∧ r.busy = false := by
  have hfp : writeFp (planInserts d e ++ planUpdates d e) p.1 = some p.2 :=
    written_fp_some d e hd p h hw
  by_cases hkept : ∃ r₀ ∈ e, r₀.id = p.1 ∧ r₀.id ∉ planDeletes d e
  · obtain ⟨r₀, hrm, hrid, hnd⟩ := hkept
    have hrow : (fun r =>
        if r.id ∈ planDeletes d e then none
        else match writeFp (planInserts d e ++ planUpdates d e) r.id with
          | none => some r
          | some fp => some (⟨r.id, false, false, fp⟩ : SyncRow)) r₀
        = some (⟨p.1, false, false, p.2⟩ : SyncRow) := by
      have hfp0 : writeFp (planInserts d e ++ planUpdates d e) r₀.id
          = some p.2 := by rw [hrid]; exact hfp
      simp only [hrid] at hnd hfp0 ⊢
      simp [ifNeg hnd, hfp0]
    have hmem : (⟨p.1, false, false, p.2⟩ : SyncRow) ∈ List.filterMap (fun r =>
        if r.id ∈ planDeletes d e then none
        else match writeFp (planInserts d e ++ planUpdates d e) r.id with
          | none => some r
          | some fp => some (⟨r.id, false, false, fp⟩ : SyncRow)) e := by
      rw [List.mem_filterMap]
      exact ⟨r₀, hrm, hrow⟩
    unfold applyPlanCore
    exact ⟨⟨p.1, false, false, p.2⟩, List.mem_append_left _ hmem, rfl, rfl, rfl, rfl⟩
  · have hfresh : p ∈ (planInserts d e ++ planUpdates d e).filter
        (fun p_1 => decide ((e.any fun r => decide (r.id = p_1.1)) = false)) := by
      rw [List.mem_filter]
      refine ⟨hw, ?_⟩
      simp only [decide_eq_true_eq]
      by_cases hany : (e.any fun r => decide (r.id = p.1)) = true
      · exfalso
        obtain ⟨r₀, hrm, hpred⟩ := any_mem_of_true hany
        simp only [decide_eq_true_eq] at hpred
        by_cases hdel : r₀.id ∈ planDeletes d e
        · rw [mem_plan_deletes] at hdel
          obtain ⟨_, _, _, _, hno⟩ := hdel
          have hanyd : (d.any fun q => decide (q.1 = r₀.id)) = true :=
            any_of_mem h (by simp [hpred])
          simp [hanyd] at hno
        · exact hkept ⟨r₀, hrm, hpred, hdel⟩
      · cases hbc : (e.any fun r => decide (r.id = p.1)) <;> simp_all
    have hmem : (⟨p.1, false, false, p.2⟩ : SyncRow) ∈
        ((planInserts d e ++ planUpdates d e).filter fun p_1 =>
          decide ((e.any fun r => decide (r.id = p_1.1)) = false)).map
          fun p_1 => (⟨p_1.1, false, false, p_1.2⟩ : SyncRow) := by
      rw [List.mem_map]
      exact ⟨p, hfresh, rfl⟩
    unfold applyPlanCore
    exact ⟨⟨p.1, false, false, p.2⟩, List.mem_append_right _ hmem, rfl, rfl, rfl, rfl⟩

/-- **(3a) Every desired pair ends confirmed and free with its fingerprint.** -/
theorem apply_plan_desired_core (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (he : (e.map (·.id)).Nodup)
    (p : Nat × Nat) (h : p ∈ d) :
    ∃ r ∈ applyPlanCore e (planInserts d e) (planUpdates d e)
        (planDeletes d e),
      r.id = p.1 ∧ r.fingerprint = p.2 ∧ r.cancelled = false
        ∧ r.busy = false := by
  rcases plan_covers d e p h with ⟨q, hqi, hqx⟩ | ⟨q, hqu, hqx⟩ | hxu
  · have heq : q = p := by
      have hdq : q ∈ d := (mem_plan_inserts.mp hqi).1
      exact fst_mem_eq d q p hdq h (by rw [hqx]) hd
    subst q
    exact apply_plan_written_core d e hd he p h
      (List.mem_append_left _ hqi)
  · have heq : q = p := by
      have hdq : q ∈ d := (mem_plan_updates.mp hqu).1
      exact fst_mem_eq d q p hdq h (by rw [hqx]) hd
    subst q
    exact apply_plan_written_core d e hd he p h
      (List.mem_append_right _ hqu)
  · -- Unchanged: the managed row stays as it is.
    rw [mem_plan_unchanged] at hxu
    obtain ⟨p', hpd, hpx, r, hfind, hnc, hnb, hfp⟩ := hxu
    have heq : p' = p := fst_mem_eq d p' p hpd h hpx hd
    subst p'
    have hrm : r ∈ e := (syncFind_mem_id hfind).1
    have hnid : r.id = p.1 := (syncFind_mem_id hfind).2
    have hnd : r.id ∉ planDeletes d e := by
      intro hdel
      rw [mem_plan_deletes] at hdel
      obtain ⟨_, _, _, _, hno⟩ := hdel
      have hany : (d.any fun q => decide (q.1 = r.id)) = true :=
        any_of_mem h (by simp [hnid])
      simp [hany] at hno
    have hfp0 : writeFp (planInserts d e ++ planUpdates d e) r.id = none := by
      by_cases hf : writeFp (planInserts d e ++ planUpdates d e) r.id = none
      · exact hf
      · exfalso
        cases hw : (planInserts d e ++ planUpdates d e).find?
            (fun w => w.1 == r.id) with
        | none =>
          unfold writeFp at hf
          simp [hw] at hf
        | some w =>
          have hwm : w ∈ planInserts d e ++ planUpdates d e :=
            find?_mem' hw
          have hw1 : w.1 = r.id := by
            have hpw := find?_prop' hw
            simpa using hpw
          have hwd : w ∈ d := written_mem_of_mem hwm
          have hwx : w.1 = p.1 := by rw [hw1, hnid]
          have hwp : w = p := fst_mem_eq d w p hwd h hwx hd
          subst w
          have havehd : p.1 ∈ planUnchanged d e := by
            rw [mem_plan_unchanged]
            exact ⟨p, h, rfl, r, hfind, hnc, hnb, hfp⟩
          simp only [List.mem_append] at hwm
          rcases hwm with hwins | hwupd
          · exact (plan_disjoint d e hd p.1).2.1 ⟨p, hwins, rfl, havehd⟩
          · exact (plan_disjoint d e hd p.1).2.2 ⟨p, hwupd, rfl, havehd⟩
    have hrow : (fun r_1 =>
        if r_1.id ∈ planDeletes d e then none
        else match writeFp (planInserts d e ++ planUpdates d e) r_1.id with
          | none => some r_1
          | some fp => some (⟨r_1.id, false, false, fp⟩ : SyncRow)) r
        = some r := by
      simp [ifNeg hnd, hfp0]
    have hmem : r ∈ List.filterMap (fun r_1 =>
        if r_1.id ∈ planDeletes d e then none
        else match writeFp (planInserts d e ++ planUpdates d e) r_1.id with
          | none => some r_1
          | some fp => some (⟨r_1.id, false, false, fp⟩ : SyncRow)) e := by
      rw [List.mem_filterMap]
      exact ⟨r, hrm, hrow⟩
    unfold applyPlanCore
    refine ⟨r, List.mem_append_left _ hmem, hnid, ?_, ?_, hnb⟩
    · exact hfp
    · cases hbc : r.cancelled <;> simp_all

/-- **(3b) Every confirmed result row is a desired pair.** -/
theorem apply_plan_confirmed_core (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (he : (e.map (·.id)).Nodup)
    (r : SyncRow) (h : r ∈ applyPlanCore e (planInserts d e)
      (planUpdates d e) (planDeletes d e))
    (hc : r.cancelled = false) :
    (r.id, r.fingerprint) ∈ d := by
  unfold applyPlanCore at h
  simp only [List.mem_append] at h
  rcases h with hkept | hfresh
  · rw [List.mem_filterMap] at hkept
    obtain ⟨r₀, hrm, hfr⟩ := hkept
    by_cases hdel : r₀.id ∈ planDeletes d e
    · simp [ifPos hdel] at hfr
    · simp only [ifNeg hdel] at hfr
      cases hfp : writeFp (planInserts d e ++ planUpdates d e) r₀.id with
      | none =>
        simp [hfp] at hfr
        subst hfr
        by_cases hid : ∃ p ∈ d, p.1 = r₀.id
        · obtain ⟨p, hpd, hpid⟩ := hid
          have hfindp : syncFind e p.1 = some r₀ := by
            rw [hpid]
            exact syncFind_some e r₀ hrm he
          rcases plan_covers d e p hpd with ⟨q, hqi, hqx⟩ | ⟨q, hqu, hqx⟩ | hxu
          · exfalso
            have heq : q = p := by
              have hdq : q ∈ d := (mem_plan_inserts.mp hqi).1
              exact fst_mem_eq d q p hdq hpd (by rw [hqx]) hd
            subst q
            have hsome := written_fp_some d e hd p hpd
              (List.mem_append_left _ hqi)
            rw [hpid] at hsome
            simp [hsome] at hfp
          · exfalso
            have heq : q = p := by
              have hdq : q ∈ d := (mem_plan_updates.mp hqu).1
              exact fst_mem_eq d q p hdq hpd (by rw [hqx]) hd
            subst q
            have hsome := written_fp_some d e hd p hpd
              (List.mem_append_right _ hqu)
            rw [hpid] at hsome
            simp [hsome] at hfp
          · rw [mem_plan_unchanged] at hxu
            obtain ⟨p', hpd', hpx, r', hfind', hnc', _, hfp'⟩ := hxu
            have heqp : p' = p := fst_mem_eq d p' p hpd' hpd hpx hd
            subst p'
            have hrr : r' = r₀ :=
              Option.some_inj.mp (hfind'.symm.trans hfindp)
            subst hrr
            rw [← hpid, hfp']
            exact hpd
        · -- Undesired id: a confirmed kept row would have been deleted.
          have hnc0 : r₀.cancelled = false := hc
          have hdel' : r₀.id ∈ planDeletes d e := by
            rw [mem_plan_deletes]
            refine ⟨r₀, hrm, rfl, hnc0, ?_⟩
            by_cases hany : (d.any fun p => decide (p.1 = r₀.id)) = true
            · exfalso
              obtain ⟨p, hpd, hpred⟩ := any_mem_of_true hany
              simp only [decide_eq_true_eq] at hpred
              exact hid ⟨p, hpd, hpred⟩
            · cases hbc : (d.any fun p => decide (p.1 = r₀.id)) <;> simp_all
          exact absurd hdel' hdel
      | some fp =>
        simp [hfp] at hfr
        subst hfr
        cases hw : (planInserts d e ++ planUpdates d e).find?
            (fun w => w.1 == r₀.id) with
        | none =>
          unfold writeFp at hfp
          simp [hw] at hfp
        | some w =>
          have hwm : w ∈ planInserts d e ++ planUpdates d e :=
            find?_mem' hw
          have hw1 : w.1 = r₀.id := by
            have hpw := find?_prop' hw
            simpa using hpw
          have hwd : w ∈ d := written_mem_of_mem hwm
          have hmem_fp : w.2 = fp := by
            unfold writeFp at hfp
            simpa [hw] using hfp
          show (r₀.id, fp) ∈ d
          rw [← hw1, ← hmem_fp]
          exact hwd
  · rw [List.mem_map] at hfresh
    obtain ⟨w, hwfm, hwr⟩ := hfresh
    rw [List.mem_filter] at hwfm
    obtain ⟨hwm, _⟩ := hwfm
    have hwd : w ∈ d := written_mem_of_mem hwm
    subst hwr
    show (w.1, w.2) ∈ d
    exact hwd

/-- Managed rows with equal ids in a distinct-id list are the same row. -/
theorem syncRow_mem_eq (e : List SyncRow) (r r' : SyncRow)
    (hm : r ∈ e) (hm' : r' ∈ e) (heq : r.id = r'.id)
    (h : (e.map (·.id)).Nodup) : r = r' := by
  revert hm hm' heq h
  induction e with
  | nil =>
    intro hm _ _ _
    simp at hm
  | cons hd rest ih =>
    intro hm hm' heq h
    simp only [List.map_cons, List.nodup_cons, List.mem_cons] at hm hm' h
    rcases hm with rfl | htlm
    · rcases hm' with rfl | htlm'
      · rfl
      · exfalso
        obtain ⟨hni, _⟩ := h
        apply hni
        rw [List.mem_map]
        exact ⟨r', htlm', by simpa using heq.symm⟩
    · rcases hm' with rfl | htlm'
      · exfalso
        obtain ⟨hni, _⟩ := h
        apply hni
        rw [List.mem_map]
        exact ⟨r, htlm, by simpa using heq⟩
      · exact ih htlm htlm' heq h.2

/-- **(3c) Cancelled leftovers stay untouched.** -/
theorem apply_plan_cancelled_kept_core (d : List (Nat × Nat))
    (e : List SyncRow) (he : (e.map (·.id)).Nodup)
    (r : SyncRow) (hm : r ∈ e) (hc : r.cancelled = true)
    (hnd : r.id ∉ d.map (·.1)) :
    r ∈ applyPlanCore e (planInserts d e) (planUpdates d e)
      (planDeletes d e) := by
  have hndel : r.id ∉ planDeletes d e := by
    intro hdel
    rw [mem_plan_deletes] at hdel
    obtain ⟨r', hrm', hrid, hnc, _⟩ := hdel
    have heqr : r' = r := syncRow_mem_eq e r' r hrm' hm hrid he
    subst heqr
    simp [hc] at hnc
  have hnone : writeFp (planInserts d e ++ planUpdates d e) r.id = none := by
    by_cases hf : writeFp (planInserts d e ++ planUpdates d e) r.id = none
    · exact hf
    · exfalso
      unfold writeFp at hf
      cases hw : (planInserts d e ++ planUpdates d e).find?
          (fun w => w.1 == r.id) with
      | none => simp [hw] at hf
      | some w =>
        have hwm : w ∈ planInserts d e ++ planUpdates d e :=
          find?_mem' hw
        have hw1 : w.1 = r.id := by
          have hpw := find?_prop' hw
          simpa using hpw
        have hwd : w ∈ d := written_mem_of_mem hwm
        rw [List.mem_map] at hnd
        exact hnd ⟨w, hwd, hw1⟩
  have hrow : (fun r_1 =>
      if r_1.id ∈ planDeletes d e then none
      else match writeFp (planInserts d e ++ planUpdates d e) r_1.id with
        | none => some r_1
        | some fp => some (⟨r_1.id, false, false, fp⟩ : SyncRow)) r
      = some r := by
    simp [ifNeg hndel, hnone]
  have hmem : r ∈ List.filterMap (fun r_1 =>
      if r_1.id ∈ planDeletes d e then none
      else match writeFp (planInserts d e ++ planUpdates d e) r_1.id with
        | none => some r_1
        | some fp => some (⟨r_1.id, false, false, fp⟩ : SyncRow)) e := by
    rw [List.mem_filterMap]
    exact ⟨r, hm, hrow⟩
  unfold applyPlanCore
  exact List.mem_append_left _ hmem

/-- The three application properties restated for `applyPlan`. -/
theorem apply_plan_desired (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (he : (e.map (·.id)).Nodup)
    (p : Nat × Nat) (h : p ∈ d) :
    ∃ r ∈ applyPlan e (planSync d e),
      r.id = p.1 ∧ r.fingerprint = p.2 ∧ r.cancelled = false
        ∧ r.busy = false := by
  obtain ⟨r, hrm, hid, hfp, hc, hb⟩ := apply_plan_desired_core d e hd he p h
  exact ⟨r, hrm, hid, hfp, hc, hb⟩

theorem apply_plan_confirmed (d : List (Nat × Nat)) (e : List SyncRow)
    (hd : (d.map (·.1)).Nodup) (he : (e.map (·.id)).Nodup)
    (r : SyncRow) (h : r ∈ applyPlan e (planSync d e))
    (hc : r.cancelled = false) :
    (r.id, r.fingerprint) ∈ d := by
  have hcore : r ∈ applyPlanCore e (planInserts d e) (planUpdates d e)
      (planDeletes d e) := h
  exact apply_plan_confirmed_core d e hd he r hcore hc

theorem apply_plan_cancelled_kept (d : List (Nat × Nat)) (e : List SyncRow)
    (he : (e.map (·.id)).Nodup)
    (r : SyncRow) (hm : r ∈ e) (hc : r.cancelled = true)
    (hnd : r.id ∉ d.map (·.1)) :
    r ∈ applyPlan e (planSync d e) := by
  have hcore : r ∈ applyPlanCore e (planInserts d e) (planUpdates d e)
      (planDeletes d e) :=
    apply_plan_cancelled_kept_core d e he r hm hc hnd
  exact hcore

/-! ## Base32hex encoder (vectors only) -/

/-- One byte to 8 bits, MSB first. -/
def byteBits (b : Nat) : List Nat :=
  (List.range 8).map fun i => (b / 2 ^ (7 - i)) % 2

/-- Whole bit stream, MSB first. -/
def toBits : List Nat → List Nat
  | [] => []
  | b :: rest => byteBits b ++ toBits rest

theorem byteBits_length (b : Nat) : (byteBits b).length = 8 := by
  simp [byteBits]

theorem toBits_length (bytes : List Nat) :
    (toBits bytes).length = bytes.length * 8 := by
  induction bytes with
  | nil => rfl
  | cons b rest ih =>
    simp only [toBits, List.length_append, List.length_cons, byteBits_length, ih]
    omega

/-- `n`-th bit (`0` past the end; the encoder only calls it in range). -/
def bitAt (bits : List Nat) (n : Nat) : Nat :=
  (bits[n]?).getD 0

/-- 5-bit group value at group index `i`. -/
def groupAt (bits : List Nat) (i : Nat) : Nat :=
  bitAt bits (i * 5) * 16 + bitAt bits (i * 5 + 1) * 8
    + bitAt bits (i * 5 + 2) * 4 + bitAt bits (i * 5 + 3) * 2
    + bitAt bits (i * 5 + 4)

/-- Base32hex encode: regroup the bit stream in fives (lengths that are not a
    multiple of 5 bytes are rejected by the TypeScript and never exported). -/
def encodeB32 (bytes : List Nat) : List Nat :=
  (List.range ((toBits bytes).length / 5)).map fun i => groupAt (toBits bytes) i

/-- The output holds one 5-bit group per five input bits. -/
theorem encodeB32_length (bytes : List Nat) :
    (encodeB32 bytes).length = (toBits bytes).length / 5 := by
  simp [encodeB32]

end Research
