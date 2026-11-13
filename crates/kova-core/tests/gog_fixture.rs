//! Integration tests against a fake GOG install root.
//!
//! The fixture lays games out the way GOG Galaxy does — one folder
//! per game holding a `goggame-<id>.info` file — with one game
//! nested a level deeper (inside a `Collection/` folder) to prove
//! the walk, and one malformed info file counted as skipped.

use std::path::{Path, PathBuf};

use kova_core::gog::scan_gog_roots;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("gog-games")
}

#[test]
fn gog_fixture_scan_walks_and_counts_skips() {
    let root = fixture_root();
    let (games, skipped) = scan_gog_roots(std::slice::from_ref(&root));

    assert_eq!(skipped, 1, "the broken .info file must be counted");
    assert_eq!(games.len(), 2, "games: {games:?}");

    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, vec!["Neon Harbor", "Starfall Drift"]);

    let starfall = games.iter().find(|g| g.id == "1452360789").unwrap();
    assert_eq!(starfall.source, "gog");
    assert_eq!(starfall.appid, 1452360789);
    assert_eq!(starfall.install_path, root.join("Starfall Drift"));
    assert_eq!(starfall.installdir, "Starfall Drift");
    assert_eq!(starfall.library, root);
    assert_eq!(starfall.launch_uri, "goggalaxy://openGameView/1452360789");

    // Found one level deeper, under Collection/.
    let neon = games.iter().find(|g| g.id == "1987654321").unwrap();
    assert_eq!(
        neon.install_path,
        root.join("Collection").join("NeonHarborGame")
    );
}

#[test]
fn gog_missing_root_is_empty_not_an_error() {
    let (games, skipped) = scan_gog_roots(&[PathBuf::from("/nonexistent/kova/gog")]);
    assert!(games.is_empty());
    assert_eq!(skipped, 0);
}
