const WS_URL = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
/** CSS pixels per dungeon tile — larger = clearer map / less "low-fi". */
const TILE = 26;
const FOV = 9;
/** Visible window in tiles — camera tracks the player. */
const VIEW_W = 32;
const VIEW_H = 18;
/** Input lock failsafe (ms). Server unlock is faster; this keeps turn spam snappy. */
const INPUT_LOCK_MS = 90;
/** Cap devicePixelRatio so mobile GPUs stay smooth. */
const MAX_DPR = 2.5;

/** Terrain base colors (lit). Memory/out-of-FOV uses desaturated dark variants. */
const TERRAIN = {
  "#": { fill: [58, 66, 86], edge: [110, 122, 148], mem: [16, 17, 24] },
  ".": { fill: [34, 44, 58], edge: [48, 60, 78], mem: [11, 12, 18] },
  ">": { fill: [64, 52, 22], edge: [220, 180, 50], mem: [24, 20, 12] },
  "<": { fill: [30, 48, 72], edge: [120, 160, 220], mem: [14, 18, 28] },
  "+": { fill: [72, 54, 34], edge: [190, 130, 70], mem: [20, 16, 12] },
};
const MONSTER = {
  rat: "#c4a06a",
  bat: "#b09ad0",
  snake: "#6ad06a",
  kobold: "#9acc5a",
  goblin: "#7aba4a",
  skeleton: "#e8e8d8",
  orc: "#e0b840",
  wraith: "#b0a0ff",
  ogre: "#d88850",
  troll: "#5aba8a",
  dragon: "#f05050",
};
const ITEM_COLORS = {
  ")": "#e0c060",
  "[": "#80a0d0",
  "!": "#e070e0",
  "%": "#d09050",
  "?": "#90d0ff",
  $: "#ffd700",
  "=": "#a0e0ff",
  "/": "#c0c0ff",
};

/** Map KeyboardEvent.code → server key (layout-independent for WASD). */
const CODE_TO_KEY = {
  ArrowUp: "k",
  ArrowDown: "j",
  ArrowLeft: "h",
  ArrowRight: "l",
  KeyW: "k",
  KeyA: "h",
  KeyS: "j",
  KeyD: "l",
  KeyH: "h",
  KeyJ: "j",
  KeyK: "k",
  KeyL: "l",
  KeyY: "y",
  KeyU: "u",
  KeyB: "b",
  KeyN: "n",
  KeyI: "i",
  KeyG: "g",
  Period: ".",
  Space: ".",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
};
/** Keys that must never scroll the page while playing. */
const SCROLL_BLOCK_CODES = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyH",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyY",
  "KeyU",
  "KeyB",
  "KeyN",
]);

let ws = null;
let state = null;
let explored = [];
/** Voluntary compute Web Worker (contribute cycles between inputs). */
let computeWorker = null;
let computeScore = 0;
let computeOffered = false;
/** Sticky browser session — restored so reconnect/audit span soft reloads. */
let sessionId = null;
try {
  sessionId = sessionStorage.getItem("grokhack-session");
} catch {
  /* private mode */
}
/** Per-name resume secrets (sec-app) — required to rejoin an existing run. */
function loadResumeMap() {
  try {
    const raw = localStorage.getItem("grokhack-resume");
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
function saveResumeToken(name, token) {
  if (!name || !token) return;
  try {
    const map = loadResumeMap();
    map[String(name).toLowerCase()] = token;
    localStorage.setItem("grokhack-resume", JSON.stringify(map));
  } catch {
    /* private mode */
  }
}
function getResumeToken(name) {
  if (!name) return undefined;
  try {
    return loadResumeMap()[String(name).toLowerCase()] || undefined;
  } catch {
    return undefined;
  }
}
function clearResumeToken(name) {
  if (!name) return;
  try {
    const map = loadResumeMap();
    const key = String(name).toLowerCase();
    if (!(key in map)) return;
    delete map[key];
    localStorage.setItem("grokhack-resume", JSON.stringify(map));
  } catch {
    /* private mode */
  }
}
/** Join failed before the server admitted us — do not sticky-reconnect as joined. */
function resetJoinAttempt(message) {
  joined = false;
  resuming = false;
  if (message) {
    try {
      $("join-err").textContent = message;
    } catch {
      /* ignore */
    }
  }
}
let inputLocked = false;
let inputUnlockTimer = null;
let pendingKey = null;
let joined = false;
let playerName = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingTimer = null;
/** True while a mid-game WS rejoin is in flight (silent resume, unlock input). */
let resuming = false;
let social = null;
let chatExpanded = false;
let chatUnread = 0;
let socialOpen = false;
let lastHp = null;
let cam = { ox: 0, oy: 0 };
let floatTexts = []; // {x,y,text,color,life,max}
let lastLogSeen = "";
let prevHpForFloat = null;
const chatLines = [];
const dmLines = [];
const telemetryQueue = [];
const breadcrumbs = [];
let telemetryTimer = null;
const sessionStartedAt = Date.now();
/** Attribution from ?ref=x share links (Growth). */
const acquireRef = (() => {
  try {
    return new URLSearchParams(location.search).get("ref") || "";
  } catch {
    return "";
  }
})();

/** Cached linked X handle (no @) for death shares — filled from player state / API. */
let linkedXHandle = null;
try {
  linkedXHandle = sessionStorage.getItem("grokhack-x-handle") || null;
} catch {
  /* private mode */
}

const $ = (id) => document.getElementById(id);

function cacheXHandle(handle) {
  if (!handle) return;
  const h = String(handle).replace(/^@+/, "").trim();
  if (!h) return;
  linkedXHandle = h;
  try {
    sessionStorage.setItem("grokhack-x-handle", h);
  } catch {
    /* ignore */
  }
}

function xHandleDisplay(handle) {
  if (!handle) return null;
  const h = String(handle).replace(/^@+/, "");
  return h ? `@${h}` : null;
}

/** Request a link code (Discord /link equivalent for X). */
async function requestXLinkCode(xHandle, gameName) {
  const res = await fetch("/api/x/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xHandle, gameName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    return { ok: false, message: data.message || data.error || "Could not create link code" };
  }
  return data;
}

async function refreshXLinkStatus(name) {
  const n = name || playerName;
  if (!n) return;
  try {
    const res = await fetch(`/api/x/handle?name=${encodeURIComponent(n)}`);
    const data = await res.json();
    if (data?.xHandle) cacheXHandle(data.xHandle);
    const statusEl = $("x-link-status");
    if (statusEl) {
      if (data?.display) {
        statusEl.textContent = `Linked: ${data.display} ↔ ${n}`;
        statusEl.classList.add("linked");
      } else {
        statusEl.textContent = `No X linked for ${n}. Get a code below.`;
        statusEl.classList.remove("linked");
      }
    }
  } catch {
    /* offline */
  }
}

function crumb(label, detail) {
  breadcrumbs.push(`${label}${detail ? ":" + detail : ""}`);
  if (breadcrumbs.length > 30) breadcrumbs.shift();
}

function track(event, detail = {}) {
  telemetryQueue.push({ event, detail, at: new Date().toISOString() });
  crumb(event, detail.phase || detail.attempt || "");
  if (telemetryQueue.length >= 15) flushTelemetry();
}

function flushTelemetry() {
  if (!telemetryQueue.length) return;
  const batch = telemetryQueue.splice(0, 50);
  const body = JSON.stringify({ sessionId, events: batch });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function startTelemetryFlush() {
  clearInterval(telemetryTimer);
  telemetryTimer = setInterval(flushTelemetry, 12_000);
}

function reportClientError(err, context) {
  track("client_error", { context });
  fetch("/api/audit/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: String(err?.message || err),
      context,
      stack: err?.stack?.slice(0, 800),
      breadcrumbs: [...breadcrumbs],
      url: location.href,
    }),
    keepalive: true,
  }).catch(() => {});
}

function toast(msg, isErr = false) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function setConnStatus(kind) {
  const dot = $("conn-dot");
  if (!dot) return;
  dot.classList.remove("ok", "bad");
  if (kind === "ok") dot.classList.add("ok");
  if (kind === "bad") dot.classList.add("bad");
  dot.title = kind === "ok" ? "Connected" : kind === "bad" ? "Disconnected" : "Connecting";
}

/** True only when a *visible* text field is focused (ignore hidden join form). */
function isTyping() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.id === "canvas") return false;
  const tag = el.tagName;
  const editable =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  if (!editable) return false;
  // Hidden join-screen / collapsed panels must not steal WASD/arrows
  if (el.closest?.(".hidden")) return false;
  if (el.closest?.("#join-screen")) return false;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // chat collapsed: input still in DOM but not meant to capture movement
    if (el.id === "chat-input" && $("chat-dock")?.classList.contains("collapsed")) return false;
  } catch {
    /* ignore */
  }
  return true;
}

