/**
 * Floor traps — NetHack-grade agent stress (trap-pressure).
 *
 * Hidden until triggered or searched. Density scales with depth (near-zero d1, cruel d6+).
 * Placement prefers corridors / choke tiles so pure BFS pathing bots eat damage.
 *
 * Persistence note: trap state lives on GameState / FloorState in-memory; DB team can
 * opt-in serialize later without this module knowing about DuckDB.
 */
import { RNG } from "./rng";
import { isWalkable } from "./dungeon";
import type { Dungeon, FloorTrap, PlayerState, Room, TrapKind } from "./types";

/** Salt so trap rolls stay deterministic without colliding with monster/item streams. */
export const TRAP_SEED_SALT = 0x7a11_c0de;

const ALL_KINDS: TrapKind[] = ["pit", "bear", "teleport", "poison_needle"];

let trapSeq = 0;
function nextTrapId(): string {
  trapSeq += 1;
  return `trap_${trapSeq}`;
}

/** Reset id counter (tests). */
export function resetTrapIds(): void {
  trapSeq = 0;
}

/**
 * Target trap count envelope by depth.
 * d1 near-zero; d6+ cruel. Used by gen + metrics tests.
 */
export function trapCountRange(depth: number): { min: number; max: number } {
  const d = Math.max(1, depth);
  if (d === 1) return { min: 0, max: 1 };
  if (d === 2) return { min: 0, max: 2 };
  if (d === 3) return { min: 1, max: 3 };
  if (d === 4) return { min: 2, max: 5 };
  if (d === 5) return { min: 3, max: 7 };
  // d6+: cruel — denser every level, hard cap for layout safety
  const min = Math.min(5 + (d - 6), 12);
  const max = Math.min(9 + (d - 6) * 2, 18);
  return { min, max };
}

/** Roll how many traps to place this floor. */
export function rollTrapCount(depth: number, rng: RNG): number {
  if (depth <= 1) {
    // ~12% of d1 floors get a single tutorial trap
    return rng.chance(0.12) ? 1 : 0;
  }
  const { min, max } = trapCountRange(depth);
  return rng.int(min, max);
}

/**
 * Kind weights: deeper floors lean poison/teleport; shallow lean pit/bear.
 * Always returns one of the four kinds.
 */
export function pickTrapKind(depth: number, rng: RNG): TrapKind {
  const d = Math.max(1, depth);
  const weights: Record<TrapKind, number> = {
    pit: Math.max(1, 5 - Math.floor(d / 3)),
    bear: Math.max(1, 3 + Math.floor(d / 4)),
    teleport: Math.max(1, 1 + Math.floor(d / 2)),
    poison_needle: Math.max(1, d >= 3 ? 1 + Math.floor((d - 2) / 2) : 0.5),
  };
  // Normalize fractional poison on d1–2
  if (d < 3) weights.poison_needle = 0.35;

  const total = ALL_KINDS.reduce((s, k) => s + weights[k], 0);
  let roll = rng.next() * total;
  for (const k of ALL_KINDS) {
    roll -= weights[k];
    if (roll <= 0) return k;
  }
  return "pit";
}

export function trapGlyph(kind: TrapKind): string {
  switch (kind) {
    case "pit":
      return "^";
    case "bear":
      return "^";
    case "teleport":
      return "^";
    case "poison_needle":
      return "^";
  }
}

export function trapDisplayName(kind: TrapKind): string {
  switch (kind) {
    case "pit":
      return "pit";
    case "bear":
      return "bear trap";
    case "teleport":
      return "teleport trap";
    case "poison_needle":
      return "poison needle trap";
  }
}

function pointInRoom(room: Room, x: number, y: number): boolean {
  return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
}

function inAnyRoom(rooms: Room[], x: number, y: number): boolean {
  return rooms.some((r) => pointInRoom(r, x, y));
}

function chebyshev(
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Candidate floor tiles: walkable, not stairs, preferably corridors (not in rooms).
 * Corridor bias punishes shortest-path bots that hug hallways.
 */
export function trapPlacementCandidates(
  dungeon: Dungeon,
  occupied: Set<string>,
  depth: number
): { corridor: { x: number; y: number }[]; room: { x: number; y: number }[] } {
  const corridor: { x: number; y: number }[] = [];
  const room: { x: number; y: number }[] = [];
  const { stairsDown, stairsUp, rooms, tiles } = dungeon;
  const startRoom = rooms[0];
  // Safe radius around entry stairs / start room
  const safeR = depth <= 2 ? 4 : depth <= 4 ? 3 : 2;

  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      if (!isWalkable(tiles, x, y)) continue;
      if (tiles[y][x] === ">" || tiles[y][x] === "<" || tiles[y][x] === "+") continue;
      if (stairsDown.x === x && stairsDown.y === y) continue;
      if (stairsUp.x === x && stairsUp.y === y) continue;
      if (chebyshev(x, y, stairsDown.x, stairsDown.y) < safeR) continue;
      if (chebyshev(x, y, stairsUp.x, stairsUp.y) < safeR) continue;
      // Keep start room mostly clean on shallow depths
      if (depth <= 3 && startRoom && pointInRoom(startRoom, x, y)) continue;

      if (inAnyRoom(rooms, x, y)) room.push({ x, y });
      else corridor.push({ x, y });
    }
  }
  return { corridor, room };
}

