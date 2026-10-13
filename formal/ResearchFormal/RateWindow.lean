import ResearchFormal.Basic

/-!
# Fixed-window rate gate

Formal model of `rateWindowPermit` in
`packages/domain/src/market/rateWindow.ts` (API-007).

Times are integers so the half-open window `(now − window, now]` matches the
TypeScript exactly, including when `now < window` (the floor is then
negative). The TypeScript works on millisecond floats; the model abstracts
them to whole units, which is exact on the integer vectors the conformance
test replays.

The main theorem says: if a grant is recorded only when `ratePermit` allows
it, no window ever contains more than `maxPer` grants. Grant times are in
clock order (the runner appends them as they occur), so the theorem assumes
the input is pairwise non-decreasing — without that the statement is false
(a late-recorded past timestamp can complete a window that was sparse when
each grant was checked).
-/

namespace Research

/-- Whether `t` lies in `(now − window, now]`. -/
def windowFilter (now : Int) (window : Nat) (t : Int) : Bool :=
  decide ((now - (window : Int)) < t) && decide (t ≤ now)

/-- Grants of `grants` lying in `(now − window, now]`. -/
def countIn (grants : List Int) (now : Int) (window : Nat) : Nat :=
  (grants.filter (windowFilter now window)).length

/-- A request is allowed iff fewer than `maxPer` grants lie in the window. -/
def ratePermit (grants : List Int) (now : Int) (maxPer window : Nat) : Bool :=
  decide (countIn grants now window < maxPer)

theorem windowFilter_true (now s : Int) (window : Nat) :
    windowFilter now window s = true ↔ (now - (window : Int)) < s ∧ s ≤ now := by
  simp only [windowFilter, Bool.and_eq_true, decide_eq_true_eq]

/-- A monotone filter keeps fewer elements. -/
theorem filter_mono_length (f g : Int → Bool) (l : List Int)
    (h : ∀ s ∈ l, f s = true → g s = true) :
    (l.filter f).length ≤ (l.filter g).length := by
  induction l with
  | nil => simp
  | cons a rest ih =>
    have hrest : ∀ s ∈ rest, f s = true → g s = true :=
      fun s hs hfs => h s (List.mem_cons_of_mem _ hs) hfs
    simp only [List.filter_cons]
    by_cases hf : f a = true
    · rw [ifPos hf, ifPos (h a List.mem_cons_self hf)]
      simp only [List.length_cons]
      have := ih hrest
      omega
    · rw [ifNeg hf]
      by_cases hg : g a = true
      · rw [ifPos hg]
        simp only [List.length_cons]
        have := ih hrest
        omega
      · rw [ifNeg hg]
        exact ih hrest

/-- Keep a grant only when `ratePermit` allows it at its own time. -/
def recordAux : List Int → List Int → Nat → Nat → List Int
  | [], acc, _, _ => acc
  | t :: rest, acc, maxPer, window =>
    recordAux rest (if ratePermit acc t maxPer window then acc ++ [t] else acc) maxPer window

def recordGrants (times : List Int) (maxPer window : Nat) : List Int :=
  recordAux times [] maxPer window

theorem mem_recordAux (ts acc : List Int) (maxPer window : Nat) (x : Int) :
    x ∈ recordAux ts acc maxPer window → x ∈ acc ∨ x ∈ ts := by
  induction ts generalizing acc with
  | nil =>
    intro hx
    simp only [recordAux] at hx
    exact Or.inl hx
  | cons t rest ih =>
    intro hx
    simp only [recordAux] at hx
    by_cases hperm : ratePermit acc t maxPer window = true
    · rw [ifPos hperm] at hx
      rcases ih (acc ++ [t]) hx with h | h
      · rw [List.mem_append] at h
        cases h with
        | inl h => exact Or.inl h
        | inr h =>
          simp at h
          subst h
          exact Or.inr List.mem_cons_self
      · exact Or.inr (List.mem_cons_of_mem _ h)
    · rw [ifNeg hperm] at hx
      rcases ih acc hx with h | h
      · exact Or.inl h
      · exact Or.inr (List.mem_cons_of_mem _ h)

/-- Appending one larger element keeps pairwise order. -/
theorem pairwise_append_singleton (l : List Int) (a : Int)
    (hs : l.Pairwise (· ≤ ·)) (hle : ∀ x ∈ l, x ≤ a) : (l ++ [a]).Pairwise (· ≤ ·) := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    have hsx : (x :: xs).Pairwise (· ≤ ·) := hs
    obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp hsx
    have ih' := ih (List.pairwise_cons.mp hsx).2 (fun z hz => hle z (List.mem_cons_of_mem _ hz))
    simp only [List.cons_append]
    rw [List.pairwise_cons]
    constructor
    · intro y hy
      rw [List.mem_append] at hy
      cases hy with
      | inl h => exact hhead y h
      | inr h =>
        simp at h
        rw [h]
        exact hle x List.mem_cons_self
    · exact ih'

