# KOVA V1 — Functional Launcher

**By Avok Interactive.** KOVA is Dre's gaming OS for PC ("Xbox and Steam had a baby" —
see `../SPEC.md`). V0 was the clickable web prototype. **V1 is the real,
functional launcher**: a Rust core that scans a machine's actual game
libraries — Steam, Epic, GOG, itch, and standalone folders — plus the
built-in Avok shelf, and a Tauri desktop app with a Home / Library /
Settings interface, per-game detail pages, persistent Quick Resume,
and a global-hotkey Quick Panel overlay.

Date: 2026-10-23 · Status: slice 1 (Steam scanner + Tauri app) **built,
test-verified, and proven running on Dre's Mac** (15/15 tests, GUI
compiled and launched). Slice 2 (unified library + overlay) **built,
test-verified, and proven on Dre's Mac** (35/35 core tests, unified
proof run, Quick Panel summoned live). Slice 3 (standalone source +
Avok shelf, product-feel frontend, persistent state, packaging)
**built and test-verified on the build VM** (42/42 core tests, slice-3
proof run) and proven on Dre's Mac. Slice 4 (local-install merge +
real `.app` icon art) is **built and test-verified on the build VM**
(55/55 core tests, slice-4 proof run) and proven on Dre's Mac.
Slice 5 (per-game profiles + library management) is **built and
test-verified on the build VM** (72/72 core tests, slice-5 proof
run); its app-side changes get their first compile on the next Mac
build — see "Honest status" for exactly what was verified where.

## What V1 is

- `kova-core` — a pure-Rust crate (no GUI/Tauri dependencies) that scans
  **six sources into one unified library**. Every scanner emits the same
  `Game` record (`source`, store-specific string `id`, `appid` where the
  store id is numeric, name, installdir, resolved install path, size on
  disk, last-updated, library/discovery root, `launch_uri`) and **never
  lets one bad file kill the scan**: malformed files are counted as
  skipped and skipped.
  - **Steam** — locates an installation (explicit path, or platform
    defaults for Windows, Linux, and macOS — including Linux Flatpak
    Steam), enumerates **all** library folders from
    `steamapps/libraryfolders.vdf` (modern nested **and** old flat
    formats), and parses every `appmanifest_*.acf`. Uses a hand-rolled
    VDF/ACF KeyValues parser (quoted strings, escapes, nested braces,
    `//` comments). Launch: `steam://rungameid/<appid>`.
  - **Epic** (`epic.rs`) — parses Epic Games Launcher `*.item` JSON
    manifests from the manifests directories: macOS
    `~/Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests`,
    Windows `C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests`
    (Linux has no standard Epic install, so no Linux candidates).
    Fields: `DisplayName`, `AppName`, `InstallLocation`, `InstallSize`
    (may be absent → 0). Launch:
    `com.epicgames.launcher://apps/<AppName>?action=launch&silent=true`
    (AppName minimally percent-encoded).
  - **GOG** (`gog.rs`) — walks install roots for `goggame-*.info` JSON
    files (`gameId`, `name`, `playTasks`); the game lives in the folder
    containing the info file. Defaults: Windows
    `C:\Program Files (x86)\GOG Galaxy\Games` and `C:\GOG Games`;
    macOS's `~/Library/Application Support/GOG Galaxy` is Galaxy config,
    not games, so other OSes take explicit roots. Launch:
    `goggalaxy://openGameView/<gameId>`.
  - **itch** (`itch.rs`) — walks the itch apps root (macOS
    `~/Library/Application Support/itch/apps`, Windows
    `%APPDATA%\itch\apps`, Linux `~/.config/itch/apps`) for
    `.itch/receipt.json.gz` receipts — gzipped JSON
    (`{game: {id, title, url}, cave, ...}`), decompressed with
    `flate2`'s pure-Rust backend (no C dependencies). Launch: the
    game's install **folder path**, opened by the OS — itch has no
    launcher URI scheme KOVA can rely on, and the folder contains the
    `.app` bundle / executable. (Documented choice, also noted in
    `itch.rs`.)
  - **Standalone** (`standalone.rs`) — walks game folders (defaults
    `~/Games` and `~/KOVA Games`, or caller-supplied roots) to depth 3
    for directly launchable items: macOS `.app` bundles, Windows
    `.exe` files, Linux binaries (`.x86_64`, `.AppImage`, and on Unix
    extensionless executables). Helper noise — names containing
    `unins`, `setup`, `crash`, or `helper` — is filtered out and
    counted as skipped. Launch: the item's own path, opened by the OS;
    the game's `id` is that absolute path.
  - **Avok shelf** (`avok.rs`) — not a scan: Avok Interactive's own
    live titles, compiled into the core as ordinary `Game` records
    with `source = "avok"`. **Dispatch HQ** (live free web edition)
    and **The Open World** (live on its subreddit), each with its
    real web URL as `launch_uri`.
  - **Unified API** — `scan_all_with(steam_root, standalone_roots)`
    runs all six sources (Steam at the given/auto-located root, the
    other stores at platform defaults, the given standalone folders,
    the built-in shelf); `scan_all(steam_root)` is the same with
    default standalone folders, and `scan_sources(&SourceRoots)`
    takes explicit roots per source (used by tests and the CLI
    flags). All return a `UnifiedLibrary`: one `SourceReport` per
    source — `{ source, roots (found), games, skipped }` — in steam /
    epic / gog / itch / standalone / avok order, plus `total_games`.
    Before the total is calculated, a standalone install that exactly
    matches an Avok title after name normalization is merged into
    that title's shelf record (slice 4 — see below). A source whose
    directories don't exist reports zero games, never an error.
  - **Profiles** (`profiles.rs`) — the per-game user layer (slice
    5): `GameProfile` records (name override, favorite, hidden,
    launch args, art URL override, launch count, last launched)
    keyed by `"<source>:<id>"`, merged over a scan by
    `apply_profiles` into an `AnnotatedLibrary` whose games keep
    their usual JSON shape plus the display fields. Pure and
    fully unit-tested, like the rest of the core.
