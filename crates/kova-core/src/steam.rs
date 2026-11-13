//! Steam installation discovery and library scanning.
//!
//! A Steam install is a root folder containing `steamapps/`. Additional
//! library folders are listed in `steamapps/libraryfolders.vdf`, which
//! exists in two shapes:
//!
//! * **Modern (nested)** — each numeric key holds an object with a `path`:
//!   `"libraryfolders" { "0" { "path" "C:\\...\\Steam" ... } "1" { "path" ... } }`
//! * **Old (flat)** — each numeric key maps straight to a path string:
//!   `"LibraryFolders" { "1" "D:\\SteamLibrary" "2" "E:\\SteamLibrary" }`
//!
//! Games are described by `appmanifest_<appid>.acf` files inside each
//! library's `steamapps/` folder.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::vdf::{self, Node};

/// One installed game. This is KOVA's unified library record: every
/// scanner (Steam, Epic, GOG, itch, standalone, and the built-in
/// Avok shelf) produces this same shape.
///
/// `appid` is the Steam appid. For the other stores it carries the
/// store's numeric id when that id parses as a `u32` (GOG gameId, itch
/// game id) and `0` when it does not (Epic AppNames are not numeric;
/// standalone games and Avok titles have no numeric id). `id` is
/// always the source-specific id as a string — for Steam, the numeric
/// appid rendered as a string; for standalone games, the item's
/// absolute path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Game {
    /// Source this game came from: `"steam"` | `"epic"` | `"gog"` |
    /// `"itch"` | `"standalone"` | `"avok"`.
    pub source: String,
    /// Store-specific id as a string (Steam: the appid, e.g. `"730"`).
    pub id: String,
    pub appid: u32,
    pub name: String,
    /// The `installdir` value from the manifest (folder name only).
    pub installdir: String,
    /// Resolved install path: `<library>/steamapps/common/<installdir>`.
    pub install_path: PathBuf,
    /// `SizeOnDisk` from the manifest, in bytes (0 if absent).
    pub size_on_disk: u64,
    /// `LastUpdated` from the manifest, as a Unix timestamp (0 if absent).
    pub last_updated: u64,
    /// The library folder (Steam) or discovery root (other sources)
    /// this game was found under. Avok shelf entries use the literal
    /// `"built-in"`.
    pub library: PathBuf,
    /// How KOVA launches the game: a store URI
    /// (`steam://rungameid/<appid>`, Epic/GOG launcher URIs), a web
    /// URL (Avok shelf titles), or a filesystem path — for itch, the
    /// game's install folder; for standalone games, the launchable
    /// item itself (opened by the OS in both cases).
    pub launch_uri: String,
}

/// The result of scanning one Steam installation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanResult {
    pub steam_root: PathBuf,
    /// All library folders, Steam root first, duplicates removed.
    pub libraries: Vec<PathBuf>,
    /// All games found, de-duplicated by appid, sorted by name.
    pub games: Vec<Game>,
    /// How many manifest files were skipped as malformed/unreadable.
    pub skipped_manifests: usize,
}

#[derive(Debug)]
pub enum ScanError {
    Io(std::io::Error),
    SteamNotFound(String),
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScanError::Io(e) => write!(f, "I/O error: {e}"),
            ScanError::SteamNotFound(msg) => write!(f, "Steam installation not found: {msg}"),
        }
    }
}

impl std::error::Error for ScanError {}

impl From<std::io::Error> for ScanError {
    fn from(e: std::io::Error) -> Self {
        ScanError::Io(e)
    }
}

// ---------------------------------------------------------------------------
// Locating Steam
// ---------------------------------------------------------------------------

/// Default Steam root candidates on Windows.
pub fn windows_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from(r"C:\Program Files (x86)\Steam"),
        PathBuf::from(r"C:\Program Files\Steam"),
    ]
}

/// Default Steam root candidates on Linux (`$HOME`-relative ones are only
/// included when a home directory can be determined).
pub fn linux_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(home.join(".steam").join("steam"));
        out.push(home.join(".local").join("share").join("Steam"));
        // Flatpak Steam
        out.push(
            home.join(".var")
                .join("app")
                .join("com.valvesoftware.Steam")
                .join(".local")
                .join("share")
                .join("Steam"),
        );
    }
    out
}

