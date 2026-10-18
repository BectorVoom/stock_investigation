import ResearchFormal.Basic

/-!
# Request-start spacing (ADR-0030 C2)

Formal model of `Ledger` and `await_slot` in
`crates/research-tools/src/search.rs`, which space GDELT request starts (5 s)
and per-host `web.fetch_page` starts (1 s).

The algorithm is *reserve-at-send*: nothing is reserved while a caller waits.
A caller that is allowed to send atomically (under the ledger lock) records
exactly the instant `now` it decided on, and a caller that is cancelled, or
that finds the window closed, records nothing, so no restore step exists.

Assumptions, stated where the code relies on them:
* Waiters are served first come, first served (only the head of a ticket
  queue may claim). That only RESTRICTS which `claim` can happen next, so the
  theorem, which quantifies over every interleaving, covers it; the queue is
  what prevents starvation, which is not a safety property and is tested.
* One key. The Rust ledger forgets the oldest keys beyond its capacity (200
  hosts, the TypeScript maps' FIFO bound), so the guarantee holds for every
  remembered key; a key forgotten after more than 200 other hosts were started
  is treated as new. The model has unbounded memory.

* `claim now` — the caller read `now` and asks to send. It sends (and records
  `now`) exactly when `now` is at least `interval` after the last recorded
  start; otherwise it must wait and ask again.
* `note t` — a request that ended on another URL of a host: the recorded
  start becomes `max(existing, t)`; it can never move backwards.
* `abort` — a cancelled caller: no effect.

Keys (hosts) are independent ledgers, so one key is modelled. The model is
over unbounded integers; Rust uses saturating `i64`, equal for every valid
Date millisecond. Reads of `now` may arrive in any order (a caller reads the
clock outside the lock and may be descheduled), and the theorem still holds.

Main theorem (`run_spaced`): after ANY interleaving of claims, notes and
aborts, any two recorded request starts are at least `interval` apart.
-/

namespace Research

/-- Earliest instant a caller that read `now` may start. -/
def reserveSlot (now : Int) (last : Option Int) (interval : Int) : Int :=
  match last with
  | none => now
  | some l => max now (l + interval)

/-- Ledger state: the latest recorded start and every recorded start, newest first. -/
structure SpacingState where
  last : Option Int
  starts : List Int

inductive SpacingOp where
  | claim (now : Int)
  | note (t : Int)
  | abort

/-- One operation under the ledger lock. -/
def spacingStep (interval : Int) (s : SpacingState) : SpacingOp → SpacingState
  | .claim now =>
    if reserveSlot now s.last interval ≤ now then ⟨some now, now :: s.starts⟩ else s
  | .note t =>
    ⟨some (match s.last with
      | none => t
      | some l => max l t), s.starts⟩
  | .abort => s

def spacingRun (interval : Int) (ops : List SpacingOp) : SpacingState :=
  ops.foldl (spacingStep interval) ⟨none, []⟩

/-- Starts are pairwise `interval` apart (newest first), and every recorded
start is at most the latest recorded one. -/
def SpacingInv (interval : Int) (s : SpacingState) : Prop :=
  List.Pairwise (fun a b => b + interval ≤ a) s.starts ∧
    ∀ x, x ∈ s.starts → ∃ l, s.last = some l ∧ x ≤ l

theorem spacing_init (interval : Int) : SpacingInv interval ⟨none, []⟩ := by
  refine ⟨List.Pairwise.nil, ?_⟩
  intro x hx
  simp at hx

theorem spacing_step (interval : Int) (hi : 0 ≤ interval) (s : SpacingState)
    (h : SpacingInv interval s) (op : SpacingOp) :
    SpacingInv interval (spacingStep interval s op) := by
  obtain ⟨hp, hl⟩ := h
  cases op with
  | abort => exact ⟨hp, hl⟩
  | note t =>
    refine ⟨hp, ?_⟩
    intro x hx
    obtain ⟨l, hlast, hxl⟩ := hl x hx
    refine ⟨max l t, ?_, ?_⟩
    · simp [spacingStep, hlast]
    · omega
  | claim now =>
    by_cases hc : reserveSlot now s.last interval ≤ now
    · simp only [spacingStep, hc, ite_true]
      cases hlast : s.last with
      | none =>
        have hnil : s.starts = [] := by
          cases hs : s.starts with
          | nil => rfl
          | cons y ys =>
            obtain ⟨l, hl', _⟩ := hl y (by simp [hs])
            rw [hlast] at hl'
            cases hl'
        refine ⟨?_, ?_⟩
        · rw [hnil]; simp
        · intro x hx
          rw [hnil] at hx
          simp at hx
          exact ⟨now, rfl, by omega⟩
      | some l =>
        have hle : l + interval ≤ now := by
          have : max now (l + interval) ≤ now := by
            simpa [reserveSlot, hlast] using hc
          omega
        refine ⟨?_, ?_⟩
        · rw [List.pairwise_cons]
          refine ⟨?_, hp⟩
          intro b hb
          obtain ⟨l', hl', hbl⟩ := hl b hb
          rw [hlast] at hl'
          cases hl'
          omega
        · intro x hx
          refine ⟨now, rfl, ?_⟩
          rcases List.mem_cons.mp hx with hx | hx
          · omega
          · obtain ⟨l', hl', hxl⟩ := hl x hx
            rw [hlast] at hl'
            cases hl'
            omega
    · simp only [spacingStep, hc, ite_false]
      exact ⟨hp, hl⟩

theorem spacing_fold (interval : Int) (hi : 0 ≤ interval) (ops : List SpacingOp) :
    ∀ s : SpacingState, SpacingInv interval s →
      SpacingInv interval (ops.foldl (spacingStep interval) s) := by
  induction ops with
  | nil => intro s h; exact h
  | cons op rest ih =>
    intro s h
    exact ih _ (spacing_step interval hi s h op)

/-- After any interleaving of claims, notes and aborts, any two recorded
request starts are at least `interval` apart. -/
theorem run_spaced (interval : Int) (hi : 0 ≤ interval) (ops : List SpacingOp) :
    List.Pairwise (fun a b => b + interval ≤ a) (spacingRun interval ops).starts :=
  (spacing_fold interval hi ops ⟨none, []⟩ (spacing_init interval)).1

/-- A caller that is never allowed to send (every `claim` finds the window
closed, or the caller aborts) leaves the ledger untouched. -/
theorem abort_records_nothing (interval : Int) (s : SpacingState) :
    spacingStep interval s .abort = s := rfl

/-- A claim that is refused changes nothing, so a caller that gives up while
waiting needs no undo. -/
theorem refused_claim_records_nothing (interval now : Int) (s : SpacingState)
    (h : ¬ reserveSlot now s.last interval ≤ now) :
    spacingStep interval s (.claim now) = s := by
  simp [spacingStep, h]

end Research
