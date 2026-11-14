//! KOVA's persistent state model (v1.2.0) — the shape of
//! `kova-state.json`.
//!
//! This module owns the state *types* and their pure validation so
//! they can be unit-tested without Tauri: the app crate only owns
//! the file I/O (`load_state` / `save_state`) and the commands that
//! mutate the state. Every field on every struct is
//! serde-defaulted, so a state file written by any earlier version
//! loads clean — a pre-slice-5 file (recents only), a v1.1.1 file
//! (gamer profile + wishlist), and a v1.2.0 file all deserialize
//! into the same struct, with missing pieces at their defaults.
//!
//! KOVA LIVE (§9) needs **no** new state: the gamertag in
//! [`GamerProfile`] *is* the LIVE tag — the UI says so in copy
//! only, and nothing is stored for it here.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::profiles::Profiles;
use crate::Game;

// ---------------------------------------------------------------------------
// Small date helper (kids day rollover, no chrono dependency)
// ---------------------------------------------------------------------------

/// Convert a Unix timestamp to a UTC `YYYY-MM-DD` date string
/// (Howard Hinnant's civil-from-days algorithm — pure integer
/// math, no date library). Used for the kids shelf's `used_date`.
pub fn unix_timestamp_to_date(timestamp: i64) -> String {
    let days = timestamp.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}")
}

/// Today's UTC date as `YYYY-MM-DD`.
pub fn today_date_string() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unix_timestamp_to_date(now)
}

// ---------------------------------------------------------------------------
// Gamer profile (v1.1.1; banner added v1.2.0)
// ---------------------------------------------------------------------------

/// The player's gamer profile — local only. KOVA has no backend
/// and no accounts, so this lives in `kova-state.json` on the
/// player's own machine and nowhere else.
///
/// `avatar` is one of: "" (no avatar — the UI shows the gamertag
/// initial), `"builtin:<id>"` (a built-in option the frontend
/// draws), or a `data:image/...` URL from a frontend upload
/// (downscaled by canvas, capped — see the app's
/// `set_gamer_profile`). `banner` (v1.2.0) is the same shape for
/// the profile banner / cover image on the Profile view.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GamerProfile {
    /// Display name. No uniqueness check — a local tag. This is
    /// also the player's KOVA LIVE tag (§9): no separate LIVE
    /// identity is stored.
    #[serde(default)]
    pub gamertag: String,
    /// Avatar: "" | "builtin:<id>" | data URL.
    #[serde(default)]
    pub avatar: String,
    /// One bio line.
    #[serde(default)]
    pub bio: String,
    /// Profile banner / cover image: a `data:image/...` URL, or
    /// `None` for no banner. Same ~200 KB cap as the avatar,
    /// enforced by the app on the way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
}

// ---------------------------------------------------------------------------
// Shelves / collections (v1.2.0 §7)
// ---------------------------------------------------------------------------

/// One collection shelf. A game can sit on more than one shelf.
/// `builtin` marks the three seeded shelves ("Playing now",
/// "Backlog", "Finished") — the UI treats them as permanent
/// fixtures, but the backend stores them like any other shelf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Shelf {
    /// Stable id: `"playing-now"` / `"backlog"` / `"finished"`
    /// for the built-ins, a frontend-generated id for custom
    /// shelves.
    #[serde(default)]
    pub id: String,
    /// Display name, trimmed on the way in.
    #[serde(default)]
    pub name: String,
    /// Profile keys (`"<source>:<id>"`) on this shelf.
    #[serde(default)]
    pub game_keys: Vec<String>,
    /// True for the three built-in shelves.
    #[serde(default)]
    pub builtin: bool,
}

/// Maximum shelves the state keeps. Beyond this, `set_shelves`
/// keeps the first 50 and drops the rest.
pub const MAX_SHELVES: usize = 50;

