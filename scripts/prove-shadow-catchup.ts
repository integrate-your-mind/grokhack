import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestHarness } from "../edge/node_modules/wrangler/wrangler-dist/cli.js";
import { reduceGameplay, type GameplayState } from "../src/gameplay-reducer.js";
import { shadowEntryHash } from "../src/shadow-journal.js";
import { OriginGameplayJournal } from "../server/origin-journal.js";
import { catchUpOriginJournal, ShadowCatchupError } from "../server/shadow-catchup.js";

const secret = "local-shadow-e2e-secret-2026-07-11-proof";
const route = { realmId: "local-proof", floorInstanceId: "primary", depth: 1, floorEpoch: 1 };
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
    maxBatches: 5,
    fetchImpl: (input, init) => harness.fetch(input, init),
  });
  if (!parity.caughtUp || parity.checkpoint !== 300 || parity.duplicates !== 64 || parity.accepted !== 236 || parity.stateHash !== journal.readAfter("origin_parity", 299, 1)[0]!.afterStateHash || state.hungerState !== "weak") {
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
  process.stdout.write(`${JSON.stringify({ ok: true, responseLossObserved, parity, terminalParity, divergence })}\n`);
} finally {
  await harness.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
