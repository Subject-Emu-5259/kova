// KOVA V1 frontend — plain JS, no framework.
// Talks to the Tauri backend through the global Tauri API
// (enabled by "withGlobalTauri": true in tauri.conf.json):
//   invoke("scan_library", { path })          -> annotated library JSON
//        { sources: [{ source, roots, games, skipped }], total_games }
//        (games carry the core's Game fields plus slice-5 profile
//        fields: key, display_name, favorite, hidden,
//        art_url_override, launch_count, last_launched)
//   invoke("launch_game", { gameJson })       -> launch + record stats
//        and recents; returns the updated state
//   invoke("get_state")                       -> { recents,
//        standalone_folders, profiles, show_hidden_games,
//        gamer_profile, wishlist }
//   invoke("set_profile", { key, profile })   -> upsert a game profile
//   invoke("clear_profile", { key })          -> remove a game profile
//   invoke("set_show_hidden_games", { show })  -> updated state
//   invoke("set_gamer_profile", { profile })  -> updated state
//   invoke("set_wishlist", { wishlist })      -> updated state
//   invoke("set_standalone_folders", { folders }) -> updated state
//   invoke("game_icon", { gameJson })         -> cached local .app icon path?

const invoke =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.invoke
    : null;
const convertFileSrc =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.convertFileSrc
    : null;

// ---------------------------------------------------------------- DOM

const statusEl = document.getElementById("status");
const heroEl = document.getElementById("hero");
const quickResumeEl = document.getElementById("quick-resume");
const favoritesSectionEl = document.getElementById("favorites-section");
const favoritesEl = document.getElementById("favorites");
const shelvesEl = document.getElementById("shelves");
const summaryEl = document.getElementById("summary");
const filtersEl = document.getElementById("filters");
const searchInput = document.getElementById("library-search");
const sortSelect = document.getElementById("library-sort");
const gridEl = document.getElementById("grid");
const gridEmptyEl = document.getElementById("grid-empty");
const detailEl = document.getElementById("detail");
const detailBackBtn = document.getElementById("detail-back");
const pathInput = document.getElementById("steam-path");
const rescanBtn = document.getElementById("rescan");
const folderListEl = document.getElementById("folder-list");
const folderInput = document.getElementById("folder-input");
const folderAddBtn = document.getElementById("folder-add");
const showHiddenToggle = document.getElementById("show-hidden-toggle");
const hiddenListEl = document.getElementById("hidden-list");
const updateStatusEl = document.getElementById("update-status");
const updateNotesEl = document.getElementById("update-notes");
const updateCheckBtn = document.getElementById("update-check");
const updateInstallBtn = document.getElementById("update-install");
const updateRestartBtn = document.getElementById("update-restart");
const updateBadgeEl = document.getElementById("update-badge");
const hotkeyHintEl = document.getElementById("hotkey-hint");
const headerProfileBtn = document.getElementById("header-profile");
const headerAvatarEl = document.getElementById("header-avatar");
const headerGamertagEl = document.getElementById("header-gamertag");
const avokStoreEl = document.getElementById("avok-store");
const profileHeaderEl = document.getElementById("profile-header");
const profileStatsEl = document.getElementById("profile-stats");
const profileRecentsEl = document.getElementById("profile-recents");
const profileWishlistEl = document.getElementById("profile-wishlist");
const profileShareEl = document.getElementById("profile-share");
const gamertagInput = document.getElementById("gamertag-input");
const bioInput = document.getElementById("bio-input");
const avatarOptionsEl = document.getElementById("avatar-options");
const avatarUploadBtn = document.getElementById("avatar-upload-btn");
const avatarUploadInput = document.getElementById("avatar-upload");
const profileSaveBtn = document.getElementById("profile-save");
const profileSaveNoteEl = document.getElementById("profile-save-note");
const tabBtns = Array.from(document.querySelectorAll(".tab"));
const views = {
  home: document.getElementById("view-home"),
  library: document.getElementById("view-library"),
  store: document.getElementById("view-store"),
  profile: document.getElementById("view-profile"),
  detail: document.getElementById("view-detail"),
  settings: document.getElementById("view-settings"),
};

// ------------------------------------------------------------ constants

const SOURCE_LABELS = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  itch: "itch",
  standalone: "Standalone",
  avok: "Avok",
};

const SOURCE_ORDER = ["steam", "epic", "gog", "itch", "standalone", "avok"];

// Slice 5.2 — Avok title art. Keyed by the profile key
// "<source>:<id>". The Avok desktop builds ship the Avok studio
// mark as their app icon, so layering a mapped record's bundle
// icon would show the studio mark instead of the game's own logo.
// The mapped files are Mac-side build inputs living in app/src/
// (see README, slice 5.2) — they are NOT in this repo tree, and
// the frontend degrades cleanly if one is missing (the <img>
// removes itself on error). The Open World entry is the OW
// explorer badge (v1.2.1: Dre's correction 2026-11-14 — the badge
// is the real TOW logo; the globe was a misread and is retired).
const AVOK_GAME_ART = {
  "avok:dispatch-hq": "dispatch-hq-badge.png",
  "avok:the-open-world": "the-open-world-badge.png",
};

function avokGameArtFile(game) {
  if (!game) return null;
  return AVOK_GAME_ART[profileKey(game)] || null;
}

// v1.1.1 — Avok title copy for the store cards and the richer
// detail pages. Plain facts about the two live titles: Dispatch
// HQ runs the city's fire, police, and EMS from the dispatch
// desk; The Open World is the life sim on its subreddit. No
// invented URLs — the only link shown is the record's own
// launch URI.
const AVOK_GAME_INFO = {
  "avok:dispatch-hq": {
    blurb: "Real-time emergency dispatch sim",
    edition: "Web edition · Free",
    description:
      "Run the city's emergency services from the dispatch desk — fire, " +
      "police, and EMS. Every call is a decision, and every decision " +
      "has a consequence.",
  },
  "avok:the-open-world": {
    blurb: "Life sim on Reddit",
    edition: "Reddit community · Free",
    description:
      "A life sim that lives on Reddit — build a life, earn, explore, " +
      "and shape a world other players share.",
  },
};

function avokGameInfo(game) {
  if (!game) return null;
  return AVOK_GAME_INFO[profileKey(game)] || null;
}

// --------------------------------------------------------------- state

let lastResult = null;
let appState = {
  recents: [],
  standalone_folders: [],
  profiles: {},
  show_hidden_games: false,
  gamer_profile: { gamertag: "", avatar: "", bio: "", banner: null },
  wishlist: [],
  shelves: [],
  beta: { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] },
  kids: { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: "" },
  sync: { enabled: false, folder: null, last_push_at: null, last_pull_at: null },
  journal: [],
  save_backups: [],
  milestones: [],
};
let activeFilter = "all";
let searchQuery = "";
let sortMode = "name";
let currentView = "home";
let detailGame = null;
const localIconRequests = new Map();

// ------------------------------------------------------------- helpers

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return gb.toFixed(1) + " GB";
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return Math.round(mb) + " MB";
  const kb = bytes / 1024;
  if (kb >= 1) return Math.round(kb) + " KB";
  return bytes + " B";
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(epochSeconds) {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
  statusEl.hidden = message.length === 0;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function reportFor(source) {
  if (!lastResult) return null;
  return lastResult.sources.find((r) => r.source === source) || null;
}

function allGames() {
  if (!lastResult) return [];
  return lastResult.sources.flatMap((report) => report.games).map(mergeProfile);
}

function gamesForSource(source) {
  const report = reportFor(source);
  return report ? report.games.map(mergeProfile) : [];
}

// ------------------------------------------------------------- profiles

// The profile key mirrors kova-core's `profile_key`:
// "<source>:<id>" — name-independent, so renames can't orphan a
// profile.
function profileKey(game) {
  return game.source + ":" + game.id;
}

// Fill any state fields an older persisted state (or backend)
// did not provide, so the rest of the UI can assume they exist.
// The gamer profile is deep-defaulted: a pre-v1.1.1 state file
// has no `gamer_profile` key at all. The v1.2.0 fields are
// deep-defaulted the same way: a pre-v1.2.0 state file has none
// of them, and the backend seeds the built-in shelves on load.
function normalizeState(state) {
  const normalized = Object.assign(
    {
      recents: [],
      standalone_folders: [],
      profiles: {},
      show_hidden_games: false,
      wishlist: [],
      shelves: [],
      journal: [],
      save_backups: [],
      milestones: [],
    },
    state || {}
  );
  normalized.gamer_profile = Object.assign(
    { gamertag: "", avatar: "", bio: "", banner: null },
    (state && state.gamer_profile) || {}
  );
  normalized.beta = Object.assign(
    { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] },
    (state && state.beta) || {}
  );
  normalized.kids = Object.assign(
    { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: "" },
    (state && state.kids) || {}
  );
  normalized.sync = Object.assign(
    { enabled: false, folder: null, last_push_at: null, last_pull_at: null },
    (state && state.sync) || {}
  );
  return normalized;
}

// v1.2.0 §10 — the Kids shelf gate. When enabled, only the
// allowed games are visible on library surfaces, and launching
// anything else (or past the daily limit) is blocked with a
// plain message. The Profile and Settings views are the parent's
// and stay unfiltered.
function kidsEnabled() {
  return Boolean(appState && appState.kids && appState.kids.enabled);
}

function kidsAllows(game) {
  if (!kidsEnabled()) return true;
  const allowed = (appState.kids && appState.kids.allowed_keys) || [];
  return allowed.includes(profileKey(game));
}

function kidsTimeRemainingMinutes() {
  if (!kidsEnabled()) return null;
  const kids = appState.kids || {};
  if (kids.daily_limit_minutes === null || kids.daily_limit_minutes === undefined) return null;
  return Math.max(0, kids.daily_limit_minutes - (kids.minutes_used_today || 0));
}

