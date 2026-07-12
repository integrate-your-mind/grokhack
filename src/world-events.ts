/**
 * World events & encounter variety (world-events team).
 *
 * - Timed monster reinforcements on shared multiplayer floors
 * - Environmental events with mechanical effects (not flavor-only)
 * - Themed dens for zoo / barracks / graveyard / throne packs
 *
 * Coordinate: trap-pressure (traps.ts), abyss-floors (depth tables),
 * algorithms (dungeon room specials — thin handoffs only).
 */
import { findSpawnPoint, isWalkable, randomPointInRoom } from "./dungeon";
import { createMonster, pickBeehiveMonsterKind, pickMonsterKind } from "./entities";
import { RNG } from "./rng";
import type {
  Dungeon,
  Entity,
  FloorEventState,
  MonsterKind,
  PlayerState,
  Room,
  RoomSpecial,
} from "./types";

export type { FloorEventState };

/** Salt so event RNG streams stay independent of traps/monsters. */
export const WORLD_EVENT_SEED_SALT = 0x3e3e_7e11;

export function createFloorEventState(): FloorEventState {
  return {
    turnCounter: 0,
    lastReinforcementTurn: 0,
    lastEnvEventTurn: 0,
    lastAmbientTurn: 0,
    enteredSpecials: [],
    discoveredSpecials: [],
    packSpotted: [],
    floorEnterDone: false,
  };
}

export function ensureFloorEventState(
  state: FloorEventState | undefined | null
): FloorEventState {
  if (!state || typeof state.turnCounter !== "number") return createFloorEventState();
  // Backfill fields for floors hydrated mid-session / older saves
  if (typeof state.lastAmbientTurn !== "number") state.lastAmbientTurn = 0;
  if (!Array.isArray(state.enteredSpecials)) state.enteredSpecials = [];
  if (!Array.isArray(state.discoveredSpecials)) state.discoveredSpecials = [];
  if (!Array.isArray(state.packSpotted)) state.packSpotted = [];
  if (typeof state.floorEnterDone !== "boolean") state.floorEnterDone = false;
  return state;
}

/** Deterministic event stream: seed + depth + turn (+ optional stream salt). */
export function eventRng(seed: number, depth: number, turn: number, stream = 0): RNG {
  // Mix without importing crypto — stable across SP and MMO
  const mixed =
    ((seed ^ WORLD_EVENT_SEED_SALT) +
      depth * 7919 +
      turn * 104729 +
      stream * 2654435761) >>>
    0;
  return new RNG(mixed || 1);
}

// ——— Reinforcement (wandering monsters / respawn pressure) ———

/**
 * Turns between reinforcement checks on a shared floor.
 * Faster pressure deeper and when the floor is nearly cleared.
 */
export function reinforcementInterval(depth: number, aliveMonsters: number): number {
  const d = Math.max(1, depth);
  // CEO empty-floor: d1–5 reinforce faster so "something always arrives"
  const base = d <= 3 ? 16 : d <= 5 ? 18 : d <= 7 ? 22 : d <= 10 ? 18 : 14;
  // Cleared floors reinforce sooner so multiplayer never feels empty
  // Floor of 8 so thin floors never reinforce faster than a short combat burst
  if (aliveMonsters <= 2) return Math.max(8, Math.floor(base * 0.45));
  if (aliveMonsters <= 5) return Math.max(10, Math.floor(base * 0.7));
  return base;
}

/** Soft cap so floors don't balloon forever. */
export function reinforcementCap(depth: number, playersOnFloor: number): number {
  const d = Math.max(1, depth);
  const bandBase = 10 + d * 2 + (d >= 9 ? 3 : 0);
  const multiplayer = Math.min(6, Math.max(0, playersOnFloor - 1) * 2);
  return bandBase + 6 + multiplayer;
}

export function shouldReinforce(opts: {
  depth: number;
  aliveMonsters: number;
  playersOnFloor: number;
  eventState: FloorEventState;
  /** Prefer reinforcing only when someone is present. */
  requirePlayers?: boolean;
}): boolean {
  const { depth, aliveMonsters, playersOnFloor, eventState } = opts;
  if ((opts.requirePlayers ?? true) && playersOnFloor <= 0) return false;
  if (aliveMonsters >= reinforcementCap(depth, playersOnFloor)) return false;
  const interval = reinforcementInterval(depth, aliveMonsters);
  return eventState.turnCounter - eventState.lastReinforcementTurn >= interval;
}

export interface ReinforcementPlan {
  kind: "reinforcement";
  positions: { x: number; y: number; monsterKind: MonsterKind }[];
  message: string;
}

/**
 * Plan 1–3 wandering monsters far from players when the floor thins out.
 */
export function planReinforcement(
  dungeon: Dungeon,
  depth: number,
  aliveMonsters: number,
  playersOnFloor: number,
  occupied: Set<string>,
  playerPositions: { x: number; y: number }[],
  rng: RNG
): ReinforcementPlan | null {
  if (playersOnFloor <= 0) return null;
  const cap = reinforcementCap(depth, playersOnFloor);
  const room = Math.max(0, cap - aliveMonsters);
  if (room <= 0) return null;

  const count = Math.min(room, rng.int(1, Math.min(3, 1 + Math.floor(depth / 5))));
  const positions: ReinforcementPlan["positions"] = [];
  const avoid = playerPositions[0] ?? dungeon.stairsUp;

  for (let i = 0; i < count; i++) {
    const pos = findSpawnPoint(dungeon, occupied, rng, {
      avoidRooms: dungeon.rooms[0] ? [dungeon.rooms[0]] : undefined,
      minDistanceFrom: avoid,
      minDistance: depth <= 3 ? 6 : 5,
    });
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    positions.push({
      x: pos.x,
      y: pos.y,
      monsterKind: pickMonsterKind(depth, rng.next()),
    });
  }
  if (!positions.length) return null;

  const n = positions.length;
  const message =
    n === 1
      ? "You hear footsteps approaching from the dark..."
      : `Distant howls — ${n} creatures are drawn to the scent of blood.`;
  return { kind: "reinforcement", positions, message };
}

export function applyReinforcementPlan(
  plan: ReinforcementPlan,
  depth: number
): Entity[] {
  return plan.positions.map((p) =>
    createMonster(p.monsterKind, p.x, p.y, depth)
  );
}

// ——— Environmental events ———

export type EnvEventKind =
  | "cave_in"
  | "pack_migration"
  | "graveyard_haunt"
  | "shopkeeper_call"
  /** Foul gas — damage + hunger (d1–5 common). */
  | "gas_pocket"
  /** Close-range ambush spawns (mechanical pressure). */
  | "corridor_ambush";

