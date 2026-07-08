# GrokHack

A procedurally generated roguelike inspired by NetHack. Descend through 10 dungeon levels, fight monsters, manage hunger, collect loot, and slay the dragon.

**Now with a massively multiplayer telnet server** — play in your terminal like classic NetHack, alongside other adventurers on shared dungeon floors.

## Play (Browser — single player)

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually http://localhost:5173).

## Play (Terminal — multiplayer MMO)

Start the server:

```bash
npm run server
```

Connect via telnet (in another terminal):

```bash
telnet localhost 4000
# or: nc localhost 4000
```

Enter your name, then play with `hjkl` movement. You'll share each dungeon floor with other online players.

**Server ports:**
| Port | Service |
|------|---------|
| 4000 | Telnet (terminal) |
| 4001 | WebSocket (browser MMO client) |
| 4002 | HTTP status API |

## Controls

| Key | Action |
|-----|--------|
| Arrow keys / hjkl | Move |
| yubn | Diagonal movement |
| `.` or `s` | Wait a turn |
| `i` | Open inventory |
| `1-9`, `0` | Use inventory item |
| `>` | Descend stairs |
| `Q` | Quit |
| `:say <msg>` | Chat (MMO) |
| `who` | List online players |

## Features

- **Procedural dungeons** — rooms connected by corridors, unique each run
- **Turn-based combat** — bump-to-attack with attack/defense stats
- **Hunger system** — eat rations or starve
- **Items** — weapons, armor, potions, scrolls, food (some unidentified)
- **10 dungeon levels** — monsters scale with depth; dragon guards the end
- **Fog of war** — explored tiles remembered, line-of-sight for current view
- **Permadeath** — one life per run; seed shown for sharing

## MMO Architecture

- **Authoritative server** — all game logic runs server-side; clients send keystrokes only
- **Shared dungeon floors** — each depth is one persistent floor; all players on depth 3 explore the same map, monsters, and loot
- **Per-player fog of war** — you only see what your character has explored
- **Telnet + WebSocket** — terminal clients via telnet; browser clients can connect via WebSocket (`ws://localhost:4001`)
- **Up to 500 concurrent players** per server instance (configurable in `server/world.ts`)
- **Status API** — `http://localhost:4002/` returns online count, active floors, uptime

For true massive scale (thousands+), you'd shard by depth zone across multiple server processes with Redis pub/sub — the current architecture is the single-node foundation.

## Build

```bash
npm run build
npm run build:server
npm run preview
```