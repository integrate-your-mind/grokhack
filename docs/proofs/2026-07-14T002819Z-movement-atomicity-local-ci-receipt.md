# Movement turn crash-atomicity — exact-head local CI receipt

Timestamp: `2026-07-14T00:28:19Z`

This receipt binds PR #2's source/destination floor fences,
`persistence_committed` recovery marker, and schema-v2 compatibility fix to the
exact local source state that was tested. It is not a merge, deployment,
production-adoption, media-proof, hosted-CI, or 99.99% uptime claim.

## Exact source state

- Repository: `/Users/romanmondello/grok-build`
- Branch: `codex/movement-shadow-parity`
- Proven source HEAD: `8937e31c4eef5b24c6350aca0442f9f4ad620e89`
- Source parent: `74836f287097c5f8d520d65ef1b7b40b25177a9b`
- PR base: `main` at `596d1b5bd06500e5cd38f9f3e3097280a7ccce6d`
- Remote PR branch before publication:
  `a022a086f89f0e4f842f7712d1fdf6ab70f921f2`
- Pull request: draft PR #2,
  <https://github.com/integrate-your-mind/grokhack/pull/2>
- Worktree during proof: clean; no tracked or untracked source file was present.
- Exact final-fix diff SHA-256 (`74836f2..8937e31`):
  `8e60fd777fa934ef640763c4978a43ffdd0c11ae37dd08a03826af8e53d6f181`
- Full unpublished branch diff SHA-256 (`a022a086..8937e31`):
  `e9e5819652eb5383188067ce33ebaed938fd3f4bb3cf78d5fe6eca0fb97e8942`

Atomicity commit sequence after the published PR head:

1. `a0ca6881f613d347e4fd7b293b353cb727f2f1aa` — harden movement
   shadow atomicity and recovery.
2. `d5258737f1b6b5254d8d51452f9316083c1ed60d` — make shadow E2E
   terrain deterministic.
3. `13e1ff52e68b1c229df6716321aac66df08a29bc` — make player plus
   source/destination floor persistence crash-atomic.
4. `90611f24c75a4789e5d885a8391c7e6f48e7099a` — bridge committed
   DuckDB state to restart recovery with an exact receipt.
5. `cd179c18086aad2106fd5fd95b6cbc57ede80ad2` — bound receipt state
   and reject future schema versions.
6. `74836f287097c5f8d520d65ef1b7b40b25177a9b` — restore the original
   schema-v2 layout and physically prove stale-receipt rollback.
7. `8937e31c4eef5b24c6350aca0442f9f4ad620e89` — support both known
   schema-v2 physical layouts without rewriting either.

Key source hashes:

- `server/persistence.ts`:
  `f15aed5b1674821e6b3e20db54a83a2c9b314cb69e3192a747bcfb51185291c4`
- `server/persistence.test.ts`:
  `0e5f532e28cb092cb8900bf5e61fc0df9c6274e9b7c103cf320c1182937170a3`
- `server/origin-journal.ts`:
  `3bf7455697692d6a7ace18f09dedcd74d7b12d0984d192a553e5674665acd7cd`
- `server/origin-journal.test.ts`:
  `dde05b0313f35c02963b168a00674e0f078dd3340a78e49f41da1bb2f2d0b5d5`
- `server/world.ts`:
  `354b6ba6c2c128ace93f7fc5f4d640de6ab58f5595d77a5174e6cff8592fd0e4`
- `server/world-movement-shadow.test.ts`:
  `b352575e04519fbee77f4cb0601cc917bccdae699cf8af9e6d906db8ce61919e`

## Before-fix reproduction and cause

Two inverse schema-v2 compatibility failures were reproduced against isolated
temporary DuckDB databases before the final fix:

1. The intermediate `cd179c1` writer required a `slot` column while retaining
   schema version 2. A database created by the earlier original-v2 writer had no
   such column, so the slot insert failed at runtime.
