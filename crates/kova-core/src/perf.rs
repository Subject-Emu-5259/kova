//! Performance profiles (v1.2.0) — launch-arg presets, launch-mode
//! bundles, and process-priority handling for per-game profiles.
//!
//! Honesty box (from PERF_PROFILES_SPEC.md §2): a launcher starts
//! other programs; it does not run inside them. Everything here is
//! a *request* handed to the game at launch — arguments, an
//! environment variable, a scheduling hint — and the game, the OS,
//! or the driver decides what to honor. KOVA never claims a setting
//! took effect, and there is **no FPS cap control on macOS**:
//! none exists for a launcher to use, so none is built here.
//!
//! This module is pure: it holds no state and does no I/O. The app
//! resolves a profile into [`LaunchSettings`] and applies them in
//! its launch path.

use serde::{Deserialize, Serialize};

use crate::profiles::GameProfile;

/// The note every preset carries, and the UI must show next to it:
/// the arguments are sent to the game, and the game decides what to
/// honor. A game that ignores an argument is unaffected, and KOVA
/// cannot tell the difference.
pub const PRESET_NOTE: &str = "sent to the game; the game decides what to honor";

/// One engine-known launch-argument preset.
///
/// Only presets stated honestly from documented engine flags ship
/// here: Source-family `+fps_max` / `-novid`, Unreal `-ResX` /
/// `-ResY` / `-windowed` / `-fullscreen`, Unity `-screen-width` /
/// `-screen-height` / `-screen-fullscreen`. Nothing is guessed for
/// an engine KOVA has no knowledge of.
///
/// Serialize-only: the app sends presets to the frontend; it never
/// receives one (the frontend sends a preset *id* string, and the
/// app looks it up).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PerfPreset {
    /// Stable id, referenced by `GameProfile::perf_launch_preset`.
    pub id: &'static str,
    /// Short UI label.
    pub label: &'static str,
    /// Which engine (or family) honors these arguments.
    pub engine: &'static str,
    /// The arguments, as separate argv entries (no quoting needed).
    pub args: &'static [&'static str],
    /// Whether this preset caps the frame rate. Launch mode
    /// "full" drops cap presets (see [`LaunchMode`]); window and
    /// resolution presets still apply.
    pub is_fps_cap: bool,
    /// Always [`PRESET_NOTE`].
    pub note: &'static str,
}

/// The preset library. Small on purpose: every entry is an
/// engine-documented flag set KOVA can state honestly.
pub const PERF_PRESETS: &[PerfPreset] = &[
    PerfPreset {
        id: "source-fps30",
        label: "Source: cap 30 FPS",
        engine: "Source",
        args: &["+fps_max", "30"],
        is_fps_cap: true,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "source-fps60",
        label: "Source: cap 60 FPS",
        engine: "Source",
        args: &["+fps_max", "60"],
        is_fps_cap: true,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "source-fps120",
        label: "Source: cap 120 FPS",
        engine: "Source",
        args: &["+fps_max", "120"],
        is_fps_cap: true,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "source-novid",
        label: "Source: skip intro video",
        engine: "Source",
        args: &["-novid"],
        is_fps_cap: false,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "unreal-windowed-1080",
        label: "Unreal: windowed 1080p",
        engine: "Unreal",
        args: &["-windowed", "-ResX=1920", "-ResY=1080"],
        is_fps_cap: false,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "unreal-fullscreen-1080",
        label: "Unreal: fullscreen 1080p",
        engine: "Unreal",
        args: &["-fullscreen", "-ResX=1920", "-ResY=1080"],
        is_fps_cap: false,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "unity-windowed-1080",
        label: "Unity: windowed 1080p",
        engine: "Unity",
        args: &[
            "-screen-width",
            "1920",
            "-screen-height",
            "1080",
            "-screen-fullscreen",
            "0",
        ],
        is_fps_cap: false,
        note: PRESET_NOTE,
    },
    PerfPreset {
        id: "unity-fullscreen-1080",
        label: "Unity: fullscreen 1080p",
        engine: "Unity",
        args: &[
            "-screen-width",
            "1920",
            "-screen-height",
            "1080",
            "-screen-fullscreen",
            "1",
        ],
        is_fps_cap: false,
        note: PRESET_NOTE,
    },
];

/// Look a preset up by id. An unknown id resolves to `None` — the
/// app then applies no preset args, never invented ones.
pub fn find_preset(id: &str) -> Option<&'static PerfPreset> {
    PERF_PRESETS.iter().find(|preset| preset.id == id)
}

/// Process priority for a directly-spawned game process.
///
/// The priority knob is real but small: it influences scheduling,
/// it does not raise the performance ceiling. It applies only to
/// executables KOVA spawns directly; `.app` launches go through
/// macOS `open`, which starts the process itself, so priority is a
/// no-op there (the app documents this and the UI says so). On
/// Windows the value is stored but not applied in v1.2.0 — setting
/// it needs the Win32 `SetPriorityClass` call, which needs a new
/// FFI dependency the release does not take on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Priority {
    Low,
    Normal,
    High,
}

