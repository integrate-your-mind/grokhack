import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isWalkable } from "../src/dungeon.js";
import { movementJournalStreamId, OriginGameplayJournal } from "./origin-journal.js";
import type { ClientConnection } from "./types.js";
import { WorldServer } from "./world.js";

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

describe("WorldServer movement shadow journal", () => {
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

    const movementStream = movementJournalStreamId(player.id, floor.depth);
    const entries = journal.readAfter(movementStream, 0, 64);
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
    const movementStream = movementJournalStreamId(player.id, floor.depth);
    const wallEntry = journal.readAfter(movementStream, 0, 64)[0];
    if (!wallEntry || wallEntry.v !== 2) throw new Error("missing movement entry");
    expect(wallEntry.beforeState.destination.tile === null || wallEntry.beforeState.destination.tile === "#").toBe(true);
    world.handleInput(player.id, wall.key);
    expect(journal.readAfter(movementStream, 0, 64)).toHaveLength(1);

    const open = ordinaryStep(floor);
    player.state.entity.x = open.x;
    player.state.entity.y = open.y;
    blocker.state.entity.x = open.x + open.dx;
    blocker.state.entity.y = open.y + open.dy;
    const beforePlayerTurns = player.state.turns;
    world.handleInput(player.id, open.key);
    expect(player.state).toMatchObject({ turns: beforePlayerTurns, entity: { x: open.x, y: open.y } });
    const playerEntry = journal.readAfter(movementStream, 1, 64)[0];
    if (!playerEntry || playerEntry.v !== 2) throw new Error("missing player collision entry");
    expect(playerEntry.beforeState.destination.occupant).toBe("player");
    expect(player.messages.at(-1)).toBe("BlockingWalker is in the way.");
  });

  it("captures trap and transfer intents from authoritative floor state", async () => {
    const journal = createJournal();
    const world = new WorldServer({ originJournal: journal });
    world.registerConnection(connection("intent-walker"));
    const player = await world.joinPlayer("intent-walker", "IntentWalker");
    if (typeof player === "string") throw new Error(player);
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
    const movementStream = movementJournalStreamId(player.id, floor.depth);
    const trapEntry = journal.readAfter(movementStream, 0, 64)[0];
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
    player.state.immobilizedTurns = 0;
    player.state.entity.x = attempts.x;
    player.state.entity.y = attempts.y;
    currentFloor.monsters = currentFloor.monsters.filter((monster) => monster.x !== stairsDown.x || monster.y !== stairsDown.y);
    currentFloor.items = currentFloor.items.filter((item) => item.x !== stairsDown.x || item.y !== stairsDown.y);
    currentFloor.traps = [];
    world.handleInput(player.id, attempts.key);
    const transferEntry = journal.readAfter(movementStream, 1, 64)[0];
    if (!transferEntry || transferEntry.v !== 2) throw new Error("missing transfer movement entry");
    expect(transferEntry.beforeState.destination).toMatchObject({ tile: ">", stairsDown: true });
    expect(transferEntry.command).toEqual({ type: "move", dx: attempts.dx, dy: attempts.dy });
    expect(player.floorDepth).toBe(2);
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
    const movement = journal.readAfter(movementJournalStreamId(player.id, floor.depth), 0, 64);
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
