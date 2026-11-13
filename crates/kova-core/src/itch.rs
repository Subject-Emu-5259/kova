//! itch.io app library scanning.
//!
//! The itch app installs each game under an "apps" root and writes a
//! receipt into the game folder at `.itch/receipt.json.gz` — gzipped
//! JSON shaped like:
//!
//! ```json
//! {
//!   "game": { "id": 123456, "title": "Some Game",
//!             "url": "https://dev.itch.io/some-game" },
//!   "cave": { "...": "..." },
//!   "basePath": "..."
//! }
//! ```
//!
//! Candidate apps roots:
//!
//! * macOS: `~/Library/Application Support/itch/apps`
//! * Windows: `%APPDATA%\itch\apps`
//! * Linux: `~/.config/itch/apps`
//!
//! Receipts are decompressed with `flate2`'s pure-Rust backend, so
//! this scanner stays free of C dependencies like the rest of the
//! crate.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::steam::Game;

/// How deep below an apps root we look for `.itch/receipt.json.gz`.
/// Real layout is `<apps>/<game>/.itch/receipt.json.gz` (depth 3);
/// a little headroom covers grouped folders.
const MAX_DEPTH: usize = 6;

/// Default itch apps-root candidates on macOS.
pub fn itch_macos_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = crate::home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("itch")
                .join("apps"),
        );
    }
    out
}

/// Default itch apps-root candidates on Windows (`%APPDATA%\itch\apps`).
pub fn itch_windows_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        out.push(PathBuf::from(appdata).join("itch").join("apps"));
    } else if let Some(home) = crate::home_dir() {
        out.push(
            home.join("AppData")
                .join("Roaming")
                .join("itch")
                .join("apps"),
        );
    }
    out
}

/// Default itch apps-root candidates on Linux.
pub fn itch_linux_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = crate::home_dir() {
        out.push(home.join(".config").join("itch").join("apps"));
    }
    out
}

/// Default itch apps-root candidates for an OS name.
pub fn itch_candidates_for_os(os: &str) -> Vec<PathBuf> {
    match os {
        "windows" => itch_windows_candidates(),
        "macos" => itch_macos_candidates(),
        "linux" => itch_linux_candidates(),
        _ => Vec::new(),
    }
}

/// Default itch apps-root candidates for the OS this binary runs on.
pub fn itch_default_candidates() -> Vec<PathBuf> {
    itch_candidates_for_os(std::env::consts::OS)
}

/// Parse one receipt's raw (still gzipped) bytes. `install_folder` is
/// the game folder — the parent of the receipt's `.itch` directory —
/// and `apps_root` the root it was found under. Returns `None` for
/// malformed receipts: unreadable gzip, invalid JSON, or a
/// missing/empty `game.id` / `game.title`.
pub fn parse_itch_receipt(gzipped: &[u8], install_folder: &Path, apps_root: &Path) -> Option<Game> {
    let mut decoder = flate2::read::GzDecoder::new(gzipped);
    let mut json = String::new();
    decoder.read_to_string(&mut json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let game = value.get("game")?;
    let id = match game.get("id") {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return None,
    };
    let title = game
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let installdir = install_folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(Game {
        source: "itch".to_string(),
        id: id.clone(),
        appid: id.parse().unwrap_or(0),
        name: title,
        installdir,
        install_path: install_folder.to_path_buf(),
        // Receipts carry no install size.
        size_on_disk: 0,
        last_updated: 0,
        library: apps_root.to_path_buf(),
        // itch has no launcher URI scheme KOVA can rely on, so the
        // "launch URI" is the game's install folder itself: the app's
        // opener opens the folder (which contains the .app bundle /
        // executable) with the OS file manager. Documented choice —
        // see README "V1 slice 2".
        launch_uri: install_folder.to_string_lossy().into_owned(),
    })
}

/// Scan one itch apps root for `.itch/receipt.json.gz` files. A
/// missing root is not an error — it yields no games. Malformed
/// receipts are counted in the returned `skipped` total and never
/// abort the scan. Returns `(games, skipped)` with games
/// de-duplicated by itch game id and sorted by name.
pub fn scan_itch_dir(apps_root: &Path) -> (Vec<Game>, usize) {
    let mut games: Vec<Game> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;

    if !apps_root.is_dir() {
        return (games, skipped);
    }
    let receipts = crate::collect_files(apps_root, MAX_DEPTH, &|path: &Path| {
        path.file_name()
            .map(|n| n == "receipt.json.gz")
            .unwrap_or(false)
            && path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n == ".itch")
                .unwrap_or(false)
    });
    for receipt_path in receipts {
        // <apps>/<game>/.itch/receipt.json.gz → install folder is two up.
        let install_folder = receipt_path
            .parent()
            .and_then(|itch_dir| itch_dir.parent())
            .unwrap_or(apps_root);
        let parsed = fs::read(&receipt_path)
            .ok()
            .and_then(|bytes| parse_itch_receipt(&bytes, install_folder, apps_root));
        match parsed {
            Some(game) => {
                if seen.insert(game.id.clone()) {
                    games.push(game);
                }
            }
            None => skipped += 1,
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
    use std::io::Write;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    const RECEIPT: &str = r#"{
        "game": {
            "id": 123456,
            "title": "Starfall Drift",
            "url": "https://avok.itch.io/starfall-drift"
        },
        "cave": { "id": "cave-1" },
        "basePath": "/itch/apps/starfall-drift"
    }"#;

    #[test]
    fn parses_valid_receipt() {
        let game = parse_itch_receipt(
            &gzip(RECEIPT),
            Path::new("/itch/apps/starfall-drift"),
            Path::new("/itch/apps"),
        )
        .unwrap();
        assert_eq!(game.source, "itch");
        assert_eq!(game.id, "123456");
        assert_eq!(game.appid, 123456);
        assert_eq!(game.name, "Starfall Drift");
        assert_eq!(
            game.install_path,
            PathBuf::from("/itch/apps/starfall-drift")
        );
        // Launch URI is the install folder path for itch.
        assert_eq!(game.launch_uri, "/itch/apps/starfall-drift");
    }

    #[test]
    fn rejects_bad_gzip_bad_json_and_missing_fields() {
        let folder = Path::new("/itch/apps/x");
        let root = Path::new("/itch/apps");
        assert!(parse_itch_receipt(b"not gzip at all", folder, root).is_none());
        assert!(parse_itch_receipt(&gzip("not json"), folder, root).is_none());
        // No title.
        assert!(parse_itch_receipt(&gzip(r#"{ "game": { "id": 5 } }"#), folder, root).is_none());
        // No game object at all.
        assert!(parse_itch_receipt(&gzip(r#"{ "cave": {} }"#), folder, root).is_none());
    }

    #[test]
    fn candidates_cover_all_platforms() {
        assert!(itch_candidates_for_os("windows")
            .iter()
            .all(|p| p.to_string_lossy().contains("itch")));
        assert!(itch_candidates_for_os("plan9").is_empty());
    }
}
