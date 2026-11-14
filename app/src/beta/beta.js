// KOVA beta shell — v1.2.0 workstream C. Plain JS, no framework.
// Talks to the same Tauri commands and kova-state.json as the
// classic shell (see the workstream A contract in the task brief).
//
// Graceful degradation: every invoke goes through call(), which
// returns null when there is no Tauri global (the design gate) or
// when a command fails. Views render empty states in that case and
// never crash. The shell guard in index.html redirects to classic
// when the app is present but the beta is not opted in / selected.
//
// DEMO MODE (design gate only): with no Tauri global AND
// ?demo=1, the shell renders from the small sample dataset below
// so the inspector can measure real layout density. It can never
// trigger inside the app — invoke always exists there. The sample
// games are real titles (Avok's own two, plus four real Steam
// games with their real appids); the gamertag and hours are
// stand-ins for the gate, listed in the workstream report.

"use strict";

const invoke =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.invoke
    : null;
const convertFileSrc =
  window.__TAURI__ && window.__TAURI__.core
    ? window.__TAURI__.core.convertFileSrc
    : null;

const QUERY = new URLSearchParams(window.location.search);
const DEMO = !invoke && QUERY.get("demo") === "1";

// ------------------------------------------------------------------ toast

const toastEl = document.getElementById("toast");
let toastTimer = null;
function setStatus(message, isError) {
  if (!toastEl) return;
  if (!message) {
    toastEl.hidden = true;
    return;
  }
  toastEl.textContent = message;
  toastEl.classList.toggle("error", Boolean(isError));
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 5000);
}

// ------------------------------------------------------------- invoke wrap

async function call(cmd, args) {
  if (DEMO) return demoCall(cmd, args || {});
  if (!invoke) return null;
  try {
    return await invoke(cmd, args || {});
  } catch (err) {
    console.warn("KOVA beta: " + cmd + " failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------- constants

const SOURCE_LABELS = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  itch: "itch",
  standalone: "Standalone",
  avok: "Avok",
};
const SOURCE_ORDER = ["steam", "epic", "gog", "itch", "standalone", "avok"];
const IMAGE_MAX_CHARS = 300000; // ~200 KB image, base64 — the backend cap

// Avok title art, keyed by profile key. The OW explorer badge
// (the-open-world-badge.png, transparent) is the real TOW logo —
// v1.2.1, Dre's correction 2026-11-14; the globe was a misread
// and is retired. Files live in app/src/assets/; a missing
// file removes itself on error. The Avok studio mark is NEVER
// game art: mapped titles skip the bundle-icon layer for exactly
// that reason (the Avok builds' bundle icon is the studio mark).
const AVOK_GAME_ART = {
  "avok:dispatch-hq": "../assets/dispatch-hq-badge.png",
  "avok:the-open-world": "../assets/the-open-world-badge.png",
};

// Built-in avatar options, drawn in code — same values as classic
// ("", "builtin:mark", "builtin:orbit", "builtin:bolt"), so a
// choice made here reads correctly in the classic shell.
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

const ACCENTS = [
  { id: "cyan", label: "Cyan", swatch: "#00d8f0" },
  { id: "raspberry", label: "Raspberry", swatch: "#b8336a" },
  { id: "amber", label: "Amber", swatch: "#f2a33c" },
  // Emerald values chosen for this shell: deep green #0e7a4d,
  // pale mint #e6f7ee, track #c9ecd9, ink #0a4d30 (beta.css).
  { id: "emerald", label: "Emerald", swatch: "#0e7a4d" },
];

// ---------------------------------------------------------------- demo data
// Gate-only sample data (see the header note). Real titles, real
// appids; the hours and journal words are stand-ins.

const DEMO_NOW = Math.floor(Date.now() / 1000);
const DEMO_GAMES = [
  {
    source: "avok", id: "dispatch-hq", appid: 0, name: "Dispatch HQ",
    installdir: "", install_path: "", size_on_disk: 0, last_updated: 0,
    library: "built-in", launch_uri: "https://dispatch-hq.onrender.com",
  },
  {
    source: "avok", id: "the-open-world", appid: 0, name: "The Open World",
    installdir: "", install_path: "", size_on_disk: 0, last_updated: 0,
    library: "built-in", launch_uri: "https://www.reddit.com/r/The_Open_World/",
  },
  {
    source: "steam", id: "413150", appid: 413150, name: "Stardew Valley",
    installdir: "Stardew Valley", install_path: "/Games/Stardew Valley",
    size_on_disk: 536870912, last_updated: 0, library: "/Games",
    launch_uri: "steam://rungameid/413150",
  },
  {
    source: "steam", id: "1145360", appid: 1145360, name: "Hades",
    installdir: "Hades", install_path: "/Games/Hades",
    size_on_disk: 16106127360, last_updated: 0, library: "/Games",
    launch_uri: "steam://rungameid/1145360",
  },
  {
    source: "steam", id: "504230", appid: 504230, name: "Celeste",
    installdir: "Celeste", install_path: "/Games/Celeste",
    size_on_disk: 1288490188, last_updated: 0, library: "/Games",
    launch_uri: "steam://rungameid/504230",
  },
  {
    source: "steam", id: "2379780", appid: 2379780, name: "Balatro",
    installdir: "Balatro", install_path: "/Games/Balatro",
    size_on_disk: 214748364, last_updated: 0, library: "/Games",
    launch_uri: "steam://rungameid/2379780",
  },
  {
    source: "standalone", id: "/Applications/Ember Fist.app", appid: 0,
    name: "Ember Fist", installdir: "", install_path: "/Applications/Ember Fist.app",
    size_on_disk: 0, last_updated: 0, library: "/Applications",
    launch_uri: "/Applications/Ember Fist.app",
  },
  {
    source: "itch", id: "tiny-rogue", appid: 0, name: "Tiny Rogue",
    installdir: "Tiny Rogue", install_path: "/Games/Tiny Rogue",
    size_on_disk: 0, last_updated: 0, library: "/Games",
    launch_uri: "/Games/Tiny Rogue",
  },
];
const DEMO_STATE = {
  recents: [DEMO_GAMES[3], DEMO_GAMES[2], DEMO_GAMES[0]],
  standalone_folders: [],
  profiles: {
    "steam:1145360": {
      favorite: true, hidden: false, launch_args: "", launch_count: 42,
      last_launched: DEMO_NOW - 3600, total_play_seconds: 61 * 3600 + 1200,
      last_session_seconds: 5400, last_session_end: DEMO_NOW - 3600,
      rating: 5, note: "Heat 12 with the rail. Next run: try the fists.",
      perf_launch_preset: null, perf_show_fps: false, perf_priority: "normal",
      launch_mode: null, cover_art: null, save_folder: null,
    },
    "steam:413150": {
      favorite: true, hidden: false, launch_args: "", launch_count: 31,
      last_launched: DEMO_NOW - 86400 * 2, total_play_seconds: 84 * 3600,
      last_session_seconds: 7200, last_session_end: DEMO_NOW - 86400 * 2,
      rating: 5, note: null, perf_launch_preset: null, perf_show_fps: false,
      perf_priority: "normal", launch_mode: null, cover_art: null,
      save_folder: null,
    },
    "steam:504230": {
      favorite: false, hidden: false, launch_args: "", launch_count: 18,
      last_launched: DEMO_NOW - 86400 * 5, total_play_seconds: 23 * 3600,
      last_session_seconds: 3600, last_session_end: DEMO_NOW - 86400 * 5,
      rating: 4, note: "Chapter 7 B-side is still waiting.",
      perf_launch_preset: null, perf_show_fps: false, perf_priority: "normal",
      launch_mode: null, cover_art: null, save_folder: null,
    },
    "steam:2379780": {
      favorite: false, hidden: false, launch_args: "", launch_count: 57,
      last_launched: DEMO_NOW - 86400, total_play_seconds: 19 * 3600,
      last_session_seconds: 1800, last_session_end: DEMO_NOW - 86400,
      rating: null, note: null, perf_launch_preset: null, perf_show_fps: false,
      perf_priority: "normal", launch_mode: null, cover_art: null,
      save_folder: null,
    },
    "avok:dispatch-hq": {
      favorite: true, hidden: false, launch_args: "", launch_count: 12,
      last_launched: DEMO_NOW - 86400 * 3, total_play_seconds: 0,
      last_session_seconds: 0, last_session_end: null,
      rating: 5, note: null, perf_launch_preset: null, perf_show_fps: false,
      perf_priority: "normal", launch_mode: null, cover_art: null,
      save_folder: null,
    },
    "standalone:/Applications/Ember Fist.app": {
      favorite: false, hidden: false, launch_args: "", launch_count: 6,
      last_launched: DEMO_NOW - 86400 * 6, total_play_seconds: 4 * 3600,
      last_session_seconds: 2400, last_session_end: DEMO_NOW - 86400 * 6,
      rating: null, note: null, perf_launch_preset: "unity-windowed-1080",
      perf_show_fps: true, perf_priority: "normal", launch_mode: "full",
      cover_art: null, save_folder: null,
    },
  },
  show_hidden_games: false,
  gamer_profile: {
    gamertag: "Dre",
    avatar: "",
    bio: "Building worlds. Playing them too.",
    banner: null,
  },
  wishlist: ["avok:dispatch-hq"],
  shelves: [
    { id: "playing-now", name: "Playing now", game_keys: ["steam:1145360", "steam:413150", "steam:2379780"], builtin: true },
    { id: "backlog", name: "Backlog", game_keys: ["steam:504230", "standalone:/Applications/Ember Fist.app", "itch:tiny-rogue"], builtin: true },
    { id: "finished", name: "Finished", game_keys: ["avok:the-open-world"], builtin: true },
  ],
  beta: { opted_in: true, ui: "beta", accent: "cyan", density: "comfortable", shelf_order: [] },
  kids: { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: null },
  sync: { enabled: false, folder: null, last_push_at: null, last_pull_at: null },
  journal: [
    { game_key: "steam:1145360", timestamp: DEMO_NOW - 3600, text: "Beat Theseus and Asterius first try tonight. The rail with lightning rod is the run." },
    { game_key: "steam:413150", timestamp: DEMO_NOW - 86400 * 2, text: "Finished the greenhouse. Ancient fruit goes in tomorrow." },
    { game_key: "steam:504230", timestamp: DEMO_NOW - 86400 * 5, text: "Chapter 6 B-side cleared after an hour on the last screen." },
  ],
  save_backups: [
    { game_key: "steam:413150", backed_up_at: DEMO_NOW - 86400, size_bytes: 48210, backup_name: "backup-1792000000" },
  ],
  milestones: ["first-launch", "ten-launches"],
};
const DEMO_LIBRARY = {
  sources: [
    { source: "avok", roots: [], games: [DEMO_GAMES[0], DEMO_GAMES[1]], skipped: 0 },
    { source: "steam", roots: [], games: [DEMO_GAMES[2], DEMO_GAMES[3], DEMO_GAMES[4], DEMO_GAMES[5]], skipped: 0 },
    { source: "standalone", roots: [], games: [DEMO_GAMES[6]], skipped: 0 },
    { source: "itch", roots: [], games: [DEMO_GAMES[7]], skipped: 0 },
  ],
  total_games: DEMO_GAMES.length,
};
const DEMO_CATALOG = {
  source: "bundled",
  catalog: {
    version: 1,
    listings: [
      {
        id: "dispatch-hq", title: "Dispatch HQ",
        description: "Run the city's emergency services from the dispatch desk: fire, police, and EMS. Every call is a decision, and every decision has a consequence.",
        art: null, download_url: "https://dispatch-hq.onrender.com",
        developer: "Avok Interactive", free: true, version: "0.55.0",
      },
      {
        id: "the-open-world", title: "The Open World",
        description: "A life sim that lives on Reddit. Build a life, earn, explore, and shape a world other players share.",
        art: null, download_url: "https://www.reddit.com/r/The_Open_World/",
        developer: "Avok Interactive", free: true, version: "0.108.29",
      },
    ],
  },
};
const DEMO_MILESTONES = {
  earned: ["first-launch", "ten-launches"],
  progress: [
    { id: "first-launch", title: "First launch", description: "Launch a game through KOVA.", earned: true, current: 1, target: 1 },
    { id: "ten-launches", title: "Ten launches", description: "Launch games 10 times.", earned: true, current: 10, target: 10 },
    { id: "hundred-launches", title: "A hundred launches", description: "Launch games 100 times.", earned: false, current: 42, target: 100 },
    { id: "ten-finished", title: "Ten finished", description: "Put 10 games on the Finished shelf.", earned: false, current: 1, target: 10 },
    { id: "five-hundred-hours", title: "500 hours", description: "Play 500 hours through KOVA.", earned: false, current: 191, target: 500 },
  ],
};
const DEMO_PRESETS = [
  { id: "source-fps30", label: "Source: cap 30 FPS", engine: "Source", args: ["+fps_max", "30"], is_fps_cap: true, note: "sent to the game; the game decides what to honor" },
  { id: "source-fps60", label: "Source: cap 60 FPS", engine: "Source", args: ["+fps_max", "60"], is_fps_cap: true, note: "sent to the game; the game decides what to honor" },
  { id: "source-fps120", label: "Source: cap 120 FPS", engine: "Source", args: ["+fps_max", "120"], is_fps_cap: true, note: "sent to the game; the game decides what to honor" },
  { id: "source-novid", label: "Source: skip intro videos", engine: "Source", args: ["-novid"], is_fps_cap: false, note: "sent to the game; the game decides what to honor" },
  { id: "unreal-windowed-1080", label: "Unreal: windowed 1080p", engine: "Unreal", args: ["-ResX=1920", "-ResY=1080", "-windowed"], is_fps_cap: false, note: "sent to the game; the game decides what to honor" },
  { id: "unreal-fullscreen-1080", label: "Unreal: fullscreen 1080p", engine: "Unreal", args: ["-ResX=1920", "-ResY=1080", "-fullscreen"], is_fps_cap: false, note: "sent to the game; the game decides what to honor" },
  { id: "unity-windowed-1080", label: "Unity: windowed 1080p", engine: "Unity", args: ["-screen-width", "1920", "-screen-height", "1080", "-screen-fullscreen", "0"], is_fps_cap: false, note: "sent to the game; the game decides what to honor" },
  { id: "unity-fullscreen-1080", label: "Unity: fullscreen 1080p", engine: "Unity", args: ["-screen-width", "1920", "-screen-height", "1080", "-screen-fullscreen", "1"], is_fps_cap: false, note: "sent to the game; the game decides what to honor" },
];

// Demo invoke stand-in: reads return the sample dataset; the
// writes the gate can reach update the in-memory demo state so the
// controls behave. Never used inside the app.
function demoCall(cmd, args) {
  switch (cmd) {
    case "get_state": return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "scan_library": return Promise.resolve(JSON.parse(JSON.stringify(DEMO_LIBRARY)));
    case "get_perf_presets": return Promise.resolve(DEMO_PRESETS);
    case "get_milestones": return Promise.resolve(JSON.parse(JSON.stringify(DEMO_MILESTONES)));
    case "get_journal": return Promise.resolve(DEMO_STATE.journal.slice());
    case "get_store_catalog": return Promise.resolve(JSON.parse(JSON.stringify(DEMO_CATALOG)));
    case "get_active_session":
      return Promise.resolve({ game_key: "steam:1145360", started_at: DEMO_NOW - 3720, elapsed_seconds: 3720 });
    case "get_disk_usage": {
      const games = DEMO_GAMES.map((g) => ({
        game_key: g.source + ":" + g.id, name: g.name,
        size_bytes: g.size_on_disk > 0 ? g.size_on_disk : null, complete: true,
      }));
      const total = games.reduce((sum, g) => sum + (g.size_bytes || 0), 0);
      return Promise.resolve({ games, total_bytes: total, unknown_count: games.filter((g) => g.size_bytes === null).length });
    }
    case "list_save_backups":
      return Promise.resolve(DEMO_STATE.save_backups.filter((b) => b.game_key === args.game_key));
    case "set_beta":
      DEMO_STATE.beta = Object.assign({}, DEMO_STATE.beta, args.beta || {});
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_gamer_profile":
      DEMO_STATE.gamer_profile = args.profile;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_shelves":
      DEMO_STATE.shelves = args.shelves;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_kids":
      DEMO_STATE.kids = args.kids;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_profile": {
      DEMO_STATE.profiles[args.key] = args.profile;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE.profiles)));
    }
    case "clear_profile":
      delete DEMO_STATE.profiles[args.key];
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE.profiles)));
    case "set_show_hidden_games":
      DEMO_STATE.show_hidden_games = args.show;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_wishlist":
      DEMO_STATE.wishlist = args.wishlist;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_standalone_folders":
      DEMO_STATE.standalone_folders = args.folders;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "set_sync_folder":
      DEMO_STATE.sync.folder = args.folder || null;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "push_state_to_sync":
      DEMO_STATE.sync.last_push_at = DEMO_NOW;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE.sync)));
    case "pull_state_from_sync":
      DEMO_STATE.sync.last_pull_at = DEMO_NOW;
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "add_journal_entry": {
      const entry = { game_key: args.game_key, timestamp: DEMO_NOW, text: args.text };
      DEMO_STATE.journal.push(entry);
      return Promise.resolve(DEMO_STATE.journal.slice());
    }
    case "backup_saves":
      return Promise.resolve({ backup_name: "backup-" + DEMO_NOW, size_bytes: 12345 });
    case "restore_save":
      return Promise.resolve({ game_key: args.game_key, backed_up_at: DEMO_NOW, size_bytes: 12345, backup_name: args.backup_name });
    case "import_state":
      return Promise.resolve(JSON.parse(JSON.stringify(DEMO_STATE)));
    case "check_update":
      return Promise.resolve({ available: false, version: null, current_version: "1.2.1", notes: null });
    case "launch_game":
    case "launch_uri":
    case "notify_update_available":
      return Promise.resolve(null);
    default:
      return Promise.resolve(null);
  }
}

