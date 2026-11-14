// KOVA Quick Panel (overlay window) — plain JS, no framework.
// Backend commands (see src-tauri/src/lib.rs):
//   invoke("scan_library", { path: null }) -> annotated library JSON
//   invoke("launch_game", { gameJson })    -> launch + record stats
//        and recents; returns the updated state
//   invoke("get_state")                    -> { recents,
//        standalone_folders, profiles, show_hidden_games,
//        gamer_profile, wishlist }
//   invoke("game_icon", { gameJson })      -> cached local .app icon path?
//   invoke("back_to_main")                 -> hide overlay, focus main
//   invoke("hide_overlay")                 -> hide overlay only
// Slice 5: the panel merges the persisted profiles over the scan —
// favorites lead the list (marked "Fav"), hidden games never appear,
// and titles show their display-name overrides.
// The last scan is cached in this page's memory: the overlay window
// stays alive (hidden) for the app's lifetime, so reopening the
// panel shows the cached library instantly; "Rescan" refreshes it.
// Quick Resume is re-read from the persisted state whenever the
// panel gains focus, so it stays current with the main window.

const invoke =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.invoke
    : null;
const convertFileSrc =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.convertFileSrc
    : null;

const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const recentsEl = document.getElementById("recents");
const recentsListEl = document.getElementById("recents-list");
const refreshBtn = document.getElementById("refresh");
const backBtn = document.getElementById("back");
const hotkeyHintEl = document.getElementById("hotkey-hint");
const panelGamertagEl = document.getElementById("panel-gamertag");
const controllerStatusEl = document.getElementById("controller-status");

const SOURCE_LABELS = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  itch: "itch",
  standalone: "Standalone",
  avok: "Avok",
};

// Slice 5.2 — Avok title art (mirrors main.js). The Avok desktop
// builds ship the Avok studio mark as their app icon, so layering
// a mapped record's bundle icon would show the studio mark
// instead of the game's own logo. The mapped files are Mac-side
// build inputs living in app/src/ (see README, slice 5.2) — they
// are NOT in this repo tree. The Open World entry is the OW
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

// Render a mapped Avok title's own game art into a row/card
// instead of its bundle icon. Returns true when a mapped <img>
// was added (the caller then skips attachLocalIcon); false
// otherwise. A missing file removes itself on error, leaving the
// row/card's generated presentation.
function attachAvokGameArt(game, container, className) {
  const file = avokGameArtFile(game);
  if (!file) return false;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.loading = "lazy";
  img.src = file;
  img.addEventListener("error", () => img.remove());
  container.prepend(img);
  return true;
}

let cachedLibrary = null;
let profilesMap = {};
let kidsSettings = { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: "" };
const localIconRequests = new Map();

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
  statusEl.hidden = message.length === 0;
}

// Mirrors main.js: an Avok record with an install path and a
// non-web launch target is the locally installed Mac app.
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

// Layer a local bundle's real icon into a row/card. Mirrors
// main.js (slice 5.1): the <img> is created SYNCHRONOUSLY while
// the row/card is being built and only its `src` is set when the
// cached icon-path promise resolves — the old post-await
// creation behind an `isConnected` gate could silently drop the
// icon on fast (post-launch) re-renders. Failure simply keeps
// the panel's generated presentation.
function attachLocalIcon(game, container, className) {
  if (!invoke || !convertFileSrc || !hasLocalAppBundle(game)) return;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.remove());
  container.prepend(img);
  localIconPath(game).then((iconPath) => {
    if (!iconPath) {
      img.remove();
      return;
    }
    img.src = convertFileSrc(iconPath);
  });
}

function installedMarker() {
  const marker = document.createElement("span");
  marker.className = "installed-marker";
  marker.textContent = "Installed";
  return marker;
}

function favMarker() {
  const marker = document.createElement("span");
  marker.className = "fav-marker";
  marker.textContent = "Fav";
  marker.title = "Favorite";
  return marker;
}

// ------------------------------------------------------------- profiles

// Mirrors main.js / kova-core: the key is "<source>:<id>", and the
// persisted profile supplies the display name, favorite and
// hidden flags over the scanned record.
function profileKey(game) {
  return game.source + ":" + game.id;
}

function mergeProfile(game) {
  const merged = Object.assign({}, game);
  merged.key = profileKey(game);
  const profile = profilesMap[merged.key];
  if (profile) {
    const override = (profile.name_override || "").trim();
    merged.display_name = override || game.name;
    merged.favorite = Boolean(profile.favorite);
    merged.hidden = Boolean(profile.hidden);
  } else {
    merged.display_name = game.display_name || game.name;
    merged.favorite = Boolean(game.favorite);
    merged.hidden = Boolean(game.hidden);
  }
  return merged;
}

function displayName(game) {
  return game.display_name || game.name;
}

