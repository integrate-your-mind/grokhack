import { generateDungeon, isWalkable, findSpawnPoint } from "../src/dungeon.js";
import { RNG } from "../src/rng.js";
import {
  createPlayer,
  createMonster,
  createStarterItems,
  generateItem,
  monstersForDepth,
  nextId,
} from "../src/entities.js";
import {
  meleeAttack,
  effectivePlayerEntity,
  hungerDamage,
  updateHungerState,
  useItem,
} from "../src/combat.js";
import type { Direction, Entity, GamePhase, PlayerState } from "../src/types.js";
import type { ClientConnection, FloorState, GroundItem, OnlinePlayer, WorldStats } from "./types.js";

const MAX_DEPTH = 10;
const HUNGER_PER_TURN = 2;
const FOV_RADIUS = 8;
const MAX_PLAYERS = 500;
const PLAYER_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class WorldServer {
  private floors = new Map<number, FloorState>();
  private players = new Map<string, OnlinePlayer>();
  private connections = new Map<string, ClientConnection>();
  private usedGlyphs = new Set<string>();
  private chatLog: string[] = [];
  private startedAt = Date.now();
  private totalTurns = 0;
  private worldSeed = Date.now();

  getStats(): WorldStats {
    return {
      onlinePlayers: this.players.size,
      floorsActive: this.floors.size,
      totalTurns: this.totalTurns,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  registerConnection(conn: ClientConnection): void {
    this.connections.set(conn.id, conn);
  }

  removeConnection(connId: string): void {
    const conn = this.connections.get(connId);
    if (conn?.playerId) {
      const player = this.players.get(conn.playerId);
      if (player) {
        player.connected = false;
        this.broadcastChat(`${player.name} has disconnected.`, player.id);
      }
    }
    this.connections.delete(connId);
  }

  joinPlayer(connId: string, name: string): OnlinePlayer | string {
    if (this.players.size >= MAX_PLAYERS) return "World is full. Try again later.";

    const trimmed = name.trim().slice(0, 16);
    if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) {
      return "Invalid name. Use letters, numbers, _ or - (max 16).";
    }

    const existing = [...this.players.values()].find(
      (p) => p.name.toLowerCase() === trimmed.toLowerCase() && p.connected
    );
    if (existing) return "Name already in use.";

    const glyph = this.allocateGlyph(trimmed);
    const floor = this.getOrCreateFloor(1);
    const spawn = this.findPlayerSpawn(floor, null);

    const entity = createPlayer(spawn.x, spawn.y);
    entity.char = glyph;
    entity.name = trimmed;
    entity.isPlayer = true;

    const state = this.createPlayerState(entity, 1);
    state.equippedWeapon = state.inventory.find((i) => i.type === "weapon") ?? null;
    state.equippedArmor = state.inventory.find((i) => i.type === "armor") ?? null;
    state.inventory = state.inventory.filter(
      (i) => i !== state.equippedWeapon && i !== state.equippedArmor
    );

    const player: OnlinePlayer = {
      id: nextId("player"),
      name: trimmed,
      glyph,
      state,
      explored: this.createExplored(floor.dungeon.width, floor.dungeon.height),
      messages: [`Welcome, ${trimmed}! Type :say <msg> to chat. Shared dungeon — beware other adventurers.`],
      phase: "playing",
      floorDepth: 1,
      connected: true,
      lastActive: Date.now(),
    };

    this.players.set(player.id, player);
    const conn = this.connections.get(connId);
    if (conn) conn.playerId = player.id;

    this.revealFOV(player, floor);
    this.broadcastChat(`${trimmed} enters the dungeon.`, player.id);
    this.broadcastFloor(player.floorDepth, player.id);
    return player;
  }

  getPlayer(playerId: string): OnlinePlayer | undefined {
    return this.players.get(playerId);
  }

  getPlayersOnFloor(depth: number, excludeId?: string): OnlinePlayer[] {
    return [...this.players.values()].filter(
      (p) => p.floorDepth === depth && p.connected && p.state.alive && p.id !== excludeId
    );
  }

  getOnlineCount(): number {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  listWho(): string {
    const lines = [...this.players.values()]
      .filter((p) => p.connected && p.state.alive)
      .map((p) => `${p.glyph} ${p.name} (d${p.floorDepth} L${p.state.level} HP${p.state.entity.hp})`);
    return lines.length ? lines.join("\n") : "No adventurers online.";
  }

  handleInput(playerId: string, raw: string): void {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;

    player.lastActive = Date.now();
    const key = raw.length === 1 ? raw : raw.trim();

    if (key.startsWith(":say ")) {
      this.broadcastChat(`${player.name}: ${key.slice(5)}`, player.id);
      return;
    }

    if (key === "who") {
      this.addMessage(player, this.listWho());
      this.sendToPlayer(player);
      return;
    }

    if (player.phase === "dead" || player.phase === "won") return;

    if (player.phase === "inventory") {
      if (key === "i" || key === "\x1b") {
        player.phase = "playing";
      } else {
        const num = parseInt(key, 10);
        if (!isNaN(num)) {
          const idx = num === 0 ? 9 : num - 1;
          const msg = useItem(player.state, idx);
          if (msg) this.addMessage(player, msg);
          player.phase = "playing";
          this.endPlayerTurn(player);
        }
      }
      this.sendToPlayer(player);
      return;
    }

    if (key === "i") {
      player.phase = "inventory";
      this.addMessage(player, "Inventory (1-9, 0=10, i to close):");
      player.state.inventory.forEach((item, idx) => {
        this.addMessage(player, `  ${idx + 1}. ${item.char} ${item.name}`);
      });
      this.sendToPlayer(player);
      return;
    }

    if (key === "Q") {
      this.addMessage(player, "Farewell!");
      const conn = [...this.connections.values()].find((c) => c.playerId === playerId);
      conn?.close();
      return;
    }

    if (key === "." || key === "s") {
      this.addMessage(player, "You wait.");
      this.endPlayerTurn(player);
      this.sendToPlayer(player);
      return;
    }

    if (key === ">" || key === "G") {
      this.tryDescend(player);
      this.sendToPlayer(player);
      return;
    }

    const dirs: Record<string, Direction> = {
      h: { dx: -1, dy: 0 }, j: { dx: 0, dy: 1 }, k: { dx: 0, dy: -1 }, l: { dx: 1, dy: 0 },
      y: { dx: -1, dy: -1 }, u: { dx: 1, dy: -1 }, b: { dx: -1, dy: 1 }, n: { dx: 1, dy: 1 },
      w: { dx: 0, dy: -1 }, a: { dx: -1, dy: 0 }, s: { dx: 0, dy: 1 }, d: { dx: 1, dy: 0 },
    };

    const dir = dirs[key];
    if (dir) {
      this.tryMove(player, dir);
      this.sendToPlayer(player);
    }
  }

  private tryMove(player: OnlinePlayer, dir: Direction): void {
    if (player.phase !== "playing") return;
    const floor = this.getOrCreateFloor(player.floorDepth);
    const nx = player.state.entity.x + dir.dx;
    const ny = player.state.entity.y + dir.dy;

    if (!isWalkable(floor.dungeon.tiles, nx, ny)) {
      this.addMessage(player, "You bump into a wall.");
      return;
    }

    const other = this.getPlayerAt(floor.depth, nx, ny, player.id);
    if (other) {
      this.addMessage(player, `${other.name} is in the way.`);
      return;
    }

    const monster = floor.monsters.find((m) => m.hp > 0 && m.x === nx && m.y === ny);
    if (monster) {
      const result = meleeAttack(effectivePlayerEntity(player.state), monster);
      this.addMessage(player, result.message);
      if (result.killed) this.killMonster(player, floor, monster);
      this.endPlayerTurn(player);
      return;
    }

    player.state.entity.x = nx;
    player.state.entity.y = ny;
    this.tryPickup(player, floor);
    this.endPlayerTurn(player);
  }

  private tryDescend(player: OnlinePlayer): void {
    const floor = this.getOrCreateFloor(player.floorDepth);
    const { entity } = player.state;
    const { stairsDown } = floor.dungeon;

    if (entity.x !== stairsDown.x || entity.y !== stairsDown.y) {
      this.addMessage(player, "You must stand on > to descend.");
      return;
    }

    if (player.floorDepth >= MAX_DEPTH) {
      const dragon = floor.monsters.find((m) => m.kind === "dragon" && m.hp > 0);
      if (dragon) {
        this.addMessage(player, "A dragon blocks the final descent! Slay it first.");
        return;
      }
      player.phase = "won";
      this.addMessage(player, "You have conquered the dungeon!");
      this.broadcastChat(`${player.name} has conquered the dungeon!`, player.id);
      return;
    }

    const newDepth = player.floorDepth + 1;
    const newFloor = this.getOrCreateFloor(newDepth);
    const spawn = this.findPlayerSpawn(newFloor, player.id);

    player.floorDepth = newDepth;
    player.state.depth = newDepth;
    player.state.entity.x = spawn.x;
    player.state.entity.y = spawn.y;
    player.explored = this.createExplored(newFloor.dungeon.width, newFloor.dungeon.height);

    this.addMessage(player, `You descend to depth ${newDepth}.`);
    this.revealFOV(player, newFloor);
    this.broadcastFloor(player.floorDepth);
  }

  private endPlayerTurn(player: OnlinePlayer): void {
    const floor = this.getOrCreateFloor(player.floorDepth);
    player.state.turns++;
    this.totalTurns++;
    player.state.hunger = Math.max(0, player.state.hunger - HUNGER_PER_TURN);

    const hungerMsg = updateHungerState(player.state);
    if (hungerMsg) this.addMessage(player, hungerMsg);

    const dmg = hungerDamage(player.state.hungerState);
    if (dmg > 0) {
      player.state.entity.hp -= dmg;
      this.addMessage(player, `Hunger deals ${dmg} damage.`);
      if (player.state.entity.hp <= 0) {
        player.state.alive = false;
        player.phase = "dead";
        this.addMessage(player, "You have died...");
        this.broadcastChat(`${player.name} has died on depth ${player.floorDepth}.`, player.id);
        this.usedGlyphs.delete(player.glyph);
      }
    }

    this.runFloorMonsterAI(floor, player);
    this.revealFOV(player, floor);
    this.broadcastFloor(player.floorDepth, player.id);
  }

  private runFloorMonsterAI(floor: FloorState, actingPlayer: OnlinePlayer): void {
    const targets = [...this.getPlayersOnFloor(floor.depth), actingPlayer].filter(
      (p) => p.state.alive
    );

    for (const monster of floor.monsters) {
      if (monster.hp <= 0) continue;

      let nearest = targets[0];
      let nearestDist = Infinity;
      for (const t of targets) {
        const d = Math.abs(monster.x - t.state.entity.x) + Math.abs(monster.y - t.state.entity.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = t;
        }
      }
      if (!nearest) continue;

      const px = nearest.state.entity.x;
      const py = nearest.state.entity.y;

      if (nearestDist === 1) {
        const result = meleeAttack(monster, effectivePlayerEntity(nearest.state));
        this.addMessage(nearest, result.message);
        if (result.killed) {
          nearest.state.alive = false;
          nearest.phase = "dead";
          this.addMessage(nearest, "Game over.");
          this.broadcastChat(`${nearest.name} was slain by a ${monster.name}.`, nearest.id);
          this.usedGlyphs.delete(nearest.glyph);
        }
        continue;
      }

      if (monster.ai === "hunt" && nearestDist <= 12) {
        this.moveMonsterToward(floor, monster, px, py);
      } else if (Math.random() < 0.4) {
        const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
        const d = dirs[Math.floor(Math.random() * dirs.length)];
        this.tryMoveMonster(floor, monster, d.dx, d.dy);
      }
    }
  }

  private tryMoveMonster(floor: FloorState, monster: Entity, dx: number, dy: number): boolean {
    const nx = monster.x + dx;
    const ny = monster.y + dy;
    if (!isWalkable(floor.dungeon.tiles, nx, ny)) return false;
    if (floor.monsters.some((m) => m.hp > 0 && m.id !== monster.id && m.x === nx && m.y === ny)) return false;
    if (this.getPlayerAt(floor.depth, nx, ny)) return false;
    monster.x = nx;
    monster.y = ny;
    return true;
  }

  private moveMonsterToward(floor: FloorState, monster: Entity, tx: number, ty: number): void {
    const dx = Math.sign(tx - monster.x);
    const dy = Math.sign(ty - monster.y);
    if (!this.tryMoveMonster(floor, monster, dx, 0)) {
      this.tryMoveMonster(floor, monster, 0, dy);
    }
  }

  private killMonster(player: OnlinePlayer, floor: FloorState, monster: Entity): void {
    player.state.xp += monster.xp;
    while (player.state.xp >= player.state.xpToLevel) {
      player.state.xp -= player.state.xpToLevel;
      player.state.level++;
      player.state.xpToLevel = Math.floor(player.state.xpToLevel * 1.5);
      player.state.entity.maxHp += 4;
      player.state.entity.hp = player.state.entity.maxHp;
      player.state.entity.attack += 1;
      player.state.entity.defense += 1;
      this.addMessage(player, `You ascend to level ${player.state.level}!`);
    }
    player.state.gold += Math.floor(Math.random() * 5) + 1;
    this.addMessage(player, `You kill the ${monster.name} (+${monster.xp} XP).`);
  }

  private tryPickup(player: OnlinePlayer, floor: FloorState): void {
    const idx = floor.items.findIndex(
      (i) => i.x === player.state.entity.x && i.y === player.state.entity.y
    );
    if (idx === -1) return;
    const ground = floor.items[idx];
    player.state.inventory.push(ground.item);
    floor.items.splice(idx, 1);
    this.addMessage(player, `You pick up ${ground.item.identified ? ground.item.name : "something"}.`);
  }

  private getPlayerAt(depth: number, x: number, y: number, excludeId?: string): OnlinePlayer | undefined {
    return [...this.players.values()].find(
      (p) =>
        p.connected &&
        p.state.alive &&
        p.floorDepth === depth &&
        p.id !== excludeId &&
        p.state.entity.x === x &&
        p.state.entity.y === y
    );
  }

  private getOrCreateFloor(depth: number): FloorState {
    let floor = this.floors.get(depth);
    if (floor) return floor;

    const rng = new RNG(this.worldSeed + depth * 7919);
    const dungeon = generateDungeon(rng, depth);
    floor = { depth, dungeon, monsters: [], items: [], seed: this.worldSeed + depth * 7919 };

    this.spawnMonsters(floor, rng);
    this.spawnItems(floor, rng);

    if (depth === MAX_DEPTH) {
      const up = dungeon.stairsUp;
      let dx = up.x + 1;
      let dy = up.y;
      if (!isWalkable(dungeon.tiles, dx, dy)) {
        const spot = findSpawnPoint(dungeon, new Set());
        if (spot) { dx = spot.x; dy = spot.y; }
      }
      floor.monsters.push(createMonster("dragon", dx, dy, depth));
    }

    this.floors.set(depth, floor);
    return floor;
  }

  private spawnMonsters(floor: FloorState, rng: RNG): void {
    const kinds = monstersForDepth(floor.depth);
    const count = rng.int(6, 10 + floor.depth);
    const occupied = new Set<string>();
    occupied.add(`${floor.dungeon.stairsDown.x},${floor.dungeon.stairsDown.y}`);

    for (let i = 0; i < count; i++) {
      const pos = findSpawnPoint(floor.dungeon, occupied);
      if (!pos) break;
      occupied.add(`${pos.x},${pos.y}`);
      floor.monsters.push(createMonster(rng.pick(kinds), pos.x, pos.y, floor.depth));
    }
  }

  private spawnItems(floor: FloorState, rng: RNG): void {
    const count = rng.int(4, 8 + floor.depth);
    const occupied = new Set<string>();
    for (const m of floor.monsters) occupied.add(`${m.x},${m.y}`);

    for (let i = 0; i < count; i++) {
      const pos = findSpawnPoint(floor.dungeon, occupied);
      if (!pos) break;
      occupied.add(`${pos.x},${pos.y}`);
      const item = generateItem(floor.depth, nextId("item"));
      if (rng.chance(0.08)) item.cursed = true;
      floor.items.push({ item, x: pos.x, y: pos.y });
    }
  }

  private findPlayerSpawn(floor: FloorState, excludeId: string | null): { x: number; y: number } {
    const occupied = new Set<string>();
    for (const p of this.players.values()) {
      if (p.id === excludeId || p.floorDepth !== floor.depth) continue;
      occupied.add(`${p.state.entity.x},${p.state.entity.y}`);
    }
    const room = floor.dungeon.rooms[0] ?? { x: 2, y: 2, w: 6, h: 4 };
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
    if (!occupied.has(`${cx},${cy}`) && isWalkable(floor.dungeon.tiles, cx, cy)) {
      return { x: cx, y: cy };
    }
    const pos = findSpawnPoint(floor.dungeon, occupied);
    return pos ?? { x: cx, y: cy };
  }

  private createPlayerState(entity: Entity, depth: number): PlayerState {
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

  private createExplored(width: number, height: number): boolean[][] {
    return Array.from({ length: height }, () => Array(width).fill(false));
  }

  private revealFOV(player: OnlinePlayer, floor: FloorState): void {
    const px = player.state.entity.x;
    const py = player.state.entity.y;
    const { dungeon, explored } = { dungeon: floor.dungeon, explored: player.explored };

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

  private allocateGlyph(name: string): string {
    if (!this.usedGlyphs.has("@")) {
      this.usedGlyphs.add("@");
      return "@";
    }
    const first = name[0].toUpperCase();
    if (!this.usedGlyphs.has(first)) {
      this.usedGlyphs.add(first);
      return first;
    }
    for (const g of PLAYER_GLYPHS) {
      if (!this.usedGlyphs.has(g)) {
        this.usedGlyphs.add(g);
        return g;
      }
    }
    return "+";
  }

  private addMessage(player: OnlinePlayer, msg: string): void {
    player.messages.push(msg);
    if (player.messages.length > 50) player.messages.shift();
  }

  private broadcastChat(msg: string, excludeId?: string): void {
    this.chatLog.push(msg);
    if (this.chatLog.length > 200) this.chatLog.shift();
    for (const p of this.players.values()) {
      if (!p.connected || p.id === excludeId) continue;
      this.addMessage(p, `[chat] ${msg}`);
      this.sendToPlayer(p);
    }
  }

  private broadcastFloor(depth: number, excludeId?: string): void {
    for (const p of this.players.values()) {
      if (!p.connected || p.floorDepth !== depth || p.id === excludeId) continue;
      this.sendToPlayer(p);
    }
  }

  sendToPlayer(player: OnlinePlayer): void {
    const conn = [...this.connections.values()].find((c) => c.playerId === player.id);
    if (!conn) return;

    if (player.phase === "dead") {
      conn.send("DEAD");
      return;
    }
    if (player.phase === "won") {
      conn.send("WON");
      return;
    }

    const floor = this.getOrCreateFloor(player.floorDepth);
    const others = this.getPlayersOnFloor(player.floorDepth, player.id);
    conn.send("VIEW");
  }

  buildView(player: OnlinePlayer): { floor: FloorState; others: OnlinePlayer[] } {
    return {
      floor: this.getOrCreateFloor(player.floorDepth),
      others: this.getPlayersOnFloor(player.floorDepth, player.id),
    };
  }
}