function isGameActive() {
  return (
    joined &&
    $("join-screen")?.classList.contains("hidden") &&
    $("overlay")?.classList.contains("hidden")
  );
}

function focusGame() {
  const canvas = $("canvas");
  if (!canvas) return;
  const ae = document.activeElement;
  // Blur leftover join/name field so isTyping() is false immediately
  if (ae && ae !== canvas && !isTyping()) {
    if (ae.id === "name-input" || ae.closest?.("#join-screen") || ae.closest?.(".hidden")) {
      try {
        ae.blur();
      } catch {
        /* ignore */
      }
    }
  }
  const doFocus = () => {
    try {
      canvas.focus({ preventScroll: true });
    } catch {
      try {
        canvas.focus();
      } catch {
        /* ignore */
      }
    }
  };
  doFocus();
  // Defer once more so click handlers don't immediately steal focus
  requestAnimationFrame(doFocus);
}

function focusGameSoon() {
  focusGame();
  setTimeout(focusGame, 50);
}

function setPlayingChrome(on) {
  document.body.classList.toggle("playing", !!on);
  document.documentElement.classList.toggle("playing", !!on);
}

/** Resolve a keydown to the single-char key the server expects. */
function resolveGameKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // Shift+. is ">" on US — must beat CODE_TO_KEY Period → "."
  if (e.key === ">") return "g";
  if (e.key === "?" || (e.shiftKey && (e.key === "/" || e.code === "Slash"))) return "?";
  if (CODE_TO_KEY[e.code]) return CODE_TO_KEY[e.code];
  if (e.key === ".") return ".";
  if (e.key === " " || e.code === "Space") return ".";
  if (e.key.length === 1) {
    const k = e.key.toLowerCase();
    if ("hjkl yubnig.".replace(/\s/g, "").includes(k) || (k >= "0" && k <= "9")) return k;
  }
  // Arrow keys via key when code missing
  if (e.key === "ArrowUp") return "k";
  if (e.key === "ArrowDown") return "j";
  if (e.key === "ArrowLeft") return "h";
  if (e.key === "ArrowRight") return "l";
  return null;
}

function expandChat(focusInput = true) {
  chatExpanded = true;
  $("chat-dock")?.classList.remove("collapsed");
  $("btn-chat")?.classList.add("active");
  chatUnread = 0;
  updateChatBadge();
  track("chat_open");
  if (focusInput) $("chat-input")?.focus();
}

function collapseChat() {
  chatExpanded = false;
  $("chat-dock")?.classList.add("collapsed");
  $("btn-chat")?.classList.remove("active");
  try { $("chat-input")?.blur(); } catch { /* ignore */ }
  track("chat_close");
  focusGame();
}

function updateChatBadge() {
  const badge = $("chat-badge");
  if (!badge) return;
  if (chatUnread > 0 && !chatExpanded) {
    badge.textContent = String(chatUnread);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function openSocial() {
  socialOpen = true;
  $("social-drawer")?.classList.add("open");
  $("drawer-backdrop")?.classList.remove("hidden");
  $("social-drawer")?.setAttribute("aria-hidden", "false");
  track("social_open");
}

function closeSocial() {
  socialOpen = false;
  $("social-drawer")?.classList.remove("open");
  $("drawer-backdrop")?.classList.add("hidden");
  $("social-drawer")?.setAttribute("aria-hidden", "true");
  focusGame();
}

function sendSocial(action, fields = {}) {
  if (!ws || ws.readyState !== 1) {
    toast("Not connected", true);
    return false;
  }
  ws.send(JSON.stringify({ type: "social", action, ...fields }));
  return true;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setConnStatus("bad");
  // Fast first retry (250ms) then exponential backoff (cap 30s)
  const delay = Math.min(30_000, 250 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  track("reconnect_scheduled", { attempt: reconnectAttempt, delayMs: delay });
  const errEl = $("join-err");
  if (errEl && !joined) {
    errEl.textContent =
      delay < 1000
        ? `Reconnecting…`
        : `Reconnecting in ${Math.round(delay / 1000)}s…`;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
  }, 20_000);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setConnStatus("connecting");
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    reconnectAttempt = 0;
    computeOffered = false;
    setConnStatus("ok");
    // Keep sticky session across reconnects; mint only once per browser tab
    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }
    try { sessionStorage.setItem("grokhack-session", sessionId); } catch { /* private mode */ }
    $("join-err").textContent = "";
    startPing();
    startTelemetryFlush();
    track("ws_open", { resuming: !!(playerName && joined) });
    unlockInput();
    if (playerName && joined) {
      // Mid-game reconnect: name + resumeToken (auth) + sessionId (audit sticky)
      resuming = true;
      ws.send(JSON.stringify({
        type: "join",
        name: playerName,
        sessionId,
        resumeToken: getResumeToken(playerName),
      }));
    }
  };
  ws.onmessage = (e) => {
    unlockInput();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      reportClientError(err, "ws_parse");
      return;
    }
    try {
      handleMessage(msg);
      flushPendingKey();
    } catch (err) {
      reportClientError(err, "handle_message:" + (msg?.type || "unknown"));
      toast("UI error — try refresh", true);
    }
  };
  ws.onerror = () => {
    reportClientError("websocket error", "ws_error");
    setConnStatus("bad");
  };
  ws.onclose = () => {
    unlockInput();
    clearInterval(pingTimer);
    setConnStatus("bad");
    resuming = false;
    track("ws_close", { joined, playerName });
    flushTelemetry();
    if (joined) {
      toast("Connection lost — reconnecting…", true);
      scheduleReconnect();
    } else {
      $("join-err").textContent = "Server unreachable — retrying…";
      scheduleReconnect();
    }
  };
}

function ensureComputeWorker() {
  if (computeWorker) return computeWorker;
  if (typeof Worker === "undefined") return null;
  try {
    computeWorker = new Worker("/compute-worker.js");
    computeWorker.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.type !== "solved") return;
      if (ws?.readyState !== 1) return;
      ws.send(
        JSON.stringify({
          type: "compute_result",
          job_id: m.job_id,
          ok: !!m.ok,
          result: m.result,
          error: m.error,
          ms: m.ms,
        })
      );
    };
    computeWorker.onerror = () => {
      /* worker failed — stop offering until next page load */
      computeWorker = null;
    };
  } catch {
    computeWorker = null;
  }
  return computeWorker;
}

function offerCompute() {
  if (computeOffered || ws?.readyState !== 1) return;
  if (!ensureComputeWorker()) return;
  computeOffered = true;
  ws.send(
    JSON.stringify({
      type: "compute_offer",
      capacity: 1,
      name: playerName || "browser",
      job_types: ["hash_check", "fov_rays", "pathfind_bfs", "gen_validation"],
    })
  );
}

