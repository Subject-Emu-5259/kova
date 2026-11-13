//! Slice-5 headless proof: scan the combined fixture tree (the
//! slice-3/4 six-source fixture), apply a fixture profile set with
//! `kova_core::profiles`, and print one JSON summary showing:
//!
//! * a rename override applied (`display_name` != scanned `name`),
//! * one hidden game present in the annotated library but filtered
//!   out of `visible_games`,
//! * favorites-first ordering over the visible games,
//! * an art URL override + launch statistics carried on a record,
//! * the `record_launch` update helper taking a fresh profile from
//!   count 0 / never launched to count 1 / stamped,
//! * (slice 5.1) a standalone Quick Resume snapshot of Dispatch HQ
//!   resolving to the library's merged Avok record, and a profile
//!   stranded under the snapshot's key folding into the Avok key —
//!   counts summing (1 stranded + 1 recorded = 2), the old key
//!   dropped: one profile per game.
//!
//! Usage (driven by scripts/make_slice5_proof.sh):
//!   cargo run -p kova-core --example slice5_proof -- \
//!       --steam DIR --epic DIR --gog DIR --itch DIR --standalone DIR

use std::path::PathBuf;
use std::process::ExitCode;

use kova_core::profiles::{
    apply_profiles, favorites_first, fold_profile_into, profile_key, resolve_recent, visible_games,
};
use kova_core::{Game, GameProfile, Profiles, SourceRoots};

fn find_game<'a>(library: &'a kova_core::UnifiedLibrary, name: &str) -> &'a kova_core::Game {
    library
        .all_games()
        .into_iter()
        .find(|g| g.name == name)
        .unwrap_or_else(|| panic!("fixture game not found: {name}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut roots = SourceRoots::default();
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).cloned();
        match (args[i].as_str(), value) {
            ("--steam", Some(v)) => {
                roots.steam = Some(PathBuf::from(v));
                i += 2;
            }
            ("--epic", Some(v)) => {
                roots.epic_manifests.push(PathBuf::from(v));
                i += 2;
            }
            ("--gog", Some(v)) => {
                roots.gog.push(PathBuf::from(v));
                i += 2;
            }
            ("--itch", Some(v)) => {
                roots.itch_apps.push(PathBuf::from(v));
                i += 2;
            }
            ("--standalone", Some(v)) => {
                roots.standalone.push(PathBuf::from(v));
                i += 2;
            }
            (flag, _) => {
                eprintln!("slice5_proof: unknown or incomplete flag {flag:?}");
                return ExitCode::from(2);
            }
        }
    }

    let library = kova_core::scan_sources(&roots);

    // ---- fixture profiles, keyed off the real scanned records --
    let mut profiles = Profiles::new();
    let cs2 = find_game(&library, "Counter-Strike 2");
    profiles.insert(
        profile_key(cs2),
        GameProfile {
            name_override: Some("CS2 Renamed".to_string()),
            favorite: true,
            launch_count: 3,
            last_launched: Some(1_730_000_000),
            ..GameProfile::default()
        },
    );
    let dota = find_game(&library, "Dota 2");
    profiles.insert(
        profile_key(dota),
        GameProfile {
            hidden: true,
            ..GameProfile::default()
        },
    );
    let moon_kart = find_game(&library, "Moon Kart");
    profiles.insert(
        profile_key(moon_kart),
        GameProfile {
            favorite: true,
            ..GameProfile::default()
        },
    );
    let dispatch = find_game(&library, "Dispatch HQ");
    profiles.insert(
        profile_key(dispatch),
        GameProfile {
            art_url_override: Some("https://example.invalid/dispatch-hq-art.png".to_string()),
            ..GameProfile::default()
        },
    );

    // ---- apply + views -------------------------------------------
    let annotated = apply_profiles(&library, &profiles);
    let visible = visible_games(&annotated);
    let mut ordered = visible.clone();
    favorites_first(&mut ordered);

    // ---- launch update helper: 0 launches -> 1 --------------------
    let mut fresh = GameProfile::default();
    let before = (fresh.launch_count, fresh.last_launched);
    kova_core::profiles::record_launch(&mut fresh, 1_730_003_600);
    let after = (fresh.launch_count, fresh.last_launched);

    // ---- slice 5.1: recents resolution + profile fold -------------
    // The pre-merge Quick Resume snapshot of Dispatch HQ, as the
    // standalone scanner recorded it: source "standalone", id = the
    // .app path. The fixture library's Dispatch HQ is the merged
    // Avok record carrying that same install path.
    let dispatch = find_game(&library, "Dispatch HQ");
    let snapshot = Game {
        source: "standalone".to_string(),
        id: dispatch.install_path.to_string_lossy().into_owned(),
        appid: 0,
        name: dispatch.name.clone(),
        installdir: String::new(),
        install_path: dispatch.install_path.clone(),
        size_on_disk: 0,
        last_updated: 0,
        library: dispatch.install_path.clone(),
        launch_uri: dispatch.launch_uri.clone(),
    };
    let snapshot_key = profile_key(&snapshot);
    let resolved = resolve_recent(&snapshot, &library);
    let resolved_key = profile_key(&resolved);

    // A profile stranded under the snapshot key (Dre's real state
    // file: one launch recorded through the Quick Resume tile) and
    // one launch already recorded under the Avok key. Folding must
    // sum them and drop the snapshot key.
    let mut fold_profiles = Profiles::new();
    fold_profiles.insert(
        snapshot_key.clone(),
        GameProfile {
            favorite: true,
            launch_count: 1,
            last_launched: Some(1_730_000_000),
            ..GameProfile::default()
        },
    );
    fold_profiles.insert(
        resolved_key.clone(),
        GameProfile {
            launch_count: 1,
            last_launched: Some(1_730_003_600),
            ..GameProfile::default()
        },
    );
    let fold_before_dst = fold_profiles[&resolved_key].launch_count;
    let fold_src_count = fold_profiles[&snapshot_key].launch_count;
    fold_profile_into(&mut fold_profiles, &snapshot_key, &resolved_key);
    let folded = &fold_profiles[&resolved_key];

    let annotated_json: Vec<serde_json::Value> = annotated
        .all_games()
        .iter()
        .map(|g| {
            serde_json::json!({
                "key": g.key,
                "source": g.game.source,
                "name": g.game.name,
                "display_name": g.display_name,
                "favorite": g.favorite,
                "hidden": g.hidden,
                "art_url_override": g.art_url_override,
                "launch_count": g.launch_count,
                "last_launched": g.last_launched,
            })
        })
        .collect();

    let proof = serde_json::json!({
        "total_games": annotated.total_games,
        "annotated": annotated_json,
        "visible_count": visible.len(),
        "visible_keys": visible.iter().map(|g| g.key.clone()).collect::<Vec<_>>(),
        "favorites_first_keys": ordered.iter().map(|g| g.key.clone()).collect::<Vec<_>>(),
        "launch_update": {
            "before_count": before.0,
            "before_last_launched": before.1,
            "after_count": after.0,
            "after_last_launched": after.1,
        },
        "recent_resolution": {
            "snapshot_key": snapshot_key,
            "resolved_key": resolved_key,
            "resolved_source": resolved.source,
            "resolved_id": resolved.id,
        },
        "profile_fold": {
            "dst_count_before": fold_before_dst,
            "src_count": fold_src_count,
            "count_after": folded.launch_count,
            "last_launched_after": folded.last_launched,
            "favorite_after": folded.favorite,
            "old_key_present": fold_profiles.contains_key(&snapshot_key),
        },
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&proof).expect("proof serializes")
    );
    ExitCode::SUCCESS
}
