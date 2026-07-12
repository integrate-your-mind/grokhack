import { DurableObject } from "cloudflare:workers";

import {
  MAX_DIRECTORY_PROBES,
  allocationAffinityKey,
  assignmentFor,
  canonicalRequestHash,
  directoryBucketFor,
  floorDescriptorFor,
  floorInstanceIdForSlot,
  parseDirectoryAllocationRequest,
  parseRetirementRequest,
  realmDirectoryObjectName,
  type AllocationFailure,
  type AllocationResult,
  type AllocationSuccess,
  type DirectoryAllocationRequest,
  type FloorCapacitySnapshot,
  type FloorDescriptor,
  type RetirementRequest,
  type RetirementResult,
} from "./allocation-protocol";
import { requireEdgeConfig, type EdgeConfig } from "./config";
import type { Env } from "./env";
import { isUuid } from "./protocol";

const DIRECTORY_SCHEMA_VERSION = 3;

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

interface RevisionRow extends Record<string, SqlStorageValue> {
  revision: number;
}

interface VersionRow extends Record<string, SqlStorageValue> {
  version: number | null;
}

interface ColumnRow extends Record<string, SqlStorageValue> {
  name: string;
}

interface DirectoryIdentityRow extends Record<string, SqlStorageValue> {
  object_name: string;
  environment: string;
  location_hint: string;
  realm_id: string;
  depth: number;
  allocator_layout_version: number;
  bucket_count: number;
  bucket: number;
}

interface SlotRow extends Record<string, SqlStorageValue> {
  floor_slot: number;
  floor_instance_id: string;
  floor_epoch: number;
  state: "active" | "draining";
  lifecycle_version: number;
  observed_live_players: number;
  observed_pending_players: number;
  observed_pending_sockets: number;
  observed_total_sockets: number;
  observed_durable_sessions: number;
  observed_frozen_transfers: number;
  observed_prepared_transfers: number;
  observed_max_players: number;
  observed_accepting: number;
  observed_retirement_required: number;
  observed_at: number;
  last_probe_status: string;
}

interface ReservationRow extends Record<string, SqlStorageValue> {
  affinity_key: string;
  reservation_id: string;
  floor_slot: number;
  floor_epoch: number;
  capacity_units: number;
  expires_at: number;
}

interface OperationRow extends Record<string, SqlStorageValue> {
  operation_kind: "allocate" | "retire";
  request_hash: string;
  response_json: string;
}

interface ReservationPressureRow extends Record<string, SqlStorageValue> {
  units: number;
  expires_at: number;
}

interface ReservationCapacityRow extends Record<string, SqlStorageValue> {
  reservation_id: string;
  capacity_units: number;
}

interface ProbeFailure {
  ok: false;
  overloaded: boolean;
  retryable: boolean;
  remote: boolean;
}

function firstRow<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function durableObjectFailure(error: unknown): ProbeFailure {
  if (!error || typeof error !== "object") {
    return { ok: false, overloaded: false, retryable: false, remote: false };
  }
  const candidate = error as { overloaded?: unknown; retryable?: unknown; remote?: unknown };
  return {
    ok: false,
    overloaded: candidate.overloaded === true,
    retryable: candidate.retryable === true,
    remote: candidate.remote === true,
  };
}

function allocationFailure(
  code: AllocationFailure["code"],
  bucket?: number,
  overrides: Partial<AllocationFailure> = {},
): AllocationFailure {
  return {
    ok: false,
    code,
    retryable: false,
    requiresFreshAssignment: false,
    ...(bucket === undefined ? {} : { bucket }),
    ...overrides,
  };
}

