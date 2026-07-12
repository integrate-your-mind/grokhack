/**
 * TICKET-WE-01 — Random floor events (nethack-research §3.3).
 *
 * Isolated pure module: reinforce / migration / haunt (+ pollution for blood_moon later).
 * Hooks: server/world.ts floor tick, optional src/game.ts endTurn.
 *
 * Does NOT own monsterCountRange (spawn-ecology) or RoomSpecial assignment (algorithms).
 */
import { findSpawnPoint, randomPointInRoom } from "./dungeon";
import { createMonster, pickMonsterKind } from "./entities";
import type { RNG } from "./rng";
import type { Dungeon, Entity, MonsterKind, Room } from "./types";

export type FloorEventId =
  | "reinforce"
  | "migration"
  | "haunt"
  | "cave_in"
  | "fountain"
  | "blood_moon";

/** Per-floor bookkeeping for events + future blood_moon. */
export interface FloorEventBook {
  /** Last turn any mechanical floor event fired. */
  lastEventTurn: number;
  /** Cumulative kills + corpses (blood_moon input). */
  pollution: number;
  /** Last turn we evaluated reinforce cadence. */
  lastReinforceCheckTurn: number;
  /** Turn until which migration is suppressed. */
  migrationCooldownTurn: number;
  fountainUsed?: boolean;
  throneSat?: Record<string, boolean>;
  /** Remaining turns of blood_moon pressure (optional future). */
  bloodMoonTurnsLeft?: number;
}

export function createFloorEventBook(): FloorEventBook {
  return {
    lastEventTurn: 0,
    pollution: 0,
    lastReinforceCheckTurn: 0,
    migrationCooldownTurn: 0,
  };
}

export function ensureFloorEventBook(
  book: FloorEventBook | undefined | null
): FloorEventBook {
  if (!book || typeof book.lastEventTurn !== "number") return createFloorEventBook();
  if (typeof book.pollution !== "number") book.pollution = 0;
  if (typeof book.lastReinforceCheckTurn !== "number") book.lastReinforceCheckTurn = 0;
  if (typeof book.migrationCooldownTurn !== "number") book.migrationCooldownTurn = 0;
  return book;
}

/** Increment pollution (kills/corpses) — callers in combat/world. */
export function notePollution(book: FloorEventBook, amount = 1): void {
  book.pollution = Math.max(0, book.pollution + amount);
}

export interface FloorEventContext {
  depth: number;
  /** Aggregate team-turns on this floor (MMO) or player turns (SP). */
  turn: number;
  monsterCount: number;
  /** From monsterCountRange(depth).min — do not recompute density tables here. */
  bandMin: number;
  pollution: number;
  /** Layout for spawn placement (required for real spawns). */
  dungeon: Dungeon;
  occupied: Set<string>;
  /** Acting / random player anchor for haunt. */
  playerPos: { x: number; y: number };
  hasGraveyard?: boolean;
  /** Mutable book — updated when an event fires. */
  book: FloorEventBook;
}

export interface FloorEventSpawn {
  x: number;
  y: number;
  kind: MonsterKind;
}

export interface FloorEventResult {
  id: FloorEventId;
  message: string;
  /** Extra lines (optional). */
  messages?: string[];
  spawns?: FloorEventSpawn[];
  pollutionDelta?: number;
}

/** Sparse if living monsters < 60% of band minimum. */
export function isFloorSparse(monsterCount: number, bandMin: number): boolean {
  return monsterCount < bandMin * 0.6;
}

/** Tutorial shield: no harsh events on d1 for the first 20 turns. */
export function isTutorialQuiet(depth: number, turn: number): boolean {
  return depth <= 1 && turn < 20;
}

/**
 * maybeFireFloorEvent — §3.3 primary API.
 *
 * Priority when eligible:
 * 1. reinforce (sparse + 40–80 turn cadence)
 * 2. migration (d3+, ~8% per 50-turn window)
 * 3. haunt (graveyard present or 5% d5+)
 *
 * Returns null when tutorial-quiet, on cooldown, or RNG misses.
 */
