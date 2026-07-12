# Shadow catch-up exact-state local proof — 2026-07-11T21:14:19Z

This receipt proves trusted local execution only. It does not claim a deployment,
production adoption, hosted GitHub Actions run, or mutation of the live service.

## Exact source identity

- Git HEAD: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Worktree: dirty; HEAD alone is not the tested source identity.
- Exact source-state SHA-256: `d89d3cb1f9695e61c230e3adf099456104603b0b91be31dc82cb14c032f525f5`
- Porcelain status SHA-256: `fcdd2866a2067f4afd547e0329b12bcda5f7a69c351fa869ec75c6999221f65b`
- Source manifest: 228 versionable files, excluding `data/`, proof receipts,
  generated `dist/` and coverage directories, and dependency directories.
- Reproduction command:

```bash
files=$(git ls-files --cached --others --exclude-standard | LC_ALL=C sort | \
  rg -v '^(data/|docs/proofs/|dist/|edge/dist/|coverage/|edge/coverage/|node_modules/|edge/node_modules/|mcp/node_modules/)')
printf '%s\n' "$files" | while IFS= read -r file; do
  test -f "$file" && shasum -a 256 "$file"
done | shasum -a 256
```

## Toolchain

- macOS 26.5 (25F71), Apple arm64
- Node `v22.23.1` supplied through the pinned local npm execution environment
- npm `11.16.0`
- Wrangler `4.110.0`
- Workers runtime types `5.20260711.1`

## Canonical local gate

The following commands ran in one fail-fast Node 22 shell. Final exit: `0`.

| Command | Exit | Evidence |
| --- | ---: | --- |
| root production dependency audit | 0 | zero vulnerabilities |
| edge production dependency audit | 0 | zero vulnerabilities |
| MCP production dependency audit | 0 | zero vulnerabilities |
| `npm run lint` | 0 | zero warnings allowed |
| `npm run test:coverage` | 0 | 51 files, 570 tests; 67.85% statements, 61.47% branches, 76.63% functions, 69.71% lines |
| deterministic root shuffled suite | 0 | 51 files, 570 tests, seed `20260710` |
| `npm run test:property` | 0 | 3 files, 11 journal/catch-up property tests |
| `npm run test:shadow-e2e` | 0 | real segmented origin journal to local Workers runtime; response-loss retry and divergence proof |
| `npm run build` | 0 | TypeScript and Vite production build |
| `npm run check:server-types` | 0 | exact known baseline: 319 diagnostics |
| `npm run edge:verify` | 0 | types, 38 tests, shuffle, property, coverage, all environment dry-run bundles |
| MCP TypeScript build | 0 | passed |

Edge coverage: 83.11% statements, 77.53% branches, 97.22% functions,
85.97% lines. The dedicated `ShadowReplay` implementation reached 88.15%
statements, 81.48% branches, 100% functions, and 98.21% lines.

The first Node 22 attempt reproduced a pre-existing fleet selftest hang caused by
subprocess/heredoc-heavy idle fixtures on this process-saturated host. The cause
was fixed by using shell-native matching and literal fixtures; the focused test
then passed in 2.67 seconds and the complete canonical rerun passed.

## End-to-end replay evidence

```json
{
  "ok": true,
  "responseLossObserved": true,
  "parity": {
    "streamId": "origin_parity",
    "checkpoint": 300,
    "accepted": 236,
    "duplicates": 64,
    "terminal": false,
    "stateHash": "82c56cb82a7ba023",
    "batches": 5,
    "caughtUp": true,
    "backpressured": false
  },
  "terminalParity": {
    "streamId": "origin_terminal",
    "checkpoint": 1,
    "accepted": 1,
    "duplicates": 0,
    "terminal": true,
    "stateHash": "e7730fb9e2b646f2",
    "batches": 1,
    "caughtUp": true,
    "backpressured": false
  },
  "divergence": {
    "code": "state_hash_divergence",
    "checkpoint": 0,
    "status": 422
  }
}
```

