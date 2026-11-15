// KOVA v1.2.0 — classic-shell features (plain JS, no framework).
// Loaded after main.js (defer order) and sharing its globals:
// invoke, appState, el, setStatus, currentProfile, saveProfile,
// mergeProfile, allGames, gamesForSource, gameTile, launchGame,
// profileStats, formatPlaytime, formatBytes, formatDate,
// formatDateTime, sourceLabel, renderAll, showView, scan, and the
// Kids helpers. main.js calls into window.KovaV12 at marked hook
// points; everything else here wires itself on DOMContentLoaded.
//
// Backend contract (workstream A, exact — do not guess):
//   get_perf_presets() -> [{id,label,engine,args[],is_fps_cap,note}]
//   get_active_session() -> {game_key,started_at,elapsed_seconds}|null
//   set_shelves(shelves) / set_beta(beta) / set_kids(kids) -> state
//   set_sync_folder(folder) -> state; push_state_to_sync() -> sync
//   pull_state_from_sync() -> state (LAST-WRITE-WINS — confirm first)
//   set_sync_enabled(enabled) -> state (v1.3.3; push/pull refuse while off)
//   set_save_backup_keep(keep) -> state (v1.3.3; server clamps 1..=50)
//   add_journal_entry(game_key,text) -> entries; get_journal()
//   backup_saves(game_key) / list_save_backups(game_key)
//   restore_save(game_key,backup_name) (safety-net backup automatic)
//   get_milestones() -> {earned[], progress:[{id,title,description,
//     earned,current,target}]}
//   get_disk_usage() -> {games:[{game_key,name,size_bytes|null,
//     complete}], total_bytes, unknown_count}
//   import_state(json) -> state (replaces everything — confirm first)
//   notify_update_available(version,notes) (macOS only, else no-op)
//   get_store_catalog() -> {source "live"|"bundled", catalog:{...}}
//
// Honesty limits enforced in the copy below: priority applies
// only to directly-spawned executables, Unix only, Low only
// (.app via `open` is a no-op; Windows stores it, never applies
// it; High runs at normal on Unix). Metal HUD is macOS-only,
// Metal games only. NO FPS cap exists on macOS — no cap control
// is rendered anywhere. Playtime counts only games KOVA launches
// locally. Controller battery is NOT exposed by the Gamepad API
// and is never shown.

