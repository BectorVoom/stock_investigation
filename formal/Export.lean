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

def limitName : Option Limit → String
  | none => "null"
  | some .maxAgentSteps => jsonStr "MAX_AGENT_STEPS"
  | some .maxToolCalls => jsonStr "MAX_TOOL_CALLS"
  | some .maxWallClock => jsonStr "MAX_WALL_CLOCK"
  | some .maxInputBytes => jsonStr "MAX_INPUT_BYTES"
  | some .maxSpend => jsonStr "MAX_SPEND"

def budgetVectors : List String := Id.run do
  let budget : Budget := { maxSteps := 2, maxTools := 2, maxWallClock := 10, maxBytes := 5, maxSpend := 3 }
  let mut out := []
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
                    out := jsonObj [("usage", jsonNatList [steps, tools, bytes, cost]),
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

def main : IO Unit := do
  IO.println "{"
  IO.println ("\"leanVersion\": " ++ jsonStr Lean.versionString ++ ",")
  IO.println ("\"states\": " ++ jsonArr (JobState.all.map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"terminalStates\": " ++
    jsonArr ((JobState.all.filter JobState.isTerminal).map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"leasedStates\": " ++
    jsonArr ((JobState.all.filter JobState.isLeased).map (jsonStr ∘ JobState.name)) ++ ",")
  IO.println ("\"transitions\": " ++ transitionsJson ++ ",")
  IO.println ("\"decideClaim\": [\n" ++ ",\n".intercalate decideClaimVectors ++ "\n],")
  IO.println ("\"checkLease\": [\n" ++ ",\n".intercalate checkLeaseVectors ++ "\n],")
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
  IO.println ("\"base32hex\": [\n" ++ ",\n".intercalate b32Vectors ++ "\n]")
  IO.println "}"
