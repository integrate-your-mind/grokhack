import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { reduceGameplay, type GameplayState } from "../../src/gameplay-reducer";
import { reduceMovement, type MovementState } from "../../src/movement-reducer";
import { catchUpCombatTurnJournal, catchUpMovementTurnJournal } from "../../server/shadow-catchup";
import {
  MAX_SHADOW_BATCH_BYTES,
  createMovementTurnEnvelope,
  createShadowJournalEntry,
  shadowEntryHash,
  type GameplayShadowJournalEntry,
  type MovementTurnEnvelope,
  type MovementShadowJournalEntry,
  type ShadowJournalEntry,
  type ShadowRoute,
} from "../../src/shadow-journal";
import { createCombatTurnEnvelopeV1, type CombatTurnEnvelopeV1 } from "../../src/combat-turn-envelope";
import type { Env } from "../src/env";
import { readEdgeConfig } from "../src/config";
import { routeShadowCatchup } from "../src/index";
import { floorObjectName } from "../src/protocol";

const SECRET = "local-shadow-ingest-test-key-2026-07-11";
const route: ShadowRoute = { realmId: "shadow-test", floorInstanceId: "primary", depth: 1, floorEpoch: 1, rulesetVersion: 1 };
const initial = (overrides: Partial<GameplayState> = {}): GameplayState => ({
  turns: 0, depth: 1, hunger: 800, maxHunger: 1000,
  hungerState: "normal", hp: 20, alive: true, ...overrides,
});
const movementState = (overrides: Partial<MovementState> = {}): MovementState => ({
  authority: { ...route },
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
      route,
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

function movementTurnTrace(streamId: string, count: number): MovementTurnEnvelope[] {
  const envelopes: MovementTurnEnvelope[] = [];
  let movement = movementState();
  // Long receipt-window traces exercise compaction, not terminal handling.
  // Keep the fixture alive after hunger damage begins so cursor 300 is real.
  let gameplay = initial({ hp: 1_000 });
  let previousEnvelopeHash: string | null = null;
  let previousMovementEntryHash: string | null = null;
  let previousTurnEntryHash: string | null = null;
  for (let cursor = 1; cursor <= count; cursor++) {
    const command = { type: "move", dx: 1, dy: 0 } as const;
    const turnCommand = { type: "advance_turn", action: "other" } as const;
    const envelope = createMovementTurnEnvelope({
      streamId,
      cursor,
      operationId: `00000000-0000-4000-8000-${cursor.toString(16).padStart(12, "0")}`,
      command,
      beforeState: movement,
      turn: { command: turnCommand, beforeState: gameplay },
      previousEnvelopeHash,
      previousMovementEntryHash,
      previousTurnEntryHash,
    });
    envelopes.push(envelope);
    movement = reduceMovement(movement, command).state;
    gameplay = reduceGameplay(gameplay, turnCommand).state;
    previousEnvelopeHash = envelope.envelopeHash;
    previousMovementEntryHash = envelope.movement.entryHash;
    previousTurnEntryHash = envelope.turn!.entryHash;
  }
  return envelopes;
}

function combatTurnTrace(streamId: string, count: number): CombatTurnEnvelopeV1[] {
  const envelopes: CombatTurnEnvelopeV1[] = [];
  let gameplay = initial({ hp: 1_000 });
  let previousEnvelopeHash: string | null = null;
  let previousTurnEntryHash: string | null = null;
  for (let cursor = 1; cursor <= count; cursor++) {
    const envelope = createCombatTurnEnvelopeV1({
      streamId,
      route,
      cursor,
      operationId: `00000000-0000-4000-8000-${cursor.toString(16).padStart(12, "0")}`,
      attacker: { id: "player", name: "Romy", hp: 20, maxHp: 20, attack: 8, defense: 2, isPlayer: true, traits: [], enraged: false },
      defender: { id: `rat-${cursor}`, name: "giant rat", hp: 8, maxHp: 8, attack: 2, defense: 1, isPlayer: false, traits: [], enraged: false },
      options: { weaponName: "short sword", hitPenalty: 0, critChance: 0 },
      transcript: { hit: 0, crit: 0.9, variance: 0.5, severityFlavor: 0, killFlavor: 0 },
      turn: { command: { type: "advance_turn", action: "other" }, beforeState: gameplay },
      previousEnvelopeHash,
      previousTurnEntryHash,
    });
    envelopes.push(envelope);
    gameplay = reduceGameplay(gameplay, envelope.turn.command).state;
    previousEnvelopeHash = envelope.envelopeHash;
    previousTurnEntryHash = envelope.turn.entryHash;
  }
  return envelopes;
}

async function ingest(entries: readonly ShadowJournalEntry[], options: { secret?: string; batchRoute?: ShadowRoute; extra?: Record<string, unknown> } = {}): Promise<Response> {
  return SELF.fetch("https://edge.test/internal/shadow/catch-up", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.secret ?? SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, route: options.batchRoute ?? route, entries, ...options.extra }),
  });
}