This is a real file-to-client-to-Worker-to-SQLite path. The 300-command trace
crosses hunger-state and damage boundaries. The first 64-entry response was
deliberately discarded after the Worker committed it. Retrying from cursor zero
replayed exactly 64 duplicates and applied only 236 unseen entries in bounded
pages. A separate real terminal origin stream reached identical terminal state
and hash at edge. A separately hash-chained but deliberately wrong origin after-hash
produced visible divergence evidence and did not advance its zero checkpoint.

## Built artifact hashes

```text
62f0d7caf3fca1aa0e62970f0cbb94ba23b57bc5c96763b96910830a4637070d  dist/index.html
929a1de29e2c04d8ef348cc753ba3b60f3a034b51c6fe8d685a53750fcc92dc0  dist/assets/index-DYqYzci2.css
183fdf6a22295dd7002c624d6f5a955f2bdbce1c39c87a4f7cc264b3f96de2d5  dist/assets/index-cLBkfq58.js
3ce05396debe9d7b62aedbb3113a591c9eb450edf84c3c515f059c1d0d9a9df1  edge/dist/development/index.js
3ce05396debe9d7b62aedbb3113a591c9eb450edf84c3c515f059c1d0d9a9df1  edge/dist/staging/index.js
3ce05396debe9d7b62aedbb3113a591c9eb450edf84c3c515f059c1d0d9a9df1  edge/dist/production/index.js
9c417c66d1ec40e04641d86a5dce94c50bb55b9fe7ff1f277f7bad59a15c4bda  mcp/dist/index.js
```

## Requirement audit

| Requirement | Evidence |
| --- | --- |
| Immutable origin journal | fsynced mode-0600, append-only, hash-chained 64-entry segments; restart, corruption, missing-segment, retry, append-failure guard, and terminal tests |
| Ordered cursor/checkpoint | origin contiguous cursors plus transactional SQLite checkpoint and immutable edge receipts |
| Duplicate and response-loss retry | exact duplicate replay tests, partial-overlap tests, eviction test, and 64-duplicate end-to-end retry |
| Out-of-order and gaps | reordered batch, future cursor, conflicting duplicate, missing segment, and broken chain fail visibly without passing the failing cursor |
| Terminal handling | terminal commit and duplicate are idempotent; origin and edge reject later commands without checkpoint advance |
| Bounded catch-up/backpressure | 64-entry segmented reads, 256 KiB streamed request cap, entry/batch/time limits, explicit 429/backpressure, exact byte boundary, and 65-entry rejection |
| Migration compatibility | real adjacent checkpoint schema is recreated, Durable Object evicted, expanded on construction, and advanced without losing its watermark |
| Representative parity | 300-command multi-page real origin-to-Workers replay crossing hunger/damage boundaries, plus real terminal parity, with exact final hashes |
| Deliberate divergence | valid envelope with wrong claimed after-hash records exact expected/actual evidence, returns 422, leaves checkpoint zero, then corrected retry succeeds in Workers tests |
| Focused normal/failure/odd tests | root unit/property/integration and Workers-runtime security, corruption, eviction, migration, sequence, terminal, boundary, and seeded chunking tests |
| Full local gates | all commands and results above, under Node 22 |

## Safety and remaining external gaps

- No restart, deployment, DNS change, traffic routing change, production-data
  write, or live authority transfer was performed by this work.
- Hosted Actions and PR evidence remain optional and were not required.
- Local/public health showed two users online at receipt time. The process had
  been replaced roughly three hours earlier by overlapping external work; this
  task did not cause or control that replacement.
- The shadow mechanism is proven for the extracted shared turn/vitals reducer.
  Full production readiness still requires movement, combat, traps, monsters,
  items, transfers, allocator/outbox, load/fault saturation, restore drills, and
  controlled adoption. Those are outside this shadow-catch-up objective and are
  not claimed here.
