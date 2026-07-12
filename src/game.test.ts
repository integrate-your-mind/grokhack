import { describe, it, expect } from "vitest";
import { generateDungeon, isWalkable } from "./dungeon";
import { RNG } from "./rng";
import { newGame, tryMove, waitTurn, tryDescend, trySpecialInteract, roomAt } from "./game";
import {
  hungerDamage,
  updateHungerState,
  meleeAttack,
  applyXpGain,
  effectivePlayerEntity,
} from "./combat";
import {
  createPlayer,
  createMonster,
  createBossDragon,
  createStarterItems,
  monstersForDepth,
  pickMonsterKind,
  monsterCountRange,
  depthFlavor,
  hungerPerTurn,
  makeCorpse,
  STARTER_XP_TO_LEVEL,
} from "./entities";
import type { PlayerState } from "./types";

describe("dungeon generation", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateDungeon(new RNG(42), 1);
    const b = generateDungeon(new RNG(42), 1);
    expect(a.stairsDown).toEqual(b.stairsDown);
    expect(a.rooms.length).toBe(b.rooms.length);
  });

  it("places walkable stairs", () => {
    const d = generateDungeon(new RNG(99), 3);
    expect(isWalkable(d.tiles, d.stairsDown.x, d.stairsDown.y)).toBe(true);
    expect(isWalkable(d.tiles, d.stairsUp.x, d.stairsUp.y)).toBe(true);
  });
});

describe("hunger", () => {
  it("damages player when starving", () => {
    expect(hungerDamage("starving")).toBe(3);
    expect(hungerDamage("normal")).toBe(0);
  });

  it("transitions to fainting below 5% food", () => {
    const p: PlayerState = {
      entity: createPlayer(0, 0),
      level: 1,
      xp: 0,
      xpToLevel: 20,
      hunger: 60,
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
    updateHungerState(p);
    expect(p.hungerState).toBe("fainting");
  });
});

describe("game rules", () => {
  it("starts in playing phase with gear equipped", () => {
    const g = newGame(12345);
    expect(g.phase).toBe("playing");
    expect(g.player.equippedWeapon).not.toBeNull();
    expect(g.player.equippedArmor).not.toBeNull();
    expect(g.monsters.length).toBeGreaterThan(0);
  });

  it("does not consume a turn when bumping a wall", () => {
    const g = newGame(1);
    // place player adjacent to any wall
    outer: for (let y = 0; y < g.dungeon.height; y++) {
      for (let x = 0; x < g.dungeon.width; x++) {
        if (g.dungeon.tiles[y][x] !== "#") continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const fx = x + dx;
          const fy = y + dy;
          if (!isWalkable(g.dungeon.tiles, fx, fy)) continue;
          g.player.entity.x = fx;
          g.player.entity.y = fy;
          const before = g.player.turns;
          tryMove(g, { dx: -dx || 0, dy: -dy || 0 });
          expect(g.player.turns).toBe(before);
          break outer;
        }
      }
    }
  });

  it("kills player from starvation within expected turns without food", () => {
    const g = newGame(42);
    for (let i = 0; i < 400 && g.phase === "playing"; i++) waitTurn(g);
    expect(g.phase).toBe("dead");
    expect(g.player.turns).toBeLessThan(350);
  });
});

describe("combat scaling", () => {
  it("scales dragon HP at depth 10", () => {
    const dragon = createMonster("dragon", 0, 0, 10);
    expect(dragon.hp).toBeGreaterThanOrEqual(90);
  });

  it("depth-1 rats are beatable; depth-8 trolls are not free", () => {
    const player = createPlayer(0, 0);
    player.attack = 7; // dagger + base-ish
    const rat = createMonster("rat", 1, 0, 1);
    let ratKills = 0;
    for (let i = 0; i < 30; i++) {
      rat.hp = rat.maxHp;
      const r = meleeAttack(
        { ...player, isPlayer: true },
        rat
      );
      if (r.killed) ratKills++;
    }
    expect(ratKills).toBeGreaterThan(0);

    const troll = createMonster("troll", 1, 0, 8);
    expect(troll.hp).toBeGreaterThan(40);
    expect(troll.traits).toContain("regenerate");
  });

  it("wraith and ogre exist in late tables", () => {
    const wraith = createMonster("wraith", 0, 0, 7);
    const ogre = createMonster("ogre", 0, 0, 8);
    expect(wraith.char).toBe("W");
    expect(wraith.traits).toContain("poisonous");
    expect(ogre.char).toBe("O");
    expect(ogre.hp).toBeGreaterThan(30);
  });
});

