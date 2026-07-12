import {
  generateDungeon,
  isWalkable,
  findSpawnPoint,
  randomPointInRoom,
  computeFOV,
  planMonsterSpawns,
  planCorridorScraps,
} from "./dungeon";
import { RNG } from "./rng";
import {
  createPlayer,
  createMonster,
  createBossDragon,
  createStarterItems,
  generateItem,
  generateItemBiased,
  generatePotion,
  generateHealingPotion,
  pickMonsterKind,
  monsterCountRange,
  itemCountRange,
  roomLootCount,
  roomItemPassChance,
  roomLootBias,
  countHealingPotionsOnFloor,
  minHealingPotionsForDepth,
  isHealingPotion,
  reinforcementThreshold,
  foyerThreatCount,
  nextId,
  makeCorpse,
  depthFlavor,
  curseChance,
  hungerPerTurn,
  itemDisplayName,
  STARTER_XP_TO_LEVEL,
} from "./entities";
// TICKET-DP-01 — shrine sacrifice + throne sit pure rules live in combat
// world-events handoff
import {
  createFloorEventState,
  ensureFloorEventState,
  applyPlayerEventEffects,
  spawnFromSpecs,
  applyRoomSpecialOnStep,
  pickDenMonsterKind,
  planDenPackSpawns,
  isDenSpecial,
  floorEnterAmbient,
  discoverSpecialRoomsInFov,
  detectPackSpotted,
  applyAmbientEffects,
  eventRng,
  tickWorldEventsCore,
} from "./world-events";
// TICKET-WE-01 pollution book (blood_moon fuel) — keep note on kills
import {
  createFloorEventBook,
  ensureFloorEventBook,
  notePollution,
} from "./events";
import {
  meleeAttack,
  effectivePlayerEntity,
  hungerDamage,
  updateHungerState,
  useItem,
  playerHitPenalty,
  tickMonsterRegen,
  tryRangedSpecial,
  trySummonMinion,
  revealMimic,
  checkBossEnrage,
  tryApplyMonsterOnHit,
  tickPlayerStatuses,
  ringHungerDrain,
  tickRingRegen,
  packChaseTarget,
  chooseStepToward,
  sacrificeCorpse,
  resolveThroneSit,
  findCorpseIndex,
  applyXpGain,
} from "./combat";
// trap-pressure handoff
import {
  applyTrapsOnStep,
  generateTraps,
  searchForTraps,
  trapsRngFromFloorSeed,
} from "./traps";
import type { Direction, Entity, GameState, PlayerState } from "./types";

/** Dragon lair — gate to the abyss (must slay dragon to go deeper). */
const LAIR_DEPTH = 10;
/** Abyss end — true ending only (dragon kill alone is not a win). */
const MAX_DEPTH = 15;
const FOV_RADIUS = 8;

function createExplored(width: number, height: number): boolean[][] {
  return Array.from({ length: height }, () => Array(width).fill(false));
}

function revealFOV(state: GameState): void {
  const { player, dungeon, explored } = state;
  const px = player.entity.x;
  const py = player.entity.y;

  const sawDown = explored[dungeon.stairsDown.y]?.[dungeon.stairsDown.x] ?? false;
  const sawUp =
    dungeon.stairsUp &&
    (explored[dungeon.stairsUp.y]?.[dungeon.stairsUp.x] ?? false);

  const visible = computeFOV(dungeon.tiles, px, py, FOV_RADIUS);
  for (const key of visible) {
    const [xs, ys] = key.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (y >= 0 && y < explored.length && x >= 0 && x < explored[0].length) {
      explored[y][x] = true;
    }
  }

  // Stairs discovery juice
  if (!sawDown && explored[dungeon.stairsDown.y]?.[dungeon.stairsDown.x]) {
    addMessage(state, "You spot a staircase leading deeper (>)!");
  }
  if (
    player.depth > 1 &&
    !sawUp &&
    explored[dungeon.stairsUp.y]?.[dungeon.stairsUp.x]
  ) {
    addMessage(state, "You notice stairs leading up (<).");
  }

  // world-events handoff — FOV special discovery + pack spotted
  const ev = ensureFloorEventState(state.eventState);
  state.eventState = ev;
  const rng = eventRng(state.seed, player.depth, player.turns, 0xf0);
  const disc = discoverSpecialRoomsInFov({
    dungeon,
    visibleKeys: visible,
    eventState: ev,
    depth: player.depth,
    rng,
  });
  if (disc) {
    for (const m of disc.messages) addMessage(state, m);
    applyAmbientEffects(disc, player, state.monsters);
  }
  const pack = detectPackSpotted({
    monsters: state.monsters,
    visibleKeys: visible,
    eventState: ev,
    rng: eventRng(state.seed, player.depth, player.turns, 0xf1),
  });
  if (pack) {
    for (const m of pack.messages) addMessage(state, m);
    applyAmbientEffects(pack, player, state.monsters);
  }
}

