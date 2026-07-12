import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { requireEdgeConfig } from "./config";
import {
  DEDUPE_WINDOW_PER_SESSION,
  isPositiveSafeInteger,
  isResumeProofGrant,
  isSha256Hex,
  isTokenId,
  isUuid,
  playerSessionObjectName,
  openResumeProofGrant,
} from "./protocol";

const ENVIRONMENT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const FLOOR_OBJECT_RE =
  /^floor:v1:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?:i[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?:d(?:[1-9]|1[0-5]):e[1-9][0-9]{0,15}$/;
const REQUEST_HASH_RE = /^[A-Za-z0-9:._-]{1,64}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{3,64}$/;
const LOCATION_HINTS = new Set<DurableObjectLocationHint>([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
]);
const HUNGER_STATES = new Set(["satiated", "normal", "hungry", "weak", "fainting", "starving"]);
const MAX_JOIN_OPERATION_RECEIPTS = 64;
export const MAX_TRANSFER_OPERATION_RECEIPTS = 256;
export const MAX_TRANSFER_RECEIPTS = DEDUPE_WINDOW_PER_SESSION;
const MAX_TRANSFER_RESPONSE_BYTES = 8_192;
export const MAX_TRANSFER_HANDOFF_BYTES = 3 * 1_024 * 1_024;
const encoder = new TextEncoder();

export interface SessionAuthorityFence {
  playerId: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  floorObjectName: string;
}

export interface TransferCommandReceipt {
  clientSeq: number;
  serverRevision: number;
  requestHash: string;
  responseJson: string;
}

export interface TransferGameplayState {
  turns: number;
  hunger: number;
  maxHunger: number;
  hungerState: "satiated" | "normal" | "hungry" | "weak" | "fainting" | "starving";
  hp: number;
  alive: boolean;
}

export interface TransferHandoff {
  v: 1;
  lastClientSeq: number;
  receipts: TransferCommandReceipt[];
  gameplay: TransferGameplayState;
}

export interface AuthorizeJoinRequest extends SessionAuthorityFence {
  environment: string;
  locationHint: DurableObjectLocationHint;
  operationId: string;
  connectionId: string;
  resumeProofGrant: string;
  keyId: string;
  expiresAt: number;
}

export type AuthorizeJoinResult =
  | {
      ok: true;
      decision: "initial_bound" | "same_route";
      fence: SessionAuthorityFence;
      version: number;
    }
  | {
      ok: true;
      decision: "transfer_target";
      fence: SessionAuthorityFence;
      transferId: string;
      handoff: TransferHandoff;
      targetControlToken: string;
      version: number;
    }
  | SessionFailure;

export interface FreezeTransferRequest extends SessionAuthorityFence {
  environment: string;
  operationId: string;
  transferId: string;
  connectionId: string;
  expectedVersion: number;
  resumeProofHash: string;
}

export interface PrepareTransferRequest {
  environment: string;
  playerId: string;
  operationId: string;
  transferId: string;
  expectedVersion: number;
  resumeProofHash: string;
  target: Omit<SessionAuthorityFence, "playerId"> & {
    locationHint: DurableObjectLocationHint;
  };
}

export interface CommitTransferRequest {
  environment: string;
  playerId: string;
  operationId: string;
  transferId: string;
  expectedVersion: number;
  resumeProofHash: string;
}

export interface ActivateTransferRequest extends SessionAuthorityFence {
  environment: string;
  operationId: string;
  transferId: string;
  connectionId: string;
  expectedVersion: number;
  resumeProofGrant: string;
  keyId: string;
  expiresAt: number;
}

export type AbortTransferRequest = CommitTransferRequest;

export type TransferPhase = "frozen" | "prepared" | "committed" | "activated" | "aborted";
export type TransferMode = "transfer" | "takeover";

export type TransferResult =
  | {
      ok: true;
      transferId: string;
      phase: TransferPhase;
      mode?: TransferMode;
      sourceFence: SessionAuthorityFence;
      targetFence?: SessionAuthorityFence;
      version: number;
    }
  | SessionFailure;

export type SessionFailure = {
  ok: false;
  code:
    | "invalid_request"
    | "identity_mismatch"
    | "resume_proof_mismatch"
    | "idempotency_conflict"
    | "no_active_session"
    | "stale_fence"
    | "version_conflict"
    | "takeover_required"
    | "transfer_required"
    | "transfer_in_progress"
    | "transfer_id_mismatch"
    | "transfer_not_frozen"
    | "transfer_not_prepared"
    | "transfer_not_committed"
    | "invalid_target"
    | "terminal_state"
    | "handoff_sequence_gap"
    | "handoff_conflict"
    | "commit_irreversible"
    | "source_not_frozen"
    | "source_freeze_unavailable"
    | "target_prepare_failed"
    | "target_prepare_unavailable"
    | "target_not_activated"
    | "target_activation_unavailable"
    | "abort_in_progress";
  version?: number;
};

interface IdentityRow extends Record<string, SqlStorageValue> {
  object_name: string;
  environment: string;
  player_id: string;
}

interface StateRow extends Record<string, SqlStorageValue> {
  session_epoch: number;
  authority_epoch: number;
  lease_id: string;
  floor_object_name: string;
  location_hint: string;
  connection_id: string;
  resume_proof_hash: string;
  version: number;
}

interface TransferRow extends Record<string, SqlStorageValue> {
  transfer_id: string;
  phase: TransferPhase;
  mode: TransferMode | null;
  source_session_epoch: number;
  source_authority_epoch: number;
  source_lease_id: string;
  source_floor_object_name: string;
  source_location_hint: string;
  source_connection_id: string;
  target_session_epoch: number | null;
  target_authority_epoch: number | null;
  target_lease_id: string | null;
  target_floor_object_name: string | null;
  target_location_hint: string | null;
  handoff_json: string;
  source_authority_token: string;
  target_control_token: string | null;
  cleanup_status: "none" | "pending" | "completed";
  abort_status: "none" | "in_progress";
  abort_operation_id: string | null;
  abort_request_hash: string | null;
}

interface OperationRow extends Record<string, SqlStorageValue> {
  request_hash: string;
  response_json: string;
}

interface TableColumnRow extends Record<string, SqlStorageValue> {
  name: string;
}

function firstRow<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validEnvironmentIdentity(environment: unknown, playerId: unknown, expected: string): boolean {
  return environment === expected && ENVIRONMENT_RE.test(expected) && isUuid(playerId);
}

function validFence(fence: SessionAuthorityFence): boolean {
  return (
    isUuid(fence.playerId) &&
    isPositiveSafeInteger(fence.sessionEpoch) &&
    isPositiveSafeInteger(fence.authorityEpoch) &&
    isUuid(fence.leaseId) &&
    FLOOR_OBJECT_RE.test(fence.floorObjectName)
  );
}

function validJoinRequest(input: AuthorizeJoinRequest, environment: string): boolean {
  return (
    validEnvironmentIdentity(input.environment, input.playerId, environment) &&
    validFence(input) &&
    LOCATION_HINTS.has(input.locationHint) &&
    isTokenId(input.operationId) &&
    isUuid(input.connectionId) &&
    isResumeProofGrant(input.resumeProofGrant) &&
    KEY_ID_RE.test(input.keyId) &&
    isPositiveSafeInteger(input.expiresAt)
  );
}

function normalizeHandoff(candidate: TransferHandoff): TransferHandoff | null {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    candidate.v !== 1 ||
    !isNonNegativeSafeInteger(candidate.lastClientSeq) ||
    !Array.isArray(candidate.receipts) ||
    candidate.receipts.length > MAX_TRANSFER_RECEIPTS ||
    !candidate.gameplay ||
    typeof candidate.gameplay !== "object"
  ) {
    return null;
  }
  const gameplay = candidate.gameplay;
  if (
    !isNonNegativeSafeInteger(gameplay.turns) ||
    !isNonNegativeSafeInteger(gameplay.hunger) ||
    !isPositiveSafeInteger(gameplay.maxHunger) ||
    typeof gameplay.hungerState !== "string" ||
    !HUNGER_STATES.has(gameplay.hungerState) ||
    !Number.isSafeInteger(gameplay.hp) ||
    typeof gameplay.alive !== "boolean"
  ) {
    return null;
  }
  const receipts: TransferCommandReceipt[] = [];
  for (const receipt of candidate.receipts) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !isPositiveSafeInteger(receipt.clientSeq) ||
      !isNonNegativeSafeInteger(receipt.serverRevision) ||
      typeof receipt.requestHash !== "string" ||
      !REQUEST_HASH_RE.test(receipt.requestHash) ||
      typeof receipt.responseJson !== "string" ||
      encoder.encode(receipt.responseJson).byteLength > MAX_TRANSFER_RESPONSE_BYTES
    ) {
      return null;
    }
    try {
      const parsed = JSON.parse(receipt.responseJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    } catch {
      return null;
    }
    receipts.push({
      clientSeq: receipt.clientSeq,
      serverRevision: receipt.serverRevision,
      requestHash: receipt.requestHash,
      responseJson: receipt.responseJson,
    });
  }
  if (candidate.lastClientSeq === 0 && receipts.length !== 0) return null;
  if (candidate.lastClientSeq > 0) {
    if (!receipts.length || receipts.at(-1)?.clientSeq !== candidate.lastClientSeq) return null;
    for (let index = 1; index < receipts.length; index++) {
      if (receipts[index]!.clientSeq !== receipts[index - 1]!.clientSeq + 1) return null;
    }
  }
  const normalized: TransferHandoff = {
    v: 1,
    lastClientSeq: candidate.lastClientSeq,
    receipts,
    gameplay: {
      turns: gameplay.turns,
      hunger: gameplay.hunger,
      maxHunger: gameplay.maxHunger,
      hungerState: gameplay.hungerState,
      hp: gameplay.hp,
      alive: gameplay.alive,
    },
  };
  return encoder.encode(JSON.stringify(normalized)).byteLength <= MAX_TRANSFER_HANDOFF_BYTES
    ? normalized
    : null;
}

