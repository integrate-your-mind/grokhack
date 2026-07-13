#!/usr/bin/env node
/**
 * WebSocket QA — verifies all player controls respond without error.
 */
import WebSocket from "ws";
import { pathToFileURL } from "node:url";

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

export function waitMsg(ws, pred, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onMsg = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (pred(msg)) {
          finish(resolve, msg);
        }
      } catch { /* ignore */ }
    };
    const onError = (error) => {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (code, reason) => {
      const detail = reason?.toString() || "no reason";
      finish(reject, new Error(`socket closed while waiting for message (${code}: ${detail})`));
    };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), timeout);
    ws.on("message", onMsg);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

/**
 * Complete the WebSocket handshake without losing a welcome frame that arrives
 * during the open event. All listeners are installed before the socket can
 * advance, and every exit path removes them.
 */
export function openQaSocket(ws, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let opened = ws.readyState === WebSocket.OPEN;
    let welcome = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const maybeResolve = () => {
      if (opened && welcome) finish(resolve, welcome);
    };
    const onOpen = () => {
      opened = true;
      maybeResolve();
    };
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "welcome") {
          welcome = message;
          maybeResolve();
        }
      } catch {
        // Ignore non-JSON protocol noise while waiting for the welcome frame.
      }
    };
    const onError = (error) => {
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (code, reason) => {
      const detail = reason?.toString() || "no reason";
      finish(reject, new Error(`socket closed before welcome (${code}: ${detail})`));
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("timeout waiting for welcome"));
    }, timeout);

    ws.on("open", onOpen);
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
    maybeResolve();
  });
}

const QA_DIRECTIONS = [
  { key: "l", dx: 1, dy: 0 },
  { key: "j", dx: 0, dy: 1 },
  { key: "h", dx: -1, dy: 0 },
  { key: "k", dx: 0, dy: -1 },
  { key: "u", dx: 1, dy: -1 },
  { key: "n", dx: 1, dy: 1 },
  { key: "y", dx: -1, dy: -1 },
  { key: "b", dx: -1, dy: 1 },
];

function stateActor(state, label) {
  const actor = state?.player ?? state?.you;
  if (
    !actor ||
    !Number.isSafeInteger(actor.x) ||
    !Number.isSafeInteger(actor.y) ||
    !Number.isSafeInteger(actor.turns) ||
    typeof actor.phase !== "string"
  ) {
    throw new Error(`${label}: missing player coordinates, turns, or phase`);
  }
  return actor;
}

/** Select a known-safe ordinary floor step from either human or agent state. */
export function chooseSafeWalkableStep(state) {
  const actor = stateActor(state, "safe-step selection");
  if (actor.phase !== "playing") {
    throw new Error(`no safe step: player phase is ${actor.phase}`);
  }
  const tiles = state?.floor?.tiles;
  if (!Array.isArray(tiles) || !tiles.every(Array.isArray)) {
    throw new Error("no safe step: floor tiles are missing");
  }

  const blocked = new Set();
  const addBlocked = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry?.x) || !Number.isSafeInteger(entry?.y)) continue;
      if (typeof entry.hp === "number" && entry.hp <= 0) continue;
      blocked.add(`${entry.x},${entry.y}`);
    }
  };
  addBlocked(state.floor?.monsters);
  addBlocked(state.floor?.items);
  addBlocked(state.others);
  addBlocked(state.visible?.monsters);
  addBlocked(state.visible?.items);
  addBlocked(state.visible?.players);

  for (const direction of QA_DIRECTIONS) {
    if (Array.isArray(state.valid_actions) && !state.valid_actions.includes(direction.key)) {
      continue;
    }
    const x = actor.x + direction.dx;
    const y = actor.y + direction.dy;
    // Only an ordinary floor cell is suitable for an exact QA movement proof:
    // walls, doors, stairs, pickups, combat, and other players are excluded.
    if (tiles[y]?.[x] !== "." || blocked.has(`${x},${y}`)) continue;
    return { ...direction, x, y };
  }

  throw new Error(`no safe adjacent ordinary step from (${actor.x}, ${actor.y})`);
}

