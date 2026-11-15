# KOVA LIVE Phase 1 — API contract (BUILD-TIME DOC)

Pinned 2026-11-14. The Rust backend (`app/src-tauri/src/live.rs` +
commands in `lib.rs`) and the three JS shells implement EXACTLY this
contract. The spec (`KOVA_LIVE_PHASE1_SPEC.md`) governs behavior; this
file pins names, shapes, and the demo/stub behavior so both sides match
without talking to each other.

## 1. State — `KovaState.live` (kova-core, serde-defaulted)

```jsonc
{
  "signed_in_tag": null,        // string | null — the claimed LIVE tag when signed in
  "live_tag": null,             // string | null — claimed tag (may differ from local gamertag)
  "email_verified": false,
  "appear_offline": false,      // default OFF at first sign-in
  "hide_playing": false,        // default OFF at first sign-in
  "tag_changed_at": null,       // unix seconds of last tag change (30-day rule)
  "friends": [                  // cached friends list (server is source of truth)
    { "tag": "Nova", "avatar": "builtin:1", "bio": "...",
      "presence": "online",     // "online" | "in_game" | "offline"
      "playing": null }         // game display name when in_game, else null
  ],
  "requests_in": [
    { "id": "req_nova_1", "from_tag": "Nova", "from_avatar": "builtin:1",
      "from_bio": "...", "created_at": 1794000000 }
  ],
  "requests_out": [
    { "id": "req_sol_1", "to_tag": "Sol", "created_at": 1794000000 }
  ],
  "blocked": ["BadActor"]       // tags, display form
}
```

`get_state` returns this inside the normal state object. Old state files
load with an empty `live` section (all `#[serde(default)]`).

## 2. Message cache — `kova-live-messages.json` (app data dir, NOT in state)

```jsonc
{ "conversations": {
    "Rook": {
      "messages": [
        { "id": "m1", "conversation_tag": "Rook", "from_tag": "Rook",
          "body": "you on tonight?", "sent_at": 1794000000, "mine": false }
      ],
      "last_read": 1794000000    // unix seconds; unread = messages after last_read not mine
    }
} }
```

Cap 500 messages per conversation (oldest pruned). Sign-out clears this
file on that machine. Rust owns the file; the JS demo stub keeps the same
shape in memory.

## 3. Tauri commands (all sync; errors are plain strings, codes as prefixes)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `live_get_status` | — | `{ signed_in, live_tag, email_verified, appear_offline, hide_playing, pending_requests, backend, configured }` | `backend`: `"stub"` \| `"supabase"`. `configured`: false when supabase selected but no URL/key. |
| `live_sign_up` | `{ email, password, tag }` | `{ live_tag, email_verified: false }` | Password ≥ 8 chars (`password_too_short`). Email shape check (`email_invalid`). Tag rules §5 (`tag_invalid` / `tag_taken`). Refused on Kids shelf (`kids_disabled`). |
| `live_sign_in` | `{ email, password }` | status object (same as `live_get_status`) | Wrong credentials → `invalid_credentials`. Refused on Kids shelf (`kids_disabled`). |
| `live_sign_out` | — | `null` | Clears token + live cache + message file. Local profile untouched. |
| `live_resend_verification` | — | `null` | Stub: marks verified immediately (stub has no email). Supabase: sends the real email. |
| `live_check_tag` | `{ tag }` | `{ available, suggestions: [] }` | Suggestions only when taken. |
| `live_claim_tag` | `{ tag }` | `{ live_tag }` | Tag change post-creation. 30-day rule (`tag_change_too_soon`). Old tag held 30 days (server rule; stub enforces). |
| `live_search_tag` | `{ tag }` | `{ found, profile: { tag, avatar, bio } \| null }` | Exact match, case-insensitive. Blocked players read as not found. |
| `live_send_request` | `{ tag }` | `{ request_id }` | Self-add → `cannot_add_self`. Already friends → `already_friends`. Already pending → `already_pending`. Blocked either way → `blocked`. Friend cap 500 → `friend_cap`. |
| `live_accept_request` | `{ request_id }` | `null` | |
| `live_decline_request` | `{ request_id }` | `null` | |
| `live_remove_friend` | `{ tag }` | `null` | Silent both sides. |
| `live_block` | `{ tag }` | `null` | Removes friendship if any; hides from search; blocks messages + requests. |
| `live_unblock` | `{ tag }` | `null` | Restores search visibility only; does NOT restore friendship. |
| `live_get_friends` | — | `{ friends, requests_in, requests_out, blocked }` | Refreshes from backend; on backend failure returns the cached state (fail-soft). |
| `live_set_privacy` | `{ appear_offline?, hide_playing? }` | updated `live` section | Only the provided keys change. |
| `live_send_message` | `{ to_tag, body }` | `{ message }` | Friends only (`not_friends`). Blocked → `blocked`. Max 2000 chars (`message_too_long`). Rate limit 30/min (`rate_limited`). |
| `live_get_conversations` | — | `[ { tag, last_message, last_at, unread } ]` | Most-recent-first. |
| `live_get_messages` | `{ tag }` | `{ messages: [], unread }` | Marks the conversation read (updates `last_read`). |
| `live_delete_message` | `{ message_id }` | `null` | Own messages only (`not_your_message`). Removed for both sides. |
| `live_report` | `{ kind, ref_, note }` | `null` | `kind`: `"message"` \| `"profile"`. `ref_`: message id or tag (`ref` is a Rust keyword, so the arg is `ref_` on both the real and demo paths). Note optional (max 500 chars). |
| `live_delete_account` | `{ confirm_tag }` | `null` | `confirm_tag` must equal the LIVE tag (`confirm_mismatch`). Irreversible. Clears everything LIVE. |
| `live_get_presence` | — | `{ state, playing }` | Derived: `"online"` \| `"in_game"` \| `"offline"` \| `"appear_offline"`; `playing` = game name or null. |
| `live_sync_profile` | — | `null` | Push local avatar/bio/banner/tag to the server. Fail-soft. |

