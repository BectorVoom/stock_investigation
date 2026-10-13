import ResearchFormal.Basic

/-!
# Earnings-date calendar

Formal model of `foldIcsLine` in `packages/domain/src/calendar/ics.ts` and
`selectUpcomingEarnings` in `packages/domain/src/calendar/upcoming.ts` (FR-018).

`foldIcsLine` is modelled over a list of character widths (1..4 octets), which
is exactly what the TypeScript loop observes: it never looks at the characters
themselves, only at each one's UTF-8 width. The model replicates the greedy
loop bit for bit — the first line carries up to 75 octets, every continuation
line starts with one space (which counts toward its 75, so 74 content octets)
— and proves both halves of the round trip: every produced line is within the
octet limit, and flattening the produced pieces gives back the input list
(nothing lost, duplicated or reordered).

`selectUpcomingEarnings` is modelled over rows with a stock id and an optional
day offset (the TypeScript compares validated `YYYY-MM-DD` strings, which order
exactly like day offsets from a fixed base). The model replicates the
filter-then-stable-sort-then-cap pipeline and proves the three stated
properties: the result has at most `maxItems` entries, every entry lies in the
window, and the result is sorted by (date, stock id).
-/

namespace Research

/-! ## RFC 5545 line folding -/

/-- One greedy step: start a new chunk when the current one is non-empty and
    the next width would overflow the budget (exactly the TypeScript guard
    `current !== "" && used + width > budget`). -/
def foldAux : List Nat → List (List Nat) → List Nat → Nat → Nat → List (List Nat)
  | [], chunks, cur, _, _ => chunks ++ [cur]
  | w :: rest, chunks, cur, used, budget =>
    if cur ≠ [] ∧ budget < used + w then
      foldAux rest (chunks ++ [cur]) [w] w 74
    else
      foldAux rest chunks (cur ++ [w]) (used + w) budget

/-- The whole fold: one 75-octet budget for the first line, 74 afterwards. -/
def foldWidths (widths : List Nat) : List (List Nat) :=
  foldAux widths [] [] 0 75

theorem flatten_snoc (chunks : List (List Nat)) (cur : List Nat) :
    (chunks ++ [cur]).flatten = chunks.flatten ++ cur := by
  induction chunks with
  | nil => simp [List.flatten]
  | cons x xs ih => simp [List.flatten, ih, List.append_assoc]

/-- Flattening the fold gives back everything seen so far plus the rest. -/
theorem foldAux_flatten : ∀ (rest : List Nat) (chunks : List (List Nat)) (cur : List Nat)
    (used budget : Nat),
    (foldAux rest chunks cur used budget).flatten = chunks.flatten ++ cur ++ rest := by
  intro rest
  induction rest with
  | nil =>
    intro chunks cur used budget
    simp [foldAux]
  | cons w rest' ih =>
    intro chunks cur used budget
    simp only [foldAux]
    by_cases h : cur ≠ [] ∧ budget < used + w
    · rw [ifPos h, ih, flatten_snoc]
      simp only [List.append_assoc, List.cons_append, List.nil_append]
    · rw [ifNeg h, ih]
      simp only [List.append_assoc, List.cons_append, List.nil_append]

/-- **Nothing lost, duplicated or reordered.** -/
theorem foldWidths_flatten (widths : List Nat) :
    (foldWidths widths).flatten = widths := by
  unfold foldWidths
  have h := foldAux_flatten widths [] [] 0 75
  simpa using h

/-- The bound holds for every accumulator that could arise mid-fold:
    `used` tracks the current chunk's sum, the current chunk fits its budget,
    and every finished chunk is within the 75-octet limit. -/
