import { MAX_GAME_DEPTH, floorObjectName, isUuid, type RouteTicketVerificationKey } from "./protocol";

export const ALLOCATION_PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_BODY_BYTES = 2_048;
export const CONTROL_CLOCK_SKEW_SECONDS = 30;
export const MAX_DIRECTORY_PROBES = 4;
export const ALLOCATOR_LAYOUT_VERSION = 1 as const;

const CONTROL_SIGNATURE_DOMAIN = "grokhack-control:v1";
const encoder = new TextEncoder();
const UUID_LOWER_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REALM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const HEX_SIGNATURE_RE = /^[0-9a-f]{64}$/u;
const RETIREMENT_REASONS = new Set<RetirementReason>([
  "tombstone_limit",
  "capacity_rebalance",
  "operator_drain",
  "schema_migration",
]);
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

export type RetirementReason =
  | "tombstone_limit"
  | "capacity_rebalance"
  | "operator_drain"
  | "schema_migration";

export interface AllocationRequest {
  v: typeof ALLOCATION_PROTOCOL_VERSION;
  operationId: string;
  playerId: string;
  partyId?: string;
  realmId: string;
  depth: number;
  locationHint: DurableObjectLocationHint;
  capacityUnits: number;
}

export interface DirectoryAllocationRequest extends AllocationRequest {
  bucketCount: number;
  bucket: number;
}

export interface RetirementRequest {
  v: typeof ALLOCATION_PROTOCOL_VERSION;
  operationId: string;
  realmId: string;
  depth: number;
  locationHint: DurableObjectLocationHint;
  bucketCount: number;
  bucket: number;
  floorSlot: number;
  floorInstanceId: string;
  floorEpoch: number;
  reason: RetirementReason;
}

export interface FloorDescriptor {
  realmId: string;
  depth: number;
  locationHint: DurableObjectLocationHint;
  allocatorLayoutVersion: typeof ALLOCATOR_LAYOUT_VERSION;
  bucketCount: number;
  bucket: number;
  floorSlot: number;
  floorInstanceId: string;
  floorEpoch: number;
  floorObjectName: string;
}

export interface FloorAssignment extends FloorDescriptor {
  reservationId: string;
  reservationExpiresAt: number;
}

export interface FloorCapacitySnapshot {
  ok: true;
  v: 1;
  floorObjectName: string;
  floorEpoch: number;
  livePlayers: number;
  pendingPlayers: number;
  pendingSockets: number;
  totalSockets: number;
  durableSessions: number;
  frozenTransfers: number;
  preparedTransfers: number;
  maxPlayers: number;
  maxDurableSessions: number;
  acceptingNewPlayers: boolean;
  retirementRequired: boolean;
  retired: boolean;
  emptyForRetirement: boolean;
  reservationOccupancy: ReadonlyArray<{ reservationId: string; players: number }>;
  observedAt: number;
}

export type FloorCapacityResult =
  | FloorCapacitySnapshot
  | { ok: false; code: "invalid_request" | "identity_mismatch" };

export type FloorRetirementSealResult =
  | {
      ok: true;
      phase: "blocked" | "draining" | "retired";
      floorObjectName: string;
      floorEpoch: number;
      liveSockets: number;
      frozenTransfers: number;
      preparedTransfers: number;
    }
  | {
      ok: false;
      code: "invalid_request" | "identity_mismatch" | "floor_not_empty";
      liveSockets?: number;
      frozenTransfers?: number;
    };

export type AllocationDecision = "affinity_reuse" | "existing_floor" | "new_floor" | "rotated_floor";

export interface AllocationSuccess {
  ok: true;
  decision: AllocationDecision;
  operationId: string;
  assignment: FloorAssignment;
  directory: { bucket: number; revision: number };
  capacity: {
    observedLivePlayers: number;
    observedPendingPlayers: number;
    observedPendingSockets: number;
    reservedUnits: number;
    maxPlayers: number;
  };
  probes: number;
}

export interface AllocationFailure {
  ok: false;
  code:
    | "invalid_request"
    | "identity_mismatch"
    | "operation_reused"
    | "affinity_capacity_conflict"
    | "directory_at_capacity"
    | "directory_receipt_capacity"
    | "directory_schema_incompatible"
    | "floor_unavailable"
    | "receipt_corrupt";
  retryable: boolean;
  requiresFreshAssignment: boolean;
  overloaded?: boolean;
  bucket?: number;
  probes?: number;
}

export type AllocationResult = AllocationSuccess | AllocationFailure;

