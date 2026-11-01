import ResearchFormal.Basic

/-!
# Server-side sync schedule (ADR-0051)

Formal model of `decideSync` and `marketSyncIntervalMs` in
`packages/domain/src/market/syncSchedule.ts`.

Instants are integers (epoch ms in the TypeScript). "No job yet" is
`none`, which every waiting time satisfies (the TypeScript's
`Number.POSITIVE_INFINITY`).

Proved below, for every state and every cadence with
`minGap ≤ retry` and `minGap ≤ interval` (`Cadence.valid`):

* `idle_when_active`, `idle_when_empty` — nothing is queued while a job of
  the kind is active, or when nothing is tracked;
* `queue_min_gap` — every queue is at least `minGap` after the last job of
  any scope: no loop, whatever the stored stamps say;
* `full_spacing` — a full sync is at least `min interval retry` after the
  last full one, and `full_after_failure` — at least `retry` after a full
  one that did not complete;
* `unrefreshed_after_failure` — a narrow job after a job that did not
  complete waits at least `retry`;
* liveness: `stale_queues_all` — stale data whose last full sync is
  `max interval retry` old (and the last job `minGap` old) gets a full sync;
  `new_items_queue` — a never-refreshed item gets a job once the last job is
  `max retry minGap` old; `retryable_queue` — a failed item gets one once the
  last job is `retry` old;
* the interval: `interval_ge_base` — never below 30 minutes, and
  `interval_fits_budget` — `count` series fetched once per interval stay
  within the daily request budget (`count · day ≤ budget · interval`).
-/

namespace Research
namespace SyncSchedule

structure Job where
  createdAt : Int
  completed : Bool

structure State where
  activeJob : Bool
  items : Nat
  neverRefreshed : Nat
  retryable : Nat
  oldestRefresh : Option Int
  lastJob : Option Job
  lastFullJob : Option Job

structure Cadence where
  interval : Nat
  retry : Nat
  minGap : Nat

def Cadence.valid (c : Cadence) : Prop := c.minGap ≤ c.retry ∧ c.minGap ≤ c.interval

inductive Scope where
  | all
  | unrefreshed
  deriving DecidableEq, Repr

inductive Reason where
  | stale
  | newItems
  | retry
  deriving DecidableEq, Repr

inductive Decision where
  | idle
  | queue (scope : Scope) (reason : Reason)
  deriving DecidableEq, Repr

/-- At least `d` has passed since the job was created (always, without a job). -/
def sinceAtLeast (job : Option Job) (now : Int) (d : Nat) : Bool :=
  match job with
  | none => true
  | some j => decide ((d : Int) ≤ now - j.createdAt)

/-- The job did not end `completed`. -/
def failedJob : Option Job → Bool
  | none => false
  | some j => !j.completed

/-- The oldest refresh stamp is at least `interval` old. -/
def isStale (s : State) (c : Cadence) (now : Int) : Bool :=
  match s.oldestRefresh with
  | none => false
  | some t => decide ((c.interval : Int) ≤ now - t)

def fullWait (s : State) (c : Cadence) : Nat :=
  if failedJob s.lastFullJob then c.retry else c.interval

def newWait (s : State) (c : Cadence) : Nat :=
  if failedJob s.lastJob then c.retry else c.minGap

def decideSync (s : State) (c : Cadence) (now : Int) : Decision :=
  if s.activeJob || s.items == 0 then .idle
  else if isStale s c now && sinceAtLeast s.lastJob now c.minGap &&
      sinceAtLeast s.lastFullJob now (fullWait s c) then .queue .all .stale
  else if 0 < s.neverRefreshed && sinceAtLeast s.lastJob now (newWait s c) then
    .queue .unrefreshed .newItems
  else if 0 < s.retryable && sinceAtLeast s.lastJob now c.retry then .queue .unrefreshed .retry
  else .idle

/-! ## Waiting times -/

theorem sinceAtLeast_mono (job : Option Job) (now : Int) {a b : Nat} (hab : a ≤ b)
    (h : sinceAtLeast job now b = true) : sinceAtLeast job now a = true := by
  cases job with
  | none => rfl
  | some j =>
    simp only [sinceAtLeast, decide_eq_true_eq] at h ⊢
    omega

theorem sinceAtLeast_of_max_left (job : Option Job) (now : Int) (a b : Nat)
    (h : sinceAtLeast job now (max a b) = true) : sinceAtLeast job now a = true :=
  sinceAtLeast_mono job now (Nat.le_max_left a b) h

