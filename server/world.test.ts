import { describe, it, expect } from "vitest";
import { WorldServer } from "./world.js";
import type { ClientConnection } from "./types.js";

function mockConn(id: string): ClientConnection {
  const msgs: string[] = [];
  return {
    id,
    transport: "telnet",
    playerId: null,
    send: (m) => msgs.push(m),
    close: () => {},
  };
}

describe("WorldServer multiplayer", () => {
  it("allows two players to join with unique glyphs", () => {
    const world = new WorldServer();
    const c1 = mockConn("c1");
    const c2 = mockConn("c2");
    world.registerConnection(c1);
    world.registerConnection(c2);

    const p1 = world.joinPlayer("c1", "Alice");
    const p2 = world.joinPlayer("c2", "Bob");

    expect(typeof p1).not.toBe("string");
    expect(typeof p2).not.toBe("string");
    if (typeof p1 === "string" || typeof p2 === "string") return;

    expect(p1.glyph).toBe("@");
    expect(p2.glyph).not.toBe(p1.glyph);
    expect(world.getOnlineCount()).toBe(2);
  });

  it("rejects duplicate names", () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    world.joinPlayer("c1", "Alice");
    const dup = world.joinPlayer("c2", "Alice");
    expect(dup).toBe("Name already in use.");
  });

  it("shares floor state between players on same depth", () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const p1 = world.joinPlayer("c1", "Alice");
    const p2 = world.joinPlayer("c2", "Bob");
    if (typeof p1 === "string" || typeof p2 === "string") throw new Error("join failed");

    expect(p1.floorDepth).toBe(1);
    expect(p2.floorDepth).toBe(1);

    const view1 = world.buildView(p1);
    const view2 = world.buildView(p2);
    expect(view1.floor).toBe(view2.floor);
  });

  it("processes movement and increments turns", () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = world.joinPlayer("c1", "Mover");
    if (typeof p === "string") throw new Error(p);

    const turns0 = p.state.turns;
    world.handleInput(p.id, "l");
    expect(p.state.turns).toBeGreaterThan(turns0);
  });
});