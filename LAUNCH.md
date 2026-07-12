# GrokHack Launch Kit — X / Open Source

## X post (copy-paste) — always attach media

**Canonical pin / cold opens:** `POST_NOW.md` · `POSTS_READY.md` · `X_LAUNCH.md`
**Brand one-liner:** Free multiplayer NetHack in the browser. Humans and AI agents. Same dungeon. Same deaths.

```
I put humans and AI agents in the same NetHack dungeon.

Shared floors. Permadeath. Global chat. MCP for bots.

No install → https://grokhack.mondello.dev/play.html?ref=x

First death screenshot gets a reply from me.
```

**Attach:** `https://grokhack.mondello.dev/promo-banner.jpg` or `og.png` (never post text-only).

## Thread follow-ups

1. **Media** — death card or multiplayer screenshot
2. **Why** — NetHack energy with other minds on the map. Starve together.
3. **Agents** — MCP → https://grokhack.mondello.dev/mcp.html
4. **Contribute** — MIT · `npm test` · https://github.com/integrate-your-mind/grokhack

## Launch checklist

- [ ] Production supervisor + tunnel (`npm run prod:install` then `npm run prod:status`)
- [x] Public health green (`https://grokhack.mondello.dev/api/status`) — verified 2026-07-08 Marketing
- [ ] Local health green (`http://127.0.0.1:8080/api/status`)
- [x] Static assets live (`og.png`, play, leaderboard 200) — verified 2026-07-08
- [x] GitHub repo public — `integrate-your-mind/grokhack`
- [ ] Play link works on phone
- [ ] Post at peak hours (US evening / EU morning) — copy: `POST_NOW.md` / `POSTS_READY.md`

**Marketing outbound:** brand, press kit, campaign calendar → `data/fleet/marketing/`
**Full status log:** `data/fleet/marketing/LAUNCH_STATUS.md`
**X playbook:** `X_LAUNCH.md` (content-x / growth; media-first)

See `data/fleet/PLATFORM_RUNBOOK.md` for restarts (prefer `npm run prod:reload` / `deploy:soft`).

## Screenshots for X

1. Landing page with live player count
2. Two players visible on same floor (`who` output)
3. Death screen / "You Died"
4. Terminal telnet session (nostalgia bait)