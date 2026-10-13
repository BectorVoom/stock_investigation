import ResearchFormal.Basic
import ResearchFormal.Workspace

/-!
# Home dashboard edits

Formal model of the structural part of `applyDashboardEdit` in
`packages/domain/src/market/dashboard.ts` (FR-017).

Widget ids are natural numbers; titles, sizes, series and the 30-series limit
are abstracted away (covered by unit and contract tests). `replace` keeps the
same widget id, so it is structurally the identity on accepted dashboards and
is not modelled as a separate operation; `reset` installs a validated
dashboard, which the contract schema (`homeDashboardSchema`) guarantees to be
well formed. What is proved here is the id structure of `add`, `remove`,
`move` and `reorder`: uniqueness is preserved, `move` and `reorder` permute,
`reorder` lands at the requested index keeping the order of the rest, `remove`
deletes exactly one id keeping the order of the rest, `add` appends under the
maximum, and a rejected edit contributes nothing.
-/

namespace Research

/-- Maximum widgets per dashboard (`MARKET_LIMITS.maxWidgets`). -/
def MAX_DASHBOARD_WIDGETS : Nat := 24

structure Dashboard where
  ids : List Nat
  deriving Repr, DecidableEq

def Dashboard.empty : Dashboard := ⟨[]⟩

/-- The structural invariant: widget ids are unique. -/
def Dashboard.WellFormed (d : Dashboard) : Prop :=
  d.ids.Nodup

inductive DashboardEdit where
  | add (id : Nat)
  | remove (id : Nat)
  | moveEarlier (id : Nat)
  | moveLater (id : Nat)
  | reorder (id : Nat) (toIndex : Nat)
  deriving Repr

/-- Swap the first occurrence of `id` with its predecessor. -/
def swapWithPrev : List Nat → Nat → List Nat
  | [], _ => []
  | [x], _ => [x]
  | a :: b :: rest, id =>
    if b = id then id :: a :: rest
    else a :: swapWithPrev (b :: rest) id

/-- Swap the first occurrence of `id` with its successor. -/
def swapWithNext : List Nat → Nat → List Nat
  | [], _ => []
  | [x], _ => [x]
  | a :: b :: rest, id =>
    if a = id then b :: a :: rest
    else a :: swapWithNext (b :: rest) id

def moveEarlierIds (xs : List Nat) (id : Nat) : Option (List Nat) :=
  if id ∉ xs ∨ xs.head? = some id then none else some (swapWithPrev xs id)

def moveLaterIds (xs : List Nat) (id : Nat) : Option (List Nat) :=
  if id ∉ xs ∨ xs.getLast? = some id then none else some (swapWithNext xs id)

/-- Take `id` out and put it back so that it sits at index `k` of the result.
    Rejects an unknown id and an out-of-range target. -/
def reorderIds (xs : List Nat) (id k : Nat) : Option (List Nat) :=
  if id ∉ xs ∨ k ≥ xs.length then none else some ((xs.erase id).insertIdx k id)

def applyDashboardEdit (d : Dashboard) : DashboardEdit → Option Dashboard
  | .add id =>
    if id ∈ d.ids then none
    else if d.ids.length ≥ MAX_DASHBOARD_WIDGETS then none
    else some ⟨d.ids ++ [id]⟩
  | .remove id =>
    if id ∈ d.ids then some ⟨d.ids.filter (fun x => x != id)⟩ else none
  | .moveEarlier id => (moveEarlierIds d.ids id).map Dashboard.mk
  | .moveLater id => (moveLaterIds d.ids id).map Dashboard.mk
  | .reorder id k => (reorderIds d.ids id k).map Dashboard.mk

/-! ## Swap helpers -/

theorem length_swapWithPrev (xs : List Nat) (id : Nat) :
    (swapWithPrev xs id).length = xs.length := by
  induction xs with
  | nil => rfl
  | cons a rest ih =>
    cases rest with
    | nil => rfl
    | cons b tail =>
      simp only [swapWithPrev]
      by_cases h : b = id
      · rw [ifPos h]; rfl
      · rw [ifNeg h]; simp [ih]

