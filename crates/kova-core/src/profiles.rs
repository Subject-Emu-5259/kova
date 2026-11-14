//! Per-game profiles (V1 slice 5) — the user's layer over the
//! scanned library: a display-name override, a favorite flag, a
//! hidden flag, per-game launch options, an art URL override, and
//! launch statistics (count + last launched).
//!
//! v1.2.0 extends the profile with a Performance section
//! (`perf_*` fields — see [`crate::perf`]), real playtime tracking
//! (`total_play_seconds` / `last_session_*`), a personal rating +
//! note, custom cover art, a save-folder pointer, and a one-tap
//! launch mode. Every new field is serde-defaulted, so a profile
//! entry written before v1.2.0 loads with the new fields at their
//! defaults.
//!
//! Profiles are keyed by [`profile_key`] — `"<source>:<id>"` —
//! which depends only on the game's source and store id, never on
//! its name, so a profile (and its key) survives the user renaming
//! the game through the very override the profile carries.
//!
//! This module is pure: it holds no state and does no I/O. The app
//! persists the [`Profiles`] map inside its state file and hands it
//! to [`apply_profiles`] after each scan.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{Game, UnifiedLibrary};

/// The default process priority for a profile that names none.
fn default_perf_priority() -> String {
    "normal".to_string()
}

/// One game's profile. Every field defaults, so a profile entry in
/// a state file may omit any of them — and a state file written
/// before slice 5 (no profiles at all) loads as an empty map.
///
/// `Default` is implemented by hand (not derived) because
/// `perf_priority` defaults to `"normal"`, not `""`; serde uses
/// the same default for a missing field via
/// [`default_perf_priority`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameProfile {
    /// Display-name override. `None` (or blank) means "show the
    /// scanned name".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_override: Option<String>,
    /// Favorite games lead the Quick Panel and fill the Home
    /// Favorites row.
    #[serde(default)]
    pub favorite: bool,
    /// Hidden games are filtered out of the launcher views
    /// (reversible from Settings).
    #[serde(default)]
    pub hidden: bool,
    /// Extra launch arguments — honored only for games installed
    /// locally (a filesystem-path launch target); store URI and web
    /// launches ignore them, because there is no local process for
    /// KOVA to pass arguments to. Empty means none.
    #[serde(default)]
    pub launch_args: String,
    /// Art URL override: when set, the frontend layers this image
    /// over the game's generated art.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art_url_override: Option<String>,
    /// How many times KOVA has launched this game.
    #[serde(default)]
    pub launch_count: u64,
    /// When KOVA last launched this game (Unix epoch seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_launched: Option<i64>,
    // ---- v1.2.0: performance (§1) ----
    /// Id of a launch-arg preset from [`crate::perf::PERF_PRESETS`]
    /// (e.g. `"source-fps60"`), applied on top of `launch_args`
    /// at launch. `None` means no preset. An unknown id resolves
    /// to no preset args — never invented ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perf_launch_preset: Option<String>,
    /// Launch with Apple's Metal FPS HUD on (`MTL_HUD_ENABLED=1`,
    /// macOS only, Metal games only). Monitoring, not a cap.
    #[serde(default)]
    pub perf_show_fps: bool,
    /// Process priority: `"low"` / `"normal"` / `"high"`. Applies
    /// only to executables KOVA spawns directly; `.app` launches
    /// via macOS `open` ignore it, and on Windows it is stored but
    /// not applied in v1.2.0 (see [`crate::perf::Priority`]).
    #[serde(default = "default_perf_priority")]
    pub perf_priority: String,
    // ---- v1.2.0: playtime (§2) ----
    /// Total seconds KOVA has watched this game run, summed over
    /// completed sessions. Only sessions KOVA launched locally
    /// and watched to completion count.
    #[serde(default)]
    pub total_play_seconds: u64,
    /// Length of the most recent completed session, in seconds.
    #[serde(default)]
    pub last_session_seconds: u64,
    /// When the most recent completed session ended (Unix epoch
    /// seconds). `None` until the first recorded session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_end: Option<i64>,
    // ---- v1.2.0: rating, notes, art, saves, launch mode (§7/§10) ----
    /// Personal star rating, 1–5. The app validates the range on
    /// the way in; anything else is dropped to `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    /// A private note on the game. Capped at 2000 characters by
    /// the app on the way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Custom cover art: a `data:image/...` URL from a frontend
    /// upload (downscaled by canvas, capped like the avatar —
    /// see the app's `set_profile`). `None` means the generated
    /// art / art override stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_art: Option<String>,
    /// Where this game's save files live, when the player set it
    /// (used by save backups). `None` means "auto-detect".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_folder: Option<String>,
    /// One-tap launch mode: `"quiet"` / `"full"` / `None` (see
    /// [`crate::perf::LaunchMode`]). `None` means "apply the
    /// profile's own perf settings as stored".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_mode: Option<String>,
}

impl Default for GameProfile {
    fn default() -> Self {
        GameProfile {
            name_override: None,
            favorite: false,
            hidden: false,
            launch_args: String::new(),
            art_url_override: None,
            launch_count: 0,
            last_launched: None,
            perf_launch_preset: None,
            perf_show_fps: false,
            perf_priority: default_perf_priority(),
            total_play_seconds: 0,
            last_session_seconds: 0,
            last_session_end: None,
            rating: None,
            note: None,
            cover_art: None,
            save_folder: None,
            launch_mode: None,
        }
    }
}