function kidsLaunchBlockReason(game) {
  if (!kidsEnabled()) return null;
  if (!kidsAllows(game)) {
    return displayName(game) + " is not on the Kids shelf.";
  }
  const remaining = kidsTimeRemainingMinutes();
  if (remaining !== null && remaining <= 0) {
    return "Today's play time is used up — the Kids shelf limit has been reached.";
  }
  return null;
}

function defaultProfile() {
  return {
    name_override: null,
    favorite: false,
    hidden: false,
    launch_args: "",
    art_url_override: null,
    launch_count: 0,
    last_launched: null,
    // v1.2.0 §1 performance (serde defaults on the backend match).
    perf_launch_preset: null,
    perf_show_fps: false,
    perf_priority: "normal",
    // v1.2.0 §2 playtime (read-only from the UI — the backend
    // records sessions; the UI only displays them).
    total_play_seconds: 0,
    last_session_seconds: 0,
    last_session_end: null,
    // v1.2.0 §7/§10 rating, notes, art, saves, launch mode.
    rating: null,
    note: null,
    cover_art: null,
    save_folder: null,
    launch_mode: null,
  };
}

// The stored profile for a game (a copy the caller may edit and
// hand back to `set_profile`), or a fresh default.
function currentProfile(game) {
  const stored = (appState.profiles || {})[profileKey(game)];
  return stored ? Object.assign(defaultProfile(), stored) : defaultProfile();
}

// Merge the persisted profile over a scanned (or
// backend-annotated) game record, producing the record the UI
// renders: display_name, favorite, hidden, art_url_override and
// the launch stats. The backend annotates the scan with the same
// merge; re-applying the (fresher) state map here is what makes
// profile edits show up instantly, without a rescan.
function mergeProfile(game) {
  const merged = Object.assign({}, game);
  merged.key = profileKey(game);
  const profile = (appState.profiles || {})[merged.key];
  if (profile) {
    const override = (profile.name_override || "").trim();
    merged.display_name = override || game.name;
    merged.favorite = Boolean(profile.favorite);
    merged.hidden = Boolean(profile.hidden);
    merged.launch_args = profile.launch_args || "";
    merged.art_url_override = profile.art_url_override || null;
    merged.launch_count = profile.launch_count || 0;
    merged.last_launched =
      profile.last_launched === undefined ? null : profile.last_launched;
    // v1.2.0: the backend annotates the scan with the same
    // fields; the fresher state map wins here too.
    merged.perf_launch_preset = profile.perf_launch_preset || null;
    merged.perf_show_fps = Boolean(profile.perf_show_fps);
    merged.perf_priority = profile.perf_priority || "normal";
    merged.total_play_seconds = profile.total_play_seconds || 0;
    merged.last_session_seconds = profile.last_session_seconds || 0;
    merged.last_session_end =
      profile.last_session_end === undefined ? null : profile.last_session_end;
    merged.rating =
      profile.rating === undefined ? null : profile.rating;
    merged.note = profile.note === undefined ? null : profile.note;
    merged.cover_art = profile.cover_art || null;
    merged.save_folder = profile.save_folder || null;
    merged.launch_mode = profile.launch_mode || null;
  } else {
    merged.display_name = game.display_name || game.name;
    merged.favorite = Boolean(game.favorite);
    merged.hidden = Boolean(game.hidden);
    merged.launch_args = game.launch_args || "";
    merged.art_url_override = game.art_url_override || null;
    merged.launch_count = game.launch_count || 0;
    merged.last_launched =
      game.last_launched === undefined ? null : game.last_launched;
    merged.perf_launch_preset = game.perf_launch_preset || null;
    merged.perf_show_fps = Boolean(game.perf_show_fps);
    merged.perf_priority = game.perf_priority || "normal";
    merged.total_play_seconds = game.total_play_seconds || 0;
    merged.last_session_seconds = game.last_session_seconds || 0;
    merged.last_session_end =
      game.last_session_end === undefined ? null : game.last_session_end;
    merged.rating = game.rating === undefined ? null : game.rating;
    merged.note = game.note === undefined ? null : game.note;
    merged.cover_art = game.cover_art || null;
    merged.save_folder = game.save_folder || null;
    merged.launch_mode = game.launch_mode || null;
  }
  return merged;
}

function displayName(game) {
  return game.display_name || game.name;
}

// A game launches "locally" when its launch target is a plain
// filesystem path (standalone installs, itch folders, Avok titles
// merged with a local install) rather than a store URI or web URL.
// Only those have a local process KOVA can pass launch arguments
// to — the honesty rule behind the detail page's args field.
function launchesLocalPath(game) {
  return Boolean(game.launch_uri) && !game.launch_uri.includes("://");
}

// ----------------------------------------------------------------- art

// An Avok record is a local install when slice 4's merge found a
// standalone copy: it carries an install path and its launch target
// is that local path rather than the title's web URL.
function isLocalInstall(game) {
  return Boolean(
    game &&
      game.source === "avok" &&
      game.install_path &&
      game.launch_uri &&
      !/^https?:\/\//i.test(game.launch_uri)
  );
}

function hasLocalAppBundle(game) {
  return Boolean(
    game &&
      (game.source === "standalone" || game.source === "avok") &&
      /\.app$/i.test(game.install_path || "")
  );
}

async function localIconPath(game) {
  const key = game.source + "\0" + game.id;
  if (!localIconRequests.has(key)) {
    localIconRequests.set(
      key,
      invoke("game_icon", { gameJson: game }).catch(() => null)
    );
  }
  return localIconRequests.get(key);
}

// Layer a locally installed .app's real icon over the generated
// art. The <img> is created SYNCHRONOUSLY, while the art element
// is being built (slice 5.1): the previous version created it in
// the continuation of the icon-path promise, behind an
// `isConnected` check — on a warm icon cache (every post-launch
// re-render) the continuation could fire while the freshly built
// tile was still detached (or belonged to a superseded render)
// and the icon was silently dropped, leaving the generated
// source art on screen. Now the element rides with its tile from
// construction and only its `src` lands when the (cached) path
// promise resolves; an empty result or a load error removes it.
// This is decorative only: no icon, a non-macOS build, or any
// backend failure leaves the generated tile exactly as it was.
function attachLocalIcon(game, art) {
  if (!invoke || !convertFileSrc || !hasLocalAppBundle(game)) return;
  const img = document.createElement("img");
  img.className = "local-icon";
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.remove());
  // Keep the source tag painted above the icon layer.
  const tag = art.querySelector(".tag");
  if (tag) art.insertBefore(img, tag);
  else art.appendChild(img);
  localIconPath(game).then((iconPath) => {
    if (!iconPath) {
      img.remove();
      return;
    }
    img.src = convertFileSrc(iconPath);
  });
}

// Generated gradient art for a game. Steam titles with a numeric
// appid get their real library capsule on top; locally installed
// .app games get their real bundle icon on top — EXCEPT mapped
// Avok titles (slice 5.2), whose own game-art file replaces the
// bundle-icon layer (the Avok builds' bundle icon is the studio
// mark, not the game). A profile art URL override, when set,
// layers over the default art (and over mapped art — a user's
// explicit choice wins). If any image fails to load it removes
// itself and the gradient + monogram underneath shows through.
function gameArt(game, wide) {
  const art = el("div", "art art-" + game.source + (wide ? " art-wide" : ""));
  const initial = el(
    "span",
    "art-initial",
    (displayName(game) || "?").trim().charAt(0).toUpperCase() || "?"
  );
  art.appendChild(initial);
  // Slice 5.2 — Avok title art, layered over the gradient and
  // above the monogram. The file is a Mac-side build input; a
  // missing file removes itself on error, leaving today's tile.
  const mappedArt = avokGameArtFile(game);
  if (mappedArt) {
    const img = document.createElement("img");
    img.className = "game-art-img";
    img.alt = "";
    img.loading = "lazy";
    img.src = mappedArt;
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
  }
  if (game.source === "steam" && game.appid > 0) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src =
      "https://cdn.cloudflare.steamstatic.com/steam/apps/" +
      game.appid +
      (wide ? "/header.jpg" : "/library_600x900.jpg");
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
  }
  if (game.art_url_override) {
    const img = document.createElement("img");
    img.className = "art-override";
    img.alt = "";
    img.loading = "lazy";
    img.src = game.art_url_override;
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
  }
  // v1.2.0 §7: a custom cover upload is the player's most
  // deliberate art choice, so it layers last (on top of the URL
  // override, the capsule, and the mapped art).
  if (game.cover_art) {
    const img = document.createElement("img");
    img.className = "art-cover";
    img.alt = "";
    img.loading = "lazy";
    img.src = game.cover_art;
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
  }
  const tag = el("span", "tag tag-" + game.source, sourceLabel(game.source));
  art.appendChild(tag);
  // Slice 5.2 skip rule: a mapped Avok title never gets the
  // bundle-icon layer — it would paint the studio mark over the
  // game's own art. Unmapped records behave exactly as before.
  if (!mappedArt) attachLocalIcon(game, art);
  return art;
}

// --------------------------------------------------------------- views

function showView(name) {
  currentView = name;
  for (const [key, section] of Object.entries(views)) {
    section.hidden = key !== name;
  }
  // The detail view belongs to the Library tab.
  const tabFor = name === "detail" ? "library" : name;
  for (const btn of tabBtns) {
    btn.classList.toggle("active", btn.dataset.view === tabFor);
  }
  // Deep-linkable views: the hash names the view (replaceState, so
  // the controller back button keeps its own meaning and the
  // browser history stays clean). The detail view is not
  // restorable from a hash alone — it needs a selected game — so
  // loading with #detail falls back to Home (see init).
  try {
    window.history.replaceState(null, "", "#" + name);
  } catch (err) {
    /* a file:// or restricted context may refuse history writes */
  }
  window.scrollTo({ top: 0 });
  // Slice 6: a view switch swaps the visible focus scope, so let
  // the navigator re-anchor (it keeps focus when the focused
  // element survived, and never steals it from the mouse user).
  if (window.KovaNav) window.KovaNav.refresh();
}