theorem sinceAtLeast_of_max_right (job : Option Job) (now : Int) (a b : Nat)
    (h : sinceAtLeast job now (max a b) = true) : sinceAtLeast job now b = true :=
  sinceAtLeast_mono job now (Nat.le_max_right a b) h

theorem fullWait_le_max (s : State) (c : Cadence) : fullWait s c ≤ max c.interval c.retry := by
  unfold fullWait
  split <;> omega

theorem min_le_fullWait (s : State) (c : Cadence) : min c.interval c.retry ≤ fullWait s c := by
  unfold fullWait
  split <;> omega

theorem newWait_le_max (s : State) (c : Cadence) : newWait s c ≤ max c.retry c.minGap := by
  unfold newWait
  split <;> omega

theorem minGap_le_newWait (s : State) (c : Cadence) (hc : c.valid) : c.minGap ≤ newWait s c := by
  unfold newWait
  have := hc.1
  split <;> omega

/-! ## Safety -/

theorem idle_when_active (s : State) (c : Cadence) (now : Int) (h : s.activeJob = true) :
    decideSync s c now = .idle := by
  simp [decideSync, h]

theorem idle_when_empty (s : State) (c : Cadence) (now : Int) (h : s.items = 0) :
    decideSync s c now = .idle := by
  simp [decideSync, h]

/-- What a queue decision implies about the state, branch by branch. -/
theorem queue_cases (s : State) (c : Cadence) (now : Int) (sc : Scope) (r : Reason)
    (h : decideSync s c now = .queue sc r) :
    s.activeJob = false ∧ s.items ≠ 0 ∧
    ((sc = .all ∧ r = .stale ∧ isStale s c now = true ∧
        sinceAtLeast s.lastJob now c.minGap = true ∧
        sinceAtLeast s.lastFullJob now (fullWait s c) = true) ∨
      (sc = .unrefreshed ∧ r = .newItems ∧ 0 < s.neverRefreshed ∧
        sinceAtLeast s.lastJob now (newWait s c) = true) ∨
      (sc = .unrefreshed ∧ r = .retry ∧ 0 < s.retryable ∧
        sinceAtLeast s.lastJob now c.retry = true)) := by
  unfold decideSync at h
  by_cases ha : (s.activeJob || s.items == 0) = true
  · rw [ifPos ha] at h; cases h
  rw [ifNeg ha] at h
  have hb : s.activeJob = false ∧ s.items ≠ 0 := by
    simp only [Bool.or_eq_true, beq_iff_eq, not_or] at ha
    exact ⟨by simpa using ha.1, ha.2⟩
  refine ⟨hb.1, hb.2, ?_⟩
  by_cases h1 : (isStale s c now && sinceAtLeast s.lastJob now c.minGap &&
      sinceAtLeast s.lastFullJob now (fullWait s c)) = true
  · rw [ifPos h1] at h
    cases h
    simp only [Bool.and_eq_true] at h1
    exact Or.inl ⟨rfl, rfl, h1.1.1, h1.1.2, h1.2⟩
  rw [ifNeg h1] at h
  by_cases h2 : (0 < s.neverRefreshed && sinceAtLeast s.lastJob now (newWait s c)) = true
  · rw [ifPos h2] at h
    cases h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h2
    exact Or.inr (Or.inl ⟨rfl, rfl, h2.1, h2.2⟩)
  rw [ifNeg h2] at h
  by_cases h3 : (0 < s.retryable && sinceAtLeast s.lastJob now c.retry) = true
  · rw [ifPos h3] at h
    cases h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h3
    exact Or.inr (Or.inr ⟨rfl, rfl, h3.1, h3.2⟩)
  rw [ifNeg h3] at h
  cases h

/-- Every queue is at least `minGap` after the last job: no loop. -/
theorem queue_min_gap (s : State) (c : Cadence) (now : Int) (hc : c.valid) (sc : Scope)
    (r : Reason) (h : decideSync s c now = .queue sc r) :
    sinceAtLeast s.lastJob now c.minGap = true := by
  rcases (queue_cases s c now sc r h).2.2 with ⟨_, _, _, hg, _⟩ | ⟨_, _, _, hw⟩ | ⟨_, _, _, hr⟩
  · exact hg
  · exact sinceAtLeast_mono _ _ (minGap_le_newWait s c hc) hw
  · exact sinceAtLeast_mono _ _ hc.1 hr

