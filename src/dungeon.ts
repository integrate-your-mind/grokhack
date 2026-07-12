import { RNG } from "./rng";
import type { Dungeon, Room, RoomSpecial, Tile } from "./types";
// themes handoff
import {
  selectFloorTheme,
  getThemePack,
  themedCavernChance,
  themedLoopBudget,
  themedAlcoveAttempts,
  reserveAlcoveSlots,
  placeSecretAlcoves,
  type FloorTheme,
} from "./dungeon-themes";
// world-events handoff — dens packs + encounter special assignment (P0 wire §4)
// Cycle-safe: world-events imports dungeon for placement helpers; both only call at runtime.
import {
  assignEncounterSpecials,
  densPackSize,
  isDenSpecial,
} from "./world-events";

const WIDTH = 80;
const HEIGHT = 24;
const MIN_ROOM = 4;
const MAX_ROOM = 10;

/** Room-count envelope by depth — used by gen and property tests. */
export function roomCountRange(depth: number): { min: number; max: number; target: number } {
  const d = Math.max(1, depth);
  // Depth 1: smaller tutorial floors; deep: denser NetHack-ish layouts
  const min = Math.min(5 + Math.floor((d - 1) / 2), 9);
  const max = Math.min(8 + Math.floor(d / 2) + Math.floor(d / 4), 15);
  const target = Math.min(min + 2 + Math.floor(d / 3), max);
  return { min, max, target };
}

function createEmptyGrid(): Tile[][] {
  return Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => "#" as Tile)
  );
}

function roomsOverlap(a: Room, b: Room, padding = 1): boolean {
  return (
    a.x - padding < b.x + b.w + padding &&
    a.x + a.w + padding > b.x - padding &&
    a.y - padding < b.y + b.h + padding &&
    a.y + a.h + padding > b.y - padding
  );
}

function roomCenter(r: Room): { x: number; y: number } {
  return {
    x: r.x + Math.floor(r.w / 2),
    y: r.y + Math.floor(r.h / 2),
  };
}

function roomDist(a: Room, b: Room): number {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
}

function carveRoom(tiles: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      tiles[y][x] = ".";
    }
  }
}

/**
 * Organic cavern chamber — ellipse with noisy edges.
 * Used on deeper floors so late dungeon stops feeling like office cubicles.
 */
function carveCavern(tiles: Tile[][], room: Room, rng: RNG): void {
  const cx = room.x + (room.w - 1) / 2;
  const cy = room.y + (room.h - 1) / 2;
  const rx = Math.max(1.5, room.w / 2);
  const ry = Math.max(1.5, room.h / 2);

  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const dist = nx * nx + ny * ny;
      // Soft edge noise: sometimes include border tiles
      const jitter = rng.next() * 0.35;
      if (dist <= 1.0 + jitter * 0.4) {
        tiles[y][x] = ".";
      }
    }
  }
  // Guarantee a solid core so stairs/spawns never land in a hollow ellipse
  const coreW = Math.max(2, Math.floor(room.w / 3));
  const coreH = Math.max(2, Math.floor(room.h / 3));
  const ox = room.x + Math.floor((room.w - coreW) / 2);
  const oy = room.y + Math.floor((room.h - coreH) / 2);
  for (let y = oy; y < oy + coreH; y++) {
    for (let x = ox; x < ox + coreW; x++) {
      tiles[y][x] = ".";
    }
  }
}

