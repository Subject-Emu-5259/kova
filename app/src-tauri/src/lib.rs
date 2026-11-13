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
//!   `last_launched`). An optional explicit Steam root may be
//!   passed; the other stores use their platform-default
//!   locations, and the standalone scanner uses the folders stored
//!   in KOVA's persistent state (see below).
//! * `launch_game` — launch a game (slice 5): for a locally
//!   installed game (a filesystem-path launch target) whose
//!   profile carries launch arguments, macOS launches it via
//!   `open <path> --args …`; every other game goes through the
//!   opener exactly like `launch_uri`. A successful launch is
//!   recorded in the game's profile (`launch_count`,
//!   `last_launched`) and in the Quick Resume recents, and the
//!   updated state is returned.
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
//!   state must never stop the app from launching.
//! * `get_profiles` / `set_profile` / `clear_profile` /
//!   `set_show_hidden_games` — the slice-5 state: per-game
//!   profiles (name override, favorite, hidden, launch args, art
//!   override, launch stats) keyed by `"<source>:<id>"`, plus the
//!   Settings "show hidden games" flag. State files written
//!   before slice 5 load with empty profiles — every field is
//!   serde-defaulted.
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

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

/// How many games the Quick Resume list remembers.
const RECENTS_CAP: usize = 10;

/// KOVA's persistent state (`kova-state.json` in the app data dir).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct KovaState {
    /// Recently launched games, most recent first, de-duplicated by
    /// (source, id). Powers the Quick Resume rows — "recently
    /// launched", not saved game state.
    #[serde(default)]
    recents: Vec<kova_core::Game>,
    /// Extra standalone game folders the user added in Settings.
    /// When non-empty these replace the standalone scanner's
    /// home-folder defaults; when empty the defaults apply.
    #[serde(default)]
    standalone_folders: Vec<String>,
    /// Per-game profiles (slice 5), keyed by `"<source>:<id>"`
    /// (see `kova_core::profiles`). Absent from state files
    /// written before slice 5 — the default is an empty map.
    #[serde(default)]
    profiles: kova_core::Profiles,
    /// Settings toggle: show hidden games in the Library view.
    /// Defaults to false — hidden means hidden.
    #[serde(default)]
    show_hidden_games: bool,
}

fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("kova-state.json"))
}

/// Load the persisted state. Any problem — no path, missing file,
/// corrupt JSON — returns defaults instead of an error.
fn load_state(app: &tauri::AppHandle) -> KovaState {
    let Some(path) = state_path(app) else {
        return KovaState::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return KovaState::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
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
// Per-game profiles (slice 5)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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

/// Unix epoch seconds for launch timestamps.
fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Perform the actual OS launch for a game.
///
/// Store URIs and web URLs carry a scheme (`steam://`,
/// `goggalaxy://`, `com.epicgames.launcher://`, `https://…`) and go
/// to the opener's `open_url`; plain filesystem paths (itch
/// install folders, standalone games, locally merged Avok titles)
/// go to `open_path`.
///
/// Launch arguments exist only on the filesystem-path branch —
/// there is no local process to receive them otherwise, and the UI
/// only enables the args field for such games. On macOS the path
/// is launched with `open <path> --args <args…>`, splitting the
/// profile's args string on whitespace (deliberately simple: no
/// quoting or escaping, so an argument containing a space cannot
/// be expressed). On other platforms there is no portable
/// through-the-opener way to pass arguments, so the game launches
/// plainly and the args are ignored (the UI is macOS-first).
fn do_launch(
    app: &tauri::AppHandle,
    game: &kova_core::Game,
    args: &[String],
) -> Result<(), String> {
    let is_local_path = !game.launch_uri.contains("://");
    if is_local_path && !args.is_empty() {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("open")
                .arg(&game.launch_uri)
                .arg("--args")
                .args(args)
                .status()
                .map_err(|e| e.to_string())?;
            if status.success() {
                return Ok(());
            }
            return Err(format!("macOS `open` failed with status {status}"));
        }
        // Non-macOS: fall through to the plain opener launch.
    }
    let opener = app.opener();
    if game.launch_uri.contains("://") {
        opener.open_url(game.launch_uri.clone(), None::<String>)
    } else {
        opener.open_path(game.launch_uri.clone(), None::<String>)
    }
    .map_err(|e| e.to_string())
}

/// Launch a game and record it: the game's profile gains a launch
/// (`launch_count` + 1, `last_launched` = now) and the game moves
/// to the front of the Quick Resume recents. Both updates persist
/// in one state write, and the updated state is returned. A failed
/// launch records nothing.
///
/// Slice 5.1: the incoming record may be a Quick Resume snapshot
/// with a pre-merge identity, so it is first resolved against the
/// most recent library (the `scan_library` cache, or a fresh scan
/// when this launch somehow precedes one). The launch is recorded
/// under the *resolved* game's key, the resolved record is what
/// lands in recents, and any profile stranded under the snapshot's
/// old key is folded into the resolved key — this is what migrates
/// a stranded launch count on the user's next launch.
#[tauri::command]
fn launch_game(
    app: tauri::AppHandle,
    last: tauri::State<'_, LastLibrary>,
    game_json: serde_json::Value,
) -> Result<KovaState, String> {
    let game: kova_core::Game =
        serde_json::from_value(game_json).map_err(|e| format!("invalid game record: {e}"))?;
    if game.launch_uri.is_empty() {
        return Err("this game has no launch target".to_string());
    }
    let mut state = load_state(&app);
    let library = match cached_library(&last) {
        Some(library) => library,
        None => {
            let standalone_roots: Vec<PathBuf> =
                state.standalone_folders.iter().map(PathBuf::from).collect();
            let library = kova_core::scan_all_with(None, standalone_roots);
            cache_library(&last, &library);
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
    let args: Vec<String> = state
        .profiles
        .get(&key)
        .map(|p| {
            p.launch_args
                .split_whitespace()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    do_launch(&app, &resolved, &args)?;

    let profile = state.profiles.entry(key).or_default();
    kova_core::record_launch(profile, now_epoch_seconds());
    record_recent(&mut state, &resolved);
    save_state(&app, &state)?;
    Ok(state)
}

#[tauri::command]
fn back_to_main(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
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
            game_icon,
            back_to_main,
            hide_overlay,
            check_update,
            install_update,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running KOVA");
}
