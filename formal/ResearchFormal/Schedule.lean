import ResearchFormal.MonthGrid

/-!
# Scheduled tasks: the next local slot and the claim-time tick

Formal model of `nextLocalSlot` and `decideTaskTick` in
`packages/domain/src/schedule/schedule.ts` (ADR-0033).

Local wall-clock time is a natural number of minutes since 1970-01-01 00:00
local (the TypeScript `LocalMinute`; the vectors stay at or after 1970, where
the two agree). A day is `minute / 1440`, the minute of the day
`minute % 1440`, and the weekday of day `n` is `(n + 4) % 7` (0 = Sunday;
1970-01-01 was a Thursday).

The calendar is rebuilt here so that it can be reasoned about: month `k`
(January 1970 is month 0) has `monthLen k` days (`gridDaysInMonth`, so 28–31
with Gregorian leap years) and starts on day `monthStart k`, the sum of the
lengths before it; `monthOf d` is the month that contains day `d`, found by
walking the months. The TypeScript uses Hinnant's closed-form
`days_from_civil` / `civil_from_days` instead; the exported vectors tie the
two together on samples around month, leap-day and century boundaries.

`Sched.matches s m` says, declaratively, which minutes a schedule names:

* `once` — exactly its date and time;
* `daily` — every minute whose minute of the day is the time;
* `weekly` — those of them on a listed weekday;
* `monthly` — those on the given day of the month, or on the month's last
  day when the month is shorter (a 31st runs on 30 April and 28/29 February).

Proved below, for every well-formed schedule (`Sched.valid`):

* `nextLocalSlot_gt` — the slot is strictly after its input;
* `nextLocalSlot_matches` — the slot is a minute the schedule names;
* `nextLocalSlot_minimal` — no minute the schedule names lies strictly
  between the input and the slot (monthly included, with last-day clamping);
* `nextLocalSlot_complete` — whenever the schedule names some minute after
  the input, a slot exists and is no later: together with the two above, the
  slot is *the least* named minute after the input;
* `nextLocalSlot_recurring` — daily, weekly and monthly schedules always have
  a next slot; `nextLocalSlot_once_passed` — a `once` whose time is not after
  the input has none.

And for the tick (`decideTaskTick`), for any `nextAfter`:

* `tick_fire_requires` — a fire happens only for an active task that is due
  (`nextRunAt ≤ now`) and has no unfinished run;
* `tick_fire_next_gt` — a fire's next run, when there is one, is strictly
  after now, and the task stays active; `tick_fire_next_none` — without one
  the task completes; `tick_fire_takes_next` — the next run is the schedule
  function's answer whenever that is after now;
* `tick_after_fire_idle` — the stored result ticks `idle` at every instant
  before its next run (and forever once completed): the slot never fires
  twice, and every slot missed up to now is folded into the one run;
* bound to a schedule in local minutes: `tick_fire_coalesces` — after a
  fire, no named minute lies between now and the next run;
  `tick_once_completes` — a `once` task completes when it fires;
  `tick_recurring_stays_active` — a recurring one stays active.

Not modelled: time-zone resolution (`timeZone.ts`: `Intl` offsets and the
daylight-saving `compatible` disambiguation), which the unit tests pin over
fixed zones, and the parsing of `HH:MM` / `YYYY-MM-DD` text.
-/

namespace Research
namespace Schedule

/-! ## The calendar -/

/-- Days of month `k` (month 0 = January 1970). -/
def monthLen (k : Nat) : Nat := gridDaysInMonth (1970 + k / 12) (k % 12 + 1)

theorem monthLen_bounds (k : Nat) : 28 ≤ monthLen k ∧ monthLen k ≤ 31 := by
  unfold monthLen gridDaysInMonth
  split
  all_goals (try split)
  all_goals omega

/-- The first day of month `k`. -/
def monthStart : Nat → Nat
  | 0 => 0
  | k + 1 => monthStart k + monthLen k

theorem monthStart_succ (k : Nat) : monthStart (k + 1) = monthStart k + monthLen k := rfl

theorem monthStart_mono {j k : Nat} (h : j ≤ k) : monthStart j ≤ monthStart k := by
  induction k with
  | zero =>
    have : j = 0 := by omega
    subst this
    exact Nat.le_refl _
  | succ k ih =>
    by_cases hjk : j = k + 1
    · subst hjk
      exact Nat.le_refl _
    · have := ih (by omega)
      rw [monthStart_succ]
      omega

