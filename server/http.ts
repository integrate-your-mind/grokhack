import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";
import { buildAgentState, AGENT_DOCS } from "./agent-protocol.js";
import { getLeaderboard, getRecentRuns } from "./leaderboard.js";
import { logEvent, getRecentEvents, getSessionTrace } from "./audit.js";
import { getGlobalWall, getSocialSnapshot } from "./social.js";
import {
  BIND_HOST,
  rateLimit,
  requireAdmin,
  readBody,
  securityHeaders,
  safePublicPath,
  MAX_WS_MESSAGE_BYTES,
} from "./security.js";
import { getBridgeStatus } from "./bridge.js";
import { getDiscordBotStatus, repostRules } from "./discord-bot.js";

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
  const file = safePublicPath(PUBLIC_DIR, urlPath);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);
  res.writeHead(200, securityHeaders({ "Content-Type": MIME[ext] ?? "application/octet-stream" }));
  res.end(fs.readFileSync(file));
  return true;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, securityHeaders({ "Content-Type": "application/json" }));
  res.end(JSON.stringify(data));
}

export function serializePlayer(p: ReturnType<WorldServer["getPlayer"]>) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    glyph: p.glyph,
    kind: p.kind,
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

export function serializeFloor(floor: ReturnType<WorldServer["buildView"]>["floor"]) {
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

function pushState(ws: import("ws").WebSocket, world: WorldServer, conn: ClientConnection): void {
  if (!conn.playerId || ws.readyState !== 1) return;
  const p = world.getPlayer(conn.playerId);
  if (!p) return;

  if (conn.agentMode) {
    ws.send(JSON.stringify(buildAgentState(world, p)));
    return;
  }

  const { floor, others } = world.buildView(p);
  ws.send(JSON.stringify({
    type: "state",
    player: serializePlayer(p),
    floor: serializeFloor(floor),
    others: others.map(serializePlayer),
    online: world.getOnlineCount(),
  }));
}

function attachWebSocket(server: http.Server, world: WorldServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  const wsAlive = new WeakMap<import("ws").WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (wsAlive.get(ws) === false) return ws.terminate();
      wsAlive.set(ws, false);
      ws.ping();
    });
  }, 25_000);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws, req) => {
    if (!rateLimit(req)) {
      ws.close(1008, "Rate limited");
      return;
    }

    const connId = randomUUID();
    const sessionId = randomUUID();
    let named = false;
    wsAlive.set(ws, true);
    ws.on("pong", () => wsAlive.set(ws, true));

    logEvent("session_connect", sessionId, { transport: "websocket" });

    const conn: ClientConnection = {
      id: connId,
      sessionId,
      transport: "websocket",
      playerId: null,
      agentMode: false,
      send: (msg: string) => {
        if (ws.readyState !== 1) return;
        if (msg.startsWith("RT:")) {
          ws.send(msg.slice(3));
          return;
        }
        if (msg.startsWith("SCORE:")) {
          ws.send(JSON.stringify({ type: "score", entry: JSON.parse(msg.slice(6)) }));
          return;
        }
        if (msg === "VIEW") pushState(ws, world, conn);
        else if (msg === "DEAD" || msg === "WON") {
          ws.send(JSON.stringify({ type: msg.toLowerCase() }));
        }
      },
      close: () => ws.close(),
    };

    world.registerConnection(conn);
    ws.send(JSON.stringify({
      type: "welcome",
      sessionId,
      online: world.getOnlineCount(),
      maxPlayers: 500,
      agent_docs: "/api/agent",
      mcp_docs: "/api/mcp",
      social: {
        chat: ":say <msg>",
        friends: ":friend add|accept|remove <name>",
        dm: ":dm <name> <msg>",
        wall: ":wall <msg>",
      },
    }));

    ws.on("message", (raw) => {
      if (raw.toString().length > MAX_WS_MESSAGE_BYTES) {
        ws.close(1009, "Message too large");
        return;
      }
      let msg: {
        type: string;
        name?: string;
        key?: string;
        text?: string;
        kind?: string;
        action?: string;
        target?: string;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "join" && msg.name && !named) {
        conn.agentMode = msg.kind === "agent";
        const result = world.joinPlayer(connId, msg.name, msg.kind === "agent" ? "agent" : "human");
        if (typeof result === "string") {
          ws.send(JSON.stringify({ type: "error", message: result }));
          return;
        }
        named = true;
        const p = world.getPlayer(conn.playerId!);
        if (p) {
          ws.send(JSON.stringify({
            type: "social_snapshot",
            snapshot: getSocialSnapshot(p.name),
            chat_history: world.getChatLog(30),
          }));
        }
        world.broadcastPresence();
        pushState(ws, world, conn);
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", online: world.getOnlineCount() }));
        return;
      }

      if (msg.type === "social" && conn.playerId) {
        const result = world.handleSocialApi(conn.playerId, msg.action || "", {
          target: msg.target || "",
          text: msg.text || "",
        });
        ws.send(JSON.stringify({ type: "social_result", action: msg.action, result }));
        if (msg.action === "snapshot" || msg.action?.startsWith("friend") || msg.action === "dm_thread") {
          pushState(ws, world, conn);
        }
        return;
      }

      if (msg.type === "input" && conn.playerId) {
        if (msg.text?.startsWith(":")) {
          world.handleInput(conn.playerId, msg.text);
        } else if (msg.key) {
          world.handleInput(conn.playerId, msg.key);
        }
        pushState(ws, world, conn);
      }

      if (msg.type === "who" && conn.playerId) {
        world.handleInput(conn.playerId, "who");
        pushState(ws, world, conn);
      }
    });

    ws.on("close", () => {
      logEvent("session_disconnect", sessionId, { transport: "websocket", playerId: conn.playerId ?? undefined });
      world.removeConnection(connId);
      world.broadcastPresence();
    });
  });

  console.log("[ws] attached at /ws (human + agent modes)");
}

