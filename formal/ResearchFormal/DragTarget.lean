import ResearchFormal.Basic

/-!
# Drop-target decision for widget drags

Formal model of `nextDropTarget` in
`packages/widget-grid/src/core/dragModel.ts` (ADR-0019).

Coordinates are integers (`Int`). The TypeScript uses doubles, but every
conformance vector is integral, so the two agree exactly on the grid. The
TypeScript compares the pointer against slot centers `(left + right) / 2`;
to stay in integers the model uses *doubled* centers (`left + right`).
Halving every term divides the dot product
`(hoverCenter - draggedCenter) · (pointer - hoverCenter)` by 4, a positive
factor, so the sign — the only thing the decision reads — is unchanged.

Indices are natural numbers: `draggedIndex`, `target` and `banned` are
preview positions, always non-negative in the engine (a negative
`draggedIndex` is outside the `Nat` model; the implementation holds still
for it, exactly as for any out-of-range index).

The engine invariant is `previous.target = draggedIndex`: after every
decision the preview is re-measured in the new order, so the dragged widget
sits at the last target. The vectors carry mostly engine-shaped histories
plus a few with a different target. `banned_only_while_inside` assumes the
invariant: without it a commit could land exactly on `previous.target` with
a fresh ban, and a fresh ban is not "held" anywhere yet — see that theorem.
-/

namespace Research

/-- A slot rectangle in the current preview order. -/
structure SlotRect where
  left : Int
  top : Int
  right : Int
  bottom : Int
  deriving Repr, DecidableEq

/-- The previous (and next) drop-target decision. -/
structure DragHistory where
  target : Nat
  banned : Option Nat
  deriving Repr, DecidableEq

/-- Inclusive on all four edges, as in the TypeScript `contains`. -/
def contains (r : SlotRect) (px py : Int) : Bool :=
  decide (r.left ≤ px ∧ px ≤ r.right ∧ r.top ≤ py ∧ py ≤ r.bottom)

/-- Doubled center coordinates, so all arithmetic stays in `Int`. -/
def centerX2 (r : SlotRect) : Int := r.left + r.right
def centerY2 (r : SlotRect) : Int := r.top + r.bottom

/-- Lowest-indexed slot containing the pointer among indices `0..n-1`.
    `findHover slots px py` is this with `n = slots.length`: the first
    hovered slot wins, as in the TypeScript loop with `break`. -/
def hoverAt (slots : List SlotRect) (px py : Int) (n : Nat) : Option Nat :=
  match n with
  | 0 => none
  | m + 1 =>
    match hoverAt slots px py m with
    | some h => some h
    | none =>
      match slots[m]? with
      | some r => if contains r px py then some m else none
      | none => none

def findHover (slots : List SlotRect) (px py : Int) : Option Nat :=
  hoverAt slots px py slots.length

/-- One search step, definitionally: used to unfold a single fuel layer. -/
theorem hoverAt_step (slots : List SlotRect) (px py : Int) (m : Nat) :
    hoverAt slots px py (m + 1) =
      (match hoverAt slots px py m with
       | some h => some h
       | none =>
         match slots[m]? with
         | some r => if contains r px py then some m else none
         | none => none) := rfl

/-- A found hover lies within the searched prefix and inside the engine
    range once the fuel is the slot count. -/
theorem hoverAt_some (slots : List SlotRect) (px py : Int) :
    ∀ (n : Nat), n ≤ slots.length → ∀ {h : Nat},
    hoverAt slots px py n = some h →
    h < slots.length ∧ ∃ r, slots[h]? = some r ∧ contains r px py = true := by
  intro n
  induction n with
  | zero =>
    intro _ _ hh
    simp [hoverAt] at hh
  | succ m ih =>
    intro hle h hh
    simp only [hoverAt_step] at hh
    cases hm : hoverAt slots px py m with
    | some _ =>
      simp only [hm] at hh
      cases hh
      exact ih (by omega) hm
    | none =>
      simp only [hm] at hh
      cases hsm : slots[m]? with
      | none =>
        simp only [hsm] at hh
        cases hh
      | some r =>
        simp only [hsm] at hh
        by_cases hc : contains r px py = true
        · simp only [ifPos hc] at hh
          cases hh
          exact ⟨by omega, r, hsm, hc⟩
        · simp only [ifNeg hc] at hh
          simp at hh

