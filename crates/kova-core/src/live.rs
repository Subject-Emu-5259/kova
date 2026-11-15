//! KOVA LIVE Phase 1 — pure types and helpers (no network, no Tauri).
//!
//! The LIVE state section on [`crate::KovaState`], the message-cache
//! file shape (`kova-live-messages.json`), tag validation, friend
//! sorting, and message pruning. All network code lives in the app
//! crate (`app/src-tauri/src/live.rs`); this module is unit-tested
//! without it, the same pattern as `GamerProfile`.
//!
//! Design notes (spec `KOVA_LIVE_PHASE1_SPEC.md`):
//!
//! * Friends are KOVA-native only: add by exact gamertag, inside
//!   the LIVE ecosystem. There is no cross-store friend import
//!   anywhere in this module or anywhere else.
//! * LIVE tags are unique case-insensitively; the local gamertag is
//!   claimed as the LIVE tag when free (§2.2). The local tag and the
//!   LIVE tag may differ — the state keeps both.
//! * Messages live in a separate file, never inside
//!   `kova-state.json`, so state export / backup stays small.
//! * Everything here is `#[serde(default)]`-friendly: an old state
//!   file without a `live` section loads with an empty one.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Minimum LIVE tag length in characters (spec §2.2).
pub const LIVE_TAG_MIN_CHARS: usize = 3;
/// Maximum LIVE tag length in characters (spec §2.2).
pub const LIVE_TAG_MAX_CHARS: usize = 32;
/// Maximum friends per account (spec §3.1). A server rule; the
/// stub enforces the same number.
pub const FRIEND_CAP: usize = 500;
/// Maximum DM length in characters (spec §5.2 — the journal cap).
pub const MESSAGE_MAX_CHARS: usize = 2000;
/// Messages kept per conversation, server + local cache (§5.2).
pub const MESSAGE_HISTORY_CAP: usize = 500;
/// Seconds between allowed tag changes (spec §2.2 — 30 days).
pub const TAG_CHANGE_COOLDOWN_SECS: i64 = 30 * 86_400;
/// Seconds a released tag is held before anyone else can claim it
/// (spec §2.2 / §7.4 — 30 days).
pub const TAG_HOLD_SECS: i64 = 30 * 86_400;
/// Sends allowed per account per minute (spec §5.2).
pub const MESSAGE_RATE_LIMIT_PER_MINUTE: usize = 30;
/// Maximum length of a report note (spec §5.4 — "short note").
pub const REPORT_NOTE_MAX_CHARS: usize = 500;
/// Minimum password length (spec §1.2).
pub const PASSWORD_MIN_CHARS: usize = 8;

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/// What a friend's presence line shows. `AppearOffline` is a
/// *local* privacy setting, not a friend state — friends never see
/// it as a distinct state; they see "Offline".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Online,
    InGame,
    Offline,
}

impl Default for PresenceState {
    fn default() -> Self {
        PresenceState::Offline
    }
}

// ---------------------------------------------------------------------------
// Friends / requests
// ---------------------------------------------------------------------------

/// One cached friend (server is the source of truth; this cache is
/// what the UI renders offline).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedFriend {
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub presence: PresenceState,
    /// Game display name while `presence` is `InGame`, else `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playing: Option<String>,
}

/// An incoming friend request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FriendRequest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub from_tag: String,
    #[serde(default)]
    pub from_avatar: String,
    #[serde(default)]
    pub from_bio: String,
    #[serde(default)]
    pub created_at: i64,
}

/// An outgoing friend request (still pending on the other side).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutgoingRequest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub to_tag: String,
    #[serde(default)]
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// The `live` state section
// ---------------------------------------------------------------------------

/// The KOVA LIVE section of [`crate::KovaState`]. All fields are
/// serde-defaulted, so state files written before LIVE load with an
/// empty section and the app behaves exactly as before (signed
/// out, no account). The session token is NEVER stored here — it
/// lives in the OS credential store (spec §1.4).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LiveState {
    /// The signed-in LIVE tag, or `None` when signed out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_in_tag: Option<String>,
    /// The claimed LIVE tag. May differ from the local gamertag
    /// (the player claimed a variant because the local tag was
    /// taken). `None` when no account exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_tag: Option<String>,
    /// Whether the account's email is verified. Friends and
    /// messaging need a verified email (spec §1.2).
    #[serde(default)]
    pub email_verified: bool,
    /// Appear offline to everyone (spec §4.3).
    #[serde(default)]
    pub appear_offline: bool,
    /// Hide what I'm playing — friends see "Online" even mid-game
    /// (spec §4.3).
    #[serde(default)]
    pub hide_playing: bool,
    /// Unix seconds of the last tag change, for the 30-day rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_changed_at: Option<i64>,
    /// Cached friends list (server is the source of truth).
    #[serde(default)]
    pub friends: Vec<CachedFriend>,
    /// Incoming friend requests, oldest first.
    #[serde(default)]
    pub requests_in: Vec<FriendRequest>,
    /// Outgoing friend requests, oldest first.
    #[serde(default)]
    pub requests_out: Vec<OutgoingRequest>,
    /// Blocked tags (display form).
    #[serde(default)]
    pub blocked: Vec<String>,
}

