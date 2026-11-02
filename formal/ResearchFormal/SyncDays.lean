import ResearchFormal.Basic

/-!
# The day planner of the per-date stock-price sync (ADR-0058 §2, §8)

Formal model of `planSyncDays` in `packages/domain/src/sync/syncDays.ts`:
which days of a window a `stock-prices-sync` job asks the provider for (its
only user, ADR-0059 §1).

Abstractions (tied to the code by the conformance vectors):

- Dates are day numbers (`Int`, days since 1970-01-01, a Thursday); the code
  parses `YYYY-MM-DD` into the same numbers (`isoDayNumber`). Invalid date
  text, which the code ignores (a known entry) or answers with `[]` (a window
  end), is outside the model and covered by unit tests.
- The weekday is `(d + 4) % 7` with Lean's Euclidean `%` on `Int`, which is
  the code's `(((d + 4) % 7) + 7) % 7` (0 = Sunday … 6 = Saturday), also for
  days before 1970.
- Instants (`nowMs`, `retryAtMs`) and the cap are integers; the code floors
  the cap, the vectors pass integers.

`planSyncDays` is the code's loop (`walk`: from `newest` down, while days are
left in the window and places in the plan). `plan_eq_take` shows it is the
first `max` due days of the window, newest first, and every guarantee
follows:

- `plan_mem` (a) — every planned day is a weekday of `[oldest, newest]`;
- `plan_pairwise`, `plan_nodup` (b) — strictly decreasing, so no repeats;
- `plan_not_blocked` (c) — no planned day has a final known entry or one
  whose retry time has not come (`now < retryAt`); a day listed twice is
  blocked when any entry blocks it;
- `plan_length_le` (d) — at most `max` days;
- `plan_complete` (e) — a due day (a weekday of the window that no known
  entry blocks) is left out only when `max` days were chosen, all newer than
  it; `plan_all_due` — a plan shorter than `max` holds every due day;
- `plan_empty_of_lt`, `plan_empty_of_max` (f) — an empty window
  (`newest < oldest`) or `max ≤ 0` plans nothing.
-/

namespace Research
namespace SyncDays

/-- `KnownSyncDay`: a day the store already has an outcome for. -/
structure Known where
  day : Int
  final : Bool
  retryAt : Int
  deriving DecidableEq, Repr

/-- `SyncDaysInput`, in day numbers. -/
structure Input where
  newest : Int
  oldest : Int
  known : List Known
  now : Int
  max : Int
  deriving Repr

/-- 0 = Sunday … 6 = Saturday; day 0 (1970-01-01) is a Thursday. -/
def weekdayOf (d : Int) : Int := (d + 4) % 7

def isWeekday (d : Int) : Bool := weekdayOf d != 0 && weekdayOf d != 6

/-- A known entry keeps its day out: final, or its retry time has not come. -/
def Known.blocks (now : Int) (k : Known) : Bool := k.final || decide (now < k.retryAt)

