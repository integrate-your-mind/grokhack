import { describe, it, expect, vi } from "vitest";
import {
  meleeAttack,
  conjugateVerb,
  useItem,
  updateHungerState,
  hungerCombatMod,
  effectivePlayerEntity,
  playerHitPenalty,
  tickMonsterRegen,
  tryBreathAttack,
  checkBossEnrage,
  tryApplyMonsterOnHit,
  tryLevelDrain,
  tickPlayerStatuses,
  playerAttackBonus,
  packChaseTarget,
  chooseStepToward,
  sacrificeCorpse,
  resolveThroneSit,
} from "./combat";
import {
  createPlayer,
  createMonster,
  createBossDragon,
  generateItem,
  potionMapForSeed,
  itemDisplayName,
  POTION_TRUE_NAMES,
  makeCorpse,
  monstersForDepth,
  pickMonsterKind,
  depthScale,
  hungerPerTurn,
  curseChance,
  monsterCountRange,
} from "./entities";
import type { PlayerState, Item } from "./types";

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

/** All severityVerb stems + expected third-person present (TICKET-ERR-02). */
const SEVERITY_VERB_3P: ReadonlyArray<readonly [string, string]> = [
  ["bash", "bashes"],
  ["smash", "smashes"],
  ["strike hard", "strikes hard"],
  ["hit", "hits"],
  ["cut", "cuts"],
  ["devastate", "devastates"],
  ["maul", "mauls"],
  ["nick", "nicks"],
  ["graze", "grazes"],
  ["glance", "glances"],
  ["wound", "wounds"],
  // also in severityVerb high band (not in triage list but same conjugator)
  ["brutalize", "brutalizes"],
];

describe("conjugateVerb", () => {
  it.each(SEVERITY_VERB_3P)("%s → %s", (stem, expected) => {
    expect(conjugateVerb(stem)).toBe(expected);
  });

  it("never emits live-bug forms bashs|smashs|strike hards", () => {
    for (const [stem, expected] of SEVERITY_VERB_3P) {
      const got = conjugateVerb(stem);
      expect(got).not.toMatch(/\bbashs\b|\bsmashs\b|strike hards/);
      expect(got).toBe(expected);
    }
  });

  it("conjugates only the first token of multi-word verbs", () => {
    expect(conjugateVerb("strike hard")).toBe("strikes hard");
    expect(conjugateVerb("  strike   hard  ")).toBe("strikes hard");
  });

  it("uses -es for sibilant endings (s/x/z/ch/sh)", () => {
    expect(conjugateVerb("bash")).toBe("bashes");
    expect(conjugateVerb("smash")).toBe("smashes");
    expect(conjugateVerb("slash")).toBe("slashes");
    expect(conjugateVerb("box")).toBe("boxes");
  });
});

