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

  it("covers critical, swift, and nonlethal branches without implicit randomness", () => {
    const critical = reducePlayerMeleeV1(
      attacker,
      { ...defender, hp: 100, maxHp: 100 },
      { ...options, critChance: 1 },
      { hit: 0, crit: 0, variance: 0.5, severityFlavor: 0 },
    );
    expect(critical).toMatchObject({ hit: true, critical: true, damage: 14, killed: false, defender: { hp: 86 } });
    const swift = reducePlayerMeleeV1(
      { ...attacker, traits: ["swift"] },
      { ...defender, hp: 100, maxHp: 100 },
      options,
      { hit: 0, crit: 0.9, variance: 0.5, swiftSpike: 0, severityFlavor: 0 },
    );
    expect(swift).toMatchObject({ hit: true, critical: false, damage: 9, killed: false, defender: { hp: 91 } });
    expect(() => reducePlayerMeleeV1(
      { ...attacker, traits: ["swift"] }, defender, options,
      { hit: 0, crit: 0.9, variance: 0.5, severityFlavor: 0, killFlavor: 0 },
    )).toThrow("invalid_combat_transcript_swift");
  });

  it("preserves deterministic reducer output across seeded combat transcripts", () => {
    let seed = 0x636f6d62;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 256; run++) {
      const sourceAttacker = { ...attacker, attack: 1 + Math.floor(random() * 30) };
      const sourceDefender = { ...defender, hp: 1 + Math.floor(random() * 80), maxHp: 80, defense: Math.floor(random() * 10) };
      const damage = Math.max(1, sourceAttacker.attack - sourceDefender.defense + 1);
      const transcript: CombatRollTranscriptV1 = sourceDefender.hp <= damage
        ? { hit: 0, crit: 0.99, variance: 0.5, severityFlavor: random(), killFlavor: random() }
        : { hit: 0, crit: 0.99, variance: 0.5, severityFlavor: random() };
      const before = structuredClone({ sourceAttacker, sourceDefender, transcript });
      const first = reducePlayerMeleeV1(sourceAttacker, sourceDefender, options, transcript);
      expect(reducePlayerMeleeV1(sourceAttacker, sourceDefender, options, transcript)).toEqual(first);
      expect({ sourceAttacker, sourceDefender, transcript }).toEqual(before);
      expect(first.defender.hp).toBeGreaterThanOrEqual(0);
      expect(first.defender.hp).toBeLessThanOrEqual(sourceDefender.maxHp);
      expect(first.killed).toBe(first.defender.hp === 0);
    }
  });
});
