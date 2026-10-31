import ResearchFormal

/-!
# Conformance vectors

Prints, as JSON, the outputs of the verified models over exhaustive small
grids. `tests/formal/conformance.test.ts` replays every vector against the
TypeScript implementation, which ties the proofs (about these models) to the
code that actually runs. Regenerate with:

    lake exe export-vectors > vectors.json
-/

open Research

def JobState.name : JobState → String
  | .pending => "pending"
  | .claimed => "claimed"
  | .planning => "planning"
  | .collecting => "collecting"
  | .analyzing => "analyzing"
  | .verifying => "verifying"
  | .publishing => "publishing"
  | .completed => "completed"
  | .failed => "failed"
  | .cancelled => "cancelled"
  | .partialOutcome => "partial"
  | .waitingApproval => "waiting_approval"

def jsonStr (s : String) : String := "\"" ++ s ++ "\""
def jsonArr (items : List String) : String := "[" ++ ", ".intercalate items ++ "]"
def jsonObj (fields : List (String × String)) : String :=
  "{" ++ ", ".intercalate (fields.map fun (k, v) => jsonStr k ++ ": " ++ v) ++ "}"
def jsonBool (b : Bool) : String := if b then "true" else "false"
def jsonNat (n : Nat) : String := toString n
def jsonNatList (l : List Nat) : String := jsonArr (l.map jsonNat)
def jsonInt (i : Int) : String := toString i
def jsonIntList (l : List Int) : String := jsonArr (l.map jsonInt)
def jsonOptNat : Option Nat → String
  | none => "null"
  | some n => jsonNat n

def transitionsJson : String :=
  jsonObj (JobState.all.map fun s => (JobState.name s, jsonArr ((JobState.next s).map (jsonStr ∘ JobState.name))))

def claimDecisionJson : ClaimDecision → String
  | .claim a g fresh =>
    jsonObj [("kind", jsonStr "claim"), ("reason", jsonStr (if fresh then "fresh" else "lease-expired")),
         ("nextAttempt", jsonNat a), ("nextLeaseGeneration", jsonNat g)]
  | .exhausted => jsonObj [("kind", jsonStr "exhausted")]
  | .notEligible => jsonObj [("kind", jsonStr "not-eligible")]

def decideClaimVectors : List String := Id.run do
  let mut out := []
  for state in JobState.all do
    for attempt in [0, 1, 2, 3] do
      for maxAttempts in [1, 3] do
        for leaseExpired in [true, false] do
          for cancelRequested in [true, false] do
            for generation in [0, 4] do
              let job : Job :=
                { state, generation, owner := some 1, leaseExpired, attempt, maxAttempts,
                  cancelRequested }
              out := jsonObj [("state", jsonStr (JobState.name state)), ("attempt", jsonNat attempt),
                ("maxAttempts", jsonNat maxAttempts), ("leaseExpired", jsonBool leaseExpired),
                ("cancelRequested", jsonBool cancelRequested), ("leaseGeneration", jsonNat generation),
                ("decision", claimDecisionJson (decideClaim job))] :: out
  return out.reverse

def leaseCheckName : LeaseCheck → String
  | .ok => "OK"
  | .notLeased => "NOT_LEASED"
  | .stale => "STALE_LEASE"
  | .wrongRunner => "WRONG_RUNNER"

def checkLeaseVectors : List String := Id.run do
  let mut out := []
  for state in JobState.all do
    for owner in [none, some 1, some 2] do
      for generation in [1, 2] do
        for runner in [1, 2] do
          for proofGeneration in [1, 2] do
            let job : Job :=
              { state, generation, owner, leaseExpired := false, attempt := 1, maxAttempts := 3,
                cancelRequested := false }
            out := jsonObj [("state", jsonStr (JobState.name state)), ("leaseOwner", jsonOptNat owner),
              ("leaseGeneration", jsonNat generation), ("runner", jsonNat runner),
              ("proofGeneration", jsonNat proofGeneration),
              ("result", jsonStr (leaseCheckName (checkLease job runner proofGeneration)))] :: out
  return out.reverse

def releaseDecisionJson : ReleaseDecision → String
  | .requeue a => jsonObj [("kind", jsonStr "requeue"), ("nextAttempt", jsonNat a)]
  | .cancel => jsonObj [("kind", jsonStr "cancel")]
  | .rejected c => jsonObj [("kind", jsonStr "rejected"), ("error", jsonStr (leaseCheckName c))]

/--
`decideRelease` over every state, owner, generation, presenting runner, proof
generation, attempt and cancel bit. For a granted hand-back the vector also
records what the released job then answers: the presenting proof's lease
check, and the next claim's decision.
-/
def decideReleaseVectors : List String := Id.run do
  let mut out := []
  for state in JobState.all do
    for owner in [none, some 1] do
      for generation in [1, 2] do
        for runner in [1, 2] do
          for proofGeneration in [1, 2] do
            for attempt in [0, 1, 3] do
              for cancelRequested in [true, false] do
                let job : Job :=
                  { state, generation, owner, leaseExpired := false, attempt, maxAttempts := 3,
                    cancelRequested }
                let decision := decideRelease job runner proofGeneration
                let after := applyRelease job decision
                let granted := match decision with
                  | .rejected _ => false
                  | _ => true
                out := jsonObj [("state", jsonStr (JobState.name state)), ("leaseOwner", jsonOptNat owner),
                  ("leaseGeneration", jsonNat generation), ("runner", jsonNat runner),
                  ("proofGeneration", jsonNat proofGeneration), ("attempt", jsonNat attempt),
                  ("cancelRequested", jsonBool cancelRequested),
                  ("decision", releaseDecisionJson decision),
                  ("releasedState", if granted then jsonStr (JobState.name after.state) else "null"),
                  ("releasedCheck",
                    if granted then jsonStr (leaseCheckName (checkLease after runner proofGeneration))
                    else "null"),
                  ("releasedClaim",
                    if granted then claimDecisionJson (decideClaim after) else "null")] :: out
  return out.reverse

def limitName : Option Limit → String
  | none => "null"
  | some .maxAgentSteps => jsonStr "MAX_AGENT_STEPS"
  | some .maxToolCalls => jsonStr "MAX_TOOL_CALLS"
  | some .maxWallClock => jsonStr "MAX_WALL_CLOCK"
  | some .maxInputBytes => jsonStr "MAX_INPUT_BYTES"
  | some .maxSpend => jsonStr "MAX_SPEND"

def budgetVectors : List String := Id.run do
  let mut out := []
  for cap in [some 3, none] do
    let budget : Budget := { maxSteps := 2, maxTools := 2, maxWallClock := 10, maxBytes := 5, maxSpend := cap }
    for steps in [0, 2] do
      for tools in [1, 2] do
        for bytes in [0, 5] do
          for cost in [0, 3] do
            for elapsed in [0, 9, 10] do
              for dSteps in [0, 1] do
                for dTools in [0, 1] do
                  for dBytes in [0, 1] do
                    for dCost in [0, 1] do
                      let usage : Usage := ⟨steps, tools, bytes, cost⟩
                      let delta : Delta := ⟨dSteps, dTools, dBytes, dCost⟩
                      out := jsonObj [("maxSpendUsd", cap.map jsonNat |>.getD "null"),
                        ("usage", jsonNatList [steps, tools, bytes, cost]),
                        ("elapsedMs", jsonNat elapsed),
                        ("next", jsonNatList [dSteps, dTools, dBytes, dCost]),
                        ("limit", limitName (checkBudget budget usage elapsed delta))] :: out
  return out.reverse

def positionChangeName : PositionChange → String
  | .newlyReported => "newly-reported-holding"
  | .increase => "increase-in-reported-position"
  | .decrease => "decrease-in-reported-position"
  | .noLongerReported => "no-longer-reported"
  | .unchanged => "unchanged-reported-position"
  | .notReported => "not-reported"

def positionChangeVectors : List String := Id.run do
  let mut out := []
  for previous in [0, 1, 5, 10] do
    for current in [0, 1, 5, 10] do
      out := jsonObj [("previous", jsonNat previous), ("current", jsonNat current),
        ("change", jsonStr (positionChangeName (classifyPositionChange previous current)))] :: out
  return out.reverse