- `kova-scan` — a CLI binary (in kova-core); the headless end-to-end proof:
  - `kova-scan` → unified scan of all six sources, printed as JSON,
  - `kova-scan <STEAM_ROOT>` → slice-1 behavior: scan just that Steam
    installation, printed as JSON (exit 2 if not found),
  - `kova-scan --unified [--steam DIR] [--epic DIR] [--gog DIR]... [--itch DIR] [--standalone DIR]...`
    → unified scan with explicit roots for any source.
- `app/` — the Tauri 2 launcher app. Plain HTML/CSS/JS frontend (no
  framework) in KOVA identity (Avok cyan on near-black — see
  "Brand — Avok cyan rebrand" below), organized as **Home / Library / Settings**
  views plus a per-game detail page (see "V1 slice 3"), backed by
  Rust commands:
  - `scan_library(path?)` → `kova_core::scan_all_with` + the slice-5
    profile merge — returns the **annotated** library: the unified
    library's usual JSON, with each game additionally carrying
    `key`, `display_name`, `favorite`, `hidden`,
    `art_url_override`, `launch_count`, and `last_launched` (the
    optional path is still the Steam root; standalone folders come
    from the persisted state),
  - `launch_game(game_json)` → launch a game and record it (slice
    5): locally installed games with profile launch arguments are
    launched via `open <path> --args …` on macOS; everything else
    goes through the opener exactly like `launch_uri`. A successful
    launch bumps the profile's `launch_count` / `last_launched`
    and the Quick Resume recents in one state write, and returns
    the updated state.
  - `launch_uri(uri)` → opens a game's `launch_uri` with the OS (Tauri
    opener plugin): store URIs and web URLs via `open_url`, itch /
    standalone filesystem paths via `open_path`. The store's own
    launcher performs the actual launch. Kept for compatibility;
    the frontend launches through `launch_game`.
  - `get_state()` / `set_recent(game_json)` /
    `set_standalone_folders(folders)` → KOVA's persistent state
    (`kova-state.json` in the app data dir): the Quick Resume
    recents list and the user's standalone folders. A missing or
    corrupt state file yields defaults, never an error.
  - `get_profiles()` / `set_profile(key, profile)` /
    `clear_profile(key)` / `set_show_hidden_games(show)` → the
    slice-5 state: per-game profiles keyed by `"<source>:<id>"`,
    plus the Settings "show hidden games" flag (see "V1 slice 5").
  - `game_icon(game_json)` → on macOS, the cached local icon image
    for a standalone / locally installed Avok `.app` game, or null
    when no icon can be produced (see "V1 slice 4").
  - `back_to_main` / `hide_overlay` → overlay window management.
  - The **overlay** is a second window (`overlay.html`): the KOVA
    Quick Panel — see "V1 slice 2" (Quick Resume added in slice 3).

## What V1 is NOT (yet)

- The overlay is a **floating companion panel, not an injected in-game
  overlay** — see the honest scope note under "V1 slice 2".
- No KOVA Store, no accounts — local machine only.
- With the exception of standalone games (which the OS opens
  directly), the app does not launch executables itself; it hands
  each store's launch URI (or, for itch, the install folder) to the
  OS, so the corresponding store app must be installed.
- The bundled PNG icons are the real Avok Interactive mark (see
  "Brand — Avok cyan rebrand" below), and release bundles are
  **unsigned** — see the packaging notes under "V1 slice 3".

## Brand — Avok cyan rebrand (2026-10-23)

Dre replaced the V0–V1.4 identity (graphite + molten amber `#FF7A1A`)
with Avok Interactive's official logo system: a beveled glossy cyan
"A" mark (with the flipped-K negative space) on near-black — the
same mark used as the studio's itch.io avatar.

**Palette** (sampled programmatically from the mark with Pillow —
dominant clusters, not eyeballed):

| Role | Value | Source in the mark |
| --- | --- | --- |
| Accent (`--accent`) | `#00D8F0` | dominant body cyan of the A |
| Accent dim (`--accent-dim`) | `#039BBD` | the A's shadow-side cyan |
| Hover / highlight | `#2CE0F2` | bright bevel cluster |
| Deep cyan (hero / Avok art) | `#0D495D` | deepest saturated cyan |
| Ground (`--graphite`) | `#0B0D0F` | the mark's near-black field |

The wordmark's flat cyan (`#26CED7`) sits in the same family and
corroborates the accent. Button text on the accent is near-black
`#03181D`. Per-source art keeps each store's own brand hue
(Steam blues, GOG purple, itch red, standalone teal, Epic graphite);
only the Avok art and hero moved from amber to the cyan system.
The error red `#FF6B5E` is semantic, not brand.

**The mark in the app:**

- **Header** — both windows show the mark next to the KOVA wordmark.
  It ships as `app/src/logo-asset.js`: a 256×256 PNG (center-cropped
  4% from the canonical mark to clear the source art's white corner
  artifacts), base64-embedded (~98 KB) so the no-build frontend
  needs no asset pipeline. `logo-asset.js` sets the `src` of every
  `img.brand-logo` on load. Regenerate it from the canonical mark
  whenever the brand art changes; don't hand-edit the data URI.
- **App icons** — `app/src-tauri/icons/` (512 / 256 / 128 / 32) were
  generated from the same cropped mark with Pillow: full-bleed
  square art, no rounding added (macOS masks it). These are real
  repo assets and copy to the Mac like any other file.

**Mac build icon flow (this release):** binary icon files can't ride
the file-copy path to the Mac within its transfer limits, so on the
Mac the icon set is regenerated from the full-res mark PNG in
Dre's Downloads instead:

```bash
# one-time: crop the mark's white corner artifacts, then generate
sips -c 1472 1472 ~/Downloads/avok-mark.png --out /tmp/avok-mark-crop.png  # center crop; adjust offsets if the source differs
cd ~/Projects/kova-v1/app
npx tauri icon /tmp/avok-mark-crop.png   # writes the full icon set into src-tauri/icons/
npm run tauri build
```

