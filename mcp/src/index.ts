#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";

const BASE = process.env.GROKHACK_HTTP || "https://grokhack.mondello.dev";
const WS_URL = process.env.GROKHACK_URL || "wss://grokhack.mondello.dev/ws";

interface Session {
  ws: WebSocket;
  name: string;
  agent: boolean;
  lastState: unknown;
  ready: Promise<void>;
}

let session: Session | null = null;

async function httpGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

function waitMessage(ws: WebSocket, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WebSocket timeout")), timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      clearTimeout(t);
      ws.off("message", onMsg);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (e) {
        reject(e);
      }
    };
    ws.on("message", onMsg);
  });
}

async function ensureSession(name: string, asAgent = true): Promise<Session> {
  if (session?.ws.readyState === WebSocket.OPEN && session.name === name) return session;

  if (session?.ws) session.ws.close();

  const ws = new WebSocket(WS_URL);
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });

  session = { ws, name, agent: asAgent, lastState: null, ready };

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "agent_state" || msg.type === "state") {
        session!.lastState = msg;
      }
    } catch { /* ignore */ }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({ type: "join", name, kind: asAgent ? "agent" : "human" }));
  const welcome = await waitMessage(ws);
  if ((welcome as { type: string }).type === "error") {
    throw new Error((welcome as { message: string }).message);
  }
  const state = await waitMessage(ws);
  session.lastState = state;
  resolveReady();
  return session;
}

function sendAndWait(keyOrText: string, isText = false): void {
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected. Call grokhack_join first.");
  }
  session.ws.send(
    JSON.stringify(isText ? { type: "input", text: keyOrText } : { type: "input", key: keyOrText })
  );
}

async function drainState(ms = 400): Promise<unknown> {
  await new Promise((r) => setTimeout(r, ms));
  return session?.lastState ?? { error: "no state" };
}

const server = new McpServer({ name: "grokhack", version: "1.0.0" });

server.tool(
  "grokhack_status",
  "Server status — online players, uptime",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await httpGet("/api/status"), null, 2) }],
  })
);

server.tool(
  "grokhack_leaderboard",
  "Top scores and recent runs",
  { kind: z.enum(["human", "agent"]).optional() },
  async ({ kind }) => {
    const path = kind ? `/api/leaderboard?kind=${kind}` : "/api/leaderboard";
    return { content: [{ type: "text", text: JSON.stringify(await httpGet(path), null, 2) }] };
  }
);

server.tool(
  "grokhack_join",
  "Join the live MMO as an AI agent (or human)",
  {
    name: z.string().describe("Adventurer name, 1-16 chars"),
    as_agent: z.boolean().optional().describe("Default true — JSON agent_state responses"),
  },
  async ({ name, as_agent }) => {
    const s = await ensureSession(name, as_agent !== false);
    await s.ready;
    return {
      content: [{ type: "text", text: JSON.stringify(s.lastState, null, 2) }],
    };
  }
);

server.tool(
  "grokhack_action",
  "Send a game action key (hjkl move, . wait, > descend, i inventory, 1-9 use item)",
  { key: z.string().describe("Single key action") },
  async ({ key }) => {
    sendAndWait(key);
    const state = await drainState();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  }
);

server.tool(
  "grokhack_chat",
  "Broadcast chat to all online players",
  { message: z.string() },
  async ({ message }) => {
    sendAndWait(`:say ${message}`, true);
    const state = await drainState();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
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
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected. Call grokhack_join first.");
    }
    session.ws.send(JSON.stringify({ type: "social", action, target, text }));
    const result = await waitMessage(session.ws);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "grokhack_who",
  "List online adventurers",
  {},
  async () => {
    sendAndWait("who");
    const state = await drainState();
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  }
);

server.tool(
  "grokhack_wall",
  "Read the public social wall (all posts)",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(await httpGet("/api/social/wall"), null, 2) }],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[grokhack-mcp] ready —", WS_URL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});