function handleMessage(msg) {
  if (msg.type === "welcome") {
    $("join-online").textContent = msg.online ?? 0;
    // SESSION-HA: do not clobber sticky browser sessionId with a fresh server UUID
    if (msg.sessionId && !sessionId) {
      sessionId = msg.sessionId;
    }
    try {
      if (sessionId) sessionStorage.setItem("grokhack-session", sessionId);
    } catch {
      /* ignore */
    }
  } else if (msg.type === "compute_ready") {
    track("compute_ready", { score: msg.score });
  } else if (msg.type === "compute_job") {
    const w = ensureComputeWorker();
    if (!w) {
      if (ws?.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "compute_result",
            job_id: msg.job_id,
            ok: false,
            error: "no_worker",
          })
        );
      }
      return;
    }
    w.postMessage({
      type: "solve",
      job_id: msg.job_id,
      job_type: msg.job_type,
      payload: msg.payload,
    });
  } else if (msg.type === "compute_ack") {
    if (msg.accepted && typeof msg.total_score === "number") {
      computeScore = msg.total_score;
      track("compute_ack", { score: computeScore, job_type: msg.job_type });
    }
  } else if (msg.type === "presence" || msg.type === "pong") {
    const n = msg.online ?? msg.players?.length ?? 0;
    $("join-online").textContent = n;
    if (state) state.online = n;
    updateHeader();
  } else if (msg.type === "error") {
    $("join-err").textContent = msg.message;
    // Don't sticky-toast "Name already in use" spam during racey reconnects
    if (resuming && /already in use/i.test(msg.message || "")) {
      track("resume_name_busy", { message: msg.message });
      // Retry shortly — grace owner may still be flipping; backoff handles it
      scheduleReconnect();
      return;
    }
    // Existing durable character without a matching browser resume key.
    // Clear the bad local secret and stop pretending we are joined (which
    // previously looped reconnects on the same failed name forever).
    if (/resume denied/i.test(msg.message || "")) {
      clearResumeToken(playerName);
      const help =
        "That name already has a save, but this browser does not have its resume key. " +
        "Pick a new name to start fresh, or open the browser/device that first joined.";
      resetJoinAttempt(help);
      toast(help, true);
      track("resume_denied", { name: playerName || "" });
      return;
    }
    // Any other join/admission failure before playable state.
    if (!state?.player) {
      resetJoinAttempt(msg.message);
    }
    toast(msg.message, true);
    resuming = false;
  } else if (msg.type === "social_snapshot") {
    social = msg.snapshot;
    if (msg.resumeToken && (msg.name || playerName)) {
      saveResumeToken(msg.name || playerName, msg.resumeToken);
    }
    if (msg.chat_history?.length) {
      chatLines.length = 0;
      for (const line of msg.chat_history) appendChat(line, "sys", false);
      renderChatFeed();
    }
    renderSocial();
  } else if (msg.type === "social_result") {
    const r = msg.result;
    if (typeof r === "string") toast(r, true);
    else if (r?.message && r.ok === false) toast(r.message, true);
    else if (r?.message && r.ok !== false) toast(r.message);
    if (r?.snapshot) social = r.snapshot;
    else if (msg.action === "snapshot" && r) social = r;
    if (msg.action === "dm_thread" && r?.thread) {
      dmLines.length = 0;
      for (const m of r.thread) appendDM(m.from, m.to, m.text, m.at);
    }
    renderSocial();
  } else if (msg.type === "chat") {
    if (msg.channel === "dm") {
      appendDM(msg.from, msg.to, msg.text, msg.at);
    } else {
      const me = state?.player?.name;
      const isMe = msg.from === me;
      appendChat(isMe ? `You: ${msg.text}` : `${msg.from}: ${msg.text}`, isMe ? "me" : "chat");
    }
  } else if (msg.type === "social") {
    if (msg.event === "friends_updated" && msg.snapshot) social = msg.snapshot;
    if (msg.event === "wall_post" && msg.post) appendWall(msg.post);
    renderSocial();
  } else if (msg.type === "state" || msg.type === "agent_state") {
    if (msg.type === "agent_state") {
      state = { player: msg.you, floor: msg.floor, others: msg.visible?.players || [], online: msg.online };
    } else {
      state = msg;
    }
    // Only treat the client as joined after the server admitted a playable player.
    if (state?.player?.name) {
      joined = true;
      playerName = state.player.name;
      try {
        localStorage.setItem("grokhack-name", playerName);
      } catch {
        /* private mode */
      }
      resuming = false;
      try {
        $("join-err").textContent = "";
      } catch {
        /* ignore */
      }
    }
    if (state?.player?.xHandle) cacheXHandle(state.player.xHandle);
    // Detect :verify X success in log lines
    const lastMsgs = state?.player?.messages || [];
    for (const m of lastMsgs.slice(-4)) {
      const match = String(m).match(/Linked X (@[\w]+) to /i);
      if (match) cacheXHandle(match[1]);
    }
    // After first playable state, offer spare browser CPU (Web Worker)
    if (!computeOffered) offerCompute();
    if (state.player.phase === "dead") {
      resuming = false;
      track("player_death", {
        depth: state.player.depth,
        turns: state.player.turns,
        cause: state.player.deathCause || "",
      });
      flushTelemetry();
      showEndOverlay("dead", deathDetail(state.player));
      return;
    }
    if (state.player.phase === "won") {
      resuming = false;
      track("player_victory", { depth: state.player.depth, turns: state.player.turns });
      flushTelemetry();
      showEndOverlay("won", "You conquered the dungeon!");
      return;
    }
    ensureExplored(state.floor.width, state.floor.height);
    revealFOV(state);
    const wasResume = resuming;
    if (wasResume) {
      resuming = false;
      unlockInput();
      track("resume_success", {
        name: state.player.name,
        depth: state.player.depth,
        turns: state.player.turns,
      });
      // Silent resume: clear "connection lost" toast without a noisy welcome
      const toastEl = $("toast");
      if (toastEl && /reconnect|connection lost/i.test(toastEl.textContent || "")) {
        toastEl.classList.add("hidden");
      }
    } else if (!state._joinedTracked) {
      state._joinedTracked = true;
      track("join_success", {
        name: state.player.name,
        depth: state.player.depth,
        ref: acquireRef || undefined,
      });
      refreshXLinkStatus(state.player.name);
    }
    showGame();
    render();
    // Prevent soft-lock: always re-focus canvas after resume/state push
    if (wasResume || isGameActive()) focusGameSoon();
  } else if (msg.type === "dead" || msg.type === "won") {
    if (msg.player) {
      state = state || {};
      state.player = msg.player;
    }
    const detail =
      msg.type === "won"
        ? "You conquered the dungeon!"
        : deathDetail(msg.player || state?.player);
    showEndOverlay(msg.type === "won" ? "won" : "dead", detail);
  }
}

function deathDetail(p) {
  if (!p) return "Game over.";
  if (p.deathCause) return p.deathCause;
  const msgs = (p.messages || []).filter((m) => !String(m).startsWith("[chat]"));
  return msgs.slice(-1)[0] || "Game over.";
}

function appendChat(text, kind = "chat", bumpUnread = true) {
  const last = chatLines[chatLines.length - 1];
  if (last?.text === text && last?.kind === kind) return;
  chatLines.push({ text, kind });
  if (chatLines.length > 100) chatLines.shift();
  renderChatFeed();
  if (bumpUnread && !chatExpanded && kind !== "me") {
    chatUnread++;
    updateChatBadge();
  }
}

function appendDM(from, to, text) {
  dmLines.push({ from, to, text, at: new Date().toISOString() });
  if (dmLines.length > 100) dmLines.shift();
  renderDMFeed();
}

function appendWall(post) {
  if (!social) social = { wall: [] };
  social.wall = [post, ...(social.wall || [])].slice(0, 20);
  renderWallFeed();
}

function renderChatFeed() {
  const el = $("chat-feed");
  if (!el) return;
  el.innerHTML = chatLines.length
    ? chatLines.map((l) => `<div class="line ${l.kind}">${esc(l.text)}</div>`).join("")
    : '<div class="line sys">No messages yet. Press Enter to chat.</div>';
  el.scrollTop = el.scrollHeight;
}

function renderDMFeed() {
  const el = $("dm-feed");
  if (!el) return;
  const me = state?.player?.name;
  el.innerHTML = dmLines.length
    ? dmLines.map((m) => {
        const arrow = m.from === me ? `→${m.to}` : `←${m.from}`;
        return `<div class="line dm"><span class="who">${esc(arrow)}</span> ${esc(m.text)}</div>`;
      }).join("")
    : '<div class="line sys">No DMs yet.</div>';
  el.scrollTop = el.scrollHeight;
}

function renderWallFeed() {
  const el = $("wall-feed");
  if (!el) return;
  el.innerHTML = (social?.wall || []).length
    ? social.wall.map((p) => `<div class="line"><span class="who">${esc(p.author)}</span> ${esc(p.text)}</div>`).join("")
    : '<div class="line sys">Wall is quiet.</div>';
}

function renderSocial() {
  renderWallFeed();
  const pending = $("pending-in");
  const list = $("friends-list");
  if (!pending || !list) return;

  const pendingIn = social?.pendingIn || [];
  pending.innerHTML = pendingIn.length
    ? pendingIn.map((n, i) => `<span>${esc(n)} <button type="button" data-pending-idx="${i}">accept</button></span>`).join(" · ")
    : "";

  pending.querySelectorAll("[data-pending-idx]").forEach((btn) => {
    btn.onclick = () => {
      const name = pendingIn[Number(btn.dataset.pendingIdx)];
      if (name) sendSocial("friend_accept", { target: name });
    };
  });

  const friends = social?.friends || [];
  list.innerHTML = friends.length
    ? friends.map((n, i) => `<li><span>${esc(n)}</span><button type="button" data-friend-idx="${i}">dm</button></li>`).join("")
    : '<li class="sys">No friends — add someone above</li>';

  list.querySelectorAll("[data-friend-idx]").forEach((btn) => {
    btn.onclick = () => {
      const name = friends[Number(btn.dataset.friendIdx)];
      if (!name) return;
      $("dm-target").value = name;
      document.querySelector('.tab[data-tab="dms"]')?.click();
      $("dm-text")?.focus();
    };
  });
}

function ensureExplored(w, h) {
  if (explored.length === h && explored[0]?.length === w) return;
  explored = Array.from({ length: h }, () => Array(w).fill(false));
}

function revealFOV(msg) {
  const px = msg.player.x, py = msg.player.y;
  const tiles = msg.floor.tiles;
  for (let dy = -FOV; dy <= FOV; dy++) {
    for (let dx = -FOV; dx <= FOV; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || y >= tiles.length || x >= tiles[0].length) continue;
      if (dx * dx + dy * dy > FOV * FOV) continue;
      explored[y][x] = true;
    }
  }
}