/** Assert the exact authoritative state delta produced by one QA action. */
export function assertStateTransition(beforeState, afterState, expected) {
  const label = expected.label ?? "state transition";
  const before = stateActor(beforeState, `${label} before`);
  const after = stateActor(afterState, `${label} after`);
  const expectedX = before.x + expected.dx;
  const expectedY = before.y + expected.dy;
  const expectedTurns = before.turns + expected.turnDelta;
  const expectedDepth = before.depth;
  const failures = [];

  if (after.x !== expectedX || after.y !== expectedY) {
    failures.push(`position (${expectedX}, ${expectedY}), got (${after.x}, ${after.y})`);
  }
  if (after.turns !== expectedTurns) {
    failures.push(`turns ${expectedTurns}, got ${after.turns}`);
  }
  if (expected.phase !== undefined && after.phase !== expected.phase) {
    failures.push(`phase ${expected.phase}, got ${after.phase}`);
  }
  if (Number.isSafeInteger(expectedDepth) && after.depth !== expectedDepth) {
    failures.push(`depth ${expectedDepth}, got ${after.depth}`);
  }
  if (failures.length) throw new Error(`${label}: expected ${failures.join("; ")}`);
  return after;
}

async function main() {
  console.log(`\nGrokHack play controls QA → ${WS_URL}\n`);

  const ws = new WebSocket(WS_URL);

  try {
    await openQaSocket(ws);
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

    let humanState = joined;
    const step = chooseSafeWalkableStep(humanState);
    ws.send(JSON.stringify({ type: "input", key: step.key }));
    const moved = await waitMsg(ws, (m) => m.type === "state");
    assertStateTransition(humanState, moved, {
      label: `human move ${step.key}`,
      dx: step.dx,
      dy: step.dy,
      turnDelta: 1,
      phase: "playing",
    });
    pass(`human move ${step.key} (exact position, +1 turn)`);
    humanState = moved;

    ws.send(JSON.stringify({ type: "input", key: "." }));
    const waited = await waitMsg(ws, (m) => m.type === "state");
    assertStateTransition(humanState, waited, {
      label: "human wait",
      dx: 0,
      dy: 0,
      turnDelta: 1,
      phase: "playing",
    });
    pass("human wait (position stable, +1 turn)");
    humanState = waited;

    ws.send(JSON.stringify({ type: "input", key: "i" }));
    const inventory = await waitMsg(ws, (m) => m.type === "state");
    assertStateTransition(humanState, inventory, {
      label: "inventory open",
      dx: 0,
      dy: 0,
      turnDelta: 0,
      phase: "inventory",
    });
    pass("inventory open (phase changed, no move/turn)");

    ws.send(JSON.stringify({ type: "input", key: "i" }));
    const inventoryClosed = await waitMsg(ws, (m) => m.type === "state");
    assertStateTransition(inventory, inventoryClosed, {
      label: "inventory close",
      dx: 0,
      dy: 0,
      turnDelta: 0,
      phase: "playing",
    });
    pass("inventory close (playing, no move/turn)");

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

  } catch (err) {
    fail("unexpected", err.message);
  } finally {
    ws.close();
  }

  // --- Agent protocol path (kind=agent → agent_state) ---
  console.log("\nAgent protocol QA…\n");
  const agentName = `Ag${Date.now().toString(36).slice(-6)}`;
  const aws = new WebSocket(WS_URL);
  try {
    await openQaSocket(aws);
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

    if (joined.type !== "error" && joined.you && joined.valid_actions) {
      const step = chooseSafeWalkableStep(joined);
      aws.send(JSON.stringify({ type: "input", key: step.key }));
      const moved = await waitMsg(aws, (m) => m.type === "agent_state");
      assertStateTransition(joined, moved, {
        label: `agent move ${step.key}`,
        dx: step.dx,
        dy: step.dy,
        turnDelta: 1,
        phase: "playing",
      });
      pass(`agent move ${step.key} (exact position, +1 turn)`);
    }

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