def claimStatusName : ClaimStatus → String
  | .supported => "supported"
  | .unsupported => "unsupported"
  | .conflicting => "conflicting"

def claimStatusVectors : List String := Id.run do
  let mut out := []
  for supports in [0, 1, 2] do
    for contradicts in [0, 1] do
      for unsupportedNumbers in [0, 1] do
        out := jsonObj [("supports", jsonNat supports), ("contradicts", jsonNat contradicts),
          ("unsupportedNumbers", jsonNat unsupportedNumbers),
          ("status", jsonStr (claimStatusName (claimStatus supports contradicts unsupportedNumbers)))] :: out
  return out.reverse

def operationJson : Operation → String
  | .create id => jsonObj [("op", jsonStr "create"), ("id", jsonNat id)]
  | .remove id => jsonObj [("op", jsonStr "remove"), ("id", jsonNat id)]
  | .reorder order => jsonObj [("op", jsonStr "reorder"), ("order", jsonNatList order)]
  | .touch id => jsonObj [("op", jsonStr "touch"), ("id", jsonNat id)]

def operationAlphabet : List Operation :=
  [.create 1, .create 2, .remove 1, .remove 2, .reorder [2, 1], .reorder [1, 2], .reorder [1],
   .reorder [1, 1], .touch 1, .touch 2]

/-- Every operation sequence of length 1 to 3 over the alphabet. -/
def operationSequences : List (List Operation) :=
  let one := operationAlphabet.map fun a => [a]
  let two := operationAlphabet.flatMap fun a => operationAlphabet.map fun b => [a, b]
  let three := operationAlphabet.flatMap fun a => two.map fun rest => a :: rest
  one ++ two ++ three

def workspaceVectors : List String :=
  operationSequences.map fun ops =>
    let final := runOperations Workspace.empty ops
    jsonObj [("operations", jsonArr (ops.map operationJson)), ("version", jsonNat final.version),
      ("components", jsonNatList final.components), ("order", jsonNatList final.order)]

/--
Version-guard vectors: every operation against several workspaces, submitted
with the current, a stale and a future expected version, then submitted again
unchanged. These exercise `applyCommand` (compare-and-set and replay rejection),
which the sequence vectors above never do because they always use the current version.
-/
def guardVectors : List String := Id.run do
  let mut out := []
  for setup in [[], [Operation.create 1], [Operation.create 1, Operation.create 2]] do
    let w := runOperations Workspace.empty setup
    let expectedVersions :=
      (if w.version > 0 then [w.version - 1] else []) ++ [w.version, w.version + 1]
    for op in operationAlphabet do
      for expected in expectedVersions do
        let result := applyCommand w expected op
        let replayAccepted :=
          match result with
          | some w' => (applyCommand w' expected op).isSome
          | none => false
        out := jsonObj [("setup", jsonArr (setup.map operationJson)), ("operation", operationJson op),
          ("expectedVersion", jsonNat expected), ("accepted", jsonBool result.isSome),
          ("version", jsonNat (match result with | some w' => w'.version | none => w.version)),
          ("replayAccepted", jsonBool replayAccepted)] :: out
  return out.reverse

/-- Every size list of length 0..3 over {0, 1, 2, 3}, newest first. -/
def recentSizeLists : List (List Nat) :=
  [[]] ++
  ([0, 1, 2, 3].map fun a => [a]) ++
  ([0, 1, 2, 3].flatMap fun a => [0, 1, 2, 3].map fun b => [a, b]) ++
  ([0, 1, 2, 3].flatMap fun a =>
    [0, 1, 2, 3].flatMap fun b => [0, 1, 2, 3].map fun c => [a, b, c])

def recentWithinBudgetVectors : List String := Id.run do
  let mut out := []
  for xs in recentSizeLists do
    for budget in [0, 1, 2, 3, 4, 5] do
      for maxItems in [0, 1, 2, 3] do
        out := jsonObj [("sizes", jsonNatList xs), ("budget", jsonNat budget),
          ("maxItems", jsonNat maxItems),
          ("count", jsonNat (recentCountWithinBudget xs budget maxItems))] :: out
  return out.reverse

/-! ## Home dashboard edits -/

def dashboardEditJson : DashboardEdit → String
  | .add id => jsonObj [("kind", jsonStr "add"), ("id", jsonNat id)]
  | .remove id => jsonObj [("kind", jsonStr "remove"), ("id", jsonNat id)]
  | .moveEarlier id => jsonObj [("kind", jsonStr "moveEarlier"), ("id", jsonNat id)]
  | .moveLater id => jsonObj [("kind", jsonStr "moveLater"), ("id", jsonNat id)]
  | .reorder id k => jsonObj [("kind", jsonStr "reorder"), ("id", jsonNat id), ("toIndex", jsonNat k)]

/-- Every id list of length 0..3 over {0, 1, 2} without duplicates, plus one
    full 24-widget dashboard for the maximum rule. -/
def dashboardGrid : List (List Nat) :=
  [[]] ++ [[0], [1], [2]]
  ++ [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]
  ++ [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
  ++ [List.range 24]

def dashboardEdits : List DashboardEdit :=
  ([0, 1, 2, 3].map DashboardEdit.add) ++ ([0, 1, 2, 3].map DashboardEdit.remove)
  ++ ([0, 1, 2, 3].map DashboardEdit.moveEarlier) ++ ([0, 1, 2, 3].map DashboardEdit.moveLater)
  ++ ((List.range 5).flatMap fun k => [0, 1, 2, 3].map fun id => DashboardEdit.reorder id k)

def dashboardVec (ids : List Nat) (e : DashboardEdit) : String :=
  let result := applyDashboardEdit ⟨ids⟩ e
  jsonObj [("dashboard", jsonNatList ids), ("edit", dashboardEditJson e),
    ("accepted", jsonBool result.isSome),
    ("ids", jsonNatList (result.getD ⟨ids⟩).ids)]

def dashboardVectors : List String :=
  dashboardGrid.flatMap fun ids => dashboardEdits.map (dashboardVec ids)

/-! ## Fixed-window rate gate -/

/-- Grant-time lists of length 0..2 over {0, 1, 5} (not necessarily ordered). -/
def grantLists : List (List Int) :=
  [[]] ++ ([0, 1, 5].map fun a => [a])
  ++ ([0, 1, 5].flatMap fun a => [0, 1, 5].map fun b => [a, b])

def permitVec (grants : List Int) (now maxPer window : Nat) : String :=
  let allowed := ratePermit grants now maxPer window
  let retry : String :=
    if allowed then "null"
    else match (grants.filter (windowFilter now window)).min? with
      | none => "null"
      | some oldest => toString (oldest + window - now)
  jsonObj [("grants", jsonIntList grants), ("now", jsonNat now),
    ("maxPer", jsonNat maxPer), ("window", jsonNat window),
    ("allowed", jsonBool allowed), ("retryAfter", retry)]

def permitVectors : List String := Id.run do
  let mut out := []
  for grants in grantLists do
    for now in List.range 7 do
      for maxPer in [1, 2, 3] do
        for window in [1, 2, 3, 5] do
          out := permitVec grants now maxPer window :: out
  return out.reverse

/-- Non-decreasing grant-time lists of length 0..3 over {0, 1, 2}. -/
def sortedTimeLists : List (List Int) :=
  [[]] ++ [[0], [1], [2]]
  ++ [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]]
  ++ [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 1, 1], [0, 1, 2], [0, 2, 2],
      [1, 1, 1], [1, 1, 2], [1, 2, 2], [2, 2, 2]]

def recordVec (times : List Int) (maxPer window : Nat) : String :=
  jsonObj [("times", jsonIntList times), ("maxPer", jsonNat maxPer),
    ("window", jsonNat window), ("recorded", jsonIntList (recordGrants times maxPer window))]

def recordVectors : List String := Id.run do
  let mut out := []
  for times in sortedTimeLists do
    for maxPer in [1, 2] do
      for window in [1, 2, 3] do
        out := recordVec times maxPer window :: out
  return out.reverse

/-! ## Earnings-date calendar (FR-018) -/

/-- Character-width lists of length 0..3 over {1, 2, 3, 4} octets. -/
def foldSmall : List (List Nat) :=
  [[]] ++ ([1, 2, 3, 4].map fun a => [a])
  ++ ([1, 2, 3, 4].flatMap fun a => [1, 2, 3, 4].map fun b => [a, b])
  ++ ([1, 2, 3, 4].flatMap fun a =>
    [1, 2, 3, 4].flatMap fun b => [1, 2, 3, 4].map fun c => [a, b, c])