describe("melee combat", () => {
  it("routes player attacks through the deterministic reducer without changing lazy RNG draws", () => {
    const attacker = createPlayer(0, 0);
    attacker.attack = 8;
    const defender = createMonster("rat", 1, 0, 1);
    defender.defense = 1;
    defender.hp = defender.maxHp = 8;
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.5).mockReturnValueOnce(0).mockReturnValueOnce(0);
    const result = meleeAttack(attacker, defender, { critChance: 0 });
    expect(result).toMatchObject({ hit: true, damage: 8, killed: true, critical: false });
    expect(defender.hp).toBe(0);
    expect(random).toHaveBeenCalledTimes(5);
    random.mockRestore();
  });

  it("consumes only hit and flavor rolls for a player miss", () => {
    const attacker = createPlayer(0, 0);
    const defender = createMonster("rat", 1, 0, 1);
    const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.99).mockReturnValueOnce(0);
    expect(meleeAttack(attacker, defender)).toMatchObject({ hit: false, damage: 0 });
    expect(random).toHaveBeenCalledTimes(2);
    random.mockRestore();
  });

  it("monster hit messages conjugate multi-word verbs (no strike hards)", () => {
    const mon = createMonster("orc", 1, 0, 1);
    mon.attack = 80;
    mon.defense = 0;
    const player = createPlayer(0, 0);
    player.hp = 100;
    player.maxHp = 100;
    player.defense = 0;

    let sawHit = false;
    for (let i = 0; i < 80; i++) {
      player.hp = 100;
      const r = meleeAttack(mon, player);
      if (!r.hit) continue;
      sawHit = true;
      expect(r.message).not.toMatch(/strike hards|smashs|bashs/);
      // Valid third-person forms when severity verbs appear
      if (/strike/.test(r.message)) expect(r.message).toMatch(/strikes hard/);
      if (/\bsmash/.test(r.message)) expect(r.message).toMatch(/smashes/);
      if (/\bbash/.test(r.message)) expect(r.message).toMatch(/bashes/);
    }
    expect(sawHit).toBe(true);
  });

  it("returns structured results with critical flag", () => {
    const a = createPlayer(0, 0);
    a.attack = 50;
    const d = createMonster("rat", 1, 0, 1);
    d.hp = 100;
    d.maxHp = 100;
    d.defense = 0;

    let sawHit = false;
    for (let i = 0; i < 40; i++) {
      d.hp = 100;
      const r = meleeAttack(a, d, { weaponName: "long sword" });
      expect(typeof r.critical).toBe("boolean");
      expect(typeof r.message).toBe("string");
      if (r.hit) {
        sawHit = true;
        expect(r.damage).toBeGreaterThan(0);
        expect(r.message.length).toBeGreaterThan(5);
      } else {
        expect(r.damage).toBe(0);
        expect(r.message.toLowerCase()).toMatch(/miss|dodge|whistle|wide/);
      }
    }
    expect(sawHit).toBe(true);
  });

  it("can kill weak monsters", () => {
    const a = createPlayer(0, 0);
    a.attack = 40;
    const d = createMonster("rat", 1, 0, 1);
    d.hp = 2;
    d.maxHp = 2;
    d.defense = 0;
    let killed = false;
    for (let i = 0; i < 20 && !killed; i++) {
      d.hp = 2;
      const r = meleeAttack(a, d);
      if (r.killed) killed = true;
    }
    expect(killed).toBe(true);
  });
});

