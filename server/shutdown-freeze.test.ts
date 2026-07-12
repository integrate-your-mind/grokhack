import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientConnection } from "./types.js";
import { SHUTDOWN_RETRY_MESSAGE, WorldServer } from "./world.js";

function connection(id: string, close = vi.fn()): ClientConnection {
  return {
    id,
    sessionId: `shutdown-${id}`,
    transport: "websocket",
    playerId: null,
    agentMode: false,
    send: () => {},
    close,
  };
}

describe("graceful shutdown mutation fence", () => {
  afterEach(() => {
    delete process.env.GROKHACK_DISCONNECT_GRACE_MS;
  });

  it("rejects a join whose durable lookup completes after shutdown begins", async () => {
    let resolveLookup!: (value: null) => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const world = new WorldServer({
      loadResumablePlayer: async () => {
        markLookupStarted();
        return new Promise<null>((resolve) => {
          resolveLookup = resolve;
        });
      },
    });
    world.registerConnection(connection("pending"));

    const join = world.joinPlayer("pending", "DrainRace");
    await lookupStarted;
    expect(world.beginShutdown()).toBe(true);
    resolveLookup(null);

    expect(await join).toBe(SHUTDOWN_RETRY_MESSAGE);
    expect(world.getPresence().players).toHaveLength(0);
  });

  it("freezes input, social, external chat, and connection admission idempotently", async () => {
    process.env.GROKHACK_DISCONNECT_GRACE_MS = "0";
    const world = new WorldServer({ loadResumablePlayer: async () => null });
    const existing = connection("existing");
    expect(world.registerConnection(existing)).toBe(true);
    const player = await world.joinPlayer("existing", "DrainHero");
    if (typeof player === "string") throw new Error(player);

    const turns = player.state.turns;
    const chat = world.getChatLog(200);
    expect(world.beginShutdown()).toBe(true);
    expect(world.beginShutdown()).toBe(false);
    expect(world.isDraining()).toBe(true);

    world.handleInput(player.id, ".");
    world.ingestExternalChat("relay", "late mutation", "irc");
    expect(world.handleSocialApi(player.id, "wall_post", { text: "late post" })).toEqual({
      ok: false,
      message: SHUTDOWN_RETRY_MESSAGE,
    });
    expect(player.state.turns).toBe(turns);
    expect(world.getChatLog(200)).toEqual(chat);

    const lateClose = vi.fn();
    expect(world.registerConnection(connection("late", lateClose))).toBe(false);
    expect(lateClose).toHaveBeenCalledOnce();
    expect(await world.joinPlayer("late", "TooLate")).toBe(SHUTDOWN_RETRY_MESSAGE);
  });
});
