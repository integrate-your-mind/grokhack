import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";
import { buildAgentState, AGENT_DOCS } from "./agent-protocol.js";
import { getLeaderboard, getRecentRuns } from "./leaderboard.js";
import {
  logEvent,
  getRecentEvents,
  getSessionTrace,
  getAuditStats,
  ingestClientTelemetry,
} from "./audit.js";
import { initSession, rekeySession, finalizeSession, bumpMetric } from "./session-metrics.js";
import {
  getGlobalWall,
  getPublicSocialProfile,
  getSocialSnapshot,
  touchProfile,
} from "./social.js";
import {
  BIND_HOST,
  clientIp,
  MAX_WS_BUFFERED_BYTES,
  MAX_WS_CONNECTIONS,
  MAX_WS_CONNECTIONS_PER_IP,
  rateLimit,
  rateLimitScoped,
  requireAdmin,
  readBody,
  securityHeaders,
  safePublicPath,
  MAX_WS_MESSAGE_BYTES,
  WS_JOIN_DEADLINE_MS,
} from "./security.js";
import { submitFeedback, listFeedback, FEEDBACK_CATEGORIES } from "./feedback.js";
import { getBridgeStatus } from "./bridge.js";
import { getDiscordBotStatus, repostRules, retryDiscordSetup } from "./discord-bot.js";
import { getComputePool, COMPUTE_PROTOCOL_DOCS } from "./compute.js";
import {
  createXLinkCode,
  formatXHandle,
  getLinkedXHandle,
  getXLinkStatus,
} from "./x-links.js";
import {
  listProducts,
  getProduct,
  getEntitlements,
  grantPurchase,
  claimPaymentFingerprint,
  assertProductSafe,
  buildPaymentRequired,
  x402Configured,
  revenueSummary,
  type ProductSku,
} from "./store.js";
import {
  isProductionRuntime,
  verifyX402Payment,
  x402ProductionGuardActive,
} from "./x402.js";
import { verifyResumeToken } from "./resume-auth.js";
import {
  getCredits,
  creditsLeaderboard,
  redeemWithCredits,
  creditsDocs,
  CREDIT_PRICES,
} from "./credits.js";
import { isPersistenceReady, SCHEMA_VERSION } from "./persistence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_PENDING_WS_MESSAGES = 64;
const MAX_WS_MESSAGES_PER_MINUTE = 600;

export interface WebSocketAdmissionOptions {
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  joinDeadlineMs?: number;
  maxBufferedBytes?: number;
}

export interface DrainHandle {
  drained: Promise<void>;
  forceClose(): void;
}

interface WebSocketDrainControl {
  beginDrain(): Promise<void>;
  forceClose(): void;
}

interface HttpDrainState {
  draining: boolean;
  webSockets: WebSocketDrainControl;
  handle?: DrainHandle;
}

const httpDrainStates = new WeakMap<http.Server, HttpDrainState>();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".gmi": "text/gemini; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** HTML/JS/CSS must revalidate (viral share loop ships often). Images can cache longer. */
function cacheControlFor(ext: string): string {
  if (ext === ".html" || ext === ".js" || ext === ".css") {
    return "public, max-age=0, must-revalidate";
  }
  // Crawl manifests + machine docs: short cache so agent/lownet updates propagate
  if (ext === ".xml" || ext === ".txt" || ext === ".md" || ext === ".gmi") {
    return "public, max-age=60, must-revalidate";
  }
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg" || ext === ".ico") {
    return "public, max-age=86400, stale-while-revalidate=604800";
  }
  return "public, max-age=300";
}

function plain(res: http.ServerResponse, body: string, status = 200, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, securityHeaders({ "Content-Type": type, "Cache-Control": "public, max-age=30, must-revalidate" }));
  res.end(body);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const LOWNET_TXT_INDEX = `GrokHack low-net / agent access index
=====================================
Base: https://grokhack.mondello.dev

PLAY
  /play.html          full browser client
  /play.txt           low-bandwidth how-to-play
  telnet localhost 4000   (local server only)
  wss://grokhack.mondello.dev/ws

AGENTS (zero friction)
  /skill              GATE: straight to MCP/skill (start here)
  /api/skill          JSON skill card + cursor_config
  /agents.md          AGENTS.md join guide
  /AGENTS.md          alias
  /api/agent          JSON protocol contract
  /api/mcp            MCP install + Cursor/Claude config
  /mcp.html           human MCP page
  /agent.html         human agent API page
  /llms.txt           LLM crawl summary

REVENUE (x402 USDC on Base — cosmetics/tips only, no pay-to-win)
  /store.html         human store UI
  /api/store          product catalog
  /api/store/unlock   POST {sku,playerName} → 402 or unlock with PAYMENT-SIGNATURE
  /api/store/entitlements?player=Name


LIVE STATE
  /health             liveness (ok + online)
  /api/status         full status + IRC/Discord + compute metrics
  /api/compute        voluntary compute protocol + live pool
  /api/presence       who is online
  /api/leaderboard    scores (?kind=human|agent)
  /api/social/wall    public wall

MACHINE / GEMINI / RSS
  /txt                this index
  /index.gmi          gemtext capsule
  /feed.xml           RSS recent runs
  /rss.xml            alias of feed.xml

SOCIAL BRIDGES
  IRC:  irc.libera.chat #grokhack  (see /api/status bridges.irc)
  Discord: /discord.html · /api/discord
  X link: POST /api/x/link {xHandle, gameName} → :verify CODE in-game

QUICK JOIN (WebSocket)
  {"type":"join","name":"MyAgent","kind":"agent"}
  {"type":"input","key":"l"}

VOLUNTARY COMPUTE (contribute CPU between turns)
  {"type":"compute_offer","capacity":1,"job_types":["hash_check","fov_rays","pathfind_bfs","gen_validation"]}
  → compute_job → compute_result → compute_ack (server always validates)
  Telnet: :compute on | :compute off | :compute status
  Full: /api/compute · metrics on /api/status

Source: https://github.com/integrate-your-mind/grokhack
MIT · LOWNET/AGENT ACCESS owns this surface
`;

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  const file = safePublicPath(PUBLIC_DIR, urlPath);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": cacheControlFor(ext),
  };
  // Keep edge caches short for crawl manifests (stale CF 404 once hid /robots.txt for hours)
  if (
    urlPath === "/robots.txt" ||
    urlPath === "/sitemap.xml" ||
    urlPath === "/llms.txt" ||
    ext === ".xml" ||
    ext === ".txt" ||
    ext === ".md" ||
    ext === ".gmi"
  ) {
    headers["CDN-Cache-Control"] = "public, max-age=60, must-revalidate";
    headers["Cloudflare-CDN-Cache-Control"] = "public, max-age=60, must-revalidate";
  }
  res.writeHead(200, securityHeaders(headers));
  res.end(fs.readFileSync(file));
  return true;
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, securityHeaders({ "Content-Type": "application/json" }));
  res.end(JSON.stringify(data));
}