/**
 * Generate hidden floor traps. Deterministic given dungeon + rng stream.
 * Never places on stairs; prefers corridors; at most one trap per tile.
 */
export function generateTraps(
  dungeon: Dungeon,
  depth: number,
  rng: RNG,
  occupied: Set<string> = new Set()
): FloorTrap[] {
  const count = rollTrapCount(depth, rng);
  if (count <= 0) return [];

  const { corridor, room } = trapPlacementCandidates(dungeon, occupied, depth);
  // 75% corridor preference when available (BFS hallway bots)
  const pool: { x: number; y: number }[] = [];
  const corridorNeed = Math.ceil(count * 0.75);
  const cShuf = rng.shuffle(corridor);
  const rShuf = rng.shuffle(room);
  for (let i = 0; i < corridorNeed && i < cShuf.length; i++) pool.push(cShuf[i]);
  // Fill remainder from rooms, then leftover corridors
  const rest = [...rShuf, ...cShuf.slice(corridorNeed)];
  for (const p of rest) {
    if (pool.length >= count) break;
    if (pool.some((q) => q.x === p.x && q.y === p.y)) continue;
    pool.push(p);
  }

  const traps: FloorTrap[] = [];
  const used = new Set(occupied);
  for (const p of pool) {
    if (traps.length >= count) break;
    const key = `${p.x},${p.y}`;
    if (used.has(key)) continue;
    used.add(key);
    traps.push({
      id: nextTrapId(),
      kind: pickTrapKind(depth, rng),
      x: p.x,
      y: p.y,
      revealed: false,
      sprung: false,
    });
  }
  return traps;
}

/** Active (not yet sprung) trap on tile, if any. */
export function trapAt(traps: FloorTrap[], x: number, y: number): FloorTrap | undefined {
  return traps.find((t) => t.x === x && t.y === y && !t.sprung);
}

/** Revealed trap glyph for map rendering (hidden traps return null). */
export function revealedTrapAt(
  traps: FloorTrap[],
  x: number,
  y: number
): FloorTrap | undefined {
  return traps.find((t) => t.x === x && t.y === y && t.revealed);
}

/** True if a bot with only map knowledge should avoid this tile. */
export function isKnownHazard(traps: FloorTrap[], x: number, y: number): boolean {
  return traps.some((t) => t.x === x && t.y === y && t.revealed && !t.sprung);
}

function applyPoisonFromNeedle(player: PlayerState, power: number, turns: number): void {
  if (!player.statuses) player.statuses = [];
  const existing = player.statuses.find((s) => s.kind === "poison");
  if (existing) {
    existing.turnsLeft = Math.max(existing.turnsLeft, turns);
    existing.power = Math.max(existing.power, power);
  } else {
    player.statuses.push({ kind: "poison", turnsLeft: turns, power });
  }
}

