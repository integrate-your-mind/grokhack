import type { Entity, Item, PlayerState } from "../src/types.js";
import { itemDisplayName } from "../src/entities.js";
import type { FloorState, OnlinePlayer } from "./types.js";

const FOV_RADIUS = 8;
const MAP_WIDTH = 78;
const MAP_HEIGHT = 18;
const LOG_WIDTH = 76;
const LOG_LINES_DEFAULT = 6;
const LOG_LINES_INVENTORY = 3;

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
  "+": ANSI.yellow,
};

const MONSTER_COLOR: Record<string, string> = {
  rat: ANSI.gray,
  kobold: ANSI.green,
  goblin: ANSI.green,
  orc: ANSI.yellow,
  troll: ANSI.cyan,
  dragon: ANSI.red,
};

const HUNGER_COLOR: Record<string, string> = {
  satiated: ANSI.green,
  normal: ANSI.white,
  hungry: ANSI.yellow,
  weak: ANSI.yellow + ANSI.bold,
  fainting: ANSI.red,
  starving: ANSI.red + ANSI.bold,
};

function inFov(px: number, py: number, x: number, y: number): boolean {
  return (x - px) ** 2 + (y - py) ** 2 <= FOV_RADIUS * FOV_RADIUS;
}

function colorForEntity(e: Entity): string {
  if (e.isPlayer) return ANSI.yellow;
  if (e.kind && MONSTER_COLOR[e.kind]) return MONSTER_COLOR[e.kind];
  return ANSI.white;
}

/** Visible length of a string after stripping ANSI CSI sequences. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate plain text for a terminal column budget.
 * Prefer breaking at spaces; fall back to hard cut + ellipsis.
 */
export function smartTruncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return "…";
  const budget = maxLen - 1;
  const slice = text.slice(0, budget);
  const sp = slice.lastIndexOf(" ");
  if (sp >= Math.floor(budget * 0.45)) {
    return slice.slice(0, sp).replace(/\s+$/, "") + "…";
  }
  return slice + "…";
}

/** Color a log line based on content (combat / social / system). */
export function colorizeLogLine(msg: string): string {
  const m = msg;
  if (m.startsWith("[dm") || m.includes("[dm←") || m.includes("[dm→")) {
    return ANSI.magenta + m + ANSI.reset;
  }
  if (m.startsWith("[chat]") || m.startsWith("* ")) {
    return ANSI.cyan + m + ANSI.reset;
  }
  if (
    /you (hit|slash|stab|crush|smite|burn|miss)/i.test(m) ||
    /hits you|misses you|bites you|claws you|breathes/i.test(m)
  ) {
    return ANSI.yellow + m + ANSI.reset;
  }
  if (
    /damage|deals \d|poison|starv|died|game over|perished|slain|incinerated/i.test(m)
  ) {
    return ANSI.red + m + ANSI.reset;
  }
  if (/you kill|conquered|ascend|victory|\+.*XP|pick up|reveals/i.test(m)) {
    return ANSI.green + m + ANSI.reset;
  }
  if (/inventory|^\s+\d+\.\s/i.test(m) || m.includes("equipped") || m.includes("(worn)")) {
    return ANSI.white + m + ANSI.reset;
  }
  if (/friend|wall|bio|welcome|farewell|usage:/i.test(m)) {
    return ANSI.blue + m + ANSI.reset;
  }
  return ANSI.dim + m + ANSI.reset;
}

/** Format one log message into display lines with color + smart wrap/truncate. */
export function formatLogMessage(msg: string, maxWidth = LOG_WIDTH): string[] {
  const parts = msg.split("\n");
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.replace(/\s+$/, "");
    if (!trimmed) continue;
    const truncated = smartTruncate(trimmed, maxWidth);
    out.push("> " + colorizeLogLine(truncated));
  }
  return out.length ? out : ["> " + colorizeLogLine(smartTruncate(msg, maxWidth))];
}

function hpColor(hp: number, maxHp: number): string {
  const r = maxHp > 0 ? Math.max(0, hp) / maxHp : 0;
  if (r > 0.6) return ANSI.green;
  if (r > 0.3) return ANSI.yellow;
  return ANSI.red;
}

function bar(cur: number, max: number, width: number, fillColor: string): string {
  const ratio = max > 0 ? Math.max(0, cur) / max : 0;
  const filled = Math.min(width, Math.round(ratio * width));
  return (
    `[${fillColor}${"█".repeat(filled)}${ANSI.dim}${"░".repeat(width - filled)}${ANSI.reset}]`
  );
}

