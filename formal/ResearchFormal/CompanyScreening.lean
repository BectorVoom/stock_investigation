import Std

namespace Research.CompanyScreening

/-!
# Company Screening & Fuzzy Matching (`packages/domain/src/watchlist/companyScreening.ts`)

Verifies the two core invariants of thematic/sector company retrieval:
1. **Bounded Optimal String Alignment (OSA) & Pigeonhole SQL Prefilter Soundness:**
   - Numeric/ticker, CJK, and short (`< 5` char) tokens allow `0` edits (`allowedEdits`).
   - Any 1-edit token (`5 ≤ q.length`) preserves at least one of the two 2-char slices
     `q[0..2)` or `q[3..5)` verbatim (`prefilter1_sound`).
   - Any 2-edit token (`8 ≤ q.length`) preserves at least one of the three 2-char slices
     `q[0..2)`, `q[3..5)`, or `q[6..8)` verbatim (`prefilter2_sound`).
2. **Theme/Sector Membership & False-Positive Exclusion:**
   - Customer-targeted (`<Target>向け<Head>`, `<Target>用<Head>`) and ancillary service/component
     themes never qualify as theme membership (`customer_or_ancillary_theme_excluded`).
   - Blank-check SPACs never match non-identity queries (`blank_check_excluded`).
   - Companies with stored summaries (`hasSummary = true`) that only match in body text
     (customer lists, historical spin-offs, or divested businesses) without an identity,
     theme, or sector/segment anchor are always excluded (`body_only_with_summary_excluded`).
-/

def optMin : Option Nat → Option Nat → Option Nat
  | none, y => y
  | x, none => x
  | some x, some y => some (min x y)

def optSucc : Option Nat → Option Nat
  | none => none
  | some x => some (x + 1)

/-- Bounded Optimal String Alignment distance (`some d` when distance `d ≤ k`, `none` when `> k`). -/
def osaWithin : Nat → List Nat → List Nat → Option Nat
  | _, [], [] => some 0
  | 0, x :: xs, y :: ys => if x == y then osaWithin 0 xs ys else none
  | 0, _, _ => none
  | k + 1, [], ys => if ys.length ≤ k + 1 then some ys.length else none
  | k + 1, xs, [] => if xs.length ≤ k + 1 then some xs.length else none
  | k + 1, x :: xs, y :: ys =>
    if x == y then
      osaWithin (k + 1) xs ys
    else
      let del := optSucc (osaWithin k xs (y :: ys))
      let ins := optSucc (osaWithin k (x :: xs) ys)
      let sub := optSucc (osaWithin k xs ys)
      let trans := match xs, ys with
        | x2 :: xs', y2 :: ys' =>
          if x == y2 && x2 == y then optSucc (osaWithin k xs' ys') else none
        | _, _ => none
      optMin (optMin del ins) (optMin sub trans)
termination_by k a b => (k, a.length + b.length)

theorem osaWithin_refl (k : Nat) (xs : List Nat) : osaWithin k xs xs = some 0 := by
  induction xs with
  | nil => cases k <;> unfold osaWithin <;> rfl
  | cons x rest ih =>
    cases k <;> (unfold osaWithin; simp [ih])

