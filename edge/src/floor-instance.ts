import { DurableObject } from "cloudflare:workers";
import { gameplayStateHash, reduceGameplay } from "../../src/gameplay-reducer";
import { movementStateHash, reduceMovement } from "../../src/movement-reducer";

import type {
  FloorCapacityResult,
  FloorRetirementSealResult,
} from "./allocation-protocol";
import { requireEdgeConfig, type EdgeConfig } from "./config";
import type { Env } from "./env";
import type {
  AuthorizeJoinResult,
  SessionAuthorityFence,
  TransferHandoff,
  TransferResult,
} from "./player-session";
import {
  buildFloorBootstrap,
  FLOOR_GENERATOR_VERSION,
  FLOOR_SIMULATION_PROFILE,
  supportsFloorGeneratorVersion,
} from "./floor-bootstrap";
import { MAX_TRANSFER_HANDOFF_BYTES, MAX_TRANSFER_RECEIPTS } from "./player-session";
import {
  DEDUPE_WINDOW_PER_SESSION,
  EDGE_PROTOCOL_VERSION,
  MAX_INBOUND_FRAME_BYTES,
  floorObjectName,
  isPositiveSafeInteger,
  isResumeProofGrant,
  isTokenId,
  isUuid,
  playerSessionObjectName,
  type RouteTicketClaims,
  verifyRouteTicketWithKeyring,
} from "./protocol";

const SUPERSEDED_CLOSE_CODE = 4_001;
const STALE_SESSION_CLOSE_CODE = 4_002;
const JOIN_EXPIRED_CLOSE_CODE = 4_003;
const RATE_LIMIT_CLOSE_CODE = 4_008;
const FLOOR_OVERLOAD_CLOSE_CODE = 1_013;
const PROBE_REQUEST_HASH = "slo_probe:v1";
const FLOOR_SCHEMA_VERSION = 7;
const FLOOR_IDENTITY_RE =
  /^floor:v1:([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?):i([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?):d([1-9]|1[0-5]):e([1-9][0-9]{0,15})$/u;
const HUNGER_STATES = new Set([
  "satiated",
  "normal",
  "hungry",
  "weak",
  "fainting",
  "starving",
]);
const frameEncoder = new TextEncoder();
const frameScratch = new Uint8Array(MAX_INBOUND_FRAME_BYTES + 1);

interface SocketAttachment {
  v: 4;
  playerId: string;
  playerName: string;
  depth: number;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  resumeProofGrant: string;
  keyId: string;
  floorObjectName: string;
  allocationReservationId?: string;
  locationHint: DurableObjectLocationHint;
  connectionId: string;
  ticketId: string;
  expiresAt: number;
  joined: boolean;
  messageWindowStartedAt: number;
  messagesInWindow: number;
  messageTokens?: number;
  messageRefilledAt?: number;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  session_epoch: number;
  authority_epoch: number;
  lease_id: string;
  last_client_seq: number;
  connection_id: string;
  disconnected_at: number | null;
  transfer_frozen: number;
  transfer_id: string | null;
}

interface RevisionRow extends Record<string, SqlStorageValue> {
  revision: number;
}

interface CachedCommandRow extends Record<string, SqlStorageValue> {
  request_hash: string;
  response_json: string;
}

interface TransferCommandRow extends Record<string, SqlStorageValue> {
  client_seq: number;
  server_revision: number;
  request_hash: string;
  response_json: string;
}

interface GameplayRow extends Record<string, SqlStorageValue> {
  turns: number;
  hunger: number;
  max_hunger: number;
  hunger_state: string;
  hp: number;
  alive: number;
}

interface MovementCellRow extends Record<string, SqlStorageValue> {
  tile: "#" | "." | ">" | "<" | "+";
  trap: number;
  stairs_down: number;
  item_present: number;
  room_effect: number;
}

interface PlayerPositionRow extends Record<string, SqlStorageValue> {
  x: number;
  y: number;
  phase: "playing" | "inventory" | "dead" | "won";
  immobilized_turns: number;
  present: number;
}

interface FloorWorldRow extends Record<string, SqlStorageValue> {
  status: "ready";
  generator_version: number;
  ruleset_version: number;
  simulation_profile: string;
  seed: number;
  width: number;
  height: number;
  entry_x: number;
  entry_y: number;
  cell_count: number;
  map_hash: string;
}

interface SpawnCellRow extends Record<string, SqlStorageValue> {
  x: number;
  y: number;
}

interface FloorCellIntegrityRow extends Record<string, SqlStorageValue> {
  cell_count: number;
  minimum_x: number | null;
  maximum_x: number | null;
  minimum_y: number | null;
  maximum_y: number | null;
  spawn_count: number;
  entry_spawn_count: number;
}

interface PersistedBootstrapCellRow extends Record<string, SqlStorageValue> {
  x: number;
  y: number;
  tile: "#" | "." | ">" | "<" | "+";
  spawn_rank: number | null;
}

interface VersionRow extends Record<string, SqlStorageValue> {
  version: number | null;
}

interface TransferExportRow extends Record<string, SqlStorageValue> {
  request_identity: string;
  response_json: string;
  status: "frozen" | "aborted" | "finalized";
  authority_token: string | null;
}

interface TransferImportRow extends Record<string, SqlStorageValue> {
  request_identity: string;
  status: string;
}

interface TransferPreparationRow extends Record<string, SqlStorageValue> {
  request_identity: string;
  status: "prepared" | "activated" | "aborted";
  control_token: string;
  handoff_json: string;
}

interface FloorTransferOperationRow extends Record<string, SqlStorageValue> {
  request_identity: string;
  response_json: string;
}

interface TicketRow extends Record<string, SqlStorageValue> {
  status: string;
  connection_id: string;
  expires_at: number;
}

interface NameRow extends Record<string, SqlStorageValue> {
  object_name: string;
}

interface LifecycleRow extends Record<string, SqlStorageValue> {
  state: "active" | "draining" | "retired";
  version: number;
}

interface MinimumRow extends Record<string, SqlStorageValue> {
  deadline: number | null;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

interface TableColumnRow extends Record<string, SqlStorageValue> {
  name: string;
}

type ActivationResult =
  | {
      ok: true;
      expectedClientSeq: number;
      position?: { x: number; y: number };
      movementProfile?: string;
      availableMoves?: ReadonlyArray<{ dx: number; dy: number }>;
    }
  | { ok: false; code: string };

type FloorReadyResult =
  | { ok: true; world: FloorWorldRow }
  | { ok: false; code: string };

type MovementPositionResult =
  | { ok: true; position: { x: number; y: number } }
  | { ok: false; code: string };

type ProbeResult =
  | { ok: true; response: string }
  | { ok: false; code: string; expectedClientSeq?: number };

const WAIT_REQUEST_HASH = "input:wait:v1";

function moveRequestHash(dx: number, dy: number): string {
  return `input:move:v1:${dx}:${dy}`;
}

function movementAuthorityFor(attachment: SocketAttachment): {
  realmId: string;
  floorInstanceId: string;
  depth: number;
  floorEpoch: number;
  rulesetVersion: number;
} | null {
  const match = FLOOR_IDENTITY_RE.exec(attachment.floorObjectName);
  if (!match) return null;
  const depth = Number(match[3]);
  const floorEpoch = Number(match[4]);
  if (depth !== attachment.depth || !Number.isSafeInteger(floorEpoch)) return null;
  return {
    realmId: match[1]!,
    floorInstanceId: match[2]!,
    depth,
    floorEpoch,
    rulesetVersion: 1,
  };
}

function validMovementCell(cell: MovementCellRow): boolean {
  return (
    (cell.tile === "#" || cell.tile === "." || cell.tile === ">" ||
      cell.tile === "<" || cell.tile === "+") &&
    (cell.trap === 0 || cell.trap === 1) &&
    (cell.stairs_down === 0 || cell.stairs_down === 1) &&
    (cell.item_present === 0 || cell.item_present === 1) &&
    (cell.room_effect === 0 || cell.room_effect === 1)
  );
}

function validGameplayRow(row: GameplayRow): boolean {
  return (
    Number.isSafeInteger(row.turns) &&
    row.turns >= 0 &&
    Number.isSafeInteger(row.hunger) &&
    row.hunger >= 0 &&
    Number.isSafeInteger(row.max_hunger) &&
    row.max_hunger > 0 &&
    HUNGER_STATES.has(row.hunger_state) &&
    Number.isSafeInteger(row.hp) &&
    (row.alive === 0 || row.alive === 1)
  );
}

export interface FloorTransferRequest extends SessionAuthorityFence {
  transferId: string;
  operationId: string;
  connectionId: string;
}

export interface ControlledFloorTransferRequest extends FloorTransferRequest {
  authorityToken: string;
}

export interface PrepareTransferImportRequest {
  transferId: string;
  operationId: string;
  playerId: string;
  sessionEpoch: number;
  authorityEpoch: number;
  leaseId: string;
  floorObjectName: string;
  controlToken: string;
  handoff: TransferHandoff;
}

export type TransferPreparationResult =
  | { ok: true; transferId: string; phase: "prepared" | "activated" | "aborted" }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "identity_mismatch"
        | "idempotency_conflict"
        | "stale_fence"
        | "floor_draining"
        | "transfer_in_progress"
        | "transfer_id_mismatch";
    };

export type FloorTransferResult =
  | { ok: true; transferId: string; phase: "frozen"; handoff: TransferHandoff }
  | { ok: true; transferId: string; phase: "aborted" | "finalized" }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "identity_mismatch"
        | "idempotency_conflict"
        | "stale_fence"
        | "floor_draining"
        | "transfer_in_progress"
        | "transfer_id_mismatch"
        | "terminal_state"
        | "handoff_unavailable"
        | "commit_irreversible"
        | "transfer_not_aborted"
        | "transfer_not_committed"
        | "session_authority_unavailable";
    };

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function firstRow<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}

function validFloorLifecycleRequest(
  input: unknown,
  objectName: string | undefined,
): input is { floorObjectName: string; floorEpoch: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const candidate = input as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    typeof candidate.floorObjectName === "string" &&
    candidate.floorObjectName === objectName &&
    isPositiveSafeInteger(candidate.floorEpoch) &&
    candidate.floorObjectName.endsWith(`:e${candidate.floorEpoch}`)
  );
}

function validFloorTransferRequest(input: FloorTransferRequest, objectName: string | undefined): boolean {
  return (
    isUuid(input.playerId) &&
    isUuid(input.transferId) &&
    isTokenId(input.operationId) &&
    isUuid(input.connectionId) &&
    isPositiveSafeInteger(input.sessionEpoch) &&
    isPositiveSafeInteger(input.authorityEpoch) &&
    isUuid(input.leaseId) &&
    typeof input.floorObjectName === "string" &&
    input.floorObjectName === objectName
  );
}

function floorTransferRequestIdentity(input: FloorTransferRequest, phase: string): string {
  return JSON.stringify([
    phase,
    input.transferId.toLowerCase(),
    input.playerId.toLowerCase(),
    input.sessionEpoch,
    input.authorityEpoch,
    input.leaseId.toLowerCase(),
    input.floorObjectName,
    input.connectionId.toLowerCase(),
  ]);
}

function transferPreparationIdentity(input: PrepareTransferImportRequest): string {
  return JSON.stringify([
    input.transferId.toLowerCase(),
    input.playerId.toLowerCase(),
    input.sessionEpoch,
    input.authorityEpoch,
    input.leaseId.toLowerCase(),
    input.floorObjectName,
    input.controlToken.toLowerCase(),
    input.handoff,
  ]);
}

function validTransferPreparation(
  input: PrepareTransferImportRequest,
  objectName: string | undefined,
): boolean {
  if (
    !isUuid(input.transferId) ||
    !isTokenId(input.operationId) ||
    !isUuid(input.playerId) ||
    !isPositiveSafeInteger(input.sessionEpoch) ||
    !isPositiveSafeInteger(input.authorityEpoch) ||
    !isUuid(input.leaseId) ||
    input.floorObjectName !== objectName ||
    !isUuid(input.controlToken) ||
    !input.handoff ||
    input.handoff.v !== 1 ||
    !Number.isSafeInteger(input.handoff.lastClientSeq) ||
    input.handoff.lastClientSeq < 0 ||
    !Array.isArray(input.handoff.receipts) ||
    input.handoff.receipts.length > MAX_TRANSFER_RECEIPTS ||
    frameEncoder.encode(JSON.stringify(input.handoff)).byteLength > MAX_TRANSFER_HANDOFF_BYTES
  ) {
    return false;
  }
  if (input.handoff.lastClientSeq === 0) return input.handoff.receipts.length === 0;
  if (input.handoff.receipts.at(-1)?.clientSeq !== input.handoff.lastClientSeq) return false;
  for (let index = 1; index < input.handoff.receipts.length; index++) {
    if (input.handoff.receipts[index]!.clientSeq !== input.handoff.receipts[index - 1]!.clientSeq + 1) {
      return false;
    }
  }
  return true;
}

