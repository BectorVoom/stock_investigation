import ResearchFormal.Basic

/-!
# Stock directory search

Formal model of `packages/domain/src/watchlist/stockSearch.ts` (ADR-0034):
`foldStockSearchText`, `stockSearchTerms`, `stockSearchKeys`,
`stockSearchHaystack`, `stockSearchTier`, `compareStockSearchHits` and
`rankStockSearch`.

**The model starts after NFKC.** `foldStockSearchText` first applies
`String.prototype.normalize("NFKC")`; Unicode normalization is outside the
model. Text is a list of code points (`List Nat`): the TypeScript loop walks
code points (`for … of`), so every step below mirrors one loop iteration.

**Whitespace** is the set of code points the TypeScript `/\s/u` matches that
NFKC leaves unchanged: TAB, LF, VT, FF, CR, SPACE, U+1680, U+2028, U+2029 and
U+FEFF. The other `\s` code points (U+00A0, U+2000–U+200A, U+202F, U+205F,
U+3000) all normalize to SPACE, so after NFKC this set is exact: on
NFKC-normalized text the model's whitespace test agrees with `/\s/u` on
every code point.

**Length and order are by code point.** The TypeScript slices the query by
UTF-16 unit and compares symbols and markets by UTF-16 unit. The two agree on
the Basic Multilingual Plane, which is where every conformance vector stays
(symbols and markets are ASCII in the directory).

Proved below:
1. `rank_sound` — every ranked row is an input row and matches every term,
   each term inside one of its three keys;
2. `rank_complete` — when no more than `limit` rows match, every matching
   row is ranked;
3. `rankHits_sorted`, `rankHits_tier`, `rank_length_le`, `clampLimit_bounds`
   — the hits are sorted by (tier, symbol length, symbol, market), each
   carries its row's tier, and there are at most `limit` (1..20) of them;
4. `fold_idem`, `fold_no_leading_space`, `fold_no_trailing_space`,
   `fold_no_double_space`, `fold_whitespace_is_space` — the fold is
   idempotent and its output is single-spaced and trimmed;
5. `infix_join_iff`, `term_in_haystack_iff` — a term without a newline is
   in the newline-joined haystack exactly when it is in one key, so no term
   ever matches across two fields;
6. `rankHits_exact_first`, `rank_head_exact`, `exact_in_rank` — an
   exact-symbol hit (tier 0) precedes every other hit, heads the result
   whenever one exists, and is never cut off while the exact hits fit the
   limit.
-/

namespace Research
namespace StockSearch

/-- Text after NFKC, as code points. -/
abbrev Text := List Nat

def space : Nat := 32
def newline : Nat := 10

/-- `/\s/u` restricted to the code points NFKC leaves unchanged. -/
def isWs (c : Nat) : Bool :=
  decide (c = 9 ∨ c = 10 ∨ c = 11 ∨ c = 12 ∨ c = 13 ∨ c = 32 ∨
    c = 0x1680 ∨ c = 0x2028 ∨ c = 0x2029 ∨ c = 0xFEFF)

/-- One non-whitespace code point: ASCII A–Z lower-cased, hiragana
    U+3041–U+3096 shifted to katakana, everything else kept. -/
def foldChar (c : Nat) : Nat :=
  if 0x41 ≤ c ∧ c ≤ 0x5A then c + 0x20
  else if 0x3041 ≤ c ∧ c ≤ 0x3096 then c + 0x60
  else c

/-- The TypeScript loop: `out` is `folded`, `pending` is `pendingSpace`. -/
def foldLoop : Text → Text → Bool → Text
  | [], out, _ => out
  | c :: cs, out, pending =>
    if isWs c then foldLoop cs out (!out.isEmpty)
    else foldLoop cs ((if pending then out ++ [space] else out) ++ [foldChar c]) false

/-- `foldStockSearchText` after NFKC. -/
def fold (s : Text) : Text := foldLoop s [] false

/-! ## The fold -/

theorem isWs_space : isWs space = true := by decide

theorem foldChar_not_ws {c : Nat} (h : isWs c = false) : isWs (foldChar c) = false := by
  simp only [isWs, decide_eq_false_iff_not] at h ⊢
  unfold foldChar
  split
  · omega
  · split <;> omega

theorem foldChar_idem (c : Nat) : foldChar (foldChar c) = foldChar c := by
  unfold foldChar
  split
  · rw [ifNeg (by omega), ifNeg (by omega)]
  · split
    · rw [ifNeg (by omega), ifNeg (by omega)]
    · rfl

theorem foldChar_ne_space {c : Nat} (h : isWs c = false) : foldChar c ≠ space := by
  intro he
  have := foldChar_not_ws h
  rw [he, isWs_space] at this
  exact Bool.noConfusion this

/-- No two spaces in a row. -/
def NoDouble : Text → Prop
  | a :: b :: rest => ¬(a = space ∧ b = space) ∧ NoDouble (b :: rest)
  | _ => True

/-- A code point the fold leaves alone: not whitespace and a fixed point. -/
def Settled (x : Nat) : Prop := isWs x = false ∧ foldChar x = x

/-- What every fold output satisfies. -/
structure Clean (out : Text) : Prop where
  chars : ∀ x ∈ out, x = space ∨ Settled x
  noDouble : NoDouble out
  head : out.head? ≠ some space
  last : out.getLast? ≠ some space