function showGame() {
  $("join-screen").classList.add("hidden");
  $("game").classList.remove("hidden");
  setPlayingChrome(true);
  try {
    $("name-input")?.blur();
  } catch {
    /* ignore */
  }
  if (!chatExpanded && !socialOpen) focusGameSoon();
}

function showOverlay(title, body) {
  $("overlay").classList.remove("hidden");
  $("overlay-box").innerHTML = `<h2>${esc(title)}</h2><p>${esc(body)}</p><button type="button" onclick="location.reload()">Play Again</button>`;
}

/** Death/victory screen — rich run summary + viral share loop (W3). */
function showEndOverlay(outcome, detail) {
  const p = state?.player;
  const name = p?.name || playerName || "Adventurer";
  const depth = p?.depth ?? 1;
  const turns = p?.turns ?? 0;
  const gold = p?.gold ?? 0;
  const level = p?.level ?? 1;
  const won = outcome === "won";
  if (p?.xHandle) cacheXHandle(p.xHandle);
  const xHandle = p?.xHandle || linkedXHandle || null;
  const title = won ? "Victory!" : "You Died";
  const stats = `Depth ${depth} · Lv${level} · ${gold} gold · ${turns} turns`;
  const gear = [
    p?.weapon ? `⚔ ${p.weapon.name}` : null,
    p?.armor ? `🛡 ${p.armor.name}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lastLog = (p?.messages || [])
    .filter((m) => !String(m).startsWith("[chat]"))
    .slice(-3)
    .map((m) => `<div class="end-log-line">${esc(m)}</div>`)
    .join("");
  const share = { won, name, depth, turns, gold, level, detail: detail || "", xHandle };
  const tweet = buildShareTweet(share);
  const intent = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(tweet);
  // Pre-render share card so Post + Save are instant
  const cardDataUrl = renderDeathCardPNG(share);
  const handleLine = xHandleDisplay(xHandle);

  $("overlay").classList.remove("hidden");
  $("overlay-box").classList.toggle("dead", !won);
  $("overlay-box").classList.toggle("won", won);
  $("overlay-box").innerHTML = `
    <h2>${esc(title)}</h2>
    <p class="end-detail">${esc(detail || "")}</p>
    <p class="end-stats">${esc(stats)}</p>
    ${handleLine ? `<p class="end-x-handle">${esc(handleLine)}</p>` : ""}
    ${gear ? `<p class="end-gear">${esc(gear)}</p>` : ""}
    ${lastLog ? `<div class="end-log">${lastLog}</div>` : ""}
    <div class="end-card-wrap">
      <img class="end-card-preview" id="end-card-preview" alt="Death share card" width="300" height="158" />
    </div>
    <div class="end-actions">
      <a class="btn-share-x" id="btn-share-x" href="${intent}" target="_blank" rel="noopener noreferrer">Post on 𝕏</a>
      <button type="button" id="btn-save-death" class="btn-secondary">Save image</button>
      <button type="button" id="btn-copy-death" class="btn-secondary">Copy text</button>
      <button type="button" id="btn-play-again">Play Again</button>
    </div>
    <p class="end-feedback"><a id="btn-end-feedback" href="/feedback.html?page=death&amp;player=${encodeURIComponent(name)}">Send feedback</a> — bugs, balance, what killed you</p>
    <p class="end-hint">${handleLine ? `Shares as ${esc(handleLine)} · ` : ""}Attach the image when you post — media beats 20-view hell</p>
  `;

  const preview = $("end-card-preview");
  if (preview && cardDataUrl) preview.src = cardDataUrl;

  $("btn-play-again")?.addEventListener("click", () => location.reload());
  $("btn-share-x")?.addEventListener("click", () => {
    // Best-effort native share (image + text) on mobile; intent still opens as fallback
    tryNativeShare(share, cardDataUrl, tweet);
    track("share_x_click", { outcome, depth, turns, name, xHandle: xHandle || "" });
    flushTelemetry();
  });
  $("btn-save-death")?.addEventListener("click", () => {
    downloadDeathCard(cardDataUrl, name, depth, won);
    track("share_image_save", { outcome, depth, turns, name });
    flushTelemetry();
    toast("Saved — attach it when you post on 𝕏");
  });
  $("btn-copy-death")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(tweet);
      toast("Copied — paste on X + attach Save image");
      track("share_copy", { outcome, depth, turns });
      flushTelemetry();
    } catch {
      toast("Copy failed — use Post on 𝕏", true);
    }
  });
}

/** Short, hook-first tweet. Lands on play with ref=x for attribution. */
function buildShareTweet({ won, name, depth, turns, gold, level, detail, xHandle }) {
  const playUrl = "https://grokhack.mondello.dev/play.html?ref=x";
  const who = xHandleDisplay(xHandle) ? `${name} (${xHandleDisplay(xHandle)})` : name;
  if (won) {
    return [
      `${who} cleared GrokHack.`,
      `Lv${level} · ${gold}g · ${turns} turns`,
      ``,
      `Multiplayer NetHack. Browser. Free. Humans + AI agents:`,
      playUrl,
    ].join("\n");
  }
  const cause = detail && String(detail).length <= 72 ? detail : null;
  const hook = cause
    ? `Died depth ${depth}: ${cause}`
    : `Died on depth ${depth} in GrokHack`;
  return [
    hook,
    `${who} · ${turns} turns · Lv${level} · ${gold}g`,
    ``,
    `Can you go deeper? Free multiplayer NetHack:`,
    playUrl,
  ].join("\n");
}

/** Branded 1200×630 death/victory card for X media posts (no server). */
function renderDeathCardPNG({ won, name, depth, turns, gold, level, detail, xHandle }) {
  try {
    const W = 1200;
    const H = 630;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    if (!ctx) return null;

    // Background
    ctx.fillStyle = "#08080c";
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createRadialGradient(W * 0.7, H * 0.35, 40, W * 0.55, H * 0.4, 420);
    grad.addColorStop(0, won ? "rgba(74,201,122,0.18)" : "rgba(201,74,74,0.22)");
    grad.addColorStop(1, "rgba(8,8,12,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Frame
    ctx.strokeStyle = won ? "#4ac97a" : "#c94a4a";
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, W - 36, H - 36);
    ctx.strokeStyle = "#2a2a3a";
    ctx.lineWidth = 1;
    ctx.strokeRect(32, 32, W - 64, H - 64);

    // Eyebrow
    ctx.fillStyle = "#6a6a7a";
    ctx.font = "600 22px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText("GROKHACK  ·  MULTIPLAYER  ·  PERMADEATH", 64, 90);

    // Title
    ctx.fillStyle = won ? "#4ac97a" : "#c94a4a";
    ctx.font = "700 88px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText(won ? "VICTORY" : "YOU DIED", 64, 200);

    // Cause / detail
    const line = (detail && String(detail).slice(0, 64)) || (won ? "Dungeon conquered" : "Permadeath");
    ctx.fillStyle = "#d8d8e8";
    ctx.font = "600 32px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText(line, 64, 270);

    // Stats row (+ linked @handle when present)
    const handle = xHandleDisplay(xHandle);
    const whoLine = handle
      ? `${name}  ${handle}  ·  depth ${depth}  ·  Lv${level}  ·  ${gold} gold  ·  ${turns} turns`
      : `${name}  ·  depth ${depth}  ·  Lv${level}  ·  ${gold} gold  ·  ${turns} turns`;
    ctx.fillStyle = "#a8a8b8";
    ctx.font = "400 28px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText(whoLine, 64, 340);

    // Mini map flavor (ASCII strip)
    const mapSnap = snapshotMapASCII();
    if (mapSnap) {
      ctx.fillStyle = "#3a3a4a";
      ctx.font = "400 16px 'IBM Plex Mono', ui-monospace, monospace";
      const lines = mapSnap.split("\n").slice(0, 8);
      lines.forEach((ln, i) => ctx.fillText(ln, 64, 400 + i * 20));
    }

    // Footer
    ctx.fillStyle = "#c9a227";
    ctx.font = "600 26px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText("grokhack.mondello.dev", 64, H - 70);
    ctx.fillStyle = "#6a8ac9";
    ctx.font = "400 22px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText(won ? "Beat that run →" : "Go deeper →", W - 280, H - 70);

    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Compact explored map strip for the share card. */
function snapshotMapASCII() {
  try {
    const tiles = state?.floor?.tiles;
    const p = state?.player;
    if (!tiles || !p) return null;
    const w = tiles[0]?.length || 0;
    const h = tiles.length || 0;
    if (!w || !h) return null;
    const R = 10;
    const x0 = Math.max(0, p.x - R);
    const y0 = Math.max(0, p.y - 4);
    const x1 = Math.min(w, p.x + R + 1);
    const y1 = Math.min(h, p.y + 5);
    const rows = [];
    for (let y = y0; y < y1; y++) {
      let row = "";
      for (let x = x0; x < x1; x++) {
        if (x === p.x && y === p.y) {
          row += "@";
          continue;
        }
        const known = explored[y]?.[x];
        if (!known) {
          row += " ";
          continue;
        }
        const ch = tiles[y][x];
        row += ch === "#" ? "#" : ch === ">" || ch === "<" ? ch : ".";
      }
      rows.push(row);
    }
    return rows.join("\n");
  } catch {
    return null;
  }
}

function downloadDeathCard(dataUrl, name, depth, won) {
  if (!dataUrl) {
    toast("Could not render image", true);
    return;
  }
  const a = document.createElement("a");
  const safe = String(name || "adventurer").replace(/[^\w.-]+/g, "_").slice(0, 24);
  a.href = dataUrl;
  a.download = `grokhack-${won ? "win" : "death"}-d${depth}-${safe}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function tryNativeShare(share, dataUrl, tweet) {
  if (!navigator.share || !dataUrl) return;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], `grokhack-death-d${share.depth}.png`, { type: "image/png" });
    if (navigator.canShare && !navigator.canShare({ files: [file] })) return;
    await navigator.share({ text: tweet, files: [file], title: "GrokHack" });
    track("share_native", { depth: share.depth, won: !!share.won });
    flushTelemetry();
  } catch {
    /* user cancelled or unsupported — intent link still works */
  }
}

