import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import type { TransferHandoff } from "../src/player-session";
import { floorObjectName, playerSessionObjectName } from "../src/protocol";
import { authorityJoinRequest, ticketInput } from "./helpers";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("transfer state-machine properties", () => {
  it("keeps authority behind valid seeded phase prefixes and preserves arbitrary handoff cuts", async () => {
    const random = seededRandom(0x7a11_2026);
    const runtimeEnv = env as Env;

    for (let trial = 0; trial < 12; trial++) {
      const playerId = crypto.randomUUID();
      const resumeProofHash = (trial + 1).toString(16).padStart(64, "0");
      const sourceLease = crypto.randomUUID();
      const sourceConnection = crypto.randomUUID();
      const sourceRoute = ticketInput({
        playerId,
        playerName: `PropHero${trial}`,
        realmId: `prop-a${trial}`,
        sessionEpoch: 1,
        authorityEpoch: 1,
        leaseId: sourceLease,
        resumeProofHash,
      });
      const sourceFloor = floorObjectName(sourceRoute);
      const authority = runtimeEnv.PLAYER_SESSIONS.getByName(
        playerSessionObjectName("test", playerId),
      );
      await expect(
        authority.authorizeJoin(await authorityJoinRequest(sourceRoute, sourceConnection)),
      ).resolves.toMatchObject({ ok: true, decision: "initial_bound", version: 1 });

      const cut = Math.floor(random() * 6);
      const handoff: TransferHandoff = {
        v: 1,
        lastClientSeq: cut,
        receipts: Array.from({ length: cut }, (_, index) => ({
          clientSeq: index + 1,
          serverRevision: 20 + index,
          requestHash: "slo_probe:v1",
          responseJson: JSON.stringify({
            type: "ack",
            command: "slo_probe",
            clientSeq: index + 1,
            serverRevision: 20 + index,
          }),
        })),
        gameplay: {
          turns: cut,
          hunger: 1000 - cut * 2,
          maxHunger: 1000,
          hungerState: "satiated",
          hp: 20,
          alive: true,
        },
      };
      const transferId = crypto.randomUUID();
      const takeover = random() >= 0.5;
      const targetSessionEpoch = takeover ? 2 : 1;
      const targetLease = crypto.randomUUID();
      const targetRoute = ticketInput({
        ...sourceRoute,
        realmId: takeover ? sourceRoute.realmId : `prop-b${trial}`,
        depth: takeover ? sourceRoute.depth : 2,
        sessionEpoch: targetSessionEpoch,
        authorityEpoch: 2,
        leaseId: targetLease,
        jti: crypto.randomUUID(),
      });
      const targetFloor = floorObjectName(targetRoute);
      const freezeRequest = {
        environment: "test",
        playerId,
        sessionEpoch: 1,
        authorityEpoch: 1,
        leaseId: sourceLease,
        floorObjectName: sourceFloor,
        connectionId: sourceConnection,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        resumeProofHash,
      } as const;
      const prepareRequest = {
        environment: "test",
        playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 2,
        resumeProofHash,
        target: {
          sessionEpoch: targetSessionEpoch,
          authorityEpoch: 2,
          leaseId: targetLease,
          floorObjectName: targetFloor,
          locationHint: "wnam" as const,
        },
      } as const;
      const commitRequest = {
        environment: "test",
        playerId,
        transferId,
        operationId: crypto.randomUUID(),
        expectedVersion: 3,
        resumeProofHash,
      } as const;

      const invalidActivationRoute = { ...targetRoute, jti: crypto.randomUUID() };
      const invalidActivationGrant = await authorityJoinRequest(
        invalidActivationRoute,
        crypto.randomUUID(),
      );
      const invalidBeforeFreeze = [
        () => authority.commitTransfer({ ...commitRequest, operationId: crypto.randomUUID(), expectedVersion: 1 }),
        () => authority.prepareTransfer({ ...prepareRequest, operationId: crypto.randomUUID(), expectedVersion: 1 }),
        () =>
          authority.activateTransfer({
            environment: "test",
            playerId,
            sessionEpoch: targetSessionEpoch,
            authorityEpoch: 2,
            leaseId: targetLease,
            floorObjectName: targetFloor,
            transferId,
            operationId: `${invalidActivationRoute.jti}-activate`,
            connectionId: invalidActivationGrant.connectionId,
            expectedVersion: 1,
            resumeProofGrant: invalidActivationGrant.resumeProofGrant,
            keyId: invalidActivationGrant.keyId,
            expiresAt: invalidActivationGrant.expiresAt,
          }),
      ];
      invalidBeforeFreeze.sort(() => random() - 0.5);
      for (const invalid of invalidBeforeFreeze) {
        await expect(invalid()).resolves.toMatchObject({ ok: false });
        await expect(authority.getSnapshot()).resolves.toMatchObject({ version: 1, transfer: null });
      }

      const source = runtimeEnv.FLOOR_INSTANCES.getByName(sourceFloor);
      await runInDurableObject(source, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO sessions
             (player_id, session_epoch, authority_epoch, lease_id, last_client_seq,
              connection_id, updated_at, disconnected_at)
           VALUES (?, 1, 1, ?, ?, ?, unixepoch(), NULL)`,
          playerId,
          sourceLease,
          cut,
          sourceConnection,
        );
        state.storage.sql.exec(
          `INSERT INTO player_gameplay
             (player_id, turns, hunger, max_hunger, hunger_state, hp, alive)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          playerId,
          handoff.gameplay.turns,
          handoff.gameplay.hunger,
          handoff.gameplay.maxHunger,
          handoff.gameplay.hungerState,
          handoff.gameplay.hp,
        );
        for (const receipt of handoff.receipts) {
          state.storage.sql.exec(
            `INSERT INTO processed_commands
               (player_id, session_epoch, client_seq, server_revision, request_hash,
                response_json, created_at)
             VALUES (?, 1, ?, ?, ?, ?, unixepoch())`,
            playerId,
            receipt.clientSeq,
            receipt.serverRevision,
            receipt.requestHash,
            receipt.responseJson,
          );
        }
      });
      await expect(
        source.freezeSessionForTransfer({
          playerId,
          sessionEpoch: 1,
          authorityEpoch: 1,
          leaseId: sourceLease,
          floorObjectName: sourceFloor,
          connectionId: sourceConnection,
          transferId,
          operationId: crypto.randomUUID(),
        }),
      ).resolves.toMatchObject({ ok: true, phase: "frozen", handoff });

      const frozen = await authority.freezeTransfer(freezeRequest);
      expect(frozen).toMatchObject({ ok: true, phase: "frozen", version: 2 });
      await expect(authority.freezeTransfer(freezeRequest)).resolves.toEqual(frozen);
      await expect(
        authority.freezeTransfer({ ...freezeRequest, expectedVersion: 2 }),
      ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });
      await expect(
        authority.commitTransfer({ ...commitRequest, operationId: crypto.randomUUID(), expectedVersion: 2 }),
      ).resolves.toMatchObject({ ok: false, code: "transfer_not_prepared", version: 2 });

      const prepared = await authority.prepareTransfer(prepareRequest);
      expect(prepared).toMatchObject({
        ok: true,
        phase: "prepared",
        mode: takeover ? "takeover" : "transfer",
        version: 3,
      });
      await expect(authority.prepareTransfer(prepareRequest)).resolves.toEqual(prepared);
      await expect(
        authority.authorizeJoin(
          await authorityJoinRequest({ ...targetRoute, jti: crypto.randomUUID() }),
        ),
      ).resolves.toMatchObject({ ok: false, code: "transfer_not_committed", version: 3 });

      const committed = await authority.commitTransfer(commitRequest);
      expect(committed).toMatchObject({ ok: true, phase: "committed", version: 4 });
      await expect(authority.commitTransfer(commitRequest)).resolves.toEqual(committed);
      await expect(
        authority.authorizeJoin(
          await authorityJoinRequest({ ...sourceRoute, jti: crypto.randomUUID() }),
        ),
      ).resolves.toMatchObject({ ok: false, code: "stale_fence", version: 4 });

      const targetConnection = crypto.randomUUID();
      const targetAuthorizationRoute = { ...targetRoute, jti: crypto.randomUUID() };
      const targetAuthorizationRequest = await authorityJoinRequest(
        targetAuthorizationRoute,
        targetConnection,
      );
      const targetAuthorization = await authority.authorizeJoin(targetAuthorizationRequest);
      expect(targetAuthorization).toMatchObject({
        ok: true,
        decision: "transfer_target",
        handoff,
        version: 5,
      });
      const activationRequest = {
        environment: "test",
        playerId,
        sessionEpoch: targetSessionEpoch,
        authorityEpoch: 2,
        leaseId: targetLease,
        floorObjectName: targetFloor,
        transferId,
        operationId: `${targetAuthorizationRoute.jti}-activate`,
        connectionId: targetConnection,
        expectedVersion: 5,
        resumeProofGrant: targetAuthorizationRequest.resumeProofGrant,
        keyId: targetAuthorizationRequest.keyId,
        expiresAt: targetAuthorizationRequest.expiresAt,
      } as const;
      const activated = await authority.activateTransfer(activationRequest);
      expect(activated).toMatchObject({ ok: false, code: "target_not_activated" });
      await expect(authority.activateTransfer(activationRequest)).resolves.toEqual(activated);
      await expect(authority.getSnapshot()).resolves.toMatchObject({
        sessionEpoch: targetSessionEpoch,
        authorityEpoch: 2,
        leaseId: targetLease,
        floorObjectName: targetFloor,
        version: 5,
        transfer: {
          transferId,
          phase: "committed",
          mode: takeover ? "takeover" : "transfer",
        },
      });
    }
  }, 20_000);
});