theorem mem_swapWithPrev (xs : List Nat) (id x : Nat) :
    x ∈ swapWithPrev xs id ↔ x ∈ xs := by
  induction xs with
  | nil => simp [swapWithPrev]
  | cons a rest ih =>
    cases rest with
    | nil => simp [swapWithPrev]
    | cons b tail =>
      simp only [swapWithPrev]
      by_cases h : b = id
      · rw [ifPos h, h]
        simp only [List.mem_cons]
        constructor
        · rintro (rfl | rfl | hm)
          · exact Or.inr (Or.inl rfl)
          · exact Or.inl rfl
          · exact Or.inr (Or.inr hm)
        · rintro (rfl | rfl | hm)
          · exact Or.inr (Or.inl rfl)
          · exact Or.inl rfl
          · exact Or.inr (Or.inr hm)
      · rw [ifNeg h, List.mem_cons, List.mem_cons, ih]

theorem nodup_swapWithPrev {xs : List Nat} (hn : xs.Nodup) (id : Nat) :
    (swapWithPrev xs id).Nodup := by
  induction xs with
  | nil => simp [swapWithPrev]
  | cons a rest ih =>
    cases rest with
    | nil =>
      simp only [swapWithPrev]
      exact hn
    | cons b tail =>
      simp only [swapWithPrev]
      by_cases h : b = id
      · rw [ifPos h]
        obtain ⟨hna, hidt⟩ := List.nodup_cons.mp hn
        obtain ⟨hnid, hnt⟩ := List.nodup_cons.mp hidt
        have hane : a ≠ id := by
          intro heq
          apply hna
          rw [heq, h]
          exact List.mem_cons_self
        have hiat : id ∉ a :: tail := by
          simp only [List.mem_cons, not_or]
          refine ⟨fun heq => hane heq.symm, ?_⟩
          intro hm
          apply hnid
          rw [h]
          exact hm
        have hat : (a :: tail).Nodup := by
          apply List.nodup_cons.mpr
          constructor
          · intro hm
            apply hna
            exact List.mem_cons_of_mem _ hm
          · exact hnt
        exact List.nodup_cons.mpr ⟨hiat, hat⟩
      · rw [ifNeg h]
        obtain ⟨hna, hbt⟩ := List.nodup_cons.mp hn
        have hmem : a ∈ swapWithPrev (b :: tail) id ↔ a ∈ b :: tail :=
          mem_swapWithPrev (b :: tail) id a
        have hnotin : a ∉ swapWithPrev (b :: tail) id := fun hm => hna (hmem.mp hm)
        exact List.nodup_cons.mpr ⟨hnotin, ih hbt⟩

theorem length_swapWithNext (xs : List Nat) (id : Nat) :
    (swapWithNext xs id).length = xs.length := by
  induction xs with
  | nil => rfl
  | cons a rest ih =>
    cases rest with
    | nil => rfl
    | cons b tail =>
      simp only [swapWithNext]
      by_cases h : a = id
      · rw [ifPos h]; rfl
      · rw [ifNeg h]; simp [ih]

theorem mem_swapWithNext (xs : List Nat) (id x : Nat) :
    x ∈ swapWithNext xs id ↔ x ∈ xs := by
  induction xs with
  | nil => simp [swapWithNext]
  | cons a rest ih =>
    cases rest with
    | nil => simp [swapWithNext]
    | cons b tail =>
      simp only [swapWithNext]
      by_cases h : a = id
      · rw [ifPos h, h]
        simp only [List.mem_cons]
        constructor
        · rintro (rfl | rfl | hm)
          · exact Or.inr (Or.inl rfl)
          · exact Or.inl rfl
          · exact Or.inr (Or.inr hm)
        · rintro (rfl | rfl | hm)
          · exact Or.inr (Or.inl rfl)
          · exact Or.inl rfl
          · exact Or.inr (Or.inr hm)
      · rw [ifNeg h, List.mem_cons, List.mem_cons, ih]

theorem nodup_swapWithNext {xs : List Nat} (hn : xs.Nodup) (id : Nat) :
    (swapWithNext xs id).Nodup := by
  induction xs with
  | nil => simp [swapWithNext]
  | cons a rest ih =>
    cases rest with
    | nil =>
      simp only [swapWithNext]
      exact hn
    | cons b tail =>
      simp only [swapWithNext]
      by_cases h : a = id
      · rw [ifPos h]
        obtain ⟨hnid, hbt⟩ := List.nodup_cons.mp hn
        obtain ⟨hnb, hnt⟩ := List.nodup_cons.mp hbt
        have hbne : b ≠ id := by
          intro heq
          apply hnid
          rw [h, heq]
          exact List.mem_cons_self
        have hbin : b ∉ a :: tail := by
          simp only [List.mem_cons, not_or]
          exact ⟨fun heq => hbne (heq.trans h), hnb⟩
        have hrest : (a :: tail).Nodup := by
          apply List.nodup_cons.mpr
          constructor
          · intro hm
            apply hnid
            exact List.mem_cons_of_mem _ hm
          · exact hnt
        exact List.nodup_cons.mpr ⟨hbin, hrest⟩
      · rw [ifNeg h]
        obtain ⟨hna, hbt⟩ := List.nodup_cons.mp hn
        have hmem : a ∈ swapWithNext (b :: tail) id ↔ a ∈ b :: tail :=
          mem_swapWithNext (b :: tail) id a
        have hnotin : a ∉ swapWithNext (b :: tail) id := fun hm => hna (hmem.mp hm)
        exact List.nodup_cons.mpr ⟨hnotin, ih hbt⟩