impl LiveState {
    pub fn signed_in(&self) -> bool {
        self.signed_in_tag.is_some()
    }

    /// Pending incoming requests (the badge count).
    pub fn pending_requests(&self) -> usize {
        self.requests_in.len()
    }

    pub fn is_friend(&self, tag: &str) -> bool {
        let key = tag_key(tag);
        self.friends.iter().any(|f| tag_key(&f.tag) == key)
    }

    pub fn is_blocked(&self, tag: &str) -> bool {
        let key = tag_key(tag);
        self.blocked.iter().any(|b| tag_key(b) == key)
    }

    /// Whether the player may change their tag now (30 days since
    /// the last change, or never changed).
    pub fn can_change_tag(&self, now: i64) -> bool {
        match self.tag_changed_at {
            None => true,
            Some(changed) => now - changed >= TAG_CHANGE_COOLDOWN_SECS,
        }
    }
}

// ---------------------------------------------------------------------------
// Tag validation
// ---------------------------------------------------------------------------

/// The case-insensitive identity of a tag: trimmed, lowercased.
/// Two tags are "the same tag" when their keys match.
pub fn tag_key(tag: &str) -> String {
    tag.trim().to_lowercase()
}

/// Validate a LIVE tag (spec §2.2): trimmed, 3–32 characters,
/// letters / numbers / spaces / underscore / hyphen only. Returns
/// the trimmed tag, or an error string starting with `tag_invalid`.
pub fn validate_live_tag(tag: &str) -> Result<String, String> {
    let tag = tag.trim().to_string();
    let len = tag.chars().count();
    if len < LIVE_TAG_MIN_CHARS {
        return Err(format!(
            "tag_invalid: tags need at least {LIVE_TAG_MIN_CHARS} characters"
        ));
    }
    if len > LIVE_TAG_MAX_CHARS {
        return Err(format!(
            "tag_invalid: tags can be at most {LIVE_TAG_MAX_CHARS} characters"
        ));
    }
    if !tag
        .chars()
        .all(|c| c.is_alphanumeric() || c == ' ' || c == '_' || c == '-')
    {
        return Err(
            "tag_invalid: tags can only use letters, numbers, spaces, _ and -".to_string(),
        );
    }
    Ok(tag)
}

/// Suggest variants when a tag is taken (spec §2.2): the tag with
/// `_`, `-1`, `-2`, `_1` appended — first free ones win at claim
/// time, so the caller filters by availability.
pub fn suggest_tag_variants(tag: &str) -> Vec<String> {
    let tag = tag.trim();
    vec![
        format!("{tag}_"),
        format!("{tag}-1"),
        format!("{tag}-2"),
        format!("{tag}_1"),
    ]
}

/// Sort friends for display: online (including in-game) first,
/// then alphabetical, case-insensitive (spec §3.3).
pub fn sort_friends(friends: &mut Vec<CachedFriend>) {
    friends.sort_by(|a, b| {
        let online = |f: &CachedFriend| f.presence != PresenceState::Offline;
        match (online(a), online(b)) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => tag_key(&a.tag).cmp(&tag_key(&b.tag)),
        }
    });
}

// ---------------------------------------------------------------------------
// Messages — the separate cache file
// ---------------------------------------------------------------------------

/// One DM. `mine` marks messages this account sent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveMessage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub conversation_tag: String,
    #[serde(default)]
    pub from_tag: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub sent_at: i64,
    #[serde(default)]
    pub mine: bool,
}

/// One conversation's cached history + read marker.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ConversationCache {
    /// Oldest first, capped at [`MESSAGE_HISTORY_CAP`].
    #[serde(default)]
    pub messages: Vec<LiveMessage>,
    /// Unix seconds the player last read this conversation.
    #[serde(default)]
    pub last_read: i64,
}

impl ConversationCache {
    /// Unread count: messages after `last_read` that aren't mine.
    pub fn unread_count(&self) -> usize {
        self.messages
            .iter()
            .filter(|m| !m.mine && m.sent_at > self.last_read)
            .count()
    }

