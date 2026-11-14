//! KOVA V1 launcher — Tauri backend (Avok Interactive).
//!
//! Commands bridging the plain HTML/JS frontend to `kova-core`:
//!
//! * `scan_library` — run kova-core's unified scan (Steam + Epic +
//!   GOG + itch + standalone + the built-in Avok shelf), apply the
//!   persisted per-game profiles with `kova_core::apply_profiles`,
//!   and return the annotated library as JSON (each game keeps its
//!   usual fields, plus `key`, `display_name`, `favorite`,
//!   `hidden`, `art_url_override`, `launch_count`,
//!   `last_launched`, `total_play_seconds`, `rating`, `cover_art`).
//!   An optional explicit Steam root may be passed; the other stores
//!   use their platform-default locations, and the standalone scanner
//!   uses the folders stored in KOVA's persistent state (see below).
//! * `launch_game` — launch a game (slice 5, extended v1.2.0): the
//!   profile's performance settings resolve into launch arguments
//!   (free-text args + the chosen preset's args, shaped by the
//!   launch-mode bundle), the Metal FPS HUD env var (macOS only),
//!   and a process priority for directly-spawned executables. A
//!   successful launch is recorded in the game's profile
//!   (`launch_count`, `last_launched`) and in the Quick Resume
//!   recents, and — for a locally launched game — a background
//!   watcher records the play session when the game exits (see
//!   "Playtime tracking" below). The updated state is returned.
//! * One profile per game (slice 5.1): recents are launch-time
//!   snapshots, and a snapshot can predate slice 4's local-install
//!   merge (a standalone Dispatch HQ snapshot vs the library's
//!   `avok:dispatch-hq` record). The backend caches the most
//!   recent scan (`LastLibrary`); `scan_library`, `get_state` and
//!   `launch_game` resolve recents against it with
//!   `kova_core::resolve_recents` and fold any profile stranded
//!   under a snapshot key into the resolved library key
//!   (`kova_core::fold_profile_into`), persisting the migration —
//!   so a game has exactly one profile no matter which tile
//!   launched it. `get_state` before the session's first scan has
//!   no library to resolve against and returns the raw state; the
//!   frontend scans immediately after.
//! * `launch_uri` — open a raw `launch_uri` with the OS, via the
//!   Tauri opener plugin: store URIs and web URLs (`steam://`,
//!   Epic/GOG launcher schemes, `https://…`) go to `open_url`;
//!   plain filesystem paths (itch install folders, standalone
//!   games) go to `open_path`. Kept for compatibility; the
//!   frontend launches through `launch_game`.
//! * `get_state` / `set_recent` / `set_standalone_folders` —
//!   KOVA's persistent state, stored as `kova-state.json` in the
//!   app data dir: the Quick Resume recents list (most recent
//!   first, deduped, capped) and the user's standalone game
//!   folders. A missing or corrupt state file yields defaults —
//!   state must never stop the app from launching. The state shape
//!   itself lives in `kova_core::state` (v1.2.0) so its
//!   compatibility and validation are unit-tested without Tauri.
//! * `get_profiles` / `set_profile` / `clear_profile` /
//!   `set_show_hidden_games` — the slice-5 state: per-game
//!   profiles (name override, favorite, hidden, launch args, art
//!   override, launch stats) keyed by `"<source>:<id>"`, plus the
//!   Settings "show hidden games" flag. v1.2.0 extends the profile
//!   with perf settings, playtime, rating, notes, cover art, a
//!   save folder, and a launch mode — all serde-defaulted, so
//!   state files written before v1.2.0 load clean.
//! * `set_gamer_profile` / `set_wishlist` — the v1.1.1 state: the
//!   player's gamertag + avatar + bio (local only — KOVA has no
//!   backend or accounts) and the local Avok wishlist (game keys).
//!   v1.2.0 adds a profile banner to the gamer profile. Both are
//!   additive, serde-defaulted fields: state files written before
//!   v1.1.1 load with an empty profile and an empty wishlist.
//! * v1.2.0 state commands: `set_shelves` (collections, with the
//!   three built-ins seeded when the list is empty), `set_beta`
//!   (beta program + new-UI settings), `set_kids` (kids shelf
//!   settings — storage + validation only; enforcement is the
//!   frontend's job), `set_sync_folder` / `push_state_to_sync` /
//!   `pull_state_from_sync` (cross-device sync through the user's
//!   own cloud folder — last-write-wins, no merge),
//!   `add_journal_entry` / `get_journal` (the per-game journal,
//!   capped at 500 entries), `backup_saves` / `list_save_backups`
//!   / `restore_save` (save-file snapshots under the app data
//!   dir), `get_milestones` (local badges from the player's own
//!   history).
//! * v1.2.0 launch-support commands: `get_perf_presets` (the
//!   engine-known launch-arg preset library), `get_active_session`
//!   (the session timer: what is running now and for how long),
//!   `get_disk_usage` (per-game install sizes, bounded walk —
//!   Steam/web titles report "unknown", never invented),
//!   `import_state` (replace the state from an exported JSON
//!   file), `notify_update_available` (a macOS notification when
//!   an update is found), `get_store_catalog` (the Game Store
//!   catalog — live from the KOVA site when reachable, else the
//!   bundled Avok-only catalog).
//! * `game_icon` — on macOS, extract a locally installed `.app`
//!   game's icon into the app data dir's `art-cache` (copying
//!   PNG/JPG resources, converting `.icns` with the system `sips`)
//!   and return the cached image path. Any failure returns `None`;
//!   local icon art is decorative and must never block rendering.
//! * `back_to_main` / `hide_overlay` — overlay window management.
//!
//! The overlay is a Tauri companion window toggled by the global
//! hotkey **CmdOrCtrl+Shift+K** (registered in `setup`). It is a
//! floating panel over the desktop — not an injected in-game
//! overlay; see the README's "V1 slice 2" section for the honest
//! scope note.
//!
//! The menu-bar tray icon (v1.2.0 §10) shows the recent games
//! (max 8) plus "Show KOVA" and "Quit KOVA". It is built in
//! `setup` from the persisted state and refreshed after every
//! launch; if tray creation fails (no icon, no tray support) the
//! app logs and continues without it. macOS-first; Windows
//! behavior is untested (no Windows run-test yet).
//!
//! ## Playtime tracking (v1.2.0 §2) — how it works, and its limits
//!
//! After a successful local launch, `launch_game` starts a
//! background watcher thread for the game:
//!
//! * Directly-spawned executables (a Windows `.exe`, a Unix
//!   binary) are watched via the child handle — the thread waits
//!   on the process and records the session when it exits.
//! * macOS `.app` launches go through `open`, which exits
//!   immediately, so the thread polls the process list for the
//!   bundle path instead (up to 30s for the app to appear, then
//!   every 5s until it is gone twice in a row).
//! * URI launches (Steam, web) and opener fallbacks have no
//!   process to watch — no session is recorded.
//!
//! When the game exits, the watcher loads the freshest state,
//! adds the session to the profile (`total_play_seconds`,
//! `last_session_seconds`, `last_session_end`), and saves. Known
//! limits, all honest: if KOVA quits mid-session the session is
//! lost (the watcher dies with the app); a game already running
//! before KOVA launched it gets no session — KOVA cannot know
//! when that session started, so it records session 0 rather
//! than over-counting; a second launch of a game already being
//! watched starts no second watcher (no double-count); and state
//! writes are whole-file, so a watcher save racing a concurrent
//! profile edit can lose one of the two writes (last-write-wins,
//! the same pattern the rest of the app already uses).
//!
//! ## Performance honesty limits (v1.2.0 §1)
//!
//! * Process priority applies only to directly-spawned
//!   executables (Unix `nice -n 10` for Low). `.app` launches via
//!   `open` ignore it — `open` starts the process, KOVA cannot
//!   set its priority. On Windows the value is stored but not
//!   applied in v1.2.0 (it needs Win32 `SetPriorityClass`, a new
//!   FFI dependency this release does not take on). High priority
//!   is not attempted via `nice` on Unix: a negative increment
//!   needs privileges, and a failed `nice` would exit before the
//!   game started.
//! * The Metal FPS HUD (`MTL_HUD_ENABLED=1`) is macOS only, Metal
//!   games only, and for `open` launches it relies on `open
//!   --env`, whose availability varies by macOS version.
//! * There is no FPS cap control on macOS — none exists for a
//!   launcher to use, so none is built. The only "cap" is a
//!   launch-arg preset the game itself honors (e.g. Source
//!   `+fps_max`), and the UI labels presets "sent to the game;
//!   the game decides what to honor."
//! * KOVA LIVE (§9) needs no core change: the gamertag IS the
//!   LIVE tag. No new state, no new command — UI copy only.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::time::Duration;

use kova_core::{
    BetaSettings, GamerProfile, JournalEntry, KidsSettings, KovaState, SaveBackup, Shelf,
    SyncSettings,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

/// How many games the Quick Resume list remembers.
const RECENTS_CAP: usize = 10;

fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("kova-state.json"))
}

/// Load the persisted state. Any problem — no path, missing file,
/// corrupt JSON — returns defaults instead of an error. The
/// built-in shelves are seeded when the list is empty (fresh
/// install, or a pre-1.2.0 file).
fn load_state(app: &tauri::AppHandle) -> KovaState {
    let mut state: KovaState = (|| {
        let path = state_path(app)?;
        let contents = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&contents).ok()
    })()
    .unwrap_or_default();
    state.ensure_builtin_shelves();
    state
}

