#!/usr/bin/env node
/**
 * Proof: kill WS → rejoin same name within grace → same depth/inventory.
 * Also proves concurrent same-name join never fails with "Name already in use".
 *
 * Usage: node scripts/prove-reconnect.mjs
 *        BOT_URL=ws://127.0.0.1:8080/ws node scripts/prove-reconnect.mjs
 */
import WebSocket from "ws";

const WS_URL =
  process.env.BOT_URL ||
  (process.env.QA_URL
    ? process.env.QA_URL.replace(/^http/, "ws") + "/ws"
    : "wss://grokhack.mondello.dev/ws");

const NAME = (process.env.PROOF_NAME || `Proof${Date.now().toString(36).slice(-6)}`).slice(0, 16);
const SESSION = crypto.randomUUID?.() || `proof-${Date.now()}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeState(msg) {
  if (msg.type === "state" && msg.player) return msg;
  if (msg.type === "agent_state" && msg.you) {
    return {
      type: "state",
      player: msg.you,
      floor: msg.floor,
      others: msg.visible?.players || [],
      online: msg.online,
    };
  }
  return null;
}

function waitForState(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for state")), timeoutMs);
    const onMsg = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const state = normalizeState(msg);
        if (state) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(state);
        }
        if (msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMsg);
          reject(new Error(msg.message || "join error"));
        }
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMsg);
  });
}

let resumeToken = null;

async function openJoin(label) {
  const ws = new WebSocket(WS_URL);
  // Listen before open so welcome/state never race past us
  const pending = waitForState(ws);
  let capturedToken = null;
  const onSnap = (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "social_snapshot" && msg.resumeToken) {
        capturedToken = msg.resumeToken;
        resumeToken = msg.resumeToken;
      }
    } catch {
      /* ignore */
    }
  };
  ws.on("message", onSnap);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("close", (code) => {
      if (code === 1008) reject(new Error("rate limited (1008) — wait 60s and retry"));
    });
  });
  ws.send(
    JSON.stringify({
      type: "join",
      name: NAME,
      sessionId: SESSION,
      resumeToken: resumeToken || undefined,
    })
  );
  const state = await pending;
  if (capturedToken) resumeToken = capturedToken;
  console.log(`[${label}] joined as ${NAME}`, {
    depth: state.player.depth,
    gold: state.player.gold,
    turns: state.player.turns,
    inventory: state.player.inventory?.length ?? 0,
    hp: state.player.hp,
    hasResumeToken: !!resumeToken,
  });
  return { ws, state };
}

async function main() {
  console.log(`[proof] target=${WS_URL} name=${NAME}`);

  // 1) Join, move, kill socket
  const first = await openJoin("join-1");
  first.ws.send(JSON.stringify({ type: "input", key: "l" }));
  first.ws.send(JSON.stringify({ type: "input", key: "." }));
  await sleep(400);
  // Refresh state snapshot after inputs if possible
  first.ws.send(JSON.stringify({ type: "ping" }));
  await sleep(200);
  first.ws.close();
  // Fast rejoin (within grace; also covers close-race)
  await sleep(250);

  const second = await openJoin("rejoin-grace");
  const a = first.state.player;
  const b = second.state.player;

  const checks = {
    notNameInUse: true,
    sameDepth: a.depth === b.depth,
    sameGold: a.gold === b.gold,
    sameInventoryCount: (a.inventory?.length ?? 0) === (b.inventory?.length ?? 0),
    turnsHeldOrAdvanced: b.turns >= a.turns,
    hpHeld: typeof b.hp === "number" && b.hp > 0,
  };

  // 2) Concurrent same-name while still connected — must supersede, not error
  let concurrentOk = false;
  try {
    const third = await openJoin("concurrent-same-name");
    concurrentOk = third.state.player?.name?.toLowerCase() === NAME.toLowerCase();
    third.ws.close();
  } catch (err) {
    if (/already in use/i.test(err.message)) {
      checks.notNameInUse = false;
      console.error("[proof] concurrent join failed with name collision:", err.message);
    } else {
      throw err;
    }
  }
  checks.concurrentResume = concurrentOk;

  console.log("[proof] resume checks:", checks);
  second.ws.close();

  const ok = Object.values(checks).every(Boolean);
  if (!ok) {
    console.error("[proof] FAILED — resume contract not satisfied");
    process.exit(1);
  }
  console.log("[proof] PASSED — kill WS + same-name rejoin restored depth/inventory; no name collision");
}

main().catch((err) => {
  console.error("[proof] error:", err.message);
  if (/already in use/i.test(err.message)) {
    console.error("[proof] FAILED — Name already in use (resume-by-name broken)");
  }
  process.exit(1);
});