    pub fn last_message(&self) -> Option<&LiveMessage> {
        self.messages.last()
    }
}

/// The whole `kova-live-messages.json` file. Keyed by the other
/// player's tag in display form.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LiveMessageCache {
    #[serde(default)]
    pub conversations: HashMap<String, ConversationCache>,
}

/// Keep the last [`MESSAGE_HISTORY_CAP`] messages, oldest first.
pub fn prune_messages(messages: Vec<LiveMessage>) -> Vec<LiveMessage> {
    if messages.len() <= MESSAGE_HISTORY_CAP {
        return messages;
    }
    messages[messages.len() - MESSAGE_HISTORY_CAP..].to_vec()
}

impl LiveMessageCache {
    /// Add a message, pruning the conversation to the cap.
    pub fn add_message(&mut self, message: LiveMessage) {
        let conv = self
            .conversations
            .entry(message.conversation_tag.clone())
            .or_default();
        conv.messages.push(message);
        conv.messages = prune_messages(std::mem::take(&mut conv.messages));
    }

    /// Mark a conversation read as of `now` (unix seconds).
    pub fn mark_read(&mut self, tag: &str, now: i64) {
        if let Some(conv) = self.conversations.get_mut(tag) {
            conv.last_read = now;
        }
    }

    /// Conversation summaries, most-recent-first (spec §5.3).
    pub fn summaries(&self) -> Vec<ConversationSummary> {
        let mut out: Vec<ConversationSummary> = self
            .conversations
            .iter()
            .filter_map(|(tag, conv)| {
                let last = conv.last_message()?;
                Some(ConversationSummary {
                    tag: tag.clone(),
                    last_message: last.body.clone(),
                    last_at: last.sent_at,
                    unread: conv.unread_count(),
                })
            })
            .collect();
        out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
        out
    }

    /// Total unread across all conversations.
    pub fn total_unread(&self) -> usize {
        self.conversations
            .values()
            .map(|c| c.unread_count())
            .sum()
    }
}