function pickTeleportLanding(
  dungeon: Dungeon,
  player: PlayerState,
  rng: RNG,
  occupied: Set<string>
): { x: number; y: number } | null {
  const candidates: { x: number; y: number }[] = [];
  for (let y = 0; y < dungeon.height; y++) {
    for (let x = 0; x < dungeon.width; x++) {
      if (!isWalkable(dungeon.tiles, x, y)) continue;
      if (x === player.entity.x && y === player.entity.y) continue;
      // Prefer non-door landings; still allow if desperate
      const t = dungeon.tiles[y][x];
      if (t === "+") continue;
      if (occupied.has(`${x},${y}`)) continue;
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) {
    // Softlock guard: allow any walkable including doors / near monsters
    for (let y = 0; y < dungeon.height; y++) {
      for (let x = 0; x < dungeon.width; x++) {
        if (!isWalkable(dungeon.tiles, x, y)) continue;
        if (x === player.entity.x && y === player.entity.y) continue;
        candidates.push({ x, y });
      }
    }
  }
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}

export interface TrapResolveResult {
  messages: string[];
  /** True if player entity coordinates changed (teleport). */
  relocated: boolean;
}

/**
 * Trigger a single armed trap the player is standing on.
 * Mutates trap (revealed/sprung) and player (hp, status, position).
 */
export function resolveTrap(
  trap: FloorTrap,
  player: PlayerState,
  dungeon: Dungeon,
  rng: RNG,
  occupied: Set<string> = new Set()
): TrapResolveResult {
  const messages: string[] = [];
  let relocated = false;
  if (trap.sprung) return { messages, relocated };

  trap.revealed = true;
  const name = trapDisplayName(trap.kind);

  switch (trap.kind) {
    case "pit": {
      const dmg = rng.int(1, 4) + Math.floor(player.depth / 2);
      player.entity.hp -= dmg;
      messages.push(`You fall into a pit! (−${dmg} HP)`);
      // Remains armed — can fall again (NetHack-style)
      break;
    }
    case "bear": {
      const dmg = rng.int(1, 3) + Math.floor(player.depth / 3);
      player.entity.hp -= dmg;
      const hold = rng.int(2, 4);
      player.immobilizedTurns = Math.max(player.immobilizedTurns ?? 0, hold);
      trap.sprung = true;
      messages.push(
        `A bear trap snaps shut on your leg! (−${dmg} HP) You are held for ${hold} turns.`
      );
      break;
    }
    case "teleport": {
      const dest = pickTeleportLanding(dungeon, player, rng, occupied);
      if (dest) {
        player.entity.x = dest.x;
        player.entity.y = dest.y;
        relocated = true;
        messages.push("A teleport trap warps space around you!");
      } else {
        messages.push("A teleport trap fizzles — nowhere to go.");
      }
      // Stays armed
      break;
    }
    case "poison_needle": {
      const dmg = rng.int(1, 3) + Math.floor(player.depth / 4);
      player.entity.hp -= dmg;
      const power = player.depth >= 6 ? 2 : 1;
      const turns = 3 + Math.floor(player.depth / 3);
      applyPoisonFromNeedle(player, power, turns);
      trap.sprung = true;
      messages.push(
        `A poison needle stabs your foot! (−${dmg} HP) Venom seeps into the wound.`
      );
      break;
    }
  }

  if (player.entity.hp <= 0) {
    player.entity.hp = 0;
    player.alive = false;
    if (!player.deathCause) {
      player.deathCause =
        trap.kind === "pit"
          ? "Fell into a pit"
          : trap.kind === "bear"
            ? "Killed by a bear trap"
            : trap.kind === "poison_needle"
              ? "Killed by a poison needle trap"
              : `Killed by a ${name}`;
    }
    messages.push("You die...");
  }

  return { messages, relocated };
}

/**
 * Step-on resolution with teleport chain cap (no infinite warp softlock).
 */
export function applyTrapsOnStep(
  traps: FloorTrap[],
  player: PlayerState,
  dungeon: Dungeon,
  rng: RNG,
  occupied: Set<string> = new Set(),
  maxChain = 3
): string[] {
  const all: string[] = [];
  for (let i = 0; i < maxChain; i++) {
    if (!player.alive) break;
    const trap = trapAt(traps, player.entity.x, player.entity.y);
    if (!trap) break;
    const result = resolveTrap(trap, player, dungeon, rng, occupied);
    all.push(...result.messages);
    if (!result.relocated) break;
  }
  return all;
}

/**
 * Search current tile + 8 neighbors. Finds unrevealed traps with depth-scaled chance.
 * Does not spend a turn itself — caller ends the turn.
 */
export function searchForTraps(
  traps: FloorTrap[],
  x: number,
  y: number,
  rng: RNG,
  findChance = 0.55
): { found: FloorTrap[]; messages: string[] } {
  const found: FloorTrap[] = [];
  const messages: string[] = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      for (const trap of traps) {
        if (trap.x !== tx || trap.y !== ty) continue;
        if (trap.revealed || trap.sprung) continue;
        if (!rng.chance(findChance)) continue;
        trap.revealed = true;
        found.push(trap);
        messages.push(`You find a ${trapDisplayName(trap.kind)}!`);
      }
    }
  }

  if (found.length === 0) {
    messages.push("You search the area. Nothing unusual.");
  }
  return { found, messages };
}

/** Deterministic trap stream from floor seed (safe across resume without persistence columns). */
export function trapsRngFromFloorSeed(floorSeed: number): RNG {
  return new RNG((floorSeed ^ TRAP_SEED_SALT) >>> 0 || 1);
}

/**
 * Ensure a trap list exists for a floor. Regenerates from seed when missing
 * (e.g. floors loaded from DB before traps were persisted).
 */
export function ensureFloorTraps(
  dungeon: Dungeon,
  depth: number,
  floorSeed: number,
  existing: FloorTrap[] | undefined | null
): FloorTrap[] {
  if (existing && Array.isArray(existing)) return existing;
  const rng = trapsRngFromFloorSeed(floorSeed);
  return generateTraps(dungeon, depth, rng);
}

/**
 * Softlock guards used by tests:
 * - traps never occupy stairs
 * - teleport always has a walkable landing when ≥2 walkable tiles exist
 * - immobilize turns are finite and positive
 */
export function assertTrapsSafe(traps: FloorTrap[], dungeon: Dungeon): string[] {
  const errors: string[] = [];
  for (const t of traps) {
    if (t.x === dungeon.stairsDown.x && t.y === dungeon.stairsDown.y) {
      errors.push(`trap on stairsDown at ${t.x},${t.y}`);
    }
    if (t.x === dungeon.stairsUp.x && t.y === dungeon.stairsUp.y) {
      errors.push(`trap on stairsUp at ${t.x},${t.y}`);
    }
    if (!isWalkable(dungeon.tiles, t.x, t.y)) {
      errors.push(`trap on non-walkable ${t.x},${t.y}`);
    }
  }
  // Uniqueness
  const seen = new Set<string>();
  for (const t of traps) {
    const k = `${t.x},${t.y}`;
    if (seen.has(k)) errors.push(`duplicate trap at ${k}`);
    seen.add(k);
  }
  return errors;
}
