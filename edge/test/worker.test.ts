import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  floorObjectName,
  issueRouteTicket,
  MAX_INBOUND_FRAME_BYTES,
  playerSessionObjectName,
} from "../src/protocol";
import {
  TEST_PREVIOUS_ROUTE_TICKET_SECRET,
  TEST_ROUTE_TICKET_SECRET,
  authorityJoinRequest,
  connect,
  connectWithTicket,
  join,
  nextClose,
  nextJson,
  ticketInput,
} from "./helpers";

function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
}

async function seedMovementState(
  input: ReturnType<typeof ticketInput>,
  cells: ReadonlyArray<{
    x: number;
    y: number;
    tile?: "#" | "." | ">" | "<" | "+";
    trap?: number;
    stairsDown?: number;
    itemPresent?: number;
    roomEffect?: number;
  }>,
  position = { x: 1, y: 1 },
) {
  const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
  await runInDurableObject(stub, (instance, state) => {
    const bootstrap = state.storage.transactionSync(() =>
      (instance as unknown as {
        ensureFloorReady(name: string, depth: number): { ok: boolean; code?: string };
      }).ensureFloorReady(floorObjectName(input), input.depth),
    );
    if (!bootstrap.ok) throw new Error(`movement bootstrap failed: ${bootstrap.code}`);
    for (const cell of cells) {
      state.storage.sql.exec(
        `INSERT INTO floor_cells
           (x, y, tile, trap, stairs_down, item_present, room_effect)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(x, y) DO UPDATE SET
           tile = excluded.tile, trap = excluded.trap,
           stairs_down = excluded.stairs_down, item_present = excluded.item_present,
           room_effect = excluded.room_effect`,
        cell.x,
        cell.y,
        cell.tile ?? ".",
        cell.trap ?? 0,
        cell.stairsDown ?? 0,
        cell.itemPresent ?? 0,
        cell.roomEffect ?? 0,
      );
    }
    state.storage.sql.exec(
      `INSERT INTO player_positions
         (player_id, x, y, phase, immobilized_turns, updated_revision, present)
       VALUES (?, ?, ?, 'playing', 0, 0, 1)
       ON CONFLICT(player_id) DO UPDATE SET
         x = excluded.x, y = excluded.y, phase = 'playing',
         immobilized_turns = 0, updated_revision = 0, present = 1`,
      input.playerId,
      position.x,
      position.y,
    );
    state.storage.sql.exec(
      `INSERT INTO player_gameplay
         (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
       VALUES (?, 0, 1000, 1000, 'satiated', 20, 1)
       ON CONFLICT(player_id) DO UPDATE SET
         turns = 0, hunger = 1000, max_hunger = 1000,
         hunger_state = 'satiated', hp = 20, alive = 1`,
      input.playerId,
    );
  });
  return stub;
}