export function startHttpServer(world: WorldServer, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (!rateLimit(req)) {
      res.writeHead(429, securityHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: "Rate limited" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/status") {
      json(res, {
        name: "GrokHack MMO",
        ...world.getStats(),
        bridges: getBridgeStatus(),
        discord: getDiscordBotStatus(),
      });
      return;
    }

    if (url.pathname === "/api/discord") {
      const d = getDiscordBotStatus();
      let clientId = process.env.DISCORD_CLIENT_ID || "";
      if (!clientId && process.env.DISCORD_BOT_TOKEN?.includes(".")) {
        try {
          clientId = Buffer.from(process.env.DISCORD_BOT_TOKEN.split(".")[0], "base64").toString("utf8");
        } catch { /* ignore */ }
      }
      json(res, {
        ...d,
        inviteUrl: clientId
          ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${d.invitePermissions}&scope=bot%20applications.commands`
          : null,
        onboarding: ["Join server", "Verify in #rules-and-verify", "/link gamename", ":verify CODE in-game"],
      });
      return;
    }

    if (url.pathname === "/api/discord/repost-rules" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const ok = await repostRules();
      json(res, { ok });
      return;
    }

    if (url.pathname === "/api/agent") {
      json(res, AGENT_DOCS);
      return;
    }

    if (url.pathname === "/api/mcp") {
      json(res, {
        name: "grokhack",
        package: "@grokhack/mcp",
        install: "npx @grokhack/mcp",
        repo_path: "mcp/",
        endpoint: "wss://grokhack.mondello.dev/ws",
        tools: [
          "grokhack_status",
          "grokhack_join",
          "grokhack_action",
          "grokhack_chat",
          "grokhack_social",
          "grokhack_who",
          "grokhack_leaderboard",
        ],
        cursor_config: {
          mcpServers: {
            grokhack: {
              command: "node",
              args: ["mcp/dist/index.js"],
              env: { GROKHACK_URL: "wss://grokhack.mondello.dev/ws" },
            },
          },
        },
        local_install: "npm run mcp:build && node mcp/dist/index.js",
      });
      return;
    }

    if (url.pathname === "/api/social/wall") {
      json(res, { posts: getGlobalWall(50) });
      return;
    }

    if (url.pathname.startsWith("/api/social/profile/")) {
      const name = decodeURIComponent(url.pathname.split("/").pop() || "");
      const snap = getSocialSnapshot(name);
      json(res, snap);
      return;
    }

    if (url.pathname === "/api/presence") {
      json(res, world.getPresence());
      return;
    }

    if (url.pathname === "/api/audit/client-error" && req.method === "POST") {
      try {
        const body = await readBody(req, 4096);
        const data = JSON.parse(body) as { sessionId?: string; message?: string; context?: string };
        const msg = String(data.message || "").slice(0, 500);
        logEvent("client_error", String(data.sessionId || "unknown").slice(0, 64), {
          detail: { message: msg, context: String(data.context || "").slice(0, 100) },
        });
        json(res, { ok: true });
      } catch {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "Bad request" }));
      }
      return;
    }

    if (url.pathname === "/api/audit/recent") {
      if (!requireAdmin(req, res)) return;
      json(res, { events: getRecentEvents(100) });
      return;
    }

    if (url.pathname.startsWith("/api/audit/session/")) {
      if (!requireAdmin(req, res)) return;
      const sid = url.pathname.split("/").pop() || "";
      json(res, { sessionId: sid, events: getSessionTrace(sid) });
      return;
    }

    if (url.pathname === "/api/leaderboard") {
      const kind = url.searchParams.get("kind") as "human" | "agent" | null;
      json(res, {
        top: getLeaderboard(kind ?? undefined, 50),
        recent: getRecentRuns(15),
      });
      return;
    }

    if (serveStatic(url.pathname, res)) return;

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  attachWebSocket(server, world);

  server.listen(port, BIND_HOST, () => {
    console.log(`[http] http://${BIND_HOST}:${port}`);
  });

  return server;
}