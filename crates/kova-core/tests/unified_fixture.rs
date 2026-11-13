//! Integration test for the unified scan (`scan_sources`): one call
//! must cover Steam + Epic + GOG + itch + Standalone, each with its
//! own report, plus the built-in Avok shelf; and a source pointing
//! at directories that don't exist must report zero games instead
//! of failing (the Avok shelf is built in, so it always reports).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use kova_core::{scan_sources, SourceRoots};

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

fn gzip_bytes(text: &str) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(text.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

/// Assemble (base, steam_root, itch_apps) in a temp directory.
fn assemble(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("kova-core-test-{}-{label}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();

    // Steam: fixtures + rendered libraryfolders.vdf.
    let steam_root = base.join("steam");
    let library_b = base.join("library-b");
    copy_dir(&fixture_dir("fake-steam"), &steam_root);
    copy_dir(&fixture_dir("library-b"), &library_b);
    let template = fs::read_to_string(
        fixture_dir("fake-steam")
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

    // itch: gzip the plain receipt fixtures into place.
    let itch_apps = base.join("itch-apps");
    for game_folder in ["starfall-drift", "neon-harbor", "broken-game"] {
        let plain = fs::read_to_string(
            fixture_dir("itch-apps")
                .join(game_folder)
                .join(".itch")
                .join("receipt.json"),
        )
        .unwrap();
        let target_dir = itch_apps.join(game_folder).join(".itch");
        fs::create_dir_all(&target_dir).unwrap();
        fs::write(target_dir.join("receipt.json.gz"), gzip_bytes(&plain)).unwrap();
    }

    (base, steam_root, itch_apps)
}

/// The extensionless standalone fixture only counts on Unix once
/// it carries an executable bit; set it here rather than depending
/// on checkout modes or another test binary having done it.
#[cfg(unix)]
fn make_void_runner_executable() {
    use std::os::unix::fs::PermissionsExt;
    let path = fixture_dir("standalone-games").join("void-runner");
    let mut perms = fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&path, perms).unwrap();
}

#[test]
fn unified_scan_covers_all_six_sources() {
    let (base, steam_root, itch_apps) = assemble("unified");
    #[cfg(unix)]
    make_void_runner_executable();
    let roots = SourceRoots {
        steam: Some(steam_root.clone()),
        epic_manifests: vec![fixture_dir("epic-manifests")],
        gog: vec![fixture_dir("gog-games")],
        itch_apps: vec![itch_apps.clone()],
        standalone: vec![fixture_dir("standalone-games")],
    };

    let unified = scan_sources(&roots);

    // Reports arrive in the canonical source order.
    let order: Vec<&str> = unified.sources.iter().map(|s| s.source.as_str()).collect();
    assert_eq!(
        order,
        vec!["steam", "epic", "gog", "itch", "standalone", "avok"]
    );

    let report = |name: &str| unified.source(name).expect("source report exists");
    assert_eq!(report("steam").games.len(), 4);
    assert_eq!(report("steam").skipped, 2);
    assert_eq!(report("steam").roots.len(), 2); // root + library B
    assert_eq!(report("epic").games.len(), 2);
    assert_eq!(report("epic").skipped, 1);
    assert_eq!(report("epic").roots, vec![fixture_dir("epic-manifests")]);
    assert_eq!(report("gog").games.len(), 2);
    assert_eq!(report("gog").skipped, 1);
    assert_eq!(report("itch").games.len(), 2);
    assert_eq!(report("itch").skipped, 1);
    // The extensionless void-runner fixture only counts on Unix
    // (executable bit); the other three standalone games are
    // extension/bundle based and count everywhere.
    #[cfg(unix)]
    assert_eq!(report("standalone").games.len(), 4);
    #[cfg(not(unix))]
    assert_eq!(report("standalone").games.len(), 3);
    assert_eq!(report("standalone").skipped, 2);
    assert_eq!(report("avok").games.len(), 2);
    assert_eq!(report("avok").skipped, 0);
    assert_eq!(report("avok").roots, vec![PathBuf::from("built-in")]);

    #[cfg(unix)]
    assert_eq!(unified.total_games, 16);
    #[cfg(not(unix))]
    assert_eq!(unified.total_games, 15);
    assert_eq!(unified.all_games().len(), unified.total_games);
    // Every game carries its source tag and a launch target.
    for game in unified.all_games() {
        assert!(
            ["steam", "epic", "gog", "itch", "standalone", "avok"].contains(&game.source.as_str()),
            "unexpected source {:?}",
            game.source
        );
        assert!(!game.id.is_empty());
        assert!(!game.launch_uri.is_empty());
    }

    let _ = fs::remove_dir_all(&base);
}

#[test]
fn unified_scan_with_missing_dirs_reports_zeros() {
    let missing = PathBuf::from("/nonexistent/kova");
    let roots = SourceRoots {
        steam: Some(missing.join("steam")),
        epic_manifests: vec![missing.join("epic")],
        gog: vec![missing.join("gog")],
        itch_apps: vec![missing.join("itch")],
        standalone: vec![missing.join("games")],
    };
    let unified = scan_sources(&roots);
    // Every scanned source reports zeros; the built-in Avok shelf
    // still reports its two titles, so the total is 2, not 0.
    assert_eq!(unified.total_games, 2);
    for report in &unified.sources {
        if report.source == "avok" {
            assert_eq!(report.games.len(), 2);
            continue;
        }
        assert!(report.games.is_empty(), "{} should be empty", report.source);
        assert_eq!(report.skipped, 0, "{} should skip nothing", report.source);
        assert!(
            report.roots.is_empty(),
            "{} should find no roots",
            report.source
        );
    }
}
