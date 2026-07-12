import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { reduceGameplay, type GameplayState } from "../../src/gameplay-reducer";
import {
  MAX_SHADOW_BATCH_BYTES,
  createShadowJournalEntry,
  shadowEntryHash,
  type ShadowJournalEntry,
  type ShadowRoute,
} from "../../src/shadow-journal";
import type { Env } from "../src/env";
import { floorObjectName } from "../src/protocol";

const SECRET = "local-shadow-ingest-test-key-2026-07-11";
const route: ShadowRoute = { realmId: "shadow-test", floorInstanceId: "primary", depth: 1, floorEpoch: 1 };
const initial = (overrides: Partial<GameplayState> = {}): GameplayState => ({
  turns: 0, depth: 1, hunger: 800, maxHunger: 1000,
  hungerState: "normal", hp: 20, alive: true, ...overrides,
});

function trace(streamId: string, count: number, start = initial()): ShadowJournalEntry[] {
  const entries: ShadowJournalEntry[] = [];
  let state = start;
  let previousEntryHash: string | null = null;
  for (let cursor = 1; cursor <= count; cursor++) {
    const command = { type: "advance_turn", action: cursor % 2 ? "wait" : "other" } as const;
    const entry = createShadowJournalEntry({ streamId, cursor, command, beforeState: state, previousEntryHash });
    entries.push(entry);
    state = reduceGameplay(state, command).state;
    previousEntryHash = entry.entryHash;
  }
  return entries;
}

async function ingest(entries: readonly ShadowJournalEntry[], options: { secret?: string; batchRoute?: ShadowRoute; extra?: Record<string, unknown> } = {}): Promise<Response> {
  return SELF.fetch("https://edge.test/internal/shadow/catch-up", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.secret ?? SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, route: options.batchRoute ?? route, entries, ...options.extra }),
  });
}

function stubFor(streamId: string) {
  const runtimeEnv = env as Env;
  const name = `shadow:v1:${floorObjectName(route)}:s${streamId}`;
  return runtimeEnv.SHADOW_REPLAYS.get(runtimeEnv.SHADOW_REPLAYS.idFromName(name));
}

