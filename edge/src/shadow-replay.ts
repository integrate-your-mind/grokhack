import { DurableObject } from "cloudflare:workers";

import { gameplayStateHash, reduceGameplay } from "../../src/gameplay-reducer";
import {
  MAX_SHADOW_BATCH_BYTES,
  MAX_SHADOW_BATCH_ENTRIES,
  validateShadowJournalEntry,
  type ShadowJournalEntry,
} from "../../src/shadow-journal";
import type { Env } from "./env";

interface CheckpointRow extends Record<string, SqlStorageValue> {
  checkpoint: number;
  last_entry_hash: string | null;
  state_hash: string | null;
  terminal: number;
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
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS shadow_entries (
        stream_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        entry_hash TEXT NOT NULL,
        before_state_hash TEXT NOT NULL,
        after_state_hash TEXT NOT NULL,
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
      ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of expansions) {
      if (!columns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE shadow_checkpoint ADD COLUMN ${name} ${definition}`);
    }
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO _shadow_schema_migrations (version, applied_at) VALUES (1, unixepoch())");
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
    const rawEntries = (candidate as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries) || rawEntries.length < 1) return json({ code: "invalid_batch" }, 400);
    if (rawEntries.length > MAX_SHADOW_BATCH_ENTRIES) return json({ code: "shadow_backpressure", limit: MAX_SHADOW_BATCH_ENTRIES }, 429);
    let entries: ShadowJournalEntry[];
    try { entries = rawEntries.map(validateShadowJournalEntry); } catch (error) {
      return json({ code: error instanceof Error ? error.message : "invalid_entry", checkpoint: 0 }, 400);
    }
    const streamId = entries[0]!.streamId;
    if (entries.some((entry) => entry.streamId !== streamId)) return json({ code: "mixed_stream_batch", checkpoint: 0 }, 400);
    const result = this.ingest(entries);
    if (result.ok) return json(result);
    const status = result.code === "state_hash_divergence" || result.code === "terminal_mismatch" ? 422 : 409;
    return json(result, status);
  }

  private checkpoint(streamId: string): CheckpointRow {
    return firstRow(this.ctx.storage.sql.exec<CheckpointRow>(
      "SELECT checkpoint, last_entry_hash, state_hash, terminal FROM shadow_checkpoint WHERE stream_id = ?", streamId,
    )) ?? { checkpoint: 0, last_entry_hash: null, state_hash: null, terminal: 0 };
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
        const transition = reduceGameplay(entry.beforeState, entry.command);
        const actualHash = gameplayStateHash(transition.state);
        if (actualHash !== entry.afterStateHash) {
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO shadow_divergences (stream_id, cursor, entry_hash, expected_hash, actual_hash, detected_at) VALUES (?, ?, ?, ?, ?, unixepoch())",
            streamId, entry.cursor, entry.entryHash, entry.afterStateHash, actualHash,
          );
          return { ok: false, code: "state_hash_divergence", checkpoint: checkpoint.checkpoint, cursor: entry.cursor, expectedHash: entry.afterStateHash, actualHash };
        }
        if (entry.terminal !== !transition.state.alive) return { ok: false, code: "terminal_mismatch", checkpoint: checkpoint.checkpoint, cursor: entry.cursor };
        this.ctx.storage.sql.exec(
          "INSERT INTO shadow_entries (stream_id, cursor, entry_hash, before_state_hash, after_state_hash, terminal, ingested_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())",
          streamId, entry.cursor, entry.entryHash, entry.beforeStateHash, entry.afterStateHash, entry.terminal ? 1 : 0,
        );
        this.ctx.storage.sql.exec(`INSERT INTO shadow_checkpoint
          (stream_id, checkpoint, last_entry_hash, state_hash, terminal, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(stream_id) DO UPDATE SET checkpoint = excluded.checkpoint,
            last_entry_hash = excluded.last_entry_hash, state_hash = excluded.state_hash,
            terminal = excluded.terminal, updated_at = excluded.updated_at`,
          streamId, entry.cursor, entry.entryHash, actualHash, entry.terminal ? 1 : 0,
        );
        checkpoint = { checkpoint: entry.cursor, last_entry_hash: entry.entryHash, state_hash: actualHash, terminal: entry.terminal ? 1 : 0 };
        accepted++;
      }
      return { ok: true, streamId, checkpoint: checkpoint.checkpoint, accepted, duplicates, terminal: checkpoint.terminal === 1, stateHash: checkpoint.state_hash };
    });
  }
}