theorem noDouble_snoc {l : Text} {x : Nat} (h : NoDouble l)
    (hx : l.getLast? = some space → x ≠ space) : NoDouble (l ++ [x]) := by
  induction l with
  | nil => simp [NoDouble]
  | cons a rest ih =>
    cases rest with
    | nil =>
      simp only [List.getLast?_singleton, Option.some.injEq] at hx
      simp only [List.cons_append, List.nil_append, NoDouble, and_true]
      intro ⟨ha, hx'⟩
      exact hx ha hx'
    | cons b rest' =>
      simp only [NoDouble] at h
      simp only [List.cons_append, NoDouble]
      refine ⟨h.1, ?_⟩
      have := ih h.2 (by rw [List.getLast?_cons_cons] at hx; exact hx)
      simpa using this

theorem clean_nil : Clean [] where
  chars := by simp
  noDouble := by simp [NoDouble]
  head := by simp
  last := by simp

theorem settled_foldChar {c : Nat} (h : isWs c = false) : Settled (foldChar c) :=
  ⟨foldChar_not_ws h, foldChar_idem c⟩

/-- One non-whitespace step keeps the output clean. -/
theorem clean_step {out : Text} {p : Bool} {c : Nat} (hc : Clean out)
    (hp : p = true → out ≠ []) (hw : isWs c = false) :
    Clean ((if p then out ++ [space] else out) ++ [foldChar c]) := by
  have hne := foldChar_ne_space hw
  have hset := settled_foldChar hw
  cases p with
  | true =>
    have hout := hp rfl
    simp only [ite_true]
    refine ⟨?_, ?_, ?_, ?_⟩
    · intro x hx
      simp only [List.mem_append, List.mem_singleton] at hx
      rcases hx with (hx | hx) | hx
      · exact hc.chars x hx
      · exact Or.inl hx
      · exact Or.inr (hx ▸ hset)
    · refine noDouble_snoc (noDouble_snoc hc.noDouble (fun h => absurd h hc.last)) ?_
      intro _; exact hne
    · rw [List.append_assoc, List.head?_append]
      cases hh : out.head? with
      | none => rw [List.head?_eq_none_iff] at hh; exact absurd hh hout
      | some a => have h1 := hc.head; rw [hh] at h1; simpa using h1
    · rw [List.getLast?_concat]; simpa using hne
  | false =>
    simp only [Bool.false_eq_true, ite_false]
    refine ⟨?_, ?_, ?_, ?_⟩
    · intro x hx
      simp only [List.mem_append, List.mem_singleton] at hx
      rcases hx with hx | hx
      · exact hc.chars x hx
      · exact Or.inr (hx ▸ hset)
    · exact noDouble_snoc hc.noDouble (fun _ => hne)
    · rw [List.head?_append]
      cases hh : out.head? with
      | none => simpa using hne
      | some a => have h1 := hc.head; rw [hh] at h1; simpa using h1
    · rw [List.getLast?_concat]; simpa using hne

theorem foldLoop_clean (s : Text) :
    ∀ (out : Text) (p : Bool), Clean out → (p = true → out ≠ []) → Clean (foldLoop s out p) := by
  induction s with
  | nil => intro out p hc _; exact hc
  | cons c cs ih =>
    intro out p hc hp
    unfold foldLoop
    split
    · refine ih out _ hc ?_
      intro h
      cases out with
      | nil => simp at h
      | cons _ _ => simp
    · rename_i hw
      exact ih _ false (clean_step hc hp (by simpa using hw)) (by simp)

theorem fold_clean (s : Text) : Clean (fold s) :=
  foldLoop_clean s [] false clean_nil (by simp)

/-- **(4a) No leading space.** -/
theorem fold_no_leading_space (s : Text) : (fold s).head? ≠ some space :=
  (fold_clean s).head

/-- **(4b) No trailing space.** -/
theorem fold_no_trailing_space (s : Text) : (fold s).getLast? ≠ some space :=
  (fold_clean s).last

theorem not_double_infix_of_noDouble {l : Text} (h : NoDouble l) : ¬[space, space] <:+: l := by
  induction l with
  | nil => intro hi; have := hi.length_le; simp at this
  | cons a rest ih =>
    intro hi
    rw [List.infix_cons_iff] at hi
    cases rest with
    | nil =>
      rcases hi with hp | hi
      · have := hp.length_le; simp at this
      · have := hi.length_le; simp at this
    | cons b rest' =>
      simp only [NoDouble] at h
      rcases hi with hp | hi
      · rw [List.cons_prefix_cons, List.cons_prefix_cons] at hp
        exact h.1 ⟨hp.1.symm, hp.2.1.symm⟩
      · exact ih h.2 hi

/-- **(4c) No double space.** -/
theorem fold_no_double_space (s : Text) : ¬[space, space] <:+: fold s :=
  not_double_infix_of_noDouble (fold_clean s).noDouble

/-- **(4d) The only whitespace left is SPACE** (in particular no newline). -/
theorem fold_whitespace_is_space (s : Text) : ∀ x ∈ fold s, isWs x = true → x = space := by
  intro x hx hw
  rcases (fold_clean s).chars x hx with h | h
  · exact h
  · rw [h.1] at hw; exact Bool.noConfusion hw

theorem newline_not_mem_fold (s : Text) : newline ∉ fold s := by
  intro h
  have := fold_whitespace_is_space s newline h (by decide)
  exact absurd this (by decide)

