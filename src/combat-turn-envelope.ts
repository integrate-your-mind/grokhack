import {
  playerMeleeStateHashV1,
  playerMeleeTransitionHashV1,
  reducePlayerMeleeV1,
  type CombatantSnapshotV1,
  type CombatRollTranscriptV1,
  type PlayerMeleeOptionsV1,
} from "./combat-reducer.js";
import {
  createShadowJournalEntry,
  validateShadowRoute,
  validateShadowJournalEntry,
  type GameplayJournalInput,
  type GameplayShadowJournalEntry,
  type ShadowRoute,
} from "./shadow-journal.js";

export const COMBAT_TURN_ENVELOPE_VERSION = 1 as const;

export interface CombatTurnEnvelopeV1 {
  v: typeof COMBAT_TURN_ENVELOPE_VERSION;
  kind: "combat_turn";
  streamId: string;
  route: ShadowRoute;
  cursor: number;
  operationId: string;
  attacker: CombatantSnapshotV1;
  defender: CombatantSnapshotV1;
  options: PlayerMeleeOptionsV1;
  transcript: CombatRollTranscriptV1;
  turn: GameplayShadowJournalEntry;
  beforeStateHash: string;
  afterStateHash: string;
  targetKilled: boolean;
  terminal: boolean;
  previousEnvelopeHash: string | null;
  envelopeHash: string;
}

export interface CombatTurnEnvelopeInput {
  streamId: string;
  route: ShadowRoute;
  cursor: number;
  operationId: string;
  attacker: CombatantSnapshotV1;
  defender: CombatantSnapshotV1;
  options: PlayerMeleeOptionsV1;
  transcript: CombatRollTranscriptV1;
  turn: Omit<GameplayJournalInput, "streamId" | "cursor" | "previousEntryHash">;
  previousEnvelopeHash?: string | null;
  previousTurnEntryHash?: string | null;
}

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function transcriptHashMaterial(transcript: CombatRollTranscriptV1): string {
  return [
    transcript.hit,
    transcript.missFlavor ?? "-",
    transcript.crit ?? "-",
    transcript.variance ?? "-",
    transcript.swiftSpike ?? "-",
    transcript.severityFlavor ?? "-",
    transcript.killFlavor ?? "-",
  ].join("|");
}

export function combatTurnEnvelopeHash(envelope: Omit<CombatTurnEnvelopeV1, "envelopeHash">): string {
  return fnv64([envelope.v, envelope.kind, envelope.streamId,
    envelope.route.realmId, envelope.route.floorInstanceId, envelope.route.depth,
    envelope.route.floorEpoch, envelope.route.rulesetVersion, envelope.cursor, envelope.operationId,
    envelope.beforeStateHash, envelope.afterStateHash, envelope.targetKilled ? 1 : 0,
    envelope.terminal ? 1 : 0, envelope.turn.entryHash,
    transcriptHashMaterial(envelope.transcript), envelope.previousEnvelopeHash ?? "genesis"].join("|"));
}

export function createCombatTurnEnvelopeV1(input: CombatTurnEnvelopeInput): CombatTurnEnvelopeV1 {
  const { turn: turnInput, previousTurnEntryHash, previousEnvelopeHash = null, ...envelopeInput } = input;
  const route = validateShadowRoute(input.route);
  const result = reducePlayerMeleeV1(input.attacker, input.defender, input.options, input.transcript);
  const turn = createShadowJournalEntry({
    streamId: `${input.streamId}_vitals`,
    cursor: input.cursor,
    command: turnInput.command,
    beforeState: turnInput.beforeState,
    previousEntryHash: previousTurnEntryHash ?? null,
  }) as GameplayShadowJournalEntry;
  const beforeStateHash = playerMeleeStateHashV1(input.attacker, input.defender);
  const afterStateHash = fnv64([
    playerMeleeStateHashV1(input.attacker, result.defender),
    playerMeleeTransitionHashV1(result),
    turn.afterStateHash,
  ].join("|"));
  const unsigned: Omit<CombatTurnEnvelopeV1, "envelopeHash"> = {
    ...envelopeInput, route, turn, v: COMBAT_TURN_ENVELOPE_VERSION, kind: "combat_turn", beforeStateHash, afterStateHash,
    previousEnvelopeHash,
    targetKilled: result.killed, terminal: turn.terminal,
  };
  return { ...unsigned, envelopeHash: combatTurnEnvelopeHash(unsigned) };
}

export function validateCombatTurnEnvelopeV1(value: unknown): CombatTurnEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_combat_turn_envelope");
  const envelope = value as Partial<CombatTurnEnvelopeV1>;
  if (envelope.v !== COMBAT_TURN_ENVELOPE_VERSION || envelope.kind !== "combat_turn" ||
      typeof envelope.streamId !== "string" || !/^combat_[0-9a-f]{48}$/u.test(envelope.streamId) ||
      !Number.isSafeInteger(envelope.cursor) || Number(envelope.cursor) < 1 ||
      typeof envelope.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(envelope.operationId) ||
      (envelope.previousEnvelopeHash !== null && (typeof envelope.previousEnvelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.previousEnvelopeHash))) ||
      typeof envelope.beforeStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.beforeStateHash) ||
      typeof envelope.afterStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.afterStateHash) ||
      typeof envelope.targetKilled !== "boolean" || typeof envelope.terminal !== "boolean" ||
      typeof envelope.envelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.envelopeHash)) {
    throw new Error("invalid_combat_turn_envelope");
  }
  let turn: GameplayShadowJournalEntry;
  try {
    const candidate = validateShadowJournalEntry(envelope.turn);
    if (candidate.v !== 1 || candidate.streamId !== `${envelope.streamId}_vitals` ||
        candidate.cursor !== envelope.cursor) {
      throw new Error("invalid_combat_turn_envelope");
    }
    turn = candidate;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_combat_turn_envelope") throw error;
    throw new Error("invalid_combat_turn_envelope", { cause: error });
  }
  let route: ShadowRoute;
  try { route = validateShadowRoute(envelope.route); }
  catch (error) { throw new Error("invalid_combat_turn_envelope", { cause: error }); }
  const canonical = createCombatTurnEnvelopeV1({
    streamId: envelope.streamId, route, cursor: Number(envelope.cursor), operationId: envelope.operationId,
    attacker: envelope.attacker as CombatantSnapshotV1, defender: envelope.defender as CombatantSnapshotV1,
    options: envelope.options as PlayerMeleeOptionsV1, transcript: envelope.transcript as CombatRollTranscriptV1,
    turn: { command: turn.command, beforeState: turn.beforeState },
    previousEnvelopeHash: envelope.previousEnvelopeHash ?? null,
    previousTurnEntryHash: turn.previousEntryHash,
  });
  if (canonical.beforeStateHash !== envelope.beforeStateHash || canonical.afterStateHash !== envelope.afterStateHash ||
      canonical.targetKilled !== envelope.targetKilled || canonical.terminal !== envelope.terminal ||
      canonical.envelopeHash !== envelope.envelopeHash) {
    throw new Error("combat_turn_envelope_hash_mismatch");
  }
  return canonical;
}
