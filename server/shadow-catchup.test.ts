import { describe, expect, it } from "vitest";

import { createShadowJournalEntry, type ShadowJournalEntry } from "../src/shadow-journal.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import { catchUpOriginJournal } from "./shadow-catchup.js";

const state: GameplayState = { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 20, alive: true };
const entry = createShadowJournalEntry({ streamId: "copy", cursor: 1, command: { type: "advance_turn", action: "wait" }, beforeState: state });
const route = { realmId: "copy-test", floorInstanceId: "primary", depth: 1, floorEpoch: 1 };
const secret = "shadow-copy-test-secret-at-least-32-bytes";

function source(entries: readonly ShadowJournalEntry[]) {
  return { readAfter: (_streamId: string, cursor: number, limit: number) => entries.filter((value) => value.cursor > cursor).slice(0, limit) };
}

describe("catchUpOriginJournal", () => {
  it("advances from the edge checkpoint and becomes caught up", async () => {
    const result = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test/internal/shadow/catch-up", secret,
      fetchImpl: async () => Response.json({ streamId: "copy", checkpoint: 1, accepted: 1, duplicates: 0, terminal: false, stateHash: entry.afterStateHash }),
    });
    expect(result).toMatchObject({ checkpoint: 1, accepted: 1, caughtUp: true, backpressured: false });
  });

  it("does not advance its caller checkpoint on response loss and retries the same entry", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts++;
      if (attempts === 1) throw new Error("response lost");
      return Response.json({ streamId: "copy", checkpoint: 1, accepted: 0, duplicates: 1, terminal: false, stateHash: entry.afterStateHash });
    };
    await expect(catchUpOriginJournal({ journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret, fetchImpl })).rejects.toThrow("response lost");
    const retried = await catchUpOriginJournal({ journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret, fetchImpl });
    expect(retried).toMatchObject({ checkpoint: 1, accepted: 0, duplicates: 1 });
  });

  it("returns explicit backpressure and preserves the supplied checkpoint", async () => {
    const result = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ code: "shadow_backpressure" }, { status: 429 }),
    });
    expect(result).toMatchObject({ checkpoint: 0, caughtUp: false, backpressured: true });
  });

  it("fails closed on edge gap and impossible checkpoint responses", async () => {
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ code: "cursor_gap", checkpoint: 0 }, { status: 409 }),
    })).rejects.toMatchObject({ code: "cursor_gap", checkpoint: 0 });
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ streamId: "copy", checkpoint: 2, accepted: 1, duplicates: 0, terminal: false, stateHash: entry.afterStateHash }),
    })).rejects.toThrow("invalid shadow checkpoint advance");
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({
        streamId: "copy",
        checkpoint: 1,
        accepted: 1,
        duplicates: 0,
        terminal: false,
        stateHash: entry.afterStateHash,
        entryVersion: 1,
        stateDomain: "movement",
      }),
    })).rejects.toThrow("invalid shadow response");
  });

  it("bounds entries and batches per invocation", async () => {
    await expect(catchUpOriginJournal({ journal: source([]), streamId: "copy", route, endpoint: "x", secret, maxEntriesPerBatch: 65 })).rejects.toThrow("invalid batch limit");
    await expect(catchUpOriginJournal({ journal: source([]), streamId: "copy", route, endpoint: "x", secret, maxBatches: 101 })).rejects.toThrow("invalid batch count");
    const timed = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "x", secret,
      maxDurationMs: 1, now: (() => { let value = 0; return () => value++; })(),
    });
    expect(timed).toMatchObject({ checkpoint: 0, caughtUp: false, backpressured: true, batches: 0 });
  });
});