/-- A failed search means no searched slot contains the pointer. -/
theorem hoverAt_none_all (slots : List SlotRect) (px py : Int) :
    ∀ (n : Nat) (m : Nat) (r : SlotRect),
    hoverAt slots px py n = none → m < n → slots[m]? = some r →
    contains r px py = false := by
  intro n
  induction n with
  | zero =>
    intro m _ _ hlt _
    omega
  | succ m ih =>
    intro k r hh hlt hr
    simp only [hoverAt_step] at hh
    cases hm : hoverAt slots px py m with
    | some _ =>
      simp only [hm] at hh
      cases hh
    | none =>
      simp only [hm] at hh
      by_cases hkm : k = m
      · subst hkm
        simp only [hr] at hh
        by_cases hc : contains r px py = true
        · simp only [ifPos hc] at hh
          simp at hh
        · cases hcc : contains r px py with
          | true => exact absurd hcc hc
          | false => rfl
      · exact ih k r hm (by omega) hr

/-- No slot under the pointer means the search fails. -/
theorem hoverAt_none_of_outside {slots : List SlotRect} {px py : Int}
    (h : ∀ m, m < slots.length → ∀ r, slots[m]? = some r →
      contains r px py = false) :
    hoverAt slots px py slots.length = none := by
  have key : ∀ n, n ≤ slots.length →
      (∀ m, m < n → ∀ r, slots[m]? = some r → contains r px py = false) →
      hoverAt slots px py n = none := by
    intro n
    induction n with
    | zero =>
      intro _ _
      rfl
    | succ m ih =>
      intro hle hsub
      simp only [hoverAt_step]
      have hm : hoverAt slots px py m = none :=
        ih (by omega) (fun k hk r hr => hsub k (by omega) r hr)
      simp only [hm]
      cases hsm : slots[m]? with
      | none => rfl
      | some r =>
        have hc : contains r px py = false :=
          hsub m (Nat.lt_succ_self m) r hsm
        simp [hsm, hc]
  exact key slots.length (Nat.le_refl _) (fun m hm r hr => h m hm r hr)

/-- Keep the ban only while the pointer stays inside the banned slot;
    a dangling index clears it, as in the TypeScript. -/
def bannedStillHeld (slots : List SlotRect) (banned : Option Nat)
    (px py : Int) : Option Nat :=
  match banned with
  | none => none
  | some b =>
    match slots[b]? with
    | none => none
    | some r => if contains r px py then some b else none

