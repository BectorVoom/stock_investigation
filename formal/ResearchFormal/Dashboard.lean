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
well formed. What is proved here is the id structure of `add`, `remove` and
`move`: uniqueness is preserved, `move` permutes, `remove` deletes exactly one
id keeping the order of the rest, `add` appends under the maximum, and a
rejected edit contributes nothing.
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

def applyDashboardEdit (d : Dashboard) : DashboardEdit → Option Dashboard
  | .add id =>
    if id ∈ d.ids then none
    else if d.ids.length ≥ MAX_DASHBOARD_WIDGETS then none
    else some ⟨d.ids ++ [id]⟩
  | .remove id =>
    if id ∈ d.ids then some ⟨d.ids.filter (fun x => x != id)⟩ else none
  | .moveEarlier id => (moveEarlierIds d.ids id).map Dashboard.mk
  | .moveLater id => (moveLaterIds d.ids id).map Dashboard.mk

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