function revealAll(state: GameState): void {
  for (let y = 0; y < state.dungeon.height; y++) {
    for (let x = 0; x < state.dungeon.width; x++) {
      if (state.dungeon.tiles[y][x] !== "#") {
        state.explored[y][x] = true;
      }
    }
  }
}

function addMessage(state: GameState, msg: string): void {
  state.messages.push(msg);
  if (state.messages.length > 50) state.messages.shift();
}

function pickWhisper(monsterName: string): string {
  // Fallback only — prefer peripheralWhisper (deterministic)
  return `You sense a ${monsterName} nearby.`;
}

function spawnMonsters(state: GameState, rng: RNG): void {
  // Depth owns threat tables + count bands; Algorithms owns placement geometry.
  // P0-5: dens use pickDenMonsterKind / planDenPackSpawns (themed packs).
  const depth = state.player.depth;
  const band = monsterCountRange(depth);
  const count = rng.int(band.min, band.max);
  const occupied = new Set<string>();
  occupied.add(`${state.player.entity.x},${state.player.entity.y}`);

  // Floor population — dens geometry from planMonsterSpawns; themed kinds in dens
  const positions = planMonsterSpawns(
    state.dungeon,
    depth,
    count,
    rng,
    occupied
  );
  for (const pos of positions) {
    const room = state.dungeon.rooms.find(
      (r) =>
        pos.x >= r.x &&
        pos.x < r.x + r.w &&
        pos.y >= r.y &&
        pos.y < r.y + r.h
    );
    const special = room?.special ?? null;
    const kind = isDenSpecial(special)
      ? pickDenMonsterKind(special, depth, rng)
      : pickMonsterKind(depth, rng.next());
    state.monsters.push(createMonster(kind, pos.x, pos.y, depth));
  }

  // P0-5: guarantee themed den packs fill zoo/barracks/graveyard/throne/beehive
  for (const pack of planDenPackSpawns(state.dungeon, depth, occupied, rng)) {
    state.monsters.push(createMonster(pack.monsterKind, pack.x, pack.y, depth));
  }

  // P0-6: foyer threats — first FOV (chebyshev ≤8 of stairs/player) must show life
  const foyerN = foyerThreatCount(depth);
  for (let i = 0; i < foyerN; i++) {
    const pos = findSpawnPoint(state.dungeon, occupied, rng, {
      minDistanceFrom: { x: state.player.entity.x, y: state.player.entity.y },
      minDistance: 3,
    });
    if (!pos) break;
    const cheb = Math.max(
      Math.abs(pos.x - state.player.entity.x),
      Math.abs(pos.y - state.player.entity.y)
    );
    if (cheb > 8 && depth <= 5) {
      occupied.add(`${pos.x},${pos.y}`);
      continue;
    }
    occupied.add(`${pos.x},${pos.y}`);
    const kind = pickMonsterKind(Math.min(depth, 3), rng.next());
    state.monsters.push(createMonster(kind, pos.x, pos.y, depth));
  }
}

