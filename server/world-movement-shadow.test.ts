import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isWalkable } from "../src/dungeon.js";
import { movementJournalRunId, movementJournalStreamId, OriginGameplayJournal } from "./origin-journal.js";
import type { ClientConnection } from "./types.js";
import {
  shouldRecordMovementNoopEvidence,
  WorldServer,
} from "./world.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function connection(id: string): ClientConnection {
  return {
    id,
    sessionId: `movement-shadow-${id}`,
    transport: "websocket",
    playerId: null,
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

function ordinaryStep(floor: ReturnType<WorldServer["buildView"]>["floor"]): {
  x: number;
  y: number;
  dx: number;
  dy: number;
  key: string;
} {
  const directions = [
    { dx: 1, dy: 0, key: "l" },
    { dx: -1, dy: 0, key: "h" },
    { dx: 0, dy: 1, key: "j" },
    { dx: 0, dy: -1, key: "k" },
  ] as const;
  const step = floor.dungeon.tiles.flatMap((row, y) => row.map((_tile, x) => ({ x, y })))
    .flatMap(({ x, y }) => directions.map((direction) => ({ x, y, ...direction })))
    .find(({ x, y, dx, dy }) => {
      const targetX = x + dx;
      const targetY = y + dy;
      const special = floor.dungeon.rooms.some((room) => room.special &&
        targetX >= room.x && targetX < room.x + room.w &&
        targetY >= room.y && targetY < room.y + room.h);
      const occupied = floor.monsters.some((monster) => monster.hp > 0 && monster.x === targetX && monster.y === targetY);
      const hasItem = floor.items.some((item) => item.x === targetX && item.y === targetY);
      return isWalkable(floor.dungeon.tiles, x, y) &&
        isWalkable(floor.dungeon.tiles, targetX, targetY) &&
        !special &&
        !occupied &&
        !hasItem &&
        (targetX !== floor.dungeon.stairsDown.x || targetY !== floor.dungeon.stairsDown.y);
    });
  if (!step) throw new Error("generated floor has no ordinary adjacent walkable tiles");
  return step;
}

function wallStep(floor: ReturnType<WorldServer["buildView"]>["floor"]): {
  x: number;
  y: number;
  dx: number;
  dy: number;
  key: string;
} {
  const directions = [
    { dx: 1, dy: 0, key: "l" },
    { dx: -1, dy: 0, key: "h" },
    { dx: 0, dy: 1, key: "j" },
    { dx: 0, dy: -1, key: "k" },
  ] as const;
  const step = floor.dungeon.tiles.flatMap((row, y) => row.map((_tile, x) => ({ x, y })))
    .flatMap(({ x, y }) => directions.map((direction) => ({ x, y, ...direction })))
    .find(({ x, y, dx, dy }) =>
      isWalkable(floor.dungeon.tiles, x, y) && !isWalkable(floor.dungeon.tiles, x + dx, y + dy));
  if (!step) throw new Error("generated floor has no walkable tile adjacent to terrain");
  return step;
}

function createJournal(): OriginGameplayJournal {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-shadow-"));
  directories.push(directory);
  return new OriginGameplayJournal(directory);
}

function movementStream(
  player: Awaited<ReturnType<WorldServer["joinPlayer"]>>,
  floor: ReturnType<WorldServer["buildView"]>["floor"],
): string {
  if (typeof player === "string") throw new Error("player unavailable");
  if (!floor.movementAuthority) throw new Error("floor movement authority unavailable");
  return movementJournalStreamId(
    player.id,
    movementJournalRunId(player.resumeToken ?? ""),
    floor.movementAuthority,
  );
}

describe("WorldServer movement shadow journal", () => {
  it("fails empty-world hydration closed when the authority registry is corrupt", async () => {
    const world = new WorldServer({
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        validateMovementAuthorityRegistry: () => { throw new Error("authority registry corrupt"); },
      },
    });
    await expect(world.hydrateFromDatabase()).rejects.toThrow("authority registry corrupt");
  });

  it("fails a new floor closed before player mutation when authority durability is unavailable", async () => {
    const world = new WorldServer({
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        movementAuthorityForFloor: () => { throw new Error("authority disk unavailable"); },
      },
    });
    const rejectedConnection = connection("authority-failure");
    world.registerConnection(rejectedConnection);
    await expect(world.joinPlayer("authority-failure", "AuthorityFailure")).rejects.toThrow("authority disk unavailable");
    expect(world.getStats()).toMatchObject({ onlinePlayers: 0, floorsActive: 0, totalTurns: 0 });
    expect(rejectedConnection.playerId).toBeNull();
  });

  it("does not make a cold-loaded player resident when authority preflight fails", async () => {
    const source = new WorldServer({ loadResumablePlayer: async () => null, originJournal: null });
    source.registerConnection(connection("cold-authority-source"));
    const persisted = await source.joinPlayer("cold-authority-source", "ColdAuthority");
    if (typeof persisted === "string" || !persisted.resumeToken) throw new Error("source join failed");

    const cold = new WorldServer({
      loadResumablePlayer: async () => persisted,
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        movementAuthorityForFloor: () => { throw new Error("authority disk unavailable"); },
      },
    });
    const coldConnection = connection("cold-authority-retry");
    cold.registerConnection(coldConnection);
    await expect(cold.joinPlayer(
      "cold-authority-retry",
      persisted.name,
      "human",
      persisted.resumeToken,
    )).rejects.toThrow("authority disk unavailable");
    expect(cold.getPlayer(persisted.id)).toBeUndefined();
    expect(coldConnection.playerId).toBeNull();
    expect(cold.getStats()).toMatchObject({ onlinePlayers: 0, floorsActive: 0 });
  });

  it("reuses the pending authority rotation operation after a transient first-use failure", async () => {
    const attempts: Array<{ rotate: boolean; rotationId: string }> = [];
    const world = new WorldServer({
      loadResumablePlayer: async () => null,
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        movementAuthorityForFloor: ({ realmId, depth, rotate, rotationId }) => {
          attempts.push({ rotate, rotationId });
          if (attempts.length === 1) throw new Error("authority acknowledgement lost");
          return {
            realmId,
            floorInstanceId: "authority-reconciled-floor",
            depth,
            floorEpoch: 1,
            rulesetVersion: 1,
          };
        },
      },
    });
    const retryConnection = connection("authority-operation-retry");
    world.registerConnection(retryConnection);
    await expect(world.joinPlayer("authority-operation-retry", "AuthorityRetry"))
      .rejects.toThrow("authority acknowledgement lost");
    expect(retryConnection.playerId).toBeNull();

    const joined = await world.joinPlayer("authority-operation-retry", "AuthorityRetry");
    if (typeof joined === "string") throw new Error(joined);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual({ rotate: true, rotationId: attempts[1]!.rotationId });
    expect(world.getStats()).toMatchObject({ onlinePlayers: 1, floorsActive: 1 });
    expect(retryConnection.playerId).toBe(joined.id);
  });

  it("keeps the current owner connected when a supersede authority preflight fails", async () => {
    let authorityCalls = 0;
    const world = new WorldServer({
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        movementAuthorityForFloor: ({ realmId, depth }) => {
          authorityCalls++;
          if (authorityCalls > 1) throw new Error("authority disk unavailable");
          return {
            realmId,
            floorInstanceId: "authority-owner-floor",
            depth,
            floorEpoch: 1,
            rulesetVersion: 1,
          };
        },
      },
    });
    const currentConnection = connection("authority-owner-current");
    currentConnection.close = vi.fn();
    world.registerConnection(currentConnection);
    const player = await world.joinPlayer("authority-owner-current", "AuthorityOwner");
    if (typeof player === "string" || !player.resumeToken) throw new Error("join failed");

    // Exercise the odd recovery path in which the in-memory floor lost its
    // cached sidecar authority and reconnect must establish it again.
    world.buildView(player).floor.movementAuthority = undefined;
    const replacementConnection = connection("authority-owner-replacement");
    world.registerConnection(replacementConnection);

    await expect(world.joinPlayer(
      "authority-owner-replacement",
      player.name,
      "human",
      player.resumeToken,
    )).rejects.toThrow("authority disk unavailable");
    expect(player.connected).toBe(true);
    expect(currentConnection.playerId).toBe(player.id);
    expect(currentConnection.close).not.toHaveBeenCalled();
    expect(replacementConnection.playerId).toBeNull();
  });

  it("caps unique no-op evidence for the process lifetime without eviction cycling", () => {
    const evidence = new Map<string, Map<string, true>>();
    const record = (playerId: string, fingerprint: string, playerLimit = 2): boolean => {
      if (!shouldRecordMovementNoopEvidence(evidence, playerId, fingerprint, 64, playerLimit)) return false;
      let playerEvidence = evidence.get(playerId);
      if (!playerEvidence) {
        playerEvidence = new Map<string, true>();
        evidence.set(playerId, playerEvidence);
      }
      playerEvidence.set(fingerprint, true);
      return true;
    };
    let recorded = 0;
    for (let index = 0; index < 65; index++) {
      if (record("player-1", `fingerprint-${index}`)) recorded++;
    }
    expect(recorded).toBe(64);
    expect(evidence.get("player-1")?.size).toBe(64);
    expect(record("player-1", "fingerprint-0")).toBe(false);
    expect(record("player-1", "fingerprint-65")).toBe(false);
    expect(record("player-2", "first")).toBe(true);
    expect(record("player-3", "first")).toBe(false);
    expect(evidence.size).toBe(2);
  });

  it("records the movement decision before its existing turn/vitals transition", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("walker"));
    const player = await world.joinPlayer("walker", "ShadowWalker");
    if (typeof player === "string") throw new Error(player);

    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);

    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    const turnsBefore = player.state.turns;
    world.handleInput(player.id, step.key);

    const streamId = movementStream(player, floor);
    const entries = journal.readAfter(streamId, 0, 64);
    expect(entries[0]?.command).toMatchObject({ type: "move", dx: step.dx, dy: step.dy });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ v: 2, terminal: false });
    expect(journal.readAfter(player.id, 0, 64)).toEqual([
      expect.objectContaining({ v: 1, command: { type: "advance_turn", action: "other" } }),
    ]);
    expect(player.state).toMatchObject({
      turns: turnsBefore + 1,
      entity: { x: step.x + step.dx, y: step.y + step.dy },
    });
  });

  it("keeps origin movement available after V1 and V2 shadow evidence reach capacity", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-capacity-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory, {
      maxMovementEntries: 1,
      maxGameplayEntries: 1,
    });
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("capacity-walker"));
    const player = await world.joinPlayer("capacity-walker", "CapacityWalker");
    if (typeof player === "string") throw new Error(player);

    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    const reverseKey = ({ l: "h", h: "l", j: "k", k: "j" } as Record<string, string>)[step.key];
    if (!reverseKey) throw new Error("ordinary step has no reverse key");
    for (const monster of floor.monsters) monster.hp = 0;
    floor.items = floor.items.filter((item) =>
      (item.x !== step.x || item.y !== step.y) &&
      (item.x !== step.x + step.dx || item.y !== step.y + step.dy));
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;

    world.handleInput(player.id, step.key);
    for (const monster of floor.monsters) monster.hp = 0;
    world.handleInput(player.id, reverseKey);

    expect(player.state).toMatchObject({
      turns: 2,
      entity: { x: step.x, y: step.y },
    });
    expect(journal.readAfter(movementStream(player, floor), 0, 64)).toHaveLength(1);
    expect(journal.readAfter(player.id, 0, 64)).toHaveLength(1);
    expect((world as unknown as { evidenceCapacityReported: Set<string> }).evidenceCapacityReported)
      .toEqual(new Set(["movement", "vitals"]));
  });

  it("journals terrain and player collision decisions without charging a turn", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("blocked"));
    world.registerConnection(connection("blocker"));
    const player = await world.joinPlayer("blocked", "BlockedWalker");
    const blocker = await world.joinPlayer("blocker", "BlockingWalker");
    if (typeof player === "string" || typeof blocker === "string") throw new Error("join failed");
    const floor = world.buildView(player).floor;
    floor.traps = [];

    const wall = wallStep(floor);
    player.state.entity.x = wall.x;
    player.state.entity.y = wall.y;
    const beforeWallTurns = player.state.turns;
    world.handleInput(player.id, wall.key);
    expect(player.state).toMatchObject({ turns: beforeWallTurns, entity: { x: wall.x, y: wall.y } });
    const streamId = movementStream(player, floor);
    const wallEntry = journal.readAfter(streamId, 0, 64)[0];
    if (!wallEntry || wallEntry.v !== 2) throw new Error("missing movement entry");
    expect(wallEntry.beforeState.destination.tile === null || wallEntry.beforeState.destination.tile === "#").toBe(true);
    world.handleInput(player.id, wall.key);
    expect(journal.readAfter(streamId, 0, 64)).toHaveLength(1);

    // Use the second player's untouched stream so this test does not inject an
    // unjournaled coordinate jump after the wall decision above.
    const open = ordinaryStep(floor);
    blocker.state.entity.x = open.x;
    blocker.state.entity.y = open.y;
    player.state.entity.x = open.x + open.dx;
    player.state.entity.y = open.y + open.dy;
    const beforePlayerTurns = blocker.state.turns;
    world.handleInput(blocker.id, open.key);
    expect(blocker.state).toMatchObject({ turns: beforePlayerTurns, entity: { x: open.x, y: open.y } });
    const playerEntry = journal.readAfter(movementStream(blocker, floor), 0, 64)[0];
    if (!playerEntry || playerEntry.v !== 2) throw new Error("missing player collision entry");
    expect(playerEntry.beforeState.destination.occupant).toBe("player");
    expect(blocker.messages.at(-1)).toBe("BlockedWalker is in the way.");
  });

  it("captures trap and transfer intents from authoritative floor state", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("intent-walker"));
    world.registerConnection(connection("transfer-walker"));
    const player = await world.joinPlayer("intent-walker", "IntentWalker");
    const transferPlayer = await world.joinPlayer("transfer-walker", "TransferWalker");
    if (typeof player === "string" || typeof transferPlayer === "string") throw new Error("join failed");
    const floor = world.buildView(player).floor;
    const trapStep = ordinaryStep(floor);
    const targetX = trapStep.x + trapStep.dx;
    const targetY = trapStep.y + trapStep.dy;
    floor.monsters = floor.monsters.filter((monster) => monster.x !== targetX || monster.y !== targetY);
    floor.items = floor.items.filter((item) => item.x !== targetX || item.y !== targetY);
    floor.traps = [{ id: "movement-test-bear", kind: "bear", x: targetX, y: targetY, revealed: false, sprung: false }];
    player.state.entity.x = trapStep.x;
    player.state.entity.y = trapStep.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    world.handleInput(player.id, trapStep.key);
    const streamId = movementStream(player, floor);
    const trapEntry = journal.readAfter(streamId, 0, 64)[0];
    if (!trapEntry || trapEntry.v !== 2) throw new Error("missing trap movement entry");
    expect(trapEntry.beforeState.destination.trap).toBe(true);

    const currentFloor = world.buildView(player).floor;
    const { stairsDown, tiles } = currentFloor.dungeon;
    const attempts = [
      { x: stairsDown.x - 1, y: stairsDown.y, key: "l", dx: 1, dy: 0 },
      { x: stairsDown.x + 1, y: stairsDown.y, key: "h", dx: -1, dy: 0 },
      { x: stairsDown.x, y: stairsDown.y - 1, key: "j", dx: 0, dy: 1 },
      { x: stairsDown.x, y: stairsDown.y + 1, key: "k", dx: 0, dy: -1 },
    ].find(({ x, y }) => isWalkable(tiles, x, y));
    if (!attempts) throw new Error("stairs have no walkable approach");
    transferPlayer.state.entity.x = attempts.x;
    transferPlayer.state.entity.y = attempts.y;
    currentFloor.monsters = currentFloor.monsters.filter((monster) => monster.x !== stairsDown.x || monster.y !== stairsDown.y);
    currentFloor.items = currentFloor.items.filter((item) => item.x !== stairsDown.x || item.y !== stairsDown.y);
    currentFloor.traps = [];
    world.handleInput(transferPlayer.id, attempts.key);
    const transferEntry = journal.readAfter(movementStream(transferPlayer, currentFloor), 0, 64)[0];
    if (!transferEntry || transferEntry.v !== 2) throw new Error("missing transfer movement entry");
    expect(transferEntry.beforeState.destination).toMatchObject({ tile: ">", stairsDown: true });
    expect(transferEntry.command).toEqual({ type: "move", dx: attempts.dx, dy: attempts.dy });
    expect(transferPlayer.floorDepth).toBe(2);
  });

  it("preserves the terminal V1 vitals record when movement starvation ends the run", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("starving-walker"));
    const player = await world.joinPlayer("starving-walker", "StarvingWalker");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    floor.monsters = floor.monsters.filter((monster) => monster.x !== step.x + step.dx || monster.y !== step.y + step.dy);
    floor.items = floor.items.filter((item) => item.x !== step.x + step.dx || item.y !== step.y + step.dy);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 1;
    player.state.hungerState = "starving";
    player.state.entity.hp = 3;

    world.handleInput(player.id, step.key);

    expect(player.phase).toBe("dead");
    const movement = journal.readAfter(movementStream(player, floor), 0, 64);
    const vitals = journal.readAfter(player.id, 0, 64);
    expect(movement).toEqual([expect.objectContaining({ v: 2, terminal: false })]);
    expect(vitals).toEqual([expect.objectContaining({ v: 1, terminal: true })]);
  });

  it("does not partially mutate a movement when its immutable journal append fails", async () => {
    const world = new WorldServer({
      originJournal: { appendTransition: () => { throw new Error("disk unavailable"); } },
    });
    world.registerConnection(connection("guarded-walker"));
    const player = await world.joinPlayer("guarded-walker", "GuardedWalker");
    if (typeof player === "string") throw new Error(player);

    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    const pickup = floor.items[0];
    if (!pickup) throw new Error("generated floor has no item for rollback proof");
    pickup.x = step.x + step.dx;
    pickup.y = step.y + step.dy;
    const before = JSON.parse(JSON.stringify({
      playerState: player.state,
      phase: player.phase,
      floorItems: floor.items,
      floorMonsters: floor.monsters,
      floorTraps: floor.traps,
    })) as unknown;

    world.handleInput(player.id, step.key);

    expect({
      playerState: player.state,
      phase: player.phase,
      floorItems: floor.items,
      floorMonsters: floor.monsters,
      floorTraps: floor.traps,
    }).toEqual(before);
    expect(player.messages.at(-1)).toBe("Turn journal unavailable — retry shortly.");
  });
});
