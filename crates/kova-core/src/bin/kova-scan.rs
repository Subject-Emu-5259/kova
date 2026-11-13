//! kova-scan — headless proof that KOVA's library scanners work.
//!
//! Usage:
//!   kova-scan                              Unified scan of all six sources
//!                                          (Steam auto-located; Epic/GOG/itch/
//!                                          standalone at platform defaults;
//!                                          the Avok shelf is built in),
//!                                          printed as JSON.
//!   kova-scan <STEAM_ROOT>                 Legacy slice-1 mode: scan just that
//!                                          Steam installation, printed as JSON.
//!   kova-scan --unified [--steam <DIR>] [--epic <DIR>]
//!                       [--gog <DIR>]... [--itch <DIR>]
//!                       [--standalone <DIR>]...
//!                                          Unified scan with explicit roots for
//!                                          any source (repeatable --gog and
//!                                          --standalone). Sources without a
//!                                          flag use platform defaults.
//!
//! Exit code 2 means the requested scan could not be performed
//! (legacy mode: no Steam installation found/scanned).

use std::path::PathBuf;
use std::process::ExitCode;

use kova_core::SourceRoots;

fn print_json<T: serde::Serialize>(value: &T) -> ExitCode {
    match serde_json::to_string_pretty(value) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("kova-scan: failed to serialize result: {e}");
            ExitCode::from(2)
        }
    }
}

fn legacy_steam_scan(arg: &str) -> ExitCode {
    let explicit = PathBuf::from(arg);
    let root = match kova_core::locate_steam(Some(&explicit)) {
        Some(root) => root,
        None => {
            eprintln!("kova-scan: could not locate Steam installation for {arg}");
            return ExitCode::from(2);
        }
    };
    match kova_core::scan_library(&root) {
        Ok(result) => print_json(&result),
        Err(e) => {
            eprintln!("kova-scan: {e}");
            ExitCode::from(2)
        }
    }
}

fn unified_scan(args: &[String]) -> ExitCode {
    let mut roots = SourceRoots::default();
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).cloned();
        match (flag, value) {
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
            _ => {
                eprintln!(
                    "kova-scan: unknown or incomplete flag {flag:?}. \
                     Usage: kova-scan [--unified [--steam DIR] [--epic DIR] \
                     [--gog DIR]... [--itch DIR] [--standalone DIR]...] \
                     | [STEAM_ROOT]"
                );
                return ExitCode::from(2);
            }
        }
    }
    print_json(&kova_core::scan_sources(&roots))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        None => print_json(&kova_core::scan_all(None)),
        Some("--unified") => unified_scan(&args[1..]),
        Some(single) if args.len() == 1 && !single.starts_with("--") => legacy_steam_scan(single),
        _ => {
            eprintln!(
                "kova-scan: unexpected arguments. Usage: kova-scan \
                 [--unified [--steam DIR] [--epic DIR] [--gog DIR]... \
                 [--itch DIR] [--standalone DIR]...] | [STEAM_ROOT]"
            );
            ExitCode::from(2)
        }
    }
}