theorem osaWithin_zero_some :
    ∀ (a b : List Nat) (d : Nat), osaWithin 0 a b = some d → d = 0 ∧ a = b
  | [], [], d, h => by
    unfold osaWithin at h
    injection h with hd
    exact ⟨hd.symm, rfl⟩
  | [], _ :: _, _, h => by
    unfold osaWithin at h
    contradiction
  | _ :: _, [], _, h => by
    unfold osaWithin at h
    contradiction
  | x :: xs, y :: ys, d, h => by
    unfold osaWithin at h
    split at h
    · rename_i hxy
      have hxy' : x = y := beq_iff_eq.mp hxy
      obtain ⟨hd, hrest⟩ := osaWithin_zero_some xs ys d h
      exact ⟨hd, by rw [hxy', hrest]⟩
    · contradiction

private theorem optMin_eq_some {a b : Option Nat} {d : Nat} (h : optMin a b = some d) :
    (∃ d1, a = some d1 ∧ d ≤ d1) ∨ (∃ d2, b = some d2 ∧ d ≤ d2) := by
  cases a with
  | none =>
    cases b with
    | none => simp [optMin] at h
    | some d2 =>
      simp [optMin] at h
      exact Or.inr ⟨d2, rfl, by omega⟩
  | some d1 =>
    cases b with
    | none =>
      simp [optMin] at h
      exact Or.inl ⟨d1, rfl, by omega⟩
    | some d2 =>
      simp [optMin] at h
      by_cases hle : d1 ≤ d2
      · exact Or.inl ⟨d1, rfl, by omega⟩
      · exact Or.inr ⟨d2, rfl, by omega⟩

private theorem optSucc_eq_some {a : Option Nat} {d : Nat} (h : optSucc a = some d) :
    ∃ d', a = some d' ∧ d = d' + 1 := by
  cases a with
  | none => simp [optSucc] at h
  | some d' =>
    simp [optSucc] at h
    exact ⟨d', rfl, h.symm⟩

theorem osaWithin_le (k : Nat) :
    ∀ (a b : List Nat) (d : Nat), osaWithin k a b = some d → d ≤ k := by
  induction k with
  | zero =>
    intro a b d h
    obtain ⟨hd, _⟩ := osaWithin_zero_some a b d h
    omega
  | succ k' ihk =>
    intro a b d h
    induction a generalizing b with
    | nil =>
      cases b with
      | nil =>
        unfold osaWithin at h
        injection h with hd
        omega
      | cons y ys =>
        unfold osaWithin at h
        split at h
        · rename_i hlen
          injection h with hd
          omega
        · contradiction
    | cons x xs iha =>
      cases b with
      | nil =>
        unfold osaWithin at h
        split at h
        · rename_i hlen
          injection h with hd
          omega
        · contradiction
      | cons y ys =>
        unfold osaWithin at h
        split at h
        · exact iha ys h
        · rcases optMin_eq_some h with ⟨dL, hL, hleL⟩ | ⟨dR, hR, hleR⟩
          · rcases optMin_eq_some hL with ⟨d1, h1, hle1⟩ | ⟨d2, h2, hle2⟩
            · obtain ⟨d', hd', rfl⟩ := optSucc_eq_some h1
              have hstep := ihk xs (y :: ys) d' hd'
              omega
            · obtain ⟨d', hd', rfl⟩ := optSucc_eq_some h2
              have hstep := ihk (x :: xs) ys d' hd'
              omega
          · rcases optMin_eq_some hR with ⟨d3, h3, hle3⟩ | ⟨d4, h4, hle4⟩
            · obtain ⟨d', hd', rfl⟩ := optSucc_eq_some h3
              have hstep := ihk xs ys d' hd'
              omega
            · cases xs with
              | nil => simp at h4
              | cons x2 xs' =>
                cases ys with
                | nil => simp at h4
                | cons y2 ys' =>
                  simp only at h4
                  split at h4
                  · obtain ⟨d', hd', rfl⟩ := optSucc_eq_some h4
                    have hstep := ihk xs' ys' d' hd'
                    omega
                  · contradiction

/-- 2-character window starting at `offset` (`q.slice(offset, offset + 2)`). -/
def slice2 (q : List Nat) (offset : Nat) : List Nat :=
  (q.drop offset).take 2

def prefilter1Matches (q w : List Nat) : Bool :=
  decide (slice2 q 0 <:+: w) || decide (slice2 q 3 <:+: w)

def prefilter2Matches (q w : List Nat) : Bool :=
  decide (slice2 q 0 <:+: w) || decide (slice2 q 3 <:+: w) || decide (slice2 q 6 <:+: w)

private theorem infix_cons_of_infix {s u : List Nat} (y : Nat) (h : s <:+: u) :
    s <:+: y :: u := by
  obtain ⟨l, r, rfl⟩ := h
  exact ⟨y :: l, r, rfl⟩

/-- Any 1-edit OSA match on a token of length `≥ 5` preserves `q[0..2)` or `q[3..5)` verbatim. -/
theorem prefilter1_sound (q w : List Nat) (d : Nat)
    (hlen : 5 ≤ q.length) (hosa : osaWithin 1 q w = some d) :
    prefilter1Matches q w = true := by
  rcases q with _ | ⟨q0, _ | ⟨q1, _ | ⟨q2, _ | ⟨q3, _ | ⟨q4, qRest⟩⟩⟩⟩⟩
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · have hs0 : slice2 (q0 :: q1 :: q2 :: q3 :: q4 :: qRest) 0 = [q0, q1] := rfl
    have hs3 : slice2 (q0 :: q1 :: q2 :: q3 :: q4 :: qRest) 3 = [q3, q4] := rfl
    rw [prefilter1Matches, hs0, hs3, Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq]
    rcases w with _ | ⟨w0, wRest⟩
    · unfold osaWithin at hosa
      split at hosa
      · rename_i hbad
        simp only [List.length_cons] at hbad
        omega
      · contradiction
    · unfold osaWithin at hosa
      split at hosa
      · rename_i hq0
        have h0 : q0 = w0 := beq_iff_eq.mp hq0
        subst h0
        rcases wRest with _ | ⟨w1, wRest2⟩
        · unfold osaWithin at hosa
          split at hosa
          · rename_i hbad
            simp only [List.length_cons] at hbad
            omega
          · contradiction
        · unfold osaWithin at hosa
          split at hosa
          · rename_i hq1
            have h1 : q1 = w1 := beq_iff_eq.mp hq1
            subst h1
            exact Or.inl ⟨[], wRest2, rfl⟩
          · rcases optMin_eq_some hosa with ⟨dL, hL, _⟩ | ⟨dR, hR, _⟩
            · rcases optMin_eq_some hL with ⟨d1, h1, _⟩ | ⟨d2, h2, _⟩
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h1
                obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                exact Or.inr ⟨[q0, q2], qRest, by rw [← heq]; rfl⟩
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h2
                obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                exact Or.inr ⟨[q0, w1, q1, q2], qRest, by rw [← heq]; rfl⟩
            · rcases optMin_eq_some hR with ⟨d3, h3, _⟩ | ⟨d4, h4, _⟩
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h3
                obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                exact Or.inr ⟨[q0, w1, q2], qRest, by rw [← heq]; rfl⟩
              · rcases wRest2 with _ | ⟨w2, wRest3⟩
                · simp at h4
                · simp only at h4
                  split at h4
                  · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                    obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                    exact Or.inr ⟨[q0, w1, w2], qRest, by rw [← heq]; rfl⟩
                  · contradiction
      · rcases optMin_eq_some hosa with ⟨dL, hL, _⟩ | ⟨dR, hR, _⟩
        · rcases optMin_eq_some hL with ⟨d1, h1, _⟩ | ⟨d2, h2, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h1
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inr ⟨[q1, q2], qRest, by rw [← heq]; rfl⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h2
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inl ⟨[w0], q2 :: q3 :: q4 :: qRest, by rw [← heq]; rfl⟩
        · rcases optMin_eq_some hR with ⟨d3, h3, _⟩ | ⟨d4, h4, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h3
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inr ⟨[w0, q1, q2], qRest, by rw [← heq]; rfl⟩
          · rcases wRest with _ | ⟨w1, wRest2⟩
            · simp at h4
            · simp only at h4
              split at h4
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                exact Or.inr ⟨[w0, w1, q2], qRest, by rw [← heq]; rfl⟩
              · contradiction

private theorem tail_slices_of_osa1 (q3 q4 q5 q6 q7 : Nat) (qRest : List Nat) :
    ∀ (p u : List Nat) (d : Nat),
      osaWithin 1 (p ++ q3 :: q4 :: q5 :: q6 :: q7 :: qRest) u = some d →
      [q3, q4] <:+: u ∨ [q6, q7] <:+: u := by
  intro p
  induction p with
  | nil =>
    intro u d h
    have hp := prefilter1_sound (q3 :: q4 :: q5 :: q6 :: q7 :: qRest) u d
      (by simp only [List.length_cons]; omega) h
    rw [prefilter1Matches, Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq] at hp
    exact hp
  | cons x p' ih =>
    intro u d h
    rw [List.cons_append] at h
    cases u with
    | nil =>
      unfold osaWithin at h
      split at h
      · rename_i hbad
        simp only [List.length_cons, List.length_append] at hbad
        omega
      · contradiction
    | cons y u' =>
      unfold osaWithin at h
      split at h
      · rcases ih u' d h with h34 | h67
        · exact Or.inl (infix_cons_of_infix y h34)
        · exact Or.inr (infix_cons_of_infix y h67)
      · rcases optMin_eq_some h with ⟨dL, hL, _⟩ | ⟨dR, hR, _⟩
        · rcases optMin_eq_some hL with ⟨d1, h1, _⟩ | ⟨d2, h2, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h1
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inl ⟨p', q5 :: q6 :: q7 :: qRest, by rw [← heq]; simp [List.append_assoc]⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h2
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inl ⟨y :: x :: p', q5 :: q6 :: q7 :: qRest, by rw [← heq]; simp [List.append_assoc]⟩
        · rcases optMin_eq_some hR with ⟨d3, h3, _⟩ | ⟨d4, h4, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h3
            obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
            exact Or.inl ⟨y :: p', q5 :: q6 :: q7 :: qRest, by rw [← heq]; simp [List.append_assoc]⟩
          · cases p' with
            | nil =>
              rcases u' with _ | ⟨y2, u''⟩
              · simp at h4
              · simp only [List.nil_append] at h4
                split at h4
                · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                  obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                  exact Or.inr ⟨[y, y2, q4, q5], qRest, by rw [← heq]; rfl⟩
                · contradiction
            | cons x2 p'' =>
              rcases u' with _ | ⟨y2, u''⟩
              · simp at h4
              · simp only [List.cons_append] at h4
                split at h4
                · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                  obtain ⟨_, heq⟩ := osaWithin_zero_some _ _ d' hd'
                  exact Or.inl ⟨y :: y2 :: p'', q5 :: q6 :: q7 :: qRest, by rw [← heq]; simp [List.append_assoc]⟩
                · contradiction

/-- Any 2-edit OSA match on a token of length `≥ 8` preserves `q[0..2)`, `q[3..5)`, or `q[6..8)`. -/
theorem prefilter2_sound (q w : List Nat) (d : Nat)
    (hlen : 8 ≤ q.length) (hosa : osaWithin 2 q w = some d) :
    prefilter2Matches q w = true := by
  rcases q with _ | ⟨q0, _ | ⟨q1, _ | ⟨q2, _ | ⟨q3, _ | ⟨q4, _ | ⟨q5, _ | ⟨q6, _ | ⟨q7, qRest⟩⟩⟩⟩⟩⟩⟩⟩
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · simp at hlen
  · have hs0 : slice2 (q0 :: q1 :: q2 :: q3 :: q4 :: q5 :: q6 :: q7 :: qRest) 0 = [q0, q1] := rfl
    have hs3 : slice2 (q0 :: q1 :: q2 :: q3 :: q4 :: q5 :: q6 :: q7 :: qRest) 3 = [q3, q4] := rfl
    have hs6 : slice2 (q0 :: q1 :: q2 :: q3 :: q4 :: q5 :: q6 :: q7 :: qRest) 6 = [q6, q7] := rfl
    rw [prefilter2Matches, hs0, hs3, hs6, Bool.or_eq_true, Bool.or_eq_true,
        decide_eq_true_eq, decide_eq_true_eq, decide_eq_true_eq]
    rcases w with _ | ⟨w0, wRest⟩
    · unfold osaWithin at hosa
      split at hosa
      · rename_i hbad
        simp only [List.length_cons] at hbad
        omega
      · contradiction
    · unfold osaWithin at hosa
      split at hosa
      · rename_i hq0
        have h0 : q0 = w0 := beq_iff_eq.mp hq0
        subst h0
        rcases wRest with _ | ⟨w1, wRest2⟩
        · unfold osaWithin at hosa
          split at hosa
          · rename_i hbad
            simp only [List.length_cons] at hbad
            omega
          · contradiction
        · unfold osaWithin at hosa
          split at hosa
          · rename_i hq1
            have h1 : q1 = w1 := beq_iff_eq.mp hq1
            subst h1
            exact Or.inl (Or.inl ⟨[], wRest2, rfl⟩)
          · rcases optMin_eq_some hosa with ⟨dL, hL, _⟩ | ⟨dR, hR, _⟩
            · rcases optMin_eq_some hL with ⟨d1, h1, _⟩ | ⟨d2, h2, _⟩
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h1
                rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q2] (w1 :: wRest2) d' hd' with h34 | h67
                · exact Or.inl (Or.inr (infix_cons_of_infix q0 h34))
                · exact Or.inr (infix_cons_of_infix q0 h67)
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h2
                rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q1, q2] wRest2 d' hd' with h34 | h67
                · exact Or.inl (Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 h34)))
                · exact Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 h67))
            · rcases optMin_eq_some hR with ⟨d3, h3, _⟩ | ⟨d4, h4, _⟩
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h3
                rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q2] wRest2 d' hd' with h34 | h67
                · exact Or.inl (Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 h34)))
                · exact Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 h67))
              · rcases wRest2 with _ | ⟨w2, wRest3⟩
                · simp at h4
                · simp only at h4
                  split at h4
                  · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                    rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [] wRest3 d' hd' with h34 | h67
                    · exact Or.inl (Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 (infix_cons_of_infix w2 h34))))
                    · exact Or.inr (infix_cons_of_infix q0 (infix_cons_of_infix w1 (infix_cons_of_infix w2 h67)))
                  · contradiction
      · rcases optMin_eq_some hosa with ⟨dL, hL, _⟩ | ⟨dR, hR, _⟩
        · rcases optMin_eq_some hL with ⟨d1, h1, _⟩ | ⟨d2, h2, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h1
            rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q1, q2] (w0 :: wRest) d' hd' with h34 | h67
            · exact Or.inl (Or.inr h34)
            · exact Or.inr h67
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h2
            rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q0, q1, q2] wRest d' hd' with h34 | h67
            · exact Or.inl (Or.inr (infix_cons_of_infix w0 h34))
            · exact Or.inr (infix_cons_of_infix w0 h67)
        · rcases optMin_eq_some hR with ⟨d3, h3, _⟩ | ⟨d4, h4, _⟩
          · obtain ⟨d', hd', _⟩ := optSucc_eq_some h3
            rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q1, q2] wRest d' hd' with h34 | h67
            · exact Or.inl (Or.inr (infix_cons_of_infix w0 h34))
            · exact Or.inr (infix_cons_of_infix w0 h67)
          · rcases wRest with _ | ⟨w1, wRest2⟩
            · simp at h4
            · simp only at h4
              split at h4
              · obtain ⟨d', hd', _⟩ := optSucc_eq_some h4
                rcases tail_slices_of_osa1 q3 q4 q5 q6 q7 qRest [q2] wRest2 d' hd' with h34 | h67
                · exact Or.inl (Or.inr (infix_cons_of_infix w0 (infix_cons_of_infix w1 h34)))
                · exact Or.inr (infix_cons_of_infix w0 (infix_cons_of_infix w1 h67))
              · contradiction

