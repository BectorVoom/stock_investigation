import ResearchFormal.MonthGrid

/-!
# Annual financial statements (ADR-0045 §4–§6, §10)

Formal model of `packages/domain/src/finance/financialStatements.ts`:
`selectMetricValue` (the authoritative value of one metric in one fiscal
year), `edinetScanPlan` (which EDINET dates a sync still scans),
`isAnnualDuration`, `fiscalYearOfPeriodEnd` and `subtractDecimals`.

Abstractions (each tied to the code by the conformance vectors):

- Dates are day numbers (`Nat`); the code compares ISO dates as text, which
  is the order of the day numbers. Filing ids are `Nat`s in the order of the
  code's text comparison.
- A decimal value is an `Int`: the selection only compares values for
  equality, negates them and tests their sign, and canonical decimal text is
  equal exactly when the numbers are equal. `subtractDecimals` is modelled
  separately over (coefficient, scale) pairs.
- One metric is a `Metric`: its rows of `EQUITY_CONCEPT_MAPPINGS` (in table
  order) and `standardHasMappings`. Concepts and units are strings, as in the
  code.

## The selection (`select`)

- `select_value_spec` (§5 (a)) — a value comes from one in-scope mapped fact
  of a latest filing (no in-scope mapped fact has a later (filing date, id)),
  with the best rank of that filing, with the mapping's sign applied, in a
  currency unit, non-negative where the metric demands it, and consolidated
  whenever any consolidated mapped fact exists; `select_value_filedOn` — with
  coherent filings it is a fact of the latest filing itself.
- `select_congr` (§5 (b)) — the result depends only on the *set* of facts:
  any two lists with the same members select the same result (every field,
  `reportedValueCount` included) for coherent filings and a coherent table;
  `select_perm` (reordering) and `select_resync` (appending facts already
  stored: a re-sync with the same facts is a no-op) follow.
- `select_older_irrelevant` (§5 (c)) — appending facts of the selected scope
  whose filing is strictly older than the latest one changes nothing but the
  number of different reported values (`reportedValueCount`, the revision
  history); `select_older_irrelevant_coherent` derives the "different filing"
  side condition from coherence.
- `select_ambiguous_iff` (§5 (d)) — the result is `ambiguous` exactly when
  the latest filing's best-ranked mapped facts disagree on value, unit or
  period.

The two coherence preconditions are what the data guarantee: every fact of
one filing carries that filing's date and accounting standard
(`FilingsCoherent`), and within one standard and scope no two mapping rows
share a rank (`TableCoherent`; `conceptTables_coherent` checks the vector
tables, the TypeScript test checks the real table).

## The EDINET scan plan (`plan`)

- `plan_day_spec` — every planned day is a weekday, strictly before today
  and not yet scanned (`plan_never_today`); `plan_length_le` — at most
  `maxDays` days;
- `plan_discovery_iff` — discovery runs exactly while no annual report is
  known; `plan_discovery_within` — it stays within the last `discoveryDays`
  days; `plan_backfill_within` — a backfill day lies 30–100 days after a
  missing fiscal year end; `plan_forward_after` — a forward day follows the
  newest report's filing;
- `plan_active_nonempty`, `plan_empty_terminal` — a phase that scans plans at
  least one day, and an empty plan is `idle` or `not-found`;
- `plan_days_candidates`, `remaining_step_lt`, `plan_eventually_terminal` —
  planned days come from a finite candidate list that does not depend on the
  scanned set, so marking them scanned strictly shrinks the unscanned
  candidates, and repeating the plan (reports unchanged) reaches `idle` or
  `not-found`.

## Periods, fiscal years and decimals

- `annual_iff`, `annual_examples` — the annual-duration bounds;
- `fiscalYear_spec` — the fiscal year is the end's year, or the year before
  for an end in 1–7 January;
- `subtract_exact` — `subtractDecimals` is exact (result + right = left) and
  `subtract_canonical` — its result has no trailing fractional zero.
-/

namespace Research.FinancialStatements

/-! ## Facts and mappings -/

inductive Standard where
  | usGaap
  | jgaap
  | ifrs
  deriving DecidableEq, Repr

inductive Scope where
  | consolidated
  | separate
  deriving DecidableEq, Repr

/-- `EquityReportedFact`: dates as day numbers, the decimal value as an integer. -/
structure Fact where
  filingId : Nat
  filedOn : Nat
  standard : Standard
  concept : String
  scope : Scope
  unit : String
  value : Int
  periodStart : Option Nat
  periodEnd : Nat
  deriving DecidableEq, Repr

/-- One row of `EQUITY_CONCEPT_MAPPINGS` for the metric (`scope = none` is `"any"`). -/
structure Mapping where
  standard : Standard
  concept : String
  rank : Nat
  negate : Bool
  scope : Option Scope
  deriving DecidableEq, Repr

/-- One metric: its definition flags, its mapping rows in table order and `standardHasMappings`. -/
structure Metric where
  derived : Bool
  nonNegative : Bool
  mappings : List Mapping
  hasMappings : Standard → Bool

abbrev Cand := Fact × Mapping

def fits (m : Mapping) (s : Scope) : Bool :=
  match m.scope with
  | none => true
  | some t => t == s

/-- The candidates one fact contributes (the code's inner loop). -/
def candidatesOf (M : Metric) (f : Fact) : List Cand :=
  if M.hasMappings f.standard then
    (M.mappings.filter fun m => m.standard == f.standard && m.concept == f.concept && fits m f.scope).map
      fun m => (f, m)
  else []

def mapped (M : Metric) (facts : List Fact) : List Cand := facts.flatMap (candidatesOf M)

def chosenScope (cs : List Cand) : Scope :=
  if cs.any (fun c => c.1.scope == .consolidated) then .consolidated else .separate

def inScope (cs : List Cand) : List Cand := cs.filter fun c => c.1.scope == chosenScope cs

/-- A filing's place in time: (filing date, filing id). -/
def key (f : Fact) : Nat × Nat := (f.filedOn, f.filingId)

/-- `laterFiling` on keys. -/
def keyLt (a b : Nat × Nat) : Prop := a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 < b.2)

instance (a b : Nat × Nat) : Decidable (keyLt a b) := by unfold keyLt; infer_instance

/-- The code's scan for the latest filing (a later key replaces the current one). -/
def latestKey (cs : List Cand) : Option (Nat × Nat) :=
  cs.foldl (fun acc c => match acc with
    | none => some (key c.1)
    | some k => if keyLt k (key c.1) then some (key c.1) else some k) none

def group (cs : List Cand) (id : Nat) : List Cand := cs.filter fun c => c.1.filingId == id

def minRank (g : List Cand) : Option Nat :=
  g.foldl (fun acc c => match acc with
    | none => some c.2.rank
    | some r => some (min r c.2.rank)) none

/-- The code's `best` list: the candidates of the smallest rank, in input order. -/
def best (g : List Cand) : List Cand :=
  match minRank g with
  | none => []
  | some r => g.filter fun c => c.2.rank == r