describe("exploration juice", () => {
  it("mentions atmosphere on new game", () => {
    const g = newGame(7);
    expect(g.messages.some((m) => /damp stone|Welcome to GrokHack/i.test(m))).toBe(true);
  });

  it("includes bat/snake in early bestiary", () => {
    const bat = createMonster("bat", 0, 0, 1);
    const snake = createMonster("snake", 0, 0, 3);
    expect(bat.char).toBe("B");
    expect(snake.char).toBe("S");
  });

  it("new games start with empty status list", () => {
    const g = newGame(99);
    expect(g.player.statuses).toEqual([]);
    expect(g.player.equippedRing).toBeNull();
  });
});

describe("cycle1 early curve + XP", () => {
  it("starts with STARTER_XP_TO_LEVEL and levels after ~3 rat-class kills", () => {
    const g = newGame(99);
    expect(g.player.level).toBe(1);
    expect(g.player.xpToLevel).toBe(STARTER_XP_TO_LEVEL);
    let sawLevel = false;
    for (let i = 0; i < 5; i++) {
      const msgs = applyXpGain(g.player, 5); // rat-class XP
      if (msgs.some((m) => /ascend to level/i.test(m))) sawLevel = true;
    }
    expect(g.player.level).toBeGreaterThanOrEqual(2);
    expect(sawLevel).toBe(true);
  });

  it("orc at d4 non-crit is soft-capped vs geared starter (not free one-shot)", () => {
    const entity = createPlayer(0, 0);
    const inv = createStarterItems();
    const p: PlayerState = {
      entity,
      level: 1,
      xp: 0,
      xpToLevel: STARTER_XP_TO_LEVEL,
      hunger: 800,
      maxHunger: 1000,
      hungerState: "normal",
      inventory: [],
      equippedWeapon: inv.find((i) => i.type === "weapon") ?? null,
      equippedArmor: inv.find((i) => i.type === "armor") ?? null,
      equippedRing: null,
      gold: 0,
      turns: 0,
      depth: 4,
      alive: true,
      statuses: [],
    };
    const orc = createMonster("orc", 1, 0, 4);
    let maxDmg = 0;
    for (let i = 0; i < 100; i++) {
      const def = effectivePlayerEntity(p);
      def.hp = def.maxHp;
      const r = meleeAttack(orc, def);
      if (r.hit && !r.critical) maxDmg = Math.max(maxDmg, r.damage);
    }
    const cap = Math.max(5, Math.floor(p.entity.maxHp * 0.4));
    expect(maxDmg).toBeLessThanOrEqual(cap);
    expect(maxDmg).toBeGreaterThan(0);
    // Still hurts — not neutered
    expect(maxDmg).toBeGreaterThanOrEqual(3);
  });
});