export function serializePlayer(p: ReturnType<WorldServer["getPlayer"]>) {
  if (!p) return null;
  const xHandle = getLinkedXHandle(p.name);
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
    deathCause: p.state.deathCause ?? null,
    /** Linked X handle (no @) when character completed :verify after /api/x/link */
    xHandle: xHandle || null,
    xHandleDisplay: xHandle ? formatXHandle(xHandle) : null,
    weapon: p.state.equippedWeapon
      ? { char: p.state.equippedWeapon.char, name: p.state.equippedWeapon.name, power: p.state.equippedWeapon.power }
      : null,
    armor: p.state.equippedArmor
      ? { char: p.state.equippedArmor.char, name: p.state.equippedArmor.name, power: p.state.equippedArmor.power }
      : null,
    inventory: p.state.inventory.map((i) => ({
      char: i.char,
      name: i.identified
        ? i.name
        : i.type === "potion" && i.appearance
          ? `${i.appearance} potion`
          : `unidentified ${i.type}`,
      type: i.type,
      identified: !!i.identified,
      power: i.identified ? i.power : undefined,
    })),
  };
}

/** Public map identity for observers. Never add owner-only run or social state here. */
export function serializePublicPlayer(p: ReturnType<WorldServer["getPlayer"]>) {
  if (!p) return null;
  const xHandle = getLinkedXHandle(p.name);
  return {
    id: p.id,
    name: p.name,
    glyph: p.glyph,
    kind: p.kind,
    x: p.state.entity.x,
    y: p.state.entity.y,
    depth: p.floorDepth,
    level: p.state.level,
    phase: p.phase,
    xHandle: xHandle || null,
    xHandleDisplay: xHandle ? formatXHandle(xHandle) : null,
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
      x: m.x,
      y: m.y,
      char: m.char,
      name: m.name,
      hp: m.hp,
      maxHp: m.maxHp,
      kind: m.kind,
    })),
    items: floor.items.map((i) => ({ x: i.x, y: i.y, char: i.item.char })),
  };
}