function spawnItems(state: GameState, rng: RNG): void {
  // items density handoff — shared tables in entities.itemCountRange / roomLootCount
  const depth = state.player.depth;
  const band = itemCountRange(depth);
  const count = rng.int(band.min, band.max);
  const occupied = new Set<string>();
  occupied.add(`${state.player.entity.x},${state.player.entity.y}`);
  const curseRate = curseChance(depth);

  for (const m of state.monsters) occupied.add(`${m.x},${m.y}`);

  for (let i = 0; i < count; i++) {
    const pos = findSpawnPoint(state.dungeon, occupied, rng, {
      minDistanceFrom: { x: state.player.entity.x, y: state.player.entity.y },
      minDistance: 2,
    });
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    const bias =
      depth <= 5 ? roomLootBias(null, depth, rng.next(), rng.next()) : "any";
    const item = generateItemBiased(depth, nextId("item"), state.seed, bias);
    // Don't curse guaranteed-sustain healing pots on d1–3
    if (rng.chance(curseRate) && !(depth <= 3 && isHealingPotion(item))) {
      item.cursed = true;
      item.buc = "cursed";
    }
    state.items.push({ item, x: pos.x, y: pos.y });
  }

  // Analytics cycle1: inject true healing so skilled players can learn under pressure
  {
    const need = minHealingPotionsForDepth(depth) - countHealingPotionsOnFloor(state.items);
    for (let i = 0; i < need; i++) {
      const pos = findSpawnPoint(state.dungeon, occupied, rng, {
        minDistanceFrom: { x: state.player.entity.x, y: state.player.entity.y },
        minDistance: 2,
      });
      if (!pos) break;
      occupied.add(`${pos.x},${pos.y}`);
      state.items.push({
        item: generateHealingPotion(depth, nextId("item"), state.seed, i === 0 && depth === 1),
        x: pos.x,
        y: pos.y,
      });
    }
  }

  // TICKET-SE-01 / §3.1 — vault & shrine clusters first (unchanged density teeth)
  const startRoom = state.dungeon.rooms[0];
  for (const room of state.dungeon.rooms) {
    if (room.special === "vault") {
      const n = roomLootCount("vault", depth, rng.next());
      for (let i = 0; i < n; i++) {
        const pos = randomPointInRoom(room, occupied, rng);
        if (!pos) break;
        occupied.add(`${pos.x},${pos.y}`);
        const item = generateItem(depth + 1, nextId("item"), state.seed);
        item.identified = false;
        state.items.push({ item, x: pos.x, y: pos.y });
      }
      addMessage(
        state,
        room.locked
          ? "You sense a locked treasure vault nearby..."
          : "You sense a treasure vault nearby..."
      );
    } else if (room.special === "shrine") {
      const n = roomLootCount("shrine", depth, rng.next());
      for (let i = 0; i < n; i++) {
        const pos = randomPointInRoom(room, occupied, rng);
        if (!pos) break;
        occupied.add(`${pos.x},${pos.y}`);
        const pot =
          depth <= 3 && i === 0
            ? generateHealingPotion(depth, nextId("item"), state.seed)
            : generatePotion(depth, nextId("item"), state.seed, undefined, "uncursed");
        pot.power = Math.max(pot.power, 12 + depth * 2);
        pot.bucKnown = false;
        state.items.push({ item: pot, x: pos.x, y: pos.y });
      }
    }
  }

  // §3.1 room pass: non-start rooms, p=0.75+0.03d (cap 0.95); 20% second item
  const roomP = roomItemPassChance(depth);
  for (const room of state.dungeon.rooms) {
    if (room === startRoom) continue;
    if (room.special === "vault" || room.special === "shrine") continue; // already piled
    if (!rng.chance(roomP)) continue;
    const n = rng.chance(0.2) ? 2 : 1;
    const bias = roomLootBias(room.special, depth, rng.next(), rng.next());
    for (let i = 0; i < n; i++) {
      const pos = randomPointInRoom(room, occupied, rng);
      if (!pos) break;
      occupied.add(`${pos.x},${pos.y}`);
      const item = generateItemBiased(depth, nextId("item"), state.seed, bias);
      if (rng.chance(curseRate * 0.8) && !(depth <= 3 && isHealingPotion(item))) {
        item.cursed = true;
        item.buc = "cursed";
      }
      state.items.push({ item, x: pos.x, y: pos.y });
    }
    if (room.special === "barracks" && rng.chance(0.55)) {
      addMessage(state, "You hear the clatter of weapons from a nearby barracks.");
    } else if (room.special === "zoo" && rng.chance(0.55)) {
      addMessage(state, "Distant chittering echoes through the halls...");
    }
  }

  // §3.1 corridor scraps — hallways between rooms
  for (const pos of planCorridorScraps(state.dungeon, depth, rng, occupied)) {
    const item = generateItemBiased(depth, nextId("item"), state.seed, "food");
    if (rng.chance(curseRate * 0.5)) {
      item.cursed = true;
      item.buc = "cursed";
    }
    state.items.push({ item, x: pos.x, y: pos.y });
  }
}

function createPlayerState(entity: Entity, depth: number): PlayerState {
  return {
    entity,
    level: 1,
    xp: 0,
    xpToLevel: STARTER_XP_TO_LEVEL,
    hunger: 800,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: createStarterItems(),
    equippedWeapon: null,
    equippedArmor: null,
    equippedRing: null,
    gold: 0,
    turns: 0,
    depth,
    alive: true,
    statuses: [],
  };
}

export function newGame(seed?: number): GameState {
  const gameSeed = seed ?? Date.now();
  const rng = new RNG(gameSeed);
  const depth = 1;
  const dungeon = generateDungeon(rng, depth);

  const startRoom = dungeon.rooms[0] ?? { x: 2, y: 2, w: 6, h: 4 };
  const px = startRoom.x + Math.floor(startRoom.w / 2);
  const py = startRoom.y + Math.floor(startRoom.h / 2);

  const playerEntity = createPlayer(px, py);
  const player = createPlayerState(playerEntity, depth);
  player.equippedWeapon = player.inventory.find((i) => i.type === "weapon") ?? null;
  player.equippedArmor = player.inventory.find((i) => i.type === "armor") ?? null;
  player.inventory = player.inventory.filter(
    (i) => i !== player.equippedWeapon && i !== player.equippedArmor
  );

  const state: GameState = {
    dungeon,
    player,
    monsters: [],
    items: [],
    traps: [],
    explored: createExplored(dungeon.width, dungeon.height),
    messages: [
      "Welcome to GrokHack! Slay the dragon at depth 10, then conquer the abyss (true ending at 15).",
      depthFlavor(1),
    ],
    phase: "playing",
    seed: gameSeed,
    lastWorldEventTurn: 0,
    eventCooldowns: {},
    eventState: createFloorEventState(),
    eventBook: createFloorEventBook(),
  };

  spawnMonsters(state, rng);
  spawnItems(state, rng);
  // trap-pressure handoff — hidden floor traps (near-zero d1)
  state.traps = generateTraps(
    dungeon,
    depth,
    trapsRngFromFloorSeed(gameSeed + depth * 7919)
  );
  // world-events handoff — floor-enter ambient (once)
  {
    const enter = floorEnterAmbient(
      depth,
      dungeon,
      state.eventState!,
      eventRng(gameSeed, depth, 0, 0xe1)
    );
    if (enter) {
      for (const m of enter.messages) addMessage(state, m);
    }
  }
  // Clear vault whisper until player is actually on a vault floor with FOV
  // (spawnItems may have pushed vault message before FOV — keep it, it's atmospheric)
  revealFOV(state);
  return state;
}