/** Pillars in large halls — breaks line of sight, NetHack throne-room energy. */
function placePillars(tiles: Tile[][], room: Room, rng: RNG): void {
  if (room.w < 7 || room.h < 7) return;
  if (!rng.chance(0.55)) return;

  const inset = 2;
  const candidates: { x: number; y: number }[] = [];
  for (let y = room.y + inset; y < room.y + room.h - inset; y++) {
    for (let x = room.x + inset; x < room.x + room.w - inset; x++) {
      if (tiles[y][x] === ".") candidates.push({ x, y });
    }
  }
  if (candidates.length < 4) return;

  const count = rng.int(2, Math.min(5, Math.floor(candidates.length / 8) + 2));
  const placed: { x: number; y: number }[] = [];
  for (const p of rng.shuffle(candidates)) {
    if (placed.length >= count) break;
    if (tiles[p.y][p.x] !== ".") continue;
    // Manhattan gap of 3 from other pillars so halls stay navigable
    if (placed.some((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 3)) continue;
    tiles[p.y][p.x] = "#";
    placed.push(p);
  }
}

function carveHorizontal(tiles: Tile[][], x1: number, x2: number, y: number, width = 1): void {
  const start = Math.min(x1, x2);
  const end = Math.max(x1, x2);
  for (let x = start; x <= end; x++) {
    for (let w = 0; w < width; w++) {
      const yy = y + w;
      if (tiles[yy]?.[x] === "#") tiles[yy][x] = ".";
    }
  }
}

function carveVertical(tiles: Tile[][], y1: number, y2: number, x: number, width = 1): void {
  const start = Math.min(y1, y2);
  const end = Math.max(y1, y2);
  for (let y = start; y <= end; y++) {
    for (let w = 0; w < width; w++) {
      const xx = x + w;
      if (tiles[y]?.[xx] === "#") tiles[y][xx] = ".";
    }
  }
}

function connectRooms(
  tiles: Tile[][],
  a: Room,
  b: Room,
  rng: RNG,
  wideChance = 0.18
): void {
  const ax = rng.int(a.x, a.x + a.w - 1);
  const ay = rng.int(a.y, a.y + a.h - 1);
  const bx = rng.int(b.x, b.x + b.w - 1);
  const by = rng.int(b.y, b.y + b.h - 1);
  // Deeper floors / grand halls sometimes get 2-wide galleries
  const width = rng.chance(wideChance) ? 2 : 1;

  if (rng.chance(0.5)) {
    carveHorizontal(tiles, ax, bx, ay, width);
    carveVertical(tiles, ay, by, bx, width);
  } else {
    carveVertical(tiles, ay, by, ax, width);
    carveHorizontal(tiles, ax, bx, by, width);
  }
}

/** Prim-style MST: every room reachable with short corridors, then optional loops. */
function connectAllRooms(
  tiles: Tile[][],
  rooms: Room[],
  rng: RNG,
  loopBudget: number,
  wideChance = 0.18
): void {
  if (rooms.length < 2) return;

  const connected = new Set<number>([0]);
  const remaining = new Set<number>(rooms.map((_, i) => i).filter((i) => i !== 0));

  while (remaining.size > 0) {
    let bestFrom = -1;
    let bestTo = -1;
    let bestDist = Infinity;

    for (const i of connected) {
      for (const j of remaining) {
        const d = roomDist(rooms[i], rooms[j]);
        // Slight RNG jitter so layouts aren't pure nearest-neighbor trees
        const score = d + rng.int(0, 4);
        if (score < bestDist) {
          bestDist = score;
          bestFrom = i;
          bestTo = j;
        }
      }
    }

    if (bestFrom < 0 || bestTo < 0) break;
    connectRooms(tiles, rooms[bestFrom], rooms[bestTo], rng, wideChance);
    connected.add(bestTo);
    remaining.delete(bestTo);
  }

  // Extra corridors for loops / alternate paths (depth-scaled + theme)
  for (let i = 0; i < loopBudget; i++) {
    const a = rng.int(0, rooms.length - 1);
    let b = rng.int(0, rooms.length - 1);
    if (a === b) b = (b + 1) % rooms.length;
    // Prefer connecting somewhat distant rooms for interesting loops
    if (roomDist(rooms[a], rooms[b]) < 12 && rng.chance(0.4)) continue;
    connectRooms(tiles, rooms[a], rooms[b], rng, wideChance);
  }
}

export function isWalkable(tiles: Tile[][], x: number, y: number): boolean {
  if (x < 0 || y < 0 || y >= tiles.length || x >= tiles[0].length) return false;
  const t = tiles[y][x];
  return t === "." || t === ">" || t === "<" || t === "+";
}

/** True if tile blocks line-of-sight (opaque). Doors are transparent once present. */
export function blocksVision(tiles: Tile[][], x: number, y: number): boolean {
  if (x < 0 || y < 0 || y >= tiles.length || x >= tiles[0].length) return true;
  return tiles[y][x] === "#";
}

function walkableTiles(tiles: Tile[][]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[0].length; x++) {
      if (isWalkable(tiles, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** BFS connectivity of the walkable graph — property-test surface. */
export function isFullyConnected(tiles: Tile[][]): boolean {
  const floors = walkableTiles(tiles);
  if (floors.length === 0) return false;
  const start = floors[0];
  const seen = new Set<string>();
  const q: { x: number; y: number }[] = [start];
  seen.add(`${start.x},${start.y}`);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (q.length) {
    const cur = q.shift()!;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (!isWalkable(tiles, nx, ny)) continue;
      seen.add(key);
      q.push({ x: nx, y: ny });
    }
  }
  return seen.size === floors.length;
}

/** Repair rare disconnects by tunneling to nearest connected component. */
function ensureConnectivity(tiles: Tile[][], rng: RNG): void {
  if (isFullyConnected(tiles)) return;

  const floors = walkableTiles(tiles);
  if (floors.length < 2) return;

  // Find components
  const componentOf = new Map<string, number>();
  let compId = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (const f of floors) {
    const key = `${f.x},${f.y}`;
    if (componentOf.has(key)) continue;
    const q = [f];
    componentOf.set(key, compId);
    while (q.length) {
      const cur = q.shift()!;
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nk = `${nx},${ny}`;
        if (componentOf.has(nk)) continue;
        if (!isWalkable(tiles, nx, ny)) continue;
        componentOf.set(nk, compId);
        q.push({ x: nx, y: ny });
      }
    }
    compId++;
  }

  if (compId <= 1) return;

  // Connect each component to component 0 via L-corridor between nearest points
  const byComp = new Map<number, { x: number; y: number }[]>();
  for (const f of floors) {
    const id = componentOf.get(`${f.x},${f.y}`)!;
    if (!byComp.has(id)) byComp.set(id, []);
    byComp.get(id)!.push(f);
  }

  const main = byComp.get(0) ?? floors;
  for (let id = 1; id < compId; id++) {
    const pts = byComp.get(id);
    if (!pts?.length) continue;
    let bestA = main[0];
    let bestB = pts[0];
    let best = Infinity;
    // Sample for speed on large floors
    const sampleMain = main.length > 40 ? rng.shuffle(main).slice(0, 40) : main;
    const samplePts = pts.length > 40 ? rng.shuffle(pts).slice(0, 40) : pts;
    for (const a of sampleMain) {
      for (const b of samplePts) {
        const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (d < best) {
          best = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (rng.chance(0.5)) {
      carveHorizontal(tiles, bestA.x, bestB.x, bestA.y);
      carveVertical(tiles, bestA.y, bestB.y, bestB.x);
    } else {
      carveVertical(tiles, bestA.y, bestB.y, bestA.x);
      carveHorizontal(tiles, bestA.x, bestB.x, bestB.y);
    }
  }
}

function pointInRoom(room: Room, x: number, y: number): boolean {
  return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
}

/**
 * Seal a vault: close all exits except one door (+).
 * NetHack-style locked vault flavor without a full key system.
 */
function sealVault(tiles: Tile[][], room: Room, rng: RNG): boolean {
  const exits: { x: number; y: number }[] = [];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (!isWalkable(tiles, x, y)) continue;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (pointInRoom(room, nx, ny)) continue;
        if (isWalkable(tiles, nx, ny)) {
          exits.push({ x: nx, y: ny });
        }
      }
    }
  }

  // Unique exit tiles just outside the room
  const unique = new Map<string, { x: number; y: number }>();
  for (const e of exits) unique.set(`${e.x},${e.y}`, e);
  const exitList = [...unique.values()];
  if (exitList.length === 0) return false;

  const keep = rng.pick(exitList);
  for (const e of exitList) {
    if (e.x === keep.x && e.y === keep.y) {
      tiles[e.y][e.x] = "+";
    } else {
      tiles[e.y][e.x] = "#";
    }
  }
  room.locked = true;
  return true;
}

/** Occasional open doors on corridor mouths for visual variety. */
function placeCorridorDoors(tiles: Tile[][], rooms: Room[], rng: RNG): void {
  const inAnyRoom = (x: number, y: number) => rooms.some((r) => pointInRoom(r, x, y));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  for (const room of rooms) {
    if (room.special === "vault") continue; // vault already has sealed door
    if (room.special === "alcove") continue; // secret alcove keeps single door
    if (!rng.chance(0.35)) continue;

    const candidates: { x: number; y: number }[] = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (inAnyRoom(nx, ny)) continue;
          if (tiles[ny]?.[nx] === ".") candidates.push({ x: nx, y: ny });
        }
      }
    }
    if (candidates.length && rng.chance(0.7)) {
      const d = rng.pick(candidates);
      tiles[d.y][d.x] = "+";
    }
  }
}

