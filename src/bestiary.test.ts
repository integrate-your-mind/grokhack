/**
 * Bestiary expansion tests — new NetHack-class kinds, stats, spawn eligibility.
 */
import { describe, it, expect } from "vitest";
import {
  MONSTER_DEFS,
  createMonster,
  pickMonsterKind,
  monstersForDepth,
  isMonsterEligibleAtDepth,
  allMonsterKinds,
  depthScale,
  beehiveDenMonsterPool,
  pickBeehiveMonsterKind,
  isPackDenKind,
} from "./entities";
import { pickDenMonsterKind } from "./world-events";
import { RNG } from "./rng";
import {
  tryApplyMonsterOnHit,
  tryMindBlast,
  tryStealFromPlayer,
  tryAmbushBonus,
  tryAcidArmor,
  tryGazeStun,
  trySummonMinion,
  revealMimic,
  tryRangedSpecial,
  checkBossEnrage,
  tickMonsterRegen,
  tryLevelDrain,
} from "./combat";
import { createPlayer } from "./entities";
import type { MonsterKind, PlayerState } from "./types";

/** Mid/late threats shipped in first bestiary wave. */
const BESTIARY_MIDLATE: MonsterKind[] = [
  "killer_bee",
  "mimic",
  "nymph",
  "mind_flayer",
  "lich",
];

/** Early-depth fauna — d1–5 ecology (this cycle P0). */
const EARLY_FAUNA: MonsterKind[] = ["newt", "grid_bug", "lichen", "jackal"];

/** TICKET-BE-01 §3.4 minimum ship set. */
const TICKET_BE01: MonsterKind[] = ["wolf", "insect", "thief", "mimic", "ooze", "lich"];

/** d1–5 variety wave — mimic/nymph-class/swarm archetypes + early fauna. */
const D15_VARIETY: MonsterKind[] = [
  "gecko",
  "giant_ant",
  "leprechaun",
  "floating_eye",
  "fox",
];

function makePlayer(): PlayerState {
  const entity = createPlayer(1, 1);
  return {
    entity,
    level: 3,
    xp: 30,
    xpToLevel: 40,
    hunger: 500,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: [
      {
        id: "i1",
        name: "ration",
        char: "%",
        type: "food",
        power: 200,
        identified: true,
      },
    ],
    equippedWeapon: null,
    equippedArmor: null,
    equippedRing: null,
    gold: 25,
    turns: 0,
    depth: 5,
    alive: true,
    statuses: [],
  };
}