// -------------------------------------------------------------- launch

async function launchGame(game, button) {
  if (!invoke || !game.launch_uri) return;
  // v1.2.0 §10 — the Kids shelf blocks launches outside the
  // allowed games (or past the daily limit) with a plain message.
  const blockReason = kidsLaunchBlockReason(game);
  if (blockReason) {
    setStatus(blockReason, true);
    return;
  }
  if (button) button.disabled = true;
  try {
    // launch_game launches, applies the profile's launch args for
    // local installs, and records the launch (stats + Quick
    // Resume) in one state write, returning the updated state.
    const updated = await invoke("launch_game", { gameJson: game });
    setStatus(
      "Launching " + displayName(game) + " via " + sourceLabel(game.source) + "…",
      false
    );
    if (updated) {
      appState = normalizeState(updated);
      renderQuickResume();
      renderFavorites();
      // v1.2.0 §7: a fresh launch resets the session timer's note.
      if (window.KovaV12 && window.KovaV12.onLaunched) window.KovaV12.onLaunched();
      if (currentView === "detail" && detailGame && detailGame.key === game.key) {
        detailGame = mergeProfile(detailGame);
        renderDetail();
      }
    }
  } catch (err) {
    setStatus("Launch failed for " + displayName(game) + ": " + err, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function actionButton(game) {
  // No launch target -> no button. KOVA never renders a Play button
  // that cannot do anything.
  if (!game.launch_uri) return null;
  const btn = el("button", "play", game.source === "avok" ? "Open" : "Play");
  btn.type = "button";
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    launchGame(game, btn);
  });
  return btn;
}

// --------------------------------------------------------------- tiles

function gameTile(game, mini) {
  const tile = el("article", "tile" + (mini ? " tile-mini" : ""));
  tile.tabIndex = 0;
  // Slice 6: stable anchor for gamepad/keyboard re-anchoring
  // after re-renders (the profile key, not the display name).
  tile.dataset.navKey = game.key;
  tile.setAttribute("role", "button");
  tile.setAttribute("aria-label", displayName(game));

  tile.appendChild(gameArt(game, false));

  const body = el("div", "tile-body");
  body.appendChild(el("h3", "tile-title", displayName(game)));
  const badges = [];
  if (game.favorite) badges.push(el("span", "fav-badge", "Favorite"));
  if (isLocalInstall(game)) {
    badges.push(el("span", "installed-badge", "Installed"));
  }
  if (badges.length > 0) {
    const row = el("div", "badges");
    for (const badge of badges) row.appendChild(badge);
    body.appendChild(row);
  }
  const bits = [];
  if (game.size_on_disk) bits.push(formatBytes(game.size_on_disk));
  if (game.last_updated) bits.push("Updated " + formatDate(game.last_updated));
  if (bits.length > 0) body.appendChild(el("div", "meta", bits.join(" · ")));
  const action = actionButton(game);
  if (action) body.appendChild(action);
  tile.appendChild(body);

  const open = () => openDetail(game);
  tile.addEventListener("click", open);
  // Slice 6: keyboard activation moved to the shared navigator
  // (nav.js) — Enter/Space on a focused tile go through the same
  // activate path as gamepad A, so the two never diverge. The
  // tile's click handler above is still the single opener.
  return tile;
}

// ---------------------------------------------------------------- home

function renderHero() {
  heroEl.innerHTML = "";
  const avokGames = gamesForSource("avok").filter((g) => !g.hidden);
  const featured =
    avokGames.find((g) => g.id === "dispatch-hq") || avokGames[0] || null;
  const hero = el("div", "hero");
  const copy = el("div", "hero-copy");
  const featuredIsLocal = featured && isLocalInstall(featured);
  copy.appendChild(el("div", "hero-eyebrow", "Avok Interactive · Featured"));
  copy.appendChild(el("h1", "hero-title", featured ? displayName(featured) : "Dispatch HQ"));
  if (featuredIsLocal) {
    copy.appendChild(el("span", "installed-badge hero-installed", "Installed on this Mac"));
  }
  copy.appendChild(
    el(
      "p",
      "hero-sub",
      featuredIsLocal
        ? "The real-time emergency dispatch sim — installed on this Mac. " +
            "Open launches the Mac app. Every call is a decision."
        : "The real-time emergency dispatch sim — free web edition, live now. " +
            "Every call is a decision."
    )
  );
  if (featured) {
    const btn = el("button", "play hero-play", "Open Dispatch HQ");
    btn.type = "button";
    btn.addEventListener("click", () => launchGame(featured, btn));
    copy.appendChild(btn);
  }
  hero.appendChild(copy);
  const artSide = el("div", "hero-art");
  const monoSource = featured ? displayName(featured) : "Dispatch HQ";
  const mono = monoSource
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  artSide.appendChild(el("span", "hero-mono", mono || "DH"));
  // Slice 5.2: the featured Avok title's own art over the hero
  // gradient (the monogram underneath is the missing-file
  // fallback). The hero never layers a bundle icon — it would be
  // the studio mark — so there is no skip rule to apply here.
  const heroMappedArt = featured ? avokGameArtFile(featured) : null;
  if (heroMappedArt) {
    const img = document.createElement("img");
    img.className = "hero-game-art";
    img.alt = "";
    img.loading = "lazy";
    img.src = heroMappedArt;
    img.addEventListener("error", () => img.remove());
    artSide.appendChild(img);
  }
  hero.appendChild(artSide);
  heroEl.appendChild(hero);
}

function renderQuickResume() {
  quickResumeEl.innerHTML = "";
  const recents = ((appState && appState.recents) || [])
    .map(mergeProfile)
    .filter((game) => !game.hidden)
    .filter((game) => kidsAllows(game));
  if (recents.length === 0) {
    quickResumeEl.appendChild(
      el(
        "p",
        "empty-note",
        "Nothing here yet — launch a game from KOVA and it will be waiting here."
      )
    );
    return;
  }
  for (const game of recents) {
    quickResumeEl.appendChild(gameTile(game, true));
  }
}

function renderFavorites() {
  favoritesEl.innerHTML = "";
  const favorites = allGames()
    .filter((game) => game.favorite && !game.hidden)
    .filter((game) => kidsAllows(game))
    .sort((a, b) =>
      displayName(a).toLowerCase().localeCompare(displayName(b).toLowerCase())
    );
  favoritesSectionEl.hidden = favorites.length === 0;
  for (const game of favorites) {
    favoritesEl.appendChild(gameTile(game, true));
  }
}

function renderShelves() {
  shelvesEl.innerHTML = "";
  if (!invoke) {
    shelvesEl.appendChild(
      el("p", "empty-note", "Library scan needs the KOVA app.")
    );
    return;
  }
  if (!lastResult) {
    shelvesEl.appendChild(el("p", "empty-note", "Scanning your library…"));
    return;
  }
  // The Avok shelf has its own store section above
  // (renderAvokStore), so it is not repeated here — one place per
  // game. Store strips follow in canonical order, and a source
  // with no games simply gets no strip.
  const ordered = [...lastResult.sources]
    .filter((report) => report.source !== "avok")
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  let rendered = 0;
  // v1.2.0 §7: the player's collection shelves render as Home
  // rows above the source strips (in beta.shelf_order when set).
  if (window.KovaV12 && window.KovaV12.renderHomeShelfRows) {
    rendered += window.KovaV12.renderHomeShelfRows(shelvesEl);
  }
  for (const report of ordered) {
    const games = gamesForSource(report.source).filter((g) => !g.hidden).filter((g) => kidsAllows(g));
    if (games.length === 0) continue;
    rendered += 1;
    const shelf = el("div", "shelf");
    const head = el("div", "shelf-head");
    head.appendChild(el("h3", "shelf-title", sourceLabel(report.source)));
    head.appendChild(
      el("span", "shelf-count", games.length + (games.length === 1 ? " game" : " games"))
    );
    shelf.appendChild(head);
    const row = el("div", "strip-row");
    for (const game of games) row.appendChild(gameTile(game, true));
    shelf.appendChild(row);
    shelvesEl.appendChild(shelf);
  }
  if (rendered === 0) {
    shelvesEl.appendChild(
      el("p", "empty-note", "No games found in Steam, Epic, GOG, itch, or your standalone folders yet.")
    );
  }
}

// ---------------------------------------------------------- avok store

// The Avok Store (v1.1.1): a store-like browse of Avok's own
// titles — art-forward cards with the game's own description,
// its edition, and Open / Details / Wishlist actions. KOVA sells
// nothing: the cards link out to the live editions, they never
// take payment.
function storeCard(game) {
  const card = el("article", "store-card");
  card.dataset.navKey = game.key;
  card.appendChild(gameArt(game, true));
  const body = el("div", "store-body");
  body.appendChild(el("h3", "store-title", displayName(game)));
  const info = avokGameInfo(game);
  if (info) {
    body.appendChild(el("p", "store-blurb", info.blurb));
    body.appendChild(el("p", "store-desc", info.description));
  }
  body.appendChild(
    el(
      "p",
      "store-meta",
      isLocalInstall(game)
        ? "Installed on this Mac"
        : (info && info.edition) || "Avok Interactive"
    )
  );
  const actions = el("div", "store-actions");
  const open = actionButton(game);
  if (open) actions.appendChild(open);
  const details = el("button", "ghost", "Details");
  details.type = "button";
  details.addEventListener("click", (event) => {
    event.stopPropagation();
    openDetail(game);
  });
  actions.appendChild(details);
  actions.appendChild(wishlistButton(game));
  body.appendChild(actions);
  card.appendChild(body);
  card.addEventListener("click", () => openDetail(game));
  return card;
}

function renderAvokStore() {
  if (!avokStoreEl) return;
  avokStoreEl.innerHTML = "";
  if (!invoke) {
    avokStoreEl.appendChild(
      el("p", "empty-note", "Library scan needs the KOVA app.")
    );
    return;
  }
  if (!lastResult) {
    avokStoreEl.appendChild(el("p", "empty-note", "Scanning your library…"));
    return;
  }
  const games = gamesForSource("avok").filter((game) => !game.hidden).filter((game) => kidsAllows(game));
  if (games.length === 0) {
    avokStoreEl.appendChild(
      el("p", "empty-note", "No Avok titles to show right now.")
    );
    return;
  }
  for (const game of games) avokStoreEl.appendChild(storeCard(game));
}

// ------------------------------------------------------------- library

// Games the Library should count and show before search + sort:
// the source chip's games, with hidden games excluded unless the
// Settings toggle says otherwise.
function libraryGames() {
  const showHidden = Boolean(appState.show_hidden_games);
  return allGames().filter((game) => {
    if (activeFilter !== "all" && game.source !== activeFilter) return false;
    if (game.hidden && !showHidden) return false;
    if (!kidsAllows(game)) return false;
    return true;
  });
}

function sortGames(games) {
  const byName = (a, b) =>
    displayName(a)
      .toLowerCase()
      .localeCompare(displayName(b).toLowerCase()) ||
    a.key.localeCompare(b.key);
  const sorted = [...games];
  if (sortMode === "recent") {
    sorted.sort(
      (a, b) => (b.last_launched || 0) - (a.last_launched || 0) || byName(a, b)
    );
  } else if (sortMode === "played") {
    sorted.sort(
      (a, b) =>
        (b.launch_count || 0) - (a.launch_count || 0) ||
        (b.last_launched || 0) - (a.last_launched || 0) ||
        byName(a, b)
    );
  } else if (sortMode === "source") {
    sorted.sort(
      (a, b) =>
        SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
        byName(a, b)
    );
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

function visibleGames() {
  let games = libraryGames();
  const query = searchQuery.trim().toLowerCase();
  if (query) {
    games = games.filter(
      (game) =>
        displayName(game).toLowerCase().includes(query) ||
        game.name.toLowerCase().includes(query)
    );
  }
  return sortGames(games);
}

// Counts shown in the summary + chips respect the same hidden rule
// as the grid, so the numbers always match what's on screen.
function countedGames(source) {
  const showHidden = Boolean(appState.show_hidden_games);
  return allGames().filter((game) => {
    if (source !== "all" && game.source !== source) return false;
    if (!kidsAllows(game)) return false;
    return showHidden || !game.hidden;
  });
}

function renderSummary() {
  summaryEl.hidden = false;
  summaryEl.innerHTML = "";
  const parts = [["Total games", String(countedGames("all").length)]];
  for (const report of lastResult.sources) {
    parts.push([
      sourceLabel(report.source),
      String(countedGames(report.source).length),
    ]);
  }
  const skippedTotal = lastResult.sources.reduce((n, r) => n + r.skipped, 0);
  parts.push(["Skipped files", String(skippedTotal)]);
  for (const [label, value] of parts) {
    const span = document.createElement("span");
    const strong = el("strong", null, label + ": ");
    span.appendChild(strong);
    span.appendChild(document.createTextNode(value));
    summaryEl.appendChild(span);
  }
}

function renderFilters() {
  filtersEl.hidden = false;
  filtersEl.innerHTML = "";
  const chips = [["all", "All", countedGames("all").length]];
  for (const report of lastResult.sources) {
    chips.push([
      report.source,
      sourceLabel(report.source),
      countedGames(report.source).length,
    ]);
  }
  for (const [value, label, count] of chips) {
    const chip = el("button", "chip" + (activeFilter === value ? " active" : ""), label + " · " + count);
    chip.type = "button";
    chip.addEventListener("click", () => {
      activeFilter = value;
      renderFilters();
      renderGrid();
    });
    filtersEl.appendChild(chip);
  }
}

function renderGrid() {
  gridEl.innerHTML = "";
  if (!lastResult) {
    gridEmptyEl.hidden = false;
    gridEmptyEl.textContent = invoke
      ? "Scanning your library…"
      : "Library scan needs the KOVA app.";
    return;
  }
  const games = visibleGames();
  for (const game of games) {
    gridEl.appendChild(gameTile(game, false));
  }
  if (games.length === 0) {
    gridEmptyEl.hidden = false;
    if (searchQuery.trim()) {
      gridEmptyEl.textContent =
        "No games match “" + searchQuery.trim() + "”.";
    } else if (activeFilter === "all") {
      gridEmptyEl.textContent = "No games found on this machine yet.";
    } else {
      gridEmptyEl.textContent =
        "No games from " + sourceLabel(activeFilter) + " in this scan.";
    }
  } else {
    gridEmptyEl.hidden = true;
  }
}

// -------------------------------------------------------------- detail

function openDetail(game) {
  detailGame = game;
  renderDetail();
  showView("detail");
}

function renderDetail() {
  const game = detailGame;
  detailEl.innerHTML = "";
  if (!game) return;

  detailEl.appendChild(gameArt(game, true));

  const body = el("div", "detail-body");
  body.appendChild(el("h1", "detail-title", displayName(game)));

  // v1.1.1: Avok titles get the richer page — their blurb and
  // description above the facts, and the live web address shown
  // as text (the Open button is the working link; a plain <a>
  // would navigate the KOVA window itself).
  const info = avokGameInfo(game);
  if (info) {
    body.appendChild(el("p", "detail-blurb", info.blurb));
    body.appendChild(el("p", "detail-desc", info.description));
  }

  const rows = [
    ["Source", sourceLabel(game.source)],
    ["Size", game.size_on_disk ? formatBytes(game.size_on_disk) : "—"],
    ["Last updated", game.last_updated ? formatDate(game.last_updated) : "—"],
  ];
  if (game.source === "avok") {
    rows.splice(1, 0, [
      "Edition / Status",
      isLocalInstall(game) ? "Installed on this Mac" : "Web edition",
    ]);
    if (/^https?:\/\//i.test(game.launch_uri || "")) {
      rows.push([
        "On the web",
        game.launch_uri.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      ]);
    }
  }
  if (game.install_path) rows.push(["Install path", game.install_path]);
  if (game.library && game.library !== "built-in") {
    rows.push(["Library", game.library]);
  }
  if (game.source === "avok") rows.push(["Library", "Built into KOVA"]);
  const table = el("dl", "detail-meta");
  for (const [key, value] of rows) {
    table.appendChild(el("dt", null, key));
    table.appendChild(el("dd", null, value));
  }

  // v1.1.1: two columns below the title — the facts and the Play
  // button on the left, the per-game profile card on the right —
  // so the detail page uses the window instead of leaving the
  // right half empty. Stacks to one column under 900px.
  const columns = el("div", "detail-columns");
  const factsCol = el("div", "detail-facts");
  factsCol.appendChild(table);

  const action = actionButton(game);
  if (action) {
    action.classList.add("detail-play");
    factsCol.appendChild(action);
  } else {
    factsCol.appendChild(el("p", "empty-note", "This title has no launch target on this machine."));
  }
  columns.appendChild(factsCol);

  columns.appendChild(renderProfileSection(game));
  body.appendChild(columns);
  // v1.2.0: playtime, performance, rating + note + cover,
  // shelves, save backups, journal, and duplicate hints live in
  // v12.js and render below the two columns.
  if (window.KovaV12 && window.KovaV12.renderDetailExtras) {
    const extras = window.KovaV12.renderDetailExtras(game);
    if (extras) body.appendChild(extras);
  }
  detailEl.appendChild(body);
}

// ------------------------------------------------------ profile editor

// Persist a profile for a game (upsert) and refresh every view
// the change can touch — tiles, favorites, shelves, the hidden
// list, and this detail page.
async function saveProfile(game, profile, message) {
  if (!invoke) return;
  try {
    const updated = await invoke("set_profile", {
      key: profileKey(game),
      profile,
    });
    if (updated) appState.profiles = updated;
    if (detailGame && detailGame.key === profileKey(game)) {
      detailGame = mergeProfile(game);
    }
    renderAll();
    if (currentView === "detail") renderDetail();
    if (message) setStatus(message, false);
  } catch (err) {
    setStatus("Could not save profile: " + err, true);
  }
}

function profileField(labelText, input, noteText) {
  const field = el("div", "profile-field");
  const label = el("label", null, labelText);
  label.htmlFor = input.id;
  field.appendChild(label);
  field.appendChild(input);
  if (noteText) field.appendChild(el("p", "profile-note", noteText));
  return field;
}

function textInput(id, value, placeholder) {
  const input = document.createElement("input");
  input.id = id;
  input.className = "text-input";
  input.type = "text";
  input.value = value || "";
  input.placeholder = placeholder || "";
  input.spellcheck = false;
  return input;
}

function renderProfileSection(game) {
  const profile = currentProfile(game);
  const hasStoredProfile = Boolean((appState.profiles || {})[profileKey(game)]);
  const section = el("section", "profile-card");
  section.appendChild(el("h2", null, "Profile"));

  const stats =
    profile.launch_count > 0
      ? "Played " +
        profile.launch_count +
        (profile.launch_count === 1 ? " time" : " times") +
        (profile.last_launched
          ? " · Last played " + formatDateTime(profile.last_launched)
          : "")
      : "Never launched from KOVA";
  section.appendChild(el("p", "profile-stats", stats));

  const nameInput = textInput(
    "profile-name",
    profile.name_override,
    "Display name (blank = " + game.name + ")"
  );
  section.appendChild(profileField("Display name", nameInput, null));

  const artInput = textInput(
    "profile-art",
    profile.art_url_override,
    "Art image URL (blank = default art)"
  );
  section.appendChild(profileField("Art override", artInput, null));

  // Launch options are honest only for local installs: a store
  // URI or web launch has no local process to receive arguments.
  const local = launchesLocalPath(game);
  const argsInput = textInput(
    "profile-args",
    profile.launch_args,
    "--windowed -skipintro"
  );
  argsInput.disabled = !local;
  section.appendChild(
    profileField(
      "Launch options",
      argsInput,
      local
        ? "Passed to the app when it launches from this Mac. Arguments are split on spaces — no quoting."
        : "Launch options apply to games installed on this Mac."
    )
  );

  const actions = el("div", "profile-actions");

  const saveBtn = el("button", null, "Save profile");
  saveBtn.type = "button";
  saveBtn.addEventListener("click", () => {
    const next = currentProfile(game);
    next.name_override = nameInput.value.trim() || null;
    next.art_url_override = artInput.value.trim() || null;
    next.launch_args = argsInput.value.trim();
    saveProfile(game, next, "Profile saved for " + displayName(game) + ".");
  });
  actions.appendChild(saveBtn);

  const favBtn = el(
    "button",
    "ghost toggle-btn" + (profile.favorite ? " on" : ""),
    profile.favorite ? "Favorited" : "Favorite"
  );
  favBtn.type = "button";
  favBtn.setAttribute("aria-pressed", String(Boolean(profile.favorite)));
  favBtn.addEventListener("click", () => {
    const next = currentProfile(game);
    next.favorite = !next.favorite;
    saveProfile(
      game,
      next,
      next.favorite
        ? displayName(game) + " added to Favorites."
        : displayName(game) + " removed from Favorites."
    );
  });
  actions.appendChild(favBtn);

  // v1.1.1: the wishlist is Avok titles only.
  if (game.source === "avok") {
    actions.appendChild(wishlistButton(game));
  }

  const hideBtn = el(
    "button",
    "ghost toggle-btn" + (profile.hidden ? " on" : ""),
    profile.hidden ? "Unhide" : "Hide"
  );
  hideBtn.type = "button";
  hideBtn.setAttribute("aria-pressed", String(Boolean(profile.hidden)));
  hideBtn.addEventListener("click", () => {
    const next = currentProfile(game);
    next.hidden = !next.hidden;
    saveProfile(
      game,
      next,
      next.hidden
        ? displayName(game) +
            " hidden. You can unhide it here or in Settings."
        : displayName(game) + " is visible again."
    );
  });
  actions.appendChild(hideBtn);

  const resetBtn = el("button", "ghost", "Reset profile");
  resetBtn.type = "button";
  resetBtn.disabled = !hasStoredProfile;
  resetBtn.addEventListener("click", async () => {
    if (!invoke) return;
    try {
      const updated = await invoke("clear_profile", { key: profileKey(game) });
      if (updated) appState.profiles = updated;
      detailGame = mergeProfile(game);
      renderAll();
      if (currentView === "detail") renderDetail();
      setStatus("Profile reset for " + game.name + ".", false);
    } catch (err) {
      setStatus("Could not reset profile: " + err, true);
    }
  });
  actions.appendChild(resetBtn);

  section.appendChild(actions);
  return section;
}

// --------------------------------------------- gamer profile (v1.1.1)

// The gamer profile is LOCAL: KOVA has no backend and no accounts,
// so the gamertag, avatar, and bio live in kova-state.json on this
// machine and nowhere else. The avatar value is "" (no avatar —
// the UI shows the gamertag's initial), "builtin:<id>", or a data
// URL from an upload (downscaled in the frontend, capped).
const AVATAR_MAX_DATA_URL_CHARS = 300000; // ~200 KB image, base64

// Built-in avatar options, drawn in code — no image files. "mark"
// reuses the embedded Avok mark; "orbit" and "bolt" are small
// inline SVGs in the brand palette; "initial" renders the
// gamertag's first letter (and is the fallback for "").
const AVATAR_OPTIONS = [
  { id: "initial", label: "Initial", value: "" },
  { id: "mark", label: "Avok mark", value: "builtin:mark" },
  { id: "orbit", label: "Orbit", value: "builtin:orbit" },
  { id: "bolt", label: "Bolt", value: "builtin:bolt" },
];

const AVATAR_SVGS = {
  orbit:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="none" stroke="#00D8F0" stroke-width="3"/><circle cx="32" cy="32" r="14" fill="none" stroke="#039BBD" stroke-width="3"/><circle cx="50" cy="16" r="6" fill="#00D8F0"/></svg>',
  bolt:
    '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M36 6 L14 36 h12 L28 58 L50 26 h-13 z" fill="#00D8F0"/></svg>',
};

function gamerProfile() {
  return (appState && appState.gamer_profile) || {
    gamertag: "",
    avatar: "",
    bio: "",
  };
}

function gamertagInitial() {
  const tag = (gamerProfile().gamertag || "").trim();
  return tag ? tag.charAt(0).toUpperCase() : "K";
}

// Render an avatar value into an element. `sizeClass` is one of
// avatar-sm (28px), avatar-md (48px), avatar-lg (96px).
function avatarElement(value, sizeClass) {
  const wrap = el("span", "avatar " + (sizeClass || "avatar-md"));
  if (value && value.indexOf("data:image/") === 0) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.src = value;
    img.addEventListener("error", () => {
      wrap.innerHTML = "";
      wrap.appendChild(el("span", "avatar-initial", gamertagInitial()));
    });
    wrap.appendChild(img);
    return wrap;
  }
  if (value === "builtin:mark" && window.AVOK_MARK_DATA_URI) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.src = window.AVOK_MARK_DATA_URI;
    img.addEventListener("error", () => {
      wrap.innerHTML = "";
      wrap.appendChild(el("span", "avatar-initial", gamertagInitial()));
    });
    wrap.appendChild(img);
    return wrap;
  }
  const builtin = value && value.indexOf("builtin:") === 0 ? value.slice(8) : null;
  if (builtin && AVATAR_SVGS[builtin]) {
    wrap.innerHTML = AVATAR_SVGS[builtin];
    return wrap;
  }
  wrap.appendChild(el("span", "avatar-initial", gamertagInitial()));
  return wrap;
}

function renderHeaderProfile() {
  if (!headerGamertagEl || !headerAvatarEl) return;
  const profile = gamerProfile();
  headerGamertagEl.textContent = (profile.gamertag || "").trim() || "Set gamertag";
  headerAvatarEl.innerHTML = "";
  headerAvatarEl.appendChild(avatarElement(profile.avatar, "avatar-sm"));
}

// Downscale an uploaded image on a canvas until its data URL fits
// the cap: PNG at 256px, then JPEG at 256px, then JPEG at 192px.
// Rejects with a plain message when nothing fits (or the file is
// not a readable image) — the caller shows it in the status bar.
function downscaleAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || file.type.indexOf("image/") !== 0) {
      reject(new Error("That file is not an image."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read that image."));
      img.onload = () => {
        const attempts = [
          { size: 256, type: "image/png", quality: undefined },
          { size: 256, type: "image/jpeg", quality: 0.85 },
          { size: 192, type: "image/jpeg", quality: 0.7 },
        ];
        for (const attempt of attempts) {
          const scale = Math.min(
            1,
            attempt.size / Math.max(img.naturalWidth, img.naturalHeight)
          );
          const width = Math.max(1, Math.round(img.naturalWidth * scale));
          const height = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl =
            attempt.quality === undefined
              ? canvas.toDataURL(attempt.type)
              : canvas.toDataURL(attempt.type, attempt.quality);
          if (dataUrl.length <= AVATAR_MAX_DATA_URL_CHARS) {
            resolve(dataUrl);
            return;
          }
        }
        reject(
          new Error("That image is still too large after shrinking — try a smaller file.")
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// The avatar choice staged in the Settings form. null means "keep
// the saved avatar"; any other value ("" / "builtin:<id>" / data
// URL) is what Save will store.
let stagedAvatar = null;

function selectedAvatarValue() {
  return stagedAvatar !== null ? stagedAvatar : gamerProfile().avatar || "";
}

function renderAvatarOptions() {
  if (!avatarOptionsEl) return;
  avatarOptionsEl.innerHTML = "";
  const selected = selectedAvatarValue();
  const options = AVATAR_OPTIONS.slice();
  // A staged or saved upload gets its own option so the picker
  // always shows what is selected.
  if (selected && selected.indexOf("data:image/") === 0) {
    options.push({ id: "upload", label: "Uploaded", value: selected });
  }
  for (const option of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-option" + (option.value === selected ? " selected" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(option.value === selected));
    btn.setAttribute("aria-label", option.label);
    btn.title = option.label;
    btn.appendChild(avatarElement(option.value, "avatar-md"));
    btn.appendChild(el("span", "avatar-option-label", option.label));
    btn.addEventListener("click", () => {
      stagedAvatar = option.value;
      renderAvatarOptions();
    });
    avatarOptionsEl.appendChild(btn);
  }
}

function renderProfileSettings() {
  if (!gamertagInput || !bioInput) return;
  const profile = gamerProfile();
  gamertagInput.value = profile.gamertag || "";
  bioInput.value = profile.bio || "";
  stagedAvatar = null;
  renderAvatarOptions();
}

async function saveGamerProfile() {
  if (!invoke) return;
  const profile = {
    gamertag: gamertagInput.value.trim(),
    avatar: selectedAvatarValue(),
    bio: bioInput.value.trim(),
  };
  try {
    const updated = await invoke("set_gamer_profile", { profile });
    if (updated) appState = normalizeState(updated);
    stagedAvatar = null;
    renderHeaderProfile();
    renderProfile();
    renderProfileSettings();
    if (profileSaveNoteEl) {
      profileSaveNoteEl.hidden = false;
      window.setTimeout(() => {
        profileSaveNoteEl.hidden = true;
      }, 3000);
    }
  } catch (err) {
    setStatus("Could not save profile: " + err, true);
  }
}

// ---------------------------------------------------------------- wishlist

// The wishlist is Avok titles only (the backend drops non-avok:
// keys too) — the shelf is what KOVA showcases.
function isWishlisted(game) {
  return (appState.wishlist || []).includes(profileKey(game));
}

async function toggleWishlist(game) {
  if (!invoke || !game || game.source !== "avok") return;
  const key = profileKey(game);
  const list = (appState.wishlist || []).slice();
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1);
  else list.push(key);
  try {
    const updated = await invoke("set_wishlist", { wishlist: list });
    if (updated) appState = normalizeState(updated);
    renderAvokStore();
    renderProfile();
    if (currentView === "detail") renderDetail();
    setStatus(
      at >= 0
        ? displayName(game) + " removed from your wishlist."
        : displayName(game) + " added to your wishlist.",
      false
    );
  } catch (err) {
    setStatus("Could not update the wishlist: " + err, true);
  }
}

function wishlistButton(game) {
  const wished = isWishlisted(game);
  const btn = el(
    "button",
    "ghost toggle-btn" + (wished ? " on" : ""),
    wished ? "Wishlisted" : "Wishlist"
  );
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(wished));
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleWishlist(game);
  });
  return btn;
}

// ------------------------------------------------------------ profile view

// Stats computed from the library as rendered (hidden games
// excluded, same rule as the shelves). Before the first scan
// there is no library: every value is null and the strip shows
// dashes — a missing value, not a zero. v1.2.0 §2: most-played
// is BY TIME (total_play_seconds), with launch count kept as its
// own cell; total hours is the sum across the library.
function profileStats() {
  if (!lastResult) {
    return { games: null, favorites: null, totalLaunches: null, mostPlayed: null, totalPlaySeconds: null, mostPlayedByTime: null };
  }
  const games = allGames().filter((game) => !game.hidden);
  const favorites = games.filter((game) => game.favorite).length;
  const totalLaunches = games.reduce(
    (sum, game) => sum + (game.launch_count || 0),
    0
  );
  const totalPlaySeconds = games.reduce(
    (sum, game) => sum + (game.total_play_seconds || 0),
    0
  );
  let mostPlayed = null;
  for (const game of games) {
    if (
      (game.launch_count || 0) > 0 &&
      (!mostPlayed || game.launch_count > mostPlayed.launch_count)
    ) {
      mostPlayed = game;
    }
  }
  let mostPlayedByTime = null;
  for (const game of games) {
    if (
      (game.total_play_seconds || 0) > 0 &&
      (!mostPlayedByTime || game.total_play_seconds > mostPlayedByTime.total_play_seconds)
    ) {
      mostPlayedByTime = game;
    }
  }
  return { games: games.length, favorites, totalLaunches, mostPlayed, totalPlaySeconds, mostPlayedByTime };
}

// v1.2.0 §2: "12h 34m" for the stats strip and share card;
// under an hour reads "34m", under a minute reads "0m".
function formatPlaytime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
}

