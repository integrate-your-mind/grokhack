import { describe, it, expect, beforeEach } from "vitest";
import util from "node:util";
import {
  ensureIrcUtilPolyfill,
  getBridgeStatus,
  isBenignUnhandledIrcMessage,
  formatIrcError,
  shouldSuppressIrcOutError,
  installQuietIrcOutError,
} from "./bridge.js";
import { checkExternalChat, resetExternalChatLimits } from "./external-chat.js";

describe("IRC util polyfill", () => {
  it("ensureIrcUtilPolyfill provides util.log with apply", () => {
    // Simulate modern Node without util.log
    const u = util as typeof util & { log?: (...args: unknown[]) => void };
    const saved = u.log;
    // @ts-expect-error force-delete for test
    delete u.log;
    expect(typeof u.log).toBe("undefined");

    ensureIrcUtilPolyfill();
    expect(typeof u.log).toBe("function");
    // This is the exact crash path in irc-upd self.out.error
    expect(() => u.log!.apply(u, ["ERROR:", "test", ""])).not.toThrow();

    // restore if we had one (polyfill stays — fine for process)
    if (saved) u.log = saved;
  });

  it("getBridgeStatus exposes irc fields", () => {
    const s = getBridgeStatus();
    expect(s.irc).toBeDefined();
    expect(typeof s.irc.enabled).toBe("boolean");
    expect(s.irc.server).toBeTruthy();
    expect(s.irc.channel).toMatch(/^#/);
    expect(s.irc).toHaveProperty("connected");
    expect(s.irc).toHaveProperty("inChannel");
    expect(s.irc).toHaveProperty("lastError");
    expect(s.irc).toHaveProperty("reconnects");
    expect(typeof s.irc.reconnects).toBe("number");
    expect(s.irc).toHaveProperty("registeredAt");
    expect(s.externalLimits.tiers.irc).toEqual({ max: 3, windowMs: 30_000 });
  });
});

describe("benign unhandled WHOIS / secure messages", () => {
  it("treats rpl_whoissecure (671) as benign", () => {
    expect(
      isBenignUnhandledIrcMessage({
        prefix: "cadmium.libera.chat",
        server: "cadmium.libera.chat",
        command: "rpl_whoissecure",
        rawCommand: "671",
        commandType: "reply",
        args: ["GrokHack", "GrokHack", "is using a secure connection [TLSv1.3]"],
      })
    ).toBe(true);
  });

  it("treats numeric 338 (actually using host) as benign", () => {
    expect(
      isBenignUnhandledIrcMessage({
        prefix: "lithium.libera.chat",
        command: "338",
        rawCommand: "338",
        commandType: "normal",
        args: ["GrokHack", "GrokHack", "2607:fb90::1", "actually using host"],
      })
    ).toBe(true);
  });

  it("treats other rpl_whois* replies as benign", () => {
    expect(isBenignUnhandledIrcMessage({ command: "rpl_whoiscertfp", rawCommand: "276" })).toBe(
      true
    );
    expect(isBenignUnhandledIrcMessage({ command: "rpl_whoisbot", rawCommand: "335" })).toBe(true);
  });

  it("does not treat real errors as benign", () => {
    expect(isBenignUnhandledIrcMessage({ command: "err_bannedfromchan", rawCommand: "474" })).toBe(
      false
    );
    expect(isBenignUnhandledIrcMessage({ command: "privmsg", args: ["#c", "hi"] })).toBe(false);
    expect(isBenignUnhandledIrcMessage(null)).toBe(false);
    expect(isBenignUnhandledIrcMessage("boom")).toBe(false);
  });

  it("shouldSuppressIrcOutError matches library unhandled log shape", () => {
    const whoisSecure = {
      command: "rpl_whoissecure",
      rawCommand: "671",
      args: ["GrokHack", "GrokHack", "secure"],
    };
    expect(shouldSuppressIrcOutError(["Unhandled message:", whoisSecure])).toBe(true);
    expect(
      shouldSuppressIrcOutError([
        "Unhandled message:",
        { command: "338", rawCommand: "338", args: ["a", "b", "host"] },
      ])
    ).toBe(true);
    // Real errors must not be suppressed
    expect(shouldSuppressIrcOutError(["connection reset"])).toBe(false);
    expect(
      shouldSuppressIrcOutError([
        "Unhandled message:",
        { command: "err_bannedfromchan", rawCommand: "474" },
      ])
    ).toBe(false);
  });

  it("installQuietIrcOutError swallows benign unhandled and passes real errors", () => {
    const calls: unknown[][] = [];
    const client = {
      out: {
        showErrors: true,
        error(...args: unknown[]) {
          calls.push(args);
        },
      },
    };
    installQuietIrcOutError(client);

    client.out.error("Unhandled message:", {
      command: "rpl_whoissecure",
      rawCommand: "671",
    });
    client.out.error("Unhandled message:", { command: "338", rawCommand: "338" });
    client.out.error("real problem");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["real problem"]);
  });
});

describe("formatIrcError", () => {
  it("formats Error, string, and IRC message objects", () => {
    expect(formatIrcError(new Error("socket hang up"))).toBe("socket hang up");
    expect(formatIrcError("plain")).toBe("plain");
    expect(
      formatIrcError({
        command: "err_nicknameinuse",
        rawCommand: "433",
        args: ["*", "GrokHack", "Nickname is already in use"],
      })
    ).toContain("err_nicknameinuse");
    expect(formatIrcError(null)).toBe("unknown");
  });
});

describe("IRC inbound path (external-chat)", () => {
  beforeEach(() => resetExternalChatLimits());

  it("rate-limits irc tier at 3/30s", () => {
    expect(checkExternalChat("irc", "irc:alice", "one").ok).toBe(true);
    expect(checkExternalChat("irc", "irc:alice", "two").ok).toBe(true);
    expect(checkExternalChat("irc", "irc:alice", "three").ok).toBe(true);
    expect(checkExternalChat("irc", "irc:alice", "four").ok).toBe(false);
  });
});

describe("getBridgeStatus shape contract", () => {
  it("reports disconnected defaults when bridge not started in this process", () => {
    const s = getBridgeStatus();
    // Without startChatBridge in unit tests, socket flags stay false
    expect(s.irc.connected).toBe(false);
    expect(s.irc.inChannel).toBe(false);
    expect(s.irc.reconnects).toBe(0);
    expect(s.irc.channel).toBe(process.env.IRC_CHANNEL || "#grokhack");
    expect(s.irc.nick).toBe(process.env.IRC_NICK || "GrokHack");
  });
});
