import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

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
  | { status: "duplicate"; entry: ShadowJournalEntry }
  | {
      status: "dropped_capacity";
      domain: "vitals" | "movement";
      maxEntries: number;
    };

interface StreamHead {
  cursor: number;
  entryHash: string;
  terminal: boolean;
  lastEntry?: ShadowJournalEntry;
}

interface WriterOwner {
  pid: number;
  ownerId: string;
  ownerFileName: string;
  processStartId?: string;
}

function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/u) : [];
      const startTime = fields[19];
      if (startTime && /^[0-9]+$/u.test(startTime)) return `linux-proc:${startTime}`;
    } catch { /* fall through to the portable process query */ }
  }
  if (process.platform === "win32") return null;
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return started && started.length <= 96 ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

const SEGMENT_ENTRIES = 64;
const AUTHORITY_REGISTRY_FILE = "_movement-authority-v1.json";
const MOVEMENT_EVIDENCE_DIRECTORY = "movement-v2";
const JOURNAL_WRITER_FILE = ".origin-journal-writer-v1.lock";
const JOURNAL_WRITER_RECOVERY_FILE = ".origin-journal-writer-recovery-v1.lock";
const JOURNAL_COMMIT_MIGRATION_FILE = ".origin-journal-commit-sidecars-v1";
const JOURNAL_COMMIT_SUFFIX = ".commits";
const JOURNAL_WRITE_SEQUENCE_FILE = ".origin-journal-write-sequence-v1";
const MAX_AUTHORITY_RECORDS = 256;
export const MAX_GAMEPLAY_EVIDENCE_ENTRIES = 4_096;
export const MAX_MOVEMENT_EVIDENCE_ENTRIES = 4_096;
export const MAX_MOVEMENT_EVIDENCE_ENTRY_BYTES = 8 * 1024;
const MAX_JOURNAL_SEGMENT_BYTES = SEGMENT_ENTRIES * MAX_MOVEMENT_EVIDENCE_ENTRY_BYTES;
const MAX_EVIDENCE_FILES = MAX_GAMEPLAY_EVIDENCE_ENTRIES + MAX_MOVEMENT_EVIDENCE_ENTRIES;
const JOURNAL_WRITER_MAX_BYTES = 4 * 1024;
const JOURNAL_READER_RETRY_ATTEMPTS = 200;
const JOURNAL_READER_RETRY_DELAY_MS = 5;
const PROCESS_WRITER_ID = randomUUID();
const PROCESS_WRITER_START_ID = processStartIdentity(process.pid);

interface SharedEvidenceState {
  v: 1;
  gameplayEntries: number;
  movementEntries: number;
  valid: boolean;
  recoveryFiles: Set<string>;
  heads: Map<string, StreamHead>;
  writeSequence: number;
}

const sharedEvidenceByDirectory = new Map<string, SharedEvidenceState>();

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
  /** Fault/interleaving seam used to prove online readers take a stable prefix. */
  readFileSync?: (file: string) => Buffer;
  /** Global retained V2 evidence ceiling. Primarily configurable for focused tests. */
  maxMovementEntries?: number;
  /** Global retained V1 evidence ceiling. Primarily configurable for focused tests. */
  maxGameplayEntries?: number;
}

export class OriginGameplayJournal {
  private readonly directory: string;
  private heads = new Map<string, StreamHead>();
  private evidenceState?: SharedEvidenceState;
  private readonly fsyncSync: (descriptor: number) => void;
  private readonly writeSync: (descriptor: number, buffer: Uint8Array, offset: number, length: number) => number;
  private readonly readFileSync: (file: string) => Buffer;
  private readonly maxMovementEntries: number;
  private readonly maxGameplayEntries: number;
  private readonly pendingDirectorySyncs: string[] = [];
  private sequenceDirectoryEntryDurable = false;