/-- The fields two best-ranked facts must share (`bestOfFiling`'s comparison). -/
def sig (c : Cand) : String × Int × Nat × Option Nat :=
  (c.1.unit, c.1.value, c.1.periodEnd, c.1.periodStart)

inductive Best where
  | none
  | ambiguous
  | one (c : Cand)
  deriving DecidableEq, Repr

/-- `bestOfFiling`. -/
def bestOf (g : List Cand) : Best :=
  match best g with
  | [] => .none
  | c :: rest => if (c :: rest).all (fun d => sig d == sig c) then .one c else .ambiguous

def normalized (c : Cand) : Int := if c.2.negate then -c.1.value else c.1.value

/-- `CURRENCY_UNIT`: three ASCII capitals. -/
def isCurrency (u : String) : Bool :=
  u.length == 3 && u.toList.all fun ch => 'A' ≤ ch && ch ≤ 'Z'

/-- The normalized best value of every filing that has one in `unit` (with repeats). -/
def reportedValues (s : List Cand) (unit : String) : List Int :=
  s.filterMap fun c => match bestOf (group s c.1.filingId) with
    | .one b => if b.1.unit == unit then some (normalized b) else none
    | _ => none

def dedup : List Int → List Int
  | [] => []
  | x :: xs => if x ∈ xs then dedup xs else x :: dedup xs

inductive Reason where
  | notReported
  | noMappingForStandard
  | ambiguous
  | unexpectedSign
  | unsupportedUnit
  | notDerivable
  deriving DecidableEq, Repr

structure Value where
  value : Int
  currency : String
  filingId : Nat
  filedOn : Nat
  concept : String
  scope : Scope
  standard : Standard
  periodStart : Option Nat
  periodEnd : Nat
  reportedValueCount : Nat
  deriving DecidableEq, Repr

inductive Selection where
  | value (v : Value)
  | unavailable (r : Reason)
  deriving DecidableEq, Repr

/-- The value a chosen candidate yields, with the count of reported values. -/
def valueOf (c : Cand) (count : Nat) : Value :=
  { value := normalized c, currency := c.1.unit, filingId := c.1.filingId,
    filedOn := c.1.filedOn, concept := c.1.concept, scope := c.1.scope,
    standard := c.1.standard, periodStart := c.1.periodStart, periodEnd := c.1.periodEnd,
    reportedValueCount := count }

/-- The checks after the latest filing's best fact is known. -/
def finish (M : Metric) (s : List Cand) : Best → Selection
  | .none => .unavailable .notReported
  | .ambiguous => .unavailable .ambiguous
  | .one c =>
    if isCurrency c.1.unit = false then .unavailable .unsupportedUnit
    else if M.nonNegative = true ∧ normalized c < 0 then .unavailable .unexpectedSign
    else .value (valueOf c (dedup (reportedValues s c.1.unit)).length)

/-- `selectMetricValue`. -/
def select (M : Metric) (facts : List Fact) : Selection :=
  if M.derived then .unavailable .notDerivable
  else
    let cs := mapped M facts
    if cs = [] then
      .unavailable (if facts.any (fun f => !M.hasMappings f.standard) then .noMappingForStandard
        else .notReported)
    else
      let s := inScope cs
      match latestKey s with
      | none => .unavailable .notReported
      | some k => finish M s (bestOf (group s k.2))

/-- Every fact of one filing carries that filing's date and accounting standard. -/
def FilingsCoherent (facts : List Fact) : Prop :=
  ∀ f ∈ facts, ∀ g ∈ facts, f.filingId = g.filingId → f.filedOn = g.filedOn ∧ f.standard = g.standard

/-- Within one standard and one scope, a rank names one mapping row. -/
def TableCoherent (M : Metric) : Prop :=
  ∀ m₁ ∈ M.mappings, ∀ m₂ ∈ M.mappings, m₁.standard = m₂.standard → m₁.rank = m₂.rank →
    ∀ s, fits m₁ s = true → fits m₂ s = true → m₁ = m₂

/-! ## Membership lemmas -/

theorem mem_candidatesOf (M : Metric) (f : Fact) (c : Cand) :
    c ∈ candidatesOf M f ↔ c.1 = f ∧ M.hasMappings f.standard = true ∧ c.2 ∈ M.mappings ∧
      c.2.standard = f.standard ∧ c.2.concept = f.concept ∧ fits c.2 f.scope = true := by
  unfold candidatesOf
  split
  · rename_i h
    simp only [List.mem_map, List.mem_filter, Bool.and_eq_true, beq_iff_eq]
    constructor
    · rintro ⟨m, ⟨hm, ⟨hs, hc⟩, hf⟩, rfl⟩
      exact ⟨rfl, h, hm, hs, hc, hf⟩
    · rintro ⟨h1, -, hm, hs, hc, hf⟩
      exact ⟨c.2, ⟨hm, ⟨hs, hc⟩, hf⟩, by rw [← h1]⟩
  · rename_i h
    simp only [List.not_mem_nil, false_iff]
    rintro ⟨-, h', -⟩
    exact h (by simpa using h')

theorem mem_mapped (M : Metric) (facts : List Fact) (c : Cand) :
    c ∈ mapped M facts ↔ c.1 ∈ facts ∧ c ∈ candidatesOf M c.1 := by
  unfold mapped
  rw [List.mem_flatMap]
  constructor
  · rintro ⟨f, hf, hc⟩
    have := ((mem_candidatesOf M f c).mp hc).1
    subst this
    exact ⟨hf, hc⟩
  · rintro ⟨hf, hc⟩
    exact ⟨c.1, hf, hc⟩

/-- Lists with the same members. -/
def SameMembers {α : Type} (a b : List α) : Prop := ∀ x, x ∈ a ↔ x ∈ b

theorem SameMembers.symm {α : Type} {a b : List α} (h : SameMembers a b) : SameMembers b a :=
  fun x => (h x).symm

theorem mapped_same (M : Metric) {l₁ l₂ : List Fact} (h : SameMembers l₁ l₂) :
    SameMembers (mapped M l₁) (mapped M l₂) := by
  intro c
  rw [mem_mapped, mem_mapped, h c.1]

theorem chosenScope_same {a b : List Cand} (h : SameMembers a b) : chosenScope a = chosenScope b := by
  unfold chosenScope
  have : a.any (fun c => c.1.scope == .consolidated) = b.any (fun c => c.1.scope == .consolidated) := by
    apply Bool.eq_iff_iff.mpr
    simp only [List.any_eq_true]
    constructor
    · rintro ⟨x, hx, e⟩; exact ⟨x, (h x).mp hx, e⟩
    · rintro ⟨x, hx, e⟩; exact ⟨x, (h x).mpr hx, e⟩
  rw [this]

theorem mem_inScope (cs : List Cand) (c : Cand) :
    c ∈ inScope cs ↔ c ∈ cs ∧ c.1.scope = chosenScope cs := by
  unfold inScope
  simp

theorem inScope_same {a b : List Cand} (h : SameMembers a b) : SameMembers (inScope a) (inScope b) := by
  intro c
  rw [mem_inScope, mem_inScope, h c, chosenScope_same h]

theorem mem_group (cs : List Cand) (id : Nat) (c : Cand) :
    c ∈ group cs id ↔ c ∈ cs ∧ c.1.filingId = id := by
  unfold group
  simp

theorem group_same {a b : List Cand} (id : Nat) (h : SameMembers a b) :
    SameMembers (group a id) (group b id) := by
  intro c
  rw [mem_group, mem_group, h c]

/-! ## The latest filing -/

def keyLe (a b : Nat × Nat) : Prop := a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 ≤ b.2)

/-- What the scan computes from a starting key: a key of the start or of the list, at least all of them. -/
theorem latestKey_fold_spec (cs : List Cand) (start : Option (Nat × Nat)) (k : Nat × Nat)
    (h : cs.foldl (fun acc c => match acc with
      | none => some (key c.1)
      | some k => if keyLt k (key c.1) then some (key c.1) else some k) start = some k) :
    (start = some k ∨ ∃ c ∈ cs, key c.1 = k) ∧
      (∀ s, start = some s → keyLe s k) ∧ ∀ c ∈ cs, keyLe (key c.1) k := by
  induction cs generalizing start with
  | nil =>
    simp only [List.foldl_nil] at h
    subst h
    refine ⟨Or.inl rfl, ?_, by simp⟩
    intro s hs
    simp only [Option.some.injEq] at hs
    subst hs
    unfold keyLe; omega
  | cons c rest ih =>
    simp only [List.foldl_cons] at h
    obtain ⟨hmem, hstart, hall⟩ := ih _ h
    cases start with
    | none =>
      simp only at hmem hstart
      refine ⟨?_, by simp, ?_⟩
      · rcases hmem with hm | ⟨d, hd, e⟩
        · simp only [Option.some.injEq] at hm
          exact Or.inr ⟨c, List.mem_cons_self, hm⟩
        · exact Or.inr ⟨d, List.mem_cons_of_mem c hd, e⟩
      · intro d hd
        rcases List.mem_cons.mp hd with rfl | hd
        · exact hstart _ rfl
        · exact hall d hd
    | some s =>
      simp only at hmem hstart
      by_cases hlt : keyLt s (key c.1)
      · simp only [hlt, ↓reduceIte] at hmem hstart
        have hck := hstart _ rfl
        refine ⟨?_, ?_, ?_⟩
        · rcases hmem with hm | ⟨d, hd, e⟩
          · simp only [Option.some.injEq] at hm
            exact Or.inr ⟨c, List.mem_cons_self, hm⟩
          · exact Or.inr ⟨d, List.mem_cons_of_mem c hd, e⟩
        · intro t ht
          simp only [Option.some.injEq] at ht
          subst ht
          unfold keyLt at hlt; unfold keyLe at hck ⊢; omega
        · intro d hd
          rcases List.mem_cons.mp hd with rfl | hd
          · exact hck
          · exact hall d hd
      · simp only [hlt, ↓reduceIte] at hmem hstart
        have hsk := hstart _ rfl
        refine ⟨?_, ?_, ?_⟩
        · rcases hmem with hm | ⟨d, hd, e⟩
          · exact Or.inl hm
          · exact Or.inr ⟨d, List.mem_cons_of_mem c hd, e⟩
        · intro t ht
          simp only [Option.some.injEq] at ht
          subst ht
          exact hsk
        · intro d hd
          rcases List.mem_cons.mp hd with rfl | hd
          · unfold keyLt at hlt; unfold keyLe at hsk ⊢; omega
          · exact hall d hd

theorem latestKey_fold_some (cs : List Cand) (s : Nat × Nat) :
    ∃ k, cs.foldl (fun acc c => match acc with
      | none => some (key c.1)
      | some k => if keyLt k (key c.1) then some (key c.1) else some k) (some s) = some k := by
  induction cs generalizing s with
  | nil => exact ⟨s, rfl⟩
  | cons c rest ih =>
    simp only [List.foldl_cons]
    split
    · exact ih _
    · exact ih _

theorem latestKey_spec (cs : List Cand) (k : Nat × Nat) (h : latestKey cs = some k) :
    (∃ c ∈ cs, key c.1 = k) ∧ ∀ c ∈ cs, keyLe (key c.1) k := by
  obtain ⟨hmem, -, hall⟩ := latestKey_fold_spec cs none k h
  refine ⟨?_, hall⟩
  rcases hmem with hm | hm
  · simp at hm
  · exact hm

theorem latestKey_isSome (cs : List Cand) (h : cs ≠ []) : ∃ k, latestKey cs = some k := by
  cases cs with
  | nil => exact absurd rfl h
  | cons c rest =>
    unfold latestKey
    simp only [List.foldl_cons]
    exact latestKey_fold_some rest _

theorem latestKey_nil : latestKey [] = none := rfl

theorem latestKey_eq_none (cs : List Cand) : latestKey cs = none ↔ cs = [] := by
  constructor
  · intro h
    cases cs with
    | nil => rfl
    | cons c t =>
      obtain ⟨k, hk⟩ := latestKey_isSome (c :: t) (by simp)
      rw [hk] at h
      contradiction
  · rintro rfl; rfl

theorem keyLe_antisymm (a b : Nat × Nat) (h₁ : keyLe a b) (h₂ : keyLe b a) : a = b := by
  unfold keyLe at h₁ h₂
  obtain ⟨a1, a2⟩ := a
  obtain ⟨b1, b2⟩ := b
  simp only at h₁ h₂
  have e1 : a1 = b1 := by omega
  have e2 : a2 = b2 := by omega
  rw [e1, e2]

theorem latestKey_same {a b : List Cand} (h : SameMembers a b) : latestKey a = latestKey b := by
  cases ha : latestKey a with
  | none =>
    have : a = [] := (latestKey_eq_none a).mp ha
    subst this
    have : b = [] := by
      cases b with
      | nil => rfl
      | cons x t => exact absurd ((h x).mpr List.mem_cons_self) (by simp)
    rw [this]; rfl
  | some k =>
    have hne : b ≠ [] := by
      intro hb
      subst hb
      obtain ⟨⟨c, hc, -⟩, -⟩ := latestKey_spec a k ha
      exact absurd ((h c).mp hc) (by simp)
    obtain ⟨k', hk'⟩ := latestKey_isSome b hne
    rw [hk']
    obtain ⟨⟨c, hc, rfl⟩, hall⟩ := latestKey_spec a _ ha
    obtain ⟨⟨c', hc', rfl⟩, hall'⟩ := latestKey_spec b _ hk'
    exact congrArg some (keyLe_antisymm _ _ (hall' c ((h c).mp hc)) (hall c' ((h c').mpr hc')))

/-! ## The best fact of a filing -/

theorem minRank_fold_spec (g : List Cand) (start : Option Nat) (r : Nat)
    (h : g.foldl (fun acc c => match acc with
      | none => some c.2.rank
      | some r => some (min r c.2.rank)) start = some r) :
    (start = some r ∨ ∃ c ∈ g, c.2.rank = r) ∧ (∀ s, start = some s → r ≤ s) ∧
      ∀ c ∈ g, r ≤ c.2.rank := by
  induction g generalizing start with
  | nil =>
    simp only [List.foldl_nil] at h
    subst h
    refine ⟨Or.inl rfl, ?_, by simp⟩
    intro s hs
    simp only [Option.some.injEq] at hs
    omega
  | cons c rest ih =>
    simp only [List.foldl_cons] at h
    obtain ⟨hmem, hstart, hall⟩ := ih _ h
    cases start with
    | none =>
      simp only at hmem hstart
      refine ⟨?_, by simp, ?_⟩
      · rcases hmem with hm | ⟨d, hd, e⟩
        · simp only [Option.some.injEq] at hm
          exact Or.inr ⟨c, List.mem_cons_self, hm⟩
        · exact Or.inr ⟨d, List.mem_cons_of_mem c hd, e⟩
      · intro d hd
        rcases List.mem_cons.mp hd with rfl | hd
        · exact hstart _ rfl
        · exact hall d hd
    | some s =>
      simp only at hmem hstart
      have hm := hstart _ rfl
      refine ⟨?_, ?_, ?_⟩
      · rcases hmem with hm' | ⟨d, hd, e⟩
        · simp only [Option.some.injEq] at hm'
          by_cases hsc : s ≤ c.2.rank
          · left; rw [← hm']; simp [Nat.min_eq_left hsc]
          · right; exact ⟨c, List.mem_cons_self, by rw [← hm']; omega⟩
        · exact Or.inr ⟨d, List.mem_cons_of_mem c hd, e⟩
      · intro t ht
        simp only [Option.some.injEq] at ht
        subst ht
        omega
      · intro d hd
        rcases List.mem_cons.mp hd with rfl | hd
        · omega
        · exact hall d hd

theorem minRank_fold_some (g : List Cand) (s : Nat) :
    ∃ r, g.foldl (fun acc c => match acc with
      | none => some c.2.rank
      | some r => some (min r c.2.rank)) (some s) = some r := by
  induction g generalizing s with
  | nil => exact ⟨s, rfl⟩
  | cons c rest ih =>
    simp only [List.foldl_cons]
    exact ih _

theorem minRank_spec (g : List Cand) (r : Nat) (h : minRank g = some r) :
    (∃ c ∈ g, c.2.rank = r) ∧ ∀ c ∈ g, r ≤ c.2.rank := by
  obtain ⟨hmem, -, hall⟩ := minRank_fold_spec g none r h
  refine ⟨?_, hall⟩
  rcases hmem with hm | hm
  · simp at hm
  · exact hm

theorem minRank_isSome (g : List Cand) (h : g ≠ []) : ∃ r, minRank g = some r := by
  cases g with
  | nil => exact absurd rfl h
  | cons c rest =>
    unfold minRank
    simp only [List.foldl_cons]
    exact minRank_fold_some rest _

theorem minRank_same {a b : List Cand} (h : SameMembers a b) : minRank a = minRank b := by
  by_cases hna : a = []
  · subst hna
    have : b = [] := by
      cases b with
      | nil => rfl
      | cons x t => exact absurd ((h x).mpr List.mem_cons_self) (by simp)
    rw [this]
  · have hnb : b ≠ [] := by
      intro hb
      subst hb
      cases a with
      | nil => exact hna rfl
      | cons x t => exact absurd ((h x).mp List.mem_cons_self) (by simp)
    obtain ⟨r, hr⟩ := minRank_isSome a hna
    obtain ⟨r', hr'⟩ := minRank_isSome b hnb
    rw [hr, hr']
    obtain ⟨⟨c, hc, rfl⟩, hall⟩ := minRank_spec a _ hr
    obtain ⟨⟨c', hc', rfl⟩, hall'⟩ := minRank_spec b _ hr'
    have := hall c' ((h c').mpr hc')
    have := hall' c ((h c).mp hc)
    exact congrArg some (by omega)

theorem mem_best (g : List Cand) (c : Cand) :
    c ∈ best g ↔ c ∈ g ∧ ∀ d ∈ g, c.2.rank ≤ d.2.rank := by
  unfold best
  cases hr : minRank g with
  | none =>
    have : g = [] := by
      cases g with
      | nil => rfl
      | cons x t =>
        obtain ⟨r, h⟩ := minRank_isSome (x :: t) (by simp)
        rw [hr] at h; contradiction
    subst this
    simp
  | some r =>
    obtain ⟨⟨m, hm, hmr⟩, hall⟩ := minRank_spec g r hr
    simp only [List.mem_filter, beq_iff_eq]
    constructor
    · rintro ⟨hc, rfl⟩
      exact ⟨hc, hall⟩
    · rintro ⟨hc, hle⟩
      have := hle m hm
      have := hall c hc
      exact ⟨hc, by omega⟩

theorem best_same {a b : List Cand} (h : SameMembers a b) : SameMembers (best a) (best b) := by
  intro c
  rw [mem_best, mem_best]
  constructor
  · rintro ⟨hc, hle⟩
    exact ⟨(h c).mp hc, fun d hd => hle d ((h d).mpr hd)⟩
  · rintro ⟨hc, hle⟩
    exact ⟨(h c).mpr hc, fun d hd => hle d ((h d).mp hd)⟩

theorem best_eq_nil (g : List Cand) : best g = [] ↔ g = [] := by
  constructor
  · intro h
    cases g with
    | nil => rfl
    | cons x t =>
    obtain ⟨r, hr⟩ := minRank_isSome (x :: t) (by simp)
    obtain ⟨⟨c, hc, rfl⟩, hall⟩ := minRank_spec (x :: t) _ hr
    have : c ∈ best (x :: t) := (mem_best (x :: t) c).mpr ⟨hc, hall⟩
    rw [h] at this
    simp at this
  · rintro rfl; rfl

/-- `bestOf` says `ambiguous` exactly when two best-ranked candidates disagree. -/
theorem bestOf_ambiguous_iff (g : List Cand) :
    bestOf g = .ambiguous ↔ ∃ a ∈ best g, ∃ b ∈ best g, sig a ≠ sig b := by
  unfold bestOf
  split
  · rename_i h
    rw [h]; simp
  · rename_i c rest h
    rw [h]
    split
    · rename_i hall
      simp only [reduceCtorEq, false_iff, not_exists, not_and, Decidable.not_not]
      rw [List.all_eq_true] at hall
      intro a ha b hb
      have e1 := hall a ha
      have e2 := hall b hb
      simp only [beq_iff_eq] at e1 e2
      rw [e1, e2]
    · rename_i hall
      simp only [true_iff]
      rw [List.all_eq_true] at hall
      simp only [beq_iff_eq, Classical.not_forall] at hall
      obtain ⟨d, hd, hne⟩ := hall
      exact ⟨d, hd, c, List.mem_cons_self, hne⟩

theorem bestOf_one (g : List Cand) (c : Cand) (h : bestOf g = .one c) :
    c ∈ best g ∧ ∀ d ∈ best g, sig d = sig c := by
  unfold bestOf at h
  split at h
  · simp at h
  · rename_i c' rest hb
    split at h
    · rename_i hall
      simp only [Best.one.injEq] at h
      subst h
      rw [hb]
      refine ⟨List.mem_cons_self, ?_⟩
      intro d hd
      have := (List.all_eq_true.mp hall) d hd
      simpa using this
    · simp at h

theorem bestOf_none_iff (g : List Cand) : bestOf g = .none ↔ g = [] := by
  rw [← best_eq_nil]
  unfold bestOf
  split
  · rename_i h; simp [h]
  · rename_i c rest h
    rw [h]
    split <;> simp

/-- Candidates of one group that tie on rank and on the compared fields are the same candidate. -/
def GroupCoherent (g : List Cand) : Prop :=
  ∀ a ∈ g, ∀ b ∈ g, a.2.rank = b.2.rank → sig a = sig b → a = b

theorem bestOf_same {a b : List Cand} (h : SameMembers a b) (hc : GroupCoherent a) :
    bestOf a = bestOf b := by
  have hbest := best_same h
  cases hA : bestOf a with
  | none =>
    have : a = [] := (bestOf_none_iff a).mp hA
    subst this
    have : b = [] := by
      cases b with
      | nil => rfl
      | cons x t => exact absurd ((h x).mpr List.mem_cons_self) (by simp)
    rw [this]; rfl
  | ambiguous =>
    obtain ⟨x, hx, y, hy, hne⟩ := (bestOf_ambiguous_iff a).mp hA
    exact ((bestOf_ambiguous_iff b).mpr ⟨x, (hbest x).mp hx, y, (hbest y).mp hy, hne⟩).symm
  | one c =>
    obtain ⟨hcA, hallA⟩ := bestOf_one a c hA
    cases hB : bestOf b with
    | none =>
      have : b = [] := (bestOf_none_iff b).mp hB
      subst this
      exact absurd ((h c).mp ((mem_best a c).mp hcA).1) (by simp)
    | ambiguous =>
      obtain ⟨x, hx, y, hy, hne⟩ := (bestOf_ambiguous_iff b).mp hB
      have := hallA x ((hbest x).mpr hx)
      have := hallA y ((hbest y).mpr hy)
      exact absurd (by simp_all) hne
    | one d =>
      obtain ⟨hdB, -⟩ := bestOf_one b d hB
      have hdA := (hbest d).mpr hdB
      have hsig := hallA d hdA
      have hrank : d.2.rank = c.2.rank := by
        have h1 := ((mem_best a d).mp hdA).2 c ((mem_best a c).mp hcA).1
        have h2 := ((mem_best a c).mp hcA).2 d ((mem_best a d).mp hdA).1
        omega
      have := hc d ((mem_best a d).mp hdA).1 c ((mem_best a c).mp hcA).1 hrank hsig
      rw [this]

/-! ## Coherence -/

theorem FilingsCoherent.same {l₁ l₂ : List Fact} (h : SameMembers l₁ l₂) (hc : FilingsCoherent l₁) :
    FilingsCoherent l₂ :=
  fun f hf g hg e => hc f ((h f).mpr hf) g ((h g).mpr hg) e

/-- The groups of the in-scope candidates of coherent facts are coherent. -/
theorem groupCoherent (M : Metric) (facts : List Fact) (hf : FilingsCoherent facts)
    (ht : TableCoherent M) (id : Nat) : GroupCoherent (group (inScope (mapped M facts)) id) := by
  intro a ha b hb hrank hsig
  obtain ⟨haS, haId⟩ := (mem_group _ _ a).mp ha
  obtain ⟨hbS, hbId⟩ := (mem_group _ _ b).mp hb
  obtain ⟨haM, haScope⟩ := (mem_inScope _ a).mp haS
  obtain ⟨hbM, hbScope⟩ := (mem_inScope _ b).mp hbS
  obtain ⟨haF, haC⟩ := (mem_mapped M facts a).mp haM
  obtain ⟨hbF, hbC⟩ := (mem_mapped M facts b).mp hbM
  obtain ⟨-, -, haMap, haStd, haCon, haFit⟩ := (mem_candidatesOf M a.1 a).mp haC
  obtain ⟨-, -, hbMap, hbStd, hbCon, hbFit⟩ := (mem_candidatesOf M b.1 b).mp hbC
  obtain ⟨hdate, hstd⟩ := hf a.1 haF b.1 hbF (by rw [haId, hbId])
  have hscope : a.1.scope = b.1.scope := by rw [haScope, hbScope]
  have hm : a.2 = b.2 :=
    ht a.2 haMap b.2 hbMap (by rw [haStd, hbStd, hstd]) hrank a.1.scope haFit (by rw [hscope]; exact hbFit)
  have hcon : a.1.concept = b.1.concept := by rw [← haCon, ← hbCon, hm]
  unfold sig at hsig
  simp only [Prod.mk.injEq] at hsig
  obtain ⟨hu, hv, he, hs⟩ := hsig
  obtain ⟨⟨fi, fo, fs, fc, fsc, fu, fv, fps, fpe⟩, am⟩ := a
  obtain ⟨⟨gi, go, gs, gc, gsc, gu, gv, gps, gpe⟩, bm⟩ := b
  simp only at haId hbId hdate hstd hscope hcon hu hv he hs hm
  subst hm
  have : fi = gi := by rw [haId, hbId]
  subst this hdate hstd hscope hcon hu hv he hs
  rfl

/-! ## Distinct values -/

theorem mem_dedup (l : List Int) (x : Int) : x ∈ dedup l ↔ x ∈ l := by
  induction l with
  | nil => simp [dedup]
  | cons y ys ih =>
    unfold dedup
    split
    · rename_i hy
      rw [ih]
      constructor
      · exact List.mem_cons_of_mem y
      · intro hx
        rcases List.mem_cons.mp hx with rfl | hx
        · exact hy
        · exact hx
    · simp [ih]

theorem nodup_dedup (l : List Int) : (dedup l).Nodup := by
  induction l with
  | nil => simp [dedup]
  | cons y ys ih =>
    unfold dedup
    split
    · exact ih
    · rename_i hy
      refine List.nodup_cons.mpr ⟨?_, ih⟩
      rw [mem_dedup]; exact hy

theorem nodup_length_le {a b : List Int} (ha : a.Nodup) (hb : b.Nodup) (h : ∀ x ∈ a, x ∈ b) :
    a.length ≤ b.length := by
  induction a generalizing b with
  | nil => simp
  | cons x xs ih =>
    obtain ⟨hx, hxs⟩ := List.nodup_cons.mp ha
    have hxb := h x List.mem_cons_self
    have hsub : ∀ y ∈ xs, y ∈ b.erase x := by
      intro y hy
      have hne : y ≠ x := fun e => hx (e ▸ hy)
      exact (List.mem_erase_of_ne hne).mpr (h y (List.mem_cons_of_mem x hy))
    have := ih hxs (hb.erase x) hsub
    rw [List.length_erase_of_mem hxb] at this
    have : 0 < b.length := List.length_pos_of_mem hxb
    simp only [List.length_cons]
    omega

theorem dedup_length_same {a b : List Int} (h : SameMembers a b) : (dedup a).length = (dedup b).length := by
  apply Nat.le_antisymm
  · exact nodup_length_le (nodup_dedup a) (nodup_dedup b)
      (fun x hx => (mem_dedup b x).mpr ((h x).mp ((mem_dedup a x).mp hx)))
  · exact nodup_length_le (nodup_dedup b) (nodup_dedup a)
      (fun x hx => (mem_dedup a x).mpr ((h x).mpr ((mem_dedup b x).mp hx)))

theorem mem_reportedValues (s : List Cand) (u : String) (x : Int) :
    x ∈ reportedValues s u ↔ ∃ c ∈ s, ∃ b, bestOf (group s c.1.filingId) = .one b ∧ b.1.unit = u ∧
      normalized b = x := by
  unfold reportedValues
  rw [List.mem_filterMap]
  constructor
  · rintro ⟨c, hc, h⟩
    refine ⟨c, hc, ?_⟩
    split at h
    · rename_i b hb
      split at h
      · rename_i hu
        simp only [Option.some.injEq] at h
        exact ⟨b, hb, by simpa using hu, h⟩
      · simp at h
    · simp at h
  · rintro ⟨c, hc, b, hb, hu, hx⟩
    refine ⟨c, hc, ?_⟩
    rw [hb]
    simp [hu, hx]

/-! ## (b) The selection depends only on the set of facts -/

theorem select_congr (M : Metric) (l₁ l₂ : List Fact) (h : SameMembers l₁ l₂)
    (hf : FilingsCoherent l₁) (ht : TableCoherent M) : select M l₁ = select M l₂ := by
  have hf₂ := hf.same h
  unfold select
  split
  · rfl
  · have hm := mapped_same M h
    have hempty : (mapped M l₁ = []) ↔ (mapped M l₂ = []) := by
      constructor
      · intro e
        cases hl : mapped M l₂ with
        | nil => rfl
        | cons x t =>
          have := (hm x).mpr (by rw [hl]; exact List.mem_cons_self)
          rw [e] at this; simp at this
      · intro e
        cases hl : mapped M l₁ with
        | nil => rfl
        | cons x t =>
          have := (hm x).mp (by rw [hl]; exact List.mem_cons_self)
          rw [e] at this; simp at this
    by_cases he : mapped M l₁ = []
    · have he₂ := hempty.mp he
      simp only [he, he₂, ↓reduceIte]
      have : l₁.any (fun f => !M.hasMappings f.standard) = l₂.any (fun f => !M.hasMappings f.standard) := by
        apply Bool.eq_iff_iff.mpr
        simp only [List.any_eq_true]
        constructor
        · rintro ⟨x, hx, e⟩; exact ⟨x, (h x).mp hx, e⟩
        · rintro ⟨x, hx, e⟩; exact ⟨x, (h x).mpr hx, e⟩
      rw [this]
    · have he₂ : ¬ mapped M l₂ = [] := fun e => he (hempty.mpr e)
      simp only [he, he₂, ↓reduceIte]
      have hs := inScope_same hm
      rw [latestKey_same hs]
      cases latestKey (inScope (mapped M l₂)) with
      | none => rfl
      | some k =>
        simp only
        have hg := group_same k.2 hs
        have hb := bestOf_same hg (groupCoherent M l₁ hf ht k.2)
        rw [hb]
        unfold finish
        cases bestOf (group (inScope (mapped M l₂)) k.2) with
        | none => rfl
        | ambiguous => rfl
        | one c =>
          simp only
          have hr : SameMembers (reportedValues (inScope (mapped M l₁)) c.1.unit)
              (reportedValues (inScope (mapped M l₂)) c.1.unit) := by
            intro x
            rw [mem_reportedValues, mem_reportedValues]
            constructor
            · rintro ⟨d, hd, b, hb', hu, hx⟩
              refine ⟨d, (hs d).mp hd, b, ?_, hu, hx⟩
              rw [← bestOf_same (group_same d.1.filingId hs) (groupCoherent M l₁ hf ht _)]
              exact hb'
            · rintro ⟨d, hd, b, hb', hu, hx⟩
              refine ⟨d, (hs d).mpr hd, b, ?_, hu, hx⟩
              rw [bestOf_same (group_same d.1.filingId hs) (groupCoherent M l₁ hf ht _)]
              exact hb'
          rw [dedup_length_same hr]

/-- (b) Reordering the facts never changes the selection. -/
theorem select_perm (M : Metric) (l₁ l₂ : List Fact) (h : l₁.Perm l₂) (hf : FilingsCoherent l₁)
    (ht : TableCoherent M) : select M l₁ = select M l₂ :=
  select_congr M l₁ l₂ (fun _ => h.mem_iff) hf ht

/-- (b) A re-sync that delivers facts already stored (in any order, any number of times) is a no-op. -/
theorem select_resync (M : Metric) (l again : List Fact) (h : ∀ g ∈ again, g ∈ l)
    (hf : FilingsCoherent l) (ht : TableCoherent M) : select M (l ++ again) = select M l := by
  have hs : SameMembers l (l ++ again) := by
    intro x
    constructor
    · exact fun hx => List.mem_append_left again hx
    · intro hx
      rcases List.mem_append.mp hx with hx | hx
      · exact hx
      · exact h x hx
  exact (select_congr M l (l ++ again) hs hf ht).symm

/-! ## (a) A value comes from a fact of a latest filing -/

theorem inScope_nil : inScope [] = [] := rfl

theorem mapped_ne_nil_of_latest (M : Metric) (facts : List Fact) (k : Nat × Nat)
    (h : latestKey (inScope (mapped M facts)) = some k) : mapped M facts ≠ [] := by
  intro e
  rw [e, inScope_nil, latestKey_nil] at h
  contradiction

/-- What an in-scope candidate is: a stored fact with one of the metric's rows that fits it. -/
theorem inScope_mapped_spec (M : Metric) (facts : List Fact) (c : Cand)
    (h : c ∈ inScope (mapped M facts)) :
    c.1 ∈ facts ∧ c.2 ∈ M.mappings ∧ M.hasMappings c.1.standard = true ∧
      c.2.standard = c.1.standard ∧ c.2.concept = c.1.concept ∧ fits c.2 c.1.scope = true ∧
      c.1.scope = chosenScope (mapped M facts) := by
  obtain ⟨hm, hs⟩ := (mem_inScope _ c).mp h
  obtain ⟨hf, hc⟩ := (mem_mapped M facts c).mp hm
  obtain ⟨-, hh, hmap, hstd, hcon, hfit⟩ := (mem_candidatesOf M c.1 c).mp hc
  exact ⟨hf, hmap, hh, hstd, hcon, hfit, hs⟩

/-- Consolidated facts win: the chosen scope is consolidated whenever any mapped fact is. -/
theorem chosenScope_consolidated (cs : List Cand) (h : ∃ c ∈ cs, c.1.scope = .consolidated) :
    chosenScope cs = .consolidated := by
  unfold chosenScope
  have : cs.any (fun c => c.1.scope == .consolidated) = true := by
    obtain ⟨c, hc, e⟩ := h
    exact List.any_eq_true.mpr ⟨c, hc, by simp [e]⟩
  rw [this]; rfl

theorem select_value_spec (M : Metric) (facts : List Fact) (v : Value)
    (h : select M facts = .value v) :
    M.derived = false ∧
      ∃ c ∈ inScope (mapped M facts), ∃ k, latestKey (inScope (mapped M facts)) = some k ∧
        (∃ d ∈ inScope (mapped M facts), key d.1 = k) ∧
        (∀ d ∈ inScope (mapped M facts), keyLe (key d.1) k) ∧
        c.1.filingId = k.2 ∧
        (∀ d ∈ inScope (mapped M facts), d.1.filingId = k.2 → c.2.rank ≤ d.2.rank) ∧
        v = valueOf c v.reportedValueCount ∧
        isCurrency c.1.unit = true ∧
        (M.nonNegative = true → 0 ≤ normalized c) := by
  unfold select at h
  split at h
  · simp at h
  · rename_i hd
    simp only at h
    split at h
    · simp at h
    · split at h
      · simp at h
      · rename_i k hk
        refine ⟨by simpa using hd, ?_⟩
        unfold finish at h
        split at h
        · simp at h
        · simp at h
        · rename_i c hc
          split at h
          · simp at h
          · rename_i hcur
            split at h
            · simp at h
            · rename_i hsign
              simp only [Selection.value.injEq] at h
              subst h
              obtain ⟨hcb, -⟩ := bestOf_one _ c hc
              obtain ⟨hcg, hmin⟩ := (mem_best _ c).mp hcb
              obtain ⟨hcs, hcid⟩ := (mem_group _ _ c).mp hcg
              obtain ⟨hex, hall⟩ := latestKey_spec _ k hk
              refine ⟨c, hcs, k, hk, hex, hall, hcid, ?_, rfl, by simpa using hcur, ?_⟩
              · intro d hds hdid
                exact hmin d ((mem_group _ _ d).mpr ⟨hds, hdid⟩)
              · intro hn
                have : ¬ normalized c < 0 := fun hlt => hsign ⟨hn, hlt⟩
                omega

/-- With coherent filings, the chosen fact belongs to the latest filing itself (its date too). -/
theorem select_value_filedOn (M : Metric) (facts : List Fact) (v : Value) (hf : FilingsCoherent facts)
    (h : select M facts = .value v) :
    ∃ c ∈ inScope (mapped M facts), v = valueOf c v.reportedValueCount ∧
      ∀ d ∈ inScope (mapped M facts), keyLe (key d.1) (key c.1) := by
  obtain ⟨-, c, hc, k, -, ⟨d, hd, hdk⟩, hall, hcid, -, hv, -⟩ := select_value_spec M facts v h
  refine ⟨c, hc, hv, ?_⟩
  have hkc : key c.1 = k := by
    have hcf := (inScope_mapped_spec M facts c hc).1
    have hdf := (inScope_mapped_spec M facts d hd).1
    have hid : c.1.filingId = d.1.filingId := by
      rw [hcid, ← hdk]; rfl
    obtain ⟨hdate, -⟩ := hf c.1 hcf d.1 hdf hid
    rw [← hdk]
    unfold key
    rw [hdate, hid]
  rw [hkc]
  exact hall

/-! ## (c) Facts of older filings never change the selected value -/

/-- The selection with the revision count erased. -/
def Selection.withoutCount : Selection → Selection
  | .value v => .value { v with reportedValueCount := 0 }
  | s => s

theorem finish_withoutCount (M : Metric) (s₁ s₂ : List Cand) (b : Best) :
    (finish M s₁ b).withoutCount = (finish M s₂ b).withoutCount := by
  unfold finish
  cases b with
  | none => rfl
  | ambiguous => rfl
  | one c =>
    simp only
    split
    · rfl
    · split
      · rfl
      · simp [Selection.withoutCount, valueOf]

theorem latestKey_fold_older (B : List Cand) (k : Nat × Nat) (h : ∀ c ∈ B, keyLt (key c.1) k) :
    B.foldl (fun acc c => match acc with
      | none => some (key c.1)
      | some k => if keyLt k (key c.1) then some (key c.1) else some k) (some k) = some k := by
  induction B with
  | nil => rfl
  | cons c rest ih =>
    simp only [List.foldl_cons]
    have hc := h c List.mem_cons_self
    have : ¬ keyLt k (key c.1) := by unfold keyLt at hc ⊢; omega
    simp only [this, ↓reduceIte]
    exact ih (fun d hd => h d (List.mem_cons_of_mem c hd))

theorem select_older_irrelevant (M : Metric) (l new : List Fact) (k : Nat × Nat)
    (hk : latestKey (inScope (mapped M l)) = some k)
    (hnew : ∀ g ∈ new, g.scope = chosenScope (mapped M l) ∧ keyLt (key g) k ∧ g.filingId ≠ k.2) :
    (select M (l ++ new)).withoutCount = (select M l).withoutCount := by
  have hne := mapped_ne_nil_of_latest M l k hk
  have happ : mapped M (l ++ new) = mapped M l ++ mapped M new := List.flatMap_append
  have hB : ∀ c ∈ mapped M new, c.1.scope = chosenScope (mapped M l) ∧ keyLt (key c.1) k ∧
      c.1.filingId ≠ k.2 := fun c hc => hnew c.1 ((mem_mapped M new c).mp hc).1
  have hscope : chosenScope (mapped M l ++ mapped M new) = chosenScope (mapped M l) := by
    by_cases hcons : ∃ c ∈ mapped M l, c.1.scope = .consolidated
    · rw [chosenScope_consolidated _ hcons,
        chosenScope_consolidated _ (by
          obtain ⟨c, hc, e⟩ := hcons
          exact ⟨c, List.mem_append_left _ hc, e⟩)]
    · have hsep : chosenScope (mapped M l) = .separate := by
        unfold chosenScope
        have : (mapped M l).any (fun c => c.1.scope == .consolidated) = false := by
          apply Bool.eq_false_iff.mpr
          intro ha
          obtain ⟨c, hc, e⟩ := List.any_eq_true.mp ha
          exact hcons ⟨c, hc, by simpa using e⟩
        rw [this]; rfl
      rw [hsep]
      unfold chosenScope
      have : (mapped M l ++ mapped M new).any (fun c => c.1.scope == .consolidated) = false := by
        apply Bool.eq_false_iff.mpr
        intro ha
        obtain ⟨c, hc, e⟩ := List.any_eq_true.mp ha
        rcases List.mem_append.mp hc with hc | hc
        · exact hcons ⟨c, hc, by simpa using e⟩
        · have := (hB c hc).1
          rw [hsep] at this
          simp [this] at e
      rw [this]; rfl
  have hin : inScope (mapped M (l ++ new)) = inScope (mapped M l) ++ mapped M new := by
    rw [happ]
    unfold inScope
    rw [hscope, List.filter_append]
    congr 1
    apply List.filter_eq_self.mpr
    intro c hc
    simp [(hB c hc).1]
  have hlatest : latestKey (inScope (mapped M (l ++ new))) = some k := by
    rw [hin]
    unfold latestKey
    rw [List.foldl_append]
    unfold latestKey at hk
    rw [hk]
    exact latestKey_fold_older _ k (fun c hc => (hB c hc).2.1)
  have hgroup : group (inScope (mapped M (l ++ new))) k.2 = group (inScope (mapped M l)) k.2 := by
    rw [hin]
    unfold group
    rw [List.filter_append]
    have : (mapped M new).filter (fun c => c.1.filingId == k.2) = [] := by
      apply List.filter_eq_nil_iff.mpr
      intro c hc
      simpa using (hB c hc).2.2
    rw [this, List.append_nil]
  have hne' : mapped M (l ++ new) ≠ [] := by
    rw [happ]
    intro e
    exact hne (List.append_eq_nil_iff.mp e).1
  unfold select
  split
  · rfl
  · simp only [hne, hne', ↓reduceIte, hlatest, hk, hgroup]
    exact finish_withoutCount M _ _ _

/-- The same with coherent filings: an older filing is never the latest one. -/
theorem select_older_irrelevant_coherent (M : Metric) (l new : List Fact) (k : Nat × Nat)
    (hf : FilingsCoherent (l ++ new)) (hk : latestKey (inScope (mapped M l)) = some k)
    (hnew : ∀ g ∈ new, g.scope = chosenScope (mapped M l) ∧ keyLt (key g) k) :
    (select M (l ++ new)).withoutCount = (select M l).withoutCount := by
  apply select_older_irrelevant M l new k hk
  intro g hg
  obtain ⟨hs, hlt⟩ := hnew g hg
  refine ⟨hs, hlt, ?_⟩
  intro hid
  obtain ⟨⟨d, hd, hdk⟩, -⟩ := latestKey_spec _ k hk
  have hdf := (inScope_mapped_spec M l d hd).1
  obtain ⟨hdate, -⟩ := hf g (List.mem_append_right l hg) d.1 (List.mem_append_left new hdf)
    (by rw [hid, ← hdk]; rfl)
  have : key g = k := by
    show (g.filedOn, g.filingId) = k
    rw [hdate, hid, ← hdk]
    rfl
  rw [this] at hlt
  unfold keyLt at hlt
  omega

/-! ## (d) Ambiguity -/

theorem select_ambiguous_iff (M : Metric) (facts : List Fact) :
    select M facts = .unavailable .ambiguous ↔
      M.derived = false ∧ ∃ k, latestKey (inScope (mapped M facts)) = some k ∧
        ∃ a ∈ best (group (inScope (mapped M facts)) k.2),
          ∃ b ∈ best (group (inScope (mapped M facts)) k.2), sig a ≠ sig b := by
  constructor
  · intro h
    unfold select at h
    split at h
    · simp at h
    · rename_i hd
      simp only at h
      split at h
      · split at h <;> simp at h
      · split at h
        · simp at h
        · rename_i k hk
          refine ⟨by simpa using hd, k, hk, ?_⟩
          apply (bestOf_ambiguous_iff _).mp
          unfold finish at h
          split at h
          · simp at h
          · assumption
          · split at h
            · simp at h
            · split at h <;> simp at h
  · rintro ⟨hd, k, hk, hamb⟩
    have hamb' := (bestOf_ambiguous_iff _).mpr hamb
    have hne := mapped_ne_nil_of_latest M facts k hk
    unfold select
    simp only [hd, Bool.false_eq_true, ↓reduceIte, hne, hk, hamb']
    rfl

/-! ## The EDINET scan plan -/

/-- `EDINET_SCAN`. -/
def discoveryDays : Nat := 400
def windowStartDays : Nat := 30
def windowEndDays : Nat := 100

/-- 1970-01-01 was a Thursday: day `d` is a Sunday when `(d + 4) % 7 = 0`, a Saturday at 6. -/
def isWeekday (d : Nat) : Bool := (d + 4) % 7 != 0 && (d + 4) % 7 != 6

/-- `weekdaysBetween lo (hi - 1)`: the weekdays `lo ≤ d < hi`, ascending. -/
def weekdaysIn (lo hi : Nat) : List Nat := ((List.range (hi - lo)).map (lo + ·)).filter isWeekday

/-- The calendar operations the plan uses: the June 15–30 peak test and `shiftIsoDateYears(·, -k)`. -/
structure Calendar where
  isPeak : Nat → Bool
  yearsBefore : Nat → Nat → Option Nat

structure ScanInput where
  today : Nat
  scanned : List Nat
  /-- (period end, filing date) of the original annual reports found so far. -/
  reports : List (Nat × Nat)
  backfillYears : Nat
  maxDays : Nat

inductive Phase where
  | discovery
  | backfill
  | forward
  | idle
  | notFound
  deriving DecidableEq, Repr

structure Plan where
  phase : Phase
  days : List Nat
  deriving DecidableEq, Repr

/-- The newest report: the latest period end, then the latest filing (the first such one). -/
def newest (rs : List (Nat × Nat)) : Option (Nat × Nat) :=
  rs.foldl (fun acc r => match acc with
    | none => some r
    | some a => if r.1 > a.1 ∨ (r.1 = a.1 ∧ r.2 > a.2) then some r else some a) none

def unscanned (i : ScanInput) (ds : List Nat) : List Nat := ds.filter fun d => decide (d ∉ i.scanned)

def discoveryOrder (cal : Calendar) (today : Nat) : List Nat :=
  let window := (weekdaysIn (today - discoveryDays) today).reverse
  window.filter cal.isPeak ++ window.filter fun d => !cal.isPeak d

def backfillDays (cal : Calendar) (i : ScanInput) (n : Nat × Nat) : List Nat :=
  (List.range' 1 (i.backfillYears - 1)).flatMap fun k =>
    match cal.yearsBefore n.1 k with
    | none => []
    | some e =>
      if e ∈ i.reports.map (·.1) then []
      else (weekdaysIn (e + windowStartDays) (min (e + windowEndDays + 1) i.today)).reverse

def forwardDays (i : ScanInput) (n : Nat × Nat) : List Nat := weekdaysIn (n.2 + 1) i.today

/-- The plan once the newest report (if any) is known. -/
def planWith (cal : Calendar) (i : ScanInput) : Option (Nat × Nat) → Plan
  | none =>
    if unscanned i (discoveryOrder cal i.today) = [] then ⟨.notFound, []⟩
    else ⟨.discovery, (unscanned i (discoveryOrder cal i.today)).take i.maxDays⟩
  | some n =>
    if unscanned i (backfillDays cal i n) ≠ [] then
      ⟨.backfill, (unscanned i (backfillDays cal i n)).take i.maxDays⟩
    else if unscanned i (forwardDays i n) = [] then ⟨.idle, []⟩
    else ⟨.forward, (unscanned i (forwardDays i n)).take i.maxDays⟩

/-- `edinetScanPlan`. -/
def plan (cal : Calendar) (i : ScanInput) : Plan :=
  if i.maxDays = 0 then ⟨.idle, []⟩ else planWith cal i (newest i.reports)

theorem mem_weekdaysIn (lo hi d : Nat) :
    d ∈ weekdaysIn lo hi ↔ lo ≤ d ∧ d < hi ∧ isWeekday d = true := by
  unfold weekdaysIn
  simp only [List.mem_filter, List.mem_map, List.mem_range]
  constructor
  · rintro ⟨⟨j, hj, rfl⟩, hw⟩
    exact ⟨by omega, by omega, hw⟩
  · rintro ⟨hlo, hhi, hw⟩
    exact ⟨⟨d - lo, by omega, by omega⟩, hw⟩

theorem mem_unscanned (i : ScanInput) (ds : List Nat) (d : Nat) :
    d ∈ unscanned i ds ↔ d ∈ ds ∧ d ∉ i.scanned := by
  unfold unscanned
  simp

theorem mem_discoveryOrder (cal : Calendar) (today d : Nat) :
    d ∈ discoveryOrder cal today ↔ d ∈ weekdaysIn (today - discoveryDays) today := by
  unfold discoveryOrder
  simp only [List.mem_append, List.mem_filter, List.mem_reverse]
  constructor
  · rintro (⟨h, -⟩ | ⟨h, -⟩) <;> exact h
  · intro h
    cases hp : cal.isPeak d
    · exact Or.inr ⟨h, by simp⟩
    · exact Or.inl ⟨h, rfl⟩

theorem mem_backfillDays (cal : Calendar) (i : ScanInput) (n : Nat × Nat) (d : Nat) :
    d ∈ backfillDays cal i n ↔ ∃ k e, 1 ≤ k ∧ k < i.backfillYears ∧ cal.yearsBefore n.1 k = some e ∧
      e ∉ i.reports.map (·.1) ∧ d ∈ weekdaysIn (e + windowStartDays) (min (e + windowEndDays + 1) i.today) := by
  unfold backfillDays
  rw [List.mem_flatMap]
  constructor
  · rintro ⟨k, hk, hd⟩
    obtain ⟨j, hj, rfl⟩ := List.mem_range'.mp hk
    split at hd
    · simp at hd
    · rename_i e he
      split at hd
      · simp at hd
      · rename_i hnf
        exact ⟨1 + 1 * j, e, by omega, by omega, he, hnf, List.mem_reverse.mp hd⟩
  · rintro ⟨k, e, hk1, hk2, he, hnf, hd⟩
    refine ⟨k, List.mem_range'.mpr ⟨k - 1, by omega, by omega⟩, ?_⟩
    simp only [he, hnf, ↓reduceIte, List.mem_reverse]
    exact hd

theorem newest_isSome (rs : List (Nat × Nat)) : newest rs = none ↔ rs = [] := by
  constructor
  · intro h
    cases rs with
    | nil => rfl
    | cons r t =>
      exfalso
      unfold newest at h
      simp only [List.foldl_cons] at h
      have : ∀ (l : List (Nat × Nat)) (a : Nat × Nat), l.foldl (fun acc r => match acc with
          | none => some r
          | some a => if r.1 > a.1 ∨ (r.1 = a.1 ∧ r.2 > a.2) then some r else some a) (some a) ≠ none := by
        intro l
        induction l with
        | nil => intro a; simp
        | cons x xs ih =>
          intro a
          simp only [List.foldl_cons]
          split <;> exact ih _
      exact this t r h
  · rintro rfl; rfl

/-- The days the plan draws from: they depend on today, the reports and `backfillYears`, never on what was scanned. -/
def candidates (cal : Calendar) (i : ScanInput) : List Nat :=
  match newest i.reports with
  | none => discoveryOrder cal i.today
  | some n => backfillDays cal i n ++ forwardDays i n

/-- Every planned day is a candidate that is not yet scanned. -/
theorem plan_days_candidates (cal : Calendar) (i : ScanInput) (d : Nat) (h : d ∈ (plan cal i).days) :
    d ∈ candidates cal i ∧ d ∉ i.scanned := by
  unfold plan at h
  split at h
  · simp at h
  · unfold candidates
    cases hn : newest i.reports with
    | none =>
      simp only [hn, planWith] at h ⊢
      split at h
      · simp at h
      · exact (mem_unscanned i _ d).mp (List.mem_of_mem_take h)
    | some n =>
      simp only [hn, planWith] at h ⊢
      split at h
      · have := (mem_unscanned i _ d).mp (List.mem_of_mem_take h)
        exact ⟨List.mem_append_left _ this.1, this.2⟩
      · split at h
        · simp at h
        · have := (mem_unscanned i _ d).mp (List.mem_of_mem_take h)
          exact ⟨List.mem_append_right _ this.1, this.2⟩

/-- Every planned day is a weekday strictly before today that has not been scanned yet. -/
theorem plan_day_spec (cal : Calendar) (i : ScanInput) (d : Nat) (h : d ∈ (plan cal i).days) :
    isWeekday d = true ∧ d < i.today ∧ d ∉ i.scanned := by
  obtain ⟨hc, hs⟩ := plan_days_candidates cal i d h
  refine ⟨?_, ?_, hs⟩
  all_goals
    unfold candidates at hc
    cases hn : newest i.reports with
    | none =>
      simp only [hn] at hc
      have := (mem_weekdaysIn _ _ d).mp ((mem_discoveryOrder cal _ d).mp hc)
      first | exact this.2.2 | exact this.2.1
    | some n =>
      simp only [hn] at hc
      rcases List.mem_append.mp hc with hc | hc
      · obtain ⟨k, e, -, -, -, -, hw⟩ := (mem_backfillDays cal i _ d).mp hc
        have := (mem_weekdaysIn _ _ d).mp hw
        first | exact this.2.2 | omega
      · have := (mem_weekdaysIn _ _ d).mp hc
        first | exact this.2.2 | exact this.2.1

/-- Today is never scanned: its list is still growing. -/
theorem plan_never_today (cal : Calendar) (i : ScanInput) : i.today ∉ (plan cal i).days :=
  fun h => Nat.lt_irrefl _ (plan_day_spec cal i _ h).2.1

/-- At most `maxDays` days per job. -/
theorem plan_length_le (cal : Calendar) (i : ScanInput) : (plan cal i).days.length ≤ i.maxDays := by
  unfold plan
  split
  · simp
  · generalize newest i.reports = o
    cases o with
    | none =>
      simp only [planWith]
      split
      · simp
      · simp only [List.length_take]; omega
    | some n =>
      simp only [planWith]
      split
      · simp only [List.length_take]; omega
      · split
        · simp
        · simp only [List.length_take]; omega

/-- Discovery happens exactly while no annual report is known. -/
theorem plan_discovery_iff (cal : Calendar) (i : ScanInput) :
    ((plan cal i).phase = .discovery ∨ (plan cal i).phase = .notFound) ↔ i.maxDays ≠ 0 ∧ i.reports = [] := by
  rw [← newest_isSome]
  unfold plan
  split
  · rename_i hm
    simp [hm]
  · rename_i hm
    cases newest i.reports with
    | none =>
      simp only [planWith, hm, ne_eq, not_false_eq_true, and_self, iff_true]
      split <;> simp
    | some n =>
      simp only [planWith, reduceCtorEq, and_false, iff_false]
      split
      · simp
      · split <;> simp

/-- Discovery stays within the last `discoveryDays` days. -/
theorem plan_discovery_within (cal : Calendar) (i : ScanInput) (d : Nat)
    (hp : (plan cal i).phase = .discovery) (h : d ∈ (plan cal i).days) :
    i.today - discoveryDays ≤ d ∧ d < i.today := by
  have hr : i.reports = [] := ((plan_discovery_iff cal i).mp (Or.inl hp)).2
  obtain ⟨hc, -⟩ := plan_days_candidates cal i d h
  unfold candidates at hc
  rw [(newest_isSome _).mpr hr] at hc
  have := (mem_weekdaysIn _ _ d).mp ((mem_discoveryOrder cal _ d).mp hc)
  exact ⟨this.1, this.2.1⟩

/-- A backfill day lies 30–100 days after a fiscal year end whose report is still missing. -/
theorem plan_backfill_within (cal : Calendar) (i : ScanInput) (d : Nat)
    (hp : (plan cal i).phase = .backfill) (h : d ∈ (plan cal i).days) :
    ∃ n k e, newest i.reports = some n ∧ 1 ≤ k ∧ k < i.backfillYears ∧ cal.yearsBefore n.1 k = some e ∧
      e ∉ i.reports.map (·.1) ∧ e + windowStartDays ≤ d ∧ d ≤ e + windowEndDays := by
  unfold plan at hp h
  split at hp
  · simp at hp
  · rename_i hm
    simp only [hm, ↓reduceIte] at h
    cases hn : newest i.reports with
    | none =>
      simp only [hn, planWith] at hp
      split at hp <;> simp at hp
    | some n =>
      simp only [hn, planWith] at hp h
      split at hp
      · rename_i hb
        simp only [hb, ne_eq, not_false_eq_true, ↓reduceIte] at h
        have := ((mem_unscanned i _ d).mp (List.mem_of_mem_take h)).1
        obtain ⟨k, e, hk1, hk2, he, hnf, hw⟩ := (mem_backfillDays cal i n d).mp this
        have hw' := (mem_weekdaysIn _ _ d).mp hw
        exact ⟨n, k, e, rfl, hk1, hk2, he, hnf, hw'.1, by have := hw'.2.1; omega⟩
      · split at hp <;> simp at hp

/-- A forward day follows the newest report's filing date. -/
theorem plan_forward_after (cal : Calendar) (i : ScanInput) (d : Nat)
    (hp : (plan cal i).phase = .forward) (h : d ∈ (plan cal i).days) :
    ∃ n, newest i.reports = some n ∧ n.2 < d := by
  unfold plan at hp h
  split at hp
  · simp at hp
  · rename_i hm
    simp only [hm, ↓reduceIte] at h
    cases hn : newest i.reports with
    | none =>
      simp only [hn, planWith] at hp
      split at hp <;> simp at hp
    | some n =>
      simp only [hn, planWith] at hp h
      split at hp
      · simp at hp
      · rename_i hb
        simp only [hb, ↓reduceIte] at h
        split at hp
        · simp at hp
        · rename_i hf
          simp only [hf, ↓reduceIte] at h
          have := ((mem_unscanned i _ d).mp (List.mem_of_mem_take h)).1
          exact ⟨n, rfl, by have := ((mem_weekdaysIn _ _ d).mp this).1; omega⟩

def Phase.scans : Phase → Bool
  | .discovery | .backfill | .forward => true
  | .idle | .notFound => false

/-- A phase that scans plans at least one day. -/
theorem plan_active_nonempty (cal : Calendar) (i : ScanInput) (hp : (plan cal i).phase.scans = true) :
    (plan cal i).days ≠ [] := by
  unfold plan at hp ⊢
  split
  · rename_i hm
    simp [hm, Phase.scans] at hp
  · rename_i hm
    have hpos : 0 < i.maxDays := Nat.pos_of_ne_zero hm
    simp only [hm, ↓reduceIte] at hp
    generalize newest i.reports = o at hp ⊢
    cases o with
    | none =>
      simp only [planWith] at hp ⊢
      split
      · rename_i he
        simp [he, Phase.scans] at hp
      · rename_i hne
        intro ht
        rcases List.take_eq_nil_iff.mp ht with h0 | h0
        · omega
        · exact hne h0
    | some n =>
      simp only [planWith] at hp ⊢
      split
      · rename_i hne
        intro ht
        rcases List.take_eq_nil_iff.mp ht with h0 | h0
        · omega
        · exact hne h0
      · rename_i hb
        split
        · rename_i hf
          simp [hb, hf, Phase.scans] at hp
        · rename_i hne
          intro ht
          rcases List.take_eq_nil_iff.mp ht with h0 | h0
          · omega
          · exact hne h0

/-- An empty plan is final: `idle` or `not-found`. -/
theorem plan_empty_terminal (cal : Calendar) (i : ScanInput) (h : (plan cal i).days = []) :
    (plan cal i).phase = .idle ∨ (plan cal i).phase = .notFound := by
  cases hp : (plan cal i).phase with
  | idle => exact Or.inl rfl
  | notFound => exact Or.inr rfl
  | discovery => exact absurd h (plan_active_nonempty cal i (by rw [hp]; rfl))
  | backfill => exact absurd h (plan_active_nonempty cal i (by rw [hp]; rfl))
  | forward => exact absurd h (plan_active_nonempty cal i (by rw [hp]; rfl))

/-! ### Termination: marking the planned days scanned shrinks a finite measure -/

/-- The input after a job scanned every planned day (reports unchanged). -/
def step (cal : Calendar) (i : ScanInput) : ScanInput :=
  { i with scanned := i.scanned ++ (plan cal i).days }

/-- The candidates not scanned yet (with multiplicity): the termination measure. -/
def remaining (cal : Calendar) (i : ScanInput) : Nat :=
  (candidates cal i).countP fun d => decide (d ∉ i.scanned)

theorem candidates_step (cal : Calendar) (i : ScanInput) :
    candidates cal (step cal i) = candidates cal i := rfl

theorem countP_lt_of_mono {p q : Nat → Bool} (l : List Nat) (hpq : ∀ x ∈ l, q x = true → p x = true)
    (hx : ∃ x ∈ l, p x = true ∧ q x = false) : l.countP q < l.countP p := by
  induction l with
  | nil => simp at hx
  | cons y ys ih =>
    simp only [List.countP_cons]
    have hle : ys.countP q ≤ ys.countP p := by
      apply List.countP_mono_left
      intro x hx hq
      exact hpq x (List.mem_cons_of_mem y hx) hq
    obtain ⟨x, hxm, hpx, hqx⟩ := hx
    rcases List.mem_cons.mp hxm with rfl | hxm
    · simp only [hpx, hqx]
      simp
      omega
    · have := ih (fun z hz hq => hpq z (List.mem_cons_of_mem y hz) hq) ⟨x, hxm, hpx, hqx⟩
      have hy := hpq y List.mem_cons_self
      cases hq : q y <;> cases hp : p y <;> simp_all <;> omega

/-- A job that scans its planned days strictly decreases the unscanned candidates. -/
theorem remaining_step_lt (cal : Calendar) (i : ScanInput) (hp : (plan cal i).phase.scans = true) :
    remaining cal (step cal i) < remaining cal i := by
  unfold remaining
  rw [candidates_step]
  apply countP_lt_of_mono
  · intro x _ hq
    simp only [step, List.mem_append, not_or, decide_eq_true_eq] at hq
    simpa using hq.1
  · have hne := plan_active_nonempty cal i hp
    obtain ⟨d, hd⟩ := List.exists_mem_of_ne_nil _ hne
    obtain ⟨hc, hs⟩ := plan_days_candidates cal i d hd
    refine ⟨d, hc, by simpa using hs, ?_⟩
    simp only [step, List.mem_append, not_or, decide_eq_false_iff_not, not_and, Decidable.not_not]
    intro _
    exact hd

/-- `n` jobs in a row, each marking its planned days scanned. -/
def run (cal : Calendar) : Nat → ScanInput → ScanInput
  | 0, i => i
  | n + 1, i => run cal n (step cal i)

/-- Repeating the plan, each job marking its days scanned, reaches `idle` or `not-found`. -/
theorem plan_eventually_terminal (cal : Calendar) (i : ScanInput) :
    ∃ n, (plan cal (run cal n i)).phase.scans = false := by
  suffices h : ∀ m (i : ScanInput), remaining cal i ≤ m → ∃ n, (plan cal (run cal n i)).phase.scans = false from
    h _ i (Nat.le_refl _)
  intro m
  induction m with
  | zero =>
    intro i hm
    cases hs : (plan cal i).phase.scans with
    | false => exact ⟨0, hs⟩
    | true =>
      have := remaining_step_lt cal i hs
      omega
  | succ m ih =>
    intro i hm
    cases hs : (plan cal i).phase.scans with
    | false => exact ⟨0, hs⟩
    | true =>
      have := remaining_step_lt cal i hs
      obtain ⟨n, hn⟩ := ih (step cal i) (by omega)
      exact ⟨n + 1, hn⟩

/-! ## Annual periods, fiscal years and exact subtraction -/

/-- `ANNUAL_DURATION_DAYS`. -/
def annualMin : Int := 350
def annualMax : Int := 380

/-- `isAnnualDuration` on day numbers (inclusive day count). -/
def isAnnualDuration (start finish : Int) : Bool :=
  decide (annualMin ≤ finish - start + 1 ∧ finish - start + 1 ≤ annualMax)

theorem annual_iff (start finish : Int) :
    isAnnualDuration start finish = true ↔ start + 349 ≤ finish ∧ finish ≤ start + 379 := by
  unfold isAnnualDuration annualMin annualMax
  simp only [decide_eq_true_eq]
  omega

/-- Calendar years (365, 366 days) and 52/53-week years (364, 371 days) are annual; a half year is not. -/
theorem annual_examples (start : Int) :
    isAnnualDuration start (start + 364) = true ∧ isAnnualDuration start (start + 365) = true ∧
      isAnnualDuration start (start + 363) = true ∧ isAnnualDuration start (start + 370) = true ∧
      isAnnualDuration start (start + 183) = false := by
  refine ⟨(annual_iff _ _).mpr (by omega), (annual_iff _ _).mpr (by omega),
    (annual_iff _ _).mpr (by omega), (annual_iff _ _).mpr (by omega), ?_⟩
  apply Bool.eq_false_iff.mpr
  intro h
  have := (annual_iff _ _).mp h
  omega

/-- `fiscalYearOfPeriodEnd` on a civil date. -/
def fiscalYear (year month day : Int) : Int :=
  if month = 1 ∧ day ≤ 7 then year - 1 else year

theorem fiscalYear_spec (year month day : Int) :
    (month = 1 ∧ day ≤ 7 → fiscalYear year month day = year - 1) ∧
      (¬ (month = 1 ∧ day ≤ 7) → fiscalYear year month day = year) := by
  unfold fiscalYear
  constructor
  · intro h; simp [h]
  · intro h; simp [h]

/-- A decimal: `coef / 10 ^ scale`. -/
structure Dec where
  coef : Int
  scale : Nat
  deriving DecidableEq, Repr

/-- Canonical text has no trailing fractional zero. -/
def Dec.Canonical (d : Dec) : Prop := d.scale = 0 ∨ d.coef % 10 ≠ 0

/-- Equal as numbers. -/
def Dec.Eqv (a b : Dec) : Prop := a.coef * 10 ^ b.scale = b.coef * 10 ^ a.scale

/-- Exact sum (not canonical): the test the subtraction must pass. -/
def Dec.add (a b : Dec) : Dec := ⟨a.coef * 10 ^ b.scale + b.coef * 10 ^ a.scale, a.scale + b.scale⟩

/-- `fromScaled`: strip trailing fractional zeros. -/
def strip : Int → Nat → Dec
  | c, 0 => ⟨c, 0⟩
  | c, s + 1 => if c % 10 = 0 then strip (c / 10) s else ⟨c, s + 1⟩

/-- `subtractDecimals`. -/
def subtract (a b : Dec) : Dec :=
  let s := max a.scale b.scale
  strip (a.coef * 10 ^ (s - a.scale) - b.coef * 10 ^ (s - b.scale)) s

theorem strip_canonical (c : Int) (s : Nat) : (strip c s).Canonical := by
  induction s generalizing c with
  | zero => exact Or.inl rfl
  | succ s ih =>
    unfold strip
    split
    · exact ih _
    · rename_i h
      exact Or.inr h

theorem strip_eqv (c : Int) (s : Nat) : Dec.Eqv (strip c s) ⟨c, s⟩ := by
  induction s generalizing c with
  | zero => unfold strip Dec.Eqv; simp
  | succ s ih =>
    unfold strip
    split
    · rename_i h
      have h10 : c / 10 * 10 = c := Int.ediv_mul_cancel (Int.dvd_of_emod_eq_zero h)
      have hih := ih (c / 10)
      unfold Dec.Eqv at hih ⊢
      simp only at hih ⊢
      generalize strip (c / 10) s = R at hih ⊢
      generalize c / 10 = q at h10 hih
      rw [Int.pow_succ]
      generalize (10 : Int) ^ s = Q at hih ⊢
      generalize (10 : Int) ^ R.scale = P at hih ⊢
      subst h10
      grind
    · unfold Dec.Eqv; rfl

/-- `subtractDecimals` is canonical. -/
theorem subtract_canonical (a b : Dec) : (subtract a b).Canonical := strip_canonical _ _

/-- `subtractDecimals` is exact: result + right = left. -/
theorem subtract_exact (a b : Dec) : Dec.Eqv (Dec.add (subtract a b) b) a := by
  have hr := strip_eqv (a.coef * 10 ^ (max a.scale b.scale - a.scale) -
    b.coef * 10 ^ (max a.scale b.scale - b.scale)) (max a.scale b.scale)
  unfold subtract
  simp only
  generalize hR : strip (a.coef * 10 ^ (max a.scale b.scale - a.scale) -
    b.coef * 10 ^ (max a.scale b.scale - b.scale)) (max a.scale b.scale) = R at hr
  unfold Dec.Eqv Dec.add at *
  simp only at hr ⊢
  have ha : (10 : Int) ^ (max a.scale b.scale - a.scale) * 10 ^ a.scale = 10 ^ max a.scale b.scale := by
    rw [← Int.pow_add]; congr 1; omega
  have hb : (10 : Int) ^ (max a.scale b.scale - b.scale) * 10 ^ b.scale = 10 ^ max a.scale b.scale := by
    rw [← Int.pow_add]; congr 1; omega
  have hpos : (10 : Int) ^ max a.scale b.scale ≠ 0 := Int.ne_of_gt (Int.pow_pos (by decide))
  rw [Int.pow_add]
  apply Int.eq_of_mul_eq_mul_right hpos
  generalize (10 : Int) ^ (max a.scale b.scale - a.scale) = A at ha hr
  generalize (10 : Int) ^ (max a.scale b.scale - b.scale) = B at hb hr
  generalize (10 : Int) ^ max a.scale b.scale = S at ha hb hr hpos
  generalize (10 : Int) ^ a.scale = PA at ha
  generalize (10 : Int) ^ b.scale = PB at hb
  generalize (10 : Int) ^ R.scale = PR at hr
  grind

/-! ## The vector tables and calendar

The metrics the conformance vectors replay, with the rows of
`EQUITY_CONCEPT_MAPPINGS` they read (concept names verbatim), and the civil
calendar the scan plan uses (Hinnant arithmetic from `MonthGrid.lean`).
-/

/-- Two rows that would tie inside one filing: same standard, same rank, a scope both fit. -/
def clash (a b : Mapping) : Prop :=
  a.standard = b.standard ∧ a.rank = b.rank ∧
    ((fits a .consolidated && fits b .consolidated) || (fits a .separate && fits b .separate)) = true

instance (a b : Mapping) : Decidable (clash a b) := by unfold clash; infer_instance

theorem clash_symm (a b : Mapping) (h : clash a b) : clash b a := by
  obtain ⟨h1, h2, h3⟩ := h
  refine ⟨h1.symm, h2.symm, ?_⟩
  simp only [Bool.or_eq_true, Bool.and_eq_true] at h3 ⊢
  rcases h3 with ⟨x, y⟩ | ⟨x, y⟩
  · exact Or.inl ⟨y, x⟩
  · exact Or.inr ⟨y, x⟩

theorem eq_of_pairwise_clash (l : List Mapping) (hp : l.Pairwise fun a b => ¬ clash a b)
    (a b : Mapping) (ha : a ∈ l) (hb : b ∈ l) (h : clash a b) : a = b := by
  induction l with
  | nil => simp at ha
  | cons x xs ih =>
    obtain ⟨hx, hxs⟩ := List.pairwise_cons.mp hp
    rcases List.mem_cons.mp ha with rfl | ha' <;> rcases List.mem_cons.mp hb with rfl | hb'
    · rfl
    · exact absurd h (hx b hb')
    · exact absurd (clash_symm _ _ h) (hx a ha')
    · exact ih hxs ha' hb'

theorem tableCoherent_of_pairwise (M : Metric) (hp : M.mappings.Pairwise fun a b => ¬ clash a b) :
    TableCoherent M := by
  intro m₁ h₁ m₂ h₂ hs hr s f₁ f₂
  apply eq_of_pairwise_clash _ hp _ _ h₁ h₂
  refine ⟨hs, hr, ?_⟩
  cases s <;> simp [f₁, f₂]

def row (standard : Standard) (concept : String) (rank : Nat) (negate : Bool := false)
    (scope : Option Scope := none) : Mapping :=
  { standard, concept, rank, negate, scope }

/-- `standardHasMappings`: IFRS has no reviewed mapping yet. -/
def hasReviewedMappings : Standard → Bool
  | .usGaap => true
  | .jgaap => true
  | .ifrs => false

def revenueMetric : Metric :=
  { derived := false, nonNegative := false, hasMappings := hasReviewedMappings,
    mappings := [
      row .usGaap "us-gaap:Revenues" 0,
      row .usGaap "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" 1,
      row .usGaap "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax" 2,
      row .usGaap "us-gaap:SalesRevenueNet" 3,
      row .jgaap "jppfs_cor:NetSales" 0,
      row .jgaap "jppfs_cor:OperatingRevenue1" 1] }

def profitMetric : Metric :=
  { derived := false, nonNegative := false, hasMappings := hasReviewedMappings,
    mappings := [
      row .usGaap "us-gaap:NetIncomeLoss" 0,
      row .jgaap "jppfs_cor:ProfitLossAttributableToOwnersOfParent" 0 false (some .consolidated),
      row .jgaap "jppfs_cor:ProfitLoss" 0 false (some .separate)] }

def capexMetric : Metric :=
  { derived := false, nonNegative := true, hasMappings := hasReviewedMappings,
    mappings := [
      row .usGaap "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment" 0,
      row .jgaap "jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF" 0 true] }

def freeCashFlowMetric : Metric :=
  { derived := true, nonNegative := false, hasMappings := hasReviewedMappings, mappings := [] }

/-- The vector tables meet the selection's table precondition. -/
theorem conceptTables_coherent :
    TableCoherent revenueMetric ∧ TableCoherent profitMetric ∧ TableCoherent capexMetric ∧
      TableCoherent freeCashFlowMetric :=
  ⟨tableCoherent_of_pairwise _ (by decide), tableCoherent_of_pairwise _ (by decide),
    tableCoherent_of_pairwise _ (by decide), tableCoherent_of_pairwise _ (by decide)⟩

/-- The June 15–30 peak of March year-end filings (`EDINET_SCAN.peakMonthDay…`). -/
def civilPeak (d : Nat) : Bool :=
  let (_, m, dd) := gridCivilFromDays d
  m == 6 && 15 ≤ dd && dd ≤ 30

/-- `shiftIsoDateYears(·, -k)`: the same month and day `k` years earlier, 29 February → 28. -/
def civilYearsBefore (d k : Nat) : Option Nat :=
  let (y, m, dd) := gridCivilFromDays d
  let y' := y - k
  if y' < 1970 then none
  else
    let day := if m = 2 ∧ dd = 29 ∧ gridLeapYear y'.toNat = false then 28 else dd
    some (gridDaysFromCivil y'.toNat m.toNat day.toNat).toNat

def edinetCalendar : Calendar := { isPeak := civilPeak, yearsBefore := civilYearsBefore }

end Research.FinancialStatements
