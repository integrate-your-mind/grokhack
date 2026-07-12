import type { Entity } from "../src/types.js";

/**
 * Emergency high-water mark for one persisted floor.
 *
 * Designed floors top out well below this (MAX_DEPTH is 15); this is a fuse for
 * lifecycle bugs and hostile/corrupt snapshots, not a gameplay population target.
 */
export const MAX_ACTIVE_MONSTERS_PER_FLOOR = 256;

export interface FloorMonsterNormalization {
  monsters: Entity[];
  removedDead: number;
  removedDuplicates: number;
  removedOverflow: number;
}

/**
 * Return a persistence-safe active monster list.
 *
 * Dead/invalid entities and duplicate ids are discarded. If a corrupt snapshot
 * exceeds the defensive limit, bosses are retained before ordinary monsters,
 * while the relative order of retained entities remains stable.
 */
export function normalizeFloorMonsters(
  monsters: readonly Entity[],
  limit = MAX_ACTIVE_MONSTERS_PER_FLOOR
): FloorMonsterNormalization {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("floor monster limit must be a non-negative safe integer");
  }

  const liveUnique: Entity[] = [];
  const seenIds = new Set<string>();
  let removedDead = 0;
  let removedDuplicates = 0;

  for (const monster of monsters) {
    if (!Number.isFinite(monster.hp) || monster.hp <= 0) {
      removedDead++;
      continue;
    }
    if (seenIds.has(monster.id)) {
      removedDuplicates++;
      continue;
    }
    seenIds.add(monster.id);
    liveUnique.push(monster);
  }

  const removedOverflow = Math.max(0, liveUnique.length - limit);
  if (removedOverflow === 0) {
    return { monsters: liveUnique, removedDead, removedDuplicates, removedOverflow };
  }

  const bosses = liveUnique.filter((monster) => monster.traits?.includes("boss"));
  const ordinary = liveUnique.filter((monster) => !monster.traits?.includes("boss"));
  const retained = new Set<Entity>();

  for (const monster of bosses) {
    if (retained.size >= limit) break;
    retained.add(monster);
  }
  for (const monster of ordinary) {
    if (retained.size >= limit) break;
    retained.add(monster);
  }

  return {
    monsters: liveUnique.filter((monster) => retained.has(monster)),
    removedDead,
    removedDuplicates,
    removedOverflow,
  };
}
