# GrokHack Security

## Threat model

GrokHack is a **public game server** on your laptop, fronted by **Cloudflare Tunnel**. Players connect over HTTPS/WSS only — they never touch your LAN directly when tunnel is used correctly.

## What we lock down

| Control | Default |
|---------|---------|
| Bind address | `127.0.0.1` (localhost only) |
| Public exposure | Cloudflare tunnel → `:8080` only |
| Telnet `:4000` | Localhost only — **not** tunneled |
| Audit APIs | Disabled unless `GROKHACK_ADMIN_TOKEN` is set |
| Rate limit | 120 req/min per IP |
| POST body cap | 64 KB |
| WebSocket message cap | 8 KB |
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

## Reporting issues

Open a security issue (private) on GitHub or email the maintainer.