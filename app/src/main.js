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
//        standalone_folders, profiles, show_hidden_games }
//   invoke("set_profile", { key, profile })   -> upsert a game profile
//   invoke("clear_profile", { key })          -> remove a game profile
//   invoke("set_show_hidden_games", { show })  -> updated state
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
const tabBtns = Array.from(document.querySelectorAll(".tab"));
const views = {
  home: document.getElementById("view-home"),
  library: document.getElementById("view-library"),
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
// removes itself on error). The Open World entry is the OLD globe
// mark: a newer TOW icon exists elsewhere and Dre has NOT picked
// it, so it is referenced nowhere here.
const AVOK_GAME_ART = {
  "avok:dispatch-hq": "dispatch-hq-badge.png",
  "avok:the-open-world": "the-open-world-mark.png",
};

function avokGameArtFile(game) {
  if (!game) return null;
  return AVOK_GAME_ART[profileKey(game)] || null;
}

// --------------------------------------------------------------- state

let lastResult = null;
let appState = {
  recents: [],
  standalone_folders: [],
  profiles: {},
  show_hidden_games: false,
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
function normalizeState(state) {
  return Object.assign(
    {
      recents: [],
      standalone_folders: [],
      profiles: {},
      show_hidden_games: false,
    },
    state || {}
  );
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
  } else {
    merged.display_name = game.display_name || game.name;
    merged.favorite = Boolean(game.favorite);
    merged.hidden = Boolean(game.hidden);
    merged.launch_args = game.launch_args || "";
    merged.art_url_override = game.art_url_override || null;
    merged.launch_count = game.launch_count || 0;
    merged.last_launched =
      game.last_launched === undefined ? null : game.last_launched;
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
  window.scrollTo({ top: 0 });
  // Slice 6: a view switch swaps the visible focus scope, so let
  // the navigator re-anchor (it keeps focus when the focused
  // element survived, and never steals it from the mouse user).
  if (window.KovaNav) window.KovaNav.refresh();
}

// -------------------------------------------------------------- launch

async function launchGame(game, button) {
  if (!invoke || !game.launch_uri) return;
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
  if (game.favorite) badges.push(el("span", "fav-badge", "★ Favorite"));
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
  copy.appendChild(el("div", "hero-eyebrow", "AVOK INTERACTIVE · FEATURED"));
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
    .filter((game) => !game.hidden);
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
  if (!lastResult) {
    shelvesEl.appendChild(el("p", "empty-note", "Scanning your library…"));
    return;
  }
  // The Avok shelf leads; store strips follow in canonical order,
  // and a source with no games simply gets no strip.
  const ordered = [...lastResult.sources].sort((a, b) => {
    const rank = (s) => (s === "avok" ? -1 : SOURCE_ORDER.indexOf(s));
    return rank(a.source) - rank(b.source);
  });
  let rendered = 0;
  for (const report of ordered) {
    const games = gamesForSource(report.source).filter((g) => !g.hidden);
    if (games.length === 0) continue;
    rendered += 1;
    const shelf = el("div", "shelf");
    const head = el("div", "shelf-head");
    head.appendChild(
      el("h3", "shelf-title", report.source === "avok" ? "Avok Interactive" : sourceLabel(report.source))
    );
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

// ------------------------------------------------------------- library

// Games the Library should count and show before search + sort:
// the source chip's games, with hidden games excluded unless the
// Settings toggle says otherwise.
function libraryGames() {
  const showHidden = Boolean(appState.show_hidden_games);
  return allGames().filter((game) => {
    if (activeFilter !== "all" && game.source !== activeFilter) return false;
    if (game.hidden && !showHidden) return false;
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
  body.appendChild(table);

  const action = actionButton(game);
  if (action) {
    action.classList.add("detail-play");
    body.appendChild(action);
  } else {
    body.appendChild(el("p", "empty-note", "This title has no launch target on this machine."));
  }

  body.appendChild(renderProfileSection(game));
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
    profile.favorite ? "★ Favorited" : "☆ Favorite"
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
  renderShelves();
  renderHiddenSettings();
  if (lastResult) {
    renderSummary();
    renderFilters();
    renderGrid();
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
}

// ---------------------------------------------------------------- init

for (const btn of tabBtns) {
  btn.addEventListener("click", () => showView(btn.dataset.view));
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
if (window.KovaNav) {
  window.KovaNav.init({
    onBack: () => {
      if (currentView === "detail") showView("library");
      else if (currentView !== "home") showView("home");
    },
    onHome: () => showView("home"),
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  renderHero();
  await loadState();
  scan();
  if (updateCheckBtn) updateCheckBtn.addEventListener("click", () => checkForUpdates(true));
  if (updateInstallBtn) updateInstallBtn.addEventListener("click", installUpdate);
  if (updateRestartBtn) updateRestartBtn.addEventListener("click", restartForUpdate);
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
});
