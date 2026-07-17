import { describe, expect, it, vi } from "vitest";

import { buildFloorBootstrap } from "../src/floor-bootstrap";

describe("deterministic FloorInstance bootstrap", () => {
  it("builds stable persisted geometry without ambient randomness", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("ambient randomness is forbidden during floor bootstrap");
    });
    try {
      const name = "floor:v1:test:iroom:d1:e1";
      const first = buildFloorBootstrap(name, 1);
      const replay = buildFloorBootstrap(name, 1);
      const other = buildFloorBootstrap("floor:v1:test:iother:d1:e1", 1);

      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        seed: 3_709_120_837,
        generatorVersion: 1,
        simulationProfile: "movement_plain_v1",
        width: 80,
        height: 24,
        entryX: 10,
        entryY: 21,
        cellCount: 80 * 24,
        mapHash: "604bb73ab6ab9bac",
      });
      expect(first.seed).toBeGreaterThan(0);
      expect(first.cells).toHaveLength(first.cellCount);
      expect(first.cells.find((cell) => cell.spawnRank === 0)).toMatchObject({
        x: first.entryX,
        y: first.entryY,
        tile: ".",
      });
      expect(first.cells.filter((cell) => cell.spawnRank !== null)).toHaveLength(377);
      expect(other.mapHash).not.toBe(first.mapHash);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it("keeps every supported depth above the configured 100-player spawn ceiling", () => {
    const hashes = new Set<string>();
    for (let depth = 1; depth <= 15; depth++) {
      const floor = buildFloorBootstrap(`floor:v1:capacity:iprimary:d${depth}:e1`, depth);
      const spawnCount = floor.cells.filter((cell) => cell.spawnRank !== null).length;
      expect(spawnCount).toBeGreaterThanOrEqual(100);
      hashes.add(floor.mapHash);
    }
    expect(hashes.size).toBe(15);
  });
});