/// All profiles, keyed by [`profile_key`]. A `BTreeMap` so the
/// persisted state file has a stable, diff-friendly key order.
pub type Profiles = BTreeMap<String, GameProfile>;

/// The stable profile key for a game: `"<source>:<id>"`.
///
/// The key deliberately ignores the game's name: a profile must
/// keep matching its game after a rename override, a store
/// re-title, or slice 4's local-install merge (which preserves the
/// Avok record's source and id).
pub fn profile_key(game: &Game) -> String {
    format!("{}:{}", game.source, game.id)
}

/// Record one launch in a profile: the count goes up by one and
/// `last_launched` is set to `now` (Unix epoch seconds). Every
/// other field is untouched. This is the update the app's
/// `launch_game` command applies after a successful launch.
pub fn record_launch(profile: &mut GameProfile, now: i64) {
    profile.launch_count = profile.launch_count.saturating_add(1);
    profile.last_launched = Some(now);
}

/// Record one completed play session (v1.2.0): `seconds` of play
/// ending at `end` (Unix epoch seconds) are added to the running
/// total, and the last-session fields are overwritten with this
/// session. Every other field is untouched. This is the update the
/// app's playtime watcher applies when a game it launched exits.
pub fn record_session(profile: &mut GameProfile, seconds: u64, end: i64) {
    profile.total_play_seconds = profile.total_play_seconds.saturating_add(seconds);
    profile.last_session_seconds = seconds;
    profile.last_session_end = Some(end);
}

// ---------------------------------------------------------------------------
// One profile per game (slice 5.1)
//
// Quick Resume recents are launch-time *snapshots*. A snapshot can
// carry a different identity than the game's current library
// record: slice 4's local-install merge folds a standalone install
// into the Avok shelf record, but a recents snapshot taken before
// (or outside) that merge still says `standalone:<path>` while the
// library says `avok:dispatch-hq` — so launches and profile edits
// recorded through the Quick Resume tile landed under a second
// profile key for the same game. The helpers below resolve a
// snapshot back to its library record and fold two profiles into
// one, so a game ends up with exactly one profile no matter which
// tile launched it.
// ---------------------------------------------------------------------------

/// Resolve a recents snapshot to the library record for the same
/// game, when the library has one. Matching rules, in order:
///
/// 1. Same `source` + `id` — the ordinary case (also refreshes a
///    stale snapshot's fields from the fresh scan).
/// 2. The snapshot is a standalone/itch local record whose
///    `install_path` equals a library game's `install_path` —
///    this catches the merged-Avok case, where the library record
///    kept the Avok source/id and took the standalone install's
///    path. When several library games share the path, a record
///    that is not the snapshot itself wins.
/// 3. Same `launch_uri`, when the snapshot's is non-empty and
///    **exactly one** library game carries it — a URI shared by
///    several games (a generic web URL, a store page) identifies
///    nothing and never resolves.
///
/// No match returns the snapshot unchanged.
pub fn resolve_recent(recent: &Game, library: &UnifiedLibrary) -> Game {
    let games = library.all_games();

    // (1) Same source + id.
    if let Some(found) = games
        .iter()
        .find(|g| g.source == recent.source && g.id == recent.id)
    {
        return (*found).clone();
    }

    // (2) Local record whose install path a library game took over.
    if (recent.source == "standalone" || recent.source == "itch")
        && !recent.install_path.as_os_str().is_empty()
    {
        let matches: Vec<&Game> = games
            .iter()
            .filter(|g| g.install_path == recent.install_path)
            .copied()
            .collect();
        if let Some(found) = matches
            .iter()
            .find(|g| g.source != recent.source || g.id != recent.id)
            .or_else(|| matches.first())
        {
            return (*found).clone();
        }
    }

    // (3) A launch URI exactly one library game carries.
    if !recent.launch_uri.is_empty() {
        let matches: Vec<&Game> = games
            .iter()
            .filter(|g| g.launch_uri == recent.launch_uri)
            .copied()
            .collect();
        if matches.len() == 1 {
            return matches[0].clone();
        }
    }

    recent.clone()
}

/// Resolve every recents snapshot against the library and
/// de-duplicate by the resolved record's (source, id), keeping the
/// first (most recent) occurrence and the list's order. Two
/// snapshots of one game — say a standalone snapshot and the
/// library record itself — collapse into the single library
/// record.
pub fn resolve_recents(recents: &[Game], library: &UnifiedLibrary) -> Vec<Game> {
    let mut resolved: Vec<Game> = Vec::with_capacity(recents.len());
    for recent in recents {
        let game = resolve_recent(recent, library);
        if !resolved
            .iter()
            .any(|g| g.source == game.source && g.id == game.id)
        {
            resolved.push(game);
        }
    }
    resolved
}