/-- Token script classification for edit-distance budgets (`fuzzyAllowedEdits`). -/
inductive TokenKind where
  | numericOrTicker
  | cjk
  | katakana
  | ascii
  | mixed
  deriving DecidableEq, Repr, Inhabited

def allowedEdits : TokenKind → Nat → Nat
  | .numericOrTicker, _ => 0
  | .cjk, _ => 0
  | .mixed, _ => 0
  | .katakana, len => if 5 ≤ len then 1 else 0
  | .ascii, len => if 9 ≤ len then 2 else if 5 ≤ len then 1 else 0

theorem numeric_exact (len : Nat) : allowedEdits .numericOrTicker len = 0 := rfl
theorem cjk_exact (len : Nat) : allowedEdits .cjk len = 0 := rfl

theorem short_token_exact (kind : TokenKind) (len : Nat) (h : len < 5) :
    allowedEdits kind len = 0 := by
  by_cases h9 : 9 ≤ len
  · omega
  · by_cases h5 : 5 ≤ len
    · omega
    · cases kind <;> simp [allowedEdits, h9, h5]

theorem allowedEdits_one_len (kind : TokenKind) (len : Nat) (h : allowedEdits kind len = 1) :
    5 ≤ len := by
  by_cases h9 : 9 ≤ len
  · omega
  · by_cases h5 : 5 ≤ len
    · exact h5
    · cases kind <;> simp [allowedEdits, h9, h5] at h

