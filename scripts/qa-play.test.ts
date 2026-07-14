import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  assertStateTransition,
  chooseSafeWalkableStep,
  openQaSocket,
  resolveQaBase,
  waitMsg,
} from "./qa-play.mjs";

class FakeSocket extends EventEmitter {
  readyState = 0;
}

function welcome(): Buffer {
  return Buffer.from(JSON.stringify({ type: "welcome", sessionId: "qa-test" }));
}

const tiles = [
  ["#", "#", "#", "#", "#"],
  ["#", ".", ".", ".", "#"],
  ["#", ".", ".", ".", "#"],
  ["#", ".", ".", ".", "#"],
  ["#", "#", "#", "#", "#"],
];

function humanState(player = {}, floor = {}, others = []) {
  return {
    type: "state",
    player: { x: 2, y: 2, turns: 7, phase: "playing", depth: 1, ...player },
    floor: { tiles, monsters: [], items: [], ...floor },
    others,
  };
}

function agentState(
  you = {},
  visible = {},
  validActions = ["h", "j", "k", "l", "y", "u", "b", "n"],
  floorTiles = tiles,
) {
  return {
    type: "agent_state",
    you: { x: 2, y: 2, turns: 12, phase: "playing", depth: 1, ...you },
    floor: { tiles: floorTiles },
    visible: { monsters: [], items: [], players: [], ...visible },
    valid_actions: validActions,
  };
}

describe("qa-play safe movement selection", () => {
  it("selects an ordinary unoccupied human step", () => {
    expect(chooseSafeWalkableStep(humanState())).toEqual({
      key: "l",
      dx: 1,
      dy: 0,
      x: 3,
      y: 2,
    });
  });

  it("uses human floor occupants and other players", () => {
    const state = humanState(
      {},
      {
        monsters: [{ x: 3, y: 2, hp: 4 }],
        items: [{ x: 1, y: 2 }],
      },
      [{ x: 2, y: 3 }],
    );

    expect(chooseSafeWalkableStep(state)).toMatchObject({ key: "k", x: 2, y: 1 });
  });

  it("uses agent visibility and skips monsters, players, and pickups", () => {
    const state = agentState({}, {
      monsters: [{ x: 3, y: 2, hp: 4 }],
      players: [{ x: 2, y: 3 }],
      items: [{ x: 1, y: 2 }],
    });

    expect(chooseSafeWalkableStep(state)).toMatchObject({ key: "k", x: 2, y: 1 });
  });

  it("can choose a diagonal ordinary tile when cardinal cells are unavailable", () => {
    const diagonalTiles = tiles.map((row) => [...row]);
    diagonalTiles[2][3] = "#";
    diagonalTiles[3][2] = ">";
    diagonalTiles[2][1] = "+";
    diagonalTiles[1][2] = "<";

    expect(chooseSafeWalkableStep(agentState({}, {}, undefined, diagonalTiles))).toMatchObject({
      key: "u",
      x: 3,
      y: 1,
    });
  });

  it("fails explicitly when no safe adjacent ordinary step exists", () => {
    const closedTiles = tiles.map((row) => [...row]);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) closedTiles[y][x] = "#";
    }
    closedTiles[2][2] = ".";

    expect(() => chooseSafeWalkableStep({
      ...humanState(),
      floor: { tiles: closedTiles, monsters: [], items: [] },
    })).toThrow("no safe adjacent ordinary step from (2, 2)");
  });
});

describe("qa-play target safety", () => {
  it("uses a loopback target by default and permits local HTTP QA", () => {
    expect(resolveQaBase()).toBe("http://127.0.0.1:8080");
    expect(resolveQaBase("http://localhost:8081")).toBe("http://localhost:8081");
    expect(resolveQaBase("http://[::1]:8082")).toBe("http://[::1]:8082");
  });

  it("rejects remote and malformed targets unless HTTPS remote QA is explicitly enabled", () => {
    expect(() => resolveQaBase("https://grokhack.mondello.dev")).toThrow("remote QA requires https and QA_ALLOW_REMOTE=1");
    expect(() => resolveQaBase("http://example.test", true)).toThrow("remote QA requires https and QA_ALLOW_REMOTE=1");
    expect(() => resolveQaBase("https://user:pass@example.test", true)).toThrow("QA_URL must not include credentials");
    expect(() => resolveQaBase("ws://127.0.0.1:8080")).toThrow("QA_URL must use http or https");
    expect(resolveQaBase("https://staging.example.test", true)).toBe("https://staging.example.test");
  });
});

