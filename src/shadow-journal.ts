import {
  gameplayStateHash,
  reduceGameplay,
  type GameplayCommand,
  type GameplayState,
} from "./gameplay-reducer.js";
import {
  movementContinuityHash,
  movementEventHash,
  movementStateHash,
  reduceMovement,
  validateMovementState,
  type MovementCommand,
  type MovementState,
} from "./movement-reducer.js";

export const SHADOW_JOURNAL_VERSION = 1 as const;
export const MOVEMENT_SHADOW_JOURNAL_VERSION = 2 as const;
export const MOVEMENT_RULESET_VERSION = 1 as const;
export const MOVEMENT_TURN_ENVELOPE_VERSION = 1 as const;
export const MAX_SHADOW_BATCH_ENTRIES = 64;
export const MAX_SHADOW_BATCH_BYTES = 256 * 1024;
export const MAX_MOVEMENT_TURN_ENVELOPE_BYTES = 20 * 1024;

export interface ShadowRoute {
  realmId: string;
  floorInstanceId: string;
  depth: number;
  floorEpoch: number;
  rulesetVersion: typeof MOVEMENT_RULESET_VERSION;
}

export interface GameplayShadowJournalEntry {
  v: typeof SHADOW_JOURNAL_VERSION;
  streamId: string;
  cursor: number;
  command: GameplayCommand;
  beforeState: GameplayState;
  beforeStateHash: string;
  afterStateHash: string;
  terminal: boolean;
  previousEntryHash: string | null;
  entryHash: string;
}

export interface MovementShadowJournalEntry {
  v: typeof MOVEMENT_SHADOW_JOURNAL_VERSION;
  streamId: string;
  cursor: number;
  command: MovementCommand;
  beforeState: MovementState;
  beforeStateHash: string;
  beforeContinuityHash: string;
  afterStateHash: string;
  afterContinuityHash: string;
  eventHash: string;
  terminal: boolean;
  previousEntryHash: string | null;
  entryHash: string;
}

export type ShadowJournalEntry = GameplayShadowJournalEntry | MovementShadowJournalEntry;
export type UnsignedShadowJournalEntry =
  | Omit<GameplayShadowJournalEntry, "entryHash">
  | Omit<MovementShadowJournalEntry, "entryHash">;

export interface GameplayJournalInput {
  streamId: string;
  cursor: number;
  command: GameplayCommand;
  beforeState: GameplayState;
  previousEntryHash?: string | null;
}

export interface MovementJournalInput {
  streamId: string;
  cursor: number;
  command: MovementCommand;
  beforeState: MovementState;
  previousEntryHash?: string | null;
}

/**
 * Additive atomic publication unit for one movement decision and its optional
 * turn/vitals follow-up. Frozen V1/V2 entries remain unchanged; neither nested
 * entry is a standalone catch-up record when carried by this envelope.
 */
export interface MovementTurnEnvelope {
  v: typeof MOVEMENT_TURN_ENVELOPE_VERSION;
  kind: "movement_turn";
  streamId: string;
  cursor: number;
  operationId: string;
  movement: MovementShadowJournalEntry;
  turn: GameplayShadowJournalEntry | null;
  previousEnvelopeHash: string | null;
  envelopeHash: string;
}

export interface MovementTurnEnvelopeInput {
  streamId: string;
  cursor: number;
  operationId: string;
  command: MovementCommand;
  beforeState: MovementState;
  turn?: {
    command: GameplayCommand;
    beforeState: GameplayState;
  } | null;
  previousEnvelopeHash?: string | null;
  previousMovementEntryHash?: string | null;
  previousTurnEntryHash?: string | null;
}

export type ShadowJournalInput = GameplayJournalInput | MovementJournalInput;
export type ShadowEntryForInput<T extends ShadowJournalInput> =
  T extends GameplayJournalInput ? GameplayShadowJournalEntry : MovementShadowJournalEntry;

export interface ShadowCatchupBatch {
  v: typeof SHADOW_JOURNAL_VERSION;
  route: ShadowRoute;
  entries: readonly ShadowJournalEntry[];
}

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function movementTurnEnvelopeHash(
  envelope: Omit<MovementTurnEnvelope, "envelopeHash">,
): string {
  return fnv64([
    envelope.v,
    envelope.kind,
    envelope.streamId,
    envelope.cursor,
    envelope.operationId,
    envelope.movement.entryHash,
    envelope.turn?.entryHash ?? "no-turn",
    envelope.previousEnvelopeHash ?? "genesis",
  ].join("|"));
}

export function createMovementTurnEnvelope(input: MovementTurnEnvelopeInput): MovementTurnEnvelope {
  const movement = createShadowJournalEntry({
    streamId: `${input.streamId}_movement`,
    cursor: input.cursor,
    command: input.command,
    beforeState: input.beforeState,
    previousEntryHash: input.previousMovementEntryHash ?? null,
  });
  const turn = input.turn
    ? createShadowJournalEntry({
        streamId: `${input.streamId}_vitals`,
        cursor: input.cursor,
        command: input.turn.command,
        beforeState: input.turn.beforeState,
        previousEntryHash: input.previousTurnEntryHash ?? null,
      })
    : null;
  const unsigned: Omit<MovementTurnEnvelope, "envelopeHash"> = {
    v: MOVEMENT_TURN_ENVELOPE_VERSION,
    kind: "movement_turn",
    streamId: input.streamId,
    cursor: input.cursor,
    operationId: input.operationId,
    movement,
    turn,
    previousEnvelopeHash: input.previousEnvelopeHash ?? null,
  };
  return { ...unsigned, envelopeHash: movementTurnEnvelopeHash(unsigned) };
}

