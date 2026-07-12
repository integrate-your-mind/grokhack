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
    await expect(nextJson(connection.socket!)).resolves.toMatchObject({ code: "edge_gameplay_not_migrated" });
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
