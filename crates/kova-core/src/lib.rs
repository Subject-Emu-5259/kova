//! kova-core — the pure-Rust heart of KOVA V1 (Avok Interactive).
//!
//! This crate has **no GUI/Tauri dependencies** so it can be built and
//! tested anywhere, including headless machines. It implements KOVA's
//! unified game library across six sources:
//!
//! * [`steam`] — locate a Steam installation, enumerate its library
//!   folders, and parse every `appmanifest_*.acf` into a
//!   [`steam::Game`] with a `steam://rungameid/<appid>` launch URI.
//! * [`epic`] — parse Epic Games Launcher `*.item` manifests.
//! * [`gog`] — walk install roots for `goggame-*.info` files.
//! * [`itch`] — find itch app installs via gzipped
//!   `.itch/receipt.json.gz` receipts (pure-Rust gzip via `flate2`).
//! * [`standalone`] — walk game folders for directly launchable
//!   items: macOS `.app` bundles, Windows `.exe` files (helpers
//!   filtered out), Linux binaries / AppImages.
//! * [`avok`] — the built-in Avok shelf: Avok Interactive's own live
//!   titles, compiled in rather than scanned.
//! * [`profiles`] — per-game user profiles (slice 5): name
//!   overrides, favorites, hidden games, launch options, art
//!   overrides, and launch statistics, merged over a scan with
//!   [`profiles::apply_profiles`].
//! * [`perf`] — performance profiles (v1.2.0): the engine-known
//!   launch-arg preset library, one-tap launch-mode bundles, and
//!   process-priority handling.
//! * [`milestones`] — local milestones (v1.2.0): badges computed
//!   from the player's own history, no server.
//! * [`state`] — the persistent state model (v1.2.0): the shape of
//!   `kova-state.json` (shelves, beta, kids, sync, journal, save
//!   backups, milestones) plus its pure validation, so the app
//!   crate owns only file I/O and commands.
//! * [`vdf`] — the hand-rolled Valve KeyValues (VDF/ACF) parser.
//!
//! Every scanner produces the same [`Game`] record (with a `source`
//! tag and a store-specific `id`) and never lets a malformed file
//! abort a scan: bad files are counted as *skipped*. [`scan_all`]
//! runs every scanner against platform defaults and returns a
//! [`UnifiedLibrary`] with one [`SourceReport`] per source, in
//! steam / epic / gog / itch / standalone / avok order.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub mod app_icon;
pub mod avok;
pub mod epic;
pub mod gog;
pub mod itch;
pub mod milestones;
pub mod perf;
pub mod profiles;
pub mod standalone;
pub mod state;
pub mod steam;
pub mod vdf;

pub use app_icon::locate_app_icon;
pub use state::{
    builtin_shelves, normalize_beta, normalize_kids, push_journal_entry, today_date_string,
    unix_timestamp_to_date, validate_shelves, BetaSettings, GamerProfile, JournalEntry,
    KidsSettings, KovaState, SaveBackup, Shelf, SyncSettings, JOURNAL_CAP,
    JOURNAL_ENTRY_MAX_CHARS, MAX_SHELVES,
};
pub use milestones::{
    compute_milestones, earned_ids, MilestoneStats, MilestoneStatus, MILESTONE_FINISHED_10,
    MILESTONE_LAUNCHES_100, MILESTONE_LIBRARY_50, MILESTONE_PLAYTIME_500H, MILESTONE_VARIETY_10,
};
pub use perf::{
    find_preset, resolve_launch_settings, LaunchMode, LaunchSettings, PerfPreset, Priority,
    PERF_PRESETS, PRESET_NOTE,
};
pub use profiles::{
    annotate_game, apply_profiles, favorites_first, fold_profile_into, merge_profiles, profile_key,
    record_launch, record_session, resolve_recent, resolve_recents, visible_games, AnnotatedGame,
    AnnotatedLibrary, AnnotatedSource, GameProfile, Profiles,
};
pub use steam::{
    candidates_for_os, default_candidates, library_folders, linux_candidates, locate_steam,
    macos_candidates, parse_appmanifest, parse_library_folders, scan_library, windows_candidates,
    Game, ScanError, ScanResult,
};