/// Merge two profiles for the *same* game into one: `dst` is the
/// profile that survives (under the resolved library key), `src`
/// is the one being folded away (the snapshot key's).
///
/// Launch counts sum and `last_launched` takes the later stamp —
/// both profiles recorded real launches of one game. The flags are
/// sticky (`favorite` / `hidden` are OR-ed: either profile's choice
/// counts). The text fields prefer `dst`'s value and fall back to
/// `src`'s: `name_override` / `art_url_override` when `dst` has one
/// set, `launch_args` when `dst`'s is non-empty.
///
/// v1.2.0 fields follow the same shape:
/// * Playtime sums (`total_play_seconds`), like launch counts —
///   both sides watched real sessions of one game. The last-session
///   pair (`last_session_seconds` + `last_session_end`) comes
///   whole from the side with the later `last_session_end`
///   (`None` counts as "never", older than any stamp); on a tie,
///   `dst`'s pair wins. The two fields are never mixed across
///   sides — a length only means something with its own end stamp.
/// * `rating` / `note` / `cover_art` / `save_folder` /
///   `launch_mode` / `perf_launch_preset` take the non-empty side,
///   `dst` first — same dst-wins rule as the text fields.
/// * `perf_show_fps` is OR-ed, like the other flags.
/// * `perf_priority`: a deliberate non-default choice on either
///   side survives — `dst` wins unless it is `"normal"` (the
///   default, treated as "no choice made"), in which case `src`'s
///   value stands. Two different non-default choices resolve to
///   `dst`'s.
pub fn merge_profiles(dst: &GameProfile, src: &GameProfile) -> GameProfile {
    let last_launched = match (dst.last_launched, src.last_launched) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    // The last-session pair travels together, from the side whose
    // session ended later. `None` (no session yet) sorts below any
    // stamp; equal stamps keep dst's pair.
    let (last_session_seconds, last_session_end) =
        if src.last_session_end.unwrap_or(i64::MIN) > dst.last_session_end.unwrap_or(i64::MIN) {
            (src.last_session_seconds, src.last_session_end)
        } else {
            (dst.last_session_seconds, dst.last_session_end)
        };
    GameProfile {
        name_override: dst
            .name_override
            .clone()
            .or_else(|| src.name_override.clone()),
        favorite: dst.favorite || src.favorite,
        hidden: dst.hidden || src.hidden,
        launch_args: if dst.launch_args.is_empty() {
            src.launch_args.clone()
        } else {
            dst.launch_args.clone()
        },
        art_url_override: dst
            .art_url_override
            .clone()
            .or_else(|| src.art_url_override.clone()),
        launch_count: dst.launch_count.saturating_add(src.launch_count),
        last_launched,
        perf_launch_preset: dst
            .perf_launch_preset
            .clone()
            .or_else(|| src.perf_launch_preset.clone()),
        perf_show_fps: dst.perf_show_fps || src.perf_show_fps,
        perf_priority: if dst.perf_priority == "normal" {
            src.perf_priority.clone()
        } else {
            dst.perf_priority.clone()
        },
        total_play_seconds: dst
            .total_play_seconds
            .saturating_add(src.total_play_seconds),
        last_session_seconds,
        last_session_end,
        rating: dst.rating.or(src.rating),
        note: dst.note.clone().or_else(|| src.note.clone()),
        cover_art: dst.cover_art.clone().or_else(|| src.cover_art.clone()),
        save_folder: dst
            .save_folder
            .clone()
            .or_else(|| src.save_folder.clone()),
        launch_mode: dst
            .launch_mode
            .clone()
            .or_else(|| src.launch_mode.clone()),
    }
}

/// Fold the profile stored under `from_key` into the one under
/// `into_key` (see [`merge_profiles`]) and remove `from_key`, so
/// the map never keeps two profiles for one resolved game. A
/// missing `from_key`, or `from_key == into_key`, is a no-op.
pub fn fold_profile_into(profiles: &mut Profiles, from_key: &str, into_key: &str) {
    if from_key == into_key {
        return;
    }
    let Some(src) = profiles.remove(from_key) else {
        return;
    };
    let dst = profiles.entry(into_key.to_string()).or_default();
    *dst = merge_profiles(dst, &src);
}

/// A scanned game merged with its profile for display.
///
/// Serializes as the [`Game`] record's own fields (via flatten)
/// plus the profile-derived fields below, so the frontend JSON
/// keeps the exact shape it has always read for games, with
/// `display_name` and friends added. The scanned `name` is never
/// mutated — the override lives in `display_name` only.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnnotatedGame {
    /// The scanned game record, unchanged.
    #[serde(flatten)]
    pub game: Game,
    /// The profile key (`"<source>:<id>"`).
    pub key: String,
    /// What the UI should call the game: the profile's name
    /// override when set (and non-blank), else the scanned name.
    pub display_name: String,
    /// The profile's art URL override, if any.
    pub art_url_override: Option<String>,
    /// Whether the user favorited this game.
    pub favorite: bool,
    /// Whether the user hid this game.
    pub hidden: bool,
    /// Launches recorded for this game (0 without a profile).
    pub launch_count: u64,
    /// Last launch time from the profile, if any.
    pub last_launched: Option<i64>,
    /// Total playtime in seconds from the profile (0 without a
    /// profile). The library view uses this for "most-played by
    /// time" without a second fetch.
    pub total_play_seconds: u64,
    /// The profile's star rating, 1–5, if the player set one.
    pub rating: Option<u8>,
    /// The profile's custom cover art (data URL), if set.
    pub cover_art: Option<String>,
}

