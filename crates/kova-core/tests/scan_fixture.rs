//! Integration tests against a fake Steam installation fixture.
//!
//! The fixture under `tests/fixtures/` ships appmanifest files plus
//! `libraryfolders.vdf.template` files. Because a real
//! `libraryfolders.vdf` must contain absolute paths, each test assembles
//! a private copy of the fixture in a temp directory and substitutes the
//! `@STEAM_ROOT@` / `@LIBRARY_B@` tokens with the assembled locations.

use std::fs;
use std::path::{Path, PathBuf};

use kova_core::{library_folders, locate_steam, scan_library};

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let target = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// Assemble a fresh fixture install and return (base, steam_root, library_b).
fn assemble(
    label: &str,
    steam_fixture: &str,
    template_fixture: &str,
) -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("kova-core-test-{}-{label}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();

    let steam_root = base.join("steam");
    let library_b = base.join("library-b");
    copy_dir(&fixture_dir(steam_fixture), &steam_root);
    copy_dir(&fixture_dir("library-b"), &library_b);

    let template = fs::read_to_string(
        fixture_dir(template_fixture)
            .join("steamapps")
            .join("libraryfolders.vdf.template"),
    )
    .unwrap();
    let rendered = template
        .replace("@STEAM_ROOT@", &steam_root.to_string_lossy())
        .replace("@LIBRARY_B@", &library_b.to_string_lossy());
    fs::write(
        steam_root.join("steamapps").join("libraryfolders.vdf"),
        rendered,
    )
    .unwrap();

    (base, steam_root, library_b)
}

#[test]
fn modern_fixture_scan_finds_everything() {
    let (base, root, lib_b) = assemble("modern", "fake-steam", "fake-steam");

    // Libraries are enumerated: root (from the modern "path" entries)
    // plus the second library folder.
    let libraries = library_folders(&root);
    assert_eq!(libraries, vec![root.clone(), lib_b.clone()]);

    let result = scan_library(&root).expect("scan should succeed");
    assert_eq!(result.libraries.len(), 2);
    assert_eq!(result.games.len(), 4, "games: {:?}", result.games);
    // appmanifest_broken.acf (garbage) + appmanifest_999999.acf (no appid)
    assert_eq!(result.skipped_manifests, 2);

    // Sorted by name.
    let names: Vec<&str> = result.games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "Counter-Strike 2",
            "Dota 2",
            "Rocket League",
            "Team Fortress 2"
        ]
    );

    let cs2 = result.games.iter().find(|g| g.appid == 730).unwrap();
    assert_eq!(cs2.source, "steam");
    assert_eq!(cs2.id, "730");
    assert_eq!(cs2.name, "Counter-Strike 2");
    assert_eq!(cs2.installdir, "Counter-Strike Global Offensive");
    assert_eq!(cs2.launch_uri, "steam://rungameid/730");
    assert_eq!(cs2.size_on_disk, 67882246144);
    assert_eq!(cs2.last_updated, 1729000000);
    assert_eq!(
        cs2.install_path,
        root.join("steamapps")
            .join("common")
            .join("Counter-Strike Global Offensive")
    );
    assert_eq!(cs2.library, root);

    let tf2 = result.games.iter().find(|g| g.appid == 440).unwrap();
    assert_eq!(tf2.name, "Team Fortress 2");
    assert_eq!(tf2.installdir, "Team Fortress 2");
    assert_eq!(tf2.launch_uri, "steam://rungameid/440");
    assert_eq!(tf2.library, lib_b);

    let rl = result.games.iter().find(|g| g.appid == 252950).unwrap();
    assert_eq!(rl.launch_uri, "steam://rungameid/252950");

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn old_flat_format_fixture_also_enumerates_libraries() {
    let (base, root, lib_b) = assemble("old", "old-steam", "old-steam");

    let libraries = library_folders(&root);
    assert_eq!(libraries, vec![root.clone(), lib_b.clone()]);

    // The old-format root has no manifests of its own; both games come
    // from library B and must still be found.
    let result = scan_library(&root).expect("scan should succeed");
    let appids: Vec<u32> = result.games.iter().map(|g| g.appid).collect();
    assert_eq!(appids, vec![252950, 440]); // sorted by name: Rocket League, Team Fortress 2
    assert_eq!(result.skipped_manifests, 0);

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn scan_rejects_a_non_steam_directory() {
    let dir = std::env::temp_dir().join(format!("kova-core-test-{}-empty", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    assert!(scan_library(&dir).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn locate_steam_prefers_the_explicit_path() {
    let explicit = Path::new("/somewhere/Steam");
    assert_eq!(locate_steam(Some(explicit)), Some(explicit.to_path_buf()));
}
