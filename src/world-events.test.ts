/**
 * world-events: reinforcements, environmental events, encounter room specials.
 */
import { describe, it, expect } from "vitest";
import { generateDungeon } from "./dungeon";
import { createPlayer } from "./entities";
import { RNG } from "./rng";
import {
  WORLD_EVENT_SEED_SALT,
  assignEncounterSpecials,
  createFloorEventState,
  densPackSize,
  ensureFloorEventState,
  envEventCooldown,
  pickDenMonsterKind,
  planDenPackSpawns,
  planReinforcement,
  applyReinforcementPlan,
  reinforcementCap,
  reinforcementInterval,
  rollEnvironmentalEvent,
  shouldReinforce,
  applyRoomSpecialOnStep,
  applyPlayerEventEffects,
  roomAt,
  spawnFromSpecs,
  ambientInterval,
  eventRng,
  floorEnterAmbient,
  discoverSpecialRoomsInFov,
  detectPackSpotted,
  rollTimedAmbient,
  applyAmbientEffects,
  tickWorldEventsCore,
} from "./world-events";
import type { Entity, PlayerState, Room } from "./types";

function makePlayer(x = 5, y = 5): PlayerState {
  const entity = createPlayer(x, y);
  return {
    entity,
    level: 1,
    xp: 0,
    xpToLevel: 20,
    hunger: 800,
    maxHunger: 1000,
    hungerState: "normal",
    inventory: [],
    equippedWeapon: null,
    equippedArmor: null,
    equippedRing: null,
    gold: 10,
    turns: 0,
    depth: 5,
    alive: true,
    statuses: [],
  };
}

describe("reinforcement schedule", () => {
  it("exports a stable event seed salt", () => {
    expect(WORLD_EVENT_SEED_SALT).toBe(0x3e3e_7e11);
  });

  it("intervals shrink when the floor is nearly cleared", () => {
    const full = reinforcementInterval(5, 12);
    const thin = reinforcementInterval(5, 1);
    expect(thin).toBeLessThan(full);
    expect(thin).toBeGreaterThanOrEqual(6);
  });

  it("cap rises with multiplayer presence", () => {
    expect(reinforcementCap(5, 3)).toBeGreaterThan(reinforcementCap(5, 1));
  });

  it("shouldReinforce gates on interval and cap", () => {
    const ev = createFloorEventState();
    ev.turnCounter = 5;
    ev.lastReinforcementTurn = 0;
    expect(
      shouldReinforce({
        depth: 5,
        aliveMonsters: 20,
        playersOnFloor: 1,
        eventState: ev,
      })
    ).toBe(false); // too soon / full

    ev.turnCounter = 100;
    expect(
      shouldReinforce({
        depth: 5,
        aliveMonsters: 2,
        playersOnFloor: 1,
        eventState: ev,
      })
    ).toBe(true);

    expect(
      shouldReinforce({
        depth: 5,
        aliveMonsters: 2,
        playersOnFloor: 0,
        eventState: ev,
        requirePlayers: true,
      })
    ).toBe(false);
  });

  it("planReinforcement spawns 1–3 monsters with a message", () => {
    const rng = new RNG(42);
    const dungeon = generateDungeon(rng, 6);
    const occupied = new Set<string>();
    occupied.add(`${dungeon.stairsUp.x},${dungeon.stairsUp.y}`);
    const plan = planReinforcement(
      dungeon,
      6,
      1,
      2,
      occupied,
      [{ x: dungeon.stairsUp.x, y: dungeon.stairsUp.y }],
      new RNG(99)
    );
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.positions.length).toBeGreaterThanOrEqual(1);
    expect(plan.positions.length).toBeLessThanOrEqual(3);
    expect(plan.message.length).toBeGreaterThan(10);
    const entities = applyReinforcementPlan(plan, 6);
    expect(entities.length).toBe(plan.positions.length);
    expect(entities.every((e) => e.hp > 0)).toBe(true);
  });

  it("turn-pump with thinned floor raises living count via public API", () => {
    const dungeon = generateDungeon(new RNG(2026), 5);
    const playerPos = { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y };
    const occupied = new Set<string>([`${playerPos.x},${playerPos.y}`]);
    const ev = createFloorEventState();
    let alive = 1; // thinned floor
    let spawned = 0;

    for (let t = 0; t < 48; t++) {
      ev.turnCounter += 1;
      if (
        !shouldReinforce({
          depth: 5,
          aliveMonsters: alive,
          playersOnFloor: 2,
          eventState: ev,
          requirePlayers: true,
        })
      ) {
        continue;
      }
      const plan = planReinforcement(
        dungeon,
        5,
        alive,
        2,
        occupied,
        [playerPos],
        new RNG(7000 + t)
      );
      if (!plan) continue;
      const ents = applyReinforcementPlan(plan, 5);
      spawned += ents.length;
      alive += ents.length;
      for (const e of ents) occupied.add(`${e.x},${e.y}`);
      ev.lastReinforcementTurn = ev.turnCounter;
    }

    expect(spawned).toBeGreaterThan(0);
    expect(alive).toBeGreaterThan(1);
    expect(ev.lastReinforcementTurn).toBeGreaterThan(0);
  });
});

