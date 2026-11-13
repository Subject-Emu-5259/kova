//! Integration tests against a fake itch apps root.
//!
//! Receipts on disk are gzipped JSON, so the repo fixture ships the
//! receipts as plain `receipt.json` files and each test assembles a
//! private copy in a temp directory, gzipping them into the real
//! on-disk shape: `<apps>/<game>/.itch/receipt.json.gz`. The fixture
//! has two valid games and one malformed receipt (invalid JSON once
//! decompressed), which must be counted as skipped.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use kova_core::itch::scan_itch_dir;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("itch-apps")
}

fn gzip_bytes(text: &str) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

/// Assemble a fresh itch apps root from the fixture and return
/// (base_to_clean_up, apps_root).
fn assemble(label: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("kova-core-test-{}-{label}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let apps = base.join("apps");
    for game_folder in ["starfall-drift", "neon-harbor", "broken-game"] {
        let plain = fs::read_to_string(
            fixture_dir()
                .join(game_folder)
                .join(".itch")
                .join("receipt.json"),
        )
        .unwrap();
        let target_dir = apps.join(game_folder).join(".itch");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("receipt.json.gz"), gzip_bytes(&plain)).unwrap();
    }
    (base, apps)
}

#[test]
fn itch_fixture_scan_reads_gzipped_receipts() {
    let (base, apps) = assemble("itch");

    let (games, skipped) = scan_itch_dir(&apps);
    assert_eq!(skipped, 1, "the malformed receipt must be counted");
    assert_eq!(games.len(), 2, "games: {games:?}");

    let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(names, vec!["Neon Harbor", "Starfall Drift"]);

    let starfall = games.iter().find(|g| g.id == "2450001").unwrap();
    assert_eq!(starfall.source, "itch");
    assert_eq!(starfall.appid, 2450001);
    assert_eq!(starfall.install_path, apps.join("starfall-drift"));
    assert_eq!(starfall.installdir, "starfall-drift");
    assert_eq!(starfall.library, apps);
    // itch launches by opening the install folder (documented choice).
    assert_eq!(
        starfall.launch_uri,
        apps.join("starfall-drift").to_string_lossy()
    );

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn itch_missing_root_is_empty_not_an_error() {
    let (games, skipped) = scan_itch_dir(Path::new("/nonexistent/kova/itch-apps"));
    assert!(games.is_empty());
    assert_eq!(skipped, 0);
}
