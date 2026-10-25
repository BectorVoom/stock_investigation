/-!
# Page series (ADR-0040 §4)

Formal model of `pageSeriesIds` and `watchlistListIdsOf` in
`packages/domain/src/watchlist/lists.ts`.

Series ids and list ids are abstracted to `Nat`. The inputs are:

- `named`: the series the page's widgets name themselves, concatenated in
  widget order with repeats (`distinctDashboardSeriesIds` is `dedup named`);
- `refs`: the list ids of the page's `watchlist-prices` widgets in widget
  order, with repeats (`watchlistListIdsOf` is `dedup refs`);
- `lists`: a list's series in list order, or `none` for a deleted list.

`walk` is the TypeScript `push` loop step for step: it stops as soon as the
output holds `limit` ids (the check comes before the seen test, as in the
code) and skips an id already in the output. The TypeScript returns from both
loops when a push is refused; `walk_full` shows the model's second walk then
adds nothing either.

The main result, `pageSeriesIds_eq_take`, is that the page is exactly the
first `limit` of the distinct ids of `named ++ listed`; the properties of
ADR-0040 §4 (no repeats, at most `limit`, sound, named series first and never
pushed out, complete when everything fits) follow from it, and
`pageSeriesIds_widget_order` shows that a list named by two widgets counts
once (de-duplicating the list ids changes nothing).
-/

namespace Research.PageSeries

/-- One step of the `seen` set: append `x` unless the output already holds it. -/
def addNew (out : List Nat) (x : Nat) : List Nat :=
  if x ∈ out then out else out ++ [x]

/-- Distinct elements, first appearance first: `[...new Set(xs)]`. -/
def dedup (xs : List Nat) : List Nat :=
  xs.foldl addNew []

/-- The `push` loop: refuse once `limit` ids are out, skip a seen id. -/
def walk (limit : Nat) : List Nat → List Nat → List Nat
  | out, [] => out
  | out, x :: xs => if limit ≤ out.length then out else walk limit (addNew out x) xs

/-- A list's series, or nothing for a deleted list (`listSeries(id) ?? []`). -/
def seriesOf (lists : Nat → Option (List Nat)) (listId : Nat) : List Nat :=
  (lists listId).getD []

/-- The listed series in the order the implementation visits them. -/
def listedSeries (lists : Nat → Option (List Nat)) (refs : List Nat) : List Nat :=
  (dedup refs).flatMap (seriesOf lists)

/-- `pageSeriesIds(widgets, listSeries, limit)`: named series, then each distinct list's. -/
def pageSeriesIds (named refs : List Nat) (lists : Nat → Option (List Nat)) (limit : Nat) :
    List Nat :=
  walk limit (walk limit [] (dedup named)) (listedSeries lists refs)

/-! ## The `seen` fold -/

theorem prefix_addNew (out : List Nat) (x : Nat) : out <+: addNew out x := by
  unfold addNew
  split
  · exact List.prefix_refl out
  · exact List.prefix_append out [x]

theorem prefix_foldl (xs out : List Nat) : out <+: xs.foldl addNew out := by
  induction xs generalizing out with
  | nil => exact List.prefix_refl out
  | cons x xs ih => exact (prefix_addNew out x).trans (ih (addNew out x))

theorem length_addNew_le (out : List Nat) (x : Nat) :
    (addNew out x).length ≤ out.length + 1 := by
  unfold addNew
  split <;> simp

theorem mem_addNew (out : List Nat) (x y : Nat) : y ∈ addNew out x ↔ y ∈ out ∨ y = x := by
  unfold addNew
  split
  · constructor
    · exact Or.inl
    · rintro (h | rfl)
      · exact h
      · assumption
  · simp

theorem mem_foldl (xs out : List Nat) (y : Nat) :
    y ∈ xs.foldl addNew out ↔ y ∈ out ∨ y ∈ xs := by
  induction xs generalizing out with
  | nil => simp
  | cons x xs ih =>
    rw [List.foldl_cons, ih, mem_addNew, List.mem_cons]
    constructor
    · rintro ((h | h) | h)
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr h)
    · rintro (h | h | h)
      · exact Or.inl (Or.inl h)
      · exact Or.inl (Or.inr h)
      · exact Or.inr h