export interface EnvEventResult {
  kind: EnvEventKind;
  messages: string[];
  /** Damage applied to the acting player (after defense-ish flat). */
  damageToPlayer?: number;
  /** Optional hunger tax. */
  hungerDrain?: number;
  /** Optional heal (rare gas pocket false alarm / clean air). */
  healToPlayer?: number;
  /** Monsters to spawn. */
  spawns?: { x: number; y: number; monsterKind: MonsterKind }[];
  /** Gold granted (shopkeeper / throne residue). */
  goldDelta?: number;
  /** Alert pack AI to hunt. */
  alertPacks?: boolean;
}

/** Min turns between environmental rolls (not counting reinforcements). */
export function envEventCooldown(depth: number): number {
  // Density coord: faster d1–5 cadence so something always happens
  return depth <= 2 ? 12 : depth <= 5 ? 16 : depth <= 8 ? 28 : 24;
}

/**
 * Roll a floor-wide environmental event with mechanical teeth.
 * Returns null when nothing fires this turn.
 */
export function rollEnvironmentalEvent(opts: {
  depth: number;
  dungeon: Dungeon;
  eventState: FloorEventState;
  occupied: Set<string>;
  playerPos: { x: number; y: number };
  rng: RNG;
  /** Has a graveyard room on this floor? */
  hasGraveyard?: boolean;
}): EnvEventResult | null {
  const { depth, dungeon, eventState, occupied, playerPos, rng } = opts;
  if (eventState.turnCounter - eventState.lastEnvEventTurn < envEventCooldown(depth)) {
    return null;
  }
  // Higher chance on d1–5 so early game feels eventful
  const fireChance =
    depth <= 5
      ? 0.34 + Math.min(0.1, depth * 0.015)
      : 0.18 + Math.min(0.12, depth * 0.01);
  if (!rng.chance(fireChance)) return null;

  const weights: { kind: EnvEventKind; w: number }[] = [
    { kind: "cave_in", w: 2.5 },
    { kind: "pack_migration", w: 3.5 },
    { kind: "graveyard_haunt", w: opts.hasGraveyard || depth >= 4 ? 3 : 0.5 },
    { kind: "shopkeeper_call", w: depth >= 3 ? 2 : 0.8 },
    // New: early floors lean gas + ambush so d1–5 never go quiet
    { kind: "gas_pocket", w: depth <= 5 ? 4 : 2 },
    { kind: "corridor_ambush", w: depth <= 5 ? 3.5 : 2.5 },
  ];
  const total = weights.reduce((s, x) => s + x.w, 0);
  let roll = rng.next() * total;
  let kind: EnvEventKind = "pack_migration";
  for (const row of weights) {
    roll -= row.w;
    if (roll <= 0) {
      kind = row.kind;
      break;
    }
  }

  switch (kind) {
    case "cave_in":
      return resolveCaveIn(depth, playerPos, dungeon, rng);
    case "pack_migration":
      return resolvePackMigration(depth, dungeon, occupied, playerPos, rng);
    case "graveyard_haunt":
      return resolveGraveyardHaunt(depth, dungeon, occupied, playerPos, rng, opts.hasGraveyard);
    case "shopkeeper_call":
      return resolveShopkeeperCall(depth, dungeon, occupied, playerPos, rng);
    case "gas_pocket":
      return resolveGasPocket(depth, rng);
    case "corridor_ambush":
      return resolveCorridorAmbush(depth, dungeon, occupied, playerPos, rng);
  }
}

function resolveCaveIn(
  depth: number,
  playerPos: { x: number; y: number },
  dungeon: Dungeon,
  rng: RNG
): EnvEventResult {
  // Mechanical teeth: flat damage + hunger from dust/choking (no map rewrite — safe for shared floors)
  const dmg = rng.int(2, 3 + Math.floor(depth / 3));
  const hungerDrain = rng.int(8, 18 + depth);
  return {
    kind: "cave_in",
    messages: [
      "The ceiling groans — rubble crashes nearby!",
      dmg > 0 ? `Falling stone clips you for ${dmg} damage.` : "You barely dodge the debris.",
    ],
    damageToPlayer: dmg,
    hungerDrain,
  };
}

/** Gas pocket — common d1–5 pressure: damage + hunger, rare clean breath heal. */
function resolveGasPocket(depth: number, rng: RNG): EnvEventResult {
  if (rng.chance(0.18)) {
    const heal = rng.int(2, 4 + Math.floor(depth / 4));
    return {
      kind: "gas_pocket",
      messages: [
        "A pocket of clean air opens — the fog thins.",
        `You catch your breath and recover ${heal} HP.`,
      ],
      healToPlayer: heal,
    };
  }
  const dmg = rng.int(1, 2 + Math.floor(depth / 3));
  const hungerDrain = rng.int(10, 20 + depth * 2);
  return {
    kind: "gas_pocket",
    messages: [
      "A foul gas pocket blooms in the corridor!",
      `You choke for ${dmg} damage as your appetite flees.`,
    ],
    damageToPlayer: dmg,
    hungerDrain,
  };
}

/**
 * Corridor ambush — 1–2 hostiles spawn near the actor (closer than pack migration).
 * Does not touch monsterCountRange bands — pure event spawns.
 */
function resolveCorridorAmbush(
  depth: number,
  dungeon: Dungeon,
  occupied: Set<string>,
  playerPos: { x: number; y: number },
  rng: RNG
): EnvEventResult {
  const n = rng.int(1, depth <= 3 ? 2 : 3);
  const spawns: EnvEventResult["spawns"] = [];
  const kinds: MonsterKind[] =
    depth <= 3
      ? ["rat", "kobold", "bat", "goblin"]
      : depth <= 7
        ? ["kobold", "goblin", "snake", "orc"]
        : ["orc", "goblin", "snake", "skeleton"];

  for (let i = 0; i < n; i++) {
    // Prefer near player but not on them — ambush range 2–5
    const pos = findSpawnPoint(dungeon, occupied, rng, {
      minDistanceFrom: playerPos,
      minDistance: 2,
    });
    if (!pos) break;
    // Reject if too far (want teeth near the actor)
    const cheb = Math.max(
      Math.abs(pos.x - playerPos.x),
      Math.abs(pos.y - playerPos.y)
    );
    if (cheb > 6) {
      // still accept occasionally so floors aren't starved of spawns
      if (!rng.chance(0.35)) continue;
    }
    occupied.add(`${pos.x},${pos.y}`);
    spawns.push({ x: pos.x, y: pos.y, monsterKind: rng.pick(kinds) });
  }

  if (!spawns.length) {
    return {
      kind: "corridor_ambush",
      messages: ["You sense an ambush forming — then it slips away."],
      alertPacks: true,
    };
  }

  return {
    kind: "corridor_ambush",
    messages: [
      spawns.length === 1
        ? "Ambush! Something drops from a side corridor!"
        : `Ambush! ${spawns.length} hostiles close in from the dark!`,
    ],
    spawns,
    alertPacks: true,
  };
}

