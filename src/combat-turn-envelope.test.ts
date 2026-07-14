import { describe, expect, it } from "vitest";
import { createCombatTurnEnvelopeV1, validateCombatTurnEnvelopeV1 } from "./combat-turn-envelope.js";

const input = {
  streamId: `combat_${"a".repeat(48)}`,
  cursor: 1,
  operationId: "00000000-0000-4000-8000-000000000001",
  attacker: { id: "player", name: "Romy", hp: 20, maxHp: 20, attack: 8, defense: 2, isPlayer: true, traits: [], enraged: false },
  defender: { id: "rat", name: "giant rat", hp: 8, maxHp: 8, attack: 2, defense: 1, isPlayer: false, traits: [], enraged: false },
  options: { weaponName: "short sword", hitPenalty: 0, critChance: 0 },
  transcript: { hit: 0, crit: 0.9, variance: 0.5, severityFlavor: 0, killFlavor: 0 },
  turn: {
    command: { type: "advance_turn", action: "other" },
    beforeState: { turns: 3, depth: 1, hunger: 5, maxHunger: 20, hungerState: "normal", hp: 20, alive: true },
  },
  previousEnvelopeHash: null,
} as const;

describe("combat turn envelope", () => {
  it("binds the deterministic combat result and rejects tampering", () => {
    const envelope = createCombatTurnEnvelopeV1(input);
    expect(validateCombatTurnEnvelopeV1(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(envelope).toMatchObject({ targetKilled: true, terminal: false, beforeStateHash: expect.stringMatching(/^[0-9a-f]{16}$/u) });
    expect(() => validateCombatTurnEnvelopeV1({ ...envelope, transcript: { ...envelope.transcript, variance: 0 } })).toThrow("invalid_combat_transcript_nonlethal");
    expect(() => validateCombatTurnEnvelopeV1({ ...envelope, transcript: { ...envelope.transcript, extra: 0 } })).toThrow("invalid_combat_transcript_keys");
    expect(() => validateCombatTurnEnvelopeV1({
      ...envelope,
      turn: { ...envelope.turn, streamId: "wrong_vitals_stream" },
    })).toThrow("invalid_combat_turn_envelope");
  });
});