export function maybeFireFloorEvent(
  ctx: FloorEventContext,
  rng: RNG
): FloorEventResult | null {
  const { depth, turn, monsterCount, bandMin, book } = ctx;

  if (isTutorialQuiet(depth, turn)) return null;

  // Global min gap between any mechanical events (anti-spam)
  if (turn - book.lastEventTurn < 12 && book.lastEventTurn > 0) return null;

  // 1) Reinforce — primary anti-empty
  if (isFloorSparse(monsterCount, bandMin)) {
    const since = turn - book.lastReinforceCheckTurn;
    // Cadence 40–80 turns between reinforce attempts once sparse
    const interval = book.lastReinforceCheckTurn === 0 ? 40 : rng.int(40, 80);
    if (book.lastReinforceCheckTurn === 0 || since >= interval) {
      book.lastReinforceCheckTurn = turn;
      const result = buildReinforce(ctx, rng);
      if (result) {
        book.lastEventTurn = turn;
        return result;
      }
    }
  }

  // 2) Migration — d3+, roughly 8% per 50-turn window (int roll avoids first-draw LCG bias)
  if (depth >= 3 && turn >= book.migrationCooldownTurn) {
    if (turn > 0 && turn % 50 === 0 && rng.int(1, 100) <= 8) {
      const result = buildMigration(ctx, rng);
      if (result) {
        book.lastEventTurn = turn;
        book.migrationCooldownTurn = turn + 50;
        return result;
      }
    }
  }

  // 3) Haunt — graveyard floor or 5% on d5+ (int roll for stable rates)
  const hauntPct = ctx.hasGraveyard ? 12 : depth >= 5 ? 5 : 0;
  if (
    hauntPct > 0 &&
    turn - book.lastEventTurn >= 25 &&
    rng.int(1, 100) <= hauntPct
  ) {
    const result = buildHaunt(ctx, rng);
    if (result) {
      book.lastEventTurn = turn;
      return result;
    }
  }

  // Optional future: blood_moon when pollution high
  if (
    book.pollution >= 25 &&
    depth >= 4 &&
    (book.bloodMoonTurnsLeft ?? 0) <= 0 &&
    turn - book.lastEventTurn >= 40 &&
    rng.chance(0.04)
  ) {
    book.bloodMoonTurnsLeft = 30;
    book.lastEventTurn = turn;
    return {
      id: "blood_moon",
      message: "The air grows thick and red — a blood moon rises over this floor.",
      messages: ["Something in the dark hungers for more blood."],
    };
  }

  return null;
}

/**
 * Force-path for tests: attempt reinforce if sparse, ignoring cadence (not tutorial).
 */
export function forceReinforceIfSparse(
  ctx: FloorEventContext,
  rng: RNG
): FloorEventResult | null {
  if (isTutorialQuiet(ctx.depth, ctx.turn)) return null;
  if (!isFloorSparse(ctx.monsterCount, ctx.bandMin)) return null;
  const result = buildReinforce(ctx, rng);
  if (result) {
    ctx.book.lastEventTurn = ctx.turn;
    ctx.book.lastReinforceCheckTurn = ctx.turn;
  }
  return result;
}

/** Test/helper: force migration pack (ignores chance, respects tutorial). */
export function forceMigration(
  ctx: FloorEventContext,
  rng: RNG
): FloorEventResult | null {
  if (isTutorialQuiet(ctx.depth, ctx.turn)) return null;
  if (ctx.depth < 3) return null;
  const result = buildMigration(ctx, rng);
  if (result) {
    ctx.book.lastEventTurn = ctx.turn;
    ctx.book.migrationCooldownTurn = ctx.turn + 50;
  }
  return result;
}

/** Test/helper: force haunt (ignores chance, respects tutorial). */
export function forceHaunt(
  ctx: FloorEventContext,
  rng: RNG
): FloorEventResult | null {
  if (isTutorialQuiet(ctx.depth, ctx.turn)) return null;
  const result = buildHaunt(ctx, rng);
  if (result) {
    ctx.book.lastEventTurn = ctx.turn;
  }
  return result;
}

