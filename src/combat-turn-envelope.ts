import {
  playerMeleeStateHashV1,
  playerMeleeTransitionHashV1,
  reducePlayerMeleeV1,
  type CombatantSnapshotV1,
  type CombatRollTranscriptV1,
  type PlayerMeleeOptionsV1,
} from "./combat-reducer.js";

export const COMBAT_TURN_ENVELOPE_VERSION = 1 as const;

export interface CombatTurnEnvelopeV1 {
  v: typeof COMBAT_TURN_ENVELOPE_VERSION;
  kind: "combat_turn";
  streamId: string;
  cursor: number;
  operationId: string;
  attacker: CombatantSnapshotV1;
  defender: CombatantSnapshotV1;
  options: PlayerMeleeOptionsV1;
  transcript: CombatRollTranscriptV1;
  beforeStateHash: string;
  afterStateHash: string;
  terminal: boolean;
  previousEnvelopeHash: string | null;
  envelopeHash: string;
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
  return fnv64([envelope.v, envelope.kind, envelope.streamId, envelope.cursor, envelope.operationId,
    envelope.beforeStateHash, envelope.afterStateHash, envelope.terminal ? 1 : 0,
    transcriptHashMaterial(envelope.transcript), envelope.previousEnvelopeHash ?? "genesis"].join("|"));
}

export function createCombatTurnEnvelopeV1(input: Omit<CombatTurnEnvelopeV1, "v" | "kind" | "beforeStateHash" | "afterStateHash" | "terminal" | "envelopeHash">): CombatTurnEnvelopeV1 {
  const result = reducePlayerMeleeV1(input.attacker, input.defender, input.options, input.transcript);
  const beforeStateHash = playerMeleeStateHashV1(input.attacker, input.defender);
  const afterStateHash = fnv64([
    playerMeleeStateHashV1(input.attacker, result.defender),
    playerMeleeTransitionHashV1(result),
  ].join("|"));
  const unsigned: Omit<CombatTurnEnvelopeV1, "envelopeHash"> = {
    ...input, v: COMBAT_TURN_ENVELOPE_VERSION, kind: "combat_turn", beforeStateHash, afterStateHash, terminal: result.killed,
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
      typeof envelope.terminal !== "boolean" || typeof envelope.envelopeHash !== "string" || !/^[0-9a-f]{16}$/u.test(envelope.envelopeHash)) {
    throw new Error("invalid_combat_turn_envelope");
  }
  const canonical = createCombatTurnEnvelopeV1({
    streamId: envelope.streamId, cursor: Number(envelope.cursor), operationId: envelope.operationId,
    attacker: envelope.attacker as CombatantSnapshotV1, defender: envelope.defender as CombatantSnapshotV1,
    options: envelope.options as PlayerMeleeOptionsV1, transcript: envelope.transcript as CombatRollTranscriptV1,
    previousEnvelopeHash: envelope.previousEnvelopeHash ?? null,
  });
  if (canonical.beforeStateHash !== envelope.beforeStateHash || canonical.afterStateHash !== envelope.afterStateHash ||
      canonical.terminal !== envelope.terminal || canonical.envelopeHash !== envelope.envelopeHash) {
    throw new Error("combat_turn_envelope_hash_mismatch");
  }
  return canonical;
}
