//! KOVA LIVE Phase 1 — backend client, session, message cache.
//!
//! Two backends behind one trait ([`LiveBackend`]):
//!
//! * [`StubBackend`] — an in-memory fake server with seeded players,
//!   the default until Dre approves a real Supabase project. The
//!   whole flow (sign-up, tag claim, friends, presence, DMs) works
//!   end-to-end against it, in the real app and in tests.
//! * [`SupabaseBackend`] — the real client: Supabase Auth + PostgREST
//!   over HTTPS, Realtime over websocket. It is compiled and
//!   structure-checked here, but it has NEVER run against a live
//!   project (no project exists yet — Dre's call, and no spend is
//!   approved). When the project exists, switching is a config
//!   change, not a rebuild (see [`LiveConfig`]).
//!
//! Backend selection: env `KOVA_LIVE_BACKEND` (`stub` forces the stub,
//! `supabase` forces Supabase); when unset, Supabase is used if a URL
//! and anon key are available (env or `live-config.json`), else the
//! stub. A shipped app with `live-config.json` in its data dir
//! therefore uses the real backend with no user action.
//! (`KOVA_LIVE_SUPABASE_URL`, `KOVA_LIVE_SUPABASE_ANON_KEY`) or
//! `live-config.json` in the app data dir — never hardcoded, never
//! in the repo. No real key exists anywhere in this codebase.
//!
//! Session tokens live in the OS credential store (macOS Keychain /
//! Windows Credential Manager via the `keyring` crate) — never in
//! `kova-state.json`, never plaintext on disk (spec §1.4).
//!
//! Messages live in `kova-live-messages.json` in the app data dir,
//! never inside `kova-state.json` (spec §5.2). Sign-out clears it.
//!
//! Supabase schema the project setup must create (NOT part of this
//! build — a setup checklist for when Dre approves the project):
//! `profiles(user_id, tag, tag_key unique, avatar, bio, banner,
//! tag_changed_at)`, `friend_requests(id, from_user, to_user,
//! status, created_at)`, `friendships(user_a, user_b)`,
//! `blocks(blocker, blocked)`, `messages(id, from_user, to_user,
//! body, sent_at)`, `reports(id, reporter, kind, ref, note,
//! created_at, resolution)`, `held_tags(tag_key, held_until)`,
//! `presence(user_id, state, playing, updated_at)` — plus RLS
//! policies letting the anon key read/write them for the signed-in
//! user. Presence is stored in the `presence` table (heartbeat
//! upsert) AND broadcast over Realtime when connected; friends
//! lists read presence from the table, so presence works even if
//! the realtime socket drops.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use kova_core::{
    CachedFriend, FriendRequest, GamerProfile, LiveMessage, LiveMessageCache, LiveState,
    OutgoingRequest, PresenceState,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Active session (moved here from lib.rs so the presence publisher
// in this module can read it; same shape, same semantics)
// ---------------------------------------------------------------------------

/// The currently watched play session: the most recent launch's
/// game key and start time, for the session timer and the LIVE
/// presence publisher.
#[derive(Debug, Clone)]
pub struct ActiveSessionSnapshot {
    pub game_key: String,
    pub started_at: i64,
}

/// One slot, managed by Tauri: launching a second game while one
/// is running replaces the record.
#[derive(Default)]
pub struct ActiveSession(pub Mutex<Option<ActiveSessionSnapshot>>);

impl ActiveSession {
    pub fn current(&self) -> Option<ActiveSessionSnapshot> {
        self.0.lock().ok().and_then(|guard| guard.clone())
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Stub,
    Supabase,
}

/// How LIVE connects. Built once at startup from env / config
/// file; the backend is chosen from it and never changes
/// mid-run (restart the app to switch backends).
#[derive(Debug, Clone)]
pub struct LiveConfig {
    pub backend: BackendKind,
    pub supabase_url: Option<String>,
    pub supabase_anon_key: Option<String>,
}

#[derive(Deserialize)]
struct LiveConfigFile {
    supabase_url: Option<String>,
    supabase_anon_key: Option<String>,
}

impl LiveConfig {
    pub fn load(app_data_dir: Option<PathBuf>) -> LiveConfig {
        // Backend selection (fixed 2026-11-14 — the original code read the
        // backend from the env var ONLY, so a shipped .app with no env var
        // would have run the stub forever even with a config file present):
        //   KOVA_LIVE_BACKEND=stub     -> Stub (explicit dev/test override)
        //   KOVA_LIVE_BACKEND=supabase -> Supabase
        //   unset / anything else      -> Supabase if a config file (or env)
        //     provides both a URL and an anon key, else Stub. A shipped app
        //     with live-config.json in its data dir therefore uses the real
        //     backend with no user action; a dev checkout with no config
        //     still gets the stub.
        let env_backend = std::env::var("KOVA_LIVE_BACKEND")
            .unwrap_or_default()
            .to_lowercase();
        let mut url = std::env::var("KOVA_LIVE_SUPABASE_URL").ok().filter(|v| !v.is_empty());
        let mut key = std::env::var("KOVA_LIVE_SUPABASE_ANON_KEY")
            .ok()
            .filter(|v| !v.is_empty());
        if url.is_none() || key.is_none() {
            if let Some(dir) = app_data_dir {
                if let Ok(contents) = std::fs::read_to_string(dir.join("live-config.json")) {
                    if let Ok(file) = serde_json::from_str::<LiveConfigFile>(&contents) {
                        if url.is_none() {
                            url = file.supabase_url.filter(|v| !v.is_empty());
                        }
                        if key.is_none() {
                            key = file.supabase_anon_key.filter(|v| !v.is_empty());
                        }
                    }
                }
            }
        }
        let backend = match env_backend.as_str() {
            "stub" => BackendKind::Stub,
            "supabase" => BackendKind::Supabase,
            _ => {
                if url.is_some() && key.is_some() {
                    BackendKind::Supabase
                } else {
                    BackendKind::Stub
                }
            }
        };
        LiveConfig {
            backend,
            supabase_url: url,
            supabase_anon_key: key,
        }
    }

    pub fn supabase_configured(&self) -> bool {
        self.supabase_url.is_some() && self.supabase_anon_key.is_some()
    }
}

// ---------------------------------------------------------------------------
// Session token — OS credential store (spec §1.4)
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "interactive.avok.kova";
const KEYRING_USERNAME: &str = "kova-live-session";

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME).map_err(|e| e.to_string())
}

pub fn store_session_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| e.to_string())
}

pub fn load_session_token() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

pub fn clear_session_token() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

// ---------------------------------------------------------------------------
// Message cache file — kova-live-messages.json (spec §5.2)
// ---------------------------------------------------------------------------

pub fn messages_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("kova-live-messages.json"))
}

/// Load the message cache. Any problem returns an empty cache —
/// messages must never stop the app from launching.
pub fn load_message_cache(app: &tauri::AppHandle) -> LiveMessageCache {
    (|| {
        let path = messages_path(app)?;
        let contents = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&contents).ok()
    })()
    .unwrap_or_default()
}

pub fn save_message_cache(
    app: &tauri::AppHandle,
    cache: &LiveMessageCache,
) -> Result<(), String> {
    let path = messages_path(app).ok_or("could not resolve the app data directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn clear_message_cache(app: &tauri::AppHandle) {
    if let Some(path) = messages_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/// A signed-in session. The access token is short-lived; the
/// refresh token is what the keyring stores.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub user_id: String,
    pub email: String,
    pub tag: String,
    pub email_verified: bool,
    pub access_token: String,
    pub refresh_token: String,
}

/// A public profile, as exact-match search returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicProfile {
    pub tag: String,
    pub avatar: String,
    pub bio: String,
}

/// A tag availability answer, with suggestions when taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagCheck {
    pub available: bool,
    pub suggestions: Vec<String>,
}

/// The friends snapshot a `live_get_friends` returns: friends,
/// requests both directions, and the block list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FriendsSnapshot {
    #[serde(default)]
    pub friends: Vec<CachedFriend>,
    #[serde(default)]
    pub requests_in: Vec<FriendRequest>,
    #[serde(default)]
    pub requests_out: Vec<OutgoingRequest>,
    #[serde(default)]
    pub blocked: Vec<String>,
}

/// A presence publish: what the signed-in player looks like to
/// friends right now. `state` is `"online"` | `"in_game"` |
/// `"offline"`; `playing` is the game display name when in game.
#[derive(Debug, Clone, PartialEq)]
pub struct PresencePublish {
    pub state: String,
    pub playing: Option<String>,
}

/// The status object `live_get_status` / sign-in return.
#[derive(Debug, Clone, Serialize)]
pub struct LiveStatus {
    pub signed_in: bool,
    pub live_tag: Option<String>,
    pub email_verified: bool,
    pub appear_offline: bool,
    pub hide_playing: bool,
    pub pending_requests: usize,
    pub backend: String,
    pub configured: bool,
}