describe("qa-play state transition assertions", () => {
  it("accepts exact movement, wait, and inventory transitions", () => {
    const before = humanState();
    const moved = humanState({ x: 3, turns: 8 });
    const waited = humanState({ x: 3, turns: 9 });
    const inventory = humanState({ x: 3, turns: 9, phase: "inventory" });

    expect(assertStateTransition(before, moved, {
      label: "move",
      dx: 1,
      dy: 0,
      turnDelta: 1,
      phase: "playing",
    })).toMatchObject({ x: 3, y: 2, turns: 8 });
    expect(() => assertStateTransition(moved, waited, {
      label: "wait",
      dx: 0,
      dy: 0,
      turnDelta: 1,
      phase: "playing",
    })).not.toThrow();
    expect(() => assertStateTransition(waited, inventory, {
      label: "inventory",
      dx: 0,
      dy: 0,
      turnDelta: 0,
      phase: "inventory",
    })).not.toThrow();
  });

  it("accepts an exact agent-state movement transition", () => {
    expect(assertStateTransition(
      agentState(),
      agentState({ x: 3, turns: 13 }),
      {
        label: "agent move",
        dx: 1,
        dy: 0,
        turnDelta: 1,
        phase: "playing",
      },
    )).toMatchObject({ x: 3, y: 2, turns: 13 });
  });

  it.each([
    ["stale/no-op", { x: 2, y: 2, turns: 7 }],
    ["wrong delta", { x: 2, y: 3, turns: 8 }],
    ["wrong turn", { x: 3, y: 2, turns: 9 }],
  ])("rejects %s state", (_name, player) => {
    expect(() => assertStateTransition(humanState(), humanState(player), {
      label: "move proof",
      dx: 1,
      dy: 0,
      turnDelta: 1,
      phase: "playing",
    })).toThrow("move proof: expected");
  });
});

describe("qa-play WebSocket handshake", () => {
  it("captures welcome delivered synchronously during the open event", async () => {
    const socket = new FakeSocket();
    socket.once("open", () => socket.emit("message", welcome()));

    const pending = openQaSocket(socket, 100);
    socket.readyState = 1;
    socket.emit("open");

    await expect(pending).resolves.toMatchObject({ type: "welcome", sessionId: "qa-test" });
    expect(socket.eventNames()).toEqual([]);
  });

  it("accepts the normal open-then-welcome order and ignores unrelated frames", async () => {
    const socket = new FakeSocket();
    const pending = openQaSocket(socket, 100);

    socket.readyState = 1;
    socket.emit("open");
    socket.emit("message", Buffer.from("not-json"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "state" })));
    socket.emit("message", welcome());

    await expect(pending).resolves.toMatchObject({ type: "welcome" });
    expect(socket.eventNames()).toEqual([]);
  });

  it("fails promptly and cleans up when the connection errors", async () => {
    const socket = new FakeSocket();
    const pending = openQaSocket(socket, 100);

    socket.emit("error", new Error("synthetic connection failure"));

    await expect(pending).rejects.toThrow("synthetic connection failure");
    expect(socket.eventNames()).toEqual([]);
  });

  it("reports a close that happens before welcome", async () => {
    const socket = new FakeSocket();
    const pending = openQaSocket(socket, 100);

    socket.emit("close", 1008, Buffer.from("Join deadline exceeded"));

    await expect(pending).rejects.toThrow(
      "socket closed before welcome (1008: Join deadline exceeded)",
    );
    expect(socket.eventNames()).toEqual([]);
  });

  it("bounds a silent handshake and cleans up after timeout", async () => {
    const socket = new FakeSocket();
    const pending = openQaSocket(socket, 10);

    await expect(pending).rejects.toThrow("timeout waiting for welcome");
    expect(socket.eventNames()).toEqual([]);
  });
});

describe("qa-play message waits", () => {
  it("removes its listener when a state wait times out", async () => {
    const socket = new FakeSocket();
    const pending = waitMsg(socket, () => false, 10);

    await expect(pending).rejects.toThrow("timeout");
    expect(socket.eventNames()).toEqual([]);
  });

  it("removes every listener when the socket errors or closes", async () => {
    const errored = new FakeSocket();
    const errorPending = waitMsg(errored, () => false, 100);
    errored.emit("error", new Error("state stream failed"));
    await expect(errorPending).rejects.toThrow("state stream failed");
    expect(errored.eventNames()).toEqual([]);

    const closed = new FakeSocket();
    const closePending = waitMsg(closed, () => false, 100);
    closed.emit("close", 1006, Buffer.from("lost connection"));
    await expect(closePending).rejects.toThrow(
      "socket closed while waiting for message (1006: lost connection)",
    );
    expect(closed.eventNames()).toEqual([]);
  });
});
