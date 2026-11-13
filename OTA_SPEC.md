# KOVA over-the-air updates + branded DMG installer — CONFIRMED

> **CONFIRMED by Dre 2026-11-12 ("Ok confirm") — build authorized.**
> Both recommendations accepted: GitHub repo + Actions (§8), and
> prompt-first installs (§5). "fmg" confirmed as a misspelling of DMG.

Date: 2026-11-12
Status: draft for Dre's review
Depends on: KOVA 1.0.0 (six slices proven on Dre's Mac; Mac rebuild
underway Nov 12). OTA ships in the release AFTER 1.0.0 — see §7.

## 1. What this is

Two halves of one order (Dre, 2026-11-12):

1. **OTA updates for KOVA.** The app checks for a new version, downloads
   it, verifies it, and installs it on restart — no more manual rebuild
   and .app swap for every release. This is also the standing company
   program: handbook rule G6 makes OTA mandatory for company products,
   and KOVA is one.
2. **A branded DMG installer for Mac.** `tauri build` already produces a
   DMG alongside the .app (the Oct 25 build left its intermediate in the
   bundle dir), but it is the plain Tauri default — app icon plus an
   Applications link, no background, no layout. This half gives the DMG
   the Avok/KOVA treatment: a designed background, a laid-out window,
   the app's own icon — the way the NeuralAI Workspace DMG is done.

The two halves meet at the first OTA-capable release: Dre installs it
once from the new branded DMG, and every release after that arrives
over the air (§7).

Confirmed by Dre 2026-11-12: "fmg" was a misspelling of DMG (the
Mac disk image). The DMG half of this spec stands as written.

## 2. The family pattern this follows

Both OTA systems already live in the portfolio work the same way, and
KOVA follows them:

- **Manifest-driven.** One small JSON file on a Wasmer site names the
  latest version, the payload URL, and its checksum. The app polls the
  manifest; the manifest is the only thing the app trusts to say a new
  version exists.
- **Wasmer-hosted.** NeuralAI Workspace serves its manifest + payloads
  from neuralai.wasmer.app/updates/workspace/; Avok Engine from
  avokinteractive.wasmer.app/updates/avok-engine/. KOVA's feed lives
  at kova-99837.wasmer.app/updates/kova/ — same pattern, KOVA's own
  site.
- **Verified before install.** NeuralAI checks SHA-256; Avok Engine
  checks the manifest's sha256 + size. KOVA verifies a cryptographic
  signature (§3) — stronger than a checksum, and the Tauri-native way.
- **Staged, never in place.** The running app is never touched. The new
  version downloads and verifies first, then installs on restart.
- **Checked on a rhythm.** Both family updaters check at startup and
  every 6 hours, plus on demand. KOVA does the same.

What KOVA does NOT copy: neither family updater is a Tauri app, so
neither uses Tauri's own updater. KOVA does (§3) — it is the maintained
path for this stack, and it handles signing, the feed format, and the
install/restart flow instead of hand-rolled code doing it worse.

## 3. OTA mechanism — tauri-plugin-updater 2.x

KOVA is Tauri v2, so the updater is the official `tauri-plugin-updater`
2.x plugin — the same plugin pattern KOVA already uses for opener and
global-shortcut. No new architecture, one more plugin.

**What changes in the app:**

- `app/src-tauri/Cargo.toml`: add `tauri-plugin-updater = "2"`.
- `app/src-tauri/src/lib.rs`: one more `.plugin(...)` line in `run()`,
  next to opener and global-shortcut — plus three Rust commands
  (`check_update`, `install_update`, `restart_app`) that the Settings
  UI calls through the normal `invoke()` path. The updater is driven
  from Rust, not from the frontend's JS: KOVA's frontend is plain JS
  with no bundler, so the updater's npm package has no import path and
  no npm dependency is added. No updater capability permissions are
  needed in v1 — Rust-internal updater calls do not cross the
  capability ACL (only frontend-invoked plugin commands do).
- `app/src-tauri/tauri.conf.json`: a `plugins.updater` block with the
  feed endpoint and the public key (§4).
- `app/src/main.js` + Settings: an Updates card — current version,
  "Check for updates" button, last-check time, and the install prompt
  (§5).

