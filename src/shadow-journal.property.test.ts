import { describe, expect, it } from "vitest";

import { gameplayStateHash, reduceGameplay, replayGameplayTrace, type GameplayState } from "./gameplay-reducer.js";
import { movementEventHash, movementStateHash, reduceMovement, type MovementState } from "./movement-reducer.js";
import {
  createShadowJournalEntry,
  validateShadowJournalEntry,
  type GameplayShadowJournalEntry,
  type MovementShadowJournalEntry,
} from "./shadow-journal.js";

describe("shadow journal seeded properties", () => {
  it("preserves reducer parity and a contiguous hash chain across generated traces", () => {
    let seed = 0x51ad0;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 100; run++) {
      const initial: GameplayState = {
        turns: 0,
        depth: 1 + Math.floor(random() * 15),
        hunger: 100 + Math.floor(random() * 901),
        maxHunger: 1000,
        hungerState: "normal",
        hp: 10 + Math.floor(random() * 91),
        alive: true,
      };
      let state = initial;
      const steps = 1 + Math.floor(random() * 50);
      const commands = [];
      let previousEntryHash: string | null = null;
      for (let cursor = 1; cursor <= steps && state.alive; cursor++) {
        const command = { type: "advance_turn", action: random() < 0.5 ? "wait" : "other" } as const;
        const entry: GameplayShadowJournalEntry = createShadowJournalEntry({ streamId: `property_${run}`, cursor, command, beforeState: state, previousEntryHash });
        expect(validateShadowJournalEntry(JSON.parse(JSON.stringify(entry)) as unknown)).toEqual(entry);
        expect(entry.previousEntryHash).toBe(previousEntryHash);
        previousEntryHash = entry.entryHash;
        commands.push({ command, expectedStateHash: entry.afterStateHash });
        state = reduceGameplay(state, command).state;
      }
      const replayed = replayGameplayTrace(initial, commands);
      expect(replayed.state).toEqual(state);
      expect(replayed.stateHash).toBe(gameplayStateHash(state));
    }
  });

  it("preserves movement state and behavioral hashes across seeded cell decisions", () => {
    let seed = 0x6d6f7665;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const tiles = ["#", ".", ">", "<", "+", null] as const;
    const occupants = ["none", "player", "monster"] as const;
    const directions = [
      [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
    ] as const;
    for (let run = 0; run < 250; run++) {
      const tile = tiles[Math.floor(random() * tiles.length)]!;
      const beforeState: MovementState = {
        authority: { realmId: "property", floorInstanceId: "floor-1", depth: 1, floorEpoch: 1, rulesetVersion: 1 },
        x: 1 + Math.floor(random() * 78),
        y: 1 + Math.floor(random() * 22),
        phase: "playing",
        alive: true,
        immobilizedTurns: random() < 0.1 ? 1 + Math.floor(random() * 4) : 0,
        destination: {
          tile,
          occupant: occupants[Math.floor(random() * occupants.length)]!,
          trap: random() < 0.2,
          stairsDown: tile === ">" && random() < 0.8,
        },
      };
      const [dx, dy] = directions[Math.floor(random() * directions.length)]!;
      const command = { type: "move", dx, dy } as const;
      const transition = reduceMovement(beforeState, command);
      const entry: MovementShadowJournalEntry = createShadowJournalEntry({
        streamId: `movement_property_${run}`,
        cursor: 1,
        command,
        beforeState,
      });
      expect(validateShadowJournalEntry(JSON.parse(JSON.stringify(entry)) as unknown)).toEqual(entry);
      expect(entry.v).toBe(2);
      expect(entry.beforeStateHash).toBe(movementStateHash(beforeState));
      expect(entry.afterStateHash).toBe(movementStateHash(transition.state));
      expect(entry.eventHash).toBe(movementEventHash(transition));
    }
  });
});
