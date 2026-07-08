import { generateDungeon, isWalkable, findSpawnPoint } from "./dungeon";
import { RNG } from "./rng";
import {
  createPlayer,
  createMonster,
  createStarterItems,
  generateItem,
  monstersForDepth,
  nextId,
} from "./entities";
import {
  meleeAttack,
  effectivePlayerEntity,
  hungerDamage,
  updateHungerState,
  useItem,
} from "./combat";
import type { Direction, Entity, GamePhase, GameState, PlayerState } from "./types";

const MAX_DEPTH = 10;
const HUNGER_PER_TURN = 2;
const FOV_RADIUS = 8;

function createExplored(width: number, height: number): boolean[][] {
  return Array.from({ length: height }, () => Array(width).fill(false));
}

function revealFOV(state: GameState): void {
  const { player, dungeon, explored } = state;
  const px = player.entity.x;
  const py = player.entity.y;

  for (let dy = -FOV_RADIUS; dy <= FOV_RADIUS; dy++) {
    for (let dx = -FOV_RADIUS; dx <= FOV_RADIUS; dx++) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= dungeon.width || y >= dungeon.height) continue;
      if (dx * dx + dy * dy > FOV_RADIUS * FOV_RADIUS) continue;

      let visible = true;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      for (let i = 1; i <= steps; i++) {
        const sx = px + Math.round((dx * i) / steps);
        const sy = py + Math.round((dy * i) / steps);
        if (dungeon.tiles[sy][sx] === "#" && (sx !== x || sy !== y)) {
          visible = false;
          break;
        }
      }
      if (visible) explored[y][x] = true;
    }
  }
}

function addMessage(state: GameState, msg: string): void {
  state.messages.push(msg);
  if (state.messages.length > 50) state.messages.shift();
}

function spawnMonsters(state: GameState, rng: RNG): void {
  const kinds = monstersForDepth(state.player.depth);
  const count = rng.int(4, 8 + state.player.depth);
  const occupied = new Set<string>();
  occupied.add(`${state.player.entity.x},${state.player.entity.y}`);

  for (let i = 0; i < count; i++) {
    const pos = findSpawnPoint(state.dungeon, occupied);
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    const kind = rng.pick(kinds);
    state.monsters.push(createMonster(kind, pos.x, pos.y, state.player.depth));
  }
}

function spawnItems(state: GameState, rng: RNG): void {
  const count = rng.int(3, 6 + state.player.depth);
  const occupied = new Set<string>();
  occupied.add(`${state.player.entity.x},${state.player.entity.y}`);

  for (const m of state.monsters) occupied.add(`${m.x},${m.y}`);

  for (let i = 0; i < count; i++) {
    const pos = findSpawnPoint(state.dungeon, occupied);
    if (!pos) break;
    occupied.add(`${pos.x},${pos.y}`);
    const item = generateItem(state.player.depth, nextId("item"));
    if (rng.chance(0.08)) item.cursed = true;
    state.items.push({ item, x: pos.x, y: pos.y });
  }
}

function createPlayerState(entity: Entity, depth: number): PlayerState {
  return {
    entity,
    level: 1,
    xp: 0,
    xpToLevel: 20,
    hunger: 800,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: createStarterItems(),
    equippedWeapon: null,
    equippedArmor: null,
    gold: 0,
    turns: 0,
    depth,
    alive: true,
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
    explored: createExplored(dungeon.width, dungeon.height),
    messages: ["Welcome to GrokHack! Descend to depth 10 and slay the dragon."],
    phase: "playing",
    seed: gameSeed,
  };

  spawnMonsters(state, rng);
  spawnItems(state, rng);
  revealFOV(state);
  return state;
}

function monsterAt(state: GameState, x: number, y: number): Entity | undefined {
  return state.monsters.find((m) => m.x === x && m.y === y && m.hp > 0);
}

function itemAt(state: GameState, x: number, y: number) {
  return state.items.find((i) => i.x === x && i.y === y);
}

function tryPickup(state: GameState): void {
  const idx = state.items.findIndex(
    (i) => i.x === state.player.entity.x && i.y === state.player.entity.y
  );
  if (idx === -1) return;
  const ground = state.items[idx];
  state.player.inventory.push(ground.item);
  state.items.splice(idx, 1);
  addMessage(state, `You pick up ${ground.item.identified ? `a ${ground.item.name}` : "something"}.`);
}

