#!/usr/bin/env node
/**
 * GrokHack Discord bot setup — run once to get invite URL and validate token.
 * Usage: DISCORD_BOT_TOKEN=xxx npm run discord:setup
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const envPath = join(root, ".env");

const PERMS = "1099780198434"; // manage roles/channels, moderate, messages

function loadEnv() {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const envFile = loadEnv();
const token = process.env.DISCORD_BOT_TOKEN || envFile.DISCORD_BOT_TOKEN || "";

console.log(`
╔══════════════════════════════════════════════════════════╗
║           GrokHack Discord — secure onboarding           ║
╚══════════════════════════════════════════════════════════╝
`);

if (!token) {
  console.log(`No DISCORD_BOT_TOKEN yet. Do this once (~10 min):

1. CREATE SERVER (Discord app)
   • Discord → + → Create My Own → "GrokHack"
   • Enable Server Settings → Safety → Verification Level: **Medium**

2. CREATE BOT (Developer Portal)
   • https://discord.com/developers/applications → New Application → "GrokHack Bot"
   • Bot → Reset Token → copy token
   • Bot → Privileged Gateway Intents → enable **Server Members Intent** + **Message Content Intent**
   • OAuth2 → URL Generator:
     - Scopes: bot, applications.commands
     - Permissions: Manage Roles, Manage Channels, Moderate Members, Send Messages, Manage Messages
   • Copy generated URL → open in browser → select your GrokHack server

3. SAVE TOKEN (never commit)
   echo 'DISCORD_BOT_TOKEN=YOUR_TOKEN' >> .env
   # Optional: DISCORD_GUILD_ID=your_server_id (right-click server → Copy Server ID)

4. START SERVER
   npm run server

The bot auto-creates channels, roles, verify button, and slash commands (/play /link /status).
`);
  try {
    execSync("open https://discord.com/developers/applications", { stdio: "ignore" });
  } catch { /* headless */ }
  process.exit(1);
}

let clientId = process.env.DISCORD_CLIENT_ID || envFile.DISCORD_CLIENT_ID;
if (!clientId && token.includes(".")) {
  try {
    clientId = Buffer.from(token.split(".")[0], "base64").toString("utf8");
  } catch { /* ignore */ }
}

const me = await fetch("https://discord.com/api/v10/users/@me", {
  headers: { Authorization: `Bot ${token}` },
}).then((r) => r.json());

if (me.code) {
  console.error("Invalid token:", me.message);
  process.exit(1);
}

console.log(`✓ Bot: ${me.username}#${me.discriminator || "0"} (${me.id})`);

const invite = `https://discord.com/api/oauth2/authorize?client_id=${clientId || me.id}&permissions=${PERMS}&scope=bot%20applications.commands`;
console.log(`\nInvite URL (if not yet added to server):\n${invite}\n`);

if (!existsSync(envPath) || !envFile.DISCORD_BOT_TOKEN) {
  const line = `DISCORD_BOT_TOKEN=${token}\n`;
  writeFileSync(envPath, (existsSync(envPath) ? readFileSync(envPath, "utf8") : "") + line, { flag: "a" });
  console.log("✓ Appended DISCORD_BOT_TOKEN to .env (gitignored)");
}

console.log(`Next: npm run server — bot will auto-setup #rules-and-verify, roles, and onboarding.`);
try {
  execSync(`open "${invite}"`, { stdio: "ignore" });
} catch { /* ignore */ }