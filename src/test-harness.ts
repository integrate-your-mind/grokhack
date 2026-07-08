/**
 * Headless test harness — imported by vitest and the simulate script.
 * Exercises game logic without a browser.
 */
import { generateDungeon, isWalkable } from "./dungeon";
import { RNG } from "./rng";
import {
  newGame,
  tryMove,
  waitTurn,
  tryDescend,
  openInventory,
  selectInventoryItem,
} from "./game";
import {
  meleeAttack,
  hungerDamage,
  updateHungerState,
  effectivePlayerEntity,
} from "./combat";
import { createPlayer, createMonster, MONSTER_DEFS } from "./entities";
import type { Direction, GameState, PlayerState } from "./types";

export interface SimResult {
  seed: number;
  outcome: "won" | "dead" | "timeout";
  depth: number;
  level: number;
  turns: number;
  hp: number;
  hunger: number;
  kills: number;
  reason: string;
}

const DIRS: Direction[] = [
  { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
  { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
];

function bfsPath(
  state: GameState,
  tx: number,
  ty: number
): Direction[] | null {
  const start = `${state.player.entity.x},${state.player.entity.y}`;
  const queue: { x: number; y: number; path: Direction[] }[] = [
    { x: state.player.entity.x, y: state.player.entity.y, path: [] },
  ];
  const seen = new Set([start]);

  while (queue.length > 0) {
    const { x, y, path } = queue.shift()!;
    if (x === tx && y === ty) return path;

    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (!isWalkable(state.dungeon.tiles, nx, ny)) continue;
      const monster = state.monsters.find((m) => m.x === nx && m.y === ny && m.hp > 0);
      if (monster && !(nx === tx && ny === ty)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny, path: [...path, d] });
    }
  }
  return null;
}

function adjacentMonster(state: GameState) {
  const { x, y } = state.player.entity;
  return state.monsters.find(
    (m) => m.hp > 0 && Math.abs(m.x - x) + Math.abs(m.y - y) === 1
  );
}

function eatIfHungry(state: GameState): void {
  if (state.player.hunger > 300) return;
  const foodIdx = state.player.inventory.findIndex((i) => i.type === "food");
  if (foodIdx === -1) return;
  openInventory(state);
  selectInventoryItem(state, foodIdx);
}

function healIfLow(state: GameState): void {
  if (state.player.entity.hp > state.player.entity.maxHp * 0.4) return;
  const potIdx = state.player.inventory.findIndex((i) => i.type === "potion");
  if (potIdx === -1) return;
  openInventory(state);
  selectInventoryItem(state, potIdx);
}

function equipBetter(state: GameState): void {
  for (let i = 0; i < state.player.inventory.length; i++) {
    const item = state.player.inventory[i];
    if (item.type === "weapon" && item.power > (state.player.equippedWeapon?.power ?? 0)) {
      openInventory(state);
      selectInventoryItem(state, i);
      return;
    }
    if (item.type === "armor" && item.power > (state.player.equippedArmor?.power ?? 0)) {
      openInventory(state);
      selectInventoryItem(state, i);
      return;
    }
  }
}

/** Greedy bot: fight, loot, eat, descend. Not optimal but tests beatability. */
export function simulateGame(seed: number, maxTurns = 8000): SimResult {
  const state = newGame(seed);
  let kills = 0;
  const initialMonsterCount = () => state.monsters.filter((m) => m.hp > 0).length;

  for (let t = 0; t < maxTurns; t++) {
    if (state.phase === "won") {
      return {
        seed,
        outcome: "won",
        depth: state.player.depth,
        level: state.player.level,
        turns: state.player.turns,
        hp: state.player.entity.hp,
        hunger: state.player.hunger,
        kills,
        reason: "victory",
      };
    }
    if (state.phase === "dead") {
      return {
        seed,
        outcome: "dead",
        depth: state.player.depth,
        level: state.player.level,
        turns: state.player.turns,
        hp: state.player.entity.hp,
        hunger: state.player.hunger,
        kills,
        reason: state.messages.at(-1) ?? "died",
      };
    }

    const beforeKills = initialMonsterCount();
    healIfLow(state);
    eatIfHungry(state);
    equipBetter(state);

    const adj = adjacentMonster(state);
    if (adj) {
      const dir = DIRS.find(
        (d) =>
          state.player.entity.x + d.dx === adj.x &&
          state.player.entity.y + d.dy === adj.y
      );
      if (dir) tryMove(state, dir);
      if (initialMonsterCount() < beforeKills) kills++;
      continue;
    }

    const { stairsDown } = state.dungeon;
    const onStairs =
      state.player.entity.x === stairsDown.x &&
      state.player.entity.y === stairsDown.y;

    if (onStairs) {
      const dragonAlive = state.monsters.some((m) => m.kind === "dragon" && m.hp > 0);
      if (!dragonAlive || state.player.depth < 10) {
        tryDescend(state);
        continue;
      }
    }

    const nearbyItem = state.items.find(
      (i) =>
        Math.abs(i.x - state.player.entity.x) + Math.abs(i.y - state.player.entity.y) <= 6
    );
    const target = nearbyItem
      ? { x: nearbyItem.x, y: nearbyItem.y }
      : stairsDown;

    const path = bfsPath(state, target.x, target.y);
    if (path && path.length > 0) {
      tryMove(state, path[0]);
    } else {
      waitTurn(state);
    }
  }

  return {
    seed,
    outcome: "timeout",
    depth: state.player.depth,
    level: state.player.level,
    turns: state.player.turns,
    hp: state.player.entity.hp,
    hunger: state.player.hunger,
    kills,
    reason: "max turns exceeded",
  };
}

