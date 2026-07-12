/**
 * sec-app: join/resume hijack + chat spam + sanitize.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientConnection } from "./types.js";
import { WorldServer } from "./world.js";
import { resetResumeAuthForTests } from "./resume-auth.js";
import { sanitizeChatText, sanitizePlayerName } from "./security.js";

let tmpDir = "";

function mockConn(id: string): ClientConnection {
  return {
    id,
    transport: "websocket",
    playerId: null,
    sessionId: `sess-${id}`,
    agentMode: false,
    send: () => {},
    close: () => {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-sec-app-"));
  process.env.GROKHACK_RESUME_TOKENS_PATH = path.join(tmpDir, "tokens.json");
  resetResumeAuthForTests();
});

afterEach(() => {
  resetResumeAuthForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GROKHACK_RESUME_TOKENS_PATH;
});

describe("resume-token hijack defenses", () => {
  it("rejects supersede without resumeToken (live hijack)", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("victim"));
    world.registerConnection(mockConn("attacker"));
    const victim = await world.joinPlayer("victim", "Hero");
    if (typeof victim === "string") throw new Error(victim);
    expect(victim.resumeToken).toMatch(/^[0-9a-f]{64}$/i);

    const hijack = await world.joinPlayer("attacker", "Hero");
    expect(typeof hijack).toBe("string");
    expect(String(hijack)).toMatch(/Resume denied/i);
    expect(victim.connected).toBe(true);
    expect(world.getPlayer(victim.id)?.connected).toBe(true);
  });

  it("writes the bearer-token vault with owner-only permissions", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("owner"));
    const joined = await world.joinPlayer("owner", "PrivateVault");
    if (typeof joined === "string") throw new Error(joined);

    const tokenPath = process.env.GROKHACK_RESUME_TOKENS_PATH!;
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700);
  });

  it("rejects wrong resumeToken on grace reconnect", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const first = await world.joinPlayer("c1", "Mage");
    if (typeof first === "string") throw new Error(first);
    first.state.gold = 99;
    world.removeConnection("c1");

    world.registerConnection(mockConn("c2"));
    const bad = await world.joinPlayer(
      "c2",
      "Mage",
      "human",
      "0".repeat(64)
    );
    expect(String(bad)).toMatch(/Resume denied/i);

    world.registerConnection(mockConn("c3"));
    const ok = await world.joinPlayer("c3", "Mage", "human", first.resumeToken);
    if (typeof ok === "string") throw new Error(ok);
    expect(ok.id).toBe(first.id);
    expect(ok.state.gold).toBe(99);
  });

  it("allows supersede only with correct resumeToken", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    world.registerConnection(mockConn("c2"));
    const first = await world.joinPlayer("c1", "Rogue");
    if (typeof first === "string") throw new Error(first);
    first.state.turns = 5;

    const second = await world.joinPlayer("c2", "Rogue", "human", first.resumeToken);
    if (typeof second === "string") throw new Error(second);
    expect(second.id).toBe(first.id);
    expect(second.state.turns).toBe(5);
    expect(second.connected).toBe(true);
  });

  it("fails closed when the resume-token vault disappears", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("victim"));
    const victim = await world.joinPlayer("victim", "VaultHero");
    if (typeof victim === "string") throw new Error(victim);

    resetResumeAuthForTests();
    world.registerConnection(mockConn("attacker"));
    const takeover = await world.joinPlayer("attacker", "VaultHero");

    expect(String(takeover)).toMatch(/Resume denied/i);
    expect(world.getPlayer(victim.id)?.connected).toBe(true);
  });

  it("rotates token on fresh run after death so old secret cannot reclaim", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const first = await world.joinPlayer("c1", "Phoenix");
    if (typeof first === "string") throw new Error(first);
    const oldToken = first.resumeToken!;
    first.phase = "dead";
    first.connected = false;
    // dead cleanup happens on next join of same name
    world.registerConnection(mockConn("c2"));
    const fresh = await world.joinPlayer("c2", "Phoenix");
    if (typeof fresh === "string") throw new Error(fresh);
    expect(fresh.resumeToken).toBeTruthy();
    expect(fresh.resumeToken).not.toBe(oldToken);
    expect(fresh.id).not.toBe(first.id);

    world.registerConnection(mockConn("c3"));
    const steal = await world.joinPlayer("c3", "Phoenix", "human", oldToken);
    expect(String(steal)).toMatch(/Resume denied/i);
  });
});

describe("chat spam + sanitize", () => {
  it("rate-limits global chat per player", async () => {
    const world = new WorldServer();
    world.registerConnection(mockConn("c1"));
    const p = await world.joinPlayer("c1", "Chatter");
    if (typeof p === "string") throw new Error(p);

    for (let i = 0; i < 20; i++) {
      world.handleInput(p.id, `:say spam-${i}`);
    }
    const before = p.messages.length;
    world.handleInput(p.id, ":say one-too-many");
    expect(p.messages.some((m) => /rate limit/i.test(m))).toBe(true);
    expect(p.messages.length).toBeGreaterThan(before - 1);
  });

  it("strips control chars from chat", () => {
    expect(sanitizeChatText("hi\x00\x07there")).toBe("hithere");
    expect(sanitizeChatText("  ok  ")).toBe("ok");
    expect(sanitizeChatText("x".repeat(500)).length).toBe(280);
  });

  it("rejects injection-ish player names", () => {
    expect(sanitizePlayerName("")).toBeNull();
    expect(sanitizePlayerName("<script>")).toBeNull();
    expect(sanitizePlayerName("1bad")).toBeNull();
    expect(sanitizePlayerName("Good_Name-1")).toBe("Good_Name-1");
  });
});