theorem mem_dedup (xs : List Nat) (y : Nat) : y ∈ dedup xs ↔ y ∈ xs := by
  unfold dedup
  rw [mem_foldl]
  simp

theorem nodup_addNew {out : List Nat} (h : out.Nodup) (x : Nat) : (addNew out x).Nodup := by
  unfold addNew
  split
  · exact h
  · rename_i hx
    refine List.pairwise_append.mpr ⟨h, List.pairwise_singleton _ _, ?_⟩
    intro a ha b hb
    rw [List.mem_singleton] at hb
    subst hb
    intro hab
    subst hab
    exact hx ha

theorem nodup_foldl (xs : List Nat) {out : List Nat} (h : out.Nodup) :
    (xs.foldl addNew out).Nodup := by
  induction xs generalizing out with
  | nil => exact h
  | cons x xs ih => exact ih (nodup_addNew h x)

theorem nodup_dedup (xs : List Nat) : (dedup xs).Nodup :=
  nodup_foldl xs List.nodup_nil

/-- Folding ids the output already holds changes nothing. -/
theorem foldl_absorbed (ys out : List Nat) (h : ∀ y ∈ ys, y ∈ out) :
    ys.foldl addNew out = out := by
  induction ys with
  | nil => rfl
  | cons y ys ih =>
    have hy : y ∈ out := h y (List.mem_cons_self ..)
    rw [List.foldl_cons]
    have hstep : addNew out y = out := by simp [addNew, hy]
    rw [hstep]
    exact ih (fun z hz => h z (List.mem_cons_of_mem _ hz))

/-- Distinct new ids are appended unchanged. -/
theorem foldl_fresh (l out : List Nat) (hl : l.Nodup) (hd : ∀ x ∈ l, x ∉ out) :
    l.foldl addNew out = out ++ l := by
  induction l generalizing out with
  | nil => simp
  | cons x xs ih =>
    rw [List.nodup_cons] at hl
    have hx : x ∉ out := hd x (List.mem_cons_self ..)
    rw [List.foldl_cons]
    have hstep : addNew out x = out ++ [x] := by simp [addNew, hx]
    rw [hstep, ih (out ++ [x]) hl.2]
    · simp
    · intro y hy hmem
      rw [List.mem_append, List.mem_singleton] at hmem
      rcases hmem with h | h
      · exact hd y (List.mem_cons_of_mem _ hy) h
      · subst h
        exact hl.1 hy

theorem dedup_dedup (xs : List Nat) : dedup (dedup xs) = dedup xs := by
  rw [show dedup (dedup xs) = (dedup xs).foldl addNew [] from rfl,
    foldl_fresh _ [] (nodup_dedup xs) (fun _ _ h => by simp at h)]
  simp

theorem dedup_append (xs ys : List Nat) : dedup (xs ++ ys) = ys.foldl addNew (dedup xs) := by
  unfold dedup
  rw [List.foldl_append]

/-! ## The bounded walk -/

theorem walk_full (limit : Nat) (out xs : List Nat) (h : limit ≤ out.length) :
    walk limit out xs = out := by
  cases xs with
  | nil => rfl
  | cons x xs => simp [walk, h]

/-- The two loops are one walk over the concatenation. -/
theorem walk_append (limit : Nat) (out xs ys : List Nat) :
    walk limit (walk limit out xs) ys = walk limit out (xs ++ ys) := by
  induction xs generalizing out with
  | nil => rfl
  | cons x xs ih =>
    by_cases h : limit ≤ out.length
    · simp only [walk, h, ↓reduceIte, List.cons_append]
      exact walk_full limit out ys h
    · simp only [walk, h, ↓reduceIte, List.cons_append]
      exact ih (addNew out x)

/-- The walk is the unbounded fold cut at `limit`. -/
theorem walk_eq_take (limit : Nat) (xs out : List Nat) (h : out.length ≤ limit) :
    walk limit out xs = (xs.foldl addNew out).take limit := by
  induction xs generalizing out with
  | nil => simp [walk, List.take_of_length_le h]
  | cons x xs ih =>
    by_cases hfull : limit ≤ out.length
    · simp only [walk, hfull, ↓reduceIte, List.foldl_cons]
      have hlen : out.length = limit := Nat.le_antisymm h hfull
      obtain ⟨t, ht⟩ := (prefix_addNew out x).trans (prefix_foldl xs (addNew out x))
      rw [← ht, ← hlen, List.take_left]
    · simp only [walk, hfull, ↓reduceIte, List.foldl_cons]
      have := length_addNew_le out x
      exact ih (addNew out x) (by omega)

