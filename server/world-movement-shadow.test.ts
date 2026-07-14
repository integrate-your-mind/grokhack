import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isWalkable } from "../src/dungeon.js";
import {
  combatTurnJournalStreamId,
  movementJournalRunId,
  movementTurnJournalStreamId,
  OriginGameplayJournal,
} from "./origin-journal.js";
import { createMonster } from "../src/entities.js";
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

function prepareTransfer(
  world: WorldServer,
  player: Exclude<Awaited<ReturnType<WorldServer["joinPlayer"]>>, string>,
): {
  sourceFloor: ReturnType<WorldServer["buildView"]>["floor"];
  pickupId: string;
  key: string;
} {
  const sourceFloor = world.buildView(player).floor;
  const { stairsDown, tiles } = sourceFloor.dungeon;
  const approach = [
    { x: stairsDown.x - 1, y: stairsDown.y, key: "l" },
    { x: stairsDown.x + 1, y: stairsDown.y, key: "h" },
    { x: stairsDown.x, y: stairsDown.y - 1, key: "j" },
    { x: stairsDown.x, y: stairsDown.y + 1, key: "k" },
  ].find(({ x, y }) => isWalkable(tiles, x, y));
  if (!approach) throw new Error("stairs have no walkable approach");
  const pickup = sourceFloor.items[0];
  if (!pickup) throw new Error("generated floor has no item for transfer persistence proof");
  sourceFloor.items = [{ ...pickup, x: stairsDown.x, y: stairsDown.y }];
  sourceFloor.monsters = sourceFloor.monsters.filter(
    (monster) => monster.x !== stairsDown.x || monster.y !== stairsDown.y,
  );
  sourceFloor.traps = [];
  player.state.entity.x = approach.x;
  player.state.entity.y = approach.y;
  player.state.hunger = 2_000;
  player.state.entity.hp = 999;
  player.state.entity.maxHp = 999;
  return { sourceFloor, pickupId: pickup.item.id, key: approach.key };
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

function movementTurnStream(
  player: Awaited<ReturnType<WorldServer["joinPlayer"]>>,
  floor: ReturnType<WorldServer["buildView"]>["floor"],
): string {
  if (typeof player === "string") throw new Error("player unavailable");
  if (!floor.movementAuthority) throw new Error("floor movement authority unavailable");
  return movementTurnJournalStreamId(
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

  it("publishes a movement decision and its turn/vitals transition in one envelope", async () => {
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

    const streamId = movementTurnStream(player, floor);
    const envelopes = journal.readMovementTurnsAfter(streamId, 0, 64);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.movement).toMatchObject({
      v: 2,
      command: { type: "move", dx: step.dx, dy: step.dy },
      terminal: false,
    });
    expect(envelopes[0]?.turn).toMatchObject({
      v: 1,
      command: { type: "advance_turn", action: "other" },
      terminal: false,
    });
    expect(journal.readAfter(player.id, 0, 64)).toEqual([]);
    expect(player.state).toMatchObject({
      turns: turnsBefore + 1,
      entity: { x: step.x + step.dx, y: step.y + step.dy },
    });
  });

  it("journals the origin-sampled player combat transcript without replaying monster authority", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("combat-walker"));
    const player = await world.joinPlayer("combat-walker", "CombatWalker");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    const monster = createMonster("rat", step.x + step.dx, step.y + step.dy, floor.depth);
    monster.hp = monster.maxHp = 1;
    floor.monsters.push(monster);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.entity.attack = 50;
    player.state.hunger = 2_000;
    player.state.entity.hp = player.state.entity.maxHp = 999;
    world.handleInput(player.id, step.key);
    const streamId = combatTurnJournalStreamId(
      player.id,
      movementJournalRunId(player.resumeToken ?? ""),
      floor.movementAuthority!,
    );
    const [envelope] = journal.readCombatTurnsAfter(streamId, 0, 64);
    expect(envelope).toMatchObject({
      cursor: 1,
      attacker: { id: player.state.entity.id, isPlayer: true },
      defender: { id: monster.id, hp: 1, isPlayer: false },
      targetKilled: true,
      terminal: false,
      turn: { command: { type: "advance_turn", action: "other" } },
    });
  });

  it("does not mutate combat state when the durable combat envelope rejects", async () => {
    const journal = createJournal();
    vi.spyOn(journal, "appendCombatTurn").mockImplementation(() => { throw new Error("injected combat journal failure"); });
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("combat-journal-failure"));
    const player = await world.joinPlayer("combat-journal-failure", "CombatJournalFailure");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    const monster = createMonster("rat", step.x + step.dx, step.y + step.dy, floor.depth);
    monster.hp = monster.maxHp = 1;
    floor.monsters.push(monster);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.entity.attack = 50;
    player.state.hunger = 2_000;
    world.handleInput(player.id, step.key);
    expect(monster.hp).toBe(1);
    expect(player.state.entity).toMatchObject({ x: step.x, y: step.y });
    expect(journal.hasPendingMovementTurn()).toBe(true);
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
    expect(journal.readMovementTurnsAfter(movementTurnStream(player, floor), 0, 64)).toHaveLength(1);
    expect(journal.readAfter(player.id, 0, 64)).toHaveLength(0);
    world.handleInput(player.id, ".");
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
    const streamId = movementTurnStream(player, floor);
    const wallEntry = journal.readMovementTurnsAfter(streamId, 0, 64)[0]?.movement;
    if (!wallEntry) throw new Error("missing movement entry");
    expect(wallEntry.beforeState.destination.tile === null || wallEntry.beforeState.destination.tile === "#").toBe(true);
    world.handleInput(player.id, wall.key);
    expect(journal.readMovementTurnsAfter(streamId, 0, 64)).toHaveLength(1);

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
    const playerEntry = journal.readMovementTurnsAfter(movementTurnStream(blocker, floor), 0, 64)[0]?.movement;
    if (!playerEntry) throw new Error("missing player collision entry");
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
    const streamId = movementTurnStream(player, floor);
    const trapEntry = journal.readMovementTurnsAfter(streamId, 0, 64)[0]?.movement;
    if (!trapEntry) throw new Error("missing trap movement entry");
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
    const transferEntry = journal.readMovementTurnsAfter(
      movementTurnStream(transferPlayer, currentFloor), 0, 64,
    )[0]?.movement;
    if (!transferEntry) throw new Error("missing transfer movement entry");
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
    const envelopes = journal.readMovementTurnsAfter(movementTurnStream(player, floor), 0, 64);
    expect(envelopes).toEqual([
      expect.objectContaining({
        movement: expect.objectContaining({ v: 2, terminal: false }),
        turn: expect.objectContaining({ v: 1, terminal: true }),
      }),
    ]);
  });

  it("marks origin application only after synchronous turn and status effects finish", async () => {
    const journal = createJournal();
    let world!: WorldServer;
    let playerDuringMark: { state: { turns: number; immobilizedTurns?: number } } | undefined;
    let appliedObservation: { turns: number; immobilizedTurns: number; totalTurns: number } | undefined;
    world = new WorldServer({
      originJournal: {
        appendTransition: journal.appendTransition.bind(journal),
        appendMovementTurn: journal.appendMovementTurn.bind(journal),
        prepareMovementTurn: journal.prepareMovementTurn.bind(journal),
        markMovementTurnApplied: (input) => {
          if (!playerDuringMark) throw new Error("missing player during applied marker");
          appliedObservation = {
            turns: playerDuringMark.state.turns,
            immobilizedTurns: playerDuringMark.state.immobilizedTurns ?? 0,
            totalTurns: world.getStats().totalTurns,
          };
          journal.markMovementTurnApplied(input);
        },
        markMovementTurnPersistenceCommitted: journal.markMovementTurnPersistenceCommitted.bind(journal),
        completeMovementTurnPreparation: journal.completeMovementTurnPreparation.bind(journal),
        hasPendingMovementTurn: journal.hasPendingMovementTurn.bind(journal),
        movementAuthorityForFloor: journal.movementAuthorityForFloor.bind(journal),
        validateMovementAuthorityRegistry: journal.validateMovementAuthorityRegistry.bind(journal),
      },
    });
    world.registerConnection(connection("applied-order"));
    const player = await world.joinPlayer("applied-order", "AppliedOrder");
    if (typeof player === "string") throw new Error(player);
    playerDuringMark = player;
    const floor = world.buildView(player).floor;
    floor.monsters = [];
    floor.items = [];
    floor.traps = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.immobilizedTurns = 1;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    const turnsBefore = player.state.turns;

    world.handleInput(player.id, step.key);

    expect(appliedObservation).toEqual({
      turns: turnsBefore + 1,
      immobilizedTurns: 0,
      totalTurns: 1,
    });
    expect(journal.hasPendingMovementTurn()).toBe(false);
    expect(world.getStats().shadowEvidenceDegraded).toBe(false);
  });

  it("recovers same-process availability after an applied-marker rename acknowledgement loss", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-applied-ack-loss-"));
    directories.push(directory);
    let preparationRenames = 0;
    const journal = new OriginGameplayJournal(directory, {
      renameMovementTurnPreparationSync: (from, to) => {
        fs.renameSync(from, to);
        preparationRenames++;
        if (preparationRenames === 2) {
          throw new Error("injected origin-applied rename acknowledgement loss");
        }
      },
    });
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("applied-ack-loss"));
    const player = await world.joinPlayer("applied-ack-loss", "AppliedAckLoss");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    floor.monsters = [];
    floor.items = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;

    world.handleInput(player.id, step.key);

    expect(preparationRenames).toBe(3);
    expect(world.getStats().shadowEvidenceDegraded).toBe(false);
    expect(journal.hasPendingMovementTurn()).toBe(false);
    expect(player.messages).not.toContain("Turn completed; shadow evidence is degraded.");
  });

  it("recovers same-process availability after a persistence-marker rename acknowledgement loss", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-persisted-ack-loss-"));
    directories.push(directory);
    let preparationRenames = 0;
    const journal = new OriginGameplayJournal(directory, {
      renameMovementTurnPreparationSync: (from, to) => {
        fs.renameSync(from, to);
        preparationRenames++;
        if (preparationRenames === 3) {
          throw new Error("injected persistence marker rename acknowledgement loss");
        }
      },
    });
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("persisted-ack-loss"));
    const player = await world.joinPlayer("persisted-ack-loss", "PersistedAckLoss");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    floor.monsters = [];
    floor.items = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;

    world.handleInput(player.id, step.key);

    expect(preparationRenames).toBe(3);
    expect(world.getStats().shadowEvidenceDegraded).toBe(false);
    expect(journal.hasPendingMovementTurn()).toBe(false);
    expect(player.messages).not.toContain("Turn completed; shadow evidence is degraded.");
  });

  it("keeps movement fenced until its player and floor persistence acknowledgement", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-world-persistence-fence-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory);
    let acknowledgePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      acknowledgePersistence = resolve;
    });
    const world = new WorldServer({
      originJournal: journal,
      persistMovementTurn: () => persistence,
    });
    world.registerConnection(connection("persistence-fence"));
    const player = await world.joinPlayer("persistence-fence", "PersistenceFence");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    floor.monsters = [];
    floor.items = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;

    world.handleInput(player.id, step.key);
    const committed = {
      x: player.state.entity.x,
      y: player.state.entity.y,
      turns: player.state.turns,
    };
    expect(world.getStats().shadowEvidenceDegraded).toBe(true);
    expect(journal.hasPendingMovementTurn()).toBe(true);

    world.handleInput(player.id, step.key);
    expect({ x: player.state.entity.x, y: player.state.entity.y, turns: player.state.turns })
      .toEqual(committed);
    expect(player.messages).toContain("Movement persistence is still committing — retry shortly.");

    acknowledgePersistence();
    await vi.waitFor(() => {
      expect(world.getStats().shadowEvidenceDegraded).toBe(false);
      expect(journal.hasPendingMovementTurn()).toBe(false);
    });
  });

  it("holds the graceful durability barrier until movement persistence finishes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-world-shutdown-fence-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory);
    let acknowledgePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      acknowledgePersistence = resolve;
    });
    const world = new WorldServer({
      originJournal: journal,
      persistMovementTurn: () => persistence,
    });
    world.registerConnection(connection("shutdown-persistence-fence"));
    const player = await world.joinPlayer("shutdown-persistence-fence", "ShutdownPersistenceFence");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    floor.monsters = [];
    floor.items = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    world.handleInput(player.id, step.key);
    expect(journal.hasPendingMovementTurn()).toBe(true);

    world.beginShutdown();
    let durabilityFinished = false;
    const durability = world.flushAllDurable().then(() => {
      durabilityFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(durabilityFinished).toBe(false);

    acknowledgePersistence();
    await durability;
    expect(journal.hasPendingMovementTurn()).toBe(false);
    expect(world.getStats().shadowEvidenceDegraded).toBe(false);
  });

  it("fails the graceful durability barrier when movement persistence remains poisoned", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-world-shutdown-poison-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory);
    const world = new WorldServer({
      originJournal: journal,
      persistMovementTurn: async () => {
        throw new Error("injected shutdown persistence failure");
      },
    });
    world.registerConnection(connection("shutdown-persistence-poison"));
    const player = await world.joinPlayer("shutdown-persistence-poison", "ShutdownPersistencePoison");
    if (typeof player === "string") throw new Error(player);
    const floor = world.buildView(player).floor;
    floor.traps = [];
    floor.monsters = [];
    floor.items = [];
    const step = ordinaryStep(floor);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    world.handleInput(player.id, step.key);
    await vi.waitFor(() => {
      expect(player.messages).toContain("Turn completed; shadow evidence is degraded.");
    });

    world.beginShutdown();
    await expect(world.flushAllDurable()).rejects.toThrow("movement turn persistence remains unresolved");
    expect(journal.hasPendingMovementTurn()).toBe(true);
  });

  it("keeps both source and destination floor mutations fenced during a transfer", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-world-transfer-fence-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory);
    let acknowledgePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      acknowledgePersistence = resolve;
    });
    let persistedFloorDepths: number[] = [];
    let persistedSourceHasPickup: boolean | undefined;
    const world = new WorldServer({
      originJournal: journal,
      persistMovementTurn: (_player, floors) => {
        persistedFloorDepths = floors.map((floor) => floor.depth);
        persistedSourceHasPickup = floors.find((floor) => floor.depth === 1)?.items
          .some((ground) => ground.item.id === pickupId);
        return persistence;
      },
    });
    world.registerConnection(connection("transfer-persistence-fence"));
    const player = await world.joinPlayer("transfer-persistence-fence", "TransferPersistenceFence");
    if (typeof player === "string") throw new Error(player);
    const { sourceFloor, pickupId, key } = prepareTransfer(world, player);

    world.handleInput(player.id, key);

    expect(player.floorDepth).toBe(2);
    expect(sourceFloor.items.some((ground) => ground.item.id === pickupId)).toBe(false);
    expect(persistedFloorDepths).toEqual([1, 2]);
    expect(persistedSourceHasPickup).toBe(false);
    expect(world.getStats().shadowEvidenceDegraded).toBe(true);
    expect(journal.hasPendingMovementTurn()).toBe(true);

    acknowledgePersistence();
    await vi.waitFor(() => {
      expect(world.getStats().shadowEvidenceDegraded).toBe(false);
      expect(journal.hasPendingMovementTurn()).toBe(false);
    });
  });

  it("keeps a failed source-and-destination transfer persistence attempt fenced", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-world-transfer-failure-"));
    directories.push(directory);
    const journal = new OriginGameplayJournal(directory);
    let persistedFloorDepths: number[] = [];
    let persistedSourceHasPickup: boolean | undefined;
    let pickupId = "";
    const world = new WorldServer({
      originJournal: journal,
      persistMovementTurn: async (_player, floors) => {
        persistedFloorDepths = floors.map((floor) => floor.depth);
        persistedSourceHasPickup = floors.find((floor) => floor.depth === 1)?.items
          .some((ground) => ground.item.id === pickupId);
        throw new Error("injected destination floor persistence failure");
      },
    });
    world.registerConnection(connection("transfer-persistence-failure"));
    const player = await world.joinPlayer("transfer-persistence-failure", "TransferPersistenceFailure");
    if (typeof player === "string") throw new Error(player);
    const prepared = prepareTransfer(world, player);
    pickupId = prepared.pickupId;

    world.handleInput(player.id, prepared.key);

    await vi.waitFor(() => {
      expect(player.messages).toContain("Turn completed; shadow evidence is degraded.");
    });
    expect(player.floorDepth).toBe(2);
    expect(prepared.sourceFloor.items.some((ground) => ground.item.id === pickupId)).toBe(false);
    expect(persistedFloorDepths).toEqual([1, 2]);
    expect(persistedSourceHasPickup).toBe(false);
    expect(world.getStats().shadowEvidenceDegraded).toBe(true);
    expect(journal.hasPendingMovementTurn()).toBe(true);
  });

  it("recovers exact DB commit receipts while fencing pre-ack and tampered crashes", () => {
    const scenarios = [
      { name: "normal_completion", status: 0, recovered: true, persisted: "after", receipt: false },
      { name: "before_ack", status: 77, recovered: false, persisted: "before", receipt: false },
      { name: "after_db_commit", status: 79, recovered: true, persisted: "after", receipt: false },
      { name: "after_db_commit_tampered", status: 80, recovered: false, persisted: "after", receipt: true },
      { name: "after_persistence_commit", status: 78, recovered: true, persisted: "after", receipt: false },
    ] as const;
    for (const scenario of scenarios) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grokhack-world-${scenario.name}-`));
      directories.push(directory);
      const environment = {
        ...process.env,
        GROKHACK_DATA_DIR: path.join(directory, "data"),
        GROKHACK_DB_PATH: path.join(directory, "data", "world.duckdb"),
        GROKHACK_DISCONNECT_GRACE_MS: "0",
        IRC_ENABLED: "0",
      };
      const crash = spawnSync(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        `
          import fs from "node:fs";
          import path from "node:path";
          import { isWalkable } from "./src/dungeon.ts";
          import {
            movementJournalRunId,
            movementTurnJournalStreamId,
            OriginGameplayJournal,
          } from "./server/origin-journal.ts";
          import {
            closePersistence,
            flushPersistence,
            hasMovementTurnCommit,
            initPersistence,
            saveFloorNow,
            saveMovementTurnNow,
            savePlayerNow,
          } from "./server/persistence.ts";
          import { WorldServer } from "./server/world.ts";
          const root = process.argv[1];
          const scenario = process.argv[2];
          await initPersistence();
          const journal = new OriginGameplayJournal(path.join(root, "journal"),
            scenario === "after_persistence_commit"
              ? { unlinkMovementTurnPreparationSync() { process.exit(78); } }
              : {});
          const world = new WorldServer({
            loadResumablePlayer: async () => null,
            originJournal: journal,
            ...(scenario === "before_ack"
              ? { persistMovementTurn: async () => { process.exit(77); } }
              : scenario === "after_db_commit" || scenario === "after_db_commit_tampered"
                ? {
                    persistMovementTurn: async (player, floors, identity) => {
                      await saveMovementTurnNow(player, floors, identity, {
                        afterCommit() {
                          if (scenario === "after_db_commit_tampered") {
                            const marker = path.join(
                              root,
                              "journal",
                              "movement-turn-v1",
                              ".movement-turn-preparation-v1.json",
                            );
                            const tampered = JSON.parse(fs.readFileSync(marker, "utf8"));
                            tampered.operationId = "00000000-0000-4000-8000-000000000099";
                            fs.writeFileSync(marker, JSON.stringify(tampered));
                            process.exit(80);
                          }
                          process.exit(79);
                        },
                      });
                    },
                  }
              : {}),
          });
          await world.hydrateFromDatabase();
          const connection = {
            id: "cold-crash",
            sessionId: "cold-crash-session",
            transport: "websocket",
            playerId: null,
            agentMode: false,
            send() {},
            close() {},
          };
          world.registerConnection(connection);
          const player = await world.joinPlayer(connection.id, "ColdCrash");
          if (typeof player === "string" || !player.resumeToken) throw new Error(String(player));
          const floor = world.buildView(player).floor;
          floor.monsters = [];
          floor.items = [];
          floor.traps = [];
          const directions = [
            { dx: 1, dy: 0, key: "l" },
            { dx: -1, dy: 0, key: "h" },
            { dx: 0, dy: 1, key: "j" },
            { dx: 0, dy: -1, key: "k" },
          ];
          const step = floor.dungeon.tiles.flatMap((row, y) => row.map((_tile, x) => ({ x, y })))
            .flatMap(({ x, y }) => directions.map((direction) => ({ x, y, ...direction })))
            .find(({ x, y, dx, dy }) => {
              const targetX = x + dx;
              const targetY = y + dy;
              return isWalkable(floor.dungeon.tiles, x, y) &&
                isWalkable(floor.dungeon.tiles, targetX, targetY) &&
                (targetX !== floor.dungeon.stairsDown.x || targetY !== floor.dungeon.stairsDown.y);
            });
          if (!step || !floor.movementAuthority) throw new Error("no ordinary crash step");
          player.state.entity.x = step.x;
          player.state.entity.y = step.y;
          player.state.hunger = 2_000;
          player.state.entity.hp = 999;
          player.state.entity.maxHp = 999;
          const baseline = {
            playerId: player.id,
            x: player.state.entity.x,
            y: player.state.entity.y,
            turns: player.state.turns,
            hunger: player.state.hunger,
            key: step.key,
            dx: step.dx,
            dy: step.dy,
            streamId: movementTurnJournalStreamId(
              player.id,
              movementJournalRunId(player.resumeToken),
              floor.movementAuthority,
            ),
          };
          await savePlayerNow(player);
          await saveFloorNow(floor);
          await flushPersistence();
          fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify(baseline));
          world.handleInput(player.id, step.key);
          if (scenario === "normal_completion") {
            for (let attempt = 0; attempt < 200 && world.getStats().shadowEvidenceDegraded; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            const envelope = journal.readMovementTurnsAfter(baseline.streamId, 0, 1)[0];
            const receipt = envelope
              ? await hasMovementTurnCommit({ streamId: envelope.streamId, operationId: envelope.operationId })
              : false;
            process.stdout.write("NORMAL_RESULT " + JSON.stringify({
              degraded: world.getStats().shadowEvidenceDegraded,
              pending: journal.hasPendingMovementTurn(),
              receipt,
            }) + "\\n");
            await flushPersistence();
            await closePersistence();
            process.exit(0);
          }
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          throw new Error("crash injection did not fire");
        `,
        directory,
        scenario.name,
      ], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 20_000 });
      expect(crash.status, `${scenario.name}: ${crash.stderr}`).toBe(scenario.status);
      if (scenario.name === "normal_completion") {
        const normalLine = crash.stdout.split("\n").find((line) => line.startsWith("NORMAL_RESULT "));
        expect(normalLine).toBeDefined();
        expect(JSON.parse(normalLine!.slice("NORMAL_RESULT ".length))).toEqual({
          degraded: false,
          pending: false,
          receipt: false,
        });
      }

      const restart = spawnSync(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e",
        `
          import fs from "node:fs";
          import path from "node:path";
          import { reduceGameplay } from "./src/gameplay-reducer.ts";
          import { reduceMovement } from "./src/movement-reducer.ts";
          import { OriginGameplayJournal } from "./server/origin-journal.ts";
          import {
            closePersistence,
            hasMovementTurnCommit,
            initPersistence,
          } from "./server/persistence.ts";
          import { WorldServer } from "./server/world.ts";
          const root = process.argv[1];
          const baseline = JSON.parse(fs.readFileSync(path.join(root, "baseline.json"), "utf8"));
          await initPersistence();
          const journal = new OriginGameplayJournal(path.join(root, "journal"));
          const world = new WorldServer({ originJournal: journal });
          await world.hydrateFromDatabase();
          const player = world.getPlayer(baseline.playerId);
          const envelope = journal.readMovementTurnsAfter(baseline.streamId, 0, 1)[0];
          const movementAfter = envelope && reduceMovement(envelope.movement.beforeState, envelope.movement.command).state;
          const turnAfter = envelope?.turn && reduceGameplay(envelope.turn.beforeState, envelope.turn.command).state;
          const result = {
            degraded: world.getStats().shadowEvidenceDegraded,
            pending: journal.hasPendingMovementTurn(),
            receipt: envelope
              ? await hasMovementTurnCommit({ streamId: envelope.streamId, operationId: envelope.operationId })
              : false,
            baseline,
            persisted: player && {
              x: player.state.entity.x,
              y: player.state.entity.y,
              turns: player.state.turns,
              hunger: player.state.hunger,
            },
            envelopeAfter: movementAfter && turnAfter && {
              x: movementAfter.x,
              y: movementAfter.y,
              turns: turnAfter.turns,
              hunger: turnAfter.hunger,
            },
          };
          await closePersistence();
          process.stdout.write("COLD_RESULT " + JSON.stringify(result) + "\\n");
        `,
        directory,
      ], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 20_000 });
      expect(restart.status, `${scenario.name}: ${restart.stderr}`).toBe(0);
      const resultLine = restart.stdout.split("\n").find((line) => line.startsWith("COLD_RESULT "));
      if (!resultLine) throw new Error(`missing ${scenario.name} cold restart result: ${restart.stdout}`);
      const result = JSON.parse(resultLine.slice("COLD_RESULT ".length)) as {
        degraded: boolean;
        pending: boolean;
        receipt: boolean;
        baseline: { x: number; y: number; turns: number; hunger: number };
        persisted: { x: number; y: number; turns: number; hunger: number };
        envelopeAfter: { x: number; y: number; turns: number; hunger: number };
      };
      if (scenario.persisted === "after") {
        expect(result.persisted).toEqual(result.envelopeAfter);
      } else {
        expect(result.persisted).toEqual({
          x: result.baseline.x,
          y: result.baseline.y,
          turns: result.baseline.turns,
          hunger: result.baseline.hunger,
        });
        expect(result.envelopeAfter).not.toEqual(result.persisted);
      }
      expect(result.receipt).toBe(scenario.receipt);
      if (scenario.recovered) {
        expect(result).toMatchObject({ degraded: false, pending: false });
      } else {
        expect(result).toMatchObject({ degraded: true, pending: true });
      }
    }
  }, 60_000);

  it("does not partially mutate a movement when durable preparation fails", async () => {
    const world = new WorldServer({
      originJournal: {
        appendTransition: () => { throw new Error("unexpected legacy append"); },
        appendMovementTurn: () => { throw new Error("unexpected envelope append"); },
        prepareMovementTurn: () => { throw new Error("disk unavailable"); },
        markMovementTurnApplied: () => { throw new Error("unexpected apply marker"); },
        markMovementTurnPersistenceCommitted: () => { throw new Error("unexpected persistence marker"); },
        completeMovementTurnPreparation: () => { throw new Error("unexpected preparation completion"); },
        hasPendingMovementTurn: () => false,
      },
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

  it("rolls a started movement forward and latches degradation when the atomic envelope fails", async () => {
    const journal = createJournal();
    let playerDuringAppend: { state: { turns: number; hunger: number } } | undefined;
    let appendObservation: { turns: number; hunger: number } | undefined;
    const world = new WorldServer({
      originJournal: {
        appendTransition: journal.appendTransition.bind(journal),
        appendMovementTurn: () => {
          appendObservation = playerDuringAppend
            ? { turns: playerDuringAppend.state.turns, hunger: playerDuringAppend.state.hunger }
            : undefined;
          throw new Error("injected envelope commit failure");
        },
        prepareMovementTurn: journal.prepareMovementTurn.bind(journal),
        markMovementTurnApplied: journal.markMovementTurnApplied.bind(journal),
        markMovementTurnPersistenceCommitted: journal.markMovementTurnPersistenceCommitted.bind(journal),
        completeMovementTurnPreparation: journal.completeMovementTurnPreparation.bind(journal),
        hasPendingMovementTurn: journal.hasPendingMovementTurn.bind(journal),
        movementAuthorityForFloor: journal.movementAuthorityForFloor.bind(journal),
        validateMovementAuthorityRegistry: journal.validateMovementAuthorityRegistry.bind(journal),
      },
    });
    world.registerConnection(connection("degraded-walker"));
    const player = await world.joinPlayer("degraded-walker", "DegradedWalker");
    if (typeof player === "string") throw new Error(player);
    playerDuringAppend = player;

    const floor = world.buildView(player).floor;
    floor.traps = [];
    const step = ordinaryStep(floor);
    floor.monsters = floor.monsters.filter((monster) =>
      monster.x !== step.x + step.dx || monster.y !== step.y + step.dy);
    floor.items = floor.items.filter((item) =>
      item.x !== step.x + step.dx || item.y !== step.y + step.dy);
    player.state.entity.x = step.x;
    player.state.entity.y = step.y;
    player.state.hunger = 2_000;
    player.state.entity.hp = 999;
    player.state.entity.maxHp = 999;
    const before = {
      turns: player.state.turns,
      hunger: player.state.hunger,
      x: player.state.entity.x,
      y: player.state.entity.y,
    };

    world.handleInput(player.id, step.key);

    expect(player.state).toMatchObject({
      turns: before.turns + 1,
      entity: { x: before.x + step.dx, y: before.y + step.dy },
    });
    expect(player.state.hunger).toBeLessThan(before.hunger);
    expect(appendObservation).toEqual({ turns: before.turns + 1, hunger: player.state.hunger });
    expect(world.getStats().shadowEvidenceDegraded).toBe(true);
    expect(player.messages).toContain("Turn completed; shadow evidence is degraded.");
    expect(journal.readMovementTurnsAfter(movementTurnStream(player, floor), 0, 64)).toEqual([]);
    const restarted = new WorldServer({ originJournal: journal });
    expect(restarted.getStats().shadowEvidenceDegraded).toBe(true);
    restarted.registerConnection(connection("degraded-restart"));
    const resumedPlayer = await restarted.joinPlayer("degraded-restart", "DegradedRestart");
    if (typeof resumedPlayer === "string") throw new Error(resumedPlayer);
    const resumedFloor = restarted.buildView(resumedPlayer).floor;
    resumedFloor.traps = [];
    const resumedStep = ordinaryStep(resumedFloor);
    resumedFloor.monsters = resumedFloor.monsters.filter((candidate) =>
      candidate.x !== resumedStep.x + resumedStep.dx || candidate.y !== resumedStep.y + resumedStep.dy);
    resumedFloor.items = resumedFloor.items.filter((candidate) =>
      candidate.x !== resumedStep.x + resumedStep.dx || candidate.y !== resumedStep.y + resumedStep.dy);
    resumedPlayer.state.entity.x = resumedStep.x;
    resumedPlayer.state.entity.y = resumedStep.y;
    const resumedTurns = resumedPlayer.state.turns;

    restarted.handleInput(resumedPlayer.id, resumedStep.key);

    // A cold process cannot safely admit another turn while a durable prepared
    // marker has no matching persistence receipt. Doing so would let a new
    // command race an unresolved combat/movement decision from before restart.
    expect(resumedPlayer.state).toMatchObject({
      turns: resumedTurns,
      entity: { x: resumedStep.x, y: resumedStep.y },
    });
    expect(resumedPlayer.messages).toContain("Movement persistence is still committing — retry shortly.");
    expect(restarted.getStats().shadowEvidenceDegraded).toBe(true);
    expect(journal.hasPendingMovementTurn()).toBe(true);
    expect(journal.readMovementTurnsAfter(movementTurnStream(resumedPlayer, resumedFloor), 0, 64)).toEqual([]);
  });
});
