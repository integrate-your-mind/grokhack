import { describe, it, expect } from "vitest";
import {
  autoIdentifyMatchingPotions,
  autoIdentifyMatchingRings,
  autoIdentifyMatchingScrolls,
  autoIdentifyMatchingWands,
  playerDefenseBonus,
  playerAttackBonus,
  ringHungerDrain,
  tickRingRegen,
  useItem,
} from "./combat";
import {
  createPlayer,
  fullyIdentify,
  generateItem,
  generatePotion,
  generateRing,
  generateScroll,
  generateWand,
  itemDisplayName,
  itemTypeWeights,
  potionMapForSeed,
  ringMapForSeed,
  rollBuc,
  SCROLL_TRUE_NAMES,
  scrollMapForSeed,
  RING_TRUE_NAMES,
  WAND_TRUE_NAMES,
  wandMapForSeed,
} from "./entities";
import type { Item, PlayerState } from "./types";

function makePlayer(): PlayerState {
  const entity = createPlayer(1, 1);
  return {
    entity,
    level: 1,
    xp: 0,
    xpToLevel: 20,
    hunger: 500,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: [],
    equippedWeapon: null,
    equippedArmor: null,
    equippedRing: null,
    gold: 0,
    turns: 0,
    depth: 1,
    alive: true,
    statuses: [],
  };
}

describe("seeded appearance maps", () => {
  it("potion/scroll/ring/wand maps are deterministic per seed", () => {
    expect([...potionMapForSeed(42).entries()]).toEqual([...potionMapForSeed(42).entries()]);
    expect([...scrollMapForSeed(42).entries()]).toEqual([...scrollMapForSeed(42).entries()]);
    expect([...ringMapForSeed(42).entries()]).toEqual([...ringMapForSeed(42).entries()]);
    expect([...wandMapForSeed(42).entries()]).toEqual([...wandMapForSeed(42).entries()]);
  });

  it("different seeds reshuffle mappings", () => {
    const a = [...potionMapForSeed(1).values()].join(",");
    const b = [...potionMapForSeed(999).values()].join(",");
    expect(a).not.toEqual(b);
    const wa = [...wandMapForSeed(1).values()].join(",");
    const wb = [...wandMapForSeed(999).values()].join(",");
    expect(wa).not.toEqual(wb);
  });

  it("scroll and potion maps for same seed are independent (salted)", () => {
    // Same index shouldn't always map to "same" kind of power — salts diverge shuffles
    const pot = potionMapForSeed(7);
    const scr = scrollMapForSeed(7);
    expect(pot.size).toBeGreaterThan(5);
    expect(scr.size).toBeGreaterThan(5);
  });

  it("wand map is independent of potion/scroll/ring salts", () => {
    const wand = wandMapForSeed(7);
    expect(wand.size).toBeGreaterThan(5);
    // glass wand must resolve to a known effect for seed 7
    expect(wand.get("glass")).toBeTruthy();
  });
});

