import { describe, it, expect } from "vitest";
import {
  extractRunCause,
  isPollutedDeathCause,
  DEATH_CAUSE_RE,
  inferSlainFromDamage,
  killerFromCause,
  rawDeathCause,
} from "./death-cause.mjs";

describe("extractRunCause (bot death filter)", () => {
  it("prefers server deathCause over last messages", () => {
    const cause = extractRunCause(
      { deathCause: "Slain by a skeleton" },
      null,
      ["You notice stairs leading up (<).", "The goblin misses you."]
    );
    expect(cause).toBe("Slain by a skeleton");
  });

  it("reads deathCause from nested state.you / state.player", () => {
    expect(
      extractRunCause(null, { you: { deathCause: "Starved to death" } }, ["You wait."])
    ).toBe("Starved to death");
    expect(
      extractRunCause(null, { player: { deathCause: "Succumbed to poison" } }, [])
    ).toBe("Succumbed to poison");
  });

  it("rejects inventory, stairs, ambient, miss as raw cause; damage-only is polluted but may infer slain", () => {
    const neverCause = [
      "You notice stairs leading up (<).",
      "You notice stairs leading down (>).",
      "Inventory (1-9, 0=10, i to close):",
      "  2. ? scroll labeled XIXAXA XOXAXA XUXAXA",
      "You hear a growl in the distance.",
      "Welcome back, GrokBot1.",
      "The goblin misses you.",
      "A clumsy swipe from the skeleton misses.",
      "You bump into a wall.",
      "You wait.",
      "[chat] Alice: hi",
    ];
    for (const m of neverCause) {
      expect(isPollutedDeathCause(m), m).toBe(true);
      expect(extractRunCause(null, null, [m]), m).toBe("permadeath");
    }
    // Damage lines are polluted as raw epitaphs, but extractRunCause may infer killer
    for (const m of ["The snake bashs you for 3 damage.", "The orc mauls you for 8 damage."]) {
      expect(isPollutedDeathCause(m), m).toBe(true);
      expect(extractRunCause(null, null, [m]), m).toMatch(/^Slain by a /i);
    }
  });

  it("accepts real death lines from the log when field empty", () => {
    expect(
      extractRunCause(null, null, [
        "You notice stairs leading down (>).",
        "The orc hits you for 6 damage.",
        "You die...",
      ])
    ).toMatch(/you die/i);

    expect(
      extractRunCause(null, null, ["Inventory open", "Slain by a orc"])
    ).toBe("Slain by a orc");

    expect(DEATH_CAUSE_RE.test("Incinerated by a dragon")).toBe(true);
    expect(
      extractRunCause(null, null, ["Incinerated by a dragon", "Game over."])
    ).toMatch(/Incinerated by a dragon/i);
  });

  it("does not treat polluted server field as authoritative", () => {
    // Defensive: if YOU payload ever leaks a UI line, still filter it
    expect(
      extractRunCause(
        { deathCause: "You notice stairs leading up (<)." },
        null,
        ["Slain by a bat"]
      )
    ).toBe("Slain by a bat");
  });

  it("infers slain-from last damage when deathCause and epitaph missing", () => {
    expect(
      extractRunCause(null, null, [
        "You notice stairs leading down (>).",
        "The goblin misses you.",
        "The kobold glances you for 1 damage.",
        "The orc CRITICAL hits you for 8 damage!",
      ])
    ).toMatch(/Slain by a orc/i);

    expect(inferSlainFromDamage(["The skeleton nicks you for 1 damage."])).toMatch(
      /skeleton/i
    );
  });

  it("rawDeathCause + killerFromCause for bot-runs fields", () => {
    expect(rawDeathCause({ deathCause: "Slain by a snake" }, null)).toBe("Slain by a snake");
    expect(killerFromCause("Slain by a snake")).toBe("snake");
    expect(killerFromCause("Starved to death")).toBeNull();
  });

  it("never uses inventory lines even as inference", () => {
    expect(
      extractRunCause(null, null, [
        "  2. ? scroll labeled XIXAXA",
        "Inventory (1-9, 0=10, i to close):",
      ])
    ).toBe("permadeath");
  });
});
