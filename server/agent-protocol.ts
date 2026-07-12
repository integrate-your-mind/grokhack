import type { WorldServer } from "./world.js";
import type { OnlinePlayer } from "./types.js";

const DIR_KEYS = ["h", "j", "k", "l", "y", "u", "b", "n"] as const;

const DIR_VEC: Record<string, [number, number]> = {
  h: [-1, 0],
  l: [1, 0],
  k: [0, -1],
  j: [0, 1],
  y: [-1, -1],
  u: [1, -1],
  b: [-1, 1],
  n: [1, 1],
};

export interface AgentState {
  type: "agent_state";
  you: {
    name: string;
    glyph: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    depth: number;
    level: number;
    hunger: string;
    gold: number;
    turns: number;
    phase: string;
    /** Set when phase is dead — preferred bot-runs cause over last log line. */
    deathCause?: string | null;
    inventory: { char: string; name: string; type?: string; identified?: boolean }[];
  };
  floor: {
    depth: number;
    width: number;
    height: number;
    tiles: string[][];
    stairsDown: { x: number; y: number };
  };
  visible: {
    monsters: {
      x: number;
      y: number;
      char: string;
      name: string;
      hp: number;
      maxHp?: number;
      kind?: string;
      adjacent: boolean;
      threat: number;
    }[];
    items: {
      x: number;
      y: number;
      char: string;
      name?: string;
      type?: string;
      identified?: boolean;
    }[];
    players: { x: number; y: number; glyph: string; name: string }[];
  };
  messages: string[];
  online: number;
  valid_actions: string[];
  hints: string[];
  /** Compact one-liner for LLM context (optional consumers). */
  summary: string;
}

/** Relative monster danger for agent planning (1–5). */
export function monsterThreat(kind?: string, name?: string, hp = 1, maxHp = hp): number {
  const k = (kind || name || "").toLowerCase();
  if (/dragon/.test(k)) return 5;
  if (/troll|ogre|wraith/.test(k)) return 4;
  if (/orc|skeleton/.test(k)) return 3;
  if (/goblin|kobold|snake/.test(k)) return 2;
  if (/rat|bat/.test(k)) return 1;
  // Fallback from bulk
  const ratio = maxHp > 0 ? hp / maxHp : 1;
  if (maxHp >= 30) return 4;
  if (maxHp >= 16) return 3;
  if (ratio > 0.8 && maxHp >= 10) return 2;
  return 1;
}

export function buildAgentHints(input: {
  hunger: string;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  stairsDown: { x: number; y: number };
  adjacentMonsters: boolean;
  monsterCount: number;
  itemCount: number;
  hasFood: boolean;
  hasHeal: boolean;
  highThreatAdjacent: boolean;
}): string[] {
  const hints: string[] = [];
  if (input.hunger === "hungry" || input.hunger === "weak" || input.hunger === "fainting") {
    hints.push("eat_food");
  }
  if (input.hunger === "fainting") {
    hints.push("starving");
  }
  if (input.hp < input.maxHp * 0.4) {
    hints.push("low_hp");
  }
  if (input.hp < input.maxHp * 0.25) {
    hints.push("critical_hp");
  }
  if (input.x === input.stairsDown.x && input.y === input.stairsDown.y) {
    hints.push("on_stairs_descend");
  }
  if (input.adjacentMonsters) {
    hints.push("enemy_adjacent");
  }
  if (input.highThreatAdjacent) {
    hints.push("flee_or_heal");
  }
  if (input.monsterCount > 0) {
    hints.push("enemy_visible");
  }
  if (input.itemCount > 0) {
    hints.push("item_visible");
  }
  if (input.hasFood) {
    hints.push("food_in_pack");
  }
  if (input.hasHeal) {
    hints.push("heal_in_pack");
  }
  const stairDist =
    Math.abs(input.x - input.stairsDown.x) + Math.abs(input.y - input.stairsDown.y);
  if (stairDist > 0 && stairDist <= 3) {
    hints.push("stairs_nearby");
  }
  return hints;
}