/// The three built-in shelves, seeded whenever the state's shelf
/// list is empty. Ids are stable: the Finished shelf is found by
/// its id (`"finished"`) for the milestones computation.
pub fn builtin_shelves() -> Vec<Shelf> {
    vec![
        Shelf {
            id: "playing-now".to_string(),
            name: "Playing now".to_string(),
            game_keys: Vec::new(),
            builtin: true,
        },
        Shelf {
            id: "backlog".to_string(),
            name: "Backlog".to_string(),
            game_keys: Vec::new(),
            builtin: true,
        },
        Shelf {
            id: "finished".to_string(),
            name: "Finished".to_string(),
            game_keys: Vec::new(),
            builtin: true,
        },
    ]
}

/// Validate a full shelf replacement (`set_shelves`): trim names
/// and ids, drop shelves with an empty id or name, de-duplicate
/// shelf ids (first occurrence wins), drop unknown game keys
/// (keys the app does not know — not in `known_keys`), de-duplicate
/// game keys within a shelf (first occurrence wins), and cap the
/// list at [`MAX_SHELVES`]. Pure: the caller supplies the known
/// keys (profile keys ∪ recents keys ∪ cached-library keys ∪ the
/// built-in Avok shelf keys).
pub fn validate_shelves(shelves: Vec<Shelf>, known_keys: &HashSet<String>) -> Vec<Shelf> {
    let mut out: Vec<Shelf> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    for shelf in shelves {
        let id = shelf.id.trim().to_string();
        let name = shelf.name.trim().to_string();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        let mut game_keys: Vec<String> = Vec::new();
        for key in shelf.game_keys {
            let key = key.trim().to_string();
            if key.is_empty() || !known_keys.contains(&key) {
                continue;
            }
            if !game_keys.contains(&key) {
                game_keys.push(key);
            }
        }
        out.push(Shelf {
            id,
            name,
            game_keys,
            builtin: shelf.builtin,
        });
        if out.len() >= MAX_SHELVES {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Beta program + new platform UI (v1.2.0 §11)
// ---------------------------------------------------------------------------

/// Beta program settings. Off by default; the current UI stays the
/// main UI for everyone not in the beta. When beta is on, a UI
/// selector appears in Settings (Classic / Beta) and the choice is
/// remembered across launches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BetaSettings {
    /// Whether the player joined the beta program.
    #[serde(default)]
    pub opted_in: bool,
    /// `"classic"` (the current UI) or `"beta"` (the new light
    /// shell). Defaults to `"classic"`.
    #[serde(default = "default_beta_ui")]
    pub ui: String,
    /// Beta shell accent: `"cyan"` / `"raspberry"` / `"amber"` /
    /// `"emerald"`. Defaults to `"cyan"`.
    #[serde(default = "default_beta_accent")]
    pub accent: String,
    /// Layout density: `"comfortable"` / `"compact"`. Defaults to
    /// `"comfortable"`.
    #[serde(default = "default_beta_density")]
    pub density: String,
    /// Custom shelf order: shelf ids in the player's order.
    /// Shelves missing from the list keep their stored order after
    /// the listed ones (the UI resolves this).
    #[serde(default)]
    pub shelf_order: Vec<String>,
}

fn default_beta_ui() -> String {
    "classic".to_string()
}

fn default_beta_accent() -> String {
    "cyan".to_string()
}

fn default_beta_density() -> String {
    "comfortable".to_string()
}

impl Default for BetaSettings {
    fn default() -> Self {
        BetaSettings {
            opted_in: false,
            ui: default_beta_ui(),
            accent: default_beta_accent(),
            density: default_beta_density(),
            shelf_order: Vec::new(),
        }
    }
}

/// Validate beta settings (`set_beta`): unknown `ui` / `accent` /
/// `density` values fall back to their defaults (never an error —
/// the UI must always have a usable shell); `shelf_order` is
/// trimmed, emptied of blanks, and de-duplicated.
pub fn normalize_beta(mut beta: BetaSettings) -> BetaSettings {
    if beta.ui != "classic" && beta.ui != "beta" {
        beta.ui = default_beta_ui();
    }
    if !["cyan", "raspberry", "amber", "emerald"].contains(&beta.accent.as_str()) {
        beta.accent = default_beta_accent();
    }
    if beta.density != "comfortable" && beta.density != "compact" {
        beta.density = default_beta_density();
    }
    let mut order: Vec<String> = Vec::new();
    for id in beta.shelf_order {
        let id = id.trim().to_string();
        if !id.is_empty() && !order.contains(&id) {
            order.push(id);
        }
    }
    beta.shelf_order = order;
    beta
}

// ---------------------------------------------------------------------------
// Kids shelf (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// Kids shelf settings: a locked-down profile with only approved
/// games, plus a daily time limit. This struct stores the settings
/// and the usage counter; enforcement (hiding games, stopping at
/// the limit) is the frontend's job.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KidsSettings {
    /// Whether the kids shelf is active.
    #[serde(default)]
    pub enabled: bool,
    /// Profile keys (`"<source>:<id>"`) the kids shelf may show.
    #[serde(default)]
    pub allowed_keys: Vec<String>,
    /// Daily play limit in minutes, or `None` for no limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_limit_minutes: Option<u32>,
    /// Minutes used on `used_date`.
    #[serde(default)]
    pub minutes_used_today: u32,
    /// The UTC date (`YYYY-MM-DD`) `minutes_used_today` counts
    /// toward. A stale date means the counter belongs to a past
    /// day.
    #[serde(default)]
    pub used_date: String,
}

/// Validate kids settings (`set_kids`): trim and de-duplicate
/// `allowed_keys`; a `used_date` that is empty or not shaped like
/// `YYYY-MM-DD` is reset to `today` with the counter zeroed (the
/// counter cannot belong to a date that is not a date). Day
/// rollover for a *valid* past date is the enforcement layer's
/// job, not the setter's — this function only fixes malformed
/// input.
pub fn normalize_kids(mut kids: KidsSettings, today: &str) -> KidsSettings {
    let mut allowed: Vec<String> = Vec::new();
    for key in kids.allowed_keys {
        let key = key.trim().to_string();
        if !key.is_empty() && !allowed.contains(&key) {
            allowed.push(key);
        }
    }
    kids.allowed_keys = allowed;
    kids.used_date = kids.used_date.trim().to_string();
    if !is_date_shaped(&kids.used_date) {
        kids.used_date = today.to_string();
        kids.minutes_used_today = 0;
    }
    kids
}

/// `YYYY-MM-DD` shape check: 10 chars, dashes at 4 and 7, digits
/// elsewhere. Not a calendar check — `2026-13-40` passes the
/// shape, which is fine: the field is a day bucket, not a date
/// the app computes with.
fn is_date_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

// ---------------------------------------------------------------------------
// Cross-device sync through the user's own cloud (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// Sync settings: profile + state sync through a folder on the
/// user's own cloud storage (iCloud / Drive) — no KOVA server
/// holds the data. Push writes the current state JSON into the
/// folder; pull reads it back and replaces the local state.
/// Last-write-wins, no merge: a pull discards local changes made
/// since the last push, and a push overwrites whatever the folder
/// held. The UI must say so before either runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SyncSettings {
    /// Whether sync is enabled (gates future automatic sync;
    /// manual push/pull work regardless).
    #[serde(default)]
    pub enabled: bool,
    /// The sync folder (a path on the user's cloud drive), or
    /// `None` when no folder is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// When the last push ran (Unix epoch seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_push_at: Option<i64>,
    /// When the last pull ran (Unix epoch seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pull_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Game journal (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// One journal entry: a quick note after a session, kept per game.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Profile key (`"<source>:<id>"`) of the game.
    #[serde(default)]
    pub game_key: String,
    /// When the entry was written (Unix epoch seconds).
    #[serde(default)]
    pub timestamp: i64,
    /// The note text.
    #[serde(default)]
    pub text: String,
}