/-- Width runs around the 75-octet first line and the 74-octet continuation
    lines, plus mixed widths straddling a fold. -/
def foldBoundary : List (List Nat) :=
  let rep := List.replicate
  [rep 74 1, rep 75 1, rep 76 1, rep 149 1, rep 150 1,
   rep 36 2, rep 37 2, rep 38 2, rep 74 2, rep 75 2,
   rep 24 3, rep 25 3, rep 26 3, rep 49 3, rep 50 3,
   rep 17 4, rep 18 4, rep 19 4, rep 37 4, rep 38 4,
   rep 74 1 ++ [2], rep 74 1 ++ [4], rep 73 1 ++ [2, 2],
   rep 18 4 ++ [3], [4, 4] ++ rep 70 1 ++ [2], rep 24 3 ++ [4]]

def foldVectors : List String :=
  (foldSmall ++ foldBoundary).map fun widths =>
    jsonObj [("widths", jsonNatList widths),
      ("lines", jsonArr ((foldWidths widths).map jsonNatList))]

def earnRowJson : EarnRow → String
  | ⟨s, none⟩ => jsonObj [("stock", jsonNat s), ("date", "null")]
  | ⟨s, some d⟩ => jsonObj [("stock", jsonNat s), ("date", jsonNat d)]

def earnPairJson (p : Nat × Nat) : String :=
  jsonObj [("date", jsonNat p.1), ("stock", jsonNat p.2)]

/-- Row lists of length 0..2 over a six-row alphabet (one undecided row and
    five dated rows over three stocks and three day offsets). -/
def earnAlphabet : List EarnRow :=
  [⟨0, none⟩, ⟨0, some 0⟩, ⟨1, some 1⟩, ⟨0, some 2⟩, ⟨2, some 0⟩, ⟨1, some 2⟩]

def earnRowLists : List (List EarnRow) :=
  [[]] ++ (earnAlphabet.map fun a => [a])
  ++ (earnAlphabet.flatMap fun a => earnAlphabet.map fun b => [a, b])

def upcomingVectors : List String := Id.run do
  let mut out := []
  for rows in earnRowLists do
    for today in [0, 1] do
      for daysAhead in [0, 1, 3] do
        for maxItems in [0, 1, 2, 5] do
          out := jsonObj [("rows", jsonArr (rows.map earnRowJson)),
            ("today", jsonNat today), ("daysAhead", jsonNat daysAhead),
            ("maxItems", jsonNat maxItems),
            ("selected", jsonArr ((selectUpcoming rows today daysAhead maxItems).map earnPairJson))] :: out
  return out.reverse

/-! ## Earnings month grid (FR-019 section 1) -/

def pad2 (n : Nat) : String :=
  if n < 10 then "0" ++ toString n else toString n

def pad4 (n : Nat) : String :=
  if n < 10 then "000" ++ toString n
  else if n < 100 then "00" ++ toString n
  else if n < 1000 then "0" ++ toString n
  else toString n

def isoOfInts (y m d : Int) : String :=
  pad4 y.toNat ++ "-" ++ pad2 m.toNat ++ "-" ++ pad2 d.toNat

/-- ISO date of absolute day `a` (days since 1970-01-01). -/
def isoOfAbs (a : Int) : String :=
  match gridCivilFromDays a with
  | (y, m, d) => isoOfInts y m d

/-- Sample months: epoch edges, leap and common Februaries, 4/5/6-week grids. -/
def monthSamples : List (Nat × Nat) :=
  [(1970, 1), (1970, 2), (2024, 2), (2026, 2), (2026, 8),
   (2026, 10), (2026, 12), (2027, 1), (9999, 12)]

