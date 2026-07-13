import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  saveMovementTurnNow,
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
      equippedRing: null,
      statuses: [],
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

  it("commits the movement snapshot atomically across process-crash boundaries", async () => {
    const child = `
      import {
        closePersistence,
        flushPersistence,
        initPersistence,
        loadWorld,
        saveFloorNow,
        saveMovementTurnNow,
        savePlayerNow,
        saveWorldMeta,
      } from "./server/persistence.ts";
      const mode = process.argv[1];
      const crashPoint = process.argv[2] ?? "none";
      await initPersistence();
      if (mode === "seed_state") {
        const player = {
          id: "atomic-player", name: "AtomicMover", glyph: "@", kind: "human",
          state: { depth: 1, entity: { x: 1, y: 1 }, alive: true },
          explored: [[true]], messages: [], phase: "playing", floorDepth: 1,
          connected: false, lastActive: 1, scoreRecorded: false,
        };
        const item = { id: "atomic-item", char: "%", name: "atomic ration", type: "food", identified: true, power: 0 };
        await saveWorldMeta({ worldSeed: 42, totalTurns: 0, startedAt: 1 });
        await savePlayerNow(player);
        await saveFloorNow({
          depth: 1,
          seed: 101,
          dungeon: {},
          monsters: [],
          items: [{ x: 1, y: 1, item }],
          traps: [{ id: "atomic-trap", kind: "bear", x: 1, y: 1, revealed: false, sprung: false }],
          eventState: {
            turnCounter: 0, lastReinforcementTurn: 0, lastEnvEventTurn: 0, lastAmbientTurn: 0,
            enteredSpecials: [], discoveredSpecials: [], packSpotted: [], floorEnterDone: false,
          },
          eventBook: { lastEventTurn: 0, pollution: 0, lastReinforceCheckTurn: 0, migrationCooldownTurn: 0 },
        });
        await saveFloorNow({ depth: 2, seed: 202, dungeon: {}, monsters: [], items: [] });
        await flushPersistence();
        await closePersistence();
      } else if (mode === "move_state") {
        const world = await loadWorld();
        if (!world) throw new Error("missing world");
        const player = world.players.find((candidate) => candidate.name === "AtomicMover");
        const source = world.floors.find((floor) => floor.depth === 1);
        const destination = world.floors.find((floor) => floor.depth === 2);
        if (!player || !source || !destination) throw new Error("missing movement snapshot");
        player.floorDepth = 2;
        player.state.depth = 2;
        const [movedItem] = source.items.splice(0, 1);
        if (movedItem) destination.items.push(movedItem);
        source.traps[0].revealed = true;
        source.traps[0].sprung = true;
        source.eventState.turnCounter = 1;
        source.eventBook.pollution = 1;
        const crash = (point) => {
          if (crashPoint === point) process.exit(71);
        };
        try {
          await saveMovementTurnNow(player, [source, destination], {
            afterBegin() { crash("after_begin"); },
            afterPlayerWrite() { crash("after_player"); },
            afterFloorWrite(_depth, index) {
              crash(index === 0 ? "after_source" : "after_destination");
              if (crashPoint === "throw_after_source" && index === 0) {
                throw new Error("injected movement transaction failure");
              }
            },
            beforeCommit() { crash("before_commit"); },
            afterCommit() { crash("after_commit"); },
          });
        } catch (error) {
          if (crashPoint !== "throw_after_source" ||
              !(error instanceof Error) || error.message !== "injected movement transaction failure") {
            throw error;
          }
          await closePersistence();
          process.exit(72);
        }
        await flushPersistence();
        await closePersistence();
      } else {
        const world = await loadWorld();
        if (!world) throw new Error("missing world");
        const player = world.players.find((candidate) => candidate.name === "AtomicMover");
        const source = world.floors.find((floor) => floor.depth === 1);
        const destination = world.floors.find((floor) => floor.depth === 2);
        console.log("ATOMIC_RESULT=" + JSON.stringify({
          playerDepth: player?.floorDepth,
          sourceItems: source?.items.length,
          destinationItems: destination?.items.length,
          sourceTrapSprung: source?.traps?.[0]?.sprung,
          sourceEventTurn: source?.eventState?.turnCounter,
          sourcePollution: source?.eventBook?.pollution,
        }));
        await closePersistence();
      }
    `;
    const runChild = (database: string, mode: string, crashPoint = "none") => spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      child,
      mode,
      crashPoint,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, GROKHACK_DB_PATH: database },
      encoding: "utf8",
      timeout: 20_000,
    });
    const inspect = (database: string) => {
      const inspected = runChild(database, "read_state");
      expect(inspected.status, inspected.stderr).toBe(0);
      const resultLine = inspected.stdout.split("\n").find((line) => line.startsWith("ATOMIC_RESULT="));
      expect(resultLine).toBeDefined();
      return JSON.parse(resultLine!.slice("ATOMIC_RESULT=".length)) as Record<string, number>;
    };
    const baseline = {
      playerDepth: 1,
      sourceItems: 1,
      destinationItems: 0,
      sourceTrapSprung: false,
      sourceEventTurn: 0,
      sourcePollution: 0,
    };
    const committed = {
      playerDepth: 2,
      sourceItems: 0,
      destinationItems: 1,
      sourceTrapSprung: true,
      sourceEventTurn: 1,
      sourcePollution: 1,
    };

    for (const crashPoint of [
      "after_begin",
      "after_player",
      "after_source",
      "after_destination",
      "before_commit",
    ]) {
      const database = path.join(tmpDir, `${crashPoint}.duckdb`);
      const seeded = runChild(database, "seed_state");
      expect(seeded.status, seeded.stderr).toBe(0);
      const crashed = runChild(database, "move_state", crashPoint);
      expect(crashed.status, `${crashPoint}: ${crashed.stderr}`).toBe(71);
      expect(inspect(database), crashPoint).toEqual(baseline);
    }

    const committedDatabase = path.join(tmpDir, "after_commit.duckdb");
    expect(runChild(committedDatabase, "seed_state").status).toBe(0);
    const afterCommit = runChild(committedDatabase, "move_state", "after_commit");
    expect(afterCommit.status, afterCommit.stderr).toBe(71);
    expect(inspect(committedDatabase)).toEqual(committed);

    const retryDatabase = path.join(tmpDir, "failure-retry.duckdb");
    expect(runChild(retryDatabase, "seed_state").status).toBe(0);
    const failed = runChild(retryDatabase, "move_state", "throw_after_source");
    expect(failed.status, failed.stderr).toBe(72);
    expect(inspect(retryDatabase)).toEqual(baseline);
    const retried = runChild(retryDatabase, "move_state");
    expect(retried.status, retried.stderr).toBe(0);
    expect(inspect(retryDatabase)).toEqual(committed);
  }, 30_000);

  it("rejects missing, duplicate, and oversized movement floor sets before writing", async () => {
    const player = samplePlayer("AtomicFloorValidation");
    const floor = {
      depth: 1,
      seed: 303,
      dungeon: generateDungeon(new RNG(303), 1),
      monsters: [],
      items: [],
    };
    await expect(saveMovementTurnNow(player, [])).rejects.toThrow("invalid_movement_turn_persistence_floors");
    await expect(saveMovementTurnNow(player, [floor, floor])).rejects.toThrow(
      "invalid_movement_turn_persistence_floors",
    );
    await expect(saveMovementTurnNow(player, [
      floor,
      { ...floor, depth: 2 },
      { ...floor, depth: 3 },
    ])).rejects.toThrow("invalid_movement_turn_persistence_floors");
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
      type: "ring",
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
            type: "ring",
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
            type: "ring",
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
      type: "wand",
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
      type: "ring",
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
        type: "ring",
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
