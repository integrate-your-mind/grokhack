import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";

export function startWebSocketServer(world: WorldServer, port: number): WebSocketServer {
  const wss = new WebSocketServer({ port, host: "0.0.0.0" });

  wss.on("connection", (ws) => {
    const connId = randomUUID();
    let named = false;

    const conn: ClientConnection = {
      id: connId,
      transport: "websocket",
      playerId: null,
      send: (msg: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (msg === "VIEW" && conn.playerId) {
          const p = world.getPlayer(conn.playerId);
          if (p) {
            const { floor, others } = world.buildView(p);
            ws.send(JSON.stringify({
              type: "state",
              player: serializePlayer(p),
              floor: serializeFloor(floor),
              others: others.map(serializePlayer),
            }));
          }
        } else if (msg === "DEAD" || msg === "WON") {
          ws.send(JSON.stringify({ type: msg.toLowerCase() }));
        }
      },
      close: () => ws.close(),
    };

    world.registerConnection(conn);
    ws.send(JSON.stringify({
      type: "welcome",
      online: world.getOnlineCount(),
      maxPlayers: 500,
    }));

    ws.on("message", (raw) => {
      let msg: { type: string; name?: string; key?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "join" && msg.name && !named) {
        const result = world.joinPlayer(connId, msg.name);
        if (typeof result === "string") {
          ws.send(JSON.stringify({ type: "error", message: result }));
          return;
        }
        named = true;
        conn.send("VIEW");
        return;
      }

      if (msg.type === "input" && conn.playerId) {
        if (msg.text?.startsWith(":")) {
          world.handleInput(conn.playerId, msg.text);
        } else if (msg.key) {
          world.handleInput(conn.playerId, msg.key);
        }
        conn.send("VIEW");
      }

      if (msg.type === "who" && conn.playerId) {
        world.handleInput(conn.playerId, "who");
      }
    });

    ws.on("close", () => world.removeConnection(connId));
  });

  wss.on("listening", () => {
    console.log(`[ws] listening on port ${port}`);
  });

  return wss;
}

function serializePlayer(p: ReturnType<WorldServer["getPlayer"]>) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    glyph: p.glyph,
    x: p.state.entity.x,
    y: p.state.entity.y,
    hp: p.state.entity.hp,
    maxHp: p.state.entity.maxHp,
    depth: p.floorDepth,
    level: p.state.level,
    phase: p.phase,
    messages: p.messages.slice(-10),
    hunger: p.state.hungerState,
    gold: p.state.gold,
    turns: p.state.turns,
    inventory: p.state.inventory.map((i) => ({ char: i.char, name: i.name })),
  };
}

function serializeFloor(floor: ReturnType<WorldServer["buildView"]>["floor"]) {
  return {
    depth: floor.depth,
    width: floor.dungeon.width,
    height: floor.dungeon.height,
    tiles: floor.dungeon.tiles,
    stairsDown: floor.dungeon.stairsDown,
    monsters: floor.monsters.filter((m) => m.hp > 0).map((m) => ({
      x: m.x, y: m.y, char: m.char, name: m.name, hp: m.hp,
    })),
    items: floor.items.map((i) => ({ x: i.x, y: i.y, char: i.item.char })),
  };
}