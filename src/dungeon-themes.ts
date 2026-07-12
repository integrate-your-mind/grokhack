/**
 * Themed floor helpers for generateDungeon — NetHack-grade variety bar.
 * Keep generateDungeon thin: select theme, bias params, place secret alcoves.
 *
 * Owned by ALGORITHMS / gen-themes. Do not import from dungeon.ts (avoid cycles).
 */
import { RNG } from "./rng";
import type { Room, Tile } from "./types";

export type FloorTheme = "mines" | "halls" | "crypt";

export interface ThemePack {
  id: FloorTheme;
  /** Display name for messages / future UI. */
  name: string;
  /** Added to depth-based cavern carve chance (clamped). */
  cavernBias: number;
  /** Extra optional corridor loops after MST. */
  loopBonus: number;
  /** Chance to attempt at least one secret alcove (depth ≥ 4). */
  alcoveChance: number;
  /** Prefer smaller chambers when packing rooms. */
  preferSmallRooms: boolean;
  /** Bias toward 2-wide corridors (grand halls). */
  wideCorridorChance: number;
}

const THEME_PACKS: Record<FloorTheme, ThemePack> = {
  mines: {
    id: "mines",
    name: "Gnomish Mines",
    cavernBias: 0.28,
    loopBonus: 0,
    alcoveChance: 0.55,
    preferSmallRooms: true,
    wideCorridorChance: 0.08,
  },
  halls: {
    id: "halls",
    name: "Grand Halls",
    cavernBias: -0.08,
    loopBonus: 2,
    alcoveChance: 0.4,
    preferSmallRooms: false,
    wideCorridorChance: 0.32,
  },
  crypt: {
    id: "crypt",
    name: "Crypt",
    cavernBias: 0.1,
    loopBonus: 1,
    alcoveChance: 0.72,
    preferSmallRooms: true,
    wideCorridorChance: 0.12,
  },
};

export function getThemePack(theme: FloorTheme): ThemePack {
  return THEME_PACKS[theme];
}

export function allFloorThemes(): FloorTheme[] {
  return ["mines", "halls", "crypt"];
}

/**
 * Pick a floor theme from depth + RNG (deterministic with seed).
 * Shallow floors lean halls; mid/deep favor crypt & mines.
 */
export function selectFloorTheme(depth: number, rng: RNG): FloorTheme {
  const d = Math.max(1, depth);
  let mines = 0.18 + (d >= 5 ? 0.22 : 0) + (d >= 8 ? 0.18 : 0);
  let halls = 0.5 - (d >= 6 ? 0.18 : 0) - (d >= 9 ? 0.1 : 0);
  let crypt = 0.32 + (d >= 4 ? 0.12 : 0) + (d >= 7 ? 0.1 : 0);
  // Keep weights non-negative
  mines = Math.max(0.05, mines);
  halls = Math.max(0.08, halls);
  crypt = Math.max(0.08, crypt);
  const total = mines + halls + crypt;
  const r = rng.next() * total;
  if (r < mines) return "mines";
  if (r < mines + halls) return "halls";
  return "crypt";
}

/** Pure depth+seed theme pick (no RNG object) — useful for metrics/tests. */
export function themeForDepthSeed(depth: number, seed: number): FloorTheme {
  return selectFloorTheme(depth, new RNG(seed ^ (depth * 0x9e3779b9)));
}

/** Depth base cavern chance + theme bias. */
export function themedCavernChance(depth: number, theme: FloorTheme): number {
  const base = depth >= 8 ? 0.45 : depth >= 5 ? 0.28 : depth >= 3 ? 0.12 : 0;
  const biased = base + getThemePack(theme).cavernBias;
  return Math.max(0, Math.min(0.85, biased));
}

/** MST loop budget with theme bonus. */
export function themedLoopBudget(
  depth: number,
  roomCount: number,
  theme: FloorTheme
): number {
  if (roomCount < 2) return 0;
  const base = Math.min(
    2 + Math.floor(depth / 3) + (depth >= 8 ? 2 : 0),
    roomCount
  );
  return Math.min(roomCount, base + getThemePack(theme).loopBonus);
}

/**
 * How many secret alcoves to attempt. Reserves headroom against roomCountRange max.
 * depth < 4 → 0 (secret features kick in mid-dungeon).
 */
export function themedAlcoveAttempts(
  depth: number,
  theme: FloorTheme,
  rng: RNG
): number {
  if (depth < 4) return 0;
  const pack = getThemePack(theme);
  if (!rng.chance(pack.alcoveChance)) return 0;
  // Crypts sometimes hide two niches; halls rarely
  if (theme === "crypt" && rng.chance(0.35)) return 2;
  if (theme === "mines" && rng.chance(0.2)) return 2;
  return 1;
}