theorem allowedEdits_two_len (kind : TokenKind) (len : Nat) (h : allowedEdits kind len = 2) :
    9 ≤ len := by
  by_cases h9 : 9 ≤ len
  · exact h9
  · by_cases h5 : 5 ≤ len
    · cases kind <;> simp [allowedEdits, h9, h5] at h
    · cases kind <;> simp [allowedEdits, h9, h5] at h

/-- Evaluation of one stored theme entry against a query term. -/
structure ThemeMatchFlags where
  matchesTargetOnly : Bool
  isAncillary : Bool
  matchesDirect : Bool
  matchesRelated : Bool
  deriving DecidableEq, Repr, Inhabited

def themeQualifiesDirect (flags : ThemeMatchFlags) : Bool :=
  !flags.matchesTargetOnly && !flags.isAncillary && flags.matchesDirect

def themeQualifiesRelated (flags : ThemeMatchFlags) : Bool :=
  !flags.matchesTargetOnly && !flags.isAncillary && flags.matchesRelated

theorem customer_or_ancillary_theme_excluded (flags : ThemeMatchFlags)
    (h : flags.matchesTargetOnly = true ∨ flags.isAncillary = true) :
    themeQualifiesDirect flags = false ∧ themeQualifiesRelated flags = false := by
  rcases h with ht | ha
  · simp [themeQualifiesDirect, themeQualifiesRelated, ht]
  · simp [themeQualifiesDirect, themeQualifiesRelated, ha]

