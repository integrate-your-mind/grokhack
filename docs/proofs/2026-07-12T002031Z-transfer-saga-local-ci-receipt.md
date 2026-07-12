# Player transfer/takeover exact-state local proof — 2026-07-12T00:20:31Z

This receipt proves trusted local execution only. It does not claim deployment,
production adoption, hosted GitHub Actions, external load, live SLO attainment,
or any mutation of the running service or production data.

## Exact source identity

- Git HEAD: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Worktree: dirty; HEAD alone is not the tested source identity.
- Exact source-state SHA-256: `0f40214d247d17cfcd410f613c6b7c1e46a0a46bf81f26b44c2f704f75210b4a`
- Porcelain status SHA-256: `249ccad46b64cd25ec615aa73dc8c35bc1589c424e133c3c0cc24e9c4e5c7146`
- Source manifest: 230 versionable files, excluding `data/`, proof receipts,
  generated `dist/` and coverage directories, and dependency directories.
- Reproduction command:

```bash
files=$(git ls-files --cached --others --exclude-standard | LC_ALL=C sort | \
  rg -v '^(data/|docs/proofs/|dist/|edge/dist/|coverage/|edge/coverage/|node_modules/|edge/node_modules/|mcp/node_modules/)')
printf '%s\n' "$files" | while IFS= read -r file; do
  test -f "$file" && shasum -a 256 "$file"
done | shasum -a 256
git status --porcelain=v1 --untracked-files=all | shasum -a 256
```

The final post-gate edit outside `docs/proofs/` only updated
`docs/production-readiness-review.md` with the observed test and security-scan
results. It does not enter any build or test input. The edge snapshot digest was
recomputed afterward and remained exact.

## Toolchain

- macOS `26.5` (`25F71`), Apple arm64
- Node `v22.23.1` from the cached pinned local npm execution environment
- npm `11.16.0`
- Wrangler `4.110.0`
- Workers runtime types `5.20260711.1`
- TypeScript server baseline compiler `5.9.3`

## Canonical local gate