function resolvePackMigration(
  depth: number,
  dungeon: Dungeon,
  occupied: Set<string>,
  playerPos: { x: number; y: number },
  rng: RNG
): EnvEventResult {
  const n = rng.int(2, Math.min(5, 2 + Math.floor(depth / 4)));
  const spawns: EnvEventResult["spawns"] = [];
  const packKinds: MonsterKind[] =
    depth <= 3
      ? ["rat", "rat", "bat", "kobold"]
      : depth <= 7
        ? ["rat", "kobold", "goblin", "snake"]
        : ["goblin", "orc", "snake", "bat"];

  for (let i = 0; i < n; i++) {
    const pos = findSpawnPoint(dungeon, occupied, rng, {
      minDistanceFrom: playerPos,
      minDistance: 4,
      avoidRooms: dungeon.rooms[0] ? [dungeon.rooms[0]] : undefined,
    });
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    spawns.push({
      x: pos.x,
      y: pos.y,
      monsterKind: rng.pick(packKinds),
    });
  }
  if (!spawns.length) {
    return {
      kind: "pack_migration",
      messages: ["You hear a distant migration of beasts — they pass you by."],
    };
  }
  return {
    kind: "pack_migration",
    messages: [
      `A migrating pack surges through the halls (${spawns.length} beasts)!`,
    ],
    spawns,
  };
}

function resolveGraveyardHaunt(
  depth: number,
  dungeon: Dungeon,
  occupied: Set<string>,
  playerPos: { x: number; y: number },
  rng: RNG,
  hasGraveyard?: boolean
): EnvEventResult {
  const graves = dungeon.rooms.filter((r) => r.special === "graveyard");
  const prefer = hasGraveyard && graves.length ? graves : null;
  const spawns: EnvEventResult["spawns"] = [];
  const n = rng.int(1, depth >= 8 ? 3 : 2);
  const undead: MonsterKind[] =
    depth >= 6 ? ["skeleton", "wraith", "skeleton"] : ["skeleton", "skeleton", "bat"];

  for (let i = 0; i < n; i++) {
    let pos: { x: number; y: number } | null = null;
    if (prefer) {
      const room = rng.pick(prefer);
      pos = randomPointInRoom(room, occupied, rng);
    }
    if (!pos) {
      pos = findSpawnPoint(dungeon, occupied, rng, {
        minDistanceFrom: playerPos,
        minDistance: 3,
      });
    }
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    spawns.push({ x: pos.x, y: pos.y, monsterKind: rng.pick(undead) });
  }

  const chill = rng.int(1, 2 + Math.floor(depth / 5));
  return {
    kind: "graveyard_haunt",
    messages: [
      "A cold wind rises — the dead remember this place.",
      chill > 0 ? `Necrotic chill saps ${chill} HP.` : "You steel yourself against the haunt.",
    ],
    damageToPlayer: chill,
    spawns: spawns.length ? spawns : undefined,
  };
}

function resolveShopkeeperCall(
  depth: number,
  dungeon: Dungeon,
  occupied: Set<string>,
  playerPos: { x: number; y: number },
  rng: RNG
): EnvEventResult {
  // Soft shopkeeper: gold tip OR a tough "guard" spawn if "shoplifting" vibe (depth pressure)
  if (rng.chance(0.55)) {
    const gold = rng.int(3, 8 + depth * 2);
    return {
      kind: "shopkeeper_call",
      messages: [
        "A gruff voice echoes: \"Don't touch the merchandise!\"",
        `You find ${gold} gold scattered near a abandoned stall.`,
      ],
      goldDelta: gold,
    };
  }
  const pos = findSpawnPoint(dungeon, occupied, rng, {
    minDistanceFrom: playerPos,
    minDistance: 3,
  });
  const guardKind: MonsterKind =
    depth >= 8 ? "ogre" : depth >= 5 ? "orc" : "goblin";
  if (!pos) {
    return {
      kind: "shopkeeper_call",
      messages: ["You hear a shop bell in the dark — nothing more."],
    };
  }
  occupied.add(`${pos.x},${pos.y}`);
  return {
    kind: "shopkeeper_call",
    messages: [
      "A shopkeeper's hired guard steps from the shadows!",
      `"No refunds," something growls.`,
    ],
    spawns: [{ x: pos.x, y: pos.y, monsterKind: guardKind }],
  };
}

// ——— Room specials with teeth (step-on / enter) ———

export function roomKey(room: Room): string {
  return `${room.x},${room.y},${room.special ?? "none"}`;
}

