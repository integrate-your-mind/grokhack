## SECURITY.md source: "SECURITY.md"

# GrokHack Security

## Threat model

GrokHack is a **public game server** on your laptop, fronted by **Cloudflare Tunnel**. Players connect over HTTPS/WSS only — they never touch your LAN directly when tunnel is used correctly.

## What we lock down

| Control | Default |
|---------|---------|
| Bind address | `127.0.0.1` (localhost only); Docker/k8s HTTP may use `0.0.0.0` |
| Telnet bind | **Always** `TELNET_BIND_HOST=127.0.0.1` (never inherits HTTP `BIND_HOST`) |
| Public exposure | Cloudflare tunnel → `:8080` only |
| Telnet `:4000` | Localhost only — **not** tunneled; not published in compose/k8s Service |
| Dual tunnel | Host **or** k8s tunnel — never both for the same tunnel ID (split-brain) |
| Audit APIs | Disabled unless `GROKHACK_ADMIN_TOKEN` is set |
| Rate limit | 120 req/min per IP (global) |
| Feedback limit | 5/hour, 20/day per IP + honeypot + duplicate detection |
| POST body cap | 64 KB |
| WebSocket message cap | 8 KiB UTF-8 at the `ws` parser boundary |
| WebSocket queue/rate | 64 pending frames and 600 messages/min per connection |
| WebSocket connection cap | 600 origin-wide; 16 concurrent per client IP |
| WebSocket join deadline | 15 seconds; unjoined sockets are closed |
| WebSocket outbound cap | 512 KiB queued or single-frame budget per connection |
| Character admission | I/O-free FIFO commit gate; one active identity per connection |
| Service child environment | Supervisor strips unrelated workstation/provider credentials |
| Runtime launcher | Locked local `tsx` binary; no `npx`/npm-exec parent |
| Static files | Path traversal blocked |
| Security headers | CSP, X-Frame-Options, nosniff |

## Run securely (production)

```bash
# 1. Generate admin token (keep secret — never commit)
export GROKHACK_ADMIN_TOKEN="$(openssl rand -hex 32)"

# 2. Bind localhost only (default)
export BIND_HOST=127.0.0.1

# 3. Start server + tunnel
npm run server
npm run tunnel:prod
```

Only **port 8080 on 127.0.0.1** is reachable locally. Telnet stays on `127.0.0.1:4000` for you only.

## Admin API

Audit logs require a bearer token:

```bash
curl -H "Authorization: Bearer $GROKHACK_ADMIN_TOKEN" \
  https://grokhack.mondello.dev/api/audit/recent
  https://grokhack.mondello.dev/api/audit/stats?days=7
```

Without `GROKHACK_ADMIN_TOKEN`, audit endpoints return 403.

## Discord / IRC

- `DISCORD_WEBHOOK_URL` — outbound only; store in env, never in git
- IRC bridge — outbound to Libera; no inbound shell access

## macOS laptop hardening (recommended)

1. **System Settings → Network → Firewall** — turn on, block incoming except signed apps you need
2. **Do not** set `BIND_HOST=0.0.0.0` unless you intend LAN access
3. **Do not** port-forward 8080/4000 on your router — use Cloudflare Tunnel only
4. Keep `cloudflared` credentials in `~/.cloudflared/` (already outside repo)
5. Rotate `GROKHACK_ADMIN_TOKEN` if leaked

If any credential appears in `ps`/process arguments, rotate it immediately. The
supervisor source now avoids npm-exec and removes known unrelated developer-agent
credentials, but a running process does not inherit that fix until an approved restart.

## Feedback API

Public: `POST /api/feedback` (max 4 KB body)

| Control | Default |
|---------|---------|
| Burst | 10 POSTs/min per IP |
| Hourly | 5 submissions per IP |
| Daily | 20 submissions per IP |
| Honeypot | Hidden `website` field — bots rejected |
| Timing | Rejects if submitted &lt; 1.5s after page load |
| Duplicates | Same message from same IP within 24h blocked |
| Storage | `data/feedback/` JSONL — IPs stored as salted hash only |

Admin review: `GET /api/feedback/list` (requires `GROKHACK_ADMIN_TOKEN`)

## Reporting security issues

Use category **security** on [/feedback.html](/feedback.html) or open a private GitHub security advisory.