fn save_state(app: &tauri::AppHandle, state: &KovaState) -> Result<(), String> {
    let path = state_path(app).ok_or("could not resolve the app data directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// The most recent unified scan, cached by `scan_library`
/// (slice 5.1). Recents resolution and profile folding need a
/// library to resolve against; commands that run before the
/// session's first scan find `None` here and work with the raw
/// state, exactly as slices 1–5 did.
#[derive(Default)]
struct LastLibrary(Mutex<Option<kova_core::UnifiedLibrary>>);

fn cached_library(last: &LastLibrary) -> Option<kova_core::UnifiedLibrary> {
    last.0.lock().ok().and_then(|guard| guard.clone())
}

fn cache_library(last: &LastLibrary, library: &kova_core::UnifiedLibrary) {
    if let Ok(mut guard) = last.0.lock() {
        *guard = Some(library.clone());
    }
}

/// The currently watched play session, if any (v1.2.0 §2): the
/// most recent launch's game key and start time, for the session
/// timer (`get_active_session`). One slot: launching a second
/// game while one is running replaces the record (each game's own
/// watcher still records its session on exit — the record is only
/// what the timer UI shows).
#[derive(Debug, Clone)]
struct ActiveSessionInfo {
    game_key: String,
    started_at: i64,
}

#[derive(Default)]
struct ActiveSession(Mutex<Option<ActiveSessionInfo>>);

/// Slice 5.1 migration: resolve the state's recents against the
/// library and fold any profile stranded under a snapshot key
/// into the resolved library key, so the state never keeps two
/// profiles (or two recents entries) for one game. Returns whether
/// anything changed; callers persist the state when it did. The
/// migration is idempotent — once resolved, nothing changes.
fn migrate_state(state: &mut KovaState, library: &kova_core::UnifiedLibrary) -> bool {
    let mut changed = false;
    // Fold first, while the recents still name the snapshot keys.
    let folds: Vec<(String, String)> = state
        .recents
        .iter()
        .map(|recent| {
            (
                kova_core::profile_key(recent),
                kova_core::profile_key(&kova_core::resolve_recent(recent, library)),
            )
        })
        .collect();
    for (old_key, new_key) in folds {
        if old_key != new_key && state.profiles.contains_key(&old_key) {
            kova_core::fold_profile_into(&mut state.profiles, &old_key, &new_key);
            changed = true;
        }
    }
    let resolved = kova_core::resolve_recents(&state.recents, library);
    if resolved != state.recents {
        state.recents = resolved;
        changed = true;
    }
    changed
}

#[tauri::command]
fn get_state(app: tauri::AppHandle, last: tauri::State<'_, LastLibrary>) -> KovaState {
    let mut state = load_state(&app);
    // With a scan on record, hand back the migrated state (and
    // persist the migration) so recents never render under a
    // stale snapshot identity. Before the first scan there is
    // nothing to resolve against — return the raw state.
    if let Some(library) = cached_library(&last) {
        if migrate_state(&mut state, &library) {
            let _ = save_state(&app, &state);
        }
    }
    state
}

/// Move a game to the front of the recents list (de-duplicated by
/// source + id, capped at [`RECENTS_CAP`]). Shared by `set_recent`
/// and `launch_game`.
fn record_recent(state: &mut KovaState, game: &kova_core::Game) {
    state
        .recents
        .retain(|g| !(g.source == game.source && g.id == game.id));
    state.recents.insert(0, game.clone());
    state.recents.truncate(RECENTS_CAP);
}

/// Record a launched game at the front of the recents list and
/// return the updated state. Kept for compatibility; the frontend
/// now launches through `launch_game`, which records recents (and
/// launch statistics) itself.
#[tauri::command]
fn set_recent(app: tauri::AppHandle, game_json: serde_json::Value) -> Result<KovaState, String> {
    let game: kova_core::Game =
        serde_json::from_value(game_json).map_err(|e| format!("invalid game record: {e}"))?;
    let mut state = load_state(&app);
    record_recent(&mut state, &game);
    save_state(&app, &state)?;
    Ok(state)
}

/// Replace the standalone folder list (from Settings) and return
/// the updated state.
#[tauri::command]
fn set_standalone_folders(
    app: tauri::AppHandle,
    folders: Vec<String>,
) -> Result<KovaState, String> {
    let mut state = load_state(&app);
    state.standalone_folders = folders
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    save_state(&app, &state)?;
    Ok(state)
}

// ---------------------------------------------------------------------------
// Per-game profiles (slice 5, extended v1.2.0)
// ---------------------------------------------------------------------------

/// Maximum characters in a profile note (v1.2.0).
const NOTE_MAX_CHARS: usize = 2000;

/// Return the persisted profile map (`"<source>:<id>"` →
/// `GameProfile`).
#[tauri::command]
fn get_profiles(app: tauri::AppHandle) -> kova_core::Profiles {
    load_state(&app).profiles
}

/// Upsert one game's profile and return the updated map. The
/// text fields are normalized on the way in: a blank name override
/// or art override means "none", so the state file never carries
/// empty-string overrides that the core would have to second-guess.
///
/// v1.2.0 validation: the rating keeps only 1–5 (anything else is
/// dropped to `None`); the note is capped at 2000 characters; the
/// cover art is capped like the avatar (rejected over the cap —
/// the frontend downscales uploads first, so this is a backstop);
/// the launch mode keeps only `"quiet"` / `"full"`; the priority
/// is normalized to `"low"` / `"normal"` / `"high"`; the preset id
/// is trimmed but an unknown id is KEPT, not dropped — a preset
/// added by a newer version must survive a round-trip through an
/// older one, and an unknown id resolves to no args at launch.
/// Playtime fields are preserved exactly as sent: the watcher
/// owns them, and the frontend round-trips them.
#[tauri::command]
fn set_profile(
    app: tauri::AppHandle,
    key: String,
    mut profile: kova_core::GameProfile,
) -> Result<kova_core::Profiles, String> {
    let blank_to_none = |value: Option<String>| {
        value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    profile.name_override = blank_to_none(profile.name_override);
    profile.art_url_override = blank_to_none(profile.art_url_override);
    profile.launch_args = profile.launch_args.trim().to_string();
    profile.rating = profile.rating.filter(|rating| (1..=5).contains(rating));
    profile.note = profile
        .note
        .map(|note| truncate_chars(note.trim(), NOTE_MAX_CHARS))
        .filter(|note| !note.is_empty());
    if let Some(cover) = profile.cover_art.take() {
        let cover = cover.trim().to_string();
        if cover.len() > AVATAR_MAX_CHARS {
            return Err("cover art image is too large (over the 200 KB cap)".to_string());
        }
        profile.cover_art = if cover.is_empty() { None } else { Some(cover) };
    }
    profile.save_folder = blank_to_none(profile.save_folder);
    profile.launch_mode =
        blank_to_none(profile.launch_mode).filter(|mode| mode == "quiet" || mode == "full");
    profile.perf_launch_preset = blank_to_none(profile.perf_launch_preset);
    profile.perf_priority =
        kova_core::Priority::parse(&profile.perf_priority).as_str().to_string();
    let mut state = load_state(&app);
    state.profiles.insert(key, profile);
    save_state(&app, &state)?;
    Ok(state.profiles)
}

/// Remove one game's profile entirely (the Game Detail "Reset
/// profile" action): the game returns to its scanned name and art,
/// unfavorited, unhidden, with its launch statistics cleared.
/// Returns the updated map.
#[tauri::command]
fn clear_profile(app: tauri::AppHandle, key: String) -> Result<kova_core::Profiles, String> {
    let mut state = load_state(&app);
    state.profiles.remove(&key);
    save_state(&app, &state)?;
    Ok(state.profiles)
}

/// Persist the Settings "show hidden games" toggle and return the
/// updated state.
#[tauri::command]
fn set_show_hidden_games(app: tauri::AppHandle, show: bool) -> Result<KovaState, String> {
    let mut state = load_state(&app);
    state.show_hidden_games = show;
    save_state(&app, &state)?;
    Ok(state)
}

// ---------------------------------------------------------------------------
// Gamer profile + wishlist (v1.1.1; banner added v1.2.0)
// ---------------------------------------------------------------------------

/// Limits for the gamer profile, enforced on the way in so the
/// state file stays small no matter what the frontend sends. The
/// avatar cap is in characters of the data-URL string: a ~200 KB
/// image base64-encodes to roughly 273,000 characters, so 300,000
/// leaves headroom for the `data:image/...;base64,` prefix. The
/// banner and per-game cover art share the same cap.
const GAMERTAG_MAX_CHARS: usize = 32;
const BIO_MAX_CHARS: usize = 160;
const AVATAR_MAX_CHARS: usize = 300_000;

/// Truncate a string to at most `max` characters (on char
/// boundaries — never splits a multi-byte character).
fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Replace the gamer profile (gamertag, avatar, bio, banner) and
/// return the updated state. Text is trimmed and capped; an avatar
/// or banner data URL over the cap is rejected (the frontend
/// downscales uploads before sending, so this is a backstop, not
/// the normal path).
#[tauri::command]
fn set_gamer_profile(
    app: tauri::AppHandle,
    profile: GamerProfile,
) -> Result<KovaState, String> {
    let gamertag = truncate_chars(profile.gamertag.trim(), GAMERTAG_MAX_CHARS);
    let bio = truncate_chars(profile.bio.trim(), BIO_MAX_CHARS);
    let avatar = profile.avatar.trim().to_string();
    if avatar.len() > AVATAR_MAX_CHARS {
        return Err("avatar image is too large (over the 200 KB cap)".to_string());
    }
    let banner = match profile.banner {
        Some(banner) => {
            let banner = banner.trim().to_string();
            if banner.len() > AVATAR_MAX_CHARS {
                return Err("banner image is too large (over the 200 KB cap)".to_string());
            }
            if banner.is_empty() {
                None
            } else {
                Some(banner)
            }
        }
        None => None,
    };
    let mut state = load_state(&app);
    state.gamer_profile = GamerProfile {
        gamertag,
        avatar,
        bio,
        banner,
    };
    save_state(&app, &state)?;
    Ok(state)
}

/// Replace the local Avok wishlist (profile keys
/// `"<source>:<id>"`) and return the updated state. Entries are
/// trimmed, empties dropped, duplicates removed (first occurrence
/// wins). Only Avok titles belong on the wishlist — the shelf is
/// what KOVA showcases — so non-`avok:` keys are dropped.
#[tauri::command]
fn set_wishlist(app: tauri::AppHandle, wishlist: Vec<String>) -> Result<KovaState, String> {
    let mut cleaned: Vec<String> = Vec::new();
    for key in wishlist {
        let key = key.trim().to_string();
        if key.starts_with("avok:") && !cleaned.contains(&key) {
            cleaned.push(key);
        }
    }
    let mut state = load_state(&app);
    state.wishlist = cleaned;
    save_state(&app, &state)?;
    Ok(state)
}

// ---------------------------------------------------------------------------
// Shelves, beta, kids, sync, journal, save backups, milestones (v1.2.0)
// ---------------------------------------------------------------------------

/// Replace the whole shelf list (from the Library / collections
/// UI) and return the updated state. Validation lives in
/// `kova_core::validate_shelves`: names and ids are trimmed,
/// empty shelves dropped, ids de-duplicated, unknown game keys
/// dropped (a key is "known" when it appears in the profiles,
/// recents, cached library, or the built-in Avok shelf), and the
/// list capped at 50 shelves. An empty result re-seeds the three
/// built-ins — they are permanent fixtures, so an empty shelf
/// list is never kept.
#[tauri::command]
fn set_shelves(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    shelves: Vec<Shelf>,
) -> Result<KovaState, String> {
    let mut state = load_state(&app);
    let mut known = state.known_game_keys();
    if let Some(library) = cached_library(&last) {
        for game in library.all_games() {
            known.insert(kova_core::profile_key(game));
        }
    }
    state.shelves = kova_core::validate_shelves(shelves, &known);
    state.ensure_builtin_shelves();
    save_state(&app, &state)?;
    Ok(state)
}

/// Replace the beta program settings and return the updated state.
/// Unknown `ui` / `accent` / `density` values fall back to their
/// defaults (never an error — the UI must always have a usable
/// shell); see `kova_core::normalize_beta`.
#[tauri::command]
fn set_beta(app: tauri::AppHandle, beta: BetaSettings) -> Result<KovaState, String> {
    let mut state = load_state(&app);
    state.beta = kova_core::normalize_beta(beta);
    save_state(&app, &state)?;
    Ok(state)
}

/// Replace the kids shelf settings and return the updated state.
/// Storage + validation only: `allowed_keys` are trimmed and
/// de-duplicated, and a malformed `used_date` is reset to today
/// with the counter zeroed (see `kova_core::normalize_kids`).
/// Enforcement — hiding unapproved games, stopping at the daily
/// limit, rolling the counter over at midnight — is the
/// frontend's job.
#[tauri::command]
fn set_kids(app: tauri::AppHandle, kids: KidsSettings) -> Result<KovaState, String> {
    let mut state = load_state(&app);
    let today = kova_core::today_date_string();
    state.kids = kova_core::normalize_kids(kids, &today);
    save_state(&app, &state)?;
    Ok(state)
}

/// The state file's name inside the sync folder — the same name
/// as the local state file, so a folder listing reads plainly.
const SYNC_STATE_FILENAME: &str = "kova-state.json";

/// Set (or clear, with `None` / "") the sync folder and return
/// the updated state. A set folder must already exist and be a
/// directory — KOVA writes into it, it does not pick it. This
/// changes only the folder; `sync.enabled` is separate.
#[tauri::command]
fn set_sync_folder(
    app: tauri::AppHandle,
    folder: Option<String>,
) -> Result<KovaState, String> {
    let folder = folder
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty());
    if let Some(folder) = &folder {
        if !Path::new(folder).is_dir() {
            return Err(format!(
                "sync folder does not exist or is not a folder: {folder}"
            ));
        }
    }
    let mut state = load_state(&app);
    state.sync.folder = folder;
    save_state(&app, &state)?;
    Ok(state)
}

/// Push the current state into the sync folder and return the
/// updated sync settings (with `last_push_at` stamped). Requires
/// a folder; `sync.enabled` does not gate a manual push — the
/// user asked for it. Last-write-wins: the push overwrites
/// whatever the folder held.
#[tauri::command]
fn push_state_to_sync(app: tauri::AppHandle) -> Result<SyncSettings, String> {
    let mut state = load_state(&app);
    let folder = state
        .sync
        .folder
        .clone()
        .ok_or("no sync folder is set — pick one in Settings first")?;
    let dir = PathBuf::from(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not use the sync folder ({e})"))?;
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SYNC_STATE_FILENAME), json).map_err(|e| e.to_string())?;
    state.sync.last_push_at = Some(now_epoch_seconds());
    save_state(&app, &state)?;
    Ok(state.sync.clone())
}

/// Pull the state from the sync folder, replacing the local state
/// wholesale, and return the new state. Last-write-wins, no merge:
/// local changes made since the last push are discarded, and the
/// pulled state's own sync settings (including its folder and
/// `last_push_at`) come with it — only `last_pull_at` is stamped
/// fresh, so it always reflects this machine's last pull. The UI
/// must confirm before calling this.
#[tauri::command]
fn pull_state_from_sync(app: tauri::AppHandle) -> Result<KovaState, String> {
    let current = load_state(&app);
    let folder = current
        .sync
        .folder
        .clone()
        .ok_or("no sync folder is set — pick one in Settings first")?;
    let path = PathBuf::from(&folder).join(SYNC_STATE_FILENAME);
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read the synced state file ({e})"))?;
    let mut pulled: KovaState = serde_json::from_str(&contents)
        .map_err(|e| format!("the synced state file is not valid KOVA state ({e})"))?;
    pulled.normalize_imported();
    pulled.sync.last_pull_at = Some(now_epoch_seconds());
    save_state(&app, &pulled)?;
    Ok(pulled)
}

/// Add a journal entry for a game and return the updated journal
/// (oldest first, capped at 500 — the oldest entries are trimmed).
/// An empty game key or empty text is rejected; text over 2000
/// characters is truncated (see `JournalEntry::new`).
#[tauri::command]
fn add_journal_entry(
    app: tauri::AppHandle,
    game_key: String,
    text: String,
) -> Result<Vec<JournalEntry>, String> {
    let entry = JournalEntry::new(&game_key, now_epoch_seconds(), &text)
        .ok_or("a journal entry needs a game and some text")?;
    let mut state = load_state(&app);
    kova_core::push_journal_entry(&mut state.journal, entry);
    save_state(&app, &state)?;
    Ok(state.journal)
}

/// Return the journal (also available via `get_state`).
#[tauri::command]
fn get_journal(app: tauri::AppHandle) -> Vec<JournalEntry> {
    load_state(&app).journal
}

// ---------------------------------------------------------------------------
// Save backups (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// Snapshots live under `<app data>/save-backups/<game>/<name>/`.
const SAVE_BACKUPS_DIR: &str = "save-backups";
/// A snapshot's manifest marker: the source folder the snapshot
/// was copied from, so a restore can find the target even if the
/// profile's folder changed since. Never copied back into the
/// game (the copy helper skips it).
const BACKUP_SOURCE_MARKER: &str = ".kova-backup-source";
/// Copy bounds: a snapshot bigger than this is refused outright
/// (a partial backup is worse than none — the partial directory
/// is removed and the command errors).
const BACKUP_MAX_FILES: usize = 20_000;
const BACKUP_MAX_BYTES: u64 = 1 << 30; // 1 GiB

fn save_backups_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(SAVE_BACKUPS_DIR))
}