/-- Per-term match channels on a candidate company (`CompanyTermMatch`). -/
structure TermMatch where
  identity : Bool
  directTheme : Bool
  relatedTheme : Bool
  sectorOrSegment : Bool
  activeBody : Bool
  deriving DecidableEq, Repr, Inhabited

def TermMatch.anchored (t : TermMatch) : Bool :=
  t.identity || t.directTheme || t.relatedTheme || t.sectorOrSegment

def TermMatch.satisfied (t : TermMatch) : Bool :=
  t.anchored || t.activeBody

/-- Ordered membership tiers (`CompanyMembershipTier`, rank 0..4). -/
inductive MembershipTier where
  | identity
  | directTheme
  | relatedTheme
  | sectorSegment
  | activeFiling
  deriving DecidableEq, Repr, Inhabited

def MembershipTier.rank : MembershipTier → Nat
  | .identity => 0
  | .directTheme => 1
  | .relatedTheme => 2
  | .sectorSegment => 3
  | .activeFiling => 4

/-- Classifies a company candidate (`classifyCompanyMembership`). -/
def classifyMembership (hasSummary isBlankCheck : Bool) (terms : List TermMatch) :
    Option MembershipTier :=
  if terms.isEmpty then none
  else if terms.all (·.identity) then some .identity
  else if isBlankCheck then none
  else if !(terms.all (·.satisfied)) then none
  else if hasSummary && !(terms.any (·.anchored)) then none
  else if terms.all (fun t => t.identity || t.directTheme) then some .directTheme
  else if terms.all (fun t => t.identity || t.directTheme || t.relatedTheme) then some .relatedTheme
  else if terms.all (·.anchored) then some .sectorSegment
  else some .activeFiling

