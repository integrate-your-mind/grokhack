# Combat shadow-parity local receipt

- Timestamp: 2026-07-14T22:19:38Z
- Branch: `codex/movement-shadow-parity`
- Exact HEAD: `9eae8f203e87d66660e95a3fb34d38888d9b5926`
- Delivery surface: draft PR #2 (`main` <- `codex/movement-shadow-parity`)
- Authority boundary: local, shadow-only verification. No deployment, traffic routing, production-data mutation, secret access, merge, or release occurred.

## Implemented at this head

- Player-to-monster melee is resolved by a pure transcript-bound reducer.
- Origin samples historic RNG branches lazily and journals a versioned combat envelope with a V1 turn/vitals transition.
- Origin and Worker validate route binding, operation/cursor/hash chains, duplicate receipts, terminal behavior, and deterministic combat/turn outputs.
- A failed origin combat journal append leaves the prepared movement fence unresolved and blocks further mutation in-process.

## Local evidence

| Command | Result |
| --- | --- |
| `npm test` | pass: 59 files, 728 tests |
| `npm run test:property` | pass: 3 files, 81 tests |
| `npm run lint` | pass |
| `npm run build` | pass |
| `npm --prefix edge run verify` | pass: edge typecheck, coverage (104 tests), shuffle, seeded property, and development/staging/production dry-run builds |
| focused origin/world combat tests | pass: 159 tests |

The edge suite emits an expected simulated SQLite trigger error during an existing fault-injection test; its command exits successfully.

## Known gaps / not release evidence

- `npm run build:server` fails on existing broad NodeNext/test typing debt; this receipt does not claim it passes.
- The server type-baseline gate has inherited line-offset noise after source additions; the one new combat route-literal mismatch was fixed before this receipt.
- No full combat-specific cold-crash/restart/eviction/catch-up scenario has yet been demonstrated end-to-end against the exact origin and Worker path.
- Hosted Actions is unavailable as proof (billing-locked zero-step runs), and PR #2 remains draft/unstable.
- No browser/runtime video or production deployment proof exists.