/// One source's slice of an [`AnnotatedLibrary`] — mirrors
/// [`crate::SourceReport`], with annotated games.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnnotatedSource {
    pub source: String,
    pub roots: Vec<PathBuf>,
    pub games: Vec<AnnotatedGame>,
    pub skipped: usize,
}

/// A [`UnifiedLibrary`] with profiles applied — the display-ready
/// library. `total_games` is the scanned total (hidden games
/// included); use [`visible_games`] for what the UI should show.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AnnotatedLibrary {
    pub sources: Vec<AnnotatedSource>,
    pub total_games: usize,
}

impl AnnotatedLibrary {
    /// Every annotated game from every source, in report order.
    pub fn all_games(&self) -> Vec<&AnnotatedGame> {
        self.sources.iter().flat_map(|s| s.games.iter()).collect()
    }
}

/// Merge one game with its profile (the default profile when the
/// map has no entry for the game's key).
pub fn annotate_game(game: &Game, profiles: &Profiles) -> AnnotatedGame {
    let key = profile_key(game);
    let profile = profiles.get(&key);
    let display_name = profile
        .and_then(|p| p.name_override.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| game.name.clone());
    AnnotatedGame {
        game: game.clone(),
        key,
        display_name,
        art_url_override: profile.and_then(|p| p.art_url_override.clone()),
        favorite: profile.map(|p| p.favorite).unwrap_or(false),
        hidden: profile.map(|p| p.hidden).unwrap_or(false),
        launch_count: profile.map(|p| p.launch_count).unwrap_or(0),
        last_launched: profile.and_then(|p| p.last_launched),
        total_play_seconds: profile.map(|p| p.total_play_seconds).unwrap_or(0),
        rating: profile.and_then(|p| p.rating),
        cover_art: profile.and_then(|p| p.cover_art.clone()),
    }
}

/// Apply a profile map to a scanned library, returning the
/// display-ready annotated library. With an empty map this is the
/// identity: every game's display name is its scanned name, no
/// favorites, nothing hidden, zeroed stats.
pub fn apply_profiles(library: &UnifiedLibrary, profiles: &Profiles) -> AnnotatedLibrary {
    let sources = library
        .sources
        .iter()
        .map(|report| AnnotatedSource {
            source: report.source.clone(),
            roots: report.roots.clone(),
            games: report
                .games
                .iter()
                .map(|game| annotate_game(game, profiles))
                .collect(),
            skipped: report.skipped,
        })
        .collect();
    AnnotatedLibrary {
        sources,
        total_games: library.total_games,
    }
}

/// The games a launcher view should show: the annotated library
/// with hidden games filtered out, in library order. (Favorites
/// ordering, when wanted, is [`favorites_first`]'s job.)
pub fn visible_games(library: &AnnotatedLibrary) -> Vec<&AnnotatedGame> {
    library
        .all_games()
        .into_iter()
        .filter(|game| !game.hidden)
        .collect()
}