def monthGridVec (year month weekStart : Nat) : String :=
  let days := gridDaysInMonth year month
  let fw := gridWeekday year month 1
  let leading := gridLeading fw weekStart
  let total := gridCells leading days
  let base := gridDaysFromCivil year month 1
  let first := isoOfAbs (base - leading)
  let inMonth := (List.range' 1 days).map fun k =>
    isoOfAbs (gridDaysFromCivil year month k)
  jsonObj [("year", jsonNat year), ("month", jsonNat month),
    ("weekStart", jsonNat weekStart), ("firstWeekday", jsonNat fw),
    ("days", jsonNat days), ("leading", jsonNat leading),
    ("rows", jsonNat (total / 7)), ("first", jsonStr first),
    ("inMonth", jsonArr (inMonth.map jsonStr))]

def monthGridVectors : List String :=
  monthSamples.flatMap fun (year, month) =>
    [0, 1, 6].map fun weekStart => monthGridVec year month weekStart

/-! ## Google sync plan + base32hex encoder (FR-019 section 2.3) -/

def pairJson (p : Nat × Nat) : String :=
  jsonObj [("id", jsonNat p.1), ("fp", jsonNat p.2)]

def syncRowJson (r : SyncRow) : String :=
  jsonObj [("id", jsonNat r.id), ("cancelled", jsonBool r.cancelled),
    ("fp", jsonNat r.fingerprint)]

def pairAlphabet : List (Nat × Nat) :=
  [(0, 0), (0, 1), (1, 0), (1, 1), (2, 0)]

def pairLists : List (List (Nat × Nat)) :=
  [[]] ++ (pairAlphabet.map fun a => [a])
  ++ (pairAlphabet.flatMap fun a => pairAlphabet.map fun b => [a, b])

def syncRowAlphabet : List SyncRow :=
  [⟨0, false, 0⟩, ⟨0, true, 0⟩, ⟨1, false, 0⟩,
   ⟨1, false, 1⟩, ⟨1, true, 1⟩, ⟨2, false, 0⟩]

def syncRowLists : List (List SyncRow) :=
  [[]] ++ (syncRowAlphabet.map fun a => [a])
  ++ (syncRowAlphabet.flatMap fun a => syncRowAlphabet.map fun b => [a, b])

/-- Distinct-id inputs only: duplicates are rejected by the implementation
    (`DUPLICATE_ID`) and covered by fail-closed unit tests instead. -/
def distinctIds (d : List (Nat × Nat)) : Bool :=
  decide ((d.map (·.1)).Nodup)

def distinctRowIds (e : List SyncRow) : Bool :=
  decide ((e.map (·.id)).Nodup)

def syncPlanVec (desired : List (Nat × Nat)) (existing : List SyncRow) : String :=
  let plan := planSync desired existing
  jsonObj [("desired", jsonArr (desired.map pairJson)),
    ("existing", jsonArr (existing.map syncRowJson)),
    ("inserts", jsonArr (plan.inserts.map pairJson)),
    ("updates", jsonArr (plan.updates.map pairJson)),
    ("deletes", jsonNatList plan.deletes),
    ("unchanged", jsonNatList plan.unchanged)]

def syncPlanVectors : List String := Id.run do
  let mut out := []
  for desired in pairLists do
    if !distinctIds desired then continue
    for existing in syncRowLists do
      if !distinctRowIds existing then continue
      out := syncPlanVec desired existing :: out
  return out.reverse

def b32Samples : List (List Nat) :=
  [[]] ++ [[0, 0, 0, 0, 0], [255, 255, 255, 255, 255],
  [0, 0, 0, 0, 1], [1, 0, 0, 0, 0], [0, 0, 0, 0, 255], [255, 0, 0, 0, 0],
  [0, 1, 2, 3, 4], [1, 2, 3, 4, 5], [10, 20, 30, 40, 50], [7, 7, 7, 7, 7],
  [128, 64, 32, 16, 8], [1, 255, 1, 255, 1]]
  ++ [List.replicate 20 0, List.replicate 20 255, List.range' 0 20,
    [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4]]

def b32Vectors : List String :=
  b32Samples.map fun bytes =>
    jsonObj [("bytes", jsonNatList bytes),
      ("chars", jsonNatList (encodeB32 bytes))]

/-! ## Chart viewer (`ChartWindow.lean`, ADR-0025) -/

def cIntervalName : CInterval → String
  | .daily => "daily"
  | .weekly => "weekly"
  | .monthly => "monthly"
  | .quarterly => "quarterly"
  | .yearly => "yearly"

def cPresetName : CPreset → String
  | .w1 => "1w"
  | .m1 => "1m"
  | .m3 => "3m"
  | .m6 => "6m"
  | .ytd => "ytd"
  | .y1 => "1y"
  | .y3 => "3y"
  | .y5 => "5y"
  | .max => "max"

def cPointJson (p : CPoint) : String :=
  jsonObj [("day", jsonInt p.day), ("date", jsonStr (isoOfAbs p.day)),
    ("value", jsonNat p.val)]

def cBarJson (b : CBar) : String :=
  jsonObj [("day", jsonInt b.day), ("date", jsonStr (isoOfAbs b.day)),
    ("open", jsonNat b.open_), ("high", jsonNat b.high),
    ("low", jsonNat b.low), ("close", jsonNat b.close),
    ("count", jsonNat b.count)]

/-- Boundaries: a week split (Sat/Sun/Mon), month ends (incl. Feb in a
    common year), quarter and year ends. -/
def chartTriples : List (CInterval × List Int) :=
  [(.weekly, [2, 3, 4]), (.weekly, [9, 10, 11]),
   (.monthly, [30, 31, 32]), (.monthly, [58, 59, 60]), (.monthly, [364, 365, 366]),
   (.quarterly, [89, 90, 91]), (.quarterly, [364, 365, 366]),
   (.yearly, [364, 365, 366]), (.yearly, [729, 730, 731]),
   (.daily, [5, 6, 7])]

/-- Every point list of length 0..2 over the boundary days × values {0, 1, 2}
    (unsorted orders included: both sides sort). -/
def chartPointLists (days : List Int) : List (List CPoint) :=
  let alphabet := days.flatMap fun d => [0, 1, 2].map fun v => CPoint.mk d v
  [[]] ++ (alphabet.map fun a => [a])
    ++ (alphabet.flatMap fun a => alphabet.map fun b => [a, b])

def resampleVec (iv : CInterval) (pts : List CPoint) : String :=
  jsonObj [("interval", jsonStr (cIntervalName iv)),
    ("points", jsonArr (pts.map cPointJson)),
    ("bars", jsonArr ((resampleSorted iv (sortPoints pts)).map cBarJson))]

def chartResampleVectors : List String :=
  chartTriples.flatMap fun (iv, days) => (chartPointLists days).map (resampleVec iv)

def windowJson (w : Window) : String :=
  jsonObj [("from", jsonInt w.lo), ("to", jsonInt w.hi)]

def presetVec (preset : CPreset) (first last : Int) : String :=
  let r := presetWindow preset first last
  jsonObj [("preset", jsonStr (cPresetName preset)),
    ("firstDay", jsonInt first), ("lastDay", jsonInt last),
    ("from", jsonInt r.lo), ("to", jsonInt r.hi)]

def chartPresetVectors : List String := Id.run do
  let mut out := []
  for preset in ([.w1, .m1, .m3, .m6, .ytd, .y1, .y3, .y5, .max] : List CPreset) do
    for last in ([gridDaysFromCivil 2024 3 31, gridDaysFromCivil 2024 6 15,
        gridDaysFromCivil 2023 2 28] : List Int) do
      for first in ([gridDaysFromCivil 2020 1 1, last - 100, last] : List Int) do
        out := presetVec preset first last :: out
  return out.reverse

def clampVec (a b lo hi : Int) (minSpan : Nat) : String :=
  let r := clampWindow ⟨a, b⟩ ⟨lo, hi⟩ minSpan
  jsonObj [("window", windowJson ⟨a, b⟩), ("extent", windowJson ⟨lo, hi⟩),
    ("minSpan", jsonNat minSpan), ("from", jsonInt r.lo), ("to", jsonInt r.hi)]

def chartClampVectors : List String := Id.run do
  let mut out := []
  for a in ([-1, 0, 2] : List Int) do
    for b in ([-1, 0, 2, 4] : List Int) do
      for hi in ([1, 4] : List Int) do
        for minSpan in ([0, 1, 5] : List Nat) do
          out := clampVec a b 0 hi minSpan :: out
  return out.reverse

def panVec (a b delta lo hi : Int) : String :=
  let r := panWindow ⟨a, b⟩ delta ⟨lo, hi⟩
  jsonObj [("window", windowJson ⟨a, b⟩), ("delta", jsonInt delta),
    ("extent", windowJson ⟨lo, hi⟩),
    ("from", jsonInt r.lo), ("to", jsonInt r.hi)]

def chartPanVectors : List String := Id.run do
  let mut out := []
  for a in ([-1, 0, 2] : List Int) do
    for b in ([-1, 0, 2, 4] : List Int) do
      for delta in ([-3, 0, 2] : List Int) do
        for hi in ([1, 4] : List Int) do
          out := panVec a b delta 0 hi :: out
  return out.reverse

/-- Zoom vectors with the float-agreement filter: the TypeScript computes the
    anchor shift in floating point, so vectors where the exact division is
    integral (but neither trivially zero nor full-span, where the float result
    is exact) are skipped — the unit tests cover those cases instead. -/
def zoomVec (a b anchor : Int) (num den : Nat) (lo hi : Int) (minSpan : Nat) :
    Option String :=
  let s := zoomNewSpan ((b - a).toNat) num den minSpan ((hi - lo).toNat)
  let ae := min (max anchor lo) hi
  let spanN := (b - a).toNat
  let offN := (min (max (ae - a) 0) (b - a)).toNat
  if spanN ≠ 0 ∧ offN ≠ 0 ∧ offN ≠ spanN ∧ (offN * s) % spanN == 0 then none
  else
    let r := zoomWindow ⟨a, b⟩ anchor num den ⟨lo, hi⟩ minSpan
    some (jsonObj [("window", windowJson ⟨a, b⟩), ("anchor", jsonInt anchor),
      ("factorNum", jsonNat num), ("factorDen", jsonNat den),
      ("extent", windowJson ⟨lo, hi⟩), ("minSpan", jsonNat minSpan),
      ("from", jsonInt r.lo), ("to", jsonInt r.hi)])

def chartZoomVectors : List String := Id.run do
  let mut out := []
  for ab in ([(-1, -1), (-1, 2), (0, 0), (0, 2), (0, 4), (2, 2), (2, 5)] :
      List (Int × Int)) do
    for anchor in ([-1, 0, 2, 4] : List Int) do
      for numDen in ([(1, 2), (1, 1), (2, 1), (3, 2)] : List (Nat × Nat)) do
        for hi in ([3, 6] : List Int) do
          for minSpan in ([0, 2] : List Nat) do
            match zoomVec ab.1 ab.2 anchor numDen.1 numDen.2 0 hi minSpan with
            | none => continue
            | some v => out := v :: out
  return out.reverse

/-- Sorted day lists of length 0..3 over {0, 1, 2} (duplicates included). -/
def chartDayLists : List (List Int) :=
  [[]] ++ [[0], [1], [2]]
  ++ [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]]
  ++ [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 1, 1], [0, 1, 2], [0, 2, 2],
      [1, 1, 1], [1, 1, 2], [1, 2, 2], [2, 2, 2]]

def sliceVec (days : List Int) (a b : Int) : String :=
  let idx := sliceIdx days a b
  jsonObj [("days", jsonIntList days), ("from", jsonInt a), ("to", jsonInt b),
    ("start", jsonNat idx.1), ("end", jsonNat idx.2)]

def chartSliceVectors : List String := Id.run do
  let mut out := []
  for days in chartDayLists do
    for a in ([-1, 0, 1, 2, 3] : List Int) do
      for b in ([-1, 0, 1, 2, 3] : List Int) do
        out := sliceVec days a b :: out
  return out.reverse

/-- Value lists of length 0..3 over {0, 1, 2} against periods 0..4
    (period 0 is outside the model: the implementation fails closed). -/
def chartValueLists : List (List Nat) :=
  [[]] ++ [[0], [1], [2]]
  ++ [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]
  ++ ([0, 1, 2].flatMap fun a => [0, 1, 2].flatMap fun b =>
      [0, 1, 2].map fun c => [a, b, c])

