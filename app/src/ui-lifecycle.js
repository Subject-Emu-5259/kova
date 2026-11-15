// KOVA UI lifecycle — shared by the Classic, Beta and Third shells.
//
// Standing rule (Dre, 2026-11-14): beta is a closed program for
// beta testers — a feature Dre picks for beta lives behind the beta
// door, testers try it and we fix what they report, and after its
// 30-day beta window it is promoted to everyone. Dre decides per
// feature whether it starts in beta — NOT every feature goes through
// beta. Stage ("third") IS a beta feature: beta-gated at launch,
// then it graduates to the main Settings selector when its 30-day
// window expires. Per-UI beta start dates live in
// state.beta.ui_beta_start, an object mapping a UI id to unix
// seconds, e.g. {"third": 1794690000}. The start is stamped the
// first time the player selects that UI.
// Beta run: 30 days (Dre-confirmed, 2026-11-14).
(function () {
  "use strict";
  var BETA_RUN_DAYS = 30;
  var BETA_RUN_SECS = BETA_RUN_DAYS * 24 * 60 * 60;

  function startOf(beta, ui) {
    var m = (beta && beta.ui_beta_start) || {};
    var v = m[ui];
    return typeof v === "number" && isFinite(v) && v > 0 ? v : null;
  }

  // True once this UI's beta run has expired.
  function graduated(beta, ui, nowSec) {
    var s = startOf(beta, ui);
    if (s === null) return false;
    return (nowSec || Math.floor(Date.now() / 1000)) >= s + BETA_RUN_SECS;
  }

  // UIs the player may select right now: Classic always; Beta while
  // opted in; a newer UI while opted in OR once its beta has expired.
  function availableUis(beta, nowSec) {
    var list = ["classic"];
    if (beta && beta.opted_in) list.push("beta");
    if ((beta && beta.opted_in) || graduated(beta, "third", nowSec)) {
      list.push("third");
    }
    return list;
  }

  // Whether the player may currently run this UI (shell-guard check).
  function mayRun(beta, ui, nowSec) {
    if (ui === "classic") return true;
    if (ui === "beta") return !!(beta && beta.opted_in);
    if (ui === "third") {
      return !!((beta && beta.opted_in) || graduated(beta, "third", nowSec));
    }
    return false;
  }

  // Stamp the beta start for a UI the first time it is selected.
  // Returns a new beta object; does not mutate the input.
  function withStartStamp(beta, ui, nowSec) {
    var next = Object.assign({}, beta || {});
    var map = Object.assign({}, (beta && beta.ui_beta_start) || {});
    if (startOf(beta, ui) === null) {
      map[ui] = nowSec || Math.floor(Date.now() / 1000);
    }
    next.ui_beta_start = map;
    return next;
  }

  window.KovaUi = {
    BETA_RUN_DAYS: BETA_RUN_DAYS,
    BETA_RUN_SECS: BETA_RUN_SECS,
    graduated: graduated,
    availableUis: availableUis,
    mayRun: mayRun,
    withStartStamp: withStartStamp,
  };
})();