/-- Full syncs are at least `min interval retry` apart. -/
theorem full_spacing (s : State) (c : Cadence) (now : Int) (r : Reason)
    (h : decideSync s c now = .queue .all r) :
    sinceAtLeast s.lastFullJob now (min c.interval c.retry) = true := by
  rcases (queue_cases s c now .all r h).2.2 with ⟨_, _, _, _, hf⟩ | ⟨hs, _⟩ | ⟨hs, _⟩
  · exact sinceAtLeast_mono _ _ (min_le_fullWait s c) hf
  · cases hs
  · cases hs

/-- A full sync after a full one that did not complete waits at least `retry`. -/
theorem full_after_failure (s : State) (c : Cadence) (now : Int) (r : Reason)
    (hf : failedJob s.lastFullJob = true) (h : decideSync s c now = .queue .all r) :
    sinceAtLeast s.lastFullJob now c.retry = true := by
  rcases (queue_cases s c now .all r h).2.2 with ⟨_, _, _, _, hw⟩ | ⟨hs, _⟩ | ⟨hs, _⟩
  · simpa [fullWait, hf] using hw
  · cases hs
  · cases hs

/-- A narrow job after a job that did not complete waits at least `retry`. -/
theorem unrefreshed_after_failure (s : State) (c : Cadence) (now : Int) (r : Reason)
    (hf : failedJob s.lastJob = true) (h : decideSync s c now = .queue .unrefreshed r) :
    sinceAtLeast s.lastJob now c.retry = true := by
  rcases (queue_cases s c now .unrefreshed r h).2.2 with ⟨hs, _⟩ | ⟨_, _, _, hw⟩ | ⟨_, _, _, hr⟩
  · cases hs
  · simpa [newWait, hf] using hw
  · exact hr

/-! ## Liveness -/

theorem stale_queues_all (s : State) (c : Cadence) (now : Int) (ha : s.activeJob = false)
    (hi : s.items ≠ 0) (hs : isStale s c now = true)
    (hg : sinceAtLeast s.lastJob now c.minGap = true)
    (hf : sinceAtLeast s.lastFullJob now (max c.interval c.retry) = true) :
    decideSync s c now = .queue .all .stale := by
  have hw := sinceAtLeast_mono _ _ (fullWait_le_max s c) hf
  simp [decideSync, ha, hi, hs, hg, hw]

theorem new_items_queue (s : State) (c : Cadence) (now : Int) (ha : s.activeJob = false)
    (hi : s.items ≠ 0) (hn : 0 < s.neverRefreshed)
    (hg : sinceAtLeast s.lastJob now (max c.retry c.minGap) = true) :
    ∃ sc r, decideSync s c now = .queue sc r := by
  have hw := sinceAtLeast_mono _ _ (newWait_le_max s c) hg
  unfold decideSync
  simp only [ha, hi, Bool.false_or, beq_iff_eq, ite_false]
  split
  · exact ⟨_, _, rfl⟩
  · simp [hn, hw]

theorem retryable_queue (s : State) (c : Cadence) (now : Int) (ha : s.activeJob = false)
    (hi : s.items ≠ 0) (hr : 0 < s.retryable)
    (hg : sinceAtLeast s.lastJob now (max c.retry c.minGap) = true) :
    ∃ sc r, decideSync s c now = .queue sc r := by
  have hw := sinceAtLeast_of_max_left _ _ _ _ hg
  unfold decideSync
  simp only [ha, hi, Bool.false_or, beq_iff_eq, ite_false]
  split
  · exact ⟨_, _, rfl⟩
  · split
    · exact ⟨_, _, rfl⟩
    · simp [hr, hw]

/-! ## The market interval -/

def baseInterval : Nat := 1800000
def dayMs : Nat := 86400000
def twelveDataBudget : Nat := 600

/-- `max(30 min, ⌈day · count / budget⌉)`. -/
def marketInterval (count : Nat) : Nat :=
  max baseInterval ((dayMs * count + twelveDataBudget - 1) / twelveDataBudget)

theorem interval_ge_base (count : Nat) : baseInterval ≤ marketInterval count :=
  Nat.le_max_left _ _

theorem interval_fits_budget (count : Nat) :
    count * dayMs ≤ twelveDataBudget * marketInterval count := by
  unfold marketInterval baseInterval dayMs twelveDataBudget
  have := Nat.le_max_right 1800000 ((86400000 * count + 600 - 1) / 600)
  omega

end SyncSchedule
end Research