export function validateMovementTurnEnvelope(value: unknown): MovementTurnEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_movement_turn_envelope");
  const envelope = value as Partial<MovementTurnEnvelope>;
  if (envelope.v !== MOVEMENT_TURN_ENVELOPE_VERSION || envelope.kind !== "movement_turn" ||
      typeof envelope.streamId !== "string" || !/^turn_[0-9a-f]{48}$/u.test(envelope.streamId) ||
      !Number.isSafeInteger(envelope.cursor) || Number(envelope.cursor) < 1 ||
      typeof envelope.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(envelope.operationId) ||
      (envelope.previousEnvelopeHash !== null &&
        (typeof envelope.previousEnvelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.previousEnvelopeHash))) ||
      typeof envelope.envelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.envelopeHash)) {
    throw new Error("invalid_movement_turn_envelope");
  }
  const movement = validateShadowJournalEntry(envelope.movement);
  if (movement.v !== MOVEMENT_SHADOW_JOURNAL_VERSION ||
      movement.streamId !== `${envelope.streamId}_movement` || movement.cursor !== envelope.cursor) {
    throw new Error("invalid_movement_turn_envelope");
  }
  let turn: GameplayShadowJournalEntry | null = null;
  if (envelope.turn !== null) {
    const candidate = validateShadowJournalEntry(envelope.turn);
    if (candidate.v !== SHADOW_JOURNAL_VERSION ||
        candidate.streamId !== `${envelope.streamId}_vitals` || candidate.cursor !== envelope.cursor) {
      throw new Error("invalid_movement_turn_envelope");
    }
    turn = candidate;
  }
  const movementTransition = reduceMovement(movement.beforeState, movement.command);
  if ((movementTransition.turnCost === "none") !== (turn === null)) {
    throw new Error("movement_turn_pair_mismatch");
  }
  const validated: MovementTurnEnvelope = {
    v: MOVEMENT_TURN_ENVELOPE_VERSION,
    kind: "movement_turn",
    streamId: envelope.streamId,
    cursor: Number(envelope.cursor),
    operationId: envelope.operationId,
    movement,
    turn,
    previousEnvelopeHash: envelope.previousEnvelopeHash ?? null,
    envelopeHash: envelope.envelopeHash,
  };
  const unsigned = { ...validated } as Omit<MovementTurnEnvelope, "envelopeHash"> & { envelopeHash?: string };
  delete unsigned.envelopeHash;
  if (validated.envelopeHash !== movementTurnEnvelopeHash(unsigned)) {
    throw new Error("movement_turn_envelope_hash_mismatch");
  }
  return validated;
}

export function shadowEntryHash(entry: UnsignedShadowJournalEntry): string {
  if (entry.v === SHADOW_JOURNAL_VERSION) {
    // V1 hash material is frozen for historical segment compatibility.
    return fnv64([
      entry.v,
      entry.streamId,
      entry.cursor,
      entry.command.type,
      entry.command.action,
      entry.beforeStateHash,
      entry.afterStateHash,
      entry.terminal ? 1 : 0,
      entry.previousEntryHash ?? "genesis",
    ].join("|"));
  }
  return fnv64([
    entry.v,
    entry.streamId,
    entry.cursor,
    entry.command.type,
    entry.command.dx,
    entry.command.dy,
    entry.beforeStateHash,
    entry.beforeContinuityHash,
    entry.afterStateHash,
    entry.afterContinuityHash,
    entry.eventHash,
    entry.terminal ? 1 : 0,
    entry.previousEntryHash ?? "genesis",
  ].join("|"));
}

export function createShadowJournalEntry<T extends ShadowJournalInput>(input: T): ShadowEntryForInput<T> {
  if (input.command.type === "advance_turn") {
    const transition = reduceGameplay(input.beforeState as GameplayState, input.command);
    const unsigned: Omit<GameplayShadowJournalEntry, "entryHash"> = {
      v: SHADOW_JOURNAL_VERSION,
      streamId: input.streamId,
      cursor: input.cursor,
      command: input.command,
      beforeState: { ...(input.beforeState as GameplayState) },
      beforeStateHash: gameplayStateHash(input.beforeState as GameplayState),
      afterStateHash: gameplayStateHash(transition.state),
      terminal: !transition.state.alive,
      previousEntryHash: input.previousEntryHash ?? null,
    };
    return { ...unsigned, entryHash: shadowEntryHash(unsigned) } as ShadowEntryForInput<T>;
  }
  const beforeState = input.beforeState as MovementState;
  const transition = reduceMovement(beforeState, input.command);
  const unsigned: Omit<MovementShadowJournalEntry, "entryHash"> = {
    v: MOVEMENT_SHADOW_JOURNAL_VERSION,
    streamId: input.streamId,
    cursor: input.cursor,
    command: input.command,
    beforeState: {
      ...beforeState,
      authority: { ...beforeState.authority },
      destination: { ...beforeState.destination },
    },
    beforeStateHash: movementStateHash(beforeState),
    beforeContinuityHash: movementContinuityHash(beforeState),
    afterStateHash: movementStateHash(transition.state),
    afterContinuityHash: movementContinuityHash(transition.state),
    eventHash: movementEventHash(transition),
    terminal: !transition.state.alive,
    previousEntryHash: input.previousEntryHash ?? null,
  };
  return { ...unsigned, entryHash: shadowEntryHash(unsigned) } as ShadowEntryForInput<T>;
}

