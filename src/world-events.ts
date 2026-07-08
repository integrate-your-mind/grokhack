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
import { createMonster, pickMonsterKind } from "./entities";
import type { RNG } from "./rng";
import type {
  Dungeon,
  Entity,
  MonsterKind,
  PlayerState,
  Room,
  RoomSpecial,
} from "./types";

/** Salt so event RNG streams stay independent of traps/monsters. */
export const WORLD_EVENT_SEED_SALT = 0x3e3e_7e11;

/** In-memory bookkeeping for a floor (multiplayer or SP). */
export interface FloorEventState {
  /** Total player-turns processed on this floor (any player). */
  turnCounter: number;
  /** turnCounter at last successful reinforcement. */
  lastReinforcementTurn: number;
  /** turnCounter at last environmental event. */
  lastEnvEventTurn: number;
  /** Room keys (`x,y`) already delivering first-entry specials this visit. */
  enteredSpecials: string[];
}

export function createFloorEventState(): FloorEventState {
  return {
    turnCounter: 0,
    lastReinforcementTurn: 0,
    lastEnvEventTurn: 0,
    enteredSpecials: [],
  };
}

export function ensureFloorEventState(
  state: FloorEventState | undefined | null
): FloorEventState {
  if (state && typeof state.turnCounter === "number") return state;
  return createFloorEventState();
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
  | "shopkeeper_call";

export interface EnvEventResult {
  kind: EnvEventKind;
  messages: string[];
  /** Damage applied to the acting player (after defense-ish flat). */
  damageToPlayer?: number;
  /** Optional hunger tax. */
  hungerDrain?: number;
  /** Monsters to spawn. */
  spawns?: { x: number; y: number; monsterKind: MonsterKind }[];
  /** Gold granted (shopkeeper / throne residue). */
  goldDelta?: number;
}

/** Min turns between environmental rolls (not counting reinforcements). */
export function envEventCooldown(depth: number): number {
  // CEO: more event variety on early floors
  return depth <= 2 ? 22 : depth <= 5 ? 28 : depth <= 8 ? 32 : 24;
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
      ? 0.28 + Math.min(0.1, depth * 0.015)
      : 0.18 + Math.min(0.12, depth * 0.01);
  if (!rng.chance(fireChance)) return null;

  const weights: { kind: EnvEventKind; w: number }[] = [
    { kind: "cave_in", w: 3 },
    { kind: "pack_migration", w: 4 },
    { kind: "graveyard_haunt", w: opts.hasGraveyard || depth >= 4 ? 3 : 0.5 },
    { kind: "shopkeeper_call", w: depth >= 3 ? 2 : 0.8 },
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
