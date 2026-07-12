import type { GameState, HungerState } from "./types";
import { getVisibleItems, getVisibleMonsters } from "./game";
import { itemDisplayName } from "./entities";

/** Readable tile size (px). MMO uses 12; SP prefers slightly larger glyphs. */
const MIN_TILE = 12;
const MAX_TILE = 18;
/** Camera viewport in tiles — tracks the player. */
const VIEW_W = 52;
const VIEW_H = 24;

const COLORS: Record<string, string> = {
  "#": "#3a3a4a",
  ".": "#1a1a24",
  ">": "#c9a227",
  "<": "#6a8ac9",
  "+": "#8a6a3a",
  "@": "#c9a227",
};

const HUNGER_WARN: HungerState[] = ["hungry", "weak", "fainting", "starving"];

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private tile = MIN_TILE;
  private cam = { ox: 0, oy: 0, vw: VIEW_W, vh: VIEW_H };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
  }

  /** Recompute tile size from the dungeon panel width (responsive). */
  private fitTile(dungeonW: number, dungeonH: number): number {
    const panel = this.canvas.parentElement;
    const maxW = panel?.clientWidth || this.canvas.clientWidth || 800;
    const maxH = Math.max(280, Math.min(window.innerHeight * 0.55, 520));
    const vw = Math.min(VIEW_W, dungeonW);
    const vh = Math.min(VIEW_H, dungeonH);
    const byW = Math.floor(maxW / vw);
    const byH = Math.floor(maxH / vh);
    return Math.max(MIN_TILE, Math.min(MAX_TILE, Math.min(byW, byH) || MIN_TILE));
  }

  private updateCamera(state: GameState): void {
    const { dungeon, player } = state;
    const vw = Math.min(VIEW_W, dungeon.width);
    const vh = Math.min(VIEW_H, dungeon.height);
    let ox = player.entity.x - Math.floor(vw / 2);
    let oy = player.entity.y - Math.floor(vh / 2);
    ox = Math.max(0, Math.min(ox, dungeon.width - vw));
    oy = Math.max(0, Math.min(oy, dungeon.height - vh));
    this.cam = { ox, oy, vw, vh };
  }

  render(state: GameState): void {
    const { dungeon, player, explored } = state;
    this.tile = this.fitTile(dungeon.width, dungeon.height);
    this.updateCamera(state);

    const { ox, oy, vw, vh } = this.cam;
    const tile = this.tile;
    const w = vw * tile;
    const h = vh * tile;
    this.canvas.width = w;
    this.canvas.height = h;

    this.ctx.fillStyle = "#050508";
    this.ctx.fillRect(0, 0, w, h);

    for (let y = oy; y < oy + vh; y++) {
      for (let x = ox; x < ox + vw; x++) {
        const seen = explored[y]?.[x];
        if (!seen) continue;

        const t = dungeon.tiles[y][x];
        const sx = (x - ox) * tile;
        const sy = (y - oy) * tile;

        const inFov = inFovOf(player.entity.x, player.entity.y, x, y);

        this.ctx.fillStyle = inFov ? (COLORS[t] ?? "#1a1a24") : "#0d0d14";
        this.ctx.fillRect(sx, sy, tile, tile);

        if (inFov && t !== ".") {
          this.ctx.fillStyle = COLORS[t] ?? "#888";
          this.ctx.font = `${tile - 2}px "IBM Plex Mono", monospace`;
          this.ctx.textBaseline = "alphabetic";
          this.ctx.fillText(t, sx + 2, sy + tile - 3);
        } else if (!inFov && t !== ".") {
          // Dim remembered structure
          this.ctx.fillStyle = "#2a2a38";
          this.ctx.font = `${tile - 2}px "IBM Plex Mono", monospace`;
          this.ctx.textBaseline = "alphabetic";
          this.ctx.fillText(t, sx + 2, sy + tile - 3);
        }
      }
    }

    for (const { item, x, y } of getVisibleItems(state)) {
      if (!inCam(this.cam, x, y)) continue;
      if (!inFovOf(player.entity.x, player.entity.y, x, y)) continue;
      this.drawChar(x, y, item.char, item.cursed ? "#8a4a8a" : "#8a8a4a");
    }

    for (const m of getVisibleMonsters(state)) {
      if (!inCam(this.cam, m.x, m.y)) continue;
      if (!inFovOf(player.entity.x, player.entity.y, m.x, m.y)) continue;
      // HP bar for hostiles
      const ratio = Math.max(0, m.hp / m.maxHp);
      const px = (m.x - ox) * tile + 1;
      const py = (m.y - oy) * tile;
      this.ctx.fillStyle = "#2a1a1a";
      this.ctx.fillRect(px, py, tile - 2, 2);
      this.ctx.fillStyle = ratio > 0.5 ? "#4ac97a" : ratio > 0.25 ? "#c9a227" : "#c94a4a";
      this.ctx.fillRect(px, py, Math.max(1, (tile - 2) * ratio), 2);
      this.drawChar(m.x, m.y, m.char, m.color);
    }

    // Player highlight + glyph
    const px = (player.entity.x - ox) * tile;
    const py = (player.entity.y - oy) * tile;
    this.ctx.fillStyle = "rgba(201,162,39,0.18)";
    this.ctx.fillRect(px, py, tile, tile);
    this.drawChar(player.entity.x, player.entity.y, "@", player.entity.color);
  }

  private drawChar(x: number, y: number, char: string, color: string): void {
    const tile = this.tile;
    const sx = (x - this.cam.ox) * tile;
    const sy = (y - this.cam.oy) * tile;
    this.ctx.fillStyle = color;
    this.ctx.font = `bold ${tile - 2}px "IBM Plex Mono", monospace`;
    this.ctx.textBaseline = "alphabetic";
    this.ctx.fillText(char, sx + 2, sy + tile - 3);
  }
}