async function launch(game, button) {
  if (!invoke || !game.launch_uri) return;
  // v1.2.0 §10 — the Kids shelf gate, mirrored from the main
  // window: launching outside the allowed games (or past the
  // daily limit) is blocked with a plain message.
  if (kidsSettings.enabled) {
    if (!(kidsSettings.allowed_keys || []).includes(profileKey(game))) {
      setStatus(displayName(game) + " is not on the Kids shelf.", true);
      return;
    }
    if (
      kidsSettings.daily_limit_minutes !== null &&
      kidsSettings.daily_limit_minutes !== undefined &&
      (kidsSettings.minutes_used_today || 0) >= kidsSettings.daily_limit_minutes
    ) {
      setStatus("Today's play time is used up — the Kids shelf limit has been reached.", true);
      return;
    }
  }
  button.disabled = true;
  try {
    // launch_game launches and records the launch (stats +
    // recents) in the backend, returning the updated state.
    const updated = await invoke("launch_game", { gameJson: game });
    setStatus(
      "Launching " + displayName(game) + " via " + sourceLabel(game.source) + "…",
      false
    );
    if (updated) {
      profilesMap = updated.profiles || {};
      renderRecents(updated.recents);
      if (cachedLibrary) render(cachedLibrary);
    }
  } catch (err) {
    setStatus("Launch failed for " + displayName(game) + ": " + err, true);
  } finally {
    button.disabled = false;
  }
}

function gameRow(game) {
  const row = document.createElement("div");
  row.className = "game-row";
  // Slice 6: rows are navigation stops (activation presses the
  // row's Play button via nav.js); the row itself has no click.
  row.tabIndex = 0;
  row.dataset.navKey = game.key;
  // Slice 5.2 skip rule: a mapped Avok title shows its own game
  // art in the row instead of the bundle icon (the studio mark).
  // Unmapped records keep the bundle-icon layer.
  if (!attachAvokGameArt(game, row, "row-game-art")) {
    attachLocalIcon(game, row, "row-icon");
  }

  const name = document.createElement("span");
  name.className = "game-name";
  name.textContent = displayName(game);
  row.appendChild(name);

  if (game.favorite) row.appendChild(favMarker());

  const tag = document.createElement("span");
  tag.className = "tag tag-" + game.source;
  tag.textContent = sourceLabel(game.source);
  row.appendChild(tag);

  if (isLocalInstall(game)) row.appendChild(installedMarker());

  if (game.launch_uri) {
    const launchBtn = document.createElement("button");
    launchBtn.type = "button";
    launchBtn.className = "play";
    launchBtn.textContent = game.source === "avok" ? "Open" : "Launch";
    launchBtn.addEventListener("click", () => launch(game, launchBtn));
    row.appendChild(launchBtn);
  }

  return row;
}

function render(library) {
  listEl.innerHTML = "";
  // Hidden games never appear in the panel; favorites lead,
  // ordered by display name within each group (the core's
  // favorites-first ordering, mirrored here).
  const games = library.sources
    .flatMap((report) => report.games)
    .map(mergeProfile)
    .filter((game) => !game.hidden)
    .filter((game) => !kidsSettings.enabled || (kidsSettings.allowed_keys || []).includes(game.key))
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        displayName(a)
          .toLowerCase()
          .localeCompare(displayName(b).toLowerCase()) ||
        a.key.localeCompare(b.key)
    );
  for (const game of games) {
    listEl.appendChild(gameRow(game));
  }

  if (games.length === 0) {
    setStatus(
      "No games found in Steam, Epic, GOG, itch, or your standalone folders on this machine.",
      false
    );
  } else {
    setStatus(games.length + " games in your library.", false);
  }
}

function renderRecents(recents) {
  recentsListEl.innerHTML = "";
  const visible = (recents || [])
    .map(mergeProfile)
    .filter((game) => !game.hidden)
    .filter((game) => !kidsSettings.enabled || (kidsSettings.allowed_keys || []).includes(game.key));
  if (visible.length === 0) {
    recentsEl.hidden = true;
    return;
  }
  recentsEl.hidden = false;
  for (const game of visible) {
    const card = document.createElement("div");
    card.className = "recent-card art-" + game.source;
    // Slice 6: cards are navigation stops like rows (activation
    // presses the card's Play button via nav.js).
    card.tabIndex = 0;
    card.dataset.navKey = game.key;
    // Slice 5.2 skip rule, same as rows: mapped Avok art replaces
    // the bundle-icon layer on Quick Resume cards too.
    if (!attachAvokGameArt(game, card, "recent-game-art")) {
      attachLocalIcon(game, card, "recent-icon");
    }

    const initial = document.createElement("span");
    initial.className = "recent-initial";
    initial.textContent = (displayName(game) || "?").trim().charAt(0).toUpperCase() || "?";
    card.appendChild(initial);

    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = displayName(game);
    card.appendChild(name);

    if (game.favorite) card.appendChild(favMarker());

    if (isLocalInstall(game)) card.appendChild(installedMarker());

    if (game.launch_uri) {
      const launchBtn = document.createElement("button");
      launchBtn.type = "button";
      launchBtn.className = "play recent-play";
      launchBtn.textContent = game.source === "avok" ? "Open" : "Launch";
      launchBtn.addEventListener("click", () => launch(game, launchBtn));
      card.appendChild(launchBtn);
    }

    recentsListEl.appendChild(card);
  }
}

