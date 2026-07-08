import net from "node:net";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import {
  negotiateTelnet,
  renderDeath,
  renderTerminalView,
  renderVictory,
  renderWelcome,
  stripTelnetCommands,
} from "./terminal.js";
import type { ClientConnection } from "./types.js";

export function startTelnetServer(world: WorldServer, port: number): net.Server {
  const server = net.createServer((socket) => {
    const connId = randomUUID();
    let playerId: string | null = null;
    let naming = true;
    let nameBuffer = "";

    negotiateTelnet(socket);

    const conn: ClientConnection = {
      id: connId,
      transport: "telnet",
      playerId: null,
      agentMode: false,
      send: (msg: string) => {
        if (msg === "DEAD") {
          const p = playerId ? world.getPlayer(playerId) : null;
          socket.write(p ? renderDeath(p) : "You died.\r\n");
          return;
        }
        if (msg === "WON") {
          const p = playerId ? world.getPlayer(playerId) : null;
          socket.write(p ? renderVictory(p) : "Victory!\r\n");
          return;
        }
        if (msg === "VIEW" && playerId) {
          const p = world.getPlayer(playerId);
          if (p) {
            const { floor, others } = world.buildView(p);
            socket.write(renderTerminalView(p, floor, others));
          }
        }
      },
      close: () => socket.end(),
    };

    world.registerConnection(conn);
    socket.write(renderWelcome(world.getOnlineCount(), 500));

    socket.on("data", (data) => {
      const text = stripTelnetCommands(data);

      if (naming) {
        nameBuffer += text;
        if (!nameBuffer.includes("\n") && !nameBuffer.includes("\r")) return;

        const name = nameBuffer.replace(/[\r\n]/g, "");
        nameBuffer = "";
        naming = false;

        const result = world.joinPlayer(connId, name);
        if (typeof result === "string") {
          socket.write(`\r\n${result}\r\nEnter thy name, adventurer: `);
          naming = true;
          return;
        }

        playerId = result.id;
        conn.playerId = playerId;
        const { floor, others } = world.buildView(result);
        socket.write(renderTerminalView(result, floor, others));
        return;
      }

      for (const ch of text) {
        if (ch === "\n" || ch === "\r") continue;
        if (playerId) world.handleInput(playerId, ch);
        if (playerId) {
          const p = world.getPlayer(playerId);
          if (p && p.connected) {
            const { floor, others } = world.buildView(p);
            socket.write(renderTerminalView(p, floor, others));
          }
        }
      }
    });

    socket.on("close", () => world.removeConnection(connId));
    socket.on("error", () => world.removeConnection(connId));
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[telnet] listening on port ${port}`);
  });

  return server;
}