/**
 * NetHack-adjacent status: HP / Hunger / Depth / Level / Gold (+ XP, turns).
 * Depth prefers floorDepth when provided (MMO source of truth).
 */
export function renderStatus(p: PlayerState, floorDepth?: number): string {
  const e = p.entity;
  const depth = floorDepth ?? p.depth;
  const hpCol = hpColor(e.hp, e.maxHp);
  const hungerCol = HUNGER_COLOR[p.hungerState] ?? ANSI.white;
  const hpBar = bar(e.hp, e.maxHp, 10, hpCol);
  const foodBar = bar(p.hunger, p.maxHunger, 6, hungerCol);

  return (
    `${ANSI.bold}HP${ANSI.reset}${hpBar}${hpCol}${Math.max(0, e.hp)}/${e.maxHp}${ANSI.reset}  ` +
    `${ANSI.bold}Hunger${ANSI.reset}${foodBar}${hungerCol}${p.hungerState}${ANSI.reset}  ` +
    `${ANSI.bold}Dlvl${ANSI.reset}${ANSI.cyan}${depth}${ANSI.reset}  ` +
    `${ANSI.bold}Lv${ANSI.reset}${p.level}  ` +
    `${ANSI.bold}Au${ANSI.reset}${ANSI.yellow}${p.gold}${ANSI.reset}  ` +
    `${ANSI.dim}XP${p.xp}/${p.xpToLevel}  T${p.turns}${ANSI.reset}`
  );
}

function equippedTag(p: PlayerState, item: Item): string {
  if (item === p.equippedWeapon) return `${ANSI.green} (wielded)${ANSI.reset}`;
  if (item === p.equippedArmor) return `${ANSI.green} (worn)${ANSI.reset}`;
  if (item === p.equippedRing) return `${ANSI.green} (ring)${ANSI.reset}`;
  if (item.cursed && item.identified) return `${ANSI.magenta} (cursed)${ANSI.reset}`;
  return "";
}

/** Inventory panel with itemDisplayName clarity (numbers match world useItem keys). */
export function renderInventoryPanel(p: PlayerState): string[] {
  const lines: string[] = [];
  lines.push(
    `${ANSI.bold}${ANSI.cyan}── Pack ──${ANSI.reset} ` +
      `${ANSI.dim}1-9 use · 0=10 · i close${ANSI.reset}`
  );
  if (!p.inventory.length) {
    lines.push(`${ANSI.dim}  (empty)${ANSI.reset}`);
    return lines;
  }
  p.inventory.forEach((item, idx) => {
    const key = idx === 9 ? 0 : idx + 1;
    if (idx > 9) return;
    const name = itemDisplayName(item);
    const tag = equippedTag(p, item);
    lines.push(
      `  ${ANSI.bold}${key}${ANSI.reset}. ${ANSI.magenta}${item.char}${ANSI.reset} ${name}${tag}`
    );
  });
  if (p.inventory.length > 10) {
    lines.push(`${ANSI.dim}  …and ${p.inventory.length - 10} more${ANSI.reset}`);
  }
  return lines;
}

export function renderHelp(): string {
  const L = (k: string, desc: string) =>
    `  ${ANSI.bold}${k.padEnd(22)}${ANSI.reset}${ANSI.dim}${desc}${ANSI.reset}`;
  const lines = [
    ANSI.clear +
      `${ANSI.bold}${ANSI.yellow}GrokHack — Help${ANSI.reset}  ${ANSI.dim}(? or :help)${ANSI.reset}`,
    ANSI.gray + "─".repeat(56) + ANSI.reset,
    `${ANSI.bold}${ANSI.cyan}Keys${ANSI.reset}`,
    L("hjkl / arrows", "move (bump to fight)"),
    L("yubn / HJKL", "diagonals if bound by client"),
    L(".  or  s", "wait a turn"),
    L("i", "open / close inventory"),
    L("1-9  0", "use item while pack is open"),
    L("g  >  G", "descend stairs (stand on >)"),
    L("Q", "quit session"),
    L("?", "this help"),
    L(":", "open command line"),
    "",
    `${ANSI.bold}${ANSI.cyan}Commands${ANSI.reset}  ${ANSI.dim}(type after : then Enter)${ANSI.reset}`,
    L(":say <msg>", "global chat"),
    L(":me <action>", "emote (* you wave)"),
    L(":dm <name> <msg>", "private message"),
    L(":who", "players online"),
    L(":friend add|accept|…", "friend requests"),
    L(":friends", "list friends / pending"),
    L(":wall <msg>", "post to friend wall"),
    L(":social", "read wall feed"),
    L(":bio <text>", "set profile bio"),
    L(":verify <code>", "link Discord"),
    L(":help", "this help"),
    "",
    `${ANSI.dim}Tip: combat is bump-to-attack. Don't starve. Descend deeper.${ANSI.reset}`,
    `${ANSI.dim}Press any key to return to the dungeon.${ANSI.reset}`,
  ];
  return lines.join("\r\n") + "\r\n";
}

