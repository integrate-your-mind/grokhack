const WS_URL = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
const TILE = 10;
const FOV = 8;
const COLORS = { "#": "#3a3a4a", ".": "#1a1a24", ">": "#c9a227", "<": "#6a8ac9" };
const MONSTER = { rat: "#8a6a4a", kobold: "#7a9a5a", goblin: "#5a8a4a", orc: "#c9a227", troll: "#4a6a5a", dragon: "#c94a4a" };
const MOVE_KEYS = new Set([
  "h","j","k","l","y","u","b","n","i",".","s",">",
  "0","1","2","3","4","5","6","7","8","9",
  "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
]);

let ws = null;
let state = null;
let explored = [];
let sessionId = null;
let inputLocked = false;
let joined = false;
let playerName = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingTimer = null;
let social = null;
let chatExpanded = false;
let chatUnread = 0;
let socialOpen = false;
const chatLines = [];
const dmLines = [];

const $ = (id) => document.getElementById(id);

function reportClientError(err, context) {
  fetch("/api/audit/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: String(err?.message || err),
      context,
      url: location.href,
    }),
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

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

function isGameActive() {
  return joined && $("join-screen").classList.contains("hidden") && $("overlay").classList.contains("hidden");
}

function focusGame() {
  $("canvas")?.focus({ preventScroll: true });
}

function expandChat(focusInput = true) {
  chatExpanded = true;
  $("chat-dock")?.classList.remove("collapsed");
  $("btn-chat")?.classList.add("active");
  chatUnread = 0;
  updateChatBadge();
  if (focusInput) $("chat-input")?.focus();
}

function collapseChat() {
  chatExpanded = false;
  $("chat-dock")?.classList.add("collapsed");
  $("btn-chat")?.classList.remove("active");
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
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  const errEl = $("join-err");
  if (errEl && !joined) errEl.textContent = `Reconnecting in ${Math.round(delay / 1000)}s…`;
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
    setConnStatus("ok");
    sessionId = sessionId || crypto.randomUUID();
    $("join-err").textContent = "";
    startPing();
    if (playerName && joined) {
      ws.send(JSON.stringify({ type: "join", name: playerName, sessionId }));
    }
  };
  ws.onmessage = (e) => {
    inputLocked = false;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      reportClientError(err, "ws_parse");
      return;
    }
    try {
      handleMessage(msg);
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
    inputLocked = false;
    clearInterval(pingTimer);
    setConnStatus("bad");
    if (joined) {
      toast("Connection lost — reconnecting…", true);
      scheduleReconnect();
    } else {
      $("join-err").textContent = "Server unreachable — retrying…";
      scheduleReconnect();
    }
  };
}

function handleMessage(msg) {
  if (msg.type === "welcome") {
    $("join-online").textContent = msg.online ?? 0;
    if (msg.sessionId) sessionId = msg.sessionId;
  } else if (msg.type === "presence" || msg.type === "pong") {
    const n = msg.online ?? msg.players?.length ?? 0;
    $("join-online").textContent = n;
    if (state) state.online = n;
    updateHeader();
  } else if (msg.type === "error") {
    $("join-err").textContent = msg.message;
    toast(msg.message, true);
  } else if (msg.type === "social_snapshot") {
    social = msg.snapshot;
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
    if (state.player.phase === "dead") {
      showOverlay("You Died", (state.player.messages || []).slice(-1)[0] || "Game over.");
      return;
    }
    if (state.player.phase === "won") {
      showOverlay("Victory!", "You conquered the dungeon!");
      return;
    }
    ensureExplored(state.floor.width, state.floor.height);
    revealFOV(state);
    showGame();
    render();
  } else if (msg.type === "dead" || msg.type === "won") {
    showOverlay(msg.type === "won" ? "Victory!" : "You Died", "Refresh to play again.");
  }
}

function appendChat(text, kind = "chat", bumpUnread = true) {
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
  focusGame();
}

function showOverlay(title, body) {
  $("overlay").classList.remove("hidden");
  $("overlay-box").innerHTML = `<h2>${esc(title)}</h2><p>${esc(body)}</p><button type="button" onclick="location.reload()">Play Again</button>`;
}

function updateHeader() {
  if (!state?.player) return;
  const p = state.player;
  const phase = p.phase === "inventory" ? " · INVENTORY (i or 1-9)" : "";
  $("header-status").textContent = `${p.name} · d${p.depth} · Lv${p.level} · ${state.online ?? "?"} online${phase}`;
}