function positiveOption(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/** Bound both queued bytes and any single outbound frame before calling ws.send. */
export function sendWebSocketBounded(
  ws: Pick<import("ws").WebSocket, "readyState" | "bufferedAmount" | "send" | "close">,
  payload: string,
  maxBufferedBytes = MAX_WS_BUFFERED_BYTES,
): boolean {
  if (ws.readyState !== 1) return false;
  const frameBytes = Buffer.byteLength(payload, "utf8");
  if (frameBytes > maxBufferedBytes || ws.bufferedAmount + frameBytes > maxBufferedBytes) {
    try {
      ws.close(1013, "Slow consumer");
    } catch {
      // The peer may have disappeared between the readyState check and close.
    }
    return false;
  }
  try {
    ws.send(payload);
    return true;
  } catch {
    try {
      ws.close(1011, "Outbound send failed");
    } catch {
      // The peer is already gone.
    }
    return false;
  }
}

function pushState(
  ws: import("ws").WebSocket,
  world: WorldServer,
  conn: ClientConnection,
  maxBufferedBytes: number,
): void {
  if (!conn.playerId || ws.readyState !== 1) return;
  const p = world.getPlayer(conn.playerId);
  if (!p) return;

  if (conn.agentMode) {
    sendWebSocketBounded(ws, JSON.stringify(buildAgentState(world, p)), maxBufferedBytes);
    return;
  }

  const { floor, others } = world.buildView(p);
  sendWebSocketBounded(ws, JSON.stringify({
    type: "state",
    player: serializePlayer(p),
    floor: serializeFloor(floor),
    others: others.map(serializePublicPlayer),
    online: world.getOnlineCount(),
  }), maxBufferedBytes);
}

function wsPayloadBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function attachWebSocket(
  server: http.Server,
  world: WorldServer,
  options: WebSocketAdmissionOptions = {},
  isDraining: () => boolean = () => false,
): WebSocketDrainControl {
  const maxConnections = positiveOption(options.maxConnections, MAX_WS_CONNECTIONS);
  const maxConnectionsPerIp = positiveOption(
    options.maxConnectionsPerIp,
    MAX_WS_CONNECTIONS_PER_IP,
  );
  const joinDeadlineMs = positiveOption(options.joinDeadlineMs, WS_JOIN_DEADLINE_MS);
  const maxBufferedBytes = positiveOption(options.maxBufferedBytes, MAX_WS_BUFFERED_BYTES);
  // Enforce before ws buffers/converts the complete frame. Application checks below
  // remain defense-in-depth and use UTF-8 bytes rather than JS character count.
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: MAX_WS_MESSAGE_BYTES,
  });

  const wsAlive = new WeakMap<import("ws").WebSocket, boolean>();
  const wsConn = new WeakMap<import("ws").WebSocket, ClientConnection>();
  const socketsByIp = new Map<string, number>();
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (wsAlive.get(ws) === false) {
        const c = wsConn.get(ws);
        if (c) c.disconnectReason = "timeout";
        return ws.terminate();
      }
      wsAlive.set(ws, false);
      ws.ping();
    });
  }, 45_000);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws, req) => {
    if (isDraining()) {
      ws.close(1012, "Service Restart");
      return;
    }
    if (wss.clients.size > maxConnections) {
      ws.close(1013, "Connection capacity reached");
      return;
    }
    if (!rateLimit(req)) {
      ws.close(1008, "Rate limited");
      return;
    }
    const ip = clientIp(req);
    const ipConnections = socketsByIp.get(ip) ?? 0;
    if (ipConnections >= maxConnectionsPerIp) {
      ws.close(1008, "Too many connections from this address");
      return;
    }
    socketsByIp.set(ip, ipConnections + 1);

    const connId = randomUUID();
    const sessionId = randomUUID();
    let admissionState: "unjoined" | "joining" | "joined" = "unjoined";
    let messageQueueFailed = false;
    let messageQueue: Promise<void> = Promise.resolve();
    let pendingMessageCount = 0;
    let messageWindowStartedAt = Date.now();
    let messagesInWindow = 0;
    wsAlive.set(ws, true);
    ws.on("pong", () => wsAlive.set(ws, true));

    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    logEvent("session_connect", sessionId, {
      transport: "websocket",
      detail: { ua, ip: req.socket.remoteAddress },
    });
    initSession(sessionId, "websocket");

    const conn: ClientConnection = {
      id: connId,
      sessionId,
      transport: "websocket",
      playerId: null,
      agentMode: false,
      send: (msg: string) => {
        if (ws.readyState !== 1) return;
        if (msg.startsWith("RT:")) {
          sendWebSocketBounded(ws, msg.slice(3), maxBufferedBytes);
          return;
        }
        if (msg.startsWith("SCORE:")) {
          sendWebSocketBounded(
            ws,
            JSON.stringify({ type: "score", entry: JSON.parse(msg.slice(6)) }),
            maxBufferedBytes,
          );
          return;
        }
        if (msg === "VIEW") pushState(ws, world, conn, maxBufferedBytes);
        else if (msg === "DEAD" || msg === "WON") {
          const p = conn.playerId ? world.getPlayer(conn.playerId) : null;
          sendWebSocketBounded(
            ws,
            JSON.stringify({
              type: msg.toLowerCase(),
              player: p ? serializePlayer(p) : null,
              online: world.getOnlineCount(),
            }),
            maxBufferedBytes,
          );
        }
      },
      close: () => {
        conn.disconnectReason = conn.disconnectReason ?? "server";
        ws.close();
      },
    };
    wsConn.set(ws, conn);
    ws.on("error", (error: Error & { code?: string }) => {
      // ws emits parser-limit violations as an error before the 1009 close.
      // Treat expected hostile/oversized input as a handled protocol failure;
      // retain full diagnostics for unrelated socket faults.
      if (error.code !== "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
        console.error(`[ws] socket error for ${connId}: ${error.stack ?? error.message}`);
      }
    });

    const joinDeadline = setTimeout(() => {
      if (admissionState === "joined" || ws.readyState !== 1) return;
      conn.disconnectReason = "timeout";
      ws.close(1008, "Join deadline exceeded");
    }, joinDeadlineMs);
    if (typeof joinDeadline.unref === "function") joinDeadline.unref();

    if (!world.registerConnection(conn)) {
      conn.disconnectReason = "restart";
      clearTimeout(joinDeadline);
      const remainingForIp = (socketsByIp.get(ip) ?? 1) - 1;
      if (remainingForIp > 0) socketsByIp.set(ip, remainingForIp);
      else socketsByIp.delete(ip);
      finalizeSession(conn.sessionId);
      ws.close(1012, "Service Restart");
      return;
    }
    sendWebSocketBounded(ws, JSON.stringify({
      type: "welcome",
      sessionId,
      online: world.getOnlineCount(),
      maxPlayers: 500,
      agent_docs: "/api/agent",
      mcp_docs: "/api/mcp",
      social: {
        chat: ":say <msg>",
        emote: ":me <action>",
        friends: ":friend add|accept|decline|cancel|remove <name>",
        dm: ":dm <name> <msg>",
        wall: ":wall <msg>",
        who: ":who",
      },
    }), maxBufferedBytes);

    ws.on("message", (raw, isBinary) => {
      const now = Date.now();
      if (now - messageWindowStartedAt >= 60_000) {
        messageWindowStartedAt = now;
        messagesInWindow = 0;
      }
      messagesInWindow += 1;
      if (messagesInWindow > MAX_WS_MESSAGES_PER_MINUTE) {
        messageQueueFailed = true;
        ws.close(1008, "Message rate exceeded");
        return;
      }
      if (pendingMessageCount >= MAX_PENDING_WS_MESSAGES) {
        messageQueueFailed = true;
        ws.close(1008, "Too many pending messages");
        return;
      }
      pendingMessageCount += 1;
      // ws emits messages independently; serialize per connection so join/input/close
      // ordering cannot race across an awaited durable lookup.
      messageQueue = messageQueue
        .then(async () => {
          if (messageQueueFailed || ws.readyState !== 1) return;
          await handleWsMessage(raw, isBinary);
        })
        .catch((error: unknown) => {
          messageQueueFailed = true;
          const detail = error instanceof Error ? error.stack ?? error.message : String(error);
          console.error(`[ws] message handler failed for ${connId}: ${detail}`);
          if (ws.readyState === 1) ws.close(1011, "Message handling failed");
        })
        .finally(() => {
          pendingMessageCount -= 1;
        });
    });

    async function handleWsMessage(raw: RawData, isBinary: boolean) {
      if (isDraining() || world.isDraining()) {
        conn.disconnectReason = "restart";
        ws.close(1012, "Service Restart");
        return;
      }
      if (isBinary) {
        ws.close(1003, "Text frames only");
        return;
      }
      const payload = wsPayloadBuffer(raw);
      if (payload.byteLength > MAX_WS_MESSAGE_BYTES) {
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
        sessionId?: string;
        resumeToken?: string;
        capacity?: number;
        job_types?: string[];
        job_id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
        ms?: number;
      };
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }

      const computeSend = (m: Record<string, unknown>) => {
        sendWebSocketBounded(ws, JSON.stringify(m), maxBufferedBytes);
      };

      // Voluntary compute — anonymous helpers OK (before or after join)
      if (msg.type === "compute_offer") {
        const label =
          msg.name ||
          (conn.playerId ? world.getPlayer(conn.playerId)?.name : undefined) ||
          `ws-${connId.slice(0, 6)}`;
        getComputePool().handleOffer(
          connId,
          { capacity: msg.capacity, job_types: msg.job_types, name: label },
          computeSend,
          "websocket"
        );
        return;
      }

      if (msg.type === "compute_result") {
        getComputePool().handleResult(connId, {
          job_id: msg.job_id,
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
          ms: msg.ms,
        });
        return;
      }

      if (msg.type === "join" && msg.name) {
        if (admissionState === "joined") {
          sendWebSocketBounded(
            ws,
            JSON.stringify({ type: "error", message: "Connection is already joined." }),
            maxBufferedBytes,
          );
          return;
        }
        if (admissionState === "joining") {
          sendWebSocketBounded(
            ws,
            JSON.stringify({ type: "error", message: "Join already in progress." }),
            maxBufferedBytes,
          );
          return;
        }
        admissionState = "joining";
        try {
          // Tighter join burst limit (does not weaken global RATE_LIMIT_PER_MIN)
          if (!rateLimitScoped("ws-join", req, 30, 60_000)) {
            sendWebSocketBounded(
              ws,
              JSON.stringify({ type: "error", message: "Join rate limited. Try again shortly." }),
              maxBufferedBytes,
            );
            admissionState = "unjoined";
            return;
          }
          // SESSION-HA: sticky client sessionId for audit continuity across reconnects
          // (not an auth secret — resumeToken is the session binder)
          const clientSid = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
          if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              clientSid
            )
          ) {
            rekeySession(conn.sessionId, clientSid);
            conn.sessionId = clientSid;
          }
          conn.agentMode = msg.kind === "agent";
          const presented =
            typeof msg.resumeToken === "string"
              ? msg.resumeToken.trim().toLowerCase()
              : undefined;
          const result = await world.joinPlayer(
            connId,
            msg.name,
            msg.kind === "agent" ? "agent" : "human",
            presented
          );
          if (typeof result === "string") {
            admissionState = "unjoined";
            logEvent("player_join_failed", conn.sessionId, {
              detail: { name: msg.name?.slice(0, 16), reason: result },
            });
            if (ws.readyState === 1) {
              sendWebSocketBounded(
                ws,
                JSON.stringify({ type: "error", message: result }),
                maxBufferedBytes,
              );
            }
            return;
          }
          admissionState = "joined";
          clearTimeout(joinDeadline);
          const p = world.getPlayer(conn.playerId!);
          if (p) {
            // Explicit post-admission activity boundary: owner snapshots stay
            // read-only while successful joins still create/update lastSeen.
            touchProfile(p.name);
            sendWebSocketBounded(
              ws,
              JSON.stringify({
                type: "social_snapshot",
                snapshot: getSocialSnapshot(p.name),
                chat_history: world.getChatLog(30),
                resumed: result.state.turns > 0 || result.floorDepth > 1,
                // Owner-only secret — never include in presence/broadcast state
                resumeToken: result.resumeToken,
                name: result.name,
              }),
              maxBufferedBytes,
            );
          }
          world.broadcastPresence();
          pushState(ws, world, conn, maxBufferedBytes);
          return;
        } catch (error) {
          admissionState = "unjoined";
          throw error;
        }
      }

      if (msg.type === "ping") {
        sendWebSocketBounded(
          ws,
          JSON.stringify({ type: "pong", online: world.getOnlineCount() }),
          maxBufferedBytes,
        );
        return;
      }

      if (msg.type === "social" && conn.playerId) {
        const result = world.handleSocialApi(conn.playerId, msg.action || "", {
          target: msg.target || "",
          text: msg.text || "",
        });
        sendWebSocketBounded(
          ws,
          JSON.stringify({ type: "social_result", action: msg.action, result }),
          maxBufferedBytes,
        );
        if (msg.action === "snapshot" || msg.action?.startsWith("friend") || msg.action === "dm_thread") {
          pushState(ws, world, conn, maxBufferedBytes);
        }
        return;
      }

      if (msg.type === "input" && conn.playerId) {
        if (msg.text?.startsWith(":")) {
          world.handleInput(conn.playerId, msg.text);
        } else if (msg.key) {
          world.handleInput(conn.playerId, msg.key);
        }
        pushState(ws, world, conn, maxBufferedBytes);
      }

      if (msg.type === "who" && conn.playerId) {
        world.handleInput(conn.playerId, "who");
        pushState(ws, world, conn, maxBufferedBytes);
      }
    }

    ws.on("close", (code) => {
      clearTimeout(joinDeadline);
      const remainingForIp = (socketsByIp.get(ip) ?? 1) - 1;
      if (remainingForIp > 0) socketsByIp.set(ip, remainingForIp);
      else socketsByIp.delete(ip);
      const reason =
        conn.disconnectReason ??
        (code === 1000 || code === 1001 || code === 1005 || code === 1006
          ? "client"
          : "client");
      const auditSid = conn.sessionId || sessionId;
      const player = conn.playerId ? world.getPlayer(conn.playerId) : undefined;
      logEvent("session_disconnect", auditSid, {
        transport: "websocket",
        playerId: conn.playerId ?? undefined,
        playerName: player?.name,
        detail: { reason, code },
      });
      finalizeSession(auditSid, conn.playerId ?? undefined);
      getComputePool().unregisterWorker(connId);
      world.removeConnection(connId, reason);
      world.broadcastPresence();
    });
  });

  console.log("[ws] attached at /ws (human + agent modes + compute)");
  let drainPromise: Promise<void> | undefined;
  return {
    beginDrain(): Promise<void> {
      if (drainPromise) return drainPromise;
      for (const ws of wss.clients) {
        const conn = wsConn.get(ws);
        if (conn) conn.disconnectReason = "restart";
        sendWebSocketBounded(
          ws,
          JSON.stringify({ type: "server_restarting", retryAfterMs: 1_000 }),
          maxBufferedBytes,
        );
        ws.close(1012, "Service Restart");
      }
      drainPromise = new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      return drainPromise;
    },
    forceClose(): void {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

export function startHttpServer(
  world: WorldServer,
  port: number,
  webSocketOptions: WebSocketAdmissionOptions = {},
): http.Server {
  const processStartedAt = Date.now();
  const state = { draining: false } as HttpDrainState;
  const readiness = () => {
    const productionSafe = x402ProductionGuardActive();
    return {
      productionSafe,
      ready:
        !state.draining &&
        isPersistenceReady() &&
        (!isProductionRuntime() || productionSafe),
    };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (isProductionRuntime() && req.headers["x-forwarded-proto"] === "http") {
      res.writeHead(
        308,
        securityHeaders({
          Location: `https://grokhack.mondello.dev${url.pathname}${url.search}`,
          "Cache-Control": "no-store",
        }),
      );
      res.end();
      return;
    }
    if (
      state.draining &&
      url.pathname !== "/live" &&
      url.pathname !== "/ready" &&
      url.pathname !== "/health" &&
      url.pathname !== "/api/status"
    ) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "1");
      json(res, { ok: false, ready: false, draining: true }, 503);
      return;
    }

    if (!rateLimit(req)) {
      res.writeHead(429, securityHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ error: "Rate limited" }));
      return;
    }

    if (url.pathname === "/api/status") {
      const runtime = readiness();
      json(res, {
        name: "GrokHack MMO",
        ready: runtime.ready,
        draining: state.draining,
        productionSafe: runtime.productionSafe,
        processUptimeMs: Date.now() - processStartedAt,
        releaseSha: process.env.GROKHACK_RELEASE_SHA || "local",
        ...world.getStats(),
        bridges: getBridgeStatus(),
        discord: getDiscordBotStatus(),
        x: getXLinkStatus(),
        compute: getComputePool().getMetrics(),
        revenue: revenueSummary(),
        agent_docs: "/api/agent",
        mcp_docs: "/api/mcp",
        store_docs: "/api/store",
        skill_gate: "/skill",
        compute_docs: "/api/compute",
        machine_docs: {
          skill: "/skill",
          skill_json: "/api/skill",
          llms_txt: "/llms.txt",
          agents_md: "/agents.md",
          play_txt: "/play.txt",
          plain_index: "/txt",
          gemtext: "/index.gmi",
          rss: "/feed.xml",
          health: "/health",
          store: "/api/store",
        },
      }, runtime.ready ? 200 : 503);
      return;
    }

    if (url.pathname === "/live") {
      json(res, {
        ok: true,
        processUptimeMs: Date.now() - processStartedAt,
        releaseSha: process.env.GROKHACK_RELEASE_SHA || "local",
      });
      return;
    }

    if (url.pathname === "/ready") {
      const runtime = readiness();
      json(
        res,
        {
          ok: runtime.ready,
          ready: runtime.ready,
          draining: state.draining,
          persistence: isPersistenceReady(),
          productionSafe: runtime.productionSafe,
          schemaVersion: SCHEMA_VERSION,
          releaseSha: process.env.GROKHACK_RELEASE_SHA || "local",
        },
        runtime.ready ? 200 : 503,
      );
      return;
    }

    // Agent skill gate — straight to MCP/play (no human marketing fluff)
    if (url.pathname === "/skill" || url.pathname === "/skill/" || url.pathname === "/SKILL.md") {
      const skillPath = path.join(PUBLIC_DIR, "skill.md");
      if (fs.existsSync(skillPath)) {
        res.writeHead(
          200,
          securityHeaders({
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "public, max-age=60",
            "X-Robots-Tag": "all",
            Link: '</api/skill>; rel="alternate"; type="application/json"',
          })
        );
        res.end(fs.readFileSync(skillPath));
        return;
      }
    }

    if (url.pathname === "/api/skill") {
      const mcpEnv = {
        GROKHACK_URL: "wss://grokhack.mondello.dev/ws",
        GROKHACK_HTTP: "https://grokhack.mondello.dev",
      };
      const serverBlock = {
        command: "node",
        args: ["mcp/dist/index.js"],
        env: mcpEnv,
      };
      json(res, {
        name: "grokhack-skill",
        title: "GrokHack — play now (agent gate)",
        description:
          "Install MCP or open WebSocket. Same dungeon as humans. Optional x402 cosmetics/tips at /api/store.",
        gate: true,
        free_to_play: true,
        pay_to_win: false,
        start_here: [
          "1. GET /api/mcp for cursor_config",
          "2. grokhack_join { name }",
          "3. grokhack_look then grokhack_action { key: \"l\" }",
          "Optional: POST /api/store/unlock for cosmetics via x402 USDC",
        ],
        links: {
          skill_md: "https://grokhack.mondello.dev/skill",
          mcp: "https://grokhack.mondello.dev/api/mcp",
          mcp_html: "https://grokhack.mondello.dev/mcp.html",
          agent: "https://grokhack.mondello.dev/api/agent",
          agents_md: "https://grokhack.mondello.dev/agents.md",
          llms: "https://grokhack.mondello.dev/llms.txt",
          ws: "wss://grokhack.mondello.dev/ws",
          play: "https://grokhack.mondello.dev/play.html",
          store: "https://grokhack.mondello.dev/api/store",
        },
        cursor_config: { mcpServers: { grokhack: serverBlock } },
        quick_ws: {
          join: { type: "join", name: "YourAgent", kind: "agent" },
          move: { type: "input", key: "l" },
        },
        store: {
          payment: "x402",
          catalog: "/api/store",
          unlock: "POST /api/store/unlock",
        },
      });
      return;
    }

    if (url.pathname === "/api/compute") {
      json(res, {
        ...COMPUTE_PROTOCOL_DOCS,
        live: getComputePool().getMetrics(),
      });
      return;
    }

    // Lightweight liveness for probes / agents (also ?format=json)
    if (url.pathname === "/health") {
      const stats = world.getStats();
      const bridges = getBridgeStatus();
      const runtime = readiness();
      if (url.searchParams.get("format") === "json") {
        json(res, {
          ok: true,
          ready: runtime.ready,
          draining: state.draining,
          online: stats.onlinePlayers,
          processUptimeMs: Date.now() - processStartedAt,
          worldUptimeMs: stats.uptimeMs,
          // Backward-compatible alias; callers should migrate to worldUptimeMs.
          uptimeMs: stats.uptimeMs,
          uptimeKind: "world",
          irc: bridges.irc?.connected ?? false,
          persistence: isPersistenceReady(),
          productionSafe: runtime.productionSafe,
          schemaVersion: SCHEMA_VERSION,
          releaseSha: process.env.GROKHACK_RELEASE_SHA || "local",
          nodeVersion: process.version,
        });
        return;
      }
      plain(
        res,
        `ok ready=${runtime.ready} online=${stats.onlinePlayers} process_uptime_ms=${Date.now() - processStartedAt} world_uptime_ms=${stats.uptimeMs} irc=${bridges.irc?.connected ? "up" : "down"}\n`
      );
      return;
    }

    // Plain-text endpoint index (low-bandwidth / agent discovery)
    if (url.pathname === "/txt" || url.pathname === "/txt/") {
      plain(res, LOWNET_TXT_INDEX);
      return;
    }

    // RSS — recent runs + static discovery entries (agents, humans, lownet)
    if (url.pathname === "/feed.xml" || url.pathname === "/rss.xml") {
      const recent = getRecentRuns(25);
      const now = new Date().toUTCString();
      const items: string[] = [];
      items.push(`    <item>
      <title>GrokHack — multiplayer NetHack MMO (agents welcome)</title>
      <link>https://grokhack.mondello.dev/</link>
      <guid isPermaLink="true">https://grokhack.mondello.dev/</guid>
      <description>Free open-source multiplayer roguelike. Browser, telnet, MCP, WebSocket agents.</description>
      <pubDate>${now}</pubDate>
    </item>`);
      items.push(`    <item>
      <title>Join as AI agent — MCP / WebSocket</title>
      <link>https://grokhack.mondello.dev/agents.md</link>
      <guid isPermaLink="true">https://grokhack.mondello.dev/agents.md</guid>
      <description>Machine join guide. wss://grokhack.mondello.dev/ws · GET /api/agent · GET /api/mcp</description>
      <pubDate>${now}</pubDate>
    </item>`);
      for (const r of recent) {
        const name = escapeXml(r.name || "adventurer");
        const depth = r.depth ?? 0;
        const kind = r.kind ?? "human";
        const score = r.score ?? 0;
        const at = r.at || new Date().toISOString();
        const pub = new Date(at).toUTCString();
        const title = escapeXml(`${name} (${kind}) depth ${depth} score ${score}`);
        const link = `https://grokhack.mondello.dev/leaderboard.html`;
        const guid = escapeXml(`grokhack-run-${name}-${depth}-${score}-${at}`);
        items.push(`    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${guid}</guid>
      <description>${title}</description>
      <pubDate>${pub}</pubDate>
    </item>`);
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>GrokHack</title>
    <link>https://grokhack.mondello.dev/</link>
    <description>Multiplayer NetHack-style MMO — recent runs, agent join links</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>
`;
      res.writeHead(
        200,
        securityHeaders({
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "public, max-age=60, must-revalidate",
        })
      );
      res.end(xml);
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

    // X (Twitter) account link — same UX as Discord /link + :verify (code MVP; OAuth later)
    if (url.pathname === "/api/x" || url.pathname === "/api/x/status") {
      const name = url.searchParams.get("name") || undefined;
      json(res, getXLinkStatus(name || undefined));
      return;
    }

    if (url.pathname === "/api/x/handle" && req.method === "GET") {
      const name = (url.searchParams.get("name") || "").trim();
      if (!name) {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "name required" }));
        return;
      }
      const handle = getLinkedXHandle(name);
      json(res, {
        ok: true,
        gameName: name,
        xHandle: handle,
        display: handle ? formatXHandle(handle) : null,
      });
      return;
    }

    if (url.pathname === "/api/x/link" && req.method === "POST") {
      if (!rateLimitScoped("x-link", req, 10, 60_000)) {
        res.writeHead(429, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "Slow down." }));
        return;
      }
      try {
        const body = await readBody(req, 2048);
        const data = JSON.parse(body) as Record<string, unknown>;
        const xHandle = String(data.xHandle || data.handle || "");
        const gameName = String(data.gameName || data.name || "");
        const result = createXLinkCode(xHandle, gameName);
        if (!result.ok) {
          res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
          res.end(JSON.stringify(result));
          return;
        }
        json(res, {
          ok: true,
          code: result.entry.code,
          xHandle: result.entry.xHandle,
          display: formatXHandle(result.entry.xHandle),
          gameName: result.entry.gameName,
          expiresAt: result.entry.expiresAt,
          verify: `:verify ${result.entry.code}`,
          instructions: [
            `Join as \`${result.entry.gameName}\` on play.html (or telnet)`,
            `In-game type: :verify ${result.entry.code}`,
            "Code expires in 15 minutes.",
          ],
        });
      } catch {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "Bad request" }));
      }
      return;
    }

    if (url.pathname === "/api/discord/setup" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const result = await retryDiscordSetup();
      json(res, result);
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

    // —— Revenue store (x402) ——
    if (url.pathname === "/api/store" && req.method === "GET") {
      json(res, {
        name: "GrokHack Store",
        policy: "cosmetics_and_tips_only",
        pay_to_win: false,
        payment: "x402",
        network: "Base (eip155:8453)",
        asset: "USDC",
        configured: x402Configured(),
        revenue: revenueSummary(),
        products: listProducts().map((p) => ({
          ...p,
          creditPrice: CREDIT_PRICES[p.sku] ?? null,
        })),
        unlock: "POST /api/store/unlock { sku, playerName } with PAYMENT-SIGNATURE",
        redeem_credits: "POST /api/credits/redeem { playerName, sku, resumeToken }",
        entitlements: "GET /api/store/entitlements?player=Name",
        human_ui: "/store.html",
      });
      return;
    }

    if (url.pathname === "/api/credits" && req.method === "GET") {
      if (url.searchParams.get("docs") === "1") {
        json(res, creditsDocs());
        return;
      }
      const player = String(url.searchParams.get("player") || "").trim();
      if (!player) {
        json(res, { ...creditsDocs(), leaderboard: creditsLeaderboard(10) });
        return;
      }
      json(res, {
        player,
        account: getCredits(player),
        redeemable: CREDIT_PRICES,
        entitlements: getEntitlements(player),
      });
      return;
    }

    if (url.pathname === "/api/credits/leaderboard" && req.method === "GET") {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
      json(res, {
        name: "Compute Credits leaderboard",
        unit: "credits (1 validated job = 1 credit)",
        token: false,
        entries: creditsLeaderboard(limit),
      });
      return;
    }

    if (url.pathname === "/api/credits/redeem" && req.method === "POST") {
      if (!rateLimitScoped("credits-redeem", req, 20, 60_000)) {
        json(res, { error: "Rate limited" }, 429);
        return;
      }
      try {
        const raw = await readBody(req, 2048);
        const body = JSON.parse(raw || "{}") as {
          playerName?: string;
          player?: string;
          sku?: string;
          resumeToken?: string;
        };
        const playerName = String(body.playerName || body.player || "").trim();
        const sku = String(body.sku || "").trim();
        if (!playerName || !sku) {
          json(res, { error: "playerName and sku required" }, 400);
          return;
        }
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(playerName)) {
          json(res, { error: "invalid_player_name" }, 400);
          return;
        }
        const headerToken = req.headers["x-grokhack-resume-token"];
        const presentedToken = String(
          body.resumeToken || (Array.isArray(headerToken) ? headerToken[0] : headerToken) || ""
        );
        if (verifyResumeToken(playerName, presentedToken) !== "ok") {
          json(res, { error: "character_auth_required" }, 401);
          return;
        }
        const result = redeemWithCredits(playerName, sku);
        if (!result.ok) {
          json(res, result, result.error === "insufficient_credits" ? 402 : 400);
          return;
        }
        json(res, {
          ...result,
          message: `Redeemed ${result.product} for ${result.account.playerName} with compute credits.`,
        });
        return;
      } catch (err) {
        json(res, { error: "Bad request", detail: String(err instanceof Error ? err.message : err) }, 400);
        return;
      }
    }

    if (url.pathname === "/api/store/entitlements" && req.method === "GET") {
      const player = String(url.searchParams.get("player") || "").trim();
      if (!player) {
        json(res, { error: "player query required" }, 400);
        return;
      }
      json(res, { player, entitlements: getEntitlements(player) });
      return;
    }

    if (url.pathname === "/api/store/unlock" && req.method === "POST") {
      if (!rateLimitScoped("store-unlock", req, 30, 60_000)) {
        json(res, { error: "Rate limited" }, 429);
        return;
      }
      try {
        const raw = await readBody(req, 4096);
        const body = JSON.parse(raw || "{}") as {
          sku?: string;
          playerName?: string;
          player?: string;
        };
        const sku = String(body.sku || "").trim() as ProductSku;
        const playerName = String(body.playerName || body.player || "").trim();
        const product = getProduct(sku);
        if (!product) {
          json(res, { error: "Unknown sku", products: listProducts().map((p) => p.sku) }, 400);
          return;
        }
        const safe = assertProductSafe(product);
        if (!safe.ok) {
          json(res, { error: "SKU not sellable", reason: safe.reason }, 400);
          return;
        }
        if (!playerName || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(playerName)) {
          json(res, { error: "Valid playerName required (game character name)" }, 400);
          return;
        }

        const verified = await verifyX402Payment(req, product);
        if (!verified.ok) {
          if (verified.failureKind === "payment_required") {
            const challenge = buildPaymentRequired(product);
            res.writeHead(
              402,
              securityHeaders({
                "Content-Type": "application/json",
                "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, X-PAYMENT",
              })
            );
            res.end(JSON.stringify({ ...challenge, playerName, reason: verified.reason }));
            return;
          }
          const status =
            verified.failureKind === "configuration" || verified.failureKind === "upstream"
              ? 503
              : 402;
          json(
            res,
            {
              error: "Payment verification failed",
              reason: verified.reason,
              retryable: verified.retryable === true,
            },
            status,
          );
          return;
        }

        // Replay protection: same PAYMENT-SIGNATURE cannot unlock twice
        const fp = verified.paymentFingerprint;
        if (!fp) {
          json(res, { error: "Payment verification failed", reason: "missing_payment_fingerprint" }, 402);
          return;
        }
        const claim = claimPaymentFingerprint(fp, {
          sku: product.sku,
          playerName,
          payer: verified.payer,
        });
        if (!claim.ok) {
          json(
            res,
            {
              error: claim.reason === "replay" ? "Payment already used" : "Invalid payment fingerprint",
              reason: claim.reason,
            },
            claim.reason === "replay" ? 409 : 400
          );
          return;
        }

        const entitlements = grantPurchase(playerName, product, {
          txHint: verified.txHint,
          payer: verified.payer,
        });
        json(res, {
          ok: true,
          sku: product.sku,
          playerName,
          grants: product.grants,
          entitlements,
          message: `Unlocked ${product.name} for ${playerName}. Thank you — no pay-to-win, ever.`,
        });
        return;
      } catch (err) {
        json(res, { error: "Bad request", detail: String(err instanceof Error ? err.message : err) }, 400);
        return;
      }
    }

    if (url.pathname === "/api/mcp") {
      const mcpEnv = {
        GROKHACK_URL: "wss://grokhack.mondello.dev/ws",
        GROKHACK_HTTP: "https://grokhack.mondello.dev",
      };
      const tools = [
        "grokhack_status",
        "grokhack_docs",
        "grokhack_join",
        "grokhack_reconnect",
        "grokhack_observe",
        "grokhack_look",
        "grokhack_action",
        "grokhack_chat",
        "grokhack_social",
        "grokhack_who",
        "grokhack_wall",
        "grokhack_leaderboard",
      ];
      const serverBlock = {
        command: "node",
        args: ["mcp/dist/index.js"],
        env: mcpEnv,
      };
      json(res, {
        name: "grokhack",
        package: "@grokhack/mcp",
        install: "npx @grokhack/mcp",
        repo: "https://github.com/integrate-your-mind/grokhack",
        repo_path: "mcp/",
        // Agent acquisition pitch (free WS + MCP, same rules, leaderboard)
        pitch:
          "Free multiplayer NetHack for AI agents — open WebSocket or MCP, same dungeon as humans, real leaderboard. No auth.",
        one_liner:
          "Free multiplayer NetHack for AI agents — WebSocket or MCP, same dungeon as humans, real leaderboard.",
        free: true,
        auth: "none",
        same_rules_as_humans: true,
        leaderboard: "https://grokhack.mondello.dev/leaderboard.html",
        leaderboard_agents: "https://grokhack.mondello.dev/leaderboard.html?kind=agent",
        play: "https://grokhack.mondello.dev/play.html?ref=mcp",
        mcp_html: "https://grokhack.mondello.dev/mcp.html?ref=mcp",
        pitch_pack: "https://grokhack.mondello.dev/agents.md",
        endpoint: "wss://grokhack.mondello.dev/ws",
        http_base: "https://grokhack.mondello.dev",
        agent_docs: "/api/agent",
        machine_docs: "/agents.md",
        zero_friction: [
          "git clone && npm install && npm run mcp:build",
          "Point MCP at absolute path: node /abs/path/mcp/dist/index.js",
          "Or raw WS: wss://grokhack.mondello.dev/ws + join kind=agent",
          "curl -sS https://grokhack.mondello.dev/api/mcp | jq .cursor_config",
        ],
        tools,
        tool_flow: [
          "grokhack_status",
          "grokhack_join",
          "grokhack_look",
          "grokhack_action",
          "grokhack_chat",
        ],
        cursor_config: { mcpServers: { grokhack: serverBlock } },
        claude_desktop_config: { mcpServers: { grokhack: serverBlock } },
        local_env: {
          GROKHACK_URL: "ws://127.0.0.1:8080/ws",
          GROKHACK_HTTP: "http://127.0.0.1:8080",
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
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        json(res, { error: "method_not_allowed" }, 405);
        return;
      }
      const encodedName = url.pathname.slice("/api/social/profile/".length);
      if (!encodedName || encodedName.includes("/")) {
        json(res, { error: "Profile not found" }, 404);
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent(encodedName);
      } catch {
        json(res, { error: "Malformed profile name" }, 400);
        return;
      }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(name)) {
        json(res, { error: "Invalid profile name" }, 400);
        return;
      }
      const snap = getPublicSocialProfile(name);
      if (!snap) {
        json(res, { error: "Profile not found" }, 404);
        return;
      }
      json(res, snap);
      return;
    }

    if (url.pathname === "/api/presence") {
      json(res, world.getPresence());
      return;
    }

    if (url.pathname === "/api/audit/client-error" && req.method === "POST") {
      try {
        const body = await readBody(req, 8192);
        const data = JSON.parse(body) as {
          sessionId?: string;
          message?: string;
          context?: string;
          stack?: string;
          breadcrumbs?: string[];
          url?: string;
        };
        const sid = String(data.sessionId || "unknown").slice(0, 64);
        const msg = String(data.message || "").slice(0, 500);
        logEvent("client_error", sid, {
          detail: {
            message: msg,
            context: String(data.context || "").slice(0, 100),
            stack: String(data.stack || "").slice(0, 800),
            breadcrumbs: (data.breadcrumbs || []).slice(0, 20).map((b) => String(b).slice(0, 80)),
            url: String(data.url || "").slice(0, 200),
          },
        });
        bumpMetric(sid, "errors");
        json(res, { ok: true });
      } catch {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "Bad request" }));
      }
      return;
    }

    if (url.pathname === "/api/feedback" && req.method === "GET") {
      json(res, { categories: FEEDBACK_CATEGORIES });
      return;
    }

    if (url.pathname === "/api/feedback" && req.method === "POST") {
      if (!rateLimitScoped("feedback-burst", req, 10, 60_000)) {
        res.writeHead(429, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "Slow down." }));
        return;
      }
      try {
        const body = await readBody(req, 4096);
        const data = JSON.parse(body) as Record<string, unknown>;
        const result = submitFeedback(req, {
          category: String(data.category || ""),
          message: String(data.message || ""),
          contact: String(data.contact || ""),
          playerName: String(data.playerName || ""),
          sessionId: String(data.sessionId || ""),
          page: String(data.page || ""),
          website: String(data.website || ""),
          _ts: typeof data._ts === "number" ? data._ts : undefined,
        });
        if (!result.ok) {
          const status = result.code === "rate_limit" ? 429 : 400;
          res.writeHead(status, securityHeaders({ "Content-Type": "application/json" }));
          res.end(JSON.stringify(result));
          return;
        }
        json(res, result);
      } catch {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "Bad request" }));
      }
      return;
    }

    if (url.pathname === "/api/feedback/list") {
      if (!requireAdmin(req, res)) return;
      const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10) || 50);
      json(res, { feedback: listFeedback(limit) });
      return;
    }

    if (url.pathname === "/api/telemetry" && req.method === "POST") {
      try {
        const body = await readBody(req, 16_384);
        const data = JSON.parse(body) as {
          sessionId?: string;
          events?: { event: string; detail?: Record<string, unknown>; at?: string }[];
        };
        const sid = String(data.sessionId || "unknown").slice(0, 64);
        const n = ingestClientTelemetry(sid, data.events || []);
        bumpMetric(sid, "clientEventCount", n);
        json(res, { ok: true, ingested: n });
      } catch {
        res.writeHead(400, securityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "Bad request" }));
      }
      return;
    }

    if (url.pathname === "/api/audit/recent") {
      if (!requireAdmin(req, res)) return;
      const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10) || 100);
      json(res, { events: getRecentEvents(limit) });
      return;
    }

    if (url.pathname === "/api/audit/stats") {
      if (!requireAdmin(req, res)) return;
      const days = Math.min(30, parseInt(url.searchParams.get("days") || "7", 10) || 7);
      json(res, getAuditStats(days));
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

    // Never let CDNs cache 404s (stale robots.txt 404 blocked crawl policy for hours)
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
    });
    res.end("Not found");
  });

  state.webSockets = attachWebSocket(server, world, webSocketOptions, () => state.draining);
  httpDrainStates.set(server, state);

  server.listen(port, BIND_HOST, () => {
    console.log(`[http] http://${BIND_HOST}:${port}`);
  });

  return server;
}

export function beginHttpDrain(server: http.Server): DrainHandle {
  const state = httpDrainStates.get(server);
  if (!state) throw new Error("HTTP server is not managed by startHttpServer");
  if (state.handle) return state.handle;

  state.draining = true;
  const httpClosed = new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
  const webSocketsClosed = state.webSockets.beginDrain();
  const drained = Promise.all([httpClosed, webSocketsClosed]).then(() => undefined);
  state.handle = {
    drained,
    forceClose(): void {
      state.webSockets.forceClose();
      server.closeAllConnections?.();
    },
  };
  return state.handle;
}
