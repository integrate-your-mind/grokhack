# Free local CI (no GitHub Actions)

Hosted GitHub Actions is **disabled** for this repo. Billing locks were starting zero-step jobs that failed PRs without running a single test, and we do not pay for Actions minutes.

## Canonical command

```bash
npm run ci          # full gate + writes docs/proofs/*-local-ci-receipt.md
npm run ci:quick    # lint + test + build + server type baseline
```

Or:

```bash
bash scripts/ci-local.sh full
SKIP_INSTALL=1 npm run ci   # reuse existing node_modules
SKIP_AUDIT=1 npm run ci     # skip npm audit
WRITE_RECEIPT=0 npm run ci  # no proof file
```

## What it runs (full)

Same surface the old workflow claimed:

1. locked `npm ci` (root, edge, mcp)
2. production dependency audits
3. lint
4. coverage tests
5. deterministic shuffled tests
6. journal/catch-up properties
7. shadow e2e
8. browser build
9. server type baseline
10. edge verify (incl. Wrangler dry-runs)
11. MCP build

## Evidence

Successful runs write:

`docs/proofs/<UTC>-local-ci-receipt.md`

Soft reload / deploy (`npm run prod:reload`, `scripts/deploy.sh`) call this same gate.

## PR / merge policy

- **Do not** treat GitHub Actions check runs as release evidence.
- Paste or link the latest local CI receipt on the PR when promoting work.
- Optional: run `npm run ci` before push on your machine.

## Why not self-hosted GitHub runners?

You *can* install a free self-hosted runner later, but that still routes through GitHub Actions infrastructure and PR checks. Local CI is simpler, offline-capable, and matches the production host (macOS + Node) that actually serves `grokhack.mondello.dev`.