export class RealmDirectory extends DurableObject<Env> {
  private readonly bindings: Env;
  private readonly config: EdgeConfig;
  private readonly schemaCompatible: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    this.config = requireEdgeConfig(env);
    this.schemaCompatible = this.initializeSchema();
  }

  async allocate(candidate: unknown): Promise<AllocationResult> {
    if (!this.schemaCompatible) {
      return allocationFailure("directory_schema_incompatible", undefined, {
        retryable: false,
        requiresFreshAssignment: true,
      });
    }
    let request: DirectoryAllocationRequest;
    try {
      request = parseDirectoryAllocationRequest(candidate);
    } catch {
      return allocationFailure("invalid_request");
    }
    if (
      request.bucketCount !== this.config.realmDirectoryBuckets ||
      request.bucket !== directoryBucketFor(request, request.bucketCount) ||
      request.capacityUnits > this.config.floorSocketCap
    ) {
      return allocationFailure("invalid_request", request.bucket);
    }
    if (!this.bindIdentity(request)) {
      return allocationFailure("identity_mismatch", request.bucket);
    }

    const requestHash = await canonicalRequestHash("allocate", request);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const replay = this.ctx.storage.transactionSync(() => {
      this.purgeExpiredState(nowSeconds);
      return this.replayAllocation(request.operationId, requestHash);
    });
    if (replay) return replay;

    const affinityKey = allocationAffinityKey(request);
    const existing = this.ctx.storage.transactionSync(() =>
      this.activeReservation(affinityKey, nowSeconds),
    );
    if (existing) {
      return this.reuseReservation(request, requestHash, existing);
    }

    const totalSlots = this.slotCount();
    const candidateLimit = totalSlots < this.config.realmDirectoryFloorLimit
      ? MAX_DIRECTORY_PROBES - 1
      : MAX_DIRECTORY_PROBES;
    const slots = this.candidateSlots(candidateLimit, nowSeconds);
    let probes = 0;
    let sawProbeFailure = false;
    let sawOverload = false;

    for (const slot of slots) {
      const outcome = await this.probeSlot(request, slot);
      probes += 1;
      const settled = this.completedOrReserved(request, requestHash, affinityKey);
      if (settled) return settled;
      if (!outcome.ok) {
        sawProbeFailure = true;
        sawOverload ||= outcome.overloaded;
        this.recordProbeFailure(slot, outcome, nowSeconds);
        continue;
      }
      const observedSlot = this.recordSnapshot(slot, outcome, nowSeconds);
      if (!observedSlot) continue;
      if (outcome.retirementRequired || outcome.retired) continue;
      const reserved = this.tryReserve(
        request,
        requestHash,
        affinityKey,
        observedSlot,
        outcome,
        probes,
        "existing_floor",
      );
      if (reserved) return reserved;
    }

    while (probes < MAX_DIRECTORY_PROBES) {
      const settled = this.completedOrReserved(request, requestHash, affinityKey);
      if (settled) return settled;
      const created = this.createOrFindUnobservedSlot(request);
      if (!created) break;
      const outcome = await this.probeSlot(request, created.slot);
      probes += 1;
      const completed = this.completedOrReserved(request, requestHash, affinityKey);
      if (completed) return completed;
      if (!outcome.ok) {
        sawProbeFailure = true;
        sawOverload ||= outcome.overloaded;
        this.recordProbeFailure(created.slot, outcome, nowSeconds);
        continue;
      }
      const observedSlot = this.recordSnapshot(created.slot, outcome, nowSeconds);
      if (observedSlot && !outcome.retirementRequired && !outcome.retired) {
        const reserved = this.tryReserve(
          request,
          requestHash,
          affinityKey,
          observedSlot,
          outcome,
          probes,
          created.created ? "new_floor" : "existing_floor",
        );
        if (reserved) return reserved;
        if (reserved === null) {
          // A concurrent request may have consumed the observed capacity.
          // Probe a fresh slot/version while the four-call budget remains.
          continue;
        }
      }
    }

    const failure = allocationFailure(
      sawProbeFailure ? "floor_unavailable" : "directory_at_capacity",
      request.bucket,
      {
        retryable: !sawOverload,
        requiresFreshAssignment: true,
        overloaded: sawOverload,
        probes,
      },
    );
    return this.recordAllocationFailure(request, requestHash, failure);
  }

  async retire(candidate: unknown): Promise<RetirementResult> {
    if (!this.schemaCompatible) {
      return {
        ok: false,
        code: "directory_schema_incompatible",
        retryable: false,
        requiresFreshAssignment: true,
      };
    }
    let request: RetirementRequest;
    try {
      request = parseRetirementRequest(candidate);
    } catch {
      return {
        ok: false,
        code: "invalid_request",
        retryable: false,
        requiresFreshAssignment: false,
      };
    }
    if (
      !this.config.realmDirectorySupportedBucketCounts.has(request.bucketCount) ||
      !this.bindIdentity(request)
    ) {
      return {
        ok: false,
        code: "identity_mismatch",
        retryable: false,
        requiresFreshAssignment: false,
      };
    }
    const requestHash = await canonicalRequestHash("retire", request);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const early = this.ctx.storage.transactionSync(() => {
      this.purgeExpiredState(nowSeconds);
      const replay = this.replayRetirement(request.operationId, requestHash);
      if (replay) return { result: replay };
      const slot = this.slot(request.floorSlot);
      if (!slot) {
        const result: RetirementResult = {
          ok: false,
          code: "floor_slot_not_found",
          retryable: false,
          requiresFreshAssignment: true,
        };
        return {
          result: this.recordRetirementResult(
            request,
            requestHash,
            result,
            nowSeconds + this.config.realmDirectoryReservationSeconds,
          ),
        };
      }
      const currentFloor = this.descriptor(request, slot.floor_epoch, slot.floor_slot);
      if (
        slot.floor_instance_id !== request.floorInstanceId ||
        slot.floor_epoch !== request.floorEpoch
      ) {
        const result: RetirementResult = {
          ok: false,
          code: "stale_floor_epoch",
          retryable: false,
          requiresFreshAssignment: true,
          currentFloor,
        };
        return {
          result: this.recordRetirementResult(
            request,
            requestHash,
            result,
            nowSeconds + this.config.realmDirectoryReservationSeconds,
          ),
        };
      }
      if (slot.state === "active") {
        this.ctx.storage.sql.exec(
          `UPDATE floor_slots
           SET state = 'draining', lifecycle_version = lifecycle_version + 1,
               retirement_reason = ?, updated_at = ?
           WHERE floor_slot = ? AND floor_epoch = ? AND state = 'active'`,
          request.reason,
          nowSeconds,
          request.floorSlot,
          request.floorEpoch,
        );
        this.incrementRevision();
      }
      const pressure = this.reservationPressure(request.floorSlot, request.floorEpoch, nowSeconds);
      if (pressure.units > 0) {
        const revision = this.revision();
        const result: RetirementResult = {
          ok: true,
          operationId: request.operationId,
          phase: "draining",
          retiredFloor: currentFloor,
          activeReservationUnits: pressure.units,
          liveSockets: 0,
          frozenTransfers: 0,
          preparedTransfers: 0,
          retryAfterSeconds: Math.max(1, pressure.expires_at - nowSeconds),
          directory: { bucket: request.bucket, revision },
        };
        return {
          result: this.recordRetirementResult(
            request,
            requestHash,
            result,
            Math.max(nowSeconds + this.config.realmDirectoryReservationSeconds, pressure.expires_at),
          ),
        };
      }
      return { slot: this.slot(request.floorSlot)! };
    });
    if ("result" in early && early.result) {
      if (this.slot(request.floorSlot)?.state === "draining") {
        const delay = early.result.ok && early.result.phase === "draining"
          ? early.result.retryAfterSeconds * 1_000
          : 1_000;
        await this.scheduleRetirementAlarm(delay);
      }
      return early.result;
    }

    const oldFloor = this.descriptor(request, request.floorEpoch, request.floorSlot);
    let advanced;
    try {
      advanced = await this.bindings.FLOOR_INSTANCES.getByName(oldFloor.floorObjectName, {
        locationHint: request.locationHint,
      }).advanceFloorRetirement({
        floorObjectName: oldFloor.floorObjectName,
        floorEpoch: request.floorEpoch,
      });
    } catch (error) {
      const failure = durableObjectFailure(error);
      const result: RetirementResult = {
        ok: false,
        code: "floor_unavailable",
        retryable: failure.retryable && !failure.overloaded,
        requiresFreshAssignment: true,
        overloaded: failure.overloaded,
      };
      return this.ctx.storage.transactionSync(() =>
        this.recordRetirementResult(
          request,
          requestHash,
          result,
          nowSeconds + this.config.realmDirectoryReservationSeconds,
        ),
      );
    }
    if (!advanced.ok) {
      const result: RetirementResult = {
        ok: false,
        code: "floor_unavailable",
        retryable: false,
        requiresFreshAssignment: true,
      };
      return this.ctx.storage.transactionSync(() =>
        this.recordRetirementResult(
          request,
          requestHash,
          result,
          nowSeconds + this.config.realmDirectoryReservationSeconds,
        ),
      );
    }
    if (advanced.phase !== "retired") {
      const result: RetirementResult = {
        ok: true,
        operationId: request.operationId,
        phase: "draining",
        retiredFloor: oldFloor,
        activeReservationUnits: 0,
        liveSockets: advanced.liveSockets,
        frozenTransfers: advanced.frozenTransfers,
        preparedTransfers: advanced.preparedTransfers,
        retryAfterSeconds: 3,
        directory: { bucket: request.bucket, revision: this.revision() },
      };
      const recorded = this.ctx.storage.transactionSync(() =>
        this.recordRetirementResult(
          request,
          requestHash,
          result,
          nowSeconds + this.config.realmDirectoryReservationSeconds,
        ),
      );
      await this.scheduleRetirementAlarm(3_000);
      return recorded;
    }

    return this.ctx.storage.transactionSync(() => {
      const commitNow = Math.floor(Date.now() / 1_000);
      this.purgeExpiredState(commitNow);
      const replay = this.replayRetirement(request.operationId, requestHash);
      if (replay) return replay;
      const slot = this.slot(request.floorSlot);
      if (
        !slot ||
        slot.floor_instance_id !== request.floorInstanceId ||
        slot.floor_epoch !== request.floorEpoch ||
        slot.state !== "draining"
      ) {
        const result: RetirementResult = {
          ok: false,
          code: "stale_floor_epoch",
          retryable: false,
          requiresFreshAssignment: true,
          ...(slot
            ? { currentFloor: this.descriptor(request, slot.floor_epoch, slot.floor_slot) }
            : {}),
        };
        return this.recordRetirementResult(
          request,
          requestHash,
          result,
          commitNow + this.config.realmDirectoryReservationSeconds,
        );
      }
      if (this.reservationPressure(request.floorSlot, request.floorEpoch, commitNow).units > 0) {
        const result: RetirementResult = {
          ok: false,
          code: "floor_unavailable",
          retryable: true,
          requiresFreshAssignment: true,
        };
        return this.recordRetirementResult(
          request,
          requestHash,
          result,
          commitNow + this.config.realmDirectoryReservationSeconds,
        );
      }
      if (request.floorEpoch >= Number.MAX_SAFE_INTEGER) {
        const result: RetirementResult = {
          ok: false,
          code: "floor_epoch_exhausted",
          retryable: false,
          requiresFreshAssignment: true,
        };
        return this.recordRetirementResult(
          request,
          requestHash,
          result,
          commitNow + this.config.realmDirectoryReservationSeconds,
        );
      }
      if (!this.hasReceiptCapacity(commitNow)) {
        return {
          ok: false,
          code: "directory_receipt_capacity",
          retryable: true,
          requiresFreshAssignment: true,
        };
      }
      const nextEpoch = request.floorEpoch + 1;
      this.ctx.storage.sql.exec(
        `UPDATE floor_slots
         SET floor_epoch = ?, state = 'active', lifecycle_version = lifecycle_version + 1,
             observed_live_players = 0, observed_pending_sockets = 0,
             observed_pending_players = 0,
             observed_total_sockets = 0, observed_durable_sessions = 0,
             observed_frozen_transfers = 0, observed_prepared_transfers = 0,
             observed_max_players = ?, observed_accepting = 1,
             observed_retirement_required = 0, observed_at = 0,
             last_probe_status = 'never', retirement_reason = NULL, updated_at = ?
         WHERE floor_slot = ? AND floor_epoch = ? AND state = 'draining'`,
        nextEpoch,
        this.config.floorSocketCap,
        commitNow,
        request.floorSlot,
        request.floorEpoch,
      );
      const revision = this.incrementRevision();
      const result: RetirementResult = {
        ok: true,
        operationId: request.operationId,
        phase: "rotated",
        retiredFloor: oldFloor,
        replacement: this.descriptor(request, nextEpoch, request.floorSlot),
        directory: { bucket: request.bucket, revision },
      };
      this.insertOperation(
        request.operationId,
        "retire",
        requestHash,
        result,
        commitNow + this.config.realmDirectoryReservationSeconds,
        commitNow,
      );
      return result;
    });
  }

  async alarm(): Promise<void> {
    if (!this.schemaCompatible) {
      console.error(JSON.stringify({ event: "realm_directory_alarm_schema_incompatible" }));
      return;
    }
    const identity = this.directoryIdentity();
    if (!identity) {
      console.error(JSON.stringify({ event: "realm_directory_alarm_identity_missing" }));
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1_000);
    this.ctx.storage.transactionSync(() => this.purgeExpiredState(nowSeconds));
    const draining = this.drainingSlots(MAX_DIRECTORY_PROBES);
    let nextDelayMs: number | undefined;

    for (const slot of draining) {
      const currentNow = Math.floor(Date.now() / 1_000);
      const reservations = this.reservationPressure(slot.floor_slot, slot.floor_epoch, currentNow);
      if (reservations.units > 0) {
        const delay = Math.max(1_000, (reservations.expires_at - currentNow) * 1_000);
        nextDelayMs = Math.min(nextDelayMs ?? delay, delay);
        continue;
      }
      const floor = this.descriptorFromIdentity(identity, slot.floor_epoch, slot.floor_slot);
      if (floor.floorInstanceId !== slot.floor_instance_id) {
        console.error(
          JSON.stringify({
            event: "realm_directory_slot_identity_corrupt",
            bucket: identity.bucket,
            floorSlot: slot.floor_slot,
            floorEpoch: slot.floor_epoch,
          }),
        );
        continue;
      }
      try {
        const advanced = await this.bindings.FLOOR_INSTANCES.getByName(floor.floorObjectName, {
          locationHint: floor.locationHint,
        }).advanceFloorRetirement({
          floorObjectName: floor.floorObjectName,
          floorEpoch: floor.floorEpoch,
        });
        if (advanced.ok && advanced.phase === "retired") {
          const rotated = this.rotateDrainingSlot(identity, slot, Math.floor(Date.now() / 1_000));
          console.log(
            JSON.stringify({
              event: "realm_directory_alarm_retirement",
              bucket: identity.bucket,
              floorSlot: slot.floor_slot,
              floorEpoch: slot.floor_epoch,
              rotated,
            }),
          );
          if (!rotated) nextDelayMs = Math.min(nextDelayMs ?? 3_000, 3_000);
        } else {
          nextDelayMs = Math.min(nextDelayMs ?? 3_000, 3_000);
        }
      } catch (error) {
        const failure = durableObjectFailure(error);
        console.error(
          JSON.stringify({
            event: "realm_directory_alarm_floor_failed",
            bucket: identity.bucket,
            floorSlot: slot.floor_slot,
            floorEpoch: slot.floor_epoch,
            overloaded: failure.overloaded,
            retryable: failure.retryable,
            remote: failure.remote,
          }),
        );
        nextDelayMs = Math.min(nextDelayMs ?? 3_000, 3_000);
      }
    }

    if (this.drainingSlotCount() > draining.length) {
      nextDelayMs = Math.min(nextDelayMs ?? 1_000, 1_000);
    }
    if (nextDelayMs !== undefined) {
      await this.scheduleRetirementAlarm(nextDelayMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private initializeSchema(): boolean {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const maximumVersion = firstRow(
      this.ctx.storage.sql.exec<VersionRow>(
        "SELECT MAX(version) AS version FROM _sql_schema_migrations",
      ),
    )?.version;
    if (maximumVersion !== null && maximumVersion !== undefined && maximumVersion > DIRECTORY_SCHEMA_VERSION) {
      return false;
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS directory_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      INSERT OR IGNORE INTO directory_meta (singleton, revision) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS directory_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        object_name TEXT NOT NULL,
        environment TEXT NOT NULL,
        location_hint TEXT NOT NULL,
        realm_id TEXT NOT NULL,
        depth INTEGER NOT NULL,
        allocator_layout_version INTEGER NOT NULL,
        bucket_count INTEGER NOT NULL,
        bucket INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS floor_slots (
        floor_slot INTEGER PRIMARY KEY CHECK (floor_slot >= 0),
        floor_instance_id TEXT NOT NULL,
        floor_epoch INTEGER NOT NULL CHECK (floor_epoch > 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'draining')),
        lifecycle_version INTEGER NOT NULL CHECK (lifecycle_version > 0),
        observed_live_players INTEGER NOT NULL DEFAULT 0,
        observed_pending_players INTEGER NOT NULL DEFAULT 0,
        observed_pending_sockets INTEGER NOT NULL DEFAULT 0,
        observed_total_sockets INTEGER NOT NULL DEFAULT 0,
        observed_durable_sessions INTEGER NOT NULL DEFAULT 0,
        observed_frozen_transfers INTEGER NOT NULL DEFAULT 0,
        observed_prepared_transfers INTEGER NOT NULL DEFAULT 0,
        observed_max_players INTEGER NOT NULL DEFAULT 0,
        observed_accepting INTEGER NOT NULL DEFAULT 1,
        observed_retirement_required INTEGER NOT NULL DEFAULT 0,
        observed_at INTEGER NOT NULL DEFAULT 0,
        last_probe_status TEXT NOT NULL DEFAULT 'never',
        retirement_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS allocation_reservations (
        affinity_key TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        floor_slot INTEGER NOT NULL,
        floor_epoch INTEGER NOT NULL,
        capacity_units INTEGER NOT NULL CHECK (capacity_units > 0),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS directory_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('allocate', 'retire')),
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        retain_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);

    this.ensureColumn("directory_identity", "allocator_layout_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("directory_identity", "bucket_count", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("floor_slots", "lifecycle_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("floor_slots", "observed_pending_players", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_pending_sockets", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_total_sockets", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_durable_sessions", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_frozen_transfers", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_prepared_transfers", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_max_players", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "observed_accepting", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("floor_slots", "observed_retirement_required", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("floor_slots", "last_probe_status", "TEXT NOT NULL DEFAULT 'never'");
    this.ensureColumn("floor_slots", "retirement_reason", "TEXT");
    this.ensureColumn("allocation_reservations", "reservation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("directory_operations", "retain_until", "INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS reservations_expiry
        ON allocation_reservations(expires_at);
      CREATE INDEX IF NOT EXISTS reservations_slot_epoch
        ON allocation_reservations(floor_slot, floor_epoch, expires_at);
      CREATE INDEX IF NOT EXISTS operations_retention
        ON directory_operations(retain_until);
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (1, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (2, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (3, unixepoch());
    `);
    return true;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = new Set(
      this.ctx.storage.sql
        .exec<ColumnRow>(`PRAGMA table_info(${table})`)
        .toArray()
        .map((row) => row.name),
    );
    if (!columns.has(column)) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private bindIdentity(
    request: Pick<
      RetirementRequest,
      "realmId" | "depth" | "locationHint" | "bucketCount" | "bucket"
    >,
  ): boolean {
    const objectName = realmDirectoryObjectName(
      this.config.environment,
      request,
      request.bucketCount,
      request.bucket,
    );
    if (this.ctx.id.name !== objectName) return false;
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO directory_identity
           (singleton, object_name, environment, location_hint, realm_id, depth,
            allocator_layout_version, bucket_count, bucket)
         VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?)`,
        objectName,
        this.config.environment,
        request.locationHint,
        request.realmId,
        request.depth,
        request.bucketCount,
        request.bucket,
      );
      const row = firstRow(
        this.ctx.storage.sql.exec<DirectoryIdentityRow>(
          `SELECT object_name, environment, location_hint, realm_id, depth,
                  allocator_layout_version, bucket_count, bucket
           FROM directory_identity WHERE singleton = 1`,
        ),
      );
      return (
        row?.object_name === objectName &&
        row.environment === this.config.environment &&
        row.location_hint === request.locationHint &&
        row.realm_id === request.realmId &&
        row.depth === request.depth &&
        row.allocator_layout_version === 1 &&
        row.bucket_count === request.bucketCount &&
        row.bucket === request.bucket
      );
    });
  }

  private activeReservation(affinityKey: string, nowSeconds: number): ReservationRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<ReservationRow>(
        `SELECT r.affinity_key, r.reservation_id, r.floor_slot, r.floor_epoch,
                r.capacity_units, r.expires_at
         FROM allocation_reservations r
         JOIN floor_slots s ON s.floor_slot = r.floor_slot AND s.floor_epoch = r.floor_epoch
         WHERE r.affinity_key = ? AND r.expires_at > ? AND s.state IN ('active', 'draining')`,
        affinityKey,
        nowSeconds,
      ),
    );
  }

  private completedOrReserved(
    request: DirectoryAllocationRequest,
    requestHash: string,
    affinityKey: string,
  ): AllocationResult | undefined {
    return this.ctx.storage.transactionSync(() => {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      this.purgeExpiredState(nowSeconds);
      const replay = this.replayAllocation(request.operationId, requestHash);
      if (replay) return replay;
      const reservation = this.activeReservation(affinityKey, nowSeconds);
      return reservation
        ? this.reuseReservationInTransaction(request, requestHash, reservation, nowSeconds)
        : undefined;
    });
  }

  private reuseReservation(
    request: DirectoryAllocationRequest,
    requestHash: string,
    reservation: ReservationRow,
  ): AllocationResult {
    return this.ctx.storage.transactionSync(() => {
      const commitNow = Math.floor(Date.now() / 1_000);
      this.purgeExpiredState(commitNow);
      return this.reuseReservationInTransaction(request, requestHash, reservation, commitNow);
    });
  }

  private reuseReservationInTransaction(
    request: DirectoryAllocationRequest,
    requestHash: string,
    reservation: ReservationRow,
    nowSeconds: number,
  ): AllocationResult {
    const replay = this.replayAllocation(request.operationId, requestHash);
    if (replay) return replay;
    const current = this.activeReservation(reservation.affinity_key, nowSeconds);
    if (!current) {
      return allocationFailure("floor_unavailable", request.bucket, {
        retryable: true,
        requiresFreshAssignment: true,
      });
    }
    if (current.capacity_units !== request.capacityUnits) {
      const result = allocationFailure("affinity_capacity_conflict", request.bucket);
      return this.recordAllocationResult(
        request,
        requestHash,
        result,
        current.expires_at,
        nowSeconds,
      );
    }
    if (!isUuid(current.reservation_id)) {
      current.reservation_id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "UPDATE allocation_reservations SET reservation_id = ?, updated_at = ? WHERE affinity_key = ?",
        current.reservation_id,
        nowSeconds,
        current.affinity_key,
      );
    }
    const slot = this.slot(current.floor_slot);
    if (!slot || slot.floor_epoch !== current.floor_epoch) {
      return allocationFailure("receipt_corrupt", request.bucket);
    }
    const assignment = assignmentFor(
      { ...request, floorSlot: slot.floor_slot },
      slot.floor_epoch,
      current.reservation_id,
      current.expires_at,
    );
    const result: AllocationSuccess = {
      ok: true,
      decision: "affinity_reuse",
      operationId: request.operationId,
      assignment,
      directory: { bucket: request.bucket, revision: this.revision() },
      capacity: {
          observedLivePlayers: slot.observed_live_players,
          observedPendingPlayers: slot.observed_pending_players,
          observedPendingSockets: slot.observed_pending_sockets,
        reservedUnits: this.reservationPressure(
          slot.floor_slot,
          slot.floor_epoch,
          nowSeconds,
        ).units,
        maxPlayers: slot.observed_max_players || this.config.floorSocketCap,
      },
      probes: 0,
    };
    return this.recordAllocationResult(
      request,
      requestHash,
      result,
      current.expires_at,
      nowSeconds,
    );
  }

  private candidateSlots(limit: number, nowSeconds: number): SlotRow[] {
    if (limit <= 0) return [];
    return this.ctx.storage.sql
      .exec<SlotRow>(
        `SELECT s.floor_slot, s.floor_instance_id, s.floor_epoch, s.state,
                s.lifecycle_version, s.observed_live_players,
                s.observed_pending_players,
                s.observed_pending_sockets, s.observed_total_sockets,
                s.observed_durable_sessions, s.observed_frozen_transfers,
                s.observed_prepared_transfers, s.observed_max_players,
                s.observed_accepting, s.observed_retirement_required,
                s.observed_at, s.last_probe_status
         FROM floor_slots s
         WHERE s.state = 'active'
         ORDER BY (
           s.observed_live_players + s.observed_pending_players +
           COALESCE((SELECT SUM(r.capacity_units) FROM allocation_reservations r
                     WHERE r.floor_slot = s.floor_slot AND r.floor_epoch = s.floor_epoch
                       AND r.expires_at > ?), 0)
         ) ASC, s.observed_at ASC, s.floor_slot ASC
         LIMIT ?`,
        nowSeconds,
        limit,
      )
      .toArray();
  }

  private async probeSlot(
    request: DirectoryAllocationRequest,
    slot: SlotRow,
  ): Promise<FloorCapacitySnapshot | ProbeFailure> {
    const descriptor = this.descriptor(request, slot.floor_epoch, slot.floor_slot);
    if (slot.floor_instance_id !== descriptor.floorInstanceId) {
      return { ok: false, overloaded: false, retryable: false, remote: false };
    }
    try {
      const result = await this.bindings.FLOOR_INSTANCES.getByName(descriptor.floorObjectName, {
        locationHint: request.locationHint,
      }).getCapacitySnapshot({
        floorObjectName: descriptor.floorObjectName,
        floorEpoch: slot.floor_epoch,
      });
      if (!result.ok || result.floorObjectName !== descriptor.floorObjectName) {
        return { ok: false, overloaded: false, retryable: false, remote: false };
      }
      if (
        !Array.isArray(result.reservationOccupancy) ||
        result.reservationOccupancy.length > result.maxPlayers + 1 ||
        result.reservationOccupancy.some(
          (entry) =>
            !isUuid(entry.reservationId) ||
            entry.reservationId !== entry.reservationId.toLowerCase() ||
            !Number.isSafeInteger(entry.players) ||
            entry.players < 1 ||
            entry.players > result.maxPlayers + 1,
        )
      ) {
        return { ok: false, overloaded: false, retryable: false, remote: false };
      }
      return result;
    } catch (error) {
      return durableObjectFailure(error);
    }
  }

  private recordSnapshot(
    slot: SlotRow,
    snapshot: FloorCapacitySnapshot,
    nowSeconds: number,
  ): SlotRow | undefined {
    const recorded = this.ctx.storage.transactionSync(() => {
      const current = this.slot(slot.floor_slot);
      if (
        !current ||
        current.floor_epoch !== slot.floor_epoch ||
        current.lifecycle_version !== slot.lifecycle_version ||
        current.state !== "active"
      ) {
        return undefined;
      }
      const draining = snapshot.retirementRequired || snapshot.retired;
      this.ctx.storage.sql.exec(
        `UPDATE floor_slots
         SET state = ?, lifecycle_version = lifecycle_version + 1,
             observed_live_players = ?, observed_pending_sockets = ?,
             observed_pending_players = ?,
             observed_total_sockets = ?, observed_durable_sessions = ?,
             observed_frozen_transfers = ?, observed_prepared_transfers = ?,
             observed_max_players = ?, observed_accepting = ?,
             observed_retirement_required = ?, observed_at = ?,
             last_probe_status = 'ok', retirement_reason = ?, updated_at = ?
         WHERE floor_slot = ? AND floor_epoch = ? AND lifecycle_version = ? AND state = 'active'`,
        draining ? "draining" : "active",
        snapshot.livePlayers,
        snapshot.pendingSockets,
        snapshot.pendingPlayers,
        snapshot.totalSockets,
        snapshot.durableSessions,
        snapshot.frozenTransfers,
        snapshot.preparedTransfers,
        snapshot.maxPlayers,
        snapshot.acceptingNewPlayers ? 1 : 0,
        snapshot.retirementRequired ? 1 : 0,
        snapshot.observedAt,
        draining ? "tombstone_limit" : null,
        nowSeconds,
        slot.floor_slot,
        slot.floor_epoch,
        slot.lifecycle_version,
      );
      if (draining) this.incrementRevision();
      return draining ? undefined : this.slot(slot.floor_slot);
    });
    if (!recorded && this.slot(slot.floor_slot)?.state === "draining") {
      this.ctx.waitUntil(this.scheduleRetirementAlarm(1_000));
    }
    return recorded;
  }

  private recordProbeFailure(slot: SlotRow, failure: ProbeFailure, nowSeconds: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE floor_slots
       SET last_probe_status = ?, observed_at = ?, updated_at = ?
       WHERE floor_slot = ? AND floor_epoch = ? AND lifecycle_version = ?`,
      failure.overloaded ? "overloaded" : failure.remote ? "remote_error" : "error",
      nowSeconds,
      nowSeconds,
      slot.floor_slot,
      slot.floor_epoch,
      slot.lifecycle_version,
    );
  }

  private tryReserve(
    request: DirectoryAllocationRequest,
    requestHash: string,
    affinityKey: string,
    slot: SlotRow,
    snapshot: FloorCapacitySnapshot,
    probes: number,
    decision: "existing_floor" | "new_floor",
  ): AllocationResult | null {
    return this.ctx.storage.transactionSync(() => {
      const commitNow = Math.floor(Date.now() / 1_000);
      this.purgeExpiredState(commitNow);
      const replay = this.replayAllocation(request.operationId, requestHash);
      if (replay) return replay;
      const existing = this.activeReservation(affinityKey, commitNow);
      if (existing) {
        return this.reuseReservationInTransaction(request, requestHash, existing, commitNow);
      }
      const current = this.slot(slot.floor_slot);
      if (
        !current ||
        current.floor_epoch !== slot.floor_epoch ||
        current.lifecycle_version !== slot.lifecycle_version ||
        current.state !== "active"
      ) {
        return null;
      }
      if (snapshot.observedAt > commitNow + 1 || commitNow - snapshot.observedAt > 5) {
        return null;
      }
      const pressure = this.outstandingReservationUnits(
        slot.floor_slot,
        slot.floor_epoch,
        commitNow,
        snapshot.reservationOccupancy,
      );
      const playerPressure = snapshot.livePlayers + snapshot.pendingPlayers + snapshot.preparedTransfers;
      const observedPressure = Math.max(playerPressure, snapshot.totalSockets);
      const capacity = Math.min(snapshot.maxPlayers, this.config.floorSocketCap);
      if (
        !snapshot.acceptingNewPlayers ||
        observedPressure + pressure + request.capacityUnits > capacity
      ) {
        return null;
      }
      if (!this.hasReceiptCapacity(commitNow)) {
        return allocationFailure("directory_receipt_capacity", request.bucket, {
          retryable: true,
          requiresFreshAssignment: true,
        });
      }
      const expiresAt = commitNow + this.config.realmDirectoryReservationSeconds;
      this.ctx.storage.sql.exec(
        `INSERT INTO allocation_reservations
           (affinity_key, reservation_id, floor_slot, floor_epoch, capacity_units,
            expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        affinityKey,
        request.operationId,
        slot.floor_slot,
        slot.floor_epoch,
        request.capacityUnits,
        expiresAt,
        commitNow,
        commitNow,
      );
      const revision = this.incrementRevision();
      const result: AllocationSuccess = {
        ok: true,
        decision,
        operationId: request.operationId,
        assignment: assignmentFor(
          { ...request, floorSlot: slot.floor_slot },
          slot.floor_epoch,
          request.operationId,
          expiresAt,
        ),
        directory: { bucket: request.bucket, revision },
        capacity: {
          observedLivePlayers: snapshot.livePlayers,
          observedPendingPlayers: snapshot.pendingPlayers,
          observedPendingSockets: snapshot.pendingSockets,
          reservedUnits: pressure + request.capacityUnits,
          maxPlayers: capacity,
        },
        probes,
      };
      this.insertOperation(
        request.operationId,
        "allocate",
        requestHash,
        result,
        expiresAt,
        commitNow,
      );
      return result;
    });
  }

  private createOrFindUnobservedSlot(
    request: DirectoryAllocationRequest,
  ): { slot: SlotRow; created: boolean } | undefined {
    return this.ctx.storage.transactionSync(() => {
      const unobserved = firstRow(
        this.ctx.storage.sql.exec<SlotRow>(
          `SELECT floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
                  observed_live_players, observed_pending_sockets, observed_total_sockets,
                  observed_pending_players,
                  observed_durable_sessions, observed_frozen_transfers,
                  observed_prepared_transfers, observed_max_players, observed_accepting,
                  observed_retirement_required, observed_at, last_probe_status
           FROM floor_slots WHERE state = 'active' AND observed_at = 0
           ORDER BY floor_slot LIMIT 1`,
        ),
      );
      if (unobserved) return { slot: unobserved, created: false };
      const rows = this.ctx.storage.sql
        .exec<{ floor_slot: number } & Record<string, SqlStorageValue>>(
          "SELECT floor_slot FROM floor_slots ORDER BY floor_slot",
        )
        .toArray();
      if (rows.length >= this.config.realmDirectoryFloorLimit) return undefined;
      const used = new Set(rows.map((row) => row.floor_slot));
      let floorSlot = 0;
      while (used.has(floorSlot) && floorSlot < this.config.realmDirectoryFloorLimit) floorSlot += 1;
      if (floorSlot >= this.config.realmDirectoryFloorLimit) return undefined;
      const floorInstanceId = floorInstanceIdForSlot(
        request.locationHint,
        request.bucketCount,
        request.bucket,
        floorSlot,
      );
      const nowSeconds = Math.floor(Date.now() / 1_000);
      this.ctx.storage.sql.exec(
        `INSERT INTO floor_slots
           (floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
            observed_live_players, observed_pending_players, observed_pending_sockets,
            observed_total_sockets,
            observed_durable_sessions, observed_frozen_transfers,
            observed_prepared_transfers, observed_max_players, observed_accepting,
            observed_retirement_required, observed_at, last_probe_status,
            retirement_reason, created_at, updated_at)
         VALUES (?, ?, 1, 'active', 1, 0, 0, 0, 0, 0, 0, 0, ?, 1, 0, 0, 'never', NULL, ?, ?)`,
        floorSlot,
        floorInstanceId,
        this.config.floorSocketCap,
        nowSeconds,
        nowSeconds,
      );
      this.incrementRevision();
      return { slot: this.slot(floorSlot)!, created: true };
    });
  }

  private replayAllocation(operationId: string, requestHash: string): AllocationResult | undefined {
    const operation = this.operation(operationId);
    if (!operation) return undefined;
    if (operation.operation_kind !== "allocate" || operation.request_hash !== requestHash) {
      return allocationFailure("operation_reused");
    }
    try {
      const result = JSON.parse(operation.response_json) as AllocationResult;
      return typeof result?.ok === "boolean" ? result : allocationFailure("receipt_corrupt");
    } catch {
      return allocationFailure("receipt_corrupt");
    }
  }

  private replayRetirement(operationId: string, requestHash: string): RetirementResult | undefined {
    const operation = this.operation(operationId);
    if (!operation) return undefined;
    if (operation.operation_kind !== "retire" || operation.request_hash !== requestHash) {
      return {
        ok: false,
        code: "operation_reused",
        retryable: false,
        requiresFreshAssignment: false,
      };
    }
    try {
      const result = JSON.parse(operation.response_json) as RetirementResult;
      return typeof result?.ok === "boolean"
        ? result
        : {
            ok: false,
            code: "receipt_corrupt",
            retryable: false,
            requiresFreshAssignment: false,
          };
    } catch {
      return {
        ok: false,
        code: "receipt_corrupt",
        retryable: false,
        requiresFreshAssignment: false,
      };
    }
  }

  private recordAllocationFailure(
    request: DirectoryAllocationRequest,
    requestHash: string,
    result: AllocationFailure,
  ): AllocationResult {
    return this.ctx.storage.transactionSync(() => {
      const commitNow = Math.floor(Date.now() / 1_000);
      return this.recordAllocationResult(
        request,
        requestHash,
        result,
        commitNow + this.config.realmDirectoryReservationSeconds,
        commitNow,
      );
    });
  }

  private recordAllocationResult(
    request: DirectoryAllocationRequest,
    requestHash: string,
    result: AllocationResult,
    retainUntil: number,
    nowSeconds: number,
  ): AllocationResult {
    const replay = this.replayAllocation(request.operationId, requestHash);
    if (replay) return replay;
    if (!this.hasReceiptCapacity(nowSeconds)) {
      return allocationFailure("directory_receipt_capacity", request.bucket, {
        retryable: true,
        requiresFreshAssignment: true,
      });
    }
    this.insertOperation(
      request.operationId,
      "allocate",
      requestHash,
      result,
      retainUntil,
      nowSeconds,
    );
    return result;
  }

  private recordRetirementResult(
    request: RetirementRequest,
    requestHash: string,
    result: RetirementResult,
    retainUntil: number,
  ): RetirementResult {
    const replay = this.replayRetirement(request.operationId, requestHash);
    if (replay) return replay;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const effectiveRetainUntil = Math.max(
      retainUntil,
      nowSeconds + this.config.realmDirectoryReservationSeconds,
    );
    if (!this.hasReceiptCapacity(nowSeconds)) {
      return {
        ok: false,
        code: "directory_receipt_capacity",
        retryable: true,
        requiresFreshAssignment: true,
      };
    }
    this.insertOperation(
      request.operationId,
      "retire",
      requestHash,
      result,
      effectiveRetainUntil,
      nowSeconds,
    );
    return result;
  }

  private insertOperation(
    operationId: string,
    kind: "allocate" | "retire",
    requestHash: string,
    result: AllocationResult | RetirementResult,
    retainUntil: number,
    nowSeconds: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO directory_operations
         (operation_id, operation_kind, request_hash, response_json, retain_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      operationId,
      kind,
      requestHash,
      JSON.stringify(result),
      retainUntil,
      nowSeconds,
    );
  }

  private operation(operationId: string): OperationRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<OperationRow>(
        `SELECT operation_kind, request_hash, response_json
         FROM directory_operations WHERE operation_id = ?`,
        operationId,
      ),
    );
  }

  private hasReceiptCapacity(nowSeconds: number): boolean {
    this.ctx.storage.sql.exec("DELETE FROM directory_operations WHERE retain_until <= ?", nowSeconds);
    const count = firstRow(
      this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM directory_operations"),
    )?.count ?? 0;
    return count < this.config.realmDirectoryReceiptLimit;
  }

  private purgeExpiredState(nowSeconds: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM allocation_reservations WHERE expires_at <= ?",
      nowSeconds,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM directory_operations WHERE retain_until <= ?",
      nowSeconds,
    );
  }

  private reservationPressure(
    floorSlot: number,
    floorEpoch: number,
    nowSeconds: number,
  ): ReservationPressureRow {
    return (
      firstRow(
        this.ctx.storage.sql.exec<ReservationPressureRow>(
          `SELECT COALESCE(SUM(capacity_units), 0) AS units,
                  COALESCE(MAX(expires_at), 0) AS expires_at
           FROM allocation_reservations
           WHERE floor_slot = ? AND floor_epoch = ? AND expires_at > ?`,
          floorSlot,
          floorEpoch,
          nowSeconds,
        ),
      ) ?? { units: 0, expires_at: 0 }
    );
  }

  private outstandingReservationUnits(
    floorSlot: number,
    floorEpoch: number,
    nowSeconds: number,
    occupancy: ReadonlyArray<{ reservationId: string; players: number }>,
  ): number {
    const occupied = new Map<string, number>();
    for (const entry of occupancy) {
      occupied.set(entry.reservationId, (occupied.get(entry.reservationId) ?? 0) + entry.players);
    }
    return this.ctx.storage.sql
      .exec<ReservationCapacityRow>(
        `SELECT reservation_id, capacity_units FROM allocation_reservations
         WHERE floor_slot = ? AND floor_epoch = ? AND expires_at > ?`,
        floorSlot,
        floorEpoch,
        nowSeconds,
      )
      .toArray()
      .reduce(
        (total, reservation) =>
          total +
          Math.max(
            0,
            reservation.capacity_units - (occupied.get(reservation.reservation_id) ?? 0),
          ),
        0,
      );
  }

  private slot(floorSlot: number): SlotRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<SlotRow>(
        `SELECT floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
                observed_live_players, observed_pending_players,
                observed_pending_sockets, observed_total_sockets,
                observed_durable_sessions, observed_frozen_transfers,
                observed_prepared_transfers, observed_max_players, observed_accepting,
                observed_retirement_required, observed_at, last_probe_status
         FROM floor_slots WHERE floor_slot = ?`,
        floorSlot,
      ),
    );
  }

  private slotCount(): number {
    return firstRow(
      this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM floor_slots"),
    )?.count ?? 0;
  }

  private drainingSlots(limit: number): SlotRow[] {
    return this.ctx.storage.sql
      .exec<SlotRow>(
        `SELECT floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
                observed_live_players, observed_pending_players,
                observed_pending_sockets, observed_total_sockets,
                observed_durable_sessions, observed_frozen_transfers,
                observed_prepared_transfers, observed_max_players, observed_accepting,
                observed_retirement_required, observed_at, last_probe_status
         FROM floor_slots WHERE state = 'draining' ORDER BY updated_at, floor_slot LIMIT ?`,
        limit,
      )
      .toArray();
  }

  private drainingSlotCount(): number {
    return firstRow(
      this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM floor_slots WHERE state = 'draining'",
      ),
    )?.count ?? 0;
  }

  private directoryIdentity(): DirectoryIdentityRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<DirectoryIdentityRow>(
        `SELECT object_name, environment, location_hint, realm_id, depth,
                allocator_layout_version, bucket_count, bucket
         FROM directory_identity WHERE singleton = 1`,
      ),
    );
  }

  private rotateDrainingSlot(
    identity: DirectoryIdentityRow,
    observed: SlotRow,
    nowSeconds: number,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.purgeExpiredState(nowSeconds);
      const current = this.slot(observed.floor_slot);
      if (
        !current ||
        current.state !== "draining" ||
        current.floor_epoch !== observed.floor_epoch ||
        current.lifecycle_version !== observed.lifecycle_version ||
        current.floor_instance_id !== observed.floor_instance_id ||
        current.floor_epoch >= Number.MAX_SAFE_INTEGER ||
        this.reservationPressure(current.floor_slot, current.floor_epoch, nowSeconds).units > 0
      ) {
        return false;
      }
      const expected = this.descriptorFromIdentity(
        identity,
        current.floor_epoch,
        current.floor_slot,
      );
      if (expected.floorInstanceId !== current.floor_instance_id) return false;
      this.ctx.storage.sql.exec(
        `UPDATE floor_slots
         SET floor_epoch = floor_epoch + 1, state = 'active',
             lifecycle_version = lifecycle_version + 1,
             observed_live_players = 0, observed_pending_sockets = 0,
             observed_pending_players = 0,
             observed_total_sockets = 0, observed_durable_sessions = 0,
             observed_frozen_transfers = 0, observed_prepared_transfers = 0,
             observed_max_players = ?, observed_accepting = 1,
             observed_retirement_required = 0, observed_at = 0,
             last_probe_status = 'never', retirement_reason = NULL, updated_at = ?
         WHERE floor_slot = ? AND floor_epoch = ? AND lifecycle_version = ?
           AND state = 'draining'`,
        this.config.floorSocketCap,
        nowSeconds,
        current.floor_slot,
        current.floor_epoch,
        current.lifecycle_version,
      );
      this.incrementRevision();
      return true;
    });
  }

  private async scheduleRetirementAlarm(delayMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(1_000, delayMs);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || deadline < current) await this.ctx.storage.setAlarm(deadline);
  }

  private revision(): number {
    const row = firstRow(
      this.ctx.storage.sql.exec<RevisionRow>(
        "SELECT revision FROM directory_meta WHERE singleton = 1",
      ),
    );
    if (!row) throw new Error("directory_meta invariant violated");
    return row.revision;
  }

  private incrementRevision(): number {
    const next = this.revision() + 1;
    this.ctx.storage.sql.exec(
      "UPDATE directory_meta SET revision = ? WHERE singleton = 1",
      next,
    );
    return next;
  }

  private descriptor(
    request: Pick<
      RetirementRequest,
      "realmId" | "depth" | "locationHint" | "bucketCount" | "bucket"
    >,
    floorEpoch: number,
    floorSlot: number,
  ): FloorDescriptor {
    return floorDescriptorFor({ ...request, floorSlot }, floorEpoch);
  }

  private descriptorFromIdentity(
    identity: DirectoryIdentityRow,
    floorEpoch: number,
    floorSlot: number,
  ): FloorDescriptor {
    return floorDescriptorFor(
      {
        realmId: identity.realm_id,
        depth: identity.depth,
        locationHint: identity.location_hint as DurableObjectLocationHint,
        bucketCount: identity.bucket_count,
        bucket: identity.bucket,
        floorSlot,
      },
      floorEpoch,
    );
  }
}
