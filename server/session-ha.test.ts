/**
 * SESSION-HA contract tests — supervisor restart + force flush must not wipe runs.
 * Owns: flushAllDurable, SIGTERM path, reconnect-by-name after cold start.
 * Coordinate: DATABASE owns persistence.ts; conn-resilience owns grace disconnect.
 * See data/fleet/SESSION_HA.md
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextId, resetEntityCounterForTests } from "../src/entities.js";
import type { ClientConnection } from "./types.js";
import {
  closePersistence,
  flushPersistence,
  initPersistence,
  loadPlayerByName,
  loadResumablePlayerByName,
  resetPersistenceForTests,
  saveWorldMeta,
} from "./persistence.js";
import { WorldServer } from "./world.js";

let tmpDir = "";

function mockConn(id: string, sessionId = "ha-session"): ClientConnection {
  return {
    id,
    transport: "websocket",
    playerId: null,
    sessionId,
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

describe("session-ha: supervisor restart contract", () => {
  beforeEach(async () => {
    resetEntityCounterForTests();
    // Instant finalize for isolation from grace timers in non-grace cases
    process.env.GROKHACK_DISCONNECT_GRACE_MS = "0";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-ha-"));
    process.env.GROKHACK_DB_PATH = path.join(tmpDir, "ha.duckdb");
    await initPersistence();
    await saveWorldMeta({ worldSeed: 42, totalTurns: 0, startedAt: Date.now() });
  });

  afterEach(async () => {
    await flushPersistence();
    await resetPersistenceForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GROKHACK_DB_PATH;
    delete process.env.GROKHACK_DISCONNECT_GRACE_MS;
  });

  it("flushAllDurable (SIGTERM path) saves mid-game state without socket close", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const joined = await world.joinPlayer("c1", "HaSurvivor");
    if (typeof joined === "string") throw new Error(joined);

    // Mid-game mutation that may only be debounced — not yet force-saved via removeConnection
    joined.floorDepth = 5;
    joined.state.gold = 250;
    joined.state.turns = 77;
    joined.state.inventory.push({
      id: nextId("item"),
      char: "*",
      name: "ha relic",
      type: "misc",
      identified: true,
      power: 0,
    });
    // Still connected — simulates live players when supervisor sends SIGTERM
    expect(joined.connected).toBe(true);

    // SIGTERM path: world.flushAllDurable → flushPersistence → close (no removeConnection)
    await world.flushAllDurable();
    await flushPersistence();
    await closePersistence();

    // Cold boot
    await initPersistence();
    const cold = new WorldServer();
    await cold.hydrateFromDatabase();
    cold.registerConnection(mockConn("c2", "ha-session-2"));
    const resumed = await cold.joinPlayer("c2", "HaSurvivor", "human", joined.resumeToken);
    if (typeof resumed === "string") throw new Error(resumed);

    expect(resumed.id).toBe(joined.id);
    expect(resumed.floorDepth).toBe(5);
    expect(resumed.state.gold).toBe(250);
    expect(resumed.state.turns).toBe(77);
    expect(resumed.state.inventory.some((i) => i.name === "ha relic")).toBe(true);
    expect(resumed.connected).toBe(true);
  });

  it("flushAllDurable marks rows disconnected so loadResumable works", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "GraceRow");
    if (typeof p === "string") throw new Error(p);
    p.floorDepth = 3;
    await world.flushAllDurable();

    const row = await loadPlayerByName("GraceRow");
    expect(row?.connected).toBe(false);
    expect(row?.floorDepth).toBe(3);
    expect(await loadResumablePlayerByName("GraceRow")).not.toBeNull();
  });

  it("reconnect-by-name after hydrate restores same player id", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const first = await world.joinPlayer("c1", "StickyName");
    if (typeof first === "string") throw new Error(first);
    first.state.turns = 12;
    await world.flushAllDurable();
    await flushPersistence();

    const cold = new WorldServer();
    await cold.hydrateFromDatabase();
    cold.registerConnection(mockConn("c2"));
    const second = await cold.joinPlayer("c2", "StickyName", "human", first.resumeToken);
    if (typeof second === "string") throw new Error(second);

    expect(second.id).toBe(first.id);
    expect(second.state.turns).toBe(12);
  });

  it("shared floor loot survives SIGTERM flush + dual reconnect", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("a"));
    world.registerConnection(mockConn("b"));
    const p1 = await world.joinPlayer("a", "LootA");
    const p2 = await world.joinPlayer("b", "LootB");
    if (typeof p1 === "string" || typeof p2 === "string") throw new Error("join failed");

    const floor = world.buildView(p1).floor;
    floor.items.push({
      x: 3,
      y: 3,
      item: {
        id: nextId("item"),
        char: "$",
        name: "sigterm gold",
        type: "misc",
        identified: true,
        power: 0,
      },
    });
    p1.floorDepth = 1;
    p2.floorDepth = 1;

    await world.flushAllDurable();
    await flushPersistence();
    await closePersistence();

    await initPersistence();
    const cold = new WorldServer();
    await cold.hydrateFromDatabase();
    cold.registerConnection(mockConn("a2"));
    cold.registerConnection(mockConn("b2"));
    const r1 = await cold.joinPlayer("a2", "LootA", "human", p1.resumeToken);
    const r2 = await cold.joinPlayer("b2", "LootB", "human", p2.resumeToken);
    if (typeof r1 === "string" || typeof r2 === "string") throw new Error(String(r1) + String(r2));

    const items = cold.buildView(r1).floor.items;
    expect(items.some((g) => g.item.name === "sigterm gold")).toBe(true);
    expect(r1.connected && r2.connected).toBe(true);
  });
});