export function validateShadowJournalEntry(value: unknown): ShadowJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_entry");
  const entry = value as Record<string, unknown>;
  if ((entry.v !== SHADOW_JOURNAL_VERSION && entry.v !== MOVEMENT_SHADOW_JOURNAL_VERSION) ||
      typeof entry.streamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.streamId) ||
      !Number.isSafeInteger(entry.cursor) || Number(entry.cursor) < 1 ||
      !entry.command || typeof entry.command !== "object" || Array.isArray(entry.command) ||
      !entry.beforeState || typeof entry.beforeState !== "object" || Array.isArray(entry.beforeState) ||
      typeof entry.beforeStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.beforeStateHash) ||
      typeof entry.afterStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.afterStateHash) ||
      typeof entry.terminal !== "boolean" ||
      (entry.previousEntryHash !== null && (typeof entry.previousEntryHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.previousEntryHash))) ||
      typeof entry.entryHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.entryHash)) {
    throw new Error("invalid_entry");
  }
  const command = entry.command as Record<string, unknown>;
  if (entry.v === SHADOW_JOURNAL_VERSION) {
    if (command.type !== "advance_turn" || (command.action !== "wait" && command.action !== "other")) {
      throw new Error("invalid_entry");
    }
    const state = entry.beforeState as Partial<GameplayState>;
    const hungerStates = new Set(["satiated", "normal", "hungry", "weak", "fainting", "starving"]);
    if (!Number.isSafeInteger(state.turns) || Number(state.turns) < 0 ||
        !Number.isSafeInteger(state.depth) || Number(state.depth) < 1 || Number(state.depth) > 64 ||
        !Number.isSafeInteger(state.hunger) || Number(state.hunger) < 0 ||
        !Number.isSafeInteger(state.maxHunger) || Number(state.maxHunger) < 1 ||
        typeof state.hungerState !== "string" || !hungerStates.has(state.hungerState) ||
        !Number.isSafeInteger(state.hp) || typeof state.alive !== "boolean") {
      throw new Error("invalid_gameplay_state");
    }
    if (entry.beforeStateHash !== gameplayStateHash(entry.beforeState as GameplayState)) {
      throw new Error("before_state_hash_mismatch");
    }
  } else {
    if (command.type !== "move" || !Number.isSafeInteger(command.dx) || !Number.isSafeInteger(command.dy) ||
        Math.abs(Number(command.dx)) > 1 || Math.abs(Number(command.dy)) > 1 ||
        (command.dx === 0 && command.dy === 0) ||
        typeof entry.beforeContinuityHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.beforeContinuityHash) ||
        typeof entry.afterContinuityHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.afterContinuityHash) ||
        typeof entry.eventHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.eventHash)) {
      throw new Error("invalid_entry");
    }
    const state = validateMovementState(entry.beforeState);
    if (entry.beforeStateHash !== movementStateHash(state)) throw new Error("before_state_hash_mismatch");
    if (entry.beforeContinuityHash !== movementContinuityHash(state)) throw new Error("before_continuity_hash_mismatch");
    // Validate command/state reachability here so a hash-valid hostile envelope
    // cannot defer coordinate overflow into an uncaught Durable Object error.
    reduceMovement(state, command as unknown as MovementCommand);
  }
  const unsigned = { ...entry } as Record<string, unknown>;
  delete unsigned.entryHash;
  if (entry.entryHash !== shadowEntryHash(unsigned as UnsignedShadowJournalEntry)) {
    throw new Error("entry_hash_mismatch");
  }
  // The declared after hash is intentionally not recomputed here. The isolated
  // edge replay must do that independently so divergence is visible evidence.
  return entry as unknown as ShadowJournalEntry;
}

export function validateShadowRoute(value: unknown): ShadowRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_route");
  const route = value as Partial<ShadowRoute>;
  if (typeof route.realmId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(route.realmId) ||
      typeof route.floorInstanceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(route.floorInstanceId) ||
      !Number.isSafeInteger(route.depth) || Number(route.depth) < 1 || Number(route.depth) > 64 ||
      !Number.isSafeInteger(route.floorEpoch) || Number(route.floorEpoch) < 1 ||
      route.rulesetVersion !== MOVEMENT_RULESET_VERSION) {
    throw new Error("invalid_route");
  }
  return route as ShadowRoute;
}