export function roomAt(dungeon: Dungeon, x: number, y: number): Room | undefined {
  return dungeon.rooms.find(
    (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
  );
}

export interface RoomStepResult {
  messages: string[];
  damage?: number;
  heal?: number;
  hungerDelta?: number;
  goldDelta?: number;
  /** Mark first-entry handled for this room. */
  markEntered?: string;
  spawns?: { x: number; y: number; monsterKind: MonsterKind }[];
}

/**
 * Mechanical effects when a player steps on a special room tile.
 * Fountain: center blessing/curse. Graveyard: chill on first entry + rare spawn.
 * Throne: gold or royal guard. Zoo/barracks: first-entry pack howl (no free damage).
 */
export function applyRoomSpecialOnStep(opts: {
  dungeon: Dungeon;
  x: number;
  y: number;
  depth: number;
  eventState: FloorEventState;
  occupied: Set<string>;
  rng: RNG;
  player: PlayerState;
}): RoomStepResult | null {
  const room = roomAt(opts.dungeon, opts.x, opts.y);
  if (!room?.special) return null;

  const special = room.special;
  const key = roomKey(room);
  const firstEntry = !opts.eventState.enteredSpecials.includes(key);

  if (special === "fountain") {
    return applyFountain(room, opts.x, opts.y, opts.depth, opts.rng, firstEntry, key);
  }
  if (special === "graveyard") {
    return applyGraveyardStep(
      room,
      opts.depth,
      opts.rng,
      firstEntry,
      key,
      opts.occupied
    );
  }
  if (special === "throne") {
    return applyThroneStep(room, opts.depth, opts.rng, firstEntry, key, opts.occupied);
  }
  if ((special === "zoo" || special === "barracks") && firstEntry) {
    return {
      messages: [
        special === "zoo"
          ? "You step into a monster zoo — cages hang open."
          : "You enter barracks still warm from recent drills.",
      ],
      markEntered: key,
    };
  }
  if (special === "shrine" && firstEntry) {
    return {
      messages: ["A forgotten shrine hums with residual magic."],
      markEntered: key,
    };
  }
  return null;
}

function applyFountain(
  room: Room,
  x: number,
  y: number,
  depth: number,
  rng: RNG,
  firstEntry: boolean,
  key: string
): RoomStepResult | null {
  const cx = room.x + Math.floor(room.w / 2);
  const cy = room.y + Math.floor(room.h / 2);
  // Only the basin center is magical; first entry always whispers
  if (x !== cx || y !== cy) {
    if (firstEntry) {
      return {
        messages: ["You hear water dripping from a stone fountain."],
        markEntered: key,
      };
    }
    return null;
  }
  // Mechanical teeth: heal OR poison/hunger tax
  if (rng.chance(0.55)) {
    const heal = rng.int(4, 8 + Math.floor(depth / 2));
    return {
      messages: [
        "You drink from the fountain. The water is cool and pure.",
        `You recover ${heal} HP.`,
      ],
      heal,
      markEntered: firstEntry ? key : undefined,
    };
  }
  const dmg = rng.int(2, 4 + Math.floor(depth / 3));
  return {
    messages: [
      "You drink from the fountain. The water tastes of iron and regret.",
      `The foul draft deals ${dmg} damage.`,
    ],
    damage: dmg,
    hungerDelta: -rng.int(10, 25),
    markEntered: firstEntry ? key : undefined,
  };
}

function applyGraveyardStep(
  room: Room,
  depth: number,
  rng: RNG,
  firstEntry: boolean,
  key: string,
  occupied: Set<string>
): RoomStepResult {
  const chill = firstEntry ? rng.int(1, 2 + Math.floor(depth / 6)) : rng.chance(0.12) ? 1 : 0;
  const messages: string[] = [];
  if (firstEntry) {
    messages.push("Gravestones lean in the torchlight. Something watches.");
  }
  if (chill > 0) {
    messages.push(`Grave-chill seeps into your bones (${chill} damage).`);
  }
  const spawns: RoomStepResult["spawns"] = [];
  if (firstEntry && rng.chance(0.4)) {
    const pos = randomPointInRoom(room, occupied, rng);
    if (pos) {
      occupied.add(`${pos.x},${pos.y}`);
      spawns.push({
        x: pos.x,
        y: pos.y,
        monsterKind: depth >= 6 && rng.chance(0.35) ? "wraith" : "skeleton",
      });
      messages.push("A corpse claws free of the dirt!");
    }
  }
  return {
    messages,
    damage: chill > 0 ? chill : undefined,
    markEntered: firstEntry ? key : undefined,
    spawns: spawns.length ? spawns : undefined,
  };
}

function applyThroneStep(
  room: Room,
  depth: number,
  rng: RNG,
  firstEntry: boolean,
  key: string,
  occupied: Set<string>
): RoomStepResult {
  if (!firstEntry) return { messages: [] };
  const messages = ["A cracked throne dominates the chamber."];
  if (rng.chance(0.5)) {
    const gold = rng.int(5, 12 + depth * 2);
    messages.push(`You pry ${gold} gold from the throne's fittings.`);
    return { messages, goldDelta: gold, markEntered: key };
  }
  const pos = randomPointInRoom(room, occupied, rng);
  const kind: MonsterKind = depth >= 7 ? "troll" : depth >= 4 ? "orc" : "goblin";
  if (pos) {
    occupied.add(`${pos.x},${pos.y}`);
    messages.push("The throne's guardian stirs!");
    return {
      messages,
      markEntered: key,
      spawns: [{ x: pos.x, y: pos.y, monsterKind: kind }],
    };
  }
  return { messages, markEntered: key };
}

// ——— Den / pack helpers for generation ———

/** Encounter specials beyond classic vault/shrine. */
export const ENCOUNTER_SPECIALS: RoomSpecial[] = [
  "vault",
  "shrine",
  "barracks",
  "zoo",
  "graveyard",
  "fountain",
  "throne",
  "alcove",
];

/**
 * Themed monster kind for dens. Prefer these when filling zoo/barracks/graveyard/throne.
 */
export function pickDenMonsterKind(
  special: RoomSpecial,
  depth: number,
  rng: RNG
): MonsterKind {
  switch (special) {
    case "zoo": {
      const pool: MonsterKind[] =
        depth >= 6
          ? ["rat", "bat", "snake", "kobold", "snake"]
          : ["rat", "rat", "bat", "kobold"];
      return rng.pick(pool);
    }
    case "barracks": {
      const pool: MonsterKind[] =
        depth >= 7
          ? ["goblin", "orc", "orc", "kobold", "skeleton"]
          : depth >= 3
            ? ["goblin", "kobold", "orc", "goblin"]
            : ["kobold", "goblin", "rat"];
      return rng.pick(pool);
    }
    case "graveyard": {
      const pool: MonsterKind[] =
        depth >= 6 ? ["skeleton", "wraith", "skeleton"] : ["skeleton", "skeleton", "bat"];
      return rng.pick(pool);
    }
    case "throne": {
      const pool: MonsterKind[] =
        depth >= 8 ? ["orc", "ogre", "troll"] : depth >= 5 ? ["orc", "goblin", "ogre"] : ["goblin", "orc"];
      return rng.pick(pool);
    }
    // P0-8 / bestiary handoff — dens always killer_bee pack (see entities.beehiveDenMonsterPool)
    case "beehive":
      return pickBeehiveMonsterKind(depth, rng.next());
    default:
      return pickMonsterKind(depth, rng.next());
  }
}

/** True for rooms that get dense monster packs (not fountain/shrine/vault alone). */
export function isDenSpecial(special: RoomSpecial | undefined | null): boolean {
  return (
    special === "barracks" ||
    special === "zoo" ||
    special === "graveyard" ||
    special === "throne" ||
    special === "beehive"
  );
}

/**
 * Pack size for dens — stronger zoo/barracks; graveyard undead packs; throne guards.
 * Depth-aware. Accepts legacy 2-arg form densPackSize(special, rng) (assumes mid depth).
 */
export function densPackSize(
  special: RoomSpecial | undefined | null,
  depthOrRng: number | RNG,
  rngMaybe?: RNG
): number {
  let depth: number;
  let rng: RNG;
  if (typeof depthOrRng === "number") {
    depth = depthOrRng;
    rng = rngMaybe as RNG;
  } else {
    depth = 5;
    rng = depthOrRng;
  }
  const d = Math.max(1, depth);
  switch (special) {
    case "zoo":
      // Stronger zoo packs
      return d <= 5 ? rng.int(7, 12) : rng.int(6, 11);
    case "barracks":
      return d <= 5 ? rng.int(5, 9) : rng.int(4, 7);
    case "graveyard":
      // Undead pack — thick mid dens
      return d <= 6 ? rng.int(5, 9) : rng.int(6, 10);
    case "throne":
      return d <= 7 ? rng.int(3, 5) : rng.int(4, 6);
    case "beehive":
      return d <= 5 ? rng.int(6, 10) : rng.int(5, 9);
    default:
      return 0;
  }
}

/**
 * Assign fountain / graveyard / throne without clobbering existing specials.
 * Safe to call after ALG-01 assignSpecialRooms: never duplicates a kind, never
 * exceeds remaining cap budget (pass maxExtra from specialRoomCap - used).
 * Gates: fountain d2+, graveyard d4+, throne d6+ (ALG-01 also places throne/grave d4+).
 */
export function assignEncounterSpecials(
  rooms: Room[],
  depth: number,
  rng: RNG,
  maxExtraBudget = 2
): void {
  if (rooms.length < 3) return;
  if (maxExtraBudget <= 0) return;
  const candidates = rng.shuffle(rooms.slice(1).filter((r) => !r.special));
  if (!candidates.length) return;

  const maxExtra = Math.min(
    maxExtraBudget,
    depth >= 8 ? 3 : depth >= 6 ? 2 : depth >= 4 ? 2 : 1
  );
  let added = 0;

  const has = (special: RoomSpecial): boolean => rooms.some((r) => r.special === special);

  const tryAssign = (special: RoomSpecial, chance: number, minDepth: number) => {
    if (added >= maxExtra) return;
    if (depth < minDepth) return;
    if (has(special)) return;
    if (!rng.chance(chance)) return;
    const room = candidates.find((r) => !r.special);
    if (!room) return;
    room.special = special;
    added++;
  };

  tryAssign("fountain", Math.min(0.38 + depth * 0.04, 0.72), 2);
  tryAssign("graveyard", Math.min(0.32 + (depth - 4) * 0.06, 0.62), 4);
  tryAssign("throne", Math.min(0.28 + (depth - 6) * 0.06, 0.55), 6);

  // Soft guarantee only when none of the encounter set exist yet (no duplicates)
  if (
    added === 0 &&
    depth >= 2 &&
    !has("fountain") &&
    !has("graveyard") &&
    !has("throne")
  ) {
    const room = candidates.find((r) => !r.special);
    if (room) {
      if (depth >= 6) {
        room.special = rng.chance(0.4) ? "throne" : "graveyard";
      } else if (depth >= 4) {
        room.special = rng.chance(0.55) ? "graveyard" : "fountain";
      } else {
        room.special = "fountain";
      }
      added++;
    }
  }
}

/**
 * Extra den positions beyond the global count — ensures zoo/barracks/graveyard/throne
 * always get real packs even when the floor budget is tight.
 */
export function planDenPackSpawns(
  dungeon: Dungeon,
  depth: number,
  occupied: Set<string>,
  rng: RNG
): { x: number; y: number; monsterKind: MonsterKind; special: RoomSpecial }[] {
  const out: {
    x: number;
    y: number;
    monsterKind: MonsterKind;
    special: RoomSpecial;
  }[] = [];
  const dens = dungeon.rooms.filter((r) => isDenSpecial(r.special));
  const entry = dungeon.stairsUp;

  for (const room of dens) {
    const special = room.special!;
    const pack = densPackSize(special, depth, rng);
    for (let i = 0; i < pack; i++) {
      const pos = findSpawnPoint(dungeon, occupied, rng, {
        preferRooms: [room],
        minDistanceFrom: entry,
        minDistance: 2,
      });
      if (!pos) break;
      // Ensure tile is walkable
      if (!isWalkable(dungeon.tiles, pos.x, pos.y)) continue;
      occupied.add(`${pos.x},${pos.y}`);
      out.push({
        x: pos.x,
        y: pos.y,
        monsterKind: pickDenMonsterKind(special, depth, rng),
        special,
      });
    }
  }
  return out;
}

/** Apply damage/heal/gold from an event onto a player state. Returns death message if killed. */
export function applyPlayerEventEffects(
  player: PlayerState,
  effects: {
    damage?: number;
    heal?: number;
    hungerDelta?: number;
    goldDelta?: number;
  }
): string | null {
  if (effects.heal && effects.heal > 0) {
    player.entity.hp = Math.min(player.entity.maxHp, player.entity.hp + effects.heal);
  }
  if (effects.damage && effects.damage > 0) {
    player.entity.hp -= effects.damage;
    if (player.entity.hp <= 0) {
      player.entity.hp = 0;
      player.alive = false;
      player.deathCause = player.deathCause ?? "Crushed by the dungeon itself";
      return "You succumb to the dungeon's wrath...";
    }
  }
  if (effects.hungerDelta) {
    player.hunger = Math.max(0, Math.min(player.maxHunger, player.hunger + effects.hungerDelta));
  }
  if (effects.goldDelta) {
    player.gold = Math.max(0, player.gold + effects.goldDelta);
  }
  return null;
}

/** Build entities from spawn specs. */
export function spawnFromSpecs(
  specs: { x: number; y: number; monsterKind: MonsterKind }[],
  depth: number
): Entity[] {
  return specs.map((s) => createMonster(s.monsterKind, s.x, s.y, depth));
}

// ——— Ambient flavor (alive floors beyond static spawns) ———

export type AmbientKind =
  | "whisper"
  | "stampede"
  | "shrine_omen"
  | "barracks_drill"
  | "vault_alarm"
  | "depth_beat"
  | "pack_spotted"
  | "floor_enter"
  | "rare_floor";

export interface AmbientEvent {
  kind: AmbientKind;
  messages: string[];
  /** Soft teeth: set nearby pack monsters to hunt. */
  alertPacks?: boolean;
  /** Soft teeth: tiny hunger tax (dungeon nerves). */
  hungerDrain?: number;
}

/** Min turns between ambient lines (richer early, still no spam). */
export function ambientInterval(depth: number): number {
  const d = Math.max(1, depth);
  if (d <= 2) return 7;
  if (d <= 5) return 9;
  if (d <= 10) return 12;
  return 14;
}

const WHISPERS_EARLY = [
  "You hear something moving in the dark...",
  "A drip of water counts the seconds between heartbeats.",
  "Claws tick stone just past the torch glow.",
  "A squeak answers another squeak — then silence.",
  "Dust sifts from the ceiling as something heavy shifts.",
  "Your torch gutters; the dark presses closer.",
  "A soft chittering circles the edge of hearing.",
  "Stone scrapes stone. Not wind. Not you.",
  "You smell wet fur and old blood.",
  "Something sniffs along a corridor you have not mapped.",
  "A low mutter of voices — or rats arguing over bones.",
  "The dark behind you feels occupied.",
];

const WHISPERS_DEEP = [
  "A growl rolls through the rock like distant thunder.",
  "You sense weight moving on floors above — or below.",
  "Something large shifts in the shadows.",
  "Footsteps scrape stone just out of sight.",
  "The air tastes of iron and old magic.",
  "A roar too far to place still makes your teeth ache.",
  "Your torchlight seems thinner here.",
];

const STAMPEDE = [
  "A rumble of many feet — a stampede is coming!",
  "Dust rises in the corridor: something runs as a pack.",
  "You hear the drum of claws — a swarm is on the move.",
  "Squeals and scrapes braiding into one charge.",
  "The floor vibrates. Small feet. Too many.",
];

const SHRINE_OMENS = [
  "A warm draft smells of incense — a shrine is near.",
  "Faint chanting threads the stone, then dies.",
  "Your skin prickles: old blessings still cling here.",
  "A soft light winks at the edge of vision, then is gone.",
  "You feel watched by something that is not hungry — only curious.",
];

const BARRACKS_DRILLS = [
  "You hear the clatter of weapons from a nearby barracks.",
  "Boots stamp in unison — drills, not a march past.",
  "A barked order echoes; something answers with a snarl.",
  "Shield rims knock wood. Someone is training for you.",
  "Armor jingles in cadence down an unseen hall.",
];

const VAULT_ALARMS = [
  "You sense a treasure vault nearby...",
  "A thin chime rings once — like a vault testing its locks.",
  "Gold-scented air; greed and danger share a room.",
  "Something mechanical clicks twice behind sealed stone.",
  "Your torch finds a glint that is not a puddle.",
];

const DEPTH_BEATS_EARLY = [
  "The dungeon settles around you, alive and uncaring.",
  "Corridors branch like questions you have not answered.",
  "Somewhere, a door closes that you did not open.",
  "Moss drinks the torchlight. The stone drinks sound.",
  "You are not the first on this floor — only the latest.",
  "A draft from deeper levels carries a colder story.",
];

const DEPTH_BEATS_MID = [
  "The stone here remembers violence.",
  "Your footsteps sound too loud for the company you keep.",
  "Depth has a weight; you feel it on your shoulders.",
  "Even the rats seem scarred and serious now.",
];

const DEPTH_BEATS_ABYSS = [
  "The abyss does not echo. It swallows.",
  "Geometry feels optional. Keep your eyes on the floor.",
  "Something older than dragons wrote these halls.",
  "Your torch burns blue for a heartbeat, then normal.",
];

const PACK_SPOTTED = [
  "A pack has your scent! Multiple beasts begin to hunt.",
  "You spot a knot of creatures moving as one.",
  "Eyes catch the torch — many pairs, not one.",
  "The corridor ahead is crowded with hostile life.",
  "Pack tactics: they fan out as you watch.",
];

const FLOOR_ENTER_EARLY = [
  "The floor is restless tonight.",
  "Something already knew you would arrive.",
  "You hear life in three directions at once.",
  "Fresh tracks cut the dust near the stairs.",
];

const FLOOR_ENTER_MID = [
  "The welcome mat is bloodstains and broken spears.",
  "This depth does not pretend to be empty.",
  "You step into a working ecosystem of teeth.",
];

const FLOOR_ENTER_DEEP = [
  "The air refuses to be friendly.",
  "You have descended past the dungeon's patience.",
  "Only the stubborn and the dead stay this deep.",
];

const RARE_FLOOR = [
  "A chill wind races the halls — the floor itself is uneasy.",
  "All the torches you do not carry seem to lean toward you.",
  "For a moment every distant sound stops. Then resumes, closer.",
  "You feel a floor-wide attention settle on your back.",
];

function pickLine(pool: string[], rng: RNG): string {
  return rng.pick(pool);
}

/**
 * Floor-enter ambient (once per visit). Complements depthFlavor — not a replacement.
 */
export function floorEnterAmbient(
  depth: number,
  dungeon: Dungeon,
  eventState: FloorEventState,
  rng: RNG
): AmbientEvent | null {
  if (eventState.floorEnterDone) return null;
  eventState.floorEnterDone = true;

  const messages: string[] = [];
  if (depth <= 5) messages.push(pickLine(FLOOR_ENTER_EARLY, rng));
  else if (depth <= 10) messages.push(pickLine(FLOOR_ENTER_MID, rng));
  else messages.push(pickLine(FLOOR_ENTER_DEEP, rng));

  // Hint specials without spoiling exact rooms
  const specials = new Set(
    dungeon.rooms.map((r) => r.special).filter((s): s is Exclude<RoomSpecial, null> => !!s)
  );
  if (specials.has("vault") && rng.chance(0.55)) {
    messages.push(pickLine(VAULT_ALARMS, rng));
  } else if (specials.has("barracks") && rng.chance(0.5)) {
    messages.push(pickLine(BARRACKS_DRILLS, rng));
  } else if (specials.has("shrine") && rng.chance(0.5)) {
    messages.push(pickLine(SHRINE_OMENS, rng));
  } else if (specials.has("zoo") && rng.chance(0.45)) {
    messages.push(pickLine(STAMPEDE, rng));
  } else if (rng.chance(depth <= 5 ? 0.4 : 0.25)) {
    messages.push(
      depth <= 5
        ? pickLine(DEPTH_BEATS_EARLY, rng)
        : depth <= 10
          ? pickLine(DEPTH_BEATS_MID, rng)
          : pickLine(DEPTH_BEATS_ABYSS, rng)
    );
  }

  return { kind: "floor_enter", messages };
}

/**
 * FOV discovery: first time any tile of a special room is seen.
 * Returns at most one discovery per call (caller can loop).
 */
export function discoverSpecialRoomsInFov(opts: {
  dungeon: Dungeon;
  visibleKeys: Iterable<string>;
  eventState: FloorEventState;
  depth: number;
  rng: RNG;
}): AmbientEvent | null {
  const { dungeon, eventState, rng } = opts;
  for (const key of opts.visibleKeys) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const room = roomAt(dungeon, x, y);
    if (!room?.special || room.special === "alcove") continue;
    const rk = roomKey(room);
    if (eventState.discoveredSpecials.includes(rk)) continue;
    eventState.discoveredSpecials.push(rk);

    const special = room.special;
    let messages: string[];
    let kind: AmbientKind = "depth_beat";
    switch (special) {
      case "vault":
        kind = "vault_alarm";
        messages = [
          room.locked
            ? "You spot a locked treasure vault nearby..."
            : "You spot a treasure vault nearby...",
          pickLine(VAULT_ALARMS, rng),
        ];
        break;
      case "shrine":
        kind = "shrine_omen";
        messages = ["You discover a forgotten shrine.", pickLine(SHRINE_OMENS, rng)];
        break;
      case "barracks":
        kind = "barracks_drill";
        messages = ["You have found barracks.", pickLine(BARRACKS_DRILLS, rng)];
        break;
      case "zoo":
        kind = "stampede";
        messages = [
          "You discover a monster zoo — cages hang open.",
          pickLine(STAMPEDE, rng),
        ];
        break;
      case "graveyard":
        kind = "whisper";
        messages = [
          "Gravestones lean into view. The air cools.",
          "Something watches from between the markers.",
        ];
        break;
      case "fountain":
        kind = "whisper";
        messages = ["You spot a stone fountain, water still moving."];
        break;
      case "throne":
        kind = "vault_alarm";
        messages = ["A cracked throne commands the chamber ahead."];
        break;
      default:
        messages = ["You notice a chamber that feels important."];
    }
    return { kind, messages };
  }
  return null;
}

