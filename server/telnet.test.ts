import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { beginTelnetDrain, startTelnetServer } from "./telnet.js";
import { WorldServer } from "./world.js";

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    const drain = beginTelnetDrain(server);
    drain.forceClose();
    await drain.drained;
  }
  vi.restoreAllMocks();
});

async function ephemeralPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("ephemeral port unavailable");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForText(socket: net.Socket, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}`));
    }, 2_000);
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (pattern.test(received)) {
        cleanup();
        resolve(received);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

describe("Telnet admission", () => {
  it("contains a durable-authority join failure and permits an exact retry", async () => {
    let authorityUnavailable = true;
    const world = new WorldServer({
      loadResumablePlayer: async () => null,
      originJournal: {
        appendTransition: () => { throw new Error("unexpected append"); },
        movementAuthorityForFloor: ({ realmId, depth }) => {
          if (authorityUnavailable) throw new Error("authority disk unavailable");
          return {
            realmId,
            floorInstanceId: "telnet-retry-floor",
            depth,
            floorEpoch: 1,
            rulesetVersion: 1,
          };
        },
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await ephemeralPort();
    const server = startTelnetServer(world, port);
    if (!server) throw new Error("telnet server unavailable");
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      if (server.listening) resolve();
      else {
        server.once("listening", resolve);
        server.once("error", reject);
      }
    });

    const socket = net.createConnection({ host: "127.0.0.1", port });
    sockets.push(socket);
    await waitForText(socket, /Enter your name/i);
    socket.write("TelnetFence\r\n");
    const rejected = await waitForText(socket, /Unable to join right now/);
    expect(rejected).not.toContain("authority disk unavailable");
    expect(server.listening).toBe(true);
    expect(world.getStats()).toMatchObject({ onlinePlayers: 0, floorsActive: 0 });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"event":"telnet_join_failed"'));

    authorityUnavailable = false;
    socket.write("TelnetFence\r\n");
    await expect(waitForText(socket, /\[resume\] Save this token/)).resolves.toContain("TelnetFence:");
    expect(world.getStats()).toMatchObject({ onlinePlayers: 1, floorsActive: 1 });
  });
});