/// A file-name-safe directory for one game's snapshots: a
/// sanitized key plus a stable hash (the key itself can contain
/// slashes — standalone ids are paths — so the raw key is never
/// used as a directory name).
fn backup_game_dir(root: &Path, game_key: &str) -> PathBuf {
    let sanitized: String = game_key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let trimmed = sanitized.trim_matches('-');
    let stem = if trimmed.is_empty() { "game" } else { trimmed };
    let hash = stable_cache_hash(game_key);
    root.join(format!("{stem}-{hash:016x}"))
}

/// The result of a bounded recursive copy.
struct CopyOutcome {
    files: u64,
    bytes: u64,
    skipped: u64,
}

/// Copy a directory tree, bounded by file count and total bytes.
/// Symlinks are skipped (never followed), unreadable entries are
/// skipped and counted, and the backup-source marker is never
/// copied (it is KOVA's own bookkeeping, not game data). Exceeding
/// either bound errors out — the caller removes the partial
/// destination.
fn copy_dir_bounded(
    src: &Path,
    dst: &Path,
    max_files: usize,
    max_bytes: u64,
) -> Result<CopyOutcome, String> {
    fn walk(
        src: &Path,
        dst: &Path,
        max_files: usize,
        max_bytes: u64,
        outcome: &mut CopyOutcome,
    ) -> Result<(), String> {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    outcome.skipped += 1;
                    continue;
                }
            };
            let Ok(file_type) = entry.file_type() else {
                outcome.skipped += 1;
                continue;
            };
            if file_type.is_symlink() {
                outcome.skipped += 1;
                continue;
            }
            if file_type.is_file() && entry.file_name() == BACKUP_SOURCE_MARKER {
                continue;
            }
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if file_type.is_dir() {
                walk(&from, &to, max_files, max_bytes, outcome)?;
            } else if file_type.is_file() {
                if outcome.files as usize >= max_files {
                    return Err(format!(
                        "save folder has more than {max_files} files — refusing a partial backup"
                    ));
                }
                let size = std::fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
                if outcome.bytes.saturating_add(size) > max_bytes {
                    return Err(
                        "save folder is larger than the 1 GiB backup cap — refusing a partial backup"
                            .to_string(),
                    );
                }
                match std::fs::copy(&from, &to) {
                    Ok(copied) => {
                        outcome.files += 1;
                        outcome.bytes = outcome.bytes.saturating_add(copied);
                    }
                    Err(_) => {
                        outcome.skipped += 1;
                    }
                }
            }
        }
        Ok(())
    }
    let mut outcome = CopyOutcome {
        files: 0,
        bytes: 0,
        skipped: 0,
    };
    walk(src, dst, max_files, max_bytes, &mut outcome)?;
    Ok(outcome)
}