function render() {
  if (!state?.player || !state?.floor) return;
  const { player, floor, others = [] } = state;
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  const w = floor.width * TILE, h = floor.height * TILE;
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = "#050508";
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (!explored[y]?.[x]) continue;
      const vis = (x - player.x) ** 2 + (y - player.y) ** 2 <= FOV * FOV;
      const tile = floor.tiles[y][x];
      ctx.fillStyle = vis ? (COLORS[tile] || "#1a1a24") : "#0d0d14";
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if (vis && tile !== ".") {
        ctx.fillStyle = COLORS[tile] || "#888";
        ctx.font = `${TILE - 1}px monospace`;
        ctx.fillText(tile, x * TILE + 1, y * TILE + TILE - 2);
      }
    }
  }

  for (const item of floor.items || []) {
    if (!inFov(player, item.x, item.y)) continue;
    drawChar(ctx, item.x, item.y, item.char, "#8a8a4a");
  }
  for (const m of floor.monsters || []) {
    if (!inFov(player, m.x, m.y)) continue;
    drawChar(ctx, m.x, m.y, m.char, MONSTER[m.kind] || "#fff");
  }
  for (const o of others) {
    if (!inFov(player, o.x, o.y)) continue;
    drawChar(ctx, o.x, o.y, o.glyph, "#6a8ac9");
  }
  drawChar(ctx, player.x, player.y, player.glyph, "#c9a227");

  updateHeader();

  const hud = $("hud");
  const hungry = player.hunger === "hungry" || player.hunger === "weak" || player.hunger === "fainting";
  const lowHp = player.hp < player.maxHp * 0.35;
  hud.innerHTML = [
    `<span class="${lowHp ? "warn" : ""}">HP ${Math.max(0, player.hp)}/${player.maxHp}</span>`,
    `<span>Lv ${player.level}</span>`,
    `<span>XP ${player.xp ?? 0}/${player.xpToLevel ?? "?"}</span>`,
    `<span class="${hungry ? "warn" : ""}">${player.hunger}</span>`,
    `<span>Au ${player.gold}</span>`,
    `<span>T ${player.turns}</span>`,
    `<span>Inv ${(player.inventory || []).map((i) => i.char).join("") || "—"}</span>`,
  ].join("");

  $("log").innerHTML = (player.messages || []).slice(-4).map((m) => `<div>${esc(m)}</div>`).join("") || "<div>—</div>";
}

function inFov(player, x, y) {
  return (x - player.x) ** 2 + (y - player.y) ** 2 <= FOV * FOV;
}

function drawChar(ctx, x, y, ch, color) {
  ctx.fillStyle = color;
  ctx.font = `bold ${TILE - 1}px monospace`;
  ctx.fillText(ch, x * TILE + 1, y * TILE + TILE - 2);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function sendKey(key) {
  if (!ws || ws.readyState !== 1) {
    toast("Not connected", true);
    return;
  }
  if (inputLocked) return;
  if (!$("overlay").classList.contains("hidden")) return;
  inputLocked = true;
  ws.send(JSON.stringify({ type: "input", key, sessionId }));
}

function sendChat(text) {
  if (!text.trim()) return;
  if (!ws || ws.readyState !== 1) {
    toast("Not connected", true);
    return;
  }
  ws.send(JSON.stringify({ type: "input", text: `:say ${text.trim()}`, sessionId }));
  appendChat(`You: ${text.trim()}`, "me", false);
}

function handleGameKey(e) {
  if (!isGameActive()) return;
  if (isTyping()) return;

  if (e.key === "Enter" || e.key === "/") {
    e.preventDefault();
    expandChat(true);
    return;
  }

  if (e.key === "Escape") {
    if (chatExpanded) {
      e.preventDefault();
      collapseChat();
      return;
    }
    if (socialOpen) {
      e.preventDefault();
      closeSocial();
      return;
    }
    return;
  }

  if (!MOVE_KEYS.has(e.key)) return;
  e.preventDefault();
  const map = { ArrowUp: "k", ArrowDown: "j", ArrowLeft: "h", ArrowRight: "l" };
  sendKey(map[e.key] || e.key);
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
  joined = true;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "join", name, sessionId }));
  else connect();
});

$("name-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join-btn").click();
});

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
  });
});

$("chat-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value;
  sendChat(text);
  $("chat-input").value = "";
  collapseChat();
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

document.querySelectorAll(".dpad-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isTyping()) return;
    sendKey(btn.dataset.key);
  });
});

document.addEventListener("keydown", handleGameKey);

function refreshOnlineCount() {
  fetch("/api/status")
    .then((r) => r.json())
    .then((d) => { $("join-online").textContent = d.onlinePlayers ?? 0; })
    .catch(() => { $("join-online").textContent = "?"; });
}

refreshOnlineCount();
setInterval(refreshOnlineCount, 15_000);
connect();