function statCell(label, value, caption) {
  const cell = el("div", "stat-cell");
  cell.setAttribute("role", "listitem");
  cell.appendChild(el("span", "stat-label", label));
  cell.appendChild(el("span", "stat-value num", value));
  if (caption) cell.appendChild(el("span", "stat-caption", caption));
  return cell;
}

function renderProfile() {
  if (!profileHeaderEl || !profileStatsEl) return;
  const profile = gamerProfile();
  const tag = (profile.gamertag || "").trim();

  profileHeaderEl.innerHTML = "";
  profileHeaderEl.appendChild(avatarElement(profile.avatar, "avatar-lg"));
  const identity = el("div", "profile-identity");
  identity.appendChild(el("h1", "profile-name", tag || "Your profile"));
  // v1.2.0 §9: the gamertag IS the KOVA LIVE tag — the identity
  // seed, with the honest line that nothing is online yet.
  identity.appendChild(el("p", "profile-live-tag", "Your KOVA LIVE tag"));
  identity.appendChild(
    el(
      "p",
      "profile-live-note",
      "LIVE is coming — your tag is already yours. Nothing is online yet."
    )
  );
  identity.appendChild(
    el(
      "p",
      "profile-bio",
      (profile.bio || "").trim() || "Add a bio in Settings."
    )
  );
  const editBtn = el("button", "ghost", "Edit profile");
  editBtn.type = "button";
  editBtn.addEventListener("click", () => showView("settings"));
  identity.appendChild(editBtn);
  profileHeaderEl.appendChild(identity);

  const stats = profileStats();
  profileStatsEl.innerHTML = "";
  const dash = "—";
  profileStatsEl.appendChild(
    statCell(
      "Games",
      stats.games === null ? dash : String(stats.games),
      "in your library"
    )
  );
  profileStatsEl.appendChild(
    statCell(
      "Favorites",
      stats.favorites === null ? dash : String(stats.favorites),
      "starred"
    )
  );
  profileStatsEl.appendChild(
    statCell(
      "Launches",
      stats.totalLaunches === null ? dash : String(stats.totalLaunches),
      "from KOVA"
    )
  );
  profileStatsEl.appendChild(
    statCell(
      "Total hours",
      stats.totalPlaySeconds === null ? dash : formatPlaytime(stats.totalPlaySeconds),
      "games launched from KOVA"
    )
  );
  profileStatsEl.appendChild(
    statCell(
      "Most played",
      stats.mostPlayedByTime ? displayName(stats.mostPlayedByTime) : dash,
      stats.mostPlayedByTime
        ? formatPlaytime(stats.mostPlayedByTime.total_play_seconds) + " played"
        : "no playtime recorded yet"
    )
  );
  // v1.2.0 §2/§7/§10: recent sessions, library stats, and
  // milestones render into the Profile view's v12 containers.
  if (window.KovaV12 && window.KovaV12.renderProfileExtras) {
    window.KovaV12.renderProfileExtras();
  }

  profileRecentsEl.innerHTML = "";
  const recents = ((appState && appState.recents) || [])
    .map(mergeProfile)
    .filter((game) => !game.hidden)
    .slice(0, 5);
  if (recents.length === 0) {
    profileRecentsEl.appendChild(
      el(
        "p",
        "empty-note",
        "Nothing here yet — launch a game from KOVA and it will be waiting here."
      )
    );
  } else {
    for (const game of recents) {
      profileRecentsEl.appendChild(gameTile(game, true));
    }
  }

  profileWishlistEl.innerHTML = "";
  const wished = (appState.wishlist || [])
    .map((key) => allGames().find((game) => game.key === key))
    .filter(Boolean)
    .filter((game) => !game.hidden);
  if (wished.length === 0) {
    profileWishlistEl.appendChild(
      el(
        "p",
        "empty-note",
        "No Avok titles on your wishlist yet — add one from the Avok Store or a game's page."
      )
    );
  } else {
    for (const game of wished) {
      profileWishlistEl.appendChild(gameTile(game, true));
    }
  }

  renderShareSection();
}