/**
 * Pack spotted: 3+ living pack/swarm monsters in FOV → one warning.
 */
export function detectPackSpotted(opts: {
  monsters: Entity[];
  visibleKeys: Set<string>;
  eventState: FloorEventState;
  rng: RNG;
}): AmbientEvent | null {
  const packers: Entity[] = [];
  for (const m of opts.monsters) {
    if (m.hp <= 0) continue;
    if (!opts.visibleKeys.has(`${m.x},${m.y}`)) continue;
    const isPack =
      m.traits?.includes("pack") ||
      m.kind === "rat" ||
      m.kind === "kobold" ||
      m.kind === "goblin" ||
      m.kind === "bat";
    if (isPack) packers.push(m);
  }
  if (packers.length < 3) return null;

  // Cluster key: rough cell of centroid so different packs can each warn once
  const cx = Math.floor(packers.reduce((s, m) => s + m.x, 0) / packers.length / 5);
  const cy = Math.floor(packers.reduce((s, m) => s + m.y, 0) / packers.length / 5);
  const pk = `pack:${cx},${cy}:${packers.length >= 5 ? "swarm" : "pack"}`;
  if (opts.eventState.packSpotted.includes(pk)) return null;
  opts.eventState.packSpotted.push(pk);

  return {
    kind: "pack_spotted",
    messages: [pickLine(PACK_SPOTTED, opts.rng)],
    alertPacks: true,
  };
}