/-- A held ban is the previous one, over a slot holding the pointer. -/
theorem bannedStillHeld_some {slots : List SlotRect} {px py : Int}
    {previous banned : Option Nat} {b : Nat}
    (hh : bannedStillHeld slots previous px py = banned)
    (hb : banned = some b) :
    previous = some b ∧ ∃ r, slots[b]? = some r ∧ contains r px py = true := by
  unfold bannedStillHeld at hh
  cases hpb : previous with
  | none =>
    simp only [hpb, hb] at hh
    cases hh
  | some b' =>
    simp only [hpb] at hh
    cases hsb : slots[b']? with
    | none =>
      simp only [hsb, hb] at hh
      cases hh
    | some r =>
      simp only [hsb] at hh
      by_cases hc : contains r px py = true
      · simp only [ifPos hc, hb] at hh
        cases hh
        exact ⟨rfl, r, hsb, hc⟩
      · simp only [ifNeg hc, hb] at hh
        cases hh

/-- The ban survives exactly while the pointer stays inside its slot. -/
theorem bannedStillHeld_inside {slots : List SlotRect} {px py : Int}
    {b : Nat} {r : SlotRect}
    (hr : slots[b]? = some r) (hc : contains r px py = true) :
    bannedStillHeld slots (some b) px py = some b := by
  simp [bannedStillHeld, hr, hc]

/-- The next drop target, branch by branch as in the TypeScript: hold when
    there are fewer than two slots or the dragged index is out of range;
    hold when the pointer is in no slot or over the dragged slot;
    hysteresis on the banned slot; commit past the midpoint (doubled-center
    dot product `> 0`), with coincident centers committing outright. -/
def nextDropTarget (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory) : DragHistory :=
  if slots.length ≤ 1 then
    { target := previous.target,
      banned := bannedStillHeld slots previous.banned px py }
  else if slots.length ≤ draggedIndex then
    { target := previous.target,
      banned := bannedStillHeld slots previous.banned px py }
  else
    match findHover slots px py with
    | none =>
      { target := previous.target,
        banned := bannedStillHeld slots previous.banned px py }
    | some hover =>
      if hover = draggedIndex then
        { target := previous.target,
          banned := bannedStillHeld slots previous.banned px py }
      else if previous.banned = some hover then
        { target := previous.target, banned := previous.banned }
      else
        match slots[draggedIndex]? with
        | none =>
          { target := previous.target,
            banned := bannedStillHeld slots previous.banned px py }
        | some d =>
          match slots[hover]? with
          | none =>
            { target := previous.target,
              banned := bannedStillHeld slots previous.banned px py }
          | some h =>
            if centerX2 h - centerX2 d = 0 ∧ centerY2 h - centerY2 d = 0 then
              { target := hover, banned := some draggedIndex }
            else
              if (centerX2 h - centerX2 d) * (2 * px - centerX2 h)
                  + (centerY2 h - centerY2 d) * (2 * py - centerY2 h) ≤ 0 then
                { target := previous.target,
                  banned := bannedStillHeld slots previous.banned px py }
              else
                { target := hover, banned := some draggedIndex }

/-! ## Safety: the target is always usable -/

/-- The returned target is the previous target, or the index of a slot
    that contains the pointer. -/
theorem target_previous_or_hover (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory) :
    (nextDropTarget slots draggedIndex px py previous).target = previous.target ∨
    (∃ i r, slots[i]? = some r ∧ contains r px py = true ∧
      (nextDropTarget slots draggedIndex px py previous).target = i) := by
  unfold nextDropTarget
  by_cases h1 : slots.length ≤ 1
  · simp [ifPos h1]
  · simp only [ifNeg h1] at ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp [ifPos h2]
    · simp only [ifNeg h2] at ⊢
      cases hfh : findHover slots px py with
      | none => simp [hfh]
      | some hover =>
        simp only [hfh] at ⊢
        by_cases heq : hover = draggedIndex
        · simp [ifPos heq]
        · simp only [ifNeg heq] at ⊢
          by_cases hb : previous.banned = some hover
          · simp [ifPos hb]
          · simp only [ifNeg hb] at ⊢
            cases hd : slots[draggedIndex]? with
            | none => simp [hd]
            | some d =>
              simp only [hd] at ⊢
              cases hhv : slots[hover]? with
              | none => simp [hhv]
              | some h =>
                simp only [hhv] at ⊢
                obtain ⟨r, hr, hcr⟩ :=
                  (hoverAt_some slots px py _ (Nat.le_refl _) hfh).2
                simp only [hhv] at hr
                cases hr
                by_cases hc : centerX2 h - centerX2 d = 0 ∧
                    centerY2 h - centerY2 d = 0
                · simp only [ifPos hc] at ⊢
                  refine Or.inr ⟨hover, h, hhv, hcr, ?_⟩
                  simp
                · simp only [ifNeg hc] at ⊢
                  by_cases hdot : (centerX2 h - centerX2 d) * (2 * px - centerX2 h)
                      + (centerY2 h - centerY2 d) * (2 * py - centerY2 h) ≤ 0
                  · simp [ifPos hdot]
                  · simp only [ifNeg hdot] at ⊢
                    refine Or.inr ⟨hover, h, hhv, hcr, ?_⟩
                    simp

/-- If the previous target splices in range, so does the returned one:
    the drag engine can always splice at it. -/
theorem target_in_range (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory)
    (hprev : previous.target < slots.length) :
    (nextDropTarget slots draggedIndex px py previous).target < slots.length := by
  unfold nextDropTarget
  by_cases h1 : slots.length ≤ 1
  · simp only [ifPos h1] at ⊢
    exact hprev
  · simp only [ifNeg h1] at ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp only [ifPos h2] at ⊢
      exact hprev
    · simp only [ifNeg h2] at ⊢
      cases hfh : findHover slots px py with
      | none =>
        simp only [hfh] at ⊢
        exact hprev
      | some hover =>
        simp only [hfh] at ⊢
        by_cases heq : hover = draggedIndex
        · simp only [ifPos heq] at ⊢
          exact hprev
        · simp only [ifNeg heq] at ⊢
          by_cases hb : previous.banned = some hover
          · simp only [ifPos hb] at ⊢
            exact hprev
          · simp only [ifNeg hb] at ⊢
            cases hd : slots[draggedIndex]? with
            | none =>
              simp only [hd] at ⊢
              exact hprev
            | some dslot =>
              simp only [hd] at ⊢
              cases hhv : slots[hover]? with
              | none =>
                simp only [hhv] at ⊢
                exact hprev
              | some drect =>
                simp only [hhv] at ⊢
                by_cases hc : centerX2 drect - centerX2 dslot = 0 ∧
                    centerY2 drect - centerY2 dslot = 0
                · simp only [ifPos hc] at ⊢
                  exact (hoverAt_some slots px py _ (Nat.le_refl _) hfh).1
                · simp only [ifNeg hc] at ⊢
                  by_cases hdot : (centerX2 drect - centerX2 dslot) * (2 * px - centerX2 drect)
                      + (centerY2 drect - centerY2 dslot) * (2 * py - centerY2 drect) ≤ 0
                  · simp only [ifPos hdot] at ⊢
                    exact hprev
                  · simp only [ifNeg hdot] at ⊢
                    exact (hoverAt_some slots px py _ (Nat.le_refl _) hfh).1

/-! ## Stability: the target holds unless the pointer commits -/

/-- When no slot contains the pointer, the target is unchanged. -/
theorem hold_outside_slots (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory)
    (hempty : ∀ (i : Nat) (r : SlotRect), slots[i]? = some r → contains r px py = false) :
    (nextDropTarget slots draggedIndex px py previous).target = previous.target := by
  have hnone : findHover slots px py = none :=
    hoverAt_none_of_outside (fun m _ r hr => hempty m r hr)
  unfold nextDropTarget
  by_cases h1 : slots.length ≤ 1
  · simp [ifPos h1]
  · simp only [ifNeg h1] at ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp [ifPos h2]
    · simp [ifNeg h2, hnone]

/-- Hysteresis: while the pointer stays inside the banned slot, the whole
    decision is unchanged — the widget just swapped with cannot swap back. -/
theorem hold_over_banned (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory) {hover : Nat}
    (hfh : findHover slots px py = some hover)
    (hb : previous.banned = some hover) :
    nextDropTarget slots draggedIndex px py previous = previous := by
  obtain ⟨r, hr, hcr⟩ := (hoverAt_some slots px py _ (Nat.le_refl _) hfh).2
  have hheld : bannedStillHeld slots previous.banned px py = previous.banned := by
    simp only [hb] at ⊢
    exact bannedStillHeld_inside hr hcr
  unfold nextDropTarget
  by_cases h1 : slots.length ≤ 1
  · simp [ifPos h1, hheld]
  · simp only [ifNeg h1] at ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp [ifPos h2, hheld]
    · simp only [ifNeg h2, hfh] at ⊢
      by_cases heq : hover = draggedIndex
      · simp [ifPos heq, hheld]
      · simp [ifNeg heq, ifPos hb]

/-- Whenever the target changes, the new ban is the vacated index. -/
theorem commit_bans_vacated (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory)
    (hchange : (nextDropTarget slots draggedIndex px py previous).target ≠
      previous.target) :
    (nextDropTarget slots draggedIndex px py previous).banned =
      some draggedIndex := by
  unfold nextDropTarget at hchange ⊢
  by_cases h1 : slots.length ≤ 1
  · simp [ifPos h1] at hchange
  · simp only [ifNeg h1] at hchange ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp [ifPos h2] at hchange
    · simp only [ifNeg h2] at hchange ⊢
      cases hfh : findHover slots px py with
      | none => simp [hfh] at hchange
      | some hover =>
        simp only [hfh] at hchange ⊢
        by_cases heq : hover = draggedIndex
        · simp [ifPos heq] at hchange
        · simp only [ifNeg heq] at hchange ⊢
          by_cases hb : previous.banned = some hover
          · simp [ifPos hb] at hchange
          · simp only [ifNeg hb] at hchange ⊢
            cases hd : slots[draggedIndex]? with
            | none => simp [hd] at hchange
            | some dcb =>
              simp only [hd] at hchange ⊢
              cases hhv : slots[hover]? with
              | none => simp [hhv] at hchange
              | some hcb =>
                simp only [hhv] at hchange ⊢
                by_cases hc : centerX2 hcb - centerX2 dcb = 0 ∧
                    centerY2 hcb - centerY2 dcb = 0
                · simp only [ifPos hc] at hchange ⊢
                · simp only [ifNeg hc] at hchange ⊢
                  by_cases hdot : (centerX2 hcb - centerX2 dcb) * (2 * px - centerX2 hcb)
                      + (centerY2 hcb - centerY2 dcb) * (2 * py - centerY2 hcb) ≤ 0
                  · simp [ifPos hdot] at hchange
                  · simp only [ifNeg hdot] at hchange ⊢

/-- Whenever the target changes, the pointer is strictly past the hovered
    slot's doubled center in the direction away from the dragged slot
    (dot product `> 0`), or the two centers coincide. -/
theorem commit_needs_crossing (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory)
    (hchange : (nextDropTarget slots draggedIndex px py previous).target ≠
      previous.target) :
    ∃ hover hrect drect,
      findHover slots px py = some hover ∧
      slots[hover]? = some hrect ∧ slots[draggedIndex]? = some drect ∧
      ((centerX2 hrect - centerX2 drect) * (2 * px - centerX2 hrect)
        + (centerY2 hrect - centerY2 drect) * (2 * py - centerY2 hrect) > 0 ∨
       (centerX2 hrect - centerX2 drect = 0 ∧
        centerY2 hrect - centerY2 drect = 0)) := by
  unfold nextDropTarget at hchange
  by_cases h1 : slots.length ≤ 1
  · simp [ifPos h1] at hchange
  · simp only [ifNeg h1] at hchange
    by_cases h2 : slots.length ≤ draggedIndex
    · simp [ifPos h2] at hchange
    · simp only [ifNeg h2] at hchange
      cases hfh : findHover slots px py with
      | none => simp [hfh] at hchange
      | some hover =>
        simp only [hfh] at hchange
        by_cases heq : hover = draggedIndex
        · simp [ifPos heq] at hchange
        · simp only [ifNeg heq] at hchange
          by_cases hb : previous.banned = some hover
          · simp [ifPos hb] at hchange
          · simp only [ifNeg hb] at hchange
            cases hd : slots[draggedIndex]? with
            | none => simp [hd] at hchange
            | some d =>
              simp only [hd] at hchange
              cases hhv : slots[hover]? with
              | none => simp [hhv] at hchange
              | some h =>
                simp only [hhv] at hchange
                by_cases hc : centerX2 h - centerX2 d = 0 ∧
                    centerY2 h - centerY2 d = 0
                · simp only [ifPos hc] at hchange
                  exact ⟨hover, h, d, rfl, hhv, rfl, Or.inr hc⟩
                · simp only [ifNeg hc] at hchange
                  by_cases hdot : (centerX2 h - centerX2 d) * (2 * px - centerX2 h)
                      + (centerY2 h - centerY2 d) * (2 * py - centerY2 h) ≤ 0
                  · simp [ifPos hdot] at hchange
                  · simp only [ifNeg hdot] at hchange
                    exact ⟨hover, h, d, rfl, hhv, rfl, Or.inl (by omega)⟩

/-- Under the engine invariant (`previous.target = draggedIndex`: the engine
    re-measures the slots in the new preview order after every decision, so
    the dragged widget always sits at the last target), a held target keeps
    the ban only while the pointer stays inside it: a ban never outlives the
    pointer leaving the slot.

    The invariant is load-bearing: without it a commit could land exactly on
    `previous.target` with a fresh ban (two neighbour slots, dragged 0,
    `previous = { target := 1, banned := none }`, pointer deep inside slot 1
    commits to `{ target := 1, banned := some 0 }`), and a fresh ban is not
    "held" anywhere yet. -/
theorem banned_only_while_inside (slots : List SlotRect) (draggedIndex : Nat)
    (px py : Int) (previous : DragHistory)
    (heng : previous.target = draggedIndex)
    (hsame : (nextDropTarget slots draggedIndex px py previous).target =
      previous.target) :
    (nextDropTarget slots draggedIndex px py previous).banned = none ∨
    (∃ b, (nextDropTarget slots draggedIndex px py previous).banned = some b ∧
      previous.banned = some b ∧
      ∃ r, slots[b]? = some r ∧ contains r px py = true) := by
  unfold nextDropTarget at hsame ⊢
  by_cases h1 : slots.length ≤ 1
  · simp only [ifPos h1] at hsame ⊢
    cases hh : bannedStillHeld slots previous.banned px py with
    | none => simp
    | some b =>
      obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
      exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
  · simp only [ifNeg h1] at hsame ⊢
    by_cases h2 : slots.length ≤ draggedIndex
    · simp only [ifPos h2] at hsame ⊢
      cases hh : bannedStillHeld slots previous.banned px py with
      | none => simp
      | some b =>
        obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
        exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
    · simp only [ifNeg h2] at hsame ⊢
      cases hfh : findHover slots px py with
      | none =>
        simp only [hfh] at hsame ⊢
        cases hh : bannedStillHeld slots previous.banned px py with
        | none => simp
        | some b =>
          obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
          exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
      | some hover =>
        simp only [hfh] at hsame ⊢
        by_cases heq : hover = draggedIndex
        · simp only [ifPos heq] at hsame ⊢
          cases hh : bannedStillHeld slots previous.banned px py with
          | none => simp
          | some b =>
            obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
            exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
        · simp only [ifNeg heq] at hsame ⊢
          by_cases hb : previous.banned = some hover
          · simp only [ifPos hb] at hsame ⊢
            cases hpb : previous.banned with
            | none => simp
            | some b =>
              have hbeq : hover = b := by
                injection hb.symm.trans hpb
              subst hbeq
              obtain ⟨r, hr, hcr⟩ :=
                (hoverAt_some slots px py _ (Nat.le_refl _) hfh).2
              refine Or.inr ⟨hover, ?_, rfl, r, hr, hcr⟩
              simp
          · simp only [ifNeg hb] at hsame ⊢
            cases hd : slots[draggedIndex]? with
            | none =>
              simp only [hd] at hsame ⊢
              cases hh : bannedStillHeld slots previous.banned px py with
              | none => simp
              | some b =>
                obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
                exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
            | some d =>
              simp only [hd] at hsame ⊢
              cases hhv : slots[hover]? with
              | none =>
                simp only [hhv] at hsame ⊢
                cases hh : bannedStillHeld slots previous.banned px py with
                | none => simp
                | some b =>
                  obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
                  exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
              | some h =>
                simp only [hhv] at hsame ⊢
                by_cases hc : centerX2 h - centerX2 d = 0 ∧
                    centerY2 h - centerY2 d = 0
                · simp only [ifPos hc] at hsame
                  exact absurd (hsame.trans heng) heq
                · simp only [ifNeg hc] at hsame ⊢
                  by_cases hdot : (centerX2 h - centerX2 d) * (2 * px - centerX2 h)
                      + (centerY2 h - centerY2 d) * (2 * py - centerY2 h) ≤ 0
                  · simp only [ifPos hdot] at hsame ⊢
                    cases hh : bannedStillHeld slots previous.banned px py with
                    | none => simp
                    | some b =>
                      obtain ⟨hpb, r, hr, hcr⟩ := bannedStillHeld_some hh rfl
                      exact Or.inr ⟨b, rfl, hpb, r, hr, hcr⟩
                  · simp only [ifNeg hdot] at hsame
                    exact absurd (hsame.trans heng) heq

end Research
