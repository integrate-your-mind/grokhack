import {
  MAX_SHADOW_BATCH_ENTRIES,
  type MovementTurnEnvelope,
  type ShadowJournalEntry,
  type ShadowRoute,
} from "../src/shadow-journal.js";

interface ShadowJournalReader {
  readAfter(streamId: string, cursor: number, limit: number): readonly ShadowJournalEntry[];
}

interface MovementTurnJournalReader {
  readMovementTurnsAfter(streamId: string, cursor: number, limit: number): readonly MovementTurnEnvelope[];
}

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

export interface MovementTurnCatchupCheckpoint {
  streamId: string;
  checkpoint: number;
  accepted: number;
  duplicates: number;
  terminal: boolean;
  lastEnvelopeHash: string | null;
  movementStateHash: string | null;
  turnStateHash: string | null;
}

export interface MovementTurnCatchupResult extends MovementTurnCatchupCheckpoint {
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

class ShadowCatchupDeadlineError extends Error {
  constructor() {
    super("shadow catch-up deadline exceeded");
    this.name = "ShadowCatchupDeadlineError";
  }
}

async function withinDeadline<T>(durationMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ShadowCatchupDeadlineError());
    }, Math.max(1, durationMs));
  });
  try {
    try {
      return await Promise.race([operation(controller.signal), deadline]);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ShadowCatchupDeadlineError)) {
        throw new ShadowCatchupDeadlineError();
      }
      throw error;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

function parseMovementTurnCheckpoint(value: unknown): MovementTurnCatchupCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid movement-turn shadow response");
  const candidate = value as Partial<MovementTurnCatchupCheckpoint>;
  const validHash = (hash: unknown) => hash === null || (typeof hash === "string" && /^[0-9a-f]{16}$/u.test(hash));
  if (typeof candidate.streamId !== "string" || !/^turn_[0-9a-f]{48}$/u.test(candidate.streamId) ||
      !Number.isSafeInteger(candidate.checkpoint) || Number(candidate.checkpoint) < 0 ||
      !Number.isSafeInteger(candidate.accepted) || Number(candidate.accepted) < 0 ||
      !Number.isSafeInteger(candidate.duplicates) || Number(candidate.duplicates) < 0 ||
      typeof candidate.terminal !== "boolean" || !validHash(candidate.lastEnvelopeHash) ||
      !validHash(candidate.movementStateHash) ||
      !validHash(candidate.turnStateHash)) {
    throw new Error("invalid movement-turn shadow response");
  }
  return candidate as MovementTurnCatchupCheckpoint;
}

function compactedMovementTurnCheckpoint(value: unknown, streamId: string, currentCheckpoint: number): MovementTurnResumeState {
  const checkpoint = parseMovementTurnCheckpoint(value);
  if (checkpoint.streamId !== streamId || checkpoint.accepted !== 0 || checkpoint.duplicates !== 0 ||
      checkpoint.checkpoint <= currentCheckpoint) {
    throw new Error("invalid movement-turn compacted checkpoint");
  }
  return checkpoint;
}

type MovementTurnResumeState = Pick<
  MovementTurnCatchupCheckpoint,
  "checkpoint" | "terminal" | "lastEnvelopeHash" | "movementStateHash" | "turnStateHash"
>;

function advanceMovementTurnResumeState(
  journal: MovementTurnJournalReader,
  streamId: string,
  initial: MovementTurnResumeState,
  targetCheckpoint: number,
): MovementTurnResumeState {
  let { checkpoint, terminal, lastEnvelopeHash, movementStateHash, turnStateHash } = initial;
  if (!Number.isSafeInteger(targetCheckpoint) || targetCheckpoint < checkpoint) {
    throw new RangeError("invalid resume cursor");
  }
  while (checkpoint < targetCheckpoint) {
    const remaining = targetCheckpoint - checkpoint;
    const page = journal.readMovementTurnsAfter(streamId, checkpoint, Math.min(MAX_SHADOW_BATCH_ENTRIES, remaining));
    if (page.length < 1) throw new RangeError("invalid resume cursor");
    for (const envelope of page) {
      if (envelope.cursor !== checkpoint + 1 || envelope.cursor > targetCheckpoint) {
        throw new RangeError("invalid resume cursor");
      }
      checkpoint = envelope.cursor;
      lastEnvelopeHash = envelope.envelopeHash;
      movementStateHash = envelope.movement.afterStateHash;
      if (envelope.turn) turnStateHash = envelope.turn.afterStateHash;
      terminal = envelope.turn?.terminal ?? envelope.movement.terminal;
    }
  }
  return { checkpoint, terminal, lastEnvelopeHash, movementStateHash, turnStateHash };
}

