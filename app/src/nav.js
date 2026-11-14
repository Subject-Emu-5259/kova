// KOVA slice 6 — shared gamepad/keyboard navigation (plain JS).
// Loaded by BOTH windows (main + Quick Panel) before their own
// script. One focus system, two input paths that never diverge:
//   - gamepad via navigator.getGamepads() polling (standard mapping)
//   - keyboard arrows + Enter/Space + Escape through the SAME
//     move/activate/back functions
// The focus order is computed live from the DOM on every move,
// so re-renders (search, rescan, launch, profile edits) never
// leave focus pointing at a dead element: after any DOM change
// the system re-anchors to the nearest focusable element.
//
// What is focusable: native controls (buttons, inputs, selects,
// checkboxes) plus anything with tabindex="0" — game tiles in the
// main window, game rows and Quick Resume cards in the panel.
// Hidden games never appear (they are not rendered, or their
// section is [hidden]), and the visibility walk below also
// excludes anything inside a hidden section, so focus can never
// land on a hidden game or a hidden control.
//
// The ring is a class, not :focus-visible: programmatic focus
// (gamepad moves) does not reliably match :focus-visible, and a
// console UI must show focus at TV distance. The ring appears
// only while navigating (gamepad or nav keys); any pointer use
// clears it, so mouse users never see it.
//
// Each window wires its own back/home meanings through init():
//   main:    back = detail -> Library, Library/Settings -> Home;
//            Start/Guide -> Home
//   panel:   back = hide the panel; Start/Guide -> back to KOVA
// No backend commands are needed: the panel callbacks reuse the
// existing hide_overlay / back_to_main invokes from overlay.js.

