import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShadowJournalEntry } from "../src/shadow-journal.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import { OriginGameplayJournal } from "./origin-journal.js";

const directories: string[] = [];
const initial = (overrides: Partial<GameplayState> = {}): GameplayState => ({
  turns: 0, depth: 1, hunger: 800, maxHunger: 1000,
  hungerState: "normal", hp: 20, alive: true, ...overrides,
});

function journal(): { directory: string; value: OriginGameplayJournal } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-"));
  directories.push(directory);
  return { directory, value: new OriginGameplayJournal(directory) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("OriginGameplayJournal", () => {
  it("appends immutable ordered entries and resumes its cursor after restart", () => {
    const { directory, value } = journal();
    const one = value.appendTransition({ streamId: "player_1", command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(one.status).toBe("appended");
    expect(one.entry.cursor).toBe(1);

    const restarted = new OriginGameplayJournal(directory);
    const two = restarted.appendTransition({ streamId: "player_1", command: { type: "advance_turn", action: "other" }, beforeState: initial({ turns: 1, hunger: 798 }) });
    expect(two.entry.cursor).toBe(2);
    expect(restarted.readAfter("player_1", 0, 1)).toEqual([one.entry]);
    expect(restarted.readAfter("player_1", 1, 64)).toEqual([two.entry]);
    expect(fs.statSync(path.join(directory, "player_1.00000000.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("makes exact retry idempotent and rejects conflict, gap, traversal, and corrupt restart", () => {
    const { directory, value } = journal();
    const entry = createShadowJournalEntry({ streamId: "safe", cursor: 1, command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(value.append(entry).status).toBe("appended");
    expect(value.append(entry).status).toBe("duplicate");
    const conflict = { ...entry, entryHash: "0000000000000000" };
    expect(() => value.append(conflict)).toThrow(/entry_hash_mismatch/);
    const gap = createShadowJournalEntry({ streamId: "safe", cursor: 3, previousEntryHash: entry.entryHash, command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(() => value.append(gap)).toThrow("journal_cursor_gap");
    expect(() => value.readAfter("../escape", 0, 1)).toThrow("invalid_stream_id");
    fs.appendFileSync(path.join(directory, "safe.00000000.jsonl"), "not-json\n");
    expect(() => new OriginGameplayJournal(directory).readAfter("safe", 0, 64)).toThrow();
  });

  it("enforces bounded reads and records terminal transitions", () => {
    const { directory, value } = journal();
    const result = value.appendTransition({
      streamId: "terminal",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial({ hunger: 1, hungerState: "starving", hp: 3 }),
    });
    expect(result.entry.terminal).toBe(true);
    expect(() => new OriginGameplayJournal(directory).appendTransition({ streamId: "terminal", command: { type: "advance_turn", action: "wait" }, beforeState: initial({ turns: 1, alive: false }) })).toThrow("journal_terminal_stream");
    expect(() => value.readAfter("terminal", 0, 65)).toThrow("invalid limit");
    expect(() => value.readAfter("terminal", -1, 1)).toThrow("invalid cursor");
  });

  it("deduplicates a logical retry without allocating another cursor", () => {
    const { value } = journal();
    const secondTurn = () => value.appendTransition({
      streamId: "gap-proof", command: { type: "advance_turn", action: "wait" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    });
    expect(() => secondTurn()).not.toThrow();
    expect(secondTurn().status).toBe("duplicate");
    expect(value.readAfter("gap-proof", 0, 64)[0]?.cursor).toBe(1);
  });

  it("segments long streams so bounded catch-up reads only small adjacent files", () => {
    const { directory, value } = journal();
    let state = initial();
    for (let index = 0; index < 130; index++) {
      value.appendTransition({ streamId: "segmented", command: { type: "advance_turn", action: "other" }, beforeState: state });
      state = { ...state, turns: state.turns + 1, hunger: Math.max(0, state.hunger - 2) };
    }
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("segmented."))).toHaveLength(3);
    expect(value.readAfter("segmented", 60, 64).map((entry) => entry.cursor)).toEqual(Array.from({ length: 64 }, (_, index) => index + 61));
    expect(value.readAfter("segmented", 128, 64).map((entry) => entry.cursor)).toEqual([129, 130]);
    fs.rmSync(path.join(directory, "segmented.00000001.jsonl"));
    expect(() => value.readAfter("segmented", 64, 64)).toThrow("journal_missing_segment");
  });
});
