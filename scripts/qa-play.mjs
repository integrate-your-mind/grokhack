#!/usr/bin/env node
/**
 * WebSocket QA — verifies all player controls respond without error.
 */
import WebSocket from "ws";

const BASE = process.env.QA_URL || "http://127.0.0.1:8080";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const NAME = `QA${Date.now().toString(36).slice(-6)}`;

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name}: ${detail}`);
}

function waitMsg(ws, pred, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeout);
    const onMsg = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (pred(msg)) {
          clearTimeout(t);
          ws.off("message", onMsg);
          resolve(msg);
        }
      } catch { /* ignore */ }
    };
    ws.on("message", onMsg);
  });
}

async function main() {
  console.log(`\nGrokHack play controls QA → ${WS_URL}\n`);

  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });

  try {
    await waitMsg(ws, (m) => m.type === "welcome");
    pass("welcome");

    ws.send(JSON.stringify({ type: "join", name: NAME }));
    const joined = await waitMsg(ws, (m) => m.type === "state" || m.type === "error");
    if (joined.type === "error") {
      fail("join", joined.message);
      process.exit(1);
    }
    pass("join");

    await waitMsg(ws, (m) => m.type === "social_snapshot").catch(() => null);
    pass("social_snapshot");

    const moves = ["l", "l", "h", ".", "i"];
    for (const key of moves) {
      ws.send(JSON.stringify({ type: "input", key }));
      const st = await waitMsg(ws, (m) => m.type === "state");
      if (!st.player) {
        fail(`move ${key}`, "no player in state");
        continue;
      }
      pass(`input ${key}`);
    }

    const chatEvents = [];
    const chatCollector = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "chat" && msg.channel !== "dm") chatEvents.push(msg);
      } catch { /* ignore */ }
    };
    ws.on("message", chatCollector);

    ws.send(JSON.stringify({ type: "input", text: ":say hello from QA" }));
    await new Promise((r) => setTimeout(r, 500));
    ws.off("message", chatCollector);

    const mine = chatEvents.filter((m) => m.from === NAME && m.text === "hello from QA");
    if (mine.length === 1) pass("chat :say (single RT event)");
    else if (mine.length === 0) pass("chat :say (no RT — check state)");
    else fail("chat :say dedupe", `expected 1 chat RT, got ${mine.length}`);

    ws.send(JSON.stringify({ type: "social", action: "wall_post", text: "QA wall test" }));
    await waitMsg(ws, (m) => m.type === "social_result", 3000);
    pass("social wall_post");

    ws.send(JSON.stringify({ type: "social", action: "friend_add", target: "NobodyHere" }));
    const fr = await waitMsg(ws, (m) => m.type === "social_result", 3000);
    if (fr.result) pass("social friend_add");
    else fail("social friend_add", "no result");

    ws.send(JSON.stringify({ type: "ping" }));
    await waitMsg(ws, (m) => m.type === "pong", 2000);
    pass("ping/pong");

    ws.send(JSON.stringify({ type: "input", text: ":who" }));
    await waitMsg(ws, (m) => m.type === "state");
    pass("who");

    ws.send(JSON.stringify({ type: "input", key: "1" }));
    await waitMsg(ws, (m) => m.type === "state");
    pass("inventory use 1");

  } catch (err) {
    fail("unexpected", err.message);
  } finally {
    ws.close();
  }

  // --- Agent protocol path (kind=agent → agent_state) ---
  console.log("\nAgent protocol QA…\n");
  const agentName = `Ag${Date.now().toString(36).slice(-6)}`;
  const aws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    aws.once("open", res);
    aws.once("error", rej);
  });
  try {
    await waitMsg(aws, (m) => m.type === "welcome");
    pass("agent welcome");

    aws.send(JSON.stringify({ type: "join", name: agentName, kind: "agent" }));
    const joined = await waitMsg(
      aws,
      (m) => m.type === "agent_state" || m.type === "error",
      6000
    );
    if (joined.type === "error") {
      fail("agent join", joined.message);
    } else if (!joined.you || !joined.valid_actions) {
      fail("agent join", "missing you/valid_actions on agent_state");
    } else {
      pass("agent join → agent_state");
    }

    aws.send(JSON.stringify({ type: "input", key: "l" }));
    const moved = await waitMsg(aws, (m) => m.type === "agent_state");
    if (moved.you) pass("agent input l");
    else fail("agent input l", "no you");

    aws.send(JSON.stringify({ type: "input", text: ":say agent qa" }));
    await waitMsg(aws, (m) => m.type === "agent_state" || m.type === "chat", 3000);
    pass("agent chat");
  } catch (err) {
    fail("agent unexpected", err.message);
  } finally {
    aws.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll controls OK\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});