/// Maximum journal entries kept. Beyond this, the oldest entries
/// are trimmed.
pub const JOURNAL_CAP: usize = 500;

/// Maximum characters in one journal entry (same cap as a profile
/// note). Longer text is truncated on the way in.
pub const JOURNAL_ENTRY_MAX_CHARS: usize = 2000;

impl JournalEntry {
    /// Build an entry from raw input: the game key and text are
    /// trimmed; an empty game key or empty text yields `None`
    /// (nothing to record); text over the cap is truncated on
    /// char boundaries.
    pub fn new(game_key: &str, timestamp: i64, text: &str) -> Option<JournalEntry> {
        let game_key = game_key.trim().to_string();
        let text: String = text.trim().chars().take(JOURNAL_ENTRY_MAX_CHARS).collect();
        if game_key.is_empty() || text.is_empty() {
            return None;
        }
        Some(JournalEntry {
            game_key,
            timestamp,
            text,
        })
    }
}

/// Append an entry to the journal, trimming the oldest entries
/// when the list passes [`JOURNAL_CAP`]. The journal stays in
/// insertion order (oldest first).
pub fn push_journal_entry(journal: &mut Vec<JournalEntry>, entry: JournalEntry) {
    journal.push(entry);
    if journal.len() > JOURNAL_CAP {
        let excess = journal.len() - JOURNAL_CAP;
        journal.drain(..excess);
    }
}