// ------------------------------------------------------------- share card

// The shareable profile card (v1.1.1, local-only social): an
// image and a text version of the gamertag + stats + shelf, made
// on this machine. Nothing is sent anywhere — the player copies
// or downloads it and posts it wherever they like.
const SHARE_CARD_WIDTH = 1200;
const SHARE_CARD_HEIGHT = 630;

function shelfNames() {
  return gamesForSource("avok")
    .filter((game) => !game.hidden)
    .map((game) => displayName(game));
}

function shareCardText() {
  const profile = gamerProfile();
  const tag = (profile.gamertag || "").trim() || "A KOVA player";
  const stats = profileStats();
  const lines = [tag + " on KOVA"];
  if ((profile.bio || "").trim()) lines.push((profile.bio || "").trim());
  if (stats.games !== null) {
    lines.push(
      stats.games +
        " games · " +
        stats.favorites +
        " favorites · " +
        stats.totalLaunches +
        " launches"
    );
  }
  // v1.2.0 §2: the card carries total hours, and most-played is
  // by time — playtime counts only games launched from KOVA.
  if (stats.totalPlaySeconds !== null && stats.totalPlaySeconds > 0) {
    lines.push("Total playtime: " + formatPlaytime(stats.totalPlaySeconds));
  }
  const mostByTime = stats.mostPlayedByTime || stats.mostPlayed;
  if (mostByTime) {
    lines.push(
      "Most played: " +
        displayName(mostByTime) +
        (stats.mostPlayedByTime
          ? " (" + formatPlaytime(mostByTime.total_play_seconds) + ")"
          : " (" +
            mostByTime.launch_count +
            (mostByTime.launch_count === 1 ? " launch" : " launches") +
            ")")
    );
  }
  const shelf = shelfNames();
  if (shelf.length > 0) lines.push("Avok shelf: " + shelf.join(" · "));
  return lines.join("\n");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

function truncateForCanvas(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

// Draw the 1200×630 share card: ground, avatar, gamertag, bio,
// the same four stats the Profile view shows, and the Avok shelf
// line. Avatar images that fail to load fall back to the initial
// letter — the card never fails on art.
async function drawShareCard(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const profile = gamerProfile();
  const stats = profileStats();
  const tag = (profile.gamertag || "").trim() || "Your profile";
  const bio = (profile.bio || "").trim();

  ctx.fillStyle = "#0B0D0F";
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  ctx.fillStyle = "#00D8F0";
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, 8);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#00D8F0";
  ctx.font = "800 30px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("KOVA", 72, 64);
  ctx.fillStyle = "#949494";
  ctx.font = "400 24px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("by Avok Interactive", 178, 64);

  const avatarCx = 136;
  const avatarCy = 210;
  const avatarR = 64;
  let avatarDrawn = false;
  const avatarValue = profile.avatar || "";
  let avatarSrc = null;
  if (avatarValue.indexOf("data:image/") === 0) {
    avatarSrc = avatarValue;
  } else if (avatarValue === "builtin:mark" && window.AVOK_MARK_DATA_URI) {
    avatarSrc = window.AVOK_MARK_DATA_URI;
  } else if (
    avatarValue.indexOf("builtin:") === 0 &&
    AVATAR_SVGS[avatarValue.slice(8)]
  ) {
    avatarSrc =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(AVATAR_SVGS[avatarValue.slice(8)]);
  }
  if (avatarSrc) {
    try {
      const img = await loadImage(avatarSrc);
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        img,
        avatarCx - avatarR,
        avatarCy - avatarR,
        avatarR * 2,
        avatarR * 2
      );
      ctx.restore();
      avatarDrawn = true;
    } catch (err) {
      avatarDrawn = false;
    }
  }
  if (!avatarDrawn) {
    ctx.fillStyle = "#17191D";
    ctx.beginPath();
    ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#00D8F0";
    ctx.font = "800 64px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(gamertagInitial(), avatarCx, avatarCy + 23);
    ctx.textAlign = "left";
  }

  ctx.fillStyle = "#F5F5F4";
  ctx.font = "800 56px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(truncateForCanvas(tag, 24), 232, 200);
  if (bio) {
    ctx.fillStyle = "#B4B4B4";
    ctx.font = "400 28px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(truncateForCanvas(bio, 52), 232, 248);
  }

  ctx.strokeStyle = "#262A30";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(72, 330);
  ctx.lineTo(SHARE_CARD_WIDTH - 72, 330);
  ctx.stroke();

  const cells = [
    ["Games", stats.games === null ? "—" : String(stats.games)],
    ["Favorites", stats.favorites === null ? "—" : String(stats.favorites)],
    ["Launches", stats.totalLaunches === null ? "—" : String(stats.totalLaunches)],
    [
      "Most played",
      stats.mostPlayedByTime
        ? truncateForCanvas(displayName(stats.mostPlayedByTime), 16)
        : stats.mostPlayed
          ? truncateForCanvas(displayName(stats.mostPlayed), 16)
          : "—",
    ],
  ];
  const cellWidth = (SHARE_CARD_WIDTH - 144) / 4;
  cells.forEach(([label, value], i) => {
    const x = 72 + i * cellWidth;
    ctx.fillStyle = "#949494";
    ctx.font = "400 22px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(label, x, 384);
    ctx.fillStyle = "#F5F5F4";
    ctx.font = "700 40px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(value, x, 436);
  });

  // v1.2.0 §2: total hours on the card's foot line, next to the
  // Avok shelf — the same hours the Profile view shows.
  const shelf = shelfNames();
  const hoursLine =
    stats.totalPlaySeconds !== null && stats.totalPlaySeconds > 0
      ? formatPlaytime(stats.totalPlaySeconds) + " played"
      : "";
  const footParts = [];
  if (shelf.length > 0) footParts.push("Avok shelf: " + shelf.join(" · "));
  if (hoursLine) footParts.push(hoursLine);
  ctx.fillStyle = "#949494";
  ctx.font = "400 24px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(
    truncateForCanvas(
      footParts.length > 0 ? footParts.join("  ·  ") : "Avok Interactive",
      86
    ),
    72,
    572
  );
}

