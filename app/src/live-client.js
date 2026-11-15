// KOVA LIVE — shared client (all three shells).
// Loaded with defer AFTER nav.js, BEFORE each shell's main script.
// Exposes window.KovaLive: call(), isDemo(), validateTag(),
// suggestTags(), presenceLabel(), sortFriends(), onEvent(), and
// demoBackend.
//
// Contract: LIVE_API_CONTRACT.md §7. The demo backend implements
// every §3 command with the §6 seeded data, and mirrors its state
// into sessionStorage under key "kova-live-demo" so it persists
// across shell switches within one browser session (shell switches
// are full page loads).
//
// DEMO GATE HOOK (design gate + headless tests only): with
// ?demo=1&live=authed and no persisted demo state, the demo
// backend auto-signs-in a demo account (tag "Dre", verified) so
// the gate can photograph the signed-in views. It can never
// trigger inside the app — invoke always exists there, and
// isDemo() is false.

(function () {
  "use strict";

  var STORAGE_KEY = "kova-live-demo";
  var TAG_MIN = 3;
  var TAG_MAX = 32;
  var TAG_RE = /^[A-Za-z0-9 _-]+$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PASSWORD_MIN = 8;
  var MESSAGE_MAX = 2000;
  var MESSAGE_CAP = 500;
  var FRIEND_CAP = 500;
  var RATE_LIMIT_PER_MIN = 30;
  var TAG_CHANGE_DAYS = 30;
  var DAY_SECONDS = 86400;

  // ------------------------------------------------------------ tags

  // Contract §5, identical in Rust + JS. Returns
  // { ok, tag, error } — tag is the trimmed form.
  function validateTag(raw) {
    var tag = (raw || "").trim();
    if (tag.length < TAG_MIN) {
      return { ok: false, tag: tag, error: "Tags need at least 3 characters." };
    }
    if (tag.length > TAG_MAX) {
      return { ok: false, tag: tag, error: "Tags can be at most 32 characters." };
    }
    if (!TAG_RE.test(tag)) {
      return {
        ok: false,
        tag: tag,
        error: "Tags can only use letters, numbers, spaces, _ and -.",
      };
    }
    return { ok: true, tag: tag, error: null };
  }

  // Contract §5: the suggestion candidates for a taken tag, in
  // order. The caller keeps the first free ones (max 3).
  function suggestTags(tag) {
    var base = (tag || "").trim();
    var out = [];
    [base + "_", base + "-1", base + "-2", base + "_1"].forEach(function (c) {
      if (c.length <= TAG_MAX) out.push(c);
    });
    return out;
  }

  function tagKey(tag) {
    return (tag || "").trim().toLowerCase();
  }

  // -------------------------------------------------------- presence

  function presenceLabel(friend) {
    if (!friend) return "Offline";
    if (friend.presence === "in_game") {
      return friend.playing ? "Playing " + friend.playing : "In game";
    }
    if (friend.presence === "online") return "Online";
    return "Offline";
  }

  // Online-first (in-game counts as online), then alphabetical
  // (case-insensitive). Returns a new array; the input is untouched.
  function sortFriends(friends) {
    return (friends || []).slice().sort(function (a, b) {
      var aOn = a.presence === "online" || a.presence === "in_game" ? 0 : 1;
      var bOn = b.presence === "online" || b.presence === "in_game" ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      var aTag = (a.tag || "").toLowerCase();
      var bTag = (b.tag || "").toLowerCase();
      if (aTag < bTag) return -1;
      if (aTag > bTag) return 1;
      return 0;
    });
  }

  // ------------------------------------------------------ demo backend
  //
  // The stub is the server (contract §6). One demo account at a
  // time; the account's friends, requests, and conversations are
  // the server-side data and survive sign-out (the server copy
  // remains until the account is deleted — spec §5.2). Sign-out
  // only drops the session.

  // Fake players — searchable, addable (contract §6, identical in
  // the Rust stub). Their presence is fixed in the stub.
  var FAKE_PLAYERS = {
    nova: {
      tag: "Nova",
      avatar: "builtin:1",
      bio: "Speedrunner, Hades II enjoyer.",
      presence: "online",
      playing: null,
    },
    rook: {
      tag: "Rook",
      avatar: "builtin:2",
      bio: "On dispatch. Every call is a decision.",
      presence: "in_game",
      playing: "Dispatch HQ",
    },
    ash: {
      tag: "Ash",
      avatar: "builtin:3",
      bio: "Quiet hours.",
      presence: "offline",
      playing: null,
    },
    sol: {
      tag: "Sol",
      avatar: "builtin:4",
      bio: "Building worlds.",
      presence: "offline",
      playing: null,
    },
  };

  function fakePlayer(tag) {
    return FAKE_PLAYERS[tagKey(tag)] || null;
  }

  function friendFromPlayer(player) {
    return {
      tag: player.tag,
      avatar: player.avatar,
      bio: player.bio,
      presence: player.presence,
      playing: player.playing,
    };
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function err(code, message) {
    return new Error(code + ": " + message);
  }

  function freshDemoState() {
    return {
      // The one demo account (null until the first sign-up).
      account: null,
      signedIn: false,
      // Server-side data for the account.
      friends: [],
      requestsIn: [],
      requestsOut: [],
      blocked: [],
      conversations: {},
      // tagKey -> unix seconds until which the tag is held after
      // a change or a deletion (30 days).
      heldTags: {},
      msgSeq: 0,
      sentAt: [],
    };
  }

  var demoState = freshDemoState();

  function saveDemoState() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(demoState));
    } catch (e) {
      /* sessionStorage unavailable — the demo still works in memory */
    }
  }

  function loadDemoState() {
    try {
      var raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return false;
      demoState = Object.assign(freshDemoState(), parsed);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Seed a fresh account (contract §6): one incoming request from
  // Nova, one DM conversation with Rook (3 messages).
  function seedAccount(state) {
    var now = nowSeconds();
    state.friends = [];
    state.requestsIn = [
      {
        id: "req_nova_1",
        from_tag: "Nova",
        from_avatar: "builtin:1",
        from_bio: "Speedrunner, Hades II enjoyer.",
        created_at: now - 3600,
      },
    ];
    state.requestsOut = [];
    state.blocked = [];
    state.conversations = {
      Rook: {
        messages: [
          {
            id: "m1",
            conversation_tag: "Rook",
            from_tag: "Rook",
            body: "you on tonight?",
            sent_at: now - 3600,
            mine: false,
          },
          {
            id: "m2",
            conversation_tag: "Rook",
            from_tag: state.account ? state.account.live_tag : "me",
            body: "yeah after dinner",
            sent_at: now - 3500,
            mine: true,
          },
          {
            id: "m3",
            conversation_tag: "Rook",
            from_tag: "Rook",
            body: "good, bringing the ladder crew",
            sent_at: now - 3400,
            mine: false,
          },
        ],
        last_read: now - 3500, // read through your own reply; Rook's last message is unread
      },
    };
    state.msgSeq = 3;
    state.sentAt = [];
  }

  function demoStatus() {
    var account = demoState.account;
    var signedIn = Boolean(demoState.signedIn && account);
    return {
      signed_in: signedIn,
      live_tag: signedIn ? account.live_tag : null,
      email_verified: signedIn ? Boolean(account.email_verified) : false,
      appear_offline: signedIn ? Boolean(account.appear_offline) : false,
      hide_playing: signedIn ? Boolean(account.hide_playing) : false,
      pending_requests: signedIn ? demoState.requestsIn.length : 0,
      backend: "stub",
      configured: true,
    };
  }

  // The contract §1 live section, as live_set_privacy returns it.
  function demoLiveSection() {
    var account = demoState.account;
    var signedIn = Boolean(demoState.signedIn && account);
    return {
      signed_in_tag: signedIn ? account.live_tag : null,
      live_tag: signedIn ? account.live_tag : null,
      email_verified: signedIn ? Boolean(account.email_verified) : false,
      appear_offline: signedIn ? Boolean(account.appear_offline) : false,
      hide_playing: signedIn ? Boolean(account.hide_playing) : false,
      tag_changed_at: signedIn ? account.tag_changed_at : null,
      friends: signedIn ? JSON.parse(JSON.stringify(demoState.friends)) : [],
      requests_in: signedIn ? JSON.parse(JSON.stringify(demoState.requestsIn)) : [],
      requests_out: signedIn ? JSON.parse(JSON.stringify(demoState.requestsOut)) : [],
      blocked: signedIn ? demoState.blocked.slice() : [],
    };
  }

  function requireSignedIn() {
    if (!demoState.signedIn || !demoState.account) {
      throw err("not_signed_in", "sign in to KOVA LIVE first");
    }
    return demoState.account;
  }

  function isTagTaken(key, ownKey) {
    if (key === ownKey) return false;
    if (FAKE_PLAYERS[key]) return true;
    var held = demoState.heldTags[key];
    if (held && held > nowSeconds()) return true;
    return false;
  }

  function isBlocked(tag) {
    return demoState.blocked.some(function (t) {
      return tagKey(t) === tagKey(tag);
    });
  }

  function findFriend(tag) {
    return (
      demoState.friends.find(function (f) {
        return tagKey(f.tag) === tagKey(tag);
      }) || null
    );
  }

  function unreadCount(convo) {
    if (!convo) return 0;
    var lastRead = convo.last_read || 0;
    return convo.messages.filter(function (m) {
      return !m.mine && m.sent_at > lastRead;
    }).length;
  }

  var demoCommands = {
    live_get_status: function () {
      return demoStatus();
    },

    live_sign_up: function (args) {
      args = args || {};
      var email = (args.email || "").trim();
      if (!EMAIL_RE.test(email)) {
        throw err("email_invalid", "that does not look like an email address");
      }
      if ((args.password || "").length < PASSWORD_MIN) {
        throw err("password_too_short", "passwords need at least 8 characters");
      }
      var checked = validateTag(args.tag);
      if (!checked.ok) throw err("tag_invalid", checked.error);
      var key = tagKey(checked.tag);
      var ownKey = demoState.account ? tagKey(demoState.account.live_tag) : null;
      if (isTagTaken(key, ownKey)) {
        throw err("tag_taken", "that tag is already claimed");
      }
      // A fresh account seeds itself (contract §6). A second
      // sign-up in the demo replaces the demo account.
      demoState.account = {
        email: email,
        password: args.password,
        live_tag: checked.tag,
        email_verified: false,
        appear_offline: false,
        hide_playing: false,
        tag_changed_at: null,
      };
      demoState.signedIn = true;
      seedAccount(demoState);
      saveDemoState();
      return { live_tag: checked.tag, email_verified: false };
    },

    live_sign_in: function (args) {
      args = args || {};
      var account = demoState.account;
      if (
        !account ||
        (args.email || "").trim().toLowerCase() !== account.email.toLowerCase() ||
        args.password !== account.password
      ) {
        throw err("invalid_credentials", "that email and password do not match an account");
      }
      demoState.signedIn = true;
      saveDemoState();
      return demoStatus();
    },

    live_sign_out: function () {
      demoState.signedIn = false;
      saveDemoState();
      return null;
    },

    live_resend_verification: function () {
      var account = requireSignedIn();
      // Stub: marks verified immediately (there is no email in
      // the stub). The real backend sends the email.
      account.email_verified = true;
      saveDemoState();
      return null;
    },

    live_check_tag: function (args) {
      args = args || {};
      var checked = validateTag(args.tag);
      if (!checked.ok) throw err("tag_invalid", checked.error);
      var key = tagKey(checked.tag);
      var ownKey = demoState.account ? tagKey(demoState.account.live_tag) : null;
      if (!isTagTaken(key, ownKey)) {
        return { available: true, suggestions: [] };
      }
      var suggestions = suggestTags(checked.tag).filter(function (c) {
        return !isTagTaken(tagKey(c), ownKey);
      });
      return { available: false, suggestions: suggestions.slice(0, 3) };
    },

    live_claim_tag: function (args) {
      var account = requireSignedIn();
      args = args || {};
      var checked = validateTag(args.tag);
      if (!checked.ok) throw err("tag_invalid", checked.error);
      var key = tagKey(checked.tag);
      if (key === tagKey(account.live_tag)) {
        return { live_tag: account.live_tag };
      }
      if (
        account.tag_changed_at &&
        nowSeconds() - account.tag_changed_at < TAG_CHANGE_DAYS * DAY_SECONDS
      ) {
        throw err("tag_change_too_soon", "tags can only change once every 30 days");
      }
      if (isTagTaken(key, tagKey(account.live_tag))) {
        throw err("tag_taken", "that tag is already claimed");
      }
      // The old tag is held 30 days before anyone else can claim it.
      demoState.heldTags[tagKey(account.live_tag)] =
        nowSeconds() + TAG_CHANGE_DAYS * DAY_SECONDS;
      account.live_tag = checked.tag;
      account.tag_changed_at = nowSeconds();
      saveDemoState();
      return { live_tag: checked.tag };
    },

    live_search_tag: function (args) {
      requireSignedIn();
      args = args || {};
      var player = fakePlayer(args.tag);
      if (!player || isBlocked(player.tag)) {
        return { found: false, profile: null };
      }
      return {
        found: true,
        profile: { tag: player.tag, avatar: player.avatar, bio: player.bio },
      };
    },

    live_send_request: function (args) {
      var account = requireSignedIn();
      args = args || {};
      var player = fakePlayer(args.tag);
      if (!player) {
        throw err("not_found", "no player has that tag");
      }
      if (tagKey(player.tag) === tagKey(account.live_tag)) {
        throw err("cannot_add_self", "you cannot add yourself as a friend");
      }
      if (isBlocked(player.tag)) {
        throw err("blocked", "that player is blocked");
      }
      if (findFriend(player.tag)) {
        throw err("already_friends", "you are already friends with " + player.tag);
      }
      if (
        demoState.requestsOut.some(function (r) {
          return tagKey(r.to_tag) === tagKey(player.tag);
        })
      ) {
        throw err("already_pending", "a friend request to " + player.tag + " is already waiting");
      }
      if (demoState.friends.length >= FRIEND_CAP) {
        throw err("friend_cap", "the friends list is full (500)");
      }
      // Stub-only: fake players auto-accept immediately, so the
      // full flow completes in one session. The request never
      // sits in requests_out; the friend appears at once.
      demoState.friends.push(friendFromPlayer(player));
      saveDemoState();
      return { request_id: "req_auto_" + tagKey(player.tag) };
    },

    live_accept_request: function (args) {
      requireSignedIn();
      args = args || {};
      var at = demoState.requestsIn.findIndex(function (r) {
        return r.id === args.request_id;
      });
      if (at < 0) throw err("request_not_found", "that request is no longer waiting");
      var request = demoState.requestsIn[at];
      demoState.requestsIn.splice(at, 1);
      var player = fakePlayer(request.from_tag);
      if (player && !findFriend(player.tag)) {
        demoState.friends.push(friendFromPlayer(player));
      }
      saveDemoState();
      return null;
    },

    live_decline_request: function (args) {
      requireSignedIn();
      args = args || {};
      demoState.requestsIn = demoState.requestsIn.filter(function (r) {
        return r.id !== args.request_id;
      });
      saveDemoState();
      return null;
    },

    live_remove_friend: function (args) {
      requireSignedIn();
      args = args || {};
      demoState.friends = demoState.friends.filter(function (f) {
        return tagKey(f.tag) !== tagKey(args.tag);
      });
      saveDemoState();
      return null;
    },

    live_block: function (args) {
      requireSignedIn();
      args = args || {};
      var tag = (args.tag || "").trim();
      if (!tag) throw err("tag_invalid", "no player to block");
      demoState.friends = demoState.friends.filter(function (f) {
        return tagKey(f.tag) !== tagKey(tag);
      });
      demoState.requestsIn = demoState.requestsIn.filter(function (r) {
        return tagKey(r.from_tag) !== tagKey(tag);
      });
      demoState.requestsOut = demoState.requestsOut.filter(function (r) {
        return tagKey(r.to_tag) !== tagKey(tag);
      });
      if (!isBlocked(tag)) demoState.blocked.push(tag);
      saveDemoState();
      return null;
    },

    live_unblock: function (args) {
      requireSignedIn();
      args = args || {};
      demoState.blocked = demoState.blocked.filter(function (t) {
        return tagKey(t) !== tagKey(args.tag);
      });
      saveDemoState();
      return null;
    },

    live_get_friends: function () {
      requireSignedIn();
      return {
        friends: JSON.parse(JSON.stringify(demoState.friends)),
        requests_in: JSON.parse(JSON.stringify(demoState.requestsIn)),
        requests_out: JSON.parse(JSON.stringify(demoState.requestsOut)),
        blocked: demoState.blocked.slice(),
      };
    },

    live_set_privacy: function (args) {
      var account = requireSignedIn();
      args = args || {};
      if (typeof args.appear_offline === "boolean") {
        account.appear_offline = args.appear_offline;
      }
      if (typeof args.hide_playing === "boolean") {
        account.hide_playing = args.hide_playing;
      }
      saveDemoState();
      return demoLiveSection();
    },

    live_send_message: function (args) {
      var account = requireSignedIn();
      args = args || {};
      var to = (args.to_tag || "").trim();
      var body = args.body || "";
      if (body.length > MESSAGE_MAX) {
        throw err("message_too_long", "messages can be at most 2000 characters");
      }
      if (!body.trim()) {
        throw err("message_empty", "write something first");
      }
      if (isBlocked(to)) {
        throw err("blocked", "that player is blocked");
      }
      if (!findFriend(to)) {
        throw err("not_friends", "you can only message friends");
      }
      var now = nowSeconds();
      demoState.sentAt = demoState.sentAt.filter(function (t) {
        return now - t < 60;
      });
      if (demoState.sentAt.length >= RATE_LIMIT_PER_MIN) {
        throw err("rate_limited", "slow down — too many messages at once");
      }
      demoState.sentAt.push(now);
      demoState.msgSeq += 1;
      var message = {
        id: "m" + demoState.msgSeq,
        conversation_tag: to,
        from_tag: account.live_tag,
        body: body,
        sent_at: now,
        mine: true,
      };
      var convo = demoState.conversations[to];
      if (!convo) {
        convo = { messages: [], last_read: now };
        demoState.conversations[to] = convo;
      }
      convo.messages.push(message);
      if (convo.messages.length > MESSAGE_CAP) {
        convo.messages.splice(0, convo.messages.length - MESSAGE_CAP);
      }
      convo.last_read = now;
      saveDemoState();
      return { message: message };
    },

    live_get_conversations: function () {
      requireSignedIn();
      var list = Object.keys(demoState.conversations).map(function (tag) {
        var convo = demoState.conversations[tag];
        var last = convo.messages[convo.messages.length - 1];
        return {
          tag: tag,
          last_message: last ? last.body : "",
          last_at: last ? last.sent_at : 0,
          unread: unreadCount(convo),
        };
      });
      list.sort(function (a, b) {
        return b.last_at - a.last_at;
      });
      return list;
    },

    live_get_messages: function (args) {
      requireSignedIn();
      args = args || {};
      var convo = demoState.conversations[(args.tag || "").trim()];
      if (!convo) return { messages: [], unread: 0 };
      var unread = unreadCount(convo);
      convo.last_read = nowSeconds();
      saveDemoState();
      return {
        messages: JSON.parse(JSON.stringify(convo.messages)),
        unread: unread,
      };
    },

    live_delete_message: function (args) {
      requireSignedIn();
      args = args || {};
      var found = null;
      Object.keys(demoState.conversations).forEach(function (tag) {
        var convo = demoState.conversations[tag];
        var at = convo.messages.findIndex(function (m) {
          return m.id === args.message_id;
        });
        if (at >= 0) found = { convo: convo, at: at };
      });
      if (!found) throw err("message_not_found", "that message is gone already");
      if (!found.convo.messages[found.at].mine) {
        throw err("not_your_message", "you can only delete your own messages");
      }
      found.convo.messages.splice(found.at, 1);
      saveDemoState();
      return null;
    },

    live_report: function (args) {
      requireSignedIn();
      args = args || {};
      // The arg is ref_, not ref: `ref` is a reserved keyword in
      // Rust, so the Tauri parameter is ref_ and Tauri maps JSON
      // keys to parameter names exactly (contract §3).
      if (args.kind !== "message" && args.kind !== "profile") {
        throw err("report_invalid", "reports name a message or a profile");
      }
      if (!args.ref_ || typeof args.ref_ !== "string") {
        throw err("report_invalid", "reports name a message or a profile");
      }
      // The stub accepts the report; a human on the Avok team
      // reads the real queue (spec §5.4).
      return null;
    },

    live_delete_account: function (args) {
      var account = requireSignedIn();
      args = args || {};
      if ((args.confirm_tag || "").trim() !== account.live_tag) {
        throw err("confirm_mismatch", "type your LIVE tag exactly to confirm");
      }
      demoState.heldTags[tagKey(account.live_tag)] =
        nowSeconds() + TAG_CHANGE_DAYS * DAY_SECONDS;
      demoState.account = null;
      demoState.signedIn = false;
      demoState.friends = [];
      demoState.requestsIn = [];
      demoState.requestsOut = [];
      demoState.blocked = [];
      demoState.conversations = {};
      demoState.msgSeq = 0;
      demoState.sentAt = [];
      saveDemoState();
      return null;
    },

    live_get_presence: function () {
      var account = demoState.account;
      if (!demoState.signedIn || !account) {
        return { state: "offline", playing: null };
      }
      if (account.appear_offline) {
        return { state: "appear_offline", playing: null };
      }
      // The demo has no playtime watcher, so nothing is ever
      // "in game" here; the real backend derives it from the
      // active session (contract §3).
      return { state: "online", playing: null };
    },

    live_sync_profile: function () {
      requireSignedIn();
      return null;
    },
  };

  var demoBackend = {
    call: function (cmd, args) {
      var fn = demoCommands[cmd];
      if (!fn) {
        return Promise.reject(err("unknown_command", "no such LIVE command: " + cmd));
      }
      try {
        return Promise.resolve(fn(args || {}));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    // Exposed for the gate + tests: the fake players the stub
    // seeds, and a reset for a clean slate.
    fakePlayers: function () {
      return Object.keys(FAKE_PLAYERS).map(function (k) {
        return FAKE_PLAYERS[k].tag;
      });
    },
    reset: function () {
      demoState = freshDemoState();
      saveDemoState();
    },
  };

  // ------------------------------------------------------------ boot

  var hadPersisted = loadDemoState();

  // Gate hook: ?demo=1&live=authed auto-signs-in a demo account
  // (tag "Dre", verified, seeded per §6) when there is no
  // persisted demo state yet. Demo-only: isDemo() is false
  // inside the app, so this can never run there.
  function isDemo() {
    return !(
      window.__TAURI__ &&
      window.__TAURI__.core &&
      typeof window.__TAURI__.core.invoke === "function"
    );
  }

  if (isDemo() && !hadPersisted) {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("demo") === "1" && params.get("live") === "authed") {
        demoState.account = {
          email: "demo@kova.local",
          password: "demo-password-1",
          live_tag: "Dre",
          email_verified: true,
          appear_offline: false,
          hide_playing: false,
          tag_changed_at: null,
        };
        demoState.signedIn = true;
        seedAccount(demoState);
        saveDemoState();
      }
    } catch (e) {
      /* no gate hook without URL parsing */
    }
  }

  // ----------------------------------------------------------- events

  // Subscribe to live-presence / live-message Tauri events when
  // running under Tauri; no-op in demo mode. Returns the
  // Tauri unlisten promise, or a resolved no-op.
  function onEvent(name, fn) {
    try {
      var tauriEvent = window.__TAURI__ && window.__TAURI__.event;
      if (tauriEvent && typeof tauriEvent.listen === "function") {
        return tauriEvent.listen(name, fn);
      }
    } catch (e) {
      /* fall through to the no-op */
    }
    return Promise.resolve(function () {});
  }

  // ------------------------------------------------------------- call

  // Invokes the Tauri command, or the demo backend when there is
  // no Tauri global (demo mode + headless tests).
  function call(cmd, args) {
    if (!isDemo()) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    return demoBackend.call(cmd, args || {});
  }

  window.KovaLive = {
    call: call,
    isDemo: isDemo,
    validateTag: validateTag,
    suggestTags: suggestTags,
    presenceLabel: presenceLabel,
    sortFriends: sortFriends,
    onEvent: onEvent,
    demoBackend: demoBackend,
  };
})();
