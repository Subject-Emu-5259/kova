#!/usr/bin/env bash
# Assemble a slice-4 fixture tree under v1/target/slice4-fixture/
# and run a unified kova-scan over it, saving v1/SLICE4_PROOF.json.
#
# The tree starts from the same six-source fixture set as slice 3,
# then stages three extra standalone .app bundles:
#
#   Dispatch HQ.app   the local install that must merge into Avok
#   dispatch-hq.app   a second, differently spelled install of the
#                     same title (also merged/removed, never chosen
#                     because "Dispatch HQ" sorts first)
#   Moon Kart.app     a non-matching standalone game (must remain)
#
# Expected final counts: steam 4/2, epic 2/1, gog 2/1, itch 2/1,
# standalone 5/2 (the four slice-3 games + Moon Kart), avok 2/0 —
# 17 games total. Dispatch HQ appears exactly once, as the Avok
# record, with the first local bundle as its launch/install path.
set -euo pipefail

V1_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$V1_DIR/crates/kova-core/tests/fixtures"
TREE="$V1_DIR/target/slice4-fixture"
STEAM_ROOT="$TREE/steam"
LIBRARY_B="$TREE/library-b"
EPIC_DIR="$TREE/epic-manifests"
GOG_ROOT="$TREE/gog-games"
ITCH_APPS="$TREE/itch-apps"
STANDALONE_ROOT="$TREE/standalone-games"

rm -rf "$TREE"
mkdir -p "$TREE"

# Steam (same assembly as the slice-2/3 proof scripts).
cp -r "$FIXTURES/fake-steam" "$STEAM_ROOT"
cp -r "$FIXTURES/library-b" "$LIBRARY_B"
sed -e "s|@STEAM_ROOT@|$STEAM_ROOT|g" \
    -e "s|@LIBRARY_B@|$LIBRARY_B|g" \
    "$STEAM_ROOT/steamapps/libraryfolders.vdf.template" \
    > "$STEAM_ROOT/steamapps/libraryfolders.vdf"

# Epic + GOG + standalone fixtures are plain files, usable as-is.
cp -r "$FIXTURES/epic-manifests" "$EPIC_DIR"
cp -r "$FIXTURES/gog-games" "$GOG_ROOT"
cp -r "$FIXTURES/standalone-games" "$STANDALONE_ROOT"
# The extensionless Linux binary only counts with its executable bit.
chmod +x "$STANDALONE_ROOT/void-runner" 2>/dev/null || true

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

# Slice-4 staging: real bundle shapes (Contents/Info.plist), with a
# declared icon resource on the install that should win the merge.
DISPATCH_BUNDLE="$STANDALONE_ROOT/Dispatch HQ.app"
mkdir -p "$DISPATCH_BUNDLE/Contents/Resources"
cat > "$DISPATCH_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Dispatch HQ</string>
  <key>CFBundleIconFile</key>
  <string>DispatchIcon</string>
</dict>
</plist>
PLIST
printf 'declared icon fixture\n' > "$DISPATCH_BUNDLE/Contents/Resources/DispatchIcon.icns"
printf 'larger conventional icon fixture\n' > "$DISPATCH_BUNDLE/Contents/Resources/AppIcon.icns"

DUPLICATE_BUNDLE="$STANDALONE_ROOT/dispatch-hq.app"
mkdir -p "$DUPLICATE_BUNDLE/Contents"
cat > "$DUPLICATE_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>dispatch-hq</string>
</dict>
</plist>
PLIST

UNRELATED_BUNDLE="$STANDALONE_ROOT/Moon Kart.app"
mkdir -p "$UNRELATED_BUNDLE/Contents"
cat > "$UNRELATED_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Moon Kart</string>
</dict>
</plist>
PLIST

cd "$V1_DIR"
cargo run -q -p kova-core --bin kova-scan -- \
    --unified \
    --steam "$STEAM_ROOT" \
    --epic "$EPIC_DIR" \
    --gog "$GOG_ROOT" \
    --itch "$ITCH_APPS" \
    --standalone "$STANDALONE_ROOT" \
    > "$V1_DIR/SLICE4_PROOF.json"

echo "Slice-4 fixture tree: $TREE"
echo "Unified scan written: $V1_DIR/SLICE4_PROOF.json"
python3 - "$V1_DIR/SLICE4_PROOF.json" "$DISPATCH_BUNDLE" <<'PY'
import json
import re
import sys

proof_path, dispatch_bundle = sys.argv[1], sys.argv[2]
with open(proof_path) as f:
    data = json.load(f)

for source in data["sources"]:
    print(
        f"  {source['source']:10} games={len(source['games'])} "
        f"skipped={source['skipped']} roots={len(source['roots'])}"
    )
print(f"  total_games={data['total_games']}")

def normalized(name):
    return re.sub(r"[^0-9a-z]+", "", name.lower())

all_games = [g for s in data["sources"] for g in s["games"]]
dispatch_records = [g for g in all_games if normalized(g["name"]) == "dispatchhq"]
assert len(dispatch_records) == 1, dispatch_records
dispatch = dispatch_records[0]
assert dispatch["source"] == "avok", dispatch
assert dispatch["id"] == "dispatch-hq", dispatch
assert dispatch["library"] == "built-in", dispatch
assert dispatch["install_path"] == dispatch_bundle, dispatch
assert dispatch["launch_uri"] == dispatch_bundle, dispatch

standalone = next(s for s in data["sources"] if s["source"] == "standalone")
assert all(normalized(g["name"]) != "dispatchhq" for g in standalone["games"])
assert any(g["name"] == "Moon Kart" for g in standalone["games"])
assert data["total_games"] == sum(len(s["games"]) for s in data["sources"])
print("  Dispatch HQ: once, source=avok, local launch/install path verified")
PY