function renderShareSection() {
  if (!profileShareEl) return;
  profileShareEl.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "share-canvas";
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Preview of your shareable KOVA profile card");
  profileShareEl.appendChild(canvas);
  drawShareCard(canvas);

  const actions = el("div", "share-actions");
  const downloadBtn = el("button", null, "Download image");
  downloadBtn.type = "button";
  downloadBtn.addEventListener("click", () => {
    if (!canvas.toBlob) {
      setStatus("This browser cannot download the card image.", true);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        setStatus("Could not make the card image.", true);
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "kova-profile-card.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Profile card downloaded.", false);
    }, "image/png");
  });
  actions.appendChild(downloadBtn);

  const copyBtn = el("button", "ghost", "Copy text");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", async () => {
    const text = shareCardText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setStatus("Profile text copied to the clipboard.", false);
    } catch (err) {
      setStatus("Could not copy the profile text: " + err, true);
    }
  });
  actions.appendChild(copyBtn);
  profileShareEl.appendChild(actions);
}

// ------------------------------------------------------------ settings

// The visibility card: the "show hidden games" toggle plus the
// hidden games list with per-game Unhide — hiding is always
// reversible from the UI.
function renderHiddenSettings() {
  if (showHiddenToggle) {
    showHiddenToggle.checked = Boolean(appState.show_hidden_games);
  }
  hiddenListEl.innerHTML = "";
  const profiles = appState.profiles || {};
  const hiddenKeys = Object.keys(profiles).filter(
    (key) => profiles[key] && profiles[key].hidden
  );
  if (hiddenKeys.length === 0) {
    hiddenListEl.appendChild(
      el("p", "empty-note", "No hidden games. Hide one from its game page and it will be listed here.")
    );
    return;
  }
  for (const key of hiddenKeys) {
    const scanned = allGames().find((g) => g.key === key);
    const profile = profiles[key];
    const label = scanned
      ? displayName(scanned)
      : (profile.name_override || "").trim() || key;
    const row = el("div", "folder-row");
    const text = el("span", "folder-path", label);
    if (scanned) {
      text.appendChild(
        el("span", "hidden-key", " · " + sourceLabel(scanned.source))
      );
    }
    row.appendChild(text);
    const unhide = el("button", "ghost folder-remove", "Unhide");
    unhide.type = "button";
    unhide.addEventListener("click", async () => {
      const game = scanned || { source: key.split(":")[0], id: key.slice(key.indexOf(":") + 1), name: label };
      const next = currentProfile(game);
      next.hidden = false;
      await saveProfile(game, next, label + " is visible again.");
    });
    row.appendChild(unhide);
    hiddenListEl.appendChild(row);
  }
}