function updateHeader() {
  if (!state?.player) return;
  const p = state.player;
  const phase = p.phase === "inventory" ? " · INVENTORY (1-9)" : "";
  $("header-status").textContent = `${p.name} · d${p.depth} · Lv${p.level} · ${state.online ?? "?"} online${phase}`;
}

function renderInventoryPanel(player) {
  let panel = $("inv-panel");
  if (player.phase !== "inventory") {
    panel?.classList.add("hidden");
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "inv-panel";
    panel.className = "inv-panel";
    $("play-area")?.appendChild(panel);
  }
  const items = player.inventory || [];
  const rows = items.length
    ? items
        .map((it, i) => {
          const key = i < 9 ? String(i + 1) : i === 9 ? "0" : "·";
          const label = it.name || "item";
          return `<div class="inv-row"><kbd>${key}</kbd> <span class="inv-char">${esc(it.char || "?")}</span> ${esc(label)}</div>`;
        })
        .join("")
    : `<div class="inv-empty">Pack is empty.</div>`;
  const gear = [
    player.weapon ? `Wielding ${player.weapon.name}` : null,
    player.armor ? `Wearing ${player.armor.name}` : null,
  ]
    .filter(Boolean)
    .map((g) => `<div class="inv-gear">${esc(g)}</div>`)
    .join("");
  panel.innerHTML = `<div class="inv-title">Inventory — press 1-9 to use, i to close</div>${gear}${rows}`;
  panel.classList.remove("hidden");
}

function cameraFor(player, floor) {
  const vw = Math.min(VIEW_W, floor.width);
  const vh = Math.min(VIEW_H, floor.height);
  let ox = player.x - Math.floor(vw / 2);
  let oy = player.y - Math.floor(vh / 2);
  ox = Math.max(0, Math.min(ox, Math.max(0, floor.width - vw)));
  oy = Math.max(0, Math.min(oy, Math.max(0, floor.height - vh)));
  return { ox, oy, vw, vh };
}

function rgb(r, g, b, a = 1) {
  return a < 1 ? `rgba(${r|0},${g|0},${b|0},${a})` : `rgb(${r|0},${g|0},${b|0})`;
}

function lightAt(player, x, y, vis) {
  if (!vis) return 0.28;
  const d2 = (x - player.x) ** 2 + (y - player.y) ** 2;
  const max = FOV * FOV;
  const t = 1 - Math.min(1, d2 / max);
  // Soft torch falloff: bright near player, still readable at FOV edge
  return 0.48 + 0.58 * (t * t * (3 - 2 * t));
}