/-- The bound holds for every accumulator that could arise mid-run. -/
theorem recordAux_bounded (maxPer window : Nat) (now : Int) :
    ∀ (ts acc : List Int),
    acc.Pairwise (· ≤ ·) →
    (∀ x ∈ acc, ∀ y ∈ ts, x ≤ y) →
    (∀ m : Int, countIn acc m window ≤ maxPer) →
    ts.Pairwise (· ≤ ·) →
    countIn (recordAux ts acc maxPer window) now window ≤ maxPer := by
  intro ts
  induction ts with
  | nil =>
    intro acc _ _ hbound _
    simpa [recordAux] using hbound now
  | cons t rest ih =>
    intro acc hsorted_acc hbelow hbound hsorted
    obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp hsorted
    have ht_le : ∀ y ∈ rest, t ≤ y := fun y hy => hhead y hy
    by_cases hperm : ratePermit acc t maxPer window = true
    · -- Granted: the new accumulator stays ordered, below the rest, and bounded.
      have hstep : recordAux (t :: rest) acc maxPer window
          = recordAux rest (acc ++ [t]) maxPer window := by
        simp only [recordAux]
        rw [ifPos hperm]
      rw [hstep]
      have hbelow_all : ∀ s ∈ acc, s ≤ t := fun s hs => hbelow s hs t List.mem_cons_self
      have hsorted_acc' : (acc ++ [t]).Pairwise (· ≤ ·) :=
        pairwise_append_singleton acc t hsorted_acc hbelow_all
      have hbelow' : ∀ x ∈ acc ++ [t], ∀ y ∈ rest, x ≤ y := by
        intro x hx y hy
        rw [List.mem_append] at hx
        cases hx with
        | inl h =>
          have h1 : x ≤ t := hbelow x h t List.mem_cons_self
          have h2 : t ≤ y := ht_le y hy
          omega
        | inr h =>
          simp at h
          rw [h]
          exact ht_le y hy
      have hbound' : ∀ m : Int, countIn (acc ++ [t]) m window ≤ maxPer := by
        intro m
        show ((acc ++ [t]).filter (windowFilter m window)).length ≤ maxPer
        have hsplit : ((acc ++ [t]).filter (windowFilter m window)).length
            = (acc.filter (windowFilter m window)).length
              + (if windowFilter m window t then 1 else 0) := by
          rw [List.filter_append]
          cases hft : windowFilter m window t <;> simp [hft]
        rw [hsplit]
        by_cases htm : windowFilter m window t = true
        · rw [ifPos htm]
          have hsub : ∀ s ∈ acc, windowFilter m window s = true
              → windowFilter t window s = true := by
            intro s hsacc hfs
            rw [windowFilter_true] at hfs ⊢
            obtain ⟨h1, h2⟩ := hfs
            obtain ⟨h3, h4⟩ := (windowFilter_true m t window).mp htm
            exact ⟨by omega, hbelow_all s hsacc⟩
          have hle : (acc.filter (windowFilter m window)).length
              ≤ (acc.filter (windowFilter t window)).length :=
            filter_mono_length _ _ _ hsub
          have hplt : (acc.filter (windowFilter t window)).length < maxPer :=
            of_decide_eq_true hperm
          omega
        · rw [ifNeg htm]
          simp only [Nat.add_zero]
          exact hbound m
      exact ih (acc ++ [t]) hsorted_acc' hbelow' hbound' htail
    · -- Denied: the accumulator is unchanged.
      have hstep : recordAux (t :: rest) acc maxPer window
          = recordAux rest acc maxPer window := by
        simp only [recordAux]
        rw [ifNeg hperm]
      rw [hstep]
      exact ih acc hsorted_acc
        (fun x hx y hy => hbelow x hx y (List.mem_cons_of_mem _ hy)) hbound htail

/-- **Rate bound.** If a grant is recorded only when `ratePermit` allows it,
    no window ever contains more than `maxPer` grants. -/
theorem recorded_never_over_window (times : List Int) (maxPer window : Nat)
    (hsorted : times.Pairwise (· ≤ ·)) (now : Int) :
    countIn (recordGrants times maxPer window) now window ≤ maxPer := by
  unfold recordGrants
  exact recordAux_bounded maxPer window now times []
    List.Pairwise.nil
    (fun x hx => absurd hx List.not_mem_nil)
    (fun m => by
      simp only [countIn, List.filter_nil, List.length_nil]
      exact Nat.zero_le _)
    hsorted

end Research
