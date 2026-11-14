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
    return state().sync || { enabled: false, folder: null, last_push_at: null, last_pull_at: null };
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

  // v1.3.0: Dre names the store review address in a follow-up; until then the email action opens with no recipient. Do not invent an address.
  var STORE_REVIEW_ADDRESS = "REVIEW_ADDRESS_NOT_SET";

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
        "The store review address isn't set yet — download your application below and send it once the address is published. Listings are approved by both Melo and Dre, and nothing appears in the store until both say yes.";
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
          "-application.json. Send it to Avok for review — listings are approved by both Melo and Dre, and nothing appears in the store until both say yes. There is no automatic submission." +
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
              : " Send it to Avok for review — listings are approved by both Melo and Dre.");
        }
        setStatus("Application opened in your mail client.", false);
      });
    }
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
    var folderInput = document.createElement("input");
    folderInput.className = "text-input";
    folderInput.type = "text";
    folderInput.value = sync.folder || "";
    folderInput.placeholder = "Sync folder, e.g. /Users/you/Library/Mobile Documents/com~apple~CloudDocs/KOVA";
    folderInput.spellcheck = false;
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
    pushBtn.disabled = !sync.folder;
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
    pullBtn.disabled = !sync.folder;
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
      var next = {
        opted_in: toggle.checked,
        // Leaving the beta always lands back on Classic.
        ui: toggle.checked ? beta.ui : "classic",
        accent: beta.accent,
        density: beta.density,
        shelf_order: beta.shelf_order,
      };
      invoke("set_beta", { beta: next })
        .then(function (updated) {
          applyState(updated);
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

    // The UI selector appears ONLY when opted in.
    if (beta.opted_in) {
      var selector = el("div", "beta-ui-selector");
      selector.appendChild(el("span", "field-label", "Interface"));
      [
        ["classic", "Classic", "The current KOVA UI."],
        ["beta", "Beta", "The brand-new light UI. Switching reloads the app into the beta shell."],
      ].forEach(function (entry) {
        var label = el("label", "launch-mode-option");
        var radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "beta-ui";
        radio.value = entry[0];
        radio.checked = beta.ui === entry[0];
        radio.addEventListener("change", function () {
          if (!invoke || !radio.checked) return;
          invoke("set_beta", {
            beta: {
              opted_in: beta.opted_in,
              ui: entry[0],
              accent: beta.accent,
              density: beta.density,
              shelf_order: beta.shelf_order,
            },
          })
            .then(function (updated) {
              if (updated) appState = normalizeState(updated);
              if (entry[0] === "beta") {
                window.location.href = "beta/index.html";
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
    renderBetaSettings();
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
    wireStateBackup();
    wireOnboarding();
  }

  window.addEventListener("DOMContentLoaded", function () {
    wireStaticControls();
    renderKidsBanner();
    renderSettingsExtras();
    if (invoke) {
      pollSession();
      window.setInterval(pollSession, SESSION_POLL_MS);
    }
  });

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
    refreshMilestones: function () {
      renderMilestones(true);
    },
  };
})();
