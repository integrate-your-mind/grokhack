const WS_URL = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
const TILE = 10;
const FOV = 8;
const COLORS = { "#": "#3a3a4a", ".": "#1a1a24", ">": "#c9a227", "<": "#6a8ac9" };
const MONSTER = { rat: "#8a6a4a", kobold: "#7a9a5a", goblin: "#5a8a4a", orc: "#c9a227", troll: "#4a6a5a", dragon: "#c94a4a" };

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
      userAgent: navigator.userAgent,
    }),
  }).catch(() => {});
}

function sendSocial(action, fields = {}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "social", action, ...fields }));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  $("join-err").textContent = `Reconnecting in ${Math.round(delay / 1000)}s…`;
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
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    reconnectAttempt = 0;
    sessionId = sessionId || crypto.randomUUID();
    $("join-err").textContent = "";
    startPing();
    if (playerName) {
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
    }
  };
  ws.onerror = () => reportClientError("websocket error", "ws_error");
  ws.onclose = () => {
    inputLocked = false;
    clearInterval(pingTimer);
    if (joined) {
      $("log")?.insertAdjacentHTML("beforeend", `<div style="color:#c94a4a">Connection lost — reconnecting…</div>`);
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
    if (state?.player && $("header-status")) {
      $("header-status").textContent = $("header-status").textContent.replace(/· \d+ online/, `· ${n} online`);
    }
  } else if (msg.type === "error") {
    $("join-err").textContent = msg.message;
  } else if (msg.type === "social_snapshot") {
    social = msg.snapshot;
    if (msg.chat_history) {
      for (const line of msg.chat_history) {
        appendChat(line, "sys");
      }
    }
    renderSocial();
  } else if (msg.type === "social_result") {
    if (msg.result?.snapshot) social = msg.result.snapshot;
    else if (msg.action === "snapshot" && msg.result) social = msg.result;
    if (msg.action === "dm_thread" && msg.result?.thread) {
      dmLines.length = 0;
      for (const m of msg.result.thread) {
        appendDM(m.from, m.to, m.text, m.at);
      }
    }
    renderSocial();
  } else if (msg.type === "chat") {
    if (msg.channel === "dm") appendDM(msg.from, msg.to, msg.text, msg.at);
    else appendChat(`${msg.from}: ${msg.text}`, msg.channel === "global" ? "chat" : "sys");
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

function appendChat(text, kind = "chat") {
  chatLines.push({ text, kind });
  if (chatLines.length > 80) chatLines.shift();
  renderChatFeed();
}

function appendDM(from, to, text, at) {
  dmLines.push({ from, to, text, at });
  if (dmLines.length > 80) dmLines.shift();
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
  el.innerHTML = chatLines
    .map((l) => {
      const cls = l.kind === "sys" ? "line sys" : "line";
      return `<div class="${cls}">${esc(l.text)}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function renderDMFeed() {
  const el = $("dm-feed");
  if (!el) return;
  const me = state?.player?.name;
  el.innerHTML = dmLines
    .map((m) => {
      const arrow = m.from === me ? `→${m.to}` : `←${m.from}`;
      return `<div class="line dm"><span class="who">${esc(arrow)}</span> ${esc(m.text)}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function renderWallFeed() {
  const el = $("wall-feed");
  if (!el || !social) return;
  el.innerHTML = (social.wall || [])
    .map((p) => `<div class="line"><span class="who">${esc(p.author)}</span> ${esc(p.text)}</div>`)
    .join("") || '<div class="line sys">Wall is quiet.</div>';
}

function renderSocial() {
  renderWallFeed();
  const pending = $("pending-in");
  const list = $("friends-list");
  if (!pending || !list || !social) return;

  pending.innerHTML = (social.pendingIn || [])
    .map(
      (n) =>
        `${esc(n)} <button type="button" data-accept="${esc(n)}">accept</button>`
    )
    .join("<br>");

  pending.querySelectorAll("[data-accept]").forEach((btn) => {
    btn.onclick = () => sendSocial("friend_accept", { target: btn.dataset.accept });
  });

  list.innerHTML = (social.friends || [])
    .map(
      (n) =>
        `<li><span>${esc(n)}</span><button type="button" data-dm="${esc(n)}">dm</button></li>`
    )
    .join("") || '<li class="sys">No friends yet</li>';

  list.querySelectorAll("[data-dm]").forEach((btn) => {
    btn.onclick = () => {
      $("dm-target").value = btn.dataset.dm;
      document.querySelector('.tab[data-tab="dms"]').click();
      $("dm-text").focus();
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
}

function showOverlay(title, body) {
  $("overlay").classList.remove("hidden");
  $("overlay-box").innerHTML = `<h2>${esc(title)}</h2><p>${esc(body)}</p><button onclick="location.reload()">Play Again</button>`;
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

  const phaseLabel = player.phase === "inventory" ? " [INVENTORY — press 1-9 or i to close]" : "";
  $("header-status").textContent = `${player.name} · depth ${player.depth} · ${state.online ?? "?"} online${phaseLabel}`;
  $("hud").innerHTML = [
    `HP ${Math.max(0, player.hp)}/${player.maxHp}`,
    `Lv ${player.level}  XP ${player.xp ?? 0}/${player.xpToLevel ?? "?"}`,
    `Hunger: ${player.hunger}`,
    `Gold ${player.gold}  Turns ${player.turns}`,
    `Inv: ${(player.inventory || []).map((i) => i.char).join(" ") || "empty"}`,
  ].join("<br>");
  $("log").innerHTML = (player.messages || []).slice(-8).map((m) => `<div>${esc(m)}</div>`).join("");
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
  if (!ws || ws.readyState !== 1 || inputLocked) return;
  if ($("overlay") && !$("overlay").classList.contains("hidden")) return;
  inputLocked = true;
  ws.send(JSON.stringify({ type: "input", key, sessionId }));
}

function sendText(text) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "input", text, sessionId }));
}

$("join-btn").onclick = () => {
  const name = $("name-input").value.trim();
  if (!name) return;
  playerName = name;
  joined = true;
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: "join", name, sessionId }));
  } else {
    connect();
  }
};

