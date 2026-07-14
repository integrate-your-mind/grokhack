import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { dataPath } from "./data-paths.js";
import {
  createMovementTurnEnvelope,
  createShadowJournalEntry,
  MAX_MOVEMENT_TURN_ENVELOPE_BYTES,
  validateMovementTurnEnvelope,
  validateShadowJournalEntry,
  validateShadowRoute,
  type GameplayJournalInput,
  type MovementTurnEnvelope,
  type MovementTurnEnvelopeInput,
  type MovementJournalInput,
  type ShadowJournalEntry,
  type ShadowJournalInput,
  type ShadowRoute,
} from "../src/shadow-journal.js";
import { movementContinuityHash, reduceMovement, type MovementAuthority } from "../src/movement-reducer.js";
import {
  createCombatTurnEnvelopeV1,
  validateCombatTurnEnvelopeV1,
  type CombatTurnEnvelopeInput,
  type CombatTurnEnvelopeV1,
} from "../src/combat-turn-envelope.js";

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

interface MovementTurnHead {
  cursor: number;
  envelopeHash: string;
  movementEntryHash: string;
  turnEntryHash: string | null;
  terminal: boolean;
  lastEnvelope?: MovementTurnEnvelope;
}

interface CombatTurnHead {
  cursor: number;
  envelopeHash: string;
  turnEntryHash: string | null;
  terminal: boolean;
  lastEnvelope?: CombatTurnEnvelopeV1;
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
const MOVEMENT_TURN_DIRECTORY = "movement-turn-v1";
const COMBAT_TURN_DIRECTORY = "combat-turn-v1";
const MOVEMENT_TURN_PREPARATION_FILE = ".movement-turn-preparation-v1.json";
const MOVEMENT_TURN_PREPARATION_TEMP_FILE = ".movement-turn-preparation-v1.tmp";
const LEGACY_MOVEMENT_TURN_PREPARATION_TEMP =
  /^\.movement-turn-preparation-v1\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
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
const MAX_LEGACY_MOVEMENT_TURN_PREPARATION_TEMPS = 64;
const JOURNAL_WRITER_MAX_BYTES = 4 * 1024;
const JOURNAL_READER_RETRY_ATTEMPTS = 200;
const JOURNAL_READER_RETRY_DELAY_MS = 5;
const MAX_MOVEMENT_TURN_PREPARATION_BYTES = 512;
const PROCESS_WRITER_ID = randomUUID();
const PROCESS_WRITER_START_ID = processStartIdentity(process.pid);

interface SharedEvidenceState {
  v: 1;
  gameplayEntries: number;
  movementEntries: number;
  valid: boolean;
  recoveryFiles: Set<string>;
  heads: Map<string, StreamHead>;
  movementTurnHeads: Map<string, MovementTurnHead>;
  movementTurnLegacyTempsChecked: boolean;
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

interface MovementTurnPreparation {
  v: 1;
  streamId: string;
  operationId: string;
  expectedCursor: number;
  previousEnvelopeHash: string | null;
  movementEntryHash: string;
  state: "prepared" | "origin_applied" | "persistence_committed";
}

export interface MovementTurnRecoveryCandidate {
  streamId: string;
  operationId: string;
  state: MovementTurnPreparation["state"];
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

/** Dedicated additive stream for atomic movement plus optional turn evidence. */
export function movementTurnJournalStreamId(
  playerId: string,
  runId: string,
  authority: Readonly<MovementAuthority>,
): string {
  const movementStream = movementJournalStreamId(playerId, runId, authority);
  const streamHash = createHash("sha256").update(`movement-turn-v1|${movementStream}`, "utf8").digest("hex").slice(0, 48);
  return `turn_${streamHash}`;
}

/** Dedicated additive combat stream; movement envelope identities remain frozen. */
export function combatTurnJournalStreamId(
  playerId: string,
  runId: string,
  authority: Readonly<MovementAuthority>,
): string {
  const movementStream = movementJournalStreamId(playerId, runId, authority);
  const streamHash = createHash("sha256").update(`combat-turn-v1|${movementStream}`, "utf8").digest("hex").slice(0, 48);
  return `combat_${streamHash}`;
}

function validateMovementTurnPreparationIdentity(input: {
  streamId: string;
  operationId: string;
}): { streamId: string; operationId: string } {
  if (!/^turn_[0-9a-f]{48}$/u.test(input.streamId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.operationId)) {
    throw new Error("invalid_movement_turn_preparation");
  }
  return { streamId: input.streamId, operationId: input.operationId };
}

export type OriginTransitionInput =
  | Omit<GameplayJournalInput, "cursor" | "previousEntryHash">
  | Omit<MovementJournalInput, "cursor" | "previousEntryHash">;

export type OriginMovementTurnInput = Omit<
  MovementTurnEnvelopeInput,
  "cursor" | "previousEnvelopeHash" | "previousMovementEntryHash" | "previousTurnEntryHash"
>;

export type MovementTurnAppendResult =
  | { status: "appended"; envelope: MovementTurnEnvelope }
  | { status: "duplicate"; envelope: MovementTurnEnvelope }
  | Extract<JournalAppendResult, { status: "dropped_capacity" }>;

export type OriginCombatTurnInput = Omit<CombatTurnEnvelopeInput, "cursor" | "previousEnvelopeHash" | "previousTurnEntryHash">;

export type CombatTurnAppendResult =
  | { status: "appended"; envelope: CombatTurnEnvelopeV1 }
  | { status: "duplicate"; envelope: CombatTurnEnvelopeV1 };

export interface OriginGameplayJournalOptions {
  /** Fault-injection seam used to prove pre/post-rename fsync recovery. */
  fsyncSync?: (descriptor: number) => void;
  /** Fault-injection seam used to prove short writes cannot truncate a segment. */
  writeSync?: (descriptor: number, buffer: Uint8Array, offset: number, length: number) => number;
  /** Fault-injection seam for the durable movement-turn preparation rename. */
  renameMovementTurnPreparationSync?: (from: string, to: string) => void;
  /** Fault-injection seam for the durable movement-turn preparation unlink. */
  unlinkMovementTurnPreparationSync?: (file: string) => void;
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
  private movementTurnHeads = new Map<string, MovementTurnHead>();
  private combatTurnHeads = new Map<string, CombatTurnHead>();
  private evidenceState?: SharedEvidenceState;
  private readonly fsyncSync: (descriptor: number) => void;
  private readonly writeSync: (descriptor: number, buffer: Uint8Array, offset: number, length: number) => number;
  private readonly renameMovementTurnPreparationSync: (from: string, to: string) => void;
  private readonly unlinkMovementTurnPreparationSync: (file: string) => void;
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
    this.renameMovementTurnPreparationSync = options.renameMovementTurnPreparationSync ?? fs.renameSync;
    this.unlinkMovementTurnPreparationSync = options.unlinkMovementTurnPreparationSync ?? fs.unlinkSync;
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
   * One global durable preparation fences the origin mutation and persistence
   * window. A cold process clears only `persistence_committed`: that phase is
   * written after every required DuckDB write acknowledges, so an exact
   * committed envelope plus that durable phase can safely reconcile cleanup.
   * Earlier phases remain poison because they cannot prove persisted state.
   */
  hasPendingMovementTurn(): boolean {
    this.ensureEvidenceState();
    const directory = this.movementTurnDirectory();
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    this.ensureMovementTurnDirectory();
    try {
      this.recoverMovementTurnPreparationTemps();
      const existing = this.readMovementTurnPreparation();
      if (existing?.state === "persistence_committed" &&
          this.movementTurnPreparationIsCommitted(existing)) {
        this.unlinkMovementTurnPreparationSync(this.movementTurnPreparationFile());
        this.syncDirectory(this.movementTurnDirectory());
        return false;
      }
      return existing !== null;
    } catch {
      // Corrupt or ambiguous marker/temp state must fence shadow adoption, but
      // legacy origin availability is handled by the caller's degraded latch.
      return true;
    }
  }