// ---------------------------------------------------------------------------
// Save backups (v1.2.0 §10)
// ---------------------------------------------------------------------------

/// One save backup: a snapshot of a game's save files, stored
/// under the app data dir in `save-backups/<key>/<backup_name>/`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SaveBackup {
    /// Profile key (`"<source>:<id>"`) of the game.
    #[serde(default)]
    pub game_key: String,
    /// When the backup was taken (Unix epoch seconds).
    #[serde(default)]
    pub backed_up_at: i64,
    /// Total bytes copied into the snapshot.
    #[serde(default)]
    pub size_bytes: u64,
    /// The snapshot's folder name inside `save-backups/<key>/`
    /// (e.g. `backup-1793000000`). Unique per game.
    #[serde(default)]
    pub backup_name: String,
}

// ---------------------------------------------------------------------------
// The whole state file
// ---------------------------------------------------------------------------

/// KOVA's persistent state (`kova-state.json` in the app data
/// dir). Every field is serde-defaulted: any earlier version's
/// file loads clean, with the fields it never wrote at their
/// defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct KovaState {
    /// Recently launched games, most recent first, de-duplicated by
    /// (source, id). Powers the Quick Resume rows — "recently
    /// launched", not saved game state.
    #[serde(default)]
    pub recents: Vec<Game>,
    /// Extra standalone game folders the user added in Settings.
    /// When non-empty these replace the standalone scanner's
    /// home-folder defaults; when empty the defaults apply.
    #[serde(default)]
    pub standalone_folders: Vec<String>,
    /// Per-game profiles (slice 5), keyed by `"<source>:<id>"`
    /// (see `kova_core::profiles`). Absent from state files
    /// written before slice 5 — the default is an empty map.
    #[serde(default)]
    pub profiles: Profiles,
    /// Settings toggle: show hidden games in the Library view.
    /// Defaults to false — hidden means hidden.
    #[serde(default)]
    pub show_hidden_games: bool,
    /// The player's gamer profile (v1.1.1). Absent from state
    /// files written before v1.1.1 — the default is empty.
    #[serde(default)]
    pub gamer_profile: GamerProfile,
    /// Local wishlist (v1.1.1): profile keys `"<source>:<id>"` of
    /// Avok titles the player marked as wanted. Absent from state
    /// files written before v1.1.1 — the default is empty.
    #[serde(default)]
    pub wishlist: Vec<String>,
    /// Collection shelves (v1.2.0 §7). Seeded with the three
    /// built-ins when empty (see [`KovaState::ensure_builtin_shelves`]).
    #[serde(default)]
    pub shelves: Vec<Shelf>,
    /// Beta program settings (v1.2.0 §11).
    #[serde(default)]
    pub beta: BetaSettings,
    /// Kids shelf settings (v1.2.0 §10).
    #[serde(default)]
    pub kids: KidsSettings,
    /// Cross-device sync settings (v1.2.0 §10).
    #[serde(default)]
    pub sync: SyncSettings,
    /// Game journal entries (v1.2.0 §10), oldest first, capped
    /// at [`JOURNAL_CAP`].
    #[serde(default)]
    pub journal: Vec<JournalEntry>,
    /// Save backup records (v1.2.0 §10). The snapshots themselves
    /// live under the app data dir in `save-backups/`.
    #[serde(default)]
    pub save_backups: Vec<SaveBackup>,
    /// Earned milestone ids (v1.2.0 §10). Stored so a badge never
    /// re-fires: once earned, the id stays here.
    #[serde(default)]
    pub milestones: Vec<String>,
}

