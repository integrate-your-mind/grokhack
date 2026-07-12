# Edge allocation/control-plane exact-state proof — 2026-07-12T22:15:41Z

This receipt proves trusted local source, test, build and scoped security execution. It does not claim that the Cloudflare Worker is deployed or receiving production traffic. The primary origin remained live during this proof and production data was not mutated.

## Exact source identity

- Git HEAD before consolidation commit: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Branch: `codex/edge-allocation-control-plane`
- Worktree: dirty; HEAD alone is not the tested source identity.
- Exact versionable source-state SHA-256: `e6c715039f1dec9ddb37bafde1e7188fc0e9550fb93bea063e8806a20d281bb8`
- Porcelain-status SHA-256 excluding proof receipts: `ccd6a29b1341d1e8d7642526d04624cb9bf6e35f0ff0ad08a59699afee7bc6ba`
- Source manifest: 236 versionable files, excluding `data/`, `.gstack/`, proof receipts, generated build/coverage output and dependency directories.
- Edge scan snapshot: `codex-security-snapshot/v1:sha256:d69d136f8232bf15968e74cd2b71c1ea50504543de2b4dc993ef33e321e25e0e`

Reproduction command:

```bash
files=$(git ls-files --cached --others --exclude-standard | LC_ALL=C sort | \
  rg -v '^(data/|docs/proofs/|dist/|edge/dist/|coverage/|edge/coverage/|node_modules/|edge/node_modules/|mcp/node_modules/|\.gstack/)')
printf '%s\n' "$files" | while IFS= read -r file; do
  test -f "$file" && shasum -a 256 "$file"
done | shasum -a 256
git status --porcelain=v1 --untracked-files=all | \
  rg -v '^\?\? docs/proofs/' | shasum -a 256
```

## Toolchain

- macOS `26.5` (`25F71`), Apple arm64
- Node `v22.23.1`
- npm `11.16.0`
- tmux `3.6a`
- Wrangler `4.110.0`
- TypeScript server-baseline compiler `5.9.3`

## Canonical local gate

All final commands used Node 22 and exited 0.

| Command | Result |
| --- | --- |
| `npm ci`, `npm ci --prefix edge`, `npm ci --prefix mcp` | 180, 128 and 98 locked packages installed; builds later proved the clean installs |
| three `npm audit --omit=dev --audit-level=moderate` commands | zero production dependency vulnerabilities |
| `npm run lint` | zero warnings |
| `npm run test:coverage` | 52 files, 578 tests; 67.80% statements, 61.43% branches, 76.60% functions, 69.71% lines |
| deterministic root shuffle, seed `20260710` | 52 files, 578 tests |
| `npm run test:property` | 3 files, 11 journal/catch-up property tests |
| `npm run test:shadow-e2e` | 300 commands, 236 accepted, 64 exact response-loss duplicates, terminal parity and visible divergence |
| `npm run build` | TypeScript and Vite production browser build |
| `npm run check:server-types` | exact known baseline: 319 diagnostics |
| `npm run edge:verify` | types; 78 coverage tests; 78 shuffled tests; 3 seeded properties; all environment dry-run bundles |
| `npm --prefix mcp run build` | MCP TypeScript build |
| `git diff --check` | clean |

Edge coverage: 81.60% statements, 76.66% branches, 95.65% functions and 84.41% lines.

The clean install emitted npm's allow-scripts policy warning for unapproved dependency install scripts. This is recorded rather than hidden; all root, Worker and MCP builds completed from the installed lock state.

## Reproduced defects and locked fixes

