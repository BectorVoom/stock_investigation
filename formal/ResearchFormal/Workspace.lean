import ResearchFormal.Basic

/-!
# Workspace command reducer

Formal model of the structural part of `applyUiCommand` in
`packages/domain/src/workspace/reducer.ts` (section 7, rules UI-006, ARCH-016).

Component ids are natural numbers and component props are abstracted away:
`touch` stands for every operation that needs an existing component but leaves
the set of components and the layout untouched (update, focus, select, bind).
-/

namespace Research

structure Workspace where
  /-- Monotonic version; every accepted command increments it by one. -/
  version : Nat
  components : List Nat
  /-- Display order. -/
  order : List Nat
  deriving Repr, DecidableEq

def Workspace.empty : Workspace := ⟨0, [], []⟩

/--
The structural invariant of a workspace: component ids are unique, and the
layout lists every component exactly once.
-/
def Workspace.WellFormed (w : Workspace) : Prop :=
  w.components.Nodup ∧ w.order.Nodup ∧ ∀ x, x ∈ w.order ↔ x ∈ w.components

inductive Operation where
  | create (id : Nat)
  | remove (id : Nat)
  | reorder (order : List Nat)
  | touch (id : Nat)
  deriving Repr

/--
The reducer's layout check, exactly as implemented: the proposed order has no
duplicates, has as many entries as there are components, and names only
existing components. (It does not check the converse inclusion; that it follows
anyway is `layout_covers_components` below.)
-/
def IsLayoutOf (order components : List Nat) : Prop :=
  order.Nodup ∧ order.length = components.length ∧ ∀ x ∈ order, x ∈ components

instance (order components : List Nat) : Decidable (IsLayoutOf order components) := by
  unfold IsLayoutOf
  exact inferInstance

/-- Effect of one operation on the structure, ignoring the version precondition. -/
def step (w : Workspace) : Operation → Option Workspace
  | .create id =>
    if id ∈ w.components then none
    else some ⟨w.version + 1, w.components ++ [id], w.order ++ [id]⟩
  | .remove id =>
    if id ∈ w.components then
      some ⟨w.version + 1, w.components.filter (fun x => x != id), w.order.filter (fun x => x != id)⟩
    else none
  | .reorder order =>
    if IsLayoutOf order w.components then some ⟨w.version + 1, w.components, order⟩ else none
  | .touch id =>
    if id ∈ w.components then some ⟨w.version + 1, w.components, w.order⟩ else none

/-- A command is an operation plus the version its author believed was current. -/
def applyCommand (w : Workspace) (expectedVersion : Nat) (op : Operation) : Option Workspace :=
  if expectedVersion ≠ w.version then none else step w op

/-! ## Versioning -/

theorem step_bumps_version {w w' : Workspace} {op : Operation} (h : step w op = some w') :
    w'.version = w.version + 1 := by
  cases op with
  | create id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h; cases h
    · rw [ifNeg hm] at h; cases h; rfl
  | remove id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h; cases h; rfl
    · rw [ifNeg hm] at h; cases h
  | reorder order =>
    simp only [step] at h
    by_cases hl : IsLayoutOf order w.components
    · rw [ifPos hl] at h; cases h; rfl
    · rw [ifNeg hl] at h; cases h
  | touch id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h; cases h; rfl
    · rw [ifNeg hm] at h; cases h