describe("potion identity", () => {
  it("maps appearance to effect deterministically per seed", () => {
    const a = potionMapForSeed(42);
    const b = potionMapForSeed(42);
    const c = potionMapForSeed(99);
    expect([...a.entries()]).toEqual([...b.entries()]);
    // Different seeds usually differ (extremely unlikely to fully match)
    expect([...a.values()].join(",")).not.toEqual([...c.values()].join(","));
  });

  it("shows appearance until identified", () => {
    const pot = generateItem(3, "p1", 42);
    // force potion by retrying
    let potion: Item | null = null;
    for (let i = 0; i < 80; i++) {
      const it = generateItem(3, `p-${i}`, 42);
      if (it.type === "potion") {
        potion = it;
        break;
      }
    }
    expect(potion).not.toBeNull();
    expect(potion!.effect).toBeTruthy();
    expect(potion!.appearance).toBeTruthy();
    expect(itemDisplayName(potion!)).toContain("potion");
    expect(itemDisplayName(potion!)).not.toContain("of ");
    potion!.identified = true;
    expect(itemDisplayName(potion!)).toBe(POTION_TRUE_NAMES[potion!.effect!]);
  });

  it("applies healing and identifies the potion", () => {
    const p = makePlayer();
    p.entity.hp = 5;
    p.inventory.push({
      id: "h1",
      name: "red potion",
      char: "!",
      type: "potion",
      power: 10,
      identified: false,
      appearance: "red",
      effect: "healing",
    });
    const msg = useItem(p, 0);
    expect(msg).toMatch(/healing|better/i);
    expect(p.entity.hp).toBeGreaterThan(5);
    expect(p.inventory.length).toBe(0);
  });

  it("poison can hurt the drinker", () => {
    const p = makePlayer();
    p.entity.hp = 20;
    p.inventory.push({
      id: "x",
      name: "blue potion",
      char: "!",
      type: "potion",
      power: 10,
      identified: false,
      appearance: "blue",
      effect: "poison",
    });
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/poison/);
    expect(p.entity.hp).toBeLessThan(20);
  });

  it("strength permanently boosts attack", () => {
    const p = makePlayer();
    const before = p.entity.attack;
    p.inventory.push({
      id: "s",
      name: "green potion",
      char: "!",
      type: "potion",
      power: 8,
      identified: false,
      appearance: "green",
      effect: "strength",
    });
    useItem(p, 0);
    expect(p.entity.attack).toBe(before + 1);
  });

  it("auto-identifies matching potion colors in pack", () => {
    const p = makePlayer();
    p.entity.hp = 5;
    p.inventory.push(
      {
        id: "a",
        name: "red potion",
        char: "!",
        type: "potion",
        power: 10,
        identified: false,
        appearance: "red",
        effect: "healing",
      },
      {
        id: "b",
        name: "red potion",
        char: "!",
        type: "potion",
        power: 10,
        identified: false,
        appearance: "red",
        effect: "healing",
      },
      {
        id: "c",
        name: "blue potion",
        char: "!",
        type: "potion",
        power: 10,
        identified: false,
        appearance: "blue",
        effect: "poison",
      }
    );
    const msg = useItem(p, 0)!;
    expect(msg).toMatch(/recognize/i);
    expect(p.inventory.find((i) => i.id === "b")?.identified).toBe(true);
    expect(p.inventory.find((i) => i.id === "b")?.name).toMatch(/healing/i);
    expect(p.inventory.find((i) => i.id === "c")?.identified).toBe(false);
  });
});

describe("corpses", () => {
  it("creates edible food items", () => {
    const c = makeCorpse("goblin", "c1", { kind: "goblin" });
    expect(c.type).toBe("food");
    expect(c.name).toContain("goblin");
    expect(c.corpseUnsafe).toBe(false);
    const p = makePlayer();
    p.inventory.push(c);
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/eat|rotten/);
  });
});

describe("TICKET-DP-01 corpse ecology", () => {
  it("marks undead corpses unsafe", () => {
    const sk = makeCorpse("skeleton", "s1", { kind: "skeleton" });
    const wr = makeCorpse("wraith", "w1", { kind: "wraith" });
    const gob = makeCorpse("goblin", "g1", { kind: "goblin" });
    expect(sk.corpseUnsafe).toBe(true);
    expect(wr.corpseUnsafe).toBe(true);
    expect(gob.corpseUnsafe).toBe(false);
  });

  it("eating skeleton corpse always hurts and poisons", () => {
    const p = makePlayer();
    p.entity.hp = 20;
    p.entity.maxHp = 20;
    p.inventory.push(makeCorpse("skeleton", "sk", { kind: "skeleton" }));
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/undead|necrotic|poison/);
    expect(p.entity.hp).toBeLessThan(20);
    expect(p.statuses.some((s) => s.kind === "poison")).toBe(true);
    expect(p.inventory.length).toBe(0);
  });

  it("shrine sacrifice consumes corpse and can heal (forced roll)", () => {
    const p = makePlayer();
    p.entity.hp = 5;
    p.entity.maxHp = 20;
    p.inventory.push(makeCorpse("orc", "o1", { kind: "orc" }));
    const msg = sacrificeCorpse(p, 0, 0.1); // heal band
    expect(msg.toLowerCase()).toMatch(/sacrifice|restore|warmth|heal|hp/i);
    expect(p.entity.hp).toBeGreaterThan(5);
    expect(p.inventory.length).toBe(0);
  });

  it("shrine sacrifice can bless weapon (forced roll)", () => {
    const p = makePlayer();
    p.equippedWeapon = {
      id: "w",
      name: "dagger",
      char: ")",
      type: "weapon",
      power: 3,
      identified: true,
      buc: "uncursed",
    };
    const before = p.equippedWeapon.power;
    p.inventory.push(makeCorpse("rat", "r1", { kind: "rat" }));
    const msg = sacrificeCorpse(p, 0, 0.5); // bless band 0.4–0.7
    expect(msg.toLowerCase()).toMatch(/bless/);
    expect(p.equippedWeapon.buc).toBe("blessed");
    expect(p.equippedWeapon.bucKnown).toBe(true);
    expect(p.equippedWeapon.power).toBe(before + 1);
  });

  it("throne sit table covers gold / buff / summon / none", () => {
    const goldP = makePlayer();
    goldP.depth = 4;
    goldP.gold = 0;
    expect(resolveThroneSit(goldP, 0.1).message).toMatch(/gold/i);
    expect(goldP.gold).toBeGreaterThan(0);

    const buffP = makePlayer();
    const atk = buffP.entity.attack;
    const def = buffP.entity.defense;
    const buffMsg = resolveThroneSit(buffP, 0.5).message;
    expect(buffMsg.toLowerCase()).toMatch(/attack|defense|throne/);
    expect(buffP.entity.attack + buffP.entity.defense).toBeGreaterThan(atk + def);

    const sum = resolveThroneSit(makePlayer(), 0.75);
    expect(sum.summon).toBeTruthy();
    expect(sum.message.toLowerCase()).toMatch(/guardian|erupts|summon|orc|ogre|goblin/);

    const none = resolveThroneSit(makePlayer(), 0.95);
    expect(none.summon).toBeUndefined();
    expect(none.message.toLowerCase()).toMatch(/nothing/);
  });
});