describe("environmental events", () => {
  it("respects env cooldown — d1–5 faster than deep", () => {
    expect(envEventCooldown(2)).toBeLessThan(envEventCooldown(12));
    expect(envEventCooldown(5)).toBeLessThanOrEqual(envEventCooldown(8));
    expect(envEventCooldown(1)).toBeLessThanOrEqual(16);
  });

  it("fires mechanical events after cooldown (damage or spawns or gold)", () => {
    const dungeon = generateDungeon(new RNG(7), 8);
    // Force graveyard for haunt path
    const room = dungeon.rooms[1];
    if (room) room.special = "graveyard";

    let hits = 0;
    for (let seed = 0; seed < 80; seed++) {
      const ev = createFloorEventState();
      ev.turnCounter = 200;
      ev.lastEnvEventTurn = 0;
      const occupied = new Set<string>();
      occupied.add(`${dungeon.stairsUp.x},${dungeon.stairsUp.y}`);
      const result = rollEnvironmentalEvent({
        depth: 8,
        dungeon,
        eventState: ev,
        occupied,
        playerPos: { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y },
        rng: new RNG(seed * 997 + 13),
        hasGraveyard: true,
      });
      if (!result) continue;
      hits++;
      const hasTeeth =
        (result.damageToPlayer ?? 0) > 0 ||
        (result.spawns?.length ?? 0) > 0 ||
        (result.goldDelta ?? 0) > 0 ||
        (result.hungerDrain ?? 0) > 0;
      expect(hasTeeth || result.messages.length > 0).toBe(true);
      expect([
        "cave_in",
        "pack_migration",
        "graveyard_haunt",
        "shopkeeper_call",
        "gas_pocket",
        "corridor_ambush",
      ]).toContain(result.kind);
    }
    expect(hits).toBeGreaterThan(5);
  });

  it("applyPlayerEventEffects heals, damages, and can kill", () => {
    const p = makePlayer();
    p.entity.hp = 10;
    p.entity.maxHp = 20;
    applyPlayerEventEffects(p, { heal: 5 });
    expect(p.entity.hp).toBe(15);
    applyPlayerEventEffects(p, { damage: 3, goldDelta: 4 });
    expect(p.entity.hp).toBe(12);
    expect(p.gold).toBe(14);
    p.entity.hp = 2;
    const death = applyPlayerEventEffects(p, { damage: 5 });
    expect(p.alive).toBe(false);
    expect(death).toMatch(/succumb/i);
  });
});