/**
 * Peripheral whisper when a hunter lurks just outside FOV (deterministic).
 */
export function peripheralWhisper(opts: {
  monsters: Entity[];
  playerPos: { x: number; y: number };
  fovRadius: number;
  depth: number;
  seed: number;
  turn: number;
  eventState: FloorEventState;
}): AmbientEvent | null {
  const { monsters, playerPos, fovRadius, depth, seed, turn, eventState } = opts;
  // Share ambient cooldown so whispers don't stack with timed ambience
  if (eventState.turnCounter - eventState.lastAmbientTurn < Math.max(4, ambientInterval(depth) - 3)) {
    return null;
  }
  const rng = eventRng(seed, depth, turn, 0x77);
  // ~8% after gap on early floors, lower deeper (AI still stress-tests)
  if (!rng.chance(depth <= 5 ? 0.1 : 0.06)) return null;

  for (const monster of monsters) {
    if (monster.hp <= 0) continue;
    if (monster.ai !== "hunt" && !monster.traits?.includes("pack")) continue;
    const cheb = Math.max(
      Math.abs(monster.x - playerPos.x),
      Math.abs(monster.y - playerPos.y)
    );
    if (cheb > fovRadius && cheb <= fovRadius + 4) {
      const pool = depth <= 5 ? WHISPERS_EARLY : WHISPERS_DEEP;
      const line =
        rng.chance(0.35) && monster.name
          ? `You sense a ${monster.name} nearby.`
          : pickLine(pool, rng);
      eventState.lastAmbientTurn = eventState.turnCounter;
      return { kind: "whisper", messages: [line] };
    }
  }
  return null;
}