/// Order games favorites-first: favorites lead, non-favorites
/// follow, and each group is ordered by display name
/// (case-insensitive), with the profile key as a stable tiebreak.
/// The Quick Panel and the Home Favorites row use this ordering.
pub fn favorites_first(games: &mut [&AnnotatedGame]) {
    games.sort_by(|a, b| {
        b.favorite
            .cmp(&a.favorite)
            .then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
            .then_with(|| a.key.cmp(&b.key))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceReport;

    fn game(source: &str, id: &str, name: &str) -> Game {
        Game {
            source: source.to_string(),
            id: id.to_string(),
            appid: 0,
            name: name.to_string(),
            installdir: String::new(),
            install_path: PathBuf::new(),
            size_on_disk: 0,
            last_updated: 0,
            library: PathBuf::from("built-in"),
            launch_uri: String::new(),
        }
    }

    fn library(games: Vec<Game>) -> UnifiedLibrary {
        let total = games.len();
        UnifiedLibrary {
            sources: vec![SourceReport {
                source: "steam".to_string(),
                roots: Vec::new(),
                games,
                skipped: 0,
            }],
            total_games: total,
        }
    }

    fn profiles_with(entries: Vec<(&str, GameProfile)>) -> Profiles {
        entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn profile_key_is_source_and_id_only() {
        let a = game("steam", "730", "Counter-Strike 2");
        let renamed = game("steam", "730", "A Completely Different Title");
        assert_eq!(profile_key(&a), "steam:730");
        // The key survives renames: it never looks at the name.
        assert_eq!(profile_key(&a), profile_key(&renamed));
        assert_ne!(
            profile_key(&a),
            profile_key(&game("epic", "730", "Counter-Strike 2"))
        );
    }

    #[test]
    fn name_override_wins_and_blank_override_falls_back() {
        let cs = game("steam", "730", "Counter-Strike 2");
        let profiles = profiles_with(vec![(
            "steam:730",
            GameProfile {
                name_override: Some("CS2".to_string()),
                ..GameProfile::default()
            },
        )]);
        let annotated = annotate_game(&cs, &profiles);
        assert_eq!(annotated.display_name, "CS2");
        // The scanned name itself is never mutated.
        assert_eq!(annotated.game.name, "Counter-Strike 2");

        let blank = profiles_with(vec![(
            "steam:730",
            GameProfile {
                name_override: Some("   ".to_string()),
                ..GameProfile::default()
            },
        )]);
        assert_eq!(annotate_game(&cs, &blank).display_name, "Counter-Strike 2");
    }

    #[test]
    fn empty_profiles_are_the_identity() {
        let lib = library(vec![
            game("steam", "730", "Counter-Strike 2"),
            game("steam", "570", "Dota 2"),
        ]);
        let annotated = apply_profiles(&lib, &Profiles::new());
        assert_eq!(annotated.total_games, 2);
        for game in annotated.all_games() {
            assert_eq!(game.display_name, game.game.name);
            assert!(!game.favorite);
            assert!(!game.hidden);
            assert_eq!(game.launch_count, 0);
            assert_eq!(game.last_launched, None);
            assert_eq!(game.art_url_override, None);
        }
        assert_eq!(visible_games(&annotated).len(), 2);
    }

    #[test]
    fn hidden_games_are_filtered_from_visible() {
        let lib = library(vec![
            game("steam", "730", "Counter-Strike 2"),
            game("steam", "570", "Dota 2"),
            game("steam", "440", "Team Fortress 2"),
        ]);
        let profiles = profiles_with(vec![(
            "steam:570",
            GameProfile {
                hidden: true,
                ..GameProfile::default()
            },
        )]);
        let annotated = apply_profiles(&lib, &profiles);
        // The annotated library still carries the hidden game
        // (Settings needs it); only the visible view drops it.
        assert_eq!(annotated.all_games().len(), 3);
        let visible = visible_games(&annotated);
        assert_eq!(visible.len(), 2);
        assert!(visible.iter().all(|g| g.game.id != "570"));
    }

    #[test]
    fn favorites_come_first_then_display_name() {
        let lib = library(vec![
            game("steam", "1", "Zebra Racer"),
            game("steam", "2", "alpha quest"),
            game("steam", "3", "Moon Kart"),
            game("steam", "4", "Beta Siege"),
        ]);
        let profiles = profiles_with(vec![
            (
                "steam:3",
                GameProfile {
                    favorite: true,
                    ..GameProfile::default()
                },
            ),
            (
                "steam:2",
                GameProfile {
                    favorite: true,
                    ..GameProfile::default()
                },
            ),
        ]);
        let annotated = apply_profiles(&lib, &profiles);
        let mut visible = visible_games(&annotated);
        favorites_first(&mut visible);
        let names: Vec<&str> = visible.iter().map(|g| g.display_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha quest", "Moon Kart", "Beta Siege", "Zebra Racer"]
        );
    }

    #[test]
    fn record_launch_counts_and_stamps() {
        let mut profile = GameProfile {
            favorite: true,
            launch_args: "--fullscreen".to_string(),
            ..GameProfile::default()
        };
        record_launch(&mut profile, 1_730_000_000);
        assert_eq!(profile.launch_count, 1);
        assert_eq!(profile.last_launched, Some(1_730_000_000));
        record_launch(&mut profile, 1_730_003_600);
        assert_eq!(profile.launch_count, 2);
        assert_eq!(profile.last_launched, Some(1_730_003_600));
        // Other fields are untouched by a launch.
        assert!(profile.favorite);
        assert_eq!(profile.launch_args, "--fullscreen");
    }

    #[test]
    fn art_override_is_carried_on_the_record() {
        let dispatch = game("avok", "dispatch-hq", "Dispatch HQ");
        let profiles = profiles_with(vec![(
            "avok:dispatch-hq",
            GameProfile {
                art_url_override: Some("https://example.invalid/art.png".to_string()),
                launch_count: 7,
                last_launched: Some(1_729_000_000),
                ..GameProfile::default()
            },
        )]);
        let annotated = annotate_game(&dispatch, &profiles);
        assert_eq!(
            annotated.art_url_override.as_deref(),
            Some("https://example.invalid/art.png")
        );
        assert_eq!(annotated.launch_count, 7);
        assert_eq!(annotated.last_launched, Some(1_729_000_000));
    }

    #[test]
    fn profile_json_round_trips_and_defaults_missing_fields() {
        // A minimal entry — as in a hand-edited or older state
        // file — fills every other field with its default.
        let parsed: GameProfile = serde_json::from_str(r#"{"favorite": true}"#).unwrap();
        assert!(parsed.favorite);
        assert!(!parsed.hidden);
        assert_eq!(parsed.launch_args, "");
        assert_eq!(parsed.launch_count, 0);
        assert_eq!(parsed.name_override, None);
        assert_eq!(parsed.last_launched, None);

        let full = GameProfile {
            name_override: Some("CS2".to_string()),
            favorite: true,
            hidden: false,
            launch_args: "-novid".to_string(),
            art_url_override: None,
            launch_count: 3,
            last_launched: Some(42),
            ..GameProfile::default()
        };
        let json = serde_json::to_string(&full).unwrap();
        let back: GameProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, full);
    }

    // ---- slice 5.1: one profile per game -------------------------

    /// A slice-4-style library: the standalone Dispatch HQ install
    /// folded into the Avok record (Avok source/id, standalone
    /// install path + launch target), one Steam game, and two
    /// records sharing one generic web launch URI.
    fn library_51() -> UnifiedLibrary {
        let mut dispatch = game("avok", "dispatch-hq", "Dispatch HQ");
        dispatch.install_path = PathBuf::from("/games/Dispatch HQ.app");
        dispatch.launch_uri = "/games/Dispatch HQ.app".to_string();
        let mut zebra = game("steam", "9", "Zebra Racer");
        zebra.launch_uri = "steam://rungameid/9".to_string();
        let mut web_a = game("avok", "web-a", "Web A");
        web_a.launch_uri = "https://example.invalid/play".to_string();
        let mut web_b = game("avok", "web-b", "Web B");
        web_b.launch_uri = "https://example.invalid/play".to_string();
        let total = 4;
        UnifiedLibrary {
            sources: vec![SourceReport {
                source: "mixed".to_string(),
                roots: Vec::new(),
                games: vec![dispatch, zebra, web_a, web_b],
                skipped: 0,
            }],
            total_games: total,
        }
    }

    /// The pre-merge Quick Resume snapshot of Dispatch HQ: the
    /// standalone scanner's record for the same .app.
    fn standalone_dispatch_snapshot() -> Game {
        let mut snapshot = game("standalone", "/games/Dispatch HQ.app", "Dispatch HQ");
        snapshot.install_path = PathBuf::from("/games/Dispatch HQ.app");
        snapshot.launch_uri = "/games/Dispatch HQ.app".to_string();
        snapshot
    }

    #[test]
    fn resolve_recent_by_install_path_finds_the_merged_avok_record() {
        let lib = library_51();
        let resolved = resolve_recent(&standalone_dispatch_snapshot(), &lib);
        assert_eq!(resolved.source, "avok");
        assert_eq!(resolved.id, "dispatch-hq");
        assert_eq!(profile_key(&resolved), "avok:dispatch-hq");
    }

    #[test]
    fn resolve_recent_by_source_and_id_refreshes_the_snapshot() {
        let lib = library_51();
        // A stale snapshot of a library game (old title, no art
        // fields) resolves to the library's current record.
        let stale = game("steam", "9", "Zebra Racer (Old Title)");
        let resolved = resolve_recent(&stale, &lib);
        assert_eq!(resolved.source, "steam");
        assert_eq!(resolved.id, "9");
        assert_eq!(resolved.name, "Zebra Racer");
        assert_eq!(resolved.launch_uri, "steam://rungameid/9");
    }

    #[test]
    fn resolve_recent_without_a_match_returns_the_snapshot() {
        let lib = library_51();
        let stranger = game("gog", "1207664643", "Not In The Library");
        assert_eq!(resolve_recent(&stranger, &lib), stranger);
    }

    #[test]
    fn resolve_recent_by_unique_launch_uri() {
        let lib = library_51();
        // A renamed-store snapshot: source/id unknown to the
        // library, but its launch URI is carried by exactly one
        // library game.
        let mut snapshot = game("standalone", "some-folder", "Zebra Racer");
        snapshot.launch_uri = "steam://rungameid/9".to_string();
        let resolved = resolve_recent(&snapshot, &lib);
        assert_eq!(resolved.source, "steam");
        assert_eq!(resolved.id, "9");
    }

    #[test]
    fn resolve_recent_ignores_an_ambiguous_launch_uri() {
        let lib = library_51();
        // Two library games share this generic web URI, so it
        // identifies neither — the snapshot must pass through.
        let mut snapshot = game("standalone", "mystery", "Mystery Game");
        snapshot.launch_uri = "https://example.invalid/play".to_string();
        assert_eq!(resolve_recent(&snapshot, &lib), snapshot);
    }

    #[test]
    fn resolve_recents_collapses_snapshots_of_one_game() {
        let lib = library_51();
        let snapshot = standalone_dispatch_snapshot();
        let avok = lib
            .all_games()
            .into_iter()
            .find(|g| g.id == "dispatch-hq")
            .unwrap()
            .clone();
        let resolved = resolve_recents(&[snapshot, avok], &lib);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].source, "avok");
        assert_eq!(resolved[0].id, "dispatch-hq");
    }

    #[test]
    fn merge_profiles_sums_counts_and_prefers_dst_text() {
        let dst = GameProfile {
            name_override: Some("HQ".to_string()),
            favorite: false,
            hidden: true,
            launch_args: String::new(),
            art_url_override: None,
            launch_count: 2,
            last_launched: Some(200),
            ..GameProfile::default()
        };
        let src = GameProfile {
            name_override: Some("Dispatch".to_string()),
            favorite: true,
            hidden: false,
            launch_args: "--windowed".to_string(),
            art_url_override: Some("https://example.invalid/a.png".to_string()),
            launch_count: 3,
            last_launched: Some(150),
            ..GameProfile::default()
        };
        let merged = merge_profiles(&dst, &src);
        assert_eq!(merged.launch_count, 5);
        assert_eq!(merged.last_launched, Some(200));
        assert!(merged.favorite, "flags are OR-ed");
        assert!(merged.hidden, "flags are OR-ed");
        assert_eq!(merged.name_override.as_deref(), Some("HQ"), "dst text wins");
        assert_eq!(
            merged.launch_args, "--windowed",
            "empty dst args fall back to src"
        );
        assert_eq!(
            merged.art_url_override.as_deref(),
            Some("https://example.invalid/a.png"),
            "unset dst art falls back to src"
        );

        // Reverse direction: the other stamp is later, dst's
        // non-empty args win.
        let mut dst2 = dst.clone();
        dst2.launch_args = "-novid".to_string();
        let merged2 = merge_profiles(&dst2, &src);
        assert_eq!(merged2.launch_args, "-novid");
        assert_eq!(merged2.last_launched, Some(200));
        let merged3 = merge_profiles(&src, &dst);
        assert_eq!(merged3.last_launched, Some(200), "max, not dst-wins");
        // None stamps stay None only when both sides are None.
        let merged4 = merge_profiles(&GameProfile::default(), &GameProfile::default());
        assert_eq!(merged4.last_launched, None);
        assert_eq!(merged4.launch_count, 0);
    }

    #[test]
    fn fold_profile_into_moves_the_profile_and_drops_the_old_key() {
        // Dre's stranded Dispatch HQ launch: count 1 under the
        // standalone snapshot key, nothing under the Avok key yet.
        let mut profiles = profiles_with(vec![(
            "standalone:/games/Dispatch HQ.app",
            GameProfile {
                favorite: true,
                launch_count: 1,
                last_launched: Some(1_730_000_000),
                ..GameProfile::default()
            },
        )]);
        fold_profile_into(
            &mut profiles,
            "standalone:/games/Dispatch HQ.app",
            "avok:dispatch-hq",
        );
        assert!(!profiles.contains_key("standalone:/games/Dispatch HQ.app"));
        let folded = &profiles["avok:dispatch-hq"];
        assert_eq!(folded.launch_count, 1);
        assert!(folded.favorite);

        // A second fold with an existing destination sums.
        profiles.insert(
            "standalone:/games/Dispatch HQ.app".to_string(),
            GameProfile {
                launch_count: 2,
                last_launched: Some(1_729_000_000),
                ..GameProfile::default()
            },
        );
        fold_profile_into(
            &mut profiles,
            "standalone:/games/Dispatch HQ.app",
            "avok:dispatch-hq",
        );
        let folded = &profiles["avok:dispatch-hq"];
        assert_eq!(folded.launch_count, 3, "counts sum across the fold");
        assert_eq!(
            folded.last_launched,
            Some(1_730_000_000),
            "the later stamp survives"
        );

        // No-ops: missing source key, and folding a key into itself.
        fold_profile_into(&mut profiles, "steam:missing", "avok:dispatch-hq");
        fold_profile_into(&mut profiles, "avok:dispatch-hq", "avok:dispatch-hq");
        assert_eq!(profiles["avok:dispatch-hq"].launch_count, 3);
        assert_eq!(profiles.len(), 1);
    }

    #[test]
    fn annotated_game_serializes_with_the_games_own_shape() {
        let cs = game("steam", "730", "Counter-Strike 2");
        let annotated = annotate_game(&cs, &Profiles::new());
        let value = serde_json::to_value(&annotated).unwrap();
        // The Game fields ride at the top level (flatten), exactly
        // as the frontend has always read them…
        assert_eq!(value["source"], "steam");
        assert_eq!(value["id"], "730");
        assert_eq!(value["name"], "Counter-Strike 2");
        // …and the profile-derived fields join them.
        assert_eq!(value["key"], "steam:730");
        assert_eq!(value["display_name"], "Counter-Strike 2");
        assert_eq!(value["favorite"], false);
        assert_eq!(value["hidden"], false);
    }

    // ---- v1.2.0: perf, playtime, rating, notes, art, saves ----

    #[test]
    fn new_profile_fields_default_sensibly() {
        let profile = GameProfile::default();
        assert_eq!(profile.perf_launch_preset, None);
        assert!(!profile.perf_show_fps);
        assert_eq!(profile.perf_priority, "normal");
        assert_eq!(profile.total_play_seconds, 0);
        assert_eq!(profile.last_session_seconds, 0);
        assert_eq!(profile.last_session_end, None);
        assert_eq!(profile.rating, None);
        assert_eq!(profile.note, None);
        assert_eq!(profile.cover_art, None);
        assert_eq!(profile.save_folder, None);
        assert_eq!(profile.launch_mode, None);
    }

    #[test]
    fn pre_120_profile_json_loads_clean_with_defaults() {
        // A profile entry exactly as v1.1.1 wrote it — none of the
        // v1.2.0 fields present. It must deserialize with every
        // new field at its default, not error.
        let parsed: GameProfile = serde_json::from_str(
            r#"{
                "name_override": "CS2",
                "favorite": true,
                "hidden": false,
                "launch_args": "-novid",
                "art_url_override": null,
                "launch_count": 12,
                "last_launched": 1730000000
            }"#,
        )
        .unwrap();
        assert_eq!(parsed.name_override.as_deref(), Some("CS2"));
        assert!(parsed.favorite);
        assert_eq!(parsed.launch_count, 12);
        assert_eq!(parsed.perf_launch_preset, None);
        assert!(!parsed.perf_show_fps);
        assert_eq!(parsed.perf_priority, "normal");
        assert_eq!(parsed.total_play_seconds, 0);
        assert_eq!(parsed.last_session_seconds, 0);
        assert_eq!(parsed.last_session_end, None);
        assert_eq!(parsed.rating, None);
        assert_eq!(parsed.note, None);
        assert_eq!(parsed.cover_art, None);
        assert_eq!(parsed.save_folder, None);
        assert_eq!(parsed.launch_mode, None);
    }

    #[test]
    fn full_v120_profile_round_trips() {
        let full = GameProfile {
            perf_launch_preset: Some("source-fps60".to_string()),
            perf_show_fps: true,
            perf_priority: "high".to_string(),
            total_play_seconds: 7265,
            last_session_seconds: 3600,
            last_session_end: Some(1_730_100_000),
            rating: Some(5),
            note: Some("Best with friends.".to_string()),
            cover_art: Some("data:image/png;base64,AAAA".to_string()),
            save_folder: Some("/Users/dre/Library/Application Support/CS2".to_string()),
            launch_mode: Some("quiet".to_string()),
            ..GameProfile::default()
        };
        let json = serde_json::to_string(&full).unwrap();
        let back: GameProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, full);
    }

    #[test]
    fn record_session_adds_to_total_and_overwrites_last() {
        let mut profile = GameProfile {
            total_play_seconds: 100,
            last_session_seconds: 100,
            last_session_end: Some(1_000),
            ..GameProfile::default()
        };
        record_session(&mut profile, 3_600, 1_730_000_000);
        assert_eq!(profile.total_play_seconds, 3_700);
        assert_eq!(profile.last_session_seconds, 3_600);
        assert_eq!(profile.last_session_end, Some(1_730_000_000));
        record_session(&mut profile, 60, 1_730_000_100);
        assert_eq!(profile.total_play_seconds, 3_760);
        assert_eq!(profile.last_session_seconds, 60);
        assert_eq!(profile.last_session_end, Some(1_730_000_100));
    }

    #[test]
    fn merge_profiles_handles_the_v120_fields() {
        let dst = GameProfile {
            perf_launch_preset: None,
            perf_show_fps: false,
            perf_priority: "normal".to_string(),
            total_play_seconds: 1_000,
            last_session_seconds: 1_000,
            last_session_end: Some(200),
            rating: None,
            note: Some("dst note".to_string()),
            cover_art: None,
            save_folder: None,
            launch_mode: Some("quiet".to_string()),
            ..GameProfile::default()
        };
        let src = GameProfile {
            perf_launch_preset: Some("source-fps60".to_string()),
            perf_show_fps: true,
            perf_priority: "high".to_string(),
            total_play_seconds: 500,
            last_session_seconds: 500,
            last_session_end: Some(300),
            rating: Some(4),
            note: Some("src note".to_string()),
            cover_art: Some("data:image/png;base64,AAAA".to_string()),
            save_folder: Some("/saves/game".to_string()),
            launch_mode: Some("full".to_string()),
            ..GameProfile::default()
        };
        let merged = merge_profiles(&dst, &src);
        // Playtime sums; the last-session pair comes whole from
        // the side whose session ended later (src, stamp 300).
        assert_eq!(merged.total_play_seconds, 1_500);
        assert_eq!(merged.last_session_seconds, 500);
        assert_eq!(merged.last_session_end, Some(300));
        // The non-empty side wins, dst first.
        assert_eq!(
            merged.perf_launch_preset.as_deref(),
            Some("source-fps60"),
            "unset dst preset falls back to src"
        );
        assert!(merged.perf_show_fps, "flags are OR-ed");
        assert_eq!(
            merged.perf_priority, "high",
            "a default dst priority yields to src's deliberate choice"
        );
        assert_eq!(merged.rating, Some(4));
        assert_eq!(merged.note.as_deref(), Some("dst note"), "dst text wins");
        assert_eq!(
            merged.cover_art.as_deref(),
            Some("data:image/png;base64,AAAA")
        );
        assert_eq!(merged.save_folder.as_deref(), Some("/saves/game"));
        assert_eq!(merged.launch_mode.as_deref(), Some("quiet"), "dst wins");

        // Reverse: dst's later session pair wins whole, and dst's
        // deliberate priority beats src's.
        let merged2 = merge_profiles(&src, &dst);
        assert_eq!(merged2.total_play_seconds, 1_500);
        assert_eq!(merged2.last_session_seconds, 500);
        assert_eq!(merged2.last_session_end, Some(300));
        assert_eq!(merged2.perf_priority, "high");
        assert_eq!(merged2.note.as_deref(), Some("src note"));

        // A side with no session at all never donates a pair.
        let no_session = GameProfile::default();
        let merged3 = merge_profiles(&no_session, &dst);
        assert_eq!(merged3.last_session_seconds, 1_000);
        assert_eq!(merged3.last_session_end, Some(200));
        assert_eq!(merged3.total_play_seconds, 1_000);
    }

    #[test]
    fn annotated_game_carries_playtime_rating_and_cover() {
        let cs = game("steam", "730", "Counter-Strike 2");
        let profiles = profiles_with(vec![(
            "steam:730",
            GameProfile {
                total_play_seconds: 9_999,
                rating: Some(5),
                cover_art: Some("data:image/png;base64,AAAA".to_string()),
                ..GameProfile::default()
            },
        )]);
        let annotated = annotate_game(&cs, &profiles);
        assert_eq!(annotated.total_play_seconds, 9_999);
        assert_eq!(annotated.rating, Some(5));
        assert_eq!(
            annotated.cover_art.as_deref(),
            Some("data:image/png;base64,AAAA")
        );
        let plain = annotate_game(&cs, &Profiles::new());
        assert_eq!(plain.total_play_seconds, 0);
        assert_eq!(plain.rating, None);
        assert_eq!(plain.cover_art, None);
    }
}
