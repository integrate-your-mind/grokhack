import { MAX_SHADOW_BATCH_ENTRIES, type ShadowRoute } from "../src/shadow-journal.js";
import type { OriginGameplayJournal } from "./origin-journal.js";

export interface ShadowCatchupCheckpoint {
  streamId: string;
  checkpoint: number;
  accepted: number;
  duplicates: number;
  terminal: boolean;
  stateHash: string | null;
  entryVersion: 1 | 2 | null;
  stateDomain: "vitals" | "movement" | null;
}

export interface ShadowCatchupResult extends ShadowCatchupCheckpoint {
  batches: number;
  caughtUp: boolean;
  backpressured: boolean;
}

export class ShadowCatchupError extends Error {
  readonly status: number;
  readonly checkpoint: number;
  readonly code: string;

  constructor(status: number, checkpoint: number, code: string) {
    super(`shadow catch-up failed: ${code} (status ${status}, checkpoint ${checkpoint})`);
    this.name = "ShadowCatchupError";
    this.status = status;
    this.checkpoint = checkpoint;
    this.code = code;
  }
}

function parseCheckpoint(value: unknown): ShadowCatchupCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid shadow response");
  const candidate = value as Partial<ShadowCatchupCheckpoint>;
  const entryVersion = candidate.entryVersion ?? null;
  const stateDomain = candidate.stateDomain ?? null;
  if (typeof candidate.streamId !== "string" || !Number.isSafeInteger(candidate.checkpoint) ||
      Number(candidate.checkpoint) < 0 || !Number.isSafeInteger(candidate.accepted) ||
      !Number.isSafeInteger(candidate.duplicates) || typeof candidate.terminal !== "boolean" ||
      (candidate.stateHash !== null && (typeof candidate.stateHash !== "string" || !/^[0-9a-f]{16}$/u.test(candidate.stateHash))) ||
      (entryVersion !== null && entryVersion !== 1 && entryVersion !== 2) ||
      (stateDomain !== null && stateDomain !== "vitals" && stateDomain !== "movement") ||
      (entryVersion === null) !== (stateDomain === null) ||
      (entryVersion === 1 && stateDomain !== "vitals") ||
      (entryVersion === 2 && stateDomain !== "movement")) {
    throw new Error("invalid shadow response");
  }
  return { ...candidate, entryVersion, stateDomain } as ShadowCatchupCheckpoint;
}

export async function catchUpOriginJournal(options: {
  journal: Pick<OriginGameplayJournal, "readAfter">;
  streamId: string;
  route: ShadowRoute;
  endpoint: string;
  secret: string;
  cursor?: number;
  maxEntriesPerBatch?: number;
  maxBatches?: number;
  maxDurationMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<ShadowCatchupResult> {
  const limit = options.maxEntriesPerBatch ?? MAX_SHADOW_BATCH_ENTRIES;
  const maxBatches = options.maxBatches ?? 4;
  const maxDurationMs = options.maxDurationMs ?? 5_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SHADOW_BATCH_ENTRIES) throw new RangeError("invalid batch limit");
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new RangeError("invalid batch count");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60_000) throw new RangeError("invalid duration");
  if (new TextEncoder().encode(options.secret).byteLength < 32) throw new Error("shadow secret too short");
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let checkpoint = options.cursor ?? 0;
  let accepted = 0;
  let duplicates = 0;
  let batches = 0;
  let terminal = false;
  let stateHash: string | null = null;
  let entryVersion: 1 | 2 | null = null;
  let stateDomain: "vitals" | "movement" | null = null;
  for (; batches < maxBatches; batches++) {
    if (now() - startedAt >= maxDurationMs) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches, caughtUp: false, backpressured: true };
    }
    const entries = options.journal.readAfter(options.streamId, checkpoint, limit);
    if (!entries.length) return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches, caughtUp: true, backpressured: false };
    const response = await send(options.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, route: options.route, entries }),
    });
    const body = await response.json() as unknown;
    if (response.status === 429) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches, caughtUp: false, backpressured: true };
    }
    if (!response.ok) {
      const failure = body && typeof body === "object" ? body as { code?: unknown; checkpoint?: unknown } : {};
      throw new ShadowCatchupError(response.status, Number.isSafeInteger(failure.checkpoint) ? Number(failure.checkpoint) : checkpoint, typeof failure.code === "string" ? failure.code : "unknown_error");
    }
    const result = parseCheckpoint(body);
    const lastSent = entries.at(-1)!.cursor;
    if (result.streamId !== options.streamId || result.checkpoint < checkpoint || result.checkpoint > lastSent) {
      throw new Error("invalid shadow checkpoint advance");
    }
    checkpoint = result.checkpoint;
    accepted += result.accepted;
    duplicates += result.duplicates;
    terminal = result.terminal;
    stateHash = result.stateHash;
    entryVersion = result.entryVersion;
    stateDomain = result.stateDomain;
    if (terminal) return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches: batches + 1, caughtUp: true, backpressured: false };
  }
  const remaining = options.journal.readAfter(options.streamId, checkpoint, 1);
  return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches, caughtUp: remaining.length === 0, backpressured: remaining.length > 0 };
}