/-- The fold leaves clean text unchanged (the loop replays it verbatim). -/
theorem foldLoop_settled (l : Text) :
    ∀ (out : Text) (p : Bool),
      (∀ x ∈ l, x = space ∨ Settled x) → NoDouble l → l.getLast? ≠ some space →
      (p = true → out ≠ [] ∧ l.head? ≠ some space ∧ l ≠ []) →
      (l.head? = some space → out ≠ [] ∧ p = false) →
      foldLoop l out p = out ++ (if p then [space] else []) ++ l := by
  induction l with
  | nil =>
    intro out p _ _ _ hp _
    cases p with
    | true => exact absurd rfl (hp rfl).2.2
    | false => simp [foldLoop]
  | cons c cs ih =>
    intro out p hchars hnd hlast hp hhead
    have hcs : ∀ x ∈ cs, x = space ∨ Settled x := fun x hx => hchars x (by simp [hx])
    have hlast' : cs.getLast? ≠ some space := by
      cases cs with
      | nil => simp
      | cons d ds => rwa [List.getLast?_cons_cons] at hlast
    have hnd' : NoDouble cs := by
      cases cs with
      | nil => simp [NoDouble]
      | cons d ds => exact hnd.2
    rcases hchars c (by simp) with hc | hc
    · -- a space: the previous output is non-empty, so the space is pending
      have ⟨hout, hpf⟩ := hhead (by simp [hc])
      subst hpf
      have hws : isWs c = true := by rw [hc]; decide
      have hcs_ne : cs ≠ [] := by
        intro he; subst he; simp [hc] at hlast
      have hcs_head : cs.head? ≠ some space := by
        cases cs with
        | nil => exact absurd rfl hcs_ne
        | cons d ds =>
          simp only [List.head?_cons, ne_eq, Option.some.injEq]
          intro hd; exact hnd.1 ⟨hc, hd⟩
      have hempty : (!out.isEmpty) = true := by
        cases out with
        | nil => exact absurd rfl hout
        | cons _ _ => rfl
      simp only [foldLoop, hws, ite_true, hempty]
      rw [ih out true hcs hnd' hlast' (fun _ => ⟨hout, hcs_head, hcs_ne⟩)
        (fun h => absurd h hcs_head)]
      simp [hc]
    · have hws : isWs c = false := hc.1
      simp only [foldLoop, hws, Bool.false_eq_true, ite_false]
      rw [ih _ false hcs hnd' hlast' (fun h => Bool.noConfusion h) (fun _ => ⟨by simp, rfl⟩)]
      rw [hc.2]
      cases p <;> simp

/-- **(4) The fold is idempotent.** -/
theorem fold_idem (s : Text) : fold (fold s) = fold s := by
  have hc := fold_clean s
  unfold fold
  rw [foldLoop_settled (foldLoop s [] false) [] false hc.chars hc.noDouble hc.last
    (fun h => Bool.noConfusion h) (fun h => absurd h hc.head)]
  simp

/-! ## Terms -/

/-- `STOCK_SEARCH_LIMITS`. -/
def maxQueryChars : Nat := 64
def maxTerms : Nat := 4
def maxResults : Nat := 20

/-- `String.prototype.split(" ")`: one piece per space-separated run, empty
    pieces included (the fold leaves none). -/
def splitSpace : Text → List Text
  | [] => [[]]
  | c :: cs =>
    if c = space then [] :: splitSpace cs
    else match splitSpace cs with
      | [] => [[c]]
      | w :: ws => (c :: w) :: ws

/-- `stockSearchTerms`: the first `maxQueryChars` code points, folded, split
    on spaces, at most `maxTerms` terms; none for a blank query. -/
def terms (q : Text) : List Text :=
  let folded := fold (q.take maxQueryChars)
  if folded = [] then [] else (splitSpace folded).take maxTerms

theorem mem_splitSpace {l t : Text} (ht : t ∈ splitSpace l) : ∀ x ∈ t, x ∈ l ∧ x ≠ space := by
  induction l generalizing t with
  | nil => simp [splitSpace] at ht; subst ht; simp
  | cons c cs ih =>
    unfold splitSpace at ht
    split at ht
    · simp only [List.mem_cons] at ht
      rcases ht with ht | ht
      · subst ht; simp
      · intro x hx; have := ih ht x hx; exact ⟨List.mem_cons_of_mem _ this.1, this.2⟩
    · rename_i hc
      split at ht
      · simp only [List.mem_singleton] at ht; subst ht
        intro x hx; simp only [List.mem_singleton] at hx; subst hx; exact ⟨by simp, hc⟩
      · rename_i w ws hsplit
        simp only [List.mem_cons] at ht
        rcases ht with ht | ht
        · subst ht
          intro x hx
          simp only [List.mem_cons] at hx
          rcases hx with hx | hx
          · subst hx; exact ⟨by simp, hc⟩
          · have := ih (t := w) (by rw [hsplit]; simp) x hx
            exact ⟨List.mem_cons_of_mem _ this.1, this.2⟩
        · intro x hx
          have := ih (t := t) (by rw [hsplit]; simp [ht]) x hx
          exact ⟨List.mem_cons_of_mem _ this.1, this.2⟩