2. After `74836f2` restored the original no-slot insert, a database created by
   the immediate parent still had its required single-slot table. Startup
   accepted schema v2, then an ordinary movement failed with
   `NOT NULL constraint failed: movement_turn_commits.slot`. The player and
   floors rolled back and persistence stayed ready, so later movements could
   repeat the durability failure.

The cause was one numeric schema version representing two unpublished physical
receipt-table layouts. The final fix probes `information_schema.columns` only
after migrations and before readiness, chooses between two static insert
statements, and resets the cached shape on close. It performs no DDL, table
rewrite, drop, data copy, or schema-version change.

## Atomicity and recovery behavior

- `WorldServer` fences the player plus the exact source and destination floor
  snapshots for a transfer before publishing movement evidence.
- DuckDB serializes receipt writers and commits stale-receipt pruning, player,
  one or two floors, and the new exact snapshot receipt in one transaction.
- The fsync-backed journal advances monotonically through `prepared`,
  `origin_applied`, and `persistence_committed`; marker removal occurs only
  after the exact committed receipt is observable.
- Restart recovery compares the marker identity and snapshot hash with DuckDB.
  Exact retry is idempotent; conflicting, reordered, stale, or tampered state
  fails closed.
- A rollback failure poisons the connection instead of silently reusing an
  uncertain transaction.

### Normal, failure, retry, tamper, and odd-path matrix

| Path | Exact proof |
| --- | --- |
| Normal | Canonical original-v2 and transient single-slot-v2 saves succeed; an isolated WebSocket move survives database reopen. |
| Source/destination fence | A transfer captures both floors; injected destination-floor failure publishes neither new state nor evidence. |
| Write failure | Injection after begin, prune, player, source floor, destination floor, and receipt write rolls the transaction back. |
| Commit/crash | Physical child exits before commit and after each write/fsync boundary; pre-commit cases restore the prior player, both floors, and existing stale receipt, while post-commit recovery completes exactly once. |
| Retry/response loss | Identical operation retry validates the stored snapshot and deduplicates; Worker response-loss proof accepts 332 and detects 64 duplicates. |
| Tamper | Player/floor snapshot hash mismatch, wrong identity, stale/reordered preparation, and marker tampering fail closed. |
| Cleanup/poison | Failed marker unlink and failed receipt cleanup remain recoverable; rollback failure poisons persistence. |
| Compatibility | Original v2, prior-writer column list, transient slot v2, future schema rejection, close/reopen shape reset, and one-row receipt ceiling are covered. |
| Gameplay odd paths | Bounds, doors, combat intent, trap effects, cross-floor transfer, starvation terminal state, duplicates, and paged catch-up retain origin/Worker parity. |

The independent reviewer found no blocking issue at the exact source head and
independently passed 104/104 scoped tests. One limitation is explicit: the
single-slot layout has a direct normal/stale-receipt regression, while every
crash/tamper/retry boundary is physically repeated on the shared transaction
path using canonical v2 rather than duplicated once per physical table shape.

## Workflow-faithful clean-install gate

Environment:

- macOS `26.5` (`25F71`), Apple Silicon `arm64`
- Node `v22.23.1`
- npm `10.9.4`
- Vitest `4.1.10`
- Wrangler `4.110.0`
- Server type baseline compiler: TypeScript `5.9.3`

Lockfile SHA-256 values:

- root: `75b9e592f8cdc51520e1f336554ac23518433b156af7d2c9b9099652fc3c6793`
- edge: `1ee8643958028c97d777c13646dc0863c8842d8354d4efae8702085458977cc3`
- MCP: `213c07adba4d1bd1aeb6157a03cf8c04bf15bfd6eaafb202ff6d77f6b95e1240`

The literal local CI-order command sequence used the cached Node 22 binary and
npm CLI below. Every command exited 0:

