import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  const safe = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC_DIR, safe.replace(/^\//, ""));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
  return true;
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
    messages: p.messages.slice(-12),
    hunger: p.state.hungerState,
    gold: p.state.gold,
    turns: p.state.turns,
    xp: p.state.xp,
    xpToLevel: p.state.xpToLevel,
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
      x: m.x, y: m.y, char: m.char, name: m.name, hp: m.hp, kind: m.kind,
    })),
    items: floor.items.map((i) => ({ x: i.x, y: i.y, char: i.item.char })),
  };
}

function attachWebSocket(server: http.Server, world: WorldServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    const connId = randomUUID();
    let named = false;

    const conn: ClientConnection = {
      id: connId,
      transport: "websocket",
      playerId: null,
      send: (msg: string) => {
        if (ws.readyState !== 1) return;
        if (msg === "VIEW" && conn.playerId) {
          const p = world.getPlayer(conn.playerId);
          if (p) {
            const { floor, others } = world.buildView(p);
            ws.send(JSON.stringify({
              type: "state",
              player: serializePlayer(p),
              floor: serializeFloor(floor),
              others: others.map(serializePlayer),
              online: world.getOnlineCount(),
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
        conn.send("VIEW");
      }
    });

    ws.on("close", () => world.removeConnection(connId));
  });

  console.log("[ws] attached at /ws");
}

export function startHttpServer(world: WorldServer, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ name: "GrokHack MMO", ...world.getStats() }));
      return;
    }

    if (url.pathname === "/api/who") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ players: world.getOnlineCount() }));
      return;
    }

    if (serveStatic(url.pathname, res)) return;

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  attachWebSocket(server, world);

  server.listen(port, "0.0.0.0", () => {
    console.log(`[http] http://0.0.0.0:${port} (landing + /play + /ws + /api/status)`);
  });

  return server;
}