/-! ## The page -/

/-- Order (ADR-0040 §4): the page is the first `limit` distinct ids of `named ++ listed`. -/
theorem pageSeriesIds_eq_take (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) :
    pageSeriesIds named refs lists limit =
      (dedup (named ++ listedSeries lists refs)).take limit := by
  unfold pageSeriesIds
  rw [walk_append, walk_eq_take limit _ [] (Nat.zero_le _), List.foldl_append, dedup_append]
  have h := dedup_dedup named
  unfold dedup at h ⊢
  rw [h]

/-- The result has no repeats. -/
theorem pageSeriesIds_nodup (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) : (pageSeriesIds named refs lists limit).Nodup := by
  rw [pageSeriesIds_eq_take]
  exact (nodup_dedup _).sublist (List.take_sublist _ _)

/-- The result holds at most `limit` ids. -/
theorem pageSeriesIds_length_le (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) : (pageSeriesIds named refs lists limit).length ≤ limit := by
  rw [pageSeriesIds_eq_take]
  exact List.length_take_le _ _

/-- A series is on the page via a widget naming it or an existing list a widget names. -/
def Source (named refs : List Nat) (lists : Nat → Option (List Nat)) (x : Nat) : Prop :=
  x ∈ named ∨ ∃ l ∈ refs, ∃ s, lists l = some s ∧ x ∈ s

theorem mem_listedSeries (lists : Nat → Option (List Nat)) (refs : List Nat) (x : Nat) :
    x ∈ listedSeries lists refs ↔ ∃ l ∈ refs, ∃ s, lists l = some s ∧ x ∈ s := by
  unfold listedSeries seriesOf
  rw [List.mem_flatMap]
  constructor
  · rintro ⟨l, hl, hx⟩
    rw [mem_dedup] at hl
    cases hs : lists l with
    | none => simp [hs] at hx
    | some s => exact ⟨l, hl, s, hs, by simpa [hs] using hx⟩
  · rintro ⟨l, hl, s, hs, hx⟩
    exact ⟨l, (mem_dedup refs l).mpr hl, by simpa [hs] using hx⟩

theorem mem_all (named refs : List Nat) (lists : Nat → Option (List Nat)) (x : Nat) :
    x ∈ dedup (named ++ listedSeries lists refs) ↔ Source named refs lists x := by
  rw [mem_dedup, List.mem_append, mem_listedSeries]
  rfl

/-- Sound: every id on the page is named by a widget or in a referenced, existing list. -/
theorem pageSeriesIds_sound (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit x : Nat) (h : x ∈ pageSeriesIds named refs lists limit) :
    Source named refs lists x := by
  rw [pageSeriesIds_eq_take] at h
  exact (mem_all named refs lists x).mp (List.mem_of_mem_take h)

/-- The page is a prefix of all distinct named-then-listed ids. -/
theorem pageSeriesIds_prefix_all (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) :
    pageSeriesIds named refs lists limit <+: dedup (named ++ listedSeries lists refs) := by
  rw [pageSeriesIds_eq_take]
  exact List.take_prefix _ _

/-- The page begins with the distinct named series (as many as `limit` allows). -/
theorem pageSeriesIds_named_prefix (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) : (dedup named).take limit <+: pageSeriesIds named refs lists limit := by
  rw [pageSeriesIds_eq_take, dedup_append]
  obtain ⟨t, ht⟩ := prefix_foldl (listedSeries lists refs) (dedup named)
  rw [← ht, List.take_append]
  exact List.prefix_append _ _

/-- When the named series fit, the page begins with all of them: no list pushes one out. -/
theorem pageSeriesIds_named_all (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) (h : (dedup named).length ≤ limit) :
    dedup named <+: pageSeriesIds named refs lists limit := by
  have := pageSeriesIds_named_prefix named refs lists limit
  rwa [List.take_of_length_le h] at this

/-- Adding list widgets keeps the page of named series as a prefix. -/
theorem pageSeriesIds_lists_extend (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) :
    pageSeriesIds named [] lists limit <+: pageSeriesIds named refs lists limit := by
  have hnil : pageSeriesIds named [] lists limit = (dedup named).take limit := by
    rw [pageSeriesIds_eq_take]
    simp [listedSeries, dedup]
  rw [hnil]
  exact pageSeriesIds_named_prefix named refs lists limit

