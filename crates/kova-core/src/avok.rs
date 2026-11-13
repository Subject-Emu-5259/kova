//! The Avok shelf — KOVA's built-in showcase of Avok Interactive's
//! own titles.
//!
//! This is not a scan of the machine: it is a curated list compiled
//! into kova-core, returned as ordinary [`Game`] records with
//! `source = "avok"` so the shelf renders alongside the store
//! libraries. Both titles on the shelf are playable now and carry a
//! real launch URI (a live web edition / community page, opened by
//! the OS browser). No URL is ever invented for a title that is not
//! live.

use std::path::PathBuf;

use crate::steam::Game;

/// Build one shelf record. `library` is the literal `"built-in"` so
/// the UI can tell at a glance the entry did not come from a scan.
fn shelf_entry(id: &str, name: &str, launch_uri: &str) -> Game {
    Game {
        source: "avok".to_string(),
        id: id.to_string(),
        // Avok ids are slugs, not numeric store ids.
        appid: 0,
        name: name.to_string(),
        installdir: String::new(),
        install_path: PathBuf::new(),
        size_on_disk: 0,
        last_updated: 0,
        library: PathBuf::from("built-in"),
        launch_uri: launch_uri.to_string(),
    }
}

/// The Avok shelf: Avok Interactive's two live titles, in showcase
/// order.
///
/// * **Dispatch HQ** — live free web edition.
/// * **The Open World** — live on its subreddit.
pub fn avok_shelf() -> Vec<Game> {
    vec![
        shelf_entry(
            "dispatch-hq",
            "Dispatch HQ",
            "https://dispatch-hq.onrender.com",
        ),
        shelf_entry(
            "the-open-world",
            "The Open World",
            "https://www.reddit.com/r/The_Open_World/",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelf_has_exactly_the_two_live_titles() {
        let shelf = avok_shelf();
        assert_eq!(shelf.len(), 2);
        let names: Vec<&str> = shelf.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["Dispatch HQ", "The Open World"]);
        for game in &shelf {
            assert_eq!(game.source, "avok");
            assert!(!game.id.is_empty());
            assert!(
                !game.launch_uri.is_empty(),
                "{} must carry its real launch URI",
                game.name
            );
        }
    }

    #[test]
    fn shelf_titles_carry_their_real_urls() {
        let shelf = avok_shelf();
        let by_name = |name: &str| shelf.iter().find(|g| g.name == name).unwrap();
        assert_eq!(
            by_name("Dispatch HQ").launch_uri,
            "https://dispatch-hq.onrender.com"
        );
        assert_eq!(
            by_name("The Open World").launch_uri,
            "https://www.reddit.com/r/The_Open_World/"
        );
    }
}
