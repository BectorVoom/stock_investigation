import Std

namespace Research.ComparisonTable

/-- Pads or truncates one row to exact width `cols`. -/
def normalizeRow (cols : Nat) (pad : Nat) (row : List Nat) : List Nat :=
  let prefixCells := row.take cols
  prefixCells ++ List.replicate (cols - prefixCells.length) pad

theorem normalizeRow_length (cols pad : Nat) (row : List Nat) :
    (normalizeRow cols pad row).length = cols := by
  simp only [normalizeRow, List.length_append, List.length_replicate, List.length_take]
  omega

/-- Normalizes `rows` to a bounded `min cols maxCols × maxRows` rectangle (`rectangularizeTableRows`). -/
def rectangularizeRows (cols maxCols maxRows pad : Nat) (rows : List (List Nat)) : List (List Nat) :=
  if min cols maxCols == 0 || maxRows == 0 then []
  else (rows.take maxRows).map (normalizeRow (min cols maxCols) pad)

theorem rectangularizeRows_length_le (cols maxCols maxRows pad : Nat) (rows : List (List Nat)) :
    (rectangularizeRows cols maxCols maxRows pad rows).length ≤ maxRows := by
  unfold rectangularizeRows
  split
  · simp
  · simp only [List.length_map, List.length_take]
    omega

theorem rectangularizeRows_row_width (cols maxCols maxRows pad : Nat) (rows : List (List Nat))
    (outRow : List Nat) (h : outRow ∈ rectangularizeRows cols maxCols maxRows pad rows) :
    outRow.length = min cols maxCols := by
  unfold rectangularizeRows at h
  split at h
  · contradiction
  · obtain ⟨srcRow, _, rfl⟩ := List.mem_map.mp h
    exact normalizeRow_length _ _ _

/-- Candidate comparison-table row flags (`ComparisonRowCandidate`). -/
structure RowCandidate where
  hasVerifiedSupport : Bool
  hasStrayNumber : Bool
  deriving DecidableEq, Repr, Inhabited

def RowCandidate.admissible (c : RowCandidate) : Bool :=
  c.hasVerifiedSupport && !c.hasStrayNumber

/-- Returns 0-based indices of admissible rows, in order, capped at `maxRows` (`selectVerifiedComparisonRowIndices`). -/
def selectComparisonRows (candidates : List RowCandidate) (maxRows : Nat) : List Nat :=
  if maxRows == 0 then []
  else
    (((List.range candidates.length).filterMap fun idx =>
      match candidates[idx]? with
      | some c => if c.admissible then some idx else none
      | none => none)).take maxRows

theorem selectComparisonRows_length_le (candidates : List RowCandidate) (maxRows : Nat) :
    (selectComparisonRows candidates maxRows).length ≤ maxRows := by
  unfold selectComparisonRows
  split
  · simp
  · exact List.length_take_le _ _

theorem selectComparisonRows_sound (candidates : List RowCandidate) (maxRows idx : Nat)
    (h : idx ∈ selectComparisonRows candidates maxRows) :
    ∃ c, candidates[idx]? = some c ∧ c.hasVerifiedSupport = true ∧ c.hasStrayNumber = false := by
  unfold selectComparisonRows at h
  split at h
  · contradiction
  · have hm := List.mem_of_mem_take h
    obtain ⟨j, _, hj⟩ := List.mem_filterMap.mp hm
    cases hget : candidates[j]? with
    | none => simp [hget] at hj
    | some c =>
      simp only [hget] at hj
      split at hj
      · rename_i hadm
        injection hj with hj_eq
        subst hj_eq
        simp only [RowCandidate.admissible, Bool.and_eq_true, Bool.not_eq_true'] at hadm
        exact ⟨c, hget, hadm.1, hadm.2⟩
      · simp at hj

end Research.ComparisonTable