function levelUp(state: GameState): void {
  state.player.level++;
  state.player.xpToLevel = Math.floor(state.player.xpToLevel * 1.5);
  state.player.entity.maxHp += 4;
  state.player.entity.hp = state.player.entity.maxHp;
  state.player.entity.attack += 1;
  state.player.entity.defense += 1;
  addMessage(state, `You ascend to level ${state.player.level}!`);
}

function gainXp(state: GameState, amount: number): void {
  state.player.xp += amount;
  while (state.player.xp >= state.player.xpToLevel) {
    state.player.xp -= state.player.xpToLevel;
    levelUp(state);
  }
}

function killMonster(state: GameState, monster: Entity): void {
  gainXp(state, monster.xp);
  state.player.gold += Math.floor(Math.random() * 5) + 1;
  addMessage(state, `You kill the ${monster.name} (+${monster.xp} XP).`);
}

function endTurn(state: GameState): void {
  state.player.turns++;
  state.player.hunger = Math.max(0, state.player.hunger - HUNGER_PER_TURN);

  const hungerMsg = updateHungerState(state.player);
  if (hungerMsg) addMessage(state, hungerMsg);

  const dmg = hungerDamage(state.player.hungerState);
  if (dmg > 0) {
    state.player.entity.hp -= dmg;
    addMessage(state, `Hunger deals ${dmg} damage.`);
    if (state.player.entity.hp <= 0) {
      state.player.alive = false;
      state.phase = "dead";
      addMessage(state, "You have starved to death...");
    }
  }

  runMonsterAI(state);
  revealFOV(state);
}

function runMonsterAI(state: GameState): void {
  const player = state.player.entity;

  for (const monster of state.monsters) {
    if (monster.hp <= 0) continue;

    const dist = Math.abs(monster.x - player.x) + Math.abs(monster.y - player.y);

    if (dist === 1) {
      const result = meleeAttack(monster, effectivePlayerEntity(state.player));
      addMessage(state, result.message);
      if (result.killed) {
        state.player.alive = false;
        state.phase = "dead";
        addMessage(state, "Game over.");
      }
      continue;
    }

    if (monster.ai === "hunt" && dist <= 12) {
      moveMonsterToward(state, monster, player.x, player.y);
    } else if (Math.random() < 0.4) {
      const dirs = [
        { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
        { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
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
  const dx = Math.sign(tx - monster.x);
  const dy = Math.sign(ty - monster.y);

  if (tryMoveMonster(state, monster, dx, 0)) return;
  tryMoveMonster(state, monster, 0, dy);
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

  if (player.depth >= MAX_DEPTH) {
    const dragon = state.monsters.find((m) => m.kind === "dragon" && m.hp > 0);
    if (dragon) {
      addMessage(state, "A dragon blocks the final descent! Slay it first.");
      return false;
    }
    state.phase = "won";
    addMessage(state, "You have conquered the dungeon! Victory!");
    return true;
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
  state.explored = createExplored(newDungeon.width, newDungeon.height);

  spawnMonsters(state, rng);
  spawnItems(state, rng);

  if (newDepth === MAX_DEPTH) {
    const dragon = createMonster("dragon", px + 2, py, newDepth);
    state.monsters.push(dragon);
    addMessage(state, "You hear a terrible roar from the depths...");
  }

  addMessage(state, `You descend to depth ${newDepth}.`);
  revealFOV(state);
  return true;
}

export function tryMove(state: GameState, dir: Direction): boolean {
  if (state.phase !== "playing") return false;

  const nx = state.player.entity.x + dir.dx;
  const ny = state.player.entity.y + dir.dy;

  if (!isWalkable(state.dungeon.tiles, nx, ny)) {
    addMessage(state, "You bump into a wall.");
    return false;
  }

  const target = monsterAt(state, nx, ny);
  if (target) {
    const result = meleeAttack(effectivePlayerEntity(state.player), target);
    addMessage(state, result.message);
    if (result.killed) killMonster(state, target);
    endTurn(state);
    return true;
  }

  state.player.entity.x = nx;
  state.player.entity.y = ny;
  tryPickup(state);
  endTurn(state);
  return true;
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
  if (msg) addMessage(state, msg);
  state.phase = "playing";
  endTurn(state);
}

export function getVisibleMonsters(state: GameState): Entity[] {
  return state.monsters.filter(
    (m) => m.hp > 0 && state.explored[m.y]?.[m.x]
  );
}

export function getVisibleItems(state: GameState) {
  return state.items.filter((i) => state.explored[i.y]?.[i.x]);
}