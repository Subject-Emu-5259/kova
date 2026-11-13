#!/usr/bin/env bash
# Assemble a runnable fake Steam installation under v1/demo-steam/ from the
# kova-core test fixtures. A real libraryfolders.vdf must contain absolute
# paths, so the @STEAM_ROOT@ / @LIBRARY_B@ tokens in the fixture templates
# are substituted with this machine's actual demo locations.
set -euo pipefail

V1_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$V1_DIR/crates/kova-core/tests/fixtures"
DEMO="$V1_DIR/demo-steam"
STEAM_ROOT="$DEMO/steam"
LIBRARY_B="$DEMO/library-b"

rm -rf "$DEMO"
mkdir -p "$DEMO"
cp -r "$FIXTURES/fake-steam" "$STEAM_ROOT"
cp -r "$FIXTURES/library-b" "$LIBRARY_B"

sed -e "s|@STEAM_ROOT@|$STEAM_ROOT|g" \
    -e "s|@LIBRARY_B@|$LIBRARY_B|g" \
    "$STEAM_ROOT/steamapps/libraryfolders.vdf.template" \
    > "$STEAM_ROOT/steamapps/libraryfolders.vdf"

echo "Demo Steam install assembled:"
echo "  root:      $STEAM_ROOT"
echo "  library B: $LIBRARY_B"
echo "Scan it with:"
echo "  cargo run -p kova-core --bin kova-scan -- \"$STEAM_ROOT\""