function inFovOf(px: number, py: number, x: number, y: number): boolean {
  return (x - px) ** 2 + (y - py) ** 2 <= 64;
}

function inCam(
  cam: { ox: number; oy: number; vw: number; vh: number },
  x: number,
  y: number
): boolean {
  return x >= cam.ox && y >= cam.oy && x < cam.ox + cam.vw && y < cam.oy + cam.vh;
}

/** Color-code combat / discovery / danger lines (parity with MMO client). */
export function msgClass(m: string): string {
  const s = String(m);
  if (/CRITICAL|slain|die|dead|poison|starv|incinerat|killed|curse/i.test(s))
    return "msg msg-danger";
  if (/kill|ascend|Victory|conquer|gold|restored|strength|better|recognize|heal|level up|gain/i.test(s))
    return "msg msg-good";
  if (
    /spot a staircase|stairs leading|descend|vault|shrine|roar|hear|sense|growl|footsteps|shadows|Welcome|damp stone|lair/i.test(
      s
    )
  )
    return "msg msg-discover";
  if (/miss|dodge|whistles|bump|nothing happens/i.test(s)) return "msg msg-miss";
  return "msg";
}

export function renderHUD(state: GameState): void {
  const el = document.getElementById("hud");
  if (!el) return;
  const p = state.player;
  const e = p.entity;
  const hpPct = Math.max(0, (e.hp / e.maxHp) * 100);
  const hungerPct = Math.max(0, (p.hunger / p.maxHunger) * 100);
  const xpPct = Math.min(100, (p.xp / p.xpToLevel) * 100);
  const lowHp = e.hp < e.maxHp * 0.35;
  const hungry = HUNGER_WARN.includes(p.hungerState);
  const atk = e.attack + (p.equippedWeapon?.power ?? 0);
  const def = e.defense + (p.equippedArmor?.power ?? 0);
  const wpn = p.equippedWeapon ? itemDisplayName(p.equippedWeapon) : "—";
  const arm = p.equippedArmor ? itemDisplayName(p.equippedArmor) : "—";
  const ring = p.equippedRing ? itemDisplayName(p.equippedRing) : null;

  // Nearby threats (Manhattan 1, in FOV)
  const nearby = state.monsters.filter(
    (m) =>
      Math.abs(m.x - e.x) + Math.abs(m.y - e.y) === 1 &&
      inFovOf(e.x, e.y, m.x, m.y)
  );
  const threat =
    nearby.length > 0
      ? `<div class="stat-row threat"><span>Threat</span><span>${escapeHtml(
          nearby.map((m) => m.name).join(", ")
        )}</span></div>`
      : "";

  const onStairs =
    dungeonAt(state, e.x, e.y) === ">" || dungeonAt(state, e.x, e.y) === "<";
  const stairsHint = onStairs
    ? `<div class="stat-row stairs-hint"><span>Stairs</span><span>press &gt; / g</span></div>`
    : "";

  el.innerHTML = `
    <div class="stat-row"><span>Depth</span><span>${p.depth}</span></div>
    <div class="stat-row"><span>Level</span><span>${p.level}</span></div>
    <div class="stat-row ${lowHp ? "warn" : ""}"><span>HP</span><span>${Math.max(0, e.hp)}/${e.maxHp}</span></div>
    <div class="bar"><div class="bar-fill hp-fill ${lowHp ? "low" : ""}" style="width:${hpPct}%"></div></div>
    <div class="stat-row ${hungry ? "warn" : ""}"><span>Hunger</span><span>${p.hungerState}</span></div>
    <div class="bar"><div class="bar-fill hunger-fill ${hungry ? "low" : ""}" style="width:${hungerPct}%"></div></div>
    ${
      p.statuses?.some((s) => s.kind === "poison")
        ? `<div class="stat-row warn"><span>Status</span><span>poisoned</span></div>`
        : ""
    }
    <div class="stat-row"><span>XP</span><span>${p.xp}/${p.xpToLevel}</span></div>
    <div class="bar"><div class="bar-fill xp-fill" style="width:${xpPct}%"></div></div>
    <div class="stat-row gear"><span title="weapon">⚔</span><span class="gear-name" title="${escapeHtml(wpn)}">${escapeHtml(wpn)}</span></div>
    <div class="stat-row gear"><span title="armor">🛡</span><span class="gear-name" title="${escapeHtml(arm)}">${escapeHtml(arm)}</span></div>
    ${
      ring
        ? `<div class="stat-row gear"><span title="ring">💍</span><span class="gear-name" title="${escapeHtml(ring)}">${escapeHtml(ring)}</span></div>`
        : ""
    }
    <div class="stat-row"><span>ATK / DEF</span><span>${atk} / ${def}</span></div>
    <div class="stat-row"><span>Gold</span><span>${p.gold}</span></div>
    <div class="stat-row"><span>Turns</span><span>${p.turns}</span></div>
    ${threat}
    ${stairsHint}
  `;
}