/**
 * Cap total non-alcove specials — nethack-concepts §3.2 / TICKET-ALG-01.
 * density coord: d1–5 need ≥2 specials so floors feel eventful (CEO empty-floor).
 */
export function specialRoomCap(depth: number): number {
  const d = Math.max(1, depth);
  if (d <= 2) return 2;
  if (d <= 5) return 3;
  return Math.min(4, 1 + Math.floor(d / 3));
}

/** Prefer mid-size rooms for shops (not tiny alcoves, not giant halls). */
function pickShopRoom(free: Room[], rng: RNG): Room | undefined {
  if (!free.length) return undefined;
  const scored = free
    .map((r) => {
      const area = r.w * r.h;
      // Sweet spot ~20–36 tiles; penalize extremes
      const mid = 28;
      const score = -Math.abs(area - mid) + rng.next() * 2;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.r;
}

/**
 * Assign classic + NetHack-inspired special rooms.
 * Spawn CONTENTS (packs, priced goods, interact) owned by spawn-ecology / world-events / depth.
 * TICKET-ALG-01: shop d2+, beehive d3+, throne d4+, graveyard d4+; max 1 each; crypt biases graveyard.
 */
function assignSpecialRooms(
  rooms: Room[],
  depth: number,
  rng: RNG,
  theme?: FloorTheme
): void {
  if (rooms.length < 3) return;

  // Never special-case the first room (player/start)
  const candidates = rooms.slice(1);
  const shuffled = rng.shuffle(candidates);

  // Classic specials
  const vaultChance = Math.min(0.3 + depth * 0.06, 0.85);
  const shrineChance = Math.min(0.28 + depth * 0.04, 0.6);
  const barracksChance = Math.min(0.35 + depth * 0.06, 0.75);
  const zooChance = depth >= 3 ? Math.min(0.22 + (depth - 3) * 0.06, 0.55) : 0;

  // TICKET-ALG-01 depth-gated specials (§3.2 chances)
  const shopChance = depth >= 2 ? Math.min(0.18 + (depth - 2) * 0.04, 0.4) : 0;
  const beehiveChance = depth >= 3 ? Math.min(0.1 + (depth - 3) * 0.04, 0.3) : 0;
  const throneChance = depth >= 4 ? Math.min(0.12 + (depth - 4) * 0.04, 0.35) : 0;
  let graveyardChance = depth >= 4 ? Math.min(0.12 + (depth - 4) * 0.04, 0.35) : 0;
  // Crypt theme bias graveyard (+0.2)
  if (theme === "crypt" && depth >= 4) {
    graveyardChance = Math.min(graveyardChance + 0.2, 0.55);
  }
  // Fountain kept in types (world-events teeth); soft assign d2+ without thrashing density
  const fountainChance = depth >= 2 ? Math.min(0.22 + depth * 0.03, 0.5) : 0;

  let specials = 0;
  // Reserve ≥1 slot for assignEncounterSpecials on d2+ so fountain/graveyard/throne
  // are not starved when classic dens fill the entire cap (nethack-systems §4 P0 wire).
  const cap = specialRoomCap(depth);
  const maxSpecials = depth >= 2 ? Math.max(1, cap - 1) : cap;

  const has = (kind: RoomSpecial): boolean =>
    shuffled.some((r) => r.special === kind) || rooms.some((r) => r.special === kind);

  const freeRooms = (): Room[] => shuffled.filter((r) => !r.special);

  type SpecOffer = {
    kind: RoomSpecial;
    chance: number;
    pick?: (free: Room[], rng: RNG) => Room | undefined;
  };

  // Type-first offers (shuffled) so vault does not always crowd out new specials
  const offers: SpecOffer[] = [
    { kind: "vault", chance: vaultChance },
    { kind: "shrine", chance: shrineChance },
    { kind: "barracks", chance: barracksChance },
    { kind: "zoo", chance: zooChance },
    { kind: "shop", chance: shopChance, pick: pickShopRoom },
    { kind: "beehive", chance: beehiveChance },
    { kind: "throne", chance: throneChance },
    { kind: "graveyard", chance: graveyardChance },
    { kind: "fountain", chance: fountainChance },
  ];

  for (const offer of rng.shuffle(offers)) {
    if (specials >= maxSpecials) break;
    if (offer.chance <= 0) continue;
    if (has(offer.kind)) continue;
    if (!rng.chance(offer.chance)) continue;
    const free = freeRooms();
    if (!free.length) break;
    const room = offer.pick ? offer.pick(free, rng) : free[0];
    if (!room) continue;
    room.special = offer.kind;
    specials++;
  }

  // Guarantee at least one special on every floor with rooms (d1+ packs/vaults)
  if (specials === 0 && shuffled.length) {
    const pick = shuffled[0];
    const roll = rng.next();
    if (depth <= 2) {
      // d2 may take shop; d1 stays classic dens
      if (depth >= 2 && roll < 0.25) pick.special = "shop";
      else pick.special = (roll < 0.55 ? "barracks" : roll < 0.8 ? "shrine" : "vault") as RoomSpecial;
    } else if (depth <= 3) {
      pick.special = (
        roll < 0.25 ? "shop" : roll < 0.4 ? "beehive" : roll < 0.6 ? "barracks" : roll < 0.8 ? "shrine" : "vault"
      ) as RoomSpecial;
    } else {
      // d4+: full palette including throne / graveyard
      if (roll < 0.12) pick.special = "throne";
      else if (roll < 0.24) pick.special = "graveyard";
      else if (roll < 0.36) pick.special = "shop";
      else if (roll < 0.46) pick.special = "beehive";
      else if (roll < 0.6) pick.special = "zoo";
      else if (roll < 0.75) pick.special = "barracks";
      else if (roll < 0.88) pick.special = "shrine";
      else pick.special = "vault";
    }
    specials++;
  }

  // Early floors: second dens room when cap allows (life on the map); still max 1 each
  if (depth <= 5 && specials < 2 && specials < maxSpecials && shuffled.length > 1) {
    const free = shuffled.find((r) => !r.special);
    if (free) {
      const wantZoo = depth >= 3 && rng.chance(0.4);
      if (wantZoo && !has("zoo")) {
        free.special = "zoo";
      } else if (!has("barracks")) {
        free.special = "barracks";
      } else if (!has("zoo") && depth >= 3) {
        free.special = "zoo";
      } else if (!has("shrine")) {
        free.special = "shrine";
      }
    }
  }
}

function placeStairs(tiles: Tile[][], rooms: Room[], depth: number, rng: RNG): {
  stairsDown: { x: number; y: number };
  stairsUp: { x: number; y: number };
} {
  // Stairs up / entry in first room; stairs down in farthest room for exploration quality
  const start = rooms[0] ?? { x: 2, y: 2, w: 6, h: 4, special: null };
  const startCenter = roomCenter(start);

  let farRoom = rooms[rooms.length - 1] ?? start;
  let farScore = -1;
  for (let i = 1; i < rooms.length; i++) {
    // themes handoff — never put stairs in a secret alcove
    if (rooms[i].special === "alcove") continue;
    const c = roomCenter(rooms[i]);
    const score = Math.abs(c.x - startCenter.x) + Math.abs(c.y - startCenter.y) + rng.int(0, 3);
    if (score > farScore) {
      farScore = score;
      farRoom = rooms[i];
    }
  }

  const stairsUp = {
    x: start.x + Math.floor(start.w / 2),
    y: start.y + Math.floor(start.h / 2),
  };
  const stairsDown = {
    x: farRoom.x + Math.floor(farRoom.w / 2),
    y: farRoom.y + Math.floor(farRoom.h / 2),
  };

  // Avoid same tile on depth 1 (up isn't drawn but coords still set)
  if (stairsDown.x === stairsUp.x && stairsDown.y === stairsUp.y) {
    const floors = walkableTiles(tiles).filter(
      (f) => f.x !== stairsUp.x || f.y !== stairsUp.y
    );
    if (floors.length) {
      const alt = rng.pick(floors);
      stairsDown.x = alt.x;
      stairsDown.y = alt.y;
    }
  }

  tiles[stairsDown.y][stairsDown.x] = ">";
  if (depth > 1) tiles[stairsUp.y][stairsUp.x] = "<";

  return { stairsDown, stairsUp };
}

export function generateDungeon(rng: RNG, depth: number): Dungeon {
  const tiles = createEmptyGrid();
  const rooms: Room[] = [];
  const { min, max, target } = roomCountRange(depth);

  // themes handoff — pack biases + secret alcove budget (deterministic)
  const theme: FloorTheme = selectFloorTheme(depth, rng);
  const pack = getThemePack(theme);
  const alcoveReserve = reserveAlcoveSlots(depth, max, min);
  const alcoveAttempts = themedAlcoveAttempts(depth, theme, rng);
  const effectiveMax = Math.max(min, max - alcoveReserve);
  const roomTarget = Math.min(Math.max(target, min), effectiveMax);
  const cavernChance = themedCavernChance(depth, theme);
  const wideChance = pack.wideCorridorChance;

  const tryPlaceRoom = (preferSmall: boolean): boolean => {
    const maxDim = Math.min(MAX_ROOM + (depth >= 6 ? 2 : 0), 12);
    const maxW = preferSmall ? Math.min(6, maxDim) : maxDim;
    const maxH = preferSmall ? Math.min(6, maxDim) : maxDim;
    const w = rng.int(MIN_ROOM, maxW);
    const h = rng.int(MIN_ROOM, maxH);
    const x = rng.int(1, WIDTH - w - 2);
    const y = rng.int(1, HEIGHT - h - 2);
    const room: Room = { x, y, w, h, special: null, locked: false };
    if (rooms.some((r) => roomsOverlap(r, room))) return false;

    // themes handoff — mines/crypt cavern bias via themedCavernChance
    if (rooms.length > 0 && rng.chance(cavernChance)) {
      carveCavern(tiles, room, rng);
    } else {
      carveRoom(tiles, room);
    }
    rooms.push(room);
    return true;
  };

  for (let attempt = 0; attempt < 160 && rooms.length < roomTarget; attempt++) {
    // themes handoff — mines/crypt pack smaller chambers more often
    const themeSmall = pack.preferSmallRooms && rng.chance(0.35);
    tryPlaceRoom(themeSmall);
  }

  // Hard push toward min room count with smaller chambers if packing was tight
  for (let attempt = 0; attempt < 80 && rooms.length < min; attempt++) {
    tryPlaceRoom(true);
  }

  // Pillars after rooms exist (before corridors so doors still attach cleanly)
  for (const room of rooms) {
    if (room.w >= 7 && room.h >= 7) placePillars(tiles, room, rng);
  }

  // Fallback: guarantee a playable start room
  if (rooms.length === 0) {
    const room: Room = { x: 2, y: 2, w: 8, h: 6, special: null, locked: false };
    carveRoom(tiles, room);
    rooms.push(room);
  }

  // themes handoff — loop budget + wide corridor bias by pack
  const loopBudget = themedLoopBudget(depth, rooms.length, theme);
  connectAllRooms(tiles, rooms, rng, loopBudget, wideChance);
  ensureConnectivity(tiles, rng);

  assignSpecialRooms(rooms, depth, rng, theme);
  // P0 wire (nethack-systems §4): encounter specials after classic assignment.
  // Fills free rooms under remaining specialRoomCap — never clobbers ALG specials.
  {
    const used = rooms.filter(
      (r) => r.special && r.special !== "alcove" && r.special !== null
    ).length;
    const remaining = Math.max(0, specialRoomCap(depth) - used);
    if (remaining > 0) {
      assignEncounterSpecials(rooms, depth, rng, remaining);
    }
  }
  // Spawn CONTENTS: dens via planMonsterSpawns/isDenSpecial; step teeth via world-events

  // Lock vaults after corridors exist so we seal real exits
  for (const room of rooms) {
    if (room.special === "vault") {
      sealVault(tiles, room, rng);
    }
  }

  placeCorridorDoors(tiles, rooms, rng);

  // themes handoff — secret alcoves off main MST (after tree + vaults)
  placeSecretAlcoves(tiles, rooms, rng, alcoveAttempts, max);
  ensureConnectivity(tiles, rng); // sealing vaults / alcoves can isolate — repair

  const { stairsDown, stairsUp } = placeStairs(tiles, rooms, depth, rng);

  // trap-pressure handoff — floor traps generated in src/traps.ts after dungeon
  // (game.ts / world.ts call generateTraps; density scales with depth)

  return {
    width: WIDTH,
    height: HEIGHT,
    tiles,
    rooms,
    stairsDown,
    stairsUp,
  };
}

/**
 * Multi-ray FOV with dense angular sampling.
 * Reveals the blocking wall at ray termination (NetHack-style wall face lighting).
 * Higher exploration quality than single-step grid circle checks.
 */
export function computeFOV(
  tiles: Tile[][],
  ox: number,
  oy: number,
  radius: number
): Set<string> {
  const visible = new Set<string>([`${ox},${oy}`]);
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  const r2 = radius * radius;

  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) visible.add(`${x},${y}`);
  };

  // Cast many rays around the full circle; denser than 360/radius grid steps
  const rays = Math.max(64, radius * 16);
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let prevX = ox;
    let prevY = oy;

    for (let step = 1; step <= radius + 1; step++) {
      const x = ox + Math.round(cos * step);
      const y = oy + Math.round(sin * step);
      if (x === prevX && y === prevY) continue;
      prevX = x;
      prevY = y;

      if (x < 0 || y < 0 || x >= width || y >= height) break;

      const dist2 = (x - ox) * (x - ox) + (y - oy) * (y - oy);
      if (dist2 > r2 + radius) break; // small slack so perimeter walls light

      mark(x, y);
      if (blocksVision(tiles, x, y)) break;
    }
  }

  // Also mark immediate cardinal/diagonal neighbors for snappy close-range feel
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      mark(ox + dx, oy + dy);
    }
  }

  return visible;
}