// ------------------------------------------------------------------- utils

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function profileKey(game) {
  return game.source + ":" + game.id;
}
function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}
function displayName(game) {
  return game.display_name || game.name;
}
// A game launches "locally" when its launch target is a plain
// filesystem path rather than a store URI or web URL. Only those
// have a local process KOVA can pass launch arguments, a Metal HUD
// flag, or a priority to — the honesty rule behind the detail
// page's Performance tab (same rule as classic).
function launchesLocalPath(game) {
  return Boolean(game && game.launch_uri) && !game.launch_uri.includes("://");
}
function isAppBundle(game) {
  return Boolean(
    game &&
      (game.source === "standalone" || game.source === "avok") &&
      /\.app$/i.test(game.install_path || "")
  );
}
function fmtHours(seconds) {
  const hours = Math.floor((seconds || 0) / 3600);
  const minutes = Math.floor(((seconds || 0) % 3600) / 60);
  if (hours === 0) return minutes + "m";
  return hours + "h " + String(minutes).padStart(2, "0") + "m";
}
function fmtHoursShort(seconds) {
  const hours = (seconds || 0) / 3600;
  if (hours < 1) return Math.floor((seconds || 0) / 60) + "m";
  return (Math.round(hours * 10) / 10).toLocaleString("en-US") + "h";
}
function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  return m + ":" + String(sec).padStart(2, "0");
}
function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return (Math.round(value * 10) / 10).toLocaleString("en-US") + " " + units[unit];
}
function fmtDate(epochSeconds) {
  if (!epochSeconds) return "Never";
  return new Date(epochSeconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function fmtDateTime(epochSeconds) {
  if (!epochSeconds) return "Never";
  return new Date(epochSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function relativeDay(epochSeconds) {
  if (!epochSeconds) return "Never played";
  const then = new Date(epochSeconds * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((startOfToday - startOfThen) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return days + " days ago";
  return fmtDate(epochSeconds);
}
function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}
function downloadFile(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime || "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slugify(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Downscale an uploaded image on a canvas until its data URL fits
// the cap. `attempts` are tried in order (max dimension, type,
// quality); rejects with a plain message when nothing fits.
function downscaleImage(file, attempts) {
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
          if (dataUrl.length <= IMAGE_MAX_CHARS) {
            resolve(dataUrl);
            return;
          }
        }
        reject(
          new Error("That image is still too large after shrinking. Try a smaller file.")
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
const AVATAR_ATTEMPTS = [
  { size: 256, type: "image/png", quality: undefined },
  { size: 256, type: "image/jpeg", quality: 0.85 },
  { size: 192, type: "image/jpeg", quality: 0.7 },
];
const COVER_ATTEMPTS = [
  { size: 640, type: "image/jpeg", quality: 0.85 },
  { size: 480, type: "image/jpeg", quality: 0.75 },
  { size: 320, type: "image/jpeg", quality: 0.7 },
];
const BANNER_ATTEMPTS = [
  { size: 1200, type: "image/jpeg", quality: 0.8 },
  { size: 960, type: "image/jpeg", quality: 0.75 },
  { size: 720, type: "image/jpeg", quality: 0.7 },
];

// ------------------------------------------------------------------- state

let appState = null;
let library = null; // { sources: [{ source, roots, games, skipped }], total_games }
let perfPresets = null;
let milestonesData = null;
let catalogData = null;
let diskUsageData = null;
let activeSession = null;
let lastSessionSeen = null; // for kids minute crediting
let pendingUpdateVersion = null;

function defaultState() {
  return {
    recents: [],
    standalone_folders: [],
    profiles: {},
    show_hidden_games: false,
    gamer_profile: { gamertag: "", avatar: "", bio: "", banner: null },
    wishlist: [],
    shelves: [
      { id: "playing-now", name: "Playing now", game_keys: [], builtin: true },
      { id: "backlog", name: "Backlog", game_keys: [], builtin: true },
      { id: "finished", name: "Finished", game_keys: [], builtin: true },
    ],
    beta: { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] },
    kids: { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: null },
    sync: { enabled: false, folder: null, last_push_at: null, last_pull_at: null },
    journal: [],
    save_backups: [],
    milestones: [],
  };
}
function normalizeState(state) {
  const base = defaultState();
  const normalized = Object.assign(base, state || {});
  normalized.gamer_profile = Object.assign(
    { gamertag: "", avatar: "", bio: "", banner: null },
    (state && state.gamer_profile) || {}
  );
  normalized.beta = Object.assign(
    { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] },
    (state && state.beta) || {}
  );
  normalized.kids = Object.assign(
    { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: null },
    (state && state.kids) || {}
  );
  normalized.sync = Object.assign(
    { enabled: false, folder: null, last_push_at: null, last_pull_at: null },
    (state && state.sync) || {}
  );
  normalized.shelves = Array.isArray(normalized.shelves) ? normalized.shelves : base.shelves;
  normalized.profiles = normalized.profiles || {};
  normalized.recents = normalized.recents || [];
  normalized.journal = normalized.journal || [];
  normalized.save_backups = normalized.save_backups || [];
  return normalized;
}
function gamerProfile() {
  return (appState && appState.gamer_profile) || { gamertag: "", avatar: "", bio: "", banner: null };
}
function betaSettings() {
  return (appState && appState.beta) || { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] };
}
function kidsSettings() {
  return (appState && appState.kids) || { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: null };
}
function applyBetaTheme() {
  const beta = betaSettings();
  const accent = ACCENTS.some((a) => a.id === beta.accent) ? beta.accent : "cyan";
  document.documentElement.setAttribute("data-accent", accent);
  document.documentElement.setAttribute(
    "data-density",
    beta.density === "compact" ? "compact" : "comfortable"
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
    perf_launch_preset: null,
    perf_show_fps: false,
    perf_priority: "normal",
    total_play_seconds: 0,
    last_session_seconds: 0,
    last_session_end: null,
    rating: null,
    note: null,
    cover_art: null,
    save_folder: null,
    launch_mode: null,
  };
}
function storedProfile(game) {
  const key = typeof game === "string" ? game : profileKey(game);
  const stored = (appState.profiles || {})[key];
  return stored ? Object.assign(defaultProfile(), stored) : defaultProfile();
}
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
    merged.last_launched = profile.last_launched === undefined ? null : profile.last_launched;
    merged.total_play_seconds = profile.total_play_seconds || 0;
    merged.last_session_seconds = profile.last_session_seconds || 0;
    merged.last_session_end = profile.last_session_end === undefined ? null : profile.last_session_end;
    merged.rating = profile.rating === undefined ? null : profile.rating;
    merged.note = profile.note || null;
    merged.cover_art = profile.cover_art || null;
    merged.save_folder = profile.save_folder || null;
    merged.launch_mode = profile.launch_mode || null;
    merged.perf_launch_preset = profile.perf_launch_preset || null;
    merged.perf_show_fps = Boolean(profile.perf_show_fps);
    merged.perf_priority = profile.perf_priority || "normal";
  } else {
    merged.display_name = game.display_name || game.name;
    merged.favorite = Boolean(game.favorite);
    merged.hidden = Boolean(game.hidden);
    merged.launch_args = game.launch_args || "";
    merged.art_url_override = game.art_url_override || null;
    merged.launch_count = game.launch_count || 0;
    merged.last_launched = game.last_launched === undefined ? null : game.last_launched;
    merged.total_play_seconds = game.total_play_seconds || 0;
    merged.last_session_seconds = game.last_session_seconds || 0;
    merged.last_session_end = game.last_session_end === undefined ? null : game.last_session_end;
    merged.rating = game.rating === undefined ? null : game.rating;
    merged.note = game.note || null;
    merged.cover_art = game.cover_art || null;
    merged.save_folder = game.save_folder || null;
    merged.launch_mode = game.launch_mode || null;
    merged.perf_launch_preset = game.perf_launch_preset || null;
    merged.perf_show_fps = Boolean(game.perf_show_fps);
    merged.perf_priority = game.perf_priority || "normal";
  }
  return merged;
}
function allGames() {
  if (!library) return [];
  return library.sources
    .flatMap((report) => report.games)
    .map((game) => mergeProfile(game));
}
function gameByKey(key) {
  return allGames().find((g) => g.key === key) || null;
}
function visibleGames() {
  const kids = kidsSettings();
  return allGames().filter((game) => {
    if (kids.enabled && !kids.allowed_keys.includes(game.key)) return false;
    if (game.hidden && !appState.show_hidden_games) return false;
    return true;
  });
}
// Shelves in the player's order: beta.shelf_order first, then any
// shelf missing from it in stored order.
function orderedShelves() {
  const shelves = (appState.shelves || []).slice();
  const order = betaSettings().shelf_order || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return shelves.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : order.length;
    const rb = rank.has(b.id) ? rank.get(b.id) : order.length;
    return ra - rb;
  });
}
function totalPlaySeconds() {
  return Object.values(appState.profiles || {}).reduce(
    (sum, p) => sum + (p.total_play_seconds || 0),
    0
  );
}
function totalLaunches() {
  return Object.values(appState.profiles || {}).reduce(
    (sum, p) => sum + (p.launch_count || 0),
    0
  );
}

// --------------------------------------------------------------------- art

const localIconRequests = new Map();
function localIconPath(game) {
  const key = game.source + "\0" + game.id;
  if (!localIconRequests.has(key)) {
    localIconRequests.set(
      key,
      call("game_icon", { gameJson: game }).catch(() => null)
    );
  }
  return localIconRequests.get(key);
}
// One game's art, layered: the player's custom cover first, then
// their art URL override, then the game's own mapped art (Avok
// titles), then the Steam capsule, then a local .app bundle icon —
// EXCEPT mapped Avok titles, whose bundle icon is the studio mark.
// A failed image removes itself, leaving the monogram.
function gameArt(game, wide) {
  const art = el("div", "art");
  art.appendChild(
    el(
      "span",
      "art-initial",
      (displayName(game) || "?").trim().charAt(0).toUpperCase() || "?"
    )
  );
  const layer = (src, cls) => {
    if (!src) return;
    const img = document.createElement("img");
    img.className = "game-art-img" + (cls ? " " + cls : "");
    img.alt = "";
    img.loading = "lazy";
    img.src = src;
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
  };
  const mappedArt = AVOK_GAME_ART[profileKey(game)] || null;
  layer(mappedArt);
  if (game.source === "steam" && game.appid > 0) {
    layer(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/" +
        game.appid +
        (wide ? "/header.jpg" : "/library_600x900.jpg")
    );
  }
  if (!mappedArt && isAppBundle(game) && invoke && convertFileSrc) {
    const img = document.createElement("img");
    img.className = "game-art-img";
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => img.remove());
    art.appendChild(img);
    localIconPath(game).then((iconPath) => {
      if (!iconPath) {
        img.remove();
        return;
      }
      img.src = convertFileSrc(iconPath);
    });
  }
  if (game.art_url_override) layer(game.art_url_override);
  if (game.cover_art) layer(game.cover_art);
  return art;
}
function artWithTag(game, wide) {
  const art = gameArt(game, wide);
  art.appendChild(el("span", "tag", sourceLabel(game.source)));
  return art;
}
function avatarElement(value, sizeClass) {
  const wrap = el("span", "avatar " + (sizeClass || "avatar-md"));
  const initial = () => {
    const tag = (gamerProfile().gamertag || "").trim();
    return tag ? tag.charAt(0).toUpperCase() : "K";
  };
  if (value && value.indexOf("data:image/") === 0) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.src = value;
    img.addEventListener("error", () => {
      clear(wrap);
      wrap.appendChild(el("span", "avatar-initial", initial()));
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
      clear(wrap);
      wrap.appendChild(el("span", "avatar-initial", initial()));
    });
    wrap.appendChild(img);
    return wrap;
  }
  const builtin = value && value.indexOf("builtin:") === 0 ? value.slice(8) : null;
  if (builtin && AVATAR_SVGS[builtin]) {
    wrap.innerHTML = AVATAR_SVGS[builtin];
    return wrap;
  }
  wrap.appendChild(el("span", "avatar-initial", initial()));
  return wrap;
}

// ------------------------------------------------------------------ router

const views = {
  home: document.getElementById("view-home"),
  library: document.getElementById("view-library"),
  detail: document.getElementById("view-detail"),
  store: document.getElementById("view-store"),
  profile: document.getElementById("view-profile"),
  settings: document.getElementById("view-settings"),
};
let currentView = "home";
let currentDetailKey = null;
let currentDetailTab = "overview";