function buildReinforce(ctx: FloorEventContext, rng: RNG): FloorEventResult | null {
  const n = rng.int(1, 3);
  const spawns: FloorEventSpawn[] = [];
  const occupied = ctx.occupied;

  for (let i = 0; i < n; i++) {
    const pos = findSpawnPoint(ctx.dungeon, occupied, rng, {
      avoidRooms: ctx.dungeon.rooms[0] ? [ctx.dungeon.rooms[0]] : undefined,
      minDistanceFrom: ctx.playerPos,
      minDistance: ctx.depth <= 3 ? 6 : 5,
    });
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    spawns.push({
      x: pos.x,
      y: pos.y,
      kind: pickMonsterKind(ctx.depth, rng.next()),
    });
  }
  if (!spawns.length) return null;

  const message =
    spawns.length === 1
      ? "You hear distant footsteps approaching..."
      : `Distant howls — ${spawns.length} creatures are drawn to the scent of blood.`;

  return { id: "reinforce", message, spawns };
}

function buildMigration(ctx: FloorEventContext, rng: RNG): FloorEventResult | null {
  const rooms = ctx.dungeon.rooms.filter((_, i) => i > 0);
  const room: Room | undefined = rooms.length ? rng.pick(rooms) : ctx.dungeon.rooms[0];
  if (!room) return null;

  const packSize = rng.int(3, Math.min(6, 3 + Math.floor(ctx.depth / 3)));
  const spawns: FloorEventSpawn[] = [];
  const pool: MonsterKind[] =
    ctx.depth <= 5
      ? ["rat", "kobold", "goblin", "bat"]
      : ["goblin", "orc", "kobold", "snake"];

  for (let i = 0; i < packSize; i++) {
    const pos = randomPointInRoom(room, ctx.occupied, rng);
    if (!pos) {
      const fallback = findSpawnPoint(ctx.dungeon, ctx.occupied, rng, {
        preferRooms: [room],
        minDistanceFrom: ctx.playerPos,
        minDistance: 3,
      });
      if (!fallback) break;
      ctx.occupied.add(`${fallback.x},${fallback.y}`);
      spawns.push({ x: fallback.x, y: fallback.y, kind: rng.pick(pool) });
      continue;
    }
    ctx.occupied.add(`${pos.x},${pos.y}`);
    spawns.push({ x: pos.x, y: pos.y, kind: rng.pick(pool) });
  }
  if (!spawns.length) return null;

  return {
    id: "migration",
    message: `A migrating pack surges into the halls (${spawns.length} beasts)!`,
    messages: ["Pack migration — the floor just got noisier."],
    spawns,
  };
}

function buildHaunt(ctx: FloorEventContext, rng: RNG): FloorEventResult | null {
  const undead: MonsterKind[] =
    ctx.depth >= 6 ? ["skeleton", "wraith"] : ["skeleton", "skeleton"];
  const graves = ctx.dungeon.rooms.filter((r) => r.special === "graveyard");
  const spawns: FloorEventSpawn[] = [];
  const n = 2;

  for (let i = 0; i < n; i++) {
    let pos: { x: number; y: number } | null = null;
    if (graves.length) {
      pos = randomPointInRoom(rng.pick(graves), ctx.occupied, rng);
    }
    if (!pos) {
      pos = findSpawnPoint(ctx.dungeon, ctx.occupied, rng, {
        minDistanceFrom: ctx.playerPos,
        minDistance: 2,
      });
    }
    if (!pos) break;
    ctx.occupied.add(`${pos.x},${pos.y}`);
    spawns.push({ x: pos.x, y: pos.y, kind: rng.pick(undead) });
  }

  return {
    id: "haunt",
    message: "A graveyard chill washes over you — the dead remember.",
    messages: [
      "Necrotic whispers curl from the dark.",
      spawns.length
        ? "Bones scrape together into shapes that should not walk."
        : "The chill passes. For now.",
    ],
    spawns: spawns.length ? spawns : undefined,
  };
}

/** Materialize spawn specs into entities. */
export function entitiesFromEventSpawns(
  spawns: FloorEventSpawn[],
  depth: number
): Entity[] {
  return spawns.map((s) => createMonster(s.kind, s.x, s.y, depth));
}

/**
 * Apply blood_moon decay each turn (optional hook).
 * Returns true if still under blood moon.
 */
export function tickBloodMoon(book: FloorEventBook): boolean {
  if ((book.bloodMoonTurnsLeft ?? 0) > 0) {
    book.bloodMoonTurnsLeft! -= 1;
    return book.bloodMoonTurnsLeft! > 0;
  }
  return false;
}