(`sips -c` center-crops to height×width; the canonical mark is
1600×1600 with ~51px corner artifacts, hence 1472. If a future mark
has clean corners, run `npx tauri icon` on it directly.)

## V1 slice 2 — unified library + KOVA Quick Panel

**Unified library** (kova-core): Epic, GOG, and itch scanners joined
Steam behind `scan_all` / `scan_sources`, all emitting the shared
`Game` record with `source` + `id`. Fixture-tested per store (valid
fixtures with 2 games each, one malformed file per store counted as
skipped, missing-directory = empty report) plus a unified fixture
test. Headless proof: `SLICE2_PROOF.json`, produced by
`scripts/make_slice2_proof.sh`, which assembles a combined four-store
fixture tree and runs `kova-scan --unified` over it — **Steam 4 games /
2 skipped, Epic 2 / 1, GOG 2 / 1, itch 2 / 1 — 10 games total**.

**KOVA Quick Panel** (app): a second Tauri window, created hidden at
startup (`visible: false` in `tauri.conf.json`), 960×600, centered,
frameless, transparent, always-on-top, skipped from the taskbar.

- **Toggle: `CmdOrCtrl+Shift+K`** — registered globally in `lib.rs`
  setup via `tauri-plugin-global-shortcut`. Showing the panel focuses
  it; pressing again hides it. If registration fails (another app owns
  the hotkey), the failure is logged and the app still runs.
- The panel lists the scanned library (via the same `scan_library`
  command; the last scan is cached in the page), each row tagged with
  its source and a **Launch** button (`launch_uri`). **Back to KOVA**
  hides the panel and focuses the main window; **Esc** closes the
  panel; **Rescan** refreshes the cache.

> **Honest overlay scope:** this is a *floating companion panel* — an
> always-on-top window KOVA owns, summoned by a global hotkey. It is
> **not** a Steam-style overlay injected into a running game's
> rendering pipeline: Tauri cannot hook DirectX/Vulkan/Metal
> presentation, and true injection is out of scope for this stack.
> Practically: the panel floats over the desktop and over windowed /
> borderless games; a game in exclusive-fullscreen mode may keep it
> underneath. That is the real, useful thing a Tauri overlay can be —
> quick library access and launching without alt-tabbing to the main
> window — and it is what shipped here.

## V1 slice 3 — product feel + packaged app

**Two new sources** (kova-core):

- **Standalone** — games that didn't come from a store, found by
  walking game folders to depth 3: `.app` bundles, `.exe` files
  (uninstallers / setups / crash reporters / helpers filtered out
  and counted as skipped), Linux `.x86_64` / `.AppImage` /
  extensionless-executable binaries. Defaults are `~/Games` and
  `~/KOVA Games`; the app adds user folders from Settings.
- **The Avok shelf** — Avok Interactive's two live titles as built-in
  records: **Dispatch HQ** (`https://dispatch-hq.onrender.com`, its
  live free web edition) and **The Open World**
  (`https://www.reddit.com/r/The_Open_World/`). Both open in the
  browser via the normal launch path.

Headless proof: `SLICE3_PROOF.json`, produced by
`scripts/make_slice3_proof.sh`, which assembles a combined
six-source fixture tree and runs `kova-scan --unified` over it —
**Steam 4 / 2 skipped, Epic 2 / 1, GOG 2 / 1, itch 2 / 1,
Standalone 4 / 2, Avok 2 / 0 — 16 games total**.

**Persistent state** (app): `kova-state.json` in the app data dir
holds the Quick Resume recents (most recent first, deduped by
source + id, capped at 10) and the user's standalone folders.
Launching a game — from the main window or the Quick Panel —
records it via `set_recent`; Settings edits folders via
`set_standalone_folders`, and `scan_library` feeds them to the
core scan. Missing/corrupt state = defaults, never a crash.

**Product-feel frontend** (app): the main window is now three views
behind a top tab bar, at the V0 prototype's polish level — graphite
+ molten amber, rounded art tiles with hover lift and focus rings.

- **Home** — a hero banner featuring **Dispatch HQ** with an Open
  button; the **Quick Resume** row (your recent launches); and
  "Your shelves" strips: the Avok shelf first, then one strip per
  source that actually has games.
- **Library** — the unified grid with source chips (All / Steam /
  Epic / GOG / itch / Standalone / Avok, each with its count).
  Tiles carry **art**: Steam games load their real library capsule
  from Steam's CDN, falling back to a generated gradient tile
  (game initial + source color) when a capsule is missing; every
  other source uses the generated art. Sizes are formatted
  (GB / MB), and every tile carries its source tag.
- **Game Detail** — click any tile: big art, name, source, size,
  last-updated (locale date), install path, and a Launch/Open
  button.
- **Settings** — the Steam root field, the standalone folders
  editor (add by path / remove, persisted), the Quick Panel hotkey
  hint (rendered as ⌘+Shift+K on macOS, Ctrl+Shift+K elsewhere),
  and an About card.
- **Quick Panel** — gains a **Quick Resume** strip above the
  library list, refreshed from the persisted state each time the
  panel is focused; launching from the panel records recents too.

**Packaging** (Mac, the proven machine):

```bash
cd ~/Projects/kova-v1            # (or this repo's v1/)
cargo test -p kova-core          # 72 tests should pass
cd app && npm install && npm run tauri build
```

The bundle lands at `target/release/bundle/macos/KOVA.app`, with a
`.dmg` alongside it in the same folder. Drag `KOVA.app` to
Applications and it runs like any other app — no Terminal, no dev
server. The bundle metadata now declares category **Game**,
publisher **Avok Interactive**, and a macOS minimum system version
of 11.0.

> **Honest packaging notes:** the bundle is **unsigned** — it's a
> personal build, not a notarized App Store release — so on first
> open macOS Gatekeeper will refuse a plain double-click; use
> **right-click → Open** once, after which it launches normally.
> And two honesty labels from the UI: **Quick Resume means
> "recently launched from KOVA"** — it is a recents list, not
> Steam/Xbox-style saved-state resume; and shelf/store entries only
> ever show a Play/Open button when they carry a real launch
> target.

