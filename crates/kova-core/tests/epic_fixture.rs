//! Integration tests against a fake Epic manifests directory.
//!
//! The fixture ships two valid `*.item` manifests, one malformed
//! `.item` (invalid JSON, counted as skipped), and a non-manifest
//! text file that must be ignored entirely.

use std::path::{Path, PathBuf};

use kova_core::epic::scan_epic_dir;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("epic-manifests")
}

#[test]
fn epic_fixture_scan_finds_games_and_counts_skips() {
    let (games, skipped) = scan_epic_dir(&fixture_dir());

    // BrokenManifest.item is invalid JSON; ignore-me.txt is not a
    // manifest at all and must not be counted either way.
    assert_eq!(skipped, 1);
    assert_eq!(games.len(), 2, "games: {games:?}");

    // Sorted by name.
    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, vec!["Neon Harbor", "Starfall Drift"]);

    let starfall = games.iter().find(|g| g.id == "StarfallDrift").unwrap();
    assert_eq!(starfall.source, "epic");
    assert_eq!(starfall.appid, 0); // Epic ids are not numeric
    assert_eq!(starfall.size_on_disk, 21474836480);
    assert_eq!(
        starfall.install_path,
        PathBuf::from(r"D:\EpicGames\StarfallDrift")
    );
    assert_eq!(starfall.installdir, "StarfallDrift");
    assert_eq!(
        starfall.launch_uri,
        "com.epicgames.launcher://apps/StarfallDrift?action=launch&silent=true"
    );

    let neon = games.iter().find(|g| g.id == "NeonHarbor").unwrap();
    assert_eq!(neon.size_on_disk, 0); // InstallSize absent in the fixture
}

#[test]
fn epic_missing_dir_is_empty_not_an_error() {
    let missing = Path::new("/nonexistent/kova/epic-manifests");
    let (games, skipped) = scan_epic_dir(missing);
    assert!(games.is_empty());
    assert_eq!(skipped, 0);
}