  /**
   * Returns the exact durable preparation identity for database-receipt
   * reconciliation. This is intentionally read-only: only the caller that
   * proves the matching committed snapshot may advance or clear the marker.
   */
  movementTurnRecoveryCandidate(): MovementTurnRecoveryCandidate | null {
    this.ensureEvidenceState();
    const directory = this.movementTurnDirectory();
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    this.ensureMovementTurnDirectory();
    this.recoverMovementTurnPreparationTemps();
    const existing = this.readMovementTurnPreparation();
    if (!existing) return null;
    if (existing.state !== "prepared" && !this.movementTurnPreparationIsCommitted(existing)) {
      throw new Error("movement_turn_preparation_corrupt");
    }
    return {
      streamId: existing.streamId,
      operationId: existing.operationId,
      state: existing.state,
    };
  }

  prepareMovementTurn(input: Pick<OriginMovementTurnInput, "streamId" | "operationId" | "command" | "beforeState">): void {
    const identity = validateMovementTurnPreparationIdentity(input);
    this.ensureEvidenceState();
    this.ensureMovementTurnDirectory();
    const head = this.movementTurnHead(identity.streamId);
    if (head.terminal || reduceMovement(input.beforeState, input.command).turnCost === "none") {
      throw new Error("invalid_movement_turn_preparation");
    }
    const movement = createShadowJournalEntry({
      streamId: `${identity.streamId}_movement`,
      cursor: head.cursor + 1,
      command: input.command,
      beforeState: input.beforeState,
      previousEntryHash: head.cursor === 0 ? null : head.movementEntryHash,
    });
    const preparation: MovementTurnPreparation = {
      v: 1,
      ...identity,
      expectedCursor: head.cursor + 1,
      previousEnvelopeHash: head.cursor === 0 ? null : head.envelopeHash,
      movementEntryHash: movement.entryHash,
      state: "prepared",
    };
    this.recoverMovementTurnPreparationTemps();
    const existing = this.readMovementTurnPreparation();
    if (existing) {
      if (existing.state === "prepared" && this.sameMovementTurnPreparation(existing, preparation)) {
        // A lost directory-fsync acknowledgement may leave the exact marker
        // durable even though the caller did not observe prepare success.
        this.syncDirectory(this.movementTurnDirectory());
        return;
      }
      throw new Error("movement_turn_preparation_exists");
    }
    this.writeMovementTurnPreparationDurably(preparation);
  }

  /** Durably records that all synchronous origin effects represented by the operation finished. */
  markMovementTurnApplied(input: { streamId: string; operationId: string }): void {
    const identity = validateMovementTurnPreparationIdentity(input);
    this.ensureEvidenceState();
    this.ensureMovementTurnDirectory();
    this.recoverMovementTurnPreparationTemps();
    const existing = this.readMovementTurnPreparation();
    if (!existing) throw new Error("movement_turn_preparation_uncommitted");
    if (existing.streamId !== identity.streamId || existing.operationId !== identity.operationId) {
      throw new Error("movement_turn_preparation_conflict");
    }
    if (!this.movementTurnPreparationIsCommitted(existing)) {
      throw new Error("movement_turn_preparation_uncommitted");
    }
    if (existing.state === "origin_applied" || existing.state === "persistence_committed") {
      this.syncDirectory(this.movementTurnDirectory());
      return;
    }
    this.writeMovementTurnPreparationDurably({ ...existing, state: "origin_applied" });
  }