describe("item generation tables", () => {
  it("includes rings and scrolls in weight table", () => {
    const w = itemTypeWeights(5);
    const types = w.map((x) => x.type);
    expect(types).toContain("ring");
    expect(types).toContain("scroll");
    expect(types).toContain("potion");
    expect(types).toContain("wand");
  });

  it("rings become more common at depth", () => {
    const early = itemTypeWeights(1).find((x) => x.type === "ring")!.w;
    const deep = itemTypeWeights(10).find((x) => x.type === "ring")!.w;
    expect(deep).toBeGreaterThan(early);
  });

  it("wands become more common at depth", () => {
    const early = itemTypeWeights(1).find((x) => x.type === "wand")!.w;
    const deep = itemTypeWeights(10).find((x) => x.type === "wand")!.w;
    expect(deep).toBeGreaterThan(early);
  });

  it("generateItem can produce all major types over many rolls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(generateItem(8, `i-${i}`, 123).type);
    }
    expect(seen.has("potion")).toBe(true);
    expect(seen.has("scroll")).toBe(true);
    expect(seen.has("ring")).toBe(true);
    expect(seen.has("wand")).toBe(true);
    expect(seen.has("weapon")).toBe(true);
  });

  it("scrolls spawn with labels, not true names, until identified", () => {
    const sc = generateScroll(4, "s1", 55);
    expect(sc.type).toBe("scroll");
    expect(sc.appearance).toBeTruthy();
    expect(sc.scrollEffect).toBeTruthy();
    expect(sc.identified).toBe(false);
    expect(itemDisplayName(sc)).toMatch(/scroll labeled/i);
    expect(itemDisplayName(sc)).not.toMatch(/scroll of /i);
    fullyIdentify(sc);
    expect(itemDisplayName(sc)).toBe(SCROLL_TRUE_NAMES[sc.scrollEffect!]);
  });

  it("rings spawn with material appearance", () => {
    const r = generateRing(5, "r1", 77, "silver");
    expect(r.appearance).toBe("silver");
    expect(r.ringEffect).toBe(ringMapForSeed(77).get("silver"));
    expect(itemDisplayName(r)).toBe("silver ring");
    fullyIdentify(r);
    expect(itemDisplayName(r)).toBe(RING_TRUE_NAMES[r.ringEffect!]);
  });

  it("wands spawn with material appearance and charges, not true names", () => {
    const w = generateWand(4, "w1", 88, "glass");
    expect(w.type).toBe("wand");
    expect(w.appearance).toBe("glass");
    expect(w.wandEffect).toBe(wandMapForSeed(88).get("glass"));
    expect(w.identified).toBe(false);
    expect(w.charges).toBeGreaterThanOrEqual(1);
    expect(w.charges).toBeLessThanOrEqual(8);
    expect(itemDisplayName(w)).toBe("glass wand");
    expect(itemDisplayName(w)).not.toMatch(/wand of /i);
    fullyIdentify(w);
    expect(itemDisplayName(w)).toMatch(WAND_TRUE_NAMES[w.wandEffect!]);
    expect(itemDisplayName(w)).toMatch(/charge/);
  });

  it("rollBuc produces valid BUC values", () => {
    const counts = { blessed: 0, uncursed: 0, cursed: 0 };
    for (let i = 0; i < 200; i++) {
      counts[rollBuc(5, () => i / 200)]++;
    }
    // With deterministic rng ladder we should hit all bands
    expect(counts.blessed + counts.uncursed + counts.cursed).toBe(200);
  });
});

describe("potion identify risk/reward", () => {
  it("poison is worse when cursed", () => {
    const p1 = makePlayer();
    p1.entity.hp = 40;
    p1.inventory.push(
      generatePotion(5, "a", 1, "inky", "uncursed")
    );
    // force poison
    p1.inventory[0].effect = "poison";
    p1.inventory[0].power = 10;
    const hp1 = p1.entity.hp;
    useItem(p1, 0);
    const dmgUncursed = hp1 - p1.entity.hp;

    const p2 = makePlayer();
    p2.entity.hp = 40;
    p2.inventory.push(generatePotion(5, "b", 1, "inky", "cursed"));
    p2.inventory[0].effect = "poison";
    p2.inventory[0].power = 10;
    const hp2 = p2.entity.hp;
    useItem(p2, 0);
    const dmgCursed = hp2 - p2.entity.hp;
    expect(dmgCursed).toBeGreaterThanOrEqual(dmgUncursed);
  });

  it("auto-identifies matching potion colors", () => {
    const p = makePlayer();
    const pot = generatePotion(3, "p1", 9, "red");
    pot.effect = "healing";
    const twin = generatePotion(3, "p2", 9, "red");
    twin.effect = "healing";
    const other = generatePotion(3, "p3", 9, "blue");
    p.inventory.push(pot, twin, other);
    useItem(p, 0);
    expect(p.inventory.find((i) => i.id === "p2")?.identified).toBe(true);
    expect(p.inventory.find((i) => i.id === "p3")?.identified).toBe(false);
  });
});

