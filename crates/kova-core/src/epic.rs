//! Epic Games Launcher library scanning.
//!
//! The Epic Games Launcher records every installed item as a JSON
//! manifest file (`*.item`) in a manifests directory:
//!
//! * macOS: `~/Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests`
//! * Windows: `C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests`
//! * Linux: the Epic Games Launcher has no standard Linux install,
//!   so there are no standard candidates (Heroic Games Launcher etc.
//!   are out of scope for this slice).
//!
//! Relevant manifest fields: `DisplayName`, `AppName` (the launch id),
//! `InstallLocation`, and `InstallSize` (bytes, may be absent).
//! Games launch through the launcher URI
//! `com.epicgames.launcher://apps/<AppName>?action=launch&silent=true`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::steam::Game;

/// Default Epic manifests directory candidates on Windows.
pub fn epic_windows_candidates() -> Vec<PathBuf> {
    vec![PathBuf::from(
        r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests",
    )]
}

/// Default Epic manifests directory candidates on macOS.
pub fn epic_macos_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = crate::home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("Epic")
                .join("EpicGamesLauncher")
                .join("Data")
                .join("Manifests"),
        );
    }
    out
}

/// Default Epic manifests candidates for an OS name (same values as
/// `std::env::consts::OS`). Linux has no standard Epic install.
pub fn epic_candidates_for_os(os: &str) -> Vec<PathBuf> {
    match os {
        "windows" => epic_windows_candidates(),
        "macos" => epic_macos_candidates(),
        _ => Vec::new(),
    }
}

/// Default Epic manifests candidates for the OS this binary runs on.
pub fn epic_default_candidates() -> Vec<PathBuf> {
    epic_candidates_for_os(std::env::consts::OS)
}

/// Minimal percent-encoding for an Epic AppName inside a launch URI:
/// everything outside the RFC 3986 unreserved set is `%XX`-encoded.
fn encode_app_name(app_name: &str) -> String {
    let mut out = String::with_capacity(app_name.len());
    for byte in app_name.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The Epic launcher launch URI for an AppName.
pub fn epic_launch_uri(app_name: &str) -> String {
    format!(
        "com.epicgames.launcher://apps/{}?action=launch&silent=true",
        encode_app_name(app_name)
    )
}

/// Parse one Epic `*.item` manifest's contents. Returns `None` for
/// malformed manifests: invalid JSON, or a missing/empty `DisplayName`,
/// `AppName`, or `InstallLocation`.
pub fn parse_epic_manifest(contents: &str, manifests_dir: &Path) -> Option<Game> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    let get_str = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let name = get_str("DisplayName")?.to_string();
    let app_name = get_str("AppName")?.to_string();
    let install_location = get_str("InstallLocation")?.to_string();
    let install_path = PathBuf::from(&install_location);
    // The folder name is taken by splitting on both `/` and `\`:
    // InstallLocation is a Windows-style path in most manifests, and
    // `Path::file_name` on Unix would not split on backslashes.
    let installdir = install_location
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();
    let size_on_disk = value
        .get("InstallSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Some(Game {
        source: "epic".to_string(),
        id: app_name.clone(),
        // Epic AppNames are opaque strings, not numeric ids.
        appid: 0,
        name,
        installdir,
        install_path,
        size_on_disk,
        last_updated: 0,
        library: manifests_dir.to_path_buf(),
        launch_uri: epic_launch_uri(&app_name),
    })
}

/// Scan one Epic manifests directory. A missing directory is not an
/// error — it yields no games. Malformed manifests are counted in the
/// returned `skipped` total and never abort the scan. Returns
/// `(games, skipped)` with games de-duplicated by AppName and sorted
/// by name.
pub fn scan_epic_dir(manifests_dir: &Path) -> (Vec<Game>, usize) {
    let mut games: Vec<Game> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;

    let entries = match fs::read_dir(manifests_dir) {
        Ok(entries) => entries,
        Err(_) => return (games, skipped),
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|ext| ext.eq_ignore_ascii_case("item"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();

    for path in files {
        let parsed = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| parse_epic_manifest(&contents, manifests_dir));
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

    const VALID: &str = r#"{
        "AppName": "StarfallDrift",
        "DisplayName": "Starfall Drift",
        "InstallLocation": "D:\\EpicGames\\StarfallDrift",
        "InstallSize": 21474836480,
        "bIsManaged": true
    }"#;

    #[test]
    fn parses_valid_manifest() {
        let game = parse_epic_manifest(VALID, Path::new("/manifests")).unwrap();
        assert_eq!(game.source, "epic");
        assert_eq!(game.id, "StarfallDrift");
        assert_eq!(game.name, "Starfall Drift");
        assert_eq!(
            game.install_path,
            PathBuf::from(r"D:\EpicGames\StarfallDrift")
        );
        assert_eq!(game.size_on_disk, 21474836480);
        assert_eq!(
            game.launch_uri,
            "com.epicgames.launcher://apps/StarfallDrift?action=launch&silent=true"
        );
    }

    #[test]
    fn install_size_may_be_absent() {
        let contents = r#"{
            "AppName": "NeonHarbor",
            "DisplayName": "Neon Harbor",
            "InstallLocation": "/Games/NeonHarbor"
        }"#;
        let game = parse_epic_manifest(contents, Path::new("/m")).unwrap();
        assert_eq!(game.size_on_disk, 0);
        assert_eq!(game.installdir, "NeonHarbor");
    }

    #[test]
    fn rejects_missing_fields_and_bad_json() {
        let dir = Path::new("/m");
        assert!(parse_epic_manifest("not json", dir).is_none());
        // No AppName.
        assert!(
            parse_epic_manifest(r#"{"DisplayName": "X", "InstallLocation": "/g/X"}"#, dir)
                .is_none()
        );
        // No DisplayName.
        assert!(
            parse_epic_manifest(r#"{"AppName": "X", "InstallLocation": "/g/X"}"#, dir).is_none()
        );
        // No InstallLocation.
        assert!(parse_epic_manifest(r#"{"AppName": "X", "DisplayName": "X"}"#, dir).is_none());
    }

    #[test]
    fn launch_uri_encodes_app_name_minimally() {
        assert_eq!(
            epic_launch_uri("PlainName123"),
            "com.epicgames.launcher://apps/PlainName123?action=launch&silent=true"
        );
        assert_eq!(
            epic_launch_uri("Name With Spaces"),
            "com.epicgames.launcher://apps/Name%20With%20Spaces?action=launch&silent=true"
        );
    }

    #[test]
    fn candidates_cover_windows_and_macos_but_not_linux() {
        assert!(epic_candidates_for_os("windows")
            .iter()
            .any(|p| p.to_string_lossy().contains("Manifests")));
        assert!(epic_candidates_for_os("linux").is_empty());
    }
}
