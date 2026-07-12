import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  directoryBucketFor,
  floorInstanceIdForSlot,
  realmDirectoryObjectName,
  type AllocationRequest,
  type AllocationSuccess,
  type RetirementRequest,
  type RetirementResult,
} from "../src/allocation-protocol";
import type { Env } from "../src/env";
import { floorObjectName } from "../src/protocol";
import {
  TEST_PREVIOUS_ROUTE_TICKET_SECRET,
  TEST_ROUTE_TICKET_SECRET,
  connect,
  join,
  nextJson,
  ticketInput,
} from "./helpers";

const encoder = new TextEncoder();
const TEST_BUCKET_COUNT = 8;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ControlOptions {
  rawBody?: string;
  signedBody?: string;
  timestamp?: string;
  keyId?: string;
  secret?: string;
  omitSignature?: boolean;
  contentType?: string;
  urlSuffix?: string;
  method?: string;
}

async function controlSignature(
  path: string,
  rawBody: string,
  timestamp: string,
  keyId: string,
  secret: string,
): Promise<string> {
  return controlSignatureBytes(path, encoder.encode(rawBody), timestamp, keyId, secret);
}

async function controlSignatureBytes(
  path: string,
  rawBody: Uint8Array,
  timestamp: string,
  keyId: string,
  secret: string,
): Promise<string> {
  const prefix = encoder.encode(
    `test\ngrokhack-control:v1\nPOST\n${path}\n${timestamp}\n${keyId}\n`,
  );
  const signingInput = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signingInput.set(prefix);
  signingInput.set(rawBody, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput)));
}