impl KovaState {
    /// Seed the three built-in shelves when the shelf list is
    /// empty. Called on every state load: a fresh install (or a
    /// pre-1.2.0 file) gets the built-ins, and a state whose
    /// shelves were all removed re-seeds them — the built-ins are
    /// permanent fixtures, so an empty shelf list is never kept.
    pub fn ensure_builtin_shelves(&mut self) {
        if self.shelves.is_empty() {
            self.shelves = builtin_shelves();
        }
    }

    /// The keys the app knows about, for shelf validation: every
    /// profile key, every recents key, and the built-in Avok shelf
    /// keys (always known — the shelf is compiled in, not
    /// scanned). Callers add cached-library keys on top when a
    /// scan is on record.
    pub fn known_game_keys(&self) -> HashSet<String> {
        let mut keys: HashSet<String> = HashSet::new();
        for key in self.profiles.keys() {
            keys.insert(key.clone());
        }
        for game in &self.recents {
            keys.insert(crate::profile_key(game));
        }
        for game in crate::avok::avok_shelf() {
            keys.insert(crate::profile_key(&game));
        }
        keys
    }

    /// Merge a state parsed from JSON (import / pull) into a
    /// usable state: seed built-in shelves when the list is empty.
    /// This is the one normalization an imported state gets — the
    /// file's own values are otherwise trusted as-is
    /// (last-write-wins, no merge with the local state).
    pub fn normalize_imported(&mut self) {
        self.ensure_builtin_shelves();
    }
}