function parseHash() {
  const hash = window.location.hash || "";
  const match = hash.match(/^#\/(\w+)(?:\/(.+))?$/);
  if (!match) return { view: "home", param: null };
  const view = match[1];
  if (!views[view]) return { view: "home", param: null };
  let param = null;
  if (match[2]) {
    try {
      param = decodeURIComponent(match[2]);
    } catch (err) {
      param = match[2];
    }
  }
  return { view, param };
}
function go(view, param) {
  const hash = "#/" + view + (param ? "/" + encodeURIComponent(param) : "");
  if (window.location.hash === hash) {
    route();
    return;
  }
  window.location.hash = hash;
}
function route() {
  const { view, param } = parseHash();
  currentView = view;
  if (view === "detail") {
    if (param && param !== currentDetailKey) currentDetailTab = "overview";
    currentDetailKey = param;
  }
  for (const [key, section] of Object.entries(views)) {
    section.hidden = key !== view;
  }
  const navFor = view === "detail" ? "library" : view;
  document.querySelectorAll(".nav-item, .bottombar-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === navFor);
  });
  document.title =
    "KOVA Beta: " + navFor.charAt(0).toUpperCase() + navFor.slice(1);
  renderTopbarProfile();
  renderCurrentView();
  window.scrollTo(0, 0);
}
function renderCurrentView() {
  if (currentView === "home") renderHome();
  else if (currentView === "library") renderLibrary();
  else if (currentView === "detail") renderDetail();
  else if (currentView === "store") renderStore();
  else if (currentView === "profile") renderProfile();
  else if (currentView === "settings") renderSettings();
  if (window.KovaNav) window.KovaNav.refresh();
}
function renderTopbarProfile() {
  const profile = gamerProfile();
  const chip = document.getElementById("topbar-gamertag");
  const avatarHost = document.getElementById("topbar-avatar");
  if (chip) chip.textContent = (profile.gamertag || "").trim() || "Set gamertag";
  if (avatarHost) {
    clear(avatarHost);
    avatarHost.appendChild(avatarElement(profile.avatar, "avatar-sm"));
  }
}

// ------------------------------------------------------------ shared bits

function titleRow(parent, title, finding) {
  const row = el("div", "title-row");
  row.appendChild(el("h1", null, title));
  if (finding) row.appendChild(el("p", "finding", finding));
  parent.appendChild(row);
  return row;
}
function emptyState(parent, text, actionLabel, actionFn) {
  const box = el("div", "empty", text);
  if (actionLabel && actionFn) {
    box.appendChild(document.createTextNode(" "));
    const btn = el("button", "text-btn", actionLabel);
    btn.type = "button";
    btn.addEventListener("click", actionFn);
    box.appendChild(btn);
  }
  parent.appendChild(box);
  return box;
}
function gameTile(game) {
  const tile = el("button", "game-tile" + (game.hidden ? " is-hidden" : ""));
  tile.type = "button";
  tile.setAttribute("data-nav-key", "game:" + game.key);
  tile.setAttribute("aria-label", displayName(game));
  tile.appendChild(artWithTag(game, false));
  const name = el("span", "tile-name", displayName(game));
  if (game.favorite) {
    const star = el("span", "fav-star");
    star.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17l-6.1 3.6 1.4-6.8L2.2 9.1l6.9-.8z" fill="currentColor"/></svg>';
    star.title = "Favorite";
    name.appendChild(star);
  }
  tile.appendChild(name);
  const meta = [];
  if (game.total_play_seconds > 0) meta.push(fmtHoursShort(game.total_play_seconds) + " played");
  else if (game.last_launched) meta.push("Played " + relativeDay(game.last_launched).toLowerCase());
  else meta.push("Not played yet");
  tile.appendChild(el("span", "tile-meta", meta.join(" · ")));
  tile.addEventListener("click", () => go("detail", game.key));
  return tile;
}
function kidsNotice(parent) {
  const kids = kidsSettings();
  if (!kids.enabled) return;
  const note = el(
    "div",
    "notice info",
    "Kids shelf is on. Showing only the " +
      kids.allowed_keys.length +
      " approved game" +
      (kids.allowed_keys.length === 1 ? "" : "s") +
      (kids.daily_limit_minutes !== null && kids.daily_limit_minutes !== undefined
        ? ", " + kids.minutes_used_today + " of " + kids.daily_limit_minutes + " minutes used today"
        : "") +
      ". Manage it in Settings."
  );
  note.style.marginBottom = "20px";
  parent.appendChild(note);
}

// -------------------------------------------------------------------- home
// One question: "What am I playing right now — and what's next?"
// The signature element is the Now playing strip: the running game
// with its live elapsed time, the accent hue on the one live data
// element. Everything below it is the answer to "what's next":
// continue playing, then the player's shelves in their own order,
// then favorites.

let sessionTickTimer = null;
function startSessionTicker() {
  if (sessionTickTimer) return;
  sessionTickTimer = setInterval(() => {
    if (!activeSession || currentView !== "home") return;
    const elTime = document.getElementById("np-elapsed");
    if (elTime) {
      const elapsed = Math.floor(Date.now() / 1000) - activeSession.started_at;
      elTime.textContent = fmtDuration(elapsed);
    }
  }, 1000);
}

function greetingForHour() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function renderHome() {
  const root = views.home;
  clear(root);
  const profile = gamerProfile();
  const tag = (profile.gamertag || "").trim();
  const games = visibleGames();
  const recents = resolveRecents();

  let finding;
  if (activeSession) {
    const sessionGame = gameByKey(activeSession.game_key);
    finding = sessionGame
      ? displayName(sessionGame) + " is running now."
      : "A game is running now.";
  } else if (recents.length > 0) {
    finding =
      "Last played: " +
      displayName(recents[0]) +
      ", " +
      relativeDay(recents[0].last_launched).toLowerCase() +
      ".";
  } else if (games.length > 0) {
    finding = games.length + " games in your library.";
  } else {
    finding = "Your library is empty. Scan to find your games.";
  }
  titleRow(root, tag ? greetingForHour() + ", " + tag : greetingForHour(), finding);
  kidsNotice(root);

  // Now playing — the live session, when one is running.
  if (activeSession) {
    const sessionGame = gameByKey(activeSession.game_key);
    if (sessionGame) {
      const strip = el("div", "now-playing");
      strip.appendChild(gameArt(sessionGame, true));
      const body = el("div", "np-body");
      const label = el("span", "np-label");
      label.appendChild(el("span", "live-dot"));
      label.appendChild(document.createTextNode("Now playing"));
      body.appendChild(label);
      body.appendChild(el("div", "np-name", displayName(sessionGame)));
      const time = el("div", "np-time");
      time.appendChild(document.createTextNode("Running for "));
      const elapsed = el("span", "num");
      elapsed.id = "np-elapsed";
      elapsed.textContent = fmtDuration(activeSession.elapsed_seconds);
      time.appendChild(elapsed);
      body.appendChild(time);
      strip.appendChild(body);
      const openBtn = el("button", "btn", "Open game page");
      openBtn.type = "button";
      openBtn.addEventListener("click", () => go("detail", sessionGame.key));
      strip.appendChild(openBtn);
      root.appendChild(strip);
      startSessionTicker();
    }
  }

  // Continue playing — recents, capped at 4.
  const continueSection = el("div", "view-section");
  const continueHead = el("div", "section-head");
  continueHead.appendChild(el("h2", null, "Continue playing"));
  if (recents.length > 0) {
    continueHead.appendChild(el("span", "count", recents.length + " recent"));
  }
  continueSection.appendChild(continueHead);
  if (recents.length === 0) {
    emptyState(
      continueSection,
      games.length === 0
        ? "No games yet. Scan your library from Settings to get started."
        : "Nothing launched yet. Pick a game below and play.",
      games.length === 0 ? "Open Settings" : null,
      games.length === 0 ? () => go("settings") : null
    );
  } else {
    const list = el("div", "row-list");
    recents.slice(0, 4).forEach((game) => {
      const row = el("div", "row-item");
      row.tabIndex = 0;
      row.setAttribute("data-nav-key", "recent:" + game.key);
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", displayName(game));
      row.appendChild(gameArt(game, true));
      const body = el("div", "row-body");
      body.appendChild(el("div", "row-name", displayName(game)));
      const meta = sourceLabel(game.source) + " · " + relativeDay(game.last_launched);
      body.appendChild(el("div", "row-meta", meta));
      row.appendChild(body);
      const playBtn = el("button", "btn btn-primary play", game.source === "avok" ? "Open" : "Play");
      playBtn.type = "button";
      playBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        launchGame(game, playBtn);
      });
      const actionWrap = el("div", "row-action");
      actionWrap.appendChild(playBtn);
      row.appendChild(actionWrap);
      row.addEventListener("click", () => go("detail", game.key));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          go("detail", game.key);
        }
      });
      list.appendChild(row);
    });
    continueSection.appendChild(list);
  }
  root.appendChild(continueSection);

  // Shelves in the player's order.
  const shelvesSection = el("div", "view-section");
  const shelvesHead = el("div", "section-head");
  shelvesHead.appendChild(el("h2", null, "Your shelves"));
  const manageLink = el("a", "head-link", "Manage shelves");
  manageLink.href = "#/profile";
  shelvesHead.appendChild(manageLink);
  shelvesSection.appendChild(shelvesHead);
  let anyShelfGames = false;
  const visibleKeys = new Set(games.map((g) => g.key));
  orderedShelves().forEach((shelf) => {
    const shelfGames = shelf.game_keys
      .map((key) => gameByKey(key))
      .filter((game) => game && visibleKeys.has(game.key));
    if (shelfGames.length === 0) return;
    anyShelfGames = true;
    const head = el("div", "section-head");
    head.style.marginTop = "20px";
    head.appendChild(el("h2", null, shelf.name));
    head.appendChild(el("span", "count", shelfGames.length + " game" + (shelfGames.length === 1 ? "" : "s")));
    shelvesSection.appendChild(head);
    const grid = el("div", "tile-grid");
    shelfGames.slice(0, 6).forEach((game) => grid.appendChild(gameTile(game)));
    shelvesSection.appendChild(grid);
  });
  if (!anyShelfGames) {
    emptyState(
      shelvesSection,
      "No games on your shelves yet. Open a game and add it to a shelf from its detail page."
    );
  }
  root.appendChild(shelvesSection);

  // Favorites.
  const favorites = games.filter((g) => g.favorite);
  const favSection = el("div", "view-section");
  const favHead = el("div", "section-head");
  favHead.appendChild(el("h2", null, "Favorites"));
  if (favorites.length > 0) favHead.appendChild(el("span", "count", String(favorites.length)));
  favSection.appendChild(favHead);
  if (favorites.length === 0) {
    emptyState(favSection, "No favorites yet. Star a game on its detail page and it lands here.");
  } else {
    const grid = el("div", "tile-grid");
    favorites.slice(0, 6).forEach((game) => grid.appendChild(gameTile(game)));
    favSection.appendChild(grid);
  }
  root.appendChild(favSection);
}

function resolveRecents() {
  const kids = kidsSettings();
  const seen = new Set();
  const out = [];
  (appState.recents || []).forEach((recent) => {
    const key = profileKey(recent);
    if (seen.has(key)) return;
    seen.add(key);
    const inLibrary = gameByKey(key);
    const game = inLibrary || mergeProfile(recent);
    if (kids.enabled && !kids.allowed_keys.includes(key)) return;
    if (game.hidden && !appState.show_hidden_games) return;
    out.push(game);
  });
  return out;
}

// ----------------------------------------------------------------- library
// One question: "Which game do I want, and where does it live?"
// Count-card filters by source (the dealt pattern), the top-bar
// search, a sort, and the game grid.

let libraryFilter = "all"; // "all" | "favorites" | source id
let libraryQuery = "";
let librarySort = "name";

function renderLibrary() {
  const root = views.library;
  clear(root);
  const games = visibleGames();
  const hours = totalPlaySeconds();
  titleRow(
    root,
    "Library",
    games.length +
      " game" +
      (games.length === 1 ? "" : "s") +
      (hours > 0 ? " · " + fmtHours(hours) + " played through KOVA" : "")
  );
  kidsNotice(root);

  // Count cards: All, Favorites, then one per source present.
  const counts = { all: games.length, favorites: games.filter((g) => g.favorite).length };
  games.forEach((g) => {
    counts[g.source] = (counts[g.source] || 0) + 1;
  });
  const cards = el("div", "count-cards");
  const makeCard = (id, label, count) => {
    const card = el("button", "count-card");
    card.type = "button";
    card.setAttribute("aria-pressed", libraryFilter === id ? "true" : "false");
    card.appendChild(el("div", "cc-label", label));
    card.appendChild(el("div", "cc-value num", String(count)));
    card.addEventListener("click", () => {
      libraryFilter = id;
      renderLibrary();
    });
    cards.appendChild(card);
  };
  makeCard("all", "All games", counts.all);
  makeCard("favorites", "Favorites", counts.favorites);
  SOURCE_ORDER.forEach((source) => {
    if (counts[source]) makeCard(source, sourceLabel(source), counts[source]);
  });
  root.appendChild(cards);

  const toolbar = el("div", "library-toolbar");
  const filtered = filterLibraryGames(games);
  const resultCount = el("span", "result-count num");
  resultCount.textContent =
    filtered.length +
    " game" +
    (filtered.length === 1 ? "" : "s") +
    (libraryQuery ? ' matching "' + libraryQuery + '"' : "");
  toolbar.appendChild(resultCount);
  const sortSelect = el("select", "select");
  sortSelect.setAttribute("aria-label", "Sort library");
  [
    ["name", "Sort: Name"],
    ["recent", "Sort: Recently played"],
    ["played", "Sort: Most played"],
    ["launches", "Sort: Most launched"],
  ].forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    if (librarySort === value) option.selected = true;
    sortSelect.appendChild(option);
  });
  sortSelect.addEventListener("change", () => {
    librarySort = sortSelect.value;
    renderLibrary();
  });
  toolbar.appendChild(sortSelect);
  root.appendChild(toolbar);

  if (filtered.length === 0) {
    if (games.length === 0) {
      emptyState(
        root,
        "No games found. Scan your library from Settings: Steam, Epic, GOG, itch, and your standalone folders.",
        "Open Settings",
        () => go("settings")
      );
    } else {
      emptyState(root, "Nothing matches that filter. Clear the search or pick another filter.");
    }
    return;
  }
  const grid = el("div", "tile-grid");
  filtered.forEach((game) => grid.appendChild(gameTile(game)));
  root.appendChild(grid);
}

function filterLibraryGames(games) {
  let list = games.slice();
  if (libraryFilter === "favorites") list = list.filter((g) => g.favorite);
  else if (libraryFilter !== "all") list = list.filter((g) => g.source === libraryFilter);
  if (libraryQuery) {
    const q = libraryQuery.toLowerCase();
    list = list.filter((g) => displayName(g).toLowerCase().includes(q));
  }
  if (librarySort === "recent") {
    list.sort((a, b) => (b.last_launched || 0) - (a.last_launched || 0));
  } else if (librarySort === "played") {
    list.sort((a, b) => (b.total_play_seconds || 0) - (a.total_play_seconds || 0));
  } else if (librarySort === "launches") {
    list.sort((a, b) => (b.launch_count || 0) - (a.launch_count || 0));
  } else {
    list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }
  return list;
}

// ------------------------------------------------------------------ launch