impl LiveStatus {
    pub fn from_state(live: &LiveState, config: &LiveConfig) -> LiveStatus {
        LiveStatus {
            signed_in: live.signed_in(),
            live_tag: live.live_tag.clone(),
            email_verified: live.email_verified,
            appear_offline: live.appear_offline,
            hide_playing: live.hide_playing,
            pending_requests: live.pending_requests(),
            backend: match config.backend {
                BackendKind::Stub => "stub".to_string(),
                BackendKind::Supabase => "supabase".to_string(),
            },
            configured: match config.backend {
                BackendKind::Stub => true,
                BackendKind::Supabase => config.supabase_configured(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// The backend trait — one interface, stub + Supabase behind it
// ---------------------------------------------------------------------------

/// Every LIVE operation the app needs, as one backend interface.
/// Errors are plain strings starting with a code prefix (see
/// `LIVE_API_CONTRACT.md` §3); the frontend matches on the prefix.
pub trait LiveBackend: Send {
    /// Human name for logs and diagnostics (not currently read
    /// by any command — kept as backend surface).
    #[allow(dead_code)]
    fn backend_name(&self) -> &'static str;
    fn session(&self) -> Option<SessionInfo>;
    /// Restore a session from a stored refresh token (app start).
    fn restore_session(&mut self, refresh_token: &str) -> Result<SessionInfo, String>;
    fn sign_up(&mut self, email: &str, password: &str, tag: &str) -> Result<SessionInfo, String>;
    fn sign_in(&mut self, email: &str, password: &str) -> Result<SessionInfo, String>;
    fn sign_out(&mut self);
    fn resend_verification(&mut self) -> Result<(), String>;
    fn check_tag(&self, tag: &str) -> Result<TagCheck, String>;
    fn claim_tag(&mut self, tag: &str) -> Result<String, String>;
    fn search_tag(&self, tag: &str) -> Result<Option<PublicProfile>, String>;
    fn send_request(&mut self, tag: &str) -> Result<String, String>;
    fn accept_request(&mut self, request_id: &str) -> Result<(), String>;
    fn decline_request(&mut self, request_id: &str) -> Result<(), String>;
    fn remove_friend(&mut self, tag: &str) -> Result<(), String>;
    fn block(&mut self, tag: &str) -> Result<(), String>;
    fn unblock(&mut self, tag: &str) -> Result<(), String>;
    fn get_friends(&self) -> Result<FriendsSnapshot, String>;
    fn send_message(&mut self, to_tag: &str, body: &str) -> Result<LiveMessage, String>;
    fn fetch_messages(&self, tag: &str) -> Result<Vec<LiveMessage>, String>;
    fn fetch_all_messages(&self) -> Result<Vec<LiveMessage>, String>;
    fn delete_message(&mut self, message_id: &str) -> Result<(), String>;
    fn report(&mut self, kind: &str, ref_: &str, note: &str) -> Result<(), String>;
    fn delete_account(&mut self) -> Result<(), String>;
    fn sync_profile(&mut self, profile: &GamerProfile) -> Result<(), String>;
    fn set_presence(&mut self, presence: &PresencePublish) -> Result<(), String>;
}

/// The Tauri-managed LIVE backend: one config, one backend behind
/// a mutex (commands lock it per call).
pub struct LiveBackendState {
    pub config: LiveConfig,
    pub backend: Mutex<Box<dyn LiveBackend>>,
}

impl LiveBackendState {
    pub fn new(app_data_dir: Option<PathBuf>) -> LiveBackendState {
        let config = LiveConfig::load(app_data_dir);
        let backend = Self::build_backend(&config);
        LiveBackendState {
            config,
            backend: Mutex::new(backend),
        }
    }

    pub fn build_backend(config: &LiveConfig) -> Box<dyn LiveBackend> {
        match config.backend {
            BackendKind::Stub => Box::new(StubBackend::new()),
            BackendKind::Supabase => Box::new(SupabaseBackend::new(config)),
        }
    }
}

/// Derive the signed-in player's presence from the privacy
/// toggles + the active session (spec §4.2–§4.3). Pure, so the
/// publisher thread and `live_get_presence` agree exactly.
pub fn derive_presence(
    appear_offline: bool,
    hide_playing: bool,
    active_game: Option<&str>,
) -> PresencePublish {
    if appear_offline {
        return PresencePublish {
            state: "offline".to_string(),
            playing: None,
        };
    }
    match active_game {
        Some(game) if !hide_playing => PresencePublish {
            state: "in_game".to_string(),
            playing: Some(game.to_string()),
        },
        _ => PresencePublish {
            state: "online".to_string(),
            playing: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Stub backend — the in-memory fake server
// ---------------------------------------------------------------------------

/// One stub account. Passwords are plaintext IN MEMORY ONLY — the
/// stub never persists anything, and the stub is never the real
/// backend. The real backend hashes server-side (spec §7.1).
struct StubAccount {
    user_id: String,
    email: String,
    password: String,
    tag: String,
    avatar: String,
    bio: String,
    verified: bool,
    friends: Vec<String>,
    requests_in: Vec<StubRequest>,
    requests_out: Vec<StubRequest>,
    blocked: Vec<String>,
    seeded: bool,
    tag_changed_at: Option<i64>,
    send_times: Vec<i64>,
    fake: bool,
}

#[derive(Clone)]
struct StubRequest {
    id: String,
    from_user: String,
    to_user: String,
    created_at: i64,
}

struct StubMessage {
    id: String,
    from_user: String,
    to_user: String,
    body: String,
    sent_at: i64,
}

/// A report filed against a player or message. The stub keeps
/// them in memory only (a real backend persists them for the
/// Avok team's manual review); nothing reads them back yet.
#[allow(dead_code)]
struct StubReport {
    reporter: String,
    kind: String,
    ref_: String,
    note: String,
    created_at: i64,
}

/// The stub server: every account, edge, and message in memory,
/// seeded with the four fake players from the contract (§6). The
/// stub is the default backend until a real Supabase project
/// exists; it makes the whole LIVE flow testable with no network
/// and no spend.
pub struct StubBackend {
    accounts: HashMap<String, StubAccount>,
    by_email: HashMap<String, String>,
    tags: HashMap<String, String>,
    held_tags: HashMap<String, i64>,
    messages: Vec<StubMessage>,
    reports: Vec<StubReport>,
    presence: HashMap<String, (PresenceState, Option<String>)>,
    current: Option<String>,
    next_id: u64,
}

fn valid_email_shape(email: &str) -> bool {
    let email = email.trim();
    match email.split_once('@') {
        Some((local, domain)) => !local.is_empty() && domain.contains('.') && !domain.starts_with('.'),
        None => false,
    }
}

impl StubBackend {
    pub fn new() -> StubBackend {
        let mut stub = StubBackend {
            accounts: HashMap::new(),
            by_email: HashMap::new(),
            tags: HashMap::new(),
            held_tags: HashMap::new(),
            messages: Vec::new(),
            reports: Vec::new(),
            presence: HashMap::new(),
            current: None,
            next_id: 1,
        };
        // Fake players (contract §6). No email, so nobody can sign
        // in as them — they exist to be searched, added, and
        // messaged.
        stub.add_fake("fake-nova", "Nova", "builtin:1", "Speedrunner, Hades II enjoyer.");
        stub.add_fake(
            "fake-rook",
            "Rook",
            "builtin:2",
            "On dispatch. Every call is a decision.",
        );
        stub.add_fake("fake-ash", "Ash", "builtin:3", "Quiet hours.");
        stub.add_fake("fake-sol", "Sol", "builtin:4", "Building worlds.");
        stub.presence.insert(
            "fake-nova".to_string(),
            (PresenceState::Online, None),
        );
        stub.presence.insert(
            "fake-rook".to_string(),
            (
                PresenceState::InGame,
                Some("Dispatch HQ".to_string()),
            ),
        );
        stub.presence
            .insert("fake-ash".to_string(), (PresenceState::Offline, None));
        stub.presence
            .insert("fake-sol".to_string(), (PresenceState::Offline, None));
        stub
    }

    fn add_fake(&mut self, user_id: &str, tag: &str, avatar: &str, bio: &str) {
        self.tags
            .insert(kova_core::tag_key(tag), user_id.to_string());
        self.accounts.insert(
            user_id.to_string(),
            StubAccount {
                user_id: user_id.to_string(),
                email: String::new(),
                password: String::new(),
                tag: tag.to_string(),
                avatar: avatar.to_string(),
                bio: bio.to_string(),
                verified: true,
                friends: Vec::new(),
                requests_in: Vec::new(),
                requests_out: Vec::new(),
                blocked: Vec::new(),
                seeded: true,
                tag_changed_at: None,
                send_times: Vec::new(),
                fake: true,
            },
        );
    }

    fn next_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}_{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn me_id(&self) -> Result<String, String> {
        self.current
            .clone()
            .ok_or_else(|| "not_signed_in: sign in to KOVA LIVE first".to_string())
    }

    fn display_tag(&self, user_id: &str) -> String {
        self.accounts
            .get(user_id)
            .map(|a| a.tag.clone())
            .unwrap_or_default()
    }

    fn user_id_for_tag(&self, tag: &str) -> Option<String> {
        self.tags.get(&kova_core::tag_key(tag)).cloned()
    }

    fn tag_available(&self, tag: &str) -> bool {
        let key = kova_core::tag_key(tag);
        if self.tags.contains_key(&key) {
            return false;
        }
        match self.held_tags.get(&key) {
            Some(until) => *until <= now_unix(),
            None => true,
        }
    }

    /// Seed a fresh account (contract §6): Nova's incoming
    /// request + the Rook DM conversation. Once per account.
    fn seed_account(&mut self, user_id: &str) {
        let now = now_unix();
        let seeded = self
            .accounts
            .get(user_id)
            .map(|a| a.seeded)
            .unwrap_or(true);
        if seeded {
            return;
        }
        if let Some(account) = self.accounts.get_mut(user_id) {
            account.seeded = true;
            account.requests_in.push(StubRequest {
                id: "req_nova_1".to_string(),
                from_user: "fake-nova".to_string(),
                to_user: user_id.to_string(),
                created_at: now - 7200,
            });
        }
        if let Some(nova) = self.accounts.get_mut("fake-nova") {
            nova.requests_out.push(StubRequest {
                id: "req_nova_1".to_string(),
                from_user: "fake-nova".to_string(),
                to_user: user_id.to_string(),
                created_at: now - 7200,
            });
        }
        for (i, (from, body, at)) in [
            ("fake-rook", "you on tonight?", now - 3600),
            (user_id, "yeah after dinner", now - 3500),
            ("fake-rook", "good, bringing the ladder crew", now - 3400),
        ]
        .into_iter()
        .enumerate()
        {
            let to = if from == user_id { "fake-rook" } else { user_id };
            self.messages.push(StubMessage {
                id: format!("m_rook_{}", i + 1),
                from_user: from.to_string(),
                to_user: to.to_string(),
                body: body.to_string(),
                sent_at: at,
            });
        }
    }

    fn add_friendship(&mut self, a: &str, b: &str) {
        for (user, other) in [(a, b), (b, a)] {
            if let Some(account) = self.accounts.get_mut(user) {
                if !account.friends.iter().any(|f| f == other) {
                    account.friends.push(other.to_string());
                }
            }
        }
    }

    fn remove_friendship(&mut self, a: &str, b: &str) {
        for (user, other) in [(a, b), (b, a)] {
            if let Some(account) = self.accounts.get_mut(user) {
                account.friends.retain(|f| f != other);
            }
        }
    }

    fn remove_requests_between(&mut self, a: &str, b: &str) {
        for account in self.accounts.values_mut() {
            account
                .requests_in
                .retain(|r| !((r.from_user == a && r.to_user == b) || (r.from_user == b && r.to_user == a)));
            account
                .requests_out
                .retain(|r| !((r.from_user == a && r.to_user == b) || (r.from_user == b && r.to_user == a)));
        }
    }

    fn project_message(&self, m: &StubMessage, me: &str) -> LiveMessage {
        let other = if m.from_user == me {
            &m.to_user
        } else {
            &m.from_user
        };
        LiveMessage {
            id: m.id.clone(),
            conversation_tag: self.display_tag(other),
            from_tag: self.display_tag(&m.from_user),
            body: m.body.clone(),
            sent_at: m.sent_at,
            mine: m.from_user == me,
        }
    }

    fn session_for(&self, user_id: &str) -> Option<SessionInfo> {
        let account = self.accounts.get(user_id)?;
        Some(SessionInfo {
            user_id: account.user_id.clone(),
            email: account.email.clone(),
            tag: account.tag.clone(),
            email_verified: account.verified,
            access_token: format!("stub-access-{}", account.user_id),
            refresh_token: format!("stub:{}", account.email),
        })
    }
}

impl Default for StubBackend {
    fn default() -> Self {
        StubBackend::new()
    }
}

impl LiveBackend for StubBackend {
    fn backend_name(&self) -> &'static str {
        "stub"
    }

    fn session(&self) -> Option<SessionInfo> {
        self.current.as_deref().and_then(|id| self.session_for(id))
    }

    fn restore_session(&mut self, refresh_token: &str) -> Result<SessionInfo, String> {
        let email = refresh_token
            .strip_prefix("stub:")
            .ok_or_else(|| "invalid_session: stored session is not a stub session".to_string())?;
        let user_id = self
            .by_email
            .get(&email.to_lowercase())
            .cloned()
            .ok_or_else(|| "invalid_session: no account for the stored session".to_string())?;
        self.current = Some(user_id.clone());
        self.session_for(&user_id)
            .ok_or_else(|| "invalid_session: account is gone".to_string())
    }

    fn sign_up(&mut self, email: &str, password: &str, tag: &str) -> Result<SessionInfo, String> {
        let email = email.trim().to_lowercase();
        if !valid_email_shape(&email) {
            return Err("email_invalid: enter a valid email address".to_string());
        }
        if password.chars().count() < kova_core::PASSWORD_MIN_CHARS {
            return Err("password_too_short: passwords need at least 8 characters".to_string());
        }
        let tag = kova_core::validate_live_tag(tag)?;
        if self.by_email.contains_key(&email) {
            return Err("email_taken: an account with this email already exists".to_string());
        }
        if !self.tag_available(&tag) {
            return Err("tag_taken: that tag is already claimed".to_string());
        }
        let user_id = self.next_id("user");
        self.tags.insert(kova_core::tag_key(&tag), user_id.clone());
        self.by_email.insert(email.clone(), user_id.clone());
        self.accounts.insert(
            user_id.clone(),
            StubAccount {
                user_id: user_id.clone(),
                email: email.clone(),
                password: password.to_string(),
                tag: tag.clone(),
                avatar: String::new(),
                bio: String::new(),
                verified: false,
                friends: Vec::new(),
                requests_in: Vec::new(),
                requests_out: Vec::new(),
                blocked: Vec::new(),
                seeded: false,
                tag_changed_at: None,
                send_times: Vec::new(),
                fake: false,
            },
        );
        self.seed_account(&user_id);
        self.current = Some(user_id.clone());
        self.session_for(&user_id)
            .ok_or_else(|| "sign_up_failed: account was created but the session could not start".to_string())
    }

    fn sign_in(&mut self, email: &str, password: &str) -> Result<SessionInfo, String> {
        let email = email.trim().to_lowercase();
        let user_id = self
            .by_email
            .get(&email)
            .cloned()
            .ok_or_else(|| "invalid_credentials: email or password is wrong".to_string())?;
        let ok = self
            .accounts
            .get(&user_id)
            .map(|a| a.password == password)
            .unwrap_or(false);
        if !ok {
            return Err("invalid_credentials: email or password is wrong".to_string());
        }
        self.seed_account(&user_id);
        self.current = Some(user_id.clone());
        self.session_for(&user_id)
            .ok_or_else(|| "sign_in_failed: session could not start".to_string())
    }

    fn sign_out(&mut self) {
        self.current = None;
    }

    fn resend_verification(&mut self) -> Result<(), String> {
        // The stub has no email: resending verifies immediately.
        let me = self.me_id()?;
        if let Some(account) = self.accounts.get_mut(&me) {
            account.verified = true;
        }
        Ok(())
    }

    fn check_tag(&self, tag: &str) -> Result<TagCheck, String> {
        let tag = kova_core::validate_live_tag(tag)?;
        if self.tag_available(&tag) {
            return Ok(TagCheck {
                available: true,
                suggestions: Vec::new(),
            });
        }
        let suggestions: Vec<String> = kova_core::suggest_tag_variants(&tag)
            .into_iter()
            .filter(|v| self.tag_available(v))
            .take(3)
            .collect();
        Ok(TagCheck {
            available: false,
            suggestions,
        })
    }

    fn claim_tag(&mut self, tag: &str) -> Result<String, String> {
        let me = self.me_id()?;
        let tag = kova_core::validate_live_tag(tag)?;
        let (current_tag, changed_at) = self
            .accounts
            .get(&me)
            .map(|a| (a.tag.clone(), a.tag_changed_at))
            .unwrap_or_default();
        if kova_core::tag_key(&current_tag) == kova_core::tag_key(&tag) {
            return Ok(current_tag);
        }
        if let Some(changed) = changed_at {
            if now_unix() - changed < kova_core::TAG_CHANGE_COOLDOWN_SECS {
                return Err(
                    "tag_change_too_soon: tags can change once every 30 days".to_string(),
                );
            }
        }
        if !self.tag_available(&tag) {
            return Err("tag_taken: that tag is already claimed".to_string());
        }
        let now = now_unix();
        self.held_tags
            .insert(kova_core::tag_key(&current_tag), now + kova_core::TAG_HOLD_SECS);
        self.tags.remove(&kova_core::tag_key(&current_tag));
        self.tags.insert(kova_core::tag_key(&tag), me.clone());
        if let Some(account) = self.accounts.get_mut(&me) {
            account.tag = tag.clone();
            account.tag_changed_at = Some(now);
        }
        Ok(tag)
    }

    fn search_tag(&self, tag: &str) -> Result<Option<PublicProfile>, String> {
        let user_id = match self.user_id_for_tag(tag) {
            Some(id) => id,
            None => return Ok(None),
        };
        // Blocked either way reads as "no player with that tag".
        if let Some(me) = &self.current {
            let me_blocked = self
                .accounts
                .get(me)
                .map(|a| a.blocked.iter().any(|b| b == &user_id))
                .unwrap_or(false);
            let they_blocked = self
                .accounts
                .get(&user_id)
                .map(|a| a.blocked.iter().any(|b| b == me))
                .unwrap_or(false);
            if me_blocked || they_blocked {
                return Ok(None);
            }
        }
        Ok(self.accounts.get(&user_id).map(|a| PublicProfile {
            tag: a.tag.clone(),
            avatar: a.avatar.clone(),
            bio: a.bio.clone(),
        }))
    }

    fn send_request(&mut self, tag: &str) -> Result<String, String> {
        let me = self.me_id()?;
        let target = self
            .user_id_for_tag(tag)
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        if target == me {
            return Err("cannot_add_self: that's your own tag".to_string());
        }
        let (is_friend, is_blocked, they_blocked, pending_out, pending_in, at_cap, is_fake) = {
            let mine = self.accounts.get(&me).unwrap();
            let theirs = self.accounts.get(&target).unwrap();
            (
                mine.friends.iter().any(|f| f == &target),
                mine.blocked.iter().any(|b| b == &target),
                theirs.blocked.iter().any(|b| b == &me),
                mine.requests_out.iter().any(|r| r.to_user == target),
                mine.requests_in.iter().any(|r| r.from_user == target),
                mine.friends.len() >= kova_core::FRIEND_CAP,
                theirs.fake,
            )
        };
        if is_friend {
            return Err("already_friends: you're already friends".to_string());
        }
        if is_blocked || they_blocked {
            return Err("blocked: you can't send a request to this player".to_string());
        }
        if pending_out {
            return Err("already_pending: your request is already waiting".to_string());
        }
        if pending_in {
            return Err(
                "already_pending: they already sent you a request — accept it in Friends"
                    .to_string(),
            );
        }
        if at_cap {
            return Err("friend_cap: your friends list is full (500)".to_string());
        }
        // Fake players accept immediately (stub-only behavior).
        if is_fake {
            self.add_friendship(&me, &target);
            return Ok(self.next_id("auto"));
        }
        let id = self.next_id("req");
        let req = StubRequest {
            id: id.clone(),
            from_user: me.clone(),
            to_user: target.clone(),
            created_at: now_unix(),
        };
        if let Some(mine) = self.accounts.get_mut(&me) {
            mine.requests_out.push(req.clone());
        }
        if let Some(theirs) = self.accounts.get_mut(&target) {
            theirs.requests_in.push(req);
        }
        Ok(id)
    }

    fn accept_request(&mut self, request_id: &str) -> Result<(), String> {
        let me = self.me_id()?;
        let from = {
            let mine = self.accounts.get(&me).unwrap();
            match mine.requests_in.iter().find(|r| r.id == request_id) {
                Some(r) => r.from_user.clone(),
                None => return Err("request_not_found: that request is gone".to_string()),
            }
        };
        if self.accounts.get(&me).unwrap().friends.len() >= kova_core::FRIEND_CAP {
            return Err("friend_cap: your friends list is full (500)".to_string());
        }
        self.remove_requests_between(&me, &from);
        self.add_friendship(&me, &from);
        Ok(())
    }

    fn decline_request(&mut self, request_id: &str) -> Result<(), String> {
        let me = self.me_id()?;
        let from = {
            let mine = self.accounts.get(&me).unwrap();
            match mine.requests_in.iter().find(|r| r.id == request_id) {
                Some(r) => r.from_user.clone(),
                None => return Ok(()),
            }
        };
        self.remove_requests_between(&me, &from);
        Ok(())
    }

    fn remove_friend(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me_id()?;
        if let Some(target) = self.user_id_for_tag(tag) {
            self.remove_friendship(&me, &target);
        }
        Ok(())
    }

    fn block(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me_id()?;
        let target = self
            .user_id_for_tag(tag)
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        if target == me {
            return Err("cannot_add_self: that's your own tag".to_string());
        }
        self.remove_friendship(&me, &target);
        self.remove_requests_between(&me, &target);
        if let Some(mine) = self.accounts.get_mut(&me) {
            if !mine.blocked.iter().any(|b| b == &target) {
                mine.blocked.push(target);
            }
        }
        Ok(())
    }

    fn unblock(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me_id()?;
        if let Some(target) = self.user_id_for_tag(tag) {
            if let Some(mine) = self.accounts.get_mut(&me) {
                mine.blocked.retain(|b| b != &target);
            }
        }
        Ok(())
    }

    fn get_friends(&self) -> Result<FriendsSnapshot, String> {
        let me = self.me_id()?;
        let mine = self.accounts.get(&me).unwrap();
        let mut friends: Vec<CachedFriend> = mine
            .friends
            .iter()
            .filter_map(|id| {
                let a = self.accounts.get(id)?;
                let (presence, playing) = self
                    .presence
                    .get(id)
                    .cloned()
                    .unwrap_or((PresenceState::Offline, None));
                Some(CachedFriend {
                    tag: a.tag.clone(),
                    avatar: a.avatar.clone(),
                    bio: a.bio.clone(),
                    presence,
                    playing,
                })
            })
            .collect();
        kova_core::sort_friends(&mut friends);
        let requests_in: Vec<FriendRequest> = mine
            .requests_in
            .iter()
            .filter_map(|r| {
                let from = self.accounts.get(&r.from_user)?;
                Some(FriendRequest {
                    id: r.id.clone(),
                    from_tag: from.tag.clone(),
                    from_avatar: from.avatar.clone(),
                    from_bio: from.bio.clone(),
                    created_at: r.created_at,
                })
            })
            .collect();
        let requests_out: Vec<OutgoingRequest> = mine
            .requests_out
            .iter()
            .map(|r| OutgoingRequest {
                id: r.id.clone(),
                to_tag: self.display_tag(&r.to_user),
                created_at: r.created_at,
            })
            .collect();
        let blocked: Vec<String> = mine
            .blocked
            .iter()
            .map(|id| self.display_tag(id))
            .collect();
        Ok(FriendsSnapshot {
            friends,
            requests_in,
            requests_out,
            blocked,
        })
    }

    fn send_message(&mut self, to_tag: &str, body: &str) -> Result<LiveMessage, String> {
        let me = self.me_id()?;
        let target = self
            .user_id_for_tag(to_tag)
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        let (is_friend, is_blocked, they_blocked) = {
            let mine = self.accounts.get(&me).unwrap();
            let theirs = self.accounts.get(&target).unwrap();
            (
                mine.friends.iter().any(|f| f == &target),
                mine.blocked.iter().any(|b| b == &target),
                theirs.blocked.iter().any(|b| b == &me),
            )
        };
        if !is_friend {
            return Err("not_friends: you can only message friends".to_string());
        }
        if is_blocked || they_blocked {
            return Err("blocked: you can't message this player".to_string());
        }
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err("message_empty: write something first".to_string());
        }
        if body.chars().count() > kova_core::MESSAGE_MAX_CHARS {
            return Err("message_too_long: messages can be at most 2000 characters".to_string());
        }
        let now = now_unix();
        let rate_limited = {
            let mine = self.accounts.get_mut(&me).unwrap();
            mine.send_times.retain(|t| now - *t < 60);
            if mine.send_times.len() >= kova_core::MESSAGE_RATE_LIMIT_PER_MINUTE {
                true
            } else {
                mine.send_times.push(now);
                false
            }
        };
        if rate_limited {
            return Err("rate_limited: slow down — too many messages at once".to_string());
        }
        let id = self.next_id("m");
        self.messages.push(StubMessage {
            id: id.clone(),
            from_user: me.clone(),
            to_user: target.clone(),
            body: body.clone(),
            sent_at: now,
        });
        let m = self.messages.last().unwrap();
        Ok(LiveMessage {
            id: m.id.clone(),
            conversation_tag: self.display_tag(&target),
            from_tag: self.display_tag(&me),
            body: m.body.clone(),
            sent_at: m.sent_at,
            mine: true,
        })
    }

    fn fetch_messages(&self, tag: &str) -> Result<Vec<LiveMessage>, String> {
        let me = self.me_id()?;
        let target = match self.user_id_for_tag(tag) {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };
        let mut out: Vec<LiveMessage> = self
            .messages
            .iter()
            .filter(|m| {
                (m.from_user == me && m.to_user == target)
                    || (m.from_user == target && m.to_user == me)
            })
            .map(|m| self.project_message(m, &me))
            .collect();
        out.sort_by_key(|m| m.sent_at);
        Ok(kova_core::prune_messages(out))
    }

    fn fetch_all_messages(&self) -> Result<Vec<LiveMessage>, String> {
        let me = self.me_id()?;
        let mut out: Vec<LiveMessage> = self
            .messages
            .iter()
            .filter(|m| m.from_user == me || m.to_user == me)
            .map(|m| self.project_message(m, &me))
            .collect();
        out.sort_by_key(|m| m.sent_at);
        Ok(out)
    }

    fn delete_message(&mut self, message_id: &str) -> Result<(), String> {
        let me = self.me_id()?;
        let pos = self.messages.iter().position(|m| m.id == message_id);
        match pos {
            Some(i) => {
                if self.messages[i].from_user != me {
                    return Err("not_your_message: you can only delete your own messages".to_string());
                }
                self.messages.remove(i);
                Ok(())
            }
            None => Err("message_not_found: that message is gone".to_string()),
        }
    }

    fn report(&mut self, kind: &str, ref_: &str, note: &str) -> Result<(), String> {
        let me = self.me_id()?;
        if kind != "message" && kind != "profile" {
            return Err("report_invalid: reports are for a message or a profile".to_string());
        }
        if note.chars().count() > kova_core::REPORT_NOTE_MAX_CHARS {
            return Err("report_note_too_long: keep the note under 500 characters".to_string());
        }
        // The stub keeps reports in memory; the real backend queues
        // them for the Avok team's manual review (spec §5.4).
        self.reports.push(StubReport {
            reporter: me,
            kind: kind.to_string(),
            ref_: ref_.to_string(),
            note: note.to_string(),
            created_at: now_unix(),
        });
        Ok(())
    }

    fn delete_account(&mut self) -> Result<(), String> {
        let me = self.me_id()?;
        let (tag, email) = self
            .accounts
            .get(&me)
            .map(|a| (a.tag.clone(), a.email.clone()))
            .unwrap_or_default();
        let now = now_unix();
        self.held_tags
            .insert(kova_core::tag_key(&tag), now + kova_core::TAG_HOLD_SECS);
        self.tags.remove(&kova_core::tag_key(&tag));
        self.by_email.remove(&email.to_lowercase());
        for account in self.accounts.values_mut() {
            account.friends.retain(|f| f != &me);
            account.blocked.retain(|b| b != &me);
            account
                .requests_in
                .retain(|r| r.from_user != me && r.to_user != me);
            account
                .requests_out
                .retain(|r| r.from_user != me && r.to_user != me);
        }
        self.messages.retain(|m| m.from_user != me);
        self.reports.retain(|r| r.reporter != me);
        self.presence.remove(&me);
        self.accounts.remove(&me);
        self.current = None;
        Ok(())
    }

    fn sync_profile(&mut self, profile: &GamerProfile) -> Result<(), String> {
        let me = self.me_id()?;
        if let Some(account) = self.accounts.get_mut(&me) {
            account.avatar = profile.avatar.clone();
            account.bio = profile.bio.clone();
        }
        Ok(())
    }

    fn set_presence(&mut self, presence: &PresencePublish) -> Result<(), String> {
        let me = match &self.current {
            Some(id) => id.clone(),
            None => return Ok(()),
        };
        let state = match presence.state.as_str() {
            "in_game" => PresenceState::InGame,
            "offline" => PresenceState::Offline,
            _ => PresenceState::Online,
        };
        self.presence
            .insert(me, (state, presence.playing.clone()));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Supabase backend — the real client (UNVERIFIED against a live
// project: no project exists yet. Compiled + structure-checked
// only. When Dre approves the project, this is what talks to it.)
// ---------------------------------------------------------------------------

/// Supabase Auth + PostgREST over HTTPS (blocking reqwest), with
/// a Realtime websocket thread for inbound message push. All calls
/// have a 10s timeout and fail soft — the UI falls back to the
/// cached state (spec §8).
pub struct SupabaseBackend {
    client: reqwest::blocking::Client,
    base_url: String,
    anon_key: String,
    session: Option<SessionInfo>,
}

fn http_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "offline: KOVA LIVE didn't answer in time".to_string()
    } else if e.is_connect() {
        "offline: couldn't reach KOVA LIVE".to_string()
    } else {
        format!("offline: couldn't reach KOVA LIVE ({e})")
    }
}

impl SupabaseBackend {
    pub fn new(config: &LiveConfig) -> SupabaseBackend {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        SupabaseBackend {
            client,
            base_url: config
                .supabase_url
                .clone()
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string(),
            anon_key: config.supabase_anon_key.clone().unwrap_or_default(),
            session: None,
        }
    }

    fn configured(&self) -> Result<(), String> {
        if self.base_url.is_empty() || self.anon_key.is_empty() {
            return Err(
                "not_configured: KOVA LIVE isn't set up yet — no Supabase project is configured"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn me(&self) -> Result<&SessionInfo, String> {
        self.session
            .as_ref()
            .ok_or_else(|| "not_signed_in: sign in to KOVA LIVE first".to_string())
    }

    fn auth_headers(&self, authed: bool) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "apikey",
            reqwest::header::HeaderValue::from_str(&self.anon_key)
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")),
        );
        let token = if authed {
            self.session
                .as_ref()
                .map(|s| s.access_token.clone())
                .unwrap_or_else(|| self.anon_key.clone())
        } else {
            self.anon_key.clone()
        };
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
        headers
    }

    /// POST to Supabase Auth. Returns the parsed JSON body.
    fn auth_post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.configured()?;
        let url = format!("{}/auth/v1{path}", self.base_url);
        let resp = self
            .client
            .post(&url)
            .headers(self.auth_headers(false))
            .json(body)
            .send()
            .map_err(http_err)?;
        let status = resp.status();
        let value: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let msg = value
                .get("msg")
                .or_else(|| value.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("sign-in failed");
            if status.as_u16() == 400 || status.as_u16() == 401 {
                return Err(format!("invalid_credentials: {msg}"));
            }
            return Err(format!("live_error: {msg}"));
        }
        Ok(value)
    }

    /// PostgREST request. `query` is the raw query string (without
    /// `?`). Returns the parsed JSON body (usually an array).
    fn rest(
        &self,
        method: &str,
        table: &str,
        query: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        self.configured()?;
        let url = format!("{}/rest/v1/{table}?{query}", self.base_url);
        let mut req = match method {
            "POST" => self.client.post(&url),
            "PATCH" => self.client.patch(&url),
            "DELETE" => self.client.delete(&url),
            _ => self.client.get(&url),
        };
        req = req.headers(self.auth_headers(true));
        if method == "POST" || method == "PATCH" {
            // PostgREST upserts need an explicit resolution preference:
            // `on_conflict` alone only names the conflict target — without
            // `resolution=merge-duplicates` the POST is a plain INSERT and
            // 409s on conflict (caught 2026-11-14: the presence heartbeat
            // would never update past its first publish).
            let prefer = if method == "POST" && query.contains("on_conflict=") {
                "return=representation,resolution=merge-duplicates"
            } else {
                "return=representation"
            };
            req = req.header("Prefer", prefer);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let resp = req.send().map_err(http_err)?;
        let status = resp.status();
        let value: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        if !status.is_success() {
            let msg = value
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("request failed");
            return Err(format!("live_error: {msg} (HTTP {})", status.as_u16()));
        }
        Ok(value)
    }

    fn user_id_for_tag(&self, tag: &str) -> Result<Option<String>, String> {
        let key = kova_core::tag_key(tag);
        let rows = self.rest(
            "GET",
            "profiles",
            &format!("tag_key=eq.{}&select=user_id", url_encode(&key)),
            None,
        )?;
        Ok(rows
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("user_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    }

    fn profile_row(&self, user_id: &str) -> Result<Option<PublicProfile>, String> {
        let rows = self.rest(
            "GET",
            "profiles",
            &format!("user_id=eq.{}&select=tag,avatar,bio", url_encode(user_id)),
            None,
        )?;
        Ok(rows
            .as_array()
            .and_then(|a| a.first())
            .map(|r| PublicProfile {
                tag: r.get("tag").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                avatar: r
                    .get("avatar")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                bio: r.get("bio").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            }))
    }

    /// Is either side blocking the other?
    fn blocked_either_way(&self, me: &str, them: &str) -> Result<bool, String> {
        let rows = self.rest(
            "GET",
            "blocks",
            &format!(
                "or=(and(blocker.eq.{},blocked.eq.{}),and(blocker.eq.{},blocked.eq.{}))&select=blocker",
                url_encode(me),
                url_encode(them),
                url_encode(them),
                url_encode(me)
            ),
            None,
        )?;
        Ok(rows
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false))
    }

    fn are_friends(&self, me: &str, them: &str) -> Result<bool, String> {
        let rows = self.rest(
            "GET",
            "friendships",
            &format!(
                "or=(and(user_a.eq.{},user_b.eq.{}),and(user_a.eq.{},user_b.eq.{}))&select=user_a",
                url_encode(me),
                url_encode(them),
                url_encode(them),
                url_encode(me)
            ),
            None,
        )?;
        Ok(rows
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false))
    }
}

fn url_encode(s: &str) -> String {
    // Minimal percent-encoding for PostgREST query values: the
    // values here are tags, uuids, and keys — encode everything
    // outside the unreserved set.
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl LiveBackend for SupabaseBackend {
    fn backend_name(&self) -> &'static str {
        "supabase"
    }

    fn session(&self) -> Option<SessionInfo> {
        self.session.clone()
    }

    fn restore_session(&mut self, refresh_token: &str) -> Result<SessionInfo, String> {
        let value = self.auth_post(
            "/token?grant_type=refresh_token",
            &serde_json::json!({ "refresh_token": refresh_token }),
        )?;
        let access = value
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let refresh = value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or(refresh_token)
            .to_string();
        let user = value.get("user").cloned().unwrap_or(serde_json::Value::Null);
        let user_id = user
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let email = user
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let verified = user.get("email_confirmed_at").is_some_and(|v| !v.is_null());
        self.session = Some(SessionInfo {
            user_id: user_id.clone(),
            email: email.clone(),
            tag: String::new(),
            email_verified: verified,
            access_token: access.clone(),
            refresh_token: refresh.clone(),
        });
        let profile = self.profile_row(&user_id)?.unwrap_or(PublicProfile {
            tag: String::new(),
            avatar: String::new(),
            bio: String::new(),
        });
        let mut session = self.session.clone().unwrap();
        session.tag = profile.tag;
        self.session = Some(session.clone());
        Ok(session)
    }

    fn sign_up(&mut self, email: &str, password: &str, tag: &str) -> Result<SessionInfo, String> {
        let email = email.trim().to_lowercase();
        if !valid_email_shape(&email) {
            return Err("email_invalid: enter a valid email address".to_string());
        }
        if password.chars().count() < kova_core::PASSWORD_MIN_CHARS {
            return Err("password_too_short: passwords need at least 8 characters".to_string());
        }
        let tag = kova_core::validate_live_tag(tag)?;
        let check = self.check_tag(&tag)?;
        if !check.available {
            return Err("tag_taken: that tag is already claimed".to_string());
        }
        // The tag rides in user_metadata so the project's
        // on-signup trigger can create the profiles row (see the
        // setup checklist in this module's header).
        let value = self.auth_post(
            "/signup",
            &serde_json::json!({
                "email": email,
                "password": password,
                "data": { "tag": tag, "tag_key": kova_core::tag_key(&tag) },
            }),
        )?;
        let user = value.get("user").cloned().unwrap_or(serde_json::Value::Null);
        let user_id = user
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if user_id.is_empty() {
            return Err("sign_up_failed: the account could not be created".to_string());
        }
        let verified = user.get("email_confirmed_at").is_some_and(|v| !v.is_null());
        // With email confirmation on, signup returns no session —
        // the player signs in after verifying. Without it, a
        // session comes back immediately.
        let session_value = value.get("session").cloned().unwrap_or(serde_json::Value::Null);
        let access = session_value
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let refresh = session_value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let session = SessionInfo {
            user_id,
            email,
            tag,
            email_verified: verified,
            access_token: access,
            refresh_token: refresh,
        };
        if !session.access_token.is_empty() {
            self.session = Some(session.clone());
        }
        Ok(session)
    }

    fn sign_in(&mut self, email: &str, password: &str) -> Result<SessionInfo, String> {
        let email = email.trim().to_lowercase();
        let value = self.auth_post(
            "/token?grant_type=password",
            &serde_json::json!({ "email": email, "password": password }),
        )?;
        let access = value
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let refresh = value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let user = value.get("user").cloned().unwrap_or(serde_json::Value::Null);
        let user_id = user
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let verified = user.get("email_confirmed_at").is_some_and(|v| !v.is_null());
        let mut session = SessionInfo {
            user_id: user_id.clone(),
            email,
            tag: String::new(),
            email_verified: verified,
            access_token: access,
            refresh_token: refresh,
        };
        self.session = Some(session.clone());
        // The profile row (created by the signup trigger) holds
        // the tag. If it is missing (trigger not deployed), create
        // it best-effort from the user metadata.
        let profile = self.profile_row(&user_id)?;
        session.tag = match profile {
            Some(p) => p.tag,
            None => {
                let meta_tag = user
                    .get("user_metadata")
                    .and_then(|m| m.get("tag"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if !meta_tag.is_empty() {
                    let _ = self.rest(
                        "POST",
                        "profiles",
                        "on_conflict=user_id",
                        Some(&serde_json::json!({
                            "user_id": user_id,
                            "tag": meta_tag,
                            "tag_key": kova_core::tag_key(&meta_tag),
                            "avatar": "",
                            "bio": "",
                        })),
                    );
                }
                meta_tag
            }
        };
        self.session = Some(session.clone());
        Ok(session)
    }

    fn sign_out(&mut self) {
        if self.session.is_some() {
            let _ = self.auth_post("/logout", &serde_json::json!({}));
        }
        self.session = None;
    }

    fn resend_verification(&mut self) -> Result<(), String> {
        let email = self.me()?.email.clone();
        self.auth_post(
            "/resend",
            &serde_json::json!({ "type": "signup", "email": email }),
        )?;
        Ok(())
    }

    fn check_tag(&self, tag: &str) -> Result<TagCheck, String> {
        let tag = kova_core::validate_live_tag(tag)?;
        let key = kova_core::tag_key(&tag);
        let taken = self.user_id_for_tag(&tag)?.is_some();
        let held = {
            let rows = self.rest(
                "GET",
                "held_tags",
                &format!(
                    "tag_key=eq.{}&held_until=gt.{}&select=tag_key",
                    url_encode(&key),
                    // now, as ISO-8601 — PostgREST compares
                    // timestamptz against the literal.
                    chrono_now_iso()
                ),
                None,
            )?;
            rows.as_array().map(|a| !a.is_empty()).unwrap_or(false)
        };
        if !taken && !held {
            return Ok(TagCheck {
                available: true,
                suggestions: Vec::new(),
            });
        }
        let mut suggestions = Vec::new();
        for variant in kova_core::suggest_tag_variants(&tag) {
            if self.user_id_for_tag(&variant)?.is_none() {
                suggestions.push(variant);
            }
            if suggestions.len() >= 3 {
                break;
            }
        }
        Ok(TagCheck {
            available: false,
            suggestions,
        })
    }

    fn claim_tag(&mut self, tag: &str) -> Result<String, String> {
        let me = self.me()?.user_id.clone();
        let current_tag = self.me()?.tag.clone();
        let tag = kova_core::validate_live_tag(tag)?;
        if kova_core::tag_key(&current_tag) == kova_core::tag_key(&tag) {
            return Ok(current_tag);
        }
        // 30-day rule, from the profiles row.
        let rows = self.rest(
            "GET",
            "profiles",
            &format!("user_id=eq.{}&select=tag_changed_at", url_encode(&me)),
            None,
        )?;
        if let Some(changed) = rows
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("tag_changed_at"))
            .and_then(|v| v.as_str())
        {
            if let Ok(changed_unix) = parse_iso_to_unix(changed) {
                if now_unix() - changed_unix < kova_core::TAG_CHANGE_COOLDOWN_SECS {
                    return Err(
                        "tag_change_too_soon: tags can change once every 30 days".to_string()
                    );
                }
            }
        }
        let check = self.check_tag(&tag)?;
        if !check.available {
            return Err("tag_taken: that tag is already claimed".to_string());
        }
        self.rest(
            "PATCH",
            "profiles",
            &format!("user_id=eq.{}", url_encode(&me)),
            Some(&serde_json::json!({
                "tag": tag,
                "tag_key": kova_core::tag_key(&tag),
                "tag_changed_at": chrono_now_iso(),
            })),
        )?;
        // Hold the old tag for 30 days.
        let _ = self.rest(
            "POST",
            "held_tags",
            "on_conflict=tag_key",
            Some(&serde_json::json!({
                "tag_key": kova_core::tag_key(&current_tag),
                "held_until": chrono_iso_in_days(30),
            })),
        );
        if let Some(session) = self.session.as_mut() {
            session.tag = tag.clone();
        }
        Ok(tag)
    }

    fn search_tag(&self, tag: &str) -> Result<Option<PublicProfile>, String> {
        let user_id = match self.user_id_for_tag(tag)? {
            Some(id) => id,
            None => return Ok(None),
        };
        if let Some(me) = self.session.as_ref().map(|s| s.user_id.clone()) {
            if self.blocked_either_way(&me, &user_id)? {
                return Ok(None);
            }
        }
        self.profile_row(&user_id)
    }

    fn send_request(&mut self, tag: &str) -> Result<String, String> {
        let me = self.me()?.user_id.clone();
        let target = self
            .user_id_for_tag(tag)?
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        if target == me {
            return Err("cannot_add_self: that's your own tag".to_string());
        }
        if self.are_friends(&me, &target)? {
            return Err("already_friends: you're already friends".to_string());
        }
        if self.blocked_either_way(&me, &target)? {
            return Err("blocked: you can't send a request to this player".to_string());
        }
        let pending = self.rest(
            "GET",
            "friend_requests",
            &format!(
                "or=(and(from_user.eq.{},to_user.eq.{}),and(from_user.eq.{},to_user.eq.{}))&status=eq.pending&select=id,from_user",
                url_encode(&me),
                url_encode(&target),
                url_encode(&target),
                url_encode(&me)
            ),
            None,
        )?;
        if let Some(rows) = pending.as_array() {
            if let Some(row) = rows.first() {
                let from = row.get("from_user").and_then(|v| v.as_str()).unwrap_or("");
                if from == me {
                    return Err("already_pending: your request is already waiting".to_string());
                }
                return Err(
                    "already_pending: they already sent you a request — accept it in Friends"
                        .to_string(),
                );
            }
        }
        let friends = self.rest(
            "GET",
            "friendships",
            &format!(
                "or=(user_a.eq.{},user_b.eq.{})&select=user_a",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        )?;
        if friends.as_array().map(|a| a.len()).unwrap_or(0) >= kova_core::FRIEND_CAP {
            return Err("friend_cap: your friends list is full (500)".to_string());
        }
        let created = self.rest(
            "POST",
            "friend_requests",
            "",
            Some(&serde_json::json!({
                "from_user": me,
                "to_user": target,
                "status": "pending",
            })),
        )?;
        Ok(created
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string())
    }

    fn accept_request(&mut self, request_id: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let rows = self.rest(
            "GET",
            "friend_requests",
            &format!(
                "id=eq.{}&to_user=eq.{}&status=eq.pending&select=from_user",
                url_encode(request_id),
                url_encode(&me)
            ),
            None,
        )?;
        let from = rows
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("from_user"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "request_not_found: that request is gone".to_string())?
            .to_string();
        let friends = self.rest(
            "GET",
            "friendships",
            &format!(
                "or=(user_a.eq.{},user_b.eq.{})&select=user_a",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        )?;
        if friends.as_array().map(|a| a.len()).unwrap_or(0) >= kova_core::FRIEND_CAP {
            return Err("friend_cap: your friends list is full (500)".to_string());
        }
        self.rest(
            "PATCH",
            "friend_requests",
            &format!("id=eq.{}", url_encode(request_id)),
            Some(&serde_json::json!({ "status": "accepted" })),
        )?;
        // Canonical order: the smaller uuid first.
        let (a, b) = if me < from {
            (me.clone(), from.clone())
        } else {
            (from.clone(), me.clone())
        };
        self.rest(
            "POST",
            "friendships",
            "on_conflict=user_a,user_b",
            Some(&serde_json::json!({ "user_a": a, "user_b": b })),
        )?;
        Ok(())
    }

    fn decline_request(&mut self, request_id: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        self.rest(
            "DELETE",
            "friend_requests",
            &format!(
                "id=eq.{}&to_user=eq.{}",
                url_encode(request_id),
                url_encode(&me)
            ),
            None,
        )?;
        Ok(())
    }

    fn remove_friend(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let target = match self.user_id_for_tag(tag)? {
            Some(id) => id,
            None => return Ok(()),
        };
        self.rest(
            "DELETE",
            "friendships",
            &format!(
                "or=(and(user_a.eq.{},user_b.eq.{}),and(user_a.eq.{},user_b.eq.{}))",
                url_encode(&me),
                url_encode(&target),
                url_encode(&target),
                url_encode(&me)
            ),
            None,
        )?;
        Ok(())
    }

    fn block(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let target = self
            .user_id_for_tag(tag)?
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        if target == me {
            return Err("cannot_add_self: that's your own tag".to_string());
        }
        let _ = self.remove_friend(tag);
        let _ = self.rest(
            "DELETE",
            "friend_requests",
            &format!(
                "or=(and(from_user.eq.{},to_user.eq.{}),and(from_user.eq.{},to_user.eq.{}))",
                url_encode(&me),
                url_encode(&target),
                url_encode(&target),
                url_encode(&me)
            ),
            None,
        );
        self.rest(
            "POST",
            "blocks",
            "on_conflict=blocker,blocked",
            Some(&serde_json::json!({ "blocker": me, "blocked": target })),
        )?;
        Ok(())
    }

    fn unblock(&mut self, tag: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let target = match self.user_id_for_tag(tag)? {
            Some(id) => id,
            None => return Ok(()),
        };
        self.rest(
            "DELETE",
            "blocks",
            &format!(
                "blocker=eq.{}&blocked=eq.{}",
                url_encode(&me),
                url_encode(&target)
            ),
            None,
        )?;
        Ok(())
    }

    fn get_friends(&self) -> Result<FriendsSnapshot, String> {
        let me = self.me()?.user_id.clone();
        // Friend ids, then their profiles + presence in two batched
        // reads (PostgREST `in` lists).
        let edges = self.rest(
            "GET",
            "friendships",
            &format!(
                "or=(user_a.eq.{},user_b.eq.{})&select=user_a,user_b",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        )?;
        let mut friend_ids: Vec<String> = Vec::new();
        if let Some(rows) = edges.as_array() {
            for row in rows {
                for key in ["user_a", "user_b"] {
                    if let Some(id) = row.get(key).and_then(|v| v.as_str()) {
                        if id != me && !friend_ids.contains(&id.to_string()) {
                            friend_ids.push(id.to_string());
                        }
                    }
                }
            }
        }
        let mut friends: Vec<CachedFriend> = Vec::new();
        if !friend_ids.is_empty() {
            let in_list = friend_ids.join(",");
            let profiles = self.rest(
                "GET",
                "profiles",
                &format!("user_id=in.({})&select=user_id,tag,avatar,bio", in_list),
                None,
            )?;
            let presence = self
                .rest(
                    "GET",
                    "presence",
                    &format!("user_id=in.({})&select=user_id,state,playing", in_list),
                    None,
                )
                .unwrap_or(serde_json::Value::Null);
            let presence_map: HashMap<String, (String, Option<String>)> = presence
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| {
                            let id = r.get("user_id")?.as_str()?.to_string();
                            let state = r
                                .get("state")
                                .and_then(|v| v.as_str())
                                .unwrap_or("offline")
                                .to_string();
                            let playing = r
                                .get("playing")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            Some((id, (state, playing)))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(rows) = profiles.as_array() {
                for row in rows {
                    let id = row
                        .get("user_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let (state, playing) = presence_map
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| ("offline".to_string(), None));
                    friends.push(CachedFriend {
                        tag: row
                            .get("tag")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        avatar: row
                            .get("avatar")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        bio: row
                            .get("bio")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        presence: match state.as_str() {
                            "online" => PresenceState::Online,
                            "in_game" => PresenceState::InGame,
                            _ => PresenceState::Offline,
                        },
                        playing,
                    });
                }
            }
        }
        kova_core::sort_friends(&mut friends);
        // Requests in / out.
        let requests_in = {
            let rows = self.rest(
                "GET",
                "friend_requests",
                &format!(
                    "to_user=eq.{}&status=eq.pending&select=id,from_user,created_at&order=created_at.asc",
                    url_encode(&me)
                ),
                None,
            )?;
            let mut out = Vec::new();
            if let Some(list) = rows.as_array() {
                for row in list {
                    let from = row
                        .get("from_user")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let profile = self.profile_row(from)?.unwrap_or(PublicProfile {
                        tag: String::new(),
                        avatar: String::new(),
                        bio: String::new(),
                    });
                    out.push(FriendRequest {
                        id: row
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        from_tag: profile.tag,
                        from_avatar: profile.avatar,
                        from_bio: profile.bio,
                        created_at: row
                            .get("created_at")
                            .and_then(|v| v.as_str())
                            .and_then(|s| parse_iso_to_unix(s).ok())
                            .unwrap_or(0),
                    });
                }
            }
            out
        };
        let requests_out = {
            let rows = self.rest(
                "GET",
                "friend_requests",
                &format!(
                    "from_user=eq.{}&status=eq.pending&select=id,to_user,created_at&order=created_at.asc",
                    url_encode(&me)
                ),
                None,
            )?;
            let mut out = Vec::new();
            if let Some(list) = rows.as_array() {
                for row in list {
                    let to = row
                        .get("to_user")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let profile = self.profile_row(to)?.unwrap_or(PublicProfile {
                        tag: String::new(),
                        avatar: String::new(),
                        bio: String::new(),
                    });
                    out.push(OutgoingRequest {
                        id: row
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        to_tag: profile.tag,
                        created_at: row
                            .get("created_at")
                            .and_then(|v| v.as_str())
                            .and_then(|s| parse_iso_to_unix(s).ok())
                            .unwrap_or(0),
                    });
                }
            }
            out
        };
        let blocked = {
            let rows = self.rest(
                "GET",
                "blocks",
                &format!("blocker=eq.{}&select=blocked", url_encode(&me)),
                None,
            )?;
            let mut out = Vec::new();
            if let Some(list) = rows.as_array() {
                for row in list {
                    if let Some(id) = row.get("blocked").and_then(|v| v.as_str()) {
                        if let Some(profile) = self.profile_row(id)? {
                            out.push(profile.tag);
                        }
                    }
                }
            }
            out
        };
        Ok(FriendsSnapshot {
            friends,
            requests_in,
            requests_out,
            blocked,
        })
    }

    fn send_message(&mut self, to_tag: &str, body: &str) -> Result<LiveMessage, String> {
        let me = self.me()?.user_id.clone();
        let my_tag = self.me()?.tag.clone();
        let target = self
            .user_id_for_tag(to_tag)?
            .ok_or_else(|| "tag_not_found: no player with that tag".to_string())?;
        if !self.are_friends(&me, &target)? {
            return Err("not_friends: you can only message friends".to_string());
        }
        if self.blocked_either_way(&me, &target)? {
            return Err("blocked: you can't message this player".to_string());
        }
        let body = body.trim().to_string();
        if body.is_empty() {
            return Err("message_empty: write something first".to_string());
        }
        if body.chars().count() > kova_core::MESSAGE_MAX_CHARS {
            return Err("message_too_long: messages can be at most 2000 characters".to_string());
        }
        // Server-side rate limiting is a project rule (edge
        // function / DB check) — the client sends and surfaces a
        // rejection plainly if one comes back.
        let created = self.rest(
            "POST",
            "messages",
            "",
            Some(&serde_json::json!({
                "from_user": me,
                "to_user": target,
                "body": body,
            })),
        )?;
        let row = created
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok(LiveMessage {
            id: row
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            conversation_tag: to_tag.to_string(),
            from_tag: my_tag,
            body,
            sent_at: row
                .get("sent_at")
                .and_then(|v| v.as_str())
                .and_then(|s| parse_iso_to_unix(s).ok())
                .unwrap_or_else(now_unix),
            mine: true,
        })
    }

    fn fetch_messages(&self, tag: &str) -> Result<Vec<LiveMessage>, String> {
        let me = self.me()?.user_id.clone();
        let target = match self.user_id_for_tag(tag)? {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };
        let rows = self.rest(
            "GET",
            "messages",
            &format!(
                "or=(and(from_user.eq.{},to_user.eq.{}),and(from_user.eq.{},to_user.eq.{}))&order=sent_at.asc&limit=500",
                url_encode(&me),
                url_encode(&target),
                url_encode(&target),
                url_encode(&me)
            ),
            None,
        )?;
        let mut out = Vec::new();
        if let Some(list) = rows.as_array() {
            for row in list {
                let from = row
                    .get("from_user")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let from_tag = if from == me {
                    self.me()?.tag.clone()
                } else {
                    tag.to_string()
                };
                out.push(LiveMessage {
                    id: row
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    conversation_tag: tag.to_string(),
                    from_tag,
                    body: row
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    sent_at: row
                        .get("sent_at")
                        .and_then(|v| v.as_str())
                        .and_then(|s| parse_iso_to_unix(s).ok())
                        .unwrap_or(0),
                    mine: from == me,
                });
            }
        }
        Ok(out)
    }

    fn fetch_all_messages(&self) -> Result<Vec<LiveMessage>, String> {
        let me = self.me()?.user_id.clone();
        let my_tag = self.me()?.tag.clone();
        let rows = self.rest(
            "GET",
            "messages",
            &format!(
                "or=(from_user.eq.{},to_user.eq.{})&order=sent_at.asc&limit=1000",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        )?;
        let mut out = Vec::new();
        let mut tag_cache: HashMap<String, String> = HashMap::new();
        if let Some(list) = rows.as_array() {
            for row in list {
                let from = row
                    .get("from_user")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let to = row
                    .get("to_user")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let other = if from == me { &to } else { &from };
                let other_tag = match tag_cache.get(other) {
                    Some(t) => t.clone(),
                    None => {
                        let t = self
                            .profile_row(other)?
                            .map(|p| p.tag)
                            .unwrap_or_default();
                        tag_cache.insert(other.clone(), t.clone());
                        t
                    }
                };
                out.push(LiveMessage {
                    id: row
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    conversation_tag: other_tag,
                    from_tag: if from == me {
                        my_tag.clone()
                    } else {
                        tag_cache.get(&from).cloned().unwrap_or_default()
                    },
                    body: row
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    sent_at: row
                        .get("sent_at")
                        .and_then(|v| v.as_str())
                        .and_then(|s| parse_iso_to_unix(s).ok())
                        .unwrap_or(0),
                    mine: from == me,
                });
            }
        }
        Ok(out)
    }

    fn delete_message(&mut self, message_id: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let rows = self.rest(
            "GET",
            "messages",
            &format!("id=eq.{}&select=from_user", url_encode(message_id)),
            None,
        )?;
        let from = rows
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("from_user"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "message_not_found: that message is gone".to_string())?;
        if from != me {
            return Err("not_your_message: you can only delete your own messages".to_string());
        }
        self.rest(
            "DELETE",
            "messages",
            &format!("id=eq.{}", url_encode(message_id)),
            None,
        )?;
        Ok(())
    }

    fn report(&mut self, kind: &str, ref_: &str, note: &str) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        if kind != "message" && kind != "profile" {
            return Err("report_invalid: reports are for a message or a profile".to_string());
        }
        if note.chars().count() > kova_core::REPORT_NOTE_MAX_CHARS {
            return Err("report_note_too_long: keep the note under 500 characters".to_string());
        }
        self.rest(
            "POST",
            "reports",
            "",
            Some(&serde_json::json!({
                "reporter": me,
                "kind": kind,
                "ref": ref_,
                "note": note,
            })),
        )?;
        Ok(())
    }

    fn delete_account(&mut self) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        let my_tag = self.me()?.tag.clone();
        // App data first (spec §7.4): messages sent, friendships,
        // requests, blocks, reports, presence, profile — then the
        // tag is held 30 days.
        let _ = self.rest(
            "DELETE",
            "messages",
            &format!("from_user=eq.{}", url_encode(&me)),
            None,
        );
        let _ = self.rest(
            "DELETE",
            "friendships",
            &format!(
                "or=(user_a.eq.{},user_b.eq.{})",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        );
        let _ = self.rest(
            "DELETE",
            "friend_requests",
            &format!(
                "or=(from_user.eq.{},to_user.eq.{})",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        );
        let _ = self.rest(
            "DELETE",
            "blocks",
            &format!(
                "or=(blocker.eq.{},blocked.eq.{})",
                url_encode(&me),
                url_encode(&me)
            ),
            None,
        );
        let _ = self.rest(
            "DELETE",
            "reports",
            &format!("reporter=eq.{}", url_encode(&me)),
            None,
        );
        let _ = self.rest(
            "DELETE",
            "presence",
            &format!("user_id=eq.{}", url_encode(&me)),
            None,
        );
        let _ = self.rest(
            "POST",
            "held_tags",
            "on_conflict=tag_key",
            Some(&serde_json::json!({
                "tag_key": kova_core::tag_key(&my_tag),
                "held_until": chrono_iso_in_days(30),
            })),
        );
        let _ = self.rest(
            "DELETE",
            "profiles",
            &format!("user_id=eq.{}", url_encode(&me)),
            None,
        );
        // The auth.users row needs the service key — a project-side
        // Edge Function (`delete-account`) does it. If the function
        // isn't deployed yet, the app data is already gone and the
        // player is signed out; the auth row is removed when the
        // function lands. Never block deletion on it.
        let url = format!("{}/functions/v1/delete-account", self.base_url);
        let _ = self
            .client
            .post(&url)
            .headers(self.auth_headers(true))
            .json(&serde_json::json!({}))
            .send();
        self.session = None;
        Ok(())
    }

    fn sync_profile(&mut self, profile: &GamerProfile) -> Result<(), String> {
        let me = self.me()?.user_id.clone();
        self.rest(
            "PATCH",
            "profiles",
            &format!("user_id=eq.{}", url_encode(&me)),
            Some(&serde_json::json!({
                "avatar": profile.avatar,
                "bio": profile.bio,
                "banner": profile.banner,
            })),
        )?;
        Ok(())
    }

    fn set_presence(&mut self, presence: &PresencePublish) -> Result<(), String> {
        let me = match self.session.as_ref().map(|s| s.user_id.clone()) {
            Some(id) => id,
            None => return Ok(()),
        };
        // Upsert the presence row (heartbeat). Friends read
        // presence from this table in get_friends, so presence
        // works even when the realtime socket is down.
        let _ = self.rest(
            "POST",
            "presence",
            "on_conflict=user_id",
            Some(&serde_json::json!({
                "user_id": me,
                "state": presence.state,
                "playing": presence.playing,
                "updated_at": chrono_now_iso(),
            })),
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Small ISO-8601 helpers (no chrono dependency — the app crate
// stays light; these cover exactly the shapes Supabase returns)
// ---------------------------------------------------------------------------

/// Current time as ISO-8601 UTC (`2026-11-14T19:30:00Z`).
fn chrono_now_iso() -> String {
    iso_from_unix(now_unix())
}

fn chrono_iso_in_days(days: i64) -> String {
    iso_from_unix(now_unix() + days * 86_400)
}

fn iso_from_unix(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's
/// civil-from-days algorithm — the same one kova-core's
/// `unix_timestamp_to_date` uses.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parse an ISO-8601 UTC timestamp (`2026-11-14T19:30:00Z`, with
/// optional fractional seconds) to unix seconds.
fn parse_iso_to_unix(s: &str) -> Result<i64, String> {
    let date_part = s.get(0..10).ok_or("bad timestamp")?;
    let time_part = s.get(11..19).ok_or("bad timestamp")?;
    let parse = |part: &str| -> Result<i64, String> {
        part.parse::<i64>().map_err(|_| "bad timestamp".to_string())
    };
    let year = parse(date_part.get(0..4).ok_or("bad timestamp")?)?;
    let month = parse(date_part.get(5..7).ok_or("bad timestamp")?)?;
    let day = parse(date_part.get(8..10).ok_or("bad timestamp")?)?;
    let hour = parse(time_part.get(0..2).ok_or("bad timestamp")?)?;
    let min = parse(time_part.get(3..5).ok_or("bad timestamp")?)?;
    let sec = parse(time_part.get(6..8).ok_or("bad timestamp")?)?;
    // Days from civil (Hinnant's inverse).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Ok(days * 86_400 + hour * 3600 + min * 60 + sec)
}

// ---------------------------------------------------------------------------
// Realtime — inbound message push (Supabase only, best-effort)
// ---------------------------------------------------------------------------

/// Handle for the realtime thread: stop it on sign-out.
pub struct RealtimeHandle {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RealtimeHandle {
    /// Signal the thread to exit. Deliberately does NOT join:
    /// the thread may be blocked in `socket.read()` with no
    /// timeout, and joining from a command (sign-out) could hang
    /// the UI indefinitely. The thread checks the flag after
    /// every read and exits then; dropping the handle detaches
    /// it, and process exit ends it regardless.
    pub fn stop(mut self) {
        self.stop
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Drop the join handle without joining (see above).
        let _ = self.thread.take();
    }
}

/// Spawn the realtime thread: connects to Supabase Realtime,
/// subscribes to INSERTs on the messages table addressed to this
/// user, and emits a `live-message` Tauri event per message. The
/// frontend also fetches on view entry, so a dropped socket only
/// delays delivery — it never loses messages. Reconnects with
/// backoff; never panics, never blocks the app.
///
/// UNVERIFIED against a live project (none exists yet). The
/// Phoenix join payloads follow Supabase Realtime's documented
/// wire shape; the first live-project test run must confirm the
/// join succeeds and events arrive.
pub fn spawn_realtime_thread(
    config: &LiveConfig,
    user_id: &str,
    access_token: &str,
    app: tauri::AppHandle,
) -> RealtimeHandle {
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = stop.clone();
    let base_url = config.supabase_url.clone().unwrap_or_default();
    let anon_key = config.supabase_anon_key.clone().unwrap_or_default();
    let user_id = user_id.to_string();
    let access_token = access_token.to_string();
    let thread = std::thread::spawn(move || {
        let mut backoff_secs: u64 = 1;
        while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            match realtime_loop(&base_url, &anon_key, &user_id, &access_token, &app, &stop_flag) {
                Ok(()) => backoff_secs = 1,
                Err(e) => {
                    eprintln!("KOVA LIVE realtime: {e}; reconnecting in {backoff_secs}s");
                    std::thread::sleep(std::time::Duration::from_secs(backoff_secs));
                    backoff_secs = (backoff_secs * 2).min(60);
                }
            }
        }
    });
    RealtimeHandle {
        stop,
        thread: Some(thread),
    }
}

fn realtime_loop(
    base_url: &str,
    anon_key: &str,
    user_id: &str,
    access_token: &str,
    app: &tauri::AppHandle,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    // wss://<host>/realtime/v1/websocket?apikey=...&vsn=1.0.0
    let ws_url = base_url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let url = format!("{ws_url}/realtime/v1/websocket?apikey={anon_key}&vsn=1.0.0");
    let (mut socket, _) =
        tungstenite::connect(url.as_str()).map_err(|e| format!("realtime connect failed: {e}"))?;
    // Join the messages channel with a postgres_changes filter.
    let join = serde_json::json!({
        "topic": "realtime:public:messages",
        "event": "phx_join",
        "payload": {
            "config": {
                "postgres_changes": [{
                    "event": "INSERT",
                    "schema": "public",
                    "table": "messages",
                    "filter": format!("to_user=eq.{user_id}"),
                }]
            },
            "access_token": access_token,
        },
        "ref": "1",
    });
    socket
        .send(tungstenite::Message::Text(join.to_string().into()))
        .map_err(|e| format!("realtime join failed: {e}"))?;
    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = socket.close(None);
            return Ok(());
        }
        let msg = socket
            .read()
            .map_err(|e| format!("realtime read failed: {e}"))?;
        // Stopped while the read was in flight (sign-out): exit
        // before emitting a stale event for the old user.
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = socket.close(None);
            return Ok(());
        }
        if let tungstenite::Message::Text(text) = msg {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if value.get("event").and_then(|v| v.as_str()) == Some("postgres_changes") {
                    if let Some(record) = value
                        .get("payload")
                        .and_then(|p| p.get("data"))
                        .and_then(|d| d.get("record"))
                    {
                        let message = LiveMessage {
                            id: record
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            conversation_tag: String::new(),
                            from_tag: String::new(),
                            body: record
                                .get("body")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            sent_at: record
                                .get("sent_at")
                                .and_then(|v| v.as_str())
                                .and_then(|s| parse_iso_to_unix(s).ok())
                                .unwrap_or_else(now_unix),
                            mine: false,
                        };
                        // Tags are resolved by the frontend on
                        // receipt (it re-fetches the conversation);
                        // the event carries the sender id.
                        let from_user = record
                            .get("from_user")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let _ = app.emit(
                            "live-message",
                            serde_json::json!({ "from_user": from_user, "message": message }),
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_presence_appear_offline_wins_over_playing() {
        let presence = derive_presence(true, false, Some("Dispatch HQ"));
        assert_eq!(presence.state, "offline");
        assert_eq!(presence.playing, None);
    }

    #[test]
    fn derive_presence_in_game_online_and_hidden() {
        let presence = derive_presence(false, false, Some("Dispatch HQ"));
        assert_eq!(presence.state, "in_game");
        assert_eq!(presence.playing.as_deref(), Some("Dispatch HQ"));

        let presence = derive_presence(false, true, Some("Dispatch HQ"));
        assert_eq!(presence.state, "online");
        assert_eq!(presence.playing, None);

        let presence = derive_presence(false, false, None);
        assert_eq!(presence.state, "online");
        assert_eq!(presence.playing, None);
    }

    #[test]
    fn stub_rejects_bad_sign_up() {
        let mut backend = StubBackend::new();
        assert!(backend
            .sign_up("not-an-email", "longpassword", "Tester")
            .unwrap_err()
            .starts_with("email_invalid"));
        assert!(backend
            .sign_up("a@b.co", "short", "Tester")
            .unwrap_err()
            .starts_with("password_too_short"));
        assert!(backend
            .sign_up("a@b.co", "longpassword", "Nova")
            .unwrap_err()
            .starts_with("tag_taken"));
        assert!(backend
            .sign_up("a@b.co", "longpassword", "No")
            .unwrap_err()
            .starts_with("tag_invalid"));
    }

    #[test]
    fn stub_check_tag_suggests_when_taken() {
        let backend = StubBackend::new();
        let check = backend.check_tag("Nova").unwrap();
        assert!(!check.available);
        assert!(!check.suggestions.is_empty());
        assert!(check.suggestions.iter().all(|s| s.starts_with("Nova")));
        assert!(backend.check_tag("SomebodyNew").unwrap().available);
    }

    #[test]
    fn stub_resend_verification_marks_verified() {
        let mut backend = StubBackend::new();
        let session = backend
            .sign_up("dre@example.com", "password123", "DreTest")
            .unwrap();
        assert!(!session.email_verified);
        backend.resend_verification().unwrap();
        assert!(backend.session().unwrap().email_verified);
    }

    #[test]
    fn stub_full_flow_friends_messages_block_claim() {
        let mut backend = StubBackend::new();
        let session = backend
            .sign_up("dre@example.com", "password123", "DreTest")
            .unwrap();
        assert_eq!(session.tag, "DreTest");
        assert!(!session.email_verified);

        // Seeded (contract §6): Nova's incoming request + the
        // Rook DM conversation.
        let friends = backend.get_friends().unwrap();
        assert_eq!(friends.requests_in.len(), 1);
        assert_eq!(friends.requests_in[0].id, "req_nova_1");
        assert_eq!(friends.requests_in[0].from_tag, "Nova");
        let rook = backend.fetch_messages("Rook").unwrap();
        assert_eq!(rook.len(), 3);
        assert_eq!(rook[0].body, "you on tonight?");
        assert!(!rook[0].mine);
        assert!(rook[1].mine);
        assert_eq!(rook[1].body, "yeah after dinner");

        // Accept Nova; add Sol (fake players auto-accept).
        backend.accept_request("req_nova_1").unwrap();
        backend.send_request("Sol").unwrap();
        let friends = backend.get_friends().unwrap();
        assert!(friends.friends.iter().any(|f| f.tag == "Nova"));
        assert!(friends.friends.iter().any(|f| f.tag == "Sol"));
        assert!(friends.requests_in.is_empty());
        let nova = friends.friends.iter().find(|f| f.tag == "Nova").unwrap();
        assert_eq!(nova.presence, PresenceState::Online);
        let sol = friends.friends.iter().find(|f| f.tag == "Sol").unwrap();
        assert_eq!(sol.presence, PresenceState::Offline);

        // DM Nova, then read it back.
        let sent = backend.send_message("Nova", "hey nova").unwrap();
        assert!(sent.mine);
        assert_eq!(sent.conversation_tag, "Nova");
        let conv = backend.fetch_messages("Nova").unwrap();
        assert_eq!(conv.len(), 1);
        assert_eq!(conv[0].body, "hey nova");

        // Block Ash: search reads as not found; unblock restores.
        backend.block("Ash").unwrap();
        assert!(backend.search_tag("Ash").unwrap().is_none());
        backend.unblock("Ash").unwrap();
        assert!(backend.search_tag("Ash").unwrap().is_some());

        // Tag claim + the 30-day cooldown on the next change.
        assert_eq!(backend.claim_tag("DreTest2").unwrap(), "DreTest2");
        assert!(backend
            .claim_tag("DreTest3")
            .unwrap_err()
            .starts_with("tag_change_too_soon"));

        // The old tag is held: a fresh account cannot take it.
        backend.sign_out();
        assert!(backend
            .sign_up("other@example.com", "password123", "DreTest")
            .unwrap_err()
            .starts_with("tag_taken"));

        // And the first account can sign back in under its new tag.
        let session = backend.sign_in("dre@example.com", "password123").unwrap();
        assert_eq!(session.tag, "DreTest2");
    }

    #[test]
    fn stub_restore_session_round_trips() {
        let mut backend = StubBackend::new();
        let session = backend
            .sign_up("dre@example.com", "password123", "DreTest")
            .unwrap();
        let token = session.refresh_token.clone();
        backend.sign_out();
        assert!(backend.session().is_none());
        let restored = backend.restore_session(&token).unwrap();
        assert_eq!(restored.tag, "DreTest");
        assert!(backend
            .restore_session("stub:nobody@example.com")
            .unwrap_err()
            .starts_with("invalid_session"));
    }
}