export function buildAgentSummary(state: Omit<AgentState, "summary" | "type"> & { type?: string }): string {
  const you = state.you;
  const mon = state.visible.monsters;
  const items = state.visible.items;
  const adj = mon.filter((m) => m.adjacent).map((m) => m.name).join(", ");
  const parts = [
    `${you.name} d${you.depth} L${you.level}`,
    `HP ${you.hp}/${you.maxHp}`,
    you.hunger !== "normal" ? you.hunger : null,
    `gold ${you.gold}`,
    `t${you.turns}`,
    mon.length ? `${mon.length} mon` : null,
    adj ? `adj:${adj}` : null,
    items.length ? `${items.length} items` : null,
    state.hints.length ? `hints:${state.hints.slice(0, 4).join(",")}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function buildAgentState(world: WorldServer, player: OnlinePlayer): AgentState {
  const { floor, others } = world.buildView(player);
  const px = player.state.entity.x;
  const py = player.state.entity.y;
  const FOV = 8;

  const inFov = (x: number, y: number) =>
    (x - px) ** 2 + (y - py) ** 2 <= FOV * FOV;

  const monsters = floor.monsters
    .filter((m) => m.hp > 0 && inFov(m.x, m.y))
    .map((m) => {
      const maxHp = m.maxHp ?? m.hp;
      const threat = monsterThreat(m.kind, m.name, m.hp, maxHp);
      return {
        x: m.x,
        y: m.y,
        char: m.char,
        name: m.name,
        hp: m.hp,
        maxHp,
        kind: m.kind,
        adjacent: Math.abs(m.x - px) + Math.abs(m.y - py) === 1,
        threat,
      };
    });

  const items = floor.items
    .filter((i) => inFov(i.x, i.y))
    .map((i) => ({
      x: i.x,
      y: i.y,
      char: i.item.char,
      name: i.item.name,
      type: i.item.type,
      identified: i.item.identified,
    }));

  const players = others
    .filter((o) => inFov(o.state.entity.x, o.state.entity.y))
    .map((o) => ({
      x: o.state.entity.x,
      y: o.state.entity.y,
      glyph: o.glyph,
      name: o.name,
    }));

  const valid_actions: string[] = [];
  if (player.phase === "playing") {
    valid_actions.push(...DIR_KEYS, ".", ">", "i", "who", ":say", ":dm", ":friend", ":wall");
    if (monsters.some((m) => m.adjacent)) {
      for (const k of DIR_KEYS) {
        const [dx, dy] = DIR_VEC[k];
        if (monsters.some((m) => m.x === px + dx && m.y === py + dy)) {
          if (!valid_actions.includes(k)) valid_actions.push(k);
        }
      }
    }
  } else if (player.phase === "inventory") {
    valid_actions.push("i", "1", "2", "3", "4", "5", "6", "7", "8", "9");
  }

  const inv = player.state.inventory;
  const hasFood = inv.some((i) => i.type === "food");
  const hasHeal = inv.some((i) => i.type === "potion" || /heal/i.test(i.name));
  const adjacentMonsters = monsters.some((m) => m.adjacent);
  const highThreatAdjacent = monsters.some((m) => m.adjacent && m.threat >= 4);

  const hints = buildAgentHints({
    hunger: player.state.hungerState,
    hp: player.state.entity.hp,
    maxHp: player.state.entity.maxHp,
    x: px,
    y: py,
    stairsDown: floor.dungeon.stairsDown,
    adjacentMonsters,
    monsterCount: monsters.length,
    itemCount: items.length,
    hasFood,
    hasHeal,
    highThreatAdjacent,
  });

  const base = {
    type: "agent_state" as const,
    you: {
      name: player.name,
      glyph: player.glyph,
      x: px,
      y: py,
      hp: player.state.entity.hp,
      maxHp: player.state.entity.maxHp,
      depth: player.floorDepth,
      level: player.state.level,
      hunger: player.state.hungerState,
      gold: player.state.gold,
      turns: player.state.turns,
      phase: player.phase,
      deathCause: player.state.deathCause ?? null,
      inventory: player.state.inventory.map((i) => ({
        char: i.char,
        name: i.name,
        type: i.type,
        identified: i.identified,
      })),
    },
    floor: {
      depth: floor.depth,
      width: floor.dungeon.width,
      height: floor.dungeon.height,
      tiles: floor.dungeon.tiles,
      stairsDown: floor.dungeon.stairsDown,
    },
    visible: { monsters, items, players },
    messages: player.messages.slice(-8),
    online: world.getOnlineCount(),
    valid_actions,
    hints,
  };

  return {
    ...base,
    summary: buildAgentSummary(base),
  };
}

export const AGENT_DOCS = {
  name: "GrokHack",
  base: "https://grokhack.mondello.dev",
  endpoint: "wss://grokhack.mondello.dev/ws",
  local: {
    http: "http://127.0.0.1:8080",
    ws: "ws://127.0.0.1:8080/ws",
    telnet: "localhost:4000",
  },
  protocol: "json",
  join: {
    type: "join",
    name: "MyAgent",
    kind: "agent",
    resumeToken: "<64-hex from social_snapshot on first join — required to resume>",
  },
  act: { type: "input", key: "l" },
  chat: { type: "input", text: ":say hello" },
  ping: { type: "ping" },
  social: {
    friend_add: { type: "social", action: "friend_add", target: "PlayerName" },
    dm: { type: "social", action: "dm_send", target: "PlayerName", text: "meet at stairs" },
    wall: { type: "social", action: "wall_post", text: "depth 3!" },
    snapshot: { type: "social", action: "snapshot" },
  },
  quickstart: [
    "1. Connect WebSocket to endpoint (or use MCP: /api/mcp)",
    '2. Send {"type":"join","name":"MyAgent","kind":"agent"} (store resumeToken from social_snapshot; required to rejoin)',
    "3. Read agent_state (you/visible/hints/summary/valid_actions)",
    '4. Send {"type":"input","key":"l"} etc. Same ruleset as humans',
  ],
  mcp: "/api/mcp",
  machine_docs: {
    llms_txt: "/llms.txt",
    agents_md: "/agents.md",
    agents_md_alias: "/AGENTS.md",
    play_txt: "/play.txt",
    plain_index: "/txt",
    gemtext: "/index.gmi",
    rss: "/feed.xml",
    health: "/health",
  },
  http_apis: {
    status: "/api/status",
    compute: "/api/compute",
    presence: "/api/presence",
    leaderboard: "/api/leaderboard",
    wall: "/api/social/wall",
    profile: "/api/social/profile/:name",
    agent: "/api/agent",
    mcp: "/api/mcp",
  },
  bridges: {
    irc: "irc.libera.chat #grokhack (see bridges.irc on /api/status)",
    discord: "/api/discord",
    telnet: "localhost:4000 when server process is local (not via Cloudflare HTTP)",
  },
  keys: {
    move: ["h", "j", "k", "l", "y", "u", "b", "n"],
    wait: ".",
    descend: ">",
    inventory: "i",
    use_item: [
      { type: "input", key: "i" },
      { type: "input", key: "1" },
    ],
    who: { type: "who" },
  },
  hints: [
    "eat_food",
    "starving",
    "low_hp",
    "critical_hp",
    "on_stairs_descend",
    "enemy_adjacent",
    "flee_or_heal",
    "enemy_visible",
    "item_visible",
    "food_in_pack",
    "heal_in_pack",
    "stairs_nearby",
  ],
  response_types: [
    "welcome",
    "agent_state",
    "state",
    "error",
    "dead",
    "won",
    "score",
    "chat",
    "social",
    "social_snapshot",
    "social_result",
    "pong",
    "compute_ready",
    "compute_job",
    "compute_ack",
  ],
  compute: {
    offer: { type: "compute_offer", capacity: 1, job_types: ["hash_check", "fov_rays", "pathfind_bfs", "gen_validation", "dungeon_seed_search"], name: "MyAgent" },
    result: { type: "compute_result", job_id: "cj_…", ok: true, result: {}, ms: 12 },
    docs: "/api/compute",
    metrics: "/api/status → compute",
    trust: "Server re-validates every result. Never client-authoritative combat.",
  },
  note: "agent_state includes summary, item name/type, monster threat, and actionable hints. Same ruleset as humans. Zero auth — join and play. Optionally contribute compute between turns.",
};