```bash
export PATH=/Users/romanmondello/.npm/_npx/d295cebdb7c54afe/node_modules/node/bin:$PATH
NODE=/Users/romanmondello/.npm/_npx/d295cebdb7c54afe/node_modules/node/bin/node
NPM=/Users/romanmondello/.npm/_npx/4b0cc92362cfffad/node_modules/npm/bin/npm-cli.js
"$NODE" "$NPM" ci
"$NODE" "$NPM" ci --prefix edge
"$NODE" "$NPM" ci --prefix mcp
"$NODE" "$NPM" audit --omit=dev --audit-level=moderate
"$NODE" "$NPM" audit --omit=dev --audit-level=moderate --prefix edge
"$NODE" "$NPM" audit --omit=dev --audit-level=moderate --prefix mcp
"$NODE" "$NPM" run lint
"$NODE" "$NPM" test -- server/persistence.test.ts server/origin-journal.test.ts server/world-movement-shadow.test.ts
"$NODE" "$NPM" run test:coverage
"$NODE" "$NPM" test -- --sequence.shuffle --sequence.seed=20260710
"$NODE" "$NPM" run test:property
"$NODE" "$NPM" run test:shadow-e2e
"$NODE" "$NPM" run build
"$NODE" "$NPM" run check:server-types
"$NODE" "$NPM" run edge:verify
"$NODE" "$NPM" run mcp:build
```

Results:

- Three locked installs and three production dependency audits passed; all
  audits reported zero known vulnerabilities.
- Lint passed with zero warnings.
- Scoped atomicity path: 3 files, 104/104 tests passed. This supersedes the
  earlier 78-test path with the added schema and physical crash regressions.
- Root coverage: 57 files, 716 tests; 71.90% statements, 66.32% branches,
  80.18% functions, and 74.13% lines.
- Root deterministic shuffle: 57 files, 716 tests, seed `20260710`.
- Journal/catch-up properties: 3 files, 77 tests.
- Origin-to-local-Worker E2E: checkpoint 396, 332 accepted, 64 response-loss
  duplicates; state, event, and continuity divergences returned HTTP 422;
  normal, bounds, door, combat, trap, transfer, terminal, and 130-envelope
  paged scenarios passed.
- Browser build: 115.75 KiB JavaScript, 38.85 KiB gzip.
- Server type-debt guard matched exactly 310 diagnostics; this is a frozen debt
  baseline, not a claim of zero TypeScript diagnostics.
- Edge coverage: 9 files, 101 tests; 82.17% statements, 76.86% branches,
  96.20% functions, and 84.70% lines. The deterministic shuffle also passed
  101/101; seeded selection passed 5 with 25 intentionally skipped by filter.
- Development, staging, and production Wrangler dry-runs each produced a
  180.02 KiB / 37.33 KiB-gzip Worker and did not deploy.
- The logged `SQLITE_CONSTRAINT_TRIGGER` exception is deliberate fault
  injection in the edge atomicity test; both coverage and shuffle suites exited
  0 after asserting it.
- MCP TypeScript build passed.
- `git diff --check` passed.

Generated artifact identity after the clean-install gate:

- Aggregate browser/Worker/MCP file-manifest SHA-256:
  `4f8b9cf69686c13333f291a77aaefb988b155e750da2fdc334435726c90342d9`
- Browser JavaScript:
  `183fdf6a22295dd7002c624d6f5a955f2bdbce1c39c87a4f7cc264b3f96de2d5`
- Development/staging/production Worker JavaScript (identical):
  `77de6c39fa6604c6027ba201339edc415e9737b78ee15a151fe5383716095087`
- MCP JavaScript:
  `9c417c66d1ec40e04641d86a5dce94c50bb55b9fe7ff1f277f7bad59a15c4bda`

## Isolated physical runtime QA

A real Node 22 `WorldServer`, `OriginGameplayJournal`, persistence layer, HTTP
server, and WebSocket endpoint were started directly on an ephemeral localhost
port with a fresh temporary data directory and DuckDB. `server/index.ts` and
`.env` were not loaded; Discord, external bridges, production endpoints, and
live data were not used.

`/health?format=json` reported ready. A human client joined, selected an
ordinary adjacent floor cell, and moved exactly one cell and one turn. After a
graceful drain and database close/reopen, the persisted coordinates and turn
matched the acknowledged state. The journal reported no recovery candidate and
the receipt table contained zero rows after normal cleanup:

