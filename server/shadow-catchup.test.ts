import { describe, expect, it } from "vitest";

import {
  createMovementTurnEnvelope,
  createShadowJournalEntry,
  type MovementTurnEnvelope,
  type ShadowJournalEntry,
} from "../src/shadow-journal.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import { catchUpMovementTurnJournal, catchUpOriginJournal } from "./shadow-catchup.js";
import { catchUpCombatTurnJournal } from "./shadow-catchup.js";
import { createCombatTurnEnvelopeV1 } from "../src/combat-turn-envelope.js";

const state: GameplayState = { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 20, alive: true };
const entry = createShadowJournalEntry({ streamId: "copy", cursor: 1, command: { type: "advance_turn", action: "wait" }, beforeState: state });
const route = { realmId: "copy-test", floorInstanceId: "primary", depth: 1, floorEpoch: 1, rulesetVersion: 1 } as const;
const secret = "shadow-copy-test-secret-at-least-32-bytes";

function source(entries: readonly ShadowJournalEntry[]) {
  return { readAfter: (_streamId: string, cursor: number, limit: number) => entries.filter((value) => value.cursor > cursor).slice(0, limit) };
}

const movementTurnStream = `turn_${"a".repeat(48)}`;
const firstMovementTurn = createMovementTurnEnvelope({
  streamId: movementTurnStream,
  cursor: 1,
  operationId: "00000000-0000-4000-8000-000000000001",
  command: { type: "move", dx: 1, dy: 0 },
  beforeState: {
    authority: route,
    x: 1,
    y: 1,
    phase: "playing",
    alive: true,
    immobilizedTurns: 0,
    destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  },
  turn: { command: { type: "advance_turn", action: "other" }, beforeState: state },
});
const secondMovementTurn = createMovementTurnEnvelope({
  streamId: movementTurnStream,
  cursor: 2,
  operationId: "00000000-0000-4000-8000-000000000002",
  command: { type: "move", dx: 0, dy: 1 },
  beforeState: {
    authority: route,
    x: 2,
    y: 1,
    phase: "playing",
    alive: true,
    immobilizedTurns: 0,
    destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  },
  turn: {
    command: { type: "advance_turn", action: "other" },
    beforeState: { ...state, turns: 1, hunger: 798 },
  },
  previousEnvelopeHash: firstMovementTurn.envelopeHash,
  previousMovementEntryHash: firstMovementTurn.movement.entryHash,
  previousTurnEntryHash: firstMovementTurn.turn?.entryHash,
});
const noTurnMovement = createMovementTurnEnvelope({
  streamId: movementTurnStream,
  cursor: 2,
  operationId: "00000000-0000-4000-8000-000000000003",
  command: { type: "move", dx: 1, dy: 0 },
  beforeState: {
    authority: route,
    x: 2,
    y: 1,
    phase: "playing",
    alive: true,
    immobilizedTurns: 0,
    destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
  },
  turn: null,
  previousEnvelopeHash: firstMovementTurn.envelopeHash,
  previousMovementEntryHash: firstMovementTurn.movement.entryHash,
  previousTurnEntryHash: firstMovementTurn.turn?.entryHash,
});

function movementTurnSource(envelopes: readonly MovementTurnEnvelope[]) {
  return {
    readMovementTurnsAfter: (_streamId: string, cursor: number, limit: number) =>
      envelopes.filter((value) => value.cursor > cursor).slice(0, limit),
  };
}

const combatTurn = createCombatTurnEnvelopeV1({
  streamId: `combat_${"b".repeat(48)}`,
  route,
  cursor: 1,
  operationId: "00000000-0000-4000-8000-000000000001",
  attacker: { id: "player", name: "Romy", hp: 20, maxHp: 20, attack: 8, defense: 2, isPlayer: true, traits: [], enraged: false },
  defender: { id: "rat", name: "giant rat", hp: 8, maxHp: 8, attack: 2, defense: 1, isPlayer: false, traits: [], enraged: false },
  options: { weaponName: "short sword", hitPenalty: 0, critChance: 0 },
  transcript: { hit: 0, crit: 0.9, variance: 0.5, severityFlavor: 0, killFlavor: 0 },
  turn: { command: { type: "advance_turn", action: "other" }, beforeState: state },
});

