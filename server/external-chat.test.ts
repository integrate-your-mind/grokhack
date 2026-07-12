import { describe, it, expect, beforeEach } from "vitest";
import { checkExternalChat, resetExternalChatLimits } from "./external-chat.js";

describe("external chat limits", () => {
  beforeEach(() => resetExternalChatLimits());

  it("allows linked discord tier more than unlinked", () => {
    for (let i = 0; i < 2; i++) {
      expect(checkExternalChat("discord_unlinked", "discord:u1", `msg ${i}`).ok).toBe(true);
    }
    expect(checkExternalChat("discord_unlinked", "discord:u1", "msg 3").ok).toBe(false);

    for (let i = 0; i < 5; i++) {
      expect(checkExternalChat("discord_linked", "discord:u2", `linked ${i}`).ok).toBe(true);
    }
    expect(checkExternalChat("discord_linked", "discord:u2", "linked 6").ok).toBe(false);
  });

  it("rejects duplicate text from same source", () => {
    expect(checkExternalChat("irc", "irc:alice", "hello there").ok).toBe(true);
    expect(checkExternalChat("irc", "irc:alice", "hello there").ok).toBe(false);
    expect(checkExternalChat("irc", "irc:bob", "hello there").ok).toBe(true);
  });
});