/-- No term holds whitespace (so no space and no newline). -/
theorem terms_no_ws {q t : Text} (ht : t ∈ terms q) : ∀ x ∈ t, isWs x = false := by
  intro x hx
  unfold terms at ht
  simp only at ht
  split at ht
  · simp at ht
  · have ⟨hmem, hne⟩ := mem_splitSpace (List.mem_of_mem_take ht) x hx
    cases hw : isWs x with
    | false => rfl
    | true => exact absurd (fold_whitespace_is_space _ x hmem hw) hne

theorem newline_not_mem_term {q t : Text} (ht : t ∈ terms q) : newline ∉ t := by
  intro h
  have := terms_no_ws ht newline h
  exact Bool.noConfusion this

theorem terms_length_le (q : Text) : (terms q).length ≤ maxTerms := by
  unfold terms
  simp only
  split
  · simp
  · exact List.length_take_le _ _

/-! ## Keys, haystack and the cross-field argument -/

/-- One directory row. `localName` is the Japanese name of a JP listing. -/
structure Row where
  market : Text
  symbol : Text
  name : Text
  localName : Option Text
  deriving DecidableEq, Repr

/-- `stockSearchKeys`. -/
structure Keys where
  symbolKey : Text
  nameKey : Text
  localNameKey : Text

def keys (r : Row) : Keys :=
  ⟨fold r.symbol, fold r.name, (r.localName.map fold).getD []⟩

/-- `stockSearchHaystack`: the keys joined by newlines. -/
def haystack (k : Keys) : Text :=
  k.symbolKey ++ [newline] ++ k.nameKey ++ [newline] ++ k.localNameKey

theorem keys_no_newline (r : Row) :
    newline ∉ (keys r).symbolKey ∧ newline ∉ (keys r).nameKey ∧
      newline ∉ (keys r).localNameKey := by
  refine ⟨newline_not_mem_fold _, newline_not_mem_fold _, ?_⟩
  cases h : r.localName with
  | none => simp [keys, h]
  | some n => simp only [keys, h, Option.map_some, Option.getD_some]; exact newline_not_mem_fold n

/-- A prefix of `a ++ sep :: b` that avoids `sep` is a prefix of `a`, or `a`
    is a prefix of it — in which case it is at most `a` long. -/
theorem prefix_sep {t a b : Text} {sep : Nat} (ht : sep ∉ t) (hp : t <+: a ++ sep :: b) :
    t <+: a := by
  induction a generalizing t with
  | nil =>
    cases t with
    | nil => exact List.nil_prefix
    | cons x xs =>
      rw [List.nil_append, List.cons_prefix_cons] at hp
      exact absurd (hp.1 ▸ List.mem_cons_self) ht
  | cons y ys ih =>
    cases t with
    | nil => exact List.nil_prefix
    | cons x xs =>
      rw [List.cons_append, List.cons_prefix_cons] at hp
      rw [List.cons_prefix_cons]
      exact ⟨hp.1, ih (fun h => ht (List.mem_cons_of_mem _ h)) hp.2⟩

/-- An infix of `a ++ sep :: b` that avoids `sep` lies in `a` or in `b`. -/
theorem infix_sep_iff {t a b : Text} {sep : Nat} (ht : sep ∉ t) :
    t <:+: a ++ sep :: b ↔ t <:+: a ∨ t <:+: b := by
  constructor
  · intro h
    induction a with
    | nil =>
      rw [List.nil_append, List.infix_cons_iff] at h
      rcases h with hp | hi
      · cases t with
        | nil => exact Or.inl (List.nil_infix)
        | cons x xs =>
          rw [List.cons_prefix_cons] at hp
          exact absurd (hp.1 ▸ List.mem_cons_self) ht
      · exact Or.inr hi
    | cons y ys ih =>
      rw [List.cons_append, List.infix_cons_iff] at h
      rcases h with hp | hi
      · rw [← List.cons_append] at hp
        exact Or.inl (prefix_sep ht hp).isInfix
      · rcases ih hi with h | h
        · exact Or.inl (List.infix_cons h)
        · exact Or.inr h
  · intro h
    rcases h with h | h
    · exact h.trans List.infix_append_left
    · exact (List.infix_cons h).trans (List.suffix_append _ _).isInfix

/-- **(5) A term never matches across two fields.** A term with no newline is
    inside the newline-joined keys exactly when it is inside one of them.
    (Stronger than needed: the keys may even hold newlines.) -/
theorem infix_join_iff {t a b c : Text} (ht : newline ∉ t) :
    t <:+: a ++ [newline] ++ b ++ [newline] ++ c ↔ t <:+: a ∨ t <:+: b ∨ t <:+: c := by
  have e : a ++ [newline] ++ b ++ [newline] ++ c = a ++ newline :: (b ++ newline :: c) := by simp
  rw [e, infix_sep_iff ht, infix_sep_iff ht]

/-- (5) applied: every query term is in a row's haystack exactly when it is
    in one of the row's keys. -/
theorem term_in_haystack_iff {q t : Text} (r : Row) (ht : t ∈ terms q) :
    t <:+: haystack (keys r) ↔
      t <:+: (keys r).symbolKey ∨ t <:+: (keys r).nameKey ∨ t <:+: (keys r).localNameKey :=
  infix_join_iff (newline_not_mem_term ht)

/-! ## Tier -/

/-- `stockSearchTier`: 0 exact symbol (one term), 1 symbol prefix, 2 name or
    local-name prefix, 3 other match — the prefix tiers look at the first
    term only; `none` when there are no terms or a term is in no key. -/
