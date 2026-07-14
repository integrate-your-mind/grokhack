import { DurableObject } from "cloudflare:workers";

import { gameplayStateHash, reduceGameplay } from "../../src/gameplay-reducer";
import { movementContinuityHash, movementEventHash, movementStateHash, reduceMovement } from "../../src/movement-reducer";
import {
  MAX_SHADOW_BATCH_BYTES,
  MAX_SHADOW_BATCH_ENTRIES,
  SHADOW_JOURNAL_VERSION,
  validateMovementTurnEnvelope,
  validateShadowJournalEntry,
  validateShadowRoute,
  type MovementTurnEnvelope,
  type ShadowJournalEntry,
  type ShadowRoute,
} from "../../src/shadow-journal";
import type { Env } from "./env";
import { BoundedBodyError, readBoundedText } from "./bounded-body";

interface CheckpointRow extends Record<string, SqlStorageValue> {
  checkpoint: number;
  last_entry_hash: string | null;
  state_hash: string | null;
  terminal: number;
  entry_version: number | null;
  state_domain: string | null;
  continuity_hash: string | null;
}

interface EntryRow extends Record<string, SqlStorageValue> {
  entry_hash: string;
}

interface MovementTurnCheckpointRow extends Record<string, SqlStorageValue> {
  checkpoint: number;
  last_envelope_hash: string | null;
  last_movement_entry_hash: string | null;
  last_turn_entry_hash: string | null;
  movement_state_hash: string | null;
  turn_state_hash: string | null;
  movement_continuity_hash: string | null;
  terminal: number;
}

interface MovementTurnReceiptRow extends Record<string, SqlStorageValue> {
  cursor: number;
  operation_id: string;
  envelope_hash: string;
}

interface TableColumnRow extends Record<string, SqlStorageValue> { name: string }
interface VersionRow extends Record<string, SqlStorageValue> { version: number | null }
interface CountRow extends Record<string, SqlStorageValue> { count: number }
interface IdentityRow extends Record<string, SqlStorageValue> {
  realm_id: string;
  floor_instance_id: string;
  depth: number;
  floor_epoch: number;
  ruleset_version: number;
  stream_id: string;
}

const SHADOW_SCHEMA_VERSION = 6;
const MAX_DIVERGENCES_PER_STREAM = 64;
const SHADOW_RECEIPT_WINDOW = 256;

type IngestFailure = {
  ok: false;
  code: string;
  checkpoint: number;
  expectedCursor?: number;
  cursor?: number;
  expectedHash?: string;
  actualHash?: string;
};

type IngestSuccess = {
  ok: true;
  streamId: string;
  checkpoint: number;
  accepted: number;
  duplicates: number;
  terminal: boolean;
  stateHash: string | null;
  entryVersion: number | null;
  stateDomain: "vitals" | "movement" | null;
};

type MovementTurnIngestSuccess = {
  ok: true;
  streamId: string;
  checkpoint: number;
  accepted: number;
  duplicates: number;
  terminal: boolean;
  lastEnvelopeHash: string | null;
  movementStateHash: string | null;
  turnStateHash: string | null;
};

type MovementTurnIngestFailure = IngestFailure & {
  streamId?: string;
  accepted?: number;
  duplicates?: number;
  terminal?: boolean;
  lastEnvelopeHash?: string | null;
  movementStateHash?: string | null;
  turnStateHash?: string | null;
};