/-- Some entry for `d` blocks it (the code's `blocked` set). -/
def blocked (known : List Known) (now d : Int) : Bool :=
  known.any fun k => k.day == d && k.blocks now

/-- A day the plan may take: a weekday no known entry blocks. -/
def due (known : List Known) (now d : Int) : Bool := isWeekday d && !blocked known now d

/-- `n` consecutive days from `d` downward: `d, d - 1, …, d - n + 1`. -/
def daysDown : Nat → Int → List Int
  | 0, _ => []
  | n + 1, d => d :: daysDown n (d - 1)

/-- The code's loop: at day `d`, `n` days left in the window, `c` places left in the plan. -/
def walk (p : Int → Bool) : Nat → Int → Nat → List Int
  | 0, _, _ => []
  | _ + 1, _, 0 => []
  | n + 1, d, c + 1 => if p d then d :: walk p n (d - 1) c else walk p n (d - 1) (c + 1)

/-- The number of days of `[oldest, newest]` (0 when `newest < oldest`). -/
def windowLength (i : Input) : Nat := (i.newest - i.oldest + 1).toNat

def planSyncDays (i : Input) : List Int :=
  if i.newest < i.oldest ∨ i.max ≤ 0 then []
  else walk (due i.known i.now) (windowLength i) i.newest i.max.toNat

/-- The due days of the window, newest first: what the plan takes from. -/
def dueDays (i : Input) : List Int := (daysDown (windowLength i) i.newest).filter (due i.known i.now)

/-! ## The window -/

theorem mem_daysDown (n : Nat) (d x : Int) : x ∈ daysDown n d ↔ d - n < x ∧ x ≤ d := by
  induction n generalizing d with
  | zero => simp [daysDown]
  | succ n ih =>
    simp only [daysDown, List.mem_cons, ih]
    push_cast
    omega

theorem pairwise_daysDown (n : Nat) (d : Int) : (daysDown n d).Pairwise (· > ·) := by
  induction n generalizing d with
  | zero => exact List.Pairwise.nil
  | succ n ih =>
    refine List.pairwise_cons.mpr ⟨fun y hy => ?_, ih (d - 1)⟩
    have := (mem_daysDown n (d - 1) y).mp hy
    omega

theorem mem_window (i : Input) (x : Int) :
    x ∈ daysDown (windowLength i) i.newest ↔ i.oldest ≤ x ∧ x ≤ i.newest := by
  rw [mem_daysDown]
  unfold windowLength
  by_cases h : 0 ≤ i.newest - i.oldest + 1
  · rw [Int.toNat_of_nonneg h]; omega
  · have : (i.newest - i.oldest + 1).toNat = 0 := by omega
    rw [this]; omega

/-! ## The loop is "the first `max` due days" -/

theorem walk_eq (p : Int → Bool) (n : Nat) (d : Int) (c : Nat) :
    walk p n d c = ((daysDown n d).filter p).take c := by
  induction n generalizing d c with
  | zero => simp [walk, daysDown]
  | succ n ih =>
    cases c with
    | zero => simp [walk]
    | succ c =>
      simp only [walk, daysDown, List.filter_cons]
      by_cases hp : p d
      · simp [hp, ih]
      · simp [hp, ih]

theorem plan_eq_take (i : Input) : planSyncDays i = (dueDays i).take i.max.toNat := by
  unfold planSyncDays dueDays
  by_cases h : i.newest < i.oldest ∨ i.max ≤ 0
  · rw [ifPos h]
    rcases h with h | h
    · have : windowLength i = 0 := by unfold windowLength; omega
      simp [this, daysDown]
    · have : i.max.toNat = 0 := by omega
      simp [this]
  · rw [ifNeg h, walk_eq]

theorem due_iff (known : List Known) (now d : Int) :
    due known now d = true ↔
      isWeekday d = true ∧ ∀ k ∈ known, k.day = d → k.final = false ∧ k.retryAt ≤ now := by
  unfold due blocked Known.blocks
  simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true, List.any_eq_false,
    beq_iff_eq, Bool.or_eq_true, decide_eq_true_eq]
  constructor
  · rintro ⟨hw, hk⟩
    refine ⟨hw, fun k hm hd => ⟨?_, ?_⟩⟩
    · cases hf : k.final
      · rfl
      · exact absurd ⟨hd, Or.inl hf⟩ (hk k hm)
    · exact Int.not_lt.mp fun hr => hk k hm ⟨hd, Or.inr hr⟩
  · rintro ⟨hw, hk⟩
    refine ⟨hw, fun k hm ⟨hd, hc⟩ => ?_⟩
    obtain ⟨hf, hr⟩ := hk k hm hd
    rcases hc with hc | hc
    · rw [hf] at hc; exact Bool.false_ne_true hc
    · omega

theorem mem_dueDays (i : Input) (x : Int) :
    x ∈ dueDays i ↔ (isWeekday x = true ∧ i.oldest ≤ x ∧ x ≤ i.newest) ∧
      ∀ k ∈ i.known, k.day = x → k.final = false ∧ k.retryAt ≤ i.now := by
  unfold dueDays
  rw [List.mem_filter, mem_window, due_iff]
  constructor
  · rintro ⟨hw, hd, hk⟩; exact ⟨⟨hd, hw⟩, hk⟩
  · rintro ⟨⟨hd, hw⟩, hk⟩; exact ⟨hw, hd, hk⟩

theorem pairwise_dueDays (i : Input) : (dueDays i).Pairwise (· > ·) :=
  (pairwise_daysDown _ _).filter _

/-! ## The guarantees -/

/-- (a) Every planned day is a weekday of the window. -/
theorem plan_mem (i : Input) (x : Int) (h : x ∈ planSyncDays i) :
    isWeekday x = true ∧ i.oldest ≤ x ∧ x ≤ i.newest := by
  rw [plan_eq_take] at h
  exact ((mem_dueDays i x).mp (List.mem_of_mem_take h)).1

