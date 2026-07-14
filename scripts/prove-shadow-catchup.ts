import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { createTestHarness } from "../edge/node_modules/wrangler/wrangler-dist/cli.js";
import { isWalkable } from "../src/dungeon.js";
import { createMonster } from "../src/entities.js";
import { gameplayStateHash, reduceGameplay, type GameplayState } from "../src/gameplay-reducer.js";
import { reduceMovement, type MovementState } from "../src/movement-reducer.js";
import {
  createShadowJournalEntry,
  shadowEntryHash,
  validateShadowRoute,
  type MovementTurnEnvelope,
} from "../src/shadow-journal.js";
import {
  movementJournalRunId,
  movementJournalStreamId,
  movementTurnJournalStreamId,
  combatTurnJournalStreamId,
  OriginGameplayJournal,
} from "../server/origin-journal.js";
import {
  catchUpCombatTurnJournal,
  catchUpMovementTurnJournal,
  catchUpOriginJournal,
  ShadowCatchupError,
} from "../server/shadow-catchup.js";
import type { ClientConnection, FloorState, OnlinePlayer } from "../server/types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
const worktreeStatus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const worktreeClean = worktreeStatus.length === 0;
const requireCleanProof = process.env.GROKHACK_REQUIRE_CLEAN_PROOF === "1";
const sourceState = {
  headSha,
  worktreeClean,
  requireCleanProof,
  statusEntryCount: worktreeStatus === "" ? 0 : worktreeStatus.trimEnd().split("\n").length,
  statusSha256: sha256(worktreeStatus),
  trackedDiffSha256: sha256(trackedDiff),
  sourceIdentitySha256: sha256(`${headSha}\0${worktreeStatus}\0${trackedDiff}`),
  identityScope: "HEAD plus porcelain status paths and tracked HEAD diff; untracked file contents excluded",
};

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
// Wrangler and Node each ship structurally compatible fetch types from separate
// packages. Keep that type-system seam in one place while dispatching every
// request through the real local Worker harness.
const harnessFetch: typeof fetch = (input, init) =>
  harness.fetch(input as never, init as never) as unknown as Promise<Response>;

function connection(id: string, messages: string[]): ClientConnection {
  return {
    id,
    sessionId: `movement-turn-e2e-${id}`,
    transport: "websocket",
    playerId: null,
    agentMode: false,
    send: (message) => messages.push(typeof message === "string" ? message : JSON.stringify(message)),
    close: () => {},
  };
}

const directions = [
  { dx: 1, dy: 0, key: "l" },
  { dx: -1, dy: 0, key: "h" },
  { dx: 0, dy: 1, key: "j" },
  { dx: 0, dy: -1, key: "k" },
] as const;

type MovementStep = (typeof directions)[number] & { x: number; y: number };

function findOrdinaryStep(floor: FloorState): MovementStep | undefined {
  return floor.dungeon.tiles.flatMap((row, y) => row.map((_tile, x) => ({ x, y })))
    .flatMap(({ x, y }) => directions.map((direction) => ({ x, y, ...direction })))
    .find(({ x, y, dx, dy }) => {
      const targetX = x + dx;
      const targetY = y + dy;
      const sourceSpecial = floor.dungeon.rooms.some((room) => room.special &&
        x >= room.x && x < room.x + room.w &&
        y >= room.y && y < room.y + room.h);
      const special = floor.dungeon.rooms.some((room) => room.special &&
        targetX >= room.x && targetX < room.x + room.w &&
        targetY >= room.y && targetY < room.y + room.h);
      return isWalkable(floor.dungeon.tiles, x, y) &&
        isWalkable(floor.dungeon.tiles, targetX, targetY) &&
        floor.dungeon.tiles[y]?.[x] !== "+" &&
        floor.dungeon.tiles[targetY]?.[targetX] !== "+" &&
        !sourceSpecial && !special &&
        (x !== floor.dungeon.stairsDown.x || y !== floor.dungeon.stairsDown.y) &&
        (targetX !== floor.dungeon.stairsDown.x || targetY !== floor.dungeon.stairsDown.y);
    });
}

function movementEventCodes(envelope: MovementTurnEnvelope): string[] {
  return reduceMovement(envelope.movement.beforeState, envelope.movement.command).events.map((event) =>
    event.type === "message" ? `${event.type}:${event.code}` : event.type);
}

function gameplayEventCodes(envelope: MovementTurnEnvelope): string[] {
  if (!envelope.turn) return [];
  return reduceGameplay(envelope.turn.beforeState, envelope.turn.command).events.map((event) =>
    event.type === "message" ? `${event.type}:${event.text}` : event.type);
}

