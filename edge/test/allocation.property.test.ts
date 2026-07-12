import { describe, expect, it } from "vitest";

import {
  directoryBucketFor,
  floorInstanceIdForSlot,
  parseAllocationRequest,
  realmDirectoryObjectName,
} from "../src/allocation-protocol";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function seededUuid(random: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("seeded allocator routing properties", () => {
  it("keeps canonical party/player affinity stable, bounded, and layout-versioned", () => {
    const random = seededRandom(20_260_711);
    const used = new Set<number>();
    for (let index = 0; index < 1_000; index++) {
      const playerId = seededUuid(random);
      const partyId = seededUuid(random);
      const playerBucket = directoryBucketFor({ playerId }, 64);
      const partyBucket = directoryBucketFor({ playerId, partyId }, 64);
      used.add(playerBucket);
      expect(playerBucket).toBeGreaterThanOrEqual(0);
      expect(playerBucket).toBeLessThan(64);
      expect(directoryBucketFor({ playerId }, 64)).toBe(playerBucket);
      expect(directoryBucketFor({ playerId: seededUuid(random), partyId }, 64)).toBe(partyBucket);
      expect(directoryBucketFor({ playerId, partyId }, 8)).toBe(partyBucket & 7);
    }
    expect(used.size).toBe(64);

    const playerId = seededUuid(random);
    expect(() =>
      parseAllocationRequest({
        v: 1,
        operationId: seededUuid(random),
        playerId: playerId.toUpperCase(),
        realmId: "property-realm",
        depth: 1,
        locationHint: "wnam",
        capacityUnits: 1,
      }),
    ).toThrowError("invalid_request");

    expect(floorInstanceIdForSlot("wnam", 64, 7, 3)).not.toBe(
      floorInstanceIdForSlot("enam", 64, 7, 3),
    );
    expect(floorInstanceIdForSlot("wnam", 64, 7, 3)).not.toBe(
      floorInstanceIdForSlot("wnam", 128, 7, 3),
    );
    expect(
      realmDirectoryObjectName(
        "test",
        { realmId: "property-realm", depth: 1, locationHint: "wnam" },
        64,
        7,
      ),
    ).toContain(":n64:b7");
  });
});