/-- Complete: when every distinct id fits, every named or listed id is on the page. -/
theorem pageSeriesIds_complete (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit x : Nat) (hfit : (dedup (named ++ listedSeries lists refs)).length ≤ limit)
    (hx : Source named refs lists x) : x ∈ pageSeriesIds named refs lists limit := by
  rw [pageSeriesIds_eq_take, List.take_of_length_le hfit]
  exact (mem_all named refs lists x).mpr hx

/-- A page whose distinct ids fit shows exactly the ids that have a source. -/
theorem pageSeriesIds_mem_iff (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit x : Nat) (hfit : (dedup (named ++ listedSeries lists refs)).length ≤ limit) :
    x ∈ pageSeriesIds named refs lists limit ↔ Source named refs lists x :=
  ⟨pageSeriesIds_sound named refs lists limit x,
    pageSeriesIds_complete named refs lists limit x hfit⟩

/-! ## A list named by several widgets counts once -/

/-- The first appearances of `refs` not already in `seen`. -/
def fresh : List Nat → List Nat → List Nat
  | _, [] => []
  | seen, r :: rs => if r ∈ seen then fresh seen rs else r :: fresh (seen ++ [r]) rs

theorem foldl_eq_fresh (refs seen : List Nat) :
    refs.foldl addNew seen = seen ++ fresh seen refs := by
  induction refs generalizing seen with
  | nil => simp [fresh]
  | cons r rs ih =>
    rw [List.foldl_cons]
    by_cases hr : r ∈ seen
    · simp only [addNew, hr, ↓reduceIte, fresh]
      exact ih seen
    · simp only [addNew, hr, ↓reduceIte, fresh]
      rw [ih (seen ++ [r])]
      simp

theorem dedup_eq_fresh (refs : List Nat) : dedup refs = fresh [] refs := by
  unfold dedup
  rw [foldl_eq_fresh]
  simp

theorem flatMap_fresh (f : Nat → List Nat) (refs : List Nat) :
    ∀ (seen out : List Nat), (∀ r ∈ seen, ∀ x ∈ f r, x ∈ out) →
      (refs.flatMap f).foldl addNew out = ((fresh seen refs).flatMap f).foldl addNew out := by
  induction refs with
  | nil => intro _ _ _; simp [fresh]
  | cons r rs ih =>
    intro seen out hseen
    rw [List.flatMap_cons, List.foldl_append]
    by_cases hr : r ∈ seen
    · rw [foldl_absorbed (f r) out (hseen r hr)]
      simp only [fresh, hr, ↓reduceIte]
      exact ih seen out hseen
    · simp only [fresh, hr, ↓reduceIte, List.flatMap_cons, List.foldl_append]
      apply ih (seen ++ [r]) ((f r).foldl addNew out)
      intro r' hr' x hx
      rw [mem_foldl]
      rw [List.mem_append, List.mem_singleton] at hr'
      rcases hr' with h | h
      · exact Or.inl (hseen r' h x hx)
      · subst h
        exact Or.inr hx

/--
Widget order (ADR-0040 §4): the page is the first `limit` distinct ids of the
named series followed by each `watchlist-prices` widget's list in widget
order — a list that several widgets name contributes nothing the second time.
-/
theorem pageSeriesIds_widget_order (named refs : List Nat) (lists : Nat → Option (List Nat))
    (limit : Nat) :
    pageSeriesIds named refs lists limit =
      (dedup (named ++ refs.flatMap (seriesOf lists))).take limit := by
  rw [pageSeriesIds_eq_take, dedup_append, dedup_append, listedSeries, dedup_eq_fresh refs,
    flatMap_fresh (seriesOf lists) refs [] (dedup named) (fun _ h => by simp at h)]

/-- `watchlistListIdsOf` has no repeats and names exactly the referenced lists. -/
theorem listIds_nodup (refs : List Nat) : (dedup refs).Nodup := nodup_dedup refs

theorem listIds_mem (refs : List Nat) (l : Nat) : l ∈ dedup refs ↔ l ∈ refs := mem_dedup refs l

end Research.PageSeries