/// The display name for a game key, for save-folder auto-detection:
/// the cached library record first, then a recents snapshot, then
/// the profile's name override, then the id half of the key.
fn game_display_name(state: &KovaState, last: &LastLibrary, game_key: &str) -> Option<String> {
    if let Some(library) = cached_library(last) {
        if let Some(game) = library
            .all_games()
            .into_iter()
            .find(|g| kova_core::profile_key(g) == game_key)
        {
            return Some(game.name.clone());
        }
    }
    if let Some(game) = state
        .recents
        .iter()
        .find(|g| kova_core::profile_key(g) == game_key)
    {
        return Some(game.name.clone());
    }
    if let Some(name) = state
        .profiles
        .get(game_key)
        .and_then(|p| p.name_override.clone())
    {
        return Some(name);
    }
    game_key.split_once(':').map(|(_, id)| id.to_string())
}

/// Best-effort save-folder auto-detection (macOS only): a folder
/// under `~/Library/Application Support` whose name matches the
/// game — exact first, then a normalized-name match (case,
/// spaces, and punctuation ignored). Other platforms return
/// `None`: without a profile save folder there is nothing honest
/// to guess.
#[cfg(target_os = "macos")]
fn autodetect_save_folder(game_name: &str) -> Option<PathBuf> {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)?
        .join("Library/Application Support");
    if !base.is_dir() {
        return None;
    }
    let exact = base.join(game_name);
    if exact.is_dir() {
        return Some(exact);
    }
    let wanted = kova_core::normalize_game_name(game_name);
    let entries = std::fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if kova_core::normalize_game_name(&name) == wanted {
            return Some(path);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn autodetect_save_folder(_game_name: &str) -> Option<PathBuf> {
    None
}

fn no_save_folder_error(name: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        format!("no save folder found for \"{name}\" under ~/Library/Application Support — set one in the game's profile")
    }
    #[cfg(not(target_os = "macos"))]
    {
        format!("no save folder is set for \"{name}\" — set one in the game's profile")
    }
}

/// Resolve where a game's saves live: the profile's `save_folder`
/// when set (an error when it is set but does not exist — a config
/// mistake worth reporting, not silently working around), else
/// auto-detection by game name.
fn resolve_save_folder(
    state: &KovaState,
    last: &LastLibrary,
    game_key: &str,
) -> Result<PathBuf, String> {
    if let Some(folder) = state
        .profiles
        .get(game_key)
        .and_then(|p| p.save_folder.clone())
    {
        let folder = folder.trim().to_string();
        if !folder.is_empty() {
            let path = PathBuf::from(&folder);
            if path.is_dir() {
                return Ok(path);
            }
            return Err(format!(
                "the save folder set for this game does not exist: {folder}"
            ));
        }
    }
    let name = game_display_name(state, last, game_key).ok_or_else(|| {
        "KOVA does not know this game — set its save folder in the game's profile".to_string()
    })?;
    autodetect_save_folder(&name).ok_or_else(|| no_save_folder_error(&name))
}

/// What `backup_saves` reports: the stored record, where the
/// snapshot came from, and what was copied (and skipped).
#[derive(Serialize)]
struct BackupResult {
    backup: SaveBackup,
    source_path: String,
    files_copied: u64,
    files_skipped: u64,
}

/// Snapshot a game's save files into
/// `<app data>/save-backups/<game>/backup-<epoch>/` and return
/// the backup record plus where it came from. The source is the
/// profile's `save_folder` when set, else auto-detection by game
/// name (macOS `~/Library/Application Support`, best-effort — the
/// error says what was tried when nothing is found). An empty or
/// unreadable source errors instead of recording a hollow backup.
#[tauri::command]
fn backup_saves(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    game_key: String,
) -> Result<BackupResult, String> {
    let mut state = load_state(&app);
    let source = resolve_save_folder(&state, &last, &game_key)?;
    let root = save_backups_root(&app).ok_or("could not resolve the app data directory")?;
    let game_dir = backup_game_dir(&root, &game_key);
    std::fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let now = now_epoch_seconds();
    let mut backup_name = format!("backup-{now}");
    let mut attempt = 0;
    while game_dir.join(&backup_name).exists() {
        attempt += 1;
        backup_name = format!("backup-{now}-{attempt}");
    }
    let dest = game_dir.join(&backup_name);
    let outcome = match copy_dir_bounded(&source, &dest, BACKUP_MAX_FILES, BACKUP_MAX_BYTES) {
        Ok(outcome) => outcome,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    if outcome.files == 0 {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!(
            "the save folder for this game is empty (or unreadable): {}",
            source.display()
        ));
    }
    let _ = std::fs::write(
        dest.join(BACKUP_SOURCE_MARKER),
        source.to_string_lossy().as_bytes(),
    );
    let backup = SaveBackup {
        game_key: game_key.clone(),
        backed_up_at: now,
        size_bytes: outcome.bytes,
        backup_name: backup_name.clone(),
    };
    state.save_backups.push(backup.clone());
    save_state(&app, &state)?;
    Ok(BackupResult {
        backup,
        source_path: source.to_string_lossy().into_owned(),
        files_copied: outcome.files,
        files_skipped: outcome.skipped,
    })
}

/// List a game's backups, newest last (insertion order). Records
/// whose snapshot folder is gone from disk are pruned (and the
/// prune is persisted) — the list never shows a backup that
/// cannot be restored.
#[tauri::command]
fn list_save_backups(app: tauri::AppHandle, game_key: String) -> Vec<SaveBackup> {
    let mut state = load_state(&app);
    if let Some(root) = save_backups_root(&app) {
        let before = state.save_backups.len();
        state.save_backups.retain(|backup| {
            backup_game_dir(&root, &backup.game_key)
                .join(&backup.backup_name)
                .is_dir()
        });
        if state.save_backups.len() != before {
            let _ = save_state(&app, &state);
        }
    }
    state
        .save_backups
        .into_iter()
        .filter(|backup| backup.game_key == game_key)
        .collect()
}

/// Restore a save backup into the game's live save folder.
/// Safety first: the current saves are snapshotted into a
/// `pre-restore-<epoch>` backup BEFORE anything is overwritten —
/// if that safety backup fails, the restore aborts and nothing
/// changes. The restore itself is a merge: the snapshot's files
/// overwrite the target's, and files in the target that the
/// snapshot does not have are left alone (never deleted).
/// Returns the safety-net backup created before the restore — or
/// the restored backup itself when there were no current saves to
/// protect (the target did not exist yet).
#[tauri::command]
fn restore_save(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    game_key: String,
    backup_name: String,
) -> Result<SaveBackup, String> {
    let mut state = load_state(&app);
    let root = save_backups_root(&app).ok_or("could not resolve the app data directory")?;
    let record = state
        .save_backups
        .iter()
        .find(|b| b.game_key == game_key && b.backup_name == backup_name)
        .cloned()
        .ok_or_else(|| format!("no backup named \"{backup_name}\" for this game"))?;
    let snapshot = backup_game_dir(&root, &game_key).join(&backup_name);
    if !snapshot.is_dir() {
        return Err(format!(
            "the backup folder for \"{backup_name}\" is gone from disk"
        ));
    }
    // Where do the saves live now? Prefer the source recorded in
    // the snapshot itself (it is the only record when the user
    // deleted their saves — the reason they are restoring), then
    // the profile / auto-detect.
    let marker = snapshot.join(BACKUP_SOURCE_MARKER);
    let target = std::fs::read_to_string(&marker)
        .ok()
        .map(|contents| PathBuf::from(contents.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| resolve_save_folder(&state, &last, &game_key).ok())
        .ok_or_else(|| {
            "could not find where this game's saves live — set the save folder in the game's profile"
                .to_string()
        })?;
    let mut pre_restore: Option<SaveBackup> = None;
    if target.is_dir() {
        let game_dir = backup_game_dir(&root, &game_key);
        std::fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
        let now = now_epoch_seconds();
        let mut name = format!("pre-restore-{now}");
        let mut attempt = 0;
        while game_dir.join(&name).exists() {
            attempt += 1;
            name = format!("pre-restore-{now}-{attempt}");
        }
        let dest = game_dir.join(&name);
        let outcome = copy_dir_bounded(&target, &dest, BACKUP_MAX_FILES, BACKUP_MAX_BYTES)
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(&dest);
                format!("could not back up the current saves before restoring ({e}) — restore aborted, nothing changed")
            })?;
        let _ = std::fs::write(
            dest.join(BACKUP_SOURCE_MARKER),
            target.to_string_lossy().as_bytes(),
        );
        let safety = SaveBackup {
            game_key: game_key.clone(),
            backed_up_at: now,
            size_bytes: outcome.bytes,
            backup_name: name,
        };
        state.save_backups.push(safety.clone());
        pre_restore = Some(safety);
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    copy_dir_bounded(&snapshot, &target, BACKUP_MAX_FILES, BACKUP_MAX_BYTES).map_err(|e| {
        format!("restore failed partway ({e}) — your previous saves are in the pre-restore backup")
    })?;
    save_state(&app, &state)?;
    Ok(pre_restore.unwrap_or(record))
}

// ---------------------------------------------------------------------------
// Milestones (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// What `get_milestones` returns: the stored earned ids (every
/// badge ever earned, in the order earned — stored so a badge
/// never re-fires) plus the current progress of all five
/// milestones, with honest numbers.
#[derive(Serialize)]
struct MilestonesResponse {
    earned: Vec<String>,
    progress: Vec<kova_core::MilestoneStatus>,
}