theorem empty_terms_none (hasSummary isBlankCheck : Bool) :
    classifyMembership hasSummary isBlankCheck [] = none := rfl

theorem blank_check_excluded (hasSummary : Bool) (terms : List TermMatch)
    (hnonid : terms.all (·.identity) = false) :
    classifyMembership hasSummary true terms = none := by
  unfold classifyMembership
  cases terms with
  | nil => rfl
  | cons _ _ => simp [hnonid]

theorem body_only_with_summary_excluded (isBlankCheck : Bool) (terms : List TermMatch)
    (hnoanchor : ∀ t ∈ terms, t.anchored = false) :
    classifyMembership true isBlankCheck terms = none := by
  unfold classifyMembership
  cases terms with
  | nil => rfl
  | cons head tail =>
    have hhead : head.anchored = false := hnoanchor head (by simp)
    have hid_false : head.identity = false := by
      simp only [TermMatch.anchored, Bool.or_eq_false_iff] at hhead
      exact hhead.1.1.1
    have hall_id : (head :: tail).all (·.identity) = false := by
      simp [hid_false]
    have hany_anchor : (head :: tail).any (·.anchored) = false := by
      rw [List.any_eq_false]
      intro t ht
      simp [hnoanchor t ht]
    simp [hall_id, hany_anchor]