/// Default Steam root candidates on macOS.
pub fn macos_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(
            home.join("Library")
                .join("Application Support")
                .join("Steam"),
        );
    }
    out
}

/// Default candidates for an OS name (`"windows"`, `"linux"`, `"macos"` —
/// the values of `std::env::consts::OS`). Unknown values yield an empty list.
pub fn candidates_for_os(os: &str) -> Vec<PathBuf> {
    match os {
        "windows" => windows_candidates(),
        "linux" => linux_candidates(),
        "macos" => macos_candidates(),
        _ => Vec::new(),
    }
}

/// Default candidates for the OS this binary is running on.
pub fn default_candidates() -> Vec<PathBuf> {
    candidates_for_os(std::env::consts::OS)
}

fn home_dir() -> Option<PathBuf> {
    crate::home_dir()
}

/// Locate a Steam installation. An explicit root wins if given (it is
/// returned as-is; existence is verified by the scan itself). Otherwise the
/// platform's default candidates are probed for a `steamapps` folder.
pub fn locate_steam(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(path.to_path_buf());
    }
    default_candidates()
        .into_iter()
        .find(|candidate| candidate.join("steamapps").is_dir())
}

// ---------------------------------------------------------------------------
// libraryfolders.vdf
// ---------------------------------------------------------------------------

