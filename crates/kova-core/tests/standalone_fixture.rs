//! Integration tests against a fake standalone-games folder.
//!
//! The fixture mixes every standalone kind: a macOS `.app` bundle, a
//! Windows `.exe`, an AppImage nested one level down, an
//! extensionless Unix binary, two helper `.exe` files that must be
//! skipped and counted (an uninstaller and a setup helper), a plain
//! text file that must be ignored, and an `.exe` buried at depth 4
//! that the depth-3 walk must never reach.

use std::path::{Path, PathBuf};

use kova_core::standalone::scan_standalone_roots;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("standalone-games")
}

/// The extensionless fixture only counts as a game once it carries
/// an executable bit; set it here so the test does not depend on
/// checkout/copy tools preserving file modes.
#[cfg(unix)]
fn make_void_runner_executable(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let path = root.join("void-runner");
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
}

#[test]
fn standalone_fixture_scan_finds_games_and_counts_skips() {
    let root = fixture_root();
    #[cfg(unix)]
    make_void_runner_executable(&root);

    let (games, skipped) = scan_standalone_roots(std::slice::from_ref(&root));

    assert_eq!(
        skipped, 2,
        "unins000.exe and Setup Helper.exe must be counted as skipped"
    );

    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    #[cfg(unix)]
    assert_eq!(
        names,
        vec![
            "Neon Harbor",
            "Pixel Racer",
            "Starfall Drift",
            "void-runner"
        ],
        "games: {games:?}"
    );
    #[cfg(not(unix))]
    assert_eq!(names, vec!["Neon Harbor", "Pixel Racer", "Starfall Drift"]);

    // The depth-4 executable is past the walk bound.
    assert!(
        !names.contains(&"Hidden Game"),
        "depth-bound walk must not find Hidden Game.exe"
    );

    let starfall = games.iter().find(|g| g.name == "Starfall Drift").unwrap();
    assert_eq!(starfall.source, "standalone");
    assert_eq!(
        starfall.install_path,
        root.join("Starfall Drift.app"),
        "the .app bundle itself is the install path"
    );
    assert_eq!(starfall.installdir, "Starfall Drift.app");
    // id and launch_uri are the absolute path, per the standalone design.
    assert_eq!(starfall.id, starfall.install_path.to_string_lossy());
    assert_eq!(starfall.launch_uri, starfall.id);
    assert_eq!(starfall.library, root);

    let neon = games.iter().find(|g| g.name == "Neon Harbor").unwrap();
    assert_eq!(neon.install_path, root.join("Neon Harbor.exe"));
    assert!(neon.size_on_disk > 0, "plain files report their size");

    // Found one level deeper, under Collection/.
    let pixel = games.iter().find(|g| g.name == "Pixel Racer").unwrap();
    assert_eq!(
        pixel.install_path,
        root.join("Collection").join("Pixel Racer.AppImage")
    );
}

#[test]
fn standalone_missing_root_is_empty_not_an_error() {
    let (games, skipped) = scan_standalone_roots(&[PathBuf::from("/nonexistent/kova/games")]);
    assert!(games.is_empty());
    assert_eq!(skipped, 0);
}