describe("catchUpOriginJournal", () => {
  it("advances from the edge checkpoint and becomes caught up", async () => {
    const result = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test/internal/shadow/catch-up", secret,
      fetchImpl: async () => Response.json({ streamId: "copy", checkpoint: 1, accepted: 1, duplicates: 0, terminal: false, stateHash: entry.afterStateHash }),
    });
    expect(result).toMatchObject({ checkpoint: 1, accepted: 1, caughtUp: true, backpressured: false });
  });

  it("does not advance its caller checkpoint on response loss and retries the same entry", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts++;
      if (attempts === 1) throw new Error("response lost");
      return Response.json({ streamId: "copy", checkpoint: 1, accepted: 0, duplicates: 1, terminal: false, stateHash: entry.afterStateHash });
    };
    await expect(catchUpOriginJournal({ journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret, fetchImpl })).rejects.toThrow("response lost");
    const retried = await catchUpOriginJournal({ journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret, fetchImpl });
    expect(retried).toMatchObject({ checkpoint: 1, accepted: 0, duplicates: 1 });
  });

  it("proves a caller resume cursor remotely before reporting caught up", async () => {
    let requests = 0;
    const result = await catchUpOriginJournal({
      journal: source([entry]),
      streamId: "copy",
      route,
      endpoint: "https://edge.test",
      secret,
      cursor: 1,
      fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as { entries: ShadowJournalEntry[] };
        expect(body.entries.map((candidate) => candidate.cursor)).toEqual([1]);
        return Response.json({
          streamId: "copy",
          checkpoint: 1,
          accepted: 0,
          duplicates: 1,
          terminal: false,
          stateHash: entry.afterStateHash,
          entryVersion: 1,
          stateDomain: "vitals",
        });
      },
    });
    expect(requests).toBe(1);
    expect(result).toMatchObject({ checkpoint: 1, accepted: 0, duplicates: 1, caughtUp: true });
  });

  it("rejects an unprovable resume cursor before making a request", async () => {
    const fetchImpl = async () => { throw new Error("unexpected request"); };
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      cursor: 2, fetchImpl,
    })).rejects.toThrow("invalid resume cursor");
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      cursor: -1, fetchImpl,
    })).rejects.toThrow("invalid resume cursor");
  });

  it("returns explicit backpressure and preserves the supplied checkpoint", async () => {
    const result = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ code: "shadow_backpressure" }, { status: 429 }),
    });
    expect(result).toMatchObject({ checkpoint: 0, caughtUp: false, backpressured: true });
  });

  it("fails closed on edge gap and impossible checkpoint responses", async () => {
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ code: "cursor_gap", checkpoint: 0 }, { status: 409 }),
    })).rejects.toMatchObject({ code: "cursor_gap", checkpoint: 0 });
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ streamId: "copy", checkpoint: 2, accepted: 1, duplicates: 0, terminal: false, stateHash: entry.afterStateHash }),
    })).rejects.toThrow("invalid shadow checkpoint advance");
    await expect(catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({
        streamId: "copy",
        checkpoint: 1,
        accepted: 1,
        duplicates: 0,
        terminal: false,
        stateHash: entry.afterStateHash,
        entryVersion: 1,
        stateDomain: "movement",
      }),
    })).rejects.toThrow("invalid shadow response");
  });

  it("bounds entries and batches per invocation", async () => {
    await expect(catchUpOriginJournal({ journal: source([]), streamId: "copy", route, endpoint: "x", secret, maxEntriesPerBatch: 65 })).rejects.toThrow("invalid batch limit");
    await expect(catchUpOriginJournal({ journal: source([]), streamId: "copy", route, endpoint: "x", secret, maxBatches: 101 })).rejects.toThrow("invalid batch count");
    const timed = await catchUpOriginJournal({
      journal: source([entry]), streamId: "copy", route, endpoint: "x", secret,
      maxDurationMs: 1, now: (() => { let value = 0; return () => value++; })(),
    });
    expect(timed).toMatchObject({ checkpoint: 0, caughtUp: false, backpressured: true, batches: 0 });
  });

  it("turns a blackholed edge request into a bounded explicit timeout", async () => {
    await expect(catchUpOriginJournal({
      journal: source([entry]),
      streamId: "copy",
      route,
      endpoint: "https://edge.test",
      secret,
      maxDurationMs: 10,
      fetchImpl: async () => new Promise<Response>(() => { /* deliberate blackhole */ }),
    })).rejects.toMatchObject({ code: "shadow_timeout", status: 504, checkpoint: 0 });
  });
});

