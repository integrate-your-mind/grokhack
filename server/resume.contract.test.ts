/**
 * Resume contract tests — DATABASE team owns this file + persistence.ts.
 * See server/persistence.OWNER.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStarterItems, nextId, resetEntityCounterForTests } from "../src/entities.js";
import type { ClientConnection } from "./types.js";
import {
  flushPersistence,
  initPersistence,
  loadResumablePlayerByName,
  resetPersistenceForTests,
  savePlayerNow,
  saveWorldMeta,
} from "./persistence.js";
import { WorldServer } from "./world.js";

let tmpDir = "";

function mockConn(id: string): ClientConnection {
  return {
    id,
    transport: "telnet",
    playerId: null,
    sessionId: "contract-session",
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

describe("resume contract", () => {
  describe("in-memory (same process)", () => {
    it("disconnect → rejoin restores floor, turns, and inventory count", async () => {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      const first = await world.joinPlayer("c1", "Contractor");
      if (typeof first === "string") throw new Error(first);

      const invBefore = first.state.inventory.length;
      first.state.turns = 18;
      first.floorDepth = 2;
      first.state.gold = 33;
      world.removeConnection("c1");

      world.registerConnection(mockConn("c2"));
      const resumed = await world.joinPlayer("c2", "Contractor", "human", first.resumeToken);
      if (typeof resumed === "string") throw new Error(resumed);

      expect(resumed.id).toBe(first.id);
      expect(resumed.floorDepth).toBe(2);
      expect(resumed.state.turns).toBe(18);
      expect(resumed.state.gold).toBe(33);
      expect(resumed.state.inventory.length).toBe(invBefore);
      expect(resumed.connected).toBe(true);
    });

    it("grace reconnect keeps explored + inventory; stays on map until grace ends", async () => {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      world.registerConnection(mockConn("observer"));
      const first = await world.joinPlayer("c1", "Graceful");
      const observer = await world.joinPlayer("observer", "Watcher");
      if (typeof first === "string" || typeof observer === "string") throw new Error("join failed");

      first.state.turns = 9;
      first.state.gold = 44;
      // Mark some explored cells so we can assert identity
      if (first.explored[0]) first.explored[0][0] = true;
      const invBefore = first.state.inventory.length;
      const exploredRef = first.explored;

      world.removeConnection("c1");
      // Soft grace: still visible to others on the floor
      expect(world.buildView(observer).others.some((o) => o.name === "Graceful")).toBe(true);

      world.registerConnection(mockConn("c2"));
      const resumed = await world.joinPlayer("c2", "Graceful", "human", first.resumeToken);
      if (typeof resumed === "string") throw new Error(resumed);

      expect(resumed.id).toBe(first.id);
      expect(resumed.explored).toBe(exploredRef);
      expect(resumed.explored[0]?.[0]).toBe(true);
      expect(resumed.state.inventory.length).toBe(invBefore);
      expect(resumed.state.gold).toBe(44);
      expect(resumed.state.turns).toBe(9);
      expect(resumed.connected).toBe(true);
    });

    it("after grace flush, rejoin is still resumable (cold path)", async () => {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      const first = await world.joinPlayer("c1", "Expired");
      if (typeof first === "string") throw new Error(first);
      first.floorDepth = 3;
      first.state.turns = 50;

      world.removeConnection("c1");
      world.flushDisconnectGrace(first.id);
      expect(first.connected).toBe(false);

      world.registerConnection(mockConn("c2"));
      const resumed = await world.joinPlayer("c2", "Expired", "human", first.resumeToken);
      if (typeof resumed === "string") throw new Error(resumed);
      expect(resumed.id).toBe(first.id);
      expect(resumed.floorDepth).toBe(3);
      expect(resumed.state.turns).toBe(50);
      // Cold resume gets a personal welcome note
      expect(resumed.messages.some((m) => /welcome back/i.test(m))).toBe(true);
    });
  });

  describe("DuckDB (cold start)", () => {
    beforeEach(async () => {
      resetEntityCounterForTests();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-resume-"));
      process.env.GROKHACK_DB_PATH = path.join(tmpDir, "contract.duckdb");
      await initPersistence();
      await saveWorldMeta({ worldSeed: 1, totalTurns: 0, startedAt: Date.now() });
    });

    afterEach(async () => {
      await flushPersistence();
      await resetPersistenceForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.GROKHACK_DB_PATH;
    });

    it("hydrate + rejoin restores floor depth, gold, and inventory items", async () => {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      const joined = await world.joinPlayer("c1", "ColdStart");
      if (typeof joined === "string") throw new Error(joined);

      joined.floorDepth = 4;
      joined.state.gold = 120;
      joined.state.inventory = [
        ...createStarterItems(),
        {
          id: nextId("item"),
          char: "*",
          name: "contract token",
          type: "misc",
          identified: true,
          power: 0,
        },
      ];
      await savePlayerNow(joined);
      world.removeConnection("c1");
      await flushPersistence();

      const cold = new WorldServer();
      await cold.hydrateFromDatabase();
      cold.registerConnection(mockConn("c2"));
      const resumed = await cold.joinPlayer("c2", "ColdStart", "human", joined.resumeToken);
      if (typeof resumed === "string") throw new Error(resumed);

      expect(resumed.floorDepth).toBe(4);
      expect(resumed.state.gold).toBe(120);
      expect(resumed.state.inventory.some((i) => i.name === "contract token")).toBe(true);
    });

    it("does not resume dead or connected players", async () => {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      const live = await world.joinPlayer("c1", "DeadRun");
      if (typeof live === "string") throw new Error(live);
      live.phase = "dead";
      live.connected = false;
      await savePlayerNow(live);
      await flushPersistence();

      expect(await loadResumablePlayerByName("DeadRun")).toBeNull();
    });
  });
});