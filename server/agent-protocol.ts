import type { WorldServer } from "./world.js";
import type { OnlinePlayer } from "./types.js";

const DIR_KEYS = ["h", "j", "k", "l", "y", "u", "b", "n"] as const;

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
    inventory: { char: string; name: string; type?: string }[];
  };
  floor: {
    depth: number;
    width: number;
    height: number;
    tiles: string[][];
    stairsDown: { x: number; y: number };
  };
  visible: {
    monsters: { x: number; y: number; char: string; name: string; hp: number; kind?: string; adjacent: boolean }[];
    items: { x: number; y: number; char: string }[];
    players: { x: number; y: number; glyph: string; name: string }[];
  };
  messages: string[];
  online: number;
  valid_actions: string[];
  hints: string[];
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
    .map((m) => ({
      x: m.x,
      y: m.y,
      char: m.char,
      name: m.name,
      hp: m.hp,
      kind: m.kind,
      adjacent: Math.abs(m.x - px) + Math.abs(m.y - py) === 1,
    }));

  const items = floor.items
    .filter((i) => inFov(i.x, i.y))
    .map((i) => ({ x: i.x, y: i.y, char: i.item.char }));

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
      valid_actions.push(...DIR_KEYS.filter((k) => {
        const dirs: Record<string, [number, number]> = {
          h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1],
          y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1],
        };
        const [dx, dy] = dirs[k];
        return monsters.some((m) => m.x === px + dx && m.y === py + dy);
      }));
    }
  }

  const hints: string[] = [];
  if (player.state.hungerState === "hungry" || player.state.hungerState === "weak") {
    hints.push("eat_food");
  }
  if (player.state.entity.hp < player.state.entity.maxHp * 0.4) {
    hints.push("low_hp");
  }
  if (px === floor.dungeon.stairsDown.x && py === floor.dungeon.stairsDown.y) {
    hints.push("on_stairs_descend");
  }
  if (monsters.some((m) => m.adjacent)) {
    hints.push("enemy_adjacent");
  }

  return {
    type: "agent_state",
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
      inventory: player.state.inventory.map((i) => ({
        char: i.char,
        name: i.name,
        type: i.type,
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
}

export const AGENT_DOCS = {
  endpoint: "wss://grokhack.mondello.dev/ws",
  protocol: "json",
  join: { type: "join", name: "MyAgent", kind: "agent" },
  act: { type: "input", key: "l" },
  chat: { type: "input", text: ":say hello" },
  social: {
    friend_add: { type: "social", action: "friend_add", target: "PlayerName" },
    dm: { type: "social", action: "dm_send", target: "PlayerName", text: "meet at stairs" },
    wall: { type: "social", action: "wall_post", text: "depth 3!" },
    snapshot: { type: "social", action: "snapshot" },
  },
  mcp: "/api/mcp",
  keys: {
    move: ["h", "j", "k", "l", "y", "u", "b", "n"],
    wait: ".",
    descend: ">",
    inventory: "i",
    use_item: { type: "input", key: "1" },
    who: { type: "who" },
  },
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
  ],
};