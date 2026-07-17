# Boot isolation + combat outbox local receipt

- Timestamp: 2026-07-16T18:39Z (local)
- Branch: `codex/movement-shadow-parity`
- Base: `57ca410` (origin tip before this commit)
- Scope: origin-only. No Worker deploy, DNS/route change, or public edge authority cutover.

## Implemented

1. **Boot isolation** — `hasPendingMovementTurn` / `movementTurnRecoveryCandidate` no longer reconcile full shadow-journal inventory. Poison/legacy evidence cannot abort `WorldServer` construction (fixes 2026-07-16 CF 1033 crash loop root path). Authority-registry validation degrades shadow instead of failing hydration.
2. **Combat transactional outbox** (from `codex/combat-outbox-isolated` worktree design):
   - `planCombatTurn` / `appendCombatTurnEnvelope` split
   - DuckDB `movement_turn_combat_outbox` created additively
   - `SCHEMA_WRITE_VERSION = 2` (read max 3 for accidental v3 markers)
   - Snapshot hash binds combat outbox; deferred lifecycle + fail-closed fences

## Evidence

| Command | Result |
| --- | --- |
| `npm test -- server/origin-journal.test.ts server/persistence.test.ts server/world-movement-shadow.test.ts` | **121/121 pass** |

## Explicit non-claims

- Hosted Actions still billing-locked (not evidence).
- PR #2 transfer REJECT items remain open — edge not production authority.
- Full root/edge canonical gate not re-run in this receipt.
- Live soft-reload recorded separately after this commit lands.