def maVec (values : List Nat) (period : Nat) : String :=
  jsonObj [("values", jsonNatList values), ("period", jsonNat period),
    ("mask", match period with
      | 0 => "null"
      | _ + 1 => jsonArr ((maMask values period).map fun set => if set then "true" else "false"))]

def chartMaVectors : List String := Id.run do
  let mut out := []
  for values in chartValueLists do
    for period in ([0, 1, 2, 3, 4] : List Nat) do
      out := maVec values period :: out
  return out.reverse

/-! ## Drop-target decision (`DragTarget.lean`) -/

/-- Small alphabet: two same-size neighbours (`dragR0`, `dragR1`, with a
    2-unit gap), a large slot next to a small one (`dragR2`, `dragR3`), and
    a slot sharing `dragR0`'s center (`dragR4`, for the coincident-centers
    branch). -/
def dragR0 : SlotRect := { left := 0, top := 0, right := 10, bottom := 10 }
def dragR1 : SlotRect := { left := 12, top := 0, right := 22, bottom := 10 }
def dragR2 : SlotRect := { left := 0, top := 0, right := 22, bottom := 22 }
def dragR3 : SlotRect := { left := 24, top := 0, right := 34, bottom := 10 }
def dragR4 : SlotRect := { left := 3, top := 3, right := 7, bottom := 7 }

/-- Slot lists of length 0..3: empty, singleton, same-size neighbours, a
    large/small pair (disjoint, so the reverse behaves identically and is
    omitted), the same-center pair in both orders (they overlap, so the
    order decides the hover), and a nested triple. -/
def dragSlotLists : List (List SlotRect) :=
  [[], [dragR0], [dragR0, dragR1], [dragR2, dragR3],
   [dragR0, dragR4], [dragR4, dragR0], [dragR2, dragR0, dragR4]]

/-- Pointer lattice: x hits outside-left, a small-slot interior, the small
    right edge, the gap, the neighbour left edge and interior, the far
    small's edge and interior, and outside-right; y hits outside-below, a
    mid row through every slot, and a row inside only the large slot. -/
def dragPointers : List (Int × Int) :=
  (([-2, 5, 10, 11, 12, 17, 24, 29, 36] : List Int).flatMap fun x =>
    (([-2, 5, 11] : List Int).map fun y => (x, y)))

def slotRectJson (r : SlotRect) : String :=
  jsonObj [("left", jsonInt r.left), ("top", jsonInt r.top),
    ("right", jsonInt r.right), ("bottom", jsonInt r.bottom)]

def dragHistoryJson (h : DragHistory) : String :=
  jsonObj [("target", jsonNat h.target),
    ("banned", match h.banned with | none => "null" | some b => jsonNat b)]

/-- 2943 vectors: every slot list against every `draggedIndex` in
    `0..length` (one out of range), every lattice pointer, every
    `previous.banned` in `none | 0..length-1`, and `previous.target =
    draggedIndex` (what the engine passes) plus `(draggedIndex + 1) %
    length` when there is more than one slot. The grid reaches every
    branch: short lists, the out-of-range dragged index, gaps and outside,
    hover-is-dragged, hover-is-banned, coincident centers, held midpoints
    and commits. -/
def dragTargetVectors : List String := Id.run do
  let mut out := []
  for slots in dragSlotLists do
    for d in List.range (slots.length + 1) do
      for p in dragPointers do
        for banned in none :: (List.range slots.length).map some do
          let targets :=
            if slots.length ≥ 2 then [d, (d + 1) % slots.length] else [d]
          for t in targets do
            let prev : DragHistory := { target := t, banned := banned }
            let res := nextDropTarget slots d p.1 p.2 prev
            out := jsonObj [("slots", jsonArr (slots.map slotRectJson)),
              ("draggedIndex", jsonNat d),
              ("pointer", jsonObj [("x", jsonInt p.1), ("y", jsonInt p.2)]),
              ("previous", dragHistoryJson prev),
              ("target", jsonNat res.target),
              ("banned", match res.banned with
                | none => "null" | some b => jsonNat b)] :: out
  return out.reverse

/-! ## Request-start spacing (`Spacing.lean`)

Every operation sequence of length 0..3 over claims and notes at times
{0, 1, 2, 3, 5, 6}, interval 3. `abort` is a no-op and is covered by the
theorem, not exported. -/

def spacingOps : List SpacingOp :=
  ([0, 1, 2, 3, 5, 6].map fun t => SpacingOp.claim t) ++
  ([0, 1, 2, 3, 5, 6].map fun t => SpacingOp.note t)

def spacingOpJson : SpacingOp → String
  | .claim t => jsonArr [jsonStr "claim", jsonInt t]
  | .note t => jsonArr [jsonStr "note", jsonInt t]
  | .abort => jsonArr [jsonStr "abort"]