- Joined reservations were double-counted after a player connected, incorrectly spilling capacity to another Floor. Opaque signed reservation IDs now reconcile live occupancy.
- Concurrent exact allocation retries created four unused slots. Post-await receipt and affinity rechecks now prevent duplicate side effects.
- Tombstone retirement detected the need to drain but scheduled no alarm. Bounded automatic lifecycle alarms now drive retirement after eviction.
- Explicitly supported historical bucket counts could not retire after a layout change. Directory identity now includes and routes the declared supported bucket count.
- A failed `/api/status` read was converted to zero online players, allowing blind reload. The deploy guard now treats failed or malformed status as blocked.
- Isolated tests recursively copied nested `mcp/node_modules` and reproduced `ENOSPC`; nested dependency/generated trees are now excluded.
- Pages deployment inferred a dirty feature branch and stale HEAD. It now materializes `public/` from the exact pushed main SHA and passes explicit branch/SHA/clean metadata.
- The backend exposed `releaseSha:"local"`; boot now resolves a validated configured or checked-out Git SHA.
- Forwarded plaintext production requests returned 200 without HSTS. They now redirect to the canonical HTTPS host and emit HSTS.
- The `full` workflow could publish the mirror before discovering that origin reload was blocked. It now guards and reloads/verifies the primary origin before publishing the optional Pages mirror.
- The final full matrix reproduced two Vitest wrapper timeouts while their bounded integration operations were still valid; isolated reruns passed, explicit 15s/35s test budgets were added without weakening assertions, and the complete matrix then passed.

Normal, failure and odd cases are covered, including response loss, malformed/tampered bytes, invalid UTF-8, query/media/method rejection, key rotation, concurrent duplicates, capacity pressure, eviction, alarms, frozen/prepared transfer blockers, stale epochs, future schemas and bounded receipt pressure.

## Security scan

Codex Security `0.1.11` completed an exhaustive scoped `edge/` review:

- 14/14 deploy/runtime paths have unique current-hash completion receipts.
- Every high-impact coverage row is closed; no row is deferred.
- Current reportable findings: 0.
- Sealed manifest SHA-256: `708ecf645399f0b054762601057ecf1eb7da099eaae125a8fff51fead0ad18a4`
- Sealed report SHA-256: `4713cb9c4f86df4cb83912b4de21114f5d1a5c0e28fc4d04121380ee19324970`
- Findings SHA-256: `cc001941a65a4a2c3d7944a374346fa82b46d4fd62d41ac163ed7c91a3808d87`
- Coverage SHA-256: `9b85120545b80cc61749ccc675f51db344c71bda9f7cc25534e28cd48e46fdb7`

Canonical report:

`/private/var/folders/79/v8mgm0w50vv5qvv3l3_nvb7h0000gn/T/codex-security-scans/grok-build/f4843762_20260712T214224Z/report.md`

## Built artifact hashes

```text
62f0d7caf3fca1aa0e62970f0cbb94ba23b57bc5c96763b96910830a4637070d  dist/index.html
929a1de29e2c04d8ef348cc753ba3b60f3a034b51c6fe8d685a53750fcc92dc0  dist/assets/index-DYqYzci2.css
183fdf6a22295dd7002c624d6f5a955f2bdbce1c39c87a4f7cc264b3f96de2d5  dist/assets/index-cLBkfq58.js
a1bb096134f638db67ffe809169e9123b9581fa60c93cb5cb66b224cc794e283  edge/dist/development/index.js
a1bb096134f638db67ffe809169e9123b9581fa60c93cb5cb66b224cc794e283  edge/dist/staging/index.js
a1bb096134f638db67ffe809169e9123b9581fa60c93cb5cb66b224cc794e283  edge/dist/production/index.js
9c417c66d1ec40e04641d86a5dce94c50bb55b9fe7ff1f277f7bad59a15c4bda  mcp/dist/index.js
```

## External/runtime state at proof time

- GitHub had no open PR, issue, review comment, Actions run or overlapping deployment.
- The live origin reported ready and production-safe with exactly two managed `GrokBot` agent connections; no human player was present.
- Static assets already matched the mutable checkout because the origin reads `public/` directly.
- The running backend still reported `releaseSha:"local"`; post-merge guarded reload and runtime verification remain the next delivery step.
- Cloudflare Wrangler authentication was expired. This does not weaken local proof; Pages inventory/publication requires reauthentication.
- The Cloudflare Worker remains deliberately uncut-over: deploying it would apply Durable Object migrations while gameplay parity is still incomplete.
