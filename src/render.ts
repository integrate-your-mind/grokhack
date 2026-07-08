import type { GameState } from "./types";
import { getVisibleItems, getVisibleMonsters } from "./game";
import { itemDisplayName } from "./entities";

const TILE_SIZE = 10;
const COLORS: Record<string, string> = {
  "#": "#3a3a4a",
  ".": "#1a1a24",
  ">": "#c9a227",
  "<": "#6a8ac9",
  "@": "#c9a227",
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
  }

  render(state: GameState): void {
    const { dungeon, player, explored } = state;
    const w = dungeon.width * TILE_SIZE;
    const h = dungeon.height * TILE_SIZE;
    this.canvas.width = w;
    this.canvas.height = h;

    this.ctx.fillStyle = "#050508";
    this.ctx.fillRect(0, 0, w, h);

    for (let y = 0; y < dungeon.height; y++) {
      for (let x = 0; x < dungeon.width; x++) {
        const seen = explored[y][x];
        if (!seen) continue;

        const tile = dungeon.tiles[y][x];
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;

        const inFov =
          Math.abs(x - player.entity.x) <= 8 &&
          Math.abs(y - player.entity.y) <= 8 &&
          (x - player.entity.x) ** 2 + (y - player.entity.y) ** 2 <= 64;

        this.ctx.fillStyle = inFov ? (COLORS[tile] ?? "#1a1a24") : "#0d0d14";
        this.ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        if (inFov && tile !== ".") {
          this.ctx.fillStyle = COLORS[tile] ?? "#888";
          this.ctx.font = `${TILE_SIZE - 1}px "IBM Plex Mono", monospace`;
          this.ctx.textBaseline = "top";
          this.ctx.fillText(tile, px + 1, py);
        }
      }
    }

    for (const { item, x, y } of getVisibleItems(state)) {
      const inFov =
        (x - player.entity.x) ** 2 + (y - player.entity.y) ** 2 <= 64;
      if (!inFov) continue;
      this.drawChar(x, y, item.char, item.cursed ? "#8a4a8a" : "#8a8a4a");
    }

    for (const m of getVisibleMonsters(state)) {
      const inFov =
        (m.x - player.entity.x) ** 2 + (m.y - player.entity.y) ** 2 <= 64;
      if (!inFov) continue;
      this.drawChar(m.x, m.y, m.char, m.color);
    }

    this.drawChar(player.entity.x, player.entity.y, "@", player.entity.color);
  }

  private drawChar(x: number, y: number, char: string, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.font = `bold ${TILE_SIZE - 1}px "IBM Plex Mono", monospace`;
    this.ctx.textBaseline = "top";
    this.ctx.fillText(char, x * TILE_SIZE + 1, y * TILE_SIZE);
  }
}

export function renderHUD(state: GameState): void {
  const el = document.getElementById("hud");
  if (!el) return;
  const p = state.player;
  const e = p.entity;
  const hpPct = Math.max(0, (e.hp / e.maxHp) * 100);
  const hungerPct = Math.max(0, (p.hunger / p.maxHunger) * 100);
  const xpPct = Math.min(100, (p.xp / p.xpToLevel) * 100);

  el.innerHTML = `
    <div class="stat-row"><span>Depth</span><span>${p.depth}</span></div>
    <div class="stat-row"><span>Level</span><span>${p.level}</span></div>
    <div class="stat-row"><span>HP</span><span>${Math.max(0, e.hp)}/${e.maxHp}</span></div>
    <div class="bar"><div class="bar-fill hp-fill" style="width:${hpPct}%"></div></div>
    <div class="stat-row"><span>Hunger</span><span>${p.hungerState}</span></div>
    <div class="bar"><div class="bar-fill hunger-fill" style="width:${hungerPct}%"></div></div>
    <div class="stat-row"><span>XP</span><span>${p.xp}/${p.xpToLevel}</span></div>
    <div class="bar"><div class="bar-fill xp-fill" style="width:${xpPct}%"></div></div>
    <div class="stat-row"><span>ATK</span><span>${e.attack + (p.equippedWeapon?.power ?? 0)}</span></div>
    <div class="stat-row"><span>DEF</span><span>${e.defense + (p.equippedArmor?.power ?? 0)}</span></div>
    <div class="stat-row"><span>Gold</span><span>${p.gold}</span></div>
    <div class="stat-row"><span>Turns</span><span>${p.turns}</span></div>
  `;
}

export function renderInventory(state: GameState): void {
  const el = document.getElementById("inventory");
  if (!el) return;
  const p = state.player;

  if (state.phase !== "inventory") {
    const lines = p.inventory.map((item, i) => {
      const eq =
        item === p.equippedWeapon || item === p.equippedArmor ? " (worn)" : "";
      return `<div class="item">${item.char} ${itemDisplayName(item)}${eq}</div>`;
    });
    el.innerHTML = lines.length ? lines.join("") : "<span>empty</span>";
    return;
  }

  const lines = p.inventory.map((item, i) => {
    const eq =
      item === p.equippedWeapon || item === p.equippedArmor ? " equipped" : "";
    return `<div class="item${eq}">${i + 1}. ${item.char} ${itemDisplayName(item)}</div>`;
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
  el.innerHTML = recent
    .map((m, i) => {
      const cls = i >= recent.length - 3 ? "msg recent" : "msg";
      return `<div class="${cls}">${escapeHtml(m)}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function showOverlay(title: string, body: string, onRestart?: () => void): void {
  const overlay = document.getElementById("overlay");
  const content = document.getElementById("overlay-content");
  if (!overlay || !content) return;

  content.innerHTML = `
    <div class="tombstone">${title.includes("Victory") ? "🏆" : "☠"}</div>
    <h2>${escapeHtml(title)}</h2>
    <p>${body}</p>
    <button id="restart-btn">Play Again</button>
  `;
  overlay.classList.remove("hidden");

  document.getElementById("restart-btn")?.addEventListener("click", () => {
    overlay.classList.add("hidden");
    onRestart?.();
  });
}

export function hideOverlay(): void {
  document.getElementById("overlay")?.classList.add("hidden");
}