function assertCodes(label: string, actual: readonly string[], expected: readonly string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} event mismatch: ${JSON.stringify({ actual, expected })}`);
  }
}

function assertEnvelopeSemantics(
  label: string,
  envelope: MovementTurnEnvelope,
  expected: {
    outcome: ReturnType<typeof reduceMovement>["outcome"];
    movementEvents: readonly string[];
    turnEvents: readonly string[];
    terminal?: boolean;
  },
): {
  outcome: ReturnType<typeof reduceMovement>["outcome"];
  turnCost: ReturnType<typeof reduceMovement>["turnCost"];
  movementEvents: string[];
  turnEvents: string[];
  turnPresent: boolean;
  terminal: boolean;
} {
  const transition = reduceMovement(envelope.movement.beforeState, envelope.movement.command);
  const actualMovementEvents = movementEventCodes(envelope);
  const actualTurnEvents = gameplayEventCodes(envelope);
  const shouldCarryTurn = transition.turnCost !== "none";
  const terminal = envelope.turn?.terminal ?? envelope.movement.terminal;
  if (transition.outcome !== expected.outcome || Boolean(envelope.turn) !== shouldCarryTurn ||
      (envelope.turn && (envelope.turn.command.type !== "advance_turn" || envelope.turn.command.action !== "other")) ||
      terminal !== (expected.terminal ?? false)) {
    throw new Error(`${label} envelope semantics mismatch: ${JSON.stringify({
      outcome: transition.outcome,
      expectedOutcome: expected.outcome,
      turnCost: transition.turnCost,
      turnPresent: Boolean(envelope.turn),
      terminal,
      expectedTerminal: expected.terminal ?? false,
    })}`);
  }
  assertCodes(`${label} movement`, actualMovementEvents, expected.movementEvents);
  assertCodes(`${label} turn`, actualTurnEvents, expected.turnEvents);
  return {
    outcome: transition.outcome,
    turnCost: transition.turnCost,
    movementEvents: actualMovementEvents,
    turnEvents: actualTurnEvents,
    turnPresent: Boolean(envelope.turn),
    terminal,
  };
}

try {
  if (requireCleanProof && !worktreeClean) {
    throw new Error(`clean proof required but worktree is dirty (${sourceState.statusEntryCount} status entries)`);
  }
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
        await harnessFetch(input, init);
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
    fetchImpl: harnessFetch,
  });
  if (!parity.caughtUp || parity.checkpoint !== 396 || parity.duplicates !== 64 || parity.accepted !== 332 || parity.stateHash !== journal.readAfter("origin_parity", 395, 1)[0]!.afterStateHash || state.hungerState !== "weak") {
    throw new Error(`parity proof failed: ${JSON.stringify(parity)}`);
  }

  const terminalJournal = new OriginGameplayJournal(path.join(directory, "terminal"));
  const terminalAppend = terminalJournal.appendTransition({
    streamId: "origin_terminal",
    command: { type: "advance_turn", action: "wait" },
    beforeState: { turns: 0, depth: 1, hunger: 1, maxHunger: 1000, hungerState: "starving", hp: 3, alive: true },
  });
  if (terminalAppend.status === "dropped_capacity") throw new Error("terminal journal capacity exhausted");
  const terminalEntry = terminalAppend.entry;
  const terminalParity = await catchUpOriginJournal({
    journal: terminalJournal,
    streamId: "origin_terminal",
    route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: harnessFetch,
  });
  if (!terminalEntry.terminal || !terminalParity.terminal || terminalParity.checkpoint !== 1 || terminalParity.stateHash !== terminalEntry.afterStateHash) {
    throw new Error(`terminal parity proof failed: ${JSON.stringify(terminalParity)}`);
  }

  const divergenceJournal = new OriginGameplayJournal(path.join(directory, "divergent"));
  const correctAppend = divergenceJournal.appendTransition({
    streamId: "origin_divergence",
    command: { type: "advance_turn", action: "wait" },
    beforeState: { turns: 0, depth: 1, hunger: 800, maxHunger: 1000, hungerState: "normal", hp: 20, alive: true },
  });
  if (correctAppend.status === "dropped_capacity") throw new Error("divergence journal capacity exhausted");
  const correct = correctAppend.entry;
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
      fetchImpl: harnessFetch,
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    divergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!divergence || divergence.code !== "state_hash_divergence" || divergence.checkpoint !== 0 || divergence.status !== 422) {
    throw new Error(`divergence proof failed: ${JSON.stringify(divergence)}`);
  }

  const eventDivergenceJournal = new OriginGameplayJournal(path.join(directory, "event-divergent"));
  const correctMovementAppend = eventDivergenceJournal.appendTransition({
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
  });
  if (correctMovementAppend.status === "dropped_capacity") {
    throw new Error("event-divergence journal capacity exhausted");
  }
  const correctMovement = correctMovementAppend.entry;
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
      fetchImpl: harnessFetch,
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    eventDivergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!eventDivergence || eventDivergence.code !== "event_hash_divergence" || eventDivergence.checkpoint !== 0 || eventDivergence.status !== 422) {
    throw new Error(`event divergence proof failed: ${JSON.stringify(eventDivergence)}`);
  }

  const continuityJournal = new OriginGameplayJournal(path.join(directory, "continuity"));
  const continuityFirstAppend = continuityJournal.appendTransition({
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
  });
  if (continuityFirstAppend.status === "dropped_capacity") {
    throw new Error("continuity journal capacity exhausted");
  }
  const continuityFirst = continuityFirstAppend.entry;
  await catchUpOriginJournal({
    journal: continuityJournal,
    streamId: "origin_continuity_divergence",
    route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: harnessFetch,
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
      fetchImpl: harnessFetch,
    });
  } catch (error) {
    if (!(error instanceof ShadowCatchupError)) throw error;
    continuityDivergence = { code: error.code, checkpoint: error.checkpoint, status: error.status };
  }
  if (!continuityDivergence || continuityDivergence.code !== "state_continuity_divergence" ||
      continuityDivergence.checkpoint !== 1 || continuityDivergence.status !== 422) {
    throw new Error(`continuity divergence proof failed: ${JSON.stringify(continuityDivergence)}`);
  }

  // Production-shaped movement-turn proof: real WorldServer command handling,
  // the durable origin envelope, the public authenticated Worker route and one
  // SQLite Durable Object transaction. Every data path remains under this
  // isolated temporary root.
  process.env.GROKHACK_DATA_DIR = path.join(directory, "world-data");
  process.env.GROKHACK_DB_PATH = path.join(directory, "world-data", "world.duckdb");
  process.env.GROKHACK_DISCONNECT_GRACE_MS = "0";
  process.env.IRC_ENABLED = "0";
  const { WorldServer } = await import("../server/world.js");
  const worldJournal = new OriginGameplayJournal(path.join(directory, "world-journal"));
  const world = new WorldServer({ loadResumablePlayer: async () => null, originJournal: worldJournal });
  const worldMessages: string[] = [];
  const worldConnection = connection("real-world", worldMessages);
  world.registerConnection(worldConnection);
  const player = await world.joinPlayer(worldConnection.id, "AtomicProof");
  if (typeof player === "string" || !player.resumeToken) throw new Error(`movement-turn join failed: ${player}`);
  const floor = world.buildView(player).floor;
  floor.traps = [];
  floor.monsters = [];
  floor.items = [];
  const ordinaryStep = findOrdinaryStep(floor);
  if (!ordinaryStep || !floor.movementAuthority) throw new Error("isolated world has no ordinary movement proof step");
  player.state.entity.x = ordinaryStep.x;
  player.state.entity.y = ordinaryStep.y;
  player.state.hunger = 2_000;
  player.state.entity.hp = 999;
  player.state.entity.maxHp = 999;
  player.state.statuses = [{ kind: "poison", turnsLeft: 2, power: 2 }];
  const originBefore = {
    x: player.state.entity.x,
    y: player.state.entity.y,
    turns: player.state.turns,
    hunger: player.state.hunger,
    hp: player.state.entity.hp,
  };
  world.handleInput(player.id, ordinaryStep.key);
  const movementRunId = movementJournalRunId(player.resumeToken);
  const movementTurnStreamId = movementTurnJournalStreamId(player.id, movementRunId, floor.movementAuthority);
  const standaloneMovementStreamId = movementJournalStreamId(player.id, movementRunId, floor.movementAuthority);
  const [movementTurnEnvelope, ...unexpectedEnvelopes] = worldJournal.readMovementTurnsAfter(
    movementTurnStreamId,
    0,
    64,
  );
  if (!movementTurnEnvelope || unexpectedEnvelopes.length > 0 || !movementTurnEnvelope.turn ||
      worldJournal.readAfter(player.id, 0, 64).length !== 0 ||
      worldJournal.readAfter(standaloneMovementStreamId, 0, 64).length !== 0) {
    throw new Error("real WorldServer did not publish exactly one atomic movement-turn envelope");
  }
  const ordinarySemantics = assertEnvelopeSemantics("ordinary", movementTurnEnvelope, {
    outcome: "moved",
    movementEvents: ["moved", "pickup_intent", "room_step_intent", "turn_intent", "visibility_intent"],
    turnEvents: [],
  });
  const originAfter = {
    x: player.state.entity.x,
    y: player.state.entity.y,
    turns: player.state.turns,
    hunger: player.state.hunger,
    hp: player.state.entity.hp,
  };
  if (originAfter.x !== originBefore.x + ordinaryStep.dx ||
      originAfter.y !== originBefore.y + ordinaryStep.dy ||
      originAfter.turns !== originBefore.turns + 1 ||
      originAfter.hunger >= originBefore.hunger || originAfter.hp !== originBefore.hp - 2 ||
      world.getStats().shadowEvidenceDegraded) {
    throw new Error(`real WorldServer movement did not roll forward exactly once: ${JSON.stringify({ originBefore, originAfter })}`);
  }

  const worker = harness.getWorker();
  const replayObjectsBefore = await worker.listDurableObjectIds("SHADOW_REPLAYS");
  const movementTurnFirstAckHolder: { value: Record<string, unknown> | null } = { value: null };
  let movementTurnResponseLossObserved = false;
  try {
    await catchUpMovementTurnJournal({
      journal: worldJournal,
      streamId: movementTurnStreamId,
      route: validateShadowRoute(movementTurnEnvelope.movement.beforeState.authority),
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      fetchImpl: async (input, init) => {
        const response = await harnessFetch(input, init);
        movementTurnFirstAckHolder.value = await response.clone().json() as Record<string, unknown>;
        throw new Error("deliberate movement-turn response loss");
      },
    });
  } catch (error) {
    movementTurnResponseLossObserved = error instanceof Error &&
      error.message === "deliberate movement-turn response loss";
  }
  const movementTurnFirstAck = movementTurnFirstAckHolder.value;
  if (!movementTurnResponseLossObserved || !movementTurnFirstAck ||
      movementTurnFirstAck.streamId !== movementTurnStreamId ||
      movementTurnFirstAck.checkpoint !== 1 || movementTurnFirstAck.accepted !== 1 ||
      movementTurnFirstAck.duplicates !== 0 ||
      movementTurnFirstAck.terminal !== false ||
      movementTurnFirstAck.lastEnvelopeHash !== movementTurnEnvelope.envelopeHash ||
      movementTurnFirstAck.movementStateHash !== movementTurnEnvelope.movement.afterStateHash ||
      movementTurnFirstAck.turnStateHash !== movementTurnEnvelope.turn.afterStateHash) {
    throw new Error(`movement-turn response-loss commit was not observed: ${JSON.stringify(movementTurnFirstAck)}`);
  }
  const movementTurnRetry = await catchUpMovementTurnJournal({
    journal: worldJournal,
    streamId: movementTurnStreamId,
    route: validateShadowRoute(movementTurnEnvelope.movement.beforeState.authority),
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: harnessFetch,
  });
  if (!movementTurnRetry.caughtUp || movementTurnRetry.checkpoint !== 1 ||
      movementTurnRetry.accepted !== 0 || movementTurnRetry.duplicates !== 1 ||
      movementTurnRetry.lastEnvelopeHash !== movementTurnEnvelope.envelopeHash ||
      movementTurnRetry.movementStateHash !== movementTurnEnvelope.movement.afterStateHash ||
      movementTurnRetry.turnStateHash !== movementTurnEnvelope.turn.afterStateHash) {
    throw new Error(`movement-turn response-loss retry failed: ${JSON.stringify(movementTurnRetry)}`);
  }

  const reverseStep = directions.find((direction) =>
    direction.dx === -ordinaryStep.dx && direction.dy === -ordinaryStep.dy);
  if (!reverseStep) throw new Error("ordinary movement reverse step is unavailable");
  world.handleInput(player.id, reverseStep.key);
  const [originEffectsEnvelope, ...unexpectedOriginEffectsEnvelopes] = worldJournal.readMovementTurnsAfter(
    movementTurnStreamId,
    1,
    64,
  );
  if (!originEffectsEnvelope || unexpectedOriginEffectsEnvelopes.length > 0 || !originEffectsEnvelope.turn ||
      originEffectsEnvelope.cursor !== 2 || originEffectsEnvelope.turn.beforeState.hp !== originAfter.hp ||
      gameplayStateHash(originEffectsEnvelope.turn.beforeState) === movementTurnEnvelope.turn.afterStateHash) {
    throw new Error("real consecutive World turns did not expose the authenticated origin-effects boundary");
  }
  const movementTurnParity = await catchUpMovementTurnJournal({
    journal: worldJournal,
    streamId: movementTurnStreamId,
    route: validateShadowRoute(movementTurnEnvelope.movement.beforeState.authority),
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: harnessFetch,
  });
  const replayObjectsAfter = await worker.listDurableObjectIds("SHADOW_REPLAYS");
  if (!movementTurnParity.caughtUp || movementTurnParity.checkpoint !== 2 ||
      movementTurnParity.accepted !== 1 || movementTurnParity.duplicates !== 1 ||
      movementTurnParity.lastEnvelopeHash !== originEffectsEnvelope.envelopeHash ||
      movementTurnParity.movementStateHash !== originEffectsEnvelope.movement.afterStateHash ||
      movementTurnParity.turnStateHash !== originEffectsEnvelope.turn.afterStateHash ||
      replayObjectsAfter.length !== replayObjectsBefore.length + 1) {
    throw new Error(`movement-turn origin-effects parity failed: ${JSON.stringify(movementTurnParity)}`);
  }

  const failureDirectory = path.join(directory, "world-failure-journal");
  let failCommitByte = false;
  const failureJournal = new OriginGameplayJournal(failureDirectory, {
    writeSync: (descriptor, buffer, offset, length) => {
      if (failCommitByte && buffer.byteLength === 1) {
        failCommitByte = false;
        throw new Error("injected movement-turn commit failure");
      }
      return fs.writeSync(descriptor, buffer, offset, length);
    },
  });
  const failureWorld = new WorldServer({ loadResumablePlayer: async () => null, originJournal: failureJournal });
  const failureMessages: string[] = [];
  const failureConnection = connection("real-failure", failureMessages);
  failureWorld.registerConnection(failureConnection);
  const failurePlayer = await failureWorld.joinPlayer(failureConnection.id, "AtomicFailure");
  if (typeof failurePlayer === "string" || !failurePlayer.resumeToken) {
    throw new Error(`movement-turn failure join failed: ${failurePlayer}`);
  }
  const failureFloor = failureWorld.buildView(failurePlayer).floor;
  failureFloor.traps = [];
  failureFloor.monsters = [];
  failureFloor.items = [];
  const failureStep = findOrdinaryStep(failureFloor);
  if (!failureStep || !failureFloor.movementAuthority) throw new Error("failure world has no movement proof step");
  failurePlayer.state.entity.x = failureStep.x;
  failurePlayer.state.entity.y = failureStep.y;
  failurePlayer.state.hunger = 2_000;
  failurePlayer.state.entity.hp = 999;
  failurePlayer.state.entity.maxHp = 999;
  const failureBefore = {
    x: failurePlayer.state.entity.x,
    y: failurePlayer.state.entity.y,
    turns: failurePlayer.state.turns,
    hunger: failurePlayer.state.hunger,
  };
  failCommitByte = true;
  failureWorld.handleInput(failurePlayer.id, failureStep.key);
  const failureStreamId = movementTurnJournalStreamId(
    failurePlayer.id,
    movementJournalRunId(failurePlayer.resumeToken),
    failureFloor.movementAuthority,
  );
  const failureAfter = {
    x: failurePlayer.state.entity.x,
    y: failurePlayer.state.entity.y,
    turns: failurePlayer.state.turns,
    hunger: failurePlayer.state.hunger,
  };
  const failureReplayObjects = await worker.listDurableObjectIds("SHADOW_REPLAYS");
  if (failureAfter.x !== failureBefore.x + failureStep.dx ||
      failureAfter.y !== failureBefore.y + failureStep.dy ||
      failureAfter.turns !== failureBefore.turns + 1 ||
      failureAfter.hunger >= failureBefore.hunger ||
      !failureWorld.getStats().shadowEvidenceDegraded ||
      !failurePlayer.messages.includes("Turn completed; shadow evidence is degraded.") ||
      new OriginGameplayJournal(failureDirectory).readMovementTurnsAfter(failureStreamId, 0, 64).length !== 0 ||
      failureReplayObjects.length !== replayObjectsAfter.length) {
    throw new Error(`movement-turn failure did not roll origin forward safely: ${JSON.stringify({ failureBefore, failureAfter })}`);
  }

  let scenarioSequence = 0;
  async function createWorldScenario(label: string) {
    scenarioSequence++;
    const scenarioId = `${scenarioSequence}-${label}`;
    const scenarioJournal = new OriginGameplayJournal(path.join(directory, `world-scenario-${scenarioId}`));
    const scenarioWorld = new WorldServer({ loadResumablePlayer: async () => null, originJournal: scenarioJournal });
    const messages: string[] = [];
    const scenarioConnection = connection(`scenario-${scenarioId}`, messages);
    scenarioWorld.registerConnection(scenarioConnection);
    const joined = await scenarioWorld.joinPlayer(
      scenarioConnection.id,
      `Proof${scenarioSequence}${label.replace(/[^A-Za-z0-9]/gu, "").slice(0, 12)}`,
    );
    if (typeof joined === "string" || !joined.resumeToken) {
      throw new Error(`${label} scenario join failed: ${joined}`);
    }
    const scenarioFloor = scenarioWorld.buildView(joined).floor;
    if (!scenarioFloor.movementAuthority) throw new Error(`${label} scenario has no movement authority`);
    scenarioFloor.monsters = [];
    scenarioFloor.items = [];
    scenarioFloor.traps = [];
    joined.phase = "playing";
    joined.state.alive = true;
    joined.state.entity.hp = 999;
    joined.state.entity.maxHp = 999;
    joined.state.hunger = 800;
    joined.state.maxHunger = 1_000;
    joined.state.hungerState = "normal";
    joined.state.immobilizedTurns = 0;
    joined.state.statuses = [];
    return {
      label,
      journal: scenarioJournal,
      world: scenarioWorld,
      player: joined,
      floor: scenarioFloor,
      messages,
    };
  }

  type WorldScenario = Awaited<ReturnType<typeof createWorldScenario>>;

  function originSnapshot(value: OnlinePlayer) {
    return {
      x: value.state.entity.x,
      y: value.state.entity.y,
      turns: value.state.turns,
      hunger: value.state.hunger,
      hungerState: value.state.hungerState,
      hp: value.state.entity.hp,
      alive: value.state.alive,
      phase: value.phase,
      floorDepth: value.floorDepth,
      stateDepth: value.state.depth,
      immobilizedTurns: value.state.immobilizedTurns ?? 0,
    };
  }

  function scenarioStreamId(scenario: WorldScenario): string {
    return movementTurnJournalStreamId(
      scenario.player.id,
      movementJournalRunId(scenario.player.resumeToken!),
      scenario.floor.movementAuthority!,
    );
  }

  async function replayWorldScenario(options: {
    scenario: WorldScenario;
    originBefore: ReturnType<typeof originSnapshot>;
    originAfter: ReturnType<typeof originSnapshot>;
    expected: Parameters<typeof assertEnvelopeSemantics>[2];
  }) {
    const { scenario } = options;
    const streamId = scenarioStreamId(scenario);
    const envelopes = scenario.journal.readMovementTurnsAfter(streamId, 0, 64);
    if (envelopes.length !== 1) {
      throw new Error(`${scenario.label} scenario published ${envelopes.length} movement-turn envelopes`);
    }
    const envelope = envelopes[0]!;
    const semantics = assertEnvelopeSemantics(scenario.label, envelope, options.expected);
    const legacyMovementStreamId = movementJournalStreamId(
      scenario.player.id,
      movementJournalRunId(scenario.player.resumeToken!),
      scenario.floor.movementAuthority!,
    );
    if (scenario.journal.readAfter(scenario.player.id, 0, 64).length !== 0 ||
        scenario.journal.readAfter(legacyMovementStreamId, 0, 64).length !== 0 ||
        scenario.world.getStats().shadowEvidenceDegraded) {
      throw new Error(`${scenario.label} scenario leaked legacy evidence or degraded origin parity`);
    }
    const objectCountBefore = (await harness.getWorker().listDurableObjectIds("SHADOW_REPLAYS")).length;
    const replay = await catchUpMovementTurnJournal({
      journal: scenario.journal,
      streamId,
      route: validateShadowRoute(envelope.movement.beforeState.authority),
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      fetchImpl: harnessFetch,
    });
    const objectCountAfter = (await harness.getWorker().listDurableObjectIds("SHADOW_REPLAYS")).length;
    if (!replay.caughtUp || replay.backpressured || replay.checkpoint !== 1 ||
        replay.accepted !== 1 || replay.duplicates !== 0 ||
        replay.lastEnvelopeHash !== envelope.envelopeHash ||
        replay.movementStateHash !== envelope.movement.afterStateHash ||
        replay.turnStateHash !== (envelope.turn?.afterStateHash ?? null) ||
        replay.terminal !== (envelope.turn?.terminal ?? envelope.movement.terminal) ||
        objectCountAfter !== objectCountBefore + 1) {
      throw new Error(`${scenario.label} Worker parity failed: ${JSON.stringify(replay)}`);
    }
    return {
      streamId,
      action: envelope.movement.command,
      originBefore: options.originBefore,
      originAfter: options.originAfter,
      semantics,
      envelopeHash: envelope.envelopeHash,
      movementEntryHash: envelope.movement.entryHash,
      turnEntryHash: envelope.turn?.entryHash ?? null,
      Worker: replay,
      durableObjectDelta: objectCountAfter - objectCountBefore,
    };
  }

  const boundsScenario = await createWorldScenario("bounds");
  boundsScenario.player.state.entity.x = 0;
  boundsScenario.player.state.entity.y = 0;
  const boundsBefore = originSnapshot(boundsScenario.player);
  boundsScenario.world.handleInput(boundsScenario.player.id, "h");
  const boundsAfter = originSnapshot(boundsScenario.player);
  if (boundsAfter.x !== boundsBefore.x || boundsAfter.y !== boundsBefore.y ||
      boundsAfter.turns !== boundsBefore.turns || boundsAfter.hunger !== boundsBefore.hunger ||
      !boundsScenario.player.messages.includes("You bump into a wall.")) {
    throw new Error(`bounds origin result mismatch: ${JSON.stringify({ boundsBefore, boundsAfter })}`);
  }
  const boundsProof = await replayWorldScenario({
    scenario: boundsScenario,
    originBefore: boundsBefore,
    originAfter: boundsAfter,
    expected: { outcome: "blocked_terrain", movementEvents: ["message:wall"], turnEvents: [] },
  });

  const doorScenario = await createWorldScenario("door");
  const doorStep = findOrdinaryStep(doorScenario.floor);
  if (!doorStep) throw new Error("door scenario has no ordinary step");
  const doorTarget = { x: doorStep.x + doorStep.dx, y: doorStep.y + doorStep.dy };
  doorScenario.floor.dungeon.tiles[doorTarget.y]![doorTarget.x] = "+";
  doorScenario.player.state.entity.x = doorStep.x;
  doorScenario.player.state.entity.y = doorStep.y;
  const doorBefore = originSnapshot(doorScenario.player);
  doorScenario.world.handleInput(doorScenario.player.id, doorStep.key);
  const doorAfter = originSnapshot(doorScenario.player);
  if (doorAfter.x !== doorTarget.x || doorAfter.y !== doorTarget.y ||
      doorAfter.turns !== doorBefore.turns + 1 || doorAfter.hunger !== doorBefore.hunger - 2 ||
      doorAfter.floorDepth !== doorBefore.floorDepth) {
    throw new Error(`door origin result mismatch: ${JSON.stringify({ doorBefore, doorAfter })}`);
  }
  const doorProof = await replayWorldScenario({
    scenario: doorScenario,
    originBefore: doorBefore,
    originAfter: doorAfter,
    expected: {
      outcome: "moved",
      movementEvents: ["moved", "door_crossed", "pickup_intent", "room_step_intent", "turn_intent", "visibility_intent"],
      turnEvents: [],
    },
  });

  const combatScenario = await createWorldScenario("combat");
  const combatStep = findOrdinaryStep(combatScenario.floor);
  if (!combatStep) throw new Error("combat scenario has no ordinary step");
  const combatTarget = { x: combatStep.x + combatStep.dx, y: combatStep.y + combatStep.dy };
  const proofMonster = createMonster("rat", combatTarget.x, combatTarget.y, combatScenario.floor.depth);
  proofMonster.hp = 999;
  proofMonster.maxHp = 999;
  proofMonster.attack = 1;
  proofMonster.traits = [];
  proofMonster.ai = "wander";
  combatScenario.floor.monsters = [proofMonster];
  combatScenario.player.state.entity.x = combatStep.x;
  combatScenario.player.state.entity.y = combatStep.y;
  const combatBefore = originSnapshot(combatScenario.player);
  const combatMessageStart = combatScenario.player.messages.length;
  combatScenario.world.handleInput(combatScenario.player.id, combatStep.key);
  const combatAfter = originSnapshot(combatScenario.player);
  const combatMessages = combatScenario.player.messages.slice(combatMessageStart);
  if (combatAfter.x !== combatBefore.x || combatAfter.y !== combatBefore.y ||
      combatAfter.turns !== combatBefore.turns + 1 || combatAfter.hunger !== combatBefore.hunger - 2 ||
      !combatAfter.alive || !combatMessages.some((message) => /rat/iu.test(message))) {
    throw new Error(`combat origin result mismatch: ${JSON.stringify({ combatBefore, combatAfter, combatMessages })}`);
  }
  const combatProof = {
    ...await replayWorldScenario({
      scenario: combatScenario,
      originBefore: combatBefore,
      originAfter: combatAfter,
      expected: {
        outcome: "combat_intent",
        movementEvents: ["combat_intent", "turn_intent", "visibility_intent"],
        turnEvents: [],
      },
    }),
    combatMessages,
    monsterHpAfter: proofMonster.hp,
  };
  // The movement envelope only records the blocked movement/combat intent. The
  // separately durable combat envelope carries the origin-sampled transcript
  // and deterministic defender transition, so prove its real Worker route too.
  const combatStreamId = combatTurnJournalStreamId(
    combatScenario.player.id,
    movementJournalRunId(combatScenario.player.resumeToken!),
    combatScenario.floor.movementAuthority!,
  );
  const [combatEnvelope, ...unexpectedCombatEnvelopes] = combatScenario.journal.readCombatTurnsAfter(
    combatStreamId,
    0,
    64,
  );
  if (!combatEnvelope || unexpectedCombatEnvelopes.length > 0 ||
      combatEnvelope.route.realmId !== combatScenario.floor.movementAuthority!.realmId ||
      combatEnvelope.route.floorInstanceId !== combatScenario.floor.movementAuthority!.floorInstanceId ||
      combatEnvelope.route.depth !== combatScenario.floor.movementAuthority!.depth ||
      combatEnvelope.route.floorEpoch !== combatScenario.floor.movementAuthority!.floorEpoch ||
      combatEnvelope.targetKilled || combatEnvelope.terminal) {
    throw new Error(`combat scenario did not publish its expected durable combat envelope: ${JSON.stringify({
      combatStreamId,
      combatEnvelope,
      unexpectedCount: unexpectedCombatEnvelopes.length,
    })}`);
  }
  const combatFirstAckHolder: { value: Record<string, unknown> | null } = { value: null };
  let combatResponseLossObserved = false;
  try {
    await catchUpCombatTurnJournal({
      journal: combatScenario.journal,
      streamId: combatStreamId,
      route: combatEnvelope.route,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      fetchImpl: async (input, init) => {
        const response = await harnessFetch(input, init);
        combatFirstAckHolder.value = await response.clone().json() as Record<string, unknown>;
        throw new Error("deliberate combat response loss");
      },
    });
  } catch (error) {
    combatResponseLossObserved = error instanceof ShadowCatchupError &&
      error.status === 503 && error.code === "deliberate combat response loss";
  }
  const combatFirstAck = combatFirstAckHolder.value;
  if (!combatResponseLossObserved || !combatFirstAck ||
      combatFirstAck.streamId !== combatStreamId || combatFirstAck.checkpoint !== 1 ||
      combatFirstAck.accepted !== 1 || combatFirstAck.duplicates !== 0 ||
      combatFirstAck.lastEnvelopeHash !== combatEnvelope.envelopeHash ||
      combatFirstAck.combatStateHash !== combatEnvelope.afterStateHash ||
      combatFirstAck.turnStateHash !== combatEnvelope.turn.afterStateHash ||
      combatFirstAck.terminal !== false) {
    throw new Error(`combat response-loss commit was not observed: ${JSON.stringify(combatFirstAck)}`);
  }
  const combatRetry = await catchUpCombatTurnJournal({
    journal: combatScenario.journal,
    streamId: combatStreamId,
    route: combatEnvelope.route,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    fetchImpl: harnessFetch,
  });
  if (!combatRetry.caughtUp || combatRetry.backpressured || combatRetry.checkpoint !== 1 ||
      combatRetry.accepted !== 0 || combatRetry.duplicates !== 1 ||
      combatRetry.lastEnvelopeHash !== combatEnvelope.envelopeHash ||
      combatRetry.combatStateHash !== combatEnvelope.afterStateHash ||
      combatRetry.turnStateHash !== combatEnvelope.turn.afterStateHash || combatRetry.terminal) {
    throw new Error(`combat response-loss retry failed: ${JSON.stringify(combatRetry)}`);
  }
  Object.assign(combatProof, {
    combatStreamId,
    combatEnvelopeHash: combatEnvelope.envelopeHash,
    combatTurnEntryHash: combatEnvelope.turn.entryHash,
    combatResponseLossObserved,
    firstCombatAcknowledgement: combatFirstAck,
    combatRetryAcknowledgement: combatRetry,
  });

  const trapScenario = await createWorldScenario("trap");
  const trapStep = findOrdinaryStep(trapScenario.floor);
  if (!trapStep) throw new Error("trap scenario has no ordinary step");
  const trapTarget = { x: trapStep.x + trapStep.dx, y: trapStep.y + trapStep.dy };
  const proofTrap = {
    id: "proof-bear-trap",
    kind: "bear" as const,
    x: trapTarget.x,
    y: trapTarget.y,
    revealed: false,
    sprung: false,
  };
  trapScenario.floor.traps = [proofTrap];
  trapScenario.player.state.entity.x = trapStep.x;
  trapScenario.player.state.entity.y = trapStep.y;
  const trapBefore = originSnapshot(trapScenario.player);
  const trapMessageStart = trapScenario.player.messages.length;
  trapScenario.world.handleInput(trapScenario.player.id, trapStep.key);
  const trapAfter = originSnapshot(trapScenario.player);
  const trapMessages = trapScenario.player.messages.slice(trapMessageStart);
  if (trapAfter.x !== trapTarget.x || trapAfter.y !== trapTarget.y ||
      trapAfter.turns !== trapBefore.turns + 1 || trapAfter.hunger !== trapBefore.hunger - 2 ||
      !proofTrap.sprung || trapAfter.immobilizedTurns < 1 ||
      !trapMessages.some((message) => /bear trap/iu.test(message))) {
    throw new Error(`trap origin result mismatch: ${JSON.stringify({ trapBefore, trapAfter, proofTrap, trapMessages })}`);
  }
  const trapProof = {
    ...await replayWorldScenario({
      scenario: trapScenario,
      originBefore: trapBefore,
      originAfter: trapAfter,
      expected: {
        outcome: "moved",
        movementEvents: ["moved", "pickup_intent", "trap_intent", "room_step_intent", "turn_intent", "visibility_intent"],
        turnEvents: [],
      },
    }),
    trap: proofTrap,
    trapMessages,
  };

  const transferScenario = await createWorldScenario("transfer");
  const stairs = transferScenario.floor.dungeon.stairsDown;
  const transferStep = directions.map((direction) => ({
    ...direction,
    x: stairs.x - direction.dx,
    y: stairs.y - direction.dy,
  })).find((candidate) => isWalkable(
    transferScenario.floor.dungeon.tiles,
    candidate.x,
    candidate.y,
  ));
  if (!transferStep) throw new Error("transfer scenario has no walkable stairs approach");
  transferScenario.player.state.entity.x = transferStep.x;
  transferScenario.player.state.entity.y = transferStep.y;
  const transferBefore = originSnapshot(transferScenario.player);
  const transferMessageStart = transferScenario.player.messages.length;
  transferScenario.world.handleInput(transferScenario.player.id, transferStep.key);
  const transferAfter = originSnapshot(transferScenario.player);
  const transferMessages = transferScenario.player.messages.slice(transferMessageStart);
  if (transferAfter.floorDepth !== transferBefore.floorDepth + 1 ||
      transferAfter.stateDepth !== transferBefore.stateDepth + 1 ||
      transferAfter.turns !== transferBefore.turns + 1 || transferAfter.hunger !== transferBefore.hunger - 2 ||
      !transferMessages.some((message) => message === `You descend to depth ${transferAfter.floorDepth}.`)) {
    throw new Error(`transfer origin result mismatch: ${JSON.stringify({ transferBefore, transferAfter, transferMessages })}`);
  }
  const transferProof = await replayWorldScenario({
    scenario: transferScenario,
    originBefore: transferBefore,
    originAfter: transferAfter,
    expected: {
      outcome: "moved",
      movementEvents: ["moved", "pickup_intent", "room_step_intent", "transfer_intent", "turn_intent", "visibility_intent"],
      turnEvents: [],
    },
  });

  const terminalScenario = await createWorldScenario("terminal");
  const terminalStep = findOrdinaryStep(terminalScenario.floor);
  if (!terminalStep) throw new Error("terminal scenario has no ordinary step");
  terminalScenario.player.state.entity.x = terminalStep.x;
  terminalScenario.player.state.entity.y = terminalStep.y;
  terminalScenario.player.state.hunger = 1;
  terminalScenario.player.state.hungerState = "starving";
  terminalScenario.player.state.entity.hp = 3;
  terminalScenario.player.state.entity.maxHp = 3;
  const terminalBefore = originSnapshot(terminalScenario.player);
  terminalScenario.world.handleInput(terminalScenario.player.id, terminalStep.key);
  const terminalAfter = originSnapshot(terminalScenario.player);
  if (terminalAfter.x !== terminalStep.x + terminalStep.dx ||
      terminalAfter.y !== terminalStep.y + terminalStep.dy ||
      terminalAfter.turns !== terminalBefore.turns + 1 || terminalAfter.hunger !== 0 ||
      terminalAfter.hp !== 0 || terminalAfter.alive || terminalAfter.phase !== "dead" ||
      !terminalScenario.player.messages.includes("You have starved to death...")) {
    throw new Error(`terminal origin result mismatch: ${JSON.stringify({ terminalBefore, terminalAfter })}`);
  }
  const terminalMovementProof = await replayWorldScenario({
    scenario: terminalScenario,
    originBefore: terminalBefore,
    originAfter: terminalAfter,
    expected: {
      outcome: "moved",
      movementEvents: ["moved", "pickup_intent", "room_step_intent", "turn_intent", "visibility_intent"],
      turnEvents: ["message:Hunger deals 3 damage.", "starved", "message:You have starved to death..."],
      terminal: true,
    },
  });

  const bulkJournal = new OriginGameplayJournal(path.join(directory, "movement-turn-bulk-journal"));
  const bulkRoute = {
    ...route,
    floorInstanceId: "bulk-reload-proof",
  } as const;
  const bulkStreamId = movementTurnJournalStreamId(
    "bulk-player",
    movementJournalRunId("b".repeat(64)),
    bulkRoute,
  );
  let bulkMovementState: MovementState = {
    authority: { ...bulkRoute },
    x: 10,
    y: 10,
    phase: "playing",
    alive: true,
    immobilizedTurns: 0,
    destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  };
  let bulkGameplayState: GameplayState = {
    turns: 0,
    depth: 1,
    hunger: 2_000,
    maxHunger: 2_000,
    hungerState: "satiated",
    hp: 999,
    alive: true,
  };
  for (let cursor = 1; cursor <= 300; cursor++) {
    const command = { type: "move", dx: cursor % 2 === 1 ? 1 : -1, dy: 0 } as const;
    const beforeState: MovementState = {
      ...bulkMovementState,
      authority: { ...bulkMovementState.authority },
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const turnCommand = { type: "advance_turn", action: "other" } as const;
    const append = bulkJournal.appendMovementTurn({
      streamId: bulkStreamId,
      operationId: `00000000-0000-4000-8000-${cursor.toString(16).padStart(12, "0")}`,
      command,
      beforeState,
      turn: { command: turnCommand, beforeState: bulkGameplayState },
    });
    if (append.status !== "appended") {
      throw new Error(`bulk movement-turn append ${cursor} failed: ${JSON.stringify(append)}`);
    }
    bulkMovementState = reduceMovement(beforeState, command).state;
    bulkGameplayState = reduceGameplay(bulkGameplayState, turnCommand).state;
  }
  const bulkPageBoundaryEnvelope = bulkJournal.readMovementTurnsAfter(bulkStreamId, 63, 1)[0];
  const bulkFinalEnvelope = bulkJournal.readMovementTurnsAfter(bulkStreamId, 299, 1)[0];
  if (!bulkPageBoundaryEnvelope || bulkPageBoundaryEnvelope.cursor !== 64 ||
      !bulkFinalEnvelope || bulkFinalEnvelope.cursor !== 300) {
    throw new Error("bulk origin journal did not preserve the 64/300 page boundaries");
  }
  const bulkFirstAcknowledgementHolder: { value: Record<string, unknown> | null } = { value: null };
  let bulkResponseLossObserved = false;
  try {
    await catchUpMovementTurnJournal({
      journal: bulkJournal,
      streamId: bulkStreamId,
      route: bulkRoute,
      endpoint: "http://worker.local/internal/shadow/catch-up",
      secret,
      maxEntriesPerBatch: 64,
      maxBatches: 1,
      maxDurationMs: 60_000,
      fetchImpl: async (input, init) => {
        const response = await harnessFetch(input, init);
        bulkFirstAcknowledgementHolder.value = await response.clone().json() as Record<string, unknown>;
        throw new Error("deliberate bulk page-boundary response loss");
      },
    });
  } catch (error) {
    bulkResponseLossObserved = error instanceof Error &&
      error.message === "deliberate bulk page-boundary response loss";
  }
  const bulkFirstAcknowledgement = bulkFirstAcknowledgementHolder.value;
  if (!bulkResponseLossObserved || !bulkFirstAcknowledgement ||
      bulkFirstAcknowledgement.streamId !== bulkStreamId ||
      bulkFirstAcknowledgement.checkpoint !== 64 || bulkFirstAcknowledgement.accepted !== 64 ||
      bulkFirstAcknowledgement.duplicates !== 0 || bulkFirstAcknowledgement.terminal !== false ||
      bulkFirstAcknowledgement.lastEnvelopeHash !== bulkPageBoundaryEnvelope.envelopeHash ||
      bulkFirstAcknowledgement.movementStateHash !== bulkPageBoundaryEnvelope.movement.afterStateHash ||
      bulkFirstAcknowledgement.turnStateHash !== bulkPageBoundaryEnvelope.turn?.afterStateHash) {
    throw new Error(`bulk first-page commit was not observed: ${JSON.stringify(bulkFirstAcknowledgement)}`);
  }
  const durableObjectsBeforeReload = (await harness.getWorker().listDurableObjectIds("SHADOW_REPLAYS")).sort();
  await harness.update((current) => current);
  const durableObjectsAfterReload = (await harness.getWorker().listDurableObjectIds("SHADOW_REPLAYS")).sort();
  const durableObjectIdsPreserved = JSON.stringify(durableObjectsAfterReload) ===
    JSON.stringify(durableObjectsBeforeReload);
  const bulkRetry = await catchUpMovementTurnJournal({
    journal: bulkJournal,
    streamId: bulkStreamId,
    route: bulkRoute,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    cursor: 0,
    maxEntriesPerBatch: 64,
    maxBatches: 5,
    maxDurationMs: 60_000,
    fetchImpl: harnessFetch,
  });
  const reloadStoragePreserved = bulkRetry.duplicates === 64 && bulkRetry.accepted === 236;
  const reloadStorageRecreated = bulkRetry.duplicates === 0 && bulkRetry.accepted === 300;
  if (!bulkRetry.caughtUp || bulkRetry.backpressured || bulkRetry.checkpoint !== 300 ||
      (!reloadStoragePreserved && !reloadStorageRecreated) ||
      bulkRetry.lastEnvelopeHash !== bulkFinalEnvelope.envelopeHash ||
      bulkRetry.movementStateHash !== bulkFinalEnvelope.movement.afterStateHash ||
      bulkRetry.turnStateHash !== bulkFinalEnvelope.turn?.afterStateHash || bulkRetry.terminal) {
    throw new Error(`bulk response-loss/reload parity failed: ${JSON.stringify(bulkRetry)}`);
  }
  if (reloadStoragePreserved && !durableObjectIdsPreserved) {
    throw new Error("bulk reload retained receipts but lost the Durable Object storage identity listing");
  }
  const bulkCompactedRecovery = await catchUpMovementTurnJournal({
    journal: bulkJournal,
    streamId: bulkStreamId,
    route: bulkRoute,
    endpoint: "http://worker.local/internal/shadow/catch-up",
    secret,
    cursor: 0,
    maxEntriesPerBatch: 64,
    maxBatches: 2,
    maxDurationMs: 60_000,
    fetchImpl: harnessFetch,
  });
  if (!bulkCompactedRecovery.caughtUp || bulkCompactedRecovery.backpressured ||
      bulkCompactedRecovery.checkpoint !== 300 || bulkCompactedRecovery.accepted !== 0 ||
      bulkCompactedRecovery.duplicates !== 0 ||
      bulkCompactedRecovery.lastEnvelopeHash !== bulkFinalEnvelope.envelopeHash ||
      bulkCompactedRecovery.movementStateHash !== bulkFinalEnvelope.movement.afterStateHash ||
      bulkCompactedRecovery.turnStateHash !== bulkFinalEnvelope.turn?.afterStateHash ||
      bulkCompactedRecovery.terminal) {
    throw new Error(`bulk compacted checkpoint recovery failed: ${JSON.stringify(bulkCompactedRecovery)}`);
  }
  const bulkProof = {
    streamId: bulkStreamId,
    envelopes: 300,
    pageSize: 64,
    responseLossObserved: bulkResponseLossObserved,
    firstHiddenAcknowledgement: bulkFirstAcknowledgement,
    runtimeReconstruction: {
      method: "harness.update(current => current)",
      claim: "supported Worker reload with persisted-ID and receipt checks; explicit DO instance eviction is not independently observable",
      explicitDurableObjectEvictionApiAvailable: false,
      durableObjectIdsBefore: durableObjectsBeforeReload,
      durableObjectIdsAfter: durableObjectsAfterReload,
      durableObjectIdsPreserved,
      storageResult: reloadStoragePreserved ? "preserved" : "recreated",
      requestedDuplicateProofSatisfied: reloadStoragePreserved,
    },
    retryFromCursorZero: bulkRetry,
    compactedCheckpointRecovery: bulkCompactedRecovery,
    finalEnvelopeHash: bulkFinalEnvelope.envelopeHash,
    finalMovementStateHash: bulkFinalEnvelope.movement.afterStateHash,
    finalTurnStateHash: bulkFinalEnvelope.turn?.afterStateHash ?? null,
  };

  const movementTurnProof = {
    headSha,
    sourceState,
    action: { key: ordinaryStep.key, dx: ordinaryStep.dx, dy: ordinaryStep.dy },
    originBefore,
    originAfter,
    semantics: ordinarySemantics,
    streamId: movementTurnStreamId,
    envelopeHash: movementTurnEnvelope.envelopeHash,
    movementEntryHash: movementTurnEnvelope.movement.entryHash,
    turnEntryHash: movementTurnEnvelope.turn.entryHash,
    firstHiddenAcknowledgement: movementTurnFirstAck,
    retryAcknowledgement: movementTurnRetry,
    originEffectsBoundary: {
      priorReducerTurnStateHash: movementTurnEnvelope.turn.afterStateHash,
      nextOriginTurnBeforeStateHash: gameplayStateHash(originEffectsEnvelope.turn.beforeState),
      nextEnvelopeHash: originEffectsEnvelope.envelopeHash,
      acknowledgement: movementTurnParity,
    },
    durableObjectDelta: replayObjectsAfter.length - replayObjectsBefore.length,
    failure: {
      originBefore: failureBefore,
      originAfter: failureAfter,
      degraded: failureWorld.getStats().shadowEvidenceDegraded,
      retainedEnvelopes: 0,
      durableObjectDelta: failureReplayObjects.length - replayObjectsAfter.length,
    },
    scenarios: {
      bounds: boundsProof,
      door: doorProof,
      combat: combatProof,
      trap: trapProof,
      transfer: transferProof,
      terminal: terminalMovementProof,
    },
    bulk: bulkProof,
  };
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceState,
    responseLossObserved,
    parity,
    terminalParity,
    divergence,
    eventDivergence,
    continuityDivergence,
    movementTurnProof,
  })}\n`);
} finally {
  try {
    await harness.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