/// The current user's home directory (`$HOME`, falling back to
/// `%USERPROFILE%`). Shared by the store candidate builders.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// Collect files under `root` whose path satisfies `matches`,
/// descending at most `max_depth` directory levels below `root`
/// (files directly in `root` are at depth 1). Unreadable directories
/// are skipped silently. Results are sorted for determinism.
pub(crate) fn collect_files(
    root: &Path,
    max_depth: usize,
    matches: &dyn Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    fn walk(
        dir: &Path,
        depth: usize,
        max_depth: usize,
        matches: &dyn Fn(&Path) -> bool,
        out: &mut Vec<PathBuf>,
    ) {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                if depth < max_depth {
                    walk(&path, depth + 1, max_depth, matches, out);
                }
            } else if matches(&path) {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 1, max_depth, matches, &mut out);
    out.sort();
    out
}

/// One source's slice of a unified scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceReport {
    /// `"steam"` | `"epic"` | `"gog"` | `"itch"` | `"standalone"` |
    /// `"avok"`.
    pub source: String,
    /// The root(s) that were found and scanned for this source: for
    /// Steam, its library folders; for the other scanners, the
    /// candidate directories/roots that exist. The Avok shelf is
    /// built in, so its single root is the literal `"built-in"`.
    /// Empty when the source isn't installed (or wasn't locatable)
    /// on this machine.
    pub roots: Vec<PathBuf>,
    /// Games found, de-duplicated by store id, sorted by name.
    pub games: Vec<Game>,
    /// How many manifest/info/receipt files were skipped as malformed.
    pub skipped: usize,
}

/// The result of scanning every source: one report per source, in
/// Steam / Epic / GOG / itch / Standalone / Avok order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedLibrary {
    pub sources: Vec<SourceReport>,
    /// Total games across all sources.
    pub total_games: usize,
}

impl UnifiedLibrary {
    /// The report for one source (`"steam"`, `"epic"`, ...), if present.
    pub fn source(&self, source: &str) -> Option<&SourceReport> {
        self.sources.iter().find(|s| s.source == source)
    }

    /// Every game from every source, in report order.
    pub fn all_games(&self) -> Vec<&Game> {
        self.sources.iter().flat_map(|s| s.games.iter()).collect()
    }
}

/// Explicit scan roots for [`scan_sources`]. `None` / empty fields
/// mean "use the platform defaults" for Steam, and for
/// Epic/GOG/itch/Standalone explicit candidate lists *replace* the
/// defaults when non-empty (used by tests and the
/// `kova-scan --unified` flags); when empty, platform defaults are
/// used there too. The Avok shelf is built in and takes no roots.
#[derive(Debug, Clone, Default)]
pub struct SourceRoots {
    /// Explicit Steam root; `None` auto-locates via platform defaults.
    pub steam: Option<PathBuf>,
    /// Epic manifests directories to scan.
    pub epic_manifests: Vec<PathBuf>,
    /// GOG install roots to walk.
    pub gog: Vec<PathBuf>,
    /// itch apps roots to scan.
    pub itch_apps: Vec<PathBuf>,
    /// Standalone game folders to walk.
    pub standalone: Vec<PathBuf>,
}

fn scan_steam(steam_root: Option<&Path>) -> SourceReport {
    let located = steam::locate_steam(steam_root);
    match located {
        Some(root) => match steam::scan_library(&root) {
            Ok(result) => SourceReport {
                source: "steam".to_string(),
                roots: result.libraries.clone(),
                games: result.games,
                skipped: result.skipped_manifests,
            },
            Err(_) => SourceReport {
                source: "steam".to_string(),
                roots: Vec::new(),
                games: Vec::new(),
                skipped: 0,
            },
        },
        None => SourceReport {
            source: "steam".to_string(),
            roots: Vec::new(),
            games: Vec::new(),
            skipped: 0,
        },
    }
}

