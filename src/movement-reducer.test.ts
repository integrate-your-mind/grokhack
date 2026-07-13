import { describe, expect, it } from "vitest";

import {
  movementContinuityHash,
  movementEventHash,
  movementStateHash,
  reduceMovement,
  validateMovementState,
  type MovementState,
} from "./movement-reducer.js";

const state = (overrides: Partial<MovementState> = {}): MovementState => ({
  authority: { realmId: "test", floorInstanceId: "floor-1", depth: 1, floorEpoch: 1, rulesetVersion: 1 },
  x: 10,
  y: 10,
  phase: "playing",
  alive: true,
  immobilizedTurns: 0,
  destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  ...overrides,
});

describe("reduceMovement", () => {
  it.each([
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ])("moves once for direction %i,%i without mutating input", (dx, dy) => {
    const input = Object.freeze(state({ destination: Object.freeze({ tile: ".", occupant: "none", trap: false, stairsDown: false }) }));
    const transition = reduceMovement(input, { type: "move", dx, dy });
    expect(transition).toMatchObject({
      state: { x: 10 + dx, y: 10 + dy },
      outcome: "moved",
      turnCost: "after_effects",
    });
    expect(transition.events.map((event) => event.type)).toEqual([
      "moved", "pickup_intent", "room_step_intent", "turn_intent", "visibility_intent",
    ]);
    expect(input).toEqual(state());
  });

  it("keeps wall, bounds, player, and monster decisions behaviorally distinct", () => {
    const wall = reduceMovement(state({ destination: { tile: "#", occupant: "none", trap: false, stairsDown: false } }), { type: "move", dx: 1, dy: 0 });
    const bounds = reduceMovement(state({ destination: { tile: null, occupant: "none", trap: false, stairsDown: false } }), { type: "move", dx: 1, dy: 0 });
    const player = reduceMovement(state({ destination: { tile: ".", occupant: "player", trap: false, stairsDown: false } }), { type: "move", dx: 1, dy: 0 });
    const monster = reduceMovement(state({ destination: { tile: ".", occupant: "monster", trap: false, stairsDown: false } }), { type: "move", dx: 1, dy: 0 });
    expect([wall.outcome, bounds.outcome, player.outcome, monster.outcome]).toEqual([
      "blocked_terrain", "blocked_terrain", "blocked_player", "combat_intent",
    ]);
    expect([wall.turnCost, bounds.turnCost, player.turnCost, monster.turnCost]).toEqual([
      "none", "none", "none", "consume",
    ]);
    expect(new Set([movementEventHash(wall), movementEventHash(player), movementEventHash(monster)]).size).toBe(3);
    expect(wall.state).toMatchObject({ x: 10, y: 10 });
    expect(player.state).toMatchObject({ x: 10, y: 10 });
    expect(monster.state).toMatchObject({ x: 10, y: 10 });
  });

  it("emits ordered door, pickup, trap, room, transfer, turn, and visibility intents", () => {
    const transition = reduceMovement(state({
      destination: { tile: ">", occupant: "none", trap: true, stairsDown: true },
    }), { type: "move", dx: 0, dy: 1 });
    expect(transition.events.map((event) => event.type)).toEqual([
      "moved", "pickup_intent", "trap_intent", "room_step_intent", "transfer_intent", "turn_intent", "visibility_intent",
    ]);
    const door = reduceMovement(state({
      destination: { tile: "+", occupant: "none", trap: false, stairsDown: false },
    }), { type: "move", dx: 1, dy: 0 });
    expect(door.events.map((event) => event.type)).toContain("door_crossed");
  });

  it("turns an immobilized move into a struggle and ignores non-playing state", () => {
    expect(reduceMovement(state({ immobilizedTurns: 2 }), { type: "move", dx: 1, dy: 0 })).toMatchObject({
      state: { x: 10, y: 10, immobilizedTurns: 2 },
      outcome: "struggle",
      turnCost: "consume",
    });
    expect(reduceMovement(state({ phase: "dead", alive: false }), { type: "move", dx: 1, dy: 0 })).toMatchObject({
      outcome: "ignored",
      turnCost: "none",
      events: [],
    });
  });

  it.each([
    { type: "move", dx: 0, dy: 0 },
    { type: "move", dx: 2, dy: 0 },
    { type: "move", dx: 0.5, dy: 1 },
    { type: "move", dx: Number.NaN, dy: 1 },
  ])("rejects invalid direction %#", (command) => {
    expect(() => reduceMovement(state(), command as { type: "move"; dx: number; dy: number })).toThrow(RangeError);
  });

  it("rejects an internally inconsistent walkable snapshot that would leave coordinate bounds", () => {
    expect(() => reduceMovement(state({ x: 0 }), { type: "move", dx: -1, dy: 0 })).toThrow("invalid movement destination");
    expect(() => reduceMovement(state({ x: Number.MAX_SAFE_INTEGER }), { type: "move", dx: 1, dy: 0 })).toThrow("invalid movement destination");
  });

  it("validates and hashes every movement input field", () => {
    const input = state();
    expect(validateMovementState(JSON.parse(JSON.stringify(input)) as unknown)).toEqual(input);
    expect(movementStateHash(input)).toMatch(/^[0-9a-f]{16}$/u);
    expect(movementStateHash(state({ destination: { ...input.destination, trap: true } }))).not.toBe(movementStateHash(input));
    expect(movementStateHash(state({ authority: { ...input.authority, depth: 2, floorInstanceId: "floor-2" } }))).not.toBe(movementStateHash(input));
    expect(() => validateMovementState({ ...input, x: -1 })).toThrow("invalid_movement_state");
    expect(() => validateMovementState({ ...input, authority: { ...input.authority, floorInstanceId: "../escape" } })).toThrow("invalid_movement_state");
    expect(() => validateMovementState({ ...input, destination: { ...input.destination, tile: "?" } })).toThrow("invalid_movement_state");
  });

  it("separates fresh destination observations from carried movement continuity", () => {
    const input = state();
    const differentObservation = state({
      destination: { tile: ">", occupant: "monster", trap: true, stairsDown: true },
    });
    expect(movementStateHash(differentObservation)).not.toBe(movementStateHash(input));
    expect(movementContinuityHash(differentObservation)).toBe(movementContinuityHash(input));
    expect(movementContinuityHash({ ...input, x: input.x + 1 })).not.toBe(movementContinuityHash(input));
  });
});