/-- (b) Newest first, strictly. -/
theorem plan_pairwise (i : Input) : (planSyncDays i).Pairwise (· > ·) := by
  rw [plan_eq_take]
  exact (pairwise_dueDays i).sublist (List.take_sublist _ _)

theorem plan_nodup (i : Input) : (planSyncDays i).Nodup :=
  (plan_pairwise i).imp fun h => Int.ne_of_gt h

/-- (c) No planned day has a known entry that is final or before its retry time. -/
theorem plan_not_blocked (i : Input) (x : Int) (h : x ∈ planSyncDays i) (k : Known)
    (hk : k ∈ i.known) (hd : k.day = x) : k.final = false ∧ k.retryAt ≤ i.now := by
  rw [plan_eq_take] at h
  exact ((mem_dueDays i x).mp (List.mem_of_mem_take h)).2 k hk hd

/-- (d) At most `max` days. -/
theorem plan_length_le (i : Input) : (planSyncDays i).length ≤ i.max.toNat := by
  rw [plan_eq_take, List.length_take]
  exact Nat.min_le_left _ _

/-- Left out of a prefix of a strictly decreasing list: the prefix is full and newer. -/
theorem take_complete {l : List Int} (hp : l.Pairwise (· > ·)) {y : Int} (hy : y ∈ l) (c : Nat)
    (hn : y ∉ l.take c) : (l.take c).length = c ∧ ∀ x ∈ l.take c, y < x := by
  induction l generalizing c with
  | nil => simp at hy
  | cons a l ih =>
    obtain ⟨ha, hl⟩ := List.pairwise_cons.mp hp
    cases c with
    | zero => simp
    | succ c =>
      rw [List.take_succ_cons, List.mem_cons, not_or] at hn
      have hyl : y ∈ l := by
        rcases List.mem_cons.mp hy with rfl | h
        · exact absurd rfl hn.1
        · exact h
      obtain ⟨hlen, hlt⟩ := ih hl hyl c hn.2
      refine ⟨by simp [List.take_succ_cons, hlen], fun x hx => ?_⟩
      rw [List.take_succ_cons, List.mem_cons] at hx
      rcases hx with rfl | hx
      · exact ha y hyl
      · exact hlt x hx

/-- (e) Completeness: a due day is left out only when `max` newer due days were chosen. -/
theorem plan_complete (i : Input) (d : Int) (hw : isWeekday d = true) (hlo : i.oldest ≤ d)
    (hhi : d ≤ i.newest) (hk : ∀ k ∈ i.known, k.day = d → k.final = false ∧ k.retryAt ≤ i.now)
    (hn : d ∉ planSyncDays i) :
    (planSyncDays i).length = i.max.toNat ∧ ∀ x ∈ planSyncDays i, d < x := by
  rw [plan_eq_take] at hn ⊢
  exact take_complete (pairwise_dueDays i) ((mem_dueDays i d).mpr ⟨⟨hw, hlo, hhi⟩, hk⟩) _ hn

/-- A plan shorter than `max` holds every due day of the window. -/
theorem plan_all_due (i : Input) (h : (planSyncDays i).length < i.max.toNat) (d : Int)
    (hw : isWeekday d = true) (hlo : i.oldest ≤ d) (hhi : d ≤ i.newest)
    (hk : ∀ k ∈ i.known, k.day = d → k.final = false ∧ k.retryAt ≤ i.now) :
    d ∈ planSyncDays i := by
  by_cases hm : d ∈ planSyncDays i
  · exact hm
  · have := (plan_complete i d hw hlo hhi hk hm).1
    omega

/-- (f) An empty window plans nothing. -/
theorem plan_empty_of_lt (i : Input) (h : i.newest < i.oldest) : planSyncDays i = [] :=
  ifPos (Or.inl h)

/-- (f) A cap of zero or less plans nothing. -/
theorem plan_empty_of_max (i : Input) (h : i.max ≤ 0) : planSyncDays i = [] :=
  ifPos (Or.inr h)

/-- Weekdays by the calendar: 1970-01-01 Thursday, 1970-01-03 Saturday, 1970-01-04 Sunday,
    1969-12-29 Monday (the Euclidean `%` before 1970). -/
theorem weekday_examples :
    weekdayOf 0 = 4 ∧ weekdayOf 2 = 6 ∧ weekdayOf 3 = 0 ∧ weekdayOf (-3) = 1 ∧
      isWeekday (-4) = false ∧ isWeekday (-3) = true := by decide

end SyncDays
end Research
