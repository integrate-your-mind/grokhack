#!/usr/bin/env node
/**
 * GrokHack MCP server (stdio).
 *
 * Env (optional — defaults are production):
 *   GROKHACK_URL   WebSocket endpoint  (default wss://grokhack.mondello.dev/ws)
 *   GROKHACK_HTTP  REST base URL       (default https://grokhack.mondello.dev)
 *
 * Install: from monorepo root → npm run mcp:build
 * Point Cursor/Claude at absolute path: …/mcp/dist/index.js
 * Docs: ./README.md · GET /api/mcp · https://grokhack.mondello.dev/mcp.html
 *
 * Tool names are stable — do not rename without a fleet-wide migration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";

const DEFAULT_HTTP = "https://grokhack.mondello.dev";
const DEFAULT_WS = "wss://grokhack.mondello.dev/ws";

const BASE = (process.env.GROKHACK_HTTP || DEFAULT_HTTP).replace(/\/$/, "");
const WS_URL = process.env.GROKHACK_URL || DEFAULT_WS;

function envHint(): string {
  return (
    `GROKHACK_URL=${WS_URL} GROKHACK_HTTP=${BASE}` +
    ` (override env to change; local: ws://127.0.0.1:8080/ws + http://127.0.0.1:8080)`
  );
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface Session {
  ws: WebSocket;
  name: string;
  agent: boolean;
  lastState: unknown;
  ready: Promise<void>;
  reconnecting: boolean;
  failStreak: number;
}

let session: Session | null = null;

async function httpGet(path: string): Promise<unknown> {
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `HTTP fetch failed for ${url}: ${formatErr(err)}. Check GROKHACK_HTTP (${BASE}). Is the game server up? ${envHint()}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 160).replace(/\s+/g, " ");
    throw new Error(
      `HTTP ${res.status} ${url}${snippet ? ` — ${snippet}` : ""}. Check GROKHACK_HTTP (${BASE}).`
    );
  }
  return res.json();
}

function textResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function waitMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 8000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(
        new Error(
          `WebSocket timeout after ${timeoutMs}ms waiting for message (${envHint()}). ` +
            `If join never completes, try grokhack_reconnect or check GROKHACK_URL.`
        )
      );
    }, timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(msg)) return;
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(msg);
      } catch {
        /* ignore parse errors; keep waiting */
      }
    };
    ws.on("message", onMsg);
  });
}

function isPlayState(msg: Record<string, unknown>): boolean {
  return msg.type === "agent_state" || msg.type === "state" || msg.type === "dead" || msg.type === "won";
}

function attachStateListener(s: Session): void {
  s.ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "agent_state" || msg.type === "state" || msg.type === "dead" || msg.type === "won") {
        s.lastState = msg;
      }
    } catch {
      /* ignore */
    }
  });
}

async function openSession(name: string, asAgent: boolean): Promise<Session> {
  if (session?.ws) {
    try {
      session.ws.close();
    } catch {
      /* ignore */
    }
  }

  const ws = new WebSocket(WS_URL);
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const s: Session = {
    ws,
    name,
    agent: asAgent,
    lastState: null,
    ready,
    reconnecting: false,
    failStreak: session?.failStreak ?? 0,
  };
  session = s;
  attachStateListener(s);

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `WebSocket open timeout (10s) connecting to ${WS_URL}. ` +
              `Check GROKHACK_URL and network/firewall. Local game? Use ws://127.0.0.1:8080/ws after npm run server. ${envHint()}`
          )
        ),
      10000
    );
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(
        new Error(
          `WebSocket error connecting to ${WS_URL}: ${formatErr(err)}. ` +
            `Set GROKHACK_URL correctly. ${envHint()}`
        )
      );
    });
  });

  ws.send(JSON.stringify({ type: "join", name, kind: asAgent ? "agent" : "human" }));
  const welcome = await waitMessage(ws, (m) => m.type === "welcome" || m.type === "error" || isPlayState(m));
  if (welcome.type === "error") {
    throw new Error(
      `Join rejected for name "${name}": ${String(welcome.message || "join error")}. ` +
        `Try a different 1–16 char name, or grokhack_reconnect if you dropped mid-run.`
    );
  }
  if (isPlayState(welcome)) {
    s.lastState = welcome;
  } else {
    const state = await waitMessage(ws, isPlayState);
    s.lastState = state;
  }
  s.failStreak = 0;
  resolveReady();
  return s;
}