/// Compute the local milestones from the player's own history and
/// return them, storing any newly earned ids. Stats come from the
/// profiles (total launches, distinct games launched, total
/// playtime), the Finished shelf, and the cached library scan —
/// before the session's first scan the library size reads 0 and
/// the Collector milestone simply shows no progress yet.
#[tauri::command]
fn get_milestones(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
) -> MilestonesResponse {
    let mut state = load_state(&app);
    let mut total_launches: u64 = 0;
    let mut distinct_games_launched: u64 = 0;
    let mut total_play_seconds: u64 = 0;
    for profile in state.profiles.values() {
        total_launches = total_launches.saturating_add(profile.launch_count);
        total_play_seconds = total_play_seconds.saturating_add(profile.total_play_seconds);
        if profile.launch_count > 0 {
            distinct_games_launched += 1;
        }
    }
    let finished_shelf_count = state
        .shelves
        .iter()
        .find(|shelf| shelf.id == "finished")
        .map(|shelf| shelf.game_keys.len() as u64)
        .unwrap_or(0);
    let library_size = cached_library(&last)
        .map(|library| library.total_games as u64)
        .unwrap_or(0);
    let stats = kova_core::MilestoneStats {
        total_launches,
        finished_shelf_count,
        total_play_seconds,
        library_size,
        distinct_games_launched,
    };
    let progress = kova_core::compute_milestones(&stats);
    let mut changed = false;
    for id in kova_core::earned_ids(&progress) {
        if !state.milestones.contains(&id) {
            state.milestones.push(id);
            changed = true;
        }
    }
    if changed {
        let _ = save_state(&app, &state);
    }
    MilestonesResponse {
        earned: state.milestones.clone(),
        progress,
    }
}

// ---------------------------------------------------------------------------
// Perf presets + active session (v1.2.0 §1/§2)
// ---------------------------------------------------------------------------

/// Return the engine-known launch-arg preset library (see
/// `kova_core::perf`). The frontend sends a preset *id* back via
/// `set_profile`; the backend looks it up at launch.
#[tauri::command]
fn get_perf_presets() -> Vec<kova_core::PerfPreset> {
    kova_core::PERF_PRESETS.to_vec()
}

/// The session timer's answer: what is running now (the most
/// recent launch), when it started, and how long it has run.
/// `None` when nothing is being watched.
#[derive(Serialize)]
struct ActiveSessionResponse {
    game_key: String,
    started_at: i64,
    elapsed_seconds: u64,
}

#[tauri::command]
fn get_active_session(active: tauri::State<'_, ActiveSession>) -> Option<ActiveSessionResponse> {
    let guard = active.0.lock().ok()?;
    let current = guard.as_ref()?;
    let elapsed = now_epoch_seconds()
        .saturating_sub(current.started_at)
        .max(0) as u64;
    Some(ActiveSessionResponse {
        game_key: current.game_key.clone(),
        started_at: current.started_at,
        elapsed_seconds: elapsed,
    })
}

// ---------------------------------------------------------------------------
// Disk usage (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// Walk bounds for one game's install folder, and for the whole
/// `get_disk_usage` call. A walk that hits a bound reports the
/// partial size with `complete: false` — a lower bound, never a
/// made-up total.
const DISK_WALK_MAX_FILES_PER_GAME: usize = 50_000;
const DISK_WALK_MAX_FILES_TOTAL: usize = 250_000;
const DISK_WALK_MAX_DEPTH: usize = 16;

/// One game's disk usage. `size_bytes` is `None` when the game
/// has no local install KOVA can measure (a Steam URI title, a
/// web title, a missing folder, or a walk the file budget cut
/// short before measuring anything) — "unknown", never invented.
/// `complete: false` means the walk hit a bound and the size is
/// a partial lower bound.
#[derive(Serialize)]
struct GameDiskUsage {
    game_key: String,
    name: String,
    size_bytes: Option<u64>,
    complete: bool,
}

#[derive(Serialize)]
struct DiskUsage {
    games: Vec<GameDiskUsage>,
    total_bytes: u64,
    unknown_count: usize,
}

/// Sum the bytes under `root`, bounded: at most
/// `DISK_WALK_MAX_FILES_PER_GAME` files, `DISK_WALK_MAX_DEPTH`
/// levels deep, and the shared `budget` of files for the whole
/// call. Symlinks are never followed; unreadable entries are
/// skipped. Returns `(bytes, complete)`.
fn dir_size_bounded(root: &Path, budget: &mut usize) -> (u64, bool) {
    let mut total: u64 = 0;
    let mut complete = true;
    let mut files: usize = 0;
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if files >= DISK_WALK_MAX_FILES_PER_GAME || *budget == 0 {
            complete = false;
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if files >= DISK_WALK_MAX_FILES_PER_GAME || *budget == 0 {
                complete = false;
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if depth + 1 <= DISK_WALK_MAX_DEPTH {
                    stack.push((path, depth + 1));
                } else {
                    complete = false;
                }
            } else if file_type.is_file() {
                files += 1;
                *budget = budget.saturating_sub(1);
                if let Ok(meta) = entry.metadata() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    (total, complete)
}

/// Per-game install sizes from the cached library (or a fresh
/// scan when none is cached), plus the total of the known sizes
/// and how many games are unknown. Local installs are measured by
/// walking their install folder; a game with no install path (a
/// store URI or web title) reports `size_bytes: null`.
#[tauri::command]
fn get_disk_usage(app: tauri::AppHandle, last: tauri::State<'_, LastLibrary>) -> DiskUsage {
    let library = match cached_library(&last) {
        Some(library) => library,
        None => {
            let state = load_state(&app);
            let standalone_roots: Vec<PathBuf> =
                state.standalone_folders.iter().map(PathBuf::from).collect();
            let library = kova_core::scan_all_with(None, standalone_roots);
            cache_library(&last, &library);
            library
        }
    };
    let mut budget = DISK_WALK_MAX_FILES_TOTAL;
    let mut games = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut unknown_count = 0;
    for game in library.all_games() {
        let key = kova_core::profile_key(game);
        let path = &game.install_path;
        if path.as_os_str().is_empty() || !path.exists() {
            unknown_count += 1;
            games.push(GameDiskUsage {
                game_key: key,
                name: game.name.clone(),
                size_bytes: None,
                complete: true,
            });
            continue;
        }
        if path.is_file() {
            match std::fs::metadata(path).map(|m| m.len()) {
                Ok(size) => {
                    total_bytes = total_bytes.saturating_add(size);
                    games.push(GameDiskUsage {
                        game_key: key,
                        name: game.name.clone(),
                        size_bytes: Some(size),
                        complete: true,
                    });
                }
                Err(_) => {
                    unknown_count += 1;
                    games.push(GameDiskUsage {
                        game_key: key,
                        name: game.name.clone(),
                        size_bytes: None,
                        complete: true,
                    });
                }
            }
            continue;
        }
        let (size, complete) = dir_size_bounded(path, &mut budget);
        // An incomplete walk that measured nothing (the file
        // budget ran out first) is "unknown", not "0 bytes".
        let size_bytes = if complete || size > 0 { Some(size) } else { None };
        if let Some(size) = size_bytes {
            total_bytes = total_bytes.saturating_add(size);
        } else {
            unknown_count += 1;
        }
        games.push(GameDiskUsage {
            game_key: key,
            name: game.name.clone(),
            size_bytes,
            complete,
        });
    }
    DiskUsage {
        games,
        total_bytes,
        unknown_count,
    }
}

// ---------------------------------------------------------------------------
// State import, update notifications, Game Store catalog (v1.2.0)
// ---------------------------------------------------------------------------

/// Replace the whole state from an exported state JSON string
/// (the state backup/restore flow, §7) and return the new state.
/// The JSON must parse as a `KovaState`; anything else is
/// rejected with a clear error and the local state is untouched.
/// The UI must confirm before calling this — the import discards
/// the current state (last-write-wins, no merge).
#[tauri::command]
fn import_state(app: tauri::AppHandle, json: String) -> Result<KovaState, String> {
    let mut state: KovaState = serde_json::from_str(&json)
        .map_err(|e| format!("that file is not a valid KOVA state file ({e})"))?;
    state.normalize_imported();
    save_state(&app, &state)?;
    Ok(state)
}

/// Quote a string for AppleScript: backslash- and quote-escaped,
/// newlines flattened to spaces, wrapped in double quotes.
#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
        .replace('\r', " ");
    format!("\"{escaped}\"")
}

/// Show a macOS notification that an update is available
/// (v1.2.0 §7): `osascript display notification`, no new
/// dependency. Other platforms are an `Ok` no-op — the Settings
/// badge is the update signal there. The version and notes are
/// truncated for the notification body.
#[tauri::command]
fn notify_update_available(version: String, notes: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let version = truncate_chars(version.trim(), 32);
        let notes = truncate_chars(notes.trim(), 160);
        let body = if notes.is_empty() {
            format!("KOVA {version} is available.")
        } else {
            format!("KOVA {version} is available. {notes}")
        };
        let script = format!(
            "display notification {} with title {}",
            applescript_string(&body),
            applescript_string("KOVA Update Available")
        );
        let status = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("osascript failed with status {status}"));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (version, notes);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Game Store catalog (v1.2.0 §8, Phase A)
// ---------------------------------------------------------------------------

/// The live catalog: a static JSON on the KOVA site, updated when
/// a listing is approved (the same pattern as the OTA feed — no
/// new backend). Listings are approved by BOTH Melo and Dre.
const STORE_CATALOG_URL: &str = "https://kova-99837.wasmer.app/store/catalog.json";
/// Fetch timeout, in seconds. The command blocks for at most
/// this long before falling back to the bundled catalog.
const STORE_CATALOG_TIMEOUT_SECS: u64 = 10;

/// One store listing. `download_url` is the dev's own link —
/// KOVA does not host game files in Phase A. `art` is `None`
/// when a listing carries no art, and the UI falls back to the
/// in-app Avok art.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoreListing {
    id: String,
    title: String,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    art: Option<String>,
    download_url: String,
    developer: String,
    free: bool,
    version: String,
}

/// The catalog file's shape: a schema version plus the listings.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoreCatalog {
    version: u32,
    listings: Vec<StoreListing>,
}

/// What `get_store_catalog` returns: where the catalog came from
/// (`"live"` — fetched from the site — or `"bundled"` — the
/// offline fallback) plus the catalog itself.
#[derive(Debug, Clone, Serialize)]
struct StoreCatalogResponse {
    source: String,
    catalog: StoreCatalog,
}