  /** Durably records that every movement-bound origin persistence write acknowledged. */
  markMovementTurnPersistenceCommitted(input: { streamId: string; operationId: string }): void {
    const identity = validateMovementTurnPreparationIdentity(input);
    this.ensureEvidenceState();
    this.ensureMovementTurnDirectory();
    this.recoverMovementTurnPreparationTemps();
    const existing = this.readMovementTurnPreparation();
    if (!existing) throw new Error("movement_turn_preparation_uncommitted");
    if (existing.streamId !== identity.streamId || existing.operationId !== identity.operationId) {
      throw new Error("movement_turn_preparation_conflict");
    }
    if (!this.movementTurnPreparationIsCommitted(existing)) {
      throw new Error("movement_turn_preparation_uncommitted");
    }
    if (existing.state === "persistence_committed") {
      this.syncDirectory(this.movementTurnDirectory());
      return;
    }
    if (existing.state !== "origin_applied") {
      throw new Error("movement_turn_origin_not_applied");
    }
    this.writeMovementTurnPreparationDurably({ ...existing, state: "persistence_committed" });
  }

  completeMovementTurnPreparation(input: { streamId: string; operationId: string }): void {
    const identity = validateMovementTurnPreparationIdentity(input);
    this.ensureEvidenceState();
    this.ensureMovementTurnDirectory();
    this.recoverMovementTurnPreparationTemps();
    const existing = this.readMovementTurnPreparation();
    if (!existing) {
      // An unlink may have committed even if its directory fsync response was
      // lost. The matching immutable envelope makes this retry safe.
      const head = this.movementTurnHead(identity.streamId).lastEnvelope;
      if (head?.operationId !== identity.operationId) {
        throw new Error("movement_turn_preparation_uncommitted");
      }
      this.syncDirectory(this.movementTurnDirectory());
      return;
    }
    if (existing.streamId !== identity.streamId || existing.operationId !== identity.operationId) {
      throw new Error("movement_turn_preparation_conflict");
    }
    if (!this.movementTurnPreparationIsCommitted(existing)) {
      throw new Error("movement_turn_preparation_uncommitted");
    }
    if (existing.state === "prepared") {
      throw new Error("movement_turn_origin_not_applied");
    }
    if (existing.state !== "persistence_committed") {
      throw new Error("movement_turn_persistence_not_committed");
    }
    this.unlinkMovementTurnPreparationSync(this.movementTurnPreparationFile());
    this.syncDirectory(this.movementTurnDirectory());
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

  appendMovementTurn(input: OriginMovementTurnInput): MovementTurnAppendResult {
    const movementCapacity = this.capacityResult(2);
    const gameplayCapacity = input.turn ? this.capacityResult(1) : null;
    const head = this.movementTurnHead(input.streamId);
    const last = head.lastEnvelope;
    if (last?.operationId === input.operationId) {
      const retry = createMovementTurnEnvelope({
        ...input,
        cursor: last.cursor,
        previousEnvelopeHash: last.previousEnvelopeHash,
        previousMovementEntryHash: last.movement.previousEntryHash,
        previousTurnEntryHash: last.turn ? last.turn.previousEntryHash : head.turnEntryHash,
      });
      if (retry.envelopeHash === last.envelopeHash) return { status: "duplicate", envelope: last };
      throw new Error("movement_turn_operation_conflict");
    }
    if (movementCapacity) return movementCapacity;
    if (gameplayCapacity) return gameplayCapacity;
    return this.appendMovementTurnEnvelope(createMovementTurnEnvelope({
      ...input,
      cursor: head.cursor + 1,
      previousEnvelopeHash: head.cursor === 0 ? null : head.envelopeHash,
      previousMovementEntryHash: head.cursor === 0 ? null : head.movementEntryHash,
      previousTurnEntryHash: head.turnEntryHash,
    }));
  }

  appendMovementTurnEnvelope(envelope: MovementTurnEnvelope): MovementTurnAppendResult {
    const validated = validateMovementTurnEnvelope(envelope);
    const movementCapacity = this.capacityResult(2);
    if (movementCapacity) {
      const last = this.movementTurnHeads.get(validated.streamId)?.lastEnvelope;
      if (last?.envelopeHash === validated.envelopeHash) return { status: "duplicate", envelope: last };
      return movementCapacity;
    }
    if (validated.turn) {
      const gameplayCapacity = this.capacityResult(1);
      if (gameplayCapacity) {
        const last = this.movementTurnHeads.get(validated.streamId)?.lastEnvelope;
        if (last?.envelopeHash === validated.envelopeHash) return { status: "duplicate", envelope: last };
        return gameplayCapacity;
      }
    }
    const head = this.movementTurnHead(validated.streamId);
    if (head.terminal) throw new Error("movement_turn_terminal_stream");
    if (validated.cursor <= head.cursor) {
      const existing = this.movementTurnEnvelopeAt(validated.streamId, validated.cursor);
      if (existing?.envelopeHash === validated.envelopeHash) return { status: "duplicate", envelope: existing };
      throw new Error("movement_turn_cursor_conflict");
    }
    if (validated.cursor !== head.cursor + 1) throw new Error("movement_turn_cursor_gap");
    if (validated.previousEnvelopeHash !== (head.cursor === 0 ? null : head.envelopeHash)) {
      throw new Error("movement_turn_hash_chain_mismatch");
    }
    if (validated.movement.previousEntryHash !== (head.cursor === 0 ? null : head.movementEntryHash)) {
      throw new Error("movement_turn_movement_chain_mismatch");
    }
    if (validated.turn && validated.turn.previousEntryHash !== head.turnEntryHash) {
      throw new Error("movement_turn_vitals_chain_mismatch");
    }
    const previous = head.lastEnvelope;
    if (head.cursor > 0 && !previous) throw new Error("movement_turn_missing_segment");
    if (previous) {
      const previousTransition = reduceMovement(previous.movement.beforeState, previous.movement.command);
      if (previousTransition.turnCost === "none" &&
          movementContinuityHash(previousTransition.state) !== validated.movement.beforeContinuityHash) {
        throw new Error("movement_turn_state_continuity_mismatch");
      }
    }
    const payload = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (payload.byteLength > MAX_MOVEMENT_TURN_ENVELOPE_BYTES) {
      throw new Error("movement_turn_envelope_too_large");
    }
    const evidence = this.ensureEvidenceState();
    this.beginJournalWrite(evidence);
    let file: string;
    try {
      this.ensureMovementTurnDirectory();
      file = this.movementTurnFileFor(validated.streamId, this.segmentFor(validated.cursor));
      try {
        this.ensureCommitFile(file);
        this.appendFileDurably(file, payload);
        // The single commit byte publishes the complete pair or neither nested
        // transition. Readers never observe the preceding data append alone.
        this.appendCommitDurably(file);
      } catch (error) {
        this.movementTurnHeads.delete(validated.streamId);
        this.invalidateAndReconcileEvidence(file);
        throw error;
      }
      evidence.movementEntries++;
      if (validated.turn) evidence.gameplayEntries++;
      const next: MovementTurnHead = {
        cursor: validated.cursor,
        envelopeHash: validated.envelopeHash,
        movementEntryHash: validated.movement.entryHash,
        turnEntryHash: validated.turn?.entryHash ?? head.turnEntryHash,
        terminal: validated.turn?.terminal ?? validated.movement.terminal,
        lastEnvelope: validated,
      };
      this.movementTurnHeads.set(validated.streamId, next);
      evidence.movementTurnHeads.set(validated.streamId, next);
      return { status: "appended", envelope: validated };
    } finally {
      if (evidence.valid) this.endJournalWrite(evidence);
    }
  }

  appendCombatTurn(input: OriginCombatTurnInput): CombatTurnAppendResult {
    const head = this.combatTurnHead(input.streamId);
    const last = head.lastEnvelope;
    if (last?.operationId === input.operationId) {
      const retry = createCombatTurnEnvelopeV1({
        ...input,
        cursor: last.cursor,
        previousEnvelopeHash: last.previousEnvelopeHash,
        previousTurnEntryHash: last.turn.previousEntryHash,
      });
      if (retry.envelopeHash === last.envelopeHash) return { status: "duplicate", envelope: last };
      throw new Error("combat_turn_operation_conflict");
    }
    const envelope = createCombatTurnEnvelopeV1({
      ...input,
      cursor: head.cursor + 1,
      previousEnvelopeHash: head.cursor === 0 ? null : head.envelopeHash,
      previousTurnEntryHash: head.turnEntryHash,
    });
    return this.appendCombatTurnEnvelope(envelope);
  }

  appendCombatTurnEnvelope(envelope: CombatTurnEnvelopeV1): CombatTurnAppendResult {
    const validated = validateCombatTurnEnvelopeV1(envelope);
    const head = this.combatTurnHead(validated.streamId);
    if (head.terminal) throw new Error("combat_turn_terminal_stream");
    if (validated.cursor <= head.cursor) {
      const existing = this.combatTurnEnvelopeAt(validated.streamId, validated.cursor);
      if (existing?.envelopeHash === validated.envelopeHash) return { status: "duplicate", envelope: existing };
      throw new Error("combat_turn_cursor_conflict");
    }
    if (validated.cursor !== head.cursor + 1) throw new Error("combat_turn_cursor_gap");
    if (validated.previousEnvelopeHash !== (head.cursor === 0 ? null : head.envelopeHash)) {
      throw new Error("combat_turn_hash_chain_mismatch");
    }
    if (validated.turn.previousEntryHash !== head.turnEntryHash) {
      throw new Error("combat_turn_vitals_chain_mismatch");
    }
    const payload = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (payload.byteLength > MAX_MOVEMENT_TURN_ENVELOPE_BYTES) throw new Error("combat_turn_envelope_too_large");
    const evidence = this.ensureEvidenceState();
    this.beginJournalWrite(evidence);
    let file: string;
    try {
      this.ensureCombatTurnDirectory();
      file = this.combatTurnFileFor(validated.streamId, this.segmentFor(validated.cursor));
      try {
        this.ensureCommitFile(file);
        this.appendFileDurably(file, payload);
        this.appendCommitDurably(file);
      } catch (error) {
        this.combatTurnHeads.delete(validated.streamId);
        this.invalidateAndReconcileEvidence(file);
        throw error;
      }
      this.combatTurnHeads.set(validated.streamId, {
        cursor: validated.cursor,
        envelopeHash: validated.envelopeHash,
        turnEntryHash: validated.turn.entryHash,
        terminal: validated.terminal,
        lastEnvelope: validated,
      });
      return { status: "appended", envelope: validated };
    } finally {
      if (evidence.valid) this.endJournalWrite(evidence);
    }
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

  readMovementTurnsAfter(streamId: string, cursor: number, limit: number): MovementTurnEnvelope[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("invalid cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid limit");
    this.assertMovementTurnStreamId(streamId);
    let lastError: unknown;
    for (let attempt = 0; attempt < JOURNAL_READER_RETRY_ATTEMPTS; attempt++) {
      const before = this.readWriteSequenceToken();
      if (before?.active) {
        if (before.ownerId === PROCESS_WRITER_ID) throw new Error("journal_writer_busy");
        this.waitForWriter();
        continue;
      }
      this.movementTurnHeads.delete(streamId);
      try {
        const result = this.readMovementTurnsAfterSnapshot(streamId, cursor, limit);
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

  readCombatTurnsAfter(streamId: string, cursor: number, limit: number): CombatTurnEnvelopeV1[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("invalid cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid limit");
    this.assertCombatTurnStreamId(streamId);
    const head = this.combatTurnHead(streamId);
    if (cursor >= head.cursor) return [];
    const result: CombatTurnEnvelopeV1[] = [];
    for (let segment = this.segmentFor(cursor + 1); result.length < limit; segment++) {
      const envelopes = this.readCombatTurnSegment(streamId, segment, false);
      for (const envelope of envelopes) {
        if (envelope.cursor > cursor && envelope.cursor <= head.cursor) result.push(envelope);
        if (result.length === limit) return result;
      }
      if (envelopes.length < SEGMENT_ENTRIES) break;
    }
    const expected = Math.min(limit, head.cursor - cursor);
    if (result.length !== expected) throw new Error("combat_turn_missing_segment");
    return result;
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

  private readMovementTurnsAfterSnapshot(
    streamId: string,
    cursor: number,
    limit: number,
  ): MovementTurnEnvelope[] {
    const head = this.movementTurnHead(streamId, false);
    if (cursor >= head.cursor) return [];
    const result: MovementTurnEnvelope[] = [];
    let segment = this.segmentFor(cursor + 1);
    while (result.length < limit) {
      const envelopes = this.readMovementTurnSegment(streamId, segment, false);
      for (const envelope of envelopes) {
        if (envelope.cursor > cursor && envelope.cursor <= head.cursor) result.push(envelope);
        if (result.length === limit) return result;
      }
      if (envelopes.length < SEGMENT_ENTRIES) break;
      segment++;
    }
    const expected = Math.min(limit, head.cursor - cursor);
    if (result.length !== expected) throw new Error("movement_turn_missing_segment");
    return result;
  }

  private movementTurnHead(streamId: string, repair = true): MovementTurnHead {
    this.assertMovementTurnStreamId(streamId);
    const cached = this.movementTurnHeads.get(streamId);
    if (cached) return cached;
    this.ensureDirectory();
    const segments = this.boundedMovementTurnSegments(streamId);
    if (!segments.length) {
      const empty: MovementTurnHead = {
        cursor: 0,
        envelopeHash: "",
        movementEntryHash: "",
        turnEntryHash: null,
        terminal: false,
      };
      this.movementTurnHeads.set(streamId, empty);
      return empty;
    }
    const latestSegment = segments.at(-1)!;
    if (segments.some((value, index) => value !== index)) throw new Error("movement_turn_missing_segment");
    let envelopes = this.readMovementTurnSegment(streamId, latestSegment, repair);
    if (!envelopes.length) {
      if (repair && this.removeEmptyMovementTurnSegmentFiles(streamId, latestSegment)) {
        return this.movementTurnHead(streamId);
      }
      if (repair) throw new Error("movement_turn_empty_segment");
      if (latestSegment === 0) {
        return { cursor: 0, envelopeHash: "", movementEntryHash: "", turnEntryHash: null, terminal: false };
      }
      throw new Error("movement_turn_empty_segment");
    }
    if (repair) this.syncMovementTurnSegmentFiles(streamId, latestSegment);
    const allEnvelopes = segments.flatMap((segment) =>
      segment === latestSegment ? envelopes : this.readMovementTurnSegment(streamId, segment, false));
    let lastTurnHash: string | null = null;
    for (let index = 0; index < allEnvelopes.length; index++) {
      const envelope = allEnvelopes[index]!;
      const previous = allEnvelopes[index - 1];
      if (envelope.cursor !== index + 1 ||
          envelope.previousEnvelopeHash !== (previous?.envelopeHash ?? null) ||
          envelope.movement.previousEntryHash !== (previous?.movement.entryHash ?? null) ||
          (envelope.turn !== null && envelope.turn.previousEntryHash !== lastTurnHash) ||
          previous?.turn?.terminal || previous?.movement.terminal) {
        throw new Error("movement_turn_corrupt_sequence");
      }
      if (previous) {
        const transition = reduceMovement(previous.movement.beforeState, previous.movement.command);
        if (transition.turnCost === "none" &&
            movementContinuityHash(transition.state) !== envelope.movement.beforeContinuityHash) {
          throw new Error("movement_turn_state_continuity_mismatch");
        }
      }
      if (envelope.turn) lastTurnHash = envelope.turn.entryHash;
    }
    const last = allEnvelopes.at(-1)!;
    const head: MovementTurnHead = {
      cursor: last.cursor,
      envelopeHash: last.envelopeHash,
      movementEntryHash: last.movement.entryHash,
      turnEntryHash: lastTurnHash,
      terminal: last.turn?.terminal ?? last.movement.terminal,
      lastEnvelope: last,
    };
    this.movementTurnHeads.set(streamId, head);
    return head;
  }

  private movementTurnEnvelopeAt(streamId: string, cursor: number): MovementTurnEnvelope | undefined {
    return this.readMovementTurnSegment(streamId, this.segmentFor(cursor)).find((entry) => entry.cursor === cursor);
  }

  private combatTurnEnvelopeAt(streamId: string, cursor: number): CombatTurnEnvelopeV1 | undefined {
    return this.readCombatTurnSegment(streamId, this.segmentFor(cursor)).find((entry) => entry.cursor === cursor);
  }

  private combatTurnHead(streamId: string): CombatTurnHead {
    this.assertCombatTurnStreamId(streamId);
    const cached = this.combatTurnHeads.get(streamId);
    if (cached) return cached;
    this.ensureCombatTurnDirectory();
    const all: CombatTurnEnvelopeV1[] = [];
    for (let segment = 0; ; segment++) {
      const entries = this.readCombatTurnSegment(streamId, segment);
      if (!entries.length) break;
      all.push(...entries);
      if (entries.length < SEGMENT_ENTRIES) break;
    }
    let previous: CombatTurnEnvelopeV1 | undefined;
    for (const envelope of all) {
      if (envelope.cursor !== (previous?.cursor ?? 0) + 1 ||
          envelope.previousEnvelopeHash !== (previous?.envelopeHash ?? null) ||
          envelope.turn.previousEntryHash !== (previous?.turn.entryHash ?? null) || previous?.terminal) {
        throw new Error("combat_turn_corrupt_sequence");
      }
      previous = envelope;
    }
    const head: CombatTurnHead = previous ? {
      cursor: previous.cursor,
      envelopeHash: previous.envelopeHash,
      turnEntryHash: previous.turn.entryHash,
      terminal: previous.terminal,
      lastEnvelope: previous,
    } : { cursor: 0, envelopeHash: "", turnEntryHash: null, terminal: false };
    this.combatTurnHeads.set(streamId, head);
    return head;
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

  private ensureMovementTurnDirectory(): void {
    this.ensureDirectory();
    const directory = this.movementTurnDirectory();
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      this.syncDirectory(this.directory);
    }
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("movement_turn_directory_insecure");
    }
  }

  private ensureCombatTurnDirectory(): void {
    this.ensureDirectory();
    const directory = this.combatTurnDirectory();
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      this.syncDirectory(this.directory);
    }
    const metadata = fs.lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("combat_turn_directory_insecure");
    }
  }

  private movementTurnPreparationFile(): string {
    return path.join(this.movementTurnDirectory(), MOVEMENT_TURN_PREPARATION_FILE);
  }

  private movementTurnPreparationTempFile(): string {
    return path.join(this.movementTurnDirectory(), MOVEMENT_TURN_PREPARATION_TEMP_FILE);
  }

  private readMovementTurnPreparation(): MovementTurnPreparation | null {
    const file = this.movementTurnPreparationFile();
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 ||
        metadata.size > MAX_MOVEMENT_TURN_PREPARATION_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("movement_turn_preparation_corrupt");
    }
    try {
      const candidate = JSON.parse(this.readFileSync(file).toString("utf8")) as Partial<MovementTurnPreparation>;
      const keys = Object.keys(candidate);
      const state = candidate.state ?? "prepared";
      if (candidate.v !== 1 || typeof candidate.streamId !== "string" ||
          typeof candidate.operationId !== "string" || !Number.isSafeInteger(candidate.expectedCursor) ||
          Number(candidate.expectedCursor) < 1 ||
          (candidate.previousEnvelopeHash !== null &&
            (typeof candidate.previousEnvelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(candidate.previousEnvelopeHash))) ||
          typeof candidate.movementEntryHash !== "string" || !/^[0-9a-f]{16}$/u.test(candidate.movementEntryHash) ||
          (state !== "prepared" && state !== "origin_applied" && state !== "persistence_committed") ||
          (keys.length !== 6 && keys.length !== 7) ||
          (keys.length === 7 && !keys.includes("state"))) {
        throw new Error("movement_turn_preparation_corrupt");
      }
      const identity = validateMovementTurnPreparationIdentity({
        streamId: candidate.streamId,
        operationId: candidate.operationId,
      });
      return {
        v: 1,
        ...identity,
        expectedCursor: Number(candidate.expectedCursor),
        previousEnvelopeHash: candidate.previousEnvelopeHash ?? null,
        movementEntryHash: candidate.movementEntryHash,
        state,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "movement_turn_preparation_corrupt") throw error;
      throw new Error("movement_turn_preparation_corrupt", { cause: error });
    }
  }

  private sameMovementTurnPreparation(
    left: MovementTurnPreparation,
    right: MovementTurnPreparation,
  ): boolean {
    return left.streamId === right.streamId &&
      left.operationId === right.operationId &&
      left.expectedCursor === right.expectedCursor &&
      left.previousEnvelopeHash === right.previousEnvelopeHash &&
      left.movementEntryHash === right.movementEntryHash;
  }

  private movementTurnPreparationIsCommitted(preparation: MovementTurnPreparation): boolean {
    const committed = this.movementTurnEnvelopeAt(preparation.streamId, preparation.expectedCursor);
    return committed?.operationId === preparation.operationId &&
      committed.previousEnvelopeHash === preparation.previousEnvelopeHash &&
      committed.movement.entryHash === preparation.movementEntryHash;
  }

  private recoverMovementTurnPreparationTemps(): void {
    const directory = this.movementTurnDirectory();
    const legacyScanRequired = this.evidenceState?.movementTurnLegacyTempsChecked !== true;
    const files = [this.movementTurnPreparationTempFile()];
    if (legacyScanRequired) {
      const legacyNames = fs.readdirSync(directory).filter((name) =>
        LEGACY_MOVEMENT_TURN_PREPARATION_TEMP.test(name));
      if (legacyNames.length > MAX_LEGACY_MOVEMENT_TURN_PREPARATION_TEMPS) {
        throw new Error("movement_turn_preparation_temp_inventory_too_large");
      }
      files.push(...legacyNames.map((name) => path.join(directory, name)));
    }
    let removed = false;
    for (const file of files) {
      let metadata: fs.Stats;
      try {
        metadata = fs.lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink() ||
          metadata.size > MAX_MOVEMENT_TURN_PREPARATION_BYTES ||
          (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("movement_turn_preparation_temp_corrupt");
      }
      fs.unlinkSync(file);
      removed = true;
    }
    if (removed) this.syncDirectory(directory);
    if (legacyScanRequired && this.evidenceState) {
      this.evidenceState.movementTurnLegacyTempsChecked = true;
    }
  }

  private writeMovementTurnPreparationDurably(preparation: MovementTurnPreparation): void {
    const payload = Buffer.from(`${JSON.stringify(preparation)}\n`, "utf8");
    if (payload.byteLength > MAX_MOVEMENT_TURN_PREPARATION_BYTES) {
      throw new Error("movement_turn_preparation_too_large");
    }
    this.recoverMovementTurnPreparationTemps();
    const temporary = this.movementTurnPreparationTempFile();
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("movement_turn_preparation_temp_corrupt");
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
      fs.closeSync(descriptor);
      descriptor = undefined;
      this.renameMovementTurnPreparationSync(temporary, this.movementTurnPreparationFile());
      this.syncDirectory(this.movementTurnDirectory());
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* preserve the original write/sync error */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* cold recovery validates any survivor */ }
      throw error;
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

  private replaceFileDurably(
    file: string,
    payload: Uint8Array,
    renameSync: (from: string, to: string) => void = fs.renameSync,
  ): void {
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
      renameSync(temporary, file);
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

  private readMovementTurnSegment(
    streamId: string,
    segment: number,
    repair = true,
  ): MovementTurnEnvelope[] {
    const file = this.movementTurnFileFor(streamId, segment);
    const dataExists = fs.existsSync(file);
    const commitFile = this.commitFileFor(file);
    if (!dataExists) {
      if (fs.existsSync(commitFile) && this.readCommitCount(commitFile) > 0) {
        throw new Error("movement_turn_missing_segment");
      }
      return [];
    }
    const envelopes = this.readCommittedMovementTurnFile(file, repair);
    if (envelopes.length > SEGMENT_ENTRIES) throw new Error("movement_turn_corrupt_sequence");
    return envelopes;
  }

  private readCombatTurnSegment(streamId: string, segment: number, repair = true): CombatTurnEnvelopeV1[] {
    const file = this.combatTurnFileFor(streamId, segment);
    if (!fs.existsSync(file)) {
      if (fs.existsSync(this.commitFileFor(file)) && this.readCommitCount(this.commitFileFor(file)) > 0) {
        throw new Error("combat_turn_missing_segment");
      }
      return [];
    }
    const envelopes = this.readCommittedCombatTurnFile(file, repair);
    if (envelopes.length > SEGMENT_ENTRIES) throw new Error("combat_turn_corrupt_sequence");
    return envelopes;
  }

  private readCommittedCombatTurnFile(file: string, repair: boolean): CombatTurnEnvelopeV1[] {
    const commitFile = this.commitFileFor(file);
    if (!fs.existsSync(commitFile)) throw new Error("combat_turn_commit_sidecar_missing");
    const metadata = fs.statSync(file);
    if (!metadata.isFile() || metadata.size > SEGMENT_ENTRIES * MAX_MOVEMENT_TURN_ENVELOPE_BYTES ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("combat_turn_insecure_file");
    }
    const payload = this.readFileSync(file);
    if (payload.byteLength > 0 && payload[payload.byteLength - 1] !== 0x0a) {
      if (!repair) throw new Error("combat_turn_partial_record");
      const lastNewline = payload.lastIndexOf(0x0a);
      this.truncateJournalToLineCount(file, lastNewline < 0 ? 0 : payload.subarray(0, lastNewline + 1).toString("utf8").split("\n").filter(Boolean).length);
    }
    const current = this.readFileSync(file);
    const envelopes = current.toString("utf8").split("\n").filter(Boolean).map((line) => {
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_MOVEMENT_TURN_ENVELOPE_BYTES) throw new Error("combat_turn_envelope_too_large");
      return validateCombatTurnEnvelopeV1(JSON.parse(line) as unknown);
    });
    const committed = this.readCommitCount(commitFile);
    if (committed > envelopes.length) throw new Error("combat_turn_commit_sidecar_corrupt");
    if (repair && envelopes.length > committed) this.truncateJournalToLineCount(file, committed);
    return envelopes.slice(0, committed);
  }

  private readMovementTurnFile(file: string, repair = true): MovementTurnEnvelope[] {
    const metadata = fs.statSync(file);
    if (metadata.size > SEGMENT_ENTRIES * MAX_MOVEMENT_TURN_ENVELOPE_BYTES) {
      throw new Error("movement_turn_segment_too_large");
    }
    if (!metadata.isFile() ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("movement_turn_insecure_file");
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
    return payload.toString("utf8").split("\n").filter(Boolean).map((line) => {
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_MOVEMENT_TURN_ENVELOPE_BYTES) {
        throw new Error("movement_turn_envelope_too_large");
      }
      return validateMovementTurnEnvelope(JSON.parse(line) as unknown);
    });
  }

  private readCommittedMovementTurnFile(file: string, repair: boolean): MovementTurnEnvelope[] {
    const commitFile = this.commitFileFor(file);
    if (!repair && fs.existsSync(commitFile)) {
      const committed = this.readCommitCount(commitFile);
      const envelopes = this.readMovementTurnFile(file, false);
      if (committed > envelopes.length) throw new Error("movement_turn_commit_sidecar_corrupt");
      return envelopes.slice(0, committed);
    }
    const envelopes = this.readMovementTurnFile(file, repair);
    if (!fs.existsSync(commitFile)) throw new Error("movement_turn_commit_sidecar_missing");
    const committed = this.readCommitCount(commitFile);
    if (committed > envelopes.length) throw new Error("movement_turn_commit_sidecar_corrupt");
    if (repair && envelopes.length > committed) this.truncateJournalToLineCount(file, committed);
    return envelopes.slice(0, committed);
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
      this.movementTurnHeads = this.evidenceState.movementTurnHeads;
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
      this.movementTurnHeads = shared.movementTurnHeads;
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
      movementTurnHeads: this.movementTurnHeads,
      movementTurnLegacyTempsChecked: false,
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
    const movementTurnStreams = new Map<string, MovementTurnEnvelope[]>();
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
    const movementTurnDirectory = this.movementTurnDirectory();
    if (fs.existsSync(movementTurnDirectory)) {
      const metadata = fs.lstatSync(movementTurnDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
          (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("movement_turn_directory_insecure");
      }
      for (const name of fs.readdirSync(movementTurnDirectory)) {
        const match = /^(turn_[0-9a-f]{48})\.([0-9]{8})\.jsonl$/u.exec(name);
        if (!match) continue;
        files++;
        if (files > MAX_EVIDENCE_FILES) throw new Error("journal_evidence_inventory_too_large");
        const streamId = match[1]!;
        const segment = Number(match[2]);
        const envelopes = this.readCommittedMovementTurnFile(path.join(movementTurnDirectory, name), true);
        totalEntries += envelopes.reduce((count, envelope) => count + 1 + (envelope.turn ? 1 : 0), 0);
        if (totalEntries > MAX_GAMEPLAY_EVIDENCE_ENTRIES + MAX_MOVEMENT_EVIDENCE_ENTRIES) {
          throw new Error("journal_evidence_inventory_too_large");
        }
        for (const envelope of envelopes) {
          if (envelope.streamId !== streamId || this.segmentFor(envelope.cursor) !== segment) {
            throw new Error("movement_turn_corrupt_sequence");
          }
          const stream = movementTurnStreams.get(streamId) ?? [];
          stream.push(envelope);
          movementTurnStreams.set(streamId, stream);
          movementEntries++;
          if (envelope.turn) gameplayEntries++;
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
    const rebuiltMovementTurnHeads = new Map<string, MovementTurnHead>();
    for (const [streamId, envelopes] of movementTurnStreams) {
      envelopes.sort((left, right) => left.cursor - right.cursor);
      let lastTurnHash: string | null = null;
      for (let index = 0; index < envelopes.length; index++) {
        const envelope = envelopes[index]!;
        const previous = envelopes[index - 1];
        if (envelope.cursor !== index + 1 ||
            envelope.previousEnvelopeHash !== (previous?.envelopeHash ?? null) ||
            envelope.movement.previousEntryHash !== (previous?.movement.entryHash ?? null) ||
            (envelope.turn !== null && envelope.turn.previousEntryHash !== lastTurnHash) ||
            previous?.turn?.terminal || previous?.movement.terminal) {
          throw new Error("movement_turn_corrupt_sequence");
        }
        if (previous) {
          const transition = reduceMovement(previous.movement.beforeState, previous.movement.command);
          if (transition.turnCost === "none" &&
              movementContinuityHash(transition.state) !== envelope.movement.beforeContinuityHash) {
            throw new Error("movement_turn_state_continuity_mismatch");
          }
        }
        if (envelope.turn) lastTurnHash = envelope.turn.entryHash;
      }
      const last = envelopes.at(-1)!;
      rebuiltMovementTurnHeads.set(streamId, {
        cursor: last.cursor,
        envelopeHash: last.envelopeHash,
        movementEntryHash: last.movement.entryHash,
        turnEntryHash: lastTurnHash,
        terminal: last.turn?.terminal ?? last.movement.terminal,
        lastEnvelope: last,
      });
    }
    if (movementEntries > this.maxMovementEntries || gameplayEntries > this.maxGameplayEntries) {
      throw new Error("journal_evidence_capacity_exceeded");
    }
    if (!migrated) {
      // Sidecars may live in the child movement directory. Re-sync every
      // journal directory before the root sentinel can durably declare the
      // migration complete, including on a retry after lost acknowledgement.
      for (const directory of this.journalDirectories()) {
        if (fs.existsSync(directory)) this.syncDirectory(directory);
      }
      if (fs.existsSync(movementTurnDirectory)) this.syncDirectory(movementTurnDirectory);
      this.replaceFileDurably(
        path.join(this.directory, JOURNAL_COMMIT_MIGRATION_FILE),
        Buffer.from("v1\n", "utf8"),
      );
    }
    state.heads.clear();
    for (const [streamId, head] of rebuiltHeads) state.heads.set(streamId, head);
    this.heads = state.heads;
    state.movementTurnHeads.clear();
    for (const [streamId, head] of rebuiltMovementTurnHeads) state.movementTurnHeads.set(streamId, head);
    this.movementTurnHeads = state.movementTurnHeads;
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

  private boundedMovementTurnSegments(streamId: string): number[] {
    this.assertMovementTurnStreamId(streamId);
    const maxSegments = Math.ceil(this.maxMovementEntries / SEGMENT_ENTRIES);
    const segments: number[] = [];
    let missing = false;
    for (let segment = 0; segment < maxSegments; segment++) {
      const file = this.movementTurnFileFor(streamId, segment);
      const exists = fs.existsSync(file);
      if (!exists) {
        const commitFile = this.commitFileFor(file);
        if (fs.existsSync(commitFile) && this.readCommitCount(commitFile) > 0) {
          throw new Error("movement_turn_missing_segment");
        }
        missing = true;
        continue;
      }
      if (missing) throw new Error("movement_turn_missing_segment");
      segments.push(segment);
    }
    if (fs.existsSync(this.movementTurnFileFor(streamId, maxSegments))) {
      throw new Error("movement_turn_evidence_capacity_exceeded");
    }
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

  private syncMovementTurnSegmentFiles(streamId: string, segment: number): void {
    const file = this.movementTurnFileFor(streamId, segment);
    const files = [file, this.commitFileFor(file)].filter((candidate) => fs.existsSync(candidate));
    for (const candidate of files) {
      const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        this.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    if (files.length) this.syncDirectory(this.movementTurnDirectory());
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

  private removeEmptyMovementTurnSegmentFiles(streamId: string, segment: number): boolean {
    const file = this.movementTurnFileFor(streamId, segment);
    const commitFile = this.commitFileFor(file);
    const files = [file, commitFile].filter((candidate) => fs.existsSync(candidate));
    if (!files.length || files.some((candidate) => fs.statSync(candidate).size !== 0)) return false;
    for (const candidate of files) fs.rmSync(candidate);
    this.syncDirectory(this.movementTurnDirectory());
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

  private movementTurnFileFor(streamId: string, segment: number): string {
    this.assertMovementTurnStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    return path.join(this.movementTurnDirectory(), `${streamId}.${String(segment).padStart(8, "0")}.jsonl`);
  }

  private movementTurnDirectory(): string {
    return path.join(this.directory, MOVEMENT_TURN_DIRECTORY);
  }

  private combatTurnFileFor(streamId: string, segment: number): string {
    this.assertCombatTurnStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    return path.join(this.combatTurnDirectory(), `${streamId}.${String(segment).padStart(8, "0")}.jsonl`);
  }

  private combatTurnDirectory(): string {
    return path.join(this.directory, COMBAT_TURN_DIRECTORY);
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

  private assertMovementTurnStreamId(streamId: string): void {
    if (!/^turn_[0-9a-f]{48}$/u.test(streamId)) throw new Error("invalid_movement_turn_stream_id");
  }

  private assertCombatTurnStreamId(streamId: string): void {
    if (!/^combat_[0-9a-f]{48}$/u.test(streamId)) throw new Error("invalid_combat_turn_stream_id");
  }
}