/**
 * Timed ambient beat every N turns — flavor pools by depth + floor specials.
 * No spam: respects lastAmbientTurn. Prefer mechanical env/reinforce first.
 */
export function rollTimedAmbient(opts: {
  depth: number;
  dungeon: Dungeon;
  eventState: FloorEventState;
  seed: number;
  turn: number;
  /** Skip if a mechanical event already fired this turn. */
  skipIfBusy?: boolean;
}): AmbientEvent | null {
  if (opts.skipIfBusy) return null;
  const { depth, dungeon, eventState, seed, turn } = opts;
  const gap = eventState.turnCounter - eventState.lastAmbientTurn;
  if (gap < ambientInterval(depth)) return null;

  const rng = eventRng(seed, depth, turn, 0xa1);
  // Chance after gap — higher d1–5
  const chance = depth <= 2 ? 0.55 : depth <= 5 ? 0.42 : depth <= 10 ? 0.32 : 0.28;
  if (!rng.chance(chance)) return null;

  const specials = dungeon.rooms.map((r) => r.special).filter(Boolean) as RoomSpecial[];
  const has = (s: RoomSpecial) => specials.includes(s);

  type Cand = { kind: AmbientKind; w: number; lines: string[]; alert?: boolean; hunger?: number };
  const cands: Cand[] = [
    {
      kind: "whisper",
      w: depth <= 5 ? 5 : 3,
      lines: depth <= 5 ? WHISPERS_EARLY : WHISPERS_DEEP,
    },
    {
      kind: "depth_beat",
      w: depth <= 5 ? 4 : 3,
      lines:
        depth <= 5
          ? DEPTH_BEATS_EARLY
          : depth <= 10
            ? DEPTH_BEATS_MID
            : DEPTH_BEATS_ABYSS,
    },
    {
      kind: "stampede",
      w: has("zoo") || depth <= 5 ? 3 : 1.2,
      lines: STAMPEDE,
      alert: true,
    },
    {
      kind: "shrine_omen",
      w: has("shrine") ? 3.5 : 0.6,
      lines: SHRINE_OMENS,
    },
    {
      kind: "barracks_drill",
      w: has("barracks") ? 3.5 : 0.7,
      lines: BARRACKS_DRILLS,
      alert: true,
    },
    {
      kind: "vault_alarm",
      w: has("vault") ? 3 : 0.5,
      lines: VAULT_ALARMS,
    },
    {
      kind: "rare_floor",
      w: depth <= 5 ? 1.2 : 0.8,
      lines: RARE_FLOOR,
      hunger: rng.int(4, 10),
    },
  ];

  const total = cands.reduce((s, c) => s + c.w, 0);
  let roll = rng.next() * total;
  let pick = cands[0];
  for (const c of cands) {
    roll -= c.w;
    if (roll <= 0) {
      pick = c;
      break;
    }
  }

  eventState.lastAmbientTurn = eventState.turnCounter;
  return {
    kind: pick.kind,
    messages: [pickLine(pick.lines, rng)],
    alertPacks: pick.alert,
    hungerDrain: pick.hunger,
  };
}

