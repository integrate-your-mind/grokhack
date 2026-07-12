import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { reduceGameplay, type GameplayState } from "../../src/gameplay-reducer";
import { reduceMovement, type MovementState } from "../../src/movement-reducer";
import {
  MAX_SHADOW_BATCH_BYTES,
  createShadowJournalEntry,
  shadowEntryHash,
  type GameplayShadowJournalEntry,
  type MovementShadowJournalEntry,
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
const movementState = (overrides: Partial<MovementState> = {}): MovementState => ({
  authority: { ...route, rulesetVersion: 1 },
  x: 12,
  y: 8,
  phase: "playing",
  alive: true,
  immobilizedTurns: 0,
  destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  ...overrides,
});

function trace(streamId: string, count: number, start = initial()): GameplayShadowJournalEntry[] {
  const entries: GameplayShadowJournalEntry[] = [];
  let state = start;
  let previousEntryHash: string | null = null;
  for (let cursor = 1; cursor <= count; cursor++) {
    const command = { type: "advance_turn", action: cursor % 2 ? "wait" : "other" } as const;
    const entry: GameplayShadowJournalEntry = createShadowJournalEntry({ streamId, cursor, command, beforeState: state, previousEntryHash });
    entries.push(entry);
    state = reduceGameplay(state, command).state;
    previousEntryHash = entry.entryHash;
  }
  return entries;
}

function movementTrace(streamId: string, count: number): MovementShadowJournalEntry[] {
  const entries: MovementShadowJournalEntry[] = [];
  let beforeState = movementState();
  let previousEntryHash: string | null = null;
  const destinations = [
    { tile: ".", occupant: "none", trap: false, stairsDown: false },
    { tile: "#", occupant: "none", trap: false, stairsDown: false },
    { tile: ".", occupant: "player", trap: false, stairsDown: false },
    { tile: ".", occupant: "monster", trap: false, stairsDown: false },
    { tile: ">", occupant: "none", trap: true, stairsDown: true },
  ] as const;
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  for (let cursor = 1; cursor <= count; cursor++) {
    beforeState = { ...beforeState, destination: { ...destinations[(cursor - 1) % destinations.length]! } };
    const [dx, dy] = directions[(cursor - 1) % directions.length]!;
    const command = { type: "move", dx, dy } as const;
    const entry: MovementShadowJournalEntry = createShadowJournalEntry({
      streamId,
      cursor,
      command,
      beforeState,
      previousEntryHash,
    });
    entries.push(entry);
    beforeState = reduceMovement(beforeState, command).state;
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

  it("replays a mixed V1/vitals and V2/movement chain across eviction", async () => {
    const [vitals] = trace("mixed-version", 1);
    const movement = createShadowJournalEntry({
      streamId: "mixed-version",
      cursor: 2,
      previousEntryHash: vitals!.entryHash,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    await expect((await ingest([vitals!])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
    await evictDurableObject(stubFor("mixed-version"));
    const response = await ingest([vitals!, movement]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 1,
      duplicates: 1,
      stateHash: movement.afterStateHash,
      entryVersion: 2,
      stateDomain: "movement",
    });
    await expect(runInDurableObject(stubFor("mixed-version"), (_instance, state) =>
      state.storage.sql.exec<{ entry_version: number; event_hash: string | null }>(
        "SELECT entry_version, event_hash FROM shadow_entries WHERE stream_id = ? AND cursor = 2",
        "mixed-version",
      ).toArray()[0],
    )).resolves.toEqual({ entry_version: 2, event_hash: movement.eventHash });
  });

  it("records movement event divergence without advancing the checkpoint", async () => {
    const correct = createShadowJournalEntry({
      streamId: "movement-event-divergence",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ destination: { tile: ".", occupant: "player", trap: false, stairsDown: false } }),
    });
    const divergentUnsigned = { ...correct, eventHash: "0000000000000000" };
    const divergent = { ...divergentUnsigned, entryHash: shadowEntryHash(divergentUnsigned) };
    const response = await ingest([divergent]);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "event_hash_divergence",
      checkpoint: 0,
      cursor: 1,
      expectedHash: "0000000000000000",
      actualHash: correct.eventHash,
    });
    await evictDurableObject(stubFor("movement-event-divergence"));
    await expect((await ingest([correct])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
  });

  it("fences a movement trace to its declared floor authority", async () => {
    const movement = createShadowJournalEntry({
      streamId: "movement-route-fence",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    const response = await ingest([movement], {
      batchRoute: { ...route, floorInstanceId: "other-floor" },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "movement_authority_mismatch", checkpoint: 0 });
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

  it("expands legacy entry storage before accepting a V2 movement record", async () => {
    const streamId = "entry-migration";
    const stub = stubFor(streamId);
    const legacy = trace(streamId, 1)[0]!;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE shadow_entries");
      state.storage.sql.exec(`CREATE TABLE shadow_entries (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        before_state_hash TEXT NOT NULL,
        after_state_hash TEXT NOT NULL,
        terminal INTEGER NOT NULL,
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor)
      ) WITHOUT ROWID`);
      state.storage.sql.exec(
        "INSERT INTO shadow_entries (stream_id, cursor, entry_hash, before_state_hash, after_state_hash, terminal, ingested_at) VALUES (?, 1, ?, ?, ?, 0, unixepoch())",
        streamId, legacy.entryHash, legacy.beforeStateHash, legacy.afterStateHash,
      );
      state.storage.sql.exec(`INSERT INTO shadow_checkpoint
        (stream_id, checkpoint, last_entry_hash, state_hash, terminal, entry_version, state_domain, updated_at)
        VALUES (?, 1, ?, ?, 0, 1, 'vitals', unixepoch())
        ON CONFLICT(stream_id) DO UPDATE SET checkpoint = 1, last_entry_hash = excluded.last_entry_hash,
          state_hash = excluded.state_hash, terminal = 0, entry_version = 1,
          state_domain = 'vitals', updated_at = excluded.updated_at`,
        streamId, legacy.entryHash, legacy.afterStateHash,
      );
    });
    await evictDurableObject(stub);
    await expect((await ingest([legacy])).json()).resolves.toMatchObject({
      checkpoint: 1,
      accepted: 0,
      duplicates: 1,
      entryVersion: 1,
      stateDomain: "vitals",
    });
    const movement = createShadowJournalEntry({
      streamId,
      cursor: 2,
      previousEntryHash: legacy.entryHash,
      command: { type: "move", dx: 0, dy: -1 },
      beforeState: movementState(),
    });
    await expect((await ingest([movement])).json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 1,
      entryVersion: 2,
      stateDomain: "movement",
    });
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ name: string }>("PRAGMA table_info(shadow_entries)").toArray().map((row) => row.name),
    )).resolves.toEqual(expect.arrayContaining(["entry_version", "event_hash"]));
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ cursor: number }>(
        "SELECT cursor FROM shadow_entries WHERE stream_id = ? ORDER BY cursor",
        streamId,
      ).toArray().map((row) => row.cursor),
    )).resolves.toEqual([1, 2]);
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _shadow_schema_migrations ORDER BY version",
      ).toArray().map((row) => row.version),
    )).resolves.toEqual([1, 2, 3]);
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

  it("keeps mixed movement checkpoints monotonic across seeded duplicate chunking", async () => {
    let seed = 0x6d6f7665;
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const entries = movementTrace("movement-property", 40);
    let cursor = 0;
    while (cursor < entries.length) {
      const width = 1 + Math.floor(random() * 6);
      const duplicatePrefix = random() < 0.6 ? Math.floor(random() * Math.min(4, cursor + 1)) : 0;
      const response = await ingest(entries.slice(Math.max(0, cursor - duplicatePrefix), Math.min(entries.length, cursor + width)));
      const body = await response.json() as { checkpoint: number };
      expect(body.checkpoint).toBeGreaterThanOrEqual(cursor);
      cursor = body.checkpoint;
    }
    expect(cursor).toBe(40);
  });
});