Every command below used Node `22.23.1`. Final gate result: `0`.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm ci` | 0 | 180 locked packages; zero audit findings |
| `npm ci --prefix edge` | 0 | 130 locked packages; zero audit findings |
| `npm ci --prefix mcp` | 0 | 98 locked packages; zero audit findings |
| root production dependency audit | 0 | zero vulnerabilities |
| edge production dependency audit | 0 | zero vulnerabilities |
| MCP production dependency audit | 0 | zero vulnerabilities |
| first `npm run lint` | 1 | caught an always-overwritten cleanup initializer in `PlayerSession`; source was corrected |
| final `npm run lint` | 0 | zero warnings allowed |
| `npm run test:coverage` | 0 | 51 files, 570 tests; 67.81% statements, 61.45% branches, 76.63% functions, 69.71% lines |
| deterministic root shuffled suite | 0 | 51 files, 570 tests, seed `20260710` |
| `npm run test:property` | 0 | 3 files, 11 journal/catch-up property tests |
| `npm run test:shadow-e2e` | 0 | 300-command real origin-to-Workers replay, 64 exact response-loss duplicates, terminal parity, visible divergence |
| `npm run build` | 0 | TypeScript and Vite browser production build |
| `npm run check:server-types` | 0 | exact known baseline: 319 diagnostics |
| `npm run edge:verify` | 0 | types, coverage, 58 tests, shuffle, seeded properties, and all environment dry-run bundles |
| `npm --prefix mcp run build` | 0 | MCP TypeScript build |

The npm 11 root clean install emitted its policy warning that four dependency
install scripts were not pre-approved. This was not hidden as proof: the
subsequent TypeScript, Vite, Workers, and MCP builds all executed successfully
from that clean tree. Hosted Actions was not needed for the result.

## Transfer/takeover proof

The Workers-runtime suite proves:

- the central freeze cannot commit unless the exact source Floor and connection
  are already durably frozen;
- deterministic proof-bound source and target capabilities close crashes between
  remote phase persistence and `PlayerSession` persistence;
- equivalent concurrent freeze/prepare requests coalesce without releasing or
  aborting the phase adopted by the winning request;
- the destination persists and validates preparation before irreversible commit;
- cross-floor transfer and same-floor higher-session takeover preserve gameplay,
  the last client sequence, and all 256 dedupe receipts;
- exact response-loss retries return byte-identical phase and command responses;
- uncommitted target activation, stale source authority, wrong proof, corrupt or
  gapped handoff, terminal gameplay, and destination conflicts fail closed;
- abort-before-commit durably marks an in-progress subphase, unwinds target then
  source, and resumes from an alarm after object eviction;
- successful activation automatically finalizes and closes the old source;
  failed cleanup remains alarm-backed;
- source close events cannot disturb the activated target fence;
- PlayerSession and Floor adjacent schemas expand before use;
- central operation receipts and terminal Floor transfer artifacts are bounded;
- signed uppercase/lowercase UUID aliases canonicalize into one player session,
  supersede the old socket, and cannot independently commit `clientSeq=1`.

Normal, failure, odd, concurrency, response-loss, eviction, schema, storage, and
seeded property paths are covered by 58 real Workers-runtime tests. Edge
coverage is 80.48% statements, 75.94% branches, 96.39% functions, and 83.33%
lines, above every configured threshold.

## Security scan

A complete Codex Security scoped working-tree scan reviewed all 11 ranked edge
transfer/auth paths with one unique hash-guarded receipt per path.

- Edge snapshot: `codex-security-snapshot/v1:sha256:1fdf0971f6da606cf0bf14234f1c7a6dc61409d2ab02d7002f0c6b654d6d2fea`
- Candidate: `edge-player-uuid-case-fence-bypass`
- Historical status: reproduced through the real Workers `/ws` path
- Current status: `suppressed`, `fixed_by_current_diff`, `survives=no`
- Validation confidence: high (`0.95`)
- Reportable findings in current source: `0`
- Sealed report SHA-256: `354618a78a3855e41c6e4e722431946552b2ff768cdcf45d71450ef806934818`
- Sealed manifest SHA-256: `ee65ad5b3eabafe018f576c384babe00de079b3b90faf3ae7cbc941d0cb178cd`

The canonical finalizer succeeded and generated the readable report at:

`/private/var/folders/79/v8mgm0w50vv5qvv3l3_nvb7h0000gn/T/codex-security-scans/grok-build/f4843762_20260711T234136Z/report.md`

## Built artifact hashes

```text
62f0d7caf3fca1aa0e62970f0cbb94ba23b57bc5c96763b96910830a4637070d  dist/index.html
929a1de29e2c04d8ef348cc753ba3b60f3a034b51c6fe8d685a53750fcc92dc0  dist/assets/index-DYqYzci2.css
183fdf6a22295dd7002c624d6f5a955f2bdbce1c39c87a4f7cc264b3f96de2d5  dist/assets/index-cLBkfq58.js
430c420ef5eca34894d18df8972474a291d2da5b1a05165b5a6e468f9a53694c  edge/dist/development/index.js
430c420ef5eca34894d18df8972474a291d2da5b1a05165b5a6e468f9a53694c  edge/dist/staging/index.js
430c420ef5eca34894d18df8972474a291d2da5b1a05165b5a6e468f9a53694c  edge/dist/production/index.js
9c417c66d1ec40e04641d86a5dce94c50bb55b9fe7ff1f277f7bad59a15c4bda  mcp/dist/index.js
```

## Requirement audit

| Requirement | Evidence |
| --- | --- |
| Resume-proof security | Stable hash removed from browser-visible claims; AES-GCM opaque grant is bound to identity, fence, route, key, ticket, and expiry |
| Durable phase receipts | Exact operation/request/response/version receipts with explicit bounded retention |
| Authority epochs and leases | Source/target tuples validated at PlayerSession and Floor boundaries |
| Abort before commit | Durable in-progress subphase, idempotent target/source unwind, alarm recovery |
| Response-loss retry | Exact phase retries, target/source crash-window reconstruction, concurrent-equivalent coalescing |
| Stale source/destination fencing | Old source is frozen then finalized; unactivated destination and stale fences cannot commit |
| Sequence/dedupe handoff | Full 256-receipt contiguous handoff, exact duplicate response, gap/conflict rejection |
| Terminal/conflict/gap handling | Focused Workers failures and seeded properties fail closed without authority advance |
| Hibernation/eviction | Source, destination, PlayerSession, activation, cleanup, and abort recovery paths exercise Durable Object eviction |
| Adjacent schema | PlayerSession and Floor old schemas are recreated, evicted, expanded, and used |
| Bounded/authenticated inputs | Ticket/proof HMAC+AEAD, canonical UUIDs, body/frame/receipt/artifact caps, strict identities |
| Local end-to-end proof | Real WebSockets and SQLite Durable Objects perform cross-floor transfer and same-floor takeover |
| Canonical release gate | Clean Node 22 installs, audits, lint, root/edge coverage/shuffle/property, E2E, builds, baseline, all Worker dry runs |
| Security closure | 11/11 files reviewed; reproduced candidate fixed; zero surviving reportable findings |

## Safety and remaining external gaps

- No restart, deployment, DNS/routing change, paid-resource creation, secret
  upload, production-data write, live authority transfer, merge, push, or external
  communication was performed.
- Hosted GitHub Actions and PR publication remain optional evidence only.
- The transfer slice is locally proven but undeployed. Production adoption still
  needs a real external issuer/control plane, approved internal environment,
  canary traffic, independent probes, distributed load/fault evidence, and
  restore drills.
- The broader production-readiness roadmap remains open: sharded allocation and
  floor-epoch retirement, complete reducer parity, outbox/queues/projections/R2,
  measured saturation and reconnect storms, and the 30-day application SLO gate.
- The legacy server TypeScript debt remains the exact 319-diagnostic baseline;
  it did not grow and is not misrepresented as compile-clean.