function drawTerrain(ctx, tile, sx, sy, vis, light) {
  const t = TERRAIN[tile] || TERRAIN["."];
  const src = vis ? t.fill : t.mem;
  const r = src[0] * (vis ? light : 1);
  const g = src[1] * (vis ? light : 1);
  const b = src[2] * (vis ? light : 1);
  ctx.fillStyle = rgb(r, g, b);
  ctx.fillRect(sx, sy, TILE, TILE);

  if (!vis) return;

  if (tile === "#") {
    // Lit wall: top rim highlight + bottom shade + brick face
    const er = t.edge[0] * light;
    const eg = t.edge[1] * light;
    const eb = t.edge[2] * light;
    ctx.fillStyle = rgb(er, eg, eb, 0.72);
    ctx.fillRect(sx, sy, TILE, 3);
    ctx.fillStyle = rgb(er * 0.55, eg * 0.55, eb * 0.55, 0.55);
    ctx.fillRect(sx, sy + 3, 2, TILE - 5);
    ctx.fillStyle = rgb(0, 0, 0, 0.32);
    ctx.fillRect(sx, sy + TILE - 2, TILE, 2);
    ctx.fillStyle = rgb(er, eg, eb, 0.18);
    ctx.fillRect(sx + 3, sy + 5, TILE - 6, TILE - 10);
    // mortar joint every other row for brick read
    const row = Math.floor(sy / TILE);
    const col = Math.floor(sx / TILE);
    if ((row + col) % 2 === 0) {
      ctx.fillStyle = rgb(er, eg, eb, 0.1);
      ctx.fillRect(sx + Math.floor(TILE / 2) - 1, sy + 4, 2, TILE - 8);
    }
  } else if (tile === "." || tile === ">" || tile === "<" || tile === "+") {
    // Floor grain
    const checker = ((sx / TILE) ^ (sy / TILE)) & 1;
    ctx.fillStyle = rgb(255, 255, 255, checker ? 0.045 * light : 0.02 * light);
    ctx.fillRect(sx, sy, TILE, TILE);
    if (tile === ">" || tile === "<") {
      ctx.fillStyle = rgb(t.edge[0], t.edge[1], t.edge[2], 0.95 * light);
      ctx.font = `bold ${Math.floor(TILE * 0.72)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tile, sx + TILE / 2, sy + TILE / 2 + 1);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  }
}

function drawEntity(ctx, x, y, ch, color, opts = {}) {
  const sx = (x - cam.ox) * TILE;
  const sy = (y - cam.oy) * TILE;
  const pad = Math.max(1, Math.floor(TILE * 0.12));
  const cx = sx + TILE / 2;
  const cy = sy + TILE / 2;
  // Soft glow under entity (lit silhouette)
  if (opts.glow) {
    ctx.fillStyle = opts.glow;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.48, 0, Math.PI * 2);
    ctx.fill();
  }
  // Body plate
  ctx.fillStyle = opts.body || "rgba(0,0,0,0.5)";
  if (opts.round) {
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(sx + pad, sy + pad, TILE - pad * 2, TILE - pad * 2);
  }
  // Glyph with subtle outline for readability on bright floors
  ctx.font = `bold ${Math.floor(TILE * 0.72)}px "IBM Plex Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, Math.floor(TILE * 0.08));
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.strokeText(ch, cx, cy + 1);
  ctx.fillStyle = color;
  ctx.fillText(ch, cx, cy + 1);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function applyHitJuice(player) {
  if (lastHp == null) {
    lastHp = player.hp;
    return;
  }
  if (prefersReducedMotion()) {
    lastHp = player.hp;
    return;
  }
  if (player.hp < lastHp) {
    const canvas = $("canvas");
    const shell = $("play-area");
    canvas?.classList.remove("shake");
    shell?.classList.remove("hurt-flash");
    // reflow to restart animation
    void canvas?.offsetWidth;
    canvas?.classList.add("shake");
    shell?.classList.add("hurt-flash");
    clearTimeout(applyHitJuice._t);
    applyHitJuice._t = setTimeout(() => {
      canvas?.classList.remove("shake");
      shell?.classList.remove("hurt-flash");
    }, 280);
  } else if (player.hp > lastHp) {
    $("play-area")?.classList.add("heal-flash");
    clearTimeout(applyHitJuice._h);
    applyHitJuice._h = setTimeout(() => $("play-area")?.classList.remove("heal-flash"), 320);
  }
  lastHp = player.hp;
}


function pushFloat(wx, wy, text, color) {
  floatTexts.push({
    x: wx,
    y: wy,
    text: String(text),
    color: color || "#fff",
    life: 1,
    max: 1,
  });
  if (floatTexts.length > 24) floatTexts.shift();
}

function harvestLogFloats(player) {
  const msgs = (player.messages || []).filter((m) => !String(m).startsWith("[chat]"));
  const last = msgs[msgs.length - 1] || "";
  if (!last || last === lastLogSeen) return;
  lastLogSeen = last;
  const s = String(last);
  const px = player.x;
  const py = player.y;
  // Damage dealt / taken
  let m = s.match(/for (\d+) damage/i) || s.match(/\((\d+) dmg\)/i) || s.match(/CRITICAL[^\d]*(\d+)/i);
  if (m) {
    const n = m[1];
    const crit = /CRITICAL/i.test(s);
    const againstYou = /\byou\b/i.test(s) && !/^You /i.test(s);
    pushFloat(px + (againstYou ? 0 : 0.3), py - 0.2, (crit ? "!" : "") + n, againstYou ? "#ff6a6a" : crit ? "#ffe066" : "#ffd0a0");
    return;
  }
  if (/miss|dodge|whistle|wide/i.test(s)) {
    pushFloat(px, py - 0.15, "miss", "#8a8a9a");
    return;
  }
  if (/pick up|You pick/i.test(s)) {
    pushFloat(px, py - 0.2, "get", "#c9a227");
    return;
  }
  if (/ascend to level|level \d+/i.test(s) && /ascend/i.test(s)) {
    pushFloat(px, py - 0.35, "LEVEL!", "#6ad0ff");
    return;
  }
  if (/dies|kill the|fell the|collapses/i.test(s)) {
    pushFloat(px, py - 0.25, "KILL", "#ff5050");
  }
}

function drawFloats(ctx, dt) {
  const next = [];
  for (const f of floatTexts) {
    f.life -= dt;
    if (f.life <= 0) continue;
    const t = 1 - f.life / f.max;
    const sx = (f.x - cam.ox) * TILE + TILE / 2;
    const sy = (f.y - cam.oy) * TILE + TILE * 0.2 - t * TILE * 1.1;
    ctx.globalAlpha = Math.max(0, f.life / f.max);
    ctx.fillStyle = f.color;
    ctx.font = `bold ${Math.floor(TILE * 0.55)}px "IBM Plex Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 3;
    ctx.strokeText(f.text, sx, sy);
    ctx.fillText(f.text, sx, sy);
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
    next.push(f);
  }
  floatTexts = next;
}

function drawMinimap(ctx, player, floor, others) {
  const mw = 88;
  const mh = 66;
  const pad = 8;
  const ox = cam.vw * TILE - mw - pad;
  const oy = pad;
  ctx.fillStyle = "rgba(6,8,14,0.78)";
  ctx.strokeStyle = "rgba(201,162,39,0.45)";
  ctx.lineWidth = 1;
  ctx.fillRect(ox - 2, oy - 2, mw + 4, mh + 4);
  ctx.strokeRect(ox - 2, oy - 2, mw + 4, mh + 4);

  const scaleX = mw / Math.max(1, floor.width);
  const scaleY = mh / Math.max(1, floor.height);
  // explored floors
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (!explored[y]?.[x]) continue;
      const t = floor.tiles[y][x];
      if (t === "#") ctx.fillStyle = "#2a3040";
      else if (t === ">" || t === "<") ctx.fillStyle = "#c9a227";
      else ctx.fillStyle = "#1a2838";
      ctx.fillRect(ox + x * scaleX, oy + y * scaleY, Math.max(1, scaleX), Math.max(1, scaleY));
    }
  }
  // camera rect
  ctx.strokeStyle = "rgba(150,180,255,0.5)";
  ctx.strokeRect(
    ox + cam.ox * scaleX,
    oy + cam.oy * scaleY,
    cam.vw * scaleX,
    cam.vh * scaleY
  );
  // others
  for (const o of others || []) {
    ctx.fillStyle = "#6a9fff";
    ctx.fillRect(ox + o.x * scaleX - 1, oy + o.y * scaleY - 1, 3, 3);
  }
  // monsters in FOV
  for (const m of floor.monsters || []) {
    if (!inFov(player, m.x, m.y)) continue;
    ctx.fillStyle = m.kind === "dragon" ? "#f05050" : "#c07070";
    ctx.fillRect(ox + m.x * scaleX - 1, oy + m.y * scaleY - 1, 2, 2);
  }
  // player
  ctx.fillStyle = "#ffe08a";
  ctx.fillRect(ox + player.x * scaleX - 1.5, oy + player.y * scaleY - 1.5, 4, 4);
}

/**
 * Size the canvas so tiles stay square.
 * Never stretch via CSS max-width alone — both axes scale together.
 * Returns logical (pre-DPR) draw size in CSS pixels.
 */
function fitCanvasBuffer(canvas, logicalW, logicalH) {
  const area = $("play-area");
  const maxW = Math.max(160, area?.clientWidth || window.innerWidth || logicalW);
  // Leave room for HUD/log/controls under the map
  const maxH = Math.max(
    140,
    Math.min(
      window.innerHeight * (window.matchMedia("(max-width: 720px), (pointer: coarse)").matches ? 0.52 : 0.7),
      900
    )
  );
  // Uniform scale → square tiles always
  const fit = Math.min(1, maxW / logicalW, maxH / logicalH);
  const displayW = Math.max(1, Math.floor(logicalW * fit));
  const displayH = Math.max(1, Math.floor(logicalH * fit));
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const bw = Math.max(1, Math.floor(displayW * dpr));
  const bh = Math.max(1, Math.floor(displayH * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  // Explicit CSS size on both axes — never max-width-only stretch
  canvas.style.width = displayW + "px";
  canvas.style.height = displayH + "px";
  canvas.style.maxWidth = "100%";
  canvas.style.aspectRatio = `${displayW} / ${displayH}`;
  const ctx = canvas.getContext("2d");
  // Map logical game pixels → backing store (keeps TILE math simple)
  const sx = bw / logicalW;
  const sy = bh / logicalH;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { ctx, logicalW, logicalH, displayW, displayH, dpr };
}

function render() {
  if (!state?.player || !state?.floor) return;
  const { player, floor, others = [] } = state;
  const canvas = $("canvas");
  cam = cameraFor(player, floor);
  const w = cam.vw * TILE;
  const h = cam.vh * TILE;
  const { ctx } = fitCanvasBuffer(canvas, w, h);
  ctx.fillStyle = "#050508";
  ctx.fillRect(0, 0, w, h);

  applyHitJuice(player);
  harvestLogFloats(player);
  if (prevHpForFloat != null && player.hp < prevHpForFloat) {
    pushFloat(player.x, player.y - 0.1, "-" + (prevHpForFloat - player.hp), "#ff7070");
  }
  prevHpForFloat = player.hp;

  for (let y = cam.oy; y < cam.oy + cam.vh; y++) {
    for (let x = cam.ox; x < cam.ox + cam.vw; x++) {
      if (!explored[y]?.[x]) continue;
      const vis = inFov(player, x, y);
      const tile = floor.tiles[y]?.[x] ?? " ";
      const sx = (x - cam.ox) * TILE;
      const sy = (y - cam.oy) * TILE;
      const light = lightAt(player, x, y, vis);
      drawTerrain(ctx, tile, sx, sy, vis, light);
    }
  }

  // Torch vignette — colored lighting, not flat mono ASCII
  {
    const lx = (player.x - cam.ox) * TILE + TILE / 2;
    const ly = (player.y - cam.oy) * TILE + TILE / 2;
    const rad = FOV * TILE * 0.95;
    const g = ctx.createRadialGradient(lx, ly, TILE * 0.8, lx, ly, rad);
    g.addColorStop(0, "rgba(255, 200, 110, 0.10)");
    g.addColorStop(0.45, "rgba(90, 120, 200, 0.04)");
    g.addColorStop(1, "rgba(0, 0, 8, 0.42)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  for (const item of floor.items || []) {
    if (!inFov(player, item.x, item.y)) continue;
    if (!inCam(item.x, item.y)) continue;
    drawEntity(ctx, item.x, item.y, item.char, ITEM_COLORS[item.char] || "#d0c060", {
      glow: "rgba(200,180,60,0.22)",
      body: "rgba(24,18,6,0.7)",
    });
  }
  for (const m of floor.monsters || []) {
    if (!inFov(player, m.x, m.y)) continue;
    if (!inCam(m.x, m.y)) continue;
    const mcol = MONSTER[m.kind] || "#fff";
    drawEntity(ctx, m.x, m.y, m.char, mcol, {
      round: true,
      glow: m.kind === "dragon" ? "rgba(240,50,50,0.28)" : "rgba(255,80,80,0.12)",
      body: "rgba(12,8,14,0.72)",
    });
    if (m.maxHp && m.hp < m.maxHp) {
      const ratio = Math.max(0, m.hp / m.maxHp);
      const px = (m.x - cam.ox) * TILE + 2;
      const py = (m.y - cam.oy) * TILE + 1;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(px, py, TILE - 4, 3);
      ctx.fillStyle = ratio < 0.35 ? "#e05050" : ratio < 0.7 ? "#e0b040" : "#50c060";
      ctx.fillRect(px, py, Math.max(1, (TILE - 4) * ratio), 3);
    }
  }
  for (const o of others) {
    if (!inFov(player, o.x, o.y)) continue;
    if (!inCam(o.x, o.y)) continue;
    drawEntity(ctx, o.x, o.y, o.glyph, "#7ab0ff", {
      round: true,
      glow: "rgba(100,150,255,0.28)",
      body: "rgba(16,32,64,0.75)",
    });
  }
  const onStairs =
    floor.stairsDown &&
    player.x === floor.stairsDown.x &&
    player.y === floor.stairsDown.y;
  {
    const px = (player.x - cam.ox) * TILE;
    const py = (player.y - cam.oy) * TILE;
    const g = ctx.createRadialGradient(
      px + TILE / 2,
      py + TILE / 2,
      2,
      px + TILE / 2,
      py + TILE / 2,
      TILE * 1.1
    );
    g.addColorStop(0, "rgba(255, 210, 80, 0.45)");
    g.addColorStop(1, "rgba(255, 180, 40, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(px - 6, py - 6, TILE + 12, TILE + 12);
    if (onStairs) {
      drawEntity(ctx, player.x, player.y, ">", "#e0b83a", { body: "rgba(40,30,8,0.5)" });
    }
    drawEntity(ctx, player.x, player.y, player.glyph || "@", onStairs ? "#ffffff" : "#ffe08a", {
      round: true,
      glow: "rgba(255,200,60,0.35)",
      body: "rgba(48,36,8,0.8)",
    });
  }

  drawFloats(ctx, 0.045);
  drawMinimap(ctx, player, floor, others);
  updateHeader();

  const hud = $("hud");
  const hungry = player.hunger === "hungry" || player.hunger === "weak" || player.hunger === "fainting" || player.hunger === "starving";
  const lowHp = player.hp < player.maxHp * 0.35;
  const wpn = player.weapon?.name ? player.weapon.name : "—";
  const arm = player.armor?.name ? player.armor.name : "—";
  const nearby = (floor.monsters || []).filter(
    (m) => Math.abs(m.x - player.x) + Math.abs(m.y - player.y) === 1 && inFov(player, m.x, m.y)
  );
  const threat =
    nearby.length > 0
      ? `<span class="threat">${esc(nearby.map((m) => m.name).join(", "))}</span>`
      : "";
  hud.innerHTML = [
    `<span class="${lowHp ? "warn" : ""}">HP ${Math.max(0, player.hp)}/${player.maxHp}</span>`,
    `<span>Lv ${player.level}</span>`,
    `<span>XP ${player.xp ?? 0}/${player.xpToLevel ?? "?"}</span>`,
    `<span class="${hungry ? "warn" : ""}">${player.hunger}</span>`,
    `<span>Au ${player.gold}</span>`,
    `<span>T ${player.turns}</span>`,
    `<span title="weapon">⚔ ${esc(wpn)}</span>`,
    `<span title="armor">🛡 ${esc(arm)}</span>`,
    `<span>Inv ${(player.inventory || []).map((i) => i.char).join("") || "—"}</span>`,
    onStairs ? `<span class="stairs-hint">Stairs — g or walk</span>` : "",
    threat,
  ].join("");

  const gameMsgs = (player.messages || []).filter((m) => !m.startsWith("[chat]"));
  const prevLast = $("log")?.dataset?.last || "";
  const last = gameMsgs[gameMsgs.length - 1] || "";
  $("log").innerHTML =
    gameMsgs
      .slice(-5)
      .map((m, idx, arr) => {
        const flash = m === last && m !== prevLast && idx === arr.length - 1 ? " msg-flash" : "";
        return `<div class="${msgClass(m)}${flash}">${esc(m)}</div>`;
      })
      .join("") || "<div>—</div>";
  if ($("log")) $("log").dataset.last = last;

  // Context tip for first-time movers
  const tip = $("context-tip");
  if (tip) {
    if (onStairs) tip.textContent = "You stand on stairs ↓ — press g to descend";
    else if (player.phase === "inventory") tip.textContent = "Inventory open — 1-9 use item, i close";
    else if (nearby.length) tip.textContent = `Engage: bump into ${nearby[0].name}`;
    else if ((player.turns || 0) < 8) tip.textContent = "Move with arrows / WASD / hjkl · i inventory · . wait";
    else tip.textContent = "";
  }

  renderInventoryPanel(player);
}

/** Color-code combat / discovery / danger lines in the message log. */
function msgClass(m) {
  const s = String(m);
  if (/CRITICAL|slain|die|dead|poison|starv/i.test(s)) return "msg-danger";
  if (/kill|ascend|Victory|conquer|gold|restored|strength|better|recognize/i.test(s)) return "msg-good";
  if (/spot a staircase|stairs leading|descend|vault|shrine|roar|hear|sense|growl|footsteps|shadows/i.test(s))
    return "msg-discover";
  if (/miss|dodge|whistles|bump/i.test(s)) return "msg-miss";
  return "";
}

function inFov(player, x, y) {
  return (x - player.x) ** 2 + (y - player.y) ** 2 <= FOV * FOV;
}

function inCam(x, y) {
  return x >= cam.ox && y >= cam.oy && x < cam.ox + cam.vw && y < cam.oy + cam.vh;
}

function drawChar(ctx, x, y, ch, color) {
  drawEntity(ctx, x, y, ch, color);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function unlockInput() {
  inputLocked = false;
  clearTimeout(inputUnlockTimer);
  inputUnlockTimer = null;
}

function lockInput() {
  inputLocked = true;
  clearTimeout(inputUnlockTimer);
  // Short lock — snappy roguelike feel; failsafe unsticks dropped packets
  inputUnlockTimer = setTimeout(() => {
    inputLocked = false;
    inputUnlockTimer = null;
    flushPendingKey();
  }, INPUT_LOCK_MS);
}

function flushPendingKey() {
  if (!pendingKey || inputLocked) return;
  const k = pendingKey;
  pendingKey = null;
  sendKey(k);
}

function sendKey(key) {
  if (!ws || ws.readyState !== 1) {
    toast("Not connected", true);
    return;
  }
  if (!$("overlay")?.classList.contains("hidden")) return;
  if (inputLocked) {
    pendingKey = key;
    return;
  }
  lockInput();
  ws.send(JSON.stringify({ type: "input", key, sessionId }));
  if (!isTyping()) focusGame();
}

function sendChat(text) {
  const t = text.trim();
  if (!t) return;
  if (!ws || ws.readyState !== 1) {
    toast("Not connected", true);
    return;
  }
  track("chat_send", { len: t.length, cmd: t.startsWith(":") });
  // Colon commands (:verify, :who, :dm, …) pass through; plain text is global chat
  const payload = t.startsWith(":") ? t : `:say ${t}`;
  ws.send(JSON.stringify({ type: "input", text: payload, sessionId }));
}

function handleGameKey(e) {
  if (!isGameActive()) return;

  // Esc leaves chat/social even when an input is focused
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (chatExpanded) { collapseChat(); return; }
    if (socialOpen) { closeSocial(); return; }
    if (isTyping()) {
      try { document.activeElement?.blur?.(); } catch { /* ignore */ }
      focusGame();
      return;
    }
    if (state?.player?.phase === "inventory") { sendKey("i"); return; }
    focusGame();
    return;
  }

  // Block browser scroll/page chrome for movement keys (not while typing chat)
  // Always use e.code (layout-independent) for arrows/WASD/hjkl/space
  if (!isTyping() && (SCROLL_BLOCK_CODES.has(e.code) || e.key === " " || e.key.startsWith("Arrow"))) {
    e.preventDefault();
    e.stopPropagation();
  }

  if (isTyping()) return;

  // Enter / / open chat — not when a dpad button has focus-steal
  if (e.key === "Enter" || e.key === "/" || e.code === "Slash") {
    // Shift+/ is "?" — handled below
    if (e.shiftKey && e.code === "Slash") {
      /* fall through to help */
    } else if (e.key === "Enter" || e.key === "/") {
      e.preventDefault();
      e.stopPropagation();
      expandChat(true);
      return;
    }
  }

  // ? help tip
  if (e.key === "?" || (e.shiftKey && (e.key === "/" || e.code === "Slash"))) {
    e.preventDefault();
    e.stopPropagation();
    toast("Move: arrows/WASD/hjkl · Fight: bump · Inv: i · Wait: . or Space · Descend: g · Chat: Enter");
    return;
  }

  const key = resolveGameKey(e);
  if (!key) return;
  e.preventDefault();
  e.stopPropagation();
  sendKey(key);
  // Keep canvas focused so arrows never scroll the page
  if (document.activeElement !== $("canvas") && !isTyping()) focusGame();
}

// --- Wire UI ---
$("join-btn")?.addEventListener("click", () => {
  const name = $("name-input").value.trim();
  if (!name) {
    toast("Enter a name", true);
    return;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    toast("Name: letters, numbers, _ - only", true);
    return;
  }
  playerName = name;
  // Do not set joined=true until the server returns a playable state. Setting it
  // early made Resume-denied failures sticky-reconnect forever.
  joined = false;
  resuming = false;
  try {
    $("name-input")?.blur();
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem("grokhack-name", name);
  } catch {
    /* private mode */
  }
  track("join_attempt", { name, ref: acquireRef || undefined, hasResume: !!getResumeToken(name) });
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({
      type: "join",
      name,
      sessionId,
      resumeToken: getResumeToken(name),
    }));
  } else connect();
});

$("name-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

// Remember last adventurer name
try {
  const saved = localStorage.getItem("grokhack-name");
  if (saved && $("name-input") && !$("name-input").value) {
    $("name-input").value = saved;
  }
} catch {
  /* ignore */
}

// Growth: attribute inbound share traffic (?ref=x from death tweets)
if (acquireRef) {
  track("acquire", { ref: acquireRef, path: location.pathname });
  startTelemetryFlush();
  flushTelemetry();
}

$("btn-chat")?.addEventListener("click", () => {
  if (chatExpanded) collapseChat();
  else expandChat(true);
});

$("chat-toggle")?.addEventListener("click", () => {
  if (chatExpanded) collapseChat();
  else expandChat(true);
});

$("btn-social")?.addEventListener("click", openSocial);
$("social-close")?.addEventListener("click", closeSocial);
$("drawer-backdrop")?.addEventListener("click", closeSocial);

document.querySelectorAll(".social-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".social-tabs .tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`)?.classList.add("active");
    if (tab.dataset.tab === "dms" && $("dm-target")?.value) {
      sendSocial("dm_thread", { target: $("dm-target").value });
    }
    if (tab.dataset.tab === "x") {
      refreshXLinkStatus(playerName || state?.player?.name);
    }
  });
});

