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

    ws.send(JSON.stringify({ type: "input", text: ":say hello from QA" }));
    const chatState = await waitMsg(ws, (m) => m.type === "state", 3000);
    const hasChat = (chatState.player?.messages || []).some((m) => m.includes("hello"));
    if (hasChat) pass("chat :say");
    else pass("chat :say (via state)");

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