/// One row of the Messages section (spec §5.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub tag: String,
    pub last_message: String,
    pub last_at: i64,
    pub unread: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn friend(tag: &str, presence: PresenceState) -> CachedFriend {
        CachedFriend {
            tag: tag.to_string(),
            avatar: String::new(),
            bio: String::new(),
            presence,
            playing: None,
        }
    }

    #[test]
    fn tag_validation_accepts_good_tags() {
        assert_eq!(validate_live_tag("Dre").unwrap(), "Dre");
        assert_eq!(validate_live_tag("  Dre_99-X ").unwrap(), "Dre_99-X");
        assert_eq!(validate_live_tag("a b c").unwrap(), "a b c");
    }

    #[test]
    fn tag_validation_rejects_short_long_and_bad_chars() {
        assert!(validate_live_tag("Dr").unwrap_err().starts_with("tag_invalid"));
        assert!(validate_live_tag("").unwrap_err().starts_with("tag_invalid"));
        let long = "a".repeat(33);
        assert!(validate_live_tag(&long).unwrap_err().starts_with("tag_invalid"));
        assert!(validate_live_tag("Dr@").unwrap_err().starts_with("tag_invalid"));
        assert!(validate_live_tag("Dr#e").unwrap_err().starts_with("tag_invalid"));
    }

    #[test]
    fn tag_key_is_case_insensitive() {
        assert_eq!(tag_key("Dre"), tag_key("dre"));
        assert_eq!(tag_key("  DRE "), "dre");
    }

    #[test]
    fn tag_suggestions_follow_the_spec_shape() {
        assert_eq!(
            suggest_tag_variants("Dre"),
            vec!["Dre_", "Dre-1", "Dre-2", "Dre_1"]
        );
    }

    #[test]
    fn friends_sort_online_first_then_alphabetical() {
        let mut friends = vec![
            friend("zoe", PresenceState::Offline),
            friend("amy", PresenceState::Offline),
            friend("bob", PresenceState::Online),
            friend("Al", PresenceState::InGame),
        ];
        sort_friends(&mut friends);
        let tags: Vec<&str> = friends.iter().map(|f| f.tag.as_str()).collect();
        assert_eq!(tags, vec!["Al", "bob", "amy", "zoe"]);
    }

    #[test]
    fn prune_keeps_the_newest_500() {
        let messages: Vec<LiveMessage> = (0..600)
            .map(|i| LiveMessage {
                id: format!("m{i}"),
                conversation_tag: "Rook".to_string(),
                from_tag: "Rook".to_string(),
                body: format!("msg {i}"),
                sent_at: i,
                mine: false,
            })
            .collect();
        let pruned = prune_messages(messages);
        assert_eq!(pruned.len(), MESSAGE_HISTORY_CAP);
        assert_eq!(pruned.first().unwrap().id, "m100");
        assert_eq!(pruned.last().unwrap().id, "m599");
    }

    #[test]
    fn prune_leaves_short_histories_alone() {
        let messages: Vec<LiveMessage> = (0..10)
            .map(|i| LiveMessage {
                id: format!("m{i}"),
                conversation_tag: "Rook".to_string(),
                from_tag: "Rook".to_string(),
                body: String::new(),
                sent_at: i,
                mine: false,
            })
            .collect();
        assert_eq!(prune_messages(messages).len(), 10);
    }

    #[test]
    fn unread_counts_only_theirs_after_last_read() {
        let conv = ConversationCache {
            messages: vec![
                LiveMessage {
                    id: "1".into(),
                    conversation_tag: "Rook".into(),
                    from_tag: "Rook".into(),
                    body: "a".into(),
                    sent_at: 100,
                    mine: false,
                },
                LiveMessage {
                    id: "2".into(),
                    conversation_tag: "Rook".into(),
                    from_tag: "me".into(),
                    body: "b".into(),
                    sent_at: 200,
                    mine: true,
                },
                LiveMessage {
                    id: "3".into(),
                    conversation_tag: "Rook".into(),
                    from_tag: "Rook".into(),
                    body: "c".into(),
                    sent_at: 300,
                    mine: false,
                },
            ],
            last_read: 150,
        };
        assert_eq!(conv.unread_count(), 1);
    }

    #[test]
    fn message_cache_add_mark_read_and_summaries() {
        let mut cache = LiveMessageCache::default();
        cache.add_message(LiveMessage {
            id: "1".into(),
            conversation_tag: "Rook".into(),
            from_tag: "Rook".into(),
            body: "hi".into(),
            sent_at: 100,
            mine: false,
        });
        cache.add_message(LiveMessage {
            id: "2".into(),
            conversation_tag: "Nova".into(),
            from_tag: "Nova".into(),
            body: "yo".into(),
            sent_at: 200,
            mine: false,
        });
        assert_eq!(cache.total_unread(), 2);
        let summaries = cache.summaries();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].tag, "Nova"); // most recent first
        cache.mark_read("Nova", 250);
        assert_eq!(cache.total_unread(), 1);
    }

    #[test]
    fn live_state_defaults_to_signed_out() {
        let live = LiveState::default();
        assert!(!live.signed_in());
        assert_eq!(live.pending_requests(), 0);
        assert!(!live.appear_offline);
        assert!(!live.hide_playing);
        assert!(live.can_change_tag(1_800_000_000));
    }

    #[test]
    fn tag_change_cooldown_is_30_days() {
        let mut live = LiveState::default();
        live.tag_changed_at = Some(1_700_000_000);
        assert!(!live.can_change_tag(1_700_000_000 + 29 * 86_400));
        assert!(live.can_change_tag(1_700_000_000 + 30 * 86_400));
    }

    #[test]
    fn friend_and_block_lookups_are_case_insensitive() {
        let mut live = LiveState::default();
        live.friends.push(friend("Nova", PresenceState::Online));
        live.blocked.push("BadActor".to_string());
        assert!(live.is_friend("nova"));
        assert!(live.is_blocked("badactor"));
        assert!(!live.is_friend("Rook"));
    }

    #[test]
    fn old_state_file_without_live_loads_clean() {
        let state: crate::KovaState =
            serde_json::from_str(r#"{"recents": [], "gamer_profile": {"gamertag": "Dre"}}"#)
                .unwrap();
        assert_eq!(state.live, LiveState::default());
        assert!(!state.live.signed_in());
    }

    #[test]
    fn live_state_round_trips_through_json() {
        let mut live = LiveState::default();
        live.signed_in_tag = Some("Dre".to_string());
        live.live_tag = Some("Dre".to_string());
        live.email_verified = true;
        live.friends.push(CachedFriend {
            tag: "Rook".to_string(),
            avatar: "builtin:2".to_string(),
            bio: "On dispatch.".to_string(),
            presence: PresenceState::InGame,
            playing: Some("Dispatch HQ".to_string()),
        });
        let json = serde_json::to_string(&live).unwrap();
        let back: LiveState = serde_json::from_str(&json).unwrap();
        assert_eq!(live, back);
    }
}
