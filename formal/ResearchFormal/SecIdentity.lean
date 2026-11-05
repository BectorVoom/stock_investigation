namespace ResearchFormal.SecIdentity

/-- The completion's release rule: a secondary can never take an identity;
older runners may release an untracked listing, and a confirmed main listing
may release a tracked secondary. Database writes remain lease fenced. -/
def canRelease (primary : Option Bool) (otherTracked : Bool) : Bool :=
  primary != some false && (!otherTracked || primary == some true)

theorem secondary_never_releases (tracked : Bool) :
    canRelease (some false) tracked = false := by
  cases tracked <;> decide

theorem main_can_release_tracked : canRelease (some true) true = true := by
  decide

theorem old_runner_cannot_release_tracked : canRelease none true = false := by
  decide

end ResearchFormal.SecIdentity