Error prefix convention: the error string starts with the code, e.g.
`"tag_taken: that tag is already claimed"`. The frontend matches on the
prefix before the first `:`.

## 4. Backend selection (Rust)

- Env `KOVA_LIVE_BACKEND`: `"stub"` (default) or `"supabase"`.
- Supabase config: env `KOVA_LIVE_SUPABASE_URL` +
  `KOVA_LIVE_SUPABASE_ANON_KEY`, or `live-config.json` in the app data
  dir (`{ "supabase_url", "supabase_anon_key" }`). Never hardcoded, never
  in the repo.
- Session token: OS credential store via the `keyring` crate
  (Keychain / Credential Manager). Never in `kova-state.json`, never
  plaintext on disk.
- Supabase selected but unconfigured → every LIVE command fails with
  `not_configured`; the UI shows the signed-out state with a note that
  LIVE isn't set up yet.

## 5. Tag rules (identical in Rust + JS)

- Trim. 3–32 chars. Allowed: letters, numbers, space, `_`, `-`.
- Case-insensitive uniqueness (`tag_key` = lowercase).
- Suggestions when taken: `{tag}_`, `{tag}-1`, `{tag}-2`, `{tag}_1`
  (first free ones, max 3).

## 6. Stub backend — seeded data (IDENTICAL in Rust stub + JS demo stub)

The stub is the server. On FIRST sign-up/sign-in of a fresh account it
seeds that account with:

- Fake players (searchable, addable):
  - `Nova` — online, avatar `builtin:1`, bio "Speedrunner, Hades II enjoyer."
  - `Rook` — in game "Dispatch HQ", avatar `builtin:2`, bio "On dispatch. Every call is a decision."
  - `Ash` — offline, avatar `builtin:3`, bio "Quiet hours."
  - `Sol` — offline, avatar `builtin:4`, bio "Building worlds."
- One incoming request from `Nova` (id `req_nova_1`).
- One DM conversation with `Rook` (3 messages, oldest first):
  1. Rook: "you on tonight?" (mine: false)
  2. me: "yeah after dinner" (mine: true)
  3. Rook: "good, bringing the ladder crew" (mine: false)
  `sent_at`: now-3600, now-3500, now-3400 (relative at seed time).
- `Nova`, `Rook`, `Ash`, `Sol` are TAKEN tags. Everything else is free.
- Outgoing friend requests to a fake player are AUTO-ACCEPTED
  immediately by the stub (the fake player "accepts"). This is
  stub-only behavior so the full flow completes in one session; the
  real backend waits for the other player. Document it in the UI? No —
  it just works; the request disappears from `requests_out` and the
  friend appears in `friends`.