fn scan_epic(dirs: &[PathBuf]) -> SourceReport {
    let mut games: Vec<Game> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped = 0usize;
    let mut roots = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        roots.push(dir.clone());
        let (found, dir_skipped) = epic::scan_epic_dir(dir);
        skipped += dir_skipped;
        for game in found {
            if seen.insert(game.id.clone()) {
                games.push(game);
            }
        }
    }
    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    SourceReport {
        source: "epic".to_string(),
        roots,
        games,
        skipped,
    }
}

fn scan_gog(roots_in: &[PathBuf]) -> SourceReport {
    let existing: Vec<PathBuf> = roots_in.iter().filter(|r| r.is_dir()).cloned().collect();
    let (games, skipped) = gog::scan_gog_roots(&existing);
    SourceReport {
        source: "gog".to_string(),
        roots: existing,
        games,
        skipped,
    }
}

fn scan_itch(roots_in: &[PathBuf]) -> SourceReport {
    let mut games: Vec<Game> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped = 0usize;
    let mut roots = Vec::new();
    for dir in roots_in {
        if !dir.is_dir() {
            continue;
        }
        roots.push(dir.clone());
        let (found, dir_skipped) = itch::scan_itch_dir(dir);
        skipped += dir_skipped;
        for game in found {
            if seen.insert(game.id.clone()) {
                games.push(game);
            }
        }
    }
    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    SourceReport {
        source: "itch".to_string(),
        roots,
        games,
        skipped,
    }
}

fn scan_standalone(roots_in: &[PathBuf]) -> SourceReport {
    let existing: Vec<PathBuf> = roots_in.iter().filter(|r| r.is_dir()).cloned().collect();
    let (games, skipped) = standalone::scan_standalone_roots(&existing);
    SourceReport {
        source: "standalone".to_string(),
        roots: existing,
        games,
        skipped,
    }
}

fn scan_avok() -> SourceReport {
    SourceReport {
        source: "avok".to_string(),
        roots: vec![PathBuf::from("built-in")],
        games: avok::avok_shelf(),
        skipped: 0,
    }
}