function monsterAt(state: GameState, x: number, y: number): Entity | undefined {
  return state.monsters.find((m) => m.x === x && m.y === y && m.hp > 0);
}

/** Free cardinally-adjacent walkable tile for lich summons (TICKET-BE-01). */
function findAdjacentOpen(
  state: GameState,
  x: number,
  y: number
): { x: number; y: number } | null {
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  for (const d of dirs) {
    const nx = x + d.dx;
    const ny = y + d.dy;
    if (!isWalkable(state.dungeon.tiles, nx, ny)) continue;
    if (nx === state.player.entity.x && ny === state.player.entity.y) continue;
    if (monsterAt(state, nx, ny)) continue;
    return { x: nx, y: ny };
  }
  return null;
}

function tryPickup(state: GameState): void {
  const idx = state.items.findIndex(
    (i) => i.x === state.player.entity.x && i.y === state.player.entity.y
  );
  if (idx === -1) return;
  const ground = state.items[idx];
  state.player.inventory.push(ground.item);
  state.items.splice(idx, 1);
  const shown = itemDisplayName(ground.item);
  // Articles: "a red potion" / "scroll labeled X" / "an unidentified weapon"
  const needsAn = /^[aeiou]/i.test(shown);
  const article = shown.startsWith("scroll") || shown.startsWith("unidentified") ? "" : needsAn ? "an " : "a ";
  addMessage(state, `You pick up ${article}${shown}.`);
}

function killMonster(state: GameState, monster: Entity): void {
  // Shared XP path with MMO (cycle1: all bots died Lv1 — threshold + grant path)
  const levelMsgs = applyXpGain(state.player, monster.xp);
  for (const m of levelMsgs) addMessage(state, m);
  const gold = Math.floor(Math.random() * 5) + 1 + Math.floor(state.player.depth / 2);
  state.player.gold += gold;
  addMessage(state, `You kill the ${monster.name} (+${monster.xp} XP, +${gold} gold).`);
  // TICKET-WE-01 pollution (blood_moon fuel)
  {
    const book = ensureFloorEventBook(state.eventBook);
    state.eventBook = book;
    notePollution(book, 1);
  }

  // Corpse drop — undead leave corpses too (deadly eat / shrine offerings, DP-01)
  const corpseChance = monster.traits?.includes("undead") ? 0.42 : 0.35;
  if (Math.random() < corpseChance) {
    const corpse = makeCorpse(monster.name, nextId("item"), {
      kind: monster.kind,
      traits: monster.traits,
    });
    state.items.push({ item: corpse, x: monster.x, y: monster.y });
    addMessage(state, `The ${monster.name} leaves a corpse.`);
  } else if (Math.random() < 0.12) {
    const loot = generateItem(state.player.depth, nextId("item"), state.seed);
    state.items.push({ item: loot, x: monster.x, y: monster.y });
    addMessage(state, `Something clatters from the ${monster.name}.`);
  }

  // Remove dead from active list for cleanliness
  state.monsters = state.monsters.filter((m) => m.hp > 0 || m.id !== monster.id);
}

function endTurn(state: GameState): void {
  state.player.turns++;
  const drain = hungerPerTurn(state.player.depth) + ringHungerDrain(state.player);
  state.player.hunger = Math.max(0, state.player.hunger - drain);

  // Ring of regeneration ticks before hunger pain
  if (state.player.alive) {
    tickRingRegen(state.player);
  }

  const hungerMsg = updateHungerState(state.player);
  if (hungerMsg) addMessage(state, hungerMsg);

  const dmg = hungerDamage(state.player.hungerState);
  if (dmg > 0) {
    state.player.entity.hp -= dmg;
    addMessage(state, `Hunger deals ${dmg} damage.`);
    if (state.player.entity.hp <= 0) {
      state.player.alive = false;
      state.phase = "dead";
      state.player.deathCause = "Starved to death";
      addMessage(state, "You have starved to death...");
    }
  }

  // Poison / status ticks before monsters act
  if (state.player.alive) {
    const statusMsg = tickPlayerStatuses(state.player);
    if (statusMsg) addMessage(state, statusMsg);
    if (!state.player.alive) {
      state.phase = "dead";
      addMessage(state, "Game over.");
    }
  }

  // trap-pressure handoff — bear trap hold wears off each turn
  if (state.player.alive && (state.player.immobilizedTurns ?? 0) > 0) {
    state.player.immobilizedTurns! -= 1;
    if (state.player.immobilizedTurns === 0) {
      addMessage(state, "You free yourself from the trap.");
    }
  }

  if (state.player.alive) {
    // world-events handoff — reinforcements + env variety (d1–5 denser cadence)
    tickWorldEventsModule(state);
  }

  if (state.player.alive) {
    runMonsterAI(state);
  }

  revealFOV(state);
}

