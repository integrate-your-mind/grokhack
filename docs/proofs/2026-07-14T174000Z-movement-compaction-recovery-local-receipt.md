# Movement shadow receipt-compaction recovery — local proof receipt

Timestamp: `2026-07-14T17:40:00-04:00`

## Scope and source state

- Repository: `/Users/romanmondello/grok-build`
- Branch: `codex/movement-shadow-parity`
- Base and upstream SHA before this scoped patch:
  `a893ca3187e6f1f6c5a2483b7a9a80d2d61bbf36`
- Remote branch at verification start: the same SHA.
- PR: draft [#2](https://github.com/integrate-your-mind/grokhack/pull/2).
- Scope: authenticated recovery from an already-compacted movement-turn receipt
  window. No deploy, merge, production traffic/data mutation, secret access, or
  paid Cloudflare action occurred.

## Reproduction and fix

Before this patch, a Worker that had checkpoint `300` and pruned receipt `1`
returned only `cursor_compacted` plus the cursor. The Node copier had the local
immutable envelopes required to prove that durable head, but no remote hashes to
compare, so it correctly stopped rather than recovering.

The Worker now includes its stream-bound durable checkpoint tuple on that
authenticated failure: stream ID, checkpoint, zero accepted/duplicate counts,
terminal bit, and envelope/movement/turn head hashes. The copier accepts it only
after reconstructing the exact origin prefix and matching every value; malformed,
stale, nonzero-count, wrong-stream, terminal, or hash-tampered tuples fail
closed. The client reader is structural rather than Node-journal-nominal, which
allows the exact client to be exercised under the Worker test runtime without
pulling Node APIs into the Worker.

## Exact local proof

| Gate | Result |
| --- | --- |
| `node scripts/run-tests-isolated.mjs server/shadow-catchup.test.ts` | pass, 15/15 |
| `npm --prefix edge test -- test/shadow-replay.test.ts` | pass, 29/29; includes actual `evictDurableObject` after a 300-envelope compaction and real client recovery through the Worker route |
| `npm run test:coverage` | pass, 57 files / 717 tests; root 71.94% statements, 66.48% branches; `server/shadow-catchup.ts` 87.55% statements, 85.02% branches |
| `npm run test:property` | pass, 3 files / 78 tests |
| `npm run test:shadow-e2e` | pass; 300-envelope response-loss/reload/compacted recovery reports checkpoint 300, accepted 0, duplicates 0, batches 1 |
| `npm run check:server-types` | pass; established 310-diagnostic baseline |
| targeted ESLint and `git diff --check` | pass |
| `npm --prefix edge run verify` | pass; types, coverage 102/102, shuffle 102/102, property 5 passed, and development/staging/production Worker dry-run bundles |
| `npm run build` and `npm run mcp:build` | pass |

The first full root coverage attempt hit an intermittent unrelated
`server/world.test.ts` reinforcement-atmosphere failure. Its focused rerun
passed, and the immediately repeated full coverage gate passed 717/717; this is
recorded as a test-stability observation, not a claim that the first run was
green.

## Review, compatibility, and remaining gaps

An independent read-only review found no source-level security blocker after the
actual-eviction integration test and tamper matrix were added. Mixed old
Worker/new copier operation is intentionally fail-closed because old Workers do
not provide the checkpoint tuple. Rollout must update Workers before enabling
receipt-window recovery; rollback stops new copier admission and never deletes
origin envelopes or Durable Object state.

This is local proof only. Hosted GitHub Actions is unavailable because its latest
run starts zero jobs under an account billing lock. PR #2 remains draft/FIX:
there is no hosted CI proof, GitHub-rendered media, production deployment,
traffic, load/restore/SLO proof, or authority transfer claim.