export type RetirementResult =
  | {
      ok: true;
      operationId: string;
      phase: "draining";
      retiredFloor: FloorDescriptor;
      activeReservationUnits: number;
      liveSockets: number;
      frozenTransfers: number;
      preparedTransfers: number;
      retryAfterSeconds: number;
      directory: { bucket: number; revision: number };
    }
  | {
      ok: true;
      operationId: string;
      phase: "rotated";
      retiredFloor: FloorDescriptor;
      replacement: FloorDescriptor;
      directory: { bucket: number; revision: number };
    }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "identity_mismatch"
        | "operation_reused"
        | "floor_slot_not_found"
        | "stale_floor_epoch"
        | "floor_epoch_exhausted"
        | "floor_unavailable"
        | "directory_receipt_capacity"
        | "directory_schema_incompatible"
        | "receipt_corrupt";
      retryable: boolean;
      requiresFreshAssignment: boolean;
      currentFloor?: FloorDescriptor;
      overloaded?: boolean;
    };

export class AllocationProtocolError extends Error {
  constructor(readonly code: "invalid_request" | "unauthorized") {
    super(code);
    this.name = "AllocationProtocolError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isLowerUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_LOWER_RE.test(value) && isUuid(value);
}

function isRealmId(value: unknown): value is string {
  return typeof value === "string" && REALM_ID_RE.test(value);
}

function isLocationHint(value: unknown): value is DurableObjectLocationHint {
  return typeof value === "string" && LOCATION_HINTS.has(value as DurableObjectLocationHint);
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 4_096 && (value & (value - 1)) === 0;
}

function parseAllocation(candidate: unknown, includeBucket: boolean): DirectoryAllocationRequest {
  if (!isPlainObject(candidate)) throw new AllocationProtocolError("invalid_request");
  const required = [
    "v",
    "operationId",
    "playerId",
    "realmId",
    "depth",
    "locationHint",
    "capacityUnits",
    ...(includeBucket ? ["bucketCount", "bucket"] : []),
  ];
  if (!exactKeys(candidate, required, ["partyId"])) {
    throw new AllocationProtocolError("invalid_request");
  }
  if (
    candidate.v !== ALLOCATION_PROTOCOL_VERSION ||
    !isLowerUuid(candidate.operationId) ||
    !isLowerUuid(candidate.playerId) ||
    (candidate.partyId !== undefined && !isLowerUuid(candidate.partyId)) ||
    !isRealmId(candidate.realmId) ||
    !isIntegerInRange(candidate.depth, 1, MAX_GAME_DEPTH) ||
    !isLocationHint(candidate.locationHint) ||
    !isIntegerInRange(candidate.capacityUnits, 1, 16) ||
    (includeBucket &&
      (!isIntegerInRange(candidate.bucketCount, 1, 4_096) ||
        !isPowerOfTwo(Number(candidate.bucketCount)) ||
        !isIntegerInRange(candidate.bucket, 0, Number(candidate.bucketCount) - 1)))
  ) {
    throw new AllocationProtocolError("invalid_request");
  }
  return {
    v: ALLOCATION_PROTOCOL_VERSION,
    operationId: candidate.operationId,
    playerId: candidate.playerId,
    ...(candidate.partyId === undefined ? {} : { partyId: candidate.partyId }),
    realmId: candidate.realmId,
    depth: candidate.depth,
    locationHint: candidate.locationHint,
    capacityUnits: candidate.capacityUnits,
    bucketCount: includeBucket ? Number(candidate.bucketCount) : 1,
    bucket: includeBucket ? Number(candidate.bucket) : 0,
  };
}

export function parseAllocationRequest(candidate: unknown): AllocationRequest {
  const parsed = parseAllocation(candidate, false);
  const { bucket: _bucket, bucketCount: _bucketCount, ...request } = parsed;
  return request;
}

export function parseDirectoryAllocationRequest(candidate: unknown): DirectoryAllocationRequest {
  return parseAllocation(candidate, true);
}

export function parseRetirementRequest(candidate: unknown): RetirementRequest {
  if (!isPlainObject(candidate)) throw new AllocationProtocolError("invalid_request");
  const required = [
    "v",
    "operationId",
    "realmId",
    "depth",
    "locationHint",
    "bucketCount",
    "bucket",
    "floorSlot",
    "floorInstanceId",
    "floorEpoch",
    "reason",
  ];
  if (
    !exactKeys(candidate, required) ||
    candidate.v !== ALLOCATION_PROTOCOL_VERSION ||
    !isLowerUuid(candidate.operationId) ||
    !isRealmId(candidate.realmId) ||
    !isIntegerInRange(candidate.depth, 1, MAX_GAME_DEPTH) ||
    !isLocationHint(candidate.locationHint) ||
    !isIntegerInRange(candidate.bucketCount, 1, 4_096) ||
    !isPowerOfTwo(Number(candidate.bucketCount)) ||
    !isIntegerInRange(candidate.bucket, 0, Number(candidate.bucketCount) - 1) ||
    !isIntegerInRange(candidate.floorSlot, 0, 4_095) ||
    typeof candidate.floorInstanceId !== "string" ||
    candidate.floorInstanceId !==
      floorInstanceIdForSlot(
        candidate.locationHint,
        Number(candidate.bucketCount),
        Number(candidate.bucket),
        Number(candidate.floorSlot),
      ) ||
    !isIntegerInRange(candidate.floorEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    typeof candidate.reason !== "string" ||
    !RETIREMENT_REASONS.has(candidate.reason as RetirementReason)
  ) {
    throw new AllocationProtocolError("invalid_request");
  }
  return candidate as unknown as RetirementRequest;
}

export function allocationAffinityKey(request: Pick<AllocationRequest, "partyId" | "playerId">): string {
  return request.partyId ? `party:${request.partyId}` : `player:${request.playerId}`;
}

export function directoryBucketFor(
  request: Pick<AllocationRequest, "partyId" | "playerId">,
  bucketCount: number,
): number {
  if (!isPowerOfTwo(bucketCount)) throw new AllocationProtocolError("invalid_request");
  const value = allocationAffinityKey(request);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & (bucketCount - 1);
}

export function realmDirectoryObjectName(
  environment: string,
  request: Pick<AllocationRequest, "realmId" | "depth" | "locationHint">,
  bucketCount: number,
  bucket: number,
): string {
  return `realm-directory:v${ALLOCATOR_LAYOUT_VERSION}:${environment}:${request.locationHint}:${request.realmId}:d${request.depth}:n${bucketCount}:b${bucket}`;
}

export function floorInstanceIdForSlot(
  locationHint: DurableObjectLocationHint,
  bucketCount: number,
  bucket: number,
  floorSlot: number,
): string {
  return `a${ALLOCATOR_LAYOUT_VERSION}-${locationHint}-n${bucketCount}-b${bucket}-s${floorSlot}`;
}

export function floorDescriptorFor(
  input: Pick<
    RetirementRequest,
    "realmId" | "depth" | "locationHint" | "bucketCount" | "bucket" | "floorSlot"
  >,
  floorEpoch: number,
): FloorDescriptor {
  const floorInstanceId = floorInstanceIdForSlot(
    input.locationHint,
    input.bucketCount,
    input.bucket,
    input.floorSlot,
  );
  return {
    realmId: input.realmId,
    depth: input.depth,
    locationHint: input.locationHint,
    allocatorLayoutVersion: ALLOCATOR_LAYOUT_VERSION,
    bucketCount: input.bucketCount,
    bucket: input.bucket,
    floorSlot: input.floorSlot,
    floorInstanceId,
    floorEpoch,
    floorObjectName: floorObjectName({
      realmId: input.realmId,
      floorInstanceId,
      depth: input.depth,
      floorEpoch,
    }),
  };
}

export function assignmentFor(
  input: Pick<
    RetirementRequest,
    "realmId" | "depth" | "locationHint" | "bucketCount" | "bucket" | "floorSlot"
  >,
  floorEpoch: number,
  reservationId: string,
  reservationExpiresAt: number,
): FloorAssignment {
  return {
    ...floorDescriptorFor(input, floorEpoch),
    reservationId,
    reservationExpiresAt,
  };
}

function signingInputPrefix(
  environment: string,
  method: string,
  path: string,
  timestamp: string,
  keyId: string,
): string {
  return `${environment}\n${CONTROL_SIGNATURE_DOMAIN}\n${method}\n${path}\n${timestamp}\n${keyId}\n`;
}

function signedBytes(prefix: string, body: Uint8Array): Uint8Array {
  const prefixBytes = encoder.encode(prefix);
  const combined = new Uint8Array(prefixBytes.byteLength + body.byteLength);
  combined.set(prefixBytes);
  combined.set(body, prefixBytes.byteLength);
  return combined;
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyControlSignature(input: {
  method: string;
  path: string;
  timestamp: string | null;
  keyId: string | null;
  signature: string | null;
  body: Uint8Array;
  environment: string;
  keys: readonly RouteTicketVerificationKey[];
  nowSeconds?: number;
}): Promise<boolean> {
  if (
    input.method !== "POST" ||
    !/^\/internal\/allocation\/(?:assign|retire)$/u.test(input.path) ||
    !input.timestamp ||
    !/^(?:0|[1-9][0-9]{0,15})$/u.test(input.timestamp) ||
    !input.keyId ||
    !input.signature ||
    !HEX_SIGNATURE_RE.test(input.signature)
  ) {
    return false;
  }
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > CONTROL_CLOCK_SKEW_SECONDS) {
    return false;
  }
  const selected = input.keys.find((key) => key.keyId === input.keyId);
  if (!selected) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(selected.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(input.signature),
    signedBytes(
      signingInputPrefix(
        input.environment,
        input.method,
        input.path,
        input.timestamp,
        input.keyId,
      ),
      input.body,
    ),
  );
}

export async function canonicalRequestHash(kind: "allocate" | "retire", request: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`${kind}\n${JSON.stringify(request)}`)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
