#!/usr/bin/env bash
# Assemble the slice-5 proof: reuse the slice-4 fixture tree and
# unified scan, then run the kova-core `slice5_proof` example over
# it. The example applies a fixture profile set (a rename, a hidden
# game, two favorites, an art override) with the real core
# profile helpers and prints a JSON summary, saved as
# v1/SLICE5_PROOF.json.
#
# The slice-4 script is run first (it also regenerates
# SLICE4_PROOF.json; the shared fixture is unchanged by slice 5).
set -euo pipefail

V1_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TREE="$V1_DIR/target/slice4-fixture"

"$V1_DIR/scripts/make_slice4_proof.sh" > /dev/null

cd "$V1_DIR"
cargo run -q -p kova-core --example slice5_proof -- \
    --steam "$TREE/steam" \
    --epic "$TREE/epic-manifests" \
    --gog "$TREE/gog-games" \
    --itch "$TREE/itch-apps" \
    --standalone "$TREE/standalone-games" \
    > "$V1_DIR/SLICE5_PROOF.json"

echo "Slice-5 proof written: $V1_DIR/SLICE5_PROOF.json"
python3 - "$V1_DIR/SLICE5_PROOF.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as f:
    proof = json.load(f)

annotated = proof["annotated"]
by_name = {g["name"]: g for g in annotated}

# Scan totals: the slice-4 fixture library, unchanged.
assert proof["total_games"] == 17, proof["total_games"]
assert len(annotated) == 17

# Rename applied: display name from the profile, scanned name kept.
cs2 = by_name["Counter-Strike 2"]
assert cs2["display_name"] == "CS2 Renamed", cs2
assert cs2["favorite"] is True
assert cs2["launch_count"] == 3 and cs2["last_launched"] == 1730000000

# Hidden: present in the annotated library, filtered from visible.
dota = by_name["Dota 2"]
assert dota["hidden"] is True
assert proof["visible_count"] == 16
assert dota["key"] not in proof["visible_keys"]
assert len(proof["visible_keys"]) == 16

# Favorites-first ordering: the two favorites lead, renamed CS2
# (display name "CS2 Renamed") ahead of Moon Kart.
ordered = proof["favorites_first_keys"]
assert ordered[0] == cs2["key"], ordered[:2]
assert ordered[1] == by_name["Moon Kart"]["key"], ordered[:2]
assert by_name["Moon Kart"]["favorite"] is True

# Art override carried on the record.
dispatch = by_name["Dispatch HQ"]
assert dispatch["art_url_override"] == "https://example.invalid/dispatch-hq-art.png"

# Launch update helper: 0 / never -> 1 / stamped.
update = proof["launch_update"]
assert update["before_count"] == 0 and update["before_last_launched"] is None
assert update["after_count"] == 1 and update["after_last_launched"] == 1730003600

# Slice 5.1: the standalone Quick Resume snapshot of Dispatch HQ
# resolves to the library's merged Avok record.
resolution = proof["recent_resolution"]
assert resolution["snapshot_key"].startswith("standalone:"), resolution
assert resolution["resolved_key"] == "avok:dispatch-hq", resolution
assert resolution["resolved_source"] == "avok"
assert resolution["resolved_id"] == "dispatch-hq"

# Slice 5.1: the stranded profile folds into the resolved key —
# counts sum (1 stranded + 1 recorded = 2), the later stamp and
# the favorite flag survive, and the old key is gone.
fold = proof["profile_fold"]
assert fold["dst_count_before"] == 1 and fold["src_count"] == 1, fold
assert fold["count_after"] == 2, fold
assert fold["last_launched_after"] == 1730003600, fold
assert fold["favorite_after"] is True, fold
assert fold["old_key_present"] is False, fold

print("  rename applied: 'Counter-Strike 2' -> 'CS2 Renamed' (favorite, 3 launches)")
print("  hidden filtered: Dota 2 annotated but not visible (17 -> 16 visible)")
print("  favorites first: CS2 Renamed, Moon Kart lead the ordering")
print("  art override carried on Dispatch HQ; launch update 0 -> 1 verified")
print("  5.1 resolution: standalone snapshot -> avok:dispatch-hq (merged record)")
print("  5.1 profile fold: 1 stranded + 1 recorded = 2, old key dropped")
PY