/-- Walks the months from `k` (which starts on day `start`) to the one holding `d`. -/
def monthOfAux (d : Nat) : Nat → Nat → Nat → Nat
  | k, _, 0 => k
  | k, start, fuel + 1 =>
    if d < start + monthLen k then k else monthOfAux d (k + 1) (start + monthLen k) fuel

/-- The month that contains day `d`. -/
def monthOf (d : Nat) : Nat := monthOfAux d 0 0 (d + 1)

theorem monthOfAux_spec (d : Nat) :
    ∀ (fuel k start : Nat), start = monthStart k → start ≤ d → d < start + fuel →
      monthStart (monthOfAux d k start fuel) ≤ d ∧
        d < monthStart (monthOfAux d k start fuel + 1) := by
  intro fuel
  induction fuel with
  | zero => intro k start _ h1 h2; omega
  | succ fuel ih =>
    intro k start hs h1 h2
    unfold monthOfAux
    by_cases hin : d < start + monthLen k
    · rw [ifPos hin, monthStart_succ]
      omega
    · rw [ifNeg hin]
      have hl := (monthLen_bounds k).1
      exact ih (k + 1) (start + monthLen k) (by rw [monthStart_succ, hs]) (by omega) (by omega)

/-- `monthOf d` brackets `d`. -/
theorem monthOf_spec (d : Nat) :
    monthStart (monthOf d) ≤ d ∧ d < monthStart (monthOf d + 1) :=
  monthOfAux_spec d (d + 1) 0 0 rfl (Nat.zero_le _) (by omega)

/-- A month that brackets `d` is `monthOf d`. -/
theorem monthOf_unique {d k : Nat} (h1 : monthStart k ≤ d) (h2 : d < monthStart (k + 1)) :
    monthOf d = k := by
  have ⟨s1, s2⟩ := monthOf_spec d
  by_cases hlt : monthOf d < k
  · have := monthStart_mono (show monthOf d + 1 ≤ k by omega)
    omega
  · by_cases hgt : k < monthOf d
    · have := monthStart_mono (show k + 1 ≤ monthOf d by omega)
      omega
    · omega

theorem monthOf_mono {d e : Nat} (h : d ≤ e) : monthOf d ≤ monthOf e := by
  have ⟨d1, _⟩ := monthOf_spec d
  have ⟨_, e2⟩ := monthOf_spec e
  by_cases hlt : monthOf e < monthOf d
  · have := monthStart_mono (show monthOf e + 1 ≤ monthOf d by omega)
    omega
  · omega

/-! ## Schedules -/

/-- A schedule in local wall-clock time; `time` is the minute of the day. -/
inductive Sched where
  /-- One civil date (`year`, `month` 1–12, `day`) and time. -/
  | once (year month day time : Nat)
  | daily (time : Nat)
  /-- Weekdays 0 = Sunday … 6 = Saturday, ascending without repeats. -/
  | weekly (days : List Nat) (time : Nat)
  /-- Day of the month 1–31; a shorter month runs on its last day. -/
  | monthly (day time : Nat)
  deriving Repr, DecidableEq

/-- Strictly ascending (so no repeats). -/
def ascending : List Nat → Bool
  | [] => true
  | [_] => true
  | a :: b :: rest => decide (a < b) && ascending (b :: rest)

/-- `isValidSchedule` (dates before 1970 are outside the model). -/
def Sched.valid : Sched → Bool
  | .once y m d t =>
    decide (t < 1440 ∧ 1970 ≤ y ∧ 1 ≤ m ∧ m ≤ 12 ∧ 1 ≤ d ∧ d ≤ gridDaysInMonth y m)
  | .daily t => decide (t < 1440)
  | .weekly ds t => decide (t < 1440) && !ds.isEmpty && ds.all (fun d => decide (d < 7)) &&
      ascending ds
  | .monthly d t => decide (t < 1440 ∧ 1 ≤ d ∧ d ≤ 31)

/-- The minute of a `once` schedule. -/
def onceSlot (y m d t : Nat) : Nat :=
  (monthStart ((y - 1970) * 12 + (m - 1)) + (d - 1)) * 1440 + t