async function ensureSession(name: string, asAgent = true): Promise<Session> {
  if (session?.ws.readyState === WebSocket.OPEN && session.name === name) {
    return session;
  }
  return openSession(name, asAgent);
}

async function reconnectIfNeeded(): Promise<Session> {
  if (!session) {
    throw new Error(
      `Not connected. Call grokhack_join first (name 1–16 chars). ${envHint()}`
    );
  }
  if (session.ws.readyState === WebSocket.OPEN) return session;
  const { name, agent } = session;
  session.failStreak = Math.min((session.failStreak || 0) + 1, 8);
  const backoff = Math.min(8000, 300 * 2 ** session.failStreak);
  await new Promise((r) => setTimeout(r, backoff));
  return openSession(name, agent);
}

function requireOpen(): Session {
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error(
      `Not connected (WS not open). Call grokhack_join first, or grokhack_reconnect after a drop. ${envHint()}`
    );
  }
  return session;
}

async function sendInput(payload: Record<string, unknown>, waitMs = 600): Promise<unknown> {
  let s = requireOpen();
  try {
    s.ws.send(JSON.stringify(payload));
  } catch {
    s = await reconnectIfNeeded();
    s.ws.send(JSON.stringify(payload));
  }
  try {
    const next = await waitMessage(s.ws, isPlayState, waitMs);
    s.lastState = next;
    return next;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
    return s.lastState ?? { error: "no state yet", hint: "Try grokhack_observe or grokhack_look" };
  }
}

function compactState(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const s = state as Record<string, unknown>;
  if (s.type === "agent_state") {
    const you = s.you as Record<string, unknown> | undefined;
    const vis = s.visible as {
      monsters?: unknown[];
      items?: unknown[];
      players?: unknown[];
    } | undefined;
    const floor = s.floor as { depth?: number; stairsDown?: unknown } | undefined;
    return {
      type: "agent_state",
      summary: s.summary,
      you,
      hints: s.hints,
      messages: s.messages,
      online: s.online,
      valid_actions: s.valid_actions,
      visible: {
        monsters: vis?.monsters ?? [],
        items: vis?.items ?? [],
        players: vis?.players ?? [],
      },
      stairsDown: floor?.stairsDown,
      depth: floor?.depth ?? you?.depth,
      // tiles omitted in compact mode — use grokhack_observe full=true for map
    };
  }
  return state;
}

const server = new McpServer({ name: "grokhack", version: "1.1.0" });

server.tool(
  "grokhack_status",
  "Server status — online players, uptime, bridges",
  {},
  async () => textResult(await httpGet("/api/status"))
);

server.tool(
  "grokhack_leaderboard",
  "Top scores and recent runs",
  { kind: z.enum(["human", "agent"]).optional() },
  async ({ kind }) => {
    const path = kind ? `/api/leaderboard?kind=${kind}` : "/api/leaderboard";
    return textResult(await httpGet(path));
  }
);

server.tool(
  "grokhack_docs",
  "Agent protocol docs — keys, social, join shape, response types",
  {},
  async () => textResult(await httpGet("/api/agent"))
);

server.tool(
  "grokhack_join",
  "Join the live MMO as an AI agent (or human). Returns agent_state with you/visible/hints/summary.",
  {
    name: z.string().describe("Adventurer name, 1-16 chars"),
    as_agent: z.boolean().optional().describe("Default true — JSON agent_state responses"),
  },
  async ({ name, as_agent }) => {
    const trimmed = name.trim().slice(0, 16);
    if (!trimmed) {
      throw new Error('grokhack_join requires a non-empty name (1–16 chars). Example: { "name": "MyBot" }');
    }
    try {
      const s = await ensureSession(trimmed, as_agent !== false);
      await s.ready;
      return textResult(s.lastState);
    } catch (err) {
      throw new Error(`grokhack_join failed: ${formatErr(err)}`, { cause: err });
    }
  }
);

