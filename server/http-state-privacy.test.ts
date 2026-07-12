import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startHttpServer } from "./http.js";
import { WorldServer } from "./world.js";

function waitForJson(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

describe("human WebSocket observer privacy", () => {
  let world: WorldServer;
  let server: http.Server;
  let port: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    world = new WorldServer();
    server = startHttpServer(world, 0);
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
    port = address.port;
  });

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    await Promise.all(
      sockets.map(async (ws) => {
        if (ws.readyState === WebSocket.CLOSED) return;
        await Promise.race([once(ws, "close"), new Promise((resolve) => setTimeout(resolve, 250))]);
        if (Number(ws.readyState) !== WebSocket.CLOSED) ws.terminate();
      })
    );
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  async function connectAndJoin(name: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await once(ws, "open");
    const state = waitForJson(
      ws,
      (message) => message.type === "state" &&
        (message.player as { name?: string } | undefined)?.name === name
    );
    ws.send(JSON.stringify({ type: "join", name, kind: "human" }));
    await state;
    return ws;
  }

  async function requestState(ws: WebSocket, name: string): Promise<Record<string, unknown>> {
    const state = waitForJson(
      ws,
      (message) => message.type === "state" &&
        (message.player as { name?: string } | undefined)?.name === name
    );
    ws.send(JSON.stringify({ type: "input", key: "?" }));
    return state;
  }

  it("keeps private state owner-only while preserving public map fields", async () => {
    const aliceSocket = await connectAndJoin("Alice");
    const bobSocket = await connectAndJoin("Bob");
    await connectAndJoin("Charlie");

    const bob = world.getPlayersOnFloor(1).find((player) => player.name === "Bob");
    if (!bob) throw new Error("Bob did not join the shared floor");
    const starter = bob.state.inventory[0];
    if (!starter) throw new Error("Bob has no starter inventory");
    starter.name = "private inventory swordfish";
    bob.state.gold = 987_654;
    bob.state.deathCause = "private death cause";
    world.handleInput(bob.id, ":dm Charlie private-dm-swordfish");

    const aliceState = await requestState(aliceSocket, "Alice");
    const others = aliceState.others as Array<Record<string, unknown>>;
    const observedBob = others.find((player) => player.name === "Bob");
    expect(observedBob).toMatchObject({
      name: "Bob",
      glyph: bob.glyph,
      kind: bob.kind,
      x: bob.state.entity.x,
      y: bob.state.entity.y,
      depth: bob.floorDepth,
      level: bob.state.level,
    });
    for (const privateKey of [
      "messages",
      "inventory",
      "gold",
      "hunger",
      "turns",
      "xp",
      "xpToLevel",
      "deathCause",
      "weapon",
      "armor",
      "resumeToken",
    ]) {
      expect(observedBob).not.toHaveProperty(privateKey);
    }
    expect(JSON.stringify(observedBob)).not.toContain("swordfish");

    const bobState = await requestState(bobSocket, "Bob");
    const owner = bobState.player as Record<string, unknown>;
    expect(owner.gold).toBe(987_654);
    expect(JSON.stringify(owner.messages)).toContain("private-dm-swordfish");
    expect(JSON.stringify(owner.inventory)).toContain("private inventory swordfish");
  });
});