- `live_resend_verification` in the stub marks the account verified
  immediately (there is no email in the stub).
- Stub rate limit: 30 messages/min (Rust stub enforces; JS demo stub
  MAY skip it — not exercised by tests).
- Stub friend cap 500, message cap 2000 chars, password min 8 chars:
  enforced in BOTH.

## 7. Shared JS — `app/src/live-client.js` (NEW, loaded by all three shells)

Loaded with `defer` AFTER `nav.js`, BEFORE each shell's main script
(same pattern as `ui-lifecycle.js`, which loads synchronously for its
guard — `live-client.js` does NOT need to be synchronous). It exposes
`window.KovaLive` with:

- `call(cmd, args)` — invokes the Tauri command, or the demo backend
  when there is no Tauri global (demo mode + headless tests).
- `isDemo()` — true when running against the demo backend.
- `validateTag(tag)` → `{ ok, tag, error }` (same rules as §5).
- `suggestTags(tag)` → `[String]`.
- `presenceLabel(friend)` → `"Online"` / `"Playing X"` / `"Offline"`.
- `sortFriends(friends)` → online-first (in-game counts as online),
  then alphabetical (case-insensitive).
- `demoBackend` — the in-memory stub implementing every command in §3
  with the seeded data from §6. All three shells share this ONE
  implementation: identical behavior in every shell is the point.
- `onEvent(name, fn)` — subscribe to `live-presence` / `live-message`
  Tauri events when running under Tauri; no-op in demo mode.

The demo backend MUST persist its state across shell switches within one
browser session (it lives on `window`, and shell switches are full page
loads — so it ALSO mirrors its state into `sessionStorage` under key
`kova-live-demo`, rehydrated on load). This is what makes the
cross-switch test pass: same friends, same messages, same privacy
settings in every shell.

## 8. UI surfaces (all three shells — Classic / Beta / Stage)

| Surface | Where in each shell |
|---|---|
| Friends view | Classic: sidebar tab + `view-friends` section. Beta: nav screen. Stage: top-bar entry + view. Contents: pending requests (incoming first, Accept/Decline), Messages section (conversations most-recent-first, unread badge), friend list (avatar, tag, presence line, Message button; online-first, offline greyed at bottom). Search box (exact-match) at top. |
| Conversation panel | Opens from a friend row's Message button. History oldest→newest, text box + Send. Report + Block actions on the conversation. |
| Join / sign-in | Profile view: "Join KOVA LIVE" card while signed out (sign-up + sign-in forms, tag claim step with availability check + suggestions, email-verification state with resend). While signed in: LIVE status line (`signed in as <tag>`, local tag vs LIVE tag when they differ) + sign-out. Sign-up completion screen shows BOTH privacy toggles. |
| Presence toggles | Settings → KOVA LIVE section: Appear offline + Hide what I'm playing. Also Appear offline in the Friends view header. |
| Blocked list + delete account | Settings → KOVA LIVE section: blocked list with Unblock per entry; "Delete my KOVA LIVE account" (two-step, type the tag to confirm). |
| Pending badge | Header gamertag chip (Classic) / nav badge (Beta + Stage) showing pending request count. |
| Kids shelf | When `kids.enabled`, LIVE sign-in/join is HIDDEN and disabled everywhere; Friends view shows the Kids note instead. |

Each shell keeps its OWN visual language (Classic: true-black flat +
cyan; Beta: light accent-ladder T-frame; Stage: dark #0c0f14, hero +
rows, top bar). Do not paste one shell's UI into another.

Copy rule: user-facing copy says "the Avok team" / "a member of the
Avok team", never "Melo and Dre". No personal names anywhere in LIVE
copy. No cross-store anything anywhere (no Steam/Epic/GOG/itch friend
mentions — friends are KOVA-native only).

## 9. What the JS build must NOT touch

Rust, `crates/`, `app/src-tauri/`, `Cargo.toml` / `Cargo.lock`,
`KOVA_LIVE_PHASE1_SPEC.md`, `V1.2.0_PLAN.md`, `ui-lifecycle.js`,
the feed, the site, the repo. No version bump. No commits.