/// The bundled fallback catalog: Avok's own two titles, with the
/// SAME names, descriptions, and download URLs the app already
/// uses for the Avok shelf (`AVOK_GAME_INFO` in main.js and the
/// launch URIs in `kova_core::avok`). No URL is invented here.
fn bundled_store_catalog() -> StoreCatalog {
    StoreCatalog {
        version: 1,
        listings: vec![
            StoreListing {
                id: "dispatch-hq".to_string(),
                title: "Dispatch HQ".to_string(),
                description: "Run the city's emergency services from the dispatch desk — fire, police, and EMS. Every call is a decision, and every decision has a consequence."
                    .to_string(),
                art: Some("https://kova-99837.wasmer.app/assets/dispatch-hq.jpg".to_string()),
                download_url: "https://dispatch-hq.onrender.com".to_string(),
                developer: "Avok Interactive".to_string(),
                free: true,
                version: "0.55.0".to_string(),
            },
            StoreListing {
                id: "the-open-world".to_string(),
                title: "The Open World".to_string(),
                description: "A life sim that lives on Reddit — build a life, earn, explore, and shape a world other players share."
                    .to_string(),
                art: Some("https://kova-99837.wasmer.app/assets/open-world.jpg".to_string()),
                download_url: "https://www.reddit.com/r/The_Open_World/".to_string(),
                developer: "Avok Interactive".to_string(),
                free: true,
                version: "0.108.29".to_string(),
            },
        ],
    }
}

/// Fetch the Game Store catalog. No HTTP client dependency: the
/// fetch runs through the system `curl` (ships with macOS and
/// modern Windows), capped at 10 seconds. Any failure — no curl,
/// no network, a bad response, bad JSON — falls back to the
/// bundled Avok-only catalog, and `source` says which one the
/// frontend got.
#[tauri::command]
fn get_store_catalog() -> StoreCatalogResponse {
    let live = std::process::Command::new("curl")
        .arg("-fsSL")
        .arg("--max-time")
        .arg(STORE_CATALOG_TIMEOUT_SECS.to_string())
        .arg(STORE_CATALOG_URL)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<StoreCatalog>(&output.stdout).ok());
    match live {
        Some(catalog) => StoreCatalogResponse {
            source: "live".to_string(),
            catalog,
        },
        None => StoreCatalogResponse {
            source: "bundled".to_string(),
            catalog: bundled_store_catalog(),
        },
    }
}

// ---------------------------------------------------------------------------
// Local app icon art
// ---------------------------------------------------------------------------

/// Keep a cache key to a conservative, file-name-safe spelling of
/// a source/id pair. The stable hash below is the actual identity;
/// the readable prefix only helps a human inspect the cache.
fn sanitize_cache_part(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    let trimmed = sanitized.trim_matches(|c| c == '-' || c == '_');
    if trimmed.is_empty() {
        "game".to_string()
    } else {
        trimmed.to_string()
    }
}

/// FNV-1a hash for deterministic, dependency-free cache names.
/// This is a cache key, not a security digest.
fn stable_cache_hash(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn icon_cache_is_current(icon: &Path, output: &Path) -> bool {
    let Ok(output_meta) = std::fs::metadata(output) else {
        return false;
    };
    if output_meta.len() == 0 {
        return false;
    }
    let Ok(icon_meta) = std::fs::metadata(icon) else {
        return false;
    };
    match (icon_meta.modified(), output_meta.modified()) {
        (Ok(icon_time), Ok(output_time)) => output_time >= icon_time,
        // If a platform cannot give us both timestamps, an existing
        // non-empty cache file is safer than converting on every
        // render; a changed icon still has a changed source path/id
        // in normal use.
        _ => true,
    }
}

/// Extract a local `.app` game's icon into
/// `<app data>/art-cache` and return the cached image path.
///
/// macOS only: other platforms return `None`, as does any game that
/// is not a standalone or Avok record pointing at a `.app` bundle.
/// Failures are deliberately quiet and return `None` — the frontend
/// always keeps its generated art fallback.
#[tauri::command]
fn game_icon(app: tauri::AppHandle, game_json: serde_json::Value) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    let game: kova_core::Game = serde_json::from_value(game_json).ok()?;
    if game.source != "standalone" && game.source != "avok" {
        return None;
    }
    let bundle = game.install_path.clone();
    let is_app_bundle = bundle.is_dir()
        && bundle
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase() == "app")
            .unwrap_or(false);
    if !is_app_bundle {
        return None;
    }

    let icon = kova_core::locate_app_icon(&bundle)?;
    let icon_ext = icon
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())?;
    if !["icns", "png", "jpg", "jpeg"].contains(&icon_ext.as_str()) {
        return None;
    }
    // The command contract returns a PNG cache path: PNG/JPG
    // resources are copied into it below, and `.icns` resources are
    // converted into it with `sips`.
    let output_ext = "png";

    let cache_dir = app.path().app_data_dir().ok()?.join("art-cache");
    std::fs::create_dir_all(&cache_dir).ok()?;
    let key = format!(
        "{}-{}",
        sanitize_cache_part(&game.source),
        sanitize_cache_part(&game.id)
    );
    let hash = stable_cache_hash(&format!("{}\0{}", game.source, game.id));
    let output = cache_dir.join(format!("{key}-{hash:016x}.{output_ext}"));
    if icon_cache_is_current(&icon, &output) {
        return Some(output.to_string_lossy().into_owned());
    }

    // Build beside the final file, then rename into place, so a
    // failed copy/conversion never leaves a half-written image for
    // the asset protocol to serve.
    let temp = cache_dir.join(format!(".{key}-{hash:016x}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let built = if icon_ext == "icns" {
        std::process::Command::new("/usr/bin/sips")
            .arg("-s")
            .arg("format")
            .arg("png")
            .arg(&icon)
            .arg("--out")
            .arg(&temp)
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
            && std::fs::metadata(&temp)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
    } else {
        std::fs::copy(&icon, &temp).is_ok()
    };
    if !built {
        let _ = std::fs::remove_file(&temp);
        return None;
    }
    if std::fs::rename(&temp, &output).is_err() {
        let _ = std::fs::remove_file(&output);
        if std::fs::rename(&temp, &output).is_err() {
            let _ = std::fs::remove_file(&temp);
            return None;
        }
    }
    Some(output.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Launching (slice 5, reworked v1.2.0) + playtime watching
// ---------------------------------------------------------------------------

/// Unix epoch seconds for launch timestamps.
fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether this game record points at a macOS `.app` bundle (a
/// directory ending in `.app`). macOS only: a folder ending in
/// `.app` elsewhere is just a folder.
#[cfg(target_os = "macos")]
fn launch_target_is_app_bundle(game: &kova_core::Game) -> bool {
    let target = Path::new(&game.launch_uri);
    target.is_dir()
        && target
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("app"))
            .unwrap_or(false)
}

/// Whether a process whose command line contains the bundle path
/// is currently running (macOS only). Used both for the
/// already-running check before a launch and by the playtime
/// watcher afterwards. Best-effort: it matches on a substring of
/// the process list, so a Terminal command mentioning the path
/// could false-positive — rare, and the failure mode is only a
/// missed session, never a wrong launch.
#[cfg(target_os = "macos")]
fn app_is_running(bundle: &Path) -> bool {
    let needle = bundle.to_string_lossy();
    let output = std::process::Command::new("/bin/ps")
        .arg("-ax")
        .arg("-o")
        .arg("command=")
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.lines().any(|line| line.contains(needle.as_ref()))
        }
        _ => false,
    }
}

/// Whether the game is already running before KOVA launches it
/// (macOS `.app` bundles only — checked via the process list). A
/// game already running gets no playtime watcher: KOVA cannot
/// know when that session started, so it records no session for
/// this launch (session 0) rather than over-counting.
fn game_already_running(game: &kova_core::Game) -> bool {
    #[cfg(target_os = "macos")]
    {
        launch_target_is_app_bundle(game) && app_is_running(Path::new(&game.launch_uri))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = game;
        false
    }
}

/// Whether a launch target is a file KOVA can spawn directly:
/// any file with an execute bit on Unix, a `.exe` on Windows.
/// (`.app` bundles are directories, not files — they take the
/// `open` path.)
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
}

/// Spawn a directly-launchable executable with its arguments.
/// Unix Low priority wraps the spawn in `nice -n 10` (`nice`
/// execs its target, so the child handle KOVA waits on IS the
/// game process, not a wrapper). High priority is not attempted
/// via `nice` (see `Priority::nice_increment`). The Metal HUD env
/// var is set for direct spawns on macOS when the profile asks
/// for it. Windows spawns plainly: priority is stored but not
/// applied there in v1.2.0.
fn spawn_direct(
    path: &Path,
    settings: &kova_core::LaunchSettings,
) -> std::io::Result<std::process::Child> {
    #[cfg(unix)]
    let mut cmd = match settings.priority.nice_increment() {
        Some(increment) => {
            let mut wrapped = std::process::Command::new("nice");
            wrapped.arg("-n").arg(increment.to_string()).arg(path);
            wrapped
        }
        None => std::process::Command::new(path),
    };
    #[cfg(not(unix))]
    let mut cmd = std::process::Command::new(path);
    cmd.args(&settings.args);
    if settings.show_fps && cfg!(target_os = "macos") {
        cmd.env("MTL_HUD_ENABLED", "1");
    }
    cmd.spawn()
}

/// What a launch produced, for the playtime watcher.
enum LaunchOutcome {
    /// No process to watch: a URI launch, a folder/document
    /// opened through the OS, or the opener fallback.
    Unwatched,
    /// A directly spawned child process — watched via its handle.
    Spawned(std::process::Child),
    /// A macOS `.app` launched via `open` — watched by polling
    /// the process list for the bundle path. (macOS only: this
    /// variant is never constructed on other platforms.)
    #[allow(dead_code)]
    Bundle(PathBuf),
}