function firstRow<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class ShadowReplay extends DurableObject<Env> {
  private readonly schemaCompatible: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.schemaCompatible = this.initializeSchema();
  }

  private initializeSchema(): boolean {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _shadow_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const maximumVersion = firstRow(this.ctx.storage.sql.exec<VersionRow>(
      "SELECT MAX(version) AS version FROM _shadow_schema_migrations",
    ))?.version;
    if (maximumVersion !== null && maximumVersion !== undefined && maximumVersion > SHADOW_SCHEMA_VERSION) {
      return false;
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shadow_checkpoint (
        stream_id TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL CHECK (checkpoint >= 0),
        last_entry_hash TEXT,
        state_hash TEXT,
        terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
        entry_version INTEGER,
        state_domain TEXT CHECK (state_domain IN ('vitals', 'movement')),
        continuity_hash TEXT,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS shadow_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        realm_id TEXT NOT NULL,
        floor_instance_id TEXT NOT NULL,
        depth INTEGER NOT NULL CHECK (depth >= 1),
        floor_epoch INTEGER NOT NULL CHECK (floor_epoch >= 1),
        ruleset_version INTEGER NOT NULL CHECK (ruleset_version >= 1),
        stream_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_entries (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        entry_version INTEGER NOT NULL DEFAULT 1,
        before_state_hash TEXT NOT NULL,
        after_state_hash TEXT NOT NULL,
        before_continuity_hash TEXT,
        after_continuity_hash TEXT,
        event_hash TEXT,
        terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS shadow_divergences (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        actual_hash TEXT NOT NULL,
        divergence_kind TEXT NOT NULL DEFAULT 'legacy_unknown',
        entry_version INTEGER,
        state_domain TEXT,
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor, entry_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS movement_turn_checkpoint (
        stream_id TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL CHECK (checkpoint >= 0),
        last_envelope_hash TEXT,
        last_movement_entry_hash TEXT,
        last_turn_entry_hash TEXT,
        movement_state_hash TEXT,
        turn_state_hash TEXT,
        movement_continuity_hash TEXT,
        terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS movement_turn_receipts (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        envelope_hash TEXT NOT NULL,
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor),
        UNIQUE (stream_id, operation_id)
      ) WITHOUT ROWID;
    `);
    const columns = new Set(this.ctx.storage.sql.exec<TableColumnRow>("PRAGMA table_info(shadow_checkpoint)").toArray().map((row) => row.name));
    const expansions = [
      ["last_entry_hash", "TEXT"],
      ["state_hash", "TEXT"],
      ["terminal", "INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1))"],
      ["entry_version", "INTEGER"],
      ["state_domain", "TEXT"],
      ["continuity_hash", "TEXT"],
      ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of expansions) {
      if (!columns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_checkpoint ADD COLUMN ${name} ${definition}`);
    }
    const entryColumns = new Set(this.ctx.storage.sql.exec<TableColumnRow>("PRAGMA table_info(shadow_entries)").toArray().map((row) => row.name));
    const entryExpansions = [
      ["entry_version", "INTEGER NOT NULL DEFAULT 1"],
      ["before_continuity_hash", "TEXT"],
      ["after_continuity_hash", "TEXT"],
      ["event_hash", "TEXT"],
    ] as const;
    for (const [name, definition] of entryExpansions) {
      if (!entryColumns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_entries ADD COLUMN ${name} ${definition}`);
    }
    const divergenceColumns = new Set(this.ctx.storage.sql.exec<TableColumnRow>("PRAGMA table_info(shadow_divergences)").toArray().map((row) => row.name));
    const divergenceExpansions = [
      ["divergence_kind", "TEXT NOT NULL DEFAULT 'legacy_unknown'"],
      ["entry_version", "INTEGER"],
      ["state_domain", "TEXT"],
    ] as const;
    for (const [name, definition] of divergenceExpansions) {
      if (!divergenceColumns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_divergences ADD COLUMN ${name} ${definition}`);
    }
    // Every nonzero checkpoint created before V2 represents a V1 vitals row.
    // Backfill its domain so duplicate-only catch-up remains interpretable.
    this.ctx.storage.sql.exec(`UPDATE shadow_checkpoint
      SET entry_version = 1, state_domain = 'vitals'
      WHERE checkpoint > 0 AND entry_version IS NULL AND state_domain IS NULL`);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO _shadow_schema_migrations (version, applied_at) VALUES (1, unixepoch()), (2, unixepoch()), (3, unixepoch()), (4, unixepoch()), (5, unixepoch()), (6, unixepoch())");
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/catch-up") return json({ code: "not_found" }, 404);
    if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405);
    if (!this.schemaCompatible) return json({ code: "shadow_schema_incompatible" }, 503);
    let text: string;
    try {
      text = await readBoundedText(request, MAX_SHADOW_BATCH_BYTES);
    } catch (error) {
      if (error instanceof BoundedBodyError && error.code === "body_too_large") {
        return json({ code: "batch_too_large" }, 413);
      }
      return json({ code: error instanceof BoundedBodyError ? error.code : "body_read_failed" }, 400);
    }
    let candidate: unknown;
    try { candidate = JSON.parse(text); } catch { return json({ code: "malformed_json" }, 400); }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return json({ code: "invalid_batch" }, 400);
    let route: ShadowRoute;
    try { route = validateShadowRoute((candidate as { route?: unknown }).route); }
    catch (error) { return json({ code: error instanceof Error ? error.message : "invalid_route" }, 400); }
    const rawEnvelopes = (candidate as { envelopes?: unknown }).envelopes;
    const rawEntries = (candidate as { entries?: unknown }).entries;
    if (Array.isArray(rawEnvelopes)) {
      if (rawEntries !== undefined || rawEnvelopes.length < 1) return json({ code: "invalid_batch" }, 400);
      if (rawEnvelopes.length > MAX_SHADOW_BATCH_ENTRIES) {
        return json({ code: "shadow_backpressure", limit: MAX_SHADOW_BATCH_ENTRIES }, 429);
      }
      let envelopes: MovementTurnEnvelope[];
      try { envelopes = rawEnvelopes.map(validateMovementTurnEnvelope); } catch (error) {
        return json({ code: error instanceof Error ? error.message : "invalid_movement_turn_envelope", checkpoint: 0 }, 400);
      }
      const streamId = envelopes[0]!.streamId;
      if (envelopes.some((envelope) => envelope.streamId !== streamId)) {
        return json({ code: "mixed_stream_batch", checkpoint: 0 }, 400);
      }
      if (envelopes.some((envelope, index) => index > 0 && envelope.cursor <= envelopes[index - 1]!.cursor)) {
        return json({ code: "batch_out_of_order", checkpoint: this.movementTurnCheckpoint(streamId).checkpoint }, 409);
      }
      if (envelopes.some((envelope) => {
        const authority = envelope.movement.beforeState.authority;
        return authority.realmId !== route.realmId || authority.floorInstanceId !== route.floorInstanceId ||
          authority.depth !== route.depth || authority.floorEpoch !== route.floorEpoch ||
          authority.rulesetVersion !== route.rulesetVersion;
      })) {
        return json({ code: "movement_authority_mismatch", checkpoint: this.movementTurnCheckpoint(streamId).checkpoint }, 409);
      }
      const result = this.ingestMovementTurns(envelopes, route);
      if (result.ok) {
        return json({
          streamId: result.streamId,
          checkpoint: result.checkpoint,
          accepted: result.accepted,
          duplicates: result.duplicates,
          terminal: result.terminal,
          lastEnvelopeHash: result.lastEnvelopeHash,
          movementStateHash: result.movementStateHash,
          turnStateHash: result.turnStateHash,
        });
      }
      const status = result.code.endsWith("_divergence") || result.code === "terminal_mismatch" ? 422 : 409;
      return json(result, status);
    }
    if (!Array.isArray(rawEntries) || rawEntries.length < 1) return json({ code: "invalid_batch" }, 400);
    if (rawEntries.length > MAX_SHADOW_BATCH_ENTRIES) return json({ code: "shadow_backpressure", limit: MAX_SHADOW_BATCH_ENTRIES }, 429);
    let entries: ShadowJournalEntry[];
    try { entries = rawEntries.map(validateShadowJournalEntry); } catch (error) {
      return json({ code: error instanceof Error ? error.message : "invalid_entry", checkpoint: 0 }, 400);
    }
    const streamId = entries[0]!.streamId;
    if (entries.some((entry) => entry.streamId !== streamId)) return json({ code: "mixed_stream_batch", checkpoint: 0 }, 400);
    if (entries.some((entry, index) => index > 0 && entry.cursor <= entries[index - 1]!.cursor)) {
      return json({ code: "batch_out_of_order", checkpoint: this.checkpoint(streamId).checkpoint }, 409);
    }
    if (entries.some((entry) => entry.v !== SHADOW_JOURNAL_VERSION && (
      entry.beforeState.authority.realmId !== route.realmId ||
      entry.beforeState.authority.floorInstanceId !== route.floorInstanceId ||
      entry.beforeState.authority.depth !== route.depth ||
      entry.beforeState.authority.floorEpoch !== route.floorEpoch ||
      entry.beforeState.authority.rulesetVersion !== route.rulesetVersion
    ))) {
      return json({ code: "movement_authority_mismatch", checkpoint: this.checkpoint(streamId).checkpoint }, 409);
    }
    const result = this.ingest(entries, route);
    if (result.ok) return json(result);
    const status = result.code === "state_hash_divergence" || result.code === "event_hash_divergence" ||
      result.code === "state_continuity_divergence" || result.code === "continuity_hash_divergence" ||
      result.code === "terminal_mismatch" ? 422 : 409;
    return json(result, status);
  }

  private checkpoint(streamId: string): CheckpointRow {
    return firstRow(this.ctx.storage.sql.exec<CheckpointRow>(
      "SELECT checkpoint, last_entry_hash, state_hash, terminal, entry_version, state_domain, continuity_hash FROM shadow_checkpoint WHERE stream_id = ?", streamId,
    )) ?? { checkpoint: 0, last_entry_hash: null, state_hash: null, terminal: 0, entry_version: null, state_domain: null, continuity_hash: null };
  }

  private movementTurnCheckpoint(streamId: string): MovementTurnCheckpointRow {
    return firstRow(this.ctx.storage.sql.exec<MovementTurnCheckpointRow>(
      `SELECT checkpoint, last_envelope_hash, last_movement_entry_hash, last_turn_entry_hash,
        movement_state_hash, turn_state_hash, movement_continuity_hash, terminal
       FROM movement_turn_checkpoint WHERE stream_id = ?`,
      streamId,
    )) ?? {
      checkpoint: 0,
      last_envelope_hash: null,
      last_movement_entry_hash: null,
      last_turn_entry_hash: null,
      movement_state_hash: null,
      turn_state_hash: null,
      movement_continuity_hash: null,
      terminal: 0,
    };
  }

  // A compacted receipt cannot prove an old retry by itself. Return the
  // durable head so an authenticated copier can reconstruct its local prefix
  // and prove the remote state before it skips forward.
  private movementTurnCompactedCheckpoint(streamId: string, cursor: number): MovementTurnIngestFailure {
    const checkpoint = this.movementTurnCheckpoint(streamId);
    return {
      ok: false,
      code: "cursor_compacted",
      streamId,
      checkpoint: checkpoint.checkpoint,
      expectedCursor: checkpoint.checkpoint + 1,
      cursor,
      accepted: 0,
      duplicates: 0,
      terminal: checkpoint.terminal === 1,
      lastEnvelopeHash: checkpoint.last_envelope_hash,
      movementStateHash: checkpoint.movement_state_hash,
      turnStateHash: checkpoint.turn_state_hash,
    };
  }

  private recordDivergence(
    entry: ShadowJournalEntry,
    kind: "state" | "event" | "continuity_before" | "continuity_after" | "terminal",
    expectedHash: string,
    actualHash: string,
  ): void {
    this.recordDivergenceEvidence({
      streamId: entry.streamId,
      cursor: entry.cursor,
      entryHash: entry.entryHash,
      kind,
      expectedHash,
      actualHash,
      entryVersion: entry.v,
      stateDomain: entry.v === SHADOW_JOURNAL_VERSION ? "vitals" : "movement",
    });
  }

  private recordDivergenceEvidence(evidence: {
    streamId: string;
    cursor: number;
    entryHash: string;
    kind: string;
    expectedHash: string;
    actualHash: string;
    entryVersion: number;
    stateDomain: "vitals" | "movement";
  }): void {
    const retained = this.ctx.storage.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM shadow_divergences WHERE stream_id = ?",
      evidence.streamId,
    ).one().count;
    if (retained >= MAX_DIVERGENCES_PER_STREAM) return;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO shadow_divergences
        (stream_id, cursor, entry_hash, expected_hash, actual_hash, divergence_kind, entry_version, state_domain, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      evidence.streamId,
      evidence.cursor,
      evidence.entryHash,
      evidence.expectedHash,
      evidence.actualHash,
      evidence.kind,
      evidence.entryVersion,
      evidence.stateDomain,
    );
    console.error(JSON.stringify({
      event: "shadow_replay_divergence",
      streamId: evidence.streamId,
      cursor: evidence.cursor,
      kind: evidence.kind,
      entryVersion: evidence.entryVersion,
      stateDomain: evidence.stateDomain,
    }));
  }

  private movementTurnDivergence(
    envelope: MovementTurnEnvelope,
    kind: string,
    stateDomain: "vitals" | "movement",
    code: string,
    checkpoint: number,
    expectedHash: string,
    actualHash: string,
  ): IngestFailure {
    this.recordDivergenceEvidence({
      streamId: envelope.streamId,
      cursor: envelope.cursor,
      entryHash: envelope.envelopeHash,
      kind,
      expectedHash,
      actualHash,
      entryVersion: envelope.v,
      stateDomain,
    });
    return {
      ok: false,
      code,
      checkpoint,
      cursor: envelope.cursor,
      expectedHash,
      actualHash,
    };
  }

  private bindIdentity(route: ShadowRoute, streamId: string): boolean {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO shadow_identity
        (singleton, realm_id, floor_instance_id, depth, floor_epoch, ruleset_version, stream_id)
        VALUES (1, ?, ?, ?, ?, ?, ?)`,
      route.realmId,
      route.floorInstanceId,
      route.depth,
      route.floorEpoch,
      route.rulesetVersion,
      streamId,
    );
    const identity = this.ctx.storage.sql.exec<IdentityRow>(
      `SELECT realm_id, floor_instance_id, depth, floor_epoch, ruleset_version, stream_id
       FROM shadow_identity WHERE singleton = 1`,
    ).one();
    return identity.realm_id === route.realmId &&
      identity.floor_instance_id === route.floorInstanceId &&
      identity.depth === route.depth &&
      identity.floor_epoch === route.floorEpoch &&
      identity.ruleset_version === route.rulesetVersion &&
      identity.stream_id === streamId;
  }

  private ingestMovementTurns(
    envelopes: readonly MovementTurnEnvelope[],
    route: ShadowRoute,
  ): MovementTurnIngestSuccess | MovementTurnIngestFailure {
    return this.ctx.storage.transactionSync(() => {
      const streamId = envelopes[0]!.streamId;
      if (!this.bindIdentity(route, streamId)) {
        return { ok: false, code: "shadow_identity_mismatch", checkpoint: this.movementTurnCheckpoint(streamId).checkpoint };
      }
      let checkpoint = this.movementTurnCheckpoint(streamId);
      const committedCheckpoint = checkpoint.checkpoint;
      let accepted = 0;
      let duplicates = 0;
      const planned: Array<{
        envelope: MovementTurnEnvelope;
        movementStateHash: string;
        turnStateHash: string | null;
        movementContinuityHash: string | null;
        terminal: boolean;
      }> = [];
      const plannedByCursor = new Map<number, MovementTurnEnvelope>();
      const plannedByOperation = new Map<string, MovementTurnEnvelope>();

      // Validate the complete batch against a simulated checkpoint before the
      // first receipt write. A validation failure therefore advances neither
      // the envelope cursor nor either nested state head.
      for (const envelope of envelopes) {
        const pendingAtCursor = plannedByCursor.get(envelope.cursor);
        if (pendingAtCursor) {
          if (pendingAtCursor.envelopeHash !== envelope.envelopeHash ||
              pendingAtCursor.operationId !== envelope.operationId) {
            return { ok: false, code: "idempotency_conflict", checkpoint: committedCheckpoint, cursor: envelope.cursor };
          }
          duplicates++;
          continue;
        }
        if (plannedByOperation.has(envelope.operationId)) {
          return { ok: false, code: "operation_reused", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }
        const existing = firstRow(this.ctx.storage.sql.exec<MovementTurnReceiptRow>(
          `SELECT cursor, operation_id, envelope_hash FROM movement_turn_receipts
           WHERE stream_id = ? AND cursor = ?`,
          streamId,
          envelope.cursor,
        ));
        if (existing) {
          if (existing.envelope_hash !== envelope.envelopeHash || existing.operation_id !== envelope.operationId) {
            return { ok: false, code: "idempotency_conflict", checkpoint: committedCheckpoint, cursor: envelope.cursor };
          }
          duplicates++;
          continue;
        }
        const reusedOperation = firstRow(this.ctx.storage.sql.exec<MovementTurnReceiptRow>(
          `SELECT cursor, operation_id, envelope_hash FROM movement_turn_receipts
           WHERE stream_id = ? AND operation_id = ?`,
          streamId,
          envelope.operationId,
        ));
        if (reusedOperation) {
          return { ok: false, code: "operation_reused", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }
        const expectedCursor = checkpoint.checkpoint + 1;
        if (envelope.cursor <= checkpoint.checkpoint - SHADOW_RECEIPT_WINDOW) {
          return this.movementTurnCompactedCheckpoint(streamId, envelope.cursor);
        }
        if (envelope.cursor !== expectedCursor) {
          return {
            ok: false,
            code: envelope.cursor < expectedCursor ? "cursor_out_of_order" : "cursor_gap",
            checkpoint: committedCheckpoint,
            expectedCursor,
            cursor: envelope.cursor,
          };
        }
        if (checkpoint.terminal === 1) {
          return { ok: false, code: "terminal_state", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }
        if (envelope.previousEnvelopeHash !== checkpoint.last_envelope_hash) {
          return { ok: false, code: "envelope_hash_chain_mismatch", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }
        if (envelope.movement.previousEntryHash !== checkpoint.last_movement_entry_hash) {
          return { ok: false, code: "movement_hash_chain_mismatch", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }
        if (envelope.turn && envelope.turn.previousEntryHash !== checkpoint.last_turn_entry_hash) {
          return { ok: false, code: "turn_hash_chain_mismatch", checkpoint: committedCheckpoint, cursor: envelope.cursor };
        }

        const beforeContinuityHash = movementContinuityHash(envelope.movement.beforeState);
        if (checkpoint.movement_continuity_hash !== null &&
            beforeContinuityHash !== checkpoint.movement_continuity_hash) {
          return this.movementTurnDivergence(
            envelope,
            "envelope_movement_continuity_before",
            "movement",
            "movement_continuity_divergence",
            committedCheckpoint,
            checkpoint.movement_continuity_hash,
            beforeContinuityHash,
          );
        }
        const movementTransition = reduceMovement(envelope.movement.beforeState, envelope.movement.command);
        const actualMovementStateHash = movementStateHash(movementTransition.state);
        const actualMovementEventHash = movementEventHash(movementTransition);
        const actualMovementContinuityHash = movementContinuityHash(movementTransition.state);
        const actualMovementTerminal = !movementTransition.state.alive;
        if (actualMovementStateHash !== envelope.movement.afterStateHash) {
          return this.movementTurnDivergence(
            envelope,
            "envelope_movement_state",
            "movement",
            "movement_state_divergence",
            committedCheckpoint,
            envelope.movement.afterStateHash,
            actualMovementStateHash,
          );
        }
        if (actualMovementEventHash !== envelope.movement.eventHash) {
          return this.movementTurnDivergence(
            envelope,
            "envelope_movement_event",
            "movement",
            "movement_event_divergence",
            committedCheckpoint,
            envelope.movement.eventHash,
            actualMovementEventHash,
          );
        }
        if (actualMovementContinuityHash !== envelope.movement.afterContinuityHash) {
          return this.movementTurnDivergence(
            envelope,
            "envelope_movement_continuity_after",
            "movement",
            "movement_continuity_divergence",
            committedCheckpoint,
            envelope.movement.afterContinuityHash,
            actualMovementContinuityHash,
          );
        }
        if (actualMovementTerminal !== envelope.movement.terminal) {
          return this.movementTurnDivergence(
            envelope,
            "envelope_movement_terminal",
            "movement",
            "terminal_mismatch",
            committedCheckpoint,
            envelope.movement.terminal ? "1" : "0",
            actualMovementTerminal ? "1" : "0",
          );
        }

        let nextTurnEntryHash = checkpoint.last_turn_entry_hash;
        let nextTurnStateHash = checkpoint.turn_state_hash;
        if (envelope.turn) {
          const turnTransition = reduceGameplay(envelope.turn.beforeState, envelope.turn.command);
          const actualTurnStateHash = gameplayStateHash(turnTransition.state);
          const actualTurnTerminal = !turnTransition.state.alive;
          if (actualTurnStateHash !== envelope.turn.afterStateHash) {
            return this.movementTurnDivergence(
              envelope,
              "envelope_turn_state",
              "vitals",
              "turn_state_divergence",
              committedCheckpoint,
              envelope.turn.afterStateHash,
              actualTurnStateHash,
            );
          }
          if (actualTurnTerminal !== envelope.turn.terminal) {
            return this.movementTurnDivergence(
              envelope,
              "envelope_turn_terminal",
              "vitals",
              "terminal_mismatch",
              committedCheckpoint,
              envelope.turn.terminal ? "1" : "0",
              actualTurnTerminal ? "1" : "0",
            );
          }
          nextTurnEntryHash = envelope.turn.entryHash;
          nextTurnStateHash = actualTurnStateHash;
        }
        const terminal = envelope.turn?.terminal ?? envelope.movement.terminal;
        const nextMovementContinuityHash = movementTransition.turnCost === "none"
          ? actualMovementContinuityHash
          : null;
        planned.push({
          envelope,
          movementStateHash: actualMovementStateHash,
          turnStateHash: nextTurnStateHash,
          movementContinuityHash: nextMovementContinuityHash,
          terminal,
        });
        plannedByCursor.set(envelope.cursor, envelope);
        plannedByOperation.set(envelope.operationId, envelope);
        checkpoint = {
          checkpoint: envelope.cursor,
          last_envelope_hash: envelope.envelopeHash,
          last_movement_entry_hash: envelope.movement.entryHash,
          last_turn_entry_hash: nextTurnEntryHash,
          movement_state_hash: actualMovementStateHash,
          turn_state_hash: nextTurnStateHash,
          movement_continuity_hash: nextMovementContinuityHash,
          terminal: terminal ? 1 : 0,
        };
        accepted++;
      }

      for (const item of planned) {
        this.ctx.storage.sql.exec(
          `INSERT INTO movement_turn_receipts
            (stream_id, cursor, operation_id, envelope_hash, ingested_at)
           VALUES (?, ?, ?, ?, unixepoch())`,
          streamId,
          item.envelope.cursor,
          item.envelope.operationId,
          item.envelope.envelopeHash,
        );
      }
      if (planned.length > 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO movement_turn_checkpoint
            (stream_id, checkpoint, last_envelope_hash, last_movement_entry_hash, last_turn_entry_hash,
             movement_state_hash, turn_state_hash, movement_continuity_hash, terminal, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
           ON CONFLICT(stream_id) DO UPDATE SET checkpoint = excluded.checkpoint,
             last_envelope_hash = excluded.last_envelope_hash,
             last_movement_entry_hash = excluded.last_movement_entry_hash,
             last_turn_entry_hash = excluded.last_turn_entry_hash,
             movement_state_hash = excluded.movement_state_hash,
             turn_state_hash = excluded.turn_state_hash,
             movement_continuity_hash = excluded.movement_continuity_hash,
             terminal = excluded.terminal, updated_at = excluded.updated_at`,
          streamId,
          checkpoint.checkpoint,
          checkpoint.last_envelope_hash,
          checkpoint.last_movement_entry_hash,
          checkpoint.last_turn_entry_hash,
          checkpoint.movement_state_hash,
          checkpoint.turn_state_hash,
          checkpoint.movement_continuity_hash,
          checkpoint.terminal,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM movement_turn_receipts WHERE stream_id = ? AND cursor <= ?",
          streamId,
          checkpoint.checkpoint - SHADOW_RECEIPT_WINDOW,
        );
      }
      const durableCheckpoint = this.movementTurnCheckpoint(streamId);
      return {
        ok: true,
        streamId,
        checkpoint: durableCheckpoint.checkpoint,
        accepted,
        duplicates,
        terminal: durableCheckpoint.terminal === 1,
        lastEnvelopeHash: durableCheckpoint.last_envelope_hash,
        movementStateHash: durableCheckpoint.movement_state_hash,
        turnStateHash: durableCheckpoint.turn_state_hash,
      };
    });
  }

  private ingest(entries: readonly ShadowJournalEntry[], route: ShadowRoute): IngestSuccess | IngestFailure {
    return this.ctx.storage.transactionSync(() => {
      const streamId = entries[0]!.streamId;
      if (!this.bindIdentity(route, streamId)) {
        return { ok: false, code: "shadow_identity_mismatch", checkpoint: this.checkpoint(streamId).checkpoint };
      }
      let checkpoint = this.checkpoint(streamId);
      let accepted = 0;
      let duplicates = 0;
      for (const entry of entries) {
        const existing = firstRow(this.ctx.storage.sql.exec<EntryRow>(
          "SELECT entry_hash FROM shadow_entries WHERE stream_id = ? AND cursor = ?", streamId, entry.cursor,
        ));
        if (existing) {
          if (existing.entry_hash !== entry.entryHash) return { ok: false, code: "idempotency_conflict", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
          duplicates++;
          continue;
        }
        const expectedCursor = checkpoint.checkpoint + 1;
        if (entry.cursor <= checkpoint.checkpoint - SHADOW_RECEIPT_WINDOW) {
          return {
            ok: false,
            code: "cursor_compacted",
            checkpoint: checkpoint.checkpoint,
            expectedCursor,
            cursor: entry.cursor,
          };
        }
        if (entry.cursor !== expectedCursor) return {
          ok: false,
          code: entry.cursor < expectedCursor ? "cursor_out_of_order" : "cursor_gap",
          checkpoint: checkpoint.checkpoint,
          expectedCursor,
          cursor: entry.cursor,
        };
        if (checkpoint.terminal === 1) return { ok: false, code: "terminal_state", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        if (entry.previousEntryHash !== checkpoint.last_entry_hash) return { ok: false, code: "hash_chain_mismatch", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        if (checkpoint.state_domain === "movement" && entry.v === SHADOW_JOURNAL_VERSION) {
          return { ok: false, code: "state_domain_regression", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        }
        let actualHash: string;
        let actualTerminal: boolean;
        let actualEventHash: string | null = null;
        let nextContinuityHash: string | null = null;
        if (entry.v === SHADOW_JOURNAL_VERSION) {
          const transition = reduceGameplay(entry.beforeState, entry.command);
          actualHash = gameplayStateHash(transition.state);
          actualTerminal = !transition.state.alive;
        } else {
          const actualBeforeContinuityHash = movementContinuityHash(entry.beforeState);
          if (checkpoint.state_domain === "movement" && checkpoint.continuity_hash !== null &&
              actualBeforeContinuityHash !== checkpoint.continuity_hash) {
            this.recordDivergence(entry, "continuity_before", checkpoint.continuity_hash, actualBeforeContinuityHash);
            return {
              ok: false,
              code: "state_continuity_divergence",
              checkpoint: checkpoint.checkpoint,
              cursor: entry.cursor,
              expectedHash: checkpoint.continuity_hash,
              actualHash: actualBeforeContinuityHash,
            };
          }
          const transition = reduceMovement(entry.beforeState, entry.command);
          actualHash = movementStateHash(transition.state);
          actualEventHash = movementEventHash(transition);
          actualTerminal = !transition.state.alive;
          const actualAfterContinuityHash = movementContinuityHash(transition.state);
          if (actualAfterContinuityHash !== entry.afterContinuityHash) {
            this.recordDivergence(entry, "continuity_after", entry.afterContinuityHash, actualAfterContinuityHash);
            return {
              ok: false,
              code: "continuity_hash_divergence",
              checkpoint: checkpoint.checkpoint,
              cursor: entry.cursor,
              expectedHash: entry.afterContinuityHash,
              actualHash: actualAfterContinuityHash,
            };
          }
          // Turn-consuming decisions hand off to origin-only effects (combat,
          // traps, room events, vitals and AI). Until those reducers are shared,
          // only a no-turn decision can safely constrain the next command.
          nextContinuityHash = transition.turnCost === "none" ? actualAfterContinuityHash : null;
        }
        if (actualHash !== entry.afterStateHash) {
          this.recordDivergence(entry, "state", entry.afterStateHash, actualHash);
          return { ok: false, code: "state_hash_divergence", checkpoint: checkpoint.checkpoint, cursor: entry.cursor, expectedHash: entry.afterStateHash, actualHash };
        }
        if (entry.v !== SHADOW_JOURNAL_VERSION) {
          if (actualEventHash === null) throw new Error("movement replay omitted event hash");
          if (actualEventHash !== entry.eventHash) {
            this.recordDivergence(entry, "event", entry.eventHash, actualEventHash);
            return { ok: false, code: "event_hash_divergence", checkpoint: checkpoint.checkpoint, cursor: entry.cursor, expectedHash: entry.eventHash, actualHash: actualEventHash };
          }
        }
        if (entry.terminal !== actualTerminal) {
          this.recordDivergence(entry, "terminal", entry.terminal ? "1" : "0", actualTerminal ? "1" : "0");
          return { ok: false, code: "terminal_mismatch", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO shadow_entries
            (stream_id, cursor, entry_hash, entry_version, before_state_hash, after_state_hash,
              before_continuity_hash, after_continuity_hash, event_hash, terminal, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
          streamId, entry.cursor, entry.entryHash, entry.v, entry.beforeStateHash, entry.afterStateHash,
          entry.v === SHADOW_JOURNAL_VERSION ? null : entry.beforeContinuityHash,
          entry.v === SHADOW_JOURNAL_VERSION ? null : entry.afterContinuityHash,
          entry.v === SHADOW_JOURNAL_VERSION ? null : entry.eventHash,
          entry.terminal ? 1 : 0,
        );
        this.ctx.storage.sql.exec(`INSERT INTO shadow_checkpoint
          (stream_id, checkpoint, last_entry_hash, state_hash, terminal, entry_version, state_domain, continuity_hash, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(stream_id) DO UPDATE SET checkpoint = excluded.checkpoint,
            last_entry_hash = excluded.last_entry_hash, state_hash = excluded.state_hash,
            terminal = excluded.terminal, entry_version = excluded.entry_version,
            state_domain = excluded.state_domain, continuity_hash = excluded.continuity_hash,
            updated_at = excluded.updated_at`,
          streamId, entry.cursor, entry.entryHash, actualHash, entry.terminal ? 1 : 0,
          entry.v, entry.v === SHADOW_JOURNAL_VERSION ? "vitals" : "movement", nextContinuityHash,
        );
        checkpoint = {
          checkpoint: entry.cursor,
          last_entry_hash: entry.entryHash,
          state_hash: actualHash,
          terminal: entry.terminal ? 1 : 0,
          entry_version: entry.v,
          state_domain: entry.v === SHADOW_JOURNAL_VERSION ? "vitals" : "movement",
          continuity_hash: nextContinuityHash,
        };
        this.ctx.storage.sql.exec(
          "DELETE FROM shadow_entries WHERE stream_id = ? AND cursor <= ?",
          streamId,
          entry.cursor - SHADOW_RECEIPT_WINDOW,
        );
        accepted++;
      }
      return {
        ok: true,
        streamId,
        checkpoint: checkpoint.checkpoint,
        accepted,
        duplicates,
        terminal: checkpoint.terminal === 1,
        stateHash: checkpoint.state_hash,
        entryVersion: checkpoint.entry_version,
        stateDomain: checkpoint.state_domain === "vitals" || checkpoint.state_domain === "movement"
          ? checkpoint.state_domain
          : null,
      };
    });
  }
}
