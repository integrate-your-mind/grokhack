import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import type { FloorTransferRequest } from "../src/floor-instance";
import {
  deriveSourceAuthorityToken,
  deriveTargetControlToken,
} from "../src/player-session";
import { floorObjectName, playerSessionObjectName } from "../src/protocol";
import {
  authorityJoinRequest,
  connect,
  join,
  nextClose,
  nextJson,
  testTicketClaims,
  ticketInput,
} from "./helpers";

function floorStub(input: ReturnType<typeof ticketInput>) {
  const runtimeEnv = env as Env;
  return runtimeEnv.FLOOR_INSTANCES.getByName(floorObjectName(input));
}

function authorityStub(playerId: string) {
  return (env as Env).PLAYER_SESSIONS.getByName(playerSessionObjectName("test", playerId));
}

async function floorConnection(
  stub: ReturnType<typeof floorStub>,
  playerId: string,
): Promise<string> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ connection_id: string }>(
        "SELECT connection_id FROM sessions WHERE player_id = ?",
        playerId,
      )
      .toArray()[0];
    if (!row) throw new Error("missing floor session");
    return row.connection_id;
  });
}

function sourceTransferRequest(
  input: ReturnType<typeof ticketInput>,
  connectionId: string,
  transferId: string,
  operationId = crypto.randomUUID(),
): FloorTransferRequest {
  return {
    playerId: input.playerId,
    sessionEpoch: input.sessionEpoch,
    authorityEpoch: input.authorityEpoch,
    leaseId: input.leaseId,
    floorObjectName: floorObjectName(input),
    connectionId,
    transferId,
    operationId,
  };
}