describe("bestiary defs", () => {
  it("registers early fauna + mid/late kinds with complete defs", () => {
    const all = [...EARLY_FAUNA, ...BESTIARY_MIDLATE];
    for (const kind of all) {
      const def = MONSTER_DEFS[kind];
      expect(def, kind).toBeDefined();
      expect(def.kind).toBe(kind);
      expect(def.char.length).toBe(1);
      expect(def.hp).toBeGreaterThan(0);
      expect(def.attack).toBeGreaterThan(0);
      expect(def.xp).toBeGreaterThan(0);
      expect(def.color).toMatch(/^#/);
    }
    expect(EARLY_FAUNA.length).toBeGreaterThanOrEqual(4);
    expect(BESTIARY_MIDLATE.length).toBeGreaterThanOrEqual(5);
    expect(allMonsterKinds().length).toBeGreaterThanOrEqual(20);
  });

  it("early fauna: weak stats + pack dens for spawn-ecology", () => {
    const newt = MONSTER_DEFS.newt;
    expect(newt.hp).toBeLessThanOrEqual(4);
    expect(newt.attack).toBeLessThanOrEqual(2);
    expect(newt.traits ?? []).not.toContain("boss");

    expect(MONSTER_DEFS.grid_bug.traits).toEqual(expect.arrayContaining(["pack", "swift"]));
    expect(MONSTER_DEFS.jackal.traits).toContain("pack");
    expect(MONSTER_DEFS.jackal.hunt).toBe(true);

    // Lichen is passive plant filler
    expect(MONSTER_DEFS.lichen.hunt).toBeFalsy();
    expect(MONSTER_DEFS.lichen.attack).toBeLessThanOrEqual(2);

    const n = createMonster("newt", 0, 0, 1);
    expect(n.char).toBe(":");
    expect(n.hp).toBeLessThanOrEqual(5);

    const jackal = createMonster("jackal", 0, 0, 1);
    expect(jackal.char).toBe("d");
    expect(jackal.traits).toContain("pack");
    expect(jackal.ai).toBe("hunt");

    const bug = createMonster("grid_bug", 0, 0, 2);
    expect(bug.char).toBe("x");
    expect(bug.ai).toBe("hunt");

    const lichen = createMonster("lichen", 0, 0, 1);
    expect(lichen.char).toBe("F");
    expect(lichen.ai).toBe("wander");
  });

  it("assigns unique AI/threat traits per mid/late kind", () => {
    expect(MONSTER_DEFS.killer_bee.traits).toEqual(
      expect.arrayContaining(["pack", "swarm", "poisonous", "swift"])
    );
    expect(MONSTER_DEFS.mimic.traits).toContain("ambush");
    expect(MONSTER_DEFS.nymph.traits).toContain("steal");
    expect(MONSTER_DEFS.mind_flayer.traits).toEqual(
      expect.arrayContaining(["mind_blast", "level_drain"])
    );
    expect(MONSTER_DEFS.lich.traits).toEqual(
      expect.arrayContaining(["unique", "boss", "regenerate", "level_drain", "mind_blast"])
    );
  });

  it("createMonster scales stats and preserves traits", () => {
    const bee = createMonster("killer_bee", 0, 0, 3);
    expect(bee.char).toBe("a");
    expect(bee.traits).toContain("swarm");
    expect(bee.ai).toBe("hunt");

    const mimic = createMonster("mimic", 0, 0, 5);
    // Disguised until reveal — glyph is fake item, trueChar is m
    expect(mimic.hiddenAs).toBeDefined();
    expect(mimic.trueChar).toBe("m");
    expect(mimic.char).not.toBe("m");
    expect(mimic.traits).toContain("ambush");
    expect(mimic.traits).toContain("mimic");
    // Mimics start wandering (ruse) until ambush or proximity forces hunt
    expect(mimic.ai).toBe("wander");
    expect(mimic.defense).toBeGreaterThanOrEqual(5);

    const nymph = createMonster("nymph", 0, 0, 4);
    expect(nymph.char).toBe("n");
    expect(nymph.traits).toContain("steal");

    const flayer = createMonster("mind_flayer", 0, 0, 7);
    expect(flayer.char).toBe("h");
    expect(flayer.traits).toContain("mind_blast");
    expect(flayer.ai).toBe("hunt");

    const lich = createMonster("lich", 0, 0, 10);
    expect(lich.char).toBe("L");
    expect(lich.name).toMatch(/Azaroth|lich/i);
    expect(lich.traits).toContain("unique");
    expect(lich.hp).toBeGreaterThan(50);
  });

  it("late kinds outscale early kinds in absolute threat", () => {
    const newt = createMonster("newt", 0, 0, 5);
    const bee = createMonster("killer_bee", 0, 0, 5);
    const lich = createMonster("lich", 0, 0, 5);
    expect(bee.hp).toBeGreaterThan(newt.hp);
    expect(lich.hp).toBeGreaterThan(bee.hp * 3);
    expect(lich.xp).toBeGreaterThan(bee.xp * 5);
    const s = depthScale(10);
    expect(s.hp).toBeGreaterThan(1);
  });
});

describe("spawn eligibility (pickMonsterKind weights)", () => {
  it("depth-1 still pins rat at roll 0 (table stability)", () => {
    expect(pickMonsterKind(1, 0)).toBe("rat");
    expect(isMonsterEligibleAtDepth("rat", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("newt", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("jackal", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("grid_bug", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("lichen", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("lich", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("mind_flayer", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("dragon", 1)).toBe(false);
  });

  it("early fauna dominates d1–2; exits by mid dungeon", () => {
    for (const kind of EARLY_FAUNA) {
      expect(isMonsterEligibleAtDepth(kind, 1) || isMonsterEligibleAtDepth(kind, 2)).toBe(true);
    }
    // Newts/lichens are shallow-only
    expect(isMonsterEligibleAtDepth("newt", 5)).toBe(false);
    expect(isMonsterEligibleAtDepth("lichen", 5)).toBe(false);
    expect(isMonsterEligibleAtDepth("newt", 10)).toBe(false);
    expect(isMonsterEligibleAtDepth("grid_bug", 10)).toBe(false);
  });

  it("killer bees appear early; mimics/nymphs mid; flayers/liches late", () => {
    expect(isMonsterEligibleAtDepth("killer_bee", 2)).toBe(true);
    expect(isMonsterEligibleAtDepth("nymph", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("mimic", 4)).toBe(true);
    expect(isMonsterEligibleAtDepth("mind_flayer", 6)).toBe(true);
    expect(isMonsterEligibleAtDepth("lich", 8)).toBe(true);

    // Not too early
    expect(isMonsterEligibleAtDepth("mimic", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("nymph", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("mind_flayer", 3)).toBe(false);
    expect(isMonsterEligibleAtDepth("lich", 5)).toBe(false);
  });

  it("shallow floors expose 5–6+ distinct kinds on the table", () => {
    for (const d of [1, 2, 3, 4, 5]) {
      const kinds = monstersForDepth(d);
      expect(kinds.length, `depth ${d} kinds=${kinds.join(",")}`).toBeGreaterThanOrEqual(5);
      // d1–5 variety wave can push tables to ~18 kinds — still table, not FOV
      expect(kinds.length, `depth ${d}`).toBeLessThanOrEqual(22);
    }
    // d1 specifically: not just rat/bat/kobold
    const d1 = new Set(monstersForDepth(1));
    expect(d1.has("newt") || d1.has("jackal") || d1.has("grid_bug")).toBe(true);
    expect(d1.size).toBeGreaterThanOrEqual(6);
  });

  it("weighted picks surface early fauna across seeds on d1", () => {
    const seen = new Set<MonsterKind>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickMonsterKind(1, i / 200));
    }
    // Across the unit interval we should see most of the early table
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(seen.has("rat")).toBe(true);
    expect(
      seen.has("newt") || seen.has("jackal") || seen.has("grid_bug") || seen.has("lichen")
    ).toBe(true);
  });

  it("pack trait kinds exist on d1–3 for spawn-ecology dens", () => {
    const packKinds = (["rat", "jackal", "grid_bug", "kobold", "killer_bee"] as MonsterKind[]).filter(
      (k) => MONSTER_DEFS[k].traits?.includes("pack")
    );
    expect(packKinds.length).toBeGreaterThanOrEqual(4);
    // At least one pack kind eligible each early depth
    for (const d of [1, 2, 3]) {
      const kinds = monstersForDepth(d);
      const hasPack = kinds.some((k) => MONSTER_DEFS[k].traits?.includes("pack"));
      expect(hasPack, `depth ${d} needs pack dens`).toBe(true);
    }
  });

  it("weighted picks eventually surface mid/late kinds in their bands", () => {
    const seen = new Set<MonsterKind>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickMonsterKind(4, i / 200));
    }
    expect(seen.has("mimic") || seen.has("nymph") || seen.has("killer_bee")).toBe(true);

    const late = new Set<MonsterKind>();
    for (let i = 0; i < 200; i++) {
      late.add(pickMonsterKind(9, i / 200));
    }
    expect(late.has("mind_flayer") || late.has("lich")).toBe(true);
  });

  it("abyss still excludes early trash and keeps dragons", () => {
    for (const d of [11, 12, 13, 14, 15]) {
      const kinds = monstersForDepth(d);
      expect(kinds).toContain("dragon");
      expect(kinds).not.toContain("rat");
      expect(kinds).not.toContain("newt");
      expect(kinds).not.toContain("jackal");
      expect(kinds).not.toContain("grid_bug");
      expect(kinds).not.toContain("killer_bee");
      expect(kinds).toContain("lich");
      expect(pickMonsterKind(d, 0)).not.toBe("rat");
    }
  });

  it("d10+ dragon/boss identity intact (no early fauna pollution)", () => {
    for (const d of [10, 11, 12]) {
      const kinds = monstersForDepth(d);
      expect(kinds).toContain("dragon");
      expect(kinds).not.toContain("newt");
      expect(kinds).not.toContain("lichen");
      expect(kinds).not.toContain("jackal");
    }
    // Lair still has meaningful dragon weight
    let dragons = 0;
    for (let i = 0; i < 100; i++) {
      if (pickMonsterKind(10, i / 100) === "dragon") dragons++;
    }
    expect(dragons).toBeGreaterThanOrEqual(15);
  });

  it("dragon weight remains higher at d15 than lair d10", () => {
    const sample = (depth: number) => {
      let dragons = 0;
      for (let i = 0; i < 100; i++) {
        if (pickMonsterKind(depth, i / 100) === "dragon") dragons++;
      }
      return dragons;
    };
    expect(sample(15)).toBeGreaterThan(sample(10));
  });
});

describe("d1–5 variety wave (DENSITY_COORD bestiary)", () => {
  it("ships 4+ new kinds with complete defs and unique threats", () => {
    expect(D15_VARIETY.length).toBeGreaterThanOrEqual(4);
    for (const kind of D15_VARIETY) {
      const def = MONSTER_DEFS[kind];
      expect(def, kind).toBeDefined();
      expect(def.char.length).toBeGreaterThanOrEqual(1);
      expect(def.hp).toBeGreaterThan(0);
      const m = createMonster(kind, 0, 0, 3);
      expect(m.kind).toBe(kind);
      expect(m.hp).toBeGreaterThan(0);
    }
    expect(MONSTER_DEFS.giant_ant.traits).toEqual(expect.arrayContaining(["pack", "swarm"]));
    expect(MONSTER_DEFS.leprechaun.traits).toContain("steal");
    expect(MONSTER_DEFS.floating_eye.traits).toContain("gaze");
    expect(MONSTER_DEFS.fox.traits).toEqual(expect.arrayContaining(["pack", "swift"]));
  });

  it("d1–5 tables include variety wave + classic threats", () => {
    expect(pickMonsterKind(1, 0)).toBe("rat");
    expect(isMonsterEligibleAtDepth("gecko", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("fox", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("giant_ant", 1)).toBe(true);
    expect(isMonsterEligibleAtDepth("leprechaun", 2)).toBe(true);
    expect(isMonsterEligibleAtDepth("floating_eye", 3)).toBe(true);
    // mimic / nymph-class still mid
    expect(isMonsterEligibleAtDepth("mimic", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("nymph", 3)).toBe(true);

    for (const d of [1, 2, 3, 4, 5]) {
      const kinds = monstersForDepth(d);
      expect(kinds.length, `d${d}`).toBeGreaterThanOrEqual(6);
    }
  });

  it("pickMonsterKind samples hit new kinds across d1–5", () => {
    const seen = new Set<MonsterKind>();
    for (const d of [1, 2, 3, 4, 5]) {
      for (let i = 0; i < 120; i++) {
        seen.add(pickMonsterKind(d, i / 120));
      }
    }
    const hits = D15_VARIETY.filter((k) => seen.has(k));
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(seen.has("mimic") || seen.has("nymph") || seen.has("leprechaun")).toBe(true);
    expect(seen.has("giant_ant") || seen.has("killer_bee") || seen.has("insect")).toBe(true);
  });

  it("leprechaun steals gold first; floating eye gazes stun", () => {
    const p = makePlayer();
    p.gold = 40;
    p.inventory = [
      {
        id: "i1",
        name: "ration",
        char: "%",
        type: "food",
        power: 100,
        identified: true,
      },
    ];
    const lep = createMonster("leprechaun", 0, 0, 3);
    const steal = tryStealFromPlayer(lep, p, () => 0);
    expect(steal).toMatch(/gold/i);
    expect(p.gold).toBeLessThan(40);
    expect(p.inventory.length).toBe(1); // gold preferred over item

    const eye = createMonster("floating_eye", 0, 0, 4);
    const gaze = tryGazeStun(eye, p, () => 0);
    expect(gaze).toMatch(/gaze|freeze/i);
    expect((p.immobilizedTurns ?? 0)).toBeGreaterThan(0);
  });
});

describe("P0-8 bees + mid mimic/nymph + beehive dens", () => {
  it("killer_bee has pack trait and is eligible d3–6", () => {
    expect(MONSTER_DEFS.killer_bee.traits).toContain("pack");
    expect(MONSTER_DEFS.killer_bee.traits).toContain("swarm");
    for (const d of [3, 4, 5, 6]) {
      expect(isMonsterEligibleAtDepth("killer_bee", d), `bee @ d${d}`).toBe(true);
    }
  });

  it("pickMonsterKind samples surface bees on d3–6", () => {
    for (const d of [3, 4, 5, 6]) {
      let bees = 0;
      for (let i = 0; i < 200; i++) {
        if (pickMonsterKind(d, i / 200) === "killer_bee") bees++;
      }
      expect(bees, `bee samples @ d${d}`).toBeGreaterThan(0);
    }
  });

  it("mimic and nymph appear mid-depth (not only deep)", () => {
    // Mid band d3–6
    expect(isMonsterEligibleAtDepth("nymph", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("mimic", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("nymph", 5)).toBe(true);
    expect(isMonsterEligibleAtDepth("mimic", 5)).toBe(true);
    expect(isMonsterEligibleAtDepth("nymph", 6)).toBe(true);
    expect(isMonsterEligibleAtDepth("mimic", 6)).toBe(true);
    // Not tutorial d1
    expect(isMonsterEligibleAtDepth("mimic", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("nymph", 1)).toBe(false);

    // Samples hit mid tables
    const mid = new Set<MonsterKind>();
    for (let i = 0; i < 200; i++) {
      mid.add(pickMonsterKind(4, i / 200));
    }
    expect(mid.has("nymph") || mid.has("mimic")).toBe(true);
    expect(mid.has("killer_bee")).toBe(true);
  });

  it("beehive den pool is pack bees; pickDenMonsterKind routes beehive", () => {
    for (const d of [3, 5, 7]) {
      const pool = beehiveDenMonsterPool(d);
      expect(pool.every((k) => k === "killer_bee" || k === "insect")).toBe(true);
      expect(pool.some((k) => k === "killer_bee")).toBe(true);
      expect(pool.every((k) => isPackDenKind(k))).toBe(true);
    }
    expect(pickBeehiveMonsterKind(4, 0)).toBe("killer_bee");
    const rng = new RNG(42);
    const hive = new Set(
      Array.from({ length: 30 }, () => pickDenMonsterKind("beehive", 4, rng))
    );
    expect([...hive].every((k) => k === "killer_bee" || k === "insect")).toBe(true);
    expect(hive.has("killer_bee")).toBe(true);
  });
});

describe("TICKET-BE-01 kinds (nethack-concepts §3.4)", () => {
  it("createMonster + traits for all six ticket kinds", () => {
    for (const kind of TICKET_BE01) {
      const m = createMonster(kind, 0, 0, 8);
      expect(m.kind).toBe(kind);
      expect(m.hp).toBeGreaterThan(0);
      expect(m.char.length).toBeGreaterThanOrEqual(1);
    }
    expect(createMonster("wolf", 0, 0, 2).traits).toContain("pack");
    expect(createMonster("insect", 0, 0, 3).traits).toEqual(
      expect.arrayContaining(["pack", "poisonous"])
    );
    expect(createMonster("thief", 0, 0, 3).traits).toContain("steal");
    expect(createMonster("ooze", 0, 0, 5).traits).toContain("acid");
    const lich = createMonster("lich", 0, 0, 8);
    expect(lich.traits).toEqual(
      expect.arrayContaining(["undead", "level_drain", "summon"])
    );
  });

  it("pickMonsterKind eligibility bands match §3.4 depth-in", () => {
    expect(isMonsterEligibleAtDepth("wolf", 2)).toBe(true);
    expect(isMonsterEligibleAtDepth("wolf", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("insect", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("insect", 1)).toBe(false);
    expect(isMonsterEligibleAtDepth("thief", 3)).toBe(true);
    expect(isMonsterEligibleAtDepth("mimic", 4)).toBe(true);
    expect(isMonsterEligibleAtDepth("ooze", 5)).toBe(true);
    expect(isMonsterEligibleAtDepth("ooze", 3)).toBe(false);
    expect(isMonsterEligibleAtDepth("lich", 8)).toBe(true);
    expect(isMonsterEligibleAtDepth("lich", 5)).toBe(false);
    // d1 stability
    expect(pickMonsterKind(1, 0)).toBe("rat");
  });

  it("mimic spawns disguised as item glyph until reveal", () => {
    // Force many creates — all should start disguised
    let disguised = 0;
    for (let i = 0; i < 10; i++) {
      const m = createMonster("mimic", 0, 0, 5);
      if (m.hiddenAs && m.char !== "m") disguised++;
    }
    expect(disguised).toBe(10);
    const m = createMonster("mimic", 0, 0, 5);
    expect(m.traits).toContain("mimic");
    const msg = revealMimic(m);
    expect(msg).toMatch(/mimic/i);
    expect(m.char).toBe("m");
    expect(m.hiddenAs).toBeUndefined();
    expect(m.ai).toBe("hunt");
  });

  it("ooze acid degrades equipped armor at 25% (forced)", () => {
    const p = makePlayer();
    p.equippedArmor = {
      id: "a1",
      name: "leather armor",
      char: "[",
      type: "armor",
      power: 4,
      identified: true,
    };
    const ooze = createMonster("ooze", 0, 0, 5);
    const msg = tryAcidArmor(ooze, p, () => 0); // force proc
    expect(msg).toMatch(/acid/i);
    expect(p.equippedArmor!.power).toBe(3);
  });

  it("thief steals via steal trait", () => {
    const p = makePlayer();
    const thief = createMonster("thief", 0, 0, 3);
    const before = p.inventory.length;
    const msg = tryStealFromPlayer(thief, p, () => 0);
    expect(msg).toMatch(/steal/i);
    expect(p.inventory.length).toBe(before - 1);
  });

  it("lich can summon a skeleton minion when ready", () => {
    const lich = createMonster("lich", 5, 5, 9);
    lich.specialCooldown = 0;
    const result = trySummonMinion(
      lich,
      9,
      { x: 6, y: 5 },
      createMonster,
      () => 0 // force proc
    );
    expect(result).not.toBeNull();
    expect(result!.minion.kind).toBe("skeleton");
    expect(result!.minion.name).toMatch(/skeleton/i);
    expect(result!.message).toMatch(/skeleton|rises|gestures/i);
    expect(lich.specialCooldown).toBeGreaterThan(0);
  });
});

describe("combat hooks for new kinds", () => {
  it("mimic ambush deals one-shot bonus and flips to hunt", () => {
    const p = makePlayer();
    p.entity.hp = 40;
    const mimic = createMonster("mimic", 0, 0, 5);
    expect(mimic.ai).toBe("wander");
    const msg = tryAmbushBonus(mimic, p, () => 0);
    expect(msg).toMatch(/mimic|surprise/i);
    expect(p.entity.hp).toBeLessThan(40);
    expect(mimic.ai).toBe("hunt");
    expect(mimic.specialCooldown).toBeGreaterThan(0);
    // Second ambush does nothing
    const again = tryAmbushBonus(mimic, p, () => 0);
    expect(again).toBeNull();
  });

  it("nymph steals inventory when steal procs", () => {
    const p = makePlayer();
    const nymph = createMonster("nymph", 0, 0, 4);
    const before = p.inventory.length;
    const msg = tryStealFromPlayer(nymph, p, () => 0); // force proc
    expect(msg).toMatch(/steal/i);
    expect(p.inventory.length).toBe(before - 1);
  });

  it("nymph steals gold when inventory empty", () => {
    const p = makePlayer();
    p.inventory = [];
    p.gold = 30;
    const nymph = createMonster("nymph", 0, 0, 4);
    const msg = tryStealFromPlayer(nymph, p, () => 0);
    expect(msg).toMatch(/gold/i);
    expect(p.gold).toBeLessThan(30);
  });

  it("mind flayer mind_blast damages and stuns at range", () => {
    const p = makePlayer();
    p.entity.hp = 50;
    const flayer = createMonster("mind_flayer", 0, 0, 7);
    const r = tryMindBlast(flayer, p, 3, () => 0); // force proc
    expect(r).not.toBeNull();
    expect(r!.hit).toBe(true);
    expect(r!.damage).toBeGreaterThan(0);
    expect(p.entity.hp).toBeLessThan(50);
    expect((p.immobilizedTurns ?? 0)).toBeGreaterThan(0);
    expect(r!.message).toMatch(/mind/i);
  });

  it("tryRangedSpecial routes mind_blast vs breath", () => {
    const p = makePlayer();
    p.entity.hp = 80;
    const flayer = createMonster("mind_flayer", 0, 0, 8);
    flayer.specialCooldown = 0;
    // Force by zeroing RNG path inside tryMindBlast — may need retries
    let hit = false;
    for (let i = 0; i < 30; i++) {
      flayer.specialCooldown = 0;
      p.entity.hp = 80;
      const r = tryRangedSpecial(flayer, p, 3);
      if (r) {
        hit = true;
        expect(r.message).toMatch(/mind/i);
        break;
      }
    }
    expect(hit).toBe(true);

    const dragon = createMonster("dragon", 0, 0, 10);
    dragon.specialCooldown = 0;
    let fire = false;
    for (let i = 0; i < 40; i++) {
      dragon.specialCooldown = 0;
      p.entity.hp = 80;
      const r = tryRangedSpecial(dragon, p, 4);
      if (r) {
        fire = true;
        expect(r.message).toMatch(/fire|breathe|bathe/i);
        break;
      }
    }
    expect(fire).toBe(true);
  });

  it("killer bees apply poison via on-hit", () => {
    const p = makePlayer();
    const bee = createMonster("killer_bee", 0, 0, 3);
    let poisoned = false;
    for (let i = 0; i < 50; i++) {
      p.statuses = [];
      const msg = tryApplyMonsterOnHit(bee, p);
      if (msg && p.statuses.some((s) => s.kind === "poison")) {
        poisoned = true;
        expect(msg).toMatch(/stinger|poison|venom/i);
        break;
      }
    }
    expect(poisoned).toBe(true);
  });

  it("lich is unique boss: regenerates, drains, enrages", () => {
    const lich = createMonster("lich", 0, 0, 10);
    expect(lich.traits).toContain("unique");
    lich.hp = Math.max(1, Math.floor(lich.maxHp * 0.3));
    const enrage = checkBossEnrage(lich);
    expect(enrage).toMatch(/enraged/i);
    expect(lich.enraged).toBe(true);

    lich.hp = Math.max(1, lich.maxHp - 10);
    const before = lich.hp;
    expect(tickMonsterRegen(lich)).toBe(true);
    expect(lich.hp).toBeGreaterThan(before);

    const p = makePlayer();
    p.level = 5;
    p.entity.maxHp = 30;
    p.entity.hp = 30;
    const drain = tryLevelDrain(lich, p, () => 0);
    expect(drain).toMatch(/drain|level|essence/i);
  });

  it("on-hit pipeline stacks ambush + steal for mixed traits", () => {
    // Mimic only ambush; nymph only steal — covered above.
    // Combined: apply on-hit to mimic still works without steal.
    const p = makePlayer();
    p.entity.hp = 50;
    const mimic = createMonster("mimic", 0, 0, 5);
    const msg = tryApplyMonsterOnHit(mimic, p);
    expect(msg).toMatch(/waiting|surprise/i);
  });
});