async function launchGame(game, button) {
  const kids = kidsSettings();
  if (kids.enabled && !kids.allowed_keys.includes(game.key)) {
    setStatus("That game is not on the kids shelf.", true);
    return;
  }
  if (
    kids.enabled &&
    kids.daily_limit_minutes !== null &&
    kids.daily_limit_minutes !== undefined &&
    kids.minutes_used_today >= kids.daily_limit_minutes
  ) {
    setStatus("The daily play limit has been reached.", true);
    return;
  }
  if (!invoke) {
    setStatus("Launching needs the KOVA app. This is a preview.", true);
    return;
  }
  if (!game.launch_uri) {
    setStatus("That game has no launch target.", true);
    return;
  }
  if (button) button.disabled = true;
  setStatus("Launching " + displayName(game) + "…");
  const updated = await call("launch_game", { gameJson: game });
  if (updated) {
    appState = normalizeState(updated);
    applyBetaTheme();
    renderCurrentView();
  } else {
    setStatus("Could not launch " + displayName(game) + ".", true);
  }
  if (button) button.disabled = false;
}

async function saveProfile(game, patch, silent) {
  const next = Object.assign(storedProfile(game), patch);
  const profiles = await call("set_profile", { key: game.key, profile: next });
  if (!profiles) {
    if (!silent) setStatus("Could not save that change.", true);
    return null;
  }
  appState.profiles = profiles;
  return profiles[game.key] || next;
}

// ------------------------------------------------------------------ detail
// One question: "What is this game to me — and how do I play it
// best?" Object header + six-column grid (the dealt pattern):
// KPI tiles of 2, then pairs of 3. Performance is local launches
// only, with the honest Mac limits stated plainly.

function renderDetail() {
  const root = views.detail;
  clear(root);
  const game = currentDetailKey ? gameByKey(currentDetailKey) : null;
  if (!game) {
    titleRow(root, "Game not found", "That game is not in the library KOVA scanned.");
    emptyState(root, "It may have moved, or the library needs a rescan.", "Back to Library", () => go("library"));
    return;
  }
  const kids = kidsSettings();
  if (kids.enabled && !kids.allowed_keys.includes(game.key)) {
    titleRow(root, displayName(game), "This game is not on the kids shelf.");
    emptyState(root, "Kids shelf is on. Only approved games open. Manage the approved list in Settings.", "Back to Library", () => go("library"));
    return;
  }

  const backBtn = el("button", "text-btn", "← Back to Library");
  backBtn.type = "button";
  backBtn.style.marginBottom = "16px";
  backBtn.addEventListener("click", () => go("library"));
  root.appendChild(backBtn);

  // Object header.
  const header = el("div", "detail-header");
  header.appendChild(gameArt(game, true));
  const body = el("div", "dh-body");
  body.appendChild(el("h1", null, displayName(game)));
  const meta = [
    sourceLabel(game.source),
    game.hidden ? "Hidden" : null,
    game.launch_count > 0
      ? game.launch_count + " launch" + (game.launch_count === 1 ? "" : "es")
      : "Never launched",
    game.last_launched ? "Last played " + relativeDay(game.last_launched) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  body.appendChild(el("div", "dh-meta", meta));
  header.appendChild(body);
  const actions = el("div", "dh-actions");
  const playBtn = el("button", "btn btn-primary", game.source === "avok" ? "Open" : "Play");
  playBtn.type = "button";
  playBtn.addEventListener("click", () => launchGame(game, playBtn));
  actions.appendChild(playBtn);
  const favBtn = el("button", "btn", game.favorite ? "Favorited" : "Favorite");
  favBtn.type = "button";
  favBtn.setAttribute("aria-pressed", game.favorite ? "true" : "false");
  favBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { favorite: !game.favorite });
    if (saved) {
      setStatus(saved.favorite ? "Added to favorites." : "Removed from favorites.");
      renderDetail();
    }
  });
  actions.appendChild(favBtn);
  const hideBtn = el("button", "btn", game.hidden ? "Unhide" : "Hide");
  hideBtn.type = "button";
  hideBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { hidden: !game.hidden });
    if (saved) {
      setStatus(saved.hidden ? "Game hidden. Show hidden games in Settings to bring it back." : "Game is visible again.");
      renderDetail();
    }
  });
  actions.appendChild(hideBtn);
  header.appendChild(actions);
  root.appendChild(header);

  // Tabs.
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  ["overview", "performance", "journal", "saves"].forEach((tab) => {
    const btn = el("button", null, tab.charAt(0).toUpperCase() + tab.slice(1));
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", currentDetailTab === tab ? "true" : "false");
    btn.addEventListener("click", () => {
      currentDetailTab = tab;
      renderDetail();
    });
    tabs.appendChild(btn);
  });
  root.appendChild(tabs);

  if (currentDetailTab === "overview") renderDetailOverview(root, game);
  else if (currentDetailTab === "performance") renderDetailPerf(root, game);
  else if (currentDetailTab === "journal") renderDetailJournal(root, game);
  else renderDetailSaves(root, game);
}

function kpiTile(label, value, sub) {
  const tile = el("div", "kpi-tile span-2");
  tile.appendChild(el("div", "kpi-label", label));
  const valueEl = el("div", "kpi-value num", value);
  tile.appendChild(valueEl);
  if (sub) tile.appendChild(el("div", "kpi-sub", sub));
  return tile;
}

function renderDetailOverview(root, game) {
  const grid = el("div", "detail-grid");
  grid.appendChild(
    kpiTile(
      "Total playtime",
      game.total_play_seconds > 0 ? fmtHours(game.total_play_seconds) : "0h 00m",
      "Only sessions KOVA launched and watched count."
    )
  );
  grid.appendChild(
    kpiTile(
      "Launches",
      String(game.launch_count),
      game.last_launched ? "Last launched " + relativeDay(game.last_launched) : "Never launched"
    )
  );
  grid.appendChild(
    kpiTile(
      "Last session",
      game.last_session_seconds > 0 ? fmtHours(game.last_session_seconds) : "—",
      game.last_session_end ? "Ended " + fmtDate(game.last_session_end) : "No completed session yet"
    )
  );

  // Rating + note.
  const ratingCard = el("div", "card span-3");
  ratingCard.appendChild(el("h3", null, "Your rating and note"));
  ratingCard.appendChild(el("p", "card-sub", "Private to this machine. A star rating and a note to your future self."));
  const stars = el("div", "stars");
  stars.setAttribute("role", "radiogroup");
  stars.setAttribute("aria-label", "Star rating");
  for (let i = 1; i <= 5; i += 1) {
    const star = el("button", game.rating && game.rating >= i ? "on" : null);
    star.type = "button";
    star.setAttribute("role", "radio");
    star.setAttribute("aria-checked", game.rating === i ? "true" : "false");
    star.setAttribute("aria-label", i + " star" + (i === 1 ? "" : "s"));
    star.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17l-6.1 3.6 1.4-6.8L2.2 9.1l6.9-.8z" fill="currentColor"/></svg>';
    star.addEventListener("click", async () => {
      const next = game.rating === i ? null : i;
      const saved = await saveProfile(game, { rating: next });
      if (saved) {
        setStatus(next ? "Rated " + next + " of 5." : "Rating cleared.");
        renderDetail();
      }
    });
    stars.appendChild(star);
  }
  ratingCard.appendChild(stars);
  const noteField = el("div", "field");
  noteField.style.marginTop = "16px";
  noteField.appendChild(el("label", null, "Note"));
  const noteInput = el("textarea", "textarea");
  // Five rows: a note worth keeping needs room to write, and it
  // brings this card level with the cover card beside it.
  noteInput.rows = 5;
  noteInput.maxLength = 2000;
  noteInput.placeholder = "What should you remember about this game?";
  noteInput.value = game.note || "";
  noteInput.setAttribute("aria-label", "Private note on this game");
  noteField.appendChild(noteInput);
  ratingCard.appendChild(noteField);
  const noteActions = el("div", "card-actions");
  const saveNoteBtn = el("button", "btn", "Save note");
  saveNoteBtn.type = "button";
  saveNoteBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { note: noteInput.value.trim() || null });
    if (saved) {
      setStatus("Note saved.");
      renderDetail();
    }
  });
  noteActions.appendChild(saveNoteBtn);
  ratingCard.appendChild(noteActions);
  grid.appendChild(ratingCard);

  // Cover art.
  const coverCard = el("div", "card span-3");
  coverCard.appendChild(el("h3", null, "Cover art"));
  coverCard.appendChild(el("p", "card-sub", "Your tile, your art. A local image, shrunk to fit the 200 KB cap."));
  const preview = gameArt(game, true);
  preview.classList.add("cover-preview");
  coverCard.appendChild(preview);
  const coverInput = document.createElement("input");
  coverInput.type = "file";
  coverInput.accept = "image/*";
  coverInput.hidden = true;
  coverInput.setAttribute("aria-label", "Choose cover art");
  coverInput.addEventListener("change", async () => {
    const file = coverInput.files && coverInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await downscaleImage(file, COVER_ATTEMPTS);
      const saved = await saveProfile(game, { cover_art: dataUrl });
      if (saved) {
        setStatus("Cover art updated.");
        renderDetail();
      }
    } catch (err) {
      setStatus(err.message, true);
    }
    coverInput.value = "";
  });
  coverCard.appendChild(coverInput);
  const coverActions = el("div", "card-actions");
  const uploadBtn = el("button", "btn", game.cover_art ? "Change cover art" : "Upload cover art");
  uploadBtn.type = "button";
  uploadBtn.addEventListener("click", () => coverInput.click());
  coverActions.appendChild(uploadBtn);
  if (game.cover_art) {
    const removeBtn = el("button", "btn", "Remove");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", async () => {
      const saved = await saveProfile(game, { cover_art: null });
      if (saved) {
        setStatus("Cover art removed.");
        renderDetail();
      }
    });
    coverActions.appendChild(removeBtn);
  }
  coverCard.appendChild(coverActions);
  grid.appendChild(coverCard);

  // Shelves.
  const shelfCard = el("div", "card span-3");
  shelfCard.appendChild(el("h3", null, "Shelves"));
  shelfCard.appendChild(el("p", "card-sub", "A game can sit on more than one shelf."));
  orderedShelves().forEach((shelf) => {
    const row = el("label", "check-row");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = shelf.game_keys.includes(game.key);
    box.addEventListener("change", async () => {
      const shelves = (appState.shelves || []).map((s) => {
        if (s.id !== shelf.id) return s;
        const keys = s.game_keys.slice();
        if (box.checked) {
          if (!keys.includes(game.key)) keys.push(game.key);
        } else {
          const at = keys.indexOf(game.key);
          if (at >= 0) keys.splice(at, 1);
        }
        return Object.assign({}, s, { game_keys: keys });
      });
      const updated = await call("set_shelves", { shelves });
      if (updated) {
        appState = normalizeState(updated);
        setStatus(box.checked ? "Added to " + shelf.name + "." : "Removed from " + shelf.name + ".");
      } else {
        box.checked = !box.checked;
        setStatus("Could not update that shelf.", true);
      }
    });
    row.appendChild(box);
    row.appendChild(document.createTextNode(shelf.name));
    const count = el("span", "so-count num", shelf.game_keys.length + " game" + (shelf.game_keys.length === 1 ? "" : "s"));
    count.style.marginLeft = "auto";
    row.appendChild(count);
    shelfCard.appendChild(row);
  });
  // Quick-add a shelf where you assign it, so a new collection
  // does not mean a trip to the Profile.
  const newShelfRow = el("div");
  newShelfRow.style.display = "flex";
  newShelfRow.style.gap = "8px";
  newShelfRow.style.marginTop = "12px";
  const newShelfInput = el("input", "input");
  newShelfInput.type = "text";
  newShelfInput.placeholder = "New shelf name";
  newShelfInput.setAttribute("aria-label", "New shelf name");
  newShelfRow.appendChild(newShelfInput);
  const addShelfBtn = el("button", "btn", "Add");
  addShelfBtn.type = "button";
  addShelfBtn.addEventListener("click", async () => {
    const name = newShelfInput.value.trim();
    if (!name) {
      setStatus("Give the shelf a name first.", true);
      return;
    }
    const id = "shelf-" + slugify(name) + "-" + Date.now().toString(36);
    const shelves = (appState.shelves || []).concat([
      { id, name, game_keys: [game.key], builtin: false },
    ]);
    const updated = await call("set_shelves", { shelves });
    if (updated) {
      appState = normalizeState(updated);
      setStatus('Shelf "' + name + '" created, with this game on it.');
      renderDetail();
    } else {
      setStatus("Could not create that shelf.", true);
    }
  });
  newShelfRow.appendChild(addShelfBtn);
  shelfCard.appendChild(newShelfRow);
  const newShelfHint = el("p", "hint", "The new shelf starts with this game on it.");
  newShelfHint.style.marginTop = "8px";
  shelfCard.appendChild(newShelfHint);
  const shelfOrderNote = el("p", "card-sub", "Shelves appear on Home in the order set on your Profile.");
  shelfOrderNote.style.marginTop = "14px";
  shelfCard.appendChild(shelfOrderNote);
  grid.appendChild(shelfCard);

  // Launch options.
  const launchCard = el("div", "card span-3");
  launchCard.appendChild(el("h3", null, "Launch options"));
  launchCard.appendChild(
    el(
      "p",
      "card-sub",
      launchesLocalPath(game)
        ? "Launch arguments go to this game's local process."
        : "This game opens through a store link or web page, so KOVA passes nothing to it. Launch arguments do not apply."
    )
  );
  const nameField = el("div", "field");
  nameField.appendChild(el("label", null, "Display name"));
  const nameInput = el("input", "input");
  nameInput.type = "text";
  nameInput.placeholder = game.name;
  nameInput.value = (storedProfile(game).name_override || "").trim();
  nameInput.setAttribute("aria-label", "Display name override");
  nameField.appendChild(nameInput);
  launchCard.appendChild(nameField);
  if (launchesLocalPath(game)) {
    const argsField = el("div", "field");
    argsField.style.marginTop = "16px";
    argsField.appendChild(el("label", null, "Launch arguments"));
    const argsInput = el("input", "input");
    argsInput.type = "text";
    argsInput.placeholder = "e.g. -windowed";
    argsInput.value = game.launch_args || "";
    argsInput.setAttribute("aria-label", "Extra launch arguments");
    argsField.appendChild(argsInput);
    argsField.appendChild(el("p", "hint", "Sent to the game at launch, before any preset's arguments."));
    launchCard.appendChild(argsField);
  }
  const artField = el("div", "field");
  artField.style.marginTop = "16px";
  artField.appendChild(el("label", null, "Art URL override"));
  const artInput = el("input", "input");
  artInput.type = "url";
  artInput.placeholder = "https://…";
  artInput.value = game.art_url_override || "";
  artInput.setAttribute("aria-label", "Art URL override");
  artField.appendChild(artInput);
  launchCard.appendChild(artField);
  const launchActions = el("div", "card-actions");
  const saveLaunchBtn = el("button", "btn", "Save launch options");
  saveLaunchBtn.type = "button";
  saveLaunchBtn.addEventListener("click", async () => {
    const patch = {
      name_override: nameInput.value.trim() || null,
      art_url_override: artInput.value.trim() || null,
    };
    if (launchesLocalPath(game)) {
      const argsInput = launchCard.querySelectorAll("input")[1];
      patch.launch_args = argsInput ? argsInput.value.trim() : game.launch_args || "";
    }
    const saved = await saveProfile(game, patch);
    if (saved) {
      setStatus("Launch options saved.");
      renderDetail();
    }
  });
  launchActions.appendChild(saveLaunchBtn);
  const resetBtn = el("button", "btn btn-danger", "Reset profile");
  resetBtn.type = "button";
  resetBtn.addEventListener("click", async () => {
    if (
      !window.confirm(
        "Reset " + displayName(game) + " to its scanned name and art, unfavorited, with its launch stats cleared?"
      )
    ) {
      return;
    }
    const profiles = await call("clear_profile", { key: game.key });
    if (profiles) {
      appState.profiles = profiles;
      setStatus("Profile reset.");
      renderDetail();
    } else {
      setStatus("Could not reset that profile.", true);
    }
  });
  launchActions.appendChild(resetBtn);
  launchCard.appendChild(launchActions);
  grid.appendChild(launchCard);

  root.appendChild(grid);
}