/// A pre-1.2.0 state file, as v1.1.1 wrote it, for the
/// compatibility test below. Kept in sync with the v1.1.1 shape
/// by hand: recents, standalone folders, profiles, the hidden
/// toggle, the gamer profile, and the wishlist — and nothing
/// v1.2.0 added.
#[cfg(test)]
const PRE_120_STATE_JSON: &str = r#"{
  "recents": [],
  "standalone_folders": ["/Games"],
  "profiles": {
    "steam:730": {
      "name_override": "CS2",
      "favorite": true,
      "hidden": false,
      "launch_args": "-novid",
      "art_url_override": null,
      "launch_count": 12,
      "last_launched": 1730000000
    }
  },
  "show_hidden_games": false,
  "gamer_profile": {
    "gamertag": "Dre",
    "avatar": "builtin:mark",
    "bio": "Plays everything."
  },
  "wishlist": ["avok:dispatch-hq"]
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_conversion_matches_known_days() {
        assert_eq!(unix_timestamp_to_date(0), "1970-01-01");
        assert_eq!(unix_timestamp_to_date(1_730_000_000), "2024-10-27");
        assert_eq!(unix_timestamp_to_date(1_792_915_200), "2026-10-25");
        // A negative timestamp (before the epoch) still yields a
        // sane date — div_euclid, not truncation.
        assert_eq!(unix_timestamp_to_date(-86_400), "1969-12-31");
    }

    #[test]
    fn pre_120_state_json_loads_clean_with_defaults() {
        let state: KovaState = serde_json::from_str(PRE_120_STATE_JSON).unwrap();
        // Everything v1.1.1 wrote survives.
        assert_eq!(state.standalone_folders, vec!["/Games"]);
        assert_eq!(state.gamer_profile.gamertag, "Dre");
        assert_eq!(state.gamer_profile.avatar, "builtin:mark");
        assert_eq!(state.wishlist, vec!["avok:dispatch-hq"]);
        let cs = &state.profiles["steam:730"];
        assert_eq!(cs.launch_count, 12);
        assert_eq!(cs.perf_priority, "normal");
        // Everything v1.2.0 added defaults.
        assert!(state.shelves.is_empty());
        assert!(!state.beta.opted_in);
        assert_eq!(state.beta.ui, "classic");
        assert_eq!(state.beta.accent, "cyan");
        assert_eq!(state.beta.density, "comfortable");
        assert!(!state.kids.enabled);
        assert!(!state.sync.enabled);
        assert!(state.journal.is_empty());
        assert!(state.save_backups.is_empty());
        assert!(state.milestones.is_empty());
        // …and the built-in shelves seed on load.
        let mut seeded = state.clone();
        seeded.ensure_builtin_shelves();
        assert_eq!(seeded.shelves.len(), 3);
        assert!(seeded.shelves.iter().all(|s| s.builtin));
    }

    #[test]
    fn empty_and_partial_state_json_load_clean() {
        let empty: KovaState = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, KovaState::default());
        // A pre-slice-5 file: recents only.
        let ancient: KovaState =
            serde_json::from_str(r#"{"recents": [], "standalone_folders": []}"#).unwrap();
        assert!(ancient.profiles.is_empty());
        assert_eq!(ancient.gamer_profile, GamerProfile::default());
        // Unknown future fields are ignored, not rejected.
        let future: KovaState =
            serde_json::from_str(r#"{"some_future_field": {"x": 1}}"#).unwrap();
        assert_eq!(future, KovaState::default());
    }

    #[test]
    fn state_round_trips_with_all_v120_fields() {
        let mut state = KovaState::default();
        state.ensure_builtin_shelves();
        state.beta.opted_in = true;
        state.beta.ui = "beta".to_string();
        state.beta.accent = "emerald".to_string();
        state.kids.enabled = true;
        state.kids.allowed_keys = vec!["avok:dispatch-hq".to_string()];
        state.sync.enabled = true;
        state.sync.folder = Some("/cloud/kova".to_string());
        state.milestones = vec!["launches-100".to_string()];
        push_journal_entry(
            &mut state.journal,
            JournalEntry::new("steam:730", 1_730_000_000, "Great session.").unwrap(),
        );
        state.save_backups.push(SaveBackup {
            game_key: "steam:730".to_string(),
            backed_up_at: 1_730_000_000,
            size_bytes: 1234,
            backup_name: "backup-1730000000".to_string(),
        });
        let json = serde_json::to_string(&state).unwrap();
        let back: KovaState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, state);
    }

    #[test]
    fn builtin_shelves_are_the_three_named_ones() {
        let shelves = builtin_shelves();
        assert_eq!(shelves.len(), 3);
        let ids: Vec<&str> = shelves.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["playing-now", "backlog", "finished"]);
        let names: Vec<&str> = shelves.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Playing now", "Backlog", "Finished"]);
        assert!(shelves.iter().all(|s| s.builtin));
        assert!(shelves.iter().all(|s| s.game_keys.is_empty()));
    }

    #[test]
    fn shelf_validation_trims_drops_unknown_and_caps() {
        let known: HashSet<String> = ["steam:730", "avok:dispatch-hq"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let shelves = vec![
            Shelf {
                id: "  custom  ".to_string(),
                name: "  My Shelf ".to_string(),
                game_keys: vec![
                    "steam:730".to_string(),
                    "steam:730".to_string(),
                    "steam:unknown".to_string(),
                    "  avok:dispatch-hq ".to_string(),
                    "".to_string(),
                ],
                builtin: false,
            },
            Shelf {
                id: "".to_string(),
                name: "No id".to_string(),
                game_keys: vec![],
                builtin: false,
            },
            Shelf {
                id: "noname".to_string(),
                name: "   ".to_string(),
                game_keys: vec![],
                builtin: false,
            },
            // Duplicate id: first occurrence wins.
            Shelf {
                id: "custom".to_string(),
                name: "Second custom".to_string(),
                game_keys: vec![],
                builtin: false,
            },
        ];
        let validated = validate_shelves(shelves, &known);
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].id, "custom");
        assert_eq!(validated[0].name, "My Shelf");
        assert_eq!(
            validated[0].game_keys,
            vec!["steam:730", "avok:dispatch-hq"],
            "unknown + duplicate + blank keys dropped, order kept"
        );
    }

    #[test]
    fn shelf_validation_caps_at_fifty() {
        let known: HashSet<String> = HashSet::new();
        let shelves: Vec<Shelf> = (0..60)
            .map(|i| Shelf {
                id: format!("shelf-{i}"),
                name: format!("Shelf {i}"),
                game_keys: vec![],
                builtin: false,
            })
            .collect();
        let validated = validate_shelves(shelves, &known);
        assert_eq!(validated.len(), MAX_SHELVES);
        assert_eq!(validated[49].id, "shelf-49");
    }

    #[test]
    fn beta_normalization_falls_back_on_bad_values() {
        let beta = normalize_beta(BetaSettings {
            opted_in: true,
            ui: "hologram".to_string(),
            accent: "violet".to_string(),
            density: "airy".to_string(),
            shelf_order: vec![
                " finished ".to_string(),
                "finished".to_string(),
                "".to_string(),
                "backlog".to_string(),
            ],
        });
        assert!(beta.opted_in);
        assert_eq!(beta.ui, "classic");
        assert_eq!(beta.accent, "cyan");
        assert_eq!(beta.density, "comfortable");
        assert_eq!(beta.shelf_order, vec!["finished", "backlog"]);

        let good = normalize_beta(BetaSettings {
            opted_in: true,
            ui: "beta".to_string(),
            accent: "raspberry".to_string(),
            density: "compact".to_string(),
            shelf_order: vec![],
        });
        assert_eq!(good.ui, "beta");
        assert_eq!(good.accent, "raspberry");
        assert_eq!(good.density, "compact");
    }

    #[test]
    fn kids_normalization_fixes_a_malformed_date_and_dedupes_keys() {
        let kids = normalize_kids(
            KidsSettings {
                enabled: true,
                allowed_keys: vec![
                    " avok:dispatch-hq ".to_string(),
                    "avok:dispatch-hq".to_string(),
                    "".to_string(),
                ],
                daily_limit_minutes: Some(60),
                minutes_used_today: 45,
                used_date: "not-a-date".to_string(),
            },
            "2026-11-13",
        );
        assert_eq!(kids.allowed_keys, vec!["avok:dispatch-hq"]);
        assert_eq!(kids.used_date, "2026-11-13");
        assert_eq!(kids.minutes_used_today, 0, "counter reset with the date");

        // A valid date is left alone, counter and all.
        let kids = normalize_kids(
            KidsSettings {
                enabled: true,
                allowed_keys: vec![],
                daily_limit_minutes: None,
                minutes_used_today: 30,
                used_date: "2026-11-12".to_string(),
            },
            "2026-11-13",
        );
        assert_eq!(kids.used_date, "2026-11-12");
        assert_eq!(kids.minutes_used_today, 30);
    }

    #[test]
    fn journal_entry_rejects_empty_and_truncates_long_text() {
        assert!(JournalEntry::new("", 1, "hello").is_none());
        assert!(JournalEntry::new("steam:730", 1, "   ").is_none());
        let long = "x".repeat(5000);
        let entry = JournalEntry::new("steam:730", 1, &long).unwrap();
        assert_eq!(entry.text.chars().count(), JOURNAL_ENTRY_MAX_CHARS);
        let entry = JournalEntry::new(" steam:730 ", 42, "  hello  ").unwrap();
        assert_eq!(entry.game_key, "steam:730");
        assert_eq!(entry.text, "hello");
        assert_eq!(entry.timestamp, 42);
    }

    #[test]
    fn journal_cap_trims_the_oldest_entries() {
        let mut journal = Vec::new();
        for i in 0..(JOURNAL_CAP + 25) {
            push_journal_entry(
                &mut journal,
                JournalEntry::new("steam:730", i as i64, &format!("entry {i}")).unwrap(),
            );
        }
        assert_eq!(journal.len(), JOURNAL_CAP);
        assert_eq!(journal.first().unwrap().text, "entry 25");
        assert_eq!(
            journal.last().unwrap().text,
            format!("entry {}", JOURNAL_CAP + 24)
        );
    }

    #[test]
    fn known_game_keys_cover_profiles_recents_and_the_avok_shelf() {
        let mut state = KovaState::default();
        state.profiles.insert(
            "steam:730".to_string(),
            crate::GameProfile::default(),
        );
        let keys = state.known_game_keys();
        assert!(keys.contains("steam:730"));
        assert!(keys.contains("avok:dispatch-hq"));
        assert!(keys.contains("avok:the-open-world"));
    }
}
