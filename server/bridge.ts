/**
 * Bridges in-game global chat to IRC (Libera #grokhack) and Discord webhook.
 * Set DISCORD_WEBHOOK_URL to enable Discord relay.
 * IRC is on by default (IRC_ENABLED=0 to disable).
 */

import util from "node:util";
import { Client } from "irc-upd";
import { discordOutboundChat, getDiscordBotStatus } from "./discord-bot.js";
import { checkExternalChat, externalChatLimits } from "./external-chat.js";

/**
 * irc-upd still calls util.log for showErrors/debug; Node 22+ removed util.log,
 * which crashes as: Cannot read properties of undefined (reading 'apply').
 * Patch the shared util singleton before any IRC Client is constructed.
 */
function formatLogArg(a: unknown): string {
  if (a == null) return String(a);
  if (typeof a === "string") return a;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a);
    } catch {
      return Object.prototype.toString.call(a);
    }
  }
  return String(a);
}

export function ensureIrcUtilPolyfill(): void {
  const u = util as typeof util & { log?: (...args: unknown[]) => void };
  if (typeof u.log !== "function") {
    u.log = (...args: unknown[]) => {
      // Match historic util.log: timestamp + args (objects as JSON)
      console.log(new Date().toISOString(), ...args.map(formatLogArg));
    };
  }
}

ensureIrcUtilPolyfill();

/** Shape of an irc-upd parsed message (subset we care about). */
export interface IrcRawMessage {
  command?: string;
  rawCommand?: string;
  commandType?: string;
  args?: string[];
  prefix?: string;
  server?: string;
  nick?: string;
}

/**
 * Libera (and other modern nets) send extra WHOIS replies that irc-upd does not
 * handle. After register it auto-WHOIS's itself, so every connect logs:
 *   ERROR: Unhandled message: rpl_whoissecure (671)
 *   ERROR: Unhandled message: 338 (actually using host)
 * These are informational, not failures.
 */
const BENIGN_UNHANDLED_COMMANDS = new Set([
  // Named codes (codes.js)
  "rpl_whoissecure", // 671 TLS/secure connection
  "rpl_whoisbot",
  "rpl_whoishost",
  "rpl_whoismodes",
  "rpl_whoisaccount",
  "rpl_whoisspecial",
  "rpl_whoiscertfp",
  "rpl_whoisactually",
  // Raw numerics not always mapped / not in switch
  "671", // rpl_whoissecure
  "338", // actually using host
  "276", // has client certificate / certfp variants
  "307", // is a registered nick (some nets)
  "320", // special WHOIS line
  "378", // is connecting from …
  "379", // is using modes …
  "330", // already handled by library, listed for completeness
]);

/** True when an unhandled IRC message is expected noise (WHOIS extras, etc.). */
export function isBenignUnhandledIrcMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as IrcRawMessage;
  const cmd = (m.command || "").toLowerCase();
  const raw = String(m.rawCommand || "");
  if (cmd && BENIGN_UNHANDLED_COMMANDS.has(cmd)) return true;
  if (raw && BENIGN_UNHANDLED_COMMANDS.has(raw)) return true;
  // Catch-all: any remaining whois* named reply we didn't list
  if (cmd.startsWith("rpl_whois")) return true;
  return false;
}

/**
 * Format anything irc-upd may pass to error/unhandled handlers into a short string.
 * Message objects have .command/.args, not Error.message.
 */
export function formatIrcError(err: unknown): string {
  if (err == null) return "unknown";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object") {
    const m = err as IrcRawMessage & { message?: string };
    if (typeof m.message === "string" && m.message) return m.message;
    const cmd = m.command || m.rawCommand || "msg";
    const args = Array.isArray(m.args) ? m.args.join(" ") : "";
    const line = args ? `${cmd}: ${args}` : String(cmd);
    return line.slice(0, 200);
  }
  return String(err);
}

/**
 * Whether an out.error call is the library's "Unhandled message:" log for a
 * benign WHOIS/secure reply. Used to keep logs clean without muting real errors.
 */
export function shouldSuppressIrcOutError(args: unknown[]): boolean {
  if (args.length < 1) return false;
  const head = args[0];
  const isUnhandledLabel =
    typeof head === "string" &&
    (head === "Unhandled message:" || head.includes("Unhandled message"));
  if (!isUnhandledLabel) return false;
  // Second arg is the message object (or sole arg if label is embedded)
  const msg = args.find((a) => a && typeof a === "object");
  if (msg) return isBenignUnhandledIrcMessage(msg);
  // String-only path after JSON polyfill: "Unhandled message: {...whois...}"
  if (typeof head === "string") {
    const lower = head.toLowerCase();
    if (lower.includes("whois") || lower.includes('"671"') || lower.includes('"338"')) {
      return true;
    }
  }
  return false;
}

/**
 * Wrap irc-upd's out.error so benign WHOIS unhandled lines never hit util.log.
 * Real protocol errors still log.
 */
export function installQuietIrcOutError(client: {
  out?: { error?: (...args: unknown[]) => void; showErrors?: boolean; showDebug?: boolean };
}): void {
  const out = client.out;
  if (!out || typeof out.error !== "function") return;
  const original = out.error.bind(out);
  out.error = (...args: unknown[]) => {
    if (shouldSuppressIrcOutError(args)) return;
    original(...args);
  };
}

export interface BridgeHooks {
  onExternalChat: (from: string, text: string, channel: "irc" | "discord") => void;
}