/** Room-target headroom so alcoves stay within roomCountRange max. */
export function reserveAlcoveSlots(depth: number, maxRooms: number, minRooms: number): number {
  if (depth < 4) return 0;
  // Keep at least min rooms for main layout; reserve up to 2 slots
  const headroom = Math.max(0, maxRooms - minRooms);
  return Math.min(2, headroom);
}

function isWalkableTile(t: Tile): boolean {
  return t === "." || t === ">" || t === "<" || t === "+";
}

function pointInRoom(room: Room, x: number, y: number): boolean {
  return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
}

function roomsOverlap(a: Room, b: Room, padding = 1): boolean {
  return (
    a.x - padding < b.x + b.w + padding &&
    a.x + a.w + padding > b.x - padding &&
    a.y - padding < b.y + b.h + padding &&
    a.y + a.h + padding > b.y - padding
  );
}

function inBounds(tiles: Tile[][], x: number, y: number): boolean {
  return y >= 0 && x >= 0 && y < tiles.length && x < (tiles[0]?.length ?? 0);
}

function regionIsSolid(
  tiles: Tile[][],
  room: Room,
  doorX: number,
  doorY: number
): boolean {
  if (room.x < 1 || room.y < 1) return false;
  if (room.y + room.h >= tiles.length - 1) return false;
  if (room.x + room.w >= (tiles[0]?.length ?? 0) - 1) return false;

  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (tiles[y][x] !== "#") return false;
    }
  }
  // Door cell must still be rock (we open it)
  if (!inBounds(tiles, doorX, doorY) || tiles[doorY][doorX] !== "#") return false;
  return true;
}

/**
 * Secret alcove: small chamber + single door, attached after MST
 * (not part of the main room spanning tree — a dead-end pocket).
 * Returns true if placed; pushes Room with special "alcove".
 */
export function tryPlaceSecretAlcove(
  tiles: Tile[][],
  rooms: Room[],
  rng: RNG
): boolean {
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  if (width < 10 || height < 10) return false;

  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  type Attach = { fx: number; fy: number; dx: number; dy: number; doorX: number; doorY: number };
  const attachments: Attach[] = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!isWalkableTile(tiles[y][x])) continue;
      // Prefer corridor mouths / room edges — any walkable is fine
      for (const [dx, dy] of dirs) {
        const doorX = x + dx;
        const doorY = y + dy;
        if (!inBounds(tiles, doorX, doorY)) continue;
        if (tiles[doorY][doorX] !== "#") continue;
        // Don't punch doors inside existing rooms
        if (rooms.some((r) => pointInRoom(r, doorX, doorY))) continue;
        attachments.push({ fx: x, fy: y, dx, dy, doorX, doorY });
      }
    }
  }

  if (!attachments.length) return false;

  const candidates = rng.shuffle(attachments);
  const maxTries = Math.min(120, candidates.length);

  for (let i = 0; i < maxTries; i++) {
    const att = candidates[i];
    const w = rng.int(3, 4);
    const h = rng.int(3, 4);

    let rx: number;
    let ry: number;
    if (att.dx === 1) {
      rx = att.doorX + 1;
      ry = att.doorY - Math.floor((h - 1) / 2);
    } else if (att.dx === -1) {
      rx = att.doorX - w;
      ry = att.doorY - Math.floor((h - 1) / 2);
    } else if (att.dy === 1) {
      rx = att.doorX - Math.floor((w - 1) / 2);
      ry = att.doorY + 1;
    } else {
      rx = att.doorX - Math.floor((w - 1) / 2);
      ry = att.doorY - h;
    }

    const room: Room = {
      x: rx,
      y: ry,
      w,
      h,
      special: "alcove",
      locked: false,
    };

    if (!regionIsSolid(tiles, room, att.doorX, att.doorY)) continue;
    if (rooms.some((r) => roomsOverlap(r, room, 0))) continue;

    // Carve chamber
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        tiles[y][x] = ".";
      }
    }
    // Single door mouth — off-MST secret entrance
    tiles[att.doorY][att.doorX] = "+";

    rooms.push(room);
    return true;
  }

  return false;
}

/**
 * Place up to `attempts` secret alcoves without exceeding `maxRooms`.
 * Call after MST + vault sealing so alcoves stay off the main tree.
 */
export function placeSecretAlcoves(
  tiles: Tile[][],
  rooms: Room[],
  rng: RNG,
  attempts: number,
  maxRooms: number
): number {
  let placed = 0;
  for (let i = 0; i < attempts; i++) {
    if (rooms.length >= maxRooms) break;
    if (tryPlaceSecretAlcove(tiles, rooms, rng)) placed++;
  }
  return placed;
}

/** Count rooms tagged as secret alcoves. */
export function countSecretAlcoves(rooms: Room[]): number {
  return rooms.filter((r) => r.special === "alcove").length;
}