theorem foldAux_bounded : ∀ (rest : List Nat) (chunks : List (List Nat)) (cur : List Nat)
    (used budget : Nat),
    (∀ w ∈ rest, w ≤ 74) →
    used = cur.sum →
    cur.sum ≤ budget →
    (budget = 75 ∨ budget = 74) →
    (∀ line ∈ chunks, line.sum ≤ 75) →
    (∀ line ∈ foldAux rest chunks cur used budget, line.sum ≤ 75) := by
  intro rest
  induction rest with
  | nil =>
    intro chunks cur used budget _ _ hcur hbudget hchunks line hline
    simp only [foldAux, List.mem_append] at hline
    cases hline with
    | inl h => exact hchunks line h
    | inr h =>
      simp at h
      subst h
      cases hbudget with
      | inl heq => rw [heq] at hcur; exact hcur
      | inr heq => rw [heq] at hcur; omega
  | cons w rest' ih =>
    intro chunks cur used budget hsmall hused hcur hbudget hchunks
    simp only [foldAux]
    by_cases h : cur ≠ [] ∧ budget < used + w
    · -- Overflow: the current chunk is finished (it fit its budget) and a
      -- fresh 74-octet chunk starts with the one width.
      rw [ifPos h]
      have hw : w ≤ 74 := hsmall w List.mem_cons_self
      have hrest : ∀ v ∈ rest', v ≤ 74 :=
        fun v hv => hsmall v (List.mem_cons_of_mem _ hv)
      refine ih (chunks ++ [cur]) [w] w 74 hrest rfl ?_ (Or.inr rfl) ?_
      · simpa using hw
      · intro line hline
        rw [List.mem_append] at hline
        cases hline with
        | inl hh => exact hchunks line hh
        | inr hh =>
          simp at hh
          subst hh
          cases hbudget with
          | inl heq => rw [heq] at hcur; exact hcur
          | inr heq => rw [heq] at hcur; omega
    · -- It fits: the chunk grows and still fits its budget.
      rw [ifNeg h]
      have hle : used + w ≤ budget := by
        by_cases hc : cur = []
        · subst hc
          simp at hused
          have hw : w ≤ 74 := hsmall w List.mem_cons_self
          cases hbudget with
          | inl heq => omega
          | inr heq => omega
        · have hge : ¬ budget < used + w := fun hlt => h ⟨hc, hlt⟩
          omega
      have hrest : ∀ v ∈ rest', v ≤ 74 :=
        fun v hv => hsmall v (List.mem_cons_of_mem _ hv)
      have hsum : used + w = (cur ++ [w]).sum := by
        simp [List.sum_append, hused]
      refine ih chunks (cur ++ [w]) (used + w) budget hrest hsum ?_ hbudget hchunks
      omega

/-- **Every produced line is within the 75-octet limit** (character widths are
    1..4 octets in real text; the model only needs each width to fit a fresh
    continuation chunk). -/
theorem foldWidths_within_limit (widths : List Nat) (h : ∀ w ∈ widths, w ≤ 74) :
    ∀ line ∈ foldWidths widths, line.sum ≤ 75 := by
  unfold foldWidths
  exact foldAux_bounded widths [] [] 0 75 h (by simp) (by simp) (Or.inl rfl)
    (fun _ hm => absurd hm List.not_mem_nil)

/-! ## Upcoming earnings selection -/

/-- One watchlist row: a stock id with an optional day offset. -/
structure EarnRow where
  stock : Nat
  date : Option Nat
  deriving Repr, DecidableEq

/-- Whether day `d` lies in `[today, today + daysAhead]`. -/
def inWindow (today daysAhead d : Nat) : Bool :=
  decide (today ≤ d) && decide (d ≤ today + daysAhead)

/-- Whether a row survives the filter (dated and inside the window). -/
def inWinRow (today daysAhead : Nat) (r : EarnRow) : Bool :=
  match r.date with
  | none => false
  | some d => inWindow today daysAhead d

/-- The kept rows as `(date, stock)` pairs, in input order. -/
def dated (rows : List EarnRow) (today daysAhead : Nat) : List (Nat × Nat) :=
  (rows.filter (inWinRow today daysAhead)).map fun r => (r.date.getD 0, r.stock)

/-- Strict key order on `(date, stock)` pairs. -/
def pairLT (a b : Nat × Nat) : Bool :=
  decide (a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 < b.2))

/-- The non-strict key order the sortedness theorem is stated with. -/
def pairLE (a b : Nat × Nat) : Prop :=
  a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 ≤ b.2)

def pairLtProp (a b : Nat × Nat) : Prop :=
  a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 < b.2)

theorem pairLT_eq (a b : Nat × Nat) : pairLT a b = true ↔ pairLtProp a b := by
  simp [pairLT, pairLtProp, decide_eq_true_eq]