async function renderDetailPerf(root, game) {
  const grid = el("div", "detail-grid");
  if (!launchesLocalPath(game)) {
    const card = el("div", "card span-6");
    card.appendChild(el("h3", null, "No performance settings for this game"));
    card.appendChild(
      el(
        "p",
        "card-sub",
        "This game opens through a store link or web page, so KOVA controls nothing about its process. There is no local launch to pass settings to. Performance settings appear for games KOVA launches from your machine."
      )
    );
    grid.appendChild(card);
    root.appendChild(grid);
    return;
  }
  if (!perfPresets) {
    perfPresets = (await call("get_perf_presets")) || [];
  }
  const profile = storedProfile(game);

  // Launch mode — one tap that bundles the perf settings.
  const modeCard = el("div", "card span-3");
  modeCard.appendChild(el("h3", null, "Launch mode"));
  modeCard.appendChild(
    el("p", "card-sub", "One tap that bundles your performance settings for the next launch.")
  );
  const modeField = el("div", "field");
  const modeSelect = el("select", "select");
  modeSelect.setAttribute("aria-label", "Launch mode");
  [
    ["", "Use profile settings"],
    ["quiet", "Quiet night"],
    ["full", "Full power"],
  ].forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    if ((profile.launch_mode || "") === value) option.selected = true;
    modeSelect.appendChild(option);
  });
  modeField.appendChild(modeSelect);
  modeField.appendChild(
    el(
      "p",
      "hint",
      "Quiet night runs at low priority with your preset as stored. Full power runs at high priority, drops any frame-rate cap preset, and turns the FPS HUD on."
    )
  );
  modeCard.appendChild(modeField);
  const modeActions = el("div", "card-actions");
  const saveModeBtn = el("button", "btn", "Save launch mode");
  saveModeBtn.type = "button";
  saveModeBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { launch_mode: modeSelect.value || null });
    if (saved) setStatus("Launch mode saved.");
  });
  modeActions.appendChild(saveModeBtn);
  modeCard.appendChild(modeActions);
  grid.appendChild(modeCard);

  // Preset picker.
  const presetCard = el("div", "card span-3");
  presetCard.appendChild(el("h3", null, "Launch-arg preset"));
  presetCard.appendChild(
    el("p", "card-sub", "Engine-known argument sets, added on top of your free-text launch args.")
  );
  const presetField = el("div", "field");
  const presetSelect = el("select", "select");
  presetSelect.setAttribute("aria-label", "Launch-arg preset");
  const noneOption = el("option", null, "No preset");
  noneOption.value = "";
  presetSelect.appendChild(noneOption);
  const byEngine = {};
  perfPresets.forEach((preset) => {
    (byEngine[preset.engine] = byEngine[preset.engine] || []).push(preset);
  });
  Object.keys(byEngine)
    .sort()
    .forEach((engine) => {
      const group = document.createElement("optgroup");
      group.label = engine;
      byEngine[engine].forEach((preset) => {
        const option = el("option", null, preset.label);
        option.value = preset.id;
        if (profile.perf_launch_preset === preset.id) option.selected = true;
        group.appendChild(option);
      });
      presetSelect.appendChild(group);
    });
  presetField.appendChild(presetSelect);
  const presetNote = el("p", "hint", "Sent to the game; the game decides what to honor.");
  presetField.appendChild(presetNote);
  presetCard.appendChild(presetField);
  const presetActions = el("div", "card-actions");
  const savePresetBtn = el("button", "btn", "Save preset");
  savePresetBtn.type = "button";
  savePresetBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { perf_launch_preset: presetSelect.value || null });
    if (saved) setStatus("Preset saved.");
  });
  presetActions.appendChild(savePresetBtn);
  presetCard.appendChild(presetActions);
  grid.appendChild(presetCard);

  // FPS HUD + priority.
  const hudCard = el("div", "card span-3");
  hudCard.appendChild(el("h3", null, "FPS HUD"));
  hudCard.appendChild(
    el("p", "card-sub", "Apple's Metal HUD: FPS, frame time, and GPU metrics while the game runs. Metal games only. Monitoring, not a cap.")
  );
  const hudRow = el("div", "switch-row");
  const hudBody = el("div", "sr-body");
  hudBody.appendChild(el("div", "sr-title", "Show FPS"));
  hudBody.appendChild(el("div", "sr-desc", "Launches the game with MTL_HUD_ENABLED=1."));
  hudRow.appendChild(hudBody);
  const hudToggle = el("button", "toggle");
  hudToggle.type = "button";
  hudToggle.setAttribute("role", "switch");
  hudToggle.setAttribute("aria-checked", profile.perf_show_fps ? "true" : "false");
  hudToggle.setAttribute("aria-label", "Show FPS HUD");
  hudToggle.addEventListener("click", async () => {
    const next = hudToggle.getAttribute("aria-checked") !== "true";
    const saved = await saveProfile(game, { perf_show_fps: next }, true);
    if (saved) {
      hudToggle.setAttribute("aria-checked", next ? "true" : "false");
      setStatus(next ? "FPS HUD on for the next launch." : "FPS HUD off.");
    } else {
      setStatus("Could not save that change.", true);
    }
  });
  hudRow.appendChild(hudToggle);
  hudCard.appendChild(hudRow);
  grid.appendChild(hudCard);

  const priorityCard = el("div", "card span-3");
  priorityCard.appendChild(el("h3", null, "Process priority"));
  priorityCard.appendChild(
    el("p", "card-sub", "A minor knob. It applies only to executables KOVA spawns directly. A no-op for .app launches, which macOS opens for you.")
  );
  const priorityField = el("div", "field");
  const prioritySelect = el("select", "select");
  prioritySelect.setAttribute("aria-label", "Process priority");
  [
    ["low", "Low"],
    ["normal", "Normal"],
    ["high", "High"],
  ].forEach(([value, label]) => {
    const option = el("option", null, label);
    option.value = value;
    if (profile.perf_priority === value) option.selected = true;
    prioritySelect.appendChild(option);
  });
  priorityField.appendChild(prioritySelect);
  priorityCard.appendChild(priorityField);
  const priorityActions = el("div", "card-actions");
  const savePriorityBtn = el("button", "btn", "Save priority");
  savePriorityBtn.type = "button";
  savePriorityBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { perf_priority: prioritySelect.value });
    if (saved) setStatus("Priority saved.");
  });
  priorityActions.appendChild(savePriorityBtn);
  priorityCard.appendChild(priorityActions);
  grid.appendChild(priorityCard);

  // The honest Mac limit.
  const limitCard = el("div", "card span-6");
  limitCard.appendChild(el("h3", null, "About frame-rate caps"));
  limitCard.appendChild(
    el(
      "p",
      "card-sub",
      "macOS has no per-game FPS cap. Use the game's own graphics settings. KOVA can send a cap as a launch argument for engines that honor one (the Source presets above), but it cannot cap a game itself."
    )
  );
  grid.appendChild(limitCard);
  root.appendChild(grid);
}

function renderDetailJournal(root, game) {
  const entries = (appState.journal || [])
    .filter((entry) => entry.game_key === game.key)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);
  const wrap = el("div", "detail-grid");
  const listCard = el("div", "card span-4");
  listCard.appendChild(el("h3", null, "Journal"));
  listCard.appendChild(
    el("p", "card-sub", entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + ": what you played, what you thought.")
  );
  if (entries.length === 0) {
    emptyState(listCard, "No journal entries for this game yet.");
  } else {
    entries.forEach((entry) => {
      const item = el("div", "journal-entry");
      item.appendChild(el("div", "je-date", fmtDateTime(entry.timestamp)));
      item.appendChild(el("div", "je-text", entry.text));
      listCard.appendChild(item);
    });
  }
  wrap.appendChild(listCard);
  const addCard = el("div", "card span-2");
  addCard.appendChild(el("h3", null, "New entry"));
  const field = el("div", "field");
  const input = el("textarea", "textarea");
  input.rows = 5;
  input.maxLength = 2000;
  input.placeholder = "What happened in this session?";
  input.setAttribute("aria-label", "New journal entry");
  field.appendChild(input);
  addCard.appendChild(field);
  const actions = el("div", "card-actions");
  const addBtn = el("button", "btn btn-primary", "Add entry");
  addBtn.type = "button";
  addBtn.addEventListener("click", async () => {
    const text = input.value.trim();
    if (!text) {
      setStatus("Write something first.", true);
      return;
    }
    const journal = await call("add_journal_entry", { game_key: game.key, text });
    if (journal) {
      appState.journal = journal;
      setStatus("Entry added.");
      renderDetail();
    } else {
      setStatus("Could not add that entry.", true);
    }
  });
  actions.appendChild(addBtn);
  addCard.appendChild(actions);
  wrap.appendChild(addCard);
  root.appendChild(wrap);
}

async function renderDetailSaves(root, game) {
  const wrap = el("div", "detail-grid");
  const profile = storedProfile(game);
  const folderCard = el("div", "card span-3");
  folderCard.appendChild(el("h3", null, "Save folder"));
  folderCard.appendChild(
    el("p", "card-sub", "Where this game's save files live. Leave it blank and KOVA auto-detects the usual Mac save locations.")
  );
  const field = el("div", "field");
  const folderInput = el("input", "input");
  folderInput.type = "text";
  folderInput.placeholder = "Auto-detect";
  folderInput.value = profile.save_folder || "";
  folderInput.setAttribute("aria-label", "Save folder path");
  field.appendChild(folderInput);
  folderCard.appendChild(field);
  const folderActions = el("div", "card-actions");
  const saveFolderBtn = el("button", "btn", "Save folder");
  saveFolderBtn.type = "button";
  saveFolderBtn.addEventListener("click", async () => {
    const saved = await saveProfile(game, { save_folder: folderInput.value.trim() || null });
    if (saved) setStatus("Save folder saved.");
  });
  folderActions.appendChild(saveFolderBtn);
  folderCard.appendChild(folderActions);
  wrap.appendChild(folderCard);

  const backupsCard = el("div", "card span-3");
  backupsCard.appendChild(el("h3", null, "Save backups"));
  backupsCard.appendChild(
    el("p", "card-sub", "Snapshots of your save files, kept on this machine, so a lost save never happens.")
  );
  const backupBtn = el("button", "btn btn-primary", "Back up saves now");
  backupBtn.type = "button";
  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    const result = await call("backup_saves", { game_key: game.key });
    backupBtn.disabled = false;
    if (result) {
      const state = await call("get_state");
      if (state) appState = normalizeState(state);
      setStatus("Save backup taken.");
      renderDetail();
    } else {
      setStatus("Could not back up these saves. KOVA could not find the save folder. Set it above.", true);
    }
  });
  const backupActions = el("div", "card-actions");
  backupActions.appendChild(backupBtn);
  backupsCard.appendChild(backupActions);
  const backups =
    (await call("list_save_backups", { game_key: game.key })) ||
    (appState.save_backups || []).filter((b) => b.game_key === game.key);
  const sorted = backups.slice().sort((a, b) => b.backed_up_at - a.backed_up_at);
  if (sorted.length === 0) {
    const empty = el("div", "empty", "No backups yet for this game.");
    empty.style.marginTop = "16px";
    backupsCard.appendChild(empty);
  } else {
    const list = el("div");
    list.style.marginTop = "8px";
    sorted.forEach((backup) => {
      const row = el("div", "backup-row");
      row.appendChild(el("span", "b-name", fmtDateTime(backup.backed_up_at)));
      row.appendChild(el("span", "b-meta num", fmtBytes(backup.size_bytes)));
      const restoreBtn = el("button", "btn btn-sm", "Restore");
      restoreBtn.type = "button";
      restoreBtn.addEventListener("click", async () => {
        if (
          !window.confirm(
            "Restore the save backup from " +
              fmtDateTime(backup.backed_up_at) +
              "? Your current saves for this game will be replaced."
          )
        ) {
          return;
        }
        const restored = await call("restore_save", {
          game_key: game.key,
          backup_name: backup.backup_name,
        });
        if (restored) setStatus("Save backup restored.");
        else setStatus("Could not restore that backup.", true);
      });
      row.appendChild(restoreBtn);
      list.appendChild(row);
    });
    backupsCard.appendChild(list);
  }
  wrap.appendChild(backupsCard);
  root.appendChild(wrap);
}

// ------------------------------------------------------------------- store
// One question: "What's new to play, free, from devs I can trust?"
// Phase A: curated listings, downloads from the dev's own link.
// The catalog may be the live feed or the bundled offline copy —
// the screen says which. The submission form generates a listing
// JSON download; there is no invented endpoint.

