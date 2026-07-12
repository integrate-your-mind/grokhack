import { describe, expect, it } from "vitest";
import { createBossDragon, createMonster } from "../src/entities.js";
import {
  MAX_ACTIVE_MONSTERS_PER_FLOOR,
  normalizeFloorMonsters,
} from "./floor-monsters.js";

describe("normalizeFloorMonsters", () => {
  it("removes dead, invalid, and duplicate entities", () => {
    const live = createMonster("goblin", 1, 1, 1);
    const dead = createMonster("orc", 2, 2, 1);
    dead.hp = 0;
    const invalid = createMonster("rat", 3, 3, 1);
    invalid.hp = Number.NaN;
    const duplicate = { ...live };

    const result = normalizeFloorMonsters([live, dead, invalid, duplicate]);

    expect(result.monsters).toEqual([live]);
    expect(result).toMatchObject({
      removedDead: 2,
      removedDuplicates: 1,
      removedOverflow: 0,
    });
  });

  it("keeps healthy floor order unchanged", () => {
    const monsters = [
      createMonster("goblin", 1, 1, 1),
      createMonster("orc", 2, 2, 1),
    ];

    expect(normalizeFloorMonsters(monsters).monsters).toEqual(monsters);
  });

  it("caps corrupt populations while retaining a late boss", () => {
    const ordinary = Array.from(
      { length: MAX_ACTIVE_MONSTERS_PER_FLOOR + 20 },
      (_, index) => createMonster("goblin", index, 1, 15)
    );
    const boss = createBossDragon(10, 10, 10);
    const result = normalizeFloorMonsters([...ordinary, boss]);

    expect(result.monsters).toHaveLength(MAX_ACTIVE_MONSTERS_PER_FLOOR);
    expect(result.monsters).toContain(boss);
    expect(result.removedOverflow).toBe(21);
    expect(result.monsters.filter((monster) => monster === boss)).toHaveLength(1);
  });

  it("rejects an invalid limit instead of silently dropping state", () => {
    expect(() => normalizeFloorMonsters([], -1)).toThrow(RangeError);
    expect(() => normalizeFloorMonsters([], 1.5)).toThrow(RangeError);
  });
});