describe("ShadowReplay catch-up", () => {
  it("catches up a representative multi-page trace with exact parity across eviction", async () => {
    const entries = trace("parity", 70);
    const first = await ingest(entries.slice(0, 64));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ checkpoint: 64, accepted: 64, duplicates: 0 });
    await evictDurableObject(stubFor("parity"));
    const second = await ingest(entries.slice(60));
    const result = await second.json() as Record<string, unknown>;
    expect(result).toMatchObject({ checkpoint: 70, accepted: 6, duplicates: 4, stateHash: entries[69]!.afterStateHash });
  });

  it("handles exact duplicate retry and rejects conflict, reorder, and gap without advancing", async () => {
    const entries = trace("ordering", 3);
    await expect((await ingest([entries[0]!])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
    await expect((await ingest([entries[0]!])).json()).resolves.toMatchObject({ checkpoint: 1, duplicates: 1 });
    const conflictUnsigned = { ...entries[0]!, afterStateHash: "0000000000000000" };
    const conflict = { ...conflictUnsigned, entryHash: shadowEntryHash(conflictUnsigned) };
    const conflictResponse = await ingest([conflict]);
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({ code: "idempotency_conflict", checkpoint: 1 });
    const gap = await ingest([entries[2]!]);
    expect(gap.status).toBe(409);
    await expect(gap.json()).resolves.toMatchObject({ code: "cursor_gap", checkpoint: 1, expectedCursor: 2 });

    const reordered = trace("reordered", 2);
    const reorderResponse = await ingest([reordered[1]!, reordered[0]!]);
    expect(reorderResponse.status).toBe(409);
    await expect(reorderResponse.json()).resolves.toMatchObject({ code: "cursor_gap", checkpoint: 0 });
  });

  it("records deliberate divergence, preserves checkpoint, and accepts corrected retry", async () => {
    const [correct] = trace("divergence", 1);
    const divergentUnsigned = { ...correct!, afterStateHash: "0000000000000000" };
    const divergent = { ...divergentUnsigned, entryHash: shadowEntryHash(divergentUnsigned) };
    const response = await ingest([divergent]);
    expect(response.status).toBe(422);
    const evidence = await response.json() as Record<string, unknown>;
    expect(evidence).toMatchObject({ code: "state_hash_divergence", cursor: 1, checkpoint: 0, expectedHash: "0000000000000000" });
    expect(evidence.actualHash).toBe(correct!.afterStateHash);
    await expect(runInDurableObject(stubFor("divergence"), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM shadow_divergences").toArray()[0]?.count,
    )).resolves.toBe(1);
    await expect((await ingest([correct!])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
  });

  it("fails closed on corrupt envelopes, chain breaks, terminal mismatch, and unknown versions", async () => {
    const entries = trace("corruption", 2);
    const badBefore = { ...entries[0]!, beforeStateHash: "0000000000000000" };
    const badBeforeResponse = await ingest([{ ...badBefore, entryHash: shadowEntryHash(badBefore) }]);
    expect(badBeforeResponse.status).toBe(400);
    const unknown = await SELF.fetch("https://edge.test/internal/shadow/catch-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 2, route, entries: [entries[0]] }),
    });
    expect(unknown.status).toBe(400);
    await expect((await ingest([entries[0]!])).json()).resolves.toMatchObject({ checkpoint: 1 });
    const brokenUnsigned = { ...entries[1]!, previousEntryHash: "0000000000000000" };
    const broken = { ...brokenUnsigned, entryHash: shadowEntryHash(brokenUnsigned) };
    await expect((await ingest([broken])).json()).resolves.toMatchObject({ code: "hash_chain_mismatch", checkpoint: 1 });

    const [ordinary] = trace("terminal-mismatch", 1);
    const mismatchUnsigned = { ...ordinary!, terminal: true };
    const mismatch = { ...mismatchUnsigned, entryHash: shadowEntryHash(mismatchUnsigned) };
    const mismatchResponse = await ingest([mismatch]);
    expect(mismatchResponse.status).toBe(422);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ code: "terminal_mismatch", checkpoint: 0 });
  });

  it("commits terminal once and rejects post-terminal commands without cursor advance", async () => {
    const terminal = trace("terminal", 1, initial({ hunger: 1, hungerState: "starving", hp: 3 }))[0]!;
    expect(terminal.terminal).toBe(true);
    await expect((await ingest([terminal])).json()).resolves.toMatchObject({ checkpoint: 1, terminal: true });
    await expect((await ingest([terminal])).json()).resolves.toMatchObject({ checkpoint: 1, duplicates: 1, terminal: true });
    const later = createShadowJournalEntry({
      streamId: "terminal", cursor: 2, previousEntryHash: terminal.entryHash,
      command: { type: "advance_turn", action: "wait" },
      beforeState: reduceGameplay(terminal.beforeState, terminal.command).state,
    });
    const response = await ingest([later]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "terminal_state", checkpoint: 1 });
  });

  it("enforces authentication, route validation, entry count, and byte backpressure", async () => {
    const one = trace("limits", 1);
    expect((await ingest(one, { secret: "wrong-secret-that-is-still-long-enough" })).status).toBe(401);
    expect((await ingest(one, { batchRoute: { ...route, realmId: "../escape" } })).status).toBe(400);
    const sixtyFive = Array.from({ length: 65 }, () => one[0]!);
    expect((await ingest(sixtyFive)).status).toBe(429);
    const oversized = await SELF.fetch("https://edge.test/internal/shadow/catch-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, route, entries: one, padding: "x".repeat(256 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    const boundaryEntry = trace("byte-boundary", 1);
    const withoutPadding = JSON.stringify({ v: 1, route, entries: boundaryEntry, padding: "" });
    const boundaryBody = JSON.stringify({
      v: 1, route, entries: boundaryEntry,
      padding: "x".repeat(MAX_SHADOW_BATCH_BYTES - new TextEncoder().encode(withoutPadding).byteLength),
    });
    expect(new TextEncoder().encode(boundaryBody).byteLength).toBe(MAX_SHADOW_BATCH_BYTES);
    const boundary = await SELF.fetch("https://edge.test/internal/shadow/catch-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: boundaryBody,
    });
    expect(boundary.status).toBe(200);
  });

  it("expands an adjacent legacy checkpoint schema after eviction without losing its watermark", async () => {
    const streamId = "migration";
    const stub = stubFor(streamId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE shadow_checkpoint");
      state.storage.sql.exec("CREATE TABLE shadow_checkpoint (stream_id TEXT PRIMARY KEY, checkpoint INTEGER NOT NULL) WITHOUT ROWID");
      state.storage.sql.exec("INSERT INTO shadow_checkpoint (stream_id, checkpoint) VALUES (?, 0)", streamId);
    });
    await evictDurableObject(stub);
    await expect((await ingest(trace(streamId, 1))).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
  });

  it("keeps checkpoint monotonic across seeded chunking and duplicate delivery", async () => {
    let seed = 0x5eed;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const entries = trace("property", 40);
    let cursor = 0;
    while (cursor < entries.length) {
      const width = 1 + Math.floor(random() * 7);
      const start = Math.max(0, cursor - (random() < 0.5 ? Math.floor(random() * Math.min(3, cursor + 1)) : 0));
      const response = await ingest(entries.slice(start, Math.min(entries.length, cursor + width)));
      const body = await response.json() as { checkpoint: number };
      expect(body.checkpoint).toBeGreaterThanOrEqual(cursor);
      cursor = body.checkpoint;
    }
    expect(cursor).toBe(40);
  });
});