async function renderStore() {
  const root = views.store;
  clear(root);
  titleRow(
    root,
    "Store",
    "Free games from independent devs. Downloads go to the dev's own page. KOVA does not host game files yet."
  );
  if (!catalogData) {
    catalogData = await call("get_store_catalog");
  }
  if (!catalogData || !catalogData.catalog) {
    emptyState(root, "The store catalog could not be loaded. Check your connection and try again.", "Retry", () => {
      catalogData = null;
      renderStore();
    });
    return;
  }
  const sourceNote = el(
    "div",
    "notice" + (catalogData.source === "bundled" ? "" : " info"),
    catalogData.source === "bundled"
      ? "Offline catalog. Showing the bundled listings. Connect to see the full store."
      : "Live catalog. Listings approved by Melo and Dre."
  );
  sourceNote.style.marginBottom = "20px";
  root.appendChild(sourceNote);

  const listings = catalogData.catalog.listings || [];
  if (listings.length === 0) {
    emptyState(root, "No listings in the catalog yet.");
  } else {
    const grid = el("div", "store-grid");
    listings.forEach((listing) => {
      const card = el("div", "store-card");
      const art = el("div", "art");
      art.appendChild(
        el("span", "art-initial", (listing.title || "?").trim().charAt(0).toUpperCase() || "?")
      );
      // Avok listings use their own local game art when the
      // catalog carries no art URL — never the studio mark.
      const localArt =
        listing.id === "dispatch-hq"
          ? AVOK_GAME_ART["avok:dispatch-hq"]
          : listing.id === "the-open-world"
            ? AVOK_GAME_ART["avok:the-open-world"]
            : null;
      const artSrc = listing.art || localArt;
      if (artSrc) {
        const img = document.createElement("img");
        img.className = "game-art-img";
        img.alt = "";
        img.loading = "lazy";
        img.src = artSrc;
        img.addEventListener("error", () => img.remove());
        art.appendChild(img);
      }
      card.appendChild(art);
      const body = el("div", "sc-body");
      body.appendChild(el("h3", null, listing.title));
      body.appendChild(
        el(
          "div",
          "sc-meta",
          listing.developer + (listing.version ? " · v" + listing.version : "")
        )
      );
      body.appendChild(el("div", "sc-desc", listing.description || ""));
      const actions = el("div", "sc-actions");
      if (listing.free) actions.appendChild(el("span", "free-pill", "Free"));
      const getBtn = el("button", "btn btn-primary", "Get it free");
      getBtn.type = "button";
      getBtn.addEventListener("click", async () => {
        if (!invoke) {
          window.open(listing.download_url, "_blank", "noopener");
          return;
        }
        const opened = await call("launch_uri", { uri: listing.download_url });
        if (opened === null && !DEMO) setStatus("Could not open that download page.", true);
      });
      actions.appendChild(getBtn);
      body.appendChild(actions);
      card.appendChild(body);
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // Submission form — generates a listing JSON download.
  const submitSection = el("div", "view-section");
  submitSection.style.marginTop = "32px";
  submitSection.appendChild(el("div", "section-head")).appendChild(el("h2", null, "Submit your game"));
  const submitCard = el("div", "card");
  submitCard.appendChild(
    el(
      "p",
      "card-sub",
      "Free games only, for now. Fill in your game's page and download the listing file, then send it to Avok. It goes through review before it appears in the store. Listings are approved by both Melo and Dre."
    )
  );
  const form = el("div");
  const fields = {};
  [
    ["title", "Game title", "text", "e.g. Tiny Rogue"],
    ["developer", "Developer or studio", "text", "e.g. Avok Interactive"],
    ["version", "Version", "text", "e.g. 1.0.0"],
    ["download_url", "Download link", "url", "https://your-site-or-itch-page"],
  ].forEach(([key, label, type, placeholder]) => {
    const field = el("div", "field");
    field.style.marginTop = "16px";
    field.appendChild(el("label", null, label));
    const input = el("input", "input");
    input.type = type;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    fields[key] = input;
    field.appendChild(input);
    form.appendChild(field);
  });
  const descField = el("div", "field");
  descField.style.marginTop = "16px";
  descField.appendChild(el("label", null, "Description"));
  const descInput = el("textarea", "textarea");
  descInput.rows = 3;
  descInput.placeholder = "What is your game, in one or two sentences?";
  descInput.setAttribute("aria-label", "Game description");
  fields.description = descInput;
  descField.appendChild(descInput);
  form.appendChild(descField);
  submitCard.appendChild(form);
  const submitActions = el("div", "card-actions");
  const downloadBtn = el("button", "btn btn-primary", "Download listing JSON");
  downloadBtn.type = "button";
  downloadBtn.addEventListener("click", () => {
    const title = fields.title.value.trim();
    const developer = fields.developer.value.trim();
    const downloadUrl = fields.download_url.value.trim();
    if (!title || !developer || !downloadUrl) {
      setStatus("A title, a developer, and a download link are all required.", true);
      return;
    }
    const listing = {
      id: slugify(title) || "untitled",
      title,
      description: fields.description.value.trim(),
      art: null,
      download_url: downloadUrl,
      developer,
      free: true,
      version: fields.version.value.trim() || "1.0.0",
    };
    downloadFile(
      "kova-store-listing-" + listing.id + ".json",
      JSON.stringify(listing, null, 2) + "\n"
    );
    setStatus("Listing JSON downloaded. Send it to Avok for review.");
  });
  submitActions.appendChild(downloadBtn);
  submitCard.appendChild(submitActions);
  submitSection.appendChild(submitCard);
  root.appendChild(submitSection);
}

// ----------------------------------------------------------------- profile
// One question: "Who am I here — and how much have I played?"
// The gamertag IS the KOVA LIVE tag — labelled so, nothing online,
// no friends or presence implied. Customization (accent, density,
// shelf order) lives here and persists through set_beta.

let stagedAvatar = null; // null = keep saved; otherwise the value to store

function renderProfile() {
  const root = views.profile;
  clear(root);
  const profile = gamerProfile();
  const tag = (profile.gamertag || "").trim();

  // Banner.
  const banner = el("div", "profile-banner");
  if (profile.banner) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = profile.banner;
    img.addEventListener("error", () => img.remove());
    banner.appendChild(img);
  }
  const bannerActions = el("div", "banner-actions");
  const bannerInput = document.createElement("input");
  bannerInput.type = "file";
  bannerInput.accept = "image/*";
  bannerInput.hidden = true;
  bannerInput.setAttribute("aria-label", "Choose banner image");
  bannerInput.addEventListener("change", async () => {
    const file = bannerInput.files && bannerInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await downscaleImage(file, BANNER_ATTEMPTS);
      await saveGamerProfile({ banner: dataUrl });
      setStatus("Banner updated.");
      renderProfile();
    } catch (err) {
      setStatus(err.message, true);
    }
    bannerInput.value = "";
  });
  banner.appendChild(bannerInput);
  const bannerBtn = el("button", "btn btn-sm", profile.banner ? "Change banner" : "Add banner");
  bannerBtn.type = "button";
  bannerBtn.addEventListener("click", () => bannerInput.click());
  bannerActions.appendChild(bannerBtn);
  if (profile.banner) {
    const removeBannerBtn = el("button", "btn btn-sm", "Remove banner");
    removeBannerBtn.type = "button";
    removeBannerBtn.addEventListener("click", async () => {
      await saveGamerProfile({ banner: null });
      setStatus("Banner removed.");
      renderProfile();
    });
    bannerActions.appendChild(removeBannerBtn);
  }
  banner.appendChild(bannerActions);
  root.appendChild(banner);

  // Head: avatar, gamertag, LIVE tag label, bio.
  const head = el("div", "profile-head");
  head.appendChild(avatarElement(profile.avatar, "avatar-lg"));
  const headBody = el("div", "ph-body");
  headBody.appendChild(el("h1", null, tag || "Your profile"));
  headBody.appendChild(el("div", "live-tag", "Your KOVA LIVE tag"));
  if (profile.bio) headBody.appendChild(el("div", "ph-bio", profile.bio));
  head.appendChild(headBody);
  root.appendChild(head);

  const layout = el("div", "profile-layout");

  // Stats strip.
  const statsCard = el("div", "card span-2col");
  statsCard.appendChild(el("h3", null, "Your numbers"));
  statsCard.appendChild(
    el("p", "card-sub", "Playtime counts only games KOVA launched locally. Games opened outside KOVA are invisible to it.")
  );
  const strip = el("div", "kpi-row");
  const mostPlayed = Object.entries(appState.profiles || {})
    .sort((a, b) => (b[1].total_play_seconds || 0) - (a[1].total_play_seconds || 0))[0];
  const mostPlayedName = mostPlayed
    ? (gameByKey(mostPlayed[0]) ? displayName(gameByKey(mostPlayed[0])) : mostPlayed[0])
    : "—";
  [
    ["Total playtime", fmtHours(totalPlaySeconds()), ""],
    ["Launches", String(totalLaunches()), ""],
    ["Games", String(allGames().length), ""],
    ["Favorites", String(allGames().filter((g) => g.favorite).length), ""],
    ["Most played", mostPlayedName, mostPlayed ? fmtHours(mostPlayed[1].total_play_seconds || 0) : ""],
  ].forEach(([label, value, sub]) => {
    const cell = el("div", "kpi-cell");
    cell.appendChild(el("div", "kpi-label", label));
    const valueEl = el("div", "kpi-value num", value);
    valueEl.style.fontSize = "20px";
    cell.appendChild(valueEl);
    if (sub) cell.appendChild(el("div", "kpi-sub", sub));
    strip.appendChild(cell);
  });
  statsCard.appendChild(strip);
  layout.appendChild(statsCard);

  // Milestones.
  const milestonesCard = el("div", "card");
  milestonesCard.appendChild(el("h3", null, "Milestones"));
  milestonesCard.appendChild(
    el("p", "card-sub", "Badges for real play, earned from your own history. No server.")
  );
  const milestonesBody = el("div");
  milestonesBody.appendChild(el("p", "card-sub", "Loading milestones…"));
  milestonesCard.appendChild(milestonesBody);
  layout.appendChild(milestonesCard);
  loadMilestones(milestonesBody);

  // Edit profile form — one Save per panel.
  const editCard = el("div", "card");
  editCard.appendChild(el("h3", null, "Edit profile"));
  editCard.appendChild(el("p", "card-sub", "Local only. Your gamertag, avatar, and bio live in kova-state.json on this machine and nowhere else."));
  const tagField = el("div", "field");
  tagField.appendChild(el("label", null, "Gamertag"));
  const tagInput = el("input", "input");
  tagInput.type = "text";
  tagInput.value = profile.gamertag || "";
  tagInput.placeholder = "Your KOVA LIVE tag";
  tagInput.setAttribute("aria-label", "Gamertag");
  tagField.appendChild(tagInput);
  editCard.appendChild(tagField);
  const bioField = el("div", "field");
  bioField.style.marginTop = "16px";
  bioField.appendChild(el("label", null, "Bio"));
  const bioInput = el("input", "input");
  bioInput.type = "text";
  bioInput.value = profile.bio || "";
  bioInput.placeholder = "One line about you";
  bioInput.setAttribute("aria-label", "Bio");
  bioField.appendChild(bioInput);
  editCard.appendChild(bioField);
  const avatarField = el("div", "field");
  avatarField.style.marginTop = "16px";
  avatarField.appendChild(el("label", null, "Avatar"));
  const avatarWrap = el("div", "avatar-options");
  const currentAvatar = stagedAvatar !== null ? stagedAvatar : profile.avatar || "";
  AVATAR_OPTIONS.forEach((option) => {
    const btn = el("button", "avatar-option");
    btn.type = "button";
    btn.setAttribute("aria-pressed", currentAvatar === option.value ? "true" : "false");
    btn.setAttribute("aria-label", option.label);
    btn.title = option.label;
    btn.appendChild(avatarElement(option.value, "avatar-md"));
    btn.addEventListener("click", () => {
      stagedAvatar = option.value;
      renderProfile();
    });
    avatarWrap.appendChild(btn);
  });
  avatarField.appendChild(avatarWrap);
  editCard.appendChild(avatarField);
  const avatarUploadInput = document.createElement("input");
  avatarUploadInput.type = "file";
  avatarUploadInput.accept = "image/*";
  avatarUploadInput.hidden = true;
  avatarUploadInput.setAttribute("aria-label", "Upload avatar image");
  avatarUploadInput.addEventListener("change", async () => {
    const file = avatarUploadInput.files && avatarUploadInput.files[0];
    if (!file) return;
    try {
      stagedAvatar = await downscaleImage(file, AVATAR_ATTEMPTS);
      renderProfile();
    } catch (err) {
      setStatus(err.message, true);
    }
    avatarUploadInput.value = "";
  });
  editCard.appendChild(avatarUploadInput);
  const editActions = el("div", "card-actions");
  const uploadAvatarBtn = el("button", "btn", "Upload image");
  uploadAvatarBtn.type = "button";
  uploadAvatarBtn.addEventListener("click", () => avatarUploadInput.click());
  editActions.appendChild(uploadAvatarBtn);
  const saveProfileBtn = el("button", "btn btn-primary", "Save profile");
  saveProfileBtn.type = "button";
  saveProfileBtn.addEventListener("click", async () => {
    const avatarValue = stagedAvatar !== null ? stagedAvatar : profile.avatar || "";
    const saved = await saveGamerProfile({
      gamertag: tagInput.value.trim(),
      avatar: avatarValue,
      bio: bioInput.value.trim(),
    });
    if (saved) {
      stagedAvatar = null;
      setStatus("Profile saved.");
      renderProfile();
    }
  });
  editActions.appendChild(saveProfileBtn);
  editCard.appendChild(editActions);
  // The honesty line for KOVA LIVE (§9): the gamertag IS the tag,
  // and nothing here is online yet. It also brings this card level
  // with the Milestones card beside it.
  const liveNote = el("p", "card-sub", "Your gamertag is your KOVA LIVE tag. Nothing here is online yet: no friends, no presence, no account. When LIVE lands, this tag travels with your exported state.");
  liveNote.style.marginTop = "14px";
  editCard.appendChild(liveNote);
  layout.appendChild(editCard);

  // Customization — applies immediately, with a quiet Saved stamp.
  const customCard = el("div", "card span-2col");
  customCard.appendChild(el("h3", null, "Customize this shell"));
  customCard.appendChild(
    el("p", "card-sub", "Beta first: what proves out here graduates to the main UI later. Changes apply right away.")
  );
  const beta = betaSettings();
  const accentField = el("div", "field");
  accentField.appendChild(el("label", null, "Accent"));
  const picker = el("div", "accent-picker");
  ACCENTS.forEach((accent) => {
    const btn = el("button", "accent-option");
    btn.type = "button";
    btn.setAttribute("aria-pressed", beta.accent === accent.id ? "true" : "false");
    const swatch = el("span", "swatch");
    swatch.style.background = accent.swatch;
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(accent.label));
    btn.addEventListener("click", async () => {
      const updated = await call("set_beta", {
        beta: Object.assign({}, beta, { accent: accent.id }),
      });
      if (updated) {
        appState = normalizeState(updated);
        applyBetaTheme();
        setStatus("Accent set to " + accent.label + ".");
        renderProfile();
      } else {
        setStatus("Could not save that accent.", true);
      }
    });
    picker.appendChild(btn);
  });
  accentField.appendChild(picker);
  customCard.appendChild(accentField);

  const densityField = el("div", "field");
  densityField.style.marginTop = "20px";
  densityField.appendChild(el("label", null, "Density"));
  const densitySeg = el("div", "segmented");
  densitySeg.setAttribute("role", "group");
  densitySeg.setAttribute("aria-label", "Layout density");
  [
    ["comfortable", "Comfortable"],
    ["compact", "Compact"],
  ].forEach(([value, label]) => {
    const btn = el("button", null, label);
    btn.type = "button";
    btn.setAttribute("aria-pressed", beta.density === value ? "true" : "false");
    btn.addEventListener("click", async () => {
      const updated = await call("set_beta", {
        beta: Object.assign({}, beta, { density: value }),
      });
      if (updated) {
        appState = normalizeState(updated);
        applyBetaTheme();
        setStatus("Density set to " + label.toLowerCase() + ".");
        renderProfile();
      } else {
        setStatus("Could not save that density.", true);
      }
    });
    densitySeg.appendChild(btn);
  });
  densityField.appendChild(densitySeg);
  customCard.appendChild(densityField);

  // Shelf order — up/down buttons (controller- and keyboard-friendly;
  // drag is hostile to the nav system, so up/down is the control).
  const orderField = el("div", "field");
  orderField.style.marginTop = "20px";
  orderField.appendChild(el("label", null, "Shelf order"));
  orderField.appendChild(
    el("p", "hint", "The order your shelves appear on Home. Use the arrows to move a shelf up or down.")
  );
  const orderList = el("div");
  const ordered = orderedShelves();
  ordered.forEach((shelf, index) => {
    const row = el("div", "shelf-order-row");
    row.appendChild(el("span", "so-name", shelf.name));
    row.appendChild(
      el("span", "so-count num", shelf.game_keys.length + " game" + (shelf.game_keys.length === 1 ? "" : "s"))
    );
    const move = async (delta) => {
      const next = ordered.slice();
      const at = next.indexOf(shelf);
      const to = at + delta;
      if (to < 0 || to >= next.length) return;
      next.splice(at, 1);
      next.splice(to, 0, shelf);
      const updated = await call("set_beta", {
        beta: Object.assign({}, beta, { shelf_order: next.map((s) => s.id) }),
      });
      if (updated) {
        appState = normalizeState(updated);
        setStatus("Shelf order saved.");
        renderProfile();
      } else {
        setStatus("Could not save the shelf order.", true);
      }
    };
    const upBtn = el("button", "order-btn", "↑");
    upBtn.type = "button";
    upBtn.setAttribute("aria-label", "Move " + shelf.name + " up");
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => move(-1));
    const downBtn = el("button", "order-btn", "↓");
    downBtn.type = "button";
    downBtn.setAttribute("aria-label", "Move " + shelf.name + " down");
    downBtn.disabled = index === ordered.length - 1;
    downBtn.addEventListener("click", () => move(1));
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    if (!shelf.builtin) {
      const deleteBtn = el("button", "order-btn", "×");
      deleteBtn.type = "button";
      deleteBtn.setAttribute("aria-label", "Delete shelf " + shelf.name);
      deleteBtn.addEventListener("click", async () => {
        if (!window.confirm('Delete the "' + shelf.name + '" shelf? Its games stay in your library.')) return;
        const shelves = (appState.shelves || []).filter((s) => s.id !== shelf.id);
        const updated = await call("set_shelves", { shelves });
        if (updated) {
          appState = normalizeState(updated);
          setStatus('Shelf "' + shelf.name + '" deleted.');
          renderProfile();
        } else {
          setStatus("Could not delete that shelf.", true);
        }
      });
      row.appendChild(deleteBtn);
    }
    orderList.appendChild(row);
  });
  orderField.appendChild(orderList);
  const newShelfRow = el("div");
  newShelfRow.style.display = "flex";
  newShelfRow.style.gap = "8px";
  newShelfRow.style.marginTop = "12px";
  const newShelfInput = el("input", "input");
  newShelfInput.type = "text";
  newShelfInput.placeholder = "New shelf name";
  newShelfInput.setAttribute("aria-label", "New shelf name");
  newShelfRow.appendChild(newShelfInput);
  const addShelfBtn = el("button", "btn", "Add shelf");
  addShelfBtn.type = "button";
  addShelfBtn.addEventListener("click", async () => {
    const name = newShelfInput.value.trim();
    if (!name) {
      setStatus("Give the shelf a name first.", true);
      return;
    }
    const id = "shelf-" + slugify(name) + "-" + Date.now().toString(36);
    const shelves = (appState.shelves || []).concat([
      { id, name, game_keys: [], builtin: false },
    ]);
    const updated = await call("set_shelves", { shelves });
    if (updated) {
      appState = normalizeState(updated);
      setStatus('Shelf "' + name + '" created.');
      renderProfile();
    } else {
      setStatus("Could not create that shelf.", true);
    }
  });
  newShelfRow.appendChild(addShelfBtn);
  orderField.appendChild(newShelfRow);
  customCard.appendChild(orderField);
  layout.appendChild(customCard);

  root.appendChild(layout);
}