```text
head=8937e31c4eef5b24c6350aca0442f9f4ad620e89
movement=(72,4,turn 0) -> (73,4,turn 1)
persisted_after_reopen=(73,4,turn 1)
recovery_pending=false
receipt_count=0
```

The reproducible scratch script and its temporary database/data root were
removed after the run. No owned test, Wrangler, E2E, or runtime process remained.
Generated `dist/`, `edge/dist/`, and `mcp/dist/` outputs were deliberately
retained as ignored, reproducible build artifacts until publication hashes were
recorded.

## Scoped security diff review

The prior exact scan of `cd179c1..74836f2` dynamically reproduced the inverse
single-slot compatibility failure. Attack-path analysis classified it as a real
engineering release blocker but not a reportable security vulnerability because
the required unpublished database shape was developer/operator controlled.

- Prior scan manifest SHA-256:
  `a3c6698149e2ad52125006aaf80fd974baec6feb9f54a8cdf164b352bce5defb`
- Prior report SHA-256:
  `06125aa6763dcc60ac8cf4bd2378c5a91d15d2d670df14e387eb259d2a26e22b`

The final exact diff `74836f2..8937e31` was then fully inventoried and reviewed
with the same threat model. Both changed source-like files were read completely,
the independent reviewer returned no blocker, the canonical contract was
sealed successfully, and zero reportable findings survived.

- Final scan ID: `scan_8937e31_20260714T001901Z`
- Final scan manifest SHA-256:
  `2ed8ad9ce08e8c28b9c078df15a56f80a44d017ccc642e3112107f9136e71f7b`
- Final deterministic report SHA-256:
  `98bb1aa9834876da17fd7ff804286c52dc69c9c2032e891ba68d5d60a5e3746a`
- Coverage: complete; deferred surfaces: none; reportable findings: zero.

The canonical scan directory is temporary execution evidence. Its hashes,
scope, outcome, limitation, and reviewer disposition are preserved here so no
unique project proof depends on temporary storage.

## Compatibility, migration, and rollback risk

- `SCHEMA_VERSION` remains 2 and this final fix performs no migration or data
  rewrite. Future versions greater than 2 are rejected before application DDL.
- Canonical original-v2 databases remain writable by the current code and the
  earlier original-v2 `90611f2` writer.
- The unpublished single-slot-v2 database remains physically unchanged and is
  writable by the current code and its `cd179c1` writer.
- A single-slot database cannot be rolled directly back to the older no-slot
  `90611f2` writer without a schema-aware backup/restore. That limitation
  predates this final compatibility fix and is why neither layout is rewritten.
- No production database is known to have adopted either unpublished atomicity
  commit. No migration, restore, compaction, production-data write, or live
  runtime restart was performed.
- Before any future application rollback, quiesce movement, preserve the
  database and journal together, and prove no in-flight preparation remains.
  This receipt is not authorization to perform that operational step.

## GitHub and remaining proof gaps

- GitHub had exactly one open PR: draft PR #2. Before this publication its head
  was `a022a086f89f0e4f842f7712d1fdf6ab70f921f2`, mergeable but `UNSTABLE`,
  with no reviews and no review threads.
- Hosted run `29226920128` targeted that published head and contains zero job
  steps. Its full annotation is: “The job was not started because your account
  is locked due to a billing issue.” It is unavailable evidence, not a code
  failure and not a reason to retry-loop.
- This exact head has local clean-install proof but no hosted runner execution.
- No screenshot or literal video has been attached to PR #2 for this backend
  slice. The real isolated runtime outcome is executable evidence, but it does
  not satisfy the portfolio media requirement by itself.
- Explicit Durable Object instance eviction is not independently observable in
  the local harness, and catch-up after the retained 256-receipt window remains
  separate PR #2 work. Runtime reconstruction and 130-envelope paged catch-up
  passed; neither result should be overstated as those missing proofs.
- No merge, deployment, publish, release, Worker traffic, route/DNS change,
  credential upload, live service restart, or production-data mutation occurred.
  Keep PR #2 draft and classified `FIX` after this scoped atomicity publication.