theorem pairLt_le (a b : Nat × Nat) (h : pairLtProp a b) : pairLE a b := by
  unfold pairLtProp at h
  unfold pairLE
  cases h with
  | inl hlt => exact Or.inl hlt
  | inr hcon =>
    obtain ⟨heq, hlt⟩ := hcon
    exact Or.inr ⟨heq, by omega⟩

/-- Trichotomy on the key: not-less means greater-or-equal. -/
theorem not_lt_le (a b : Nat × Nat) (h : ¬ pairLtProp a b) : pairLE b a := by
  unfold pairLtProp at h
  unfold pairLE
  by_cases h1 : a.1 < b.1
  · exact absurd (Or.inl h1) h
  · have hge : b.1 ≤ a.1 := by omega
    by_cases h2 : a.1 = b.1
    · have hle : b.2 ≤ a.2 := by
        by_cases hc : a.2 < b.2
        · exact absurd (Or.inr ⟨h2, hc⟩) h
        · omega
      exact Or.inr ⟨h2.symm, hle⟩
    · have hlt : b.1 < a.1 := by omega
      exact Or.inl hlt

theorem pairLE_trans {a b c : Nat × Nat}
    (h1 : pairLE a b) (h2 : pairLE b c) : pairLE a c := by
  unfold pairLE at *
  omega

/-- Stable insertion by key (`<`, so equal keys keep their input order — the
    TypeScript `Array.sort` is stable too). -/
def pairInsert (x : Nat × Nat) : List (Nat × Nat) → List (Nat × Nat)
  | [] => [x]
  | y :: ys => if pairLT x y then x :: y :: ys else y :: pairInsert x ys

def pairSort : List (Nat × Nat) → List (Nat × Nat)
  | [] => []
  | x :: xs => pairInsert x (pairSort xs)

/-- The full pipeline: keep the window, sort by (date, stock), cap. -/
def selectUpcoming (rows : List EarnRow) (today daysAhead maxItems : Nat) :
    List (Nat × Nat) :=
  (pairSort (dated rows today daysAhead)).take maxItems

theorem mem_pairInsert (x : Nat × Nat) : ∀ (l : List (Nat × Nat)) (y : Nat × Nat),
    y ∈ pairInsert x l ↔ y = x ∨ y ∈ l := by
  intro l
  induction l with
  | nil =>
    intro y
    simp [pairInsert]
  | cons z zs ih =>
    intro y
    simp only [pairInsert]
    by_cases h : pairLT x z = true
    · rw [ifPos h]
      simp
    · rw [ifNeg h, List.mem_cons, List.mem_cons, ih]
      exact or_left_comm

theorem pairwise_pairInsert (x : Nat × Nat) : ∀ (l : List (Nat × Nat)),
    l.Pairwise pairLE → (pairInsert x l).Pairwise pairLE := by
  intro l
  induction l with
  | nil =>
    intro _
    simp only [pairInsert]
    exact List.Pairwise.cons (fun _ hm => absurd hm List.not_mem_nil) List.Pairwise.nil
  | cons y ys ih =>
    intro hs
    simp only [pairInsert]
    by_cases h : pairLT x y = true
    · rw [ifPos h, List.pairwise_cons]
      have hxy : pairLE x y := pairLt_le x y ((pairLT_eq x y).mp h)
      obtain ⟨hhead, _⟩ := List.pairwise_cons.mp hs
      constructor
      · intro z hz
        rw [List.mem_cons] at hz
        cases hz with
        | inl heq => rw [heq]; exact hxy
        | inr hm => exact pairLE_trans hxy (hhead z hm)
      · exact hs
    · rw [ifNeg h, List.pairwise_cons]
      obtain ⟨hhead, htail⟩ := List.pairwise_cons.mp hs
      have hyx : pairLE y x :=
        not_lt_le x y (fun hp => h ((pairLT_eq x y).mpr hp))
      constructor
      · intro z hz
        rw [mem_pairInsert] at hz
        cases hz with
        | inl heq => rw [heq]; exact hyx
        | inr hm => exact hhead z hm
      · exact ih htail

