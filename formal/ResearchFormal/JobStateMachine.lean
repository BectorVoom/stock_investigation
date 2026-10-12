/-!
# Research job state machine

Formal model of `JOB_TRANSITIONS` in `packages/domain/src/jobs/stateMachine.ts`
(architecture section 6.3, rule ARCH-015).

The model is tied to the TypeScript implementation by conformance vectors: the
`export-vectors` executable prints this exact transition table, and
`tests/formal/conformance.test.ts` checks the TypeScript matrix against it.
-/

namespace Research

inductive JobState where
  | pending | claimed | planning | collecting | analyzing | verifying | publishing
  | completed | failed | cancelled | partialOutcome | waitingApproval
  deriving DecidableEq, Repr

namespace JobState

/-- Every state, in the order of `JOB_STATES`. -/
def all : List JobState :=
  [pending, claimed, planning, collecting, analyzing, verifying, publishing,
   completed, failed, cancelled, partialOutcome, waitingApproval]

/-- The legal successors of a state. -/
def next : JobState → List JobState
  | pending => [claimed, cancelled, failed]
  | claimed => [planning, pending, waitingApproval, failed, cancelled]
  | planning => [collecting, pending, waitingApproval, failed, cancelled]
  | collecting => [analyzing, pending, waitingApproval, partialOutcome, failed, cancelled]
  | analyzing => [verifying, pending, waitingApproval, partialOutcome, failed, cancelled]
  | verifying => [publishing, pending, waitingApproval, partialOutcome, failed, cancelled]
  | publishing => [completed, pending, partialOutcome, failed, cancelled]
  | waitingApproval => [pending, cancelled, failed]
  | completed => []
  | failed => []
  | cancelled => []
  | partialOutcome => []

def isTerminal : JobState → Bool
  | completed | failed | cancelled | partialOutcome => true
  | _ => false

/-- States in which a runner holds a lease. -/
def isLeased : JobState → Bool
  | claimed | planning | collecting | analyzing | verifying | publishing => true
  | _ => false

/-- `canStep a b` holds exactly when `a → b` is a legal transition. -/
def canStep (a b : JobState) : Bool := (next a).contains b

theorem mem_all (s : JobState) : s ∈ all := by
  cases s <;> decide

/-- Terminal states are exactly the states with no successor. -/
theorem terminal_iff_no_successor (s : JobState) : s.isTerminal = true ↔ next s = [] := by
  cases s <;> decide

/-- A terminal state is absorbing: no transition leaves it. -/
theorem terminal_is_absorbing (s t : JobState) (h : s.isTerminal = true) : canStep s t = false := by
  have hnext : next s = [] := (terminal_iff_no_successor s).mp h
  simp [canStep, hnext]

/-- No state transitions to itself, so every accepted transition is real progress. -/
theorem no_self_transition (s : JobState) : canStep s s = false := by
  cases s <;> decide

/-- No state is both leased and terminal. -/
theorem leased_not_terminal (s : JobState) (h : s.isLeased = true) : s.isTerminal = false := by
  cases s <;> first | rfl | exact absurd h (by decide)

/--
Lease recovery (section 5.3): from every leased state the job can return to
`pending`, so a job whose runner disappeared always becomes eligible again.
-/
theorem leased_can_requeue (s : JobState) (h : s.isLeased = true) : canStep s pending = true := by
  cases s <;> first | decide | exact absurd h (by decide)

/-- A leased job can always be cancelled and can always be failed. -/
theorem leased_can_cancel (s : JobState) (h : s.isLeased = true) : canStep s cancelled = true := by
  cases s <;> first | decide | exact absurd h (by decide)

theorem leased_can_fail (s : JobState) (h : s.isLeased = true) : canStep s failed = true := by
  cases s <;> first | decide | exact absurd h (by decide)

/-- Every non-terminal state has a way to stop: no job can be stuck forever. -/
theorem nonterminal_can_fail (s : JobState) (h : s.isTerminal = false) : canStep s failed = true := by
  cases s <;> first | decide | exact absurd h (by decide)

/-- The documented happy path is legal, step by step. -/
theorem happy_path :
    canStep pending claimed = true ∧ canStep claimed planning = true ∧
    canStep planning collecting = true ∧ canStep collecting analyzing = true ∧
    canStep analyzing verifying = true ∧ canStep verifying publishing = true ∧
    canStep publishing completed = true := by
  decide

/-- `completed` is reachable only from `publishing`: nothing skips verification. -/
theorem completed_only_from_publishing (s : JobState) (h : canStep s completed = true) :
    s = publishing := by
  cases s <;> first | rfl | exact absurd h (by decide)

/-- `publishing` is reachable only from `verifying`. -/
theorem publishing_only_from_verifying (s : JobState) (h : canStep s publishing = true) :
    s = verifying := by
  cases s <;> first | rfl | exact absurd h (by decide)

/-- A lease can only begin from `pending`. -/
theorem claimed_only_from_pending (s : JobState) (h : canStep s claimed = true) : s = pending := by
  cases s <;> first | rfl | exact absurd h (by decide)

/-- `partial` requires that collection has at least started. -/
theorem partial_requires_collection (s : JobState) (h : canStep s partialOutcome = true) :
    s = collecting ∨ s = analyzing ∨ s = verifying ∨ s = publishing := by
  cases s <;> first | decide | exact absurd h (by decide)

/--
A run can pause for the owner's approval only from a stage in which it can
spend (claimed through verifying): never from `publishing`, which makes no
model call, and never from a finished state.
-/
theorem approval_only_from_spending_stage (s : JobState) (h : canStep s waitingApproval = true) :
    s = claimed ∨ s = planning ∨ s = collecting ∨ s = analyzing ∨ s = verifying := by
  cases s <;> first | decide | exact absurd h (by decide)

/-- A run waiting for approval resumes only through the queue; it never jumps back mid-pipeline. -/
theorem approval_resumes_through_pending (t : JobState) (h : canStep waitingApproval t = true) :
    t = pending ∨ t = cancelled ∨ t = failed := by
  cases t <;> first | decide | exact absurd h (by decide)

/-- Only leased states and `pending`/`waitingApproval` have successors at all. -/
theorem only_open_states_progress (s t : JobState) (h : canStep s t = true) :
    s.isLeased = true ∨ s = pending ∨ s = waitingApproval := by
  cases s <;> first | decide | (cases t <;> exact absurd h (by decide))

/-- A sequence of legal transitions. -/
inductive Path : JobState → JobState → Prop where
  | refl (s : JobState) : Path s s
  | step {a b c : JobState} (h : canStep a b = true) (rest : Path b c) : Path a c

/--
Once terminal, always the same state: no sequence of transitions changes a
finished job. This is why a duplicate or late completion cannot alter it.
-/
theorem terminal_is_final {a b : JobState} (ht : a.isTerminal = true) (p : Path a b) : b = a := by
  cases p with
  | refl => rfl
  | @step _ mid _ h _ =>
    have hfalse : canStep a mid = false := terminal_is_absorbing a mid ht
    rw [hfalse] at h
    exact absurd h (by decide)

/-- From every state some terminal state is reachable. -/
theorem can_always_finish (s : JobState) : ∃ t, t.isTerminal = true ∧ Path s t := by
  cases hs : s.isTerminal with
  | true => exact ⟨s, hs, Path.refl s⟩
  | false => exact ⟨failed, rfl, Path.step (nonterminal_can_fail s hs) (Path.refl failed)⟩

end JobState
end Research