async function signedControlRequest(
  path: "/internal/allocation/assign" | "/internal/allocation/retire",
  body: unknown,
  options: ControlOptions = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const keyId = options.keyId ?? "test-v1";
  const secret = options.secret ?? TEST_ROUTE_TICKET_SECRET;
  const signature = await controlSignature(
    path,
    options.signedBody ?? rawBody,
    timestamp,
    keyId,
    secret,
  );
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json",
    "X-GrokHack-Control-Key-Id": keyId,
    "X-GrokHack-Control-Timestamp": timestamp,
    "X-GrokHack-Control-Signature": signature,
  });
  if (options.omitSignature) headers.delete("X-GrokHack-Control-Signature");
  const method = options.method ?? "POST";
  return SELF.fetch(`https://edge.test${path}${options.urlSuffix ?? ""}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: rawBody }),
  });
}

function allocationRequest(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    v: 1,
    operationId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    realmId: `alloc-${crypto.randomUUID().slice(0, 8)}`,
    depth: 1,
    locationHint: "wnam",
    capacityUnits: 1,
    ...overrides,
  };
}

function directoryStub(request: AllocationRequest) {
  const bucket = directoryBucketFor(request, TEST_BUCKET_COUNT);
  const runtimeEnv = env as Env;
  return runtimeEnv.REALM_DIRECTORIES.getByName(
    realmDirectoryObjectName("test", request, TEST_BUCKET_COUNT, bucket),
  );
}

function collidingPlayers(count: number): string[] {
  const players: string[] = [];
  let target: number | undefined;
  while (players.length < count) {
    const playerId = crypto.randomUUID();
    const bucket = directoryBucketFor({ playerId }, TEST_BUCKET_COUNT);
    if (target === undefined) target = bucket;
    if (bucket === target) players.push(playerId);
  }
  return players;
}

function playerForBucket(target: number): string {
  while (true) {
    const playerId = crypto.randomUUID();
    if (directoryBucketFor({ playerId }, TEST_BUCKET_COUNT) === target) return playerId;
  }
}

function retirementRequest(
  assignment: AllocationSuccess["assignment"],
  overrides: Partial<RetirementRequest> = {},
): RetirementRequest {
  return {
    v: 1,
    operationId: crypto.randomUUID(),
    realmId: assignment.realmId,
    depth: assignment.depth,
    locationHint: assignment.locationHint,
    bucketCount: assignment.bucketCount,
    bucket: assignment.bucket,
    floorSlot: assignment.floorSlot,
    floorInstanceId: assignment.floorInstanceId,
    floorEpoch: assignment.floorEpoch,
    reason: "tombstone_limit",
    ...overrides,
  };
}

describe("sharded RealmDirectory allocation", () => {
  it("assigns a deterministic floor and leaves the gameplay WebSocket on the direct Floor path", async () => {
    const request = allocationRequest({ realmId: "council-red-path" });
    const response = await signedControlRequest("/internal/allocation/assign", request);

    expect(response.status).toBe(200);
    const result = (await response.json()) as AllocationSuccess;
    expect(result).toMatchObject({
      ok: true,
      decision: "new_floor",
      assignment: {
        realmId: "council-red-path",
        depth: 1,
        locationHint: "wnam",
        allocatorLayoutVersion: 1,
        bucketCount: TEST_BUCKET_COUNT,
        floorEpoch: 1,
      },
    });
    expect(result.assignment.floorInstanceId).toContain("a1-wnam-n8-");

    const stub = directoryStub(request);
    const beforeRevision = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM directory_meta WHERE singleton = 1")
        .toArray()[0]!.revision,
    );
    const route = ticketInput({
      playerId: request.playerId,
      realmId: result.assignment.realmId,
      floorInstanceId: result.assignment.floorInstanceId,
      allocationReservationId: result.assignment.reservationId,
      locationHint: result.assignment.locationHint,
      depth: result.assignment.depth,
      floorEpoch: result.assignment.floorEpoch,
    });
    const connected = await connect(route);
    expect(connected.response.status).toBe(101);
    await expect(nextJson(connected.socket!)).resolves.toMatchObject({ type: "welcome" });
    await expect(join(connected.socket!, route.playerName)).resolves.toMatchObject({
      type: "edge_joined",
    });
    const afterRevision = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM directory_meta WHERE singleton = 1")
        .toArray()[0]!.revision,
    );
    expect(afterRevision).toBe(beforeRevision);
    connected.socket!.close(1000, "test_complete");
  });

  it("authenticates exact raw control requests with either configured key and fails closed", async () => {
    const active = allocationRequest();
    await expect(signedControlRequest("/internal/allocation/assign", active)).resolves.toMatchObject({
      status: 200,
    });
    const previous = allocationRequest();
    await expect(
      signedControlRequest("/internal/allocation/assign", previous, {
        keyId: "test-v0",
        secret: TEST_PREVIOUS_ROUTE_TICKET_SECRET,
      }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        omitSignature: true,
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        keyId: "unknown-v1",
      }),
    ).resolves.toMatchObject({ status: 401 });
    const tampered = allocationRequest();
    const signedBody = JSON.stringify(tampered);
    await expect(
      signedControlRequest(
        "/internal/allocation/assign",
        { ...tampered, capacityUnits: 2 },
        { signedBody },
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        timestamp: String(Math.floor(Date.now() / 1_000) - 31),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        timestamp: String(Math.floor(Date.now() / 1_000) + 31),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        urlSuffix: "?bypass=1",
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        contentType: "text/plain",
      }),
    ).resolves.toMatchObject({ status: 415 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), {
        rawBody: "{",
      }),
    ).resolves.toMatchObject({ status: 400 });
    const extra = { ...allocationRequest(), unexpected: true };
    await expect(signedControlRequest("/internal/allocation/assign", extra)).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      signedControlRequest("/internal/allocation/assign", {
        ...allocationRequest(),
        realmId: "café",
      }),
    ).resolves.toMatchObject({ status: 400 });
    const uppercase = allocationRequest();
    uppercase.playerId = uppercase.playerId.toUpperCase();
    await expect(
      signedControlRequest("/internal/allocation/assign", uppercase),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      signedControlRequest("/internal/allocation/assign", {}, { rawBody: "x".repeat(2_049) }),
    ).resolves.toMatchObject({ status: 413 });
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const invalidTimestamp = String(Math.floor(Date.now() / 1_000));
    const invalidSignature = await controlSignatureBytes(
      "/internal/allocation/assign",
      invalidUtf8,
      invalidTimestamp,
      "test-v1",
      TEST_ROUTE_TICKET_SECRET,
    );
    await expect(
      SELF.fetch("https://edge.test/internal/allocation/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GrokHack-Control-Key-Id": "test-v1",
          "X-GrokHack-Control-Timestamp": invalidTimestamp,
          "X-GrokHack-Control-Signature": invalidSignature,
        },
        body: invalidUtf8,
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      signedControlRequest("/internal/allocation/assign", allocationRequest(), { method: "GET" }),
    ).resolves.toMatchObject({ status: 405 });
  });

  it("co-locates party affinity while location and allocator layout remain collision-free", async () => {
    const partyId = crypto.randomUUID();
    const realmId = `party-${crypto.randomUUID().slice(0, 8)}`;
    const first = allocationRequest({ partyId, realmId });
    const second = allocationRequest({ partyId, realmId });
    const firstResponse = await signedControlRequest("/internal/allocation/assign", first);
    const secondResponse = await signedControlRequest("/internal/allocation/assign", second);
    const firstResult = (await firstResponse.json()) as AllocationSuccess;
    const secondResult = (await secondResponse.json()) as AllocationSuccess;
    expect(firstResult.assignment).toEqual(secondResult.assignment);
    expect(secondResult.decision).toBe("affinity_reuse");
    expect(directoryBucketFor(first, TEST_BUCKET_COUNT)).toBe(
      directoryBucketFor(second, TEST_BUCKET_COUNT),
    );

    const remote = allocationRequest({ partyId, realmId, locationHint: "enam" });
    const remoteResult = (await (
      await signedControlRequest("/internal/allocation/assign", remote)
    ).json()) as AllocationSuccess;
    expect(remoteResult.assignment.floorObjectName).not.toBe(firstResult.assignment.floorObjectName);
    expect(remoteResult.assignment.floorInstanceId).toContain("a1-enam-n8-");
  });

  it("replays a response-loss receipt across eviction and rejects operation reuse with changed input", async () => {
    const request = allocationRequest();
    const first = await signedControlRequest("/internal/allocation/assign", request);
    const firstBody = await first.json();
    const stub = directoryStub(request);
    await evictDurableObject(stub);
    const retry = await signedControlRequest("/internal/allocation/assign", request);
    expect(await retry.json()).toEqual(firstBody);

    const conflict = await signedControlRequest("/internal/allocation/assign", {
      ...request,
      capacityUnits: 2,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ ok: false, code: "operation_reused" });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM allocation_reservations")
          .toArray()[0]!.count,
      ),
    ).resolves.toBe(1);
  });

  it("serializes concurrent capacity reservations and rolls overflow to another bounded floor", async () => {
    const players = collidingPlayers(3);
    const realmId = `race-${crypto.randomUUID().slice(0, 8)}`;
    const requests = players.map((playerId) => allocationRequest({ playerId, realmId }));
    const responses = await Promise.all(
      requests.map((request) => signedControlRequest("/internal/allocation/assign", request)),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const results = await Promise.all(
      responses.map((response) => response.json() as Promise<AllocationSuccess>),
    );
    expect(new Set(results.map((result) => result.assignment.floorSlot)).size).toBeGreaterThan(1);

    const stub = directoryStub(requests[0]!);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      pressure: durableState.storage.sql
        .exec<{ floor_slot: number; units: number }>(
          `SELECT floor_slot, SUM(capacity_units) AS units
           FROM allocation_reservations GROUP BY floor_slot ORDER BY floor_slot`,
        )
        .toArray(),
      slots: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM floor_slots")
        .toArray()[0]!.count,
    }));
    expect(state.pressure.every((row) => row.units <= 2)).toBe(true);
    expect(state.slots).toBeLessThanOrEqual(4);
  });

  it("reconciles a joined allocation instead of double-counting its live reservation", async () => {
    const [firstPlayer, secondPlayer] = collidingPlayers(2);
    const realmId = `reconcile-${crypto.randomUUID().slice(0, 8)}`;
    const firstRequest = allocationRequest({ playerId: firstPlayer, realmId });
    const first = (await (
      await signedControlRequest("/internal/allocation/assign", firstRequest)
    ).json()) as AllocationSuccess;
    const route = ticketInput({
      playerId: firstPlayer,
      realmId,
      floorInstanceId: first.assignment.floorInstanceId,
      allocationReservationId: first.assignment.reservationId,
      locationHint: first.assignment.locationHint,
      depth: first.assignment.depth,
      floorEpoch: first.assignment.floorEpoch,
    });
    const connected = await connect(route);
    await nextJson(connected.socket!);
    await join(connected.socket!, route.playerName);

    const secondRequest = allocationRequest({ playerId: secondPlayer, realmId });
    const second = (await (
      await signedControlRequest("/internal/allocation/assign", secondRequest)
    ).json()) as AllocationSuccess;
    expect(second.assignment.floorObjectName).toBe(first.assignment.floorObjectName);
    connected.socket!.close(1000, "test_complete");
  });

  it("does not create extra floor slots for concurrent exact duplicates", async () => {
    const request = allocationRequest();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        signedControlRequest("/internal/allocation/assign", request),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    await expect(
      runInDurableObject(directoryStub(request), (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM floor_slots")
          .toArray()[0]!.count,
      ),
    ).resolves.toBe(1);
  });

  it("coalesces concurrent party operations before creating any extra floor slot", async () => {
    const partyId = crypto.randomUUID();
    const realmId = `party-race-${crypto.randomUUID().slice(0, 8)}`;
    const requests = Array.from({ length: 10 }, () =>
      allocationRequest({ partyId, realmId, capacityUnits: 2 }),
    );
    const responses = await Promise.all(
      requests.map((request) => signedControlRequest("/internal/allocation/assign", request)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const assignments = (await Promise.all(
      responses.map((response) => response.json()),
    )) as AllocationSuccess[];
    expect(new Set(assignments.map((result) => result.assignment.floorObjectName)).size).toBe(1);
    await expect(
      runInDurableObject(directoryStub(requests[0]!), (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM floor_slots")
          .toArray()[0]!.count,
      ),
    ).resolves.toBe(1);
  });

  it("automatically advances allocator-observed tombstone retirement after eviction", async () => {
    const initial = allocationRequest();
    const first = (await (
      await signedControlRequest("/internal/allocation/assign", initial)
    ).json()) as AllocationSuccess;
    const directory = directoryStub(initial);
    await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec("UPDATE allocation_reservations SET expires_at = 0");
    });
    const floor = (env as Env).FLOOR_INSTANCES.getByName(first.assignment.floorObjectName);
    await runInDurableObject(floor, (_instance, state) => {
      for (let index = 0; index < 3; index++) {
        state.storage.sql.exec(
          `INSERT INTO sessions
             (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
              connection_id, updated_at, disconnected_at, transfer_frozen, transfer_id)
           VALUES (?, 1, 1, ?, 0, ?, unixepoch(), unixepoch(), 0, NULL)`,
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
        );
      }
    });
    const nextPlayer = playerForBucket(first.assignment.bucket);
    const replacement = (await (
      await signedControlRequest(
        "/internal/allocation/assign",
        allocationRequest({ playerId: nextPlayer, realmId: initial.realmId }),
      )
    ).json()) as AllocationSuccess;
    expect(replacement.assignment.floorSlot).not.toBe(first.assignment.floorSlot);
    await evictDurableObject(directory);
    await expect(runDurableObjectAlarm(directory)).resolves.toBe(true);
    await expect(
      runInDurableObject(directory, (_instance, state) =>
        state.storage.sql
          .exec<{ floor_epoch: number; state: string }>(
            "SELECT floor_epoch, state FROM floor_slots WHERE floor_slot = ?",
            first.assignment.floorSlot,
          )
          .toArray()[0],
      ),
    ).resolves.toEqual({ floor_epoch: 2, state: "active" });
  });

  it("reschedules automatic retirement while a prepared transfer blocks the Floor", async () => {
    const initial = allocationRequest();
    const allocated = (await (
      await signedControlRequest("/internal/allocation/assign", initial)
    ).json()) as AllocationSuccess;
    const directory = directoryStub(initial);
    await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec("UPDATE allocation_reservations SET expires_at = 0");
    });
    const floor = (env as Env).FLOOR_INSTANCES.getByName(allocated.assignment.floorObjectName);
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO transfer_preparations
           (transfer_id, player_id, request_identity, control_token, handoff_json,
            status, created_at, updated_at)
         VALUES (?, ?, 'alarm-blocker', ?, '{}', 'prepared', unixepoch(), unixepoch())`,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
    });
    const response = await signedControlRequest(
      "/internal/allocation/retire",
      retirementRequest(allocated.assignment),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      phase: "draining",
      preparedTransfers: 1,
    });
    await evictDurableObject(directory);
    await expect(runDurableObjectAlarm(directory)).resolves.toBe(true);
    await expect(
      runInDurableObject(directory, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        slot: state.storage.sql
          .exec<{ floor_epoch: number; state: string }>(
            "SELECT floor_epoch, state FROM floor_slots WHERE floor_slot = ?",
            allocated.assignment.floorSlot,
          )
          .toArray()[0],
      })),
    ).resolves.toMatchObject({
      alarm: expect.any(Number),
      slot: { floor_epoch: 1, state: "draining" },
    });
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM transfer_preparations");
    });
    await evictDurableObject(directory);
    await expect(runDurableObjectAlarm(directory)).resolves.toBe(true);
    await expect(
      runInDurableObject(directory, (_instance, state) =>
        state.storage.sql
          .exec<{ floor_epoch: number; state: string }>(
            "SELECT floor_epoch, state FROM floor_slots WHERE floor_slot = ?",
            allocated.assignment.floorSlot,
          )
          .toArray()[0],
      ),
    ).resolves.toEqual({ floor_epoch: 2, state: "active" });
  });

  it("retires an explicitly supported historical bucket layout after shard-count migration", async () => {
    const realmId = `historical-${crypto.randomUUID().slice(0, 8)}`;
    const bucketCount = 4;
    const bucket = 1;
    const floorSlot = 0;
    const floorInstanceId = floorInstanceIdForSlot("wnam", bucketCount, bucket, floorSlot);
    const request: RetirementRequest = {
      v: 1,
      operationId: crypto.randomUUID(),
      realmId,
      depth: 1,
      locationHint: "wnam",
      bucketCount,
      bucket,
      floorSlot,
      floorInstanceId,
      floorEpoch: 1,
      reason: "schema_migration",
    };
    const directory = (env as Env).REALM_DIRECTORIES.getByName(
      realmDirectoryObjectName("test", request, bucketCount, bucket),
    );
    await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO floor_slots
           (floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
            observed_live_players, observed_pending_sockets, observed_total_sockets,
            observed_durable_sessions, observed_frozen_transfers,
            observed_prepared_transfers, observed_max_players, observed_accepting,
            observed_retirement_required, observed_at, last_probe_status,
            retirement_reason, created_at, updated_at)
         VALUES (?, ?, 1, 'active', 1, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 'never', NULL, 1, 1)`,
        floorSlot,
        floorInstanceId,
      );
    });
    const response = await signedControlRequest("/internal/allocation/retire", request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      phase: "rotated",
      replacement: { bucketCount, floorEpoch: 2 },
    });
  });

  it("drains reservations, retires the old Floor fence once, and rejects stale epochs", async () => {
    const initial = allocationRequest();
    const allocated = (await (
      await signedControlRequest("/internal/allocation/assign", initial)
    ).json()) as AllocationSuccess;
    const firstRetirement = retirementRequest(allocated.assignment);
    const drainingResponse = await signedControlRequest(
      "/internal/allocation/retire",
      firstRetirement,
    );
    expect(drainingResponse.status).toBe(202);
    await expect(drainingResponse.json()).resolves.toMatchObject({
      ok: true,
      phase: "draining",
      activeReservationUnits: 1,
    });

    const stub = directoryStub(initial);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE allocation_reservations SET expires_at = 0");
    });
    const finalRetirement = retirementRequest(allocated.assignment);
    const rotatedResponse = await signedControlRequest(
      "/internal/allocation/retire",
      finalRetirement,
    );
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as Extract<
      RetirementResult,
      { ok: true; phase: "rotated" }
    >;
    expect(rotated).toMatchObject({
      ok: true,
      phase: "rotated",
      retiredFloor: { floorEpoch: 1 },
      replacement: { floorEpoch: 2 },
    });
    await evictDurableObject(stub);
    const replay = await signedControlRequest("/internal/allocation/retire", finalRetirement);
    expect(await replay.json()).toEqual(rotated);

    const stale = await signedControlRequest(
      "/internal/allocation/retire",
      retirementRequest(allocated.assignment),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      ok: false,
      code: "stale_floor_epoch",
      currentFloor: { floorEpoch: 2 },
    });

    const staleRoute = ticketInput({
      playerId: initial.playerId,
      realmId: allocated.assignment.realmId,
      floorInstanceId: allocated.assignment.floorInstanceId,
      allocationReservationId: allocated.assignment.reservationId,
      locationHint: allocated.assignment.locationHint,
      depth: allocated.assignment.depth,
      floorEpoch: allocated.assignment.floorEpoch,
    });
    const staleConnection = await connect(staleRoute);
    expect(staleConnection.response.status).toBe(409);
    await expect(staleConnection.response.json()).resolves.toMatchObject({
      error: "stale_floor_epoch",
      lifecycle: "retired",
      requiresFreshAssignment: true,
    });
  });

  it("serializes concurrent retirement after eviction to exactly one epoch increment", async () => {
    const initial = allocationRequest();
    const allocated = (await (
      await signedControlRequest("/internal/allocation/assign", initial)
    ).json()) as AllocationSuccess;
    const stub = directoryStub(initial);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE allocation_reservations SET expires_at = 0");
    });
    await evictDurableObject(stub);
    const requests = [retirementRequest(allocated.assignment), retirementRequest(allocated.assignment)];
    const responses = await Promise.all(
      requests.map((request) => signedControlRequest("/internal/allocation/retire", request)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as RetirementResult[];
    expect(bodies.filter((result) => result.ok && result.phase === "rotated")).toHaveLength(1);
    expect(bodies.filter((result) => !result.ok && result.code === "stale_floor_epoch")).toHaveLength(1);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ floor_epoch: number }>("SELECT floor_epoch FROM floor_slots WHERE floor_slot = 0")
          .toArray()[0]!.floor_epoch,
      ),
    ).resolves.toBe(2);
    const winner = responses.findIndex((response) => response.status === 200);
    await evictDurableObject(stub);
    const replay = await signedControlRequest("/internal/allocation/retire", requests[winner]!);
    expect(await replay.json()).toEqual(bodies[winner]);
  });

  it("reports capacity vectors and blocks retirement on frozen or prepared transfers", async () => {
    const route = ticketInput({ realmId: `blockers-${crypto.randomUUID().slice(0, 8)}` });
    const runtimeEnv = env as Env;
    const floorName = floorObjectName(route);
    const floor = runtimeEnv.FLOOR_INSTANCES.getByName(floorName);
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sessions
           (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
            connection_id, updated_at, disconnected_at, transfer_frozen, transfer_id)
         VALUES (?, 1, 1, ?, 0, ?, unixepoch(), unixepoch(), 1, ?)`,
        route.playerId,
        route.leaseId,
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
      state.storage.sql.exec(
        `INSERT INTO transfer_preparations
           (transfer_id, player_id, request_identity, control_token, handoff_json,
            status, created_at, updated_at)
         VALUES (?, ?, 'capacity-vector', ?, '{}', 'prepared', unixepoch(), unixepoch())`,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
    });
    await expect(
      floor.getCapacitySnapshot({ floorObjectName: floorName, floorEpoch: route.floorEpoch }),
    ).resolves.toMatchObject({
      ok: true,
      livePlayers: 0,
      pendingSockets: 0,
      totalSockets: 0,
      durableSessions: 1,
      frozenTransfers: 1,
      preparedTransfers: 1,
      retirementRequired: false,
      emptyForRetirement: false,
    });
    await expect(
      floor.advanceFloorRetirement({ floorObjectName: floorName, floorEpoch: route.floorEpoch }),
    ).resolves.toMatchObject({
      ok: true,
      phase: "blocked",
      frozenTransfers: 1,
      preparedTransfers: 1,
    });
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET transfer_frozen = 0, transfer_id = NULL");
      state.storage.sql.exec("DELETE FROM transfer_preparations");
      state.storage.sql.exec(
        `INSERT INTO transfer_exports
           (transfer_id, player_id, request_identity, response_json, authority_token,
            status, created_at, updated_at)
         VALUES (?, ?, 'orphan-frozen-export', '{}', NULL, 'frozen', unixepoch(), unixepoch())`,
        crypto.randomUUID(),
        route.playerId,
      );
    });
    await expect(
      floor.advanceFloorRetirement({ floorObjectName: floorName, floorEpoch: route.floorEpoch }),
    ).resolves.toMatchObject({ ok: true, phase: "blocked", frozenTransfers: 1 });
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec("UPDATE transfer_exports SET status = 'aborted'");
    });
    await expect(
      floor.advanceFloorRetirement({ floorObjectName: floorName, floorEpoch: route.floorEpoch }),
    ).resolves.toMatchObject({ ok: true, phase: "retired" });
    await expect(
      floor.getCapacitySnapshot({ floorObjectName: floorName, floorEpoch: route.floorEpoch }),
    ).resolves.toMatchObject({ ok: true, retired: true, acceptingNewPlayers: false });
    const stale = await connect(route);
    expect(stale.response.status).toBe(409);
  });

  it("caps probes and fails closed when every bounded floor identity is unavailable", async () => {
    const first = allocationRequest();
    await signedControlRequest("/internal/allocation/assign", first);
    const stub = directoryStub(first);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM allocation_reservations");
      state.storage.sql.exec("DELETE FROM directory_operations");
      state.storage.sql.exec("UPDATE floor_slots SET floor_instance_id = 'corrupt-0'");
      for (let floorSlot = 1; floorSlot < 4; floorSlot++) {
        state.storage.sql.exec(
          `INSERT INTO floor_slots
             (floor_slot, floor_instance_id, floor_epoch, state, lifecycle_version,
              observed_live_players, observed_pending_sockets, observed_total_sockets,
              observed_durable_sessions, observed_frozen_transfers,
              observed_prepared_transfers, observed_max_players, observed_accepting,
              observed_retirement_required, observed_at, last_probe_status,
              retirement_reason, created_at, updated_at)
           VALUES (?, ?, 1, 'active', 1, 0, 0, 0, 0, 0, 0, 2, 1, 0, 1, 'ok', NULL, 1, 1)`,
          floorSlot,
          `corrupt-${floorSlot}`,
        );
      }
    });
    const nextPlayer = playerForBucket(directoryBucketFor(first, TEST_BUCKET_COUNT));
    const response = await signedControlRequest(
      "/internal/allocation/assign",
      allocationRequest({ playerId: nextPlayer, realmId: first.realmId }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "floor_unavailable",
      probes: 4,
      requiresFreshAssignment: true,
    });
  });

  it("expands an adjacent directory schema and preserves assignment state across eviction", async () => {
    const request = allocationRequest();
    const allocated = (await (
      await signedControlRequest("/internal/allocation/assign", request)
    ).json()) as AllocationSuccess;
    const stub = directoryStub(request);
    await runInDurableObject(stub, (_instance, state) => {
      const reservation = state.storage.sql
        .exec<{
          affinity_key: string;
          floor_slot: number;
          floor_epoch: number;
          capacity_units: number;
          expires_at: number;
          created_at: number;
          updated_at: number;
        }>(
          `SELECT affinity_key, floor_slot, floor_epoch, capacity_units,
                  expires_at, created_at, updated_at FROM allocation_reservations`,
        )
        .toArray()[0]!;
      state.storage.sql.exec("DROP TABLE floor_slots");
      state.storage.sql.exec(`CREATE TABLE floor_slots (
        floor_slot INTEGER PRIMARY KEY,
        floor_instance_id TEXT NOT NULL,
        floor_epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        observed_live_players INTEGER NOT NULL DEFAULT 0,
        observed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        `INSERT INTO floor_slots
           (floor_slot, floor_instance_id, floor_epoch, state, observed_live_players,
            observed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, 1, 1, 1)`,
        allocated.assignment.floorSlot,
        allocated.assignment.floorInstanceId,
        allocated.assignment.floorEpoch,
      );
      state.storage.sql.exec("DROP TABLE allocation_reservations");
      state.storage.sql.exec(`CREATE TABLE allocation_reservations (
        affinity_key TEXT PRIMARY KEY,
        floor_slot INTEGER NOT NULL,
        floor_epoch INTEGER NOT NULL,
        capacity_units INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID`);
      state.storage.sql.exec(
        `INSERT INTO allocation_reservations
           (affinity_key, floor_slot, floor_epoch, capacity_units, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        reservation.affinity_key,
        reservation.floor_slot,
        reservation.floor_epoch,
        reservation.capacity_units,
        reservation.expires_at,
        reservation.created_at,
        reservation.updated_at,
      );
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version IN (2, 3)");
    });
    await evictDurableObject(stub);
    const retried = await signedControlRequest("/internal/allocation/assign", {
      ...request,
      operationId: crypto.randomUUID(),
    });
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as AllocationSuccess;
    expect(retriedBody.assignment.reservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const migrated = await runInDurableObject(stub, (_instance, state) => ({
      slots: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(floor_slots)")
        .toArray()
        .map((column) => column.name),
      reservations: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(allocation_reservations)")
        .toArray()
        .map((column) => column.name),
    }));
    expect(migrated.slots).toEqual(
      expect.arrayContaining([
        "lifecycle_version",
        "observed_pending_sockets",
        "observed_prepared_transfers",
        "observed_retirement_required",
        "retirement_reason",
      ]),
    );
    expect(migrated.reservations).toContain("reservation_id");
  });

  it("fails closed instead of mutating a newer unknown directory schema", async () => {
    const request = allocationRequest();
    await signedControlRequest("/internal/allocation/assign", request);
    const stub = directoryStub(request);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (999, unixepoch())",
      );
    });
    await evictDurableObject(stub);
    const response = await signedControlRequest("/internal/allocation/assign", {
      ...request,
      operationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "directory_schema_incompatible",
      requiresFreshAssignment: true,
    });
  });

  it("never evicts live idempotency fences when the bounded receipt table is full", async () => {
    const first = allocationRequest();
    await signedControlRequest("/internal/allocation/assign", first);
    const stub = directoryStub(first);
    await runInDurableObject(stub, (_instance, state) => {
      const current = state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM directory_operations")
        .toArray()[0]!.count;
      for (let index = current; index < 64; index++) {
        state.storage.sql.exec(
          `INSERT INTO directory_operations
             (operation_id, operation_kind, request_hash, response_json, retain_until, created_at)
           VALUES (?, 'allocate', ?, '{"ok":false,"code":"directory_at_capacity","retryable":true,"requiresFreshAssignment":true}', 9999999999, ?)`,
          `seed-operation-${String(index).padStart(3, "0")}`,
          `seed-hash-${index}`,
          index,
        );
      }
    });
    const playerId = playerForBucket(directoryBucketFor(first, TEST_BUCKET_COUNT));
    const blocked = await signedControlRequest(
      "/internal/allocation/assign",
      allocationRequest({ playerId, realmId: first.realmId }),
    );
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({
      ok: false,
      code: "directory_receipt_capacity",
      retryable: true,
    });
    const bounded = await runInDurableObject(stub, (_instance, state) => ({
      operations: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM directory_operations")
        .toArray()[0]!.count,
      reservations: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM allocation_reservations")
        .toArray()[0]!.count,
    }));
    expect(bounded).toEqual({ operations: 64, reservations: 1 });
  });
});