describe("PlayerSession transfer and takeover saga", () => {
  it("refuses a central freeze unless the exact source Floor is already frozen", async () => {
    const input = ticketInput({ playerName: "NoSourceFreeze", resumeProofHash: "1".repeat(64) });
    const connectionId = crypto.randomUUID();
    const authority = authorityStub(input.playerId);
    await expect(
      authority.authorizeJoin(await authorityJoinRequest(input, connectionId)),
    ).resolves.toMatchObject({ ok: true, version: 1 });

    await expect(
      authority.freezeTransfer({
        environment: "test",
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: floorObjectName(input),
        connectionId,
        transferId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: false, code: "source_not_frozen" });
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      version: 1,
      transfer: null,
    });
  });

  it("reconstructs the source authority capability after the bind-before-persist crash window", async () => {
    const input = ticketInput({ playerName: "BindRecovery", resumeProofHash: "5".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const connectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    await sourceFloor.freezeSessionForTransfer(
      sourceTransferRequest(input, connectionId, transferId),
    );
    const freezeRequest = {
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    } as const;
    const authorityToken = await deriveSourceAuthorityToken(freezeRequest);
    await expect(
      sourceFloor.bindFrozenTransfer({ ...freezeRequest, authorityToken }),
    ).resolves.toMatchObject({ ok: true, phase: "frozen" });
    await evictDurableObject(sourceFloor);

    const authority = authorityStub(input.playerId);
    await expect(authority.freezeTransfer(freezeRequest)).resolves.toMatchObject({
      ok: true,
      phase: "frozen",
      version: 2,
    });
    await expect(
      authority.abortTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "aborted", version: 4 });
    connected.socket!.close(1000, "test_complete");
  });

  it("coalesces concurrent equivalent source freezes without releasing the adopted capability", async () => {
    const input = ticketInput({ playerName: "FreezeRace", resumeProofHash: "8".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const connectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    await sourceFloor.freezeSessionForTransfer(
      sourceTransferRequest(input, connectionId, transferId),
    );
    const authority = authorityStub(input.playerId);
    const baseFreeze = {
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId,
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    } as const;
    const [first, second] = await Promise.all([
      authority.freezeTransfer({ ...baseFreeze, operationId: crypto.randomUUID() }),
      authority.freezeTransfer({ ...baseFreeze, operationId: crypto.randomUUID() }),
    ]);
    expect(first).toMatchObject({ ok: true, phase: "frozen", version: 2 });
    expect(second).toMatchObject({ ok: true, phase: "frozen", version: 2 });
    await expect(
      authority.abortTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "aborted", version: 4 });
    connected.socket!.close(1000, "test_complete");
  });

  it("reconstructs the target control capability after the prepare-before-persist crash window", async () => {
    const input = ticketInput({ playerName: "PrepareRecovery", resumeProofHash: "6".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const connectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    const sourceFreeze = await sourceFloor.freezeSessionForTransfer(
      sourceTransferRequest(input, connectionId, transferId),
    );
    if (!sourceFreeze.ok || sourceFreeze.phase !== "frozen") throw new Error("source freeze failed");
    const authority = authorityStub(input.playerId);
    await authority.freezeTransfer({
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    });
    const targetInput = ticketInput({
      ...input,
      realmId: `prepare-recovery-${crypto.randomUUID().slice(0, 8)}`,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    const prepareRequest = {
      environment: "test",
      playerId: input.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 2,
      resumeProofHash: input.resumeProofHash,
      target: {
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        locationHint: targetInput.locationHint,
      },
    } as const;
    const targetFloor = floorStub(targetInput);
    await expect(
      targetFloor.prepareTransferImport({
        transferId,
        operationId: prepareRequest.operationId,
        playerId: input.playerId,
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        controlToken: await deriveTargetControlToken(prepareRequest),
        handoff: sourceFreeze.handoff,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "prepared" });
    await evictDurableObject(targetFloor);
    await evictDurableObject(authority);

    await expect(authority.prepareTransfer(prepareRequest)).resolves.toMatchObject({
      ok: true,
      phase: "prepared",
      version: 3,
    });
    await expect(
      authority.abortTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 3,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "aborted", version: 5 });
    connected.socket!.close(1000, "test_complete");
  });

  it("coalesces concurrent equivalent prepares without aborting the adopted destination", async () => {
    const input = ticketInput({ playerName: "PrepareRace", resumeProofHash: "7".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const connectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    await sourceFloor.freezeSessionForTransfer(
      sourceTransferRequest(input, connectionId, transferId),
    );
    const authority = authorityStub(input.playerId);
    await authority.freezeTransfer({
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    });
    const targetInput = ticketInput({
      ...input,
      realmId: `prepare-race-${crypto.randomUUID().slice(0, 8)}`,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    const basePrepare = {
      environment: "test",
      playerId: input.playerId,
      transferId,
      expectedVersion: 2,
      resumeProofHash: input.resumeProofHash,
      target: {
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        locationHint: targetInput.locationHint,
      },
    } as const;
    const [first, second] = await Promise.all([
      authority.prepareTransfer({ ...basePrepare, operationId: crypto.randomUUID() }),
      authority.prepareTransfer({ ...basePrepare, operationId: crypto.randomUUID() }),
    ]);
    expect(first).toMatchObject({ ok: true, phase: "prepared", version: 3 });
    expect(second).toMatchObject({ ok: true, phase: "prepared", version: 3 });
    await expect(
      runInDurableObject(floorStub(targetInput), (_instance, state) =>
        state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM transfer_preparations WHERE transfer_id = ?",
            transferId,
          )
          .toArray()[0]?.status,
      ),
    ).resolves.toBe("prepared");
    await authority.abortTransfer({
      environment: "test",
      playerId: input.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 3,
      resumeProofHash: input.resumeProofHash,
    });
    connected.socket!.close(1000, "test_complete");
  });

  it("keeps central authority frozen when the destination rejects preparation", async () => {
    const input = ticketInput({ playerName: "PrepareConflict", resumeProofHash: "2".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const sourceConnectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    await expect(
      sourceFloor.freezeSessionForTransfer(
        sourceTransferRequest(input, sourceConnectionId, transferId),
      ),
    ).resolves.toMatchObject({ ok: true, phase: "frozen" });
    const authority = authorityStub(input.playerId);
    await expect(
      authority.freezeTransfer({
        environment: "test",
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: floorObjectName(input),
        connectionId: sourceConnectionId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "frozen", version: 2 });

    const targetInput = ticketInput({
      ...input,
      realmId: `prepare-conflict-${crypto.randomUUID().slice(0, 8)}`,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    const targetFloor = floorStub(targetInput);
    await runInDurableObject(targetFloor, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sessions
           (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
            connection_id, updated_at, disconnected_at, transfer_frozen, transfer_id)
         VALUES (?, ?, ?, ?, 0, ?, unixepoch(), unixepoch(), 0, NULL)`,
        input.playerId,
        targetInput.sessionEpoch + 1,
        targetInput.authorityEpoch,
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
    });
    await expect(
      authority.prepareTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
        target: {
          sessionEpoch: targetInput.sessionEpoch,
          authorityEpoch: targetInput.authorityEpoch,
          leaseId: targetInput.leaseId,
          floorObjectName: floorObjectName(targetInput),
          locationHint: targetInput.locationHint,
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "target_prepare_failed" });
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      version: 2,
      floorObjectName: floorObjectName(input),
      transfer: { transferId, phase: "frozen" },
    });
    await expect(
      authority.commitTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: false, code: "transfer_not_prepared", version: 2 });
    await expect(
      authority.abortTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "aborted", version: 4 });
    connected.socket!.close(1000, "test_complete");
  });

  it("moves a live session across floors with exact phase retry and sequence/dedupe handoff", async () => {
    const resumeProofHash = "b".repeat(64);
    const sourceInput = ticketInput({
      playerId: crypto.randomUUID(),
      playerName: "TransferHero",
      realmId: `transfer-a-${crypto.randomUUID().slice(0, 8)}`,
      depth: 2,
      resumeProofHash,
    });
    const source = await connect(sourceInput);
    await nextJson(source.socket!);
    await join(source.socket!, sourceInput.playerName);
    source.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 1 }));
    const committedAtSource = await nextJson(source.socket!);
    expect(committedAtSource).toMatchObject({
      type: "ack",
      command: "wait",
      clientSeq: 1,
      state: { turns: 1, alive: true },
    });

    const sourceFloor = floorStub(sourceInput);
    const sourceConnectionId = await floorConnection(sourceFloor, sourceInput.playerId);
    const transferId = crypto.randomUUID();
    const sourceFreezeRequest = sourceTransferRequest(
      sourceInput,
      sourceConnectionId,
      transferId,
    );
    const sourceFreeze = await sourceFloor.freezeSessionForTransfer(sourceFreezeRequest);
    expect(sourceFreeze).toMatchObject({
      ok: true,
      phase: "frozen",
      handoff: { lastClientSeq: 1, gameplay: { turns: 1, alive: true } },
    });
    if (!sourceFreeze.ok || sourceFreeze.phase !== "frozen") throw new Error("freeze failed");
    await evictDurableObject(sourceFloor);
    await expect(sourceFloor.freezeSessionForTransfer(sourceFreezeRequest)).resolves.toEqual(sourceFreeze);
    await expect(
      sourceFloor.freezeSessionForTransfer({
        ...sourceFreezeRequest,
        transferId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    source.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 1 }));
    expect(await nextJson(source.socket!)).toEqual(committedAtSource);
    source.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 2 }));
    await expect(nextJson(source.socket!)).resolves.toMatchObject({
      type: "error",
      code: "transfer_frozen",
    });

    const authority = authorityStub(sourceInput.playerId);
    const authoritySnapshot = await authority.getSnapshot();
    expect(authoritySnapshot).toMatchObject({ version: 1, resumeProofBound: true });
    const freezeRequest = {
      environment: "test",
      playerId: sourceInput.playerId,
      sessionEpoch: sourceInput.sessionEpoch,
      authorityEpoch: sourceInput.authorityEpoch,
      leaseId: sourceInput.leaseId,
      floorObjectName: floorObjectName(sourceInput),
      connectionId: sourceConnectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: authoritySnapshot!.version,
      resumeProofHash,
    } as const;
    const frozen = await authority.freezeTransfer(freezeRequest);
    expect(frozen).toMatchObject({ ok: true, phase: "frozen", version: 2 });
    await evictDurableObject(authority);
    await expect(authority.freezeTransfer(freezeRequest)).resolves.toEqual(frozen);
    await expect(
      authority.freezeTransfer({ ...freezeRequest, expectedVersion: 2 }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const targetInput = ticketInput({
      ...sourceInput,
      realmId: `transfer-b-${crypto.randomUUID().slice(0, 8)}`,
      depth: 3,
      authorityEpoch: sourceInput.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    const prepareRequest = {
      environment: "test",
      playerId: sourceInput.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 2,
      resumeProofHash,
      target: {
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        locationHint: targetInput.locationHint,
      },
    } as const;
    const prepared = await authority.prepareTransfer(prepareRequest);
    expect(prepared).toMatchObject({ ok: true, phase: "prepared", mode: "transfer", version: 3 });
    await evictDurableObject(floorStub(targetInput));
    await evictDurableObject(authority);
    await expect(authority.prepareTransfer(prepareRequest)).resolves.toEqual(prepared);
    await expect(
      authority.prepareTransfer({
        ...prepareRequest,
        target: { ...prepareRequest.target, leaseId: crypto.randomUUID() },
      }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const prematureTarget = await authorityJoinRequest({
      ...targetInput,
      jti: crypto.randomUUID(),
    });
    await expect(authority.authorizeJoin(prematureTarget)).resolves.toMatchObject({
      ok: false,
      code: "transfer_not_committed",
      version: 3,
    });

    const commitRequest = {
      environment: "test",
      playerId: sourceInput.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 3,
      resumeProofHash,
    } as const;
    const committed = await authority.commitTransfer(commitRequest);
    expect(committed).toMatchObject({ ok: true, phase: "committed", version: 4 });
    await evictDurableObject(authority);
    await expect(authority.commitTransfer(commitRequest)).resolves.toEqual(committed);
    await expect(
      authority.commitTransfer({ ...commitRequest, expectedVersion: 4 }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });
    await expect(
      authority.abortTransfer({
        ...commitRequest,
        operationId: crypto.randomUUID(),
        expectedVersion: 4,
      }),
    ).resolves.toMatchObject({ ok: false, code: "commit_irreversible", version: 4 });
    await expect(
      sourceFloor.abortFrozenTransfer({
        ...sourceFreezeRequest,
        operationId: crypto.randomUUID(),
        authorityToken: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });
    await expect(
      sourceFloor.finalizeFrozenTransfer({
        ...sourceFreezeRequest,
        operationId: crypto.randomUUID(),
        authorityToken: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const target = await connect(targetInput);
    await nextJson(target.socket!);
    const transferredSourceClose = nextClose(source.socket!);
    await expect(join(target.socket!, targetInput.playerName)).resolves.toMatchObject({
      type: "edge_joined",
      expectedClientSeq: 2,
      authorityEpoch: targetInput.authorityEpoch,
      leaseId: targetInput.leaseId,
    });
    const targetFloor = floorStub(targetInput);
    const targetConnectionId = await floorConnection(targetFloor, targetInput.playerId);
    const targetClaims = await testTicketClaims(target.ticket, targetInput);
    await evictDurableObject(authority);
    const activationRetry = await authority.activateTransfer({
      environment: "test",
      playerId: targetInput.playerId,
      sessionEpoch: targetInput.sessionEpoch,
      authorityEpoch: targetInput.authorityEpoch,
      leaseId: targetInput.leaseId,
      floorObjectName: floorObjectName(targetInput),
      transferId,
      operationId: `${targetInput.jti}-activate`,
      connectionId: targetConnectionId,
      expectedVersion: 5,
      resumeProofGrant: targetClaims.resumeProofGrant,
      keyId: targetClaims.kid,
      expiresAt: targetClaims.exp,
    });
    expect(activationRetry).toMatchObject({ ok: true, phase: "activated", version: 6 });
    await expect(
      authority.activateTransfer({
        environment: "test",
        playerId: targetInput.playerId,
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        transferId,
        operationId: `${targetInput.jti}-activate`,
        connectionId: crypto.randomUUID(),
        expectedVersion: 5,
        resumeProofGrant: targetClaims.resumeProofGrant,
        keyId: targetClaims.kid,
        expiresAt: targetClaims.exp,
      }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    target.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 1 }));
    expect(await nextJson(target.socket!)).toEqual(committedAtSource);
    target.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(target.socket!)).resolves.toMatchObject({ code: "idempotency_conflict" });
    target.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 3 }));
    await expect(nextJson(target.socket!)).resolves.toMatchObject({
      code: "client_sequence_gap",
      expectedClientSeq: 2,
    });

    await expect(transferredSourceClose).resolves.toMatchObject({
      code: 4001,
      reason: "transferred",
    });
    target.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 2 }));
    const committedAtTarget = await nextJson(target.socket!);
    expect(committedAtTarget).toMatchObject({
      type: "ack",
      clientSeq: 2,
      state: { turns: 2, alive: true },
    });
    await evictDurableObject(targetFloor);
    target.socket!.send(JSON.stringify({ type: "input", command: "wait", clientSeq: 2 }));
    expect(await nextJson(target.socket!)).toEqual(committedAtTarget);

    await expect(
      runInDurableObject(sourceFloor, (_instance, state) =>
        state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM transfer_exports WHERE transfer_id = ?",
            transferId,
          )
          .toArray()[0]?.status,
      ),
    ).resolves.toBe("finalized");
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      floorObjectName: floorObjectName(targetInput),
      authorityEpoch: targetInput.authorityEpoch,
      version: 6,
      transfer: {
        transferId,
        phase: "activated",
        mode: "transfer",
        cleanupStatus: "completed",
      },
    });
    target.socket!.close(1000, "test_complete");
  });

  it("aborts before commit and restores the exact frozen source authority", async () => {
    const input = ticketInput({ playerName: "AbortHero", resumeProofHash: "c".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const floor = floorStub(input);
    const connectionId = await floorConnection(floor, input.playerId);
    const transferId = crypto.randomUUID();
    const floorFreezeRequest = sourceTransferRequest(input, connectionId, transferId);
    const exported = await floor.freezeSessionForTransfer(floorFreezeRequest);
    if (!exported.ok || exported.phase !== "frozen") throw new Error("source freeze failed");
    const authority = authorityStub(input.playerId);
    const frozen = await authority.freezeTransfer({
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    });
    expect(frozen).toMatchObject({ ok: true, version: 2 });
    const targetFloorName = floorObjectName({ ...input, realmId: "abort-target" });
    const prepared = await authority.prepareTransfer({
      environment: "test",
      playerId: input.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 2,
      resumeProofHash: input.resumeProofHash,
      target: {
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch + 1,
        leaseId: crypto.randomUUID(),
        floorObjectName: targetFloorName,
        locationHint: input.locationHint,
      },
    });
    expect(prepared).toMatchObject({ ok: true, phase: "prepared", version: 3 });
    const abortRequest = {
      environment: "test",
      playerId: input.playerId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 3,
      resumeProofHash: input.resumeProofHash,
    } as const;
    const aborted = await authority.abortTransfer(abortRequest);
    expect(aborted).toMatchObject({ ok: true, phase: "aborted", version: 5 });
    await evictDurableObject(authority);
    await expect(authority.abortTransfer(abortRequest)).resolves.toEqual(aborted);
    await evictDurableObject(floor);

    connected.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    await expect(nextJson(connected.socket!)).resolves.toMatchObject({
      type: "ack",
      clientSeq: 1,
    });
    connected.socket!.close(1000, "test_complete");
  });

  it("resumes an in-progress abort from the durable alarm after eviction", async () => {
    const input = ticketInput({ playerName: "AbortRecovery", resumeProofHash: "3".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const sourceConnectionId = await floorConnection(sourceFloor, input.playerId);
    const transferId = crypto.randomUUID();
    await sourceFloor.freezeSessionForTransfer(
      sourceTransferRequest(input, sourceConnectionId, transferId),
    );
    const authority = authorityStub(input.playerId);
    await authority.freezeTransfer({
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId: sourceConnectionId,
      transferId,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    });
    const targetInput = ticketInput({
      ...input,
      realmId: `abort-recovery-${crypto.randomUUID().slice(0, 8)}`,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    await expect(
      authority.prepareTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
        target: {
          sessionEpoch: targetInput.sessionEpoch,
          authorityEpoch: targetInput.authorityEpoch,
          leaseId: targetInput.leaseId,
          floorObjectName: floorObjectName(targetInput),
          locationHint: targetInput.locationHint,
        },
      }),
    ).resolves.toMatchObject({ ok: true, phase: "prepared", version: 3 });

    const operationId = crypto.randomUUID();
    const abortRequest = {
      environment: "test",
      playerId: input.playerId,
      transferId,
      operationId,
      expectedVersion: 3,
      resumeProofHash: input.resumeProofHash,
    } as const;
    const abortRequestIdentity = JSON.stringify([
      "abort_transfer",
      abortRequest.environment,
      abortRequest.playerId.toLowerCase(),
      abortRequest.transferId.toLowerCase(),
      abortRequest.expectedVersion,
      abortRequest.resumeProofHash,
    ]);
    await runInDurableObject(authority, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE session_transfers SET abort_status = 'in_progress',
             abort_operation_id = ?, abort_request_hash = ?, updated_at = unixepoch()
         WHERE singleton = 1 AND transfer_id = ?`,
        operationId,
        abortRequestIdentity,
        transferId,
      );
      state.storage.sql.exec(
        "UPDATE session_state SET version = 4, updated_at = unixepoch() WHERE singleton = 1",
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(authority);
    await expect(runDurableObjectAlarm(authority)).resolves.toBe(true);
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      version: 5,
      floorObjectName: floorObjectName(input),
      transfer: { transferId, phase: "aborted", cleanupStatus: "completed" },
    });
    await expect(authority.abortTransfer(abortRequest)).resolves.toMatchObject({
      ok: true,
      phase: "aborted",
      version: 5,
    });
    await expect(
      runInDurableObject(sourceFloor, (_instance, state) =>
        state.storage.sql
          .exec<{ transfer_frozen: number }>(
            "SELECT transfer_frozen FROM sessions WHERE player_id = ?",
            input.playerId,
          )
          .toArray()[0]?.transfer_frozen,
      ),
    ).resolves.toBe(0);
    await expect(
      runInDurableObject(floorStub(targetInput), (_instance, state) =>
        state.storage.sql
          .exec<{ status: string }>(
            "SELECT status FROM transfer_preparations WHERE transfer_id = ?",
            transferId,
          )
          .toArray()[0]?.status,
      ),
    ).resolves.toBe("aborted");
    connected.socket!.close(1000, "test_complete");
  });

  it("performs a same-floor higher-session takeover without resetting dedupe state", async () => {
    const input = ticketInput({ playerName: "TakeoverHero", resumeProofHash: "9".repeat(64) });
    const original = await connect(input);
    await nextJson(original.socket!);
    await join(original.socket!, input.playerName);
    original.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    const firstAck = await nextJson(original.socket!);
    const floor = floorStub(input);
    const sourceConnectionId = await floorConnection(floor, input.playerId);
    const transferId = crypto.randomUUID();
    const sourceRequest = sourceTransferRequest(input, sourceConnectionId, transferId);
    const exported = await floor.freezeSessionForTransfer(sourceRequest);
    if (!exported.ok || exported.phase !== "frozen") throw new Error("source freeze failed");

    const authority = authorityStub(input.playerId);
    await expect(
      authority.freezeTransfer({
        environment: "test",
        playerId: input.playerId,
        sessionEpoch: input.sessionEpoch,
        authorityEpoch: input.authorityEpoch,
        leaseId: input.leaseId,
        floorObjectName: floorObjectName(input),
        connectionId: sourceConnectionId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "frozen", version: 2 });
    const takeoverInput = ticketInput({
      ...input,
      sessionEpoch: input.sessionEpoch + 1,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    await expect(
      authority.prepareTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash: input.resumeProofHash,
        target: {
          sessionEpoch: takeoverInput.sessionEpoch,
          authorityEpoch: takeoverInput.authorityEpoch,
          leaseId: takeoverInput.leaseId,
          floorObjectName: floorObjectName(takeoverInput),
          locationHint: takeoverInput.locationHint,
        },
      }),
    ).resolves.toMatchObject({ ok: true, phase: "prepared", mode: "takeover", version: 3 });
    await expect(
      authority.commitTransfer({
        environment: "test",
        playerId: input.playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 3,
        resumeProofHash: input.resumeProofHash,
      }),
    ).resolves.toMatchObject({ ok: true, phase: "committed", mode: "takeover", version: 4 });

    const takeover = await connect(takeoverInput);
    await nextJson(takeover.socket!);
    const originalClose = nextClose(original.socket!);
    await expect(join(takeover.socket!, takeoverInput.playerName)).resolves.toMatchObject({
      expectedClientSeq: 2,
      sessionEpoch: takeoverInput.sessionEpoch,
      authorityEpoch: takeoverInput.authorityEpoch,
    });
    await expect(originalClose).resolves.toMatchObject({ code: 4001, reason: "transferred" });
    takeover.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 1 }));
    expect(await nextJson(takeover.socket!)).toEqual(firstAck);
    takeover.socket!.send(JSON.stringify({ type: "slo_probe", clientSeq: 2 }));
    await expect(nextJson(takeover.socket!)).resolves.toMatchObject({
      type: "ack",
      clientSeq: 2,
    });
    await expect(
      runInDurableObject(floor, (_instance, state) =>
        state.storage.sql
          .exec<{
            session_epoch: number;
            authority_epoch: number;
            last_client_seq: number;
            transfer_frozen: number;
          }>(
            `SELECT session_epoch, authority_epoch, last_client_seq, transfer_frozen
             FROM sessions WHERE player_id = ?`,
            input.playerId,
          )
          .toArray()[0],
      ),
    ).resolves.toEqual({
      session_epoch: takeoverInput.sessionEpoch,
      authority_epoch: takeoverInput.authorityEpoch,
      last_client_seq: 2,
      transfer_frozen: 0,
    });
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      sessionEpoch: takeoverInput.sessionEpoch,
      authorityEpoch: takeoverInput.authorityEpoch,
      transfer: { transferId, phase: "activated", mode: "takeover" },
    });
    takeover.socket!.close(1000, "test_complete");
  });

  it("fails closed for wrong proof, terminal state, and corrupt or gapped handoffs", async () => {
    const input = ticketInput({ playerName: "FenceCases", resumeProofHash: "d".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const floor = floorStub(input);
    const connectionId = await floorConnection(floor, input.playerId);
    const authority = authorityStub(input.playerId);
    const base = {
      environment: "test",
      playerId: input.playerId,
      sessionEpoch: input.sessionEpoch,
      authorityEpoch: input.authorityEpoch,
      leaseId: input.leaseId,
      floorObjectName: floorObjectName(input),
      connectionId,
      transferId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: "e".repeat(64),
    } as const;
    await expect(authority.freezeTransfer(base)).resolves.toMatchObject({
      ok: false,
      code: "resume_proof_mismatch",
      version: 1,
    });
    const sourceOnlyFreeze = sourceTransferRequest(
      input,
      connectionId,
      crypto.randomUUID(),
    );
    await expect(floor.freezeSessionForTransfer(sourceOnlyFreeze)).resolves.toMatchObject({
      ok: true,
      phase: "frozen",
    });
    await expect(
      floor.cancelUnboundFreeze({ ...sourceOnlyFreeze, operationId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: true, phase: "aborted" });

    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO player_gameplay
           (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
         VALUES (?, 1, 998, 1000, 'satiated', 0, 0)`,
        input.playerId,
      );
    });
    await expect(
      floor.freezeSessionForTransfer(
        sourceTransferRequest(input, connectionId, crypto.randomUUID()),
      ),
    ).resolves.toMatchObject({ ok: false, code: "terminal_state" });
    connected.socket!.close(1000, "test_complete");
  });

  it("fails closed across invalid, missing, mismatched, released, and finalized source capabilities", async () => {
    const input = ticketInput({ playerName: "CapabilityCases", resumeProofHash: "a".repeat(64) });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const floor = floorStub(input);
    const connectionId = await floorConnection(floor, input.playerId);
    const transferId = crypto.randomUUID();
    const request = sourceTransferRequest(input, connectionId, transferId);
    await floor.freezeSessionForTransfer(request);
    const controlled = {
      ...request,
      operationId: crypto.randomUUID(),
      authorityToken: await deriveSourceAuthorityToken({
        ...request,
        resumeProofHash: input.resumeProofHash,
      }),
    };

    await expect(
      floor.releaseBoundTransfer({ ...controlled, authorityToken: "not-a-token" }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_request" });
    await expect(
      floor.releaseBoundTransfer({ ...controlled, transferId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: false, code: "transfer_id_mismatch" });
    await expect(floor.bindFrozenTransfer(controlled)).resolves.toMatchObject({
      ok: true,
      phase: "frozen",
    });
    await expect(
      floor.releaseBoundTransfer({ ...controlled, authorityToken: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });
    await expect(floor.releaseBoundTransfer(controlled)).resolves.toMatchObject({
      ok: true,
      phase: "frozen",
    });
    await expect(floor.bindFrozenTransfer(controlled)).resolves.toMatchObject({
      ok: true,
      phase: "frozen",
    });
    await expect(
      floor.finalizeFrozenTransfer({ ...controlled, operationId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: true, phase: "finalized" });
    await expect(floor.releaseBoundTransfer(controlled)).resolves.toMatchObject({
      ok: false,
      code: "commit_irreversible",
    });
  });

  it("expands an adjacent Floor schema before preparing a durable import", async () => {
    const input = ticketInput({ playerName: "FloorSchema" });
    const floor = floorStub(input);
    await runInDurableObject(floor, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE sessions");
      state.storage.sql.exec("DROP TABLE transfer_exports");
      state.storage.sql.exec("DROP TABLE transfer_preparations");
      state.storage.sql.exec("DROP TABLE floor_transfer_operations");
      state.storage.sql.exec(`CREATE TABLE sessions (
        player_id TEXT PRIMARY KEY,
        session_epoch INTEGER NOT NULL,
        last_client_seq INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        `INSERT INTO sessions
           (player_id, session_epoch, last_client_seq, connection_id, updated_at)
         VALUES (?, 1, 0, ?, unixepoch())`,
        input.playerId,
        crypto.randomUUID(),
      );
      state.storage.sql.exec(`CREATE TABLE transfer_exports (
        transfer_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        request_identity TEXT NOT NULL,
        response_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    });
    await evictDurableObject(floor);

    const transferId = crypto.randomUUID();
    await expect(
      floor.prepareTransferImport({
        transferId,
        operationId: crypto.randomUUID(),
        playerId: input.playerId,
        sessionEpoch: 2,
        authorityEpoch: 2,
        leaseId: crypto.randomUUID(),
        floorObjectName: floorObjectName(input),
        controlToken: crypto.randomUUID(),
        handoff: {
          v: 1,
          lastClientSeq: 0,
          receipts: [],
          gameplay: {
            turns: 0,
            hunger: 1000,
            maxHunger: 1000,
            hungerState: "satiated",
            hp: 20,
            alive: true,
          },
        },
      }),
    ).resolves.toMatchObject({ ok: true, transferId, phase: "prepared" });
    const migrated = await runInDurableObject(floor, (_instance, state) => ({
      sessionColumns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(sessions)")
        .toArray()
        .map((column) => column.name),
      exportColumns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(transfer_exports)")
        .toArray()
        .map((column) => column.name),
      preparationStatus: state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM transfer_preparations WHERE transfer_id = ?",
          transferId,
        )
        .toArray()[0]?.status,
    }));
    expect(migrated.sessionColumns).toEqual(
      expect.arrayContaining([
        "authority_epoch",
        "lease_id",
        "disconnected_at",
        "transfer_frozen",
        "transfer_id",
      ]),
    );
    expect(migrated.exportColumns).toContain("authority_token");
    expect(migrated.preparationStatus).toBe("prepared");
  });

  it("bounds durable transfer-operation receipts while retaining the newest exact retry", async () => {
    const input = ticketInput({ playerName: "ReceiptBound", resumeProofHash: "4".repeat(64) });
    const authority = authorityStub(input.playerId);
    await authority.authorizeJoin(await authorityJoinRequest(input));
    await runInDurableObject(authority, (_instance, state) => {
      for (let index = 0; index < 300; index++) {
        state.storage.sql.exec(
          `INSERT INTO session_operations
             (operation_id, operation_kind, transfer_id, request_hash, response_json,
              resulting_version, created_at)
           VALUES (?, 'commit_transfer', ?, ?, '{"ok":false,"code":"transfer_id_mismatch"}', 0, ?)`,
          `seed-${String(index).padStart(3, "0")}`,
          crypto.randomUUID(),
          `seed-request-${index}`,
          index,
        );
      }
    });
    const request = {
      environment: "test",
      playerId: input.playerId,
      transferId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      resumeProofHash: input.resumeProofHash,
    } as const;
    const first = await authority.commitTransfer(request);
    expect(first).toMatchObject({ ok: false, code: "transfer_id_mismatch", version: 1 });
    await expect(authority.commitTransfer(request)).resolves.toEqual(first);
    const retained = await runInDurableObject(authority, (_instance, state) => ({
      count: state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM session_operations WHERE transfer_id IS NOT NULL",
        )
        .toArray()[0]?.count,
      newest: state.storage.sql
        .exec<{ response_json: string }>(
          "SELECT response_json FROM session_operations WHERE operation_id = ?",
          request.operationId,
        )
        .toArray()[0]?.response_json,
    }));
    expect(retained.count).toBe(256);
    expect(JSON.parse(retained.newest)).toEqual(first);
  });

  it("bounds terminal Floor transfer artifacts while preserving the just-completed receipt", async () => {
    const input = ticketInput({ playerName: "FloorRetention" });
    const connected = await connect(input);
    await nextJson(connected.socket!);
    await join(connected.socket!, input.playerName);
    const sourceFloor = floorStub(input);
    const connectionId = await floorConnection(sourceFloor, input.playerId);
    const sourceTransfers: string[] = [];
    for (let index = 0; index < 5; index++) {
      const transferId = crypto.randomUUID();
      sourceTransfers.push(transferId);
      const request = sourceTransferRequest(input, connectionId, transferId);
      await expect(sourceFloor.freezeSessionForTransfer(request)).resolves.toMatchObject({
        ok: true,
        phase: "frozen",
      });
      await expect(
        sourceFloor.cancelUnboundFreeze({ ...request, operationId: crypto.randomUUID() }),
      ).resolves.toMatchObject({ ok: true, phase: "aborted" });
    }

    const targetInput = ticketInput({
      ...input,
      realmId: `retention-target-${crypto.randomUUID().slice(0, 8)}`,
      sessionEpoch: input.sessionEpoch + 1,
      authorityEpoch: input.authorityEpoch + 1,
      leaseId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });
    const targetFloor = floorStub(targetInput);
    const targetTransfers: string[] = [];
    for (let index = 0; index < 5; index++) {
      const transferId = crypto.randomUUID();
      targetTransfers.push(transferId);
      const request = {
        transferId,
        operationId: crypto.randomUUID(),
        playerId: input.playerId,
        sessionEpoch: targetInput.sessionEpoch,
        authorityEpoch: targetInput.authorityEpoch,
        leaseId: targetInput.leaseId,
        floorObjectName: floorObjectName(targetInput),
        controlToken: crypto.randomUUID(),
        handoff: {
          v: 1 as const,
          lastClientSeq: 0,
          receipts: [],
          gameplay: {
            turns: 0,
            hunger: 1000,
            maxHunger: 1000,
            hungerState: "satiated" as const,
            hp: 20,
            alive: true,
          },
        },
      };
      await expect(targetFloor.prepareTransferImport(request)).resolves.toMatchObject({
        ok: true,
        phase: "prepared",
      });
      await expect(targetFloor.abortPreparedTransferImport(request)).resolves.toMatchObject({
        ok: true,
        phase: "aborted",
      });
    }

    const sourceRetention = await runInDurableObject(sourceFloor, (_instance, state) => ({
      exports: state.storage.sql
        .exec<{ transfer_id: string }>("SELECT transfer_id FROM transfer_exports")
        .toArray()
        .map((row) => row.transfer_id),
      operations: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM floor_transfer_operations")
        .toArray()[0]?.count,
    }));
    const targetRetention = await runInDurableObject(targetFloor, (_instance, state) =>
      state.storage.sql
        .exec<{ transfer_id: string }>("SELECT transfer_id FROM transfer_preparations")
        .toArray()
        .map((row) => row.transfer_id),
    );
    expect(sourceRetention.exports).toHaveLength(3);
    expect(sourceRetention.exports).toContain(sourceTransfers.at(-1));
    expect(sourceRetention.operations).toBeLessThanOrEqual(12);
    expect(targetRetention).toHaveLength(3);
    expect(targetRetention).toContain(targetTransfers.at(-1));
    connected.socket!.close(1000, "test_complete");
  });

  it("migrates an adjacent PlayerSession schema and binds only the signed hash", async () => {
    const input = ticketInput({ playerName: "SchemaHero", resumeProofHash: "f".repeat(64) });
    const authority = authorityStub(input.playerId);
    const objectName = playerSessionObjectName("test", input.playerId);
    const floorName = floorObjectName(input);
    const connectionId = crypto.randomUUID();
    await runInDurableObject(authority, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE session_state");
      state.storage.sql.exec(`CREATE TABLE session_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_epoch INTEGER NOT NULL,
        authority_epoch INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        floor_object_name TEXT NOT NULL,
        location_hint TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO session_identity
           (singleton, object_name, environment, player_id) VALUES (1, ?, 'test', ?)`,
        objectName,
        input.playerId,
      );
      state.storage.sql.exec(
        `INSERT INTO session_state
           (singleton, session_epoch, authority_epoch, lease_id, floor_object_name,
            location_hint, connection_id, version, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, 7, unixepoch())`,
        input.sessionEpoch,
        input.authorityEpoch,
        input.leaseId,
        floorName,
        input.locationHint,
        connectionId,
      );
    });
    await evictDurableObject(authority);
    await expect(
      authority.authorizeJoin(await authorityJoinRequest(input, connectionId)),
    ).resolves.toMatchObject({ ok: true, decision: "same_route", version: 8 });
    await expect(authority.getSnapshot()).resolves.toMatchObject({
      playerId: input.playerId,
      floorObjectName: floorName,
      leaseId: input.leaseId,
      resumeProofBound: true,
      version: 8,
    });
    const persisted = await runInDurableObject(authority, (_instance, state) => {
      const stateRow = state.storage.sql
        .exec<{ resume_proof_hash: string }>(
          "SELECT resume_proof_hash FROM session_state WHERE singleton = 1",
        )
        .toArray()[0];
      const allText = state.storage.sql
        .exec<{ value: string }>(
          `SELECT resume_proof_hash AS value FROM session_state
           UNION ALL SELECT response_json AS value FROM session_operations`,
        )
        .toArray()
        .map((row) => row.value)
        .join("\n");
      return { hash: stateRow?.resume_proof_hash, allText };
    });
    expect(persisted.hash).toBe(input.resumeProofHash);
    expect(persisted.allText).not.toContain("raw-resume-proof");
  });
});