function dungeonAt(state: GameState, x: number, y: number): string {
  return state.dungeon.tiles[y]?.[x] ?? "";
}

export function renderInventory(state: GameState): void {
  const el = document.getElementById("inventory");
  if (!el) return;
  const p = state.player;

  if (state.phase !== "inventory") {
    const lines = p.inventory.map((item) => {
      const eq =
        item === p.equippedWeapon ||
        item === p.equippedArmor ||
        item === p.equippedRing
          ? " (worn)"
          : "";
      return `<div class="item">${escapeHtml(item.char)} ${escapeHtml(itemDisplayName(item))}${eq}</div>`;
    });
    el.innerHTML = lines.length ? lines.join("") : "<span>empty</span>";
    return;
  }

  const lines = p.inventory.map((item, i) => {
    const eq =
      item === p.equippedWeapon ||
      item === p.equippedArmor ||
      item === p.equippedRing
        ? " equipped"
        : "";
    return `<div class="item${eq}">${i + 1}. ${escapeHtml(item.char)} ${escapeHtml(itemDisplayName(item))}</div>`;
  });
  el.innerHTML = `
    <div style="color:var(--accent);margin-bottom:0.5rem">Select item (1-9, 0=10):</div>
    ${lines.length ? lines.join("") : "<span>empty</span>"}
  `;
}