export interface SpawnOptions {
  /** Prefer tiles at least this far (chebyshev) from anchor. */
  minDistanceFrom?: { x: number; y: number };
  minDistance?: number;
  /** Prefer spawning inside these rooms (e.g. barracks/zoo). */
  preferRooms?: Room[];
  /** Avoid these rooms (e.g. player start). */
  avoidRooms?: Room[];
  /** Allow door tiles as spawns (default false). */
  allowDoors?: boolean;
}

function openFloorCandidates(
  dungeon: Dungeon,
  occupied: Set<string>,
  options: SpawnOptions = {}
): { x: number; y: number }[] {
  const candidates: { x: number; y: number }[] = [];
  const allowDoors = options.allowDoors ?? false;
  const minDist = options.minDistance ?? 0;
  const anchor = options.minDistanceFrom;

  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      const t = dungeon.tiles[y][x];
      if (t === ">") continue;
      if (t === "<") continue;
      if (t === "+") {
        if (!allowDoors) continue;
      } else if (t !== ".") {
        continue;
      }
      if (dungeon.stairsDown.x === x && dungeon.stairsDown.y === y) continue;
      if (dungeon.stairsUp.x === x && dungeon.stairsUp.y === y) continue;

      if (anchor && minDist > 0) {
        const d = Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y));
        if (d < minDist) continue;
      }

      if (options.avoidRooms?.some((r) => pointInRoom(r, x, y))) continue;

      candidates.push({ x, y });
    }
  }
  return candidates;
}

