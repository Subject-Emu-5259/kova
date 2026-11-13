//! Slice-4 integration proof at the core level: a locally
//! installed copy of Dispatch HQ, staged as standalone `.app`
//! bundles, merges into the built-in Avok record instead of
//! producing duplicate standalone tiles. A non-matching standalone
//! game remains separate, and The Open World keeps its web launch
//! when no local copy matches it.

use std::fs;
use std::path::PathBuf;

use kova_core::{locate_app_icon, scan_sources, SourceRoots};

fn write_app_bundle(root: &PathBuf, name: &str, declared_icon: Option<&str>) -> PathBuf {
    let bundle = root.join(name);
    let contents = bundle.join("Contents");
    let resources = contents.join("Resources");
    fs::create_dir_all(&resources).unwrap();

    let icon_key = declared_icon
        .map(|icon| format!("<key>CFBundleIconFile</key><string>{icon}</string>"))
        .unwrap_or_default();
    fs::write(
        contents.join("Info.plist"),
        format!("<plist><dict>{icon_key}</dict></plist>"),
    )
    .unwrap();
    bundle
}

#[test]
fn local_dispatch_install_merges_into_avok_record() {
    let base = std::env::temp_dir().join(format!(
        "kova-core-test-{}-slice4-merge",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    let standalone_root = base.join("Games");
    fs::create_dir_all(&standalone_root).unwrap();

    // Two installs normalize to the Avok title. In the standalone
    // scanner's sorted order, "Dispatch HQ" comes before
    // "dispatch-hq" (space sorts before hyphen), so this first
    // bundle is the deterministic merged install.
    let dispatch = write_app_bundle(&standalone_root, "Dispatch HQ.app", Some("DispatchIcon"));
    let dispatch_resources = dispatch.join("Contents").join("Resources");
    fs::write(dispatch_resources.join("DispatchIcon.icns"), b"declared").unwrap();
    fs::write(
        dispatch_resources.join("AppIcon.icns"),
        b"larger conventional",
    )
    .unwrap();

    let _duplicate = write_app_bundle(&standalone_root, "dispatch-hq.app", None);
    let _unrelated = write_app_bundle(&standalone_root, "Moon Kart.app", None);

    let missing = base.join("missing");
    let unified = scan_sources(&SourceRoots {
        steam: Some(missing.join("steam")),
        epic_manifests: vec![missing.join("epic")],
        gog: vec![missing.join("gog")],
        itch_apps: vec![missing.join("itch")],
        standalone: vec![standalone_root.clone()],
    });

    // Moon Kart (standalone) + the two Avok titles. The two Dispatch
    // bundles collapse into the single Avok Dispatch record.
    assert_eq!(unified.total_games, 3);
    assert_eq!(unified.all_games().len(), unified.total_games);

    let standalone = unified.source("standalone").unwrap();
    let standalone_names: Vec<&str> = standalone.games.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(standalone_names, vec!["Moon Kart"]);
    assert!(
        !standalone_names
            .iter()
            .any(|name| kova_core::normalize_game_name(name) == "dispatchhq"),
        "no standalone Dispatch HQ duplicate may remain"
    );

    let avok = unified.source("avok").unwrap();
    let dispatch_hq = avok.games.iter().find(|g| g.id == "dispatch-hq").unwrap();
    assert_eq!(dispatch_hq.source, "avok");
    assert_eq!(dispatch_hq.name, "Dispatch HQ");
    assert_eq!(dispatch_hq.library, PathBuf::from("built-in"));
    assert_eq!(dispatch_hq.install_path, dispatch);
    assert_eq!(
        dispatch_hq.launch_uri,
        dispatch.to_string_lossy().into_owned()
    );
    assert_eq!(dispatch_hq.installdir, "Dispatch HQ.app");
    assert!(
        dispatch_hq.last_updated > 0,
        "the local bundle's modification time should carry into the merged record"
    );

    // The declared icon from this same staged bundle is locatable
    // for the app's local-art path.
    assert_eq!(
        locate_app_icon(&dispatch_hq.install_path),
        Some(dispatch_resources.join("DispatchIcon.icns"))
    );

    let open_world = avok
        .games
        .iter()
        .find(|g| g.id == "the-open-world")
        .unwrap();
    assert_eq!(
        open_world.launch_uri,
        "https://www.reddit.com/r/The_Open_World/"
    );
    assert!(open_world.install_path.as_os_str().is_empty());

    let _ = fs::remove_dir_all(&base);
}