## V1 slice 4 — local installs + real app icons

**Local-install merge** (kova-core): after all six source reports
are assembled and before `total_games` is calculated,
`scan_sources` folds a standalone install into an Avok shelf record
when their names match exactly after normalization (lowercase, keep
only alphanumeric characters — so `Dispatch HQ.app`,
`dispatch-hq.app`, and `DISPATCH: HQ!` all name the same title; no
fuzzy or partial matching). The merged record:

- keeps `source = "avok"`, the Avok `id` and display name, and
  `library = "built-in"` provenance;
- takes `launch_uri`, `install_path`, and `installdir` from the
  local standalone install, so Open launches the Mac/PC app instead
  of the web edition;
- takes the local `size_on_disk` / `last_updated` when those values
  are nonzero.

Every standalone duplicate that matched the title is removed. If
several installs match, the first in the standalone report's
existing sorted order supplies the launch data, deterministically.
Standalone games with no Avok match are untouched, and **The Open
World stays web-launched unless a local install actually matches
it**. Headless proof: `SLICE4_PROOF.json`, produced by
`scripts/make_slice4_proof.sh`, stages the slice-3 fixture sources
plus `Dispatch HQ.app` (with `Contents/Info.plist`), a second
`dispatch-hq.app`, and a non-matching `Moon Kart.app` — **Steam
4 / 2 skipped, Epic 2 / 1, GOG 2 / 1, itch 2 / 1, Standalone 5 / 2,
Avok 2 / 0 — 17 games total**, with Dispatch HQ appearing exactly
once as Avok with the staged bundle as its local launch/install
path.

**Real app icon art**: kova-core's `app_icon::locate_app_icon`
helper inspects a `.app` bundle's `Contents/Info.plist` for
`CFBundleIconFile` (with or without the `.icns` extension), then
falls back through `Contents/Resources`: the declared icon,
`AppIcon.icns`, `icon.icns`, `Icon.icns`, any other `.icns`
(largest file wins, path breaks ties), and finally any PNG/JPG/JPEG
resource under the same deterministic rule. The Tauri
`game_icon(game_json)` command uses it for standalone / locally
installed Avok games whose `install_path` is a `.app` bundle:

- on macOS, PNG/JPG icons are copied into
  `<app data>/art-cache/`; `.icns` icons are converted to PNG with
  the system tool `/usr/bin/sips`;
- cache files are named deterministically from the game's source +
  id (readable sanitized prefix + stable hash) and reused while
  their modification time is at least as new as the bundle icon's;
- the frontend layers the returned image over the generated art via
  Tauri's `convertFileSrc`, in the main window's tiles/detail and
  the Quick Panel's rows and Quick Resume cards. Generated art
  remains the fallback for every failure.
- Tauri's asset protocol is enabled with its scope limited to
  **`$APPDATA/art-cache/**`** — the protocol can serve KOVA's icon
  cache, not arbitrary user files.

**Installed state in the UI**: the frontend treats an Avok record
with a non-empty `install_path` and a non-http `launch_uri` as a
local install. Its tiles and Quick Panel entries carry an
**Installed** marker; Game Detail gains an **Edition / Status**
row (`Installed on this Mac`, otherwise `Web edition`); and the
Dispatch HQ hero says the Mac app is installed and that Open
launches it. Without a local match, the hero keeps the honest
free-web-edition wording.

> **Honest slice-4 limits:** icon conversion is **macOS-only**
> (`/usr/bin/sips`) and the `game_icon` command returns null on
> other platforms and on any failure. The icon *locator* and merge
> are pure Rust and fully unit/fixture-tested on the build VM; the
> Tauri command, asset-protocol wiring, and frontend layering get
> their **first compile and run on Dre's Mac**, as with the earlier
> slices — the VM verifies the core logic and JavaScript syntax, not
> the GUI (see "Honest status").

## V1 slice 5 — game profiles + library management

**Per-game profiles** (kova-core `profiles.rs`): every game can
carry a `GameProfile`, keyed by `"<source>:<id>"` — a key that
depends only on the game's source and store id, never its name,
so a profile survives renames (including its own name override)
and slice 4's local-install merge. A profile holds:

- `name_override` — the UI shows this instead of the scanned name
  (the scanned record itself is never mutated; the override rides
  alongside it as `display_name`),
- `favorite` / `hidden` flags,
- `launch_args` — extra launch arguments (see the honesty note),
- `art_url_override` — an image URL layered over the game's art,
- `launch_count` / `last_launched` — statistics KOVA records
  itself, updated by the core's `record_launch` helper.

`apply_profiles` merges a profile map over a scan into an
`AnnotatedLibrary`; because the annotated game serializes with
`#[serde(flatten)]` over the `Game` record, the frontend JSON
keeps its established shape with the profile fields added.
`visible_games` filters hidden games out of a view, and
`favorites_first` orders favorites ahead of the rest (by display
name within each group). With an empty profile map the merge is
the identity.

