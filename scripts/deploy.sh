#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Running tests"
npm test

echo "==> Deploying Cloudflare Pages (static landing mirror)"
npx wrangler pages deploy public --project-name grokhack

echo "==> Done. Start game server + tunnel:"
echo "    npm run server"
echo "    npm run tunnel"