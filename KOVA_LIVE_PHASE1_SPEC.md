# KOVA LIVE — Phase 1 Spec

**Status:** DRAFT FOR DRE'S REVIEW — spec only, nothing built (K2: spec first,
show Dre, then build). Phase 1 ships as the next feature release after v1.3.3.

**Written:** 2026-11-14. **Author:** Melo (OS Team).

## 0. The design in one paragraph

KOVA LIVE Phase 1 turns the gamertag you already have into a real online
identity — the **identity crossover** — and adds accounts, friends, presence,
and 1:1 messaging, all inside the KOVA LIVE ecosystem. Friends are KOVA-native:
you add people by gamertag inside KOVA. There is no friend import from any
store. Everything stays local-first: the local profile keeps working with zero
account, and LIVE is opt-in — nothing about KOVA changes for a player who
never signs in.

## 0.1 Note on the plan file (read this first)

`V1.2.0_PLAN.md` §9 pillar 2, as written, describes a friends list across
every store. Dre clarified the same day (2026-11-14) that the crossover is
the IDENTITY crossover — the gamertag + local profile from v1.1.1 crosses
over to become your LIVE tag — and friends live inside KOVA LIVE only.
Dre ordered the plan file left untouched, so this spec — not the plan file's
§9 pillar text — is the authority for the Phase 1 design. Friends are KOVA-native,
by gamertag, inside KOVA LIVE. No Steam / Epic / GOG / itch friend import is
specced anywhere in this document.

## 0.2 The six pillars (confirmed by Dre, 2026-11-14)

1. **Free online, no paywall.** Never charge for online play, friends, or
   parties. Phase 1 has no paid tier anywhere.
2. **One friends list — inside KOVA LIVE.** Friends live in the KOVA LIVE
   ecosystem only: add by gamertag, see presence, message — all KOVA-native.
   (Clarified 2026-11-14: the crossover is identity, not store import.)
3. **Your data stays yours.** Local-first: profile, playtime, and library live
   on your machine; you choose what LIVE sees. No ad profile, no selling
   attention.
4. **Parties + voice built in.** Phase 2, not Phase 1.
5. **Achievements everywhere.** Phase 2, not Phase 1.
6. **Dev-friendly by default.** The store and LIVE are one system; unchanged
   by Phase 1.

## 0.3 Phase 1 scope (from the plan)