/**
 * Deterministic spawn when `rng` is provided; falls back to Math.random only if omitted
 * (legacy callers). Prefer always passing rng for seed fidelity.
 */
export function findSpawnPoint(
  dungeon: Dungeon,
  occupied: Set<string>,
  rng?: RNG,
  options: SpawnOptions = {}
): { x: number; y: number } | null {
  let candidates = openFloorCandidates(dungeon, occupied, options);

  if (options.preferRooms?.length) {
    const preferred = candidates.filter((c) =>
      options.preferRooms!.some((r) => pointInRoom(r, c.x, c.y))
    );
    if (preferred.length) candidates = preferred;
  }

  if (candidates.length === 0) {
    // Relax constraints once
    candidates = openFloorCandidates(dungeon, occupied, {
      allowDoors: options.allowDoors,
    });
  }
  if (candidates.length === 0) return null;

  if (rng) return rng.pick(candidates);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Random open floor tile inside a room (for vault loot clusters). */
export function randomPointInRoom(
  room: Room,
  occupied: Set<string>,
  rng?: RNG
): { x: number; y: number } | null {
  const candidates: { x: number; y: number }[] = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const key = `${x},${y}`;
      if (!occupied.has(key)) candidates.push({ x, y });
    }
  }
  if (!candidates.length) return null;
  if (rng) return rng.pick(candidates);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Entry safe radius for general floor fill (chebyshev from stairsUp).
 * d1 tutorial landing is clearer; FOV packs use a tighter minDistance deliberately.
 * DENSITY_COORD / spawn-ecology — do not door-ambush new players.
 */