def tier (k : Keys) : List Text → Option Nat
  | [] => none
  | first :: rest =>
    if (first :: rest).all (fun t => decide (t <:+: haystack k)) then
      if rest = [] ∧ k.symbolKey = first then some 0
      else if first.isPrefixOf k.symbolKey then some 1
      else if first.isPrefixOf k.nameKey || first.isPrefixOf k.localNameKey then some 2
      else some 3
    else none

theorem tier_cons (k : Keys) (first : Text) (rest : List Text) :
    tier k (first :: rest) =
      if (first :: rest).all (fun t => decide (t <:+: haystack k)) then
        if rest = [] ∧ k.symbolKey = first then some 0
        else if first.isPrefixOf k.symbolKey then some 1
        else if first.isPrefixOf k.nameKey || first.isPrefixOf k.localNameKey then some 2
        else some 3
      else none := rfl

/-- A row matches when there is a term and every term is inside one key. -/
def Matches (k : Keys) (ts : List Text) : Prop :=
  ts ≠ [] ∧ ∀ t ∈ ts, t <:+: k.symbolKey ∨ t <:+: k.nameKey ∨ t <:+: k.localNameKey

instance (k : Keys) (ts : List Text) : Decidable (Matches k ts) :=
  inferInstanceAs (Decidable (_ ∧ _))

theorem tier_isSome_iff (k : Keys) (ts : List Text) :
    (tier k ts).isSome ↔ ts ≠ [] ∧ ∀ t ∈ ts, t <:+: haystack k := by
  cases ts with
  | nil => simp [tier]
  | cons first rest =>
    rw [tier_cons]
    split
    · rename_i h
      simp only [List.all_eq_true, decide_eq_true_eq] at h
      refine ⟨fun _ => ⟨by simp, h⟩, fun _ => ?_⟩
      split
      · rfl
      · split
        · rfl
        · split <;> rfl
    · rename_i h
      simp only [List.all_eq_true, decide_eq_true_eq] at h
      simp only [Option.isSome_none, Bool.false_eq_true, false_iff, not_and]
      exact fun _ => h

theorem tier_le_three (k : Keys) (ts : List Text) {n : Nat} (h : tier k ts = some n) : n ≤ 3 := by
  cases ts with
  | nil => simp [tier] at h
  | cons first rest =>
    rw [tier_cons] at h
    split at h
    · split at h
      · simp at h; omega
      · split at h
        · simp at h; omega
        · split at h <;> (simp at h; omega)
    · simp at h

/-- A query's tier is defined exactly for the matching rows. -/
theorem tier_isSome_iff_matches (r : Row) (q : Text) :
    (tier (keys r) (terms q)).isSome ↔ Matches (keys r) (terms q) := by
  rw [tier_isSome_iff]
  unfold Matches
  constructor
  · intro ⟨hne, h⟩
    exact ⟨hne, fun t ht => (term_in_haystack_iff r ht).mp (h t ht)⟩
  · intro ⟨hne, h⟩
    exact ⟨hne, fun t ht => (term_in_haystack_iff r ht).mpr (h t ht)⟩

/-! ## Order -/

/-- UTF-16 / SQLite BINARY order on (BMP) text: code point by code point, a
    proper prefix first. -/
def lexLe : Text → Text → Bool
  | [], _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => if a = b then lexLe as bs else decide (a < b)