describe("hunger still works", () => {
  it("updates state", () => {
    const p = makePlayer();
    p.hunger = 60; // 6% → fainting band (5–15%)
    updateHungerState(p);
    expect(p.hungerState).toBe("fainting");
  });
});

describe("depth / difficulty balance", () => {
  it("applies hunger combat penalties when weak/starving", () => {
    expect(hungerCombatMod("normal").attack).toBe(0);
    expect(hungerCombatMod("weak").attack).toBeLessThan(0);
    expect(hungerCombatMod("starving").attack).toBeLessThan(hungerCombatMod("weak").attack);
    expect(hungerCombatMod("starving").hitPenalty).toBeGreaterThan(0.15);

    const p = makePlayer();
    p.entity.attack = 5;
    p.hungerState = "starving";
    const eff = effectivePlayerEntity(p);
    expect(eff.attack).toBeLessThan(5);
    expect(playerHitPenalty(p)).toBeGreaterThan(0);
  });

  it("cursed weapons reduce attack bonus", () => {
    const p = makePlayer();
    p.equippedWeapon = {
      id: "w",
      name: "long sword",
      char: ")",
      type: "weapon",
      power: 8,
      identified: true,
      cursed: true,
    };
    expect(playerAttackBonus(p)).toBe(6); // 8 - 2 curse tax
  });

  it("trolls regenerate each tick", () => {
    const troll = createMonster("troll", 0, 0, 5);
    troll.hp = Math.max(1, troll.maxHp - 10);
    const before = troll.hp;
    expect(tickMonsterRegen(troll)).toBe(true);
    expect(troll.hp).toBeGreaterThan(before);
  });

  it("snakes can apply poison on hit", () => {
    const p = makePlayer();
    const snake = createMonster("snake", 0, 0, 3);
    // Force-apply by retrying
    let poisoned = false;
    for (let i = 0; i < 40; i++) {
      p.statuses = [];
      const msg = tryApplyMonsterOnHit(snake, p);
      if (msg && p.statuses.some((s) => s.kind === "poison")) {
        poisoned = true;
        break;
      }
    }
    expect(poisoned).toBe(true);
  });

  it("wraiths carry level_drain and can steal a level", () => {
    const p = makePlayer();
    p.level = 4;
    p.entity.maxHp = 28;
    p.entity.hp = 28;
    p.entity.attack = 7;
    p.entity.defense = 5;
    p.xp = 40;
    const wraith = createMonster("wraith", 0, 0, 7);
    expect(wraith.traits).toContain("level_drain");

    let drained = false;
    for (let i = 0; i < 60; i++) {
      p.level = 4;
      p.entity.maxHp = 28;
      p.entity.hp = 28;
      p.entity.attack = 7;
      p.entity.defense = 5;
      p.xp = 40;
      const msg = tryLevelDrain(wraith, p, () => 0); // force proc
      if (msg && /drain|level/i.test(msg)) {
        drained = true;
        expect(p.level).toBe(3);
        expect(p.entity.maxHp).toBe(24);
        expect(p.entity.attack).toBe(6);
        expect(p.entity.defense).toBe(4);
        break;
      }
    }
    expect(drained).toBe(true);
  });

  it("level drain at level 1 saps max HP instead", () => {
    const p = makePlayer();
    p.level = 1;
    p.entity.maxHp = 20;
    p.entity.hp = 20;
    const wraith = createMonster("wraith", 0, 0, 7);
    const msg = tryLevelDrain(wraith, p, () => 0);
    expect(msg).toMatch(/essence|max HP/i);
    expect(p.level).toBe(1);
    expect(p.entity.maxHp).toBeLessThan(20);
  });

  it("pack chase prefers open flanks over dogpile", () => {
    // Prey at (5,5); flank (6,5) free; (4,5) blocked
    const aim = packChaseTarget(8, 5, 5, 5, (x, y) => x === 4 && y === 5);
    expect(aim).toEqual({ x: 6, y: 5 });
  });

  it("chooseStepToward prefers longer axis", () => {
    const steps: string[] = [];
    chooseStepToward(0, 0, 3, 1, (dx, dy) => {
      steps.push(`${dx},${dy}`);
      return dx === 1 && dy === 0; // accept east
    });
    expect(steps[0]).toBe("1,0");
  });

  it("poison status ticks damage the player", () => {
    const p = makePlayer();
    p.entity.hp = 20;
    p.statuses = [{ kind: "poison", turnsLeft: 2, power: 2 }];
    const msg = tickPlayerStatuses(p);
    expect(msg).toMatch(/poison/i);
    expect(p.entity.hp).toBe(18);
    expect(p.statuses[0]?.turnsLeft).toBe(1);
  });

  it("dragon breath hits at range and ignores half defense", () => {
    const p = makePlayer();
    p.entity.hp = 40;
    p.entity.defense = 10;
    p.equippedArmor = {
      id: "a",
      name: "plate mail",
      char: "[",
      type: "armor",
      power: 10,
      identified: true,
    };
    const dragon = createBossDragon(0, 0, 10);
    dragon.specialCooldown = 0;
    // Force many tries — enraged always breathes
    dragon.enraged = true;
    let sawBreath = false;
    for (let i = 0; i < 10; i++) {
      dragon.specialCooldown = 0;
      p.entity.hp = 40;
      const r = tryBreathAttack(dragon, p, 3);
      if (r) {
        sawBreath = true;
        expect(r.hit).toBe(true);
        expect(r.damage).toBeGreaterThan(0);
        expect(r.message.toLowerCase()).toMatch(/fire|breath/);
        break;
      }
    }
    expect(sawBreath).toBe(true);
  });

  it("boss enrages below 40% HP", () => {
    const dragon = createBossDragon(0, 0, 10);
    dragon.hp = Math.floor(dragon.maxHp * 0.3);
    const atkBefore = dragon.attack;
    const msg = checkBossEnrage(dragon);
    expect(msg).toMatch(/enraged|fury/i);
    expect(dragon.enraged).toBe(true);
    expect(dragon.attack).toBeGreaterThan(atkBefore);
    // second call is no-op
    expect(checkBossEnrage(dragon)).toBeNull();
  });

  it("cursed equipped gear cannot be swapped", () => {
    const p = makePlayer();
    p.equippedWeapon = {
      id: "cursed",
      name: "dagger",
      char: ")",
      type: "weapon",
      power: 3,
      identified: true,
      cursed: true,
    };
    p.inventory.push({
      id: "better",
      name: "long sword",
      char: ")",
      type: "weapon",
      power: 8,
      identified: false,
    });
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/cursed|stuck/);
    expect(p.equippedWeapon?.id).toBe("cursed");
  });

  it("scroll of remove curse cleanses gear", () => {
    const p = makePlayer();
    p.equippedWeapon = {
      id: "c",
      name: "mace",
      char: ")",
      type: "weapon",
      power: 6,
      identified: true,
      cursed: true,
    };
    p.inventory.push({
      id: "sc",
      name: "scroll of remove curse",
      char: "?",
      type: "scroll",
      power: 1,
      identified: false,
    });
    const msg = useItem(p, 0)!;
    expect(msg.toLowerCase()).toMatch(/curse|cleansed/);
    expect(p.equippedWeapon?.cursed).toBe(false);
  });

  it("depth tables escalate threat kinds", () => {
    const early = monstersForDepth(1);
    const late = monstersForDepth(9);
    expect(early).toContain("rat");
    expect(early).not.toContain("troll");
    expect(late).toContain("troll");
    expect(late.some((k) => k === "dragon" || k === "ogre" || k === "wraith")).toBe(true);

    // Weighted pick is stable for fixed roll
    expect(pickMonsterKind(1, 0)).toBe("rat");
  });

  it("asymmetric scaling: HP grows faster than attack", () => {
    const s1 = depthScale(1);
    const s10 = depthScale(10);
    expect(s10.hp - s1.hp).toBeGreaterThan(s10.attack - s1.attack);
    const d1 = createMonster("orc", 0, 0, 1);
    const d10 = createMonster("orc", 0, 0, 10);
    expect(d10.hp / d1.hp).toBeGreaterThan(d10.attack / d1.attack);
  });

  it("boss dragon is tougher than table dragon", () => {
    const normal = createMonster("dragon", 0, 0, 10);
    const boss = createBossDragon(0, 0, 10);
    expect(boss.hp).toBeGreaterThan(normal.hp);
    expect(boss.traits).toContain("breath");
    expect(boss.traits).toContain("boss");
    expect(boss.name).toMatch(/ancient/i);
  });

  it("hunger and curse pressure escalate with depth", () => {
    expect(hungerPerTurn(1)).toBe(2);
    expect(hungerPerTurn(7)).toBeGreaterThan(hungerPerTurn(1));
    expect(curseChance(10)).toBeGreaterThan(curseChance(1));
    // Depth team raised mid/late curse pressure (cap 0.34); still bounded.
    expect(curseChance(10)).toBeLessThanOrEqual(0.34);
    const early = monsterCountRange(1);
    const late = monsterCountRange(10);
    expect(late.max).toBeGreaterThan(early.max);
  });

  it("poison potions leave residual poison status", () => {
    const p = makePlayer();
    p.entity.hp = 30;
    p.inventory.push({
      id: "poi",
      name: "inky potion",
      char: "!",
      type: "potion",
      power: 12,
      identified: false,
      appearance: "inky",
      effect: "poison",
    });
    useItem(p, 0);
    expect(p.entity.hp).toBeLessThan(30);
    expect(p.statuses.some((s) => s.kind === "poison")).toBe(true);
  });

  it("healing potions clear poison", () => {
    const p = makePlayer();
    p.entity.hp = 10;
    p.statuses = [{ kind: "poison", turnsLeft: 5, power: 2 }];
    p.inventory.push({
      id: "h",
      name: "red potion",
      char: "!",
      type: "potion",
      power: 10,
      identified: false,
      appearance: "red",
      effect: "healing",
    });
    useItem(p, 0);
    expect(p.statuses.some((s) => s.kind === "poison")).toBe(false);
  });
});