**The feed.** One JSON file at
`https://kova-99837.wasmer.app/updates/kova/version.json`, in the
Tauri updater format: `version`, `notes`, and a `platforms` map with
one entry per platform (`darwin-aarch64`, later `windows-x86_64`),
each carrying a `url` and a `signature`. The feed is published with
each release, alongside the artifacts — the same release step that
puts the DMG on the site.

**The check rhythm.** On launch, every 6 hours while running, and on
demand from Settings. A failed check (offline, feed down) is silent
in the UI and recorded in the status line — it never errors in Dre's
face, and it never blocks launching a game.

## 4. Signing — the trust root

The updater verifies every payload against a signature made with a
private key whose public half is baked into the app. A payload that
fails verification is rejected before install — a tampered or
wrong-version file can never reach the installed app.

- **Keypair:** generated once by Dre on his Mac with the Tauri CLI signer
  (`npm run tauri signer generate -- -w ~/.tauri/kova.key`, run from
  `app/`). One keypair for KOVA, all platforms.
- **Private key:** lives on Dre's Mac (`~/.tauri/kova.key`, 0600) and in
  the repo's GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), both set by Dre's own hands. It
  never touches the VM, never appears in chat or memory, and never enters
  the repo (`.gitignore` blocks `*.key`). If it is ever exposed, the
  keypair is rotated and the public key in the app is updated in the
  next release.
- **Public key:** pasted by Dre to Melo (it is public by design — it
  verifies, it cannot sign) and embedded in `tauri.conf.json`
  (`plugins.updater.pubkey`). The 1.1.0 build waits on the real pubkey:
  a wrong or placeholder key baked into 1.1.0 would break every future
  update, so the keypair step comes before the build, not after.

This is the one new secret the feature introduces, and it is guarded
like the others (handbook rule U7).

## 5. Update experience — prompt first, never silent

KOVA is Dre's machine and his product. Updates never install without
his go:

1. The app finds a newer version in the feed. A quiet badge appears
   in Settings (and nowhere else — no pop-up over a game).
2. Dre opens Settings and sees the version, the release notes, and an
   Install button. He can also dismiss it; the badge waits.
3. Install downloads the payload with a progress line, verifies the
   signature, and stages it.
4. The app asks to restart to finish. On restart, the new version is
   live. If anything fails at any step, the installed app is untouched
   and Settings says plainly what failed.

Auto-install on restart (no prompt) is NOT proposed for v1. It can be
a later decision, once OTA has proven itself over real hops.

## 6. The branded DMG

**Current state (verified Nov 12).** Dre's Mac builds already run the
DMG path: the Oct 25 build left a 37.8 MB read-write DMG intermediate
in `target/release/bundle/macos/`, and today's 1.0.0 build created the
`bundle/dmg/` staging dir. The DMG that ships today is Tauri's plain
default. Nothing about the build changes — only what the DMG looks
like when it opens.

**The design.** One designed background for the DMG window: the Avok
mark and KOVA identity, amber product accent (the documented family
choice — "molten amber (KOVA)") on the near-black ground, the KOVA
app icon and the Applications link laid out with room to breathe.
No text baked into the art that a version bump would stale — the
version lives in the DMG filename, not the picture.

**Build route (two options, decided at build time):**

- **First choice: Tauri bundler DMG config.** Tauri v2's bundler
  takes DMG presentation in `tauri.conf.json` (`bundle.macOS.dmg`:
  background image, window size and position, icon positions). If it
  covers the design, the branded DMG comes out of `tauri build`
  directly — no extra tooling, no extra step for Dre.
- **Fallback: the proven custom builder.** The NeuralAI Workspace DMG
  is built with a custom HFS+ builder in
  `~/workspace/neuralai-workspace-dmg/` (`mk_hfsplus.py`, `BUILD.sh`,
  `build_dsstore.py`, `build_preview.py`) — it produced the 1.0.0 /
  1.0.1 / 1.0.2 DMGs with designed backgrounds and a simulated Finder
  preview. If the bundler's options prove too limited, that builder
  is adapted for KOVA. Its hard-won lessons carry over verbatim:
  Finder shows the background at 1x with no scaling (render at the
  exact content size), and the window is always simulated and checked
  by eye before the DMG ships.

