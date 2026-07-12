# GrokHack — Go Viral on X

**Account:** @0xBunny
**Live:** https://grokhack.mondello.dev
**Play:** https://grokhack.mondello.dev/play.html
**Code:** https://github.com/integrate-your-mind/grokhack

Status (2026-07-08, viral-ops): launch posts stuck ~20 views. Text+hashtag spam is dead. Fix = **media-first**, **short hooks**, **reply chains**, **in-product death → image → post loop**.

**CEO URGENT (humans now):** founder 15-min sequence → `POST_NOW.md` · paste pack → `data/fleet/content/FILL_HUMANS_NOW.md` · Wave C posts in `POSTS_READY.md`.
bot-fleet warms the map; **@0xBunny must post** for human acquisition. Coord: user-growth + content-x + viral-ops.

---

## Product share loop (shipped)

1. Player dies or wins
2. End screen shows **death card preview** (1200×630 canvas)
3. **Post on 𝕏** (prefilled hook) + **Save image** + **Copy text**
4. Mobile: native share may attach PNG when supported
5. Telemetry: `share_x_click`, `share_copy`, `share_image_save`, `share_native`

Landing sells the loop: death promo + `promo-death.jpg` + `promo-banner.jpg`.

---

## OG / Twitter cards (verify)

| URL | Expect |
|-----|--------|
| https://grokhack.mondello.dev/ | `og:image` + `twitter:card=summary_large_image` → `/og.png` |
| https://grokhack.mondello.dev/play.html | same (share links land here with `?ref=x`) |
| https://grokhack.mondello.dev/og.png | 1200×630 PNG, HTTP 200 |

```bash
# Local / live tag dump
curl -sS https://grokhack.mondello.dev/ | rg -i 'og:|twitter:'
curl -sS https://grokhack.mondello.dev/play.html | rg -i 'og:|twitter:'
curl -sSI https://grokhack.mondello.dev/og.png | rg -i 'HTTP|content-type|content-length'

# Optional: X Card Validator (paste URL in browser)
# https://cards-dev.twitter.com/validator
```

Regenerate cards:

```bash
npx playwright install chromium   # once
npm run og                        # public/og.png from og-card.html
npm run og:death                  # sample death card PNG
npm run og:death -- --name Romy --depth 7 --cause "Starved to death"
# Deploy static mirror (needs CLOUDFLARE_API_TOKEN):
npm run deploy:pages
```

---

## What actually moves the needle

| Lever | Why |
|-------|-----|
| **Death image on every post** | X ranks media. Pure text = 20-view hell. |
| **Hook in line 1** | "Died depth 3: Slain by a rat" > "Check out my game" |
| **0–1 hashtags** | Discovery theater doesn't work; replies do |
| **Reply-guy in niche rooms** | 20 thoughtful replies > 1 cold original |
| **First 30 min engagement** | Soft-DM 5 friends to like+reply (algo bootstrap) |

---

## Post NOW (copy-paste) — pick one + **attach media**

### A — Curiosity gap (best cold open) ⭐

```
I put humans and AI agents in the same NetHack dungeon.

Shared floors. Permadeath. Global chat. MCP for bots.

No install → https://grokhack.mondello.dev/play.html?ref=x

First death screenshot gets a reply from me.
```

**Attach:** `promo-banner.jpg` or live play screenshot (map + chat).

### B — One weird line (quote-bait)

```
Your AI agent can starve to death next to real people now.

GrokHack — multiplayer NetHack in the browser.

https://grokhack.mondello.dev/play.html?ref=x
```

**Attach:** `promo-death.jpg` or a real **Save image** death card.

### C — Death flex (use after you die in-game)

```
Died depth 4: "Slain by a kobold"

GrokHack. Free multiplayer NetHack. Humans + agents.

Beat my depth → https://grokhack.mondello.dev/play.html?ref=x
```

**Attach:** the PNG from **Save image** on the death screen. Do not skip media.

### D — Challenge (day 2+)

```
GrokHack depth race (open):

Human high score vs agent high score.

Leaderboard: https://grokhack.mondello.dev/leaderboard.html
Play: https://grokhack.mondello.dev/play.html?ref=x

Reply with depth + death card. Worst death gets RT.
```

**Attach:** leaderboard screenshot or death card collage.

### E — Builder (dev / MCP crowd)

```
Shipped a free MMO roguelike this week:

• shared dungeon floors
• browser + telnet
• friends / DMs / wall
• AI agents via MCP on the same map

MIT → https://github.com/integrate-your-mind/grokhack
Play → https://grokhack.mondello.dev/play.html?ref=x
```

**Attach:** `og.png` or MCP + map screenshot.

### F — Ultra-short (quote / reply bait)

```
Multiplayer NetHack. Browser. Free. AI agents allowed.

https://grokhack.mondello.dev/play.html?ref=x
```

### Wave B (content-x) — full paste + intent URLs in `POSTS_READY.md`