**State v2** (app): `kova-state.json` gains a `profiles` map and
a `show_hidden_games` flag. Both are serde-defaulted, so a state
file written by slices 1–4 loads unchanged with empty profiles —
no migration, and a corrupt file still yields defaults. New
commands: `get_profiles`, `set_profile` (upsert; blank name/art
overrides normalize to "none"), `clear_profile` (the detail
page's Reset), and `set_show_hidden_games`. `launch_game`
replaces the frontend's old `launch_uri` + `set_recent` pair: it
launches, then records the launch in the profile stats and the
recents in a single state write, returning the updated state.
`launch_uri` and `set_recent` remain registered for
compatibility.

**Library management** (frontend):

- **Game Detail** gains a Profile section: a stats line ("Played
  N times · Last played …", or "Never launched from KOVA"), a
  display-name field, an art URL override field, a launch-options
  field, Favorite and Hide toggles, a Save button, and a Reset
  profile button.
- **Library** gains a live **search** box (matches display and
  scanned names) and a **sort** select — Name / Recently played /
  Most played / Source. Favorites carry a ★ badge on their tiles;
  summary and chip counts respect the same hidden rule as the
  grid, so the numbers always match the screen.
- **Home** gains a **Favorites row** (favorited, non-hidden
  games), and hidden games leave the hero, shelves, and Quick
  Resume too.
- **Quick Panel** lists favorites first with a ★ marker and never
  shows hidden games (Quick Resume included).
- **Settings** gains a Library Visibility card: a "Show hidden
  games in the Library" toggle (persisted; it affects only the
  Library view) and the list of hidden games, each with an
  **Unhide** button — hiding is always reversible from the UI.

Headless proof: `SLICE5_PROOF.json`, produced by
`scripts/make_slice5_proof.sh`, which reuses the slice-4 fixture
tree and runs the `slice5_proof` cargo example over it — the
example applies a fixture profile set with the real core helpers:
**17 games scanned; "Counter-Strike 2" renamed to "CS2 Renamed"
(favorite, 3 launches on record); Dota 2 hidden (annotated but
filtered: 16 visible); favorites-first ordering led by CS2
Renamed and Moon Kart; an art override carried on Dispatch HQ;
and `record_launch` shown taking a fresh profile from 0 / never
to 1 / stamped**.

> **Honest slice-5 limits:** launch arguments are real only for
> games **installed on this Mac** — a filesystem-path launch
> target (standalone installs, itch folders, locally merged Avok
> titles). Store URI and web launches have no local process for
> KOVA to pass arguments to, so the detail page disables the
> field for those games and says why ("Launch options apply to
> games installed on this Mac"). On macOS the args are passed via
> `open <path> --args …`, **split on whitespace** — deliberately
> simple: there is no quoting or escaping, so an argument
> containing a space cannot be expressed. On non-macOS platforms
> the opener has no portable args channel, so such games launch
> plainly and the args are ignored. As with slices 1–4, the core
> logic and proof are verified headlessly on the build VM and the
> JavaScript is syntax-checked, but the Tauri commands and UI get
> their **first compile and run on Dre's Mac** (see "Honest
> status").

## V1 slice 5.1 — one profile per game + the icon race

Two targeted fixes on top of slice 5, both found in live use.

**One profile per game.** Quick Resume recents are launch-time
snapshots, and a snapshot can predate slice 4's local-install
merge: Dre's recents held Dispatch HQ as a *standalone* record
while the library holds it as `avok:dispatch-hq`, so a launch
through the Quick Resume tile recorded its stats under the
snapshot's key and the Library record kept a second, separate
profile. The core gained `resolve_recent` / `resolve_recents`
(match by source + id, then by install path for standalone/itch
records — the merged-Avok case — then by a launch URI exactly one
library game carries; no match passes the snapshot through) and
`merge_profiles` / `fold_profile_into` (launch counts sum,
`last_launched` takes the later stamp, favorite/hidden OR,
text fields prefer the surviving profile with the folded one as
fallback). The app caches the most recent scan and runs the
migration wherever state meets that scan — in `scan_library`,
in `get_state` (raw before the session's first scan), and in
`launch_game`, which resolves the launched record before
recording, so a stranded profile folds into the resolved key on
the user's next launch and the migration persists with the
launch's own state write. The frontend re-reads state after a
scan so Quick Resume renders the resolved records. The slice-5
proof now asserts the whole path over the fixture: a standalone
Dispatch HQ snapshot resolves to `avok:dispatch-hq`, and a
profile stranded under the snapshot key folds in — 1 stranded
launch + 1 recorded launch = 2, old key dropped.

**The icon race.** After launching a game, its tile could fall
back to the generated source art instead of the game's real
local icon. The icon `<img>` was created only in the
continuation of the (cached) `game_icon` promise, behind an
`isConnected` check that silently dropped it: on slow first-load
renders the backend's icon conversion gave the tile time to
reach the document, but on fast post-launch re-renders the
continuation could fire while the freshly built tile was still
detached (or belonged to a superseded render generation) and
the icon was lost with no retry. Both windows (`main.js`,
`overlay.js`) now create the `<img>` synchronously while the
tile/row/card is being built and set only its `src` when the
path promise resolves; an empty result or a load error removes
it. No backend change.

## V1 slice 5.2 — Avok title art

**The problem (Dre, live).** KOVA tiles for Avok titles showed the
studio mark — the Avok A — instead of each game's own logo. Cause:
the Avok desktop builds ship the Avok mark as their app icon, and
KOVA layers a locally installed game's bundle icon over its tile,
so Dispatch HQ's tile wore the studio mark. The 5.1 icon race fix
made that layer reliable; 5.2 replaces it for Avok titles that
have art of their own. Frontend only: no core or backend changes.

**The art map.** Both windows (`main.js`, `overlay.js`) carry the
same small map, keyed by the profile key `"<source>:<id>"`:

- `avok:dispatch-hq` → `dispatch-hq-badge.png` (the game's circular
  shield badge)
- `avok:the-open-world` → `the-open-world-mark.png` (the OLD globe
  mark)

**The layering rule.** When a game has a mapped art file, its tile
(and the featured hero, and the Quick Panel row / Quick Resume
card) renders that file — centered, contain-fit, over the
gradient, above the monogram — and SKIPS the local bundle-icon
layer for that record. Records without mapped art behave exactly
as before: bundle icon for local `.app` games, Steam CDN capsule,
monogram fallback. A mapped `<img>` removes itself on load error,
so a missing art file degrades to today's tile — never a broken
tile. A profile art URL override still layers above the mapped
art when the user sets one.

**Mac-side asset flow.** The PNGs are build inputs, not VM files:
they do not exist in this repo tree and are never generated here.
On the Mac they are copied into `app/src/` from the game repos
via binary-safe Mac-internal copies (the same channel that moves
`.app` bundles) before the build, so the frontend's relative
`src` resolves. If a file is absent at build time, tiles simply
fall back — the build does not break.

**Explicitly NOT wired.** A newer The Open World icon exists
elsewhere; Dre has NOT picked between it and the old globe mark,
so the new icon is referenced nowhere in this change. The map
keeps the old mark until he picks.

## V1 slice 6 — controller navigation

**The gap (Dre).** KOVA is console-style, controller-first in
vision, but mouse/keyboard-driven in fact. This slice makes it
fully drivable from a gamepad, with keyboard arrows as the
identical fallback path — so the whole thing is provable without
a controller in hand. Frontend only: no core, backend, launch,
profile, state-format, or art changes.

**The focus system.** One shared module, `app/src/nav.js`,
loaded by both windows before their own script. It computes the
focus order live from the DOM on every move (native controls
plus `tabindex="0"` stops: main-window tiles, panel rows and
Quick Resume cards), so re-renders never strand focus: a
MutationObserver re-anchors to the nearest stop by game key
(tiles/rows/cards carry `data-nav-key`), then by clamped index,
then the first stop. Focus never lands on hidden games or hidden
controls — hidden games are not rendered, and the visibility walk
excludes anything inside a `[hidden]` section. Movement is
spatial first (nearest element in the pressed direction, with
nesting skipped so focus never ping-pongs inside one tile),
falling back to DOM order at a row's edge. The ring is a
`.kova-nav-focus` class in Avok cyan (#00D8F0), visible only
while navigating; any pointer use clears it.

**The button map (standard mapping).**

- D-pad / left stick — move focus (380ms initial pause, then
  accelerating repeats while held; 0.35 stick deadzone)
- A (button 0) — activate (tile → detail page, row/card → launch
  via its Play button, button → click)
- B (button 1) — back (detail → Library → Home; panel → hide)
- Start / Guide (buttons 9 / 16) — Home in the main window,
  back to KOVA in the panel

**Keyboard parity.** Arrows, Enter/Space, and Escape drive the
SAME move/activate/back functions, so keyboard and gamepad never
diverge. Tile Enter/Space handling moved out of `gameTile` into
the navigator; the panel's Escape handler likewise folded into
its back action. Inside a text field, select, or checkbox, keys
stay native (typing, native dropdown, native toggle) — Escape
leaves the field and drops focus to the nearest stop below it.
Opening the panel focuses its first row on first summon; later
summons re-anchor to the last stop when navigating. Closing the
panel returns to the main window, whose navigator re-anchors on
window focus.

**Honest proof note.** The VM cannot open a gamepad or the Tauri
GUI — first visual and live-gamepad proof happens on Dre's Mac,
as with every slice. What is verified here: syntax checks on all
changed JS, and grep confirmation that launch, search, profiles,
and art paths are untouched apart from the focus layer (tile
activation routing, row/card tab stops, view-switch re-anchor).

## Project layout

```
v1/
├── Cargo.toml                  # workspace (default member: kova-core)
├── README.md                   # this file
├── TEST_OUTPUT.txt             # captured `cargo test -p kova-core` output (slice 1)
├── TAURI_CHECK_LOG.txt         # captured `cargo check -p kova-app` attempt (slice 1)
├── SCAN_PROOF.json             # slice-1 kova-scan run against the demo Steam fixture
├── SLICE2_PROOF.json           # slice-2 unified kova-scan run against a combined fixture
├── SLICE3_PROOF.json           # slice-3 unified kova-scan run (six sources)
├── SLICE4_PROOF.json           # slice-4 unified run (local Dispatch merge)
├── SLICE5_PROOF.json           # slice-5 profiles run over the slice-4 fixture
├── scripts/
│   ├── make_demo_fixture.sh    # assembles demo-steam/ from the test fixtures
│   ├── make_icons.py           # legacy placeholder-icon generator (superseded by the Avok mark icons — see "Brand")
│   ├── make_slice2_proof.sh    # assembles target/slice2-fixture/ + writes SLICE2_PROOF.json
│   ├── make_slice3_proof.sh    # assembles target/slice3-fixture/ + writes SLICE3_PROOF.json
│   ├── make_slice4_proof.sh    # assembles target/slice4-fixture/ + writes SLICE4_PROOF.json
│   └── make_slice5_proof.sh    # runs the slice5_proof example -> SLICE5_PROOF.json
├── demo-steam/                 # generated fake Steam install (git-ignored)
├── crates/
│   └── kova-core/
│       ├── src/
│       │   ├── lib.rs          # unified API: SourceReport, UnifiedLibrary, scan_all(_with)
│       │   ├── vdf.rs          # hand-rolled KeyValues (VDF/ACF) parser
│       │   ├── steam.rs        # discovery, libraryfolders, manifests, scan
│       │   ├── epic.rs         # Epic *.item manifest scanner
│       │   ├── gog.rs          # GOG goggame-*.info scanner
│       │   ├── itch.rs         # itch receipt.json.gz scanner (flate2)
│       │   ├── standalone.rs   # standalone folder scanner (.app/.exe/AppImage)
│       │   ├── avok.rs         # the built-in Avok shelf (2 live titles)
│       │   ├── app_icon.rs     # .app bundle icon locator (Info.plist/Resources)
│       │   ├── profiles.rs     # per-game profiles: merge, visibility, ordering, launch stats, recents resolution + profile fold (5.1)
│       │   ├── bin/kova-scan.rs
│       │   └── examples/slice5_proof.rs  # slice-5 proof generator (fixture profiles)
│       └── tests/
│           ├── scan_fixture.rs   # Steam fixture integration tests
│           ├── epic_fixture.rs   # Epic fixture integration tests
│           ├── gog_fixture.rs    # GOG fixture integration tests
│           ├── itch_fixture.rs   # itch fixture integration tests (gzips receipts)
│           ├── standalone_fixture.rs # standalone fixture integration tests
│           ├── slice4_fixture.rs # local-install merge integration test
│           ├── unified_fixture.rs# scan_sources across all fixture trees + shelf
│           └── fixtures/         # fake-steam/, old-steam/, library-b/,
│                                 # epic-manifests/, gog-games/, itch-apps/,
│                                 # standalone-games/
└── app/
    ├── package.json            # Tauri CLI + @tauri-apps/plugin-global-shortcut
    ├── src/                    # frontend: index.html, main.js, styles.css,
    │                           # overlay.html, overlay.js, overlay.css,
    │                           # logo-asset.js (embedded Avok mark)
    └── src-tauri/              # Tauri backend: src/lib.rs (commands + hotkey),
                                # tauri.conf.json (main + overlay windows),
                                # capabilities/, icons/
```

## Run the scanner + tests (any machine, no GUI needed)

Prerequisite: a stable Rust toolchain (`https://rustup.rs`).

```bash
cd v1
cargo test -p kova-core            # 72 tests: parser, formats, store +
                                   # standalone scans, local-install merge,
                                   # app-icon locator, profiles, unified scan
cargo build -p kova-core --bin kova-scan

# Unified scan of a real machine (all six sources, defaults auto-detected):
./target/debug/kova-scan

# Scan one Steam install only (slice-1 behavior):
./target/debug/kova-scan                                  # auto-detect defaults
./target/debug/kova-scan "C:\Program Files (x86)\Steam"   # explicit, Windows
./target/debug/kova-scan ~/.local/share/Steam             # explicit, Linux

# Or reproduce the proofs against the bundled fixtures:
./scripts/make_demo_fixture.sh
./target/debug/kova-scan "$PWD/demo-steam/steam"          # -> SCAN_PROOF.json shape
./scripts/make_slice2_proof.sh                            # -> SLICE2_PROOF.json
./scripts/make_slice3_proof.sh                            # -> SLICE3_PROOF.json
./scripts/make_slice4_proof.sh                            # -> SLICE4_PROOF.json
./scripts/make_slice5_proof.sh                            # -> SLICE5_PROOF.json
```

The Steam fixture install contains 2 libraries and 6 manifests: 4 valid
games (Counter-Strike 2 + Dota 2 in the root, Team Fortress 2 + Rocket
League in library B) and 2 deliberately broken ones (garbage VDF,
missing appid), which the scan skips and counts. Each slice-2 store
fixture has 2 valid games and 1 malformed file. The standalone fixture
has 4 games (a `.app` bundle, an `.exe`, an AppImage, and — on Unix —
an extensionless binary), 2 helper `.exe` files counted as skipped,
and an `.exe` buried past the depth bound that must never be found.

## Build the Tauri GUI

### Prerequisites — Linux (Debian/Ubuntu)

Tauri 2 needs WebKitGTK and friends; without them the Rust GUI crates
cannot compile:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev pkg-config build-essential
```

### Prerequisites — Windows

- Rust (MSVC toolchain) via rustup
- Microsoft C++ Build Tools + WebView2 (preinstalled on Windows 11)

### Build & run (both platforms)

```bash
cd v1/app
npm install            # installs the Tauri CLI + global-shortcut plugin package
npm run tauri dev      # dev build + launch
npm run tauri build    # release bundle
# Equivalent without npm, after the CLI or with cargo:
cargo build -p kova-app        # from v1/
cargo run   -p kova-app
```

### Run on Dre's Mac (the proven path)

Slice 1 was built and launched on Dre's MacBook Air with exactly this
sequence; slice 2 uses the same sequence (the project now also lives
at `~/Projects/kova-v1` on that Mac):

```bash
brew install rust                # if cargo is missing
cd ~/Projects/kova-v1            # (or this repo's v1/)
# icons: the repo's src-tauri/icons/ already hold the Avok mark set;
# on the Mac, regenerate them per "Mac build icon flow" under "Brand" above.
cargo test -p kova-core          # 72 tests should pass
cd app && npm install && npm run tauri dev
```

Once the app is running, press **Cmd+Shift+K** (macOS) /
**Ctrl+Shift+K** (Windows/Linux) to toggle the KOVA Quick Panel.
For the packaged `.app` build instead of the dev run, see
"Packaging" under "V1 slice 3" above.

## Honest status — verified vs not

Verified on the build VM (headless Linux, 2026-10-23):

- **`cargo test -p kova-core`: 72/72 green** — all 55 slice-1–4
  tests still pass, plus 9 slice-5 profile unit tests: key
  stability (source + id only, rename-proof), override precedence
  (name override wins; blank falls back to the scanned name),
  empty-profiles identity, hidden filtering from the visible set,
  favorites-first ordering, the launch update helper (count +
  timestamp, other fields untouched), art/stat carry-through,
  profile JSON defaults + round-trip, and the annotated game's
  flattened serialization shape — and 8 slice-5.1 tests: recents
  resolution by install path (the merged-Avok case) and by
  source + id, no-match passthrough, unique-launch-URI
  resolution, ambiguous shared URIs left unresolved, recents
  de-duplication across snapshots, profile-merge arithmetic and
  flag semantics, and the fold dropping the old key. The 13
  slice-4 tests (5 local-install merge, 7 app-icon locator, 1
  fixture integration) are part of the 55. `cargo check -p
  kova-core` is also clean; the workspace is `cargo fmt`-clean.
- **`kova-scan` unified runs against the combined fixture trees**
  produced `SLICE4_PROOF.json`: **Steam 4 games / 2 skipped, Epic 2 / 1,
  GOG 2 / 1, itch 2 / 1, Standalone 5 / 2, Avok 2 / 0 — 17 games
  total**, with Dispatch HQ exactly once (Avok, locally launched)
  and no standalone Dispatch duplicate; and `SLICE3_PROOF.json`:
  **Steam 4 / 2, Epic 2 / 1, GOG 2 / 1, itch 2 / 1, Standalone 4 / 2,
  Avok 2 / 0 — 16 games total**, unchanged by the slice-4 merge
  because that fixture stages no Avok-matching standalone install.
  Slice-2's proof still stands (`SLICE2_PROOF.json`: 10 games across
  the four stores), as does slice 1's (`SCAN_PROOF.json`: 2 libraries,
  4 games, 2 skipped manifests).
- **The slice-5 proof run** (`scripts/make_slice5_proof.sh`, which
  re-runs the slice-4 script first) produced `SLICE5_PROOF.json`
  via the `slice5_proof` cargo example over the same fixture tree:
  a rename applied (`Counter-Strike 2` → display name "CS2
  Renamed", scanned name intact, favorite with 3 recorded
  launches), one hidden game filtered from the visible set
  (17 annotated → 16 visible), favorites-first ordering led by the
  two fixture favorites, an art URL override carried on Dispatch
  HQ, and the launch update helper verified 0 → 1 with the
  timestamp set. Slice 5.1 extended the run with recents
  resolution (a standalone Dispatch HQ snapshot resolving to
  `avok:dispatch-hq`) and the profile fold (1 stranded launch +
  1 recorded = 2 under the resolved key, the snapshot key
  dropped). All assertions in the script pass.
- **Frontend JS syntax-checked** with `node --check` (`main.js`,
  `overlay.js` — OK); `tauri.conf.json` (bundle metadata plus the
  slice-4 asset protocol, enabled with scope
  `$APPDATA/art-cache/**` only), `capabilities/default.json`, and
  `package.json` all parse as valid JSON; the overlay window is
  present in the config with `url: overlay.html`. Frontend ↔ backend
  wiring reviewed by hand: every `invoke(...)` name and argument in
  JS matches a registered Rust command signature
  (`scan_library{path}`, `launch_uri{uri}`, `launch_game{gameJson}`,
  `get_state{}`, `set_recent{gameJson}`,
  `set_standalone_folders{folders}`, `get_profiles{}`,
  `set_profile{key,profile}`, `clear_profile{key}`,
  `set_show_hidden_games{show}`, `game_icon{gameJson}`,
  `back_to_main{}`, `hide_overlay{}`), and
  every field the JS reads
  (`sources[].{source,roots,games,skipped}`, `total_games`,
  `game.{source,id,appid,name,install_path,size_on_disk,
  last_updated,library,launch_uri}` plus the slice-5 annotation
  fields `game.{key,display_name,favorite,hidden,art_url_override,
  launch_count,last_launched}`,
  `state.{recents,standalone_folders,profiles,show_hidden_games}`,
  and profile entries `{name_override,favorite,hidden,launch_args,
  art_url_override,launch_count,last_launched}`) matches the serde
  output of kova-core's `AnnotatedLibrary`/`Game`/`GameProfile`
  and the app's `KovaState`. The new DOM ids the JS looks up
  (`favorites`, `library-search`, `library-sort`,
  `show-hidden-toggle`, `hidden-list`) were cross-checked against
  `index.html` mechanically.
- **Dependencies**: slice 5 added **no new dependency** — profiles
  are std + serde only, in the core and the app alike. (Slice 4's
  note stands: the merge and icon locator are std-only; the app
  crate enables Tauri 2.12.5's existing `protocol-asset` feature,
  which adds the transitive `http-range` crate to `Cargo.lock`.)

Proven on Dre's Mac (slices 1–4, 2026-10-23): the full sequence
above — `cargo test -p kova-core`, `npm install`, `tauri dev`
compiling and launching the KOVA window; the in-app scan
auto-detected his real Steam root and reported truthfully against
it; the Quick Panel was summoned live with Cmd+Shift+K; the
slice-3 build was packaged as `KOVA.app`, installed in
Applications, and its Home / Library / Settings tabs verified
working in the installed app; and the slice-4 build was likewise
installed, with the locally installed Dispatch HQ shown as one
Avok tile with its real icon art and an Installed marker.

Could NOT be verified on this VM:

- **The slice-5 GUI changes have not been compiled yet** — the same
  system-library wall as slices 1–4 (details below). A fresh
  `cargo check -p kova-app` for slice 5 again stopped at the
  `gdk-sys` build script (`gdk-3.0` not found) before reaching
  KOVA's app code. The app-side Rust parses and is `rustfmt`-clean
  and the new commands are hand-reviewed against the JS, but their
  first compile — and the first real profile edit, hidden-game
  flow, and `open --args` launch through the new UI — happens on
  the Mac run above. (State-file backward compatibility rests on
  the same `#[serde(default)]` field pattern slices 1–4 already
  rely on; the old-file shape is covered by the core's profile
  JSON default tests.)

**Tauri GUI compile attempt on this VM — exact result (slice 1):**
`cargo check -p kova-app` resolved and downloaded the full Tauri 2
dependency tree and compiled through it until the system-library wall:

```
error: failed to run custom build command for `gdk-sys v0.18.2`
pkg-config exited with status code 1
  > pkg-config --libs --cflags gdk-3.0 'gdk-3.0 >= 3.22'
  Package gdk-3.0 was not found in the pkg-config search path.
The system library `gdk-3.0` required by crate `gdk-sys` was not found.
```

(Full log: `TAURI_CHECK_LOG.txt`.) The command was re-run for
slices 4 and 5 and stopped at the identical `gdk-sys` wall. Independent probe agrees:
`pkg-config --exists gtk+-3.0`, `webkit2gtk-4.0`, and `webkit2gtk-4.1`
all report **not present** on this VM, and installing them needs sudo
apt, which was out of scope. So the missing prerequisite is precisely
the **GTK 3 + WebKitGTK development stack** — the failure is a system
library, not application code (compilation never reached a code error).
On a desktop machine, install the Linux prerequisites listed above (or
use Windows with WebView2 + MSVC) and run the build commands above.

## Next slices (toward spec §8 V1)

1. First Mac compile + bundle of slice 5, then prove the profile
   flows end to end: rename a game, favorite it, hide and unhide
   it, and launch a local install with arguments.
2. Per-game *performance* profiles (spec §8 V1/V2) — slice 5
   delivered the profile layer and launch options; performance
   knobs (frame-rate caps, quality presets) are a later,
   platform-deep feature.
3. Signed/notarized release builds for distribution beyond Dre's
   own machines.
