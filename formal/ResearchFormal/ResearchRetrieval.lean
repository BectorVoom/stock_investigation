import Std

namespace Research.Retrieval

/-- Round robin, then a bounded prefix. SQL supplies newest-first groups. -/
def interleave (groups : List (List Nat)) (limit : Nat) : List Nat :=
  let rounds := groups.foldl (fun size group => max size group.length) 0
  ((List.range rounds).flatMap (fun i => groups.filterMap (fun group => group[i]?))).take limit

theorem bounded (groups : List (List Nat)) (limit : Nat) :
    (interleave groups limit).length ≤ limit := by
  exact List.length_take_le _ _

theorem zero (groups : List (List Nat)) : interleave groups 0 = [] := by
  simp [interleave]

theorem no_invented_passage (groups : List (List Nat)) (limit value : Nat)
    (h : value ∈ interleave groups limit) : ∃ group ∈ groups, value ∈ group := by
  have hm := List.mem_of_mem_take h
  obtain ⟨i, _, hi⟩ := List.mem_flatMap.mp hm
  obtain ⟨group, hg, hv⟩ := List.mem_filterMap.mp hi
  exact ⟨group, hg, List.mem_of_getElem? hv⟩

end Research.Retrieval