theorem unsatisfied_term_excluded (hasSummary isBlankCheck : Bool) (terms : List TermMatch)
    (t : TermMatch) (hmem : t ∈ terms) (hunsat : t.satisfied = false) :
    classifyMembership hasSummary isBlankCheck terms = none := by
  unfold classifyMembership
  cases terms with
  | nil => contradiction
  | cons head tail =>
    have hid_false : t.identity = false := by
      simp only [TermMatch.satisfied, TermMatch.anchored, Bool.or_eq_false_iff] at hunsat
      exact hunsat.1.1.1.1
    have hall_id : (head :: tail).all (·.identity) = false := by
      rw [List.all_eq_false]
      exact ⟨t, hmem, by simp [hid_false]⟩
    have hall_sat : (head :: tail).all (·.satisfied) = false := by
      rw [List.all_eq_false]
      exact ⟨t, hmem, by simp [hunsat]⟩
    simp [hall_id, hall_sat]

theorem classified_summary_has_anchor (isBlankCheck : Bool) (terms : List TermMatch)
    (tier : MembershipTier)
    (h : classifyMembership true isBlankCheck terms = some tier) :
    ∃ t ∈ terms, t.anchored = true := by
  exact Classical.byContradiction fun hnone => by
    have hall : ∀ t ∈ terms, t.anchored = false := by
      intro t ht
      cases hanc : t.anchored with
      | false => rfl
      | true => exact False.elim (hnone ⟨t, ht, hanc⟩)
    rw [body_only_with_summary_excluded isBlankCheck terms hall] at h
    contradiction

theorem identity_highest_tier (hasSummary isBlankCheck : Bool) (terms : List TermMatch)
    (hne : terms ≠ []) (hid : ∀ t ∈ terms, t.identity = true) :
    classifyMembership hasSummary isBlankCheck terms = some .identity := by
  unfold classifyMembership
  have hempty : terms.isEmpty = false := List.isEmpty_eq_false_iff.mpr hne
  have hall : terms.all (·.identity) = true := List.all_eq_true.mpr hid
  simp [hempty, hall]

end Research.CompanyScreening