**Where the DMG goes.** The DMG is the first-install artifact. It is
published on the KOVA site next to the update feed (a download button
appears on the site when a signed build exists to ship — the public
release the roadmap already owes). Dre installs from it once; OTA
takes it from there.

## 7. Sequencing — the honest bootstrap

An updater can only update an app that already has the updater. KOVA
1.0.0 (built Nov 12) does not have it. So:

1. **v1.1.0** carries the updater + the branded DMG. Dre installs it
   manually from the DMG, the same way he installs today. This is the
   last manual install.
2. **v1.1.1+** arrive over the air. The first real OTA hop (1.1.0 →
   1.1.1) is the proof the feature works, verified on Dre's Mac
   (§9) — not assumed from a passing build.

Nothing in this spec pretends 1.0.0 can update itself.

## 8. Windows — blocked on the installer decision, with a recommendation

The Tauri updater replaces an *installed* app. On Windows that means
an NSIS or MSI install — the bare `.exe` KOVA has today has no install
record for an updater to replace, so Windows OTA cannot ship on the
bare exe. Windows OTA therefore waits on the installer decision Dre
already owns (GitHub repo + Actions vs. staying with the bare exe).

**Recommendation (prepared decision, per U18): GitHub repo + Actions.**
One decision closes four open items at once: (a) the Windows installer
itself (signed MSI via Actions); (b) Windows OTA artifacts (the
updater feed's `windows-x86_64` entry); (c) version control for the
KOVA source, which today has no git repo at all; (d) a repeatable
release pipeline (tag → build Mac DMG + Windows MSI + sign + publish
feed) instead of hand-built artifacts. The bare exe stays as the dev
artifact. This is a gate-list item (account creation + publish), so
it comes to Dre as this prepared decision — the answer is yes or no,
not a research task.

Mac OTA does not wait on it: Mac ships first, Windows follows when
the installer decision lands.

## 9. Verification plan (when/if this is built)

- **OTA hop test, modeled on the Avok Engine's verify-ota-hop
  scripts:** a test 1.1.1 release published to the feed, installed
  over 1.1.0 on Dre's Mac, version confirmed after restart. The hop
  is the proof — a passing build is not.
- **Signature negative test:** a payload with a bad signature (or a
  manifest pointing at a tampered file) is rejected before install,
  and the installed app is untouched. Verified on the Mac, not
  assumed from the plugin's docs.
- **DMG visual check:** the branded DMG is mounted and inspected by
  eye (or simulated with the NeuralAI preview tooling) before it
  ships — background at the right size, icons placed, no clipped
  art, no stale version in the picture.
- **Offline + feed-down behavior:** with no network and with the feed
  unreachable, the app launches and plays games normally; Settings
  shows the last check honestly.
- **Core tests** for any new Rust code, in the same style as the
  slice-5 profile tests. The updater plugin itself is upstream code
  and is not re-tested — the seams KOVA owns (feed URL, version
  compare, Settings UI) are.

## 10. What this spec explicitly does NOT promise

- No automatic rollback on a failed launch. The Tauri updater
  verifies before install, but it does not health-check the new
  version and restore the old one the way the NeuralAI launcher
  does. Mitigation: signature verification before install, the
  previous DMG kept available on the site, and the manual reinstall
  path Dre already knows. A failed update is recoverable by hand,
  not automatically.
- No Windows OTA until the installer decision lands (§8).
- No silent auto-install. Dre approves every install (§5).
- No 1.0.0 self-update. The updater arrives in 1.1.0 and works from
  there (§7).
- No feed or artifact published without Dre's go. The feed URL and
  the DMG are public surfaces; every publish waits on him, per the
  gate.

## 11. Open questions (for Dre)

1. **"fmg" = the DMG installer?** — RESOLVED 2026-11-12: confirmed,
   Dre misspelled DMG.
2. **Installer decision:** GitHub repo + Actions, as recommended in
   §8 — CONFIRMED 2026-11-12. (Mac OTA ships either way; Windows OTA
   follows the repo.)
3. **Prompt-first installs** (§5) — CONFIRMED 2026-11-12.