describe("catchUpCombatTurnJournal", () => {
  it("sends combat envelopes and requires the exact deterministic acknowledgement", async () => {
    const result = await catchUpCombatTurnJournal({
      journal: { readCombatTurnsAfter: (_streamId, cursor, limit) => [combatTurn].filter((entry) => entry.cursor > cursor).slice(0, limit) },
      streamId: combatTurn.streamId,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { combatEnvelopes: unknown[] };
        expect(body.combatEnvelopes).toEqual([combatTurn]);
        return Response.json({ streamId: combatTurn.streamId, checkpoint: 1, accepted: 1, duplicates: 0,
          terminal: false, lastEnvelopeHash: combatTurn.envelopeHash, combatStateHash: combatTurn.afterStateHash,
          turnStateHash: combatTurn.turn.afterStateHash });
      },
    });
    expect(result).toMatchObject({ checkpoint: 1, accepted: 1, caughtUp: true, backpressured: false });
  });

  it("rejects an acknowledgement that skips beyond the envelope batch", async () => {
    await expect(catchUpCombatTurnJournal({
      journal: { readCombatTurnsAfter: (_streamId, cursor, limit) => [combatTurn].filter((entry) => entry.cursor > cursor).slice(0, limit) },
      streamId: combatTurn.streamId, route, endpoint: "https://edge.test", secret,
      fetchImpl: async () => Response.json({ streamId: combatTurn.streamId, checkpoint: 2, accepted: 1, duplicates: 0,
        terminal: false, lastEnvelopeHash: combatTurn.envelopeHash, combatStateHash: combatTurn.afterStateHash,
        turnStateHash: combatTurn.turn.afterStateHash }),
    })).rejects.toThrow("invalid combat-turn shadow checkpoint advance");
  });
});

