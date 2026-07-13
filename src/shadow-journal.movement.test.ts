import { describe, expect, it } from "vitest";

import type { MovementState } from "./movement-reducer.js";
import {
  createShadowJournalEntry,
  shadowEntryHash,
  validateShadowJournalEntry,
} from "./shadow-journal.js";

const movementState = (overrides: Partial<MovementState> = {}): MovementState => ({
  authority: { realmId: "test", floorInstanceId: "floor-1", depth: 1, floorEpoch: 1, rulesetVersion: 1 },
  x: 4,
  y: 7,
  phase: "playing",
  alive: true,
  immobilizedTurns: 0,
  destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  ...overrides,
});

describe("movement shadow journal envelope", () => {
  it("creates a V2 movement entry without changing the frozen V1 hash format", () => {
    const legacy = createShadowJournalEntry({
      streamId: "legacy",
      cursor: 1,
      command: { type: "advance_turn", action: "wait" },
      beforeState: { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 20, alive: true },
    });
    expect(legacy).toMatchObject({ v: 1, entryHash: "f4112de5415fae40" });

    const movement = createShadowJournalEntry({
      streamId: "movement",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    expect(movement).toMatchObject({ v: 2, command: { type: "move", dx: 1, dy: 0 }, terminal: false });
    expect(movement.beforeContinuityHash).toMatch(/^[0-9a-f]{16}$/u);
    expect(movement.afterContinuityHash).toMatch(/^[0-9a-f]{16}$/u);
    expect(movement.eventHash).toMatch(/^[0-9a-f]{16}$/u);
    expect(validateShadowJournalEntry(JSON.parse(JSON.stringify(movement)) as unknown)).toEqual(movement);
  });

  it("rejects malformed directions and hash/event tampering", () => {
    expect(() => createShadowJournalEntry({
      streamId: "movement",
      cursor: 1,
      command: { type: "move", dx: 0, dy: 0 },
      beforeState: movementState(),
    })).toThrow(RangeError);
    const entry = createShadowJournalEntry({
      streamId: "movement",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    const tamperedEvent = { ...entry, eventHash: "0000000000000000" };
    expect(() => validateShadowJournalEntry(tamperedEvent)).toThrow("entry_hash_mismatch");
    const rehashedTamper = { ...tamperedEvent, entryHash: shadowEntryHash(tamperedEvent) };
    expect(validateShadowJournalEntry(rehashedTamper)).toEqual(rehashedTamper);
    const badState = { ...entry, beforeState: { ...entry.beforeState, x: -1 } };
    expect(() => validateShadowJournalEntry(badState)).toThrow("invalid_movement_state");
    const badContinuity = { ...entry, beforeContinuityHash: "0000000000000000" };
    expect(() => validateShadowJournalEntry(badContinuity)).toThrow("before_continuity_hash_mismatch");
  });
});