/**
 * Shared world-events tick (same core as server/world.ts tickFloorWorldEvents).
 */
function tickWorldEventsModule(state: GameState): void {
  const ev = ensureFloorEventState(state.eventState);
  state.eventState = ev;

  const result = tickWorldEventsCore({
    depth: state.player.depth,
    seed: state.seed,
    dungeon: state.dungeon,
    monsters: state.monsters,
    playerPos: { x: state.player.entity.x, y: state.player.entity.y },
    playersOnFloor: 1,
    eventState: ev,
    hasGraveyard: state.dungeon.rooms.some((r) => r.special === "graveyard"),
    fovRadius: FOV_RADIUS,
  });

  for (const msg of result.floorMessages) addMessage(state, msg);
  for (const msg of result.actorMessages) addMessage(state, msg);
  if (result.newMonsters.length) {
    state.monsters.push(...result.newMonsters);
  }
  if (result.alertPacks) {
    applyAmbientEffects(
      { kind: "stampede", messages: [], alertPacks: true },
      state.player,
      state.monsters
    );
  }
  const death = applyPlayerEventEffects(state.player, {
    damage: result.damageToActor,
    heal: result.healToActor,
    hungerDelta: result.hungerDrainActor ? -result.hungerDrainActor : undefined,
    goldDelta: result.goldDeltaActor,
  });
  if (death) addMessage(state, death);
  if (!state.player.alive) {
    state.phase = "dead";
    addMessage(state, "Game over.");
  }
  if (result.busy || result.floorMessages.length || result.actorMessages.length) {
    state.lastWorldEventTurn = state.player.turns;
  }
}

function runMonsterAI(state: GameState): void {
  const player = state.player.entity;
  let whispered = false;

  for (const monster of state.monsters) {
    if (monster.hp <= 0) continue;

    // Passive regen (trolls, dragons)
    tickMonsterRegen(monster);

    const dist = Math.abs(monster.x - player.x) + Math.abs(monster.y - player.y);

    // Breath / mind blast / ranged special before closing
    if (dist >= 2 && dist <= 6 && state.player.alive) {
      const special = tryRangedSpecial(monster, state.player, dist);
      if (special) {
        addMessage(state, special.message);
        if (special.killed || !state.player.alive) {
          state.player.alive = false;
          state.phase = "dead";
          if (!state.player.deathCause) {
            state.player.deathCause = monster.traits?.includes("mind_blast")
              ? `Mind blasted by a ${monster.name}`
              : `Incinerated by a ${monster.name}`;
          }
          addMessage(state, "Game over.");
          continue;
        }
        // Used special — still may move closer this turn
      } else if (monster.traits?.includes("summon") && dist >= 2 && dist <= 5) {
        // Lich summon skeleton into adjacent open tile (TICKET-BE-01)
        const open = findAdjacentOpen(state, monster.x, monster.y);
        const summoned = trySummonMinion(
          monster,
          state.player.depth,
          open,
          createMonster
        );
        if (summoned) {
          state.monsters.push(summoned.minion);
          addMessage(state, summoned.message);
        }
      }
    }

    // Mimic drops disguise when player is adjacent
    if (dist === 1 && monster.hiddenAs) {
      const rev = revealMimic(monster);
      if (rev) addMessage(state, rev);
    }

    if (dist === 1) {
      const result = meleeAttack(monster, effectivePlayerEntity(state.player));
      // Apply damage to actual player entity (effective is a copy)
      if (result.hit) {
        state.player.entity.hp -= result.damage;
        if (state.player.entity.hp <= 0) {
          state.player.entity.hp = 0;
          state.player.alive = false;
          state.phase = "dead";
          state.player.deathCause = `Slain by a ${monster.name}`;
        } else {
          const onHit = tryApplyMonsterOnHit(monster, state.player);
          if (onHit) addMessage(state, onHit);
        }
      }
      addMessage(state, result.message);
      if (!state.player.alive) {
        addMessage(state, "Game over.");
      }
      continue;
    }

    // Peripheral threat whispers (outside FOV, nearby hunters) — one per turn
    if (!whispered) {
      const cheb = Math.max(Math.abs(monster.x - player.x), Math.abs(monster.y - player.y));
      if (
        monster.ai === "hunt" &&
        cheb > FOV_RADIUS &&
        cheb <= FOV_RADIUS + 4 &&
        Math.random() < 0.06
      ) {
        addMessage(state, pickWhisper(monster.name));
        whispered = true;
      }
    }

    // Pack/swarm hunt farther and flank; swift always hunts in range
    const isPack =
      monster.traits?.includes("pack") || monster.traits?.includes("swarm");
    const huntRange = isPack ? 16 : monster.traits?.includes("swift") ? 14 : 12;
    if (monster.ai === "hunt" && dist <= huntRange) {
      moveMonsterToward(state, monster, player.x, player.y);
    } else if (Math.random() < 0.4) {
      const dirs = [
        { dx: 0, dy: -1 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: 1, dy: 0 },
      ];
      const d = dirs[Math.floor(Math.random() * dirs.length)];
      tryMoveMonster(state, monster, d.dx, d.dy);
    }
  }
}