describe("catchUpMovementTurnJournal", () => {
  it("pages complete envelopes and reports both nested state hashes", async () => {
    let requests = 0;
    const result = await catchUpMovementTurnJournal({
      journal: movementTurnSource([firstMovementTurn, secondMovementTurn]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret,
      maxEntriesPerBatch: 1,
      fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as { envelopes: MovementTurnEnvelope[] };
        expect(body.envelopes).toHaveLength(1);
        const envelope = body.envelopes[0]!;
        return Response.json({
          streamId: movementTurnStream,
          checkpoint: envelope.cursor,
          accepted: 1,
          duplicates: 0,
          terminal: envelope.turn?.terminal ?? envelope.movement.terminal,
          lastEnvelopeHash: envelope.envelopeHash,
          movementStateHash: envelope.movement.afterStateHash,
          turnStateHash: envelope.turn?.afterStateHash ?? null,
        });
      },
    });
    expect(requests).toBe(2);
    expect(result).toMatchObject({
      checkpoint: 2,
      accepted: 2,
      batches: 2,
      caughtUp: true,
      backpressured: false,
      movementStateHash: secondMovementTurn.movement.afterStateHash,
      turnStateHash: secondMovementTurn.turn?.afterStateHash,
    });
  });

  it("re-submits an exact envelope after response loss and preserves backpressure", async () => {
    let delivered = false;
    const fetchImpl = async () => {
      if (!delivered) {
        delivered = true;
        throw new Error("envelope response lost");
      }
      return Response.json({
        streamId: movementTurnStream,
        checkpoint: 1,
        accepted: 0,
        duplicates: 1,
        terminal: false,
        lastEnvelopeHash: firstMovementTurn.envelopeHash,
        movementStateHash: firstMovementTurn.movement.afterStateHash,
        turnStateHash: firstMovementTurn.turn?.afterStateHash ?? null,
      });
    };
    const options = {
      journal: movementTurnSource([firstMovementTurn]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test",
      secret,
      fetchImpl,
    };
    await expect(catchUpMovementTurnJournal(options)).rejects.toThrow("envelope response lost");
    await expect(catchUpMovementTurnJournal(options)).resolves.toMatchObject({ checkpoint: 1, duplicates: 1 });
    await expect(catchUpMovementTurnJournal({
      ...options,
      fetchImpl: async () => Response.json({ code: "shadow_backpressure" }, { status: 429 }),
    })).resolves.toMatchObject({ checkpoint: 0, caughtUp: false, backpressured: true });
  });

  it("accepts a Worker checkpoint already ahead only when the local envelope proves it", async () => {
    const result = await catchUpMovementTurnJournal({
      journal: movementTurnSource([firstMovementTurn, secondMovementTurn]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret,
      maxEntriesPerBatch: 1,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { envelopes: MovementTurnEnvelope[] };
        expect(body.envelopes.map((envelope) => envelope.cursor)).toEqual([1]);
        return Response.json({
          streamId: movementTurnStream,
          checkpoint: 2,
          accepted: 0,
          duplicates: 1,
          terminal: false,
          lastEnvelopeHash: secondMovementTurn.envelopeHash,
          movementStateHash: secondMovementTurn.movement.afterStateHash,
          turnStateHash: secondMovementTurn.turn?.afterStateHash ?? null,
        });
      },
    });
    expect(result).toMatchObject({
      checkpoint: 2,
      accepted: 0,
      duplicates: 1,
      batches: 1,
      caughtUp: true,
      lastEnvelopeHash: secondMovementTurn.envelopeHash,
      movementStateHash: secondMovementTurn.movement.afterStateHash,
      turnStateHash: secondMovementTurn.turn?.afterStateHash,
    });
  });

  it("recovers from a compacted receipt only when the durable head matches local history", async () => {
    let requests = 0;
    const result = await catchUpMovementTurnJournal({
      journal: movementTurnSource([firstMovementTurn, secondMovementTurn]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret,
      maxEntriesPerBatch: 1,
      fetchImpl: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as { envelopes: MovementTurnEnvelope[] };
        if (requests === 1) {
          expect(body.envelopes.map((envelope) => envelope.cursor)).toEqual([1]);
          return Response.json({
            code: "cursor_compacted", streamId: movementTurnStream, checkpoint: 1, accepted: 0, duplicates: 0,
            terminal: false, lastEnvelopeHash: firstMovementTurn.envelopeHash,
            movementStateHash: firstMovementTurn.movement.afterStateHash,
            turnStateHash: firstMovementTurn.turn?.afterStateHash ?? null,
          }, { status: 409 });
        }
        expect(body.envelopes.map((envelope) => envelope.cursor)).toEqual([2]);
        return Response.json({
          streamId: movementTurnStream, checkpoint: 2, accepted: 1, duplicates: 0, terminal: false,
          lastEnvelopeHash: secondMovementTurn.envelopeHash,
          movementStateHash: secondMovementTurn.movement.afterStateHash,
          turnStateHash: secondMovementTurn.turn?.afterStateHash ?? null,
        });
      },
    });
    expect(requests).toBe(2);
    expect(result).toMatchObject({ checkpoint: 2, accepted: 1, duplicates: 0, caughtUp: true });

    const durableHead = {
      code: "cursor_compacted", streamId: movementTurnStream, checkpoint: 1, accepted: 0, duplicates: 0,
      terminal: false, lastEnvelopeHash: firstMovementTurn.envelopeHash,
      movementStateHash: firstMovementTurn.movement.afterStateHash,
      turnStateHash: firstMovementTurn.turn?.afterStateHash ?? null,
    };
    const tamperedHeads = [
      { ...durableHead, streamId: `turn_${"b".repeat(48)}` },
      { ...durableHead, checkpoint: 0 },
      { ...durableHead, accepted: 1 },
      { ...durableHead, duplicates: 1 },
      { ...durableHead, terminal: true },
      { ...durableHead, lastEnvelopeHash: "0000000000000000" },
      { ...durableHead, movementStateHash: "0000000000000000" },
      { ...durableHead, turnStateHash: "0000000000000000" },
    ];
    for (const response of tamperedHeads) {
      await expect(catchUpMovementTurnJournal({
        journal: movementTurnSource([firstMovementTurn, secondMovementTurn]), streamId: movementTurnStream, route,
        endpoint: "https://edge.test/internal/shadow/catch-up", secret,
        fetchImpl: async () => Response.json(response, { status: 409 }),
      })).rejects.toThrow("invalid movement-turn compacted checkpoint");
    }
  });

  it("resumes at a no-turn envelope with the prior durable turn-state hash", async () => {
    const result = await catchUpMovementTurnJournal({
      journal: movementTurnSource([firstMovementTurn, noTurnMovement]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test/internal/shadow/catch-up",
      secret,
      cursor: 2,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { envelopes: MovementTurnEnvelope[] };
        expect(body.envelopes.map((envelope) => envelope.cursor)).toEqual([2]);
        return Response.json({
          streamId: movementTurnStream,
          checkpoint: 2,
          accepted: 1,
          duplicates: 0,
          terminal: false,
          lastEnvelopeHash: noTurnMovement.envelopeHash,
          movementStateHash: noTurnMovement.movement.afterStateHash,
          turnStateHash: firstMovementTurn.turn!.afterStateHash,
        });
      },
    });
    expect(result).toMatchObject({
      checkpoint: 2,
      accepted: 1,
      duplicates: 0,
      movementStateHash: noTurnMovement.movement.afterStateHash,
      turnStateHash: firstMovementTurn.turn!.afterStateHash,
      caughtUp: true,
    });
  });

  it("fails closed on an impossible checkpoint and bounds a blackholed request", async () => {
    const options = {
      journal: movementTurnSource([firstMovementTurn]),
      streamId: movementTurnStream,
      route,
      endpoint: "https://edge.test",
      secret,
    };
    await expect(catchUpMovementTurnJournal({
      ...options,
      fetchImpl: async () => Response.json({
        streamId: movementTurnStream,
        checkpoint: 2,
        accepted: 1,
        duplicates: 0,
        terminal: false,
        lastEnvelopeHash: firstMovementTurn.envelopeHash,
        movementStateHash: firstMovementTurn.movement.afterStateHash,
        turnStateHash: firstMovementTurn.turn?.afterStateHash ?? null,
      }),
    })).rejects.toThrow("invalid movement-turn shadow checkpoint advance");
    await expect(catchUpMovementTurnJournal({
      ...options,
      maxDurationMs: 10,
      fetchImpl: async () => new Promise<Response>(() => { /* deliberate blackhole */ }),
    })).rejects.toMatchObject({ code: "shadow_timeout", status: 504, checkpoint: 0 });
  });

  it("rejects acknowledgements whose counts, terminal state, or hashes do not prove the sent envelope", async () => {
    const acknowledged = {
      streamId: movementTurnStream,
      checkpoint: 1,
      accepted: 1,
      duplicates: 0,
      terminal: false,
      lastEnvelopeHash: firstMovementTurn.envelopeHash,
      movementStateHash: firstMovementTurn.movement.afterStateHash,
      turnStateHash: firstMovementTurn.turn?.afterStateHash ?? null,
    };
    const falseAcknowledgements = [
      { ...acknowledged, accepted: 0 },
      { ...acknowledged, checkpoint: 0, accepted: 0 },
      { ...acknowledged, terminal: true },
      { ...acknowledged, lastEnvelopeHash: "0000000000000000" },
      { ...acknowledged, movementStateHash: "0000000000000000" },
      { ...acknowledged, turnStateHash: "0000000000000000" },
    ];
    for (const response of falseAcknowledgements) {
      await expect(catchUpMovementTurnJournal({
        journal: movementTurnSource([firstMovementTurn]),
        streamId: movementTurnStream,
        route,
        endpoint: "https://edge.test",
        secret,
        fetchImpl: async () => Response.json(response),
      })).rejects.toThrow("invalid movement-turn shadow checkpoint advance");
    }
  });
});