/// Extract library paths from the *contents* of a `libraryfolders.vdf`
/// file, handling both the modern nested and the old flat format.
/// The Steam root itself is always included first; the order of the
/// remaining entries follows the file. Duplicates are removed
/// (compared as strings, so path-spelling differences may survive).
pub fn parse_library_folders(contents: &str, steam_root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![steam_root.to_path_buf()];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(steam_root.to_string_lossy().into_owned());

    let push = |out: &mut Vec<PathBuf>, seen: &mut HashSet<String>, raw: &str| {
        if !raw.is_empty() && seen.insert(raw.to_string()) {
            out.push(PathBuf::from(raw));
        }
    };

    if let Ok(root) = vdf::parse(contents) {
        if let Some(top) = root.get("libraryfolders") {
            if let Some(pairs) = top.as_object() {
                for (key, value) in pairs {
                    // Only numeric keys are library entries ("0", "1", ...);
                    // the old format also carries stray keys like
                    // "TimeNextStatsReport" whose values are not paths.
                    if !key.chars().all(|c| c.is_ascii_digit()) || key.is_empty() {
                        continue;
                    }
                    match value {
                        // Old flat format: value is the path itself.
                        Node::Scalar(path) => push(&mut out, &mut seen, path),
                        // Modern format: value is an object with "path".
                        Node::Object(_) => {
                            if let Some(path) = value.get("path").and_then(|n| n.as_str()) {
                                push(&mut out, &mut seen, path);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Enumerate all library folders for a Steam root: the root itself plus
/// everything in `steamapps/libraryfolders.vdf` (if present/readable).
pub fn library_folders(steam_root: &Path) -> Vec<PathBuf> {
    let vdf_path = steam_root.join("steamapps").join("libraryfolders.vdf");
    match fs::read_to_string(&vdf_path) {
        Ok(contents) => parse_library_folders(&contents, steam_root),
        Err(_) => vec![steam_root.to_path_buf()],
    }
}

// ---------------------------------------------------------------------------
// appmanifest_*.acf
// ---------------------------------------------------------------------------

fn parse_u64(node: &Node, key: &str) -> u64 {
    node.get(key)
        .and_then(|n| n.as_str())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// Parse one appmanifest's contents. Returns `None` for malformed
/// manifests: unparseable VDF, missing `AppState`, missing/invalid
/// `appid`, or a missing `name`.
pub fn parse_appmanifest(contents: &str, library: &Path) -> Option<Game> {
    let root = vdf::parse(contents).ok()?;
    let state = root.get("AppState")?;
    let appid = state
        .get("appid")
        .and_then(|n| n.as_str())
        .and_then(|s| s.trim().parse::<u32>().ok())?;
    let name = state.get("name")?.as_str()?.to_string();
    let installdir = state
        .get("installdir")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let install_path = library.join("steamapps").join("common").join(&installdir);
    Some(Game {
        source: "steam".to_string(),
        id: appid.to_string(),
        appid,
        name,
        installdir,
        install_path,
        size_on_disk: parse_u64(state, "SizeOnDisk"),
        last_updated: parse_u64(state, "LastUpdated"),
        library: library.to_path_buf(),
        launch_uri: format!("steam://rungameid/{appid}"),
    })
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Scan a Steam installation rooted at `steam_root`.
///
/// Fails only when the root has no `steamapps` folder at all; individual
/// unreadable or malformed manifests are counted in
/// [`ScanResult::skipped_manifests`] and never abort the scan.
pub fn scan_library(steam_root: &Path) -> Result<ScanResult, ScanError> {
    if !steam_root.join("steamapps").is_dir() {
        return Err(ScanError::SteamNotFound(format!(
            "{} has no steamapps folder",
            steam_root.display()
        )));
    }

    let libraries = library_folders(steam_root);
    let mut games: Vec<Game> = Vec::new();
    let mut seen_appids: HashSet<u32> = HashSet::new();
    let mut skipped_manifests = 0usize;

    for library in &libraries {
        let steamapps = library.join("steamapps");
        let entries = match fs::read_dir(&steamapps) {
            Ok(entries) => entries,
            Err(_) => continue, // library listed but not present/readable
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let parsed = fs::read_to_string(&path)
                .ok()
                .and_then(|contents| parse_appmanifest(&contents, library));
            match parsed {
                Some(game) => {
                    if seen_appids.insert(game.appid) {
                        games.push(game);
                    }
                }
                None => skipped_manifests += 1,
            }
        }
    }

    games.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.appid.cmp(&b.appid))
    });

    Ok(ScanResult {
        steam_root: steam_root.to_path_buf(),
        libraries,
        games,
        skipped_manifests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_libraryfolders_format() {
        let contents = r#"
        "libraryfolders"
        {
            "0"
            {
                "path"      "/games/Steam"
                "contentid" "123456789"
                "apps"
                {
                    "228980" "100"
                }
            }
            "1"
            {
                "path"      "/mnt/big/SteamLibrary"
                "apps"
                {
                    "730" "200"
                }
            }
        }
        "#;
        let libs = parse_library_folders(contents, Path::new("/games/Steam"));
        assert_eq!(
            libs,
            vec![
                PathBuf::from("/games/Steam"),
                PathBuf::from("/mnt/big/SteamLibrary"),
            ]
        );
    }

    #[test]
    fn old_flat_libraryfolders_format() {
        let contents = r#"
        "LibraryFolders"
        {
            "TimeNextStatsReport"   "1700000000"
            "ContentStatsID"        "987654321"
            "1"     "D:\\SteamLibrary"
            "2"     "E:\\MoreGames"
        }
        "#;
        let libs = parse_library_folders(contents, Path::new("C:\\Steam"));
        assert_eq!(
            libs,
            vec![
                PathBuf::from("C:\\Steam"),
                PathBuf::from("D:\\SteamLibrary"),
                PathBuf::from("E:\\MoreGames"),
            ]
        );
    }

    #[test]
    fn libraryfolders_missing_or_broken_falls_back_to_root() {
        let libs = parse_library_folders("not vdf at all {{{", Path::new("/x/Steam"));
        assert_eq!(libs, vec![PathBuf::from("/x/Steam")]);
    }

    #[test]
    fn candidates_cover_all_platforms() {
        assert!(candidates_for_os("windows")
            .iter()
            .any(|p| p.to_string_lossy().contains("Steam")));
        assert!(candidates_for_os("macos")
            .iter()
            .all(|p| p.to_string_lossy().contains("Steam") || p.as_os_str().is_empty()));
        // linux candidates are HOME-dependent; at minimum the function runs.
        let _ = candidates_for_os("linux");
        assert!(candidates_for_os("plan9").is_empty());
    }
}
