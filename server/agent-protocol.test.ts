import { describe, expect, it } from "vitest";
import {
  buildAgentHints,
  buildAgentSummary,
  monsterThreat,
} from "./agent-protocol.js";

describe("monsterThreat", () => {
  it("ranks known kinds", () => {
    expect(monsterThreat("dragon")).toBe(5);
    expect(monsterThreat("troll")).toBe(4);
    expect(monsterThreat("orc")).toBe(3);
    expect(monsterThreat("rat")).toBe(1);
  });

  it("falls back on bulk when kind unknown", () => {
    expect(monsterThreat(undefined, "Weird Thing", 40, 40)).toBe(4);
    expect(monsterThreat(undefined, "blob", 2, 2)).toBe(1);
  });
});

describe("buildAgentHints", () => {
  const base = {
    hunger: "normal",
    hp: 16,
    maxHp: 16,
    x: 5,
    y: 5,
    stairsDown: { x: 10, y: 10 },
    adjacentMonsters: false,
    monsterCount: 0,
    itemCount: 0,
    hasFood: false,
    hasHeal: false,
    highThreatAdjacent: false,
  };

  it("flags sustain needs", () => {
    expect(buildAgentHints({ ...base, hunger: "hungry" })).toContain("eat_food");
    expect(buildAgentHints({ ...base, hunger: "fainting" })).toEqual(
      expect.arrayContaining(["eat_food", "starving"])
    );
    expect(buildAgentHints({ ...base, hp: 4, maxHp: 16 })).toContain("low_hp");
    expect(buildAgentHints({ ...base, hp: 3, maxHp: 16 })).toEqual(
      expect.arrayContaining(["low_hp", "critical_hp"])
    );
  });

  it("flags combat and stairs", () => {
    expect(
      buildAgentHints({ ...base, adjacentMonsters: true, highThreatAdjacent: true })
    ).toEqual(expect.arrayContaining(["enemy_adjacent", "flee_or_heal"]));
    expect(buildAgentHints({ ...base, x: 10, y: 10 })).toContain("on_stairs_descend");
    expect(buildAgentHints({ ...base, x: 10, y: 12 })).toContain("stairs_nearby");
  });

  it("flags pack and visibility", () => {
    expect(
      buildAgentHints({
        ...base,
        hasFood: true,
        hasHeal: true,
        monsterCount: 2,
        itemCount: 1,
      })
    ).toEqual(
      expect.arrayContaining([
        "food_in_pack",
        "heal_in_pack",
        "enemy_visible",
        "item_visible",
      ])
    );
  });
});

describe("buildAgentSummary", () => {
  it("compacts state for LLM tools", () => {
    const summary = buildAgentSummary({
      you: {
        name: "GrokBot1",
        glyph: "A",
        x: 1,
        y: 1,
        hp: 10,
        maxHp: 16,
        depth: 2,
        level: 3,
        hunger: "hungry",
        gold: 12,
        turns: 40,
        phase: "playing",
        inventory: [],
      },
      floor: {
        depth: 2,
        width: 40,
        height: 20,
        tiles: [],
        stairsDown: { x: 5, y: 5 },
      },
      visible: {
        monsters: [
          {
            x: 2,
            y: 1,
            char: "r",
            name: "rat",
            hp: 3,
            adjacent: true,
            threat: 1,
          },
        ],
        items: [{ x: 3, y: 3, char: "%" }],
        players: [],
      },
      messages: [],
      online: 2,
      valid_actions: ["h"],
      hints: ["eat_food", "enemy_adjacent"],
    });
    expect(summary).toContain("GrokBot1 d2 L3");
    expect(summary).toContain("HP 10/16");
    expect(summary).toContain("hungry");
    expect(summary).toContain("adj:rat");
    expect(summary).toContain("hints:eat_food,enemy_adjacent");
  });
});