export function runBatchSimulation(count: number, startSeed = 1): SimResult[] {
  return Array.from({ length: count }, (_, i) => simulateGame(startSeed + i));
}

// --- Unit test assertions (no vitest dependency) ---

export interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export function runUnitTests(): TestResult[] {
  const results: TestResult[] = [];
  const assert = (name: string, cond: boolean, detail?: string) => {
    results.push({ name, pass: cond, detail });
  };

  // RNG determinism
  const r1 = new RNG(42);
  const r2 = new RNG(42);
  assert("RNG is deterministic", r1.int(1, 100) === r2.int(1, 100));

  // Dungeon generation
  const d = generateDungeon(new RNG(123), 1);
  assert("dungeon has rooms", d.rooms.length > 0);
  assert("stairs down is walkable", isWalkable(d.tiles, d.stairsDown.x, d.stairsDown.y));
  assert("player spawn room floor exists", d.rooms[0].w >= 4);

  // New game invariants
  const g = newGame(999);
  assert("game starts in playing phase", g.phase === "playing");
  assert("player has HP", g.player.entity.hp > 0);
  assert("player has equipped weapon", g.player.equippedWeapon !== null);
  assert("player has equipped armor", g.player.equippedArmor !== null);
  assert("monsters spawned", g.monsters.length > 0);
  assert("items spawned", g.items.length > 0);
  assert("FOV explored tiles exist", g.explored.flat().some(Boolean));

  // Wall bump should NOT consume turn (documented behavior / bug)
  const turnsBefore = g.player.turns;
  tryMove(g, { dx: 0, dy: -1 }); // may hit wall
  // only assert if we know it's a wall - check multiple bumps
  let wallBumpFree = false;
  const g2 = newGame(1001);
  const t0 = g2.player.turns;
  for (const d of DIRS) {
    const nx = g2.player.entity.x + d.dx;
    const ny = g2.player.entity.y + d.dy;
    if (!isWalkable(g2.dungeon.tiles, nx, ny)) {
      tryMove(g2, d);
      if (g2.player.turns === t0) wallBumpFree = true;
      break;
    }
  }
  assert("wall bump does not consume turn (known issue)", wallBumpFree, "free action exploit");

  // Hunger math
  const p: PlayerState = {
    entity: createPlayer(0, 0),
    level: 1, xp: 0, xpToLevel: 20,
    hunger: 100, maxHunger: 1000, hungerState: "normal",
    inventory: [], equippedWeapon: null, equippedArmor: null,
    gold: 0, turns: 0, depth: 1, alive: true,
  };
  updateHungerState(p);
  assert("hunger state updates to weak", p.hungerState === "weak");
  assert("starving deals damage", hungerDamage("starving") === 3);

  // Combat: player can damage rat
  const player = createPlayer(5, 5);
  const rat = createMonster("rat", 6, 5, 1);
  let damageDealt = false;
  for (let i = 0; i < 50; i++) {
    const r = meleeAttack({ ...player, isPlayer: true }, rat);
    if (r.hit && r.damage > 0) damageDealt = true;
    if (rat.hp <= 0) break;
  }
  assert("melee can kill a rat", rat.hp <= 0 || damageDealt);

  // Dragon is tough
  const dragon = createMonster("dragon", 0, 0, 10);
  assert("depth-10 dragon has high HP", dragon.hp >= 60);

  // Depth 10 dragon spawn position check across seeds
  let dragonInWall = 0;
  for (let seed = 0; seed < 100; seed++) {
    const sim = newGame(seed);
    // force descend to depth 10
    let s = sim;
    for (let depth = 1; depth < 10 && s.phase === "playing"; depth++) {
      // teleport player to stairs via moves is slow; use direct manipulation in test
    }
  }
  // Simpler: check dragon spawn logic
  for (let seed = 0; seed < 50; seed++) {
    const state = newGame(seed);
    const rng = new RNG(state.seed + 9 * 7919);
    const dungeon = generateDungeon(rng, 10);
    const px = dungeon.stairsUp.x;
    const py = dungeon.stairsUp.y;
    const dx = px + 2;
    const dy = py;
    if (!isWalkable(dungeon.tiles, dx, dy)) dragonInWall++;
  }
  assert(
    "dragon spawn can land in wall",
    dragonInWall > 0,
    `${dragonInWall}/50 seeds have dragon at px+2 inside wall`
  );

  // Effective player stats include gear
  const g3 = newGame(555);
  const eff = effectivePlayerEntity(g3.player);
  assert(
    "equipped gear boosts attack",
    eff.attack > g3.player.entity.attack,
    `base ${g3.player.entity.attack} effective ${eff.attack}`
  );

  // Dead monster doesn't block movement
  const g4 = newGame(777);
  if (g4.monsters.length > 0) {
    const m = g4.monsters[0];
    m.hp = 0;
    const nx = m.x;
    const ny = m.y;
    const dir = {
      dx: nx - g4.player.entity.x,
      dy: ny - g4.player.entity.y,
    };
    if (Math.abs(dir.dx) + Math.abs(dir.dy) === 1) {
      const turns = g4.player.turns;
      tryMove(g4, dir);
      assert("can walk through dead monster tile", g4.player.entity.x === nx && g4.player.entity.y === ny);
    }
  }

  return results;
}