// ------------------------------------------------------------ updates

// Over-the-air updates (v1.1.0). Check on launch and every 6 hours,
// silently; an available update lights the Settings tab badge and
// waits in the Updates card. Install and restart are always explicit
// clicks — nothing auto-installs.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let pendingUpdateVersion = null;

// Release notes bundled in-app (v1.1.1). The Updates card shows the
// current version's notes first, then the previous version's — so the
// 1.1.0 notes are visible inside the app, not just on GitHub. The
// feed's notes still drive the available-update display. Bump
// APP_VERSION with each release and add its notes at the top of
// RELEASE_ORDER.
const APP_VERSION = "1.3.1";
const RELEASE_ORDER = ["1.3.1", "1.3.0", "1.2.1", "1.2.0"];
const RELEASE_NOTES = {
  "1.3.1": [
    "Dev applications now send to the review inbox — the email button works.",
  ],
  "1.3.0": [
    "The Game Store now shows every way to play each game — web, file, and Reddit — with one action per platform. Dispatch HQ is on all three.",
    "The dev application is real now: what your game is, where it plays, when you want it listed, and who you are — reviewed by Melo and Dre before anything appears.",
  ],
  "1.2.1": [
    "The Open World now shows its real logo — the OW explorer badge, transparent like the Dispatch HQ badge.",
  ],
  "1.2.0": [
    "Performance profiles: launch presets, Apple's FPS HUD, and process priority — per game, set once.",
    "Playtime tracking: real hours per game, feeding your profile stats and share card.",
    "The update prompt now shows the real release notes, not a placeholder line.",
    "Logo placement fixes and polish across the app, and the dock icon stops flipping between the old and new logo.",
    "Collections, custom cover art, ratings and notes, a session timer, stats, update notifications, and state backup.",
    "The Game Store opens for devs: free games, listed and browsable, downloads from the dev's own link.",
    "KOVA LIVE begins: your gamertag is now your LIVE identity.",
    "Big Picture mode, save backups, cloud sync through your own storage, a Kids shelf, milestones, a game journal, launch modes, disk view, menu-bar launch, and controller status.",
    "The KOVA Beta Program: a brand-new light UI you can switch to from Settings, with profile customization first.",
  ],
  "1.1.1": [
    "Release notes now show in the app — what changed in each version, right in Settings.",
    "A polished, more platform-feel KOVA: cleaner screens, smoother navigation everywhere.",
    "Your gamertag and gamer profile: your tag, your avatar, your stats, all on your machine.",
    "A sharper Avok shelf with richer game pages and a local wishlist.",
    "Share your profile card anywhere.",
    "This update arrived over the air, the first one ever for KOVA.",
  ],
  "1.1.0": [
    "KOVA can now update itself. Check for updates in Settings, read what's new, and install when you choose — updates never install silently.",
    "Branded DMG installer with the KOVA wordmark and install arrow.",
    "Same library, same controller navigation, same Quick Panel — now on 1.1.0.",
    "This is the last manual install. From here, updates arrive in the app.",
  ],
};

function renderWhatsNew() {
  const body = document.getElementById("update-whatsnew-body");
  if (!body) return;
  const start = RELEASE_ORDER.indexOf(APP_VERSION);
  const shown = start >= 0 ? RELEASE_ORDER.slice(start, start + 2) : [APP_VERSION];
  body.innerHTML = "";
  for (const version of shown) {
    const notes = RELEASE_NOTES[version];
    if (!notes) continue;
    const heading = document.createElement("h4");
    heading.textContent = "KOVA " + version;
    body.appendChild(heading);
    const list = document.createElement("ul");
    for (const note of notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.appendChild(item);
    }
    body.appendChild(list);
  }
}

function setUpdateBadge(show) {
  if (updateBadgeEl) updateBadgeEl.hidden = !show;
}

