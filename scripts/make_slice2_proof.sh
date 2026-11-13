#!/usr/bin/env bash
# Assemble a combined four-store fixture tree under v1/target/slice2-fixture/
# from the kova-core test fixtures, then run a unified kova-scan over it and
# save the JSON as v1/SLICE2_PROOF.json.
#
#   target/slice2-fixture/
#     steam/            fake Steam install (rendered libraryfolders.vdf)
#     library-b/        second Steam library
#     epic-manifests/   *.item manifests (copied as-is)
#     gog-games/        goggame-*.info tree (copied as-is)
#     itch-apps/        game folders with .itch/receipt.json.gz
#                       (gzipped here from the plain receipt fixtures)
set -euo pipefail

V1_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$V1_DIR/crates/kova-core/tests/fixtures"
TREE="$V1_DIR/target/slice2-fixture"
STEAM_ROOT="$TREE/steam"
LIBRARY_B="$TREE/library-b"
EPIC_DIR="$TREE/epic-manifests"
GOG_ROOT="$TREE/gog-games"
ITCH_APPS="$TREE/itch-apps"

rm -rf "$TREE"
mkdir -p "$TREE"

# Steam (same assembly as make_demo_fixture.sh).
cp -r "$FIXTURES/fake-steam" "$STEAM_ROOT"
cp -r "$FIXTURES/library-b" "$LIBRARY_B"
sed -e "s|@STEAM_ROOT@|$STEAM_ROOT|g" \
    -e "s|@LIBRARY_B@|$LIBRARY_B|g" \
    "$STEAM_ROOT/steamapps/libraryfolders.vdf.template" \
    > "$STEAM_ROOT/steamapps/libraryfolders.vdf"

# Epic + GOG fixtures are plain files, usable as-is.
cp -r "$FIXTURES/epic-manifests" "$EPIC_DIR"
cp -r "$FIXTURES/gog-games" "$GOG_ROOT"

# itch receipts must be gzipped on disk.
for game in starfall-drift neon-harbor broken-game; do
    mkdir -p "$ITCH_APPS/$game/.itch"
    python3 -c "
import gzip, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, 'rb') as f_in, gzip.open(dst, 'wb') as f_out:
    f_out.write(f_in.read())
" "$FIXTURES/itch-apps/$game/.itch/receipt.json" \
  "$ITCH_APPS/$game/.itch/receipt.json.gz"
done

cd "$V1_DIR"
cargo run -q -p kova-core --bin kova-scan -- \
    --unified \
    --steam "$STEAM_ROOT" \
    --epic "$EPIC_DIR" \
    --gog "$GOG_ROOT" \
    --itch "$ITCH_APPS" \
    > "$V1_DIR/SLICE2_PROOF.json"

echo "Combined fixture tree: $TREE"
echo "Unified scan written:    $V1_DIR/SLICE2_PROOF.json"
python3 -c "
import json
with open('$V1_DIR/SLICE2_PROOF.json') as f:
    data = json.load(f)
for source in data['sources']:
    print(f\"  {source['source']:6} games={len(source['games'])} skipped={source['skipped']} roots={len(source['roots'])}\")
print(f\"  total_games={data['total_games']}\")
"