export function spawnSafeRadius(depth: number): number {
  const d = Math.max(1, depth);
  if (d <= 1) return 4;
  if (d <= 5) return 3;
  return 2;
}

/**
 * Depth-scaled monster placement plan (d1–5 density quality):
 * - Safe landing around entry stairs (`spawnSafeRadius`)
 * - Dens ALWAYS get full packs (may exceed `count`) — zoo/barracks/graveyard/throne/beehive
 *   via isDenSpecial + densPackSize (world-events). Themed kinds: planDenPackSpawns /
 *   pickDenMonsterKind at spawn-ecology call sites (game/world), not here.
 * - Near-entry rooms + corridor sentries so FOV (not whole-map) shows life
 * - Count is a floor-wide minimum after dens/vaults/foyer packs
 */
export function planMonsterSpawns(
  dungeon: Dungeon,
  depth: number,
  count: number,
  rng: RNG,
  occupied: Set<string>
): { x: number; y: number }[] {
  const spawns: { x: number; y: number }[] = [];
  const entry = dungeon.stairsUp;
  const startRoom = dungeon.rooms[0];
  // Dens: barracks | zoo | graveyard | throne | beehive (isDenSpecial)
  const dens = dungeon.rooms.filter((r) => isDenSpecial(r.special));
  const vaults = dungeon.rooms.filter((r) => r.special === "vault");

  // General fill / far rooms — keep stairs breathable
  const safeRadius = spawnSafeRadius(depth);
  // FOV packs may sit closer (still off the stair tile itself)
  const fovMinDist = 2;

  const placeIn = (
    preferRooms: Room[] | undefined,
    minDistance: number,
    avoidStart: boolean
  ): { x: number; y: number } | null => {
    const pos = findSpawnPoint(dungeon, occupied, rng, {
      preferRooms,
      avoidRooms: avoidStart && startRoom ? [startRoom] : undefined,
      minDistanceFrom: entry,
      minDistance,
    });
    if (!pos) return null;
    occupied.add(`${pos.x},${pos.y}`);
    spawns.push(pos);
    return pos;
  };

  // 1) Dens packs ALWAYS full — not clipped by count (NetHack zoo/barracks feel)
  // d1–5: densPackSize already elevated; still try full pack, dens minDist=2 (not safeRadius)
  for (const room of dens) {
    const pack = densPackSize(room.special ?? null, depth, rng);
    for (let i = 0; i < pack; i++) {
      if (!placeIn([room], 2, false)) break;
    }
  }

  // 2) Vault guardians (shallow vaults get at least a sentry)
  for (const room of vaults) {
    const guards = depth >= 7 ? 3 : depth >= 3 ? 2 : 1;
    for (let i = 0; i < guards; i++) {
      if (!placeIn([room], 1, false)) break;
    }
  }

  // 3) Near-entry room packs — FOV compensation (map is large; torch is short)
  const nearRooms = dungeon.rooms
    .filter((r) => r !== startRoom && !isDenSpecial(r.special))
    .map((r) => {
      const cx = r.x + Math.floor(r.w / 2);
      const cy = r.y + Math.floor(r.h / 2);
      const dist = Math.max(Math.abs(cx - entry.x), Math.abs(cy - entry.y));
      return { room: r, dist };
    })
    .sort((a, b) => a.dist - b.dist);

  // d1–5: denser foyer so new players see life immediately
  const foyerTarget =
    depth <= 2 ? rng.int(5, 8) : depth <= 5 ? rng.int(4, 7) : rng.int(2, 4);
  let foyerPlaced = 0;
  for (const { room, dist } of nearRooms) {
    if (foyerPlaced >= foyerTarget) break;
    // Prefer rooms the player will walk into within a few turns (FOV ~8 + corridor)
    if (dist > 16) break;
    const pack =
      dist <= 8
        ? depth <= 5
          ? rng.int(2, 4)
          : rng.int(1, 3)
        : depth <= 5
          ? rng.int(1, 3)
          : rng.int(1, 2);
    for (let i = 0; i < pack && foyerPlaced < foyerTarget; i++) {
      // FOV packs: closer than safeRadius, still off stairs
      const minD = dist <= 8 ? fovMinDist : safeRadius;
      if (placeIn([room], minD, true)) foyerPlaced++;
      else break;
    }
  }

  // 3b) Corridor sentries in torchlight of stairs (FOV never shows whole map)
  // d1–5: always try at least 2 so mean near-stairs density holds
  const sentryWant =
    depth <= 2 ? rng.int(3, 5) : depth <= 5 ? rng.int(2, 4) : rng.int(0, 2);
  if (sentryWant > 0) {
    const corridorNear: { x: number; y: number }[] = [];
    for (let y = 0; y < dungeon.height; y++) {
      for (let x = 0; x < dungeon.width; x++) {
        if (dungeon.tiles[y][x] !== ".") continue;
        const key = `${x},${y}`;
        if (occupied.has(key)) continue;
        if (startRoom && pointInRoom(startRoom, x, y)) continue;
        if (dungeon.rooms.some((r) => pointInRoom(r, x, y))) continue;
        const d = Math.max(Math.abs(x - entry.x), Math.abs(y - entry.y));
        // Inside FOV (~8), off stair cluster (not door ambush on tile itself)
        if (d < fovMinDist || d > 8) continue;
        corridorNear.push({ x, y });
      }
    }
    if (corridorNear.length) {
      const picks = rng.shuffle(corridorNear);
      for (let i = 0; i < sentryWant && i < picks.length; i++) {
        const pos = picks[i];
        occupied.add(`${pos.x},${pos.y}`);
        spawns.push(pos);
      }
    }
  }

  // 4) Far ordinary rooms (beyond foyer) — d1–6 never leave dead wings empty
  if (depth <= 6) {
    for (const { room, dist } of nearRooms) {
      if (dist <= 16) continue; // foyer already handled
      if (room.special === "vault") continue;
      const n = depth <= 5 ? rng.int(1, 2) : 1;
      for (let i = 0; i < n; i++) {
        if (spawns.length >= count + 10) break;
        if (!placeIn([room], safeRadius, true)) break;
      }
    }
  }

  // 5) Fill remaining across the floor until floor minimum `count`
  while (spawns.length < count) {
    const pos = placeIn(undefined, safeRadius, true);
    if (pos) continue;
    const fallback = findSpawnPoint(dungeon, occupied, rng, {
      minDistanceFrom: entry,
      minDistance: fovMinDist,
    });
    if (!fallback) break;
    occupied.add(`${fallback.x},${fallback.y}`);
    spawns.push(fallback);
  }

  return spawns;
}