export function renderMessages(state: GameState): void {
  const el = document.getElementById("message-log");
  if (!el) return;
  const recent = state.messages.slice(-12);
  const last = recent[recent.length - 1] || "";
  const prevLast = el.dataset.last || "";

  el.innerHTML = recent
    .map((m, i, arr) => {
      const flash =
        m === last && m !== prevLast && i === arr.length - 1 ? " msg-flash" : "";
      const recentCls = i >= arr.length - 3 ? " recent" : "";
      return `<div class="${msgClass(m)}${recentCls}${flash}">${escapeHtml(m)}</div>`;
    })
    .join("");
  el.dataset.last = last;
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rich death/victory overlay with last messages + gear (display-only). */
export function showEndOverlay(
  state: GameState,
  outcome: "dead" | "won",
  onRestart?: () => void
): void {
  const overlay = document.getElementById("overlay");
  const content = document.getElementById("overlay-content");
  if (!overlay || !content) return;

  const p = state.player;
  const won = outcome === "won";
  const title = won ? "Victory!" : "You Died";
  const detail = won
    ? "You have conquered the depths!"
    : p.deathCause || state.messages.at(-1) || "The dungeon claims another soul.";
  const stats = `Depth ${p.depth} · Lv${p.level} · ${p.gold} gold · ${p.turns} turns`;
  const gear = [
    p.equippedWeapon ? `⚔ ${itemDisplayName(p.equippedWeapon)}` : null,
    p.equippedArmor ? `🛡 ${itemDisplayName(p.equippedArmor)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lastLog = state.messages
    .slice(-4)
    .map((m) => `<div class="end-log-line">${escapeHtml(m)}</div>`)
    .join("");

  content.classList.toggle("dead", !won);
  content.classList.toggle("won", won);
  content.innerHTML = `
    <div class="tombstone">${won ? "🏆" : "☠"}</div>
    <h2>${escapeHtml(title)}</h2>
    <p class="end-detail">${escapeHtml(detail)}</p>
    <p class="end-stats">${escapeHtml(stats)}</p>
    ${gear ? `<p class="end-gear">${escapeHtml(gear)}</p>` : ""}
    <p class="end-seed">Seed: ${state.seed}</p>
    ${lastLog ? `<div class="end-log">${lastLog}</div>` : ""}
    <button type="button" id="restart-btn">Play Again</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("restart-btn")?.addEventListener("click", () => {
    overlay.classList.add("hidden");
    content.classList.remove("dead", "won");
    onRestart?.();
  });
}

/** @deprecated prefer showEndOverlay — kept for callers that only need a simple box */
export function showOverlay(title: string, body: string, onRestart?: () => void): void {
  const overlay = document.getElementById("overlay");
  const content = document.getElementById("overlay-content");
  if (!overlay || !content) return;

  content.classList.remove("dead", "won");
  content.innerHTML = `
    <div class="tombstone">${title.includes("Victory") ? "🏆" : "☠"}</div>
    <h2>${escapeHtml(title)}</h2>
    <p>${body}</p>
    <button type="button" id="restart-btn">Play Again</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("restart-btn")?.addEventListener("click", () => {
    overlay.classList.add("hidden");
    onRestart?.();
  });
}

export function hideOverlay(): void {
  const overlay = document.getElementById("overlay");
  const content = document.getElementById("overlay-content");
  overlay?.classList.add("hidden");
  content?.classList.remove("dead", "won");
}

export function toggleHelp(force?: boolean): void {
  const help = document.getElementById("help-panel");
  if (!help) return;
  const show = force ?? help.classList.contains("hidden");
  help.classList.toggle("hidden", !show);
}

export function hideHelp(): void {
  document.getElementById("help-panel")?.classList.add("hidden");
}

export function isHelpOpen(): boolean {
  const help = document.getElementById("help-panel");
  return !!help && !help.classList.contains("hidden");
}