function handoffFailureCode(candidate: unknown): SessionFailure["code"] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "invalid_request";
  }
  const value = candidate as { lastClientSeq?: unknown; receipts?: unknown };
  if (!isNonNegativeSafeInteger(value.lastClientSeq) || !Array.isArray(value.receipts)) {
    return "invalid_request";
  }
  const sequences = value.receipts.map((receipt) =>
    receipt && typeof receipt === "object"
      ? (receipt as { clientSeq?: unknown }).clientSeq
      : undefined,
  );
  if (
    (value.lastClientSeq === 0 && sequences.length !== 0) ||
    (value.lastClientSeq > 0 &&
      (!sequences.length || sequences.at(-1) !== value.lastClientSeq)) ||
    sequences.some(
      (sequence, index) =>
        index > 0 && Number(sequence) !== Number(sequences[index - 1]) + 1,
    )
  ) {
    return "handoff_sequence_gap";
  }
  return "handoff_conflict";
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function canonicalRequest(kind: string, values: unknown[]): string {
  return JSON.stringify([kind, ...values]);
}

async function deriveCapabilityUuid(domain: string, values: unknown[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([domain, ...values]))),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deriveSourceAuthorityToken(input: {
  playerId: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  floorObjectName: string;
  connectionId: string;
  transferId: string;
  resumeProofHash: string;
}): Promise<string> {
  return deriveCapabilityUuid("grokhack-source-transfer-authority-v1", [
    input.playerId.toLowerCase(),
    input.sessionEpoch,
    input.authorityEpoch,
    input.leaseId.toLowerCase(),
    input.floorObjectName,
    input.connectionId.toLowerCase(),
    input.transferId.toLowerCase(),
    input.resumeProofHash.toLowerCase(),
  ]);
}

export async function deriveTargetControlToken(input: PrepareTransferRequest): Promise<string> {
  return deriveCapabilityUuid("grokhack-target-transfer-control-v1", [
    input.playerId.toLowerCase(),
    input.transferId.toLowerCase(),
    input.target.sessionEpoch,
    input.target.authorityEpoch,
    input.target.leaseId.toLowerCase(),
    input.target.floorObjectName,
    input.target.locationHint,
    input.resumeProofHash.toLowerCase(),
  ]);
}

