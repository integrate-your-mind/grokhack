import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { dataPath } from "./data-paths.js";
import {
  createShadowJournalEntry,
  validateShadowJournalEntry,
  validateShadowRoute,
  type GameplayJournalInput,
  type MovementJournalInput,
  type ShadowJournalEntry,
  type ShadowJournalInput,
  type ShadowRoute,
} from "../src/shadow-journal.js";
import { movementContinuityHash, reduceMovement, type MovementAuthority } from "../src/movement-reducer.js";

export type JournalAppendResult =
  | { status: "appended"; entry: ShadowJournalEntry }
  | { status: "duplicate"; entry: ShadowJournalEntry };

interface StreamHead {
  cursor: number;
  entryHash: string;
  terminal: boolean;
}

const SEGMENT_ENTRIES = 64;
const AUTHORITY_REGISTRY_FILE = "_movement-authority-v1.json";
const MAX_AUTHORITY_RECORDS = 256;

interface MovementAuthorityRecord extends MovementAuthority {
  floorSeed: number;
  rotationId: string;
  rotationMode: "reuse" | "rotate";
}

interface MovementAuthorityRegistry {
  v: 1;
  floors: MovementAuthorityRecord[];
}

/** Non-secret character-run discriminator derived from the 256-bit resume credential. */
export function movementJournalRunId(resumeToken: string): string {
  if (!/^[0-9a-f]{64}$/iu.test(resumeToken)) throw new Error("invalid_movement_run");
  return createHash("sha256").update(resumeToken.toLowerCase(), "utf8").digest("hex").slice(0, 24);
}

/** Rotates the stream whenever the character run or routed floor authority changes. */
export function movementJournalStreamId(
  playerId: string,
  runId: string,
  authority: Readonly<MovementAuthority>,
): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(playerId)) {
    throw new Error("invalid_movement_stream");
  }
  if (!/^[0-9a-f]{24}$/u.test(runId)) throw new Error("invalid_movement_stream");
  let route: ShadowRoute;
  try {
    route = validateShadowRoute(authority);
  } catch {
    throw new Error("invalid_movement_stream");
  }
  const streamHash = createHash("sha256").update(JSON.stringify([
    playerId,
    runId,
    route.realmId,
    route.floorInstanceId,
    route.depth,
    route.floorEpoch,
    route.rulesetVersion,
  ])).digest("hex").slice(0, 48);
  return `movement_${streamHash}`;
}

export type OriginTransitionInput =
  | Omit<GameplayJournalInput, "cursor" | "previousEntryHash">
  | Omit<MovementJournalInput, "cursor" | "previousEntryHash">;

export interface OriginGameplayJournalOptions {
  /** Fault-injection seam used to prove pre/post-rename fsync recovery. */
  fsyncSync?: (descriptor: number) => void;
  /** Fault-injection seam used to prove short writes cannot truncate a segment. */
  writeSync?: (descriptor: number, buffer: Uint8Array, offset: number, length: number) => number;
}

export class OriginGameplayJournal {
  private readonly directory: string;
  private readonly heads = new Map<string, StreamHead>();
  private readonly fsyncSync: (descriptor: number) => void;
  private readonly writeSync: (descriptor: number, buffer: Uint8Array, offset: number, length: number) => number;
  private readonly pendingDirectorySyncs: string[] = [];

  constructor(directory = dataPath("shadow-journal"), options: OriginGameplayJournalOptions = {}) {
    this.directory = directory;
    this.fsyncSync = options.fsyncSync ?? fs.fsyncSync;
    this.writeSync = options.writeSync ?? ((descriptor, buffer, offset, length) =>
      fs.writeSync(descriptor, buffer, offset, length));
    let candidate = this.directory;
    while (!fs.existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      this.pendingDirectorySyncs.push(parent);
      candidate = parent;
    }
  }

  validateMovementAuthorityRegistry(): void {
    this.ensureDirectory();
    this.readAuthorityRegistry();
  }

