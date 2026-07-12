import { describe, expect, it } from "vitest";

import { startWebSocketServer } from "./websocket.js";
import { WorldServer } from "./world.js";

describe("retired standalone WebSocket entry point", () => {
  it("fails closed instead of starting an unhardened listener", () => {
    expect(() => startWebSocketServer(new WorldServer(), 0)).toThrow(/startHttpServer/);
  });
});