/// Normalize a game name for the local-install merge: lowercase it
/// and keep only alphanumeric characters. This deliberately makes
/// `"Dispatch HQ"`, `"dispatch-hq"`, and `"DISPATCH: HQ!"` the same
/// merge key without making fuzzy or partial matches.
pub fn normalize_game_name(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Merge standalone installs into matching Avok shelf records.
///
/// A standalone game whose normalized name exactly matches an Avok
/// title is the same game installed locally, not a second library
/// entry. The Avok record keeps its source/id/name and its
/// `"built-in"` library provenance, but it takes the local install's
/// launch target and install metadata. Every matching standalone
/// duplicate is removed; if several installs match one title, the
/// first in the standalone report's existing sorted order is the one
/// merged. Standalone games with no Avok match are left untouched.
fn merge_local_installs_into_avok(sources: &mut [SourceReport]) {
    let Some(standalone_index) = sources.iter().position(|s| s.source == "standalone") else {
        return;
    };
    let Some(avok_index) = sources.iter().position(|s| s.source == "avok") else {
        return;
    };

    let standalone_games = std::mem::take(&mut sources[standalone_index].games);
    let mut retained = Vec::new();
    let mut merged_titles: std::collections::HashSet<String> = std::collections::HashSet::new();

    for local in standalone_games {
        let normalized = normalize_game_name(&local.name);
        let avok_position = sources[avok_index]
            .games
            .iter()
            .position(|game| normalize_game_name(&game.name) == normalized);

        let Some(position) = avok_position else {
            retained.push(local);
            continue;
        };

        // Only the first matching install (in the report's sorted
        // order) supplies the local launch data. Later matches are
        // the same title installed elsewhere and are still removed,
        // so the library never shows duplicate tiles for it.
        if merged_titles.insert(normalized) {
            let avok_game = &mut sources[avok_index].games[position];
            avok_game.launch_uri = local.launch_uri.clone();
            avok_game.install_path = local.install_path.clone();
            avok_game.installdir = local.installdir.clone();
            if local.size_on_disk != 0 {
                avok_game.size_on_disk = local.size_on_disk;
            }
            if local.last_updated != 0 {
                avok_game.last_updated = local.last_updated;
            }
            // Provenance stays with the shelf, as documented above.
            avok_game.library = PathBuf::from("built-in");
        }
    }

    sources[standalone_index].games = retained;
}

/// Run every scanner against explicit roots (platform defaults fill
/// in wherever a field is `None`/empty). A source whose directories
/// don't exist reports zero games — never an error. The Avok shelf
/// is built in and always reports its titles.
pub fn scan_sources(roots: &SourceRoots) -> UnifiedLibrary {
    let epic_dirs = if roots.epic_manifests.is_empty() {
        epic::epic_default_candidates()
    } else {
        roots.epic_manifests.clone()
    };
    let gog_roots = if roots.gog.is_empty() {
        gog::gog_default_roots()
    } else {
        roots.gog.clone()
    };
    let itch_dirs = if roots.itch_apps.is_empty() {
        itch::itch_default_candidates()
    } else {
        roots.itch_apps.clone()
    };
    let standalone_roots = if roots.standalone.is_empty() {
        standalone::standalone_default_roots()
    } else {
        roots.standalone.clone()
    };

    let mut sources = vec![
        scan_steam(roots.steam.as_deref()),
        scan_epic(&epic_dirs),
        scan_gog(&gog_roots),
        scan_itch(&itch_dirs),
        scan_standalone(&standalone_roots),
        scan_avok(),
    ];
    // A locally installed copy of an Avok title belongs to that
    // title's shelf record, not a duplicate standalone tile. Merge
    // before counting so `total_games` reflects the final library.
    merge_local_installs_into_avok(&mut sources);
    let total_games = sources.iter().map(|s| s.games.len()).sum();
    UnifiedLibrary {
        sources,
        total_games,
    }
}

/// Scan the unified library: Steam (auto-located, or the explicit
/// root given), Epic/GOG/itch at their platform-default locations,
/// the given standalone folders (the home-folder defaults when the
/// list is empty), and the built-in Avok shelf.
pub fn scan_all_with(
    steam_root: Option<PathBuf>,
    standalone_roots: Vec<PathBuf>,
) -> UnifiedLibrary {
    scan_sources(&SourceRoots {
        steam: steam_root,
        standalone: standalone_roots,
        ..SourceRoots::default()
    })
}

/// Scan the unified library with default standalone folders —
/// see [`scan_all_with`].
pub fn scan_all(steam_root: Option<PathBuf>) -> UnifiedLibrary {
    scan_all_with(steam_root, standalone::standalone_default_roots())
}

#[cfg(test)]
mod local_install_merge_tests {
    use super::*;

    fn game(source: &str, id: &str, name: &str, launch_uri: &str) -> Game {
        Game {
            source: source.to_string(),
            id: id.to_string(),
            appid: 0,
            name: name.to_string(),
            installdir: String::new(),
            install_path: PathBuf::new(),
            size_on_disk: 0,
            last_updated: 0,
            library: PathBuf::from("built-in"),
            launch_uri: launch_uri.to_string(),
        }
    }

    fn local_dispatch(name: &str, path: &str, size: u64, updated: u64) -> Game {
        let mut local = game("standalone", path, name, path);
        local.installdir = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        local.install_path = PathBuf::from(path);
        local.size_on_disk = size;
        local.last_updated = updated;
        local.library = PathBuf::from("/Games");
        local
    }

    fn reports(standalone: Vec<Game>) -> Vec<SourceReport> {
        vec![
            SourceReport {
                source: "standalone".to_string(),
                roots: vec![PathBuf::from("/Games")],
                games: standalone,
                skipped: 0,
            },
            SourceReport {
                source: "avok".to_string(),
                roots: vec![PathBuf::from("built-in")],
                games: avok::avok_shelf(),
                skipped: 0,
            },
        ]
    }

    #[test]
    fn normalization_ignores_case_spaces_and_punctuation() {
        assert_eq!(normalize_game_name("Dispatch HQ"), "dispatchhq");
        assert_eq!(normalize_game_name("DISPATCH-HQ!"), "dispatchhq");
        assert_eq!(normalize_game_name(" dispatch: hq "), "dispatchhq");
    }

    #[test]
    fn exact_normalized_match_merges_local_install_into_avok() {
        let local = local_dispatch(
            "dispatch-hq",
            "/Games/dispatch-hq.app",
            123_456,
            1_729_000_000,
        );
        let mut sources = reports(vec![local]);
        merge_local_installs_into_avok(&mut sources);

        assert!(sources[0].games.is_empty(), "duplicate standalone remains");
        let dispatch = sources[1]
            .games
            .iter()
            .find(|g| g.id == "dispatch-hq")
            .unwrap();
        assert_eq!(dispatch.source, "avok");
        assert_eq!(dispatch.name, "Dispatch HQ");
        assert_eq!(dispatch.launch_uri, "/Games/dispatch-hq.app");
        assert_eq!(
            dispatch.install_path,
            PathBuf::from("/Games/dispatch-hq.app")
        );
        assert_eq!(dispatch.installdir, "dispatch-hq.app");
        assert_eq!(dispatch.size_on_disk, 123_456);
        assert_eq!(dispatch.last_updated, 1_729_000_000);
        assert_eq!(dispatch.library, PathBuf::from("built-in"));
    }

    #[test]
    fn multiple_matches_merge_first_sorted_install_and_remove_all() {
        // This vec is already in the standalone scanner's sorted
        // order; the merge must preserve that deterministic choice.
        let first = local_dispatch("Dispatch HQ", "/Games/Dispatch HQ.app", 10, 100);
        let second = local_dispatch("dispatch-hq", "/Other/dispatch-hq.app", 20, 200);
        let mut sources = reports(vec![first, second]);
        merge_local_installs_into_avok(&mut sources);

        assert!(sources[0].games.is_empty());
        let dispatch = sources[1]
            .games
            .iter()
            .find(|g| g.id == "dispatch-hq")
            .unwrap();
        assert_eq!(
            dispatch.install_path,
            PathBuf::from("/Games/Dispatch HQ.app")
        );
        assert_eq!(dispatch.size_on_disk, 10);
        assert_eq!(dispatch.last_updated, 100);
    }

    #[test]
    fn non_matching_standalone_game_remains_separate() {
        let unrelated = local_dispatch("Other Game", "/Games/Other Game.app", 10, 100);
        let mut sources = reports(vec![unrelated]);
        merge_local_installs_into_avok(&mut sources);

        assert_eq!(sources[0].games.len(), 1);
        assert_eq!(sources[0].games[0].name, "Other Game");
        let dispatch = sources[1]
            .games
            .iter()
            .find(|g| g.id == "dispatch-hq")
            .unwrap();
        assert_eq!(dispatch.launch_uri, "https://dispatch-hq.onrender.com");
        assert!(dispatch.install_path.as_os_str().is_empty());
    }

    #[test]
    fn open_world_stays_web_launched_without_a_local_match() {
        let mut sources = reports(vec![local_dispatch(
            "Dispatch HQ",
            "/Games/Dispatch HQ.app",
            0,
            0,
        )]);
        merge_local_installs_into_avok(&mut sources);
        let open_world = sources[1]
            .games
            .iter()
            .find(|g| g.id == "the-open-world")
            .unwrap();
        assert_eq!(
            open_world.launch_uri,
            "https://www.reddit.com/r/The_Open_World/"
        );
        assert!(open_world.install_path.as_os_str().is_empty());
    }
}