Accounts, friends, presence (online / in-game / what you're playing),
messaging (1:1 direct messages). Section 11 lists everything explicitly NOT
in Phase 1.

---

## 1. Accounts

### 1.1 What a KOVA account is

A KOVA account is the online half of the profile the player already has. It
holds exactly four things: an email (private, never shown to anyone), a
gamertag (the public handle — the LIVE tag), a password (hashed server-side by
the auth provider; KOVA never sees or stores it), and the player's chosen
public profile (avatar, bio, banner — synced copies of the local profile,
§2).

### 1.2 Creation

- **Where:** Profile view (both shells) → "Join KOVA LIVE" → create-account
  flow. Also offered once, dismissibly, in the beta Profile's LIVE note, which
  today reads "Nothing here is online yet."
- **Steps:** (1) email address, (2) password (minimum 8 characters),
  (3) confirm the gamertag — the local gamertag is pre-filled and claimed if
  it is free (§2.2), (4) verify the email by clicking a link sent to it.
  The account cannot add friends or message until the email is verified;
  sign-in before verification shows a "check your inbox" state with a
  resend button.
- **Sign-in methods in Phase 1:** email + password only. No social sign-in
  (no "sign in with Steam / Epic / Google") in Phase 1 — each one is a
  separate integration and a separate dependency on a store's goodwill.
- **No paywall:** creating an account, signing in, friends, presence, and
  messaging are all free, forever, with no tier, trial, or limit that a
  payment would lift.

### 1.3 What stays local vs what the service holds

| Data | Lives where | Notes |
| --- | --- | --- |
| Library (scanned games) | Local only | Never uploaded. |
| Per-game profiles (perf, rating, notes, cover art) | Local only | Never uploaded. |
| Playtime history (totals, sessions) | Local only | Only the *current* session is shared, as presence (§4), and only while the user allows it. |
| Journal, shelves, save backups, Kids settings, wishlist | Local only | Never uploaded. |
| Gamertag, avatar, bio, banner | Local + server copy | The server copy is what friends see. The user edits it in the app; the app syncs it. |
| Email | Server only | Never shown to other players, never written to `kova-state.json`. |
| Friends graph, friend requests, blocks | Server | The source of truth; the app caches it locally for offline display. |
| Presence | Server (ephemeral) | Online / in-game state, live only; no presence history is kept. |
| Messages | Server + local cache | §5. |

### 1.4 Sign-in / sign-out on the app

- **Sign-in** is per machine: the app keeps a session token in the OS
  credential store (macOS Keychain on Mac, Credential Manager on Windows —
  never in `kova-state.json`, never in plaintext). Signing in on a second
  machine is a fresh sign-in; sessions are independent.
- **Sign-out** clears the token and the local LIVE cache (friends list,
  messages) from that machine. The local profile (gamertag, avatar, bio,
  banner in `kova-state.json`) is untouched — signing out of LIVE never
  deletes or changes the local profile.
- **Offline / signed-out behavior:** the app works exactly as it does today.
  Friends, presence, and messaging simply show their signed-out state
  ("Sign in to KOVA LIVE to see friends"). No feature the player already has
  degrades, and the app never blocks on a LIVE call — every LIVE request has
  a short timeout and fails to the local state.

### 1.5 The local profile keeps working with zero account

This is the load-bearing promise of the whole phase. A player who never
creates an account gets the exact KOVA they have today: local gamertag,
avatar, bio, banner, wishlist, shelves, milestones, journal — all of it, with
no account prompt that can't be dismissed and no feature held back. LIVE is
an addition, not a gate.

---

## 2. The identity crossover

### 2.1 The tag you already have is your LIVE tag

Since v1.1.1 the player has a gamertag in `GamerProfile` (max 32 characters,
trimmed; avatar is `""` | `"builtin:<id>"` | a data URL capped at ~200 KB;
bio max 160 characters; banner the same shape as the avatar). Since v1.2.0
both shells label it "Your KOVA LIVE tag." Phase 1 makes that label true: at
account creation, the local gamertag is offered as the LIVE tag, and the
local avatar / bio / banner are offered as the public profile. The player
confirms or edits them once, and from then on the local profile and the LIVE
profile are the same identity, edited in one place (the app's Profile view)
and synced to the server.

### 2.2 Uniqueness — the one place the local tag and the LIVE tag differ

Local gamertags are not unique: two machines can both have the tag "Dre."
LIVE tags must be unique, because they are how friends find each other.
Rules:

- LIVE tags are unique **case-insensitively**: "Dre" and "dre" are the same
  tag. The player keeps their capitalization as the display form.
- Allowed: 3–32 characters, letters, numbers, spaces, underscore, hyphen.
  No leading or trailing space (trimmed on the way in, as today). Tags under
  3 characters are rejected at claim time.
- **Claim flow:** at account creation the app checks the local tag. If it is
  free, it is claimed as-is. If it is taken, the app says so plainly and
  suggests variants (e.g. `Dre`, `Dre_`, `Dre-1`) — the player picks one.
  The local gamertag is NOT changed by this: if the player claims `Dre_`
  online, their local tag can stay `Dre`, and the Profile view shows both
  ("Local tag: Dre · LIVE tag: Dre_") until they choose to match them.
- **First come, first served.** No reservations, no auctions, no premium
  tags — pillar 1 forbids charging for identity.
- **Tag changes after creation:** allowed, once every 30 days, through the
  same availability check. The old tag is held for 30 days before anyone
  else can claim it (prevents impersonation right after a change). See open
  question 6.

### 2.3 Profile sync rules

- The app is the editor: avatar, bio, banner, and tag changes are made in
  the Profile view and pushed to the server on save. A failed push (offline)
  keeps the local change and retries on the next sign-in / reconnect; the
  local profile is never rolled back by a server failure.
- The server copy is what friends see. Nothing else about the local profile
  is uploaded — no library, no playtime history, no journal.
- Built-in avatars (`"builtin:<id>"`) sync as the id, not as image data.
  Uploaded avatars sync as the same downscaled data URL the app already
  stores (~200 KB cap). No new image pipeline is needed.

---

## 3. Friends

### 3.1 Adding friends — by gamertag, inside KOVA LIVE

- **Search:** the Friends view has a search box. Phase 1 search is
  **exact-match on gamertag** (case-insensitive): type the tag, get the
  profile if it exists. There is no browse, no suggestions, and no
  partial-match discovery in Phase 1 — exact-match keeps the surface small
  and makes spam-harvesting impractical.
- **Request flow:** search → view the profile card (tag, avatar, bio) →
  "Add friend" → the other player gets a pending request. They accept or
  decline. Until accepted, neither side sees the other's presence or can
  message. A declined request disappears (no notification to the sender
  beyond "no response" — the request simply stops pending). A player can
  re-request after a decline, but a blocked player cannot request at all.
- **Both sides must hold KOVA accounts.** There is no way to add someone who
  does not have a KOVA account, and no way to import a friend from anywhere
  else. That is the design, not a limitation to work around later without
  Dre's explicit re-decision.
- **Friend cap:** 500 friends per account (generous for a real player,
  high enough that no legitimate user hits it, low enough to bound abuse).
  The cap is a server rule; the exact number is tunable at build time.

### 3.2 Removing and blocking

- **Remove friend:** one tap, no confirmation dialog beyond the tap itself;
  the edge is deleted on both sides immediately. The removed player is not
  notified. Either side can re-add later.
- **Block:** removes the friendship (if any) and prevents all contact:
  the blocked player cannot send a friend request, cannot see your presence,
  cannot message you, and your profile does not appear in their exact-match
  search (it reads as "no player with that tag"). Blocking is silent — the
  blocked player is never told. Unblock restores search visibility only;
  it does not restore the friendship.
- **Blocked list** is visible in Settings → KOVA LIVE, with an unblock
  action per entry.

### 3.3 Friends list UI (classic + beta shells)

- A **Friends view** in both shells, reached from the sidebar/nav alongside
  Home / Library / Store / Profile. Contents, top to bottom: pending
  requests (incoming first, with Accept / Decline), then the friend list.
- Each friend row: avatar, gamertag, presence line (§4), and a message
  button. Rows sort online-first, then alphabetically. Offline friends stay
  listed, greyed, at the bottom.
- The header gamertag chip (classic) and Profile view (both shells) gain a
  LIVE status line: signed in as `<tag>` / not signed in, plus a pending
  request count badge when requests are waiting.
- The design-taste skill gate applies at build time (the beta shell's
  screens go through `inspect.mjs --app`, 0 FAIL, as in v1.2.0 §11).

---

## 4. Presence

### 4.1 States

| State | What friends see | When |
| --- | --- | --- |
| Online | "Online" | App open and signed in, no game running. |
| In game | "Playing \<game\>" | A game KOVA launched is running (§4.2). |
| Offline | "Offline" / last-seen hidden | App closed, signed out, or no heartbeat for 2 minutes. |
| Appear offline | "Offline" to everyone | User-set; the user still sees everyone else normally. |

There is no "last seen at <time>" in Phase 1 — offline is just offline.
Presence history is not stored.

### 4.2 Driven by the existing playtime watcher

KOVA already knows when you launch a game: v1.2.0 §2 added a playtime
watcher (direct spawns tracked via the child handle, `.app` launches via
`ps` polling) and an `ActiveSession` slot (`game_key`, `started_at`) exposed
to the frontend as `get_active_session`. Presence reuses it directly:

- When the watcher records a launch, the LIVE client publishes "in game"
  with the game's display name (resolved from the library the same way the
  session timer does).
- When the watcher records the session's end, presence returns to "Online."
- The watcher's honest limits carry over unchanged: a game already running
  before KOVA launched it gets no session (presence stays "Online" — never
  a guessed game); if KOVA quits mid-session, the session is lost and
  presence goes offline with the app; no double-counting.
- Presence is published only while the user is signed in and has not
  disabled it (§4.3). The game name is the only game information ever sent
  — no playtime totals, no library contents, no paths.

### 4.3 Privacy controls

- **Appear offline** — a toggle in the Friends view header and in Settings →
  KOVA LIVE. While on, friends see "Offline." The user still sees friends'
  presence and can still message normally.
- **Hide what I'm playing** — a toggle in Settings → KOVA LIVE. While on,
  friends see "Online" even mid-game; the game name is never sent.
- **Defaults:** both toggles OFF at first sign-in (presence fully on),
  because presence is the point of Phase 1 — but both toggles are presented
  in the sign-up completion screen, not buried, so the choice is made with
  eyes open. See open question 3.
- **Per-friend presence hiding is NOT in Phase 1.** The controls are global
  (appear offline to everyone, or hide your game from everyone). Granular
  per-friend visibility is a Phase 2 consideration.

### 4.4 How presence travels

The signed-in app holds one realtime connection to the LIVE service and
sends a heartbeat while open. Friends' presence updates arrive over that
connection (no polling). If the connection drops, the app reconnects with
backoff; if the server misses heartbeats for 2 minutes, it marks the player
offline. When the app is closed cleanly it sends an offline update on exit
(best-effort — the heartbeat timeout is the real guarantee).

---

## 5. Messaging

### 5.1 Scope: 1:1 direct messages only

Phase 1 messaging is one-to-one DMs between friends. Group chats, party
chat, and voice are Phase 2. You can only message someone you are friends
with, and only while neither side has blocked the other. There is no way to
message a stranger — this is deliberate, and it is most of the moderation
strategy (§5.4).

### 5.2 Sending, receiving, history

- **Sending:** from a friend row ("Message") or from an open conversation.
  Text only in Phase 1 — no images, files, or links previews. Message max
  length 2,000 characters (the same cap the game journal already uses).
- **Delivery:** messages go to the server, which delivers them live to the
  recipient over their realtime connection if they are online, and stores
  them for pickup if they are not. On sign-in / reconnect, the app fetches
  any messages it missed. There is no read receipt in Phase 1 (sent, not
  seen — one less thing to argue about).
- **History storage:** the server keeps the last 500 messages per
  conversation; older messages are pruned server-side. The app keeps a
  local cache of the same conversations in a separate file,
  `kova-live-messages.json` in the app data dir — NOT inside
  `kova-state.json`, so state export / backup stays small and portable and
  messages never leak into a shared state file. Signing out clears the
  local message cache on that machine; the server copy remains until the
  account is deleted (§8.4).
- **Rate limit:** the server caps each account at a modest send rate
  (recommended starting point: 30 messages per minute per account; exact
  number tunable at build time). Over the cap, sends are rejected with a
  plain "slow down" error, not a ban.

### 5.3 What the conversation UI looks like

A conversation opens as a panel from the Friends view (both shells): message
history oldest-to-newest, a text box, a send button. No typing indicator in
Phase 1. Conversations are listed in the Friends view under a "Messages"
section, most-recent-first, with an unread count badge. Unread state is
tracked locally (last-read marker per conversation, kept in the local
message cache file).

### 5.4 Moderation basics (honest about what a small team can run)

- **Block** (§3.2) is the primary tool: it ends all contact immediately,
  silently, with no review needed. Most bad behavior ends at block.
- **Report:** any message or profile can be reported (one tap, optional
  short note). Reports go to a review queue read by the Avok team — the same
  two-person review rule as the store. There is no automated moderation, no
  keyword filter, and no auto-ban in Phase 1: a small team cannot run
  automated moderation honestly, and a bad auto-filter is worse than none.
- **What happens after a report:** a human reads it. Outcomes: nothing (no
  violation), a warning to the reported account (delivered in-app on next
  sign-in), or an account suspension / ban (server-side; the banned account
  cannot sign in, and its tag is held, not freed). There is no appeal flow
  in Phase 1 — a banned player can contact the review inbox (the store
  review address) and a human decides.
- **What KOVA does NOT do:** no message content scanning, no proactive
  monitoring of conversations, no reporting to third parties. Reports are
  the only way a conversation reaches a human.


---

## 6. Hosting + backend — the decision Dre needs

Phase 1 needs a real backend for the first time in KOVA's history: accounts,
a friends graph, live presence, and message delivery. The KOVA site and the
OTA feed are static files on Wasmer — Wasmer cannot host this; a realtime
service needs an always-on backend with a database and websocket connections.

### 6.1 What the backend must provide

Auth (email + password, verification emails, session tokens), a Postgres
(or equivalent) database for accounts / friends / messages / reports, a
realtime channel for presence + message delivery, and file-free operation
(no user file uploads in Phase 1 — avatars sync as data URLs already capped
at ~200 KB, stored as text in the database). No game servers, no voice
servers, no matchmaking in Phase 1.

### 6.2 The options (prices verified October–November 2026; re-check before committing)

| Option | What it is | Cost picture | Fit |
| --- | --- | --- | --- |
| **Supabase (managed)** | Auth + Postgres + Realtime + Storage in one managed service, open-source. | Free: $0 (500 MB DB, 50k monthly active users, 5 GB egress, 200 realtime connections — but projects **pause after 1 week idle**, which would take LIVE down). Pro: from **$25/mo** (8 GB DB, 100k MAU, 250 GB egress, 500 realtime connections, 7-day backups, never pauses; overages: $0.125/GB disk, $0.00325/MAU, $0.09/GB egress, $10 per 1,000 extra realtime connections; spend cap on by default). | Best fit. One service covers every Phase 1 need; no server to patch. |
| **Firebase (managed)** | Google's Auth + Firestore + Realtime Database. | Spark: $0 (Auth 50k MAU; Firestore 1 GiB stored, 50k reads / 20k writes / 20k deletes **per day**; no Cloud Functions, no Cloud Storage since Feb 2026). Blaze: pay-as-you-go, no base fee, same free quotas (Firestore reads ~$0.03–0.06 per 100k, writes ~$0.09–0.18 per 100k depending on region; Auth $0.0055/MAU past 50k). | Workable, but the **daily** Firestore quotas are a real risk for a presence + chat app — one busy day can burn the day's reads before the month is out, and the service shuts off instead of billing. |
| **Render (PaaS, already in Dre's stack)** | Raw app hosting: a web service + managed Postgres. Dre already uses Render (NEA1 fallback). | Free web service sleeps after 15 min idle; free Postgres is time-limited and deleted. Paid floor: Starter web service $7/mo + Basic-256mb Postgres $6/mo ≈ **$13/mo**. | Cheapest managed floor, but Render provides **no auth and no realtime** — auth, presence, and message delivery would all be hand-built and hand-maintained by the team. More code, more risk, for a $12/mo saving over Supabase Pro. |
| **Hetzner VPS (self-hosted)** | A rented Linux box; the team runs everything (Postgres, auth service, realtime, backups, TLS, patching). | CX23: **€5.99/mo (~$7.09, checked 10 Nov 2026)** — 2 vCPU, 4 GB RAM, 40 GB disk, 20 TB traffic. | Cheapest cash cost, highest ops burden. The server bill is the small part — the real cost is the team's time keeping it patched, backed up, and up. No managed auth, no managed realtime, no automatic backups. |
| **Modal (serverless, already in Dre's stack)** | Scale-to-zero containers; Dre uses it for NEA1 inference. | Pay per use; scale-to-zero. | **Not a fit for LIVE's core.** Presence needs persistent websocket connections; a platform that sleeps containers when idle cannot hold them. Could host stateless API endpoints, but not the realtime heart. |
| **Wasmer (current KOVA site host)** | Static hosting. | — | **Cannot host this.** Static files only; no database, no websockets, no auth. |

### 6.3 RECOMMENDATION: Supabase — Free while building, Pro at launch

**Build and test on Supabase Free ($0), and go live on Supabase Pro at
$25/month.** Reasons: it is the only option where one managed service covers
auth, the database, and realtime presence with no server for the team to
patch; the price is a flat, predictable $25/mo at launch scale (the $10/mo
compute credit covers the default instance, so $25 is the whole bill until
usage grows past the included quotas); the spend cap is on by default, so a
usage spike pauses service instead of producing a surprise bill; it is
open-source with a self-host exit ramp (§6.4); and Dre already has a
Supabase account (signed up 2026-11-04 for OpenStudio). The Free tier's
auto-pause makes it unusable for production — that is exactly why the
recommendation is Pro at launch, not Free forever.

**Honest cost picture.** $0 while building (Free tier, dev + staging
projects). $25/mo from the day LIVE goes live. The bill stays $25/mo until
the app outgrows the included quotas — 100k monthly active users, 8 GB of
database, 250 GB egress, 500 simultaneous realtime connections — at which
point the overage rates above apply, and the team will see it coming in the
dashboard months before it bites. The first thing likely to bind is the
500-realtime-connection limit if KOVA ever has 500+ players online at once;
each extra 1,000 connections is $10/mo. Nothing in Phase 1 needs the $599/mo
Team plan (that buys compliance reports and SSO, not capacity).

**What Dre would be signing up for.** A Supabase organization on the Pro
plan (card on file, $25/mo, cancel anytime), one production project, and —
separately — the account that owns it should be Dre's (or a shared Avok
account he controls), the same custody rule as the signing key: the LIVE
backend is a release root for the social service, and losing access to it
strands every player. No sign-up happens under this spec — the sign-up is a
separate step after Dre approves the spec, and it is his call which account
holds it.

### 6.4 Exit ramp

If Supabase ever stops fitting — price, policy, or scale — the backend is
plain Postgres + standard auth + websockets, all open-source. The migration
path is: self-host Supabase (or a small Rust service + Postgres) on a VPS
(Hetzner CX23-class, ~$7/mo) with the same schema. Nothing in the Phase 1
client design depends on a Supabase-only feature that cannot be re-implemented.
Data export is a Postgres dump — the team owns the data, not the vendor.

---

## 7. Security + privacy

### 7.1 Auth approach

Email + password via the managed auth provider (Supabase Auth under the
recommendation). Passwords are hashed server-side by the provider — KOVA
never handles a plaintext password after the sign-up / sign-in form submits
it over TLS, and no password or hash is ever stored in the app or in
`kova-state.json`. Sessions use short-lived access tokens + refresh tokens;
the refresh token lives in the OS credential store (§1.4). All client ↔
server traffic is TLS. There is no "remember me forever" — refresh tokens
expire and the player signs in again (the provider's default rotation
applies; exact lifetimes are provider configuration, set at build time).

### 7.2 What the server stores

Accounts (email, tag, password hash, verification state, public profile
copy), friend edges + pending requests + blocks, presence (ephemeral —
current state only, no history), messages (last 500 per conversation, §5.2),
reports (reporter, reported, message/profile reference, note, timestamp,
resolution), and minimal operational logs (sign-ins, errors — kept 7 days
under Supabase Pro's log retention). That is all. No library, no playtime
history, no game paths, no machine identifiers, no analytics events, no ad
profile — ever.

### 7.3 What the user controls

- Everything public about them (tag, avatar, bio, banner) is editable in
  the app and deletable by clearing it.
- Presence: appear offline, hide-what-I'm-playing (§4.3).
- Contact: block (§3.2) ends all contact from a player, immediately.
- Messages: a player can delete their own sent messages (removed from the
  conversation for both sides).
- Account: full deletion (§7.4).

### 7.4 Account deletion

In Settings → KOVA LIVE → "Delete my KOVA LIVE account." Two-step
confirmation (type the gamertag to confirm — no accidental taps). On
deletion the server removes: the account, the email, the public profile,
all friend edges and pending requests, all blocks in both directions, all
messages the user sent (removed from both sides of each conversation), and
all reports they filed. The gamertag is held for 30 days, then freed for
anyone to claim (see open question 6). The local profile on the machine is
untouched — deletion removes the online identity, not the local KOVA
profile. Deletion is irreversible and immediate on the server side; there
is no "deleted accounts" retention beyond the 30-day tag hold.

### 7.5 Data retention summary

Presence: live only, no history. Messages: last 500 per conversation,
pruned automatically. Operational logs: 7 days. Deleted accounts: removed
immediately except the 30-day tag hold. Backups (Supabase Pro, 7 days) may
transiently contain deleted data until they roll off — stated here so the
claim is honest: "deleted" means gone from the live service immediately and
from backups within 7 days.

---

## 8. Client architecture (what the build touches)

- **New state fields** (all `#[serde(default)]`, same rule as every v1.2.0
  addition — an old state file loads clean): a `live` section on `KovaState`
  holding the signed-in tag (or none), the two privacy toggles, and the
  cached friends list. The session token does NOT go in state (§1.4).
  Messages live in the separate `kova-live-messages.json` file (§5.2).
- **New dependencies:** the app crate today has no HTTP client (its only
  network use is the updater plugin). Phase 1 adds an HTTP client and a
  websocket client to `app/src-tauri` — the exact crates are a build
  decision, but the dependency is real and must be in the build plan, not
  discovered mid-build. No new `kova-core` dependencies are expected: LIVE
  state types live in `kova-core` (pure, unit-tested, same pattern as
  `GamerProfile`), and all network code lives in the app crate.
- **New Tauri commands** (same pattern as `set_gamer_profile` /
  `get_active_session`): sign-up, sign-in, sign-out, delete account,
  search-by-tag, send/accept/decline friend request, remove friend,
  block/unblock, set presence toggles, send message, fetch conversations,
  report. Exact command names are set at build time.
- **Presence publisher:** a small Rust-side task that watches the existing
  `ActiveSession` slot and the heartbeat timer, and publishes presence
  changes. It reuses the playtime watcher — it does not duplicate it.
- **Offline-first:** every LIVE command fails soft. If the service is
  unreachable, the UI shows the last cached friends/presence with a
  "couldn't reach KOVA LIVE" note, and messaging queues nothing — a failed
  send tells the player plainly and keeps their draft in the text box.
- **No changes to:** the scanners, the library, the store, the updater, the
  OTA feed, the beta program mechanics, or the Kids shelf (except §11's note
  that LIVE sign-in is disabled on the Kids shelf).

---

## 9. UI surfaces (both shells)

| Surface | Classic shell | Beta shell |
| --- | --- | --- |
| Friends view | New view in the sidebar nav | New screen in the beta nav |
| Join / sign-in | Profile view → "Join KOVA LIVE" | Profile screen → "Join KOVA LIVE" |
| Presence toggles | Settings → KOVA LIVE section | Settings screen → KOVA LIVE section |
| Blocked list + delete account | Settings → KOVA LIVE section | Settings screen → KOVA LIVE section |
| Pending request badge | Header gamertag chip + Friends nav item | Profile / Friends nav badge |
| Conversation panel | Opens from a friend row | Opens from a friend row |

Copy rules: no personal names in user-facing LIVE copy (per Dre's 1.3.2
direction — "the Avok team," never "Melo and Dre"). The beta Profile's
"Nothing here is online yet" note is replaced by the live state once the
player signs in, and by the join prompt while they are signed out.

---

## 10. What is explicitly NOT in Phase 1

- **Parties + voice** (Phase 2).
- **Activity feeds** (Phase 2).
- **Achievements** (Phase 2).
- **Matchmaking** (Phase 3).
- **Cloud saves** (Phase 3).
- **Group chats / party chat** (Phase 2).
- **Cross-store friend import** — no Steam / Epic / GOG / itch friend
  import, in any form. Friends are KOVA-native by design (Dre's clarified
  intent, 2026-11-14; see §0.1).
- **Social sign-in** (no "sign in with Steam / Epic / Google").
- **Message attachments** (no images, files, or link previews).
- **Read receipts, typing indicators, per-friend presence controls.**
- **Automated moderation** (no keyword filters, no auto-bans).
- **LIVE sign-in on the Kids shelf** — the Kids profile cannot create or
  sign into a LIVE account in Phase 1 (see open question 7).
- **A public web presence for LIVE** (no web friends list, no web chat) —
  LIVE lives in the KOVA app only in Phase 1.

---

## 11. Open questions for Dre (recommendation attached to each)

**DECIDED 2026-11-14 ~16:23 CT (Dre): yes on all eight, with #1 amended —
Free tier until we can pay for Pro; the Pro ($25/mo) decision comes when
we can afford it, not at a fixed date. No hosting spend is approved yet.**

1. **Hosting — Supabase Pro at $25/mo from launch, Free ($0) while
   building?** Recommendation: **yes.** One managed service for auth +
   database + realtime, flat predictable price, open-source exit ramp. The
   alternative (Render at ~$13/mo) saves $12/mo and costs the team a
   hand-built auth + realtime layer.
2. **Gamertag uniqueness — LIVE tags unique, first-come-first-served, local
   tag claimed if free?** Recommendation: **yes.** It is the only way
   add-by-tag works, and the claim flow keeps the crossover smooth.
3. **Presence default — show what you're playing ON at first sign-in, with
   both privacy toggles shown during sign-up?** Recommendation: **yes.**
   Presence is the point of the phase; the toggles are presented, not
   buried, so the choice is informed.
4. **One tag only — no separate display name in Phase 1 (your tag is your
   name)?** Recommendation: **yes.** Simpler, and the tag IS the identity.
   A separate display name can come later if players ask for it.
5. **Message history — last 500 messages per conversation, server-side
   pruning?** Recommendation: **yes.** Generous for real use, bounded for
   the database.
6. **Tag hold after deletion or change — 30 days before anyone else can
   claim the tag?** Recommendation: **yes, 30 days.** Prevents impersonation
   right after someone leaves or renames.
7. **Kids shelf + age — LIVE sign-in disabled on the Kids shelf, accounts
   13+?** Recommendation: **yes.** The Kids shelf is a locked-down profile
   for Ameria; LIVE (friends, DMs with strangers' tags) does not belong on
   it. 13+ matches standard practice for an account with messaging.
8. **Reports — reviewed by the Avok team, manually, same as the store?**
   Recommendation: **yes.** Two-person human review, no automation in
   Phase 1.

---

## 12. Sources (prices and limits verified; re-check before committing)

- Supabase pricing (Free / Pro / Team, quotas, overage rates, auto-pause):
  multiple 2026 pricing reviews cross-checked against supabase.com/pricing,
  latest read 29 Oct 2026.
- Firebase Spark / Blaze quotas and rates: firebase.google.com/pricing,
  last checked 28 Oct 2026 (incl. the 3 Feb 2026 Cloud Storage change).
- Render workspace / compute / Postgres pricing: render.com/pricing via
  2026 reviews, latest Oct 2026 (free Postgres expiry: 30 days per most
  sources).
- Hetzner CX23 €5.99/mo (~$7.09): Hetzner price tables, checked 10 Nov
  2026 (post-June-2026 repricing).
- KOVA code facts (state model, gamertag/avatar caps, playtime watcher,
  existing LIVE copy): read from `~/workspace/kova/v1/` on 2026-11-14 —
  `crates/kova-core/src/state.rs`, `app/src-tauri/src/lib.rs`,
  `app/src/main.js`, `app/src/beta/beta.js`, `V1.2.0_PLAN.md` §9.