theorem lexLe_total : ∀ (a b : Text), (lexLe a b || lexLe b a) = true
  | [], _ => by simp [lexLe]
  | _ :: _, [] => by simp [lexLe]
  | x :: xs, y :: ys => by
    by_cases h : x = y
    · subst h; simp only [lexLe, ite_true]; exact lexLe_total xs ys
    · have h' : ¬y = x := fun e => h e.symm
      simp only [lexLe, h, h', ite_false, Bool.or_eq_true, decide_eq_true_eq]
      omega

theorem lexLe_trans : ∀ (a b c : Text), lexLe a b = true → lexLe b c = true → lexLe a c = true
  | [], _, _ => by simp [lexLe]
  | _ :: _, [], _ => by simp [lexLe]
  | _ :: _, _ :: _, [] => by simp [lexLe]
  | x :: xs, y :: ys, z :: zs => by
    intro h1 h2
    simp only [lexLe] at h1 h2 ⊢
    by_cases hxy : x = y <;> by_cases hyz : y = z
    · subst hxy; subst hyz; simp only [ite_true] at h1 h2 ⊢; exact lexLe_trans xs ys zs h1 h2
    · subst hxy; simp only [ite_true, hyz, ite_false] at h1 h2 ⊢; exact h2
    · subst hyz; simp only [hxy, ite_false] at h1 h2 ⊢; exact h1
    · simp only [hxy, hyz, ite_false, decide_eq_true_eq] at h1 h2
      have hxz : ¬x = z := by omega
      simp only [hxz, ite_false, decide_eq_true_eq]; omega

theorem lexLe_antisymm : ∀ (a b : Text), lexLe a b = true → lexLe b a = true → a = b
  | [], [], _, _ => rfl
  | [], _ :: _, _, h => by simp [lexLe] at h
  | _ :: _, [], h, _ => by simp [lexLe] at h
  | x :: xs, y :: ys, h1, h2 => by
    by_cases hxy : x = y
    · subst hxy; simp only [lexLe, ite_true] at h1 h2; rw [lexLe_antisymm xs ys h1 h2]
    · have hyx : ¬y = x := fun e => hxy e.symm
      simp only [lexLe, hxy, hyx, ite_false, decide_eq_true_eq] at h1 h2; omega

/-- A ranked row with its tier. -/
abbrev Hit := Row × Nat

/-- `compareStockSearchHits a b ≤ 0`: tier, then shorter symbol, then symbol,
    then market. -/
def hitLe (a b : Hit) : Bool :=
  if a.2 ≠ b.2 then decide (a.2 < b.2)
  else if a.1.symbol.length ≠ b.1.symbol.length then
    decide (a.1.symbol.length < b.1.symbol.length)
  else if a.1.symbol ≠ b.1.symbol then lexLe a.1.symbol b.1.symbol
  else lexLe a.1.market b.1.market

theorem hitLe_tier {a b : Hit} (h : hitLe a b = true) : a.2 ≤ b.2 := by
  unfold hitLe at h
  split at h
  · simp at h; omega
  · omega

theorem hitLe_total (a b : Hit) : (hitLe a b || hitLe b a) = true := by
  unfold hitLe
  by_cases h1 : a.2 = b.2
  · simp only [h1, ne_eq, not_true_eq_false, ite_false]
    by_cases h2 : a.1.symbol.length = b.1.symbol.length
    · simp only [h2, not_true_eq_false, ite_false]
      by_cases h3 : a.1.symbol = b.1.symbol
      · simp only [h3, not_true_eq_false, ite_false]
        exact lexLe_total _ _
      · have h3' : ¬b.1.symbol = a.1.symbol := fun e => h3 e.symm
        simp only [h3, h3', not_false_eq_true, ite_true]
        exact lexLe_total _ _
    · have h2' : ¬b.1.symbol.length = a.1.symbol.length := fun e => h2 e.symm
      simp only [h2, h2', not_false_eq_true, ite_true, Bool.or_eq_true, decide_eq_true_eq]
      omega
  · have h1' : ¬b.2 = a.2 := fun e => h1 e.symm
    simp only [ne_eq, h1, h1', not_false_eq_true, ite_true, Bool.or_eq_true, decide_eq_true_eq]
    omega

theorem hitLe_trans : ∀ (a b c : Hit), hitLe a b = true → hitLe b c = true → hitLe a c = true
  | (⟨ma, sa, na, la⟩, ta), (⟨mb, sb, nb, lb⟩, tb), (⟨mc, sc, nc, lc⟩, tc) => by
    intro hab hbc
    simp only [hitLe, ne_eq] at hab hbc ⊢
    by_cases e1 : ta = tb
    · subst e1
      simp only [not_true_eq_false, ite_false] at hab
      by_cases e2 : ta = tc
      · subst e2
        simp only [not_true_eq_false, ite_false] at hbc ⊢
        by_cases l1 : sa.length = sb.length
        · simp only [l1, not_true_eq_false, ite_false] at hab ⊢
          by_cases l2 : sb.length = sc.length
          · simp only [l2, not_true_eq_false, ite_false] at hbc ⊢
            by_cases s1 : sa = sb
            · subst s1
              simp only [not_true_eq_false, ite_false] at hab
              by_cases s2 : sa = sc
              · subst s2
                simp only [not_true_eq_false, ite_false] at hbc ⊢
                exact lexLe_trans _ _ _ hab hbc
              · simp only [s2, not_false_eq_true, ite_true] at hbc ⊢
                exact hbc
            · simp only [s1, not_false_eq_true, ite_true] at hab
              by_cases s2 : sb = sc
              · subst s2
                simp only [s1, not_false_eq_true, ite_true]
                exact hab
              · simp only [s2, not_false_eq_true, ite_true] at hbc
                by_cases s3 : sa = sc
                · subst s3; exact absurd (lexLe_antisymm _ _ hab hbc) s1
                · simp only [s3, not_false_eq_true, ite_true]
                  exact lexLe_trans _ _ _ hab hbc
          · simp only [l2, not_false_eq_true, ite_true] at hbc ⊢
            exact hbc
        · simp only [l1, not_false_eq_true, ite_true, decide_eq_true_eq] at hab
          by_cases l2 : sb.length = sc.length
          · have l3 : ¬sa.length = sc.length := by omega
            simp only [l3, not_false_eq_true, ite_true, decide_eq_true_eq]
            omega
          · simp only [l2, not_false_eq_true, ite_true, decide_eq_true_eq] at hbc
            have l3 : ¬sa.length = sc.length := by omega
            simp only [l3, not_false_eq_true, ite_true, decide_eq_true_eq]
            omega
      · simp only [e2, not_false_eq_true, ite_true, decide_eq_true_eq] at hbc ⊢
        exact hbc
    · simp only [e1, not_false_eq_true, ite_true, decide_eq_true_eq] at hab
      by_cases e2 : tb = tc
      · subst e2
        simp only [e1, not_false_eq_true, ite_true, decide_eq_true_eq]
        exact hab
      · simp only [e2, not_false_eq_true, ite_true, decide_eq_true_eq] at hbc
        have e3 : ¬ta = tc := by omega
        simp only [e3, not_false_eq_true, ite_true, decide_eq_true_eq]
        omega

/-! ## Rank -/

/-- `Math.min(Math.max(Math.trunc(limit), 1), maxResults)`, for an integral
    `limit`. -/
def clampLimit (limit : Int) : Nat := (min (max limit 1) (maxResults : Int)).toNat

theorem clampLimit_bounds (limit : Int) : 1 ≤ clampLimit limit ∧ clampLimit limit ≤ maxResults := by
  unfold clampLimit maxResults
  omega

/-- Every row with a tier, in input order. -/
def hits (rows : List Row) (ts : List Text) : List Hit :=
  rows.filterMap fun r => (tier (keys r) ts).map fun n => (r, n)

/-- The sorted hits, cut at the limit. `List.mergeSort` is stable, as is
    `Array.prototype.sort`, so ties (equal tier, symbol and market) keep the
    input order in both. -/
def rankHits (rows : List Row) (q : Text) (limit : Int) : List Hit :=
  let ts := terms q
  if ts = [] then [] else ((hits rows ts).mergeSort hitLe).take (clampLimit limit)

/-- `rankStockSearch`. -/
def rank (rows : List Row) (q : Text) (limit : Int) : List Row :=
  (rankHits rows q limit).map Prod.fst

theorem mem_hits {rows : List Row} {ts : List Text} {h : Hit} :
    h ∈ hits rows ts ↔ h.1 ∈ rows ∧ tier (keys h.1) ts = some h.2 := by
  unfold hits
  rw [List.mem_filterMap]
  constructor
  · intro ⟨r, hr, he⟩
    cases ht : tier (keys r) ts with
    | none => rw [ht] at he; simp at he
    | some n =>
      rw [ht] at he
      simp only [Option.map_some, Option.some.injEq] at he
      subst he
      exact ⟨hr, ht⟩
  · intro ⟨hr, ht⟩
    exact ⟨h.1, hr, by rw [ht]; rfl⟩

/-- Each ranked hit is a hit: an input row carrying its own tier. -/
theorem rankHits_tier {rows : List Row} {q : Text} {limit : Int} {h : Hit}
    (hm : h ∈ rankHits rows q limit) : h.1 ∈ rows ∧ tier (keys h.1) (terms q) = some h.2 := by
  unfold rankHits at hm
  simp only at hm
  split at hm
  · simp at hm
  · exact mem_hits.mp (List.mem_mergeSort.mp (List.mem_of_mem_take hm))

/-- **(1) Soundness.** Every ranked row is an input row, the query has
    terms, and every term is inside one of the row's keys. -/
theorem rank_sound {rows : List Row} {q : Text} {limit : Int} {r : Row}
    (hr : r ∈ rank rows q limit) : r ∈ rows ∧ Matches (keys r) (terms q) := by
  unfold rank at hr
  rw [List.mem_map] at hr
  obtain ⟨h, hm, rfl⟩ := hr
  have ⟨hrow, ht⟩ := rankHits_tier hm
  refine ⟨hrow, (tier_isSome_iff_matches h.1 q).mp ?_⟩
  rw [ht]; rfl

theorem length_hits (rows : List Row) (ts : List Text) :
    (hits rows ts).length = (rows.filter fun r => (tier (keys r) ts).isSome).length := by
  unfold hits
  rw [List.length_filterMap_eq_countP, List.countP_eq_length_filter]
  congr 1
  apply List.filter_congr
  intro r _
  cases tier (keys r) ts <;> rfl

/-- **(2) Completeness.** When no more than `limit` rows match, every
    matching input row is ranked. -/
theorem rank_complete {rows : List Row} {q : Text} {limit : Int} {r : Row}
    (hcount : (rows.filter fun r => decide (Matches (keys r) (terms q))).length ≤ clampLimit limit)
    (hr : r ∈ rows) (hmatch : Matches (keys r) (terms q)) : r ∈ rank rows q limit := by
  have hsome := (tier_isSome_iff_matches r q).mpr hmatch
  obtain ⟨n, hn⟩ := Option.isSome_iff_exists.mp hsome
  have hcount' : (hits rows (terms q)).length ≤ clampLimit limit := by
    rw [length_hits]
    have e : (rows.filter fun r => (tier (keys r) (terms q)).isSome) =
        rows.filter fun r => decide (Matches (keys r) (terms q)) := by
      apply List.filter_congr
      intro x _
      rw [Bool.eq_iff_iff, decide_eq_true_iff]
      exact tier_isSome_iff_matches x q
    rw [e]; exact hcount
  unfold rank rankHits
  simp only
  rw [ifNeg hmatch.1, List.take_of_length_le (by rw [List.length_mergeSort]; exact hcount')]
  rw [List.mem_map]
  exact ⟨(r, n), List.mem_mergeSort.mpr (mem_hits.mpr ⟨hr, hn⟩), rfl⟩

/-- **(3a) The hits are sorted** by (tier, symbol length, symbol, market). -/
theorem rankHits_sorted (rows : List Row) (q : Text) (limit : Int) :
    (rankHits rows q limit).Pairwise (fun a b => hitLe a b = true) := by
  unfold rankHits
  simp only
  split
  · exact List.Pairwise.nil
  · exact (List.pairwise_mergeSort hitLe_trans hitLe_total _).sublist (List.take_sublist _ _)

/-- **(3b) At most `limit` rows**, and the limit is clamped to 1..20. -/
theorem rank_length_le (rows : List Row) (q : Text) (limit : Int) :
    (rank rows q limit).length ≤ clampLimit limit ∧ clampLimit limit ≤ maxResults := by
  refine ⟨?_, (clampLimit_bounds limit).2⟩
  unfold rank rankHits
  simp only
  split
  · simp
  · rw [List.length_map]; exact List.length_take_le _ _

/-- **(6a) Exact symbols first.** No hit of a higher tier precedes an
    exact-symbol hit. -/
theorem rankHits_exact_first (rows : List Row) (q : Text) (limit : Int) :
    (rankHits rows q limit).Pairwise (fun a b => b.2 = 0 → a.2 = 0) :=
  (rankHits_sorted rows q limit).imp fun h hb => by have := hitLe_tier h; omega

/-- **(6b)** When some row is an exact-symbol hit, the first result is one. -/
theorem rank_head_exact {rows : List Row} {q : Text} {limit : Int} {r : Row}
    (hr : r ∈ rows) (h0 : tier (keys r) (terms q) = some 0) :
    ∃ h, (rankHits rows q limit).head? = some h ∧ h.2 = 0 := by
  have hts : terms q ≠ [] := by
    intro he; rw [he] at h0; simp [tier] at h0
  have hmem : (r, 0) ∈ (hits rows (terms q)).mergeSort hitLe :=
    List.mem_mergeSort.mpr (mem_hits.mpr ⟨hr, h0⟩)
  have hsorted := List.pairwise_mergeSort hitLe_trans hitLe_total (hits rows (terms q))
  unfold rankHits
  simp only
  rw [ifNeg hts]
  cases hs : (hits rows (terms q)).mergeSort hitLe with
  | nil => rw [hs] at hmem; simp at hmem
  | cons x xs =>
    have hk : clampLimit limit = (clampLimit limit - 1) + 1 := by
      have := (clampLimit_bounds limit).1; omega
    rw [hk, List.take_succ_cons]
    refine ⟨x, rfl, ?_⟩
    rw [hs] at hmem hsorted
    rcases List.mem_cons.mp hmem with he | he
    · rw [← he]
    · have := hitLe_tier ((List.pairwise_cons.mp hsorted).1 _ he)
      simp at this; exact this

/-- In a list where no higher-tier hit precedes a tier-0 hit, every tier-0
    hit lies within the first `k` entries once `k` covers all tier-0 hits. -/
theorem exact_mem_take {l : List Hit} {x : Hit} {k : Nat}
    (hp : l.Pairwise (fun a b => b.2 = 0 → a.2 = 0)) (hx : x ∈ l) (h0 : x.2 = 0)
    (hk : (l.filter fun h => decide (h.2 = 0)).length ≤ k) : x ∈ l.take k := by
  induction l generalizing k with
  | nil => simp at hx
  | cons y ys ih =>
    have ⟨hy, hys⟩ := List.pairwise_cons.mp hp
    by_cases hy0 : y.2 = 0
    · rw [List.filter_cons, ifPos (by simpa using hy0), List.length_cons] at hk
      have hk' : k = (k - 1) + 1 := by omega
      rw [hk', List.take_succ_cons]
      rcases List.mem_cons.mp hx with he | he
      · rw [he]; exact List.mem_cons_self
      · exact List.mem_cons_of_mem _ (ih hys he (by omega))
    · rcases List.mem_cons.mp hx with he | he
      · rw [he] at h0; exact absurd h0 hy0
      · exact absurd (hy x he h0) hy0

/-- **(6c)** An exact-symbol row is never cut off while all exact-symbol
    rows fit the limit. -/
theorem exact_in_rank {rows : List Row} {q : Text} {limit : Int} {r : Row}
    (hcount : (rows.filter fun r => decide (tier (keys r) (terms q) = some 0)).length ≤
      clampLimit limit)
    (hr : r ∈ rows) (h0 : tier (keys r) (terms q) = some 0) : r ∈ rank rows q limit := by
  have hts : terms q ≠ [] := by
    intro he; rw [he] at h0; simp [tier] at h0
  let sorted := (hits rows (terms q)).mergeSort hitLe
  have hsorted : sorted.Pairwise (fun a b => b.2 = 0 → a.2 = 0) :=
    (List.pairwise_mergeSort hitLe_trans hitLe_total _).imp fun h hb => by
      have := hitLe_tier h; omega
  have hmem : (r, 0) ∈ sorted := List.mem_mergeSort.mpr (mem_hits.mpr ⟨hr, h0⟩)
  have hcount' : (sorted.filter fun h => decide (h.2 = 0)).length ≤ clampLimit limit := by
    rw [← List.countP_eq_length_filter, (List.mergeSort_perm _ _).countP_eq, hits,
      List.countP_filterMap, List.countP_eq_length_filter]
    refine Nat.le_trans (Nat.le_of_eq ?_) hcount
    congr 1
    apply List.filter_congr
    intro x _
    cases tier (keys x) (terms q) with
    | none => simp
    | some n => simp
  unfold rank rankHits
  simp only
  rw [ifNeg hts, List.mem_map]
  exact ⟨(r, 0), exact_mem_take hsorted hmem rfl hcount', rfl⟩

/-- Stability: two hits already in order in the input stay in that order
    after sorting (so ties keep input order, as `Array.prototype.sort` does). -/
theorem sort_stable {rows : List Row} {ts : List Text} {a b : Hit}
    (hab : hitLe a b = true) (h : List.Sublist [a, b] (hits rows ts)) :
    List.Sublist [a, b] ((hits rows ts).mergeSort hitLe) :=
  List.pair_sublist_mergeSort hitLe_trans hitLe_total hab h

end StockSearch
end Research