function attachmentFor(socket: WebSocket): SocketAttachment | null {
  try {
    const value = socket.deserializeAttachment();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<SocketAttachment>;
    if (
      candidate.v !== 4 ||
      typeof candidate.playerId !== "string" ||
      typeof candidate.playerName !== "string" ||
      !Number.isSafeInteger(candidate.depth) || Number(candidate.depth) < 1 ||
      !Number.isSafeInteger(candidate.sessionEpoch) ||
      !Number.isSafeInteger(candidate.authorityEpoch) ||
      Number(candidate.authorityEpoch) < 1 ||
      typeof candidate.leaseId !== "string" ||
      !isResumeProofGrant(candidate.resumeProofGrant) ||
      typeof candidate.keyId !== "string" ||
      typeof candidate.floorObjectName !== "string" ||
      typeof candidate.locationHint !== "string" ||
      typeof candidate.connectionId !== "string" ||
      typeof candidate.ticketId !== "string" ||
      !Number.isSafeInteger(candidate.expiresAt) ||
      typeof candidate.joined !== "boolean" ||
      !Number.isSafeInteger(candidate.messageWindowStartedAt) ||
      !Number.isSafeInteger(candidate.messagesInWindow) ||
      ((candidate.messageTokens !== undefined || candidate.messageRefilledAt !== undefined) &&
        (typeof candidate.messageTokens !== "number" ||
          !Number.isFinite(candidate.messageTokens) ||
          candidate.messageTokens < 0 ||
          !Number.isSafeInteger(candidate.messageRefilledAt)))
    ) {
      return null;
    }
    return candidate as SocketAttachment;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, body: unknown): void {
  try {
    socket.send(JSON.stringify(body));
  } catch {
    // The peer can disappear between event dispatch and send. Durable state is authoritative.
  }
}

function messageExceedsLimit(message: string | ArrayBuffer): boolean {
  if (message instanceof ArrayBuffer) return message.byteLength > MAX_INBOUND_FRAME_BYTES;
  if (message.length > MAX_INBOUND_FRAME_BYTES) return true;
  const encoded = frameEncoder.encodeInto(message, frameScratch);
  return encoded.written > MAX_INBOUND_FRAME_BYTES || encoded.read < message.length;
}

export class FloorInstance extends DurableObject<Env> {
  private readonly config: EdgeConfig;
  private readonly bindings: Env;
  private readonly schemaCompatible: boolean;
  private floorEventTokens: number;
  private floorEventRefilledAt: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    this.config = requireEdgeConfig(env);
    this.floorEventTokens = this.config.floorEventBurst;
    this.floorEventRefilledAt = Date.now();
    this.schemaCompatible = this.initializeSchema();
  }

  private initializeSchema(): boolean {
    const migrationTable = firstRow(
      this.ctx.storage.sql.exec<NameRow>(
        "SELECT name AS object_name FROM sqlite_master WHERE type = 'table' AND name = '_sql_schema_migrations'",
      ),
    );
    if (migrationTable) {
      const maximumVersion = firstRow(
        this.ctx.storage.sql.exec<VersionRow>(
          "SELECT MAX(version) AS version FROM _sql_schema_migrations",
        ),
      )?.version;
      if (
        maximumVersion !== null &&
        maximumVersion !== undefined &&
        maximumVersion > FLOOR_SCHEMA_VERSION
      ) {
        return false;
      }
    }
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS floor_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      INSERT OR IGNORE INTO floor_meta (singleton, revision) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS floor_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        object_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS floor_lifecycle (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'retired')),
        version INTEGER NOT NULL CHECK (version >= 1),
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO floor_lifecycle
        (singleton, state, version, updated_at) VALUES (1, 'active', 1, unixepoch());

      CREATE TABLE IF NOT EXISTS floor_world (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        status TEXT NOT NULL CHECK (status = 'ready'),
        generator_version INTEGER NOT NULL CHECK (generator_version > 0),
        ruleset_version INTEGER NOT NULL CHECK (ruleset_version > 0),
        simulation_profile TEXT NOT NULL,
        seed INTEGER NOT NULL CHECK (seed > 0),
        width INTEGER NOT NULL CHECK (width > 0),
        height INTEGER NOT NULL CHECK (height > 0),
        entry_x INTEGER NOT NULL CHECK (entry_x >= 0),
        entry_y INTEGER NOT NULL CHECK (entry_y >= 0),
        cell_count INTEGER NOT NULL CHECK (cell_count > 0),
        map_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        player_id TEXT PRIMARY KEY,
        session_epoch INTEGER NOT NULL CHECK (session_epoch > 0),
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch > 0),
        lease_id TEXT NOT NULL,
        last_client_seq INTEGER NOT NULL CHECK (last_client_seq >= 0),
        connection_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        disconnected_at INTEGER,
        transfer_frozen INTEGER NOT NULL DEFAULT 0 CHECK (transfer_frozen IN (0, 1)),
        transfer_id TEXT
      );

      CREATE TABLE IF NOT EXISTS processed_commands (
        player_id TEXT NOT NULL,
        session_epoch INTEGER NOT NULL,
        client_seq INTEGER NOT NULL,
        server_revision INTEGER NOT NULL,
        request_hash TEXT NOT NULL DEFAULT 'slo_probe:v1',
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, session_epoch, client_seq)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS route_tickets (
        jti TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        session_epoch INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'abandoned')),
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS player_gameplay (
        player_id TEXT PRIMARY KEY,
        turns INTEGER NOT NULL CHECK (turns >= 0),
        hunger INTEGER NOT NULL CHECK (hunger >= 0),
        max_hunger INTEGER NOT NULL CHECK (max_hunger > 0),
        hunger_state TEXT NOT NULL,
        hp INTEGER NOT NULL,
        alive INTEGER NOT NULL CHECK (alive IN (0, 1))
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS floor_cells (
        x INTEGER NOT NULL CHECK (x >= 0),
        y INTEGER NOT NULL CHECK (y >= 0),
        tile TEXT NOT NULL CHECK (tile IN ('#', '.', '>', '<', '+')),
        trap INTEGER NOT NULL DEFAULT 0 CHECK (trap IN (0, 1)),
        stairs_down INTEGER NOT NULL DEFAULT 0 CHECK (stairs_down IN (0, 1)),
        item_present INTEGER NOT NULL DEFAULT 0 CHECK (item_present IN (0, 1)),
        room_effect INTEGER NOT NULL DEFAULT 0 CHECK (room_effect IN (0, 1)),
        spawn_rank INTEGER CHECK (spawn_rank IS NULL OR spawn_rank >= 0),
        PRIMARY KEY (x, y)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS player_positions (
        player_id TEXT PRIMARY KEY,
        x INTEGER NOT NULL CHECK (x >= 0),
        y INTEGER NOT NULL CHECK (y >= 0),
        phase TEXT NOT NULL DEFAULT 'playing'
          CHECK (phase IN ('playing', 'inventory', 'dead', 'won')),
        immobilized_turns INTEGER NOT NULL DEFAULT 0 CHECK (immobilized_turns >= 0),
        updated_revision INTEGER NOT NULL DEFAULT 0 CHECK (updated_revision >= 0),
        present INTEGER NOT NULL DEFAULT 0 CHECK (present IN (0, 1))
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS monster_positions (
        monster_id TEXT PRIMARY KEY,
        x INTEGER NOT NULL CHECK (x >= 0),
        y INTEGER NOT NULL CHECK (y >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        UNIQUE (x, y)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS transfer_exports (
        transfer_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        request_identity TEXT NOT NULL,
        response_json TEXT NOT NULL,
        authority_token TEXT,
        status TEXT NOT NULL CHECK (status IN ('frozen', 'aborted', 'finalized')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS transfer_imports (
        transfer_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        request_identity TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'activated'),
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS transfer_preparations (
        transfer_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        request_identity TEXT NOT NULL,
        control_token TEXT NOT NULL,
        handoff_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'activated', 'aborted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS floor_transfer_operations (
        operation_id TEXT PRIMARY KEY,
        transfer_id TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        request_identity TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      `);

    // Expand old local/pre-deploy v1 stores safely; production schema changes must
    // still follow the expand/contract release plan in the ADR.
    const sessionColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(sessions)")
        .toArray()
        .map((column) => column.name),
    );
    if (!sessionColumns.has("disconnected_at")) {
      this.ctx.storage.sql.exec("ALTER TABLE sessions ADD COLUMN disconnected_at INTEGER");
    }
    if (!sessionColumns.has("authority_epoch")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE sessions ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!sessionColumns.has("lease_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE sessions ADD COLUMN lease_id TEXT NOT NULL DEFAULT ''");
    }
    if (!sessionColumns.has("transfer_frozen")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE sessions ADD COLUMN transfer_frozen INTEGER NOT NULL DEFAULT 0 CHECK (transfer_frozen IN (0, 1))",
      );
    }
    if (!sessionColumns.has("transfer_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE sessions ADD COLUMN transfer_id TEXT");
    }
    const commandColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(processed_commands)")
        .toArray()
        .map((column) => column.name),
    );
    if (!commandColumns.has("request_hash")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE processed_commands ADD COLUMN request_hash TEXT NOT NULL DEFAULT 'slo_probe:v1'",
      );
    }
    const exportColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(transfer_exports)")
        .toArray()
        .map((column) => column.name),
    );
    if (!exportColumns.has("authority_token")) {
      this.ctx.storage.sql.exec("ALTER TABLE transfer_exports ADD COLUMN authority_token TEXT");
    }
    const gameplayColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(player_gameplay)")
        .toArray()
        .map((column) => column.name),
    );
    const gameplayExpansions = [
      ["hunger", "INTEGER NOT NULL DEFAULT 1000 CHECK (hunger >= 0)"],
      ["max_hunger", "INTEGER NOT NULL DEFAULT 1000 CHECK (max_hunger > 0)"],
      ["hunger_state", "TEXT NOT NULL DEFAULT 'satiated'"],
      ["hp", "INTEGER NOT NULL DEFAULT 20"],
      ["alive", "INTEGER NOT NULL DEFAULT 1 CHECK (alive IN (0, 1))"],
    ] as const;
    for (const [name, definition] of gameplayExpansions) {
      if (!gameplayColumns.has(name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE player_gameplay ADD COLUMN ${name} ${definition}`);
      }
    }
    const cellColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(floor_cells)")
        .toArray()
        .map((column) => column.name),
    );
    if (!cellColumns.has("spawn_rank")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE floor_cells ADD COLUMN spawn_rank INTEGER CHECK (spawn_rank IS NULL OR spawn_rank >= 0)",
      );
    }
    const positionColumns = new Set(
      this.ctx.storage.sql
        .exec<TableColumnRow>("PRAGMA table_info(player_positions)")
        .toArray()
        .map((column) => column.name),
    );
    if (!positionColumns.has("present")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE player_positions ADD COLUMN present INTEGER NOT NULL DEFAULT 0 CHECK (present IN (0, 1))",
      );
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS route_tickets_expiry ON route_tickets(expires_at);
      CREATE INDEX IF NOT EXISTS sessions_disconnected ON sessions(disconnected_at);
      DROP INDEX IF EXISTS player_positions_coordinate;
      CREATE UNIQUE INDEX IF NOT EXISTS player_positions_present_coordinate
        ON player_positions(x, y) WHERE present = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS floor_cells_spawn_rank
        ON floor_cells(spawn_rank) WHERE spawn_rank IS NOT NULL;
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (1, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (2, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (3, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (4, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (5, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (6, unixepoch());
      INSERT OR IGNORE INTO _sql_schema_migrations (version, applied_at) VALUES (7, unixepoch());
    `);
      return true;
    });
  }

  private assertSchemaCompatible(): void {
    if (!this.schemaCompatible) throw new Error("floor_schema_incompatible");
  }

  getCapacitySnapshot(input: unknown): FloorCapacityResult {
    this.assertSchemaCompatible();
    if (!validFloorLifecycleRequest(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    const identity = FLOOR_IDENTITY_RE.exec(input.floorObjectName);
    if (!identity) return { ok: false, code: "invalid_request" };
    if (!this.bindFloorIdentity(input.floorObjectName)) {
      return { ok: false, code: "identity_mismatch" };
    }
    const lifecycle = this.floorLifecycle();
    const floorReady = lifecycle.state === "active"
      ? this.ctx.storage.transactionSync(() => {
          const ready = this.ensureFloorReady(input.floorObjectName, Number(identity[3]));
          return ready.ok && !this.floorCellsMatchWorld(ready.world, Number(identity[3]))
            ? { ok: false as const, code: "floor_world_incompatible" }
            : ready;
        })
      : { ok: false as const, code: "floor_not_active" };
    const nowSeconds = Math.floor(Date.now() / 1_000);
    this.expirePendingSockets(nowSeconds);
    this.purgeExpiredTicketRows(nowSeconds);
    const sockets = this.ctx.getWebSockets();
    const attachments = sockets.map(attachmentFor);
    const livePlayerIds = new Set(
      attachments
        .filter((attachment): attachment is SocketAttachment => attachment?.joined === true)
        .map((attachment) => attachment.playerId),
    );
    const pendingPlayerIds = new Set(
      attachments
        .filter((attachment): attachment is SocketAttachment => attachment?.joined === false)
        .map((attachment) => attachment.playerId)
        .filter((playerId) => !livePlayerIds.has(playerId)),
    );
    const livePlayers = livePlayerIds.size;
    const pendingPlayers = pendingPlayerIds.size;
    const pendingSockets = attachments.filter((attachment) => attachment?.joined === false).length;
    const reservationPlayers = new Map<string, Set<string>>();
    for (const attachment of attachments) {
      if (!attachment?.allocationReservationId) continue;
      const players = reservationPlayers.get(attachment.allocationReservationId) ?? new Set<string>();
      players.add(attachment.playerId);
      reservationPlayers.set(attachment.allocationReservationId, players);
    }
    const durableSessions =
      firstRow(this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM sessions"))?.count ?? 0;
    const frozenSessions =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM sessions WHERE transfer_frozen = 1",
        ),
      )?.count ?? 0;
    const frozenExports =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM transfer_exports WHERE status = 'frozen'",
        ),
      )?.count ?? 0;
    const frozenTransfers = Math.max(frozenSessions, frozenExports);
    const preparedTransfers =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM transfer_preparations WHERE status = 'prepared'",
        ),
      )?.count ?? 0;
    const retirementRequired =
      !floorReady.ok ||
      lifecycle.state !== "active" ||
      durableSessions >= this.config.floorSessionTombstoneCap;
    // Pending sockets and prepared imports can overlap with later live state. Counting
    // them here is intentionally conservative; Floor admission remains the hard cap.
    const futurePlayerPressure = livePlayers + pendingPlayers + preparedTransfers;
    return {
      ok: true,
      v: 1,
      floorObjectName: input.floorObjectName,
      floorEpoch: input.floorEpoch,
      livePlayers,
      pendingPlayers,
      pendingSockets,
      totalSockets: sockets.length,
      durableSessions,
      frozenTransfers,
      preparedTransfers,
      maxPlayers: this.config.floorSocketCap,
      maxDurableSessions: this.config.floorSessionTombstoneCap,
      acceptingNewPlayers:
        floorReady.ok &&
        lifecycle.state === "active" &&
        !retirementRequired &&
        futurePlayerPressure < this.config.floorSocketCap &&
        sockets.length < this.config.floorSocketCap,
      retirementRequired,
      retired: lifecycle.state === "retired",
      emptyForRetirement:
        sockets.length === 0 && frozenTransfers === 0 && preparedTransfers === 0,
      reservationOccupancy: Array.from(reservationPlayers, ([reservationId, players]) => ({
        reservationId,
        players: players.size,
      })).sort((left, right) => left.reservationId.localeCompare(right.reservationId)),
      observedAt: nowSeconds,
    };
  }

  advanceFloorRetirement(input: unknown): FloorRetirementSealResult {
    this.assertSchemaCompatible();
    if (!validFloorLifecycleRequest(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    if (!this.bindFloorIdentity(input.floorObjectName)) {
      return { ok: false, code: "identity_mismatch" };
    }
    const frozenSessions =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM sessions WHERE transfer_frozen = 1",
        ),
      )?.count ?? 0;
    const frozenExports =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM transfer_exports WHERE status = 'frozen'",
        ),
      )?.count ?? 0;
    const frozenTransfers = Math.max(frozenSessions, frozenExports);
    const preparedTransfers =
      firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM transfer_preparations WHERE status = 'prepared'",
        ),
      )?.count ?? 0;
    const sockets = this.ctx.getWebSockets();
    let lifecycle = this.floorLifecycle();
    if (lifecycle.state === "active" && (frozenTransfers > 0 || preparedTransfers > 0)) {
      return {
        ok: true,
        phase: "blocked",
        floorObjectName: input.floorObjectName,
        floorEpoch: input.floorEpoch,
        liveSockets: sockets.length,
        frozenTransfers,
        preparedTransfers,
      };
    }
    if (lifecycle.state === "active") {
      this.ctx.storage.sql.exec(
        `UPDATE floor_lifecycle
         SET state = 'draining', version = version + 1, updated_at = unixepoch()
         WHERE singleton = 1 AND state = 'active'`,
      );
      lifecycle = this.floorLifecycle();
    }
    if (
      lifecycle.state === "draining" &&
      sockets.length === 0 &&
      frozenTransfers === 0 &&
      preparedTransfers === 0
    ) {
      this.ctx.storage.sql.exec(
        `UPDATE floor_lifecycle
         SET state = 'retired', version = version + 1, updated_at = unixepoch()
         WHERE singleton = 1 AND state = 'draining'`,
      );
      lifecycle = this.floorLifecycle();
    }
    return {
      ok: true,
      phase: lifecycle.state === "retired" ? "retired" : "draining",
      floorObjectName: input.floorObjectName,
      floorEpoch: input.floorEpoch,
      liveSockets: sockets.length,
      frozenTransfers,
      preparedTransfers,
    };
  }

  freezeSessionForTransfer(input: FloorTransferRequest): FloorTransferResult {
    this.assertSchemaCompatible();
    if (!validFloorTransferRequest(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    if (this.floorLifecycle().state !== "active") {
      return { ok: false, code: "floor_draining" };
    }
    const identity = floorTransferRequestIdentity(input, "freeze");
    return this.ctx.storage.transactionSync(() => {
      const replay = this.replayFloorTransferOperation(input.operationId, identity);
      if (replay) return replay;
      const priorExport = firstRow(
        this.ctx.storage.sql.exec<TransferExportRow>(
          `SELECT request_identity, response_json, status FROM transfer_exports
           WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (priorExport) {
        if (priorExport.request_identity !== floorTransferRequestIdentity(input, "source")) {
          return { ok: false, code: "idempotency_conflict" };
        }
        const result = JSON.parse(priorExport.response_json) as FloorTransferResult;
        return this.recordFloorTransferOperation(input, "freeze", identity, result);
      }
      const session = this.getSession(input.playerId.toLowerCase());
      if (!this.floorFenceMatches(input, session)) {
        return this.recordFloorTransferOperation(input, "freeze", identity, {
          ok: false,
          code: "stale_fence",
        });
      }
      if (session.transfer_frozen === 1) {
        return this.recordFloorTransferOperation(input, "freeze", identity, {
          ok: false,
          code:
            session.transfer_id === input.transferId.toLowerCase()
              ? "idempotency_conflict"
              : "transfer_in_progress",
        });
      }
      const gameplay = firstRow(
        this.ctx.storage.sql.exec<GameplayRow>(
          `SELECT turns, hunger, max_hunger, hunger_state, hp, alive
           FROM player_gameplay WHERE player_id = ?`,
          input.playerId.toLowerCase(),
        ),
      );
      if (gameplay && gameplay.alive !== 1) {
        return this.recordFloorTransferOperation(input, "freeze", identity, {
          ok: false,
          code: "terminal_state",
        });
      }
      // TransferHandoff v1 predates authoritative position state. Freezing a
      // movement-backed player without carrying that state would strand or
      // duplicate its floor occupancy. Keep transfer fail-closed until the
      // versioned position handoff is implemented.
      const position = firstRow(
        this.ctx.storage.sql.exec<PlayerPositionRow>(
          `SELECT x, y, phase, immobilized_turns
           FROM player_positions WHERE player_id = ?`,
          input.playerId.toLowerCase(),
        ),
      );
      if (position) {
        return this.recordFloorTransferOperation(input, "freeze", identity, {
          ok: false,
          code: "handoff_unavailable",
        });
      }
      const receiptRows = this.ctx.storage.sql
        .exec<TransferCommandRow>(
          `SELECT client_seq, server_revision, request_hash, response_json
           FROM processed_commands
           WHERE player_id = ? AND session_epoch = ?
           ORDER BY client_seq DESC LIMIT ?`,
          input.playerId.toLowerCase(),
          input.sessionEpoch,
          MAX_TRANSFER_RECEIPTS,
        )
        .toArray()
        .reverse();
      if (session.last_client_seq > 0) {
        if (!receiptRows.length || receiptRows.at(-1)?.client_seq !== session.last_client_seq) {
          return this.recordFloorTransferOperation(input, "freeze", identity, {
            ok: false,
            code: "handoff_unavailable",
          });
        }
        for (let index = 1; index < receiptRows.length; index++) {
          if (receiptRows[index]!.client_seq !== receiptRows[index - 1]!.client_seq + 1) {
            return this.recordFloorTransferOperation(input, "freeze", identity, {
              ok: false,
              code: "handoff_unavailable",
            });
          }
        }
      }
      const handoff: TransferHandoff = {
        v: 1,
        lastClientSeq: session.last_client_seq,
        receipts: receiptRows.map((row) => ({
          clientSeq: row.client_seq,
          serverRevision: row.server_revision,
          requestHash: row.request_hash,
          responseJson: row.response_json,
        })),
        gameplay: {
          turns: gameplay?.turns ?? 0,
          hunger: gameplay?.hunger ?? 1000,
          maxHunger: gameplay?.max_hunger ?? 1000,
          hungerState:
            (gameplay?.hunger_state as TransferHandoff["gameplay"]["hungerState"] | undefined) ??
            "satiated",
          hp: gameplay?.hp ?? 20,
          alive: gameplay ? gameplay.alive === 1 : true,
        },
      };
      if (frameEncoder.encode(JSON.stringify(handoff)).byteLength > MAX_TRANSFER_HANDOFF_BYTES) {
        return this.recordFloorTransferOperation(input, "freeze", identity, {
          ok: false,
          code: "handoff_unavailable",
        });
      }
      const result: FloorTransferResult = {
        ok: true,
        transferId: input.transferId.toLowerCase(),
        phase: "frozen",
        handoff,
      };
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET transfer_frozen = 1, transfer_id = ?, updated_at = unixepoch()
         WHERE player_id = ? AND session_epoch = ? AND authority_epoch = ?
           AND lease_id = ? AND connection_id = ? AND transfer_frozen = 0`,
        input.transferId.toLowerCase(),
        input.playerId.toLowerCase(),
        input.sessionEpoch,
        input.authorityEpoch,
        input.leaseId.toLowerCase(),
        input.connectionId.toLowerCase(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO transfer_exports
           (transfer_id, player_id, request_identity, response_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'frozen', unixepoch(), unixepoch())`,
        input.transferId.toLowerCase(),
        input.playerId.toLowerCase(),
        floorTransferRequestIdentity(input, "source"),
        JSON.stringify(result),
      );
      return this.recordFloorTransferOperation(input, "freeze", identity, result);
    });
  }

  bindFrozenTransfer(input: ControlledFloorTransferRequest): FloorTransferResult {
    this.assertSchemaCompatible();
    if (!validFloorTransferRequest(input, this.ctx.id.name) || !isUuid(input.authorityToken)) {
      return { ok: false, code: "invalid_request" };
    }
    return this.ctx.storage.transactionSync(() => {
      const exported = firstRow(
        this.ctx.storage.sql.exec<TransferExportRow>(
          `SELECT request_identity, response_json, status, authority_token
           FROM transfer_exports WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (!exported) return { ok: false, code: "transfer_id_mismatch" };
      if (exported.request_identity !== floorTransferRequestIdentity(input, "source")) {
        return { ok: false, code: "idempotency_conflict" };
      }
      if (exported.status !== "frozen") return { ok: false, code: "commit_irreversible" };
      const session = this.getSession(input.playerId.toLowerCase());
      if (
        !this.floorFenceMatches(input, session) ||
        session.transfer_frozen !== 1 ||
        session.transfer_id !== input.transferId.toLowerCase()
      ) {
        return { ok: false, code: "stale_fence" };
      }
      if (
        exported.authority_token !== null &&
        exported.authority_token !== input.authorityToken.toLowerCase()
      ) {
        return { ok: false, code: "transfer_in_progress" };
      }
      if (exported.authority_token === null) {
        this.ctx.storage.sql.exec(
          `UPDATE transfer_exports SET authority_token = ?, updated_at = unixepoch()
           WHERE transfer_id = ? AND authority_token IS NULL AND status = 'frozen'`,
          input.authorityToken.toLowerCase(),
          input.transferId.toLowerCase(),
        );
      }
      return JSON.parse(exported.response_json) as FloorTransferResult;
    });
  }

  releaseBoundTransfer(input: ControlledFloorTransferRequest): FloorTransferResult {
    this.assertSchemaCompatible();
    if (!validFloorTransferRequest(input, this.ctx.id.name) || !isUuid(input.authorityToken)) {
      return { ok: false, code: "invalid_request" };
    }
    return this.ctx.storage.transactionSync(() => {
      const exported = firstRow(
        this.ctx.storage.sql.exec<TransferExportRow>(
          `SELECT request_identity, response_json, status, authority_token
           FROM transfer_exports WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (!exported) return { ok: false, code: "transfer_id_mismatch" };
      if (
        exported.request_identity !== floorTransferRequestIdentity(input, "source") ||
        exported.authority_token !== input.authorityToken.toLowerCase()
      ) {
        return { ok: false, code: "idempotency_conflict" };
      }
      if (exported.status !== "frozen") return { ok: false, code: "commit_irreversible" };
      this.ctx.storage.sql.exec(
        `UPDATE transfer_exports SET authority_token = NULL, updated_at = unixepoch()
         WHERE transfer_id = ? AND authority_token = ? AND status = 'frozen'`,
        input.transferId.toLowerCase(),
        input.authorityToken.toLowerCase(),
      );
      return JSON.parse(exported.response_json) as FloorTransferResult;
    });
  }

  prepareTransferImport(input: PrepareTransferImportRequest): TransferPreparationResult {
    this.assertSchemaCompatible();
    if (!validTransferPreparation(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    if (this.floorLifecycle().state !== "active") {
      return { ok: false, code: "floor_draining" };
    }
    const identity = transferPreparationIdentity(input);
    return this.ctx.storage.transactionSync(() => {
      const prior = firstRow(
        this.ctx.storage.sql.exec<TransferPreparationRow>(
          `SELECT request_identity, status, control_token, handoff_json
           FROM transfer_preparations WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (prior) {
        if (prior.request_identity !== identity || prior.control_token !== input.controlToken.toLowerCase()) {
          return { ok: false, code: "idempotency_conflict" };
        }
        return prior.status === "aborted"
          ? { ok: false, code: "transfer_id_mismatch" }
          : { ok: true, transferId: input.transferId.toLowerCase(), phase: "prepared" };
      }
      const competing = firstRow(
        this.ctx.storage.sql.exec<{ transfer_id: string } & Record<string, SqlStorageValue>>(
          `SELECT transfer_id FROM transfer_preparations
           WHERE player_id = ? AND status = 'prepared' LIMIT 1`,
          input.playerId.toLowerCase(),
        ),
      );
      if (competing) return { ok: false, code: "transfer_in_progress" };
      const session = this.getSession(input.playerId.toLowerCase());
      if (
        session &&
        (session.session_epoch > input.sessionEpoch ||
          (session.session_epoch === input.sessionEpoch &&
            (session.authority_epoch > input.authorityEpoch ||
              (session.authority_epoch === input.authorityEpoch &&
                session.lease_id !== input.leaseId.toLowerCase()))))
      ) {
        return { ok: false, code: "stale_fence" };
      }
      if (!session) {
        const sessionCount = firstRow(
          this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM sessions"),
        )?.count;
        if ((sessionCount ?? 0) >= this.config.floorSessionTombstoneCap) {
          return { ok: false, code: "transfer_in_progress" };
        }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO transfer_preparations
           (transfer_id, player_id, request_identity, control_token, handoff_json,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'prepared', unixepoch(), unixepoch())`,
        input.transferId.toLowerCase(),
        input.playerId.toLowerCase(),
        identity,
        input.controlToken.toLowerCase(),
        JSON.stringify(input.handoff),
      );
      return { ok: true, transferId: input.transferId.toLowerCase(), phase: "prepared" };
    });
  }

  abortPreparedTransferImport(input: PrepareTransferImportRequest): TransferPreparationResult {
    this.assertSchemaCompatible();
    if (!validTransferPreparation(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    const identity = transferPreparationIdentity(input);
    return this.ctx.storage.transactionSync(() => {
      const prepared = firstRow(
        this.ctx.storage.sql.exec<TransferPreparationRow>(
          `SELECT request_identity, status, control_token, handoff_json
           FROM transfer_preparations WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (!prepared) {
        return { ok: true, transferId: input.transferId.toLowerCase(), phase: "aborted" };
      }
      if (prepared.request_identity !== identity || prepared.control_token !== input.controlToken.toLowerCase()) {
        return { ok: false, code: "idempotency_conflict" };
      }
      if (prepared.status === "activated") return { ok: false, code: "stale_fence" };
      this.ctx.storage.sql.exec(
        `UPDATE transfer_preparations SET status = 'aborted', updated_at = unixepoch()
         WHERE transfer_id = ? AND status <> 'activated'`,
        input.transferId.toLowerCase(),
      );
      this.pruneTerminalTransferArtifacts(input.transferId.toLowerCase());
      return { ok: true, transferId: input.transferId.toLowerCase(), phase: "aborted" };
    });
  }

  confirmTransferActivated(input: PrepareTransferImportRequest): TransferPreparationResult {
    this.assertSchemaCompatible();
    if (!validTransferPreparation(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    const prepared = firstRow(
      this.ctx.storage.sql.exec<TransferPreparationRow>(
        `SELECT request_identity, status, control_token, handoff_json
         FROM transfer_preparations WHERE transfer_id = ?`,
        input.transferId.toLowerCase(),
      ),
    );
    if (!prepared) return { ok: false, code: "transfer_id_mismatch" };
    if (
      prepared.request_identity !== transferPreparationIdentity(input) ||
      prepared.control_token !== input.controlToken.toLowerCase()
    ) {
      return { ok: false, code: "idempotency_conflict" };
    }
    return prepared.status === "activated"
      ? { ok: true, transferId: input.transferId.toLowerCase(), phase: "activated" }
      : { ok: false, code: "stale_fence" };
  }

  abortFrozenTransfer(input: ControlledFloorTransferRequest): FloorTransferResult {
    this.assertSchemaCompatible();
    return this.endFrozenTransfer(input, "abort");
  }

  finalizeFrozenTransfer(input: ControlledFloorTransferRequest): FloorTransferResult {
    this.assertSchemaCompatible();
    const result = this.endFrozenTransfer(input, "finalize");
    if (result.ok && result.phase === "finalized") {
      for (const socket of this.ctx.getWebSockets(`player:${input.playerId.toLowerCase()}`)) {
        const attachment = attachmentFor(socket);
        if (
          attachment &&
          attachment.sessionEpoch === input.sessionEpoch &&
          attachment.authorityEpoch === input.authorityEpoch &&
          attachment.leaseId === input.leaseId.toLowerCase() &&
          attachment.connectionId === input.connectionId.toLowerCase()
        ) {
          try {
            socket.close(SUPERSEDED_CLOSE_CODE, "transferred");
          } catch {
            // The durable frozen fence is already final.
          }
        }
      }
    }
    return result;
  }

  async cancelUnboundFreeze(input: FloorTransferRequest): Promise<FloorTransferResult> {
    this.assertSchemaCompatible();
    if (!validFloorTransferRequest(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    const exported = firstRow(
      this.ctx.storage.sql.exec<TransferExportRow>(
        `SELECT request_identity, response_json, status, authority_token
         FROM transfer_exports WHERE transfer_id = ?`,
        input.transferId.toLowerCase(),
      ),
    );
    if (!exported) return { ok: false, code: "transfer_id_mismatch" };
    if (exported.authority_token !== null) return { ok: false, code: "transfer_in_progress" };
    let snapshot: {
      sessionEpoch: number;
      authorityEpoch: number;
      leaseId: string;
      floorObjectName: string;
      transfer: { transferId: string; phase: string } | null;
    } | null;
    try {
      snapshot = await this.bindings.PLAYER_SESSIONS.getByName(
        playerSessionObjectName(this.config.environment, input.playerId),
      ).getSnapshot();
    } catch {
      return { ok: false, code: "session_authority_unavailable" };
    }
    const centralStillNamesSource = Boolean(
      snapshot &&
        snapshot.sessionEpoch === input.sessionEpoch &&
        snapshot.authorityEpoch === input.authorityEpoch &&
        snapshot.leaseId === input.leaseId.toLowerCase() &&
        snapshot.floorObjectName === input.floorObjectName,
    );
    const matchingTransferActive = Boolean(
      snapshot?.transfer &&
        snapshot.transfer.transferId === input.transferId.toLowerCase() &&
        snapshot.transfer.phase !== "aborted" &&
        snapshot.transfer.phase !== "activated",
    );
    if (!centralStillNamesSource || matchingTransferActive) {
      return { ok: false, code: "transfer_in_progress" };
    }
    return this.endFrozenTransfer(input, "abort", true);
  }

  private endFrozenTransfer(
    input: FloorTransferRequest,
    action: "abort" | "finalize",
    allowUnbound = false,
  ): FloorTransferResult {
    if (!validFloorTransferRequest(input, this.ctx.id.name)) {
      return { ok: false, code: "invalid_request" };
    }
    const identity = floorTransferRequestIdentity(input, action);
    return this.ctx.storage.transactionSync(() => {
      const replay = this.replayFloorTransferOperation(input.operationId, identity);
      if (replay) return replay;
      const exported = firstRow(
        this.ctx.storage.sql.exec<TransferExportRow>(
          `SELECT request_identity, response_json, status, authority_token FROM transfer_exports
           WHERE transfer_id = ?`,
          input.transferId.toLowerCase(),
        ),
      );
      if (!exported) {
        return this.recordFloorTransferOperation(input, action, identity, {
          ok: false,
          code: "transfer_id_mismatch",
        });
      }
      if (exported.request_identity !== floorTransferRequestIdentity(input, "source")) {
        return this.recordFloorTransferOperation(input, action, identity, {
          ok: false,
          code: "idempotency_conflict",
        });
      }
      const suppliedAuthorityToken =
        "authorityToken" in input && typeof input.authorityToken === "string"
          ? input.authorityToken.toLowerCase()
          : null;
      if (
        (allowUnbound && exported.authority_token !== null) ||
        (!allowUnbound &&
          (!isUuid(suppliedAuthorityToken) || exported.authority_token !== suppliedAuthorityToken))
      ) {
        return this.recordFloorTransferOperation(input, action, identity, {
          ok: false,
          code: "idempotency_conflict",
        });
      }
      if (action === "abort" && exported.status === "finalized") {
        return this.recordFloorTransferOperation(input, action, identity, {
          ok: false,
          code: "commit_irreversible",
        });
      }
      if (action === "finalize" && exported.status === "aborted") {
        return this.recordFloorTransferOperation(input, action, identity, {
          ok: false,
          code: "transfer_id_mismatch",
        });
      }
      const desiredPhase = action === "abort" ? "aborted" : "finalized";
      if (exported.status !== desiredPhase) {
        const session = this.getSession(input.playerId.toLowerCase());
        const sourceStillFrozen =
          this.floorFenceMatches(input, session) &&
          session.transfer_frozen === 1 &&
          session.transfer_id === input.transferId.toLowerCase();
        const sameFloorImport =
          action === "finalize"
            ? firstRow(
                this.ctx.storage.sql.exec<TransferPreparationRow>(
                  `SELECT request_identity, status, control_token, handoff_json
                   FROM transfer_preparations WHERE transfer_id = ?`,
                  input.transferId.toLowerCase(),
                ),
              )
            : undefined;
        if (!sourceStillFrozen && sameFloorImport?.status !== "activated") {
          return this.recordFloorTransferOperation(input, action, identity, {
            ok: false,
            code: "stale_fence",
          });
        }
        if (action === "abort") {
          this.ctx.storage.sql.exec(
            `UPDATE sessions SET transfer_frozen = 0, transfer_id = NULL, updated_at = unixepoch()
             WHERE player_id = ? AND transfer_id = ? AND transfer_frozen = 1`,
            input.playerId.toLowerCase(),
            input.transferId.toLowerCase(),
          );
        } else if (sourceStillFrozen) {
          this.ctx.storage.sql.exec(
            `UPDATE sessions SET disconnected_at = unixepoch(), updated_at = unixepoch()
             WHERE player_id = ? AND transfer_id = ? AND transfer_frozen = 1`,
            input.playerId.toLowerCase(),
            input.transferId.toLowerCase(),
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE transfer_exports SET status = ?, updated_at = unixepoch() WHERE transfer_id = ?",
          desiredPhase,
          input.transferId.toLowerCase(),
        );
      }
      const result = this.recordFloorTransferOperation(input, action, identity, {
        ok: true,
        transferId: input.transferId.toLowerCase(),
        phase: desiredPhase,
      });
      this.pruneTerminalTransferArtifacts(input.transferId.toLowerCase());
      return result;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.schemaCompatible) {
      return json({ error: "floor_schema_incompatible", retryable: false }, 503);
    }
    const url = new URL(request.url);
    if (url.pathname !== "/connect") return json({ error: "not_found" }, 404);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426, { Upgrade: "websocket" });
    }

    const rawTicket = request.headers.get("X-GrokHack-Route-Ticket");
    if (!rawTicket) return json({ error: "missing_route_ticket" }, 401);

    let claims: RouteTicketClaims;
    try {
      claims = await verifyRouteTicketWithKeyring(
        rawTicket,
        this.config.routeTicketVerificationKeys,
        {
          maximumTtlSeconds: this.config.routeTicketTtlSeconds + 5,
          expectedAudience: this.config.routeTicketAudience,
          expectedIssuer: this.config.routeTicketIssuer,
          expectedEnvironment: this.config.environment,
        },
      );
    } catch {
      return json({ error: "invalid_route_ticket" }, 401);
    }

    const expectedObjectName = floorObjectName(claims);
    if (this.ctx.id.name && this.ctx.id.name !== expectedObjectName) {
      return json({ error: "floor_identity_mismatch" }, 409);
    }
    if (!this.bindFloorIdentity(expectedObjectName)) {
      return json({ error: "floor_identity_mismatch" }, 409);
    }
    const lifecycle = this.floorLifecycle();
    if (lifecycle.state !== "active") {
      return json(
        {
          error: "stale_floor_epoch",
          lifecycle: lifecycle.state,
          retryable: false,
          requiresFreshAssignment: true,
        },
        409,
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    this.expirePendingSockets(nowSeconds);
    this.purgeExpiredTicketRows(nowSeconds);

    const priorSession = this.getSession(claims.playerId);
    if (priorSession && priorSession.session_epoch > claims.sessionEpoch) {
      return json({ error: "stale_session_epoch" }, 409);
    }
    if (!priorSession) {
      const sessionCount = firstRow(
        this.ctx.storage.sql.exec<CountRow>("SELECT COUNT(*) AS count FROM sessions"),
      )?.count;
      if ((sessionCount ?? 0) >= this.config.floorSessionTombstoneCap) {
        return json(
          {
            error: "floor_epoch_retirement_required",
            retryable: true,
            requiresFreshAssignment: true,
          },
          503,
          { "Retry-After": "3" },
        );
      }
    }
    const usedTicket = firstRow(
      this.ctx.storage.sql.exec<TicketRow>(
        "SELECT status, connection_id, expires_at FROM route_tickets WHERE jti = ?",
        claims.jti,
      ),
    );
    if (usedTicket) return json({ error: "route_ticket_replayed" }, 409);

    const allSockets = this.ctx.getWebSockets();
    const samePlayerSockets = allSockets.filter(
      (socket) => attachmentFor(socket)?.playerId === claims.playerId,
    );
    const pendingPlayerSockets = samePlayerSockets.filter(
      (socket) => attachmentFor(socket)?.joined === false,
    );
    const canSupersedePending =
      pendingPlayerSockets.length > 0 &&
      pendingPlayerSockets.every(
        (socket) => (attachmentFor(socket)?.sessionEpoch ?? Number.MAX_SAFE_INTEGER) < claims.sessionEpoch,
      );
    if (pendingPlayerSockets.length > 0 && !canSupersedePending) {
      return json({ error: "connection_attempt_pending" }, 409);
    }
    if (canSupersedePending) {
      for (const socket of pendingPlayerSockets) {
        const attachment = attachmentFor(socket);
        if (!attachment) continue;
        this.markTicketAbandoned(attachment);
        try {
          socket.close(SUPERSEDED_CLOSE_CODE, "superseded_pending_attempt");
        } catch {
          // The durable ticket state is authoritative if the peer disappeared.
        }
      }
    }
    // Closed hibernating sockets may remain visible until the close callback runs.
    // Exclude the attempts superseded above from the admission capacity decision.
    const capacitySockets = canSupersedePending
      ? allSockets.filter((socket) => !pendingPlayerSockets.includes(socket))
      : allSockets;
    const uniqueJoinedPlayers = new Set(
      capacitySockets
        .map((socket) => attachmentFor(socket))
        .filter((attachment): attachment is SocketAttachment => attachment?.joined === true)
        .map((attachment) => attachment.playerId),
    );
    const replacingActivePlayer = uniqueJoinedPlayers.has(claims.playerId);
    if (uniqueJoinedPlayers.size >= this.config.floorSocketCap && !replacingActivePlayer) {
      return json(
        { error: "floor_at_capacity", retryable: true, requiresFreshAssignment: true },
        503,
        { "Retry-After": "3" },
      );
    }
    // One temporary replacement socket above the player cap is the absolute bound.
    if (capacitySockets.length >= this.config.floorSocketCap + (replacingActivePlayer ? 1 : 0)) {
      return json(
        { error: "floor_socket_capacity", retryable: true, requiresFreshAssignment: true },
        503,
        { "Retry-After": "3" },
      );
    }

    const connectionId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO route_tickets
         (jti, player_id, session_epoch, connection_id, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', unixepoch())`,
      claims.jti,
      claims.playerId,
      claims.sessionEpoch,
      connectionId,
      claims.exp,
    );

    let server: WebSocket | undefined;
    try {
      const pair = new WebSocketPair();
      const client = pair[0];
      server = pair[1];
      this.ctx.acceptWebSocket(server, [`player:${claims.playerId}`]);
      server.serializeAttachment({
        v: 4,
        playerId: claims.playerId,
        playerName: claims.playerName,
        depth: claims.depth,
        sessionEpoch: claims.sessionEpoch,
        authorityEpoch: claims.authorityEpoch,
        leaseId: claims.leaseId,
        resumeProofGrant: claims.resumeProofGrant,
        keyId: claims.kid,
        floorObjectName: expectedObjectName,
        ...(claims.allocationReservationId === undefined
          ? {}
          : { allocationReservationId: claims.allocationReservationId }),
        locationHint: claims.locationHint,
        connectionId,
        ticketId: claims.jti,
        expiresAt: claims.exp,
        joined: false,
        messageWindowStartedAt: Date.now(),
        messagesInWindow: 0,
        messageTokens: this.config.floorMessageBurst,
        messageRefilledAt: Date.now(),
      } satisfies SocketAttachment);
      await this.scheduleMaintenance();

      send(server, {
        type: "welcome",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        online: uniqueJoinedPlayers.size,
        maxPlayers: this.config.floorSocketCap,
        sessionEpoch: claims.sessionEpoch,
        joinDeadline: claims.exp,
        architecture: "floor-instance-do",
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "Sec-WebSocket-Protocol": "grokhack.v4" },
      });
    } catch (error) {
      // Keep the JTI consumed until expiry. A failed upgrade must never make a
      // captured one-time credential reusable or fence the healthy connection.
      this.ctx.storage.sql.exec(
        "UPDATE route_tickets SET status = 'abandoned' WHERE jti = ? AND connection_id = ?",
        claims.jti,
        connectionId,
      );
      try {
        server?.close(1011, "admission_failed");
      } catch {
        // The pair may not have reached acceptWebSocket.
      }
      console.error(
        JSON.stringify({
          event: "floor_admission_failed",
          floor: expectedObjectName,
          errorClass: error instanceof Error ? error.name : "unknown",
        }),
      );
      return json({ error: "floor_admission_failed" }, 503, { "Retry-After": "1" });
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (!this.schemaCompatible) {
      send(socket, { type: "error", code: "floor_schema_incompatible", retryable: false });
      socket.close(1012, "floor_schema_incompatible");
      return;
    }
    if (messageExceedsLimit(message)) {
      socket.close(1009, "message_too_large");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "text_frames_only");
      return;
    }

    const attachment = attachmentFor(socket);
    if (!attachment) {
      socket.close(1011, "invalid_socket_attachment");
      return;
    }
    if (!this.consumeMessageBudget(socket, attachment)) return;

    const recoverableActive = this.isRecoverableActiveConnection(attachment);
    if (attachment.joined) {
      if (!this.isCurrentConnection(attachment)) {
        send(socket, { type: "error", code: "stale_connection", retryable: false });
        socket.close(STALE_SESSION_CLOSE_CODE, "stale_connection");
        return;
      }
    } else if (!this.isPendingConnection(attachment) && !recoverableActive) {
      send(socket, { type: "error", code: "invalid_connection_attempt", retryable: false });
      socket.close(STALE_SESSION_CLOSE_CODE, "invalid_connection_attempt");
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const joinDeadline = recoverableActive
      ? attachment.expiresAt + this.config.floorReplayGraceSeconds
      : attachment.expiresAt;
    if (!attachment.joined && joinDeadline <= nowSeconds) {
      if (recoverableActive) this.markSessionDisconnected(attachment);
      else this.markTicketAbandoned(attachment);
      send(socket, { type: "error", code: "join_deadline_expired", retryable: false });
      socket.close(JOIN_EXPIRED_CLOSE_CODE, "join_deadline_expired");
      return;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(message);
    } catch {
      send(socket, { type: "error", code: "malformed_json", retryable: false });
      return;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      send(socket, { type: "error", code: "invalid_message", retryable: false });
      return;
    }
    const frame = candidate as Record<string, unknown>;
    if (typeof frame.type !== "string") {
      send(socket, { type: "error", code: "invalid_message", retryable: false });
      return;
    }

    if (frame.type === "ping") {
      send(socket, { type: "pong", online: this.joinedPlayerCount() });
      return;
    }

    if (frame.type === "join") {
      if (frame.name !== attachment.playerName) {
        send(socket, { type: "error", code: "route_identity_mismatch", retryable: false });
        return;
      }
      this.ctx.waitUntil(this.completeJoin(socket, attachment));
      return;
    }

    if (!attachment.joined) {
      send(socket, { type: "error", code: "join_required", retryable: false });
      return;
    }

    if (frame.type === "slo_probe") {
      if (!Number.isSafeInteger(frame.clientSeq) || Number(frame.clientSeq) < 1) {
        send(socket, { type: "error", code: "invalid_client_sequence", retryable: false });
        return;
      }
      const result = this.commitProbe(attachment, Number(frame.clientSeq));
      if (result.ok) {
        try {
          socket.send(result.response);
        } catch {
          // The commit is durable even if the acknowledgement socket disappears.
        }
      } else {
        send(socket, {
          type: "error",
          code: result.code,
          expectedClientSeq: result.expectedClientSeq,
          retryable: false,
        });
      }
      return;
    }

    if (frame.type === "input") {
      if (frame.command === "wait" && Number.isSafeInteger(frame.clientSeq) && Number(frame.clientSeq) > 0) {
        const result = this.commitWait(attachment, Number(frame.clientSeq));
        if (result.ok) socket.send(result.response);
        else send(socket, { type: "error", code: result.code, expectedClientSeq: result.expectedClientSeq, retryable: false });
        return;
      }
      if (frame.command === "move") {
        if (!Number.isSafeInteger(frame.clientSeq) || Number(frame.clientSeq) < 1) {
          send(socket, { type: "error", code: "invalid_client_sequence", retryable: false });
          return;
        }
        const keys = Object.keys(frame).sort();
        if (keys.join(",") !== "clientSeq,command,dx,dy,type") {
          send(socket, { type: "error", code: "invalid_movement_input", retryable: false });
          return;
        }
        if (
          !Number.isSafeInteger(frame.dx) ||
          !Number.isSafeInteger(frame.dy) ||
          Math.abs(Number(frame.dx)) > 1 ||
          Math.abs(Number(frame.dy)) > 1 ||
          (Number(frame.dx) === 0 && Number(frame.dy) === 0)
        ) {
          send(socket, { type: "error", code: "invalid_movement_direction", retryable: false });
          return;
        }
        let result: ProbeResult;
        try {
          result = this.commitMove(
            attachment,
            Number(frame.clientSeq),
            Number(frame.dx),
            Number(frame.dy),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "floor_movement_commit_failed",
              floor: attachment.floorObjectName,
              errorClass: error instanceof Error ? error.name : "unknown",
            }),
          );
          send(socket, { type: "error", code: "movement_commit_failed", retryable: true });
          return;
        }
        if (result.ok) {
          try {
            socket.send(result.response);
          } catch {
            // The durable receipt makes response-loss retries byte-identical.
          }
        } else {
          send(socket, {
            type: "error",
            code: result.code,
            expectedClientSeq: result.expectedClientSeq,
            retryable: false,
          });
        }
        return;
      }
      send(socket, {
        type: "error",
        code: "edge_gameplay_not_migrated",
        retryable: false,
      });
      return;
    }

    send(socket, { type: "error", code: "unsupported_message_type", retryable: false });
  }

  webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    if (!this.schemaCompatible) return;
    this.markSocketClosed(socket);
    try {
      socket.close(code, reason);
    } catch {
      // The peer is already closed.
    }
    void wasClean;
  }

  webSocketError(socket: WebSocket): void {
    if (!this.schemaCompatible) return;
    this.markSocketClosed(socket);
    try {
      socket.close(1011, "websocket_error");
    } catch {
      // The peer is already closed.
    }
  }

  async alarm(): Promise<void> {
    if (!this.schemaCompatible) {
      console.error(JSON.stringify({ event: "floor_alarm_schema_incompatible" }));
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1_000);
    this.expirePendingSockets(nowSeconds);
    this.ctx.storage.transactionSync(() => {
      this.purgeExpiredTicketRows(nowSeconds);
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_commands
         WHERE EXISTS (
           SELECT 1 FROM sessions
           WHERE sessions.player_id = processed_commands.player_id
             AND sessions.session_epoch = processed_commands.session_epoch
             AND sessions.transfer_frozen = 0
             AND sessions.disconnected_at IS NOT NULL
             AND sessions.disconnected_at + ? <= ?
         )`,
        this.config.floorReplayGraceSeconds,
        nowSeconds,
      );
      // Keep the lightweight session sequence fence forever within this floor
      // epoch; deleting it would allow same-epoch sequence reset/double apply.
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET disconnected_at = NULL
         WHERE transfer_frozen = 0 AND disconnected_at IS NOT NULL AND disconnected_at + ? <= ?`,
        this.config.floorReplayGraceSeconds,
        nowSeconds,
      );
    });
    await this.scheduleMaintenance();
  }

  private bindFloorIdentity(expectedObjectName: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO floor_identity (singleton, object_name) VALUES (1, ?)",
        expectedObjectName,
      );
      const row = firstRow(
        this.ctx.storage.sql.exec<NameRow>(
          "SELECT object_name FROM floor_identity WHERE singleton = 1",
        ),
      );
      return row?.object_name === expectedObjectName;
    });
  }

  /** Must run inside the caller's SQLite transaction. */
  private ensureFloorReady(floorObjectName: string, depth: number): FloorReadyResult {
    const identity = firstRow(
      this.ctx.storage.sql.exec<NameRow>(
        "SELECT object_name FROM floor_identity WHERE singleton = 1",
      ),
    );
    if (identity?.object_name !== floorObjectName) {
      return { ok: false, code: "identity_mismatch" };
    }

    const existing = firstRow(
      this.ctx.storage.sql.exec<FloorWorldRow>(
        `SELECT status, generator_version, ruleset_version, simulation_profile,
                seed, width, height, entry_x, entry_y, cell_count, map_hash
         FROM floor_world WHERE singleton = 1`,
      ),
    );
    if (existing) {
      if (
        existing.status !== "ready" ||
        !supportsFloorGeneratorVersion(existing.generator_version) ||
        existing.ruleset_version !== 1 ||
        existing.simulation_profile !== FLOOR_SIMULATION_PROFILE ||
        !Number.isSafeInteger(existing.seed) ||
        existing.seed <= 0 ||
        !Number.isSafeInteger(existing.width) ||
        existing.width <= 0 ||
        !Number.isSafeInteger(existing.height) ||
        existing.height <= 0 ||
        !Number.isSafeInteger(existing.entry_x) ||
        existing.entry_x < 0 ||
        existing.entry_x >= existing.width ||
        !Number.isSafeInteger(existing.entry_y) ||
        existing.entry_y < 0 ||
        existing.entry_y >= existing.height ||
        !Number.isSafeInteger(existing.cell_count) ||
        existing.cell_count <= 0 ||
        existing.cell_count !== existing.width * existing.height ||
        !Number.isSafeInteger(existing.width * existing.height) ||
        !/^[0-9a-f]{16}$/u.test(existing.map_hash)
      ) {
        return { ok: false, code: "floor_world_incompatible" };
      }
      return { ok: true, world: existing };
    }

    const legacyState = firstRow(
      this.ctx.storage.sql.exec<CountRow>(
        `SELECT
           (SELECT COUNT(*) FROM floor_cells) +
           (SELECT COUNT(*) FROM player_positions) +
           (SELECT COUNT(*) FROM monster_positions) AS count`,
      ),
    )?.count;
    if (legacyState !== 0) return { ok: false, code: "floor_migration_required" };

    const bootstrap = buildFloorBootstrap(floorObjectName, depth);
    const batchSize = 128;
    for (let offset = 0; offset < bootstrap.cells.length; offset += batchSize) {
      const values = bootstrap.cells.slice(offset, offset + batchSize).map((cell) =>
        `(${cell.x},${cell.y},'${cell.tile}',0,0,0,0,${cell.spawnRank ?? "NULL"})`,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO floor_cells
           (x, y, tile, trap, stairs_down, item_present, room_effect, spawn_rank)
         VALUES ${values.join(",")}`,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO floor_world
         (singleton, status, generator_version, ruleset_version, simulation_profile,
          seed, width, height, entry_x, entry_y, cell_count, map_hash)
       VALUES (1, 'ready', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bootstrap.generatorVersion,
      bootstrap.simulationProfile,
      bootstrap.seed,
      bootstrap.width,
      bootstrap.height,
      bootstrap.entryX,
      bootstrap.entryY,
      bootstrap.cellCount,
      bootstrap.mapHash,
    );
    const created = firstRow(
      this.ctx.storage.sql.exec<FloorWorldRow>(
        `SELECT status, generator_version, ruleset_version, simulation_profile,
                seed, width, height, entry_x, entry_y, cell_count, map_hash
         FROM floor_world WHERE singleton = 1`,
      ),
    );
    if (!created) throw new Error("floor bootstrap invariant violated");
    return { ok: true, world: created };
  }

  /** Bounded full-map integrity check used at allocation and join, not per command. */
  private floorCellsMatchWorld(world: FloorWorldRow, depth: number): boolean {
    const integrity = firstRow(
      this.ctx.storage.sql.exec<FloorCellIntegrityRow>(
        `SELECT
           COUNT(*) AS cell_count,
           MIN(x) AS minimum_x,
           MAX(x) AS maximum_x,
           MIN(y) AS minimum_y,
           MAX(y) AS maximum_y,
           SUM(CASE WHEN spawn_rank IS NOT NULL THEN 1 ELSE 0 END) AS spawn_count,
           SUM(CASE
                 WHEN x = ? AND y = ? AND spawn_rank = 0 AND tile = '.'
                   AND trap = 0 AND stairs_down = 0
                   AND item_present = 0 AND room_effect = 0
                 THEN 1 ELSE 0
               END) AS entry_spawn_count
         FROM floor_cells`,
        world.entry_x,
        world.entry_y,
      ),
    );
    if (!(
      integrity?.cell_count === world.cell_count &&
      integrity.minimum_x === 0 &&
      integrity.maximum_x === world.width - 1 &&
      integrity.minimum_y === 0 &&
      integrity.maximum_y === world.height - 1 &&
      integrity.spawn_count >= this.config.floorSocketCap &&
      integrity.entry_spawn_count === 1
    )) {
      return false;
    }

    let expected;
    const floorObjectName = this.ctx.id.name;
    if (!floorObjectName) return false;
    try {
      expected = buildFloorBootstrap(floorObjectName, depth, world.generator_version);
    } catch {
      return false;
    }
    if (
      expected.seed !== world.seed ||
      expected.simulationProfile !== world.simulation_profile ||
      expected.width !== world.width ||
      expected.height !== world.height ||
      expected.entryX !== world.entry_x ||
      expected.entryY !== world.entry_y ||
      expected.cellCount !== world.cell_count ||
      expected.mapHash !== world.map_hash
    ) {
      return false;
    }

    const persisted = this.ctx.storage.sql.exec<PersistedBootstrapCellRow>(
      "SELECT x, y, tile, spawn_rank FROM floor_cells ORDER BY y, x",
    ).toArray();
    return persisted.length === expected.cells.length && persisted.every((cell, index) => {
      const canonical = expected.cells[index];
      return (
        canonical !== undefined &&
        cell.x === canonical.x &&
        cell.y === canonical.y &&
        cell.tile === canonical.tile &&
        cell.spawn_rank === canonical.spawnRank
      );
    });
  }

  /** Must run inside the movement command transaction. */
  private ensureMovementPosition(
    attachment: SocketAttachment,
    validateCells = false,
  ): MovementPositionResult {
    const ready = this.ensureFloorReady(attachment.floorObjectName, attachment.depth);
    if (!ready.ok) return ready;
    if (validateCells && !this.floorCellsMatchWorld(ready.world, attachment.depth)) {
      return { ok: false, code: "floor_world_incompatible" };
    }
    if (ready.world.simulation_profile !== FLOOR_SIMULATION_PROFILE) {
      return { ok: false, code: "edge_movement_profile_not_migrated" };
    }

    const gameplay = firstRow(
      this.ctx.storage.sql.exec<GameplayRow>(
        "SELECT turns, hunger, max_hunger, hunger_state, hp, alive FROM player_gameplay WHERE player_id = ?",
        attachment.playerId,
      ),
    );
    if (gameplay && !validGameplayRow(gameplay)) {
      return { ok: false, code: "movement_state_corrupt" };
    }
    if (gameplay?.alive === 0) return { ok: false, code: "terminal_state" };

    const existing = firstRow(
      this.ctx.storage.sql.exec<PlayerPositionRow>(
        `SELECT x, y, phase, immobilized_turns, present
         FROM player_positions WHERE player_id = ?`,
        attachment.playerId,
      ),
    );
    if (existing?.phase === "dead" || existing?.phase === "won") {
      return { ok: false, code: "terminal_state" };
    }
    if (existing?.present === 1) {
      return { ok: true, position: { x: existing.x, y: existing.y } };
    }

    let spawn = existing
      ? firstRow(
          this.ctx.storage.sql.exec<SpawnCellRow>(
            `SELECT x, y FROM floor_cells
             WHERE x = ? AND y = ? AND spawn_rank IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM player_positions
                 WHERE x = ? AND y = ? AND present = 1 AND player_id <> ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM monster_positions
                 WHERE x = ? AND y = ? AND active = 1
               )`,
            existing.x,
            existing.y,
            existing.x,
            existing.y,
            attachment.playerId,
            existing.x,
            existing.y,
          ),
        )
      : undefined;
    spawn ??= firstRow(
      this.ctx.storage.sql.exec<SpawnCellRow>(
        `SELECT floor_cells.x, floor_cells.y
         FROM floor_cells
         WHERE spawn_rank IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM player_positions
             WHERE player_positions.x = floor_cells.x
               AND player_positions.y = floor_cells.y
               AND player_positions.present = 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM monster_positions
             WHERE monster_positions.x = floor_cells.x
               AND monster_positions.y = floor_cells.y
               AND monster_positions.active = 1
           )
         ORDER BY spawn_rank
         LIMIT 1`,
      ),
    );
    if (!spawn) return { ok: false, code: "floor_capacity_exhausted" };

    if (existing) {
      this.ctx.storage.sql.exec(
        `UPDATE player_positions
         SET x = ?, y = ?, present = 1
         WHERE player_id = ? AND present = 0`,
        spawn.x,
        spawn.y,
        attachment.playerId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO player_positions
           (player_id, x, y, phase, immobilized_turns, updated_revision, present)
         VALUES (?, ?, ?, 'playing', 0, 0, 1)`,
        attachment.playerId,
        spawn.x,
        spawn.y,
      );
    }
    const positionChanges = firstRow(
      this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count"),
    )?.count;
    if (positionChanges !== 1) throw new Error("player spawn fence lost");
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO player_gameplay
         (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
       VALUES (?, 0, 1000, 1000, 'satiated', 20, 1)`,
      attachment.playerId,
    );
    return { ok: true, position: { x: spawn.x, y: spawn.y } };
  }

  /** Must run inside the caller's SQLite transaction. */
  private availablePlainMoves(
    playerId: string,
    position: { x: number; y: number },
  ): ReadonlyArray<{ dx: number; dy: number }> {
    const directions = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    return directions.filter(({ dx, dy }) => {
      const x = position.x + dx;
      const y = position.y + dy;
      const cell = firstRow(
        this.ctx.storage.sql.exec<MovementCellRow>(
          `SELECT tile, trap, stairs_down, item_present, room_effect
           FROM floor_cells WHERE x = ? AND y = ?`,
          x,
          y,
        ),
      );
      if (
        !cell ||
        !validMovementCell(cell) ||
        cell.tile !== "." ||
        cell.trap !== 0 ||
        cell.stairs_down !== 0 ||
        cell.item_present !== 0 ||
        cell.room_effect !== 0
      ) {
        return false;
      }
      const occupants = firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          `SELECT
             (SELECT COUNT(*) FROM player_positions
              WHERE x = ? AND y = ? AND present = 1 AND player_id <> ?) +
             (SELECT COUNT(*) FROM monster_positions
              WHERE x = ? AND y = ? AND active = 1) AS count`,
          x,
          y,
          playerId,
          x,
          y,
        ),
      )?.count;
      return occupants === 0;
    });
  }

  /** Claims a position only when the allocator already provisioned this floor. */
  private claimReadyFloorPosition(
    attachment: SocketAttachment,
  ):
    | {
        ok: true;
        position: { x: number; y: number };
        movementProfile: string;
        availableMoves: ReadonlyArray<{ dx: number; dy: number }>;
      }
    | { ok: false; code: string }
    | undefined {
    const provisioned = firstRow(
      this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM floor_world WHERE singleton = 1",
      ),
    )?.count;
    if (provisioned === 0) return undefined;
    if (provisioned !== 1) return { ok: false, code: "floor_world_incompatible" };
    const activeMonsters = firstRow(
      this.ctx.storage.sql.exec<CountRow>(
        "SELECT COUNT(*) AS count FROM monster_positions WHERE active = 1",
      ),
    )?.count;
    if (activeMonsters !== 0) {
      return { ok: false, code: "edge_movement_effect_not_migrated" };
    }
    const claimed = this.ensureMovementPosition(attachment, true);
    if (!claimed.ok) return claimed;
    return {
      ok: true,
      position: claimed.position,
      movementProfile: FLOOR_SIMULATION_PROFILE,
      availableMoves: this.availablePlainMoves(attachment.playerId, claimed.position),
    };
  }

  private floorLifecycle(): LifecycleRow {
    const row = firstRow(
      this.ctx.storage.sql.exec<LifecycleRow>(
        "SELECT state, version FROM floor_lifecycle WHERE singleton = 1",
      ),
    );
    if (!row) throw new Error("floor_lifecycle invariant violated");
    return row;
  }

  private getSession(playerId: string): SessionRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<SessionRow>(
        `SELECT session_epoch, authority_epoch, lease_id, last_client_seq,
                connection_id, disconnected_at, transfer_frozen, transfer_id
         FROM sessions WHERE player_id = ?`,
        playerId,
      ),
    );
  }

  private getTicket(ticketId: string): TicketRow | undefined {
    return firstRow(
      this.ctx.storage.sql.exec<TicketRow>(
        "SELECT status, connection_id, expires_at FROM route_tickets WHERE jti = ?",
        ticketId,
      ),
    );
  }

  private isPendingConnection(attachment: SocketAttachment): boolean {
    const ticket = this.getTicket(attachment.ticketId);
    return ticket?.status === "pending" && ticket.connection_id === attachment.connectionId;
  }

  private isRecoverableActiveConnection(attachment: SocketAttachment): boolean {
    const ticket = this.getTicket(attachment.ticketId);
    return (
      ticket?.status === "active" &&
      ticket.connection_id === attachment.connectionId &&
      this.isCurrentConnection(attachment)
    );
  }

  private isCurrentConnection(attachment: SocketAttachment): boolean {
    const session = this.getSession(attachment.playerId);
    return (
      session?.session_epoch === attachment.sessionEpoch &&
      session.authority_epoch === attachment.authorityEpoch &&
      session.lease_id === attachment.leaseId &&
      session.connection_id === attachment.connectionId
    );
  }

  private consumeMessageBudget(socket: WebSocket, attachment: SocketAttachment): boolean {
    const now = Date.now();
    const elapsed = Math.max(0, now - (attachment.messageRefilledAt ?? now));
    const refillPerMs = this.config.floorMessagesPerMinute / 60_000;
    const available = Math.min(
      this.config.floorMessageBurst,
      (attachment.messageTokens ?? this.config.floorMessageBurst) + elapsed * refillPerMs,
    );
    attachment.messageRefilledAt = now;
    attachment.messageTokens = available;
    // Retain the v2 fields for rolling compatibility with already-hibernating sockets.
    attachment.messageWindowStartedAt = now;
    attachment.messagesInWindow = Math.ceil(this.config.floorMessageBurst - available);
    if (available < 1) {
      socket.serializeAttachment(attachment);
      send(socket, { type: "error", code: "message_rate_exceeded", retryable: false });
      socket.close(RATE_LIMIT_CLOSE_CODE, "message_rate_exceeded");
      return false;
    }
    attachment.messageTokens = available - 1;
    attachment.messagesInWindow = Math.ceil(
      this.config.floorMessageBurst - attachment.messageTokens,
    );
    socket.serializeAttachment(attachment);
    if (this.consumeFloorEventBudget(now)) return true;
    send(socket, { type: "error", code: "floor_overloaded", retryable: true });
    socket.close(FLOOR_OVERLOAD_CLOSE_CODE, "floor_overloaded");
    return false;
  }

  private consumeFloorEventBudget(now: number): boolean {
    const elapsed = Math.max(0, now - this.floorEventRefilledAt);
    this.floorEventTokens = Math.min(
      this.config.floorEventBurst,
      this.floorEventTokens + (elapsed * this.config.floorEventsPerSecond) / 1_000,
    );
    this.floorEventRefilledAt = now;
    if (this.floorEventTokens < 1) return false;
    this.floorEventTokens -= 1;
    return true;
  }

  private async authorizeGlobalJoin(
    attachment: SocketAttachment,
  ): Promise<AuthorizeJoinResult | null> {
    try {
      const authority = this.bindings.PLAYER_SESSIONS.getByName(
        playerSessionObjectName(this.config.environment, attachment.playerId),
      );
      return await authority.authorizeJoin({
        environment: this.config.environment,
        playerId: attachment.playerId,
        sessionEpoch: attachment.sessionEpoch,
        authorityEpoch: attachment.authorityEpoch,
        leaseId: attachment.leaseId,
        resumeProofGrant: attachment.resumeProofGrant,
        keyId: attachment.keyId,
        expiresAt: attachment.expiresAt,
        floorObjectName: attachment.floorObjectName,
        locationHint: attachment.locationHint,
        operationId: attachment.ticketId,
        connectionId: attachment.connectionId,
      });
    } catch (error) {
      const failure =
        error && typeof error === "object"
          ? (error as { overloaded?: unknown; retryable?: unknown; remote?: unknown })
          : {};
      console.error(
        JSON.stringify({
          event: "player_session_authority_failed",
          floor: attachment.floorObjectName,
          overloaded: failure.overloaded === true,
          retryable: failure.retryable === true,
          remote: failure.remote === true,
        }),
      );
      return null;
    }
  }

  private async completeJoin(socket: WebSocket, attachment: SocketAttachment): Promise<void> {
    const authorization = await this.authorizeGlobalJoin(attachment);
    if (!authorization) {
      send(socket, { type: "error", code: "session_authority_unavailable", retryable: true });
      return;
    }
    if (!authorization.ok) {
      this.markTicketAbandoned(attachment);
      send(socket, { type: "error", code: authorization.code, retryable: false });
      socket.close(STALE_SESSION_CLOSE_CODE, authorization.code);
      return;
    }
    const transferAuthorization =
      authorization.decision === "transfer_target" ? authorization : undefined;
    const activation = this.activateConnection(
      attachment,
      transferAuthorization?.transferId,
      transferAuthorization?.handoff,
      transferAuthorization?.targetControlToken,
    );
    if (!activation.ok) {
      send(socket, { type: "error", code: activation.code, retryable: false });
      socket.close(STALE_SESSION_CLOSE_CODE, activation.code);
      return;
    }
    if (transferAuthorization) {
      const confirmation = await this.confirmGlobalTransfer(
        attachment,
        transferAuthorization.transferId,
        transferAuthorization.version,
      );
      if (!confirmation) {
        send(socket, { type: "error", code: "session_authority_unavailable", retryable: true });
        return;
      }
      if (!confirmation.ok) {
        send(socket, { type: "error", code: confirmation.code, retryable: false });
        socket.close(STALE_SESSION_CLOSE_CODE, confirmation.code);
        return;
      }
    }
    attachment.joined = true;
    socket.serializeAttachment(attachment);
    this.closeSupersededSockets(socket, attachment.playerId);
    send(socket, {
      type: "edge_joined",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      playerId: attachment.playerId,
      name: attachment.playerName,
      sessionEpoch: attachment.sessionEpoch,
      authorityEpoch: attachment.authorityEpoch,
      leaseId: attachment.leaseId,
      expectedClientSeq: activation.expectedClientSeq,
      ...(activation.position ? { position: activation.position } : {}),
      ...(activation.movementProfile
        ? { movementProfile: activation.movementProfile }
        : {}),
      ...(activation.availableMoves
        ? { availableMoves: activation.availableMoves }
        : {}),
    });
  }

  private async confirmGlobalTransfer(
    attachment: SocketAttachment,
    transferId: string,
    expectedVersion: number,
  ): Promise<TransferResult | null> {
    try {
      const authority = this.bindings.PLAYER_SESSIONS.getByName(
        playerSessionObjectName(this.config.environment, attachment.playerId),
      );
      return await authority.activateTransfer({
        environment: this.config.environment,
        playerId: attachment.playerId,
        sessionEpoch: attachment.sessionEpoch,
        authorityEpoch: attachment.authorityEpoch,
        leaseId: attachment.leaseId,
        floorObjectName: attachment.floorObjectName,
        transferId,
        operationId: `${attachment.ticketId}-activate`,
        connectionId: attachment.connectionId,
        expectedVersion,
        resumeProofGrant: attachment.resumeProofGrant,
        keyId: attachment.keyId,
        expiresAt: attachment.expiresAt,
      });
    } catch (error) {
      const failure =
        error && typeof error === "object"
          ? (error as { overloaded?: unknown; retryable?: unknown; remote?: unknown })
          : {};
      console.error(
        JSON.stringify({
          event: "player_session_activation_failed",
          floor: attachment.floorObjectName,
          overloaded: failure.overloaded === true,
          retryable: failure.retryable === true,
          remote: failure.remote === true,
        }),
      );
      return null;
    }
  }

  private activateConnection(
    attachment: SocketAttachment,
    transferId?: string,
    handoff?: TransferHandoff,
    targetControlToken?: string,
  ): ActivationResult {
    return this.ctx.storage.transactionSync(() => {
      const ticket = this.getTicket(attachment.ticketId);
      if (!ticket || ticket.connection_id !== attachment.connectionId) {
        return { ok: false, code: "invalid_connection_attempt" };
      }
      const session = this.getSession(attachment.playerId);
      if (ticket.status === "active") {
        if (
          session?.session_epoch === attachment.sessionEpoch &&
          session.authority_epoch === attachment.authorityEpoch &&
          session.lease_id === attachment.leaseId &&
          session.connection_id === attachment.connectionId
        ) {
          const readyPosition = this.claimReadyFloorPosition(attachment);
          if (readyPosition && !readyPosition.ok) return readyPosition;
          return {
            ok: true,
            expectedClientSeq: session.last_client_seq + 1,
            position: readyPosition?.position,
            movementProfile: readyPosition?.movementProfile,
            availableMoves: readyPosition?.availableMoves,
          };
        }
        return { ok: false, code: "stale_connection" };
      }
      if (ticket.status !== "pending") return { ok: false, code: "invalid_connection_attempt" };
      if (ticket.expires_at <= Math.floor(Date.now() / 1_000)) {
        return { ok: false, code: "join_deadline_expired" };
      }
      if (
        session &&
        (session.session_epoch > attachment.sessionEpoch ||
          (session.session_epoch === attachment.sessionEpoch &&
            session.authority_epoch > attachment.authorityEpoch))
      ) {
        return { ok: false, code: "stale_session_epoch" };
      }

      if (
        (transferId === undefined) !== (handoff === undefined) ||
        (transferId === undefined) !== (targetControlToken === undefined)
      ) {
        return { ok: false, code: "invalid_transfer_handoff" };
      }
      const provisionedWorlds = firstRow(
        this.ctx.storage.sql.exec<CountRow>(
          "SELECT COUNT(*) AS count FROM floor_world WHERE singleton = 1",
        ),
      )?.count;
      if (transferId && provisionedWorlds !== 0) {
        return { ok: false, code: "position_handoff_required" };
      }
      const readyPosition = transferId ? undefined : this.claimReadyFloorPosition(attachment);
      if (readyPosition && !readyPosition.ok) return readyPosition;
      if (transferId && handoff && targetControlToken) {
        const preparedInput: PrepareTransferImportRequest = {
          transferId,
          operationId: attachment.ticketId,
          playerId: attachment.playerId,
          sessionEpoch: attachment.sessionEpoch,
          authorityEpoch: attachment.authorityEpoch,
          leaseId: attachment.leaseId,
          floorObjectName: attachment.floorObjectName,
          controlToken: targetControlToken,
          handoff,
        };
        const transferIdentity = transferPreparationIdentity(preparedInput);
        const priorImport = firstRow(
          this.ctx.storage.sql.exec<TransferPreparationRow>(
            `SELECT request_identity, status, control_token, handoff_json
             FROM transfer_preparations WHERE transfer_id = ?`,
            transferId,
          ),
        );
        if (
          !priorImport ||
          priorImport.request_identity !== transferIdentity ||
          priorImport.control_token !== targetControlToken.toLowerCase() ||
          priorImport.status === "aborted"
        ) {
          return { ok: false, code: "idempotency_conflict" };
        }
        if (
          session &&
          session.session_epoch === attachment.sessionEpoch &&
          (session.authority_epoch === attachment.authorityEpoch
            ? session.lease_id !== attachment.leaseId
            : session.authority_epoch > attachment.authorityEpoch)
        ) {
          return { ok: false, code: "stale_session_epoch" };
        }
        if (
          handoff.lastClientSeq === 0
            ? handoff.receipts.length !== 0
            : handoff.receipts.at(-1)?.clientSeq !== handoff.lastClientSeq
        ) {
          return { ok: false, code: "invalid_transfer_handoff" };
        }
        for (let index = 1; index < handoff.receipts.length; index++) {
          if (handoff.receipts[index]!.clientSeq !== handoff.receipts[index - 1]!.clientSeq + 1) {
            return { ok: false, code: "invalid_transfer_handoff" };
          }
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO sessions
             (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
              connection_id, updated_at, disconnected_at, transfer_frozen, transfer_id)
           VALUES (?, ?, ?, ?, ?, ?, unixepoch(), NULL, 0, NULL)
           ON CONFLICT(player_id) DO UPDATE SET
             session_epoch = excluded.session_epoch,
             authority_epoch = excluded.authority_epoch,
             lease_id = excluded.lease_id,
             last_client_seq = excluded.last_client_seq,
             connection_id = excluded.connection_id,
             updated_at = excluded.updated_at,
             disconnected_at = NULL,
             transfer_frozen = 0,
             transfer_id = NULL`,
          attachment.playerId,
          attachment.sessionEpoch,
          attachment.authorityEpoch,
          attachment.leaseId,
          handoff.lastClientSeq,
          attachment.connectionId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM processed_commands WHERE player_id = ?",
          attachment.playerId,
        );
        let maximumImportedRevision = 0;
        for (const receipt of handoff.receipts) {
          maximumImportedRevision = Math.max(maximumImportedRevision, receipt.serverRevision);
          this.ctx.storage.sql.exec(
            `INSERT INTO processed_commands
               (player_id, session_epoch, client_seq, server_revision, request_hash,
                response_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
            attachment.playerId,
            attachment.sessionEpoch,
            receipt.clientSeq,
            receipt.serverRevision,
            receipt.requestHash,
            receipt.responseJson,
          );
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO player_gameplay
             (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(player_id) DO UPDATE SET
             turns = excluded.turns, hunger = excluded.hunger,
             max_hunger = excluded.max_hunger, hunger_state = excluded.hunger_state,
             hp = excluded.hp, alive = excluded.alive`,
          attachment.playerId,
          handoff.gameplay.turns,
          handoff.gameplay.hunger,
          handoff.gameplay.maxHunger,
          handoff.gameplay.hungerState,
          handoff.gameplay.hp,
          handoff.gameplay.alive ? 1 : 0,
        );
        this.ctx.storage.sql.exec(
          `UPDATE floor_meta SET revision = MAX(revision, ?) WHERE singleton = 1`,
          maximumImportedRevision,
        );
        this.ctx.storage.sql.exec(
          `UPDATE transfer_preparations SET status = 'activated', updated_at = unixepoch()
           WHERE transfer_id = ? AND control_token = ? AND status IN ('prepared', 'activated')`,
          transferId,
          targetControlToken.toLowerCase(),
        );
        this.pruneTerminalTransferArtifacts(transferId);
        this.ctx.storage.sql.exec(
          "UPDATE route_tickets SET status = 'active' WHERE jti = ? AND connection_id = ?",
          attachment.ticketId,
          attachment.connectionId,
        );
        return { ok: true, expectedClientSeq: handoff.lastClientSeq + 1 };
      }

      if (!session || attachment.sessionEpoch > session.session_epoch) {
        this.ctx.storage.sql.exec(
          `INSERT INTO sessions
             (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
              connection_id, updated_at, disconnected_at)
           VALUES (?, ?, ?, ?, 0, ?, unixepoch(), NULL)
           ON CONFLICT(player_id) DO UPDATE SET
             session_epoch = excluded.session_epoch,
             authority_epoch = excluded.authority_epoch,
             lease_id = excluded.lease_id,
             last_client_seq = 0,
             connection_id = excluded.connection_id,
             updated_at = excluded.updated_at,
             disconnected_at = NULL`,
          attachment.playerId,
          attachment.sessionEpoch,
          attachment.authorityEpoch,
          attachment.leaseId,
          attachment.connectionId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM processed_commands WHERE player_id = ? AND session_epoch < ?",
          attachment.playerId,
          attachment.sessionEpoch,
        );
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE sessions
           SET authority_epoch = ?, lease_id = ?, connection_id = ?,
               updated_at = unixepoch(), disconnected_at = NULL
           WHERE player_id = ? AND session_epoch = ?`,
          attachment.authorityEpoch,
          attachment.leaseId,
          attachment.connectionId,
          attachment.playerId,
          attachment.sessionEpoch,
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE route_tickets SET status = 'active' WHERE jti = ? AND connection_id = ?",
        attachment.ticketId,
        attachment.connectionId,
      );
      const updated = this.getSession(attachment.playerId);
      if (!updated) throw new Error("session activation invariant violated");
      return {
        ok: true,
        expectedClientSeq: updated.last_client_seq + 1,
        position: readyPosition?.position,
        movementProfile: readyPosition?.movementProfile,
        availableMoves: readyPosition?.availableMoves,
      };
    });
  }

  private closeSupersededSockets(currentSocket: WebSocket, playerId: string): void {
    for (const socket of this.ctx.getWebSockets(`player:${playerId}`)) {
      if (socket === currentSocket) continue;
      try {
        socket.close(SUPERSEDED_CLOSE_CODE, "superseded");
      } catch {
        // The durable SQLite connection fence remains authoritative.
      }
    }
  }

  private joinedPlayerCount(): number {
    return new Set(
      this.ctx
        .getWebSockets()
        .map((socket) => attachmentFor(socket))
        .filter((attachment): attachment is SocketAttachment => attachment?.joined === true)
        .map((attachment) => attachment.playerId),
    ).size;
  }

  private markTicketAbandoned(attachment: SocketAttachment): void {
    this.ctx.storage.sql.exec(
      `UPDATE route_tickets SET status = 'abandoned'
       WHERE jti = ? AND connection_id = ? AND status = 'pending'`,
      attachment.ticketId,
      attachment.connectionId,
    );
  }

  private markSocketClosed(socket: WebSocket): void {
    const attachment = attachmentFor(socket);
    if (!attachment) return;
    if (!attachment.joined) {
      if (this.isRecoverableActiveConnection(attachment)) {
        this.markSessionDisconnected(attachment);
      } else {
        this.markTicketAbandoned(attachment);
      }
    } else {
      this.markSessionDisconnected(attachment);
    }
    this.ctx.waitUntil(this.scheduleMaintenance());
  }

  private markSessionDisconnected(attachment: SocketAttachment): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET disconnected_at = unixepoch(), updated_at = unixepoch()
         WHERE player_id = ? AND session_epoch = ? AND authority_epoch = ?
           AND lease_id = ? AND connection_id = ?`,
        attachment.playerId,
        attachment.sessionEpoch,
        attachment.authorityEpoch,
        attachment.leaseId,
        attachment.connectionId,
      );
      const sessionChanges = firstRow(
        this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count"),
      )?.count;
      if (sessionChanges === 1) {
        this.ctx.storage.sql.exec(
          "UPDATE player_positions SET present = 0 WHERE player_id = ? AND present = 1",
          attachment.playerId,
        );
      }
    });
  }

  private expirePendingSockets(nowSeconds: number): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (!attachment || attachment.joined) continue;
      const recoverableActive = this.isRecoverableActiveConnection(attachment);
      const deadline = recoverableActive
        ? attachment.expiresAt + this.config.floorReplayGraceSeconds
        : attachment.expiresAt;
      if (deadline <= nowSeconds) {
        if (recoverableActive) this.markSessionDisconnected(attachment);
        else this.markTicketAbandoned(attachment);
        try {
          socket.close(JOIN_EXPIRED_CLOSE_CODE, "join_deadline_expired");
        } catch {
          // The peer may already be closed.
        }
      }
    }
  }

  private purgeExpiredTicketRows(nowSeconds: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM route_tickets
       WHERE (status <> 'active' AND expires_at <= ?)
          OR (status = 'active' AND expires_at + ? <= ?)`,
      nowSeconds,
      this.config.floorReplayGraceSeconds,
      nowSeconds,
    );
  }

  private async scheduleMaintenance(): Promise<void> {
    const ticketDeadline = firstRow(
      this.ctx.storage.sql.exec<MinimumRow>(
        `SELECT MIN(
           CASE WHEN status = 'active' THEN expires_at + ? ELSE expires_at END
         ) AS deadline FROM route_tickets`,
        this.config.floorReplayGraceSeconds,
      ),
    )?.deadline;
    const replayDeadline = firstRow(
      this.ctx.storage.sql.exec<MinimumRow>(
        `SELECT MIN(disconnected_at + ?) AS deadline
         FROM sessions WHERE disconnected_at IS NOT NULL`,
        this.config.floorReplayGraceSeconds,
      ),
    )?.deadline;
    const deadlines = [ticketDeadline, replayDeadline].filter(
      (deadline): deadline is number => typeof deadline === "number",
    );
    if (!deadlines.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextDeadlineMs = Math.max(Date.now() + 1_000, Math.min(...deadlines) * 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || nextDeadlineMs < current) {
      await this.ctx.storage.setAlarm(nextDeadlineMs);
    }
  }

  private floorFenceMatches(input: FloorTransferRequest, session: SessionRow | undefined): session is SessionRow {
    return Boolean(
      session &&
        session.session_epoch === input.sessionEpoch &&
        session.authority_epoch === input.authorityEpoch &&
        session.lease_id === input.leaseId.toLowerCase() &&
        session.connection_id === input.connectionId.toLowerCase(),
    );
  }

  private replayFloorTransferOperation(
    operationId: string,
    requestIdentity: string,
  ): FloorTransferResult | undefined {
    const prior = firstRow(
      this.ctx.storage.sql.exec<FloorTransferOperationRow>(
        `SELECT request_identity, response_json FROM floor_transfer_operations
         WHERE operation_id = ?`,
        operationId,
      ),
    );
    if (!prior) return undefined;
    return prior.request_identity === requestIdentity
      ? (JSON.parse(prior.response_json) as FloorTransferResult)
      : { ok: false, code: "idempotency_conflict" };
  }

  private pruneTerminalTransferArtifacts(protectedTransferId: string): void {
    const retainedOtherTransfers = Math.max(0, this.config.floorSessionTombstoneCap - 1);
    this.ctx.storage.sql.exec(
      `DELETE FROM floor_transfer_operations
       WHERE transfer_id IN (
         SELECT transfer_id FROM transfer_exports
         WHERE status IN ('aborted', 'finalized') AND transfer_id <> ?
         ORDER BY updated_at DESC, transfer_id DESC LIMIT -1 OFFSET ?
       )`,
      protectedTransferId,
      retainedOtherTransfers,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM transfer_exports
       WHERE transfer_id IN (
         SELECT transfer_id FROM transfer_exports
         WHERE status IN ('aborted', 'finalized') AND transfer_id <> ?
         ORDER BY updated_at DESC, transfer_id DESC LIMIT -1 OFFSET ?
       )`,
      protectedTransferId,
      retainedOtherTransfers,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM transfer_preparations
       WHERE transfer_id IN (
         SELECT transfer_id FROM transfer_preparations
         WHERE status IN ('activated', 'aborted') AND transfer_id <> ?
         ORDER BY updated_at DESC, transfer_id DESC LIMIT -1 OFFSET ?
       )`,
      protectedTransferId,
      retainedOtherTransfers,
    );
  }

  private recordFloorTransferOperation(
    input: FloorTransferRequest,
    kind: string,
    requestIdentity: string,
    result: FloorTransferResult,
  ): FloorTransferResult {
    this.ctx.storage.sql.exec(
      `INSERT INTO floor_transfer_operations
         (operation_id, transfer_id, operation_kind, request_identity, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`,
      input.operationId,
      input.transferId.toLowerCase(),
      kind,
      requestIdentity,
      JSON.stringify(result),
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM floor_transfer_operations
       WHERE transfer_id = ? AND operation_id NOT IN (
         SELECT operation_id FROM floor_transfer_operations
         WHERE transfer_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT 64
       )`,
      input.transferId.toLowerCase(),
      input.transferId.toLowerCase(),
    );
    const terminalOperationCap = Math.min(
      100_000,
      Math.max(1, this.config.floorSessionTombstoneCap * 4),
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM floor_transfer_operations
       WHERE operation_id IN (
         SELECT operation_id FROM floor_transfer_operations
         WHERE operation_id <> ? AND transfer_id NOT IN (
           SELECT transfer_id FROM transfer_exports WHERE status = 'frozen'
         )
         ORDER BY created_at DESC, operation_id DESC LIMIT -1 OFFSET ?
       )`,
      input.operationId,
      terminalOperationCap - 1,
    );
    return result;
  }

  private commitProbe(attachment: SocketAttachment, clientSeq: number): ProbeResult {
    return this.ctx.storage.transactionSync(() => {
      const session = this.getSession(attachment.playerId);
      if (
        !session ||
        session.session_epoch !== attachment.sessionEpoch ||
        session.authority_epoch !== attachment.authorityEpoch ||
        session.lease_id !== attachment.leaseId ||
        session.connection_id !== attachment.connectionId
      ) {
        return { ok: false, code: "stale_connection" };
      }

      const cached = firstRow(
        this.ctx.storage.sql.exec<CachedCommandRow>(
          `SELECT request_hash, response_json FROM processed_commands
           WHERE player_id = ? AND session_epoch = ? AND client_seq = ?`,
          attachment.playerId,
          attachment.sessionEpoch,
          clientSeq,
        ),
      );
      if (cached) {
        return cached.request_hash === PROBE_REQUEST_HASH
          ? { ok: true, response: cached.response_json }
          : { ok: false, code: "idempotency_conflict" };
      }
      if (session.transfer_frozen === 1) {
        return { ok: false, code: "transfer_frozen" };
      }

      const expectedClientSeq = session.last_client_seq + 1;
      if (clientSeq !== expectedClientSeq) {
        return {
          ok: false,
          code: clientSeq < expectedClientSeq ? "stale_client_sequence" : "client_sequence_gap",
          expectedClientSeq,
        };
      }

      const meta = firstRow(
        this.ctx.storage.sql.exec<RevisionRow>(
          "SELECT revision FROM floor_meta WHERE singleton = 1",
        ),
      );
      if (!meta) throw new Error("floor_meta invariant violated");
      const serverRevision = meta.revision + 1;
      const response = JSON.stringify({
        type: "ack",
        command: "slo_probe",
        clientSeq,
        serverSeq: serverRevision,
        serverRevision,
      });

      this.ctx.storage.sql.exec(
        "UPDATE floor_meta SET revision = ? WHERE singleton = 1",
        serverRevision,
      );
      this.ctx.storage.sql.exec(
        `UPDATE sessions
         SET last_client_seq = ?, updated_at = unixepoch(), disconnected_at = NULL
         WHERE player_id = ? AND session_epoch = ? AND authority_epoch = ?
           AND lease_id = ? AND connection_id = ?`,
        clientSeq,
        attachment.playerId,
        attachment.sessionEpoch,
        attachment.authorityEpoch,
        attachment.leaseId,
        attachment.connectionId,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO processed_commands
           (player_id, session_epoch, client_seq, server_revision, request_hash, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
        attachment.playerId,
        attachment.sessionEpoch,
        clientSeq,
        serverRevision,
        PROBE_REQUEST_HASH,
        response,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_commands
         WHERE player_id = ? AND session_epoch = ? AND client_seq <= ?`,
        attachment.playerId,
        attachment.sessionEpoch,
        clientSeq - DEDUPE_WINDOW_PER_SESSION,
      );
      return { ok: true, response };
    });
  }

  private commitMove(
    attachment: SocketAttachment,
    clientSeq: number,
    dx: number,
    dy: number,
  ): ProbeResult {
    const requestHash = moveRequestHash(dx, dy);
    return this.ctx.storage.transactionSync(() => {
      const session = this.getSession(attachment.playerId);
      if (
        !session ||
        session.session_epoch !== attachment.sessionEpoch ||
        session.authority_epoch !== attachment.authorityEpoch ||
        session.lease_id !== attachment.leaseId ||
        session.connection_id !== attachment.connectionId
      ) {
        return { ok: false, code: "stale_connection" };
      }

      const cached = firstRow(
        this.ctx.storage.sql.exec<CachedCommandRow>(
          `SELECT request_hash, response_json FROM processed_commands
           WHERE player_id = ? AND session_epoch = ? AND client_seq = ?`,
          attachment.playerId,
          attachment.sessionEpoch,
          clientSeq,
        ),
      );
      if (cached) {
        return cached.request_hash === requestHash
          ? { ok: true, response: cached.response_json }
          : { ok: false, code: "idempotency_conflict" };
      }
      if (session.transfer_frozen === 1) return { ok: false, code: "transfer_frozen" };

      const expectedClientSeq = session.last_client_seq + 1;
      if (clientSeq !== expectedClientSeq) {
        return {
          ok: false,
          code: clientSeq < expectedClientSeq ? "stale_client_sequence" : "client_sequence_gap",
          expectedClientSeq,
        };
      }

      const authority = movementAuthorityFor(attachment);
      if (!authority) return { ok: false, code: "movement_state_corrupt" };
      const movementState = this.ensureMovementPosition(attachment);
      if (!movementState.ok) return movementState;
      const gameplay = firstRow(
        this.ctx.storage.sql.exec<GameplayRow>(
          `SELECT turns, hunger, max_hunger, hunger_state, hp, alive
           FROM player_gameplay WHERE player_id = ?`,
          attachment.playerId,
        ),
      );
      const position = firstRow(
        this.ctx.storage.sql.exec<PlayerPositionRow>(
          `SELECT x, y, phase, immobilized_turns, present
           FROM player_positions WHERE player_id = ?`,
          attachment.playerId,
        ),
      );
      if (!position) return { ok: false, code: "movement_state_unavailable" };
      if (
        !Number.isSafeInteger(position.x) ||
        position.x < 0 ||
        !Number.isSafeInteger(position.y) ||
        position.y < 0 ||
        !Number.isSafeInteger(position.immobilized_turns) ||
        position.immobilized_turns < 0 ||
        position.present !== 1
      ) {
        return { ok: false, code: "movement_state_corrupt" };
      }
      if (gameplay && !validGameplayRow(gameplay)) {
        return { ok: false, code: "movement_state_corrupt" };
      }
      if (gameplay?.alive === 0 || position.phase === "dead" || position.phase === "won") {
        return { ok: false, code: "terminal_state" };
      }
      if (position.phase !== "playing") {
        return { ok: false, code: "movement_state_unavailable" };
      }

      const source = firstRow(
        this.ctx.storage.sql.exec<MovementCellRow>(
          `SELECT tile, trap, stairs_down, item_present, room_effect
           FROM floor_cells WHERE x = ? AND y = ?`,
          position.x,
          position.y,
        ),
      );
      if (!source) return { ok: false, code: "movement_state_unavailable" };
      if (!validMovementCell(source)) return { ok: false, code: "movement_state_corrupt" };
      if (
        source.tile !== "." ||
        source.trap === 1 ||
        source.stairs_down === 1 ||
        source.item_present === 1 ||
        source.room_effect === 1
      ) {
        return { ok: false, code: "edge_movement_effect_not_migrated" };
      }
      const sourceMonsters =
        firstRow(
          this.ctx.storage.sql.exec<CountRow>(
            "SELECT COUNT(*) AS count FROM monster_positions WHERE x = ? AND y = ? AND active = 1",
            position.x,
            position.y,
          ),
        )?.count ?? 0;
      if (sourceMonsters !== 0) return { ok: false, code: "movement_state_corrupt" };
      const activeMonsters =
        firstRow(
          this.ctx.storage.sql.exec<CountRow>(
            "SELECT COUNT(*) AS count FROM monster_positions WHERE active = 1",
          ),
        )?.count ?? 0;
      if (activeMonsters > 0) {
        return { ok: false, code: "edge_movement_effect_not_migrated" };
      }

      const destinationX = position.x + dx;
      const destinationY = position.y + dy;
      if (!Number.isSafeInteger(destinationX) || !Number.isSafeInteger(destinationY)) {
        return { ok: false, code: "movement_state_corrupt" };
      }
      const inBounds = destinationX >= 0 && destinationY >= 0;
      const destination = inBounds
        ? firstRow(
            this.ctx.storage.sql.exec<MovementCellRow>(
              `SELECT tile, trap, stairs_down, item_present, room_effect
               FROM floor_cells WHERE x = ? AND y = ?`,
              destinationX,
              destinationY,
            ),
          )
        : undefined;
      if (destination && !validMovementCell(destination)) {
        return { ok: false, code: "movement_state_corrupt" };
      }
      const playerOccupants = inBounds
        ? (firstRow(
            this.ctx.storage.sql.exec<CountRow>(
              `SELECT COUNT(*) AS count FROM player_positions
               WHERE x = ? AND y = ? AND present = 1 AND player_id <> ?`,
              destinationX,
              destinationY,
              attachment.playerId,
            ),
          )?.count ?? 0)
        : 0;
      const monsterOccupants = inBounds
        ? (firstRow(
            this.ctx.storage.sql.exec<CountRow>(
              `SELECT COUNT(*) AS count FROM monster_positions
               WHERE x = ? AND y = ? AND active = 1`,
              destinationX,
              destinationY,
            ),
          )?.count ?? 0)
        : 0;
      if (
        playerOccupants > 1 ||
        monsterOccupants > 1 ||
        (playerOccupants > 0 && monsterOccupants > 0) ||
        (!destination && (playerOccupants > 0 || monsterOccupants > 0)) ||
        (destination?.tile === "#" && (playerOccupants > 0 || monsterOccupants > 0))
      ) {
        return { ok: false, code: "movement_state_corrupt" };
      }

      const movement = reduceMovement(
        {
          authority,
          x: position.x,
          y: position.y,
          phase: position.phase,
          alive: gameplay ? gameplay.alive === 1 : true,
          immobilizedTurns: position.immobilized_turns,
          destination: {
            tile: destination?.tile ?? null,
            occupant:
              playerOccupants === 1
                ? "player"
                : monsterOccupants === 1
                  ? "monster"
                  : "none",
            trap: destination?.trap === 1,
            stairsDown: destination?.stairs_down === 1,
          },
        },
        { type: "move", dx, dy },
      );
      if (
        position.immobilized_turns > 0 ||
        monsterOccupants > 0 ||
        destination?.tile === "+" ||
        destination?.tile === ">" ||
        destination?.tile === "<" ||
        destination?.trap === 1 ||
        destination?.stairs_down === 1 ||
        destination?.item_present === 1 ||
        destination?.room_effect === 1 ||
        movement.outcome === "combat_intent"
      ) {
        return { ok: false, code: "edge_movement_effect_not_migrated" };
      }

      const priorGameplay = {
        turns: gameplay?.turns ?? 0,
        depth: attachment.depth,
        hunger: gameplay?.hunger ?? 1000,
        maxHunger: gameplay?.max_hunger ?? 1000,
        hungerState:
          (gameplay?.hunger_state as
            | "satiated"
            | "normal"
            | "hungry"
            | "weak"
            | "fainting"
            | "starving"
            | undefined) ?? "satiated",
        hp: gameplay?.hp ?? 20,
        alive: gameplay ? gameplay.alive === 1 : true,
      };
      const turn =
        movement.turnCost === "none"
          ? { state: priorGameplay, events: [] as const }
          : reduceGameplay(priorGameplay, { type: "advance_turn", action: "other" });
      const meta = firstRow(
        this.ctx.storage.sql.exec<RevisionRow>(
          "SELECT revision FROM floor_meta WHERE singleton = 1",
        ),
      );
      if (!meta || !Number.isSafeInteger(meta.revision) || meta.revision < 0 ||
          meta.revision === Number.MAX_SAFE_INTEGER) {
        return { ok: false, code: "movement_state_corrupt" };
      }
      const serverRevision = meta.revision + 1;
      const response = JSON.stringify({
        type: "ack",
        command: "move",
        dx,
        dy,
        clientSeq,
        serverSeq: serverRevision,
        serverRevision,
        outcome: movement.outcome,
        position: { x: movement.state.x, y: movement.state.y },
        movement: {
          turnCost: movement.turnCost,
          stateHash: movementStateHash(movement.state),
          events: movement.events,
        },
        state: turn.state,
        stateHash: gameplayStateHash(turn.state),
        events: turn.events,
      });

      this.ctx.storage.sql.exec(
        `UPDATE player_positions
         SET x = ?, y = ?, updated_revision = ?,
             phase = CASE WHEN ? = 1 THEN phase ELSE 'dead' END,
             present = CASE WHEN ? = 1 THEN 1 ELSE 0 END
         WHERE player_id = ? AND x = ? AND y = ? AND present = 1`,
        movement.state.x,
        movement.state.y,
        serverRevision,
        turn.state.alive ? 1 : 0,
        turn.state.alive ? 1 : 0,
        attachment.playerId,
        position.x,
        position.y,
      );
      const positionChanges = firstRow(
        this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count"),
      )?.count;
      if (positionChanges !== 1) throw new Error("player position fence lost");
      this.ctx.storage.sql.exec(
        `INSERT INTO player_gameplay
           (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           turns = excluded.turns, hunger = excluded.hunger,
           max_hunger = excluded.max_hunger, hunger_state = excluded.hunger_state,
           hp = excluded.hp, alive = excluded.alive`,
        attachment.playerId,
        turn.state.turns,
        turn.state.hunger,
        turn.state.maxHunger,
        turn.state.hungerState,
        turn.state.hp,
        turn.state.alive ? 1 : 0,
      );
      this.ctx.storage.sql.exec(
        "UPDATE floor_meta SET revision = ? WHERE singleton = 1",
        serverRevision,
      );
      this.ctx.storage.sql.exec(
        `UPDATE sessions
         SET last_client_seq = ?, updated_at = unixepoch(), disconnected_at = NULL
         WHERE player_id = ? AND session_epoch = ? AND authority_epoch = ?
           AND lease_id = ? AND connection_id = ?`,
        clientSeq,
        attachment.playerId,
        attachment.sessionEpoch,
        attachment.authorityEpoch,
        attachment.leaseId,
        attachment.connectionId,
      );
      const sessionChanges = firstRow(
        this.ctx.storage.sql.exec<CountRow>("SELECT changes() AS count"),
      )?.count;
      if (sessionChanges !== 1) throw new Error("session authority fence lost");
      this.ctx.storage.sql.exec(
        `INSERT INTO processed_commands
           (player_id, session_epoch, client_seq, server_revision, request_hash,
            response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
        attachment.playerId,
        attachment.sessionEpoch,
        clientSeq,
        serverRevision,
        requestHash,
        response,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_commands
         WHERE player_id = ? AND session_epoch = ? AND client_seq <= ?`,
        attachment.playerId,
        attachment.sessionEpoch,
        clientSeq - DEDUPE_WINDOW_PER_SESSION,
      );
      return { ok: true, response };
    });
  }

  private commitWait(attachment: SocketAttachment, clientSeq: number): ProbeResult {
    return this.ctx.storage.transactionSync(() => {
      const session = this.getSession(attachment.playerId);
      if (!session || session.session_epoch !== attachment.sessionEpoch ||
          session.authority_epoch !== attachment.authorityEpoch || session.lease_id !== attachment.leaseId ||
          session.connection_id !== attachment.connectionId) return { ok: false, code: "stale_connection" };
      const cached = firstRow(this.ctx.storage.sql.exec<CachedCommandRow>(
        "SELECT request_hash, response_json FROM processed_commands WHERE player_id = ? AND session_epoch = ? AND client_seq = ?",
        attachment.playerId, attachment.sessionEpoch, clientSeq,
      ));
      if (cached) return cached.request_hash === WAIT_REQUEST_HASH
        ? { ok: true, response: cached.response_json }
        : { ok: false, code: "idempotency_conflict" };
      if (session.transfer_frozen === 1) return { ok: false, code: "transfer_frozen" };
      const expectedClientSeq = session.last_client_seq + 1;
      if (clientSeq !== expectedClientSeq) return { ok: false, code: clientSeq < expectedClientSeq ? "stale_client_sequence" : "client_sequence_gap", expectedClientSeq };
      const row = firstRow(this.ctx.storage.sql.exec<{
        turns: number; hunger: number; max_hunger: number; hunger_state: string; hp: number; alive: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT turns, hunger, max_hunger, hunger_state, hp, alive FROM player_gameplay WHERE player_id = ?", attachment.playerId,
      ));
      const transition = reduceGameplay({
        turns: row?.turns ?? 0,
        depth: attachment.depth,
        hunger: row?.hunger ?? 1000,
        maxHunger: row?.max_hunger ?? 1000,
        hungerState: (row?.hunger_state as "satiated" | "normal" | "hungry" | "weak" | "fainting" | "starving" | undefined) ?? "satiated",
        hp: row?.hp ?? 20,
        alive: row ? row.alive === 1 : true,
      }, { type: "advance_turn", action: "wait" });
      if (row && row.alive !== 1) return { ok: false, code: "terminal_state" };
      const meta = firstRow(this.ctx.storage.sql.exec<RevisionRow>("SELECT revision FROM floor_meta WHERE singleton = 1"));
      if (!meta) throw new Error("floor_meta invariant violated");
      const serverRevision = meta.revision + 1;
      const response = JSON.stringify({ type: "ack", command: "wait", clientSeq, serverSeq: serverRevision, serverRevision, state: transition.state, stateHash: gameplayStateHash(transition.state), events: transition.events });
      this.ctx.storage.sql.exec(`INSERT INTO player_gameplay
        (player_id, turns, hunger, max_hunger, hunger_state, hp, alive) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET turns = excluded.turns, hunger = excluded.hunger,
          max_hunger = excluded.max_hunger, hunger_state = excluded.hunger_state, hp = excluded.hp, alive = excluded.alive`,
        attachment.playerId, transition.state.turns, transition.state.hunger, transition.state.maxHunger,
        transition.state.hungerState, transition.state.hp, transition.state.alive ? 1 : 0);
      if (!transition.state.alive) {
        this.ctx.storage.sql.exec(
          "UPDATE player_positions SET phase = 'dead', present = 0 WHERE player_id = ?",
          attachment.playerId,
        );
      }
      this.ctx.storage.sql.exec("UPDATE floor_meta SET revision = ? WHERE singleton = 1", serverRevision);
      this.ctx.storage.sql.exec(
        `UPDATE sessions SET last_client_seq = ?, updated_at = unixepoch(), disconnected_at = NULL
         WHERE player_id = ? AND session_epoch = ? AND authority_epoch = ?
           AND lease_id = ? AND connection_id = ?`,
        clientSeq,
        attachment.playerId,
        attachment.sessionEpoch,
        attachment.authorityEpoch,
        attachment.leaseId,
        attachment.connectionId,
      );
      this.ctx.storage.sql.exec("INSERT INTO processed_commands (player_id, session_epoch, client_seq, server_revision, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())", attachment.playerId, attachment.sessionEpoch, clientSeq, serverRevision, WAIT_REQUEST_HASH, response);
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_commands
         WHERE player_id = ? AND session_epoch = ? AND client_seq <= ?`,
        attachment.playerId,
        attachment.sessionEpoch,
        clientSeq - DEDUPE_WINDOW_PER_SESSION,
      );
      return { ok: true, response };
    });
  }
}
