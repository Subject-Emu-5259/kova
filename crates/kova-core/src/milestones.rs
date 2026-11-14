//! Local milestones (v1.2.0 §10) — badges earned from the player's
//! own history, computed with no server and no accounts.
//!
//! Pure functions: the app gathers the [`MilestoneStats`] from its
//! state (profiles + shelves) and the cached library, and
//! [`compute_milestones`] returns one [`MilestoneStatus`] per
//! milestone with honest progress numbers. The app stores newly
//! earned ids in state so a badge never re-fires.

use serde::{Deserialize, Serialize};

/// The five v1.2.0 milestones, in display order.
pub const MILESTONE_LAUNCHES_100: &str = "launches-100";
pub const MILESTONE_FINISHED_10: &str = "finished-10";
pub const MILESTONE_PLAYTIME_500H: &str = "playtime-500h";
pub const MILESTONE_LIBRARY_50: &str = "library-50";
pub const MILESTONE_VARIETY_10: &str = "variety-10";

/// Total launches across all games that earns the Century Club
/// badge.
pub const LAUNCHES_TARGET: u64 = 100;
/// Games on the Finished shelf that earns the Finisher badge.
pub const FINISHED_TARGET: u64 = 10;
/// Total playtime, in seconds, that earns the 500 Hours badge
/// (500 * 3600).
pub const PLAYTIME_TARGET_SECONDS: u64 = 1_800_000;
/// Library size that earns the Collector badge.
pub const LIBRARY_TARGET: u64 = 50;
/// Distinct games launched that earns the Explorer badge.
pub const VARIETY_TARGET: u64 = 10;

/// The inputs to milestone computation, gathered by the app from
/// persisted state and the cached library scan.
///
/// * `total_launches` — the sum of every profile's `launch_count`
///   (launches KOVA recorded; games launched outside KOVA are
///   invisible to it).
/// * `finished_shelf_count` — games on the built-in Finished shelf.
/// * `total_play_seconds` — the sum of every profile's
///   `total_play_seconds` (sessions KOVA watched to completion;
///   a session still running, or one cut short by KOVA quitting,
///   is not counted yet).
/// * `library_size` — games in the cached library scan (0 before
///   the session's first scan — the milestone simply shows 0
///   progress until a scan runs).
/// * `distinct_games_launched` — profiles with `launch_count > 0`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MilestoneStats {
    pub total_launches: u64,
    pub finished_shelf_count: u64,
    pub total_play_seconds: u64,
    pub library_size: u64,
    pub distinct_games_launched: u64,
}

/// One milestone's status: its definition plus the player's honest
/// progress toward it. `current` is capped at `target` in the
/// response so a progress bar never overflows; `earned` is the
/// authoritative flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MilestoneStatus {
    pub id: String,
    pub title: String,
    pub description: String,
    pub earned: bool,
    /// Progress toward the target, capped at `target`.
    pub current: u64,
    pub target: u64,
}

/// Compute every milestone's status from the given stats. Pure and
/// total: no stat is ever invented, and a missing input (a 0 from
/// "no scan yet") simply reads as no progress.
pub fn compute_milestones(stats: &MilestoneStats) -> Vec<MilestoneStatus> {
    let one = |id: &str, title: &str, description: &str, current: u64, target: u64| {
        MilestoneStatus {
            id: id.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            earned: current >= target,
            current: current.min(target),
            target,
        }
    };
    vec![
        one(
            MILESTONE_LAUNCHES_100,
            "Century Club",
            "Launch 100 games from KOVA",
            stats.total_launches,
            LAUNCHES_TARGET,
        ),
        one(
            MILESTONE_FINISHED_10,
            "Finisher",
            "Put 10 games on the Finished shelf",
            stats.finished_shelf_count,
            FINISHED_TARGET,
        ),
        one(
            MILESTONE_PLAYTIME_500H,
            "500 Hours",
            "Play 500 hours across your library",
            stats.total_play_seconds,
            PLAYTIME_TARGET_SECONDS,
        ),
        one(
            MILESTONE_LIBRARY_50,
            "Collector",
            "Have 50 games in your library",
            stats.library_size,
            LIBRARY_TARGET,
        ),
        one(
            MILESTONE_VARIETY_10,
            "Explorer",
            "Launch 10 different games",
            stats.distinct_games_launched,
            VARIETY_TARGET,
        ),
    ]
}

/// The ids of the milestones in `statuses` that are earned.
pub fn earned_ids(statuses: &[MilestoneStatus]) -> Vec<String> {
    statuses
        .iter()
        .filter(|s| s.earned)
        .map(|s| s.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_stats_earn_nothing_and_report_zero_progress() {
        let statuses = compute_milestones(&MilestoneStats::default());
        assert_eq!(statuses.len(), 5);
        for status in &statuses {
            assert!(!status.earned);
            assert_eq!(status.current, 0);
            assert!(status.target > 0);
        }
        assert!(earned_ids(&statuses).is_empty());
    }

    #[test]
    fn each_milestone_earns_exactly_at_its_target() {
        // One below every target: nothing earned.
        let below = MilestoneStats {
            total_launches: LAUNCHES_TARGET - 1,
            finished_shelf_count: FINISHED_TARGET - 1,
            total_play_seconds: PLAYTIME_TARGET_SECONDS - 1,
            library_size: LIBRARY_TARGET - 1,
            distinct_games_launched: VARIETY_TARGET - 1,
        };
        assert!(earned_ids(&compute_milestones(&below)).is_empty());

        // Exactly at every target: all five earned.
        let at = MilestoneStats {
            total_launches: LAUNCHES_TARGET,
            finished_shelf_count: FINISHED_TARGET,
            total_play_seconds: PLAYTIME_TARGET_SECONDS,
            library_size: LIBRARY_TARGET,
            distinct_games_launched: VARIETY_TARGET,
        };
        let earned = earned_ids(&compute_milestones(&at));
        assert_eq!(
            earned,
            vec![
                MILESTONE_LAUNCHES_100,
                MILESTONE_FINISHED_10,
                MILESTONE_PLAYTIME_500H,
                MILESTONE_LIBRARY_50,
                MILESTONE_VARIETY_10,
            ]
        );
    }

    #[test]
    fn progress_is_honest_and_capped_at_the_target() {
        let stats = MilestoneStats {
            total_launches: 250,
            finished_shelf_count: 3,
            total_play_seconds: 3_600,
            library_size: 12,
            distinct_games_launched: 10,
        };
        let statuses = compute_milestones(&stats);
        let by_id = |id: &str| statuses.iter().find(|s| s.id == id).unwrap();
        let launches = by_id(MILESTONE_LAUNCHES_100);
        assert!(launches.earned);
        assert_eq!(launches.current, LAUNCHES_TARGET, "capped at the target");
        let finished = by_id(MILESTONE_FINISHED_10);
        assert!(!finished.earned);
        assert_eq!(finished.current, 3);
        assert_eq!(finished.target, FINISHED_TARGET);
        let playtime = by_id(MILESTONE_PLAYTIME_500H);
        assert_eq!(playtime.current, 3_600);
        assert_eq!(playtime.target, 1_800_000);
        assert!(by_id(MILESTONE_VARIETY_10).earned);
    }

    #[test]
    fn milestone_ids_are_stable_and_unique() {
        let statuses = compute_milestones(&MilestoneStats::default());
        let mut ids = std::collections::HashSet::new();
        for status in &statuses {
            assert!(ids.insert(status.id.clone()), "duplicate id {}", status.id);
            assert!(!status.title.is_empty());
            assert!(!status.description.is_empty());
        }
    }
}
