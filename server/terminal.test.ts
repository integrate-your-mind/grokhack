import { describe, it, expect } from "vitest";
import {
  ANSI,
  smartTruncate,
  colorizeLogLine,
  formatLogMessage,
  renderStatus,
  renderDeath,
  renderVictory,
  renderHelp,
  renderInventoryPanel,
  renderTerminalView,
  visibleLength,
} from "./terminal.js";
import type { OnlinePlayer } from "./types.js";
import type { FloorState } from "./types.js";
import type { PlayerState, Entity, Item } from "../src/types.js";

function makeEntity(over: Partial<Entity> = {}): Entity {
  return {
    id: "p1",
    name: "Hero",
    char: "@",
    x: 5,
    y: 5,
    hp: 12,
    maxHp: 20,
    attack: 3,
    defense: 1,
    xp: 0,
    isPlayer: true,
    color: "#c9a227",
    ...over,
  };
}

function makePlayerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    entity: makeEntity(),
    level: 3,
    xp: 40,
    xpToLevel: 80,
    hunger: 500,
    maxHunger: 1000,
    hungerState: "hungry",
    inventory: [],
    equippedWeapon: null,
    equippedArmor: null,
    equippedRing: null,
    gold: 42,
    turns: 100,
    depth: 4,
    alive: true,
    statuses: [],
    ...over,
  };
}

function makeOnline(over: Partial<OnlinePlayer> = {}): OnlinePlayer {
  return {
    id: "id1",
    name: "Ada",
    glyph: "@",
    kind: "human",
    state: makePlayerState(),
    explored: Array.from({ length: 12 }, () => Array(20).fill(true)),
    messages: ["You hit the rat.", "[chat] Bob: hi"],
    phase: "playing",
    floorDepth: 4,
    connected: true,
    lastActive: Date.now(),
    scoreRecorded: false,
    ...over,
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function tinyFloor(): FloorState {
  const w = 20;
  const h = 12;
  const tiles = Array.from({ length: h }, () => Array(w).fill("."));
  for (let x = 0; x < w; x++) {
    tiles[0][x] = "#";
    tiles[h - 1][x] = "#";
  }
  for (let y = 0; y < h; y++) {
    tiles[y][0] = "#";
    tiles[y][w - 1] = "#";
  }
  tiles[6][6] = ">";
  return {
    depth: 4,
    dungeon: {
      width: w,
      height: h,
      tiles: tiles as FloorState["dungeon"]["tiles"],
      rooms: [{ x: 2, y: 2, w: 10, h: 6 }],
      stairsDown: { x: 6, y: 6 },
      stairsUp: { x: 3, y: 3 },
    },
    monsters: [],
    items: [],
    seed: 1,
  };
}

describe("smartTruncate", () => {
  it("leaves short strings alone", () => {
    expect(smartTruncate("hello", 20)).toBe("hello");
  });

  it("breaks at a word when possible", () => {
    const out = smartTruncate("You hit the giant rat for 4 damage", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
    // Should not mid-cut a word when a space exists in the latter half of the budget.
    expect(out).toBe("You hit the giant…");
  });

  it("hard-cuts when no good space", () => {
    const out = smartTruncate("abcdefghijklmnopqrstuvwxyz", 10);
    expect(out).toBe("abcdefghi…");
  });
});

describe("colorizeLogLine / formatLogMessage", () => {
  it("colors combat and chat distinctly", () => {
    const hit = colorizeLogLine("You hit the goblin.");
    const chat = colorizeLogLine("[chat] Ada: hello");
    const dmg = colorizeLogLine("Hunger deals 2 damage.");
    expect(hit).toContain(ANSI.yellow);
    expect(chat).toContain(ANSI.cyan);
    expect(dmg).toContain(ANSI.red);
    expect(hit).toContain(ANSI.reset);
  });

  it("expands multi-line messages and truncates", () => {
    const lines = formatLogMessage("line one\nline two is very long " + "x".repeat(100), 40);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0].startsWith("> ")).toBe(true);
    expect(visibleLength(lines[1])).toBeLessThanOrEqual(42); // "> " + 40
  });
});

describe("renderStatus", () => {
  it("includes HP hunger depth level gold", () => {
    const s = renderStatus(makePlayerState(), 7);
    const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/HP/);
    expect(plain).toMatch(/Hunger/);
    expect(plain).toMatch(/hungry/);
    expect(plain).toMatch(/Dlvl7|Dlvl.*7/);
    expect(plain).toMatch(/Lv3|Lv.*3/);
    expect(plain).toMatch(/Au.*42|42/);
  });
});

describe("renderDeath / renderVictory", () => {
  it("shows deathCause when present", () => {
    const p = makeOnline({
      state: makePlayerState({ deathCause: "Slain by a dragon", alive: false }),
      floorDepth: 10,
    });
    const out = renderDeath(p);
    expect(out).toContain("YOU DIED");
    expect(out).toContain("Slain by a dragon");
    expect(out).toContain("Ada");
    expect(out).toMatch(/depth.*10|10/);
  });

  it("omits blank cause cleanly", () => {
    const p = makeOnline({ state: makePlayerState({ deathCause: undefined }) });
    const out = renderDeath(p);
    expect(out).toContain("YOU DIED");
    expect(out).not.toContain("undefined");
  });

  it("renders victory with stats", () => {
    const out = renderVictory(makeOnline({ floorDepth: 10 }));
    expect(out).toContain("VICTORY");
    expect(out).toContain("Ada");
    expect(out).toContain("conquered");
  });
});

describe("renderHelp", () => {
  it("lists keys and social commands", () => {
    const h = renderHelp();
    expect(h).toMatch(/hjkl/i);
    expect(h).toContain(":say");
    expect(h).toContain(":dm");
    expect(h).toContain(":friend");
    expect(h).toContain(":who");
    expect(h).toContain(":help");
  });
});

describe("renderInventoryPanel", () => {
  it("uses readable item names and equip tags", () => {
    const weapon: Item = {
      id: "w1",
      name: "dagger",
      char: ")",
      type: "weapon",
      power: 2,
      identified: true,
    };
    const potion: Item = {
      id: "p1",
      name: "potion",
      char: "!",
      type: "potion",
      power: 0,
      appearance: "ruby",
      identified: false,
    };
    const state = makePlayerState({
      inventory: [weapon, potion],
      equippedWeapon: weapon,
    });
    const plain = stripAnsi(renderInventoryPanel(state).join("\n"));
    expect(plain).toMatch(/dagger/);
    expect(plain).toMatch(/wielded/);
    expect(plain).toMatch(/ruby potion/);
    expect(plain).toMatch(/1\./);
  });
});

describe("renderTerminalView", () => {
  it("draws status, help hint, and colored log", () => {
    const plain = stripAnsi(renderTerminalView(makeOnline(), tinyFloor(), []));
    expect(plain).toContain("GrokHack");
    expect(plain).toMatch(/HP/);
    expect(plain).toMatch(/Dlvl|Hunger/);
    expect(plain).toMatch(/\?:help|:help/);
    expect(plain).toContain("You hit the rat.");
  });

  it("shows pack panel in inventory phase", () => {
    const food: Item = {
      id: "f1",
      name: "food ration",
      char: "%",
      type: "food",
      power: 300,
      identified: true,
    };
    const p = makeOnline({
      phase: "inventory",
      state: makePlayerState({ inventory: [food] }),
    });
    const plain = stripAnsi(renderTerminalView(p, tinyFloor(), []));
    expect(plain).toMatch(/Pack/);
    expect(plain).toMatch(/food ration/);
  });
});