window.KovaNav = (function () {
  "use strict";

  var FOCUS_SELECTOR =
    "button:not(:disabled), input:not(:disabled), " +
    "select:not(:disabled), textarea:not(:disabled), " +
    "[tabindex]:not([tabindex='-1'])";

  var ACCENT = "#00D8F0";

  var onBack = null;
  var onHome = null;
  var onBigPicture = null;
  var started = false;

  // Anchor for re-anchoring after re-renders: the stable key of
  // the last focused element plus its index as a fallback.
  var lastKey = null;
  var lastIndex = 0;
  var navMode = false;
  var ringed = null;

  // Gamepad held-direction repeat state (console feel: an
  // initial pause, then accelerating repeats while held).
  var heldDir = null;
  var heldSince = 0;
  var nextRepeat = 0;
  var prevButtons = [];

  function isVisible(el) {
    var node = el;
    while (node && node !== document) {
      if (node.hidden) return false;
      if (node.nodeType === 1) {
        var style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
      }
      node = node.parentNode;
    }
    return true;
  }

  function collect() {
    var all = Array.prototype.slice.call(
      document.querySelectorAll(FOCUS_SELECTOR)
    );
    return all.filter(isVisible);
  }

  // Stable-ish identity for re-anchoring: tiles, rows, and cards
  // carry their game key in data-nav-key; a control inside one
  // (e.g. a tile's Play button) anchors to that key plus its own
  // label, so a re-render lands back on the same game's control
  // instead of another game's identically labeled button.
  function keyOf(el) {
    if (!el) return null;
    var host = el.closest ? el.closest("[data-nav-key]") : null;
    var base = host ? host.getAttribute("data-nav-key") : null;
    if (base && host !== el) {
      var label = (el.textContent || "").trim().slice(0, 40);
      return base + "|" + el.tagName + ":" + label;
    }
    if (base) return base;
    if (el.id) return "id:" + el.id;
    return "text:" + (el.textContent || "").trim().slice(0, 40);
  }

  function setRing(el) {
    if (ringed && ringed !== el) ringed.classList.remove("kova-nav-focus");
    ringed = el;
    if (el) el.classList.add("kova-nav-focus");
  }

  function clearRing() {
    if (ringed) ringed.classList.remove("kova-nav-focus");
    ringed = null;
  }

  function applyFocus(el) {
    if (!el) return;
    el.focus({ preventScroll: false });
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch (err) {
        /* older webviews ignore the options object */
      }
    }
    setRing(el);
    lastKey = keyOf(el);
    var list = collect();
    var index = list.indexOf(el);
    if (index >= 0) lastIndex = index;
  }

  // Re-anchor after a re-render. If the focused element survived,
  // keep it (this is the common path: typing in the search field
  // re-renders the grid around the still-focused input). If focus
  // was lost and we are navigating, restore the anchored element
  // by key, else by clamped index, else the first element. When
  // not navigating, never steal focus from the mouse user.
  function refresh() {
    var list = collect();
    if (list.length === 0) return;
    var active = document.activeElement;
    if (active && list.indexOf(active) >= 0) {
      lastKey = keyOf(active);
      lastIndex = list.indexOf(active);
      if (navMode) setRing(active);
      return;
    }
    if (!navMode) return;
    if (lastKey) {
      for (var i = 0; i < list.length; i++) {
        if (keyOf(list[i]) === lastKey) {
          applyFocus(list[i]);
          return;
        }
      }
    }
    applyFocus(list[Math.min(lastIndex, list.length - 1)]);
  }

  function focusFirst() {
    var list = collect();
    if (list.length === 0) return;
    navMode = true;
    applyFocus(list[0]);
  }

  function rectCenter(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function centerInside(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // Move focus one step in a direction. Spatial first: among
  // elements lying in that direction, the closest wins (primary
  // distance weighted over lateral drift, so grid rows and
  // strips feel like a console). Elements nested inside the
  // current element (a tile's own Play button) or containing it
  // are skipped — otherwise focus ping-pongs inside one tile.
  // If nothing lies in that direction, fall back to DOM order so
  // navigation never dead-ends at a row's edge.
  function moveFrom(el, dir) {
    var list = collect();
    if (list.length === 0) return;
    if (!el || list.indexOf(el) < 0) {
      applyFocus(list[0]);
      return;
    }
    var rect = el.getBoundingClientRect();
    var center = rectCenter(rect);
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var cand = list[i];
      if (cand === el) continue;
      var cRect = cand.getBoundingClientRect();
      var cCenter = rectCenter(cRect);
      // Skip nesting either way: the focused element's own
      // children, and ancestors that contain it.
      if (
        centerInside(rect, cCenter.x, cCenter.y) ||
        centerInside(cRect, center.x, center.y)
      ) {
        continue;
      }
      var dx = cCenter.x - center.x;
      var dy = cCenter.y - center.y;
      var primary;
      var lateral;
      if (dir === "left") {
        if (dx >= -4) continue;
        primary = -dx;
        lateral = Math.abs(dy);
      } else if (dir === "right") {
        if (dx <= 4) continue;
        primary = dx;
        lateral = Math.abs(dy);
      } else if (dir === "up") {
        if (dy >= -4) continue;
        primary = -dy;
        lateral = Math.abs(dx);
      } else {
        if (dy <= 4) continue;
        primary = dy;
        lateral = Math.abs(dx);
      }
      var score = primary + lateral * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) {
      applyFocus(best);
      return;
    }
    var index = list.indexOf(el);
    var next =
      dir === "right" || dir === "down"
        ? Math.min(index + 1, list.length - 1)
        : Math.max(index - 1, 0);
    applyFocus(list[next]);
  }

  function move(dir) {
    var list = collect();
    if (list.length === 0) return;
    var active = document.activeElement;
    if (!active || list.indexOf(active) < 0) {
      // First nav press: land on the anchor (or the first stop).
      navMode = true;
      if (lastKey) {
        for (var i = 0; i < list.length; i++) {
          if (keyOf(list[i]) === lastKey) {
            applyFocus(list[i]);
            return;
          }
        }
      }
      applyFocus(list[Math.min(lastIndex, list.length - 1)]);
      return;
    }
    navMode = true;
    moveFrom(active, dir);
  }

  // Activate the focused stop. Rows and Quick Resume cards have
  // no click of their own — their Play button is the action — so
  // activation presses it. Tiles open their detail page on click
  // (unchanged behavior). Form controls are left to the browser:
  // Enter/Space on an input, select, or checkbox already does the
  // native thing, and nav never intercepts those keys there.
  function activate() {
    var active = document.activeElement;
    if (!active) return;
    if (active.matches("input, textarea, select")) return;
    var rowPlay = null;
    if (active.matches(".game-row, .recent-card")) {
      rowPlay = active.querySelector(".play");
    }
    if (rowPlay && !rowPlay.disabled) {
      rowPlay.click();
      return;
    }
    active.click();
  }

  function goBack() {
    if (typeof onBack === "function") onBack();
  }

  function goHome() {
    if (typeof onHome === "function") onHome();
  }

  // v1.2.0 §10: Y toggles Big Picture (main window only — the
  // panel never wires this callback).
  function goBigPicture() {
    if (typeof onBigPicture === "function") onBigPicture();
  }

  function isField(el) {
    return !!el && el.matches("input, textarea, select");
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var active = document.activeElement;
    var key = event.key;
    if (key === "Escape") {
      if (isField(active)) {
        // Typing in a field: Escape leaves the field and drops
        // focus to the nearest stop below it (from the search
        // field, that is the first grid tile) instead of
        // trapping focus on the field itself.
        event.preventDefault();
        navMode = true;
        var field = active;
        field.blur();
        moveFrom(field, "down");
      } else {
        event.preventDefault();
        goBack();
      }
      return;
    }
    // Inside a field, arrows/Enter/Space belong to the field.
    if (isField(active)) return;
    var dir = null;
    if (key === "ArrowLeft") dir = "left";
    else if (key === "ArrowRight") dir = "right";
    else if (key === "ArrowUp") dir = "up";
    else if (key === "ArrowDown") dir = "down";
    if (dir) {
      event.preventDefault();
      move(dir);
      return;
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
      event.preventDefault();
      navMode = true;
      // No stop focused yet (fresh window): land on the anchor
      // instead of activating whatever the browser focused.
      var list = collect();
      if (!active || list.indexOf(active) < 0) {
        move(dir);
        return;
      }
      activate();
    }
  }

  function onPointerDown() {
    // Mouse/touch use: the ring belongs to navigation only.
    navMode = false;
    clearRing();
  }

  function onFocusIn() {
    // Tab moves focus natively; if we are navigating, the ring
    // follows it so keyboard and gamepad focus always agree.
    if (!navMode) return;
    var active = document.activeElement;
    if (active && collect().indexOf(active) >= 0) setRing(active);
  }

  function onWindowFocus() {
    // Returning to this window (e.g. back from the Quick Panel):
    // re-anchor the navigator's last stop instead of leaving
    // focus nowhere.
    if (navMode) refresh();
  }

  // ---------------------------------------------------------- gamepad

  function readDirection(gp) {
    var buttons = gp.buttons || [];
    var axes = gp.axes || [];
    if (buttons[12] && buttons[12].pressed) return "up";
    if (buttons[13] && buttons[13].pressed) return "down";
    if (buttons[14] && buttons[14].pressed) return "left";
    if (buttons[15] && buttons[15].pressed) return "right";
    var x = axes[0] || 0;
    var y = axes[1] || 0;
    var deadzone = 0.35;
    if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) return null;
    if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
    return y < 0 ? "up" : "down";
  }

  function buttonPressed(gp, index) {
    var button = (gp.buttons || [])[index];
    return !!button && (button.pressed || button.value > 0.5);
  }

  function pollGamepad() {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;
    var pads = navigator.getGamepads();
    var gp = null;
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected !== false) {
        gp = pads[i];
        break;
      }
    }
    if (!gp) {
      heldDir = null;
      prevButtons = [];
      return;
    }
    var now = performance.now();
    var dir = readDirection(gp);
    if (dir) {
      navMode = true;
      if (dir !== heldDir) {
        move(dir);
        heldDir = dir;
        heldSince = now;
        nextRepeat = now + 380;
      } else if (now >= nextRepeat) {
        move(dir);
        // Accelerate: ~120ms steps easing to ~55ms while held.
        var interval = Math.max(55, 120 - (now - heldSince) / 30);
        nextRepeat = now + interval;
      }
    } else {
      heldDir = null;
    }
    // Face buttons are edge-triggered: holding A must not
    // re-activate the focused stop every frame.
    var pressedNow = [
      buttonPressed(gp, 0),
      buttonPressed(gp, 1),
      buttonPressed(gp, 9),
      buttonPressed(gp, 16),
      buttonPressed(gp, 3),
    ];
    var was = prevButtons;
    if (pressedNow[0] && !was[0]) {
      navMode = true;
      var list = collect();
      var active = document.activeElement;
      if (!active || list.indexOf(active) < 0) {
        move(null);
      } else {
        activate();
      }
    }
    if (pressedNow[1] && !was[1]) goBack();
    if ((pressedNow[2] && !was[2]) || (pressedNow[3] && !was[3])) goHome();
    // v1.2.0 §10: Y toggles Big Picture (no-op where unwired).
    if (pressedNow[4] && !was[4]) goBigPicture();
    prevButtons = pressedNow;
  }

  function gamepadLoop() {
    try {
      pollGamepad();
    } catch (err) {
      /* a gamepad API hiccup must never break the window */
    }
    window.requestAnimationFrame(gamepadLoop);
  }

  // ------------------------------------------------------------- init

  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      refresh();
    }, 60);
  }

  function init(options) {
    if (started) return;
    started = true;
    options = options || {};
    onBack = options.onBack || null;
    onHome = options.onHome || null;
    onBigPicture = options.onBigPicture || null;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focus", onWindowFocus);
    // Re-anchor after any re-render, without touching call sites:
    // renders replace DOM nodes (childList), while the focus ring
    // itself only toggles a class (attributes are not observed,
    // so focusing cannot re-trigger this).
    if (typeof MutationObserver !== "undefined") {
      var observer = new MutationObserver(scheduleRefresh);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    if (
      typeof window.requestAnimationFrame === "function" &&
      typeof navigator !== "undefined" &&
      navigator.getGamepads
    ) {
      window.requestAnimationFrame(gamepadLoop);
    }
  }

  return {
    init: init,
    refresh: refresh,
    focusFirst: focusFirst,
    move: move,
    activate: activate,
    goBack: goBack,
    goHome: goHome,
    goBigPicture: goBigPicture,
    // Exposed for the parent's accent check: the ring color.
    accent: ACCENT,
  };
})();