let irc: Client | null = null;
let hooks: BridgeHooks | null = null;
let ircConnected = false;
let ircInChannel = false;
let ircLastError: string | null = null;
let ircRegisteredAt: number | null = null;
let ircReconnects = 0;

const IRC_SERVER = process.env.IRC_SERVER || "irc.libera.chat";
const IRC_CHANNEL = process.env.IRC_CHANNEL || "#grokhack";
const IRC_NICK = process.env.IRC_NICK || "GrokHack";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";

function stripIrcFormatting(text: string): string {
  // Strip CTCP, mIRC colors/bold/etc. keep readable text
  return text
    .replace(/\x01/g, "")
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "")
    .replace(/[\x02\x0f\x16\x1d\x1f]/g, "")
    .trim();
}

function markDisconnected(reason?: string): void {
  const wasUp = ircConnected;
  ircConnected = false;
  ircInChannel = false;
  if (reason) ircLastError = reason.slice(0, 200);
  if (wasUp) {
    console.log("[bridge] IRC connection closed — will retry");
  }
}

export function startChatBridge(h: BridgeHooks): void {
  hooks = h;
  ensureIrcUtilPolyfill();

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
      autoRejoin: true,
      retryCount: null,
      retryDelay: 5000,
      floodProtection: true,
      floodProtectionDelay: 1000,
    });

    // Mute expected Libera WHOIS extras without disabling real error logging
    installQuietIrcOutError(irc);

    irc.on("registered", () => {
      ircConnected = true;
      ircLastError = null;
      ircRegisteredAt = Date.now();
      console.log(`[bridge] IRC connected as ${IRC_NICK} → ${IRC_CHANNEL}`);
    });

    irc.on("join", (channel: string, nick: string) => {
      if (nick === IRC_NICK && channel.toLowerCase() === IRC_CHANNEL.toLowerCase()) {
        ircConnected = true;
        ircInChannel = true;
      }
    });

    irc.on("part", (channel: string, nick: string) => {
      if (nick === IRC_NICK && channel.toLowerCase() === IRC_CHANNEL.toLowerCase()) {
        ircInChannel = false;
      }
    });

    irc.on("kick", (channel: string, nick: string) => {
      if (nick === IRC_NICK && channel.toLowerCase() === IRC_CHANNEL.toLowerCase()) {
        ircInChannel = false;
        // autoRejoin is on; stay "connected" at protocol level
      }
    });

    irc.on("close", () => {
      if (ircConnected) ircReconnects += 1;
      markDisconnected();
    });

    irc.on("abort", () => {
      markDisconnected("abort (max retries)");
      console.error("[bridge] IRC aborted reconnects");
    });

    irc.on("netError", (err: unknown) => {
      const msg = formatIrcError(err);
      markDisconnected(msg);
      console.error("[bridge] IRC net error:", msg);
    });

    irc.on("error", (err: unknown) => {
      const msg = formatIrcError(err);
      // Ignore noisy util.log leftovers if any still surface
      if (msg.includes("reading 'apply'")) {
        ensureIrcUtilPolyfill();
        return;
      }
      // Protocol error objects for benign unhandled should not reach here, but belt-and-suspenders
      if (isBenignUnhandledIrcMessage(err)) return;
      ircLastError = msg.slice(0, 200);
      console.error("[bridge] IRC error:", msg);
    });

    // Sink unhandled events so nothing else treats them as failures
    irc.on("unhandled", (message: unknown) => {
      if (isBenignUnhandledIrcMessage(message)) return;
      // Unexpected unhandled — log once at warn level (not ERROR via util.log)
      console.warn("[bridge] IRC unhandled:", formatIrcError(message));
    });

    irc.on("message", (from: string, _to: string, text: string) => {
      if (from === IRC_NICK) return;
      const cleaned = stripIrcFormatting(text);
      if (!cleaned) return;
      const decision = checkExternalChat("irc", `irc:${from.toLowerCase()}`, cleaned);
      if (!decision.ok) return;
      hooks?.onExternalChat(from, cleaned, "irc");
    });
  } catch (err) {
    console.error("[bridge] IRC startup failed (game still runs):", err);
    irc = null;
    ircConnected = false;
    ircInChannel = false;
    ircLastError = err instanceof Error ? err.message : String(err);
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

  const bot = getDiscordBotStatus();
  if (bot.ready) {
    discordOutboundChat(playerName, text);
  } else if (DISCORD_WEBHOOK) {
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

/** IRC / Discord action-style emote: * player waves */
export function bridgeOutboundEmote(playerName: string, text: string): void {
  const line = `* ${playerName} ${text}`;

  if (irc && ircConnected) {
    try {
      irc.say(IRC_CHANNEL, line);
    } catch (err) {
      console.error("[bridge] IRC emote failed:", err);
    }
  }

  const bot = getDiscordBotStatus();
  if (bot.ready) {
    discordOutboundChat(playerName, `_${text}_`);
  } else if (DISCORD_WEBHOOK) {
    fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "GrokHack",
        content: `* **${playerName}** ${text.slice(0, 1800)}`,
      }),
    }).catch((err) => console.error("[bridge] discord emote:", err));
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
      nick: IRC_NICK,
      /** Protocol session registered (socket + welcome). */
      connected: ircConnected,
      /** Present in #channel (join completed; autoRejoin may restore). */
      inChannel: ircInChannel,
      lastError: ircLastError,
      registeredAt: ircRegisteredAt,
      reconnects: ircReconnects,
      inboundLimit: "3 msgs / 30s",
    },
    externalLimits: externalChatLimits(),
    discord: getDiscordBotStatus(),
  };
}