export class PlayerSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _player_session_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        object_name TEXT NOT NULL,
        environment TEXT NOT NULL,
        player_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_epoch INTEGER NOT NULL CHECK (session_epoch > 0),
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
        lease_id TEXT NOT NULL,
        floor_object_name TEXT NOT NULL,
        location_hint TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        resume_proof_hash TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_transfers (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        transfer_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('frozen', 'prepared', 'committed', 'activated', 'aborted')),
        mode TEXT CHECK (mode IS NULL OR mode IN ('transfer', 'takeover')),
        source_session_epoch INTEGER NOT NULL,
        source_authority_epoch INTEGER NOT NULL,
        source_lease_id TEXT NOT NULL,
        source_floor_object_name TEXT NOT NULL,
        source_location_hint TEXT NOT NULL,
        source_connection_id TEXT NOT NULL,
        target_session_epoch INTEGER,
        target_authority_epoch INTEGER,
        target_lease_id TEXT,
        target_floor_object_name TEXT,
        target_location_hint TEXT,
        handoff_json TEXT NOT NULL,
        source_authority_token TEXT NOT NULL DEFAULT '',
        target_control_token TEXT,
        cleanup_status TEXT NOT NULL DEFAULT 'none' CHECK (cleanup_status IN ('none', 'pending', 'completed')),
        abort_status TEXT NOT NULL DEFAULT 'none' CHECK (abort_status IN ('none', 'in_progress')),
        abort_operation_id TEXT,
        abort_request_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL DEFAULT 'authorize_join',
        transfer_id TEXT,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        resulting_version INTEGER NOT NULL CHECK (resulting_version >= 0),
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS session_operations_created
        ON session_operations(created_at DESC);
    `);
    const stateColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(session_state)")
        .toArray()
        .map((column) => column.name),
    );
    if (!stateColumns.has("resume_proof_hash")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_state ADD COLUMN resume_proof_hash TEXT NOT NULL DEFAULT ''",
      );
    }
    const operationColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(session_operations)")
        .toArray()
        .map((column) => column.name),
    );
    if (!operationColumns.has("operation_kind")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE session_operations ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'authorize_join'",
      );
    }
    if (!operationColumns.has("transfer_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE session_operations ADD COLUMN transfer_id TEXT");
    }
    const transferColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(session_transfers)")
        .toArray()
        .map((column) => column.name),
    );
    const transferExpansions = [
      ["source_authority_token", "TEXT NOT NULL DEFAULT ''"],
      ["target_control_token", "TEXT"],
      ["cleanup_status", "TEXT NOT NULL DEFAULT 'none' CHECK (cleanup_status IN ('none', 'pending', 'completed'))"],
      ["abort_status", "TEXT NOT NULL DEFAULT 'none' CHECK (abort_status IN ('none', 'in_progress'))"],
      ["abort_operation_id", "TEXT"],
      ["abort_request_hash", "TEXT"],
    ] as const;
    for (const [name, definition] of transferExpansions) {
      if (!transferColumns.has(name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE session_transfers ADD COLUMN ${name} ${definition}`);
      }
    }
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO _player_session_schema_migrations (version, applied_at)
        VALUES (1, unixepoch());
      INSERT OR IGNORE INTO _player_session_schema_migrations (version, applied_at)
        VALUES (2, unixepoch());
    `);
  }

  async authorizeJoin(input: AuthorizeJoinRequest): Promise<AuthorizeJoinResult> {
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    if (!validJoinRequest(input, environment)) return { ok: false, code: "invalid_request" };
    if (!this.objectIdentityMatches(environment, input.playerId)) {
      return { ok: false, code: "identity_mismatch" };
    }
    let resumeProofHash: string;
    try {
      const key = requireEdgeConfig(this.env).routeTicketVerificationKeys.find(
        (candidate) => candidate.keyId === input.keyId,
      );
      if (!key) return { ok: false, code: "resume_proof_mismatch" };
      resumeProofHash = await openResumeProofGrant(input.resumeProofGrant, key.secret, {
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: input.floorObjectName,
        keyId: input.keyId,
        jti: input.operationId,
        expiresAt: input.expiresAt,
      });
    } catch {
      return { ok: false, code: "resume_proof_mismatch" };
    }
    const requestHash = canonicalRequest("authorize_join", [
      input.environment,
      input.playerId.toLowerCase(),
      input.sessionEpoch,
      input.authorityEpoch,
      input.leaseId.toLowerCase(),
      input.floorObjectName,
      input.locationHint,
      input.connectionId.toLowerCase(),
      input.keyId,
      input.expiresAt,
      input.resumeProofGrant,
    ]);

    return this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<AuthorizeJoinResult>(input.operationId, requestHash);
      if (replay) return replay;
      if (!this.bindIdentity(environment, input.playerId)) {
        return this.recordAndReturn(
          input.operationId,
          "authorize_join",
          null,
          requestHash,
          { ok: false, code: "identity_mismatch" },
          0,
        );
      }
      let current = this.getState();
      if (!current) {
        const version = 1;
        this.ctx.storage.sql.exec(
          `INSERT INTO session_state
             (singleton, session_epoch, authority_epoch, lease_id, floor_object_name,
              location_hint, connection_id, resume_proof_hash, version, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
          input.sessionEpoch,
          input.authorityEpoch,
          input.leaseId.toLowerCase(),
          input.floorObjectName,
          input.locationHint,
          input.connectionId.toLowerCase(),
          resumeProofHash,
          version,
        );
        return this.recordAndReturn(
          input.operationId,
          "authorize_join",
          null,
          requestHash,
          {
            ok: true,
            decision: "initial_bound",
            fence: this.fenceFromJoin(input),
            version,
          },
          version,
        );
      }

      // Safe adjacent-schema enrollment: only an exact already-authorized route
      // can bind the new hash on a store created before the hash column existed.
      if (current.resume_proof_hash === "") {
        if (!this.joinMatchesState(input, current)) {
          return this.recordAndReturn(
            input.operationId,
            "authorize_join",
            null,
            requestHash,
            { ok: false, code: "resume_proof_mismatch", version: current.version },
            current.version,
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE session_state SET resume_proof_hash = ?, updated_at = unixepoch() WHERE singleton = 1 AND version = ?",
          resumeProofHash,
          current.version,
        );
        current = { ...current, resume_proof_hash: resumeProofHash };
      }
      if (!constantTimeHexEqual(resumeProofHash, current.resume_proof_hash)) {
        return this.recordAndReturn(
          input.operationId,
          "authorize_join",
          null,
          requestHash,
          { ok: false, code: "resume_proof_mismatch", version: current.version },
          current.version,
        );
      }

      const transfer = this.getTransfer();
      if (transfer?.phase === "committed" && this.joinMatchesTransferTarget(input, transfer)) {
        if (!transfer.target_control_token) {
          return this.recordAndReturn(
            input.operationId,
            "authorize_join",
            transfer.transfer_id,
            requestHash,
            { ok: false, code: "transfer_not_prepared", version: current.version },
            current.version,
          );
        }
        const version = current.version + 1;
        this.ctx.storage.sql.exec(
          `UPDATE session_state SET connection_id = ?, version = ?, updated_at = unixepoch()
           WHERE singleton = 1 AND version = ?`,
          input.connectionId.toLowerCase(),
          version,
          current.version,
        );
        const result: AuthorizeJoinResult = {
          ok: true,
          decision: "transfer_target",
          fence: this.fenceFromJoin(input),
          transferId: transfer.transfer_id,
          handoff: JSON.parse(transfer.handoff_json) as TransferHandoff,
          targetControlToken: transfer.target_control_token,
          version,
        };
        return this.recordAndReturn(
          input.operationId,
          "authorize_join",
          transfer.transfer_id,
          requestHash,
          result,
          version,
        );
      }
      if (transfer && (transfer.phase === "frozen" || transfer.phase === "prepared")) {
        const matchesTarget =
          transfer.phase === "prepared" && this.joinMatchesTransferTarget(input, transfer);
        const result: AuthorizeJoinResult = {
          ok: false,
          code: matchesTarget ? "transfer_not_committed" : "transfer_in_progress",
          version: current.version,
        };
        return this.recordAndReturn(
          input.operationId,
          "authorize_join",
          transfer.transfer_id,
          requestHash,
          result,
          current.version,
        );
      }

      let result: AuthorizeJoinResult;
      if (input.sessionEpoch < current.session_epoch || input.authorityEpoch < current.authority_epoch) {
        result = { ok: false, code: "stale_fence", version: current.version };
      } else if (input.sessionEpoch > current.session_epoch) {
        result = { ok: false, code: "takeover_required", version: current.version };
      } else if (this.joinMatchesState(input, current)) {
        const version = current.version + 1;
        this.ctx.storage.sql.exec(
          `UPDATE session_state
           SET connection_id = ?, version = ?, updated_at = unixepoch()
           WHERE singleton = 1 AND version = ?`,
          input.connectionId.toLowerCase(),
          version,
          current.version,
        );
        result = {
          ok: true,
          decision: "same_route",
          fence: this.fenceFromJoin(input),
          version,
        };
      } else if (input.floorObjectName !== current.floor_object_name) {
        result = { ok: false, code: "transfer_required", version: current.version };
      } else {
        result = { ok: false, code: "stale_fence", version: current.version };
      }
      return this.recordAndReturn(
        input.operationId,
        "authorize_join",
        null,
        requestHash,
        result,
        result.version ?? current.version,
      );
    });
  }

  async freezeTransfer(input: FreezeTransferRequest): Promise<TransferResult> {
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    if (
      !validEnvironmentIdentity(input.environment, input.playerId, environment) ||
      !validFence(input) ||
      !isTokenId(input.operationId) ||
      !isUuid(input.transferId) ||
      !isUuid(input.connectionId) ||
      !isPositiveSafeInteger(input.expectedVersion) ||
      !isSha256Hex(input.resumeProofHash)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.objectIdentityMatches(environment, input.playerId)) {
      return { ok: false, code: "identity_mismatch" };
    }
    const requestHash = canonicalRequest("freeze_transfer", [
      input.environment,
      input.playerId.toLowerCase(),
      input.sessionEpoch,
      input.authorityEpoch,
      input.leaseId.toLowerCase(),
      input.floorObjectName,
      input.connectionId.toLowerCase(),
      input.expectedVersion,
      input.resumeProofHash,
    ]);
    const early = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return { done: true as const, result: replay };
      const current = this.getState();
      if (!current) {
        return {
          done: true as const,
          result: this.transferFailure(input, "freeze_transfer", requestHash, "no_active_session", 0),
        };
      }
      if (!constantTimeHexEqual(input.resumeProofHash, current.resume_proof_hash)) {
        return {
          done: true as const,
          result: this.transferFailure(input, "freeze_transfer", requestHash, "resume_proof_mismatch", current.version),
        };
      }
      if (current.version !== input.expectedVersion) {
        return {
          done: true as const,
          result: this.transferFailure(input, "freeze_transfer", requestHash, "version_conflict", current.version),
        };
      }
      if (!this.fenceMatchesState(input, current) || input.connectionId.toLowerCase() !== current.connection_id) {
        return {
          done: true as const,
          result: this.transferFailure(input, "freeze_transfer", requestHash, "stale_fence", current.version),
        };
      }
      const prior = this.getTransfer();
      if (prior && prior.phase !== "activated" && prior.phase !== "aborted") {
        return {
          done: true as const,
          result: this.transferFailure(input, "freeze_transfer", requestHash, "transfer_in_progress", current.version),
        };
      }
      return { done: false as const };
    });
    if (early.done) return early.result;

    // Stable derivation closes the crash window between the source binding the
    // capability and this object durably recording the transfer row. An exact
    // retry reconstructs the same unguessable token from the internal proof.
    const authorityToken = await deriveSourceAuthorityToken(input);
    const source = this.env.FLOOR_INSTANCES.getByName(input.floorObjectName);
    let sourceFreeze;
    try {
      sourceFreeze = await source.bindFrozenTransfer({
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: input.floorObjectName,
        connectionId: input.connectionId,
        transferId: input.transferId,
        operationId: input.operationId,
        authorityToken,
      });
    } catch {
      return { ok: false, code: "source_freeze_unavailable" };
    }
    if (!sourceFreeze.ok || sourceFreeze.phase !== "frozen") {
      const replay = this.ctx.storage.transactionSync(() =>
        this.replayOperation<TransferResult>(input.operationId, requestHash),
      );
      return replay ?? { ok: false, code: "source_not_frozen" };
    }
    const handoff = normalizeHandoff(sourceFreeze.handoff);
    if (!handoff || !handoff.gameplay.alive) {
      await this.releaseUncommittedSource(input, authorityToken);
      return {
        ok: false,
        code: !handoff ? handoffFailureCode(sourceFreeze.handoff) : "terminal_state",
      };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return replay;
      const current = this.getState();
      if (!current) return { ok: false, code: "no_active_session" } as TransferResult;
      const adopted = this.getTransfer();
      const adoptedEquivalentFreeze = Boolean(
        adopted &&
          adopted.transfer_id === input.transferId.toLowerCase() &&
          adopted.phase === "frozen" &&
          adopted.abort_status === "none" &&
          adopted.source_session_epoch === input.sessionEpoch &&
          adopted.source_authority_epoch === input.authorityEpoch &&
          adopted.source_lease_id === input.leaseId.toLowerCase() &&
          adopted.source_floor_object_name === input.floorObjectName &&
          adopted.source_connection_id === input.connectionId.toLowerCase() &&
          adopted.source_authority_token === authorityToken.toLowerCase() &&
          adopted.handoff_json === JSON.stringify(handoff) &&
          current.version - input.expectedVersion === 1 &&
          this.transferSourceMatchesState(adopted, current)
      );
      if (adoptedEquivalentFreeze && adopted) {
        return this.recordAndReturn(
          input.operationId,
          "freeze_transfer",
          input.transferId,
          requestHash,
          this.transferResultFromRow(input.playerId, adopted, current.version),
          current.version,
        );
      }
      if (
        current.version !== input.expectedVersion ||
        !this.fenceMatchesState(input, current) ||
        current.connection_id !== input.connectionId.toLowerCase() ||
        !constantTimeHexEqual(input.resumeProofHash, current.resume_proof_hash)
      ) {
        return { ok: false, code: "version_conflict", version: current.version } as TransferResult;
      }
      const prior = adopted;
      if (prior && prior.phase !== "activated" && prior.phase !== "aborted") {
        return { ok: false, code: "transfer_in_progress", version: current.version } as TransferResult;
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO session_transfers
           (singleton, transfer_id, phase, mode,
            source_session_epoch, source_authority_epoch, source_lease_id,
            source_floor_object_name, source_location_hint, source_connection_id,
            target_session_epoch, target_authority_epoch, target_lease_id,
            target_floor_object_name, target_location_hint, handoff_json,
            source_authority_token, target_control_token, cleanup_status,
            abort_status, abort_operation_id, abort_request_hash, created_at, updated_at)
         VALUES (1, ?, 'frozen', NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 'none', 'none', NULL, NULL, unixepoch(), unixepoch())
         ON CONFLICT(singleton) DO UPDATE SET
           transfer_id = excluded.transfer_id, phase = excluded.phase, mode = NULL,
           source_session_epoch = excluded.source_session_epoch,
           source_authority_epoch = excluded.source_authority_epoch,
           source_lease_id = excluded.source_lease_id,
           source_floor_object_name = excluded.source_floor_object_name,
           source_location_hint = excluded.source_location_hint,
           source_connection_id = excluded.source_connection_id,
           target_session_epoch = NULL, target_authority_epoch = NULL,
           target_lease_id = NULL, target_floor_object_name = NULL,
           target_location_hint = NULL, handoff_json = excluded.handoff_json,
           source_authority_token = excluded.source_authority_token,
           target_control_token = NULL, cleanup_status = 'none', abort_status = 'none',
           abort_operation_id = NULL, abort_request_hash = NULL,
           created_at = excluded.created_at, updated_at = excluded.updated_at`,
        input.transferId.toLowerCase(),
        input.sessionEpoch,
        input.authorityEpoch,
        input.leaseId.toLowerCase(),
        input.floorObjectName,
        current.location_hint,
        input.connectionId.toLowerCase(),
        JSON.stringify(handoff),
        authorityToken.toLowerCase(),
      );
      this.bumpVersion(current.version, version);
      const result: TransferResult = {
        ok: true,
        transferId: input.transferId.toLowerCase(),
        phase: "frozen",
        sourceFence: this.fenceFromState(input.playerId, current),
        version,
      };
      return this.recordAndReturn(input.operationId, "freeze_transfer", input.transferId, requestHash, result, version);
    });
    if (!result.ok) {
      await this.releaseUncommittedSource(input, authorityToken);
    }
    return result;
  }

  async prepareTransfer(input: PrepareTransferRequest): Promise<TransferResult> {
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    const targetFence: SessionAuthorityFence = {
      playerId: input.playerId,
      sessionEpoch: input.target?.sessionEpoch,
      authorityEpoch: input.target?.authorityEpoch,
      leaseId: input.target?.leaseId,
      floorObjectName: input.target?.floorObjectName,
    };
    if (
      !validEnvironmentIdentity(input.environment, input.playerId, environment) ||
      !input.target ||
      !validFence(targetFence) ||
      !LOCATION_HINTS.has(input.target.locationHint) ||
      !isTokenId(input.operationId) ||
      !isUuid(input.transferId) ||
      !isPositiveSafeInteger(input.expectedVersion) ||
      !isSha256Hex(input.resumeProofHash)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.objectIdentityMatches(environment, input.playerId)) return { ok: false, code: "identity_mismatch" };
    const requestHash = canonicalRequest("prepare_transfer", [
      input.environment,
      input.playerId.toLowerCase(),
      input.transferId.toLowerCase(),
      input.expectedVersion,
      input.resumeProofHash,
      targetFence.sessionEpoch,
      targetFence.authorityEpoch,
      targetFence.leaseId.toLowerCase(),
      targetFence.floorObjectName,
      input.target.locationHint,
    ]);
    const early = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return { done: true as const, result: replay };
      const current = this.getState();
      if (!current) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "no_active_session", 0) };
      }
      if (!constantTimeHexEqual(input.resumeProofHash, current.resume_proof_hash)) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "resume_proof_mismatch", current.version) };
      }
      const transfer = this.getTransfer();
      if (!transfer || transfer.transfer_id !== input.transferId.toLowerCase()) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "transfer_id_mismatch", current.version) };
      }
      if (transfer.phase !== "frozen" || transfer.abort_status !== "none") {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "transfer_not_frozen", current.version) };
      }
      if (current.version !== input.expectedVersion) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "version_conflict", current.version) };
      }
      if (!this.transferSourceMatchesState(transfer, current)) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "stale_fence", current.version) };
      }
      const mode = this.transferMode(transfer, targetFence);
      if (!mode) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "invalid_target", current.version) };
      }
      const handoff = normalizeHandoff(JSON.parse(transfer.handoff_json) as TransferHandoff);
      if (!handoff) {
        return { done: true as const, result: this.transferFailure(input, "prepare_transfer", requestHash, "handoff_conflict", current.version) };
      }
      return { done: false as const, transfer, mode, handoff };
    });
    if (early.done) return early.result;

    // As with the source capability, an exact retry must reconstruct this token
    // if the destination commits preparation before this object persists it.
    const controlToken = await deriveTargetControlToken(input);
    const preparation = {
      transferId: input.transferId,
      operationId: input.operationId,
      playerId: input.playerId,
      sessionEpoch: targetFence.sessionEpoch,
      authorityEpoch: targetFence.authorityEpoch,
      leaseId: targetFence.leaseId,
      floorObjectName: targetFence.floorObjectName,
      controlToken,
      handoff: early.handoff,
    };
    const target = this.env.FLOOR_INSTANCES.getByName(targetFence.floorObjectName);
    let prepared;
    try {
      prepared = await target.prepareTransferImport(preparation);
    } catch {
      return { ok: false, code: "target_prepare_unavailable" };
    }
    if (!prepared.ok) {
      return { ok: false, code: "target_prepare_failed" };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return replay;
      const current = this.getState();
      const transfer = this.getTransfer();
      const adoptedEquivalentPreparation = Boolean(
        current &&
          transfer &&
          transfer.transfer_id === input.transferId.toLowerCase() &&
          transfer.phase === "prepared" &&
          transfer.abort_status === "none" &&
          transfer.target_session_epoch === targetFence.sessionEpoch &&
          transfer.target_authority_epoch === targetFence.authorityEpoch &&
          transfer.target_lease_id === targetFence.leaseId.toLowerCase() &&
          transfer.target_floor_object_name === targetFence.floorObjectName &&
          transfer.target_location_hint === input.target.locationHint &&
          transfer.target_control_token === controlToken.toLowerCase() &&
          current.version - input.expectedVersion === 1
      );
      if (adoptedEquivalentPreparation && current && transfer) {
        return this.recordAndReturn(
          input.operationId,
          "prepare_transfer",
          input.transferId,
          requestHash,
          this.transferResultFromRow(input.playerId, transfer, current.version),
          current.version,
        );
      }
      if (
        !current ||
        !transfer ||
        transfer.transfer_id !== input.transferId.toLowerCase() ||
        transfer.phase !== "frozen" ||
        transfer.abort_status !== "none" ||
        current.version !== input.expectedVersion ||
        !this.transferSourceMatchesState(transfer, current)
      ) {
        return {
          ok: false,
          code: "version_conflict",
          ...(current ? { version: current.version } : {}),
        } as TransferResult;
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_transfers
         SET phase = 'prepared', mode = ?, target_session_epoch = ?,
             target_authority_epoch = ?, target_lease_id = ?,
             target_floor_object_name = ?, target_location_hint = ?,
             target_control_token = ?, updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ? AND phase = 'frozen'`,
        early.mode,
        targetFence.sessionEpoch,
        targetFence.authorityEpoch,
        targetFence.leaseId.toLowerCase(),
        targetFence.floorObjectName,
        input.target.locationHint,
        controlToken.toLowerCase(),
        input.transferId.toLowerCase(),
      );
      this.bumpVersion(current.version, version);
      const result: TransferResult = {
        ok: true,
        transferId: input.transferId.toLowerCase(),
        phase: "prepared",
        mode: early.mode,
        sourceFence: this.fenceFromTransferSource(input.playerId, transfer),
        targetFence: { ...targetFence, playerId: input.playerId.toLowerCase(), leaseId: targetFence.leaseId.toLowerCase() },
        version,
      };
      return this.recordAndReturn(input.operationId, "prepare_transfer", input.transferId, requestHash, result, version);
    });
    if (!result.ok) {
      try {
        await target.abortPreparedTransferImport(preparation);
      } catch {
        // Staging grants no command authority; a later retry can clean the orphan safely.
      }
    }
    return result;
  }

  commitTransfer(input: CommitTransferRequest): TransferResult {
    return this.commitPreparedTransfer(input);
  }

  async abortTransfer(input: AbortTransferRequest): Promise<TransferResult> {
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    if (
      !validEnvironmentIdentity(input.environment, input.playerId, environment) ||
      !isTokenId(input.operationId) ||
      !isUuid(input.transferId) ||
      !isPositiveSafeInteger(input.expectedVersion) ||
      !isSha256Hex(input.resumeProofHash)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.objectIdentityMatches(environment, input.playerId)) {
      return { ok: false, code: "identity_mismatch" };
    }
    const requestHash = canonicalRequest("abort_transfer", [
      input.environment,
      input.playerId.toLowerCase(),
      input.transferId.toLowerCase(),
      input.expectedVersion,
      input.resumeProofHash,
    ]);
    const started = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return { done: true as const, result: replay };
      const current = this.getState();
      if (!current) {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "no_active_session", 0) };
      }
      if (!constantTimeHexEqual(input.resumeProofHash, current.resume_proof_hash)) {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "resume_proof_mismatch", current.version) };
      }
      const transfer = this.getTransfer();
      if (!transfer || transfer.transfer_id !== input.transferId.toLowerCase()) {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "transfer_id_mismatch", current.version) };
      }
      if (transfer.phase === "committed" || transfer.phase === "activated") {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "commit_irreversible", current.version) };
      }
      if (transfer.abort_status === "in_progress") {
        if (
          transfer.abort_operation_id !== input.operationId ||
          transfer.abort_request_hash !== requestHash
        ) {
          return { done: true as const, result: { ok: false, code: "idempotency_conflict", version: current.version } as TransferResult };
        }
        return { done: false as const, transfer, version: current.version };
      }
      if (current.version !== input.expectedVersion) {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "version_conflict", current.version) };
      }
      if (transfer.phase !== "frozen" && transfer.phase !== "prepared") {
        return { done: true as const, result: this.transferFailure(input, "abort_transfer", requestHash, "transfer_not_frozen", current.version) };
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_transfers SET abort_status = 'in_progress',
             abort_operation_id = ?, abort_request_hash = ?, updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ? AND abort_status = 'none'`,
        input.operationId,
        requestHash,
        input.transferId.toLowerCase(),
      );
      this.bumpVersion(current.version, version);
      return { done: false as const, transfer: { ...transfer, abort_status: "in_progress" as const }, version };
    });
    if (started.done) return started.result;
    await this.ctx.storage.setAlarm(Date.now() + 1_000);

    const transfer = started.transfer;
    const handoff = normalizeHandoff(JSON.parse(transfer.handoff_json) as TransferHandoff);
    if (!handoff) return { ok: false, code: "abort_in_progress", version: started.version };
    if (
      transfer.target_control_token &&
      transfer.target_session_epoch !== null &&
      transfer.target_authority_epoch !== null &&
      transfer.target_lease_id &&
      transfer.target_floor_object_name
    ) {
      try {
        const targetAbort = await this.env.FLOOR_INSTANCES.getByName(
          transfer.target_floor_object_name,
        ).abortPreparedTransferImport({
          transferId: transfer.transfer_id,
          operationId: `${transfer.transfer_id}-abort-target`,
          playerId: input.playerId,
          sessionEpoch: transfer.target_session_epoch,
          authorityEpoch: transfer.target_authority_epoch,
          leaseId: transfer.target_lease_id,
          floorObjectName: transfer.target_floor_object_name,
          controlToken: transfer.target_control_token,
          handoff,
        });
        if (!targetAbort.ok) {
          return { ok: false, code: "abort_in_progress", version: started.version };
        }
      } catch {
        return { ok: false, code: "abort_in_progress", version: started.version };
      }
    }
    try {
      const sourceAbort = await this.env.FLOOR_INSTANCES.getByName(
        transfer.source_floor_object_name,
      ).abortFrozenTransfer({
        playerId: input.playerId,
        sessionEpoch: transfer.source_session_epoch,
        authorityEpoch: transfer.source_authority_epoch,
        leaseId: transfer.source_lease_id,
        floorObjectName: transfer.source_floor_object_name,
        connectionId: transfer.source_connection_id,
        transferId: transfer.transfer_id,
        operationId: `${transfer.transfer_id}-abort-source`,
        authorityToken: transfer.source_authority_token,
      });
      if (!sourceAbort.ok) {
        return { ok: false, code: "abort_in_progress", version: started.version };
      }
    } catch {
      return { ok: false, code: "abort_in_progress", version: started.version };
    }

    const completed = this.ctx.storage.transactionSync<TransferResult>(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return replay;
      const current = this.getState();
      const latest = this.getTransfer();
      if (
        !current ||
        !latest ||
        latest.transfer_id !== input.transferId.toLowerCase() ||
        latest.abort_status !== "in_progress" ||
        latest.abort_operation_id !== input.operationId ||
        latest.abort_request_hash !== requestHash
      ) {
        return { ok: false, code: "abort_in_progress", ...(current ? { version: current.version } : {}) };
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_transfers SET phase = 'aborted', abort_status = 'none',
             cleanup_status = 'completed', updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ? AND abort_status = 'in_progress'`,
        input.transferId.toLowerCase(),
      );
      this.bumpVersion(current.version, version);
      const result: TransferResult = {
        ok: true,
        transferId: latest.transfer_id,
        phase: "aborted",
        mode: latest.mode ?? undefined,
        sourceFence: this.fenceFromTransferSource(input.playerId, latest),
        targetFence: this.fenceFromTransferTarget(input.playerId, latest),
        version,
      };
      return this.recordAndReturn(input.operationId, "abort_transfer", input.transferId, requestHash, result, version);
    });
    if (completed.ok && completed.phase === "aborted") await this.ctx.storage.deleteAlarm();
    return completed;
  }

  async activateTransfer(input: ActivateTransferRequest): Promise<TransferResult> {
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    if (
      !validEnvironmentIdentity(input.environment, input.playerId, environment) ||
      !validFence(input) ||
      !isTokenId(input.operationId) ||
      !isUuid(input.transferId) ||
      !isUuid(input.connectionId) ||
      !isPositiveSafeInteger(input.expectedVersion) ||
      !isResumeProofGrant(input.resumeProofGrant) ||
      !KEY_ID_RE.test(input.keyId) ||
      !isPositiveSafeInteger(input.expiresAt)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.objectIdentityMatches(environment, input.playerId)) return { ok: false, code: "identity_mismatch" };
    let resumeProofHash: string;
    try {
      const key = requireEdgeConfig(this.env).routeTicketVerificationKeys.find(
        (candidate) => candidate.keyId === input.keyId,
      );
      if (!key) return { ok: false, code: "resume_proof_mismatch" };
      resumeProofHash = await openResumeProofGrant(input.resumeProofGrant, key.secret, {
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: input.floorObjectName,
        keyId: input.keyId,
        jti: input.operationId.replace(/-activate$/u, ""),
        expiresAt: input.expiresAt,
      });
    } catch {
      return { ok: false, code: "resume_proof_mismatch" };
    }
    const requestHash = canonicalRequest("activate_transfer", [
      input.environment,
      input.playerId.toLowerCase(),
      input.transferId.toLowerCase(),
      input.sessionEpoch,
      input.authorityEpoch,
      input.leaseId.toLowerCase(),
      input.floorObjectName,
      input.connectionId.toLowerCase(),
      input.expectedVersion,
      input.keyId,
      input.expiresAt,
      input.resumeProofGrant,
    ]);
    const early = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return { done: true as const, result: replay };
      const current = this.getState();
      if (!current) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "no_active_session", 0) };
      }
      if (!constantTimeHexEqual(resumeProofHash, current.resume_proof_hash)) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "resume_proof_mismatch", current.version) };
      }
      const transfer = this.getTransfer();
      if (!transfer || transfer.transfer_id !== input.transferId.toLowerCase()) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "transfer_id_mismatch", current.version) };
      }
      if (transfer.phase === "activated") {
        if (this.fenceMatchesState(input, current) && current.connection_id === input.connectionId.toLowerCase()) {
          const result = this.transferResultFromRow(input.playerId, transfer, current.version);
          return { done: true as const, result: this.recordAndReturn(input.operationId, "activate_transfer", input.transferId, requestHash, result, current.version) };
        }
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "stale_fence", current.version) };
      }
      if (transfer.phase !== "committed" || !transfer.target_control_token) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "transfer_not_committed", current.version) };
      }
      if (current.version !== input.expectedVersion) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "version_conflict", current.version) };
      }
      if (!this.fenceMatchesState(input, current) || current.connection_id !== input.connectionId.toLowerCase()) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "stale_fence", current.version) };
      }
      const target = this.fenceFromTransferTarget(input.playerId, transfer);
      const handoff = normalizeHandoff(JSON.parse(transfer.handoff_json) as TransferHandoff);
      if (!target || !handoff) {
        return { done: true as const, result: this.transferFailure(input, "activate_transfer", requestHash, "handoff_conflict", current.version) };
      }
      return { done: false as const, transfer, target, handoff };
    });
    if (early.done) {
      if (early.result.ok && early.result.phase === "activated") {
        await this.cleanupActivatedSource(input.playerId, input.transferId);
      }
      return early.result;
    }

    try {
      const confirmation = await this.env.FLOOR_INSTANCES.getByName(
        early.target.floorObjectName,
      ).confirmTransferActivated({
        transferId: input.transferId,
        operationId: `${input.transferId}-confirm-target`,
        playerId: input.playerId,
        sessionEpoch: early.target.sessionEpoch,
        authorityEpoch: early.target.authorityEpoch,
        leaseId: early.target.leaseId,
        floorObjectName: early.target.floorObjectName,
        controlToken: early.transfer.target_control_token!,
        handoff: early.handoff,
      });
      if (!confirmation.ok || confirmation.phase !== "activated") {
        return { ok: false, code: "target_not_activated" };
      }
    } catch {
      return { ok: false, code: "target_activation_unavailable" };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return replay;
      const current = this.getState();
      const transfer = this.getTransfer();
      if (
        !current ||
        !transfer ||
        transfer.transfer_id !== input.transferId.toLowerCase() ||
        transfer.phase !== "committed" ||
        current.version !== input.expectedVersion ||
        !this.fenceMatchesState(input, current) ||
        current.connection_id !== input.connectionId.toLowerCase()
      ) {
        return { ok: false, code: "version_conflict", ...(current ? { version: current.version } : {}) } as TransferResult;
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_transfers SET phase = 'activated', cleanup_status = 'pending',
             updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ? AND phase = 'committed'`,
        input.transferId.toLowerCase(),
      );
      this.bumpVersion(current.version, version);
      const result = this.transferResultFromRow(input.playerId, { ...transfer, phase: "activated" }, version);
      return this.recordAndReturn(input.operationId, "activate_transfer", input.transferId, requestHash, result, version);
    });
    if (result.ok && result.phase === "activated") {
      await this.cleanupActivatedSource(input.playerId, input.transferId);
    }
    return result;
  }

  getSnapshot():
    | (SessionAuthorityFence & {
        environment: string;
        locationHint: string;
        version: number;
        resumeProofBound: boolean;
        transfer: {
          transferId: string;
          phase: TransferPhase;
          mode: TransferMode | null;
          cleanupStatus: "none" | "pending" | "completed";
        } | null;
      })
    | null {
    const state = this.getState();
    if (!state) return null;
    const transfer = this.getTransfer();
    return {
      environment: String(this.env.EDGE_ENVIRONMENT || ""),
      playerId: this.ctx.id.name?.split(":").at(-1) ?? "",
      sessionEpoch: state.session_epoch,
      authorityEpoch: state.authority_epoch,
      leaseId: state.lease_id,
      floorObjectName: state.floor_object_name,
      locationHint: state.location_hint,
      version: state.version,
      resumeProofBound: state.resume_proof_hash.length === 64,
      transfer: transfer
        ? {
            transferId: transfer.transfer_id,
            phase: transfer.phase,
            mode: transfer.mode,
            cleanupStatus: transfer.cleanup_status,
          }
        : null,
    };
  }

  async alarm(): Promise<void> {
    const transfer = this.getTransfer();
    if (transfer?.abort_status === "in_progress") {
      const playerId = this.ctx.id.name?.split(":").at(-1) ?? "";
      const completed = isUuid(playerId)
        ? await this.resumeAbortingTransfer(playerId, transfer)
        : false;
      if (!completed) await this.ctx.storage.setAlarm(Date.now() + 1_000);
      return;
    }
    if (transfer?.phase === "activated" && transfer.cleanup_status === "pending") {
      const playerId = this.ctx.id.name?.split(":").at(-1) ?? "";
      if (isUuid(playerId)) await this.cleanupActivatedSource(playerId, transfer.transfer_id);
    }
  }

  private async resumeAbortingTransfer(playerId: string, transfer: TransferRow): Promise<boolean> {
    if (
      transfer.abort_status !== "in_progress" ||
      !transfer.abort_operation_id ||
      !transfer.abort_request_hash ||
      !isUuid(transfer.source_authority_token)
    ) {
      return false;
    }
    const abortOperationId = transfer.abort_operation_id;
    const abortRequestHash = transfer.abort_request_hash;
    const handoff = normalizeHandoff(JSON.parse(transfer.handoff_json) as TransferHandoff);
    if (!handoff) return false;
    if (
      transfer.target_control_token &&
      transfer.target_session_epoch !== null &&
      transfer.target_authority_epoch !== null &&
      transfer.target_lease_id &&
      transfer.target_floor_object_name
    ) {
      try {
        const target = await this.env.FLOOR_INSTANCES.getByName(
          transfer.target_floor_object_name,
        ).abortPreparedTransferImport({
          transferId: transfer.transfer_id,
          operationId: `${transfer.transfer_id}-abort-target`,
          playerId,
          sessionEpoch: transfer.target_session_epoch,
          authorityEpoch: transfer.target_authority_epoch,
          leaseId: transfer.target_lease_id,
          floorObjectName: transfer.target_floor_object_name,
          controlToken: transfer.target_control_token,
          handoff,
        });
        if (!target.ok) return false;
      } catch {
        return false;
      }
    }
    try {
      const source = await this.env.FLOOR_INSTANCES.getByName(
        transfer.source_floor_object_name,
      ).abortFrozenTransfer({
        playerId,
        sessionEpoch: transfer.source_session_epoch,
        authorityEpoch: transfer.source_authority_epoch,
        leaseId: transfer.source_lease_id,
        floorObjectName: transfer.source_floor_object_name,
        connectionId: transfer.source_connection_id,
        transferId: transfer.transfer_id,
        operationId: `${transfer.transfer_id}-abort-source`,
        authorityToken: transfer.source_authority_token,
      });
      if (!source.ok) return false;
    } catch {
      return false;
    }
    const completed = this.ctx.storage.transactionSync(() => {
      const current = this.getState();
      const latest = this.getTransfer();
      if (
        !current ||
        !latest ||
        latest.transfer_id !== transfer.transfer_id ||
        latest.abort_status !== "in_progress" ||
        latest.abort_operation_id !== transfer.abort_operation_id ||
        latest.abort_request_hash !== transfer.abort_request_hash
      ) {
        return false;
      }
      const replay = this.replayOperation<TransferResult>(
        abortOperationId,
        abortRequestHash,
      );
      if (replay?.ok && replay.phase === "aborted") return true;
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_transfers SET phase = 'aborted', abort_status = 'none',
             cleanup_status = 'completed', updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ? AND abort_status = 'in_progress'`,
        transfer.transfer_id,
      );
      this.bumpVersion(current.version, version);
      const result: TransferResult = {
        ok: true,
        transferId: latest.transfer_id,
        phase: "aborted",
        mode: latest.mode ?? undefined,
        sourceFence: this.fenceFromTransferSource(playerId, latest),
        targetFence: this.fenceFromTransferTarget(playerId, latest),
        version,
      };
      this.recordAndReturn(
        abortOperationId,
        "abort_transfer",
        transfer.transfer_id,
        abortRequestHash,
        result,
        version,
      );
      return true;
    });
    if (completed) await this.ctx.storage.deleteAlarm();
    return completed;
  }

  private async cleanupActivatedSource(playerId: string, transferId: string): Promise<void> {
    const transfer = this.getTransfer();
    if (
      !transfer ||
      transfer.transfer_id !== transferId.toLowerCase() ||
      transfer.phase !== "activated" ||
      transfer.cleanup_status === "completed" ||
      !isUuid(transfer.source_authority_token)
    ) {
      return;
    }
    let finalized: boolean;
    try {
      const result = await this.env.FLOOR_INSTANCES.getByName(
        transfer.source_floor_object_name,
      ).finalizeFrozenTransfer({
        playerId,
        sessionEpoch: transfer.source_session_epoch,
        authorityEpoch: transfer.source_authority_epoch,
        leaseId: transfer.source_lease_id,
        floorObjectName: transfer.source_floor_object_name,
        connectionId: transfer.source_connection_id,
        transferId: transfer.transfer_id,
        operationId: `${transfer.transfer_id}-finalize-source`,
        authorityToken: transfer.source_authority_token,
      });
      finalized = result.ok && result.phase === "finalized";
    } catch {
      finalized = false;
    }
    if (finalized) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE session_transfers SET cleanup_status = 'completed', updated_at = unixepoch()
           WHERE singleton = 1 AND transfer_id = ? AND phase = 'activated'
             AND cleanup_status = 'pending'`,
          transfer.transfer_id,
        );
      });
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
  }

  private async releaseUncommittedSource(
    input: FreezeTransferRequest,
    authorityToken: string,
  ): Promise<void> {
    const source = this.env.FLOOR_INSTANCES.getByName(input.floorObjectName);
    try {
      const released = await source.releaseBoundTransfer({
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: input.floorObjectName,
        connectionId: input.connectionId,
        transferId: input.transferId,
        operationId: `${input.transferId}-release`,
        authorityToken,
      });
      if (!released.ok) return;
      await source.cancelUnboundFreeze({
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: input.floorObjectName,
        connectionId: input.connectionId,
        transferId: input.transferId,
        operationId: `${input.transferId}-cancel`,
      });
    } catch {
      // The exact retry reconstructs the same capability and can resume safely.
    }
  }

  private commitPreparedTransfer(input: CommitTransferRequest): TransferResult {
    const kind = "commit_transfer";
    const environment = String(this.env.EDGE_ENVIRONMENT || "");
    if (
      !validEnvironmentIdentity(input.environment, input.playerId, environment) ||
      !isTokenId(input.operationId) ||
      !isUuid(input.transferId) ||
      !isPositiveSafeInteger(input.expectedVersion) ||
      !isSha256Hex(input.resumeProofHash)
    ) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.objectIdentityMatches(environment, input.playerId)) return { ok: false, code: "identity_mismatch" };
    const requestHash = canonicalRequest(kind, [
      input.environment,
      input.playerId.toLowerCase(),
      input.transferId.toLowerCase(),
      input.expectedVersion,
      input.resumeProofHash,
    ]);
    return this.ctx.storage.transactionSync(() => {
      const replay = this.replayOperation<TransferResult>(input.operationId, requestHash);
      if (replay) return replay;
      const current = this.getState();
      if (!current) return this.transferFailure(input, kind, requestHash, "no_active_session", 0);
      if (!constantTimeHexEqual(input.resumeProofHash, current.resume_proof_hash)) {
        return this.transferFailure(input, kind, requestHash, "resume_proof_mismatch", current.version);
      }
      const transfer = this.getTransfer();
      if (!transfer || transfer.transfer_id !== input.transferId.toLowerCase()) {
        return this.transferFailure(input, kind, requestHash, "transfer_id_mismatch", current.version);
      }
      if (current.version !== input.expectedVersion) {
        return this.transferFailure(input, kind, requestHash, "version_conflict", current.version);
      }
      if (
        transfer.phase !== "prepared" ||
        transfer.abort_status !== "none" ||
        !transfer.target_control_token
      ) {
        return this.transferFailure(input, kind, requestHash, "transfer_not_prepared", current.version);
      }
      const target = this.fenceFromTransferTarget(input.playerId, transfer);
      if (!target || !transfer.target_location_hint) {
        return this.transferFailure(input, kind, requestHash, "invalid_target", current.version);
      }
      const version = current.version + 1;
      this.ctx.storage.sql.exec(
        `UPDATE session_state
         SET session_epoch = ?, authority_epoch = ?, lease_id = ?, floor_object_name = ?,
             location_hint = ?, connection_id = '', version = ?, updated_at = unixepoch()
         WHERE singleton = 1 AND version = ?`,
        target.sessionEpoch,
        target.authorityEpoch,
        target.leaseId,
        target.floorObjectName,
        transfer.target_location_hint,
        version,
        current.version,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session_transfers SET phase = 'committed', updated_at = unixepoch() WHERE singleton = 1 AND transfer_id = ? AND phase = 'prepared'",
        input.transferId.toLowerCase(),
      );
      const result: TransferResult = {
        ok: true,
        transferId: transfer.transfer_id,
        phase: "committed",
        mode: transfer.mode ?? undefined,
        sourceFence: this.fenceFromTransferSource(input.playerId, transfer),
        targetFence: target,
        version,
      };
      return this.recordAndReturn(input.operationId, kind, input.transferId, requestHash, result, version);
    });
  }

  private objectIdentityMatches(environment: string, playerId: string): boolean {
    return this.ctx.id.name === playerSessionObjectName(environment, playerId);
  }

  private bindIdentity(environment: string, playerId: string): boolean {
    const expectedObjectName = playerSessionObjectName(environment, playerId);
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO session_identity
         (singleton, object_name, environment, player_id) VALUES (1, ?, ?, ?)`,
      expectedObjectName,
      environment,
      playerId.toLowerCase(),
    );
    const identity = firstRow(
      this.ctx.storage.sql.exec<IdentityRow>(
        "SELECT object_name, environment, player_id FROM session_identity WHERE singleton = 1",
      ),
    );
    return Boolean(
      identity &&
        identity.object_name === expectedObjectName &&
        identity.environment === environment &&
        identity.player_id === playerId.toLowerCase(),
    );
  }

  private getState(): StateRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<StateRow>(
        `SELECT session_epoch, authority_epoch, lease_id, floor_object_name,
                location_hint, connection_id, resume_proof_hash, version
         FROM session_state WHERE singleton = 1`,
      ),
    );
  }

  private getTransfer(): TransferRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<TransferRow>(
        `SELECT transfer_id, phase, mode, source_session_epoch, source_authority_epoch,
                source_lease_id, source_floor_object_name, source_location_hint,
                source_connection_id, target_session_epoch, target_authority_epoch,
                target_lease_id, target_floor_object_name, target_location_hint, handoff_json,
                source_authority_token, target_control_token, cleanup_status, abort_status,
                abort_operation_id, abort_request_hash
         FROM session_transfers WHERE singleton = 1`,
      ),
    );
  }

  private bumpVersion(expected: number, version: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE session_state SET version = ?, updated_at = unixepoch() WHERE singleton = 1 AND version = ?",
      version,
      expected,
    );
  }

  private joinMatchesState(input: AuthorizeJoinRequest, state: StateRow): boolean {
    return (
      input.sessionEpoch === state.session_epoch &&
      input.authorityEpoch === state.authority_epoch &&
      input.leaseId.toLowerCase() === state.lease_id &&
      input.floorObjectName === state.floor_object_name &&
      input.locationHint === state.location_hint
    );
  }

  private fenceMatchesState(input: SessionAuthorityFence, state: StateRow): boolean {
    return (
      input.sessionEpoch === state.session_epoch &&
      input.authorityEpoch === state.authority_epoch &&
      input.leaseId.toLowerCase() === state.lease_id &&
      input.floorObjectName === state.floor_object_name
    );
  }

  private transferSourceMatchesState(transfer: TransferRow, state: StateRow): boolean {
    return (
      transfer.source_session_epoch === state.session_epoch &&
      transfer.source_authority_epoch === state.authority_epoch &&
      transfer.source_lease_id === state.lease_id &&
      transfer.source_floor_object_name === state.floor_object_name &&
      transfer.source_location_hint === state.location_hint &&
      transfer.source_connection_id === state.connection_id
    );
  }

  private joinMatchesTransferTarget(input: AuthorizeJoinRequest, transfer: TransferRow): boolean {
    return (
      input.sessionEpoch === transfer.target_session_epoch &&
      input.authorityEpoch === transfer.target_authority_epoch &&
      input.leaseId.toLowerCase() === transfer.target_lease_id &&
      input.floorObjectName === transfer.target_floor_object_name &&
      input.locationHint === transfer.target_location_hint
    );
  }

  private transferMode(transfer: TransferRow, target: SessionAuthorityFence): TransferMode | null {
    if (
      transfer.source_authority_epoch === Number.MAX_SAFE_INTEGER ||
      target.authorityEpoch !== transfer.source_authority_epoch + 1 ||
      target.leaseId.toLowerCase() === transfer.source_lease_id
    ) {
      return null;
    }
    if (
      target.sessionEpoch === transfer.source_session_epoch &&
      target.floorObjectName !== transfer.source_floor_object_name
    ) {
      return "transfer";
    }
    if (
      transfer.source_session_epoch < Number.MAX_SAFE_INTEGER &&
      target.sessionEpoch === transfer.source_session_epoch + 1
    ) {
      return "takeover";
    }
    return null;
  }

  private fenceFromJoin(input: AuthorizeJoinRequest): SessionAuthorityFence {
    return {
      playerId: input.playerId.toLowerCase(),
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId.toLowerCase(),
      floorObjectName: input.floorObjectName,
    };
  }

  private fenceFromState(playerId: string, state: StateRow): SessionAuthorityFence {
    return {
      playerId: playerId.toLowerCase(),
      sessionEpoch: state.session_epoch,
      authorityEpoch: state.authority_epoch,
      leaseId: state.lease_id,
      floorObjectName: state.floor_object_name,
    };
  }

  private fenceFromTransferSource(playerId: string, transfer: TransferRow): SessionAuthorityFence {
    return {
      playerId: playerId.toLowerCase(),
      sessionEpoch: transfer.source_session_epoch,
      authorityEpoch: transfer.source_authority_epoch,
      leaseId: transfer.source_lease_id,
      floorObjectName: transfer.source_floor_object_name,
    };
  }

  private fenceFromTransferTarget(playerId: string, transfer: TransferRow): SessionAuthorityFence | undefined {
    if (
      transfer.target_session_epoch === null ||
      transfer.target_authority_epoch === null ||
      transfer.target_lease_id === null ||
      transfer.target_floor_object_name === null
    ) {
      return undefined;
    }
    return {
      playerId: playerId.toLowerCase(),
      sessionEpoch: transfer.target_session_epoch,
      authorityEpoch: transfer.target_authority_epoch,
      leaseId: transfer.target_lease_id,
      floorObjectName: transfer.target_floor_object_name,
    };
  }

  private transferResultFromRow(playerId: string, transfer: TransferRow, version: number): TransferResult {
    return {
      ok: true,
      transferId: transfer.transfer_id,
      phase: transfer.phase,
      mode: transfer.mode ?? undefined,
      sourceFence: this.fenceFromTransferSource(playerId, transfer),
      targetFence: this.fenceFromTransferTarget(playerId, transfer),
      version,
    };
  }

  private replayOperation<T>(operationId: string, requestHash: string): T | undefined {
    const prior = firstRow(
      this.ctx.storage.sql.exec<OperationRow>(
        "SELECT request_hash, response_json FROM session_operations WHERE operation_id = ?",
        operationId,
      ),
    );
    if (!prior) return undefined;
    if (prior.request_hash !== requestHash) {
      return { ok: false, code: "idempotency_conflict" } as T;
    }
    return JSON.parse(prior.response_json) as T;
  }

  private transferFailure(
    input: { operationId: string; transferId: string },
    kind: string,
    requestHash: string,
    code: SessionFailure["code"],
    version: number,
  ): TransferResult {
    return this.recordAndReturn(
      input.operationId,
      kind,
      input.transferId,
      requestHash,
      { ok: false, code, ...(version > 0 ? { version } : {}) },
      version,
    );
  }

  private recordAndReturn<T>(
    operationId: string,
    operationKind: string,
    transferId: string | null,
    requestHash: string,
    result: T,
    resultingVersion: number,
  ): T {
    this.ctx.storage.sql.exec(
      `INSERT INTO session_operations
         (operation_id, operation_kind, transfer_id, request_hash, response_json,
          resulting_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
      operationId,
      operationKind,
      transferId?.toLowerCase() ?? null,
      requestHash,
      JSON.stringify(result),
      resultingVersion,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM session_operations
       WHERE transfer_id IS NULL AND operation_id NOT IN (
         SELECT operation_id FROM session_operations
         WHERE transfer_id IS NULL
         ORDER BY created_at DESC, operation_id DESC LIMIT ?
       )`,
      MAX_JOIN_OPERATION_RECEIPTS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM session_operations
       WHERE transfer_id IS NOT NULL
         AND operation_id <> COALESCE(
           (SELECT abort_operation_id FROM session_transfers
            WHERE singleton = 1 AND abort_status = 'in_progress'),
           ''
         )
         AND operation_id NOT IN (
           SELECT operation_id FROM session_operations
           WHERE transfer_id IS NOT NULL
           ORDER BY resulting_version DESC, created_at DESC, operation_id DESC LIMIT ?
         )`,
      MAX_TRANSFER_OPERATION_RECEIPTS,
    );
    return result;
  }
}
