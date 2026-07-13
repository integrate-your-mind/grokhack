import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestHarness } from "../edge/node_modules/wrangler/wrangler-dist/cli.js";
import { reduceGameplay, type GameplayState } from "../src/gameplay-reducer.js";
import { reduceMovement, type MovementState } from "../src/movement-reducer.js";
import { createShadowJournalEntry, shadowEntryHash } from "../src/shadow-journal.js";
import { OriginGameplayJournal } from "../server/origin-journal.js";
import { catchUpOriginJournal, ShadowCatchupError } from "../server/shadow-catchup.js";

const secret = "local-shadow-e2e-secret-2026-07-11-proof";
const route = { realmId: "local-proof", floorInstanceId: "primary", depth: 1, floorEpoch: 1, rulesetVersion: 1 } as const;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-shadow-e2e-"));
const harness = createTestHarness({
  root: process.cwd(),
  workers: [{
    configPath: "edge/wrangler.jsonc",
    secrets: {
      ROUTE_TICKET_SECRET: "local-route-ticket-proof-secret-2026-07-11",
      ROUTE_TICKET_PREVIOUS_SECRET: "local-previous-route-proof-secret-2026-07",
      SHADOW_INGEST_SECRET: secret,
    },
  }],
});

try {
  await harness.listen();
  const journal = new OriginGameplayJournal(directory);
  let state: GameplayState = { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 1000, alive: true };
  for (let cursor = 1; cursor <= 300; cursor++) {
    const command = { type: "advance_turn", action: cursor % 2 ? "wait" : "other" } as const;
    journal.appendTransition({ streamId: "origin_parity", command, beforeState: state });
    state = reduceGameplay(state, command).state;
  }
  let movementState: MovementState = {
    authority: { ...route },
    x: 10,
    y: 10,
    phase: "playing",
    alive: true,
    immobilizedTurns: 0,
    destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  };
  const movementDestinations = [
    { tile: ".", occupant: "none", trap: false, stairsDown: false },
    { tile: "#", occupant: "none", trap: false, stairsDown: false },
    { tile: ".", occupant: "player", trap: false, stairsDown: false },
    { tile: ".", occupant: "monster", trap: false, stairsDown: false },
    { tile: ">", occupant: "none", trap: true, stairsDown: true },
    { tile: "+", occupant: "none", trap: false, stairsDown: false },
  ] as const;
  const movementDirections = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  for (let index = 0; index < 96; index++) {
    movementState = { ...movementState, destination: { ...movementDestinations[index % movementDestinations.length]! } };
    const [dx, dy] = movementDirections[index % movementDirections.length]!;
    const command = { type: "move", dx, dy } as const;
    journal.appendTransition({ streamId: "origin_parity", command, beforeState: movementState });
    movementState = reduceMovement(movementState, command).state;
  }
  let responseLossObserved = false;
  try {
    await catchUpOriginJournal({
      journal,
      streamId: "origin_parity",
      route,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      maxBatches: 1,
      fetchImpl: async (input, init) => {
        await harness.fetch(input, init);
        throw new Error("deliberate response loss");
      },
    });
  } catch (error) {
    responseLossObserved = error instanceof Error && error.message === "deliberate response loss";
  }
  if (!responseLossObserved) throw new Error("response-loss proof did not fail as expected");
  const parity = await catchUpOriginJournal({
    journal,
    streamId: "origin_parity",
    route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    maxBatches: 7,
    fetchImpl: (input, init) => harness.fetch(input, init),
  });
  if (!parity.caughtUp || parity.checkpoint !== 396 || parity.duplicates !== 64 || parity.accepted !== 332 || parity.stateHash !== journal.readAfter("origin_parity", 395, 1)[0]!.afterStateHash || state.hungerState !== "weak") {
    throw new Error(`parity proof failed: ${JSON.stringify(parity)}`);
  }

  const terminalJournal = new OriginGameplayJournal(path.join(directory, "terminal"));
  const terminalEntry = terminalJournal.appendTransition({
    streamId: "origin_terminal",
    command: { type: "advance_turn", action: "wait" },
    beforeState: { turns: 0, depth: 1, hunger: 1, maxHunger: 1000, hungerState: "starving", hp: 3, alive: true },
  }).entry;
  const terminalParity = await catchUpOriginJournal({
    journal: terminalJournal,
    streamId: "origin_terminal",
    route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: (input, init) => harness.fetch(input, init),
  });
  if (!terminalEntry.terminal || !terminalParity.terminal || terminalParity.checkpoint !== 1 || terminalParity.stateHash !== terminalEntry.afterStateHash) {
    throw new Error(`terminal parity proof failed: ${JSON.stringify(terminalParity)}`);
  }

  const divergenceJournal = new OriginGameplayJournal(path.join(directory, "divergent"));
  const correct = divergenceJournal.appendTransition({
    streamId: "origin_divergence",
    command: { type: "advance_turn", action: "wait" },
    beforeState: { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 20, alive: true },
  }).entry;
  fs.rmSync(path.join(directory, "divergent"), { recursive: true, force: true });
  const unsigned = { ...correct, afterStateHash: "0000000000000000" };
  const divergent = { ...unsigned, entryHash: shadowEntryHash(unsigned) };
  const divergentSource = { readAfter: (_streamId: string, cursor: number) => cursor < 1 ? [divergent] : [] };
  let divergence: { code: string; checkpoint: number; status: number } | null = null;
  try {
    await catchUpOriginJournal({
      journal: divergentSource,
      streamId: "origin_divergence",
      route,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      fetchImpl: (input, init) => harness.fetch(input, init),
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    divergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!divergence || divergence.code !== "state_hash_divergence" || divergence.checkpoint !== 0 || divergence.status !== 422) {
    throw new Error(`divergence proof failed: ${JSON.stringify(divergence)}`);
  }

  const eventDivergenceJournal = new OriginGameplayJournal(path.join(directory, "event-divergent"));
  const correctMovement = eventDivergenceJournal.appendTransition({
    streamId: "origin_event_divergence",
    command: { type: "move", dx: 1, dy: 0 },
    beforeState: {
      authority: { ...route },
      x: 2,
      y: 3,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "player", trap: false, stairsDown: false },
    },
  }).entry;
  if (correctMovement.v !== 2) throw new Error("movement journal did not produce V2 evidence");
  fs.rmSync(path.join(directory, "event-divergent"), { recursive: true, force: true });
  const eventUnsigned = { ...correctMovement, eventHash: "0000000000000000" };
  const eventDivergent = { ...eventUnsigned, entryHash: shadowEntryHash(eventUnsigned) };
  const eventSource = { readAfter: (_streamId: string, cursor: number) => cursor < 1 ? [eventDivergent] : [] };
  let eventDivergence: { code: string; checkpoint: number; status: number } | null = null;
  try {
    await catchUpOriginJournal({
      journal: eventSource,
      streamId: "origin_event_divergence",
      route,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      fetchImpl: (input, init) => harness.fetch(input, init),
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    eventDivergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!eventDivergence || eventDivergence.code !== "event_hash_divergence" || eventDivergence.checkpoint !== 0 || eventDivergence.status !== 422) {
    throw new Error(`event divergence proof failed: ${JSON.stringify(eventDivergence)}`);
  }

  const continuityJournal = new OriginGameplayJournal(path.join(directory, "continuity"));
  const continuityFirst = continuityJournal.appendTransition({
    streamId: "origin_continuity_divergence",
    command: { type: "move", dx: 1, dy: 0 },
    beforeState: {
      authority: { ...route },
      x: 4,
      y: 5,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
    },
  }).entry;
  await catchUpOriginJournal({
    journal: continuityJournal,
    streamId: "origin_continuity_divergence",
    route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: (input, init) => harness.fetch(input, init),
  });
  const continuityJump = createShadowJournalEntry({
    streamId: "origin_continuity_divergence",
    cursor: 2,
    previousEntryHash: continuityFirst.entryHash,
    command: { type: "move", dx: 1, dy: 0 },
    beforeState: {
      authority: { ...route },
      x: 40,
      y: 5,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "player", trap: false, stairsDown: false },
    },
  });
  const continuitySource = {
    readAfter: (_streamId: string, cursor: number, limit: number) =>
      [continuityFirst, continuityJump].filter((entry) => entry.cursor > cursor).slice(0, limit),
  };
  let continuityDivergence: { code: string; checkpoint: number; status: number } | null = null;
  try {
    await catchUpOriginJournal({
      journal: continuitySource,
      streamId: "origin_continuity_divergence",
      route,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      cursor: 1,
      fetchImpl: (input, init) => harness.fetch(input, init),
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    continuityDivergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!continuityDivergence || continuityDivergence.code !== "state_continuity_divergence" ||
      continuityDivergence.checkpoint !== 1 || continuityDivergence.status !== 422) {
    throw new Error(`continuity divergence proof failed: ${JSON.stringify(continuityDivergence)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    responseLossObserved,
    parity,
    terminalParity,
    divergence,
    eventDivergence,
    continuityDivergence,
  })}\n`);
} finally {
  await harness.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