function renderUpdateState(statusText, notesText, showInstall, showRestart) {
  if (updateStatusEl) updateStatusEl.textContent = statusText;
  if (updateNotesEl) {
    updateNotesEl.textContent = notesText || "";
    updateNotesEl.hidden = !notesText;
  }
  if (updateInstallBtn) updateInstallBtn.hidden = !showInstall;
  if (updateRestartBtn) updateRestartBtn.hidden = !showRestart;
}

async function checkForUpdates(manual) {
  if (!invoke) return;
  if (manual) {
    renderUpdateState("Checking for updates…", "", false, false);
  }
  try {
    const info = await invoke("check_update");
    if (!info) return;
    if (info.available) {
      pendingUpdateVersion = info.version;
      setUpdateBadge(true);
      renderUpdateState(
        "Update available: KOVA " + info.version + " (you're on " + info.current_version + ").",
        info.notes || "",
        true,
        false
      );
      // v1.2.0 §7: a macOS notification when an update is found,
      // not just the badge in Settings. Best-effort and
      // de-duplicated per version: the 6-hour re-check must not
      // re-notify for the same release. No-op off macOS.
      if (window.KovaV12 && window.KovaV12.notifyUpdateOnce) {
        window.KovaV12.notifyUpdateOnce(info.version, info.notes || "");
      }
    } else {
      pendingUpdateVersion = null;
      setUpdateBadge(false);
      renderUpdateState(
        "You're on the latest version (KOVA " + info.current_version + ").",
        "",
        false,
        false
      );
    }
  } catch (err) {
    // A failed check (offline, feed down) never errors in Dre's face:
    // the card says so plainly and the next scheduled check retries.
    renderUpdateState(
      "Couldn't check for updates — will retry automatically.",
      "",
      false,
      false
    );
  }
}

async function installUpdate() {
  if (!invoke || !pendingUpdateVersion) return;
  renderUpdateState(
    "Downloading KOVA " + pendingUpdateVersion + "…",
    "",
    false,
    false
  );
  try {
    const installed = await invoke("install_update");
    setUpdateBadge(false);
    renderUpdateState(
      "KOVA " + installed + " is ready. Restart to finish the update.",
      "",
      false,
      true
    );
  } catch (err) {
    setStatus("Update failed: " + err, true);
    renderUpdateState(
      "Update failed — your installed version is untouched. Try again from the Updates card.",
      "",
      true,
      false
    );
  }
}

async function restartForUpdate() {
  if (!invoke) return;
  try {
    await invoke("restart_app");
  } catch (err) {
    setStatus("Couldn't restart: " + err, true);
  }
}

function renderFolders() {
  folderListEl.innerHTML = "";
  const folders = (appState && appState.standalone_folders) || [];
  if (folders.length === 0) {
    folderListEl.appendChild(
      el("p", "empty-note", "No custom folders — using ~/Games and ~/KOVA Games.")
    );
    return;
  }
  for (const folder of folders) {
    const row = el("div", "folder-row");
    row.appendChild(el("span", "folder-path", folder));
    const remove = el("button", "ghost folder-remove", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => saveFolders(folders.filter((f) => f !== folder)));
    row.appendChild(remove);
    folderListEl.appendChild(row);
  }
}

async function saveFolders(folders) {
  if (!invoke) return;
  try {
    const updated = await invoke("set_standalone_folders", { folders });
    if (updated) appState = normalizeState(updated);
    renderFolders();
    scan();
  } catch (err) {
    setStatus("Could not save folders: " + err, true);
  }
}

// ---------------------------------------------------------------- scan

// Re-render every data-driven view from the current scan +
// state. Used after scans and after profile edits.
function renderAll() {
  renderHero();
  renderQuickResume();
  renderFavorites();
  renderAvokStore();
  renderShelves();
  renderHeaderProfile();
  renderProfile();
  renderHiddenSettings();
  if (lastResult) {
    renderSummary();
    renderFilters();
    renderGrid();
  }
  // v1.2.0: the Store view, the Kids time indicator, the Big
  // Picture grid, and the Settings extras re-render with the rest.
  if (window.KovaV12) {
    if (window.KovaV12.renderKidsBanner) window.KovaV12.renderKidsBanner();
    if (window.KovaV12.renderStore) window.KovaV12.renderStore();
    if (window.KovaV12.renderBigPictureGrid) window.KovaV12.renderBigPictureGrid();
    if (window.KovaV12.renderSettingsExtras) window.KovaV12.renderSettingsExtras();
  }
}

function render(result) {
  lastResult = result;
  renderAll();
}

async function scan() {
  if (!invoke) {
    setStatus(
      "Tauri runtime not detected. Launch KOVA with `npm run tauri dev` " +
        "(see the project README) — or use the kova-scan CLI for a headless scan.",
      true
    );
    return;
  }
  setStatus("Scanning your library…", false);
  const path = pathInput.value.trim();
  try {
    const result = await invoke("scan_library", {
      path: path.length > 0 ? path : null,
    });
    // Slice 5.1: the scan migrated the persisted state on the
    // backend (recents resolved to their library records,
    // profiles stranded under snapshot keys folded into the
    // resolved keys). Re-read the state so Quick Resume renders
    // the resolved records, not the pre-scan snapshots this page
    // loaded at startup.
    try {
      const state = await invoke("get_state");
      if (state) appState = normalizeState(state);
    } catch (err) {
      /* keep the state we have */
    }
    render(result);
    setStatus("", false);
  } catch (err) {
    setStatus("Scan failed: " + err, true);
  }
}

async function loadState() {
  if (!invoke) return;
  try {
    const state = await invoke("get_state");
    if (state) appState = normalizeState(state);
  } catch (err) {
    /* defaults are fine */
  }
  renderQuickResume();
  renderFolders();
  renderHiddenSettings();
  renderHeaderProfile();
  renderProfileSettings();
  // v1.2.0: the Kids daily counter resets on a new day, and a
  // fresh install gets the (skippable) onboarding flow.
  if (window.KovaV12) {
    if (window.KovaV12.maybeResetKidsDay) window.KovaV12.maybeResetKidsDay();
    if (window.KovaV12.maybeShowOnboarding) window.KovaV12.maybeShowOnboarding();
  }
}

// ---------------------------------------------------------------- init

for (const btn of tabBtns) {
  btn.addEventListener("click", () => showView(btn.dataset.view));
}
if (headerProfileBtn) {
  headerProfileBtn.addEventListener("click", () => showView("profile"));
}
if (profileSaveBtn) {
  profileSaveBtn.addEventListener("click", saveGamerProfile);
}
if (avatarUploadBtn && avatarUploadInput) {
  avatarUploadBtn.addEventListener("click", () => avatarUploadInput.click());
  avatarUploadInput.addEventListener("change", async () => {
    const file = avatarUploadInput.files && avatarUploadInput.files[0];
    // Clear the input so picking the same file again still fires.
    avatarUploadInput.value = "";
    if (!file) return;
    try {
      stagedAvatar = await downscaleAvatar(file);
      renderAvatarOptions();
      setStatus("Picture ready — Save profile to keep it.", false);
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });
}
detailBackBtn.addEventListener("click", () => showView("library"));
rescanBtn.addEventListener("click", scan);
folderAddBtn.addEventListener("click", () => {
  const value = folderInput.value.trim();
  if (!value) return;
  const folders = [...((appState && appState.standalone_folders) || [])];
  if (!folders.includes(value)) folders.push(value);
  folderInput.value = "";
  saveFolders(folders);
});
folderInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") folderAddBtn.click();
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderGrid();
});
sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value;
  renderGrid();
});
showHiddenToggle.addEventListener("change", async () => {
  if (!invoke) return;
  try {
    const updated = await invoke("set_show_hidden_games", {
      show: showHiddenToggle.checked,
    });
    if (updated) appState = normalizeState(updated);
    renderAll();
  } catch (err) {
    setStatus("Could not save the visibility setting: " + err, true);
    showHiddenToggle.checked = Boolean(appState.show_hidden_games);
  }
});

hotkeyHintEl.textContent = /Mac/i.test(navigator.userAgent)
  ? "⌘+Shift+K"
  : "Ctrl+Shift+K";

// Slice 6: gamepad/keyboard navigation. Back walks detail ->
// Library -> Home and stops at Home; Start/Guide returns Home.
// The navigator owns arrows/Enter/Space/Escape and the gamepad;
// form fields keep their native keys (see nav.js).
// v1.2.0 §10: Back first closes Big Picture when it is open,
// and the Y button toggles Big Picture.
if (window.KovaNav) {
  window.KovaNav.init({
    onBack: () => {
      if (window.KovaV12 && window.KovaV12.isBigPictureOpen && window.KovaV12.isBigPictureOpen()) {
        window.KovaV12.closeBigPicture();
        return;
      }
      if (currentView === "detail") showView("library");
      else if (currentView !== "home") showView("home");
    },
    onHome: () => showView("home"),
    onBigPicture: () => {
      if (window.KovaV12 && window.KovaV12.toggleBigPicture) window.KovaV12.toggleBigPicture();
    },
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  renderHero();
  await loadState();
  // Render the profile face and the store from the first paint,
  // even before the scan lands (and even without a Tauri runtime:
  // the honest empty states, not blank sections). The scan
  // re-renders everything with data.
  renderHeaderProfile();
  renderProfile();
  renderAvokStore();
  renderShelves();
  renderGrid();
  scan();
  // Deep-linkable views: #library, #profile, or #settings open
  // that view on load. #detail has no game to show, so it falls
  // back to Home.
  const hashView = (window.location.hash || "").replace(/^#/, "");
  if (hashView === "library" || hashView === "profile" || hashView === "settings" || hashView === "store") {
    showView(hashView);
  }
  if (updateCheckBtn) updateCheckBtn.addEventListener("click", () => checkForUpdates(true));
  if (updateInstallBtn) updateInstallBtn.addEventListener("click", installUpdate);
  if (updateRestartBtn) updateRestartBtn.addEventListener("click", restartForUpdate);
  renderWhatsNew();
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
});