export function renderTerminalView(
  viewer: OnlinePlayer,
  floor: FloorState,
  others: OnlinePlayer[]
): string {
  const { dungeon } = floor;
  const px = viewer.state.entity.x;
  const py = viewer.state.entity.y;
  const vw = Math.min(MAP_WIDTH, dungeon.width);
  const vh = MAP_HEIGHT;
  const ox = Math.max(0, Math.min(px - Math.floor(vw / 2), dungeon.width - vw));
  const oy = Math.max(0, Math.min(py - Math.floor(vh / 2), dungeon.height - vh));

  const lines: string[] = [];
  lines.push(
    `${ANSI.bold}${ANSI.yellow}GrokHack MMO${ANSI.reset} ` +
      `${ANSI.dim}${viewer.name} (${viewer.glyph}) · floor online ${others.length + 1}${ANSI.reset}`
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

      const seen = viewer.explored[y]?.[x];
      const visible = Boolean(seen && inFov(px, py, x, y));

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
  lines.push(renderStatus(viewer.state, viewer.floorDepth));
  lines.push(
    ANSI.dim +
      "?:help  :say :dm :friend :wall :who  i:inv  hjkl:move  g:descend" +
      ANSI.reset
  );

  if (viewer.phase === "inventory") {
    for (const invLine of renderInventoryPanel(viewer.state)) {
      lines.push(invLine);
    }
  }

  const logBudget = viewer.phase === "inventory" ? LOG_LINES_INVENTORY : LOG_LINES_DEFAULT;
  const expanded: string[] = [];
  for (const msg of viewer.messages) {
    expanded.push(...formatLogMessage(msg, LOG_WIDTH));
  }
  const recent = expanded.slice(-logBudget);
  for (const msg of recent) {
    lines.push(msg);
  }

  return ANSI.clear + lines.join("\r\n") + "\r\n";
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
    `${ANSI.dim}Players online: ${online}/${maxPlayers}${ANSI.reset}\r\n` +
    `${ANSI.dim}In-game: ? or :help for keys & social commands${ANSI.reset}\r\n\r\n` +
    `Enter thy name, adventurer: `
  );
}

export function renderDeath(player: OnlinePlayer): string {
  const cause = player.state.deathCause?.trim();
  const causeLine = cause
    ? `${ANSI.red}${ANSI.bold}${cause}${ANSI.reset}\r\n\r\n`
    : "";
  return (
    ANSI.clear +
    `${ANSI.red}${ANSI.bold}☠  YOU DIED  ☠${ANSI.reset}\r\n\r\n` +
    causeLine +
    `${ANSI.bold}${player.name}${ANSI.reset} perished on depth ${ANSI.cyan}${player.floorDepth}${ANSI.reset}.\r\n` +
    `Level ${player.state.level} | Gold ${ANSI.yellow}${player.state.gold}${ANSI.reset} | Turns ${player.state.turns}\r\n` +
    `${ANSI.dim}XP ${player.state.xp} · HP was ${Math.max(0, player.state.entity.hp)}/${player.state.entity.maxHp}${ANSI.reset}\r\n\r\n` +
    `${ANSI.dim}Reconnect to start anew. Share your death.${ANSI.reset}\r\n`
  );
}

export function renderVictory(player: OnlinePlayer): string {
  return (
    ANSI.clear +
    `${ANSI.yellow}${ANSI.bold}★ VICTORY ★${ANSI.reset}\r\n\r\n` +
    `${ANSI.green}${ANSI.bold}${player.name} conquered the dungeon!${ANSI.reset}\r\n\r\n` +
    `Depth reached ${ANSI.cyan}${player.floorDepth}${ANSI.reset} | Level ${player.state.level}\r\n` +
    `Gold ${ANSI.yellow}${player.state.gold}${ANSI.reset} | Turns ${player.state.turns} | XP ${player.state.xp}\r\n\r\n` +
    `${ANSI.dim}The dragon falls. Your name will be remembered.${ANSI.reset}\r\n`
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