function tryMoveMonster(state: GameState, monster: Entity, dx: number, dy: number): boolean {
  const nx = monster.x + dx;
  const ny = monster.y + dy;
  if (!isWalkable(state.dungeon.tiles, nx, ny)) return false;
  if (monsterAt(state, nx, ny)) return false;
  if (nx === state.player.entity.x && ny === state.player.entity.y) return false;
  monster.x = nx;
  monster.y = ny;
  return true;
}

function moveMonsterToward(state: GameState, monster: Entity, tx: number, ty: number): void {
  let aimX = tx;
  let aimY = ty;
  // Pack/swarm: approach open flanks so multiple rats/bees/orcs surround the player
  if (monster.traits?.includes("pack") || monster.traits?.includes("swarm")) {
    const aim = packChaseTarget(monster.x, monster.y, tx, ty, (x, y) => {
      if (!isWalkable(state.dungeon.tiles, x, y)) return true;
      if (x === state.player.entity.x && y === state.player.entity.y) return true;
      const other = monsterAt(state, x, y);
      return !!(other && other.id !== monster.id);
    });
    aimX = aim.x;
    aimY = aim.y;
  }
  chooseStepToward(monster.x, monster.y, aimX, aimY, (dx, dy) =>
    tryMoveMonster(state, monster, dx, dy)
  );
}

function descend(state: GameState): boolean {
  const { player, dungeon } = state;
  if (
    player.entity.x !== dungeon.stairsDown.x ||
    player.entity.y !== dungeon.stairsDown.y
  ) {
    addMessage(state, "You must stand on the stairs to descend.");
    return false;
  }

  // True ending: final stairs at abyss floor (d15)
  if (player.depth >= MAX_DEPTH) {
    state.phase = "won";
    addMessage(state, "You have conquered the abyss! True ending — Victory!");
    return true;
  }

  // Lair gate: dragon must die before abyss stairs open
  if (player.depth === LAIR_DEPTH) {
    const dragon = state.monsters.find((m) => m.kind === "dragon" && m.hp > 0);
    if (dragon) {
      addMessage(state, "A dragon blocks the abyss stairs! Slay it first.");
      return false;
    }
  }

  const rng = new RNG(state.seed + player.depth * 7919);
  const newDepth = player.depth + 1;
  const newDungeon = generateDungeon(rng, newDepth);

  const px = newDungeon.stairsUp.x;
  const py = newDungeon.stairsUp.y;
  player.entity.x = px;
  player.entity.y = py;
  player.depth = newDepth;

  state.dungeon = newDungeon;
  state.monsters = [];
  state.items = [];
  state.traps = [];
  state.explored = createExplored(newDungeon.width, newDungeon.height);

  spawnMonsters(state, rng);
  // trap-pressure handoff
  state.traps = generateTraps(
    newDungeon,
    newDepth,
    trapsRngFromFloorSeed(state.seed + newDepth * 7919)
  );
  // Suppress vault messages until after welcome line
  const before = state.messages.length;
  spawnItems(state, rng);
  const vaultMsgs = state.messages.splice(before);

  if (newDepth === LAIR_DEPTH) {
    const dragon = createBossDragon(px + 2, py, newDepth);
    // ensure dragon on walkable
    if (!isWalkable(newDungeon.tiles, dragon.x, dragon.y)) {
      const spot = findSpawnPoint(newDungeon, new Set([`${px},${py}`]), rng, {
        minDistanceFrom: { x: px, y: py },
        minDistance: 2,
      });
      if (spot) {
        dragon.x = spot.x;
        dragon.y = spot.y;
      }
    }
    state.monsters.push(dragon);
    addMessage(state, "You hear a terrible roar from the depths...");
    addMessage(state, "An ancient dragon guards the abyss stairs.");
  } else if (newDepth === LAIR_DEPTH + 1) {
    addMessage(state, "The lair falls behind. The abyss yawns open.");
  }

  addMessage(state, `You descend to depth ${newDepth}.`);
  addMessage(state, depthFlavor(newDepth));
  for (const m of vaultMsgs) addMessage(state, m);
  // world-events handoff — reset ambient + event book for the new floor visit
  state.eventState = createFloorEventState();
  state.eventBook = createFloorEventBook();
  {
    const enter = floorEnterAmbient(
      newDepth,
      newDungeon,
      state.eventState,
      eventRng(state.seed, newDepth, 0, 0xe2)
    );
    if (enter) {
      for (const m of enter.messages) addMessage(state, m);
    }
  }
  revealFOV(state);
  return true;
}

