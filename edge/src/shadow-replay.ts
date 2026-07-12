import { DurableObject } from "cloudflare:workers";

import { gameplayStateHash, reduceGameplay } from "../../src/gameplay-reducer";
import { movementEventHash, movementStateHash, reduceMovement } from "../../src/movement-reducer";
import {
  MAX_SHADOW_BATCH_BYTES,
  MAX_SHADOW_BATCH_ENTRIES,
  SHADOW_JOURNAL_VERSION,
  validateShadowJournalEntry,
  validateShadowRoute,
  type ShadowJournalEntry,
  type ShadowRoute,
} from "../../src/shadow-journal";
import type { Env } from "./env";

interface CheckpointRow extends Record<string, SqlStorageValue> {
  checkpoint: number;
  last_entry_hash: string | null;
  state_hash: string | null;
  terminal: number;
  entry_version: number | null;
  state_domain: string | null;
}

interface EntryRow extends Record<string, SqlStorageValue> {
  entry_hash: string;
}

interface TableColumnRow extends Record<string, SqlStorageValue> { name: string }

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

function firstRow<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class ShadowReplay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shadow_checkpoint (
        stream_id TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL CHECK (checkpoint >= 0),
        last_entry_hash TEXT,
        state_hash TEXT,
        terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
        entry_version INTEGER,
        state_domain TEXT CHECK (state_domain IN ('vitals', 'movement')),
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS shadow_entries (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        entry_version INTEGER NOT NULL DEFAULT 1,
        before_state_hash TEXT NOT NULL,
        after_state_hash TEXT NOT NULL,
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
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, cursor, entry_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS _shadow_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(this.ctx.storage.sql.exec<TableColumnRow>("PRAGMA table_info(shadow_checkpoint)").toArray().map((row) => row.name));
    const expansions = [
      ["last_entry_hash", "TEXT"],
      ["state_hash", "TEXT"],
      ["terminal", "INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1))"],
      ["entry_version", "INTEGER"],
      ["state_domain", "TEXT"],
      ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of expansions) {
      if (!columns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_checkpoint ADD COLUMN ${name} ${definition}`);
    }
    const entryColumns = new Set(this.ctx.storage.sql.exec<TableColumnRow>("PRAGMA table_info(shadow_entries)").toArray().map((row) => row.name));
    const entryExpansions = [
      ["entry_version", "INTEGER NOT NULL DEFAULT 1"],
      ["event_hash", "TEXT"],
    ] as const;
    for (const [name, definition] of entryExpansions) {
      if (!entryColumns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_entries ADD COLUMN ${name} ${definition}`);
    }
    // Every nonzero checkpoint created before V2 represents a V1 vitals row.
    // Backfill its domain so duplicate-only catch-up remains interpretable.
    this.ctx.storage.sql.exec(`UPDATE shadow_checkpoint
      SET entry_version = 1, state_domain = 'vitals'
      WHERE checkpoint > 0 AND entry_version IS NULL AND state_domain IS NULL`);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO _shadow_schema_migrations (version, applied_at) VALUES (1, unixepoch()), (2, unixepoch()), (3, unixepoch())");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/catch-up") return json({ code: "not_found" }, 404);
    if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SHADOW_BATCH_BYTES) return json({ code: "batch_too_large" }, 413);
    let candidate: unknown;
    try { candidate = JSON.parse(text); } catch { return json({ code: "malformed_json" }, 400); }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return json({ code: "invalid_batch" }, 400);
    let route: ShadowRoute;
    try { route = validateShadowRoute((candidate as { route?: unknown }).route); }
    catch (error) { return json({ code: error instanceof Error ? error.message : "invalid_route" }, 400); }
    const rawEntries = (candidate as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries) || rawEntries.length < 1) return json({ code: "invalid_batch" }, 400);
    if (rawEntries.length > MAX_SHADOW_BATCH_ENTRIES) return json({ code: "shadow_backpressure", limit: MAX_SHADOW_BATCH_ENTRIES }, 429);
    let entries: ShadowJournalEntry[];
    try { entries = rawEntries.map(validateShadowJournalEntry); } catch (error) {
      return json({ code: error instanceof Error ? error.message : "invalid_entry", checkpoint: 0 }, 400);
    }
    const streamId = entries[0]!.streamId;
    if (entries.some((entry) => entry.streamId !== streamId)) return json({ code: "mixed_stream_batch", checkpoint: 0 }, 400);
    if (entries.some((entry) => entry.v !== SHADOW_JOURNAL_VERSION && (
      entry.beforeState.authority.realmId !== route.realmId ||
      entry.beforeState.authority.floorInstanceId !== route.floorInstanceId ||
      entry.beforeState.authority.depth !== route.depth ||
      entry.beforeState.authority.floorEpoch !== route.floorEpoch ||
      entry.beforeState.authority.rulesetVersion !== route.rulesetVersion
    ))) {
      return json({ code: "movement_authority_mismatch", checkpoint: this.checkpoint(streamId).checkpoint }, 409);
    }
    const result = this.ingest(entries);
    if (result.ok) return json(result);
    const status = result.code === "state_hash_divergence" || result.code === "event_hash_divergence" ||
      result.code === "terminal_mismatch" ? 422 : 409;
    return json(result, status);
  }

  private checkpoint(streamId: string): CheckpointRow {
    return firstRow(this.ctx.storage.sql.exec<CheckpointRow>(
      "SELECT checkpoint, last_entry_hash, state_hash, terminal, entry_version, state_domain FROM shadow_checkpoint WHERE stream_id = ?", streamId,
    )) ?? { checkpoint: 0, last_entry_hash: null, state_hash: null, terminal: 0, entry_version: null, state_domain: null };
  }

  private ingest(entries: readonly ShadowJournalEntry[]): IngestSuccess | IngestFailure {
    return this.ctx.storage.transactionSync(() => {
      const streamId = entries[0]!.streamId;
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
        if (entry.cursor !== expectedCursor) return {
          ok: false,
          code: entry.cursor < expectedCursor ? "cursor_out_of_order" : "cursor_gap",
          checkpoint: checkpoint.checkpoint,
          expectedCursor,
          cursor: entry.cursor,
        };
        if (checkpoint.terminal === 1) return { ok: false, code: "terminal_state", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        if (entry.previousEntryHash !== checkpoint.last_entry_hash) return { ok: false, code: "hash_chain_mismatch", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        let actualHash: string;
        let actualTerminal: boolean;
        let actualEventHash: string | null = null;
        if (entry.v === SHADOW_JOURNAL_VERSION) {
          const transition = reduceGameplay(entry.beforeState, entry.command);
          actualHash = gameplayStateHash(transition.state);
          actualTerminal = !transition.state.alive;
        } else {
          const transition = reduceMovement(entry.beforeState, entry.command);
          actualHash = movementStateHash(transition.state);
          actualEventHash = movementEventHash(transition);
          actualTerminal = !transition.state.alive;
        }
        if (actualHash !== entry.afterStateHash) {
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO shadow_divergences (stream_id, cursor, entry_hash, expected_hash, actual_hash, detected_at) VALUES (?, ?, ?, ?, ?, unixepoch())",
            streamId, entry.cursor, entry.entryHash, entry.afterStateHash, actualHash,
          );
          return { ok: false, code: "state_hash_divergence", checkpoint: checkpoint.checkpoint, cursor: entry.cursor, expectedHash: entry.afterStateHash, actualHash };
        }
        if (entry.v !== SHADOW_JOURNAL_VERSION) {
          if (actualEventHash === null) throw new Error("movement replay omitted event hash");
          if (actualEventHash !== entry.eventHash) {
            this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO shadow_divergences (stream_id, cursor, entry_hash, expected_hash, actual_hash, detected_at) VALUES (?, ?, ?, ?, ?, unixepoch())",
              streamId, entry.cursor, entry.entryHash, entry.eventHash, actualEventHash,
            );
            return { ok: false, code: "event_hash_divergence", checkpoint: checkpoint.checkpoint, cursor: entry.cursor, expectedHash: entry.eventHash, actualHash: actualEventHash };
          }
        }
        if (entry.terminal !== actualTerminal) return { ok: false, code: "terminal_mismatch", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        this.ctx.storage.sql.exec(
          "INSERT INTO shadow_entries (stream_id, cursor, entry_hash, entry_version, before_state_hash, after_state_hash, event_hash, terminal, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())",
          streamId, entry.cursor, entry.entryHash, entry.v, entry.beforeStateHash, entry.afterStateHash,
          entry.v === SHADOW_JOURNAL_VERSION ? null : entry.eventHash, entry.terminal ? 1 : 0,
        );
        this.ctx.storage.sql.exec(`INSERT INTO shadow_checkpoint
          (stream_id, checkpoint, last_entry_hash, state_hash, terminal, entry_version, state_domain, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(stream_id) DO UPDATE SET checkpoint = excluded.checkpoint,
            last_entry_hash = excluded.last_entry_hash, state_hash = excluded.state_hash,
            terminal = excluded.terminal, entry_version = excluded.entry_version,
            state_domain = excluded.state_domain, updated_at = excluded.updated_at`,
          streamId, entry.cursor, entry.entryHash, actualHash, entry.terminal ? 1 : 0,
          entry.v, entry.v === SHADOW_JOURNAL_VERSION ? "vitals" : "movement",
        );
        checkpoint = {
          checkpoint: entry.cursor,
          last_entry_hash: entry.entryHash,
          state_hash: actualHash,
          terminal: entry.terminal ? 1 : 0,
          entry_version: entry.v,
          state_domain: entry.v === SHADOW_JOURNAL_VERSION ? "vitals" : "movement",
        };
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
