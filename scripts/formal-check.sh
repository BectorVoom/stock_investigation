#!/bin/sh
# Checks the Lean 4 proofs and that the committed conformance vectors are the
# ones the verified models produce. Requires the Lean toolchain (elan).
set -eu
cd "$(dirname "$0")/../formal"
LAKE="$(command -v lake || true)"
[ -n "$LAKE" ] || LAKE="$HOME/.elan/bin/lake"
[ -x "$LAKE" ] || { echo "lake not found: install elan (https://lean-lang.org/install/)" >&2; exit 127; }

"$LAKE" build
if grep -rn --include='*.lean' -E '\b(sorry|admit)\b|^axiom ' ResearchFormal Export.lean; then
	echo "unproved obligation found" >&2
	exit 1
fi
generated="$(mktemp)"
trap 'rm -f "$generated"' EXIT
"$LAKE" exe export-vectors > "$generated"
if ! cmp -s "$generated" vectors.json; then
	echo "formal/vectors.json is stale: run 'lake exe export-vectors > vectors.json' in formal/" >&2
	exit 1
fi
echo "Lean proofs build and conformance vectors are current."