theorem pairwise_pairSort : ∀ (l : List (Nat × Nat)), (pairSort l).Pairwise pairLE := by
  intro l
  induction l with
  | nil => simp [pairSort]
  | cons x xs ih =>
    simp only [pairSort]
    exact pairwise_pairInsert x (pairSort xs) ih

theorem mem_pairSort : ∀ (l : List (Nat × Nat)) (p : Nat × Nat),
    p ∈ pairSort l ↔ p ∈ l := by
  intro l
  induction l with
  | nil =>
    intro p
    simp [pairSort]
  | cons x xs ih =>
    intro p
    simp only [pairSort, mem_pairInsert, ih, List.mem_cons]

theorem length_take_le : ∀ (l : List α) (n : Nat), (l.take n).length ≤ n := by
  intro l
  induction l with
  | nil =>
    intro n
    cases n with
    | zero => exact Nat.zero_le _
    | succ _ => exact Nat.zero_le _
  | cons _ xs ih =>
    intro n
    cases n with
    | zero => exact Nat.zero_le _
    | succ n => exact Nat.succ_le_succ (ih n)

theorem mem_take_of_mem : ∀ {l : List α} {n : Nat} {a : α},
    a ∈ l.take n → a ∈ l := by
  intro l n a h
  induction l generalizing n with
  | nil => simp at h
  | cons x xs ih =>
    cases n with
    | zero => simp at h
    | succ n =>
      rw [List.take_succ_cons, List.mem_cons] at h
      rw [List.mem_cons]
      cases h with
      | inl heq => exact Or.inl heq
      | inr hm => exact Or.inr (ih hm)

theorem pairwise_take (l : List α) (r : α → α → Prop) (n : Nat)
    (h : l.Pairwise r) : (l.take n).Pairwise r := by
  induction l generalizing n with
  | nil =>
    cases n with
    | zero => simp
    | succ n => simp
  | cons x xs ih =>
    cases n with
    | zero =>
      rw [List.take_zero]
      exact List.Pairwise.nil
    | succ n =>
      rw [List.pairwise_cons] at h
      obtain ⟨hhead, htail⟩ := h
      show (x :: xs.take n).Pairwise r
      rw [List.pairwise_cons]
      constructor
      · intro y hy
        exact hhead y (mem_take_of_mem hy)
      · exact ih n htail

theorem mem_dated {rows : List EarnRow} {today daysAhead : Nat} {p : Nat × Nat}
    (h : p ∈ dated rows today daysAhead) :
    today ≤ p.1 ∧ p.1 ≤ today + daysAhead := by
  unfold dated at h
  rw [List.mem_map] at h
  obtain ⟨r, hr, rfl⟩ := h
  rw [List.mem_filter] at hr
  obtain ⟨_, hwin⟩ := hr
  cases hd : r.date with
  | none => simp [inWinRow, hd] at hwin
  | some d =>
    have hwin' : inWindow today daysAhead d = true := by
      have h2 := hwin
      unfold inWinRow at h2
      rw [hd] at h2
      simpa using h2
    simp only [inWindow, Bool.and_eq_true, decide_eq_true_eq] at hwin'
    exact hwin'

/-- **The result has at most `maxItems` entries.** -/
theorem selectUpcoming_length (rows : List EarnRow) (today daysAhead maxItems : Nat) :
    (selectUpcoming rows today daysAhead maxItems).length ≤ maxItems := by
  unfold selectUpcoming
  exact length_take_le _ _

/-- **Every entry lies in the window.** -/
theorem selectUpcoming_mem_window (rows : List EarnRow) (today daysAhead maxItems : Nat)
    (p : Nat × Nat) (h : p ∈ selectUpcoming rows today daysAhead maxItems) :
    today ≤ p.1 ∧ p.1 ≤ today + daysAhead := by
  unfold selectUpcoming at h
  exact mem_dated ((mem_pairSort _ _).mp (mem_take_of_mem h))

/-- **The result is sorted by (date, stock id).** -/
theorem selectUpcoming_sorted (rows : List EarnRow) (today daysAhead maxItems : Nat) :
    (selectUpcoming rows today daysAhead maxItems).Pairwise pairLE := by
  unfold selectUpcoming
  exact pairwise_take _ _ _ (pairwise_pairSort _)

end Research
