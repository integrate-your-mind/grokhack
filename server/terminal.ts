import type { Dungeon, Entity, PlayerState } from "../src/types.js";
import type { FloorState, GroundItem, OnlinePlayer } from "./types.js";

const FOV_RADIUS = 8;

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgBlack: "\x1b[40m",
  clear: "\x1b[2J\x1b[H",
};

const TILE_COLOR: Record<string, string> = {
  "#": ANSI.gray,
  ".": ANSI.dim,
  ">": ANSI.yellow,
  "<": ANSI.cyan,
};

const MONSTER_COLOR: Record<string, string> = {
  rat: ANSI.gray,
  kobold: ANSI.green,
  goblin: ANSI.green,
  orc: ANSI.yellow,
  troll: ANSI.cyan,
  dragon: ANSI.red,
};

function inFov(px: number, py: number, x: number, y: number): boolean {
  return (x - px) ** 2 + (y - py) ** 2 <= FOV_RADIUS ** FOV_RADIUS;
}

function colorForEntity(e: Entity): string {
  if (e.isPlayer) return ANSI.yellow;
  if (e.kind && MONSTER_COLOR[e.kind]) return MONSTER_COLOR[e.kind];
  return ANSI.white;
}

export function renderTerminalView(
  viewer: OnlinePlayer,
  floor: FloorState,
  others: OnlinePlayer[]
): string {
  const { dungeon } = floor;
  const px = viewer.state.entity.x;
  const py = viewer.state.entity.y;
  const vw = Math.min(78, dungeon.width);
  const vh = 20;
  const ox = Math.max(0, Math.min(px - Math.floor(vw / 2), dungeon.width - vw));
  const oy = Math.max(0, Math.min(py - Math.floor(vh / 2), dungeon.height - vh));

  const lines: string[] = [];
  lines.push(
    `${ANSI.bold}${ANSI.yellow}GrokHack MMO${ANSI.reset} ` +
      `${ANSI.dim}depth ${viewer.floorDepth} | ${viewer.name} (${viewer.glyph}) | online: ${others.length + 1}${ANSI.reset}`
  );
  lines.push(ANSI.gray + "─".repeat(vw) + ANSI.reset);

  for (let row = 0; row < vh; row++) {
    const y = oy + row;
    let line = "";
    for (let col = 0; col < vw; col++) {
      const x = ox + col;
      if (y < 0 || y >= dungeon.height || x < 0 || x >= dungeon.width) {
        line += " ";
        continue;
      }

      const seen = viewer.explored[y][x];
      const visible = seen && inFov(px, py, x, y);

      let ch = " ";
      let color = ANSI.dim;

      const other = others.find(
        (p) =>
          p.id !== viewer.id &&
          p.state.alive &&
          p.state.entity.x === x &&
          p.state.entity.y === y
      );
      const monster = floor.monsters.find((m) => m.hp > 0 && m.x === x && m.y === y);
      const ground = floor.items.find((i) => i.x === x && i.y === y);

      if (x === px && y === py) {
        ch = viewer.glyph;
        color = ANSI.bold + ANSI.yellow;
      } else if (other && visible) {
        ch = other.glyph;
        color = ANSI.cyan;
      } else if (monster && visible) {
        ch = monster.char;
        color = colorForEntity(monster);
      } else if (ground && visible) {
        ch = ground.item.char;
        color = ANSI.magenta;
      } else if (visible) {
        ch = dungeon.tiles[y][x];
        color = TILE_COLOR[ch] ?? ANSI.dim;
      } else if (seen) {
        ch = dungeon.tiles[y][x] === "#" ? "#" : ".";
        color = ANSI.gray;
      }

      line += color + ch + ANSI.reset;
    }
    lines.push(line);
  }

  lines.push(ANSI.gray + "─".repeat(vw) + ANSI.reset);
  lines.push(renderStatus(viewer.state));
  lines.push(ANSI.dim + "hjkl move | i inv | . wait | > descend | :say chat | who | Q quit" + ANSI.reset);

  const recent = viewer.messages.slice(-4);
  for (const msg of recent) {
    lines.push(ANSI.dim + "> " + msg + ANSI.reset);
  }

  return ANSI.clear + lines.join("\r\n") + "\r\n";
}

