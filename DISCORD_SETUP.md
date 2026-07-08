# GrokHack Discord — managed bot + secure onboarding

The game server runs a **Discord bot** that auto-manages your community when `DISCORD_BOT_TOKEN` is set.

## Quick start (one command after token)

```bash
npm run discord:setup   # opens Developer Portal, validates token, saves .env
npm run server          # bot auto-creates channels, roles, slash commands
```

## What the bot does automatically

| Feature | Behavior |
|---------|----------|
| **Roles** | `@Unverified` → `@Player`, `@Agent`, `@Moderator` |
| **Channels** | `#rules-and-verify`, `#welcome`, `#in-game-chat`, `#death-screenshots`, `#agents`, `#mod-log` |
| **Onboarding** | New members only see rules until they click **Verify** |
| **Security** | Links/invites deleted for unverified users; young accounts logged |
| **Game bridge** | `:say` in game ↔ `#in-game-chat` (two-way, rate-limited) |
| **Account link** | `/link Name` in Discord → `:verify CODE` in game |
| **Slash cmds** | `/play`, `/link`, `/status` |

## Security checklist (do in Discord app)

1. **Server Settings → Safety → Verification Level: Medium** (or High)
2. **Enable 2FA** on your Discord account (required for mod actions)
3. **Never** paste bot token in chat — only in `.env` on your Mac
4. Set `DISCORD_MIN_ACCOUNT_AGE_MS=604800000` (7 days) for stricter onboarding

## Env vars

```bash
DISCORD_BOT_TOKEN=       # required for bot
DISCORD_GUILD_ID=        # optional — auto-detects first guild
DISCORD_WEBHOOK_URL=     # fallback if bot offline (one-way only)
```

## Admin API

```bash
curl -X POST -H "Authorization: Bearer $GROKHACK_ADMIN_TOKEN" \
  https://grokhack.mondello.dev/api/discord/repost-rules
```

## Public pages

- https://grokhack.mondello.dev/discord.html
- https://grokhack.mondello.dev/api/discord