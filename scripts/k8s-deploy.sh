#!/usr/bin/env bash
# Deploy GrokHack HA stack to the current kubectl context.
# Security: refuse dual-origin (host cloudflared + k8s tunnel) unless ALLOW_DUAL_ORIGIN=1.
# Never echo secret values.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NS=grokhack
TUNNEL_ID="${TUNNEL_ID:-48eb2839-41c7-426b-9bed-8cce35b7b545}"
CREDS="${CLOUDFLARED_CREDS:-$HOME/.cloudflared/${TUNNEL_ID}.json}"
SKIP_TUNNEL="${SKIP_TUNNEL:-0}"
ALLOW_DUAL_ORIGIN="${ALLOW_DUAL_ORIGIN:-0}"

echo "[k8s] context=$(kubectl config current-context 2>/dev/null || echo none)"
echo "[k8s] building image grokhack:latest"
docker build -t grokhack:latest "$ROOT"

# --- dual-origin / split-brain guard -----------------------------------------
host_cf_running() {
  pgrep -f "cloudflared tunnel .*${TUNNEL_ID}|cloudflared tunnel --config cloudflare/grokhack-tunnel" >/dev/null 2>&1
}

if [[ "$SKIP_TUNNEL" != "1" && "$ALLOW_DUAL_ORIGIN" != "1" ]] && host_cf_running; then
  echo "[k8s] ERROR: host cloudflared already running for this tunnel." >&2
  echo "[k8s] Applying game only would leave two DuckDB worlds; applying tunnel would split public edge." >&2
  echo "[k8s] Options:" >&2
  echo "  SKIP_TUNNEL=1 $0          # deploy game StatefulSet only (tunnel stays on host)" >&2
  echo "  # stop host tunnel, then re-run (migrates edge to k8s)" >&2
  echo "  ALLOW_DUAL_ORIGIN=1 $0    # dangerous — only for brief cutover" >&2
  exit 1
fi

kubectl apply -f "$ROOT/deploy/k8s/00-namespace.yaml"
kubectl apply -f "$ROOT/deploy/k8s/10-configmap.yaml"
kubectl apply -f "$ROOT/deploy/k8s/20-pvc.yaml"

if [[ -f "$ROOT/.env" ]]; then
  # Pipe secret YAML to kubectl apply — never write plaintext secret files into the repo.
  kubectl -n "$NS" create secret generic grokhack-env \
    --from-env-file="$ROOT/.env" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "[k8s] applied grokhack-env from .env (values not logged)"
else
  echo "[k8s] WARN: no .env — apply deploy/k8s/30-secret.example.yaml manually (copy → 30-secret.yaml)"
fi

if [[ "$SKIP_TUNNEL" != "1" ]]; then
  if [[ -f "$CREDS" ]]; then
    kubectl -n "$NS" create secret generic grokhack-tunnel-creds \
      --from-file=credentials.json="$CREDS" \
      --dry-run=client -o yaml | kubectl apply -f -
    echo "[k8s] applied tunnel credentials secret (path only, not contents)"
  else
    echo "[k8s] ERROR: missing credentials $CREDS" >&2
    exit 1
  fi
fi

kubectl apply -f "$ROOT/deploy/k8s/40-game-statefulset.yaml"

if [[ "$SKIP_TUNNEL" == "1" ]]; then
  echo "[k8s] SKIP_TUNNEL=1 — not applying/scaling tunnel deployment"
  # Ensure in-cluster tunnel stays at 0 so host remains sole public origin.
  kubectl -n "$NS" scale deploy/grokhack-tunnel --replicas=0 2>/dev/null || true
else
  kubectl apply -f "$ROOT/deploy/k8s/50-tunnel-deployment.yaml"
fi

echo "[k8s] waiting for game ready..."
kubectl -n "$NS" rollout status statefulset/grokhack-game --timeout=180s

if [[ "$SKIP_TUNNEL" != "1" ]]; then
  echo "[k8s] waiting for tunnel ready..."
  kubectl -n "$NS" rollout status deployment/grokhack-tunnel --timeout=180s
fi

kubectl -n "$NS" get pods,svc,pdb
# Never: kubectl get secret -o yaml (leaks). Never log env from pods.

echo "[k8s] probing public edge..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 8 https://grokhack.mondello.dev/api/status >/dev/null; then
    echo "[k8s] PUBLIC OK"
    curl -sf https://grokhack.mondello.dev/api/status | head -c 200
    echo
    exit 0
  fi
  echo "[k8s] wait public $i..."
  sleep 3
done
echo "[k8s] WARN: public edge not healthy yet — check tunnel pods/logs" >&2
if [[ "$SKIP_TUNNEL" != "1" ]]; then
  # Logs only — cloudflared does not print credential JSON in normal operation.
  kubectl -n "$NS" logs -l tier=tunnel --tail=30 || true
fi
exit 1