  /**
   * Returns durable floor authority. Hydrated floors reuse their incarnation;
   * regenerated floors rotate synchronously before a command can be admitted.
   */
  movementAuthorityForFloor(input: {
    realmId: string;
    depth: number;
    floorSeed: number;
    rotate: boolean;
    rotationId: string;
  }): MovementAuthority {
    if (!Number.isSafeInteger(input.floorSeed) || input.floorSeed < 1 ||
        typeof input.rotationId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.rotationId)) {
      throw new Error("invalid_movement_authority");
    }
    const probe = validateShadowRoute({
      realmId: input.realmId,
      floorInstanceId: "authority-probe",
      depth: input.depth,
      floorEpoch: 1,
      rulesetVersion: 1,
    });
    this.ensureDirectory();
    const registry = this.readAuthorityRegistry();
    const index = registry.floors.findIndex((record) =>
      record.realmId === probe.realmId && record.depth === probe.depth);
    const existing = index >= 0 ? registry.floors[index] : undefined;
    if (existing && existing.rotationId === input.rotationId) {
      const mode = input.rotate ? "rotate" : "reuse";
      if (existing.floorSeed !== input.floorSeed || existing.rotationMode !== mode) {
        throw new Error("movement_authority_operation_reused");
      }
      // A prior rename may have committed even if its directory-fsync response
      // was lost. Re-sync before treating the same rotation retry as durable.
      this.syncDirectory(this.directory);
      return this.authorityFromRecord(existing);
    }
    const mustRotate = !existing || input.rotate || existing.floorSeed !== input.floorSeed;
    if (!mustRotate && existing) return this.authorityFromRecord(existing);
    if (!existing && registry.floors.length >= MAX_AUTHORITY_RECORDS) {
      throw new Error("movement_authority_capacity");
    }
    const floorEpoch = existing ? existing.floorEpoch + 1 : 1;
    if (!Number.isSafeInteger(floorEpoch)) throw new Error("movement_authority_epoch_exhausted");
    const record: MovementAuthorityRecord = {
      realmId: probe.realmId,
      floorInstanceId: randomUUID(),
      depth: probe.depth,
      floorEpoch,
      rulesetVersion: 1,
      floorSeed: input.floorSeed,
      rotationId: input.rotationId,
      rotationMode: input.rotate ? "rotate" : "reuse",
    };
    validateShadowRoute(record);
    if (index >= 0) registry.floors[index] = record;
    else registry.floors.push(record);
    registry.floors.sort((left, right) => {
      if (left.realmId === right.realmId) return left.depth - right.depth;
      return left.realmId < right.realmId ? -1 : 1;
    });
    this.replaceFileDurably(
      path.join(this.directory, AUTHORITY_REGISTRY_FILE),
      Buffer.from(`${JSON.stringify(registry)}\n`, "utf8"),
    );
    return this.authorityFromRecord(record);
  }

  appendTransition(input: OriginTransitionInput): JournalAppendResult {
    const head = this.head(input.streamId);
    if (head.cursor > 0) {
      const last = this.entryAt(input.streamId, head.cursor);
      const retry = createShadowJournalEntry({
        ...input,
        cursor: head.cursor,
        previousEntryHash: last?.previousEntryHash ?? null,
      } as ShadowJournalInput);
      if (last?.entryHash === retry.entryHash) return { status: "duplicate", entry: last };
    }
    return this.append(createShadowJournalEntry({
      ...input,
      cursor: head.cursor + 1,
      previousEntryHash: head.cursor === 0 ? null : head.entryHash,
    } as ShadowJournalInput));
  }

  append(entry: ShadowJournalEntry): JournalAppendResult {
    const validated = validateShadowJournalEntry(entry);
    const head = this.head(validated.streamId);
    if (head.terminal) throw new Error("journal_terminal_stream");
    if (validated.cursor <= head.cursor) {
      const existing = this.entryAt(validated.streamId, validated.cursor);
      if (existing?.entryHash === validated.entryHash) return { status: "duplicate", entry: existing };
      throw new Error("journal_cursor_conflict");
    }
    if (validated.cursor !== head.cursor + 1) throw new Error("journal_cursor_gap");
    if (validated.previousEntryHash !== (head.cursor === 0 ? null : head.entryHash)) throw new Error("journal_hash_chain_mismatch");
    const previousEntry = head.cursor > 0 ? this.entryAt(validated.streamId, head.cursor) : undefined;
    if (head.cursor > 0 && !previousEntry) throw new Error("journal_missing_segment");
    if (validated.v === 1 && previousEntry?.v === 2) {
      throw new Error("journal_state_domain_regression");
    }
    if (validated.v === 2 && previousEntry?.v === 2) {
      const previousTransition = reduceMovement(previousEntry.beforeState, previousEntry.command);
      if (previousTransition.turnCost === "none" &&
          movementContinuityHash(previousTransition.state) !== validated.beforeContinuityHash) {
        throw new Error("journal_state_continuity_mismatch");
      }
    }
    this.ensureDirectory();
    const file = this.fileFor(validated.streamId, this.segmentFor(validated.cursor));
    const previousContents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    try {
      this.replaceFileDurably(file, Buffer.from(`${previousContents}${JSON.stringify(validated)}\n`, "utf8"));
    } catch (error) {
      // Rename may have committed even when the directory fsync response was
      // lost. Re-read canonical state on retry instead of trusting stale memory.
      this.heads.delete(validated.streamId);
      throw error;
    }
    this.heads.set(validated.streamId, { cursor: validated.cursor, entryHash: validated.entryHash, terminal: validated.terminal });
    return { status: "appended", entry: validated };
  }

  readAfter(streamId: string, cursor: number, limit: number): ShadowJournalEntry[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("invalid cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid limit");
    this.assertStreamId(streamId);
    const head = this.head(streamId);
    if (cursor >= head.cursor) return [];
    const result: ShadowJournalEntry[] = [];
    let segment = this.segmentFor(cursor + 1);
    while (result.length < limit) {
      const entries = this.readSegment(streamId, segment);
      for (const entry of entries) {
        if (entry.cursor > cursor) result.push(entry);
        if (result.length === limit) return result;
      }
      if (entries.length < SEGMENT_ENTRIES) break;
      segment++;
    }
    const expected = Math.min(limit, head.cursor - cursor);
    if (result.length !== expected) throw new Error("journal_missing_segment");
    return result;
  }

  private head(streamId: string): StreamHead {
    this.assertStreamId(streamId);
    const cached = this.heads.get(streamId);
    if (cached) return cached;
    this.ensureDirectory();
    const prefix = `${streamId}.`;
    const segments = fs.readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && /^.+\.[0-9]{8}\.jsonl$/u.test(name))
      .map((name) => Number(name.slice(prefix.length, prefix.length + 8)))
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    if (!segments.length) {
      const empty = { cursor: 0, entryHash: "", terminal: false };
      this.heads.set(streamId, empty);
      return empty;
    }
    const latestSegment = segments.at(-1)!;
    if (segments.some((value, index) => value !== index)) throw new Error("journal_missing_segment");
    const entries = this.readSegment(streamId, latestSegment);
    if (!entries.length) throw new Error("journal_empty_segment");
    const firstExpected = latestSegment * SEGMENT_ENTRIES + 1;
    if (entries[0]!.cursor !== firstExpected) throw new Error("journal_corrupt_sequence");
    for (let index = 1; index < entries.length; index++) {
      if (entries[index]!.cursor !== entries[index - 1]!.cursor + 1 ||
          entries[index]!.previousEntryHash !== entries[index - 1]!.entryHash ||
          entries[index - 1]!.terminal) throw new Error("journal_corrupt_sequence");
    }
    if (latestSegment > 0) {
      const previous = this.readSegment(streamId, latestSegment - 1).at(-1);
      if (!previous || entries[0]!.previousEntryHash !== previous.entryHash || previous.terminal) throw new Error("journal_hash_chain_mismatch");
    } else if (entries[0]!.previousEntryHash !== null) {
      throw new Error("journal_hash_chain_mismatch");
    }
    const last = entries.at(-1)!;
    const cursor = last.cursor;
    const entryHash = last.entryHash;
    const terminal = last.terminal;
    const head = { cursor, entryHash, terminal };
    this.heads.set(streamId, head);
    return head;
  }

  private entryAt(streamId: string, cursor: number): ShadowJournalEntry | undefined {
    return this.readSegment(streamId, this.segmentFor(cursor)).find((entry) => entry.cursor === cursor);
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    while (this.pendingDirectorySyncs.length) {
      const directory = this.pendingDirectorySyncs[0]!;
      const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        this.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      this.pendingDirectorySyncs.shift();
    }
  }

  private syncDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      this.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private replaceFileDurably(file: string, payload: Uint8Array): void {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      let written = 0;
      while (written < payload.byteLength) {
        const count = this.writeSync(descriptor, payload, written, payload.byteLength - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > payload.byteLength - written) {
          throw new Error("journal_short_write");
        }
        written += count;
      }
      this.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      this.syncDirectory(this.directory);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original write/sync error */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original write/sync error */ }
      throw error;
    }
  }

  private readAuthorityRegistry(): MovementAuthorityRegistry {
    const file = path.join(this.directory, AUTHORITY_REGISTRY_FILE);
    if (!fs.existsSync(file)) return { v: 1, floors: [] };
    const metadata = fs.statSync(file);
    if (metadata.size > 256 * 1024) throw new Error("movement_authority_registry_too_large");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("movement_authority_registry_insecure_permissions");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("movement_authority_registry_corrupt");
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("movement_authority_registry_corrupt");
    }
    const value = candidate as { v?: unknown; floors?: unknown };
    if (value.v !== 1 || !Array.isArray(value.floors) || value.floors.length > MAX_AUTHORITY_RECORDS) {
      throw new Error("movement_authority_registry_corrupt");
    }
    const seen = new Set<string>();
    const floors: MovementAuthorityRecord[] = [];
    for (const candidateRecord of value.floors) {
      if (!candidateRecord || typeof candidateRecord !== "object" || Array.isArray(candidateRecord)) {
        throw new Error("movement_authority_registry_corrupt");
      }
      const record = candidateRecord as Partial<MovementAuthorityRecord>;
      if (!Number.isSafeInteger(record.floorSeed) || Number(record.floorSeed) < 1 ||
          typeof record.rotationId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(record.rotationId) ||
          (record.rotationMode !== "reuse" && record.rotationMode !== "rotate")) {
        throw new Error("movement_authority_registry_corrupt");
      }
      let authority: ShadowRoute;
      try { authority = validateShadowRoute(record); }
      catch { throw new Error("movement_authority_registry_corrupt"); }
      const key = `${authority.realmId}:${authority.depth}`;
      if (seen.has(key)) throw new Error("movement_authority_registry_corrupt");
      seen.add(key);
      floors.push({
        ...authority,
        floorSeed: Number(record.floorSeed),
        rotationId: record.rotationId,
        rotationMode: record.rotationMode,
      });
    }
    return { v: 1, floors };
  }

  private authorityFromRecord(record: MovementAuthorityRecord): MovementAuthority {
    return {
      realmId: record.realmId,
      floorInstanceId: record.floorInstanceId,
      depth: record.depth,
      floorEpoch: record.floorEpoch,
      rulesetVersion: record.rulesetVersion,
    };
  }

  private readSegment(streamId: string, segment: number): ShadowJournalEntry[] {
    const file = this.fileFor(streamId, segment);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.map((line) => validateShadowJournalEntry(JSON.parse(line) as unknown));
  }

  private fileFor(streamId: string, segment: number): string {
    this.assertStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    return path.join(this.directory, `${streamId}.${String(segment).padStart(8, "0")}.jsonl`);
  }

  private segmentFor(cursor: number): number {
    return Math.floor((Math.max(1, cursor) - 1) / SEGMENT_ENTRIES);
  }

  private assertStreamId(streamId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(streamId)) throw new Error("invalid_stream_id");
  }
}