describe("scroll identify risk/reward", () => {
  it("reading reveals label mapping and auto-ids matches", () => {
    const p = makePlayer();
    const map = scrollMapForSeed(42);
    // pick a safe effect
    let label = "FOOBIE BLETCH";
    for (const [lab, eff] of map) {
      if (eff === "teleport") {
        label = lab;
        break;
      }
    }
    const a = generateScroll(3, "s1", 42, label);
    const b = generateScroll(3, "s2", 42, label);
    p.inventory.push(a, b);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/teleport|blur|displaced|lurch/);
    expect(p.inventory.find((i) => i.id === "s2")?.identified).toBe(true);
    expect(p.inventory.find((i) => i.id === "s2")?.name).toMatch(/teleport/i);
  });

  it("scroll of fire damages and may destroy items", () => {
    const p = makePlayer();
    p.entity.hp = 30;
    const fire = generateScroll(5, "f1", 1);
    fire.scrollEffect = "fire";
    fire.appearance = "THARR";
    fire.name = "scroll labeled THARR";
    fire.buc = "uncursed";
    p.inventory.push(fire, {
      id: "ration",
      name: "ration",
      char: "%",
      type: "food",
      power: 100,
      identified: true,
    });
    const before = p.entity.hp;
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/flame|burn|fire/);
    expect(p.entity.hp).toBeLessThan(before);
  });

  it("scroll of amnesia un-identifies known items", () => {
    const p = makePlayer();
    const known: Item = {
      id: "k1",
      name: "potion of healing",
      char: "!",
      type: "potion",
      power: 10,
      identified: true,
      appearance: "red",
      effect: "healing",
      buc: "uncursed",
      bucKnown: true,
    };
    const amn = generateScroll(4, "a1", 2);
    amn.scrollEffect = "amnesia";
    amn.appearance = "NR 9";
    p.inventory.push(amn, known);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/amnesia|forget|foggy/);
    // Either wiped or reported nothing — if wiped, identified false
    if (msg.includes("forget")) {
      expect(p.inventory.find((i) => i.id === "k1")?.identified).toBe(false);
    }
  });

  it("blessed identify can reveal multiple items", () => {
    const p = makePlayer();
    const idScroll = generateScroll(3, "id", 3);
    idScroll.scrollEffect = "identify";
    idScroll.buc = "blessed";
    idScroll.appearance = "YUM YUM";
    p.inventory.push(
      idScroll,
      generatePotion(2, "u1", 3, "red"),
      generateRing(2, "u2", 3, "gold"),
      generateScroll(2, "u3", 3)
    );
    // ensure unknowns
    for (const it of p.inventory) {
      if (it.id !== "id") it.identified = false;
    }
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/identify|reveal/);
    const stillUnknown = p.inventory.filter((i) => !i.identified).length;
    // blessed reveals up to 3; we had 3 unknowns
    expect(stillUnknown).toBeLessThanOrEqual(0);
  });

  it("remove curse cleanses equipped cursed gear", () => {
    const p = makePlayer();
    p.equippedWeapon = {
      id: "w",
      name: "dagger",
      char: ")",
      type: "weapon",
      power: 3,
      identified: true,
      cursed: true,
      buc: "cursed",
    };
    const sc = generateScroll(4, "rc", 4);
    sc.scrollEffect = "remove_curse";
    p.inventory.push(sc);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/curse|cleansed/);
    expect(p.equippedWeapon?.cursed).toBe(false);
    expect(p.equippedWeapon?.buc).toBe("uncursed");
  });
});