impl Priority {
    /// Parse the profile's stored string (`"low"` / `"normal"` /
    /// `"high"`). Anything else — including "" — is `Normal`.
    pub fn parse(value: &str) -> Priority {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Priority::Low,
            "high" => Priority::High,
            _ => Priority::Normal,
        }
    }

    /// The canonical stored spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Normal => "normal",
            Priority::High => "high",
        }
    }

    /// The Unix `nice` increment for this priority, used by the
    /// app's direct-spawn path (`nice -n <value> <exe>`). `None`
    /// means no `nice` wrapper — launch plainly.
    ///
    /// Only Low maps to a wrapper: lowering your own priority
    /// (+10) is always permitted for an unprivileged user. High
    /// would need a negative increment, which needs privileges
    /// KOVA does not have — and a failed `nice` would exit
    /// before the game ever started, so the app does not attempt
    /// it: High launches at normal priority on Unix, and the
    /// stored value is kept for a future privileged path. The UI
    /// says priority is a minor knob, and this is why.
    pub fn nice_increment(self) -> Option<i32> {
        match self {
            Priority::Low => Some(10),
            Priority::Normal | Priority::High => None,
        }
    }
}

/// One-tap launch modes (v1.2.0 §10) — bundles of the perf
/// settings into a single choice, stored per game as
/// `GameProfile::launch_mode` (`"quiet"` / `"full"` / unset).
///
/// * **Quiet** ("Quiet night"): the profile's chosen preset args
///   apply *if one is set* — KOVA never invents cap args for an
///   engine it does not know — plus low process priority. The FPS
///   HUD stays as the profile set it.
/// * **Full** ("Full power"): no cap args — any fps-cap preset on
///   the profile is dropped for this launch (window/resolution
///   presets still apply) — plus high process priority and the
///   Metal FPS HUD forced on.
///
/// With no launch mode set, the profile's own settings apply
/// exactly as stored: preset args (any kind), the stored priority,
/// and the stored FPS toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaunchMode {
    Quiet,
    Full,
}

impl LaunchMode {
    /// Parse the profile's stored string. Anything other than the
    /// two known modes — including "" — is `None` (no bundle).
    pub fn parse(value: Option<&str>) -> Option<LaunchMode> {
        match value.map(str::trim) {
            Some("quiet") => Some(LaunchMode::Quiet),
            Some("full") => Some(LaunchMode::Full),
            _ => None,
        }
    }
}

/// What a launch actually applies, resolved from a profile by
/// [`resolve_launch_settings`]. The app hands `args` to the game's
/// process, `show_fps` to the Metal HUD env var (macOS only), and
/// `priority` to the direct-spawn path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSettings {
    /// Final argument list: the profile's free-text launch args
    /// first, then the preset's args (when a preset is set and the
    /// launch mode keeps it). Never invented — empty when the
    /// profile names no preset.
    pub args: Vec<String>,
    /// Whether to launch with the Metal FPS HUD on
    /// (`MTL_HUD_ENABLED=1`, macOS only, Metal games only).
    pub show_fps: bool,
    /// Process priority for a directly-spawned executable.
    pub priority: Priority,
    /// The launch mode that shaped this resolution, if any.
    pub mode: Option<LaunchMode>,
}

