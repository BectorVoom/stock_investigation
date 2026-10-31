import ResearchFormal.Basic

/-!
# Stock mentions in stored articles

Formal model of `packages/domain/src/news/stockMentions.ts` (ADR-0049 §7):
`termOccursAt`, `termOccurs`, `articleMention` and `mentionLikePattern`,
with a model of SQLite's `LIKE … ESCAPE '\'`, the prefilter the API's query
applies before `articleMention`.

**The model starts at the term characters.** How a term is built from a
stored name (`nameMentionTerm`: NFKC, whitespace runs to one space, corporate
forms removed; `stockMentionTerms`: distinct names, then a US symbol, at most
four) is outside it, as `StockSearch.lean` leaves NFKC out; those are covered
by unit tests. Article text is matched as stored, so nothing is normalized
between the SQL and the match.

**Text is a list of UTF-16 code units** (`List Nat`): the TypeScript indexes
terms and texts by code unit (`charAt`, `length`). `mentionLikePattern` walks
the term by code point (`for … of`); the model does too, through `pieces`,
which groups a high surrogate followed by a low one into one piece and leaves
every other unit alone, as `for … of` does. A piece is written to the pattern
unit by unit (`encodePiece`: only SPACE, `-`, `%`, `_` and `\` are rewritten,
so a surrogate pair is kept as it is).

**The byte budget.** D1 refuses a `LIKE` pattern over 50 UTF-8 bytes, so the
body keeps the longest prefix of whole pieces whose encoded bytes fit in 48
(`takeFit`): the first piece that does not fit ends it, so a cut never splits
an escape (`\%` is one 2-byte piece) or a surrogate pair (one 4-byte piece).
`utf8Len` counts UTF-8 bytes over code units: a surrogate pair is 4 bytes,
any other unit 1, 2 or 3 by its value — a lone surrogate 3, as the
TypeScript's `codePointAt` arithmetic and `TextEncoder` (which writes U+FFFD)
count it.

**SQLite counts code points, the model code units.** `%` and a literal agree
on well-formed UTF-16 text: a literal surrogate pair in a pattern built from a
well-formed term can only match at a code-point boundary. `_` (one character)
does not: on a character outside the Basic Multilingual Plane SQLite's `_`
takes the whole surrogate pair, the model's one unit. The pattern puts `_`
only where the term has a separator, and a separator matches only SPACE or
`-` (one code unit, one code point), so a true mention puts a one-unit
character under every `_` and the prefilter theorem holds for SQLite as for
the model. The conformance test replays the `LIKE` vectors on real SQLite
(`node:sqlite`), the astral-text × `_` combinations excluded.

**Case:** a name matches ASCII letters in either case, a symbol exactly;
SQLite's `LIKE` folds ASCII case only (its default, `case_sensitive_like`
off), so it never rejects what a case-insensitive name match accepts, and
only widens a symbol's.

Proved below:
1. `articleMention_sound` — a returned term is one of the terms and occurs,
   boundaries included, in one of the (non-null) texts;
2. `articleMention_eq_some_iff`, `articleMention_eq_none_iff`,
   `articleMention_complete` — the result is exactly the first term in term
   order that occurs in some text, and none only when no term occurs;
3. `like_of_termOccursAt`, `like_of_termOccurs`, `prefilter_of_mention` —
   an occurrence implies the text matches the term's `LIKE` pattern, cut or
   not (the kept units are a prefix of the term, `keptText_prefix`, and a
   prefix matches wherever the term does), so the SQL prefilter (any term's
   pattern on any non-null text) never drops an article `articleMention`
   keeps;
4. `mentionLikePattern_bytes`, `takeFit_maximal`, `takeFit_all` — the
   pattern is at most 50 UTF-8 bytes (`utf8Len_append_le`: joining never
   lengthens an encoding); the body is the longest prefix of whole code
   points that fits, and a term that fits is kept whole;
5. `not_occursAt_word_start`, `not_occursAt_word_end`,
   `occursAt_whole_word`, `apple_not_in_pineapple` — an occurrence of a term
   that starts (ends) with an ASCII letter or digit is never preceded
   (followed) by one: it is never inside a longer ASCII word.
-/

namespace Research
namespace StockMentions

/-- Text as UTF-16 code units. -/
abbrev Text := List Nat

def space : Nat := 32
def hyphen : Nat := 45
def percent : Nat := 37
def underscore : Nat := 95
def backslash : Nat := 92

/-- `isSeparator`: SPACE or `-`. -/
def isSep (c : Nat) : Bool := c == space || c == hyphen

/-- `isAsciiAlphanumeric`: 0-9, A-Z, a-z. -/
def isAlnum (c : Nat) : Bool :=
  decide ((48 ≤ c ∧ c ≤ 57) ∨ (65 ≤ c ∧ c ≤ 90) ∨ (97 ≤ c ∧ c ≤ 122))

/-- `asciiLowerChar`: A-Z to a-z, every other unit kept (SQLite's
    `sqlite3Tolower` on the units `LIKE` folds). -/
def lower (c : Nat) : Nat := if 65 ≤ c ∧ c ≤ 90 then c + 32 else c

inductive Kind where
  | name
  | symbol
  deriving DecidableEq, Repr

/-- `StockMentionTerm`. -/
structure Term where
  text : Text
  kind : Kind
  deriving DecidableEq, Repr

/-- A name compares ASCII letters case-insensitively, a symbol exactly. -/
def Term.caseInsensitive (t : Term) : Bool :=
  match t.kind with
  | .name => true
  | .symbol => false

/-- `charMatches`. -/
def charMatches (ci : Bool) (termChar textChar : Nat) : Bool :=
  if isSep termChar then isSep textChar
  else if ci then lower termChar == lower textChar
  else termChar == textChar

/-- Every term unit matches the text unit at the same offset (the loop of
    `termOccursAt`); false when the text is shorter. -/
def prefixMatches (ci : Bool) : Text → Text → Bool
  | [], _ => true
  | _ :: _, [] => false
  | t :: ts, x :: xs => charMatches ci t x && prefixMatches ci ts xs

/-- `termOccursAt`. `charAt` past either end is `""`, which is not
    alphanumeric; the model reads unit 0 there, which is not either. -/
def termOccursAt (text : Text) (term : Term) (pos : Nat) : Bool :=
  let n := term.text.length
  (n != 0) && decide (pos + n ≤ text.length) &&
    prefixMatches term.caseInsensitive term.text (text.drop pos) &&
    (!isAlnum (term.text.headD 0) || pos == 0 || !isAlnum (text.getD (pos - 1) 0)) &&
    (!isAlnum (term.text.getLastD 0) || pos + n == text.length || !isAlnum (text.getD (pos + n) 0))

/-- `termOccurs`: some index. The TypeScript stops at
    `text.length - term.text.length`; past it `termOccursAt` is false. -/
def termOccurs (text : Text) (term : Term) : Bool :=
  (List.range (text.length + 1)).any (termOccursAt text term)

/-- Whether some non-null text mentions the term (the inner loop). -/
def mentionedIn (texts : List (Option Text)) (term : Term) : Bool :=
  texts.any fun
    | none => false
    | some s => termOccurs s term

/-- `articleMention`: the first term, in term order, some text mentions. -/
def articleMention (texts : List (Option Text)) (terms : List Term) : Option Term :=
  terms.find? (mentionedIn texts)

/-! ## The match -/

theorem termOccurs_iff {text : Text} {term : Term} :
    termOccurs text term = true ↔ ∃ i, termOccursAt text term i = true := by
  unfold termOccurs
  rw [List.any_eq_true]
  constructor
  · rintro ⟨i, _, h⟩
    exact ⟨i, h⟩
  · rintro ⟨i, h⟩
    refine ⟨i, ?_, h⟩
    rw [List.mem_range]
    have hle : i + term.text.length ≤ text.length := by
      unfold termOccursAt at h
      simp only [Bool.and_eq_true, decide_eq_true_eq] at h
      exact h.1.1.1.2
    omega

/-- A term mentioned somewhere: one non-null text where it occurs at an index. -/
def Mentioned (texts : List (Option Text)) (term : Term) : Prop :=
  ∃ s, some s ∈ texts ∧ ∃ i, termOccursAt s term i = true

theorem mentionedIn_iff {texts : List (Option Text)} {term : Term} :
    mentionedIn texts term = true ↔ Mentioned texts term := by
  unfold mentionedIn Mentioned
  rw [List.any_eq_true]
  constructor
  · rintro ⟨x, hx, h⟩
    cases x with
    | none => exact absurd h (by simp)
    | some s => exact ⟨s, hx, termOccurs_iff.mp h⟩
  · rintro ⟨s, hs, h⟩
    exact ⟨some s, hs, termOccurs_iff.mpr h⟩

/-- **Exactly the first mentioned term.** -/
theorem articleMention_eq_some_iff {texts : List (Option Text)} {terms : List Term} {t : Term} :
    articleMention texts terms = some t ↔
      Mentioned texts t ∧ ∃ pre post, terms = pre ++ t :: post ∧ ∀ u ∈ pre, ¬Mentioned texts u := by
  unfold articleMention
  rw [List.find?_eq_some_iff_append, mentionedIn_iff]
  constructor
  · rintro ⟨hm, pre, post, he, hpre⟩
    refine ⟨hm, pre, post, he, fun u hu hmu => ?_⟩
    have := hpre u hu
    rw [mentionedIn_iff.mpr hmu] at this
    exact Bool.noConfusion this
  · rintro ⟨hm, pre, post, he, hpre⟩
    refine ⟨hm, pre, post, he, fun u hu => ?_⟩
    cases h : mentionedIn texts u with
    | false => rfl
    | true => exact absurd (mentionedIn_iff.mp h) (hpre u hu)

/-- **Soundness:** a returned term is a term and occurs, at a boundary, in a text. -/
theorem articleMention_sound {texts : List (Option Text)} {terms : List Term} {t : Term}
    (h : articleMention texts terms = some t) :
    t ∈ terms ∧ ∃ s, some s ∈ texts ∧ ∃ i, termOccursAt s t i = true := by
  obtain ⟨hm, pre, post, he, _⟩ := articleMention_eq_some_iff.mp h
  exact ⟨he ▸ List.mem_append_right pre List.mem_cons_self, hm⟩

/-- **No term mentioned** is the only way to get none. -/
theorem articleMention_eq_none_iff {texts : List (Option Text)} {terms : List Term} :
    articleMention texts terms = none ↔ ∀ t ∈ terms, ¬Mentioned texts t := by
  unfold articleMention
  rw [List.find?_eq_none]
  exact forall_congr' fun t => imp_congr_right fun _ => not_congr mentionedIn_iff

/-- **Completeness:** whenever some term occurs in some text, a term is
    returned — the first such one (`articleMention_eq_some_iff`). -/
theorem articleMention_complete {texts : List (Option Text)} {terms : List Term} {t : Term}
    (ht : t ∈ terms) (hm : Mentioned texts t) :
    ∃ u, articleMention texts terms = some u := by
  cases h : articleMention texts terms with
  | none => exact absurd hm (articleMention_eq_none_iff.mp h t ht)
  | some u => exact ⟨u, rfl⟩

/-! ## Word boundaries -/

theorem occursAt_parts {text : Text} {term : Term} {i : Nat} (h : termOccursAt text term i = true) :
    (!isAlnum (term.text.headD 0) || i == 0 || !isAlnum (text.getD (i - 1) 0)) = true ∧
    (!isAlnum (term.text.getLastD 0) || i + term.text.length == text.length ||
      !isAlnum (text.getD (i + term.text.length) 0)) = true := by
  unfold termOccursAt at h
  simp only [Bool.and_eq_true] at h
  exact ⟨h.1.2, h.2⟩

/-- A term starting with an ASCII letter or digit never occurs right after one. -/
theorem not_occursAt_word_start {text : Text} {term : Term} {i : Nat}
    (hHead : isAlnum (term.text.headD 0) = true) (hi : 0 < i)
    (hPrev : isAlnum (text.getD (i - 1) 0) = true) : termOccursAt text term i = false := by
  cases h : termOccursAt text term i with
  | false => rfl
  | true =>
    have := (occursAt_parts h).1
    have hi' : (i == 0) = false := by simp; omega
    rw [hHead, hPrev, hi'] at this
    exact absurd this (by decide)

/-- A term ending with an ASCII letter or digit is never followed by one. -/
theorem not_occursAt_word_end {text : Text} {term : Term} {i : Nat}
    (hLast : isAlnum (term.text.getLastD 0) = true) (hEnd : i + term.text.length < text.length)
    (hNext : isAlnum (text.getD (i + term.text.length) 0) = true) :
    termOccursAt text term i = false := by
  cases h : termOccursAt text term i with
  | false => rfl
  | true =>
    have := (occursAt_parts h).2
    have hEnd' : (i + term.text.length == text.length) = false := by simp; omega
    rw [hLast, hNext, hEnd'] at this
    exact absurd this (by decide)

/-- An occurrence of a term with ASCII-alphanumeric ends is a whole ASCII
    word: at the text start or after a non-alphanumeric unit, and at the text
    end or before one. -/
theorem occursAt_whole_word {text : Text} {term : Term} {i : Nat}
    (h : termOccursAt text term i = true)
    (hHead : isAlnum (term.text.headD 0) = true) (hLast : isAlnum (term.text.getLastD 0) = true) :
    (i = 0 ∨ isAlnum (text.getD (i - 1) 0) = false) ∧
    (i + term.text.length = text.length ∨ isAlnum (text.getD (i + term.text.length) 0) = false) := by
  have ⟨h1, h2⟩ := occursAt_parts h
  rw [hHead] at h1
  rw [hLast] at h2
  simp only [Bool.not_true, Bool.false_or, Bool.or_eq_true, beq_iff_eq,
    Bool.not_eq_true'] at h1 h2
  exact ⟨h1, h2⟩

/-- "Apple" as code units. -/
def apple : Text := [65, 112, 112, 108, 101]

/-- The name "Apple" does not occur in "Pineapple", nor in "Applesauce"; it
    does in "(Apple)" and, case-insensitively, in "APPLE". -/
theorem apple_not_in_pineapple :
    termOccurs [80, 105, 110, 101, 97, 112, 112, 108, 101] ⟨apple, .name⟩ = false ∧
    termOccurs (apple ++ [115, 97, 117, 99, 101]) ⟨apple, .name⟩ = false ∧
    termOccurs ([40] ++ apple ++ [41]) ⟨apple, .name⟩ = true ∧
    termOccurs [65, 80, 80, 76, 69] ⟨apple, .name⟩ = true := by
  decide

/-! ## SQLite `LIKE … ESCAPE '\'` -/

/-- One parsed pattern element. -/
inductive Pat where
  /-- `%`: any sequence, the empty one included. -/
  | any
  /-- `_`: exactly one character. -/
  | one
  /-- A literal (an escaped character or any other one), compared with ASCII case folded. -/
  | lit (c : Nat)
  deriving DecidableEq, Repr

/-- One unescaped pattern character: `%`, `_` or a literal. -/
def plain (c : Nat) : Pat :=
  if c = percent then .any else if c = underscore then .one else .lit c

/-- The pattern with `\` as the escape: `\c` is the literal `c`; a trailing
    `\` makes the pattern match nothing (SQLite answers no match). -/
def parseLike : Text → Option (List Pat)
  | [] => some []
  | [c] => if c = backslash then none else some [plain c]
  | c :: d :: rest =>
    if c = backslash then (parseLike rest).map (Pat.lit d :: ·)
    else (parseLike (d :: rest)).map (plain c :: ·)

theorem parseLike_plain {c : Nat} (hc : c ≠ backslash) (rest : Text) :
    parseLike (c :: rest) = (parseLike rest).map (plain c :: ·) := by
  cases rest with
  | nil => simp [parseLike, hc]
  | cons d rest => simp [parseLike, hc]

theorem parseLike_escape (d : Nat) (rest : Text) :
    parseLike (backslash :: d :: rest) = (parseLike rest).map (Pat.lit d :: ·) := by
  simp [parseLike]

/-- Whether the whole text matches the parsed pattern. -/
def likeMatch : List Pat → Text → Bool
  | [], s => s.isEmpty
  | .any :: ps, [] => likeMatch ps []
  | .any :: ps, x :: s => likeMatch ps (x :: s) || likeMatch (.any :: ps) s
  | .one :: _, [] => false
  | .one :: ps, _ :: s => likeMatch ps s
  | .lit _ :: _, [] => false
  | .lit c :: ps, x :: s => lower c == lower x && likeMatch ps s
termination_by ps s => ps.length + s.length

/-- `text LIKE pattern ESCAPE '\'`. -/
def likeMatches (text pattern : Text) : Bool :=
  match parseLike pattern with
  | none => false
  | some ps => likeMatch ps text

/-- One term unit in the pattern: a separator as `_`, `%` `_` `\` escaped. -/
def encodeChar (c : Nat) : Text :=
  if isSep c then [underscore]
  else if c = percent ∨ c = underscore ∨ c = backslash then [backslash, c]
  else [c]

/-! ### The byte budget

D1 refuses a `LIKE` pattern longer than 50 UTF-8 bytes, so the pattern keeps
the longest prefix of whole term characters whose pieces fit in 48 bytes
(the two `%` take the other two). -/

/-- `STOCK_MENTION_LIMITS.maxLikePatternBytes`. -/
def maxLikePatternBytes : Nat := 50

def isHigh (c : Nat) : Bool := decide (0xD800 ≤ c ∧ c ≤ 0xDBFF)
def isLow (c : Nat) : Bool := decide (0xDC00 ≤ c ∧ c ≤ 0xDFFF)

/-- UTF-8 bytes of one unit read alone: a lone surrogate counts 3, as the
    TypeScript's `codePointAt` arithmetic (and `TextEncoder`, which writes
    U+FFFD) does. -/
def unitBytes (c : Nat) : Nat := if c < 0x80 then 1 else if c < 0x800 then 2 else 3

/-- UTF-8 length of code units: a high surrogate followed by a low one is
    one 4-byte code point, every other unit is read alone. -/
def utf8Len : Text → Nat
  | [] => 0
  | [c] => unitBytes c
  | c :: d :: rest =>
    if isHigh c && isLow d then 4 + utf8Len rest else unitBytes c + utf8Len (d :: rest)

/-- The code points of a text as unit lists, as `for … of` walks a string:
    a surrogate pair is one piece, never split; every other unit is one. -/
def pieces : Text → List Text
  | [] => []
  | [c] => [[c]]
  | c :: d :: rest =>
    if isHigh c && isLow d then [c, d] :: pieces rest else [c] :: pieces (d :: rest)

/-- One code point in the pattern (`encodeChar` on each unit; a surrogate
    pair is neither a separator nor `%` `_` `\`, so it is kept). -/
def encodePiece (p : Text) : Text := p.flatMap encodeChar

/-- The loop: the next piece is kept while its bytes fit; the first one
    that does not ends the body. -/
def takeFit : Nat → List Text → List Text
  | _, [] => []
  | budget, p :: ps =>
    if utf8Len (encodePiece p) ≤ budget then p :: takeFit (budget - utf8Len (encodePiece p)) ps
    else []

/-- The term units the pattern keeps: a prefix of whole code points. -/
def keptText (t : Term) : Text := (takeFit (maxLikePatternBytes - 2) (pieces t.text)).flatten

/-- `mentionLikePattern`. -/
def mentionLikePattern (t : Term) : Text :=
  percent :: (keptText t).flatMap encodeChar ++ [percent]

theorem pieces_flatten : ∀ s : Text, (pieces s).flatten = s
  | [] => rfl
  | [_] => rfl
  | c :: d :: rest => by
    unfold pieces
    split
    · simp [pieces_flatten rest]
    · simp [pieces_flatten (d :: rest)]

theorem takeFit_prefix : ∀ (budget : Nat) (ps : List Text), takeFit budget ps <+: ps
  | _, [] => List.prefix_refl _
  | budget, p :: ps => by
    unfold takeFit
    split
    · exact List.cons_prefix_cons.mpr ⟨rfl, takeFit_prefix _ ps⟩
    · exact List.nil_prefix

/-- The kept units are a prefix of the term. -/
theorem keptText_prefix (t : Term) : keptText t <+: t.text := by
  obtain ⟨r, hr⟩ := takeFit_prefix (maxLikePatternBytes - 2) (pieces t.text)
  refine ⟨r.flatten, ?_⟩
  unfold keptText
  rw [← List.flatten_append, hr, pieces_flatten]

/-- **Longest prefix:** either every piece is kept, or the first piece left
    out does not fit in what the kept ones leave of the budget. -/
theorem takeFit_maximal : ∀ (budget : Nat) (ps : List Text),
    takeFit budget ps = ps ∨
      ∃ p post, ps = takeFit budget ps ++ p :: post ∧
        budget < ((takeFit budget ps).map fun q => utf8Len (encodePiece q)).sum + utf8Len (encodePiece p)
  | _, [] => Or.inl rfl
  | budget, p :: ps => by
    unfold takeFit
    split
    · rename_i hp
      rcases takeFit_maximal (budget - utf8Len (encodePiece p)) ps with h | ⟨q, post, he, hlt⟩
      · exact Or.inl (by rw [h])
      · refine Or.inr ⟨q, post, by rw [List.cons_append, ← he], ?_⟩
        simp only [List.map_cons, List.sum_cons]
        omega
    · rename_i hp
      exact Or.inr ⟨p, ps, rfl, by simp; omega⟩

theorem utf8Len_ccons (c d : Nat) (rest : Text) :
    utf8Len (c :: d :: rest) =
      if isHigh c && isLow d then 4 + utf8Len rest else unitBytes c + utf8Len (d :: rest) := rfl

theorem unitBytes_le_three (c : Nat) : unitBytes c ≤ 3 := by
  unfold unitBytes; split
  · omega
  · split <;> omega

theorem unitBytes_surrogate {c : Nat} (h : isLow c = true) : unitBytes c = 3 := by
  simp only [isLow, decide_eq_true_eq] at h
  unfold unitBytes
  rw [ifNeg (by omega), ifNeg (by omega)]

theorem utf8Len_cons_low {d : Nat} (rest : Text) (hd : isLow d = true) :
    utf8Len (d :: rest) = 3 + utf8Len rest := by
  have hnh : isHigh d = false := by
    simp only [isLow, decide_eq_true_eq] at hd
    simp only [isHigh, decide_eq_false_iff_not]; omega
  cases rest with
  | nil => simp [utf8Len, unitBytes_surrogate hd]
  | cons e rest => simp [utf8Len, hnh, unitBytes_surrogate hd]

/-- Joining can only pair a dangling high surrogate with a low one, which
    shortens the encoding: UTF-8 length is subadditive. -/
theorem utf8Len_append_le : ∀ (a b : Text), utf8Len (a ++ b) ≤ utf8Len a + utf8Len b
  | [], _ => by simp [utf8Len]
  | [c], [] => by simp
  | [c], d :: b => by
    show utf8Len (c :: d :: b) ≤ unitBytes c + utf8Len (d :: b)
    rw [utf8Len_ccons]
    split
    · rename_i h
      simp only [Bool.and_eq_true] at h
      rw [utf8Len_cons_low b h.2]
      simp only [isHigh, decide_eq_true_eq] at h
      have : unitBytes c = 3 := by unfold unitBytes; rw [ifNeg (by omega), ifNeg (by omega)]
      omega
    · exact Nat.le_refl _
  | c :: d :: a, b => by
    show utf8Len (c :: d :: (a ++ b)) ≤ utf8Len (c :: d :: a) + utf8Len b
    rw [utf8Len_ccons, utf8Len_ccons]
    split
    · have := utf8Len_append_le a b
      omega
    · have := utf8Len_append_le (d :: a) b
      simp only [List.cons_append] at this
      omega

theorem utf8Len_takeFit_le : ∀ (budget : Nat) (ps : List Text),
    utf8Len ((takeFit budget ps).flatMap encodePiece) ≤ budget
  | _, [] => by simp [takeFit, utf8Len]
  | budget, p :: ps => by
    unfold takeFit
    split
    · rename_i hp
      rw [List.flatMap_cons]
      have h1 := utf8Len_append_le (encodePiece p) ((takeFit (budget - utf8Len (encodePiece p)) ps).flatMap encodePiece)
      have h2 := utf8Len_takeFit_le (budget - utf8Len (encodePiece p)) ps
      omega
    · simp [utf8Len]

theorem flatten_flatMap_encode (ps : List Text) :
    ps.flatten.flatMap encodeChar = ps.flatMap encodePiece := by
  induction ps with
  | nil => rfl
  | cons p ps ih => simp [List.flatten_cons, List.flatMap_append, ih, encodePiece]

/-- **The pattern fits D1:** at most 50 UTF-8 bytes. -/
theorem mentionLikePattern_bytes (t : Term) : utf8Len (mentionLikePattern t) ≤ maxLikePatternBytes := by
  unfold mentionLikePattern keptText
  rw [flatten_flatMap_encode]
  have hbody := utf8Len_takeFit_le (maxLikePatternBytes - 2) (pieces t.text)
  have h1 := utf8Len_append_le [percent]
    ((takeFit (maxLikePatternBytes - 2) (pieces t.text)).flatMap encodePiece ++ [percent])
  have h2 := utf8Len_append_le
    ((takeFit (maxLikePatternBytes - 2) (pieces t.text)).flatMap encodePiece) [percent]
  have hp : utf8Len [percent] = 1 := by decide
  simp only [List.cons_append, List.nil_append] at h1
  rw [List.cons_append]
  have hm : maxLikePatternBytes = 50 := rfl
  omega

/-- A term whose pieces fit is kept whole. -/
theorem takeFit_all : ∀ (budget : Nat) (ps : List Text),
    ((ps.map fun q => utf8Len (encodePiece q)).sum ≤ budget) → takeFit budget ps = ps
  | _, [], _ => rfl
  | budget, p :: ps, h => by
    simp only [List.map_cons, List.sum_cons] at h
    unfold takeFit
    rw [ifPos (by omega), takeFit_all _ ps (by omega)]

/-- What a term unit parses back to. -/
def patOf (c : Nat) : Pat := if isSep c then .one else .lit c

theorem parseLike_encode (c : Nat) (rest : Text) :
    parseLike (encodeChar c ++ rest) = (parseLike rest).map (patOf c :: ·) := by
  unfold encodeChar patOf
  by_cases hs : isSep c = true
  · simp only [hs, ite_true, List.singleton_append]
    rw [parseLike_plain (by decide)]
    rfl
  · simp only [hs, Bool.false_eq_true, ite_false]
    by_cases hx : c = percent ∨ c = underscore ∨ c = backslash
    · rw [ifPos hx, List.cons_append, List.singleton_append, parseLike_escape]
    · rw [ifNeg hx, List.singleton_append]
      simp only [not_or] at hx
      rw [parseLike_plain hx.2.2]
      simp [plain, hx.1, hx.2.1]

theorem parseLike_flatMap (cs rest : Text) :
    parseLike (cs.flatMap encodeChar ++ rest) = (parseLike rest).map (cs.map patOf ++ ·) := by
  induction cs with
  | nil => simp
  | cons c cs ih =>
    rw [List.flatMap_cons, List.append_assoc, parseLike_encode, ih, Option.map_map]
    rfl

/-- The pattern parses as `%`, one element per kept term unit, `%`. -/
theorem parseLike_mentionLikePattern (t : Term) :
    parseLike (mentionLikePattern t) = some (.any :: ((keptText t).map patOf ++ [.any])) := by
  unfold mentionLikePattern
  rw [List.cons_append, parseLike_plain (by decide), parseLike_flatMap,
    parseLike_plain (by decide)]
  simp [parseLike, plain]

theorem likeMatch_any (s : Text) : likeMatch [.any] s = true := by
  induction s with
  | nil => simp [likeMatch]
  | cons x s ih => simp [likeMatch, ih]

/-- A leading `%` skips any prefix. -/
theorem likeMatch_any_skip (ps : List Pat) (pre s : Text) (h : likeMatch ps s = true) :
    likeMatch (.any :: ps) (pre ++ s) = true := by
  induction pre with
  | nil =>
    cases s with
    | nil => simpa [likeMatch] using h
    | cons x s => simp [likeMatch, h]
  | cons x pre ih => simp [likeMatch, ih]

theorem charMatches_lower {ci : Bool} {t x : Nat} (h : charMatches ci t x = true)
    (hs : isSep t = false) : lower t = lower x := by
  unfold charMatches at h
  rw [hs] at h
  cases ci with
  | true => simpa using h
  | false =>
    simp only [Bool.false_eq_true, ite_false, beq_iff_eq] at h
    rw [h]

/-- A unit-by-unit match from the text start is a `LIKE` match of the
    term's elements followed by `%`. -/
theorem likeMatch_of_prefixMatches {ci : Bool} :
    ∀ (ts s : Text), prefixMatches ci ts s = true → likeMatch (ts.map patOf ++ [.any]) s = true
  | [], s, _ => likeMatch_any s
  | _ :: _, [], h => by simp [prefixMatches] at h
  | t :: ts, x :: xs, h => by
    simp only [prefixMatches, Bool.and_eq_true] at h
    have ih := likeMatch_of_prefixMatches ts xs h.2
    rw [List.map_cons, List.cons_append]
    by_cases hs : isSep t = true
    · have hp : patOf t = .one := by simp [patOf, hs]
      rw [hp]
      simpa [likeMatch] using ih
    · have hp : patOf t = .lit t := by simp [patOf, hs]
      have hl := charMatches_lower h.1 (by simpa using hs)
      rw [hp]
      simp [likeMatch, hl, ih]

/-- A prefix of the term matches wherever the term does. -/
theorem prefixMatches_of_prefix {ci : Bool} :
    ∀ {ts us : Text} (s : Text), us <+: ts → prefixMatches ci ts s = true → prefixMatches ci us s = true
  | _, [], _, _, _ => rfl
  | [], _ :: _, _, hp, _ => absurd hp (by simp)
  | _ :: _, _ :: _, [], _, h => by simp [prefixMatches] at h
  | t :: ts, u :: us, x :: xs, hp, h => by
    obtain ⟨hu, hp'⟩ := List.cons_prefix_cons.mp hp
    simp only [prefixMatches, Bool.and_eq_true] at h ⊢
    exact ⟨hu ▸ h.1, prefixMatches_of_prefix xs hp' h.2⟩

/-- **Prefilter safety at one index:** an occurrence implies the `LIKE` match
    of the (possibly cut) pattern. -/
theorem like_of_termOccursAt {text : Text} {term : Term} {i : Nat}
    (h : termOccursAt text term i = true) : likeMatches text (mentionLikePattern term) = true := by
  have hp : prefixMatches term.caseInsensitive (keptText term) (text.drop i) = true := by
    unfold termOccursAt at h
    simp only [Bool.and_eq_true] at h
    exact prefixMatches_of_prefix _ (keptText_prefix term) h.1.1.2
  unfold likeMatches
  rw [parseLike_mentionLikePattern]
  rw [← List.take_append_drop i text]
  exact likeMatch_any_skip _ _ _ (likeMatch_of_prefixMatches _ _ hp)

theorem like_of_termOccurs {text : Text} {term : Term} (h : termOccurs text term = true) :
    likeMatches text (mentionLikePattern term) = true := by
  obtain ⟨i, hi⟩ := termOccurs_iff.mp h
  exact like_of_termOccursAt hi

/-- The SQL prefilter: some term's pattern matches some non-null text
    (`NULL LIKE p` is NULL, which no `WHERE` keeps). -/
def prefilter (texts : List (Option Text)) (terms : List Term) : Bool :=
  terms.any fun t => texts.any fun
    | none => false
    | some s => likeMatches s (mentionLikePattern t)

/-- **The SQL never drops a true mention:** every article `articleMention`
    keeps passes the prefilter. -/
theorem prefilter_of_mention {texts : List (Option Text)} {terms : List Term} {t : Term}
    (h : articleMention texts terms = some t) : prefilter texts terms = true := by
  obtain ⟨ht, s, hs, i, hi⟩ := articleMention_sound h
  unfold prefilter
  rw [List.any_eq_true]
  refine ⟨t, ht, ?_⟩
  rw [List.any_eq_true]
  exact ⟨some s, hs, like_of_termOccursAt hi⟩

end StockMentions
end Research