async function ingestMovementTurns(
  envelopes: readonly MovementTurnEnvelope[],
  options: { secret?: string; batchRoute?: ShadowRoute; extra?: Record<string, unknown> } = {},
): Promise<Response> {
  return SELF.fetch("https://edge.test/internal/shadow/catch-up", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.secret ?? SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, route: options.batchRoute ?? route, envelopes, ...options.extra }),
  });
}

async function ingestCombatTurns(
  combatEnvelopes: readonly CombatTurnEnvelopeV1[],
  options: { secret?: string; batchRoute?: ShadowRoute; extra?: Record<string, unknown> } = {},
): Promise<Response> {
  return SELF.fetch("https://edge.test/internal/shadow/catch-up", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.secret ?? SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, route: options.batchRoute ?? route, combatEnvelopes, ...options.extra }),
  });
}

function stubFor(streamId: string) {
  const runtimeEnv = env as Env;
  const name = `shadow:v1:${floorObjectName(route)}:r${route.rulesetVersion}:s${streamId}`;
  return runtimeEnv.SHADOW_REPLAYS.get(runtimeEnv.SHADOW_REPLAYS.idFromName(name));
}

describe("ShadowReplay catch-up", () => {
  it("replays combat turns without making monster death terminal and deduplicates after eviction", async () => {
    const streamId = `combat_${"2".repeat(48)}`;
    const envelopes = combatTurnTrace(streamId, 2);
    const first = await ingestCombatTurns([envelopes[0]!]);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      streamId, checkpoint: 1, accepted: 1, duplicates: 0, terminal: false,
      lastEnvelopeHash: envelopes[0]!.envelopeHash,
      combatStateHash: envelopes[0]!.afterStateHash,
      turnStateHash: envelopes[0]!.turn.afterStateHash,
    });
    await evictDurableObject(stubFor(streamId));
    const retried = await ingestCombatTurns(envelopes);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ checkpoint: 2, accepted: 1, duplicates: 1, terminal: false });
  });

  it("rejects a combat envelope replayed through a different floor authority", async () => {
    const streamId = `combat_${"3".repeat(48)}`;
    const [envelope] = combatTurnTrace(streamId, 1);
    const mismatched = createCombatTurnEnvelopeV1({
      streamId,
      route: { ...route, floorEpoch: route.floorEpoch + 1 },
      cursor: envelope!.cursor,
      operationId: envelope!.operationId,
      attacker: envelope!.attacker,
      defender: envelope!.defender,
      options: envelope!.options,
      transcript: envelope!.transcript,
      turn: { command: envelope!.turn.command, beforeState: envelope!.turn.beforeState },
      previousEnvelopeHash: envelope!.previousEnvelopeHash,
      previousTurnEntryHash: envelope!.turn.previousEntryHash,
    });
    const response = await ingestCombatTurns([mismatched]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "combat_authority_mismatch", checkpoint: 0 });
  });

  it("retains a bounded combat receipt window and returns the durable head after eviction", async () => {
    const streamId = `combat_${"4".repeat(48)}`;
    const envelopes = combatTurnTrace(streamId, 300);
    for (let offset = 0; offset < envelopes.length; offset += 64) {
      const response = await ingestCombatTurns(envelopes.slice(offset, offset + 64));
      expect(response.status, `offset ${offset}: ${await response.clone().text()}`).toBe(200);
    }
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ count: number; minimum: number; maximum: number }>(
        `SELECT COUNT(*) AS count, MIN(cursor) AS minimum, MAX(cursor) AS maximum
         FROM combat_turn_receipts WHERE stream_id = ?`, streamId,
      ).one(),
    )).resolves.toEqual({ count: 256, minimum: 45, maximum: 300 });
    const compacted = await ingestCombatTurns([envelopes[0]!]);
    expect(compacted.status).toBe(409);
    await expect(compacted.json()).resolves.toMatchObject({
      code: "cursor_compacted", streamId, checkpoint: 300, cursor: 1,
      accepted: 0, duplicates: 0, terminal: false,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      combatStateHash: envelopes.at(-1)!.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn.afterStateHash,
    });
    await evictDurableObject(stubFor(streamId));
    const afterEviction = await ingestCombatTurns([envelopes[0]!]);
    expect(afterEviction.status).toBe(409);
    await expect(afterEviction.json()).resolves.toMatchObject({
      code: "cursor_compacted", streamId, checkpoint: 300,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      combatStateHash: envelopes.at(-1)!.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn.afterStateHash,
    });
    await expect((await ingestCombatTurns([envelopes.at(-1)!])).json()).resolves.toMatchObject({ checkpoint: 300, accepted: 0, duplicates: 1 });
  });

  it("atomically replays movement-turn envelopes and deduplicates an exact retry across eviction", async () => {
    const streamId = `turn_${"1".repeat(48)}`;
    const envelopes = movementTurnTrace(streamId, 2);
    const first = await ingestMovementTurns([envelopes[0]!]);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      streamId,
      checkpoint: 1,
      accepted: 1,
      duplicates: 0,
      terminal: false,
      lastEnvelopeHash: envelopes[0]!.envelopeHash,
      movementStateHash: envelopes[0]!.movement.afterStateHash,
      turnStateHash: envelopes[0]!.turn!.afterStateHash,
    });

    await evictDurableObject(stubFor(streamId));
    const retried = await ingestMovementTurns(envelopes);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 1,
      duplicates: 1,
      movementStateHash: envelopes[1]!.movement.afterStateHash,
      turnStateHash: envelopes[1]!.turn!.afterStateHash,
    });
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) => ({
      receipts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM movement_turn_receipts WHERE stream_id = ?",
        streamId,
      ).one().count,
      checkpoint: state.storage.sql.exec<{ checkpoint: number }>(
        "SELECT checkpoint FROM movement_turn_checkpoint WHERE stream_id = ?",
        streamId,
      ).one().checkpoint,
    }))).resolves.toEqual({ receipts: 2, checkpoint: 2 });
  });

  it("preflights a complete envelope batch so a late chain failure commits no partial pair", async () => {
    const streamId = `turn_${"2".repeat(48)}`;
    const correct = movementTurnTrace(streamId, 2);
    const badSecond = createMovementTurnEnvelope({
      streamId,
      cursor: 2,
      operationId: "00000000-0000-4000-8000-000000000099",
      command: correct[1]!.movement.command,
      beforeState: correct[1]!.movement.beforeState,
      turn: {
        command: correct[1]!.turn!.command,
        beforeState: correct[1]!.turn!.beforeState,
      },
      previousEnvelopeHash: "0000000000000000",
      previousMovementEntryHash: correct[0]!.movement.entryHash,
      previousTurnEntryHash: correct[0]!.turn!.entryHash,
    });
    const rejected = await ingestMovementTurns([correct[0]!, badSecond]);
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "envelope_hash_chain_mismatch",
      checkpoint: 0,
      cursor: 2,
    });
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) => ({
      receipts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM movement_turn_receipts WHERE stream_id = ?",
        streamId,
      ).one().count,
      checkpoints: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM movement_turn_checkpoint WHERE stream_id = ?",
        streamId,
      ).one().count,
    }))).resolves.toEqual({ receipts: 0, checkpoints: 0 });
    const gap = await ingestMovementTurns([correct[1]!]);
    expect(gap.status).toBe(409);
    await expect(gap.json()).resolves.toMatchObject({ code: "cursor_gap", checkpoint: 0, expectedCursor: 1 });
    const reordered = await ingestMovementTurns([correct[1]!, correct[0]!]);
    expect(reordered.status).toBe(409);
    await expect(reordered.json()).resolves.toMatchObject({ code: "batch_out_of_order", checkpoint: 0 });
    await expect((await ingestMovementTurns(correct)).json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 2,
      duplicates: 0,
    });
  });

  it("rolls back receipts and checkpoint together when the edge SQL commit fails", async () => {
    const streamId = `turn_${"3".repeat(48)}`;
    const [envelope] = movementTurnTrace(streamId, 1);
    const stub = stubFor(streamId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER fail_movement_turn_checkpoint
        BEFORE INSERT ON movement_turn_checkpoint
        BEGIN SELECT RAISE(ABORT, 'injected movement-turn checkpoint failure'); END`);
    });
    const failed = await ingestMovementTurns([envelope!]);
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({ code: "shadow_replay_unavailable" });
    await expect(runInDurableObject(stub, (_instance, state) => ({
      receipts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM movement_turn_receipts WHERE stream_id = ?",
        streamId,
      ).one().count,
      checkpoints: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM movement_turn_checkpoint WHERE stream_id = ?",
        streamId,
      ).one().count,
    }))).resolves.toEqual({ receipts: 0, checkpoints: 0 });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_movement_turn_checkpoint");
    });
    await expect((await ingestMovementTurns([envelope!])).json()).resolves.toMatchObject({
      checkpoint: 1,
      accepted: 1,
      duplicates: 0,
    });
  });

  it("carries the turn head through no-turn evidence and fences stale continuity and operation reuse", async () => {
    const streamId = `turn_${"4".repeat(48)}`;
    const [first] = movementTurnTrace(streamId, 1);
    const blockedState = movementState({
      x: 13,
      destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
    });
    const blocked = createMovementTurnEnvelope({
      streamId,
      cursor: 2,
      operationId: "00000000-0000-4000-8000-000000000102",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: blockedState,
      turn: null,
      previousEnvelopeHash: first!.envelopeHash,
      previousMovementEntryHash: first!.movement.entryHash,
      previousTurnEntryHash: first!.turn!.entryHash,
    });
    await expect((await ingestMovementTurns([first!, blocked])).json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 2,
      turnStateHash: first!.turn!.afterStateHash,
    });

    const stale = createMovementTurnEnvelope({
      streamId,
      cursor: 3,
      operationId: "00000000-0000-4000-8000-000000000103",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ x: 99 }),
      turn: { command: { type: "advance_turn", action: "other" }, beforeState: initial({ turns: 1, hunger: 798 }) },
      previousEnvelopeHash: blocked.envelopeHash,
      previousMovementEntryHash: blocked.movement.entryHash,
      previousTurnEntryHash: first!.turn!.entryHash,
    });
    const staleResponse = await ingestMovementTurns([stale]);
    expect(staleResponse.status).toBe(422);
    await expect(staleResponse.json()).resolves.toMatchObject({
      code: "movement_continuity_divergence",
      checkpoint: 2,
      cursor: 3,
    });
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ divergence_kind: string; entry_version: number; state_domain: string }>(
        "SELECT divergence_kind, entry_version, state_domain FROM shadow_divergences WHERE stream_id = ? AND cursor = 3",
        streamId,
      ).one(),
    )).resolves.toEqual({
      divergence_kind: "envelope_movement_continuity_before",
      entry_version: 1,
      state_domain: "movement",
    });

    const reused = createMovementTurnEnvelope({
      streamId,
      cursor: 3,
      operationId: first!.operationId,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ x: 13 }),
      turn: { command: { type: "advance_turn", action: "other" }, beforeState: initial({ turns: 1, hunger: 798 }) },
      previousEnvelopeHash: blocked.envelopeHash,
      previousMovementEntryHash: blocked.movement.entryHash,
      previousTurnEntryHash: first!.turn!.entryHash,
    });
    const reusedResponse = await ingestMovementTurns([reused]);
    expect(reusedResponse.status).toBe(409);
    await expect(reusedResponse.json()).resolves.toMatchObject({ code: "operation_reused", checkpoint: 2 });
    expect((await ingestMovementTurns([first!], { extra: { entries: [first!.movement] } })).status).toBe(400);
  });

  it("accepts an authenticated origin-only vitals effect between reducer turns", async () => {
    const streamId = `turn_${"8".repeat(48)}`;
    const correct = movementTurnTrace(streamId, 2);
    await expect((await ingestMovementTurns([correct[0]!])).json()).resolves.toMatchObject({
      checkpoint: 1,
      accepted: 1,
    });

    const reducerAfter = reduceGameplay(correct[0]!.turn!.beforeState, correct[0]!.turn!.command).state;
    const afterOriginOnlyPoison = { ...reducerAfter, hp: reducerAfter.hp - 1 };
    const nextTurn = createMovementTurnEnvelope({
      streamId,
      cursor: 2,
      operationId: "00000000-0000-4000-8000-000000000802",
      command: correct[1]!.movement.command,
      beforeState: correct[1]!.movement.beforeState,
      turn: { command: correct[1]!.turn!.command, beforeState: afterOriginOnlyPoison },
      previousEnvelopeHash: correct[0]!.envelopeHash,
      previousMovementEntryHash: correct[0]!.movement.entryHash,
      previousTurnEntryHash: correct[0]!.turn!.entryHash,
    });
    const response = await ingestMovementTurns([nextTurn]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      checkpoint: 2,
      accepted: 1,
      turnStateHash: nextTurn.turn!.afterStateHash,
    });
  });

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
    await expect(runInDurableObject(stubFor("movement-event-divergence"), (_instance, state) =>
      state.storage.sql.exec<{ divergence_kind: string; entry_version: number; state_domain: string }>(
        "SELECT divergence_kind, entry_version, state_domain FROM shadow_divergences",
      ).toArray()[0],
    )).resolves.toEqual({ divergence_kind: "event", entry_version: 2, state_domain: "movement" });
    await evictDurableObject(stubFor("movement-event-divergence"));
    await expect((await ingest([correct])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
  });

  it("fences carried state after no-turn decisions and permits origin-effect boundaries", async () => {
    const streamId = "movement-continuity";
    const first = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ destination: { tile: "#", occupant: "none", trap: false, stairsDown: false } }),
    });
    await expect((await ingest([first])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
    const jumped = createShadowJournalEntry({
      streamId,
      cursor: 2,
      previousEntryHash: first.entryHash,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ x: 40, destination: { tile: ".", occupant: "player", trap: false, stairsDown: false } }),
    });
    const rejected = await ingest([jumped]);
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "state_continuity_divergence",
      checkpoint: 1,
      cursor: 2,
    });
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ divergence_kind: string }>(
        "SELECT divergence_kind FROM shadow_divergences WHERE stream_id = ? AND cursor = 2",
        streamId,
      ).toArray()[0]?.divergence_kind,
    )).resolves.toBe("continuity_before");

    const effectStream = "movement-effect-boundary";
    const effectful = createShadowJournalEntry({
      streamId: effectStream,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    await expect((await ingest([effectful])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
    const afterOriginEffects = createShadowJournalEntry({
      streamId: effectStream,
      cursor: 2,
      previousEntryHash: effectful.entryHash,
      command: { type: "move", dx: 0, dy: 1 },
      beforeState: movementState({ x: 51, y: 19 }),
    });
    await expect((await ingest([afterOriginEffects])).json()).resolves.toMatchObject({ checkpoint: 2, accepted: 1 });

    const afterHash = createShadowJournalEntry({
      streamId: "movement-after-continuity",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    const tamperedUnsigned = { ...afterHash, afterContinuityHash: "0000000000000000" };
    const tampered = { ...tamperedUnsigned, entryHash: shadowEntryHash(tamperedUnsigned) };
    const tamperedResponse = await ingest([tampered]);
    expect(tamperedResponse.status).toBe(422);
    await expect(tamperedResponse.json()).resolves.toMatchObject({
      code: "continuity_hash_divergence",
      checkpoint: 0,
      cursor: 1,
    });
  });

  it("allows the one-way V1-to-V2 upgrade and rejects a movement stream downgrade", async () => {
    const streamId = "domain-downgrade";
    const movement = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    await expect((await ingest([movement])).json()).resolves.toMatchObject({
      checkpoint: 1,
      entryVersion: 2,
      stateDomain: "movement",
    });
    const vitals = createShadowJournalEntry({
      streamId,
      cursor: 2,
      previousEntryHash: movement.entryHash,
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const response = await ingest([vitals]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "state_domain_regression",
      checkpoint: 1,
      cursor: 2,
    });
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

    const futureRuleset = createShadowJournalEntry({
      streamId: "movement-ruleset-fence",
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ authority: { ...route, rulesetVersion: 2 } }),
    });
    const mismatched = await ingest([futureRuleset]);
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toMatchObject({ code: "movement_authority_mismatch", checkpoint: 0 });

    const unsupportedRoute = await SELF.fetch("https://edge.test/internal/shadow/catch-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, route: { ...route, rulesetVersion: 2 }, entries: [futureRuleset] }),
    });
    expect(unsupportedRoute.status).toBe(400);
    await expect(unsupportedRoute.json()).resolves.toMatchObject({ code: "invalid_route" });
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
    const leadingGap = await ingest([reordered[1]!]);
    expect(leadingGap.status).toBe(409);
    await expect(leadingGap.json()).resolves.toMatchObject({ code: "cursor_gap", checkpoint: 0 });
    const reorderResponse = await ingest([reordered[1]!, reordered[0]!]);
    expect(reorderResponse.status).toBe(409);
    await expect(reorderResponse.json()).resolves.toMatchObject({ code: "batch_out_of_order", checkpoint: 0 });

    const lateReordered = trace("late-reordered", 2);
    await expect((await ingest([lateReordered[0]!])).json()).resolves.toMatchObject({ checkpoint: 1 });
    const lateReorderResponse = await ingest([lateReordered[1]!, lateReordered[0]!]);
    expect(lateReorderResponse.status).toBe(409);
    await expect(lateReorderResponse.json()).resolves.toMatchObject({ code: "batch_out_of_order", checkpoint: 1 });
    await expect((await ingest([lateReordered[1]!])).json()).resolves.toMatchObject({ checkpoint: 2, accepted: 1 });
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
      state.storage.sql.exec<{ divergence_kind: string; entry_version: number; state_domain: string }>(
        "SELECT divergence_kind, entry_version, state_domain FROM shadow_divergences",
      ).toArray()[0],
    )).resolves.toEqual({ divergence_kind: "state", entry_version: 1, state_domain: "vitals" });
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
    await expect(runInDurableObject(stubFor("terminal-mismatch"), (_instance, state) =>
      state.storage.sql.exec<{ divergence_kind: string }>(
        "SELECT divergence_kind FROM shadow_divergences",
      ).toArray()[0]?.divergence_kind,
    )).resolves.toBe("terminal");
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
      state.storage.sql.exec("DELETE FROM _shadow_schema_migrations WHERE version > 1");
      state.storage.sql.exec("DROP TABLE shadow_checkpoint");
      state.storage.sql.exec(`CREATE TABLE shadow_checkpoint (
        stream_id TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL,
        last_entry_hash TEXT,
        state_hash TEXT,
        terminal INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID`);
      state.storage.sql.exec(
        "INSERT INTO shadow_checkpoint (stream_id, checkpoint, last_entry_hash, state_hash, terminal, updated_at) VALUES (?, 1, ?, ?, 0, unixepoch())",
        streamId, legacy.entryHash, legacy.afterStateHash,
      );
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
      state.storage.sql.exec("DROP TABLE shadow_divergences");
      state.storage.sql.exec(`CREATE TABLE shadow_divergences (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        actual_hash TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor, entry_hash)
      ) WITHOUT ROWID`);
      state.storage.sql.exec(
        "INSERT INTO shadow_divergences (stream_id, cursor, entry_hash, expected_hash, actual_hash, detected_at) VALUES (?, 1, 'legacy-evidence', 'expected', 'actual', unixepoch())",
        streamId,
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
    )).resolves.toEqual(expect.arrayContaining([
      "entry_version", "before_continuity_hash", "after_continuity_hash", "event_hash",
    ]));
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ cursor: number }>(
        "SELECT cursor FROM shadow_entries WHERE stream_id = ? ORDER BY cursor",
        streamId,
      ).toArray().map((row) => row.cursor),
    )).resolves.toEqual([1, 2]);
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ divergence_kind: string; entry_version: number | null; state_domain: string | null }>(
        "SELECT divergence_kind, entry_version, state_domain FROM shadow_divergences WHERE entry_hash = 'legacy-evidence'",
      ).toArray()[0],
    )).resolves.toEqual({ divergence_kind: "legacy_unknown", entry_version: null, state_domain: null });
    await expect(runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _shadow_schema_migrations ORDER BY version",
      ).toArray().map((row) => row.version),
    )).resolves.toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("fails closed instead of mutating a newer unknown replay schema", async () => {
    const streamId = "future-schema";
    const first = trace(streamId, 1)[0]!;
    await expect((await ingest([first])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });
    const stub = stubFor(streamId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO _shadow_schema_migrations (version, applied_at) VALUES (999, unixepoch())",
      );
    });
    await evictDurableObject(stub);

    const second = trace(streamId, 2)[1]!;
    const response = await ingest([second]);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "shadow_schema_incompatible" });
    await expect(runInDurableObject(stub, (_instance, state) => ({
      entryCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM shadow_entries WHERE stream_id = ?",
        streamId,
      ).one().count,
      versions: state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _shadow_schema_migrations ORDER BY version",
      ).toArray().map((row) => row.version),
    }))).resolves.toEqual({ entryCount: 1, versions: [1, 2, 3, 4, 5, 6, 7, 999] });
  });

  it("maps a retryable replay-object failure without leaking an uncaught exception", async () => {
    const runtimeEnv = env as Env;
    const configured = readEdgeConfig(runtimeEnv);
    if (!configured.ok) throw new Error(configured.errors.join(", "));
    const failingEnv = Object.create(runtimeEnv) as Env;
    Object.defineProperty(failingEnv, "SHADOW_REPLAYS", {
      value: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async () => {
            throw Object.assign(new Error("injected replay failure"), { retryable: true, remote: true });
          },
        }),
      },
    });
    const entries = trace("route-failure", 1);
    const response = await routeShadowCatchup(new Request("https://edge.test/internal/shadow/catch-up", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, route, entries }),
    }), failingEnv, configured.value);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      code: "shadow_replay_unavailable",
      retryable: true,
    });
  });

  it("binds a replay object to its first route and stream identity", async () => {
    const streamId = "identity-fence";
    const first = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    await expect((await ingest([first])).json()).resolves.toMatchObject({ checkpoint: 1, accepted: 1 });

    const otherRoute = { ...route, floorInstanceId: "secondary" };
    const foreign = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState({ authority: otherRoute }),
    });
    const response = await stubFor(streamId).fetch("https://shadow.internal/catch-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: otherRoute, entries: [foreign] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "shadow_identity_mismatch", checkpoint: 1 });
  });

  it("caps retained divergence evidence per stream", async () => {
    const streamId = "divergence-cap";
    const correct = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let index = 0; index < 70; index++) {
      const eventHash = index.toString(16).padStart(16, "0");
      const unsigned = { ...correct, eventHash };
      const divergent = { ...unsigned, entryHash: shadowEntryHash(unsigned) };
      expect((await ingest([divergent])).status).toBe(422);
    }
    expect(errorLog).toHaveBeenCalledTimes(64);
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM shadow_divergences WHERE stream_id = ?",
        streamId,
      ).one().count,
    )).resolves.toBe(64);
  });

  it("commits a terminal movement-turn pair once and rejects a post-terminal envelope", async () => {
    const streamId = `turn_${"5".repeat(48)}`;
    const terminal = createMovementTurnEnvelope({
      streamId,
      cursor: 1,
      operationId: "00000000-0000-4000-8000-000000000501",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState(),
      turn: {
        command: { type: "advance_turn", action: "other" },
        beforeState: initial({ hunger: 1, hungerState: "starving", hp: 3 }),
      },
    });
    expect(terminal.turn?.terminal).toBe(true);
    await expect((await ingestMovementTurns([terminal])).json()).resolves.toMatchObject({
      checkpoint: 1,
      accepted: 1,
      terminal: true,
    });
    await expect((await ingestMovementTurns([terminal])).json()).resolves.toMatchObject({
      checkpoint: 1,
      accepted: 0,
      duplicates: 1,
      terminal: true,
    });
    const later = createMovementTurnEnvelope({
      streamId,
      cursor: 2,
      operationId: "00000000-0000-4000-8000-000000000502",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: reduceMovement(terminal.movement.beforeState, terminal.movement.command).state,
      turn: {
        command: { type: "advance_turn", action: "other" },
        beforeState: reduceGameplay(terminal.turn!.beforeState, terminal.turn!.command).state,
      },
      previousEnvelopeHash: terminal.envelopeHash,
      previousMovementEntryHash: terminal.movement.entryHash,
      previousTurnEntryHash: terminal.turn!.entryHash,
    });
    const response = await ingestMovementTurns([later]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "terminal_state", checkpoint: 1 });
  });

  it("retains a bounded movement-turn receipt window and rejects compacted retries", async () => {
    const streamId = `turn_${"6".repeat(48)}`;
    const envelopes = movementTurnTrace(streamId, 300);
    expect(envelopes.every((envelope) => envelope.turn?.terminal === false)).toBe(true);
    for (let offset = 0; offset < envelopes.length; offset += 64) {
      const response = await ingestMovementTurns(envelopes.slice(offset, offset + 64));
      expect(response.status, `offset ${offset}: ${await response.clone().text()}`).toBe(200);
    }
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ count: number; minimum: number; maximum: number }>(
        `SELECT COUNT(*) AS count, MIN(cursor) AS minimum, MAX(cursor) AS maximum
         FROM movement_turn_receipts WHERE stream_id = ?`,
        streamId,
      ).one(),
    )).resolves.toEqual({ count: 256, minimum: 45, maximum: 300 });
    const compacted = await ingestMovementTurns([envelopes[0]!]);
    expect(compacted.status).toBe(409);
    await expect(compacted.json()).resolves.toMatchObject({
      code: "cursor_compacted",
      streamId,
      checkpoint: 300,
      cursor: 1,
      accepted: 0,
      duplicates: 0,
      terminal: false,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      movementStateHash: envelopes.at(-1)!.movement.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn!.afterStateHash,
    });
    await evictDurableObject(stubFor(streamId));
    const compactedAfterEviction = await ingestMovementTurns([envelopes[0]!]);
    expect(compactedAfterEviction.status).toBe(409);
    await expect(compactedAfterEviction.json()).resolves.toMatchObject({
      code: "cursor_compacted",
      streamId,
      checkpoint: 300,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      movementStateHash: envelopes.at(-1)!.movement.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn!.afterStateHash,
    });
    await expect((await ingestMovementTurns([envelopes.at(-1)!])).json()).resolves.toMatchObject({
      checkpoint: 300,
      accepted: 0,
      duplicates: 1,
    });
  });

  it("recovers a local 300-envelope prefix after receipt compaction and actual eviction", async () => {
    const streamId = `turn_${"9".repeat(48)}`;
    const envelopes = movementTurnTrace(streamId, 300);
    for (let offset = 0; offset < envelopes.length; offset += 64) {
      const response = await ingestMovementTurns(envelopes.slice(offset, offset + 64));
      expect(response.status, `offset ${offset}: ${await response.clone().text()}`).toBe(200);
    }
    await evictDurableObject(stubFor(streamId));
    const statuses: number[] = [];
    const result = await catchUpMovementTurnJournal({
      journal: {
        readMovementTurnsAfter: (_streamId, cursor, limit) => envelopes.filter((envelope) => envelope.cursor > cursor).slice(0, limit),
      },
      streamId,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret: SECRET,
      maxEntriesPerBatch: 64,
      maxBatches: 2,
      fetchImpl: async (input, init) => {
        const response = await SELF.fetch(input, init);
        statuses.push(response.status);
        return response;
      },
    });
    expect(statuses).toEqual([409]);
    expect(result).toMatchObject({
      checkpoint: 300,
      accepted: 0,
      duplicates: 0,
      terminal: false,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      movementStateHash: envelopes.at(-1)!.movement.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn!.afterStateHash,
      batches: 1,
      caughtUp: true,
      backpressured: false,
    });
  });

  it("reconstructs a 300-combat envelope prefix against the evicted durable object", async () => {
    const streamId = `combat_${"9".repeat(48)}`;
    const envelopes = combatTurnTrace(streamId, 300);
    for (let offset = 0; offset < envelopes.length; offset += 64) {
      const response = await ingestCombatTurns(envelopes.slice(offset, offset + 64));
      expect(response.status, `offset ${offset}: ${await response.clone().text()}`).toBe(200);
    }
    await evictDurableObject(stubFor(streamId));
    const statuses: number[] = [];
    const result = await catchUpCombatTurnJournal({
      journal: {
        readCombatTurnsAfter: (_streamId, cursor, limit) => envelopes.filter((envelope) => envelope.cursor > cursor).slice(0, limit),
      },
      streamId,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret: SECRET,
      maxEntriesPerBatch: 64,
      maxBatches: 2,
      fetchImpl: async (input, init) => {
        const response = await SELF.fetch(input, init);
        statuses.push(response.status);
        return response;
      },
    });
    expect(statuses).toEqual([409]);
    expect(result).toMatchObject({
      checkpoint: 300,
      accepted: 0,
      duplicates: 0,
      terminal: false,
      lastEnvelopeHash: envelopes.at(-1)!.envelopeHash,
      combatStateHash: envelopes.at(-1)!.afterStateHash,
      turnStateHash: envelopes.at(-1)!.turn.afterStateHash,
      batches: 1,
      caughtUp: true,
      backpressured: false,
    });
  });

  it("retains a bounded exact-idempotency window and rejects compacted retries", async () => {
    const streamId = "receipt-window";
    const entries = trace(streamId, 300, initial({ hp: 1_000 }));
    for (let offset = 0; offset < entries.length; offset += 64) {
      const response = await ingest(entries.slice(offset, offset + 64));
      expect(response.status, `offset ${offset}: ${await response.clone().text()}`).toBe(200);
    }
    await expect(runInDurableObject(stubFor(streamId), (_instance, state) =>
      state.storage.sql.exec<{ count: number; minimum: number; maximum: number }>(
        `SELECT COUNT(*) AS count, MIN(cursor) AS minimum, MAX(cursor) AS maximum
         FROM shadow_entries WHERE stream_id = ?`,
        streamId,
      ).one(),
    )).resolves.toEqual({ count: 256, minimum: 45, maximum: 300 });

    const compacted = await ingest([entries[0]!]);
    expect(compacted.status).toBe(409);
    await expect(compacted.json()).resolves.toMatchObject({
      code: "cursor_compacted",
      checkpoint: 300,
      cursor: 1,
    });
    await expect((await ingest([entries.at(-1)!])).json()).resolves.toMatchObject({
      checkpoint: 300,
      accepted: 0,
      duplicates: 1,
    });
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

  it("keeps movement-turn checkpoints monotonic across seeded duplicate chunking", async () => {
    let seed = 0x7475726e;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const envelopes = movementTurnTrace(`turn_${"7".repeat(48)}`, 40);
    let cursor = 0;
    while (cursor < envelopes.length) {
      const width = 1 + Math.floor(random() * 6);
      const duplicatePrefix = random() < 0.6 ? Math.floor(random() * Math.min(4, cursor + 1)) : 0;
      const response = await ingestMovementTurns(
        envelopes.slice(Math.max(0, cursor - duplicatePrefix), Math.min(envelopes.length, cursor + width)),
      );
      const body = await response.json() as { checkpoint: number };
      expect(response.status).toBe(200);
      expect(body.checkpoint).toBeGreaterThanOrEqual(cursor);
      cursor = body.checkpoint;
    }
    expect(cursor).toBe(40);
  });
});