  constructor(directory = dataPath("shadow-journal"), options: OriginGameplayJournalOptions = {}) {
    this.directory = directory;
    this.fsyncSync = options.fsyncSync ?? fs.fsyncSync;
    this.writeSync = options.writeSync ?? ((descriptor, buffer, offset, length) =>
      fs.writeSync(descriptor, buffer, offset, length));
    this.readFileSync = options.readFileSync ?? ((file) => fs.readFileSync(file));
    this.maxMovementEntries = options.maxMovementEntries ?? MAX_MOVEMENT_EVIDENCE_ENTRIES;
    this.maxGameplayEntries = options.maxGameplayEntries ?? MAX_GAMEPLAY_EVIDENCE_ENTRIES;
    if (!Number.isSafeInteger(this.maxMovementEntries) || this.maxMovementEntries < 1 ||
        this.maxMovementEntries > MAX_MOVEMENT_EVIDENCE_ENTRIES) {
      throw new Error("invalid_movement_evidence_capacity");
    }
    if (!Number.isSafeInteger(this.maxGameplayEntries) || this.maxGameplayEntries < 1 ||
        this.maxGameplayEntries > MAX_GAMEPLAY_EVIDENCE_ENTRIES) {
      throw new Error("invalid_gameplay_evidence_capacity");
    }
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
    this.ensureEvidenceState();
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
    const version = input.command.type === "advance_turn" ? 1 : 2;
    const capacity = this.capacityResult(version);
    if (capacity) {
      const last = this.heads.get(input.streamId)?.lastEntry;
      if (last) {
        const retry = createShadowJournalEntry({
          ...input,
          cursor: last.cursor,
          previousEntryHash: last.previousEntryHash,
        } as ShadowJournalInput);
        if (last.entryHash === retry.entryHash) return { status: "duplicate", entry: last };
      }
      return capacity;
    }
    const head = this.head(input.streamId);
    if (head.cursor > 0) {
      const last = head.lastEntry;
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
    const capacity = this.capacityResult(validated.v);
    if (capacity) {
      const last = this.heads.get(validated.streamId)?.lastEntry;
      if (last?.entryHash === validated.entryHash) return { status: "duplicate", entry: last };
      return capacity;
    }
    const head = this.head(validated.streamId);
    if (head.terminal) throw new Error("journal_terminal_stream");
    if (validated.cursor <= head.cursor) {
      const existing = this.entryAt(validated.streamId, validated.cursor);
      if (existing?.entryHash === validated.entryHash) return { status: "duplicate", entry: existing };
      throw new Error("journal_cursor_conflict");
    }
    if (validated.cursor !== head.cursor + 1) throw new Error("journal_cursor_gap");
    if (validated.previousEntryHash !== (head.cursor === 0 ? null : head.entryHash)) throw new Error("journal_hash_chain_mismatch");
    const previousEntry = head.lastEntry;
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
    const payload = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (payload.byteLength > MAX_MOVEMENT_EVIDENCE_ENTRY_BYTES) {
      throw new Error("journal_entry_too_large");
    }
    const evidence = this.ensureEvidenceState();
    this.beginJournalWrite(evidence);
    let file: string;
    try {
      this.ensureDirectory();
      if (validated.v === 2) this.ensureMovementDirectory();
      file = this.fileFor(validated.streamId, this.segmentFor(validated.cursor), validated.v);
      try {
        this.ensureCommitFile(file);
        this.appendFileDurably(file, payload);
        this.appendCommitDurably(file);
      } catch (error) {
        // A write or sync may have committed even when its acknowledgement was
        // lost. Re-read and re-sync canonical state on retry.
        this.heads.delete(validated.streamId);
        this.invalidateAndReconcileEvidence(file);
        throw error;
      }
      if (validated.v === 2) evidence.movementEntries++;
      else evidence.gameplayEntries++;
      this.heads.set(validated.streamId, {
        cursor: validated.cursor,
        entryHash: validated.entryHash,
        terminal: validated.terminal,
        lastEntry: validated,
      });
      return { status: "appended", entry: validated };
    } finally {
      // A failed commit is not safe to publish until reconciliation has
      // re-established and re-synced the canonical committed prefix. Leave an
      // odd sequence fence in place when recovery itself fails; the next
      // writer (or restart) must recover before readers may proceed.
      if (evidence.valid) this.endJournalWrite(evidence);
    }
  }

  readAfter(streamId: string, cursor: number, limit: number): ShadowJournalEntry[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("invalid cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid limit");
    this.assertStreamId(streamId);
    let lastError: unknown;
    for (let attempt = 0; attempt < JOURNAL_READER_RETRY_ATTEMPTS; attempt++) {
      const before = this.readWriteSequenceToken();
      if (before?.active) {
        // A synchronous reader cannot wait for this process's current write to
        // finish without deadlocking its own event loop.
        if (before.ownerId === PROCESS_WRITER_ID) throw new Error("journal_writer_busy");
        this.waitForWriter();
        continue;
      }
      // Heads cached by an online catch-up reader can become stale between
      // separate pages. Always rebuild the bounded disk head inside the same
      // sequence snapshot used for the returned rows.
      this.heads.delete(streamId);
      try {
        const result = this.readAfterSnapshot(streamId, cursor, limit);
        const after = this.readWriteSequenceToken();
        if (before?.token === after?.token && !after?.active) return result;
      } catch (error) {
        lastError = error;
        const after = this.readWriteSequenceToken();
        if (before?.token === after?.token && !after?.active) throw error;
      }
      this.waitForWriter();
    }
    throw new Error("journal_writer_busy", { cause: lastError });
  }

  private readAfterSnapshot(streamId: string, cursor: number, limit: number): ShadowJournalEntry[] {
    const head = this.head(streamId, false);
    if (cursor >= head.cursor) return [];
    const result: ShadowJournalEntry[] = [];
    let segment = this.segmentFor(cursor + 1);
    while (result.length < limit) {
      const entries = this.readSegment(streamId, segment, false);
      for (const entry of entries) {
        if (entry.cursor > cursor && entry.cursor <= head.cursor) result.push(entry);
        if (result.length === limit) return result;
      }
      if (entries.length < SEGMENT_ENTRIES) break;
      segment++;
    }
    const expected = Math.min(limit, head.cursor - cursor);
    if (result.length !== expected) throw new Error("journal_missing_segment");
    return result;
  }

  private head(streamId: string, repair = true): StreamHead {
    this.assertStreamId(streamId);
    const cached = this.heads.get(streamId);
    if (cached) return cached;
    this.ensureDirectory();
    const segments = this.boundedSegments(streamId);
    if (!segments.length) {
      const empty = { cursor: 0, entryHash: "", terminal: false };
      this.heads.set(streamId, empty);
      return empty;
    }
    let latestSegment = segments.at(-1)!;
    if (segments.some((value, index) => value !== index)) throw new Error("journal_missing_segment");
    let entries = this.readSegment(streamId, latestSegment, repair);
    if (!entries.length) {
      if (repair && this.removeEmptySegmentFiles(streamId, latestSegment)) {
        return this.head(streamId);
      }
      if (repair) throw new Error("journal_empty_segment");
      if (latestSegment === 0) return { cursor: 0, entryHash: "", terminal: false };
      latestSegment--;
      entries = this.readSegment(streamId, latestSegment, false);
      if (!entries.length) throw new Error("journal_empty_segment");
    }
    // A prior append may have written the complete record before losing its
    // fsync acknowledgement. A cold head always re-syncs the canonical tail
    // before an exact retry can be treated as durable.
    if (repair) this.syncSegmentFiles(streamId, latestSegment);
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
    const head = { cursor, entryHash, terminal, lastEntry: last };
    this.heads.set(streamId, head);
    return head;
  }

  private entryAt(streamId: string, cursor: number): ShadowJournalEntry | undefined {
    return this.readSegment(streamId, this.segmentFor(cursor)).find((entry) => entry.cursor === cursor);
  }

  private ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const metadata = fs.lstatSync(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("journal_directory_insecure");
    }
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

  private ensureMovementDirectory(): void {
    this.ensureDirectory();
    const directory = this.movementDirectory();
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      this.syncDirectory(this.directory);
    }
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("movement_evidence_directory_insecure");
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
      this.syncDirectory(path.dirname(file));
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original write/sync error */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original write/sync error */ }
      throw error;
    }
  }

  private appendFileDurably(file: string, payload: Uint8Array): void {
    const existed = fs.existsSync(file);
    let descriptor: number | undefined;
    let fileSynced = false;
    try {
      descriptor = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("journal_insecure_file");
      }
      let written = 0;
      while (written < payload.byteLength) {
        const count = this.writeSync(descriptor, payload, written, payload.byteLength - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > payload.byteLength - written) {
          throw new Error("journal_short_write");
        }
        written += count;
      }
      this.fsyncSync(descriptor);
      fileSynced = true;
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (!existed) this.syncDirectory(path.dirname(file));
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original write/sync error */ }
      }
      if (!existed && !fileSynced) {
        try {
          fs.rmSync(file, { force: true });
          this.syncDirectory(path.dirname(file));
        } catch { /* recovery on the next read still rejects or repairs the file */ }
      }
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

  private readSegment(streamId: string, segment: number, repair = true): ShadowJournalEntry[] {
    const entries = this.segmentFilesFor(streamId, segment)
      .flatMap((file) => this.readCommittedJournalFile(file, repair))
      .sort((left, right) => left.cursor - right.cursor);
    if (entries.length > SEGMENT_ENTRIES) throw new Error("journal_corrupt_sequence");
    for (let index = 1; index < entries.length; index++) {
      if (entries[index]!.cursor === entries[index - 1]!.cursor) {
        throw new Error("journal_cursor_conflict");
      }
    }
    return entries;
  }

  private readJournalFile(file: string, repair = true): ShadowJournalEntry[] {
    const metadata = fs.statSync(file);
    if (metadata.size > MAX_JOURNAL_SEGMENT_BYTES) throw new Error("journal_segment_too_large");
    if (!metadata.isFile() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("journal_insecure_file");
    }
    let payload = this.readFileSync(file);
    if (payload.byteLength > 0 && payload[payload.byteLength - 1] !== 0x0a) {
      const lastNewline = payload.lastIndexOf(0x0a);
      const durableLength = lastNewline < 0 ? 0 : lastNewline + 1;
      if (repair) {
        const descriptor = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          fs.ftruncateSync(descriptor, durableLength);
          this.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      payload = payload.subarray(0, durableLength);
    }
    if (payload.byteLength === 0) return [];
    return payload.toString("utf8").split("\n").filter(Boolean)
      .map((line) => {
        if (Buffer.byteLength(line, "utf8") + 1 > MAX_MOVEMENT_EVIDENCE_ENTRY_BYTES) {
          throw new Error("journal_entry_too_large");
        }
        return validateShadowJournalEntry(JSON.parse(line) as unknown);
      });
  }

  private readCommittedJournalFile(
    file: string,
    repair: boolean,
    migrateMissing = false,
  ): ShadowJournalEntry[] {
    const commitFile = this.commitFileFor(file);
    if (!repair && fs.existsSync(commitFile)) {
      // Capture visibility before data. A concurrent writer always fsyncs the
      // JSONL record before advancing this count, so this snapshot may lag but
      // can never lead the subsequently captured data.
      const committed = this.readCommitCount(commitFile);
      const entries = this.readJournalFile(file, false);
      if (committed > entries.length) throw new Error("journal_commit_sidecar_corrupt");
      return entries.slice(0, committed);
    }
    const entries = this.readJournalFile(file, repair);
    let committed: number;
    if (fs.existsSync(commitFile)) {
      committed = this.readCommitCount(commitFile);
    } else if (migrateMissing) {
      this.replaceFileDurably(commitFile, Buffer.alloc(entries.length, 0x0a));
      committed = entries.length;
    } else if (!repair && !this.commitSidecarsMigrated()) {
      // Before the one-time writer migration, newline-complete historical
      // entries are the only available stable prefix.
      committed = entries.length;
    } else {
      throw new Error("journal_commit_sidecar_missing");
    }
    if (committed > entries.length) throw new Error("journal_commit_sidecar_corrupt");
    if (repair && entries.length > committed) {
      this.truncateJournalToLineCount(file, committed);
    }
    return entries.slice(0, committed);
  }

  private appendCommitDurably(file: string): void {
    const commitFile = this.commitFileFor(file);
    const committed = fs.existsSync(commitFile) ? this.readCommitCount(commitFile) : 0;
    if (committed >= SEGMENT_ENTRIES) throw new Error("journal_commit_sidecar_corrupt");
    this.appendFileDurably(commitFile, Buffer.from("\n", "utf8"));
  }

  private ensureCommitFile(file: string): void {
    const commitFile = this.commitFileFor(file);
    if (fs.existsSync(commitFile)) {
      this.readCommitCount(commitFile);
      return;
    }
    this.replaceFileDurably(commitFile, Buffer.alloc(0));
  }

  private readCommitCount(file: string): number {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > SEGMENT_ENTRIES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("journal_commit_sidecar_corrupt");
    }
    const payload = this.readFileSync(file);
    if (payload.some((byte) => byte !== 0x0a)) throw new Error("journal_commit_sidecar_corrupt");
    return payload.byteLength;
  }

  private truncateJournalToLineCount(file: string, lineCount: number): void {
    const payload = fs.readFileSync(file);
    let seen = 0;
    let durableLength = 0;
    for (let index = 0; index < payload.byteLength && seen < lineCount; index++) {
      if (payload[index] === 0x0a) {
        seen++;
        durableLength = index + 1;
      }
    }
    if (seen !== lineCount) throw new Error("journal_commit_sidecar_corrupt");
    const descriptor = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      fs.ftruncateSync(descriptor, durableLength);
      this.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.syncDirectory(path.dirname(file));
  }

  private commitSidecarsMigrated(): boolean {
    const file = path.join(this.directory, JOURNAL_COMMIT_MIGRATION_FILE);
    if (!fs.existsSync(file)) return false;
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 3 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
        fs.readFileSync(file, "utf8") !== "v1\n") {
      throw new Error("journal_commit_migration_corrupt");
    }
    return true;
  }

  private commitFileFor(file: string): string {
    return `${file}${JOURNAL_COMMIT_SUFFIX}`;
  }

  private beginJournalWrite(state: SharedEvidenceState): void {
    if (state.writeSequence % 2 !== 0) throw new Error("journal_writer_reentrant");
    const next = state.writeSequence + 1;
    this.writeSequenceToken(next, true);
    state.writeSequence = next;
  }

  private endJournalWrite(state: SharedEvidenceState): void {
    if (state.writeSequence % 2 !== 1) throw new Error("journal_writer_sequence_corrupt");
    const next = state.writeSequence + 1;
    // The evidence and commit byte are already durable. The even token only
    // publishes that stable prefix to live readers; if it is lost in a crash,
    // the durable odd token remains fail-closed until writer recovery.
    this.writeSequenceToken(next, false);
    state.writeSequence = next;
  }

  private writeSequenceToken(sequence: number, durable: boolean): void {
    const file = path.join(this.directory, JOURNAL_WRITE_SEQUENCE_FILE);
    const payload = Buffer.from(`${PROCESS_WRITER_ID}:${sequence}\n`, "utf8");
    const directorySyncRequired = !fs.existsSync(file) || !this.sequenceDirectoryEntryDurable;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("journal_write_sequence_corrupt");
      }
      let written = 0;
      while (written < payload.byteLength) {
        const count = fs.writeSync(descriptor, payload, written, payload.byteLength - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > payload.byteLength - written) {
          throw new Error("journal_write_sequence_corrupt");
        }
        written += count;
      }
      if (durable) fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (durable && directorySyncRequired) {
        this.syncDirectoryUninjected(this.directory);
        this.sequenceDirectoryEntryDurable = true;
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  private readWriteSequenceToken(): { token: string; active: boolean; ownerId: string | null } | null {
    const file = path.join(this.directory, JOURNAL_WRITE_SEQUENCE_FILE);
    if (!fs.existsSync(file)) return null;
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("journal_write_sequence_corrupt");
    }
    const payload = fs.readFileSync(file, "utf8");
    const match = /^([0-9a-f-]{36}):([0-9]+)\n$/u.exec(payload);
    if (!match) return { token: `unstable:${payload}`, active: true, ownerId: null };
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("journal_write_sequence_corrupt");
    }
    return { token: `${match[1]}:${sequence}`, active: sequence % 2 === 1, ownerId: match[1]! };
  }

  private waitForWriter(): void {
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      JOURNAL_READER_RETRY_DELAY_MS,
    );
  }

  private capacityResult(version: 1 | 2): Extract<JournalAppendResult, { status: "dropped_capacity" }> | null {
    const evidence = this.ensureEvidenceState();
    const maxEntries = version === 2 ? this.maxMovementEntries : this.maxGameplayEntries;
    const entries = version === 2 ? evidence.movementEntries : evidence.gameplayEntries;
    if (entries < maxEntries) return null;
    return {
      status: "dropped_capacity",
      domain: version === 2 ? "movement" : "vitals",
      maxEntries,
    };
  }

  /**
   * The journal is intentionally a single-writer component. Every instance in
   * this process shares one canonical inventory, while a durable owner record
   * rejects a second live process. The hot path writes only the new record and
   * one commit byte, while capacity accounting derives from canonical evidence
   * instead of a separately fallible counter.
   */
  private ensureEvidenceState(): SharedEvidenceState {
    if (this.evidenceState) {
      this.heads = this.evidenceState.heads;
      if (!this.evidenceState.valid || this.evidenceState.writeSequence % 2 !== 0) {
        this.reconcileEvidenceStateWithSequence(this.evidenceState);
      }
      return this.evidenceState;
    }
    this.ensureDirectory();
    const key = fs.realpathSync(this.directory);
    const shared = sharedEvidenceByDirectory.get(key);
    if (shared) {
      this.evidenceState = shared;
      this.heads = shared.heads;
      if (!shared.valid || shared.writeSequence % 2 !== 0) {
        this.reconcileEvidenceStateWithSequence(shared);
      }
      return shared;
    }
    this.acquireWriterOwnership();
    const created: SharedEvidenceState = {
      v: 1,
      gameplayEntries: 0,
      movementEntries: 0,
      valid: false,
      recoveryFiles: new Set(),
      heads: this.heads,
      writeSequence: 0,
    };
    sharedEvidenceByDirectory.set(key, created);
    this.evidenceState = created;
    this.reconcileEvidenceStateWithSequence(created);
    return created;
  }

  private reconcileEvidenceStateWithSequence(state: SharedEvidenceState): void {
    if (state.writeSequence % 2 === 0) this.beginJournalWrite(state);
    let recovered = false;
    try {
      this.reconcileEvidenceState(state);
      recovered = true;
    } finally {
      if (recovered) this.endJournalWrite(state);
    }
  }

  private invalidateAndReconcileEvidence(file: string): void {
    const shared = sharedEvidenceByDirectory.get(fs.realpathSync(this.directory));
    if (!shared) return;
    shared.valid = false;
    shared.recoveryFiles.add(file);
    shared.recoveryFiles.add(this.commitFileFor(file));
    try {
      this.reconcileEvidenceState(shared);
    } catch {
      // Preserve the original append failure. The next append must reconcile
      // successfully before it can make another capacity decision.
    }
  }

  private reconcileEvidenceState(state: SharedEvidenceState): void {
    const migrated = this.commitSidecarsMigrated();
    let gameplayEntries = 0;
    let movementEntries = 0;
    let files = 0;
    let totalEntries = 0;
    const streams = new Map<string, ShadowJournalEntry[]>();
    for (const directory of this.journalDirectories()) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        const match = /^(.*)\.([0-9]{8})\.jsonl$/u.exec(name);
        if (!match) continue;
        files++;
        if (files > MAX_EVIDENCE_FILES) throw new Error("journal_evidence_inventory_too_large");
        const streamId = match[1]!;
        const segment = Number(match[2]);
        this.assertStreamId(streamId);
        const entries = this.readCommittedJournalFile(path.join(directory, name), true, !migrated);
        totalEntries += entries.length;
        if (totalEntries > MAX_GAMEPLAY_EVIDENCE_ENTRIES + MAX_MOVEMENT_EVIDENCE_ENTRIES) {
          throw new Error("journal_evidence_inventory_too_large");
        }
        for (const entry of entries) {
          if (entry.streamId !== streamId || this.segmentFor(entry.cursor) !== segment) {
            throw new Error("journal_corrupt_sequence");
          }
          const stream = streams.get(streamId) ?? [];
          stream.push(entry);
          streams.set(streamId, stream);
          if (entry.v === 2) movementEntries++;
          else gameplayEntries++;
        }
      }
    }
    const rebuiltHeads = new Map<string, StreamHead>();
    for (const [streamId, entries] of streams) {
      entries.sort((left, right) => left.cursor - right.cursor);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const previous = entries[index - 1];
        if (entry.cursor !== index + 1 ||
            entry.previousEntryHash !== (previous?.entryHash ?? null) || previous?.terminal ||
            (entry.v === 1 && previous?.v === 2)) {
          throw new Error("journal_corrupt_sequence");
        }
        if (entry.v === 2 && previous?.v === 2) {
          const transition = reduceMovement(previous.beforeState, previous.command);
          if (transition.turnCost === "none" &&
              movementContinuityHash(transition.state) !== entry.beforeContinuityHash) {
            throw new Error("journal_state_continuity_mismatch");
          }
        }
      }
      const last = entries.at(-1)!;
      rebuiltHeads.set(streamId, {
        cursor: last.cursor,
        entryHash: last.entryHash,
        terminal: last.terminal,
        lastEntry: last,
      });
    }
    if (!migrated) {
      // Sidecars may live in the child movement directory. Re-sync every
      // journal directory before the root sentinel can durably declare the
      // migration complete, including on a retry after lost acknowledgement.
      for (const directory of this.journalDirectories()) {
        if (fs.existsSync(directory)) this.syncDirectory(directory);
      }
      this.replaceFileDurably(
        path.join(this.directory, JOURNAL_COMMIT_MIGRATION_FILE),
        Buffer.from("v1\n", "utf8"),
      );
    }
    state.heads.clear();
    for (const [streamId, head] of rebuiltHeads) state.heads.set(streamId, head);
    this.heads = state.heads;
    state.gameplayEntries = gameplayEntries;
    state.movementEntries = movementEntries;
    this.syncRecoveryFiles(state);
    state.valid = true;
  }

  private syncRecoveryFiles(state: SharedEvidenceState): void {
    for (const file of state.recoveryFiles) {
      if (fs.existsSync(file)) {
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const metadata = fs.fstatSync(descriptor);
          if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
            throw new Error("journal_insecure_file");
          }
          this.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      this.syncDirectory(path.dirname(file));
      state.recoveryFiles.delete(file);
    }
  }

  private acquireWriterOwnership(): void {
    const lockFile = path.join(this.directory, JOURNAL_WRITER_FILE);
    const ownerFileName = `.origin-journal-owner-${PROCESS_WRITER_ID}.json`;
    const ownerFile = path.join(this.directory, ownerFileName);
    const payload = Buffer.from(`${JSON.stringify({
      v: 1,
      pid: process.pid,
      ownerId: PROCESS_WRITER_ID,
      ownerFileName,
      startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString(),
      ...(PROCESS_WRITER_START_ID ? { processStartId: PROCESS_WRITER_START_ID } : {}),
    })}\n`, "utf8");
    let descriptor: number | undefined;
    try {
      fs.rmSync(ownerFile, { force: true });
      descriptor = fs.openSync(ownerFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      let written = 0;
      while (written < payload.byteLength) {
        const count = fs.writeSync(descriptor, payload, written, payload.byteLength - written);
        if (!Number.isSafeInteger(count) || count < 1 || count > payload.byteLength - written) {
          throw new Error("journal_writer_short_write");
        }
        written += count;
      }
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      this.syncDirectoryUninjected(this.directory);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.linkSync(ownerFile, lockFile);
          this.syncDirectoryUninjected(this.directory);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const owner = this.readWriterOwner(lockFile);
          if (owner.pid === process.pid && owner.ownerId === PROCESS_WRITER_ID) return;
          if (this.processIsAlive(owner)) {
            throw new Error("journal_writer_already_active", { cause: error });
          }
          const recoveryFile = path.join(this.directory, JOURNAL_WRITER_RECOVERY_FILE);
          this.acquireWriterRecoveryClaim(ownerFile, recoveryFile);
          try {
            if (!fs.existsSync(lockFile)) continue;
            const current = this.readWriterOwner(lockFile);
            if (current.pid === process.pid && current.ownerId === PROCESS_WRITER_ID) return;
            if (this.processIsAlive(current)) {
              throw new Error("journal_writer_already_active", { cause: error });
            }
            fs.unlinkSync(lockFile);
            this.syncDirectoryUninjected(this.directory);
            try {
              fs.linkSync(ownerFile, lockFile);
            } catch (claimError) {
              if ((claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError;
              const replacement = this.readWriterOwner(lockFile);
              if (this.processIsAlive(replacement)) {
                throw new Error("journal_writer_already_active", { cause: claimError });
              }
              throw new Error("journal_writer_recovery_busy", { cause: claimError });
            }
            this.syncDirectoryUninjected(this.directory);
            try { fs.rmSync(path.join(this.directory, current.ownerFileName), { force: true }); }
            catch { /* the fixed lock is the ownership authority */ }
            return;
          } finally {
            this.releaseWriterRecoveryClaim(recoveryFile);
          }
        }
      }
      throw new Error("journal_writer_already_active");
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve ownership error */ }
      }
      try { fs.rmSync(ownerFile, { force: true }); } catch { /* preserve ownership error */ }
      throw error;
    }
  }

  private acquireWriterRecoveryClaim(ownerFile: string, recoveryFile: string): void {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.linkSync(ownerFile, recoveryFile);
        this.syncDirectoryUninjected(this.directory);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const claimant = this.readWriterOwner(recoveryFile);
        if (claimant.pid === process.pid && claimant.ownerId === PROCESS_WRITER_ID) return;
        if (this.processIsAlive(claimant)) {
          throw new Error("journal_writer_recovery_busy", { cause: error });
        }
        try {
          fs.unlinkSync(recoveryFile);
          this.syncDirectoryUninjected(this.directory);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new Error("journal_writer_recovery_busy");
  }

  private releaseWriterRecoveryClaim(recoveryFile: string): void {
    try {
      if (!fs.existsSync(recoveryFile)) return;
      const claimant = this.readWriterOwner(recoveryFile);
      if (claimant.pid !== process.pid || claimant.ownerId !== PROCESS_WRITER_ID) return;
      fs.unlinkSync(recoveryFile);
      this.syncDirectoryUninjected(this.directory);
    } catch {
      // A surviving claim remains recoverable through its PID-scoped owner
      // record. Never turn best-effort cleanup into a split ownership failure.
    }
  }

  private readWriterOwner(file: string): WriterOwner {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > JOURNAL_WRITER_MAX_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("journal_writer_owner_corrupt");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error("journal_writer_owner_corrupt");
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("journal_writer_owner_corrupt");
    }
    const owner = candidate as {
      v?: unknown;
      pid?: unknown;
      ownerId?: unknown;
      ownerFileName?: unknown;
      startedAt?: unknown;
      processStartId?: unknown;
    };
    if (owner.v !== 1 || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 ||
        typeof owner.ownerId !== "string" || !/^[0-9a-f-]{36}$/u.test(owner.ownerId) ||
        typeof owner.ownerFileName !== "string" ||
        !/^\.origin-journal-owner-[0-9a-f-]{36}\.json$/u.test(owner.ownerFileName) ||
        typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt)) ||
        (owner.processStartId !== undefined &&
          (typeof owner.processStartId !== "string" || owner.processStartId.length > 128))) {
      throw new Error("journal_writer_owner_corrupt");
    }
    return {
      pid: Number(owner.pid),
      ownerId: owner.ownerId,
      ownerFileName: owner.ownerFileName,
      ...(typeof owner.processStartId === "string" ? { processStartId: owner.processStartId } : {}),
    };
  }

  private processIsAlive(owner: WriterOwner): boolean {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (!owner.processStartId) return true;
    const currentStartId = processStartIdentity(owner.pid);
    // If the platform cannot prove identity, conservatively preserve the lock.
    return currentStartId === null || currentStartId === owner.processStartId;
  }

  private syncDirectoryUninjected(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private boundedSegments(streamId: string): number[] {
    const maxEntries = /^movement_[0-9a-f]{48}$/u.test(streamId)
      ? this.maxMovementEntries
      : this.maxGameplayEntries;
    const maxSegments = Math.ceil(maxEntries / SEGMENT_ENTRIES);
    const segments: number[] = [];
    let missing = false;
    for (let segment = 0; segment < maxSegments; segment++) {
      const exists = this.segmentFilesFor(streamId, segment).length > 0;
      if (!exists) {
        missing = true;
        continue;
      }
      if (missing) throw new Error("journal_missing_segment");
      segments.push(segment);
    }
    if (this.segmentFilesFor(streamId, maxSegments).length > 0) throw new Error("journal_evidence_capacity_exceeded");
    return segments;
  }

  private syncSegmentFiles(streamId: string, segment: number): void {
    const files = this.segmentFilesFor(streamId, segment);
    for (const file of files) {
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        this.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    for (const directory of new Set(files.map((file) => path.dirname(file)))) {
      this.syncDirectory(directory);
    }
  }

  private removeEmptySegmentFiles(streamId: string, segment: number): boolean {
    const files = this.segmentFilesFor(streamId, segment);
    if (!files.length || files.some((file) => fs.statSync(file).size !== 0)) return false;
    for (const file of files) fs.rmSync(file);
    for (const directory of new Set(files.map((file) => path.dirname(file)))) {
      this.syncDirectory(directory);
    }
    return true;
  }

  private segmentFilesFor(streamId: string, segment: number): string[] {
    this.assertStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    const name = `${streamId}.${String(segment).padStart(8, "0")}.jsonl`;
    return this.journalDirectories().flatMap((directory) => {
      const file = path.join(directory, name);
      const dataExists = fs.existsSync(file);
      const commitExists = fs.existsSync(this.commitFileFor(file));
      if (!dataExists && commitExists && this.readCommitCount(this.commitFileFor(file)) > 0) {
        throw new Error("journal_missing_segment");
      }
      return dataExists ? [file] : [];
    });
  }

  private fileFor(streamId: string, segment: number, version: 1 | 2 = 1): string {
    this.assertStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    const directory = version === 2 ? this.movementDirectory() : this.directory;
    return path.join(directory, `${streamId}.${String(segment).padStart(8, "0")}.jsonl`);
  }

  private movementDirectory(): string {
    return path.join(this.directory, MOVEMENT_EVIDENCE_DIRECTORY);
  }

  private journalDirectories(): string[] {
    return [this.directory, this.movementDirectory()];
  }

  private segmentFor(cursor: number): number {
    return Math.floor((Math.max(1, cursor) - 1) / SEGMENT_ENTRIES);
  }

  private assertStreamId(streamId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(streamId)) throw new Error("invalid_stream_id");
  }
}
