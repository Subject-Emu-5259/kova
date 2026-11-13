//! GOG library scanning.
//!
//! GOG Galaxy installs each game in its own folder containing a
//! `goggame-<gameId>.info` JSON file:
//!
//! ```json
//! {
//!   "gameId": "1207658924",
//!   "name": "Some Game",
//!   "playTasks": [{ "isPrimary": true, "path": "game.exe", ... }]
//! }
//! ```
//!
//! There is no single registry of GOG install roots, so the scanner
//! accepts roots and walks them (bounded depth) looking for
//! `goggame-*.info` files. The game lives in the folder containing
//! the info file. Defaults cover the standard Windows locations;
//! `~/Library/Application Support/GOG Galaxy` on macOS is Galaxy
//! *config*, not games, so macOS relies on explicit roots.
//!
//! Games launch through Galaxy: `goggalaxy://openGameView/<gameId>`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::steam::Game;

/// How deep below a scan root we look for `goggame-*.info` files.
/// Real layouts put the info file one folder below the root
/// (`<root>/<Game>/goggame-*.info`); the extra depth covers bundles
/// and collection folders without walking whole drives.
const MAX_DEPTH: usize = 6;

/// Default GOG install roots on Windows.
pub fn gog_windows_roots() -> Vec<PathBuf> {
    vec![
        PathBuf::from(r"C:\Program Files (x86)\GOG Galaxy\Games"),
        PathBuf::from(r"C:\GOG Games"),
    ]
}

/// Default GOG roots for an OS name. Only Windows has standard
/// per-game install roots; other OSes rely on explicit roots.
pub fn gog_roots_for_os(os: &str) -> Vec<PathBuf> {
    match os {
        "windows" => gog_windows_roots(),
        _ => Vec::new(),
    }
}

/// Default GOG roots for the OS this binary runs on.
pub fn gog_default_roots() -> Vec<PathBuf> {
    gog_roots_for_os(std::env::consts::OS)
}

/// Parse one `goggame-*.info` file's contents. `install_folder` is the
/// folder containing the info file (the game's install path) and
/// `root` the scan root it was found under. Returns `None` for
/// malformed files: invalid JSON, or a missing/empty `gameId`/`name`.
/// (`gameId` may be a JSON string or number.)
pub fn parse_gog_info(contents: &str, install_folder: &Path, root: &Path) -> Option<Game> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    let game_id = match value.get("gameId") {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => return None,
    };
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let installdir = install_folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(Game {
        source: "gog".to_string(),
        id: game_id.clone(),
        appid: game_id.parse().unwrap_or(0),
        name,
        installdir,
        install_path: install_folder.to_path_buf(),
        // The info file carries no install size.
        size_on_disk: 0,
        last_updated: 0,
        library: root.to_path_buf(),
        launch_uri: format!("goggalaxy://openGameView/{game_id}"),
    })
}

/// Scan GOG install roots, walking each existing root for
/// `goggame-*.info` files. Missing roots are ignored. Malformed info
/// files are counted in the returned `skipped` total and never abort
/// the scan. Returns `(games, skipped)` with games de-duplicated by
/// gameId and sorted by name.
pub fn scan_gog_roots(roots: &[PathBuf]) -> (Vec<Game>, usize) {
    let mut games: Vec<Game> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let info_files = crate::collect_files(root, MAX_DEPTH, &|path: &Path| {
            path.file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    n.starts_with("goggame-") && n.ends_with(".info")
                })
                .unwrap_or(false)
        });
        for info_path in info_files {
            let install_folder = info_path.parent().unwrap_or(root);
            let parsed = fs::read_to_string(&info_path)
                .ok()
                .and_then(|contents| parse_gog_info(&contents, install_folder, root));
            match parsed {
                Some(game) => {
                    if seen.insert(game.id.clone()) {
                        games.push(game);
                    }
                }
                None => skipped += 1,
            }
        }
    }

    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    (games, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_info() {
        let contents = r#"{
            "gameId": "1207658924",
            "name": "Starfall Drift",
            "playTasks": [
                { "category": "game", "isPrimary": true, "path": "StarfallDrift.exe" }
            ]
        }"#;
        let game = parse_gog_info(
            contents,
            Path::new("/games/Starfall Drift"),
            Path::new("/games"),
        )
        .unwrap();
        assert_eq!(game.source, "gog");
        assert_eq!(game.id, "1207658924");
        assert_eq!(game.appid, 1207658924);
        assert_eq!(game.name, "Starfall Drift");
        assert_eq!(game.install_path, PathBuf::from("/games/Starfall Drift"));
        assert_eq!(game.installdir, "Starfall Drift");
        assert_eq!(game.launch_uri, "goggalaxy://openGameView/1207658924");
    }

    #[test]
    fn numeric_game_id_is_accepted() {
        let contents = r#"{ "gameId": 42, "name": "Numeric Id Game" }"#;
        let game = parse_gog_info(contents, Path::new("/g/N"), Path::new("/g")).unwrap();
        assert_eq!(game.id, "42");
        assert_eq!(game.appid, 42);
    }

    #[test]
    fn rejects_missing_fields_and_bad_json() {
        let folder = Path::new("/g/X");
        let root = Path::new("/g");
        assert!(parse_gog_info("not json", folder, root).is_none());
        assert!(parse_gog_info(r#"{ "name": "No Id" }"#, folder, root).is_none());
        assert!(parse_gog_info(r#"{ "gameId": "7" }"#, folder, root).is_none());
    }

    #[test]
    fn default_roots_are_windows_only() {
        assert_eq!(gog_roots_for_os("windows").len(), 2);
        assert!(gog_roots_for_os("macos").is_empty());
        assert!(gog_roots_for_os("linux").is_empty());
    }
}
