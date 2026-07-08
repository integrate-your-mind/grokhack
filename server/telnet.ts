import net from "node:net";
import { randomUUID } from "node:crypto";
import type { WorldServer } from "./world.js";
import {
  negotiateTelnet,
  renderDeath,
  renderHelp,
  renderTerminalView,
  renderVictory,
  renderWelcome,
  stripTelnetCommands,
} from "./terminal.js";
import { logEvent } from "./audit.js";
import { initSession, finalizeSession } from "./session-metrics.js";
import { BIND_HOST } from "./security.js";
import type { ClientConnection } from "./types.js";

export function startTelnetServer(world: WorldServer, port: number): net.Server {
  const server = net.createServer((socket) => {
    const connId = randomUUID();
    const sessionId = randomUUID();
    let playerId: string | null = null;
    let naming = true;
    let nameBuffer = "";
    let cmdBuffer: string | null = null;
    /** When true, next non-control key dismisses help and redraws the map. */
    let helpOpen = false;

    negotiateTelnet(socket);

    logEvent("session_connect", sessionId, { transport: "telnet" });
    initSession(sessionId, "telnet");

    const conn: ClientConnection = {
      id: connId,
      sessionId,
      transport: "telnet",
      playerId: null,
      agentMode: false,
      send: (msg: string) => {
        if (msg.startsWith("RT:")) {
          try {
            const payload = JSON.parse(msg.slice(3)) as { type?: string; channel?: string; from?: string; text?: string };
            if (payload.type === "chat" && playerId) {
              const p = world.getPlayer(playerId);
              if (p) {
                const label = payload.channel === "dm" ? "[dm]" : "[chat]";
                p.messages.push(`${label} ${payload.from}: ${payload.text}`);
                if (p.messages.length > 50) p.messages.shift();
              }
            }
          } catch {
            /* ignore */
          }
          return;
        }
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

    const refresh = () => {
      if (!playerId) return;
      helpOpen = false;
      const p = world.getPlayer(playerId);
      if (p && p.connected) {
        const { floor, others } = world.buildView(p);
        socket.write(renderTerminalView(p, floor, others));
      }
    };

    const showHelp = () => {
      helpOpen = true;
      socket.write(renderHelp());
    };

    const isHelpCommand = (line: string): boolean => {
      const t = line.trim().toLowerCase();
      return t === ":help" || t === "help" || t === "?";
    };

    socket.on("data", (data) => {
      const text = stripTelnetCommands(data);

      if (naming) {
        nameBuffer += text;
        if (!nameBuffer.includes("\n") && !nameBuffer.includes("\r")) return;

        const name = nameBuffer.replace(/[\r\n]/g, "");
        nameBuffer = "";
        naming = false;

        void (async () => {
          const result = await world.joinPlayer(connId, name);
          if (typeof result === "string") {
            socket.write(`\r\n${result}\r\nEnter thy name, adventurer: `);
            naming = true;
            return;
          }

          playerId = result.id;
          conn.playerId = playerId;
          refresh();
        })();
        return;
      }

      for (const ch of text) {
        if (ch === "\r") continue;

        if (cmdBuffer !== null) {
          if (ch === "\n") {
            const line = cmdBuffer.trim();
            cmdBuffer = null;
            if (line && playerId) {
              if (isHelpCommand(line)) {
                showHelp();
              } else {
                world.handleInput(playerId, line.startsWith(":") ? line : `:${line}`);
                refresh();
              }
            } else if (helpOpen) {
              refresh();
            }
          } else if (ch === "\x7f" || ch === "\b") {
            cmdBuffer = cmdBuffer.slice(0, -1);
          } else {
            cmdBuffer += ch;
          }
          continue;
        }

        if (ch === ":") {
          cmdBuffer = ":";
          socket.write("\r\n: ");
          continue;
        }

        // Local help overlay — does not change world semantics (:who still lists players).
        if (ch === "?") {
          showHelp();
          continue;
        }

        if (ch === "\n") {
          if (helpOpen) refresh();
          continue;
        }

        // Any other key dismisses help, then is played as a normal input.
        if (helpOpen) {
          helpOpen = false;
          if (playerId) world.handleInput(playerId, ch);
          refresh();
          continue;
        }

        if (playerId) world.handleInput(playerId, ch);
        refresh();
      }
    });

    socket.on("close", () => {
      logEvent("session_disconnect", sessionId, { transport: "telnet", playerId: playerId ?? undefined });
      finalizeSession(sessionId, playerId ?? undefined);
      world.removeConnection(connId);
    });
    socket.on("error", () => world.removeConnection(connId));
  });

  server.listen(port, BIND_HOST, () => {
    console.log(`[telnet] ${BIND_HOST}:${port} (localhost only — not exposed via tunnel)`);
  });

  return server;
}