/// Perform the actual OS launch for a game, applying the resolved
/// launch settings.
///
/// Store URIs and web URLs carry a scheme (`steam://`,
/// `goggalaxy://`, `com.epicgames.launcher://`, `https://…`) and
/// go to the opener's `open_url` — no local process, no settings
/// apply, no session is watched.
///
/// Local paths branch three ways:
/// * macOS `.app` bundle: `open` (with `--env
///   MTL_HUD_ENABLED=1` when the FPS HUD is on — `open --env`
///   availability varies by macOS version — and `--args` when
///   arguments exist). Priority is a no-op here: `open` starts
///   the process, KOVA cannot set its priority.
/// * A directly executable file (a Windows `.exe`, a Unix
///   binary): spawned directly, so priority and the HUD env var
///   apply and the child handle is watchable. A spawn failure
///   falls back to the opener (the pre-1.2.0 behavior) instead
///   of failing the launch.
/// * Anything else (folders, documents): the opener — or `open
///   --args` on macOS when arguments exist, the pre-1.2.0 path.
fn do_launch(
    app: &tauri::AppHandle,
    game: &kova_core::Game,
    settings: &kova_core::LaunchSettings,
) -> Result<LaunchOutcome, String> {
    let target = game.launch_uri.clone();
    if target.contains("://") {
        let opener = app.opener();
        opener
            .open_url(target, None::<String>)
            .map_err(|e| e.to_string())?;
        return Ok(LaunchOutcome::Unwatched);
    }
    let path = PathBuf::from(&target);
    #[cfg(target_os = "macos")]
    if launch_target_is_app_bundle(game) {
        let mut cmd = std::process::Command::new("open");
        if settings.show_fps {
            cmd.arg("--env").arg("MTL_HUD_ENABLED=1");
        }
        cmd.arg(&path);
        if !settings.args.is_empty() {
            cmd.arg("--args").args(&settings.args);
        }
        let status = cmd.status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("macOS `open` failed with status {status}"));
        }
        return Ok(LaunchOutcome::Bundle(path));
    }
    if is_executable_file(&path) {
        match spawn_direct(&path, settings) {
            Ok(child) => return Ok(LaunchOutcome::Spawned(child)),
            Err(e) => {
                eprintln!(
                    "KOVA: direct spawn failed for {} ({e}); falling back to the opener",
                    path.display()
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    if !settings.args.is_empty() || settings.show_fps {
        let mut cmd = std::process::Command::new("open");
        if settings.show_fps {
            cmd.arg("--env").arg("MTL_HUD_ENABLED=1");
        }
        cmd.arg(&path);
        if !settings.args.is_empty() {
            cmd.arg("--args").args(&settings.args);
        }
        let status = cmd.status().map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(LaunchOutcome::Unwatched);
        }
        return Err(format!("macOS `open` failed with status {status}"));
    }
    let opener = app.opener();
    opener
        .open_path(target, None::<String>)
        .map_err(|e| e.to_string())?;
    Ok(LaunchOutcome::Unwatched)
}

/// Register a session as the active one for the timer UI.
/// Returns false when a session for the SAME game is already
/// active — the caller then skips starting a second watcher, so
/// a double launch never double-counts playtime. A session for a
/// different game replaces the record (each game's own watcher
/// still records its session on exit).
fn try_register_session(active: &ActiveSession, key: &str, started_at: i64) -> bool {
    let Ok(mut guard) = active.0.lock() else {
        return false;
    };
    if let Some(current) = guard.as_ref() {
        if current.game_key == key {
            return false;
        }
    }
    *guard = Some(ActiveSessionInfo {
        game_key: key.to_string(),
        started_at,
    });
    true
}

/// Clear the active-session record, but only if it still refers
/// to this session (a later launch may have replaced it).
fn unregister_session(active: &ActiveSession, key: &str, started_at: i64) {
    if let Ok(mut guard) = active.0.lock() {
        if let Some(current) = guard.as_ref() {
            if current.game_key == key && current.started_at == started_at {
                *guard = None;
            }
        }
    }
}

/// What a playtime watcher waits on.
enum SessionWatch {
    /// Wait on the spawned child process.
    Child(std::process::Child),
    /// Poll the process list for a macOS `.app` bundle.
    Bundle(PathBuf),
}

/// Wait for a macOS `.app` launch to finish (macOS only).
/// Returns false when the app never appears within the 30s grace
/// window — the launch handed off elsewhere (or failed) and there
/// is no session to record. Once the app has appeared, the exit is
/// confirmed by two consecutive "not running" polls 5s apart, so
/// a launcher-to-game handoff does not end the session early.
#[cfg(target_os = "macos")]
fn wait_for_bundle_exit(bundle: &Path) -> bool {
    let mut appeared = false;
    for _ in 0..30 {
        if app_is_running(bundle) {
            appeared = true;
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if !appeared {
        return false;
    }
    let mut misses = 0;
    loop {
        std::thread::sleep(Duration::from_secs(5));
        if app_is_running(bundle) {
            misses = 0;
        } else {
            misses += 1;
            if misses >= 2 {
                return true;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_bundle_exit(_bundle: &Path) -> bool {
    false
}

/// Start the background playtime watcher for a launched game.
/// The thread waits for the game to exit (child handle, or bundle
/// polling), then records the session in the profile and clears
/// the active-session record. Everything in the thread is
/// best-effort and never panics the app: a failed thread spawn, a
/// failed state load, or a failed save just means the session is
/// lost — the launch itself already succeeded. If KOVA quits
/// mid-session, the watcher dies with it and the session is lost.
fn start_playtime_watch(
    app: tauri::AppHandle,
    key: String,
    started_at: i64,
    watch: SessionWatch,
) {
    // The thread owns its copy of the key; the caller keeps the
    // original for the spawn-failure message below.
    let watch_key = key.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("kova-playtime-{key}"))
        .spawn(move || {
            let ended = match watch {
                SessionWatch::Child(mut child) => {
                    let _ = child.wait();
                    true
                }
                SessionWatch::Bundle(bundle) => wait_for_bundle_exit(&bundle),
            };
            if !ended {
                let active = app.state::<ActiveSession>();
                unregister_session(&active, &watch_key, started_at);
                return;
            }
            let end = now_epoch_seconds();
            let seconds = end.saturating_sub(started_at).max(0) as u64;
            let mut state = load_state(&app);
            let profile = state.profiles.entry(watch_key.clone()).or_default();
            kova_core::record_session(profile, seconds, end);
            let _ = save_state(&app, &state);
            let active = app.state::<ActiveSession>();
            unregister_session(&active, &watch_key, started_at);
        });
    if let Err(e) = spawned {
        eprintln!("KOVA: could not start the playtime watcher for {key}: {e}");
    }
}

/// Launch a game and record it: the game's profile gains a launch
/// (`launch_count` + 1, `last_launched` = now) and the game moves
/// to the front of the Quick Resume recents. Both updates persist
/// in one state write, and the updated state is returned. A failed
/// launch records nothing.
///
/// The profile's performance settings resolve first
/// (`kova_core::resolve_launch_settings`): free-text args + the
/// preset's args (shaped by the launch-mode bundle), the FPS HUD
/// toggle, and the process priority — see `do_launch` for what
/// each launch path applies.
///
/// Slice 5.1: the incoming record may be a Quick Resume snapshot
/// with a pre-merge identity, so it is first resolved against the
/// most recent library (the `scan_library` cache, or a fresh scan
/// when this launch somehow precedes one). The launch is recorded
/// under the *resolved* game's key, the resolved record is what
/// lands in recents, and any profile stranded under the snapshot's
/// old key is folded into the resolved key — this is what migrates
/// a stranded launch count on the user's next launch.
///
/// Shared by the `launch_game` command and the tray menu's recent
/// items (which is why it takes the managed states directly
/// instead of `tauri::State` parameters).
fn launch_game_inner(
    app: &tauri::AppHandle,
    last: &LastLibrary,
    active: &ActiveSession,
    game: kova_core::Game,
) -> Result<KovaState, String> {
    if game.launch_uri.is_empty() {
        return Err("this game has no launch target".to_string());
    }
    let mut state = load_state(app);
    let library = match cached_library(last) {
        Some(library) => library,
        None => {
            let standalone_roots: Vec<PathBuf> =
                state.standalone_folders.iter().map(PathBuf::from).collect();
            let library = kova_core::scan_all_with(None, standalone_roots);
            cache_library(last, &library);
            library
        }
    };
    // Resolve the snapshot and migrate: fold stranded profiles
    // (the recents-wide pass, then the launched game's own key —
    // it may not sit in recents) and resolve the recents list.
    migrate_state(&mut state, &library);
    let resolved = kova_core::resolve_recent(&game, &library);
    let old_key = kova_core::profile_key(&game);
    let key = kova_core::profile_key(&resolved);
    if old_key != key {
        kova_core::fold_profile_into(&mut state.profiles, &old_key, &key);
    }
    let default_profile = kova_core::GameProfile::default();
    let settings = kova_core::resolve_launch_settings(
        state.profiles.get(&key).unwrap_or(&default_profile),
    );
    let started_at = now_epoch_seconds();
    // The already-running check happens BEFORE the launch: once
    // `open` has run, a running process is ambiguous (was it
    // already there, or did we just start it?).
    let already_running = game_already_running(&resolved);

    let outcome = do_launch(app, &resolved, &settings)?;

    // Start the playtime watcher for a watched launch — unless
    // the game was already running (session 0, see
    // `game_already_running`) or a session for this game is
    // already being watched (no double-count). Dropping an
    // un-watched `Child` here detaches it; the game keeps running.
    if !already_running {
        let watch = match outcome {
            LaunchOutcome::Spawned(child) => Some(SessionWatch::Child(child)),
            LaunchOutcome::Bundle(bundle) => Some(SessionWatch::Bundle(bundle)),
            LaunchOutcome::Unwatched => None,
        };
        if let Some(watch) = watch {
            if try_register_session(active, &key, started_at) {
                start_playtime_watch(app.clone(), key.clone(), started_at, watch);
            }
        }
    }

    let profile = state.profiles.entry(key).or_default();
    kova_core::record_launch(profile, started_at);
    record_recent(&mut state, &resolved);
    save_state(app, &state)?;
    refresh_tray_menu(app);
    Ok(state)
}

#[tauri::command]
fn launch_game(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    active: tauri::State<'_, ActiveSession>,
    game_json: serde_json::Value,
) -> Result<KovaState, String> {
    let game: kova_core::Game =
        serde_json::from_value(game_json).map_err(|e| format!("invalid game record: {e}"))?;
    launch_game_inner(&app, &last, &active, game)
}

#[tauri::command]
fn scan_library(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    path: Option<String>,
) -> kova_core::AnnotatedLibrary {
    let steam_root = path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    // The user's standalone folders come from the persisted state;
    // an empty list leaves the core's home-folder defaults in play.
    let mut state = load_state(&app);
    let standalone_roots: Vec<PathBuf> =
        state.standalone_folders.iter().map(PathBuf::from).collect();
    let library = kova_core::scan_all_with(steam_root, standalone_roots);
    // Slice 5.1: cache the scan for recents resolution, and run
    // the one-profile-per-game migration against it (persisting
    // any change) before annotating, so the profiles the frontend
    // sees are already the folded ones.
    cache_library(&last, &library);
    if migrate_state(&mut state, &library) {
        let _ = save_state(&app, &state);
    }
    // Slice 5: the library the frontend renders is the scan merged
    // with the persisted profiles (display names, favorites,
    // hidden flags, art overrides, launch stats).
    kova_core::apply_profiles(&library, &state.profiles)
}

#[tauri::command]
fn launch_uri(app: tauri::AppHandle, uri: String) -> Result<(), String> {
    let opener = app.opener();
    // Store launch URIs and web URLs carry a scheme (`steam://`,
    // `goggalaxy://`, `com.epicgames.launcher://`, `https://`);
    // itch and standalone games use plain filesystem paths, which
    // the opener must open as paths instead.
    if uri.contains("://") {
        opener.open_url(uri, None::<String>)
    } else {
        opener.open_path(uri, None::<String>)
    }
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Menu-bar tray icon (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// The tray icon's id (used to find it again for menu refreshes).
const TRAY_ID: &str = "kova-tray";
/// How many recent games the tray menu lists.
const TRAY_RECENTS_MAX: usize = 8;
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
/// Menu-item id prefix for a recent game; the profile key
/// (`"<source>:<id>"`) follows, so a click resolves the game from
/// the current state (recents may have shifted since the menu was
/// built).
const TRAY_RECENT_PREFIX: &str = "tray-recent:";

fn tray_recent_id(key: &str) -> String {
    format!("{TRAY_RECENT_PREFIX}{key}")
}

/// Build the tray menu from the state: the recent games (max 8,
/// display name from the profile override or the scanned name),
/// a separator, then "Show KOVA" and "Quit KOVA".
fn build_tray_menu(
    app: &tauri::AppHandle,
    state: &KovaState,
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    let mut items: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    for game in state.recents.iter().take(TRAY_RECENTS_MAX) {
        let key = kova_core::profile_key(game);
        let label = state
            .profiles
            .get(&key)
            .and_then(|profile| profile.name_override.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| game.name.clone());
        let label = truncate_chars(&label, 48);
        let item = MenuItemBuilder::with_id(tray_recent_id(&key), label)
            .build(app)
            .map_err(|e| e.to_string())?;
        items.push(item);
    }
    let mut builder = MenuBuilder::new(app);
    for item in &items {
        builder = builder.item(item);
    }
    if !items.is_empty() {
        builder = builder.separator();
    }
    let show = MenuItemBuilder::with_id(TRAY_SHOW_ID, "Show KOVA")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id(TRAY_QUIT_ID, "Quit KOVA")
        .build(app)
        .map_err(|e| e.to_string())?;
    builder = builder.item(&show);
    builder = builder.item(&quit);
    builder.build().map_err(|e| e.to_string())
}

/// Show the main window (shared by the tray menu and
/// `back_to_main`).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Handle a tray menu click: "Show KOVA" shows the main window,
/// "Quit KOVA" exits, and a recent launches that game through the
/// same path as the in-app launch (profile settings, recents,
/// playtime watcher — and a tray menu refresh afterwards). A
/// recent whose game left the recents list since the menu was
/// built is ignored, never launched from a stale record.
fn handle_tray_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id: &str = event.id().as_ref();
    match id {
        TRAY_SHOW_ID => show_main_window(app),
        TRAY_QUIT_ID => app.exit(0),
        _ => {
            if let Some(key) = id.strip_prefix(TRAY_RECENT_PREFIX) {
                let state = load_state(app);
                if let Some(game) = state
                    .recents
                    .iter()
                    .find(|game| kova_core::profile_key(game) == key)
                {
                    let game = game.clone();
                    let last = app.state::<LastLibrary>();
                    let active = app.state::<ActiveSession>();
                    if let Err(e) = launch_game_inner(app, &last, &active, game) {
                        eprintln!("KOVA: tray launch failed for {key}: {e}");
                    }
                } else {
                    eprintln!("KOVA: tray recent {key} is no longer in recents; ignoring");
                }
            }
        }
    }
}

/// Create the menu-bar tray icon at startup, using the app icon
/// (the default window icon tauri-build embeds). Any failure —
/// no icon, no tray support on this machine — logs and continues
/// without the tray: KOVA must still launch.
fn setup_tray(app: &tauri::AppHandle) {
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("KOVA: no default window icon — skipping the menu-bar tray icon");
        return;
    };
    let state = load_state(app);
    let menu = match build_tray_menu(app, &state) {
        Ok(menu) => menu,
        Err(e) => {
            eprintln!("KOVA: could not build the tray menu ({e}) — skipping the tray icon");
            return;
        }
    };
    if let Err(e) = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("KOVA — Avok Interactive")
        .show_menu_on_left_click(true)
        .on_menu_event(handle_tray_menu_event)
        .build(app)
    {
        eprintln!("KOVA: could not create the menu-bar tray icon ({e}) — continuing without it");
    }
}

/// Rebuild the tray menu from the current state (after a launch,
/// when the recents changed). A missing tray (creation failed at
/// startup) or a failed rebuild is a silent no-op — the menu just
/// stays as it was.
fn refresh_tray_menu(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let state = load_state(app);
    match build_tray_menu(app, &state) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                eprintln!("KOVA: could not refresh the tray menu: {e}");
            }
        }
        Err(e) => eprintln!("KOVA: could not rebuild the tray menu: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Overlay hotkey
// ---------------------------------------------------------------------------

/// The overlay toggle hotkey: Cmd+Shift+K on macOS, Ctrl+Shift+K
/// elsewhere (the `CmdOrCtrl` convention).
fn overlay_shortcut() -> Shortcut {
    let cmd_or_ctrl = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(cmd_or_ctrl | Modifiers::SHIFT), Code::KeyK)
}

/// Show the overlay window if hidden, hide it if visible.
fn toggle_overlay(app: &tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        if overlay.is_visible().unwrap_or(false) {
            let _ = overlay.hide();
        } else {
            let _ = overlay.show();
            let _ = overlay.set_focus();
        }
    }
}

#[tauri::command]
fn back_to_main(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    show_main_window(&app);
}

#[tauri::command]
fn hide_overlay(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

// ---------------------------------------------------------------------------
// Over-the-air updates (v1.1.0, tauri-plugin-updater)
//
// The updater is driven from Rust, not from the frontend's JS: KOVA's
// frontend is plain JS with no bundler, so the updater's npm package
// has no import path. The Settings UI calls these three commands
// through the same invoke() path as everything else.
//
// Flow: check_update reads the feed manifest (no download). If a newer
// version is announced, install_update re-checks (stateless — no shared
// pending-update state to go stale), downloads the signed artifact,
// verifies its signature, and stages it. restart_app finishes the
// install. Nothing installs without Dre's go in the Settings UI.
#[derive(Serialize)]
struct UpdateInfo {
    available: bool,
    version: Option<String>,
    current_version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version),
            current_version: update.current_version,
            notes: update.body,
        }),
        None => Ok(UpdateInfo {
            available: false,
            version: None,
            current_version: app.package_info().version.to_string(),
            notes: None,
        }),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available.".to_string())?;
    let version = update.version.clone();
    // Progress callbacks are no-ops in v1: the Settings UI shows a
    // "Downloading…" state instead of a percentage bar.
    update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(version)
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LastLibrary::default())
        .manage(ActiveSession::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == overlay_shortcut() {
                        toggle_overlay(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Registration can fail (e.g. another app owns the
            // hotkey). Log and carry on — KOVA must still launch;
            // the overlay just won't have a hotkey.
            if let Err(e) = app.handle().global_shortcut().register(overlay_shortcut()) {
                eprintln!("KOVA: failed to register overlay hotkey CmdOrCtrl+Shift+K: {e}");
            }
            // The tray icon is best-effort too (see setup_tray).
            setup_tray(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            launch_uri,
            launch_game,
            get_state,
            set_recent,
            set_standalone_folders,
            get_profiles,
            set_profile,
            clear_profile,
            set_show_hidden_games,
            set_gamer_profile,
            set_wishlist,
            game_icon,
            back_to_main,
            hide_overlay,
            check_update,
            install_update,
            restart_app,
            // v1.2.0
            get_perf_presets,
            get_active_session,
            set_shelves,
            set_beta,
            set_kids,
            set_sync_folder,
            push_state_to_sync,
            pull_state_from_sync,
            add_journal_entry,
            get_journal,
            backup_saves,
            list_save_backups,
            restore_save,
            get_milestones,
            get_disk_usage,
            import_state,
            notify_update_available,
            get_store_catalog
        ])
        .run(tauri::generate_context!())
        .expect("error while running KOVA");
}