(function () {
  "use strict";

  // ------------------------------------------------------------ dom

  var sessionBannerEl = document.getElementById("session-banner");
  var kidsBannerEl = document.getElementById("kids-banner");
  var storeListEl = document.getElementById("store-list");
  var storeSourceEl = document.getElementById("store-source");
  var bigPictureEl = document.getElementById("big-picture");
  var bigPictureGridEl = document.getElementById("big-picture-grid");
  var bigPictureOpenBtn = document.getElementById("big-picture-open");
  var bigPictureCloseBtn = document.getElementById("big-picture-close");
  var shelvesManageEl = document.getElementById("shelves-manage");
  var shelfNewNameInput = document.getElementById("shelf-new-name");
  var shelfCreateBtn = document.getElementById("shelf-create");
  var kidsSettingsEl = document.getElementById("kids-settings");
  var syncSettingsEl = document.getElementById("sync-settings");
  var saveBackupsSettingsEl = document.getElementById("save-backups-settings");
  var stateExportBtn = document.getElementById("state-export");
  var stateImportBtn = document.getElementById("state-import-btn");
  var stateImportInput = document.getElementById("state-import");
  var stateBackupNoteEl = document.getElementById("state-backup-note");
  var diskRefreshBtn = document.getElementById("disk-refresh");
  var diskUsageEl = document.getElementById("disk-usage");
  var betaSettingsEl = document.getElementById("beta-settings");
  var betaFeedbackInput = document.getElementById("beta-feedback-input");
  var betaFeedbackSaveBtn = document.getElementById("beta-feedback-save");
  var betaFeedbackListEl = document.getElementById("beta-feedback-list");
  var profileSessionsEl = document.getElementById("profile-sessions");
  var profileLibraryStatsEl = document.getElementById("profile-library-stats");
  var profileMilestonesEl = document.getElementById("profile-milestones");
  // KOVA LIVE surfaces (v12.js owns the classic LIVE UI: the
  // Profile join card, the Friends view + conversation, and the
  // Settings LIVE section — main.js owns only the view switch
  // hook and the state shape).
  var liveFriendsEl = document.getElementById("live-friends");
  var liveJoinEl = document.getElementById("live-join");
  var liveSettingsEl = document.getElementById("live-settings");
  var friendsBadgeEl = document.getElementById("friends-badge");
  var headerLiveStatusEl = document.getElementById("header-live-status");
  var onboardingEl = document.getElementById("onboarding");
  var onboardingBodyEl = document.getElementById("onboarding-body");
  var onboardingNextBtn = document.getElementById("onboarding-next");
  var onboardingSkipBtn = document.getElementById("onboarding-skip");

  // -------------------------------------------------------- utilities

  function state() {
    return appState || {};
  }

  function shelves() {
    return (state().shelves || []).slice();
  }

  function betaSettings() {
    return state().beta || { opted_in: false, ui: "classic", accent: "cyan", density: "comfortable", shelf_order: [] };
  }

  function kidsSettings() {
    return state().kids || { enabled: false, allowed_keys: [], daily_limit_minutes: null, minutes_used_today: 0, used_date: "" };
  }

  function syncSettings() {
    return state().sync || { enabled: true, folder: null, last_push_at: null, last_pull_at: null };
  }

  // v1.3.3 — snapshots kept per game. 0 / missing / non-numeric
  // behaves as 5; the backend clamps to 1..=50 on save.
  function saveBackupKeep() {
    var keep = state().save_backup_keep;
    if (typeof keep !== "number" || keep < 1) return 5;
    return Math.min(50, Math.floor(keep));
  }

  // Shelves in the player's order: beta.shelf_order first (when
  // set), then any shelves missing from it in stored order.
  function orderedShelves() {
    var list = shelves();
    var order = betaSettings().shelf_order || [];
    if (order.length === 0) return list;
    var byId = {};
    list.forEach(function (shelf) {
      byId[shelf.id] = shelf;
    });
    var ordered = [];
    order.forEach(function (id) {
      if (byId[id]) ordered.push(byId[id]);
    });
    list.forEach(function (shelf) {
      if (order.indexOf(shelf.id) < 0) ordered.push(shelf);
    });
    return ordered;
  }

  function gameByKey(key) {
    return allGames().find(function (game) {
      return game.key === key;
    }) || null;
  }

  function utcToday() {
    return new Date().toISOString().slice(0, 10);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: mime || "application/json" }), filename);
  }

  function isHttpUrl(value) {
    try {
      var parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (err) {
      return false;
    }
  }

  // Apply a full-state result from a set_* command and re-render.
  function applyState(updated) {
    if (!updated) return;
    appState = normalizeState(updated);
    renderAll();
  }

  // ------------------------------------------------------- §7 shelves

  // Home rows for the collection shelves. Only shelves with at
  // least one visible game (not hidden, Kids-allowed) render.
  // Returns the number of rows rendered.
  function renderHomeShelfRows(container) {
    var rendered = 0;
    orderedShelves().forEach(function (shelf) {
      var games = (shelf.game_keys || [])
        .map(gameByKey)
        .filter(Boolean)
        .filter(function (game) {
          return !game.hidden && kidsAllows(game);
        });
      if (games.length === 0) return;
      rendered += 1;
      var row = el("div", "shelf");
      var head = el("div", "shelf-head");
      head.appendChild(el("h3", "shelf-title", shelf.name));
      head.appendChild(
        el("span", "shelf-count", games.length + (games.length === 1 ? " game" : " games"))
      );
      row.appendChild(head);
      var strip = el("div", "strip-row");
      games.forEach(function (game) {
        strip.appendChild(gameTile(game, true));
      });
      row.appendChild(strip);
      container.appendChild(row);
    });
    return rendered;
  }

  async function saveShelves(next, message) {
    if (!invoke) return;
    try {
      var updated = await invoke("set_shelves", { shelves: next });
      applyState(updated);
      if (message) setStatus(message, false);
    } catch (err) {
      setStatus("Could not save shelves: " + err, true);
    }
  }

  function renderShelvesManage() {
    if (!shelvesManageEl) return;
    shelvesManageEl.innerHTML = "";
    var list = orderedShelves();
    if (list.length === 0) {
      shelvesManageEl.appendChild(
        el("p", "empty-note", "No shelves yet — the built-ins (Playing now, Backlog, Finished) appear after the first library scan.")
      );
      return;
    }
    list.forEach(function (shelf) {
      var row = el("div", "folder-row shelf-row");
      var nameInput = document.createElement("input");
      nameInput.className = "text-input shelf-name-input";
      nameInput.type = "text";
      nameInput.value = shelf.name;
      nameInput.maxLength = 40;
      nameInput.spellcheck = false;
      nameInput.setAttribute("aria-label", "Shelf name");
      // Built-ins are permanent fixtures: their names stay.
      nameInput.disabled = Boolean(shelf.builtin);
      row.appendChild(nameInput);
      row.appendChild(
        el(
          "span",
          "shelf-count-inline",
          (shelf.game_keys || []).length +
            ((shelf.game_keys || []).length === 1 ? " game" : " games")
        )
      );
      if (!shelf.builtin) {
        var renameBtn = el("button", "ghost folder-remove", "Rename");
        renameBtn.type = "button";
        renameBtn.addEventListener("click", function () {
          var nextName = nameInput.value.trim();
          if (!nextName) {
            setStatus("A shelf needs a name.", true);
            return;
          }
          var next = shelves().map(function (item) {
            return item.id === shelf.id
              ? { id: item.id, name: nextName, game_keys: item.game_keys, builtin: item.builtin }
              : item;
          });
          saveShelves(next, "Shelf renamed to “" + nextName + "”.");
        });
        row.appendChild(renameBtn);
        var deleteBtn = el("button", "ghost folder-remove", "Delete");
        deleteBtn.type = "button";
        deleteBtn.addEventListener("click", function () {
          if (
            !window.confirm(
              "Delete the “" + shelf.name + "” shelf? The games stay in your library — only the shelf goes."
            )
          ) {
            return;
          }
          var next = shelves().filter(function (item) {
            return item.id !== shelf.id;
          });
          saveShelves(next, "Shelf “" + shelf.name + "” deleted.");
        });
        row.appendChild(deleteBtn);
      } else {
        row.appendChild(el("span", "shelf-builtin-tag", "Built-in"));
      }
      shelvesManageEl.appendChild(row);
    });
  }

  // ------------------------------------------------- §1/§2/§7/§10 detail

  var perfPresetsCache = null;
  var perfPresetsFailed = false;

  async function loadPerfPresets() {
    if (perfPresetsCache || perfPresetsFailed || !invoke) return perfPresetsCache;
    try {
      perfPresetsCache = await invoke("get_perf_presets");
    } catch (err) {
      perfPresetsFailed = true;
    }
    return perfPresetsCache;
  }

  // Custom cover art: same canvas-downscale pattern as the avatar
  // upload, at cover size (512px attempts, then 256px), same
  // ~200 KB data-URL cap.
  function downscaleCover(file) {
    return new Promise(function (resolve, reject) {
      if (!file || file.type.indexOf("image/") !== 0) {
        reject(new Error("That file is not an image."));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("Could not read that image."));
      };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () {
          reject(new Error("Could not read that image."));
        };
        img.onload = function () {
          var attempts = [
            { size: 512, type: "image/png", quality: undefined },
            { size: 512, type: "image/jpeg", quality: 0.85 },
            { size: 256, type: "image/jpeg", quality: 0.7 },
          ];
          for (var i = 0; i < attempts.length; i++) {
            var attempt = attempts[i];
            var scale = Math.min(
              1,
              attempt.size / Math.max(img.naturalWidth, img.naturalHeight)
            );
            var width = Math.max(1, Math.round(img.naturalWidth * scale));
            var height = Math.max(1, Math.round(img.naturalHeight * scale));
            var canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            var ctx = canvas.getContext("2d");
            if (!ctx) continue;
            ctx.drawImage(img, 0, 0, width, height);
            var dataUrl =
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

  function detailCard(title) {
    var section = el("section", "profile-card detail-extra");
    section.appendChild(el("h2", null, title));
    return section;
  }

  function renderPlaytimeCard(game, profile) {
    var section = detailCard("Playtime");
    var total = profile.total_play_seconds || 0;
    var last = profile.last_session_seconds || 0;
    section.appendChild(
      el(
        "p",
        "profile-stats",
        total > 0
          ? "Played " + formatPlaytime(total) + " in total"
          : "No playtime recorded yet"
      )
    );
    if (profile.last_session_end) {
      section.appendChild(
        el(
          "p",
          "profile-note",
          "Last session: " +
            formatPlaytime(last) +
            " · ended " +
            formatDateTime(profile.last_session_end)
        )
      );
    }
    section.appendChild(
      el("p", "profile-note", "Playtime counts only games launched from KOVA.")
    );
    return section;
  }

  function renderPerfCard(game, profile) {
    var section = detailCard("Performance");
    // The honesty rule, same as launch args: a store URI or web
    // launch has no local process for KOVA to tune.
    if (!launchesLocalPath(game)) {
      section.appendChild(
        el(
          "p",
          "profile-note",
          "Performance settings apply to games installed on this Mac. " +
            "This title launches through a URI or the web, so KOVA controls nothing about its process."
        )
      );
      return section;
    }
    section.appendChild(
      el(
        "p",
        "profile-note",
        "macOS has no per-game FPS cap — use the game's own graphics settings. " +
          "What KOVA can do is pass launch arguments, show Apple's FPS HUD, and set process priority."
      )
    );

    var presetSelect = document.createElement("select");
    presetSelect.id = "perf-preset";
    presetSelect.className = "sort-select perf-select";
    var loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = "Loading presets…";
    presetSelect.appendChild(loadingOption);
    var presetNote = el("p", "profile-note", "");
    section.appendChild(profileField("Launch preset", presetSelect, null));
    section.appendChild(presetNote);

    function refreshPresetNote() {
      var selected = (perfPresetsCache || []).find(function (preset) {
        return preset.id === presetSelect.value;
      });
      if (!selected) {
        presetNote.textContent = "No preset — only your free-text launch options apply.";
        return;
      }
      presetNote.textContent =
        selected.args.join(" ") + " — " + selected.note;
    }

    loadPerfPresets().then(function (presets) {
      presetSelect.innerHTML = "";
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "No preset";
      presetSelect.appendChild(none);
      if (!presets) {
        var failed = document.createElement("option");
        failed.value = "";
        failed.textContent = "Presets unavailable";
        failed.disabled = true;
        presetSelect.appendChild(failed);
        presetNote.textContent = "The preset list could not be loaded.";
        return;
      }
      presets.forEach(function (preset) {
        var option = document.createElement("option");
        option.value = preset.id;
        option.textContent = preset.label + " (" + preset.engine + ")";
        presetSelect.appendChild(option);
      });
      presetSelect.value = profile.perf_launch_preset || "";
      refreshPresetNote();
    });
    presetSelect.addEventListener("change", refreshPresetNote);

    var hudRow = el("label", "toggle-row");
    var hudToggle = document.createElement("input");
    hudToggle.type = "checkbox";
    hudToggle.checked = Boolean(profile.perf_show_fps);
    hudRow.appendChild(hudToggle);
    hudRow.appendChild(document.createTextNode("Show FPS (Metal HUD)"));
    section.appendChild(hudRow);
    section.appendChild(
      el(
        "p",
        "profile-note",
        "Apple's Metal HUD, Metal games only — shows FPS, doesn't cap it."
      )
    );

    var prioritySelect = document.createElement("select");
    prioritySelect.className = "sort-select perf-select";
    [
      ["low", "Low"],
      ["normal", "Normal"],
      ["high", "High"],
    ].forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry[0];
      option.textContent = entry[1];
      prioritySelect.appendChild(option);
    });
    prioritySelect.value = profile.perf_priority || "normal";
    section.appendChild(profileField("Process priority", prioritySelect, null));
    section.appendChild(
      el(
        "p",
        "profile-note",
        "Low applies to directly-launched games; .app launches ignore priority. " +
          "High runs at normal priority on Unix; on Windows the setting is stored, not applied."
      )
    );

    // §10 one-tap launch modes: a bundle, stored per profile.
    var modeWrap = el("div", "launch-mode-row");
    var modeLabel = el("span", "field-label", "Launch mode");
    modeWrap.appendChild(modeLabel);
    var modes = [
      ["", "Off", "Your performance settings apply as stored."],
      ["quiet", "Quiet night", "Preset args if set, low priority."],
      ["full", "Full power", "FPS-cap presets dropped, high priority, FPS HUD on."],
    ];
    var modeRadios = {};
    modes.forEach(function (entry) {
      var label = el("label", "launch-mode-option");
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "launch-mode";
      radio.value = entry[0];
      radio.checked = (profile.launch_mode || "") === entry[0];
      modeRadios[entry[0]] = radio;
      label.appendChild(radio);
      label.appendChild(el("span", "launch-mode-name", entry[1]));
      label.appendChild(el("span", "launch-mode-desc", entry[2]));
      modeWrap.appendChild(label);
    });
    section.appendChild(modeWrap);

    var actions = el("div", "profile-actions");
    var saveBtn = el("button", null, "Save performance");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", function () {
      var next = currentProfile(game);
      next.perf_launch_preset = presetSelect.value || null;
      next.perf_show_fps = hudToggle.checked;
      next.perf_priority = prioritySelect.value;
      var chosenMode = "";
      modes.forEach(function (entry) {
        if (modeRadios[entry[0]] && modeRadios[entry[0]].checked) chosenMode = entry[0];
      });
      next.launch_mode = chosenMode || null;
      saveProfile(game, next, "Performance saved for " + displayName(game) + ".");
    });
    actions.appendChild(saveBtn);
    section.appendChild(actions);
    return section;
  }

  function renderRatingCard(game, profile) {
    var section = detailCard("Your take");
    var starsRow = el("div", "stars-row");
    starsRow.setAttribute("role", "radiogroup");
    starsRow.setAttribute("aria-label", "Your star rating");
    for (var star = 1; star <= 5; star++) {
      (function (value) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "star-btn" + (profile.rating && value <= profile.rating ? " lit" : "");
        btn.textContent = "★";
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", String(profile.rating === value));
        btn.setAttribute("aria-label", value + (value === 1 ? " star" : " stars"));
        btn.addEventListener("click", function () {
          var next = currentProfile(game);
          // Tapping the current rating clears it.
          next.rating = profile.rating === value ? null : value;
          saveProfile(
            game,
            next,
            next.rating
              ? "Rated " + displayName(game) + " " + next.rating + "/5."
              : "Rating cleared for " + displayName(game) + "."
          );
        });
        starsRow.appendChild(btn);
      })(star);
    }
    section.appendChild(starsRow);
    section.appendChild(
      el(
        "p",
        "profile-note",
        profile.rating
          ? "Your rating: " + profile.rating + "/5. Tap the same star again to clear it."
          : "Rate this game 1–5 stars. Private — it never leaves this machine."
      )
    );

    var noteArea = document.createElement("textarea");
    noteArea.className = "text-input detail-note";
    noteArea.maxLength = 2000;
    noteArea.placeholder = "A private note on this game…";
    noteArea.value = profile.note || "";
    section.appendChild(profileField("Private note", noteArea, null));
    var noteActions = el("div", "profile-actions");
    var noteSave = el("button", null, "Save note");
    noteSave.type = "button";
    noteSave.addEventListener("click", function () {
      var next = currentProfile(game);
      next.note = noteArea.value.trim() || null;
      saveProfile(game, next, "Note saved for " + displayName(game) + ".");
    });
    noteActions.appendChild(noteSave);
    section.appendChild(noteActions);

    var coverRow = el("div", "settings-row cover-row");
    var coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = "image/*";
    coverInput.hidden = true;
    var coverBtn = el("button", "ghost", profile.cover_art ? "Change cover art" : "Upload cover art");
    coverBtn.type = "button";
    coverBtn.addEventListener("click", function () {
      coverInput.click();
    });
    coverInput.addEventListener("change", function () {
      var file = coverInput.files && coverInput.files[0];
      coverInput.value = "";
      if (!file) return;
      downscaleCover(file)
        .then(function (dataUrl) {
          var next = currentProfile(game);
          next.cover_art = dataUrl;
          saveProfile(game, next, "Cover art saved for " + displayName(game) + ".");
        })
        .catch(function (err) {
          setStatus(err.message || String(err), true);
        });
    });
    coverRow.appendChild(coverBtn);
    if (profile.cover_art) {
      var coverRemove = el("button", "ghost", "Remove cover art");
      coverRemove.type = "button";
      coverRemove.addEventListener("click", function () {
        var next = currentProfile(game);
        next.cover_art = null;
        saveProfile(game, next, "Cover art removed for " + displayName(game) + ".");
      });
      coverRow.appendChild(coverRemove);
    }
    coverRow.appendChild(coverInput);
    section.appendChild(coverRow);
    section.appendChild(
      el("p", "profile-note", "Your tile, your art — uploads are shrunk on this machine to fit a 200 KB cap.")
    );
    return section;
  }

  function renderShelvesCard(game) {
    var section = detailCard("Shelves");
    var key = profileKey(game);
    var list = orderedShelves();
    if (list.length === 0) {
      section.appendChild(
        el("p", "profile-note", "No shelves yet — the built-ins appear after the first library scan.")
      );
      return section;
    }
    list.forEach(function (shelf) {
      var row = el("label", "toggle-row shelf-toggle");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = (shelf.game_keys || []).indexOf(key) >= 0;
      box.addEventListener("change", function () {
        var next = shelves().map(function (item) {
          if (item.id !== shelf.id) return item;
          var keys = (item.game_keys || []).slice();
          var at = keys.indexOf(key);
          if (box.checked && at < 0) keys.push(key);
          if (!box.checked && at >= 0) keys.splice(at, 1);
          return { id: item.id, name: item.name, game_keys: keys, builtin: item.builtin };
        });
        saveShelves(
          next,
          box.checked
            ? displayName(game) + " added to “" + shelf.name + "”."
            : displayName(game) + " removed from “" + shelf.name + "”."
        );
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(shelf.name));
      section.appendChild(row);
    });
    section.appendChild(
      el("p", "profile-note", "A game can sit on more than one shelf.")
    );
    return section;
  }

  function renderSaveBackupCard(game, profile) {
    var section = detailCard("Save backups");
    section.appendChild(
      el(
        "p",
        "profile-note",
        "Snapshots of this game's save files, kept on this machine. " +
          "Leave the folder blank and KOVA looks in the usual places by game name."
      )
    );
    var folderInput = document.createElement("input");
    folderInput.className = "text-input";
    folderInput.type = "text";
    folderInput.value = profile.save_folder || "";
    folderInput.placeholder = "Save folder (blank = auto-detect)";
    folderInput.spellcheck = false;
    section.appendChild(profileField("Save folder", folderInput, null));
    var resultNote = el("p", "profile-note", "");
    var actions = el("div", "profile-actions");
    var savePathBtn = el("button", "ghost", "Save folder");
    savePathBtn.type = "button";
    savePathBtn.addEventListener("click", function () {
      var next = currentProfile(game);
      next.save_folder = folderInput.value.trim() || null;
      saveProfile(game, next, "Save folder saved for " + displayName(game) + ".");
    });
    actions.appendChild(savePathBtn);
    var backupBtn = el("button", null, "Backup now");
    backupBtn.type = "button";
    backupBtn.addEventListener("click", function () {
      if (!invoke) return;
      backupBtn.disabled = true;
      resultNote.textContent = "Backing up saves…";
      invoke("backup_saves", { gameKey: profileKey(game) })
        .then(function (result) {
          resultNote.textContent =
            "Backed up " +
            result.files_copied +
            " files (" +
            formatBytes(result.backup.size_bytes) +
            ") from " +
            result.source_path +
            (result.files_skipped > 0 ? " · " + result.files_skipped + " skipped." : ".");
          refreshBackupList();
        })
        .catch(function (err) {
          resultNote.textContent = "";
          setStatus("Save backup failed: " + err, true);
        })
        .finally(function () {
          backupBtn.disabled = false;
        });
    });
    actions.appendChild(backupBtn);
    section.appendChild(actions);
    section.appendChild(resultNote);
    var listEl = el("div", "backup-list");
    section.appendChild(listEl);

    function refreshBackupList() {
      if (!invoke) return;
      listEl.innerHTML = "";
      listEl.appendChild(el("p", "profile-note", "Loading backups…"));
      invoke("list_save_backups", { gameKey: profileKey(game) })
        .then(function (backups) {
          listEl.innerHTML = "";
          if (!backups || backups.length === 0) {
            listEl.appendChild(el("p", "profile-note", "No backups yet."));
            return;
          }
          backups
            .slice()
            .sort(function (a, b) {
              return b.backed_up_at - a.backed_up_at;
            })
            .forEach(function (backup) {
              var row = el("div", "folder-row");
              row.appendChild(
                el(
                  "span",
                  "folder-path",
                  formatDateTime(backup.backed_up_at) + " · " + formatBytes(backup.size_bytes)
                )
              );
              var restoreBtn = el("button", "ghost folder-remove", "Restore");
              restoreBtn.type = "button";
              restoreBtn.addEventListener("click", function () {
                if (
                  !window.confirm(
                    "Restore this backup over the current saves? " +
                      "A safety-net backup of your current saves is taken first."
                  )
                ) {
                  return;
                }
                restoreBtn.disabled = true;
                invoke("restore_save", {
                  gameKey: profileKey(game),
                  backupName: backup.backup_name,
                })
                  .then(function () {
                    resultNote.textContent =
                      "Saves restored from the " +
                      formatDateTime(backup.backed_up_at) +
                      " backup. A safety-net backup of the previous saves was kept.";
                    refreshBackupList();
                  })
                  .catch(function (err) {
                    setStatus("Restore failed: " + err, true);
                  })
                  .finally(function () {
                    restoreBtn.disabled = false;
                  });
              });
              row.appendChild(restoreBtn);
              listEl.appendChild(row);
            });
        })
        .catch(function () {
          listEl.innerHTML = "";
          listEl.appendChild(el("p", "profile-note", "Could not list backups."));
        });
    }
    refreshBackupList();
    return section;
  }

  function renderJournalCard(game) {
    var section = detailCard("Journal");
    var key = profileKey(game);
    var listEl = el("div", "journal-list");
    section.appendChild(listEl);

    function refreshJournal() {
      if (!invoke) return;
      listEl.innerHTML = "";
      listEl.appendChild(el("p", "profile-note", "Loading entries…"));
      invoke("get_journal")
        .then(function (entries) {
          listEl.innerHTML = "";
          var mine = (entries || [])
            .filter(function (entry) {
              return entry.game_key === key;
            })
            .sort(function (a, b) {
              return b.timestamp - a.timestamp;
            });
          if (mine.length === 0) {
            listEl.appendChild(
              el("p", "profile-note", "No entries yet — write what you played, what you thought.")
            );
            return;
          }
          mine.forEach(function (entry) {
            var item = el("div", "journal-entry");
            item.appendChild(el("span", "journal-date", formatDateTime(entry.timestamp)));
            item.appendChild(el("p", "journal-text", entry.text));
            listEl.appendChild(item);
          });
        })
        .catch(function () {
          listEl.innerHTML = "";
          listEl.appendChild(el("p", "profile-note", "Could not load the journal."));
        });
    }
    refreshJournal();

    var entryArea = document.createElement("textarea");
    entryArea.className = "text-input detail-note";
    entryArea.maxLength = 2000;
    entryArea.placeholder = "After your session: what happened, what you thought…";
    section.appendChild(profileField("New entry", entryArea, null));
    var actions = el("div", "profile-actions");
    var addBtn = el("button", null, "Add entry");
    addBtn.type = "button";
    addBtn.addEventListener("click", function () {
      var text = entryArea.value.trim();
      if (!text || !invoke) return;
      addBtn.disabled = true;
      invoke("add_journal_entry", { gameKey: key, text: text })
        .then(function () {
          entryArea.value = "";
          refreshJournal();
          setStatus("Journal entry added.", false);
        })
        .catch(function (err) {
          setStatus("Could not add the entry: " + err, true);
        })
        .finally(function () {
          addBtn.disabled = false;
        });
    });
    actions.appendChild(addBtn);
    section.appendChild(actions);
    return section;
  }

  function normalizedName(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function renderDuplicateHint(game) {
    var norm = normalizedName(game.name);
    if (!norm) return null;
    var dupes = allGames().filter(function (other) {
      return (
        other.key !== game.key &&
        !other.hidden &&
        other.source !== game.source &&
        normalizedName(other.name) === norm
      );
    });
    if (dupes.length === 0) return null;
    var section = detailCard("Same game, two sources");
    section.appendChild(
      el(
        "p",
        "profile-note",
        "KOVA found this game on more than one source. Hide the copy you don't launch from, and it disappears from Home, the Library, and the Quick Panel — unhide it any time in Settings."
      )
    );
    dupes.forEach(function (dupe) {
      var row = el("div", "folder-row");
      row.appendChild(
        el("span", "folder-path", displayName(dupe) + " · " + sourceLabel(dupe.source))
      );
      var hideBtn = el("button", "ghost folder-remove", "Hide the " + sourceLabel(dupe.source) + " copy");
      hideBtn.type = "button";
      hideBtn.addEventListener("click", function () {
        var next = currentProfile(dupe);
        next.hidden = true;
        saveProfile(dupe, next, displayName(dupe) + " (" + sourceLabel(dupe.source) + ") hidden.");
      });
      row.appendChild(hideBtn);
      section.appendChild(row);
    });
    return section;
  }

  function renderDetailExtras(game) {
    var profile = currentProfile(game);
    var wrap = el("div", "detail-extras");
    wrap.appendChild(renderPlaytimeCard(game, profile));
    wrap.appendChild(renderPerfCard(game, profile));
    wrap.appendChild(renderRatingCard(game, profile));
    wrap.appendChild(renderShelvesCard(game));
    wrap.appendChild(renderSaveBackupCard(game, profile));
    wrap.appendChild(renderJournalCard(game));
    var dupeHint = renderDuplicateHint(game);
    if (dupeHint) wrap.appendChild(dupeHint);
    return wrap;
  }

  // ------------------------------------------- §7 session timer + kids

  var SESSION_POLL_MS = 30000;
  var sessionNotedHours = 0;
  var sessionKey = null;
  var kidsCountedMinutes = 0;
  var kidsAccumulating = false;

  function formatElapsed(seconds) {
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return hours + "h " + minutes + "m";
    if (minutes > 0) return minutes + "m";
    return "just started";
  }

  function onLaunched() {
    // A fresh launch resets the gentle-note clock; the next poll
    // picks the new session up.
    sessionNotedHours = 0;
    sessionKey = null;
    kidsCountedMinutes = 0;
  }

  async function pollSession() {
    if (!invoke || !sessionBannerEl) return;
    var active = null;
    try {
      active = await invoke("get_active_session");
    } catch (err) {
      return;
    }
    if (!active) {
      sessionBannerEl.hidden = true;
      sessionBannerEl.textContent = "";
      sessionKey = null;
      kidsCountedMinutes = 0;
      return;
    }
    if (sessionKey !== active.game_key) {
      sessionKey = active.game_key;
      sessionNotedHours = 0;
      kidsCountedMinutes = 0;
    }
    var game = gameByKey(active.game_key);
    var name = game ? displayName(game) : active.game_key;
    var hours = Math.floor(active.elapsed_seconds / 3600);
    var text = "Playing " + name + " — " + formatElapsed(active.elapsed_seconds) + ".";
    if (hours >= 2 && hours > sessionNotedHours) {
      sessionNotedHours = hours;
      text += " You've been playing " + hours + " hours — take a break if you like.";
    } else if (hours >= 2) {
      text += " You've been playing " + hours + " hours.";
    }
    // Kids time: accumulate whole minutes from the running
    // session into minutes_used_today (one set_kids per new
    // minute, never more often). The backend only watches the
    // most recent launch, so this counts the game on screen.
    if (kidsEnabled() && !kidsAccumulating) {
      var elapsedMinutes = Math.floor(active.elapsed_seconds / 60);
      if (elapsedMinutes > kidsCountedMinutes) {
        var delta = elapsedMinutes - kidsCountedMinutes;
        kidsCountedMinutes = elapsedMinutes;
        kidsAccumulating = true;
        var kids = kidsSettings();
        invoke("set_kids", {
          kids: {
            enabled: kids.enabled,
            allowed_keys: kids.allowed_keys,
            daily_limit_minutes: kids.daily_limit_minutes,
            minutes_used_today: (kids.minutes_used_today || 0) + delta,
            used_date: utcToday(),
          },
        })
          .then(function (updated) {
            if (updated) appState = normalizeState(updated);
            renderKidsBanner();
          })
          .catch(function () {})
          .finally(function () {
            kidsAccumulating = false;
          });
      }
      var remaining = kidsTimeRemainingMinutes();
      if (remaining !== null && remaining <= 0) {
        text += " Kids daily limit reached — launching is blocked until tomorrow.";
      }
    }
    sessionBannerEl.textContent = text;
    sessionBannerEl.hidden = false;
  }

  // The daily counter belongs to used_date: on a new day it
  // resets to zero (via set_kids, so the backend's own
  // validation sees a clean record).
  function maybeResetKidsDay() {
    if (!invoke || !kidsEnabled()) return;
    var kids = kidsSettings();
    var today = utcToday();
    if (kids.used_date === today) return;
    invoke("set_kids", {
      kids: {
        enabled: kids.enabled,
        allowed_keys: kids.allowed_keys,
        daily_limit_minutes: kids.daily_limit_minutes,
        minutes_used_today: 0,
        used_date: today,
      },
    })
      .then(function (updated) {
        if (updated) appState = normalizeState(updated);
        renderKidsBanner();
      })
      .catch(function () {});
  }

  function renderKidsBanner() {
    if (!kidsBannerEl) return;
    if (!kidsEnabled()) {
      kidsBannerEl.hidden = true;
      kidsBannerEl.textContent = "";
      return;
    }
    var remaining = kidsTimeRemainingMinutes();
    var kids = kidsSettings();
    var text = "Kids shelf is on — showing only approved games.";
    if (remaining === null) {
      text += " No daily time limit set.";
    } else if (remaining <= 0) {
      text += " Today's play time is used up.";
    } else if (remaining >= 60) {
      text +=
        " " +
        Math.floor(remaining / 60) +
        "h " +
        (remaining % 60) +
        "m left today (" +
        (kids.minutes_used_today || 0) +
        "m used).";
    } else {
      text += " " + remaining + " minutes left today (" + (kids.minutes_used_today || 0) + "m used).";
    }
    kidsBannerEl.textContent = text;
    kidsBannerEl.hidden = false;
  }

  // ------------------------------------------------------- §8 store

  // v1.3.1: Dre named the store review address — his Gmail.
  var STORE_REVIEW_ADDRESS = "deandrewh26@gmail.com";

  var storeCatalogCache = null;
  var storeCatalogLoading = false;

  function renderStore() {
    if (!storeListEl) return;
    if (!invoke) {
      storeListEl.innerHTML = "";
      storeListEl.appendChild(el("p", "empty-note", "The Game Store needs the KOVA app."));
      return;
    }
    if (!storeCatalogCache && !storeCatalogLoading) {
      storeCatalogLoading = true;
      storeListEl.innerHTML = "";
      storeListEl.appendChild(el("p", "empty-note", "Loading the store…"));
      invoke("get_store_catalog")
        .then(function (response) {
          storeCatalogCache = response;
          renderStore();
        })
        .catch(function () {
          storeListEl.innerHTML = "";
          storeListEl.appendChild(
            el("p", "empty-note", "Could not load the store catalog.")
          );
        })
        .finally(function () {
          storeCatalogLoading = false;
        });
      return;
    }
    if (!storeCatalogCache) return;
    var response = storeCatalogCache;
    var catalog = (response && response.catalog) || { listings: [] };
    if (storeSourceEl) {
      storeSourceEl.hidden = false;
      storeSourceEl.textContent =
        response.source === "bundled"
          ? "Offline catalog — showing the bundled listings. The live store catalog couldn't be reached."
          : "Live catalog from the KOVA site.";
    }
    storeListEl.innerHTML = "";
    var listings = catalog.listings || [];
    if (listings.length === 0) {
      storeListEl.appendChild(el("p", "empty-note", "No games listed yet."));
      return;
    }
    listings.forEach(function (listing) {
      var card = el("article", "store-card");
      var art = el("div", "art art-avok art-wide");
      art.appendChild(
        el("span", "art-initial", (listing.title || "?").trim().charAt(0).toUpperCase() || "?")
      );
      if (listing.art) {
        var img = document.createElement("img");
        img.className = "game-art-img";
        img.alt = "";
        img.loading = "lazy";
        img.src = listing.art;
        img.addEventListener("error", function () {
          img.remove();
        });
        art.appendChild(img);
      }
      card.appendChild(art);
      var body = el("div", "store-body");
      body.appendChild(el("h3", "store-title", listing.title || "Untitled"));
      body.appendChild(
        el(
          "p",
          "store-blurb",
          (listing.free ? "Free" : "Paid") +
            " · " +
            (listing.developer || "Independent developer") +
            (listing.version ? " · v" + listing.version : "")
        )
      );
      if (listing.description) {
        body.appendChild(el("p", "store-desc", listing.description));
      }
      var actions = el("div", "store-actions");
      // One button per platform the listing actually has, in
      // Dre's locked order: web, file, reddit. A stale v1-shape
      // catalog has no platforms at all, so the card just shows
      // no platform buttons instead of crashing.
      var platformButtons = [
        ["web", "Play on Web"],
        ["file", "Download"],
        ["reddit", "Play on Reddit"],
      ];
      var platforms = listing.platforms || {};
      var platformButtonsAdded = 0;
      platformButtons.forEach(function (entry) {
        var uri = platforms[entry[0]];
        if (!uri) return;
        var label = entry[1];
        var platformBtn = el(
          "button",
          platformButtonsAdded === 0 ? "play" : "ghost",
          label
        );
        platformButtonsAdded += 1;
        platformBtn.type = "button";
        platformBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          if (!invoke) return;
          invoke("launch_uri", { uri: uri }).catch(function (err) {
            setStatus("Could not open the link: " + err, true);
          });
        });
        actions.appendChild(platformBtn);
      });
      // Wishlist tie-in for Avok games: the catalog id matches
      // the library key ("avok:<id>") for Dispatch HQ and The
      // Open World.
      var libraryGame = gameByKey("avok:" + listing.id);
      if (libraryGame) {
        actions.appendChild(wishlistButton(libraryGame));
        var detailsBtn = el("button", "ghost", "Details");
        detailsBtn.type = "button";
        detailsBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          openDetail(libraryGame);
        });
        actions.appendChild(detailsBtn);
      }
      body.appendChild(actions);
      card.appendChild(body);
      storeListEl.appendChild(card);
    });
  }

  function wireStoreSubmit() {
    var downloadBtn = document.getElementById("store-submit-download-btn");
    var emailBtn = document.getElementById("store-submit-email-btn");
    if (!downloadBtn) return;
    var note = document.getElementById("store-submit-note");
    // The review address isn't named yet: say so up front so a
    // dev knows to download the application and send it once
    // the address is published.
    if (note && STORE_REVIEW_ADDRESS === "REVIEW_ADDRESS_NOT_SET") {
      note.textContent =
        "The store review address isn't set yet — download your application below and send it once the address is published. Listings are reviewed by the Avok team — nothing appears in the store until it's approved.";
    }
    function field(id) {
      var input = document.getElementById(id);
      return input ? (input.value || "").trim() : "";
    }
    function fail(message) {
      if (note) note.textContent = message;
      setStatus(message, true);
      return null;
    }
    // Validate the form and build the application package, or
    // return null (with the failure already shown).
    function buildApplication() {
      var title = field("store-submit-title");
      var description = field("store-submit-description");
      var genre = field("store-submit-genre");
      var art = field("store-submit-art");
      var web = field("store-submit-web");
      var file = field("store-submit-file");
      var reddit = field("store-submit-reddit");
      var timing = field("store-submit-timing");
      var developer = field("store-submit-developer");
      var contact = field("store-submit-contact");
      var version = field("store-submit-version") || "1.0.0";
      if (!title) return fail("A title is required.");
      if (!description) return fail("A description is required.");
      if (!genre) return fail("A genre is required.");
      if (art && !isHttpUrl(art)) {
        return fail("The art URL needs a full http(s) URL, if given.");
      }
      if (!web && !file && !reddit) {
        return fail("At least one platform link is required.");
      }
      if (web && !isHttpUrl(web)) {
        return fail("The web link needs a full http(s) URL.");
      }
      if (file && !isHttpUrl(file)) {
        return fail("The file link needs a full http(s) URL.");
      }
      if (reddit && !isHttpUrl(reddit)) {
        return fail("The Reddit link needs a full http(s) URL.");
      }
      if (!timing) return fail("A release timing is required.");
      if (!developer) return fail("A developer name is required.");
      if (!contact) return fail("A contact is required.");
      var slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!slug) return fail("The title needs at least one letter or number.");
      var platforms = {};
      if (web) platforms.web = web;
      if (file) platforms.file = file;
      if (reddit) platforms.reddit = reddit;
      return {
        slug: slug,
        pkg: {
          kind: "kova-store-application",
          application_version: 1,
          id: slug,
          title: title,
          description: description,
          genre: genre,
          art: art || null,
          platforms: platforms,
          developer: developer,
          contact: contact,
          timing: timing,
          free: true,
          version: version,
        },
      };
    }
    function applicationMailto(app) {
      var pkg = app.pkg;
      var lines = [
        "KOVA Store application",
        "",
        "Title: " + pkg.title,
        "Developer: " + pkg.developer,
        "Contact: " + pkg.contact,
        "Genre: " + pkg.genre,
        "Timing: " + pkg.timing,
        "Version: " + pkg.version,
        "Description: " +
          (pkg.description.length > 300
            ? pkg.description.slice(0, 300) + "…"
            : pkg.description),
      ];
      if (pkg.platforms.web) lines.push("Web: " + pkg.platforms.web);
      if (pkg.platforms.file) lines.push("File: " + pkg.platforms.file);
      if (pkg.platforms.reddit) lines.push("Reddit: " + pkg.platforms.reddit);
      if (pkg.art) lines.push("Art: " + pkg.art);
      return (
        "mailto:" +
        (STORE_REVIEW_ADDRESS === "REVIEW_ADDRESS_NOT_SET"
          ? ""
          : STORE_REVIEW_ADDRESS) +
        "?subject=" +
        encodeURIComponent("KOVA Store application: " + pkg.title) +
        "&body=" +
        encodeURIComponent(lines.join("\n"))
      );
    }
    downloadBtn.addEventListener("click", function () {
      var app = buildApplication();
      if (!app) return;
      downloadText(
        JSON.stringify(app.pkg, null, 2) + "\n",
        app.slug + "-application.json",
        "application/json"
      );
      if (note) {
        note.textContent =
          "Application downloaded as " +
          app.slug +
          "-application.json. Send it to Avok for review — listings are reviewed by the Avok team — nothing appears in the store until it's approved. There is no automatic submission." +
          (STORE_REVIEW_ADDRESS === "REVIEW_ADDRESS_NOT_SET"
            ? " The store review address isn't set yet; send the application once the address is published."
            : "");
      }
      setStatus("Application JSON downloaded.", false);
    });
    if (emailBtn) {
      emailBtn.addEventListener("click", function () {
        var app = buildApplication();
        if (!app) return;
        window.open(applicationMailto(app), "_self");
        if (note) {
          note.textContent =
            "Your mail client should have opened with the application pre-filled." +
            (STORE_REVIEW_ADDRESS === "REVIEW_ADDRESS_NOT_SET"
              ? " The store review address isn't set yet, so no recipient was filled in — add it once the address is published, or download the application instead."
              : " Send it to Avok for review — listings are reviewed by the Avok team.");
        }
        setStatus("Application opened in your mail client.", false);
      });
    }
  }

  // v1.3.2: the store application form lives in a modal behind
  // the "Open application" button on the Store page. The form
  // itself is static markup — closing only hides the modal, so
  // everything typed stays put between opens.
  function wireStoreSubmitModal() {
    var modal = document.getElementById("store-submit-modal");
    var openBtn = document.getElementById("store-submit-open-btn");
    var closeBtn = document.getElementById("store-submit-close-btn");
    if (!modal || !openBtn) return;
    function isOpen() {
      return !modal.hidden;
    }
    function open() {
      modal.hidden = false;
      var firstField = document.getElementById("store-submit-title");
      if (firstField) firstField.focus();
    }
    function close() {
      modal.hidden = true;
      openBtn.focus();
    }
    openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    // Backdrop click: only when the click lands on the dimmed
    // overlay itself, not on the card or anything inside it.
    modal.addEventListener("click", function (event) {
      if (event.target === modal) close();
    });
    // Escape closes the modal. Capture phase, so this runs
    // before nav.js's bubble-phase keydown handler — otherwise
    // nav would also fire its goBack on the same keypress.
    window.addEventListener(
      "keydown",
      function (event) {
        if (!isOpen()) return;
        if (event.key !== "Escape") return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      },
      true
    );
  }

  // -------------------------------------------------- §10 big picture

  function isBigPictureOpen() {
    return Boolean(bigPictureEl && !bigPictureEl.hidden);
  }

  function renderBigPictureGrid() {
    if (!bigPictureGridEl || !isBigPictureOpen()) return;
    bigPictureGridEl.innerHTML = "";
    var games = allGames()
      .filter(function (game) {
        return !game.hidden && kidsAllows(game);
      })
      .sort(function (a, b) {
        return (
          Number(b.favorite) - Number(a.favorite) ||
          displayName(a).toLowerCase().localeCompare(displayName(b).toLowerCase())
        );
      });
    if (games.length === 0) {
      bigPictureGridEl.appendChild(
        el("p", "empty-note", "No games to show — scan your library first.")
      );
      return;
    }
    games.forEach(function (game) {
      // Big Picture tiles launch on activation (no detail page
      // behind the overlay): a console grid, not a browser.
      var tile = el("article", "tile big-picture-tile");
      tile.tabIndex = 0;
      tile.dataset.navKey = game.key;
      tile.setAttribute("role", "button");
      tile.setAttribute("aria-label", "Launch " + displayName(game));
      tile.appendChild(gameArt(game, false));
      var body = el("div", "tile-body");
      body.appendChild(el("h3", "tile-title", displayName(game)));
      if (game.favorite) {
        body.appendChild(el("span", "fav-badge", "Favorite"));
      }
      var action = actionButton(game);
      if (action) body.appendChild(action);
      tile.appendChild(body);
      tile.addEventListener("click", function () {
        launchGame(game, null);
      });
      bigPictureGridEl.appendChild(tile);
    });
  }

  function openBigPicture() {
    if (!bigPictureEl) return;
    bigPictureEl.hidden = false;
    document.body.classList.add("big-picture-open");
    renderBigPictureGrid();
    if (window.KovaNav) window.KovaNav.focusFirst();
  }

  function closeBigPicture() {
    if (!bigPictureEl) return;
    bigPictureEl.hidden = true;
    document.body.classList.remove("big-picture-open");
    if (window.KovaNav) window.KovaNav.refresh();
  }

  function toggleBigPicture() {
    if (isBigPictureOpen()) closeBigPicture();
    else openBigPicture();
  }

  // --------------------------------------- §2/§7/§10 profile extras

  var milestonesCache = null;
  var milestonesLoading = false;
  var milestonesFetchedAt = 0;

  function renderRecentSessions() {
    if (!profileSessionsEl) return;
    profileSessionsEl.innerHTML = "";
    var profiles = state().profiles || {};
    var sessions = Object.keys(profiles)
      .map(function (key) {
        var profile = profiles[key];
        if (!profile || !profile.last_session_end) return null;
        var game = gameByKey(key);
        var name = game
          ? displayName(game)
          : (profile.name_override || "").trim() || key;
        return {
          name: name,
          seconds: profile.last_session_seconds || 0,
          ended: profile.last_session_end,
          total: profile.total_play_seconds || 0,
        };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return b.ended - a.ended;
      })
      .slice(0, 5);
    if (sessions.length === 0) {
      profileSessionsEl.appendChild(
        el("p", "empty-note", "No completed sessions yet — finish a game you launched from KOVA and it shows here.")
      );
      return;
    }
    sessions.forEach(function (session) {
      var row = el("div", "folder-row");
      row.appendChild(el("span", "folder-path", session.name));
      row.appendChild(
        el(
          "span",
          "session-meta",
          formatPlaytime(session.seconds) +
            " · ended " +
            formatDateTime(session.ended) +
            " · " +
            formatPlaytime(session.total) +
            " total"
        )
      );
      profileSessionsEl.appendChild(row);
    });
  }

  function renderLibraryStats() {
    if (!profileLibraryStatsEl) return;
    profileLibraryStatsEl.innerHTML = "";
    if (!lastResult) {
      profileLibraryStatsEl.appendChild(
        el("p", "empty-note", "Scan your library to see totals.")
      );
      return;
    }
    var games = allGames().filter(function (game) {
      return !game.hidden;
    });
    var stats = profileStats();
    var strip = el("div", "stats-strip");
    strip.setAttribute("role", "list");
    SOURCE_ORDER.forEach(function (source) {
      var count = games.filter(function (game) {
        return game.source === source;
      }).length;
      if (count === 0) return;
      strip.appendChild(statCell(sourceLabel(source), String(count), "games"));
    });
    strip.appendChild(
      statCell(
        "Total hours",
        stats.totalPlaySeconds === null ? "—" : formatPlaytime(stats.totalPlaySeconds),
        "games launched from KOVA"
      )
    );
    strip.appendChild(
      statCell(
        "Favorites",
        stats.favorites === null ? "—" : String(stats.favorites),
        "starred"
      )
    );
    profileLibraryStatsEl.appendChild(strip);
    profileLibraryStatsEl.appendChild(
      el(
        "p",
        "profile-note",
        stats.mostPlayedByTime
          ? "Most played: " +
            displayName(stats.mostPlayedByTime) +
            " (" +
            formatPlaytime(stats.mostPlayedByTime.total_play_seconds) +
            ")."
          : "Most played: nothing with recorded playtime yet."
      )
    );
  }

  function renderMilestones(force) {
    if (!profileMilestonesEl) return;
    var now = Date.now();
    if (milestonesCache && !force && now - milestonesFetchedAt < 60000) {
      paintMilestones(milestonesCache);
      return;
    }
    if (!invoke) {
      profileMilestonesEl.innerHTML = "";
      profileMilestonesEl.appendChild(el("p", "empty-note", "Milestones need the KOVA app."));
      return;
    }
    if (milestonesLoading) return;
    milestonesLoading = true;
    invoke("get_milestones")
      .then(function (response) {
        milestonesCache = response;
        milestonesFetchedAt = Date.now();
        paintMilestones(response);
      })
      .catch(function () {
        profileMilestonesEl.innerHTML = "";
        profileMilestonesEl.appendChild(el("p", "empty-note", "Could not load milestones."));
      })
      .finally(function () {
        milestonesLoading = false;
      });
  }

  function paintMilestones(response) {
    if (!profileMilestonesEl) return;
    profileMilestonesEl.innerHTML = "";
    var progress = (response && response.progress) || [];
    if (progress.length === 0) {
      profileMilestonesEl.appendChild(el("p", "empty-note", "No milestones yet."));
      return;
    }
    progress.forEach(function (item) {
      var row = el("div", "milestone-row" + (item.earned ? " earned" : ""));
      var badge = el("span", "milestone-badge", item.earned ? "★" : "☆");
      badge.setAttribute("aria-hidden", "true");
      row.appendChild(badge);
      var body = el("div", "milestone-body");
      body.appendChild(el("span", "milestone-title", item.title));
      body.appendChild(el("span", "milestone-desc", item.description));
      var isPlaytime = item.id === "playtime-500h";
      var currentText = isPlaytime ? formatPlaytime(item.current) : String(item.current);
      var targetText = isPlaytime ? formatPlaytime(item.target) : String(item.target);
      body.appendChild(
        el(
          "span",
          "milestone-progress",
          item.earned ? "Earned — " + targetText : currentText + " / " + targetText
        )
      );
      var bar = el("div", "milestone-bar");
      var fill = el("div", "milestone-fill");
      fill.style.width =
        Math.min(100, Math.round((item.current / Math.max(1, item.target)) * 100)) + "%";
      bar.appendChild(fill);
      body.appendChild(bar);
      row.appendChild(body);
      profileMilestonesEl.appendChild(row);
    });
  }

  function renderProfileExtras() {
    renderRecentSessions();
    renderLibraryStats();
    renderMilestones(false);
    renderLiveJoin();
  }

  // --------------------------------------------- §10/§11 settings extras

  function renderKidsSettings() {
    if (!kidsSettingsEl) return;
    kidsSettingsEl.innerHTML = "";
    var kids = kidsSettings();
    var toggleRow = el("label", "toggle-row");
    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(kids.enabled);
    toggle.addEventListener("change", function () {
      if (!invoke) return;
      var next = {
        enabled: toggle.checked,
        allowed_keys: kids.allowed_keys,
        daily_limit_minutes: kids.daily_limit_minutes,
        minutes_used_today: kids.minutes_used_today,
        used_date: kids.used_date || utcToday(),
      };
      invoke("set_kids", { kids: next })
        .then(function (updated) {
          applyState(updated);
          setStatus(
            toggle.checked
              ? "Kids shelf is on — the Library shows only approved games."
              : "Kids shelf is off.",
            false
          );
          // KOVA LIVE hides entirely on the Kids shelf; refresh
          // the status so the badge, the header line, and the
          // LIVE surfaces follow the switch at once.
          refreshLiveStatus();
        })
        .catch(function (err) {
          setStatus("Could not save Kids settings: " + err, true);
        });
    });
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(document.createTextNode("Kids shelf on"));
    kidsSettingsEl.appendChild(toggleRow);

    var used = kids.minutes_used_today || 0;
    var limit = kids.daily_limit_minutes;
    kidsSettingsEl.appendChild(
      el(
        "p",
        "profile-note",
        limit === null || limit === undefined
          ? "Today: " + used + " minutes used · no daily limit."
          : "Today: " + used + " of " + limit + " minutes used · " + Math.max(0, limit - used) + " left."
      )
    );

    var limitInput = document.createElement("input");
    limitInput.className = "text-input kids-limit-input";
    limitInput.type = "number";
    limitInput.min = "0";
    limitInput.max = "1440";
    limitInput.placeholder = "Daily limit in minutes (blank = none)";
    if (limit !== null && limit !== undefined) limitInput.value = String(limit);
    var limitRow = el("div", "settings-row");
    limitRow.appendChild(limitInput);
    var limitSave = el("button", "ghost", "Save limit");
    limitSave.type = "button";
    limitSave.addEventListener("click", function () {
      if (!invoke) return;
      var raw = limitInput.value.trim();
      var nextLimit = null;
      if (raw !== "") {
        nextLimit = Math.max(0, Math.min(1440, Math.floor(Number(raw))));
        if (Number.isNaN(nextLimit)) {
          setStatus("The daily limit needs a number of minutes.", true);
          return;
        }
      }
      invoke("set_kids", {
        kids: {
          enabled: kids.enabled,
          allowed_keys: kids.allowed_keys,
          daily_limit_minutes: nextLimit,
          minutes_used_today: kids.minutes_used_today,
          used_date: kids.used_date || utcToday(),
        },
      })
        .then(function (updated) {
          applyState(updated);
          setStatus(
            nextLimit === null ? "Daily limit removed." : "Daily limit set to " + nextLimit + " minutes.",
            false
          );
        })
        .catch(function (err) {
          setStatus("Could not save the daily limit: " + err, true);
        });
    });
    limitRow.appendChild(limitSave);
    kidsSettingsEl.appendChild(limitRow);

    kidsSettingsEl.appendChild(el("p", "profile-note", "Approved games — only these show when the Kids shelf is on:"));
    var games = allGames().filter(function (game) {
      return !game.hidden;
    });
    if (!lastResult) {
      kidsSettingsEl.appendChild(el("p", "empty-note", "Scan your library first to pick games."));
      return;
    }
    if (games.length === 0) {
      kidsSettingsEl.appendChild(el("p", "empty-note", "No games in the library yet."));
      return;
    }
    var picker = el("div", "kids-picker");
    games
      .slice()
      .sort(function (a, b) {
        return displayName(a).toLowerCase().localeCompare(displayName(b).toLowerCase());
      })
      .forEach(function (game) {
        var row = el("label", "toggle-row kids-pick");
        var box = document.createElement("input");
        box.type = "checkbox";
        box.checked = (kids.allowed_keys || []).indexOf(game.key) >= 0;
        box.addEventListener("change", function () {
          if (!invoke) return;
          var allowed = (kidsSettings().allowed_keys || []).slice();
          var at = allowed.indexOf(game.key);
          if (box.checked && at < 0) allowed.push(game.key);
          if (!box.checked && at >= 0) allowed.splice(at, 1);
          var current = kidsSettings();
          invoke("set_kids", {
            kids: {
              enabled: current.enabled,
              allowed_keys: allowed,
              daily_limit_minutes: current.daily_limit_minutes,
              minutes_used_today: current.minutes_used_today,
              used_date: current.used_date || utcToday(),
            },
          })
            .then(function (updated) {
              applyState(updated);
            })
            .catch(function (err) {
              setStatus("Could not save the Kids shelf: " + err, true);
            });
        });
        row.appendChild(box);
        row.appendChild(
          document.createTextNode(displayName(game) + " · " + sourceLabel(game.source))
        );
        picker.appendChild(row);
      });
    kidsSettingsEl.appendChild(picker);
  }

  function renderSyncSettings() {
    if (!syncSettingsEl) return;
    syncSettingsEl.innerHTML = "";
    var sync = syncSettings();
    var toggleRow = el("label", "toggle-row");
    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(sync.enabled);
    toggle.addEventListener("change", function () {
      if (!invoke) return;
      invoke("set_sync_enabled", { enabled: toggle.checked })
        .then(function (updated) {
          applyState(updated);
          setStatus(
            toggle.checked
              ? "Cloud sync is on — push and pull are available."
              : "Cloud sync is off — push and pull are paused. Your sync folder is kept.",
            false
          );
        })
        .catch(function (err) {
          setStatus("Could not change the sync setting: " + err, true);
        });
    });
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(document.createTextNode("Enable cloud sync"));
    syncSettingsEl.appendChild(toggleRow);
    if (!sync.enabled) {
      syncSettingsEl.appendChild(
        el("p", "profile-note", "Sync is off — push and pull are paused. Your sync folder is kept.")
      );
    }
    var folderInput = document.createElement("input");
    folderInput.className = "text-input";
    folderInput.type = "text";
    folderInput.value = sync.folder || "";
    folderInput.placeholder = "Sync folder, e.g. /Users/you/Library/Mobile Documents/com~apple~CloudDocs/KOVA";
    folderInput.spellcheck = false;
    folderInput.disabled = !sync.enabled;
    syncSettingsEl.appendChild(profileField("Sync folder", folderInput, null));
    var statusLine = el("p", "profile-note", "");
    function refreshStatus(current) {
      var parts = [];
      if (current.last_push_at) parts.push("Last push: " + formatDateTime(current.last_push_at));
      if (current.last_pull_at) parts.push("Last pull: " + formatDateTime(current.last_pull_at));
      statusLine.textContent =
        parts.length > 0
          ? parts.join(" · ")
          : "Nothing pushed or pulled yet. Sync is manual — push and pull when you choose.";
    }
    refreshStatus(sync);
    syncSettingsEl.appendChild(statusLine);
    var actions = el("div", "profile-actions");
    var saveBtn = el("button", null, "Save folder");
    saveBtn.type = "button";
    // v1.3.3: saving the folder is a dead control while sync is off
    // (the input is disabled) — match the beta shell, which disables
    // its Save folder button too.
    saveBtn.disabled = !sync.enabled;
    saveBtn.addEventListener("click", function () {
      if (!invoke) return;
      invoke("set_sync_folder", { folder: folderInput.value.trim() || null })
        .then(function (updated) {
          applyState(updated);
          setStatus("Sync folder saved.", false);
        })
        .catch(function (err) {
          setStatus("Could not save the sync folder: " + err, true);
        });
    });
    actions.appendChild(saveBtn);
    var pushBtn = el("button", "ghost", "Push now");
    pushBtn.type = "button";
    pushBtn.disabled = !sync.folder || !sync.enabled;
    pushBtn.addEventListener("click", function () {
      if (!invoke) return;
      pushBtn.disabled = true;
      invoke("push_state_to_sync")
        .then(function (updatedSync) {
          appState.sync = updatedSync;
          refreshStatus(updatedSync);
          setStatus("State pushed to your sync folder.", false);
        })
        .catch(function (err) {
          setStatus("Push failed: " + err, true);
        })
        .finally(function () {
          pushBtn.disabled = false;
        });
    });
    actions.appendChild(pushBtn);
    var pullBtn = el("button", "ghost", "Pull now");
    pullBtn.type = "button";
    pullBtn.disabled = !sync.folder || !sync.enabled;
    pullBtn.addEventListener("click", function () {
      if (!invoke) return;
      if (
        !window.confirm(
          "Pulling replaces EVERYTHING on this machine — gamertag, profiles, wishlist, shelves — " +
            "with the copy in your sync folder. Last-write-wins: this machine's newer changes are lost. Continue?"
        )
      ) {
        return;
      }
      pullBtn.disabled = true;
      invoke("pull_state_from_sync")
        .then(function (updated) {
          applyState(updated);
          renderProfileSettings();
          setStatus("State pulled from your sync folder.", false);
        })
        .catch(function (err) {
          setStatus("Pull failed: " + err, true);
        })
        .finally(function () {
          pullBtn.disabled = false;
        });
    });
    actions.appendChild(pullBtn);
    syncSettingsEl.appendChild(actions);
  }

  // v1.3.3 — how many save snapshots to keep per game. The
  // backend prunes to the newest N when the next backup is taken.
  function renderSaveBackupSettings() {
    if (!saveBackupsSettingsEl) return;
    saveBackupsSettingsEl.innerHTML = "";
    var keepInput = document.createElement("input");
    keepInput.className = "text-input";
    keepInput.type = "number";
    keepInput.min = "1";
    keepInput.max = "50";
    keepInput.value = String(saveBackupKeep());
    saveBackupsSettingsEl.appendChild(profileField("Keep the newest snapshots per game", keepInput, null));
    saveBackupsSettingsEl.appendChild(
      el("p", "profile-note", "Older snapshots are removed when the next backup is taken.")
    );
    var actions = el("div", "profile-actions");
    var saveBtn = el("button", null, "Save");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", function () {
      if (!invoke) return;
      var raw = keepInput.value.trim();
      var keep = Math.floor(Number(raw));
      if (raw === "" || Number.isNaN(keep)) keep = 5;
      keep = Math.max(1, Math.min(50, keep));
      invoke("set_save_backup_keep", { keep: keep })
        .then(function (updated) {
          applyState(updated);
          setStatus("Keeping the newest " + keep + " snapshot" + (keep === 1 ? "" : "s") + " per game.", false);
        })
        .catch(function (err) {
          setStatus("Could not save the backup setting: " + err, true);
        });
    });
    actions.appendChild(saveBtn);
    saveBackupsSettingsEl.appendChild(actions);
  }

  var BETA_FEEDBACK_KEY = "kova-beta-feedback";

  function readBetaFeedback() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(BETA_FEEDBACK_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function writeBetaFeedback(notes) {
    try {
      window.localStorage.setItem(BETA_FEEDBACK_KEY, JSON.stringify(notes));
    } catch (err) {
      /* storage unavailable — the note is lost, the app goes on */
    }
  }

  function renderBetaFeedbackList() {
    if (!betaFeedbackListEl) return;
    betaFeedbackListEl.innerHTML = "";
    var notes = readBetaFeedback();
    if (notes.length === 0) {
      betaFeedbackListEl.appendChild(
        el("p", "profile-note", "No feedback notes saved yet.")
      );
      return;
    }
    notes
      .slice()
      .sort(function (a, b) {
        return (b.at || 0) - (a.at || 0);
      })
      .forEach(function (note) {
        var row = el("div", "folder-row beta-feedback-row");
        var body = el("div", "beta-feedback-body");
        body.appendChild(
          el("span", "journal-date", note.at ? formatDateTime(Math.floor(note.at / 1000)) : "")
        );
        body.appendChild(el("p", "journal-text", note.text || ""));
        row.appendChild(body);
        var deleteBtn = el("button", "ghost folder-remove", "Delete");
        deleteBtn.type = "button";
        deleteBtn.addEventListener("click", function () {
          writeBetaFeedback(
            readBetaFeedback().filter(function (item) {
              return item !== note;
            })
          );
          renderBetaFeedbackList();
        });
        row.appendChild(deleteBtn);
        betaFeedbackListEl.appendChild(row);
      });
  }

  function renderBetaSettings() {
    if (!betaSettingsEl) return;
    betaSettingsEl.innerHTML = "";
    var beta = betaSettings();
    if (beta.opted_in) {
      betaSettingsEl.appendChild(el("span", "beta-badge", "BETA"));
    }
    var toggleRow = el("label", "toggle-row");
    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(beta.opted_in);
    toggle.addEventListener("change", function () {
      if (!invoke) return;
      // Leaving the beta: a UI that still needs the beta falls back
      // to Classic; a graduated UI (Stage after its 30-day run)
      // keeps running without the beta.
      var staysWithoutBeta =
        window.KovaUi && window.KovaUi.mayRun
          ? window.KovaUi.mayRun(
              Object.assign({}, beta, { opted_in: false }),
              beta.ui
            )
          : beta.ui === "classic";
      var nextUi = toggle.checked
        ? beta.ui
        : staysWithoutBeta
          ? beta.ui
          : "classic";
      var next = {
        opted_in: toggle.checked,
        ui: nextUi,
        accent: beta.accent,
        density: beta.density,
        shelf_order: beta.shelf_order,
        ui_beta_start: beta.ui_beta_start,
      };
      invoke("set_beta", { beta: next })
        .then(function (updated) {
          applyState(updated);
          if (!toggle.checked && nextUi === "third") {
            // Left the beta but Stage graduated: land on Stage.
            window.location.href = "third/index.html";
            return;
          }
          setStatus(
            toggle.checked
              ? "You're in the KOVA beta — pick a UI below to try the new shell."
              : "You left the beta — Classic UI.",
            false
          );
        })
        .catch(function (err) {
          setStatus("Could not save beta settings: " + err, true);
        });
    });
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(document.createTextNode("Join the KOVA beta"));
    betaSettingsEl.appendChild(toggleRow);

    // The UI selector appears when opted in, or when a graduated UI
    // (Stage, after its 30-day beta run) is available to everyone —
    // a non-beta player then sees Classic + Stage, not Beta.
    var availableUis =
      window.KovaUi && window.KovaUi.availableUis
        ? window.KovaUi.availableUis(beta)
        : beta.opted_in
          ? ["classic", "beta"]
          : ["classic"];
    if (availableUis.length > 1) {
      var selector = el("div", "beta-ui-selector");
      selector.appendChild(el("span", "field-label", "Interface"));
      var UI_OPTIONS = {
        classic: ["Classic", "The current KOVA UI."],
        beta: ["Beta", "The brand-new light UI. Switching reloads the app into the beta shell."],
        third: ["Stage", "The gaming-OS home: one hero game, rows, art-first library."],
      };
      availableUis.forEach(function (uiId) {
        var entry = [uiId, UI_OPTIONS[uiId][0], UI_OPTIONS[uiId][1]];
        var label = el("label", "launch-mode-option");
        var radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "beta-ui";
        radio.value = entry[0];
        radio.checked = beta.ui === entry[0];
        radio.addEventListener("change", function () {
          if (!invoke || !radio.checked) return;
          var nextBeta = Object.assign({}, beta, { ui: entry[0] });
          // Picking Stage for the first time stamps its beta start.
          if (entry[0] === "third" && window.KovaUi && window.KovaUi.withStartStamp) {
            nextBeta = window.KovaUi.withStartStamp(nextBeta, "third");
          }
          invoke("set_beta", { beta: nextBeta })
            .then(function (updated) {
              if (updated) appState = normalizeState(updated);
              if (entry[0] === "beta") {
                window.location.href = "beta/index.html";
              } else if (entry[0] === "third") {
                window.location.href = "third/index.html";
              } else {
                renderAll();
              }
            })
            .catch(function (err) {
              setStatus("Could not switch UI: " + err, true);
            });
        });
        label.appendChild(radio);
        label.appendChild(el("span", "launch-mode-name", entry[1]));
        label.appendChild(el("span", "launch-mode-desc", entry[2]));
        selector.appendChild(label);
      });
      betaSettingsEl.appendChild(selector);
    }
    renderBetaFeedbackList();
  }

  function renderDiskUsage() {
    if (!diskUsageEl || !invoke) return;
    diskUsageEl.innerHTML = "";
    diskUsageEl.appendChild(el("p", "profile-note", "Measuring… (bounded walk — large libraries take a moment.)"));
    invoke("get_disk_usage")
      .then(function (usage) {
        diskUsageEl.innerHTML = "";
        var games = (usage.games || []).slice().sort(function (a, b) {
          var aSize = a.size_bytes === null || a.size_bytes === undefined ? -1 : a.size_bytes;
          var bSize = b.size_bytes === null || b.size_bytes === undefined ? -1 : b.size_bytes;
          return bSize - aSize;
        });
        var anyPartial = games.some(function (game) {
          return !game.complete;
        });
        var totalLine =
          "Total: " +
          (anyPartial || usage.unknown_count > 0 ? "at least " : "") +
          formatBytes(usage.total_bytes);
        if (usage.unknown_count > 0) {
          totalLine +=
            " · " +
            usage.unknown_count +
            (usage.unknown_count === 1 ? " game" : " games") +
            " with unknown size.";
        }
        diskUsageEl.appendChild(el("p", "profile-stats", totalLine));
        if (games.length === 0) {
          diskUsageEl.appendChild(el("p", "empty-note", "No games measured — scan your library first."));
          return;
        }
        games.forEach(function (game) {
          var row = el("div", "folder-row");
          row.appendChild(el("span", "folder-path", game.name || game.game_key));
          var sizeText =
            game.size_bytes === null || game.size_bytes === undefined
              ? "size unknown"
              : (game.complete ? "" : "at least ") + formatBytes(game.size_bytes);
          row.appendChild(el("span", "session-meta", sizeText));
          diskUsageEl.appendChild(row);
        });
      })
      .catch(function (err) {
        diskUsageEl.innerHTML = "";
        diskUsageEl.appendChild(el("p", "profile-note", "Could not measure disk usage: " + err));
      });
  }

  function renderSettingsExtras() {
    renderShelvesManage();
    renderKidsSettings();
    renderSyncSettings();
    renderSaveBackupSettings();
    renderBetaSettings();
    renderLiveSettings();
  }

  // -------------------------------------------------- §7 state backup

  function wireStateBackup() {
    if (stateExportBtn) {
      stateExportBtn.addEventListener("click", function () {
        if (!invoke) return;
        invoke("get_state")
          .then(function (stateValue) {
            downloadText(
              JSON.stringify(stateValue, null, 2) + "\n",
              "kova-state.json",
              "application/json"
            );
            if (stateBackupNoteEl) {
              stateBackupNoteEl.textContent = "State exported as kova-state.json.";
            }
            setStatus("State exported.", false);
          })
          .catch(function (err) {
            setStatus("Export failed: " + err, true);
          });
      });
    }
    if (stateImportBtn && stateImportInput) {
      stateImportBtn.addEventListener("click", function () {
        stateImportInput.click();
      });
      stateImportInput.addEventListener("change", function () {
        var file = stateImportInput.files && stateImportInput.files[0];
        stateImportInput.value = "";
        if (!file || !invoke) return;
        var reader = new FileReader();
        reader.onerror = function () {
          setStatus("Could not read that file.", true);
        };
        reader.onload = function () {
          if (
            !window.confirm(
              "Importing replaces EVERYTHING — gamertag, profiles, wishlist, shelves, all of it — " +
                "with this file's contents. Your current state is lost unless you exported it first. Continue?"
            )
          ) {
            return;
          }
          invoke("import_state", { json: String(reader.result || "") })
            .then(function (updated) {
              applyState(updated);
              renderProfileSettings();
              if (stateBackupNoteEl) {
                stateBackupNoteEl.textContent = "State imported — rescanning the library.";
              }
              setStatus("State imported.", false);
              scan();
            })
            .catch(function (err) {
              setStatus("Import failed: " + err, true);
            });
        };
        reader.readAsText(file);
      });
    }
  }

  // ------------------------------------------- §7 update notification

  var NOTIFIED_UPDATE_KEY = "kova-notified-update";

  function notifyUpdateOnce(version, notes) {
    if (!invoke || !version) return;
    try {
      if (window.localStorage.getItem(NOTIFIED_UPDATE_KEY) === version) return;
    } catch (err) {
      /* storage unavailable — notify anyway, once per check */
    }
    invoke("notify_update_available", { version: version, notes: notes || "" })
      .then(function () {
        try {
          window.localStorage.setItem(NOTIFIED_UPDATE_KEY, version);
        } catch (err) {
          /* ignore */
        }
      })
      .catch(function () {
        /* best-effort: the Settings badge is the fallback */
      });
  }

  // ------------------------------------------------ §7 first-run flow

  var ONBOARDED_KEY = "kova-onboarded";
  var onboardingStep = 0;
  var onboardingGamertag = "";
  var onboardingAvatar = "";

  function isFreshInstall() {
    var profile = gamerProfile();
    var tag = (profile.gamertag || "").trim();
    var recents = (state().recents || []).length;
    var profileCount = Object.keys(state().profiles || {}).length;
    return !tag && recents === 0 && profileCount === 0;
  }

  function maybeShowOnboarding() {
    if (!invoke || !onboardingEl) return;
    try {
      if (window.localStorage.getItem(ONBOARDED_KEY) === "1") return;
    } catch (err) {
      /* storage unavailable — show once per launch at most */
    }
    if (!isFreshInstall()) return;
    onboardingStep = 0;
    renderOnboardingStep();
    onboardingEl.hidden = false;
  }

  function finishOnboarding() {
    try {
      window.localStorage.setItem(ONBOARDED_KEY, "1");
    } catch (err) {
      /* ignore */
    }
    if (onboardingEl) onboardingEl.hidden = true;
  }

  function renderOnboardingStep() {
    if (!onboardingBodyEl || !onboardingNextBtn) return;
    onboardingBodyEl.innerHTML = "";
    if (onboardingStep === 0) {
      onboardingBodyEl.appendChild(
        el("p", "settings-note", "Step 1 of 3 — find your games. KOVA scans Steam, Epic, GOG, itch, and your standalone folders into one library.")
      );
      var scanBtn = el("button", null, "Scan my library");
      scanBtn.type = "button";
      scanBtn.addEventListener("click", function () {
        scan();
        setStatus("Scanning your library…", false);
      });
      onboardingBodyEl.appendChild(scanBtn);
      onboardingNextBtn.textContent = "Continue";
    } else if (onboardingStep === 1) {
      onboardingBodyEl.appendChild(
        el("p", "settings-note", "Step 2 of 3 — your gamertag. It's your KOVA LIVE tag too, and it lives only on this machine.")
      );
      var tagInput = document.createElement("input");
      tagInput.className = "text-input";
      tagInput.type = "text";
      tagInput.placeholder = "Your gamertag";
      tagInput.maxLength = 32;
      tagInput.spellcheck = false;
      tagInput.value = onboardingGamertag;
      tagInput.addEventListener("input", function () {
        onboardingGamertag = tagInput.value.trim();
      });
      onboardingBodyEl.appendChild(tagInput);
      onboardingNextBtn.textContent = "Continue";
    } else {
      onboardingBodyEl.appendChild(
        el("p", "settings-note", "Step 3 of 3 — pick an avatar. You can upload your own picture later in Settings.")
      );
      var options = el("div", "avatar-options");
      AVATAR_OPTIONS.forEach(function (option) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "avatar-option" + (onboardingAvatar === option.value ? " selected" : "");
        btn.appendChild(avatarElement(option.value, "avatar-md"));
        btn.appendChild(el("span", "avatar-option-label", option.label));
        btn.addEventListener("click", function () {
          onboardingAvatar = option.value;
          renderOnboardingStep();
        });
        options.appendChild(btn);
      });
      onboardingBodyEl.appendChild(options);
      onboardingNextBtn.textContent = "Done";
    }
  }

  function wireOnboarding() {
    if (onboardingNextBtn) {
      onboardingNextBtn.addEventListener("click", function () {
        if (onboardingStep < 2) {
          onboardingStep += 1;
          renderOnboardingStep();
          return;
        }
        // Done: save the gamertag + avatar (if either was set),
        // then close. A save failure never blocks finishing.
        if (!invoke || (!onboardingGamertag && !onboardingAvatar)) {
          finishOnboarding();
          return;
        }
        var current = gamerProfile();
        invoke("set_gamer_profile", {
          profile: {
            gamertag: onboardingGamertag || current.gamertag || "",
            avatar: onboardingAvatar || current.avatar || "",
            bio: current.bio || "",
          },
        })
          .then(function (updated) {
            if (updated) appState = normalizeState(updated);
            renderHeaderProfile();
            renderProfile();
            renderProfileSettings();
            liveCall("live_sync_profile").catch(function () {});
          })
          .catch(function (err) {
            setStatus("Could not save your profile: " + err, true);
          })
          .finally(function () {
            finishOnboarding();
          });
      });
    }
    if (onboardingSkipBtn) {
      onboardingSkipBtn.addEventListener("click", finishOnboarding);
    }
  }

  // ---------------------------------------------------------------- init

  function wireStaticControls() {
    if (bigPictureOpenBtn) {
      bigPictureOpenBtn.addEventListener("click", openBigPicture);
    }
    if (bigPictureCloseBtn) {
      bigPictureCloseBtn.addEventListener("click", closeBigPicture);
    }
    if (shelfCreateBtn && shelfNewNameInput) {
      shelfCreateBtn.addEventListener("click", function () {
        var name = shelfNewNameInput.value.trim();
        if (!name) {
          setStatus("A shelf needs a name.", true);
          return;
        }
        if (shelves().length >= 50) {
          setStatus("KOVA keeps at most 50 shelves.", true);
          return;
        }
        var id =
          "shelf-" +
          Date.now().toString(36) +
          "-" +
          Math.floor(Math.random() * 0x10000).toString(16);
        var next = shelves();
        next.push({ id: id, name: name, game_keys: [], builtin: false });
        shelfNewNameInput.value = "";
        saveShelves(next, "Shelf “" + name + "” created.");
      });
      shelfNewNameInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") shelfCreateBtn.click();
      });
    }
    if (diskRefreshBtn) {
      diskRefreshBtn.addEventListener("click", renderDiskUsage);
    }
    if (betaFeedbackSaveBtn && betaFeedbackInput) {
      betaFeedbackSaveBtn.addEventListener("click", function () {
        var text = betaFeedbackInput.value.trim();
        if (!text) {
          setStatus("Write a little feedback first.", true);
          return;
        }
        var notes = readBetaFeedback();
        notes.push({ text: text, at: Date.now() });
        writeBetaFeedback(notes);
        betaFeedbackInput.value = "";
        renderBetaFeedbackList();
        setStatus("Feedback note saved on this machine.", false);
      });
    }
    wireStoreSubmit();
    wireStoreSubmitModal();
    wireStateBackup();
    wireOnboarding();
  }

  window.addEventListener("DOMContentLoaded", function () {
    wireStaticControls();
    renderKidsBanner();
    renderSettingsExtras();
    liveBoot();
    if (invoke) {
      pollSession();
      window.setInterval(pollSession, SESSION_POLL_MS);
    }
  });

  // ================================================= KOVA LIVE ====
  //
  // The classic shell's LIVE UI (contract §8): the Profile join
  // card, the Friends view + conversation panel, the Settings
  // LIVE section, and the header status line + pending badge.
  // All LIVE calls go through window.KovaLive (live-client.js),
  // which routes to Tauri in the app and to the shared demo
  // backend in demo mode / headless tests. Every call fails
  // soft: a backend failure shows the signed-out state (or the
  // cached friends from state.live), never a crash.
  //
  // Copy rule: user-facing copy says "the Avok team", never
  // personal names. Friends are KOVA-native only, by gamertag.

  var LIVE_PRESENCE_POLL_MS = 15000;
  var LIVE_FRIENDS_POLL_MS = 30000;

  var liveStatusCache = null; // last live_get_status, or null
  var liveNotConfigured = false; // backend selected but no URL/key
  var liveFriendsCache = null; // last live_get_friends
  var liveConversationsCache = []; // last live_get_conversations
  var livePresenceCache = null; // last live_get_presence
  var liveOpenConversation = null; // tag, or null
  var liveSearchQuery = "";
  var liveSearchResult = null; // last live_search_tag profile, or null
  var liveSearchState = ""; // "", "found", "not-found"
  var livePresenceTimer = null;
  var liveFriendsTimer = null;
  var liveEventsWired = false;
  var liveGateOpened = false; // demo-only live-with hook, once
  var liveJoinMode = "signup"; // "signup" | "signin"
  var liveJoinComplete = false; // sign-up completion screen
  var liveDeleteArmed = false; // delete-account confirm step
  var liveComposerDrafts = {}; // tag -> unsent composer text (survives re-renders)

  function liveStatus() {
    return liveStatusCache;
  }

  function liveSignedIn() {
    return Boolean(liveStatusCache && liveStatusCache.signed_in);
  }

  // The error prefix before the first ":" (contract §3).
  function liveErrCode(err) {
    var text = err && err.message ? err.message : String(err || "");
    var at = text.indexOf(":");
    return at >= 0 ? text.slice(0, at) : text;
  }

  function liveErrMessage(err) {
    var code = liveErrCode(err);
    var messages = {
      email_invalid: "That does not look like an email address.",
      password_too_short: "Passwords need at least 8 characters.",
      tag_invalid: "That tag does not fit the tag rules (3–32 characters: letters, numbers, spaces, _ and -).",
      tag_taken: "That tag is already claimed.",
      tag_change_too_soon: "Tags can only change once every 30 days.",
      invalid_credentials: "That email and password do not match an account.",
      not_signed_in: "Sign in to KOVA LIVE first.",
      not_configured: "KOVA LIVE is not set up yet.",
      kids_disabled: "KOVA LIVE is off while the Kids shelf is on.",
      cannot_add_self: "You cannot add yourself as a friend.",
      already_friends: "You are already friends.",
      already_pending: "A friend request is already waiting.",
      blocked: "That player is blocked.",
      friend_cap: "The friends list is full (500).",
      not_friends: "You can only message friends.",
      message_too_long: "Messages can be at most 2000 characters.",
      rate_limited: "Slow down — too many messages at once.",
      not_your_message: "You can only delete your own messages.",
      confirm_mismatch: "Type your LIVE tag exactly to confirm.",
    };
    if (messages[code]) return messages[code];
    var text = err && err.message ? err.message : String(err || "");
    var at = text.indexOf(":");
    return at >= 0 ? text.slice(at + 1).trim() : text || "KOVA LIVE could not do that.";
  }

  function liveCall(cmd, args) {
    if (!window.KovaLive) return Promise.reject(new Error("live_unavailable: KOVA LIVE is not loaded"));
    return window.KovaLive.call(cmd, args || {});
  }

  // A friend's avatar: the shell's avatarElement handles data
  // URLs and the built-in mark/orbit/bolt; anything else
  // (including the stub's builtin:1–4) shows the friend's tag
  // initial — never the local player's initial.
  function friendAvatarElement(value, tag, sizeClass) {
    if (value && value.indexOf("data:image/") === 0) {
      return avatarElement(value, sizeClass);
    }
    if (
      value === "builtin:mark" ||
      value === "builtin:orbit" ||
      value === "builtin:bolt"
    ) {
      return avatarElement(value, sizeClass);
    }
    var wrap = el("span", "avatar " + (sizeClass || "avatar-md"));
    var initial = (tag || "?").trim().charAt(0).toUpperCase() || "?";
    wrap.appendChild(el("span", "avatar-initial", initial));
    return wrap;
  }

  function presenceDotClass(presence) {
    if (presence === "online") return "live-dot online";
    if (presence === "in_game") return "live-dot in-game";
    return "live-dot offline";
  }

  // ------------------------------------------------------- status

  // Refreshes the cached status, then the header, the badge, and
  // any LIVE surface on screen. A failed status call means LIVE
  // is unreachable: fail soft to the signed-out state.
  function refreshLiveStatus() {
    if (kidsEnabled()) {
      liveStatusCache = null;
      refreshLiveHeader();
      renderLiveJoin();
      renderLiveSettings();
      if (currentView === "friends") renderFriends();
      return Promise.resolve(null);
    }
    return liveCall("live_get_status")
      .then(function (status) {
        liveNotConfigured = false;
        liveStatusCache = status;
        refreshLiveHeader();
        renderLiveJoin();
        renderLiveSettings();
        if (currentView === "friends") renderFriends();
        // The profile header's LIVE note reads the cache.
        if (currentView === "profile") renderProfile();
        return status;
      })
      .catch(function (err) {
        liveNotConfigured = liveErrCode(err) === "not_configured";
        liveStatusCache = null;
        refreshLiveHeader();
        renderLiveJoin();
        renderLiveSettings();
        if (currentView === "friends") renderFriends();
        return null;
      });
  }

  function refreshLiveHeader() {
    if (friendsBadgeEl) {
      var pending =
        liveStatusCache && liveStatusCache.signed_in
          ? liveStatusCache.pending_requests || 0
          : 0;
      friendsBadgeEl.textContent = String(pending);
      friendsBadgeEl.hidden = pending <= 0;
      friendsBadgeEl.setAttribute("aria-label", pending + " pending friend requests");
    }
    if (headerLiveStatusEl) {
      if (!liveStatusCache || !liveStatusCache.signed_in) {
        headerLiveStatusEl.hidden = true;
        headerLiveStatusEl.textContent = "";
        return;
      }
      var line = liveStatusCache.appear_offline
        ? "LIVE · Appear offline"
        : "LIVE · Online";
      if (!liveStatusCache.email_verified) line = "LIVE · Email not verified";
      var pendingCount = liveStatusCache.pending_requests || 0;
      if (pendingCount > 0) {
        line += " · " + pendingCount + " request" + (pendingCount === 1 ? "" : "s");
      }
      headerLiveStatusEl.textContent = line;
      headerLiveStatusEl.hidden = false;
    }
  }

  // After any mutation (accept, block, sign-out…), refresh the
  // status + friends + conversations and re-render the surfaces.
  function refreshLiveAll() {
    return refreshLiveStatus().then(function () {
      if (!liveSignedIn()) {
        liveFriendsCache = null;
        liveConversationsCache = [];
        return null;
      }
      return refreshLiveFriends();
    });
  }

  function refreshLiveFriends() {
    return liveCall("live_get_friends")
      .then(function (data) {
        liveFriendsCache = data;
        return liveCall("live_get_conversations");
      })
      .then(function (convos) {
        liveConversationsCache = convos || [];
        // Re-render whichever LIVE surface is on screen: the
        // Friends view, or the Settings LIVE section (blocked
        // list) after a block/unblock.
        if (currentView === "friends") renderFriends();
        else if (currentView === "settings") renderLiveSettings();
        return liveFriendsCache;
      })
      .catch(function () {
        // Fail soft: keep the last good cache (or the cached
        // state.live friends) and show the list we have.
        if (!liveFriendsCache && state().live) {
          var cached = state().live;
          liveFriendsCache = {
            friends: cached.friends || [],
            requests_in: cached.requests_in || [],
            requests_out: cached.requests_out || [],
            blocked: cached.blocked || [],
          };
        }
        if (currentView === "friends") renderFriends();
        else if (currentView === "settings") renderLiveSettings();
        return liveFriendsCache;
      });
  }

  function refreshLivePresence() {
    return liveCall("live_get_presence")
      .then(function (presence) {
        livePresenceCache = presence;
        if (currentView === "friends") renderFriendsPresenceLine();
        return presence;
      })
      .catch(function () {
        return null;
      });
  }

  // ------------------------------------------------------ polling

  function startLivePolling() {
    stopLivePolling();
    if (!liveSignedIn()) return;
    livePresenceTimer = window.setInterval(refreshLivePresence, LIVE_PRESENCE_POLL_MS);
    liveFriendsTimer = window.setInterval(refreshLiveFriends, LIVE_FRIENDS_POLL_MS);
  }

  function stopLivePolling() {
    if (livePresenceTimer) {
      window.clearInterval(livePresenceTimer);
      livePresenceTimer = null;
    }
    if (liveFriendsTimer) {
      window.clearInterval(liveFriendsTimer);
      liveFriendsTimer = null;
    }
  }

  function liveOnViewShown(name) {
    if (name === "friends") {
      if (!liveSignedIn()) {
        // Cold cache (fresh load, direct link): the status fetch
        // must chain the friends fetch, or the lists never load
        // until the 30s poll.
        refreshLiveStatus().then(function () {
          if (liveSignedIn()) {
            refreshLiveFriends();
            refreshLivePresence();
          }
        });
      } else {
        refreshLiveFriends();
        refreshLivePresence();
      }
      startLivePolling();
    } else {
      stopLivePolling();
      // The Settings LIVE section reads the friends cache for
      // the blocked list — refresh it on entry so a block from
      // the Friends view shows up (the section is not
      // re-rendered by showView itself).
      if (name === "settings") {
        if (liveSignedIn()) refreshLiveFriends();
        else
          refreshLiveStatus().then(function () {
            if (liveSignedIn()) refreshLiveFriends();
          });
      }
    }
  }

  function liveBoot() {
    refreshLiveStatus();
    if (window.KovaLive && !liveEventsWired) {
      liveEventsWired = true;
      // Under Tauri, presence + message events refresh the lists
      // live; in demo mode these are no-ops (polling covers it).
      window.KovaLive.onEvent("live-presence", function () {
        if (currentView === "friends") refreshLiveFriends();
      });
      window.KovaLive.onEvent("live-message", function (event) {
        var tag =
          event && event.payload && event.payload.from_tag
            ? event.payload.from_tag
            : null;
        if (currentView === "friends") {
          refreshLiveFriends();
          if (tag && liveOpenConversation === tag) renderConversation(tag);
        }
      });
    }
  }

  // ------------------------------------------------- join / sign-in

  // The Profile join card: sign-up + sign-in while signed out
  // (tag claim with availability + suggestions, verification
  // state + resend, privacy toggles on sign-up completion);
  // status + sign-out while signed in. Hidden entirely on the
  // Kids shelf.
  function renderLiveJoin() {
    if (!liveJoinEl) return;
    liveJoinEl.innerHTML = "";
    if (kidsEnabled()) return;

    var card = el("div", "settings-card live-join-card");
    card.appendChild(el("h2", null, "KOVA LIVE"));

    if (liveNotConfigured) {
      card.appendChild(
        el(
          "p",
          "settings-note",
          "KOVA LIVE is not set up yet on this machine — the online service has no address configured. Your local profile works exactly as before."
        )
      );
      liveJoinEl.appendChild(card);
      return;
    }

    // Sign-up completion comes first: after sign-up the user IS
    // signed in, so the signed-in branch below would swallow it.
    if (liveJoinComplete && liveSignedIn()) {
      renderLiveJoinComplete(card);
      liveJoinEl.appendChild(card);
      return;
    }

    if (liveSignedIn()) {
      renderLiveJoinSignedIn(card);
      liveJoinEl.appendChild(card);
      return;
    }

    card.appendChild(
      el(
        "p",
        "settings-note",
        "Friends, presence, and messages — free, and inside KOVA only. " +
          "Your library, playtime, and journal stay on this machine; only your tag, avatar, and bio travel."
      )
    );

    var modeRow = el("div", "settings-row live-mode-row");
    var signupBtn = el("button", "ghost", "Create account");
    signupBtn.type = "button";
    var signinBtn = el("button", "ghost", "Sign in");
    signinBtn.type = "button";
    if (liveJoinMode === "signup") signupBtn.classList.add("live-mode-active");
    else signinBtn.classList.add("live-mode-active");
    signupBtn.addEventListener("click", function () {
      liveJoinMode = "signup";
      liveJoinComplete = false;
      renderLiveJoin();
    });
    signinBtn.addEventListener("click", function () {
      liveJoinMode = "signin";
      liveJoinComplete = false;
      renderLiveJoin();
    });
    modeRow.appendChild(signupBtn);
    modeRow.appendChild(signinBtn);
    card.appendChild(modeRow);

    if (liveJoinComplete) {
      renderLiveJoinComplete(card);
    } else if (liveJoinMode === "signup") {
      renderLiveSignupForm(card);
    } else {
      renderLiveSigninForm(card);
    }
    liveJoinEl.appendChild(card);
  }

  function renderLiveJoinSignedIn(card) {
    var status = liveStatusCache;
    var localTag = (gamerProfile().gamertag || "").trim();
    var line = "Signed in as " + status.live_tag + ".";
    if (localTag && localTag !== status.live_tag) {
      line = "Local tag: " + localTag + " · LIVE tag: " + status.live_tag + ".";
    }
    card.appendChild(el("p", "settings-note", line));
    if (!status.email_verified) {
      var verifyRow = el("div", "live-verify-row");
      verifyRow.appendChild(
        el(
          "p",
          "settings-note",
          "Check your inbox to verify your email — friends and messages wait until then."
        )
      );
      var resendBtn = el("button", "ghost", "Resend verification email");
      resendBtn.type = "button";
      resendBtn.addEventListener("click", function () {
        resendBtn.disabled = true;
        liveCall("live_resend_verification")
          .then(function () {
            setStatus("Verification email sent — check your inbox.", false);
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            resendBtn.disabled = false;
          });
      });
      verifyRow.appendChild(resendBtn);
      card.appendChild(verifyRow);
    }
    renderLiveTagChange(card);
    var row = el("div", "settings-row");
    var friendsBtn = el("button", null, "Open Friends");
    friendsBtn.type = "button";
    friendsBtn.addEventListener("click", function () {
      showView("friends");
    });
    row.appendChild(friendsBtn);
    var signOutBtn = el("button", "ghost", "Sign out of KOVA LIVE");
    signOutBtn.type = "button";
    signOutBtn.addEventListener("click", function () {
      signOutBtn.disabled = true;
      liveCall("live_sign_out")
        .then(function () {
          liveOpenConversation = null;
          liveFriendsCache = null;
          liveConversationsCache = [];
          liveJoinComplete = false;
          setStatus("Signed out of KOVA LIVE. Your local profile is untouched.", false);
          return refreshLiveAll();
        })
        .catch(function (err) {
          setStatus(liveErrMessage(err), true);
          signOutBtn.disabled = false;
        });
    });
    row.appendChild(signOutBtn);
    card.appendChild(row);
  }

  // Tag change (spec §2.2): once every 30 days, through the
  // same availability check as sign-up. The old tag is held
  // 30 days before anyone else can claim it.
  function renderLiveTagChange(card) {
    var status = liveStatusCache;
    var wrap = el("div", "live-tag-change");
    var tagInput = document.createElement("input");
    tagInput.className = "text-input";
    tagInput.type = "text";
    tagInput.value = status.live_tag || "";
    tagInput.maxLength = 32;
    tagInput.setAttribute("aria-label", "New KOVA LIVE tag");
    tagInput.spellcheck = false;
    var note = el(
      "p",
      "profile-note",
      "Tags can change once every 30 days. Your old tag is held for 30 days before anyone else can claim it."
    );
    var field = liveField("Change LIVE tag", tagInput);
    field.appendChild(note);
    var suggestionsRow = el("div", "settings-row live-suggestions");
    field.appendChild(suggestionsRow);
    wrap.appendChild(field);
    var changeBtn = el("button", "ghost", "Change tag");
    changeBtn.type = "button";
    changeBtn.addEventListener("click", function () {
      var value = tagInput.value.trim();
      suggestionsRow.innerHTML = "";
      if (!window.KovaLive) return;
      var checked = window.KovaLive.validateTag(value);
      if (!checked.ok) {
        note.textContent = checked.error;
        return;
      }
      if (checked.tag.toLowerCase() === (status.live_tag || "").toLowerCase()) {
        note.textContent = "That is already your tag.";
        return;
      }
      changeBtn.disabled = true;
      note.textContent = "Checking…";
      liveCall("live_check_tag", { tag: checked.tag })
        .then(function (result) {
          if (!result.available) {
            note.textContent = checked.tag + " is taken — try one of these:";
            (result.suggestions || []).forEach(function (suggestion) {
              var sugBtn = el("button", "ghost live-suggestion", suggestion);
              sugBtn.type = "button";
              sugBtn.addEventListener("click", function () {
                tagInput.value = suggestion;
                suggestionsRow.innerHTML = "";
                note.textContent = "";
              });
              suggestionsRow.appendChild(sugBtn);
            });
            changeBtn.disabled = false;
            return null;
          }
          return liveCall("live_claim_tag", { tag: checked.tag });
        })
        .then(function (claimed) {
          if (!claimed) return;
          setStatus("Your LIVE tag is now " + claimed.live_tag + ".", false);
          return refreshLiveAll().then(function () {
            renderLiveJoin();
          });
        })
        .catch(function (err) {
          note.textContent = liveErrMessage(err);
          changeBtn.disabled = false;
        });
    });
    wrap.appendChild(changeBtn);
    card.appendChild(wrap);
  }

  function liveField(labelText, input, hintText) {
    var field = el("div", "profile-field");
    field.appendChild(el("label", null, labelText));
    field.appendChild(input);
    if (hintText) field.appendChild(el("p", "profile-note", hintText));
    return field;
  }

  function renderLiveSignupForm(card) {
    var localTag = (gamerProfile().gamertag || "").trim();
    var emailInput = document.createElement("input");
    emailInput.className = "text-input";
    emailInput.type = "email";
    emailInput.placeholder = "you@example.com";
    emailInput.setAttribute("aria-label", "Email address");
    emailInput.autocomplete = "email";
    card.appendChild(liveField("Email", emailInput, "Private — never shown to other players."));

    var passwordInput = document.createElement("input");
    passwordInput.className = "text-input";
    passwordInput.type = "password";
    passwordInput.placeholder = "At least 8 characters";
    passwordInput.setAttribute("aria-label", "Password");
    passwordInput.autocomplete = "new-password";
    card.appendChild(liveField("Password", passwordInput));

    var tagInput = document.createElement("input");
    tagInput.className = "text-input";
    tagInput.type = "text";
    tagInput.value = localTag;
    tagInput.placeholder = "Your KOVA LIVE tag";
    tagInput.maxLength = 32;
    tagInput.setAttribute("aria-label", "KOVA LIVE tag");
    tagInput.spellcheck = false;
    var tagNote = el("p", "profile-note", "3–32 characters: letters, numbers, spaces, _ and -. Your local gamertag is pre-filled — claim it if it is free.");
    var tagField = liveField("KOVA LIVE tag", tagInput);
    tagField.appendChild(tagNote);
    var suggestionsRow = el("div", "settings-row live-suggestions");
    tagField.appendChild(suggestionsRow);
    card.appendChild(tagField);

    var checkTimer = null;
    function checkTagAvailability() {
      var value = tagInput.value;
      suggestionsRow.innerHTML = "";
      if (!window.KovaLive) return;
      var checked = window.KovaLive.validateTag(value);
      if (!checked.ok) {
        tagNote.textContent = checked.error;
        return;
      }
      tagNote.textContent = "Checking…";
      liveCall("live_check_tag", { tag: checked.tag })
        .then(function (result) {
          if (tagInput.value.trim() !== checked.tag) return;
          if (result.available) {
            tagNote.textContent = checked.tag + " is available.";
          } else {
            tagNote.textContent = checked.tag + " is taken — try one of these:";
            (result.suggestions || []).forEach(function (suggestion) {
              var sugBtn = el("button", "ghost live-suggestion", suggestion);
              sugBtn.type = "button";
              sugBtn.addEventListener("click", function () {
                tagInput.value = suggestion;
                checkTagAvailability();
              });
              suggestionsRow.appendChild(sugBtn);
            });
          }
        })
        .catch(function () {
          tagNote.textContent = "Could not check that tag right now — try creating the account anyway.";
        });
    }
    tagInput.addEventListener("input", function () {
      if (checkTimer) window.clearTimeout(checkTimer);
      checkTimer = window.setTimeout(checkTagAvailability, 400);
    });
    tagInput.addEventListener("blur", checkTagAvailability);

    var note = el("p", "profile-note live-form-note");
    card.appendChild(note);
    var row = el("div", "settings-row");
    var submitBtn = el("button", null, "Create account");
    submitBtn.type = "button";
    submitBtn.addEventListener("click", function () {
      var email = emailInput.value.trim();
      var password = passwordInput.value;
      var tag = tagInput.value.trim();
      if (!email || !password || !tag) {
        note.textContent = "Fill in the email, password, and tag first.";
        return;
      }
      submitBtn.disabled = true;
      note.textContent = "";
      liveCall("live_sign_up", { email: email, password: password, tag: tag })
        .then(function () {
          liveJoinComplete = true;
          // Push the local avatar/bio to the new server profile
          // (spec §2.3); a failed push never blocks sign-up.
          liveCall("live_sync_profile").catch(function () {});
          return refreshLiveStatus();
        })
        .then(function () {
          renderLiveJoin();
        })
        .catch(function (err) {
          note.textContent = liveErrMessage(err);
          submitBtn.disabled = false;
        });
    });
    row.appendChild(submitBtn);
    card.appendChild(row);
  }

  function renderLiveSigninForm(card) {
    var emailInput = document.createElement("input");
    emailInput.className = "text-input";
    emailInput.type = "email";
    emailInput.placeholder = "you@example.com";
    emailInput.setAttribute("aria-label", "Email address");
    emailInput.autocomplete = "email";
    card.appendChild(liveField("Email", emailInput));

    var passwordInput = document.createElement("input");
    passwordInput.className = "text-input";
    passwordInput.type = "password";
    passwordInput.placeholder = "Your password";
    passwordInput.setAttribute("aria-label", "Password");
    passwordInput.autocomplete = "current-password";
    card.appendChild(liveField("Password", passwordInput));

    var note = el("p", "profile-note live-form-note");
    card.appendChild(note);
    var row = el("div", "settings-row");
    var submitBtn = el("button", null, "Sign in");
    submitBtn.type = "button";
    submitBtn.addEventListener("click", function () {
      var email = emailInput.value.trim();
      var password = passwordInput.value;
      if (!email || !password) {
        note.textContent = "Fill in the email and password first.";
        return;
      }
      submitBtn.disabled = true;
      note.textContent = "";
      liveCall("live_sign_in", { email: email, password: password })
        .then(function () {
          // Retry the profile push on sign-in (spec §2.3).
          liveCall("live_sync_profile").catch(function () {});
          return refreshLiveAll();
        })
        .then(function () {
          setStatus("Signed in to KOVA LIVE.", false);
          renderLiveJoin();
        })
        .catch(function (err) {
          note.textContent = liveErrMessage(err);
          submitBtn.disabled = false;
        });
    });
    row.appendChild(submitBtn);
    card.appendChild(row);
  }

  // Sign-up completion: both privacy toggles, presented not
  // buried (spec §4.3), plus the verification state.
  function renderLiveJoinComplete(card) {
    var status = liveStatusCache || {};
    card.appendChild(
      el(
        "p",
        "settings-note",
        "You are in as " + (status.live_tag || "your tag") + ". Two choices before you start — both off means friends see you online and see what you are playing."
      )
    );
    var toggles = el("div", "live-privacy-toggles");
    toggles.appendChild(
      livePrivacyToggle(
        "Appear offline",
        "Friends see you as offline. You still see everyone else normally.",
        Boolean(status.appear_offline),
        function (next) {
          return liveCall("live_set_privacy", { appear_offline: next });
        }
      )
    );
    toggles.appendChild(
      livePrivacyToggle(
        "Hide what I'm playing",
        "Friends see you as Online even mid-game; the game name is never sent.",
        Boolean(status.hide_playing),
        function (next) {
          return liveCall("live_set_privacy", { hide_playing: next });
        }
      )
    );
    card.appendChild(toggles);
    if (!status.email_verified) {
      card.appendChild(
        el(
          "p",
          "settings-note",
          "Check your inbox to verify your email — friends and messages wait until then."
        )
      );
      var resendBtn = el("button", "ghost", "Resend verification email");
      resendBtn.type = "button";
      resendBtn.addEventListener("click", function () {
        resendBtn.disabled = true;
        liveCall("live_resend_verification")
          .then(function () {
            setStatus("Verification email sent — check your inbox.", false);
            return refreshLiveStatus();
          })
          .then(function () {
            renderLiveJoin();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            resendBtn.disabled = false;
          });
      });
      card.appendChild(resendBtn);
    }
    var row = el("div", "settings-row");
    var doneBtn = el("button", null, "Open Friends");
    doneBtn.type = "button";
    doneBtn.addEventListener("click", function () {
      liveJoinComplete = false;
      showView("friends");
    });
    row.appendChild(doneBtn);
    card.appendChild(row);
  }

  function livePrivacyToggle(title, description, checked, onChange) {
    var wrap = el("div", "live-privacy-row");
    var label = el("label", "toggle-row");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.addEventListener("change", function () {
      box.disabled = true;
      onChange(box.checked)
        .then(function () {
          return refreshLiveStatus();
        })
        .catch(function (err) {
          box.checked = !box.checked;
          setStatus(liveErrMessage(err), true);
        })
        .then(function () {
          box.disabled = false;
        });
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(title));
    wrap.appendChild(label);
    wrap.appendChild(el("p", "profile-note", description));
    return wrap;
  }

  // ------------------------------------------------------ friends view

  function renderFriends() {
    if (!liveFriendsEl) return;
    var hadFocusSearch =
      document.activeElement && document.activeElement.id === "live-search-input";
    liveFriendsEl.innerHTML = "";

    if (kidsEnabled()) {
      var kidsBox = el("div", "settings-card live-kids-note");
      kidsBox.appendChild(el("h2", null, "Friends are off here"));
      kidsBox.appendChild(
        el(
          "p",
          "settings-note",
          "The Kids shelf is on, so KOVA LIVE — friends, presence, and messages — stays off on this shelf. Turn the Kids shelf off in Settings to use it."
        )
      );
      liveFriendsEl.appendChild(kidsBox);
      return;
    }

    if (liveNotConfigured) {
      var ncBox = el("div", "settings-card");
      ncBox.appendChild(el("h2", null, "KOVA LIVE is not set up yet"));
      ncBox.appendChild(
        el(
          "p",
          "settings-note",
          "The online service has no address configured on this machine, so friends and messages are unavailable. Everything local works as before."
        )
      );
      liveFriendsEl.appendChild(ncBox);
      return;
    }

    if (!liveSignedIn()) {
      var signedOut = el("div", "settings-card");
      signedOut.appendChild(el("h2", null, "Sign in to KOVA LIVE to see friends"));
      signedOut.appendChild(
        el(
          "p",
          "settings-note",
          "Friends live inside KOVA LIVE — add people by gamertag, see what they are playing, and message them. It is free, and your library never leaves this machine."
        )
      );
      var joinBtn = el("button", null, "Join KOVA LIVE");
      joinBtn.type = "button";
      joinBtn.addEventListener("click", function () {
        showView("profile");
      });
      signedOut.appendChild(joinBtn);
      liveFriendsEl.appendChild(signedOut);
      return;
    }

    var layout = el("div", "live-friends-layout");
    if (liveOpenConversation) layout.classList.add("has-conversation");

    var listCol = el("div", "live-friends-list");
    renderFriendsPresenceLine(listCol);
    renderFriendsSearch(listCol);
    renderFriendsRequests(listCol);
    renderFriendsConversations(listCol);
    renderFriendsList(listCol);
    layout.appendChild(listCol);

    if (liveOpenConversation) {
      var convoCol = el("div", "live-conversation-col");
      renderConversationInto(convoCol, liveOpenConversation);
      layout.appendChild(convoCol);
    }

    liveFriendsEl.appendChild(layout);

    // Demo-only gate hook: ?demo=1&live-with=<tag> opens that
    // conversation once, so the gate can photograph it.
    if (
      !liveGateOpened &&
      !liveOpenConversation &&
      window.KovaLive &&
      window.KovaLive.isDemo()
    ) {
      try {
        var withTag = new URLSearchParams(window.location.search).get("live-with");
        if (withTag) {
          liveGateOpened = true;
          openConversation(withTag);
        }
      } catch (e) {
        /* no gate hook */
      }
    }

    if (hadFocusSearch) {
      var searchInput = document.getElementById("live-search-input");
      if (searchInput) searchInput.focus();
    }
    if (window.KovaNav) window.KovaNav.refresh();
  }

  // The presence line in the Friends header: what friends see of
  // you, plus the Appear offline toggle (contract §8). With a
  // parent it appends; without one it replaces the line already
  // on screen (the 15s presence poll).
  function renderFriendsPresenceLine(parent) {
    var status = liveStatusCache || {};
    var presence = livePresenceCache;
    var line = el("div", "live-presence-line");
    // Reads as a sentence: "You appear Online", "You appear
    // offline", "You appear Online · Playing Dispatch HQ".
    var stateText = "Online";
    if (status.appear_offline || (presence && presence.state === "appear_offline")) {
      stateText = "offline";
    } else if (presence && presence.state === "in_game") {
      stateText = presence.playing ? "Online · Playing " + presence.playing : "in game";
    }
    line.appendChild(el("span", "live-presence-text", "You appear " + stateText));
    var label = el("label", "toggle-row live-appear-toggle");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = Boolean(status.appear_offline);
    box.setAttribute("aria-label", "Appear offline");
    box.addEventListener("change", function () {
      box.disabled = true;
      liveCall("live_set_privacy", { appear_offline: box.checked })
        .then(function () {
          return refreshLiveStatus();
        })
        .then(function () {
          return refreshLivePresence();
        })
        .catch(function (err) {
          box.checked = !box.checked;
          setStatus(liveErrMessage(err), true);
        })
        .then(function () {
          box.disabled = false;
        });
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode("Appear offline"));
    line.appendChild(label);
    if (parent) {
      parent.appendChild(line);
      return;
    }
    var existing = liveFriendsEl
      ? liveFriendsEl.querySelector(".live-presence-line")
      : null;
    if (existing && existing.parentNode) {
      existing.parentNode.replaceChild(line, existing);
    }
  }

  function renderFriendsSearch(parent) {
    var wrap = el("div", "live-search-wrap");
    wrap.appendChild(el("h2", "live-section-title", "Add a friend"));
    var row = el("div", "settings-row live-search-row");
    var input = document.createElement("input");
    input.id = "live-search-input";
    input.className = "text-input";
    input.type = "search";
    input.placeholder = "Exact gamertag, e.g. Nova";
    input.value = liveSearchQuery;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Search for a player by gamertag");
    input.addEventListener("input", function () {
      liveSearchQuery = input.value;
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") searchBtn.click();
    });
    row.appendChild(input);
    var searchBtn = el("button", null, "Search");
    searchBtn.type = "button";
    searchBtn.addEventListener("click", function () {
      var tag = input.value.trim();
      liveSearchQuery = tag;
      if (!tag) {
        liveSearchState = "";
        liveSearchResult = null;
        renderFriends();
        return;
      }
      searchBtn.disabled = true;
      liveCall("live_search_tag", { tag: tag })
        .then(function (result) {
          liveSearchState = result.found ? "found" : "not-found";
          liveSearchResult = result.found ? result.profile : null;
          renderFriends();
        })
        .catch(function (err) {
          setStatus(liveErrMessage(err), true);
          searchBtn.disabled = false;
        });
    });
    row.appendChild(searchBtn);
    wrap.appendChild(row);
    wrap.appendChild(
      el(
        "p",
        "profile-note",
        "Exact match only — type the full gamertag. Friends are KOVA-native: no one is imported from anywhere else."
      )
    );
    if (liveSearchState === "not-found") {
      wrap.appendChild(
        el("p", "empty-note", "No player has that tag. Check the spelling — tags match exactly.")
      );
    } else if (liveSearchState === "found" && liveSearchResult) {
      wrap.appendChild(renderSearchResult(liveSearchResult));
    }
    parent.appendChild(wrap);
  }

  function renderSearchResult(profile) {
    var card = el("div", "live-search-result");
    card.appendChild(friendAvatarElement(profile.avatar, profile.tag, "avatar-md"));
    var body = el("div", "live-row-body");
    body.appendChild(el("div", "live-row-tag", profile.tag));
    if (profile.bio) {
      var bioEl = el("div", "live-row-sub", profile.bio);
      bioEl.title = profile.bio;
      body.appendChild(bioEl);
    }
    card.appendChild(body);
    var actions = el("div", "live-row-actions");
    var isFriend = liveFriendsCache
      ? liveFriendsCache.friends.some(function (f) {
          return f.tag.toLowerCase() === profile.tag.toLowerCase();
        })
      : false;
    var isPendingOut = liveFriendsCache
      ? liveFriendsCache.requests_out.some(function (r) {
          return r.to_tag.toLowerCase() === profile.tag.toLowerCase();
        })
      : false;
    if (isFriend) {
      var msgBtn = el("button", "ghost", "Message");
      msgBtn.type = "button";
      msgBtn.addEventListener("click", function () {
        openConversation(profile.tag);
      });
      actions.appendChild(msgBtn);
    } else if (isPendingOut) {
      actions.appendChild(el("span", "live-row-sub", "Request sent"));
    } else {
      var addBtn = el("button", null, "Add friend");
      addBtn.type = "button";
      addBtn.addEventListener("click", function () {
        addBtn.disabled = true;
        liveCall("live_send_request", { tag: profile.tag })
          .then(function () {
            setStatus("Friend request sent to " + profile.tag + ".", false);
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            addBtn.disabled = false;
          });
      });
      actions.appendChild(addBtn);
    }
    var blockBtn = el("button", "ghost", "Block");
    blockBtn.type = "button";
    blockBtn.addEventListener("click", function () {
      blockPlayer(profile.tag);
    });
    actions.appendChild(blockBtn);
    card.appendChild(actions);
    return card;
  }

  function renderFriendsRequests(parent) {
    var data = liveFriendsCache;
    if (!data) return;
    var incoming = data.requests_in || [];
    var outgoing = data.requests_out || [];
    if (incoming.length === 0 && outgoing.length === 0) return;
    var wrap = el("div", "live-requests-wrap");
    wrap.appendChild(el("h2", "live-section-title", "Friend requests"));
    incoming.forEach(function (request) {
      var row = el("div", "live-row live-request-row");
      row.appendChild(
        friendAvatarElement(request.from_avatar, request.from_tag, "avatar-md")
      );
      var body = el("div", "live-row-body");
      body.appendChild(el("div", "live-row-tag", request.from_tag));
      body.appendChild(
        el("div", "live-row-sub", request.from_bio || "Wants to be friends.")
      );
      row.appendChild(body);
      var actions = el("div", "live-row-actions");
      var acceptBtn = el("button", null, "Accept");
      acceptBtn.type = "button";
      acceptBtn.addEventListener("click", function () {
        acceptBtn.disabled = true;
        liveCall("live_accept_request", { request_id: request.id })
          .then(function () {
            setStatus(request.from_tag + " is now a friend.", false);
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            acceptBtn.disabled = false;
          });
      });
      actions.appendChild(acceptBtn);
      var declineBtn = el("button", "ghost", "Decline");
      declineBtn.type = "button";
      declineBtn.addEventListener("click", function () {
        declineBtn.disabled = true;
        liveCall("live_decline_request", { request_id: request.id })
          .then(function () {
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            declineBtn.disabled = false;
          });
      });
      actions.appendChild(declineBtn);
      row.appendChild(actions);
      wrap.appendChild(row);
    });
    outgoing.forEach(function (request) {
      var row = el("div", "live-row live-request-row is-outgoing");
      row.appendChild(friendAvatarElement("", request.to_tag, "avatar-md"));
      var body = el("div", "live-row-body");
      body.appendChild(el("div", "live-row-tag", request.to_tag));
      body.appendChild(el("div", "live-row-sub", "Request sent — waiting for an answer."));
      row.appendChild(body);
      wrap.appendChild(row);
    });
    parent.appendChild(wrap);
  }

  function renderFriendsConversations(parent) {
    var convos = liveConversationsCache || [];
    if (convos.length === 0) return;
    var wrap = el("div", "live-messages-wrap");
    wrap.appendChild(el("h2", "live-section-title", "Messages"));
    convos.forEach(function (convo) {
      var row = el("div", "live-row live-convo-row");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", "Open conversation with " + convo.tag);
      var friend = liveFriendsCache
        ? liveFriendsCache.friends.find(function (f) {
            return f.tag.toLowerCase() === convo.tag.toLowerCase();
          })
        : null;
      row.appendChild(
        friendAvatarElement(friend ? friend.avatar : "", convo.tag, "avatar-md")
      );
      var body = el("div", "live-row-body");
      body.appendChild(el("div", "live-row-tag", convo.tag));
      var lastMsgEl = el("div", "live-row-sub live-last-message", convo.last_message || "");
      lastMsgEl.title = convo.last_message || "";
      body.appendChild(lastMsgEl);
      row.appendChild(body);
      if (convo.unread > 0) {
        var badge = el("span", "count-badge", String(convo.unread));
        badge.setAttribute("aria-label", convo.unread + " unread messages");
        row.appendChild(badge);
      }
      var open = function () {
        openConversation(convo.tag);
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
      wrap.appendChild(row);
    });
    parent.appendChild(wrap);
  }

  function renderFriendsList(parent) {
    var wrap = el("div", "live-friends-wrap");
    var data = liveFriendsCache;
    var friends = data ? data.friends || [] : [];
    var sorted = window.KovaLive
      ? window.KovaLive.sortFriends(friends)
      : friends.slice();
    wrap.appendChild(
      el(
        "h2",
        "live-section-title",
        "Friends" + (sorted.length > 0 ? " · " + sorted.length : "")
      )
    );
    if (sorted.length === 0) {
      wrap.appendChild(
        el(
          "p",
          "empty-note",
          // A null cache means the friends fetch is still in
          // flight — say so instead of flashing "no friends".
          data === null
            ? "Loading friends…"
            : "No friends yet — search a gamertag above to add someone."
        )
      );
      parent.appendChild(wrap);
      return;
    }
    sorted.forEach(function (friend) {
      var offline = friend.presence === "offline";
      var row = el("div", "live-row live-friend-row" + (offline ? " is-offline" : ""));
      row.dataset.navKey = "live-friend:" + friend.tag;
      var avatarWrap = el("span", "live-avatar-wrap");
      avatarWrap.appendChild(
        friendAvatarElement(friend.avatar, friend.tag, "avatar-md")
      );
      avatarWrap.appendChild(el("span", presenceDotClass(friend.presence)));
      row.appendChild(avatarWrap);
      var body = el("div", "live-row-body");
      body.appendChild(el("div", "live-row-tag", friend.tag));
      var presenceText = window.KovaLive
        ? window.KovaLive.presenceLabel(friend)
        : friend.presence;
      var presenceEl = el("div", "live-row-sub live-presence", presenceText);
      presenceEl.title = presenceText;
      body.appendChild(presenceEl);
      row.appendChild(body);
      var actions = el("div", "live-row-actions");
      var msgBtn = el("button", null, "Message");
      msgBtn.type = "button";
      msgBtn.addEventListener("click", function () {
        openConversation(friend.tag);
      });
      actions.appendChild(msgBtn);
      var removeBtn = el("button", "ghost", "Remove");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", "Remove " + friend.tag + " from friends");
      removeBtn.addEventListener("click", function () {
        removeBtn.disabled = true;
        liveCall("live_remove_friend", { tag: friend.tag })
          .then(function () {
            if (liveOpenConversation === friend.tag) liveOpenConversation = null;
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            removeBtn.disabled = false;
          });
      });
      actions.appendChild(removeBtn);
      row.appendChild(actions);
      wrap.appendChild(row);
    });
    parent.appendChild(wrap);
  }

  // ------------------------------------------------------ conversation

  function openConversation(tag) {
    liveOpenConversation = tag;
    renderFriends();
    // Loading the messages marks the conversation read, which
    // clears its unread badge on the next refresh.
    liveCall("live_get_messages", { tag: tag })
      .then(function () {
        return liveCall("live_get_conversations");
      })
      .then(function (convos) {
        liveConversationsCache = convos || [];
        if (currentView === "friends" && liveOpenConversation === tag) renderFriends();
      })
      .catch(function () {
        /* the panel shows its own error state */
      });
  }

  function closeConversation() {
    liveOpenConversation = null;
    renderFriends();
  }

  function renderConversationInto(host, tag) {
    host.innerHTML = "";
    var panel = el("div", "live-conversation");
    var friend = liveFriendsCache
      ? liveFriendsCache.friends.find(function (f) {
          return f.tag.toLowerCase() === tag.toLowerCase();
        })
      : null;

    var head = el("div", "live-convo-head");
    head.appendChild(friendAvatarElement(friend ? friend.avatar : "", tag, "avatar-md"));
    var headBody = el("div", "live-row-body");
    headBody.appendChild(el("div", "live-row-tag", tag));
    // No friend record means we do not know their presence — a
    // conversation can outlive the friendship (or predate it).
    // Say nothing rather than a wrong "Offline".
    if (friend && window.KovaLive) {
      headBody.appendChild(
        el("div", "live-row-sub live-presence", window.KovaLive.presenceLabel(friend))
      );
    }
    head.appendChild(headBody);
    var headActions = el("div", "live-row-actions");
    var reportBtn = el("button", "ghost live-small", "Report");
    reportBtn.type = "button";
    reportBtn.setAttribute("aria-label", "Report " + tag);
    reportBtn.addEventListener("click", function () {
      openReportForm(host, "profile", tag, null);
    });
    headActions.appendChild(reportBtn);
    var blockBtn = el("button", "ghost live-small", "Block");
    blockBtn.type = "button";
    blockBtn.setAttribute("aria-label", "Block " + tag);
    blockBtn.addEventListener("click", function () {
      blockPlayer(tag);
    });
    headActions.appendChild(blockBtn);
    var closeBtn = el("button", "ghost live-small", "Close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close conversation");
    closeBtn.addEventListener("click", closeConversation);
    headActions.appendChild(closeBtn);
    head.appendChild(headActions);
    panel.appendChild(head);

    var history = el("div", "live-history");
    history.appendChild(el("p", "empty-note", "Loading messages…"));
    panel.appendChild(history);

    // Sending is friends-only (contract §3): a conversation with
    // someone who is not a friend shows the way back in, not a
    // composer that can only fail.
    if (!friend) {
      var notice = el("div", "live-composer live-not-friend");
      notice.appendChild(
        el("span", "settings-note", tag + " is not a friend yet — add them to send messages.")
      );
      var addBtn = el("button", "primary", "Add friend");
      addBtn.type = "button";
      addBtn.addEventListener("click", function () {
        addBtn.disabled = true;
        liveCall("live_send_request", { tag: tag })
          .then(function () {
            setStatus("Friend request sent to " + tag + ".", false);
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            addBtn.disabled = false;
          });
      });
      notice.appendChild(addBtn);
      panel.appendChild(notice);
      host.appendChild(panel);
    } else {
      var composer = el("div", "live-composer");
      var input = document.createElement("input");
      input.className = "text-input";
      input.type = "text";
      input.placeholder = "Message " + tag;
    input.maxLength = 2000;
    input.value = liveComposerDrafts[tag] || "";
    input.setAttribute("aria-label", "Message " + tag);
    input.addEventListener("input", function () {
      liveComposerDrafts[tag] = input.value;
    });
    var sendBtn = el("button", null, "Send");
    sendBtn.type = "button";
    var send = function () {
      var body = input.value;
      if (!body.trim()) return;
      sendBtn.disabled = true;
      liveCall("live_send_message", { to_tag: tag, body: body })
        .then(function () {
          input.value = "";
          liveComposerDrafts[tag] = "";
          renderConversationInto(host, tag);
          return liveCall("live_get_conversations");
        })
        .then(function (convos) {
          liveConversationsCache = convos || [];
        })
        .catch(function (err) {
          // A failed send keeps the draft in the text box (spec §8).
          setStatus(liveErrMessage(err), true);
        })
        .then(function () {
          sendBtn.disabled = false;
        });
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") send();
    });
    composer.appendChild(input);
    composer.appendChild(sendBtn);
    panel.appendChild(composer);

    host.appendChild(panel);
    }

    liveCall("live_get_messages", { tag: tag })
      .then(function (result) {
        if (liveOpenConversation !== tag) return;
        history.innerHTML = "";
        var messages = result.messages || [];
        if (messages.length === 0) {
          history.appendChild(
            el("p", "empty-note", "No messages yet — say hello.")
          );
          return;
        }
        messages.forEach(function (message) {
          var bubble = el(
            "div",
            "live-message" + (message.mine ? " is-mine" : " is-theirs")
          );
          var bubbleBody = el("div", "live-message-body", message.body);
          bubble.appendChild(bubbleBody);
          var meta = el("div", "live-message-meta");
          meta.appendChild(
            el(
              "span",
              "live-message-time",
              formatDateTime(message.sent_at)
            )
          );
          if (message.mine) {
            var delBtn = el("button", "live-text-btn", "Delete");
            delBtn.type = "button";
            delBtn.setAttribute("aria-label", "Delete this message");
            delBtn.addEventListener("click", function () {
              liveCall("live_delete_message", { message_id: message.id })
                .then(function () {
                  renderConversationInto(host, tag);
                })
                .catch(function (err) {
                  setStatus(liveErrMessage(err), true);
                });
            });
            meta.appendChild(delBtn);
          } else {
            var repBtn = el("button", "live-text-btn", "Report");
            repBtn.type = "button";
            repBtn.setAttribute("aria-label", "Report this message");
            repBtn.addEventListener("click", function () {
              openReportForm(host, "message", message.id, tag);
            });
            meta.appendChild(repBtn);
          }
          bubble.appendChild(meta);
          history.appendChild(bubble);
        });
        history.scrollTop = history.scrollHeight;
      })
      .catch(function (err) {
        if (liveOpenConversation !== tag) return;
        history.innerHTML = "";
        history.appendChild(el("p", "empty-note", liveErrMessage(err)));
      });
  }

  function renderConversation(tag) {
    if (currentView !== "friends") return;
    var host = document.querySelector(".live-conversation-col");
    if (host && liveOpenConversation === tag) renderConversationInto(host, tag);
  }

  // Report form: one tap + an optional short note. Reports go
  // to a review queue read by the Avok team (spec §5.4).
  function openReportForm(host, kind, ref, convoTag) {
    var panel = host.querySelector(".live-conversation");
    if (!panel) return;
    var existing = panel.querySelector(".live-report-form");
    if (existing) existing.remove();
    var form = el("div", "live-report-form");
    form.appendChild(
      el(
        "p",
        "settings-note",
        kind === "message"
          ? "Report this message to the Avok team — a human reads every report."
          : "Report this profile to the Avok team — a human reads every report."
      )
    );
    var noteInput = document.createElement("textarea");
    noteInput.className = "text-input live-report-note";
    noteInput.placeholder = "What happened? (optional)";
    noteInput.maxLength = 500;
    noteInput.setAttribute("aria-label", "Report note");
    form.appendChild(noteInput);
    var row = el("div", "settings-row");
    var submitBtn = el("button", null, "Send report");
    submitBtn.type = "button";
    submitBtn.addEventListener("click", function () {
      submitBtn.disabled = true;
      liveCall("live_report", {
        kind: kind,
        ref_: ref,
        note: noteInput.value.trim(),
      })
        .then(function () {
          setStatus("Report sent — a member of the Avok team will read it.", false);
          if (convoTag) renderConversationInto(host, convoTag);
          else if (liveOpenConversation) renderConversationInto(host, liveOpenConversation);
        })
        .catch(function (err) {
          setStatus(liveErrMessage(err), true);
          submitBtn.disabled = false;
        });
    });
    row.appendChild(submitBtn);
    var cancelBtn = el("button", "ghost", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", function () {
      form.remove();
    });
    row.appendChild(cancelBtn);
    form.appendChild(row);
    panel.appendChild(form);
    noteInput.focus();
  }

  function blockPlayer(tag) {
    liveCall("live_block", { tag: tag })
      .then(function () {
        if (liveOpenConversation === tag) liveOpenConversation = null;
        liveSearchState = "";
        liveSearchResult = null;
        setStatus(tag + " is blocked. They cannot see you or message you.", false);
        return refreshLiveAll();
      })
      .catch(function (err) {
        setStatus(liveErrMessage(err), true);
      });
  }

  // ------------------------------------------------- settings: LIVE

  function renderLiveSettings() {
    if (!liveSettingsEl) return;
    liveSettingsEl.innerHTML = "";

    if (kidsEnabled()) {
      liveSettingsEl.appendChild(
        el(
          "p",
          "settings-note",
          "KOVA LIVE is off while the Kids shelf is on — no sign-in, no friends, no messages on this shelf."
        )
      );
      return;
    }

    if (liveNotConfigured) {
      liveSettingsEl.appendChild(
        el(
          "p",
          "settings-note",
          "KOVA LIVE is not set up yet on this machine — the online service has no address configured."
        )
      );
      return;
    }

    if (!liveSignedIn()) {
      liveSettingsEl.appendChild(
        el(
          "p",
          "settings-note",
          "Sign in to KOVA LIVE from your Profile to manage presence, blocked players, and your account."
        )
      );
      var joinBtn = el("button", "ghost", "Join KOVA LIVE");
      joinBtn.type = "button";
      joinBtn.addEventListener("click", function () {
        showView("profile");
      });
      liveSettingsEl.appendChild(joinBtn);
      return;
    }

    var status = liveStatusCache;
    liveSettingsEl.appendChild(
      el("p", "settings-note", "Signed in as " + status.live_tag + ".")
    );

    var toggles = el("div", "live-privacy-toggles");
    toggles.appendChild(
      livePrivacyToggle(
        "Appear offline",
        "Friends see you as offline. You still see everyone else normally.",
        Boolean(status.appear_offline),
        function (next) {
          return liveCall("live_set_privacy", { appear_offline: next });
        }
      )
    );
    toggles.appendChild(
      livePrivacyToggle(
        "Hide what I'm playing",
        "Friends see you as Online even mid-game; the game name is never sent.",
        Boolean(status.hide_playing),
        function (next) {
          return liveCall("live_set_privacy", { hide_playing: next });
        }
      )
    );
    liveSettingsEl.appendChild(toggles);

    // Blocked list.
    var blocked = (liveFriendsCache && liveFriendsCache.blocked) || [];
    var blockedHead = el("h3", "live-subhead", "Blocked players");
    liveSettingsEl.appendChild(blockedHead);
    if (blocked.length === 0) {
      liveSettingsEl.appendChild(
        el("p", "settings-note", "No blocked players. Blocked players cannot see you, message you, or find you by tag.")
      );
    } else {
      var list = el("div", "folder-list");
      blocked.forEach(function (tag) {
        var row = el("div", "folder-row");
        row.appendChild(el("span", "folder-path", tag));
        var unblockBtn = el("button", "ghost folder-remove", "Unblock");
        unblockBtn.type = "button";
        unblockBtn.addEventListener("click", function () {
          unblockBtn.disabled = true;
          liveCall("live_unblock", { tag: tag })
            .then(function () {
              setStatus(tag + " is unblocked. They can find you by tag again — they are not a friend again.", false);
              return refreshLiveAll();
            })
            .catch(function (err) {
              setStatus(liveErrMessage(err), true);
              unblockBtn.disabled = false;
            });
        });
        row.appendChild(unblockBtn);
        list.appendChild(row);
      });
      liveSettingsEl.appendChild(list);
    }

    // Delete account — last, in a section of its own, with the
    // consequence in words and a confirmation that names the tag.
    var danger = el("div", "live-danger-zone");
    danger.appendChild(el("h3", "live-subhead", "Delete my KOVA LIVE account"));
    danger.appendChild(
      el(
        "p",
        "settings-note",
        "This removes your account, your friends, your requests, your blocks, and every message you sent — for both sides. Your tag is held for 30 days, then freed. Your local profile on this machine is untouched. This cannot be undone."
      )
    );
    if (!liveDeleteArmed) {
      var armBtn = el("button", "ghost live-danger-btn", "Delete my KOVA LIVE account");
      armBtn.type = "button";
      armBtn.addEventListener("click", function () {
        liveDeleteArmed = true;
        renderLiveSettings();
      });
      danger.appendChild(armBtn);
    } else {
      var confirmInput = document.createElement("input");
      confirmInput.className = "text-input";
      confirmInput.type = "text";
      confirmInput.placeholder = "Type " + status.live_tag + " to confirm";
      confirmInput.setAttribute("aria-label", "Type your LIVE tag to confirm deletion");
      confirmInput.spellcheck = false;
      danger.appendChild(confirmInput);
      var confirmRow = el("div", "settings-row live-delete-row");
      var deleteBtn = el("button", "live-danger-btn", "Delete my account");
      deleteBtn.type = "button";
      deleteBtn.disabled = true;
      confirmInput.addEventListener("input", function () {
        deleteBtn.disabled = confirmInput.value.trim() !== status.live_tag;
      });
      deleteBtn.addEventListener("click", function () {
        deleteBtn.disabled = true;
        liveCall("live_delete_account", { confirm_tag: status.live_tag })
          .then(function () {
            liveDeleteArmed = false;
            liveOpenConversation = null;
            liveFriendsCache = null;
            liveConversationsCache = [];
            liveJoinComplete = false;
            setStatus("Your KOVA LIVE account is deleted. Your local profile is untouched.", false);
            return refreshLiveAll();
          })
          .catch(function (err) {
            setStatus(liveErrMessage(err), true);
            deleteBtn.disabled = false;
          });
      });
      confirmRow.appendChild(deleteBtn);
      var cancelBtn = el("button", "ghost", "Keep my account");
      cancelBtn.type = "button";
      cancelBtn.addEventListener("click", function () {
        liveDeleteArmed = false;
        renderLiveSettings();
      });
      confirmRow.appendChild(cancelBtn);
      danger.appendChild(confirmRow);
    }
    liveSettingsEl.appendChild(danger);
  }

  // ------------------------------------------------------------ exports

  window.KovaV12 = {
    renderHomeShelfRows: renderHomeShelfRows,
    renderDetailExtras: renderDetailExtras,
    renderProfileExtras: renderProfileExtras,
    renderKidsBanner: renderKidsBanner,
    renderStore: renderStore,
    renderBigPictureGrid: renderBigPictureGrid,
    renderSettingsExtras: renderSettingsExtras,
    notifyUpdateOnce: notifyUpdateOnce,
    onLaunched: onLaunched,
    maybeResetKidsDay: maybeResetKidsDay,
    maybeShowOnboarding: maybeShowOnboarding,
    isBigPictureOpen: isBigPictureOpen,
    openBigPicture: openBigPicture,
    closeBigPicture: closeBigPicture,
    toggleBigPicture: toggleBigPicture,
    onViewShown: liveOnViewShown,
    liveStatus: liveStatus,
    refreshLiveHeader: refreshLiveHeader,
    renderFriends: renderFriends,
    renderLiveJoin: renderLiveJoin,
    renderLiveSettings: renderLiveSettings,
    refreshMilestones: function () {
      renderMilestones(true);
    },
  };
})();
