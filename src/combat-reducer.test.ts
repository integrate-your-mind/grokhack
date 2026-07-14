import { describe, expect, it } from "vitest";
import { reducePlayerMeleeV1, type CombatRollTranscriptV1 } from "./combat-reducer.js";

const attacker = { id: "player", name: "Romy", hp: 20, maxHp: 20, attack: 8, defense: 2, isPlayer: true, traits: [], enraged: false };
const defender = { id: "rat", name: "giant rat", hp: 8, maxHp: 8, attack: 2, defense: 1, isPlayer: false, traits: [], enraged: false };
const options = { weaponName: "short sword", hitPenalty: 0, critChance: 0 };

describe("reducePlayerMeleeV1", () => {
  it("is byte-stable and does not mutate either combatant", () => {
    const transcript: CombatRollTranscriptV1 = { hit: 0, crit: 0.9, variance: 0.5, severityFlavor: 0, killFlavor: 0 };
    const before = structuredClone({ attacker, defender });
    const first = reducePlayerMeleeV1(attacker, defender, options, transcript);
    expect(reducePlayerMeleeV1(attacker, defender, options, transcript)).toEqual(first);
    expect({ attacker, defender }).toEqual(before);
    expect(first).toMatchObject({ hit: true, damage: 8, killed: true, critical: false, defender: { hp: 0 } });
  });

  it("keeps miss and hit transcripts branch-exact", () => {
    expect(reducePlayerMeleeV1(attacker, defender, options, { hit: 0.99, missFlavor: 0 })).toMatchObject({ hit: false, damage: 0 });
    expect(() => reducePlayerMeleeV1(attacker, defender, options, { hit: 0.99, missFlavor: 0, crit: 0 })).toThrow("invalid_combat_transcript_miss");
    expect(() => reducePlayerMeleeV1(attacker, defender, options, { hit: 0, crit: 0, variance: 0.5 })).toThrow("invalid_combat_transcript_hit");
    expect(() => reducePlayerMeleeV1(attacker, defender, options, { hit: Number.NaN, missFlavor: 0 })).toThrow("invalid_combat_transcript_hit");
  });
});