/** Apply soft ambient side-effects (pack alert + hunger). */
export function applyAmbientEffects(
  ambient: AmbientEvent,
  player: PlayerState,
  monsters: Entity[]
): void {
  if (ambient.hungerDrain && ambient.hungerDrain > 0) {
    player.hunger = Math.max(0, player.hunger - ambient.hungerDrain);
  }
  if (ambient.alertPacks) {
    for (const m of monsters) {
      if (m.hp <= 0) continue;
      if (
        m.traits?.includes("pack") ||
        m.kind === "rat" ||
        m.kind === "kobold" ||
        m.kind === "goblin"
      ) {
        m.ai = "hunt";
      }
    }
  }
}

// ——— Shared tick (SP game.ts + MMO world.ts must stay identical) ———

export interface WorldEventTickInput {
  depth: number;
  seed: number;
  dungeon: Dungeon;
  /** Living monsters array (mutated: new spawns appended by caller from result). */
  monsters: Entity[];
  playerPos: { x: number; y: number };
  playersOnFloor: number;
  eventState: FloorEventState;
  hasGraveyard: boolean;
  /** FOV radius for peripheral whispers. */
  fovRadius?: number;
}

export interface WorldEventTickResult {
  /** Broadcast to every player on the floor. */
  floorMessages: string[];
  /** Actor-only lines (damage/heal flavor already in messages usually). */
  actorMessages: string[];
  newMonsters: Entity[];
  damageToActor?: number;
  healToActor?: number;
  hungerDrainActor?: number;
  goldDeltaActor?: number;
  alertPacks?: boolean;
  busy: boolean;
}

/**
 * One shared event tick: reinforce → env (incl. gas/ambush) → ambient.
 * Callers apply actor HP/gold and append newMonsters. Does not rewrite spawn bands.
 */
export function tickWorldEventsCore(input: WorldEventTickInput): WorldEventTickResult {
  const ev = ensureFloorEventState(input.eventState);
  ev.turnCounter += 1;

  const depth = input.depth;
  const alive = input.monsters.filter((m) => m.hp > 0).length;
  const rng = eventRng(input.seed, depth, ev.turnCounter, 0x11);
  const floorMessages: string[] = [];
  const actorMessages: string[] = [];
  const newMonsters: Entity[] = [];
  let busy = false;
  let damageToActor: number | undefined;
  let healToActor: number | undefined;
  let hungerDrainActor: number | undefined;
  let goldDeltaActor: number | undefined;
  let alertPacks = false;

  // 1) Reinforcements
  if (
    shouldReinforce({
      depth,
      aliveMonsters: alive,
      playersOnFloor: input.playersOnFloor,
      eventState: ev,
      requirePlayers: true,
    })
  ) {
    const occupied = new Set<string>();
    occupied.add(`${input.playerPos.x},${input.playerPos.y}`);
    for (const m of input.monsters) {
      if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
    }
    for (const m of newMonsters) occupied.add(`${m.x},${m.y}`);

    const plan = planReinforcement(
      input.dungeon,
      depth,
      alive,
      input.playersOnFloor,
      occupied,
      [input.playerPos],
      rng
    );
    if (plan) {
      const spawned = applyReinforcementPlan(plan, depth);
      newMonsters.push(...spawned);
      floorMessages.push(plan.message);
      ev.lastReinforcementTurn = ev.turnCounter;
      busy = true;
    }
  }

  // 2) Environmental events (gas_pocket, corridor_ambush, migration, haunt, …)
  {
    const occupied = new Set<string>();
    occupied.add(`${input.playerPos.x},${input.playerPos.y}`);
    for (const m of input.monsters) {
      if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
    }
    for (const m of newMonsters) occupied.add(`${m.x},${m.y}`);

    const env = rollEnvironmentalEvent({
      depth,
      dungeon: input.dungeon,
      eventState: ev,
      occupied,
      playerPos: input.playerPos,
      rng: eventRng(input.seed, depth, ev.turnCounter, 0x22),
      hasGraveyard: input.hasGraveyard,
    });
    if (env) {
      floorMessages.push(...env.messages);
      if (env.spawns?.length) {
        newMonsters.push(...spawnFromSpecs(env.spawns, depth));
      }
      if (env.damageToPlayer) damageToActor = (damageToActor ?? 0) + env.damageToPlayer;
      if (env.healToPlayer) healToActor = (healToActor ?? 0) + env.healToPlayer;
      if (env.hungerDrain) hungerDrainActor = (hungerDrainActor ?? 0) + env.hungerDrain;
      if (env.goldDelta) goldDeltaActor = (goldDeltaActor ?? 0) + env.goldDelta;
      if (env.alertPacks) alertPacks = true;
      ev.lastEnvEventTurn = ev.turnCounter;
      busy = true;
    }
  }

  // 3) Ambient flavor when not busy
  if (!busy) {
    const ambient = rollTimedAmbient({
      depth,
      dungeon: input.dungeon,
      eventState: ev,
      seed: input.seed,
      turn: ev.turnCounter,
      skipIfBusy: false,
    });
    if (ambient) {
      floorMessages.push(...ambient.messages);
      if (ambient.alertPacks) alertPacks = true;
      if (ambient.hungerDrain) hungerDrainActor = (hungerDrainActor ?? 0) + ambient.hungerDrain;
    } else {
      const whisper = peripheralWhisper({
        monsters: input.monsters,
        playerPos: input.playerPos,
        fovRadius: input.fovRadius ?? 8,
        depth,
        seed: input.seed,
        turn: ev.turnCounter,
        eventState: ev,
      });
      if (whisper) {
        actorMessages.push(...whisper.messages);
      }
    }
  }

  return {
    floorMessages,
    actorMessages,
    newMonsters,
    damageToActor,
    healToActor,
    hungerDrainActor,
    goldDeltaActor,
    alertPacks,
    busy,
  };
}
