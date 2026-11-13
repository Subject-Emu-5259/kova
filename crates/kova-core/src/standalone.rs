//! Standalone (non-store) game scanning.
//!
//! Not every game comes from a store. This scanner walks caller-
//! supplied roots — plus the home-folder defaults `~/Games` and
//! `~/KOVA Games` — looking for items the OS can launch directly:
//!
//! * **macOS `.app` bundles** — a directory whose name ends in
//!   `.app`; the game is the bundle itself.
//! * **Windows `.exe` files** — minus the noise: files whose names
//!   contain `unins`, `setup`, `crash`, or `helper`
//!   (case-insensitive) are uninstallers / installers / crash
//!   reporters / helper tools, not games; they are counted as
//!   *skipped*.
//! * **Linux binaries** — files ending in `.x86_64` or `.AppImage`,
//!   and (on Unix) extensionless files with an executable bit.
//!
//! The walk is bounded to depth 3 below each root so a stray root
//! can never send the scanner wandering a whole drive. Kind
//! detection is deliberately OS-agnostic (only the extensionless
//! rule needs Unix permission bits), so a Windows library scanned
//! from Linux still reads correctly.
//!
//! A game's `id` and `launch_uri` are both its absolute path — the
//! app hands the path to the OS opener, which launches the bundle /
//! executable. `size_on_disk` is the file size for plain files;
//! bundle directory sizes are not walked (0).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::steam::Game;

/// Deepest level below a root at which items are considered
/// (entries directly in the root are depth 1).
const MAX_DEPTH: usize = 3;

/// Default standalone roots: `~/Games` and `~/KOVA Games`, on every
/// platform. (System app folders like `/Applications` are far too
/// broad — most of their contents are not games.)
pub fn standalone_default_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = crate::home_dir() {
        out.push(home.join("Games"));
        out.push(home.join("KOVA Games"));
    }
    out
}

/// True when a file stem looks like a non-game helper: an
/// uninstaller (`unins…`), an installer (`…setup…`), a crash
/// reporter, or a helper binary. Case-insensitive substring match,
/// per the slice-3 spec.
pub fn is_helper_name(stem: &str) -> bool {
    let lower = stem.to_lowercase();
    ["unins", "setup", "crash", "helper"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Lowercased final extension of a file name (`"exe"`, `"appimage"`,
/// ...), or `None` when the name has no extension. Note `.AppImage`
/// and `.x86_64` surface here as extensions, which is exactly how
/// the launchable checks below want them.
fn extension_lower(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

#[cfg(unix)]
fn has_exec_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn has_exec_bit(_path: &Path) -> bool {
    // No permission-bit concept to consult; extensionless files are
    // not treated as launchable off Unix.
    false
}

fn unix_mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn make_game(path: &Path, root: &Path, name: String, size_on_disk: u64) -> Game {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let id = absolute.to_string_lossy().into_owned();
    Game {
        source: "standalone".to_string(),
        id: id.clone(),
        // Standalone paths have no numeric store id.
        appid: 0,
        name,
        installdir: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        install_path: absolute.clone(),
        size_on_disk,
        last_updated: unix_mtime(path),
        library: root.to_path_buf(),
        launch_uri: id,
    }
}

fn sort_and_dedup(games: &mut Vec<Game>) {
    let mut seen: HashSet<String> = HashSet::new();
    games.retain(|g| seen.insert(g.id.clone()));
    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// Recursive walk. `dir` sits at `depth` (the root itself is 0), so
/// its entries are at `depth + 1` and count while that is
/// `<= MAX_DEPTH`.
fn walk(dir: &Path, depth: usize, root: &Path, games: &mut Vec<Game>, skipped: &mut usize) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return, // unreadable folder: skip silently
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let entry_depth = depth + 1;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            if file_name.ends_with(".app") {
                // A game bundle: record it, never descend into it.
                let name = file_name
                    .strip_suffix(".app")
                    .unwrap_or(&file_name)
                    .to_string();
                if !name.is_empty() {
                    games.push(make_game(&path, root, name, 0));
                }
            } else if entry_depth < MAX_DEPTH {
                walk(&path, entry_depth, root, games, skipped);
            }
        } else if path.is_file() {
            match extension_lower(&path).as_deref() {
                Some("exe") => {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if is_helper_name(&stem) {
                        *skipped += 1;
                    } else if !stem.is_empty() {
                        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        games.push(make_game(&path, root, stem, size));
                    }
                }
                Some("appimage") | Some("x86_64") => {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if !stem.is_empty() {
                        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        games.push(make_game(&path, root, stem, size));
                    }
                }
                None => {
                    // Extensionless: a Unix executable counts as a
                    // game binary. Dotfiles are not games.
                    if !file_name.starts_with('.') && has_exec_bit(&path) {
                        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        games.push(make_game(&path, root, file_name.clone(), size));
                    }
                }
                _ => {} // any other file: not a game, ignored silently
            }
        }
    }
}

/// Scan standalone roots for launchable games. Missing roots are
/// ignored. Returns `(games, skipped)` — games de-duplicated by path
/// and sorted by name; `skipped` counts `.exe` files the helper
/// filter deliberately excluded (uninstallers, setups, crash
/// reporters, helpers).
pub fn scan_standalone_roots(roots: &[PathBuf]) -> (Vec<Game>, usize) {
    let mut games: Vec<Game> = Vec::new();
    let mut skipped = 0usize;
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let root = std::path::absolute(root).unwrap_or_else(|_| root.clone());
        walk(&root, 0, &root, &mut games, &mut skipped);
    }
    sort_and_dedup(&mut games);
    (games, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_filter_catches_the_noisy_names() {
        for name in [
            "unins000",
            "Uninstall",
            "GameSetup",
            "setup",
            "CrashReporter",
            "crashpad_handler",
            "UnityCrashHandler64",
            "HelperTool",
            "game_helper",
        ] {
            assert!(is_helper_name(name), "{name} should be filtered");
        }
        for name in ["Starfall Drift", "NeonHarbor", "Pixel Racer", "void-runner"] {
            assert!(!is_helper_name(name), "{name} is a game, not a helper");
        }
    }

    #[test]
    fn default_roots_are_the_home_game_folders() {
        let roots = standalone_default_roots();
        for root in &roots {
            let s = root.to_string_lossy();
            assert!(s.ends_with("Games") || s.ends_with("KOVA Games"), "{s}");
        }
    }

    #[test]
    fn missing_roots_scan_empty() {
        let (games, skipped) =
            scan_standalone_roots(&[PathBuf::from("/nonexistent/kova/standalone")]);
        assert!(games.is_empty());
        assert_eq!(skipped, 0);
    }
}
