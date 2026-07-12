import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { WorldServer, ensureDeathCause, killerFromDeathCause } from "./world.js";
import { createMonster } from "../src/entities.js";
import { MAX_ACTIVE_MONSTERS_PER_FLOOR } from "./floor-monsters.js";
import { dataPath } from "./data-paths.js";
import type { ClientConnection } from "./types.js";

function mockConn(id: string, sessionId = "test-session"): ClientConnection {
  const msgs: string[] = [];
  return {
    id,
    transport: "telnet",
    playerId: null,
    sessionId,
    agentMode: false,
    send: (m) => msgs.push(m),
    close: () => {},
  };
}

function readAuditDeaths(sessionId: string): Array<Record<string, unknown>> {
  const day = new Date().toISOString().slice(0, 10);
  const file = dataPath("audit", `${day}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; sessionId?: string; detail?: Record<string, unknown> })
    .filter((e) => e.type === "player_death" && e.sessionId === sessionId)
    .map((e) => e.detail ?? {});
}

describe("WorldServer multiplayer", () => {
  it("does not apply a shared turn when immutable journal append fails", async () => {
    const world = new WorldServer({
      originJournal: { appendTransition: () => { throw new Error("disk unavailable"); } },
    });
    world.registerConnection(mockConn("journal-failure"));
    const player = await world.joinPlayer("journal-failure", "JournalGuard");
    if (typeof player === "string") throw new Error(player);
    const before = { turns: player.state.turns, hunger: player.state.hunger, hp: player.state.entity.hp };
    world.handleInput(player.id, ".");
    expect({ turns: player.state.turns, hunger: player.state.hunger, hp: player.state.entity.hp }).toEqual(before);
    expect(player.messages.at(-1)).toBe("Turn journal unavailable — retry shortly.");
  });

  it("allows two players to join with unique glyphs", async () => {
    const world = new WorldServer();
    const c1 = mockConn("c1");
    const c2 = mockConn("c2");
    world.registerConnection(c1);
    world.registerConnection(c2);

    const p1 = await world.joinPlayer("c1", "Alice");
    const p2 = await world.joinPlayer("c2", "Bob");

    expect(typeof p1).not.toBe("string");
    expect(typeof p2).not.toBe("string");
    if (typeof p1 === "string" || typeof p2 === "string") return;

    expect(p1.glyph).toBe("@");
    expect(p2.glyph).not.toBe(p1.glyph);
    expect(world.getOnlineCount()).toBe(2);
  });

  it("supersedes live connection on same-name rejoin (reconnect race)", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const first = await world.joinPlayer("c1", "Alice");
    if (typeof first === "string") throw new Error(first);
    first.state.turns = 11;
    // Last socket wins only with resumeToken — fixes client reconnect before old WS close arrives
    const second = await world.joinPlayer("c2", "Alice", "human", first.resumeToken);
    if (typeof second === "string") throw new Error(second);
    expect(second.id).toBe(first.id);
    expect(second.state.turns).toBe(11);
    expect(second.connected).toBe(true);
  });

  it("analytics: resume-by-name never returns Name already in use", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("bot1a"));
    const a = await world.joinPlayer("bot1a", "GrokBot1", "agent");
    if (typeof a === "string") throw new Error(a);
    a.floorDepth = 3;
    a.state.gold = 77;
    a.state.inventory = [...a.state.inventory];
    const invLen = a.state.inventory.length;

    // Soft-disconnect (grace) then rejoin — must resume with token
    world.removeConnection("bot1a", "client");
    world.registerConnection(mockConn("bot1b"));
    const mid = await world.joinPlayer("bot1b", "GrokBot1", "agent", a.resumeToken);
    expect(typeof mid).not.toBe("string");
    if (typeof mid === "string") return;
    expect(mid).not.toBe("Name already in use.");
    expect(mid.id).toBe(a.id);
    expect(mid.floorDepth).toBe(3);
    expect(mid.state.gold).toBe(77);
    expect(mid.state.inventory.length).toBe(invLen);

    // Concurrent second socket same name (GrokBot fleet collision) — supersede with token, not fail
    world.registerConnection(mockConn("bot1c"));
    const race = await world.joinPlayer("bot1c", "GrokBot1", "agent", mid.resumeToken);
    expect(race).not.toBe("Name already in use.");
    if (typeof race === "string") throw new Error(race);
    expect(race.id).toBe(a.id);
    expect(race.connected).toBe(true);
  });

  it("resumes disconnected players on reconnect", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const first = await world.joinPlayer("c1", "Returner");
    if (typeof first === "string") throw new Error(first);

    first.state.turns = 42;
    first.floorDepth = 2;
    world.removeConnection("c1");

    world.registerConnection(mockConn("c2"));
    const resumed = await world.joinPlayer("c2", "Returner", "human", first.resumeToken);
    if (typeof resumed === "string") throw new Error(resumed);

    expect(resumed.id).toBe(first.id);
    expect(resumed.state.turns).toBe(42);
    expect(resumed.floorDepth).toBe(2);
    expect(resumed.connected).toBe(true);
  });

  it("shares floor state between players on same depth", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const p1 = await world.joinPlayer("c1", "Alice");
    const p2 = await world.joinPlayer("c2", "Bob");
    if (typeof p1 === "string" || typeof p2 === "string") throw new Error("join failed");

    expect(p1.floorDepth).toBe(1);
    expect(p2.floorDepth).toBe(1);

    const view1 = world.buildView(p1);
    const view2 = world.buildView(p2);
    expect(view1.floor).toBe(view2.floor);
  });

  it("processes movement and increments turns", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Mover");
    if (typeof p === "string") throw new Error(p);

    const turns0 = p.state.turns;
    world.handleInput(p.id, "l");
    expect(p.state.turns).toBeGreaterThan(turns0);
  });

  it("reinforces thinned multiplayer floors over time (world-events)", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Pressure");
    if (typeof p === "string") throw new Error(p);

    const { floor } = world.buildView(p);
    // Thin the shared floor so reinforcement schedule can fire
    for (const m of floor.monsters) m.hp = 0;
    floor.monsters = floor.monsters.slice(0, 1);
    if (floor.monsters[0]) floor.monsters[0].hp = 1;
    // Reset event clock so interval is measurable
    floor.eventState = {
      turnCounter: 0,
      lastReinforcementTurn: 0,
      lastEnvEventTurn: 0,
      lastAmbientTurn: 0,
      enteredSpecials: [],
      discoveredSpecials: [],
      packSpotted: [],
      floorEnterDone: false,
    };

    const before = floor.monsters.filter((m) => m.hp > 0).length;
    for (let i = 0; i < 40; i++) {
      if (p.phase !== "playing" || !p.state.alive) break;
      world.handleInput(p.id, ".");
    }
    const after = floor.monsters.filter((m) => m.hp > 0).length;
    // Reinforcements or pack migration should raise living count
    expect(after).toBeGreaterThan(before);
    expect(
      p.messages.some((m) =>
        /footsteps|creatures are drawn|migrating pack|howls|shopkeeper|ceiling groans|cold wind|grave/i.test(
          m
        )
      )
    ).toBe(true);
  }, 15_000);

  it("keeps soft-disconnected players on map during grace, hides after flush", async () => {
    const world = new WorldServer();
    const c1 = mockConn("c1");
    const c2 = mockConn("c2");
    world.registerConnection(c1);
    world.registerConnection(c2);
    const p1 = await world.joinPlayer("c1", "Alice");
    const p2 = await world.joinPlayer("c2", "Bob");
    if (typeof p1 === "string" || typeof p2 === "string") throw new Error("join failed");

    expect(world.buildView(p1).others.some((o) => o.name === "Bob")).toBe(true);
    world.removeConnection("c2");
    // Grace period: still on map, not fully gone
    expect(world.buildView(p1).others.some((o) => o.name === "Bob")).toBe(true);
    expect(p2.connected).toBe(false);
    world.flushDisconnectGrace(p2.id);
    expect(world.buildView(p1).others.some((o) => o.name === "Bob")).toBe(false);
  });

  it("silent resume within grace restores same player without name collision", async () => {
    // Pin grace so parallel session-ha (sets GROKHACK_DISCONNECT_GRACE_MS=0) cannot race.
    const prevGrace = process.env.GROKHACK_DISCONNECT_GRACE_MS;
    process.env.GROKHACK_DISCONNECT_GRACE_MS = "45000";
    try {
      const world = new WorldServer();
      world.registerConnection(mockConn("c1"));
      const first = await world.joinPlayer("c1", "Blinker");
      if (typeof first === "string") throw new Error(first);
      first.state.turns = 7;
      first.floorDepth = 2;
      const msgsBefore = first.messages.length;

      world.removeConnection("c1");
      expect(first.connected).toBe(false);

      world.registerConnection(mockConn("c2"));
      const resumed = await world.joinPlayer("c2", "Blinker", "human", first.resumeToken);
      if (typeof resumed === "string") throw new Error(resumed);

      expect(resumed.id).toBe(first.id);
      expect(resumed.connected).toBe(true);
      expect(resumed.state.turns).toBe(7);
      expect(resumed.floorDepth).toBe(2);
      // Silent grace resume: no "Welcome back" (FOV/ambient may still add flavor lines)
      expect(resumed.messages.some((m) => /welcome back/i.test(m))).toBe(false);
      expect(resumed.messages.length).toBeGreaterThanOrEqual(msgsBefore);
    } finally {
      if (prevGrace === undefined) delete process.env.GROKHACK_DISCONNECT_GRACE_MS;
      else process.env.GROKHACK_DISCONNECT_GRACE_MS = prevGrace;
    }
  });

  it("stale close after reconnect does not drop the live player", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Sticky");
    if (typeof p === "string") throw new Error(p);

    world.removeConnection("c1");
    world.registerConnection(mockConn("c2"));
    const resumed = await world.joinPlayer("c2", "Sticky", "human", p.resumeToken);
    if (typeof resumed === "string") throw new Error(resumed);
    expect(resumed.connected).toBe(true);

    // Zombie close: old conn reappears with stale playerId while c2 is live
    const zombie = mockConn("c1");
    zombie.playerId = resumed.id;
    world.registerConnection(zombie);
    world.removeConnection("c1");
    expect(resumed.connected).toBe(true);
  });

  it("auto-descends when walking onto stairs", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Delver");
    if (typeof p === "string") throw new Error(p);

    const { stairsDown, tiles } = world.buildView(p).floor.dungeon;
    const attempts = [
      { x: stairsDown.x - 1, y: stairsDown.y, key: "l" },
      { x: stairsDown.x + 1, y: stairsDown.y, key: "h" },
      { x: stairsDown.x, y: stairsDown.y - 1, key: "j" },
      { x: stairsDown.x, y: stairsDown.y + 1, key: "k" },
    ];
    let moved = false;
    for (const { x, y, key } of attempts) {
      if (tiles[y]?.[x] === "#" || tiles[y]?.[x] === undefined) continue;
      p.state.entity.x = x;
      p.state.entity.y = y;
      world.handleInput(p.id, key);
      moved = true;
      break;
    }
    expect(moved).toBe(true);
    expect(p.floorDepth).toBe(2);
  });

  it("hides dead and won players from the shared floor map", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const alive = await world.joinPlayer("c1", "Alice");
    const doomed = await world.joinPlayer("c2", "Bob");
    if (typeof alive === "string" || typeof doomed === "string") throw new Error("join failed");

    doomed.phase = "dead";
    doomed.state.alive = false;
    expect(world.buildView(alive).others).toHaveLength(0);

    doomed.phase = "playing";
    doomed.state.alive = true;
    doomed.connected = true;
    expect(world.buildView(alive).others).toHaveLength(1);

    doomed.phase = "won";
    doomed.state.alive = false;
    expect(world.buildView(alive).others).toHaveLength(0);
  });

  // world-events handoff — multiplayer reinforcement pressure
  it("reinforces monsters after many turns when floor is thinned", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Clearer");
    if (typeof p === "string") throw new Error(p);

    // Survive env events (cave-in / haunt) during long waits
    p.state.entity.hp = 999;
    p.state.entity.maxHp = 999;
    p.state.hunger = 2000;

    const floor = world.buildView(p).floor;
    expect(floor.eventState).toBeDefined();

    // Thin the floor without emptying the array (spawn-ecology keys on length)
    for (const m of floor.monsters) m.hp = 0;
    const before = floor.monsters.filter((m) => m.hp > 0).length;
    expect(before).toBe(0);
    const reinBefore = floor.eventState?.lastReinforcementTurn ?? 0;

    // Interval ~6 at depth 1 when nearly cleared; wait past multiple checks
    for (let i = 0; i < 48; i++) {
      world.handleInput(p.id, ".");
      if (!p.state.alive) break;
    }

    const after = floor.monsters.filter((m) => m.hp > 0).length;
    expect(p.state.alive).toBe(true);
    expect(after).toBeGreaterThan(before);
    // Pure reinforcement clock advanced (not only pack_migration env spawns)
    expect(floor.eventState?.lastReinforcementTurn ?? 0).toBeGreaterThan(reinBefore);
    // Atmospheric reinforcement or env-event line should reach the player
    const flavor = p.messages.some((m) =>
      /footsteps|howls|creatures|migration|ceiling|rubble|haunt|chill|shop|guard|pack|beasts|scent|drawn/i.test(
        m
      )
    );
    expect(flavor).toBe(true);
  });

  it("broadcasts reinforcement atmosphere to all players on the floor", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const a = await world.joinPlayer("c1", "Alice");
    const b = await world.joinPlayer("c2", "Bob");
    if (typeof a === "string" || typeof b === "string") throw new Error("join failed");

    for (const p of [a, b]) {
      p.state.entity.hp = 999;
      p.state.entity.maxHp = 999;
      p.state.hunger = 2000;
    }

    const floor = world.buildView(a).floor;
    for (const m of floor.monsters) m.hp = 0;

    const bobBefore = b.messages.length;
    for (let i = 0; i < 48; i++) {
      world.handleInput(a.id, ".");
      if (!a.state.alive) break;
    }

    const after = floor.monsters.filter((m) => m.hp > 0).length;
    expect(after).toBeGreaterThan(0);
    // Bob receives floor-wide atmospheric messages without acting
    expect(b.messages.length).toBeGreaterThan(bobBefore);
    const bobFlavor = b.messages.some((m) =>
      /footsteps|howls|creatures|migration|ceiling|rubble|haunt|chill|shop|guard|pack|beasts|scent|drawn/i.test(
        m
      )
    );
    expect(bobFlavor).toBe(true);
  });

  it("MMO depth-1 floor is densely stocked (spawn-ecology)", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Ecologist");
    if (typeof p === "string") throw new Error(p);
    const floor = world.buildView(p).floor;
    expect(floor.monsters.length).toBeGreaterThanOrEqual(18);
    expect(floor.items.length).toBeGreaterThanOrEqual(18);
  });

  it("removes a defeated monster from shared floor state", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const player = await world.joinPlayer("c1", "Cleaner");
    if (typeof player === "string") throw new Error(player);

    const floor = world.buildView(player).floor;
    const defeated = createMonster("goblin", 1, 1, player.floorDepth);
    defeated.hp = 0;
    floor.monsters.push(defeated);

    // The combat path has already reduced hp to zero before awarding the kill.
    // Invoke that deterministic boundary directly so this regression cannot miss.
    const killMonster = (
      world as unknown as {
        killMonster: (actor: typeof player, targetFloor: typeof floor, monster: typeof defeated) => void;
      }
    ).killMonster.bind(world);
    killMonster(player, floor, defeated);

    expect(floor.monsters.some((monster) => monster.id === defeated.id)).toBe(false);
  });

  it("bounds an oversized shared floor and retains its boss", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const player = await world.joinPlayer("c1", "Bounder");
    if (typeof player === "string") throw new Error(player);

    const floor = world.buildView(player).floor;
    const boss = createMonster("dragon", 5, 5, 10);
    boss.traits = [...(boss.traits ?? []), "boss"];
    floor.monsters = [
      ...Array.from(
        { length: MAX_ACTIVE_MONSTERS_PER_FLOOR + 25 },
        (_, index) => createMonster("goblin", index, 1, player.floorDepth)
      ),
      boss,
    ];

    // A subsequent floor access applies the runtime safety boundary.
    world.registerConnection(mockConn("c2"));
    const observer = await world.joinPlayer("c2", "Observer");
    if (typeof observer === "string") throw new Error(observer);

    const bounded = world.buildView(observer).floor.monsters;
    expect(bounded).toHaveLength(MAX_ACTIVE_MONSTERS_PER_FLOOR);
    expect(bounded).toContain(boss);
  });

  it("re-seeds empty floor ecology during hydrate recovery", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Reseed");
    if (typeof p === "string") throw new Error(p);
    const floor = world.buildView(p).floor;
    // Bad DB snapshot: geometry present, ecology wiped (empty arrays = never seeded)
    floor.monsters = [];
    floor.items = [];
    const ensureFloorEcology = (
      world as unknown as {
        ensureFloorEcology: (targetFloor: typeof floor, mode: "hydrate") => void;
      }
    ).ensureFloorEcology.bind(world);
    ensureFloorEcology(floor, "hydrate");
    const restored = world.buildView(p).floor;
    expect(restored.monsters.length).toBeGreaterThan(0);
    expect(restored.items.length).toBeGreaterThan(0);
  });

  it("melee kill sets deathCause and audit detail includes deathCause + killer", async () => {
    const world = new WorldServer();
    const sid = `melee-death-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    world.registerConnection(mockConn("c-melee", sid));
    const p = await world.joinPlayer("c-melee", `MeleeVic${Date.now() % 10000}`);
    if (typeof p === "string") throw new Error(p);

    // Survive hunger / env; keep HP at 1 so any hit is lethal
    p.state.hunger = 5000;
    p.state.entity.hp = 1;
    p.state.entity.maxHp = 1;
    p.state.entity.defense = 0;
    p.state.deathCause = undefined;
    p.state.statuses = [];

    const floor = world.buildView(p).floor;
    for (const m of floor.monsters) m.hp = 0;
    // Disable traps / env thrash for this assertion
    floor.traps = [];
    if (floor.eventState) {
      floor.eventState.lastEnvEventTurn = 1e9;
      floor.eventState.lastReinforcementTurn = 1e9;
    }

    // Place a high-attack orc adjacent so monster AI melee-kills on wait.
    const mx = p.state.entity.x + 1;
    const my = p.state.entity.y;
    const orc = createMonster("orc", mx, my, p.floorDepth);
    orc.attack = 99;
    orc.defense = 0;
    orc.ai = "hunt";
    orc.hp = 50;
    orc.maxHp = 50;
    orc.traits = [];
    floor.monsters.push(orc);

    // Pollute messages like bot UI — authority path must not use these as cause.
    p.messages.push("You notice stairs leading up (<).");
    p.messages.push("  2. ? scroll labeled XIXAXA XOXAXA XUXAXA");
    p.messages.push("The goblin misses you.");

    // Miss chance ~8% even with huge attack — retry a few waits, reset HP if needed.
    for (let i = 0; i < 20 && p.state.alive; i++) {
      p.state.entity.hp = 1;
      p.state.alive = true;
      p.phase = "playing";
      // Keep orc glued adjacent (it may wander on miss turns)
      orc.x = p.state.entity.x + 1;
      orc.y = p.state.entity.y;
      orc.hp = 50;
      world.handleInput(p.id, ".");
    }

    expect(p.state.alive).toBe(false);
    expect(p.phase).toBe("dead");
    expect(p.state.deathCause).toMatch(/Slain by a orc/i);
    expect(killerFromDeathCause(p.state.deathCause)).toBe("orc");

    const deaths = readAuditDeaths(sid);
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    const detail = deaths[deaths.length - 1] as {
      deathCause?: string;
      killer?: string | null;
      turns?: number;
      gold?: number;
      level?: number;
      depth?: number;
      score?: number;
    };
    expect(detail.deathCause).toMatch(/Slain by a orc/i);
    expect(detail.killer).toBe("orc");
    expect(detail.turns).toBeDefined();
    expect(detail.gold).toBeDefined();
    expect(detail.level).toBeDefined();
    expect(detail.depth).toBeDefined();
    expect(detail.score).toBeDefined();
  });

  it("recordScore fills deathCause when authority path left it unset", async () => {
    const world = new WorldServer();
    const sid = `fallback-death-${Date.now()}`;
    world.registerConnection(mockConn("c-fb", sid));
    const p = await world.joinPlayer("c-fb", `FbDeath${Date.now() % 10000}`);
    if (typeof p === "string") throw new Error(p);

    p.state.alive = false;
    p.phase = "dead";
    p.state.deathCause = undefined;
    p.messages.push("You bump into a wall.");
    // No lethal line — ensureDeathCause uses generic epitaph
    const cause = ensureDeathCause(p);
    expect(cause.length).toBeGreaterThan(0);
    expect(p.state.deathCause).toBe(cause);

    world.recordScore(p, "died");
    const deaths = readAuditDeaths(sid);
    expect(deaths.length).toBeGreaterThanOrEqual(1);
    const d = deaths[deaths.length - 1] as { deathCause?: string | null };
    expect(d.deathCause).toBeTruthy();
  });
});