async function loadState() {
  if (!invoke) return;
  try {
    const state = await invoke("get_state");
    profilesMap = (state && state.profiles) || {};
    // v1.2.0 §10: the Kids gate state travels with the panel.
    if (state && state.kids) kidsSettings = state.kids;
    renderRecents(state && state.recents);
    // v1.1.1: the gamertag travels with the panel — the same
    // identity as the main window. Hidden until a gamertag is set.
    if (panelGamertagEl) {
      const tag =
        state && state.gamer_profile && (state.gamer_profile.gamertag || "").trim();
      panelGamertagEl.textContent = tag || "";
      panelGamertagEl.hidden = !tag;
    }
    // Display names / favorites / hidden flags may have changed
    // in the main window since the cached scan.
    if (cachedLibrary) render(cachedLibrary);
  } catch (err) {
    recentsEl.hidden = true;
  }
}

async function scan() {
  if (!invoke) {
    setStatus("Tauri runtime not detected in the overlay window.", true);
    return;
  }
  setStatus("Scanning your library…", false);
  try {
    cachedLibrary = await invoke("scan_library", { path: null });
    render(cachedLibrary);
    // Slice 5.1: the scan migrated the persisted state on the
    // backend (recents resolved, stranded profiles folded) —
    // re-read it so Quick Resume shows the resolved records.
    loadState();
  } catch (err) {
    setStatus("Scan failed: " + err, true);
  }
}

refreshBtn.addEventListener("click", () => {
  scan();
  loadState();
});

backBtn.addEventListener("click", async () => {
  if (invoke) {
    try {
      await invoke("back_to_main");
    } catch (err) {
      setStatus("Could not return to KOVA: " + err, true);
    }
  }
});

// Slice 6: Escape handling moved to the shared navigator
// (nav.js) — its back action hides the panel, and gamepad B does
// the same. Start/Guide returns to the main window.

// The panel is shown by focusing its window — a good moment to make
// sure Quick Resume reflects launches from the main window, and to
// land navigation on the first row when the panel is summoned
// (hotkey use is keyboard-first by nature; mouse users lose the
// ring on their first pointer press, per nav.js).
window.addEventListener("focus", loadState);
// First summon only: land navigation on the first row when the
// panel first gains focus with nothing focused. Later summons
// re-anchor through nav.js (last stop, when navigating) or leave
// mouse focus alone — so a click back into the panel never yanks
// focus to the first row.
let panelStopFocused = false;
window.addEventListener("focusin", () => {
  panelStopFocused = true;
});
window.addEventListener("focus", () => {
  if (
    !panelStopFocused &&
    document.activeElement === document.body &&
    window.KovaNav
  ) {
    window.KovaNav.focusFirst();
  }
});

// Slice 6: gamepad/keyboard navigation, wired to the panel's own
// meanings of back (hide) and home (back to the main window).
if (window.KovaNav) {
  window.KovaNav.init({
    onBack: () => {
      if (invoke) invoke("hide_overlay").catch(() => {});
    },
    onHome: () => {
      if (invoke) invoke("back_to_main").catch(() => {});
    },
  });
}

hotkeyHintEl.textContent = /Mac/i.test(navigator.userAgent)
  ? "⌘+Shift+K"
  : "Ctrl+Shift+K";

// v1.2.0 §10 — controller status in the Quick Panel. Lists
// connected controllers by their Gamepad API id. Battery level
// is NOT exposed by the API, so it is never shown — the panel
// says so plainly instead of inventing a number.
function renderControllerStatus() {
  if (!controllerStatusEl) return;
  controllerStatusEl.innerHTML = "";
  const heading = document.createElement("h3");
  heading.className = "controller-title";
  heading.textContent = "Controllers";
  controllerStatusEl.appendChild(heading);
  let pads = [];
  try {
    if (typeof navigator !== "undefined" && navigator.getGamepads) {
      pads = Array.from(navigator.getGamepads()).filter(Boolean);
    }
  } catch (err) {
    pads = [];
  }
  if (pads.length === 0) {
    const none = document.createElement("p");
    none.className = "controller-none";
    none.textContent = "No controller connected.";
    controllerStatusEl.appendChild(none);
  } else {
    for (const pad of pads) {
      const row = document.createElement("p");
      row.className = "controller-row";
      row.textContent = pad.id || "Controller " + pad.index;
      controllerStatusEl.appendChild(row);
    }
  }
  const batteryNote = document.createElement("p");
  batteryNote.className = "controller-note";
  batteryNote.textContent = "Battery level isn't available — the Gamepad API doesn't expose it.";
  controllerStatusEl.appendChild(batteryNote);
}

window.addEventListener("gamepadconnected", renderControllerStatus);
window.addEventListener("gamepaddisconnected", renderControllerStatus);
window.addEventListener("focus", renderControllerStatus);

window.addEventListener("DOMContentLoaded", () => {
  loadState();
  renderControllerStatus();
  if (cachedLibrary) {
    render(cachedLibrary);
  } else {
    scan();
  }
});