describe("TICKET-DP-01 shrine + throne interact", () => {
  it("shrine sacrifice with corpse yields a mechanical outcome", () => {
    const g = newGame(42);
    // Force a shrine room around the player
    const room = g.dungeon.rooms[0];
    room.special = "shrine";
    g.player.entity.x = room.x + 1;
    g.player.entity.y = room.y + 1;
    expect(roomAt(g, g.player.entity.x, g.player.entity.y)?.special).toBe("shrine");

    g.player.entity.hp = 8;
    g.player.entity.maxHp = 20;
    g.player.inventory.push(makeCorpse("goblin", "gc", { kind: "goblin" }));
    const beforeInv = g.player.inventory.length;
    const beforeTurns = g.player.turns;
    trySpecialInteract(g);
    expect(g.player.inventory.length).toBe(beforeInv - 1);
    expect(g.player.turns).toBeGreaterThan(beforeTurns);
    expect(g.messages.some((m) => /sacrifice|shrine/i.test(m))).toBe(true);
  });

  it("throne sit once per floor; second sit refused", () => {
    const g = newGame(7);
    const room = g.dungeon.rooms[0];
    room.special = "throne";
    g.player.entity.x = room.x + Math.floor(room.w / 2);
    g.player.entity.y = room.y + Math.floor(room.h / 2);
    g.player.depth = 4;
    g.monsters = [];

    trySpecialInteract(g);
    expect(g.player.throneSatDepth).toBe(4);
    expect(g.messages.some((m) => /throne|sit|gold|guardian|nothing|crown|arm/i.test(m))).toBe(
      true
    );

    const turns = g.player.turns;
    trySpecialInteract(g);
    expect(g.messages.some((m) => /already sat/i.test(m))).toBe(true);
    expect(g.player.turns).toBe(turns); // free refuse
  });
});

describe("P0 world-events wire (SP endTurn + room step)", () => {
  it("reinforces after turns when floor is thinned", () => {
    const g = newGame(777);
    // Clear almost all monsters so shouldReinforce fires
    for (const m of g.monsters) m.hp = 0;
    g.monsters = g.monsters.filter((m) => m.hp > 0).slice(0, 1);
    if (g.monsters[0]) g.monsters[0].hp = 1;
    if (g.eventState) {
      g.eventState.turnCounter = 0;
      g.eventState.lastReinforcementTurn = 0;
    }
    const before = g.monsters.filter((m) => m.hp > 0).length;
    for (let i = 0; i < 50; i++) {
      if (g.phase !== "playing") break;
      waitTurn(g);
    }
    const after = g.monsters.filter((m) => m.hp > 0).length;
    expect(after).toBeGreaterThan(before);
    expect(
      g.messages.some((m) =>
        /footsteps|howls|creatures|migration|pack|haunt|shop|ceiling|fountain|scent/i.test(m)
      )
    ).toBe(true);
  });

  it("fountain room step can heal or damage via applyRoomSpecialOnStep path", () => {
    const g = newGame(42);
    // Plant a fountain and stand on its center
    const room = g.dungeon.rooms[1] ?? g.dungeon.rooms[0];
    room.special = "fountain";
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
    // Clear path: teleport onto fountain (step effects run on tryMove landing)
    // Move adjacent then step in if needed — direct position + wait won't fire step.
    // Use tryMove from adjacent tile.
    g.monsters = []; // clear so we don't bump combat
    const adj = { x: cx - 1, y: cy };
    if (!isWalkable(g.dungeon.tiles, adj.x, adj.y)) {
      adj.x = cx + 1;
    }
    if (!isWalkable(g.dungeon.tiles, adj.x, adj.y)) {
      adj.x = cx;
      adj.y = cy - 1;
    }
    g.player.entity.x = adj.x;
    g.player.entity.y = adj.y;
    g.player.entity.hp = 15;
    g.player.entity.maxHp = 20;
    const hp0 = g.player.entity.hp;
    const gold0 = g.player.gold;
    tryMove(g, { dx: cx - adj.x, dy: cy - adj.y });
    // Mechanical effect: heal, damage, message, or gold from specials
    const changed =
      g.player.entity.hp !== hp0 ||
      g.player.gold !== gold0 ||
      g.messages.some((m) => /fountain|water|drink|throne|grave|barracks|zoo|vault/i.test(m));
    expect(changed).toBe(true);
  });
});

/** Force solo client onto a given depth with stairs underfoot (abyss tests). */
function placeOnFloor(depth: number, seed = 42) {
  const g = newGame(seed);
  const rng = new RNG(seed + depth * 7919);
  const dungeon = generateDungeon(rng, depth);
  g.dungeon = dungeon;
  g.player.depth = depth;
  g.player.entity.x = dungeon.stairsDown.x;
  g.player.entity.y = dungeon.stairsDown.y;
  g.monsters = [];
  g.items = [];
  g.phase = "playing";
  return g;
}

