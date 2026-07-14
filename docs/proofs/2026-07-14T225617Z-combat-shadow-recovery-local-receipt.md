# Combat shadow recovery local receipt

- Tested source SHA: `1072f1dc4fe8bbc56333117b1661194e28a911a0`
- Branch: `codex/movement-shadow-parity`
- Recorded: `2026-07-14T22:56:17Z`
- Scope: deterministic player melee reducer, origin combat envelope journaling,
  durable-object replay, bounded receipt recovery, and failure fencing.

## Exact local proof

| Command | Result |
| --- | --- |
| `npm run lint` | passed |
| `npm run build` | passed; root TypeScript check and Vite production build passed |
| `npm run test:property` | passed: 3 files, 88 tests |
| `npm --prefix edge run verify` | passed: 107 tests, Istanbul coverage, seeded shuffle/property, and development/staging/production Worker dry-runs |
| `node scripts/run-tests-isolated.mjs server/world-movement-shadow.test.ts server/origin-journal.test.ts` | passed: 2 files, 88 tests |
| `node scripts/run-tests-isolated.mjs server/shadow-catchup.test.ts` | passed: 1 file, 22 tests |
| `npm --prefix edge test -- --run test/shadow-replay.test.ts` | passed: 1 file, 34 tests |
| `GROKHACK_REQUIRE_CLEAN_PROOF=1 npx tsx scripts/prove-shadow-catchup.ts` | passed on clean `8a592ee`; real WorldServer + persistent Worker harness proof |

The root `npm test` run had one timeout in the pre-existing 5-second
movement-turn segmentation test while Node, property, and edge full gates ran
concurrently. The exact test passed alone in 1.9 seconds:

```sh
node scripts/run-tests-isolated.mjs server/origin-journal.test.ts -t 'segments movement-turn evidence without per-entry file amplification'
```

## Behaviors proven

- Origin resolves player melee through the shared pure reducer and journals the
  supplied transcript before mutating the monster.
- Journal-write failure leaves combat state unchanged and retains the existing
  durable movement preparation fence.
- Combat envelopes reject malformed authority, stale/reordered/gapped cursors,
  terminal continuation, operation conflicts, and unprovable acknowledgement.
- Response loss, timeout/abort, restart, empty pre-commit segment cleanup,
  receipt compaction, and Durable Object eviction are covered.
- A 300-envelope combat prefix reconstructs against an evicted Durable Object
  only after the remote compacted checkpoint matches the local hash/state head.
- The isolated Worker harness exercises real WorldServer bounds, doors, combat
  intent, traps, transfer, terminal state, response loss, and 300-entry
  compacted-checkpoint recovery against persistent Worker storage.

## Deliberate non-proofs / release blockers

- This receipt is local evidence only. Hosted Actions is unavailable because
  its runs execute zero steps under the repository billing lock.
- Browser/WebSocket QA could not be completed: this environment terminates a
  local server when the next command begins. The server did boot against an
  isolated temporary data root; QA clients then received `ECONNREFUSED`.
- The manual diff security review found no new credential or unauthenticated
  ingress, but the plugin's artifact-backed security-diff scan has not been
  finalized.
- No deployment, traffic routing, live data mutation, merge, or release was
  performed.