export function tryMove(state: GameState, dir: Direction): boolean {
  if (state.phase !== "playing") return false;

  // trap-pressure handoff — bear trap: struggle instead of step
  if ((state.player.immobilizedTurns ?? 0) > 0) {
    addMessage(state, "You struggle against the trap!");
    endTurn(state);
    return true;
  }

  const nx = state.player.entity.x + dir.dx;
  const ny = state.player.entity.y + dir.dy;

  if (!isWalkable(state.dungeon.tiles, nx, ny)) {
    addMessage(state, "You bump into a wall.");
    return false;
  }

  const target = monsterAt(state, nx, ny);
  if (target) {
    const result = meleeAttack(effectivePlayerEntity(state.player), target, {
      weaponName: state.player.equippedWeapon?.name,
      hitPenalty: playerHitPenalty(state.player),
    });
    // Damage already applied to target (same object)
    addMessage(state, result.message);
    if (result.hit && !result.killed) {
      const enrage = checkBossEnrage(target);
      if (enrage) addMessage(state, enrage);
    }
    if (result.killed) killMonster(state, target);
    endTurn(state);
    return true;
  }

  state.player.entity.x = nx;
  state.player.entity.y = ny;
  tryPickup(state);

  // world-events handoff — fountain / graveyard / throne step effects
  {
    const ev = ensureFloorEventState(state.eventState);
    state.eventState = ev;
    const occupied = new Set<string>();
    for (const m of state.monsters) {
      if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
    }
    const roomFx = applyRoomSpecialOnStep({
      dungeon: state.dungeon,
      x: nx,
      y: ny,
      depth: state.player.depth,
      eventState: ev,
      occupied,
      rng: new RNG(state.seed + state.player.turns * 409 + state.player.depth),
      player: state.player,
    });
    if (roomFx) {
      for (const msg of roomFx.messages) addMessage(state, msg);
      if (roomFx.markEntered && !ev.enteredSpecials.includes(roomFx.markEntered)) {
        ev.enteredSpecials.push(roomFx.markEntered);
      }
      const death = applyPlayerEventEffects(state.player, {
        damage: roomFx.damage,
        heal: roomFx.heal,
        hungerDelta: roomFx.hungerDelta,
        goldDelta: roomFx.goldDelta,
      });
      if (roomFx.spawns?.length) {
        state.monsters.push(...spawnFromSpecs(roomFx.spawns, state.player.depth));
      }
      if (death) addMessage(state, death);
      if (!state.player.alive) {
        state.phase = "dead";
        addMessage(state, "Game over.");
        revealFOV(state);
        return true;
      }
    }
  }

  // trap-pressure handoff — step-on traps (hidden until trigger/search)
  if (state.traps?.length) {
    const occupied = new Set<string>();
    for (const m of state.monsters) {
      if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
    }
    const trapMsgs = applyTrapsOnStep(
      state.traps,
      state.player,
      state.dungeon,
      new RNG(state.seed + state.player.turns * 997 + state.player.depth),
      occupied
    );
    for (const msg of trapMsgs) addMessage(state, msg);
    if (!state.player.alive) {
      state.phase = "dead";
      addMessage(state, "Game over.");
      revealFOV(state);
      return true;
    }
  }

  const { stairsDown } = state.dungeon;
  const { entity } = state.player;
  if (entity.x === stairsDown.x && entity.y === stairsDown.y) {
    descend(state);
  }
  if (state.phase === "playing") endTurn(state);
  return true;
}

/** Search for hidden traps (NetHack `s`). Costs a turn. */
export function trySearch(state: GameState): void {
  if (state.phase !== "playing") return;
  if (!state.traps) state.traps = [];
  const rng = new RNG(state.seed + state.player.turns * 1301 + 17);
  const { messages } = searchForTraps(
    state.traps,
    state.player.entity.x,
    state.player.entity.y,
    rng
  );
  for (const msg of messages) addMessage(state, msg);
  endTurn(state);
}