/-- An accepted command was written against the current version and bumps it by exactly one. -/
theorem accepted_command_version {w w' : Workspace} {e : Nat} {op : Operation}
    (h : applyCommand w e op = some w') : e = w.version ∧ w'.version = w.version + 1 := by
  unfold applyCommand at h
  by_cases he : e ≠ w.version
  · rw [ifPos he] at h; cases h
  · rw [ifNeg he] at h
    exact ⟨Classical.not_not.mp he, step_bumps_version h⟩

/-- **Compare-and-set.** A command written against any other version is rejected. -/
theorem stale_command_rejected (w : Workspace) (e : Nat) (op : Operation) (h : e ≠ w.version) :
    applyCommand w e op = none := by
  unfold applyCommand
  rw [ifPos h]

/--
**Idempotent submission.** Once a command has been accepted, submitting any
command with the same expected version again is rejected: the same command can
never be applied twice.
-/
theorem replay_rejected {w w' : Workspace} {e : Nat} {op : Operation}
    (h : applyCommand w e op = some w') (op' : Operation) : applyCommand w' e op' = none := by
  obtain ⟨he, hv⟩ := accepted_command_version h
  apply stale_command_rejected
  omega

/-! ## Structural invariant -/

theorem nodup_append_singleton {l : List Nat} {a : Nat} (hl : l.Nodup) (ha : a ∉ l) :
    (l ++ [a]).Nodup := by
  induction l with
  | nil => simp
  | cons b l ih =>
    obtain ⟨hb, hl'⟩ := List.nodup_cons.mp hl
    have hab : a ≠ b := fun h => ha (h ▸ List.mem_cons_self)
    have hal : a ∉ l := fun h => ha (List.mem_cons_of_mem _ h)
    have hbl : b ∉ l ++ [a] := by
      intro hmem
      rcases List.mem_append.mp hmem with h | h
      · exact hb h
      · exact hab (List.mem_singleton.mp h).symm
    exact List.nodup_cons.mpr ⟨hbl, ih hl' hal⟩

/--
Pigeonhole: a duplicate-free list drawn from `cs` and as long as `cs` contains
every element of `cs`. This is what makes the reducer's one-directional layout
check sufficient.
-/
theorem covers_of_nodup_of_length_eq :
    ∀ (o cs : List Nat), o.Nodup → (∀ x ∈ o, x ∈ cs) → o.length = cs.length → ∀ x ∈ cs, x ∈ o
  | [], cs, _, _, hlen, x, hx => by
    have hnil : cs = [] := List.eq_nil_of_length_eq_zero hlen.symm
    rw [hnil] at hx
    exact absurd hx List.not_mem_nil
  | a :: o, cs, hnd, hsub, hlen, x, hx => by
    obtain ⟨hna, hnd'⟩ := List.nodup_cons.mp hnd
    have ha : a ∈ cs := hsub a List.mem_cons_self
    have hsub' : ∀ y ∈ o, y ∈ cs.erase a := by
      intro y hy
      have hne : y ≠ a := fun h => hna (h ▸ hy)
      exact (List.mem_erase_of_ne hne).mpr (hsub y (List.mem_cons_of_mem _ hy))
    have hlen' : o.length = (cs.erase a).length := by
      rw [List.length_erase_of_mem ha]
      simp only [List.length_cons] at hlen
      omega
    have ih := covers_of_nodup_of_length_eq o (cs.erase a) hnd' hsub' hlen'
    by_cases hxa : x = a
    · rw [hxa]; exact List.mem_cons_self
    · exact List.mem_cons_of_mem _ (ih x ((List.mem_erase_of_ne hxa).mpr hx))

/-- A layout accepted by the reducer mentions every component. -/
theorem layout_covers_components {order components : List Nat} (h : IsLayoutOf order components) :
    ∀ x, x ∈ order ↔ x ∈ components :=
  fun x => ⟨h.2.2 x, covers_of_nodup_of_length_eq order components h.1 h.2.2 h.2.1 x⟩

/-- **Invariant preservation.** Every accepted operation keeps the workspace well formed. -/
theorem step_preserves_wellFormed {w w' : Workspace} {op : Operation} (hw : w.WellFormed)
    (h : step w op = some w') : w'.WellFormed := by
  obtain ⟨hc, ho, hmem⟩ := hw
  cases op with
  | create id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h; cases h
    · rw [ifNeg hm] at h
      cases h
      have hmo : id ∉ w.order := fun hin => hm ((hmem id).mp hin)
      refine ⟨nodup_append_singleton hc hm, nodup_append_singleton ho hmo, ?_⟩
      intro x
      simp only [List.mem_append, List.mem_singleton]
      rw [hmem x]
  | remove id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h
      cases h
      refine ⟨List.Pairwise.filter _ hc, List.Pairwise.filter _ ho, ?_⟩
      intro x
      simp only [List.mem_filter]
      rw [hmem x]
    · rw [ifNeg hm] at h; cases h
  | reorder order =>
    simp only [step] at h
    by_cases hl : IsLayoutOf order w.components
    · rw [ifPos hl] at h
      cases h
      exact ⟨hc, hl.1, layout_covers_components hl⟩
    · rw [ifNeg hl] at h; cases h
  | touch id =>
    simp only [step] at h
    by_cases hm : id ∈ w.components
    · rw [ifPos hm] at h
      cases h
      exact ⟨hc, ho, hmem⟩
    · rw [ifNeg hm] at h; cases h

theorem empty_wellFormed : Workspace.empty.WellFormed := by
  refine ⟨List.nodup_nil, List.nodup_nil, ?_⟩
  intro x
  simp [Workspace.empty]

/-- After an accepted create the component exists and is laid out last. -/
theorem create_adds_component {w w' : Workspace} {id : Nat}
    (h : step w (.create id) = some w') : id ∈ w'.components ∧ id ∈ w'.order := by
  simp only [step] at h
  by_cases hm : id ∈ w.components
  · rw [ifPos hm] at h; cases h
  · rw [ifNeg hm] at h
    cases h
    exact ⟨List.mem_append.mpr (Or.inr List.mem_cons_self),
      List.mem_append.mpr (Or.inr List.mem_cons_self)⟩

/-- After an accepted remove the component is gone from both the set and the layout. -/
theorem remove_deletes_component {w w' : Workspace} {id : Nat}
    (h : step w (.remove id) = some w') : id ∉ w'.components ∧ id ∉ w'.order := by
  simp only [step] at h
  by_cases hm : id ∈ w.components
  · rw [ifPos hm] at h
    cases h
    constructor <;> simp [List.mem_filter]
  · rw [ifNeg hm] at h; cases h

/-- A duplicate create is rejected, so a component id is never overwritten. -/
theorem duplicate_create_rejected (w : Workspace) (id : Nat) (h : id ∈ w.components) :
    step w (.create id) = none := by
  simp only [step]
  rw [ifPos h]

/-! ## Sequences of operations

`runOperations` models how a research run's display instructions are applied:
each in order against the then-current version, with rejected ones skipped.
-/

def runOperations (w : Workspace) : List Operation → Workspace
  | [] => w
  | op :: rest =>
    match step w op with
    | some w' => runOperations w' rest
    | none => runOperations w rest

/-- However many instructions are valid or invalid, the result is well formed. -/
theorem runOperations_wellFormed (ops : List Operation) :
    ∀ w : Workspace, w.WellFormed → (runOperations w ops).WellFormed := by
  induction ops with
  | nil => intro w hw; exact hw
  | cons op rest ih =>
    intro w hw
    unfold runOperations
    cases hs : step w op with
    | some w' => exact ih w' (step_preserves_wellFormed hw hs)
    | none => exact ih w hw

/-- The version never goes backwards and grows by at most one per instruction. -/
theorem runOperations_version (ops : List Operation) :
    ∀ w : Workspace,
      w.version ≤ (runOperations w ops).version ∧
      (runOperations w ops).version ≤ w.version + ops.length := by
  induction ops with
  | nil => intro w; exact ⟨Nat.le_refl _, Nat.le_refl _⟩
  | cons op rest ih =>
    intro w
    unfold runOperations
    cases hs : step w op with
    | some w' =>
      have hv := step_bumps_version hs
      have := ih w'
      simp only [List.length_cons]
      omega
    | none =>
      have := ih w
      simp only [List.length_cons]
      omega

end Research