async function showXLinkResult(targetEl, data) {
  if (!targetEl) return;
  targetEl.hidden = false;
  if (!data.ok) {
    targetEl.classList.add("err");
    targetEl.innerHTML = esc(data.message || data.error || "Failed");
    return;
  }
  targetEl.classList.remove("err");
  targetEl.innerHTML = [
    `Code for <strong>${esc(data.display || data.xHandle)}</strong> ↔ <strong>${esc(data.gameName)}</strong>:`,
    `<code class="verify-cmd">:verify ${esc(data.code)}</code>`,
    `Join as that character and type the command (expires 15 min).`,
  ].join("<br>");
}

$("x-link-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const handle = $("x-handle-input")?.value?.trim() || "";
  const name = playerName || state?.player?.name || $("name-input")?.value?.trim() || "";
  if (!handle) {
    toast("Enter your @handle", true);
    return;
  }
  if (!name) {
    toast("Join with a character name first", true);
    return;
  }
  const btn = $("x-link-btn");
  if (btn) btn.disabled = true;
  try {
    const data = await requestXLinkCode(handle, name);
    await showXLinkResult($("x-link-result"), data);
    if (data.ok) {
      toast(`Type :verify ${data.code} in chat`);
      track("x_link_code", { gameName: name });
    } else {
      toast(data.message || "Link failed", true);
    }
  } catch {
    toast("Network error", true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("join-x-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const handle = $("join-x-handle")?.value?.trim() || "";
  const name =
    $("join-x-name")?.value?.trim() || $("name-input")?.value?.trim() || "";
  if (!handle || !name) {
    toast("Need @handle and character name", true);
    return;
  }
  // Keep join name in sync
  if ($("name-input") && !$("name-input").value.trim()) {
    $("name-input").value = name;
  }
  try {
    const data = await requestXLinkCode(handle, name);
    await showXLinkResult($("join-x-result"), data);
    if (data.ok) {
      toast(`Then join as ${name} and type :verify ${data.code}`);
      track("x_link_code", { gameName: name, source: "join" });
    } else {
      toast(data.message || "Link failed", true);
    }
  } catch {
    toast("Network error", true);
  }
});

// Prefill join-x character from main name field
$("name-input")?.addEventListener("input", () => {
  const n = $("name-input")?.value?.trim();
  if (n && $("join-x-name") && !$("join-x-name").value) {
    $("join-x-name").value = n;
  }
});

$("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value;
  sendChat(text);
  $("chat-input").value = "";
  $("chat-input")?.focus();
});

$("chat-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    collapseChat();
  }
});