async function saveGamerProfile(patch) {
  const current = gamerProfile();
  const next = {
    gamertag: patch.gamertag !== undefined ? patch.gamertag : current.gamertag || "",
    avatar: patch.avatar !== undefined ? patch.avatar : current.avatar || "",
    bio: patch.bio !== undefined ? patch.bio : current.bio || "",
    banner: patch.banner !== undefined ? patch.banner : current.banner || null,
  };
  const updated = await call("set_gamer_profile", { profile: next });
  if (!updated) {
    setStatus("Could not save your profile.", true);
    return null;
  }
  appState = normalizeState(updated);
  renderTopbarProfile();
  return updated;
}

async function loadMilestones(host) {
  if (!milestonesData) {
    milestonesData = await call("get_milestones");
  }
  clear(host);
  if (!milestonesData || !milestonesData.progress) {
    host.appendChild(el("p", "card-sub", "Milestones could not be loaded."));
    return;
  }
  milestonesData.progress.forEach((milestone) => {
    const item = el("div", "milestone");
    const top = el("div", "m-top");
    top.appendChild(el("span", "m-title", milestone.title));
    if (milestone.earned) top.appendChild(el("span", "earned-pill", "Earned"));
    top.appendChild(
      el(
        "span",
        "m-count num",
        milestone.current + " / " + milestone.target
      )
    );
    item.appendChild(top);
    item.appendChild(el("div", "m-desc", milestone.description));
    if (!milestone.earned && milestone.target > 0) {
      const track = el("div", "progress-track");
      const fill = el("div", "progress-fill");
      fill.style.width = Math.min(100, Math.round((milestone.current / milestone.target) * 100)) + "%";
      track.appendChild(fill);
      item.appendChild(track);
    }
    host.appendChild(item);
  });
}

// -------------------------------------------------------------- settings
// One question: "Is KOVA set up the way I want it?" Two-column
// layout (the dealt pattern): a label column beside a panel, split
// by full-width rules. One save model per panel: toggles and
// pickers save themselves; forms have their own Save button.
// NOTE: there is no command to toggle sync.enabled — the folder,
// push, and pull are the controls, and manual push/pull work
// regardless of the flag.

function settingsSection(root, title, description, summary) {
  const section = el("div", "settings-section");
  const labelCol = el("div", "settings-label");
  labelCol.appendChild(el("h2", null, title));
  labelCol.appendChild(el("p", null, description));
  if (summary) labelCol.appendChild(el("div", "label-summary", summary));
  section.appendChild(labelCol);
  const panel = el("div", "settings-panel");
  section.appendChild(panel);
  root.appendChild(section);
  return panel;
}

function switchRow(title, description, checked, onChange, badge) {
  const row = el("div", "switch-row");
  const body = el("div", "sr-body");
  const titleEl = el("div", "sr-title", title);
  if (badge) {
    const badgeEl = el("span", "status-badge" + (checked ? " on" : ""), badge);
    titleEl.appendChild(badgeEl);
  }
  body.appendChild(titleEl);
  body.appendChild(el("div", "sr-desc", description));
  row.appendChild(body);
  const toggle = el("button", "toggle");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", checked ? "true" : "false");
  toggle.setAttribute("aria-label", title);
  toggle.addEventListener("click", () => onChange(toggle.getAttribute("aria-checked") !== "true", toggle));
  row.appendChild(toggle);
  return row;
}

