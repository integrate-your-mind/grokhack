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
import { TELNET_BIND_HOST } from "./security.js";
import type { ClientConnection } from "./types.js";
import { getComputePool } from "./compute.js";
import type { DrainHandle } from "./http.js";

interface TelnetDrainState {
  draining: boolean;
  sockets: Set<net.Socket>;
  handle?: DrainHandle;
}

const telnetDrainStates = new WeakMap<net.Server, TelnetDrainState>();

export function startTelnetServer(world: WorldServer, port: number): net.Server | null {
  if (!Number.isFinite(port) || port <= 0) {
    console.log("[telnet] disabled (TELNET_PORT<=0)");
    return null;
  }

  const state: TelnetDrainState = { draining: false, sockets: new Set() };
  const server = net.createServer((socket) => {
    if (state.draining || world.isDraining()) {
      socket.end("Server restarting. Retry shortly.\r\n");
      return;
    }
    state.sockets.add(socket);
    const connId = randomUUID();
    const sessionId = randomUUID();
    let playerId: string | null = null;
    let naming = true;
    let nameBuffer = "";
    let cmdBuffer: string | null = null;
    /** When true, next non-control key dismisses help and redraws the map. */
    let helpOpen = false;
    /** JSON-lines compute contribution mode (:compute on). */
    let computeMode = false;
    let jsonLineBuffer = "";

    const computeSend = (m: Record<string, unknown>) => {
      try {
        socket.write(JSON.stringify(m) + "\r\n");
      } catch {
        /* closed */
      }
    };

    const handleComputeJson = (line: string) => {
      let msg: {
        type?: string;
        capacity?: number;
        job_types?: string[];
        name?: string;
        job_id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
        ms?: number;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        computeSend({ type: "compute_ack", accepted: false, reason: "invalid_json" });
        return;
      }
      if (msg.type === "compute_offer") {
        const label =
          msg.name ||
          (playerId ? world.getPlayer(playerId)?.name : undefined) ||
          `telnet-${connId.slice(0, 6)}`;
        getComputePool().handleOffer(
          connId,
          { capacity: msg.capacity, job_types: msg.job_types, name: label },
          computeSend,
          "telnet"
        );
        return;
      }
      if (msg.type === "compute_result") {
        getComputePool().handleResult(connId, {
          job_id: msg.job_id,
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
          ms: msg.ms,
        });
        return;
      }
      computeSend({ type: "error", message: "compute mode: send compute_offer or compute_result JSON" });
    };

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

    if (!world.registerConnection(conn)) {
      state.sockets.delete(socket);
      finalizeSession(sessionId);
      socket.end("Server restarting. Retry shortly.\r\n");
      return;
    }
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
      if (state.draining || world.isDraining()) {
        conn.disconnectReason = "restart";
        socket.end("Server restarting. Retry shortly.\r\n");
        return;
      }
      const text = stripTelnetCommands(data);

      if (naming) {
        nameBuffer += text;
        if (!nameBuffer.includes("\n") && !nameBuffer.includes("\r")) return;

        // Accept "Name" or "Name:resumeToken" (sec-app resume binder)
        const rawName = nameBuffer.replace(/[\r\n]/g, "").trim();
        nameBuffer = "";
        naming = false;
        const colon = rawName.indexOf(":");
        const name = colon > 0 ? rawName.slice(0, colon) : rawName;
        const resumeToken = colon > 0 ? rawName.slice(colon + 1).trim() : undefined;

        void (async () => {
          const result = await world.joinPlayer(connId, name, "human", resumeToken);
          if (typeof result === "string") {
            socket.write(
              `\r\n${result}\r\nEnter name or name:resumeToken: `
            );
            naming = true;
            return;
          }

          playerId = result.id;
          conn.playerId = playerId;
          if (result.resumeToken) {
            socket.write(
              `\r\n[resume] Save this token to reconnect: ${result.name}:${result.resumeToken}\r\n`
            );
          }
          refresh();
        })();
        return;
      }

      // Compute mode: accumulate JSON lines (also accept bare JSON offer anytime)
      if (computeMode && playerId) {
        jsonLineBuffer += text;
        let nl: number;
        while ((nl = jsonLineBuffer.search(/\r?\n/)) >= 0) {
          const line = jsonLineBuffer.slice(0, nl).replace(/\r$/, "").trim();
          jsonLineBuffer = jsonLineBuffer.slice(nl).replace(/^\r?\n/, "");
          if (!line) continue;
          if (line.toLowerCase() === ":compute off" || line.toLowerCase() === "compute off") {
            computeMode = false;
            getComputePool().unregisterWorker(connId);
            socket.write("\r\n[compute] OFF\r\n");
            refresh();
            continue;
          }
          handleComputeJson(line);
        }
        return;
      }

      // Allow one-shot JSON compute_offer without entering mode
      const trimmedPeek = text.trim();
      if (trimmedPeek.startsWith("{") && trimmedPeek.includes("compute_")) {
        jsonLineBuffer += text;
        if (jsonLineBuffer.includes("\n") || jsonLineBuffer.includes("\r")) {
          const line = jsonLineBuffer.replace(/[\r\n]/g, "").trim();
          jsonLineBuffer = "";
          handleComputeJson(line);
        }
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
              } else if (/^:compute\b/i.test(line) || /^compute\b/i.test(line.replace(/^:/, ""))) {
                const rest = line.replace(/^:/, "").trim().toLowerCase();
                if (rest === "compute on" || rest === "compute") {
                  computeMode = true;
                  jsonLineBuffer = "";
                  socket.write(
                    "\r\n[compute] ON — send JSON-lines (compute_offer / compute_result). :compute off to exit.\r\n"
                  );
                  const label = world.getPlayer(playerId)?.name || `telnet-${connId.slice(0, 6)}`;
                  getComputePool().handleOffer(
                    connId,
                    { capacity: 1, name: label },
                    computeSend,
                    "telnet"
                  );
                } else if (rest === "compute off") {
                  computeMode = false;
                  getComputePool().unregisterWorker(connId);
                  socket.write("\r\n[compute] OFF\r\n");
                  refresh();
                } else if (rest === "compute status") {
                  const m = getComputePool().getMetrics();
                  socket.write(
                    `\r\n[compute] workers=${m.workers} queue=${m.queueDepth} done=${m.completed} rej=${m.rejected} scoreboard=${m.topContributors.map((c) => `${c.name}:${c.score}`).join(",") || "—"}\r\n`
                  );
                } else {
                  socket.write("\r\n[compute] usage: :compute on|off|status\r\n");
                }
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
      state.sockets.delete(socket);
      logEvent("session_disconnect", sessionId, {
        transport: "telnet",
        playerId: playerId ?? undefined,
        detail: { reason: "client" },
      });
      finalizeSession(sessionId, playerId ?? undefined);
      getComputePool().unregisterWorker(connId);
      world.removeConnection(connId, "client");
    });
    socket.on("error", () => {
      state.sockets.delete(socket);
      getComputePool().unregisterWorker(connId);
      world.removeConnection(connId, "client");
    });
  });

  server.listen(port, TELNET_BIND_HOST, () => {
    console.log(
      `[telnet] ${TELNET_BIND_HOST}:${port} (not via CF tunnel; independent of BIND_HOST)`
    );
  });

  telnetDrainStates.set(server, state);

  return server;
}

export function beginTelnetDrain(server: net.Server): DrainHandle {
  const state = telnetDrainStates.get(server);
  if (!state) throw new Error("Telnet server is not managed by startTelnetServer");
  if (state.handle) return state.handle;

  state.draining = true;
  for (const socket of state.sockets) {
    socket.end("Server restarting. Retry shortly.\r\n");
  }
  const drained = new Promise<void>((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
  state.handle = {
    drained,
    forceClose(): void {
      for (const socket of state.sockets) socket.destroy();
    },
  };
  return state.handle;
}