describe("encounter room specials", () => {
  it("assignEncounterSpecials places fountain/graveyard/throne on mid depths", () => {
    let fountain = 0;
    let graveyard = 0;
    let throne = 0;
    for (let seed = 0; seed < 60; seed++) {
      const rooms: Room[] = [];
      for (let i = 0; i < 8; i++) {
        rooms.push({ x: i * 5, y: 2, w: 4, h: 4, special: null });
      }
      assignEncounterSpecials(rooms, 8, new RNG(seed * 31 + 3));
      if (rooms.some((r) => r.special === "fountain")) fountain++;
      if (rooms.some((r) => r.special === "graveyard")) graveyard++;
      if (rooms.some((r) => r.special === "throne")) throne++;
    }
    expect(fountain + graveyard + throne).toBeGreaterThan(10);
    expect(fountain).toBeGreaterThan(0);
    expect(graveyard).toBeGreaterThan(0);
  });

  it("generateDungeon yields new encounter specials over many seeds", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 80; seed++) {
      const d = generateDungeon(new RNG(seed * 17 + 5), 8);
      for (const r of d.rooms) {
        if (r.special === "fountain" || r.special === "graveyard" || r.special === "throne") {
          seen.add(r.special);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("pickDenMonsterKind is themed", () => {
    const rng = new RNG(1);
    const zoo = new Set(
      Array.from({ length: 20 }, () => pickDenMonsterKind("zoo", 5, rng))
    );
    expect([...zoo].every((k) => ["rat", "bat", "snake", "kobold"].includes(k))).toBe(true);

    const grave = pickDenMonsterKind("graveyard", 7, new RNG(2));
    expect(["skeleton", "wraith", "bat"].includes(grave)).toBe(true);
  });

  it("densPackSize is positive for dens", () => {
    const rng = new RNG(3);
    expect(densPackSize("zoo", 5, rng)).toBeGreaterThanOrEqual(5);
    expect(densPackSize("barracks", 5, rng)).toBeGreaterThanOrEqual(4);
    expect(densPackSize("graveyard", 6, rng)).toBeGreaterThanOrEqual(3);
    expect(densPackSize("throne", 7, rng)).toBeGreaterThanOrEqual(2);
  });

  it("densPackSize: stronger zoo/barracks + undead graveyard packs", () => {
    // 3-arg depth-aware form (world-events dens handoff)
    const zoo = densPackSize("zoo", 4, new RNG(1));
    expect(zoo).toBeGreaterThanOrEqual(7);
    expect(zoo).toBeLessThanOrEqual(12);
    const barracks = densPackSize("barracks", 4, new RNG(2));
    expect(barracks).toBeGreaterThanOrEqual(5);
    expect(barracks).toBeLessThanOrEqual(9);
    const grave = densPackSize("graveyard", 5, new RNG(3));
    expect(grave).toBeGreaterThanOrEqual(5);
    expect(grave).toBeLessThanOrEqual(9);
    // Legacy 2-arg form still works
    expect(densPackSize("zoo", new RNG(9))).toBeGreaterThanOrEqual(7);
  });

  it("planDenPackSpawns fills dens with themed kinds", () => {
    const d = generateDungeon(new RNG(12345), 8);
    // Force dens
    if (d.rooms[1]) d.rooms[1].special = "zoo";
    if (d.rooms[2]) d.rooms[2].special = "graveyard";
    const occupied = new Set<string>();
    occupied.add(`${d.stairsUp.x},${d.stairsUp.y}`);
    const packs = planDenPackSpawns(d, 8, occupied, new RNG(55));
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.every((p) => p.monsterKind)).toBe(true);
    const ents = spawnFromSpecs(packs, 8);
    expect(ents.length).toBe(packs.length);
  });

  it("fountain center has heal-or-harm teeth", () => {
    const dungeon = generateDungeon(new RNG(9), 4);
    const room = dungeon.rooms[1] ?? dungeon.rooms[0];
    room.special = "fountain";
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);
    const player = makePlayer(cx, cy);
    player.entity.x = cx;
    player.entity.y = cy;
    player.entity.hp = 20;
    player.entity.maxHp = 20;

    let healed = 0;
    let harmed = 0;
    for (let seed = 0; seed < 40; seed++) {
      const p = makePlayer(cx, cy);
      p.entity.hp = 15;
      p.entity.maxHp = 20;
      const ev = createFloorEventState();
      const fx = applyRoomSpecialOnStep({
        dungeon: { ...dungeon, rooms: dungeon.rooms.map((r) => ({ ...r })) },
        x: cx,
        y: cy,
        depth: 4,
        eventState: ev,
        occupied: new Set(),
        rng: new RNG(seed * 41 + 7),
        player: p,
      });
      if (!fx) continue;
      if ((fx.heal ?? 0) > 0) healed++;
      if ((fx.damage ?? 0) > 0) harmed++;
    }
    expect(healed + harmed).toBeGreaterThan(10);
    expect(healed).toBeGreaterThan(0);
    expect(harmed).toBeGreaterThan(0);
  });

  it("graveyard first entry can chill and/or spawn undead", () => {
    const dungeon = generateDungeon(new RNG(11), 6);
    const room = dungeon.rooms[1] ?? dungeon.rooms[0];
    room.special = "graveyard";
    const x = room.x + 1;
    const y = room.y + 1;
    let chill = 0;
    let spawns = 0;
    for (let seed = 0; seed < 50; seed++) {
      const p = makePlayer(x, y);
      const ev = createFloorEventState();
      const fx = applyRoomSpecialOnStep({
        dungeon,
        x,
        y,
        depth: 6,
        eventState: ev,
        occupied: new Set(),
        rng: new RNG(seed * 13 + 3),
        player: p,
      });
      if (!fx) continue;
      if ((fx.damage ?? 0) > 0) chill++;
      if (fx.spawns?.length) spawns++;
    }
    expect(chill).toBeGreaterThan(0);
    // spawn is probabilistic — allow zero on unlucky runs but chill is required
    expect(chill + spawns).toBeGreaterThan(5);
  });

  it("throne first entry grants gold or guardian", () => {
    const dungeon = generateDungeon(new RNG(19), 7);
    const room = dungeon.rooms[1] ?? dungeon.rooms[0];
    room.special = "throne";
    const x = room.x + 1;
    const y = room.y + 1;
    let gold = 0;
    let guard = 0;
    for (let seed = 0; seed < 40; seed++) {
      const p = makePlayer(x, y);
      const ev = createFloorEventState();
      const fx = applyRoomSpecialOnStep({
        dungeon,
        x,
        y,
        depth: 7,
        eventState: ev,
        occupied: new Set(),
        rng: new RNG(seed * 29 + 11),
        player: p,
      });
      if (!fx) continue;
      if ((fx.goldDelta ?? 0) > 0) gold++;
      if (fx.spawns?.length) guard++;
    }
    expect(gold + guard).toBeGreaterThan(5);
  });

  it("roomAt finds special rooms", () => {
    const dungeon = generateDungeon(new RNG(2), 5);
    const r = dungeon.rooms[0];
    expect(roomAt(dungeon, r.x + 1, r.y + 1)).toBeTruthy();
  });

  it("ensureFloorEventState rebuilds missing state", () => {
    const a = ensureFloorEventState(null);
    expect(a.turnCounter).toBe(0);
    a.turnCounter = 9;
    expect(ensureFloorEventState(a).turnCounter).toBe(9);
  });
});

describe("ambient variety", () => {
  it("eventRng is deterministic for seed+depth+turn", () => {
    const a = eventRng(12345, 3, 10, 1).next();
    const b = eventRng(12345, 3, 10, 1).next();
    const c = eventRng(12345, 3, 11, 1).next();
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("ambientInterval is shorter on early depths", () => {
    expect(ambientInterval(1)).toBeLessThan(ambientInterval(12));
    expect(ambientInterval(2)).toBeLessThanOrEqual(ambientInterval(5));
  });

  it("floorEnterAmbient fires once with messages", () => {
    const d = generateDungeon(new RNG(42), 3);
    const ev = createFloorEventState();
    const first = floorEnterAmbient(3, d, ev, eventRng(1, 3, 0, 1));
    expect(first).not.toBeNull();
    expect(first!.messages.length).toBeGreaterThan(0);
    const second = floorEnterAmbient(3, d, ev, eventRng(1, 3, 0, 1));
    expect(second).toBeNull();
  });

  it("discoverSpecialRoomsInFov announces vault/shrine once", () => {
    const d = generateDungeon(new RNG(99), 6);
    const room = d.rooms[1] ?? d.rooms[0];
    room.special = "vault";
    const key = `${room.x + 1},${room.y + 1}`;
    const ev = createFloorEventState();
    const a = discoverSpecialRoomsInFov({
      dungeon: d,
      visibleKeys: [key],
      eventState: ev,
      depth: 6,
      rng: eventRng(9, 6, 1, 1),
    });
    expect(a).not.toBeNull();
    expect(a!.messages.join(" ")).toMatch(/vault/i);
    const b = discoverSpecialRoomsInFov({
      dungeon: d,
      visibleKeys: [key],
      eventState: ev,
      depth: 6,
      rng: eventRng(9, 6, 2, 1),
    });
    expect(b).toBeNull();
  });

  it("detectPackSpotted requires 3+ pack monsters in FOV", () => {
    const ev = createFloorEventState();
    const monsters = [
      { x: 1, y: 1, hp: 5, kind: "rat", traits: ["pack"] },
      { x: 2, y: 1, hp: 5, kind: "rat", traits: ["pack"] },
      { x: 3, y: 1, hp: 5, kind: "kobold", traits: ["pack"] },
    ] as unknown as Entity[];
    const vis = new Set(["1,1", "2,1", "3,1"]);
    const hit = detectPackSpotted({
      monsters,
      visibleKeys: vis,
      eventState: ev,
      rng: eventRng(1, 2, 5, 1),
    });
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("pack_spotted");
    // second time same cluster suppressed
    expect(
      detectPackSpotted({
        monsters,
        visibleKeys: vis,
        eventState: ev,
        rng: eventRng(1, 2, 6, 1),
      })
    ).toBeNull();
  });

  it("rollTimedAmbient respects cooldown and can fire variety", () => {
    const d = generateDungeon(new RNG(7), 4);
    const kinds = new Set<string>();
    for (let turn = 0; turn < 200; turn++) {
      const ev = createFloorEventState();
      ev.turnCounter = turn;
      ev.lastAmbientTurn = turn - ambientInterval(4);
      const amb = rollTimedAmbient({
        depth: 4,
        dungeon: d,
        eventState: ev,
        seed: 777,
        turn,
      });
      if (amb) kinds.add(amb.kind);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  it("rollTimedAmbient does not spam within interval", () => {
    const d = generateDungeon(new RNG(8), 2);
    const ev = createFloorEventState();
    ev.turnCounter = 20;
    ev.lastAmbientTurn = 18; // within interval for d2 (7)
    const amb = rollTimedAmbient({
      depth: 2,
      dungeon: d,
      eventState: ev,
      seed: 3,
      turn: 20,
    });
    expect(amb).toBeNull();
  });

  it("applyAmbientEffects alerts packs and drains hunger", () => {
    const p = makePlayer();
    p.hunger = 100;
    const m = {
      hp: 5,
      kind: "goblin",
      traits: ["pack"],
      ai: "wander",
    } as unknown as Entity;
    applyAmbientEffects(
      { kind: "stampede", messages: ["x"], alertPacks: true, hungerDrain: 12 },
      p,
      [m]
    );
    expect(p.hunger).toBe(88);
    expect(m.ai).toBe("hunt");
  });
});

describe("P0 wire acceptance — reinforce + fountain", () => {
  it("cleared sparse floor: shouldReinforce + planReinforcement yields 1–3 hostiles", () => {
    const dungeon = generateDungeon(new RNG(2026), 5);
    const ev = createFloorEventState();
    // Simulate many turns elapsed so interval is satisfied
    ev.turnCounter = 100;
    ev.lastReinforcementTurn = 0;
    const alive = 1; // sparse
    expect(
      shouldReinforce({
        depth: 5,
        aliveMonsters: alive,
        playersOnFloor: 2,
        eventState: ev,
        requirePlayers: true,
      })
    ).toBe(true);

    const occupied = new Set<string>([
      `${dungeon.stairsUp.x},${dungeon.stairsUp.y}`,
    ]);
    const plan = planReinforcement(
      dungeon,
      5,
      alive,
      2,
      occupied,
      [{ x: dungeon.stairsUp.x, y: dungeon.stairsUp.y }],
      new RNG(4242)
    );
    expect(plan).not.toBeNull();
    expect(plan!.positions.length).toBeGreaterThanOrEqual(1);
    expect(plan!.positions.length).toBeLessThanOrEqual(3);
    const ents = applyReinforcementPlan(plan!, 5);
    expect(ents.length).toBe(plan!.positions.length);
    expect(ents.every((e) => e.hp > 0)).toBe(true);
    expect(plan!.message.length).toBeGreaterThan(5);
  });

  it("fountain center step has heal-or-harm mechanical teeth", () => {
    const dungeon = generateDungeon(new RNG(88), 4);
    const room = dungeon.rooms[1] ?? dungeon.rooms[0];
    room.special = "fountain";
    const cx = room.x + Math.floor(room.w / 2);
    const cy = room.y + Math.floor(room.h / 2);

    let heal = 0;
    let harm = 0;
    for (let seed = 0; seed < 50; seed++) {
      const p = makePlayer(cx, cy);
      p.entity.hp = 12;
      p.entity.maxHp = 20;
      const fx = applyRoomSpecialOnStep({
        dungeon,
        x: cx,
        y: cy,
        depth: 4,
        eventState: createFloorEventState(),
        occupied: new Set(),
        rng: new RNG(seed * 97 + 11),
        player: p,
      });
      if (!fx) continue;
      if ((fx.heal ?? 0) > 0) {
        heal++;
        const before = p.entity.hp;
        applyPlayerEventEffects(p, { heal: fx.heal });
        expect(p.entity.hp).toBeGreaterThan(before);
      }
      if ((fx.damage ?? 0) > 0) {
        harm++;
        const before = p.entity.hp;
        applyPlayerEventEffects(p, { damage: fx.damage });
        expect(p.entity.hp).toBeLessThan(before);
      }
    }
    expect(heal + harm).toBeGreaterThan(15);
    expect(heal).toBeGreaterThan(0);
    expect(harm).toBeGreaterThan(0);
  });

  it("rollEnvironmentalEvent can fire pack_migration / haunt / shopkeeper", () => {
    const dungeon = generateDungeon(new RNG(55), 8);
    if (dungeon.rooms[1]) dungeon.rooms[1].special = "graveyard";
    const kinds = new Set<string>();
    for (let seed = 0; seed < 120; seed++) {
      const ev = createFloorEventState();
      ev.turnCounter = 200;
      ev.lastEnvEventTurn = 0;
      const occupied = new Set<string>([
        `${dungeon.stairsUp.x},${dungeon.stairsUp.y}`,
      ]);
      const r = rollEnvironmentalEvent({
        depth: 8,
        dungeon,
        eventState: ev,
        occupied,
        playerPos: { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y },
        rng: new RNG((seed * 2654435761) >>> 0),
        hasGraveyard: true,
      });
      if (r) kinds.add(r.kind);
    }
    // Expect at least 2 of the 3 primary env kinds over many seeds
    const primary = ["pack_migration", "graveyard_haunt", "shopkeeper_call", "cave_in"];
    const hit = primary.filter((k) => kinds.has(k));
    expect(hit.length).toBeGreaterThanOrEqual(2);
  });
});

describe("new env events with teeth (gas_pocket + corridor_ambush)", () => {
  it("gas_pocket has heal or damage+hunger", () => {
    const dungeon = generateDungeon(new RNG(1), 3);
    let teeth = 0;
    for (let seed = 0; seed < 80; seed++) {
      const ev = createFloorEventState();
      ev.turnCounter = 100;
      ev.lastEnvEventTurn = 0;
      // Force kind by many rolls until gas_pocket
      const r = rollEnvironmentalEvent({
        depth: 3,
        dungeon,
        eventState: { ...createFloorEventState(), turnCounter: 100, lastEnvEventTurn: 0 },
        occupied: new Set([`${dungeon.stairsUp.x},${dungeon.stairsUp.y}`]),
        playerPos: { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y },
        rng: new RNG((seed * 7919 + 13) >>> 0),
      });
      if (r?.kind === "gas_pocket") {
        const has =
          (r.damageToPlayer ?? 0) > 0 ||
          (r.healToPlayer ?? 0) > 0 ||
          (r.hungerDrain ?? 0) > 0;
        if (has) teeth++;
      }
    }
    expect(teeth).toBeGreaterThan(3);
  });

  it("corridor_ambush spawns hostiles or alerts packs", () => {
    const dungeon = generateDungeon(new RNG(2), 4);
    let hits = 0;
    for (let seed = 0; seed < 100; seed++) {
      const occupied = new Set([`${dungeon.stairsUp.x},${dungeon.stairsUp.y}`]);
      const r = rollEnvironmentalEvent({
        depth: 4,
        dungeon,
        eventState: { ...createFloorEventState(), turnCounter: 80, lastEnvEventTurn: 0 },
        occupied,
        playerPos: { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y },
        rng: new RNG((seed * 2654435761) >>> 0),
      });
      if (r?.kind === "corridor_ambush") {
        hits++;
        expect(
          (r.spawns?.length ?? 0) > 0 || r.alertPacks === true || r.messages.length > 0
        ).toBe(true);
      }
    }
    expect(hits).toBeGreaterThan(2);
  });

  it("tickWorldEventsCore returns reinforce/env monsters on sparse floor", () => {
    const dungeon = generateDungeon(new RNG(99), 5);
    const ev = createFloorEventState();
    ev.turnCounter = 50;
    ev.lastReinforcementTurn = 0;
    const monsters: Entity[] = [];
    // Run several ticks until something fires
    let totalSpawned = 0;
    let msgs = 0;
    for (let i = 0; i < 40; i++) {
      const r = tickWorldEventsCore({
        depth: 5,
        seed: 99,
        dungeon,
        monsters,
        playerPos: { x: dungeon.stairsUp.x, y: dungeon.stairsUp.y },
        playersOnFloor: 1,
        eventState: ev,
        hasGraveyard: false,
      });
      monsters.push(...r.newMonsters);
      totalSpawned += r.newMonsters.length;
      msgs += r.floorMessages.length;
    }
    expect(totalSpawned + msgs).toBeGreaterThan(0);
  });
});