$("name-input").onkeydown = (e) => {
  if (e.key === "Enter") $("join-btn").click();
};

document.querySelectorAll(".social-tabs .tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".social-tabs .tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "dms" && $("dm-target").value) {
      sendSocial("dm_thread", { target: $("dm-target").value });
    }
  };
});

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  sendText(`:say ${text}`);
  $("chat-input").value = "";
};

$("friend-form").onsubmit = (e) => {
  e.preventDefault();
  const target = $("friend-input").value.trim();
  if (!target) return;
  sendSocial("friend_add", { target });
  $("friend-input").value = "";
};

$("dm-form").onsubmit = (e) => {
  e.preventDefault();
  const target = $("dm-target").value.trim();
  const text = $("dm-text").value.trim();
  if (!target || !text) return;
  sendSocial("dm_send", { target, text });
  appendDM(state?.player?.name || "you", target, text, new Date().toISOString());
  $("dm-text").value = "";
};

$("wall-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("wall-input").value.trim();
  if (!text) return;
  sendSocial("wall_post", { text });
  $("wall-input").value = "";
};

const KEYS = new Set([
  "h","j","k","l","y","u","b","n","i",".","s",">",
  "0","1","2","3","4","5","6","7","8","9",
  "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
]);

document.addEventListener("keydown", (e) => {
  if ($("join-screen").classList.contains("hidden") === false) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (!KEYS.has(e.key)) return;
  e.preventDefault();
  const map = { ArrowUp:"k", ArrowDown:"j", ArrowLeft:"h", ArrowRight:"l" };
  sendKey(map[e.key] || e.key);
});

function refreshOnlineCount() {
  fetch("/api/status").then(r => r.json()).then(d => {
    $("join-online").textContent = d.onlinePlayers ?? 0;
  }).catch(() => {
    $("join-online").textContent = "?";
  });
}
refreshOnlineCount();
setInterval(refreshOnlineCount, 15_000);
connect();