/-! ## Reorder helpers -/

/-- Inserting a fresh id preserves uniqueness, at any index. -/
theorem nodup_insertIdx {xs : List Nat} (hn : xs.Nodup) {a : Nat} (ha : a ∉ xs) (k : Nat) :
    (xs.insertIdx k a).Nodup := by
  induction xs generalizing k with
  | nil =>
    cases k with
    | zero =>
      simp only [List.insertIdx_zero]
      exact List.nodup_cons.mpr ⟨ha, List.nodup_nil⟩
    | succ k => simp only [List.insertIdx_succ_nil, List.nodup_nil]
  | cons h t ih =>
    cases k with
    | zero =>
      simp only [List.insertIdx_zero]
      exact List.nodup_cons.mpr ⟨ha, hn⟩
    | succ k =>
      rw [List.insertIdx_succ_cons]
      obtain ⟨hnot, hnodup⟩ := List.nodup_cons.mp hn
      have hat : a ∉ t := fun hm => ha (List.mem_cons_of_mem _ hm)
      have hnotin : h ∉ t.insertIdx k a := by
        by_cases hk : k ≤ t.length
        · rw [List.mem_insertIdx hk]
          rintro (rfl | hm)
          · exact ha (List.mem_cons_self)
          · exact hnot hm
        · rw [List.insertIdx_of_length_lt (by omega)]
          exact hnot
      exact List.nodup_cons.mpr ⟨hnotin, ih hnodup hat k⟩

/-- Erasing the just-inserted id recovers the list it was inserted into. -/
theorem insertIdx_erase_cancel {xs : List Nat} {a : Nat} (ha : a ∉ xs) (k : Nat) :
    ((xs.insertIdx k a).erase a) = xs := by
  induction xs generalizing k with
  | nil =>
    cases k with
    | zero => simp [List.insertIdx_zero]
    | succ k => simp [List.insertIdx_succ_nil]
  | cons h t ih =>
    cases k with
    | zero => simp [List.insertIdx_zero]
    | succ k =>
      rw [List.insertIdx_succ_cons]
      have hne : ¬(h == a) := by
        intro hcon
        apply ha
        have heq : h = a := beq_iff_eq.mp hcon
        rw [heq]
        exact List.mem_cons_self
      rw [List.erase_cons_tail hne]
      have hat : a ∉ t := fun hm => ha (List.mem_cons_of_mem _ hm)
      rw [ih hat]

/-! ## Accepted edits -/