describe("abyss depths (post-dragon)", () => {
  it("spawn tables for 11–15 include dragons and exclude early trash", () => {
    for (const d of [11, 12, 13, 14, 15]) {
      const kinds = monstersForDepth(d);
      expect(kinds).toContain("dragon");
      expect(kinds).toContain("wraith");
      expect(kinds).not.toContain("rat");
      expect(kinds).not.toContain("kobold");
      // Weighted pick never returns early-game only kinds
      expect(pickMonsterKind(d, 0)).not.toBe("rat");
    }
  });

  it("abyss tables are dragon-heavier than lair (d10)", () => {
    // Sample fixed rolls across the unit interval; count dragon picks
    const sample = (depth: number) => {
      let dragons = 0;
      for (let i = 0; i < 100; i++) {
        if (pickMonsterKind(depth, i / 100) === "dragon") dragons++;
      }
      return dragons;
    };
    expect(sample(15)).toBeGreaterThan(sample(10));
    expect(sample(12)).toBeGreaterThanOrEqual(sample(10));
  });

  it("abyss denser and hungrier than lair", () => {
    const lair = monsterCountRange(10);
    const abyss = monsterCountRange(13);
    expect(abyss.min).toBeGreaterThan(lair.min);
    expect(abyss.max).toBeGreaterThan(lair.max);
    expect(hungerPerTurn(12)).toBeGreaterThan(hungerPerTurn(10));
    expect(hungerPerTurn(15)).toBeGreaterThan(hungerPerTurn(12));
  });

  it("depthFlavor has distinct lines for 11–15", () => {
    const lines = [11, 12, 13, 14, 15].map((d) => depthFlavor(d));
    expect(new Set(lines).size).toBe(5);
    expect(lines[0]).toMatch(/abyss/i);
    expect(lines[4]).toMatch(/true ending|abyss/i);
  });

  it("blocks descent from d10 while dragon lives", () => {
    const g = placeOnFloor(10);
    g.monsters = [createBossDragon(g.player.entity.x + 2, g.player.entity.y, 10)];
    // ensure dragon not on stairs
    if (
      g.monsters[0].x === g.dungeon.stairsDown.x &&
      g.monsters[0].y === g.dungeon.stairsDown.y
    ) {
      g.monsters[0].x = g.dungeon.stairsUp.x;
      g.monsters[0].y = g.dungeon.stairsUp.y;
    }
    tryDescend(g);
    expect(g.player.depth).toBe(10);
    expect(g.phase).toBe("playing");
    expect(g.messages.some((m) => /dragon blocks/i.test(m))).toBe(true);
  });

  it("descends past 10 into abyss after dragon is dead", () => {
    const g = placeOnFloor(10);
    g.monsters = []; // dragon slain
    tryDescend(g);
    expect(g.player.depth).toBe(11);
    expect(g.phase).toBe("playing");
    expect(g.messages.some((m) => /abyss|Depth 11|descend to depth 11/i.test(m))).toBe(true);
  });

  it("does not win at d10 after dragon kill (true ending is d15)", () => {
    const g = placeOnFloor(10);
    g.monsters = [];
    tryDescend(g);
    expect(g.phase).not.toBe("won");
    expect(g.player.depth).toBe(11);
  });

  it("wins only at abyss end (d15 stairs)", () => {
    const g = placeOnFloor(15);
    g.monsters = [];
    tryDescend(g);
    expect(g.phase).toBe("won");
    expect(g.messages.some((m) => /true ending|conquered the abyss/i.test(m))).toBe(true);
  });

  it("can chain descend through abyss floors 11→14", () => {
    let g = placeOnFloor(11);
    for (const next of [12, 13, 14, 15]) {
      g.player.entity.x = g.dungeon.stairsDown.x;
      g.player.entity.y = g.dungeon.stairsDown.y;
      g.monsters = [];
      tryDescend(g);
      expect(g.phase).toBe("playing");
      expect(g.player.depth).toBe(next);
    }
  });
});