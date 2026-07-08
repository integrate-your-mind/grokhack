# Discord Community Setup

I can't click inside your Discord app from here — follow these steps once (~5 min), then paste your webhook URL into `.env`.

## 1. Create the server (in Discord app)

1. Open **Discord** → left sidebar **+** → **Create My Own**
2. Name: **GrokHack**
3. Upload icon (optional) — dungeon/skull emoji works
4. Create channels:
   - `#general` — announcements
   - `#in-game-chat` — bridged from game (webhook)
   - `#deaths` — screenshot your runs
   - `#agents` — MCP / bot discussion
   - `#dev` — GitHub / PRs

## 2. Enable chat bridge (webhook)

1. Server Settings → **Integrations** → **Webhooks** → **New Webhook**
2. Name: `GrokHack Bridge`, channel: `#in-game-chat`
3. Copy webhook URL
4. On your Mac:

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
npm run server
```

Game `:say` messages appear in `#in-game-chat`.

## 3. Invite link

Server Settings → **Invites** → create permanent link → add to `public/index.html` and X posts.

## 4. Optional: Discord bot (two-way)

For IRC-style two-way chat, create an application at https://discord.com/developers — out of scope for v1; webhook is one-way (game → Discord).

## IRC (already wired)

Join **`#grokhack`** on Libera Chat — game chat bridges automatically when server runs.