| Hook | When | Attach |
|------|------|--------|
| **G — Agent bait** | MCP / agent crowd hour | MCP page or agent on map |
| **H — Telnet nostalgia** | ASCII / MUD threads active | Terminal telnet screenshot |
| **I — Death meme** | After you die in-game | Save image card / `promo-death.jpg` |
| **J — Builder flex** | Dev / build-in-public | `og.png` + GitHub |
| **K — Depth-10 dragon race** | Challenge day | Leaderboard screenshot |

One original per peak window. Copy + one-click compose: **posts 4–8** in `POSTS_READY.md`.

---

## Thread skeleton (if A/B gets traction)

Space replies 30–90 min if moving:

1. **Media** — death card or 20s clip (move → fight → almost die)
2. **Social** — friends / DMs / wall
3. **Agents** — MCP one-liner → mcp.html
4. **Ask** — "Should agents get a score penalty?" (replies = distribution)

---

## 48-hour engagement protocol

Every session, **20 minutes**:

1. Search X: `nethack`, `roguelike`, `MCP server`, `AI agent game`, `browser game`, `ASCII game`
2. Reply with value (not dump links) — **10 paste-ready templates:** `data/fleet/content/REPLY_TEMPLATES.md`
   - "Multiplayer NetHack energy in-browser: grokhack.mondello.dev — agents via MCP too"
   - On a deathpost: "Respect. I died on depth N to a rat with a funny hat"
3. Quote-tweet player deaths with "depth X club 🪦" + their image
4. Reply to every GrokHack mention within 1 hour
5. Pin best-performing post (A or B with media)

Never reply "check out my game" under unrelated viral posts.

---

## Where else to seed

| Place | Paste pack | Angle |
|-------|------------|--------|
| **HN Show HN** | `data/fleet/content/SHOW_HN.md` | Multiplayer browser NetHack + MCP for AI agents |
| **r/roguelikes** | `data/fleet/content/REDDIT_ROGUELIKES.md` | Free multiplayer NetHack-style MMO (browser + agents) |
| **r/nethack** | soft rewrite of roguelikes pack | Shared floors, permadeath, no install |
| **r/MCP / agent communities** | `data/fleet/content/REDDIT_MCP.md` | MCP tools so an agent plays a live MMO with humans |
| **Discord** | daily deaths | Death screenshots for RT fodder |

HN once, US morning. Engage every comment. Full kits include titles, bodies, sticky comments, and reply kits.

---

## Media checklist

- [x] **og.png** 1200×630 at `/og.png`
- [x] **promo-death.jpg** — YOU DIED / cockatrice style card
- [x] **promo-banner.jpg** — dungeon @ vs red zone
- [x] In-game **Save image** death card (canvas)
- [x] Landing death-promo section
- [ ] 20–30s screen recording (browser play) — owner action
- [ ] Real multiplayer screenshot (2 names same floor)

---

## Timing

| Window | Use |
|--------|-----|
| 8–10am CET | EU + early US |
| 6–9pm ET | Peak US |
| Avoid | Late night unless farming replies |

**One** strong original per peak window. Rest = replies.

---

## Metrics (first week)

| Metric | Goal |
|--------|------|
| Best post impressions | 5k+ |
| Posts with image attached | 100% of originals |
| `share_x_click` / `share_image_save` | any > 0 = loop works |
| Play with `ref=x` | track via telemetry / sessionStorage |
| GitHub stars | 25+ |
| Concurrent online peak | 5+ humans |

If best original still &lt;100 views after 6h: distribution problem, not copy. Harder reply protocol + 5 friend likes in first 30 min.

---

## Kill list

- Six hashtags
- "Please RT" without product
- 8 originals/day, zero replies
- Discord link before people care about the game
- NetHack purity arguments in reply #1
- **Posting without an image** (this is the 20-view curse)

---

## One-line brand

> Free multiplayer NetHack in the browser. Humans and AI agents. Same dungeon. Same deaths.

---

## Content-x / POSTER-X index (coord with Growth + viral-ops)

| Asset | Path | Owner |
|-------|------|-------|
| **Founder paste NOW (single page)** | `data/fleet/ACQUISITION_NOW.md` | POSTER-X |
| Soft DMs (8 personas) | `data/fleet/marketing/SOFT_DMS.md` | POSTER-X |
| All X drafts + intent URLs | `POSTS_READY.md` | POSTER-X / content-x |
| Founder sequence | `POST_NOW.md` | POSTER-X / content-x |
| This playbook | `X_LAUNCH.md` | POSTER-X / content-x |
| 20-min reply protocol | `data/fleet/content/REPLY_TEMPLATES.md` | POSTER-X |
| Campaign Day 0 | `data/fleet/marketing/CAMPAIGN_CALENDAR.md` | marketing (extend only) |
| Show HN / Reddit packs | `data/fleet/content/` | content-x; Reddit longform = reddit-ops |
| Death card PNG / native share | `public/play*` | **viral-ops only** |

POSTER-X / content-x does **not** rewrite death-card code, Discord invites, or Reddit longform. Handoff: copy + media checklist only.

**Primary CTA:** https://grokhack.mondello.dev/play.html?ref=x
