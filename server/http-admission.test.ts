import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { beginHttpDrain, sendWebSocketBounded, startHttpServer } from "./http.js";
import { MAX_WS_MESSAGE_BYTES } from "./security.js";
import type { ClientConnection } from "./types.js";
import { WorldServer } from "./world.js";

function waitForJson(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function mockConnection(id: string): ClientConnection {
  return {
    id,
    sessionId: `admission-${id}`,
    transport: "websocket",
    playerId: null,
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for admission state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WebSocket admission hardening", () => {
  let world: WorldServer;
  let server: http.Server;
  let port = 0;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    process.env.GROKHACK_DISCONNECT_GRACE_MS = "0";
    world = new WorldServer();
    server = startHttpServer(world, 0, {
      joinDeadlineMs: 500,
      maxConnections: 4,
      maxConnectionsPerIp: 2,
    });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
    port = address.port;
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    delete process.env.GROKHACK_DISCONNECT_GRACE_MS;
  });

  async function connect(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }

  it("contains a synchronous outbound send failure", () => {
    const close = vi.fn();
    const fakeSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(() => {
        throw new Error("synthetic send failure");
      }),
      close,
    } as unknown as Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close">;

    expect(sendWebSocketBounded(fakeSocket, "{}", 1_024)).toBe(false);
    expect(close).toHaveBeenCalledWith(1011, "Outbound send failed");
  });

  it("drains WebSockets with restart semantics and is idempotent", async () => {
    const socket = await connect();
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });

    world.beginShutdown();
    const first = beginHttpDrain(server);
    const second = beginHttpDrain(server);

    expect(second).toBe(first);
    expect(await closed).toBe(1012);
    await first.drained;
  });

  it("creates exactly one player when one socket bursts duplicate joins", async () => {
    const socket = await connect();
    const joined = waitForJson(
      socket,
      (message) =>
        message.type === "state" &&
        (message.player as { name?: string } | undefined)?.name === "BurstProbe",
    );
    for (let index = 0; index < 30; index += 1) {
      socket.send(JSON.stringify({ type: "join", name: "BurstProbe" }));
    }
    await joined;

    // Ping is queued after every join frame. Its response proves the burst drained.
    const pong = waitForJson(socket, (message) => message.type === "pong");
    socket.send(JSON.stringify({ type: "ping" }));
    await pong;

    const presence = world.getPresence();
    expect(presence.connections).toBe(1);
    expect(presence.online).toBe(1);
    expect(presence.players.filter((player) => player.name === "BurstProbe")).toHaveLength(1);

    socket.close(1000, "test_complete");
    await once(socket, "close");
    await waitUntil(() => world.getPresence().connections === 0);
    expect(world.getOnlineCount()).toBe(0);
    expect(world.getPresence().players.filter((player) => player.name === "BurstProbe")).toHaveLength(0);
  });

  it("expires sockets that never join and releases their world connection", async () => {
    const socket = await connect();
    const close = once(socket, "close") as Promise<[number, Buffer]>;
    const [code, reason] = await close;
    expect(code).toBe(1008);
    expect(reason.toString()).toBe("Join deadline exceeded");
    await waitUntil(() => world.getPresence().connections === 0);
  });

  it("caps concurrent sockets per address without disturbing accepted peers", async () => {
    const first = await connect();
    const second = await connect();
    const third = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(third);
    const rejected = once(third, "close") as Promise<[number, Buffer]>;
    await once(third, "open");
    const [code, reason] = await rejected;
    expect(code).toBe(1008);
    expect(reason.toString()).toMatch(/too many connections/i);

    const firstPong = waitForJson(first, (message) => message.type === "pong");
    first.send(JSON.stringify({ type: "ping" }));
    await firstPong;
    const secondPong = waitForJson(second, (message) => message.type === "pong");
    second.send(JSON.stringify({ type: "ping" }));
    await secondPong;
  });

  it("closes before a full state can exceed the outbound byte budget", async () => {
    const boundedWorld = new WorldServer({ loadResumablePlayer: async () => null });
    const boundedServer = startHttpServer(boundedWorld, 0, {
      joinDeadlineMs: 2_000,
      maxBufferedBytes: 1_024,
    });
    if (!boundedServer.listening) await once(boundedServer, "listening");
    const address = boundedServer.address();
    if (!address || typeof address === "string") throw new Error("bounded server has no port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    sockets.push(socket);
    const welcome = waitForJson(socket, (message) => message.type === "welcome");
    await once(socket, "open");
    await welcome;
    const close = once(socket, "close") as Promise<[number, Buffer]>;
    socket.send(JSON.stringify({ type: "join", name: "BoundedOutput" }));
    const [code, reason] = await close;
    expect(code).toBe(1013);
    expect(reason.toString()).toBe("Slow consumer");

    boundedServer.closeAllConnections();
    if (boundedServer.listening) {
      await new Promise<void>((resolve, reject) => {
        boundedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("makes same-name admission atomic across simultaneous connections", async () => {
    const direct = new WorldServer();
    direct.registerConnection(mockConnection("atomic-a"));
    direct.registerConnection(mockConnection("atomic-b"));

    const [first, second] = await Promise.all([
      direct.joinPlayer("atomic-a", "AtomicProbe"),
      direct.joinPlayer("atomic-b", "AtomicProbe"),
    ]);
    const winners = [first, second].filter((result) => typeof result !== "string");
    const rejections = [first, second].filter((result) => typeof result === "string");

    expect(winners).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(String(rejections[0])).toMatch(/resume denied|already joined|name/i);
    expect(direct.getPresence().players.filter((player) => player.name === "AtomicProbe")).toHaveLength(1);
  });

  it("does not let one stalled durable lookup block an in-memory reconnect", async () => {
    let releaseSlowLookup!: (player: null) => void;
    const slowLookup = new Promise<null>((resolve) => {
      releaseSlowLookup = resolve;
    });
    const loadResumablePlayer = vi.fn((name: string) =>
      name === "SlowLookup" ? slowLookup : Promise.resolve(null)
    );
    const direct = new WorldServer({ loadResumablePlayer });

    direct.registerConnection(mockConnection("resident-old"));
    const created = await direct.joinPlayer("resident-old", "ResidentProbe");
    expect(typeof created).not.toBe("string");
    if (typeof created === "string") throw new Error(created);
    const resumeToken = created.resumeToken;
    direct.removeConnection("resident-old");

    direct.registerConnection(mockConnection("slow-lookup"));
    direct.registerConnection(mockConnection("resident-new"));
    const blockedJoin = direct.joinPlayer("slow-lookup", "SlowLookup");
    await waitUntil(() => loadResumablePlayer.mock.calls.some(([name]) => name === "SlowLookup"));

    const resumed = await Promise.race([
      direct.joinPlayer("resident-new", "ResidentProbe", "human", resumeToken),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("resident reconnect waited on unrelated lookup")), 100)
      ),
    ]);
    expect(typeof resumed).not.toBe("string");
    expect(direct.getPresence().players.filter((player) => player.name === "ResidentProbe")).toHaveLength(1);

    releaseSlowLookup(null);
    await blockedJoin;
  });

  it("allows an existing owner to reconnect when fresh-character capacity is full", async () => {
    const direct = new WorldServer({
      maxPlayers: 1,
      loadResumablePlayer: async () => null,
    });
    direct.registerConnection(mockConnection("capacity-owner-old"));
    const created = await direct.joinPlayer("capacity-owner-old", "CapacityOwner");
    expect(typeof created).not.toBe("string");
    if (typeof created === "string") throw new Error(created);

    direct.registerConnection(mockConnection("capacity-fresh"));
    await expect(direct.joinPlayer("capacity-fresh", "CapacityFresh")).resolves.toMatch(/full/i);

    direct.removeConnection("capacity-owner-old");
    direct.registerConnection(mockConnection("capacity-owner-new"));
    const resumed = await direct.joinPlayer(
      "capacity-owner-new",
      "CapacityOwner",
      "human",
      created.resumeToken,
    );
    expect(typeof resumed).not.toBe("string");
    expect(direct.getOnlineCount()).toBe(1);
  });

  it("recovers from a rejected join and prevents a second identity on one connection", async () => {
    const socket = await connect();
    const invalid = waitForJson(
      socket,
      (message) => message.type === "error" && /invalid name/i.test(String(message.message)),
    );
    socket.send(JSON.stringify({ type: "join", name: "1-invalid" }));
    await invalid;

    const joined = waitForJson(
      socket,
      (message) =>
        message.type === "state" &&
        (message.player as { name?: string } | undefined)?.name === "Recovered",
    );
    socket.send(JSON.stringify({ type: "join", name: "Recovered" }));
    await joined;

    const duplicate = waitForJson(
      socket,
      (message) => message.type === "error" && /already joined/i.test(String(message.message)),
    );
    socket.send(JSON.stringify({ type: "join", name: "SecondIdentity" }));
    await duplicate;

    expect(world.getOnlineCount()).toBe(1);
    expect(world.findPlayerByName("Recovered")).toBeDefined();
    expect(world.findPlayerByName("SecondIdentity")).toBeUndefined();
  });

  it("enforces the UTF-8 byte limit at the WebSocket parser boundary", async () => {
    const socket = await connect();
    const close = once(socket, "close");
    const payload = JSON.stringify({
      type: "ping",
      padding: "🙂".repeat(Math.ceil(MAX_WS_MESSAGE_BYTES / 4)),
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(MAX_WS_MESSAGE_BYTES);
    expect(payload.length).toBeLessThan(MAX_WS_MESSAGE_BYTES);
    socket.send(payload);

    const [code] = await close;
    expect(code).toBe(1009);
    expect(world.getOnlineCount()).toBe(0);
  });

  it("accepts an exact-boundary text frame and rejects binary JSON", async () => {
    const exact = await connect();
    const prefix = '{"type":"ping","padding":"';
    const suffix = '"}';
    const frame = `${prefix}${"a".repeat(MAX_WS_MESSAGE_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(frame, "utf8")).toBe(MAX_WS_MESSAGE_BYTES);
    const pong = waitForJson(exact, (message) => message.type === "pong");
    exact.send(frame);
    await pong;
    exact.close(1000, "boundary_proved");
    await once(exact, "close");

    const binary = await connect();
    const binaryClose = once(binary, "close");
    binary.send(Buffer.from(JSON.stringify({ type: "ping" })), { binary: true });
    const [code] = await binaryClose;
    expect(code).toBe(1003);
  });

  it("bounds the per-connection message queue under a flood", async () => {
    const flooded = await connect();
    const close = once(flooded, "close");
    for (let index = 0; index < 1_000; index += 1) {
      flooded.send(JSON.stringify({ type: "ping", index }));
    }
    const [code, reason] = await close;
    expect(code).toBe(1008);
    expect(String(reason)).toMatch(/pending|rate/i);

    const healthy = await connect();
    const pong = waitForJson(healthy, (message) => message.type === "pong");
    healthy.send(JSON.stringify({ type: "ping" }));
    await pong;
  });
});