/**
 * Corridor scrap item tiles (floor `.` not inside any room AABB).
 * Early depths scatter more so the walk between rooms always has loot.
 */
export function planCorridorScraps(
  dungeon: Dungeon,
  depth: number,
  rng: RNG,
  occupied: Set<string>
): { x: number; y: number }[] {
  const scraps: { x: number; y: number }[] = [];
  const want =
    depth <= 2 ? rng.int(4, 8) : depth <= 4 ? rng.int(3, 6) : depth <= 8 ? rng.int(2, 4) : rng.int(1, 3);

  const candidates: { x: number; y: number }[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      if (dungeon.tiles[y][x] !== ".") continue;
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      if (dungeon.stairsUp.x === x && dungeon.stairsUp.y === y) continue;
      if (dungeon.stairsDown.x === x && dungeon.stairsDown.y === y) continue;
      if (dungeon.rooms.some((r) => pointInRoom(r, x, y))) continue;
      // Keep scraps off the immediate stair tile cluster
      const d = Math.max(Math.abs(x - dungeon.stairsUp.x), Math.abs(y - dungeon.stairsUp.y));
      if (d < 2) continue;
      candidates.push({ x, y });
    }
  }
  if (!candidates.length) return scraps;

  const shuffled = rng.shuffle(candidates);
  for (let i = 0; i < want && i < shuffled.length; i++) {
    const pos = shuffled[i];
    occupied.add(`${pos.x},${pos.y}`);
    scraps.push(pos);
  }
  return scraps;
}

/** Depth-scaled monster count recommendation (aligned with monsterCountRange). */
export function monsterCountForDepth(depth: number, rng: RNG): number {
  // Keep dungeon helper in sync with entities.monsterCountRange early boost
  const baseMin = 10 + Math.floor(depth * 1.2) + (depth <= 5 ? 6 : 0);
  const baseMax = 16 + depth * 2 + (depth <= 5 ? 8 : 0);
  return rng.int(baseMin, baseMax);
}