/-- Weekday of a day number (0 = Sunday). -/
def weekdayOf (day : Nat) : Nat := (day + 4) % 7

/-- The minute a monthly schedule names in month `k` (day clamped to the month). -/
def monthlyCand (dd t k : Nat) : Nat := (monthStart k + min dd (monthLen k) - 1) * 1440 + t

/-- Which minutes a schedule names. -/
def Sched.matches : Sched → Nat → Prop
  | .once y m d t, x => x = onceSlot y m d t
  | .daily t, x => x % 1440 = t
  | .weekly ds t, x => x % 1440 = t ∧ weekdayOf (x / 1440) ∈ ds
  | .monthly dd t, x =>
    x % 1440 = t ∧ x / 1440 + 1 = monthStart (monthOf (x / 1440)) + min dd (monthLen (monthOf (x / 1440)))

/-! ## The next slot -/

/-- Day offsets `i, i+1, …` (at most `fuel` of them) after the input's day. -/
def weeklySearch (ds : List Nat) (t after : Nat) : Nat → Nat → Option Nat
  | _, 0 => none
  | i, fuel + 1 =>
    if after < (after / 1440 + i) * 1440 + t ∧ weekdayOf (after / 1440 + i) ∈ ds then
      some ((after / 1440 + i) * 1440 + t)
    else weeklySearch ds t after (i + 1) fuel

/-- `nextLocalSlot`: the first minute strictly after `after` the schedule names. -/
def nextLocalSlot (s : Sched) (after : Nat) : Option Nat :=
  if s.valid = false then none else
  match s with
  | .once y m d t => if after < onceSlot y m d t then some (onceSlot y m d t) else none
  | .daily t =>
    if after < (after / 1440) * 1440 + t then some ((after / 1440) * 1440 + t)
    else some ((after / 1440) * 1440 + t + 1440)
  | .weekly ds t => weeklySearch ds t after 0 8
  | .monthly dd t =>
    if after < monthlyCand dd t (monthOf (after / 1440)) then
      some (monthlyCand dd t (monthOf (after / 1440)))
    else some (monthlyCand dd t (monthOf (after / 1440) + 1))

/-! ### Weekly search -/

theorem weeklySearch_some (ds : List Nat) (t a : Nat) :
    ∀ (fuel i x : Nat), weeklySearch ds t a i fuel = some x →
      ∃ j, i ≤ j ∧ x = (a / 1440 + j) * 1440 + t ∧ a < x ∧ weekdayOf (a / 1440 + j) ∈ ds ∧
        ∀ l, i ≤ l → l < j →
          ¬ (a < (a / 1440 + l) * 1440 + t ∧ weekdayOf (a / 1440 + l) ∈ ds) := by
  intro fuel
  induction fuel with
  | zero => intro i x h; simp [weeklySearch] at h
  | succ fuel ih =>
    intro i x h
    unfold weeklySearch at h
    by_cases hc : a < (a / 1440 + i) * 1440 + t ∧ weekdayOf (a / 1440 + i) ∈ ds
    · rw [ifPos hc] at h
      injection h with h
      refine ⟨i, Nat.le_refl _, h.symm, ?_, ?_, ?_⟩
      · rw [← h]; exact hc.1
      · exact hc.2
      · intro l h1 h2; omega
    · rw [ifNeg hc] at h
      obtain ⟨j, hj, hx, hax, hw, hmin⟩ := ih (i + 1) x h
      refine ⟨j, by omega, hx, hax, hw, ?_⟩
      intro l h1 h2
      by_cases hl : l = i
      · subst hl; exact hc
      · exact hmin l (by omega) h2

theorem weeklySearch_none (ds : List Nat) (t a : Nat) :
    ∀ (fuel i : Nat), weeklySearch ds t a i fuel = none →
      ∀ l, i ≤ l → l < i + fuel →
        ¬ (a < (a / 1440 + l) * 1440 + t ∧ weekdayOf (a / 1440 + l) ∈ ds) := by
  intro fuel
  induction fuel with
  | zero => intro i _ l h1 h2; omega
  | succ fuel ih =>
    intro i h l h1 h2
    unfold weeklySearch at h
    by_cases hc : a < (a / 1440 + i) * 1440 + t ∧ weekdayOf (a / 1440 + i) ∈ ds
    · rw [ifPos hc] at h; simp at h
    · rw [ifNeg hc] at h
      by_cases hl : l = i
      · subst hl; exact hc
      · exact ih (i + 1) h l (by omega) (by omega)

