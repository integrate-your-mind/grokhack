#!/usr/bin/env node
/**
 * GrokHack Discord — validate token, save .env, print invite URL.
 * Usage: npm run discord:setup
 *        DISCORD_BOT_TOKEN=xxx npm run discord:setup
 */
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const envPath = join(root, ".env");
const CLIENT_ID = "1524680780741644449";
const PERMS = "1099780198434";

const PORTAL_BOT = `https://discord.com/developers/applications/${CLIENT_ID}/bot`;
const PORTAL_OAUTH = `https://discord.com/developers/applications/${CLIENT_ID}/oauth2`;
const INVITE = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=${PERMS}&scope=bot%20applications.commands`;

function loadEnv() {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function upsertEnv(key, value) {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  content = re.test(content) ? content.replace(re, line) : content + (content.endsWith("\n") ? "" : "\n") + line + "\n";
  writeFileSync(envPath, content);
}

function open(url) {
  try {
    execSync(`open "${url}"`, { stdio: "ignore" });
  } catch { /* headless */ }
}

async function promptToken() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("\nPaste DISCORD_BOT_TOKEN (from Developer Portal → Bot → Reset Token): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log(`
╔══════════════════════════════════════════════════════════╗
║        GrokHack Discord — grokhack app (${CLIENT_ID})   ║
╚══════════════════════════════════════════════════════════╝
`);

let token = process.env.DISCORD_BOT_TOKEN || loadEnv().DISCORD_BOT_TOKEN || "";

if (!token) {
  console.log(`Quick setup (~5 min):

  1. Discord app → + → Create Server → name it "GrokHack"
  2. Opening Developer Portal → Bot tab…
     • Reset Token → copy it
     • Enable: Server Members Intent + Message Content Intent
  3. Paste token below (or re-run with DISCORD_BOT_TOKEN=...)
  4. Opening bot invite → select your GrokHack server
  5. Restart game server: npm run server

Bot auto-creates: @Unverified/@Player roles, #rules-and-verify, #in-game-chat, /play /link /status
`);
  open("https://discord.com/channels/@me");
  open(PORTAL_BOT);
  token = await promptToken();
  if (!token) {
    console.error("\nNo token provided. Exiting.");
    process.exit(1);
  }
}

const me = await fetch("https://discord.com/api/v10/users/@me", {
  headers: { Authorization: `Bot ${token}` },
}).then((r) => r.json());

if (me.code) {
  console.error("Invalid token:", me.message);
  process.exit(1);
}

console.log(`\n✓ Bot: ${me.username} (${me.id})`);

const guilds = await fetch("https://discord.com/api/v10/users/@me/guilds", {
  headers: { Authorization: `Bot ${token}` },
}).then((r) => r.json());

if (Array.isArray(guilds) && guilds.length) {
  console.log(`✓ In ${guilds.length} server(s): ${guilds.map((g) => g.name).join(", ")}`);
  if (!loadEnv().DISCORD_GUILD_ID && guilds.length === 1) {
    upsertEnv("DISCORD_GUILD_ID", guilds[0].id);
    console.log(`✓ Saved DISCORD_GUILD_ID=${guilds[0].id}`);
  }
} else {
  console.log(`\n⚠ Bot not in a server yet. Opening invite URL…`);
  open(INVITE);
}

upsertEnv("DISCORD_CLIENT_ID", CLIENT_ID);
upsertEnv("DISCORD_BOT_TOKEN", token);
console.log("✓ Saved DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID to .env");

console.log(`\nInvite URL:\n${INVITE}\n`);
console.log("Next: restart server → npm run server");
console.log("Community page: https://grokhack.mondello.dev/discord.html");