/-- Per-operation outcome: whether a claim sent (`null` for a note). -/
def spacingOutcomes (interval : Int) : SpacingState → List SpacingOp → List String
  | _, [] => []
  | s, op :: rest =>
    let s' := spacingStep interval s op
    let outcome : String := match op with
      | .claim _ => jsonBool (s'.starts.length != s.starts.length)
      | _ => "null"
    outcome :: spacingOutcomes interval s' rest

def spacingVec (ops : List SpacingOp) : String :=
  let interval : Int := 3
  let final := spacingRun interval ops
  jsonObj [("interval", jsonInt interval), ("ops", jsonArr (ops.map spacingOpJson)),
    ("outcomes", jsonArr (spacingOutcomes interval ⟨none, []⟩ ops)),
    ("starts", jsonIntList final.starts),
    ("last", match final.last with | none => "null" | some l => jsonInt l)]

def spacingVectors : List String := Id.run do
  let mut out := [spacingVec []]
  for a in spacingOps do
    out := spacingVec [a] :: out
    for b in spacingOps do
      out := spacingVec [a, b] :: out
      for c in spacingOps do
        out := spacingVec [a, b, c] :: out
  return out.reverse

/-! ## Page series (`PageSeries.lean`, ADR-0040)

Named series are ids {0, 1, 2}, list series ids {1, 2, 3} (so lists overlap
the named ids and each other), list ids 0 and 1 are the referenced lists and
list 2 (`[3, 0]`) exists in every table but no widget names it. A list's
content is every list of length 0..2 over {1, 2, 3}, or deleted (absent from
the table). Each vector carries the page for every `limit` 0..4: at most four
distinct ids exist, so limit 4 is "everything fits" and 0..3 cut at every
position.
-/

def psNamedFull : List (List Nat) :=
  [[]] ++ ([0, 1, 2].map fun a => [a]) ++
  ([0, 1, 2].flatMap fun a => [0, 1, 2].map fun b => [a, b]) ++
  ([0, 1, 2].flatMap fun a => [0, 1, 2].flatMap fun b => [0, 1, 2].map fun c => [a, b, c])

/-- The named lists of length 0..2. -/
def psNamedShort : List (List Nat) := psNamedFull.take 13

/-- A referenced list's content, `none` = deleted. -/
def psContents : List (Option (List Nat)) :=
  none :: ([[]] ++ ([1, 2, 3].map fun a => [a]) ++
    ([1, 2, 3].flatMap fun a => [1, 2, 3].map fun b => [a, b])).map some

def psTable (contents : List (Nat × Option (List Nat))) : List (Nat × List Nat) :=
  contents.filterMap (fun (listId, c) => c.map fun s => (listId, s)) ++ [(2, [3, 0])]

def psVec (named refs : List Nat) (contents : List (Nat × Option (List Nat))) : String :=
  let table := psTable contents
  let lists := fun listId => List.lookup listId table
  jsonObj [("named", jsonNatList named), ("refs", jsonNatList refs),
    ("listIds", jsonNatList (PageSeries.dedup refs)),
    ("lists", jsonArr (table.map fun (listId, s) => jsonArr [jsonNat listId, jsonNatList s])),
    ("pages", jsonArr ([0, 1, 2, 3, 4].map fun limit =>
      jsonNatList (PageSeries.pageSeriesIds named refs lists limit)))]

/-- No list widget, one, and one list named by two widgets. -/
def psConfigsOne : List (List Nat × List (Nat × Option (List Nat))) :=
  [([], [])] ++ psContents.map (fun c => ([0], [(0, c)])) ++
    psContents.map (fun c => ([0, 0], [(0, c)]))

def psConfigsTwo : List (List Nat × List (Nat × Option (List Nat))) :=
  psContents.flatMap fun c0 => psContents.map fun c1 => ([0, 1], [(0, c0), (1, c1)])

/-- Three widgets naming two lists, the first one again last. -/
def psConfigsRepeat : List (List Nat × List (Nat × Option (List Nat))) :=
  psContents.flatMap fun c0 => psContents.map fun c1 => ([0, 1, 0], [(0, c0), (1, c1)])

def pageSeriesVectors : List String :=
  (psNamedFull.flatMap fun named => psConfigsOne.map fun (refs, cs) => psVec named refs cs) ++
  (psNamedShort.flatMap fun named => psConfigsTwo.map fun (refs, cs) => psVec named refs cs) ++
  ([[], [2], [2, 0, 1]].flatMap fun named =>
    psConfigsRepeat.map fun (refs, cs) => psVec named refs cs)

/-! ## Stock directory search (ADR-0034) -/

/-- Code points of a Lean string (the model's `Text`). -/
def ssText (s : String) : StockSearch.Text := s.toList.map Char.toNat

def ssHex4 (n : Nat) : String :=
  let digits := Nat.toDigits 16 n
  String.ofList (List.replicate (4 - digits.length) '0' ++ digits)

/-- A JSON string literal for model text. Unlike `jsonStr` it escapes: the
    vectors carry tabs, newlines and other whitespace code points. -/
def ssJson (t : StockSearch.Text) : String :=
  "\"" ++ String.join (t.map fun c =>
    if c = 34 then "\\\""
    else if c = 92 then "\\\\"
    else if c < 0x20 ∨ c = 0x7F ∨ c = 0x1680 ∨ c = 0x2028 ∨ c = 0x2029 ∨ c = 0xFEFF then
      "\\u" ++ ssHex4 c
    else String.singleton (Char.ofNat c)) ++ "\""

/-- The directory the rank vectors search: US and JP listings with ASCII,
    katakana, kanji and hiragana names, a tab and trailing spaces in one
    name, a symbol listed in both markets and one exact duplicate key (rows 0
    and 11) so stability shows. -/
def ssRows : List StockSearch.Row :=
  let row (market symbol name : String) (localName : Option String) : StockSearch.Row :=
    ⟨ssText market, ssText symbol, ssText name, localName.map ssText⟩
  [row "US" "AAPL" "Apple Inc." none,
   row "US" "AA" "Alcoa Corporation" none,
   row "US" "A" "Agilent Technologies, Inc." none,
   row "US" "APP" "AppLovin Corporation" none,
   row "US" "TM" "Toyota Motor Corporation" none,
   row "JP" "7203" "TOYOTA MOTOR CORPORATION" (some "トヨタ自動車"),
   row "JP" "7201" "NISSAN MOTOR CO.,LTD." (some "日産自動車"),
   row "JP" "2914" "JAPAN TOBACCO INC." (some "日本たばこ産業"),
   row "JP" "9984" "SoftBank Group Corp." (some "ソフトバンクグループ"),
   row "JP" "130A" "Veritas In Silico Inc." (some "ベリタス・イン・シリコ"),
   row "JP" "AAPL" "Apple Japan" (some "アップル ジャパン"),
   row "US" "AAPL" "Apple Inc. (second record)" none,
   row "JP" "8306" "Mitsubishi UFJ Financial Group, Inc." (some "三菱UFJフィナンシャル・グループ"),
   row "US" "T" "AT&T Inc." none,
   row "US" "BRK.B" "Berkshire Hathaway Inc. Class B" none,
   row "JP" "7974" "Nintendo Co., Ltd." (some "任天堂"),
   row "JP" "6758" "Sony Group Corporation" (some "ソニーグループ"),
   row "US" "MSFT" "Microsoft\tCorporation  " none]

/-- Queries: blank, case, prefixes of every tier, kana in both scripts,
    multi-term in both orders, a fifth term past `maxTerms`, a miss in the
    first term, a term past `maxQueryChars`, and a term that would only match
    across two fields. -/
def ssQueries : List String :=
  ["", "   ", "\t\n", "apple", "Apple", "APPLE", "aapl", "AAPL", "aa", "a", "app", "ap",
   "t", "tm", "7203", "720", "72", "7", "とよた", "トヨタ", "toyota", "toyota motor",
   "motor toyota", "motor", "自動車", "たばこ", "タバコ", "  Apple   inc ", "\tapple\n", "z",
   "inc. apple", "corp", "co inc a t zzz", "zzz a b c d",
   "toyota toyota toyota toyota toyota toyota toyota toyota toyota zzz",
   "aaplapple", "aapl apple", "ソフトバンク", "そふとばんく", "130a", "130A", "brk.b",
   "グループ", "ぐるーぷ", "三菱", "ufj", "&", "microsoft corporation", "t inc", "co", "ple"]

/-- Limits around the clamp (1..20), including a non-positive and an
    over-large one. -/
def ssLimits : List Int := [-1, 0, 1, 2, 3, 10, 20, 25]

/-- Extra fold inputs: whitespace of every kind the model knows, the A–Z and
    hiragana range edges, katakana and kanji. -/
def ssFoldInputs : List String :=
  ["", " ", "\t\n\r\x0b\x0c", "Apple", "  Apple  Inc. ", "APPLE\tINC", "a b",
   "a b c", "﻿x﻿", "とよた", "トヨタ", "ぁゖ", "ゔゕゖ", "ゝゞ", "ァヶ",
   "@AZ[`az{", "\x0b\x0cx\x0b", "a \t\n\r b", "漢字 かな カナ ABC", "日本たばこ産業",
   "Microsoft\tCorporation  ", "ベリタス・イン・シリコ", "AT&T \"Inc.\" \\ slash"]

def ssTextList (ts : List StockSearch.Text) : String := jsonArr (ts.map ssJson)

def ssRowJson (r : StockSearch.Row) : String :=
  jsonObj [("market", ssJson r.market), ("symbol", ssJson r.symbol), ("name", ssJson r.name),
    ("localName", match r.localName with | none => "null" | some n => ssJson n)]

def ssFoldVectors : List String :=
  (ssFoldInputs ++ ssQueries).map fun s =>
    let t := ssText s
    jsonObj [("input", ssJson t), ("folded", ssJson (StockSearch.fold t))]

/-- Each query's terms and every row's tier (`null` when it does not match). -/
def ssTierVectors : List String :=
  ssQueries.map fun q =>
    let ts := StockSearch.terms (ssText q)
    jsonObj [("query", ssJson (ssText q)), ("terms", ssTextList ts),
      ("tiers", jsonArr (ssRows.map fun r => jsonOptNat (StockSearch.tier (StockSearch.keys r) ts)))]

/-- Ranked rows as indices into `rows`, for the table in order and reversed. -/
def ssRankVectors : List String := Id.run do
  let mut out := []
  for (orderName, rows) in [("forward", ssRows), ("reversed", ssRows.reverse)] do
    for q in ssQueries do
      for limit in ssLimits do
        let ranked := StockSearch.rank rows (ssText q) limit
        out := jsonObj [("order", jsonStr orderName), ("query", ssJson (ssText q)),
          ("limit", jsonInt limit), ("ranked", jsonNatList (ranked.map ssRows.idxOf))] :: out
  return out.reverse

def ssVectorsJson : String :=
  "{\"rows\": [\n" ++ ",\n".intercalate (ssRows.map ssRowJson) ++
  "\n], \"fold\": [\n" ++ ",\n".intercalate ssFoldVectors ++
  "\n], \"tier\": [\n" ++ ",\n".intercalate ssTierVectors ++
  "\n], \"rank\": [\n" ++ ",\n".intercalate ssRankVectors ++ "\n]}"

/-! ## Scheduled tasks: next local slot and tick (ADR-0033) -/

def hhmm (minute : Nat) : String := pad2 (minute / 60) ++ ":" ++ pad2 (minute % 60)
def isoDate (y m d : Nat) : String := pad4 y ++ "-" ++ pad2 m ++ "-" ++ pad2 d

def schedJson : Schedule.Sched → String
  | .once y m d t =>
    jsonObj [("kind", jsonStr "once"), ("date", jsonStr (isoDate y m d)), ("time", jsonStr (hhmm t))]
  | .daily t => jsonObj [("kind", jsonStr "daily"), ("time", jsonStr (hhmm t))]
  | .weekly ds t =>
    jsonObj [("kind", jsonStr "weekly"), ("days", jsonNatList ds), ("time", jsonStr (hhmm t))]
  | .monthly d t =>
    jsonObj [("kind", jsonStr "monthly"), ("day", jsonNat d), ("time", jsonStr (hhmm t))]

/-- Schedules: every kind, month-end and leap-day clamping, and malformed ones. -/
def scheduleSamples : List Schedule.Sched :=
  [.daily 0, .daily 510, .daily 540, .daily 1439,
   .weekly [1, 2, 3, 4, 5] 480, .weekly [0] 1439, .weekly [6] 0, .weekly [0, 6] 540,
   .weekly [3] 540, .weekly [0, 1, 2, 3, 4, 5, 6] 720,
   .weekly [3, 1] 540, .weekly [2, 2] 540, .weekly [] 540, .weekly [7] 540,
   .monthly 1 0, .monthly 15 540, .monthly 28 540, .monthly 29 540, .monthly 30 540,
   .monthly 31 540, .monthly 31 1439, .monthly 0 540, .monthly 32 540,
   .once 2026 10 24 540, .once 2024 2 29 720, .once 2026 12 31 1439, .once 2100 2 28 540,
   .once 2026 2 29 540, .once 2026 13 1 540, .once 2026 4 31 540, .once 2100 2 29 540]

/-- Local instants (year, month, day, minute of day) around the boundaries that matter. -/
def afterSamples : List (Nat × Nat × Nat × Nat) :=
  [(1970, 1, 1, 0), (2024, 1, 31, 540), (2024, 1, 31, 541), (2024, 2, 28, 1439),
   (2024, 2, 29, 0), (2024, 2, 29, 720), (2025, 1, 30, 539), (2025, 2, 28, 540),
   (2026, 3, 31, 600), (2026, 4, 29, 1439), (2026, 4, 30, 540), (2026, 6, 30, 1439),
   (2026, 10, 23, 1439), (2026, 10, 24, 539), (2026, 10, 24, 540), (2026, 10, 24, 541),
   (2026, 10, 25, 0), (2026, 12, 31, 1439), (2027, 1, 1, 0), (2000, 2, 28, 540),
   (2100, 2, 28, 540), (2100, 3, 1, 0)]

def localMinuteOf (y m d t : Nat) : Nat := Schedule.onceSlot y m d t

def nextSlotVectors : List String :=
  scheduleSamples.flatMap fun s =>
    afterSamples.map fun (y, m, d, t) =>
      let after := localMinuteOf y m d t
      jsonObj [("schedule", schedJson s), ("afterDate", jsonStr (isoDate y m d)),
        ("afterTime", jsonStr (hhmm t)), ("after", jsonNat after),
        ("valid", jsonBool s.valid), ("slot", jsonOptNat (Schedule.nextLocalSlot s after))]

def statusName : Schedule.Status → String
  | .active => "active"
  | .paused => "paused"
  | .completed => "completed"

def tickJson : Schedule.Tick → String
  | .idle => jsonObj [("kind", jsonStr "idle")]
  | .wait => jsonObj [("kind", jsonStr "wait")]
  | .fire slot next st =>
    jsonObj [("kind", jsonStr "fire"), ("slot", jsonNat slot), ("nextRunAt", jsonOptNat next),
      ("status", jsonStr (statusName st))]

def tickVectors : List String := Id.run do
  let mut out := []
  let schedules : List Schedule.Sched :=
    [.daily 540, .weekly [1, 2, 3, 4, 5] 480, .monthly 31 540, .once 2026 10 24 540,
     .once 2026 12 31 1439]
  let nows := [localMinuteOf 2026 10 24 540, localMinuteOf 2026 10 31 600,
    localMinuteOf 2027 1 1 0]
  for s in schedules do
    for now in nows do
      for status in [Schedule.Status.active, .paused, .completed] do
        for next in [none, some (now - 3 * 1440), some now, some (now + 1)] do
          for unfinished in [false, true] do
            let task : Schedule.TaskT :=
              { status, nextRunAt := next, hasUnfinishedRun := unfinished }
            out := jsonObj [("schedule", schedJson s), ("now", jsonNat now),
              ("status", jsonStr (statusName status)), ("nextRunAt", jsonOptNat next),
              ("hasUnfinishedRun", jsonBool unfinished),
              ("tick", tickJson (Schedule.decideTaskTick task now (Schedule.nextLocalSlot s)))] :: out
  return out.reverse

def materialSeriesVectors : List String := Id.run do
  let mut out := []
  for provider in ["materials", "fred", "other"] do
    for symbol in ["ND2026", "", "nd", "A/B", "A:B", "ND-1", "Ａ", "A", "123", String.ofList (List.replicate 25 'A'), String.ofList (List.replicate 26 'A')] do
      out := out ++ [jsonObj [("provider", jsonStr provider), ("symbol", jsonStr symbol),
        ("accepted", jsonBool (MaterialSeries.parse provider symbol.toList))]]
  return out

/-! ## Incremental history refresh (ADR-0044) -/

def hrPoint (p : HistoryRefresh.Point) : String := jsonArr [jsonNat p.date, jsonInt p.value]

def hrPoints (ps : List HistoryRefresh.Point) : String := jsonArr (ps.map hrPoint)

def hrOptPoint : Option HistoryRefresh.Point → String
  | none => "null"
  | some p => hrPoint p

def hrRequest (r : HistoryRefresh.Request) : String :=
  jsonObj [("anchor", hrOptPoint r.anchor), ("fullCheck", jsonBool r.fullCheck)]

def hrFetch : HistoryRefresh.Fetch → String
  | .window d => jsonObj [("kind", jsonStr "window"), ("from", jsonNat d)]
  | .full => jsonObj [("kind", jsonStr "full")]

def hrWrite : Option HistoryRefresh.Write → String
  | none => "null"
  | some (.window d) => jsonObj [("mode", jsonStr "window"), ("replaceFrom", jsonNat d)]
  | some (.full d) => jsonObj [("mode", jsonStr "full"), ("replaceFrom", jsonOptNat d)]

def hrOutcome : HistoryRefresh.Outcome → String
  | .store w => jsonObj [("kind", jsonStr "store"), ("write", hrWrite w)]
  | .refetchFull => jsonObj [("kind", jsonStr "refetch-full")]

/-- Every ascending, date-unique list over `dates` (ascending) with values from `values`. -/
def hrLists (dates : List Nat) (values : List Int) : List (List HistoryRefresh.Point) :=
  dates.foldr (fun d acc => acc ++ values.flatMap fun v => acc.map fun l => ⟨d, v⟩ :: l) [[]]

/-- Claims: nothing stored, or an anchor on each answer date with each value, with and without a full check. -/
def hrRequests : List HistoryRefresh.Request :=
  { anchor := none, fullCheck := false } :: { anchor := none, fullCheck := true } ::
    ([1, 2, 3].flatMap fun d => ([0, 1] : List Int).flatMap fun v =>
      [false, true].map fun c => { anchor := some ⟨d, v⟩, fullCheck := c })

def historyRequestVectors : List String := Id.run do
  let period := HistoryRefresh.fullCheckPeriodMs
  let mut out := []
  for anchor in [none, some (⟨2, 1⟩ : HistoryRefresh.Point)] do
    for now in ([1761868800000, 1800000000000] : List Int) do
      for checked in [none, some (now - period), some (now - period + 1), some now,
          some (now + 1), some (now - 30 * 86400000)] do
        out := out ++ [jsonObj [("anchor", hrOptPoint anchor), ("now", jsonInt now),
          ("checkedAt", checked.map jsonInt |>.getD "null"),
          ("request", hrRequest (HistoryRefresh.request anchor checked now))]]
  return out

def historyFirstFetchVectors : List String :=
  hrRequests.map fun r =>
    jsonObj [("request", hrRequest r), ("fetch", hrFetch (HistoryRefresh.firstFetch r))]

def historyConfirmedVectors : List String :=
  ([0, 1, 2, 3, 4].flatMap fun d => ([0, 1] : List Int).flatMap fun v =>
    (hrLists [1, 2, 3] [0, 1]).map fun ps =>
      jsonObj [("anchor", hrPoint ⟨d, v⟩), ("points", hrPoints ps),
        ("confirmed", jsonBool (HistoryRefresh.confirmed ⟨d, v⟩ ps))])

def historyOutcomeVectors : List String :=
  hrRequests.flatMap fun r =>
    ([.window 1, .window 2, .window 3, .full] : List HistoryRefresh.Fetch).flatMap fun f =>
      (hrLists [1, 2, 3] [0, 1]).map fun ps =>
        jsonObj [("request", hrRequest r), ("fetch", hrFetch f), ("points", hrPoints ps),
          ("outcome", hrOutcome (HistoryRefresh.outcome r f ps))]

/-- Stored rows carry value 0 and fetched rows value 1, so the result shows where each row came from. -/
def historyMergeVectors : List String :=
  let writes : List (Option HistoryRefresh.Write) :=
    none :: some (.full none) :: ([1, 2, 3, 4].flatMap fun d => [some (.full (some d)), some (.window d)])
  (hrLists [1, 2, 3, 4] [0]).flatMap fun stored =>
    (hrLists [1, 2, 3, 4] [1]).flatMap fun fetched =>
      writes.flatMap fun w =>
        [2, 10].map fun max =>
          jsonObj [("stored", hrPoints stored), ("fetched", hrPoints fetched), ("write", hrWrite w),
            ("max", jsonNat max),
            ("merged", hrPoints (HistoryRefresh.mergeHistory stored fetched w max))]

def main : IO Unit := do
  IO.println "{"
  IO.println ("\"materialSeries\": " ++ jsonArr materialSeriesVectors ++ ",")
  IO.println ("\"leanVersion\": " ++ jsonStr Lean.versionString ++ ",")
  IO.println ("\"states\": " ++ jsonArr (JobState.all.map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"terminalStates\": " ++
    jsonArr ((JobState.all.filter JobState.isTerminal).map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"leasedStates\": " ++
    jsonArr ((JobState.all.filter JobState.isLeased).map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"transitions\": " ++ transitionsJson ++ ",")
  IO.println ("\"decideClaim\": [\n" ++ ",\n".intercalate decideClaimVectors ++ "\n],")
  IO.println ("\"checkLease\": [\n" ++ ",\n".intercalate checkLeaseVectors ++ "\n],")
  IO.println ("\"decideRelease\": [\n" ++ ",\n".intercalate decideReleaseVectors ++ "\n],")
  IO.println ("\"budget\": {\"limits\": " ++
    jsonObj [("maxAgentSteps", jsonNat 2), ("maxToolCalls", jsonNat 2), ("maxWallClockMs", jsonNat 10),
         ("maxInputBytes", jsonNat 5), ("maxSpendUsd", jsonNat 3)] ++
    ", \"vectors\": [\n" ++ ",\n".intercalate budgetVectors ++ "\n]},")
  IO.println ("\"positionChange\": [\n" ++ ",\n".intercalate positionChangeVectors ++ "\n],")
  IO.println ("\"claimStatus\": [\n" ++ ",\n".intercalate claimStatusVectors ++ "\n],")
  IO.println ("\"workspace\": [\n" ++ ",\n".intercalate workspaceVectors ++ "\n],")
  IO.println ("\"commandGuard\": [\n" ++ ",\n".intercalate guardVectors ++ "\n],")
  IO.println ("\"dashboard\": [\n" ++ ",\n".intercalate dashboardVectors ++ "\n],")
  IO.println ("\"ratePermit\": [\n" ++ ",\n".intercalate permitVectors ++ "\n],")
  IO.println ("\"rateRecord\": [\n" ++ ",\n".intercalate recordVectors ++ "\n],")
  IO.println ("\"recentWithinBudget\": [\n" ++ ",\n".intercalate recentWithinBudgetVectors ++ "\n],")
  IO.println ("\"foldIcs\": [\n" ++ ",\n".intercalate foldVectors ++ "\n],")
  IO.println ("\"upcomingEarnings\": [\n" ++ ",\n".intercalate upcomingVectors ++ "\n],")
  IO.println ("\"monthGrid\": [\n" ++ ",\n".intercalate monthGridVectors ++ "\n],")
  IO.println ("\"syncPlan\": [\n" ++ ",\n".intercalate syncPlanVectors ++ "\n],")
  IO.println ("\"base32hex\": [\n" ++ ",\n".intercalate b32Vectors ++ "\n],")
  IO.println ("\"chartResample\": [\n" ++ ",\n".intercalate chartResampleVectors ++ "\n],")
  IO.println ("\"chartPreset\": [\n" ++ ",\n".intercalate chartPresetVectors ++ "\n],")
  IO.println ("\"chartClamp\": [\n" ++ ",\n".intercalate chartClampVectors ++ "\n],")
  IO.println ("\"chartPan\": [\n" ++ ",\n".intercalate chartPanVectors ++ "\n],")
  IO.println ("\"chartZoom\": [\n" ++ ",\n".intercalate chartZoomVectors ++ "\n],")
  IO.println ("\"chartSlice\": [\n" ++ ",\n".intercalate chartSliceVectors ++ "\n],")
  IO.println ("\"chartMa\": [\n" ++ ",\n".intercalate chartMaVectors ++ "\n],")
  IO.println ("\"dragTarget\": [\n" ++ ",\n".intercalate dragTargetVectors ++ "\n],")
  IO.println ("\"spacing\": [\n" ++ ",\n".intercalate spacingVectors ++ "\n],")
  IO.println ("\"nextLocalSlot\": [\n" ++ ",\n".intercalate nextSlotVectors ++ "\n],")
  IO.println ("\"taskTick\": [\n" ++ ",\n".intercalate tickVectors ++ "\n],")
  IO.println ("\"pageSeries\": [\n" ++ ",\n".intercalate pageSeriesVectors ++ "\n],")
  IO.println ("\"historyRequest\": [\n" ++ ",\n".intercalate historyRequestVectors ++ "\n],")
  IO.println ("\"historyFirstFetch\": [\n" ++ ",\n".intercalate historyFirstFetchVectors ++ "\n],")
  IO.println ("\"historyConfirmed\": [\n" ++ ",\n".intercalate historyConfirmedVectors ++ "\n],")
  IO.println ("\"historyOutcome\": [\n" ++ ",\n".intercalate historyOutcomeVectors ++ "\n],")
  IO.println ("\"historyMerge\": [\n" ++ ",\n".intercalate historyMergeVectors ++ "\n],")
  IO.println ("\"equityVisibility\": " ++ jsonArr (Id.run do
    let mut out := []
    for a in [none, some (-1), some 0, some 1, some 2] do
      for c in [-1, 0, 1, 2] do
        for p in [none, some (-1), some 0, some 1, some 2] do
          for s in [none, some (-1), some 0, some 1, some 2] do
            out := out ++ [jsonObj [("availableAt", a.map jsonInt |>.getD "null"),
              ("committedAt", jsonInt c), ("informationCutoff", p.map jsonInt |>.getD "null"),
              ("ingestionCutoff", s.map jsonInt |>.getD "null"),
              ("visible", jsonBool (equityVisible a c p s))]]
    return out) ++ ",")
  IO.println ("\"equityDecimalCompare\": " ++ jsonArr (Id.run do
    let mut out := []
    for a in [-125, -10, -1, 0, 1, 10, 125] do
      for b in [-125, -10, -1, 0, 1, 10, 125] do
        for sa in [0, 1, 2] do
          for sb in [0, 1, 2] do
            out := out ++ [jsonObj [("leftCoefficient", jsonInt a), ("leftScale", jsonNat sa),
              ("rightCoefficient", jsonInt b), ("rightScale", jsonNat sb),
              ("ordering", jsonInt (equityDecimalCompare a sa b sb))]]
    return out) ++ ",")
  IO.println ("\"equityVersionVisibility\": " ++ jsonArr (Id.run do
    let mut out := []
    for v in [0, 1, 2, 3] do
      for c in [0, 1, 2, 3] do
        out := out ++ [jsonObj [("version", jsonNat v), ("cutoff", jsonNat c),
          ("visible", jsonBool (equityVersionVisible v c))]]
    return out) ++ ",")
  IO.println ("\"stockSearch\": " ++ ssVectorsJson)
  IO.println "}"