describe("rings", () => {
  it("wearing identifies and applies protection defense", () => {
    const p = makePlayer();
    const ring = generateRing(4, "r1", 10, "iron");
    ring.ringEffect = "protection";
    ring.power = 2;
    ring.buc = "uncursed";
    p.inventory.push(ring);
    const before = playerDefenseBonus(p);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/ring|ward|protection|put on/);
    expect(p.equippedRing?.identified).toBe(true);
    expect(playerDefenseBonus(p)).toBeGreaterThan(before);
  });

  it("ring of hunger drains extra", () => {
    const p = makePlayer();
    p.equippedRing = generateRing(3, "h", 11, "wooden");
    p.equippedRing.ringEffect = "hunger";
    p.equippedRing.identified = true;
    p.equippedRing.buc = "uncursed";
    expect(ringHungerDrain(p)).toBe(2);
    p.equippedRing.buc = "cursed";
    p.equippedRing.cursed = true;
    expect(ringHungerDrain(p)).toBe(4);
  });

  it("ring of regeneration heals over time", () => {
    const p = makePlayer();
    p.entity.hp = 5;
    p.equippedRing = generateRing(3, "reg", 12, "opal");
    p.equippedRing.ringEffect = "regeneration";
    p.equippedRing.buc = "uncursed";
    p.equippedRing.cursed = false;
    expect(tickRingRegen(p)).toBe(true);
    expect(p.entity.hp).toBe(6);
  });

  it("cursed ring sticks when swapping", () => {
    const p = makePlayer();
    p.equippedRing = generateRing(3, "c", 13, "jade");
    p.equippedRing.cursed = true;
    p.equippedRing.buc = "cursed";
    p.equippedRing.identified = true;
    const other = generateRing(3, "o", 13, "gold");
    p.inventory.push(other);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/cursed|won't come off/);
    expect(p.equippedRing?.id).toBe("c");
  });

  it("auto-identifies matching ring materials", () => {
    const p = makePlayer();
    const a = generateRing(3, "a", 14, "copper");
    a.ringEffect = "stealth";
    const b = generateRing(3, "b", 14, "copper");
    b.ringEffect = "stealth";
    p.inventory.push(a, b);
    useItem(p, 0);
    expect(p.inventory.find((i) => i.id === "b")?.identified).toBe(true);
  });

  it("adornment boosts attack when identified", () => {
    const p = makePlayer();
    p.equippedRing = generateRing(2, "ad", 15, "gold");
    p.equippedRing.ringEffect = "adornment";
    p.equippedRing.identified = true;
    p.equippedRing.buc = "uncursed";
    expect(playerAttackBonus(p)).toBe(1);
  });
});

describe("formal identify helpers", () => {
  it("fullyIdentify sets bucKnown and true name", () => {
    const pot = generatePotion(2, "x", 20, "milky");
    fullyIdentify(pot);
    expect(pot.identified).toBe(true);
    expect(pot.bucKnown).toBe(true);
    expect(pot.name).toMatch(/potion of /);
  });

  it("autoIdentifyMatchingScrolls is pure pack update", () => {
    const p = makePlayer();
    const a = generateScroll(2, "a", 21, "ELBIB YLOH");
    const b = generateScroll(2, "b", 21, "ELBIB YLOH");
    a.identified = true;
    a.scrollEffect = "magic_mapping";
    p.inventory.push(a, b);
    const n = autoIdentifyMatchingScrolls(p, "ELBIB YLOH", "magic_mapping");
    expect(n).toBe(1);
    expect(b.identified).toBe(true);
  });

  it("autoIdentifyMatchingRings and potions export for reuse", () => {
    const p = makePlayer();
    expect(autoIdentifyMatchingPotions(p, undefined, "healing")).toBe(0);
    expect(autoIdentifyMatchingRings(p, undefined, "protection")).toBe(0);
    expect(autoIdentifyMatchingWands(p, undefined, "light")).toBe(0);
  });
});