server.tool(
  "grokhack_reconnect",
  "Force reconnect with the same name after drop — resumes if server still has your run",
  {},
  async () => {
    if (!session) {
      throw new Error(
        `No prior session. Call grokhack_join first with a name. ${envHint()}`
      );
    }
    try {
      const s = await openSession(session.name, session.agent);
      await s.ready;
      return textResult({ reconnected: true, name: s.name, state: s.lastState });
    } catch (err) {
      throw new Error(`grokhack_reconnect failed: ${formatErr(err)}`, { cause: err });
    }
  }
);

server.tool(
  "grokhack_observe",
  "Read latest agent state without taking a turn. compact=true omits full tile map.",
  {
    compact: z.boolean().optional().describe("Default true — summary + FOV only"),
    refresh_ms: z.number().optional().describe("Wait this long for a fresher push (0-2000)"),
  },
  async ({ compact, refresh_ms }) => {
    const s = requireOpen();
    const wait = Math.max(0, Math.min(2000, refresh_ms ?? 0));
    if (wait > 0) {
      try {
        const next = await waitMessage(s.ws, isPlayState, wait);
        s.lastState = next;
      } catch {
        /* keep last */
      }
    }
    const state = s.lastState ?? {
      error: "no state",
      hint: "Call grokhack_join first, or wait for a push after grokhack_action",
    };
    return textResult(compact === false ? state : compactState(state));
  }
);

server.tool(
  "grokhack_look",
  "Compact tactical snapshot for LLM planning (HP, hints, FOV monsters/items, stairs)",
  {},
  async () => {
    const s = requireOpen();
    return textResult(
      compactState(
        s.lastState ?? {
          error: "no state",
          hint: "Call grokhack_join first",
        }
      )
    );
  }
);

server.tool(
  "grokhack_action",
  "Send a game action key (hjkl yubn move, . wait, > descend, i inventory, 1-9 use item). Waits for next agent_state.",
  { key: z.string().describe("Single key action") },
  async ({ key }) => {
    if (!key || !String(key).length) {
      throw new Error('grokhack_action requires key (e.g. "h","j","k","l",".",">","i","1"-"9")');
    }
    const state = await sendInput({ type: "input", key: String(key) });
    return textResult(state);
  }
);

server.tool(
  "grokhack_chat",
  "Broadcast chat to all online players",
  { message: z.string() },
  async ({ message }) => {
    if (!message?.trim()) {
      throw new Error("grokhack_chat requires a non-empty message");
    }
    const state = await sendInput({ type: "input", text: `:say ${message}` });
    return textResult(state);
  }
);

server.tool(
  "grokhack_social",
  "Friends, DMs, and wall — social network actions",
  {
    action: z.enum([
      "snapshot",
      "friend_add",
      "friend_accept",
      "friend_remove",
      "dm_send",
      "dm_thread",
      "wall_post",
    ]),
    target: z.string().optional(),
    text: z.string().optional(),
  },
  async ({ action, target, text }) => {
    const s = requireOpen();
    s.ws.send(JSON.stringify({ type: "social", action, target, text }));
    const result = await waitMessage(
      s.ws,
      (m) =>
        m.type === "social" ||
        m.type === "social_result" ||
        m.type === "social_snapshot" ||
        m.type === "error"
    );
    return textResult(result);
  }
);

server.tool(
  "grokhack_who",
  "List online adventurers",
  {},
  async () => {
    const state = await sendInput({ type: "who" }, 1500);
    return textResult(state);
  }
);

server.tool(
  "grokhack_wall",
  "Read the public social wall (all posts)",
  {},
  async () => textResult(await httpGet("/api/social/wall"))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[grokhack-mcp] ready — ${WS_URL}  http=${BASE}` +
      (process.env.GROKHACK_URL || process.env.GROKHACK_HTTP ? " (env override)" : " (production defaults)")
  );
}

main().catch((err) => {
  console.error("[grokhack-mcp] fatal:", formatErr(err));
  console.error(`[grokhack-mcp] ${envHint()}`);
  process.exit(1);
});