function renderStatus(p: PlayerState): string {
  const e = p.entity;
  const hpBar = bar(e.hp, e.maxHp, 12);
  const foodBar = bar(p.hunger, p.maxHunger, 8);
  return (
    `${ANSI.bold}HP${ANSI.reset}${hpBar} ${Math.max(0, e.hp)}/${e.maxHp}  ` +
    `${ANSI.bold}Lv${ANSI.reset}${p.level}  ` +
    `${ANSI.bold}Food${ANSI.reset}${foodBar} ${p.hungerState}  ` +
    `${ANSI.bold}XP${ANSI.reset}${p.xp}/${p.xpToLevel}  ` +
    `${ANSI.bold}Au${ANSI.reset}${p.gold}  ` +
    `${ANSI.bold}T${ANSI.reset}${p.turns}`
  );
}

function bar(cur: number, max: number, width: number): string {
  const filled = Math.round((Math.max(0, cur) / max) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function renderWelcome(online: number, maxPlayers: number): string {
  return (
    ANSI.clear +
    `${ANSI.bold}${ANSI.yellow}╔══════════════════════════════════════╗\r\n` +
    `║         G R O K H A C K   M M O      ║\r\n` +
    `╚══════════════════════════════════════╝${ANSI.reset}\r\n\r\n` +
    `${ANSI.cyan}A massively multiplayer roguelike.${ANSI.reset}\r\n` +
    `Connect via telnet. Explore shared dungeon floors.\r\n` +
    `Slay monsters. Descend. Don't starve.\r\n\r\n` +
    `${ANSI.dim}Players online: ${online}/${maxPlayers}${ANSI.reset}\r\n\r\n` +
    `Enter thy name, adventurer: `
  );
}

export function renderDeath(player: OnlinePlayer): string {
  return (
    ANSI.clear +
    `${ANSI.red}${ANSI.bold}☠  YOU DIED  ☠${ANSI.reset}\r\n\r\n` +
    `${player.name} perished on depth ${player.floorDepth}.\r\n` +
    `Level ${player.state.level} | Gold ${player.state.gold} | Turns ${player.state.turns}\r\n\r\n` +
    `Reconnect to start anew.\r\n`
  );
}

export function renderVictory(player: OnlinePlayer): string {
  return (
    ANSI.clear +
    `${ANSI.yellow}${ANSI.bold}★ VICTORY ★${ANSI.reset}\r\n\r\n` +
    `${player.name} conquered the dungeon!\r\n` +
    `Level ${player.state.level} | Gold ${player.state.gold} | Turns ${player.state.turns}\r\n`
  );
}

export function stripTelnetCommands(data: Buffer): string {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 255) {
      if (i + 1 < data.length && data[i + 1] >= 251) {
        i += 2;
        if (data[i - 1] === 250) {
          while (i < data.length && !(data[i] === 255 && i + 1 < data.length && data[i + 1] === 240)) {
            i++;
          }
          i++;
        }
        continue;
      }
    }
    if (data[i] === 13) continue;
    out.push(data[i]);
  }
  return Buffer.from(out).toString("utf8");
}

export function negotiateTelnet(socket: { write: (d: string) => void }): void {
  const IAC = String.fromCharCode(255);
  const WILL = String.fromCharCode(251);
  const WONT = String.fromCharCode(252);
  const DO = String.fromCharCode(253);
  const DONT = String.fromCharCode(254);
  socket.write(IAC + WILL + String.fromCharCode(1));
  socket.write(IAC + WILL + String.fromCharCode(3));
  socket.write(IAC + DONT + String.fromCharCode(34));
  socket.write(IAC + DO + String.fromCharCode(1));
}