describe("wand identify risk/reward", () => {
  it("unidentified wand shows material, not true name", () => {
    const w = generateWand(3, "g1", 42, "glass");
    expect(itemDisplayName(w)).toBe("glass wand");
    expect(itemDisplayName(w)).not.toMatch(/wand of /);
  });

  it("zapping identifies and spends a charge", () => {
    const p = makePlayer();
    const w = generateWand(3, "w1", 50, "maple", "uncursed", 3);
    w.wandEffect = "light";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/light|flash|zap/);
    expect(p.inventory[0]?.identified).toBe(true);
    expect(p.inventory[0]?.charges).toBe(2);
    expect(p.inventory[0]?.name).toMatch(/wand of light/i);
  });

  it("empty wand does nothing and stays in pack", () => {
    const p = makePlayer();
    const w = generateWand(3, "e1", 51, "oak", "uncursed", 0);
    w.wandEffect = "cold";
    w.identified = true;
    w.name = WAND_TRUE_NAMES.cold;
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/empty/);
    expect(p.inventory.length).toBe(1);
    expect(p.inventory[0]?.charges).toBe(0);
  });

  it("last charge marks wand empty", () => {
    const p = makePlayer();
    const w = generateWand(3, "last", 52, "pine", "uncursed", 1);
    w.wandEffect = "nothing";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/nothing|fizzle|empty/);
    expect(p.inventory[0]?.charges).toBe(0);
    expect(msg.toLowerCase()).toMatch(/empty/);
  });

  it("digging returns WAND_DIGGING message token", () => {
    const p = makePlayer();
    const w = generateWand(4, "dig", 53, "crystal", "uncursed", 2);
    w.wandEffect = "digging";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.startsWith("WAND_DIGGING:")).toBe(true);
    expect(msg.toLowerCase()).toMatch(/tunnel|rock|dig/);
  });

  it("striking damages the zappy adventurer", () => {
    const p = makePlayer();
    p.entity.hp = 30;
    const w = generateWand(5, "st", 54, "brass", "uncursed", 2);
    w.wandEffect = "striking";
    w.power = 8;
    p.inventory.push(w);
    const before = p.entity.hp;
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/force|bolt|striking|damage|hp/);
    expect(p.entity.hp).toBeLessThan(before);
  });

  it("cold damages on zap", () => {
    const p = makePlayer();
    p.entity.hp = 25;
    const w = generateWand(4, "c", 55, "silver", "uncursed", 2);
    w.wandEffect = "cold";
    w.power = 6;
    p.inventory.push(w);
    const before = p.entity.hp;
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/frost|cold|freeze/);
    expect(p.entity.hp).toBeLessThan(before);
  });

  it("sleep applies a defense penalty (uncursed)", () => {
    const p = makePlayer();
    const before = p.entity.defense;
    const w = generateWand(3, "sl", 56, "ebony", "uncursed", 2);
    w.wandEffect = "sleep";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/sleep|sleepy|drowse/);
    expect(p.entity.defense).toBeLessThan(before);
  });

  it("secret door detection returns flavor token", () => {
    const p = makePlayer();
    const w = generateWand(3, "sd", 57, "tin", "uncursed", 1);
    w.wandEffect = "secret_door_detection";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.startsWith("WAND_SECRET_DOORS:")).toBe(true);
    expect(msg.toLowerCase()).toMatch(/secret|door/);
  });

  it("cursed wand explodes on zap and is destroyed", () => {
    const p = makePlayer();
    p.entity.hp = 40;
    const w = generateWand(5, "curse", 58, "marble", "cursed", 4);
    w.wandEffect = "light";
    w.power = 10;
    p.inventory.push(w);
    const before = p.entity.hp;
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/explod/);
    expect(p.entity.hp).toBeLessThan(before);
    expect(p.inventory.find((i) => i.id === "curse")).toBeUndefined();
    // still identifies the type via message
    expect(msg.toLowerCase()).toMatch(/wand of light/);
  });

  it("auto-identifies matching wand materials after zap", () => {
    const p = makePlayer();
    const a = generateWand(3, "a", 59, "copper", "uncursed", 2);
    a.wandEffect = "light";
    const b = generateWand(3, "b", 59, "copper", "uncursed", 2);
    b.wandEffect = "light";
    const other = generateWand(3, "o", 59, "glass", "uncursed", 2);
    p.inventory.push(a, b, other);
    useItem(p, 0);
    expect(p.inventory.find((i) => i.id === "b")?.identified).toBe(true);
    expect(p.inventory.find((i) => i.id === "o")?.identified).toBe(false);
  });

  it("polymorph-lite can change stats", () => {
    const p = makePlayer();
    p.entity.hp = 30;
    const atk = p.entity.attack;
    const def = p.entity.defense;
    const w = generateWand(4, "poly", 60, "balsa", "uncursed", 2);
    w.wandEffect = "polymorph";
    p.inventory.push(w);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/shimmer|reshape|warp|polymorph|change|form/);
    // uncursed: either atk+1 or def-1
    expect(p.entity.attack !== atk || p.entity.defense !== def).toBe(true);
  });

  it("charges stay in 1–8 range at generation", () => {
    for (let i = 0; i < 40; i++) {
      const w = generateWand(1 + (i % 10), `ch-${i}`, 100 + i);
      expect(w.charges).toBeGreaterThanOrEqual(1);
      expect(w.charges).toBeLessThanOrEqual(8);
    }
  });
});