$("friend-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const target = $("friend-input").value.trim();
  if (!target) return;
  if (sendSocial("friend_add", { target })) toast(`Friend request sent to ${target}`);
  $("friend-input").value = "";
});

$("dm-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const target = $("dm-target").value.trim();
  const text = $("dm-text").value.trim();
  if (!target || !text) {
    toast("Need recipient and message", true);
    return;
  }
  if (sendSocial("dm_send", { target, text })) {
    appendDM(state?.player?.name || "you", target, text);
    $("dm-text").value = "";
    toast("DM sent");
  }
});

$("wall-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("wall-input").value.trim();
  if (!text) return;
  if (sendSocial("wall_post", { text })) {
    $("wall-input").value = "";
    toast("Posted to wall");
  }
});

document.querySelectorAll(".dpad-btn, .dpad-descend, .touch-action").forEach((btn) => {
  btn.setAttribute("tabindex", "-1");
  let armed = false;
  const fire = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!isGameActive()) return;
    const key = btn.dataset.key;
    if (!key) return;
    sendKey(key);
    focusGameSoon();
  };
  // pointerdown works for mouse + touch + pen; avoid 300ms click delay / double-fire
  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button != null && e.button !== 0) return;
      armed = true;
      fire(e);
    },
    { passive: false }
  );
  btn.addEventListener(
    "click",
    (e) => {
      if (armed) {
        armed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      fire(e);
    },
    { passive: false }
  );
  // Don't leave focus on the button (Space would re-trigger it)
  btn.addEventListener("focus", () => {
    if (isGameActive() && !isTyping()) focusGame();
  });
});

document.addEventListener("keydown", handleGameKey, { capture: true });
// Capture at window too — some browsers scroll before bubble to document
window.addEventListener(
  "keydown",
  (e) => {
    if (!isGameActive() || isTyping()) return;
    if (SCROLL_BLOCK_CODES.has(e.code) || e.key === " " || e.key.startsWith("Arrow")) {
      e.preventDefault();
    }
  },
  { passive: false, capture: true }
);

// Keep focus on canvas after clicks on game chrome (except form fields)
$("canvas")?.addEventListener("pointerdown", () => focusGame());
$("play-area")?.addEventListener("pointerdown", (e) => {
  if (e.target?.closest?.("input, textarea, a, .chat-dock")) return;
  // D-pad buttons handle their own fire + refocus
  if (e.target?.closest?.(".dpad-btn, .touch-action, .dpad-descend")) return;
  if (!isTyping()) focusGame();
});
$("game")?.addEventListener("click", (e) => {
  if (e.target?.closest?.("input, textarea, a, .chat-dock, .social-drawer")) return;
  if (e.target?.closest?.(".dpad-btn, .touch-action, .dpad-descend, button.pill")) return;
  if (!isTyping() && isGameActive()) focusGame();
});
// Reclaim focus if the tab comes back mid-run
window.addEventListener("focus", () => {
  if (isGameActive() && !isTyping() && !chatExpanded && !socialOpen) focusGame();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isGameActive() && !isTyping() && !chatExpanded && !socialOpen) {
    focusGameSoon();
  }
});
window.addEventListener("resize", () => {
  if (state?.player) render();
});
// Stop accidental page scroll from trackpad/wheel over the map
$("play-area")?.addEventListener(
  "wheel",
  (e) => {
    if (isGameActive() && !isTyping()) e.preventDefault();
  },
  { passive: false }
);

function refreshOnlineCount() {
  fetch("/api/status")
    .then((r) => r.json())
    .then((d) => { $("join-online").textContent = d.onlinePlayers ?? 0; })
    .catch(() => { $("join-online").textContent = "?"; });
}

track("page_load", { ua: navigator.userAgent?.slice(0, 120) });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushTelemetry();
});
window.addEventListener("pagehide", flushTelemetry);

refreshOnlineCount();
setInterval(refreshOnlineCount, 15_000);
connect();