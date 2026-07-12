import { describe, expect, it } from "vitest";

import { gameplayStateHash, reduceGameplay, replayGameplayTrace, type GameplayState } from "./gameplay-reducer.js";
import { createShadowJournalEntry, validateShadowJournalEntry } from "./shadow-journal.js";

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
        const entry = createShadowJournalEntry({ streamId: `property_${run}`, cursor, command, beforeState: state, previousEntryHash });
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
});