/-! ### Monthly candidates -/

theorem monthlyCand_bounds (dd t k : Nat) (hd : 1 ≤ dd) (ht : t < 1440) :
    monthStart k * 1440 ≤ monthlyCand dd t k ∧ monthlyCand dd t k < monthStart (k + 1) * 1440 := by
  have hl := monthLen_bounds k
  unfold monthlyCand
  rw [monthStart_succ]
  generalize monthStart k = S
  generalize monthLen k = L at hl ⊢
  have hm1 : 1 ≤ min dd L := by omega
  have hm2 : min dd L ≤ L := Nat.min_le_right dd L
  generalize min dd L = M at hm1 hm2 ⊢
  omega

theorem monthlyCand_strict (dd t : Nat) (hd : 1 ≤ dd) (ht : t < 1440) {k k' : Nat}
    (h : k < k') : monthlyCand dd t k < monthlyCand dd t k' := by
  have h1 := (monthlyCand_bounds dd t k hd ht).2
  have h2 := (monthlyCand_bounds dd t k' hd ht).1
  have h3 := Nat.mul_le_mul_right 1440 (monthStart_mono (show k + 1 ≤ k' by omega))
  omega

theorem monthlyCand_matches (dd t k : Nat) (hd : 1 ≤ dd) (ht : t < 1440) :
    (Sched.monthly dd t).matches (monthlyCand dd t k) := by
  have hl := monthLen_bounds k
  have hday : monthlyCand dd t k / 1440 = monthStart k + min dd (monthLen k) - 1 := by
    unfold monthlyCand; omega
  have hk : monthOf (monthlyCand dd t k / 1440) = k := by
    apply monthOf_unique
    · rw [hday]; omega
    · rw [hday, monthStart_succ]; omega
  show monthlyCand dd t k % 1440 = t ∧ _
  rw [hk, hday]
  refine ⟨?_, by omega⟩
  unfold monthlyCand; omega

/-- A minute a monthly schedule names is its month's candidate. -/
theorem monthly_matches_cand {dd t x : Nat}
    (hm : (Sched.monthly dd t).matches x) :
    x = monthlyCand dd t (monthOf (x / 1440)) := by
  have ⟨h1, h2⟩ := hm
  unfold monthlyCand
  omega

/-! ### The theorems -/

theorem valid_of_some {s : Sched} {a x : Nat} (h : nextLocalSlot s a = some x) :
    s.valid = true := by
  unfold nextLocalSlot at h
  by_cases hv : s.valid = false
  · rw [ifPos hv] at h; simp at h
  · simpa using hv

/-- **The slot is strictly after its input.** -/
theorem nextLocalSlot_gt (s : Sched) (a x : Nat) (h : nextLocalSlot s a = some x) : a < x := by
  have hv := valid_of_some h
  unfold nextLocalSlot at h
  rw [ifNeg (by simp [hv])] at h
  cases s with
  | once y m d t =>
    simp only at h
    by_cases hlt : a < onceSlot y m d t
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; simp at h
  | daily t =>
    simp only at h
    by_cases hlt : a < a / 1440 * 1440 + t
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; injection h with h; omega
  | weekly ds t =>
    obtain ⟨_, _, _, hax, _, _⟩ := weeklySearch_some ds t a 8 0 x h
    exact hax
  | monthly dd t =>
    simp [Sched.valid] at hv
    simp only at h
    by_cases hlt : a < monthlyCand dd t (monthOf (a / 1440))
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; injection h with h
      have hb := (monthlyCand_bounds dd t (monthOf (a / 1440) + 1) (by omega) (by omega)).1
      have hs := (monthOf_spec (a / 1440)).2
      have := Nat.mul_le_mul_right 1440 (show a / 1440 + 1 ≤ monthStart (monthOf (a / 1440) + 1) by omega)
      omega

/-- **The slot is a minute the schedule names.** -/
theorem nextLocalSlot_matches (s : Sched) (a x : Nat) (h : nextLocalSlot s a = some x) :
    s.matches x := by
  have hv := valid_of_some h
  unfold nextLocalSlot at h
  rw [ifNeg (by simp [hv])] at h
  cases s with
  | once y m d t =>
    simp only at h
    by_cases hlt : a < onceSlot y m d t
    · rw [ifPos hlt] at h; injection h with h; exact h.symm
    · rw [ifNeg hlt] at h; simp at h
  | daily t =>
    simp [Sched.valid] at hv
    simp only at h
    show x % 1440 = t
    by_cases hlt : a < a / 1440 * 1440 + t
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; injection h with h; omega
  | weekly ds t =>
    simp [Sched.valid] at hv
    obtain ⟨j, _, hx, _, hw, _⟩ := weeklySearch_some ds t a 8 0 x h
    have hday : x / 1440 = a / 1440 + j := by omega
    refine ⟨by omega, ?_⟩
    rw [hday]; exact hw
  | monthly dd t =>
    simp [Sched.valid] at hv
    simp only at h
    by_cases hlt : a < monthlyCand dd t (monthOf (a / 1440))
    · rw [ifPos hlt] at h; injection h with h; rw [← h]
      exact monthlyCand_matches dd t _ (by omega) (by omega)
    · rw [ifNeg hlt] at h; injection h with h; rw [← h]
      exact monthlyCand_matches dd t _ (by omega) (by omega)

/-- **Minimality: no named minute lies strictly between the input and the slot.** -/
theorem nextLocalSlot_minimal (s : Sched) (a x : Nat) (h : nextLocalSlot s a = some x) :
    ∀ y, a < y → y < x → ¬ s.matches y := by
  intro y hay hyx hm
  have hv := valid_of_some h
  unfold nextLocalSlot at h
  rw [ifNeg (by simp [hv])] at h
  cases s with
  | once y' m d t =>
    simp only at h
    have hy : y = onceSlot y' m d t := hm
    by_cases hlt : a < onceSlot y' m d t
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; simp at h
  | daily t =>
    simp [Sched.valid] at hv
    have hy : y % 1440 = t := hm
    simp only at h
    by_cases hlt : a < a / 1440 * 1440 + t
    · rw [ifPos hlt] at h; injection h with h; omega
    · rw [ifNeg hlt] at h; injection h with h; omega
  | weekly ds t =>
    simp [Sched.valid] at hv
    have ⟨hy1, hy2⟩ := hm
    obtain ⟨j, _, hx, _, _, hmin⟩ := weeklySearch_some ds t a 8 0 x h
    have hq : a / 1440 ≤ y / 1440 := Nat.div_le_div_right (by omega)
    have hl := hmin (y / 1440 - a / 1440) (Nat.zero_le _) (by omega)
    have hday : a / 1440 + (y / 1440 - a / 1440) = y / 1440 := by omega
    rw [hday] at hl
    exact hl ⟨by omega, hy2⟩
  | monthly dd t =>
    simp [Sched.valid] at hv
    have hd : 1 ≤ dd := by omega
    have ht : t < 1440 := by omega
    have hy := monthly_matches_cand hm
    have hk : monthOf (a / 1440) ≤ monthOf (y / 1440) :=
      monthOf_mono (Nat.div_le_div_right (by omega))
    simp only at h
    by_cases hlt : a < monthlyCand dd t (monthOf (a / 1440))
    · rw [ifPos hlt] at h; injection h with h
      by_cases heq : monthOf (y / 1440) = monthOf (a / 1440)
      · rw [heq] at hy; omega
      · have := monthlyCand_strict dd t hd ht (show monthOf (a / 1440) < monthOf (y / 1440) by omega)
        omega
    · rw [ifNeg hlt] at h; injection h with h
      by_cases heq : monthOf (y / 1440) = monthOf (a / 1440)
      · rw [heq] at hy; omega
      · by_cases heq2 : monthOf (y / 1440) = monthOf (a / 1440) + 1
        · rw [heq2] at hy; omega
        · have := monthlyCand_strict dd t hd ht
            (show monthOf (a / 1440) + 1 < monthOf (y / 1440) by omega)
          omega

/-- A weekday offset in `1..7` lands on any weekday `d < 7`. -/
theorem weekday_offset (q d : Nat) (hd : d < 7) :
    ∃ l, 1 ≤ l ∧ l ≤ 7 ∧ weekdayOf (q + l) = d := by
  unfold weekdayOf
  by_cases h0 : (d + 7 - (q + 4) % 7) % 7 = 0
  · exact ⟨7, by omega, by omega, by omega⟩
  · exact ⟨(d + 7 - (q + 4) % 7) % 7, by omega, by omega, by omega⟩

/-- **Daily, weekly and monthly schedules always have a next slot.** -/
theorem nextLocalSlot_recurring (s : Sched) (a : Nat) (hv : s.valid = true)
    (hr : ∀ y m d t, s ≠ .once y m d t) : ∃ x, nextLocalSlot s a = some x := by
  unfold nextLocalSlot
  rw [ifNeg (by simp [hv])]
  cases s with
  | once y m d t => exact absurd rfl (hr y m d t)
  | daily t =>
    simp only
    by_cases hlt : a < a / 1440 * 1440 + t
    · rw [ifPos hlt]; exact ⟨_, rfl⟩
    · rw [ifNeg hlt]; exact ⟨_, rfl⟩
  | weekly ds t =>
    simp [Sched.valid] at hv
    obtain ⟨⟨hne, hall⟩, _⟩ := hv
    match ds, hne, hall with
    | d :: rest, _, hall =>
      have hd : d < 7 := (hall d (List.mem_cons_self ..))
      obtain ⟨l, hl1, hl7, hw⟩ := weekday_offset (a / 1440) d hd
      show ∃ x, weeklySearch (d :: rest) t a 0 8 = some x
      cases hs : weeklySearch (d :: rest) t a 0 8 with
      | some x => exact ⟨x, rfl⟩
      | none =>
        have := weeklySearch_none (d :: rest) t a 8 0 hs l (Nat.zero_le _) (by omega)
        exact absurd ⟨by omega, by rw [hw]; exact List.mem_cons_self ..⟩ this
  | monthly dd t =>
    simp only
    by_cases hlt : a < monthlyCand dd t (monthOf (a / 1440))
    · rw [ifPos hlt]; exact ⟨_, rfl⟩
    · rw [ifNeg hlt]; exact ⟨_, rfl⟩

/-- A `once` whose minute is not after the input has no next slot. -/
theorem nextLocalSlot_once_passed (y m d t a : Nat) (h : onceSlot y m d t ≤ a) :
    nextLocalSlot (.once y m d t) a = none := by
  unfold nextLocalSlot
  by_cases hv : (Sched.once y m d t).valid = false
  · rw [ifPos hv]
  · rw [ifNeg hv]
    simp only
    rw [ifNeg (by omega)]

/-- **Completeness: a named minute after the input means a slot no later than it.**
    With `nextLocalSlot_matches` and `nextLocalSlot_minimal`, the slot is the
    least named minute after the input. -/
theorem nextLocalSlot_complete (s : Sched) (a y : Nat) (hv : s.valid = true) (hay : a < y)
    (hm : s.matches y) : ∃ x, nextLocalSlot s a = some x ∧ x ≤ y := by
  cases s with
  | once y' m d t =>
    have hy : y = onceSlot y' m d t := hm
    refine ⟨y, ?_, Nat.le_refl _⟩
    unfold nextLocalSlot
    rw [ifNeg (by simp [hv])]
    simp only
    rw [ifPos (by omega), hy]
  | daily t =>
    obtain ⟨x, hx⟩ := nextLocalSlot_recurring (.daily t) a hv (by intros; simp)
    refine ⟨x, hx, ?_⟩
    by_cases hle : x ≤ y
    · exact hle
    · exact absurd hm (nextLocalSlot_minimal _ a x hx y hay (by omega))
  | weekly ds t =>
    obtain ⟨x, hx⟩ := nextLocalSlot_recurring (.weekly ds t) a hv (by intros; simp)
    refine ⟨x, hx, ?_⟩
    by_cases hle : x ≤ y
    · exact hle
    · exact absurd hm (nextLocalSlot_minimal _ a x hx y hay (by omega))
  | monthly dd t =>
    obtain ⟨x, hx⟩ := nextLocalSlot_recurring (.monthly dd t) a hv (by intros; simp)
    refine ⟨x, hx, ?_⟩
    by_cases hle : x ≤ y
    · exact hle
    · exact absurd hm (nextLocalSlot_minimal _ a x hx y hay (by omega))

/-! ## The tick -/

inductive Status where
  | active
  | paused
  | completed
  deriving Repr, DecidableEq

/-- The task fields the tick reads. -/
structure TaskT where
  status : Status
  nextRunAt : Option Nat
  hasUnfinishedRun : Bool
  deriving Repr

inductive Tick where
  | idle
  | wait
  | fire (slot : Nat) (next : Option Nat) (status : Status)
  deriving Repr, DecidableEq

/-- `decideTaskTick`: `nextAfter` is the schedule's next instant after its argument. -/
def decideTaskTick (task : TaskT) (now : Nat) (nextAfter : Nat → Option Nat) : Tick :=
  match task.status, task.nextRunAt with
  | .active, some n =>
    if now < n then .idle
    else if task.hasUnfinishedRun then .wait
    else
      let next : Option Nat :=
        match nextAfter now with
        | some x => if now < x then some x else none
        | none => none
      .fire n next (if next.isSome then .active else .completed)
  | _, _ => .idle

/-- **A fire needs an active, due task without an unfinished run.** -/
theorem tick_fire_requires (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s : Nat)
    (nx : Option Nat) (st : Status) (h : decideTaskTick task now f = .fire s nx st) :
    task.status = .active ∧ task.nextRunAt = some s ∧ s ≤ now ∧
      task.hasUnfinishedRun = false := by
  unfold decideTaskTick at h
  match hs : task.status, hn : task.nextRunAt with
  | .active, some n =>
    rw [hs, hn] at h
    simp only at h
    by_cases hlt : now < n
    · rw [ifPos hlt] at h; simp at h
    · rw [ifNeg hlt] at h
      by_cases hu : task.hasUnfinishedRun = true
      · rw [ifPos hu] at h; simp at h
      · rw [ifNeg hu] at h
        simp only [Tick.fire.injEq] at h
        exact ⟨rfl, by rw [h.1], by omega, by simpa using hu⟩
  | .paused, _ => rw [hs] at h; simp at h
  | .completed, _ => rw [hs] at h; simp at h
  | .active, none => rw [hs, hn] at h; simp at h

/-- The `next` a fire stores, in closed form. -/
theorem tick_fire_next (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s : Nat)
    (nx : Option Nat) (st : Status) (h : decideTaskTick task now f = .fire s nx st) :
    nx = (match f now with
      | some x => if now < x then some x else none
      | none => none) ∧ st = (if nx.isSome then .active else .completed) := by
  unfold decideTaskTick at h
  match hs : task.status, hn : task.nextRunAt with
  | .active, some n =>
    rw [hs, hn] at h
    simp only at h
    by_cases hlt : now < n
    · rw [ifPos hlt] at h; simp at h
    · rw [ifNeg hlt] at h
      by_cases hu : task.hasUnfinishedRun = true
      · rw [ifPos hu] at h; simp at h
      · rw [ifNeg hu] at h
        simp only [Tick.fire.injEq] at h
        obtain ⟨_, h2, h3⟩ := h
        exact ⟨h2.symm, by rw [← h3, ← h2]⟩
  | .paused, _ => rw [hs] at h; simp at h
  | .completed, _ => rw [hs] at h; simp at h
  | .active, none => rw [hs, hn] at h; simp at h

/-- **A fire's next run is strictly after now, and the task stays active.** -/
theorem tick_fire_next_gt (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s x : Nat)
    (st : Status) (h : decideTaskTick task now f = .fire s (some x) st) :
    now < x ∧ st = .active := by
  obtain ⟨hn, hst⟩ := tick_fire_next task now f s (some x) st h
  refine ⟨?_, by simpa using hst⟩
  revert hn
  cases f now with
  | none => simp
  | some y =>
    simp only
    by_cases hy : now < y
    · rw [ifPos hy]; intro e; injection e with e; omega
    · rw [ifNeg hy]; simp

/-- **A fire without a next run completes the task.** -/
theorem tick_fire_next_none (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s : Nat)
    (st : Status) (h : decideTaskTick task now f = .fire s none st) : st = .completed := by
  obtain ⟨_, hst⟩ := tick_fire_next task now f s none st h
  simpa using hst

/-- **The next run is the schedule function's answer whenever that is after now.** -/
theorem tick_fire_takes_next (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s x : Nat)
    (nx : Option Nat) (st : Status) (hf : f now = some x) (hx : now < x)
    (h : decideTaskTick task now f = .fire s nx st) : nx = some x := by
  obtain ⟨hn, _⟩ := tick_fire_next task now f s nx st h
  rw [hn, hf]
  simp only
  rw [ifPos hx]

/-- **After a fire, the stored task ticks idle at every instant before its next run**
    (and forever once completed): the slot never fires twice, and every slot
    missed up to `now` is folded into this one run. -/
theorem tick_after_fire_idle (task : TaskT) (now : Nat) (f : Nat → Option Nat) (s : Nat)
    (nx : Option Nat) (st : Status) (h : decideTaskTick task now f = .fire s nx st)
    (unfinished : Bool) (later : Nat) (hlater : ∀ x, nx = some x → later < x) :
    decideTaskTick { status := st, nextRunAt := nx, hasUnfinishedRun := unfinished } later f
      = .idle := by
  unfold decideTaskTick
  cases nx with
  | none =>
    have := tick_fire_next_none task now f s st h
    subst this
    rfl
  | some x =>
    have ⟨_, hst⟩ := tick_fire_next_gt task now f s x st h
    subst hst
    simp only
    rw [ifPos (hlater x rfl)]

/-! ### The tick bound to a schedule (local minutes) -/

/-- **Missed slots coalesce: after a fire, no named minute lies between now and
    the next run**, which is itself named. -/
theorem tick_fire_coalesces (sc : Sched) (task : TaskT) (now s x : Nat) (st : Status)
    (h : decideTaskTick task now (nextLocalSlot sc) = .fire s (some x) st) :
    now < x ∧ sc.matches x ∧ ∀ y, now < y → y < x → ¬ sc.matches y := by
  obtain ⟨hn, _⟩ := tick_fire_next task now _ s (some x) st h
  have hsome : nextLocalSlot sc now = some x := by
    revert hn
    cases hf : nextLocalSlot sc now with
    | none => simp
    | some y =>
      simp only
      by_cases hy : now < y
      · rw [ifPos hy]; intro e; injection e with e; rw [e]
      · rw [ifNeg hy]; simp
  exact ⟨nextLocalSlot_gt sc now x hsome, nextLocalSlot_matches sc now x hsome,
    nextLocalSlot_minimal sc now x hsome⟩

/-- **A `once` task completes when it fires.** Its stored next run is its own
    minute, so firing means that minute has passed. -/
theorem tick_once_completes (yy m d t : Nat) (task : TaskT) (now s : Nat) (nx : Option Nat)
    (st : Status) (hnext : task.nextRunAt = some (onceSlot yy m d t))
    (h : decideTaskTick task now (nextLocalSlot (.once yy m d t)) = .fire s nx st) :
    nx = none ∧ st = .completed := by
  obtain ⟨_, hs, hle, _⟩ := tick_fire_requires task now _ s nx st h
  rw [hnext] at hs
  injection hs with hs
  have hnone := nextLocalSlot_once_passed yy m d t now (by omega)
  obtain ⟨hn, hst⟩ := tick_fire_next task now _ s nx st h
  rw [hnone] at hn
  simp only at hn
  rw [hn] at hst
  exact ⟨hn, by simpa using hst⟩

/-- **A recurring task stays active when it fires, with a next run after now.** -/
theorem tick_recurring_stays_active (sc : Sched) (hv : sc.valid = true)
    (hr : ∀ y m d t, sc ≠ .once y m d t) (task : TaskT) (now s : Nat) (nx : Option Nat)
    (st : Status) (h : decideTaskTick task now (nextLocalSlot sc) = .fire s nx st) :
    st = .active ∧ ∃ x, nx = some x ∧ now < x := by
  obtain ⟨x, hx⟩ := nextLocalSlot_recurring sc now hv hr
  have hgt := nextLocalSlot_gt sc now x hx
  have hnx := tick_fire_takes_next task now _ s x nx st hx hgt h
  subst hnx
  exact ⟨(tick_fire_next_gt task now _ s x st h).2, x, rfl, hgt⟩

end Schedule
end Research
