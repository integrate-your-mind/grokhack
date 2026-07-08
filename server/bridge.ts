/**
 * Bridges in-game global chat to IRC (Libera #grokhack) and Discord webhook.
 * Set DISCORD_WEBHOOK_URL to enable Discord relay.
 * IRC is on by default (IRC_ENABLED=0 to disable).
 */

import { Client } from "irc-upd";

export interface BridgeHooks {
  onExternalChat: (from: string, text: string, channel: "irc" | "discord") => void;
}

let irc: Client | null = null;
let hooks: BridgeHooks | null = null;
let ircConnected = false;

const IRC_SERVER = process.env.IRC_SERVER || "irc.libera.chat";
const IRC_CHANNEL = process.env.IRC_CHANNEL || "#grokhack";
const IRC_NICK = process.env.IRC_NICK || "GrokHack";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";

export function startChatBridge(h: BridgeHooks): void {
  hooks = h;
  if (process.env.IRC_ENABLED === "0") {
    console.log("[bridge] IRC disabled (IRC_ENABLED=0)");
    return;
  }

  try {
    irc = new Client(IRC_SERVER, IRC_NICK, {
      port: 6697,
      secure: true,
      channels: [IRC_CHANNEL],
      realName: "GrokHack MMO — https://grokhack.mondello.dev",
      showErrors: true,
      retryCount: null,
      retryDelay: 5000,
    });

    irc.on("registered", () => {
      ircConnected = true;
      console.log(`[bridge] IRC connected as ${IRC_NICK} → ${IRC_CHANNEL}`);
    });

    irc.on("close", () => {
      ircConnected = false;
    });

    irc.on("error", (err: Error) => {
      console.error("[bridge] IRC error:", err.message);
    });

    irc.on("message", (from: string, _to: string, text: string) => {
      if (from === IRC_NICK) return;
      if (!text.trim() || text.startsWith("\x01")) return;
      hooks?.onExternalChat(from, text.trim(), "irc");
    });
  } catch (err) {
    console.error("[bridge] IRC startup failed (game still runs):", err);
    irc = null;
  }
}

export function bridgeOutboundChat(playerName: string, text: string): void {
  const line = `<${playerName}> ${text}`;

  if (irc && ircConnected) {
    try {
      irc.say(IRC_CHANNEL, line);
    } catch (err) {
      console.error("[bridge] IRC say failed:", err);
    }
  }

  if (DISCORD_WEBHOOK) {
    fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "GrokHack",
        content: `**[game] ${playerName}:** ${text.slice(0, 1800)}`,
      }),
    }).catch((err) => console.error("[bridge] discord:", err));
  }
}

export function bridgeSystemMessage(text: string): void {
  if (irc && ircConnected) {
    try {
      irc.say(IRC_CHANNEL, `[grokhack] ${text}`);
    } catch {
      /* ignore */
    }
  }
}

export function getBridgeStatus() {
  return {
    irc: {
      enabled: process.env.IRC_ENABLED !== "0",
      server: IRC_SERVER,
      channel: IRC_CHANNEL,
      connected: ircConnected,
    },
    discord: {
      enabled: Boolean(DISCORD_WEBHOOK),
    },
  };
}