export async function catchUpOriginJournal(options: {
  journal: ShadowJournalReader;
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
  const requestedCursor = options.cursor ?? 0;
  if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) {
    throw new RangeError("invalid resume cursor");
  }
  if (requestedCursor > 0) {
    const proof = options.journal.readAfter(options.streamId, requestedCursor - 1, 1);
    if (proof[0]?.cursor !== requestedCursor) throw new RangeError("invalid resume cursor");
  }
  // A caller cursor is only a local hint. Re-submit its immutable entry so the
  // remote idempotency fence proves ownership before we report caught up.
  let checkpoint = requestedCursor > 0 ? requestedCursor - 1 : 0;
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
    const remainingMs = maxDurationMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, stateHash, entryVersion, stateDomain, batches, caughtUp: false, backpressured: true };
    }
    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await withinDeadline(remainingMs, async (signal) => {
        const result = await send(options.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ v: 1, route: options.route, entries }),
          signal,
        });
        return { response: result, body: await result.json() as unknown };
      }));
    } catch (error) {
      if (error instanceof ShadowCatchupDeadlineError) {
        throw new ShadowCatchupError(504, checkpoint, "shadow_timeout");
      }
      throw error;
    }
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

export async function catchUpMovementTurnJournal(options: {
  journal: MovementTurnJournalReader;
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
}): Promise<MovementTurnCatchupResult> {
  const limit = options.maxEntriesPerBatch ?? MAX_SHADOW_BATCH_ENTRIES;
  const maxBatches = options.maxBatches ?? 4;
  const maxDurationMs = options.maxDurationMs ?? 5_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SHADOW_BATCH_ENTRIES) throw new RangeError("invalid batch limit");
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new RangeError("invalid batch count");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60_000) throw new RangeError("invalid duration");
  if (!/^turn_[0-9a-f]{48}$/u.test(options.streamId)) throw new Error("invalid movement-turn stream");
  if (new TextEncoder().encode(options.secret).byteLength < 32) throw new Error("shadow secret too short");
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const requestedCursor = options.cursor ?? 0;
  if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) throw new RangeError("invalid resume cursor");
  if (requestedCursor > 0) {
    const proof = options.journal.readMovementTurnsAfter(options.streamId, requestedCursor - 1, 1);
    if (proof[0]?.cursor !== requestedCursor) throw new RangeError("invalid resume cursor");
  }
  const resumeState = advanceMovementTurnResumeState(
    options.journal,
    options.streamId,
    { checkpoint: 0, terminal: false, lastEnvelopeHash: null, movementStateHash: null, turnStateHash: null },
    Math.max(0, requestedCursor - 1),
  );
  let checkpoint = resumeState.checkpoint;
  let accepted = 0;
  let duplicates = 0;
  let batches = 0;
  let terminal = resumeState.terminal;
  let lastEnvelopeHash: string | null = resumeState.lastEnvelopeHash;
  let movementStateHash: string | null = resumeState.movementStateHash;
  let turnStateHash: string | null = resumeState.turnStateHash;
  for (; batches < maxBatches; batches++) {
    if (now() - startedAt >= maxDurationMs) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches, caughtUp: false, backpressured: true };
    }
    const envelopes = options.journal.readMovementTurnsAfter(options.streamId, checkpoint, limit);
    if (!envelopes.length) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches, caughtUp: true, backpressured: false };
    }
    const remainingMs = maxDurationMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches, caughtUp: false, backpressured: true };
    }
    let response: Response;
    let body: unknown;
    try {
      ({ response, body } = await withinDeadline(remainingMs, async (signal) => {
        const result = await send(options.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ v: 1, route: options.route, envelopes }),
          signal,
        });
        return { response: result, body: await result.json() as unknown };
      }));
    } catch (error) {
      if (error instanceof ShadowCatchupDeadlineError) throw new ShadowCatchupError(504, checkpoint, "shadow_timeout");
      throw error;
    }
    if (response.status === 429) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches, caughtUp: false, backpressured: true };
    }
    if (!response.ok) {
      const failure = body && typeof body === "object" ? body as { code?: unknown; checkpoint?: unknown } : {};
      if (response.status === 409 && failure.code === "cursor_compacted") {
        let acknowledged: MovementTurnResumeState;
        try {
          const remote = compactedMovementTurnCheckpoint(body, options.streamId, checkpoint);
          acknowledged = advanceMovementTurnResumeState(
            options.journal,
            options.streamId,
            { checkpoint, terminal, lastEnvelopeHash, movementStateHash, turnStateHash },
            remote.checkpoint,
          );
          if (acknowledged.terminal !== remote.terminal ||
              acknowledged.lastEnvelopeHash !== remote.lastEnvelopeHash ||
              acknowledged.movementStateHash !== remote.movementStateHash ||
              acknowledged.turnStateHash !== remote.turnStateHash) {
            throw new Error("checkpoint proof mismatch");
          }
        } catch {
          throw new Error("invalid movement-turn compacted checkpoint");
        }
        checkpoint = acknowledged.checkpoint;
        terminal = acknowledged.terminal;
        lastEnvelopeHash = acknowledged.lastEnvelopeHash;
        movementStateHash = acknowledged.movementStateHash;
        turnStateHash = acknowledged.turnStateHash;
        if (terminal) {
          return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches: batches + 1, caughtUp: true, backpressured: false };
        }
        continue;
      }
      throw new ShadowCatchupError(response.status, Number.isSafeInteger(failure.checkpoint) ? Number(failure.checkpoint) : checkpoint, typeof failure.code === "string" ? failure.code : "unknown_error");
    }
    const result = parseMovementTurnCheckpoint(body);
    const lastSent = envelopes.at(-1)!.cursor;
    let acknowledged: MovementTurnResumeState;
    try {
      acknowledged = advanceMovementTurnResumeState(
        options.journal,
        options.streamId,
        { checkpoint, terminal, lastEnvelopeHash, movementStateHash, turnStateHash },
        result.checkpoint,
      );
    } catch {
      throw new Error("invalid movement-turn shadow checkpoint advance");
    }
    if (result.streamId !== options.streamId || result.checkpoint < lastSent ||
        result.accepted + result.duplicates !== envelopes.length ||
        result.lastEnvelopeHash !== acknowledged.lastEnvelopeHash ||
        result.movementStateHash !== acknowledged.movementStateHash ||
        result.turnStateHash !== acknowledged.turnStateHash || result.terminal !== acknowledged.terminal) {
      throw new Error("invalid movement-turn shadow checkpoint advance");
    }
    checkpoint = result.checkpoint;
    accepted += result.accepted;
    duplicates += result.duplicates;
    terminal = result.terminal;
    lastEnvelopeHash = result.lastEnvelopeHash;
    movementStateHash = result.movementStateHash;
    turnStateHash = result.turnStateHash;
    if (terminal) {
      return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches: batches + 1, caughtUp: true, backpressured: false };
    }
  }
  const remaining = options.journal.readMovementTurnsAfter(options.streamId, checkpoint, 1);
  return { streamId: options.streamId, checkpoint, accepted, duplicates, terminal, lastEnvelopeHash, movementStateHash, turnStateHash, batches, caughtUp: remaining.length === 0, backpressured: remaining.length > 0 };
}
