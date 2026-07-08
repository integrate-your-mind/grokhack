const WS_URL = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws";
const TILE = 10;
const FOV = 8;
const COLORS = { "#": "#3a3a4a", ".": "#1a1a24", ">": "#c9a227", "<": "#6a8ac9" };
const MONSTER = { rat: "#8a6a4a", kobold: "#7a9a5a", goblin: "#5a8a4a", orc: "#c9a227", troll: "#4a6a5a", dragon: "#c94a4a" };

let ws = null;
let state = null;
let explored = [];

const $ = (id) => document.getElementById(id);

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "welcome") {
      $("join-online").textContent = msg.online;
    } else if (msg.type === "error") {
      $("join-err").textContent = msg.message;
    } else if (msg.type === "state") {
      state = msg;
      ensureExplored(msg.floor.width, msg.floor.height);
      revealFOV(msg);
      showGame();
      render();
    } else if (msg.type === "dead" || msg.type === "won") {
      showOverlay(msg.type === "won" ? "Victory!" : "You Died", "Refresh to play again.");
    }
  };
  ws.onclose = () => {
    $("join-err").textContent = "Disconnected from server.";
  };
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
  $("overlay-box").innerHTML = `<h2>${title}</h2><p>${body}</p><button onclick="location.reload()">Play Again</button>`;
}

function render() {
  if (!state) return;
  const { player, floor, others } = state;
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  const w = floor.width * TILE, h = floor.height * TILE;
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = "#050508";
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      if (!explored[y][x]) continue;
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

  for (const item of floor.items) {
    if (!inFov(player, item.x, item.y)) continue;
    drawChar(ctx, item.x, item.y, item.char, "#8a8a4a");
  }
  for (const m of floor.monsters) {
    if (!inFov(player, m.x, m.y)) continue;
    drawChar(ctx, m.x, m.y, m.char, MONSTER[m.kind] || "#fff");
  }
  for (const o of others) {
    if (!inFov(player, o.x, o.y)) continue;
    drawChar(ctx, o.x, o.y, o.glyph, "#6a8ac9");
  }
  drawChar(ctx, player.x, player.y, player.glyph, "#c9a227");

  $("header-status").textContent = `${player.name} · depth ${player.depth} · ${state.online ?? "?"} online`;
  $("hud").innerHTML = [
    `HP ${player.hp}/${player.maxHp}`,
    `Lv ${player.level}  XP ${player.xp}/${player.xpToLevel}`,
    `Hunger: ${player.hunger}`,
    `Gold ${player.gold}  Turns ${player.turns}`,
    `Inv: ${player.inventory.map(i => i.char).join(" ") || "empty"}`,
  ].join("<br>");
  $("log").innerHTML = (player.messages || []).slice(-8).map(m => `<div>${esc(m)}</div>`).join("");
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function sendKey(key) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "input", key }));
}

$("join-btn").onclick = () => {
  const name = $("name-input").value.trim();
  if (!name) return;
  ws.send(JSON.stringify({ type: "join", name }));
};

$("name-input").onkeydown = (e) => {
  if (e.key === "Enter") $("join-btn").click();
};

const KEYS = new Set([
  "h","j","k","l","y","u","b","n","i",".","s",">",
  "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
]);

document.addEventListener("keydown", (e) => {
  if ($("join-screen").classList.contains("hidden") === false) return;
  if (!KEYS.has(e.key)) return;
  e.preventDefault();
  const map = { ArrowUp:"k", ArrowDown:"j", ArrowLeft:"h", ArrowRight:"l" };
  sendKey(map[e.key] || e.key);
});

fetch("/api/status").then(r => r.json()).then(d => {
  $("join-online").textContent = d.onlinePlayers ?? 0;
}).catch(() => {});

connect();