function renderSettings() {
  const root = views.settings;
  clear(root);
  titleRow(root, "Settings", "Your library, your data, your machine. Everything here stays local unless you push it.");

  // Updates.
  const updatePanel = settingsSection(
    root,
    "Updates",
    "KOVA checks its update feed for new versions. An update found here also raises a macOS notification.",
    "Installed version is shown on the check result."
  );
  const updateStatus = el("p", null, "Not checked yet this session.");
  updatePanel.appendChild(updateStatus);
  const updateNotes = el("div", "update-notes");
  updateNotes.hidden = true;
  updatePanel.appendChild(updateNotes);
  const updateActions = el("div", "panel-actions");
  const checkBtn = el("button", "btn", "Check for updates");
  checkBtn.type = "button";
  const installBtn = el("button", "btn btn-primary", "Install update");
  installBtn.type = "button";
  installBtn.hidden = true;
  const restartBtn = el("button", "btn btn-primary", "Restart KOVA");
  restartBtn.type = "button";
  restartBtn.hidden = true;
  checkBtn.addEventListener("click", async () => {
    updateStatus.textContent = "Checking for updates…";
    updateNotes.hidden = true;
    installBtn.hidden = true;
    restartBtn.hidden = true;
    const info = await call("check_update");
    if (!info) {
      updateStatus.textContent = "Couldn't check for updates. It will retry automatically.";
      return;
    }
    if (info.available) {
      pendingUpdateVersion = info.version;
      updateStatus.textContent =
        "Update available: KOVA " + info.version + " (you're on " + info.current_version + ").";
      if (info.notes) {
        updateNotes.textContent = info.notes;
        updateNotes.hidden = false;
      }
      installBtn.hidden = false;
      await call("notify_update_available", {
        version: info.version || "",
        notes: info.notes || "",
      });
    } else {
      pendingUpdateVersion = null;
      updateStatus.textContent = "You're on the latest version (KOVA " + info.current_version + ").";
    }
  });
  installBtn.addEventListener("click", async () => {
    updateStatus.textContent = "Downloading KOVA " + (pendingUpdateVersion || "") + "…";
    installBtn.hidden = true;
    const installed = await call("install_update");
    if (installed) {
      updateStatus.textContent = "KOVA " + installed + " is ready. Restart to finish the update.";
      restartBtn.hidden = false;
    } else {
      updateStatus.textContent = "Update failed. Your installed version is untouched. Try again.";
      installBtn.hidden = false;
    }
  });
  restartBtn.addEventListener("click", async () => {
    await call("restart_app");
  });
  updateActions.appendChild(checkBtn);
  updateActions.appendChild(installBtn);
  updateActions.appendChild(restartBtn);
  updatePanel.appendChild(updateActions);

  // Beta program.
  const beta = betaSettings();
  const betaPanel = settingsSection(
    root,
    "Beta program",
    "The beta is the early-access channel for the upcoming public platform update. The classic UI stays the main UI. Switching is instant.",
    "You are on the beta shell now."
  );
  betaPanel.appendChild(
    switchRow(
      "Join the beta",
      "Beta members get upcoming features first, behind feature flags in state.",
      beta.opted_in,
      async (next, toggle) => {
        if (!next) {
          if (
            !window.confirm(
              "Leave the beta? The classic UI returns, and your beta choices (accent, density, shelf order) stay saved for next time."
            )
          ) {
            return;
          }
          const updated = await call("set_beta", {
            beta: Object.assign({}, beta, { opted_in: false, ui: "classic" }),
          });
          if (updated) {
            window.location.href = "../index.html";
            return;
          }
          setStatus("Could not leave the beta.", true);
          return;
        }
        const updated = await call("set_beta", {
          beta: Object.assign({}, beta, { opted_in: true }),
        });
        if (updated) {
          appState = normalizeState(updated);
          toggle.setAttribute("aria-checked", "true");
          setStatus("Welcome to the beta.");
        } else {
          setStatus("Could not join the beta.", true);
        }
      },
      beta.opted_in ? "In the beta" : "Not in the beta"
    )
  );
  const uiField = el("div", "field");
  uiField.style.marginTop = "20px";
  uiField.appendChild(el("label", null, "Interface"));
  const uiSeg = el("div", "segmented");
  uiSeg.setAttribute("role", "group");
  uiSeg.setAttribute("aria-label", "Interface choice");
  [
    ["classic", "Classic"],
    ["beta", "Beta"],
  ].forEach(([value, label]) => {
    const btn = el("button", null, label);
    btn.type = "button";
    btn.setAttribute("aria-pressed", beta.ui === value ? "true" : "false");
    btn.addEventListener("click", async () => {
      if (value === "beta") return;
      const updated = await call("set_beta", {
        beta: Object.assign({}, beta, { ui: "classic" }),
      });
      if (updated) window.location.href = "../index.html";
      else setStatus("Could not switch interfaces.", true);
    });
    uiSeg.appendChild(btn);
  });
  uiField.appendChild(uiSeg);
  betaPanel.appendChild(uiField);

  // Sync.
  const sync = appState.sync || {};
  const syncPanel = settingsSection(
    root,
    "Sync",
    "Keep your state in your own cloud folder: iCloud, Drive, whatever you use. KOVA has no server holding it. Pulling replaces this machine's state wholesale: last write wins.",
    (sync.last_push_at ? "Last push " + fmtDateTime(sync.last_push_at) + "." : "Never pushed.") +
      " " +
      (sync.last_pull_at ? "Last pull " + fmtDateTime(sync.last_pull_at) + "." : "Never pulled.")
  );
  const syncField = el("div", "field");
  syncField.appendChild(el("label", null, "Sync folder"));
  const syncInput = el("input", "input");
  syncInput.type = "text";
  syncInput.placeholder = "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/KOVA";
  syncInput.value = sync.folder || "";
  syncInput.setAttribute("aria-label", "Sync folder path");
  syncField.appendChild(syncInput);
  syncField.appendChild(
    el("p", "hint", "The folder must already exist. KOVA writes into it; it does not pick it.")
  );
  syncPanel.appendChild(syncField);
  const syncActions = el("div", "panel-actions");
  const saveSyncBtn = el("button", "btn", "Save folder");
  saveSyncBtn.type = "button";
  saveSyncBtn.addEventListener("click", async () => {
    const updated = await call("set_sync_folder", { folder: syncInput.value.trim() || null });
    if (updated) {
      appState = normalizeState(updated);
      setStatus(syncInput.value.trim() ? "Sync folder saved." : "Sync folder cleared.");
      renderSettings();
    } else {
      setStatus("That folder does not exist or is not a folder.", true);
    }
  });
  const pushBtn = el("button", "btn", "Push now");
  pushBtn.type = "button";
  pushBtn.disabled = !sync.folder;
  pushBtn.addEventListener("click", async () => {
    const result = await call("push_state_to_sync");
    if (result) {
      appState.sync = result;
      setStatus("State pushed to your sync folder.");
      renderSettings();
    } else {
      setStatus("Could not push to the sync folder.", true);
    }
  });
  const pullBtn = el("button", "btn", "Pull now");
  pullBtn.type = "button";
  pullBtn.disabled = !sync.folder;
  pullBtn.addEventListener("click", async () => {
    if (
      !window.confirm(
        "Pull the state from your sync folder? This replaces everything on this machine. Local changes since the last push are discarded."
      )
    ) {
      return;
    }
    const updated = await call("pull_state_from_sync");
    if (updated) {
      appState = normalizeState(updated);
      applyBetaTheme();
      setStatus("State pulled from your sync folder.");
      applyStateShellCheck();
      renderSettings();
    } else {
      setStatus("Could not pull from the sync folder.", true);
    }
  });
  syncActions.appendChild(saveSyncBtn);
  syncActions.appendChild(pushBtn);
  syncActions.appendChild(pullBtn);
  syncPanel.appendChild(syncActions);

  // State backup / restore.
  const backupPanel = settingsSection(
    root,
    "State backup",
    "Export everything (gamertag, profiles, shelves, journal) as one file. Importing replaces the current state wholesale: last write wins.",
    "Your data, your machine, your backup."
  );
  const backupActions = el("div", "panel-actions");
  const exportBtn = el("button", "btn", "Export state");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", async () => {
    const state = (await call("get_state")) || appState;
    downloadFile(
      "kova-state-backup-" + todayDateString() + ".json",
      JSON.stringify(state, null, 2) + "\n"
    );
    setStatus("State exported.");
  });
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = "application/json,.json";
  importInput.hidden = true;
  importInput.setAttribute("aria-label", "Choose a state backup file");
  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const text = await file.text();
    importInput.value = "";
    if (
      !window.confirm(
        "Import this state file? It replaces everything on this machine. Your current state is discarded."
      )
    ) {
      return;
    }
    const updated = await call("import_state", { json: text });
    if (updated) {
      appState = normalizeState(updated);
      applyBetaTheme();
      setStatus("State imported.");
      applyStateShellCheck();
      renderSettings();
    } else {
      setStatus("That file is not a valid KOVA state file.", true);
    }
  });
  backupPanel.appendChild(importInput);
  const importBtn = el("button", "btn", "Import state");
  importBtn.type = "button";
  importBtn.addEventListener("click", () => importInput.click());
  backupActions.appendChild(exportBtn);
  backupActions.appendChild(importBtn);
  backupPanel.appendChild(backupActions);

  // Kids shelf.
  const kids = kidsSettings();
  const kidsPanel = settingsSection(
    root,
    "Kids shelf",
    "A locked-down shelf with only the games you approve, plus a daily time limit. When it is on, the whole app shows only approved games.",
    kids.enabled
      ? kids.allowed_keys.length +
        " approved game" +
        (kids.allowed_keys.length === 1 ? "" : "s") +
        (kids.daily_limit_minutes !== null && kids.daily_limit_minutes !== undefined
          ? ", " + kids.minutes_used_today + " of " + kids.daily_limit_minutes + " minutes used today."
          : ", no time limit.")
      : "Off. Every game shows."
  );
  kidsPanel.appendChild(
    switchRow(
      "Kids shelf",
      "Only approved games appear anywhere in KOVA.",
      kids.enabled,
      async (next, toggle) => {
        const updated = await call("set_kids", {
          kids: Object.assign({}, kids, { enabled: next }),
        });
        if (updated) {
          appState = normalizeState(updated);
          toggle.setAttribute("aria-checked", next ? "true" : "false");
          setStatus(next ? "Kids shelf is on." : "Kids shelf is off.");
          renderSettings();
        } else {
          setStatus("Could not change the kids shelf.", true);
        }
      },
      kids.enabled ? "On" : "Off"
    )
  );
  const limitField = el("div", "field");
  limitField.style.marginTop = "20px";
  limitField.appendChild(el("label", null, "Daily limit (minutes)"));
  const limitInput = el("input", "input");
  limitInput.type = "number";
  limitInput.min = "0";
  limitInput.placeholder = "No limit";
  limitInput.value =
    kids.daily_limit_minutes !== null && kids.daily_limit_minutes !== undefined
      ? String(kids.daily_limit_minutes)
      : "";
  limitInput.setAttribute("aria-label", "Daily play limit in minutes");
  limitField.appendChild(limitInput);
  limitField.appendChild(
    el("p", "hint", kids.minutes_used_today + " minutes used today" + (kids.used_date ? " (" + kids.used_date + ")" : "") + ". The counter rolls over at midnight.")
  );
  kidsPanel.appendChild(limitField);
  const kidsListLabel = el("div", "field");
  kidsListLabel.style.marginTop = "16px";
  kidsListLabel.appendChild(el("label", null, "Approved games"));
  const kidsList = el("div", "kids-list");
  const libraryGames = allGames();
  if (libraryGames.length === 0) {
    kidsList.appendChild(el("p", "card-sub", "No games in the library yet."));
  } else {
    libraryGames.forEach((game) => {
      const row = el("label", "check-row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = kids.allowed_keys.includes(game.key);
      box.addEventListener("change", async () => {
        const keys = kids.allowed_keys.slice();
        if (box.checked) {
          if (!keys.includes(game.key)) keys.push(game.key);
        } else {
          const at = keys.indexOf(game.key);
          if (at >= 0) keys.splice(at, 1);
        }
        const updated = await call("set_kids", {
          kids: Object.assign({}, kids, { allowed_keys: keys }),
        });
        if (updated) {
          appState = normalizeState(updated);
        } else {
          box.checked = !box.checked;
          setStatus("Could not update the approved list.", true);
        }
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(displayName(game)));
      kidsList.appendChild(row);
    });
  }
  kidsListLabel.appendChild(kidsList);
  kidsPanel.appendChild(kidsListLabel);
  const kidsActions = el("div", "panel-actions");
  const saveLimitBtn = el("button", "btn", "Save limit");
  saveLimitBtn.type = "button";
  saveLimitBtn.addEventListener("click", async () => {
    const raw = limitInput.value.trim();
    const limit = raw === "" ? null : Math.max(0, parseInt(raw, 10));
    const updated = await call("set_kids", {
      kids: Object.assign({}, kids, { daily_limit_minutes: limit }),
    });
    if (updated) {
      appState = normalizeState(updated);
      setStatus(limit === null ? "Time limit removed." : "Daily limit set to " + limit + " minutes.");
      renderSettings();
    } else {
      setStatus("Could not save the limit.", true);
    }
  });
  kidsActions.appendChild(saveLimitBtn);
  kidsPanel.appendChild(kidsActions);

  // Disk usage.
  const diskPanel = settingsSection(
    root,
    "Disk usage",
    "How much room each game takes. Sizes come from a walk of the install folders; games KOVA cannot measure show as unknown, never as zero.",
    diskUsageData
      ? fmtBytes(diskUsageData.total_bytes) +
        " total" +
        (diskUsageData.unknown_count > 0 ? ", " + diskUsageData.unknown_count + " unknown." : ".")
      : "Not measured yet."
  );
  const diskBody = el("div");
  diskBody.appendChild(el("p", "card-sub", "Measuring disk usage…"));
  diskPanel.appendChild(diskBody);
  loadDiskUsage(diskBody);

  // Library.
  const libraryPanel = settingsSection(
    root,
    "Library",
    "Where KOVA looks for games. Standalone folders add to the default ~/Games and ~/KOVA Games.",
    (appState.standalone_folders || []).length + " custom folder" + ((appState.standalone_folders || []).length === 1 ? "" : "s") + "."
  );
  const foldersList = el("div");
  (appState.standalone_folders || []).forEach((folder) => {
    const row = el("div", "backup-row");
    row.appendChild(el("span", "b-name", folder));
    const removeBtn = el("button", "btn btn-sm", "Remove");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", async () => {
      const folders = (appState.standalone_folders || []).filter((f) => f !== folder);
      const updated = await call("set_standalone_folders", { folders });
      if (updated) {
        appState = normalizeState(updated);
        setStatus("Folder removed. Rescan to update the library.");
        renderSettings();
      } else {
        setStatus("Could not remove that folder.", true);
      }
    });
    row.appendChild(removeBtn);
    foldersList.appendChild(row);
  });
  if ((appState.standalone_folders || []).length === 0) {
    foldersList.appendChild(el("p", "card-sub", "No custom folders. Using ~/Games and ~/KOVA Games."));
  }
  libraryPanel.appendChild(foldersList);
  const folderField = el("div", "field");
  folderField.style.marginTop = "16px";
  const folderInput = el("input", "input");
  folderInput.type = "text";
  folderInput.placeholder = "/Users/you/Games";
  folderInput.setAttribute("aria-label", "Standalone folder path");
  folderField.appendChild(folderInput);
  libraryPanel.appendChild(folderField);
  const steamField = el("div", "field");
  steamField.style.marginTop = "16px";
  steamField.appendChild(el("label", null, "Steam location (optional)"));
  const steamInput = el("input", "input");
  steamInput.type = "text";
  steamInput.placeholder = "Leave blank to auto-detect";
  steamInput.setAttribute("aria-label", "Steam location");
  steamField.appendChild(steamInput);
  libraryPanel.appendChild(steamField);
  const libraryActions = el("div", "panel-actions");
  const addFolderBtn = el("button", "btn", "Add folder");
  addFolderBtn.type = "button";
  addFolderBtn.addEventListener("click", async () => {
    const folder = folderInput.value.trim();
    if (!folder) {
      setStatus("Enter a folder path first.", true);
      return;
    }
    const folders = (appState.standalone_folders || []).concat([folder]);
    const updated = await call("set_standalone_folders", { folders });
    if (updated) {
      appState = normalizeState(updated);
      setStatus("Folder added. Rescan to update the library.");
      renderSettings();
    } else {
      setStatus("Could not add that folder.", true);
    }
  });
  const rescanBtn = el("button", "btn btn-primary", "Rescan library");
  rescanBtn.type = "button";
  rescanBtn.addEventListener("click", async () => {
    rescanBtn.disabled = true;
    setStatus("Scanning your library…");
    const result = await call("scan_library", {
      path: steamInput.value.trim() || null,
    });
    if (result) {
      library = result;
      const state = await call("get_state");
      if (state) appState = normalizeState(state);
      setStatus("Library scanned: " + result.total_games + " games.");
      renderSettings();
    } else {
      setStatus("Scan failed.", true);
    }
    rescanBtn.disabled = false;
  });
  libraryActions.appendChild(addFolderBtn);
  libraryActions.appendChild(rescanBtn);
  libraryPanel.appendChild(libraryActions);
  libraryPanel.appendChild(
    switchRow(
      "Show hidden games",
      "Hidden games appear dimmed in the Library instead of being filtered out.",
      Boolean(appState.show_hidden_games),
      async (next, toggle) => {
        const updated = await call("set_show_hidden_games", { show: next });
        if (updated) {
          appState = normalizeState(updated);
          toggle.setAttribute("aria-checked", next ? "true" : "false");
          setStatus(next ? "Hidden games will show." : "Hidden games are filtered out.");
        } else {
          setStatus("Could not change that setting.", true);
        }
      }
    )
  );

  // Feedback — a local note for now: no backend to send it to.
  const feedbackPanel = settingsSection(
    root,
    "Beta feedback",
    "Tell us what the beta shell gets wrong. For now this note is saved on this Mac. KOVA has nowhere to send it yet.",
    "Saved locally, never sent."
  );
  const feedbackField = el("div", "field");
  const feedbackInput = el("textarea", "textarea");
  feedbackInput.rows = 4;
  feedbackInput.placeholder = "What should change in the beta UI?";
  feedbackInput.setAttribute("aria-label", "Beta feedback note");
  try {
    feedbackInput.value = window.localStorage.getItem("kova-beta-feedback") || "";
  } catch (err) {
    /* storage unavailable — the field still works */
  }
  feedbackField.appendChild(feedbackInput);
  feedbackPanel.appendChild(feedbackField);
  const feedbackActions = el("div", "panel-actions");
  const saveFeedbackBtn = el("button", "btn", "Save note");
  saveFeedbackBtn.type = "button";
  saveFeedbackBtn.addEventListener("click", () => {
    try {
      window.localStorage.setItem("kova-beta-feedback", feedbackInput.value);
      setStatus("Feedback note saved on this Mac.");
    } catch (err) {
      setStatus("Could not save that note.", true);
    }
  });
  feedbackActions.appendChild(saveFeedbackBtn);
  feedbackPanel.appendChild(feedbackActions);
}

async function loadDiskUsage(host) {
  if (!diskUsageData) {
    diskUsageData = await call("get_disk_usage");
  }
  clear(host);
  if (!diskUsageData) {
    host.appendChild(el("p", "card-sub", "Disk usage could not be measured."));
    return;
  }
  const known = diskUsageData.games
    .filter((g) => g.size_bytes !== null && g.size_bytes !== undefined)
    .sort((a, b) => b.size_bytes - a.size_bytes);
  const max = known.length > 0 ? known[0].size_bytes : 1;
  const total = el("p", null, "");
  total.appendChild(document.createTextNode("Total measured: "));
  total.appendChild(el("strong", "num", fmtBytes(diskUsageData.total_bytes)));
  if (diskUsageData.unknown_count > 0) {
    total.appendChild(
      document.createTextNode(" · " + diskUsageData.unknown_count + " game" + (diskUsageData.unknown_count === 1 ? "" : "s") + " could not be measured.")
    );
  }
  host.appendChild(total);
  const list = el("div");
  list.style.marginTop = "8px";
  known.slice(0, 12).forEach((game) => {
    const row = el("div", "disk-row");
    row.appendChild(el("span", "d-name", game.name));
    const bar = el("div", "disk-bar");
    const track = el("div", "progress-track");
    const fill = el("div", "progress-fill");
    fill.style.width = Math.max(2, Math.round((game.size_bytes / max) * 100)) + "%";
    track.appendChild(fill);
    bar.appendChild(track);
    row.appendChild(bar);
    const size = el("span", "d-size num", fmtBytes(game.size_bytes) + (game.complete ? "" : " (partial)"));
    row.appendChild(size);
    list.appendChild(row);
  });
  if (known.length > 12) {
    list.appendChild(el("p", "panel-note", "And " + (known.length - 12) + " more measured games."));
  }
  if (known.length === 0) {
    list.appendChild(el("p", "card-sub", "No game sizes could be measured."));
  }
  host.appendChild(list);
}

// After a wholesale state replacement (pull / import), the new
// state may no longer select the beta shell — hand back to classic.
function applyStateShellCheck() {
  if (!invoke) return;
  const beta = betaSettings();
  if (!(beta.opted_in && beta.ui === "beta")) {
    window.location.href = "../index.html";
  }
}

// ------------------------------------------------------- session + kids poll

async function pollSession() {
  const session = await call("get_active_session");
  // Kids minute crediting: when a watched session ends, credit its
  // minutes to today's counter (the backend stores the counter;
  // the frontend owns the counting).
  if (lastSessionSeen && !session) {
    const kids = kidsSettings();
    if (kids.enabled) {
      const elapsed = Math.floor(Date.now() / 1000) - lastSessionSeen.started_at;
      const minutes = Math.max(0, Math.round(elapsed / 60));
      if (minutes > 0) {
        const today = todayDateString();
        const base = kids.used_date === today ? kids.minutes_used_today : 0;
        const updated = await call("set_kids", {
          kids: Object.assign({}, kids, {
            minutes_used_today: base + minutes,
            used_date: today,
          }),
        });
        if (updated) appState = normalizeState(updated);
      }
    }
  }
  lastSessionSeen = session;
  const changed =
    (activeSession && activeSession.game_key) !== (session && session.game_key) ||
    Boolean(activeSession) !== Boolean(session);
  activeSession = session;
  if (changed && currentView === "home") renderHome();
  if (session && currentView === "home") {
    const elTime = document.getElementById("np-elapsed");
    if (elTime) elTime.textContent = fmtDuration(session.elapsed_seconds);
  }
}

// --------------------------------------------------------------------- boot

function wireTopbar() {
  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      libraryQuery = searchInput.value.trim();
      if (currentView !== "library") {
        go("library");
      } else {
        renderLibrary();
      }
    });
  }
  const profileBtn = document.getElementById("topbar-profile");
  if (profileBtn) {
    profileBtn.addEventListener("click", () => go("profile"));
  }
}

async function boot() {
  appState = defaultState();
  wireTopbar();

  const state = await call("get_state");
  if (state) appState = normalizeState(state);
  // Second shell guard (the first runs in index.html): inside the
  // app, a state that no longer selects beta hands back to classic.
  if (invoke) {
    const beta = betaSettings();
    if (!(beta.opted_in && beta.ui === "beta")) {
      window.location.replace("../index.html");
      return;
    }
  }
  applyBetaTheme();
  renderTopbarProfile();

  // Midnight rollover for the kids counter: a stale used_date
  // means the counter belongs to a past day.
  const kids = kidsSettings();
  if (invoke && kids.enabled && kids.used_date && kids.used_date !== todayDateString()) {
    const updated = await call("set_kids", {
      kids: Object.assign({}, kids, { minutes_used_today: 0, used_date: todayDateString() }),
    });
    if (updated) appState = normalizeState(updated);
  }

  const scanned = await call("scan_library", { path: null });
  if (scanned) {
    library = scanned;
    const fresh = await call("get_state");
    if (fresh) appState = normalizeState(fresh);
    applyBetaTheme();
  }

  // Initial view: ?view= (design gate) wins once, then the hash.
  const gateView = QUERY.get("view");
  if (gateView && views[gateView] && !window.location.hash) {
    window.location.hash = "#/" + gateView;
  }
  window.addEventListener("hashchange", route);
  route();

  // Session polling: the Now playing strip + kids crediting.
  pollSession();
  setInterval(pollSession, 30000);

  // Controller + keyboard navigation, shared with classic.
  if (window.KovaNav) {
    window.KovaNav.init({
      onBack: () => {
        if (currentView === "detail") go("library");
        else if (currentView !== "home") go("home");
      },
      onHome: () => go("home"),
    });
  }
}

boot();