/** Room containing a tile (for shrine / throne interact). */
export function roomAt(
  state: GameState,
  x: number,
  y: number
): import("./types").Room | undefined {
  return state.dungeon.rooms.find(
    (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
  );
}

/**
 * Special-room interact (key `a`):
 * - shrine: sacrifice corpse lite
 * - throne: sit once per floor
 * TICKET-DP-01.
 */
export function trySpecialInteract(state: GameState): void {
  if (state.phase !== "playing" || !state.player.alive) return;

  const { x, y } = state.player.entity;
  const room = roomAt(state, x, y);

  if (room?.special === "shrine") {
    const idx = findCorpseIndex(state.player);
    if (idx < 0) {
      addMessage(state, "The shrine waits. Offer a corpse (carry one and press a).");
      return; // free action when nothing to do
    }
    const msg = sacrificeCorpse(state.player, idx);
    addMessage(state, msg);
    if (!state.player.alive) {
      state.phase = "dead";
      addMessage(state, "Game over.");
      return;
    }
    endTurn(state);
    return;
  }

  if (room?.special === "throne") {
    // Prefer room center for "throne seat" flavor, but allow whole room
    if (state.player.throneSatDepth === state.player.depth) {
      addMessage(state, "You already sat this throne. The power has fled.");
      return;
    }
    const result = resolveThroneSit(state.player);
    state.player.throneSatDepth = state.player.depth;
    addMessage(state, result.message);
    if (result.summon) {
      const occupied = new Set<string>();
      occupied.add(`${x},${y}`);
      for (const m of state.monsters) {
        if (m.hp > 0) occupied.add(`${m.x},${m.y}`);
      }
      const pos = findSpawnPoint(state.dungeon, occupied, undefined, {
        minDistanceFrom: { x, y },
        minDistance: 1,
      });
      if (pos) {
        const mon = createMonster(result.summon.kind, pos.x, pos.y, state.player.depth);
        mon.ai = "hunt";
        state.monsters.push(mon);
      }
    }
    endTurn(state);
    return;
  }

  addMessage(state, "Nothing special to interact with here. (Shrine: sacrifice. Throne: sit.)");
}

export function waitTurn(state: GameState): void {
  if (state.phase !== "playing") return;
  addMessage(state, "You wait.");
  endTurn(state);
}

export function tryDescend(state: GameState): void {
  if (state.phase !== "playing") return;
  descend(state);
}

export function openInventory(state: GameState): void {
  if (state.phase !== "playing") return;
  state.phase = "inventory";
}

export function closeInventory(state: GameState): void {
  if (state.phase === "inventory") state.phase = "playing";
}

export function selectInventoryItem(state: GameState, index: number): void {
  if (state.phase !== "inventory") return;
  const msg = useItem(state.player, index);
  if (msg === "SCROLL_MAGIC_MAPPING" || msg?.startsWith("SCROLL_MAGIC_MAPPING")) {
    revealAll(state);
    addMessage(state, "The scroll of magic mapping reveals the floor!");
  } else if (msg?.startsWith("SCROLL_CREATE_MONSTER")) {
    const flavor = msg.includes(":") ? msg.split(":").slice(1).join(":") : "The scroll summons something nearby!";
    addMessage(state, flavor);
    // Spawn 1–2 hostiles near the player (risk of reading unknown scrolls)
    const rng = new RNG(state.seed + state.player.turns);
    const count = rng.int(1, 2);
    const occupied = new Set<string>();
    occupied.add(`${state.player.entity.x},${state.player.entity.y}`);
    for (const m of state.monsters) occupied.add(`${m.x},${m.y}`);
    for (let i = 0; i < count; i++) {
      const pos = findSpawnPoint(state.dungeon, occupied);
      if (!pos) break;
      // Prefer adjacent-ish: if far, still ok
      occupied.add(`${pos.x},${pos.y}`);
      const kind = pickMonsterKind(state.player.depth, rng.next());
      state.monsters.push(createMonster(kind, pos.x, pos.y, state.player.depth));
    }
  } else if (msg) {
    addMessage(state, msg);
  }
  if (!state.player.alive) {
    state.phase = "dead";
    // Prefer combat/useItem deathCause — never inventory softlock UI as cause
    if (!state.player.deathCause) {
      const m = (msg ?? "").toLowerCase();
      if (m.includes("poison")) state.player.deathCause = "Drank a potion of poison";
      else if (m.includes("flame") || m.includes("burn"))
        state.player.deathCause = "Burned by a scroll of fire";
      else if (m.includes("food poisoning") || m.includes("rotten"))
        state.player.deathCause = "Food poisoning";
      else if (m.includes("wand") && m.includes("explod"))
        state.player.deathCause = "Killed by a cursed wand exploding";
      else state.player.deathCause = "Killed by a cursed item";
    }
    return;
  }
  state.phase = "playing";
  endTurn(state);
}

export function getVisibleMonsters(state: GameState): Entity[] {
  return state.monsters.filter((m) => m.hp > 0 && state.explored[m.y]?.[m.x]);
}

export function getVisibleItems(state: GameState) {
  return state.items.filter((i) => state.explored[i.y]?.[i.x]);
}
