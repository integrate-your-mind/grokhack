import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMonster, createPlayer, createStarterItems, nextId, resetEntityCounterForTests } from "../src/entities.js";
import type { OnlinePlayer } from "./types.js";
import {
  appendChatMessages,
  closePersistence,
  countPlayers,
  listPlayerNames,
  flushPersistence,
  getSchemaVersion,
  initPersistence,
  loadFloorByDepth,
  loadPlayerByName,
  isResumablePlayer,
  loadRecentChat,
  loadResumablePlayerByName,
  loadWorld,
  resetPersistenceForTests,
  saveFloorNow,
  savePlayerNow,
  saveWorldMeta,
  scheduleSaveFloor,
  scheduleSavePlayer,
  scheduleSaveWorldMeta,
  SCHEMA_VERSION,
} from "./persistence.js";
import { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";
import { generateDungeon } from "../src/dungeon.js";
import { RNG } from "../src/rng.js";

function mockConn(id: string): ClientConnection {
  return {
    id,
    transport: "telnet",
    playerId: null,
    sessionId: "test-session",
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

let tmpDir = "";

function testDbPath(): string {
  return path.join(tmpDir, "test.duckdb");
}

function samplePlayer(name: string): OnlinePlayer {
  const entity = createPlayer(3, 4);
  entity.name = name;
  return {
    id: nextId("player"),
    name,
    glyph: "@",
    kind: "human",
    state: {
      entity,
      level: 2,
      xp: 5,
      xpToLevel: 20,
      hunger: 700,
      maxHunger: 1000,
      hungerState: "normal",
      inventory: createStarterItems(),
      equippedWeapon: null,
      equippedArmor: null,
      gold: 12,
      turns: 9,
      depth: 2,
      alive: true,
    },
    explored: [[true]],
    messages: ["saved"],
    phase: "playing",
    floorDepth: 2,
    connected: false,
    lastActive: Date.now(),
    scoreRecorded: false,
  };
}

async function simulateCrashRestart(): Promise<void> {
  await flushPersistence();
  await closePersistence();
  await initPersistence();
}

describe("duckdb persistence", () => {
  beforeEach(async () => {
    resetEntityCounterForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-db-"));
    process.env.GROKHACK_DB_PATH = testDbPath();
    await initPersistence();
    await saveWorldMeta({ worldSeed: 42, totalTurns: 10, startedAt: Date.now() });
  });

  afterEach(async () => {
    await flushPersistence();
    await resetPersistenceForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GROKHACK_DB_PATH;
  });

  it("applies schema migrations and indexes base version", async () => {
    expect(await getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("coalesces turn metadata and flushes the latest snapshot", async () => {
    const startedAt = Date.now();
    for (let totalTurns = 11; totalTurns <= 10_000; totalTurns += 1) {
      scheduleSaveWorldMeta({ worldSeed: 42, totalTurns, startedAt });
    }
    await flushPersistence();
    const loaded = await loadWorld();
    expect(loaded?.meta).toEqual({ worldSeed: 42, totalTurns: 10_000, startedAt });
  });

  it("round-trips player state with indexed name lookup", async () => {
    const player = samplePlayer("Delver");
    await savePlayerNow(player);

    const loaded = await loadPlayerByName("Delver");
    expect(loaded?.name).toBe("Delver");
    expect(loaded?.floorDepth).toBe(2);
    expect(loaded?.state.turns).toBe(9);
    expect(loaded?.messages).toContain("saved");
  });

  it("finds resumable disconnected runs only", async () => {
    const live = samplePlayer("Alice");
    live.connected = false;
    await savePlayerNow(live);
    expect(await countPlayers()).toBe(1);
    const loaded = await loadPlayerByName("Alice");
    expect(loaded?.floorDepth).toBe(2);
    expect(loaded?.connected).toBe(false);
    expect(loaded?.phase).toBe("playing");
    expect(isResumablePlayer(loaded)?.floorDepth).toBe(2);
    expect((await loadResumablePlayerByName("Alice"))?.floorDepth).toBe(2);

    const dead = samplePlayer("Bob");
    dead.phase = "dead";
    await savePlayerNow(dead);
    expect(await countPlayers()).toBe(2);
    expect(await loadResumablePlayerByName("Bob")).toBeNull();

    const online = samplePlayer("Cara");
    online.connected = true;
    expect(online.id).not.toBe(live.id);
    await savePlayerNow(online);
    expect(await countPlayers()).toBe(3);
    expect(await listPlayerNames()).toContain(`Alice/alice`);
    expect((await loadPlayerByName("Alice"))?.id).toBe(live.id);
    expect(await loadResumablePlayerByName("Cara")).toBeNull();
    expect((await loadResumablePlayerByName("Alice"))?.floorDepth).toBe(2);
  });

  it("resumes floor depth and inventory after simulated server restart", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const joined = await world.joinPlayer("c1", "Stasher");
    if (typeof joined === "string") throw new Error(joined);

    joined.floorDepth = 3;
    joined.state.gold = 77;
    joined.state.turns = 31;
    joined.state.inventory.push({
      id: nextId("item"),
      char: "!",
      name: "proof gem",
      type: "misc",
      identified: true,
      power: 0,
    });
    await savePlayerNow(joined);
    world.removeConnection("c1");
    await flushPersistence();

    const restarted = new WorldServer();
    await restarted.hydrateFromDatabase();
    restarted.registerConnection(mockConn("c2"));
    const resumed = await restarted.joinPlayer("c2", "Stasher", "human", joined.resumeToken);
    if (typeof resumed === "string") throw new Error(resumed);

    expect(resumed.id).toBe(joined.id);
    expect(resumed.floorDepth).toBe(3);
    expect(resumed.state.gold).toBe(77);
    expect(resumed.state.turns).toBe(31);
    expect(resumed.state.inventory.some((i) => i.name === "proof gem")).toBe(true);
    expect(resumed.connected).toBe(true);
  });

  it("hydrates world server after restart", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const joined = await world.joinPlayer("c1", "Persisto");
    if (typeof joined === "string") throw new Error(joined);
    joined.state.turns = 15;
    await savePlayerNow(joined);

    const rng = new RNG(99);
    const dungeon = generateDungeon(rng, 2);
    await saveFloorNow({ depth: 2, dungeon, monsters: [], items: [], seed: 99 });

    const reloaded = new WorldServer();
    await flushPersistence();
    await reloaded.hydrateFromDatabase();

    const snapshot = await loadWorld();
    expect(snapshot?.players.some((p) => p.name === "Persisto" && p.state.turns === 15)).toBe(true);
    expect(snapshot?.floors.some((f) => f.depth === 2)).toBe(true);
    await flushPersistence();
  });

  it("persists chat_log across crash restart", async () => {
    await appendChatMessages(["Alice: hello dungeon", "Bob: watch the stairs"]);
    await flushPersistence();
    await simulateCrashRestart();

    const chat = await loadRecentChat(50);
    expect(chat).toContain("Alice: hello dungeon");
    expect(chat).toContain("Bob: watch the stairs");

    const world = await loadWorld();
    expect(world?.chatLog).toContain("Alice: hello dungeon");
  });

  it("flushes debounced player/floor saves before close (crash recovery)", async () => {
    const player = samplePlayer("Debounce");
    player.state.gold = 99;
    scheduleSavePlayer(player);

    const rng = new RNG(7);
    const dungeon = generateDungeon(rng, 1);
    scheduleSaveFloor({
      depth: 1,
      seed: 7,
      dungeon,
      monsters: [createMonster("kobold", 2, 2, 1)],
      items: [
        {
          x: 5,
          y: 5,
          item: {
            id: nextId("item"),
            char: "*",
            name: "crash-recovery gem",
            type: "misc",
            identified: true,
            power: 0,
          },
        },
      ],
    });

    // No await on timers — flush must drain pending maps (SIGINT contract)
    await flushPersistence();
    await closePersistence();
    await initPersistence();

    const loaded = await loadPlayerByName("Debounce");
    expect(loaded?.state.gold).toBe(99);

    const floor = await loadFloorByDepth(1);
    expect(floor?.items.some((g) => g.item.name === "crash-recovery gem")).toBe(true);
    expect(floor?.monsters.some((m) => m.name === "kobold")).toBe(true);
  });

  it("closePersistence alone drains pending player/floor writes", async () => {
    const player = samplePlayer("CloseDrain");
    player.state.gold = 64;
    scheduleSavePlayer(player);
    const rng = new RNG(11);
    const dungeon = generateDungeon(rng, 2);
    scheduleSaveFloor({
      depth: 2,
      seed: 11,
      dungeon,
      monsters: [],
      items: [
        {
          x: 1,
          y: 1,
          item: {
            id: nextId("item"),
            char: "*",
            name: "close-drain gem",
            type: "misc",
            identified: true,
            power: 0,
          },
        },
      ],
    });

    // SIGTERM path may only call close — must not drop pending maps
    await closePersistence();
    await initPersistence();

    expect((await loadPlayerByName("CloseDrain"))?.state.gold).toBe(64);
    expect((await loadFloorByDepth(2))?.items.some((g) => g.item.name === "close-drain gem")).toBe(true);
  });

  it("multi-player: shared floor items survive crash and both reconnects", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));

    const a = await world.joinPlayer("c1", "Alice");
    const b = await world.joinPlayer("c2", "Bob");
    if (typeof a === "string" || typeof b === "string") throw new Error("join failed");

    // Shared depth-1 mutations both care about on resume
    a.state.gold = 40;
    a.state.inventory.push({
      id: nextId("item"),
      char: "!",
      name: "alice potion",
      type: "potion",
      identified: true,
      power: 5,
    });
    b.state.gold = 55;
    b.state.inventory.push({
      id: nextId("item"),
      char: "/",
      name: "bob wand",
      type: "misc",
      identified: true,
      power: 1,
    });

    const floor = world.buildView(a).floor;
    expect(floor.depth).toBe(1);
    floor.items.push({
      x: a.state.entity.x,
      y: a.state.entity.y,
      item: {
        id: nextId("item"),
        char: "%",
        name: "shared floor ration",
        type: "food",
        identified: true,
        power: 0,
      },
    });
    // Mark one living monster so the durable list differs from a fresh generate.
    if (floor.monsters.length) {
      floor.monsters[0].hp = Math.max(1, floor.monsters[0].hp);
      floor.monsters[0].name = "live-proof-monster-marker";
    }
    // Dead entities are not durable floor state; corpses live in floor.items.
    const deadMarker = createMonster("goblin", 1, 1, floor.depth);
    deadMarker.hp = 0;
    deadMarker.name = "dead-proof-corpse-marker";
    floor.monsters.push(deadMarker);

    await savePlayerNow(a);
    await savePlayerNow(b);
    await saveFloorNow(floor);

    world.removeConnection("c1");
    world.removeConnection("c2");
    await flushPersistence();

    // Simulated process death + cold start
    await closePersistence();
    await initPersistence();

    const restarted = new WorldServer();
    await restarted.hydrateFromDatabase();
    restarted.registerConnection(mockConn("r1"));
    restarted.registerConnection(mockConn("r2"));

    const a2 = await restarted.joinPlayer("r1", "Alice", "human", a.resumeToken);
    const b2 = await restarted.joinPlayer("r2", "Bob", "human", b.resumeToken);
    if (typeof a2 === "string" || typeof b2 === "string") throw new Error("resume failed");

    // Player inventory + gold restored
    expect(a2.id).toBe(a.id);
    expect(b2.id).toBe(b.id);
    expect(a2.state.gold).toBe(40);
    expect(b2.state.gold).toBe(55);
    expect(a2.state.inventory.some((i) => i.name === "alice potion")).toBe(true);
    expect(b2.state.inventory.some((i) => i.name === "bob wand")).toBe(true);
    expect(a2.floorDepth).toBe(1);
    expect(b2.floorDepth).toBe(1);
    expect(a2.connected).toBe(true);
    expect(b2.connected).toBe(true);

    // Shared floor durable — not regenerated from seed alone
    const resumedFloor = restarted.buildView(a2).floor;
    expect(resumedFloor.items.some((g) => g.item.name === "shared floor ration")).toBe(true);
    expect(resumedFloor.monsters.some((m) => m.name === "live-proof-monster-marker")).toBe(true);
    expect(resumedFloor.monsters.some((m) => m.name === "dead-proof-corpse-marker")).toBe(false);

    // Hydrate cleanup is durable, including when this floor receives no new turns.
    await flushPersistence();
    const compactedFloor = await loadFloorByDepth(1);
    expect(compactedFloor?.monsters.some((m) => m.name === "dead-proof-corpse-marker")).toBe(false);

    // Both see the same floor object / depth state
    const floorB = restarted.buildView(b2).floor;
    expect(floorB).toBe(resumedFloor);
    expect(floorB.items.some((g) => g.item.name === "shared floor ration")).toBe(true);
  });

  it("reconnect contract: disconnect saves floor, resume restores inventory + floor loot", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "ReturnLoot");
    if (typeof p === "string") throw new Error(p);

    p.state.inventory.push({
      id: nextId("item"),
      char: "=",
      name: "ring of proof",
      type: "misc",
      identified: true,
      power: 0,
    });
    const floor = world.buildView(p).floor;
    floor.items.push({
      x: 3,
      y: 3,
      item: {
        id: nextId("item"),
        char: "*",
        name: "floor diamond",
        type: "misc",
        identified: true,
        power: 0,
      },
    });

    // removeConnection must durable-save player + floor without explicit flush
    world.removeConnection("c1");
    await flushPersistence(); // settle async void saves from removeConnection

    await closePersistence();
    await initPersistence();

    const w2 = new WorldServer();
    await w2.hydrateFromDatabase();
    w2.registerConnection(mockConn("c2"));
    const resumed = await w2.joinPlayer("c2", "ReturnLoot", "human", p.resumeToken);
    if (typeof resumed === "string") throw new Error(resumed);

    expect(resumed.state.inventory.some((i) => i.name === "ring of proof")).toBe(true);
    expect(w2.buildView(resumed).floor.items.some((g) => g.item.name === "floor diamond")).toBe(true);
  });
});