/// Resolve a profile into the settings one launch applies.
///
/// Order of the argument list: free-text `launch_args` first (the
/// user's own words win the earlier slots), then the preset's args.
/// In "full" mode an fps-cap preset is dropped — the point of Full
/// is uncapped — while window/resolution presets survive. In
/// "quiet" mode the preset applies as stored; with no preset set,
/// quiet adds no cap args at all (there is no honest cap to add).
/// Priority: the mode overrides the stored value when set
/// (quiet → low, full → high); otherwise the stored value stands.
/// FPS HUD: the stored toggle, forced on by "full".
pub fn resolve_launch_settings(profile: &GameProfile) -> LaunchSettings {
    let mode = LaunchMode::parse(profile.launch_mode.as_deref());
    let mut args: Vec<String> = profile
        .launch_args
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if let Some(preset_id) = profile.perf_launch_preset.as_deref() {
        if let Some(preset) = find_preset(preset_id.trim()) {
            let dropped_by_full = mode == Some(LaunchMode::Full) && preset.is_fps_cap;
            if !dropped_by_full {
                args.extend(preset.args.iter().map(|arg| arg.to_string()));
            }
        }
    }
    let priority = match mode {
        Some(LaunchMode::Quiet) => Priority::Low,
        Some(LaunchMode::Full) => Priority::High,
        None => Priority::parse(&profile.perf_priority),
    };
    let show_fps = profile.perf_show_fps || mode == Some(LaunchMode::Full);
    LaunchSettings {
        args,
        show_fps,
        priority,
        mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ids_are_unique_and_args_non_empty() {
        let mut ids = std::collections::HashSet::new();
        for preset in PERF_PRESETS {
            assert!(ids.insert(preset.id), "duplicate preset id: {}", preset.id);
            assert!(!preset.args.is_empty(), "preset {} has no args", preset.id);
            assert!(!preset.label.is_empty());
            assert!(!preset.engine.is_empty());
            assert_eq!(preset.note, PRESET_NOTE);
            assert!(
                preset.args.iter().all(|a| !a.trim().is_empty()),
                "preset {} has a blank arg",
                preset.id
            );
        }
        // Every preset round-trips through lookup.
        for preset in PERF_PRESETS {
            assert_eq!(find_preset(preset.id), Some(preset));
        }
        assert_eq!(find_preset("not-a-preset"), None);
        assert_eq!(find_preset(""), None);
    }

    #[test]
    fn fps_cap_presets_are_exactly_the_source_fps_ones() {
        let caps: Vec<&str> = PERF_PRESETS
            .iter()
            .filter(|p| p.is_fps_cap)
            .map(|p| p.id)
            .collect();
        assert_eq!(caps, vec!["source-fps30", "source-fps60", "source-fps120"]);
    }

    #[test]
    fn priority_parses_case_insensitively_and_defaults_to_normal() {
        assert_eq!(Priority::parse("low"), Priority::Low);
        assert_eq!(Priority::parse("HIGH"), Priority::High);
        assert_eq!(Priority::parse("  normal "), Priority::Normal);
        assert_eq!(Priority::parse(""), Priority::Normal);
        assert_eq!(Priority::parse("turbo"), Priority::Normal);
        assert_eq!(Priority::Low.as_str(), "low");
        assert_eq!(Priority::Normal.as_str(), "normal");
        assert_eq!(Priority::High.as_str(), "high");
        assert_eq!(Priority::Low.nice_increment(), Some(10));
        assert_eq!(Priority::Normal.nice_increment(), None);
        // High is deliberately NOT attempted via nice: a negative
        // increment needs privileges, and a failed nice would
        // exit before the game started.
        assert_eq!(Priority::High.nice_increment(), None);
    }

    #[test]
    fn launch_mode_parses_only_the_two_known_modes() {
        assert_eq!(LaunchMode::parse(Some("quiet")), Some(LaunchMode::Quiet));
        assert_eq!(LaunchMode::parse(Some("full")), Some(LaunchMode::Full));
        assert_eq!(LaunchMode::parse(None), None);
        assert_eq!(LaunchMode::parse(Some("")), None);
        assert_eq!(LaunchMode::parse(Some("eco")), None);
    }

    #[test]
    fn resolve_applies_preset_after_free_text_args() {
        let profile = GameProfile {
            launch_args: "-novid --foo".to_string(),
            perf_launch_preset: Some("source-fps60".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&profile);
        assert_eq!(
            settings.args,
            vec!["-novid", "--foo", "+fps_max", "60"]
        );
        assert_eq!(settings.priority, Priority::Normal);
        assert!(!settings.show_fps);
        assert_eq!(settings.mode, None);
    }

    #[test]
    fn resolve_ignores_an_unknown_preset_id() {
        let profile = GameProfile {
            perf_launch_preset: Some("made-up-preset".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&profile);
        assert!(settings.args.is_empty(), "no invented args");
    }

    #[test]
    fn quiet_mode_keeps_the_preset_and_forces_low_priority() {
        let profile = GameProfile {
            perf_launch_preset: Some("source-fps60".to_string()),
            perf_priority: "high".to_string(),
            launch_mode: Some("quiet".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&profile);
        assert_eq!(settings.args, vec!["+fps_max", "60"]);
        assert_eq!(settings.priority, Priority::Low);
        assert!(!settings.show_fps);
    }

    #[test]
    fn quiet_mode_without_a_preset_adds_no_cap_args() {
        let profile = GameProfile {
            launch_mode: Some("quiet".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&profile);
        assert!(settings.args.is_empty());
        assert_eq!(settings.priority, Priority::Low);
    }

    #[test]
    fn full_mode_drops_cap_presets_keeps_window_presets_forces_hud_and_high() {
        let capped = GameProfile {
            perf_launch_preset: Some("source-fps120".to_string()),
            launch_mode: Some("full".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&capped);
        assert!(settings.args.is_empty(), "cap preset dropped by full");
        assert_eq!(settings.priority, Priority::High);
        assert!(settings.show_fps);

        let windowed = GameProfile {
            perf_launch_preset: Some("unity-windowed-1080".to_string()),
            launch_mode: Some("full".to_string()),
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&windowed);
        assert_eq!(
            settings.args,
            vec![
                "-screen-width",
                "1920",
                "-screen-height",
                "1080",
                "-screen-fullscreen",
                "0"
            ],
            "window presets survive full mode"
        );
    }

    #[test]
    fn no_mode_uses_the_stored_priority_and_hud_toggle() {
        let profile = GameProfile {
            perf_priority: "low".to_string(),
            perf_show_fps: true,
            ..GameProfile::default()
        };
        let settings = resolve_launch_settings(&profile);
        assert_eq!(settings.priority, Priority::Low);
        assert!(settings.show_fps);
    }
}
