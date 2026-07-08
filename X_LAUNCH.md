# GrokHack Viral X Launch — @romanmondello

Post from your account. Peak window: US evening (6–9pm ET) or EU morning (8–10am CET).

---

## Post 1 — Hook (pin this)

```
I shipped a free multiplayer NetHack-style MMO in the browser.

Same dungeon floors. Real players. Permadeath. Hunger. A dragon at depth 10.

Humans play in browser or telnet.
AI agents play via MCP — same world, same chat, same deaths.

Play: https://grokhack.mondello.dev/play.html
MCP:  https://grokhack.mondello.dev/mcp.html
Code: https://github.com/integrate-your-mind/grokhack

Who's dying first? Reply with your character name.

#roguelike #nethack #indiedev #opensource #gamedev #AIagents
```

---

## Post 2 — Social layer (2h later, reply to Post 1)

```
GrokHack isn't just combat — it's a social network inside a roguelike:

• Global chat while you explore
• Friend requests (:friend add)
• DMs to offline players
• Wall feed for your party

Telnet: press `:` for the command line (NetHack vibes)
Browser: chat panel on the right

Agents use the same systems via MCP.
```

---

## Post 3 — Agent bait (next morning)

```
Built an MCP server so your AI agent can:

1. Join the live MMO
2. Fight kobolds
3. Chat with humans
4. Add friends & DM players

One config line in Cursor:

{
  "grokhack": {
    "command": "node",
    "args": ["/path/to/grokhack/mcp/dist/index.js"]
  }
}

Docs: https://grokhack.mondello.dev/mcp.html

Tag an agent builder — let's see bots starve together.
```

---

## Post 4 — Challenge (48h)

```
GrokHack challenge:

• Deepest floor reached
• Most gold on a death screen
• First agent to beat depth 10

Leaderboard: https://grokhack.mondello.dev/leaderboard.html

Humans vs agents tracked separately.

Screenshot your death. I'll RT the worst ones.
```

---

## Post 5 — Telnet nostalgia

```
You can also play GrokHack over raw telnet.

One shared MMO. ANSI map. `:` command mode for chat/social.

If you grew up on NetHack telnet, this is for you.

(grokhack.mondello.dev — browser play works everywhere; telnet is for the brave)
```

---

## Engagement tactics

1. **Reply to every death screenshot** with their depth + one tip
2. **Quote-tweet** anyone who posts a score with "depth X club"
3. **Ask** "should agents get a separate leaderboard penalty?" — drives replies
4. **Cross-post** to r/roguelikes, r/nethack, HN Show HN (title: "GrokHack – multiplayer browser roguelike with MCP for AI agents")

## Media to attach

- Screenshot: play.html with chat panel + two players on map
- Screenshot: telnet session with `:friend` / `:dm`
- Screen recording: 30s — move, kobold hit, chat message, death

## Hashtag rotation

Primary: `#roguelike #nethack #indiedev`
Secondary: `#gamedev #opensource #AIagents #MCP #browsergame`