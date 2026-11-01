/-!
# The business section of a 10-K (ADR-0053 §3)

Formal model of `businessSectionBounds` in
`packages/domain/src/finance/businessDescription.ts`.

A converted filing is a list of blocks, each marked `start` ("Item 1.
Business"), `stop` (a heading that ends the section — "Item 1A", "Item 2", …;
the TypeScript's `"end"`, a Lean keyword) or `other`, with a size (its length).
A filing names Item 1 in its table of contents and again in the body, so
every start heading followed by an end heading is a candidate whose body runs
to the first end heading after it. The chosen candidate has the largest body
(the sum of the sizes strictly between start and end), the earliest start
among equals; a candidate with an empty body (a table-of-contents row followed
by "Item 1A") is never chosen.

`sectionBounds` is written the way the TypeScript computes it, as one pass
from the last block to the first: block 0 replaces the choice made among the
later blocks when it is a start heading whose body is positive and at least
as large (`≥`, so the earlier of two equal bodies wins). The theorems state
what that pass computes in terms of indices alone:

* `sectionBounds_sound` — a result `(s, e, b)` has a start heading at `s`, an
  end heading at `e > s`, no end heading strictly between, and `b > 0` is the
  sum of the sizes strictly between;
* `sectionBounds_largest` / `sectionBounds_earliest` — every candidate's
  body is at most `b`, and every candidate before `s` has a smaller body;
* `sectionBounds_eq_none_iff` — the result is `none` exactly when no start
  heading has a following end heading and a positive body.

`formal/Export.lean` evaluates `sectionBounds` over every mark sequence of
length ≤ 6 with several size patterns; `tests/formal/businessSection.conformance.test.ts`
replays them against the TypeScript.
-/

namespace Research.BusinessSection

/-- What one block is to the section search (the TypeScript's `SectionMark`). -/
inductive Mark where
  | start
  | stop
  | other
  deriving DecidableEq, Repr

/-- A block: its mark and its size (the TypeScript's `marks[i]`, `sizes[i]`). -/
abbrev Block := Mark × Nat

/--
The blocks up to the first end heading: `some (k, b)` when block `k` is the
first end heading and `b` is the total size of the blocks before it; `none`
when no block is an end heading.
-/
def toEnd : List Block → Option (Nat × Nat)
  | [] => none
  | (.stop, _) :: _ => some (0, 0)
  | (.start, size) :: rest => (toEnd rest).map fun (k, b) => (k + 1, b + size)
  | (.other, size) :: rest => (toEnd rest).map fun (k, b) => (k + 1, b + size)

/-- The body size of a choice, 0 without one. -/
def bodyOf : Option (Nat × Nat × Nat) → Nat
  | none => 0
  | some (_, _, b) => b

/-- A choice among the blocks after the first, re-indexed from the first. -/
def shift : Option (Nat × Nat × Nat) → Option (Nat × Nat × Nat)
  | none => none
  | some (s, e, b) => some (s + 1, e + 1, b)

/--
Block 0 against the choice among the later blocks: a start heading whose
body is positive and at least as large as the later choice's replaces it.
-/
def pick (m : Mark) (after : Option (Nat × Nat)) (later : Option (Nat × Nat × Nat)) :
    Option (Nat × Nat × Nat) :=
  match m, after with
  | .start, some (k, b) => if 0 < b ∧ bodyOf later ≤ b then some (0, k + 1, b) else later
  | _, _ => later

/-- `businessSectionBounds`: `some (start, end, body)`, or `none`. -/
def sectionBounds : List Block → Option (Nat × Nat × Nat)
  | [] => none
  | (m, _) :: rest => pick m (toEnd rest) (shift (sectionBounds rest))

/--
Block `i` is a start heading whose section has a body: the first end heading
after it is `k + 1` blocks later, and the blocks between have total size `b > 0`.
-/
def Candidate (l : List Block) (i k b : Nat) : Prop :=
  (∃ size, l[i]? = some (.start, size)) ∧ toEnd (l.drop (i + 1)) = some (k, b) ∧ 0 < b

/-! ## The first end heading -/

/-- What `toEnd` finds: the first end heading, and the size before it. -/
theorem toEnd_some {l : List Block} {k b : Nat} (h : toEnd l = some (k, b)) :
    (∃ size, l[k]? = some (.stop, size)) ∧
    (∀ j, j < k → ∀ x, l[j]? = some x → x.1 ≠ .stop) ∧
    b = ((l.take k).map Prod.snd).sum := by
  induction l generalizing k b with
  | nil => simp [toEnd] at h
  | cons x rest ih =>
    obtain ⟨m, size⟩ := x
    have step : ∀ k' b', toEnd rest = some (k', b') → k = k' + 1 → b = b' + size → m ≠ .stop →
        (∃ sz, ((m, size) :: rest)[k]? = some (.stop, sz)) ∧
        (∀ j, j < k → ∀ x, ((m, size) :: rest)[j]? = some x → x.1 ≠ .stop) ∧
        b = ((((m, size) :: rest).take k).map Prod.snd).sum := by
      intro k' b' hr hk hb hm
      obtain ⟨⟨sz, hsz⟩, hbefore, hsum⟩ := ih hr
      subst hk hb
      refine ⟨⟨sz, by simpa using hsz⟩, ?_, ?_⟩
      · intro j hj x hx
        cases j with
        | zero =>
          simp only [List.getElem?_cons_zero, Option.some.injEq] at hx
          subst hx
          exact hm
        | succ j =>
          simp only [List.getElem?_cons_succ] at hx
          exact hbefore j (by omega) x hx
      · simp only [List.take_succ_cons, List.map_cons, List.sum_cons]
        omega
    cases m with
    | stop =>
      simp only [toEnd, Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨⟨size, rfl⟩, fun j hj => absurd hj (Nat.not_lt_zero j), by simp⟩
    | start =>
      simp only [toEnd, Option.map_eq_some_iff, Prod.exists, Prod.mk.injEq] at h
      obtain ⟨k', b', hr, hk, hb⟩ := h
      exact step k' b' hr hk.symm hb.symm (by decide)
    | other =>
      simp only [toEnd, Option.map_eq_some_iff, Prod.exists, Prod.mk.injEq] at h
      obtain ⟨k', b', hr, hk, hb⟩ := h
      exact step k' b' hr hk.symm hb.symm (by decide)

/-- Conversely, the first end heading is what `toEnd` finds. -/
theorem toEnd_of_first {l : List Block} {k : Nat}
    (hstop : ∃ size, l[k]? = some (.stop, size))
    (hbefore : ∀ j, j < k → ∀ x, l[j]? = some x → x.1 ≠ .stop) :
    toEnd l = some (k, ((l.take k).map Prod.snd).sum) := by
  induction l generalizing k with
  | nil =>
    obtain ⟨_, h⟩ := hstop
    simp at h
  | cons x rest ih =>
    obtain ⟨m, size⟩ := x
    cases k with
    | zero =>
      obtain ⟨_, h⟩ := hstop
      simp only [List.getElem?_cons_zero, Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, _⟩ := h
      simp [toEnd]
    | succ k =>
      have hm : m ≠ .stop := hbefore 0 (by omega) (m, size) rfl
      have hr : toEnd rest = some (k, ((rest.take k).map Prod.snd).sum) := by
        refine ih ?_ ?_
        · obtain ⟨sz, h⟩ := hstop
          exact ⟨sz, by simpa using h⟩
        · intro j hj y hy
          exact hbefore (j + 1) (by omega) y (by simpa using hy)
      have hsum : ((((m, size) :: rest).take (k + 1)).map Prod.snd).sum
          = ((rest.take k).map Prod.snd).sum + size := by
        simp only [List.take_succ_cons, List.map_cons, List.sum_cons]
        omega
      rw [hsum]
      cases m with
      | stop => exact absurd rfl hm
      | start => simp [toEnd, hr]
      | other => simp [toEnd, hr]

/-- A candidate in plain index terms. -/
theorem candidate_iff {l : List Block} {i k b : Nat} :
    Candidate l i k b ↔
      (∃ size, l[i]? = some (.start, size)) ∧
      (∃ size, l[i + 1 + k]? = some (.stop, size)) ∧
      (∀ j, i < j → j < i + 1 + k → ∀ x, l[j]? = some x → x.1 ≠ .stop) ∧
      b = (((l.drop (i + 1)).take k).map Prod.snd).sum ∧ 0 < b := by
  constructor
  · rintro ⟨hstart, hend, hpos⟩
    obtain ⟨⟨sz, hsz⟩, hbefore, hsum⟩ := toEnd_some hend
    refine ⟨hstart, ⟨sz, ?_⟩, ?_, hsum, hpos⟩
    · simpa [List.getElem?_drop] using hsz
    · intro j hij hj x hx
      have hj' : j = i + 1 + (j - (i + 1)) := by omega
      refine hbefore (j - (i + 1)) (by omega) x ?_
      rw [List.getElem?_drop, ← hj']
      exact hx
  · rintro ⟨hstart, ⟨sz, hsz⟩, hbefore, hsum, hpos⟩
    refine ⟨hstart, ?_, hpos⟩
    rw [hsum]
    refine toEnd_of_first ⟨sz, ?_⟩ ?_
    · rw [List.getElem?_drop]
      exact hsz
    · intro j hj x hx
      rw [List.getElem?_drop] at hx
      exact hbefore (i + 1 + j) (by omega) (by omega) x hx

/-! ## The pass -/

theorem bodyOf_shift (r : Option (Nat × Nat × Nat)) : bodyOf (shift r) = bodyOf r := by
  cases r with
  | none => rfl
  | some r => obtain ⟨_, _, _⟩ := r; rfl

/-- Block 0 either keeps the later choice or replaces it with a larger-or-equal body. -/
theorem pick_cases (m : Mark) (after : Option (Nat × Nat)) (later : Option (Nat × Nat × Nat)) :
    pick m after later = later ∨
      ∃ k b, m = .start ∧ after = some (k, b) ∧ 0 < b ∧ bodyOf later ≤ b ∧
        pick m after later = some (0, k + 1, b) := by
  cases m with
  | stop => exact Or.inl rfl
  | other => exact Or.inl rfl
  | start =>
    cases after with
    | none => exact Or.inl rfl
    | some a =>
      obtain ⟨k, b⟩ := a
      by_cases hc : 0 < b ∧ bodyOf later ≤ b
      · exact Or.inr ⟨k, b, rfl, rfl, hc.1, hc.2, by simp [pick, hc]⟩
      · exact Or.inl (by simp [pick, hc])

theorem candidate_cons_zero {m : Mark} {size : Nat} {rest : List Block} {k b : Nat} :
    Candidate ((m, size) :: rest) 0 k b ↔ m = .start ∧ toEnd rest = some (k, b) ∧ 0 < b := by
  simp [Candidate]

theorem candidate_cons_succ {x : Block} {rest : List Block} {i k b : Nat} :
    Candidate (x :: rest) (i + 1) k b ↔ Candidate rest i k b := by
  simp [Candidate]

/-- The choice is a candidate, and its end heading is the first after its start. -/
theorem sectionBounds_candidate {l : List Block} {s e b : Nat}
    (h : sectionBounds l = some (s, e, b)) : ∃ k, e = s + 1 + k ∧ Candidate l s k b := by
  induction l generalizing s e b with
  | nil => simp [sectionBounds] at h
  | cons x rest ih =>
    obtain ⟨m, size⟩ := x
    simp only [sectionBounds] at h
    rcases pick_cases m (toEnd rest) (shift (sectionBounds rest)) with hp | ⟨k, b', hm, ha, hb, _, hp⟩
    · rw [hp] at h
      cases hr : sectionBounds rest with
      | none => simp [hr, shift] at h
      | some r =>
        obtain ⟨s', e', b''⟩ := r
        simp only [hr, shift, Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl, rfl⟩ := h
        obtain ⟨k, hk, hc⟩ := ih hr
        exact ⟨k, by omega, candidate_cons_succ.2 hc⟩
    · rw [hp] at h
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl, rfl⟩ := h
      exact ⟨k, by omega, candidate_cons_zero.2 ⟨hm, ha, hb⟩⟩

/-- Every candidate's body is at most the choice's. -/
theorem candidate_le_bodyOf {l : List Block} {i k b : Nat} (hc : Candidate l i k b) :
    b ≤ bodyOf (sectionBounds l) := by
  induction l generalizing i with
  | nil => simp [Candidate] at hc
  | cons x rest ih =>
    obtain ⟨m, size⟩ := x
    simp only [sectionBounds]
    cases i with
    | zero =>
      obtain ⟨rfl, ha, hb⟩ := candidate_cons_zero.1 hc
      rw [ha]
      by_cases hle : bodyOf (shift (sectionBounds rest)) ≤ b
      · simp only [pick, hb, hle, and_self, ↓reduceIte]
        simp [bodyOf]
      · simp only [pick, hb, hle, and_false, ↓reduceIte]
        omega
    | succ i =>
      have hle := ih (candidate_cons_succ.1 hc)
      rcases pick_cases m (toEnd rest) (shift (sectionBounds rest)) with hp | ⟨k', b', _, _, _, hge, hp⟩
      · rw [hp, bodyOf_shift]
        exact hle
      · rw [hp]
        simp only [bodyOf]
        rw [bodyOf_shift] at hge
        omega

/-- A candidate before the choice has a strictly smaller body (earliest among equals). -/
theorem candidate_before_lt {l : List Block} {s e bb i k b : Nat}
    (h : sectionBounds l = some (s, e, bb)) (hc : Candidate l i k b) (hi : i < s) : b < bb := by
  induction l generalizing s e bb i with
  | nil => simp [sectionBounds] at h
  | cons x rest ih =>
    obtain ⟨m, size⟩ := x
    simp only [sectionBounds] at h
    cases i with
    | zero =>
      obtain ⟨rfl, ha, hb⟩ := candidate_cons_zero.1 hc
      rw [ha] at h
      by_cases hle : bodyOf (shift (sectionBounds rest)) ≤ b
      · simp only [pick, hb, hle, and_self, ↓reduceIte, Option.some.injEq, Prod.mk.injEq] at h
        omega
      · simp only [pick, hb, hle, and_false, ↓reduceIte] at h
        rw [h] at hle
        simp only [bodyOf] at hle
        omega
    | succ i =>
      rcases pick_cases m (toEnd rest) (shift (sectionBounds rest)) with hp | ⟨k', b', _, _, _, _, hp⟩
      · rw [hp] at h
        cases hr : sectionBounds rest with
        | none => simp [hr, shift] at h
        | some r =>
          obtain ⟨s', e', b''⟩ := r
          simp only [hr, shift, Option.some.injEq, Prod.mk.injEq] at h
          obtain ⟨rfl, rfl, rfl⟩ := h
          exact ih hr (candidate_cons_succ.1 hc) (by omega)
      · rw [hp] at h
        simp only [Option.some.injEq, Prod.mk.injEq] at h
        omega

/-! ## What the result is -/

/--
Soundness: the result's start is a start heading, its end the first end
heading after it, and its body the positive sum of the sizes strictly between.
-/
theorem sectionBounds_sound {l : List Block} {s e b : Nat}
    (h : sectionBounds l = some (s, e, b)) :
    (∃ size, l[s]? = some (.start, size)) ∧ s < e ∧
    (∃ size, l[e]? = some (.stop, size)) ∧
    (∀ j, s < j → j < e → ∀ x, l[j]? = some x → x.1 ≠ .stop) ∧
    b = (((l.drop (s + 1)).take (e - s - 1)).map Prod.snd).sum ∧ 0 < b := by
  obtain ⟨k, rfl, hc⟩ := sectionBounds_candidate h
  obtain ⟨hstart, hstop, hbefore, hsum, hpos⟩ := candidate_iff.1 hc
  refine ⟨hstart, by omega, hstop, hbefore, ?_, hpos⟩
  have hk : s + 1 + k - s - 1 = k := by omega
  rw [hk]
  exact hsum

/-- Maximality: no candidate has a larger body than the result. -/
theorem sectionBounds_largest {l : List Block} {s e b i k b' : Nat}
    (h : sectionBounds l = some (s, e, b)) (hc : Candidate l i k b') : b' ≤ b := by
  have := candidate_le_bodyOf hc
  rw [h] at this
  exact this

/-- Earliest among equals: every candidate before the result has a smaller body. -/
theorem sectionBounds_earliest {l : List Block} {s e b i k b' : Nat}
    (h : sectionBounds l = some (s, e, b)) (hc : Candidate l i k b') (hi : i < s) : b' < b :=
  candidate_before_lt h hc hi

/-- Completeness: no result exactly when no start heading has a section with a body. -/
theorem sectionBounds_eq_none_iff {l : List Block} :
    sectionBounds l = none ↔ ∀ i k b, ¬ Candidate l i k b := by
  constructor
  · intro h i k b hc
    have hle := candidate_le_bodyOf hc
    rw [h] at hle
    simp only [bodyOf] at hle
    exact absurd hc.2.2 (by omega)
  · intro h
    cases hr : sectionBounds l with
    | none => rfl
    | some r =>
      obtain ⟨s, e, b⟩ := r
      obtain ⟨k, _, hc⟩ := sectionBounds_candidate hr
      exact absurd hc (h s k b)

end Research.BusinessSection