/-- **Uniqueness.** Every accepted edit preserves id uniqueness. -/
theorem edit_preserves_wellFormed {d d' : Dashboard} {e : DashboardEdit}
    (hw : d.WellFormed) (h : applyDashboardEdit d e = some d') : d'.WellFormed := by
  cases e with
  | add id =>
    simp only [applyDashboardEdit] at h
    by_cases hm : id ∈ d.ids
    · rw [ifPos hm] at h; cases h
    · rw [ifNeg hm] at h
      by_cases hl : d.ids.length ≥ MAX_DASHBOARD_WIDGETS
      · rw [ifPos hl] at h; cases h
      · rw [ifNeg hl] at h
        cases h
        exact nodup_append_singleton hw hm
  | remove id =>
    simp only [applyDashboardEdit] at h
    by_cases hm : id ∈ d.ids
    · rw [ifPos hm] at h
      cases h
      exact List.Pairwise.filter _ hw
    · rw [ifNeg hm] at h; cases h
  | moveEarlier id =>
    simp only [applyDashboardEdit, moveEarlierIds] at h
    by_cases hm : id ∉ d.ids ∨ d.ids.head? = some id
    · rw [ifPos hm] at h; simp at h
    · rw [ifNeg hm] at h
      simp only [Option.map_some] at h
      cases h
      exact nodup_swapWithPrev hw id
  | moveLater id =>
    simp only [applyDashboardEdit, moveLaterIds] at h
    by_cases hm : id ∉ d.ids ∨ d.ids.getLast? = some id
    · rw [ifPos hm] at h; simp at h
    · rw [ifNeg hm] at h
      simp only [Option.map_some] at h
      cases h
      exact nodup_swapWithNext hw id
  | reorder id k =>
    simp only [applyDashboardEdit, reorderIds] at h
    by_cases hm : id ∉ d.ids ∨ k ≥ d.ids.length
    · rw [ifPos hm] at h; simp at h
    · rw [ifNeg hm] at h
      simp only [Option.map_some] at h
      cases h
      exact nodup_insertIdx (hw.erase id) (List.Nodup.not_mem_erase hw) k

/-- **Add appends and never exceeds the maximum.** -/
theorem add_appends {d d' : Dashboard} {id : Nat}
    (h : applyDashboardEdit d (.add id) = some d') :
    d'.ids = d.ids ++ [id] ∧ d'.ids.length ≤ MAX_DASHBOARD_WIDGETS := by
  simp only [applyDashboardEdit] at h
  by_cases hm : id ∈ d.ids
  · rw [ifPos hm] at h; cases h
  · rw [ifNeg hm] at h
    by_cases hl : d.ids.length ≥ MAX_DASHBOARD_WIDGETS
    · rw [ifPos hl] at h; cases h
    · rw [ifNeg hl] at h
      cases h
      constructor
      · rfl
      · show (d.ids ++ [id]).length ≤ MAX_DASHBOARD_WIDGETS
        simp only [List.length_append, List.length_singleton]
        omega

/-- **Move is a permutation:** same length, same members. -/
theorem move_same_members {d d' : Dashboard} {id : Nat} {e : DashboardEdit}
    (hmove : e = .moveEarlier id ∨ e = .moveLater id)
    (h : applyDashboardEdit d e = some d') :
    d'.ids.length = d.ids.length ∧ ∀ x, x ∈ d'.ids ↔ x ∈ d.ids := by
  cases hmove with
  | inl hmove =>
    subst hmove
    simp only [applyDashboardEdit, moveEarlierIds] at h
    by_cases hm : id ∉ d.ids ∨ d.ids.head? = some id
    · rw [ifPos hm] at h; simp at h
    · rw [ifNeg hm] at h
      simp only [Option.map_some] at h
      cases h
      exact ⟨length_swapWithPrev _ _, mem_swapWithPrev _ _⟩
  | inr hmove =>
    subst hmove
    simp only [applyDashboardEdit, moveLaterIds] at h
    by_cases hm : id ∉ d.ids ∨ d.ids.getLast? = some id
    · rw [ifPos hm] at h; simp at h
    · rw [ifNeg hm] at h
      simp only [Option.map_some] at h
      cases h
      exact ⟨length_swapWithNext _ _, mem_swapWithNext _ _⟩

/-- What an accepted `reorder` looked like before accepting. -/
theorem reorderIds_accepted {xs : List Nat} {id k : Nat} {ys : List Nat}
    (h : reorderIds xs id k = some ys) :
    id ∈ xs ∧ k < xs.length ∧ ys = (xs.erase id).insertIdx k id := by
  simp only [reorderIds] at h
  by_cases hm : id ∉ xs ∨ k ≥ xs.length
  · rw [ifPos hm] at h; simp at h
  · have hmem : id ∈ xs :=
      Decidable.byContradiction (fun hc => hm (Or.inl hc))
    have hlt : k < xs.length :=
      Decidable.byContradiction (fun hc => hm (Or.inr (by omega)))
    rw [ifNeg hm] at h
    cases h
    exact ⟨hmem, hlt, rfl⟩

/-- Unpack an accepted `reorder`: the id is present, the target is in range,
    and the result is the erased list with the id inserted at the target. -/
theorem reorder_unpack {d d' : Dashboard} {id k : Nat}
    (h : applyDashboardEdit d (.reorder id k) = some d') :
    id ∈ d.ids ∧ k < d.ids.length ∧ d'.ids = (d.ids.erase id).insertIdx k id := by
  simp only [applyDashboardEdit] at h
  cases hr : reorderIds d.ids id k with
  | none => simp [hr] at h
  | some ys =>
    have hmk : Dashboard.mk ys = d' := by
      rw [hr] at h
      simpa using h
    subst hmk
    obtain ⟨hmem, hlt, rfl⟩ := reorderIds_accepted hr
    exact ⟨hmem, hlt, rfl⟩

/-- **A rejected `reorder` contributes nothing:** `none` exactly for an unknown
    id or an out-of-range target. -/
theorem reorderIds_none_iff {xs : List Nat} {id k : Nat} :
    reorderIds xs id k = none ↔ id ∉ xs ∨ k ≥ xs.length := by
  simp only [reorderIds]
  by_cases hm : id ∉ xs ∨ k ≥ xs.length
  · simp [hm]
  · simp [hm]

/-- **Reorder is a permutation:** same length, same members. -/
theorem reorder_same_members {d d' : Dashboard} {id k : Nat}
    (h : applyDashboardEdit d (.reorder id k) = some d') :
    d'.ids.length = d.ids.length ∧ ∀ x, x ∈ d'.ids ↔ x ∈ d.ids := by
  obtain ⟨hmem, hlt, heq⟩ := reorder_unpack h
  rw [heq]
  have hlen_erase : (d.ids.erase id).length = d.ids.length - 1 :=
    List.length_erase_of_mem hmem
  have hle : k ≤ (d.ids.erase id).length := by omega
  have hpos : 0 < d.ids.length := List.length_pos_of_mem hmem
  refine ⟨?_, fun x => ?_⟩
  · rw [List.length_insertIdx_of_le_length hle, hlen_erase]
    omega
  · rw [List.mem_insertIdx hle]
    constructor
    · rintro (rfl | hm)
      · exact hmem
      · exact List.mem_of_mem_erase hm
    · intro hx
      by_cases heq : x = id
      · exact Or.inl heq
      · exact Or.inr ((List.mem_erase_of_ne heq).mpr hx)

/-- **Reorder keeps the order of the rest:** erasing the moved id from the
    result gives the input with that id erased. -/
theorem reorder_keeps_order {d d' : Dashboard} {id k : Nat}
    (hw : d.WellFormed)
    (h : applyDashboardEdit d (.reorder id k) = some d') :
    d'.ids.erase id = d.ids.erase id := by
  obtain ⟨_, _, heq⟩ := reorder_unpack h
  rw [heq]
  exact insertIdx_erase_cancel (List.Nodup.not_mem_erase hw) k

/-- **The moved id lands where asked.** -/
theorem reorder_lands {d d' : Dashboard} {id k : Nat}
    (h : applyDashboardEdit d (.reorder id k) = some d') :
    d'.ids[k]? = some id := by
  obtain ⟨hmem, hlt, heq⟩ := reorder_unpack h
  rw [heq]
  have hle : k ≤ (d.ids.erase id).length := by
    rw [List.length_erase_of_mem hmem]
    omega
  rw [List.getElem?_insertIdx_self, ifPos hle]

/-- **Remove deletes exactly that id and keeps the relative order of the rest.** -/
theorem remove_deletes {d d' : Dashboard} {id : Nat}
    (h : applyDashboardEdit d (.remove id) = some d') :
    id ∉ d'.ids ∧ d'.ids = d.ids.filter (fun x => x != id) := by
  simp only [applyDashboardEdit] at h
  by_cases hm : id ∈ d.ids
  · rw [ifPos hm] at h
    cases h
    refine ⟨?_, rfl⟩
    intro hm
    rw [List.mem_filter] at hm
    simp at hm
  · rw [ifNeg hm] at h; cases h

/-! ## Sequences of edits

`runEdits` models consecutive owner edits: each against the then-current
dashboard, with rejected ones skipped (the UI disables the control, and the
server answers a version conflict without changing anything).
-/

def runEdits (d : Dashboard) : List DashboardEdit → Dashboard
  | [] => d
  | e :: rest =>
    match applyDashboardEdit d e with
    | some d' => runEdits d' rest
    | none => runEdits d rest

/-- However many edits are valid or invalid, the result is well formed. -/
theorem runEdits_wellFormed (edits : List DashboardEdit) :
    ∀ d : Dashboard, d.WellFormed → (runEdits d edits).WellFormed := by
  induction edits with
  | nil => intro d hd; exact hd
  | cons e rest ih =>
    intro d hd
    unfold runEdits
    cases hs : applyDashboardEdit d e with
    | some d' => exact ih d' (edit_preserves_wellFormed hd hs)
    | none => exact ih d hd

/-- **Rejected edits leave the dashboard unchanged.** -/
theorem rejected_edit_skipped (d : Dashboard) (e : DashboardEdit) (rest : List DashboardEdit)
    (h : applyDashboardEdit d e = none) :
    runEdits d (e :: rest) = runEdits d rest := by
  simp only [runEdits, h]

theorem dashboard_empty_wellFormed : Dashboard.empty.WellFormed := List.nodup_nil

end Research
