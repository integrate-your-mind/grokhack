import type { WorldServer } from "./world.js";

/**
 * The former standalone WebSocket listener bypassed the production HTTP
 * listener's parser limit, admission queue, connection quotas, resume fencing,
 * observer privacy serializer, heartbeat, and outbound backpressure.
 *
 * Keep this compatibility export fail-closed so an old integration receives an
 * actionable startup error instead of silently exposing an unsafe game port.
 * New callers must use startHttpServer() from ./http.ts, which owns /ws.
 */
export function startWebSocketServer(_world: WorldServer, _port: number): never {
  throw new Error(
    "Standalone WebSocket server retired: use startHttpServer(world, port) from server/http.ts",
  );
}