describe("edge gateway and FloorInstance runtime", () => {
  it("reports architecture health without touching a Durable Object", async () => {
    const response = await SELF.fetch("https://edge.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      ready: true,
      environment: "test",
      protocolVersion: 4,
      architecture: "sharded-floor-durable-objects",
    });
    const ready = await SELF.fetch("https://edge.test/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ ok: true, ready: true });
  });

  it("provisions deterministic floor geometry during the allocator capacity probe", async () => {
    const input = ticketInput({ playerName: "CapacityHero" });
    const floorName = floorObjectName(input);
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorName);
    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorName,
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({
      ok: true,
      acceptingNewPlayers: true,
      retirementRequired: false,
      durableSessions: 0,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        worlds: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM floor_world",
        ).one().count,
        cells: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM floor_cells",
        ).one().count,
        positions: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM player_positions",
        ).one().count,
      })),
    ).resolves.toEqual({ worlds: 1, cells: 80 * 24, positions: 0 });

    const connection = await connect(input);
    await nextJson(connection.socket!);
    const joined = await join(connection.socket!, input.playerName);
    expect(joined).toMatchObject({
      type: "edge_joined",
      position: { x: expect.any(Number), y: expect.any(Number) },
      movementProfile: "movement_plain_v1",
      availableMoves: expect.arrayContaining([
        { dx: expect.any(Number), dy: expect.any(Number) },
      ]),
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ present: number }>(
          "SELECT present FROM player_positions WHERE player_id = ?",
          input.playerId,
        ).one().present,
      ),
    ).resolves.toBe(1);
    connection.socket!.close(1000, "test_complete");
  });

  it("claims distinct active spawns for concurrent players on one provisioned floor", async () => {
    const firstInput = ticketInput({ playerName: "SpawnAlpha" });
    const secondInput = ticketInput({
      playerName: "SpawnBeta",
      realmId: firstInput.realmId,
      floorInstanceId: firstInput.floorInstanceId,
      depth: firstInput.depth,
      floorEpoch: firstInput.floorEpoch,
    });
    const floorName = floorObjectName(firstInput);
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorName);
    await stub.getCapacitySnapshot({ floorObjectName: floorName, floorEpoch: firstInput.floorEpoch });

    const first = await connect(firstInput);
    await nextJson(first.socket!);
    const second = await connect(secondInput);
    await nextJson(second.socket!);
    const [firstJoined, secondJoined] = await Promise.all([
      join(first.socket!, firstInput.playerName),
      join(second.socket!, secondInput.playerName),
    ]);
    expect(firstJoined.position).not.toEqual(secondJoined.position);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ player_id: string; present: number }>(
          "SELECT player_id, present FROM player_positions ORDER BY player_id",
        ).toArray(),
      ),
    ).resolves.toEqual(expect.arrayContaining([
      { player_id: firstInput.playerId, present: 1 },
      { player_id: secondInput.playerId, present: 1 },
    ]));

    const firstClose = nextClose(first.socket!);
    first.socket!.close(1000, "release_first_spawn");
    await firstClose;
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ player_id: string; present: number }>(
          "SELECT player_id, present FROM player_positions ORDER BY player_id",
        ).toArray(),
      ),
    ).resolves.toEqual(expect.arrayContaining([
      { player_id: firstInput.playerId, present: 0 },
      { player_id: secondInput.playerId, present: 1 },
    ]));
    second.socket!.close(1000, "test_complete");
  });

  it("binds one global route idempotently and rejects uncommitted authority changes", async () => {
    const runtimeEnv = env as Env;
    const playerId = crypto.randomUUID();
    const input = ticketInput({ playerId, realmId: `authority-${crypto.randomUUID().slice(0, 8)}` });
    const authority = runtimeEnv.PLAYER_SESSIONS.getByName(
      playerSessionObjectName("test", playerId),
    );
    const request = await authorityJoinRequest(input);

    const initial = await authority.authorizeJoin(request);
    expect(initial).toMatchObject({ ok: true, decision: "initial_bound", version: 1 });
    await expect(authority.authorizeJoin(request)).resolves.toEqual(initial);
    await expect(
      authority.authorizeJoin({ ...request, connectionId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });
    const transferRequest = await authorityJoinRequest({
      ...input,
      realmId: "authority-other",
      jti: crypto.randomUUID(),
    });
    await expect(authority.authorizeJoin(transferRequest)).resolves.toMatchObject({
      ok: false,
      code: "transfer_required",
      version: 1,
    });
    const takeoverRequest = await authorityJoinRequest({
      ...input,
      sessionEpoch: input.sessionEpoch + 1,
      jti: crypto.randomUUID(),
    });
    await expect(authority.authorizeJoin(takeoverRequest)).resolves.toMatchObject({
      ok: false,
      code: "takeover_required",
      version: 1,
    });
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      environment: "test",
      playerId,
      floorObjectName: request.floorObjectName,
      leaseId: input.leaseId,
      version: 1,
    });
  });

  it("fails closed before routing invalid WebSocket requests", async () => {
    const ordinary = await SELF.fetch("https://edge.test/ws");
    expect(ordinary.status).toBe(426);

    const unsigned = await SELF.fetch("https://edge.test/ws", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "grokhack.v4" },
    });
    expect(unsigned.status).toBe(401);

    const forged = await SELF.fetch("https://edge.test/ws", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "grokhack.v4, grokhack.ticket.payload.signature",
      },
    });
    expect(forged.status).toBe(401);

    const input = ticketInput();
    const ticket = await issueRouteTicket(input, TEST_ROUTE_TICKET_SECRET);
    const wrongOrigin = await connectWithTicket(ticket, "https://evil.example");
    expect(wrongOrigin.response.status).toBe(403);

    const ambiguous = await SELF.fetch("https://edge.test/ws", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol":
          `grokhack.v4, grokhack.ticket.${ticket}, grokhack.ticket.${ticket}`,
      },
    });
    expect(ambiguous.status).toBe(401);
  });

  it("consumes each route ticket once without disturbing the admitted socket", async () => {
    const input = ticketInput({ playerName: "OneTimeHero" });
    const first = await connect(input);
    await nextJson(first.socket!);

    const replayWhilePending = await connectWithTicket(first.ticket);
    expect(replayWhilePending.response.status).toBe(409);
    await expect(replayWhilePending.response.json()).resolves.toMatchObject({
      error: "route_ticket_replayed",
    });

    first.socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(first.socket!)).resolves.toMatchObject({ type: "pong" });
    await join(first.socket!, input.playerName);

    const replayAfterJoin = await connectWithTicket(first.ticket);
    expect(replayAfterJoin.response.status).toBe(409);
    first.socket!.close(1000, "test_complete");
  });

  it("routes tickets signed by the bounded previous key during rotation", async () => {
    const input = ticketInput({ playerName: "RotatingHero", keyId: "test-v0" });
    const ticket = await issueRouteTicket(input, TEST_PREVIOUS_ROUTE_TICKET_SECRET);
    const connection = await connectWithTicket(ticket);
    expect(connection.response.status).toBe(101);
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ type: "welcome" });
    connection.socket!.close(1000, "test_complete");
  });

  it("upgrades directly to a hibernating floor socket and preserves ping/join envelopes", async () => {
    const input = ticketInput({ playerName: "BrowserHero" });
    const { response, socket } = await connect(input);
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("grokhack.v4");
    expect(socket).toBeDefined();

    const welcome = await nextJson(socket!);
    expect(welcome).toMatchObject({
      type: "welcome",
      protocolVersion: 4,
      maxPlayers: 2,
      architecture: "floor-instance-do",
    });

    await expect(join(socket!, input.playerName)).resolves.toMatchObject({
      type: "edge_joined",
      playerId: input.playerId,
      expectedClientSeq: 1,
    });
    socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(socket!)).resolves.toMatchObject({ type: "pong", online: 1 });
    socket!.close(1000, "test_complete");
  });

  it("commits once, replays the exact acknowledgement, and survives object eviction", async () => {
    const input = ticketInput({ playerName: "DurableHero" });
    const first = await connect(input);
    expect(first.socket).toBeDefined();
    await nextJson(first.socket!);
    await join(first.socket!, input.playerName);

    first.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    const committed = await nextJson(first.socket!);
    expect(committed).toMatchObject({
      type: "ack",
      command: "slo_probe",
      clientSeq: 1,
      serverSeq: 1,
      serverRevision: 1,
    });

    first.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    expect(await nextJson(first.socket!)).toEqual(committed);
    first.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 3 }));
    await expect(nextJson(first.socket!)).resolves.toMatchObject({
      type: "error",
      code: "client_sequence_gap",
      expectedClientSeq: 2,
    });

    const firstClose = nextClose(first.socket!);
    first.socket!.close(1000, "eviction_test");
    await firstClose;
    const runtimeEnv = env as Env;
    const stub = runtimeEnv.FLOOR_INSTANCES.get(
      runtimeEnv.FLOOR_INSTANCES.idFromName(floorObjectName({
        realmId: input.realmId,
        floorInstanceId: input.floorInstanceId,
        depth: input.depth,
        floorEpoch: input.floorEpoch,
      })),
    );
    await evictDurableObject(stub, { webSockets: "close" });

    const resumed = await connect({ ...input, jti: crypto.randomUUID() });
    expect(resumed.socket).toBeDefined();
    await nextJson(resumed.socket!);
    await expect(join(resumed.socket!, input.playerName)).resolves.toMatchObject({
      expectedClientSeq: 2,
    });
    resumed.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    expect(await nextJson(resumed.socket!)).toEqual(committed);
    resumed.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 2 }));
    await expect(nextJson(resumed.socket!)).resolves.toMatchObject({
      type: "ack",
      clientSeq: 2,
      serverRevision: 2,
    });
    resumed.socket!.close(1000, "test_complete");
  });

  it("runs shared wait gameplay exactly once and rejects gaps and command conflicts", async () => {
    const input = ticketInput({ playerName: "WaitingHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);

    connection.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 1 }));
    const committed = await nextJson(connection.socket!);
    expect(committed).toMatchObject({
      type: "ack",
      command: "wait",
      clientSeq: 1,
      state: { turns: 1, depth: 1, hunger: 998, maxHunger: 1000, hungerState: "satiated", hp: 20, alive: true },
      stateHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      events: [{ type: "message", text: "You wait." }],
    });

    connection.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 1 }));
    expect(await nextJson(connection.socket!)).toEqual(committed);
    connection.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ code: "idempotency_conflict" });
    connection.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 3 }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ code: "client_sequence_gap", expectedClientSeq: 2 });
    connection.socket!.send(JSON.stringify({ type: "input", command: "move", clientSeq: 2 }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ code: "invalid_movement_input" });
    const runtimeEnv = env as Env;
    const stub = runtimeEnv.FLOOR_INSTANCES.get(
      runtimeEnv.FLOOR_INSTANCES.idFromName(floorObjectName(input)),
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE player_gameplay SET alive = 0 WHERE player_id = ?", input.playerId);
    });
    connection.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 2 }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ code: "terminal_state" });
    await expect(runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ last_client_seq: number }>(
        "SELECT last_client_seq FROM sessions WHERE player_id = ?", input.playerId,
      ).toArray();
      return rows[0]?.last_client_seq;
    })).resolves.toBe(1);
    connection.socket!.close(1000, "test_complete");
  });

  it("bootstraps a real floor and reclaims presence across disconnect and eviction", async () => {
    const input = ticketInput({ playerName: "BootstrapHero" });
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorObjectName(input),
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({ ok: true, acceptingNewPlayers: true });
    const first = await connect(input);
    await nextJson(first.socket!);
    const joined = await join(first.socket!, input.playerName);
    const direction = (joined.availableMoves as Array<{ dx: number; dy: number }> | undefined)?.[0];
    if (!direction) throw new Error("allocator-provisioned spawn has no plain move");
    const response = nextJson(first.socket!);
    first.socket!.send(JSON.stringify({
      type: "input",
      command: "move",
      ...direction,
      clientSeq: 1,
    }));
    const moved = await response;
    expect(moved).toMatchObject({
      type: "ack",
      command: "move",
      clientSeq: 1,
      serverRevision: 1,
      outcome: "moved",
    });

    const ready = await runInDurableObject(stub, (_instance, state) => ({
      world: state.storage.sql.exec<{
        status: string;
        generator_version: number;
        simulation_profile: string;
        seed: number;
        cell_count: number;
        map_hash: string;
      }>(
        `SELECT status, generator_version, simulation_profile, seed, cell_count, map_hash
         FROM floor_world WHERE singleton = 1`,
      ).one(),
      storedCells: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM floor_cells",
      ).one().count,
      position: state.storage.sql.exec<{ x: number; y: number; present: number }>(
        "SELECT x, y, present FROM player_positions WHERE player_id = ?",
        input.playerId,
      ).one(),
      sequence: state.storage.sql.exec<{ last_client_seq: number }>(
        "SELECT last_client_seq FROM sessions WHERE player_id = ?",
        input.playerId,
      ).one().last_client_seq,
      receipts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM processed_commands WHERE player_id = ?",
        input.playerId,
      ).one().count,
    }));
    expect(ready.world).toMatchObject({
      status: "ready",
      generator_version: 1,
      simulation_profile: "movement_plain_v1",
      cell_count: 80 * 24,
      seed: expect.any(Number),
      map_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(ready.storedCells).toBe(80 * 24);
    expect(ready.position).toMatchObject({ present: 1 });
    expect(ready.sequence).toBe(1);
    expect(ready.receipts).toBe(1);

    const firstClose = nextClose(first.socket!);
    first.socket!.close(1000, "bootstrap_disconnect");
    await firstClose;
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ present: number }>(
          "SELECT present FROM player_positions WHERE player_id = ?",
          input.playerId,
        ).one().present,
      ),
    ).resolves.toBe(0);
    await evictDurableObject(stub, { webSockets: "close" });

    const resumed = await connect({ ...input, jti: crypto.randomUUID() });
    await nextJson(resumed.socket!);
    await expect(join(resumed.socket!, input.playerName)).resolves.toMatchObject({
      expectedClientSeq: 2,
      movementProfile: "movement_plain_v1",
    });
    let replay = nextJson(resumed.socket!);
    resumed.socket!.send(JSON.stringify({
      type: "input",
      command: "move",
      dx: direction.dx,
      dy: direction.dy,
      clientSeq: 1,
    }));
    await expect(replay).resolves.toEqual(moved);

    replay = nextJson(resumed.socket!);
    resumed.socket!.send(JSON.stringify({
      type: "input",
      command: "move",
      dx: -direction.dx,
      dy: -direction.dy,
      clientSeq: 2,
    }));
    await expect(replay).resolves.toMatchObject({
      type: "ack",
      outcome: "moved",
      clientSeq: 2,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        present: state.storage.sql.exec<{ present: number }>(
          "SELECT present FROM player_positions WHERE player_id = ?",
          input.playerId,
        ).one().present,
        seed: state.storage.sql.exec<{ seed: number }>(
          "SELECT seed FROM floor_world WHERE singleton = 1",
        ).one().seed,
        mapHash: state.storage.sql.exec<{ map_hash: string }>(
          "SELECT map_hash FROM floor_world WHERE singleton = 1",
        ).one().map_hash,
      })),
    ).resolves.toEqual({ present: 1, seed: ready.world.seed, mapHash: ready.world.map_hash });
    resumed.socket!.close(1000, "test_complete");
  });

  it("keeps presence when a stale superseded socket closes", async () => {
    const input = ticketInput({ playerName: "PresenceHero" });
    const first = await connect(input);
    await nextJson(first.socket!);
    await join(first.socket!, input.playerName);
    let response = nextJson(first.socket!);
    first.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
    }));
    await expect(response).resolves.toMatchObject({ type: "ack", clientSeq: 1 });

    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    const staleClose = nextClose(first.socket!);
    const replacement = await connect({ ...input, jti: crypto.randomUUID() });
    await nextJson(replacement.socket!);
    await join(replacement.socket!, input.playerName);
    await staleClose;
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ present: number }>(
          "SELECT present FROM player_positions WHERE player_id = ?",
          input.playerId,
        ).one().present,
      ),
    ).resolves.toBe(1);

    const replacementClose = nextClose(replacement.socket!);
    replacement.socket!.close(1000, "presence_fence_complete");
    await replacementClose;
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ present: number }>(
          "SELECT present FROM player_positions WHERE player_id = ?",
          input.playerId,
        ).one().present,
      ),
    ).resolves.toBe(0);
  });

  it("fails closed instead of regenerating a legacy partial floor", async () => {
    const input = ticketInput({ playerName: "LegacyFloorHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO floor_cells
           (x, y, tile, trap, stairs_down, item_present, room_effect)
         VALUES (1, 1, '.', 0, 0, 0, 0)`,
      );
    });

    const response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
    }));
    await expect(response).resolves.toMatchObject({
      type: "error",
      code: "floor_migration_required",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        worldRows: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM floor_world",
        ).one().count,
        sequence: state.storage.sql.exec<{ last_client_seq: number }>(
          "SELECT last_client_seq FROM sessions WHERE player_id = ?",
          input.playerId,
        ).one().last_client_seq,
        positions: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM player_positions",
        ).one().count,
      })),
    ).resolves.toEqual({ worldRows: 0, sequence: 0, positions: 0 });
    connection.socket!.close(1000, "test_complete");
  });

  it("retires a plausible floor manifest whose persisted cells are partial", async () => {
    const input = ticketInput({ playerName: "PartialWorld" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    const floorName = floorObjectName(input);
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorName);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO floor_cells
           (x, y, tile, trap, stairs_down, item_present, room_effect, spawn_rank)
         VALUES (1, 1, '.', 0, 0, 0, 0, 0)`,
      );
      state.storage.sql.exec(
        `INSERT INTO floor_world
           (singleton, status, generator_version, ruleset_version, simulation_profile,
            seed, width, height, entry_x, entry_y, cell_count, map_hash)
         VALUES (1, 'ready', 1, 1, 'movement_plain_v1',
                 7, 80, 24, 1, 1, 1920, '0123456789abcdef')`,
      );
    });

    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorName,
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({
      ok: true,
      acceptingNewPlayers: false,
      retirementRequired: true,
    });
    await expect(join(connection.socket!, input.playerName)).resolves.toMatchObject({
      type: "error",
      code: "floor_world_incompatible",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        cells: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM floor_cells",
        ).one().count,
        positions: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM player_positions",
        ).one().count,
      })),
    ).resolves.toEqual({ cells: 1, positions: 0 });
  });

  it("retires a floor whose persisted geometry no longer matches its manifest hash", async () => {
    const input = ticketInput({ playerName: "TamperedWorld" });
    const floorName = floorObjectName(input);
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorName);
    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorName,
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({ ok: true, acceptingNewPlayers: true });
    await runInDurableObject(stub, (_instance, state) => {
      const cell = state.storage.sql.exec<{ x: number; y: number }>(
        "SELECT x, y FROM floor_cells WHERE spawn_rank IS NULL ORDER BY y, x LIMIT 1",
      ).one();
      state.storage.sql.exec(
        `UPDATE floor_cells
         SET tile = CASE tile WHEN '#' THEN '.' ELSE '#' END
         WHERE x = ? AND y = ?`,
        cell.x,
        cell.y,
      );
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT changes() AS count").one().count,
      ).toBe(1);
    });

    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorName,
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({
      ok: true,
      acceptingNewPlayers: false,
      retirementRequired: true,
    });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await expect(join(connection.socket!, input.playerName)).resolves.toMatchObject({
      type: "error",
      code: "floor_world_incompatible",
    });
  });

  it("rejects an unknown floor simulation profile without consuming sequence", async () => {
    const input = ticketInput({ playerName: "ProfileFenceHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    let response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
    }));
    await expect(response).resolves.toMatchObject({ type: "ack", clientSeq: 1 });

    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE floor_world SET simulation_profile = 'future_ruleset' WHERE singleton = 1",
      );
    });
    response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: -1, dy: 0, clientSeq: 2,
    }));
    await expect(response).resolves.toMatchObject({
      type: "error",
      code: "floor_world_incompatible",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ last_client_seq: number }>(
          "SELECT last_client_seq FROM sessions WHERE player_id = ?",
          input.playerId,
        ).one().last_client_seq,
      ),
    ).resolves.toBe(1);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE floor_world SET simulation_profile = 'movement_plain_v1' WHERE singleton = 1",
      );
    });
    response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: -1, dy: 0, clientSeq: 2,
    }));
    await expect(response).resolves.toMatchObject({ type: "ack", clientSeq: 2 });
    connection.socket!.close(1000, "test_complete");
  });

  it("commits an authoritative move before a lost response and replays exact bytes after eviction", async () => {
    const input = ticketInput({ playerName: "MoveReplayHero" });
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    await expect(stub.getCapacitySnapshot({
      floorObjectName: floorObjectName(input),
      floorEpoch: input.floorEpoch,
    })).resolves.toMatchObject({ ok: true, acceptingNewPlayers: true });
    const first = await connect(input);
    await nextJson(first.socket!);
    const joined = await join(first.socket!, input.playerName);
    const direction = (joined.availableMoves as Array<{ dx: number; dy: number }> | undefined)?.[0];
    if (!direction) throw new Error("allocator-provisioned spawn has no plain move");

    let injectedSendFailures = 0;
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets()[0];
      if (!socket) throw new Error("missing move socket");
      vi.spyOn(socket, "send").mockImplementationOnce(() => {
        injectedSendFailures += 1;
        throw new Error("injected response loss");
      });
    });

    first.socket!.send(JSON.stringify({
      type: "input",
      command: "move",
      ...direction,
      clientSeq: 1,
    }));
    let committed = "";
    await vi.waitFor(async () => {
      committed = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ response_json: string }>(
          `SELECT response_json FROM processed_commands
           WHERE player_id = ? AND session_epoch = 1 AND client_seq = 1`,
          input.playerId,
        ).one().response_json,
      );
      expect(injectedSendFailures).toBe(1);
      expect(JSON.parse(committed)).toMatchObject({
        type: "ack",
        command: "move",
        outcome: "moved",
      });
    });

    const firstClose = nextClose(first.socket!);
    first.socket!.close(1000, "response_lost");
    await firstClose;
    await evictDurableObject(stub, { webSockets: "close" });

    const resumed = await connect({ ...input, jti: crypto.randomUUID() });
    await nextJson(resumed.socket!);
    await expect(join(resumed.socket!, input.playerName)).resolves.toMatchObject({
      expectedClientSeq: 2,
    });
    const replay = nextText(resumed.socket!);
    resumed.socket!.send(JSON.stringify({
      type: "input", command: "move", ...direction, clientSeq: 1,
    }));
    await expect(replay).resolves.toBe(committed);
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        position: state.storage.sql.exec<{ x: number; y: number }>(
          "SELECT x, y FROM player_positions WHERE player_id = ?", input.playerId,
        ).one(),
        gameplay: state.storage.sql.exec<{ turns: number; hunger: number }>(
          "SELECT turns, hunger FROM player_gameplay WHERE player_id = ?", input.playerId,
        ).one(),
        revision: state.storage.sql.exec<{ revision: number }>(
          "SELECT revision FROM floor_meta WHERE singleton = 1",
        ).one().revision,
      })),
    ).resolves.toEqual({
      position: {
        x: (joined.position as { x: number; y: number }).x + direction.dx,
        y: (joined.position as { x: number; y: number }).y + direction.dy,
      },
      gameplay: { turns: 1, hunger: 998 },
      revision: 1,
    });
    resumed.socket!.close(1000, "test_complete");
  });

  it("handles blocked, malformed, conflicting, stale, and gapped authoritative moves", async () => {
    const input = ticketInput({ playerName: "MoveFenceHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = await seedMovementState(input, [
      { x: 1, y: 1 },
      { x: 2, y: 1, tile: "#" },
      { x: 1, y: 2 },
      { x: 0, y: 1 },
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO player_positions
           (player_id, x, y, phase, immobilized_turns, updated_revision, present)
         VALUES ('blocking-player', 1, 2, 'playing', 0, 0, 1)`,
      );
    });
    const move = (frame: Record<string, unknown>) => {
      const response = nextJson(connection.socket!);
      connection.socket!.send(JSON.stringify({ type: "input", command: "move", ...frame }));
      return response;
    };

    await expect(move({ dx: 1, dy: 0, clientSeq: 1 })).resolves.toMatchObject({
      type: "ack", outcome: "blocked_terrain", position: { x: 1, y: 1 },
    });
    await expect(move({ dx: 0, dy: -1, clientSeq: 2 })).resolves.toMatchObject({
      type: "ack", outcome: "blocked_terrain", position: { x: 1, y: 1 },
    });
    await expect(move({ dx: 0, dy: 1, clientSeq: 3 })).resolves.toMatchObject({
      type: "ack", outcome: "blocked_player", position: { x: 1, y: 1 },
    });
    await expect(move({ dx: 2, dy: 0, clientSeq: 4 })).resolves.toMatchObject({
      code: "invalid_movement_direction",
    });
    await expect(move({ dx: -1, dy: 0, clientSeq: 4, dangerous: true })).resolves.toMatchObject({
      code: "invalid_movement_input",
    });
    await expect(move({ dx: -1, dy: 0, clientSeq: 5 })).resolves.toMatchObject({
      code: "client_sequence_gap", expectedClientSeq: 4,
    });
    await expect(move({ dx: -1, dy: 0, clientSeq: 4 })).resolves.toMatchObject({
      type: "ack", outcome: "moved", position: { x: 0, y: 1 },
    });
    await expect(move({ dx: 1, dy: 0, clientSeq: 4 })).resolves.toMatchObject({
      code: "idempotency_conflict",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM processed_commands WHERE player_id = ? AND client_seq = 4",
        input.playerId,
      );
    });
    await expect(move({ dx: -1, dy: 0, clientSeq: 4 })).resolves.toMatchObject({
      code: "stale_client_sequence", expectedClientSeq: 5,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        session: state.storage.sql.exec<{ last_client_seq: number }>(
          "SELECT last_client_seq FROM sessions WHERE player_id = ?", input.playerId,
        ).one().last_client_seq,
        revision: state.storage.sql.exec<{ revision: number }>(
          "SELECT revision FROM floor_meta WHERE singleton = 1",
        ).one().revision,
        turns: state.storage.sql.exec<{ turns: number }>(
          "SELECT turns FROM player_gameplay WHERE player_id = ?", input.playerId,
        ).one().turns,
      })),
    ).resolves.toEqual({ session: 4, revision: 4, turns: 1 });
    connection.socket!.close(1000, "test_complete");
  });

  it("fails frozen, terminal, and unmigrated movement effects without consuming sequence", async () => {
    const input = ticketInput({ playerName: "MoveClosedHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = await seedMovementState(input, [{ x: 1, y: 1 }, { x: 2, y: 1 }]);
    const move = () => {
      const response = nextJson(connection.socket!);
      connection.socket!.send(JSON.stringify({
        type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
      }));
      return response;
    };
    const setDestination = (
      tile: "#" | "." | ">" | "<" | "+" = ".",
      trap = 0,
      stairsDown = 0,
      itemPresent = 0,
      roomEffect = 0,
    ) => runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE floor_cells SET tile = ?, trap = ?, stairs_down = ?,
           item_present = ?, room_effect = ? WHERE x = 2 AND y = 1`,
        tile, trap, stairsDown, itemPresent, roomEffect,
      );
    });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET transfer_frozen = 1 WHERE player_id = ?", input.playerId);
    });
    await expect(move()).resolves.toMatchObject({ code: "transfer_frozen" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sessions SET transfer_frozen = 0 WHERE player_id = ?", input.playerId);
      state.storage.sql.exec("UPDATE player_gameplay SET alive = 0 WHERE player_id = ?", input.playerId);
    });
    await expect(move()).resolves.toMatchObject({ code: "terminal_state" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE player_gameplay SET alive = 1 WHERE player_id = ?", input.playerId);
    });

    await setDestination("+");
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await setDestination(".", 1);
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await setDestination();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO monster_positions (monster_id, x, y, active) VALUES ('remote-monster', 70, 20, 1)",
      );
    });
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM monster_positions WHERE monster_id = 'remote-monster'");
    });
    await setDestination(".", 0, 0, 1);
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await setDestination(".", 0, 0, 0, 1);
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await setDestination(">", 0, 1);
    await expect(move()).resolves.toMatchObject({ code: "edge_movement_effect_not_migrated" });
    await setDestination();
    await expect(move()).resolves.toMatchObject({
      type: "ack", clientSeq: 1, outcome: "moved", position: { x: 2, y: 1 },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        sequence: state.storage.sql.exec<{ last_client_seq: number }>(
          "SELECT last_client_seq FROM sessions WHERE player_id = ?", input.playerId,
        ).one().last_client_seq,
        receipts: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM processed_commands WHERE player_id = ?", input.playerId,
        ).one().count,
      })),
    ).resolves.toEqual({ sequence: 1, receipts: 1 });
    connection.socket!.close(1000, "test_complete");
  });

  it("rolls back position, vitals, revision, sequence, and receipt on injected SQL failure", async () => {
    const input = ticketInput({ playerName: "MoveRollbackHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = await seedMovementState(input, [{ x: 1, y: 1 }, { x: 2, y: 1 }]);
    const snapshot = () => runInDurableObject(stub, (_instance, state) => ({
      position: state.storage.sql.exec<{ x: number; y: number; updated_revision: number }>(
        "SELECT x, y, updated_revision FROM player_positions WHERE player_id = ?", input.playerId,
      ).one(),
      gameplay: state.storage.sql.exec<{ turns: number; hunger: number }>(
        "SELECT turns, hunger FROM player_gameplay WHERE player_id = ?", input.playerId,
      ).one(),
      revision: state.storage.sql.exec<{ revision: number }>(
        "SELECT revision FROM floor_meta WHERE singleton = 1",
      ).one().revision,
      sequence: state.storage.sql.exec<{ last_client_seq: number }>(
        "SELECT last_client_seq FROM sessions WHERE player_id = ?", input.playerId,
      ).one().last_client_seq,
      receipts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM processed_commands WHERE player_id = ?", input.playerId,
      ).one().count,
    }));
    const before = await snapshot();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER inject_move_receipt_failure
        BEFORE INSERT ON processed_commands
        WHEN NEW.request_hash LIKE 'input:move:v1:%'
        BEGIN SELECT RAISE(ABORT, 'injected_move_receipt_failure'); END;
      `);
    });
    let response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
    }));
    await expect(response).resolves.toMatchObject({ code: "movement_commit_failed", retryable: true });
    await expect(snapshot()).resolves.toEqual(before);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER inject_move_receipt_failure");
    });
    response = nextJson(connection.socket!);
    connection.socket!.send(JSON.stringify({
      type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
    }));
    await expect(response).resolves.toMatchObject({ type: "ack", outcome: "moved" });
    connection.socket!.close(1000, "test_complete");
  });

  it("rejects corrupt movement state without consuming the retry sequence", async () => {
    const input = ticketInput({ playerName: "MoveCorruptHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = await seedMovementState(input, [{ x: 1, y: 1 }, { x: 2, y: 1 }]);
    const move = () => {
      const response = nextJson(connection.socket!);
      connection.socket!.send(JSON.stringify({
        type: "input", command: "move", dx: 1, dy: 0, clientSeq: 1,
      }));
      return response;
    };

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE player_gameplay SET hunger_state = 'corrupt' WHERE player_id = ?",
        input.playerId,
      );
    });
    await expect(move()).resolves.toMatchObject({ code: "movement_state_corrupt" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE player_gameplay SET hunger_state = 'satiated' WHERE player_id = ?",
        input.playerId,
      );
      state.storage.sql.exec("UPDATE floor_meta SET revision = ? WHERE singleton = 1", Number.MAX_SAFE_INTEGER);
    });
    await expect(move()).resolves.toMatchObject({ code: "movement_state_corrupt" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE floor_meta SET revision = 0 WHERE singleton = 1");
      state.storage.sql.exec("DELETE FROM floor_cells WHERE x = 1 AND y = 1");
    });
    await expect(move()).resolves.toMatchObject({ code: "movement_state_unavailable" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO floor_cells
           (x, y, tile, trap, stairs_down, item_present, room_effect)
         VALUES (1, 1, '.', 0, 0, 0, 0)`,
      );
    });
    await expect(move()).resolves.toMatchObject({
      type: "ack", clientSeq: 1, outcome: "moved", position: { x: 2, y: 1 },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        sequence: state.storage.sql.exec<{ last_client_seq: number }>(
          "SELECT last_client_seq FROM sessions WHERE player_id = ?", input.playerId,
        ).one().last_client_seq,
        receipts: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM processed_commands WHERE player_id = ?", input.playerId,
        ).one().count,
      })),
    ).resolves.toEqual({ sequence: 1, receipts: 1 });
    connection.socket!.close(1000, "test_complete");
  });

  it("keeps position-backed players out of the legacy transfer handoff", async () => {
    const input = ticketInput({ playerName: "MoveXferFence" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);
    const stub = await seedMovementState(input, [{ x: 1, y: 1 }]);
    const connectionId = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ connection_id: string }>(
        "SELECT connection_id FROM sessions WHERE player_id = ?", input.playerId,
      ).one().connection_id,
    );
    await expect(stub.freezeSessionForTransfer({
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
    })).resolves.toMatchObject({ ok: false, code: "handoff_unavailable" });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        frozen: state.storage.sql.exec<{ transfer_frozen: number }>(
          "SELECT transfer_frozen FROM sessions WHERE player_id = ?", input.playerId,
        ).one().transfer_frozen,
        exports: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM transfer_exports",
        ).one().count,
        position: state.storage.sql.exec<{ x: number; y: number }>(
          "SELECT x, y FROM player_positions WHERE player_id = ?", input.playerId,
        ).one(),
      })),
    ).resolves.toEqual({ frozen: 0, exports: 0, position: { x: 1, y: 1 } });
    connection.socket!.close(1000, "test_complete");
  });

  it("fails closed before mutating a future FloorInstance schema", async () => {
    const input = ticketInput({ playerName: "FutureFloorHero" });
    const first = await connect(input);
    await nextJson(first.socket!);
    const firstClose = nextClose(first.socket!);
    first.socket!.close(1000, "future_schema_seeded");
    await firstClose;
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));
    const before = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (999, unixepoch())",
      );
      state.storage.sql.exec(
        "CREATE TABLE future_floor_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      );
      state.storage.sql.exec(
        "INSERT INTO future_floor_sentinel (id, value) VALUES (1, 'preserve-me')",
      );
      return {
        schema: state.storage.sql.exec<{
          type: string;
          name: string;
          tbl_name: string;
          sql: string | null;
        }>(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           ORDER BY type, name, tbl_name`,
        ).toArray(),
        sentinel: state.storage.sql.exec<{ id: number; value: string }>(
          "SELECT id, value FROM future_floor_sentinel ORDER BY id",
        ).toArray(),
        versions: state.storage.sql.exec<{ version: number }>(
          "SELECT version FROM _sql_schema_migrations ORDER BY version",
        ).toArray().map((row) => row.version),
      };
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const rejected = await connect({ ...input, jti: crypto.randomUUID() });
    expect(rejected.response.status).toBe(503);
    await expect(rejected.response.json()).resolves.toEqual({
      error: "floor_schema_incompatible", retryable: false,
    });
    await runDurableObjectAlarm(stub);
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        schema: state.storage.sql.exec<{
          type: string;
          name: string;
          tbl_name: string;
          sql: string | null;
        }>(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           ORDER BY type, name, tbl_name`,
        ).toArray(),
        sentinel: state.storage.sql.exec<{ id: number; value: string }>(
          "SELECT id, value FROM future_floor_sentinel ORDER BY id",
        ).toArray(),
        versions: state.storage.sql.exec<{ version: number }>(
          "SELECT version FROM _sql_schema_migrations ORDER BY version",
        ).toArray().map((row) => row.version),
      })),
    ).resolves.toEqual(before);
  });

  it("rolls back a failed FloorInstance schema migration atomically", async () => {
    const input = ticketInput({ playerName: "FloorMigration" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    const close = nextClose(connection.socket!);
    connection.socket!.close(1000, "migration_injection");
    await close;
    const stub = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(input));

    const migration = await runInDurableObject(stub, (instance, state) => {
        state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 7");
        state.storage.sql.exec("DROP INDEX floor_cells_spawn_rank");
        state.storage.sql.exec(`
          CREATE TRIGGER inject_floor_schema_failure
          BEFORE INSERT ON _sql_schema_migrations
          WHEN NEW.version = 7
          BEGIN SELECT RAISE(ABORT, 'injected_floor_schema_failure'); END;
        `);
        const snapshot = () => ({
          schema: state.storage.sql.exec<{ type: string; name: string; sql: string | null }>(
            "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name",
          ).toArray(),
          versions: state.storage.sql.exec<{ version: number }>(
            "SELECT version FROM _sql_schema_migrations ORDER BY version",
          ).toArray().map((row) => row.version),
        });
        const before = snapshot();
        let error = "";
        try {
          (instance as unknown as { initializeSchema(): boolean }).initializeSchema();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      return { before, after: snapshot(), error };
    });
    expect(migration.error).toContain("injected_floor_schema_failure");
    expect(migration.after).toEqual(migration.before);
    const result = await runInDurableObject(stub, (_instance, state) => ({
      hasSpawnIndex: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'index' AND name = 'floor_cells_spawn_rank'`,
      ).one().count,
      versions: state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations ORDER BY version",
      ).toArray().map((row) => row.version),
    }));
    expect(result).toEqual({ hasSpawnIndex: 0, versions: [1, 2, 3, 4, 5, 6] });
  });

  it("keeps the same hibernating socket usable across object eviction", async () => {
    const input = ticketInput({ playerName: "HibernateHero" });
    const connection = await connect(input);
    await nextJson(connection.socket!);
    await join(connection.socket!, input.playerName);

    const runtimeEnv = env as Env;
    const stub = runtimeEnv.FLOOR_INSTANCES.get(
      runtimeEnv.FLOOR_INSTANCES.idFromName(floorObjectName(input)),
    );
    await evictDurableObject(stub);

    connection.socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ type: "pong", online: 1 });
    connection.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({
      type: "ack",
      clientSeq: 1,
      serverRevision: 1,
    });
    connection.socket!.close(1000, "test_complete");
  });

  it("fences an older session epoch without disturbing the current socket", async () => {
    const playerId = crypto.randomUUID();
    const realmId = `fence-${crypto.randomUUID().slice(0, 8)}`;
    const currentInput = ticketInput({
      playerId,
      playerName: "FenceHero",
      realmId,
      sessionEpoch: 2,
    });
    const current = await connect(currentInput);
    await nextJson(current.socket!);
    await join(current.socket!, currentInput.playerName);

    const stale = await connect({ ...currentInput, sessionEpoch: 1, jti: crypto.randomUUID() });
    expect(stale.response.status).toBe(409);
    expect(stale.socket).toBeUndefined();

    current.socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(current.socket!)).resolves.toMatchObject({ type: "pong" });
    current.socket!.close(1000, "test_complete");
  });

  it("supersedes the old socket and fences delayed messages from it", async () => {
    const input = ticketInput({ playerName: "ReconnectHero" });
    const original = await connect(input);
    await nextJson(original.socket!);
    await join(original.socket!, input.playerName);

    const replacement = await connect({ ...input, jti: crypto.randomUUID() });
    await nextJson(replacement.socket!);
    original.socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(original.socket!)).resolves.toMatchObject({ type: "pong" });

    const originalClose = nextClose(original.socket!);
    await join(replacement.socket!, input.playerName);
    await expect(originalClose).resolves.toMatchObject({ code: 4001, reason: "superseded" });
    replacement.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(replacement.socket!)).resolves.toMatchObject({ type: "ack", clientSeq: 1 });
    replacement.socket!.close(1000, "test_complete");
  });

  it("collapses opposite-case signed UUID aliases into one fenced Floor session", async () => {
    const playerId = "a0b1c2d3-e4f5-4a67-8b90-a1b2c3d4e5f6";
    const leaseId = "f0e1d2c3-b4a5-4987-8a10-f1e2d3c4b5a6";
    const firstInput = ticketInput({ playerId, leaseId, playerName: "CaseFence" });
    const first = await connect(firstInput);
    await nextJson(first.socket!);
    await join(first.socket!, firstInput.playerName);

    const aliasInput = ticketInput({
      ...firstInput,
      playerId: playerId.toUpperCase(),
      leaseId: leaseId.toUpperCase(),
      jti: crypto.randomUUID(),
    });
    const alias = await connect(aliasInput);
    await nextJson(alias.socket!);
    const firstClose = nextClose(first.socket!);
    await expect(join(alias.socket!, aliasInput.playerName)).resolves.toMatchObject({
      type: "edge_joined",
      playerId,
      expectedClientSeq: 1,
    });
    await expect(firstClose).resolves.toMatchObject({ code: 4001, reason: "superseded" });

    alias.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(alias.socket!)).resolves.toMatchObject({
      type: "ack",
      clientSeq: 1,
      serverRevision: 1,
    });
    const floor = (env as Env).FLOOR_INSTANCES.getByName(floorObjectName(firstInput));
    await expect(
      runInDurableObject(floor, (_instance, state) =>
        state.storage.sql
          .exec<{ player_id: string }>("SELECT player_id FROM sessions")
          .toArray()
          .map((row) => row.player_id),
      ),
    ).resolves.toEqual([playerId]);
    alias.socket!.close(1000, "test_complete");
  });

  it("rejects cross-floor activation until a durable transfer is committed", async () => {
    const playerId = crypto.randomUUID();
    const firstInput = ticketInput({
      playerId,
      playerName: "GlobalFenceHero",
      realmId: `global-a-${crypto.randomUUID().slice(0, 8)}`,
      depth: 2,
      sessionEpoch: 1,
    });
    const first = await connect(firstInput);
    await nextJson(first.socket!);
    await join(first.socket!, firstInput.playerName);

    const secondInput = ticketInput({
      ...firstInput,
      realmId: `global-b-${crypto.randomUUID().slice(0, 8)}`,
      depth: 3,
      sessionEpoch: 2,
      jti: crypto.randomUUID(),
    });
    const second = await connect(secondInput);
    await nextJson(second.socket!);
    const secondClose = nextClose(second.socket!);
    await expect(join(second.socket!, secondInput.playerName)).resolves.toMatchObject({
      type: "error",
      code: "takeover_required",
      retryable: false,
    });
    await expect(secondClose).resolves.toMatchObject({
      code: 4002,
      reason: "takeover_required",
    });
    first.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(first.socket!)).resolves.toMatchObject({ type: "ack", clientSeq: 1 });
    first.socket!.close(1000, "test_complete");
  });

  it("rejects a full floor with explicit reroute metadata and no partial upgrade", async () => {
    const realmId = `capacity-${crypto.randomUUID().slice(0, 8)}`;
    const base = { realmId, depth: 3, floorEpoch: 1 };
    const first = await connect(ticketInput({ ...base, playerName: "CapHeroA" }));
    await nextJson(first.socket!);
    await join(first.socket!, "CapHeroA");
    const second = await connect(ticketInput({ ...base, playerName: "CapHeroB" }));
    await nextJson(second.socket!);
    await join(second.socket!, "CapHeroB");

    const third = await connect(ticketInput({ ...base, playerName: "CapHeroC" }));
    expect(third.response.status).toBe(503);
    expect(third.response.headers.get("Retry-After")).toBe("3");
    expect(third.socket).toBeUndefined();
    await expect(third.response.json()).resolves.toMatchObject({
      error: "floor_at_capacity",
      retryable: true,
      requiresFreshAssignment: true,
    });

    first.socket!.close(1000, "test_complete");
    second.socket!.close(1000, "test_complete");
  });

  it("requires a new floor epoch before durable session tombstones can grow unbounded", async () => {
    const realmId = `retire-${crypto.randomUUID().slice(0, 8)}`;
    const floor = { realmId, floorInstanceId: "primary", depth: 4, floorEpoch: 1 };
    for (const playerName of ["RetireHeroA", "RetireHeroB", "RetireHeroC"]) {
      const connection = await connect(ticketInput({ ...floor, playerName }));
      await nextJson(connection.socket!);
      await join(connection.socket!, playerName);
      const close = nextClose(connection.socket!);
      connection.socket!.close(1000, "session_recorded");
      await close;
    }

    const overflow = await connect(ticketInput({ ...floor, playerName: "RetireHeroD" }));
    expect(overflow.response.status).toBe(503);
    expect(overflow.socket).toBeUndefined();
    await expect(overflow.response.json()).resolves.toMatchObject({
      error: "floor_epoch_retirement_required",
      retryable: true,
      requiresFreshAssignment: true,
    });
  });

  it("enforces the UTF-8 byte limit before parsing and survives malformed frames", async () => {
    const input = ticketInput({ playerName: "FrameHero" });
    const malformed = await connect(input);
    await nextJson(malformed.socket!);
    malformed.socket!.send("{");
    await expect(nextJson(malformed.socket!)).resolves.toMatchObject({
      type: "error",
      code: "malformed_json",
    });
    malformed.socket!.send(JSON.stringify({ type: "ping" }));
    await expect(nextJson(malformed.socket!)).resolves.toMatchObject({ type: "pong" });
    const malformedClose = nextClose(malformed.socket!);
    malformed.socket!.close(1000, "malformed_proved");
    await malformedClose;

    const oversized = await connect({ ...input, jti: crypto.randomUUID() });
    await nextJson(oversized.socket!);
    const close = nextClose(oversized.socket!);
    oversized.socket!.send(JSON.stringify({ type: "unknown", pad: "🙂".repeat(2_100) }));
    await expect(close).resolves.toMatchObject({ code: 1009, reason: "message_too_large" });
  });

  it("accepts an exact 8 KiB text frame, rejects binary, and rate-limits before parsing", async () => {
    const exactInput = ticketInput({ playerName: "ExactFrameHero" });
    const exact = await connect(exactInput);
    await nextJson(exact.socket!);
    const prefix = '{"type":"unknown","padding":"';
    const suffix = '"}';
    const frame = `${prefix}${"a".repeat(MAX_INBOUND_FRAME_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(frame).byteLength).toBe(MAX_INBOUND_FRAME_BYTES);
    exact.socket!.send(frame);
    await expect(nextJson(exact.socket!)).resolves.toMatchObject({
      type: "error",
      code: "join_required",
    });
    const exactClose = nextClose(exact.socket!);
    exact.socket!.close(1000, "boundary_proved");
    await exactClose;

    const binary = await connect(ticketInput({ playerName: "BinaryHero" }));
    await nextJson(binary.socket!);
    const binaryClose = nextClose(binary.socket!);
    binary.socket!.send(new TextEncoder().encode('{"type":"ping"}').buffer);
    await expect(binaryClose).resolves.toMatchObject({ code: 1003, reason: "text_frames_only" });

    const limited = await connect(ticketInput({ playerName: "RateHero" }));
    await nextJson(limited.socket!);
    const rateClose = nextClose(limited.socket!);
    for (let index = 0; index < 11; index += 1) limited.socket!.send("{");
    await expect(rateClose).resolves.toMatchObject({
      code: 4008,
      reason: "message_rate_exceeded",
    });
  });

  it("bounds synchronized traffic with a floor-wide token bucket", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const realmId = `budget-${crypto.randomUUID().slice(0, 8)}`;
    const first = await connect(ticketInput({ realmId, playerName: "BudgetHeroA" }));
    await nextJson(first.socket!);
    const second = await connect(ticketInput({ realmId, playerName: "BudgetHeroB" }));
    await nextJson(second.socket!);

    const close = nextClose(second.socket!);
    for (let index = 0; index < 8; index += 1) {
      first.socket!.send(JSON.stringify({ type: "ping" }));
    }
    for (let index = 0; index < 8; index += 1) {
      second.socket!.send(JSON.stringify({ type: "ping" }));
    }
    await expect(close).resolves.toMatchObject({ code: 1013, reason: "floor_overloaded" });
    first.socket!.close(1000, "test_complete");
  });

  it("expires an unjoined reservation and keeps a second pending ticket out", async () => {
    const input = ticketInput({
      playerName: "PendingHero",
      expiresAt: Math.floor(Date.now() / 1_000) + 2,
    });
    const pending = await connect(input);
    await nextJson(pending.socket!);

    const second = await connect({ ...input, jti: crypto.randomUUID(), expiresAt: input.expiresAt });
    expect(second.response.status).toBe(409);
    await expect(second.response.json()).resolves.toMatchObject({
      error: "connection_attempt_pending",
    });

    const close = nextClose(pending.socket!);
    await expect(close).resolves.toMatchObject({
      code: 4003,
      reason: "join_deadline_expired",
    });
  });

  it("lets a higher session epoch supersede a lost pending upgrade", async () => {
    const input = ticketInput({ playerName: "PendRecover" });
    const orphaned = await connect(input);
    await nextJson(orphaned.socket!);

    const sameEpoch = await connect({ ...input, jti: crypto.randomUUID() });
    expect(sameEpoch.response.status).toBe(409);
    await expect(sameEpoch.response.json()).resolves.toMatchObject({
      error: "connection_attempt_pending",
    });

    const orphanedClose = nextClose(orphaned.socket!);
    const replacement = await connect({
      ...input,
      sessionEpoch: input.sessionEpoch + 1,
      jti: crypto.randomUUID(),
    });
    expect(replacement.response.status).toBe(101);
    await nextJson(replacement.socket!);
    await expect(orphanedClose).resolves.toMatchObject({
      code: 4001,
      reason: "superseded_pending_attempt",
    });
    await expect(join(replacement.socket!, input.playerName)).resolves.toMatchObject({
      type: "edge_joined",
      sessionEpoch: input.sessionEpoch + 1,
    });
    replacement.socket!.close(1000, "test_complete");
  });

  it("runs alarm cleanup at the pending deadline and releases socket capacity", async () => {
    const input = ticketInput({ playerName: "AlarmPendingHero" });
    const pending = await connect(input);
    await nextJson(pending.socket!);
    const runtimeEnv = env as Env;
    const stub = runtimeEnv.FLOOR_INSTANCES.get(
      runtimeEnv.FLOOR_INSTANCES.idFromName(floorObjectName(input)),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const expiredAt = Math.floor(Date.now() / 1_000) - 1;
      for (const socket of state.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as Record<string, unknown>;
        attachment.expiresAt = expiredAt;
        socket.serializeAttachment(attachment);
      }
      state.storage.sql.exec("UPDATE route_tickets SET expires_at = ?", expiredAt);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const close = nextClose(pending.socket!);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(close).resolves.toMatchObject({ code: 4003, reason: "join_deadline_expired" });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const rows = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM route_tickets")
          .toArray();
        return rows[0]?.count;
      }),
    ).resolves.toBe(0);

    const next = await connect(
      ticketInput({
        playerName: "AlarmCapHero",
        realmId: input.realmId,
        floorInstanceId: input.floorInstanceId,
        depth: input.depth,
        floorEpoch: input.floorEpoch,
      }),
    );
    expect(next.response.status).toBe(101);
    await nextJson(next.socket!);
    next.socket!.close(1000, "test_complete");
  });

  it("expires a post-commit recovery socket at replay grace without stranding state", async () => {
    const input = ticketInput({ playerName: "AlarmRecover" });
    const recovery = await connect(input);
    await nextJson(recovery.socket!);
    const runtimeEnv = env as Env;
    const stub = runtimeEnv.FLOOR_INSTANCES.get(
      runtimeEnv.FLOOR_INSTANCES.idFromName(floorObjectName(input)),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const attachment = state.getWebSockets()[0]?.deserializeAttachment() as
        | Record<string, unknown>
        | undefined;
      if (!attachment) throw new Error("missing recovery socket attachment");
      const expiredAt = Math.floor(Date.now() / 1_000) - 601;
      attachment.expiresAt = expiredAt;
      state.getWebSockets()[0]!.serializeAttachment(attachment);
      state.storage.sql.exec(
        "UPDATE route_tickets SET status = 'active', expires_at = ? WHERE jti = ?",
        expiredAt,
        String(attachment.ticketId),
      );
      state.storage.sql.exec(
        `INSERT INTO sessions
           (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
            connection_id, updated_at, disconnected_at)
         VALUES (?, ?, ?, ?, 0, ?, unixepoch(), NULL)`,
        String(attachment.playerId),
        Number(attachment.sessionEpoch),
        Number(attachment.authorityEpoch),
        String(attachment.leaseId),
        String(attachment.connectionId),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const close = nextClose(recovery.socket!);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(close).resolves.toMatchObject({ code: 4003, reason: "join_deadline_expired" });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const tickets = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM route_tickets")
          .toArray()[0]?.count;
        const session = state.storage.sql
          .exec<{ disconnected_at: number | null }>(
            "SELECT disconnected_at FROM sessions WHERE player_id = ?",
            input.playerId,
          )
          .toArray()[0];
        return { tickets, disconnected: typeof session?.disconnected_at === "number" };
      }),
    ).resolves.toEqual({ tickets: 0, disconnected: true });
  });

  it("never silently consumes legacy gameplay before reducer migration", async () => {
    const input = ticketInput({ playerName: "MigrationHero" });
    const { socket } = await connect(input);
    await nextJson(socket!);
    await join(socket!, input.playerName);
    socket!.send(JSON.stringify({ type: "input", key: "h", clientSeq: 1 }));
    await expect(nextJson(socket!)).resolves.toMatchObject({
      type: "error",
      code: "edge_gameplay_not_migrated",
      retryable: false,
    });
    socket!.close(1000, "test_complete");
  });
});
