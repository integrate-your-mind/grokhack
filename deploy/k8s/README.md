# GrokHack Kubernetes HA

## Architecture (near-zero downtime)

| Component | Kind | Replicas | Why |
|-----------|------|----------|-----|
| **Game world** | StatefulSet | **1** | DuckDB + in-memory `WorldServer` — single writer |
| **Tunnel** | Deployment | **2** | Dual Cloudflare connectors; survive one pod death |
| **Data** | PVC RWO | 1 | Durable DuckDB, store, feedback, audit |
| **PDB** | minAvailable 1 | — | Block eviction of last game/tunnel pod |

Cloudflare already provides global edge caching for static assets. In-cluster nginx cache (`60-static-cache.yaml`) is optional.

> True multi-writer game pods need Postgres (or similar) instead of DuckDB file. Until then, HA = **fast restart + dual tunnel + KeepAlive**, not multi-active game replicas.

## Security (edge)

| Rule | Detail |
|------|--------|
| **One public origin** | Same Cloudflare tunnel ID must not have host `cloudflared` *and* k8s tunnel pods ready. That load-balances two DuckDB worlds (split-brain). |
| **Host default** | Mac launchd supervisor owns the tunnel. Keep `kubectl -n grokhack scale deploy/grokhack-tunnel --replicas=0` while host is live. |
| **k8s-deploy guard** | `scripts/k8s-deploy.sh` refuses tunnel apply if host cloudflared is running unless `ALLOW_DUAL_ORIGIN=1` or `SKIP_TUNNEL=1`. |
| **Telnet** | `TELNET_BIND_HOST=127.0.0.1` always — not on Service, not in CF ingress. |
| **Secrets** | `kubectl create secret ... --dry-run=client -o yaml \| kubectl apply` — never commit `30-secret.yaml` or log secret YAML. |
| **NetworkPolicy** | Optional: `70-network-policy.yaml` (may break probes on some CNIs). |
| **Deprecated** | `deployment.yaml` multi-replica sketch — do not apply for prod. |

## Prerequisites

- Kubernetes (k3s, GKE, EKS, AKS, Railway, DigitalOcean, colima `--kubernetes`)
- `kubectl`, `docker`/`buildx`
- Cloudflare tunnel credentials JSON for tunnel id `48eb2839-41c7-426b-9bed-8cce35b7b545`

## Quick deploy

```bash
# 1) Cluster (local example)
colima start --kubernetes --cpu 4 --memory 8

# 2) Build image into cluster
docker build -t grokhack:latest .
# k3s/colima often shares docker; else: colima nerdctl / kind load

# 3) Secrets
kubectl apply -f deploy/k8s/00-namespace.yaml
kubectl -n grokhack create secret generic grokhack-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
kubectl -n grokhack create secret generic grokhack-tunnel-creds \
  --from-file=credentials.json=$HOME/.cloudflared/48eb2839-41c7-426b-9bed-8cce35b7b545.json \
  --dry-run=client -o yaml | kubectl apply -f -

# 4) App
kubectl apply -f deploy/k8s/10-configmap.yaml
kubectl apply -f deploy/k8s/20-pvc.yaml
kubectl apply -f deploy/k8s/40-game-statefulset.yaml
kubectl apply -f deploy/k8s/50-tunnel-deployment.yaml

# 5) Verify
kubectl -n grokhack get pods,svc,pdb
curl -sf https://grokhack.mondello.dev/api/status
```

## Payments (x402)

Set in secret / `.env`:

```
X402_PAY_TO=0x0E4d1C7Ca47879C7Dd518526ef38f290C7081028
GROKHACK_TREASURY_ADDRESS=0x0E4d1C7Ca47879C7Dd518526ef38f290C7081028
THIRDWEB_SECRET_KEY=...   # for settle
```

## Zero-downtime upgrades (game)

```bash
# Build new image, then:
kubectl -n grokhack rollout restart statefulset/grokhack-game
# Tunnel can roll independently without dropping origin if 2 replicas
kubectl -n grokhack rollout restart deployment/grokhack-tunnel
```

Graceful: `preStop` sleep + server SIGTERM flush (DuckDB). Expect brief WS reconnects — client auto-reconnect handles this.

## Fallback (Mac)

If k8s is unavailable, always keep:

```bash
npm run prod          # launchd-capable supervisor
# or
docker compose up -d  # restart: always
```

launchd: `com.mondello.grokhack` KeepAlive=true.
